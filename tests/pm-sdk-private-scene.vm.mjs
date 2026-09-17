// @ts-check
import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const TESTS = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(TESTS, "helpers", "pm-sdk-private-scene.mjs");
const SOURCE_TEXT = readFileSync(SOURCE, "utf8");
const CONFIG_BYTES = Buffer.from(readFileSync(join(TESTS, "..", "vitest.config.ts")));
const PACKAGE_BYTES = Buffer.from(readFileSync(join(TESTS, "..", "package.json")));
const UID = 501n;
const PROJECT = "/project";
const LINUX_TMP = "/tmp";
const DARWIN_TMP = "/private/tmp";
const VITEST_TARGET = "/project/node_modules/.pnpm/vitest-real";

/** @typedef {{ kind: "directory", mode: bigint, uid: bigint, dev: bigint, ino: bigint } | { kind: "file", mode: bigint, uid: bigint, dev: bigint, ino: bigint, bytes: Buffer } | { kind: "symlink", mode: bigint, uid: bigint, dev: bigint, ino: bigint, target: string }} Entry */
/** @typedef {{ ordinal: number, name: string, path: string, detail?: unknown }} FsCall */
/** @typedef {{ createSdkTestScene(): Promise<object>, sdkTestSceneReceipt(value: unknown): Readonly<Record<string, unknown>> | undefined, sdkTestSceneFailureReceipt(value: unknown): Readonly<Record<string, unknown>> | undefined }} SceneNamespace */

/** @param {string} code @param {string} path */
function fsError(code, path) {
  const error = new Error(`${code}: ${path}`);
  Object.assign(error, { code, path });
  return error;
}

class MemoryFs {
  /** @param {string} [canonicalTempParent] */
  constructor(canonicalTempParent = DARWIN_TMP) {
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    /** @type {FsCall[]} */
    this.calls = [];
    this.nextIno = 100n;
    this.callOrdinal = 0;
    /** @type {number | null} */
    this.failAt = null;
    /** @type {unknown} */
    this.failureValue = undefined;
    /** @type {((call: FsCall, fs: MemoryFs) => void) | null} */
    this.afterCall = null;
    /** @type {string | null} */
    this.mkdtempOverride = null;
    this.addDirectory("/", 0o755n, 0n, 1n, 1n);
    this.addDirectory(PROJECT, 0o755n, UID, 2n, 2n);
    this.addDirectory(`${PROJECT}/tests`, 0o755n, UID, 2n, 3n);
    this.addDirectory(`${PROJECT}/tests/helpers`, 0o755n, UID, 2n, 4n);
    this.addFile(`${PROJECT}/vitest.config.ts`, CONFIG_BYTES, 0o644n, UID, 2n, 5n);
    this.addFile(`${PROJECT}/package.json`, PACKAGE_BYTES, 0o644n, UID, 2n, 6n);
    this.addDirectory(`${PROJECT}/node_modules`, 0o755n, UID, 2n, 7n);
    this.addDirectory(`${PROJECT}/node_modules/.pnpm`, 0o755n, UID, 2n, 8n);
    this.addDirectory(VITEST_TARGET, 0o755n, UID, 2n, 9n);
    this.addSymlink(`${PROJECT}/node_modules/vitest`, VITEST_TARGET, UID, 2n, 10n);
    const canonicalTemp = normalize(canonicalTempParent);
    this.addDirectory(canonicalTemp, 0o1777n, 0n, 3n, 11n);
    if (canonicalTemp !== LINUX_TMP) {
      this.addSymlink(LINUX_TMP, canonicalTemp, 0n, 3n, 12n);
    }
    this.addDirectory("/external", 0o755n, UID, 4n, 13n);
  }

  /** @param {string} path @param {bigint} [mode] @param {bigint} [uid] @param {bigint} [dev] @param {bigint} [ino] */
  addDirectory(path, mode = 0o700n, uid = UID, dev = 7n, ino = this.nextIno++) {
    this.entries.set(normalize(path), { kind: "directory", mode, uid, dev, ino });
  }

  /** @param {string} path @param {Uint8Array} bytes @param {bigint} [mode] @param {bigint} [uid] @param {bigint} [dev] @param {bigint} [ino] */
  addFile(path, bytes, mode = 0o600n, uid = UID, dev = 7n, ino = this.nextIno++) {
    this.entries.set(normalize(path), { kind: "file", mode, uid, dev, ino, bytes: Buffer.from(bytes) });
  }

