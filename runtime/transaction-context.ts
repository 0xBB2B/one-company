import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { EventEmitter } from "node:events";

interface TransactionOrigin {
  state: "active" | "invalid" | "finished";
  pendingAsyncIds: Set<number>;
  pendingPromises: Set<Promise<unknown>>;
  callbackRegistration: boolean;
  randomResources: Set<{ ondone?: unknown }>;
}

const storage = new AsyncLocalStorage<TransactionOrigin>();
const resourceOrigins = new Map<number, TransactionOrigin>();
let observingPromise = false;

// 随机字节的同步和异步形式共用资源类型；完成回调在异步调用返回前挂到任务上。
const RANDOM_RESOURCE_TYPE = "RANDOMBYTESREQUEST";

function rejectTransactionSubscription(): void {
  const origin = storage.getStore();
  if (!origin) return;
  origin.callbackRegistration = true;
  throw new Error("数据库事务内不能注册延迟事件回调");
}

// 既有 emitter/target 注册监听不会产生 async_hooks init；在注册入口拒绝，避免留下后台写回调。
const guardedRegistrations = new Map<Function, Function>();
for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"] as const) {
  const original = EventEmitter.prototype[name];
  let guarded = guardedRegistrations.get(original);
  if (!guarded) {
    guarded = function (this: EventEmitter, ...args: unknown[]) {
      rejectTransactionSubscription();
      return Reflect.apply(original, this, args);
    };
    guardedRegistrations.set(original, guarded);
  }
  Object.defineProperty(EventEmitter.prototype, name, {
    ...Object.getOwnPropertyDescriptor(EventEmitter.prototype, name), value: guarded,
  });
}
const originalAddEventListener = EventTarget.prototype.addEventListener;
Object.defineProperty(EventTarget.prototype, "addEventListener", {
  ...Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener"),
  value: function (this: EventTarget, ...args: unknown[]) {
    rejectTransactionSubscription();
    return Reflect.apply(originalAddEventListener, this, args);
  },
});

function observePromise(promise: Promise<unknown>): void {
  if (observingPromise) return;
  observingPromise = true;
  try {
    // 使用原生 then，不读取可能被覆盖的实例属性。处理器只消费
    // 违规事务来源或违规回调返回的原生 Promise 拒绝。
    void Promise.prototype.then.call(promise, () => undefined, () => undefined);
  } catch {
    // async_hooks 回调不能向宿主抛错；非原生 Promise 由事务返回值检查处理。
  } finally {
    observingPromise = false;
  }
}

function releaseResource(asyncId: number): void {
  const origin = resourceOrigins.get(asyncId);
  if (!origin) return;
  resourceOrigins.delete(asyncId);
  origin.pendingAsyncIds.delete(asyncId);
}

function releaseOriginResources(origin: TransactionOrigin): void {
  for (const asyncId of origin.pendingAsyncIds) resourceOrigins.delete(asyncId);
  origin.pendingAsyncIds.clear();
  origin.randomResources.clear();
}

// init 后在当前同步调用内完成 before/after 的资源会先释放，不会被误判为
// 后台任务。事务返回时仍待执行的资源才算违规；同步 randomBytes 单独排除。
createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    if (observingPromise) return;
    const origin = storage.getStore();
    if (!origin) return;
    if (type === RANDOM_RESOURCE_TYPE) {
      if (origin.state === "active") origin.randomResources.add(resource as { ondone?: unknown });
      return;
    }
    if (origin.state === "active") {
      origin.pendingAsyncIds.add(asyncId);
      resourceOrigins.set(asyncId, origin);
      if (type === "PROMISE" && isPromise(resource)) origin.pendingPromises.add(resource);
    } else if (origin.state === "invalid" && type === "PROMISE" && isPromise(resource)) {
      observePromise(resource);
    }
  },
  after: releaseResource,
  destroy: releaseResource,
}).enable();

export function createTransactionOrigin(): TransactionOrigin {
  return { state: "active", pendingAsyncIds: new Set(), pendingPromises: new Set(), callbackRegistration: false, randomResources: new Set() };
}

export function runWithTransactionOrigin<T>(origin: TransactionOrigin, fn: () => T): T {
  return storage.run(origin, fn);
}

export function transactionOriginHasAsyncWork(origin: TransactionOrigin): boolean {
  return origin.callbackRegistration || origin.pendingAsyncIds.size > 0
    || [...origin.randomResources].some((resource) => typeof resource.ondone === "function");
}

export function observeRejectedPromise(promise: Promise<unknown>): void {
  observePromise(promise);
}

export function invalidateTransactionOrigin(origin: TransactionOrigin): void {
  origin.state = "invalid";
  releaseOriginResources(origin);
  for (const promise of origin.pendingPromises) observePromise(promise);
  origin.pendingPromises.clear();
}

export function finishTransactionOrigin(origin: TransactionOrigin): void {
  if (origin.state === "active") origin.state = "finished";
  releaseOriginResources(origin);
  origin.pendingPromises.clear();
}

export function hasInvalidTransactionOrigin(): boolean {
  const origin = storage.getStore();
  return origin !== undefined && origin.state !== "active";
}

export function runOutsideTransactionOrigin<T>(fn: () => T): T {
  return storage.exit(fn);
}
