import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** 固定参数的 Git 调用：不运行 hook、不签名、不弹编辑器或凭据提示。 */
export function gitIn(cwd: string, args: string[], input?: string) {
  const child = exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
    { cwd, maxBuffer: 1 << 26, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" } });
  if (input !== undefined) { child.child.stdin!.end(input); }
  return child;
}

export interface TargetBranch { name: string; ref: string; remote: "origin" | null; sha: string }

async function hasOrigin(worktree: string): Promise<boolean> {
  return gitIn(worktree, ["remote", "get-url", "origin"]).then(() => true, () => false);
}

/** 目标分支：有 origin 时取远端默认分支并拉取最新提交，没有时取主仓库当前检出的分支。 */
export async function fetchTargetBranch(repositoryRoot: string, worktree: string): Promise<TargetBranch> {
  return await hasOrigin(worktree) ? fetchRemoteTarget(worktree) : localTargetBranch(repositoryRoot, worktree);
}

/** 拉取 origin 的默认分支并记下它，供不联网的检查门槛使用。 */
export async function fetchRemoteTarget(worktree: string): Promise<TargetBranch> {
  const symref = (await gitIn(worktree, ["ls-remote", "--symref", "origin", "HEAD"])).stdout;
  const name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1];
  if (!name) throw new Error("target_unknown: 无法确定远端默认分支");
  const ref = `refs/remotes/origin/${name}`;
  await gitIn(worktree, ["fetch", "--no-tags", "origin", `+refs/heads/${name}:${ref}`]);
  await gitIn(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD", ref]);
  return { name, ref, remote: "origin", sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
}

/** 不联网的目标分支：有 origin 时取上次拉取记下的远端默认分支，从未拉取过则报需要同步。 */
export async function localTargetBranch(repositoryRoot: string, worktree: string): Promise<TargetBranch> {
  if (await hasOrigin(worktree)) {
    const ref = (await gitIn(worktree, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!ref) throw new Error("sync_required: 尚未拉取过目标分支");
    return { name: ref.slice("refs/remotes/origin/".length), ref, remote: "origin", sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
  }
  const ref = (await gitIn(repositoryRoot, ["symbolic-ref", "HEAD"])).stdout.trim();
  return { name: ref.slice("refs/heads/".length), ref, remote: null, sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
}

export async function includesCommit(worktree: string, sha: string, head = "HEAD"): Promise<boolean> {
  return gitIn(worktree, ["merge-base", "--is-ancestor", sha, head]).then(() => true, () => false);
}
