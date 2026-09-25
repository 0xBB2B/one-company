import { Type } from "typebox";
import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const parameters = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "本次提交的明确文件路径；重命名须同时列出新旧路径" }),
  message: Type.String({ minLength: 1, description: "提交信息，正文使用实际换行" }),
}, { additionalProperties: false });

export type CommitPaths = (paths: string[], message: string, signal?: AbortSignal) => Promise<string>;

export function createGitCommitTool(commit: (cwd: string) => Promise<CommitPaths>): ToolDefinition<typeof parameters> {
  return {
    name: "pi_company_git_commit", label: "提交获准文件",
    description: "提交明确指定且获准写入的文件，保留他人暂存内容。普通 Shell 的 Git 元数据只读。外部 hook、filter 和签名程序受执行隔离限制；失败时不绕过检查。",
    parameters,
    async execute(_id, input, signal, _update, ctx) {
      const cwd = ctx.cwd;
      const commitPaths = await commit(cwd);
      signal?.throwIfAborted();
      const output = await commitPaths(input.paths.map((path) => resolve(cwd, path)), input.message, signal);
      return { content: [{ type: "text", text: output }], details: {} };
    },
  };
}
