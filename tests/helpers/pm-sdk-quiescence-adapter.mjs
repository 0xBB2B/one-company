const MAX_SLOTS = 8;
const MAX_FACTS = 32;
const MAX_WRITE_ATTEMPTS = 32;
const MAX_FRAME_BYTES = 256;
const MAX_TOTAL_BYTES = 8192;
const GUARD_MESSAGE = "prototype spawn guard rejected the operation";

/**
 * @typedef {{
 *   onClose: () => void,
 *   onError: (error: unknown) => void,
 * }} ObserverCallbacks
 */

/**
 * @typedef {{
 *   originalSpawn: (this: unknown, ...args: unknown[]) => unknown,
 *   writeFrame: (frame: Uint8Array) => unknown,
 *   installObserver: (receiver: object, callbacks: ObserverCallbacks) => unknown,
 * }} SpawnGuardDependencies
 */

/**
 * @typedef {{
 *   id: number,
 *   receiver: object,
 *   observerInstalled: boolean,
 *   reserveWritten: boolean,
 *   nativeEntered: boolean,
 *   nativeReturnPresent: boolean,
 *   nativeReturnValue: unknown,
 *   nativeThrowPresent: boolean,
 *   nativeThrowValue: unknown,
 *   boundAttempted: boolean,
 *   boundWritten: boolean,
 *   closeObserved: boolean,
 *   errorObservations: number,
 * }} AttemptSlot
 */

/** @returns {Error & { code: string }} */
function makeGuardError() {
  return Object.assign(new Error(GUARD_MESSAGE), {
    name: "PrototypeSpawnGuardError",
    code: "ERR_PROTOTYPE_SPAWN_GUARD",
  });
}

/**
 * Reads a required dependency without invoking an ordinary property getter.
 *
 * @param {unknown} dependencies
 * @param {keyof SpawnGuardDependencies} name
 * @returns {Function}
 */
function readOwnFunction(dependencies, name) {
  if ((typeof dependencies !== "object" || dependencies === null) &&
      typeof dependencies !== "function") {
    throw makeGuardError();
  }

  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name);
  if (descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "function") {
    throw makeGuardError();
  }
  return descriptor.value;
}

/**
 * Creates a synchronous guard around a prototype spawn method. The guard owns
 * only local attempt records and never interprets them as live native handles.
 *
 * @param {unknown} dependencies
 */
