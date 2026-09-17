// @ts-check

import { createPmSdkQuiescenceState } from "./pm-sdk-quiescence-state.mjs";

const CONFIG_ERROR_MESSAGE = "quiescence receiver rejected the configuration";
const RUNTIME_ERROR_MESSAGE = "quiescence receiver rejected the operation";
const MAX_SOURCES = 2;
const MAX_SLOTS = 8;
const MAX_FRAMES = 32;
const MAX_CHUNK_BYTES = 8192;
const MAX_TOTAL_BYTES = 8192;
const MAX_FRAME_BYTES = 256;
const MAX_RESIDUAL_BYTES = 256;
const MAX_DIAGNOSTICS = 32;
const MAX_GROUP_OBSERVATIONS = 64;
const MAX_IDENTIFIER_LENGTH = 64;

const okResult = Object.freeze({ status: /** @type {const} */ ("ok") });
const pendingResult = Object.freeze({ status: /** @type {const} */ ("pending") });
const failedResult = Object.freeze({ status: /** @type {const} */ ("failed") });

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get
);
const typedArrayByteLength = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get
);
const typedArrayByteOffset = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get
);
const typedArrayBuffer = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get
);
const typedArrayTag = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
);
const arrayBufferByteLength = /** @type {Function} */ (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
);
const uint8Set = Uint8Array.prototype.set;

/** @typedef {{ present: false } | { present: true, value: unknown }} ErrorCell */
/** @typedef {"execution-child" | "detached-group"} SlotKind */
/**
 * @typedef {{
 *   slot: number,
 *   ordinal: number,
 *   kind: SlotKind,
 *   resourceKey: object,
 *   handleKey: object,
 *   pid: number | null,
 *   bound: boolean,
 *   closed: boolean,
 * }} ReceiverSlot
 */
/**
 * @typedef {{
 *   writerId: string,
 *   creatorOwner: object | Function,
 *   readStream: object | Function,
 *   slotKinds: readonly SlotKind[],
 *   checkCreator: object,
 *   assertHealthy: Function,
 *   snapshot: Function,
 *   slots: ReceiverSlot[],
 *   wireNext: number,
 *   q1Next: number,
 *   frames: number,
 *   bytes: number,
 *   residual: Uint8Array,
 *   gate: boolean,
 *   terminal: boolean,
 *   ended: boolean,
 *   eofAttempted: boolean,
 * }} ReceiverSource
 */

/** @returns {Error & { code: string }} */
function configurationError() {
  return Object.assign(new Error(CONFIG_ERROR_MESSAGE), {
    name: "QuiescenceReceiverConfigurationError",
    code: "ERR_QUIESCENCE_RECEIVER_CONFIGURATION",
  });
}

/** @param {string} code @returns {Error & { code: string }} */
function runtimeError(code) {
  return Object.assign(new Error(RUNTIME_ERROR_MESSAGE), {
    name: "QuiescenceReceiverError",
    code,
  });
}

/** @param {unknown} value @returns {value is Record<PropertyKey, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** @param {unknown} value @param {PropertyKey} key @returns {unknown} */
function ownData(value, key) {
  if (!isRecord(value)) throw configurationError();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw configurationError();
  return descriptor.value;
}

/** @param {unknown} value @param {readonly string[]} keys */
function exactRecord(value, keys) {
  if (!isRecord(value) || Array.isArray(value)) throw configurationError();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw configurationError();
  }
}

/** @param {unknown} value @param {number} maximum @returns {string} */
function identifier(value, maximum) {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum) {
    throw configurationError();
  }
  return value;
}

/** @param {unknown} value @param {number} maximum @returns {unknown[]} */
function denseArray(value, maximum) {
  if (!Array.isArray(value)) throw configurationError();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw configurationError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys[keys.length - 1] !== "length") throw configurationError();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw configurationError();
    result.push(descriptor.value);
  }
  return result;
}

/** @param {unknown} value @returns {value is object | Function} */
function identityReference(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** @param {unknown} checkCreator @param {"assertHealthy" | "snapshot"} key @returns {Function} */
function creatorMethod(checkCreator, key) {
  if (typeof checkCreator !== "object" || checkCreator === null || Array.isArray(checkCreator)) {
    throw configurationError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(checkCreator, key);
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw configurationError();
  }
  return descriptor.value;
}

/** @param {unknown} value @returns {ErrorCell} */
function parseErrorCell(value) {
  if (!isRecord(value) || Array.isArray(value)) throw runtimeError("invalid_error_cell");
  const presentDescriptor = Object.getOwnPropertyDescriptor(value, "present");
  if (!presentDescriptor || !("value" in presentDescriptor) || typeof presentDescriptor.value !== "boolean") {
    throw runtimeError("invalid_error_cell");
  }
  const present = presentDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (!present) {
    if (keys.length !== 1 || keys[0] !== "present") throw runtimeError("invalid_error_cell");
    return Object.freeze({ present: false });
  }
  const valueDescriptor = Object.getOwnPropertyDescriptor(value, "value");
  if (!valueDescriptor || !("value" in valueDescriptor) ||
      keys.length !== 2 || !keys.includes("present") || !keys.includes("value")) {
    throw runtimeError("invalid_error_cell");
  }
  return Object.freeze({ present: true, value: valueDescriptor.value });
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} code @returns {Record<PropertyKey, unknown>} */
function runtimeRecord(value, keys, code) {
  if (!isRecord(value) || Array.isArray(value)) throw runtimeError(code);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw runtimeError(code);
  }
  return value;
}

/** @param {Record<PropertyKey, unknown>} value @param {PropertyKey} key @param {string} code @returns {unknown} */
function runtimeOwn(value, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw runtimeError(code);
  return descriptor.value;
}

/** @param {unknown} value @param {number} maximum @param {string} code @returns {unknown[]} */
function runtimeArray(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw runtimeError(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") throw runtimeError(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw runtimeError(code);
    result.push(descriptor.value);
  }
  return result;
}

/** @param {unknown} value @param {string} code @returns {boolean} */
function booleanValue(value, code) {
  if (typeof value !== "boolean") throw runtimeError(code);
  return value;
}

