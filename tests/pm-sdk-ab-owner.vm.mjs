// @ts-check
import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, errorMonitor } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, runInNewContext, SourceTextModule, SyntheticModule } from "node:vm";

const TESTS = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(TESTS, "..");
const ENTRY_URL = new URL("./pm-sdk-ab-owner-entry.mjs", import.meta.url);
const HELPER_URL = new URL("./helpers/pm-sdk-ab-owner.mjs", import.meta.url);
const A1_URL = new URL("./helpers/pm-sdk-quiescence-adapter.mjs", import.meta.url);
const SCENE_URL = new URL("./helpers/pm-sdk-private-scene.mjs", import.meta.url);
const ENTRY_SOURCE = readFileSync(ENTRY_URL, "utf8");
const HELPER_SOURCE = readFileSync(HELPER_URL, "utf8");
const A1_SOURCE = readFileSync(A1_URL, "utf8");
const SCENE_SOURCE = readFileSync(SCENE_URL, "utf8");
const FIXTURE_SOURCE = readFileSync(new URL("./fixtures/pm-sdk-ab-owner.fixture.ts", import.meta.url), "utf8");
const PACKAGE_BYTES = readFileSync(new URL("../package.json", import.meta.url));
const NODE = "/opt/homebrew/Cellar/node/26.8.2/bin/node";
const ROOT = "/tmp/pi-s-contract";
const DARWIN_USER_TEXT_ENCODING = "0x1F5:0:0";
const OBSERVED_USER_TEXT_ENCODING = "0x1F5:0x19:0x34";
const CONFIG_BYTES = 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["tests/**/*.test.ts"],\n    environment: "node",\n    pool: "forks",\n    isolate: true,\n    fileParallelism: false,\n    testTimeout: 5_000,\n    setupFiles: ["./tests/helpers/test-environment.ts"],\n  },\n});\n';
const CONFIG_HASH = `sha256:${createHash("sha256").update(CONFIG_BYTES).digest("hex")}`;
const VITEST_TARGET = join(PROJECT, "node_modules/vitest");
const PARENT_BINDING = JSON.stringify({ path: ROOT, dev: "7", ino: "77" });
const UNNAMED_PROJECT_CACHE_HASH = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const NAMED_PROJECT_CACHE_HASH = createHash("sha1").update("named-project").digest("hex");
const BASE_CACHE_DIR = join(ROOT, "cache");
const EXPECTED_CACHE_DIR = join(BASE_CACHE_DIR, "vitest", UNNAMED_PROJECT_CACHE_HASH);
const VITEST_CLI_SOURCE = readFileSync(new URL("../node_modules/vitest/dist/chunks/cli-api.B5majYba.js", import.meta.url), "utf8");

/**
 * Extracts one reviewed installed-source region. Both anchors must occur once.
 * @param {string} source @param {string} start @param {string} end
 */
function uniqueInstalledSlice(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1);
  assert.equal(source.indexOf(start, startIndex + start.length), -1);
  assert.notEqual(endIndex, -1);
  assert.equal(source.indexOf(end, endIndex + end.length), -1);
  return source.slice(startIndex, endIndex);
}

const cacheMethodStart = "\tstatic resolveCacheDir(root, dir, projectName) {";
const cacheMethodEnd = "\n\t}\n}\n\nconst debugFs";
const cacheMethodSource = `${uniqueInstalledSlice(VITEST_CLI_SOURCE, cacheMethodStart, cacheMethodEnd)}\n\t}`;
const optimizerSource = uniqueInstalledSlice(
  VITEST_CLI_SOURCE,
  "function VitestOptimizer() {",
  "\n\nfunction resolveOptimizerConfig(",
);
const optimizerSnippet = `class VitestCache {\n${cacheMethodSource}\n}\n\n${optimizerSource}\nVitestOptimizer;`;
const INSTALLED_VITEST_OPTIMIZER = /** @type {() => {config:{handler:(config:any)=>void}}} */ (runInNewContext(
  optimizerSnippet,
  Object.freeze({
    resolve: path.posix.resolve,
    slash: (/** @type {string} */ value) => value.replaceAll("\\", "/"),
    hash: (/** @type {string} */ algorithm, /** @type {string} */ data, /** @type {import("node:crypto").BinaryToTextEncoding} */ encoding) =>
      createHash(algorithm).update(data).digest(encoding),
  }),
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
));
assert.equal(typeof INSTALLED_VITEST_OPTIMIZER, "function");

/** @param {() => unknown} operation */
function capture(operation) {
  try { return { threw: false, value: operation() }; }
  catch (error) { return { threw: true, value: error }; }
}

class FakeClock {
  constructor() {
    this.next = 1;
    this.now = 0;
    /** @type {Map<number, {callback: () => void, due: number}>} */ this.timeouts = new Map();
    /** @type {Map<number, {callback: () => void, delay: number}>} */ this.intervals = new Map();
  }
  /** @param {() => void} callback @param {number} [delay] */
  setTimeout = (callback, delay = 0) => {
    const id = this.next++;
    this.timeouts.set(id, { callback, due: this.now + delay });
    return id;
  };
  /** @param {number} id */
  clearTimeout = (id) => { this.timeouts.delete(id); };
  /** @param {() => void} callback @param {number} [delay] */
  setInterval = (callback, delay = 0) => {
    const id = this.next++;
    this.intervals.set(id, { callback, delay });
    return id;
  };
  /** @param {number} id */
  clearInterval = (id) => { this.intervals.delete(id); };
  /** @param {number} milliseconds */
  advance(milliseconds) {
    const target = this.now + milliseconds;
    for (;;) {
      const due = [...this.timeouts.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timeouts.delete(id);
      this.now = timer.due;
      timer.callback();
    }
    this.now = target;
  }
}

class FakeStream extends EventEmitter {
  constructor() { super(); this.closed = false; }
  /** @param {string | Uint8Array} value */
  write(value) { this.emit("written", value); return true; }
  /** @param {string | symbol} event @param {...unknown} args */
  emit(event, ...args) {
    if (event === "close") this.closed = true;
    return super.emit(event, ...args);
  }
}

class FakeInput extends FakeStream {
  /** @param {Uint8Array} bytes */
  end(bytes) { this.emit("written", Buffer.from(bytes)); }
  pause() {}
}

class FakeProcess extends EventEmitter {
  /** @param {{env?:Record<string,string>, argv?:string[], execArgv?:string[], connected?:boolean}} [options] */
  constructor(options = {}) {
    super();
    this.env = { ...(options.env ?? {}) };
    this.argv = options.argv ?? [NODE, "/virtual/not-direct.mjs"];
    this.execArgv = options.execArgv ?? [];
    this.execPath = NODE;
    this.version = "v26.8.2";
    this.platform = "darwin";
    this.pid = 8123;
    this.connected = options.connected ?? false;
    /** @type {number | undefined} */ this.exitCode = undefined;
    this.stdin = new FakeInput();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    /** @type {Array<{pid:number, signal:unknown}>} */ this.selfSignals = [];
    /** @type {(pid: number, signal?: unknown, ...extra: unknown[]) => unknown} */
    this.kill = (pid, signal) => { this.selfSignals.push({ pid, signal }); return true; };
  }
  getuid = () => 501;
  cwd = () => PROJECT;
}

/** @typedef {{kind:"directory", mode:bigint, uid:bigint, dev:bigint, ino:bigint} | {kind:"file", mode:bigint, uid:bigint, dev:bigint, ino:bigint, bytes:Buffer} | {kind:"symlink", mode:bigint, uid:bigint, dev:bigint, ino:bigint, target:string}} MemoryEntry */
/** @typedef {"before-allocation" | "attempt-no-path" | "path-no-identity"} SceneFailureMode */
class SceneMemoryFs {
  /** @param {SceneFailureMode | undefined} failureMode */
  constructor(failureMode) {
    /** @type {Map<string, MemoryEntry>} */ this.entries = new Map();
    this.nextIno = 100n;
    this.failureMode = failureMode;
    /** @type {string | undefined} */ this.failedIdentityPath = undefined;
    this.addDirectory("/", 0o755n, 0n, 1n);
    this.addDirectory("/tmp", 0o1777n, 0n, 2n);
    this.addDirectory(PROJECT, 0o755n, 501n, 7n);
    this.addDirectory(join(PROJECT, "node_modules"), 0o755n, 501n, 7n);
    this.addDirectory(VITEST_TARGET, 0o755n, 501n, 7n);
    this.addDirectory(ROOT, 0o700n, 501n, 7n, 77n);
    this.addFile(join(ROOT, "vitest.config.ts"), Buffer.from(CONFIG_BYTES), 0o600n, 501n, 7n);
    this.addFile(join(PROJECT, "vitest.config.ts"), Buffer.from(CONFIG_BYTES), 0o644n, 501n, 7n);
    this.addFile(join(PROJECT, "package.json"), failureMode === "before-allocation" ? Buffer.from("{") : PACKAGE_BYTES, 0o644n, 501n, 7n);
    this.addFile(fileURLToPath(ENTRY_URL), Buffer.from(ENTRY_SOURCE), 0o644n, 501n, 7n);
    this.addFile(fileURLToPath(HELPER_URL), Buffer.from(HELPER_SOURCE), 0o644n, 501n, 7n);
    this.addFile(join(PROJECT, "tests/fixtures/pm-sdk-ab-owner.fixture.ts"), Buffer.from(FIXTURE_SOURCE), 0o644n, 501n, 7n);
  }
  /** @param {string} target @param {bigint} mode @param {bigint} uid @param {bigint} dev @param {bigint} [ino] */
  addDirectory(target, mode = 0o700n, uid = 501n, dev = 3n, ino = this.nextIno++) {
    this.entries.set(path.normalize(target), { kind: "directory", mode, uid, dev, ino });
  }
  /** @param {string} target @param {Uint8Array} bytes @param {bigint} mode @param {bigint} uid @param {bigint} dev */
  addFile(target, bytes, mode = 0o600n, uid = 501n, dev = 3n) {
    this.entries.set(path.normalize(target), { kind: "file", mode, uid, dev, ino: this.nextIno++, bytes: Buffer.from(bytes) });
  }
  /** @param {string} target @param {string} destination @param {bigint} [dev] */
  addSymlink(target, destination, dev = 3n) {
    this.entries.set(path.normalize(target), { kind: "symlink", mode: 0o777n, uid: 501n, dev, ino: this.nextIno++, target: path.normalize(destination) });
  }
  /** @param {string} target */
  entry(target) {
    const value = this.entries.get(path.normalize(target));
    if (!value) throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
    return value;
  }
  /** @param {string} target @param {{bigint?:boolean}} [options] */
  lstat = async (target, options = {}) => {
    if (path.normalize(target) === this.failedIdentityPath) throw Object.freeze({ sceneFsFailure: "root-identity" });
    const value = this.entry(target);
    const numeric = (/** @type {bigint} */ number) => options.bigint ? number : Number(number);
    return {
      mode: numeric(value.mode), uid: numeric(value.uid), dev: numeric(value.dev), ino: numeric(value.ino),
      size: numeric(value.kind === "file" ? BigInt(value.bytes.length) : 0n),
      isDirectory: () => value.kind === "directory", isFile: () => value.kind === "file", isSymbolicLink: () => value.kind === "symlink",
    };
  };
  /** @param {string} target */
  realpath = async (target) => {
    let current = path.normalize(target);
    const seen = new Set();
    for (;;) {
      if (seen.has(current)) throw new Error("ELOOP");
      seen.add(current);
      const value = this.entry(current);
      if (value.kind !== "symlink") return current;
      current = value.target;
    }
  };
  /** @param {string} target */
  readFile = async (target) => {
    const value = this.entry(target);
    if (value.kind !== "file") throw new Error("not a file");
    return Buffer.from(value.bytes);
  };
  /** @param {string} prefix */
  mkdtemp = async (prefix) => {
    if (this.failureMode === "attempt-no-path") throw Object.freeze({ sceneFsFailure: "mkdtemp" });
    const target = `${prefix}memory01`;
    this.addDirectory(target, 0o755n, 501n, 3n);
    if (this.failureMode === "path-no-identity") this.failedIdentityPath = path.normalize(target);
    return target;
  };
  /** @param {string} target @param {number} mode */
  chmod = async (target, mode) => { this.entry(target).mode = BigInt(mode); };
  /** @param {string} target @param {{mode?:number}} [options] */
  mkdir = async (target, options = {}) => {
    if (this.entries.has(path.normalize(target))) throw new Error("EEXIST");
    const parent = this.entry(dirname(target));
    if (parent.kind !== "directory") throw new Error("ENOTDIR");
    this.addDirectory(target, BigInt(options.mode ?? 0o777), 501n, parent.dev);
  };
  /** @param {string} target @param {Uint8Array} bytes @param {{flag?:string, mode?:number}} options */
  writeFile = async (target, bytes, options) => {
    if (options.flag !== "wx" || this.entries.has(path.normalize(target))) throw new Error("EEXIST");
    const parent = this.entry(dirname(target));
    if (parent.kind !== "directory") throw new Error("ENOTDIR");
    this.addFile(target, bytes, BigInt(options.mode ?? 0o666), 501n, parent.dev);
  };
  /** @param {string} destination @param {string} target @param {string} type */
  symlink = async (destination, target, type) => {
    assert.equal(type, "dir");
    const parent = this.entry(dirname(target));
    if (parent.kind !== "directory") throw new Error("ENOTDIR");
    this.addSymlink(target, destination, parent.dev);
  };
  /** @param {string} target */
  readlink = async (target) => {
    const value = this.entry(target);
    if (value.kind !== "symlink") throw new Error("EINVAL");
    return value.target;
  };
}

/** @typedef {{failOnChildEvent?:string|symbol, failOnChildEventAt?:number, failOnStreamEvent?:string|symbol, shortWrite?:boolean, nativeKillResult?:unknown, nativeKillThrow?:unknown, onInputEnd?:(child:any, bytes:Buffer)=>void}} ChildBehavior */
/** @param {FakeProcess} processLike @param {FakeClock} clock @param {ChildBehavior} behavior */
function childProcessWorld(processLike, clock, behavior) {
  /** @type {any[]} */ const children = [];
  /** @type {any[]} */ const forks = [];
  /** @type {any[]} */ const nativeCalls = [];
  /** @type {unknown[]} */ const killSignals = [];
  /** @type {Map<string | symbol, number>} */ const childEventCounts = new Map();
  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new FakeInput();
      this.stdin.on("written", (bytes) => behavior.onInputEnd?.(this, bytes));
      this.stdout = new FakeStream();
      this.stderr = new FakeStream();
      this.control = new FakeStream();
      /** @type {Array<FakeStream | null>} */ this.stdio = [this.stdin, this.stdout, this.stderr, this.control];
      this.channel = undefined;
      this.connected = false;
    }
    /** @param {string | symbol} event @param {(...args:any[])=>void} listener */
    on(event, listener) {
      const count = (childEventCounts.get(event) ?? 0) + 1;
      childEventCounts.set(event, count);
      if (event === behavior.failOnChildEvent && count === (behavior.failOnChildEventAt ?? 1)) {
        throw new Error("child listener installation failed");
      }
      return super.on(event, listener);
    }
    /** @param {any} normalized */
    spawn(normalized) {
      nativeCalls.push({ receiver: this, normalized });
      if (normalized.stdio[3] === "ipc") {
        normalized.envPairs.push("NODE_CHANNEL_FD=3", "NODE_CHANNEL_SERIALIZATION_MODE=advanced");
        this.stdio[3] = null;
        this.channel = {};
        this.connected = true;
      }
      Object.defineProperty(this, "pid", { value: 9000 + nativeCalls.length, configurable: true });
      return 0;
    }
    /** @param {unknown} signal */
    kill(signal) {
      killSignals.push(signal);
      if (behavior.nativeKillThrow !== undefined) throw behavior.nativeKillThrow;
      return behavior.nativeKillResult ?? true;
    }
  }
  const originalStreamOn = FakeStream.prototype.on;
  /** @param {string} file @param {string[]} args @param {any} options @param {boolean} ipc */
  function spawnNormalized(file, args, options, ipc) {
    const child = new ChildProcess();
    if (behavior.failOnStreamEvent !== undefined) {
      child.stdout.on = function (event, listener) {
        if (event === behavior.failOnStreamEvent) throw new Error("stream listener installation failed");
        return Reflect.apply(originalStreamOn, this, [event, listener]);
      };
    }
    children.push(child);
    const normalized = {
      file,
      args: [file, ...args],
      envPairs: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
      stdio: ipc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe", "pipe"],
      cwd: options.cwd,
      detached: options.detached ?? false,
      uid: undefined,
      gid: undefined,
      shell: false,
    };
    child.spawn(normalized);
    return child;
  }
  const cp = {
    ChildProcess,
    /** @param {string} file @param {string[]} args @param {any} options */
    spawn(file, args, options) { return spawnNormalized(file, args, options, false); },
    /** @param {string} file @param {string[]} args @param {any} options */
    fork(file, args, options) {
      forks.push({ file, args, options });
      return spawnNormalized(processLike.execPath, [...options.execArgv, file], { env: options.env, detached: false }, true);
    },
    spawnSync() {}, execSync() {}, execFileSync() {},
  };
  return { cp, children, forks, nativeCalls, killSignals, clock };
}

