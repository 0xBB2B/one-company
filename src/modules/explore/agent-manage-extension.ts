import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientsHandle } from "../../core/host/daemon-client.ts";
import { revokeCapturedInput, windowContext, windowReady } from "../../core/host/extension-lifecycle.ts";
import { EXPLORE_WEB_QUERY, exploreSource } from "./explore-dispatch.ts";
import { AdvisedError, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { leanToolResult } from "../../core/exec/tool-result.ts";
import { exploreReportView, exploreSourcesView } from "./explore-report.ts";
import type { ExploreReport } from "./explore-report.ts";
import { PM_MESSAGE_MAX_CHARS } from "../../core/host/protocol.ts";

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$" });
const runId = Type.String({ pattern: UUID_V7 });
const strict = { additionalProperties: false } as const;
export const MAIN_AGENT_MANAGE_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("dispatch"), role: Type.Literal("pm"), repoId, requirementId: Type.String({ pattern: UUID_V7 }) }, strict),
  Type.Object({ action: Type.Literal("dispatch"), role: Type.Literal("explore"), repoId,
    question: Type.String({ minLength: 1, maxLength: 1500 }), clues: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 8 })),
    maxTurns: Type.Integer({ minimum: 1, maximum: 100 }), ...EXPLORE_WEB_QUERY }, strict),
  Type.Object({ action: Type.Literal("status"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("pause"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("resume"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("stop"), repoId, runId }, strict),
  Type.Object({ action: Type.Literal("message"), repoId, requirementId: Type.String({ pattern: UUID_V7 }),
    text: Type.String({ minLength: 1, maxLength: PM_MESSAGE_MAX_CHARS }) }, strict),
  Type.Object({ action: Type.Literal("sources"), runId }, strict),
]);
type Params = Static<typeof MAIN_AGENT_MANAGE_PARAMETERS>;

export interface AgentManageContext { clients: WorkspaceClientsHandle }

function agentManageView(action: Params["action"], value: Record<string, unknown>): unknown {
  if (action === "dispatch") return { runId: value.runId };
  if (action !== "status") return value;
  const run = (value.run ?? {}) as Record<string, unknown>;
  return { run: Object.fromEntries(["state", "stateReason", "turns", "log"].filter((key) => run[key] !== undefined).map((key) => [key, run[key]])) };
}

const EXPLORE_RESULT_TYPE = "one-company.explore-result";

function findExploreReport(entries: ReadonlyArray<unknown>, id: string): ExploreReport | undefined {
  for (const entry of entries as Array<{ type?: string; customType?: string; details?: ExploreReport }>) {
    if (entry.type === "custom_message" && entry.customType === EXPLORE_RESULT_TYPE && entry.details?.runId === id && entry.details.research) return entry.details;
  }
  return undefined;
}

/** 主会话的 agent_manage：经守护进程派出唯一 PM 或 explore、查询或控制运行、向 PM 转述说明；模型与思考等级取派工时主会话的当前值。 */
export function registerAgentManageTool(pi: ExtensionAPI, context: () => AgentManageContext): void {
  pi.registerTool({
    name: "one_company_agent_manage",
    label: "agent_manage",
    description: "派出本需求唯一 PM（role=pm），或派出只读检索 explore（role=explore：问题、线索与轮次上限；不给 webQuery 时在仓库内检索本地文件，给出 webQuery 则联网检索，立即返回运行编号，结果到达后以卡片插入本会话，可同时派出多个），或查询、暂停、续接、停止运行，或用 sources 按运行编号取本会话收到过的检索结果的全部来源和检索范围，或用 message 把一段说明转给该需求运行中或暂停中的 PM（PM 看到的内容标为主代理转述，只作参考，不改变任务、计划或授权；需求内容的改动要修改草稿并请用户批准）。PM 需要需求工作区已 ready 并已有批准版本。",
    parameters: MAIN_AGENT_MANAGE_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const step = toolStep("one_company_agent_manage", rawParams);
      const fail: (code: string, why: string, next: string) => never = (code, why, next) => { throw toolFailure(step, new AdvisedError(code, { why, next })); };
      if (!Value.Check(MAIN_AGENT_MANAGE_PARAMETERS, rawParams)) fail("invalid_shape", "参数不符合该动作的格式", "按工具说明改正该动作的字段后重试");
      const params = rawParams as Params;
      if (params.action === "sources") {
        const report = findExploreReport(ctx.sessionManager.getBranch(), params.runId);
        if (!report) fail("no_such_result", "本会话里没有这个编号的检索结果", "核对运行编号，用派出检索时返回、检索结果里写的 runId；别的会话派出的检索在这里取不到");
        return leanToolResult(report, exploreSourcesView(report.runId, report.research!));
      }
      const client = context().clients.forRepo(params.repoId);
      if (!client) fail("foreign_repo", "repoId 不是当前窗口工作区里的仓库", "改用当前工作区列出的仓库编号");
      const model = ctx.model;
      if (params.action === "dispatch" && !model) fail("model_unavailable", "主会话当前没有选定模型，派出的运行要沿用主会话的模型", "请用户先选定模型再派");
      const result = (action: Params["action"], value: Record<string, unknown>) => leanToolResult(value, agentManageView(action, value));
      try {
        if (params.action === "dispatch") {
          const selected = { provider: model!.provider, id: model!.id }, thinking = pi.getThinkingLevel();
          if (params.role === "explore") {
            return result(params.action, await client.call("agents.dispatchExplore", { request: { question: params.question, clues: params.clues ?? [],
              source: exploreSource(params) }, maxTurns: params.maxTurns, model: selected, thinking }));
          }
          return result(params.action, await client.call("agents.dispatchPm", { requirementId: params.requirementId, model: selected, thinking }));
        }
        if (params.action === "message") return result(params.action, await client.call("pm.message", { requirementId: params.requirementId, text: params.text }));
        const method = params.action === "status" ? "runs.get" : `runs.${params.action}`;
        return result(params.action, await client.call(method, { runId: params.runId }));
      } catch (error) { throw toolFailure(step, error); }
    },
  });
}

