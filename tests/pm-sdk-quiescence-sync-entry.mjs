// @ts-check

import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const AUTHORIZATION = '--authorize=M4-PM-Q2-B4-SYNC-ENTRY';
const CASE_ARGUMENT = '--case=spawnSync';
const MAX_DIAGNOSTICS = 16;
const MAX_ELAPSED_NANOSECONDS = 5_000_000_000n;
const NODE_BINDINGS = new Map([
  ['/opt/homebrew/Cellar/node/26.8.2/bin/node', 'v26.8.2'],
  [
    '/private/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node',
    'v22.19.0',
  ],
]);
const GUARD_REJECTED = Object.freeze({ code: 'SYNC_GUARD_REJECTED' });
const EXPORT_REJECTED = Object.freeze({ code: 'SYNC_EXPORT_REJECTED' });

/** @param {unknown} value */
function isCallable(value) {
  return typeof value === 'function';
}

/** @param {PropertyDescriptor | undefined} left @param {PropertyDescriptor | undefined} right */
function sameDescriptor(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set;
}

/**
 * Captures an own data function without invoking accessors.
 * @param {Record<string, unknown> | Function} target
 * @param {string} name
 */
function captureOwnDataFunction(target, name) {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor === undefined || !('value' in descriptor) || !isCallable(descriptor.value)) {
    throw new TypeError(`invalid own data function: ${name}`);
  }
  return Object.freeze({ name, descriptor, value: descriptor.value });
}

/**
 * Minimal one-attempt synchronous call guard. It never starts a timer and
 * therefore cannot interrupt a blocking native synchronous call.
 * @param {{original:Function, record:(event:Readonly<{sequence:number,kind:'R'|'S'|'throw'}>)=>unknown, now:()=>unknown}} dependencies
 */
export function createSyncCallGuard(dependencies) {
  if ((typeof dependencies !== 'object' || dependencies === null) && typeof dependencies !== 'function') {
    throw new TypeError('invalid sync guard dependencies');
  }
  const original = captureOwnDataFunction(dependencies, 'original').value;
  const record = captureOwnDataFunction(dependencies, 'record').value;
  const now = captureOwnDataFunction(dependencies, 'now').value;

  let attempted = false;
  let nativeCalls = 0;
  let protocolRecords = 0;
  /** @type {bigint | null} */
  let startedAt = null;
  /** @type {bigint | null} */
  let elapsedNanoseconds = null;
  /** @type {null | Readonly<{code:string,valuePresent:boolean,value:unknown}>} */
  let firstFailure = null;
  /** @type {Readonly<{code:string}>[]} */
  const diagnostics = [];
  /** @type {Readonly<{kind:'not-entered'}>|Readonly<{kind:'return',value:unknown}>|Readonly<{kind:'throw',value:unknown}>} */
  let nativeOutcome = Object.freeze({ kind: 'not-entered' });

  /** @param {string} code @param {boolean} valuePresent @param {unknown} value */
  function fail(code, valuePresent = false, value = undefined) {
    if (firstFailure === null) firstFailure = Object.freeze({ code, valuePresent, value });
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(Object.freeze({ code }));
  }

  /** @param {'R'|'S'|'throw'} kind @param {number} sequence @param {boolean} fatal */
  function writeProtocol(kind, sequence, fatal) {
    const event = Object.freeze({ sequence, kind });
    let returned;
    try {
      returned = Reflect.apply(record, undefined, [event]);
    } catch (error) {
      fail(`record-${kind}-throw`, true, error);
      if (fatal) throw error;
      return false;
    }
    if (returned !== undefined) {
      fail(`record-${kind}-return`, true, returned);
      if (fatal) throw GUARD_REJECTED;
      return false;
    }
    protocolRecords += 1;
    return true;
  }

  /** @param {'start'|'end'} phase @param {boolean} fatal */
  function readClock(phase, fatal) {
    let value;
    try {
      value = Reflect.apply(now, undefined, []);
    } catch (error) {
      fail(`clock-${phase}-throw`, true, error);
      if (fatal) throw error;
      return null;
    }
    if (typeof value !== 'bigint' || value < 0n) {
      fail(`clock-${phase}-invalid`, true, value);
      if (fatal) throw GUARD_REJECTED;
      return null;
    }
    return value;
  }

  /**
   * @this {unknown}
   * @param {...unknown} args
   */
  function invoke(...args) {
    if (attempted) {
      fail('attempt-repeated');
      throw GUARD_REJECTED;
    }
    attempted = true;

    startedAt = readClock('start', true);
    writeProtocol('R', 1, true);
    if (firstFailure !== null) throw GUARD_REJECTED;

    try {
      nativeCalls += 1;
      const result = Reflect.apply(original, this, args);
      nativeOutcome = Object.freeze({ kind: 'return', value: result });
      const endedAt = readClock('end', false);
      if (endedAt !== null && startedAt !== null) {
        if (endedAt < startedAt) fail('clock-regressed');
        else {
          elapsedNanoseconds = endedAt - startedAt;
          if (elapsedNanoseconds > MAX_ELAPSED_NANOSECONDS) fail('elapsed-limit');
        }
      }
      writeProtocol('S', 2, false);
      return result;
    } catch (error) {
      if (nativeOutcome.kind !== 'return') {
        nativeOutcome = Object.freeze({ kind: 'throw', value: error });
        const endedAt = readClock('end', false);
        if (endedAt !== null && startedAt !== null) {
          if (endedAt < startedAt) fail('clock-regressed');
          else {
            elapsedNanoseconds = endedAt - startedAt;
            if (elapsedNanoseconds > MAX_ELAPSED_NANOSECONDS) fail('elapsed-limit');
          }
        }
        writeProtocol('throw', 2, false);
      }
      throw error;
    }
  }

  function snapshot() {
    const failure = firstFailure === null
      ? null
      : Object.freeze({
        code: firstFailure.code,
        valuePresent: firstFailure.valuePresent,
        value: firstFailure.value,
      });
    const outcome = nativeOutcome.kind === 'not-entered'
      ? Object.freeze({ kind: 'not-entered' })
      : Object.freeze({ kind: nativeOutcome.kind, value: nativeOutcome.value });
    return Object.freeze({
      attempted,
      failed: firstFailure !== null,
      nativeCalls,
      protocolRecords,
      elapsedNanoseconds,
      firstFailure: failure,
      diagnostics: Object.freeze([...diagnostics]),
      nativeOutcome: outcome,
    });
  }

  // Health covers local timing/recording only. Native success is represented
  // separately by nativeOutcome and must be checked by the caller.
  function assertHealthy() {
    if (firstFailure !== null) throw GUARD_REJECTED;
  }

  return Object.freeze({ invoke, snapshot, assertHealthy });
}

