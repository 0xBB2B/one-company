import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { activeCheckRoundIn, assertWritersQuiescentIn, CheckRound, CheckRoundError, collectInputManifest, formalEvidence, manifestMatchesBaseline, VerificationRun, CHECK_ROUNDS, VERIFICATION_RUNS } from "./check-round.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { readVersion } from "./prod-storage.ts";
import { checked, counter, hash, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";
import { RequirementOperations } from "./requirement-operations.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { RequirementStateError } from "./requirement-contracts.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { isTerminalState } from "./run-store.ts";
import type { RunRecord } from "./run-store.ts";
import { resolveRealRepoPath } from "./write-guard.ts";
import { writeFileAtomic } from "./store.ts";
import { readVerdictsIn } from "./verdicts.ts";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { implementScope, readPlanIn, terminationPending } from "./plan-manage.ts";
import { endRequirementExploreSessionsIn } from "./explore-session.ts";

export const CLOSE_OPERATIONS = "close_operations";
export const DELIVERY_RECEIPTS = "delivery_receipts";
export const COMPLETION_NOTICES = "completion_notices";
const SPEC_PROPOSALS = "spec_proposals";
const CHANGE_SETS = "change_sets";
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const CloseReason = Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]);
export type CloseReason = Static<typeof CloseReason>;
const Basis = object({
  version: positive, epoch: positive, revision: counter, approvedHash: nullable(hash), checkRoundId: nullable(id),
  verificationIds: Type.Array(id), verdictIds: Type.Array(id), digest: hash,
});
export type CloseBasis = Static<typeof Basis>;
const Archive = object({ path: Type.String({ minLength: 1, maxLength: 1024 }), prodHash: hash, commit: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("archived"), Type.Literal("blocked")]), attempts: counter, lastError: nullable(Type.String({ maxLength: 1024 })) });
export const CloseOperation = object({
  format: Type.Literal("close-operation/v1"), requirementId: id, repoId: hash, operationId: id, receiptId: id, reason: CloseReason, basis: Basis,
  status: Type.Union([Type.Literal("closing"), Type.Literal("closed")]),
  steps: object({ agentsStopped: Type.Boolean(), entriesCleared: Type.Boolean(), closed: Type.Boolean(), noticeQueued: Type.Boolean() }),
  archive: nullable(Archive), createdAt: counter, updatedAt: counter,
});
export type CloseOperation = Static<typeof CloseOperation>;
export const CompletionNotice = object({
  format: Type.Literal("completion-notice/v1"), requirementId: id, repoId: hash, reason: CloseReason, closeEventSequence: positive,
  message: Type.String({ minLength: 1, maxLength: 512 }), agentsEnded: Type.Literal(true),
  status: Type.Union([Type.Literal("pending"), Type.Literal("delivered")]), attempts: counter, deliveredAt: nullable(counter), createdAt: counter,
});
export type CompletionNotice = Static<typeof CompletionNotice>;
export const DeliveryReceipt = object({
  format: Type.Literal("delivery-receipt/v1"), receiptId: id, requirementId: id, repoId: hash, workspaceId: hash, branch: Type.String({ minLength: 1 }), epoch: positive,
  revision: counter, approvedProdHash: nullable(hash), codeHead: Type.String({ minLength: 1 }), specSetHash: Type.String({ minLength: 1 }), inputHash: hash,
  checkRoundId: nullable(id), verificationIds: Type.Array(id), verdictIds: Type.Array(id), pendingRevision: nullable(positive),
  deliverable: Type.Boolean(), blockers: Type.Array(Type.String({ maxLength: 256 })), suggestions: counter, createdAt: counter,
});
export type DeliveryReceipt = Static<typeof DeliveryReceipt>;

