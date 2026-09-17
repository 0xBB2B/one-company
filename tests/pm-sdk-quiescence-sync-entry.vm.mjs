// @ts-check

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const sourceUrl = new URL('./pm-sdk-quiescence-sync-entry.mjs', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const FIXED_NODE = '/opt/homebrew/Cellar/node/26.8.2/bin/node';
const FIXED_VERSION = 'v26.8.2';
const AUTHORIZATION = '--authorize=M4-PM-Q2-B4-SYNC-ENTRY';

/** @param {() => unknown} operation */
function capture(operation) {
  try { return { threw: false, value: operation() }; }
  catch (error) { return { threw: true, value: error }; }
}

/** @param {string} text @param {string} before @param {string} after @param {string} label */
function replaceExact(text, before, after, label) {
  assert.equal(text.split(before).length - 1, 1, `${label}: replacement anchor must be unique`);
  return text.replace(before, after);
}

class MockOutput extends EventEmitter {
  /** @param {'normal'|'sync-throw'|'callback-error'|'manual'} mode */
  constructor(mode = 'normal') {
    super();
    this.mode = mode;
    this.text = '';
    this.calls = 0;
    /** @type {((error?:unknown)=>void)[]} */
    this.callbacks = [];
  }
  /** @param {string} text @param {(error?:unknown)=>void} callback */
  write(text, callback) {
    this.calls += 1;
    if (this.mode === 'sync-throw') throw new Error('output failure');
    this.text += text;
    if (this.mode === 'callback-error') callback(false);
    else if (this.mode === 'manual') this.callbacks.push(callback);
    else callback();
    return true;
  }
}

/** @typedef {{result?:unknown,throwPresent?:boolean,throwValue?:unknown,sabotageRestore?:boolean,nowValues?:unknown[],nowThrowAt?:number,deniedAt?:'synchronize'|'getBinding'|'startClock'|'native',deniedName?:'execFileSync'|'execSync'}} WorldOptions */

/** @param {WorldOptions=} options */
function createWorld(options = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {{threw:boolean,value:unknown}[]} */
  const deniedOutcomes = [];
  let forbiddenNativeCalls = 0;
  let deniedTriggered = false;
  let nowIndex = 0;
  const defaultResult = Object.freeze({
    status: 0,
    signal: null,
    stdout: `${FIXED_VERSION}\n`,
    stderr: '',
    pid: 7123,
  });
  /** @type {Record<string, any>} */
  const cp = {};
  /**
   * @this {unknown}
   * @param {unknown} file
   * @param {unknown} args
   * @param {unknown} spawnOptions
   */
  function nativeSpawnSync(file, args, spawnOptions) {
    calls.push({ receiver: this, file, args, options: spawnOptions });
    triggerDenied('native');
    if (options.sabotageRestore) {
      Object.defineProperty(cp, 'spawnSync', {
        value: cp.spawnSync,
        writable: true,
        enumerable: true,
        configurable: false,
      });
    }
    if (options.throwPresent) throw options.throwValue;
    return Object.hasOwn(options, 'result') ? options.result : defaultResult;
  }
  function forbiddenNative() { forbiddenNativeCalls += 1; throw new Error('forbidden native export reached'); }
  /** @type {Array<[string, Function]>} */
  const functions = [['spawnSync', nativeSpawnSync], ['execFileSync', forbiddenNative], ['execSync', forbiddenNative]];
  for (const [name, value] of functions) {
    Object.defineProperty(cp, name, { value, writable: true, enumerable: true, configurable: true });
  }
  const named = { spawnSync: nativeSpawnSync };
  /** @param {'synchronize'|'getBinding'|'startClock'|'native'} phase */
  function triggerDenied(phase) {
    if (options.deniedAt !== phase || deniedTriggered) return;
    deniedTriggered = true;
    const name = options.deniedName ?? 'execSync';
    deniedOutcomes.push(capture(() => Reflect.apply(cp[name], cp, [])));
  }
  let syncCalls = 0;
  function synchronize() {
    syncCalls += 1;
    if (cp.spawnSync !== nativeSpawnSync) triggerDenied('synchronize');
    named.spawnSync = cp.spawnSync;
  }
  function getBinding() {
    if (cp.spawnSync !== nativeSpawnSync) triggerDenied('getBinding');
    return named.spawnSync;
  }
  const output = new MockOutput();
  const processLike = {
    argv: [FIXED_NODE, '/virtual/not-direct.mjs'],
    stdout: output,
    exitCode: undefined,
    execPath: FIXED_NODE,
    version: FIXED_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    hrtime: {
      bigint() {
        if (nowIndex === 0) triggerDenied('startClock');
        if (options.nowThrowAt === nowIndex) { nowIndex += 1; throw new Error('clock failure'); }
        const values = options.nowValues ?? [0n, 1n];
        return values[Math.min(nowIndex++, values.length - 1)];
      },
    },
  };
  return {
    cp, named, synchronize, getBinding, calls, deniedOutcomes, output, processLike, defaultResult,
    syncCalls: () => syncCalls, forbiddenNativeCalls: () => forbiddenNativeCalls,
  };
}

/**
 * Loads the real source body. Only exact static module bindings are mapped;
 * the synchronized named binding remains a mutable lexical binding in this VM.
 * @param {string} text
 * @param {ReturnType<typeof createWorld>} world
 */
function loadSource(text, world) {
  let transformed = text;
  const replacements = [
    ["import childProcess, { spawnSync } from 'node:child_process';", 'const childProcess = globalThis.__cp; let spawnSync = globalThis.__named.spawnSync;'],
    ["import { syncBuiltinESMExports } from 'node:module';", 'function syncBuiltinESMExports() { globalThis.__synchronize(); spawnSync = globalThis.__named.spawnSync; }'],
    ["import { fileURLToPath } from 'node:url';", "const fileURLToPath = () => '/virtual/source.mjs';"],
    ['export function createSyncCallGuard', 'function createSyncCallGuard'],
    ['export function parseAuthorizedCase', 'function parseAuthorizedCase'],
    ['export function runSyncSpawnCase', 'function runSyncSpawnCase'],
    ['export function createSafeOutputChannel', 'function createSafeOutputChannel'],
    ['export function main', 'function main'],
    ['import.meta.url', "'file:///virtual/source.mjs'"],
  ];
  for (const [before, after] of replacements) transformed = replaceExact(transformed, before, after, `loader ${before}`);
  transformed = `'use strict';\n${transformed}\nglobalThis.__exports = { createSyncCallGuard, parseAuthorizedCase, runSyncSpawnCase, createSafeOutputChannel, main };\n`;
  const sandbox = {
    __cp: world.cp,
    __named: world.named,
    __synchronize: world.synchronize,
    __exports: undefined,
    process: world.processLike,
    console,
  };
  const context = createContext(sandbox);
  new Script(transformed, { filename: 'pm-sdk-quiescence-sync-entry.real.vm.mjs' }).runInContext(context);
  return /** @type {any} */ (sandbox.__exports);
}

/** @param {any} api @param {ReturnType<typeof createWorld>} world */
function runFixture(api, world) {
  return api.runSyncSpawnCase({
    childProcess: world.cp,
    getSpawnSyncBinding: world.getBinding,
    syncBuiltinESMExports: world.synchronize,
    processLike: world.processLike,
    now: world.processLike.hrtime.bigint,
  });
}

/** @type {{name:string,run:()=>unknown|Promise<unknown>}[]} */
const tests = [];
/** @param {string} name @param {()=>unknown|Promise<unknown>} run */
function test(name, run) { tests.push({ name, run }); }

const baselineWorld = createWorld();
const baseline = loadSource(source, baselineWorld);

assert.match(source, /import childProcess, \{ spawnSync \} from 'node:child_process';/u);
assert.match(source, /import \{ syncBuiltinESMExports \} from 'node:module';/u);
assert.doesNotMatch(source, /\btimeout\s*:/u);
assert.doesNotMatch(source, /\bkillSignal\s*:/u);
assert.doesNotMatch(source, /\b(?:execFileSync|execSync)\s*\(/u);

test('仅加载没有安装、创建或同步副作用', () => {
  assert.equal(baselineWorld.calls.length, 0);
  assert.equal(baselineWorld.syncCalls(), 0);
  assert.equal(baselineWorld.cp.spawnSync, baselineWorld.named.spawnSync);
});

test('guard工厂只接受三个own-data函数且不执行依赖getter', () => {
  for (const name of ['original', 'record', 'now']) {
    let reads = 0;
    const dependencies = { original() {}, record() {}, now() { return 0n; } };
    Object.defineProperty(dependencies, name, { configurable: true, get() { reads += 1; return () => 0n; } });
    assert.equal(/** @type {any} */ (capture(() => baseline.createSyncCallGuard(dependencies)).value).name, 'TypeError');
    assert.equal(reads, 0, name);
  }
  const inherited = Object.create({ original() {}, record() {}, now() { return 0n; } });
  assert.equal(/** @type {any} */ (capture(() => baseline.createSyncCallGuard(inherited)).value).name, 'TypeError');
  assert.equal(/** @type {any} */ (capture(() => baseline.createSyncCallGuard({ original() {}, record() {} })).value).name, 'TypeError');
  assert.equal(/** @type {any} */ (capture(() => baseline.createSyncCallGuard({ original: 1, record() {}, now() {} })).value).name, 'TypeError');
});

test('同步guard保留this、参数与原result身份，协议事件固定冻结', () => {
  const receiver = {};
  const one = {};
  const two = {};
  const result = { opaque: true };
  /** @type {unknown[]} */ const seen = [];
  /** @type {any} */ let actualThis;
  /** @type {unknown[]} */ let actualArgs = [];
  const guard = baseline.createSyncCallGuard({
    /** @this {unknown} @param {...unknown} args */
    original: function (...args) { actualThis = this; actualArgs = args; return result; },
    record(/** @type {unknown} */ event) { seen.push(event); },
    now: (() => { const values = [4n, 9n]; return () => values.shift(); })(),
  });
  const returned = Reflect.apply(guard.invoke, receiver, [one, two]);
  assert.equal(returned, result);
  assert.equal(actualThis, receiver);
  assert.equal(actualArgs[0], one);
  assert.equal(actualArgs[1], two);
  assert.deepEqual(seen.map((event) => ({ .../** @type {any} */ (event) })), [
    { sequence: 1, kind: 'R' }, { sequence: 2, kind: 'S' },
  ]);
  assert.equal(seen.every(Object.isFrozen), true);
  const snapshot = guard.snapshot();
  assert.equal(snapshot.nativeOutcome.value, result);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(result), false);
  assert.doesNotThrow(() => guard.assertHealthy());
});

test('R失败、非undefined及thenable均在native前拒绝且不读取then', () => {
  for (const mode of ['throw', 'false', 'thenable']) {
    let calls = 0;
    let thenReads = 0;
    /** @type {Record<string, unknown>} */
    const thenable = {};
    Object.defineProperty(thenable, 'then', { get() { thenReads += 1; throw new Error('must not inspect then'); } });
    const guard = baseline.createSyncCallGuard({
      original() { calls += 1; },
      record() {
        if (mode === 'throw') throw false;
        if (mode === 'false') return false;
        return thenable;
      },
      now: () => 0n,
    });
    assert.equal(capture(() => guard.invoke()).threw, true, mode);
    assert.equal(calls, 0, mode);
    assert.equal(thenReads, 0, mode);
    assert.equal(guard.snapshot().nativeOutcome.kind, 'not-entered', mode);
  }
});

test('R记录与start clock实际throw原值原样抛出且重复不覆盖首错', () => {
  const thrownValues = [undefined, null, false, 0, '', Number.NaN, { opaque: true }];
  for (const phase of ['record', 'clock']) for (const thrown of thrownValues) {
    let calls = 0;
    const guard = baseline.createSyncCallGuard({
      original() { calls += 1; },
      record() { if (phase === 'record') throw thrown; },
      now() { if (phase === 'clock') throw thrown; return 0n; },
    });
    const outcome = capture(() => guard.invoke());
    assert.equal(outcome.threw, true);
    assert.equal(Object.is(outcome.value, thrown), true, `${phase}:${String(thrown)}`);
    assert.equal(calls, 0);
    capture(() => guard.invoke());
    const snapshot = guard.snapshot();
    assert.equal(snapshot.firstFailure.code, phase === 'record' ? 'record-R-throw' : 'clock-start-throw');
    assert.equal(Object.is(snapshot.firstFailure.value, thrown), true);
  }
});

test('重复与record内重入均拒绝并永久锁存首错', () => {
  let outerCalls = 0;
  /** @type {any} */ let guard;
  /** @type {any} */ let nested;
  guard = baseline.createSyncCallGuard({
    original() { outerCalls += 1; },
    record() { nested = capture(() => guard.invoke()); },
    now: () => 0n,
  });
  assert.equal(capture(() => guard.invoke()).threw, true);
  assert.equal(nested.threw, true);
  assert.equal(outerCalls, 0);
  assert.equal(guard.snapshot().firstFailure.code, 'attempt-repeated');

  const normal = baseline.createSyncCallGuard({ original() { return 1; }, record() {}, now: () => 0n });
  assert.equal(normal.invoke(), 1);
  for (let index = 0; index < 20; index += 1) assert.equal(capture(() => normal.invoke()).threw, true);
  assert.equal(normal.snapshot().failed, true);
  assert.equal(normal.snapshot().firstFailure.code, 'attempt-repeated');
  assert.equal(normal.snapshot().diagnostics.length, 16);
});

test('任意falsy native throw存在位和引用原样保留，throw记录失败不覆盖', () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const guard = baseline.createSyncCallGuard({
      original() { throw thrown; },
      record(/** @type {any} */ event) { if (event.kind === 'throw') throw { diagnostic: true }; },
      now: () => 0n,
    });
    const outcome = capture(() => guard.invoke());
    assert.equal(outcome.threw, true);
    assert.equal(Object.is(outcome.value, thrown), true);
    const snapshot = guard.snapshot();
    assert.equal(snapshot.nativeOutcome.kind, 'throw');
    assert.equal(Object.is(snapshot.nativeOutcome.value, thrown), true);
    assert.equal(snapshot.firstFailure.code, 'record-throw-throw');
  }
});