  /** @param {string} path @param {string} target @param {bigint} [uid] @param {bigint} [dev] @param {bigint} [ino] */
  addSymlink(path, target, uid = UID, dev = 7n, ino = this.nextIno++) {
    this.entries.set(normalize(path), { kind: "symlink", mode: 0o777n, uid, dev, ino, target: normalize(target) });
  }

  /** @param {string} path */
  entry(path) {
    const entry = this.entries.get(normalize(path));
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }

  /** @param {string} name @param {string} path @param {unknown} [detail] */
  before(name, path, detail) {
    this.callOrdinal += 1;
    const call = { ordinal: this.callOrdinal, name, path: normalize(path), detail };
    this.calls.push(call);
    if (this.failAt === call.ordinal) throw this.failureValue;
    return call;
  }

  /** @param {FsCall} call */
  after(call) {
    this.afterCall?.(call, this);
  }

  /** @param {string} path @param {{ bigint?: boolean }} options */
  lstat = async (path, options) => {
    const call = this.before("lstat", path, options);
    assert.equal(options?.bigint, true, "SUT必须使用bigint lstat");
    const entry = this.entry(path);
    const snapshot = {
      mode: entry.mode,
      uid: entry.uid,
      dev: entry.dev,
      ino: entry.ino,
      size: entry.kind === "file" ? BigInt(entry.bytes.length) : 0n,
      isDirectory: () => entry.kind === "directory",
      isFile: () => entry.kind === "file",
      isSymbolicLink: () => entry.kind === "symlink",
    };
    this.after(call);
    return snapshot;
  };

  /** @param {string} path */
  realpath = async (path) => {
    const call = this.before("realpath", path);
    let current = normalize(path);
    const seen = new Set();
    for (;;) {
      if (seen.has(current)) throw fsError("ELOOP", path);
      seen.add(current);
      const entry = this.entry(current);
      if (entry.kind !== "symlink") {
        this.after(call);
        return current;
      }
      current = entry.target;
    }
  };

  /** @param {string} path */
  readFile = async (path) => {
    const call = this.before("readFile", path);
    const entry = this.entry(path);
    if (entry.kind !== "file") throw fsError("EISDIR", path);
    const bytes = Buffer.from(entry.bytes);
    this.after(call);
    return bytes;
  };

  /** @param {string} prefix */
  mkdtemp = async (prefix) => {
    const call = this.before("mkdtemp", prefix);
    const target = normalize(this.mkdtempOverride ?? `${prefix}000001`);
    if (this.entries.has(target)) throw fsError("EEXIST", target);
    this.addDirectory(target, 0o755n, UID, 3n);
    this.after(call);
    return target;
  };

  /** @param {string} path @param {number} mode */
  chmod = async (path, mode) => {
    const call = this.before("chmod", path, mode);
    this.entry(path).mode = BigInt(mode);
    this.after(call);
  };

  /** @param {string} path @param {{ mode?: number }} options */
  mkdir = async (path, options = {}) => {
    const call = this.before("mkdir", path, options);
    const target = normalize(path);
    if (this.entries.has(target)) throw fsError("EEXIST", target);
    const parent = this.entry(dirname(target));
    if (parent.kind !== "directory") throw fsError("ENOTDIR", dirname(target));
    this.addDirectory(target, BigInt(options.mode ?? 0o777), UID, parent.dev);
    this.after(call);
  };

  /** @param {string} path @param {Uint8Array} bytes @param {{ flag?: string, mode?: number }} options */
  writeFile = async (path, bytes, options) => {
    const call = this.before("writeFile", path, options);
    const target = normalize(path);
    assert.equal(options?.flag, "wx");
    if (this.entries.has(target)) throw fsError("EEXIST", target);
    const parent = this.entry(dirname(target));
    if (parent.kind !== "directory") throw fsError("ENOTDIR", dirname(target));
    this.addFile(target, bytes, BigInt(options.mode ?? 0o666), UID, parent.dev);
    this.after(call);
  };

  /** @param {string} target @param {string} path @param {string} type */
  symlink = async (target, path, type) => {
    const call = this.before("symlink", path, { target, type });
    assert.equal(type, "dir");
    if (this.entries.has(normalize(path))) throw fsError("EEXIST", path);
    const parent = this.entry(dirname(path));
    if (parent.kind !== "directory") throw fsError("ENOTDIR", dirname(path));
    this.addSymlink(path, target, UID, parent.dev);
    this.after(call);
  };

  /** @param {string} path */
  readlink = async (path) => {
    const call = this.before("readlink", path);
    const entry = this.entry(path);
    if (entry.kind !== "symlink") throw fsError("EINVAL", path);
    this.after(call);
    return entry.target;
  };
}