/** @param {import("node:vm").Context} context @param {string} identifier @param {Record<string, unknown>} values */
async function synthetic(context, identifier, values) {
  const names = Object.keys(values);
  const module = new SyntheticModule(names, function initialize() {
    for (const name of names) this.setExport(name, values[name]);
  }, { context, identifier });
  await module.link(() => { throw new Error(`unexpected dependency from ${identifier}`); });
  await module.evaluate();
  return module;
}

/** @typedef {{process?:FakeProcess, helperSource?:string, childBehavior?:ChildBehavior, writeSync?:(fd:number, frame:Uint8Array)=>number}} HelperOptions */
/** @param {HelperOptions} [options] */
async function createHelperWorld(options = {}) {
  const processLike = options.process ?? new FakeProcess();
  const clock = new FakeClock();
  const child = childProcessWorld(processLike, clock, options.childBehavior ?? {});
  const threads = { Worker: class Worker {} };
  const context = createContext({
    process: processLike, Buffer, URL, console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  });
  const cpModule = await synthetic(context, "node:child_process", {
    default: child.cp, ChildProcess: child.cp.ChildProcess, fork: child.cp.fork,
    spawnSync: child.cp.spawnSync, execSync: child.cp.execSync, execFileSync: child.cp.execFileSync,
  });
  const threadModule = await synthetic(context, "node:worker_threads", { default: threads, Worker: threads.Worker });
  const moduleModule = await synthetic(context, "node:module", {
    syncBuiltinESMExports() {
      cpModule.setExport("ChildProcess", child.cp.ChildProcess);
      cpModule.setExport("fork", child.cp.fork);
      cpModule.setExport("spawnSync", child.cp.spawnSync);
      cpModule.setExport("execSync", child.cp.execSync);
      cpModule.setExport("execFileSync", child.cp.execFileSync);
      threadModule.setExport("Worker", threads.Worker);
    },
  });
  const eventsModule = await synthetic(context, "node:events", { errorMonitor });
  const helperPathModule = await synthetic(context, "node:path", { resolve: path.resolve });
  const helperUrlModule = await synthetic(context, "node:url", { fileURLToPath, pathToFileURL });
  /** @type {Uint8Array[]} */ const writes = [];
  const fsModule = await synthetic(context, "node:fs", {
    /** @param {number} fd @param {Uint8Array} frame */
    writeSync(fd, frame) {
      const copy = Buffer.from(frame);
      writes.push(copy);
      return options.writeSync ? options.writeSync(fd, copy) : copy.length;
    },
  });
  const a1 = new SourceTextModule(A1_SOURCE, { context, identifier: A1_URL.href });
  await a1.link(() => { throw new Error("A1 has no dependencies"); });
  await a1.evaluate();
  /** @param {string} identifier */
  async function loadHelper(identifier = HELPER_URL.href) {
    const helper = new SourceTextModule(options.helperSource ?? HELPER_SOURCE, {
      context, identifier,
      initializeImportMeta(meta) { meta.url = HELPER_URL.href; },
    });
    await helper.link((specifier) => {
      if (specifier === "node:child_process") return cpModule;
      if (specifier === "node:worker_threads") return threadModule;
      if (specifier === "node:module") return moduleModule;
      if (specifier === "node:events") return eventsModule;
      if (specifier === "node:fs") return fsModule;
      if (specifier === "node:path") return helperPathModule;
      if (specifier === "node:url") return helperUrlModule;
      if (specifier === "./pm-sdk-quiescence-adapter.mjs") return a1;
      throw new Error(`unexpected helper dependency: ${specifier}`);
    });
    await helper.evaluate();
    return helper;
  }
  return { process: processLike, clock, child, threads, context, loadHelper, writes };
}

/** @param {any} helper @param {string} nonce */
function validFrames(helper, nonce) {
  const latch = helper.createFailureLatch();
  const owner = {};
  const stream = {};
  const reader = helper.createControlReader(owner, stream, nonce, latch);
  const kinds = ["ready", "reserve", "bound", "business-pass", "b-ended", "final"];
  const text = kinds.map((kind, index) => JSON.stringify({ v: 1, n: nonce, s: index + 1, k: kind }) + "\n").join("");
  reader.accept(owner, stream, Buffer.from(text));
  reader.end(owner, stream);
  return { latch, reader, owner, stream };
}

function oEnvironment() {
  return { LANG: "C", LC_ALL: "C", __CF_USER_TEXT_ENCODING: DARWIN_USER_TEXT_ENCODING };
}

function aEnvironment() {
  return {
    HOME: `${ROOT}/home`, PI_CODING_AGENT_DIR: `${ROOT}/home/.pi/agent`,
    XDG_CONFIG_HOME: `${ROOT}/home/.config`, XDG_CACHE_HOME: `${ROOT}/home/.cache`,
    TMPDIR: `${ROOT}/tmp`, PI_COMPANY_TEST_PARENT_BINDING: PARENT_BINDING,
    NODE_ENV: "test", LANG: "C", LC_ALL: "C", __CF_USER_TEXT_ENCODING: DARWIN_USER_TEXT_ENCODING,
  };
}

/** @typedef {{unsafeConfig?:boolean, specs?:"one"|"empty"|"many"|"wrong", stop?:"before"|"after", earlyPatch?:(config:any)=>void, resolvedPatch?:(config:any)=>void, forkPatch?:(request:{file:string,args:string[],options:any})=>void, specProject?:"wrong", specPool?:string, duplicateStart?:boolean, testName?:string, testCount?:number, testState?:string, moduleState?:string, reason?:string, runErrors?:unknown[], unhandled?:unknown[], hang?:boolean, lateWorkerError?:boolean, startThrow?:unknown, controlWriteSync?:(fd:number, frame:Uint8Array)=>number, bCf?:string, childBehavior?:ChildBehavior, sceneFailure?:SceneFailureMode, guardInstallFailure?:unknown}} StartBehavior */
/** @param {StartBehavior} behavior @param {any} cp @param {FakeProcess} processLike */
function createStartVitest(behavior, cp, processLike) {
  /** @type {any[]} */ const effects = [];
  /** @type {any} */ let worker;
  let returned = false;
  let entered = false;
  /** @type {string | undefined} */ let inputCacheDir;
  /** @type {string | undefined} */ let earlyCacheDir;
  /** @type {string | undefined} */ let resolvedCacheDir;
  /** @type {(() => void) | undefined} */ let releaseHang;
  /** @param {string} _mode @param {string[]} _filters @param {any} options @param {any} viteOptions */
  async function startVitest(_mode, _filters, options, viteOptions) {
    entered = true;
    if (Object.hasOwn(behavior, "startThrow")) throw behavior.startThrow;
    const reporter = options.reporters[0];
    const plugin = viteOptions.plugins[0];
    assert.equal(viteOptions.root, PROJECT);
    inputCacheDir = viteOptions.cacheDir;
    const early = {
      root: viteOptions.root, cacheDir: viteOptions.cacheDir,
      envDir: behavior.unsafeConfig ? ROOT : false,
      publicDir: false, server: viteOptions.server,
      configFile: options.config, plugins: [plugin],
    };
    INSTALLED_VITEST_OPTIMIZER().config.handler(early);
    earlyCacheDir = early.cacheDir;
    behavior.earlyPatch?.(early);
    plugin.config.handler(early);
    effects.push("early-config-approved");
    const resolved = {
      ...early, envDir: false, publicDir: "",
      _vitest: {
        include: ["tests/fixtures/pm-sdk-ab-owner.fixture.ts"], run: true, watch: false,
        maxWorkers: 1, ui: false, api: { middlewareMode: true }, coverage: { enabled: false },
        typecheck: { enabled: false }, pool: "forks", isolate: true, fileParallelism: false,
        environment: "node", testTimeout: 5000, projects: [],
      },
    };
    behavior.resolvedPatch?.(resolved);
    resolvedCacheDir = resolved.cacheDir;
    plugin.configResolved.handler(resolved);
    effects.push("resolved-config-approved");
    const project = { vite: { config: { isProduction: false, ssr: { resolve: { conditions: ["node", "module", "development"] } } } } };
    const ctx = { getRootProject: () => project, state: { getUnhandledErrors: () => behavior.unhandled ?? [] } };
    reporter.onInit(ctx);
    Object.assign(processLike.env, {
      TEST: "true", VITEST: "true", PROD: "", DEV: "1", BASE_URL: "/", MODE: "test",
    });
    const good = {
      moduleId: join(PROJECT, "tests/fixtures/pm-sdk-ab-owner.fixture.ts"),
      project: behavior.specProject === "wrong" ? {} : project,
      pool: behavior.specPool ?? "forks",
    };
    const specs = behavior.specs === "empty" ? [] : behavior.specs === "many" ? [good, good] : behavior.specs === "wrong" ? [{ ...good, moduleId: "/wrong.ts" }] : [good];
    const stateDescriptor = Object.getOwnPropertyDescriptor(processLike, Symbol.for("pi.test.pm-sdk-ab-owner.v1"));
    const state = stateDescriptor && "value" in stateDescriptor && typeof stateDescriptor.value === "function" ? stateDescriptor.value() : null;
    effects.push(`reporter-input:${JSON.stringify({ state, specCount: specs.length, moduleId: specs[0]?.moduleId,
      fixture: join(PROJECT, "tests/fixtures/pm-sdk-ab-owner.fixture.ts"), sameProject: specs[0]?.project === ctx.getRootProject(), pool: specs[0]?.pool,
      envKeys: Object.keys(processLike.env).sort() })}`);
    reporter.onTestRunStart(specs);
    if (behavior.duplicateStart) reporter.onTestRunStart(specs);
    effects.push("reporter-start-approved");
    const expectedArgs = ["--experimental-import-meta-resolve", "--require", join(VITEST_TARGET, "suppress-warnings.cjs"),
      "--conditions", "node", "--conditions", "module", "--conditions", "development", "--import", options.execArgv[1]];
    const forkRequest = {
      file: join(VITEST_TARGET, "dist/workers/forks.js"), args: [],
      options: {
        stdio: "pipe", serialization: "advanced", execArgv: expectedArgs,
        env: { ...aEnvironment(), TEST: "true", VITEST: "true", VITEST_MODE: "RUN", FORCE_TTY: "",
          PROD: "", DEV: "1", BASE_URL: "/", MODE: "test", PI_PM_AB_ROLE: "B", PI_PM_AB_PRELOAD: options.execArgv[1],
          ...(behavior.bCf === undefined ? {} : { __CF_USER_TEXT_ENCODING: behavior.bCf }) },
      },
    };
    behavior.forkPatch?.(forkRequest);
    worker = cp.fork(forkRequest.file, forkRequest.args, forkRequest.options);
    if (behavior.hang) await new Promise((resolveHang) => { releaseHang = () => resolveHang(undefined); });
    const stop = () => {
      effects.push(`stop:${returned ? "after-return" : "inside-close"}`);
      worker.kill();
    };
    if (behavior.stop === "before") stop();
    const testCount = behavior.testCount ?? 1;
    const tests = Array.from({ length: testCount }, () => ({
      name: behavior.testName ?? "pm sdk ab owner mechanism",
      result: () => ({ state: behavior.testState ?? "passed" }),
    }));
    const module = {
      moduleId: join(PROJECT, "tests/fixtures/pm-sdk-ab-owner.fixture.ts"), project,
      state: () => behavior.moduleState ?? "passed", children: { allTests: () => tests },
    };
    reporter.onTestRunEnd([module], behavior.runErrors ?? [], behavior.reason ?? "passed");
    if (behavior.stop !== "before") stop();
    for (const stream of worker.stdio.slice(0, 3)) stream.emit("close");
    worker.emit("disconnect");
    worker.connected = false;
    worker.emit("exit", null, "SIGTERM");
    worker.emit("close");
    if (behavior.lateWorkerError) worker.emit("error", new Error("late worker error"));
    returned = true;
  }
  return {
    startVitest, effects, worker: () => worker, entered: () => entered,
    cacheDirs: () => Object.freeze({ input: inputCacheDir, early: earlyCacheDir, resolved: resolvedCacheDir }),
    release() { const release = releaseHang; releaseHang = undefined; release?.(); },
  };
}

/** @param {StartBehavior} [behavior] @param {string} [entrySource] */
async function createEntryWorld(behavior = {}, entrySource = ENTRY_SOURCE) {
  const processLike = new FakeProcess({
    env: aEnvironment(), argv: [NODE, "/virtual/not-direct.mjs", "--internal-pm-sdk-ab-owner-A", "0123456789abcdef0123456789abcdef"],
  });
  const helperWorld = await createHelperWorld({ process: processLike, childBehavior: behavior.childBehavior, writeSync: behavior.controlWriteSync });
  const helperModule = await helperWorld.loadHelper();
  const start = createStartVitest(behavior, helperWorld.child.cp, processLike);
  const context = helperWorld.context;
  const memoryFs = new SceneMemoryFs(behavior.sceneFailure);
  const cryptoModule = await synthetic(context, "node:crypto", { createHash, randomBytes: () => Buffer.alloc(16, 1) });
  let fd3Closed = false;
  const fsModule = await synthetic(context, "node:fs", {
    /** @param {number} fd */
    closeSync(fd) { assert.equal(fd, 3); fd3Closed = true; },
    /** @param {number} fd */
    fstatSync(fd) { assert.ok(fd === 0 || fd === 3); return { isSocket: () => true }; },
  });
  const fsPromises = await synthetic(context, "node:fs/promises", {
    chmod: memoryFs.chmod, lstat: memoryFs.lstat, mkdir: memoryFs.mkdir, mkdtemp: memoryFs.mkdtemp,
    readFile: memoryFs.readFile, readlink: memoryFs.readlink, realpath: memoryFs.realpath,
    symlink: memoryFs.symlink, writeFile: memoryFs.writeFile,
  });
  const pathModule = await synthetic(context, "node:path", path);
  const urlModule = await synthetic(context, "node:url", { fileURLToPath, pathToFileURL });
  const actualScene = new SourceTextModule(SCENE_SOURCE, {
    context, identifier: `${SCENE_URL.href}?actual`,
    initializeImportMeta(meta) { meta.url = SCENE_URL.href; },
  });
  await actualScene.link((specifier) => {
    if (specifier === "node:crypto") return cryptoModule;
    if (specifier === "node:fs/promises") return fsPromises;
    if (specifier === "node:path") return pathModule;
    if (specifier === "node:url") return urlModule;
    throw new Error(`unexpected scene dependency: ${specifier}`);
  });
  await actualScene.evaluate();
  const actualSceneNamespace = /** @type {any} */ (actualScene.namespace);
  let sceneCalls = 0;
  /** @type {object | undefined} */ let originalScene;
  /** @type {unknown} */ let originalSceneFailure;
  const sceneModule = await synthetic(context, SCENE_URL.href, {
    async createSdkTestScene() {
      sceneCalls += 1;
      try {
        originalScene = await actualSceneNamespace.createSdkTestScene();
        return originalScene;
      } catch (error) {
        originalSceneFailure = error;
        throw error;
      }
    },
    sdkTestSceneFailureReceipt(/** @type {unknown} */ value) { return actualSceneNamespace.sdkTestSceneFailureReceipt(value); },
    sdkTestSceneReceipt(/** @type {unknown} */ value) { return actualSceneNamespace.sdkTestSceneReceipt(value); },
  });
  const entryHelperModule = Object.hasOwn(behavior, "guardInstallFailure")
    ? await synthetic(context, `${HELPER_URL.href}?entry-guard-failure`, {
      FIXTURE: /** @type {any} */ (helperModule.namespace).FIXTURE,
      TEST_NAME: /** @type {any} */ (helperModule.namespace).TEST_NAME,
      PRELOAD_URL: /** @type {any} */ (helperModule.namespace).PRELOAD_URL,
      rejection: /** @type {any} */ (helperModule.namespace).rejection,
      createFailureLatch: /** @type {any} */ (helperModule.namespace).createFailureLatch,
      createControlWriter: /** @type {any} */ (helperModule.namespace).createControlWriter,
      createControlReader: /** @type {any} */ (helperModule.namespace).createControlReader,
      installProcessGuard() { throw behavior.guardInstallFailure; },
      assertEnvironment: /** @type {any} */ (helperModule.namespace).assertEnvironment,
    })
    : helperModule;
  const vitestModule = await synthetic(context, "vitest/node", { startVitest: start.startVitest });
  const entry = new SourceTextModule(entrySource, {
    context, identifier: ENTRY_URL.href,
    initializeImportMeta(meta) { meta.url = ENTRY_URL.href; },
    importModuleDynamically(specifier) {
      if (specifier === "vitest/node") return vitestModule;
      throw new Error(`unexpected dynamic import: ${specifier}`);
    },
  });
  await entry.link((specifier) => {
    if (specifier === "node:crypto") return cryptoModule;
    if (specifier === "node:fs") return fsModule;
    if (specifier === "node:fs/promises") return fsPromises;
    if (specifier === "node:path") return pathModule;
    if (specifier === "node:url") return urlModule;
    if (specifier === "./helpers/pm-sdk-private-scene.mjs") return sceneModule;
    if (specifier === "./helpers/pm-sdk-ab-owner.mjs") return entryHelperModule;
    throw new Error(`unexpected entry dependency: ${specifier}`);
  });
  await entry.evaluate();
  async function beginA() {
    const promise = /** @type {Promise<unknown>} */ (/** @type {any} */ (entry.namespace).main());
    await Promise.resolve();
    return { promise };
  }
  /** @param {Buffer[]} [chunks] @param {boolean} [end] */
  async function runA(chunks = [Buffer.from(JSON.stringify({
    v: 1, nonce: "0123456789abcdef0123456789abcdef", root: ROOT,
    parentBinding: PARENT_BINDING, configHash: CONFIG_HASH, vitestTarget: VITEST_TARGET,
  }))], end = true) {
    const pending = await beginA();
    for (const chunk of chunks) processLike.stdin.emit("data", chunk);
    if (end) processLike.stdin.emit("end");
    return await pending.promise;
  }
  return {
    entry: /** @type {any} */ (entry.namespace), helper: /** @type {any} */ (helperModule.namespace), helperWorld,
    process: processLike, start, beginA, runA, memoryFs, sceneCalls: () => sceneCalls,
    sceneHandle: () => originalScene, sceneFailure: () => originalSceneFailure,
    sceneReceipt: (/** @type {unknown} */ value) => actualSceneNamespace.sdkTestSceneReceipt(value),
    sceneFailureReceipt: (/** @type {unknown} */ value) => actualSceneNamespace.sdkTestSceneFailureReceipt(value),
    fd3Closed: () => fd3Closed,
  };
}

