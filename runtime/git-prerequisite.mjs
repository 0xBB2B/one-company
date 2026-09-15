import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { getuid } from "node:process";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_MESSAGE = "必须预先安装Git并确保PATH可用";
const VERSION_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const PACKAGE_ROOT = realpathSync.native(fileURLToPath(new URL("../", import.meta.url)));
const trustedBindings = new WeakSet();

const ERROR_CODES = Object.freeze({
  INVALID_CONFIGURATION: "git_invalid_configuration",
  NOT_FOUND: "git_not_found",
  UNSAFE: "git_unsafe",
  BINDING_UNTRUSTED: "git_binding_untrusted",
  CHANGED: "git_changed",
  VERSION_FAILED: "git_version_failed",
  VERSION_INVALID: "git_version_invalid",
  VERSION_TIMEOUT: "git_version_timeout",
  VERSION_OUTPUT_LIMIT: "git_version_output_limit",
});

export class GitPrerequisiteError extends Error {
  constructor(code) {
    super(`Git 前置检查失败（${code}）：${REQUIRED_MESSAGE}。`);
    this.name = "GitPrerequisiteError";
    this.code = code;
  }
}

function fail(code) {
  throw new GitPrerequisiteError(code);
}

function currentUid() {
  if (typeof getuid !== "function") fail(ERROR_CODES.UNSAFE);
  return getuid();
}

function modeOf(stat) {
  return Number(stat.mode & 0o7777n);
}

function identityOf(path, stat, type) {
  return Object.freeze({
    path,
    type,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: modeOf(stat),
    // 普通目录中增删无关兄弟项不改变Git身份；文件/链接的重建仍须失效。
    ...(type === "directory" ? {} : { ctimeNs: stat.ctimeNs.toString() }),
  });
}

function sameIdentity(left, right) {
  return left.path === right.path
    && left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.ctimeNs === right.ctimeNs;
}

export function parseMacOsAdminGroup(contents) {
  if (typeof contents !== "string") fail(ERROR_CODES.UNSAFE);
  let adminGid;
  let adminRecords = 0;
  for (const line of contents.split(/\r?\n/u)) {
    const fields = line.split(":");
    if (fields[0] !== "admin") continue;
    adminRecords += 1;
    if (fields.length !== 4 || !/^\d+$/u.test(fields[2])) fail(ERROR_CODES.UNSAFE);
    const gid = Number(fields[2]);
    if (!Number.isSafeInteger(gid) || gid < 0 || gid > 0x7fffffff) fail(ERROR_CODES.UNSAFE);
    adminGid = gid;
  }
  if (adminRecords !== 1 || adminGid === undefined) fail(ERROR_CODES.UNSAFE);
  return adminGid;
}

export function readMacOsAdminGroup(readGroupFile = () => readFileSync("/etc/group", "utf8")) {
  let contents;
  try {
    contents = readGroupFile();
  } catch {
    fail(ERROR_CODES.UNSAFE);
  }
  return parseMacOsAdminGroup(contents);
}

function macOsAdminGid() {
  if (process.platform !== "darwin") return undefined;
  return readMacOsAdminGroup();
}

function assertTrustedOwner(stat, uid) {
  const owner = Number(stat.uid);
  if (owner !== 0 && owner !== uid) fail(ERROR_CODES.UNSAFE);
}

function directoryIdentity(path, stat, uid, adminGid) {
  if (!stat.isDirectory()) fail(ERROR_CODES.UNSAFE);
  assertTrustedOwner(stat, uid);
  const mode = modeOf(stat);
  if ((mode & 0o002) !== 0) fail(ERROR_CODES.UNSAFE);
  if ((mode & 0o020) !== 0) {
    const allowedAdminDirectory = process.platform === "darwin"
      && adminGid !== undefined
      && Number(stat.gid) === adminGid;
    if (!allowedAdminDirectory) fail(ERROR_CODES.UNSAFE);
  }
  return identityOf(path, stat, "directory");
}

function recordDirectoryIdentity(state, identity) {
  const key = `${identity.type}:${identity.path}`;
  const previous = state.identities.get(key);
  if (previous && !sameIdentity(previous, identity)) fail(ERROR_CODES.CHANGED);
  if (!previous) {
    state.identities.set(key, identity);
    if (identity.type === "symlink") state.links.push(identity);
    else state.directories.push(identity);
  }
}

function pathParts(path) {
  const root = parse(path).root;
  return { root, parts: path.slice(root.length).split(sep).filter(Boolean) };
}

