// @ts-check
import assert, { AssertionError } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path, { dirname, join, normalize } from "node:path";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const TEMPORARY_ROOT_SOURCE = join(TESTS, "helpers", "temporary-root.ts");
const TEST_ENVIRONMENT_SOURCE = join(TESTS, "helpers", "test-environment.ts");
const BINDING_ENV = "PI_COMPANY_TEST_PARENT_BINDING";
const ROOT_PROPERTY = "__piCompanyTestTemporaryRoot";
const STATE_PROPERTY = "__piCompanyTestTemporaryRootState";
const NON_OWNER_PROPERTY = "__piCompanyTestTemporaryRootNonOwner";
const UID = 501n;

/** @typedef {{ kind: "directory" | "symlink", mode: bigint, uid: bigint, dev: bigint, ino: bigint, target?: string }} Entry */
/** @typedef {{ recursive?: boolean, mode?: number }} MkdirOptions */
/** @typedef {{ name: "mkdirSync", path: string, options: MkdirOptions } | { name: "lstatSync", path: string, options: { bigint?: boolean } } | { name: "chmodSync", path: string, options: number } | { name: "mkdtempSync" | "realpathSync" | "rmdirSync", path: string }} FsCall */
/** @typedef {{ temporaryRoot(): string, cleanupTemporaryRoot(): void, isTemporaryRootManaged(): boolean }} TemporaryNamespace */
/** @typedef {{ fs?: MemoryFs, process?: MemoryProcess, env?: Record<string, string>, temporarySource?: string, environmentSource?: string }} WorldOptions */

/** @param {string} code @param {string} target */
function fsError(code, target) {
  const error = new Error(`${code}: ${target}`);
  Object.assign(error, { code, path: target });
  return error;
}

class MemoryFs {
  constructor() {
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    /** @type {FsCall[]} */
    this.calls = [];
    this.nextIno = 100n;
    /** @type {((path: string) => void) | undefined} */
    this.onMkdir = undefined;
    this.addDirectory("/", 0o755n, 0n, 1n, 1n);
    this.addDirectory("/tmp", 0o777n, UID, 1n, 2n);
  }

  /** @param {string} target @param {bigint} [mode] @param {bigint} [uid] @param {bigint} [dev] @param {bigint} [ino] */
  addDirectory(target, mode = 0o700n, uid = UID, dev = 7n, ino = this.nextIno++) {
    this.entries.set(normalize(target), { kind: "directory", mode, uid, dev, ino });
    return this.entries.get(normalize(target));
  }

  /** @param {string} target @param {string} destination @param {bigint} [uid] @param {bigint} [dev] @param {bigint} [ino] */
  addSymlink(target, destination, uid = UID, dev = 7n, ino = this.nextIno++) {
    this.entries.set(normalize(target), {
      kind: "symlink", mode: 0o777n, uid, dev, ino, target: destination,
    });
  }

  /** @param {string} target */
  has(target) {
    return this.entries.has(normalize(target));
  }

  /** @param {string} target */
  entry(target) {
    const entry = this.entries.get(normalize(target));
    if (!entry) throw fsError("ENOENT", target);
    return entry;
  }

  /** @param {string} target @param {{ bigint?: boolean }} options */
  lstatSync = (target, options) => {
    this.calls.push({ name: "lstatSync", path: target, options });
    assert.equal(options?.bigint, true, "SUT必须使用native bigint lstat");
    const entry = this.entry(target);
    return {
      mode: entry.mode,
      uid: entry.uid,
      dev: entry.dev,
      ino: entry.ino,
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink",
    };
  };

  /** @param {string} target */
  realpathSync = (target) => {
    this.calls.push({ name: "realpathSync", path: target });
    let current = normalize(target);
    const seen = new Set();
    for (;;) {
      if (seen.has(current)) throw fsError("ELOOP", target);
      seen.add(current);
      const entry = this.entry(current);
      if (entry.kind !== "symlink") return current;
      current = normalize(entry.target ?? "");
    }
  };

