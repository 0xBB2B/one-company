// @ts-check
import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, errorMonitor } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

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
const CONFIG_BYTES = 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["tests/**/*.test.ts"],\n    environment: "node",\n    pool: "forks",\n    isolate: true,\n    fileParallelism: false,\n    testTimeout: 5_000,\n    setupFiles: ["./tests/helpers/test-environment.ts"],\n  },\n});\n';
const CONFIG_HASH = `sha256:${createHash("sha256").update(CONFIG_BYTES).digest("hex")}`;
const VITEST_TARGET = join(PROJECT, "node_modules/vitest");
const PARENT_BINDING = JSON.stringify({ path: ROOT, dev: "7", ino: "77" });

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

function aEnvironment() {
  return {
    HOME: `${ROOT}/home`, PI_CODING_AGENT_DIR: `${ROOT}/home/.pi/agent`,
    XDG_CONFIG_HOME: `${ROOT}/home/.config`, XDG_CACHE_HOME: `${ROOT}/home/.cache`,
    TMPDIR: `${ROOT}/tmp`, PI_COMPANY_TEST_PARENT_BINDING: PARENT_BINDING,
    NODE_ENV: "test", LANG: "C", LC_ALL: "C",
  };
}

/** @typedef {{unsafeConfig?:boolean, specs?:"one"|"empty"|"many"|"wrong", stop?:"before"|"after", earlyPatch?:(config:any)=>void, resolvedPatch?:(config:any)=>void, specProject?:"wrong", specPool?:string, duplicateStart?:boolean, testName?:string, testCount?:number, testState?:string, moduleState?:string, reason?:string, runErrors?:unknown[], unhandled?:unknown[], hang?:boolean, lateWorkerError?:boolean, childBehavior?:ChildBehavior, sceneFailure?:SceneFailureMode, guardInstallFailure?:unknown}} StartBehavior */
/** @param {StartBehavior} behavior @param {any} cp @param {FakeProcess} processLike */
function createStartVitest(behavior, cp, processLike) {
  /** @type {any[]} */ const effects = [];
  /** @type {any} */ let worker;
  let returned = false;
  let entered = false;
  /** @type {(() => void) | undefined} */ let releaseHang;
  /** @param {string} _mode @param {string[]} _filters @param {any} options @param {any} viteOptions */
  async function startVitest(_mode, _filters, options, viteOptions) {
    entered = true;
    const reporter = options.reporters[0];
    const plugin = viteOptions.plugins[0];
    const early = {
      root: viteOptions.root, cacheDir: viteOptions.cacheDir,
      envDir: behavior.unsafeConfig ? ROOT : false,
      publicDir: false, server: viteOptions.server,
      configFile: options.config, plugins: [plugin],
    };
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
    worker = cp.fork(join(VITEST_TARGET, "dist/workers/forks.js"), [], {
      stdio: "pipe", serialization: "advanced", execArgv: expectedArgs,
      env: { ...aEnvironment(), TEST: "true", VITEST: "true", VITEST_MODE: "RUN", FORCE_TTY: "",
        PROD: "", DEV: "1", BASE_URL: "/", MODE: "test", PI_PM_AB_ROLE: "B", PI_PM_AB_PRELOAD: options.execArgv[1] },
    });
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
    release() { const release = releaseHang; releaseHang = undefined; release?.(); },
  };
}

