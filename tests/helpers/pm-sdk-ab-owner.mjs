// @ts-check
import cp from "node:child_process";
import * as cpBindings from "node:child_process";
import threads from "node:worker_threads";
import * as threadBindings from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { errorMonitor } from "node:events";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrototypeSpawnGuard } from "./pm-sdk-quiescence-adapter.mjs";

export const FIXTURE = "tests/fixtures/pm-sdk-ab-owner.fixture.ts";
export const TEST_NAME = "pm sdk ab owner mechanism";
export const PRELOAD_URL = new URL("./pm-sdk-ab-owner.mjs", import.meta.url).href;
const STATE_KEY = Symbol.for("pi.test.pm-sdk-ab-owner.v1");
const MESSAGE = "PM SDK AB owner rejected operation; resources preserved";

/** @returns {Error} */
export function rejection() { return new Error(MESSAGE); }

/** Private opaque error cell; snapshots never inspect or return the thrown value. */
export function createFailureLatch() {
  let failed = false;
  /** @type {{value: unknown} | undefined} */ let first;
  /** @type {string | null} */ let code = null;
  return Object.freeze({
    /** @param {string} diagnostic @param {unknown} [error] */
    fail(diagnostic, error) {
      if (!failed) { failed = true; first = { value: error }; code = diagnostic; }
      process.exitCode = 1;
    },
    assert() { if (failed) throw rejection(); },
    snapshot() { return Object.freeze({ failed, code, opaqueErrorRetained: failed && first !== undefined }); },
  });
}
/** @typedef {ReturnType<typeof createFailureLatch>} Latch */

/** @param {string} nonce @param {Latch} latch */
export function createControlWriter(nonce, latch) {
  let sequence = 0;
  let bytes = 0;
  let terminal = false;
  return Object.freeze({
    /** @param {string} kind */
    send(kind) {
      try {
        latch.assert();
        if (terminal || !/^[a-z-]{1,24}$/u.test(kind)) throw rejection();
        const frame = Buffer.from(JSON.stringify({ v: 1, n: nonce, s: ++sequence, k: kind }) + "\n");
        bytes += frame.length;
        if (sequence > 128 || frame.length > 256 || bytes > 32768) throw rejection();
        if (writeSync(3, frame) !== frame.length) throw rejection();
        if (kind === "final") terminal = true;
      } catch (error) { latch.fail("control-write", error); throw rejection(); }
    },
  });
}

/**
 * B reports are remote observations, never local B handles or reclaim authority.
 * Only the wiring site supplies the original A and its original fd3 stream.
 * @param {object} owner @param {object} stream @param {string} nonce @param {Latch} latch
 */
export function createControlReader(owner, stream, nonce, latch) {
  let sequence = 0;
  let bytes = 0;
  let residual = "";
  let eof = false;
  let phase = 0;
  let term = false;
  const expected = ["ready", "reserve", "bound", "business-pass", "b-ended", "final"];
  /** @param {object} actualOwner @param {object} actualStream */
  function identity(actualOwner, actualStream) {
    if (owner !== actualOwner || stream !== actualStream) throw rejection();
  }
  return Object.freeze({
    /** @param {object} actualOwner @param {object} actualStream @param {Buffer} chunk */
    accept(actualOwner, actualStream, chunk) {
      try {
        latch.assert();
        identity(actualOwner, actualStream);
        if (!Buffer.isBuffer(chunk) || eof || phase === expected.length) throw rejection();
        bytes += chunk.length;
        if (bytes > 32768) throw rejection();
        for (const byte of chunk) {
          if (byte > 127) throw rejection();
          residual += String.fromCharCode(byte);
          if (residual.length > 256) throw rejection();
          if (byte !== 10) continue;
          if (++sequence > 128) throw rejection();
          const frame = JSON.parse(residual);
          if (frame === null || typeof frame !== "object" || Array.isArray(frame) ||
              Object.keys(frame).sort().join(",") !== "k,n,s,v" || frame.v !== 1 ||
              frame.n !== nonce || frame.s !== sequence ||
              residual !== JSON.stringify({ v: 1, n: nonce, s: sequence, k: frame.k }) + "\n") throw rejection();
          // Default SIGTERM is an observation, not proof of process termination.
          if (frame.k === "sigterm") {
            if ((phase !== 3 && phase !== 4) || term) throw rejection();
            term = true;
          } else {
            if (frame.k !== expected[phase]) throw rejection();
            phase++;
          }
          residual = "";
        }
      } catch (error) { latch.fail("control-read", error); }
    },
    /** @param {object} actualOwner @param {object} actualStream */
    end(actualOwner, actualStream) {
      try {
        latch.assert();
        identity(actualOwner, actualStream);
        if (eof || residual.length || phase !== expected.length) throw rejection();
        eof = true;
      } catch (error) { latch.fail("control-eof", error); }
    },
    snapshot() { return Object.freeze({ eof, complete: !latch.snapshot().failed && eof && phase === expected.length, sequence, bytes }); },
  });
}

