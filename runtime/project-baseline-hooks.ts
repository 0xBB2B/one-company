import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isAbsolute, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { ProjectBaselineError, RequestBaselineGate } from "./project-baseline.ts";
import type { ProjectBaselineProvider, ProjectBaselineMutation, RequestBaseline, ProjectBaselineSeal, ProjectBaselineSealMetadata, ProjectBaselineInvalidation } from "./project-baseline.ts";

export const OLD_PROJECT_SNAPSHOT = "项目输入已变化或当前基线不可核对；本次回答属于旧快照，不能据此继续写入或交付。下一次请求须重新核对当前项目。";
const bindings = new WeakMap<object, ProjectBaselineHooks>();

/** 可信进程登记无法证明真实结束时，宿主不得继续捕获 fresh。 */
export class UnsettledProjectMutationError extends Error {}

export interface ProjectBaselineHooksOptions {
  provider: ProjectBaselineProvider;
  /** 实际路径策略与原有范围/沙箱保护是另外的必要门槛。 */
  checkPath?: (absolutePath: string, request: RequestBaseline) => Promise<string>;
  disposeProvider?: () => void | Promise<void>;
}

export interface ProjectBaselineHookInstallOptions extends Omit<ProjectBaselineHooksOptions, "provider" | "disposeProvider"> {
  /** 每个安装器惰性解析一次；ctx 来自真实 SDK，解析失败不会放行工具。 */
  provider: ProjectBaselineProvider | ((ctx: ExtensionContext) => ProjectBaselineProvider | Promise<ProjectBaselineProvider>);
  /** 仅回收本安装器拥有的 source；共享 daemon/coordinator 不应在此整体关闭。 */
  disposeProvider?: (provider: ProjectBaselineProvider) => void | Promise<void>;
}

/** SDK 的 sessionManager 对象是可信绑定，不接受模型传入的 sessionId/role。 */
export function projectBaselineForContext(ctx?: Pick<ExtensionContext, "sessionManager">): ProjectBaselineHooks | undefined {
  return ctx ? bindings.get(ctx.sessionManager) : undefined;
}

function messageKey(message: AssistantMessage): string {
  // SDK start 是浅拷贝；流内 timestamp/api/provider 稳定，model/responseId 可由服务端补写。
  // 相同稳定身份的重复或碰撞由 messageStart 拒绝，不能靠模型名区分并换绑请求。
  return JSON.stringify([message.timestamp, message.api, message.provider]);
}

export class ProjectBaselineHooks {
  readonly gate: RequestBaselineGate;
  private readonly options: ProjectBaselineHooksOptions;
  private request: RequestBaseline | undefined;
  private sequence = 0;
  private closed = false;
  private shellOperations = 0;
  private unsettledMutation = false;
  private disposal: Promise<void> = Promise.resolve();
  private readonly messages = new Map<string, RequestBaseline | undefined>();
  private readonly dispatched: Array<RequestBaseline | undefined> = [];
  private readonly openMessages = new Set<string>();
  private ambiguousStreams = false;
  private readonly calls = new Map<string, RequestBaseline>();
  private completedMessages = new WeakMap<AssistantMessage, { request: RequestBaseline; messageId: string; hash: string }>();
  private preparation: { publication: boolean; other: boolean } | undefined;

  constructor(options: ProjectBaselineHooksOptions) {
    this.options = options;
    this.gate = new RequestBaselineGate({
      captureFresh: (signal) => options.provider.captureFresh(signal),
      assertCurrent: (snapshot, signal) => options.provider.assertCurrent(snapshot, signal),
      get assertUnmanaged() {
        const assert = options.provider.assertUnmanaged;
        return assert ? (signal?: AbortSignal) => assert.call(options.provider, signal) : undefined;
      },
      subscribeInvalidation: (listener) => options.provider.subscribeInvalidation((event) => {
        const preparation = this.preparation;
        if (preparation) {
          const publication = event.reason === "reconciled_change" && event.path === null && event.eventType === null
            && event.archiveMetadataOnly === false && event.requiresFullReconcile === true
            && ["watch", "read_before", "manual", "low_frequency"].includes(event.source ?? "")
            && Number.isSafeInteger(event.observedSequence) && event.observedSequence! >= 0
            && typeof event.baselineHash === "string" && /^[0-9a-f]{64}$/.test(event.baselineHash)
            && typeof event.repoId === "string" && typeof event.workspaceId === "string" && typeof event.authorityEpoch === "string";
          preparation.publication ||= publication;
          preparation.other ||= !publication;
        }
        listener(event);
      }),
    });
  }