test('native throw与记录健康是独立维度，assertHealthy不代表native成功', () => {
  const thrown = { native: true };
  const guard = baseline.createSyncCallGuard({ original() { throw thrown; }, record() {}, now: () => 0n });
  const outcome = capture(() => guard.invoke());
  assert.equal(outcome.value, thrown);
  assert.equal(guard.snapshot().nativeOutcome.kind, 'throw');
  assert.equal(guard.snapshot().failed, false);
  assert.doesNotThrow(() => guard.assertHealthy());
});

test('native返回后S与时钟失败不覆盖原result，5秒边界按bigint判断', () => {
  const result = {};
  const recordFailure = baseline.createSyncCallGuard({
    original() { return result; },
    record(/** @type {any} */ event) { if (event.kind === 'S') return false; },
    now: () => 0n,
  });
  assert.equal(recordFailure.invoke(), result);
  assert.equal(recordFailure.snapshot().firstFailure.code, 'record-S-return');

  let clockCalls = 0;
  const clockFailure = baseline.createSyncCallGuard({
    original() { return result; }, record() {},
    now() { if (clockCalls++ === 1) throw false; return 0n; },
  });
  assert.equal(clockFailure.invoke(), result);
  assert.equal(clockFailure.snapshot().firstFailure.code, 'clock-end-throw');

  for (const [elapsed, failed] of [[5_000_000_000n, false], [5_000_000_001n, true]]) {
    const values = [0n, elapsed];
    const guard = baseline.createSyncCallGuard({ original() { return result; }, record() {}, now: () => values.shift() });
    assert.equal(guard.invoke(), result);
    assert.equal(guard.snapshot().failed, failed);
  }
});

