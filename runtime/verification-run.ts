import { spawn } from "node:child_process";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { activeCheckRoundIn, CHECK_ROUNDS, collectInputManifest, manifestMatchesBaseline, readCheckRoundIn, readVerificationIn,
  VerificationPerformance, VerificationRun, VERIFICATION_RUNS } from "./check-round.ts";
import type { CheckBaseline, CheckInvalidation, CheckRound, InputManifest } from "./check-round.ts";
import { sandboxLaunch } from "./command-boundary.ts";
import type { CommandBoundary } from "./command-boundary.ts";
import { authorizeToolAction } from "./core-permissions.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { readGit } from "./git-read.ts";
import { checked, hash, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { writeFileAtomic } from "./store.ts";

const Grant = object({
  role: Type.Union([Type.Literal("worker"), Type.Literal("pm"), Type.Literal("reviewer"), Type.Literal("qa")]),
  callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1, maxLength: 4096, pattern: "^refs/heads/" }), epoch: positive,
});
export type VerificationRunGrant = Static<typeof Grant>;
export const VERIFICATION_RUN_PARAMETERS = Type.Union([
  object({ action: Type.Literal("run"), kind: Type.Union([Type.Literal("debug"), Type.Literal("formal")]), command: Type.String({ minLength: 1, maxLength: 4096 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3_600_000 })), performance: VerificationPerformance }),
  object({ action: Type.Literal("stop"), verificationId: id }),
  object({ action: Type.Literal("status"), verificationId: id }),
]);
export type VerificationRunParameters = Static<typeof VERIFICATION_RUN_PARAMETERS>;
export type VerificationRunAction = VerificationRunParameters["action"];
export type VerificationRunErrorCode = "verification_denied" | "invalid_shape" | "kind_forbidden" | "check_phase_active" | "round_not_open"
  | "input_changed" | "not_found" | "resource_limit";
export class VerificationRunError extends Error {
  readonly code: VerificationRunErrorCode;
  constructor(code: VerificationRunErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "VerificationRunError"; this.code = code;
  }
}
export interface VerificationRunAuthorization { readonly grant: Readonly<VerificationRunGrant>; readonly action: VerificationRunAction }
export interface VerificationRunToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  grant: VerificationRunGrant;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造true。 */
  authorize: (request: Readonly<VerificationRunAuthorization>) => boolean;
}
export interface VerificationView {
  verificationId: string; kind: VerificationRun["kind"]; status: VerificationRun["status"]; checkRoundId: string | null;
  exitCode: number | null; signal: string | null; reason: string | null; invalidation: CheckInvalidation | null;
  baseline: CheckBaseline; performance: VerificationRun["performance"]; outputRoot: string; startedAt: number; finishedAt: number | null;
}
const DEFAULT_TIMEOUT_MS = 600_000;
const STOP_GRACE_MS = 2_000;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function viewOf(run: VerificationRun): VerificationView {
  return freeze({ verificationId: run.verificationId, kind: run.kind, status: run.status, checkRoundId: run.checkRoundId, exitCode: run.exitCode, signal: run.signal,
    reason: run.reason, invalidation: run.invalidation, baseline: structuredClone(run.baseline), performance: structuredClone(run.performance),
    outputRoot: run.outputRoot, startedAt: run.startedAt, finishedAt: run.finishedAt });
}

export async function createVerificationRunTool(options: VerificationRunToolOptions) {
  try { return await openVerificationRunTool(options); }
  catch { throw new VerificationRunError("verification_denied"); }
}

