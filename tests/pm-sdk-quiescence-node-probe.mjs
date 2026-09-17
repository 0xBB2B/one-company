import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AUTHORIZATION = '--authorize=M4-PM-Q2-B1-FD-MINIMAL';
const CASE_PREFIX = '--case=';
const CASES = new Set(['normal', 'partial', 'closed-fd']);
const NODE_BINDINGS = new Map([
  ['/opt/homebrew/Cellar/node/26.8.2/bin/node', 'v26.8.2'],
  [
    '/private/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node',
    'v22.19.0',
  ],
]);
const CHILD_PATH = fileURLToPath(new URL('./fixtures/pm-sdk-quiescence-child.cjs', import.meta.url));
const LENGTH_PREFIX_BYTES = 2;
const MAX_FRAME_BYTES = 256;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - LENGTH_PREFIX_BYTES;
const MAX_FRAMES = 32;
const MAX_RECEIVED_BYTES = 8192;
const MAX_EVENTS = 128;
const MAX_DROPPED_EVENTS = 0xffff_ffff;
const DESCRIPTOR_TYPES = new Set(['socket', 'fifo', 'file', 'character', 'block', 'other']);
const SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
  'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV',
  'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
  'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);

/** @typedef {'normal' | 'partial' | 'closed-fd'} CaseName */
/** @typedef {{ present: boolean, value: unknown }} RawErrorSlot */

/** @type {RawErrorSlot} */
const stdoutErrorSlot = { present: false, value: undefined };
let stdoutFailed = false;
/** @type {() => void} */
let notifyOutputFailure = () => {};

/** @param {unknown} error */
function markOutputFailure(error) {
  if (!stdoutErrorSlot.present) {
    stdoutErrorSlot.present = true;
    stdoutErrorSlot.value = error;
  }
  if (stdoutFailed) return;
  stdoutFailed = true;
  process.exitCode = 1;
  try {
    notifyOutputFailure();
  } catch {
    process.exitCode = 1;
  }
}

process.stdout.on('error', markOutputFailure);

/** @param {string} text */
function safeWrite(text) {
  if (stdoutFailed) return false;
  try {
    process.stdout.write(text);
    return true;
  } catch (error) {
    markOutputFailure(error);
    return false;
  }
}

/** @param {object} value */
function safeEmit(value) {
  if (stdoutFailed) return false;
  try {
    return safeWrite(`${JSON.stringify(value)}\n`);
  } catch (error) {
    markOutputFailure(error);
    return false;
  }
}

/** @returns {CaseName | null} */
function parseCase() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== AUTHORIZATION || !args[1].startsWith(CASE_PREFIX)) {
    return null;
  }

  const caseName = args[1].slice(CASE_PREFIX.length);
  return CASES.has(caseName) ? /** @type {CaseName} */ (caseName) : null;
}

/** @param {unknown} value */
function trustedText(value) {
  return typeof value === 'string' ? value.slice(0, 160) : 'invalid';
}

/** @param {unknown} value */
function trustedExitCode(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** @param {unknown} value */
function trustedSignal(value) {
  return typeof value === 'string' && SIGNALS.has(value) ? /** @type {NodeJS.Signals} */ (value) : null;
}

/** @param {RawErrorSlot} slot @param {unknown} error */
function captureRawError(slot, error) {
  if (!slot.present) {
    slot.present = true;
    slot.value = error;
  }
}

const caseName = parseCase();
if (caseName === null) {
  process.exitCode = 64;
  safeWrite('NOT_AUTHORIZED\n');
} else {
  const requiredVersion = NODE_BINDINGS.get(process.execPath);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || requiredVersion !== process.version) {
    process.exitCode = 1;
    safeEmit({
      kind: 'configuration-rejected',
      case: caseName,
      platform: trustedText(process.platform),
      arch: trustedText(process.arch),
      execPath: trustedText(process.execPath),
      version: trustedText(process.version),
    });
  } else {
    runProbe(caseName);
  }
}