test('runner经同步ESM named binding自然返回并完整恢复三个descriptor', () => {
  const world = createWorld({ nowValues: [10n, 20n] });
  const before = new Map(['spawnSync', 'execFileSync', 'execSync'].map((name) => [name, Object.getOwnPropertyDescriptor(world.cp, name)]));
  const api = loadSource(source, world);
  const report = runFixture(api, world);
  assert.equal(report.ok, true);
  assert.equal(report.originalResult, world.defaultResult);
  assert.equal(report.native.resultIdentity, true);
  assert.equal(report.native.status, 0);
  assert.deepEqual(Array.from(report.protocol), ['R', 'S']);
  assert.equal(report.disabledExportsInstalled, true);
  assert.equal(report.synchronousExportViolation, false);
  assert.equal(world.forbiddenNativeCalls(), 0);
  assert.equal(report.oldCjsReferenceUnchanged, true);
  assert.deepEqual({ ...report.restoration }, { attempted: true, descriptors: true, esmBinding: true });
  assert.equal(world.syncCalls(), 2);
  assert.equal(world.calls.length, 1);
  const call = world.calls[0];
  assert.equal(call.receiver, world.cp);
  assert.equal(call.file, FIXED_NODE);
  assert.deepEqual(Array.from(call.args), ['--version']);
  assert.equal(call.options.cwd, '/');
  assert.deepEqual({ ...call.options.env }, { LANG: 'C', LC_ALL: 'C' });
  assert.equal(call.options.shell, false);
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.maxBuffer, 4096);
  assert.equal(call.options.input, '');
  assert.deepEqual(Array.from(call.options.stdio), ['pipe', 'pipe', 'pipe']);
  assert.equal(Object.hasOwn(call.options, 'timeout'), false);
  assert.equal(Object.hasOwn(call.options, 'killSignal'), false);
  for (const [name, descriptor] of before) assert.deepEqual(Object.getOwnPropertyDescriptor(world.cp, name), descriptor, name);
});