/** @param {string} nonce */
function controlFrames(nonce) {
  return ["ready", "reserve", "bound", "business-pass", "b-ended", "final"]
    .map((kind, index) => JSON.stringify({ v: 1, n: nonce, s: index + 1, k: kind }) + "\n").join("");
}

/** @typedef {{chunks?:number[], eof?:boolean, closeControl?:boolean, closeDataStreams?:boolean, outputBytes?:number, extraOutputByte?:boolean, nonBufferOutput?:unknown, outputError?:boolean, ownerOutputThrow?:unknown, exitCode?:number|null, signal?:string|null, controlPrefix?:number, failure?:{phase:string, code:string}, controlSuffix?:Buffer, advanceWaitTimeout?:boolean, corruptRootConfig?:boolean}} OuterCompletion */
/** @param {any} child @param {Buffer} reportBytes @param {OuterCompletion} [options] */
function completeOuterChild(child, reportBytes, options = {}) {
  let offset = 0;
  for (const length of options.chunks ?? [reportBytes.length]) {
    child.control.emit("data", reportBytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset < reportBytes.length) child.control.emit("data", reportBytes.subarray(offset));
  if (options.outputBytes) child.stdout.emit("data", Buffer.alloc(options.outputBytes));
  if (options.extraOutputByte) child.stderr.emit("data", Buffer.alloc(1));
  if (Object.hasOwn(options, "nonBufferOutput")) child.stdout.emit("data", options.nonBufferOutput);
  if (options.outputError) child.stdout.emit("error", new Error("stdout failed"));
  if (options.eof !== false) child.control.emit("end");
  if (options.closeDataStreams !== false) {
    child.stdin.emit("close"); child.stdout.emit("close"); child.stderr.emit("close");
  }
  if (options.closeControl !== false) child.control.emit("close");
  child.emit("exit", Object.hasOwn(options, "exitCode") ? options.exitCode : 0,
    Object.hasOwn(options, "signal") ? options.signal : null);
  child.emit("close");
}

async function createOuterReportEndpoint() {
  const reportProcess = new FakeProcess();
  const reportWorld = await createHelperWorld({ process: reportProcess });
  const reportHelper = /** @type {any} */ ((await reportWorld.loadHelper()).namespace);
  let reports = 0;
  return {
    reportWorld,
    /** @param {any} child @param {Buffer} handshake @param {OuterCompletion} completion */
    send(child, handshake, completion) {
      const parsed = JSON.parse(handshake.toString("utf8"));
      const latch = reportHelper.createFailureLatch();
      const writer = reportHelper.createControlWriter(parsed.nonce, latch);
      const start = reportWorld.writes.length;
      const kinds = ["ready", "reserve", "bound", "business-pass", "b-ended", "final"];
      for (const kind of kinds.slice(0, completion.controlPrefix ?? kinds.length)) writer.send(kind);
      if (completion.failure) {
        latch.fail(completion.failure.code);
        assert.equal(writer.sendFailureOnce(completion.failure.phase, completion.failure.code), true);
      }
      if (!completion.failure) assert.equal(latch.snapshot().failed, false);
      const frames = reportWorld.writes.slice(start);
      reports += 1;
      completeOuterChild(child, Buffer.concat(completion.controlSuffix ? [...frames, completion.controlSuffix] : frames), completion);
    },
    reports: () => reports,
  };
}

/** @param {OuterCompletion} completion @param {string} [entrySource] */
async function runOuter(completion, entrySource = ENTRY_SOURCE) {
  /** @type {any} */ let child;
  const reportEndpoint = await createOuterReportEndpoint();
  const world = await createEntryWorld({ childBehavior: {
    /** @param {any} actualChild @param {Buffer} handshake */
    onInputEnd(actualChild, handshake) {
      child = actualChild;
      reportEndpoint.send(actualChild, handshake, completion);
      if (completion.corruptRootConfig) {
        const coordinate = JSON.parse(handshake.toString("utf8"));
        const config = world.memoryFs.entry(join(coordinate.root, "vitest.config.ts"));
        if (config.kind !== "file") throw new Error("expected config file");
        config.bytes = Buffer.from("corrupt");
      }
      if (completion.advanceWaitTimeout) Promise.resolve().then(() => world.helperWorld.clock.advance(15000));
    },
  } }, entrySource);
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = oEnvironment();
  if (Object.hasOwn(completion, "ownerOutputThrow")) {
    world.process.stdout.write = () => { throw completion.ownerOutputThrow; };
  }
  const result = await world.entry.main();
  assert.equal(reportEndpoint.reports(), 1);
  assert.equal(reportEndpoint.reportWorld.writes.length,
    (completion.controlPrefix ?? 6) + (completion.failure ? 1 : 0));
  return { world, child, reportEndpoint, result };
}

/** @param {Record<string, unknown>} [changes] */
function handshakeBytes(changes = {}) {
  return Buffer.from(JSON.stringify({
    v: 1, nonce: "0123456789abcdef0123456789abcdef", root: ROOT,
    parentBinding: PARENT_BINDING, configHash: CONFIG_HASH, vitestTarget: VITEST_TARGET,
    ...changes,
  }));
}

/** @type {Array<{name:string, error:unknown}>} */
const failures = [];
let total = 0;
/** @param {string} name @param {() => unknown | Promise<unknown>} run */
async function check(name, run) {
  total += 1;
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) {
    failures.push({ name, error });
    const detail = error && typeof error === "object" && "stack" in error ? String(error.stack) : String(error);
    console.error(`FAIL ${name}: ${detail}`);
  }
}

await check("公开gate与普通import零资源", async () => {
  const world = await createEntryWorld();
  world.process.argv = [NODE, "/virtual/not-direct.mjs", "--case=vitest-fork"];
  const result = await world.entry.main();
  assert.equal(result, undefined);
  assert.equal(world.process.exitCode, 64);
  assert.equal(world.sceneCalls(), 0);
  assert.equal(world.helperWorld.child.children.length, 0);
  assert.equal(world.helperWorld.clock.intervals.size, 0);
  assert.equal(world.entry.authorized(["--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"]), true);
  assert.equal(world.entry.ownerReceipt(Object.freeze({})), undefined);
  let reads = 0;
  const opaque = new Proxy({}, {
    get() { reads += 1; throw new Error("opaque result read"); },
    ownKeys() { reads += 1; throw new Error("opaque result keys read"); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error("opaque result descriptor read"); },
  });
  assert.equal(world.entry.ownerRunReceipt(opaque), undefined);
  assert.equal(world.entry.ownerRunReceipt(null), undefined);
  assert.equal(reads, 0);
});

await check("O精确gate后使用真实Scene句柄和WeakMap收据完成四流", async () => {
  /** @type {any} */ let originalA;
  const reportEndpoint = await createOuterReportEndpoint();
  const behavior = { childBehavior: {
    /** @param {any} child @param {Buffer} handshake */
    onInputEnd(child, handshake) {
      originalA = child;
      reportEndpoint.send(child, handshake, { chunks: [1, 17, 3] });
    },
  } };
  const world = await createEntryWorld(behavior);
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = oEnvironment();
  const result = await world.entry.main();
  assert.equal(world.process.exitCode, undefined);
  assert.equal(world.sceneCalls(), 1);
  const handle = world.sceneHandle();
  assert.ok(result);
  assert.equal(result.scene, handle);
  assert.equal(Object.isFrozen(result), true);
  assert.ok(handle);
  assert.equal(Reflect.ownKeys(handle).length, 0);
  assert.ok(world.sceneReceipt(handle));
  const receipt = world.entry.ownerReceipt(handle);
  assert.ok(receipt);
  assert.equal(receipt.executionCandidate, true);
  assert.equal(receipt.aEnded, true);
  assert.equal(receipt.bEndedReported, true);
  assert.equal(receipt.reclaim, "not-requested");
  assert.equal(world.entry.ownerReceipt(Object.assign({}, handle)), undefined);
  assert.equal(world.entry.ownerReceipt(world.sceneReceipt(handle)), undefined);
  assert.equal(world.entry.ownerReceipt(Object.freeze({})), undefined);
  const runReceipt = world.entry.ownerRunReceipt(result);
  const repeatedRunReceipt = world.entry.ownerRunReceipt(result);
  assert.ok(runReceipt);
  assert.notEqual(repeatedRunReceipt, runReceipt);
  assert.equal(runReceipt.owner.executionCandidate, true);
  assert.deepEqual({ ...runReceipt.failure }, { failed: false, code: null, phase: "complete" });
  assert.equal(runReceipt.allocationFailure, undefined);
  assert.equal(Object.isFrozen(runReceipt), true);
  assert.equal(Object.isFrozen(runReceipt.failure), true);
  assert.equal(world.entry.ownerRunReceipt({ scene: handle }), undefined);
  let proxyReads = 0;
  const proxyResult = new Proxy(result, { get() { proxyReads += 1; throw new Error("result proxy read"); } });
  assert.equal(world.entry.ownerRunReceipt(proxyResult), undefined);
  assert.equal(proxyReads, 0);
  const otherWorld = await createEntryWorld();
  assert.equal(otherWorld.entry.ownerRunReceipt(result), undefined);
  assert.equal(originalA.stdio.every((/** @type {FakeStream | null} */ stream) => stream?.closed === true), true);
  assert.equal(reportEndpoint.reports(), 1);
  assert.equal(reportEndpoint.reportWorld.writes.length, 6);
  assert.notEqual(reportEndpoint.reportWorld.process, world.process);
  assert.equal(world.helperWorld.clock.intervals.size, 0);
});

await check("内部A成功仍返回undefined且不登记O结果", async () => {
  const world = await createEntryWorld();
  const result = await world.runA();
  assert.equal(result, undefined);
  assert.equal(world.entry.ownerRunReceipt(result), undefined);
  assert.equal(world.fd3Closed(), true);
});

await check("已装Vitest optimizer片段只归一化hook配置一次", async () => {
  const world = await createEntryWorld();
  await world.runA();
  assert.equal(world.process.exitCode, undefined);
  assert.deepEqual({ ...world.start.cacheDirs() }, {
    input: BASE_CACHE_DIR,
    early: EXPECTED_CACHE_DIR,
    resolved: EXPECTED_CACHE_DIR,
  });
});

/** @type {Array<[string, (world:any)=>void]>} */
const aDarwinEnvironmentRejections = [
  ["错误UID", (world) => { world.process.getuid = () => 502; }],
  ["缺CF字段", (world) => { delete world.process.env.__CF_USER_TEXT_ENCODING; }],
  ["畸形CF字段", (world) => { world.process.env.__CF_USER_TEXT_ENCODING = "0x1F5:not-a-script:0"; }],
  ["观察偏好CF字段", (world) => { world.process.env.__CF_USER_TEXT_ENCODING = OBSERVED_USER_TEXT_ENCODING; }],
  ["额外环境键", (world) => { world.process.env.UNREVIEWED_EXTRA = "1"; }],
];
for (const [name, mutate] of aDarwinEnvironmentRejections) {
  await check(`A Darwin环境${name}在library前拒绝`, async () => {
    const world = await createEntryWorld();
    mutate(world);
    await world.runA();
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.start.entered(), false);
    assert.equal(world.helperWorld.child.forks.length, 0);
    assert.equal(world.helperWorld.child.nativeCalls.length, 0);
    assert.equal(world.fd3Closed(), false);
  });
}

await check("O guard安装失败返回原结果身份和固定失败阶段", async () => {
  let opaqueReads = 0;
  const opaque = new Proxy(Object.create(null), {
    get() { opaqueReads += 1; throw new Error("guard error read"); },
    ownKeys() { opaqueReads += 1; throw new Error("guard error keys read"); },
    getOwnPropertyDescriptor() { opaqueReads += 1; throw new Error("guard error descriptor read"); },
  });
  const world = await createEntryWorld({ guardInstallFailure: opaque });
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = oEnvironment();
  const result = await world.entry.main();
  assert.ok(result);
  assert.equal(result.scene, null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(world.sceneCalls(), 0);
  assert.equal(world.helperWorld.child.children.length, 0);
  const receipt = world.entry.ownerRunReceipt(result);
  assert.equal(receipt.owner, undefined);
  assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "guard-install" });
  assert.equal(receipt.allocationFailure, undefined);
  assert.equal(opaqueReads, 0);
});

await check("O Scene前置失败不伪造allocation事实", async () => {
  const world = await createEntryWorld();
  world.memoryFs.entries.delete(path.normalize(join(PROJECT, "tests/fixtures/pm-sdk-ab-owner.fixture.ts")));
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = oEnvironment();
  const result = await world.entry.main();
  assert.equal(result.scene, null);
  assert.equal(world.sceneCalls(), 0);
  const receipt = world.entry.ownerRunReceipt(result);
  assert.equal(receipt.owner, undefined);
  assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "fixture-check" });
  assert.equal(receipt.allocationFailure, undefined);
});

/** @type {Array<[string, (world:any)=>void]>} */
const oDarwinEnvironmentRejections = [
  ["错误UID", (world) => { world.process.getuid = () => 502; }],
  ["缺CF字段", (world) => { delete world.process.env.__CF_USER_TEXT_ENCODING; }],
  ["畸形CF字段", (world) => { world.process.env.__CF_USER_TEXT_ENCODING = "0x1F5:not-a-script:0"; }],
  ["观察偏好CF字段", (world) => { world.process.env.__CF_USER_TEXT_ENCODING = OBSERVED_USER_TEXT_ENCODING; }],
];
for (const [name, mutate] of oDarwinEnvironmentRejections) {
  await check(`O Darwin环境${name}在Scene前拒绝`, async () => {
    const world = await createEntryWorld();
    world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
    world.process.env = oEnvironment();
    mutate(world);
    const result = await world.entry.main();
    assert.equal(result.scene, null);
    assert.equal(world.sceneCalls(), 0);
    assert.equal(world.helperWorld.child.children.length, 0);
    const receipt = world.entry.ownerRunReceipt(result);
    assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "environment" });
    assert.equal(receipt.allocationFailure, undefined);
  });
}

for (const [mode, expected] of /** @type {const} */ ([
  ["before-allocation", { phase: "package-input", attempted: false, root: null, identity: null }],
  ["attempt-no-path", { phase: "allocate-root", attempted: true, root: null, identity: null }],
  ["path-no-identity", { phase: "secure-root", attempted: true, root: "/tmp/pi-s-memory01", identity: null }],
])) {
  await check(`O Scene factory失败保留安全定位:${mode}`, async () => {
    const world = await createEntryWorld({ sceneFailure: mode });
    world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
    world.process.env = oEnvironment();
    const result = await world.entry.main();
    assert.equal(result.scene, null);
    assert.equal(world.sceneCalls(), 1);
    const originalError = world.sceneFailure();
    assert.ok(originalError);
    const direct = world.sceneFailureReceipt(originalError);
    assert.ok(direct);
    const receipt = world.entry.ownerRunReceipt(result);
    assert.equal(receipt.owner, undefined);
    assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "scene-allocation" });
    assert.deepEqual({ ...receipt.allocationFailure }, { ...direct });
    assert.notEqual(receipt.allocationFailure, direct);
    assert.equal(receipt.allocationFailure.phase, expected.phase);
    assert.equal(receipt.allocationFailure.allocationAttempted, expected.attempted);
    assert.equal(receipt.allocationFailure.root, expected.root);
    assert.equal(receipt.allocationFailure.rootIdentity, expected.identity);
    assert.equal(Object.isFrozen(receipt.allocationFailure), true);
    assert.deepEqual(Reflect.ownKeys(receipt.allocationFailure).sort(),
      ["allocationAttempted", "phase", "projectRoot", "root", "rootIdentity", "status"].sort());
    assert.equal(Object.hasOwn(receipt.allocationFailure, "cause"), false);
    assert.equal(Object.hasOwn(receipt.allocationFailure, "message"), false);
    assert.equal(Object.hasOwn(receipt.allocationFailure, "stack"), false);
  });
}

