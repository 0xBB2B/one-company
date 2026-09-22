import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { snapshotBranchState } from "./branch-guard.ts";
import { isProdArchivePath } from "./content-policy.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { readGitBytes } from "./git-read.ts";
import { checked, commit, counter, hash, id, object, PmLease, positive, ProdReference } from "./requirement-contracts.ts";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn } from "./requirement-coordination.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { isTerminalState } from "./run-store.ts";
import type { RunRecord } from "./run-store.ts";
import { checkSpecSet, SpecFormatError } from "./spec-format.ts";
import type { SpecSource } from "./spec-format.ts";

export const CHECK_ROUNDS = "check_rounds";
export const VERIFICATION_RUNS = "verification_runs";
const CHANGE_SETS = "change_sets";
const SPEC_PROPOSALS = "spec_proposals";
const SPEC_DIRECTORY = "docs/spec";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const specSetHash = Type.Union([hash, Type.Literal("absent"), Type.Literal("invalid")]);
export const InputEnvironment = object({ node: Type.String({ maxLength: 64 }), platform: Type.String({ maxLength: 32 }), arch: Type.String({ maxLength: 32 }) });
export const CheckBaseline = object({
  revision: positive, approved: ProdReference, codeHead: commit, specSetHash, targetSpecSetHash: nullable(hash),
  inputHash: hash, inputCount: counter, environment: InputEnvironment,
});
export type CheckBaseline = Static<typeof CheckBaseline>;
const Invalidation = object({ reason: Type.Union([Type.Literal("input_changed"), Type.Literal("observed_change"), Type.Literal("interrupted"), Type.Literal("revoked")]),
  detail: Type.String({ maxLength: 1024 }) });
