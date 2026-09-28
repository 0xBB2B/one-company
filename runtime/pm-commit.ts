import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { classifyManagedWritePath } from "./core-permissions.ts";

const exec = promisify(execFile);
const PARAMETERS = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 256, description: "本次提交的明确文件路径（相对需求 worktree）；重命名须同时列出新旧路径" }),
  message: Type.String({ minLength: 1, maxLength: 4096, description: "提交信息，建议写明对应任务" }),
}, { additionalProperties: false });

export interface PmCommitOptions {
  worktree: string;
  branch: string;
  /** 会话仍有效且持有当前租约时为真。 */
  alive(): boolean;
  /** 检查阶段禁止提交，保证 reviewer 看到的版本不变。 */
  checkPhaseActive(): boolean;
}

/** PM 在所绑定需求 worktree 分支内按任务本地提交：明确文件、保留他人暂存内容，不能切分支或推送。 */
export function createPmCommitTool(options: PmCommitOptions): ToolDefinition {
  const git = (args: string[]) => exec("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd: options.worktree, maxBuffer: 1 << 20 });
  return {
    name: "pi_company_git_commit", label: "git_commit",
    description: "在本需求 worktree 分支内提交明确列出的文件（按任务完成情况提交），保留其他已暂存内容；不能切换分支或推送，检查阶段不可用。",
    parameters: PARAMETERS, executionMode: "sequential",
    async execute(_id: string, params: { paths: string[]; message: string }) {
      if (!options.alive()) throw new Error("git_commit_denied: 会话已失效");
      if (options.checkPhaseActive()) throw new Error("check_phase_active: 检查阶段不能提交");
      for (const path of params.paths) {
        const kind = classifyManagedWritePath(path);
        if (kind === "outside" || kind === "git_metadata" || kind === "prod_archive" || kind === "project_conventions") throw new Error(`forbidden_path: ${path}`);
      }
      const head = (await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      if (head !== options.branch) throw new Error(`branch_changed: 当前分支 ${head} 不是需求分支 ${options.branch}`);
      const present: string[] = [];
      for (const path of params.paths) if (await lstat(join(options.worktree, path)).then(() => true, () => false)) present.push(path);
      if (present.length) await git(["add", "--", ...present]);
      await git(["commit", "--only", "-m", params.message, "--", ...params.paths]);
      const commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
      return { content: [{ type: "text", text: JSON.stringify({ commit, branch: options.branch, paths: params.paths }) }], details: {} };
    },
  } as unknown as ToolDefinition;
}