await check("O Scene后失败仍交回原Scene且当前失败", async () => {
  const { world, result } = await runOuter({ exitCode: 9 });
  const handle = world.sceneHandle();
  assert.equal(result.scene, handle);
  const receipt = world.entry.ownerRunReceipt(result);
  assert.equal(receipt.owner.executionCandidate, false);
  assert.equal(receipt.owner.aEnded, true);
  assert.equal(receipt.owner.bEndedReported, true);
  assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "candidate-record" });
  assert.equal(receipt.allocationFailure, undefined);
});

for (const stimulus of ["unhandled", "child-error", "control-late", "sealed-create"]) {
  await check(`R4 O候选后${stimulus}使当前原收据失效`, async () => {
    const { world, child, result } = await runOuter({});
    const handle = world.sceneHandle();
    const previous = world.entry.ownerReceipt(handle);
    const previousRun = world.entry.ownerRunReceipt(result);
    assert.equal(previous.executionCandidate, true);
    assert.equal(Object.isFrozen(previous), true);
    let opaqueReads = 0;
    const opaque = Object.create(null);
    for (const key of ["message", "stack", "toString", Symbol.toPrimitive]) {
      Object.defineProperty(opaque, key, { get() { opaqueReads += 1; throw new Error("opaque touched"); } });
    }
    if (stimulus === "unhandled") world.process.emit("unhandledRejection", opaque);
    else if (stimulus === "child-error") child.emit("error", opaque);
    else if (stimulus === "control-late") child.control.emit("data", Buffer.from("{}\n"));
    else {
      const before = world.helperWorld.child.nativeCalls.length;
      assert.throws(() => world.helperWorld.child.cp.spawn(NODE, [], { env: {}, stdio: "pipe" }));
      assert.equal(world.helperWorld.child.nativeCalls.length, before);
    }
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.helper.guardState().failed, true);
    const current = world.entry.ownerReceipt(handle);
    assert.equal(current.executionCandidate, false);
    assert.equal(current.root, previous.root);
    assert.equal(current.aEnded, true);
    assert.equal(current.bEndedReported, true);
    assert.equal(current.reclaim, "not-requested");
    assert.equal(current.preserved, true);
    const currentRun = world.entry.ownerRunReceipt(result);
    assert.equal(currentRun.owner.executionCandidate, false);
    assert.equal(currentRun.failure.failed, true);
    assert.notEqual(currentRun.failure.code, null);
    assert.equal(currentRun.failure.phase, "complete");
    assert.equal(previousRun.owner.executionCandidate, true, "旧运行快照只保留查询当时历史");
    assert.equal(previousRun.failure.failed, false);
    assert.equal(Object.hasOwn(currentRun, "latch"), false);
    assert.equal(Object.hasOwn(currentRun, "scene"), false);
    assert.equal(Object.hasOwn(current, "latch"), false);
    assert.equal(Object.hasOwn(current, "facts"), false);
    assert.equal(Object.isFrozen(current), true);
    assert.equal(previous.executionCandidate, true, "旧冻结快照只保留当时历史，不能作为最终通过");
    assert.equal(world.entry.ownerReceipt({ ...current }), undefined);
    world.process.exitCode = 0;
    assert.equal(world.entry.ownerReceipt(handle).executionCandidate, false, "不能只靠外部exitCode重置恢复候选");
    assert.equal(world.entry.ownerRunReceipt(result).failure.failed, true, "外部exitCode重置不能洗白运行失败");
    world.process.emit("exit", 0);
    assert.equal(world.process.exitCode, 1);
    assert.equal(opaqueReads, 0);
  });
}

await check("R4 候选输出同步throw不丢已观测历史事实", async () => {
  const { world, result } = await runOuter({ ownerOutputThrow: Object.freeze({ output: "failed" }) });
  const current = world.entry.ownerReceipt(world.sceneHandle());
  assert.equal(world.process.exitCode, 1);
  assert.equal(current.executionCandidate, false);
  assert.equal(current.aEnded, true);
  assert.equal(current.bEndedReported, true);
  assert.equal(current.reclaim, "not-requested");
  assert.equal(result.scene, world.sceneHandle());
  const run = world.entry.ownerRunReceipt(result);
  assert.equal(run.owner.executionCandidate, false);
  assert.deepEqual({ ...run.failure }, { failed: true, code: "o-failed", phase: "candidate-output" });
  assert.equal(run.allocationFailure, undefined);
});

await check("R4 A final后迟到失败保持退出失败且O拒绝", async () => {
  const a = await createEntryWorld();
  await a.runA();
  assert.equal(a.fd3Closed(), true);
  a.process.emit("unhandledRejection", Object.freeze({ late: true }));
  assert.equal(a.process.exitCode, 1);
  a.process.exitCode = 0;
  a.process.emit("exit", 0);
  assert.equal(a.process.exitCode, 1);
  const { world } = await runOuter({ exitCode: a.process.exitCode });
  assert.equal(world.process.exitCode, 1);
  assert.equal(world.entry.ownerReceipt(world.sceneHandle()).executionCandidate, false);
});

await check("O输出预算1048576字节仍可成为candidate", async () => {
  const { world } = await runOuter({ outputBytes: 1048576 });
  const receipt = world.entry.ownerReceipt(world.sceneHandle());
  assert.equal(world.process.exitCode, undefined);
  assert.equal(receipt.executionCandidate, true);
  assert.equal(receipt.reclaim, "not-requested");
});

await check("O输出预算1048577字节永久失败", async () => {
  const { world } = await runOuter({ outputBytes: 1048576, extraOutputByte: true });
  const receipt = world.entry.ownerReceipt(world.sceneHandle());
  assert.equal(world.process.exitCode, 1);
  assert.equal(receipt.executionCandidate, false);
  assert.equal(receipt.reclaim, "not-requested");
});

await check("O stdout error不能成为candidate", async () => {
  const { world } = await runOuter({ outputError: true });
  const receipt = world.entry.ownerReceipt(world.sceneHandle());
  assert.equal(world.process.exitCode, 1);
  assert.equal(receipt.executionCandidate, false);
});

await check("O final与EOF后仍等待第四流close", async () => {
  /** @type {any} */ let child;
  const reportEndpoint = await createOuterReportEndpoint();
  const world = await createEntryWorld({ childBehavior: {
    /** @param {any} actualChild @param {Buffer} handshake */
    onInputEnd(actualChild, handshake) {
      child = actualChild;
      reportEndpoint.send(actualChild, handshake, { closeControl: false });
    },
  } });
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = oEnvironment();
  let settled = false;
  const pending = world.entry.main().then(() => { settled = true; });
  for (let turn = 0; turn < 1000 && !child; turn += 1) await Promise.resolve();
  assert.ok(child, "O必须已经进入原A控制流");
  assert.equal(settled, false);
  assert.equal(world.entry.ownerReceipt(world.sceneHandle()), undefined);
  assert.equal(world.helperWorld.clock.intervals.size, 1);
  child.control.emit("close");
  await pending;
  assert.equal(world.entry.ownerReceipt(world.sceneHandle()).executionCandidate, true);
  assert.equal(reportEndpoint.reports(), 1);
  assert.equal(reportEndpoint.reportWorld.writes.length, 6);
  assert.notEqual(reportEndpoint.reportWorld.process, world.process);
  assert.equal(world.helperWorld.clock.intervals.size, 0);
});

await check("A握手合法JSON尾空白精确8192字节", async () => {
  const world = await createEntryWorld();
  const base = handshakeBytes();
  const padded = Buffer.concat([base, Buffer.alloc(8192 - base.length, 0x20)]);
  assert.equal(padded.length, 8192);
  await world.runA([padded]);
  assert.equal(world.process.exitCode, undefined);
  assert.equal(world.start.entered(), true);
  assert.equal(world.fd3Closed(), true);
});

await check("A握手8193字节在库边界前拒绝", async () => {
  const world = await createEntryWorld();
  await world.runA([Buffer.alloc(8193, 0x20)]);
  assert.equal(world.process.exitCode, 1);
  assert.equal(world.start.entered(), false);
  assert.equal(world.helperWorld.child.forks.length, 0);
});

const invalidHandshakes = [
  ["坏JSON", Buffer.from("{not-json")],
  ["截断EOF", handshakeBytes().subarray(0, handshakeBytes().length - 1)],
  ["错误nonce", handshakeBytes({ nonce: "ffffffffffffffffffffffffffffffff" })],
  ["多余字段", handshakeBytes({ extra: "forbidden" })],
];
for (const [name, bytes] of invalidHandshakes) {
  await check(`A握手${name}在库边界前拒绝`, async () => {
    const world = await createEntryWorld();
    await world.runA([/** @type {Buffer} */ (bytes)]);
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.start.entered(), false);
    assert.equal(world.helperWorld.child.forks.length, 0);
    assert.equal(world.fd3Closed(), false);
  });
}

await check("A握手跨多块并在真实EOF后驱动库替身", async () => {
  const world = await createEntryWorld();
  const bytes = handshakeBytes();
  await world.runA([bytes.subarray(0, 1), bytes.subarray(1, 23), bytes.subarray(23)]);
  assert.equal(world.process.exitCode, undefined);
  assert.equal(world.start.entered(), true);
  assert.equal(world.start.effects.includes("reporter-start-approved"), true);
  assert.equal(world.helperWorld.child.forks.length, 1);
});

await check("控制writer规范帧、短写和预算永久失败", async () => {
  const positive = await createHelperWorld();
  const helper = /** @type {any} */ ((await positive.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const writer = helper.createControlWriter("abc", latch);
  writer.send("ready");
  assert.equal(positive.writes[0].toString(), '{"v":1,"n":"abc","s":1,"k":"ready"}\n');
  const short = await createHelperWorld({ writeSync: (_fd, frame) => frame.length - 1 });
  const shortHelper = /** @type {any} */ ((await short.loadHelper()).namespace);
  const shortLatch = shortHelper.createFailureLatch();
  assert.throws(() => shortHelper.createControlWriter("abc", shortLatch).send("ready"));
  assert.equal(shortLatch.snapshot().code, "control-write");
  for (let index = 0; index < 128; index += 1) {
    if (index === 0) continue;
    writer.send("x");
  }
  assert.throws(() => writer.send("x"));
  assert.equal(latch.snapshot().failed, true);
});

await check("普通控制写throw短写预算永久关闭native诊断但业务latch仍可诊断", async () => {
  for (const kind of ["ready", "reserve", "bound"]) {
    for (const persistent of [false, true]) {
      const ordinal = kind === "ready" ? 1 : kind === "reserve" ? 2 : 3;
      let attempts = 0;
      let opaqueReads = 0;
      const opaque = new Proxy(Object.create(null), {
        get() { opaqueReads += 1; throw new Error("opaque write error read"); },
        ownKeys() { opaqueReads += 1; throw new Error("opaque write error keys"); },
      });
      const world = await createHelperWorld({ writeSync: (_fd, frame) => {
        attempts += 1;
        if (attempts === ordinal || (persistent && attempts >= ordinal)) throw opaque;
        return frame.length;
      } });
      const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
      const latch = helper.createFailureLatch();
      const writer = helper.createControlWriter("n", latch);
      if (ordinal > 1) writer.send("ready");
      if (ordinal > 2) writer.send("reserve");
      assert.throws(() => writer.send(kind));
      assert.equal(writer.sendFailureOnce("spec", latch.snapshot().code), false);
      assert.equal(attempts, ordinal, `${kind}:${persistent}`);
      assert.equal(opaqueReads, 0, `${kind}:${persistent}`);
      assert.equal(latch.snapshot().code, "control-write");
    }
  }

  let shortAttempts = 0;
  const short = await createHelperWorld({ writeSync: (_fd, frame) => {
    shortAttempts += 1;
    return shortAttempts === 1 ? frame.length - 1 : frame.length;
  } });
  const shortHelper = /** @type {any} */ ((await short.loadHelper()).namespace);
  const shortLatch = shortHelper.createFailureLatch();
  const shortWriter = shortHelper.createControlWriter("n", shortLatch);
  assert.throws(() => shortWriter.send("ready"));
  assert.equal(shortWriter.sendFailureOnce("spec", shortLatch.snapshot().code), false);
  assert.equal(shortAttempts, 1);

  const budget = await createHelperWorld();
  const budgetHelper = /** @type {any} */ ((await budget.loadHelper()).namespace);
  const budgetLatch = budgetHelper.createFailureLatch();
  const budgetWriter = budgetHelper.createControlWriter("n", budgetLatch);
  for (let index = 0; index < 128; index += 1) budgetWriter.send("x");
  assert.throws(() => budgetWriter.send("x"));
  assert.equal(budgetWriter.sendFailureOnce("spec", budgetLatch.snapshot().code), false);
  assert.equal(budget.writes.length, 128);

  const business = await createHelperWorld();
  const businessHelper = /** @type {any} */ ((await business.loadHelper()).namespace);
  const businessLatch = businessHelper.createFailureLatch();
  const businessWriter = businessHelper.createControlWriter("n", businessLatch);
  businessWriter.send("ready");
  businessLatch.fail("business-result");
  assert.throws(() => businessWriter.send("business-pass"));
  assert.equal(businessWriter.sendFailureOnce("business", businessLatch.snapshot().code), true);
  assert.equal(business.writes.length, 2);
  assert.equal(JSON.parse(business.writes[1].toString()).c, "business-result");
});

await check("控制reader绑定原owner/stream并严核nonce顺序EOF和迟到", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const good = validFrames(helper, "nonce");
  assert.equal(good.reader.snapshot().complete, true);
  good.reader.accept(good.owner, good.stream, Buffer.from("{}\n"));
  assert.equal(good.latch.snapshot().failed, true);
  for (const change of ["owner", "stream", "nonce", "order", "eof"]) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "n", latch);
    if (change === "owner") reader.accept({}, stream, Buffer.from('{"v":1,"n":"n","s":1,"k":"ready"}\n'));
    else if (change === "stream") reader.accept(owner, {}, Buffer.from('{"v":1,"n":"n","s":1,"k":"ready"}\n'));
    else if (change === "nonce") reader.accept(owner, stream, Buffer.from('{"v":1,"n":"x","s":1,"k":"ready"}\n'));
    else if (change === "order") reader.accept(owner, stream, Buffer.from('{"v":1,"n":"n","s":1,"k":"bound"}\n'));
    else reader.end(owner, stream);
    assert.equal(latch.snapshot().failed, true, change);
  }
});

await check("reader跨单字节多块和单块多帧均完成规范握手", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  for (const mode of ["single-byte", "multi-frame"]) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "chunks", latch);
    const bytes = Buffer.from(controlFrames("chunks"));
    if (mode === "single-byte") {
      for (const byte of bytes) reader.accept(owner, stream, Buffer.from([byte]));
    } else {
      reader.accept(owner, stream, bytes);
    }
    reader.end(owner, stream);
    assert.equal(latch.snapshot().failed, false, mode);
    assert.equal(reader.snapshot().complete, true, mode);
    assert.equal(reader.snapshot().sequence, 6, mode);
  }
});

await check("reader允许单次规范SIGTERM观察但拒绝重复", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const owner = {}; const stream = {}; const latch = helper.createFailureLatch();
  const reader = helper.createControlReader(owner, stream, "term", latch);
  const kinds = ["ready", "reserve", "bound", "sigterm", "business-pass", "b-ended", "final"];
  const text = kinds.map((kind, index) => JSON.stringify({ v: 1, n: "term", s: index + 1, k: kind }) + "\n").join("");
  reader.accept(owner, stream, Buffer.from(text)); reader.end(owner, stream);
  assert.equal(reader.snapshot().complete, true);
  assert.equal(reader.snapshot().sequence, 7);

  const repeatedLatch = helper.createFailureLatch();
  const repeated = helper.createControlReader(owner, stream, "term", repeatedLatch);
  const repeatedKinds = ["ready", "reserve", "bound", "sigterm", "sigterm"];
  repeated.accept(owner, stream, Buffer.from(repeatedKinds.map((kind, index) => JSON.stringify({ v: 1, n: "term", s: index + 1, k: kind }) + "\n").join("")));
  assert.equal(repeatedLatch.snapshot().failed, true);
});

