import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { activeForeignHosts, snapshotBranchState, verifyBranchState } from "./branch-guard.ts";
import type { BranchSnapshot } from "./branch-guard.ts";
import { changedPaths } from "./git-snapshot.ts";
import { fingerprint, overlaps, resolveRepoRelative } from "./ranges.ts";
import type { Holder, RangeClaims } from "./ranges.ts";
import type { RunStore } from "./run-store.ts";
import { invalidateEvidence, listEvidenceStages } from "./workflow-state.ts";
import type { WorkflowContext } from "./workflow-state.ts";
import type { WindowRegistry } from "./windows.ts";

function holdersEqual(a: Holder, b: Holder): boolean {
  return a.kind === b.kind && a.runId === b.runId && a.windowId === b.windowId && a.requirement === b.requirement;
}

function describeHolder(holder: Holder): string {
  return holder.runId ?? holder.windowId ?? holder.kind;
}

function toAbsoluteWithDirMarker(cwd: string, rawPath: string): string {
  const isDir = rawPath.endsWith("/");
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  return isDir && !absolute.endsWith("/") ? `${absolute}/` : absolute;
}

async function deepestExistingAncestor(absPath: string): Promise<{ real: string; remainder: string[] }> {
  let current = absPath.endsWith(sep) ? absPath.slice(0, -1) || sep : absPath;
  const remainder: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      return { real, remainder };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`无法解析路径祖先: ${absPath}`);
      remainder.unshift(basename(current));
      current = parent;
    }
  }
}

