import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { windowContext } from "./lifecycle.ts";

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$" });
const runId = Type.String({ pattern: UUID_V7 });
const strict = { additionalProperties: false } as const;
export const MAIN_AGENT_MANAGE_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("dispatch"), role: Type.Literal("pm"), repoId, requirementId: Type.String({ pattern: UUID_V7 }) }, strict),
  Type.Object({ action: Type.Literal("status"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("pause"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("resume"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("stop"), repoId, runId }, strict),
]);
type Params = Static<typeof MAIN_AGENT_MANAGE_PARAMETERS>;

export interface AgentManageContext { clients: WorkspaceClientsHandle }

function result(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { isError } };
}

/** 主会话的 agent_manage：经守护进程派出唯一 PM、查询或控制运行；模型与思考等级取派工时主会话的当前值。 */
export function registerAgentManageTool(pi: ExtensionAPI, context: () => AgentManageContext): void {
  pi.registerTool({
    name: "pi_company_agent_manage",
    label: "agent_manage",
    description: "派出本需求唯一 PM（role=pm），或查询、暂停、续接、停止运行。PM 需要需求工作区已 ready 并已有批准版本。",
    parameters: MAIN_AGENT_MANAGE_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      if (!Value.Check(MAIN_AGENT_MANAGE_PARAMETERS, rawParams)) return result({ code: "invalid_shape" }, true);
      const params = rawParams as Params;
      const client = context().clients.forRepo(params.repoId);
      if (!client) return result({ code: "foreign_repo" }, true);
      try {
        if (params.action === "dispatch") {
          const model = ctx.model;
          if (!model) return result({ code: "model_unavailable" }, true);
          return result(await client.call("agents.dispatchPm", { requirementId: params.requirementId,
            model: { provider: model.provider, id: model.id }, thinking: pi.getThinkingLevel() }));
        }
        const method = params.action === "status" ? "runs.get" : `runs.${params.action}`;
        return result(await client.call(method, { runId: params.runId }));
      } catch (error) {
        return result({ code: (error as { code?: string }).code ?? "agent_manage_failed" }, true);
      }
    },
  });
}

export default function agentManageExtension(pi: ExtensionAPI): void {
  registerAgentManageTool(pi, () => ({ clients: windowContext().clients }));
}
