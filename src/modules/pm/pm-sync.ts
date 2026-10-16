import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AdvisedError, toolFailure, toolStep } from "./tool-failure.ts";
import { fetchTargetBranch, gitIn, includesCommit } from "./target-branch.ts";

export interface PmSyncOptions {
  repositoryRoot: string;
  worktree: string;
  branch: string;
  /** 会话仍有效且持有当前租约时为真。 */
  alive(): boolean;
  checkPhaseActive(): boolean;
  /** 没有执行中的子代理与未收尾的受管写入时为真。 */
  quiescent(): boolean;
}

type SyncResult =
  | { status: "up_to_date"; target: string; head: string }
  | { status: "rebased"; target: string; head: string; previousHead: string }
  | { status: "reapplied" | "conflicts"; target: string; head: string; previousHead: string; changed: string[]; conflicted: string[] };

const entries = (text: string) => text.split("\0").filter(Boolean);

/**
 * 把需求分支同步到目标分支最新提交：能 rebase 就 rebase；冲突时放弃 rebase，把需求分支全部改动合成一份，
 * 在目标分支最新提交上按三方合并重新应用并留在工作区（未暂存），冲突文件带冲突标记，交 PM 安排修复后提交。
 */
export async function syncTargetBranch(options: Omit<PmSyncOptions, "alive" | "checkPhaseActive" | "quiescent">): Promise<SyncResult> {
  const git = (args: string[], input?: string) => gitIn(options.worktree, args, input);
  const head = (await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
  if (head !== options.branch) throw new AdvisedError("branch_changed", { why: `当前分支 ${head} 不是需求分支 ${options.branch}`, next: "停止操作，不要自己切换分支；交用户处理" });
  if ((await git(["status", "--porcelain", "--untracked-files=all"])).stdout.trim()) throw new AdvisedError("worktree_dirty", { why: "需求 worktree 里有未提交的改动", next: "先用 git_commit 提交这些改动，再同步" });
  const target = await fetchTargetBranch(options.repositoryRoot, options.worktree);
  const previousHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (await includesCommit(options.worktree, target.sha)) return { status: "up_to_date", target: target.ref, head: previousHead };
  const rebased = await git(["rebase", "--no-autosquash", "--no-autostash", target.sha]).then(() => true, () => false);
  if (rebased) return { status: "rebased", target: target.ref, head: (await git(["rev-parse", "HEAD"])).stdout.trim(), previousHead };
  await git(["rebase", "--abort"]);
  const base = (await git(["merge-base", previousHead, target.sha])).stdout.trim();
  const patch = (await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", base, previousHead])).stdout;
  await git(["reset", "--hard", "--quiet", target.sha]);
  const applied = await git(["apply", "--3way", "--whitespace=nowarn"], patch).then(() => true, () => false);
  const conflicted = entries((await git(["diff", "-z", "--name-only", "--diff-filter=U"])).stdout);
  if (!applied && conflicted.length === 0) {
    await git(["reset", "--hard", "--quiet", previousHead]);
    throw new AdvisedError("sync_failed", { why: "需求改动无法重新应用到目标分支，已恢复原提交", next: "需求分支的改动没法自动合到目标分支上，交用户处理" });
  }
  await git(["reset", "--quiet"]);
  const changed = entries((await git(["status", "--porcelain", "-z", "--untracked-files=all"])).stdout).map((entry) => entry.slice(3));
  return { status: conflicted.length ? "conflicts" : "reapplied", target: target.ref, head: target.sha, previousHead, changed, conflicted };
}

export function createPmSyncTool(options: PmSyncOptions): ToolDefinition {
  return {
    name: "one_company_git_sync", label: "git_sync",
    description: "把需求分支同步到目标分支最新提交（进入最终检查前必须做）。能 rebase 就 rebase；有冲突时需求分支改动会合成一份重新应用在目标分支最新提交上，changed 列出全部待提交文件，conflicted 列出带冲突标记的文件，previousHead 是原提交；请派 worker 按 prod 与代码修复冲突，经任务级审查后用 git_commit 提交 changed 中的全部文件。须先提交所有改动，检查阶段与子代理执行期间不可用。",
    parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
    async execute() {
      try {
        if (!options.alive()) throw new AdvisedError("git_sync_denied", { why: "PM 会话已失效，不能再同步", next: "停止操作，不要重试；在回复里说明，由上级处理" });
        if (options.checkPhaseActive()) throw new AdvisedError("check_phase_active", { why: "检查阶段进行中，不能同步", next: "等检查轮结束后再同步" });
        if (!options.quiescent()) throw new AdvisedError("writers_active", { why: "子代理执行或受管写入还没结束", next: "等子代理结束后再同步" });
        const result = await syncTargetBranch(options);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      } catch (error) { throw toolFailure(toolStep("one_company_git_sync", {}), error); }
    },
  } as unknown as ToolDefinition;
}
