import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeliveryMode } from "./git-host.ts";
import { AdvisedError } from "./tool-failure.ts";

const exec = promisify(execFile);

/** 固定参数的 Git 调用：不运行 hook、不签名、不弹编辑器或凭据提示。 */
export function gitIn(cwd: string, args: string[], input?: string) {
  const child = exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
    { cwd, maxBuffer: 1 << 26, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" } });
  if (input !== undefined) {
    // Git 提前退出时写标准输入会报 EPIPE；不监听就成了进程级未捕获异常，成败交给 Git 的退出码判断
    child.child.stdin!.on("error", () => undefined);
    child.child.stdin!.end(input);
  }
  return child;
}

export interface TargetBranch { name: string; ref: string; remote: "origin" | null; sha: string }

async function hasOrigin(worktree: string): Promise<boolean> {
  return gitIn(worktree, ["remote", "get-url", "origin"]).then(() => true, () => false);
}

export async function checkedOutBranch(repositoryRoot: string, worktree: string): Promise<TargetBranch> {
  const ref = (await gitIn(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]).catch((error: { code?: unknown }) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  })).stdout.trim();
  if (!ref) throw new AdvisedError("target_unknown", { why: "主仓库当前没有检出分支", next: "请用户在主仓库检出要合进去的分支后再继续" });
  return { name: ref.slice("refs/heads/".length), ref, remote: null, sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
}

/** 目标分支：remote 档有 origin 时取远端默认分支并拉取最新提交，其余取主仓库当前检出的分支。 */
export async function fetchTargetBranch(repositoryRoot: string, worktree: string, mode: DeliveryMode): Promise<TargetBranch> {
  return mode === "remote" && await hasOrigin(worktree) ? fetchRemoteTarget(worktree) : checkedOutBranch(repositoryRoot, worktree);
}

/** 拉取 origin 的默认分支并记下它，供不联网的检查门槛使用。 */
export async function fetchRemoteTarget(worktree: string): Promise<TargetBranch> {
  const symref = (await gitIn(worktree, ["ls-remote", "--symref", "origin", "HEAD"])).stdout;
  const name = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref)?.[1];
  if (!name) throw new AdvisedError("target_unknown", { why: "无法确定远端默认分支：origin 没有默认分支，可能远端还是空仓库", next: "交用户处理：先把目标分支推送到远端，或设好远端默认分支" });
  const ref = `refs/remotes/origin/${name}`;
  await gitIn(worktree, ["fetch", "--no-tags", "origin", `+refs/heads/${name}:${ref}`]);
  await gitIn(worktree, ["symbolic-ref", "refs/remotes/origin/HEAD", ref]);
  return { name, ref, remote: "origin", sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
}

/** 不联网的目标分支：local 档取主仓库当前检出的分支；remote 档有 origin 时取上次拉取记下的远端默认分支，从未拉取过则报需要同步。 */
export async function localTargetBranch(repositoryRoot: string, worktree: string, mode: DeliveryMode): Promise<TargetBranch> {
  if (mode === "remote" && await hasOrigin(worktree)) {
    const ref = (await gitIn(worktree, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!ref) throw new Error("sync_required: 尚未拉取过目标分支");
    return { name: ref.slice("refs/remotes/origin/".length), ref, remote: "origin", sha: (await gitIn(worktree, ["rev-parse", ref])).stdout.trim() };
  }
  return checkedOutBranch(repositoryRoot, worktree);
}

export async function includesCommit(worktree: string, sha: string, head = "HEAD"): Promise<boolean> {
  return gitIn(worktree, ["merge-base", "--is-ancestor", sha, head]).then(() => true, () => false);
}
