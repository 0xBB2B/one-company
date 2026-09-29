import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { dataRoot } from "../runtime/identity.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../runtime/daemon-client.ts";
import { createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import { createUserInteractTool } from "../runtime/user-interact-tool.ts";
import { MainIntakeInteraction } from "../runtime/main-intake-interaction.ts";
import type { MainIntakeProviders } from "../runtime/main-intake-interaction.ts";
import { createPmIntakeProviders } from "../runtime/pm-intake-runtime.ts";
import { MainRequirementInteraction } from "../runtime/main-requirement-interaction.ts";
import type { OpenRequirementService, RequirementManageHostContext } from "../runtime/main-requirement-interaction.ts";
import { registerInputRevoker, registerWindowShutdownHook, windowContext, windowReady } from "./lifecycle.ts";

export interface RequirementManageExtensionDeps {
  readonly authorization?: HostAuthorizationManager;
  readonly dataRoot?: string;
  readonly openService?: OpenRequirementService;
  /** 隔离测试注入；缺省使用读取批准清单与 PM 私有会话的真实提供方。 */
  readonly pmIntakeProviders?: MainIntakeProviders;
  /** 仅隔离测试或可信宿主用于缩短在途调用期限。 */
  readonly pmIntakeCallTtlMs?: number;
  readonly windowReady?: typeof windowReady;
  readonly windowContext?: typeof windowContext;
}
// 错误只放行固定格式的错误代码与只含字段名的改正提示，其余内容一律不回显，避免把值或正文带回模型
const SAFE_DENIAL = /^(?:requirement_host_denied:|pm_intake_interaction_denied:|PM 接手(?:服务被拒绝|契约拒绝|存储被拒绝)：)([a-z_]{1,64})(（[\p{Script=Han}A-Za-z0-9_:：、；，. -]{0,2000}）)?$/u;
export function deniedText(event: { isError: boolean; content: ReadonlyArray<{ type: string; text?: string }> },
  prefix: "requirement_interaction_denied" | "pm_intake_interaction_denied"): string {
  const text = event.isError && event.content.length === 1 && event.content[0]!.type === "text" ? event.content[0]!.text ?? "" : "";
  const match = SAFE_DENIAL.exec(text);
  return match ? `${prefix}:${match[1]}${match[2] ?? ""}` : prefix;
}
export default function requirementManageExtension(pi: ExtensionAPI, deps: RequirementManageExtensionDeps = {}): void {
  const root = deps.dataRoot ?? dataRoot(process.env);
  const authorization = deps.authorization ?? new HostAuthorizationManager({ dataRoot: root });
  const awaitWindow = deps.windowReady ?? windowReady, currentWindow = deps.windowContext ?? windowContext;
  const resolveHost = (ctx: ExtensionContext): RequirementManageHostContext => {
    const window = currentWindow();
    if (window.sessionId !== ctx.sessionManager.getSessionId() || window.heartbeatError ||
      window.workspace.repos.some((repo) => window.clients.forRepo(repo.repoId)?.state().status !== "connected")) throw new Error("requirement_host_unavailable");
    return { windowId: window.windowId, sessionId: window.sessionId,
      repositories: new Map(window.workspace.repos.map((repo) => [repo.repoId, { path: repo.path }])) };
  };
  const interaction = new MainRequirementInteraction({ dataRoot: root,
    authorization, resolveHost, ...(deps.openService ? { openService: deps.openService } : {}) });
  const intake = new MainIntakeInteraction({ dataRoot: root, authorization, resolveHost,
    providers: deps.pmIntakeProviders ?? createPmIntakeProviders(root),
    ...(deps.pmIntakeCallTtlMs !== undefined ? { callTtlMs: deps.pmIntakeCallTtlMs } : {}) });
  let unregisterShutdown: (() => void) | undefined;
  const connections: Array<() => void> = [];
  const shutdown = () => { for (const stop of connections.splice(0)) stop(); intake.shutdown(); interaction.shutdown(); authorization.shutdown(); };
  pi.registerFlag("requirement-rpc-input", { type: "boolean", default: false,
    description: "允许当前已接入RPC客户端的真实input用于需求决定；不接受扩展转述" });
  pi.on("session_start", async (_event, ctx) => {
    interaction.shutdown();
    intake.shutdown();
    const window = await awaitWindow(), sessionId = ctx.sessionManager.getSessionId();
    if (window.sessionId !== sessionId) throw new Error("requirement_host_unavailable");
    authorization.startWindow({ kind: "main", windowId: window.windowId, sessionId, repoIds: window.workspace.repos.map((repo) => repo.repoId) });
    unregisterShutdown?.();
    for (const stop of connections.splice(0)) stop();
    for (const repo of window.workspace.repos) {
      const client = window.clients.forRepo(repo.repoId);
      if (!client || client.state().status !== "connected") { shutdown(); throw new Error("requirement_host_unavailable"); }
      connections.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => authorization.revoke()));
    }
    unregisterShutdown = registerWindowShutdownHook(window, shutdown);
    registerInputRevoker(() => interaction.revokeInput());
    intake.startSession(ctx);
  });
  pi.on("input", (event, ctx) => {
    interaction.captureInput(event, ctx, ctx.mode === "rpc" && pi.getFlag("requirement-rpc-input") === true);
    return { action: "continue" };
  });
  pi.on("session_before_switch", () => { authorization.revoke(); });
  pi.on("session_before_fork", () => { authorization.revoke(); });
  pi.on("session_before_tree", () => { authorization.revoke(); });
  pi.on("session_before_compact", (_event, ctx) => { intake.clearForCompaction(ctx); });
  pi.on("model_select", () => { authorization.revoke(); });
  pi.on("session_shutdown", () => { unregisterShutdown?.(); unregisterShutdown = undefined; shutdown(); });
  pi.registerCommand("one:requirement-revoke", { description: "撤销当前窗口的需求输入与在途能力", handler: async () => { authorization.revoke(); } });
  pi.registerCommand("one:requirement-select", {
    description: "通过真实交互选择已有需求身份，不恢复旧输入、授权或执行",
    handler: async (args, ctx) => {
      if (args.trim()) { ctx.ui.notify("请从当前需求列表选择；命令参数不能直接绑定需求。", "warning"); return; }
      try {
        await ctx.waitForIdle();
        const result = await interaction.selectRequirement(ctx, ctx.mode === "rpc" && pi.getFlag("requirement-rpc-input") === true);
        ctx.ui.notify(result.selected ? `已绑定需求 ${result.requirementId}；未恢复旧输入、批准能力、PM或任务。`
          : `未绑定新需求；已取消选择或没有可选择的已核验需求。未初始化仓库数：${result.unavailableRepositories}`, "info");
      } catch { ctx.ui.notify("需求身份绑定未完成：缺少可信交互、列表超限，或会话/需求/工作区状态已变化。", "warning"); }
    },
  });
  pi.on("tool_call", (event, ctx) => { intake.observeToolCall(event, ctx); });
  pi.on("tool_execution_end", (event) => { intake.completeToolExecution(event); });
  pi.on("tool_result", (event, ctx) => {
    if (!["one_company_requirement_manage", "one_company_user_interact"].includes(event.toolName)) return;
    if (intake.ownsDelivery(event.toolCallId)) {
      try { intake.assertDelivery(event, ctx); }
      catch { return { content: [{ type: "text", text: deniedText(event, "pm_intake_interaction_denied") }], details: {}, isError: true }; }
      return;
    }
    try { if (event.isError) throw new Error("denied"); interaction.assertDelivery(event.toolCallId, ctx); }
    catch { return { content: [{ type: "text", text: deniedText(event, "requirement_interaction_denied") }], details: {}, isError: true }; }
  });
  pi.registerTool(createRequirementManageTool({ interaction }));
  pi.registerTool(createUserInteractTool({ interaction, intake }));
}
