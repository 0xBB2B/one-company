import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export interface ProjectBaselineFile {
  /** 规范化的工作区相对路径；hash 为实际字节的 SHA-256（小写十六进制）。 */
  readonly path: string;
  readonly hash: string;
}

export interface ProjectBaselineSnapshot {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly branch: string;
  readonly generation: number;
  readonly baselineHash: string;
  /** 消费者已收到的变化/失效通知序号；无通知的查询/对账不递增。 */
  readonly observedSequence: number;
  /** 重连/撤权必须改变此代次；不能仅用索引 generation 代替。 */
  readonly authorityEpoch: string;
  readonly coverage: {
    readonly kind: "allowed-inputs";
    readonly complete: true;
    readonly roots: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly policyHash: string;
  };
  readonly files: readonly ProjectBaselineFile[];
}

export type ProjectBaselineCapture =
  | { readonly kind: "fresh"; readonly snapshot: ProjectBaselineSnapshot }
  | { readonly kind: "unmanaged"; readonly reason: string };

export interface ProjectBaselineInvalidation {
  readonly reason: string;
  readonly observedSequence?: number;
  readonly source?: string;
  readonly path?: string | null;
  readonly eventType?: "change" | "rename" | null;
  readonly requiresFullReconcile?: boolean;
  readonly archiveMetadataOnly?: boolean;
  readonly baselineHash?: string | null;
  readonly repoId?: string;
  readonly workspaceId?: string;
  readonly authorityEpoch?: string;
}

/**
 * 可信适配器：只扫描已授权范围，按路径先排除 prod，不向内核提供正文。
 * assertCurrent 必须重新核对权限、身份、全部允许输入（含新增/删除）、实际字节及已观察事件；
 * 不能仅比较缓存或 mtime。已管理现场故障必须抛错，不能返回 unmanaged。
 * 事件必须来自可信宿主、按序完整投递；每条 watch/汇总/失效通知递增一次消费者序号，
 * 丢失/合并发 overflow，capture 返回前排空对应通知。查询次数不能填补通知缺口。
 * assertCurrent 不换绑 snapshot，也不将自身无内容变化的对账标记当作文件事件。
 */
export interface ProjectBaselineProvider {
  captureFresh(signal?: AbortSignal): Promise<ProjectBaselineCapture>;
  assertCurrent(snapshot: ProjectBaselineSnapshot, signal?: AbortSignal): Promise<void>;
  /** 无扫描授权时只核对管理元数据；已初始化或状态不明必须拒绝，不升级旧请求。 */
  assertUnmanaged?(signal?: AbortSignal): Promise<void>;
  subscribeInvalidation(listener: (event: ProjectBaselineInvalidation) => void): () => void;
}

export interface RequestBaseline {
  readonly requestId: string;
  readonly kind: "managed" | "unmanaged";
  readonly origin: ProjectBaselineSnapshot | null;
}

type ProjectBaselineSealSource =
  | { readonly callId: string; readonly messageId?: never }
  | { readonly messageId: string; readonly callId?: never };

export type ProjectBaselineSealMetadata = {
  readonly format: "project-baseline-seal/v1";
  readonly requestId: string;
  readonly origin: ProjectBaselineSnapshot;
  readonly executionHead: ProjectBaselineSnapshot;
} & ProjectBaselineSealSource;

declare const sealBrand: unique symbol;
/** 只有签发 gate 持有的对象身份有效；JSON/对象拷贝不具有交付能力。 */
export interface ProjectBaselineSeal {
  readonly metadata: ProjectBaselineSealMetadata;
  readonly [sealBrand]: true;
}

export type ProjectBaselineMutation = {
  readonly paths: readonly string[];
  /** null 表示删除；省略 expectedWrites 表示 Shell 等未知输出操作。 */
  readonly expectedWrites?: readonly { readonly path: string; readonly hash: string | null }[];
  /** 可信宿主在文件队列内经 lstat 确认缺失的目标父目录；不接受模型声明。 */
  readonly expectedDirectories?: readonly string[];
};

export interface RequestBaselineGateOptions {
  readonly maxCalls?: number;
  readonly maxSeals?: number;
  readonly maxPending?: number;
  readonly maxFiles?: number;
}

export class ProjectBaselineError extends Error {
  readonly code: "stale" | "unavailable" | "invalid_input" | "resource_limit" | "busy" | "invalid_seal" | "unmanaged";
  constructor(code: ProjectBaselineError["code"], message = code) {
    super(message);
    this.code = code;
    this.name = "ProjectBaselineError";
  }
}