// 符号链接可能把仓库内一个合法路径指向别处（仓库外，或仓库内的另一个范围）：字符串层面的规整看不出这点，
// 占用与范围判定必须落在"最深已存在祖先"的真实路径拼回剩余段之后，词法路径只用于逃逸时的报错文案
export async function resolveRealRepoPath(repoRoot: string, absTarget: string, isDir: boolean): Promise<string> {
  const realRoot = await realpath(repoRoot);
  const { real, remainder } = await deepestExistingAncestor(absTarget);
  const resolvedTarget = remainder.length > 0 ? join(real, ...remainder) : real;
  const rel = relative(realRoot, resolvedTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径逃逸仓库边界（符号链接指向仓库外）: ${absTarget}`);
  }
  const posixRel = rel.split(sep).join("/");
  return isDir ? `${posixRel}/` : posixRel;
}

export async function checkWrite(input: {
  repoRoot: string;
  cwd: string;
  path: string;
  writePaths: string[];
  holder: Holder;
  claims: RangeClaims;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const isDir = input.path.endsWith("/");
  const absTarget = toAbsoluteWithDirMarker(input.cwd, input.path);

  let realPath: string;
  try {
    realPath = await resolveRealRepoPath(input.repoRoot, absTarget, isDir);
  } catch (error) {
    return { allowed: false, reason: (error as Error).message };
  }

  const occupant = await input.claims.holderOf(realPath);
  if (occupant && !holdersEqual(occupant, input.holder)) {
    return { allowed: false, reason: `路径已被占用（持有者 ${describeHolder(occupant)}）: ${realPath}` };
  }

  let scoped: string[];
  try {
    scoped = input.writePaths.map((p) => resolveRepoRelative(input.repoRoot, p));
  } catch (error) {
    return { allowed: false, reason: (error as Error).message };
  }
  if (!scoped.some((scopePath) => overlaps(scopePath, realPath))) {
    return { allowed: false, reason: `路径超出本任务获准范围: ${realPath}` };
  }

  return { allowed: true };
}

async function foreignIntersection(repoRoot: string, claims: RangeClaims, holder: Holder): Promise<string[]> {
  const changed = await changedPaths(repoRoot);
  const foreign: string[] = [];
  for (const path of changed) {
    const occupant = await claims.holderOf(path);
    if (occupant && !holdersEqual(occupant, holder)) foreign.push(path);
  }
  return foreign;
}

export async function snapshotForeignRanges(input: {
  repoRoot: string;
  claims: RangeClaims;
  holder: Holder;
}): Promise<Record<string, string>> {
  const foreign = (await input.claims.entries()).filter((claim) => !holdersEqual(claim.holder, input.holder)).flatMap((claim) => claim.paths);
  if (foreign.length === 0) return {};
  return fingerprint(input.repoRoot, foreign);
}

export async function verifyAfterCommand(input: {
  repoRoot: string;
  claims: RangeClaims;
  holder: Holder;
  snapshot: Record<string, string>;
}): Promise<string[]> {
  const foreignNow = await foreignIntersection(input.repoRoot, input.claims, input.holder);
  const violations: string[] = [];
  for (const path of foreignNow) {
    if (!(path in input.snapshot)) violations.push(path);
  }
  const snapshotPaths = Object.keys(input.snapshot);
  if (snapshotPaths.length > 0) {
    const currentFingerprint = await fingerprint(input.repoRoot, snapshotPaths);
    for (const [path, expected] of Object.entries(input.snapshot)) {
      if (currentFingerprint[path] !== expected && !violations.includes(path)) violations.push(path);
    }
  }
  return violations;
}

export async function snapshotWorkspace(input: { repoRoot: string }): Promise<Record<string, string>> {
  const paths = await changedPaths(input.repoRoot);
  if (paths.length === 0) return {};
  return fingerprint(input.repoRoot, paths);
}

export async function verifyWorkspace(input: {
  repoRoot: string;
  snapshot: Record<string, string>;
  excludePaths?: string[];
}): Promise<{ writes: string[] }> {
  const exclude = input.excludePaths ?? [];
  const isExcluded = (path: string): boolean => exclude.some((ex) => overlaps(ex, path));

  const writes = new Set<string>();
  const currentPaths = await changedPaths(input.repoRoot);
  for (const path of currentPaths) {
    if (!(path in input.snapshot) && !isExcluded(path)) writes.add(path);
  }

  // 快照里记录的路径按内容指纹重新核对：git status 不再列出它（比如被还原为与 HEAD 一致）
  // 不代表命令期间没有写过，指纹变化才是唯一可信的信号
  const snapshotPaths = Object.keys(input.snapshot);
  if (snapshotPaths.length > 0) {
    const currentFingerprint = await fingerprint(input.repoRoot, snapshotPaths);
    for (const [path, expected] of Object.entries(input.snapshot)) {
      if (currentFingerprint[path] !== expected && !isExcluded(path)) writes.add(path);
    }
  }

  return { writes: [...writes] };
}

export async function invalidateValidations(input: { workflowCtx: WorkflowContext; reason: string }): Promise<void> {
  const stages = await listEvidenceStages(input.workflowCtx);
  for (const stage of stages) {
    await invalidateEvidence(input.workflowCtx, stage, input.reason);
  }
}

async function markRunFailed(runStore: RunStore, runId: string, reason: string): Promise<void> {
  try {
    await runStore.update(runId, { state: "failed", stateReason: reason });
  } catch {
    // 运行已处于终态（含此前已标 failed）时状态转换本身不再允许，只补写原因不抛给调用方
    await runStore.update(runId, { stateReason: reason });
  }
}

async function recordStateReason(runStore: RunStore, runId: string, reason: string): Promise<void> {
  try {
    await runStore.update(runId, { stateReason: reason });
  } catch {
    // 留痕失败（运行不存在/存储故障）不得顶掉 afterCommand 已经算出的核对结果，原因仍在返回的 violations 里
  }
}

export async function reportViolation(input: {
  runStore: RunStore;
  runId: string;
  paths: string[];
  claims: RangeClaims;
  workflowCtx: WorkflowContext;
}): Promise<void> {
  const reason = `写入越界: ${input.paths.join(", ")}`;
  const foreignRequirements = new Set<string>();
  for (const path of input.paths) {
    const occupant = await input.claims.holderOf(path);
    if (occupant?.requirement) foreignRequirements.add(occupant.requirement);
  }

  // 失效先于标 failed：即便随后状态更新失败，被越界方的证据也不能停留在"看似有效"
  for (const requirement of foreignRequirements) {
    await invalidateValidations({
      workflowCtx: { dataRoot: input.workflowCtx.dataRoot, cwd: input.workflowCtx.cwd, requirement },
      reason,
    });
  }

  await markRunFailed(input.runStore, input.runId, reason);
}

export interface CommandToken {
  repoRoot: string;
  holder: Holder;
  claims: RangeClaims;
  runStore: RunStore;
  runId: string;
  workflowCtx: WorkflowContext;
  windows: WindowRegistry;
  windowId: string;
  snapshot: Record<string, string>;
  branchBefore: BranchSnapshot;
}

export async function beforeCommand(input: {
  repoRoot: string;
  holder: Holder;
  claims: RangeClaims;
  runStore: RunStore;
  runId: string;
  workflowCtx: WorkflowContext;
  windows: WindowRegistry;
  windowId: string;
}): Promise<CommandToken> {
  if (!input.windows) throw new Error("beforeCommand 需要 windows 才能核对分支现场是否存在其他活动宿主");
  if (!input.windowId) throw new Error("beforeCommand 需要 windowId 才能核对分支现场是否存在其他活动宿主");
  const snapshot = await snapshotForeignRanges({ repoRoot: input.repoRoot, claims: input.claims, holder: input.holder });
  const branchBefore = await snapshotBranchState({ repoRoot: input.repoRoot });
  return { ...input, snapshot, branchBefore };
}

export async function afterCommand(
  token: CommandToken,
): Promise<{ violations: string[]; branchViolation?: { hosts: string[] } }> {
  let rangeViolations: string[] = [];
  let branchResult: Awaited<ReturnType<typeof verifyBranchState>> | undefined;
  let verifyError: string | undefined;

  // 核对链路（changedPaths/指纹/分支采集走 git，activeForeignHosts 走 windows.list()/runStore.list() 本地存储）
  // 任一环节失败都不代表命令越界，但也不能悄悄放过——留痕到 stateReason，交给使用方自己判断要不要再核对一遍
  try {
    rangeViolations = await verifyAfterCommand({
      repoRoot: token.repoRoot,
      claims: token.claims,
      holder: token.holder,
      snapshot: token.snapshot,
    });
    const activeHosts = await activeForeignHosts({
      runStore: token.runStore,
      windows: token.windows,
      windowId: token.windowId,
      runId: token.runId,
    });
    branchResult = await verifyBranchState({ repoRoot: token.repoRoot, before: token.branchBefore, activeHosts });
  } catch (error) {
    verifyError = `核对失败: ${(error as Error).message}`;
  }

  const violations = [...rangeViolations];
  let branchViolation: { hosts: string[] } | undefined;
  let branchReason = "";
  if (branchResult?.violation) {
    branchReason = `分支现场已变化（宿主: ${branchResult.hosts.join(", ")}）`;
    branchViolation = { hosts: branchResult.hosts };
    violations.push(branchReason);
  } else if (branchResult?.undetermined) {
    branchReason = branchResult.reason ?? "无法判定分支现场是否变化";
    violations.push(branchReason);
  }

  if (rangeViolations.length > 0) {
    await reportViolation({
      runStore: token.runStore,
      runId: token.runId,
      paths: rangeViolations,
      claims: token.claims,
      workflowCtx: token.workflowCtx,
    });
  }
  if (branchViolation) {
    await markRunFailed(token.runStore, token.runId, branchReason);
  } else if (branchResult?.undetermined) {
    await recordStateReason(token.runStore, token.runId, branchReason);
  }
  if (verifyError) {
    violations.push(verifyError);
    await recordStateReason(token.runStore, token.runId, verifyError);
  }

  return { violations, branchViolation };
}