/** @typedef {import("node:child_process").ChildProcess} Child */
/**
 * Keep original receiver even when post-native observation fails. No stop or
 * deletion operation is added. Unknown ownership deliberately keeps a ref.
 * @param {Child} child @param {Latch} latch @param {boolean} ipc
 */
function observeChild(child, latch, ipc) {
  let close = false;
  let exit = false;
  let disconnected = !ipc;
  let streamsCaptured = false;
  let preNativeActive = true;
  /** @type {number | null} */ let exitCode = null;
  /** @type {NodeJS.Signals | null} */ let signal = null;
  /** @type {Map<import("node:stream").Stream, boolean>} */ const streams = new Map();
  /** @type {(() => void)[]} */ const waiters = [];
  /** @type {Array<[string | symbol, (...args: any[]) => void]>} */ const childListeners = [];
  const keeper = setInterval(() => {}, 1000);
  function ended() { return exit && close && disconnected && streamsCaptured && [...streams.values()].every(Boolean); }
  function changed() {
    if (ended()) { clearInterval(keeper); for (const done of waiters.splice(0)) done(); }
  }
  /** @param {string | symbol} event @param {(...args: any[]) => void} listener */
  function listen(event, listener) {
    child.on(event, listener);
    childListeners.push([event, listener]);
  }
  function releaseChildListeners() {
    for (const [event, listener] of childListeners.splice(0).reverse()) {
      try { child.removeListener(event, listener); }
      catch (error) { latch.fail("pre-native-cleanup", error); }
    }
  }
  try {
    listen("exit", (code, sig) => { exit = true; exitCode = code; signal = sig; changed(); });
    listen("close", () => { close = true; changed(); });
    listen("disconnect", () => { disconnected = true; changed(); });
    listen(errorMonitor, (error) => latch.fail("child-error", error));
    listen("error", () => {});
  } catch (error) {
    releaseChildListeners();
    clearInterval(keeper);
    throw error;
  }
  return Object.freeze({
    child,
    releasePreNative() {
      if (!preNativeActive || streamsCaptured) return;
      preNativeActive = false;
      releaseChildListeners();
      clearInterval(keeper);
    },
    capture() {
      try {
        if (!preNativeActive || streamsCaptured || Array.from(child.stdio).length !== 4) throw rejection();
        const indices = ipc ? [0, 1, 2] : [0, 1, 2, 3];
        for (const index of indices) {
          const stream = child.stdio[index];
          if (!stream || streams.has(stream) || stream.closed) throw rejection();
          streams.set(stream, false);
          stream.on("close", () => { streams.set(stream, true); changed(); });
          stream.on("error", (error) => latch.fail("stdio-error", error));
        }
        if (ipc && (!child.channel || !child.connected || child.stdio[3] !== null)) throw rejection();
        streamsCaptured = true;
        preNativeActive = false;
        changed();
      } catch (error) { latch.fail("stdio-observation", error); }
    },
    snapshot() { return Object.freeze({ exit, close, disconnected, streamsCaptured, ended: ended(), exitCode, signal }); },
    async wait() {
      if (ended()) return true;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { latch.fail("child-close-timeout"); resolve(false); }, 15000);
        waiters.push(() => { clearTimeout(timer); resolve(true); });
      });
    },
  });
}

/**
 * Process-local immutable query. It compares current real Node references;
 * callers cannot supply an installed flag or an alternate set of bindings.
 */
export function guardState() {
  const descriptor = Object.getOwnPropertyDescriptor(process, STATE_KEY);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
  return descriptor.value();
}

/**
 * Installs once, before importing the real library. The allowance exists only
 * during the original public spawn/fork synchronous call. A1 sees unchanged
 * native this/arguments/return/throw. No restore/uninstall capability exists.
 * @param {"O" | "A" | "B"} role @param {Latch} latch
 * @param {(kind: string) => void} report
 * @param {(file: unknown, args: unknown, options: unknown) => void} validateFork
 */
