'use strict';
// @ts-check

const { spawn, execFile, ChildProcess } = require('node:child_process');
const { errorMonitor } = require('node:events');
const { promisify } = require('node:util');

const AUTHORIZATION = '--authorize=M4-PM-Q2-B2-CREATION-ENTRY';
const CASE_PREFIX = '--case=';
const CASES = new Set(['spawn', 'execFile', 'promisify-execFile']);
const NODE_BINDINGS = new Map([
  ['/opt/homebrew/Cellar/node/26.8.2/bin/node', 'v26.8.2'],
  [
    '/private/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node',
    'v22.19.0',
  ],
]);
const MAX_EVENTS = 128;
const MAX_STREAM_BYTES = 4096;

/** @typedef {'spawn' | 'execFile' | 'promisify-execFile'} CaseName */

/**
 * Exact CLI parser. Arguments may not be reordered, repeated, or extended.
 * @param {readonly string[]} argv
 * @returns {CaseName | null}
 */
function parseAuthorizedCase(argv) {
  if (argv.length !== 2 || argv[0] !== AUTHORIZATION || !argv[1]?.startsWith(CASE_PREFIX)) {
    return null;
  }
  const selected = argv[1].slice(CASE_PREFIX.length);
  return CASES.has(selected) ? /** @type {CaseName} */ (selected) : null;
}

/**
 * @param {{ execPath: string, version: string, platform: string, arch: string }} processLike
 */
