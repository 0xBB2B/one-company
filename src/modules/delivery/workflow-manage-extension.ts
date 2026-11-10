import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientsHandle } from "../../core/host/daemon-client.ts";
import { AdvisedError, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { leanToolResult } from "../../core/exec/tool-result.ts";
import { windowContext } from "../../core/host/extension-lifecycle.ts";
import { mutedItem, requirementLabel, summaryLine, toolCard } from "../../core/host/tool-card.ts";
import type { CardSpec } from "../../core/host/tool-card.ts";

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const target = { repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }), requirementId: Type.String({ pattern: UUID_V7 }) };
const strict = { additionalProperties: false } as const;
export const MAIN_WORKFLOW_MANAGE_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("status"), ...target }, strict),
  Type.Object({ action: Type.Literal("delivery-check"), ...target }, strict),
  Type.Object({ action: Type.Literal("close"), ...target, reason: Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]),
    receiptId: Type.String({ pattern: UUID_V7 }) }, strict),
]);
type Params = Static<typeof MAIN_WORKFLOW_MANAGE_PARAMETERS>;

const CLOSE_STATUS_TEXT: Record<string, string> = { none: "没在关闭", closing: "关闭中", closed: "已关闭" };
const WORKFLOW_CARDS = {
  actionOf: (args: unknown) => (args as { action?: string }).action,
  cards: {
    status: { title: "需求流程", object: (request) => requirementLabel(request.requirementId),
      summary: (details) => [CLOSE_STATUS_TEXT[details.result.close.status] ?? details.result.close.status] },
    "delivery-check": { title: "需求流程", object: (request) => requirementLabel(request.requirementId),
      summary: (details, theme) => {
        const { deliverable, blockers } = details.result as { deliverable: boolean; blockers: string[] };
        return [deliverable ? theme.fg("success", "可以交付") : [{ text: "还不能交付" }, mutedItem(theme, blockers[0]!, true), ...(blockers.length > 1 ? [mutedItem(theme, `共 ${blockers.length} 项`)] : [])]];
      } },
    close: { title: "关闭需求", object: (request) => requirementLabel(request.requirementId),
      summary: (details, theme) => {
        const { status, next } = details.result as { status: string; next?: string };
        return [status === "closed" ? theme.fg("success", "已关闭") : summaryLine(theme, status === "closing" ? "关闭中" : "没关闭", next)];
      } },
  },
} satisfies { actionOf: (args: unknown) => string | undefined; cards: Record<string, CardSpec> };

export interface WorkflowManageContext { clients: WorkspaceClientsHandle }

function pickKeys(source: unknown, keys: string[]): Record<string, unknown> {
  const from = (source ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));
}

function workflowManageView(action: Params["action"], value: Record<string, unknown>): unknown {
  if (action === "status") return value;
  const inner = (value.result ?? {}) as Record<string, unknown>;
  if (action === "delivery-check") return { result: pickKeys(inner, ["deliverable", "blockers"]) };
  const view = pickKeys(inner, ["status", "next", "message", "missing", "pending"]);
  if (inner.archive !== undefined) view.archive = inner.archive === null ? null : pickKeys(inner.archive, ["status", "reason", "next"]);
  return { result: view };
}

/** 主会话的 workflow_manage：经守护进程查看状态、交付核对与关闭需求；关闭须以用户决定的 decisionId 作为 receiptId。 */
export function registerWorkflowManageTool(pi: ExtensionAPI, context: () => WorkflowManageContext): void {
  const card = toolCard(WORKFLOW_CARDS);
  pi.registerTool({
    name: "one_company_workflow_manage",
    label: "workflow_manage",
    description: "查看需求状态（status）、交付核对（delivery-check）或关闭需求（close）。完成（completed）、取消（cancelled）或拒绝（rejected）都须先用 one_company_user_interact purpose=adjudicate 按用户原话登记决定（完成即用户验收通过 PM 的完成报告），再以返回的 decisionId 作为 receiptId。关闭没办完时，用原来的原因和决定编号再次 close，程序会接着办完。",
    parameters: MAIN_WORKFLOW_MANAGE_PARAMETERS,
    executionMode: "sequential",
    renderCall: (args, theme, context) => card.renderCall(args, theme, context),
    renderResult: (result, options, theme, context) => card.renderResult(result, options, theme, context),
    async execute(_toolCallId, rawParams) {
      const step = toolStep("one_company_workflow_manage", rawParams);
      if (!Value.Check(MAIN_WORKFLOW_MANAGE_PARAMETERS, rawParams)) throw toolFailure(step, new AdvisedError("invalid_shape",
        { why: "参数不符合该动作的格式", next: "按工具说明改正该动作的字段后重试" }));
      const { repoId, requirementId, ...request } = rawParams as Params;
      const client = context().clients.forRepo(repoId);
      if (!client) throw toolFailure(step, new AdvisedError("foreign_repo", { why: "repoId 不是当前窗口工作区里的仓库", next: "改用当前工作区列出的仓库编号" }));
      try { const value = await client.call("workflow.manage", { requirementId, request }); return leanToolResult(value, workflowManageView(request.action, value)); }
      catch (error) { throw toolFailure(step, error); }
    },
  });
}

export default function workflowManageExtension(pi: ExtensionAPI): void {
  registerWorkflowManageTool(pi, () => ({ clients: windowContext().clients }));
}
