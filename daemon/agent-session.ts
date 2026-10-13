import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ModelRuntime, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Clock, TimerHandle } from "../runtime/clock.ts";
import { describeMcpStatus, mcpExtensionFactories, registerMcpServers } from "../runtime/mcp.ts";
import { classifyFailure } from "../runtime/network-pause.ts";
import { loadPackageRules } from "../runtime/package-rules.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import { QA_PROTOTYPE_HOST_TOOLS, ROLE_HOST_TOOLS } from "../runtime/role-tools.ts";
import { checkSearchCall, filterSearchResult } from "../runtime/search-exclusion.ts";
import type { RoleDefinition } from "../runtime/roles.ts";
import { isAgentRole } from "../runtime/roles.ts";
import { createSessionManagerForRun } from "../runtime/session-records.ts";

export interface CreateAgentSessionOptions {
  dataRoot: string;
  repoId: string;
  runId: string;
  cwd: string;
  definition: RoleDefinition;
  /** 程序按当前授权数据组装的任务上下文；不含父会话历史。 */
  context: string;
  coreTools: ToolDefinition[];
  /** 宿主只读工具限定的根（explore 限在派出方工作区）；缺省不限读取范围。 */
  readRoots?: string[];
  /** 覆盖职责默认的宿主工具（如按检索来源只给 explore 部分工具）；不能超出职责默认集合。 */
  hostTools?: string[];
  runtime: ModelRuntime;
  modelRef: { provider: string; id: string };
  thinking?: string;
  /** 受限子代理的对话轮次上限；主代理与 PM 不设。一轮即一次模型生成请求。 */
  maxTurns?: number;
  /** on-result：结果工具成功提交后本轮结束即完成；idle-only：只交回控制权（PM）。 */
  completion: { kind: "on-result"; resultTool: string } | { kind: "idle-only" };
  clock: Clock;
  networkGate: NetworkPauseGate;
}

export type AgentSessionState = "running" | "paused" | "completed" | "failed" | "stopped" | "turn_limit_reached" | "ended_without_result";

export interface AgentSessionHandle {
  events: EventEmitter;
  state(): AgentSessionState;
  turnsUsed(): number;
  /** 没有进行中的模型回合、排队消息或执行中的工具。 */
  idle(): boolean;
  prompt(text: string): void;
  result(): Promise<void>;
  pause(): Promise<{ confirmed: boolean; reason?: string }>;
  resume(): Promise<void>;
  stop(): Promise<{ stopped: boolean }>;
  dispose(): void;
}

const READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
// SDK 读取前会去掉前导 @、展开 ~、解析 file:// 并替换特殊空白；这些写法的真实目标与按字面解析的不同，一律拒绝
const REWRITTEN_PATH = /^[@~]|^file:|[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/iu;
const PAUSE_ABORT_TIMEOUT_MS = 15_000;

// 候选路径可能尚未创建；沿父目录逐级 realpath，找到已存在的祖先后再拼回后续片段
export async function bestEffortRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await bestEffortRealpath(parent), path.slice(parent.length + 1));
  }
}

