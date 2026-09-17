// @ts-check

import assert from 'node:assert/strict';
import { EventEmitter, errorMonitor } from 'node:events';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Script, createContext } from 'node:vm';
import { createPrototypeSpawnGuard } from './helpers/pm-sdk-quiescence-adapter.mjs';

const cjsUrl = new URL('./pm-sdk-quiescence-creation-entry.cjs', import.meta.url);
const esmUrl = new URL('./pm-sdk-quiescence-creation-entry.mjs', import.meta.url);
const cjsSource = readFileSync(cjsUrl, 'utf8');
const esmSource = readFileSync(esmUrl, 'utf8');
const EXPECTED_VERSION = 'v26.8.2';
const FIXED_NODE = '/opt/homebrew/Cellar/node/26.8.2/bin/node';
const AUTHORIZATION = '--authorize=M4-PM-Q2-B2-CREATION-ENTRY';

/** @param {() => unknown} operation */
function capture(operation) {
  try { return { threw: false, value: operation() }; }
  catch (error) { return { threw: true, value: error }; }
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    /** @type {Map<number, {due:number, callback:()=>void}>} */
    this.timers = new Map();
    /** @type {Map<number, {callback:()=>void, delay:number}>} */
    this.intervals = new Map();
  }
  now = () => BigInt(this.time) * 1_000_000n;
  /** @param {() => void} callback @param {number} delay */
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { due: this.time + delay, callback });
    return id;
  };
  /** @param {number} id */
  clearTimeout = (id) => { this.timers.delete(id); };
  /** @param {() => void} callback @param {number} delay */
  setInterval = (callback, delay) => {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  };
  /** @param {number} id */
  clearInterval = (id) => { this.intervals.delete(id); };
  /** @param {number} target */
  async runTo(target) {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, task] = next;
      this.timers.delete(id);
      this.time = task.due;
      task.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

class MockReadable extends EventEmitter {
  /** @param {string | symbol | null} failOn */
  constructor(failOn = null) {
    super();
    this.failOn = failOn;
  }
  /** @param {string | symbol} name @param {(...args:any[])=>void} listener */
  on(name, listener) {
    if (name === this.failOn) throw new Error('stream observer registration failed');
    return super.on(name, listener);
  }
}

class MockWritable extends EventEmitter {
  /** @param {FakeClock} clock @param {{throwEnd?:boolean, omitFinish?:boolean, omitEndCallback?:boolean, omitClose?:boolean, endError?:unknown}} behavior */
  constructor(clock, behavior) {
    super();
    this.clock = clock;
    this.behavior = behavior;
    this.endCalls = 0;
  }
  /** @param {((error?: unknown) => void)=} callback */
  end(callback) {
    this.endCalls += 1;
    if (this.behavior.throwEnd) throw new Error('stdin.end failed');
    if (!this.behavior.omitFinish) this.clock.setTimeout(() => this.emit('finish'), 1);
    if (!this.behavior.omitEndCallback) this.clock.setTimeout(() => callback?.(this.behavior.endError ?? null), 2);
    if (!this.behavior.omitClose) this.clock.setTimeout(() => this.emit('close'), 3);
    return this;
  }
}

class MockOutput extends EventEmitter {
  /** @param {'normal'|'sync-throw'|'callback-error'|'manual-callback'} mode */
  constructor(mode = 'normal') {
    super();
    this.mode = mode;
    this.text = '';
    /** @type {Array<(error?:Error|null)=>void>} */
    this.callbacks = [];
  }
  /** @param {string} text @param {((error?:Error|null)=>void)=} callback */
  write(text, callback) {
    if (this.mode === 'sync-throw') throw new Error('parent write sync failure');
    this.text += text;
    if (this.mode === 'callback-error') callback?.(new Error('parent write callback failure'));
    else if (this.mode === 'manual-callback') {
      if (callback) this.callbacks.push(callback);
    } else callback?.(null);
    return true;
  }
}

/**
 * @typedef {{
 *   nativeReturn?: unknown,
 *   nativeThrow?: unknown,
 *   nativeThrowTiming?: 'before-pid'|'after-pid'|'after-no-pid',
 *   missingPid?: boolean,
 *   noAutomaticEvents?: boolean,
 *   omitChildClose?: boolean,
 *   callbackEarly?: boolean,
 *   suppressExecCallback?: boolean,
 *   nonzeroExit?: boolean,
 *   restoreSabotage?: boolean,
 *   missingPromiseChild?: boolean,
 *   stdoutFailOn?: string | symbol | null,
 *   stdoutReadThrow?: boolean,
 *   stderrFailOn?: string | symbol | null,
 *   stdinFailOn?: string | symbol | null,
 *   stdinEndThrow?: boolean,
 *   omitStdinFinish?: boolean,
 *   omitStdinEndCallback?: boolean,
 *   omitStdinClose?: boolean,
 *   stdinEndError?: unknown,
 *   childFailOn?: string | symbol,
 *   childObserverError?: unknown,
 * }} WorldBehavior
 */

