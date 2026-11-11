import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostAuthorizationError, HostAuthorizationManager } from "../requirement/host-authorization.ts";
import { dataRoot } from "../../core/storage/identity.ts";
import { DAEMON_CLIENT_LIFECYCLE_EVENTS, launchedDaemonLogPath } from "../../core/host/daemon-client.ts";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import { currentLine, currentLineRepos, latestSaveAnchorIn, lineSwitchFactsIn, recordLineAnchor } from "../requirement/line-anchors.ts";
import { RequirementService } from "../requirement/requirement-service.ts";
import { lineSwitchKind, lineSwitchReport, restoreMessageText, windowLineMemory } from "./line-switch.ts";
import type { LineSwitchItem } from "./line-switch.ts";
import { createRequirementManageTool } from "./requirement-manage-tool.ts";
import { createUserInteractTool } from "./user-interact-tool.ts";
import { MainIntakeInteraction } from "./main-intake-interaction.ts";
import type { MainIntakeProviders } from "./main-intake-interaction.ts";
import type { MentionTarget } from "./main-requirement-interaction.ts";
import { requirementMentionProvider } from "./mention-completion.ts";
import type { MentionCandidate } from "./mention-completion.ts";
import { basename } from "node:path";
import { createPmIntakeProviders } from "../pm/pm-intake-runtime.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import type { OpenRequirementService, RequirementManageHostContext } from "./main-requirement-interaction.ts";
import { failureText, toolStep } from "../../core/exec/tool-failure.ts";
import { registerRequirementInput, registerWindowShutdownHook, windowContext, windowReady } from "../../core/host/extension-lifecycle.ts";
import type { WindowContextValue } from "../../core/host/extension-lifecycle.ts";

export interface RequirementManageExtensionDeps {
  readonly authorization?: HostAuthorizationManager;
  readonly dataRoot?: string;
  readonly openService?: OpenRequirementService;
  /** 隔离测试注入；缺省使用读取批准清单与 PM 私有会话的真实提供方。 */
  readonly pmIntakeProviders?: MainIntakeProviders;
  readonly windowReady?: typeof windowReady;
  readonly windowContext?: typeof windowContext;
  readonly daemonLogPath?: (repoId: string) => string | undefined;
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
  const interaction = new MainRequirementInteraction({ dataRoot: root, mainThinking: () => pi.getThinkingLevel(),
    authorization, resolveHost, pi, ...(deps.openService ? { openService: deps.openService } : {}) });
  const intake = new MainIntakeInteraction({ dataRoot: root, authorization, resolveHost,
    providers: deps.pmIntakeProviders ?? createPmIntakeProviders(root) });
  const logPathOf = deps.daemonLogPath ?? launchedDaemonLogPath;
  const lineMemory = windowLineMemory();
  const reportLineSwitch = async (ctx: ExtensionContext, window: Pick<WindowContextValue, "workspace">, before: "window" | "latestSave"): Promise<void> => {
    const line = currentLine(ctx.sessionManager), repoOf = currentLineRepos(ctx.sessionManager);
    const items: LineSwitchItem[] = [];
    for (const repository of window.workspace.repos) {
      const repoId = repository.repoId;
      const repoLine = Object.fromEntries(Object.entries(line).filter(([requirementId]) => repoOf[requirementId] === repoId));
      if (!Object.keys(repoLine).length) continue;
      const service = await RequirementService.open({ repositoryRoot: repository.path, dataRoot: root, repoId, lines: repoLine,
        authorize: (request) => request.repoId === repoId && ["metadata", "readSaved", "readApproved"].includes(request.action)
          && (request.requirementId === undefined || request.requirementId in repoLine) }).catch(() => undefined);
      for (const [requirementId, anchors] of Object.entries(repoLine)) {
        const lineTip = anchors.at(-1)!;
        try {
          if (!service) throw new Error("需求服务打不开");
          const metadata = await service.metadata(requirementId);
          const { facts, previous } = withDatabase(repositoryDatabase(root, repoId), (db) => ({ facts: lineSwitchFactsIn(db, requirementId, anchors),
            previous: before === "window" ? lineMemory.tipOf(requirementId) : latestSaveAnchorIn(db, requirementId)?.anchor ?? null }));
          if (metadata.restoreFailure && metadata.lineAnchor !== undefined && metadata.lineAnchor !== lineTip) recordLineAnchor(pi, { repoId, requirementId, anchor: metadata.lineAnchor });
          const failure = metadata.restoreFailure ? { reason: metadata.restoreFailure, conversationVersion: facts.tipVersion, logPath: logPathOf(repoId) } : undefined;
          const item: LineSwitchItem = { requirementId, title: "", lifecycle: metadata.lifecycle, before: previous,
            tip: before === "latestSave" ? facts.tipSave ?? lineTip : lineTip, tipVersion: facts.tipVersion, currentVersion: metadata.version,
            afterApproval: facts.afterApproval, lastSaved: facts.lastSaved, ...(failure ? { failure } : {}) };
          if (lineSwitchKind(item)) item.title = metadata.lifecycle === "draft" ? (await service.read({ requirementId, source: "saved" })).title : await service.approvedTitle(requirementId);
          items.push(item);
        } catch {
          const title = await service?.read({ requirementId, source: "saved" }).then((read) => read.title, () => requirementId) ?? requirementId;
          items.push({ requirementId, title, lifecycle: "draft", before: null, tip: lineTip, tipVersion: null, currentVersion: null, afterApproval: false, lastSaved: null,
            failure: { reason: "读取这个需求的记录时出错了", conversationVersion: null, logPath: logPathOf(repoId) } });
        }
      }
    }
    lineMemory.remember(line);
    const text = restoreMessageText(lineSwitchReport(items));
    if (text) pi.sendMessage({ customType: "one-company.requirement-restore", content: text, display: true }, { triggerTurn: false });
  };
  let unregisterShutdown: (() => void) | undefined;
  const connections: Array<() => void> = [];
  const shutdown = () => { mention = undefined; for (const stop of connections.splice(0)) stop(); intake.shutdown(); interaction.shutdown(); authorization.shutdown(); };
  pi.on("session_start", async (event, ctx) => {
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
    if (["startup", "resume", "fork"].includes(event.reason)) await reportLineSwitch(ctx, window, "latestSave");
  });
  pi.on("session_tree", async (_event, ctx) => {
    let window: WindowContextValue;
    try { window = currentWindow(); } catch { return; }
    await reportLineSwitch(ctx, window, "window");
  });
  pi.on("input", (event, ctx) => {
    if (currentWindow().workspace.repos.length === 0) return { action: "continue" };
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
  pi.on("session_before_tree", (_event, ctx) => { lineMemory.remember(currentLine(ctx.sessionManager)); authorization.revoke(); });
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
