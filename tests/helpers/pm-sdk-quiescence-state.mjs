// @ts-check

/**
 * Pure, test-internal quiescence state. It records adapter facts but performs no
 * process, filesystem, network, SDK, or deletion operation. Every candidate in
 * a snapshot is diagnostic only and never grants cleanup authority.
 */
export const PM_SDK_QUIESCENCE_ADAPTER_STATUS = "not-implemented";

const LIFECYCLES = new Set(["allocated", "running", "closing", "removed"]);
const RESOURCE_KINDS = new Set(["execution-child", "detached-group"]);
const GROUP_STATES = new Set(["unknown", "alive", "gone"]);
const CASE_OUTCOMES = new Set(["pass", "failure", "interrupted"]);
const STOP_OUTCOMES = new Set(["success", "failure"]);
const EXECUTION_END_KINDS = new Set(["natural", "early-exit", "forced"]);

/** @typedef {{ present: false } | { present: true, value: unknown }} ErrorFact */
/** @typedef {{ id: string, expectFailureThenRecovery: boolean }} ExpectedStop */
/** @typedef {{ id: string, stops: readonly ExpectedStop[] }} ExpectedCase */
/**
 * @typedef {{
 *   maxEvents: number,
 *   maxResources: number,
 *   maxErrors: number,
 *   maxStopAttempts: number,
 *   maxCases: number,
 *   maxStops: number,
 *   maxWriters: number,
 *   maxIdentifierLength: number,
 * }} Limits
 */
/**
 * @typedef {{
 *   stopDomain: "execution-tree",
 *   expectedCases: readonly ExpectedCase[],
 *   expectedWriters: readonly string[],
 *   limits: Limits,
 * }} Configuration
 */
/** @typedef {{ owner: object, epoch: object }} OwnerAuth */
/**
 * @typedef {{
 *   token: object,
 *   ordinal: number,
 *   kind: "stop" | "reclaim",
 *   status: "pending" | "completed",
 *   timeouts: number,
 *   outcome: null | "success" | "failure" | "failed" | "removed",
 *   error: null | RetainedError,
 * }} Attempt
 */
/** @typedef {{ scope: string, present: true, value: unknown }} RetainedError */
/**
 * @typedef {{
 *   expected: ExpectedStop,
 *   attempts: Attempt[],
 *   current: Attempt | null,
 * }} StopState
 */
/**
 * @typedef {{
 *   expected: ExpectedCase,
 *   begun: boolean,
 *   result: null | { outcome: "pass" | "failure" | "interrupted", error: RetainedError | null },
 *   stops: Map<string, StopState>,
 * }} CaseState
 */
/** @typedef {{ nextSequence: number, eof: boolean, damaged: boolean }} WriterState */
/**
 * @typedef {{
 *   ordinal: number,
 *   caseId: string,
 *   resourceKey: object | Function,
 *   kind: "execution-child" | "detached-group",
 *   state: "reserved" | "bound" | "close-observed" | "proven-not-created" | "protocol-uncertain",
 *   writerId: string,
 *   handleKey: object | Function | null,
 *   pid: number | null,
 *   closeObserved: boolean,
 *   groupState: "unknown" | "alive" | "gone" | "not-applicable",
 *   bindingUncertain: boolean,
 *   groupIdentityUncertain: boolean,
 * }} ResourceState
 */
/**
 * @typedef {{
 *   blockers: string[],
 *   casePass: boolean,
 *   stopPass: boolean,
 *   normalExecutionEnd: boolean,
 *   executionPassCandidate: boolean,
 *   physicalEndCandidate: boolean,
 *   reclaimCandidate: boolean,
 *   reclaimSucceeded: boolean,
 *   integrityPass: boolean,
 *   overallPass: boolean,
 * }} ComputedStatus
 */

/** @param {string} code @returns {never} */
function fail(code) {
  throw new Error(code);
}

/** @param {unknown} value @param {string} code @returns {asserts value is Record<PropertyKey, unknown>} */
function assertRecord(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
}

/** @param {Record<PropertyKey, unknown>} value @param {PropertyKey} key @param {string} code @returns {unknown} */
function ownData(value, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) fail(code);
  return descriptor.value;
}

/** Read only an identity field; full carrier shape is validated after source recognition.
 * @param {unknown} value @param {PropertyKey} key @param {string} code */
function identityData(value, key, code) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") fail(code);
  return ownData(/** @type {Record<PropertyKey, unknown>} */ (value), key, code);
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} code @returns {asserts value is Record<PropertyKey, unknown>} */
function assertExactKeys(value, keys, code) {
  assertRecord(value, code);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(code);
  }
}

/** @param {unknown} value @param {string} code @returns {number} */
function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) fail(code);
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {number} maximum @param {string} code @returns {string} */
function boundedIdentifier(value, maximum, code) {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximum) fail(code);
  return value;
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} value @param {string} code @returns {ErrorFact} */
function parseErrorRecord(value, code) {
  assertRecord(value, code);
  const present = ownData(value, "present", code);
  if (typeof present !== "boolean") fail(code);
  if (present) {
    assertExactKeys(value, ["present", "value"], code);
    return { present: true, value: ownData(value, "value", code) };
  }
  assertExactKeys(value, ["present"], code);
  return { present: false };
}