/** @param {CaseName} selectedCase */
function runProbe(selectedCase) {
  const startedAt = process.hrtime.bigint();
  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {Array<{ raw: string, kind: string, sequence: number | null, descriptorType?: string, writeReturn?: number }>} */
  const frames = [];
  let droppedEvents = 0;
  let eventBudgetExceeded = false;
  let payloadAccumulationDisabled = false;
  let receivedBytes = 0;
  let frameCount = 0;
  let pending = Buffer.alloc(0);
  let discardRemaining = 0;
  let discardDeclaredLength = 0;
  let discardReceived = 0;
  let finalized = false;
  /** @type {null | ({ code: string } & Record<string, unknown>)} */
  let firstError = null;

  const rawErrors = {
    /** @type {RawErrorSlot} */ syncSpawn: { present: false, value: undefined },
    /** @type {RawErrorSlot} */ child: { present: false, value: undefined },
    /** @type {RawErrorSlot} */ stream: { present: false, value: undefined },
  };

  /** @type {{
   * syncSpawnError: boolean,
   * childError: boolean,
   * childExit: null | { code: number | null, signal: NodeJS.Signals | null },
   * childClose: null | { code: number | null, signal: NodeJS.Signals | null },
   * streamEnd: boolean,
   * streamError: boolean,
   * streamClose: boolean,
   * outputError: boolean,
   * residual: null | { declaredLength: number | null, availablePayloadBytes: number, totalBufferedBytes: number, hex: string | null },
   * deadline5: boolean,
   * deadline10: boolean,
   * }} */
  const terminal = {
    syncSpawnError: false,
    childError: false,
    childExit: null,
    childClose: null,
    streamEnd: false,
    streamError: false,
    streamClose: false,
    outputError: stdoutFailed,
    residual: null,
    deadline5: false,
    deadline10: false,
  };

  /** @param {string} code @param {Record<string, unknown>} [detail] */
  function fail(code, detail = {}) {
    if (firstError === null) {
      firstError = { code, ...detail };
    }
  }

  notifyOutputFailure = () => {
    terminal.outputError = true;
    fail('stdout-error');
  };

  /** @param {string} type @param {Record<string, unknown>} [detail] */
  function recordEvent(type, detail = {}) {
    if (events.length >= MAX_EVENTS) {
      droppedEvents = Math.min(MAX_DROPPED_EVENTS, droppedEvents + 1);
      if (!eventBudgetExceeded) {
        eventBudgetExceeded = true;
        payloadAccumulationDisabled = true;
        pending = Buffer.alloc(0);
        fail('event-budget-exceeded', { limit: MAX_EVENTS });
      }
      return;
    }
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    events.push({ sequence: events.length + 1, type, elapsedNanoseconds: elapsedNanoseconds.toString(), ...detail });
  }

  /** @param {Buffer} body */
  function acceptFrame(body) {
    frameCount += 1;
    if (frameCount > MAX_FRAMES) {
      fail('frame-count-exceeded', { limit: MAX_FRAMES });
      return;
    }
    for (const byte of body) {
      if (byte < 0x20 || byte > 0x7e) {
        fail('non-ascii-frame');
        return;
      }
    }

    const raw = body.toString('ascii');
    const meta = /^META:1:(socket|fifo|file|character|block|other)$/.exec(raw);
    if (meta !== null && DESCRIPTOR_TYPES.has(meta[1])) {
      frames.push({ raw, kind: 'META', sequence: 1, descriptorType: meta[1] });
      recordEvent('frame', { kind: 'META', sequenceValue: 1 });
      return;
    }
    if (raw === 'DATA:2:probe') {
      frames.push({ raw, kind: 'DATA', sequence: 2 });
      recordEvent('frame', { kind: 'DATA', sequenceValue: 2 });
      return;
    }
    if (raw === 'ACK:3:14') {
      frames.push({ raw, kind: 'ACK', sequence: 3, writeReturn: 14 });
      recordEvent('frame', { kind: 'ACK', sequenceValue: 3 });
      return;
    }

    frames.push({ raw: raw.slice(0, MAX_PAYLOAD_BYTES), kind: 'UNKNOWN', sequence: null });
    fail('unknown-frame');
    recordEvent('frame', { kind: 'UNKNOWN' });
  }

  /** @param {Buffer | string} chunk */
  function consume(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, receivedBytes + bytes.length);
    recordEvent('stream-data', { bytes: bytes.length });
    if (receivedBytes > MAX_RECEIVED_BYTES) {
      fail('received-byte-budget-exceeded', { limit: MAX_RECEIVED_BYTES });
      payloadAccumulationDisabled = true;
      pending = Buffer.alloc(0);
      return;
    }

    if (payloadAccumulationDisabled) {
      if (discardRemaining > 0) {
        const discarded = Math.min(discardRemaining, bytes.length);
        discardRemaining -= discarded;
        discardReceived += discarded;
      }
      return;
    }

    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= LENGTH_PREFIX_BYTES) {
      const payloadLength = pending.readUInt16BE(0);
      if (payloadLength > MAX_PAYLOAD_BYTES) {
        fail('frame-payload-too-large', {
          declaredLength: payloadLength,
          maxFrameBytes: MAX_FRAME_BYTES,
          maxPayloadBytes: MAX_PAYLOAD_BYTES,
        });
        discardDeclaredLength = payloadLength;
        const available = pending.length - LENGTH_PREFIX_BYTES;
        const discarded = Math.min(payloadLength, available);
        discardReceived = discarded;
        discardRemaining = payloadLength - discarded;
        pending = Buffer.alloc(0);
        payloadAccumulationDisabled = true;
        return;
      }
      if (pending.length < payloadLength + LENGTH_PREFIX_BYTES) return;
      const body = pending.subarray(LENGTH_PREFIX_BYTES, payloadLength + LENGTH_PREFIX_BYTES);
      pending = pending.subarray(payloadLength + LENGTH_PREFIX_BYTES);
      acceptFrame(body);
      if (payloadAccumulationDisabled) {
        pending = Buffer.alloc(0);
        return;
      }
    }
  }

  function finishStream() {
    terminal.streamEnd = true;
    if (discardDeclaredLength > 0 && discardReceived < discardDeclaredLength) {
      terminal.residual = {
        declaredLength: discardDeclaredLength,
        availablePayloadBytes: discardReceived,
        totalBufferedBytes: discardReceived + LENGTH_PREFIX_BYTES,
        hex: null,
      };
    } else if (pending.length > 0) {
      const declaredLength = pending.length >= LENGTH_PREFIX_BYTES ? pending.readUInt16BE(0) : null;
      terminal.residual = {
        declaredLength,
        availablePayloadBytes: pending.length >= LENGTH_PREFIX_BYTES ? pending.length - LENGTH_PREFIX_BYTES : 0,
        totalBufferedBytes: pending.length,
        hex: pending.toString('hex').slice(0, MAX_FRAME_BYTES * 2),
      };
    }
    recordEvent('stream-end');
  }

  /** @returns {{ ok: boolean, normalWriteReceipt: null | { reportedPreviousWriteReturn: number, expectedFrameBytes: number }, expectedFailureMatched: boolean, transportProtocol: string }} */
  function evaluateProtocol() {
    /** @type {null | { reportedPreviousWriteReturn: number, expectedFrameBytes: number }} */
    let normalWriteReceipt = null;
    let expectedFailureMatched = false;
    let matched = false;

    const metaValid =
      frames.length >= 1 &&
      frames[0].kind === 'META' &&
      frames[0].sequence === 1 &&
      /^META:1:(socket|fifo|file|character|block|other)$/.test(frames[0].raw);
    if (selectedCase === 'normal') {
      const expectedDataFrameBytes = Buffer.byteLength('DATA:2:probe', 'ascii') + LENGTH_PREFIX_BYTES;
      matched =
        frames.length === 3 &&
        metaValid &&
        frames[1].kind === 'DATA' &&
        frames[1].raw === 'DATA:2:probe' &&
        frames[2].kind === 'ACK' &&
        frames[2].raw === 'ACK:3:14' &&
        frames[2].writeReturn === expectedDataFrameBytes &&
        terminal.residual === null &&
        terminal.childExit?.code === 0 &&
        terminal.childExit?.signal === null &&
        terminal.childClose?.code === 0 &&
        terminal.childClose?.signal === null;
      if (frames[2]?.kind === 'ACK' && frames[2].writeReturn === 14) {
        normalWriteReceipt = {
          reportedPreviousWriteReturn: 14,
          expectedFrameBytes: expectedDataFrameBytes,
        };
      }
    } else if (selectedCase === 'partial') {
      expectedFailureMatched =
        frames.length === 1 &&
        metaValid &&
        terminal.residual?.declaredLength === 8 &&
        terminal.residual.availablePayloadBytes === 1 &&
        terminal.residual.totalBufferedBytes === 3 &&
        terminal.residual.hex === '000858' &&
        terminal.childExit?.code === 20 &&
        terminal.childExit?.signal === null &&
        terminal.childClose?.code === 20 &&
        terminal.childClose?.signal === null;
      matched = expectedFailureMatched;
    } else {
      expectedFailureMatched =
        frames.length === 1 &&
        metaValid &&
        terminal.residual === null &&
        terminal.childExit?.code === 21 &&
        terminal.childExit?.signal === null &&
        terminal.childClose?.code === 21 &&
        terminal.childClose?.signal === null;
      matched = expectedFailureMatched;
    }

    const transportHealthy =
      terminal.streamEnd &&
      !terminal.streamError &&
      !terminal.childError &&
      terminal.childExit !== null &&
      terminal.childClose !== null;
    const ok =
      matched &&
      transportHealthy &&
      firstError === null &&
      !eventBudgetExceeded &&
      !terminal.outputError &&
      !terminal.deadline5 &&
      !terminal.deadline10;
    return {
      ok,
      normalWriteReceipt,
      expectedFailureMatched,
      transportProtocol: ok ? (selectedCase === 'normal' ? 'passed' : 'expected-failure-matched') : 'failed',
    };
  }

  /** @param {string} kind */
  function snapshot(kind) {
    const protocol = evaluateProtocol();
    return {
      kind,
      case: selectedCase,
      ok: protocol.ok,
      normalWriteReceipt: protocol.normalWriteReceipt,
      expectedFailureMatched: protocol.expectedFailureMatched,
      transportProtocol: protocol.transportProtocol,
      originalProcessClose: terminal.childClose !== null,
      deadlineFailure: terminal.deadline5 || terminal.deadline10,
      firstError,
      terminal,
      receivedBytes,
      frameCount,
      frames,
      events,
      droppedEvents,
      eventBudgetExceeded,
      outputFailure: terminal.outputError,
    };
  }

  const args = [CHILD_PATH, AUTHORIZATION, `${CASE_PREFIX}${selectedCase}`];
  /** @type {import('node:child_process').SpawnOptions} */
  const options = {
    shell: false,
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    env: { LANG: 'C', LC_ALL: 'C' },
  };

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  try {
    child = spawn(process.execPath, args, options);
  } catch (error) {
    captureRawError(rawErrors.syncSpawn, error);
    terminal.syncSpawnError = true;
    fail('spawn-threw');
    recordEvent('spawn-throw');
    finalized = true;
    process.exitCode = 1;
    safeEmit(snapshot('final'));
    return;
  }

  const originalChild = /** @type {import('node:child_process').ChildProcess} */ (child);
  recordEvent('spawn-returned');
  originalChild.on('error', (error) => {
    captureRawError(rawErrors.child, error);
    terminal.childError = true;
    fail('child-error');
    recordEvent('child-error');
  });
  originalChild.on('exit', (code, signal) => {
    if (terminal.childExit === null) {
      terminal.childExit = { code: trustedExitCode(code), signal: trustedSignal(signal) };
    }
    recordEvent('child-exit', terminal.childExit);
  });

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let observationTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let cleanupTimer;
  const keeper = setInterval(() => {}, 1000);

  originalChild.on('close', (code, signal) => {
    if (terminal.childClose === null) {
      terminal.childClose = { code: trustedExitCode(code), signal: trustedSignal(signal) };
    }
    recordEvent('child-close', terminal.childClose);
    if (finalized) return;
    finalized = true;
    if (observationTimer !== undefined) clearTimeout(observationTimer);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    clearInterval(keeper);
    if (!terminal.streamEnd) fail('child-close-before-stream-end');
    const result = snapshot('final');
    process.exitCode = result.ok ? 0 : 1;
    safeEmit(result);
  });

  const fd3 = /** @type {import('node:stream').Readable | null | undefined} */ (originalChild.stdio[3]);
  if (fd3 === null || typeof fd3 === 'undefined' || typeof fd3.on !== 'function') {
    fail('missing-fd3-read-stream');
  } else {
    fd3.on('data', consume);
    fd3.on('end', finishStream);
    fd3.on('error', (error) => {
      captureRawError(rawErrors.stream, error);
      terminal.streamError = true;
      fail('stream-error');
      recordEvent('stream-error');
    });
    fd3.on('close', () => {
      terminal.streamClose = true;
      recordEvent('stream-close');
    });
    fd3.resume();
  }

  observationTimer = setTimeout(() => {
    if (finalized) return;
    terminal.deadline5 = true;
    fail('observation-deadline');
    recordEvent('deadline-5s');
    process.exitCode = 1;
    safeEmit(snapshot('observation-timeout'));
  }, 5000);

  cleanupTimer = setTimeout(() => {
    if (finalized) return;
    terminal.deadline10 = true;
    fail('cleanup-unconfirmed');
    recordEvent('deadline-10s');
    process.exitCode = 1;
    safeEmit(snapshot('cleanup-unconfirmed'));
  }, 10000);
}
