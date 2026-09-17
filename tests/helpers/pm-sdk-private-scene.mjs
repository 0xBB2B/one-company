// @ts-check
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_MESSAGE = "SDK test scene allocation failed; allocated data was preserved";
const CONFIG_NAME = "vitest.config.ts";
const PACKAGE_NAME = "package.json";
const PRIVATE_PACKAGE_BYTES = Buffer.from('{"type":"module"}\n', "utf8");
const SUCCESS_RECEIPTS = new WeakMap();
const FAILURE_RECEIPTS = new WeakMap();
const PROJECT_FROM_MODULE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @typedef {{ path: string, dev: string, ino: string, uid: string, mode: string }} DirectoryIdentity */
/**
 * @typedef {{
 *   status: "allocated",
 *   phase: "ready",
 *   allocationAttempted: true,
 *   projectRoot: string,
 *   root: string,
 *   rootIdentity: string,
 *   homeDir: string,
 *   agentDir: string,
 *   agentsDir: string,
 *   xdgConfigHome: string,
 *   xdgCacheHome: string,
 *   tmpDir: string,
 *   cacheDir: string,
 *   configPath: string,
 *   packagePath: string,
 *   nodeModulesPath: string,
 *   viteTempDir: string,
 *   vitestLinkPath: string,
 *   configHash: string,
 *   vitestTarget: string,
 *   parentBinding: string,
 * }} SuccessReceipt
 */
/**
 * @typedef {{
 *   status: "preserved",
 *   phase: string,
 *   allocationAttempted: boolean,
 *   projectRoot: string | null,
 *   root: string | null,
 *   rootIdentity: string | null,
 * }} FailureReceipt
 */

/** @param {string} code @returns {never} */
function fail(code) {
  throw new Error(code);
}

/** @param {string} parent @param {string} candidate */
function isStrictDescendant(parent, candidate) {
  const offset = relative(parent, candidate);
  return offset.length > 0 && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/** @param {import("node:fs").BigIntStats} stats */
function modeText(stats) {
  return (stats.mode & 0o7777n).toString(8).padStart(4, "0");
}

/** @param {string} path @param {import("node:fs").BigIntStats} stats @returns {DirectoryIdentity} */
function directoryIdentity(path, stats) {
  return Object.freeze({
    path,
    dev: String(stats.dev),
    ino: String(stats.ino),
    uid: String(stats.uid),
    mode: modeText(stats),
  });
}

/** @param {string} path @param {boolean} requirePrivate */
async function inspectDirectory(path, requirePrivate) {
  const stats = await lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail("expected_regular_directory");
  if (await realpath(path) !== path) fail("expected_canonical_directory");
  if (typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {
    if (requirePrivate) fail("directory_owner_mismatch");
  }
  if (requirePrivate && (stats.mode & 0o7777n) !== 0o700n) fail("directory_mode_mismatch");
  return directoryIdentity(path, stats);
}

/** @param {DirectoryIdentity} expected @param {boolean} requirePrivate */
async function verifyDirectory(expected, requirePrivate) {
  const actual = await inspectDirectory(expected.path, requirePrivate);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid) {
    fail("directory_identity_changed");
  }
  if (requirePrivate && actual.mode !== "0700") fail("directory_mode_changed");
}

/** @param {string} path */
async function inspectInputFile(path) {
  const stats = await lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) fail("expected_regular_input_file");
  if (await realpath(path) !== path) fail("expected_canonical_input_file");
  return Object.freeze({ path, dev: String(stats.dev), ino: String(stats.ino), size: String(stats.size) });
}

/** @param {Readonly<{ path: string, dev: string, ino: string, size: string }>} expected */
async function verifyInputFile(expected) {
  const actual = await inspectInputFile(expected.path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) {
    fail("input_file_identity_changed");
  }
}

/** @param {string} path */
async function readStableInput(path) {
  const identity = await inspectInputFile(path);
  const bytes = await readFile(path);
  await verifyInputFile(identity);
  return bytes;
}

/** @param {string} root @param {string} target */
function requireInsideRoot(root, target) {
  if (!isStrictDescendant(root, target)) fail("scene_write_outside_root");
}

