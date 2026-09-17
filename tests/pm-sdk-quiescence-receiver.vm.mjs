import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext, runInNewContext } from "node:vm";
import { createCreatorBridge } from "./helpers/pm-sdk-quiescence-bridge.mjs";
import { createPmSdkQuiescenceState } from "./helpers/pm-sdk-quiescence-state.mjs";
import { createQuiescenceReceiver } from "./helpers/pm-sdk-quiescence-receiver.mjs";

const helperUrl = new URL("./helpers/pm-sdk-quiescence-receiver.mjs", import.meta.url);
const helperSource = readFileSync(helperUrl, "utf8");
const importLine = "import { createPmSdkQuiescenceState } from \"./pm-sdk-quiescence-state.mjs\";";

/** @typedef {{ onClose: () => void, onError: (error: unknown) => void }} ObserverCallbacks */
/** @typedef {ReturnType<typeof createCreatorBridge>} Bridge */
/** @typedef {ReturnType<typeof createQuiescenceReceiver>} Receiver */
/** @typedef {typeof createQuiescenceReceiver} CreateReceiver */

/** @param {Uint8Array} bytes */
function decode(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

/** @param {string} text */
function encode(text) {
  const result = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) result[index] = text.charCodeAt(index);
  return result;
}

/** @param {() => unknown} operation */
function capture(operation) {
  try {
    return { threw: false, value: operation() };
  } catch (error) {
    return { threw: true, value: error };
  }
}

/**
 * The positive fixture always passes the original, freshly created real bridge
 * object as checkCreator. Fault-injection tests are explicitly labelled and do
 * not claim runtime bridge provenance authentication.
 * @param {CreateReceiver} create
 * @param {{ kinds?: ("execution-child"|"detached-group")[][], direct?: boolean, onPacket?: (text:string, receiver:Receiver)=>void }=} options
 */
function fixture(create, options = {}) {
  const kinds = options.kinds ?? [[]];
  /** @type {{ owner: object, stream: object, queue: Uint8Array[], bridge: Bridge, observers: Map<object, ObserverCallbacks> }[]} */
  const sides = [];
  /** @type {Receiver | null} */
  let receiver = null;
  for (let index = 0; index < kinds.length; index += 1) {
    /** @type {Uint8Array[]} */
    const queue = [];
    /** @type {Map<object, ObserverCallbacks>} */
    const observers = new Map();
    const owner = Object.freeze({ owner: index + 1 });
    const stream = Object.freeze({ stream: index + 1 });
    const bridge = createCreatorBridge({
      originalSpawn() { return 0; },
      /** @param {object} child @param {ObserverCallbacks} callbacks */
      installObserver(child, callbacks) { observers.set(child, callbacks); },
      /** @param {Uint8Array} packet */
      writePacket(packet) {
        const copy = new Uint8Array(packet.byteLength);
        copy.set(packet);
        if (options.direct && receiver !== null) {
          assert.equal(receiver.accept(owner, stream, copy).status, "ok");
          options.onPacket?.(decode(copy), receiver);
        } else {
          queue.push(copy);
        }
        return packet.byteLength;
      },
    });
    sides.push({ owner, stream, queue, bridge, observers });
  }
  receiver = create({
    caseId: "case-a",
    sources: sides.map((side, index) => ({
      writerId: `writer-${index + 1}`,
      creatorOwner: side.owner,
      readStream: side.stream,
      slotKinds: kinds[index],
      checkCreator: side.bridge,
    })),
  });
  return { receiver, sides };
}

/** @param {ReturnType<typeof fixture>} world @param {number} sourceIndex @param {"packets"|"bytes"|"joined"} [mode] */
function pump(world, sourceIndex, mode = "packets") {
  const side = world.sides[sourceIndex];
  assert.ok(side);
  const packets = side.queue.splice(0);
  if (mode === "packets") {
    for (const packet of packets) assert.equal(world.receiver.accept(side.owner, side.stream, packet).status, "ok");
    return;
  }
  let total = 0;
  for (const packet of packets) total += packet.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const packet of packets) { joined.set(packet, offset); offset += packet.length; }
  if (mode === "joined") {
    assert.equal(world.receiver.accept(side.owner, side.stream, joined).status, "ok");
  } else {
    for (const byte of joined) assert.equal(world.receiver.accept(side.owner, side.stream, Uint8Array.of(byte)).status, "ok");
  }
}

/** @param {ReturnType<typeof fixture>} world */
function rootsAndCase(world) {
  assert.equal(world.receiver.recordCaseResult({ outcome: "pass", error: { present: false } }).status, "pending");
  assert.equal(world.receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null }).status, "ok");
  assert.equal(world.receiver.observeExecutionGroup({ groupState: "gone" }).status, "ok");
}

/**
 * @param {CreateReceiver} create
 * @param {{ kinds?: ("execution-child"|"detached-group")[][], chunks?: ("packets"|"bytes"|"joined")[], omitDetachedGone?: boolean }=} options
 */
