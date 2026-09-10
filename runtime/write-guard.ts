import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { changedPaths } from "./git-snapshot.ts";
import { fingerprint } from "./ranges.ts";
import type { Holder, RangeClaims } from "./ranges.ts";
import { invalidateEvidence, listEvidenceStages } from "./workflow-state.ts";
import type { WorkflowContext } from "./workflow-state.ts";

function holdersEqual(a: Holder, b: Holder): boolean {
  return a.kind === b.kind && a.runId === b.runId && a.windowId === b.windowId && a.requirement === b.requirement;
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

async function foreignIntersection(repoRoot: string, claims: RangeClaims, holder: Holder, paths?: string[]): Promise<string[]> {
  const changed = paths ?? await changedPaths(repoRoot);
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

// 文件变化用于使旧证据失效；共享工作区的变化不能归责于某个并行命令。
export async function changedForeignRanges(input: {
  repoRoot: string;
  claims: RangeClaims;
  holder: Holder;
  snapshot: Record<string, string>;
  changedPaths?: string[];
}): Promise<string[]> {
  const foreignNow = await foreignIntersection(input.repoRoot, input.claims, input.holder, input.changedPaths);
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

export async function invalidateValidations(input: { workflowCtx: WorkflowContext; reason: string }): Promise<void> {
  const stages = await listEvidenceStages(input.workflowCtx);
  for (const stage of stages) {
    await invalidateEvidence(input.workflowCtx, stage, input.reason);
  }
}