export type CheckInvalidation = Static<typeof Invalidation>;
const Decision = object({ kind: Type.Union([Type.Literal("interrupt"), Type.Literal("defer")]), revision: positive, at: counter });
export const CheckRound = object({
  format: Type.Literal("check-round/v1"), checkRoundId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1 }), epoch: positive, fence: positive, runId: id, baseline: CheckBaseline,
  status: Type.Union([Type.Literal("open"), Type.Literal("stopping"), Type.Literal("released")]),
  invalidation: nullable(Invalidation), decision: nullable(Decision),
  verifications: Type.Array(id, { maxItems: 4096 }), active: Type.Array(id, { maxItems: 4096 }), createdAt: counter, updatedAt: counter,
});
export type CheckRound = Static<typeof CheckRound>;
export const VerificationPerformance = Type.Union([
  object({ applicable: Type.Literal(false), reason: Type.String({ minLength: 1, maxLength: 1024 }) }),
  object({ applicable: Type.Literal(true), thresholds: Type.String({ minLength: 1, maxLength: 4096 }) }),
]);
export const VerificationStatus = Type.Union([Type.Literal("running"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("timeout"),
  Type.Literal("cancelled"), Type.Literal("not_run"), Type.Literal("interrupted"), Type.Literal("invalidated")]);
export const VerificationRun = object({
  format: Type.Literal("verification-run/v1"), verificationId: id, kind: Type.Union([Type.Literal("debug"), Type.Literal("formal")]),
  requirementId: id, repoId: hash, workspaceId: hash, branch: Type.String({ minLength: 1 }), epoch: positive, runId: id,
  role: Type.Union([Type.Literal("worker"), Type.Literal("pm"), Type.Literal("reviewer"), Type.Literal("qa")]),
  checkRoundId: nullable(id), command: Type.String({ minLength: 1, maxLength: 4096 }), outputRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  baseline: CheckBaseline, performance: VerificationPerformance, status: VerificationStatus,
  exitCode: nullable(Type.Integer()), signal: nullable(Type.String({ maxLength: 32 })), reason: nullable(Type.String({ maxLength: 1024 })),
  invalidation: nullable(Invalidation), pid: nullable(positive), ownerToken: id, startedAt: counter, finishedAt: nullable(counter),
});
export type VerificationRun = Static<typeof VerificationRun>;

export type CheckRoundErrorCode = "check_round_denied" | "invalid_shape" | "pending_update" | "check_round_active" | "workers_active" | "writes_pending"
  | "spec_invalid" | "proposal_invalid" | "not_found" | "verification_active" | "round_not_open" | "check_phase_active" | "decision_conflict" | "stale_pm_lease";
export class CheckRoundError extends Error {
  readonly code: CheckRoundErrorCode;
  constructor(code: CheckRoundErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "CheckRoundError"; this.code = code;
  }
}

export interface InputManifest {
  codeHead: string; specSetHash: string; inputHash: string; environment: Static<typeof InputEnvironment>;
  files: Array<{ path: string; hash: string }>;
}
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

/** 实际输入清单：worktree 中 Git 跟踪与未忽略文件的内容指纹，排除 docs/prod；不读取本机数据目录。 */
export async function collectInputManifest(root: string): Promise<InputManifest> {
  const listing = await readGitBytes(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = [...new Set(listing.stdout.toString("utf8").split("\u0000").filter((entry) => entry.length > 0))]
    .filter((path) => !isProdArchivePath(path)).sort();
  const files: Array<{ path: string; hash: string }> = [];
  const specs: SpecSource[] = [];
  for (const path of paths) {
    const absolute = join(root, ...path.split("/"));
    let stats;
    try { stats = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { files.push({ path, hash: "absent" }); continue; } throw error; }
    if (stats.isSymbolicLink()) { files.push({ path, hash: sha256(`symlink:${await readlink(absolute)}`) }); continue; }
    if (!stats.isFile()) continue;
    const bytes = await readFile(absolute);
    files.push({ path, hash: sha256(bytes) });
    if (path.startsWith(`${SPEC_DIRECTORY}/`) && path.endsWith(".rules.json")) specs.push({ path: posix.normalize(path), content: bytes.toString("utf8") });
  }
  let specSetHash = "absent";
  if (specs.length > 0) {
    try { specSetHash = checkSpecSet(specs).contractSetHash; }
    catch (error) { if (!(error instanceof SpecFormatError)) throw error; specSetHash = "invalid"; }
  }
  const { head } = await snapshotBranchState({ repoRoot: root });
  const environment = { node: process.version, platform: process.platform, arch: process.arch };
  const inputHash = sha256(JSON.stringify([head, specSetHash, environment, files]));
  return { codeHead: head, specSetHash, inputHash, environment, files };
}

export function manifestMatchesBaseline(manifest: InputManifest, baseline: CheckBaseline): boolean {
  return manifest.inputHash === baseline.inputHash && manifest.codeHead === baseline.codeHead && manifest.specSetHash === baseline.specSetHash &&
    JSON.stringify(manifest.environment) === JSON.stringify(baseline.environment);
}

export function readCheckRoundIn(db: LocalDatabase, checkRoundId: string): StoredRecord<CheckRound> | null {
  const row = db.read<unknown>(CHECK_ROUNDS, checkRoundId);
  return row ? { ...row, data: checked(CheckRound, row.data) } : null;
}
export function readVerificationIn(db: LocalDatabase, verificationId: string): StoredRecord<VerificationRun> | null {
  const row = db.read<unknown>(VERIFICATION_RUNS, verificationId);
  return row ? { ...row, data: checked(VerificationRun, row.data) } : null;
}
/** 需求当前生效的检查阶段：轮次未退出，或仍有验证进程未结束。 */
export function activeCheckRoundIn(db: LocalDatabase, repoId: string, requirementId: string): StoredRecord<CheckRound> | null {
  for (const row of db.list<unknown>(CHECK_ROUNDS)) {
    const round = checked(CheckRound, row.data);
    if (round.repoId !== repoId || round.requirementId !== requirementId) continue;
    if (round.status !== "released" || round.active.length > 0) return { id: row.id, version: row.version, data: round };
  }
  return null;
}
export function assertModificationAllowedIn(db: LocalDatabase, repoId: string, requirementId: string): void {
  if (activeCheckRoundIn(db, repoId, requirementId)) throw new CheckRoundError("check_phase_active");
}
function activeRuns(db: LocalDatabase, requirementId: string): RunRecord[] {
  return db.list<RunRecord>("runs").map((row) => row.data)
    .filter((run) => run && run.kind === "role" && run.requirement === requirementId && !isTerminalState(run.state));
}
function pendingChangeSets(db: LocalDatabase, repoId: string, requirementId: string): string[] {
  return db.list<{ repoId?: string; requirementId?: string; status?: string; operationId?: string }>(CHANGE_SETS).map((row) => row.data)
    .filter((set) => set.repoId === repoId && set.requirementId === requirementId && (set.status === "applying" || set.status === "partial_failure"))
    .map((set) => set.operationId ?? "");
}
/** 本轮修改是否已全部收尾：无运行中的角色会话、无未完成的受控写入、无需求写占用。 */
export function assertWritersQuiescentIn(db: LocalDatabase, repoId: string, requirementId: string): void {
  const runs = activeRuns(db, requirementId);
  if (runs.length > 0) throw new CheckRoundError("workers_active", runs.map((run) => run.id).join(","));
  const sets = pendingChangeSets(db, repoId, requirementId);
  if (sets.length > 0) throw new CheckRoundError("writes_pending", sets.join(","));
  assertNoRequirementWriteClaimIn(db, repoId, requirementId);
  assertNoUnfinishedRequirementOperationsIn(db, requirementId);
}

export type CheckRoundAction = "open" | "status" | "stop" | "release" | "decide" | "observe";
export interface CheckRoundAuthorization { readonly action: CheckRoundAction; readonly requirementId: string; readonly lease?: Readonly<PmLease>; readonly checkRoundId?: string }
export interface CheckRoundServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 必须由宿主核验当前物理 PM 会话/调用者；不能从模型参数或角色文本构造 true。 */
  authorize: (request: Readonly<CheckRoundAuthorization>) => boolean;
  now?: () => number;
}
const OpenInput = object({ lease: PmLease, targetSpecProposal: Type.Optional(id) });
const RoundInput = object({ lease: PmLease, checkRoundId: id });
const DecideInput = object({ lease: PmLease, checkRoundId: id, kind: Type.Union([Type.Literal("interrupt"), Type.Literal("defer")]), revision: positive });
const ObserveInput = object({ checkRoundId: id, paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 1024 }) });