  /** @param {string} prefix */
  mkdtempSync = (prefix) => {
    this.calls.push({ name: "mkdtempSync", path: prefix });
    const target = `${prefix}${String(this.nextIno)}`;
    this.addDirectory(target, 0o700n, UID, 1n);
    return target;
  };

  /** @param {string} target @param {number} mode */
  chmodSync = (target, mode) => {
    this.calls.push({ name: "chmodSync", path: target, options: mode });
    this.entry(target).mode = BigInt(mode);
  };

  /** @param {string} target @param {MkdirOptions} [options] */
  mkdirSync = (target, options = {}) => {
    this.calls.push({ name: "mkdirSync", path: target, options });
    const normalized = normalize(target);
    if (this.entries.has(normalized)) throw fsError("EEXIST", target);
    if (!options.recursive && !this.entries.has(dirname(normalized))) throw fsError("ENOENT", dirname(normalized));
    this.addDirectory(normalized, BigInt(options.mode ?? 0o777), UID, 7n);
    this.onMkdir?.(normalized);
  };

  /** @param {string} target */
  rmdirSync = (target) => {
    this.calls.push({ name: "rmdirSync", path: target });
    const normalized = normalize(target);
    const entry = this.entry(normalized);
    if (entry.kind !== "directory") throw fsError("ENOTDIR", target);
    const prefix = `${normalized}/`;
    if ([...this.entries.keys()].some((candidate) => candidate.startsWith(prefix))) {
      throw fsError("ENOTEMPTY", target);
    }
    this.entries.delete(normalized);
  };
}

class MemoryProcess {
  /** @type {string | undefined} */
  __piCompanyTestTemporaryRoot;

  /** @param {Record<string, string>} [env] */
  constructor(env = {}) {
    /** @type {Record<string, string>} */
    this.env = { ...env };
    this.platform = "darwin";
    /** @type {Map<string, Array<() => void>>} */
    this.listeners = new Map();
  }

  getuid = () => Number(UID);

  /** @param {string} event @param {() => void} listener */
  once = (event, listener) => {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  };

  /** @param {string} event */
  emit(event) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.delete(event);
    for (const listener of listeners) listener();
  }
}