function expectedNodeVersion(processLike) {
  const expected = NODE_BINDINGS.get(processLike.execPath);
  return processLike.platform === 'darwin' && processLike.arch === 'arm64' && expected === processLike.version
    ? expected
    : null;
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

/** @param {unknown} value */
function safeExitCode(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** @param {unknown} value */
function safeSignal(value) {
  return typeof value === 'string' ? value.slice(0, 32) : null;
}

/**
 * Executes one already-authorized creation case. The real entry points below
 * supply only captured Node built-ins; dependency injection exists for the
 * zero-process VM verifier.
 *
 * @param {any} dependencies
 * @returns {Promise<Record<string, unknown>>}
 */
function runCreationCase(dependencies) {
  const selectedCase = /** @type {CaseName} */ (dependencies.caseName);
  const api = dependencies.api;
  const ChildProcessClass = dependencies.ChildProcess;
  const createPrototypeSpawnGuard = dependencies.createPrototypeSpawnGuard;
  const monitorSymbol = dependencies.errorMonitor;
  const promisifyFunction = dependencies.promisify;
  const processLike = dependencies.process;
  const clock = dependencies.clock;
  const frameSink = dependencies.frameSink;
  const onProgress = typeof dependencies.onProgress === 'function' ? dependencies.onProgress : () => {};
  const subscribeOutputFailure = typeof dependencies.subscribeOutputFailure === 'function'
    ? dependencies.subscribeOutputFailure
    : null;
  const expectedVersion = dependencies.expectedVersion;

  if (!CASES.has(selectedCase) || typeof api?.spawn !== 'function' || typeof api?.execFile !== 'function' ||
      typeof ChildProcessClass !== 'function' || typeof createPrototypeSpawnGuard !== 'function' ||
      typeof promisifyFunction !== 'function' || typeof frameSink !== 'function' ||
      typeof clock?.now !== 'function' || typeof clock?.setTimeout !== 'function' ||
      typeof clock?.clearTimeout !== 'function' || typeof clock?.setInterval !== 'function' ||
      typeof clock?.clearInterval !== 'function' || typeof expectedVersion !== 'string') {
    return Promise.reject(new TypeError('invalid creation-entry dependencies'));
  }

  const prototype = ChildProcessClass.prototype;
  const savedDescriptor = Object.getOwnPropertyDescriptor(prototype, 'spawn');
  if (savedDescriptor === undefined || !('value' in savedDescriptor) || typeof savedDescriptor.value !== 'function') {
    return Promise.reject(new TypeError('ChildProcess.prototype.spawn is not an own data function'));
  }
  const savedSpawn = savedDescriptor.value;
  const started = clock.now();
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {string[]} */
  const frames = [];
  /** @type {string[]} */
  const failures = [];
  let eventOverflow = false;
  let droppedEvents = 0;
  let stdoutOverflow = false;
  let stderrOverflow = false;
  let originalCalls = 0;
  /** @type {unknown} */
  let originalThis;
  /** @type {unknown[]} */
  let originalArguments = [];
  /** @type {unknown} */
  let originalReturn;
  let originalReturnPresent = false;
  /** @type {unknown} */
  let originalThrow;
  let originalThrowPresent = false;
  /** @type {any} */
  let publicChild = null;
  /** @type {any} */
  let ownedReceiver = null;
  let nativeEntered = false;
  let childCloseObserverInstalled = false;
  let stdoutCloseObserverInstalled = false;
  let stderrCloseObserverInstalled = false;
  let stdinCloseObserverInstalled = false;
  /** @type {any} */
  let originalPromise = null;
  /** @type {unknown} */
  let promiseChild = null;
  let publicReturned = false;
  /** @type {unknown} */
  let publicThrow;
  let publicThrowPresent = false;
  let descriptorRestored = false;
  let restoreAttempted = false;
  let callbackCalls = 0;
  let callbackErrorNull = false;
  /** @type {unknown} */
  let callbackError;
  /** @type {unknown} */
  let callbackStdout;
  /** @type {unknown} */
  let callbackStderr;
  let promiseSettled = selectedCase !== 'promisify-execFile';
  let promiseFulfilled = false;
  /** @type {unknown} */
  let promiseError;
  /** @type {unknown} */
  let promiseStdout;
  /** @type {unknown} */
  let promiseStderr;
  let spawnObserved = false;
  /** @type {null | { code: number | null, signal: string | null }} */
  let childExit = null;
  /** @type {null | { code: number | null, signal: string | null }} */
  let childClose = null;
  let childErrorObserved = false;
  let stdoutEnd = false;
  let stdoutClose = false;
  let stderrEnd = false;
  let stderrClose = false;
  let stdinEndCalled = false;
  let stdinEndCallback = false;
  let stdinEndCallbackSucceeded = false;
  let stdinEndCallbackErrorPresent = false;
  let stdinFinish = false;
  let stdinClose = false;
  let observationDeadline = false;
  let cleanupDeadline = false;
  let parentOutputFailed = false;
  let finalized = false;
  let evaluating = false;
  let stdoutText = '';
  let stderrText = '';
  /** @type {unknown} */
  let firstRawError;
  let firstRawErrorPresent = false;
  /** @type {ReturnType<typeof clock.setTimeout> | undefined} */
  let observationTimer;
  /** @type {ReturnType<typeof clock.setTimeout> | undefined} */
  let cleanupTimer;
  /** @type {ReturnType<typeof clock.setInterval> | undefined} */
  let keeper;
  /** @type {(value: Record<string, unknown>) => void} */
  let resolveResult = () => {};
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });

  /** @param {string} code */
  function fail(code) {
    if (!failures.includes(code)) failures.push(code);
  }

  /** @param {unknown} error */
  function rawError(error) {
    if (!firstRawErrorPresent) {
      firstRawErrorPresent = true;
      firstRawError = error;
    }
  }

  /** @param {unknown} error */
  function latchParentOutputFailure(error) {
    parentOutputFailed = true;
    rawError(error);
    fail('parent-output-error');
    maybeFinalize();
  }

  /** @param {Record<string, unknown>} value */
  function emitProgress(value) {
    try {
      const outcome = Reflect.apply(onProgress, undefined, [value]);
      if (outcome === false) {
        latchParentOutputFailure(new Error('progress output returned failure'));
      } else if (outcome !== null && (typeof outcome === 'object' || typeof outcome === 'function')) {
        Promise.resolve(outcome).then((written) => {
          if (written === false) latchParentOutputFailure(new Error('progress output returned failure'));
        }, latchParentOutputFailure);
      }
    } catch (error) {
      rawError(error);
      fail('progress-report-failed');
    }
  }

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  function event(type, detail = {}) {
    if (events.length >= MAX_EVENTS) {
      eventOverflow = true;
      droppedEvents = Math.min(0xffff_ffff, droppedEvents + 1);
      fail('event-budget');
      return;
    }
    events.push({
      sequence: events.length + 1,
      type,
      elapsedNanoseconds: String(clock.now() - started),
      ...detail,
    });
  }

  /** @param {unknown} chunk @param {'stdout' | 'stderr'} stream */
  function appendChunk(chunk, stream) {
    if (stream === 'stdout' ? stdoutOverflow : stderrOverflow) return;
    let text;
    try {
      text = typeof chunk === 'string' ? chunk : Buffer.from(/** @type {any} */ (chunk)).toString('utf8');
    } catch (error) {
      rawError(error);
      fail(`${stream}-decode`);
      return;
    }
    const current = stream === 'stdout' ? stdoutText : stderrText;
    if (Buffer.byteLength(current, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_STREAM_BYTES) {
      if (stream === 'stdout') stdoutOverflow = true;
      else stderrOverflow = true;
      fail(`${stream}-budget`);
      return;
    }
    if (stream === 'stdout') stdoutText += text;
    else stderrText += text;
    event(`${stream}-data`, { bytes: Buffer.byteLength(text, 'utf8') });
  }

  /** @param {Uint8Array} frame */
  function writeFrame(frame) {
    const written = Reflect.apply(frameSink, undefined, [frame]);
    if (written === frame.byteLength) {
      let text = '';
      for (const byte of frame) text += String.fromCharCode(byte);
      frames.push(text);
      event('guard-frame', { frame: text.trimEnd().slice(0, 80) });
    }
    return written;
  }

  /** @type {ReturnType<typeof createPrototypeSpawnGuard>} */
  let guard;

  /**
   * @this {unknown}
   * @param {...unknown} args
   */
  function originalSpawn(...args) {
    originalCalls += 1;
    originalThis = this;
    originalArguments = args;
    const slot = guard.owned()[0];
    if (slot === undefined || slot.receiver !== this || slot.reserveWritten !== true || slot.nativeEntered !== true) {
      fail('reserve-or-receiver-mismatch-before-native');
    }
    try {
      const result = Reflect.apply(savedSpawn, this, args);
      originalReturnPresent = true;
      originalReturn = result;
      return result;
    } catch (error) {
      originalThrowPresent = true;
      originalThrow = error;
      throw error;
    }
  }

  /**
   * Installs one observer without allowing diagnostic registration failures to
   * escape the owner path. No ordinary child `error` listener is installed.
   * @param {any} target
   * @param {string | symbol} name
   * @param {(...args:any[])=>void} listener
   * @param {string} failure
   */
  function tryOn(target, name, listener, failure) {
    try {
      target.on(name, listener);
      return true;
    } catch (error) {
      rawError(error);
      fail(failure);
      return false;
    }
  }

  /** @param {any} receiver @param {{onClose: () => void, onError: (error: unknown) => void}} callbacks */
  function installObserver(receiver, callbacks) {
    ownedReceiver = receiver;
    let registrationFailed = false;
    /** @type {unknown} */
    let registrationError;
    /** Pre-native rejection must reach A1; post-native stream tryOn remains nonthrowing.
     * @param {string | symbol} name @param {(...args:any[])=>void} listener @param {string} code */
    function requireObserver(name, listener, code) {
      try {
        receiver.on(name, listener);
        return true;
      } catch (error) {
        if (!registrationFailed) registrationError = error;
        registrationFailed = true;
        rawError(error);
        fail(code);
        return false;
      }
    }
    requireObserver(monitorSymbol, (/** @type {unknown} */ error) => {
      childErrorObserved = true;
      rawError(error);
      event('child-error-monitor');
      callbacks.onError(error);
      maybeFinalize();
    }, 'child-error-observer-install');
    childCloseObserverInstalled = requireObserver('close', (/** @type {unknown} */ code, /** @type {unknown} */ signal) => {
      if (childClose === null) childClose = { code: safeExitCode(code), signal: safeSignal(signal) };
      event('child-close', childClose ?? {});
      callbacks.onClose();
      maybeFinalize();
    }, 'child-close-observer-install');
    if (registrationFailed) throw registrationError;
  }

  guard = createPrototypeSpawnGuard({ originalSpawn, writeFrame, installObserver });
  if (subscribeOutputFailure !== null) {
    try {
      subscribeOutputFailure(latchParentOutputFailure);
    } catch (error) {
      rawError(error);
      fail('parent-output-subscribe-failed');
    }
  }

  function installStreamObservers() {
    if (ownedReceiver === null) {
      fail('owned-receiver-missing');
      return;
    }
    const child = ownedReceiver;
    tryOn(child, 'spawn', () => {
      spawnObserved = true;
      event('child-spawn');
      maybeFinalize();
    }, 'child-spawn-observer-install');
    tryOn(child, 'exit', (/** @type {unknown} */ code, /** @type {unknown} */ signal) => {
      if (childExit === null) childExit = { code: safeExitCode(code), signal: safeSignal(signal) };
      event('child-exit', childExit ?? {});
      maybeFinalize();
    }, 'child-exit-observer-install');

    /** @type {any} */
    let stdout = null;
    /** @type {any} */
    let stderr = null;
    /** @type {any} */
    let stdin = null;
    try { stdout = child.stdout; } catch (error) { rawError(error); fail('stdout-read'); }
    try { stderr = child.stderr; } catch (error) { rawError(error); fail('stderr-read'); }
    try { stdin = child.stdin; } catch (error) { rawError(error); fail('stdin-read'); }

    if (stdout === null || stdout === undefined) {
      fail('stdout-missing');
    } else {
      tryOn(stdout, monitorSymbol, (/** @type {unknown} */ error) => {
        rawError(error); fail('stdout-error'); event('stdout-error-monitor');
      }, 'stdout-error-observer-install');
      tryOn(stdout, 'data', (/** @type {unknown} */ chunk) => appendChunk(chunk, 'stdout'), 'stdout-data-observer-install');
      tryOn(stdout, 'end', () => { stdoutEnd = true; event('stdout-end'); maybeFinalize(); }, 'stdout-end-observer-install');
      stdoutCloseObserverInstalled = tryOn(
        stdout,
        'close',
        () => { stdoutClose = true; event('stdout-close'); maybeFinalize(); },
        'stdout-close-observer-install',
      );
    }

    if (stderr === null || stderr === undefined) {
      fail('stderr-missing');
    } else {
      tryOn(stderr, monitorSymbol, (/** @type {unknown} */ error) => {
        rawError(error); fail('stderr-error'); event('stderr-error-monitor');
      }, 'stderr-error-observer-install');
      tryOn(stderr, 'data', (/** @type {unknown} */ chunk) => appendChunk(chunk, 'stderr'), 'stderr-data-observer-install');
      tryOn(stderr, 'end', () => { stderrEnd = true; event('stderr-end'); maybeFinalize(); }, 'stderr-end-observer-install');
      stderrCloseObserverInstalled = tryOn(
        stderr,
        'close',
        () => { stderrClose = true; event('stderr-close'); maybeFinalize(); },
        'stderr-close-observer-install',
      );
    }

    if (stdin === null || stdin === undefined) {
      fail('stdin-missing');
    } else {
      tryOn(stdin, monitorSymbol, (/** @type {unknown} */ error) => {
        rawError(error); fail('stdin-error'); event('stdin-error-monitor');
      }, 'stdin-error-observer-install');
      tryOn(stdin, 'finish', () => { stdinFinish = true; event('stdin-finish'); maybeFinalize(); }, 'stdin-finish-observer-install');
      stdinCloseObserverInstalled = tryOn(
        stdin,
        'close',
        () => { stdinClose = true; event('stdin-close'); maybeFinalize(); },
        'stdin-close-observer-install',
      );
      try {
        stdinEndCalled = true;
        stdin.end((/** @type {unknown} */ error) => {
          stdinEndCallback = true;
          if (error !== null && error !== undefined) {
            stdinEndCallbackErrorPresent = true;
            rawError(error);
            fail('stdin-end-callback-error');
          } else {
            stdinEndCallbackSucceeded = true;
          }
          event('stdin-end-callback', { errorPresent: error !== null && error !== undefined });
          maybeFinalize();
        });
      } catch (error) {
        rawError(error);
        fail('stdin-end-throw');
      }
    }
  }

  /** @returns {boolean} */
  function resourcesEnded() {
    return childCloseObserverInstalled && childClose !== null &&
      stdoutCloseObserverInstalled && stdoutClose &&
      stderrCloseObserverInstalled && stderrClose &&
      stdinCloseObserverInstalled && stdinClose;
  }

  /** @returns {boolean} */
  function terminalFactsPresent() {
    const completion = selectedCase === 'spawn'
      ? true
      : selectedCase === 'execFile'
        ? callbackCalls > 0
        : promiseSettled;
    return childClose !== null && childExit !== null && stdoutEnd && stdoutClose && stderrEnd && stderrClose &&
      stdinEndCalled && stdinEndCallback && stdinFinish && stdinClose && completion;
  }

  /** @returns {boolean} */
  function evaluateSuccess() {
    if (originalCalls !== 1) fail('original-call-count');
    if (!originalReturnPresent || originalReturn !== 0) fail('native-return');
    if (originalThrowPresent || publicThrowPresent) fail('unexpected-sync-throw');
    if (!publicReturned || publicChild === null || originalThis !== publicChild) fail('public-child-this-identity');
    const slot = guard.owned()[0];
    if (slot === undefined || slot.receiver !== ownedReceiver) fail('guard-owned-receiver-identity');
    if (publicChild === null || ownedReceiver !== publicChild) fail('public-child-guard-identity');
    if (selectedCase === 'promisify-execFile' && promiseChild !== publicChild) fail('promise-child-identity');
    if (!spawnObserved) fail('missing-spawn-event');
    if (childExit?.code !== 0 || childExit.signal !== null) fail('child-exit-status');
    if (childClose?.code !== 0 || childClose.signal !== null) fail('child-close-status');
    if (stdoutText !== `${expectedVersion}\n`) fail('stdout-version');
    if (stderrText !== '') fail('stderr-not-empty');
    if (!stdoutEnd || !stdoutClose || !stderrEnd || !stderrClose) fail('stream-terminal-missing');
    if (!stdinEndCalled || !stdinEndCallback || !stdinEndCallbackSucceeded || stdinEndCallbackErrorPresent ||
        !stdinFinish || !stdinClose) fail('stdin-terminal-missing');
    if (selectedCase === 'execFile') {
      if (callbackCalls !== 1 || !callbackErrorNull || callbackStdout !== `${expectedVersion}\n` || callbackStderr !== '') {
        fail('execfile-callback-result');
      }
    }
    if (selectedCase === 'promisify-execFile') {
      if (!promiseSettled || !promiseFulfilled || promiseStdout !== `${expectedVersion}\n` || promiseStderr !== '') {
        fail('promisify-result');
      }
    }
    if (!descriptorRestored) fail('prototype-not-restored');
    if (eventOverflow || observationDeadline || cleanupDeadline || childErrorObserved) fail('observed-failure');
    try {
      guard.assertHealthy();
    } catch (error) {
      rawError(error);
      fail('guard-unhealthy');
    }
    return failures.length === 0;
  }

  /** @param {string} kind */
  function report(kind) {
    const slot = guard.owned()[0];
    return {
      kind,
      case: selectedCase,
      ok: kind === 'final' ? evaluateSuccess() : false,
      failures: [...failures],
      frames: [...frames],
      original: {
        calls: originalCalls,
        thisMatchesPublicChild: publicChild !== null && originalThis === publicChild,
        thisMatchesOwnedReceiver: ownedReceiver !== null && originalThis === ownedReceiver,
        argumentCount: originalArguments.length,
        returnPresent: originalReturnPresent,
        returnIsZero: originalReturnPresent && originalReturn === 0,
        throwPresent: originalThrowPresent,
      },
      publicApi: {
        returned: publicReturned,
        threw: publicThrowPresent,
        childMatchesGuardReceiver: publicChild !== null && slot?.receiver === publicChild,
        publicChildMatchesOwnedReceiver: publicChild !== null && publicChild === ownedReceiver,
        promiseChildMatches: selectedCase === 'promisify-execFile' ? promiseChild === publicChild : null,
        callbackCalls,
        callbackErrorNull,
        promiseSettled,
        promiseFulfilled,
      },
      prototype: { restored: descriptorRestored, restoreAttempted },
      terminal: {
        nativeEntered,
        resourcesEnded: resourcesEnded(),
        observers: {
          childClose: childCloseObserverInstalled,
          stdoutClose: stdoutCloseObserverInstalled,
          stderrClose: stderrCloseObserverInstalled,
          stdinClose: stdinCloseObserverInstalled,
        },
        spawnObserved,
        childErrorObserved,
        childExit,
        childClose,
        stdoutEnd,
        stdoutClose,
        stderrEnd,
        stderrClose,
        stdinEndCalled,
        stdinEndCallback,
        stdinEndCallbackSucceeded,
        stdinEndCallbackErrorPresent,
        stdinFinish,
        stdinClose,
        observationDeadline,
        cleanupDeadline,
      },
      output: {
        stdout: stdoutText,
        stderr: stderrText,
        stdoutOverflow,
        stderrOverflow,
        parentFailed: parentOutputFailed,
      },
      guard: {
        closed: guard.snapshot().closed,
        failed: guard.snapshot().failed,
        slots: guard.owned().length,
      },
      events: [...events],
      droppedEvents,
      rawErrorPresent: firstRawErrorPresent,
      ownerExitRequiresExternalObservation: true,
    };
  }

  function clearOwnedTimers() {
    if (observationTimer !== undefined) clock.clearTimeout(observationTimer);
    if (cleanupTimer !== undefined) clock.clearTimeout(cleanupTimer);
    if (keeper !== undefined) clock.clearInterval(keeper);
  }

  function maybeFinalize() {
    if (finalized || evaluating || !restoreAttempted) return;
    evaluating = true;
    try {
      const complete = terminalFactsPresent();
      if (nativeEntered && !complete && !resourcesEnded()) return;
      if (nativeEntered && !complete && !observationDeadline && !cleanupDeadline) return;
      finalized = true;
      clearOwnedTimers();
      const finalReport = report('final');
      resolveResult(finalReport);
    } finally {
      evaluating = false;
    }
  }

  const args = ['--version'];
  const commonOptions = {
    shell: false,
    detached: false,
    env: { LANG: 'C', LC_ALL: 'C' },
  };

  try {
    Object.defineProperty(prototype, 'spawn', { ...savedDescriptor, value: guard.spawn });
    try {
      if (selectedCase === 'spawn') {
        publicChild = api.spawn(processLike.execPath, args, { ...commonOptions, stdio: ['pipe', 'pipe', 'pipe'] });
        publicReturned = true;
      } else if (selectedCase === 'execFile') {
        publicChild = api.execFile(
          processLike.execPath,
          args,
          { ...commonOptions, encoding: 'utf8', maxBuffer: MAX_STREAM_BYTES },
          (/** @type {unknown} */ error, /** @type {unknown} */ stdout, /** @type {unknown} */ stderr) => {
            callbackCalls += 1;
            callbackErrorNull = error === null;
            callbackError = error;
            callbackStdout = stdout;
            callbackStderr = stderr;
            if (error !== null) { rawError(error); fail('execfile-callback-error'); }
            event('execfile-callback');
            maybeFinalize();
          },
        );
        publicReturned = true;
      } else {
        const promisedExecFile = promisifyFunction(api.execFile);
        originalPromise = promisedExecFile(
          processLike.execPath,
          args,
          { ...commonOptions, encoding: 'utf8', maxBuffer: MAX_STREAM_BYTES },
        );
        promiseChild = originalPromise.child;
        publicChild = promiseChild;
        if ((typeof publicChild !== 'object' || publicChild === null) && typeof publicChild !== 'function') {
          publicChild = null;
          fail('promisify-child-missing');
        }
        publicReturned = true;
        originalPromise.then(
          (/** @type {any} */ value) => {
            promiseSettled = true;
            promiseFulfilled = true;
            promiseStdout = value.stdout;
            promiseStderr = value.stderr;
            event('promisify-fulfilled');
            maybeFinalize();
          },
          (/** @type {unknown} */ error) => {
            promiseSettled = true;
            promiseError = error;
            rawError(error);
            fail('promisify-rejected');
            event('promisify-rejected');
            maybeFinalize();
          },
        );
      }
      guard.closeAdmission();
    } catch (error) {
      publicThrowPresent = true;
      publicThrow = error;
      rawError(error);
      fail('public-api-throw');
      try { guard.closeAdmission(); } catch (closeError) { rawError(closeError); fail('guard-close-failed'); }
    } finally {
      restoreAttempted = true;
      try {
        Object.defineProperty(prototype, 'spawn', savedDescriptor);
        descriptorRestored = sameDescriptor(Object.getOwnPropertyDescriptor(prototype, 'spawn'), savedDescriptor);
        if (!descriptorRestored) fail('prototype-restore-mismatch');
      } catch (error) {
        rawError(error);
        fail('prototype-restore-failed');
      }
    }
  } catch (error) {
    rawError(error);
    fail('prototype-install-failed');
  }

  const ownedSlot = guard.owned()[0];
  nativeEntered = ownedSlot?.nativeEntered === true;
  if (!nativeEntered) {
    maybeFinalize();
    return resultPromise;
  }

  // The keeper exists before every post-native stream read or registration.
  keeper = clock.setInterval(() => {}, 1000);
  observationTimer = clock.setTimeout(() => {
    if (finalized) return;
    observationDeadline = true;
    fail('observation-deadline');
    event('deadline-5s');
    emitProgress(report('observation-timeout'));
    maybeFinalize();
  }, 5000);
  cleanupTimer = clock.setTimeout(() => {
    if (finalized) return;
    cleanupDeadline = true;
    fail('cleanup-unconfirmed');
    event('deadline-10s');
    emitProgress(report('cleanup-unconfirmed'));
    // No kill, exit, unref, detach, listener removal, or owner release here.
    maybeFinalize();
  }, 10000);
  installStreamObservers();
  maybeFinalize();
  void callbackError;
  void promiseError;
  void publicThrow;
  void originalThrow;
  void firstRawError;
  return resultPromise;
}

function realClock() {
  return {
    now: () => process.hrtime.bigint(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
}

/** @param {Uint8Array} frame */
function memoryFrameSink(frame) {
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy.byteLength;
}

/**
 * Installs one persistent, non-recursive parent-output error channel. A write
 * callback acknowledges only that write; the error listener remains for the
 * rest of the entry lifetime.
 * @param {any} output
 * @param {{exitCode?: string | number | null}} processLike
 */
function createSafeOutputChannel(output, processLike) {
  let failed = false;
  let firstErrorPresent = false;
  /** @type {unknown} */
  let firstError;
  /** @type {Set<(error:unknown)=>void>} */
  const subscribers = new Set();
  /** @type {Set<(ok:boolean)=>void>} */
  const pending = new Set();

  /** @param {unknown} error */
  function latch(error) {
    if (!firstErrorPresent) {
      firstErrorPresent = true;
      firstError = error;
    }
    failed = true;
    try { processLike.exitCode = 1; } catch {}
    for (const finish of [...pending]) finish(false);
    for (const subscriber of [...subscribers]) {
      try { subscriber(firstError); } catch {}
    }
  }

  try {
    output.on('error', latch);
  } catch (error) {
    latch(error);
  }

  /** @param {(error:unknown)=>void} subscriber */
  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') throw new TypeError('output failure subscriber must be a function');
    subscribers.add(subscriber);
    if (failed) subscriber(firstError);
  }

  /** @param {string} text */
  function writeText(text) {
    if (failed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      /** @param {boolean} ok */
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        pending.delete(finish);
        resolve(ok && !failed);
      };
      pending.add(finish);
      try {
        output.write(text, (/** @type {unknown} */ error) => {
          if (error !== null && error !== undefined) {
            latch(error);
            finish(false);
          } else {
            finish(true);
          }
        });
      } catch (error) {
        latch(error);
        finish(false);
      }
    });
  }

  /** @param {Record<string, unknown>} value */
  function writeJson(value) {
    let text;
    try {
      text = `${JSON.stringify(value)}\n`;
    } catch (error) {
      latch(error);
      return Promise.resolve(false);
    }
    return writeText(text);
  }

  return Object.freeze({
    failed: () => failed,
    subscribe,
    writeText,
    writeJson,
  });
}