/** @param {unknown} value @param {number} minimum @param {number} maximum @param {string} code @returns {number} */
function integerValue(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < minimum || /** @type {number} */ (value) > maximum) {
    throw runtimeError(code);
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} code @returns {ErrorCell} */
function validateErrorCell(value, code) {
  const record = runtimeRecord(value, Reflect.ownKeys(/** @type {object} */ (value)).includes("value")
    ? ["present", "value"] : ["present"], code);
  const present = booleanValue(runtimeOwn(record, "present", code), code);
  if (present) {
    if (Reflect.ownKeys(record).length !== 2 || !Reflect.ownKeys(record).includes("value")) throw runtimeError(code);
    return Object.freeze({ present: true, value: runtimeOwn(record, "value", code) });
  }
  if (Reflect.ownKeys(record).length !== 1) throw runtimeError(code);
  return Object.freeze({ present: false });
}

/**
 * Copies an actual, non-shared Uint8Array without consulting caller-overridable
 * length, byteLength, iterator, constructor, or species properties.
 * @param {unknown} value
 */
function copyUint8(value) {
  let tag;
  let length;
  let byteLength;
  let byteOffset;
  let buffer;
  try {
    tag = Reflect.apply(typedArrayTag, value, []);
    length = Reflect.apply(typedArrayLength, value, []);
    byteLength = Reflect.apply(typedArrayByteLength, value, []);
    byteOffset = Reflect.apply(typedArrayByteOffset, value, []);
    buffer = Reflect.apply(typedArrayBuffer, value, []);
    Reflect.apply(arrayBufferByteLength, buffer, []);
  } catch {
    throw runtimeError("invalid_chunk");
  }
  if (tag !== "Uint8Array" || !Number.isSafeInteger(length) || length <= 0 ||
      byteLength !== length || !Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
      byteLength > MAX_CHUNK_BYTES) {
    throw runtimeError("invalid_chunk");
  }
  const copy = new Uint8Array(length);
  try {
    Reflect.apply(uint8Set, copy, [value]);
  } catch {
    throw runtimeError("invalid_chunk");
  }
  return copy;
}

/** @param {Uint8Array} bytes @returns {string} */
function ascii(bytes) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined || byte > 0x7f) throw runtimeError("invalid_ascii_frame");
    result += String.fromCharCode(byte);
  }
  return result;
}

/** @param {unknown} snapshot @returns {any} */
function validateGuardSnapshot(snapshot) {
  const code = "invalid_creator_snapshot";
  const record = runtimeRecord(snapshot, [
    "closed", "failed", "inFlight", "firstError", "firstFailureStage", "budget", "facts", "slots",
  ], code);
  const closed = booleanValue(runtimeOwn(record, "closed", code), code);
  const failed = booleanValue(runtimeOwn(record, "failed", code), code);
  const inFlight = integerValue(runtimeOwn(record, "inFlight", code), 0, 1, code);
  const firstError = validateErrorCell(runtimeOwn(record, "firstError", code), code);
  const firstFailureStage = runtimeOwn(record, "firstFailureStage", code);
  if (firstFailureStage !== null && (typeof firstFailureStage !== "string" || firstFailureStage.length > 128)) {
    throw runtimeError(code);
  }
  if (failed !== firstError.present || (failed === false && firstFailureStage !== null)) throw runtimeError(code);

  const budget = runtimeRecord(runtimeOwn(record, "budget", code),
    ["slots", "facts", "writes", "frameBytes", "totalBytes"], code);
  /** @type {[string, number, boolean][]} */
  const budgetSpec = [
    ["slots", 8, true], ["facts", 32, true], ["writes", 32, true],
    ["frameBytes", 256, false], ["totalBytes", 8192, true],
  ];
  /** @type {Record<string, any>} */
  const budgets = {};
  for (const [name, limit, used] of budgetSpec) {
    const keys = used ? ["used", "limit", "overflow"] : ["limit", "overflow"];
    const item = runtimeRecord(runtimeOwn(budget, name, code), keys, code);
    if (runtimeOwn(item, "limit", code) !== limit) throw runtimeError(code);
    const overflow = booleanValue(runtimeOwn(item, "overflow", code), code);
    const usedValue = used ? integerValue(runtimeOwn(item, "used", code), 0, Number(limit), code) : null;
    budgets[String(name)] = { used: usedValue, overflow };
  }

  const facts = runtimeArray(runtimeOwn(record, "facts", code), 32, code).map((entry) => {
    const fact = runtimeRecord(entry, ["kind", "slotId"], code);
    const kind = runtimeOwn(fact, "kind", code);
    const slotId = runtimeOwn(fact, "slotId", code);
    if (typeof kind !== "string" || kind.length > 64 ||
        (slotId !== null && (!Number.isSafeInteger(slotId) || /** @type {number} */ (slotId) < 1 || /** @type {number} */ (slotId) > 8))) {
      throw runtimeError(code);
    }
    return { kind, slotId };
  });
  const slots = runtimeArray(runtimeOwn(record, "slots", code), 8, code).map((entry, index) => {
    const slot = runtimeRecord(entry, [
      "id", "receiver", "observerInstalled", "reserveWritten", "nativeEntered", "nativeReturn", "nativeThrow",
      "boundAttempted", "boundWritten", "closeObserved", "errorObservations",
    ], code);
    const id = integerValue(runtimeOwn(slot, "id", code), 1, 8, code);
    const receiver = runtimeOwn(slot, "receiver", code);
    if (id !== index + 1 || !identityReference(receiver)) throw runtimeError(code);
    const nativeReturn = validateErrorCell(runtimeOwn(slot, "nativeReturn", code), code);
    const nativeThrow = validateErrorCell(runtimeOwn(slot, "nativeThrow", code), code);
    return {
      id,
      receiver,
      observerInstalled: booleanValue(runtimeOwn(slot, "observerInstalled", code), code),
      reserveWritten: booleanValue(runtimeOwn(slot, "reserveWritten", code), code),
      nativeEntered: booleanValue(runtimeOwn(slot, "nativeEntered", code), code),
      nativeReturn,
      nativeThrow,
      boundAttempted: booleanValue(runtimeOwn(slot, "boundAttempted", code), code),
      boundWritten: booleanValue(runtimeOwn(slot, "boundWritten", code), code),
      closeObserved: booleanValue(runtimeOwn(slot, "closeObserved", code), code),
      errorObservations: integerValue(runtimeOwn(slot, "errorObservations", code), 0, 32, code),
    };
  });
  if (budgets.slots.used !== slots.length || budgets.facts.used !== facts.length) throw runtimeError(code);
  return { closed, failed, inFlight, firstError, firstFailureStage, budgets, facts, slots };
}

