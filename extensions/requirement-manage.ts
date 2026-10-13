import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostAuthorizationError, HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { dataRoot } from "../runtime/identity.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../runtime/daemon-client.ts";
import { createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import { createUserInteractTool } from "../runtime/user-interact-tool.ts";
import { MainIntakeInteraction } from "../runtime/main-intake-interaction.ts";
import type { MainIntakeProviders } from "../runtime/main-intake-interaction.ts";
import type { MentionTarget } from "../runtime/main-requirement-interaction.ts";
import { requirementMentionProvider } from "../runtime/mention-completion.ts";
import type { MentionCandidate } from "../runtime/mention-completion.ts";
import { basename } from "node:path";
import { createPmIntakeProviders } from "../runtime/pm-intake-runtime.ts";
import { MainRequirementInteraction } from "../runtime/main-requirement-interaction.ts";
import type { OpenRequirementService, RequirementManageHostContext } from "../runtime/main-requirement-interaction.ts";
import { failureText, toolStep } from "../runtime/tool-failure.ts";
import { registerRequirementInput, registerWindowShutdownHook, windowContext, windowReady } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

export interface RequirementManageExtensionDeps {
  readonly authorization?: HostAuthorizationManager;
  readonly dataRoot?: string;
  readonly openService?: OpenRequirementService;
  /** 隔离测试注入；缺省使用读取批准清单与 PM 私有会话的真实提供方。 */
  readonly pmIntakeProviders?: MainIntakeProviders;
  readonly windowReady?: typeof windowReady;
  readonly windowContext?: typeof windowContext;
}
/** 这句话 @ 到的需求，写进本轮系统提示；编号由程序按用户原话解析，不是模型填写。 */
export function mentionNote(targets: readonly MentionTarget[], repos: ReadonlyArray<{ repoId: string; path: string }>): string {
  if (!targets.length) return "";
  return ["## 这句话 @ 到的需求", "用户在这句话里用 @ 指明了下列需求；这句话里的批准只对这些需求有效：",
    ...targets.map((target) => `- ${target.title}（仓库 ${repos.find((repo) => repo.repoId === target.repoId)?.path ?? target.repoId}，repoId ${target.repoId}，requirementId ${target.requirementId}）`)].join("\n");
}
let mention: { multiRepo: boolean; candidates(): Promise<MentionCandidate[]> } | undefined;
const mentionUis = new WeakSet<object>();
export default function requirementManageExtension(pi: ExtensionAPI, deps: RequirementManageExtensionDeps = {}): void {
  const root = deps.dataRoot ?? dataRoot(process.env);
  const authorization = deps.authorization ?? new HostAuthorizationManager({ dataRoot: root });
  const awaitWindow = deps.windowReady ?? windowReady, currentWindow = deps.windowContext ?? windowContext;
  const hostOf = (window: Pick<WindowContextValue, "windowId" | "sessionId" | "workspace">): RequirementManageHostContext => ({ windowId: window.windowId, sessionId: window.sessionId,
    repositories: new Map(window.workspace.repos.map((repo) => [repo.repoId, { path: repo.path }])) });
  const resolveHost = (ctx: ExtensionContext): RequirementManageHostContext => {
    const window = currentWindow();
    if (window.sessionId !== ctx.sessionManager.getSessionId() ||
      window.workspace.repos.some((repo) => window.clients.forRepo(repo.repoId)?.state().status !== "connected")) throw new HostAuthorizationError("host_unavailable");
    return hostOf(window);
  };
  const interaction = new MainRequirementInteraction({ dataRoot: root,
    authorization, resolveHost, ...(deps.openService ? { openService: deps.openService } : {}) });
  const intake = new MainIntakeInteraction({ dataRoot: root, authorization, resolveHost,
    providers: deps.pmIntakeProviders ?? createPmIntakeProviders(root) });
  let unregisterShutdown: (() => void) | undefined;
  const connections: Array<() => void> = [];
  const shutdown = () => { mention = undefined; for (const stop of connections.splice(0)) stop(); intake.shutdown(); interaction.shutdown(); authorization.shutdown(); };
  pi.on("session_start", async (_event, ctx) => {
    interaction.shutdown();
    intake.shutdown();
    const window = await awaitWindow(), sessionId = ctx.sessionManager.getSessionId();
    if (window.sessionId !== sessionId) throw new HostAuthorizationError("host_unavailable");
    if (window.workspace.repos.length === 0) return;
    authorization.startWindow({ kind: "main", windowId: window.windowId, sessionId, repoIds: window.workspace.repos.map((repo) => repo.repoId) });
    unregisterShutdown?.();
    for (const stop of connections.splice(0)) stop();
    for (const repo of window.workspace.repos) {
      const client = window.clients.forRepo(repo.repoId);
      // 首连失败时客户端在后台重连；连没连上交给每次调用的 resolveHost 判断，这里撤销登记会让本会话永远用不了需求工具
      if (!client) { shutdown(); throw new HostAuthorizationError("host_unavailable"); }
      connections.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, () => authorization.revoke()));
    }
    unregisterShutdown = registerWindowShutdownHook(window, shutdown);
    registerRequirementInput({ revoke: () => interaction.revokeInput(), noteOpenedItem: (item) => interaction.noteOpenedItem(item),
      mentionNote: () => mentionNote(interaction.inputTargets(), window.workspace.repos) });
    mention = { multiRepo: window.workspace.repos.length > 1, candidates: async () => {
      const running = new Set<string>();
      for (const repo of window.workspace.repos) {
        const result = await window.clients.forRepo(repo.repoId)?.call("pm.overview", {}).catch(() => undefined);
        for (const item of (result?.items ?? []) as Array<{ requirementId: string; status: string }>) if (item.status === "running") running.add(item.requirementId);
      }
      return (await interaction.mentionCandidates(ctx)).map((item) => ({ requirementId: item.requirementId, title: item.title, lifecycle: item.lifecycle,
        pmRunning: running.has(item.requirementId), repoName: basename(window.workspace.repos.find((repo) => repo.repoId === item.repoId)?.path ?? "") }));
    } };
    if (ctx.mode === "tui" && ctx.hasUI && !mentionUis.has(ctx.ui)) {
      mentionUis.add(ctx.ui);
      ctx.ui.addAutocompleteProvider((current) => requirementMentionProvider(current,
        () => (mention?.candidates() ?? Promise.resolve([])).catch(() => []), () => mention?.multiRepo ?? false));
    }
    intake.startSession(ctx, hostOf(window));
  });
  pi.on("input", (event, ctx) => {
    const { invalid } = interaction.captureInput(event, ctx);
    if (invalid.length) {
      const valid = interaction.inputTargets().length;
      ctx.ui.notify(`有 ${invalid.length} 个 @ 无效：${invalid.map((item) => `${item.token}（${item.reason}）`).join("、")}。` +
        (valid ? `这句话只附上另外 ${valid} 个需求。` : "这句话没有附上任何需求。"), "warning");
    }
    return { action: "continue" };
  });
  pi.on("session_before_switch", () => { authorization.revoke(); });
  pi.on("session_before_fork", () => { authorization.revoke(); });
  pi.on("session_before_tree", () => { authorization.revoke(); });
  pi.on("session_before_compact", (_event, ctx) => { intake.clearForCompaction(ctx); });
  pi.on("model_select", () => { authorization.revoke(); });
  pi.on("session_shutdown", () => { unregisterShutdown?.(); unregisterShutdown = undefined; shutdown(); });
  pi.on("tool_call", (event, ctx) => { intake.observeToolCall(event, ctx); });
  pi.on("tool_execution_end", (event) => { intake.completeToolExecution(event); });
  pi.on("tool_result", (event, ctx) => {
    if (!["one_company_requirement_manage", "one_company_user_interact"].includes(event.toolName)) return;
    // 出错结果已由工具写成三段原因，原样交给模型；成功结果送达前再核对一次仍是当前结果
    if (event.isError) return;
    try {
      if (intake.ownsDelivery(event.toolCallId)) intake.assertDelivery(event, ctx);
      else interaction.assertDelivery(event.toolCallId, ctx);
    } catch (error) {
      return { content: [{ type: "text", text: failureText(`${toolStep(event.toolName, event.input)}的结果送达前核对`, error) }], details: {}, isError: true };
    }
  });
  pi.registerTool(createRequirementManageTool({ interaction }));
  pi.registerTool(createUserInteractTool({ interaction, intake }));
}