/** @param {string} pathname @param {Entry} entry @param {Record<string, unknown>} [extra] */
function bindingText(pathname, entry, extra = {}) {
  return JSON.stringify({ path: pathname, dev: String(entry.dev), ino: String(entry.ino), ...extra });
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

/** @param {WorldOptions} [options] */
async function createWorld(options = {}) {
  const fs = options.fs ?? new MemoryFs();
  const testProcess = options.process ?? new MemoryProcess(options.env);
  /** @type {Array<() => void>} */
  const afterAllCallbacks = [];
  const context = createContext({ process: testProcess, console });
  const temporarySource = options.temporarySource ?? readFileSync(TEMPORARY_ROOT_SOURCE, "utf8");
  const environmentSource = options.environmentSource ?? readFileSync(TEST_ENVIRONMENT_SOURCE, "utf8");
  const fsModule = await synthetic(context, "node:fs", {
    chmodSync: fs.chmodSync,
    lstatSync: fs.lstatSync,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    realpathSync: fs.realpathSync,
    rmdirSync: fs.rmdirSync,
  });
  const osModule = await synthetic(context, "node:os", { tmpdir: () => "/memory-os-tmp" });
  const pathModule = await synthetic(context, "node:path", { isAbsolute: path.isAbsolute, join: path.join });
  const vitestModule = await synthetic(context, "vitest", {
    afterAll: /** @param {() => void} callback */ (callback) => { afterAllCallbacks.push(callback); },
  });
  const loadTemporary = async () => {
    const module = new SourceTextModule(stripTypeScriptTypes(temporarySource, { mode: "strip" }), {
      context,
      identifier: TEMPORARY_ROOT_SOURCE,
    });
    await module.link((specifier) => {
      if (specifier === "node:fs") return fsModule;
      if (specifier === "node:os") return osModule;
      if (specifier === "node:path") return pathModule;
      throw new Error(`unexpected temporary-root import: ${specifier}`);
    });
    await module.evaluate();
    return /** @type {TemporaryNamespace} */ (module.namespace);
  };
  const temporary = await loadTemporary();

  const loadEnvironment = async () => {
    const module = new SourceTextModule(stripTypeScriptTypes(environmentSource, { mode: "strip" }), {
      context,
      identifier: TEST_ENVIRONMENT_SOURCE,
    });
    await module.link(async (specifier) => {
      if (specifier === "node:fs") return fsModule;
      if (specifier === "node:path") return pathModule;
      if (specifier === "vitest") return vitestModule;
      if (specifier === "./temporary-root.ts") {
        const module = new SourceTextModule(stripTypeScriptTypes(temporarySource, { mode: "strip" }), {
          context,
          identifier: TEMPORARY_ROOT_SOURCE,
        });
        await module.link((dependency) => {
          if (dependency === "node:fs") return fsModule;
          if (dependency === "node:os") return osModule;
          if (dependency === "node:path") return pathModule;
          throw new Error(`unexpected temporary-root import: ${dependency}`);
        });
        await module.evaluate();
        return module;
      }
      throw new Error(`unexpected test-environment import: ${specifier}`);
    });
    await module.evaluate();
  };

  return {
    fs,
    process: testProcess,
    temporary,
    loadTemporary,
    loadEnvironment,
    runAfterAll() {
      for (const callback of afterAllCallbacks.splice(0).reverse()) callback();
    },
  };
}

function managedFs({ mode = 0o700n, uid = UID, dev = 7n, ino = 77n } = {}) {
  const fs = new MemoryFs();
  const parent = fs.addDirectory("/owned", mode, uid, dev, ino);
  assert.ok(parent);
  return { fs, parent };
}

async function defaultMode() {
  const world = await createWorld();
  const first = world.temporary.temporaryRoot();
  assert.match(first, /^\/tmp\/pi-t-/);
  assert.equal(world.temporary.temporaryRoot(), first);
  assert.equal(world.temporary.isTemporaryRootManaged(), false);
  assert.equal(world.fs.calls.filter((call) => call.name === "mkdtempSync").length, 1);
  assert.equal(world.fs.entry(first).mode, 0o700n);
  world.process.emit("exit");
  assert.equal(world.fs.has(first), false);

  const setup = await createWorld();
  await setup.loadEnvironment();
  const verification = setup.process.env.TMPDIR;
  assert.ok(verification?.endsWith("/verification"));
  assert.equal(setup.process.env.GIT_CEILING_DIRECTORIES, dirname(verification));
  assert.equal(setup.fs.entry(verification).mode, 0o700n);
  setup.runAfterAll();
  assert.equal(setup.fs.has(verification), false);
  assert.equal(setup.fs.has(dirname(verification)), false);
}

async function managedSuccessAndOwnership() {
  const { fs, parent } = managedFs();
  const process = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", parent) });
  const world = await createWorld({ fs, process });
  assert.equal(world.temporary.temporaryRoot(), "/owned");
  assert.equal(world.temporary.temporaryRoot(), "/owned");
  assert.equal(world.temporary.isTemporaryRootManaged(), true);
  assert.equal(fs.calls.some((call) => call.name === "mkdtempSync"), false);
  assert.equal(fs.calls.some((call) => call.name === "chmodSync"), false);
  assert.equal(process.listeners.has("exit"), false);
  world.temporary.cleanupTemporaryRoot();
  assert.equal(fs.has("/owned"), true);

  await world.loadEnvironment();
  assert.equal(process.env.TMPDIR, "/owned/verification");
  assert.equal(process.env.GIT_CEILING_DIRECTORIES, "/owned");
  assert.equal(fs.has("/owned/verification"), true);
  const mkdir = fs.calls.find((call) => call.name === "mkdirSync");
  assert.equal(mkdir?.options?.mode, 0o700);
  assert.equal(mkdir?.options?.recursive, undefined);
  assert.equal(fs.calls.some((call) => call.name === "chmodSync"), false);
  delete process.env[BINDING_ENV];
  world.runAfterAll();
  assert.equal(fs.has("/owned/verification"), true, "非owner afterAll必须保留verification");
  assert.equal(fs.has("/owned"), true, "非owner cleanup必须保留O父根");
  process.emit("exit");
  assert.equal(fs.has("/owned"), true, "受控模式不得登记默认exit删除");
}

async function managedBindingFailures() {
  const malformed = await createWorld({ env: { [BINDING_ENV]: "{" } });
  assert.throws(() => malformed.temporary.temporaryRoot(), /valid JSON/);
  delete malformed.process.env[BINDING_ENV];
  assert.throws(() => malformed.temporary.temporaryRoot(), /changed after first use/);
  assert.equal(malformed.fs.calls.some((call) => call.name === "mkdtempSync"), false);

  for (const candidate of [
    JSON.stringify({ path: "/owned", dev: "7" }),
    JSON.stringify({ path: "/owned", dev: "7", ino: "77", extra: true }),
    JSON.stringify({ path: "owned", dev: "7", ino: "77" }),
    JSON.stringify({ path: "/owned", dev: 7, ino: "77" }),
    JSON.stringify({ path: "/owned", dev: "x", ino: "77" }),
  ]) {
    const world = await createWorld({ env: { [BINDING_ENV]: candidate } });
    assert.throws(() => world.temporary.temporaryRoot());
    assert.equal(world.fs.calls.some((call) => call.name === "mkdtempSync"), false);
  }

  for (const variant of [
    { mode: 0o755n },
    { uid: 999n },
    { dev: 8n },
    { ino: 78n },
  ]) {
    const { fs, parent } = managedFs();
    const text = bindingText("/owned", parent);
    Object.assign(parent, variant);
    const world = await createWorld({ fs, env: { [BINDING_ENV]: text } });
    assert.throws(() => world.temporary.temporaryRoot());
    assert.equal(fs.calls.some((call) => call.name === "chmodSync" || call.name === "rmdirSync"), false);
  }

  const notDirectory = managedFs();
  notDirectory.parent.kind = "symlink";
  notDirectory.parent.target = "/tmp";
  const symlinkWorld = await createWorld({
    fs: notDirectory.fs,
    env: { [BINDING_ENV]: bindingText("/owned", notDirectory.parent) },
  });
  assert.throws(() => symlinkWorld.temporary.temporaryRoot(), /regular directory/);

  const alias = managedFs();
  alias.fs.addSymlink("/alias", "/owned", UID, alias.parent.dev, 88n);
  const aliasWorld = await createWorld({
    fs: alias.fs,
    env: { [BINDING_ENV]: bindingText("/alias", alias.fs.entry("/alias")) },
  });
  assert.throws(() => aliasWorld.temporary.temporaryRoot(), /regular directory/);

  const external = managedFs();
  const externalProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", external.parent) });
  externalProcess[ROOT_PROPERTY] = "/old-cache";
  const externalWorld = await createWorld({ fs: external.fs, process: externalProcess });
  assert.throws(() => externalWorld.temporary.temporaryRoot(), /existing process cache/);
  externalWorld.temporary.cleanupTemporaryRoot();
  assert.equal(external.fs.calls.some((call) => call.name === "rmdirSync"), false);
}

async function managedLockAndDrift() {
  const first = managedFs();
  const process = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", first.parent) });
  const world = await createWorld({ fs: first.fs, process });
  assert.equal(world.temporary.temporaryRoot(), "/owned");
  process.env[BINDING_ENV] = ` ${process.env[BINDING_ENV]}`;
  assert.throws(() => world.temporary.temporaryRoot(), /changed after first use/);
  assert.equal(first.fs.has("/owned"), true);

  const removed = managedFs();
  const removedProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", removed.parent) });
  const removedWorld = await createWorld({ fs: removed.fs, process: removedProcess });
  removedWorld.temporary.temporaryRoot();
  delete removedProcess.env[BINDING_ENV];
  assert.throws(() => removedWorld.temporary.temporaryRoot(), /changed after first use/);
  removedWorld.temporary.cleanupTemporaryRoot();
  assert.equal(removed.fs.has("/owned"), true);

  const drift = managedFs();
  const driftWorld = await createWorld({
    fs: drift.fs,
    env: { [BINDING_ENV]: bindingText("/owned", drift.parent) },
  });
  driftWorld.temporary.temporaryRoot();
  drift.parent.ino += 1n;
  assert.throws(() => driftWorld.temporary.temporaryRoot(), /identity changed/);
  driftWorld.temporary.cleanupTemporaryRoot();
  assert.equal(drift.fs.has("/owned"), true);

  const defaultWorld = await createWorld();
  const defaultRoot = defaultWorld.temporary.temporaryRoot();
  defaultWorld.process.env[BINDING_ENV] = JSON.stringify({ path: "/owned", dev: "7", ino: "77" });
  assert.throws(() => defaultWorld.temporary.temporaryRoot(), /cannot be added after first use/);
  defaultWorld.temporary.cleanupTemporaryRoot();
  delete defaultWorld.process.env[BINDING_ENV];
  defaultWorld.temporary.cleanupTemporaryRoot();
  assert.equal(defaultWorld.fs.has(defaultRoot), true, "观察到受控配置后不得恢复默认删除");
  assert.throws(() => defaultWorld.temporary.temporaryRoot(), /forbids default allocation/);
}

async function managedStateTamperingPreservesOwnership() {
  /** @type {Array<{ name: string, apply(testProcess: MemoryProcess): void }>} */
  const attempts = [
    {
      name: "replace",
      apply: (testProcess) => {
        Object.defineProperty(testProcess, STATE_PROPERTY, {
          value: Object.freeze({ mode: "default" }),
        });
      },
    },
    {
      name: "delete",
      apply: (testProcess) => {
        if (!Reflect.deleteProperty(testProcess, STATE_PROPERTY)) {
          throw new TypeError("state property is not configurable");
        }
      },
    },
    {
      name: "change-mode",
      apply: (testProcess) => {
        const state = /** @type {{ mode: string }} */ (Reflect.get(testProcess, STATE_PROPERTY));
        state.mode = "default";
      },
    },
  ];

  for (const attempt of attempts) {
    const root = managedFs();
    const testProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", root.parent) });
    const world = await createWorld({ fs: root.fs, process: testProcess });
    assert.equal(world.temporary.temporaryRoot(), "/owned");
    const stateDescriptor = Object.getOwnPropertyDescriptor(testProcess, STATE_PROPERTY);
    assert.equal(stateDescriptor?.writable, false);
    assert.equal(stateDescriptor?.configurable, false);
    assert.equal(Object.isFrozen(stateDescriptor?.value), true);
    const preservationDescriptor = Object.getOwnPropertyDescriptor(testProcess, NON_OWNER_PROPERTY);
    assert.equal(preservationDescriptor?.value, true);
    assert.equal(preservationDescriptor?.writable, false);
    assert.equal(preservationDescriptor?.configurable, false);

    let rejected = false;
    try {
      attempt.apply(testProcess);
    } catch (error) {
      assert.ok(error instanceof TypeError, `${attempt.name}只能由不可变边界拒绝`);
      rejected = true;
    }
    assert.equal(rejected, true, `${attempt.name}必须被拒绝`);
    world.temporary.cleanupTemporaryRoot();
    const reloaded = await world.loadTemporary();
    reloaded.cleanupTemporaryRoot();
    assert.equal(root.fs.calls.some((call) => call.name === "rmdirSync"), false,
      `${attempt.name}后重复模块加载仍不得删除`);
    assert.equal(root.fs.has("/owned"), true);
  }
}

async function cleanupBeforeInitializationPreservesConfiguredCaches() {
  for (const bindingKind of ["valid", "invalid"]) {
    for (const cacheKind of ["same", "other"]) {
      const root = managedFs();
      root.fs.addDirectory("/other-cache", 0o700n, UID, 7n, 89n);
      const binding = bindingKind === "valid" ? bindingText("/owned", root.parent) : "{";
      const testProcess = new MemoryProcess({ [BINDING_ENV]: binding });
      const cachedRoot = cacheKind === "same" ? "/owned" : "/other-cache";
      testProcess[ROOT_PROPERTY] = cachedRoot;
      const world = await createWorld({ fs: root.fs, process: testProcess });

      world.temporary.cleanupTemporaryRoot();
      assert.equal(root.fs.calls.some((call) => call.name === "mkdtempSync"), false,
        `${bindingKind}/${cacheKind} cleanup不得创建默认根`);
      assert.equal(root.fs.calls.some((call) => call.name === "rmdirSync"), false,
        `${bindingKind}/${cacheKind}首次cleanup必须保全缓存`);
      assert.equal(root.fs.has(cachedRoot), true);

      delete testProcess.env[BINDING_ENV];
      world.temporary.cleanupTemporaryRoot();
      const reloaded = await world.loadTemporary();
      reloaded.cleanupTemporaryRoot();
      assert.equal(root.fs.calls.some((call) => call.name === "rmdirSync"), false,
        `${bindingKind}/${cacheKind}移除绑定及重复加载后仍必须保全`);
      assert.equal(root.fs.has(cachedRoot), true);
    }
  }
}

async function unknownPreservationCannotRestoreDefault() {
  let combinations = 0;
  for (const marker of [{ untrusted: true }, false]) {
    for (const bindingKind of ["valid", "invalid"]) {
      for (const cacheKind of ["same", "other"]) {
        for (const firstCall of ["cleanup", "temporaryRoot"]) {
          for (const reload of [false, true]) {
            const root = managedFs();
            root.fs.addDirectory("/other-cache", 0o700n, UID, 7n, 89n);
            const testProcess = new MemoryProcess({
              [BINDING_ENV]: bindingKind === "valid" ? bindingText("/owned", root.parent) : "{",
            });
            testProcess[ROOT_PROPERTY] = cacheKind === "same" ? "/owned" : "/other-cache";
            Object.defineProperty(testProcess, NON_OWNER_PROPERTY, {
              value: marker, writable: true, configurable: true,
            });
            const world = await createWorld({ fs: root.fs, process: testProcess });
            if (firstCall === "cleanup") world.temporary.cleanupTemporaryRoot();
            else assert.throws(() => world.temporary.temporaryRoot(), /preservation state is invalid/);
            assert.equal(Reflect.deleteProperty(testProcess, NON_OWNER_PROPERTY), false,
              "初始化错误仍须固化不可撤销的保全事实");
            delete testProcess.env[BINDING_ENV];
            const current = reload ? await world.loadTemporary() : world.temporary;
            current.cleanupTemporaryRoot();
            assert.throws(() => current.temporaryRoot(), /forbids default allocation/);
            testProcess.env[BINDING_ENV] = bindingText("/other-cache", root.fs.entry("/other-cache"));
            current.cleanupTemporaryRoot();
            assert.throws(() => current.temporaryRoot(), /preservation state is invalid/);
            assert.equal(root.fs.calls.some((call) =>
              ["mkdirSync", "mkdtempSync", "chmodSync", "rmdirSync"].includes(call.name)), false);
            assert.equal(root.fs.has("/owned"), true);
            assert.equal(root.fs.has("/other-cache"), true);
            combinations += 1;
          }
        }
      }
    }
  }
  assert.equal(combinations, 32);

  let getterReads = 0;
  const getter = () => { getterReads += 1; throw new Error("unknown marker getter"); };
  /** @type {PropertyDescriptor[]} */
  const descriptors = [
    { value: { unknown: true }, writable: true, configurable: false },
    { value: false, writable: false, configurable: false },
    { value: true, writable: false, configurable: true },
    { get: getter, configurable: true },
    { get: getter, configurable: false },
  ];
  for (const descriptor of descriptors) {
    const root = managedFs();
    const testProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", root.parent) });
    testProcess[ROOT_PROPERTY] = "/owned";
    Object.defineProperty(testProcess, NON_OWNER_PROPERTY, descriptor);
    const world = await createWorld({ fs: root.fs, process: testProcess });
    world.temporary.cleanupTemporaryRoot();
    assert.equal(Reflect.deleteProperty(testProcess, NON_OWNER_PROPERTY), false);
    delete testProcess.env[BINDING_ENV];
    const reloaded = await world.loadTemporary();
    reloaded.cleanupTemporaryRoot();
    assert.throws(() => reloaded.temporaryRoot(), /forbids default allocation/);
    assert.equal(root.fs.calls.some((call) =>
      ["mkdirSync", "mkdtempSync", "chmodSync", "rmdirSync"].includes(call.name)), false);
    assert.equal(root.fs.has("/owned"), true);
  }
  assert.equal(getterReads, 0);
}

async function managedVerificationFailures() {
  /** @type {Array<{ kind: "directory" | "symlink", mode: bigint, uid: bigint }>} */
  const variants = [
    { kind: "directory", mode: 0o755n, uid: UID },
    { kind: "directory", mode: 0o700n, uid: 999n },
    { kind: "symlink", mode: 0o777n, uid: UID },
  ];
  for (const variant of variants) {
    const root = managedFs();
    if (variant.kind === "symlink") root.fs.addDirectory("/external-target");
    root.fs.entries.set("/owned/verification", {
      kind: variant.kind,
      mode: variant.mode,
      uid: variant.uid,
      dev: 7n,
      ino: 90n,
      ...(variant.kind === "symlink" ? { target: "/external-target" } : {}),
    });
    const world = await createWorld({
      fs: root.fs,
      env: { [BINDING_ENV]: bindingText("/owned", root.parent) },
    });
    await assert.rejects(world.loadEnvironment());
    assert.equal(root.fs.has("/owned/verification"), true);
    assert.equal(root.fs.has("/external-target"), variant.kind === "symlink");
    assert.equal(root.fs.calls.some((call) => call.name === "chmodSync" || call.name === "rmdirSync"), false);
  }

  const race = managedFs();
  race.fs.onMkdir = () => { race.parent.ino += 1n; };
  const raceWorld = await createWorld({
    fs: race.fs,
    env: { [BINDING_ENV]: bindingText("/owned", race.parent) },
  });
  await assert.rejects(raceWorld.loadEnvironment(), /identity changed/);
  assert.equal(race.fs.has("/owned/verification"), true, "身份漂移时保全已经产生的目录");
  assert.equal(race.fs.has("/owned"), true);
}

async function mutationChecks() {
  const originalTemporary = readFileSync(TEMPORARY_ROOT_SOURCE, "utf8");
  const identityNeedle = "stats.dev !== binding.dev || stats.ino !== binding.ino";
  assert.equal(originalTemporary.includes(identityNeedle), true);
  const identityMutant = originalTemporary.replace(identityNeedle, "stats.dev !== binding.dev && stats.ino !== binding.ino");
  let identityFailure;
  try {
    const root = managedFs();
    const text = bindingText("/owned", root.parent);
    root.parent.dev += 1n;
    const world = await createWorld({ fs: root.fs, env: { [BINDING_ENV]: text }, temporarySource: identityMutant });
    assert.throws(() => world.temporary.temporaryRoot(), /identity changed/);
  } catch (error) {
    identityFailure = error;
  }
  assert.ok(identityFailure instanceof AssertionError, "identity mutant必须由真实断言杀死");
  assert.equal(identityFailure instanceof SyntaxError, false);

  const originalEnvironment = readFileSync(TEST_ENVIRONMENT_SOURCE, "utf8");
  const cleanupNeedle = "afterAll(() => {\n  if (!managed) {";
  assert.equal(originalEnvironment.includes(cleanupNeedle), true);
  const cleanupMutant = originalEnvironment.replace(cleanupNeedle, "afterAll(() => {\n  if (managed) {");
  let cleanupFailure;
  try {
    const root = managedFs();
    const world = await createWorld({
      fs: root.fs,
      env: { [BINDING_ENV]: bindingText("/owned", root.parent) },
      environmentSource: cleanupMutant,
    });
    await world.loadEnvironment();
    world.runAfterAll();
    assert.equal(root.fs.has("/owned/verification"), true);
  } catch (error) {
    cleanupFailure = error;
  }
  assert.ok(cleanupFailure instanceof AssertionError, "cleanup mutant必须由真实断言杀死");
  assert.equal(cleanupFailure instanceof SyntaxError, false);

  const preservationNeedle = 'if (existing.configurable || ("value" in existing && existing.writable)) {';
  assert.equal(originalTemporary.split(preservationNeedle).length, 2);
  const preservationMutant = originalTemporary.replace(preservationNeedle, "if (false) {");
  const root = managedFs();
  const testProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", root.parent) });
  testProcess[ROOT_PROPERTY] = "/owned";
  Object.defineProperty(testProcess, NON_OWNER_PROPERTY, {
    value: false, writable: true, configurable: true,
  });
  const world = await createWorld({ fs: root.fs, process: testProcess, temporarySource: preservationMutant });
  // Mutant已经加载成功；以下断言直接检查实际SUT清理后的目录保全。
  let preservationFailure;
  try {
    world.temporary.cleanupTemporaryRoot();
    Reflect.deleteProperty(testProcess, NON_OWNER_PROPERTY);
    delete testProcess.env[BINDING_ENV];
    world.temporary.cleanupTemporaryRoot();
    assert.equal(root.fs.has("/owned"), true);
  } catch (error) {
    preservationFailure = error;
  }
  assert.ok(preservationFailure instanceof AssertionError, "unknown-marker mutant必须由目录保全断言杀死");

  const allocationNeedle = 'if (bindingText === undefined && hasNonOwnerPreservation(testProcess) && existing?.mode !== "managed") {';
  assert.equal(originalTemporary.split(allocationNeedle).length, 2);
  const allocationRoot = managedFs();
  const allocationProcess = new MemoryProcess({ [BINDING_ENV]: bindingText("/owned", allocationRoot.parent) });
  allocationProcess[ROOT_PROPERTY] = "/owned";
  Object.defineProperty(allocationProcess, NON_OWNER_PROPERTY, {
    value: false, writable: true, configurable: true,
  });
  const allocationWorld = await createWorld({
    fs: allocationRoot.fs,
    process: allocationProcess,
    temporarySource: originalTemporary.replace(allocationNeedle, "if (false) {"),
  });
  allocationWorld.temporary.cleanupTemporaryRoot();
  delete allocationProcess.env[BINDING_ENV];
  let allocationFailure;
  try {
    assert.throws(() => allocationWorld.temporary.temporaryRoot(), /forbids default allocation/);
  } catch (error) {
    allocationFailure = error;
  }
  assert.ok(allocationFailure instanceof AssertionError, "default-allocation mutant必须由禁止回退断言杀死");
}

await defaultMode();
await managedSuccessAndOwnership();
await managedBindingFailures();
await managedLockAndDrift();
await managedStateTamperingPreservesOwnership();
await cleanupBeforeInitializationPreservesConfiguredCaches();
await unknownPreservationCannotRestoreDefault();
await managedVerificationFailures();
await mutationChecks();
process.stdout.write("pm-sdk-owned-parent VM: baseline PASS; 32 unknown-marker combinations and 5 descriptor cases; four mutants AssertionError\n");