/** @param {unknown} snapshot @returns {any} */
function validateCreatorSnapshot(snapshot) {
  const code = "invalid_creator_snapshot";
  const record = runtimeRecord(snapshot, [
    "protocol", "failed", "bridgeFailed", "firstError", "firstFailureStage", "guard", "closed", "inFlight",
    "gateReported", "terminalReported", "wireSequence", "packetAttempts", "bytesRequested", "budget", "slots", "diagnostics",
  ], code);
  if (runtimeOwn(record, "protocol", code) !== "creator-stream/v1") throw runtimeError(code);
  const failed = booleanValue(runtimeOwn(record, "failed", code), code);
  const bridgeFailed = booleanValue(runtimeOwn(record, "bridgeFailed", code), code);
  const firstError = validateErrorCell(runtimeOwn(record, "firstError", code), code);
  const firstFailureStage = runtimeOwn(record, "firstFailureStage", code);
  if (firstFailureStage !== null && (typeof firstFailureStage !== "string" || firstFailureStage.length > 128)) throw runtimeError(code);
  const guard = validateGuardSnapshot(runtimeOwn(record, "guard", code));
  const closed = booleanValue(runtimeOwn(record, "closed", code), code);
  const inFlight = integerValue(runtimeOwn(record, "inFlight", code), 0, 1, code);
  const gateReported = booleanValue(runtimeOwn(record, "gateReported", code), code);
  const terminalReported = booleanValue(runtimeOwn(record, "terminalReported", code), code);
  const wireSequence = integerValue(runtimeOwn(record, "wireSequence", code), 0, 32, code);
  const packetAttempts = integerValue(runtimeOwn(record, "packetAttempts", code), 0, 32, code);
  const bytesRequested = integerValue(runtimeOwn(record, "bytesRequested", code), 0, 8192, code);
  if (failed !== (bridgeFailed || guard.failed) || closed !== guard.closed || inFlight !== guard.inFlight ||
      wireSequence !== packetAttempts || (failed === false && firstError.present) ||
      (failed === false && firstFailureStage !== null)) {
    throw runtimeError(code);
  }

  const budget = runtimeRecord(runtimeOwn(record, "budget", code),
    ["slots", "packets", "packetBytes", "totalBytes", "diagnostics"], code);
  const slotBudget = runtimeRecord(runtimeOwn(budget, "slots", code), ["used", "limit"], code);
  const packetsBudget = runtimeRecord(runtimeOwn(budget, "packets", code), ["used", "limit", "overflow"], code);
  const packetBytesBudget = runtimeRecord(runtimeOwn(budget, "packetBytes", code), ["limit", "overflow"], code);
  const totalBytesBudget = runtimeRecord(runtimeOwn(budget, "totalBytes", code), ["used", "limit", "overflow"], code);
  const diagnosticsBudget = runtimeRecord(runtimeOwn(budget, "diagnostics", code), ["used", "limit", "overflow"], code);
  if (runtimeOwn(slotBudget, "limit", code) !== 8 || runtimeOwn(packetsBudget, "limit", code) !== 32 ||
      runtimeOwn(packetBytesBudget, "limit", code) !== 256 || runtimeOwn(totalBytesBudget, "limit", code) !== 8192 ||
      runtimeOwn(diagnosticsBudget, "limit", code) !== 32) throw runtimeError(code);
  const overflow = [
    runtimeOwn(packetsBudget, "overflow", code), runtimeOwn(packetBytesBudget, "overflow", code),
    runtimeOwn(totalBytesBudget, "overflow", code), runtimeOwn(diagnosticsBudget, "overflow", code),
  ].map((item) => booleanValue(item, code));

  const slots = runtimeArray(runtimeOwn(record, "slots", code), 8, code).map((entry, index) => {
    const slot = runtimeRecord(entry,
      ["slotId", "receiver", "reserveReported", "boundReported", "closeReported"], code);
    const slotId = integerValue(runtimeOwn(slot, "slotId", code), 1, 8, code);
    const receiver = runtimeOwn(slot, "receiver", code);
    if (slotId !== index + 1 || !identityReference(receiver)) throw runtimeError(code);
    return {
      slotId,
      receiver,
      reserveReported: booleanValue(runtimeOwn(slot, "reserveReported", code), code),
      boundReported: booleanValue(runtimeOwn(slot, "boundReported", code), code),
      closeReported: booleanValue(runtimeOwn(slot, "closeReported", code), code),
    };
  });
  const diagnostics = runtimeArray(runtimeOwn(record, "diagnostics", code), 32, code).map((entry) => {
    const item = runtimeRecord(entry, ["kind", "sequence", "slotId"], code);
    const kind = runtimeOwn(item, "kind", code);
    const sequence = runtimeOwn(item, "sequence", code);
    const slotId = runtimeOwn(item, "slotId", code);
    if (typeof kind !== "string" || kind.length > 64 ||
        (sequence !== null && (!Number.isSafeInteger(sequence) || /** @type {number} */ (sequence) < 1 || /** @type {number} */ (sequence) > 32)) ||
        (slotId !== null && (!Number.isSafeInteger(slotId) || /** @type {number} */ (slotId) < 1 || /** @type {number} */ (slotId) > 8))) {
      throw runtimeError(code);
    }
    return { kind, sequence, slotId };
  });
  if (runtimeOwn(slotBudget, "used", code) !== slots.length || runtimeOwn(packetsBudget, "used", code) !== packetAttempts ||
      runtimeOwn(totalBytesBudget, "used", code) !== bytesRequested || runtimeOwn(diagnosticsBudget, "used", code) !== diagnostics.length) {
    throw runtimeError(code);
  }
  // A1 registers the original receiver before observer installation / R writes.
  // Only that one in-flight, not-yet-reserved tail may lack a bridge report.
  if (guard.slots.length !== slots.length) {
    const tail = guard.slots[slots.length];
    if (failed || inFlight !== 1 || guard.slots.length !== slots.length + 1 ||
        !tail || tail.reserveWritten || tail.nativeEntered || tail.nativeReturn.present ||
        tail.nativeThrow.present || tail.boundAttempted || tail.boundWritten ||
        tail.closeObserved || tail.errorObservations !== 0 || gateReported || terminalReported) {
      throw runtimeError(code);
    }
  }
  for (let index = 0; index < slots.length; index += 1) {
    const bridgeSlot = slots[index];
    const guardSlot = guard.slots[index];
    if (bridgeSlot.receiver !== guardSlot.receiver || bridgeSlot.reserveReported !== guardSlot.reserveWritten ||
        bridgeSlot.boundReported !== guardSlot.boundWritten || bridgeSlot.closeReported && !guardSlot.closeObserved) {
      throw runtimeError(code);
    }
  }
  return {
    failed, bridgeFailed, firstError, firstFailureStage, guard, closed, inFlight, gateReported, terminalReported,
    wireSequence, packetAttempts, bytesRequested, overflow, slots, diagnostics,
  };
}