function fail(code: ProjectBaselineError["code"]): never { throw new ProjectBaselineError(code); }
const HASH = /^[0-9a-f]{64}$/u;
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function relativePath(value: unknown, root = false): value is string {
  return text(value) && (root && value === "." || !isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}
const under = (path: string, root: string) => root === "." || path === root || path.startsWith(`${root}/`);
const prod = (path: string) => under(path.toLowerCase(), "docs/prod");
function allowed(path: string, snapshot: ProjectBaselineSnapshot): boolean {
  return relativePath(path) && !prod(path) && snapshot.coverage.roots.some((root) => under(path, root))
    && !snapshot.coverage.excludedPaths.some((root) => under(path, root));
}
function snapshotCopy(value: ProjectBaselineSnapshot, maxFiles: number): ProjectBaselineSnapshot {
  if (!value || !text(value.repoId) || !text(value.workspaceId) || !text(value.root) || !isAbsolute(value.root)
    || !text(value.branch) || !text(value.authorityEpoch) || !HASH.test(value.baselineHash)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.observedSequence) || value.observedSequence < 0
    || !value.coverage || value.coverage.kind !== "allowed-inputs" || value.coverage.complete !== true
    || !HASH.test(value.coverage.policyHash) || !Array.isArray(value.coverage.roots)
    || !value.coverage.roots.length || value.coverage.roots.length > 256
    || !Array.isArray(value.coverage.excludedPaths) || value.coverage.excludedPaths.length > 256
    || !value.coverage.roots.every((path) => relativePath(path, true) && !prod(path))
    || !value.coverage.excludedPaths.every((path) => relativePath(path))
    || !value.coverage.excludedPaths.some((path) => path.toLowerCase() === "docs/prod")
    || !Array.isArray(value.files) || value.files.length > maxFiles) fail("invalid_input");
  const seen = new Set<string>();
  const files = value.files.map((file) => {
    if (!file || !allowed(file.path, value) || !HASH.test(file.hash) || seen.has(file.path)) fail("invalid_input");
    seen.add(file.path);
    return Object.freeze({ path: file.path, hash: file.hash });
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({ repoId: value.repoId, workspaceId: value.workspaceId, root: value.root, branch: value.branch,
    generation: value.generation, baselineHash: value.baselineHash, observedSequence: value.observedSequence,
    authorityEpoch: value.authorityEpoch, coverage: Object.freeze({ kind: "allowed-inputs" as const, complete: true as const,
      roots: Object.freeze([...value.coverage.roots].sort()), excludedPaths: Object.freeze([...value.coverage.excludedPaths].sort()),
      policyHash: value.coverage.policyHash }), files: Object.freeze(files) });
}
function sameAuthority(a: ProjectBaselineSnapshot, b: ProjectBaselineSnapshot): boolean {
  return a.repoId === b.repoId && a.workspaceId === b.workspaceId && a.root === b.root && a.branch === b.branch
    && a.authorityEpoch === b.authorityEpoch && JSON.stringify(a.coverage) === JSON.stringify(b.coverage);
}

interface State {
  readonly request: RequestBaseline;
  readonly controller: AbortController;
  head: ProjectBaselineSnapshot | null;
  stale: boolean;
  pendingMutations: number;
}

interface MutationObservation {
  readonly state: State;
  readonly previous: ProjectBaselineSnapshot;
  readonly writes: ReadonlyMap<string, string | null>;
  readonly directories: ReadonlySet<string>;
  sequence: number;
  watchCount: number;
  reconciledHash?: string;
}

/**
 * 每个宿主会话独占一份。请求/工具绑定只能由可信宿主传入，不是模型可调用的 API。
 * 此门槛不替代写入范围保护、沙箱或正式检查锁。operation 必须等实际写入及子进程结束才返回；
 * 内核不能发现调用方故意遗留的后台写入，也不能原子锁住外部编辑器。
 */
export class RequestBaselineGate {
  readonly #provider: ProjectBaselineProvider;
  readonly #limits: Required<RequestBaselineGateOptions>;
  #unsubscribe: (() => void) | undefined;
  #closed = false;
  #everManaged = false;
  #revision = 0;
  #current: State | undefined;
  #captureController: AbortController | undefined;
  #pending = 0;
  #serial: Promise<void> = Promise.resolve();
  #mutations = 0;
  #observation: MutationObservation | undefined;
  // 已见 ID 不复用；达到上限拒绝并要求可信宿主结束会话，不淘汰旧 ID 重新授权。
  readonly #seenCalls = new Set<string>();
  readonly #calls = new Map<string, State>();
  readonly #usedCalls = new Set<string>();
  readonly #seals = new Map<ProjectBaselineSeal, State>();
  #issuedSeals = 0;

  constructor(provider: ProjectBaselineProvider, options: RequestBaselineGateOptions = {}) {
    this.#provider = provider;
    this.#limits = { maxCalls: options.maxCalls ?? 4096, maxSeals: options.maxSeals ?? 4096,
      maxPending: options.maxPending ?? 64, maxFiles: options.maxFiles ?? 50000 };
    for (const value of Object.values(this.#limits)) if (!Number.isSafeInteger(value) || value < 1) fail("invalid_input");
    this.#unsubscribe = provider.subscribeInvalidation((event) => this.#onInvalidation(event));
  }

  #onInvalidation(event: ProjectBaselineInvalidation): void {
    const observation = this.#observation;
    if (observation && this.#current === observation.state && !observation.state.stale) {
      const previous = observation.previous;
      const sequence = event.observedSequence;
      const identityMatches = event.repoId === previous.repoId && event.workspaceId === previous.workspaceId
        && event.authorityEpoch === previous.authorityEpoch && event.archiveMetadataOnly === false;
      if (identityMatches && Number.isSafeInteger(sequence)) {
        if (event.reason === "watch" && event.source === "watch" && event.requiresFullReconcile === false
          && (event.eventType === "change" || event.eventType === "rename") && typeof event.path === "string"
          && sequence === observation.sequence + 1 && observation.watchCount < this.#limits.maxFiles * 8) {
          // 未计划字节变化的目标若出现事件，不能把 A→B→A 解释为本次写入。
          const original = previous.files.find((file) => file.path === event.path)?.hash ?? null;
          const fileWrite = observation.writes.has(event.path) && observation.writes.get(event.path) !== original;
          const directoryCreate = event.eventType === "rename" && observation.directories.has(event.path);
          if (fileWrite || directoryCreate) {
            observation.sequence = sequence;
            observation.watchCount++;
            observation.reconciledHash = undefined;
            this.#seals.clear();
            return;
          }
        }
        // 汇总是已观察内容的发布通知，不是新写入授权；只能接在合法目标 watch 之后。
        if (event.reason === "reconciled_change" && event.path === null && event.eventType === null
          && event.requiresFullReconcile === true && typeof event.baselineHash === "string" && HASH.test(event.baselineHash)
          && observation.watchCount > 0 && (event.source === "watch" || event.source === "read_before")
          && sequence === observation.sequence + 1) {
          observation.sequence = sequence!;
          observation.reconciledHash = event.baselineHash;
          this.#seals.clear();
          return;
        }
      }
    }
    this.invalidate(event.reason, event);
  }

  invalidate(_reason: string, _event?: ProjectBaselineInvalidation): void {
    this.#observation = undefined;
    this.#revision++;
    if (this.#current) { this.#current.stale = true; this.#current.controller.abort(); }
    this.#captureController?.abort();
    this.#calls.clear();
    this.#usedCalls.clear();
    this.#seals.clear();
  }

  #live(state: State): void {
    if (this.#closed || this.#current !== state || state.stale || state.controller.signal.aborted) fail("stale");
  }

  #state(request: RequestBaseline): State {
    const state = this.#current;
    if (!state || state.request !== request) fail("stale");
    this.#live(state);
    return state;
  }

  #call(callId: string): State {
    const state = this.#calls.get(callId);
    if (!state) fail("stale");
    this.#live(state);
    return state;
  }

  #observeManaged(): void {
    this.#everManaged = true;
    if (this.#current?.request.kind === "unmanaged") this.invalidate("managed_capture_observed");
  }

  async beginRequest(): Promise<RequestBaseline> {
    this.invalidate("new_request");
    this.#current = undefined;
    if (this.#closed) fail("stale");
    if (this.#pending >= this.#limits.maxPending) fail("resource_limit");
    const revision = this.#revision;
    const controller = new AbortController();
    this.#captureController = controller;
    this.#pending++;
    try {
      const captured = await this.#provider.captureFresh(controller.signal);
      // 即使旧 capture 迟到，已管理事实也不能被后续 unmanaged 擦除。
      if (captured.kind === "fresh") this.#observeManaged();
      if (captured.kind !== "fresh" && captured.kind !== "unmanaged") fail("invalid_input");
      if (this.#closed || revision !== this.#revision || controller.signal.aborted) fail("stale");
      if (captured.kind === "unmanaged" && (this.#everManaged || !text(captured.reason))) fail("unavailable");
      const origin = captured.kind === "fresh" ? snapshotCopy(captured.snapshot, this.#limits.maxFiles) : null;
      const request: RequestBaseline = Object.freeze({ requestId: randomUUID(), kind: origin ? "managed" : "unmanaged", origin });
      this.#current = { request, controller, head: origin, stale: false, pendingMutations: 0 };
      return request;
    } catch (error) {
      if (revision === this.#revision) this.invalidate("capture_failed");
      throw error instanceof ProjectBaselineError ? error : new ProjectBaselineError("unavailable");
    } finally {
      this.#pending--;
      if (this.#captureController === controller) this.#captureController = undefined;
    }
  }

  async #assert(state: State, snapshot = state.head): Promise<void> {
    this.#live(state);
    try {
      if (snapshot) await this.#provider.assertCurrent(snapshot, state.controller.signal);
      else if (this.#provider.assertUnmanaged) await this.#provider.assertUnmanaged(state.controller.signal);
      else {
        const captured = await this.#provider.captureFresh(state.controller.signal);
        if (captured.kind === "fresh") this.#observeManaged();
        if (captured.kind !== "unmanaged" || this.#everManaged || !text(captured.reason)) fail("stale");
      }
    } catch { if (this.#current === state) this.invalidate("assert_failed"); fail("stale"); }
    this.#live(state);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new ProjectBaselineError("stale"));
    if (this.#pending >= this.#limits.maxPending) return Promise.reject(new ProjectBaselineError("resource_limit"));
    this.#pending++;
    const result = this.#serial.then(operation);
    this.#serial = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.#pending--; });
  }

  validateRequest(request: RequestBaseline): Promise<void> {
    const state = this.#state(request);
    return this.#enqueue(() => this.#assert(state));
  }

  /** request 参数必填：迟到 assistant 消息不能借“当前请求”换绑。 */
  bindCalls(callIds: readonly string[], request: RequestBaseline): void {
    const state = this.#state(request);
    if (!Array.isArray(callIds) || callIds.length > this.#limits.maxCalls || !callIds.every(text) || new Set(callIds).size !== callIds.length
      || callIds.some((id) => this.#seenCalls.has(id))) fail("invalid_input");
    if (this.#seenCalls.size + callIds.length > this.#limits.maxCalls) fail("resource_limit");
    for (const id of callIds) { this.#seenCalls.add(id); this.#calls.set(id, state); }
  }

  withMutation<T>(callId: string, mutation: ProjectBaselineMutation, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const state = this.#call(callId);
    const before = state.head;
    if (!mutation || !Array.isArray(mutation.paths) || mutation.paths.length > this.#limits.maxFiles
      || !mutation.paths.every((path) => relativePath(path) && !prod(path) && (!before || allowed(path, before)))
      || new Set(mutation.paths).size !== mutation.paths.length) fail("invalid_input");
    const paths = new Set(mutation.paths);
    const writes = mutation.expectedWrites === undefined ? undefined : new Map<string, string | null>();
    if (writes) {
      if (!Array.isArray(mutation.expectedWrites) || mutation.expectedWrites.length !== paths.size) fail("invalid_input");
      for (const write of mutation.expectedWrites) {
        if (!write || !paths.has(write.path) || writes.has(write.path) || (write.hash !== null && !HASH.test(write.hash))) fail("invalid_input");
        writes.set(write.path, write.hash);
      }
    }
    const directories = new Set<string>();
    if (mutation.expectedDirectories !== undefined) {
      if (!writes || !Array.isArray(mutation.expectedDirectories) || mutation.expectedDirectories.length > this.#limits.maxFiles) fail("invalid_input");
      for (const directory of mutation.expectedDirectories) {
        if (!relativePath(directory) || prod(directory) || (before && !allowed(directory, before)) || directories.has(directory)
          || !mutation.paths.some((path) => path.startsWith(`${directory}/`))) fail("invalid_input");
        directories.add(directory);
      }
    }
    const validDirectories = (snapshot: ProjectBaselineSnapshot | null) => {
      if (!directories.size) return true;
      const files = new Map(snapshot?.files.map((file) => [file.path, file.hash]));
      const changedParents = new Set<string>();
      for (const [path, hash] of writes!) {
        if (hash === null || hash === (files.get(path) ?? null)) continue;
        for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
          const parent = path.slice(0, slash);
          if (directories.has(parent)) changedParents.add(parent);
        }
      }
      return [...directories].every((directory) => !files.has(directory) && changedParents.has(directory));
    };
    if (!validDirectories(before)) fail("invalid_input");
    if (this.#usedCalls.has(callId)) fail("stale");
    this.#usedCalls.add(callId);
    state.pendingMutations++;
    this.#mutations++;
    return this.#enqueue(async () => {
      await this.#assert(state);
      const previous = state.head;
      this.#live(state);
      if (!validDirectories(previous)) fail("invalid_input");
      const observation: MutationObservation | undefined = previous && writes ? {
        state, previous, writes, directories, sequence: previous.observedSequence, watchCount: 0,
      } : undefined;
      this.#observation = observation;
      let result: T;
      try { result = await operation(state.controller.signal); }
      catch (error) { if (this.#current === state) this.invalidate("operation_failed"); throw error; }
      // 命令已运行的真实结果必须保留；当前性核对失败只废止后续能力。
      try {
        this.#live(state);
        if (previous && writes) {
          const captured = await this.#provider.captureFresh(state.controller.signal);
          this.#live(state);
          if (captured.kind !== "fresh") fail("unavailable");
          const next = snapshotCopy(captured.snapshot, this.#limits.maxFiles);
          if (!sameAuthority(previous, next) || next.generation < previous.generation
            || next.observedSequence !== observation!.sequence
            || (observation!.reconciledHash !== undefined && observation!.reconciledHash !== next.baselineHash)) fail("stale");
          const expected = new Map(previous.files.map((file) => [file.path, file.hash]));
          for (const [path, hash] of writes) { if (hash === null) expected.delete(path); else expected.set(path, hash); }
          if (next.files.length !== expected.size || next.files.some((file) => expected.get(file.path) !== file.hash)) fail("stale");
          await this.#assert(state, next);
          if (next.observedSequence !== observation!.sequence) fail("stale");
          state.head = next;
          this.#seals.clear();
        } else await this.#assert(state);
      } catch { if (this.#current === state) this.invalidate("post_mutation_changed"); }
      finally { if (this.#observation === observation) this.#observation = undefined; }
      return result;
    }).finally(() => { state.pendingMutations--; this.#mutations--; });
  }

  sealResult(callId: string): Promise<ProjectBaselineSeal> {
    return this.#seal(this.#call(callId), { callId });
  }

  /** 可信 SDK 核对实际已完成 assistant 消息与原请求的关联，并提供 messageId；不向模型开放。 */
  sealMessage(request: RequestBaseline, messageId: string): Promise<ProjectBaselineSeal> {
    const state = this.#state(request);
    if (!text(messageId)) fail("invalid_input");
    return this.#seal(state, { messageId });
  }

  #seal(state: State, source: ProjectBaselineSealSource): Promise<ProjectBaselineSeal> {
    if (this.#mutations || state.pendingMutations) fail("busy");
    return this.#enqueue(async () => {
      if (this.#mutations || state.pendingMutations) fail("busy");
      await this.#assert(state);
      if (this.#mutations || state.pendingMutations) fail("busy");
      if (!state.head || !state.request.origin) fail("unmanaged");
      if (this.#issuedSeals >= this.#limits.maxSeals) fail("resource_limit");
      const metadata: ProjectBaselineSealMetadata = Object.freeze({ format: "project-baseline-seal/v1", requestId: state.request.requestId,
        ...source, origin: state.request.origin, executionHead: state.head });
      const seal = Object.freeze({ metadata }) as ProjectBaselineSeal;
      this.#seals.set(seal, state);
      this.#issuedSeals++;
      return seal;
    });
  }

  assertDelivery(seal: ProjectBaselineSeal): Promise<ProjectBaselineSealMetadata> {
    const state = this.#seals.get(seal);
    if (!state) fail("invalid_seal");
    if (this.#mutations) fail("busy");
    return this.#enqueue(async () => {
      if (this.#seals.get(seal) !== state || state.head !== seal.metadata.executionHead) fail("invalid_seal");
      if (this.#mutations) fail("busy");
      await this.#assert(state, seal.metadata.executionHead);
      if (this.#mutations || this.#seals.get(seal) !== state) fail("invalid_seal");
      return seal.metadata;
    });
  }

  /** 无正文资源计数，供宿主诊断；达到总量上限不会悄悄复用旧 ID/seal。 */
  get diagnostics() {
    return Object.freeze({ closed: this.#closed, managed: this.#everManaged, stale: !this.#current || this.#current.stale,
      requests: this.#current ? 1 : 0, calls: this.#calls.size, seenCalls: this.#seenCalls.size,
      seals: this.#seals.size, issuedSeals: this.#issuedSeals, pending: this.#pending, mutations: this.#mutations });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.invalidate("closed");
    this.#current = undefined;
    this.#seenCalls.clear();
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    unsubscribe?.();
  }

  dispose(): void { this.close(); }
}
