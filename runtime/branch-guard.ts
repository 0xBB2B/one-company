import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changedEntries } from "./git-snapshot.ts";
import type { ChangedEntry } from "./git-snapshot.ts";
import { overlaps } from "./ranges.ts";
import { RUNNING_LIKE_STATES } from "./run-store.ts";
import type { RunStore } from "./run-store.ts";
import type { WindowRegistry } from "./windows.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface BranchSnapshot {
  head: string;
  branch: string | null;
}

function runGit(repoRoot: string, args: string[]): Promise<string> {
  return execFileAsync("git", args, {
    cwd: repoRoot,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C" },
  }).then((result) => result.stdout.trim());
}

// 只读 HEAD 与分支名：不走 collectGitSnapshot，避免命令期间工作区差异巨大时被 diff/status 的
// maxBuffer 拖累而拒绝执行——分支现场判定压根不需要内容层面的东西
export async function snapshotBranchState(input: { repoRoot: string }): Promise<BranchSnapshot> {
  const head = await runGit(input.repoRoot, ["rev-parse", "HEAD"]);
  const rawBranch = await runGit(input.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { head, branch: rawBranch === "HEAD" ? null : rawBranch };
}

type AncestorResult = "ancestor" | "not-ancestor" | "undetermined";

// 退出码 1 是 --is-ancestor 明确判定"不是后代"；其余失败（128 等 git 故障、超时）说明判不出来，
// 不能当成"确定发生了切换/重置"处理，否则会把 git 自身故障误报成分支违规
async function isAncestorCommit(repoRoot: string, ancestor: string, descendant: string): Promise<AncestorResult> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C" },
    });
    return "ancestor";
  } catch (error) {
    return (error as { code?: number }).code === 1 ? "not-ancestor" : "undetermined";
  }
}

export async function verifyBranchState(input: {
  repoRoot: string;
  before: BranchSnapshot;
  activeHosts: string[];
}): Promise<{ violation: boolean; changed: boolean; hosts: string[]; undetermined?: boolean; reason?: string }> {
  const after = await snapshotBranchState({ repoRoot: input.repoRoot });
  const branchChanged = after.branch !== input.before.branch;
  const headChanged = after.head !== input.before.head;
  const changed = branchChanged || headChanged;

  if (!branchChanged && headChanged) {
    const ancestorResult = await isAncestorCommit(input.repoRoot, input.before.head, after.head);
    if (ancestorResult === "ancestor") {
      return { violation: false, changed, hosts: input.activeHosts };
    }
    if (ancestorResult === "undetermined") {
      return {
        violation: false,
        changed,
        hosts: input.activeHosts,
        undetermined: true,
        reason: "无法判定 HEAD 是否为快进推进：merge-base 判定失败",
      };
    }
  }

  return { violation: changed && input.activeHosts.length > 0, changed, hosts: input.activeHosts };
}

export async function activeForeignHosts(input: {
  runStore: RunStore;
  windows: WindowRegistry;
  windowId: string;
  runId: string;
}): Promise<string[]> {
  const hosts: string[] = [];
  const windowList = await input.windows.list();
  for (const window of windowList) {
    if (window.liveness === "alive" && window.windowId !== input.windowId) hosts.push(`window-${window.windowId}`);
  }
  // 跨需求汇总：分支是整个仓库共享的现场，其他需求下运行中的任务同样构成风险
  const runs = await input.runStore.list({ states: [...RUNNING_LIKE_STATES], limit: Number.MAX_SAFE_INTEGER });
  for (const run of runs.items) {
    if (run.id !== input.runId) hosts.push(`run-${run.id}`);
  }
  return hosts;
}

export interface ScopedCommitBlocked {
  paths: string[];
  reason: string;
}

export interface ScopedCommitResult {
  paths: string[];
  blocked: ScopedCommitBlocked[];
}

export async function scopedCommitPaths(input: { repoRoot: string; writePaths: string[]; entries?: ChangedEntry[] }): Promise<ScopedCommitResult> {
  const entries = input.entries ?? await changedEntries(input.repoRoot);
  const paths: string[] = [];
  const blocked: ScopedCommitBlocked[] = [];
  for (const entry of entries) {
    const inScope = entry.paths.map((path) => input.writePaths.some((scope) => overlaps(scope, path)));
    if (inScope.every(Boolean)) {
      paths.push(...entry.paths);
    } else if (inScope.some(Boolean)) {
      // 重命名一端在范围内一端在范围外：整条不提交，既不能带走他人范围的内容，也不能替他人留下半条记录
      blocked.push({ paths: entry.paths, reason: `重命名跨越获准范围边界，不纳入提交: ${entry.paths.join(" ↔ ")}` });
    }
  }
  return { paths, blocked };
}
