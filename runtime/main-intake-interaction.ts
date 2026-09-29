import { performance } from "node:perf_hooks";
import { adviceIn } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolExecutionEndEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";
import { HostAuthorizationManager } from "./host-authorization.ts";
import type { RequirementManageHostContext } from "./main-requirement-interaction.ts";
import { pmDecisionNotes } from "./pm-intake-runtime.ts";
import type { PmDecisionNote } from "./pm-intake-runtime.ts";
import {
  PmIntakeService,
  type IntakeRequestView,
  type IntakeReviewDecision,
  type IntakeReviewView,
  type MainIntakeCall,
  type MainIntakeCallIdentity,
  type PmSourceDirectoryProvider,
  type PmSubmissionProvider,
} from "./pm-intake-service.ts";
import { RequirementService } from "./requirement-service.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { decisionDigest } from "./short-decision-format.ts";
import { unwrapRequest } from "./tool-request.ts";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const uuid = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const shortIssue = Type.String({ minLength: 1, maxLength: 400 });
const purpose = Type.Literal("pm-intake");

export const PM_INTAKE_ASK_PARAMETERS = object({
  purpose,
  action: Type.Literal("ask"),
  repoId,
  requirementId: uuid,
  operationId: uuid,
});
export const PM_INTAKE_FORWARD_PARAMETERS = object({
  purpose,
  action: Type.Literal("forward"),
  repoId,
  requirementId: uuid,
  requestId: uuid,
});
export const PM_INTAKE_REPLY_PARAMETERS = object({
  purpose,
  action: Type.Literal("reply"),
  repoId,
  requirementId: uuid,
  requestId: uuid,
  operationId: uuid,
  result: Type.Union([
    Type.Literal("passed"),
    Type.Literal("pm_correction_required"),
    Type.Literal("prod_revision_required"),
    Type.Literal("clarification_required"),
  ]),
  shortIssues: Type.Array(shortIssue, { maxItems: 8 }),
});
export const PM_INTAKE_PARAMETERS = Type.Union([
  PM_INTAKE_ASK_PARAMETERS,
  PM_INTAKE_FORWARD_PARAMETERS,
  PM_INTAKE_REPLY_PARAMETERS,
]);
export type PmIntakeToolInput = Static<typeof PM_INTAKE_PARAMETERS>;

const PM_SCHEMAS: Readonly<Record<PmIntakeToolInput["action"], TSchema>> = Object.freeze({
  ask: PM_INTAKE_ASK_PARAMETERS,
  forward: PM_INTAKE_FORWARD_PARAMETERS,
  reply: PM_INTAKE_REPLY_PARAMETERS,
});
const RESPONSE_BYTES = 50 * 1024;
const INNER_BYTES = 49_152;
const MAX_PENDING = 32;
const DEFAULT_TTL_MS = 30_000;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;

const MAIN_INTAKE_ADVICE: Record<string, FailureAdvice> = {
  delivery_changed: { why: "结果送达前内容或上下文被改动", next: "重新发起一次" },
  delivery_unavailable: { why: "结果已过期或不属于本次调用", next: "重新发起一次" },
  disposed: { why: "接手复核已关闭，所在会话已结束", next: "停止操作，不要重试；把这段原因告诉用户" },
  duplicate_tool_call: { why: "同一个工具调用编号被重复使用", next: "重新发起一次" },
  foreign_repo: { why: "repoId 不是当前窗口工作区里的仓库", next: "改用当前工作区列出的仓库编号" },
  invalid_options: { why: "接手复核配置不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_shape: { why: "接手复核参数不合规", next: "按原因改正后重试" },
  invalid_signal: { why: "取消信号不可用", next: "停止操作，不要重试；把这段原因告诉用户" },
  invalid_ttl: { why: "有效期设置不合规", next: "停止操作，不要重试；把这段原因告诉用户" },
  operation_cancelled: { why: "操作被取消", next: "需要时重新发起" },
  requirement_not_bound: { why: "当前窗口没有绑定这个需求", next: "请用户用 /one:requirement-select 选择需求，或用当前绑定的需求编号" },
  response_budget_exceeded: { why: "返回内容超出上限", next: "重试一次；仍然失败就把这段原因告诉用户" },
  session_not_started: { why: "会话还没准备好", next: "稍等几秒再试" },
  source_directory_provider_unavailable: { why: "读不到接手出处目录", next: "重试一次；仍然失败就把这段原因告诉用户" },
  stale_context: { why: "会话或窗口已切换，本次操作作废", next: "在当前窗口里重新发起" },
  stale_delivery: { why: "结果送达前已过期或被取消", next: "重新发起一次" },
  stale_host: { why: "窗口或会话已切换，本次操作作废", next: "在当前窗口里重新发起" },
  stale_tool_call: { why: "工具调用已过期", next: "重新发起一次" },
  submission_provider_unavailable: { why: "读不到 PM 提交的接手理解", next: "重试一次；仍然失败就把这段原因告诉用户" },
  tool_call_limit: { why: "进行中的工具调用太多", next: "等已有调用结束后再试" },
  unobserved_tool_call: { why: "宿主没有看到这次工具调用的发起", next: "重新发起一次" },
};
export class MainIntakeInteractionError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string) {
    super(`pm_intake_interaction_denied:${code}`);
    this.name = "MainIntakeInteractionError";
    this.code = code;
    this.advice = adviceIn(MAIN_INTAKE_ADVICE, code);
  }
}

