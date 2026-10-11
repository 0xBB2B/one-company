import { createHash } from "node:crypto";
import { COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { snapshotBranchState } from "./branch-guard.ts";
import { assertModificationAllowedIn, CheckRoundError } from "./check-round.ts";
import { authorizeToolAction, writePathAllowed } from "./core-permissions.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import { overlaps } from "./ranges.ts";
import { checked, hash, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { writeFileAtomic } from "./store.ts";
import { resolveRealRepoPath } from "./write-guard.ts";

const CHANGE_SETS = "change_sets";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const relativePath = Type.String({ minLength: 1, maxLength: 1024 });
const fileHash = Type.Union([hash, Type.Literal("absent")]);
const Grant = object({
  role: Type.Literal("worker"), callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1, maxLength: 4096, pattern: "^refs/heads/" }), epoch: positive,
  writePaths: Type.Array(relativePath, { minItems: 1, maxItems: 64 }),
  scratchRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
export type ChangeApplyGrant = Static<typeof Grant>;
const content = Type.Union([Type.String({ maxLength: MAX_FILE_BYTES }), Type.Null()]);
const inlineFile = object({ path: relativePath, baseHash: fileHash, content });
// 预检只读不写，可省略 baseHash，结果给出当前值供 apply 使用
const prepareFile = object({ path: relativePath, baseHash: Type.Optional(fileHash), content });
// 模型抄写 64 位指纹常出错；apply 省略时用本会话对同一文件最近一次预检的值，预检后文件被改仍判 stale_base
const applyFile = object({ path: relativePath, baseHash: Type.Optional(fileHash), content });
const scratchFile = object({ path: relativePath, baseHash: fileHash, sourcePath: relativePath, targetHash: hash });
export const CHANGE_APPLY_PARAMETERS = Type.Union([
  object({ action: Type.Literal("prepare"), files: Type.Array(prepareFile, { minItems: 1, maxItems: 64 }) }),
  object({ action: Type.Literal("apply"), operationId: id, files: Type.Array(applyFile, { minItems: 1, maxItems: 64 }) }),
  object({ action: Type.Literal("import"), operationId: id, files: Type.Array(scratchFile, { minItems: 1, maxItems: 64 }) }),
  object({ action: Type.Literal("status"), operationId: id }),
]);
export type ChangeApplyParameters = Static<typeof CHANGE_APPLY_PARAMETERS>;
export type ChangeApplyAction = ChangeApplyParameters["action"];
const FileState = object({ path: relativePath, baseHash: fileHash, targetHash: fileHash,
  status: Type.Union([Type.Literal("pending"), Type.Literal("written"), Type.Literal("failed"), Type.Literal("stale")]),
  reason: Type.Optional(Type.String({ maxLength: 512 })) });
const ChangeSet = object({
  format: Type.Literal("change-set/v1"), operationId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1 }), epoch: positive, intentHash: hash, baseHead: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("applying"), Type.Literal("applied"), Type.Literal("partial_failure"), Type.Literal("stale")]),
  files: Type.Array(FileState), createdAt: positive, updatedAt: positive,
});
export type ChangeSet = Static<typeof ChangeSet>;
const CHANGE_APPLY_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  action_not_allowed: COMMON_ADVICE.action_not_allowed,
  session_inactive: COMMON_ADVICE.session_inactive,
  open_failed: COMMON_ADVICE.open_failed,
  grant_invalid: { why: "派工身份记录不合规，角色、写入范围或需求绑定无法识别", next: "停止操作，不要重试；在回复里说明，由上级处理" },
  requirement_changed: { why: "需求已不是派工时的状态", next: "停止操作，不要重试；在回复里说明，由上级按新状态重新安排" },
  invalid_shape: COMMON_ADVICE.invalid_shape,
  forbidden_path: { why: "这个路径不允许写入", next: "只写授权范围内的普通文件" },
  path_escape: { why: "路径经过链接或 .. 指到了工作区以外", next: "改用工作区内的真实路径" },
  out_of_scope: { why: "路径不在本任务的授权写入范围内", next: "只改授权范围内的文件；确实需要时在结果里说明，由 PM 调整任务" },
  stale_base: { why: "文件或分支在预检后已被改动", next: "重新 prepare 取得最新 baseHash 后再写入" },
  operation_conflict: { why: "这个操作编号已用于别的写入", next: "换一个新生成的操作编号重试" },
  import_mismatch: { why: "要导入的生成文件与声明不一致，或不是 UTF-8 文本文件", next: "重新生成文件并按实际内容填写 targetHash" },
  resource_limit: { why: "请求或文件超出大小上限", next: "拆成更小的改动后分次写入" },
  not_found: { why: "找不到这次写入记录，或它不属于本运行", next: "核对操作编号" },
  check_phase_active: { why: "检查阶段进行中，不能修改代码", next: "等检查轮结束后再修改" },
} as const satisfies Record<string, FailureAdvice>;
export type ChangeApplyErrorCode = keyof typeof CHANGE_APPLY_ADVICE;
export class ChangeApplyError extends Error {
  readonly code: ChangeApplyErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: ChangeApplyErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "ChangeApplyError"; this.code = code; this.advice = withDetail(CHANGE_APPLY_ADVICE[code], detail);
  }
}
export interface ChangeApplyAuthorization { readonly grant: Readonly<ChangeApplyGrant>; readonly action: ChangeApplyAction }
export interface ChangeApplyToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  grant: ChangeApplyGrant;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造true。 */
  authorize: (request: Readonly<ChangeApplyAuthorization>) => boolean;
}
interface Planned { path: string; baseHash: string; targetHash: string; content: Buffer | null; absolute: string }