export type CloseAction = "preflight" | "close" | "archive" | "notify" | "delivery-check" | "status";
export interface CloseAuthorization { readonly action: CloseAction; readonly requirementId: string; readonly reason?: CloseReason; readonly receiptId?: string; readonly operationId?: string }
export interface RequirementCloseServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 关闭授权回执须由宿主对照真实用户交互核验；模型参数不能构造 true。 */
  authorize: (request: Readonly<CloseAuthorization>) => boolean;
  /** 结束本需求 PM 与子代理会话；只由宿主提供，结束与否以运行记录为准。 */
  stopAgents?: (requirementId: string) => Promise<void>;
  now?: () => number;
}
export type CloseErrorCode = "close_denied" | "invalid_shape" | "not_found" | "not_closed" | "archive_conflict" | "archive_unavailable" | "notice_missing";
export class CloseError extends Error {
  readonly code: CloseErrorCode;
  constructor(code: CloseErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "CloseError"; this.code = code; }
}
export const COMPLETION_MESSAGE = (requirementId: string) => `需求 ${requirementId} 已完成，PM 及相关子代理已结束。建议清空上下文后再开始新的需求，避免旧需求影响后续判断。`;
export const TERMINATION_MESSAGE = (requirementId: string, reason: "cancelled" | "rejected") =>
  `需求 ${requirementId} 已按 ${reason === "cancelled" ? "取消" : "拒绝"} 关闭，PM 及相关子代理已结束。建议清空上下文后再开始新的需求。`;

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function requirementIn(db: LocalDatabase, repoId: string, requirementId: string) {
  const row = db.read<RequirementRecord>("requirements", requirementId);
  if (!row || row.data.repoId !== repoId) throw new CloseError("not_found");
  return row;
}
function activeRunsIn(db: LocalDatabase, requirementId: string, kind?: RunRecord["kind"]): RunRecord[] {
  return db.list<RunRecord>("runs").map((row) => row.data)
    .filter((run) => run && run.requirement === requirementId && (kind === undefined || run.kind === kind) && !isTerminalState(run.state));
}
function runningVerificationsIn(db: LocalDatabase, repoId: string, requirementId: string): VerificationRun[] {
  return db.list<unknown>(VERIFICATION_RUNS).map((row) => checked(VerificationRun, row.data))
    .filter((run) => run.repoId === repoId && run.requirementId === requirementId && run.status === "running" && run.pid !== null && processIsAlive(run.pid));
}
function pendingProposalsIn(db: LocalDatabase, repoId: string, requirementId: string): string[] {
  return db.list<{ repoId?: string; requirementId?: string; status?: string; operationId?: string }>(SPEC_PROPOSALS).map((row) => row.data)
    .filter((proposal) => proposal.repoId === repoId && proposal.requirementId === requirementId && ["proposed", "validated", "partial_failure"].includes(proposal.status ?? ""))
    .map((proposal) => proposal.operationId ?? "");
}
function latestRoundIn(db: LocalDatabase, repoId: string, requirementId: string, epoch: number): CheckRound | null {
  const rounds = db.list<unknown>(CHECK_ROUNDS).map((row) => checked(CheckRound, row.data))
    .filter((round) => round.repoId === repoId && round.requirementId === requirementId && round.epoch === epoch).sort((a, b) => a.createdAt - b.createdAt);
  return rounds.at(-1) ?? null;
}
interface DeliveryFacts {
  record: { version: number; data: RequirementRecord }; round: CheckRound | null; verifications: VerificationRun[]; verdicts: ReturnType<typeof readVerdictsIn>;
  blockers: string[]; suggestions: number; writes: Array<[string, string, number]>;
}
/** 同步数据库依据：最新检查轮、其正式结果、独立裁决、待处理更新、未发布候选与未收尾写入。 */
function deliveryFactsIn(db: LocalDatabase, repoId: string, requirementId: string): DeliveryFacts {
  const record = requirementIn(db, repoId, requirementId);
  const blockers: string[] = [];
  if (record.data.lifecycle !== "active" || record.data.recovery !== "ready" || !record.data.approved || !record.data.workspace) blockers.push("requirement_not_active");
  if (record.data.pendingRevision !== null) blockers.push("pending_update");
  const round = latestRoundIn(db, repoId, requirementId, record.data.epoch);
  const verifications = round ? round.verifications.map((verificationId) => db.read<unknown>(VERIFICATION_RUNS, verificationId)?.data).filter((run) => run !== undefined).map((run) => checked(VerificationRun, run)) : [];
  const verdicts = round ? readVerdictsIn(db, repoId, requirementId).filter((verdict) => verdict.checkRoundId === round.checkRoundId && verdict.epoch === record.data.epoch) : [];
  if (!round) blockers.push("formal_check_missing");
  else {
    if (round.status !== "released" || round.active.length > 0) blockers.push("check_round_not_released");
    if (round.invalidation) blockers.push(`check_round_${round.invalidation.reason}`);
    if (round.baseline.revision !== record.data.revision || round.baseline.approved.hash !== record.data.approved?.hash) blockers.push("check_round_prod_mismatch");
    if (!verifications.some((run) => run.status === "passed")) blockers.push("formal_pass_missing");
    if (verifications.some((run) => run.status === "running")) blockers.push("verification_running");
    const qa = verdicts.filter((verdict) => verdict.role === "qa");
    if (qa.length === 0) blockers.push("qa_verdict_missing");
    else if (qa.some((verdict) => verdict.conclusion === "blocked")) blockers.push("qa_blocking_findings");
    else if (qa.some((verdict) => verdict.conclusion === "unverified")) blockers.push("qa_unverified_findings");
  }
  const reviews = taskReviewsIn(db, repoId, requirementId, record.data.epoch);
  if (reviews === null) blockers.push("task_review_missing");
  if (pendingProposalsIn(db, repoId, requirementId).length > 0) blockers.push("spec_candidates_unpublished");
  // 用户终止任务后、批准新的 prod 版本前，其目标仍在实施授权内时需求不能以完成关闭
  if (record.data.lifecycle === "active" && record.data.approvalManifest) {
    const scope = implementScope(registeredApprovalManifestIn(db, repoId, record.data.approvalManifest.reference, record));
    const terminated = readPlanIn(db, requirementId)?.tasks.filter((task) => terminationPending([task], record.data.revision)) ?? [];
    if (terminated.some((task) => task.goalUnitIds.some((unit) => scope.has(unit)))) blockers.push("terminated_goal_in_scope");
  }
  if (activeCheckRoundIn(db, repoId, requirementId)) blockers.push("check_phase_active");
  try { assertWritersQuiescentIn(db, repoId, requirementId); }
  catch (error) { blockers.push(error instanceof CheckRoundError ? error.code : error instanceof RequirementServiceError ? error.code : "writers_active"); }
  const evidence = [...verdicts, ...(reviews ?? [])];
  const suggestions = evidence.reduce((total, verdict) => total + verdict.findings.filter((finding) => finding.kind === "suggestion").length, 0);
  return { record, round, verifications, verdicts: evidence, blockers: [...new Set(blockers)], suggestions, writes: managedWritesIn(db, repoId, requirementId) };
}
/** 每个未取消的 worker 任务都须已完成，且有绑定其最后一次完成尝试、无阻塞无未验证项的任务级审查；缺任一项返回 null。 */
function taskReviewsIn(db: LocalDatabase, repoId: string, requirementId: string, epoch: number): ReturnType<typeof readVerdictsIn> | null {
  const workers = (readPlanIn(db, requirementId)?.tasks ?? []).filter((task) => task.role === "worker" && task.status !== "cancelled");
  const verdicts = readVerdictsIn(db, repoId, requirementId).filter((verdict) => verdict.role === "reviewer" && verdict.epoch === epoch && verdict.conclusion === "clear");
  const found: ReturnType<typeof readVerdictsIn> = [];
  for (const task of workers) {
    const attempt = task.attempts.findLast((candidate) => candidate.outcome === "completed");
    const review = attempt && verdicts.find((verdict) => verdict.review?.taskId === task.taskId && verdict.review.attemptRunId === attempt.runId);
    if (task.status !== "completed" || !review) return null;
    found.push(review);
  }
  return found;
}
function managedWritesIn(db: LocalDatabase, repoId: string, requirementId: string): Array<[string, string, number]> {
  return [SPEC_PROPOSALS, CHANGE_SETS].flatMap((namespace) => db.list<{ repoId?: string; requirementId?: string; status?: string; operationId?: string }>(namespace)
    .filter((row) => row.data.repoId === repoId && row.data.requirementId === requirementId)
    .map((row): [string, string, number] => [`${namespace}:${row.data.operationId ?? row.key}`, row.data.status ?? "", row.version])).sort();
}
function basisOf(facts: DeliveryFacts): CloseBasis {
  const verificationIds = facts.verifications.map((run) => run.verificationId).sort();
  const verdictIds = facts.verdicts.map((verdict) => verdict.verdictId).sort();
  const digest = sha256(JSON.stringify([facts.record.version, facts.record.data.epoch, facts.record.data.revision, facts.record.data.approved, facts.round?.checkRoundId ?? null,
    facts.round?.status ?? null, facts.round?.invalidation ?? null, facts.verifications.map((run) => [run.verificationId, run.status, run.baseline]),
    facts.verdicts.map((verdict) => [verdict.verdictId, verdict.conclusion]), facts.writes]));
  return { version: facts.record.version, epoch: facts.record.data.epoch, revision: facts.record.data.revision, approvedHash: facts.record.data.approved?.hash ?? null,
    checkRoundId: facts.round?.checkRoundId ?? null, verificationIds, verdictIds, digest };
}