await check("reader逐字节拒绝final后failure且健康前缀仍接受失败终帧", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const failure = (/** @type {string} */ nonce, /** @type {number} */ sequence) =>
    JSON.stringify({ v: 1, n: nonce, s: sequence, k: "a-failure", p: "spec", c: "fork-contract" }) + "\n";
  const success = controlFrames("n");
  const variants = [
    [Buffer.from(success + failure("n", 7))],
    [Buffer.from(success), Buffer.from(failure("n", 7))],
    [Buffer.from(success.slice(0, -1)), Buffer.from("\n" + failure("n", 7))],
    [Buffer.from(success), Buffer.from(failure("n", 7).slice(0, 1)), Buffer.from(failure("n", 7).slice(1))],
  ];
  for (const chunks of variants) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "n", latch);
    for (const chunk of chunks) reader.accept(owner, stream, chunk);
    reader.end(owner, stream);
    assert.equal(latch.snapshot().failed, true);
    assert.equal(reader.snapshot().successPhase, 6);
    assert.equal(reader.snapshot().acceptedFrames, 6);
    assert.equal(reader.snapshot().aFailureReported, null);
    assert.equal(reader.snapshot().complete, false);
  }

  const termKinds = ["ready", "reserve", "bound", "sigterm", "business-pass", "b-ended", "final"];
  const termSuccess = termKinds.map((kind, index) => JSON.stringify({ v: 1, n: "t", s: index + 1, k: kind }) + "\n").join("");
  const termLatch = helper.createFailureLatch(); const termOwner = {}; const termStream = {};
  const termReader = helper.createControlReader(termOwner, termStream, "t", termLatch);
  termReader.accept(termOwner, termStream, Buffer.from(termSuccess + failure("t", 8)));
  assert.equal(termLatch.snapshot().failed, true);
  assert.equal(termReader.snapshot().successPhase, 6);
  assert.equal(termReader.snapshot().acceptedFrames, 7);
  assert.equal(termReader.snapshot().aFailureReported, null);

  const prefixLatch = helper.createFailureLatch(); const prefixOwner = {}; const prefixStream = {};
  const prefixReader = helper.createControlReader(prefixOwner, prefixStream, "p", prefixLatch);
  const prefix = ["ready", "reserve", "bound"].map((kind, index) => JSON.stringify({ v: 1, n: "p", s: index + 1, k: kind }) + "\n").join("");
  prefixReader.accept(prefixOwner, prefixStream, Buffer.from(prefix + failure("p", 4)));
  prefixReader.end(prefixOwner, prefixStream);
  assert.equal(prefixLatch.snapshot().failed, true);
  assert.equal(prefixReader.snapshot().successPhase, 3);
  assert.equal(prefixReader.snapshot().acceptedFrames, 4);
  assert.deepEqual({ ...prefixReader.snapshot().aFailureReported }, { phase: "spec", code: "fork-contract" });
  assert.equal(prefixReader.snapshot().complete, false);
});

const malformedReaderFrames = [
  ["坏nonce", '{"v":1,"n":"x","s":1,"k":"ready"}\n'],
  ["坏序号", '{"v":1,"n":"n","s":2,"k":"ready"}\n'],
  ["多余字段", '{"v":1,"n":"n","s":1,"k":"ready","x":1}\n'],
  ["缺字段", '{"v":1,"n":"n","s":1}\n'],
  ["非规范key顺序", '{"n":"n","v":1,"s":1,"k":"ready"}\n'],
  ["非规范空白", '{ "v":1,"n":"n","s":1,"k":"ready"}\n'],
  ["坏JSON", '{not-json}\n'],
];
for (const [name, text] of malformedReaderFrames) {
  await check(`reader逐项拒绝${name}`, async () => {
    const world = await createHelperWorld();
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "n", latch);
    reader.accept(owner, stream, Buffer.from(text));
    assert.equal(latch.snapshot().failed, true);
    assert.equal(reader.snapshot().complete, false);
  });
}

await check("reader EOF早到、残帧、重复EOF与late数据分别拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  for (const mode of ["early", "partial", "duplicate", "late"]) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "eof", latch);
    if (mode === "partial") reader.accept(owner, stream, Buffer.from('{"v":1'));
    else if (mode === "duplicate" || mode === "late") {
      reader.accept(owner, stream, Buffer.from(controlFrames("eof")));
      reader.end(owner, stream);
    }
    if (mode === "early" || mode === "partial") reader.end(owner, stream);
    else if (mode === "duplicate") reader.end(owner, stream);
    else reader.accept(owner, stream, Buffer.from("{}\n"));
    assert.equal(latch.snapshot().failed, true, mode);
    assert.equal(reader.snapshot().complete, false, mode);
  }
});

await check("reader逐帧256字节边界接受、257拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  let nonce256 = "";
  for (let length = 1; length < 300; length += 1) {
    const candidate = "n".repeat(length);
    const frame = Buffer.from(JSON.stringify({ v: 1, n: candidate, s: 1, k: "ready" }) + "\n");
    if (frame.length === 256) { nonce256 = candidate; break; }
  }
  assert.notEqual(nonce256, "");
  const exactLatch = helper.createFailureLatch(); const exactOwner = {}; const exactStream = {};
  const exact = helper.createControlReader(exactOwner, exactStream, nonce256, exactLatch);
  const exactFrame = Buffer.from(JSON.stringify({ v: 1, n: nonce256, s: 1, k: "ready" }) + "\n");
  exact.accept(exactOwner, exactStream, exactFrame);
  assert.equal(exactFrame.length, 256);
  assert.equal(exactLatch.snapshot().failed, false);
  assert.equal(exact.snapshot().sequence, 1);

  const overNonce = `${nonce256}n`;
  const overLatch = helper.createFailureLatch(); const overOwner = {}; const overStream = {};
  const over = helper.createControlReader(overOwner, overStream, overNonce, overLatch);
  const overFrame = Buffer.from(JSON.stringify({ v: 1, n: overNonce, s: 1, k: "ready" }) + "\n");
  over.accept(overOwner, overStream, overFrame);
  assert.equal(overFrame.length, 257);
  assert.equal(overLatch.snapshot().failed, true);
});

await check("reader总字节32768通过总预算后受帧预算拒绝，32769立即拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  for (const length of [32768, 32769]) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "budget", latch);
    reader.accept(owner, stream, Buffer.alloc(length, 0x61));
    assert.equal(reader.snapshot().bytes, length);
    assert.equal(latch.snapshot().failed, true);
  }
  assert.equal(HELPER_SOURCE.includes("if (++sequence > 128)"), true);
  assert.equal(HELPER_SOURCE.includes("if (bytes > 32768)"), true);
});

await check("writer独立达到128帧和32768字节精确边界", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  let nonce = "";
  for (let length = 1; length < 300; length += 1) {
    const candidate = "n".repeat(length);
    const emptyKindLength = Buffer.byteLength(JSON.stringify({ v: 1, n: candidate, s: 1, k: "" }) + "\n");
    const needed = 256 - emptyKindLength;
    if (needed >= 3 && needed <= 20) { nonce = candidate; break; }
  }
  assert.notEqual(nonce, "");
  const writer = helper.createControlWriter(nonce, latch);
  for (let sequence = 1; sequence <= 128; sequence += 1) {
    const emptyKindLength = Buffer.byteLength(JSON.stringify({ v: 1, n: nonce, s: sequence, k: "" }) + "\n");
    const kind = "x".repeat(256 - emptyKindLength);
    writer.send(kind);
  }
  assert.equal(world.writes.length, 128);
  assert.equal(world.writes.every((frame) => frame.length === 256), true);
  assert.equal(world.writes.reduce((sum, frame) => sum + frame.length, 0), 32768);
  assert.equal(latch.snapshot().failed, false);
  assert.throws(() => writer.send("x"));
  assert.equal(latch.snapshot().failed, true);
});

await check("单fork、unsafe输入、额外创建、sync与Worker拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const expectedEnv = { SAFE: "1" };
  const guard = helper.installProcessGuard("A", latch, () => {}, (/** @type {unknown} */ file, /** @type {unknown} */ args, /** @type {any} */ options) => {
    assert.equal(file, "/worker.js"); assert.deepEqual(args, []);
    assert.deepEqual(options.env, expectedEnv); assert.deepEqual(options.execArgv, ["--import", "preload"]);
  });
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: ["--import", "preload"], env: expectedEnv });
  assert.equal(guard.original().child, child);
  assert.equal(world.child.forks.length, 1);
  assert.throws(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: ["--import", "preload"], env: expectedEnv }));
  assert.throws(() => world.child.cp.spawnSync());
  assert.throws(() => new world.threads.Worker());
  assert.equal(world.child.forks.length, 1);

  const unsafe = await createHelperWorld();
  const unsafeHelper = /** @type {any} */ ((await unsafe.loadHelper()).namespace);
  const unsafeLatch = unsafeHelper.createFailureLatch();
  unsafeHelper.installProcessGuard("A", unsafeLatch, () => {}, (/** @type {unknown} */ _file, /** @type {unknown} */ _args, /** @type {any} */ options) => {
    if (options.env.BAD || options.execArgv.includes("--bad")) throw new Error("unsafe");
  });
  assert.throws(() => unsafe.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: ["--bad"], env: { BAD: "1" } }));
  assert.equal(unsafe.child.nativeCalls.length, 0);
});

await check("原B kill false保持原值并锁存失败", async () => {
  const world = await createHelperWorld({ childBehavior: { nativeKillResult: false } });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  assert.equal(Reflect.apply(child.kill, child, []), false);
  assert.deepEqual(world.child.killSignals, [undefined]);
  assert.equal(latch.snapshot().code, "native-kill-result");
  assert.throws(() => guard.assert());
});

await check("原B kill throw保持原throw", async () => {
  const token = Object.freeze({ nativeKill: "throw" });
  const world = await createHelperWorld({ childBehavior: { nativeKillThrow: token } });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  const result = capture(() => child.kill("SIGTERM"));
  assert.equal(result.threw, true);
  assert.equal(result.value, token);
  assert.deepEqual(world.child.killSignals, ["SIGTERM"]);
  assert.equal(latch.snapshot().code, "native-kill");
});

await check("原B第二次SIGTERM拒绝且不再调native", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  assert.equal(Reflect.apply(child.kill, child, []), true);
  assert.throws(() => child.kill("SIGTERM"));
  assert.deepEqual(world.child.killSignals, [undefined]);
});

await check("原B无TERM前置的SIGKILL升级拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  assert.throws(() => child.kill("SIGKILL"));
  assert.deepEqual(world.child.killSignals, []);
});

await check("原B一次SIGKILL转交但标失败，重复升级拒绝", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  assert.equal(child.kill("SIGTERM"), true);
  assert.equal(child.kill("SIGKILL"), true);
  assert.equal(latch.snapshot().code, "sigkill-upgrade");
  assert.throws(() => child.kill("SIGKILL"));
  assert.deepEqual(world.child.killSignals, ["SIGTERM", "SIGKILL"]);
});

await check("原B错误receiver不调native且self通道不混入", async () => {
  const processLike = new FakeProcess();
  let selfCalls = 0;
  processLike.kill = function () { selfCalls += 1; return "self"; };
  const world = await createHelperWorld({ process: processLike });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  const guardedKill = child.kill;
  assert.throws(() => Reflect.apply(guardedKill, {}, ["SIGTERM"]));
  assert.deepEqual(world.child.killSignals, []);
  assert.equal(processLike.kill(processLike.pid, "SIGTERM"), "self");
  assert.equal(selfCalls, 1);
  assert.deepEqual(world.child.killSignals, []);
});

await check("exit先于stdio close不结束，unknown保持keeper", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  const observed = guard.original();
  child.emit("disconnect"); child.emit("exit", 0, null); child.emit("close");
  assert.equal(observed.snapshot().ended, false);
  assert.equal(world.clock.intervals.size, 1);
  const wait = observed.wait();
  await Promise.resolve();
  assert.equal(observed.snapshot().ended, false);
  for (const stream of child.stdio.slice(0, 3)) {
    assert.ok(stream);
    stream.emit("close");
  }
  assert.equal(await wait, true);
  assert.equal(world.clock.intervals.size, 0);
});

await check("5秒握手deadline按delay推进且超时前不提前返回", async () => {
  const world = await createEntryWorld();
  const pending = await world.beginA();
  let settled = false;
  pending.promise.then(() => { settled = true; });
  world.helperWorld.clock.advance(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(world.process.exitCode, undefined);
  world.helperWorld.clock.advance(1);
  await pending.promise;
  assert.equal(settled, true);
  assert.equal(world.process.exitCode, 1);
  assert.equal(world.start.entered(), false);
  assert.equal(world.helperWorld.child.forks.length, 0);
});

await check("15秒wait超时不释放未知keeper或伪造ended", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  const original = guard.original();
  const wait = original.wait();
  world.clock.advance(14999);
  assert.equal(latch.snapshot().failed, false);
  assert.equal(original.snapshot().ended, false);
  assert.equal(world.clock.intervals.size, 1);
  world.clock.advance(1);
  assert.equal(await wait, false);
  assert.equal(latch.snapshot().code, "child-close-timeout");
  assert.equal(original.snapshot().ended, false);
  assert.equal(world.clock.intervals.size, 1);
  for (const stream of child.stdio.slice(0, 3)) stream?.emit("close");
  child.emit("disconnect"); child.emit("exit", 0, null); child.emit("close");
  assert.equal(original.snapshot().ended, true);
  assert.equal(world.clock.intervals.size, 0);
  assert.throws(() => guard.assert());
});

await check("30秒库未settled会seal并失败但不伪造立即返回", async () => {
  const world = await createEntryWorld({ hang: true });
  const pending = await world.beginA();
  world.process.stdin.emit("data", handshakeBytes());
  world.process.stdin.emit("end");
  for (let turn = 0; turn < 1000 && !world.start.entered(); turn += 1) await Promise.resolve();
  assert.equal(world.start.entered(), true);
  assert.equal(world.helperWorld.child.forks.length, 1);
  let settled = false;
  pending.promise.then(() => { settled = true; });
  world.helperWorld.clock.advance(29999);
  await Promise.resolve();
  assert.equal(world.process.exitCode, undefined);
  assert.equal(settled, false);
  world.helperWorld.clock.advance(1);
  await Promise.resolve();
  assert.equal(world.process.exitCode, 1);
  assert.equal(settled, false);
  const nativeBefore = world.helperWorld.child.nativeCalls.length;
  assert.throws(() => world.helperWorld.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(world.helperWorld.child.nativeCalls.length, nativeBefore);
  world.start.release();
  await pending.promise;
  const worker = world.start.worker();
  for (const stream of worker.stdio.slice(0, 3)) stream.emit("close");
  worker.emit("disconnect"); worker.emit("exit", 0, null); worker.emit("close");
  assert.equal(world.helperWorld.clock.intervals.size, 0);
});

await check("late完成、新创建与final后写入都不能洗白首错", async () => {
  const readerWorld = await createHelperWorld();
  const helper = /** @type {any} */ ((await readerWorld.loadHelper()).namespace);
  const readerLatch = helper.createFailureLatch();
  const owner = {}; const stream = {};
  const reader = helper.createControlReader(owner, stream, "late", readerLatch);
  reader.accept(owner, stream, Buffer.from(controlFrames("late")));
  reader.end(owner, stream);
  assert.equal(reader.snapshot().complete, true);
  reader.accept(owner, stream, Buffer.from("{}\n"));
  assert.equal(readerLatch.snapshot().failed, true);
  assert.equal(reader.snapshot().complete, false);

  const writerLatch = helper.createFailureLatch();
  const writer = helper.createControlWriter("late", writerLatch);
  writer.send("final");
  assert.throws(() => writer.send("ready"));
  assert.equal(writerLatch.snapshot().code, "control-write");

  const guardLatch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", guardLatch, () => {}, () => {});
  guard.seal();
  const nativeBefore = readerWorld.child.nativeCalls.length;
  assert.throws(() => readerWorld.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(readerWorld.child.nativeCalls.length, nativeBefore);
  assert.equal(guardLatch.snapshot().failed, true);
});

await check("结束后的late child error保持失败且不复活候选", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const child = world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} });
  for (const stream of child.stdio.slice(0, 3)) stream?.emit("close");
  child.emit("disconnect"); child.emit("exit", 0, null); child.emit("close");
  assert.equal(guard.original().snapshot().ended, true);
  child.emit("error", new Error("late child error"));
  assert.equal(latch.snapshot().code, "child-error");
  assert.throws(() => guard.assert());
});

await check("native返回不被后置stdio观察失败覆盖", async () => {
  const world = await createHelperWorld({ childBehavior: { failOnStreamEvent: "close" } });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(result.threw, false);
  assert.equal(result.value, guard.original().child);
  assert.equal(latch.snapshot().code, "stdio-observation");
});

await check("配置前置、spec空多错路与自动finally.close stop时序", async () => {
  for (const stop of /** @type {const} */ (["before", "after"])) {
    const world = await createEntryWorld({ stop });
    await world.runA();
    assert.equal(world.process.exitCode, undefined,
      `${stop}: frames=${world.helperWorld.writes.map((frame) => frame.toString()).join("|")} effects=${world.start.effects.join(",")}`);
    assert.equal(world.fd3Closed(), true, stop);
    assert.ok(world.start.effects.includes("stop:inside-close"), stop);
    assert.equal(world.start.effects.includes("stop:after-return"), false, stop);
    assert.deepEqual(world.helperWorld.child.killSignals, [undefined], stop);
    assert.equal(world.helperWorld.clock.intervals.size, 0, stop);
    const frames = world.helperWorld.writes.map((frame) => JSON.parse(frame.toString())).map((frame) => frame.k);
    assert.deepEqual(frames, stop === "before"
      ? ["ready", "reserve", "bound", "sigterm", "business-pass", "b-ended", "final"]
      : ["ready", "reserve", "bound", "business-pass", "sigterm", "b-ended", "final"]);
  }
  const unsafe = await createEntryWorld({ unsafeConfig: true });
  await unsafe.runA();
  assert.equal(unsafe.process.exitCode, 1);
  assert.equal(unsafe.start.effects.length, 0, "非法配置必须早于库副作用标记");
  assert.equal(unsafe.helperWorld.child.forks.length, 0);
  for (const specs of ["empty", "many", "wrong"]) {
    const world = await createEntryWorld({ specs: /** @type {any} */ (specs) });
    await world.runA();
    assert.equal(world.process.exitCode, 1, specs);
    assert.equal(world.helperWorld.child.forks.length, 0, specs);
  }
});