  bindContext(ctx: Pick<ExtensionContext, "sessionManager">): void {
    if (this.closed) throw new ProjectBaselineError("stale");
    const manager = ctx.sessionManager;
    const previous = bindings.get(manager);
    if (previous && previous !== this && !previous.closed) throw new ProjectBaselineError("invalid_input");
    bindings.set(manager, this);
  }

  async beginRequest(): Promise<RequestBaseline> {
    const sequence = ++this.sequence;
    // SDK 单会话请求正常串行；存在未归属/未结束的旧流时，不猜哪个消息属于新请求。
    if (this.dispatched.length || this.openMessages.size) this.ambiguousStreams = true;
    this.request = undefined;
    this.calls.clear();
    this.gate.invalidate("request_boundary");
    // 新请求不停止已获授权的后台进程，也不把仍在写入的现场捕获为 fresh。
    if (this.shellOperations && this.gate.diagnostics.managed || this.unsettledMutation || this.ambiguousStreams) throw new ProjectBaselineError("busy");
    // 模型尚未发送时，准备所触发的发布通知可使本次读取中止；最多重新准备三次。
    // 原请求一直保持撤销。未知变化、权限变化或显式revoke不能借此续权。
    for (let attempt = 0; attempt < 3; attempt++) {
      const preparation = { publication: false, other: false };
      this.preparation = preparation;
      try {
        const request = await this.gate.beginRequest();
        if (request.kind === "managed" && this.shellOperations) { this.revoke(); throw new ProjectBaselineError("busy"); }
        if (sequence !== this.sequence || this.closed || this.gate.diagnostics.stale) throw new ProjectBaselineError("stale");
        this.request = request;
        return request;
      } catch (error) {
        if (attempt === 2 || sequence !== this.sequence || this.closed || !preparation.publication || preparation.other
          || this.dispatched.length || this.openMessages.size || this.ambiguousStreams || this.unsettledMutation
          || this.shellOperations && this.gate.diagnostics.managed
          || !(error instanceof ProjectBaselineError) || !["stale", "unavailable"].includes(error.code)) throw error;
      } finally {
        if (this.preparation === preparation) this.preparation = undefined;
      }
    }
    throw new ProjectBaselineError("unavailable");
  }

  async beforeProviderRequest(): Promise<void> {
    const request = this.request;
    if (this.dispatched.length >= 4096) { this.ambiguousStreams = true; this.revoke(); throw new ProjectBaselineError("resource_limit"); }
    this.dispatched.push(request);
    if (!request || this.ambiguousStreams) throw new ProjectBaselineError("stale");
    await this.gate.validateRequest(request);
  }

  messageStart(message: AssistantMessage): void {
    const key = messageKey(message);
    if (this.messages.has(key) || this.messages.size >= 4096) {
      this.revoke();
      if (this.messages.has(key)) this.messages.set(key, undefined);
      return;
    }
    const dispatched = this.dispatched.shift();
    this.openMessages.add(key);
    this.messages.set(key, this.ambiguousStreams ? undefined : dispatched);
  }

  async messageEnd(message: AssistantMessage): Promise<boolean> {
    const key = messageKey(message);
    this.openMessages.delete(key);
    const request = this.messages.get(key);
    if (!request || request !== this.request) return false;
    try {
      await this.gate.validateRequest(request);
      const ids = message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
      this.gate.bindCalls(ids, request);
      for (const id of ids) this.calls.set(id, request);
      if (message.stopReason === "stop" && !ids.length) this.completedMessages.set(message, { request, messageId: randomUUID(),
        hash: createHash("sha256").update(JSON.stringify(message)).digest("hex") });
      return true;
    } catch { this.revoke(); return false; }
  }

  revoke(): void {
    this.sequence++;
    this.request = undefined;
    this.calls.clear();
    this.gate.invalidate("sdk_boundary_failed");
  }

  async assertCall(callId: string): Promise<RequestBaseline> {
    const request = this.calls.get(callId);
    if (!request || request !== this.request) throw new ProjectBaselineError("stale");
    await this.gate.validateRequest(request);
    return request;
  }

  async checkPath(callId: string, path: string): Promise<string> {
    const request = await this.assertCall(callId);
    if (!this.options.checkPath) throw new ProjectBaselineError("unavailable");
    const checked = await this.options.checkPath(path, request);
    await this.assertCall(callId);
    return checked;
  }

  withMutation<T>(callId: string, mutation: ProjectBaselineMutation, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.gate.withMutation(callId, mutation, operation);
  }

