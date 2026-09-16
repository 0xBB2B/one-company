import { createPrototypeSpawnGuard } from "./pm-sdk-quiescence-adapter.mjs";

const MAX_SLOTS = 8;
const MAX_PACKET_ATTEMPTS = 32;
const MAX_PACKET_BYTES = 256;
const MAX_TOTAL_BYTES = 8192;
const MAX_DIAGNOSTICS = 32;
const BRIDGE_MESSAGE = "creator quiescence bridge rejected the operation";

/**
 * @typedef {{
 *   originalSpawn: (this: unknown, ...args: unknown[]) => unknown,
 *   installObserver: (receiver: object, callbacks: { onClose: () => void, onError: (error: unknown) => void }) => unknown,
 *   writePacket: (packet: Uint8Array) => unknown,
 * }} CreatorBridgeDependencies
 */

/** @returns {Error & { code: string }} */
function makeBridgeError() {
  return Object.assign(new Error(BRIDGE_MESSAGE), {
    name: "CreatorQuiescenceBridgeError",
    code: "ERR_CREATOR_QUIESCENCE_BRIDGE",
  });
}

/**
 * @param {unknown} dependencies
 * @param {keyof CreatorBridgeDependencies} name
 * @returns {Function}
 */
function readOwnFunction(dependencies, name) {
  if ((typeof dependencies !== "object" || dependencies === null) &&
      typeof dependencies !== "function") {
    throw makeBridgeError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
  if (descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "function") {
    throw makeBridgeError();
  }
  return descriptor.value;
}

/** @param {string} text */
function encodeAscii(text) {
  const packet = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      throw makeBridgeError();
    }
    packet[index] = code;
  }
  return packet;
}

