import { createHash } from "node:crypto";
import { AdvisedError, COMMON_ADVICE, withDetail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { snapshotBranchState } from "../../core/exec/branch-guard.ts";
import { isPrdArchivePath } from "../../core/policy/content-policy.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { readGitBytes } from "../../core/exec/git-read.ts";
import { checked, commit, counter, hash, id, object, PmLease, positive, PrdReference } from "../requirement/requirement-contracts.ts";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn } from "../requirement/requirement-coordination.ts";
import { RequirementStateStore } from "../requirement/requirement-state.ts";
import { verifyRequirementWorkspace } from "../requirement/requirement-workspace.ts";
import { isTerminalState } from "../agents/run-store.ts";
import type { RunRecord } from "../agents/run-store.ts";
import type { DeliveryMode } from "../../core/exec/git-host.ts";
import { includesCommit, localTargetBranch } from "../../core/exec/target-branch.ts";

export const CHECK_ROUNDS = "check_rounds";
export const VERIFICATION_RUNS = "verification_runs";
const CHANGE_SETS = "change_sets";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const InputEnvironment = object({ node: Type.String({ maxLength: 64 }), platform: Type.String({ maxLength: 32 }), arch: Type.String({ maxLength: 32 }) });
export const CheckBaseline = object({
  revision: positive, approved: PrdReference, codeHead: commit, inputHash: hash, inputCount: counter, environment: InputEnvironment,
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

const CHECK_ROUND_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  session_inactive: COMMON_ADVICE.session_inactive,
  requirement_changed: { why: "需求已不是 PM 接手时的状态", next: "重新读取需求状态后再决定是否开检查轮" },
  invalid_shape: COMMON_ADVICE.invalid_shape,
  pending_update: { why: "有新批准的需求版本还没复核", next: "先用 requirement_manage diff 读完新版本与上一版的差异（上下文压缩后可再查），再用 plan_manage assess-update 逐任务复核，再开检查轮" },
  check_round_active: { why: "已有一个检查轮在进行", next: "用 status 查看现有检查轮，先结束它再开新的" },
  workers_active: { why: "还有 worker 或 reviewer 运行未结束", next: "等这些运行结束或停止后再开检查轮" },
  writes_pending: { why: "还有未完成的代码写入", next: "等写入完成后再开检查轮" },
  not_found: { why: "找不到这个检查轮，或它不属于本需求", next: "用 status 查看当前检查轮编号" },
  verification_active: { why: "检查轮里还有检查在运行", next: "等检查结束或停止后再结束检查轮" },
  round_not_open: { why: "检查轮已不是开放状态", next: "用 status 查看检查轮状态" },
  check_phase_active: { why: "检查阶段进行中，不能做这个操作", next: "等检查轮结束后再做" },
  decision_conflict: { why: "检查轮已登记了不同的中断或继续决定，或没有对应的待处理更新", next: "用 status 查看检查轮现有的决定" },
  stale_pm_lease: { why: "PM 已交还租约、被新 PM 接管，或守护进程重启后作废了旧租约，或需求已换代", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  tasks_not_reviewed: { why: "还有完成的 worker 任务没经过审查", next: "先派 reviewer 审查这些任务，再开检查轮" },
  sync_required: { why: "需求分支没有包含目标分支的最新提交", next: "请用户把目标分支合入需求分支后再开检查轮" },
} as const satisfies Record<string, FailureAdvice>;
export type CheckRoundErrorCode = keyof typeof CHECK_ROUND_ADVICE;
export class CheckRoundError extends Error {
  readonly code: CheckRoundErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: CheckRoundErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "CheckRoundError"; this.code = code; this.advice = withDetail(CHECK_ROUND_ADVICE[code], detail);
  }
}

export interface InputManifest {
  codeHead: string; inputHash: string; environment: Static<typeof InputEnvironment>;
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

/** 实际输入清单：worktree 中 Git 跟踪与未忽略文件的内容指纹，排除 docs/prd；不读取本机数据目录。 */
export async function collectInputManifest(root: string): Promise<InputManifest> {
  const listing = await readGitBytes(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = [...new Set(listing.stdout.toString("utf8").split("\u0000").filter((entry) => entry.length > 0))]
    .filter((path) => !isPrdArchivePath(path)).sort();
  const files: Array<{ path: string; hash: string }> = [];
  for (const path of paths) {
    const absolute = join(root, ...path.split("/"));
    let stats;
    try { stats = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { files.push({ path, hash: "absent" }); continue; } throw error; }
    if (stats.isSymbolicLink()) { files.push({ path, hash: sha256(`symlink:${await readlink(absolute)}`) }); continue; }
    if (!stats.isFile()) continue;
    const bytes = await readFile(absolute);
    files.push({ path, hash: sha256(bytes) });
  }
  const { head } = await snapshotBranchState({ repoRoot: root });
  const environment = { node: process.version, platform: process.platform, arch: process.arch };
  const inputHash = sha256(JSON.stringify([head, environment, files]));
  return { codeHead: head, inputHash, environment, files };
}

export function manifestMatchesBaseline(manifest: InputManifest, baseline: CheckBaseline): boolean {
  return manifest.inputHash === baseline.inputHash && manifest.codeHead === baseline.codeHead &&
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
/** 需求当前生效的检查阶段：本 epoch 的轮次未退出，或仍有验证进程未结束；epoch 已变的轮次随撤权一并失效。 */
export function activeCheckRoundIn(db: LocalDatabase, repoId: string, requirementId: string): StoredRecord<CheckRound> | null {
  const epoch = db.read<{ epoch?: number }>("requirements", requirementId)?.data.epoch;
  for (const row of db.list<unknown>(CHECK_ROUNDS)) {
    const round = checked(CheckRound, row.data);
    if (round.repoId !== repoId || round.requirementId !== requirementId || round.epoch !== epoch) continue;
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
/** 计划中尚未通过任务级审查的 worker 任务：最终检查只做全量测试与 QA，须在全部任务审查通过后进行。 */
export function unreviewedWorkerTasksIn(db: LocalDatabase, requirementId: string): string[] {
  const taskIds = db.read<{ taskIds?: string[] }>("plans", requirementId)?.data.taskIds ?? [];
  return taskIds.map((taskId) => db.read<{ key: string; role: string; status: string }>("tasks", taskId)?.data)
    .filter((task) => task !== undefined && task.role === "worker" && task.status !== "completed" && task.status !== "cancelled").map((task) => task!.key);
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
  deliveryMode: () => Promise<DeliveryMode>;
  /** 必须由宿主核验当前物理 PM 会话/调用者；不能从模型参数或角色文本构造 true。 */
  authorize: (request: Readonly<CheckRoundAuthorization>) => boolean;
  now?: () => number;
}
const OpenInput = object({ lease: PmLease });
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
 * 检查轮次的可信服务：进入检查前核验本轮写入已收尾并登记基线；轮次生效期间 change_apply/新验证以外的写入被拒绝。
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
    if (this.life.disposed) throw new CheckRoundError("tool_closed");
    let result: unknown;
    try { result = this.options.authorize(freeze(structuredClone(request))); } catch (error) { throw new CheckRoundError("session_inactive", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new CheckRoundError("session_inactive");
  }
  private validateLeaseIn(db: LocalDatabase, lease: PmLease): void {
    const owner = db.read<{ fence?: number; lease?: PmLease | null }>("pm_ownership", lease.requirementId)?.data;
    const record = db.read<{ epoch?: number; lifecycle?: string; recovery?: string }>("requirements", lease.requirementId)?.data;
    if (!owner?.lease || owner.fence !== lease.fence || owner.lease.runId !== lease.runId || owner.lease.fence !== lease.fence ||
      owner.lease.epoch !== lease.epoch || !record || record.epoch !== lease.epoch ||
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
    try { request = checked(OpenInput, input); } catch (error) { throw new CheckRoundError("invalid_shape", (error as Error).message); }
    const { lease } = request;
    this.authorize({ action: "open", requirementId: lease.requirementId, lease });
    const record = this.state.read(lease.requirementId).data;
    if (record.lifecycle !== "active" || record.recovery !== "ready") throw new CheckRoundError("requirement_changed", "需求不在活动状态");
    if (!record.approved) throw new CheckRoundError("requirement_changed", "需求没有批准版本");
    if (record.epoch !== lease.epoch) throw new CheckRoundError("requirement_changed", "需求已换代（epoch 变化）");
    if (!record.workspace || record.workspace.workspaceId !== lease.workspaceId) throw new CheckRoundError("requirement_changed", "需求工作区绑定已变化");
    if (record.pendingRevision !== null) throw new CheckRoundError("pending_update");
    await verifyRequirementWorkspace(this.options.dataRoot, record.workspace);
    await this.state.checkPm(lease);
    const manifest = await collectInputManifest(record.workspace.path);
    const target = await localTargetBranch(this.options.repositoryRoot, record.workspace.path, await this.options.deliveryMode()).catch((error: unknown) => {
      if (error instanceof AdvisedError) throw error;
      return null;
    });
    if (!target || !(await includesCommit(record.workspace.path, target.sha))) throw new CheckRoundError("sync_required", target?.ref ?? "目标分支未拉取");
    const workspace = record.workspace, approved = record.approved, revision = record.revision;
    this.authorize({ action: "open", requirementId: lease.requirementId, lease });
    const round = withDatabase(this.database, (db) => db.transaction(() => {
      this.validateLeaseIn(db, lease);
      const current = db.read<{ revision?: number; approved?: unknown; pendingRevision?: unknown }>("requirements", lease.requirementId)?.data;
      if (!current || current.revision !== revision || JSON.stringify(current.approved) !== JSON.stringify(approved)) throw new CheckRoundError("requirement_changed", "开检查轮期间批准版本已变化");
      if (current.pendingRevision !== null) throw new CheckRoundError("pending_update");
      if (activeCheckRoundIn(db, this.options.repoId, lease.requirementId)) throw new CheckRoundError("check_round_active");
      assertWritersQuiescentIn(db, this.options.repoId, lease.requirementId);
      const unreviewed = unreviewedWorkerTasksIn(db, lease.requirementId);
      if (unreviewed.length) throw new CheckRoundError("tasks_not_reviewed", unreviewed.join(","));
      const now = this.now();
      const data = checked(CheckRound, { format: "check-round/v1", checkRoundId: uuidv7(), requirementId: lease.requirementId, repoId: this.options.repoId,
        workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: lease.epoch, fence: lease.fence, runId: lease.runId,
        baseline: { revision, approved, codeHead: manifest.codeHead, inputHash: manifest.inputHash,
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
    try { return checked(RoundInput, input); } catch (error) { throw new CheckRoundError("invalid_shape", (error as Error).message); }
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
    try { request = checked(DecideInput, input); } catch (error) { throw new CheckRoundError("invalid_shape", (error as Error).message); }
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
    try { request = checked(ObserveInput, input); } catch (error) { throw new CheckRoundError("invalid_shape", (error as Error).message); }
    const known = withDatabase(this.database, (db) => readCheckRoundIn(db, request.checkRoundId));
    if (!known || known.data.repoId !== this.options.repoId) throw new CheckRoundError("not_found");
    this.authorize({ action: "observe", requirementId: known.data.requirementId, checkRoundId: request.checkRoundId });
    return view(withDatabase(this.database, (db) => db.transaction(() => {
      const round = readCheckRoundIn(db, request.checkRoundId);
      if (!round) throw new CheckRoundError("not_found");
      if (round.data.status === "released" || round.data.invalidation) return round.data;
      const now = this.now();
      const invalidation = { reason: "observed_change" as const, detail: request.paths.filter((path) => !isPrdArchivePath(path)).slice(0, 16).join(",") };
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
  checkRoundId: string | null; approvedPrdHash: string; revision: number; codeHead: string;
  inputHash: string; performance: Static<typeof VerificationPerformance>;
}
/**
 * 证据适用性按当前实际内容重算：正文批准版本、代码/环境指纹任一变化即不适用；
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
  if (record && (record.approved?.hash !== run.baseline.approved.hash || record.revision !== run.baseline.revision)) reasons.push("prd_changed");
  if (record && record.epoch !== run.epoch) reasons.push("epoch_changed");
  if (record?.workspace?.path) {
    let manifest: InputManifest | null = null;
    try { manifest = await collectInputManifest(record.workspace.path); } catch { reasons.push("workspace_unavailable"); }
    if (manifest && !manifestMatchesBaseline(manifest, run.baseline)) reasons.push("input_changed");
  } else reasons.push("workspace_unavailable");
  const status = run.status === "passed" ? "passed" : run.status === "running" ? "unknown" : "failed";
  return freeze({ verificationId: run.verificationId, kind: run.kind, status, applicable: reasons.length === 0, reasons, checkRoundId: run.checkRoundId,
    approvedPrdHash: run.baseline.approved.hash, revision: run.baseline.revision, codeHead: run.baseline.codeHead,
    inputHash: run.baseline.inputHash, performance: structuredClone(run.performance) });
}