class TestProcess {
  /**
   * @param {"darwin" | "linux" | "win32"} [platform]
   * @param {Record<string, string>} [env]
   */
  constructor(platform = "darwin", env = {}) {
    this.platform = platform;
    /** @type {Record<string, string>} */
    this.env = { ...env };
  }

  getuid = () => Number(UID);
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

/**
 * @param {string} sourceText
 * @param {MemoryFs} initialFs
 * @param {TestProcess} [testProcess]
 */
async function loadSceneModule(sourceText, initialFs, testProcess = new TestProcess()) {
  let activeFs = initialFs;
  const context = createContext({ Buffer, console, process: testProcess });
  const imports = new Set();
  const fsModule = await synthetic(context, "node:fs/promises", {
    chmod: /** @param {string} path @param {number} mode */ (path, mode) => activeFs.chmod(path, mode),
    lstat: /** @param {string} path @param {{ bigint?: boolean }} options */ (path, options) => activeFs.lstat(path, options),
    mkdir: /** @param {string} path @param {{ mode?: number }} options */ (path, options) => activeFs.mkdir(path, options),
    mkdtemp: /** @param {string} prefix */ (prefix) => activeFs.mkdtemp(prefix),
    readFile: /** @param {string} path */ (path) => activeFs.readFile(path),
    readlink: /** @param {string} path */ (path) => activeFs.readlink(path),
    realpath: /** @param {string} path */ (path) => activeFs.realpath(path),
    symlink: /** @param {string} target @param {string} path @param {string} type */ (target, path, type) => activeFs.symlink(target, path, type),
    writeFile: /** @param {string} path @param {Uint8Array} bytes @param {{ flag?: string, mode?: number }} options */ (path, bytes, options) => activeFs.writeFile(path, bytes, options),
  });
  const cryptoModule = await synthetic(context, "node:crypto", { createHash });
  const pathModule = await synthetic(context, "node:path", {
    dirname: nodePath.dirname,
    isAbsolute: nodePath.isAbsolute,
    join: nodePath.join,
    relative: nodePath.relative,
    resolve: nodePath.resolve,
    sep: nodePath.sep,
  });
  const urlModule = await synthetic(context, "node:url", { fileURLToPath });
  const module = new SourceTextModule(sourceText, {
    context,
    identifier: SOURCE,
    initializeImportMeta(meta) {
      meta.url = pathToFileURL(`${PROJECT}/tests/helpers/pm-sdk-private-scene.mjs`).href;
    },
  });
  await module.link((specifier) => {
    imports.add(specifier);
    if (specifier === "node:fs/promises") return fsModule;
    if (specifier === "node:crypto") return cryptoModule;
    if (specifier === "node:path") return pathModule;
    if (specifier === "node:url") return urlModule;
    throw new Error(`unexpected scene import: ${specifier}`);
  });
  await module.evaluate();
  return {
    namespace: /** @type {SceneNamespace} */ (module.namespace),
    imports,
    process: testProcess,
    setFs(/** @type {MemoryFs} */ fs) { activeFs = fs; },
  };
}

/** @param {MemoryFs} fs */
function rootPath(fs) {
  const call = fs.calls.find((entry) => entry.name === "mkdtemp");
  assert.ok(call);
  return `${call.path}000001`;
}

/** @param {MemoryFs} fs @param {string} root */
function children(fs, root) {
  return [...fs.entries.keys()].filter((path) => dirname(path) === root).sort();
}

/** @param {MemoryFs} fs @param {string} path */
function fileEntry(fs, path) {
  const entry = fs.entry(path);
  if (entry.kind !== "file") throw new TypeError(`expected memory file: ${path}`);
  return entry;
}

/** @param {unknown} value @returns {asserts value is Error & { cause?: unknown }} */
function assertErrorValue(value) {
  assert.equal(Object.prototype.toString.call(value), "[object Error]");
  if (typeof value !== "object" || value === null) assert.fail("expected error object");
}

/** @param {SceneNamespace} scene */
async function captureFailure(scene) {
  let caught;
  try {
    await scene.createSdkTestScene();
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, undefined, "factory必须拒绝");
  return caught;
}

async function normalAllocationAndReceipts() {
  const fs = new MemoryFs();
  const loaded = await loadSceneModule(SOURCE_TEXT, fs);
  assert.equal(fs.calls.length, 0, "普通import不得触发FS");
  assert.deepEqual([...loaded.imports].sort(), [
    "node:crypto", "node:fs/promises", "node:path", "node:url",
  ]);

  const originalConfig = Buffer.from(fileEntry(fs, `${PROJECT}/vitest.config.ts`).bytes);
  const originalPackage = Buffer.from(fileEntry(fs, `${PROJECT}/package.json`).bytes);
  const handle = await loaded.namespace.createSdkTestScene();
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(Reflect.ownKeys(handle).length, 0, "成功句柄必须为空");
  const receipt = loaded.namespace.sdkTestSceneReceipt(handle);
  assert.ok(receipt);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.status, "allocated");
  assert.equal(receipt.phase, "ready");
  assert.equal(receipt.projectRoot, PROJECT);
  const root = /** @type {string} */ (receipt.root);
  assert.match(root, /^\/private\/tmp\/pi-s-[A-Za-z0-9]{6}$/);
  assert.equal(root, rootPath(fs));
  assert.equal(fs.entry(root).kind, "directory");
  assert.equal(fs.entry(root).mode, 0o700n);