/** @param {readonly string[]} argv */
export function parseAuthorizedCase(argv) {
  return argv.length === 2 && argv[0] === AUTHORIZATION && argv[1] === CASE_ARGUMENT
    ? 'spawnSync'
    : null;
}

/** @param {{execPath:string,version:string,platform:string,arch:string}} processLike */
function expectedVersion(processLike) {
  const version = NODE_BINDINGS.get(processLike.execPath);
  return processLike.platform === 'darwin' && processLike.arch === 'arm64' && version === processLike.version
    ? version
    : null;
}

/** @param {unknown} value @param {string} name */
function ownDataValue(value, name) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return Object.freeze({ present: false, data: false, value: undefined });
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor === undefined
    ? Object.freeze({ present: false, data: false, value: undefined })
    : Object.freeze({ present: true, data: 'value' in descriptor, value: 'value' in descriptor ? descriptor.value : undefined });
}

/**
 * Installs the guard on the real-shaped CJS object, synchronizes the ESM named
 * binding, invokes only that named binding, and restores complete descriptors.
 * @param {{
 *   childProcess:Record<string,unknown>,
 *   getSpawnSyncBinding:()=>unknown,
 *   syncBuiltinESMExports:()=>unknown,
 *   processLike:{execPath:string,version:string,platform:string,arch:string},
 *   now:()=>unknown,
 * }} dependencies
 */