/**
 * @param {DirectoryIdentity} rootIdentity
 * @param {DirectoryIdentity} parentIdentity
 * @param {string} target
 * @param {() => Promise<void>} write
 */
async function guardedWrite(rootIdentity, parentIdentity, target, write) {
  requireInsideRoot(rootIdentity.path, target);
  if (dirname(target) !== parentIdentity.path) fail("scene_parent_mismatch");
  await verifyDirectory(rootIdentity, true);
  if (parentIdentity.path !== rootIdentity.path) await verifyDirectory(parentIdentity, true);
  await write();
  await verifyDirectory(rootIdentity, true);
  if (parentIdentity.path !== rootIdentity.path) await verifyDirectory(parentIdentity, true);
}

/**
 * @param {DirectoryIdentity} rootIdentity
 * @param {DirectoryIdentity} parentIdentity
 * @param {string} name
 */
async function createPrivateDirectory(rootIdentity, parentIdentity, name) {
  const target = join(parentIdentity.path, name);
  await guardedWrite(rootIdentity, parentIdentity, target, async () => {
    await mkdir(target, { mode: 0o700 });
  });
  const identity = await inspectDirectory(target, true);
  await verifyDirectory(rootIdentity, true);
  await verifyDirectory(parentIdentity, true);
  return identity;
}

/**
 * @param {DirectoryIdentity} rootIdentity
 * @param {DirectoryIdentity} parentIdentity
 * @param {string} name
 * @param {Uint8Array} bytes
 */