test('result字段仅own-data读取，error自有或继承存在均失败且getter不执行', () => {
  for (const errorValue of [undefined, null, false]) {
    const result = { status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '', error: errorValue };
    const world = createWorld({ result });
    const report = runFixture(loadSource(source, world), world);
    assert.equal(report.ok, false);
    assert.equal(report.native.errorAbsent, false);
  }
  let getterCalls = 0;
  const inherited = Object.create(Object.defineProperty({}, 'error', { get() { getterCalls += 1; return false; } }));
  Object.assign(inherited, { status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '' });
  const inheritedWorld = createWorld({ result: inherited });
  assert.equal(runFixture(loadSource(source, inheritedWorld), inheritedWorld).native.errorAbsent, false);
  const getterResult = { signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '' };
  Object.defineProperty(getterResult, 'status', { enumerable: true, get() { getterCalls += 1; return 0; } });
  const getterWorld = createWorld({ result: getterResult });
  assert.equal(runFixture(loadSource(source, getterWorld), getterWorld).ok, false);
  assert.equal(getterCalls, 0);
  const proxyResult = new Proxy({ status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '' }, { has() { throw false; } });
  const proxyWorld = createWorld({ result: proxyResult });
  const proxyReport = runFixture(loadSource(source, proxyWorld), proxyWorld);
  assert.equal(proxyReport.ok, false);
  assert.equal(proxyReport.failures.includes('result-inspect-failed'), true);
});