  const expectedDirectories = [
    receipt.homeDir,
    receipt.agentDir,
    receipt.agentsDir,
    receipt.xdgConfigHome,
    receipt.xdgCacheHome,
    receipt.tmpDir,
    receipt.cacheDir,
    receipt.nodeModulesPath,
    receipt.viteTempDir,
    `${root}/home/.pi`,
  ];
  for (const path of expectedDirectories) {
    assert.equal(typeof path, "string");
    const entry = fs.entry(/** @type {string} */ (path));
    assert.equal(entry.kind, "directory");
    assert.equal(entry.mode, 0o700n);
  }

  const copiedConfig = fs.entry(/** @type {string} */ (receipt.configPath));
  const privatePackage = fs.entry(/** @type {string} */ (receipt.packagePath));
  assert.equal(copiedConfig.kind, "file");
  assert.equal(privatePackage.kind, "file");
  assert.equal(copiedConfig.mode, 0o600n);
  assert.equal(privatePackage.mode, 0o600n);
  assert.deepEqual(copiedConfig.bytes, originalConfig);
  assert.equal(privatePackage.bytes.toString("utf8"), '{"type":"module"}\n');
  assert.deepEqual(fileEntry(fs, `${PROJECT}/vitest.config.ts`).bytes, originalConfig);
  assert.deepEqual(fileEntry(fs, `${PROJECT}/package.json`).bytes, originalPackage);
  assert.equal(receipt.configHash, `sha256:${createHash("sha256").update(originalConfig).digest("hex")}`);

  const privateNodeModules = fs.entry(/** @type {string} */ (receipt.nodeModulesPath));
  assert.equal(privateNodeModules.kind, "directory", "私有node_modules必须是真目录");
  const link = fs.entry(/** @type {string} */ (receipt.vitestLinkPath));
  assert.equal(link.kind, "symlink");
  assert.equal(link.target, VITEST_TARGET);
  assert.equal(receipt.vitestTarget, VITEST_TARGET);
  assert.deepEqual(children(fs, /** @type {string} */ (receipt.nodeModulesPath)), [
    `${receipt.nodeModulesPath}/.vite-temp`, `${receipt.nodeModulesPath}/vitest`,
  ]);
  assert.equal(fs.calls.filter((call) => call.name === "symlink").length, 1);

  const binding = JSON.parse(/** @type {string} */ (receipt.parentBinding));
  assert.deepEqual(Object.keys(binding), ["path", "dev", "ino"]);
  assert.equal(binding.path, root);
  const rootEntry = fs.entry(root);
  assert.equal(binding.dev, String(rootEntry.dev));
  assert.equal(binding.ino, String(rootEntry.ino));
  assert.deepEqual(JSON.parse(/** @type {string} */ (receipt.rootIdentity)), {
    dev: String(rootEntry.dev), ino: String(rootEntry.ino), uid: String(UID),
  });

  const writeCalls = fs.calls.filter((call) => ["chmod", "mkdir", "writeFile", "symlink"].includes(call.name));
  assert.ok(writeCalls.length > 0);
  for (const call of writeCalls) {
    assert.ok(call.path === root || call.path.startsWith(`${root}/`), `外写被拒绝: ${call.path}`);
  }
  assert.deepEqual(fs.calls.filter((call) => call.name === "chmod").map((call) => call.path), [root]);
  assert.equal(fs.entry(DARWIN_TMP).mode, 0o1777n);
  assert.equal(fs.entry(PROJECT).mode, 0o755n);
  assert.equal(SOURCE_TEXT.includes("rm("), false);
  assert.equal(SOURCE_TEXT.includes("rmdir"), false);