/** @param {unknown} snapshot @param {readonly ReceiverSource[]} sources @param {string} caseId @returns {any} */
function validateQ1Snapshot(snapshot, sources, caseId) {
  const code = "invalid_q1_snapshot";
  const record = runtimeRecord(snapshot, [
    "lifecycle", "adapterStatus", "authority", "stopDomain", "eventCount", "errorCount", "ordinaryErrorCount",
    "reclaimTerminalErrorCount", "overflow", "protocolDamaged", "executionDomainEnded", "cases", "writers", "resources",
    "execution", "reclaim", "result",
  ], code);
  const lifecycle = runtimeOwn(record, "lifecycle", code);
  if (!["allocated", "running", "closing", "removed"].includes(/** @type {string} */ (lifecycle)) ||
      runtimeOwn(record, "adapterStatus", code) !== "not-implemented" ||
      runtimeOwn(record, "authority", code) !== "diagnostic-candidates-only" ||
      runtimeOwn(record, "stopDomain", code) !== "execution-tree") throw runtimeError(code);
  const eventCount = integerValue(runtimeOwn(record, "eventCount", code), 0, 128, code);
  const errorCount = integerValue(runtimeOwn(record, "errorCount", code), 0, 33, code);
  const ordinaryErrorCount = integerValue(runtimeOwn(record, "ordinaryErrorCount", code), 0, 32, code);
  const reclaimTerminalErrorCount = integerValue(runtimeOwn(record, "reclaimTerminalErrorCount", code), 0, 1, code);
  if (errorCount !== ordinaryErrorCount + reclaimTerminalErrorCount) throw runtimeError(code);
  const overflowRecord = runtimeRecord(runtimeOwn(record, "overflow", code),
    ["events", "resources", "stopAttempts", "errors"], code);
  const overflow = ["events", "resources", "stopAttempts", "errors"].map((key) =>
    booleanValue(runtimeOwn(overflowRecord, key, code), code));
  const protocolDamaged = booleanValue(runtimeOwn(record, "protocolDamaged", code), code);
  const executionDomainEnded = booleanValue(runtimeOwn(record, "executionDomainEnded", code), code);

  const cases = runtimeArray(runtimeOwn(record, "cases", code), 1, code);
  if (cases.length !== 1) throw runtimeError(code);
  const caseRecord = runtimeRecord(cases[0], ["caseId", "begun", "result", "stops"], code);
  if (runtimeOwn(caseRecord, "caseId", code) !== caseId ||
      typeof runtimeOwn(caseRecord, "result", code) !== "string" ||
      runtimeArray(runtimeOwn(caseRecord, "stops", code), 0, code).length !== 0) throw runtimeError(code);
  const caseBegun = booleanValue(runtimeOwn(caseRecord, "begun", code), code);
  const caseResult = runtimeOwn(caseRecord, "result", code);
  if (!["missing", "pass", "failure", "interrupted"].includes(/** @type {string} */ (caseResult))) throw runtimeError(code);

  const writers = runtimeArray(runtimeOwn(record, "writers", code), 2, code).map((entry, index) => {
    const writer = runtimeRecord(entry, ["writerId", "nextSequence", "eof", "damaged"], code);
    if (runtimeOwn(writer, "writerId", code) !== sources[index]?.writerId) throw runtimeError(code);
    return {
      writerId: runtimeOwn(writer, "writerId", code),
      nextSequence: integerValue(runtimeOwn(writer, "nextSequence", code), 1, 33, code),
      eof: booleanValue(runtimeOwn(writer, "eof", code), code),
      damaged: booleanValue(runtimeOwn(writer, "damaged", code), code),
    };
  });
  if (writers.length !== sources.length) throw runtimeError(code);

  const resources = runtimeArray(runtimeOwn(record, "resources", code), 16, code).map((entry, index) => {
    const resource = runtimeRecord(entry, [
      "ordinal", "caseId", "kind", "state", "hasOriginalHandleKey", "hasPidMetadata", "closeObserved", "groupState",
      "bindingUncertain", "groupIdentityUncertain",
    ], code);
    const ordinal = integerValue(runtimeOwn(resource, "ordinal", code), 1, 16, code);
    const kind = runtimeOwn(resource, "kind", code);
    const state = runtimeOwn(resource, "state", code);
    const groupState = runtimeOwn(resource, "groupState", code);
    if (ordinal !== index + 1 || runtimeOwn(resource, "caseId", code) !== caseId ||
        !["execution-child", "detached-group"].includes(/** @type {string} */ (kind)) ||
        !["reserved", "bound", "close-observed", "proven-not-created", "protocol-uncertain"].includes(/** @type {string} */ (state)) ||
        !["unknown", "alive", "gone", "not-applicable"].includes(/** @type {string} */ (groupState))) throw runtimeError(code);
    return {
      ordinal, kind, state, groupState,
      hasOriginalHandleKey: booleanValue(runtimeOwn(resource, "hasOriginalHandleKey", code), code),
      hasPidMetadata: booleanValue(runtimeOwn(resource, "hasPidMetadata", code), code),
      closeObserved: booleanValue(runtimeOwn(resource, "closeObserved", code), code),
      bindingUncertain: booleanValue(runtimeOwn(resource, "bindingUncertain", code), code),
      groupIdentityUncertain: booleanValue(runtimeOwn(resource, "groupIdentityUncertain", code), code),
    };
  });

  const executionRecord = runtimeRecord(runtimeOwn(record, "execution", code),
    ["closeObserved", "endKind", "exitCode", "hasSignal", "groupState", "groupIdentityUncertain"], code);
  const execution = {
    closeObserved: booleanValue(runtimeOwn(executionRecord, "closeObserved", code), code),
    endKind: runtimeOwn(executionRecord, "endKind", code),
    exitCode: runtimeOwn(executionRecord, "exitCode", code),
    hasSignal: booleanValue(runtimeOwn(executionRecord, "hasSignal", code), code),
    groupState: runtimeOwn(executionRecord, "groupState", code),
    groupIdentityUncertain: booleanValue(runtimeOwn(executionRecord, "groupIdentityUncertain", code), code),
  };
  if (![null, "natural", "early-exit", "forced"].includes(/** @type {any} */ (execution.endKind)) ||
      (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) ||
      !["unknown", "alive", "gone"].includes(/** @type {string} */ (execution.groupState))) throw runtimeError(code);

  const reclaimRecord = runtimeRecord(runtimeOwn(record, "reclaim", code),
    ["currentStatus", "currentOutcome", "currentTimeouts", "attempts", "failures"], code);
  const reclaim = {
    currentStatus: runtimeOwn(reclaimRecord, "currentStatus", code),
    currentOutcome: runtimeOwn(reclaimRecord, "currentOutcome", code),
    currentTimeouts: integerValue(runtimeOwn(reclaimRecord, "currentTimeouts", code), 0, Number.MAX_SAFE_INTEGER, code),
    attempts: integerValue(runtimeOwn(reclaimRecord, "attempts", code), 0, 1, code),
    failures: integerValue(runtimeOwn(reclaimRecord, "failures", code), 0, 1, code),
  };
  if (reclaim.currentStatus !== "not-requested" || reclaim.currentOutcome !== null || reclaim.attempts !== 0) {
    throw runtimeError(code);
  }

  const resultRecord = runtimeRecord(runtimeOwn(record, "result", code), [
    "blockers", "casePass", "stopPass", "normalExecutionEnd", "executionPassCandidate", "physicalEndCandidate",
    "reclaimCandidate", "reclaimSucceeded", "integrityPass", "overallPass",
  ], code);
  const blockers = runtimeArray(runtimeOwn(resultRecord, "blockers", code), 128, code).map((item) => {
    if (typeof item !== "string" || item.length > 128) throw runtimeError(code);
    return item;
  });
  const result = {
    blockers,
    casePass: booleanValue(runtimeOwn(resultRecord, "casePass", code), code),
    stopPass: booleanValue(runtimeOwn(resultRecord, "stopPass", code), code),
    normalExecutionEnd: booleanValue(runtimeOwn(resultRecord, "normalExecutionEnd", code), code),
    executionPassCandidate: booleanValue(runtimeOwn(resultRecord, "executionPassCandidate", code), code),
    physicalEndCandidate: booleanValue(runtimeOwn(resultRecord, "physicalEndCandidate", code), code),
    reclaimCandidate: booleanValue(runtimeOwn(resultRecord, "reclaimCandidate", code), code),
    reclaimSucceeded: booleanValue(runtimeOwn(resultRecord, "reclaimSucceeded", code), code),
    integrityPass: booleanValue(runtimeOwn(resultRecord, "integrityPass", code), code),
    overallPass: booleanValue(runtimeOwn(resultRecord, "overallPass", code), code),
  };
  return {
    lifecycle, eventCount, overflow, protocolDamaged, executionDomainEnded, caseBegun, caseResult,
    writers, resources, execution, reclaim, result,
  };
}