export function runSyncSpawnCase(dependencies) {
  const cp = dependencies.childProcess;
  const getSpawnSyncBinding = dependencies.getSpawnSyncBinding;
  const synchronize = dependencies.syncBuiltinESMExports;
  const processLike = dependencies.processLike;
  const now = dependencies.now;
  if ((typeof cp !== 'object' || cp === null) || !isCallable(getSpawnSyncBinding) ||
      !isCallable(synchronize) || !isCallable(now) || expectedVersion(processLike) === null) {
    throw new TypeError('invalid sync case dependencies');
  }

  const captured = [
    captureOwnDataFunction(cp, 'spawnSync'),
    captureOwnDataFunction(cp, 'execFileSync'),
    captureOwnDataFunction(cp, 'execSync'),
  ];
  const originalSpawn = captured[0].value;
  const oldCjsReference = cp.spawnSync;
  const initialNamedBinding = getSpawnSyncBinding();
  if (oldCjsReference !== originalSpawn || initialNamedBinding !== originalSpawn) {
    throw new TypeError('initial child_process binding mismatch');
  }

  /** @type {Readonly<{sequence:number,kind:'R'|'S'|'throw'}>[]} */
  const records = [];
  /** @type {string[]} */
  const failures = [];
  /** @param {string} code */
  function fail(code) {
    if (failures.length < MAX_DIAGNOSTICS && !failures.includes(code)) failures.push(code);
  }
  let synchronousExportViolation = false;
  /** @param {'execFileSync'|'execSync'} name */
  function denySynchronousExport(name) {
    synchronousExportViolation = true;
    fail(`disabled-export-invoked-${name}`);
    throw EXPORT_REJECTED;
  }
  function denyExecFileSync() { return denySynchronousExport('execFileSync'); }
  function denyExecSync() { return denySynchronousExport('execSync'); }
  function guardedNow() {
    if (synchronousExportViolation) throw GUARD_REJECTED;
    const value = Reflect.apply(now, undefined, []);
    if (synchronousExportViolation) throw GUARD_REJECTED;
    return value;
  }
  const guard = createSyncCallGuard({
    original: originalSpawn,
    record(event) {
      if (synchronousExportViolation || records.length >= 2) return false;
      records.push(event);
      return undefined;
    },
    now: guardedNow,
  });

  let installed = false;
  let esmInstalled = false;
  let disabledExportsInstalled = false;
  let restorationAttempted = false;
  let descriptorsRestored = false;
  let esmRestored = false;
  let nativeReturnPresent = false;
  /** @type {unknown} */
  let nativeReturn;
  let invocationThrowPresent = false;

  try {
    Object.defineProperty(cp, 'spawnSync', { ...captured[0].descriptor, value: guard.invoke });
    Object.defineProperty(cp, 'execFileSync', { ...captured[1].descriptor, value: denyExecFileSync });
    Object.defineProperty(cp, 'execSync', { ...captured[2].descriptor, value: denyExecSync });
    installed = true;
    disabledExportsInstalled = sameDescriptor(
      Object.getOwnPropertyDescriptor(cp, 'execFileSync'),
      { ...captured[1].descriptor, value: denyExecFileSync },
    ) && sameDescriptor(
      Object.getOwnPropertyDescriptor(cp, 'execSync'),
      { ...captured[2].descriptor, value: denyExecSync },
    );
    if (!disabledExportsInstalled) fail('disabled-export-install-mismatch');
    if (synchronousExportViolation) throw GUARD_REJECTED;
    Reflect.apply(synchronize, undefined, []);
    if (synchronousExportViolation) throw GUARD_REJECTED;
    const installedBinding = getSpawnSyncBinding();
    if (synchronousExportViolation) throw GUARD_REJECTED;
    esmInstalled = installedBinding === guard.invoke;
    if (!esmInstalled) fail('esm-install-mismatch');
    if (oldCjsReference !== originalSpawn || oldCjsReference === guard.invoke) fail('old-cjs-reference-changed');

    if (esmInstalled && disabledExportsInstalled && !synchronousExportViolation) {
      try {
        nativeReturn = Reflect.apply(/** @type {Function} */ (getSpawnSyncBinding()), cp, [
          processLike.execPath,
          ['--version'],
          Object.freeze({
            cwd: '/',
            env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
            shell: false,
            encoding: 'utf8',
            maxBuffer: 4096,
            input: '',
            stdio: Object.freeze(['pipe', 'pipe', 'pipe']),
          }),
        ]);
        nativeReturnPresent = true;
      } catch (error) {
        invocationThrowPresent = true;
      }
    }
  } catch (error) {
    fail('installation-failed');
  } finally {
    restorationAttempted = true;
    for (const { name, descriptor } of captured) {
      try {
        Object.defineProperty(cp, name, descriptor);
      } catch (error) {
        fail(`descriptor-restore-failed-${name}`);
      }
    }
    try {
      descriptorsRestored = captured.every(({ name, descriptor }) =>
        sameDescriptor(Object.getOwnPropertyDescriptor(cp, name), descriptor));
      if (!descriptorsRestored) fail('descriptor-restore-mismatch');
    } catch (error) {
      fail('descriptor-restore-inspect-failed');
    }
    try {
      Reflect.apply(synchronize, undefined, []);
      esmRestored = getSpawnSyncBinding() === originalSpawn;
      if (!esmRestored) fail('esm-restore-mismatch');
    } catch (error) {
      fail('esm-restore-failed');
    }
  }

  const guardState = guard.snapshot();
  const nativeThrowPresent = guardState.nativeOutcome.kind === 'throw';
  const nativeThrow = nativeThrowPresent ? guardState.nativeOutcome.value : undefined;
  if (invocationThrowPresent && !nativeThrowPresent && !guardState.failed) fail('invoke-threw-outside-native');
  let resultObject = false;
  let resultIdentity = false;
  let errorAbsent = false;
  /** @type {number | null} */
  let status = null;
  let statusZero = false;
  let signalNull = false;
  let stdoutMatches = false;
  let stderrEmpty = false;
  /** @type {number | null} */
  let pid = null;
  if (nativeReturnPresent) {
    resultObject = (typeof nativeReturn === 'object' && nativeReturn !== null) || typeof nativeReturn === 'function';
    resultIdentity = guardState.nativeOutcome.kind === 'return' && guardState.nativeOutcome.value === nativeReturn;
    try {
      errorAbsent = !Reflect.has(/** @type {object} */ (nativeReturn), 'error');
      const statusSlot = ownDataValue(nativeReturn, 'status');
      const signalSlot = ownDataValue(nativeReturn, 'signal');
      const stdoutSlot = ownDataValue(nativeReturn, 'stdout');
      const stderrSlot = ownDataValue(nativeReturn, 'stderr');
      const pidSlot = ownDataValue(nativeReturn, 'pid');
      if (statusSlot.present && statusSlot.data && typeof statusSlot.value === 'number' && Number.isSafeInteger(statusSlot.value)) {
        status = statusSlot.value;
      }
      statusZero = status === 0;
      signalNull = signalSlot.present && signalSlot.data && signalSlot.value === null;
      stdoutMatches = stdoutSlot.present && stdoutSlot.data && stdoutSlot.value === `${processLike.version}\n`;
      stderrEmpty = stderrSlot.present && stderrSlot.data && stderrSlot.value === '';
      if (pidSlot.present && pidSlot.data && typeof pidSlot.value === 'number' && Number.isSafeInteger(pidSlot.value)) {
        pid = pidSlot.value;
      }
    } catch (error) {
      fail('result-inspect-failed');
    }
  }

  if (!installed) fail('not-installed');
  if (!disabledExportsInstalled) fail('disabled-exports-not-installed');
  if (synchronousExportViolation) fail('disabled-export-violation');
  if (!nativeReturnPresent) fail(nativeThrowPresent ? 'native-threw' : 'native-not-called');
  if (guardState.failed) fail('guard-failed');
  if (guardState.nativeCalls !== 1) fail('native-call-count');
  if (records.length !== 2 || records[0]?.kind !== 'R' || records[1]?.kind !== 'S') fail('protocol-order');
  if (!resultObject) fail('result-not-object');
  if (!resultIdentity) fail('result-identity');
  if (!errorAbsent) fail('result-error-present');
  if (!statusZero) fail('result-status');
  if (!signalNull) fail('result-signal');
  if (!stdoutMatches) fail('result-stdout');
  if (!stderrEmpty) fail('result-stderr');
  if (!restorationAttempted || !descriptorsRestored || !esmRestored) fail('restore-incomplete');

  const report = {
    kind: 'sync-spawn-case',
    caseName: 'spawnSync',
    ok: failures.length === 0,
    expectedVersion: processLike.version,
    installed,
    esmInstalled,
    oldCjsReferenceUnchanged: oldCjsReference === originalSpawn && oldCjsReference !== guard.invoke,
    disabledExportsInstalled,
    synchronousExportViolation,
    native: Object.freeze({
      returned: nativeReturnPresent,
      threw: nativeThrowPresent,
      resultObject,
      resultIdentity,
      errorAbsent,
      status,
      statusZero,
      signalNull,
      stdoutMatches,
      stderrEmpty,
      pid,
    }),
    protocol: Object.freeze(records.map((event) => event.kind)),
    elapsedNanoseconds: guardState.elapsedNanoseconds === null ? null : String(guardState.elapsedNanoseconds),
    guard: Object.freeze({
      attempted: guardState.attempted,
      failed: guardState.failed,
      nativeCalls: guardState.nativeCalls,
      protocolRecords: guardState.protocolRecords,
      firstFailureCode: guardState.firstFailure?.code ?? null,
      diagnosticCount: guardState.diagnostics.length,
    }),
    restoration: Object.freeze({ attempted: restorationAttempted, descriptors: descriptorsRestored, esmBinding: esmRestored }),
    failures: Object.freeze([...failures]),
    limitations: Object.freeze({
      noTimeoutOrKillSignal: true,
      synchronousBlockingNotInterruptible: true,
      oldCjsDestructuredReferencesNotIntercepted: true,
      lexicalSyncInternalsNotIntercepted: true,
      noProcessTreeOrNativeCleanupClaim: true,
    }),
  };
  Object.defineProperty(report, 'originalResult', { value: nativeReturn, enumerable: false });
  Object.defineProperty(report, 'originalThrow', { value: nativeThrow, enumerable: false });
  return Object.freeze(report);
}