/** @param {WorldBehavior=} behavior */
function createMockWorld(behavior = {}) {
  const clock = new FakeClock();
  /** @type {any[]} */
  const children = [];
  /** @type {any[]} */
  const nativeRecords = [];
  /** @type {{present:boolean, value:unknown}} */
  const publicCaught = { present: false, value: undefined };
  let nextPid = 4100;
  /** @type {MockChildProcess | null} */
  let currentInvocationChild = null;

  class MockChildProcess extends EventEmitter {
    constructor() {
      super();
      const stdout = new MockReadable(behavior.stdoutFailOn ?? null);
      const stderr = new MockReadable(behavior.stderrFailOn ?? null);
      const stdin = new MockWritable(clock, {
        throwEnd: behavior.stdinEndThrow,
        omitFinish: behavior.omitStdinFinish,
        omitEndCallback: behavior.omitStdinEndCallback,
        omitClose: behavior.omitStdinClose,
        endError: behavior.stdinEndError,
      });
      this.rawStdout = stdout;
      this.stdout = stdout;
      this.stderr = stderr;
      this.stdin = stdin;
      if (behavior.stdoutReadThrow) {
        Object.defineProperty(this, 'stdout', { configurable: true, get() { throw new Error('stdout read failed'); } });
      }
      if (behavior.stdinFailOn !== undefined && behavior.stdinFailOn !== null) {
        const originalOn = this.stdin.on;
        this.stdin.on = function (name, listener) {
          if (name === behavior.stdinFailOn) throw new Error('stdin observer registration failed');
          return Reflect.apply(originalOn, this, [name, listener]);
        };
      }
      this.stdio = [stdin, stdout, stderr];
    }
    /** @param {string | symbol} name @param {(...args:any[])=>void} listener */
    on(name, listener) {
      if (name === behavior.childFailOn) throw behavior.childObserverError;
      return super.on(name, listener);
    }
    /** @param {any} options */
    spawn(options) {
      nativeRecords.push({ receiver: this, options });
      if (behavior.restoreSabotage) {
        Object.defineProperty(MockChildProcess.prototype, 'spawn', {
          value: MockChildProcess.prototype.spawn,
          writable: true,
          enumerable: false,
          configurable: false,
        });
      }
      if (behavior.nativeThrowTiming === 'before-pid') throw behavior.nativeThrow;
      if (!behavior.missingPid && behavior.nativeThrowTiming !== 'after-no-pid') {
        Object.defineProperty(this, 'pid', { value: nextPid++, writable: true, configurable: true });
      }
      if (behavior.nativeThrowTiming === 'after-pid' || behavior.nativeThrowTiming === 'after-no-pid') {
        throw behavior.nativeThrow;
      }
      const nativeReturn = Object.hasOwn(behavior, 'nativeReturn') ? behavior.nativeReturn : 0;
      const eventTarget = currentInvocationChild ?? this;
      if (!behavior.noAutomaticEvents) scheduleNatural(eventTarget);
      return nativeReturn;
    }
  }

  /** @param {MockChildProcess} child */
  function scheduleNatural(child) {
    const code = behavior.nonzeroExit ? 7 : 0;
    clock.setTimeout(() => child.emit('spawn'), 4);
    clock.setTimeout(() => child.stdout.emit('data', `${EXPECTED_VERSION}\n`), 5);
    clock.setTimeout(() => child.stdout.emit('end'), 6);
    clock.setTimeout(() => child.stderr.emit('end'), 7);
    clock.setTimeout(() => child.stdout.emit('close'), 8);
    clock.setTimeout(() => child.stderr.emit('close'), 9);
    clock.setTimeout(() => child.emit('exit', code, null), 10);
    if (!behavior.omitChildClose) clock.setTimeout(() => child.emit('close', code, null), 12);
  }

  /** @param {string} file @param {readonly string[]} args @param {any} options */
  function mockSpawn(file, args, options) {
    if (file.includes('\0') || args.some((value) => value.includes('\0'))) {
      throw new TypeError('NUL rejected before ChildProcess construction');
    }
    const child = new MockChildProcess();
    children.push(child);
    currentInvocationChild = child;
    try {
      child.spawn({ file, args, options });
    } catch (error) {
      publicCaught.present = true;
      publicCaught.value = error;
      throw error;
    } finally {
      currentInvocationChild = null;
    }
    return child;
  }

  /**
   * @param {string} file
   * @param {readonly string[]} args
   * @param {any} options
   * @param {(error: any, stdout: string, stderr: string) => void} callback
   */
  function mockExecFile(file, args, options, callback) {
    const child = mockSpawn(file, args, options);
    let stdout = '';
    let stderr = '';
    let called = false;
    /** @param {any} error */
    const done = (error) => {
      if (called || behavior.suppressExecCallback) return;
      called = true;
      callback(error, stdout, stderr);
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => done(error));
    child.on(behavior.callbackEarly ? 'exit' : 'close', (code) => {
      done(code === 0 ? null : Object.assign(new Error('exit'), { code }));
    });
    return child;
  }

  mockExecFile[promisify.custom] = (/** @type {string} */ file, /** @type {readonly string[]} */ args, /** @type {any} */ options) => {
    /** @type {MockChildProcess | null} */
    let child = null;
    const promise = /** @type {Promise<any> & {child?: MockChildProcess | null}} */ (new Promise((resolve, reject) => {
      child = mockExecFile(file, args, options, (error, stdout, stderr) => {
        if (error === null) resolve({ stdout, stderr });
        else reject(error);
      });
    }));
    promise.child = behavior.missingPromiseChild ? null : child;
    return promise;
  };

  return {
    clock,
    children,
    nativeRecords,
    publicCaught,
    MockChildProcess,
    api: { spawn: mockSpawn, execFile: mockExecFile },
  };
}

/** @param {Uint8Array} frame */
function completeFrameSink(frame) {
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy.byteLength;
}

