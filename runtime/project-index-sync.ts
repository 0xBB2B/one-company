import { AsyncLocalStorage } from "node:async_hooks";
import { watch as nodeWatch } from "node:fs";
import type { FSWatcher, WatchEventType } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { IndexState } from "./index-store.ts";
import { classifyIndexWatchEvent } from "./project-index-policy.ts";
import {
  ProjectIndexService,
  ProjectIndexServiceError,
} from "./project-index-service.ts";
import type { ProjectIndexBuildResult } from "./project-index-service.ts";

const DEFAULT_DEBOUNCE_MS = 75;
const DEFAULT_LOW_FREQUENCY_MS = 30_000;
const DEFAULT_MAX_QUEUED_EVENTS = 512;
const DEFAULT_MAX_WATCHERS = 512;
const DEFAULT_MAX_RECONCILE_PASSES = 3;
const DEFAULT_MAX_SUBSCRIBERS = 32;

type Timer = ReturnType<typeof setTimeout>;

export type ProjectIndexSyncAction = "start" | "stop" | "reconnect" | "reconcile" | "ensureFresh" | "status" | "subscribe" | "latestBuildResult";
export type ProjectIndexSyncPhase = "before" | "return";
export type ProjectIndexSyncReason =
  | "start"
  | "reconnect"
  | "watch"
  | "archive_metadata"
  | "watcher_failure"
  | "overflow"
  | "low_frequency"
  | "manual"
  | "read_before";

export interface ProjectIndexSyncAuthorizationRequest {
  action: ProjectIndexSyncAction;
  phase: ProjectIndexSyncPhase;
  workspaceId: string;
  repoId: string;
  eventSequence: number;
}

export type ProjectIndexSyncAuthorize = (request: Readonly<ProjectIndexSyncAuthorizationRequest>) => boolean;

export interface ProjectIndexBaselineChange {
  workspaceId: string;
  repoId: string;
  eventSequence: number;
  reason: "watch" | "archive_metadata" | "watcher_failure" | "overflow" | "reconciled_change";
  /** 导致本次事件或内容对账的入口。 */
  source: ProjectIndexSyncReason;
  path: string | null;
  eventType: WatchEventType | null;
  archiveMetadataOnly: boolean;
  /** 合并/溢出或实际整体baseline变化后，订阅者必须丢弃局部假设并全量复核。 */
  requiresFullReconcile: boolean;
  baselineHash: string | null;
}

export interface ProjectIndexArchiveRiskEvent {
  workspaceId: string;
  repoId: string;
  eventSequence: number;
  path: string | null;
  eventType: WatchEventType | null;
  overflowed: boolean;
}

export interface ProjectIndexSyncSubscriber {
  id: string;
  authorize(event: Readonly<ProjectIndexBaselineChange>): boolean;
  onBaselineChange(event: Readonly<ProjectIndexBaselineChange>): void | Promise<void>;
}

export interface ProjectIndexWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): this;
}

export type ProjectIndexWatchFactory = (
  path: string,
  listener: (eventType: WatchEventType, fileName: string | Buffer | null) => void,
) => ProjectIndexWatcher;

export interface ProjectIndexSyncOptions {
  service: ProjectIndexService;
  authorize?: ProjectIndexSyncAuthorize;
  debounceMs?: number;
  lowFrequencyMs?: number;
  maxQueuedEvents?: number;
  maxWatchers?: number;
  maxReconcilePasses?: number;
  maxSubscribers?: number;
  watchFactory?: ProjectIndexWatchFactory;
  beforeArchiveRisk?: (event: Readonly<ProjectIndexArchiveRiskEvent>) => void | Promise<void>;
}

export type ProjectIndexSyncState = "stopped" | "stopping" | "dirty" | "reconciling" | "fresh" | "unstable" | "error";

export interface ProjectIndexSyncStatus {
  workspaceId: string;
  repoId: string;
  state: ProjectIndexSyncState;
  started: boolean;
  dirty: boolean;
  eventSequence: number;
  reconciledSequence: number;
  generation: number;
  baselineHash: string | null;
  indexState: IndexState | null;
  queuedEvents: number;
  pendingNotifications: number;
  activeCallbacks: number;
  overflowed: boolean;
  watchers: number;
  watchHealthy: boolean;
  lastReason: ProjectIndexSyncReason | null;
  lastError: { code: "authorization_denied" | "archive_risk_failed" | "index_failure" | "watcher_limit" } | null;
}