test('禁用同步导出违规先锁存；前置违规阻止允许调用，native内违规保留结果但整体失败', () => {
  for (const deniedName of /** @type {const} */ (['execFileSync', 'execSync'])) for (const deniedAt of /** @type {const} */ (['synchronize', 'getBinding', 'startClock', 'native'])) {
    const world = createWorld({ deniedName, deniedAt });
    const report = runFixture(loadSource(source, world), world);
    assert.equal(world.deniedOutcomes.length, 1, `${deniedName}:${deniedAt}`);
    assert.equal(world.deniedOutcomes[0].threw, true);
    const deniedValue = world.deniedOutcomes[0].value;
    assert.equal(
      typeof deniedValue === 'object' && deniedValue !== null && 'code' in deniedValue ? deniedValue.code : undefined,
      'SYNC_EXPORT_REJECTED',
    );
    assert.equal(world.forbiddenNativeCalls(), 0);
    assert.equal(report.synchronousExportViolation, true);
    assert.equal(report.ok, false);
    assert.equal(world.calls.length, deniedAt === 'native' ? 1 : 0);
    if (deniedAt !== 'native') assert.equal(report.protocol.length, 0);
    if (deniedAt === 'native') assert.equal(report.originalResult, world.defaultResult);
  }
});

test('native unknown throw与恢复失败均保留原槽且不冒充资源清理', () => {
  const thrown = { opaque: 'native-secret' };
  const throwWorld = createWorld({ throwPresent: true, throwValue: thrown });
  const throwReport = runFixture(loadSource(source, throwWorld), throwWorld);
  assert.equal(throwReport.ok, false);
  assert.equal(throwReport.originalThrow, thrown);
  assert.equal(throwReport.native.threw, true);
  assert.equal(JSON.stringify(throwReport).includes('native-secret'), false);

  const result = { status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '' };
  const restoreWorld = createWorld({ result, sabotageRestore: true });
  const restoreReport = runFixture(loadSource(source, restoreWorld), restoreWorld);
  assert.equal(restoreReport.ok, false);
  assert.equal(restoreReport.originalResult, result);
  assert.equal(restoreReport.failures.some((/** @type {string} */ code) => code.startsWith('descriptor-restore-failed-')), true);
});