export async function withinRoots(cwd: string, candidate: string, roots: string[]): Promise<boolean> {
  const resolved = await bestEffortRealpath(resolvePath(cwd, candidate));
  for (const root of roots) {
    const resolvedRoot = await bestEffortRealpath(resolvePath(cwd, root));
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

export function buildAgentPrompt(definition: RoleDefinition, context: string, mcpStatus: string): string {
  return [definition.body.trim(), "", loadPackageRules("shared"), "", `## 本次任务\n${context}`, "", `## MCP 状态\n${mcpStatus}`].join("\n");
}

export async function checkAgentToolCall(event: ToolCallEvent, ctx: {
  cwd: string; readRoots?: string[]; paused: () => boolean; submitted: () => boolean;
}): Promise<ToolCallEventResult | void> {
  if (ctx.paused()) return { block: true, reason: "会话已暂停，拒绝新操作" };
  if (ctx.submitted()) return { block: true, reason: "结果已提交，会话即将结束", terminate: true };
  if (READ_TOOL_NAMES.has(event.toolName)) {
    const input = event.input as Record<string, unknown> | null;
    // grep/find/ls 允许省略 path，此时按会话 cwd 判定，不能因省略而绕过范围
    const path = input && typeof input.path === "string" ? input.path : ctx.cwd;
    if (REWRITTEN_PATH.test(path)) return { block: true, reason: `不支持的路径写法: ${path}` };
    if (ctx.readRoots && !(await withinRoots(ctx.cwd, path, ctx.readRoots))) return { block: true, reason: `读取路径超出范围: ${path}` };
    return checkSearchCall(event, ctx.cwd);
  }
}

export async function createAgentRoleSession(options: CreateAgentSessionOptions): Promise<AgentSessionHandle> {
  const { definition } = options;
  const agentDir = dirname(options.dataRoot);
  const usesMcp = (definition.mcp?.length ?? 0) > 0;
  const model = options.runtime.getModels(options.modelRef.provider).find((entry) => entry.id === options.modelRef.id);
  if (!model) throw new Error(`未找到模型: ${options.modelRef.provider}/${options.modelRef.id}`);

  const events = new EventEmitter();
  const activeTools = new Set<string>();
  let currentState: AgentSessionState = "running";
  let submitted = false;
  let queuedMessages: string[] = [];
  let session!: AgentSession;
  let disposed = false;
  let prompting = false;
  let pendingNetworkAbort: Promise<void> | undefined;
  let failedMessage: { errorMessage?: string } | null = null;
  let resolveResult!: () => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<void>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  resultPromise.catch(() => {});

  const isTerminal = () => ["completed", "failed", "stopped", "turn_limit_reached", "ended_without_result"].includes(currentState);
  let turns = 0;
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error("maxTurns 必须为正整数");
  const isPaused = () => currentState === "paused";

  function finishFailed(cause: unknown): void {
    if (isTerminal()) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    currentState = "failed";
    events.emit("failed", { reason: error.message });
    rejectResult(error);
  }
  function finishCompleted(): void {
    if (isTerminal()) return;
    currentState = "completed";
    events.emit("completed");
    resolveResult();
  }
  function reachTurnLimit(): void {
    if (isTerminal()) return;
    currentState = "turn_limit_reached";
    events.emit("turn_limit_reached", { turns, maxTurns: options.maxTurns });
    rejectResult(new Error("turn_limit_reached"));
    void session.abort().catch(() => {});
  }
  function endWithoutResult(): void {
    if (isTerminal()) return;
    currentState = "ended_without_result";
    events.emit("ended_without_result", { turns });
    rejectResult(new Error("ended_without_result"));
  }
  function onPersistError(error: Error): void {
    finishFailed(new Error(`会话保存失败: ${error.message}`));
    void session?.abort().catch(() => {});
  }

  const sessionManager = createSessionManagerForRun({ dataRoot: options.dataRoot, repoId: options.repoId, runId: options.runId, cwd: options.cwd, onPersistError });

  const extensionFactory = async (pi: ExtensionAPI): Promise<void> => {
    const mcpResult = registerMcpServers(pi, join(agentDir, "mcp.json"), definition.mcp ?? []);
    const prompt = buildAgentPrompt(definition, options.context, describeMcpStatus(mcpResult));
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${prompt}` }));
    // 模型调用前计数：已用满 N 轮时在第 N+1 次请求发出前中止，不靠提示词或模型自报
    pi.on("turn_start", () => {
      if (submitted) {
        finishCompleted();
        void session.abort().catch(() => {});
        return;
      }
      if (options.maxTurns !== undefined && turns >= options.maxTurns) {
        reachTurnLimit();
        return;
      }
      turns++;
      events.emit("turn_counted", { turns });
    });
    pi.on("tool_call", (event) => checkAgentToolCall(event, {
      cwd: options.cwd, readRoots: options.readRoots,
      paused: () => isPaused() || isTerminal(), submitted: () => submitted,
    }));
    pi.on("tool_result", (event) => filterSearchResult(event));
    pi.on("tool_execution_start", (event) => {
      activeTools.add(event.toolCallId);
    });
    pi.on("tool_execution_end", (event) => {
      activeTools.delete(event.toolCallId);
      if (options.completion.kind === "on-result" && event.toolName === options.completion.resultTool && !event.isError) submitted = true;
      events.emit("tool_end", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
    });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir, noSkills: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [...(usesMcp ? mcpExtensionFactories() : []), extensionFactory],
  });
  await resourceLoader.reload();

  const role = definition.role;
  if (!isAgentRole(role)) throw new Error(`内部定义 ${role} 不能开代理会话`);
  const hostTools = options.hostTools ?? ROLE_HOST_TOOLS[role];
  const hostToolLimit = role === "qa" && options.readRoots?.length ? QA_PROTOTYPE_HOST_TOOLS : ROLE_HOST_TOOLS[role];
  if (hostTools.some((tool) => !hostToolLimit.includes(tool))) throw new Error("宿主工具超出职责默认集合");
  const toolNames = [...hostTools, ...options.coreTools.map((tool) => tool.name), ...(usesMcp ? ["codemode", "tool_search", "mcp__*"] : [])];
  const sdkSettings = SettingsManager.create(options.cwd, agentDir, { projectTrusted: false });
  // 服务商断流等瞬时错误交 SDK 有限次重试；SDK 不重试被中止的请求，网络暂停发起的中止不会被重发
  const settingsManager = SettingsManager.inMemory({ ...sdkSettings.getGlobalSettings(),
    retry: { ...sdkSettings.getRetrySettings(), enabled: true, maxRetries: 3, baseDelayMs: 2_000 } });
  const created = await createAgentSession({
    settingsManager,
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.runtime,
    model,
    thinkingLevel: options.thinking as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"],
    resourceLoader,
    sessionManager,
    tools: toolNames,
    customTools: options.coreTools as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"]>,
  });
  session = created.session;
  // MCP 扩展在 session_start 时才连接服务
  if (usesMcp) await session.bindExtensions({});

  function requestNetworkPause(): void {
    currentState = "paused";
    options.networkGate.requestPause(options.runId);
    events.emit("network_paused");
    pendingNetworkAbort = session.abort().catch(() => {});
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") events.emit("turn");
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") events.emit("transcript_message", event);
    if (event.type === "agent_end") {
      if (currentState !== "running") return;
      const failed = failedMessage;
      failedMessage = null;
      // 服务商断流等瞬时错误由 SDK 在回合结束后重试；只有它不再重试时才按失败处理
      if (failed) {
        if (event.willRetry) return;
        // cancelled 是本模块发起的中止（暂停、停止、网络空闲）造成的正常收尾，状态已在发起处流转
        if (classifyFailure(new Error(failed.errorMessage ?? "模型请求失败")) !== "cancelled") finishFailed(failed.errorMessage ?? "模型请求失败");
        return;
      }
      if (submitted) finishCompleted();
      else if (options.maxTurns !== undefined && turns >= options.maxTurns) reachTurnLimit();
      // 子代理没提交结果就停下时不会再有人唤醒它，按本次尝试结束交父代理处理
      else if (options.completion.kind === "on-result") endWithoutResult();
      else events.emit("idle", { submitted: false });
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const usage = event.message.usage;
    if (usage) events.emit("usage", { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
    failedMessage = null;
    if (event.message.stopReason !== "error" || currentState !== "running") return;
    // 断网按暂停处理，等用户恢复后原地续接；中止后的请求 SDK 不会重试
    if (classifyFailure(new Error(event.message.errorMessage ?? "模型请求失败")) === "connection") requestNetworkPause();
    else failedMessage = event.message;
  });

  function drainPrompts(): void {
    if (prompting || isTerminal() || isPaused() || !options.networkGate.canProceed(options.runId)) return;
    const text = queuedMessages.shift();
    if (text === undefined) return;
    prompting = true;
    void session.prompt(text).catch(finishFailed).finally(() => {
      prompting = false;
      drainPrompts();
    });
  }

  function prompt(text: string): void {
    if (isTerminal()) return;
    queuedMessages.push(text);
    drainPrompts();
  }

  async function abortWithin(): Promise<boolean> {
    let confirmed = false;
    let timer: TimerHandle | null = null;
    const abort = session.abort().then(() => { confirmed = true; }).catch(() => {});
    await Promise.race([abort, new Promise<void>((resolve) => { timer = options.clock.setTimeoutExcludingSleep(() => resolve(), PAUSE_ABORT_TIMEOUT_MS); })]);
    if (timer) options.clock.clearTimer(timer);
    return confirmed;
  }

  async function pause(): Promise<{ confirmed: boolean; reason?: string }> {
    if (isTerminal()) return { confirmed: true };
    currentState = "paused";
    const drained = session.clearQueue();
    queuedMessages.push(...drained.steering, ...drained.followUp);
    const aborted = await abortWithin();
    const confirmed = aborted && activeTools.size === 0;
    if (confirmed) return { confirmed };
    const reasons: string[] = [];
    if (!aborted) reasons.push("abort 未在超时内确认");
    if (activeTools.size > 0) reasons.push("工具未确认全部停止");
    return { confirmed, reason: reasons.join("；") };
  }

  async function resume(): Promise<void> {
    if (isTerminal()) return;
    // 先等旧的 abort 落定再放行网络门，避免新请求早于旧请求收尾
    if (pendingNetworkAbort) { await pendingNetworkAbort; pendingNetworkAbort = undefined; }
    options.networkGate.resume(options.runId);
    currentState = "running";
    const queued = queuedMessages.splice(0);
    prompt(["已恢复运行，请先用可用工具核对当前状态再继续。", queued.length > 0 ? `排队消息：\n${queued.join("\n")}` : ""].filter(Boolean).join("\n\n"));
  }

  async function stop(): Promise<{ stopped: boolean }> {
    if (isTerminal()) return { stopped: activeTools.size === 0 && !prompting };
    // 先切到 stopped 再 abort：abort 引发的 aborted 消息不能被当作业务失败
    currentState = "stopped";
    rejectResult(new Error("会话已被停止"));
    await abortWithin();
    return { stopped: activeTools.size === 0 && !prompting };
  }

  function dispose(): void {
    if (currentState === "paused") throw new Error("暂停态禁止释放会话");
    if (disposed) return;
    disposed = true;
    unsubscribe();
    // pi 的 dispose 不发 session_shutdown，不先发它 MCP 服务进程会一直留在后台
    if (usesMcp) void session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {}).finally(() => session.dispose());
    else session.dispose();
  }

  return { events, state: () => currentState, turnsUsed: () => turns, idle: () => !prompting && queuedMessages.length === 0 && activeTools.size === 0, prompt, result: () => resultPromise, pause, resume, stop, dispose };
}