  const second = loaded.namespace.sdkTestSceneReceipt(handle);
  assert.ok(second);
  assert.notEqual(second, receipt, "每次必须返回新快照");
  assert.deepEqual(second, receipt);
  assert.equal(loaded.namespace.sdkTestSceneReceipt(Object.assign({}, handle)), undefined);
  let proxyReads = 0;
  const proxy = new Proxy(handle, { get() { proxyReads += 1; throw new Error("proxy getter"); } });
  assert.equal(loaded.namespace.sdkTestSceneReceipt(proxy), undefined);
  assert.equal(proxyReads, 0);
  let getterReads = 0;
  const lookalike = {};
  Object.defineProperty(lookalike, "root", { get() { getterReads += 1; throw new Error("getter"); } });
  assert.equal(loaded.namespace.sdkTestSceneReceipt(lookalike), undefined);
  assert.equal(getterReads, 0);
  assert.equal(loaded.namespace.sdkTestSceneReceipt(null), undefined);

  assert.equal(Reflect.set(receipt, "root", "/changed"), false);
  assert.equal(loaded.namespace.sdkTestSceneReceipt(handle)?.root, root);
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(handle), undefined);
  assert.equal(fs.calls.some((call) => /remove|rmdir|rm/.test(call.name)), false);
}

async function fixedSystemTempSelection() {
  const longEnvironmentTemp = `/environment/${"long-temp-parent-".repeat(12)}`;
  const projectEnvironmentTemp = `${PROJECT}/environment-temp`;
  const missingEnvironmentTemp = "/missing/environment-temp";
  const environment = {
    TMPDIR: longEnvironmentTemp,
    TMP: projectEnvironmentTemp,
    TEMP: missingEnvironmentTemp,
  };
  const scenarios = [
    { name: "linux", platform: /** @type {const} */ ("linux"), canonicalTempParent: LINUX_TMP },
    { name: "macOS", platform: /** @type {const} */ ("darwin"), canonicalTempParent: DARWIN_TMP },
  ];

  for (const scenario of scenarios) {
    const fs = new MemoryFs(scenario.canonicalTempParent);
    fs.addDirectory(longEnvironmentTemp, 0o700n, UID, 8n);
    fs.addDirectory(projectEnvironmentTemp, 0o700n, UID, 2n);
    const testProcess = new TestProcess(scenario.platform, environment);
    const loaded = await loadSceneModule(SOURCE_TEXT, fs, testProcess);
    const handle = await loaded.namespace.createSdkTestScene();
    const receipt = loaded.namespace.sdkTestSceneReceipt(handle);
    assert.ok(receipt);

    const tempRealpaths = fs.calls.filter((call) => call.name === "realpath" && call.path === LINUX_TMP);
    assert.equal(tempRealpaths.length, scenario.platform === "linux" ? 2 : 1,
      `${scenario.name}: helper必须先准确realpath('/tmp')，canonical目录复核可再次命中/tmp`);
    const mkdtempCalls = fs.calls.filter((call) => call.name === "mkdtemp");
    assert.equal(mkdtempCalls.length, 1, `${scenario.name}: 只允许一次根分配`);
    const expectedPrefix = join(scenario.canonicalTempParent, "pi-s-");
    assert.equal(mkdtempCalls[0].path, expectedPrefix, `${scenario.name}: mkdtemp必须使用canonical父目录和pi-s-`);
    assert.equal(receipt.root, `${expectedPrefix}000001`);

    const tmpEntry = fs.entry(LINUX_TMP);
    assert.equal(tmpEntry.kind, scenario.platform === "linux" ? "directory" : "symlink");
    if (tmpEntry.kind === "symlink") assert.equal(tmpEntry.target, DARWIN_TMP);

    for (const environmentPath of Object.values(environment)) {
      const accessed = fs.calls.some((call) =>
        call.path === environmentPath || call.path.startsWith(`${environmentPath}/`));
      assert.equal(accessed, false, `${scenario.name}: 不得访问环境临时目录 ${environmentPath}`);
      const allocated = [...fs.entries.keys()].some((path) => dirname(path) === environmentPath);
      assert.equal(allocated, false, `${scenario.name}: 不得在环境临时目录分配 ${environmentPath}`);
    }

    const root = /** @type {string} */ (receipt.root);
    const suffix = root.slice(expectedPrefix.length);
    assert.match(suffix, /^[A-Za-z0-9]{6}$/);
    const priorFirstLevel = join(scenario.canonicalTempParent, `pi-t-${suffix}`);
    assert.ok(Buffer.byteLength(root) <= Buffer.byteLength(priorFirstLevel),
      `${scenario.name}: pi-s-首层字节长度不得超过同父pi-t-首层`);
  }
}