/** @param {unknown} rawConfiguration @returns {Configuration} */
function parseConfiguration(rawConfiguration) {
  assertExactKeys(
    rawConfiguration,
    ["stopDomain", "expectedCases", "expectedWriters", "limits"],
    "invalid_quiescence_configuration",
  );
  if (ownData(rawConfiguration, "stopDomain", "invalid_stop_domain") !== "execution-tree") fail("unsupported_stop_domain");
  const expectedCases = ownData(rawConfiguration, "expectedCases", "invalid_expected_cases");
  const expectedWriters = ownData(rawConfiguration, "expectedWriters", "invalid_expected_writers");
  const rawLimits = ownData(rawConfiguration, "limits", "invalid_quiescence_limits");
  if (!Array.isArray(expectedCases) || expectedCases.length === 0) fail("invalid_expected_cases");
  if (!Array.isArray(expectedWriters) || expectedWriters.length === 0) fail("invalid_expected_writers");
  assertExactKeys(
    rawLimits,
    [
      "maxEvents",
      "maxResources",
      "maxErrors",
      "maxStopAttempts",
      "maxCases",
      "maxStops",
      "maxWriters",
      "maxIdentifierLength",
    ],
    "invalid_quiescence_limits",
  );
  const limits = /** @type {Limits} */ (Object.freeze({
    maxEvents: positiveInteger(ownData(rawLimits, "maxEvents", "invalid_max_events"), "invalid_max_events"),
    maxResources: positiveInteger(
      ownData(rawLimits, "maxResources", "invalid_max_resources"),
      "invalid_max_resources",
    ),
    maxErrors: positiveInteger(ownData(rawLimits, "maxErrors", "invalid_max_errors"), "invalid_max_errors"),
    maxStopAttempts: positiveInteger(
      ownData(rawLimits, "maxStopAttempts", "invalid_max_stop_attempts"),
      "invalid_max_stop_attempts",
    ),
    maxCases: positiveInteger(ownData(rawLimits, "maxCases", "invalid_max_cases"), "invalid_max_cases"),
    maxStops: positiveInteger(ownData(rawLimits, "maxStops", "invalid_max_stops"), "invalid_max_stops"),
    maxWriters: positiveInteger(ownData(rawLimits, "maxWriters", "invalid_max_writers"), "invalid_max_writers"),
    maxIdentifierLength: positiveInteger(
      ownData(rawLimits, "maxIdentifierLength", "invalid_max_identifier_length"),
      "invalid_max_identifier_length",
    ),
  }));
  if (expectedCases.length > limits.maxCases) fail("expected_cases_exceed_capacity");
  if (expectedWriters.length > limits.maxWriters) fail("expected_writers_exceed_capacity");

  const caseIds = new Set();
  let totalStops = 0;
  /** @type {ExpectedCase[]} */
  const cases = [];
  for (const entry of expectedCases) {
    assertExactKeys(entry, ["id", "stops"], "invalid_expected_case");
    const id = boundedIdentifier(
      ownData(entry, "id", "invalid_case_id"),
      limits.maxIdentifierLength,
      "invalid_case_id",
    );
    if (caseIds.has(id)) fail("duplicate_case_id");
    caseIds.add(id);
    const rawStops = ownData(entry, "stops", "invalid_case_stops");
    if (!Array.isArray(rawStops)) fail("invalid_case_stops");
    totalStops += rawStops.length;
    if (totalStops > limits.maxStops) fail("expected_stops_exceed_capacity");
    const stopIds = new Set();
    /** @type {ExpectedStop[]} */
    const stops = [];
    for (const stop of rawStops) {
      assertExactKeys(stop, ["id", "expectFailureThenRecovery"], "invalid_expected_stop");
      const stopId = boundedIdentifier(
        ownData(stop, "id", "invalid_stop_id"),
        limits.maxIdentifierLength,
        "invalid_stop_id",
      );
      if (stopIds.has(stopId)) fail("duplicate_stop_id");
      stopIds.add(stopId);
      const expectFailureThenRecovery = ownData(
        stop,
        "expectFailureThenRecovery",
        "invalid_stop_expectation",
      );
      if (typeof expectFailureThenRecovery !== "boolean") fail("invalid_stop_expectation");
      stops.push(Object.freeze({ id: stopId, expectFailureThenRecovery }));
    }
    cases.push(Object.freeze({ id, stops: Object.freeze(stops) }));
  }
  if (totalStops > limits.maxStopAttempts) fail("expected_stops_exceed_attempt_capacity");

  const writerIds = new Set();
  /** @type {string[]} */
  const writers = [];
  for (const writerId of expectedWriters) {
    const id = boundedIdentifier(writerId, limits.maxIdentifierLength, "invalid_writer_id");
    if (writerIds.has(id)) fail("duplicate_writer_id");
    writerIds.add(id);
    writers.push(id);
  }

  return Object.freeze({
    stopDomain: /** @type {const} */ ("execution-tree"),
    expectedCases: Object.freeze(cases),
    expectedWriters: Object.freeze(writers),
    limits,
  });
}

/**
 * Creates the pure diagnostic model. The returned owner and epoch are opaque
 * references local to this model; they do not authenticate an OS adapter.
 *
 * `executionPassCandidate` means case, stop, and natural execution facts pass.
 * `overallPass` additionally requires successful reclaim and no timeout,
 * unexpected failure, or protocol uncertainty. `reclaimCandidate` remains
 * independent from business success and is never deletion permission.
 * Execution-domain termination is latched; later contradictory facts revoke
 * candidates but never reactivate terminated stop operations.
 * maxErrors bounds the ordinary journal; maxStopAttempts also bounds separate
 * reclaim terminal error slots. Each issued attempt owns its slot. A completion
 * may throw a journal-capacity error after retaining its real terminal fact.
 *
 * @param {unknown} configuration
 */