function snapshotDirectoryPath(directoryPath, uid, adminGid) {
  if (!isAbsolute(directoryPath)) fail(ERROR_CODES.UNSAFE);
  const traversal = { linksRemaining: 40, identities: new Map(), directories: [], links: [] };
  const { root, parts } = pathParts(directoryPath);
  let cursor = root;
  const pending = [...parts];
  const recordDirectory = () => {
    let stat;
    try { stat = lstatSync(cursor, { bigint: true }); } catch { fail(ERROR_CODES.UNSAFE); }
    recordDirectoryIdentity(traversal, directoryIdentity(cursor, stat, uid, adminGid));
  };
  recordDirectory();
  while (pending.length) {
    const part = pending.shift();
    if (part === ".") continue;
    if (part === "..") { cursor = dirname(cursor); recordDirectory(); continue; }
    const next = join(cursor, part);
    let stat;
    try { stat = lstatSync(next, { bigint: true }); } catch { fail(ERROR_CODES.UNSAFE); }
    if (stat.isSymbolicLink()) {
      assertTrustedOwner(stat, uid);
      recordDirectoryIdentity(traversal, identityOf(next, stat, "symlink"));
      if (--traversal.linksRemaining < 0) fail(ERROR_CODES.UNSAFE);
      let target;
      try { target = readlinkSync(next); } catch { fail(ERROR_CODES.UNSAFE); }
      if (isAbsolute(target)) {
        const parsed = pathParts(target); cursor = parsed.root; pending.unshift(...parsed.parts); recordDirectory();
      } else pending.unshift(...target.split(sep).filter(Boolean));
    } else {
      cursor = next;
      recordDirectoryIdentity(traversal, directoryIdentity(cursor, stat, uid, adminGid));
    }
  }
  return Object.freeze({ canonicalPath: cursor, directories: Object.freeze(traversal.directories), links: Object.freeze(traversal.links) });
}

function snapshotEntry(entryPath, uid) {
  let stat;
  try {
    stat = lstatSync(entryPath, { bigint: true });
  } catch {
    fail(ERROR_CODES.CHANGED);
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) fail(ERROR_CODES.UNSAFE);
  assertTrustedOwner(stat, uid);
  return identityOf(entryPath, stat, stat.isSymbolicLink() ? "symlink" : "file");
}

function assertTrustedTargetStat(targetPath, stat, uid) {
  if (!stat.isFile()) fail(ERROR_CODES.UNSAFE);
  assertTrustedOwner(stat, uid);
  const mode = modeOf(stat);
  if ((mode & 0o6000) !== 0 || (mode & 0o022) !== 0 || (mode & 0o111) === 0) {
    fail(ERROR_CODES.UNSAFE);
  }
  return identityOf(targetPath, stat, "file");
}

function hashOpenTarget(targetPath, uid) {
  let pathStat;
  try {
    pathStat = lstatSync(targetPath, { bigint: true });
  } catch {
    fail(ERROR_CODES.UNSAFE);
  }
  const beforeIdentity = assertTrustedTargetStat(targetPath, pathStat, uid);

  let fd;
  try {
    fd = openSync(targetPath, constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0));
  } catch {
    fail(ERROR_CODES.UNSAFE);
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    const openIdentity = assertTrustedTargetStat(targetPath, stat, uid);
    if (!sameIdentity(beforeIdentity, openIdentity)) fail(ERROR_CODES.CHANGED);
    try {
      accessSync(targetPath, constants.X_OK);
    } catch {
      fail(ERROR_CODES.UNSAFE);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    let afterStat;
    try {
      afterStat = lstatSync(targetPath, { bigint: true });
    } catch {
      fail(ERROR_CODES.CHANGED);
    }
    const afterIdentity = assertTrustedTargetStat(targetPath, afterStat, uid);
    if (!sameIdentity(openIdentity, afterIdentity)) fail(ERROR_CODES.CHANGED);
    return Object.freeze({
      ...openIdentity,
      sha256: hash.digest("hex"),
    });
  } finally {
    closeSync(fd);
  }
}

function expectedGitName(path) {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  return process.platform === "win32" ? name.toLowerCase() === "git.exe" : name === "git";
}

function canonicalExcludedRoot(path) {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (error?.code !== "ENOENT") fail(ERROR_CODES.INVALID_CONFIGURATION);
    // realpath的ENOENT也可能来自断链；去掉末尾分隔符后检查节点本身，不能把断链当普通缺失目录。
    let probePath = path;
    const rootLength = parse(path).root.length;
    while (probePath.length > rootLength && probePath.endsWith(sep)) probePath = probePath.slice(0, -sep.length);
    let present;
    try { present = lstatSync(probePath); }
    catch (probeError) { if (probeError?.code !== "ENOENT") fail(ERROR_CODES.INVALID_CONFIGURATION); }
    if (present) fail(ERROR_CODES.INVALID_CONFIGURATION);
    // 尚未创建的尾部只在真实解析已存在父路径之后拼接，保留别名/..的实际语义。
    const parent = dirname(path);
    if (parent === path) fail(ERROR_CODES.INVALID_CONFIGURATION);
    return join(canonicalExcludedRoot(parent), basename(path));
  }
}