const PreflightInput = object({ requirementId: id, reason: CloseReason, receiptId: id });
const CloseInput = object({ requirementId: id, reason: CloseReason, receiptId: id, operationId: id });
export interface ClosePreflight { eligible: boolean; missing: string[]; basis: CloseBasis | null }
export type CloseResult =
  | { status: "rejected"; missing: string[] }
  | { status: "closing"; operationId: string; pending: string[] }
  | { status: "closed"; operationId: string; reason: CloseReason; archive: { path: string; status: string } | null; notice: "pending" | "delivered" };

/**
 * 关闭协议：资格预检不改状态 → 事务内再核对并原子进入 closing → 结束相关代理 → 登记 closed 与无正文完成通知 → 受限归档。
 * 文件读取与代理停止在事务外执行；预检通过后任何依据变化都使本次关闭不生效。
 */
export class RequirementCloseService {
  private readonly options: RequirementCloseServiceOptions;
  private readonly database: string;
  private readonly state: RequirementStateStore;
  private readonly operations: RequirementOperations;
  private readonly life: { disposed: boolean };
  private constructor(options: RequirementCloseServiceOptions, state: RequirementStateStore, life: { disposed: boolean }) {
    this.options = options; this.state = state; this.life = life; this.database = repositoryDatabase(options.dataRoot, options.repoId);
    this.operations = new RequirementOperations({ dataRoot: options.dataRoot, repoId: options.repoId });
  }
  static async open(options: RequirementCloseServiceOptions): Promise<RequirementCloseService> {
    checked(hash, options.repoId);
    const life = { disposed: false };
    const state = await RequirementStateStore.open({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: options.repoId,
      authorize: (request) => !life.disposed && request.repoId === options.repoId && ["open", "read", "begin-close", "finish-close", "events"].includes(request.action) });
    return new RequirementCloseService(options, state, life);
  }
  dispose(): void { this.life.disposed = true; }
  private now(): number { return checked(counter, this.options.now?.() ?? Date.now()); }
  private authorize(request: CloseAuthorization): void {
    if (this.life.disposed) throw new CloseError("close_denied");
    let result: unknown;
    try { result = this.options.authorize(freeze(structuredClone(request))); } catch { throw new CloseError("close_denied"); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new CloseError("close_denied");
  }
  private operation(db: LocalDatabase, requirementId: string) {
    const row = db.read<unknown>(CLOSE_OPERATIONS, requirementId);
    return row ? { version: row.version, data: checked(CloseOperation, row.data) } : null;
  }
  private saveOperation(db: LocalDatabase, current: { version: number; data: CloseOperation } | null, data: CloseOperation): void {
    const next = checked(CloseOperation, { ...data, updatedAt: this.now() });
    if (current) db.update(CLOSE_OPERATIONS, data.requirementId, current.version, next);
    else db.create(CLOSE_OPERATIONS, data.requirementId, next);
  }

  /** 交付凭据：当前内容指纹、正式证据、独立裁决与阻塞项，全程无 prod 正文。 */
  async deliveryCheck(requirementId: string): Promise<DeliveryReceipt> {
    return (await this.deliveryCheckWithBasis(requirementId)).receipt;
  }
  /** 凭据、关闭依据与角色运行判断出自同一事务，关闭再核对比对的就是签发凭据时的依据。 */
  private async deliveryCheckWithBasis(requirementId: string): Promise<{ receipt: DeliveryReceipt; basis: CloseBasis; roleRunsActive: boolean }> {
    checked(id, requirementId);
    this.authorize({ action: "delivery-check", requirementId });
    const first = withDatabase(this.database, (db) => deliveryFactsIn(db, this.options.repoId, requirementId));
    const workspace = first.record.data.workspace;
    if (workspace) await verifyRequirementWorkspace(this.options.dataRoot, workspace);
    let manifest: Awaited<ReturnType<typeof collectInputManifest>> | null = null;
    if (workspace) { try { manifest = await collectInputManifest(workspace.path); } catch { manifest = null; } }
    const applicable: string[] = [];
    for (const run of first.verifications) {
      if (run.status !== "passed") continue;
      const evidence = await formalEvidence({ dataRoot: this.options.dataRoot, repoId: this.options.repoId }, run.verificationId);
      if (evidence?.applicable) applicable.push(run.verificationId);
    }
    this.authorize({ action: "delivery-check", requirementId });
    return withDatabase(this.database, (db) => db.transaction(() => {
      const facts = deliveryFactsIn(db, this.options.repoId, requirementId);
      const blockers = [...facts.blockers];
      if (basisOf(facts).digest !== basisOf(first).digest) blockers.push("basis_changed");
      if (!manifest) blockers.push("workspace_unavailable");
      else if (facts.round && !manifestMatchesBaseline(manifest, facts.round.baseline)) blockers.push("delivery_content_mismatch");
      if (facts.round && applicable.length === 0) blockers.push("formal_evidence_not_applicable");
      const receipt = checked(DeliveryReceipt, { format: "delivery-receipt/v1", receiptId: uuidv7(), requirementId, repoId: this.options.repoId,
        workspaceId: facts.record.data.workspace?.workspaceId ?? "0".repeat(64), branch: facts.record.data.workspace?.branch ?? "refs/heads/unbound", epoch: facts.record.data.epoch,
        revision: facts.record.data.revision, approvedProdHash: facts.record.data.approved?.hash ?? null, codeHead: manifest?.codeHead ?? "unknown",
        specSetHash: manifest?.specSetHash ?? "unknown", inputHash: manifest?.inputHash ?? "0".repeat(64), checkRoundId: facts.round?.checkRoundId ?? null,
        verificationIds: applicable, verdictIds: facts.verdicts.map((verdict) => verdict.verdictId), pendingRevision: facts.record.data.pendingRevision,
        deliverable: blockers.length === 0, blockers: [...new Set(blockers)], suggestions: facts.suggestions, createdAt: this.now() });
      db.create(DELIVERY_RECEIPTS, receipt.receiptId, receipt, receipt.receiptId);
      return { receipt: freeze(receipt), basis: basisOf(facts), roleRunsActive: activeRunsIn(db, requirementId, "role").length > 0 };
    }));
  }

  /** 资格预检只报告缺项，不改状态、不提升 epoch、不撤权。 */
  async preflight(input: Static<typeof PreflightInput>): Promise<ClosePreflight> {
    let request: Static<typeof PreflightInput>;
    try { request = checked(PreflightInput, input); } catch { throw new CloseError("invalid_shape"); }
    const missing: string[] = [];
    let authorized = true;
    try { this.authorize({ action: "close", requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId }); }
    catch { authorized = false; missing.push("close_authorization_invalid"); }
    const record = withDatabase(this.database, (db) => requirementIn(db, this.options.repoId, request.requirementId));
    if (record.data.close) {
      if (record.data.close.receiptId !== request.receiptId || record.data.close.reason !== request.reason) missing.push("close_intent_conflict");
      return { eligible: authorized && missing.length === 0, missing, basis: null };
    }
    if (record.data.recovery !== "ready") missing.push("recovery_required");
    if (record.data.lifecycle !== "active" && !(record.data.lifecycle === "draft" && request.reason !== "completed")) missing.push("lifecycle_denied");
    if (request.reason !== "completed") {
      const facts = withDatabase(this.database, (db) => deliveryFactsIn(db, this.options.repoId, request.requirementId));
      return { eligible: missing.length === 0, missing, basis: basisOf(facts) };
    }
    const { receipt, basis, roleRunsActive } = await this.deliveryCheckWithBasis(request.requirementId);
    missing.push(...receipt.blockers);
    if (roleRunsActive) missing.push("role_agents_running");
    return { eligible: missing.length === 0, missing: [...new Set(missing)], basis };
  }

  async close(input: Static<typeof CloseInput>): Promise<CloseResult> {
    let request: Static<typeof CloseInput>;
    try { request = checked(CloseInput, input); } catch { throw new CloseError("invalid_shape"); }
    let authorized = true;
    try { this.authorize({ action: "close", requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId, operationId: request.operationId }); }
    catch { authorized = false; }
    const existing = withDatabase(this.database, (db) => ({ operation: this.operation(db, request.requirementId), record: requirementIn(db, this.options.repoId, request.requirementId) }));
    if (!authorized) return freeze({ status: "rejected" as const, missing: ["close_authorization_invalid"] });
    if (!existing.record.data.close) {
      const preflight = await this.preflight({ requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId });
      if (!preflight.eligible || !preflight.basis) return freeze({ status: "rejected" as const, missing: preflight.missing });
      const basis = preflight.basis;
      const intent = { operationId: request.operationId, reason: request.reason, receiptId: request.receiptId };
      try {
        this.state.beginClose({ requirementId: request.requirementId, version: basis.version, intent }, (db) => {
          const facts = deliveryFactsIn(db, this.options.repoId, request.requirementId);
          if (basisOf(facts).digest !== basis.digest) throw new RequirementStateError("close_basis_changed");
          if (activeCheckRoundIn(db, this.options.repoId, request.requirementId)) throw new RequirementStateError("check_phase_active");
          if (request.reason === "completed" && (facts.blockers.length > 0 || activeRunsIn(db, request.requirementId, "role").length > 0)) throw new RequirementStateError("completion_blocked");
          const workspace = facts.record.data.workspace;
          const archivePath = request.reason === "completed" && workspace && facts.record.data.approved ? this.operations.archivePath(request.requirementId, facts.record.data.approved) : null;
          if (request.reason === "completed" && !archivePath) throw new RequirementStateError("archive_path_missing");
          const now = this.now();
          this.saveOperation(db, this.operation(db, request.requirementId), { format: "close-operation/v1", requirementId: request.requirementId, repoId: this.options.repoId,
            operationId: request.operationId, receiptId: request.receiptId, reason: request.reason, basis, status: "closing",
            steps: { agentsStopped: false, entriesCleared: false, closed: false, noticeQueued: false },
            archive: archivePath ? { path: archivePath, prodHash: facts.record.data.approved!.hash, commit: facts.record.data.approved!.commit, status: "pending", attempts: 0, lastError: null } : null,
            createdAt: now, updatedAt: now });
        });
      } catch (error: unknown) {
        if (error instanceof RequirementStateError) return freeze({ status: "rejected" as const, missing: [error.code] });
        throw error;
      }
    } else if (existing.record.data.close.operationId !== request.operationId || existing.record.data.close.reason !== request.reason || existing.record.data.close.receiptId !== request.receiptId) {
      return freeze({ status: "rejected" as const, missing: ["close_intent_conflict"] });
    }
    return this.finish(request.requirementId);
  }

  /** 续办 closing：只重试未完成的收尾，不回 active、不改关闭原因、不重复副作用。 */
  private async finish(requirementId: string): Promise<CloseResult> {
    const operation = withDatabase(this.database, (db) => this.operation(db, requirementId));
    if (!operation) throw new CloseError("not_found");
    if (!operation.data.steps.agentsStopped) {
      try { await this.options.stopAgents?.(requirementId); } catch { /* 停止失败以运行记录为准，保持 closing。 */ }
    }
    const pending = withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      const blockers: string[] = [];
      const runs = activeRunsIn(db, requirementId);
      if (runs.length > 0) blockers.push("agents_running");
      if (runningVerificationsIn(db, this.options.repoId, requirementId).length > 0) blockers.push("verification_running");
      const owner = db.read<{ lease?: unknown }>("pm_ownership", requirementId)?.data;
      if (owner?.lease) blockers.push("pm_lease_active");
      if (blockers.length === 0 && !current.data.steps.agentsStopped) {
        endRequirementExploreSessionsIn(db, this.options.repoId, requirementId, "requirement_closed");
        this.saveOperation(db, current, { ...current.data, steps: { ...current.data.steps, agentsStopped: true, entriesCleared: true } });
      }
      return blockers;
    }));
    if (pending.length > 0) return freeze({ status: "closing" as const, operationId: operation.data.operationId, pending });
    const record = this.state.read(requirementId);
    if (record.data.lifecycle === "closing") {
      try { this.state.finishClose({ requirementId, version: record.version, operationId: operation.data.operationId }); }
      catch (error: unknown) { if (error instanceof RequirementStateError) return freeze({ status: "closing" as const, operationId: operation.data.operationId, pending: [error.code] }); throw error; }
    }
    const closeSequence = this.state.events(requirementId).find((event) => event.data.kind === "closed")?.sequence;
    if (!closeSequence) return freeze({ status: "closing" as const, operationId: operation.data.operationId, pending: ["closed_event_missing"] });
    const notice = withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      const existing = db.read<unknown>(COMPLETION_NOTICES, requirementId);
      const stored = existing ? checked(CompletionNotice, existing.data) : null;
      if (!stored) {
        const reason = current.data.reason;
        db.create(COMPLETION_NOTICES, requirementId, checked(CompletionNotice, { format: "completion-notice/v1", requirementId, repoId: this.options.repoId, reason,
          closeEventSequence: closeSequence, message: reason === "completed" ? COMPLETION_MESSAGE(requirementId) : TERMINATION_MESSAGE(requirementId, reason),
          agentsEnded: true, status: "pending", attempts: 0, deliveredAt: null, createdAt: this.now() }));
      }
      if (current.data.status !== "closed") this.saveOperation(db, current, { ...current.data, status: "closed", steps: { ...current.data.steps, closed: true, noticeQueued: true } });
      return stored?.status ?? "pending";
    }));
    const final = withDatabase(this.database, (db) => this.operation(db, requirementId)!.data);
    return freeze({ status: "closed" as const, operationId: final.operationId, reason: final.reason,
      archive: final.archive ? { path: final.archive.path, status: final.archive.status } : null, notice });
  }

  status(requirementId: string) {
    checked(id, requirementId);
    this.authorize({ action: "status", requirementId });
    const operation = withDatabase(this.database, (db) => this.operation(db, requirementId));
    if (!operation) return freeze({ status: "none" as const });
    const notice = withDatabase(this.database, (db) => db.read<unknown>(COMPLETION_NOTICES, requirementId)?.data);
    const { data } = operation;
    return freeze({ status: data.status, operationId: data.operationId, reason: data.reason, steps: { ...data.steps }, archive: data.archive ? { ...data.archive } : null,
      notice: notice ? checked(CompletionNotice, notice).status : null });
  }

  /** 完成通知投递：只重试元数据通知，不重开需求、不重启 PM。 */
  notify(requirementId: string, deliver: (notice: Readonly<{ requirementId: string; reason: CloseReason; message: string; agentsEnded: true }>) => boolean): CompletionNotice {
    checked(id, requirementId);
    this.authorize({ action: "notify", requirementId });
    const stored = withDatabase(this.database, (db) => {
      const row = db.read<unknown>(COMPLETION_NOTICES, requirementId);
      return row ? { version: row.version, data: checked(CompletionNotice, row.data) } : null;
    });
    if (!stored) throw new CloseError("notice_missing");
    if (stored.data.status === "delivered") return freeze(structuredClone(stored.data));
    let delivered = false;
    try { delivered = deliver(freeze({ requirementId, reason: stored.data.reason, message: stored.data.message, agentsEnded: true as const })) === true; } catch { delivered = false; }
    return freeze(withDatabase(this.database, (db) => db.transaction(() => {
      const row = db.read<unknown>(COMPLETION_NOTICES, requirementId)!;
      const current = checked(CompletionNotice, row.data);
      if (current.status === "delivered") return current;
      const next = checked(CompletionNotice, { ...current, attempts: current.attempts + 1, ...(delivered ? { status: "delivered", deliveredAt: this.now() } : {}) });
      db.update(COMPLETION_NOTICES, requirementId, row.version, next);
      return next;
    })));
  }

  /** 受限归档：只把关闭前固化的最终 prod.md 字节复制到登记路径；同 hash 幂等，不同内容阻塞，不向调用方返回正文。 */
  async archive(requirementId: string): Promise<{ status: "archived" | "blocked" | "pending"; path: string; prodHash: string; attempts: number; lastError: string | null }> {
    checked(id, requirementId);
    this.authorize({ action: "archive", requirementId });
    const loaded = withDatabase(this.database, (db) => ({ operation: this.operation(db, requirementId), record: requirementIn(db, this.options.repoId, requirementId) }));
    const { operation, record } = loaded;
    if (!operation || !operation.data.archive) throw new CloseError("archive_unavailable", "非完成关闭无归档资格");
    if (record.data.lifecycle !== "closed" || operation.data.status !== "closed" || record.data.close?.reason !== "completed" || operation.data.reason !== "completed") throw new CloseError("not_closed");
    const archive = operation.data.archive;
    const view = () => freeze({ status: archive.status, path: archive.path, prodHash: archive.prodHash, attempts: archive.attempts, lastError: archive.lastError });
    if (archive.status === "archived") return view();
    const save = (next: Partial<NonNullable<CloseOperation["archive"]>>) => withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      this.saveOperation(db, current, { ...current.data, archive: { ...current.data.archive!, ...next } });
    }));
    try {
      const workspace = record.data.workspace;
      if (!workspace) throw new Error("workspace_missing");
      await verifyRequirementWorkspace(this.options.dataRoot, workspace);
      const identity = this.operations.repositoryIdentity(requirementId) ?? undefined;
      const bytes = (await readVersion({ dataRoot: this.options.dataRoot, repoId: this.options.repoId, requirementId, repositoryRoot: this.options.repositoryRoot,
        expectedRepositoryIdentity: identity, commit: archive.commit, expectedHash: `sha256:${archive.prodHash}`,
        authorize: (check) => check.requirementId === requirementId && check.action === "readVersion" && (check.prodHash === undefined || check.prodHash === `sha256:${archive.prodHash}`) })).bytes;
      if (sha256(Buffer.from(bytes)) !== archive.prodHash) throw new Error("final_prod_hash_mismatch");
      const root = await realpath(workspace.path);
      const target = join(root, ...archive.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      const real = await resolveRealRepoPath(root, target, false);
      if (real !== archive.path) throw new Error("archive_path_escape");
      let existing: Buffer | null = null;
      try { const stats = await lstat(target); if (!stats.isFile()) throw new Error("archive_target_not_file"); existing = await readFile(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && sha256(existing) !== archive.prodHash) { save({ status: "blocked", attempts: archive.attempts + 1, lastError: "archive_conflict" }); throw new CloseError("archive_conflict"); }
      if (!existing) {
        await writeFileAtomic(target, Buffer.from(bytes).toString("utf8"));
        if (sha256(await readFile(target)) !== archive.prodHash) throw new Error("archive_write_mismatch");
      }
      save({ status: "archived", attempts: archive.attempts + 1, lastError: null });
      return freeze({ status: "archived" as const, path: archive.path, prodHash: archive.prodHash, attempts: archive.attempts + 1, lastError: null });
    } catch (error) {
      if (error instanceof CloseError) throw error;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
      save({ status: "pending", attempts: archive.attempts + 1, lastError: message });
      return freeze({ status: "pending" as const, path: archive.path, prodHash: archive.prodHash, attempts: archive.attempts + 1, lastError: message });
    }
  }
}