export function createPmSdkQuiescenceState(configuration) {
  const config = parseConfiguration(configuration);
  const owner = Object.freeze(Object.create(null));
  const epoch = Object.freeze(Object.create(null));
  const credentials = Object.freeze({ owner, epoch });
  /** @type {"allocated" | "running" | "closing" | "removed"} */
  let lifecycle = "allocated";
  /** @type {string | null} */
  let currentCaseId = null;
  let nextCaseIndex = 0;
  let eventOverflow = false;
  let resourceOverflow = false;
  let stopAttemptOverflow = false;
  let errorOverflow = false;
  let eventCount = 0;
  let stopAttemptCount = 0;
  let nextAttemptOrdinal = 0;
  let protocolDamaged = false;
  let executionDomainEnded = false;
  /** @type {Readonly<Record<string, unknown>>[]} */
  const events = [];
  /** @type {RetainedError[]} */
  const errors = [];
  /** @type {Map<object | Function, ResourceState>} */
  const resources = new Map();
  /** @type {Map<object | Function, ResourceState>} */
  const handleBindings = new Map();
  /** @type {Map<number, ResourceState>} */
  const pidBindings = new Map();
  /** @type {Map<string, CaseState>} */
  const caseStates = new Map();
  /** @type {Map<string, WriterState>} */
  const writerStates = new Map();
  const execution = {
    /** @type {null | { kind: "natural" | "early-exit" | "forced", exitCode: number | null, signal: string | null }} */
    close: null,
    /** @type {"unknown" | "alive" | "gone"} */
    groupState: "unknown",
    groupIdentityUncertain: false,
  };
  const reclaim = {
    /** @type {Attempt[]} */
    attempts: [],
    /** @type {Attempt | null} */
    current: null,
  };

  for (const expectedCase of config.expectedCases) {
    /** @type {Map<string, StopState>} */
    const stops = new Map();
    for (const expectedStop of expectedCase.stops) {
      stops.set(expectedStop.id, { expected: expectedStop, attempts: [], current: null });
    }
    caseStates.set(expectedCase.id, { expected: expectedCase, begun: false, result: null, stops });
  }
  for (const writerId of config.expectedWriters) {
    writerStates.set(writerId, { nextSequence: 1, eof: false, damaged: false });
  }

  /** @param {unknown} auth @param {boolean} [allowRetired] */
  function requireAuth(auth, allowRetired = false) {
    assertRecord(auth, "invalid_owner_auth");
    if (ownData(auth, "owner", "invalid_owner_auth") !== owner) fail("unknown_owner");
    if (ownData(auth, "epoch", "invalid_owner_auth") !== epoch) fail("wrong_epoch");
    if (Reflect.ownKeys(auth).length !== 2) fail("invalid_owner_auth");
    if (!allowRetired && lifecycle === "removed") fail("owner_retired");
  }

  function ensureMutable() {
    if (!LIFECYCLES.has(lifecycle) || lifecycle === "removed") fail("owner_retired");
    if (eventOverflow || resourceOverflow || stopAttemptOverflow || errorOverflow) {
      fail("state_preserved_after_overflow");
    }
  }

  /** @param {string} type @param {Record<string, unknown>} [details] */
  function appendEvent(type, details = {}) {
    if (eventCount >= config.limits.maxEvents) {
      eventOverflow = true;
      fail("event_capacity_exceeded_preserved");
    }
    eventCount += 1;
    events.push(Object.freeze({ ordinal: eventCount, type, ...details }));
  }

  /** @param {string} code @param {WriterState} [writer] @returns {never} */
  function preserveProtocol(code, writer) {
    protocolDamaged = true;
    if (writer) writer.damaged = true;
    appendEvent("protocol-uncertain", { code });
    fail(code);
  }

  /** @param {string} scope @param {ErrorFact} errorRecord @returns {RetainedError | null} */
  function retainError(scope, errorRecord) {
    if (!errorRecord.present) return null;
    if (errors.length >= config.limits.maxErrors) {
      errorOverflow = true;
      fail("error_capacity_exceeded_preserved");
    }
    const retained = Object.freeze({ scope, present: /** @type {const} */ (true), value: errorRecord.value });
    errors.push(retained);
    return retained;
  }

  /** @param {unknown} caseId @returns {CaseState} */
  function requireCase(caseId) {
    if (typeof caseId !== "string") fail("unknown_case");
    const state = caseStates.get(caseId);
    if (!state) fail("unknown_case");
    return state;
  }

  /** @param {unknown} caseId @returns {CaseState} */
  function requireStartedCase(caseId) {
    const state = requireCase(caseId);
    if (!state.begun) fail("case_not_started");
    return state;
  }

  /** @param {unknown} caseId @param {unknown} stopId @returns {StopState} */
  function requireStop(caseId, stopId) {
    const caseState = requireStartedCase(caseId);
    if (typeof stopId !== "string") fail("unknown_stop");
    const stopState = caseState.stops.get(stopId);
    if (!stopState) fail("unknown_stop");
    return stopState;
  }

  /** @param {"stop" | "reclaim"} kind @returns {Attempt} */
  function createAttempt(kind) {
    if (stopAttemptCount >= config.limits.maxStopAttempts) {
      stopAttemptOverflow = true;
      fail("stop_attempt_capacity_exceeded_preserved");
    }
    stopAttemptCount += 1;
    nextAttemptOrdinal += 1;
    return {
      token: Object.freeze(Object.create(null)),
      ordinal: nextAttemptOrdinal,
      kind,
      status: "pending",
      timeouts: 0,
      outcome: null,
      error: null,
    };
  }

  /** @param {Attempt | null} current @param {unknown} token @param {string} code @returns {Attempt} */
  function requireCurrentAttempt(current, token, code) {
    if (!current || current.token !== token) fail(code);
    return current;
  }

  /** @param {unknown} writerId @returns {WriterState} */
  function requireWriter(writerId) {
    if (typeof writerId !== "string") fail("unknown_writer_preserved");
    const writer = writerStates.get(writerId);
    if (!writer) fail("unknown_writer_preserved");
    return writer;
  }

  /** @param {unknown} writerId @param {unknown} sequence @returns {WriterState} */
  function validateWriterSequence(writerId, sequence) {
    const writer = requireWriter(writerId);
    if (writer.eof) fail("writer_after_eof_preserved");
    if (!Number.isSafeInteger(sequence) || /** @type {number} */ (sequence) <= 0) {
      fail("invalid_writer_sequence_preserved");
    }
    if (sequence !== writer.nextSequence) fail("writer_sequence_gap_preserved");
    return writer;
  }

  /** @param {WriterState} writer @param {string} type @param {Record<string, unknown>} details */
  function acceptWriterSequence(writer, type, details) {
    writer.nextSequence += 1;
    appendEvent(type, details);
  }

  /** Source identity precedes the protected stream/payload domain. Bind proposes a
   * handle; close must match an existing original handle. No getters are invoked.
   * @template T
   * @param {unknown} auth @param {unknown} fact
   * @param {"owner" | "resource" | "close"} source
   * @param {readonly string[]} keys @param {string} code
   * @param {(fact: Record<PropertyKey, unknown>, writer: WriterState, writerId: string, resource: ResourceState | null) => T} apply
   * @returns {T}
   */
  function receiveChildFact(auth, fact, source, keys, code, apply) {
    if (identityData(auth, "owner", "invalid_owner_auth") !== owner) fail("unknown_owner");
    if (identityData(auth, "epoch", "invalid_owner_auth") !== epoch) fail("wrong_epoch");
    if (lifecycle === "removed") fail("owner_retired");
    ensureMutable();
    const resource = source === "owner" ? null : requireResource(identityData(fact, "resourceKey", code));
    if (source === "close" && resource !== null && resource.handleKey !== null &&
      identityData(fact, "handleKey", code) !== resource.handleKey) fail("wrong_handle_key");

    /** @type {WriterState | undefined} */
    let writer;
    try {
      const writerId = identityData(fact, "writerId", code);
      writer = requireWriter(writerId);
      if (resource && writerId !== resource.writerId) fail("resource_writer_mismatch_preserved");
      validateWriterSequence(writerId, identityData(fact, "sequence", code));
      assertExactKeys(auth, ["owner", "epoch"], "invalid_owner_auth");
      assertExactKeys(fact, keys, code);
      return apply(fact, writer, /** @type {string} */ (writerId), resource);
    } catch (error) {
      protocolDamaged = true;
      if (writer) writer.damaged = true;
      // A bounded diagnostic failure cannot replace the first rejection.
      try { appendEvent("child-stream-rejected", { operation: code }); } catch { /* overflow remains recorded */ }
      throw error;
    }
  }

  function latchExecutionDomainEnd() {
    if (!executionDomainEnded && computeStatus().physicalEndCandidate) executionDomainEnded = true;
  }

  /** @param {unknown} resourceKey @returns {ResourceState} */
  function requireResource(resourceKey) {
    if ((typeof resourceKey !== "object" || resourceKey === null) && typeof resourceKey !== "function") {
      fail("unknown_resource");
    }
    const resource = resources.get(resourceKey);
    if (!resource) fail("unknown_resource");
    return resource;
  }

  /** @param {unknown} auth */
  function beginRun(auth) {
    requireAuth(auth);
    ensureMutable();
    if (lifecycle !== "allocated") fail("run_already_started");
    appendEvent("run-begun");
    lifecycle = "running";
  }

  /** @param {unknown} auth @param {unknown} caseId */
  function beginCase(auth, caseId) {
    requireAuth(auth);
    ensureMutable();
    if (lifecycle !== "running") fail("new_business_rejected");
    if (currentCaseId !== null) fail("case_already_active");
    const expected = config.expectedCases[nextCaseIndex];
    if (!expected || expected.id !== caseId) fail("case_out_of_order");
    const state = requireCase(caseId);
    if (state.begun || state.result) fail("old_case_rejected");
    appendEvent("case-begun", { caseId });
    state.begun = true;
    currentCaseId = /** @type {string} */ (caseId);
  }

  /** @param {unknown} auth @param {unknown} fact */
  function recordCaseResult(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["caseId", "outcome", "error"], "invalid_case_result");
    const caseId = ownData(fact, "caseId", "invalid_case_result");
    const outcome = ownData(fact, "outcome", "invalid_case_result");
    if (typeof outcome !== "string" || !CASE_OUTCOMES.has(outcome)) fail("invalid_case_outcome");
    if (currentCaseId !== caseId) fail("old_case_rejected");
    const state = requireStartedCase(caseId);
    if (state.result) fail("case_result_already_recorded");
    const errorRecord = parseErrorRecord(ownData(fact, "error", "invalid_case_result"), "invalid_case_error");
    if (outcome === "pass" && errorRecord.present) fail("passing_case_cannot_have_error");
    if (outcome !== "pass" && !errorRecord.present) fail("failed_case_requires_error_presence");
    const retained = retainError(`case:${String(caseId)}`, errorRecord);
    appendEvent("case-result", { caseId, outcome });
    state.result = {
      outcome: /** @type {"pass" | "failure" | "interrupted"} */ (outcome),
      error: retained,
    };
    currentCaseId = null;
    nextCaseIndex += 1;
  }

  /** @param {unknown} auth @param {unknown} fact */
  function requestStop(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["caseId", "stopId"], "invalid_stop_request");
    const caseId = ownData(fact, "caseId", "invalid_stop_request");
    const stopId = ownData(fact, "stopId", "invalid_stop_request");
    const stop = requireStop(caseId, stopId);
    if (executionDomainEnded || reclaim.current !== null) fail("new_stop_after_domain_end");
    if (stop.current?.status === "pending") {
      return Object.freeze({ status: /** @type {const} */ ("pending"), attempt: stop.current.token });
    }
    if (stop.current?.status === "completed" && stop.current.outcome === "success") {
      return Object.freeze({
        status: /** @type {const} */ ("completed"),
        attempt: stop.current.token,
        outcome: /** @type {const} */ ("success"),
      });
    }
    if (stop.current && stop.current.status !== "completed") fail("stop_attempt_not_ended");
    const attempt = createAttempt("stop");
    stop.current = attempt;
    stop.attempts.push(attempt);
    appendEvent("stop-requested", { caseId, stopId, attempt: attempt.ordinal });
    return Object.freeze({ status: /** @type {const} */ ("started"), attempt: attempt.token });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function timeoutStop(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["caseId", "stopId", "attempt"], "invalid_stop_timeout");
    const caseId = ownData(fact, "caseId", "invalid_stop_timeout");
    const stopId = ownData(fact, "stopId", "invalid_stop_timeout");
    const stop = requireStop(caseId, stopId);
    const attempt = requireCurrentAttempt(
      stop.current,
      ownData(fact, "attempt", "invalid_stop_timeout"),
      "unknown_stop_attempt",
    );
    if (attempt.status !== "pending") fail("stop_attempt_not_pending");
    attempt.timeouts += 1;
    appendEvent("stop-timeout", { caseId, stopId, attempt: attempt.ordinal });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function completeStop(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["caseId", "stopId", "attempt", "outcome", "error"], "invalid_stop_completion");
    const caseId = ownData(fact, "caseId", "invalid_stop_completion");
    const stopId = ownData(fact, "stopId", "invalid_stop_completion");
    const stop = requireStop(caseId, stopId);
    const attempt = requireCurrentAttempt(
      stop.current,
      ownData(fact, "attempt", "invalid_stop_completion"),
      "unknown_stop_attempt",
    );
    if (attempt.status !== "pending") fail("stop_attempt_not_pending");
    if (executionDomainEnded || reclaim.current !== null) fail("stop_execution_domain_ended");
    const outcome = ownData(fact, "outcome", "invalid_stop_completion");
    if (typeof outcome !== "string" || !STOP_OUTCOMES.has(outcome)) fail("invalid_stop_outcome");
    const errorRecord = parseErrorRecord(ownData(fact, "error", "invalid_stop_completion"), "invalid_stop_error");
    if (outcome === "success" && errorRecord.present) fail("successful_stop_cannot_have_error");
    if (outcome === "failure" && !errorRecord.present) fail("failed_stop_requires_error_presence");
    const retained = retainError(`stop:${String(caseId)}:${String(stopId)}`, errorRecord);
    appendEvent("stop-completed", { caseId, stopId, attempt: attempt.ordinal, outcome });
    attempt.status = "completed";
    attempt.outcome = /** @type {"success" | "failure"} */ (outcome);
    attempt.error = retained;
  }

  /** @param {unknown} auth @param {unknown} fact */
  function beginClosing(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["reason"], "invalid_closing_request");
    const reason = boundedIdentifier(
      ownData(fact, "reason", "invalid_closing_request"),
      config.limits.maxIdentifierLength,
      "invalid_closing_reason",
    );
    if (lifecycle === "closing") return;
    if (lifecycle !== "running" && lifecycle !== "allocated") fail("invalid_closing_transition");
    appendEvent("closing-begun", { reason });
    lifecycle = "closing";
    latchExecutionDomainEnd();
  }

  /** @param {unknown} auth @param {unknown} fact */
  function reserveResource(auth, fact) {
    return receiveChildFact(auth, fact, "owner",
      ["caseId", "resourceKey", "kind", "writerId", "sequence"], "invalid_resource_reservation",
      (data, writer, writerId) => {
        if (lifecycle === "closing") fail("late_reservation_timing_unknown");
        if (lifecycle !== "running") fail("new_creation_rejected");
        const caseId = ownData(data, "caseId", "invalid_resource_reservation");
        if (currentCaseId !== caseId) fail("resource_outside_current_case");
        requireStartedCase(caseId);
        const resourceKey = ownData(data, "resourceKey", "invalid_resource_reservation");
        if ((typeof resourceKey !== "object" || resourceKey === null) && typeof resourceKey !== "function") {
          fail("invalid_resource_key");
        }
        if (resources.has(resourceKey)) fail("duplicate_resource_key_preserved");
        const kind = ownData(data, "kind", "invalid_resource_reservation");
        if (typeof kind !== "string" || !RESOURCE_KINDS.has(kind)) fail("invalid_resource_kind");
        if (resources.size >= config.limits.maxResources) {
          resourceOverflow = true;
          fail("resource_capacity_exceeded_preserved");
        }
        const resource = /** @type {ResourceState} */ ({
          ordinal: resources.size + 1,
          caseId: /** @type {string} */ (caseId),
          resourceKey,
          kind: /** @type {"execution-child" | "detached-group"} */ (kind),
          state: "reserved",
          writerId,
          handleKey: null,
          pid: null,
          closeObserved: false,
          groupState: kind === "detached-group" ? "unknown" : "not-applicable",
          bindingUncertain: false,
          groupIdentityUncertain: false,
        });
        resources.set(resourceKey, resource);
        acceptWriterSequence(writer, "resource-reserved", { caseId, resource: resource.ordinal, kind, writerId });
      });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function bindResource(auth, fact) {
    return receiveChildFact(auth, fact, "resource",
      ["resourceKey", "handleKey", "pid", "writerId", "sequence"], "invalid_resource_binding",
      (data, writer, writerId, originalResource) => {
        const resource = /** @type {ResourceState} */ (originalResource);
        const handleKey = ownData(data, "handleKey", "invalid_resource_binding");
        if ((typeof handleKey !== "object" || handleKey === null) && typeof handleKey !== "function") {
          fail("invalid_handle_key");
        }
        const pid = ownData(data, "pid", "invalid_resource_binding");
        if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) fail("invalid_resource_pid");
        if (resource.state !== "reserved") {
          resource.bindingUncertain = true;
          fail("resource_rebinding_preserved");
        }
        if (handleBindings.has(handleKey) || pidBindings.has(/** @type {number} */ (pid))) {
          resource.state = "protocol-uncertain";
          resource.bindingUncertain = true;
          fail("resource_binding_collision_preserved");
        }
        resource.handleKey = handleKey;
        resource.pid = /** @type {number} */ (pid);
        resource.state = "bound";
        handleBindings.set(handleKey, resource);
        pidBindings.set(/** @type {number} */ (resource.pid), resource);
        acceptWriterSequence(writer, "resource-bound", { resource: resource.ordinal, writerId });
      });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function proveResourceNotCreated(auth, fact) {
    return receiveChildFact(auth, fact, "resource",
      ["resourceKey", "writerId", "sequence"], "invalid_not_created_fact",
      (_data, writer, writerId, originalResource) => {
        const resource = /** @type {ResourceState} */ (originalResource);
        if (resource.state !== "reserved") fail("not_created_state_contradiction");
        resource.state = "proven-not-created";
        acceptWriterSequence(writer, "resource-proven-not-created", { resource: resource.ordinal, writerId });
      });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function observeResourceClose(auth, fact) {
    return receiveChildFact(auth, fact, "close",
      ["resourceKey", "handleKey", "writerId", "sequence"], "invalid_resource_close",
      (data, writer, writerId, originalResource) => {
        const resource = /** @type {ResourceState} */ (originalResource);
        ownData(data, "handleKey", "invalid_resource_close");
        if (resource.state === "proven-not-created") fail("not_created_close_contradiction");
        if (resource.state !== "bound" || resource.closeObserved) fail("resource_close_state_contradiction");
        resource.closeObserved = true;
        resource.state = "close-observed";
        acceptWriterSequence(writer, "resource-close-observed", { resource: resource.ordinal, writerId });
      });
  }

  /** Parent adapter observation, independent of the child event stream and EOF.
   * @param {unknown} auth @param {unknown} fact */
  function observeResourceGroup(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["resourceKey", "handleKey", "groupState"], "invalid_resource_group_fact");
    const resourceKey = ownData(fact, "resourceKey", "invalid_resource_group_fact");
    const resource = requireResource(resourceKey);
    if (resource.state === "proven-not-created") preserveProtocol("not_created_group_contradiction");
    if (resource.kind !== "detached-group" ||
      (resource.state !== "bound" && resource.state !== "close-observed")) fail("resource_group_not_bound");
    if (ownData(fact, "handleKey", "invalid_resource_group_fact") !== resource.handleKey) fail("wrong_handle_key");
    const groupState = ownData(fact, "groupState", "invalid_resource_group_fact");
    if (typeof groupState !== "string" || !GROUP_STATES.has(groupState)) fail("invalid_observed_group_state");
    const regression = resource.groupState === "gone" && groupState !== "gone";
    resource.groupState = /** @type {"unknown" | "alive" | "gone"} */ (groupState);
    if (regression) {
      resource.groupIdentityUncertain = true;
      preserveProtocol("group_state_regression_preserved");
    }
    appendEvent("parent-resource-group-observed", { resource: resource.ordinal, groupState });
    latchExecutionDomainEnd();
  }

  /** @param {unknown} auth @param {unknown} fact */
  function recordWriterEof(auth, fact) {
    return receiveChildFact(auth, fact, "owner",
      ["writerId", "sequence", "completeFrame"], "invalid_writer_eof",
      (data, writer, writerId) => {
        const completeFrame = ownData(data, "completeFrame", "invalid_writer_eof");
        if (typeof completeFrame !== "boolean") fail("invalid_writer_eof");
        if (!completeFrame) fail("writer_partial_frame_preserved");
        writer.eof = true;
        acceptWriterSequence(writer, "writer-eof", { writerId });
        latchExecutionDomainEnd();
      });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function recordExecutionClose(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["kind", "exitCode", "signal"], "invalid_execution_close");
    if (execution.close) fail("execution_close_already_observed");
    const kind = ownData(fact, "kind", "invalid_execution_close");
    if (typeof kind !== "string" || !EXECUTION_END_KINDS.has(kind)) fail("invalid_execution_end_kind");
    const exitCode = ownData(fact, "exitCode", "invalid_execution_close");
    const signal = ownData(fact, "signal", "invalid_execution_close");
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) fail("invalid_execution_exit_code");
    if (signal !== null) {
      boundedIdentifier(signal, config.limits.maxIdentifierLength, "invalid_execution_signal");
    }
    appendEvent("execution-close-observed", { kind, exitCode, hasSignal: signal !== null });
    execution.close = {
      kind: /** @type {"natural" | "early-exit" | "forced"} */ (kind),
      exitCode: /** @type {number | null} */ (exitCode),
      signal: /** @type {string | null} */ (signal),
    };
    latchExecutionDomainEnd();
  }

  /** @param {unknown} auth @param {unknown} fact */
  function observeExecutionGroup(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["groupState"], "invalid_execution_group_fact");
    const groupState = ownData(fact, "groupState", "invalid_execution_group_fact");
    if (typeof groupState !== "string" || !GROUP_STATES.has(groupState)) fail("invalid_observed_group_state");
    const regression = execution.groupState === "gone" && groupState !== "gone";
    execution.groupState = /** @type {"unknown" | "alive" | "gone"} */ (groupState);
    if (regression) {
      execution.groupIdentityUncertain = true;
      protocolDamaged = true;
      appendEvent("execution-group-identity-uncertain", { groupState });
      fail("group_state_regression_preserved");
    }
    appendEvent("execution-group-observed", { groupState });
    latchExecutionDomainEnd();
  }

  /** Case stops run inside the execution tree; outer-owner operations are not modeled.
   * @param {string[]} blockers */
  function stopPassAndBlockers(blockers) {
    let pass = true;
    for (const [caseId, caseState] of caseStates) {
      for (const [stopId, stop] of caseState.stops) {
        const attempts = stop.attempts;
        const pending = attempts.some((attempt) => attempt.status === "pending");
        const timedOut = attempts.some((attempt) => attempt.timeouts > 0);
        let satisfied = false;
        if (stop.expected.expectFailureThenRecovery) {
          satisfied =
            attempts.length === 2 &&
            attempts[0]?.status === "completed" &&
            attempts[0]?.outcome === "failure" &&
            attempts[1]?.status === "completed" &&
            attempts[1]?.outcome === "success" &&
            !timedOut;
        } else {
          satisfied =
            attempts.length === 1 &&
            attempts[0]?.status === "completed" &&
            attempts[0]?.outcome === "success" &&
            !timedOut;
        }
        if (!satisfied) {
          pass = false;
          if (timedOut) blockers.push(`stop-timeout:${caseId}:${stopId}`);
          else if (pending) blockers.push(`stop-pending:${caseId}:${stopId}`);
          else if (attempts.some((attempt) => attempt.outcome === "failure")) {
            blockers.push(`stop-unexpected-failure:${caseId}:${stopId}`);
          } else {
            blockers.push(`stop-incomplete:${caseId}:${stopId}`);
          }
        }
      }
    }
    return pass;
  }

  /** @returns {ComputedStatus} */
  function computeStatus() {
    /** @type {string[]} */
    const blockers = [];
    /** @type {string[]} */
    const physicalBlockers = [];
    let casePass = true;
    for (const [caseId, state] of caseStates) {
      if (!state.result) {
        casePass = false;
        blockers.push(`case-result-missing:${caseId}`);
      } else if (state.result.outcome !== "pass") {
        casePass = false;
        blockers.push(`case-not-pass:${caseId}`);
      }
    }
    const stopPass = stopPassAndBlockers(blockers);
    if (protocolDamaged) {
      blockers.push("protocol-damaged");
      physicalBlockers.push("protocol-damaged");
    }
    if (eventOverflow || resourceOverflow || stopAttemptOverflow || errorOverflow) {
      blockers.push("bounded-state-overflow");
      physicalBlockers.push("bounded-state-overflow");
    }
    if (lifecycle !== "closing" && lifecycle !== "removed") {
      blockers.push("not-closing");
      physicalBlockers.push("not-closing");
    }
    if (!execution.close) {
      blockers.push("execution-close-missing");
      physicalBlockers.push("execution-close-missing");
    }
    if (execution.groupState !== "gone") {
      const blocker = `execution-group-${execution.groupState}`;
      blockers.push(blocker);
      physicalBlockers.push(blocker);
    }
    if (execution.groupIdentityUncertain) {
      blockers.push("execution-group-identity-uncertain");
      physicalBlockers.push("execution-group-identity-uncertain");
    }
    for (const [writerId, writer] of writerStates) {
      if (writer.damaged) {
        const blocker = `writer-damaged:${writerId}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
      if (!writer.eof) {
        const blocker = `writer-eof-missing:${writerId}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
    }
    for (const resource of resources.values()) {
      if (resource.state === "reserved") {
        const blocker = `resource-unbound:${resource.ordinal}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
      if (resource.state === "bound") {
        const blocker = `resource-close-missing:${resource.ordinal}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
      if (resource.state === "protocol-uncertain" || resource.bindingUncertain) {
        const blocker = `resource-binding-uncertain:${resource.ordinal}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
      if (resource.groupIdentityUncertain) {
        const blocker = `resource-group-identity-uncertain:${resource.ordinal}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
      if (
        resource.kind === "detached-group" &&
        resource.state !== "proven-not-created" &&
        resource.groupState !== "gone"
      ) {
        const blocker = `resource-group-${resource.groupState}:${resource.ordinal}`;
        blockers.push(blocker);
        physicalBlockers.push(blocker);
      }
    }
    const physicalEndCandidate = physicalBlockers.length === 0;
    const normalExecutionEnd =
      execution.close?.kind === "natural" &&
      execution.close.exitCode === 0 &&
      execution.close.signal === null;
    if (!normalExecutionEnd) blockers.push("execution-not-natural-success");
    const executionPassCandidate = casePass && stopPass && normalExecutionEnd;
    const reclaimSucceeded =
      lifecycle === "removed" && reclaim.current?.status === "completed" && reclaim.current.outcome === "removed";
    if (!reclaimSucceeded) blockers.push("reclaim-not-removed");
    const anyStopTimeout = [...caseStates.values()].some((caseState) =>
      [...caseState.stops.values()].some((stop) => stop.attempts.some((attempt) => attempt.timeouts > 0)),
    );
    const reclaimFailure = reclaim.attempts.some(
      (attempt) => attempt.timeouts > 0 || attempt.outcome === "failed",
    );
    const integrityPass =
      !protocolDamaged &&
      !eventOverflow &&
      !resourceOverflow &&
      !stopAttemptOverflow &&
      !errorOverflow &&
      !anyStopTimeout &&
      !reclaimFailure;
    if (!integrityPass) blockers.push("integrity-failure-retained");
    const reclaimCandidate = physicalEndCandidate && lifecycle === "closing";
    const overallPass = executionPassCandidate && physicalEndCandidate && reclaimSucceeded && integrityPass;
    return {
      blockers,
      casePass,
      stopPass,
      normalExecutionEnd,
      executionPassCandidate,
      physicalEndCandidate,
      reclaimCandidate,
      reclaimSucceeded,
      integrityPass,
      overallPass,
    };
  }

  /** @param {unknown} auth */
  function requestReclaim(auth) {
    requireAuth(auth);
    ensureMutable();
    if (!computeStatus().reclaimCandidate) fail("reclaim_not_candidate");
    latchExecutionDomainEnd();
    if (reclaim.current?.status === "pending") {
      return Object.freeze({ status: /** @type {const} */ ("pending"), attempt: reclaim.current.token });
    }
    const attempt = createAttempt("reclaim");
    reclaim.current = attempt;
    reclaim.attempts.push(attempt);
    appendEvent("reclaim-requested", { attempt: attempt.ordinal });
    return Object.freeze({ status: /** @type {const} */ ("started"), attempt: attempt.token });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function timeoutReclaim(auth, fact) {
    requireAuth(auth);
    ensureMutable();
    assertExactKeys(fact, ["attempt"], "invalid_reclaim_timeout");
    const attempt = requireCurrentAttempt(
      reclaim.current,
      ownData(fact, "attempt", "invalid_reclaim_timeout"),
      "unknown_reclaim_attempt",
    );
    if (attempt.status !== "pending") fail("reclaim_attempt_not_pending");
    attempt.timeouts += 1;
    appendEvent("reclaim-timeout", { attempt: attempt.ordinal });
  }

  /** @param {unknown} auth @param {unknown} fact */
  function completeReclaim(auth, fact) {
    requireAuth(auth);
    // An issued attempt owns a fixed terminal slot even when ordinary journals overflow.
    assertExactKeys(fact, ["attempt", "outcome", "error"], "invalid_reclaim_completion");
    const attempt = requireCurrentAttempt(
      reclaim.current,
      ownData(fact, "attempt", "invalid_reclaim_completion"),
      "unknown_reclaim_attempt",
    );
    if (attempt.status !== "pending") fail("reclaim_attempt_not_pending");
    const outcome = ownData(fact, "outcome", "invalid_reclaim_completion");
    if (outcome !== "failed" && outcome !== "removed") fail("invalid_reclaim_outcome");
    const errorRecord = parseErrorRecord(
      ownData(fact, "error", "invalid_reclaim_completion"),
      "invalid_reclaim_error",
    );
    if (outcome === "removed" && errorRecord.present) fail("removed_reclaim_cannot_have_error");
    if (outcome === "failed" && !errorRecord.present) fail("failed_reclaim_requires_error_presence");
    const retained = errorRecord.present
      ? Object.freeze({ scope: `reclaim:${attempt.ordinal}`, present: /** @type {const} */ (true), value: errorRecord.value })
      : null;
    attempt.status = "completed";
    attempt.outcome = outcome;
    attempt.error = retained;
    if (outcome === "removed") lifecycle = "removed";
    // Journal failure is reported after retaining the actual result, never instead of it.
    appendEvent("reclaim-completed", { attempt: attempt.ordinal, outcome });
  }

  /** @param {unknown} auth */
  function snapshot(auth) {
    requireAuth(auth, true);
    const status = computeStatus();
    return deepFreeze({
      lifecycle,
      adapterStatus: PM_SDK_QUIESCENCE_ADAPTER_STATUS,
      authority: "diagnostic-candidates-only",
      stopDomain: config.stopDomain,
      eventCount,
      errorCount: errors.length + reclaim.attempts.filter((attempt) => attempt.error !== null).length,
      ordinaryErrorCount: errors.length,
      reclaimTerminalErrorCount: reclaim.attempts.filter((attempt) => attempt.error !== null).length,
      overflow: {
        events: eventOverflow,
        resources: resourceOverflow,
        stopAttempts: stopAttemptOverflow,
        errors: errorOverflow,
      },
      protocolDamaged,
      executionDomainEnded,
      cases: [...caseStates.entries()].map(([caseId, state]) => ({
        caseId,
        begun: state.begun,
        result: state.result?.outcome ?? "missing",
        stops: [...state.stops.entries()].map(([stopId, stop]) => ({
          stopId,
          expectFailureThenRecovery: stop.expected.expectFailureThenRecovery,
          attempts: stop.attempts.map((attempt) => ({
            ordinal: attempt.ordinal,
            status: attempt.status === "pending" && executionDomainEnded ? "terminated-with-process" : attempt.status,
            settlementStatus: attempt.status,
            timeouts: attempt.timeouts,
            outcome: attempt.status === "pending" && executionDomainEnded ? "unknown-outcome" : attempt.outcome,
            errorPresent: attempt.error !== null,
          })),
        })),
      })),
      writers: [...writerStates.entries()].map(([writerId, writer]) => ({
        writerId,
        nextSequence: writer.nextSequence,
        eof: writer.eof,
        damaged: writer.damaged,
      })),
      resources: [...resources.values()].map((resource) => ({
        ordinal: resource.ordinal,
        caseId: resource.caseId,
        kind: resource.kind,
        state: resource.state,
        hasOriginalHandleKey: resource.handleKey !== null,
        hasPidMetadata: resource.pid !== null,
        closeObserved: resource.closeObserved,
        groupState: resource.groupState,
        bindingUncertain: resource.bindingUncertain,
        groupIdentityUncertain: resource.groupIdentityUncertain,
      })),
      execution: {
        closeObserved: execution.close !== null,
        endKind: execution.close?.kind ?? null,
        exitCode: execution.close?.exitCode ?? null,
        hasSignal: execution.close?.signal !== null && execution.close?.signal !== undefined,
        groupState: execution.groupState,
        groupIdentityUncertain: execution.groupIdentityUncertain,
      },
      reclaim: {
        currentStatus: reclaim.current?.status ?? "not-requested",
        currentOutcome: reclaim.current?.outcome ?? null,
        currentTimeouts: reclaim.current?.timeouts ?? 0,
        attempts: reclaim.attempts.length,
        failures: reclaim.attempts.filter(
          (attempt) => attempt.outcome === "failed" || attempt.timeouts > 0,
        ).length,
      },
      result: status,
    });
  }

  /** @param {unknown} auth */
  function diagnosticErrors(auth) {
    requireAuth(auth, true);
    return Object.freeze(
      [...errors, ...reclaim.attempts.flatMap((attempt) => attempt.error ? [attempt.error] : [])]
        .map((entry) => Object.freeze({ scope: entry.scope, present: /** @type {const} */ (true), value: entry.value })),
    );
  }

  return Object.freeze({
    credentials,
    beginRun,
    beginCase,
    recordCaseResult,
    requestStop,
    timeoutStop,
    completeStop,
    beginClosing,
    reserveResource,
    bindResource,
    proveResourceNotCreated,
    observeResourceClose,
    observeResourceGroup,
    recordWriterEof,
    recordExecutionClose,
    observeExecutionGroup,
    requestReclaim,
    timeoutReclaim,
    completeReclaim,
    snapshot,
    diagnosticErrors,
  });
}
