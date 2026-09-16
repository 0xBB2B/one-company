import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const helperUrl = new URL("./helpers/pm-sdk-quiescence-adapter.mjs", import.meta.url);
const helperSource = readFileSync(helperUrl, "utf8");

/**
 * @typedef {{ onClose: () => void, onError: (error: unknown) => void }} ObserverCallbacks
 * @typedef {{
 *   spawn: (this: unknown, ...args: unknown[]) => unknown,
 *   closeAdmission: () => number,
 *   owned: () => readonly any[],
 *   snapshot: () => any,
 *   assertHealthy: () => void,
 * }} Guard
 * @typedef {(dependencies: {
 *   originalSpawn: (this: unknown, ...args: unknown[]) => unknown,
 *   writeFrame: (frame: Uint8Array) => unknown,
 *   installObserver: (receiver: object, callbacks: ObserverCallbacks) => unknown,
 * }) => Guard} CreateGuard
 * @typedef {{ threw: boolean, value: unknown }} Captured
 */

/** @param {Uint8Array} frame */
function decodeAscii(frame) {
  return Array.from(frame, (byte) => String.fromCharCode(byte)).join("");
}

/** @param {() => unknown} operation @returns {Captured} */
function capture(operation) {
  try {
    return { threw: false, value: operation() };
  } catch (error) {
    return { threw: true, value: error };
  }
}

/** @param {string} source @param {string} label @returns {CreateGuard} */
function loadHelper(source, label) {
  const exportNeedle = "export function createPrototypeSpawnGuard";
  assert.equal(source.split(exportNeedle).length - 1, 1, `${label}: export shape changed`);
  const scriptSource = `"use strict";\n${source.replace(exportNeedle, "function createPrototypeSpawnGuard")}\ncreatePrototypeSpawnGuard;`;
  const result = new Script(scriptSource, {
    filename: `pm-sdk-quiescence-adapter.${label}.mjs`,
  }).runInContext(createContext(Object.create(null)));
  assert.equal(typeof result, "function", `${label}: helper did not load`);
  return /** @type {CreateGuard} */ (result);
}

