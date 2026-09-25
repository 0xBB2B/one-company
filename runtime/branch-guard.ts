import { readGit } from "./git-read.ts";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface BranchSnapshot {
  head: string;
  branch: string | null;
}

function runGit(repoRoot: string, args: string[]): Promise<string> {
  return readGit(repoRoot, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }).then((result) => result.stdout.trim());
}

// 只读 HEAD 与分支名：不走 collectGitSnapshot，避免命令期间工作区差异巨大时被 diff/status 的
// maxBuffer 拖累而拒绝执行——分支现场判定压根不需要内容层面的东西
export async function snapshotBranchState(input: { repoRoot: string }): Promise<BranchSnapshot> {
  const head = await runGit(input.repoRoot, ["rev-parse", "HEAD"]);
  const rawBranch = await runGit(input.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { head, branch: rawBranch === "HEAD" ? null : rawBranch };
}