  /** 只接受本安装器实际完成的 SDK 消息对象；克隆、改写或迟到消息不能借当前 request 续权。 */
  async assertMessage(message: AssistantMessage): Promise<RequestBaseline> {
    const checked = () => {
      const record = this.completedMessages.get(message);
      if (!record || record.request !== this.request || this.closed
        || record.hash !== createHash("sha256").update(JSON.stringify(message)).digest("hex")) throw new ProjectBaselineError("stale");
      if (this.gate.diagnostics.mutations || this.shellOperations || this.unsettledMutation) throw new ProjectBaselineError("busy");
      return record;
    };
    const record = checked();
    await this.gate.validateRequest(record.request);
    if (checked() !== record) throw new ProjectBaselineError("stale");
    return record.request;
  }

  async sealMessage(message: AssistantMessage): Promise<ProjectBaselineSeal> {
    const request = await this.assertMessage(message);
    const record = this.completedMessages.get(message)!;
    const seal = await this.gate.sealMessage(request, record.messageId);
    if (this.request !== request || this.completedMessages.get(message) !== record
      || record.hash !== createHash("sha256").update(JSON.stringify(message)).digest("hex")) {
      this.revoke();
      throw new ProjectBaselineError("stale");
    }
    return seal;
  }

  async sealResult(callId: string): Promise<ProjectBaselineSeal> { return this.gate.sealResult(callId); }

  async assertDelivery(seal: ProjectBaselineSeal): Promise<ProjectBaselineSealMetadata> { return this.gate.assertDelivery(seal); }

  /** operation 必须等真实进程结束；后台回执可另行返回，但不能提前 resolve 此 Promise。 */
  async runShell<T>(callId: string, cwd: string, operation: () => Promise<T>): Promise<T> {
    this.shellOperations++;
    let managed = false;
    try {
      const request = await this.assertCall(callId);
      if (request.kind === "unmanaged") return await operation();
      managed = true;
      if (request.origin) {
        const path = relative(await realpath(request.origin.root), await realpath(cwd));
        if (isAbsolute(path) || path === ".." || path.startsWith("../")) throw new ProjectBaselineError("invalid_input");
      }
      return await this.gate.withMutation(callId, { paths: [] }, operation);
    }
    catch (error) { if (managed && error instanceof UnsettledProjectMutationError) this.unsettledMutation = true; throw error; }
    finally { this.shellOperations--; }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.sequence++;
    this.request = undefined;
    this.calls.clear();
    this.messages.clear();
    this.completedMessages = new WeakMap();
    this.dispatched.length = 0;
    this.openMessages.clear();
    this.gate.dispose();
    // WeakMap 保留已关闭的拒绝标记：迟到工具不能因为解绑而退回无门槛 legacy。
    // 新安装器只可替换已关闭实例；旧 sessionManager 不再引用时标记可被回收。
    this.disposal = Promise.resolve().then(() => this.options.disposeProvider?.());
    void this.disposal.catch(() => {}); // shutdown() 仍向调用者报告真实清理失败。
  }

  /** 先同步撤权，再等待 source 清理；不把停止请求当作进程已经结束。 */
  async shutdown(): Promise<void> { this.dispose(); await this.disposal; }
}