/** @type {Array<[string, (config:any)=>void]>} */
const unsafeEarlyConfigs = [
  ["root", (config) => { config.root = "/wrong"; }],
  ["cacheDir错误绝对目录", (config) => { config.cacheDir = "/wrong"; }],
  ["cacheDir退回输入base", (config) => { config.cacheDir = BASE_CACHE_DIR; }],
  ["cacheDir兄弟目录", (config) => { config.cacheDir = join(ROOT, "cache-peer"); }],
  ["cacheDir任意子目录", (config) => { config.cacheDir = join(BASE_CACHE_DIR, "arbitrary-child"); }],
  ["cacheDir命名项目hash", (config) => { config.cacheDir = join(BASE_CACHE_DIR, "vitest", NAMED_PROJECT_CACHE_HASH); }],
  ["cacheDir双后缀", (config) => { config.cacheDir = join(EXPECTED_CACHE_DIR, "vitest", UNNAMED_PROJECT_CACHE_HASH); }],
  ["envDir", (config) => { config.envDir = ROOT; }],
  ["publicDir", (config) => { config.publicDir = true; }],
  ["server缺失", (config) => { config.server = undefined; }],
  ["middlewareMode", (config) => { config.server.middlewareMode = false; }],
  ["ws", (config) => { config.server.ws = true; }],
  ["hmr", (config) => { config.server.hmr = true; }],
  ["watch", (config) => { config.server.watch = {}; }],
  ["open", (config) => { config.server.open = true; }],
  ["preTransformRequests", (config) => { config.server.preTransformRequests = true; }],
  ["https", (config) => { config.server.https = {}; }],
  ["configFile", (config) => { config.configFile = "/wrong"; }],
  ["后置config hook", (config) => { config.plugins.push({ config() {} }); }],
];
for (const [name, patch] of unsafeEarlyConfigs) {
  await check(`真实plugin逐项拒绝early配置:${name}`, async () => {
    const world = await createEntryWorld({ earlyPatch: patch });
    await world.runA();
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.start.effects.length, 0);
    assert.equal(world.helperWorld.child.forks.length, 0);
  });
}

/** @type {Array<[string, (config:any)=>void]>} */
const unsafeResolvedConfigs = [
  ["cacheDir退回输入base", (config) => { config.cacheDir = BASE_CACHE_DIR; }],
  ["cacheDir兄弟目录", (config) => { config.cacheDir = join(ROOT, "cache-peer"); }],
  ["cacheDir任意子目录", (config) => { config.cacheDir = join(BASE_CACHE_DIR, "arbitrary-child"); }],
  ["cacheDir命名项目hash", (config) => { config.cacheDir = join(BASE_CACHE_DIR, "vitest", NAMED_PROJECT_CACHE_HASH); }],
  ["cacheDir双后缀", (config) => { config.cacheDir = join(EXPECTED_CACHE_DIR, "vitest", UNNAMED_PROJECT_CACHE_HASH); }],
  ["include", (config) => { config._vitest.include = ["wrong.ts"]; }],
  ["run", (config) => { config._vitest.run = false; }],
  ["watch", (config) => { config._vitest.watch = true; }],
  ["maxWorkers", (config) => { config._vitest.maxWorkers = 2; }],
  ["ui", (config) => { config._vitest.ui = true; }],
  ["api", (config) => { config._vitest.api.middlewareMode = false; }],
  ["coverage", (config) => { config._vitest.coverage.enabled = true; }],
  ["typecheck", (config) => { config._vitest.typecheck.enabled = true; }],
  ["pool", (config) => { config._vitest.pool = "threads"; }],
  ["isolate", (config) => { config._vitest.isolate = false; }],
  ["fileParallelism", (config) => { config._vitest.fileParallelism = true; }],
  ["environment", (config) => { config._vitest.environment = "jsdom"; }],
  ["testTimeout", (config) => { config._vitest.testTimeout = 6000; }],
  ["projects", (config) => { config._vitest.projects = [{}]; }],
];
for (const [name, patch] of unsafeResolvedConfigs) {
  await check(`真实plugin逐项拒绝resolved配置:${name}`, async () => {
    const world = await createEntryWorld({ resolvedPatch: patch });
    await world.runA();
    assert.equal(world.process.exitCode, 1);
    assert.deepEqual(world.start.effects, ["early-config-approved"]);
    assert.equal(world.helperWorld.child.forks.length, 0);
  });
}

const unsafeSpecs = [
  ["错误project", { specProject: "wrong" }],
  ["错误pool", { specPool: "threads" }],
  ["重复start", { duplicateStart: true }],
];
for (const [name, behavior] of unsafeSpecs) {
  await check(`真实reporter拒绝spec契约:${name}`, async () => {
    const world = await createEntryWorld(/** @type {StartBehavior} */ (behavior));
    await world.runA();
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.helperWorld.child.forks.length, 0);
  });
}

const unsafeBusiness = [
  ["错误name", { testName: "wrong name" }],
  ["多test", { testCount: 2 }],
  ["test失败", { testState: "failed" }],
  ["module失败", { moduleState: "failed" }],
  ["run reason失败", { reason: "failed" }],
  ["run errors非空", { runErrors: [new Error("business error")] }],
  ["unhandled非空", { unhandled: [new Error("unhandled")] }],
  ["结束后error", { lateWorkerError: true }],
];
for (const [name, behavior] of unsafeBusiness) {
  await check(`真实reporter拒绝业务结果:${name}`, async () => {
    const world = await createEntryWorld(/** @type {StartBehavior} */ (behavior));
    await world.runA();
    assert.equal(world.process.exitCode, 1);
    assert.equal(world.helperWorld.child.forks.length, 1);
  });
}

await check("封口后创建拒绝且不进入native", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const guard = helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
  guard.seal();
  assert.throws(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(world.child.nativeCalls.length, 0);
});

await check("A拒绝向B fork传播非固定CF值", async () => {
  const world = await createEntryWorld({ bCf: OBSERVED_USER_TEXT_ENCODING });
  await world.runA();
  assert.equal(world.process.exitCode, 1);
  assert.equal(world.start.entered(), true);
  assert.equal(world.helperWorld.child.forks.length, 0);
  assert.equal(world.helperWorld.child.nativeCalls.length, 0);
});

await check("fork同步契约逐项在spec锁存且既有阶段首错不被覆盖", async () => {
  /** @type {Array<[string, (request:any)=>void]>} */
  const patches = [
    ["file", (request) => { request.file = "/wrong-worker.js"; }],
    ["args", (request) => { request.args.push("unexpected"); }],
    ["options", (request) => { delete request.options.serialization; }],
    ["execArgv", (request) => { request.options.execArgv.push("--bad"); }],
    ["env", (request) => { request.options.env.EXTRA = "1"; }],
  ];
  for (const [name, patch] of patches) {
    const world = await createEntryWorld({ forkPatch: patch });
    await world.runA();
    const encoded = world.helperWorld.writes.at(-1);
    assert.ok(encoded);
    const frame = JSON.parse(encoded.toString());
    assert.equal(frame.k, "a-failure", name);
    assert.equal(frame.p, "spec", name);
    assert.equal(frame.c, "fork-contract", name);
    assert.equal(world.helperWorld.child.nativeCalls.length, 0, name);
  }
  /** @type {Array<[string, StartBehavior, string, string]>} */
  const phaseCases = [
    ["early", { unsafeConfig: true }, "early-config", "early-config"],
    ["resolved", { resolvedPatch: (/** @type {any} */ config) => { config._vitest.pool = "threads"; } }, "resolved-config", "resolved-config"],
    ["business", { testName: "wrong" }, "business", "business-result"],
  ];
  for (const [name, behavior, phase, code] of phaseCases) {
    const world = await createEntryWorld(behavior);
    await world.runA();
    const encoded = world.helperWorld.writes.at(-1);
    assert.ok(encoded);
    const frame = JSON.parse(encoded.toString());
    assert.equal(frame.p, phase, name);
    assert.equal(frame.c, code, name);
  }
});

await check("B真实绑定、fixture、重复加载与普通import", async () => {
  const processLike = new FakeProcess({
    connected: true,
    execArgv: ["--import", HELPER_URL.href],
    env: {
      ...aEnvironment(), TMPDIR: `${ROOT}/verification`, GIT_CEILING_DIRECTORIES: ROOT,
      TEST: "true", VITEST: "true", VITEST_MODE: "RUN", FORCE_TTY: "", PROD: "", DEV: "1", BASE_URL: "/", MODE: "test",
      PI_PM_AB_ROLE: "B", PI_PM_AB_PRELOAD: HELPER_URL.href,
    },
  });
  const world = await createHelperWorld({ process: processLike });
  const first = await world.loadHelper(`${HELPER_URL.href}?first`);
  const helper = /** @type {any} */ (first.namespace);
  assert.deepEqual({ ...helper.guardState() }, { role: "B", intact: true, failed: false, sealed: true, admitted: false });
  const second = await world.loadHelper(`${HELPER_URL.href}?second`);
  assert.deepEqual({ .../** @type {any} */ (second.namespace).guardState() }, { role: "B", intact: true, failed: false, sealed: true, admitted: false });

  /** @type {Array<{name:string, callback:()=>void}>} */ const registered = [];
  const vitest = await synthetic(world.context, "vitest", {
    test: (/** @type {string} */ name, /** @type {() => void} */ callback) => registered.push({ name, callback }),
  });
  const assertModule = await synthetic(world.context, "node:assert/strict", { default: assert });
  const fixture = new SourceTextModule(stripTypeScriptTypes(FIXTURE_SOURCE, { mode: "strip" }), {
    context: world.context, identifier: join(TESTS, "fixtures/pm-sdk-ab-owner.fixture.ts"),
  });
  await fixture.link((specifier) => {
    if (specifier === "node:assert/strict") return assertModule;
    if (specifier === "vitest") return vitest;
    if (specifier === "../helpers/pm-sdk-ab-owner.mjs") return first;
    throw new Error(`unexpected fixture import: ${specifier}`);
  });
  await fixture.evaluate();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, helper.TEST_NAME);
  registered[0].callback();
  processLike.env.__CF_USER_TEXT_ENCODING = OBSERVED_USER_TEXT_ENCODING;
  assert.throws(() => registered[0].callback(), AssertionError);

  const ordinary = await createHelperWorld();
  const ordinaryHelper = /** @type {any} */ ((await ordinary.loadHelper()).namespace);
  assert.equal(ordinaryHelper.guardState(), undefined);
});

for (const role of /** @type {const} */ (["O", "A", "B"])) {
  await check(`R1 ${role} self按原receiver与完整参数转交`, async () => {
    const processLike = new FakeProcess();
    /** @type {Array<{receiver:unknown, args:unknown[]}>} */ const nativeCalls = [];
    const token = Object.freeze({ role, returned: true });
    /** @this {FakeProcess} @param {...unknown} args */
    processLike.kill = function (...args) { nativeCalls.push({ receiver: this, args }); return token; };
    const nativeKill = processLike.kill;
    const world = await createHelperWorld({ process: processLike });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    const guard = helper.installProcessGuard(role, helper.createFailureLatch(), () => {}, () => {});
    guard.seal();
    const result = processLike.kill(processLike.pid, "SIGTERM", "native-extra");
    assert.equal(result, token);
    assert.notEqual(processLike.kill, nativeKill);
    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0].receiver, processLike);
    assert.equal(nativeCalls[0].args.length, 3);
    assert.equal(nativeCalls[0].args[0], processLike.pid);
    assert.equal(nativeCalls[0].args[1], "SIGTERM");
    assert.equal(nativeCalls[0].args[2], "native-extra");
    assert.equal(helper.guardState().intact, true);
  });
  await check(`R1 ${role} self保留原throw`, async () => {
    const processLike = new FakeProcess();
    const token = Object.freeze({ role, thrown: true });
    let calls = 0;
    /** @this {FakeProcess} @param {number} pid */
    processLike.kill = function (pid) { calls += 1; assert.equal(this, processLike); assert.equal(pid, processLike.pid); throw token; };
    const world = await createHelperWorld({ process: processLike });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    helper.installProcessGuard(role, helper.createFailureLatch(), () => {}, () => {});
    const result = capture(() => processLike.kill(processLike.pid));
    assert.equal(result.threw, true);
    assert.equal(result.value, token);
    assert.equal(calls, 1);
  });
}

await check("R1 已失败且sealed后self仍转交", async () => {
  const processLike = new FakeProcess();
  let calls = 0;
  /** @this {FakeProcess} @param {number} pid @param {unknown} signal */
  processLike.kill = function (pid, signal) { calls += 1; assert.equal(this, processLike); assert.equal(pid, processLike.pid); return signal; };
  const world = await createHelperWorld({ process: processLike });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("B", latch, () => {}, () => {});
  assert.throws(() => processLike.kill(processLike.pid + 1, "SIGTERM"));
  assert.equal(latch.snapshot().failed, true);
  guard.seal();
  assert.equal(processLike.kill(processLike.pid, "SIGINT"), "SIGINT");
  assert.equal(calls, 1);
});

for (const invalidPid of [0, -1, 8124, "8123", { valueOf: () => 8123 }]) {
  await check(`R1 foreign或伪PID拒绝:${typeof invalidPid === "object" ? "object" : String(invalidPid)}`, async () => {
    const processLike = new FakeProcess();
    let calls = 0;
    processLike.kill = function () { calls += 1; return true; };
    const world = await createHelperWorld({ process: processLike });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    helper.installProcessGuard("B", helper.createFailureLatch(), () => {}, () => {});
    assert.throws(() => Reflect.apply(processLike.kill, processLike, [invalidPid, "SIGTERM"]));
    assert.equal(calls, 0);
  });
}

/** @param {{role?:string, marker?:string, omitRole?:boolean, omitMarker?:boolean, execArgv?:string[], connected?:boolean, nodeEnv?:string, vitest?:string}} change */
async function rejectedPreload(change) {
  /** @type {Record<string,string>} */
  const env = { NODE_ENV: change.nodeEnv ?? "test", VITEST: change.vitest ?? "true" };
  if (!change.omitRole) env.PI_PM_AB_ROLE = change.role ?? "B";
  if (!change.omitMarker) env.PI_PM_AB_PRELOAD = change.marker ?? HELPER_URL.href;
  const processLike = new FakeProcess({ connected: change.connected ?? true, execArgv: change.execArgv ?? ["--import", HELPER_URL.href], env });
  const world = await createHelperWorld({ process: processLike });
  await assert.rejects(() => world.loadHelper(`${HELPER_URL.href}?reject-${Math.random()}`));
  assert.equal(world.child.nativeCalls.length, 0);
  assert.equal(world.process.exitCode, 1);
}

const preloadRejections = [
  ["缺role", { omitRole: true }], ["错role-A", { role: "A" }], ["错role-other", { role: "worker" }],
  ["缺marker", { omitMarker: true }], ["错marker", { marker: "file:///wrong.mjs" }],
  ["错配相邻argv", { execArgv: ["--import", "file:///other.mjs", HELPER_URL.href] }],
  ["重复helper preload", { execArgv: ["--import", HELPER_URL.href, "--import", HELPER_URL.href] }],
  ["import等号形式", { execArgv: [`--import=${HELPER_URL.href}`] }],
  ["绝对路径形式", { execArgv: ["--import", fileURLToPath(HELPER_URL)] }],
  ["相对路径形式", { execArgv: ["--import", "tests/helpers/pm-sdk-ab-owner.mjs"] }],
  ["无IPC", { connected: false }], ["错误NODE_ENV", { nodeEnv: "production" }], ["错误VITEST", { vitest: "false" }],
];
for (const [name, change] of preloadRejections) {
  await check(`R2 ${name}模块评估即拒绝`, async () => rejectedPreload(/** @type {any} */ (change)));
}

for (const role of [undefined, "O", "A"]) {
  await check(`R2 普通${role ?? "无role"}导入不装B`, async () => {
    /** @type {Record<string,string>} */ const env = { NODE_ENV: "test", VITEST: "true" };
    if (role !== undefined) env.PI_PM_AB_ROLE = role;
    const processLike = new FakeProcess({ env, execArgv: [] });
    const world = await createHelperWorld({ process: processLike });
    const helper = /** @type {any} */ ((await world.loadHelper(`${HELPER_URL.href}?ordinary-${role ?? "none"}`)).namespace);
    assert.equal(helper.guardState(), undefined);
    assert.equal(world.clock.intervals.size, 0);
  });
}

await check("R2 重复失败B状态拒绝且不重装", async () => {
  const processLike = new FakeProcess({ connected: true, execArgv: ["--import", HELPER_URL.href], env: {
    NODE_ENV: "test", VITEST: "true", PI_PM_AB_ROLE: "B", PI_PM_AB_PRELOAD: HELPER_URL.href,
  } });
  const world = await createHelperWorld({ process: processLike });
  const first = await world.loadHelper(`${HELPER_URL.href}?failed-first`);
  const originalKill = processLike.kill;
  assert.throws(() => processLike.kill(processLike.pid + 1, "SIGTERM"));
  assert.equal(/** @type {any} */ (first.namespace).guardState().failed, true);
  await assert.rejects(() => world.loadHelper(`${HELPER_URL.href}?failed-second`));
  assert.equal(processLike.kill, originalKill);
});