function complete(create, options = {}) {
  const kinds = options.kinds ?? [[]];
  const world = fixture(create, { kinds });
  assert.equal(world.receiver.start().status, "ok");
  rootsAndCase(world);
  /** @type {{pid:number}[][]} */
  const children = [];
  for (let sourceIndex = 0; sourceIndex < kinds.length; sourceIndex += 1) {
    const side = world.sides[sourceIndex];
    assert.ok(side);
    /** @type {{pid:number}[]} */
    const sourceChildren = [];
    for (let slot = 0; slot < kinds[sourceIndex].length; slot += 1) {
      const child = { pid: 1000 + sourceIndex * 100 + slot + 1 };
      sourceChildren.push(child);
      assert.equal(side.bridge.spawn.call(child), 0);
    }
    children.push(sourceChildren);
  }
  assert.equal(world.receiver.requestClosing().status, "ok");
  for (let sourceIndex = 0; sourceIndex < kinds.length; sourceIndex += 1) {
    pump(world, sourceIndex, options.chunks?.[sourceIndex] ?? "packets");
    const side = world.sides[sourceIndex];
    const sourceChildren = children[sourceIndex];
    assert.ok(side && sourceChildren);
    for (let slot = 0; slot < kinds[sourceIndex].length; slot += 1) {
      if (kinds[sourceIndex][slot] === "detached-group" && !options.omitDetachedGone) {
        assert.equal(world.receiver.observeResourceGroup(side.owner, side.stream, slot + 1, "gone").status, "ok");
      }
      side.observers.get(sourceChildren[slot])?.onClose();
    }
    side.bridge.closeAdmission();
    assert.equal(side.bridge.flush().status, "ok");
  }
  for (let sourceIndex = 0; sourceIndex < kinds.length; sourceIndex += 1) {
    pump(world, sourceIndex, options.chunks?.[sourceIndex] ?? "packets");
    assert.equal(world.sides[sourceIndex]?.bridge.finish().status, "finished");
  }
  for (let sourceIndex = 0; sourceIndex < kinds.length; sourceIndex += 1) {
    pump(world, sourceIndex, options.chunks?.[sourceIndex] ?? "packets");
    const side = world.sides[sourceIndex];
    assert.ok(side);
    assert.equal(world.receiver.end(side.owner, side.stream).status, "ok");
  }
  return world;
}

/**
 * Completes two real mixed-kind bridges while reserving their resources in an
 * order that differs from source declaration order.
 * @param {CreateReceiver} create
 * @param {"reverse" | "interleaved"} order
 */
function completeMixedOrder(create, order) {
  /** @type {("execution-child"|"detached-group")[][]} */
  const kinds = [
    ["execution-child", "detached-group"],
    ["detached-group", "execution-child"],
  ];
  const world = fixture(create, { kinds });
  assert.equal(world.receiver.start().status, "ok");
  rootsAndCase(world);
  assert.equal(world.receiver.requestClosing().status, "ok");
  /** @type {{pid:number}[][]} */
  const children = [[], []];

  /** @param {number} sourceIndex @param {number} count @param {"packets"|"joined"} mode */
  function spawnAndPump(sourceIndex, count, mode) {
    const side = world.sides[sourceIndex];
    const sourceChildren = children[sourceIndex];
    assert.ok(side && sourceChildren);
    for (let index = 0; index < count; index += 1) {
      const child = { pid: 2000 + sourceIndex * 100 + sourceChildren.length + 1 };
      sourceChildren.push(child);
      assert.equal(side.bridge.spawn.call(child), 0);
    }
    pump(world, sourceIndex, mode);
  }

  if (order === "reverse") {
    spawnAndPump(1, 2, "joined");
    spawnAndPump(0, 2, "packets");
  } else {
    spawnAndPump(1, 1, "packets");
    spawnAndPump(0, 1, "joined");
    spawnAndPump(0, 1, "joined");
    spawnAndPump(1, 1, "packets");
  }

  for (let sourceIndex = 0; sourceIndex < kinds.length; sourceIndex += 1) {
    const side = world.sides[sourceIndex];
    const sourceChildren = children[sourceIndex];
    assert.ok(side && sourceChildren);
    for (let slot = 0; slot < kinds[sourceIndex].length; slot += 1) {
      if (kinds[sourceIndex][slot] === "detached-group") {
        assert.equal(world.receiver.observeResourceGroup(side.owner, side.stream, slot + 1, "gone").status, "ok");
      }
      side.observers.get(sourceChildren[slot])?.onClose();
    }
    side.bridge.closeAdmission();
    assert.equal(side.bridge.flush().status, "ok");
    assert.equal(side.bridge.finish().status, "finished");
  }

  pump(world, 0, order === "reverse" ? "packets" : "joined");
  pump(world, 1, order === "reverse" ? "joined" : "packets");
  for (const side of world.sides) {
    assert.equal(world.receiver.end(side.owner, side.stream).status, "ok");
  }
  return world;
}

/** @param {string} source @param {string} label @returns {CreateReceiver} */
function loadReceiver(source, label) {
  assert.equal(source.split(importLine).length - 1, 1, `${label}: static Q1 import changed`);
  const exportNeedle = "export function createQuiescenceReceiver";
  assert.equal(source.split(exportNeedle).length - 1, 1, `${label}: export changed`);
  const executable = `"use strict";\n${source
    .replace(importLine, "const createPmSdkQuiescenceState = globalThis.__createPmSdkQuiescenceState;")
    .replace(exportNeedle, "function createQuiescenceReceiver")}\ncreateQuiescenceReceiver;`;
  const context = createContext({ __createPmSdkQuiescenceState: createPmSdkQuiescenceState });
  const result = new Script(executable, { filename: `pm-sdk-quiescence-receiver.${label}.mjs` }).runInContext(context);
  assert.equal(typeof result, "function", `${label}: load failed`);
  return /** @type {CreateReceiver} */ (result);
}