async function preflightAndBoundaryFailures() {
  const base = new MemoryFs();
  const loaded = await loadSceneModule(SOURCE_TEXT, base);

  let argumentError;
  try {
    await Reflect.apply(loaded.namespace.createSdkTestScene, undefined, ["/attacker/path"]);
  } catch (error) {
    argumentError = error;
  }
  assertErrorValue(argumentError);
  assert.equal(argumentError.message, "SDK test scene allocation failed; allocated data was preserved");
  assert.equal(base.calls.length, 0);
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(argumentError)?.phase, "arguments");

  const unsupportedFs = new MemoryFs();
  const unsupported = await loadSceneModule(SOURCE_TEXT, unsupportedFs, new TestProcess("win32"));
  const unsupportedError = await captureFailure(unsupported.namespace);
  assert.equal(unsupportedFs.calls.length, 0);
  assert.equal(unsupported.namespace.sdkTestSceneFailureReceipt(unsupportedError)?.phase, "platform");

  /** @type {Array<{ name: string, prepare: (fs: MemoryFs) => void, phase: string }>} */
  const variants = [
    {
      name: "config-symlink",
      prepare(fs) {
        fs.addFile("/external/config.ts", CONFIG_BYTES);
        fs.addSymlink(`${PROJECT}/vitest.config.ts`, "/external/config.ts");
      },
      phase: "config-input",
    },
    {
      name: "package-not-module",
      prepare(fs) { fs.addFile(`${PROJECT}/package.json`, Buffer.from('{"type":"commonjs"}'), 0o644n, UID, 2n, 500n); },
      phase: "package-input",
    },
    {
      name: "node-modules-symlink",
      prepare(fs) {
        fs.addDirectory("/external/modules");
        fs.addSymlink(`${PROJECT}/node_modules`, "/external/modules");
      },
      phase: "project-node-modules",
    },
    {
      name: "vitest-outside",
      prepare(fs) {
        fs.addDirectory("/external/vitest");
        fs.addSymlink(`${PROJECT}/node_modules/vitest`, "/external/vitest");
      },
      phase: "vitest-target",
    },
  ];
  for (const variant of variants) {
    const fs = new MemoryFs();
    variant.prepare(fs);
    loaded.setFs(fs);
    const error = await captureFailure(loaded.namespace);
    const receipt = loaded.namespace.sdkTestSceneFailureReceipt(error);
    assert.equal(receipt?.phase, variant.phase, variant.name);
    assert.equal(receipt?.allocationAttempted, false);
    assert.equal(receipt?.root, null);
    assert.equal(fs.calls.some((call) => ["mkdtemp", "chmod", "mkdir", "writeFile", "symlink"].includes(call.name)), false);
  }

  const outside = new MemoryFs();
  outside.mkdtempOverride = "/external/pi-s-escape";
  loaded.setFs(outside);
  const outsideError = await captureFailure(loaded.namespace);
  const outsideReceipt = loaded.namespace.sdkTestSceneFailureReceipt(outsideError);
  assert.equal(outsideReceipt?.phase, "allocate-root");
  assert.equal(outsideReceipt?.allocationAttempted, true);
  assert.equal(outsideReceipt?.root, "/external/pi-s-escape");
  assert.equal(outside.calls.some((call) => call.name === "chmod" || call.name === "mkdir" || call.name === "writeFile" || call.name === "symlink"), false);
}

