import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { createPrototypeSpawnGuard } from "./helpers/pm-sdk-quiescence-adapter.mjs";
import { createCreatorBridge } from "./helpers/pm-sdk-quiescence-bridge.mjs";

const helperUrl = new URL("./helpers/pm-sdk-quiescence-bridge.mjs", import.meta.url);
const helperSource = readFileSync(helperUrl, "utf8");
const importLine = "import { createPrototypeSpawnGuard } from \"./pm-sdk-quiescence-adapter.mjs\";";

/**
 * @typedef {{ onClose: () => void, onError: (error: unknown) => void }} ObserverCallbacks
 * @typedef {{
 *   spawn: (this: unknown, ...args: unknown[]) => unknown,
 *   closeAdmission: () => number,
 *   flush: () => Readonly<{ status: string }>,
 *   finish: () => Readonly<{ status: string }>,
 *   snapshot: () => any,
 *   assertHealthy: () => void,
 * }} Bridge
 * @typedef {(dependencies: {
 *   originalSpawn: (this: unknown, ...args: unknown[]) => unknown,
 *   installObserver: (receiver: object, callbacks: ObserverCallbacks) => unknown,
 *   writePacket: (packet: Uint8Array) => unknown,
 * }) => Bridge} CreateBridge
 * @typedef {{ threw: boolean, value: unknown }} Captured
 */

/** @param {Uint8Array} packet */
function decodeAscii(packet) {
  return Array.from(packet, (byte) => String.fromCharCode(byte)).join("");
}

/** @param {() => unknown} operation @returns {Captured} */
function capture(operation) {
  try {
    return { threw: false, value: operation() };
  } catch (error) {
    return { threw: true, value: error };
  }
}

/** @param {string} source @param {string} label @returns {CreateBridge} */
function loadBridge(source, label) {
  assert.equal(source.split(importLine).length - 1, 1, `${label}: static import binding changed`);
  const exportNeedle = "export function createCreatorBridge";
  assert.equal(source.split(exportNeedle).length - 1, 1, `${label}: export shape changed`);
  const scriptSource = `"use strict";\n${source
    .replace(importLine, "const createPrototypeSpawnGuard = globalThis.__createPrototypeSpawnGuard;")
    .replace(exportNeedle, "function createCreatorBridge")}\ncreateCreatorBridge;`;
  const context = createContext({
    __createPrototypeSpawnGuard: createPrototypeSpawnGuard,
    Uint8Array,
    Object,
    Number,
    String,
    Error,
    Reflect,
    RegExp,
  });
  const result = new Script(scriptSource, {
    filename: `pm-sdk-quiescence-bridge.${label}.mjs`,
  }).runInContext(context);
  assert.equal(typeof result, "function", `${label}: bridge did not load`);
  return /** @type {CreateBridge} */ (result);
}