for (const event of ["exit", "close", "disconnect", errorMonitor, "error"]) {
  await check(`R3 observeChild前置监听失败局部释放:${String(event)}`, async () => {
    const world = await createHelperWorld({ childBehavior: { failOnChildEvent: event } });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    const guard = helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
    const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
    assert.equal(result.threw, true);
    assert.equal(world.child.nativeCalls.length, 0);
    assert.equal(guard.original(), undefined);
    assert.equal(world.clock.intervals.size, 0);
  });
}

for (const event of ["close", errorMonitor]) {
  await check(`R3 adapter追加监听失败局部释放:${String(event)}`, async () => {
    const world = await createHelperWorld({ childBehavior: { failOnChildEvent: event, failOnChildEventAt: 2 } });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    const guard = helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
    const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
    assert.equal(result.threw, true);
    assert.equal(world.child.nativeCalls.length, 0);
    assert.equal(guard.original(), undefined);
    assert.equal(world.clock.intervals.size, 0);
  });
}

for (const mode of ["short", "throw"]) {
  await check(`R3 reserve ${mode}确定未native有限收尾`, async () => {
    const world = await createHelperWorld({ writeSync: (_fd, frame) => {
      if (mode === "throw") throw new Error("reserve writer failed");
      return frame.length - 1;
    } });
    const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
    const latch = helper.createFailureLatch();
    const writer = helper.createControlWriter("n", latch);
    const guard = helper.installProcessGuard("A", latch, (/** @type {string} */ kind) => writer.send(kind), () => {});
    const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
    assert.equal(result.threw, true);
    assert.equal(world.child.nativeCalls.length, 0);
    assert.equal(guard.original(), undefined);
    assert.equal(world.clock.intervals.size, 0);
    assert.equal(latch.snapshot().failed, true);
  });
}

await check("R3 native返回后保留真实owner与ref", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const guard = helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
  const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(result.threw, false);
  assert.equal(result.value, world.child.children[0]);
  assert.equal(world.child.nativeCalls.length, 1);
  assert.equal(guard.original().child, result.value);
  assert.equal(world.clock.intervals.size, 1);
  assert.equal(guard.original().snapshot().ended, false);
});

await check("R3 native throw保持原throw、owner与ref", async () => {
  const world = await createHelperWorld();
  const token = Object.freeze({ native: "throw" });
  const native = world.child.cp.ChildProcess.prototype.spawn;
  world.child.cp.ChildProcess.prototype.spawn = function (...args) { Reflect.apply(native, this, args); throw token; };
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const guard = helper.installProcessGuard("A", helper.createFailureLatch(), () => {}, () => {});
  const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(result.threw, true);
  assert.equal(result.value, token);
  assert.equal(world.child.nativeCalls.length, 1);
  assert.equal(guard.original().child, world.child.children[0]);
  assert.equal(world.clock.intervals.size, 1);
});

await check("R3 bound报告失败不覆盖native返回或owner", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, (/** @type {string} */ kind) => { if (kind === "bound") throw new Error("bound report failed"); }, () => {});
  const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(result.threw, false);
  assert.equal(result.value, world.child.children[0]);
  assert.equal(guard.original().child, result.value);
  assert.equal(world.clock.intervals.size, 1);
  assert.equal(latch.snapshot().failed, true);
});

await check("R3 后置stream观察失败不覆盖native返回或owner", async () => {
  const world = await createHelperWorld({ childBehavior: { failOnStreamEvent: "close" } });
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const guard = helper.installProcessGuard("A", latch, () => {}, () => {});
  const result = capture(() => world.child.cp.fork("/worker.js", [], { stdio: "pipe", serialization: "advanced", execArgv: [], env: {} }));
  assert.equal(result.threw, false);
  assert.equal(result.value, world.child.children[0]);
  assert.equal(guard.original().child, result.value);
  assert.equal(world.clock.intervals.size, 1);
  assert.equal(latch.snapshot().code, "stdio-observation");
});

await check("E1/E2 O成功投影仅含原观察器、控制进度与分流字节", async () => {
  const { world, result } = await runOuter({ outputBytes: 7, extraOutputByte: true });
  const receipt = world.entry.ownerRunReceipt(result);
  assert.deepEqual({ ...receipt.observations.a }, {
    source: "O-original-A", exit: true, close: true, disconnected: true,
    streamsCaptured: true, ended: true, exitCode: 0, signal: null,
  });
  assert.equal(receipt.observations.waitResult, true);
  assert.deepEqual({ ...receipt.observations.control }, {
    sequence: 6, acceptedFrames: 6, successPhase: 6, bytes: Buffer.byteLength(controlFrames("01010101010101010101010101010101")),
    residualBytes: 0, endObserved: true, eof: true, complete: true,
  });
  assert.deepEqual({ ...receipt.observations.output }, {
    stdoutBytes: 7, stderrBytes: 1, totalBytes: 8,
    nonBufferObserved: false, budgetExceeded: false,
  });
  assert.equal(receipt.observations.aFailureReported, null);
  assert.deepEqual(Reflect.ownKeys(receipt.observations).sort(),
    ["a", "waitResult", "control", "output", "aFailureReported"].sort());
  for (const forbidden of ["child", "stream", "pid", "opaque", "latch"]) {
    assert.equal(Object.hasOwn(receipt.observations, forbidden), false);
    assert.equal(Object.hasOwn(receipt.observations.a, forbidden), false);
  }
  assert.equal(Object.isFrozen(receipt.observations), true);
  assert.equal(Object.isFrozen(receipt.observations.a), true);
  assert.equal(Object.isFrozen(receipt.observations.control), true);
  assert.equal(Object.isFrozen(receipt.observations.output), true);
});

await check("E1 失败终帧在六个健康前缀保留A与reader事实但永久失败", async () => {
  for (let prefix = 0; prefix <= 5; prefix += 1) {
    const { world, result } = await runOuter({ controlPrefix: prefix,
      failure: { phase: "vitest", code: "a-failed" } });
    const receipt = world.entry.ownerRunReceipt(result);
    assert.equal(world.process.exitCode, 1, `prefix=${prefix}`);
    assert.equal(receipt.owner.aEnded, true, `prefix=${prefix}`);
    assert.equal(receipt.owner.bEndedReported, false, `prefix=${prefix}`);
    assert.equal(receipt.owner.executionCandidate, false, `prefix=${prefix}`);
    assert.equal(receipt.observations.a.ended, true, `prefix=${prefix}`);
    assert.equal(receipt.observations.waitResult, true, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.sequence, prefix + 1, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.acceptedFrames, prefix + 1, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.successPhase, prefix, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.endObserved, true, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.eof, false, `prefix=${prefix}`);
    assert.equal(receipt.observations.control.complete, false, `prefix=${prefix}`);
    assert.deepEqual({ ...receipt.observations.aFailureReported }, { phase: "vitest", code: "a-failed" });
  }
});

await check("E1 partial与EOF、A非零、signal及wait=false均保留不猜测事实", async () => {
  const partial = await runOuter({ controlPrefix: 0, controlSuffix: Buffer.from('{"v":1') });
  const partialReceipt = partial.world.entry.ownerRunReceipt(partial.result);
  assert.equal(partialReceipt.observations.control.sequence, 0);
  assert.equal(partialReceipt.observations.control.acceptedFrames, 0);
  assert.equal(partialReceipt.observations.control.residualBytes, 6);
  assert.equal(partialReceipt.observations.control.endObserved, true);
  assert.equal(partialReceipt.observations.control.eof, false);
  assert.equal(partialReceipt.owner.aEnded, true);

  const nonzero = await runOuter({ exitCode: 9 });
  const nonzeroReceipt = nonzero.world.entry.ownerRunReceipt(nonzero.result);
  assert.equal(nonzeroReceipt.observations.a.exitCode, 9);
  assert.equal(nonzeroReceipt.observations.a.signal, null);
  assert.equal(nonzeroReceipt.observations.a.ended, true);
  assert.equal(nonzeroReceipt.owner.bEndedReported, true);

  const signalled = await runOuter({ exitCode: null, signal: "SIGTERM" });
  const signalReceipt = signalled.world.entry.ownerRunReceipt(signalled.result);
  assert.equal(signalReceipt.observations.a.exitCode, null);
  assert.equal(signalReceipt.observations.a.signal, "SIGTERM");
  assert.equal(signalReceipt.owner.executionCandidate, false);

  const timed = await runOuter({ closeDataStreams: false, advanceWaitTimeout: true });
  const timedReceipt = timed.world.entry.ownerRunReceipt(timed.result);
  assert.equal(timedReceipt.observations.waitResult, false);
  assert.equal(timedReceipt.observations.a.ended, false);
  assert.equal(timedReceipt.owner.executionCandidate, false);
  timed.child.stdin.emit("close"); timed.child.stdout.emit("close"); timed.child.stderr.emit("close");
  assert.equal(timed.world.entry.ownerRunReceipt(timed.result).observations.a.ended, true);
  assert.equal(timed.world.helperWorld.clock.intervals.size, 0);
});

await check("E1 post-run坐标gate失败仍保留gate前事实且旧快照冻结", async () => {
  const { world, result } = await runOuter({ corruptRootConfig: true });
  const first = world.entry.ownerRunReceipt(result);
  assert.equal(first.failure.phase, "post-run-verification");
  assert.equal(first.owner.aEnded, true);
  assert.equal(first.owner.bEndedReported, true);
  assert.equal(first.observations.a.ended, true);
  assert.equal(first.observations.control.successPhase, 6);
  assert.equal(first.observations.control.endObserved, true);
  assert.equal(first.observations.control.complete, false);
  world.process.emit("unhandledRejection", Object.freeze({ later: true }));
  const current = world.entry.ownerRunReceipt(result);
  assert.equal(current.failure.failed, true);
  assert.equal(current.owner.executionCandidate, false);
  assert.equal(first.owner.executionCandidate, false);
  assert.notEqual(current, first);
  assert.equal(Object.isFrozen(first), true);
});

await check("E1/E4 stdout与stderr独立计数、1MiB边界和未知chunk不强转", async () => {
  const exact = await runOuter({ outputBytes: 1048575, extraOutputByte: true });
  const exactOutput = exact.world.entry.ownerRunReceipt(exact.result).observations.output;
  assert.deepEqual({ ...exactOutput }, { stdoutBytes: 1048575, stderrBytes: 1, totalBytes: 1048576,
    nonBufferObserved: false, budgetExceeded: false });
  assert.equal(exact.world.entry.ownerReceipt(exact.world.sceneHandle()).executionCandidate, true);

  const over = await runOuter({ outputBytes: 1048576, extraOutputByte: true });
  const overOutput = over.world.entry.ownerRunReceipt(over.result).observations.output;
  assert.equal(overOutput.stdoutBytes, 1048576);
  assert.equal(overOutput.stderrBytes, 1);
  assert.equal(overOutput.totalBytes, 1048577);
  assert.equal(overOutput.budgetExceeded, true);
  assert.equal(over.world.entry.ownerReceipt(over.world.sceneHandle()).executionCandidate, false);

  let conversions = 0;
  const unknown = Object.create(null);
  for (const key of ["toString", "valueOf", Symbol.toPrimitive]) {
    Object.defineProperty(unknown, key, { get() { conversions += 1; throw new Error("converted"); } });
  }
  const nonBuffer = await runOuter({ nonBufferOutput: unknown });
  const unknownOutput = nonBuffer.world.entry.ownerRunReceipt(nonBuffer.result).observations.output;
  assert.equal(unknownOutput.stdoutBytes, 0);
  assert.equal(unknownOutput.stderrBytes, 0);
  assert.equal(unknownOutput.totalBytes, 0);
  assert.equal(unknownOutput.nonBufferObserved, true);
  assert.equal(unknownOutput.budgetExceeded, false);
  assert.equal(conversions, 0);
});

await check("E3 writer失败终帧共享序号预算、单次占位、短写不重试", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  const writer = helper.createControlWriter("n", latch);
  writer.send("ready");
  latch.fail("business-result");
  assert.equal(writer.sendFailureOnce("business", latch.snapshot().code), true);
  assert.equal(writer.sendFailureOnce("business", latch.snapshot().code), false);
  assert.throws(() => writer.send("final"));
  assert.equal(world.writes.length, 2);
  assert.deepEqual(JSON.parse(world.writes[1].toString()),
    { v: 1, n: "n", s: 2, k: "a-failure", p: "business", c: "business-result" });

  let attempts = 0;
  const short = await createHelperWorld({ writeSync: (_fd, frame) => { attempts += 1; return attempts === 1 ? frame.length : frame.length - 1; } });
  const shortHelper = /** @type {any} */ ((await short.loadHelper()).namespace);
  const shortLatch = shortHelper.createFailureLatch();
  const shortWriter = shortHelper.createControlWriter("n", shortLatch);
  shortWriter.send("ready"); shortLatch.fail("a-failed");
  assert.equal(shortWriter.sendFailureOnce("vitest", "a-failed"), false);
  assert.equal(shortWriter.sendFailureOnce("vitest", "a-failed"), false);
  assert.equal(attempts, 2);
  assert.equal(short.writes.length, 2);

  const unknownLatch = helper.createFailureLatch();
  const unknownWriter = helper.createControlWriter("u", unknownLatch);
  unknownLatch.fail("not-an-allowed-code");
  assert.equal(unknownWriter.sendFailureOnce("vitest", unknownLatch.snapshot().code), true);
  const unknownFrame = world.writes.at(-1);
  assert.ok(unknownFrame);
  assert.equal(JSON.parse(unknownFrame.toString()).c, "a-failed");
});

await check("E3 writer第129个共享名额和32768总预算不可由失败诊断绕过", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch();
  let nonce = "";
  for (let length = 1; length < 300; length += 1) {
    const candidate = "n".repeat(length);
    const empty = Buffer.byteLength(JSON.stringify({ v: 1, n: candidate, s: 1, k: "" }) + "\n");
    if (256 - empty >= 3 && 256 - empty <= 20) { nonce = candidate; break; }
  }
  const writer = helper.createControlWriter(nonce, latch);
  for (let sequence = 1; sequence <= 128; sequence += 1) {
    const empty = Buffer.byteLength(JSON.stringify({ v: 1, n: nonce, s: sequence, k: "" }) + "\n");
    writer.send("x".repeat(256 - empty));
  }
  latch.fail("a-failed");
  assert.equal(writer.sendFailureOnce("final", "a-failed"), false);
  assert.equal(world.writes.length, 128);
  assert.equal(world.writes.reduce((sum, frame) => sum + frame.length, 0), 32768);
});

await check("E3 reader严核失败终帧身份、schema、枚举、顺序与终态", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const valid = (/** @type {number} */ sequence, /** @type {string} */ phase = "vitest", /** @type {string} */ code = "a-failed") =>
    JSON.stringify({ v: 1, n: "n", s: sequence, k: "a-failure", p: phase, c: code }) + "\n";
  for (const [name, text] of [
    ["wrong-nonce", JSON.stringify({ v: 1, n: "x", s: 1, k: "a-failure", p: "vitest", c: "a-failed" }) + "\n"],
    ["wrong-sequence", valid(2)],
    ["unknown-phase", valid(1, "internal-secret")],
    ["unknown-code", valid(1, "vitest", "message-text")],
    ["extra-key", JSON.stringify({ v: 1, n: "n", s: 1, k: "a-failure", p: "vitest", c: "a-failed", x: 1 }) + "\n"],
    ["noncanonical", '{"n":"n","v":1,"s":1,"k":"a-failure","p":"vitest","c":"a-failed"}\n'],
  ]) {
    const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
    const reader = helper.createControlReader(owner, stream, "n", latch);
    reader.accept(owner, stream, Buffer.from(text));
    assert.equal(latch.snapshot().failed, true, name);
    assert.equal(reader.snapshot().aFailureReported, null, name);
  }
  const identityLatch = helper.createFailureLatch(); const owner = {}; const stream = {};
  const identityReader = helper.createControlReader(owner, stream, "n", identityLatch);
  identityReader.accept({}, stream, Buffer.from(valid(1)));
  assert.equal(identityLatch.snapshot().failed, true);
  assert.equal(identityReader.snapshot().aFailureReported, null);

  const finalLatch = helper.createFailureLatch();
  const finalReader = helper.createControlReader(owner, stream, "n", finalLatch);
  finalReader.accept(owner, stream, Buffer.from(controlFrames("n")));
  finalReader.accept(owner, stream, Buffer.from(valid(7)));
  assert.equal(finalLatch.snapshot().failed, true);
  assert.equal(finalReader.snapshot().aFailureReported, null);

  const doubleLatch = helper.createFailureLatch();
  const doubleReader = helper.createControlReader(owner, stream, "n", doubleLatch);
  doubleReader.accept(owner, stream, Buffer.from(valid(1) + valid(2)));
  assert.equal(doubleLatch.snapshot().failed, true);
  assert.deepEqual({ ...doubleReader.snapshot().aFailureReported }, { phase: "vitest", code: "a-failed" });
  assert.equal(doubleReader.snapshot().acceptedFrames, 1);
});