export function createPrototypeSpawnGuard(dependencies) {
  const originalSpawn = /** @type {SpawnGuardDependencies["originalSpawn"]} */ (
    readOwnFunction(dependencies, "originalSpawn")
  );
  const writeFrame = /** @type {SpawnGuardDependencies["writeFrame"]} */ (
    readOwnFunction(dependencies, "writeFrame")
  );
  const installObserver = /** @type {SpawnGuardDependencies["installObserver"]} */ (
    readOwnFunction(dependencies, "installObserver")
  );

  /** @type {AttemptSlot[]} */
  const slots = [];
  /** @type {{ kind: string, slotId: number | null }[]} */
  const facts = [];

  let closed = false;
  let failed = false;
  let inFlight = 0;
  let firstErrorPresent = false;
  /** @type {unknown} */
  let firstErrorValue;
  /** @type {string | null} */
  let firstFailureStage = null;

  let slotsOverflow = false;
  let factsOverflow = false;
  let writesOverflow = false;
  let frameOverflow = false;
  let bytesOverflow = false;
  let writeAttempts = 0;
  let bytesRequested = 0;

  /**
   * @param {unknown} error
   * @param {string} stage
   */
  function latchFailure(error, stage) {
    failed = true;
    if (!firstErrorPresent) {
      firstErrorPresent = true;
      firstErrorValue = error;
      firstFailureStage = stage;
    }
  }

  /**
   * @param {string} stage
   * @returns {Error & { code: string }}
   */
  function latchGuardFailure(stage) {
    const error = makeGuardError();
    latchFailure(error, stage);
    return error;
  }

  /**
   * Ordinary diagnostic facts have a separate bounded budget. Exhaustion can
   * fail the guard but cannot erase slot outcomes or the first-error cell.
   *
   * @param {string} kind
   * @param {number | null} slotId
   */
  function recordFact(kind, slotId) {
    if (facts.length >= MAX_FACTS) {
      factsOverflow = true;
      latchFailure(makeGuardError(), "facts-budget");
      return false;
    }
    facts.push({ kind, slotId });
    return true;
  }

  /**
   * @param {string} text
   * @returns {Uint8Array}
   */
  function asciiFrame(text) {
    const frame = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code > 0x7f) {
        throw latchGuardFailure("frame-encoding");
      }
      frame[index] = code;
    }
    return frame;
  }

  /**
   * @param {string} text
   * @param {string} stage
   */
  function performWrite(text, stage) {
    const frame = asciiFrame(text);
    const expectedLength = frame.byteLength;

    writeAttempts += 1;
    bytesRequested += expectedLength;
    if (expectedLength > MAX_FRAME_BYTES) {
      frameOverflow = true;
      throw latchGuardFailure(`${stage}-frame-budget`);
    }
    if (writeAttempts > MAX_WRITE_ATTEMPTS) {
      writesOverflow = true;
      throw latchGuardFailure(`${stage}-write-budget`);
    }
    if (bytesRequested > MAX_TOTAL_BYTES) {
      bytesOverflow = true;
      throw latchGuardFailure(`${stage}-byte-budget`);
    }

    /** @type {unknown} */
    let result;
    try {
      result = Reflect.apply(writeFrame, undefined, [frame]);
    } catch (error) {
      latchFailure(error, stage);
      throw error;
    }

    if (!Number.isInteger(result) || result !== expectedLength) {
      throw latchGuardFailure(`${stage}-result`);
    }
  }

  /**
   * @param {string} stage
   */
  function requirePreNativeOpen(stage) {
    if (failed) {
      throw makeGuardError();
    }
    if (closed) {
      throw latchGuardFailure(stage);
    }
  }

  /**
   * @param {object} receiver
   * @returns {number | null}
   */
  function readPositiveOwnDataPid(receiver) {
    const descriptor = Object.getOwnPropertyDescriptor(receiver, "pid");
    if (descriptor === undefined || !("value" in descriptor) ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value <= 0) {
      return null;
    }
    return descriptor.value;
  }

  /**
   * @param {AttemptSlot} slot
   * @returns {Readonly<Record<string, unknown>>}
   */
  function slotView(slot) {
    const nativeReturn = slot.nativeReturnPresent
      ? Object.freeze({ present: true, value: slot.nativeReturnValue })
      : Object.freeze({ present: false });
    const nativeThrow = slot.nativeThrowPresent
      ? Object.freeze({ present: true, value: slot.nativeThrowValue })
      : Object.freeze({ present: false });

    return Object.freeze({
      id: slot.id,
      receiver: slot.receiver,
      observerInstalled: slot.observerInstalled,
      reserveWritten: slot.reserveWritten,
      nativeEntered: slot.nativeEntered,
      nativeReturn,
      nativeThrow,
      boundAttempted: slot.boundAttempted,
      boundWritten: slot.boundWritten,
      closeObserved: slot.closeObserved,
      errorObservations: slot.errorObservations,
    });
  }

  function closeAdmission() {
    closed = true;
    return inFlight;
  }

  function owned() {
    return Object.freeze(slots.map(slotView));
  }

  function snapshot() {
    const firstError = firstErrorPresent
      ? Object.freeze({ present: true, value: firstErrorValue })
      : Object.freeze({ present: false });
    const budget = Object.freeze({
      slots: Object.freeze({ used: slots.length, limit: MAX_SLOTS, overflow: slotsOverflow }),
      facts: Object.freeze({ used: facts.length, limit: MAX_FACTS, overflow: factsOverflow }),
      writes: Object.freeze({ used: writeAttempts, limit: MAX_WRITE_ATTEMPTS, overflow: writesOverflow }),
      frameBytes: Object.freeze({ limit: MAX_FRAME_BYTES, overflow: frameOverflow }),
      totalBytes: Object.freeze({ used: bytesRequested, limit: MAX_TOTAL_BYTES, overflow: bytesOverflow }),
    });
    const factViews = facts.map((fact) => Object.freeze({
      kind: fact.kind,
      slotId: fact.slotId,
    }));

    return Object.freeze({
      closed,
      failed,
      inFlight,
      firstError,
      firstFailureStage,
      budget,
      facts: Object.freeze(factViews),
      slots: Object.freeze(slots.map(slotView)),
    });
  }

  function assertHealthy() {
    if (failed) {
      throw makeGuardError();
    }
  }

  /**
   * @this {unknown}
   * @param {...unknown} args
   * @returns {unknown}
   */
  function spawn(...args) {
    if (closed) {
      throw latchGuardFailure("admission-closed");
    }
    if (failed) {
      throw makeGuardError();
    }
    if (inFlight !== 0) {
      throw latchGuardFailure("reentrant-spawn");
    }
    if ((typeof this !== "object" || this === null) && typeof this !== "function") {
      throw latchGuardFailure("invalid-receiver");
    }

    const receiver = /** @type {object} */ (this);
    if (slots.some((slot) => slot.receiver === receiver)) {
      throw latchGuardFailure("duplicate-receiver");
    }
    if (slots.length >= MAX_SLOTS) {
      slotsOverflow = true;
      throw latchGuardFailure("slot-budget");
    }

    /** @type {AttemptSlot} */
    const slot = {
      id: slots.length + 1,
      receiver,
      observerInstalled: false,
      reserveWritten: false,
      nativeEntered: false,
      nativeReturnPresent: false,
      nativeReturnValue: undefined,
      nativeThrowPresent: false,
      nativeThrowValue: undefined,
      boundAttempted: false,
      boundWritten: false,
      closeObserved: false,
      errorObservations: 0,
    };
    slots.push(slot);
    inFlight = 1;

    const callbacks = Object.freeze({
      onClose() {
        if (slot.closeObserved) {
          latchFailure(makeGuardError(), "observer-close-duplicate");
        } else {
          slot.closeObserved = true;
          if (!slot.nativeEntered) {
            latchFailure(makeGuardError(), "observer-close-before-native");
          }
        }
        recordFact("observer-close", slot.id);
      },
      /** @param {unknown} error */
      onError(error) {
        slot.errorObservations += 1;
        latchFailure(error, "observer-error");
        recordFact("observer-error", slot.id);
      },
    });

    try {
      /** @type {unknown} */
      let observerResult;
      try {
        observerResult = Reflect.apply(installObserver, undefined, [receiver, callbacks]);
      } catch (error) {
        latchFailure(error, "observer-install");
        throw error;
      }
      if (observerResult !== undefined) {
        throw latchGuardFailure("observer-install-result");
      }
      slot.observerInstalled = true;
      requirePreNativeOpen("closed-after-observer");

      performWrite(`R:${slot.id}\n`, "reserve-write");
      slot.reserveWritten = true;
      requirePreNativeOpen("closed-after-reserve");

      slot.nativeEntered = true;
      /** @type {unknown} */
      let result;
      try {
        result = Reflect.apply(originalSpawn, receiver, args);
      } catch (error) {
        slot.nativeThrowPresent = true;
        slot.nativeThrowValue = error;
        latchFailure(error, "native-throw");
        throw error;
      }

      slot.nativeReturnPresent = true;
      slot.nativeReturnValue = result;

      if (!failed && result === 0) {
        const pid = readPositiveOwnDataPid(receiver);
        if (pid === null) {
          latchFailure(makeGuardError(), "native-pid-unknown");
        } else {
          slot.boundAttempted = true;
          try {
            performWrite(`B:${slot.id}:${pid}\n`, "bound-write");
            slot.boundWritten = true;
          } catch (error) {
            // Bound reporting is diagnostic; the native result remains primary.
          }
        }
      } else if (!failed) {
        latchFailure(makeGuardError(), "native-result-unknown");
      }

      return result;
    } finally {
      inFlight = 0;
    }
  }

  return Object.freeze({
    spawn,
    closeAdmission,
    owned,
    snapshot,
    assertHealthy,
  });
}