async function createPrivateFile(rootIdentity, parentIdentity, name, bytes) {
  const target = join(parentIdentity.path, name);
  await guardedWrite(rootIdentity, parentIdentity, target, async () => {
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  });
  const stats = await lstat(target, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile() || await realpath(target) !== target) {
    fail("created_file_is_not_regular");
  }
  if (typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {
    fail("created_file_owner_mismatch");
  }
  if ((stats.mode & 0o7777n) !== 0o600n) fail("created_file_mode_mismatch");
  await verifyDirectory(rootIdentity, true);
  await verifyDirectory(parentIdentity, true);
  return target;
}

/**
 * @param {DirectoryIdentity} rootIdentity
 * @param {DirectoryIdentity} parentIdentity
 * @param {string} name
 * @param {string} target
 */
async function createPackageLink(rootIdentity, parentIdentity, name, target) {
  const link = join(parentIdentity.path, name);
  await guardedWrite(rootIdentity, parentIdentity, link, async () => {
    await symlink(target, link, "dir");
  });
  const stats = await lstat(link, { bigint: true });
  if (!stats.isSymbolicLink() || await readlink(link) !== target || await realpath(link) !== target) {
    fail("created_package_link_mismatch");
  }
  await verifyDirectory(rootIdentity, true);
  await verifyDirectory(parentIdentity, true);
  return link;
}

/** @param {SuccessReceipt} receipt @returns {Readonly<SuccessReceipt>} */
function successSnapshot(receipt) {
  return Object.freeze({
    status: receipt.status,
    phase: receipt.phase,
    allocationAttempted: receipt.allocationAttempted,
    projectRoot: receipt.projectRoot,
    root: receipt.root,
    rootIdentity: receipt.rootIdentity,
    homeDir: receipt.homeDir,
    agentDir: receipt.agentDir,
    agentsDir: receipt.agentsDir,
    xdgConfigHome: receipt.xdgConfigHome,
    xdgCacheHome: receipt.xdgCacheHome,
    tmpDir: receipt.tmpDir,
    cacheDir: receipt.cacheDir,
    configPath: receipt.configPath,
    packagePath: receipt.packagePath,
    nodeModulesPath: receipt.nodeModulesPath,
    viteTempDir: receipt.viteTempDir,
    vitestLinkPath: receipt.vitestLinkPath,
    configHash: receipt.configHash,
    vitestTarget: receipt.vitestTarget,
    parentBinding: receipt.parentBinding,
  });
}

/** @param {FailureReceipt} receipt @returns {Readonly<FailureReceipt>} */
function failureSnapshot(receipt) {
  return Object.freeze({
    status: receipt.status,
    phase: receipt.phase,
    allocationAttempted: receipt.allocationAttempted,
    projectRoot: receipt.projectRoot,
    root: receipt.root,
    rootIdentity: receipt.rootIdentity,
  });
}

/**
 * Allocates one private outer test scene. It does not run, stop, or remove any
 * process or filesystem resource. A failed allocation is deliberately kept.
 */
export async function createSdkTestScene() {
  let phase = "arguments";
  let allocationAttempted = false;
  /** @type {string | null} */
  let projectRoot = null;
  /** @type {string | null} */
  let root = null;
  /** @type {string | null} */
  let rootIdentityText = null;

  try {
    if (arguments.length !== 0) fail("scene_factory_takes_no_arguments");
    phase = "platform";
    if (process.platform !== "darwin" && process.platform !== "linux") fail("unsupported_platform");
    if (typeof process.getuid !== "function") fail("uid_unavailable");

    phase = "project-root";
    projectRoot = await realpath(PROJECT_FROM_MODULE);
    if (projectRoot !== PROJECT_FROM_MODULE) fail("project_root_not_canonical");
    const projectIdentity = await inspectDirectory(projectRoot, false);

    phase = "config-input";
    const originalConfigPath = join(projectRoot, CONFIG_NAME);
    const configBytes = await readStableInput(originalConfigPath);

    phase = "package-input";
    const originalPackagePath = join(projectRoot, PACKAGE_NAME);
    const packageBytes = await readStableInput(originalPackagePath);
    let packageValue;
    try {
      packageValue = JSON.parse(packageBytes.toString("utf8"));
    } catch (cause) {
      throw cause;
    }
    if (typeof packageValue !== "object" || packageValue === null || Array.isArray(packageValue) ||
      !Object.prototype.hasOwnProperty.call(packageValue, "type") || packageValue.type !== "module") {
      fail("project_package_must_be_module");
    }

    phase = "project-node-modules";
    const projectNodeModules = join(projectRoot, "node_modules");
    const projectNodeModulesIdentity = await inspectDirectory(projectNodeModules, false);
    if (!isStrictDescendant(projectRoot, projectNodeModules)) fail("project_node_modules_outside_project");

    phase = "vitest-target";
    const sourceVitestLink = join(projectNodeModules, "vitest");
    const vitestTarget = await realpath(sourceVitestLink);
    if (!isStrictDescendant(projectNodeModules, vitestTarget)) fail("vitest_target_outside_project_node_modules");
    const vitestTargetIdentity = await inspectDirectory(vitestTarget, false);
    await verifyDirectory(projectIdentity, false);
    await verifyDirectory(projectNodeModulesIdentity, false);

    phase = "system-temp";
    const systemTemp = await realpath("/tmp");
    await inspectDirectory(systemTemp, false);

    phase = "allocate-root";
    allocationAttempted = true;
    root = await mkdtemp(join(systemTemp, "pi-s-"));
    if (!isStrictDescendant(systemTemp, root) || dirname(root) !== systemTemp || !root.startsWith(join(systemTemp, "pi-s-"))) {
      fail("allocated_root_outside_system_temp");
    }

    phase = "secure-root";
    const initialRoot = await inspectDirectory(root, false);
    if (initialRoot.uid !== String(process.getuid())) fail("allocated_root_owner_mismatch");
    rootIdentityText = JSON.stringify({ dev: initialRoot.dev, ino: initialRoot.ino, uid: initialRoot.uid });
    await chmod(root, 0o700);
    const rootIdentity = await inspectDirectory(root, true);
    if (rootIdentity.dev !== initialRoot.dev || rootIdentity.ino !== initialRoot.ino || rootIdentity.uid !== initialRoot.uid) {
      fail("allocated_root_identity_changed");
    }

    phase = "home";
    const home = await createPrivateDirectory(rootIdentity, rootIdentity, "home");
    phase = "home-pi";
    const homePi = await createPrivateDirectory(rootIdentity, home, ".pi");
    phase = "agent-dir";
    const agent = await createPrivateDirectory(rootIdentity, homePi, "agent");
    phase = "agents-dir";
    const agents = await createPrivateDirectory(rootIdentity, home, ".agents");
    phase = "xdg-config";
    const xdgConfig = await createPrivateDirectory(rootIdentity, home, ".config");
    phase = "xdg-cache";
    const xdgCache = await createPrivateDirectory(rootIdentity, home, ".cache");
    phase = "tmp";
    const privateTmp = await createPrivateDirectory(rootIdentity, rootIdentity, "tmp");
    phase = "cache";
    const cache = await createPrivateDirectory(rootIdentity, rootIdentity, "cache");
    phase = "node-modules";
    const nodeModules = await createPrivateDirectory(rootIdentity, rootIdentity, "node_modules");
    phase = "vite-temp";
    const viteTemp = await createPrivateDirectory(rootIdentity, nodeModules, ".vite-temp");

    phase = "copy-config";
    const configPath = await createPrivateFile(rootIdentity, rootIdentity, CONFIG_NAME, configBytes);
    phase = "write-package";
    const packagePath = await createPrivateFile(rootIdentity, rootIdentity, PACKAGE_NAME, PRIVATE_PACKAGE_BYTES);

    phase = "revalidate-vitest-target";
    await verifyDirectory(projectIdentity, false);
    await verifyDirectory(projectNodeModulesIdentity, false);
    await verifyDirectory(vitestTargetIdentity, false);
    phase = "link-vitest";
    const vitestLink = await createPackageLink(rootIdentity, nodeModules, "vitest", vitestTarget);

    phase = "final-verification";
    await verifyDirectory(rootIdentity, true);
    const parentBinding = JSON.stringify({ path: root, dev: rootIdentity.dev, ino: rootIdentity.ino });
    const receipt = /** @type {SuccessReceipt} */ (Object.freeze({
      status: "allocated",
      phase: "ready",
      allocationAttempted: true,
      projectRoot,
      root,
      rootIdentity: rootIdentityText,
      homeDir: home.path,
      agentDir: agent.path,
      agentsDir: agents.path,
      xdgConfigHome: xdgConfig.path,
      xdgCacheHome: xdgCache.path,
      tmpDir: privateTmp.path,
      cacheDir: cache.path,
      configPath,
      packagePath,
      nodeModulesPath: nodeModules.path,
      viteTempDir: viteTemp.path,
      vitestLinkPath: vitestLink,
      configHash: `sha256:${createHash("sha256").update(configBytes).digest("hex")}`,
      vitestTarget,
      parentBinding,
    }));
    const handle = Object.freeze(Object.create(null));
    SUCCESS_RECEIPTS.set(handle, receipt);
    return handle;
  } catch (cause) {
    const wrapped = new Error(FAILURE_MESSAGE);
    Object.defineProperty(wrapped, "cause", {
      value: cause,
      writable: false,
      configurable: false,
      enumerable: false,
    });
    const receipt = /** @type {FailureReceipt} */ (Object.freeze({
      status: "preserved",
      phase,
      allocationAttempted,
      projectRoot,
      root,
      rootIdentity: rootIdentityText,
    }));
    FAILURE_RECEIPTS.set(wrapped, receipt);
    Object.freeze(wrapped);
    throw wrapped;
  }
}

/** @param {unknown} originalScene */
export function sdkTestSceneReceipt(originalScene) {
  if ((typeof originalScene !== "object" || originalScene === null) && typeof originalScene !== "function") {
    return undefined;
  }
  const receipt = SUCCESS_RECEIPTS.get(originalScene);
  return receipt === undefined ? undefined : successSnapshot(receipt);
}

/** @param {unknown} originalError */
export function sdkTestSceneFailureReceipt(originalError) {
  if ((typeof originalError !== "object" || originalError === null) && typeof originalError !== "function") {
    return undefined;
  }
  const receipt = FAILURE_RECEIPTS.get(originalError);
  return receipt === undefined ? undefined : failureSnapshot(receipt);
}