export interface CheckRoundView {
  checkRoundId: string; requirementId: string; status: CheckRound["status"]; baseline: CheckBaseline;
  invalidation: CheckInvalidation | null; decision: CheckRound["decision"]; verifications: string[]; active: string[];
}
function view(round: CheckRound): CheckRoundView {
  return freeze({ checkRoundId: round.checkRoundId, requirementId: round.requirementId, status: round.status, baseline: structuredClone(round.baseline),
    invalidation: round.invalidation, decision: round.decision, verifications: [...round.verifications], active: [...round.active] });
}

/**
 * 检查轮次的可信服务：进入检查前核验本轮写入已收尾并登记基线；轮次生效期间 change_apply/spec_change/新验证以外的写入被拒绝。
 * 文件指纹与 Git 读取在事务外完成，事务内只比对同步数据库依据。
 */
export class CheckRoundService {
  private readonly options: CheckRoundServiceOptions;
  private readonly database: string;
  private readonly state: RequirementStateStore;
  private readonly life: { disposed: boolean };
  private constructor(options: CheckRoundServiceOptions, state: RequirementStateStore, life: { disposed: boolean }) {
    this.options = options; this.state = state; this.life = life; this.database = repositoryDatabase(options.dataRoot, options.repoId);
  }
  static async open(options: CheckRoundServiceOptions): Promise<CheckRoundService> {
    checked(hash, options.repoId);
    const life = { disposed: false };
    const state = await RequirementStateStore.open({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: options.repoId,
      authorize: (request) => !life.disposed && request.repoId === options.repoId && ["open", "read", "check-pm"].includes(request.action) });
    const service = new CheckRoundService(options, state, life);
    service.reconcileInterrupted();
    return service;
  }
  dispose(): void { this.life.disposed = true; }
  private now(): number { return checked(counter, this.options.now?.() ?? Date.now()); }
  private authorize(request: CheckRoundAuthorization): void {
    if (this.life.disposed) throw new CheckRoundError("check_round_denied");
    let result: unknown;
    try { result = this.options.authorize(freeze(structuredClone(request))); } catch { throw new CheckRoundError("check_round_denied"); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new CheckRoundError("check_round_denied");
  }
  private validateLeaseIn(db: LocalDatabase, lease: PmLease): void {
    const owner = db.read<{ fence?: number; lease?: PmLease | null }>("pm_ownership", lease.requirementId)?.data;
    const record = db.read<{ epoch?: number; lifecycle?: string; recovery?: string }>("requirements", lease.requirementId)?.data;
    if (!owner?.lease || owner.fence !== lease.fence || owner.lease.runId !== lease.runId || owner.lease.fence !== lease.fence ||
      owner.lease.epoch !== lease.epoch || owner.lease.expiresAt <= this.now() || !record || record.epoch !== lease.epoch ||
      record.lifecycle !== "active" || record.recovery !== "ready") throw new CheckRoundError("stale_pm_lease");
  }
  /** 崩溃后重新打开服务：已无进程的运行中验证标为中断，不再占用检查阶段。 */
  private reconcileInterrupted(): void {
    withDatabase(this.database, (db) => db.transaction(() => {
      for (const row of db.list<unknown>(VERIFICATION_RUNS)) {
        const run = checked(VerificationRun, row.data);
        if (run.repoId !== this.options.repoId || run.status !== "running" || (run.pid !== null && processIsAlive(run.pid))) continue;
        const now = this.now();
        db.update(VERIFICATION_RUNS, run.verificationId, row.version, { ...run, status: "interrupted", reason: "进程已不存在", finishedAt: now });
        if (run.checkRoundId) {
          const round = readCheckRoundIn(db, run.checkRoundId);
          if (round) db.update(CHECK_ROUNDS, round.id, round.version, { ...round.data, active: round.data.active.filter((item) => item !== run.verificationId), updatedAt: now });
        }
      }
    }));
  }

  async openRound(input: Static<typeof OpenInput>): Promise<CheckRoundView> {
    let request: Static<typeof OpenInput>;
    try { request = checked(OpenInput, input); } catch { throw new CheckRoundError("invalid_shape"); }
    const { lease } = request;
    this.authorize({ action: "open", requirementId: lease.requirementId, lease });
    const record = this.state.read(lease.requirementId).data;
    if (record.lifecycle !== "active" || record.recovery !== "ready" || !record.workspace || !record.approved || record.epoch !== lease.epoch ||
      record.workspace.workspaceId !== lease.workspaceId) throw new CheckRoundError("check_round_denied");
    if (record.pendingRevision !== null) throw new CheckRoundError("pending_update");
    await verifyRequirementWorkspace(this.options.dataRoot, record.workspace);
    await this.state.checkPm(lease);
    const manifest = await collectInputManifest(record.workspace.path);
    if (manifest.specSetHash === "invalid") throw new CheckRoundError("spec_invalid");
    const workspace = record.workspace, approved = record.approved, revision = record.revision;
    this.authorize({ action: "open", requirementId: lease.requirementId, lease });
    const round = withDatabase(this.database, (db) => db.transaction(() => {
      this.validateLeaseIn(db, lease);
      const current = db.read<{ revision?: number; approved?: unknown; pendingRevision?: unknown }>("requirements", lease.requirementId)?.data;
      if (!current || current.revision !== revision || JSON.stringify(current.approved) !== JSON.stringify(approved)) throw new CheckRoundError("check_round_denied");
      if (current.pendingRevision !== null) throw new CheckRoundError("pending_update");
      if (activeCheckRoundIn(db, this.options.repoId, lease.requirementId)) throw new CheckRoundError("check_round_active");
      assertWritersQuiescentIn(db, this.options.repoId, lease.requirementId);
      let targetSpecSetHash: string | null = null;
      if (request.targetSpecProposal) {
        const proposal = db.read<{ requirementId?: string; repoId?: string; status?: string; approvedProdHash?: string; targetSpecSetHash?: string; epoch?: number }>(SPEC_PROPOSALS, request.targetSpecProposal)?.data;
        if (!proposal || proposal.requirementId !== lease.requirementId || proposal.repoId !== this.options.repoId || proposal.status !== "validated" ||
          proposal.approvedProdHash !== approved.hash || proposal.epoch !== lease.epoch || typeof proposal.targetSpecSetHash !== "string") throw new CheckRoundError("proposal_invalid");
        targetSpecSetHash = proposal.targetSpecSetHash;
      }
      const now = this.now();
      const data = checked(CheckRound, { format: "check-round/v1", checkRoundId: uuidv7(), requirementId: lease.requirementId, repoId: this.options.repoId,
        workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: lease.epoch, fence: lease.fence, runId: lease.runId,
        baseline: { revision, approved, codeHead: manifest.codeHead, specSetHash: manifest.specSetHash, targetSpecSetHash, inputHash: manifest.inputHash,
          inputCount: manifest.files.length, environment: manifest.environment },
        status: "open", invalidation: null, decision: null, verifications: [], active: [], createdAt: now, updatedAt: now });
      db.create(CHECK_ROUNDS, data.checkRoundId, data, data.checkRoundId);
      return data;
    }));
    return view(round);
  }

  status(checkRoundId: string): CheckRoundView {
    checked(id, checkRoundId);
    const round = withDatabase(this.database, (db) => readCheckRoundIn(db, checkRoundId));
    if (!round || round.data.repoId !== this.options.repoId) throw new CheckRoundError("not_found");
    this.authorize({ action: "status", requirementId: round.data.requirementId, checkRoundId });
    return view(round.data);
  }

  private load(db: LocalDatabase, checkRoundId: string, lease: PmLease): StoredRecord<CheckRound> {
    const round = readCheckRoundIn(db, checkRoundId);
    if (!round || round.data.repoId !== this.options.repoId || round.data.requirementId !== lease.requirementId) throw new CheckRoundError("not_found");
    this.validateLeaseIn(db, lease);
    if (round.data.epoch !== lease.epoch) throw new CheckRoundError("stale_pm_lease");
    return round;
  }
  private roundInput(input: unknown): Static<typeof RoundInput> {
    try { return checked(RoundInput, input); } catch { throw new CheckRoundError("invalid_shape"); }
  }
  /** 请求停止：轮次进入 stopping，不再接受新的验证；已开始的验证由其执行方收尾。 */
  requestStop(input: Static<typeof RoundInput>): CheckRoundView {
    const request = this.roundInput(input);
    this.authorize({ action: "stop", requirementId: request.lease.requirementId, lease: request.lease, checkRoundId: request.checkRoundId });
    return view(withDatabase(this.database, (db) => db.transaction(() => {
      const round = this.load(db, request.checkRoundId, request.lease);
      if (round.data.status !== "open" && round.data.status !== "stopping") return round.data;
      const data: CheckRound = { ...round.data, status: "stopping", updatedAt: this.now() };
      db.update(CHECK_ROUNDS, round.id, round.version, data);
      return data;
    })));
  }
  /** 退出检查阶段：只有全部验证进程已结束才释放；未结束时保持写保护。 */
  release(input: Static<typeof RoundInput>): CheckRoundView {
    const request = this.roundInput(input);
    this.authorize({ action: "release", requirementId: request.lease.requirementId, lease: request.lease, checkRoundId: request.checkRoundId });
    return view(withDatabase(this.database, (db) => db.transaction(() => {
      const round = this.load(db, request.checkRoundId, request.lease);
      if (round.data.status === "released") return round.data;
      if (round.data.active.length > 0) throw new CheckRoundError("verification_active", round.data.active.join(","));
      const invalidation = round.data.invalidation ?? (round.data.decision?.kind === "interrupt" ? { reason: "interrupted" as const, detail: "PM 中断检查" } : null);
      const data: CheckRound = { ...round.data, status: "released", invalidation, updatedAt: this.now() };
      db.update(CHECK_ROUNDS, round.id, round.version, data);
      return data;
    })));
  }
  /** 检查中收到已批准更新：有效 PM 记录 interrupt/defer；interrupt 同时请求停止。 */
  decide(input: Static<typeof DecideInput>): CheckRoundView {
    let request: Static<typeof DecideInput>;
    try { request = checked(DecideInput, input); } catch { throw new CheckRoundError("invalid_shape"); }
    this.authorize({ action: "decide", requirementId: request.lease.requirementId, lease: request.lease, checkRoundId: request.checkRoundId });
    return view(withDatabase(this.database, (db) => db.transaction(() => {
      const round = this.load(db, request.checkRoundId, request.lease);
      const current = db.read<{ pendingRevision?: number | null; revision?: number }>("requirements", request.lease.requirementId)?.data;
      if (!current || current.pendingRevision !== request.revision || current.revision !== request.revision) throw new CheckRoundError("decision_conflict", "无对应待处理更新");
      if (round.data.status !== "open" && round.data.status !== "stopping") throw new CheckRoundError("round_not_open");
      if (round.data.decision) {
        if (round.data.decision.kind === request.kind && round.data.decision.revision === request.revision) return round.data;
        throw new CheckRoundError("decision_conflict");
      }
      const data: CheckRound = { ...round.data, decision: { kind: request.kind, revision: request.revision, at: this.now() },
        status: request.kind === "interrupt" ? "stopping" : round.data.status, updatedAt: this.now() };
      db.update(CHECK_ROUNDS, round.id, round.version, data);
      return data;
    })));
  }
  /** 监听到受保护输入变化（即使内容又恢复）：本轮及其运行中的验证失效，阶段保护保持到进程结束。 */
  observeInputChange(input: Static<typeof ObserveInput>): CheckRoundView {
    let request: Static<typeof ObserveInput>;
    try { request = checked(ObserveInput, input); } catch { throw new CheckRoundError("invalid_shape"); }
    const known = withDatabase(this.database, (db) => readCheckRoundIn(db, request.checkRoundId));
    if (!known || known.data.repoId !== this.options.repoId) throw new CheckRoundError("not_found");
    this.authorize({ action: "observe", requirementId: known.data.requirementId, checkRoundId: request.checkRoundId });
    return view(withDatabase(this.database, (db) => db.transaction(() => {
      const round = readCheckRoundIn(db, request.checkRoundId);
      if (!round) throw new CheckRoundError("not_found");
      if (round.data.status === "released" || round.data.invalidation) return round.data;
      const now = this.now();
      const invalidation = { reason: "observed_change" as const, detail: request.paths.filter((path) => !isProdArchivePath(path)).slice(0, 16).join(",") };
      for (const verificationId of round.data.verifications) {
        const run = readVerificationIn(db, verificationId);
        if (run && (run.data.status === "running" || run.data.status === "passed" || run.data.status === "failed")) {
          db.update(VERIFICATION_RUNS, run.id, run.version, { ...run.data, status: run.data.status === "running" ? run.data.status : "invalidated", invalidation });
        }
      }
      const data: CheckRound = { ...round.data, invalidation, updatedAt: now };
      db.update(CHECK_ROUNDS, round.id, round.version, data);
      return data;
    })));
  }
}

export interface FormalEvidence {
  verificationId: string; kind: VerificationRun["kind"]; status: "passed" | "failed" | "unknown"; applicable: boolean; reasons: string[];
  checkRoundId: string | null; approvedProdHash: string; revision: number; codeHead: string; specSetHash: string; targetSpecSetHash: string | null;
  inputHash: string; performance: Static<typeof VerificationPerformance>;
}
/**
 * 证据适用性按当前实际内容重算：正文批准版本、代码/spec/环境指纹任一变化即不适用；
 * 记录本身不改写，重填 hash 或刷新索引都不能恢复通过。
 */
export async function formalEvidence(config: { dataRoot: string; repoId: string }, verificationId: string): Promise<FormalEvidence | null> {
  checked(id, verificationId);
  const database = repositoryDatabase(config.dataRoot, config.repoId);
  const loaded = withDatabase(database, (db) => {
    const run = readVerificationIn(db, verificationId);
    if (!run || run.data.repoId !== config.repoId) return null;
    const round = run.data.checkRoundId ? readCheckRoundIn(db, run.data.checkRoundId) : null;
    const record = db.read<{ approved?: { hash?: string } | null; revision?: number; workspace?: { path?: string } | null; lifecycle?: string; epoch?: number }>("requirements", run.data.requirementId)?.data;
    return { run: run.data, round: round?.data ?? null, record: record ?? null };
  });
  if (!loaded) return null;
  const { run, round, record } = loaded;
  const reasons: string[] = [];
  if (run.kind !== "formal") reasons.push("debug_result");
  if (run.kind === "formal" && (!round || !round.verifications.includes(run.verificationId) || JSON.stringify(round.baseline) !== JSON.stringify(run.baseline))) reasons.push("round_binding_invalid");
  if (round?.invalidation) reasons.push(`round_${round.invalidation.reason}`);
  if (round && round.status !== "released") reasons.push("round_not_released");
  if (!record) reasons.push("requirement_missing");
  if (record && (record.approved?.hash !== run.baseline.approved.hash || record.revision !== run.baseline.revision)) reasons.push("prod_changed");
  if (record && record.epoch !== run.epoch) reasons.push("epoch_changed");
  if (record?.workspace?.path) {
    let manifest: InputManifest | null = null;
    try { manifest = await collectInputManifest(record.workspace.path); } catch { reasons.push("workspace_unavailable"); }
    if (manifest && !manifestMatchesBaseline(manifest, run.baseline)) reasons.push("input_changed");
  } else reasons.push("workspace_unavailable");
  const status = run.status === "passed" ? "passed" : run.status === "running" ? "unknown" : "failed";
  return freeze({ verificationId: run.verificationId, kind: run.kind, status, applicable: reasons.length === 0, reasons, checkRoundId: run.checkRoundId,
    approvedProdHash: run.baseline.approved.hash, revision: run.baseline.revision, codeHead: run.baseline.codeHead, specSetHash: run.baseline.specSetHash,
    targetSpecSetHash: run.baseline.targetSpecSetHash, inputHash: run.baseline.inputHash, performance: structuredClone(run.performance) });
}

/** spec_change 发布门槛：检查阶段已释放，且存在与候选集合/批准 prod 绑定、仍适用的正式通过证据。 */
export function createSpecPublishGate(config: { dataRoot: string; repoId: string }) {
  return async (request: { readonly grant: { readonly requirementId: string; readonly repoId: string }; readonly proposal: { readonly targetSpecSetHash: string; readonly approvedProdHash: string } }) => {
    if (request.grant.repoId !== config.repoId) return { checkPhaseReleased: false, evidence: null };
    const database = repositoryDatabase(config.dataRoot, config.repoId);
    const { active, candidates } = withDatabase(database, (db) => ({
      active: activeCheckRoundIn(db, config.repoId, request.grant.requirementId) !== null,
      candidates: db.list<unknown>(VERIFICATION_RUNS).map((row) => checked(VerificationRun, row.data))
        .filter((run) => run.repoId === config.repoId && run.requirementId === request.grant.requirementId && run.kind === "formal" && run.status === "passed" &&
          run.baseline.targetSpecSetHash === request.proposal.targetSpecSetHash && run.baseline.approved.hash === request.proposal.approvedProdHash)
        .map((run) => run.verificationId),
    }));
    if (active) return { checkPhaseReleased: false, evidence: null };
    for (const verificationId of candidates.reverse()) {
      const evidence = await formalEvidence(config, verificationId);
      if (evidence && evidence.applicable && evidence.status === "passed") {
        return { checkPhaseReleased: true, evidence: { verificationId, status: "passed" as const, targetSpecSetHash: evidence.targetSpecSetHash!,
          approvedProdHash: evidence.approvedProdHash, codeHead: evidence.codeHead } };
      }
    }
    return { checkPhaseReleased: true, evidence: null };
  };
}
