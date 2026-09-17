// @ts-check

import childProcess, {
  ChildProcess,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { errorMonitor } from 'node:events';
import fs, { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import fsPromises, { unlink as promiseUnlink } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPrototypeSpawnGuard } from './helpers/pm-sdk-quiescence-adapter.mjs';
import common from './pm-sdk-quiescence-creation-entry.cjs';

const AUTHORIZATION = '--authorize=M4-PM-Q2-L1-JITI';
const CASE_PREFIX = '--case=';
const CASES = new Set(['spawn', 'execFile']);
const EXPECTED_JITI_VERSION = '2.7.0';
const MAX_DIAGNOSTICS = 32;
const MAX_COUNT = 0xffff_ffff;
const LOAD_REJECTED = Object.freeze({ code: 'JITI_LOAD_WINDOW_REJECTED' });
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/pm-sdk-quiescence-loader-fixture.ts', import.meta.url));
const FORK_CHILD_PATH = fileURLToPath(new URL('./fixtures/pm-sdk-quiescence-fork-child.cjs', import.meta.url));
const ENTRY_PATH = fileURLToPath(import.meta.url);

const {
  expectedNodeVersion,
  runCreationCase,
  realClock,
  memoryFrameSink,
  createSafeOutputChannel,
} = common;

/** @typedef {'spawn'|'execFile'} CaseName */

/** @param {readonly string[]} argv @returns {CaseName | null} */
export function parseAuthorizedCase(argv) {
  if (argv.length !== 2 || argv[0] !== AUTHORIZATION || !argv[1]?.startsWith(CASE_PREFIX)) return null;
  const selected = argv[1].slice(CASE_PREFIX.length);
  return CASES.has(selected) ? /** @type {CaseName} */ (selected) : null;
}

/** @param {PropertyDescriptor | undefined} left @param {PropertyDescriptor | undefined} right */
function sameDescriptor(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable && left.enumerable === right.enumerable &&
    left.writable === right.writable && left.value === right.value && left.get === right.get && left.set === right.set;
}

/** @param {unknown} target @param {string} name */
function ownDataFunction(target, name) {
  if ((typeof target !== 'object' || target === null) && typeof target !== 'function') return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
    ? Object.freeze({ descriptor, value: descriptor.value })
    : null;
}

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
function safeVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/u.test(value) ? value : null;
}

/**
 * Loads the fixed TypeScript fixture while all identified Jiti creation and
 * write paths are denied. This function accepts no paths or loader options.
 * It is for one call in a fresh dedicated CLI process: Jiti must not be
 * preloaded, calls must not repeat or run concurrently, and the caller must
 * provide a whitelisted environment. Restoring built-in properties does not
 * revoke sentinel references retained in library caches.
 */