/** @param {StartBehavior} [behavior] @param {string} [entrySource] */
async function createEntryWorld(behavior = {}, entrySource = ENTRY_SOURCE) {
  const processLike = new FakeProcess({
    env: aEnvironment(), argv: [NODE, "/virtual/not-direct.mjs", "--internal-pm-sdk-ab-owner-A", "0123456789abcdef0123456789abcdef"],
  });
  const helperWorld = await createHelperWorld({ process: processLike, childBehavior: behavior.childBehavior });
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

/** @typedef {{chunks?:number[], eof?:boolean, closeControl?:boolean, closeDataStreams?:boolean, outputBytes?:number, extraOutputByte?:boolean, outputError?:boolean, ownerOutputThrow?:unknown, exitCode?:number|null, signal?:string|null}} OuterCompletion */
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
  if (options.outputError) child.stdout.emit("error", new Error("stdout failed"));
  if (options.eof !== false) child.control.emit("end");
  if (options.closeDataStreams !== false) {
    child.stdin.emit("close"); child.stdout.emit("close"); child.stderr.emit("close");
  }
  if (options.closeControl !== false) child.control.emit("close");
  child.emit("exit", options.exitCode ?? 0, options.signal ?? null);
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
      for (const kind of ["ready", "reserve", "bound", "business-pass", "b-ended", "final"]) writer.send(kind);
      assert.equal(latch.snapshot().failed, false);
      const frames = reportWorld.writes.slice(start);
      assert.equal(frames.length, 6);
      reports += 1;
      completeOuterChild(child, Buffer.concat(frames), completion);
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
    onInputEnd(actualChild, handshake) { child = actualChild; reportEndpoint.send(actualChild, handshake, completion); },
  } }, entrySource);
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = {};
  if (Object.hasOwn(completion, "ownerOutputThrow")) {
    world.process.stdout.write = () => { throw completion.ownerOutputThrow; };
  }
  const result = await world.entry.main();
  assert.equal(reportEndpoint.reports(), 1);
  assert.equal(reportEndpoint.reportWorld.writes.length, 6);
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
  world.process.env = {};
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

await check("O guard安装失败返回原结果身份和固定失败阶段", async () => {
  let opaqueReads = 0;
  const opaque = new Proxy(Object.create(null), {
    get() { opaqueReads += 1; throw new Error("guard error read"); },
    ownKeys() { opaqueReads += 1; throw new Error("guard error keys read"); },
    getOwnPropertyDescriptor() { opaqueReads += 1; throw new Error("guard error descriptor read"); },
  });
  const world = await createEntryWorld({ guardInstallFailure: opaque });
  world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
  world.process.env = {};
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
  world.process.env = {};
  const result = await world.entry.main();
  assert.equal(result.scene, null);
  assert.equal(world.sceneCalls(), 0);
  const receipt = world.entry.ownerRunReceipt(result);
  assert.equal(receipt.owner, undefined);
  assert.deepEqual({ ...receipt.failure }, { failed: true, code: "o-failed", phase: "fixture-check" });
  assert.equal(receipt.allocationFailure, undefined);
});

for (const [mode, expected] of /** @type {const} */ ([
  ["before-allocation", { phase: "package-input", attempted: false, root: null, identity: null }],
  ["attempt-no-path", { phase: "allocate-root", attempted: true, root: null, identity: null }],
  ["path-no-identity", { phase: "secure-root", attempted: true, root: "/tmp/pi-s-memory01", identity: null }],
])) {
  await check(`O Scene factory失败保留安全定位:${mode}`, async () => {
    const world = await createEntryWorld({ sceneFailure: mode });
    world.process.argv = [NODE, fileURLToPath(ENTRY_URL), "--authorize=M4-PM-SDK-AB-OWNER", "--case=vitest-fork"];
    world.process.env = {};
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
  world.process.env = {};
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
  ["cacheDir", (config) => { config.cacheDir = "/wrong"; }],
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
  const safe = { root: PROJECT, cacheDir: `${ROOT}/cache`, envDir: ROOT, publicDir: false,
    server: { middlewareMode: true, ws: false, hmr: false, watch: null, open: false, preTransformRequests: false },
    configFile: `${ROOT}/vitest.config.ts` };
  assert.throws(() => baselineEntry.entry.assertSafeConfig(safe, { root: ROOT }, false));
  const configAnchor = "config.cacheDir !== p.cacheDir || config.envDir !== false ||";
  assert.equal(ENTRY_SOURCE.split(configAnchor).length - 1, 1);
  const mutantEntry = await createEntryWorld({}, ENTRY_SOURCE.replace(configAnchor, "config.cacheDir !== p.cacheDir || false ||"));
  assert.throws(() => assert.throws(() => mutantEntry.entry.assertSafeConfig(safe, { root: ROOT }, false)), AssertionError);
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

console.log(`SUMMARY total=${total} failed=${failures.length}`);
for (const failure of failures) console.error(`CONTRACT_FAILURE ${failure.name}`);
if (failures.length) process.exitCode = 1;