async function everyIoFailurePreservesFactsAndCause() {
  const baselineFs = new MemoryFs();
  const loaded = await loadSceneModule(SOURCE_TEXT, baselineFs);
  await loaded.namespace.createSdkTestScene();
  const totalCalls = baselineFs.callOrdinal;
  assert.ok(totalCalls > 50, "应覆盖完整的逐步I/O链");
  const opaque = Object.create(null);
  Object.defineProperty(opaque, "message", { get() { throw new Error("must not read opaque error"); } });
  const causes = [undefined, null, false, 0, "", opaque];

  for (let ordinal = 1; ordinal <= totalCalls; ordinal += 1) {
    const fs = new MemoryFs();
    const cause = causes[(ordinal - 1) % causes.length];
    fs.failAt = ordinal;
    fs.failureValue = cause;
    loaded.setFs(fs);
    let error;
    try {
      await loaded.namespace.createSdkTestScene();
    } catch (caught) {
      error = caught;
    }
    assert.equal(Object.prototype.toString.call(error), "[object Error]", `I/O ${ordinal}必须包装`);
    assertErrorValue(error);
    assert.equal(error.message, "SDK test scene allocation failed; allocated data was preserved");
    assert.equal(error.cause, cause, `I/O ${ordinal}必须保留原cause身份`);
    assert.equal(Object.isFrozen(error), true);
    const receipt = loaded.namespace.sdkTestSceneFailureReceipt(error);
    assert.ok(receipt, `I/O ${ordinal}必须有失败收据`);
    assert.equal(Object.isFrozen(receipt), true);
    assert.notEqual(receipt.phase, "ready");
    assert.equal(typeof receipt.phase, "string");
    assert.equal(fs.callOrdinal, ordinal, `I/O ${ordinal}后不得重试或继续`);
    assert.equal(fs.calls.some((call) => /remove|rmdir|rm/.test(call.name)), false);
    const second = loaded.namespace.sdkTestSceneFailureReceipt(error);
    assert.ok(second);
    assert.notEqual(second, receipt);
    assert.deepEqual(second, receipt);
    assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(Object.assign({}, error)), undefined);
    let proxyReads = 0;
    /** @type {object} */
    const proxy = new Proxy(/** @type {object} */ (error), {
      get() { proxyReads += 1; throw new Error("proxy"); },
    });
    assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(proxy), undefined);
    assert.equal(proxyReads, 0);

    const allocationCall = fs.calls.find((call) => call.name === "mkdtemp");
    assert.equal(receipt.allocationAttempted, allocationCall !== undefined);
    if (!allocationCall || allocationCall.ordinal === ordinal) {
      assert.equal(receipt.root, null, `I/O ${ordinal}未取得路径时必须保持unknown`);
      assert.equal(receipt.rootIdentity, null);
    }
    for (const call of fs.calls.filter((item) => ["chmod", "mkdir", "writeFile", "symlink"].includes(item.name))) {
      const knownRoot = /** @type {string} */ (receipt.root ?? rootPath(fs));
      assert.ok(call.path === knownRoot || call.path.startsWith(`${knownRoot}/`));
    }
  }
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(opaque), undefined);
  process.stdout.write(`scene failure matrix: ${totalCalls} I/O points, falsy and opaque causes preserved\n`);
}

async function driftAndPreservationFailures() {
  const loaded = await loadSceneModule(SOURCE_TEXT, new MemoryFs());

  const inputDrift = new MemoryFs();
  inputDrift.afterCall = (call, fs) => {
    if (call.name === "readFile" && call.path === `${PROJECT}/vitest.config.ts`) {
      fs.entry(call.path).ino += 1n;
    }
  };
  loaded.setFs(inputDrift);
  const inputError = await captureFailure(loaded.namespace);
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(inputError)?.phase, "config-input");
  assert.equal(inputDrift.calls.some((call) => call.name === "mkdtemp"), false);

  const rootDrift = new MemoryFs();
  rootDrift.afterCall = (call, fs) => {
    if (call.name === "mkdir" && call.path.endsWith("/home")) {
      fs.entry(dirname(call.path)).ino += 1n;
    }
  };
  loaded.setFs(rootDrift);
  const rootError = await captureFailure(loaded.namespace);
  const rootReceipt = loaded.namespace.sdkTestSceneFailureReceipt(rootError);
  assert.equal(rootReceipt?.phase, "home");
  assert.equal(typeof rootReceipt?.root, "string");
  assert.equal(typeof rootReceipt?.rootIdentity, "string");
  assert.equal(rootDrift.entry(/** @type {string} */ (rootReceipt?.root)).kind, "directory");
  assert.equal(rootDrift.calls.some((call) => /remove|rmdir|rm/.test(call.name)), false);

  const parentDrift = new MemoryFs();
  parentDrift.afterCall = (call, fs) => {
    if (call.name === "mkdir" && call.path.endsWith("/home/.pi")) {
      fs.entry(dirname(call.path)).ino += 1n;
    }
  };
  loaded.setFs(parentDrift);
  const parentError = await captureFailure(loaded.namespace);
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(parentError)?.phase, "home-pi");
  assert.equal(parentDrift.entries.has(`${rootPath(parentDrift)}/home/.pi`), true, "漂移后部分结果保全");

  const targetDrift = new MemoryFs();
  let targetSeen = false;
  targetDrift.afterCall = (call, fs) => {
    if (!targetSeen && call.name === "lstat" && call.path === VITEST_TARGET) {
      targetSeen = true;
      fs.entry(VITEST_TARGET).ino += 1n;
    }
  };
  loaded.setFs(targetDrift);
  const targetError = await captureFailure(loaded.namespace);
  assert.equal(loaded.namespace.sdkTestSceneFailureReceipt(targetError)?.phase, "revalidate-vitest-target");
  assert.equal(targetDrift.calls.some((call) => call.name === "symlink" && call.path.includes("pi-s-")), false);
}