/** @param {string} source @param {string} before @param {string} after @param {string} label */
function mutateOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label}: mutation anchor must be unique`);
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `${label}: mutation must change source`);
  return mutated;
}

/** @type {{ name: string, run: () => void }[]} */
const tests = [];
/** @param {string} name @param {() => void} run */
function test(name, run) {
  tests.push({ name, run });
}

const baselineCreate = loadHelper(helperSource, "baseline");

assert.doesNotMatch(helperSource, /(?:node:)?child_process|(?:node:)?net|\brequire\s*\(|\bimport\s*\(/u);
assert.doesNotMatch(helperSource, /^\s*import\s/mu);

test("正向路径保留this、参数和帧边界", () => {
  /** @type {unknown[]} */
  let actualArgs = [];
  /** @type {unknown} */
  let actualThis;
  /** @type {Uint8Array[]} */
  const frameObjects = [];
  /** @type {string[]} */
  const frames = [];
  const receiver = { pid: 4312, nested: { mutable: true } };
  const first = { first: true };
  const third = { third: true };

  const guard = baselineCreate({
    originalSpawn(...args) {
      actualThis = this;
      actualArgs = args;
      return 0;
    },
    writeFrame(frame) {
      assert.equal(Object.prototype.toString.call(frame), "[object Uint8Array]");
      frameObjects.push(frame);
      frames.push(decodeAscii(frame));
      return frame.byteLength;
    },
    installObserver(observed) {
      assert.equal(observed, receiver);
      return undefined;
    },
  });

  assert.equal(Object.isFrozen(guard), true);
  assert.equal(guard.spawn.call(receiver, first, undefined, third), 0);
  assert.equal(actualThis, receiver);
  assert.equal(actualArgs.length, 3);
  assert.equal(actualArgs[0], first);
  assert.equal(actualArgs[1], undefined);
  assert.equal(actualArgs[2], third);
  assert.deepEqual(frames, ["R:1\n", "B:1:4312\n"]);
  assert.notEqual(frameObjects[0], frameObjects[1]);
  assert.equal(guard.assertHealthy(), undefined);

  const owned = guard.owned();
  assert.equal(Object.isFrozen(owned), true);
  assert.equal(Object.isFrozen(owned[0]), true);
  assert.equal(owned[0].receiver, receiver);
  assert.equal(owned[0].nativeEntered, true);
  assert.equal(owned[0].nativeReturn.present, true);
  assert.equal(owned[0].nativeReturn.value, 0);
  assert.equal(owned[0].nativeThrow.present, false);
  assert.equal(Object.isFrozen(receiver), false);
  assert.equal(Object.isFrozen(receiver.nested), false);

  const snapshot = guard.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.budget), true);
  assert.equal(snapshot.failed, false);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(snapshot.budget.writes.used, 2);
  assert.equal(snapshot.budget.totalBytes.used, 13);
  assert.equal(guard.closeAdmission(), 0);
  assert.equal(guard.closeAdmission(), 0);
  assert.equal(guard.snapshot().closed, true);
  assert.equal(guard.assertHealthy(), undefined);
});

test("构造依赖只接受own data且不执行getter", () => {
  let getterCalls = 0;
  const dependencies = {};
  for (const name of ["originalSpawn", "writeFrame", "installObserver"]) {
    Object.defineProperty(dependencies, name, {
      get() {
        getterCalls += 1;
        return () => undefined;
      },
    });
  }
  const result = capture(() => baselineCreate(/** @type {any} */ (dependencies)));
  assert.equal(result.threw, true);
  assert.equal(getterCalls, 0);

  const inherited = Object.create({
    originalSpawn() {},
    writeFrame() {},
    installObserver() {},
  });
  assert.equal(capture(() => baselineCreate(inherited)).threw, true);
});

test("观察安装与reserve失败都阻止native且保留未知抛值", () => {
  const installSentinel = { install: true };
  let nativeCalls = 0;
  const installGuard = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {
      throw installSentinel;
    },
  });
  const installResult = capture(() => installGuard.spawn.call({ pid: 1 }));
  assert.equal(installResult.threw, true);
  assert.equal(installResult.value, installSentinel);
  assert.equal(nativeCalls, 0);
  assert.equal(installGuard.snapshot().firstError.value, installSentinel);
  assert.equal(installGuard.snapshot().inFlight, 0);

  const invalidInstall = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {
      return null;
    },
  });
  assert.equal(capture(() => invalidInstall.spawn.call({ pid: 2 })).threw, true);
  assert.equal(nativeCalls, 0);

  const writeSentinel = false;
  const throwWrite = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame() {
      throw writeSentinel;
    },
    installObserver() {},
  });
  const writeResult = capture(() => throwWrite.spawn.call({ pid: 3 }));
  assert.equal(writeResult.threw, true);
  assert.equal(Object.is(writeResult.value, writeSentinel), true);
  assert.equal(nativeCalls, 0);

  let thenCalls = 0;
  const invalidWriteResult = {};
  Object.defineProperty(invalidWriteResult, "then", {
    get() {
      thenCalls += 1;
      return () => undefined;
    },
  });
  const promiseWrite = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame() {
      return invalidWriteResult;
    },
    installObserver() {},
  });
  assert.equal(capture(() => promiseWrite.spawn.call({ pid: 4 })).threw, true);
  assert.equal(thenCalls, 0);
  assert.equal(nativeCalls, 0);
});

test("所有falsy native throw原样传播并有存在位", () => {
  for (const thrown of [undefined, null, false, 0, "", Number.NaN]) {
    const receiver = { pid: 9 };
    const guard = baselineCreate({
      originalSpawn() {
        throw thrown;
      },
      writeFrame(frame) {
        return frame.byteLength;
      },
      installObserver() {},
    });
    const result = capture(() => guard.spawn.call(receiver));
    assert.equal(result.threw, true);
    assert.equal(Object.is(result.value, thrown), true);
    const slot = guard.owned()[0];
    assert.equal(slot.receiver, receiver);
    assert.equal(slot.nativeThrow.present, true);
    assert.equal(Object.is(slot.nativeThrow.value, thrown), true);
    assert.equal(slot.nativeReturn.present, false);
    assert.equal(guard.snapshot().firstError.present, true);
    assert.equal(Object.is(guard.snapshot().firstError.value, thrown), true);
    assert.equal(guard.snapshot().inFlight, 0);
    assert.equal(capture(() => guard.assertHealthy()).threw, true);
  }
});

test("所有falsy native返回原样交还", () => {
  for (const nativeResult of [undefined, null, false, 0, "", Number.NaN]) {
    /** @type {string[]} */
    const frames = [];
    const guard = baselineCreate({
      originalSpawn() {
        return nativeResult;
      },
      writeFrame(frame) {
        frames.push(decodeAscii(frame));
        return frame.byteLength;
      },
      installObserver() {},
    });
    const result = capture(() => guard.spawn.call({ pid: 10 }));
    assert.equal(result.threw, false);
    assert.equal(Object.is(result.value, nativeResult), true);
    assert.equal(guard.owned()[0].nativeReturn.present, true);
    assert.equal(Object.is(guard.owned()[0].nativeReturn.value, nativeResult), true);
    if (Object.is(nativeResult, 0)) {
      assert.deepEqual(frames, ["R:1\n", "B:1:10\n"]);
      assert.equal(guard.assertHealthy(), undefined);
    } else {
      assert.deepEqual(frames, ["R:1\n"]);
      assert.equal(capture(() => guard.assertHealthy()).threw, true);
    }
  }
});

test("未知native结果不读取pid getter、then或valueOf且不伪造not-created", () => {
  /** @type {{ label: string, result: unknown, receiver: object, getterCount?: () => number, thenCount?: () => number, valueOfCount?: () => number }[]} */
  const cases = [];
  cases.push({ label: "nonzero", result: 7, receiver: { pid: 11 } });
  cases.push({ label: "missing-pid", result: 0, receiver: {} });

  let pidGetterCalls = 0;
  const accessorReceiver = {};
  Object.defineProperty(accessorReceiver, "pid", {
    get() {
      pidGetterCalls += 1;
      return 12;
    },
  });
  cases.push({ label: "pid-accessor", result: 0, receiver: accessorReceiver, getterCount: () => pidGetterCalls });

  let thenCalls = 0;
  const promise = Promise.resolve(0);
  Object.defineProperty(promise, "then", {
    configurable: true,
    get() {
      thenCalls += 1;
      return Promise.prototype.then;
    },
  });
  cases.push({ label: "promise", result: promise, receiver: { pid: 13 }, thenCount: () => thenCalls });

  let valueOfCalls = 0;
  const coercibleResult = {};
  Object.defineProperty(coercibleResult, "valueOf", {
    get() {
      valueOfCalls += 1;
      return () => 0;
    },
  });
  cases.push({ label: "valueOf", result: coercibleResult, receiver: { pid: 14 }, valueOfCount: () => valueOfCalls });

  for (const item of cases) {
    /** @type {string[]} */
    const frames = [];
    const guard = baselineCreate({
      originalSpawn() {
        return item.result;
      },
      writeFrame(frame) {
        frames.push(decodeAscii(frame));
        return frame.byteLength;
      },
      installObserver() {},
    });
    const actual = guard.spawn.call(item.receiver);
    assert.equal(actual, item.result, item.label);
    assert.deepEqual(frames, ["R:1\n"], item.label);
    assert.equal(capture(() => guard.assertHealthy()).threw, true, item.label);
    assert.equal(guard.owned()[0].nativeReturn.value, item.result, item.label);
    assert.equal(item.getterCount?.() ?? 0, 0, item.label);
    assert.equal(item.thenCount?.() ?? 0, 0, item.label);
    assert.equal(item.valueOfCount?.() ?? 0, 0, item.label);
  }
});

test("bound失败不替换native结果且保留receiver和nativeOutcome", () => {
  const boundSentinel = { bound: true };
  /** @type {string[]} */
  const frames = [];
  const receiver = { pid: 21 };
  const guard = baselineCreate({
    originalSpawn() {
      return 0;
    },
    writeFrame(frame) {
      const text = decodeAscii(frame);
      frames.push(text);
      if (text.startsWith("B:")) {
        throw boundSentinel;
      }
      return frame.byteLength;
    },
    installObserver() {},
  });

  const result = capture(() => guard.spawn.call(receiver));
  assert.equal(result.threw, false);
  assert.equal(result.value, 0);
  assert.deepEqual(frames, ["R:1\n", "B:1:21\n"]);
  assert.equal(guard.owned()[0].receiver, receiver);
  assert.equal(guard.owned()[0].nativeReturn.value, 0);
  assert.equal(guard.owned()[0].boundWritten, false);
  assert.equal(guard.snapshot().firstError.value, boundSentinel);
  assert.equal(capture(() => guard.assertHealthy()).threw, true);
});

test("观察先错与native后抛分别保留", () => {
  const observationError = { observation: true };
  const nativeError = "native-error";
  /** @type {ObserverCallbacks | null} */
  let callbacks = null;
  const guard = baselineCreate({
    originalSpawn() {
      callbacks?.onError(observationError);
      throw nativeError;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver(_receiver, installed) {
      callbacks = installed;
    },
  });

  const result = capture(() => guard.spawn.call({ pid: 22 }));
  assert.equal(result.threw, true);
  assert.equal(result.value, nativeError);
  assert.equal(guard.snapshot().firstError.value, observationError);
  assert.equal(guard.owned()[0].nativeThrow.value, nativeError);
  assert.equal(guard.snapshot().inFlight, 0);
});

test("观察回调不向事件栈抛并处理迟到、提前与重复close", () => {
  /** @type {ObserverCallbacks | null} */
  let callbacks = null;
  const receiver = { pid: 30 };
  const guard = baselineCreate({
    originalSpawn() {
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver(_receiver, installed) {
      callbacks = installed;
    },
  });
  assert.equal(guard.spawn.call(receiver), 0);
  assert.ok(callbacks);
  assert.equal(capture(() => callbacks?.onClose()).threw, false);
  assert.equal(guard.assertHealthy(), undefined);
  assert.equal(capture(() => callbacks?.onClose()).threw, false);
  assert.equal(capture(() => guard.assertHealthy()).threw, true);

  const lateError = { late: true };
  assert.equal(capture(() => callbacks?.onError(lateError)).threw, false);
  assert.notEqual(guard.snapshot().firstError.value, lateError);

  let nativeCalls = 0;
  const preNative = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver(_observed, installed) {
      const callbackResult = capture(() => installed.onClose());
      assert.equal(callbackResult.threw, false);
    },
  });
  assert.equal(capture(() => preNative.spawn.call({ pid: 31 })).threw, true);
  assert.equal(nativeCalls, 0);

  /** @type {Guard | null} */
  let closingGuard = null;
  const preNativeAdmissionClose = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {
      assert.equal(closingGuard?.closeAdmission(), 1);
    },
  });
  closingGuard = preNativeAdmissionClose;
  assert.equal(capture(() => preNativeAdmissionClose.spawn.call({ pid: 32 })).threw, true);
  assert.equal(preNativeAdmissionClose.snapshot().closed, true);
  assert.equal(preNativeAdmissionClose.snapshot().failed, true);
  assert.equal(nativeCalls, 0);
});

test("观察安装后和reserve写后都复查吞掉的重入", () => {
  for (const phase of ["observer", "reserve"]) {
    /** @type {Guard | null} */
    let guard = null;
    let nativeCalls = 0;
    let reentered = false;
    guard = baselineCreate({
      originalSpawn() {
        nativeCalls += 1;
        return 0;
      },
      writeFrame(frame) {
        if (phase === "reserve" && !reentered) {
          reentered = true;
          capture(() => guard?.spawn.call({ pid: 42 }));
        }
        return frame.byteLength;
      },
      installObserver() {
        if (phase === "observer" && !reentered) {
          reentered = true;
          capture(() => guard?.spawn.call({ pid: 41 }));
        }
      },
    });

    assert.equal(capture(() => guard?.spawn.call({ pid: 40 })).threw, true, phase);
    assert.equal(nativeCalls, 0, phase);
    assert.equal(guard.snapshot().failed, true, phase);
    assert.equal(guard.snapshot().inFlight, 0, phase);
  }
});

test("native内部关门允许当前结果与bound但拒绝新创建", () => {
  /** @type {Guard | null} */
  let guard = null;
  /** @type {string[]} */
  const frames = [];
  guard = baselineCreate({
    originalSpawn() {
      assert.equal(guard?.closeAdmission(), 1);
      return 0;
    },
    writeFrame(frame) {
      frames.push(decodeAscii(frame));
      return frame.byteLength;
    },
    installObserver() {},
  });

  assert.equal(guard.spawn.call({ pid: 50 }), 0);
  assert.deepEqual(frames, ["R:1\n", "B:1:50\n"]);
  assert.equal(guard.assertHealthy(), undefined);
  assert.equal(capture(() => guard?.spawn.call({ pid: 51 })).threw, true);
  assert.equal(guard.snapshot().failed, true);
});

test("native内部重入不可撤销当前结果但最终不健康", () => {
  /** @type {Guard | null} */
  let guard = null;
  let nativeCalls = 0;
  /** @type {string[]} */
  const frames = [];
  guard = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      capture(() => guard?.spawn.call({ pid: 61 }));
      return 0;
    },
    writeFrame(frame) {
      frames.push(decodeAscii(frame));
      return frame.byteLength;
    },
    installObserver() {},
  });

  assert.equal(guard.spawn.call({ pid: 60 }), 0);
  assert.equal(nativeCalls, 1);
  assert.deepEqual(frames, ["R:1\n"]);
  assert.equal(guard.snapshot().inFlight, 0);
  assert.equal(capture(() => guard?.assertHealthy()).threw, true);
});

test("重复receiver、无效receiver和第九slot在native前拒绝", () => {
  let nativeCalls = 0;
  const guard = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {},
  });
  const receiver = { pid: 70 };
  assert.equal(guard.spawn.call(receiver), 0);
  assert.equal(capture(() => guard.spawn.call(receiver)).threw, true);
  assert.equal(nativeCalls, 1);

  let invalidNativeCalls = 0;
  const invalidGuard = baselineCreate({
    originalSpawn() {
      invalidNativeCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {},
  });
  assert.equal(capture(() => invalidGuard.spawn.call(null)).threw, true);
  assert.equal(invalidNativeCalls, 0);

  let capacityCalls = 0;
  const capacityGuard = baselineCreate({
    originalSpawn() {
      capacityCalls += 1;
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {},
  });
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(capacityGuard.spawn.call({ pid: Number.MAX_SAFE_INTEGER }), 0);
  }
  assert.equal(capacityGuard.assertHealthy(), undefined);
  assert.equal(capacityGuard.snapshot().budget.slots.limit, 8);
  assert.equal(capacityGuard.snapshot().budget.facts.limit, 32);
  assert.equal(capacityGuard.snapshot().budget.writes.limit, 32);
  assert.equal(capacityGuard.snapshot().budget.frameBytes.limit, 256);
  assert.equal(capacityGuard.snapshot().budget.totalBytes.limit, 8192);
  assert.equal(capacityGuard.snapshot().budget.totalBytes.used, 200);
  assert.equal(capture(() => capacityGuard.spawn.call({ pid: 200 })).threw, true);
  assert.equal(capacityCalls, 8);
  assert.equal(capacityGuard.owned().length, 8);
  assert.equal(capacityGuard.snapshot().budget.slots.overflow, true);
  assert.equal(capacityGuard.snapshot().budget.writes.used, 16);
});

test("普通事实预算耗尽不清除首错、receiver或native结果", () => {
  /** @type {ObserverCallbacks | null} */
  let callbacks = null;
  const firstError = { first: true };
  const receiver = { pid: 81, mutable: true };
  const guard = baselineCreate({
    originalSpawn() {
      return 0;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver(_receiver, installed) {
      callbacks = installed;
    },
  });
  assert.equal(guard.spawn.call(receiver), 0);
  assert.ok(callbacks);
  for (let index = 0; index < 40; index += 1) {
    const error = index === 0 ? firstError : { index };
    assert.equal(capture(() => callbacks?.onError(error)).threw, false);
  }

  const snapshot = guard.snapshot();
  assert.equal(snapshot.failed, true);
  assert.equal(snapshot.budget.facts.used, 32);
  assert.equal(snapshot.budget.facts.limit, 32);
  assert.equal(snapshot.budget.facts.overflow, true);
  assert.equal(snapshot.firstError.value, firstError);
  assert.equal(guard.owned()[0].receiver, receiver);
  assert.equal(guard.owned()[0].nativeReturn.value, 0);
  assert.equal(receiver.mutable, true);
  assert.equal(capture(() => guard.assertHealthy()).threw, true);
});

test("owned和snapshot只冻结壳且不把原返回当句柄", () => {
  const receiver = { child: { mutable: true } };
  const nativeResult = { result: { mutable: true } };
  const guard = baselineCreate({
    originalSpawn() {
      return nativeResult;
    },
    writeFrame(frame) {
      return frame.byteLength;
    },
    installObserver() {},
  });
  assert.equal(guard.spawn.call(receiver), nativeResult);
  const owned = guard.owned();
  const snapshot = guard.snapshot();
  assert.equal(owned[0].receiver, receiver);
  assert.equal(owned[0].nativeReturn.value, nativeResult);
  assert.equal(Object.isFrozen(receiver), false);
  assert.equal(Object.isFrozen(receiver.child), false);
  assert.equal(Object.isFrozen(nativeResult), false);
  assert.equal(Object.isFrozen(nativeResult.result), false);
  assert.equal("kill" in owned[0], false);
  assert.equal(Object.isFrozen(snapshot.firstError), true);
});

/**
 * @param {string} name
 * @param {string} before
 * @param {string} after
 * @param {(create: CreateGuard) => void} invariant
 */
function mutationTest(name, before, after, invariant) {
  test(`变异命中：${name}`, () => {
    invariant(baselineCreate);
    const mutantSource = mutateOnce(helperSource, before, after, name);
    const mutantCreate = loadHelper(mutantSource, `mutant-${name}`);
    const outcome = capture(() => invariant(mutantCreate));
    assert.equal(outcome.threw, true, `${name}: mutant survived invariant`);
    assert.equal(
      outcome.value instanceof assert.AssertionError,
      true,
      `${name}: mutant must be killed by a real assertion, not a load/runtime error`,
    );
  });
}

mutationTest(
  "reserve门槛被省略",
  "      performWrite(`R:${slot.id}\\n`, \"reserve-write\");\n      slot.reserveWritten = true;",
  "      slot.reserveWritten = true;",
  (create) => {
    let nativeCalls = 0;
    const guard = create({
      originalSpawn() {
        nativeCalls += 1;
        return 0;
      },
      writeFrame(frame) {
        return frame.byteLength - 1;
      },
      installObserver() {},
    });
    const outcome = capture(() => guard.spawn.call({ pid: 901 }));
    assert.equal(outcome.threw, true);
    assert.equal(nativeCalls, 0);
  },
);

mutationTest(
  "bound异常替换native结果",
  "          } catch (error) {\n            // Bound reporting is diagnostic; the native result remains primary.\n          }",
  "          } catch (error) {\n            throw error;\n          }",
  (create) => {
    const sentinel = { bound: true };
    const guard = create({
      originalSpawn() {
        return 0;
      },
      writeFrame(frame) {
        if (decodeAscii(frame).startsWith("B:")) {
          throw sentinel;
        }
        return frame.byteLength;
      },
      installObserver() {},
    });
    const outcome = capture(() => guard.spawn.call({ pid: 902 }));
    assert.equal(outcome.threw, false);
    assert.equal(outcome.value, 0);
  },
);

mutationTest(
  "falsy native throw被吞",
  "        latchFailure(error, \"native-throw\");\n        throw error;\n      }\n\n      slot.nativeReturnPresent = true;",
  "        latchFailure(error, \"native-throw\");\n        if (error) throw error;\n      }\n\n      slot.nativeReturnPresent = true;",
  (create) => {
    const guard = create({
      originalSpawn() {
        throw false;
      },
      writeFrame(frame) {
        return frame.byteLength;
      },
      installObserver() {},
    });
    const outcome = capture(() => guard.spawn.call({ pid: 903 }));
    assert.equal(outcome.threw, true);
    assert.equal(Object.is(outcome.value, false), true);
  },
);

mutationTest(
  "吞掉重入后漏复查",
  "  function requirePreNativeOpen(stage) {\n    if (failed) {\n      throw makeGuardError();\n    }\n    if (closed) {\n      throw latchGuardFailure(stage);\n    }\n  }",
  "  function requirePreNativeOpen(_stage) {\n    return;\n  }",
  (create) => {
    /** @type {Guard | null} */
    let guard = null;
    let nativeCalls = 0;
    guard = create({
      originalSpawn() {
        nativeCalls += 1;
        return 0;
      },
      writeFrame(frame) {
        return frame.byteLength;
      },
      installObserver() {
        capture(() => guard?.spawn.call({ pid: 905 }));
      },
    });
    const outcome = capture(() => guard?.spawn.call({ pid: 904 }));
    assert.equal(outcome.threw, true);
    assert.equal(nativeCalls, 0);
  },
);

mutationTest(
  "把native返回当receiver",
  "        const pid = readPositiveOwnDataPid(receiver);",
  "        const pid = readPositiveOwnDataPid(/** @type {object} */ (result));",
  (create) => {
    /** @type {string[]} */
    const frames = [];
    const guard = create({
      originalSpawn() {
        return 0;
      },
      writeFrame(frame) {
        frames.push(decodeAscii(frame));
        return frame.byteLength;
      },
      installObserver() {},
    });
    const outcome = capture(() => guard.spawn.call({ pid: 906 }));
    assert.equal(outcome.threw, false);
    assert.deepEqual(frames, ["R:1\n", "B:1:906\n"]);
  },
);

mutationTest(
  "预算越界恢复healthy",
  "      factsOverflow = true;\n      latchFailure(makeGuardError(), \"facts-budget\");\n      return false;",
  "      factsOverflow = true;\n      failed = false;\n      return false;",
  (create) => {
    /** @type {ObserverCallbacks | null} */
    let callbacks = null;
    const guard = create({
      originalSpawn() {
        return 0;
      },
      writeFrame(frame) {
        return frame.byteLength;
      },
      installObserver(_receiver, installed) {
        callbacks = installed;
      },
    });
    assert.equal(guard.spawn.call({ pid: 907 }), 0);
    assert.ok(callbacks);
    const installedCallbacks = /** @type {ObserverCallbacks} */ (callbacks);
    for (let index = 0; index < 40; index += 1) {
      installedCallbacks.onError(index === 0 ? "first" : index);
    }
    const health = capture(() => guard.assertHealthy());
    assert.equal(health.threw, true);
    assert.equal(guard.snapshot().budget.facts.overflow, true);
  },
);

let passed = 0;
for (const { name, run } of tests) {
  try {
    run();
    passed += 1;
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
console.log(`ok - ${passed} pm-sdk quiescence adapter VM tests`);
