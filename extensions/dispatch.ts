import { basename, isAbsolute } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { DaemonClient, WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { collectGitSnapshot } from "../runtime/git-snapshot.ts";
import { dataRoot, repositoryIdentity } from "../runtime/identity.ts";
import type { Workspace } from "../runtime/identity.ts";
import type { RunState } from "../runtime/run-store.ts";
import { readRequirementState } from "../runtime/workflow-state.ts";
import { windowContext } from "./lifecycle.ts";

export const DISPATCH_PARAMETERS = Type.Object({
  requirement: Type.String({ description: "需求目录名 <YYYY-MM-DD>.<slug>" }),
  cwd: Type.String({ description: "需求所属仓库的工作目录绝对路径" }),
}, { additionalProperties: false });

export const REPLY_PARAMETERS = Type.Object({
  questionId: Type.String(),
  answer: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const FORWARD_PARAMETERS = Type.Object({
  requirement: Type.String(),
  cwd: Type.String(),
  message: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const AGENTS_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("list"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("resume"),
    Type.Literal("stop"), Type.Literal("pauseAll"), Type.Literal("resumeAll"), Type.Literal("stopAll"),
    Type.Literal("resumeInterrupted"),
  ]),
  runId: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const REVIEW_PARAMETERS = Type.Object({
  requirement: Type.String(),
  cwd: Type.String(),
  baseline: Type.String(),
}, { additionalProperties: false });

export interface DispatchContext {
  clients: WorkspaceClientsHandle;
  windowId: string;
  workspace: Workspace;
  gitTimeoutMs?: number;
  gitMaxBuffer?: number;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function okResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: { isError: false } };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: { isError: true } };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function daemonErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function daemonErrorData(error: unknown): Record<string, unknown> | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
}

// 不可达原因可能带完整 socket 路径与守护进程日志尾（daemon-client.ts 的连接失败文案），
// 直接透出会把本机绝对路径与大段日志灌进聊天区；只留第一行、抹掉路径段、限长。
// 路径判定收窄到"至少两级 ASCII 路径段"，且前一字符不能是 `:`、`/` 或字母数字——
// 排除 URL（"https://" 的双斜杠、"example.com/v1" 的字母数字前缀）与业务文案里的
// "T-1/T-2"、"读/写"这类非路径斜杠
const REASON_MAX_LENGTH = 200;
const ABSOLUTE_PATH_PATTERN = /(?<![:\w/])\/(?:[A-Za-z0-9._~@+-]+\/)+[A-Za-z0-9._~@+-]*/g;

function briefReason(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? raw;
  const withoutPaths = firstLine.replace(ABSOLUTE_PATH_PATTERN, "[path]");
  return withoutPaths.length > REASON_MAX_LENGTH ? `${withoutPaths.slice(0, REASON_MAX_LENGTH)}…` : withoutPaths;
}

const STATE_LABELS: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  paused_network: "网络已暂停",
  waiting_answer: "等待作答中",
  completed: "已完成",
  failed: "已失败",
  stopped: "已停止",
  interrupted: "已中断",
};

function stateLabel(state: string): string {
  return STATE_LABELS[state as RunState] ?? state;
}

function briefResult(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof result.id === "string") parts.push(result.id);
  if (typeof result.state === "string") parts.push(stateLabel(result.state));
  if (typeof result.stateReason === "string") parts.push(result.stateReason);
  return parts.join(" ");
}

// 中止与超时共用同一句回执：调用方（daemon 或 git 子进程）状态在中止那一刻是未知的，
// 不能宣称"未执行"，只能引导去 agents list 核对真实状态
const ABORT_RECEIPT = "已停止等待，守护进程可能仍在执行，请用 agents list 核对";

const DAEMON_CALL_TIMEOUT_MS = 30_000;

