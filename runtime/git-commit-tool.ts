import { Type } from "typebox";
import { resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { projectBaselineForContext } from "./project-baseline-hooks.ts";

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
    async execute(id, input, signal, _update, ctx) {
      const hooks = projectBaselineForContext(ctx);
      if (hooks) await hooks.assertCall(id);
      const commitPaths = await commit(ctx.cwd);
      const operation = async (baselineSignal?: AbortSignal) => {
        const combined = signal && baselineSignal ? AbortSignal.any([signal, baselineSignal]) : signal ?? baselineSignal;
        combined?.throwIfAborted();
        return commitPaths(input.paths.map((path) => resolve(ctx.cwd, path)), input.message, combined);
      };
      // actual execute 绑定原 callId；commit 仍完整经过既有范围、暂存保护及沙箱。
      // Git 元数据不是 expectedWrites 文件证明，未知副作用不能推进原请求的 executionHead。
      const output = hooks ? await hooks.withMutation(id, { paths: [] }, operation) : await operation();
      return { content: [{ type: "text", text: output }], details: {} };
    },
  };
}