/** @param {string} source @param {string} before @param {string} after @param {string} label */
function mutateOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label}: mutation anchor must be unique`);
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `${label}: mutation must change source`);
  return mutated;
}

/**
 * @param {CreateBridge} create
 * @param {{
 *   native?: (this: unknown, ...args: unknown[]) => unknown,
 *   writer?: (packet: Uint8Array, text: string) => unknown,
 * }=} options
 */
function fixture(create, options = {}) {
  /** @type {string[]} */
  const packets = [];
  /** @type {Uint8Array[]} */
  const packetObjects = [];
  /** @type {Map<object, ObserverCallbacks>} */
  const observers = new Map();
  const bridge = create({
    originalSpawn: options.native ?? function () { return 0; },
    installObserver(receiver, callbacks) {
      observers.set(receiver, callbacks);
    },
    writePacket(packet) {
      const text = decodeAscii(packet);
      packets.push(text);
      packetObjects.push(packet);
      return options.writer === undefined
        ? packet.byteLength
        : options.writer(packet, text);
    },
  });
  return { bridge, packets, packetObjects, observers };
}

/** @type {{ name: string, run: () => void }[]} */
const tests = [];
/** @param {string} name @param {() => void} run */
function test(name, run) {
  tests.push({ name, run });
}

const baselineCreate = /** @type {CreateBridge} */ (createCreatorBridge);
assert.equal(typeof loadBridge(helperSource, "baseline-vm"), "function");
assert.doesNotMatch(helperSource, /(?:node:)?(?:fs|net|child_process)|\bimport\s*\(/u);
assert.equal(helperSource.split(/^import\s/gmu).length - 1, 1);
assert.match(helperSource, /import \{ createPrototypeSpawnGuard \} from "\.\/pm-sdk-quiescence-adapter\.mjs";/u);

test("构造依赖只接受own data函数且不执行getter", () => {
  let getterCalls = 0;
  const dependencies = {};
  for (const name of ["originalSpawn", "installObserver", "writePacket"]) {
    Object.defineProperty(dependencies, name, {
      get() {
        getterCalls += 1;
        return () => undefined;
      },
    });
  }
  assert.equal(capture(() => baselineCreate(/** @type {any} */ (dependencies))).threw, true);
  assert.equal(getterCalls, 0);
  const inherited = Object.create({
    originalSpawn() {},
    installObserver() {},
    writePacket() {},
  });
  assert.equal(capture(() => baselineCreate(inherited)).threw, true);
});

test("零槽关门、G和T使用连续wire序号且finish幂等", () => {
  const { bridge, packets } = fixture(baselineCreate);
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(bridge.closeAdmission(), 0);
  assert.deepEqual(bridge.flush(), { status: "ok" });
  assert.deepEqual(packets, ["G:1\n"]);
  assert.deepEqual(bridge.finish(), { status: "finished" });
  assert.deepEqual(bridge.finish(), { status: "finished" });
  assert.deepEqual(packets, ["G:1\n", "T:2\n"]);
  assert.equal(bridge.assertHealthy(), undefined);
});

test("一槽保留this、参数、原返回并完成R/B/C/G/T", () => {
  const receiver = { pid: 4312, nested: { mutable: true } };
  const first = { first: true };
  const third = { third: true };
  /** @type {unknown} */
  let actualThis;
  /** @type {unknown[]} */
  let actualArgs = [];
  const { bridge, packets, packetObjects, observers } = fixture(baselineCreate, {
    native(...args) {
      actualThis = this;
      actualArgs = args;
      return 0;
    },
  });
  assert.equal(bridge.spawn.call(receiver, first, undefined, third), 0);
  assert.equal(actualThis, receiver);
  assert.equal(actualArgs.length, 3);
  assert.equal(actualArgs[0], first);
  assert.equal(actualArgs[1], undefined);
  assert.equal(actualArgs[2], third);
  assert.deepEqual(packets, ["R:1:1\n", "B:2:1:4312\n"]);
  assert.notEqual(packetObjects[0], packetObjects[1]);
  observers.get(receiver)?.onClose();
  assert.equal(bridge.closeAdmission(), 0);
  assert.deepEqual(bridge.flush(), { status: "ok" });
  assert.deepEqual(bridge.finish(), { status: "finished" });
  assert.deepEqual(packets, ["R:1:1\n", "B:2:1:4312\n", "C:3:1\n", "G:4\n", "T:5\n"]);
  assert.equal(Object.isFrozen(receiver), false);
  assert.equal(Object.isFrozen(receiver.nested), false);
});

test("八槽达到正常26包上界且不触达次级预算", () => {
  const { bridge, packets, observers } = fixture(baselineCreate);
  const receivers = [];
  for (let slot = 1; slot <= 8; slot += 1) {
    const receiver = { pid: 1000 + slot };
    receivers.push(receiver);
    assert.equal(bridge.spawn.call(receiver), 0);
  }
  for (const receiver of receivers) {
    observers.get(receiver)?.onClose();
  }
  bridge.closeAdmission();
  assert.equal(bridge.flush().status, "ok");
  assert.equal(bridge.finish().status, "finished");
  assert.equal(packets.length, 26);
  assert.equal(packets[0], "R:1:1\n");
  assert.equal(packets[15], "B:16:8:1008\n");
  assert.equal(packets[24], "G:25\n");
  assert.equal(packets[25], "T:26\n");
  const snapshot = bridge.snapshot();
  assert.equal(snapshot.wireSequence, 26);
  assert.equal(snapshot.budget.packets.limit, 32);
  assert.equal(snapshot.budget.packetBytes.limit, 256);
  assert.equal(snapshot.budget.totalBytes.limit, 8192);
  assert.equal(snapshot.budget.diagnostics.limit, 32);
  assert.equal(snapshot.budget.packets.overflow, false);
  assert.equal(snapshot.budget.packetBytes.overflow, false);
  assert.equal(snapshot.budget.totalBytes.overflow, false);
  assert.equal(snapshot.budget.diagnostics.overflow, false);
  assert.ok(snapshot.bytesRequested < 8192);
});

test("早到close等待B，G可先于迟到C，finish不自动补前置", () => {
  /** @type {Bridge | null} */
  let bridge = null;
  /** @type {ObserverCallbacks | null} */
  let callbacks = null;
  /** @type {string[]} */
  const packets = [];
  bridge = baselineCreate({
    originalSpawn() {
      callbacks?.onClose();
      assert.equal(bridge?.flush().status, "pending");
      return 0;
    },
    installObserver(_receiver, installed) {
      callbacks = installed;
    },
    writePacket(packet) {
      packets.push(decodeAscii(packet));
      return packet.byteLength;
    },
  });
  assert.equal(bridge.spawn.call({ pid: 21 }), 0);
  assert.deepEqual(packets, ["R:1:1\n", "B:2:1:21\n"]);
  bridge.closeAdmission();
  assert.equal(bridge.finish().status, "pending");
  assert.equal(bridge.flush().status, "ok");
  assert.deepEqual(packets, ["R:1:1\n", "B:2:1:21\n", "C:3:1\n", "G:4\n"]);
  assert.equal(bridge.finish().status, "finished");

  const late = fixture(baselineCreate);
  const receiver = { pid: 22 };
  assert.equal(late.bridge.spawn.call(receiver), 0);
  late.bridge.closeAdmission();
  assert.equal(late.bridge.flush().status, "ok");
  assert.deepEqual(late.packets, ["R:1:1\n", "B:2:1:22\n", "G:3\n"]);
  assert.equal(late.bridge.finish().status, "pending");
  late.observers.get(receiver)?.onClose();
  assert.equal(late.bridge.finish().status, "pending");
  assert.equal(late.bridge.flush().status, "ok");
  assert.deepEqual(late.packets, ["R:1:1\n", "B:2:1:22\n", "G:3\n", "C:4:1\n"]);
  assert.equal(late.bridge.finish().status, "finished");
});

test("native内部普通关门仍允许当前B", () => {
  /** @type {Bridge | null} */
  let bridge = null;
  /** @type {string[]} */
  const packets = [];
  bridge = baselineCreate({
    originalSpawn() {
      assert.equal(bridge?.closeAdmission(), 1);
      return 0;
    },
    installObserver() {},
    writePacket(packet) {
      packets.push(decodeAscii(packet));
      return packet.byteLength;
    },
  });
  assert.equal(bridge.spawn.call({ pid: 31 }), 0);
  assert.deepEqual(packets, ["R:1:1\n", "B:2:1:31\n"]);
  assert.equal(bridge.assertHealthy(), undefined);
  assert.equal(bridge.flush().status, "ok");
  assert.equal(packets[2], "G:3\n");
});

test("inFlight优先使已观察到错误的重入flush仍pending", () => {
  /** @type {Bridge | null} */
  let bridge = null;
  /** @type {ObserverCallbacks | null} */
  let callbacks = null;
  bridge = baselineCreate({
    originalSpawn() {
      callbacks?.onError("observed");
      assert.equal(bridge?.flush().status, "pending");
      return 0;
    },
    installObserver(_receiver, installed) {
      callbacks = installed;
    },
    writePacket(packet) {
      return packet.byteLength;
    },
  });
  assert.equal(bridge.spawn.call({ pid: 32 }), 0);
  assert.equal(bridge.flush().status, "failed");
});

test("所有falsy native throw不被finally flush替换", () => {
  for (const thrown of [undefined, null, false, 0, "", Number.NaN]) {
    const { bridge } = fixture(baselineCreate, {
      native() {
        throw thrown;
      },
    });
    const outcome = capture(() => {
      try {
        return bridge.spawn.call({ pid: 41 });
      } finally {
        assert.equal(bridge.flush().status, "failed");
      }
    });
    assert.equal(outcome.threw, true);
    assert.equal(Object.is(outcome.value, thrown), true);
    assert.equal(bridge.snapshot().guard.firstError.present, true);
    assert.equal(Object.is(bridge.snapshot().guard.firstError.value, thrown), true);
  }
});

test("R失败阻止native，B失败保留native结果且均不重试", () => {
  let nativeCalls = 0;
  let rCalls = 0;
  const rSentinel = { reserve: true };
  const reserve = fixture(baselineCreate, {
    native() {
      nativeCalls += 1;
      return 0;
    },
    writer(_packet, text) {
      rCalls += 1;
      if (text.startsWith("R:")) throw rSentinel;
      return 0;
    },
  });
  const reserveOutcome = capture(() => reserve.bridge.spawn.call({ pid: 51 }));
  assert.equal(reserveOutcome.threw, true);
  assert.equal(reserveOutcome.value, rSentinel);
  assert.equal(nativeCalls, 0);
  assert.equal(rCalls, 1);
  assert.equal(reserve.bridge.flush().status, "failed");
  assert.equal(rCalls, 1);

  const bSentinel = { bound: true };
  let bCalls = 0;
  const bound = fixture(baselineCreate, {
    writer(packet, text) {
      if (text.startsWith("B:")) {
        bCalls += 1;
        throw bSentinel;
      }
      return packet.byteLength;
    },
  });
  assert.equal(bound.bridge.spawn.call({ pid: 52 }), 0);
  assert.equal(bCalls, 1);
  assert.equal(bound.bridge.flush().status, "failed");
  assert.equal(bound.bridge.finish().status, "failed");
  assert.equal(bCalls, 1);
  assert.equal(bound.bridge.snapshot().firstError.value, bSentinel);
  assert.equal(bound.bridge.snapshot().guard.firstError.value, bSentinel);
});

test("C、G、T失败锁存且不重试", () => {
  for (const kind of ["C", "G", "T"]) {
    let failedCalls = 0;
    const { bridge, observers } = fixture(baselineCreate, {
      writer(packet, text) {
        if (text.startsWith(`${kind}:`)) {
          failedCalls += 1;
          throw `${kind}-failure`;
        }
        return packet.byteLength;
      },
    });
    const receiver = { pid: 60 };
    assert.equal(bridge.spawn.call(receiver), 0);
    if (kind !== "G") observers.get(receiver)?.onClose();
    bridge.closeAdmission();
    if (kind === "T") assert.equal(bridge.flush().status, "ok");
    const first = kind === "T" ? bridge.finish() : bridge.flush();
    assert.equal(first.status, "failed", kind);
    assert.equal(bridge.flush().status, "failed", kind);
    assert.equal(bridge.finish().status, "failed", kind);
    assert.equal(failedCalls, 1, kind);
  }
});

test("短写、长写、非整数、Promise和缓冲变长都失败且不读取then", () => {
  /** @type {{ label: string, writer: (packet: Uint8Array) => unknown, thenCalls?: () => number }[]} */
  const cases = [
    { label: "short", writer: (packet) => packet.byteLength - 1 },
    { label: "long", writer: (packet) => packet.byteLength + 1 },
    { label: "fraction", writer: (packet) => packet.byteLength + 0.5 },
  ];
  let thenCalls = 0;
  const receipt = {};
  Object.defineProperty(receipt, "then", {
    get() {
      thenCalls += 1;
      return () => undefined;
    },
  });
  cases.push({ label: "promise-like", writer: () => receipt, thenCalls: () => thenCalls });
  cases.push({
    label: "mutated-buffer",
    writer(packet) {
      Object.defineProperty(packet, "byteLength", { value: packet.byteLength + 10 });
      return packet.byteLength;
    },
  });

  for (const item of cases) {
    let nativeCalls = 0;
    const { bridge } = fixture(baselineCreate, {
      native() {
        nativeCalls += 1;
        return 0;
      },
      writer: item.writer,
    });
    assert.equal(capture(() => bridge.spawn.call({ pid: 71 })).threw, true, item.label);
    assert.equal(nativeCalls, 0, item.label);
    assert.equal(item.thenCalls?.() ?? 0, 0, item.label);
    assert.equal(bridge.snapshot().wireSequence, 1, item.label);
  }
});

test("writePacket中的flush/finish重入pending，spawn重入阻止native并复查健康", () => {
  /** @type {Bridge | null} */
  let bridge = null;
  let nativeCalls = 0;
  let nestedNativeCalls = 0;
  let reentered = false;
  bridge = baselineCreate({
    originalSpawn() {
      nativeCalls += 1;
      return 0;
    },
    installObserver() {},
    writePacket(packet) {
      assert.equal(bridge?.flush().status, "pending");
      assert.equal(bridge?.finish().status, "pending");
      const text = decodeAscii(packet);
      if (text.startsWith("B:") && !reentered) {
        reentered = true;
        const nested = capture(() => bridge?.spawn.call({ pid: 81 }));
        assert.equal(nested.threw, true);
        nestedNativeCalls += 0;
      }
      return packet.byteLength;
    },
  });
  assert.equal(bridge.spawn.call({ pid: 80 }), 0);
  assert.equal(nativeCalls, 1);
  assert.equal(nestedNativeCalls, 0);
  assert.equal(bridge.snapshot().failed, true);
  assert.equal(bridge.snapshot().slots[0].boundReported, false);
  assert.equal(capture(() => bridge?.assertHealthy()).threw, true);
});

test("T不是EOF：迟到A1错误使已finish桥不健康", () => {
  const { bridge, observers } = fixture(baselineCreate);
  const receiver = { pid: 91 };
  bridge.spawn.call(receiver);
  observers.get(receiver)?.onClose();
  bridge.closeAdmission();
  assert.equal(bridge.flush().status, "ok");
  assert.equal(bridge.finish().status, "finished");
  const late = { late: true };
  observers.get(receiver)?.onError(late);
  assert.equal(bridge.snapshot().terminalReported, true);
  assert.equal(bridge.snapshot().failed, true);
  assert.equal(bridge.flush().status, "failed");
  assert.equal(bridge.finish().status, "failed");
  assert.equal(capture(() => bridge.assertHealthy()).threw, true);
  assert.equal(bridge.snapshot().guard.firstError.value, late);
});

test("snapshot与结果冻结壳但不深冻receiver、原错误或原返回", () => {
  const receiver = { pid: 101, child: { mutable: true } };
  const originalError = { mutable: true };
  const { bridge, observers } = fixture(baselineCreate);
  assert.equal(bridge.spawn.call(receiver), 0);
  const snapshot = bridge.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.firstError), true);
  assert.equal(Object.isFrozen(snapshot.slots), true);
  assert.equal(Object.isFrozen(snapshot.slots[0]), true);
  assert.equal(snapshot.slots[0].receiver, receiver);
  assert.equal(Object.isFrozen(receiver), false);
  assert.equal(Object.isFrozen(receiver.child), false);
  observers.get(receiver)?.onError(originalError);
  const failed = bridge.snapshot();
  assert.equal(failed.guard.firstError.value, originalError);
  assert.equal(Object.isFrozen(originalError), false);
  assert.equal("kill" in failed, false);
  assert.equal("reclaim" in failed, false);
  assert.equal("cleanupAllowed" in failed, false);
  assert.equal(Object.isFrozen(bridge.flush()), true);
});

/**
 * @param {string} name
 * @param {string} before
 * @param {string} after
 * @param {(create: CreateBridge) => void} invariant
 */
function mutationTest(name, before, after, invariant) {
  test(`变异命中：${name}`, () => {
    invariant(baselineCreate);
    const mutantSource = mutateOnce(helperSource, before, after, name);
    const mutantCreate = loadBridge(mutantSource, `mutant-${name}`);
    const outcome = capture(() => invariant(mutantCreate));
    assert.equal(outcome.threw, true, `${name}: mutant survived invariant`);
    assert.equal(
      outcome.value instanceof assert.AssertionError,
      true,
      `${name}: mutant must be killed by a real assertion, not load/type/runtime failure`,
    );
  });
}

mutationTest(
  "向A1返回新包长度",
  "      reportedSlots.push({\n        slotId,\n        receiver: /** @type {object} */ (local.receiver),\n        reserveReported: true,\n        boundReported: false,\n        closeReported: false,\n      });\n      return oldLength;",
  "      reportedSlots.push({\n        slotId,\n        receiver: /** @type {object} */ (local.receiver),\n        reserveReported: true,\n        boundReported: false,\n        closeReported: false,\n      });\n      return oldLength + 2;",
  (create) => {
    const { bridge, packets } = fixture(create);
    const outcome = capture(() => bridge.spawn.call({ pid: 201 }));
    assert.equal(outcome.threw, false);
    assert.equal(outcome.value, 0);
    assert.deepEqual(packets, ["R:1:1\n", "B:2:1:201\n"]);
  },
);

mutationTest(
  "C早于B",
  "      sendPacket(`B:{q}:${slotId}:${pid}\\n`, \"B\", slotId);\n      reported.boundReported = true;",
  "      if (local.closeObserved) {\n        sendPacket(`C:{q}:${slotId}\\n`, \"C\", slotId);\n        reported.closeReported = true;\n      }\n      sendPacket(`B:{q}:${slotId}:${pid}\\n`, \"B\", slotId);\n      reported.boundReported = true;",
  (create) => {
    /** @type {ObserverCallbacks | null} */
    let callbacks = null;
    /** @type {string[]} */
    const packets = [];
    const bridge = create({
      originalSpawn() {
        callbacks?.onClose();
        return 0;
      },
      installObserver(_receiver, installed) {
        callbacks = installed;
      },
      writePacket(packet) {
        packets.push(decodeAscii(packet));
        return packet.byteLength;
      },
    });
    assert.equal(bridge.spawn.call({ pid: 202 }), 0);
    assert.deepEqual(packets, ["R:1:1\n", "B:2:1:202\n"]);
  },
);

mutationTest(
  "未全部close就T",
  "      const allComplete = reportedSlots.every((slot) =>\n        slot.reserveReported && slot.boundReported && slot.closeReported);",
  "      const allComplete = reportedSlots.every((slot) =>\n        slot.reserveReported && slot.boundReported);",
  (create) => {
    const { bridge, packets } = fixture(create);
    bridge.spawn.call({ pid: 203 });
    bridge.closeAdmission();
    assert.equal(bridge.flush().status, "ok");
    assert.equal(bridge.finish().status, "pending");
    assert.equal(packets.some((packet) => packet.startsWith("T:")), false);
  },
);

mutationTest(
  "把G当终结",
  "        gateReported = true;",
  "        gateReported = true;\n        terminalReported = true;",
  (create) => {
    const { bridge, packets } = fixture(create);
    bridge.spawn.call({ pid: 204 });
    bridge.closeAdmission();
    assert.equal(bridge.flush().status, "ok");
    assert.equal(bridge.finish().status, "pending");
    assert.deepEqual(packets, ["R:1:1\n", "B:2:1:204\n", "G:3\n"]);
  },
);

mutationTest(
  "写失败回滚后重试",
  "    } catch (error) {\n      latchFailure(error, `packet-${kind}-write`);\n      throw error;\n    } finally {",
  "    } catch (error) {\n      wireSequence -= 1;\n      packetAttempts -= 1;\n      bytesRequested -= expectedLength;\n      throw error;\n    } finally {",
  (create) => {
    let cAttempts = 0;
    const { bridge, observers } = fixture(create, {
      writer(packet, text) {
        if (text.startsWith("C:")) {
          cAttempts += 1;
          if (cAttempts === 1) throw "first-c-failure";
        }
        return packet.byteLength;
      },
    });
    const receiver = { pid: 205 };
    bridge.spawn.call(receiver);
    observers.get(receiver)?.onClose();
    bridge.closeAdmission();
    assert.equal(bridge.flush().status, "failed");
    bridge.flush();
    assert.equal(cAttempts, 1);
  },
);

mutationTest(
  "finally flush替换原native异常",
  "    flushing = true;\n    try {\n      const guardState = guardSnapshot();",
  "    const preflight = guard.snapshot();\n    if (bridgeFailed || preflight.failed) {\n      throw makeBridgeError();\n    }\n    flushing = true;\n    try {\n      const guardState = guardSnapshot();",
  (create) => {
    const sentinel = false;
    const { bridge } = fixture(create, {
      native() {
        throw sentinel;
      },
    });
    const outcome = capture(() => {
      try {
        bridge.spawn.call({ pid: 206 });
      } finally {
        bridge.flush();
      }
    });
    assert.equal(outcome.threw, true);
    assert.equal(Object.is(outcome.value, sentinel), true);
  },
);

mutationTest(
  "漏包写后健康复查",
  "    if (!healthyNow()) {\n      throw makeBridgeError();\n    }\n  }\n\n  /** @param {number} slotId */",
  "  }\n\n  /** @param {number} slotId */",
  (create) => {
    /** @type {Bridge | null} */
    let bridge = null;
    let nested = false;
    bridge = create({
      originalSpawn() {
        return 0;
      },
      installObserver() {},
      writePacket(packet) {
        if (decodeAscii(packet).startsWith("B:") && !nested) {
          nested = true;
          capture(() => bridge?.spawn.call({ pid: 208 }));
        }
        return packet.byteLength;
      },
    });
    assert.equal(bridge.spawn.call({ pid: 207 }), 0);
    assert.equal(bridge.snapshot().failed, true);
    assert.equal(bridge.snapshot().slots[0].boundReported, false);
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
console.log(`ok - ${passed} pm-sdk quiescence bridge VM tests`);