function callWithAbort(
  client: DaemonClient,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error(ABORT_RECEIPT)));
    const timer = setTimeout(() => finish(() => reject(new Error(ABORT_RECEIPT))), DAEMON_CALL_TIMEOUT_MS);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.call(method, params).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function locateClient(cwd: string, clients: WorkspaceClientsHandle): Promise<DaemonClient | undefined> {
  const identity = await repositoryIdentity(cwd);
  return clients.forRepo(identity.repoId);
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// 与守护进程侧唯一性判定同口径：confirmed 及其后的进行中阶段（含 retreat 回到的 executing）均可再次派出，
// 唯一性交给守护进程的 already_active 判定
const DISPATCH_BLOCKED_STAGE_REASONS: Record<string, string> = {
  draft: "尚未确认",
  rejected: "已被拒绝",
  accepted: "已验收",
};

async function executeDispatch(
  params: { requirement: string; cwd: string },
  dctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { requirement, cwd } = params;
  if (!isAbsolute(cwd)) return errorResult(`cwd 必须是绝对路径: ${cwd}`);
  const state = await readRequirementState({ dataRoot: dataRoot(process.env), cwd, requirement });
  if (!state.exists) return errorResult(`${requirement} 尚未确认，无法派出`);
  const blockedReason = DISPATCH_BLOCKED_STAGE_REASONS[state.data.stage];
  if (blockedReason) return errorResult(`${requirement} ${blockedReason}，无法派出`);
  const client = await locateClient(cwd, dctx.clients);
  if (!client) return errorResult(`${requirement} 所在仓库不在工作区内`);
  try {
    const result = await callWithAbort(client, "dispatch.requirement", { requirement, cwd }, signal);
    return okResult(`${requirement} 已派出：${briefResult(result)}`);
  } catch (error) {
    const runId = daemonErrorCode(error) === "already_active" ? daemonErrorData(error)?.runId : undefined;
    if (typeof runId === "string") return okResult(`${requirement} 已有活动运行：${runId}`);
    throw error;
  }
}

async function executeReview(
  params: { requirement: string; cwd: string; baseline: string },
  dctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { requirement, cwd, baseline } = params;
  if (!isAbsolute(cwd)) return errorResult(`cwd 必须是绝对路径: ${cwd}`);
  const timeoutMs = dctx.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const maxBuffer = dctx.gitMaxBuffer ?? GIT_MAX_BUFFER;
  // 快照计算先于连接定位：定位仓库连接也要经 git 子进程，先出发才能在 PATH 被劫持/git 挂起时被同一个 signal 及时中止
  let snapshot;
  try {
    snapshot = await collectGitSnapshot({ repoRoot: cwd, gitTimeoutMs: timeoutMs, gitMaxBuffer: maxBuffer, signal });
  } catch (error) {
    // collectGitSnapshot 对中止只报"已中止"，这里按守护进程调用惯例换成 ABORT_RECEIPT 措辞
    if (signal?.aborted) throw new Error(ABORT_RECEIPT);
    throw error;
  }
  const client = await locateClient(cwd, dctx.clients);
  if (!client) return errorResult(`${requirement} 所在仓库不在工作区内`);
  const result = await callWithAbort(
    client,
    "dispatch.review",
    { requirement, cwd, baseline, snapshot: { head: snapshot.head, fingerprint: snapshot.fingerprint } },
    signal,
  );
  return okResult(`${requirement} 已派出提交前白盒审查：${briefResult(result)}`);
}

async function executeReply(
  params: { questionId: string; answer: string },
  dctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const targets = dctx.clients.all();
  if (targets.length === 0) return errorResult("工作区内没有可用的仓库连接");
  const settled = await Promise.allSettled(
    targets.map((client) => callWithAbort(client, "relay.answer", { questionId: params.questionId, answer: params.answer, windowId: dctx.windowId }, signal)),
  );
  const accepted = settled.some((entry) => entry.status === "fulfilled" && entry.value.accepted === true);
  if (accepted) return okResult(`问题 ${params.questionId} 作答已采纳`);
  const rejections = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  const otherFailures = rejections.filter((entry) => daemonErrorCode(entry.reason) !== "not_found");
  if (otherFailures.length > 0) {
    return errorResult(otherFailures.map((entry) => briefReason(errorMessage(entry.reason))).join("; "));
  }
  if (rejections.length > 0 && rejections.length === settled.length) {
    return errorResult(`问题 ${params.questionId} 不存在`);
  }
  return errorResult(`问题 ${params.questionId} 已由其他窗口作答`);
}

const IN_PROGRESS_STAGES = new Set(["confirmed", "planned", "executing", "reviewing", "accepting"]);

async function executeForward(
  params: { requirement: string; cwd: string; message: string },
  dctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const { requirement, cwd, message } = params;
  if (!isAbsolute(cwd)) return errorResult(`cwd 必须是绝对路径: ${cwd}`);
  const client = await locateClient(cwd, dctx.clients);
  if (!client) return errorResult(`${requirement} 所在仓库不在工作区内`);
  const state = await readRequirementState({ dataRoot: dataRoot(process.env), cwd, requirement });
  if (!state.exists || !IN_PROGRESS_STAGES.has(state.data.stage)) {
    return errorResult(`${requirement} 尚无进行中状态`);
  }
  const result = await callWithAbort(client, "relay.forward", { requirement, message, windowId: dctx.windowId }, signal);
  return okResult(`${requirement} 转发成功：${briefResult(result)}`);
}

const SINGLE_RUN_METHODS: Record<string, string> = {
  status: "runs.get",
  pause: "runs.pause",
  resume: "runs.resume",
  stop: "runs.stop",
  resumeInterrupted: "runs.resumeInterrupted",
};

const BROADCAST_ALL_METHODS: Record<string, string> = {
  pauseAll: "runs.pauseAll",
  resumeAll: "runs.resumeAll",
  stopAll: "runs.stopAll",
};

const BROADCAST_ALL_FIELD: Record<string, string> = {
  pauseAll: "pausedCount",
  resumeAll: "resumedCount",
  stopAll: "stoppedCount",
};

interface BroadcastTarget {
  name: string;
  client: DaemonClient;
}

// WorkspaceClientsHandle 只能按 repoId 查、不能反查仓库名；名字一律取 workspace.repos 里
// 已发现的仓库路径（按 repoId 对上 clients 才纳入广播目标），不再靠扫目录反推。
// 主目录与其 worktree 的 repoId 相同（同一份 commonDir），按 repoId 去重、首条胜出，
// 与 runtime/daemon-client.ts 的 WorkspaceClients.create 里 uniqueRepos 的去重口径一致，
// 否则同一个连接会被广播/计数两次
function broadcastTargets(workspace: Workspace, clients: WorkspaceClientsHandle): BroadcastTarget[] {
  const uniqueRepos = new Map<string, string>();
  for (const repo of workspace.repos) {
    if (!uniqueRepos.has(repo.repoId)) uniqueRepos.set(repo.repoId, repo.path);
  }

  const targets: BroadcastTarget[] = [];
  const matchedClients = new Set<DaemonClient>();
  for (const [repoId, path] of uniqueRepos) {
    const client = clients.forRepo(repoId);
    if (client) {
      targets.push({ name: basename(path), client });
      matchedClients.add(client);
    }
  }
  for (const client of clients.all()) {
    if (!matchedClients.has(client)) targets.push({ name: "未知仓库", client });
  }
  return targets;
}

function formatRunList(
  targets: BroadcastTarget[],
  settled: PromiseSettledResult<Record<string, unknown>>[],
): { text: string; allFailed: boolean } {
  let anyOk = false;
  const parts = settled.map((entry, index) => {
    const name = targets[index]?.name ?? "未知仓库";
    if (entry.status === "fulfilled") {
      anyOk = true;
      const items = (entry.value.items as Array<{ id: string; state: string }> | undefined) ?? [];
      const summary = items.length > 0 ? items.map((item) => `${item.id}(${stateLabel(item.state)})`).join("、") : "无运行中的代理";
      return `${name}: ${summary}`;
    }
    return `${name}: ${briefReason(errorMessage(entry.reason))}`;
  });
  return { text: parts.join("；"), allFailed: settled.length > 0 && !anyOk };
}

function formatBroadcastAll(
  targets: BroadcastTarget[],
  settled: PromiseSettledResult<Record<string, unknown>>[],
  field: string,
): string {
  return settled
    .map((entry, index) => {
      const name = targets[index]?.name ?? "未知仓库";
      if (entry.status === "fulfilled") return `${name}: ${field}=${String(entry.value[field] ?? 0)}`;
      return `${name}: ${briefReason(errorMessage(entry.reason))}`;
    })
    .join("；");
}

async function executeAgents(
  params: { action: string; runId?: string; cwd?: string },
  ctx: { cwd: string },
  dctx: DispatchContext,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  if (params.action === "list") {
    const targets = broadcastTargets(dctx.workspace, dctx.clients);
    const settled = await Promise.allSettled(targets.map((target) => callWithAbort(target.client, "runs.list", {}, signal)));
    const { text, allFailed } = formatRunList(targets, settled);
    return allFailed ? errorResult(text) : okResult(text);
  }

  const broadcastMethod = BROADCAST_ALL_METHODS[params.action];
  if (broadcastMethod) {
    const targets = broadcastTargets(dctx.workspace, dctx.clients);
    const settled = await Promise.allSettled(targets.map((target) => callWithAbort(target.client, broadcastMethod, {}, signal)));
    return okResult(formatBroadcastAll(targets, settled, BROADCAST_ALL_FIELD[params.action] as string));
  }

  const method = SINGLE_RUN_METHODS[params.action];
  if (!method) return errorResult(`不支持的动作: ${params.action}`);
  if (!params.runId) return errorResult("缺少 runId");
  const cwd = params.cwd ?? ctx.cwd;
  if (!isAbsolute(cwd)) return errorResult(`cwd 必须是绝对路径: ${cwd}`);
  const client = await locateClient(cwd, dctx.clients);
  if (!client) return errorResult("仓库不在工作区内");
  const result = await callWithAbort(client, method, { runId: params.runId }, signal);
  return okResult(briefResult(result));
}

function renderSilently(): Component {
  return {
    render(): string[] {
      return [];
    },
    invalidate(): void {},
  };
}

export function registerDispatchTools(pi: ExtensionAPI, context: () => DispatchContext): void {
  pi.registerTool({
    name: "pi_company_dispatch",
    label: "派出需求代理",
    description: "为已确认的需求派出需求代理",
    parameters: DISPATCH_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
      try {
        return await executeDispatch(params, context(), signal);
      } catch (error) {
        return errorResult(briefReason(errorMessage(error)));
      }
    },
    renderCall: () => renderSilently(),
    renderResult: () => renderSilently(),
  });

  pi.registerTool({
    name: "pi_company_review",
    label: "派出提交前白盒审查",
    description: "为需求派出提交前白盒审查者",
    parameters: REVIEW_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
      try {
        return await executeReview(params, context(), signal);
      } catch (error) {
        return errorResult(briefReason(errorMessage(error)));
      }
    },
    renderCall: () => renderSilently(),
    renderResult: () => renderSilently(),
  });

  pi.registerTool({
    name: "pi_company_reply",
    label: "回复问题",
    description: "把用户答复转交给发出提问的窗口",
    parameters: REPLY_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
      try {
        return await executeReply(params, context(), signal);
      } catch (error) {
        return errorResult(briefReason(errorMessage(error)));
      }
    },
    renderCall: () => renderSilently(),
    renderResult: () => renderSilently(),
  });

  pi.registerTool({
    name: "pi_company_forward",
    label: "转发补充需求",
    description: "把补充说明转发给进行中需求所在的窗口",
    parameters: FORWARD_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
      try {
        return await executeForward(params, context(), signal);
      } catch (error) {
        return errorResult(briefReason(errorMessage(error)));
      }
    },
    renderCall: () => renderSilently(),
    renderResult: () => renderSilently(),
  });

  pi.registerTool({
    name: "pi_company_agents",
    label: "查询与控制运行",
    description: "查询工作区内的代理运行并按需暂停、恢复或停止",
    parameters: AGENTS_PARAMETERS,
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      try {
        return await executeAgents(params, ctx, context(), signal);
      } catch (error) {
        return errorResult(briefReason(errorMessage(error)));
      }
    },
    renderCall: () => renderSilently(),
    renderResult: () => renderSilently(),
  });
}

export default function dispatchExtension(pi: ExtensionAPI): void {
  registerDispatchTools(pi, () => {
    const { clients, windowId, workspace } = windowContext();
    return { clients, windowId, workspace };
  });
}