function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
async function currentHash(absolute: string): Promise<string> {
  let stats;
  try { stats = await lstat(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  if (!stats.isFile()) throw new ChangeApplyError("forbidden_path", "目标不是普通文件");
  return sha256(await readFile(absolute));
}
function intentHashOf(files: ReadonlyArray<{ path: string; baseHash: string; targetHash: string }>): string {
  return sha256(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map((file) => [file.path, file.baseHash, file.targetHash])));
}

export async function createChangeApplyTool(options: ChangeApplyToolOptions) {
  try { return await openChangeApplyTool(options); }
  catch (error) { throw error instanceof ChangeApplyError ? error : new ChangeApplyError("open_failed", (error as Error).message); }
}

async function openChangeApplyTool(options: ChangeApplyToolOptions) {
  let grant: ChangeApplyGrant;
  try { grant = freeze(checked(Grant, structuredClone(options.grant))); } catch { throw new ChangeApplyError("grant_invalid"); }
  const deny: (code: ChangeApplyErrorCode, detail?: string) => never = (code, detail) => { throw new ChangeApplyError(code, detail); };
  let disposed = false;
  const prepared = new Map<string, string>();
  function host(action: ChangeApplyAction) {
    if (disposed) deny("tool_closed");
    if (!authorizeToolAction(grant.role, "change_apply", action)) deny("action_not_allowed", `${grant.role} 不能做 ${action}`);
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action })); } catch (error) { return deny("session_inactive", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny("session_inactive");
  }
  host("status");
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: grant.repoId };
  const state = await RequirementStateStore.open({ ...config, authorize: (request) => !disposed && request.repoId === grant.repoId &&
    ["open", "read"].includes(request.action) && (request.input.requirementId === undefined || request.input.requirementId === grant.requirementId) });
  const database = repositoryDatabase(options.dataRoot, grant.repoId);

  function activeWorkspace(): NonNullable<RequirementRecord["workspace"]> {
    const record = state.read(grant.requirementId);
    const workspace = record.data.workspace;
    if (record.data.lifecycle !== "active" || record.data.recovery !== "ready") deny("requirement_changed", "需求不在活动状态");
    if (record.data.epoch !== grant.epoch) deny("requirement_changed", "需求已换代（epoch 变化）");
    if (!workspace || workspace.repoId !== grant.repoId || workspace.workspaceId !== grant.workspaceId || workspace.branch !== grant.branch ||
      workspace.requirementId !== grant.requirementId) deny("requirement_changed", "需求工作区绑定已变化");
    return workspace;
  }
  async function bindWorkspace(action: ChangeApplyAction) {
    host(action);
    const workspace = activeWorkspace();
    await verifyRequirementWorkspace(options.dataRoot, workspace);
    host(action);
    return { root: await realpath(workspace.path), workspace };
  }
  async function locate(root: string, path: string): Promise<string> {
    if (!writePathAllowed(path)) throw new ChangeApplyError("forbidden_path", path);
    const normalized = posix.normalize(path);
    if (!grant.writePaths.some((allowed) => overlaps(allowed, normalized))) throw new ChangeApplyError("out_of_scope", path);
    let real: string;
    try { real = await resolveRealRepoPath(root, join(root, ...normalized.split("/")), false); }
    catch { throw new ChangeApplyError("path_escape", path); }
    if (real !== normalized) throw new ChangeApplyError("path_escape", path);
    return join(root, ...normalized.split("/"));
  }
  async function readScratch(sourcePath: string): Promise<Buffer> {
    if (!grant.scratchRoot) throw new ChangeApplyError("forbidden_path", "未授权生成目录");
    const scratch = await realpath(grant.scratchRoot);
    const normalized = posix.normalize(sourcePath);
    if (isAbsolute(sourcePath) || sourcePath.includes("\\") || sourcePath.includes("\u0000") || normalized === ".." || normalized.startsWith("../")) {
      throw new ChangeApplyError("path_escape", sourcePath);
    }
    let real: string;
    try { real = await realpath(join(scratch, ...normalized.split("/"))); }
    catch { throw new ChangeApplyError("import_mismatch", sourcePath); }
    const rel = relative(scratch, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ChangeApplyError("path_escape", sourcePath);
    if (!(await lstat(real)).isFile()) throw new ChangeApplyError("import_mismatch", sourcePath);
    const bytes = await readFile(real);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ChangeApplyError("resource_limit", sourcePath);
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) throw new ChangeApplyError("import_mismatch", `${sourcePath} 不是 UTF-8 文本`);
    return bytes;
  }
  async function plan(root: string, params: { files: ReadonlyArray<Static<typeof inlineFile> | Static<typeof scratchFile>> }): Promise<Planned[]> {
    const seen = new Set<string>();
    const planned: Planned[] = [];
    for (const file of params.files) {
      const absolute = await locate(root, file.path);
      const normalized = posix.normalize(file.path);
      if (seen.has(normalized)) throw new ChangeApplyError("invalid_shape", `重复路径 ${normalized}`);
      seen.add(normalized);
      let content: Buffer | null;
      if ("sourcePath" in file) {
        content = await readScratch(file.sourcePath);
        if (sha256(content) !== file.targetHash) throw new ChangeApplyError("import_mismatch", file.path);
      } else content = file.content === null ? null : Buffer.from(file.content, "utf8");
      const targetHash = content === null ? "absent" : sha256(content);
      if (file.baseHash === "absent" && targetHash === "absent") throw new ChangeApplyError("invalid_shape", `删除不存在的文件 ${normalized}`);
      planned.push({ path: normalized, baseHash: file.baseHash, targetHash, content, absolute });
    }
    return planned;
  }
  async function observe(planned: Planned[]): Promise<Array<{ path: string; currentHash: string }>> {
    const result = [];
    for (const file of planned) result.push({ path: file.path, currentHash: await currentHash(file.absolute) });
    return result;
  }
  function modificationAllowed(db: Parameters<typeof assertModificationAllowedIn>[0]): void {
    try { assertModificationAllowedIn(db, grant.repoId, grant.requirementId); }
    catch (error) { if (error instanceof CheckRoundError) throw new ChangeApplyError("check_phase_active"); throw error; }
  }
  function readSet(operationId: string) {
    return withDatabase(database, (db) => {
      const row = db.read<unknown>(CHANGE_SETS, operationId);
      return row ? { version: row.version, data: checked(ChangeSet, row.data) } : null;
    });
  }
  function ownSet(set: ChangeSet) {
    return set.runId === grant.runId && set.requirementId === grant.requirementId && set.repoId === grant.repoId &&
      set.workspaceId === grant.workspaceId && set.branch === grant.branch && set.epoch === grant.epoch;
  }
  function saveSet(version: number, data: ChangeSet): number {
    return withDatabase(database, (db) => db.transaction(() => db.update(CHANGE_SETS, data.operationId, version, checked(ChangeSet, { ...data, updatedAt: Date.now() }))));
  }
  async function write(file: Planned): Promise<void> {
    if (file.content === null) { await rm(file.absolute, { force: true }); return; }
    await mkdir(dirname(file.absolute), { recursive: true });
    await writeFileAtomic(file.absolute, file.content.toString("utf8"));
  }
  async function run(action: "apply" | "import", params: { operationId: string; files: ReadonlyArray<Static<typeof inlineFile> | Static<typeof scratchFile>> }) {
    const { root } = await bindWorkspace(action);
    const planned = await plan(root, params);
    const intentHash = intentHashOf(planned);
    const existing = readSet(params.operationId);
    if (existing && (!ownSet(existing.data) || existing.data.intentHash !== intentHash)) throw new ChangeApplyError("operation_conflict");
    withDatabase(database, (db) => modificationAllowed(db));
    const head = (await snapshotBranchState({ repoRoot: root })).head;
    const observed = await observe(planned);
    let version: number;
    let set: ChangeSet;
    if (existing) {
      version = existing.version; set = structuredClone(existing.data);
      if (set.status === "applied") return freeze({ status: set.status, operationId: set.operationId, baseHead: set.baseHead, files: set.files });
      if (set.baseHead !== head) {
        version = saveSet(version, { ...set, status: "stale" });
        throw new ChangeApplyError("stale_base", "分支提交已变化");
      }
    } else {
      const stale = planned.flatMap((file, index) => observed[index]!.currentHash === file.baseHash ? [] : [`${file.path} 当前 baseHash=${observed[index]!.currentHash}`]);
      if (stale.length > 0) throw new ChangeApplyError("stale_base", stale.join(","));
      host(action);
      set = checked(ChangeSet, { format: "change-set/v1", operationId: params.operationId, runId: grant.runId, requirementId: grant.requirementId,
        repoId: grant.repoId, workspaceId: grant.workspaceId, branch: grant.branch, epoch: grant.epoch, intentHash, baseHead: head,
        status: "applying", files: planned.map((file) => ({ path: file.path, baseHash: file.baseHash, targetHash: file.targetHash, status: "pending" })),
        createdAt: Date.now(), updatedAt: Date.now() });
      version = withDatabase(database, (db) => db.transaction(() => {
        modificationAllowed(db);
        if (db.read(CHANGE_SETS, set.operationId)) throw new ChangeApplyError("operation_conflict");
        return db.create(CHANGE_SETS, set.operationId, set).version;
      }));
    }
    for (const file of planned) {
      const entry = set.files.find((candidate) => candidate.path === file.path);
      if (!entry) throw new ChangeApplyError("operation_conflict");
      if (entry.status === "written") continue;
      host(action);
      const current = await currentHash(file.absolute);
      if (current === file.targetHash) { entry.status = "written"; delete entry.reason; version = saveSet(version, set); continue; }
      if (current !== file.baseHash) {
        entry.status = "stale"; entry.reason = "目标文件已被外部修改"; set.status = "stale";
        saveSet(version, set);
        return freeze({ status: set.status, operationId: set.operationId, baseHead: set.baseHead, files: set.files });
      }
      try {
        await write(file);
        if (await currentHash(file.absolute) !== file.targetHash) throw new Error("写入后指纹不符");
      } catch (error) {
        entry.status = "failed"; entry.reason = (error instanceof Error ? error.message : String(error)).slice(0, 512); set.status = "partial_failure";
        saveSet(version, set);
        return freeze({ status: set.status, operationId: set.operationId, baseHead: set.baseHead, files: set.files });
      }
      entry.status = "written"; delete entry.reason;
      version = saveSet(version, set);
    }
    for (const file of planned) {
      if (await currentHash(file.absolute) === file.targetHash) continue;
      const entry = set.files.find((candidate) => candidate.path === file.path)!;
      entry.status = "stale"; entry.reason = "目标文件已被外部修改"; set.status = "stale";
      saveSet(version, set);
      throw new ChangeApplyError("stale_base", file.path);
    }
    set.status = "applied";
    saveSet(version, set);
    host(action); activeWorkspace();
    return freeze({ status: set.status, operationId: set.operationId, baseHead: set.baseHead, files: set.files });
  }

  async function execute(input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > MAX_REQUEST_BYTES) throw new ChangeApplyError("resource_limit");
    let params: ChangeApplyParameters;
    try { params = checkServiceInput(CHANGE_APPLY_PARAMETERS, input); } catch (error) { throw new ChangeApplyError("invalid_shape", (error as Error).message); }
    host(params.action);
    if (params.action === "status") {
      const set = readSet(params.operationId);
      if (!set || !ownSet(set.data)) throw new ChangeApplyError("not_found");
      return freeze({ status: set.data.status, operationId: set.data.operationId, baseHead: set.data.baseHead, files: set.data.files });
    }
    if (params.action === "prepare") {
      const { root } = await bindWorkspace("prepare");
      const files = [];
      for (const file of params.files) files.push({ ...file, baseHash: file.baseHash ?? await currentHash(await locate(root, file.path)) });
      const planned = await plan(root, { files });
      const observed = await observe(planned);
      const stale = planned.flatMap((file, index) => observed[index]!.currentHash === file.baseHash ? [] : [`${file.path} 当前 baseHash=${observed[index]!.currentHash}`]);
      if (stale.length > 0) throw new ChangeApplyError("stale_base", stale.join(","));
      const head = (await snapshotBranchState({ repoRoot: root })).head;
      host("prepare");
      for (const file of planned) prepared.set(file.path, file.baseHash);
      return freeze({ status: "ready" as const, baseHead: head, files: planned.map((file) => ({ path: file.path, baseHash: file.baseHash, targetHash: file.targetHash })) });
    }
    if (params.action === "import") return run("import", params);
    const files = params.files.map((file) => {
      const baseHash = file.baseHash ?? prepared.get(posix.normalize(file.path));
      if (baseHash === undefined) throw new ChangeApplyError("invalid_shape", `${file.path} 没有预检过，先 prepare 或填 baseHash`);
      return { ...file, baseHash };
    });
    return run("apply", { operationId: params.operationId, files });
  }
  return { execute, dispose() { disposed = true; } };
}