function deny(code: string): never {
  throw new MainIntakeInteractionError(code);
}

function cloneChecked<T>(schema: TSchema, value: unknown): T {
  let copy: unknown;
  try { copy = structuredClone(value); }
  catch { return deny("invalid_shape"); }
  if (!Value.Check(schema, copy)) deny("invalid_shape");
  return copy as T;
}

export function checkPmIntakeToolInput(value: unknown): PmIntakeToolInput {
  let copy: unknown;
  try { copy = structuredClone(value); }
  catch { return deny("invalid_shape"); }
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) deny("invalid_shape");
  const action = (copy as { action?: unknown }).action;
  if (typeof action !== "string" || !Object.hasOwn(PM_SCHEMAS, action)) deny("invalid_shape");
  const checked = cloneChecked<PmIntakeToolInput>(PM_SCHEMAS[action as PmIntakeToolInput["action"]]!, copy);
  if (checked.action === "reply") {
    for (const issue of checked.shortIssues) {
      if (!issue.trim() || Array.from(issue).length > 400 || [...issue].some((character) => {
        const point = character.codePointAt(0)!;
        return point >= 0xd800 && point <= 0xdfff;
      })) deny("invalid_shape");
    }
  }
  return checked;
}

function nativeSignalAborted(signal: AbortSignal): boolean {
  try { return signalAborted.call(signal) as boolean; }
  catch { return deny("invalid_signal"); }
}

function json(value: unknown): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { return deny("invalid_shape"); }
  if (serialized === undefined) deny("invalid_shape");
  return serialized;
}

export function createPmIntakeToolResponse(
  action: PmIntakeToolInput["action"],
  view: IntakeRequestView | IntakeReviewView,
  decisions?: PmDecisionNote[],
): {
  response: { content: [{ type: "text"; text: string }]; details: { format: "pm-intake-transport/v1"; action: PmIntakeToolInput["action"] } };
  responseBytes: string;
} {
  const viewText = json(decisions ? { ...view, decisions } : view);
  if (Buffer.byteLength(viewText, "utf8") > INNER_BYTES) deny("response_budget_exceeded");
  const response = {
    content: [{ type: "text" as const, text: viewText }] as [{ type: "text"; text: string }],
    details: { format: "pm-intake-transport/v1" as const, action },
  };
  const responseBytes = json(response);
  if (Buffer.byteLength(responseBytes, "utf8") > RESPONSE_BYTES) deny("response_budget_exceeded");
  return { response, responseBytes };
}