export async function loadFixedJitiFixture() {
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {Record<string, number>} */
  const attempts = Object.seal({
    prototypeSpawn: 0,
    spawnSync: 0,
    execFileSync: 0,
    execSync: 0,
    mkdirSync: 0,
    writeFileSync: 0,
    unlinkSync: 0,
    promiseUnlink: 0,
    total: 0,
  });
  let failed = false;
  let firstFailurePresent = false;
  /** @type {unknown} */
  let firstFailure;
  /** @type {string | null} */
  let firstFailureCode = null;
  let installed = false;
  let esmInstalled = false;
  let restorationAttempted = false;
  let descriptorsRestored = false;
  let esmRestored = false;
  let jitiImported = false;
  let fixtureLoaded = false;
  let createJitiOwnData = false;
  let jitiImportOwnData = false;
  let spawnIdentity = false;
  let execFileIdentity = false;
  /** @type {Function | null} */
  let fixtureSpawn = null;
  /** @type {Function | null} */
  let fixtureExecFile = null;
  /** @type {string | null} */
  let packagePath = null;
  /** @type {string | null} */
  let jitiEntryPath = null;
  /** @type {string | null} */
  let jitiVersion = null;
  /** @type {string | null} */
  let loaderHash = null;
  /** @type {string | null} */
  let fixtureHash = null;
  /** @type {string | null} */
  let jitiEntryHash = null;

  /** @param {string} code @param {boolean} [valuePresent] @param {unknown} [value] */
  function fail(code, valuePresent = false, value = undefined) {
    failed = true;
    if (!firstFailurePresent) {
      firstFailurePresent = true;
      firstFailure = value;
      firstFailureCode = code;
    }
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(code);
    void valuePresent;
  }

  /** @param {string} name */
  function deny(name) {
    attempts[name] = Math.min(MAX_COUNT, attempts[name] + 1);
    attempts.total = Math.min(MAX_COUNT, attempts.total + 1);
    fail(`denied-${name}`, true, LOAD_REJECTED);
  }

  /** @param {string} name */
  function syncDeny(name) {
    return function deniedLoadOperation() {
      deny(name);
      throw LOAD_REJECTED;
    };
  }

  function denyPromiseUnlink() {
    deny('promiseUnlink');
    return Promise.reject(LOAD_REJECTED);
  }

  const prototype = ChildProcess.prototype;
  /** @type {Array<{target:object,name:string,descriptor:PropertyDescriptor,value:Function,denied:Function,getNamed:(()=>unknown)|null}>} */
  const captured = [];
  /** @type {typeof captured} */
  const changed = [];

  /** @param {object} target @param {string} name @param {Function} denied @param {(()=>unknown)|null} getNamed */
  function captureSlot(target, name, denied, getNamed) {
    const slot = ownDataFunction(target, name);
    if (slot === null) throw new TypeError(`invalid load-window slot: ${name}`);
    if (getNamed !== null && getNamed() !== slot.value) throw new TypeError(`initial ESM binding mismatch: ${name}`);
    captured.push({ target, name, descriptor: slot.descriptor, value: slot.value, denied, getNamed });
  }

  try {
    const promiseObject = fs.promises;
    if (promiseObject !== fsPromises) throw new TypeError('fs promises object mismatch');
    if (childProcess.ChildProcess !== ChildProcess || childProcess.spawn !== spawn ||
        childProcess.execFile !== execFile || childProcess.fork !== fork) {
      throw new TypeError('initial child_process API mismatch');
    }
    captureSlot(prototype, 'spawn', syncDeny('prototypeSpawn'), null);
    captureSlot(childProcess, 'spawnSync', syncDeny('spawnSync'), () => spawnSync);
    captureSlot(childProcess, 'execFileSync', syncDeny('execFileSync'), () => execFileSync);
    captureSlot(childProcess, 'execSync', syncDeny('execSync'), () => execSync);
    captureSlot(fs, 'mkdirSync', syncDeny('mkdirSync'), () => mkdirSync);
    captureSlot(fs, 'writeFileSync', syncDeny('writeFileSync'), () => writeFileSync);
    captureSlot(fs, 'unlinkSync', syncDeny('unlinkSync'), () => unlinkSync);
    captureSlot(fsPromises, 'unlink', denyPromiseUnlink, () => promiseUnlink);
  } catch (error) {
    fail('capture-failed', true, error);
  }

  try {
    if (!failed) {
      for (const slot of captured) {
        Object.defineProperty(slot.target, slot.name, { ...slot.descriptor, value: slot.denied });
        changed.push(slot);
        if (!sameDescriptor(Object.getOwnPropertyDescriptor(slot.target, slot.name), {
          ...slot.descriptor,
          value: slot.denied,
        })) throw new TypeError(`sentinel install mismatch: ${slot.name}`);
      }
      Reflect.apply(syncBuiltinESMExports, undefined, []);
      esmInstalled = captured.every((slot) => slot.getNamed === null || slot.getNamed() === slot.denied);
      installed = changed.length === captured.length && esmInstalled;
      if (!installed) fail('sentinel-install-incomplete');
    }

    if (installed && !failed) {
      const require = createRequire(import.meta.url);
      packagePath = require.resolve('jiti/package.json');
      jitiEntryPath = resolve(dirname(packagePath), 'lib', 'jiti.mjs');
      const packageBytes = readFileSync(packagePath);
      const packageValue = JSON.parse(packageBytes.toString('utf8'));
      jitiVersion = safeVersion(packageValue?.version);
      loaderHash = sha256(readFileSync(ENTRY_PATH));
      fixtureHash = sha256(readFileSync(FIXTURE_PATH));
      jitiEntryHash = sha256(readFileSync(jitiEntryPath));
      if (jitiVersion !== EXPECTED_JITI_VERSION) throw new TypeError('unexpected Jiti version');

      const jitiNamespace = await import('jiti');
      jitiImported = true;
      const createSlot = ownDataFunction(jitiNamespace, 'createJiti');
      createJitiOwnData = createSlot !== null;
      if (createSlot === null) throw new TypeError('Jiti createJiti is not an own data function');
      const jiti = Reflect.apply(createSlot.value, undefined, [import.meta.url, {
        fsCache: false,
        moduleCache: true,
        interopDefault: false,
        tryNative: false,
        debug: false,
        alias: {},
        tsconfigPaths: false,
        transformModules: [],
        nativeModules: [
          '@earendil-works/pi-coding-agent',
          '@earendil-works/pi-ai',
          '@earendil-works/pi-tui',
          'typebox',
          'web-tree-sitter',
        ],
      }]);
      const importSlot = ownDataFunction(jiti, 'import');
      jitiImportOwnData = importSlot !== null;
      if (importSlot === null) throw new TypeError('Jiti import is not an own data function');
      const fixtureNamespace = await Reflect.apply(importSlot.value, jiti, [FIXTURE_PATH]);
      const originalSpawnSlot = ownDataFunction(fixtureNamespace, 'originalSpawn');
      const originalExecFileSlot = ownDataFunction(fixtureNamespace, 'originalExecFile');
      const spawnSlot = ownDataFunction(fixtureNamespace, 'spawnNodeVersion');
      const execFileSlot = ownDataFunction(fixtureNamespace, 'execFileNodeVersion');
      spawnIdentity = originalSpawnSlot?.value === spawn;
      execFileIdentity = originalExecFileSlot?.value === execFile;
      if (!spawnIdentity || !execFileIdentity || spawnSlot === null || execFileSlot === null) {
        throw new TypeError('fixture export identity mismatch');
      }
      fixtureSpawn = spawnSlot.value;
      fixtureExecFile = execFileSlot.value;
      fixtureLoaded = true;
    }
  } catch (error) {
    fail('load-failed', true, error);
  } finally {
    restorationAttempted = true;
    for (let index = changed.length - 1; index >= 0; index -= 1) {
      const slot = changed[index];
      try {
        Object.defineProperty(slot.target, slot.name, slot.descriptor);
      } catch (error) {
        fail(`descriptor-restore-failed-${slot.name}`, true, error);
      }
    }
    try {
      descriptorsRestored = captured.every((slot) => sameDescriptor(
        Object.getOwnPropertyDescriptor(slot.target, slot.name),
        slot.descriptor,
      ));
      if (!descriptorsRestored) fail('descriptor-restore-mismatch');
    } catch (error) {
      fail('descriptor-restore-inspect-failed', true, error);
    }
    try {
      Reflect.apply(syncBuiltinESMExports, undefined, []);
      esmRestored = captured.every((slot) => slot.getNamed === null || slot.getNamed() === slot.value);
      if (!esmRestored) fail('esm-restore-mismatch');
    } catch (error) {
      fail('esm-restore-failed', true, error);
    }
  }

  const ok = !failed && installed && fixtureLoaded && attempts.total === 0 &&
    descriptorsRestored && esmRestored && fixtureSpawn !== null && fixtureExecFile !== null;
  const report = Object.freeze({
    kind: 'fixed-jiti-loader',
    ok,
    metadata: Object.freeze({
      expectedJitiVersion: EXPECTED_JITI_VERSION,
      jitiVersion,
      packagePath,
      jitiEntryPath,
      fixturePath: FIXTURE_PATH,
      loaderPath: ENTRY_PATH,
    }),
    inputHashes: Object.freeze({ loader: loaderHash, fixture: fixtureHash, jitiEntry: jitiEntryHash }),
    load: Object.freeze({ jitiImported, fixtureLoaded, createJitiOwnData, jitiImportOwnData }),
    identity: Object.freeze({ spawn: spawnIdentity, execFile: execFileIdentity }),
    attempts: Object.freeze({ ...attempts }),
    restoration: Object.freeze({ attempted: restorationAttempted, descriptors: descriptorsRestored, esmBindings: esmRestored }),
    failure: Object.freeze({ present: firstFailurePresent, code: firstFailureCode }),
    diagnostics: Object.freeze([...diagnostics]),
  });
  void firstFailure;
  return Object.freeze({ ok, report, spawn: fixtureSpawn, execFile: fixtureExecFile });
}