/**
 * Pure in-memory receiver for the reviewed creator bridge. `creatorOwner` and
 * `readStream` are local association identities only. Likewise, receiver-owned
 * resource and handle keys associate Q1 model facts; they are not remote
 * ChildProcess handles or OS identity. `checkCreator` is expected to be the
 * original bridge object supplied by the controlled fixture/wiring site. This
 * receiver captures its two own methods but performs no runtime brand or
 * provenance authentication, and finite repeated checks cannot prove an
 * arbitrary malicious closure current.
 *
 * @param {unknown} configuration
 */
export function createQuiescenceReceiver(configuration) {
  exactRecord(configuration, ["caseId", "sources"]);
  const caseId = identifier(ownData(configuration, "caseId"), MAX_IDENTIFIER_LENGTH);
  const rawSources = denseArray(ownData(configuration, "sources"), MAX_SOURCES);
  if (rawSources.length < 1) throw configurationError();

  const writerIds = new Set();
  const owners = new Set();
  const streams = new Set();
  /** @type {ReceiverSource[]} */
  const sources = rawSources.map((raw) => {
    exactRecord(raw, ["writerId", "creatorOwner", "readStream", "slotKinds", "checkCreator"]);
    const writerId = identifier(ownData(raw, "writerId"), MAX_IDENTIFIER_LENGTH);
    const creatorOwner = ownData(raw, "creatorOwner");
    const readStream = ownData(raw, "readStream");
    const checkCreator = ownData(raw, "checkCreator");
    if (!identityReference(creatorOwner) || !identityReference(readStream) ||
        writerIds.has(writerId) || owners.has(creatorOwner) || streams.has(readStream)) throw configurationError();
    writerIds.add(writerId);
    owners.add(creatorOwner);
    streams.add(readStream);
    const slotKinds = denseArray(ownData(raw, "slotKinds"), MAX_SLOTS).map((kind) => {
      if (kind !== "execution-child" && kind !== "detached-group") throw configurationError();
      return kind;
    });
    const assertHealthy = creatorMethod(checkCreator, "assertHealthy");
    const snapshot = creatorMethod(checkCreator, "snapshot");
    return {
      writerId,
      creatorOwner,
      readStream,
      slotKinds: Object.freeze(slotKinds),
      checkCreator: /** @type {object} */ (checkCreator),
      assertHealthy,
      snapshot,
      slots: [],
      wireNext: 1,
      q1Next: 1,
      frames: 0,
      bytes: 0,
      residual: new Uint8Array(0),
      gate: false,
      terminal: false,
      ended: false,
      eofAttempted: false,
    };
  });

  /** @type {ReceiverSlot[]} */
  const resourceOrder = [];

  const q1 = createPmSdkQuiescenceState({
    stopDomain: "execution-tree",
    expectedCases: [{ id: caseId, stops: [] }],
    expectedWriters: sources.map((source) => source.writerId),
    limits: {
      maxEvents: 128,
      maxResources: 16,
      maxErrors: 32,
      maxStopAttempts: 1,
      maxCases: 1,
      maxStops: 1,
      maxWriters: 2,
      maxIdentifierLength: 64,
    },
  });
  const auth = q1.credentials;

  let busy = false;
  let receiverFailed = false;
  /** @type {ErrorCell} */
  let firstFailure = Object.freeze({ present: false });
  /** @type {string[]} */
  const diagnostics = [];
  let diagnosticsOverflow = false;
  let started = false;
  let startAttempted = false;
  let closingRequested = false;
  let q1Closing = false;
  let q1ClosingAttempted = false;
  let caseResultRecorded = false;
  let caseResultSubmitted = false;
  let caseResultAttempted = false;
  /** @type {null | { outcome: "pass" | "failure" | "interrupted", error: ErrorCell }} */
  let caseResult = null;
  let groupObservations = 0;

  /** @param {string} code */
  function diagnostic(code) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) diagnosticsOverflow = true;
    else diagnostics.push(code);
  }

  /** @param {string} code @param {boolean} [hasValue] @param {unknown} [value] */
  function latchFailure(code, hasValue = false, value = undefined) {
    receiverFailed = true;
    if (!firstFailure.present) {
      firstFailure = Object.freeze({ present: true, value: hasValue ? value : runtimeError(code) });
    }
    diagnostic(code);
  }

  /** @param {unknown} owner @param {unknown} stream @returns {ReceiverSource} */
  function sourceFor(owner, stream) {
    const source = sources.find((candidate) => candidate.creatorOwner === owner && candidate.readStream === stream);
    if (!source) throw runtimeError("unknown_source_pair");
    return source;
  }

  function maybeDrain() {
    if (!closingRequested || !sources.every((source) => source.gate)) return;
    if (!q1ClosingAttempted) {
      q1ClosingAttempted = true;
      q1.beginClosing(auth, { reason: "receiver-drained" });
      q1Closing = true;
    }
    if (caseResultRecorded && !caseResultAttempted) {
      caseResultAttempted = true;
      q1.recordCaseResult(auth, { caseId, outcome: caseResult?.outcome, error: caseResult?.error });
      caseResultSubmitted = true;
    }
  }

  /** @param {ReceiverSource} source @param {string} frame */
  function processFrame(source, frame) {
    const reserve = /^R:([1-9][0-9]*):([1-9][0-9]*)\n$/u.exec(frame);
    const bound = /^B:([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)\n$/u.exec(frame);
    const close = /^C:([1-9][0-9]*):([1-9][0-9]*)\n$/u.exec(frame);
    const gate = /^G:([1-9][0-9]*)\n$/u.exec(frame);
    const terminal = /^T:([1-9][0-9]*)\n$/u.exec(frame);
    const match = reserve ?? bound ?? close ?? gate ?? terminal;
    if (!match) throw runtimeError("invalid_frame");
    const wireSequence = Number(match[1]);
    if (!Number.isSafeInteger(wireSequence) || wireSequence !== source.wireNext || wireSequence > MAX_FRAMES) {
      throw runtimeError("wire_sequence_rejected");
    }
    source.wireNext += 1;

    if (reserve) {
      if (source.gate || source.terminal) throw runtimeError("reserve_after_gate");
      const slot = Number(reserve[2]);
      if (slot !== source.slots.length + 1 || slot > source.slotKinds.length) throw runtimeError("slot_reservation_rejected");
      const resourceKey = Object.freeze(Object.create(null));
      const handleKey = Object.freeze(Object.create(null));
      const receiverSlot = {
        slot,
        ordinal: resourceOrder.length + 1,
        kind: source.slotKinds[slot - 1],
        resourceKey,
        handleKey,
        pid: null,
        bound: false,
        closed: false,
      };
      q1.reserveResource(auth, {
        caseId,
        resourceKey,
        kind: receiverSlot.kind,
        writerId: source.writerId,
        sequence: source.q1Next,
      });
      source.q1Next += 1;
      resourceOrder.push(receiverSlot);
      source.slots.push(receiverSlot);
      return;
    }
    if (bound) {
      if (source.gate || source.terminal) throw runtimeError("bind_after_gate");
      const slot = Number(bound[2]);
      const pid = Number(bound[3]);
      const current = source.slots[slot - 1];
      if (!Number.isSafeInteger(pid) || pid <= 0 || !current || current.slot !== slot || current.bound) {
        throw runtimeError("slot_binding_rejected");
      }
      q1.bindResource(auth, {
        resourceKey: current.resourceKey,
        handleKey: current.handleKey,
        pid,
        writerId: source.writerId,
        sequence: source.q1Next,
      });
      source.q1Next += 1;
      current.pid = pid;
      current.bound = true;
      return;
    }
    if (close) {
      const slot = Number(close[2]);
      const current = source.slots[slot - 1];
      if (!current || current.slot !== slot || !current.bound || current.closed) throw runtimeError("slot_close_rejected");
      q1.observeResourceClose(auth, {
        resourceKey: current.resourceKey,
        handleKey: current.handleKey,
        writerId: source.writerId,
        sequence: source.q1Next,
      });
      source.q1Next += 1;
      current.closed = true;
      return;
    }
    if (gate) {
      if (source.gate || source.terminal || source.slots.some((slot) => !slot.bound)) throw runtimeError("gate_rejected");
      source.gate = true;
      maybeDrain();
      return;
    }
    if (terminal) {
      if (!source.gate || source.terminal || source.slots.some((slot) => !slot.closed)) throw runtimeError("terminal_rejected");
      source.terminal = true;
    }
  }

  /** @template T @param {"normal" | "conclude"} kind @param {() => T} operation @returns {T | Readonly<{status:"failed"}>} */
  function enter(kind, operation) {
    if (busy) {
      latchFailure("reentrant_call");
      return failedResult;
    }
    if (receiverFailed && kind === "normal") return failedResult;
    busy = true;
    try {
      return operation();
    } catch (error) {
      latchFailure("operation_rejected", true, error);
      return failedResult;
    } finally {
      busy = false;
    }
  }

  function start() {
    return enter("normal", () => {
      if (startAttempted) throw runtimeError("start_repeated");
      startAttempted = true;
      q1.beginRun(auth);
      q1.beginCase(auth, caseId);
      started = true;
      return okResult;
    });
  }

  function requestClosing() {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      closingRequested = true;
      maybeDrain();
      return okResult;
    });
  }

  /** @param {unknown} owner @param {unknown} stream @param {unknown} bytes */
  function accept(owner, stream, bytes) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      const source = sourceFor(owner, stream);
      if (source.terminal || source.ended) throw runtimeError("data_after_terminal");
      const chunk = copyUint8(bytes);
      if (source.bytes + chunk.length > MAX_TOTAL_BYTES) throw runtimeError("source_byte_budget");
      source.bytes += chunk.length;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] > 0x7f) throw runtimeError("invalid_ascii_frame");
      }
      const combined = new Uint8Array(source.residual.length + chunk.length);
      Reflect.apply(uint8Set, combined, [source.residual, 0]);
      Reflect.apply(uint8Set, combined, [chunk, source.residual.length]);
      let startIndex = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const frameLength = index - startIndex + 1;
        if (frameLength > MAX_FRAME_BYTES) throw runtimeError("frame_byte_budget");
        if (source.frames >= MAX_FRAMES) throw runtimeError("source_frame_budget");
        source.frames += 1;
        processFrame(source, ascii(combined.subarray(startIndex, index + 1)));
        if (receiverFailed) throw runtimeError("receiver_failed_during_frame");
        if (source.terminal && index + 1 < combined.length) throw runtimeError("data_after_terminal");
        startIndex = index + 1;
      }
      const remaining = combined.length - startIndex;
      if (remaining > MAX_RESIDUAL_BYTES) throw runtimeError("residual_byte_budget");
      source.residual = combined.slice(startIndex);
      return okResult;
    });
  }

  /** @param {unknown} owner @param {unknown} stream */
  function end(owner, stream) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      const source = sourceFor(owner, stream);
      if (source.eofAttempted || source.ended) throw runtimeError("end_repeated");
      source.eofAttempted = true;
      if (source.residual.length !== 0 || !source.gate || !source.terminal) throw runtimeError("incomplete_normal_end");
      q1.recordWriterEof(auth, {
        writerId: source.writerId,
        sequence: source.q1Next,
        completeFrame: true,
      });
      source.q1Next += 1;
      source.ended = true;
      return okResult;
    });
  }

  /** @param {unknown} owner @param {unknown} stream @param {unknown} error */
  function transportError(owner, stream, error) {
    return enter("normal", () => {
      sourceFor(owner, stream);
      latchFailure("transport_error", true, error);
      return failedResult;
    });
  }

  /** @param {unknown} fact */
  function recordCaseResult(fact) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      if (caseResultRecorded) throw runtimeError("case_result_repeated");
      const record = runtimeRecord(fact, ["outcome", "error"], "invalid_case_result");
      const outcome = runtimeOwn(record, "outcome", "invalid_case_result");
      if (outcome !== "pass" && outcome !== "failure" && outcome !== "interrupted") throw runtimeError("invalid_case_result");
      const error = parseErrorCell(runtimeOwn(record, "error", "invalid_case_result"));
      if ((outcome === "pass" && error.present) || (outcome !== "pass" && !error.present)) {
        throw runtimeError("invalid_case_result");
      }
      caseResult = Object.freeze({ outcome, error });
      caseResultRecorded = true;
      maybeDrain();
      return caseResultSubmitted ? okResult : pendingResult;
    });
  }

  /** @param {unknown} fact */
  function recordExecutionClose(fact) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      const record = runtimeRecord(fact, ["kind", "exitCode", "signal"], "invalid_execution_close");
      q1.recordExecutionClose(auth, {
        kind: runtimeOwn(record, "kind", "invalid_execution_close"),
        exitCode: runtimeOwn(record, "exitCode", "invalid_execution_close"),
        signal: runtimeOwn(record, "signal", "invalid_execution_close"),
      });
      return okResult;
    });
  }

  /** @param {unknown} fact */
  function observeExecutionGroup(fact) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      if (groupObservations >= MAX_GROUP_OBSERVATIONS) throw runtimeError("group_observation_budget");
      const record = runtimeRecord(fact, ["groupState"], "invalid_execution_group");
      groupObservations += 1;
      q1.observeExecutionGroup(auth, { groupState: runtimeOwn(record, "groupState", "invalid_execution_group") });
      return okResult;
    });
  }

  /** @param {unknown} owner @param {unknown} stream @param {unknown} slot @param {unknown} groupState */
  function observeResourceGroup(owner, stream, slot, groupState) {
    return enter("normal", () => {
      if (!started) throw runtimeError("receiver_not_started");
      const source = sourceFor(owner, stream);
      if (groupObservations >= MAX_GROUP_OBSERVATIONS) throw runtimeError("group_observation_budget");
      if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 1 || slot > 8) {
        throw runtimeError("invalid_resource_group");
      }
      const resource = source.slots[slot - 1];
      if (!resource || !resource.bound || resource.kind !== "detached-group") throw runtimeError("invalid_resource_group");
      groupObservations += 1;
      q1.observeResourceGroup(auth, {
        resourceKey: resource.resourceKey,
        handleKey: resource.handleKey,
        groupState,
      });
      return okResult;
    });
  }

  /** @param {any} q1Snapshot @param {any[]} creators */
  function terminalTransportMismatches(q1Snapshot, creators) {
    const expectedResources = resourceOrder;
    if (q1Snapshot.resources.length !== expectedResources.length) return true;
    for (let index = 0; index < expectedResources.length; index += 1) {
      const expected = expectedResources[index];
      const actual = q1Snapshot.resources[index];
      if (actual.ordinal !== expected.ordinal || actual.kind !== expected.kind || actual.state !== "close-observed" ||
          actual.hasOriginalHandleKey !== true || actual.hasPidMetadata !== true || actual.closeObserved !== true ||
          actual.bindingUncertain || actual.groupIdentityUncertain) return true;
    }
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const creator = creators[index];
      const writer = q1Snapshot.writers[index];
      if (creator.wireSequence !== source.wireNext - 1 || creator.packetAttempts !== source.frames ||
          creator.bytesRequested !== source.bytes || creator.slots.length !== source.slots.length ||
          writer.nextSequence !== source.q1Next || writer.eof !== source.ended || writer.damaged) return true;
      for (let slotIndex = 0; slotIndex < source.slots.length; slotIndex += 1) {
        const creatorSlot = creator.slots[slotIndex];
        if (!creatorSlot.reserveReported || !creatorSlot.boundReported || !creatorSlot.closeReported) return true;
      }
    }
    return false;
  }

  /** @param {"failed" | "incomplete" | "pure-model-candidate"} status @param {any} q1Snapshot @param {any[]} creators */
  function conclusion(status, q1Snapshot, creators) {
    const sourceViews = sources.map((source) => Object.freeze({
      writerId: source.writerId,
      frames: source.frames,
      bytes: source.bytes,
      residualBytes: source.residual.length,
      wireNext: source.wireNext,
      q1Next: source.q1Next,
      slots: source.slots.length,
      gate: source.gate,
      terminal: source.terminal,
      ended: source.ended,
    }));
    const first = firstFailure.present
      ? Object.freeze({ present: true, value: firstFailure.value })
      : Object.freeze({ present: false });
    const receiver = Object.freeze({
      failed: receiverFailed,
      firstFailure: first,
      diagnostics: Object.freeze([...diagnostics]),
      diagnosticsOverflow,
      started,
      closingRequested,
      q1Closing,
      caseResultRecorded,
      caseResultSubmitted,
      groupObservations,
      sources: Object.freeze(sourceViews),
    });
    const creatorViews = Object.freeze(creators.map((creator, index) => Object.freeze({
      writerId: sources[index]?.writerId,
      available: creator !== null,
      failed: creator?.failed ?? null,
      closed: creator?.closed ?? null,
      inFlight: creator?.inFlight ?? null,
      gateReported: creator?.gateReported ?? null,
      terminalReported: creator?.terminalReported ?? null,
      wireSequence: creator?.wireSequence ?? null,
      packetAttempts: creator?.packetAttempts ?? null,
      bytesRequested: creator?.bytesRequested ?? null,
      slots: creator?.slots.length ?? null,
    })));
    const q1View = q1Snapshot === null ? null : Object.freeze({
      lifecycle: q1Snapshot.lifecycle,
      eventCount: q1Snapshot.eventCount,
      protocolDamaged: q1Snapshot.protocolDamaged,
      overflow: Object.freeze([...q1Snapshot.overflow]),
      caseResult: q1Snapshot.caseResult,
      executionPassCandidate: q1Snapshot.result.executionPassCandidate,
      physicalEndCandidate: q1Snapshot.result.physicalEndCandidate,
      blockers: Object.freeze([...q1Snapshot.result.blockers]),
      writers: Object.freeze(q1Snapshot.writers.map((/** @type {any} */ writer) => Object.freeze({ ...writer }))),
      resources: q1Snapshot.resources.length,
    });
    const business = Object.freeze({
      outcome: caseResult?.outcome ?? "missing",
      executionPassCandidate: q1Snapshot?.result.executionPassCandidate ?? false,
    });
    return Object.freeze({ status, receiver, creators: creatorViews, q1: q1View, business });
  }

  function conclude() {
    const entered = enter("conclude", () => {
      if (receiverFailed) return conclusion("failed", null, sources.map(() => null));
      const initialRaw = q1.snapshot(auth);
      const initial = validateQ1Snapshot(initialRaw, sources, caseId);
      /** @type {any[]} */
      let creators = [];
      for (let round = 0; round < 2; round += 1) {
        creators = [];
        for (const source of sources) {
          const healthy = Reflect.apply(source.assertHealthy, source.checkCreator, []);
          if (healthy !== undefined) throw runtimeError("creator_health_result");
          const raw = Reflect.apply(source.snapshot, source.checkCreator, []);
          creators.push(validateCreatorSnapshot(raw));
        }
        if (receiverFailed) throw runtimeError("receiver_failed_during_conclude");
      }
      const latestRaw = q1.snapshot(auth);
      const latest = validateQ1Snapshot(latestRaw, sources, caseId);
      if (initial.eventCount !== latest.eventCount || initial.protocolDamaged !== latest.protocolDamaged ||
          initial.lifecycle !== latest.lifecycle) throw runtimeError("q1_changed_during_conclude");
      if (receiverFailed || latest.protocolDamaged || latest.overflow.some(Boolean) || creators.some((/** @type {any} */ creator) => creator.failed)) {
        if (!receiverFailed) latchFailure("unhealthy_terminal_state");
        return conclusion("failed", latest, creators);
      }

      const receiverTransportComplete = started &&
        sources.every((source) => source.gate && source.terminal && source.ended && source.residual.length === 0);
      const creatorsComplete = creators.every((/** @type {any} */ creator) => creator.closed && creator.inFlight === 0 &&
        creator.gateReported && creator.terminalReported && creator.overflow.every((/** @type {any} */ item) => item === false) &&
        creator.slots.every((/** @type {any} */ slot) => slot.reserveReported && slot.boundReported && slot.closeReported));
      if (receiverTransportComplete && creatorsComplete && terminalTransportMismatches(latest, creators)) {
        latchFailure("terminal_fact_mismatch");
        return conclusion("failed", latest, creators);
      }
      if (!receiverTransportComplete || !creatorsComplete || !closingRequested || !q1Closing ||
          !caseResultSubmitted || !latest.result.physicalEndCandidate) {
        return conclusion("incomplete", latest, creators);
      }
      return conclusion("pure-model-candidate", latest, creators);
    });
    if (entered === failedResult) return conclusion("failed", null, sources.map(() => null));
    return entered;
  }

  return Object.freeze({
    start,
    requestClosing,
    accept,
    end,
    transportError,
    recordCaseResult,
    recordExecutionClose,
    observeExecutionGroup,
    observeResourceGroup,
    conclude,
  });
}