test('严格gate两条拒绝路径零安装零创建，授权VM输出不泄露opaque槽', () => {
  for (const argv of [[], ['--case=spawnSync', AUTHORIZATION], [AUTHORIZATION, '--case=spawnSync', '--case=spawnSync']]) {
    const world = createWorld();
    world.processLike.argv = [FIXED_NODE, '/virtual/not-direct.mjs', ...argv];
    const api = loadSource(source, world);
    api.main();
    assert.equal(world.output.text, 'NOT_AUTHORIZED\n');
    assert.equal(world.calls.length, 0);
    assert.equal(world.syncCalls(), 0);
    assert.equal(world.processLike.exitCode, 64);
  }

  const authorized = createWorld();
  authorized.processLike.argv = [FIXED_NODE, '/virtual/not-direct.mjs', AUTHORIZATION, '--case=spawnSync'];
  loadSource(source, authorized).main();
  const report = JSON.parse(authorized.output.text);
  assert.equal(report.ok, true);
  assert.equal(authorized.processLike.exitCode, 0);
  assert.equal(Object.hasOwn(report, 'originalResult'), false);
  assert.equal(Object.hasOwn(report, 'originalThrow'), false);
  assert.equal(Object.hasOwn(report.native, 'stdout'), false);
  assert.equal(Object.hasOwn(report.native, 'stderr'), false);
});

test('父stdout同步、callback和迟到error持续锁存且不递归写', () => {
  for (const mode of /** @type {const} */ (['sync-throw', 'callback-error'])) {
    const output = new MockOutput(mode);
    const processLike = { exitCode: undefined };
    const channel = baseline.createSafeOutputChannel(output, processLike);
    assert.equal(channel.writeText('x'), false);
    assert.equal(channel.failed(), true);
    assert.equal(processLike.exitCode, 1);
    assert.equal(output.calls, 1);
  }
  const output = new MockOutput('manual');
  const processLike = { exitCode: undefined };
  const channel = baseline.createSafeOutputChannel(output, processLike);
  assert.equal(channel.writeText('x'), true);
  output.callbacks[0]();
  assert.doesNotThrow(() => output.emit('error', new Error('late one')));
  assert.doesNotThrow(() => output.emit('error', new Error('late two')));
  assert.equal(channel.failed(), true);
  assert.equal(processLike.exitCode, 1);
  assert.equal(output.calls, 1);
  assert.equal(output.listenerCount('error'), 1);
});

/**
 * Baseline must pass first. A mutant is loaded successfully outside the caught
 * assertion, then must be killed specifically by a host AssertionError.
 * @param {string} name
 * @param {string} before
 * @param {string} after
 * @param {(api:any)=>void} invariant
 */
function mutationTest(name, before, after, invariant) {
  test(`变异命中：${name}`, () => {
    invariant(loadSource(source, createWorld()));
    const mutated = replaceExact(source, before, after, name);
    const mutantApi = loadSource(mutated, createWorld());
    const outcome = capture(() => invariant(mutantApi));
    assert.equal(outcome.threw, true, `${name}: mutant survived`);
    assert.equal(outcome.value instanceof assert.AssertionError, true, `${name}: must be AssertionError`);
  });
}

mutationTest('跳过R记录', "    writeProtocol('R', 1, true);", "    /* mutant skips R */", (api) => {
  let calls = 0;
  const guard = api.createSyncCallGuard({ original() { calls += 1; }, record() { return false; }, now: () => 0n });
  capture(() => guard.invoke());
  assert.equal(calls, 0);
});

mutationTest('复制原result', '      return result;\n    } catch (error) {', '      return { ...result };\n    } catch (error) {', (api) => {
  const result = { identity: true };
  const guard = api.createSyncCallGuard({ original() { return result; }, record() {}, now: () => 0n });
  assert.equal(guard.invoke(), result);
});