/** main 派出的 explore 只属于派出它的窗口连接：结果到达时由该连接取回并以卡片插入本会话、由主代理接着处理。 */
export function registerExploreDelivery(pi: ExtensionAPI, context: () => Promise<{ clients: WorkspaceClientsHandle; repoIds: string[] }>): void {
  let sessionId: string | undefined;
  let unsubscribes: Array<() => void> = [];
  pi.on("session_start", async (_event, ctx) => {
    const next = ctx.sessionManager.getSessionId();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    sessionId = next;
    // 不阻塞会话启动：窗口就绪后再订阅
    void context().then(({ clients, repoIds }) => {
      if (sessionId !== next) return;
      for (const repoId of repoIds) {
        const client = clients.forRepo(repoId);
        if (!client) continue;
        unsubscribes.push(client.subscribe("explore.finished", (data) => {
          const event = data as { runId?: unknown; parentSessionId?: unknown };
          if (event.parentSessionId !== sessionId || typeof event.runId !== "string") return;
          void client.call("explore.result", { runId: event.runId }).then((report) => {
            revokeCapturedInput();
            pi.sendMessage({ customType: EXPLORE_RESULT_TYPE, content: JSON.stringify(exploreReportView(report as unknown as ExploreReport, "main")), details: report, display: true }, { triggerTurn: true });
          }).catch(() => {});
        }));
      }
    }).catch(() => {});
  });
  pi.on("session_shutdown", async () => { for (const unsubscribe of unsubscribes.splice(0)) unsubscribe(); });
}

export default function agentManageExtension(pi: ExtensionAPI): void {
  registerAgentManageTool(pi, () => ({ clients: windowContext().clients }));
  registerExploreDelivery(pi, async () => {
    const window = await windowReady();
    return { clients: window.clients, repoIds: window.workspace.repos.map((repo) => repo.repoId) };
  });
}