async function openVerificationRunTool(options: VerificationRunToolOptions) {
  const grant = freeze(checked(Grant, structuredClone(options.grant)));
  const deny: (code?: VerificationRunErrorCode, detail?: string) => never = (code = "verification_denied", detail) => { throw new VerificationRunError(code, detail); };
  let disposed = false;
  const ownerToken = uuidv7();
  const running = new Map<string, { child: ReturnType<typeof spawn>; cancel: () => void; done: Promise<void> }>();
  function host(action: VerificationRunAction) {
    if (disposed || !authorizeToolAction(grant.role, "verification_run", action)) deny();
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action })); } catch { return deny(); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny();
  }
  host("status");
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: grant.repoId };
  const state = await RequirementStateStore.open({ ...config, authorize: (request) => !disposed && request.repoId === grant.repoId &&
    ["open", "read"].includes(request.action) && (request.input.requirementId === undefined || request.input.requirementId === grant.requirementId) });
  const database = repositoryDatabase(options.dataRoot, grant.repoId);
  const repoDir = join(options.dataRoot, "repos", grant.repoId);
  const privateRoots = [
    ...["global.db", "global.db-wal", "global.db-shm"].map((name) => join(options.dataRoot, name)),
    ...["data.db", "data.db-wal", "data.db-shm", "index.db", "index.db-wal", "index.db-shm", "requirements", "sessions", "evidence", "backups"].map((name) => join(repoDir, name)),
  ];

  function activeRecord(): RequirementRecord & { workspace: NonNullable<RequirementRecord["workspace"]>; approved: NonNullable<RequirementRecord["approved"]> } {
    const data = state.read(grant.requirementId).data;
    const workspace = data.workspace, approved = data.approved;
    if (data.lifecycle !== "active" || data.recovery !== "ready" || !workspace || !approved || data.epoch !== grant.epoch || workspace.repoId !== grant.repoId ||
      workspace.workspaceId !== grant.workspaceId || workspace.branch !== grant.branch || workspace.requirementId !== grant.requirementId) deny();
    return { ...data, workspace, approved };
  }
  function own(run: VerificationRun): boolean {
    return run.runId === grant.runId && run.requirementId === grant.requirementId && run.repoId === grant.repoId && run.workspaceId === grant.workspaceId;
  }
  function saveRun(db: LocalDatabase, verificationId: string, mutate: (run: VerificationRun) => VerificationRun): VerificationRun {
    const stored = readVerificationIn(db, verificationId);
    if (!stored) throw new VerificationRunError("not_found");
    const data = checked(VerificationRun, mutate(stored.data));
    db.update(VERIFICATION_RUNS, verificationId, stored.version, data);
    return data;
  }
  function saveRound(db: LocalDatabase, checkRoundId: string, mutate: (round: CheckRound) => CheckRound): void {
    const stored = readCheckRoundIn(db, checkRoundId);
    if (!stored) return;
    db.update(CHECK_ROUNDS, checkRoundId, stored.version, { ...mutate(stored.data), updatedAt: Date.now() });
  }
  async function boundaryFor(root: string, outputRoot: string): Promise<CommandBoundary> {
    const readRoots = [root, dirname(await realpath(process.execPath)), outputRoot];
    try { readRoots.push(await realpath(join(root, "node_modules"))); } catch {}
    try { readRoots.push(await realpath(resolve(root, (await readGit(root, ["rev-parse", "--git-common-dir"])).stdout.trim()))); } catch {}
    const scratch = join(outputRoot, "tmp");
    return { readRoots: [...new Set(readRoots)], writeRoots: [join(outputRoot, "outputs"), scratch], deniedReads: privateRoots, deniedWrites: [root, ...privateRoots], scratch };
  }
  async function writeManifest(outputRoot: string, manifest: InputManifest): Promise<void> {
    await writeFileAtomic(join(outputRoot, "manifest.json"), JSON.stringify({ format: "verification-manifest/v1", codeHead: manifest.codeHead,
      specSetHash: manifest.specSetHash, inputHash: manifest.inputHash, environment: manifest.environment, files: manifest.files }, null, 2) + "\n");
  }

  async function run(params: Extract<VerificationRunParameters, { action: "run" }>): Promise<VerificationView> {
    host("run");
    if ((grant.role === "worker") !== (params.kind === "debug")) deny("kind_forbidden");
    const record = activeRecord();
    await verifyRequirementWorkspace(options.dataRoot, record.workspace);
    const root = await realpath(record.workspace.path);
    const manifest = await collectInputManifest(root);
    host("run");
    const verificationId = uuidv7();
    const outputRoot = join(repoDir, "verification", verificationId);
    await mkdir(join(outputRoot, "outputs"), { recursive: true, mode: 0o700 });
    await mkdir(join(outputRoot, "tmp"), { recursive: true, mode: 0o700 });
    await writeManifest(outputRoot, manifest);
    let started: VerificationRun | null;
    try {
      started = withDatabase(database, (db) => db.transaction(() => {
      const current = db.read<RequirementRecord>("requirements", grant.requirementId)?.data;
      if (!current || current.epoch !== grant.epoch || current.lifecycle !== "active" || current.revision !== record.revision ||
        JSON.stringify(current.approved) !== JSON.stringify(record.approved)) deny();
      const round = activeCheckRoundIn(db, grant.repoId, grant.requirementId);
      let baseline: CheckBaseline;
      let checkRoundId: string | null = null;
      if (params.kind === "formal") {
        if (!round || round.data.status !== "open" || round.data.invalidation) deny("round_not_open");
        if (round.data.epoch !== grant.epoch) deny();
        if (!manifestMatchesBaseline(manifest, round.data.baseline)) {
          // 失效登记必须随本事务提交，因此不能在此抛错；调用方据 null 拒绝本次运行。
          db.update(CHECK_ROUNDS, round.id, round.version, { ...round.data, invalidation: { reason: "input_changed", detail: "检查开始前受保护输入已变化" }, updatedAt: Date.now() });
          return null;
        }
        baseline = round.data.baseline; checkRoundId = round.data.checkRoundId;
      } else {
        if (round) deny("check_phase_active");
        baseline = { revision: record.revision, approved: record.approved, codeHead: manifest.codeHead, specSetHash: manifest.specSetHash as CheckBaseline["specSetHash"],
          targetSpecSetHash: null, inputHash: manifest.inputHash, inputCount: manifest.files.length, environment: manifest.environment };
      }
      const data = checked(VerificationRun, { format: "verification-run/v1", verificationId, kind: params.kind, requirementId: grant.requirementId, repoId: grant.repoId,
        workspaceId: grant.workspaceId, branch: grant.branch, epoch: grant.epoch, runId: grant.runId, role: grant.role, checkRoundId, command: params.command,
        outputRoot, baseline, performance: params.performance, status: "running", exitCode: null, signal: null, reason: null, invalidation: null, pid: null,
        ownerToken, startedAt: Date.now(), finishedAt: null });
      db.create(VERIFICATION_RUNS, verificationId, data, verificationId);
      if (checkRoundId) saveRound(db, checkRoundId, (item) => ({ ...item, verifications: [...item.verifications, verificationId], active: [...item.active, verificationId] }));
      return data;
      }));
    } catch (error) {
      await rm(outputRoot, { recursive: true, force: true });
      throw error;
    }
    if (!started) { await rm(outputRoot, { recursive: true, force: true }); throw new VerificationRunError("input_changed"); }
    return execute(started, root, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async function execute(started: VerificationRun, root: string, timeoutMs: number): Promise<VerificationView> {
    type Outcome = { status: VerificationRun["status"]; exitCode: number | null; signal: string | null; reason: string | null };
    let launch;
    try { launch = sandboxLaunch(started.command, await boundaryFor(root, started.outputRoot)); }
    catch (error) { return finalize(started, root, { status: "not_run", exitCode: null, signal: null, reason: (error as Error).message.slice(0, 1024) }); }
    const stdout = await open(join(started.outputRoot, "outputs", "stdout.log"), "w", 0o600);
    const stderr = await open(join(started.outputRoot, "outputs", "stderr.log"), "w", 0o600);
    let cancelled = false, timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, { cwd: root, env: launch.env, stdio: ["ignore", stdout.fd, stderr.fd] });
    } catch (error) {
      await stdout.close(); await stderr.close();
      return finalize(started, root, { status: "not_run", exitCode: null, signal: null, reason: (error as Error).message.slice(0, 1024) });
    }
    const outcome = new Promise<Outcome>((resolveOutcome) => {
      child.once("error", (error) => resolveOutcome({ status: "not_run", exitCode: null, signal: null, reason: error.message.slice(0, 1024) }));
      child.once("exit", (code, signal) => {
        if (cancelled) resolveOutcome({ status: "cancelled", exitCode: code, signal, reason: "已请求停止" });
        else if (timedOut) resolveOutcome({ status: "timeout", exitCode: code, signal, reason: `超过 ${timeoutMs}ms` });
        else resolveOutcome({ status: code === 0 ? "passed" : "failed", exitCode: code, signal, reason: null });
      });
    });
    if (child.pid) withDatabase(database, (db) => db.transaction(() => { saveRun(db, started.verificationId, (item) => ({ ...item, pid: child.pid ?? null })); }));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, STOP_GRACE_MS).unref();
    };
    const done = outcome.then(async (result) => {
      clearTimeout(timer);
      await stdout.close(); await stderr.close();
      running.delete(started.verificationId);
      return finalize(started, root, result);
    });
    running.set(started.verificationId, { child, cancel, done: done.then(() => undefined, () => undefined) });
    return done;
  }

  async function finalize(started: VerificationRun, root: string, outcome: { status: VerificationRun["status"]; exitCode: number | null; signal: string | null; reason: string | null }): Promise<VerificationView> {
    let after: InputManifest | null = null;
    try { after = await collectInputManifest(root); } catch {}
    if (outcome.status === "cancelled") await rm(join(started.outputRoot, "outputs"), { recursive: true, force: true });
    const final = withDatabase(database, (db) => db.transaction(() => {
      const round = started.checkRoundId ? readCheckRoundIn(db, started.checkRoundId) : null;
      let status = outcome.status;
      let invalidation: CheckInvalidation | null = null;
      if (round?.data.invalidation) { invalidation = round.data.invalidation; }
      else if (!after || !manifestMatchesBaseline(after, started.baseline)) {
        invalidation = { reason: "input_changed", detail: after ? "检查期间受保护输入已变化" : "检查结束后无法核对输入" };
      }
      if (invalidation && (status === "passed" || status === "failed")) status = "invalidated";
      const saved = saveRun(db, started.verificationId, (item) => ({ ...item, status, exitCode: outcome.exitCode, signal: outcome.signal, reason: outcome.reason,
        invalidation, pid: null, finishedAt: Date.now() }));
      if (started.checkRoundId) {
        saveRound(db, started.checkRoundId, (item) => ({ ...item, active: item.active.filter((entry) => entry !== started.verificationId),
          invalidation: item.invalidation ?? (invalidation?.reason === "input_changed" ? invalidation : null) }));
      }
      return saved;
    }));
    return viewOf(final);
  }

  function status(verificationId: string): VerificationView {
    const run = withDatabase(database, (db) => readVerificationIn(db, verificationId));
    if (!run || !own(run.data)) throw new VerificationRunError("not_found");
    return viewOf(run.data);
  }
  async function stop(verificationId: string): Promise<VerificationView> {
    const current = status(verificationId);
    const active = running.get(verificationId);
    if (active) { active.cancel(); await active.done; }
    return current.status === "running" && !active ? current : status(verificationId);
  }
  async function executeAction(input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > 64 * 1024) throw new VerificationRunError("resource_limit");
    let params: VerificationRunParameters;
    try { params = checkServiceInput(VERIFICATION_RUN_PARAMETERS, input); } catch { throw new VerificationRunError("invalid_shape"); }
    host(params.action);
    switch (params.action) {
      case "run": return run(params);
      case "stop": return stop(params.verificationId);
      case "status": return status(params.verificationId);
    }
  }
  return {
    execute: executeAction,
    async dispose() {
      disposed = true;
      for (const active of [...running.values()]) active.cancel();
      await Promise.all([...running.values()].map((active) => active.done));
    },
  };
}