export function installProcessGuard(role, latch, report, validateFork) {
  if (Object.getOwnPropertyDescriptor(process, STATE_KEY)) throw rejection();
  const nativeSpawn = Object.getOwnPropertyDescriptor(cp.ChildProcess.prototype, "spawn")?.value;
  if (typeof nativeSpawn !== "function") throw rejection();
  const nativeKill = cp.ChildProcess.prototype.kill;
  const nativePublicSpawn = cp.spawn;
  const nativeFork = cp.fork;
  const nativeProcessKill = process.kill;
  const selfPid = process.pid;
  if (typeof nativeProcessKill !== "function" || !Number.isSafeInteger(selfPid) || selfPid <= 0) throw rejection();
  let window = false;
  let admitted = false;
  let sealed = role === "B";
  let term = false;
  let kill = false;
  /** @type {{file: string, args: string[], env: Record<string,string>, stdio: string[], cwd: string | undefined} | undefined} */ let plan;
  /** @type {ReturnType<typeof observeChild> | undefined} */ let original;
  /** @type {Child | undefined} */ let originalChild;
  /** @type {Array<[string | symbol, (...args: any[]) => void]>} */ let adapterListeners = [];
  function captureOriginal() { original?.capture(); }
  /** @param {Child} receiver */
  function releasePreNative(receiver) {
    if (originalChild !== receiver || !original) return;
    try {
      for (const [event, listener] of adapterListeners.splice(0).reverse()) {
        try { receiver.removeListener(event, listener); }
        catch (error) { latch.fail("pre-native-cleanup", error); }
      }
      original.releasePreNative();
    } finally {
      original = undefined;
      originalChild = undefined;
    }
  }
  /** @param {unknown[]} args @param {boolean} postNative */
  function validateNative(args, postNative) {
    if (!plan || args.length !== 1 || !args[0] || typeof args[0] !== "object") deny();
    const d = Object.getOwnPropertyDescriptors(args[0]);
    const expectedEnv = Object.entries(plan.env).map(([key, value]) => `${key}=${value}`);
    if (postNative && role === "A") expectedEnv.push("NODE_CHANNEL_FD=3", "NODE_CHANNEL_SERIALIZATION_MODE=advanced");
    const envPairs = d.envPairs?.value;
    const argv = d.args?.value;
    if (!Array.isArray(envPairs) || envPairs.length !== expectedEnv.length ||
        [...envPairs].sort().some((value, index) => value !== expectedEnv.sort()[index]) ||
        !Array.isArray(argv) || argv.length !== plan.args.length + 1 || argv[0] !== plan.file ||
        argv.slice(1).some((value, index) => value !== plan?.args[index]) || d.file?.value !== plan.file ||
        d.detached?.value !== false || d.cwd?.value !== plan.cwd || d.uid?.value !== undefined || d.gid?.value !== undefined ||
        (d.shell?.value !== undefined && d.shell?.value !== false)) deny();
    if (!postNative && (!Array.isArray(d.stdio?.value) || d.stdio.value.length !== 4 ||
        d.stdio.value.some((/** @type {unknown} */ value, /** @type {number} */ index) => value !== plan?.stdio[index]))) deny();
  }
  /** @returns {never} */
  function deny() { latch.fail("creation-or-signal-rejected"); throw rejection(); }
  const adapter = createPrototypeSpawnGuard({
    originalSpawn: nativeSpawn,
    /** @param {Uint8Array} frame */
    writeFrame(frame) {
      const text = Buffer.from(frame).toString("ascii");
      if (/^R:1\n$/u.test(text)) report("reserve");
      else if (/^B:1:[1-9][0-9]*\n$/u.test(text)) report("bound");
      else deny();
      return frame.length;
    },
    /** @param {Child} receiver @param {{onClose: () => void, onError: (error: unknown) => void}} callbacks */
    installObserver(receiver, callbacks) {
      if (!window || original || admitted) deny();
      admitted = true;
      /** @type {ReturnType<typeof observeChild> | undefined} */ let observed;
      /** @type {Array<[string | symbol, (...args: any[]) => void]>} */ const installed = [];
      try {
        observed = observeChild(receiver, latch, role === "A");
        receiver.on("close", callbacks.onClose);
        installed.push(["close", callbacks.onClose]);
        receiver.on(errorMonitor, callbacks.onError);
        installed.push([errorMonitor, callbacks.onError]);
        originalChild = receiver;
        original = observed;
        adapterListeners = installed;
      } catch (error) {
        for (const [event, listener] of installed.reverse()) {
          try { receiver.removeListener(event, listener); }
          catch (cleanupError) { latch.fail("pre-native-cleanup", cleanupError); }
        }
        observed?.releasePreNative();
        throw error;
      }
    },
  });
  /** @this {Child} @param {...unknown} args */
  function guardedSpawn(...args) {
    if (!window || sealed || original) deny();
    latch.assert();
    validateNative(args, false);
    try { return Reflect.apply(adapter.spawn, this, args); }
    finally {
      // Only A1's receiver-bound record can prove native creation was not entered.
      const slots = adapter.owned().filter((slot) => slot.receiver === this);
      if (slots.length === 1 && slots[0].nativeEntered === false) {
        try { releasePreNative(this); }
        catch (error) { latch.fail("pre-native-cleanup", error); }
      } else {
        // Observation failure cannot replace an entered or unknown native outcome.
        try { captureOriginal(); validateNative(args, true); adapter.assertHealthy(); }
        catch (error) { latch.fail("native-observation", error); }
      }
    }
  }
  /** @param {...unknown} args */
  function guardedProcessKill(...args) {
    if (args.length === 0 || typeof args[0] !== "number" || args[0] !== selfPid) deny();
    return Reflect.apply(nativeProcessKill, process, args);
  }
  /** @this {Child} @param {...unknown} args */
  function guardedKill(...args) {
    if (role !== "A" || this !== originalChild || args.length > 1) deny();
    const signal = args[0];
    if (signal === undefined || signal === "SIGTERM") {
      if (term) deny();
      term = true;
      try { report("sigterm"); } catch (error) { latch.fail("stop-report", error); }
    } else if (signal === "SIGKILL" && term && !kill) {
      kill = true;
      latch.fail("sigkill-upgrade");
    } else deny();
    try {
      const result = Reflect.apply(nativeKill, this, args);
      if (result !== true) latch.fail("native-kill-result");
      return result;
    } catch (error) { latch.fail("native-kill", error); throw error; }
  }
  /** @param {unknown} file @param {unknown} args @param {unknown} options */
  function guardedFork(file, args, options) {
    if (role !== "A" || sealed || admitted || window) deny();
    try { latch.assert(); validateFork(file, args, options); }
    catch (error) { latch.fail("fork-contract", error); throw rejection(); }
    const d = Object.getOwnPropertyDescriptors(/** @type {object} */ (options));
    plan = { file: process.execPath, args: [...d.execArgv.value, /** @type {string} */ (file)],
      env: { ...d.env.value }, stdio: ["pipe", "pipe", "pipe", "ipc"], cwd: undefined };
    window = true;
    try { return Reflect.apply(nativeFork, cp, [file, args, options]); }
    finally { window = false; plan = undefined; }
  }
  /** @param {object} target @param {string} key @param {unknown} value */
  function bind(target, key, value) {
    Object.defineProperty(target, key, { value, configurable: false, writable: false });
  }
  bind(cp.ChildProcess.prototype, "spawn", guardedSpawn);
  bind(cp.ChildProcess.prototype, "kill", guardedKill);
  for (const key of ["spawnSync", "execSync", "execFileSync"]) bind(cp, key, deny);
  bind(cp, "fork", guardedFork);
  bind(threads, "Worker", deny);
  bind(process, "kill", guardedProcessKill);
  syncBuiltinESMExports();
  const query = () => Object.freeze({
    role,
    intact: Object.getOwnPropertyDescriptor(cp.ChildProcess.prototype, "spawn")?.value === guardedSpawn && Object.getOwnPropertyDescriptor(cpBindings.ChildProcess.prototype, "spawn")?.value === guardedSpawn &&
      cp.ChildProcess.prototype.kill === guardedKill && cp.fork === guardedFork && cpBindings.fork === guardedFork &&
      cp.spawnSync === deny && cpBindings.spawnSync === deny && cp.execSync === deny && cpBindings.execSync === deny &&
      cp.execFileSync === deny && cpBindings.execFileSync === deny && /** @type {unknown} */ (threads.Worker) === deny && /** @type {unknown} */ (threadBindings.Worker) === deny && process.kill === guardedProcessKill,
    failed: latch.snapshot().failed,
    sealed,
    admitted,
  });
  Object.defineProperty(process, STATE_KEY, { value: query, configurable: false, writable: false });
  process.on("uncaughtExceptionMonitor", (error) => latch.fail("uncaught", error));
  process.on("unhandledRejection", (error) => latch.fail("unhandled", error));
  process.on("exit", () => { if (latch.snapshot().failed) process.exitCode = 1; });
  return Object.freeze({
    /** O is the only caller of this method; A never gets a second allowance.
     * @param {string} file @param {string[]} args @param {import("node:child_process").SpawnOptions} options */
    launch(file, args, options) {
      if (role !== "O" || sealed || admitted || window) deny();
      latch.assert();
      plan = { file, args: [...args], env: /** @type {Record<string,string>} */ ({ ...options.env }),
        stdio: ["pipe", "pipe", "pipe", "pipe"], cwd: /** @type {string} */ (options.cwd) };
      window = true;
      try { return nativePublicSpawn(file, args, options); }
      finally { window = false; plan = undefined; }
    },
    seal() { sealed = true; adapter.closeAdmission(); },
    original() { return original; },
    assert() {
      adapter.assertHealthy(); latch.assert();
      if (!query().intact) deny();
      const state = original?.snapshot();
      if (role === "A" && state?.exit && !(state.exitCode === 0 && state.signal === null) &&
          !(term && !kill && state.signal === "SIGTERM" && state.exitCode === null)) {
        latch.fail("unexpected-b-exit"); throw rejection();
      }
    },
  });
}

