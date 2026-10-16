import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientsHandle } from "../../core/host/daemon-client.ts";
import { AdvisedError, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { windowContext } from "../../core/host/extension-lifecycle.ts";

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const target = { repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }), requirementId: Type.String({ pattern: UUID_V7 }) };
const strict = { additionalProperties: false } as const;
export const MAIN_WORKFLOW_MANAGE_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("status"), ...target }, strict),
  Type.Object({ action: Type.Literal("delivery-check"), ...target }, strict),
  Type.Object({ action: Type.Literal("close"), ...target, reason: Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]),
    receiptId: Type.String({ pattern: UUID_V7 }), operationId: Type.String({ pattern: UUID_V7 }) }, strict),
]);
type Params = Static<typeof MAIN_WORKFLOW_MANAGE_PARAMETERS>;

export interface WorkflowManageContext { clients: WorkspaceClientsHandle }

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

/** 主会话的 workflow_manage：经守护进程查看状态、交付核对与关闭需求；关闭须以用户决定的 decisionId 作为 receiptId。 */
export function registerWorkflowManageTool(pi: ExtensionAPI, context: () => WorkflowManageContext): void {
  pi.registerTool({
    name: "one_company_workflow_manage",
    label: "workflow_manage",
    description: "查看需求状态（status）、交付核对（delivery-check）或关闭需求（close）。完成（completed）、取消（cancelled）或拒绝（rejected）都须先用 one_company_user_interact purpose=adjudicate 按用户原话登记决定（完成即用户验收通过 PM 的完成报告），再以返回的 decisionId 作为 receiptId。",
    parameters: MAIN_WORKFLOW_MANAGE_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      const step = toolStep("one_company_workflow_manage", rawParams);
      if (!Value.Check(MAIN_WORKFLOW_MANAGE_PARAMETERS, rawParams)) throw toolFailure(step, new AdvisedError("invalid_shape",
        { why: "参数不符合该动作的格式", next: "按工具说明改正该动作的字段后重试" }));
      const { repoId, requirementId, ...request } = rawParams as Params;
      const client = context().clients.forRepo(repoId);
      if (!client) throw toolFailure(step, new AdvisedError("foreign_repo", { why: "repoId 不是当前窗口工作区里的仓库", next: "改用当前工作区列出的仓库编号" }));
      try { return result(await client.call("workflow.manage", { requirementId, request })); }
      catch (error) { throw toolFailure(step, error); }
    },
  });
}

export default function workflowManageExtension(pi: ExtensionAPI): void {
  registerWorkflowManageTool(pi, () => ({ clients: windowContext().clients }));
}