/** @param {string} source @param {string} before @param {string} after @param {string} label */
function mutateOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label}: anchor not unique`);
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source, `${label}: unchanged`);
  return mutated;
}

/** @param {CreateReceiver} create @param {string} stage */
function transitionWorld(create, stage) {
  const owner = {}, stream = {}, child = { pid: 4321 };
  /** @type {Receiver} */ let receiver;
  /** @type {ObserverCallbacks[]} */ const observers = [];
  /** @type {string[]} */ const seen = [];
  const inspect = () => { seen.push(receiver.conclude().status); };
  const bridge = createCreatorBridge({
    originalSpawn() { if (stage === "native") inspect(); return 0; },
    /** @param {object} _child @param {ObserverCallbacks} callbacks */
    installObserver(_child, callbacks) { observers.push(callbacks); if (stage === "install") inspect(); },
    /** @param {Uint8Array} packet */
    writePacket(packet) {
      assert.equal(receiver.accept(owner, stream, packet).status, "ok");
      if (decode(packet).startsWith(`${stage}:`)) inspect();
      return packet.byteLength;
    },
  });
  receiver = create({ caseId: "transitions", sources: [{ writerId: "w", creatorOwner: owner, readStream: stream, slotKinds: ["execution-child"], checkCreator: bridge }] });
  receiver.start(); receiver.requestClosing();
  receiver.recordCaseResult({ outcome: "pass", error: { present: false } });
  receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null });
  receiver.observeExecutionGroup({ groupState: "gone" });
  assert.equal(bridge.spawn.call(child), 0);
  assert.equal(observers.length, 1);
  observers[0].onClose(); bridge.closeAdmission();
  assert.equal(bridge.flush().status, "ok"); assert.equal(bridge.finish().status, "finished");
  assert.equal(receiver.end(owner, stream).status, "ok");
  return { seen, result: receiver.conclude() };
}

/** Real bridge + explicit in-memory transport corruption, never a fake Q1.
 * @param {CreateReceiver} create @param {"none"|"case"|"root"|"detached"} missing
 * @param {"none"|"bytes"|"slots"} corruption
 */
function terminalFaultWorld(create, missing, corruption) {
  const kind = missing === "detached" ? "detached-group" : "execution-child";
  const world = fixture(create, { kinds: [[kind]] });
  const side = world.sides[0]; assert.ok(side);
  const { receiver } = world;
  receiver.start(); receiver.requestClosing();
  if (missing !== "case") receiver.recordCaseResult({ outcome: "pass", error: { present: false } });
  receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null });
  if (missing !== "root") receiver.observeExecutionGroup({ groupState: "gone" });
  const child = { pid: 1234 };
  side.bridge.spawn.call(child); side.observers.get(child)?.onClose();
  side.bridge.closeAdmission(); side.bridge.flush(); side.bridge.finish();
  let text = side.queue.splice(0).map(decode).join("");
  if (corruption === "bytes") text = text.replace(":1234\n", ":123\n");
  if (corruption === "slots") text = "G:1\nT:2\n";
  assert.equal(receiver.accept(side.owner, side.stream, encode(text)).status, "ok");
  assert.equal(receiver.end(side.owner, side.stream).status, "ok");
  return receiver;
}

/** @type {{ name: string, run: () => void }[]} */
const tests = [];
/** @param {string} name @param {() => void} run */
function test(name, run) { tests.push({ name, run }); }

const baselineCreate = /** @type {CreateReceiver} */ (createQuiescenceReceiver);
assert.equal(typeof loadReceiver(helperSource, "baseline-vm"), "function");
assert.equal(helperSource.split(/^import\s/gmu).length - 1, 1);
assert.doesNotMatch(helperSource, /from\s+["'](?:node:)?(?:fs|net|child_process)["']|\bimport\s*\(/u);
assert.match(helperSource, /local association identities only/u);
assert.match(helperSource, /no runtime brand or\s+ \* provenance authentication/u);

test("构造严格拒绝零/三来源、缺省或稀疏slotKinds及重复来源身份", () => {
  const checker = Object.freeze({ assertHealthy() {}, snapshot() { return {}; } });
  const owner = {};
  /** @param {number} index @param {object} [sourceOwner] */
  const source = (index, sourceOwner = {}) => ({
    writerId: `writer-${index}`,
    creatorOwner: sourceOwner,
    readStream: {},
    slotKinds: [],
    checkCreator: checker,
  });
  const missingKinds = {
    writerId: "writer-missing",
    creatorOwner: {},
    readStream: {},
    checkCreator: checker,
  };
  /** @type {unknown[]} */
  const invalid = [
    { caseId: "case-a", sources: [] },
    { caseId: "case-a", sources: [source(1), source(2), source(3)] },
    { caseId: "case-a", sources: [missingKinds] },
    { caseId: "case-a", sources: [{ ...source(1), slotKinds: Array(1) }] },
    { caseId: "case-a", sources: [{ ...source(1), slotKinds: ["implicit-child"] }] },
    { caseId: "case-a", sources: [{ ...source(1), checkCreator: function fakeChecker() {} }] },
    { caseId: "case-a", sources: [source(1, owner), source(2, owner)] },
  ];
  for (const configuration of invalid) {
    const outcome = capture(() => baselineCreate(configuration));
    assert.equal(outcome.threw, true);
    assert.equal(/** @type {{code?:unknown}} */ (outcome.value).code, "ERR_QUIESCENCE_RECEIVER_CONFIGURATION");
  }
});

test("真实Q1+A1+bridge零槽单源完整候选，且无权限型返回", () => {
  const world = complete(baselineCreate);
  const result = world.receiver.conclude();
  assert.equal(result.status, "pure-model-candidate");
  assert.equal(result.q1?.physicalEndCandidate, true);
  assert.equal(result.business.executionPassCandidate, true);
  assert.equal(Object.isFrozen(result), true);
  for (const forbidden of ["cleanupAllowed", "stop", "reclaim", "credentials", "q1State"]) {
    assert.equal(Object.hasOwn(result, forbidden), false);
  }
});

test("真实双源混合kind、八槽、逐字节和合包保持wire/Q1序号分离", () => {
  /** @type {("execution-child"|"detached-group")[][]} */
  const kinds = [
    ["execution-child", "detached-group", "execution-child", "detached-group", "execution-child", "detached-group", "execution-child", "detached-group"],
    ["detached-group"],
  ];
  const world = complete(baselineCreate, { kinds, chunks: ["bytes", "joined"] });
  const result = world.receiver.conclude();
  assert.equal(result.status, "pure-model-candidate");
  assert.equal(result.receiver.sources[0]?.frames, 26);
  assert.equal(result.receiver.sources[0]?.wireNext, 27);
  assert.equal(result.receiver.sources[0]?.q1Next, 26);
  assert.equal(result.q1?.resources, 9);
});

test("真实双源混合kind按反向和交错R全局顺序、逐包与合包均完整候选", () => {
  for (const order of /** @type {const} */ (["reverse", "interleaved"])) {
    const world = completeMixedOrder(baselineCreate, order);
    const result = world.receiver.conclude();
    assert.equal(result.status, "pure-model-candidate", order);
    assert.equal(result.q1?.physicalEndCandidate, true, order);
    assert.equal(result.q1?.resources, 4, order);
  }
});

test("早到case和根事实不提前closing，排队R仍按原case递交", () => {
  const world = fixture(baselineCreate, { kinds: [["execution-child"]] });
  assert.equal(world.receiver.start().status, "ok");
  rootsAndCase(world);
  assert.equal(world.receiver.requestClosing().status, "ok");
  const side = world.sides[0];
  assert.ok(side);
  const child = { pid: 222 };
  side.bridge.spawn.call(child);
  assert.equal(world.receiver.conclude().status, "incomplete");
  pump(world, 0);
  side.observers.get(child)?.onClose();
  side.bridge.closeAdmission();
  side.bridge.flush();
  pump(world, 0);
  side.bridge.finish();
  pump(world, 0);
  assert.equal(world.receiver.end(side.owner, side.stream).status, "ok");
  assert.equal(world.receiver.conclude().status, "pure-model-candidate");
});

test("单源end可早于另一源G，另一源随后仍可接收R", () => {
  const world = fixture(baselineCreate, { kinds: [[], ["execution-child"]] });
  world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
  const first = world.sides[0], second = world.sides[1];
  assert.ok(first && second);
  first.bridge.closeAdmission(); first.bridge.flush(); pump(world, 0); first.bridge.finish(); pump(world, 0);
  assert.equal(world.receiver.end(first.owner, first.stream).status, "ok");
  const child = { pid: 333 };
  assert.equal(second.bridge.spawn.call(child), 0);
  pump(world, 1);
  second.observers.get(child)?.onClose(); second.bridge.closeAdmission(); second.bridge.flush(); pump(world, 1);
  second.bridge.finish(); pump(world, 1); world.receiver.end(second.owner, second.stream);
  assert.equal(world.receiver.conclude().status, "pure-model-candidate");
});

test("G后允许迟到C但拒绝R/B，T要求全C且G/T都不是EOF", () => {
  const world = fixture(baselineCreate, { kinds: [["execution-child"]] });
  world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
  const side = world.sides[0]; assert.ok(side);
  const child = { pid: 444 }; side.bridge.spawn.call(child); pump(world, 0);
  side.bridge.closeAdmission(); side.bridge.flush(); pump(world, 0);
  assert.equal(world.receiver.conclude().status, "incomplete");
  side.observers.get(child)?.onClose(); side.bridge.flush(); pump(world, 0);
  side.bridge.finish(); pump(world, 0);
  assert.equal(world.receiver.conclude().status, "incomplete");
  world.receiver.end(side.owner, side.stream);
  assert.equal(world.receiver.conclude().status, "pure-model-candidate");
});

test("G/T写回调内结论是incomplete，原桥成功位落定后才成为候选", () => {
  /** @type {string[]} */
  const observations = [];
  const world = fixture(baselineCreate, {
    direct: true,
    onPacket(text, receiver) {
      if (text.startsWith("G:")) observations.push(receiver.conclude().status);
      if (text.startsWith("T:")) {
        const side = world.sides[0]; assert.ok(side);
        assert.equal(receiver.end(side.owner, side.stream).status, "ok");
        observations.push(receiver.conclude().status);
      }
    },
  });
  world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
  const side = world.sides[0]; assert.ok(side);
  side.bridge.closeAdmission(); side.bridge.flush(); side.bridge.finish();
  assert.deepEqual(observations, ["incomplete", "incomplete"]);
  assert.equal(world.receiver.conclude().status, "pure-model-candidate");
});

test("真实桥安装及R/B/C/G/T过渡只是不完整，随后仍可完成", () => {
  for (const stage of ["install", "native", "R", "B", "C", "G", "T"]) {
    const observed = transitionWorld(baselineCreate, stage);
    assert.deepEqual(observed.seen, ["incomplete"], stage);
    assert.equal(observed.result.status, "pure-model-candidate", stage);
  }
});

test("双方传输已终结时矛盾先于case或group缺项锁存", () => {
  for (const missing of /** @type {const} */ (["none", "case", "root", "detached"])) {
    const valid = terminalFaultWorld(baselineCreate, missing, "none");
    assert.equal(valid.conclude().status, missing === "none" ? "pure-model-candidate" : "incomplete");
    for (const corruption of /** @type {const} */ (["bytes", "slots"])) {
      const invalid = terminalFaultWorld(baselineCreate, missing, corruption);
      const result = invalid.conclude();
      assert.equal(result.status, "failed", `${missing}/${corruption}`);
      assert.ok("receiver" in result);
      assert.equal(result.receiver.firstFailure.present, true);
      assert.equal(/** @type {any} */ (result.receiver.firstFailure).value.code, "terminal_fact_mismatch");
      assert.equal(invalid.recordCaseResult({ outcome: "pass", error: { present: false } }).status, "failed");
    }
  }
});

test("负向故障快照不能借inFlight放行任意差槽或错原引用", () => {
  for (const mode of ["idle-tail", "native-tail", "extra-tail", "wrong-prefix", "bad-tail-return"]) {
    const real = fixture(baselineCreate, { kinds: [["execution-child"]] });
    const side = real.sides[0]; assert.ok(side);
    side.bridge.spawn.call({ pid: 5432 });
    const raw = side.bridge.snapshot();
    // Explicit checker fault injection; not a source-provenance test.
    const guardSlot = /** @type {any} */ (raw.guard.slots[0]);
    const tail = { ...guardSlot, nativeEntered: false, reserveWritten: false, nativeReturn: { present: false }, boundAttempted: false, boundWritten: false };
    let slots = /** @type {any[]} */ ([]), guardSlots = [tail], inFlight = 1;
    if (mode === "idle-tail") inFlight = 0;
    if (mode === "native-tail") tail.nativeEntered = true;
    if (mode === "bad-tail-return") tail.nativeReturn = { present: true, value: 0 };
    if (mode === "extra-tail") guardSlots.push({ ...tail, id: 2 });
    if (mode === "wrong-prefix") { slots = [{ ...raw.slots[0], receiver: {} }]; guardSlots = [guardSlot]; }
    const altered = { ...raw, inFlight, slots,
      budget: { ...raw.budget, slots: { ...raw.budget.slots, used: slots.length } },
      guard: { ...raw.guard, inFlight, slots: guardSlots, budget: { ...raw.guard.budget, slots: { ...raw.guard.budget.slots, used: guardSlots.length } } },
    };
    const receiver = baselineCreate({ caseId: "fault", sources: [{ writerId: "w", creatorOwner: {}, readStream: {}, slotKinds: ["execution-child", "execution-child"], checkCreator: { assertHealthy: side.bridge.assertHealthy, snapshot() { return altered; } } }] });
    receiver.start();
    assert.equal(receiver.conclude().status, "failed", mode);
  }
});

test("缺detached gone只是不完整，子帧不会冒充父层group事实", () => {
  const world = complete(baselineCreate, { kinds: [["detached-group"]], omitDetachedGone: true });
  const result = world.receiver.conclude();
  assert.equal(result.status, "incomplete");
  assert.equal(result.q1?.physicalEndCandidate, false);
});

test("缺case结果保持不完整；业务失败仍可独立显示物理候选且不深冻原错误", () => {
  const missing = fixture(baselineCreate);
  missing.receiver.start();
  assert.equal(missing.receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null }).status, "ok");
  assert.equal(missing.receiver.observeExecutionGroup({ groupState: "gone" }).status, "ok");
  assert.equal(missing.receiver.requestClosing().status, "ok");
  assert.equal(missing.receiver.requestClosing().status, "ok");
  const missingSide = missing.sides[0]; assert.ok(missingSide);
  missingSide.bridge.closeAdmission(); missingSide.bridge.flush(); pump(missing, 0);
  missingSide.bridge.finish(); pump(missing, 0);
  assert.equal(missing.receiver.end(missingSide.owner, missingSide.stream).status, "ok");
  const missingResult = missing.receiver.conclude();
  assert.equal(missingResult.status, "incomplete");
  assert.equal(missingResult.q1?.physicalEndCandidate, true);
  assert.equal(missingResult.business.outcome, "missing");

  let getterReads = 0;
  const originalError = {};
  Object.defineProperty(originalError, "detail", {
    configurable: true,
    get() { getterReads += 1; throw new Error("must not traverse"); },
  });
  const failedBusiness = fixture(baselineCreate);
  failedBusiness.receiver.start();
  assert.equal(failedBusiness.receiver.recordCaseResult({
    outcome: "failure",
    error: { present: true, value: originalError },
  }).status, "pending");
  assert.equal(failedBusiness.receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null }).status, "ok");
  assert.equal(failedBusiness.receiver.observeExecutionGroup({ groupState: "gone" }).status, "ok");
  failedBusiness.receiver.requestClosing();
  const failedSide = failedBusiness.sides[0]; assert.ok(failedSide);
  failedSide.bridge.closeAdmission(); failedSide.bridge.flush(); pump(failedBusiness, 0);
  failedSide.bridge.finish(); pump(failedBusiness, 0);
  failedBusiness.receiver.end(failedSide.owner, failedSide.stream);
  const failedResult = failedBusiness.receiver.conclude();
  assert.equal(failedResult.status, "pure-model-candidate");
  assert.equal(failedResult.q1?.physicalEndCandidate, true);
  assert.equal(failedResult.business.outcome, "failure");
  assert.equal(failedResult.business.executionPassCandidate, false);
  assert.equal(Object.isFrozen(originalError), false);
  assert.equal(getterReads, 0);
});

test("重复case结果永久失败且保留首次；所有falsy原错误引用按存在位保留", () => {
  for (const original of [undefined, null, false, 0, "", Number.NaN]) {
    const world = fixture(baselineCreate);
    world.receiver.start();
    assert.equal(world.receiver.recordCaseResult({ outcome: "failure", error: { present: true, value: original } }).status, "pending");
    assert.equal(world.receiver.recordCaseResult({ outcome: "failure", error: { present: true, value: original } }).status, "failed");
    const result = world.receiver.conclude();
    assert.equal(result.status, "failed");
  }
  for (const original of [undefined, null, false, 0, "", Number.NaN]) {
    const world = fixture(baselineCreate);
    world.receiver.start();
    const side = world.sides[0]; assert.ok(side);
    assert.equal(world.receiver.transportError(side.owner, side.stream, original).status, "failed");
    const result = world.receiver.conclude();
    assert.equal(result.status, "failed");
    assert.equal(Object.is(/** @type {any} */ (result).receiver.firstFailure.value, original), true);
  }
});

test("未知pair先失败且不污染另一receiver；重复PID由真实Q1拒绝", () => {
  const clean = complete(baselineCreate);
  const world = fixture(baselineCreate);
  world.receiver.start();
  const real = world.sides[0]; assert.ok(real);
  assert.equal(world.receiver.accept({}, real.stream, encode("G:1\n")).status, "failed");
  assert.equal(world.receiver.conclude().status, "failed");
  assert.equal(clean.receiver.conclude().status, "pure-model-candidate");

  const duplicate = fixture(baselineCreate, { kinds: [["execution-child", "execution-child"]] });
  duplicate.receiver.start(); rootsAndCase(duplicate);
  const side = duplicate.sides[0]; assert.ok(side);
  const first = { pid: 777 }, second = { pid: 777 };
  side.bridge.spawn.call(first); side.bridge.spawn.call(second);
  assert.equal(duplicate.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "ok");
  assert.equal(duplicate.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "ok");
  assert.equal(duplicate.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "ok");
  assert.equal(duplicate.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "failed");
});

test("断帧、乱序、非ASCII、帧/残帧/总预算越界均锁存且不重同步", () => {
  const cases = [
    encode("G:2\n"),
    Uint8Array.of(0xff),
    encode(`${"X".repeat(256)}\n`),
  ];
  for (const bytes of cases) {
    const world = fixture(baselineCreate); world.receiver.start();
    const side = world.sides[0]; assert.ok(side);
    assert.equal(world.receiver.accept(side.owner, side.stream, bytes).status, "failed");
    assert.equal(world.receiver.conclude().status, "failed");
  }
  const residual = fixture(baselineCreate); residual.receiver.start();
  const side = residual.sides[0]; assert.ok(side);
  assert.equal(residual.receiver.accept(side.owner, side.stream, encode("X".repeat(256))).status, "ok");
  assert.equal(residual.receiver.accept(side.owner, side.stream, encode("Y")).status, "failed");
  const total = fixture(baselineCreate); total.receiver.start();
  const totalSide = total.sides[0]; assert.ok(totalSide);
  assert.equal(total.receiver.accept(totalSide.owner, totalSide.stream, new Uint8Array(8192).fill(65)).status, "failed");
});

test("真实跨realm Uint8Array被接收，访问器/iterator/species不执行且共享内存拒绝", () => {
  const world = fixture(baselineCreate); world.receiver.start(); world.receiver.requestClosing();
  const side = world.sides[0]; assert.ok(side);
  const crossRealm = runInNewContext("Uint8Array.of(71,58,49,10)");
  assert.equal(world.receiver.accept(side.owner, side.stream, crossRealm).status, "ok");

  let reads = 0;
  const bytes = encode("T:2\n");
  for (const key of ["length", "byteLength", "buffer", "constructor", Symbol.iterator]) {
    Object.defineProperty(bytes, key, { configurable: true, get() { reads += 1; throw new Error("must not read"); } });
  }
  assert.equal(world.receiver.accept(side.owner, side.stream, bytes).status, "ok");
  assert.equal(reads, 0);

  if (typeof SharedArrayBuffer === "function") {
    const sharedWorld = fixture(baselineCreate); sharedWorld.receiver.start();
    const sharedSide = sharedWorld.sides[0]; assert.ok(sharedSide);
    assert.equal(sharedWorld.receiver.accept(sharedSide.owner, sharedSide.stream, new Uint8Array(new SharedArrayBuffer(4))).status, "failed");
  }
});

test("同chunk的T后任意尾字节立即失败，无尾部T保持正常接收", () => {
  const clean = fixture(baselineCreate); clean.receiver.start(); clean.receiver.requestClosing();
  const cleanSide = clean.sides[0]; assert.ok(cleanSide);
  assert.equal(clean.receiver.accept(cleanSide.owner, cleanSide.stream, encode("G:1\nT:2\n")).status, "ok");
  assert.equal(clean.receiver.conclude().status, "incomplete");

  for (const trailing of ["X", " ", "G:3\n"]) {
    const world = fixture(baselineCreate); world.receiver.start(); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    assert.equal(world.receiver.accept(side.owner, side.stream, encode(`G:1\nT:2\n${trailing}`)).status, "failed", trailing);
    assert.equal(world.receiver.conclude().status, "failed", trailing);
  }
});

test("正常end拒绝半帧/缺G/T，T后数据、重复end和transport error都失败", () => {
  for (const setup of ["half", "missing", "after-t", "double-end", "error"]) {
    const world = fixture(baselineCreate); world.receiver.start();
    const side = world.sides[0]; assert.ok(side);
    if (setup === "half") world.receiver.accept(side.owner, side.stream, encode("G:1"));
    if (setup === "missing") void 0;
    if (setup === "after-t" || setup === "double-end") {
      world.receiver.requestClosing();
      world.receiver.accept(side.owner, side.stream, encode("G:1\nT:2\n"));
      if (setup === "after-t") assert.equal(world.receiver.accept(side.owner, side.stream, encode("G:3\n")).status, "failed");
      else {
        assert.equal(world.receiver.end(side.owner, side.stream).status, "ok");
        assert.equal(world.receiver.end(side.owner, side.stream).status, "failed");
      }
    } else if (setup === "error") {
      assert.equal(world.receiver.transportError(side.owner, side.stream, "abort").status, "failed");
    } else {
      assert.equal(world.receiver.end(side.owner, side.stream).status, "failed");
    }
    assert.equal(world.receiver.conclude().status, "failed");
  }
});

test("checkCreator负向注入：抛错、Promise、访问器和不符schema均拒绝，不读取then", () => {
  for (const mode of ["throw", "promise", "accessor", "schema"]) {
    const owner = {}, stream = {};
    let thenReads = 0;
    const promiseLike = {};
    Object.defineProperty(promiseLike, "then", { get() { thenReads += 1; return () => undefined; } });
    const checker = {};
    if (mode === "accessor") {
      Object.defineProperty(checker, "assertHealthy", { get() { throw new Error("getter"); } });
      Object.defineProperty(checker, "snapshot", { value() {} });
      assert.equal(capture(() => baselineCreate({ caseId: "x", sources: [{ writerId: "w", creatorOwner: owner, readStream: stream, slotKinds: [], checkCreator: checker }] })).threw, true);
      continue;
    }
    Object.defineProperty(checker, "assertHealthy", { value() { if (mode === "throw") throw false; if (mode === "promise") return promiseLike; } });
    Object.defineProperty(checker, "snapshot", { value() { return {}; } });
    const receiver = baselineCreate({ caseId: "x", sources: [{ writerId: "w", creatorOwner: owner, readStream: stream, slotKinds: [], checkCreator: checker }] });
    receiver.start();
    assert.equal(receiver.conclude().status, "failed");
    assert.equal(thenReads, 0);
  }
});

test("所有入口共享同步重入门闩，回调吞掉内层failed仍使外层failed", () => {
  const methods = ["start", "requestClosing", "accept", "end", "transportError", "recordCaseResult", "recordExecutionClose", "observeExecutionGroup", "observeResourceGroup", "conclude"];
  for (const method of methods) {
    const real = fixture(baselineCreate);
    const side = real.sides[0]; assert.ok(side);
    /** @type {Receiver} */
    let receiver;
    const checker = {
      assertHealthy() {
        if (method === "start") receiver.start();
        else if (method === "requestClosing") receiver.requestClosing();
        else if (method === "accept") receiver.accept(side.owner, side.stream, encode("G:1\n"));
        else if (method === "end") receiver.end(side.owner, side.stream);
        else if (method === "transportError") receiver.transportError(side.owner, side.stream, 0);
        else if (method === "recordCaseResult") receiver.recordCaseResult({ outcome: "pass", error: { present: false } });
        else if (method === "recordExecutionClose") receiver.recordExecutionClose({ kind: "natural", exitCode: 0, signal: null });
        else if (method === "observeExecutionGroup") receiver.observeExecutionGroup({ groupState: "gone" });
        else if (method === "observeResourceGroup") receiver.observeResourceGroup(side.owner, side.stream, 1, "gone");
        else receiver.conclude();
      },
      snapshot: side.bridge.snapshot,
    };
    receiver = baselineCreate({ caseId: "x", sources: [{ writerId: "w", creatorOwner: side.owner, readStream: side.stream, slotKinds: [], checkCreator: checker }] });
    receiver.start();
    assert.equal(receiver.conclude().status, "failed", method);
  }
});

test("迟到A1错误使已T/end结果在conclude时失败", () => {
  const world = complete(baselineCreate, { kinds: [["execution-child"]] });
  const side = world.sides[0]; assert.ok(side);
  const child = [...side.observers.keys()][0];
  side.observers.get(child)?.onError("late");
  assert.equal(world.receiver.conclude().status, "failed");
});

/**
 * Mutation tests first run the invariant against the original implementation,
 * then require the successfully loaded mutant to be killed by AssertionError.
 * @param {string} name
 * @param {string} before
 * @param {string} after
 * @param {(create: CreateReceiver) => void} invariant
 */
function mutationTest(name, before, after, invariant) {
  test(`变异命中：${name}`, () => {
    invariant(baselineCreate);
    const mutant = loadReceiver(mutateOnce(helperSource, before, after, name), `mutant-${name}`);
    const outcome = capture(() => invariant(mutant));
    assert.equal(outcome.threw, true, `${name}: mutant survived`);
    assert.equal(outcome.value instanceof assert.AssertionError, true, `${name}: must be a real assertion`);
  });
}

mutationTest(
  "合法inFlight末槽再次被静止长度条件误拒",
  "  if (guard.slots.length !== slots.length) {",
  "  if (guard.slots.length !== slots.length) throw runtimeError(code);\n  if (guard.slots.length !== slots.length) {",
  (create) => {
    const observed = transitionWorld(create, "R");
    assert.deepEqual(observed.seen, ["incomplete"]);
    assert.equal(observed.result.status, "pure-model-candidate");
  },
);

mutationTest(
  "终结传输矛盾被业务物理缺项遮蔽",
  "      if (receiverTransportComplete && creatorsComplete && terminalTransportMismatches(latest, creators)) {",
  "      if (caseResultSubmitted && latest.result.physicalEndCandidate && receiverTransportComplete && creatorsComplete && terminalTransportMismatches(latest, creators)) {",
  (create) => {
    assert.equal(terminalFaultWorld(create, "case", "bytes").conclude().status, "failed");
  },
);

mutationTest(
  "默认execution-child",
  "        kind: source.slotKinds[slot - 1],",
  "        kind: \"execution-child\",",
  (create) => {
    const world = complete(create, { kinds: [["detached-group"]], omitDetachedGone: true });
    assert.equal(world.receiver.conclude().status, "incomplete");
  },
);

mutationTest(
  "丢失R的全局资源关联",
  "    const expectedResources = resourceOrder;",
  "    const expectedResources = sources.flatMap((source) => source.slots);",
  (create) => {
    const world = completeMixedOrder(create, "reverse");
    assert.equal(world.receiver.conclude().status, "pure-model-candidate");
  },
);

mutationTest(
  "提前case结算",
  "    if (!closingRequested || !sources.every((source) => source.gate)) return;",
  `    if (!closingRequested || !sources.every((source) => source.gate)) {
      if (closingRequested && caseResultRecorded && !caseResultAttempted) {
        caseResultAttempted = true;
        q1.recordCaseResult(auth, { caseId, outcome: caseResult?.outcome, error: caseResult?.error });
        caseResultSubmitted = true;
      }
      return;
    }`,
  (create) => {
    const world = fixture(create, { kinds: [["execution-child"]] });
    world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    side.bridge.spawn.call({ pid: 901 });
    assert.equal(world.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "ok");
  },
);

mutationTest(
  "提前closing",
  "    if (!closingRequested || !sources.every((source) => source.gate)) return;",
  `    if (!closingRequested || !sources.every((source) => source.gate)) {
      if (closingRequested && !q1ClosingAttempted) {
        q1ClosingAttempted = true;
        q1.beginClosing(auth, { reason: "receiver-drained" });
        q1Closing = true;
      }
      return;
    }`,
  (create) => {
    const world = fixture(create, { kinds: [["execution-child"]] });
    world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    side.bridge.spawn.call({ pid: 902 });
    assert.equal(world.receiver.accept(side.owner, side.stream, side.queue.shift()).status, "ok");
  },
);

mutationTest(
  "子帧冒充detached group-gone",
  "      current.closed = true;\n      return;",
  `      current.closed = true;
      if (current.kind === "detached-group") {
        q1.observeResourceGroup(auth, {
          resourceKey: current.resourceKey,
          handleKey: current.handleKey,
          groupState: "gone",
        });
      }
      return;`,
  (create) => {
    const world = complete(create, { kinds: [["detached-group"]], omitDetachedGone: true });
    assert.equal(world.receiver.conclude().status, "incomplete");
  },
);

mutationTest(
  "G充当EOF",
  "      source.gate = true;\n      maybeDrain();",
  "      source.gate = true;\n      source.ended = true;\n      maybeDrain();",
  (create) => {
    const world = fixture(create); world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    side.bridge.closeAdmission(); side.bridge.flush(); pump(world, 0);
    const result = world.receiver.conclude();
    assert.equal(result.status, "incomplete");
    assert.equal(result.receiver.sources[0]?.ended, false);
  },
);

mutationTest(
  "T充当EOF",
  "      source.terminal = true;\n    }",
  "      source.terminal = true;\n      source.ended = true;\n    }",
  (create) => {
    const world = fixture(create); world.receiver.start(); rootsAndCase(world); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    side.bridge.closeAdmission(); side.bridge.flush(); pump(world, 0); side.bridge.finish(); pump(world, 0);
    const result = world.receiver.conclude();
    assert.equal(result.status, "incomplete");
    assert.equal(result.receiver.sources[0]?.ended, false);
  },
);

mutationTest(
  "移除T同chunk尾部检查",
  "        if (source.terminal && index + 1 < combined.length) throw runtimeError(\"data_after_terminal\");\n",
  "",
  (create) => {
    const world = fixture(create); world.receiver.start(); world.receiver.requestClosing();
    const side = world.sides[0]; assert.ok(side);
    assert.equal(world.receiver.accept(side.owner, side.stream, encode("G:1\nT:2\nX")).status, "failed");
  },
);

mutationTest(
  "wire序号混入Q1 EOF",
  "        sequence: source.q1Next,\n        completeFrame: true,",
  "        sequence: source.wireNext,\n        completeFrame: true,",
  (create) => {
    const world = complete(create, { kinds: [["execution-child"]] });
    assert.equal(world.receiver.conclude().status, "pure-model-candidate");
  },
);

mutationTest(
  "漏readStream来源",
  "candidate.creatorOwner === owner && candidate.readStream === stream",
  "candidate.creatorOwner === owner",
  (create) => {
    const world = fixture(create); world.receiver.start();
    const side = world.sides[0]; assert.ok(side);
    assert.equal(world.receiver.accept(side.owner, {}, encode("G:1\n")).status, "failed");
  },
);

mutationTest(
  "忽略receiver失败",
  "      if (receiverFailed) return conclusion(\"failed\", null, sources.map(() => null));",
  "      if (receiverFailed) return conclusion(\"incomplete\", null, sources.map(() => null));",
  (create) => {
    const world = fixture(create); world.receiver.start();
    const side = world.sides[0]; assert.ok(side);
    world.receiver.transportError(side.owner, side.stream, false);
    const result = world.receiver.conclude();
    assert.equal(result.status, "failed");
  },
);

mutationTest(
  "跳过第二轮末端检查",
  "      for (let round = 0; round < 2; round += 1) {",
  "      for (let round = 0; round < 1; round += 1) {",
  (create) => {
    const real = complete(baselineCreate);
    const side = real.sides[0]; assert.ok(side);
    let calls = 0;
    const checker = {
      assertHealthy() { calls += 1; },
      snapshot() { return side.bridge.snapshot(); },
    };
    const receiver = create({ caseId: "x", sources: [{ writerId: "w", creatorOwner: {}, readStream: {}, slotKinds: [], checkCreator: checker }] });
    receiver.start();
    receiver.conclude();
    assert.equal(calls, 2);
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
console.log(`ok - ${passed} pm-sdk quiescence receiver VM tests`);