export class ProjectIndexSyncError extends Error {
  readonly code: "authorization_denied" | "invalid_options" | "subscriber_limit" | "invalid_subscriber" | "operation_in_progress";

  constructor(code: ProjectIndexSyncError["code"]) {
    const messages: Record<ProjectIndexSyncError["code"], string> = {
      authorization_denied: "项目索引同步操作未获授权",
      invalid_options: "项目索引同步选项无效",
      subscriber_limit: "项目索引同步订阅者超过上限",
      invalid_subscriber: "项目索引同步订阅者无效",
      operation_in_progress: "项目索引同步正在停止，结束后才能启动",
    };
    super(messages[code]);
    this.name = "ProjectIndexSyncError";
    this.code = code;
  }
}

interface QueuedEvent {
  sequence: number;
  reason: ProjectIndexSyncReason;
  path: string | null;
  eventType: WatchEventType | null;
}

interface WatchDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

interface WatchRegistration {
  watcher: ProjectIndexWatcher;
  relativePath: string;
  archive: boolean;
  actualPath: string;
  chain: WatchDirectoryIdentity[];
}

interface SubscriberState {
  subscriber: ProjectIndexSyncSubscriber;
  registration: object;
  pending: ProjectIndexBaselineChange | null;
  running: boolean;
  active: boolean;
}

function integerOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new ProjectIndexSyncError("invalid_options");
  return selected;
}

function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function watchFactory(path: string, listener: (eventType: WatchEventType, fileName: string | Buffer | null) => void): FSWatcher {
  return nodeWatch(path, { persistent: false, encoding: "utf8" }, listener);
}

function safeFileName(value: string | Buffer | null): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/u.test(part))) return null;
  return parts.join("/");
}

/**
 * 单workspace同步内核。daemon应复用一个实例，并把authorize/订阅回调绑定到可信调用上下文。
 */
export class ProjectIndexSyncManager {
  private readonly service: ProjectIndexService;
  private readonly authorize: ProjectIndexSyncAuthorize;
  private readonly debounceMs: number;
  private readonly lowFrequencyMs: number;
  private readonly maxQueuedEvents: number;
  private readonly maxWatchers: number;
  private readonly maxReconcilePasses: number;
  private readonly maxSubscribers: number;
  private readonly makeWatcher: ProjectIndexWatchFactory;
  private readonly beforeArchiveRisk?: ProjectIndexSyncOptions["beforeArchiveRisk"];
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly watchers = new Map<string, WatchRegistration>();
  private readonly failedWatcherKeys = new Set<string>();
  private readonly callbackContext = new AsyncLocalStorage<object>();
  private readonly activeCallbacks = new Map<object, Promise<void>>();
  private queue: QueuedEvent[] = [];
  private archiveQueue: QueuedEvent[] = [];
  private eventSequence = 0;
  private reconciledSequence = 0;
  private generation = 0;
  private indexState: IndexState | null = null;
  private state: ProjectIndexSyncState = "stopped";
  private started = false;
  private stopping = false;
  private stopOperation: Promise<ProjectIndexSyncStatus> | null = null;
  private lifecycleSequence = 0;
  private archiveRiskBlocked = false;
  private dirty = false;
  private overflowed = false;
  private archiveOverflowed = false;
  private archiveBaseline: Set<string> | null = null;
  private baselineInitialized = false;
  private baselineNeedsNotification = false;
  private baselineHash: string | null = null;
  private latestBuild: ProjectIndexBuildResult | null = null;
  private deliveryEnabled = false;
  private watchHealthy = true;
  private lastReason: ProjectIndexSyncReason | null = null;
  private lastError: ProjectIndexSyncStatus["lastError"] = null;
  private debounceTimer: Timer | null = null;
  private lowFrequencyTimer: Timer | null = null;
  private serial: Promise<void> = Promise.resolve();
  private backgroundReconcile: Promise<void> | null = null;
  private invalidationRequested = false;
  private invalidation: Promise<void> | null = null;