function repositories(host: RequirementManageHostContext): Array<readonly [string, string]> {
  return [...host.repositories.entries()]
    .map(([id, value]) => [id, value.path] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

interface SessionBinding {
  readonly manager: object;
  readonly sessionId: string;
  readonly windowId: string;
  readonly cwd: string;
  readonly mode: ExtensionContext["mode"];
  readonly repositories: readonly (readonly [string, string])[];
}
interface CurrentContext {
  readonly session: SessionBinding;
  readonly manager: object;
  readonly host: RequirementManageHostContext;
  readonly binding: { readonly repoId: string; readonly requirementId: string } | undefined;
  readonly signal: AbortSignal | undefined;
}
interface ObservedCall {
  readonly params: PmIntakeToolInput;
  readonly inputHash: string;
  readonly session: SessionBinding;
  readonly manager: object;
  readonly signal: AbortSignal | undefined;
  readonly hostGeneration: number;
  readonly expiresAt: number;
}
interface OwnedCall {
  readonly expiresAt: number;
  readonly abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface CallBinding {
  readonly identity: Readonly<MainIntakeCallIdentity>;
  readonly guard: () => void;
}
interface Delivery {
  readonly inputHash: string;
  readonly responseBytes: string;
  readonly session: SessionBinding;
  readonly manager: object;
  readonly signal: AbortSignal | undefined;
  readonly operationSignal: AbortSignal;
  readonly hostGeneration: number;
  readonly expiresAt: number;
  readonly service: PmIntakeService;
  readonly call: MainIntakeCall;
  readonly view: IntakeRequestView | IntakeReviewView;
}

export interface MainIntakeProviders {
  readonly sourceDirectoryProvider: PmSourceDirectoryProvider;
  readonly submissionProvider: PmSubmissionProvider;
}
export interface MainIntakeInteractionOptions {
  readonly dataRoot: string;
  readonly authorization: HostAuthorizationManager;
  readonly resolveHost: (ctx: ExtensionContext) => RequirementManageHostContext;
  /** 仅可信宿主或测试装置在构造时注入；缺失时生产路径明确拒绝。 */
  readonly providers?: MainIntakeProviders;
  readonly callTtlMs?: number;
}

/**
 * 把真实 SDK tool_call、execute 与 tool_result 绑定成一次 Main 接手调用。
 * 只保留短期内存材料；持久化仍由 PmIntakeService 的严格元数据存储负责。
 */
export class MainIntakeInteraction {
  readonly #options: MainIntakeInteractionOptions;
  readonly #authorization: HostAuthorizationManager;
  readonly #calls = new WeakMap<object, CallBinding>();
  readonly #observed = new Map<string, ObservedCall>();
  readonly #owned = new Map<string, OwnedCall>();
  readonly #executing = new Map<string, OwnedCall>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #retired = new Map<string, number>();
  readonly #unsubscribeHost: () => void;
  #session: SessionBinding | undefined;
  #abort = new AbortController();
  #cleanupTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: MainIntakeInteractionOptions) {
    if (!options.dataRoot) deny("invalid_options");
    const ttl = options.callTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > DEFAULT_TTL_MS) deny("invalid_ttl");
    this.#options = { ...options };
    this.#authorization = options.authorization;
    this.#unsubscribeHost = this.#authorization.onRevoke(() => this.revoke());
  }

  startSession(ctx: ExtensionContext): void {
    if (this.#disposed) deny("disposed");
    this.shutdown();
    const manager = ctx.sessionManager as object;
    const sessionId = ctx.sessionManager.getSessionId();
    const host = this.#options.resolveHost(ctx);
    const principal = this.#authorization.assertCurrentSession(sessionId);
    if (host.sessionId !== sessionId || host.windowId !== principal.windowId) deny("stale_host");
    const listed = repositories(host);
    if (listed.length !== principal.repoIds.length || listed.some(([id]) => !principal.repoIds.includes(id))) deny("stale_host");
    this.#session = Object.freeze({ manager, sessionId, windowId: host.windowId, cwd: ctx.cwd,
      mode: ctx.mode, repositories: Object.freeze(listed.map((entry) => Object.freeze(entry))) });
    const interval = Math.max(10, Math.min(this.#options.callTtlMs ?? DEFAULT_TTL_MS, 1_000));
    this.#cleanupTimer = setInterval(() => this.#sweep(), interval);
    this.#cleanupTimer.unref?.();
  }

  #retire(toolCallId: string): void {
    const owned = this.#owned.get(toolCallId) ?? this.#executing.get(toolCallId);
    if (owned?.timer) { clearTimeout(owned.timer); owned.timer = undefined; }
    owned?.abort.abort();
    this.#observed.delete(toolCallId);
    this.#deliveries.delete(toolCallId);
    this.#owned.delete(toolCallId);
    this.#retired.delete(toolCallId);
    this.#retired.set(toolCallId, performance.now() + DEFAULT_TTL_MS);
    while (this.#retired.size > MAX_PENDING * 2) this.#retired.delete(this.#retired.keys().next().value!);
  }

  #sweep(): void {
    const now = performance.now();
    for (const [toolCallId, owned] of this.#owned) if (now >= owned.expiresAt) this.#retire(toolCallId);
    for (const [toolCallId, expiresAt] of this.#retired) if (now >= expiresAt) this.#retired.delete(toolCallId);
  }

  #context(ctx: ExtensionContext): CurrentContext {
    const session = this.#session;
    if (!session || this.#disposed) deny("session_not_started");
    let manager: object, sessionId: string, cwd: string, mode: ExtensionContext["mode"], signal: AbortSignal | undefined;
    let host: RequirementManageHostContext;
    try {
      manager = ctx.sessionManager as object;
      sessionId = ctx.sessionManager.getSessionId();
      cwd = ctx.cwd;
      mode = ctx.mode;
      signal = ctx.signal;
      host = this.#options.resolveHost(ctx);
    } catch { return deny("stale_context"); }
    const principal = this.#authorization.assertCurrentSession(sessionId);
    const listed = repositories(host);
    if (manager !== session.manager || sessionId !== session.sessionId || cwd !== session.cwd || mode !== session.mode ||
      host.sessionId !== sessionId || host.windowId !== session.windowId || principal.windowId !== session.windowId ||
      decisionDigest(listed) !== decisionDigest(session.repositories)) deny("stale_context");
    return { session, manager, host, binding: this.#authorization.binding(sessionId), signal };
  }

  #assertInputContext(input: PmIntakeToolInput, current: CurrentContext): void {
    if (!current.binding || current.binding.repoId !== input.repoId || current.binding.requirementId !== input.requirementId) {
      deny("requirement_not_bound");
    }
    const path = current.host.repositories.get(input.repoId)?.path;
    if (!path) deny("foreign_repo");
    this.#authorization.assertRequirement(input.repoId, input.requirementId, current.session.sessionId);
  }

  observeToolCall(event: Pick<ToolCallEvent, "toolName" | "toolCallId" | "input">, ctx: ExtensionContext): void {
    const request = unwrapRequest(event.input) as { purpose?: unknown } | undefined;
    if (event.toolName !== "one_company_user_interact" || request?.purpose !== "pm-intake") return;
    this.#sweep();
    if (this.#owned.has(event.toolCallId) || this.#executing.has(event.toolCallId) || this.#retired.has(event.toolCallId)) deny("duplicate_tool_call");
    if (new Set([...this.#owned.keys(), ...this.#executing.keys()]).size >= MAX_PENDING) deny("tool_call_limit");
    const params = checkPmIntakeToolInput(request), current = this.#context(ctx);
    this.#assertInputContext(params, current);
    const expiresAt = performance.now() + (this.#options.callTtlMs ?? DEFAULT_TTL_MS);
    this.#observed.set(event.toolCallId, { params, inputHash: decisionDigest(params), session: current.session,
      manager: current.manager, signal: current.signal, hostGeneration: this.#authorization.generation, expiresAt });
    const owned: OwnedCall = { expiresAt, abort: new AbortController() };
    this.#owned.set(event.toolCallId, owned);
    owned.timer = setTimeout(() => {
      if (this.#owned.get(event.toolCallId) === owned) this.#retire(event.toolCallId);
    }, Math.max(0, expiresAt - performance.now()));
    owned.timer.unref?.();
  }

  async #intakeService(ctx: ExtensionContext, observed: ObservedCall, input: PmIntakeToolInput): Promise<{
    service: PmIntakeService;
    guard: () => void;
  }> {
    const providers = this.#options.providers;
    if (!providers?.sourceDirectoryProvider) deny("source_directory_provider_unavailable");
    if (!providers.submissionProvider) deny("submission_provider_unavailable");
    const repositoryRoot = this.#context(ctx).host.repositories.get(input.repoId)?.path;
    if (!repositoryRoot) deny("foreign_repo");
    const guard = () => {
      const current = this.#context(ctx);
      this.#assertInputContext(input, current);
      if (current.session !== observed.session || current.manager !== observed.manager || current.signal !== observed.signal ||
        observed.signal && nativeSignalAborted(observed.signal) || this.#authorization.generation !== observed.hostGeneration ||
        performance.now() >= observed.expiresAt) deny("stale_tool_call");
    };
    const state = await RequirementStateStore.open({ dataRoot: this.#options.dataRoot, repositoryRoot,
      repoId: input.repoId, authorize: (request) => {
        try {
          guard();
          if (request.repoId !== input.repoId || !["open", "read", "check-pm"].includes(request.action)) return false;
          if (request.action === "open") return request.input.repositoryRoot === repositoryRoot;
          return request.input.requirementId === input.requirementId;
        } catch { return false; }
      } });
    guard();
    const requirementService = await RequirementService.open({ dataRoot: this.#options.dataRoot, repositoryRoot,
      repoId: input.repoId, authorize: (request) => {
        try {
          guard();
          if (request.repoId !== input.repoId || !["metadata", "readApproved"].includes(request.action)) return false;
          return request.requirementId === undefined || request.requirementId === input.requirementId;
        } catch { return false; }
      } });
    guard();
    const service = new PmIntakeService({ dataRoot: this.#options.dataRoot, repoId: input.repoId, state, requirementService,
      authorization: this.#authorization, sourceDirectoryProvider: providers.sourceDirectoryProvider,
      submissionProvider: providers.submissionProvider, deadlineMonotonic: observed.expiresAt,
      mainCallResolver: { resolve: (call) => {
        const binding = this.#calls.get(call as object);
        if (!binding) return null;
        binding.guard();
        return binding.identity;
      } } });
    return { service, guard };
  }

  #combinedSignal(observed: ObservedCall, signal: AbortSignal | undefined, current: CurrentContext, owned: OwnedCall): AbortSignal {
    if (observed.signal !== current.signal || signal !== undefined && signal !== observed.signal) deny("stale_context");
    if (observed.signal) nativeSignalAborted(observed.signal);
    if (signal) nativeSignalAborted(signal);
    return AbortSignal.any([owned.abort.signal, this.#abort.signal, ...(observed.signal ? [observed.signal] : [])]);
  }

  #fixedCurrent(delivery: Pick<Delivery, "session" | "manager" | "signal" | "operationSignal" | "hostGeneration" | "expiresAt">): void {
    if (this.#session !== delivery.session || delivery.manager !== delivery.session.manager ||
      this.#authorization.generation !== delivery.hostGeneration || delivery.signal && nativeSignalAborted(delivery.signal) ||
      nativeSignalAborted(delivery.operationSignal) || performance.now() >= delivery.expiresAt) deny("stale_delivery");
  }

  async execute(toolCallId: string, raw: unknown, ctx: ExtensionContext, signal?: AbortSignal) {
    this.#sweep();
    const input = checkPmIntakeToolInput(raw);
    const observed = this.#observed.get(toolCallId), owned = this.#owned.get(toolCallId);
    this.#observed.delete(toolCallId);
    if (!observed || !owned || decisionDigest(input) !== observed.inputHash || performance.now() >= observed.expiresAt) deny("unobserved_tool_call");
    const current = this.#context(ctx);
    this.#assertInputContext(input, current);
    if (current.session !== observed.session || current.manager !== observed.manager ||
      this.#authorization.generation !== observed.hostGeneration) deny("stale_tool_call");
    const operationSignal = this.#combinedSignal(observed, signal, current, owned);
    if (nativeSignalAborted(operationSignal)) deny("operation_cancelled");
    this.#executing.set(toolCallId, owned);
    try { return await this.#executeOwned(toolCallId, observed, input, ctx, current, operationSignal); }
    finally { this.#executing.delete(toolCallId); }
  }

  async #executeOwned(toolCallId: string, observed: ObservedCall, input: PmIntakeToolInput, ctx: ExtensionContext,
    current: CurrentContext, operationSignal: AbortSignal) {
    const intake = await this.#intakeService(ctx, observed, input), service = intake.service;
    const call: MainIntakeCall = Object.freeze({ kind: "main-intake-call" });
    const identity = Object.freeze({ repoId: input.repoId, requirementId: input.requirementId,
      windowId: current.session.windowId, sessionId: current.session.sessionId, toolCallId });
    this.#calls.set(call, Object.freeze({ identity, guard: intake.guard }));
    let view: IntakeRequestView | IntakeReviewView;
    switch (input.action) {
      case "ask": view = await service.openRequest(call, input.operationId, operationSignal); break;
      case "forward": view = await service.readRequest(call, input.requestId, operationSignal); break;
      case "reply": {
        const decision: IntakeReviewDecision = { result: input.result, shortIssues: [...input.shortIssues] };
        view = await service.recordReview(call, input.requestId, input.operationId, decision, operationSignal);
        break;
      }
      default: return deny("invalid_shape");
    }
    const decisions = input.action === "reply" ? undefined : pmDecisionNotes({ dataRoot: this.#options.dataRoot, repoId: input.repoId }, input.requirementId);
    const built = createPmIntakeToolResponse(input.action, view, decisions), response = built.response;
    const delivery: Delivery = { inputHash: observed.inputHash, responseBytes: built.responseBytes, session: observed.session,
      manager: observed.manager, signal: observed.signal, operationSignal, hostGeneration: observed.hostGeneration,
      expiresAt: observed.expiresAt, service, call, view };
    this.#deliveries.set(toolCallId, delivery);
    try {
      service.assertResultCurrent(call, view);
      this.#fixedCurrent(delivery);
      return response;
    } catch (error) {
      this.#deliveries.delete(toolCallId);
      throw error;
    }
  }

  ownsDelivery(toolCallId: string): boolean {
    this.#sweep();
    return this.#owned.has(toolCallId) || this.#retired.has(toolCallId);
  }

  completeToolExecution(event: Pick<ToolExecutionEndEvent, "toolName" | "toolCallId">): void {
    if (event.toolName !== "one_company_user_interact") return;
    if (this.#owned.has(event.toolCallId)) this.#retire(event.toolCallId);
  }

  assertDelivery(event: Pick<ToolResultEvent, "toolCallId" | "input" | "content" | "details" | "isError">, ctx: ExtensionContext): void {
    this.#sweep();
    const owned = this.#owned.get(event.toolCallId);
    const delivery = this.#deliveries.get(event.toolCallId);
    if (!owned || !delivery || event.isError || performance.now() >= owned.expiresAt) deny("delivery_unavailable");
    try { this.#assertDeliveryCurrent(event, ctx, delivery); }
    finally { this.#retire(event.toolCallId); }
  }

  #assertDeliveryCurrent(event: Pick<ToolResultEvent, "toolCallId" | "input" | "content" | "details" | "isError">,
    ctx: ExtensionContext, delivery: Delivery): void {
    const input = checkPmIntakeToolInput(unwrapRequest(event.input));
    const current = this.#context(ctx);
    this.#assertInputContext(input, current);
    const actualBytes = json({ content: event.content, details: event.details });
    if (decisionDigest(input) !== delivery.inputHash || actualBytes !== delivery.responseBytes ||
      current.session !== delivery.session || current.manager !== delivery.manager || current.signal !== delivery.signal) deny("delivery_changed");
    if (delivery.signal && nativeSignalAborted(delivery.signal) || nativeSignalAborted(delivery.operationSignal) ||
      this.#authorization.generation !== delivery.hostGeneration || performance.now() >= delivery.expiresAt) deny("stale_delivery");
    delivery.service.assertResultCurrent(delivery.call, delivery.view);
    this.#fixedCurrent(delivery);
  }

  clearForCompaction(_ctx: ExtensionContext): void {
    this.revoke();
  }

  revoke(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
    for (const toolCallId of new Set([...this.#owned.keys(), ...this.#executing.keys()])) this.#retire(toolCallId);
    this.#observed.clear();
    this.#deliveries.clear();
    this.#owned.clear();
  }

  shutdown(): void {
    this.revoke();
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
    this.#retired.clear();
    this.#session = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.shutdown();
    this.#disposed = true;
    this.#unsubscribeHost();
  }
}