function isWithin(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}

function normalizeExcludedRoots(additionalRoots = []) {
  if (!Array.isArray(additionalRoots)) fail(ERROR_CODES.INVALID_CONFIGURATION);
  const inputs = new Set([PACKAGE_ROOT, process.cwd()]);
  for (const root of additionalRoots) {
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) fail(ERROR_CODES.INVALID_CONFIGURATION);
    inputs.add(root);
  }
  const roots = new Set([...inputs].map(canonicalExcludedRoot));
  return { inputs: Object.freeze([...inputs]), roots: Object.freeze([...roots]) };
}

function assertOutsideExcludedRoots(paths, excludedRoots) {
  for (const root of excludedRoots) {
    if (paths.some((path) => isWithin(root, path))) fail(ERROR_CODES.UNSAFE);
  }
}

function isNodeModulesBin(path) {
  const normalized = process.platform === "win32" ? path.toLowerCase() : path;
  const suffix = `${sep}node_modules${sep}.bin`;
  return normalized === `node_modules${sep}.bin` || normalized.endsWith(suffix);
}

function snapshotCandidate(entryPath, excludedRoots) {
  const uid = currentUid(), adminGid = macOsAdminGid();
  const collected = { identities: new Map(), directories: [], links: [] };
  const fileLinks = [];
  let candidate = entryPath, canonicalEntryDirectory;
  const entry = snapshotEntry(entryPath, uid);
  for (let hop = 0; hop <= 40; hop++) {
    const directory = snapshotDirectoryPath(dirname(candidate), uid, adminGid);
    canonicalEntryDirectory ??= directory.canonicalPath;
    const name = candidate.slice(candidate.lastIndexOf(sep) + 1);
    if (!name || name === "." || name === "..") fail(ERROR_CODES.UNSAFE);
    const canonicalPath = join(directory.canonicalPath, name);
    const paths = [canonicalPath, directory.canonicalPath,
      ...directory.directories.map((item) => item.path), ...directory.links.map((item) => item.path)];
    assertOutsideExcludedRoots(paths, excludedRoots);
    if (paths.some((path) => isNodeModulesBin(path) || isNodeModulesBin(dirname(path)))) fail(ERROR_CODES.UNSAFE);
    for (const item of [...directory.directories, ...directory.links]) recordDirectoryIdentity(collected, item);
    let stat;
    try { stat = lstatSync(canonicalPath, { bigint: true }); } catch { fail(ERROR_CODES.UNSAFE); }
    if (!stat.isSymbolicLink()) {
      if (!expectedGitName(canonicalPath)) fail(ERROR_CODES.UNSAFE);
      return { entry, target: hashOpenTarget(canonicalPath, uid), canonicalEntryDirectory,
        directories: Object.freeze(collected.directories), directoryLinks: Object.freeze(collected.links), fileLinks: Object.freeze(fileLinks) };
    }
    assertTrustedOwner(stat, uid);
    const identity = identityOf(canonicalPath, stat, "symlink");
    if (fileLinks.some((link) => link.dev === identity.dev && link.ino === identity.ino)) fail(ERROR_CODES.UNSAFE);
    fileLinks.push(identity);
    let target;
    try { target = readlinkSync(canonicalPath); } catch { fail(ERROR_CODES.UNSAFE); }
    // 不先resolve折叠..，由逐段目录遍历按真实链接语义核对所有经过的节点。
    candidate = isAbsolute(target) ? target : `${directory.canonicalPath}${sep}${target}`;
  }
  fail(ERROR_CODES.UNSAFE);
}

function freezeBinding(entryPath, excludedRoots, excludedRootInputs, snapshot) {
  const binding = Object.freeze({
    entryPath,
    executablePath: snapshot.target.path,
    platform: process.platform,
    uid: currentUid(),
    excludedRoots,
    excludedRootInputs,
    entry: snapshot.entry,
    target: snapshot.target,
    canonicalEntryDirectory: snapshot.canonicalEntryDirectory,
    directories: snapshot.directories,
    directoryLinks: snapshot.directoryLinks,
    fileLinks: snapshot.fileLinks,
  });
  trustedBindings.add(binding);
  return binding;
}