mutationTest('吞掉falsy原throw', "      throw error;\n    }\n  }", "      if (error) throw error;\n      return undefined;\n    }\n  }", (api) => {
  const guard = api.createSyncCallGuard({ original() { throw false; }, record() {}, now: () => 0n });
  const outcome = capture(() => guard.invoke());
  assert.equal(outcome.threw, true);
  assert.equal(outcome.value, false);
});

mutationTest('error按truthiness误判', "      errorAbsent = !Reflect.has(/** @type {object} */ (nativeReturn), 'error');", "      errorAbsent = !Reflect.has(/** @type {object} */ (nativeReturn), 'error') || !nativeReturn.error;", (api) => {
  const world = createWorld({ result: { status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '', error: undefined } });
  assert.equal(runFixture(api, world).native.errorAbsent, false);
});

mutationTest('漏同步ESM安装binding', "    Reflect.apply(synchronize, undefined, []);\n    if (synchronousExportViolation) throw GUARD_REJECTED;\n    const installedBinding", "    /* mutant omits ESM synchronization */\n    if (synchronousExportViolation) throw GUARD_REJECTED;\n    const installedBinding", (api) => {
  const world = createWorld();
  assert.equal(runFixture(api, world).ok, true);
});

mutationTest('不恢复spawnSync descriptor', '        Object.defineProperty(cp, name, descriptor);', "        if (name !== 'spawnSync') Object.defineProperty(cp, name, descriptor);", (api) => {
  const world = createWorld();
  const before = Object.getOwnPropertyDescriptor(world.cp, 'spawnSync');
  runFixture(api, world);
  assert.deepEqual(Object.getOwnPropertyDescriptor(world.cp, 'spawnSync'), before);
});

mutationTest('首错被后错覆盖', '    if (firstFailure === null) firstFailure = Object.freeze({ code, valuePresent, value });', '    firstFailure = Object.freeze({ code, valuePresent, value });', (api) => {
  const guard = api.createSyncCallGuard({ original() {}, record() { throw false; }, now: () => 0n });
  capture(() => guard.invoke());
  capture(() => guard.invoke());
  assert.equal(guard.snapshot().firstFailure.code, 'record-R-throw');
});

mutationTest('S记录失败未锁存', "      writeProtocol('S', 2, false);", "      /* mutant skips S */", (api) => {
  const guard = api.createSyncCallGuard({ original() { return 1; }, record(/** @type {any} */ event) { if (event.kind === 'S') return false; }, now: () => 0n });
  assert.equal(guard.invoke(), 1);
  assert.equal(guard.snapshot().failed, true);
});

mutationTest('工厂预读getter', "  const original = captureOwnDataFunction(dependencies, 'original').value;", '  const original = dependencies.original;', (api) => {
  let reads = 0; const deps = { record() {}, now() { return 0n; } };
  Object.defineProperty(deps, 'original', { get() { reads += 1; return () => {}; } });
  capture(() => api.createSyncCallGuard(deps)); assert.equal(reads, 0);
});
mutationTest('R抛出值被固定拒绝替换', "      if (fatal) throw error;\n      return false;", "      if (fatal) throw GUARD_REJECTED;\n      return false;", (api) => {
  const guard = api.createSyncCallGuard({ original() {}, record() { throw false; }, now: () => 0n });
  assert.equal(capture(() => guard.invoke()).value, false);
});
mutationTest('禁用导出违规未锁存', "    synchronousExportViolation = true;\n    fail(`disabled-export-invoked-${name}`);", '    /* mutant does not latch disabled export use */', (api) => {
  const world = createWorld({ deniedAt: 'native' }); assert.equal(runFixture(api, world).ok, false);
});
mutationTest('error仅查own而漏继承', "      errorAbsent = !Reflect.has(/** @type {object} */ (nativeReturn), 'error');", "      errorAbsent = Object.getOwnPropertyDescriptor(nativeReturn, 'error') === undefined;", (api) => {
  const result = Object.assign(Object.create({ error: undefined }), { status: 0, signal: null, stdout: `${FIXED_VERSION}\n`, stderr: '' });
  const world = createWorld({ result }); assert.equal(runFixture(api, world).native.errorAbsent, false);
});

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
console.log(`ok - ${passed} pm-sdk quiescence sync-entry VM tests`);