/** 主宿主与角色共用；只安装 SDK hook，不授予任何工具或写入范围。 */
export function installProjectBaselineHooks(pi: ExtensionAPI, options: ProjectBaselineHookInstallOptions): ProjectBaselineHooks {
  let lastContext: ExtensionContext | undefined;
  let instance: ProjectBaselineHooks | undefined;
  let staleNotified = false;
  let previousRequest: RequestBaseline | undefined;
  // context 注入不会写回会话；旧资料仍在历史中时，每次请求保留提醒，不假装模型已忘记。
  let oldContext = false;
  const notify = (ctx: ExtensionContext): void => {
    // UI 不可用/抛错不影响已经完成的程序撤权。
    try { if (ctx.hasUI) ctx.ui.setStatus("project-baseline", OLD_PROJECT_SNAPSHOT); } catch { /* 无 UI。 */ }
  };
  let provider: ProjectBaselineProvider | undefined;
  let pendingProvider: Promise<ProjectBaselineProvider> | undefined;
  let sourceClosed = false;
  let sourceUnavailable = false;
  let unsubscribeSource: (() => void) | undefined;
  const sourceListeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  const resolveProvider = async (): Promise<ProjectBaselineProvider> => {
    if (sourceClosed || sourceUnavailable || !lastContext) throw new ProjectBaselineError("unavailable");
    if (provider) return provider;
    if (!pendingProvider) {
      const ctx = lastContext;
      pendingProvider = Promise.resolve().then(() => typeof options.provider === "function" ? options.provider(ctx) : options.provider).then((resolved) => {
        provider = resolved;
        if (sourceClosed) throw new ProjectBaselineError("stale");
        try { unsubscribeSource = resolved.subscribeInvalidation((event) => {
          for (const listener of sourceListeners) listener(event);
          if (instance?.gate.diagnostics.stale && instance.gate.diagnostics.managed) oldContext = true;
          if (instance?.gate.diagnostics.stale && lastContext && !staleNotified) {
            staleNotified = true;
            notify(lastContext);
            try { pi.appendEntry("project-baseline-stale", { status: "old_snapshot" }); } catch { /* 撤权已完成。 */ }
          }
        }); } catch (error) { sourceUnavailable = true; throw error; }
        return resolved;
      });
    }
    try { return await pendingProvider; }
    catch (error) { if (!provider) pendingProvider = undefined; throw error; }
  };
  const hooks = new ProjectBaselineHooks({ checkPath: options.checkPath, provider: {
    captureFresh: async (signal) => (await resolveProvider()).captureFresh(signal),
    assertCurrent: async (snapshot, signal) => (await resolveProvider()).assertCurrent(snapshot, signal),
    get assertUnmanaged() {
      if (!provider?.assertUnmanaged) return undefined;
      return async (signal?: AbortSignal) => {
        const current = await resolveProvider();
        if (!current.assertUnmanaged) throw new ProjectBaselineError("unavailable");
        await current.assertUnmanaged(signal);
      };
    },
    subscribeInvalidation(listener) { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; },
  }, disposeProvider: async () => {
    sourceClosed = true;
    unsubscribeSource?.();
    sourceListeners.clear();
    try { await pendingProvider; } catch { /* 捕获失败已经撤权；仍清理迟到返回的 source。 */ }
    if (provider) await options.disposeProvider?.(provider);
    provider = undefined;
  } });
  instance = hooks;
  pi.on("session_start", (_event, ctx) => { lastContext = ctx; hooks.bindContext(ctx); });
  pi.on("context", async (event, ctx) => {
    lastContext = ctx;
    staleNotified = false;
    // 在撤销旧 request 之前核对其 executionHead，覆盖 read 返回后、通知尚未送达的变化。
    // 已认可的精确自写由 gate 推进 head，不被当作外部变化；后台未结束时不等待其队列。
    if (previousRequest?.kind === "managed") {
      if (hooks.gate.diagnostics.stale || hooks.gate.diagnostics.mutations) oldContext = true;
      else {
        try { await hooks.gate.validateRequest(previousRequest); }
        catch { oldContext = true; }
      }
    }
    try {
      hooks.bindContext(ctx);
      const previous = previousRequest;
      const request = await hooks.beginRequest();
      previousRequest = request;
      if (request.origin) {
        const change = oldContext ? "external_or_unknown" : previous?.origin && previous.origin.baselineHash !== request.origin.baselineHash ? "verified_own_write" : "fresh";
        const notice = oldContext
          ? "此前消息中的项目资料可能属于旧快照；重新取得执行基线不代表旧推理已刷新。继续分析或修改前，须重新查询受影响的当前文件。"
          : change === "verified_own_write" ? "宿主已核对本批精确写入及完整输入集合；这只确认实际文件结果，不证明旧分析或验证已适用。" : "本次请求已核对当前项目输入；历史消息不自动成为当前事实。";
        return { messages: [...event.messages, { role: "custom" as const, customType: "project-baseline-current", display: true,
          content: `${notice}\n${JSON.stringify({ change, workspaceId: request.origin.workspaceId, baselineHash: request.origin.baselineHash,
            generation: request.origin.generation, observedSequence: request.origin.observedSequence, authorityEpoch: request.origin.authorityEpoch })}`, timestamp: Date.now() }] };
      }
    }
    catch {
      if (hooks.gate.diagnostics.managed) oldContext = true;
      hooks.revoke(); notify(ctx);
      return { messages: [...event.messages, { role: "custom" as const, customType: "project-baseline-stale",
        content: OLD_PROJECT_SNAPSHOT, display: true, timestamp: Date.now() }] };
    }
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    try { await hooks.beforeProviderRequest(); }
    catch { hooks.revoke(); notify(ctx); }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") hooks.messageStart(event.message);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (await hooks.messageEnd(event.message)) return;
    notify(ctx);
    return { message: { ...event.message, content: [...event.message.content, { type: "text" as const, text: OLD_PROJECT_SNAPSHOT }] } };
  });
  pi.on("tool_call", async (event) => {
    if (!["write", "edit", "bash", "pi_company_git_commit"].includes(event.toolName)) return;
    try { await hooks.assertCall(event.toolCallId); }
    catch { return { block: true, reason: OLD_PROJECT_SNAPSHOT }; }
  });
  pi.on("session_shutdown", async () => { lastContext = undefined; await hooks.shutdown(); });
  return hooks;
}