  constructor(options: ProjectIndexSyncOptions) {
    if (!options || !(options.service instanceof ProjectIndexService)) throw new ProjectIndexSyncError("invalid_options");
    this.service = options.service;
    this.authorize = options.authorize ?? (() => false);
    this.debounceMs = integerOption(options.debounceMs, DEFAULT_DEBOUNCE_MS, 0, 2_000);
    this.lowFrequencyMs = integerOption(options.lowFrequencyMs, DEFAULT_LOW_FREQUENCY_MS, 100, 3_600_000);
    this.maxQueuedEvents = integerOption(options.maxQueuedEvents, DEFAULT_MAX_QUEUED_EVENTS, 1, 4_096);
    this.maxWatchers = integerOption(options.maxWatchers, DEFAULT_MAX_WATCHERS, 1, 4_096);
    this.maxReconcilePasses = integerOption(options.maxReconcilePasses, DEFAULT_MAX_RECONCILE_PASSES, 1, 8);
    this.maxSubscribers = integerOption(options.maxSubscribers, DEFAULT_MAX_SUBSCRIBERS, 1, 128);
    this.makeWatcher = options.watchFactory ?? watchFactory;
    this.beforeArchiveRisk = options.beforeArchiveRisk;
  }

  private authorizeAt(action: ProjectIndexSyncAction, phase: ProjectIndexSyncPhase): void {
    let allowed = false;
    try {
      allowed = this.authorize(Object.freeze({
        action,
        phase,
        workspaceId: this.service.workspace.workspaceId,
        repoId: this.service.workspace.repoId,
        eventSequence: this.eventSequence,
      })) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ProjectIndexSyncError("authorization_denied");
  }

  private result(): ProjectIndexSyncStatus {
    return {
      workspaceId: this.service.workspace.workspaceId,
      repoId: this.service.workspace.repoId,
      state: this.state,
      started: this.started,
      dirty: this.dirty,
      eventSequence: this.eventSequence,
      reconciledSequence: this.reconciledSequence,
      generation: this.generation,
      baselineHash: this.baselineHash,
      indexState: this.indexState,
      queuedEvents: this.queue.length + this.archiveQueue.length,
      pendingNotifications: [...this.subscribers.values()].filter((state) => state.pending !== null).length,
      activeCallbacks: this.activeCallbacks.size,
      overflowed: this.overflowed || this.archiveOverflowed,
      watchers: this.watchers.size,
      watchHealthy: this.watchHealthy,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  status(): ProjectIndexSyncStatus {
    const sequence = this.eventSequence;
    this.authorizeAt("status", "before");
    const result = this.result();
    this.authorizeAt("status", "return");
    if (sequence !== this.eventSequence) return { ...this.result(), state: "unstable", dirty: true };
    return result;
  }

  latestBuildResult(): ProjectIndexBuildResult | null {
    const sequence = this.eventSequence;
    this.authorizeAt("latestBuildResult", "before");
    const result = this.state === "fresh" && !this.dirty && this.latestBuild?.baselineHash === this.baselineHash
      ? structuredClone(this.latestBuild)
      : null;
    this.authorizeAt("latestBuildResult", "return");
    if (sequence !== this.eventSequence || this.state !== "fresh" || this.dirty) return null;
    return result;
  }

  subscribe(subscriber: ProjectIndexSyncSubscriber): () => void {
    this.authorizeAt("subscribe", "before");
    if (!subscriber || typeof subscriber.id !== "string" || !/^[\p{L}\p{N}._:@+-]{1,128}$/u.test(subscriber.id)
      || typeof subscriber.authorize !== "function" || typeof subscriber.onBaselineChange !== "function") {
      throw new ProjectIndexSyncError("invalid_subscriber");
    }
    if (!this.subscribers.has(subscriber.id) && this.subscribers.size >= this.maxSubscribers) throw new ProjectIndexSyncError("subscriber_limit");
    const previous = this.subscribers.get(subscriber.id);
    const registration = Object.freeze({});
    const previousValues = previous ? { subscriber: previous.subscriber, registration: previous.registration, pending: previous.pending, active: previous.active } : null;
    const state: SubscriberState = previous ?? { subscriber, registration, pending: null, running: false, active: true };
    state.active = true;
    state.subscriber = subscriber;
    state.registration = registration;
    state.pending = null;
    this.subscribers.set(subscriber.id, state);
    try { this.authorizeAt("subscribe", "return"); }
    catch (error) {
      if (previous && previousValues) {
        previous.subscriber = previousValues.subscriber;
        previous.registration = previousValues.registration;
        previous.pending = previousValues.pending;
        previous.active = previousValues.active;
      } else this.subscribers.delete(subscriber.id);
      throw error;
    }
    return () => {
      if (this.subscribers.get(subscriber.id) !== state || state.registration !== registration) return;
      state.pending = null;
      state.active = false;
      // 已开始回调仍占用槽位，同ID重新注册会复用它，不会新增第二个在途回调。
      if (!state.running) this.subscribers.delete(subscriber.id);
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private queueBackgroundReconcile(): Promise<void> {
    if (this.backgroundReconcile) return this.backgroundReconcile;
    const operation = this.enqueue(async () => { await this.reconcileLoop(); });
    this.backgroundReconcile = operation;
    const clear = () => { if (this.backgroundReconcile === operation) this.backgroundReconcile = null; };
    void operation.then(clear, clear);
    return operation;
  }

  private requestPersistentDirty(): void {
    this.invalidationRequested = true;
    if (this.invalidation) return;
    this.invalidation = (async () => {
      while (this.invalidationRequested) {
        this.invalidationRequested = false;
        await this.service.markDirty();
      }
    })().catch(() => {
      this.lastError = { code: "index_failure" };
      this.state = "error";
      this.dirty = true;
      throw new ProjectIndexServiceError("index_failure", "sync-invalidate", true);
    }).finally(() => { this.invalidation = null; });
    void this.invalidation.catch(() => undefined);
  }

  private mergedNotification(previous: ProjectIndexBaselineChange, next: ProjectIndexBaselineChange): ProjectIndexBaselineChange {
    return {
      workspaceId: next.workspaceId,
      repoId: next.repoId,
      eventSequence: Math.max(previous.eventSequence, next.eventSequence),
      reason: "overflow",
      source: next.source,
      path: null,
      eventType: null,
      archiveMetadataOnly: false,
      requiresFullReconcile: true,
      baselineHash: next.baselineHash ?? previous.baselineHash,
    };
  }

  private deliver(event: ProjectIndexBaselineChange): void {
    if (!this.deliveryEnabled || this.stopping) return;
    for (const state of this.subscribers.values()) {
      if (!state.active) continue;
      state.pending = state.pending ? this.mergedNotification(state.pending, event) : Object.freeze({ ...event });
      this.scheduleSubscriber(state);
    }
  }

  private archiveRiskPending(): boolean {
    return this.archiveRiskBlocked || this.archiveQueue.length > 0 || this.archiveOverflowed;
  }

  private scheduleSubscriber(state: SubscriberState): void {
    if (state.running || !state.active || this.archiveRiskPending()) return;
    state.running = true;
    queueMicrotask(() => { void this.drainSubscriber(state).catch(() => undefined); });
  }

  private async drainSubscriber(state: SubscriberState): Promise<void> {
    try {
      while (state.pending) {
        if (!state.active || !this.deliveryEnabled || this.stopping || this.subscribers.get(state.subscriber.id) !== state) {
          state.pending = null;
          return;
        }
        if (this.archiveRiskPending()) return;
        const registration = state.registration;
        const event = state.pending;
        state.pending = null;
        let allowed = false;
        // 权限核验紧邻实际回调，排队时的旧授权和已取消订阅都不能放行。
        try {
          allowed = this.subscribers.get(state.subscriber.id) === state
            && state.subscriber.authorize(Object.freeze({ ...event })) === true;
        } catch {
          allowed = false;
        }
        if (!allowed || !state.active || state.registration !== registration || !this.deliveryEnabled || this.stopping
          || this.archiveRiskPending() || this.subscribers.get(state.subscriber.id) !== state) continue;
        const token = Object.freeze({});
        const callback = this.callbackContext.run(token, async () => {
          try { await state.subscriber.onBaselineChange(Object.freeze({ ...event })); }
          catch { /* 通知失败不恢复旧baseline；后续事件仍按合并失效通知处理。 */ }
        });
        this.activeCallbacks.set(token, callback);
        try { await callback; }
        finally { this.activeCallbacks.delete(token); }
      }
    } finally {
      state.running = false;
      if (!state.active && this.subscribers.get(state.subscriber.id) === state) this.subscribers.delete(state.subscriber.id);
      if (state.active && state.pending && this.deliveryEnabled && !this.stopping && this.subscribers.get(state.subscriber.id) === state) {
        this.scheduleSubscriber(state);
      }
    }
  }

  private observe(reason: ProjectIndexSyncReason, path: string | null, eventType: WatchEventType | null, archive: boolean, notify: boolean): void {
    if (!Number.isSafeInteger(this.eventSequence + 1)) {
      this.overflowed = true;
      this.eventSequence = Number.MAX_SAFE_INTEGER;
    } else {
      this.eventSequence += 1;
    }
    const event: QueuedEvent = { sequence: this.eventSequence, reason, path, eventType };
    this.dirty = true;
    this.state = "dirty";
    this.lastReason = reason;
    this.lastError = null;
    if (this.queue.length < this.maxQueuedEvents) this.queue.push(event);
    else {
      this.queue = [];
      this.overflowed = true;
      reason = "overflow";
      this.lastReason = reason;
    }
    if (archive) {
      if (this.archiveQueue.length < this.maxQueuedEvents) this.archiveQueue.push(event);
      else {
        this.archiveQueue = [];
        this.archiveOverflowed = true;
      }
    }
    this.requestPersistentDirty();
    if (notify) {
      this.deliver({
        workspaceId: this.service.workspace.workspaceId,
        repoId: this.service.workspace.repoId,
        eventSequence: this.eventSequence,
        reason: this.overflowed ? "overflow" : reason as ProjectIndexBaselineChange["reason"],
        source: reason,
        path: this.overflowed ? null : path,
        eventType,
        archiveMetadataOnly: archive,
        requiresFullReconcile: this.overflowed,
        baselineHash: null,
      });
    }
    if (this.started && !this.stopping) this.scheduleDebouncedReconcile();
  }

  private scheduleDebouncedReconcile(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.started || this.stopping) return;
      void this.queueBackgroundReconcile().catch(() => undefined);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private scheduleLowFrequency(): void {
    if (this.lowFrequencyTimer) clearTimeout(this.lowFrequencyTimer);
    if (!this.started || this.stopping) return;
    this.lowFrequencyTimer = setTimeout(() => {
      this.lowFrequencyTimer = null;
      if (!this.started || this.stopping) return;
      this.observe("low_frequency", null, null, false, false);
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
      void this.queueBackgroundReconcile().finally(() => this.scheduleLowFrequency()).catch(() => undefined);
    }, this.lowFrequencyMs);
    this.lowFrequencyTimer.unref?.();
  }

  private handleWatchEvent(directory: string, archiveDirectory: boolean, eventType: WatchEventType, rawName: string | Buffer | null): void {
    if (!this.started || this.stopping) return;
    const name = safeFileName(rawName);
    let path = name === null ? null : directory === "." ? name : `${directory}/${name}`;
    let archive = archiveDirectory;
    if (path !== null) {
      try {
        const classification = classifyIndexWatchEvent(path);
        if (classification === "ignored") return;
        archive ||= classification === "archive_metadata";
      } catch {
        path = null;
      }
    }
    this.observe(archive ? "archive_metadata" : "watch", path, eventType, archive, true);
  }

  private watchFailed(key: string): void {
    const registration = this.watchers.get(key);
    if (registration) {
      try { registration.watcher.close(); } catch { /* watcher已不可用。 */ }
      this.watchers.delete(key);
    }
    this.watchHealthy = false;
    if (!this.failedWatcherKeys.has(key)) {
      this.failedWatcherKeys.add(key);
      this.observe("watcher_failure", null, null, false, true);
    }
  }

  private async checkedWatchPath(relativePath: string): Promise<{ actualPath: string; chain: WatchDirectoryIdentity[] }> {
    const parts = relativePath === "." ? [] : relativePath.split("/");
    const chain: WatchDirectoryIdentity[] = [];
    let current = this.service.workspace.root;
    for (const part of [null, ...parts] as Array<string | null>) {
      if (part !== null) current = join(current, part);
      const before = await lstat(current);
      const actual = await realpath(current);
      const after = await lstat(current);
      if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino || actual !== current || !contained(this.service.workspace.root, actual)) {
        throw new Error("unsafe watch directory");
      }
      chain.push({ path: actual, device: after.dev, inode: after.ino });
    }
    return { actualPath: current, chain };
  }

  private sameWatchChain(left: WatchDirectoryIdentity[], right: WatchDirectoryIdentity[]): boolean {
    return left.length === right.length && left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && entry.path === other.path && entry.device === other.device && entry.inode === other.inode;
    });
  }

  private canInstallWatchers(sequence: number): boolean {
    return this.started && !this.stopping && sequence === this.lifecycleSequence;
  }

  private async installWatchPlan(result: ProjectIndexBuildResult): Promise<boolean> {
    const sequence = this.lifecycleSequence;
    if (!this.canInstallWatchers(sequence)) return false;
    const desired = new Map<string, { relativePath: string; archive: boolean }>();
    for (const relativePath of result.watchPlan.directories) desired.set(`index:${relativePath}`, { relativePath, archive: false });
    for (const relativePath of result.watchPlan.archiveDirectories) desired.set(`archive:${relativePath}`, { relativePath, archive: true });
    const ordered = [...desired.entries()].sort(([left], [right]) => left.localeCompare(right));
    this.watchHealthy = ordered.length <= this.maxWatchers;
    if (ordered.length > this.maxWatchers) {
      this.lastError = { code: "watcher_limit" };
      this.overflowed = true;
    }
    const selected = new Map(ordered.slice(0, this.maxWatchers));
    let changed = selected.size !== this.watchers.size || [...selected.keys()].some((key) => !this.watchers.has(key));
    for (const [key, value] of selected) {
      try {
        const checked = await this.checkedWatchPath(value.relativePath);
        if (!this.canInstallWatchers(sequence)) return false;
        const existing = this.watchers.get(key);
        if (existing && existing.relativePath === value.relativePath && existing.archive === value.archive
          && existing.actualPath === checked.actualPath && this.sameWatchChain(existing.chain, checked.chain)) {
          this.failedWatcherKeys.delete(key);
          continue;
        }
        if (existing) {
          try { existing.watcher.close(); } catch { /* 同路径inode已失效，继续注册新watcher。 */ }
          this.watchers.delete(key);
          changed = true;
        }
        const watcher = this.makeWatcher(checked.actualPath, (eventType, fileName) => this.handleWatchEvent(value.relativePath, value.archive, eventType, fileName));
        if (!this.canInstallWatchers(sequence)) {
          watcher.close();
          return false;
        }
        const registration: WatchRegistration = {
          watcher,
          relativePath: value.relativePath,
          archive: value.archive,
          actualPath: checked.actualPath,
          chain: checked.chain,
        };
        this.watchers.set(key, registration);
        watcher.on("error", () => {
          if (this.watchers.get(key) === registration) this.watchFailed(key);
        });
        if (!this.canInstallWatchers(sequence)) {
          watcher.close();
          if (this.watchers.get(key) === registration) this.watchers.delete(key);
          return false;
        }
        this.failedWatcherKeys.delete(key);
      } catch {
        const existing = this.watchers.get(key);
        if (existing) {
          try { existing.watcher.close(); } catch { /* 不保留无法重新核验的watcher。 */ }
          this.watchers.delete(key);
        }
        changed = true;
        this.watchHealthy = false;
        this.watchFailed(key);
      }
    }
    for (const [key, registration] of [...this.watchers]) {
      if (selected.has(key)) continue;
      try { registration.watcher.close(); } catch { /* 关闭后由低频对账兜底。 */ }
      this.watchers.delete(key);
      this.failedWatcherKeys.delete(key);
      changed = true;
    }
    return changed;
  }

  private async processArchiveRisk(targetSequence: number): Promise<void> {
    this.archiveRiskBlocked = true;
    const pending = this.archiveQueue.filter((event) => event.sequence <= targetSequence);
    let currentBaseline = this.archiveBaseline;
    if (this.beforeArchiveRisk) {
      // preview沿用M2扫描策略，只枚举归档目录项名称；生命周期hook必须在常规refresh及正文解析前执行。
      const preview = await this.service.preview();
      currentBaseline = new Set([
        ...preview.archives.metadata.map((entry) => entry.path),
        ...preview.archives.issues.map((entry) => entry.path).filter((path): path is string => path !== null),
      ]);
      const discovered = new Set<string>();
      if (this.archiveBaseline === null) {
        for (const path of currentBaseline) discovered.add(path);
      } else {
        for (const path of currentBaseline) if (!this.archiveBaseline.has(path)) discovered.add(path);
        for (const path of this.archiveBaseline) if (!currentBaseline.has(path)) discovered.add(path);
      }
      const events = new Map<string, QueuedEvent>();
      for (const path of discovered) events.set(`path:${path}`, { sequence: targetSequence, reason: "archive_metadata", path, eventType: null });
      for (const event of pending) events.set(event.path === null ? `unknown:${event.sequence}` : `path:${event.path}`, event);
      if (this.archiveOverflowed) events.set("overflow", { sequence: targetSequence, reason: "overflow", path: null, eventType: null });
      for (const event of events.values()) {
        await this.beforeArchiveRisk(Object.freeze({
          workspaceId: this.service.workspace.workspaceId,
          repoId: this.service.workspace.repoId,
          eventSequence: event.sequence,
          path: event.path,
          eventType: event.eventType,
          overflowed: event.reason === "overflow" || this.archiveOverflowed,
        }));
      }
    }
    this.archiveBaseline = currentBaseline;
    this.archiveQueue = this.archiveQueue.filter((event) => event.sequence > targetSequence);
    if (this.eventSequence === targetSequence) this.archiveOverflowed = false;
    this.archiveRiskBlocked = false;
    if (!this.archiveRiskPending()) {
      for (const state of this.subscribers.values()) if (state.pending) this.scheduleSubscriber(state);
    }
  }

  private async reconcileLoop(): Promise<ProjectIndexSyncStatus> {
    const lifecycleSequence = this.lifecycleSequence;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (!this.baselineInitialized) {
      const existing = await this.service.status();
      this.baselineHash = existing.index?.baselineHash ?? null;
      this.baselineNeedsNotification = existing.index !== null && existing.index.baselineHash === null;
      this.generation = existing.index?.currentGeneration ?? 0;
      this.indexState = existing.index?.status ?? null;
      this.baselineInitialized = true;
    }
    for (let pass = 0; pass < this.maxReconcilePasses; pass++) {
      if (this.stopping || lifecycleSequence !== this.lifecycleSequence) break;
      const targetSequence = this.eventSequence;
      const reconcileSource = this.lastReason ?? "manual";
      this.state = "reconciling";
      try {
        if (this.invalidation) await this.invalidation;
        await this.processArchiveRisk(targetSequence);
        if (this.stopping || lifecycleSequence !== this.lifecycleSequence) break;
        const built = await this.service.refresh();
        if (this.stopping || lifecycleSequence !== this.lifecycleSequence) break;
        if (built.status === "cancelled") {
          this.dirty = true;
          this.state = this.stopping ? "stopped" : "unstable";
          return this.result();
        }
        this.generation = built.generation;
        this.indexState = built.status;
        const watcherPlanChanged = await this.installWatchPlan(built);
        if (this.stopping || lifecycleSequence !== this.lifecycleSequence) break;
        if (watcherPlanChanged) {
          this.dirty = true;
          await this.service.markDirty();
          continue;
        }
        if (!this.watchHealthy) {
          this.dirty = true;
          this.state = "unstable";
          await this.service.markDirty();
          return this.result();
        }
        if (targetSequence !== this.eventSequence) continue;
        const changed = this.baselineNeedsNotification || (this.baselineHash !== null && built.baselineHash !== this.baselineHash);
        this.baselineHash = built.baselineHash;
        this.baselineNeedsNotification = false;
        this.latestBuild = structuredClone(built);
        this.reconciledSequence = targetSequence;
        this.dirty = false;
        this.state = "fresh";
        this.queue = [];
        this.overflowed = false;
        if (this.lastError?.code !== "watcher_limit") this.lastError = null;
        if (changed) {
          this.deliver({
            workspaceId: this.service.workspace.workspaceId,
            repoId: this.service.workspace.repoId,
            eventSequence: targetSequence,
            reason: "reconciled_change",
            source: reconcileSource,
            path: null,
            eventType: null,
            archiveMetadataOnly: false,
            requiresFullReconcile: true,
            baselineHash: built.baselineHash,
          });
        }
        return this.result();
      } catch (error) {
        this.dirty = true;
        if (error instanceof ProjectIndexSyncError && error.code === "authorization_denied") throw error;
        // 构建期间的新事件会提高IndexStore fence；旧构建失败是预期结果，继续处理更新后的序号。
        if (!this.stopping && targetSequence !== this.eventSequence) continue;
        if (this.beforeArchiveRisk && this.archiveQueue.some((event) => event.sequence <= targetSequence)) {
          this.lastError = { code: "archive_risk_failed" };
        } else {
          this.lastError = { code: "index_failure" };
        }
        this.state = "error";
        try { await this.service.markDirty(); } catch { /* manager仍保持dirty，后续重连/手动对账重试。 */ }
        return this.result();
      }
    }
    if (this.stopping || lifecycleSequence !== this.lifecycleSequence) {
      this.state = "stopped";
      return this.result();
    }
    this.dirty = true;
    this.state = "unstable";
    try { await this.service.markDirty(); } catch { /* 无法持久化时manager状态仍明确dirty。 */ }
    return this.result();
  }

  private async startWith(action: "start" | "reconnect", reason: "start" | "reconnect"): Promise<ProjectIndexSyncStatus> {
    if (this.stopping || this.stopOperation) throw new ProjectIndexSyncError("operation_in_progress");
    const lifecycleSequence = this.lifecycleSequence;
    let cleanup: Promise<ProjectIndexSyncStatus> | undefined;
    try {
      return await this.enqueue(async () => {
        if (this.stopping || lifecycleSequence !== this.lifecycleSequence) throw new ProjectIndexSyncError("operation_in_progress");
        this.authorizeAt(action, "before");
        try {
          this.started = true;
          this.deliveryEnabled = true;
          this.observe(reason, null, null, false, false);
          const result = await this.reconcileLoop();
          if (this.stopping || lifecycleSequence !== this.lifecycleSequence) return this.result();
          this.scheduleLowFrequency();
          const sequence = this.eventSequence;
          this.authorizeAt(action, "return");
          if (sequence !== this.eventSequence || (result.state === "fresh" && result.reconciledSequence !== sequence)) {
            this.dirty = true;
            this.state = "unstable";
          }
          return this.result();
        } catch (error) {
          // 启动未获完整授权时立即撤销后台能力，收尾在退出当前串行操作后等待。
          cleanup = this.requestStop();
          throw error;
        }
      });
    } catch (error) {
      if (cleanup) await cleanup;
      throw error;
    }
  }

  start(): Promise<ProjectIndexSyncStatus> { return this.startWith("start", this.started ? "reconnect" : "start"); }
  reconnect(): Promise<ProjectIndexSyncStatus> { return this.startWith("reconnect", "reconnect"); }

  reconcile(): Promise<ProjectIndexSyncStatus> {
    this.authorizeAt("reconcile", "before");
    this.observe("manual", null, null, false, false);
    return this.enqueue(async () => {
      const result = await this.reconcileLoop();
      const sequence = this.eventSequence;
      this.authorizeAt("reconcile", "return");
      if (sequence !== this.eventSequence || (result.state === "fresh" && result.reconciledSequence !== sequence)) {
        this.dirty = true;
        this.state = "unstable";
      }
      return this.result();
    });
  }

  ensureFresh(): Promise<ProjectIndexSyncStatus> {
    this.authorizeAt("ensureFresh", "before");
    this.observe("read_before", null, null, false, false);
    return this.enqueue(async () => {
      const result = await this.reconcileLoop();
      const sequence = this.eventSequence;
      this.authorizeAt("ensureFresh", "return");
      if (result.state === "fresh" && (sequence !== this.eventSequence || result.reconciledSequence !== sequence || result.dirty)) {
        this.dirty = true;
        this.state = "unstable";
        try { await this.service.markDirty(); } catch { /* 返回明确unstable，不把持久化失败说成fresh。 */ }
      }
      return this.result();
    });
  }

  private closeWatchers(): void {
    for (const registration of this.watchers.values()) {
      try { registration.watcher.close(); } catch { /* 继续关闭其余已登记监听器。 */ }
    }
    this.watchers.clear();
  }

  private requestStop(): Promise<ProjectIndexSyncStatus> {
    const callerCallback = this.callbackContext.getStore();
    if (this.stopOperation) {
      // 已开始的回调不能等待正在等待它结束的外部stop；它只收到正在收尾的真实状态。
      return callerCallback ? Promise.resolve(this.result()) : this.stopOperation;
    }
    this.lifecycleSequence += 1;
    this.stopping = true;
    this.state = "stopping";
    this.started = false;
    this.deliveryEnabled = false;
    this.dirty = true;
    for (const state of this.subscribers.values()) state.pending = null;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.lowFrequencyTimer) { clearTimeout(this.lowFrequencyTimer); this.lowFrequencyTimer = null; }
    this.closeWatchers();
    this.service.cancel();
    const operation = (async () => {
      await this.enqueue(async () => {
        if (this.invalidation) await this.invalidation.catch(() => undefined);
        this.closeWatchers();
      });
      const callbacks = [...this.activeCallbacks.entries()]
        .filter(([token]) => token !== callerCallback)
        .map(([, pending]) => pending);
      if (callbacks.length) await Promise.allSettled(callbacks);
      return this.enqueue(async () => {
        this.closeWatchers();
        this.started = false;
        this.state = "stopped";
        this.watchHealthy = true;
        this.failedWatcherKeys.clear();
        return this.result();
      });
    })();
    this.stopOperation = operation;
    const clear = () => {
      if (this.stopOperation === operation) {
        this.stopOperation = null;
        this.stopping = false;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  async stop(): Promise<ProjectIndexSyncStatus> {
    this.authorizeAt("stop", "before");
    const result = await this.requestStop();
    this.authorizeAt("stop", "return");
    return result;
  }
}