/** @param {{execArgv:readonly string[],env:Record<string,string|undefined>}} processLike */
function environmentAccepted(processLike) {
  if (processLike.execArgv.length !== 0) return false;
  return !Object.keys(processLike.env).some((name) => name === 'NODE_OPTIONS' || name.startsWith('JITI_'));
}

export async function main() {
  const output = createSafeOutputChannel(process.stdout, process);
  const selectedCase = parseAuthorizedCase(process.argv.slice(2));
  if (selectedCase === null) {
    process.exitCode = 64;
    const written = await output.writeText('NOT_AUTHORIZED\n');
    if (!written || output.failed()) process.exitCode = 1;
    return;
  }
  const expectedVersion = expectedNodeVersion(process);
  if (expectedVersion === null || !environmentAccepted(process)) {
    process.exitCode = 1;
    await output.writeJson({ kind: 'configuration-rejected' });
    return;
  }
  if (output.failed()) return;

  const loaded = await loadFixedJitiFixture();
  if (!loaded.ok || output.failed() || loaded.spawn === null || loaded.execFile === null) {
    process.exitCode = 1;
    await output.writeJson({ kind: 'jiti-quiescence', ok: false, loader: loaded.report, runner: null });
    return;
  }

  /** @type {Record<string, unknown> | null} */
  let runner = null;
  try {
    runner = await runCreationCase({
      caseName: selectedCase,
      api: { spawn: loaded.spawn, execFile: loaded.execFile, fork },
      ChildProcess,
      createPrototypeSpawnGuard,
      errorMonitor,
      promisify,
      process,
      clock: realClock(),
      frameSink: memoryFrameSink,
      expectedVersion,
      forkChildPath: FORK_CHILD_PATH,
      onProgress: (/** @type {Record<string, unknown>} */ value) => output.writeJson(value),
      subscribeOutputFailure: output.subscribe,
    });
  } catch {
    process.exitCode = 1;
  }
  const result = { kind: 'jiti-quiescence', ok: runner?.ok === true, loader: loaded.report, runner };
  const written = await output.writeJson(result);
  if (!written || output.failed() || result.ok !== true) process.exitCode = 1;
  else if (process.exitCode !== 1) process.exitCode = 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