async function mutationChecks() {
  const identityNeedle = "actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid";
  assert.equal(SOURCE_TEXT.split(identityNeedle).length, 2);
  const identityMutant = SOURCE_TEXT.replace(identityNeedle, "false");
  const identityFs = new MemoryFs();
  const identityLoaded = await loadSceneModule(identityMutant, identityFs);
  identityFs.afterCall = (call, fs) => {
    if (call.name === "mkdir" && call.path.endsWith("/home")) fs.entry(dirname(call.path)).ino += 1n;
  };
  let identityFailure;
  try {
    await assert.rejects(identityLoaded.namespace.createSdkTestScene());
  } catch (error) {
    identityFailure = error;
  }
  assert.ok(identityFailure instanceof AssertionError, "identity mutant必须加载后由真实断言杀死");
  assert.equal(identityFailure instanceof SyntaxError, false);

  const causeNeedle = "value: cause,";
  assert.equal(SOURCE_TEXT.split(causeNeedle).length, 2);
  const causeMutant = SOURCE_TEXT.replace(causeNeedle, "value: undefined,");
  const causeFs = new MemoryFs();
  const causeLoaded = await loadSceneModule(causeMutant, causeFs);
  const originalCause = Object.freeze(Object.create(null));
  causeFs.failAt = 1;
  causeFs.failureValue = originalCause;
  let causeFailure;
  try {
    await causeLoaded.namespace.createSdkTestScene();
    assert.fail("mutant必须拒绝");
  } catch (error) {
    try {
      assertErrorValue(error);
      assert.equal(error.cause, originalCause);
    } catch (assertion) {
      causeFailure = assertion;
    }
  }
  assert.ok(causeFailure instanceof AssertionError, "cause mutant必须加载后由真实断言杀死");
  assert.equal(causeFailure instanceof SyntaxError, false);

  const fixedTempNeedle = 'await realpath("/tmp")';
  assert.equal(SOURCE_TEXT.split(fixedTempNeedle).length, 2);
  const environmentFallbackMutant = SOURCE_TEXT.replace(
    fixedTempNeedle,
    'await realpath(process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp")',
  );
  const environmentTemp = `/environment/${"mutant-long-temp-parent-".repeat(10)}`;
  const environmentFs = new MemoryFs(DARWIN_TMP);
  environmentFs.addDirectory(environmentTemp, 0o700n, UID, 8n);
  const environmentLoaded = await loadSceneModule(
    environmentFallbackMutant,
    environmentFs,
    new TestProcess("darwin", { TMPDIR: environmentTemp }),
  );
  let environmentFailure;
  try {
    const handle = await environmentLoaded.namespace.createSdkTestScene();
    const receipt = environmentLoaded.namespace.sdkTestSceneReceipt(handle);
    assert.ok(receipt, "环境回退mutant必须先成功分配");
    assert.match(/** @type {string} */ (receipt.root), /^\/private\/tmp\/pi-s-/,
      "策略断言必须拒绝环境目录分配");
  } catch (error) {
    environmentFailure = error;
  }
  assert.ok(environmentFailure instanceof AssertionError,
    "环境回退mutant必须成功加载和分配后由策略断言杀死");
  assert.equal(environmentFailure instanceof SyntaxError, false);
  assert.equal(environmentFs.calls.some((call) =>
    call.name === "mkdtemp" && call.path === join(environmentTemp, "pi-s-")), true,
  "环境回退mutant必须实际尝试在错误位置分配");
}

await normalAllocationAndReceipts();
await fixedSystemTempSelection();
await preflightAndBoundaryFailures();
await everyIoFailurePreservesFactsAndCause();
await driftAndPreservationFailures();
await mutationChecks();
process.stdout.write("pm-sdk-private-scene VM: baseline PASS; fixed canonical /tmp, first-level length, layout, identity, failure matrix, no-remove and three mutants PASS\n");