/** @param {Uint8Array} frame */
function decodeAscii(frame) {
  let text = "";
  for (const byte of frame) {
    if (byte > 0x7f) {
      throw makeBridgeError();
    }
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * Creates the synchronous creator-side transport bridge around the reviewed
 * prototype spawn guard. The bridge reports local observations only; it does
 * not authenticate an OS source or grant cleanup authority.
 *
 * @param {unknown} dependencies
 */
export function createCreatorBridge(dependencies) {
  const originalSpawn = /** @type {CreatorBridgeDependencies["originalSpawn"]} */ (
    readOwnFunction(dependencies, "originalSpawn")
  );
  const installObserver = /** @type {CreatorBridgeDependencies["installObserver"]} */ (
    readOwnFunction(dependencies, "installObserver")
  );
  const writePacket = /** @type {CreatorBridgeDependencies["writePacket"]} */ (
    readOwnFunction(dependencies, "writePacket")
  );

  /** @type {{
   *   slotId: number,
   *   receiver: object,
   *   reserveReported: boolean,
   *   boundReported: boolean,
   *   closeReported: boolean,
   * }[]} */
  const reportedSlots = [];
  /** @type {{ kind: string, sequence: number | null, slotId: number | null }[]} */
  const diagnostics = [];

  /** @type {ReturnType<typeof createPrototypeSpawnGuard>} */
  let guard;
  let bridgeFailed = false;
  let firstErrorPresent = false;
  /** @type {unknown} */
  let firstErrorValue;
  /** @type {string | null} */
  let firstFailureStage = null;
  let writing = false;
  let flushing = false;
  let finishing = false;
  let gateReported = false;
  let terminalReported = false;
  let wireSequence = 0;
  let packetAttempts = 0;
  let bytesRequested = 0;
  let packetAttemptsOverflow = false;
  let packetBytesOverflow = false;
  let totalBytesOverflow = false;
  let diagnosticsOverflow = false;

  /**
   * @param {string} kind
   * @param {number | null} sequence
   * @param {number | null} slotId
   */
  function recordDiagnostic(kind, sequence, slotId) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      diagnosticsOverflow = true;
      return false;
    }
    diagnostics.push({ kind, sequence, slotId });
    return true;
  }

  /**
   * @param {unknown} error
   * @param {string} stage
   */
  function latchFailure(error, stage) {
    bridgeFailed = true;
    if (!firstErrorPresent) {
      firstErrorPresent = true;
      firstErrorValue = error;
      firstFailureStage = stage;
    }
    recordDiagnostic("failure", null, null);
    if (guard !== undefined) {
      try {
        guard.closeAdmission();
      } catch {
        // The original failure remains authoritative for this bridge.
      }
    }
  }

  /** @param {string} stage */
  function latchBridgeFailure(stage) {
    const error = makeBridgeError();
    latchFailure(error, stage);
    return error;
  }

  function guardSnapshot() {
    try {
      return guard.snapshot();
    } catch (error) {
      latchFailure(error, "guard-snapshot");
      return null;
    }
  }

  function healthyNow() {
    if (bridgeFailed) {
      return false;
    }
    const snapshot = guardSnapshot();
    return snapshot !== null && snapshot.failed === false;
  }

  /**
   * @param {string} textWithoutSequence
   * @param {string} kind
   * @param {number | null} slotId
   */
  function sendPacket(textWithoutSequence, kind, slotId) {
    if (writing || terminalReported ||
        (gateReported && (kind === "R" || kind === "B" || kind === "G"))) {
      throw latchBridgeFailure("packet-admission");
    }

    const nextSequence = wireSequence + 1;
    const text = textWithoutSequence.replace("{q}", String(nextSequence));
    const packet = encodeAscii(text);
    const expectedLength = packet.byteLength;

    if (nextSequence > MAX_PACKET_ATTEMPTS || packetAttempts + 1 > MAX_PACKET_ATTEMPTS) {
      packetAttemptsOverflow = true;
      throw latchBridgeFailure("packet-attempt-budget");
    }
    if (expectedLength > MAX_PACKET_BYTES) {
      packetBytesOverflow = true;
      throw latchBridgeFailure("packet-size-budget");
    }
    if (bytesRequested + expectedLength > MAX_TOTAL_BYTES) {
      totalBytesOverflow = true;
      throw latchBridgeFailure("packet-total-budget");
    }

    wireSequence = nextSequence;
    packetAttempts += 1;
    bytesRequested += expectedLength;
    recordDiagnostic(`packet-${kind}`, nextSequence, slotId);

    writing = true;
    /** @type {unknown} */
    let result;
    try {
      result = Reflect.apply(writePacket, undefined, [packet]);
    } catch (error) {
      latchFailure(error, `packet-${kind}-write`);
      throw error;
    } finally {
      writing = false;
    }

    if (!Number.isInteger(result) || result !== expectedLength) {
      throw latchBridgeFailure(`packet-${kind}-result`);
    }
    if (!healthyNow()) {
      throw makeBridgeError();
    }
  }

  /** @param {number} slotId */
  function localGuardSlot(slotId) {
    const owned = guard.owned();
    const candidate = owned[slotId - 1];
    if (candidate === undefined || candidate.id !== slotId) {
      throw latchBridgeFailure("guard-slot-mismatch");
    }
    return candidate;
  }

  /** @param {Uint8Array} frame */
  function writeFrame(frame) {
    if (writing || flushing || finishing) {
      throw latchBridgeFailure("write-frame-reentrant");
    }
    if (!(frame instanceof Uint8Array)) {
      throw latchBridgeFailure("guard-frame-type");
    }

    const oldLength = frame.byteLength;
    let text;
    try {
      text = decodeAscii(frame);
    } catch (error) {
      latchFailure(error, "guard-frame-ascii");
      throw error;
    }

    const reserve = /^R:([1-8])\n$/u.exec(text);
    if (reserve !== null) {
      const slotId = Number(reserve[1]);
      if (gateReported || terminalReported || slotId !== reportedSlots.length + 1) {
        throw latchBridgeFailure("reserve-order");
      }
      const local = localGuardSlot(slotId);
      if (reportedSlots.some((slot) => slot.slotId === slotId)) {
        throw latchBridgeFailure("reserve-duplicate");
      }
      sendPacket(`R:{q}:${slotId}\n`, "R", slotId);
      reportedSlots.push({
        slotId,
        receiver: /** @type {object} */ (local.receiver),
        reserveReported: true,
        boundReported: false,
        closeReported: false,
      });
      return oldLength;
    }

    const bound = /^B:([1-8]):([1-9][0-9]{0,15})\n$/u.exec(text);
    if (bound !== null) {
      const slotId = Number(bound[1]);
      const pid = Number(bound[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || gateReported || terminalReported) {
        throw latchBridgeFailure("bound-format");
      }
      const reported = reportedSlots[slotId - 1];
      const local = localGuardSlot(slotId);
      if (reported === undefined || !reported.reserveReported || reported.boundReported ||
          reported.receiver !== local.receiver || local.boundAttempted !== true ||
          local.reserveWritten !== true) {
        throw latchBridgeFailure("bound-order");
      }
      sendPacket(`B:{q}:${slotId}:${pid}\n`, "B", slotId);
      reported.boundReported = true;
      return oldLength;
    }

    throw latchBridgeFailure("guard-frame-format");
  }

  guard = createPrototypeSpawnGuard({
    originalSpawn,
    installObserver,
    writeFrame,
  });

  const pendingResult = Object.freeze({ status: "pending" });
  const okResult = Object.freeze({ status: "ok" });
  const failedResult = Object.freeze({ status: "failed" });
  const finishedResult = Object.freeze({ status: "finished" });

  function closeAdmission() {
    return guard.closeAdmission();
  }

  function flush() {
    if (writing || flushing || finishing) {
      return pendingResult;
    }
    flushing = true;
    try {
      const guardState = guardSnapshot();
      if (guardState === null) {
        return failedResult;
      }
      if (guardState.inFlight !== 0) {
        return pendingResult;
      }
      if (bridgeFailed || guardState.failed) {
        return failedResult;
      }

      const owned = guard.owned();
      for (const reported of reportedSlots) {
        const local = owned[reported.slotId - 1];
        if (local === undefined || local.receiver !== reported.receiver) {
          latchBridgeFailure("flush-slot-mismatch");
          return failedResult;
        }
        if (local.closeObserved && reported.boundReported && !reported.closeReported) {
          try {
            sendPacket(`C:{q}:${reported.slotId}\n`, "C", reported.slotId);
          } catch {
            return failedResult;
          }
          reported.closeReported = true;
        }
      }

      if (!gateReported && guardState.closed &&
          reportedSlots.every((slot) => slot.reserveReported && slot.boundReported)) {
        try {
          sendPacket("G:{q}\n", "G", null);
        } catch {
          return failedResult;
        }
        gateReported = true;
      }
      return healthyNow() ? okResult : failedResult;
    } catch (error) {
      latchFailure(error, "flush");
      return failedResult;
    } finally {
      flushing = false;
    }
  }

  function finish() {
    if (writing || flushing || finishing) {
      return pendingResult;
    }
    finishing = true;
    try {
      if (!healthyNow()) {
        return failedResult;
      }
      if (terminalReported) {
        return finishedResult;
      }
      const guardState = guardSnapshot();
      if (guardState === null || guardState.failed) {
        return failedResult;
      }
      const allComplete = reportedSlots.every((slot) =>
        slot.reserveReported && slot.boundReported && slot.closeReported);
      if (!guardState.closed || guardState.inFlight !== 0 || !gateReported || !allComplete) {
        return pendingResult;
      }
      try {
        sendPacket("T:{q}\n", "T", null);
      } catch {
        return failedResult;
      }
      terminalReported = true;
      return finishedResult;
    } catch (error) {
      latchFailure(error, "finish");
      return failedResult;
    } finally {
      finishing = false;
    }
  }

  function snapshot() {
    const guardState = guard.snapshot();
    const firstError = firstErrorPresent
      ? Object.freeze({ present: true, value: firstErrorValue })
      : Object.freeze({ present: false });
    const slotViews = reportedSlots.map((slot) => Object.freeze({
      slotId: slot.slotId,
      receiver: slot.receiver,
      reserveReported: slot.reserveReported,
      boundReported: slot.boundReported,
      closeReported: slot.closeReported,
    }));
    const diagnosticViews = diagnostics.map((entry) => Object.freeze({
      kind: entry.kind,
      sequence: entry.sequence,
      slotId: entry.slotId,
    }));
    const budget = Object.freeze({
      slots: Object.freeze({ used: reportedSlots.length, limit: MAX_SLOTS }),
      packets: Object.freeze({ used: packetAttempts, limit: MAX_PACKET_ATTEMPTS, overflow: packetAttemptsOverflow }),
      packetBytes: Object.freeze({ limit: MAX_PACKET_BYTES, overflow: packetBytesOverflow }),
      totalBytes: Object.freeze({ used: bytesRequested, limit: MAX_TOTAL_BYTES, overflow: totalBytesOverflow }),
      diagnostics: Object.freeze({ used: diagnostics.length, limit: MAX_DIAGNOSTICS, overflow: diagnosticsOverflow }),
    });
    return Object.freeze({
      protocol: "creator-stream/v1",
      failed: bridgeFailed || guardState.failed,
      bridgeFailed,
      firstError,
      firstFailureStage,
      guard: guardState,
      closed: guardState.closed,
      inFlight: guardState.inFlight,
      gateReported,
      terminalReported,
      wireSequence,
      packetAttempts,
      bytesRequested,
      budget,
      slots: Object.freeze(slotViews),
      diagnostics: Object.freeze(diagnosticViews),
    });
  }

  function assertHealthy() {
    if (!healthyNow()) {
      throw makeBridgeError();
    }
  }

  return Object.freeze({
    spawn: guard.spawn,
    closeAdmission,
    flush,
    finish,
    snapshot,
    assertHealthy,
  });
}