export function resolveHostGit(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail(ERROR_CODES.INVALID_CONFIGURATION);
  }
  if (Object.keys(options).some((key) => key !== "path" && key !== "excludedRoots")) {
    fail(ERROR_CODES.INVALID_CONFIGURATION);
  }
  const pathValue = options.path === undefined ? process.env.PATH : options.path;
  if (typeof pathValue !== "string") fail(ERROR_CODES.NOT_FOUND);
  const exclusions = normalizeExcludedRoots(options.excludedRoots ?? []), excludedRoots = exclusions.roots;
  const executableName = process.platform === "win32" ? "git.exe" : "git";

  for (const item of pathValue.split(delimiter)) {
    if (item === "" || !isAbsolute(item)) continue;
    const pathEntry = item;
    if (isNodeModulesBin(pathEntry)) continue;
    const entryPath = `${pathEntry}${pathEntry.endsWith(sep) ? "" : sep}${executableName}`;
    if (entryPath === resolve(entryPath) && excludedRoots.some((root) => isWithin(root, entryPath))) continue;
    try {
      lstatSync(entryPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      fail(ERROR_CODES.UNSAFE);
    }
    const snapshot = snapshotCandidate(entryPath, excludedRoots);
    const binding = freezeBinding(entryPath, excludedRoots, exclusions.inputs, snapshot);
    try {
      assertGitCurrent(binding);
      return binding;
    } catch (error) {
      trustedBindings.delete(binding);
      throw error;
    }
  }
  fail(ERROR_CODES.NOT_FOUND);
}

export function assertGitCurrent(binding, excludedRoots = []) {
  if (binding === null || typeof binding !== "object" || !trustedBindings.has(binding)) {
    fail(ERROR_CODES.BINDING_UNTRUSTED);
  }
  if (!Array.isArray(excludedRoots)) fail(ERROR_CODES.INVALID_CONFIGURATION);
  if (binding.platform !== process.platform || binding.uid !== currentUid()) fail(ERROR_CODES.CHANGED);
  const currentExcludedRoots = normalizeExcludedRoots([...binding.excludedRootInputs, ...binding.excludedRoots, ...excludedRoots]);
  const snapshot = snapshotCandidate(binding.entryPath, currentExcludedRoots.roots);
  if (!sameIdentity(binding.entry, snapshot.entry)
    || !sameIdentity(binding.target, snapshot.target)
    || binding.target.sha256 !== snapshot.target.sha256
    || binding.executablePath !== snapshot.target.path
    || binding.canonicalEntryDirectory !== snapshot.canonicalEntryDirectory
    || binding.directories.length !== snapshot.directories.length
    || binding.directories.some((directory, index) => !sameIdentity(directory, snapshot.directories[index]))
    || binding.directoryLinks.length !== snapshot.directoryLinks.length
    || binding.directoryLinks.some((link, index) => !sameIdentity(link, snapshot.directoryLinks[index]))
    || binding.fileLinks.length !== snapshot.fileLinks.length
    || binding.fileLinks.some((link, index) => !sameIdentity(link, snapshot.fileLinks[index]))) {
    fail(ERROR_CODES.CHANGED);
  }
  return binding;
}

function versionEnvironment() {
  const environment = { LANG: "C", LC_ALL: "C" };
  for (const name of ["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return environment;
}

function parseVersionOutput(stdout, stderr) {
  if (stderr.length !== 0 || stdout.length === 0 || stdout.length + stderr.length > OUTPUT_LIMIT_BYTES) {
    fail(ERROR_CODES.VERSION_INVALID);
  }
  const output = stdout.toString("utf8");
  const match = /^git version ([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[0-9A-Za-z]+)*(?: \([0-9A-Za-z][0-9A-Za-z ._+():/-]{0,95}\))?)\r?\n?$/u.exec(output);
  if (!match) fail(ERROR_CODES.VERSION_INVALID);
  return match[1];
}

export function checkGitVersion(binding) {
  assertGitCurrent(binding);
  try {
    const result = spawnSync(binding.executablePath, ["--version"], {
      cwd: process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\") : "/",
      env: versionEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: OUTPUT_LIMIT_BYTES,
      encoding: "buffer",
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") fail(ERROR_CODES.VERSION_TIMEOUT);
      if (result.error.code === "ENOBUFS") fail(ERROR_CODES.VERSION_OUTPUT_LIMIT);
      fail(ERROR_CODES.VERSION_FAILED);
    }
    if (stdout.length + stderr.length > OUTPUT_LIMIT_BYTES) fail(ERROR_CODES.VERSION_OUTPUT_LIMIT);
    if (result.status !== 0 || result.signal !== null) fail(ERROR_CODES.VERSION_FAILED);
    const version = parseVersionOutput(stdout, stderr);
    return Object.freeze({ version, executablePath: binding.executablePath, binding });
  } finally {
    assertGitCurrent(binding);
  }
}

function isCliInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--check") {
      fail(ERROR_CODES.INVALID_CONFIGURATION);
    }
    const result = checkGitVersion(resolveHostGit());
    process.stdout.write(`Git 前置检查通过：${result.version}\n`);
  } catch (error) {
    const message = error instanceof GitPrerequisiteError
      ? error.message
      : `Git 前置检查失败：${REQUIRED_MESSAGE}。`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