await check("E3 合法失败终帧不推进成功phase且物理end不冒充成功EOF", async () => {
  const world = await createHelperWorld();
  const helper = /** @type {any} */ ((await world.loadHelper()).namespace);
  const latch = helper.createFailureLatch(); const owner = {}; const stream = {};
  const reader = helper.createControlReader(owner, stream, "n", latch);
  reader.accept(owner, stream, Buffer.from('{"v":1,"n":"n","s":1,"k":"ready"}\n'));
  reader.accept(owner, stream, Buffer.from('{"v":1,"n":"n","s":2,"k":"a-failure","p":"early-config","c":"early-config"}\n'));
  assert.deepEqual({ ...reader.snapshot().aFailureReported }, { phase: "early-config", code: "early-config" });
  assert.equal(reader.snapshot().successPhase, 1);
  assert.equal(reader.snapshot().acceptedFrames, 2);
  assert.equal(reader.snapshot().endObserved, false);
  assert.equal(reader.snapshot().eof, false);
  assert.equal(reader.snapshot().complete, false);
  reader.end(owner, stream);
  assert.equal(reader.snapshot().endObserved, true);
  assert.equal(reader.snapshot().eof, false);
  reader.accept(owner, stream, Buffer.from('{"v":1,"n":"n","s":3,"k":"final"}\n'));
  assert.equal(reader.snapshot().successPhase, 1);
});

await check("E4 A固定阶段和错误码不读取opaque且不新增child/kill/close", async () => {
  let reads = 0;
  const opaque = new Proxy(Object.create(null), {
    get() { reads += 1; throw new Error("opaque get"); },
    ownKeys() { reads += 1; throw new Error("opaque keys"); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error("opaque descriptor"); },
  });
  const world = await createEntryWorld({ startThrow: opaque });
  await world.runA();
  assert.equal(world.process.exitCode, 1);
  assert.equal(world.fd3Closed(), false);
  assert.equal(world.helperWorld.child.forks.length, 0);
  assert.deepEqual(world.helperWorld.child.killSignals, []);
  assert.equal(reads, 0);
  assert.equal(world.helperWorld.writes.length, 2);
  const failure = JSON.parse(world.helperWorld.writes[1].toString());
  assert.deepEqual(failure, { v: 1, n: "0123456789abcdef0123456789abcdef", s: 2,
    k: "a-failure", p: "vitest", c: "a-failed" });

  const early = await createEntryWorld({ unsafeConfig: true });
  await early.runA();
  const earlyFrame = early.helperWorld.writes.at(-1);
  assert.ok(earlyFrame);
  const earlyFailure = JSON.parse(earlyFrame.toString());
  assert.equal(earlyFailure.k, "a-failure");
  assert.equal(earlyFailure.p, "early-config");
  assert.equal(earlyFailure.c, "early-config");
});

await check("E4 握手未完整不发送诊断，原fd3短写只尝试一次且不重发", async () => {
  const handshake = await createEntryWorld();
  await handshake.runA([Buffer.from("{")]);
  assert.equal(handshake.helperWorld.writes.length, 0);
  assert.equal(handshake.fd3Closed(), false);

  let attempts = 0;
  const short = await createEntryWorld({ controlWriteSync: (_fd, frame) => { attempts += 1; return frame.length - 1; } });
  await short.runA();
  assert.equal(short.process.exitCode, 1);
  assert.equal(attempts, 1);
  assert.equal(short.helperWorld.writes.length, 1);
  assert.equal(short.fd3Closed(), false);
  assert.equal(short.helperWorld.child.forks.length, 0);
  assert.deepEqual(short.helperWorld.child.killSignals, []);
});

await check("关键变异：owner绑定与envDir前置断言能杀死变异", async () => {
  const baseline = await createHelperWorld();
  const baselineHelper = /** @type {any} */ ((await baseline.loadHelper()).namespace);
  const latch = baselineHelper.createFailureLatch(); const owner = {}; const stream = {};
  const reader = baselineHelper.createControlReader(owner, stream, "n", latch);
  reader.accept({}, stream, Buffer.from('{"v":1,"n":"n","s":1,"k":"ready"}\n'));
  assert.equal(latch.snapshot().failed, true, "baseline必须先拒绝伪owner");
  const ownerAnchor = "if (owner !== actualOwner || stream !== actualStream) throw rejection();";
  assert.equal(HELPER_SOURCE.split(ownerAnchor).length - 1, 1);
  const mutantWorld = await createHelperWorld({ helperSource: HELPER_SOURCE.replace(ownerAnchor, "if (false) throw rejection();") });
  const mutant = /** @type {any} */ ((await mutantWorld.loadHelper()).namespace);
  assert.throws(() => {
    const mLatch = mutant.createFailureLatch(); const mOwner = {}; const mStream = {};
    const mReader = mutant.createControlReader(mOwner, mStream, "n", mLatch);
    mReader.accept({}, mStream, Buffer.from('{"v":1,"n":"n","s":1,"k":"ready"}\n'));
    assert.equal(mLatch.snapshot().failed, true);
  }, AssertionError);

  const baselineEntry = await createEntryWorld();
  const safe = { root: PROJECT, cacheDir: EXPECTED_CACHE_DIR, envDir: ROOT, publicDir: false,
    server: { middlewareMode: true, ws: false, hmr: false, watch: null, open: false, preTransformRequests: false },
    configFile: `${ROOT}/vitest.config.ts` };
  assert.throws(() => baselineEntry.entry.assertSafeConfig(safe, { root: ROOT }, false));
  const configAnchor = "config.cacheDir !== expectedCacheDir || config.envDir !== false ||";
  assert.equal(ENTRY_SOURCE.split(configAnchor).length - 1, 1);
  const mutantEntry = await createEntryWorld({}, ENTRY_SOURCE.replace(configAnchor, "config.cacheDir !== expectedCacheDir || false ||"));
  assert.throws(() => assert.throws(() => mutantEntry.entry.assertSafeConfig(safe, { root: ROOT }, false)), AssertionError);
});

await check("cache精确等值退回base与前缀放宽变异均由AssertionError杀死", async () => {
  const baselineEntry = await createEntryWorld();
  const safeServer = { middlewareMode: true, ws: false, hmr: false, watch: null, open: false, preTransformRequests: false };
  const baseConfig = { root: PROJECT, cacheDir: BASE_CACHE_DIR, envDir: false, publicDir: false,
    server: safeServer, configFile: `${ROOT}/vitest.config.ts` };
  const childConfig = { ...baseConfig, cacheDir: join(BASE_CACHE_DIR, "arbitrary-child") };
  assert.throws(() => baselineEntry.entry.assertSafeConfig(baseConfig, { root: ROOT }, false));
  assert.throws(() => baselineEntry.entry.assertSafeConfig(childConfig, { root: ROOT }, false));

  const exactAnchor = "config.cacheDir !== expectedCacheDir";
  assert.equal(ENTRY_SOURCE.split(exactAnchor).length - 1, 1);
  const baseFallbackSource = ENTRY_SOURCE.replace(exactAnchor,
    "(config.cacheDir !== expectedCacheDir && config.cacheDir !== p.cacheDir)");
  const baseFallback = await createEntryWorld({}, baseFallbackSource);
  assert.throws(() => assert.throws(
    () => baseFallback.entry.assertSafeConfig(baseConfig, { root: ROOT }, false),
  ), AssertionError);

  const prefixSource = ENTRY_SOURCE.replace(exactAnchor, "!config.cacheDir.startsWith(p.cacheDir)");
  const prefix = await createEntryWorld({}, prefixSource);
  assert.throws(() => assert.throws(
    () => prefix.entry.assertSafeConfig(childConfig, { root: ROOT }, false),
  ), AssertionError);
});

await check("R4 当前收据失效保护的有效变异", async () => {
  const anchor = "run.facts.executionCandidate === true && !run.latch.snapshot().failed";
  assert.equal(ENTRY_SOURCE.split(anchor).length, 2);
  const mutant = ENTRY_SOURCE.replace(anchor, "run.facts.executionCandidate === true");
  const { world } = await runOuter({}, mutant);
  const handle = world.sceneHandle();
  assert.equal(world.entry.ownerReceipt(handle).executionCandidate, true);
  world.process.emit("unhandledRejection", Object.freeze({ late: true }));
  assert.equal(world.process.exitCode, 1);
  assert.throws(() => assert.equal(world.entry.ownerReceipt(handle).executionCandidate, false), AssertionError);
});

await check("E5 六个新增变异均成功加载后由真实AssertionError杀死", async () => {
  const gateAnchor = "const observed = original.snapshot();\n    preserveFacts(false);\n    phase = \"post-run-verification\";";
  assert.equal(ENTRY_SOURCE.split(gateAnchor).length, 2);
  const gateMutant = ENTRY_SOURCE.replace(gateAnchor,
    "const observed = original.snapshot();\n    phase = \"post-run-verification\";");
  const gate = await runOuter({ corruptRootConfig: true }, gateMutant);
  assert.throws(() => assert.equal(gate.world.entry.ownerRunReceipt(gate.result).owner.bEndedReported, true), AssertionError);

  const completeAnchor = "complete: !latch.snapshot().failed && eof && phase === expected.length,";
  assert.equal(HELPER_SOURCE.split(completeAnchor).length, 2);
  const completeMutant = HELPER_SOURCE.replace(completeAnchor,
    "complete: endObserved || (!latch.snapshot().failed && eof && phase === expected.length),");
  const completeWorld = await createHelperWorld({ helperSource: completeMutant });
  const completeHelper = /** @type {any} */ ((await completeWorld.loadHelper()).namespace);
  const completeLatch = completeHelper.createFailureLatch(); const completeOwner = {}; const completeStream = {};
  const completeReader = completeHelper.createControlReader(completeOwner, completeStream, "n", completeLatch);
  completeReader.end(completeOwner, completeStream);
  assert.throws(() => assert.equal(completeReader.snapshot().complete, false), AssertionError);

  const phaseAnchor = "acceptedFrames++;\n            aFailureReported = Object.freeze({ phase: frame.p, code: frame.c });";
  assert.equal(HELPER_SOURCE.split(phaseAnchor).length, 2);
  const phaseMutant = HELPER_SOURCE.replace(phaseAnchor,
    "acceptedFrames++;\n            phase = expected.length;\n            aFailureReported = Object.freeze({ phase: frame.p, code: frame.c });");
  const phaseWorld = await createHelperWorld({ helperSource: phaseMutant });
  const phaseHelper = /** @type {any} */ ((await phaseWorld.loadHelper()).namespace);
  const phaseLatch = phaseHelper.createFailureLatch(); const phaseOwner = {}; const phaseStream = {};
  const phaseReader = phaseHelper.createControlReader(phaseOwner, phaseStream, "n", phaseLatch);
  phaseReader.accept(phaseOwner, phaseStream,
    Buffer.from('{"v":1,"n":"n","s":1,"k":"a-failure","p":"vitest","c":"a-failed"}\n'));
  assert.throws(() => assert.equal(phaseReader.snapshot().successPhase, 0), AssertionError);

  const budgetAnchor = "const frame = encode({ v: 1, n: nonce, s: next, k: \"a-failure\", p: phase, c: code });";
  assert.equal(HELPER_SOURCE.split(budgetAnchor).length, 2);
  const budgetMutant = HELPER_SOURCE.replace(budgetAnchor,
    "const frame = Buffer.from(JSON.stringify({ v: 1, n: nonce, s: next, k: \"a-failure\", p: phase, c: code }) + \"\\n\");");
  const budgetWorld = await createHelperWorld({ helperSource: budgetMutant });
  const budgetHelper = /** @type {any} */ ((await budgetWorld.loadHelper()).namespace);
  const budgetLatch = budgetHelper.createFailureLatch();
  let budgetNonce = "";
  for (let length = 1; length < 300; length += 1) {
    const candidate = "n".repeat(length);
    const empty = Buffer.byteLength(JSON.stringify({ v: 1, n: candidate, s: 1, k: "" }) + "\n");
    if (256 - empty >= 3 && 256 - empty <= 20) { budgetNonce = candidate; break; }
  }
  const budgetWriter = budgetHelper.createControlWriter(budgetNonce, budgetLatch);
  for (let sequence = 1; sequence <= 128; sequence += 1) {
    const empty = Buffer.byteLength(JSON.stringify({ v: 1, n: budgetNonce, s: sequence, k: "" }) + "\n");
    budgetWriter.send("x".repeat(256 - empty));
  }
  budgetLatch.fail("a-failed");
  assert.throws(() => assert.equal(budgetWriter.sendFailureOnce("final", "a-failed"), false), AssertionError);

  const ordinaryAnchor = "send(kind) {\n      try {\n        latch.assert();\n        if (terminal || !writeHealthy || failureReserved || !/^[a-z-]{1,24}$/u.test(kind)) throw rejection();";
  assert.equal(HELPER_SOURCE.split(ordinaryAnchor).length, 2);
  const ordinaryMutant = HELPER_SOURCE.replace(ordinaryAnchor,
    "send(kind) {\n      try {\n        if (!writeHealthy || !/^[a-z-]{1,24}$/u.test(kind)) throw rejection();");
  const ordinaryWorld = await createHelperWorld({ helperSource: ordinaryMutant });
  const ordinaryHelper = /** @type {any} */ ((await ordinaryWorld.loadHelper()).namespace);
  const ordinaryLatch = ordinaryHelper.createFailureLatch();
  const ordinaryWriter = ordinaryHelper.createControlWriter("n", ordinaryLatch);
  ordinaryLatch.fail("a-failed"); ordinaryWriter.sendFailureOnce("vitest", "a-failed");
  assert.throws(() => assert.throws(() => ordinaryWriter.send("ready")), AssertionError);

  const opaqueAnchor = "fail(diagnostic, error) {\n      if (!failed) { failed = true; first = { value: error }; code = diagnostic; }";
  assert.equal(HELPER_SOURCE.split(opaqueAnchor).length, 2);
  const opaqueMutant = HELPER_SOURCE.replace(opaqueAnchor,
    "fail(diagnostic, error) {\n      String(error);\n      if (!failed) { failed = true; first = { value: error }; code = diagnostic; }");
  const opaqueWorld = await createHelperWorld({ helperSource: opaqueMutant });
  const opaqueHelper = /** @type {any} */ ((await opaqueWorld.loadHelper()).namespace);
  let opaqueReads = 0;
  const opaque = new Proxy(Object.create(null), { get() { opaqueReads += 1; return () => "opaque"; } });
  const opaqueLatch = opaqueHelper.createFailureLatch();
  opaqueLatch.fail("a-failed", opaque);
  assert.throws(() => assert.equal(opaqueReads, 0), AssertionError);
});

await check("F1/F2/F3新增保护的有效变异", async () => {
  const writeAnchor = "        } catch (error) {\n          writeHealthy = false;\n          throw error;\n        }";
  assert.equal(HELPER_SOURCE.split(writeAnchor).length, 2);
  const writeMutant = HELPER_SOURCE.replace(writeAnchor, "        } catch (error) {\n          throw error;\n        }");
  let attempts = 0;
  const writeWorld = await createHelperWorld({ helperSource: writeMutant, writeSync: (_fd, frame) => {
    attempts += 1;
    if (attempts === 1) throw new Error("first write failed");
    return frame.length;
  } });
  const writeHelper = /** @type {any} */ ((await writeWorld.loadHelper()).namespace);
  const writeLatch = writeHelper.createFailureLatch();
  const writeWriter = writeHelper.createControlWriter("n", writeLatch);
  assert.throws(() => writeWriter.send("ready"));
  assert.throws(() => assert.equal(writeWriter.sendFailureOnce("spec", writeLatch.snapshot().code), false), AssertionError);

  const forkAnchor = "    } catch (error) {\n      latch.fail(\"fork-contract\", error);\n      throw error;\n    }";
  assert.equal(ENTRY_SOURCE.split(forkAnchor).length, 2);
  const forkMutant = ENTRY_SOURCE.replace(forkAnchor, "    } catch (error) {\n      throw error;\n    }");
  const forkWorld = await createEntryWorld({ bCf: OBSERVED_USER_TEXT_ENCODING }, forkMutant);
  await forkWorld.runA();
  const forkEncoded = forkWorld.helperWorld.writes.at(-1);
  assert.ok(forkEncoded);
  const forkFrame = JSON.parse(forkEncoded.toString());
  assert.throws(() => assert.equal(forkFrame.p, "spec"), AssertionError);

  const finalAnchor = "        for (let index = 0; index < chunk.length; index += 1) {\n          if (phase === expected.length) throw rejection();";
  assert.equal(HELPER_SOURCE.split(finalAnchor).length, 2);
  const finalMutant = HELPER_SOURCE.replace(finalAnchor,
    "        for (let index = 0; index < chunk.length; index += 1) {\n          if (false) throw rejection();");
  const finalWorld = await createHelperWorld({ helperSource: finalMutant });
  const finalHelper = /** @type {any} */ ((await finalWorld.loadHelper()).namespace);
  const finalLatch = finalHelper.createFailureLatch(); const finalOwner = {}; const finalStream = {};
  const finalReader = finalHelper.createControlReader(finalOwner, finalStream, "n", finalLatch);
  const finalFailure = JSON.stringify({ v: 1, n: "n", s: 7, k: "a-failure", p: "spec", c: "fork-contract" }) + "\n";
  finalReader.accept(finalOwner, finalStream, Buffer.from(controlFrames("n") + finalFailure));
  assert.throws(() => assert.equal(finalReader.snapshot().acceptedFrames, 6), AssertionError);
});

console.log(`SUMMARY total=${total} failed=${failures.length}`);
for (const failure of failures) console.error(`CONTRACT_FAILURE ${failure.name}`);
if (failures.length) process.exitCode = 1;