/** @param {Record<string, string>} expected @param {unknown} actual */
export function assertEnvironment(expected, actual) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw rejection();
  const keys = Reflect.ownKeys(actual);
  if (keys.length !== Object.keys(expected).length) throw rejection();
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(expected, key)) throw rejection();
    const d = Object.getOwnPropertyDescriptor(actual, key);
    if (!d || !("value" in d) || d.value !== expected[key]) throw rejection();
  }
}

const PRELOAD_PATH = fileURLToPath(PRELOAD_URL);
/** @param {unknown} value */
function identifiesThisPreload(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === PRELOAD_URL || value === PRELOAD_PATH) return true;
  try {
    if (value.startsWith("file:") && fileURLToPath(new URL(value)) === PRELOAD_PATH) return true;
  } catch {}
  try { return pathToFileURL(resolve(process.cwd(), value)).href === PRELOAD_URL; }
  catch { return false; }
}

// B requires the one reviewed --import URL spelling. Equivalent helper preload
// spellings establish intent but are rejected rather than silently unguarded.
let helperArgIntent = false;
let helperReferences = 0;
let canonicalPairs = 0;
for (let index = 0; index < process.execArgv.length; index += 1) {
  const argument = process.execArgv[index];
  if (identifiesThisPreload(argument)) { helperArgIntent = true; helperReferences += 1; }
  if (argument === "--import") {
    const specifier = process.execArgv[index + 1];
    if (identifiesThisPreload(specifier)) helperArgIntent = true;
    if (specifier === PRELOAD_URL) canonicalPairs += 1;
  } else if (typeof argument === "string" && argument.startsWith("--import=")) {
    if (identifiesThisPreload(argument.slice("--import=".length))) {
      helperArgIntent = true;
      helperReferences += 1;
    }
  }
}
const roleIntent = process.env.PI_PM_AB_ROLE === "B";
const markerIntent = Object.hasOwn(process.env, "PI_PM_AB_PRELOAD");
const bIntent = helperArgIntent || roleIntent || markerIntent;
if (bIntent) {
  const valid = process.env.PI_PM_AB_ROLE === "B" && process.env.PI_PM_AB_PRELOAD === PRELOAD_URL &&
    canonicalPairs === 1 && helperReferences === 1 && process.connected === true &&
    process.env.NODE_ENV === "test" && process.env.VITEST === "true";
  if (!valid) { process.exitCode = 1; throw rejection(); }
  const prior = guardState();
  if (prior) {
    if (prior.role !== "B" || !prior.intact || prior.failed) { process.exitCode = 1; throw rejection(); }
  } else {
    const latch = createFailureLatch();
    installProcessGuard("B", latch, () => { throw rejection(); }, () => { throw rejection(); });
  }
}