/**
 * Writes an isolated report through a persistent error channel. Entry points
 * create one channel before parsing and reuse it for progress and final output.
 * @param {any} output
 * @param {Record<string, unknown>} value
 */
function writeReport(output, value) {
  return createSafeOutputChannel(output, { exitCode: undefined }).writeJson(value);
}

/**
 * CJS direct entry. A1 is dynamically loaded only after the exact gate and
 * fixed runtime binding pass, and still before prototype installation.
 */
async function cjsMain() {
  const output = createSafeOutputChannel(process.stdout, process);
  const selectedCase = parseAuthorizedCase(process.argv.slice(2));
  if (selectedCase === null) {
    process.exitCode = 64;
    const written = await output.writeText('NOT_AUTHORIZED\n');
    if (!written || output.failed()) process.exitCode = 1;
    return;
  }
  const expectedVersion = expectedNodeVersion(process);
  if (expectedVersion === null) {
    process.exitCode = 1;
    await output.writeJson({ kind: 'configuration-rejected' });
    return;
  }
  if (output.failed()) return;
  const { createPrototypeSpawnGuard } = await import('./helpers/pm-sdk-quiescence-adapter.mjs');
  if (output.failed()) return;
  const report = await runCreationCase({
    caseName: selectedCase,
    api: { spawn, execFile },
    ChildProcess,
    createPrototypeSpawnGuard,
    errorMonitor,
    promisify,
    process,
    clock: realClock(),
    frameSink: memoryFrameSink,
    expectedVersion,
    onProgress: (/** @type {Record<string, unknown>} */ value) => output.writeJson(value),
    subscribeOutputFailure: output.subscribe,
  });
  const written = await output.writeJson(report);
  if (!written || output.failed() || report.ok !== true) process.exitCode = 1;
  else if (process.exitCode !== 1) process.exitCode = 0;
}

module.exports = {
  AUTHORIZATION,
  CASE_PREFIX,
  parseAuthorizedCase,
  expectedNodeVersion,
  runCreationCase,
  realClock,
  memoryFrameSink,
  createSafeOutputChannel,
  writeReport,
  cjsMain,
};

if (require.main === module) {
  cjsMain().catch(() => {
    process.exitCode = 1;
  });
}