/**
 * Parent output stays subscribed for late failures. Failures never recurse into
 * another write and always force a non-zero outer process result.
 * @param {{on:(name:string,listener:(error:unknown)=>void)=>unknown,write:(text:string,callback?:(error?:unknown)=>void)=>unknown}} output
 * @param {{exitCode?:string|number|null}} processLike
 */
export function createSafeOutputChannel(output, processLike) {
  let failed = false;
  let writes = 0;
  /** @param {unknown} _error */
  function latch(_error) {
    failed = true;
    processLike.exitCode = 1;
  }
  try {
    output.on('error', latch);
  } catch (error) {
    latch(error);
  }
  /** @param {string} text */
  function writeText(text) {
    if (failed) return false;
    writes += 1;
    try {
      output.write(text, function (error) {
        if (arguments.length > 0 && error !== null && error !== undefined) latch(error);
      });
    } catch (error) {
      latch(error);
    }
    return !failed;
  }
  return Object.freeze({ writeText, failed: () => failed, writes: () => writes });
}

/** @param {ReturnType<typeof runSyncSpawnCase>} report */
function safeReport(report) {
  return {
    kind: report.kind,
    caseName: report.caseName,
    ok: report.ok,
    expectedVersion: report.expectedVersion,
    installed: report.installed,
    esmInstalled: report.esmInstalled,
    oldCjsReferenceUnchanged: report.oldCjsReferenceUnchanged,
    disabledExportsInstalled: report.disabledExportsInstalled,
    synchronousExportViolation: report.synchronousExportViolation,
    native: report.native,
    protocol: report.protocol,
    elapsedNanoseconds: report.elapsedNanoseconds,
    guard: report.guard,
    restoration: report.restoration,
    failures: report.failures,
    limitations: report.limitations,
  };
}

export function main() {
  const output = createSafeOutputChannel(process.stdout, process);
  const selectedCase = parseAuthorizedCase(process.argv.slice(2));
  if (selectedCase === null) {
    process.exitCode = 64;
    if (!output.writeText('NOT_AUTHORIZED\n') || output.failed()) process.exitCode = 1;
    return;
  }
  if (expectedVersion(process) === null) {
    process.exitCode = 1;
    output.writeText('{"kind":"configuration-rejected"}\n');
    return;
  }
  if (output.failed()) return;

  let report;
  try {
    report = runSyncSpawnCase({
      childProcess,
      getSpawnSyncBinding: () => spawnSync,
      syncBuiltinESMExports,
      processLike: process,
      now: () => process.hrtime.bigint(),
    });
  } catch (error) {
    process.exitCode = 1;
    output.writeText('{"kind":"sync-spawn-case","ok":false,"failures":["runner-failed"]}\n');
    return;
  }
  process.exitCode = report.ok ? 0 : 1;
  const text = `${JSON.stringify(safeReport(report))}\n`;
  if (!output.writeText(text) || output.failed()) process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