/** @param {string} source @param {string} before @param {string} after @param {string} label */
function replaceExact(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label}: replacement anchor must be unique`);
  return source.replace(before, after);
}

/**
 * Loads the real CJS source with exact built-in mappings. The sole dynamic A1
 * import is replaced by the already-loaded real A1 function.
 * @param {string} source
 * @param {ReturnType<typeof createMockWorld>} world
 * @param {{argv?:string[], output?:MockOutput}=} options
 */
function loadCommon(source, world, options = {}) {
  const module = { exports: {} };
  const output = options.output ?? new MockOutput();
  const processLike = {
    argv: options.argv ?? ['/fixed/node', '/virtual/entry.cjs'],
    stdout: output,
    exitCode: undefined,
    execPath: FIXED_NODE,
    version: EXPECTED_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    hrtime: { bigint: world.clock.now },
  };
  /** @param {string} specifier */
  const requireFunction = (specifier) => {
    if (specifier === 'node:child_process') return {
      spawn: world.api.spawn,
      execFile: world.api.execFile,
      ChildProcess: world.MockChildProcess,
    };
    if (specifier === 'node:events') return { errorMonitor };
    if (specifier === 'node:util') return { promisify };
    throw new Error(`unexpected require: ${specifier}`);
  };
  requireFunction.main = {};
  const transformed = replaceExact(
    source,
    "  const { createPrototypeSpawnGuard } = await import('./helpers/pm-sdk-quiescence-adapter.mjs');",
    '  const { createPrototypeSpawnGuard } = globalThis.__guard;',
    'CJS real A1 import',
  );
  const context = createContext({
    module,
    exports: module.exports,
    require: requireFunction,
    process: processLike,
    __guard: { createPrototypeSpawnGuard },
    Buffer,
    Uint8Array,
    Promise,
    Object,
    Reflect,
    Number,
    String,
    TypeError,
    Map,
    Set,
    console,
    setTimeout: world.clock.setTimeout,
    clearTimeout: world.clock.clearTimeout,
    setInterval: world.clock.setInterval,
    clearInterval: world.clock.clearInterval,
  });
  new Script(transformed, { filename: 'pm-sdk-quiescence-creation-entry.real.cjs' }).runInContext(context);
  return { common: /** @type {any} */ (module.exports), processLike, output };
}

/**
 * Loads the real ESM source body after exact replacement of every static
 * built-in/module binding. Strict mode is explicit because vm.Script is used.
 * @param {string} source
 * @param {ReturnType<typeof createMockWorld>} world
 * @param {any} common
 * @param {{argv?:string[], output?:MockOutput}=} options
 */
function loadEsm(source, world, common, options = {}) {
  let transformed = source;
  const replacements = [
    ["import { spawn, execFile, ChildProcess } from 'node:child_process';", 'const { spawn, execFile, ChildProcess } = globalThis.__childProcess;'],
    ["import { errorMonitor } from 'node:events';", 'const { errorMonitor } = globalThis.__events;'],
    ["import { fileURLToPath } from 'node:url';", 'const { fileURLToPath } = globalThis.__url;'],
    ["import { promisify } from 'node:util';", 'const { promisify } = globalThis.__util;'],
    ["import { createPrototypeSpawnGuard } from './helpers/pm-sdk-quiescence-adapter.mjs';", 'const { createPrototypeSpawnGuard } = globalThis.__guard;'],
    ["import common from './pm-sdk-quiescence-creation-entry.cjs';", 'const common = globalThis.__common;'],
    ['export async function runEsmCreationEntry', 'async function runEsmCreationEntry'],
    ['export async function esmMain', 'async function esmMain'],
    ['import.meta.url', "'file:///virtual/entry.mjs'"],
  ];
  for (const [before, after] of replacements) transformed = replaceExact(transformed, before, after, `ESM ${before}`);
  transformed = `'use strict';\n${transformed}\nglobalThis.__esmExports = { runEsmCreationEntry, esmMain };\n`;
  const output = options.output ?? new MockOutput();
  const processLike = {
    argv: options.argv ?? ['/fixed/node', '/virtual/not-direct.mjs'],
    stdout: output,
    exitCode: undefined,
    execPath: FIXED_NODE,
    version: EXPECTED_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    hrtime: { bigint: world.clock.now },
  };
  const sandbox = {
    __childProcess: { spawn: world.api.spawn, execFile: world.api.execFile, ChildProcess: world.MockChildProcess },
    __events: { errorMonitor },
    __url: { fileURLToPath: () => '/virtual/source-only.mjs' },
    __util: { promisify },
    __guard: { createPrototypeSpawnGuard },
    __common: common,
    __esmExports: undefined,
    process: processLike,
    Buffer,
    Uint8Array,
    Promise,
    Object,
    Reflect,
    Number,
    String,
    TypeError,
    Map,
    Set,
    console,
    setTimeout: world.clock.setTimeout,
    clearTimeout: world.clock.clearTimeout,
    setInterval: world.clock.setInterval,
    clearInterval: world.clock.clearInterval,
  };
  const context = createContext(sandbox);
  new Script(transformed, { filename: 'pm-sdk-quiescence-creation-entry.real.vm.mjs' }).runInContext(context);
  return { esm: /** @type {any} */ (sandbox.__esmExports), processLike, output };
}

/** @typedef {'spawn'|'execFile'|'promisify-execFile'} CaseName */

/**
 * @param {any} runner
 * @param {CaseName} caseName
 * @param {ReturnType<typeof createMockWorld>} world
 * @param {{frameSink?:(frame:Uint8Array)=>unknown,onProgress?:(value:any)=>unknown,subscribeOutputFailure?:((listener:(error:unknown)=>void)=>void)}=} options
 */
function startFixture(runner, caseName, world, options = {}) {
  /** @type {any[]} */
  const progress = [];
  const promise = runner({
    caseName,
    api: world.api,
    ChildProcess: world.MockChildProcess,
    createPrototypeSpawnGuard,
    errorMonitor,
    promisify,
    process: { execPath: FIXED_NODE, version: EXPECTED_VERSION, platform: 'darwin', arch: 'arm64' },
    clock: world.clock,
    frameSink: options.frameSink ?? completeFrameSink,
    expectedVersion: EXPECTED_VERSION,
    onProgress: options.onProgress ?? ((value) => progress.push(value)),
    subscribeOutputFailure: options.subscribeOutputFailure,
  });
  return { promise, progress };
}

/** @param {any} runner @param {CaseName} caseName @param {WorldBehavior=} behavior */
async function completeFixture(runner, caseName, behavior = {}) {
  const world = createMockWorld(behavior);
  const started = startFixture(runner, caseName, world);
  await world.clock.runTo(100);
  const report = await started.promise;
  return { world, report, progress: started.progress };
}

/** @param {any} child @param {{omit?:'child'|'stdout'|'stderr'|'stdin'|'stdout-end', version?:string}=} options */
function emitManualCompletion(child, options = {}) {
  child.emit('spawn');
  child.stdout.emit('data', `${options.version ?? EXPECTED_VERSION}\n`);
  if (options.omit !== 'stdout-end') child.stdout.emit('end');
  child.stderr.emit('end');
  if (options.omit !== 'stdout') child.stdout.emit('close');
  if (options.omit !== 'stderr') child.stderr.emit('close');
  child.emit('exit', 0, null);
  if (options.omit !== 'child') child.emit('close', 0, null);
  if (options.omit !== 'stdin') child.stdin.emit('close');
}

/** @param {string} text */
function jsonLines(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Creates an actual CJS/ESM main-entry fixture. Both paths execute their real
 * entry body; only the exact built-in/module bindings are in-memory.
 * @param {'cjs'|'esm'} kind
 * @param {CaseName} caseName
 * @param {WorldBehavior=} behavior
 * @param {MockOutput=} output
 * @param {string=} cjsOverride
 * @param {string=} esmOverride
 */
function startEntry(kind, caseName, behavior = {}, output = new MockOutput(), cjsOverride = cjsSource, esmOverride = esmSource) {
  const world = createMockWorld(behavior);
  const argv = ['/fixed/node', kind === 'cjs' ? '/virtual/entry.cjs' : '/virtual/entry.mjs', AUTHORIZATION, `--case=${caseName}`];
  const loadedCommon = loadCommon(cjsOverride, world, { argv, output });
  if (kind === 'cjs') {
    return { world, output, processLike: loadedCommon.processLike, promise: loadedCommon.common.cjsMain(), api: loadedCommon.common };
  }
  const loadedEsm = loadEsm(esmOverride, world, loadedCommon.common, { argv, output });
  return { world, output, processLike: loadedEsm.processLike, promise: loadedEsm.esm.esmMain(), api: loadedCommon.common };
}

/** @param {ReturnType<typeof startEntry>} entry */
async function completeEntry(entry) {
  await entry.world.clock.runTo(100);
  await entry.promise;
  return jsonLines(entry.output.text).at(-1);
}

/** @type {{name:string, run:()=>unknown|Promise<unknown>}[]} */
const tests = [];
/** @param {string} name @param {()=>unknown|Promise<unknown>} run */
function test(name, run) { tests.push({ name, run }); }

const baselineWorld = createMockWorld();
const baselineCommon = loadCommon(cjsSource, baselineWorld).common;
const cjsRunner = baselineCommon.runCreationCase;

assert.match(esmSource, /import \{ spawn, execFile, ChildProcess \} from 'node:child_process';/u);
assert.match(esmSource, /api: \{ spawn, execFile \}/u);
assert.doesNotMatch(esmSource, /common\.(?:spawn|execFile|ChildProcess)/u);
assert.match(cjsSource, /if \(require\.main === module\)/u);

test('真实CJS cjsMain与ESM esmMain三种API均走静态入口绑定和完整终态', async () => {
  for (const kind of /** @type {const} */ (['cjs', 'esm'])) {
    for (const caseName of /** @type {CaseName[]} */ (['spawn', 'execFile', 'promisify-execFile'])) {
      const entry = startEntry(kind, caseName);
      const report = await completeEntry(entry);
      assert.equal(report.ok, true, `${kind}/${caseName}`);
      assert.equal(report.original.calls, 1, `${kind}/${caseName}`);
      assert.equal(report.original.thisMatchesPublicChild, true, `${kind}/${caseName}`);
      assert.equal(report.original.thisMatchesOwnedReceiver, true, `${kind}/${caseName}`);
      assert.equal(report.publicApi.childMatchesGuardReceiver, true, `${kind}/${caseName}`);
      assert.equal(report.publicApi.publicChildMatchesOwnedReceiver, true, `${kind}/${caseName}`);
      assert.equal(report.terminal.resourcesEnded, true, `${kind}/${caseName}`);
      assert.equal(report.prototype.restored, true, `${kind}/${caseName}`);
      assert.equal(entry.world.children.length, 1, `${kind}/${caseName}`);
      assert.equal(entry.world.nativeRecords.length, 1, `${kind}/${caseName}`);
      assert.equal(Array.from(report.frames, (frame) => frame[0]).join(','), 'R,B', `${kind}/${caseName}`);
      assert.equal(entry.processLike.exitCode, 0, `${kind}/${caseName}`);
      if (caseName === 'promisify-execFile') assert.equal(report.publicApi.promiseChildMatches, true);
      if (caseName === 'execFile') assert.equal(report.publicApi.callbackCalls, 1);
    }
  }
});

test('两真实入口无gate先装持续父输出通道、拒绝且零spawn，晚错和重复错不逃逸', async () => {
  for (const kind of /** @type {const} */ (['cjs', 'esm'])) {
    const world = createMockWorld();
    const output = new MockOutput();
    const argv = ['/fixed/node', kind === 'cjs' ? '/virtual/entry.cjs' : '/virtual/entry.mjs'];
    const common = loadCommon(cjsSource, world, { argv, output });
    let promise;
    let processLike;
    if (kind === 'cjs') {
      promise = common.common.cjsMain();
      processLike = common.processLike;
    } else {
      const loaded = loadEsm(esmSource, world, common.common, { argv, output });
      promise = loaded.esm.esmMain();
      processLike = loaded.processLike;
    }
    await promise;
    assert.equal(output.text, 'NOT_AUTHORIZED\n', kind);
    assert.equal(world.children.length, 0, kind);
    assert.equal(output.listenerCount('error'), 1, kind);
    assert.equal(capture(() => output.emit('error', new Error('late-1'))).threw, false, kind);
    assert.equal(capture(() => output.emit('error', new Error('late-2'))).threw, false, kind);
    assert.equal(processLike.exitCode, 1, kind);
  }
});

test('R1：native进入后有pid或无pid再throw均保留原receiver和keeper，零native失败可结束', async () => {
  const throwCases = [
    ...[undefined, null, false, 0, '', Number.NaN].map((value) => ({ timing: /** @type {const} */ ('after-pid'), value })),
    { timing: /** @type {const} */ ('after-no-pid'), value: undefined },
  ];
  for (const { timing, value: thrown } of throwCases) {
    const label = `${timing}/${String(thrown)}`;
    const world = createMockWorld({ nativeThrowTiming: timing, nativeThrow: thrown, noAutomaticEvents: true, omitStdinClose: true });
    const started = startFixture(cjsRunner, 'spawn', world);
    let settled = false;
    started.promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, label);
    assert.equal(world.clock.intervals.size, 1, label);
    assert.equal(world.publicCaught.present, true, label);
    assert.equal(Object.is(world.publicCaught.value, thrown), true, label);
    assert.equal(world.children[0].listenerCount('close') > 0, true, label);
    emitManualCompletion(world.children[0]);
    await world.clock.runTo(10);
    const report = await started.promise;
    assert.equal(report.ok, false, label);
    assert.equal(report.publicApi.returned, false, label);
    assert.equal(report.original.thisMatchesOwnedReceiver, true, label);
    assert.equal(report.terminal.resourcesEnded, true, label);
  }

  const zeroWorld = createMockWorld();
  const zero = startFixture(cjsRunner, 'spawn', zeroWorld, { frameSink: (frame) => frame.byteLength - 1 });
  const zeroReport = await zero.promise;
  assert.equal(zeroReport.terminal.nativeEntered, false);
  assert.equal(zeroWorld.nativeRecords.length, 0);
  assert.equal(zeroWorld.clock.intervals.size, 0);
});

test('R2：stream注册、读取与stdin.end异常不逃逸且不能在未知close时释放owner', async () => {
  const closeFailureWorld = createMockWorld({ noAutomaticEvents: true, stdoutFailOn: 'close', omitStdinClose: true });
  const closeFailure = capture(() => startFixture(cjsRunner, 'spawn', closeFailureWorld));
  assert.equal(closeFailure.threw, false);
  const closeStarted = /** @type {ReturnType<typeof startFixture>} */ (closeFailure.value);
  assert.equal(closeFailureWorld.clock.intervals.size, 1);
  emitManualCompletion(closeFailureWorld.children[0]);
  await closeFailureWorld.clock.runTo(10000);
  let settled = false;
  closeStarted.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(closeFailureWorld.clock.intervals.size, 1);

  const readWorld = createMockWorld({ noAutomaticEvents: true, stdoutReadThrow: true, omitStdinClose: true });
  const readStarted = capture(() => startFixture(cjsRunner, 'spawn', readWorld));
  assert.equal(readStarted.threw, false);
  const readChild = readWorld.children[0];
  readChild.emit('spawn');
  readChild.rawStdout.emit('data', `${EXPECTED_VERSION}\n`);
  readChild.rawStdout.emit('end');
  readChild.rawStdout.emit('close');
  readChild.stderr.emit('end');
  readChild.stderr.emit('close');
  readChild.emit('exit', 0, null);
  readChild.emit('close', 0, null);
  readChild.stdin.emit('close');
  await readWorld.clock.runTo(10000);
  let readSettled = false;
  /** @type {ReturnType<typeof startFixture>} */ (readStarted.value).promise.then(() => { readSettled = true; });
  await Promise.resolve();
  assert.equal(readSettled, false);
  assert.equal(readWorld.clock.intervals.size, 1);

  const endWorld = createMockWorld({ noAutomaticEvents: true, stdinEndThrow: true });
  const endStarted = capture(() => startFixture(cjsRunner, 'spawn', endWorld));
  assert.equal(endStarted.threw, false);
  emitManualCompletion(endWorld.children[0]);
  await endWorld.clock.runTo(5000);
  const endReport = await /** @type {ReturnType<typeof startFixture>} */ (endStarted.value).promise;
  assert.equal(endReport.ok, false);
  assert.ok(endReport.failures.includes('stdin-end-throw'));
});

test('R3：父输出同步、callback及callback后/重复异步error首错锁存且不移除监听', async () => {
  for (const mode of /** @type {const} */ (['sync-throw', 'callback-error'])) {
    const output = new MockOutput(mode);
    const processLike = { exitCode: undefined };
    const channel = baselineCommon.createSafeOutputChannel(output, processLike);
    assert.equal(await channel.writeText('x'), false, mode);
    assert.equal(channel.failed(), true, mode);
    assert.equal(processLike.exitCode, 1, mode);
    assert.equal(output.listenerCount('error'), 1, mode);
    assert.equal(capture(() => output.emit('error', new Error('after-write-failure'))).threw, false, mode);
  }

  const output = new MockOutput('manual-callback');
  const processLike = { exitCode: undefined };
  const channel = baselineCommon.createSafeOutputChannel(output, processLike);
  const write = channel.writeText('x');
  output.callbacks[0](null);
  assert.equal(await write, true);
  assert.equal(capture(() => output.emit('error', new Error('after-callback'))).threw, false);
  assert.equal(capture(() => output.emit('error', new Error('repeated'))).threw, false);
  assert.equal(channel.failed(), true);
  assert.equal(output.listenerCount('error'), 1);
  assert.equal(processLike.exitCode, 1);

  const beforeOutput = new MockOutput('manual-callback');
  const beforeProcess = { exitCode: undefined };
  const beforeChannel = baselineCommon.createSafeOutputChannel(beforeOutput, beforeProcess);
  const beforeWrite = beforeChannel.writeText('y');
  assert.equal(capture(() => beforeOutput.emit('error', new Error('before-callback'))).threw, false);
  beforeOutput.callbacks[0](null);
  assert.equal(await beforeWrite, false);
  assert.equal(capture(() => beforeOutput.emit('error', new Error('after-failed-write'))).threw, false);
  assert.equal(beforeProcess.exitCode, 1);

  const successEntry = startEntry('cjs', 'spawn');
  await completeEntry(successEntry);
  assert.equal(successEntry.processLike.exitCode, 0);
  assert.equal(capture(() => successEntry.output.emit('error', new Error('after-final-report'))).threw, false);
  assert.equal(successEntry.processLike.exitCode, 1);
});

test('R3/R4：等待期间父输出错和progress异常不逃逸、不清keeper；两入口输出5/10秒', async () => {
  for (const kind of /** @type {const} */ (['cjs', 'esm'])) {
    const output = new MockOutput();
    const entry = startEntry(kind, 'spawn', { noAutomaticEvents: true, omitStdinClose: true }, output);
    assert.equal(output.listenerCount('error'), 1, kind);
    await entry.world.clock.runTo(5000);
    let reports = jsonLines(output.text);
    assert.equal(reports.at(-1).kind, 'observation-timeout', kind);
    await entry.world.clock.runTo(10000);
    reports = jsonLines(output.text);
    assert.equal(reports.at(-1).kind, 'cleanup-unconfirmed', kind);
    assert.equal(entry.world.clock.intervals.size, 1, kind);
    assert.equal(capture(() => output.emit('error', new Error('waiting-output-error'))).threw, false, kind);
    assert.equal(entry.world.clock.intervals.size, 1, kind);
    emitManualCompletion(entry.world.children[0]);
    await entry.world.clock.runTo(10010);
    await entry.promise;
    assert.equal(entry.processLike.exitCode, 1, kind);
  }

  const progressWorld = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
  const progress = startFixture(cjsRunner, 'spawn', progressWorld, { onProgress: () => { throw new Error('progress'); } });
  assert.equal(capture(() => progressWorld.clock.runTo(10000)).threw, false);
  await progressWorld.clock.runTo(10000);
  let settled = false;
  progress.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(progressWorld.clock.intervals.size, 1);
});

test('R5：CP与三路stream任一close迟到均保活；全资源close仅缺验收事实在5秒失败完成', async () => {
  for (const omitted of /** @type {const} */ (['child', 'stdout', 'stderr', 'stdin'])) {
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const started = startFixture(cjsRunner, 'spawn', world);
    emitManualCompletion(world.children[0], { omit: omitted });
    await world.clock.runTo(10000);
    let settled = false;
    started.promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, omitted);
    assert.equal(world.clock.intervals.size, 1, omitted);
    if (omitted === 'child') world.children[0].emit('close', 0, null);
    else if (omitted === 'stdout') world.children[0].stdout.emit('close');
    else if (omitted === 'stderr') world.children[0].stderr.emit('close');
    else world.children[0].stdin.emit('close');
    await Promise.resolve();
    const report = await started.promise;
    assert.equal(report.ok, false, omitted);
    assert.equal(report.terminal.resourcesEnded, true, omitted);
  }

  const missingEndWorld = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
  const missingEnd = startFixture(cjsRunner, 'spawn', missingEndWorld);
  emitManualCompletion(missingEndWorld.children[0], { omit: 'stdout-end' });
  await missingEndWorld.clock.runTo(4999);
  let settled = false;
  missingEnd.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  await missingEndWorld.clock.runTo(5000);
  const report = await missingEnd.promise;
  assert.equal(report.ok, false);
  assert.equal(report.terminal.resourcesEnded, true);
  assert.equal(report.terminal.stdoutEnd, false);
});

test('公共promise.child缺失不冒充未创建，仍用A1原receiver等待全部close', async () => {
  const world = createMockWorld({ noAutomaticEvents: true, missingPromiseChild: true, omitStdinClose: true });
  const started = startFixture(cjsRunner, 'promisify-execFile', world);
  let settled = false;
  started.promise.then(() => { settled = true; });
  assert.equal(settled, false);
  assert.equal(world.clock.intervals.size, 1);
  emitManualCompletion(world.children[0]);
  await world.clock.runTo(10);
  const report = await started.promise;
  assert.equal(report.ok, false);
  assert.ok(report.failures.includes('promisify-child-missing'));
  assert.equal(report.original.thisMatchesOwnedReceiver, true);
  assert.equal(report.terminal.resourcesEnded, true);
});

test('R7：每路超过4KiB后锁存停止累积，后续小块仅排空且终态仍记录', async () => {
  for (const streamName of /** @type {const} */ (['stdout', 'stderr'])) {
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const started = startFixture(cjsRunner, 'spawn', world);
    const child = world.children[0];
    child[streamName].emit('data', 'x'.repeat(4097));
    child[streamName].emit('data', 'later');
    emitManualCompletion(child);
    await world.clock.runTo(10);
    const report = await started.promise;
    assert.equal(report.ok, false, streamName);
    assert.equal(report.output[streamName], streamName === 'stdout' ? '' : '', streamName);
    assert.equal(report.output[`${streamName}Overflow`], true, streamName);
    assert.equal(report.terminal.resourcesEnded, true, streamName);
  }

  const cumulativeWorld = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
  const cumulative = startFixture(cjsRunner, 'spawn', cumulativeWorld);
  cumulativeWorld.children[0].stdout.emit('data', 'a'.repeat(4090));
  cumulativeWorld.children[0].stdout.emit('data', 'b'.repeat(10));
  cumulativeWorld.children[0].stdout.emit('data', 'small');
  emitManualCompletion(cumulativeWorld.children[0], { version: '' });
  await cumulativeWorld.clock.runTo(10);
  const cumulativeReport = await cumulative.promise;
  assert.equal(cumulativeReport.output.stdout.startsWith('a'.repeat(4090)), true);
  assert.equal(cumulativeReport.output.stdout.includes('small'), false);
  assert.equal(cumulativeReport.output.stdoutOverflow, true);
});

test('child只装errorMonitor不吞普通error，原型descriptor恢复及固定参数保持', async () => {
  const world = createMockWorld({ noAutomaticEvents: true });
  const before = Object.getOwnPropertyDescriptor(world.MockChildProcess.prototype, 'spawn');
  const started = startFixture(cjsRunner, 'spawn', world);
  assert.deepEqual(Object.getOwnPropertyDescriptor(world.MockChildProcess.prototype, 'spawn'), before);
  const child = world.children[0];
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount(errorMonitor), 1);
  const sentinel = new Error('unhandled-after-monitor');
  assert.throws(() => child.emit('error', sentinel), (error) => error === sentinel);
  emitManualCompletion(child);
  await world.clock.runTo(10);
  const report = await started.promise;
  assert.equal(report.ok, false);
  const native = world.nativeRecords[0].options;
  assert.equal(native.file, FIXED_NODE);
  assert.equal(Array.from(native.args).join(','), '--version');
  assert.equal(native.options.shell, false);
  assert.equal(native.options.detached, false);
  assert.equal(Array.from(native.options.stdio).join(','), 'pipe,pipe,pipe');
});

test('F1：ESM真实入口在期限前输出失败必须通知runner，而不只设置外层exit', async () => {
  const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
  const output = new MockOutput();
  const argv = ['/fixed/node', '/virtual/entry.mjs', AUTHORIZATION, '--case=spawn'];
  const common = loadCommon(cjsSource, world, { argv, output }).common;
  const originalRunner = common.runCreationCase;
  /** @type {any[]} */ const reports = [];
  /** @type {unknown[]} */ const subscriptions = [];
  common.runCreationCase = (/** @type {any} */ deps) => {
    subscriptions.push(deps.subscribeOutputFailure);
    const promise = originalRunner(deps);
    promise.then((/** @type {any} */ report) => { reports.push(report); });
    return promise;
  };
  const loaded = loadEsm(esmSource, world, common, { argv, output });
  const entry = loaded.esm.esmMain();
  assert.equal(world.children.length, 1);
  assert.equal(typeof subscriptions[0], 'function');
  assert.doesNotThrow(() => output.emit('error', new Error('early-output')));
  assert.equal(world.clock.intervals.size, 1);
  emitManualCompletion(world.children[0]);
  await world.clock.runTo(10); await entry;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].output.parentFailed, true);
  assert.ok(reports[0].failures.includes('parent-output-error'));
  assert.equal(reports[0].terminal.observationDeadline, false);
  assert.equal(loaded.processLike.exitCode, 1);
});

test('F2：native前两种必需观察注册失败阻止R和native并保留原抛值', async () => {
  for (const name of [errorMonitor, 'close']) for (const value of [undefined, false, { original: true }]) {
    const world = createMockWorld({ childFailOn: name, childObserverError: value });
    const started = startFixture(cjsRunner, 'spawn', world);
    const report = await started.promise;
    assert.equal(world.nativeRecords.length, 0);
    assert.equal(world.publicCaught.present, true);
    assert.equal(world.publicCaught.value, value);
    assert.equal(report.terminal.nativeEntered, false);
    assert.equal(report.guard.failed, true);
    assert.equal(report.frames.length, 0);
    assert.equal(report.ok, false);
    assert.equal(world.clock.intervals.size, 0);
    assert.equal(world.children[0].listenerCount(name === errorMonitor ? 'close' : errorMonitor), 1);
  }
});

test('F3：stdin.end原错误独立于finish缺项保存并锁存失败', async () => {
  for (const value of [false, 0, '', { original: true }]) {
    const world = createMockWorld({ stdinEndError: value, omitStdinFinish: true });
    const started = startFixture(cjsRunner, 'spawn', world);
    await world.clock.runTo(5000);
    const report = await started.promise;
    assert.equal(report.ok, false);
    assert.equal(report.rawErrorPresent, true);
    assert.equal(report.terminal.stdinEndCallback, true);
    assert.equal(report.terminal.stdinEndCallbackSucceeded, false);
    assert.equal(report.terminal.stdinEndCallbackErrorPresent, true);
    assert.ok(report.failures.includes('stdin-end-callback-error'));
    assert.equal(report.terminal.resourcesEnded, true);
  }
  const normal = await completeFixture(cjsRunner, 'spawn');
  assert.equal(normal.report.terminal.stdinEndCallbackSucceeded, true);
  assert.equal(normal.report.terminal.stdinEndCallbackErrorPresent, false);
});

test('F4：progress失败值及异步false、拒绝、抛错不清owner', async () => {
  for (const mode of ['false', 'promise-false', 'rejection', 'throw', 'late-false', 'void']) {
    /** @type {(value:boolean)=>void} */ let settle = () => {};
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const started = startFixture(cjsRunner, 'spawn', world, { onProgress: () => {
      if (mode === 'false') return false;
      if (mode === 'promise-false') return Promise.resolve(false);
      if (mode === 'rejection') return Promise.reject(false);
      if (mode === 'throw') throw false;
      if (mode === 'late-false') return new Promise((resolve) => { settle = resolve; });
      return undefined;
    } });
    await world.clock.runTo(5000);
    assert.equal(world.clock.intervals.size, 1);
    if (mode === 'late-false') { settle(false); await Promise.resolve(); await Promise.resolve(); }
    emitManualCompletion(world.children[0]); await world.clock.runTo(5010);
    const report = await started.promise;
    assert.equal(report.ok, false);
    if (mode === 'throw') assert.ok(report.failures.includes('progress-report-failed'));
    else assert.equal(report.output.parentFailed, mode !== 'void', mode);
  }
});

test('F5：恢复缺pid、非零native/child、B短写和restore抛错回归', async () => {
  /** @type {Array<[string, WorldBehavior, ((frame:Uint8Array)=>unknown)?]>} */
  const rows = [
    ['pid', { missingPid: true }], ['native', { nativeReturn: 9 }],
    ['child', { nonzeroExit: true }], ['restore', { restoreSabotage: true }],
    ['bound', {}, (() => { let writes = 0; return (/** @type {Uint8Array} */ frame) => ++writes === 2 ? frame.byteLength - 1 : frame.byteLength; })()],
  ];
  for (const [name, behavior, frameSink] of rows) {
    const world = createMockWorld(behavior);
    const started = startFixture(cjsRunner, 'spawn', world, { frameSink });
    await world.clock.runTo(100); const report = await started.promise;
    assert.equal(report.ok, false, name);
    assert.equal(report.terminal.resourcesEnded, true, name);
    assert.equal(world.clock.intervals.size, 0, name);
    if (name === 'restore') assert.ok(report.failures.includes('prototype-restore-failed'));
  }
  for (const name of /** @type {CaseName[]} */ (['execFile', 'promisify-execFile'])) {
    const world = createMockWorld({ callbackEarly: true, omitChildClose: true });
    const started = startFixture(cjsRunner, name, world);
    let settled = false; started.promise.then(() => { settled = true; });
    await world.clock.runTo(100); assert.equal(settled, false);
    assert.equal(world.clock.intervals.size, 1);
    world.children[0].emit('close', 0, null);
    assert.equal((await started.promise).ok, true, name);
  }
});

test('F5：恢复gate/NUL/仅加载不安装及execFile原error回调回归', async () => {
  const world = createMockWorld();
  const before = Object.getOwnPropertyDescriptor(world.MockChildProcess.prototype, 'spawn');
  const common = loadCommon(cjsSource, world).common;
  loadEsm(esmSource, world, common);
  assert.equal(world.children.length, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(world.MockChildProcess.prototype, 'spawn'), before);
  for (const args of [[], ['--case=spawn', AUTHORIZATION], [AUTHORIZATION, '--case=unknown'], [AUTHORIZATION, '--case=spawn', '--case=spawn']]) {
    assert.equal(common.parseAuthorizedCase(args), null);
  }
  assert.ok(before && 'value' in before);
  const guard = createPrototypeSpawnGuard({ originalSpawn: before.value, writeFrame: completeFrameSink, installObserver() {} });
  Object.defineProperty(world.MockChildProcess.prototype, 'spawn', { ...before, value: guard.spawn });
  try {
    assert.throws(() => world.api.spawn('bad\0file', ['--version'], {}), TypeError);
    assert.equal(world.children.length, 0); assert.equal(guard.owned().length, 0);
  } finally { Object.defineProperty(world.MockChildProcess.prototype, 'spawn', before); }
  const errorWorld = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
  const started = startFixture(cjsRunner, 'execFile', errorWorld);
  const child = errorWorld.children[0], sentinel = new Error('execFile-original');
  assert.equal(child.listenerCount('error'), 1); assert.equal(child.listenerCount(errorMonitor), 1);
  assert.doesNotThrow(() => child.emit('error', sentinel));
  emitManualCompletion(child); await errorWorld.clock.runTo(10);
  const result = await started.promise;
  assert.equal(result.publicApi.callbackCalls, 1); assert.equal(result.publicApi.callbackErrorNull, false);
  assert.equal(result.guard.failed, true); assert.equal(result.ok, false);
});

/**
 * Every mutation first runs its invariant against the normal source. The
 * mutant must load successfully and then be killed by a host AssertionError.
 * @param {string} name
 * @param {string} source
 * @param {string} before
 * @param {string} after
 * @param {(mutated:string|null)=>Promise<void>} invariant
 */
function mutationTest(name, source, before, after, invariant) {
  test(`变异命中：${name}`, async () => {
    await invariant(null);
    const mutated = replaceExact(source, before, after, name);
    const outcome = await (async () => {
      try { await invariant(mutated); return { threw: false, value: undefined }; }
      catch (error) { return { threw: true, value: error }; }
    })();
    assert.equal(outcome.threw, true, `${name}: mutant survived`);
    assert.equal(outcome.value instanceof assert.AssertionError, true, `${name}: must be a real AssertionError`);
  });
}

mutationTest(
  'native前observer失败未交给A1',
  cjsSource,
  '    if (registrationFailed) throw registrationError;',
  '    if (registrationFailed) { /* mutant suppresses required rejection */ }',
  async (mutated) => {
    const world = createMockWorld({ childFailOn: errorMonitor, childObserverError: false });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    startFixture(runner, 'spawn', world);
    assert.equal(world.nativeRecords.length, 0);
  },
);

mutationTest(
  'stdin回调错误被忽略',
  cjsSource,
  '          if (error !== null && error !== undefined) {\n            stdinEndCallbackErrorPresent = true;',
  '          if (false) {\n            stdinEndCallbackErrorPresent = true;',
  async (mutated) => {
    const world = createMockWorld({ stdinEndError: false, omitStdinFinish: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    await world.clock.runTo(5000);
    assert.ok((await started.promise).failures.includes('stdin-end-callback-error'));
  },
);

mutationTest(
  'progress的fulfilled false被当正常回执',
  cjsSource,
  "          if (written === false) latchParentOutputFailure(new Error('progress output returned failure'));",
  '          void written;',
  async (mutated) => {
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world, { onProgress: () => Promise.resolve(false) });
    await world.clock.runTo(5000); emitManualCompletion(world.children[0]);
    await world.clock.runTo(5010);
    assert.equal((await started.promise).output.parentFailed, true);
  },
);

mutationTest(
  'reserve未完成即进入native',
  cjsSource,
  '    const written = Reflect.apply(frameSink, undefined, [frame]);',
  '    Reflect.apply(frameSink, undefined, [frame]);\n    const written = frame.byteLength;',
  async (mutated) => {
    const world = createMockWorld();
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world, { frameSink: (frame) => frame.byteLength - 1 });
    await world.clock.runTo(100);
    await started.promise;
    assert.equal(world.nativeRecords.length, 0);
  },
);

mutationTest(
  'originalSpawn绑定错误this',
  cjsSource,
  '      const result = Reflect.apply(savedSpawn, this, args);',
  '      const result = Reflect.apply(savedSpawn, prototype, args);',
  async (mutated) => {
    const world = createMockWorld();
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    await world.clock.runTo(100);
    const report = await started.promise;
    assert.equal(report.original.thisMatchesPublicChild, true);
    assert.equal(report.ok, true);
  },
);

mutationTest(
  'promisify包装丢失原promise.child',
  cjsSource,
  '        promiseChild = originalPromise.child;',
  '        originalPromise = originalPromise.then((value) => value);\n        promiseChild = originalPromise.child;',
  async (mutated) => {
    const world = createMockWorld();
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'promisify-execFile', world);
    await world.clock.runTo(100);
    assert.equal((await started.promise).publicApi.promiseChildMatches, true);
  },
);

mutationTest(
  'native后throw按公共null误判未创建',
  cjsSource,
  '  nativeEntered = ownedSlot?.nativeEntered === true;',
  '  nativeEntered = publicChild !== null;',
  async (mutated) => {
    const world = createMockWorld({ nativeThrowTiming: 'after-pid', nativeThrow: false, noAutomaticEvents: true, omitStdinClose: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    let settled = false;
    started.promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(world.clock.intervals.size, 1);
  },
);

mutationTest(
  'stream注册异常逃逸owner路径',
  cjsSource,
  '      fail(failure);\n      return false;',
  '      fail(failure);\n      throw error;',
  async (mutated) => {
    const world = createMockWorld({ noAutomaticEvents: true, stdoutFailOn: 'close' });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const outcome = capture(() => startFixture(runner, 'spawn', world));
    assert.equal(outcome.threw, false);
    assert.equal(world.clock.intervals.size, 1);
  },
);

mutationTest(
  '用child close替代全部资源close',
  cjsSource,
  '      if (nativeEntered && !complete && !resourcesEnded()) return;',
  '      if (nativeEntered && !complete && childClose === null) return;',
  async (mutated) => {
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    emitManualCompletion(world.children[0], { omit: 'stdin' });
    await world.clock.runTo(5000);
    let settled = false;
    started.promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
  },
);

mutationTest(
  '父输出只监听首个error',
  cjsSource,
  "    output.on('error', latch);",
  "    output.once('error', latch);",
  async (mutated) => {
    const world = createMockWorld();
    const common = loadCommon(mutated ?? cjsSource, world).common;
    const output = new MockOutput();
    common.createSafeOutputChannel(output, { exitCode: undefined });
    assert.equal(capture(() => output.emit('error', new Error('one'))).threw, false);
    assert.equal(capture(() => output.emit('error', new Error('two'))).threw, false);
  },
);

mutationTest(
  'CJS真实入口漏接progress',
  cjsSource,
  '    onProgress: (/** @type {Record<string, unknown>} */ value) => output.writeJson(value),',
  '    onProgress: undefined,',
  async (mutated) => {
    const entry = startEntry('cjs', 'spawn', { noAutomaticEvents: true, omitStdinClose: true }, new MockOutput(), mutated ?? cjsSource);
    await entry.world.clock.runTo(5000);
    assert.equal(jsonLines(entry.output.text).at(-1)?.kind, 'observation-timeout');
  },
);

mutationTest(
  'ESM真实入口错接named spawn',
  esmSource,
  '    api: { spawn, execFile },',
  "    api: { spawn: () => { throw new TypeError('mutant'); }, execFile },",
  async (mutated) => {
    const entry = startEntry('esm', 'spawn', {}, new MockOutput(), cjsSource, mutated ?? esmSource);
    const report = await completeEntry(entry);
    assert.equal(report.ok, true);
    assert.equal(entry.world.nativeRecords.length, 1);
  },
);

mutationTest(
  'stream超预算后恢复累积',
  cjsSource,
  "    if (stream === 'stdout' ? stdoutOverflow : stderrOverflow) return;",
  "    if (false && (stream === 'stdout' ? stdoutOverflow : stderrOverflow)) return;",
  async (mutated) => {
    const world = createMockWorld({ noAutomaticEvents: true, omitStdinClose: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    world.children[0].stdout.emit('data', 'x'.repeat(4097));
    world.children[0].stdout.emit('data', 'later');
    emitManualCompletion(world.children[0]);
    await world.clock.runTo(10);
    const report = await started.promise;
    assert.equal(report.output.stdout.includes('later'), false);
  },
);

mutationTest(
  '普通child error监听吞语义',
  cjsSource,
  '    requireObserver(monitorSymbol, (/** @type {unknown} */ error) => {',
  "    requireObserver('error', (/** @type {unknown} */ error) => {",
  async (mutated) => {
    const world = createMockWorld({ noAutomaticEvents: true });
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    startFixture(runner, 'spawn', world);
    assert.equal(world.children[0].listenerCount('error'), 0);
    assert.equal(world.children[0].listenerCount(errorMonitor), 1);
  },
);

mutationTest(
  '未恢复完整descriptor',
  cjsSource,
  "        Object.defineProperty(prototype, 'spawn', savedDescriptor);",
  "        Object.defineProperty(prototype, 'spawn', { ...savedDescriptor, value: guard.spawn });",
  async (mutated) => {
    const world = createMockWorld();
    const runner = loadCommon(mutated ?? cjsSource, world).common.runCreationCase;
    const started = startFixture(runner, 'spawn', world);
    await world.clock.runTo(100);
    assert.equal((await started.promise).prototype.restored, true);
  },
);

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
console.log(`ok - ${passed} pm-sdk quiescence creation-entry VM tests`);
