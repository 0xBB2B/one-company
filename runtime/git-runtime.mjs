import { createHash } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import {
  GitPrerequisiteError,
  assertGitCurrent,
  checkGitVersion,
  resolveHostGit,
} from "./git-prerequisite.mjs";

const MAX_EXPECTATION_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_DECIMAL_BYTES = 128;
const MAX_ROOTS = 256;
const MAX_IDENTITY_RECORDS = 128;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]);

const ERROR_CODES = Object.freeze({
  UNINITIALIZED: "git_runtime_uninitialized",
  INVALID: "git_runtime_invalid",
  INVALID_EXPECTATION: "git_expectation_invalid",
  EXPECTATION_MISMATCH: "git_expectation_mismatch",
});

export class GitRuntimeError extends Error {
  constructor(code) {
    super(`Git 运行时绑定失败（${code}）：必须重启并从可信宿主 PATH 重新启用。`);
    this.name = "GitRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new GitRuntimeError(code);
}

let state = { kind: "uninitialized" };

function inspectPrototype(value, expected) {
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
  if (!expected.includes(prototype)) fail(ERROR_CODES.INVALID_EXPECTATION);
}

function arrayKind(value) {
  try { return Array.isArray(value); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
}

function dataObject(value, allowedKeys, seen) {
  if (value === null || typeof value !== "object" || arrayKind(value)) fail(ERROR_CODES.INVALID_EXPECTATION);
  inspectPrototype(value, [Object.prototype, null]);
  if (seen.has(value)) fail(ERROR_CODES.INVALID_EXPECTATION);
  seen.add(value);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
  if (keys.length > allowedKeys.length) fail(ERROR_CODES.INVALID_EXPECTATION);
  const allowed = new Set(allowedKeys);
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) fail(ERROR_CODES.INVALID_EXPECTATION);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(ERROR_CODES.INVALID_EXPECTATION);
    result[key] = descriptor.value;
  }
  return result;
}

function exactData(data, keys) {
  const actual = Object.keys(data).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(ERROR_CODES.INVALID_EXPECTATION);
  }
}

function dataArray(value, maximum, seen) {
  if (!arrayKind(value)) fail(ERROR_CODES.INVALID_EXPECTATION);
  inspectPrototype(value, [Array.prototype]);
  if (seen.has(value)) fail(ERROR_CODES.INVALID_EXPECTATION);
  seen.add(value);
  let lengthDescriptor;
  try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length"); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(length)
    || length < 0 || length > maximum) fail(ERROR_CODES.INVALID_EXPECTATION);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
  if (keys.length !== length + 1 || !keys.includes("length")) fail(ERROR_CODES.INVALID_EXPECTATION);
  const result = [];
  for (let index = 0; index < length; index++) {
    const key = String(index);
    if (!keys.includes(key)) fail(ERROR_CODES.INVALID_EXPECTATION);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(ERROR_CODES.INVALID_EXPECTATION);
    result.push(descriptor.value);
  }
  return result;
}

function pathValue(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    fail(ERROR_CODES.INVALID_EXPECTATION);
  }
  return value;
}

function safeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(ERROR_CODES.INVALID_EXPECTATION);
  return value;
}

function decimal(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_DECIMAL_BYTES || !DECIMAL.test(value)) {
    fail(ERROR_CODES.INVALID_EXPECTATION);
  }
  return value;
}

function parseIdentity(value, expectedType, target, seen) {
  const required = ["path", "type", "dev", "ino", "uid", "gid", "mode"];
  const keys = [...required, ...(expectedType === "directory" ? [] : ["ctimeNs"]), ...(target ? ["sha256"] : [])];
  const data = dataObject(value, [...required, "ctimeNs", "sha256"], seen);
  exactData(data, keys);
  if (data.type !== expectedType) fail(ERROR_CODES.INVALID_EXPECTATION);
  return {
    path: pathValue(data.path),
    type: expectedType,
    dev: decimal(data.dev),
    ino: decimal(data.ino),
    uid: safeInteger(data.uid, 0x7fffffff),
    gid: safeInteger(data.gid, 0x7fffffff),
    mode: safeInteger(data.mode, 0o7777),
    ...(expectedType === "directory" ? {} : { ctimeNs: decimal(data.ctimeNs) }),
    ...(target ? (typeof data.sha256 === "string" && SHA256.test(data.sha256)
      ? { sha256: data.sha256 }
      : fail(ERROR_CODES.INVALID_EXPECTATION)) : {}),
  };
}

function parseEntry(value, seen) {
  let typeDescriptor;
  try {
    typeDescriptor = value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "type")
      : undefined;
  } catch {
    fail(ERROR_CODES.INVALID_EXPECTATION);
  }
  const type = typeDescriptor && "value" in typeDescriptor ? typeDescriptor.value : undefined;
  if (type !== "file" && type !== "symlink") fail(ERROR_CODES.INVALID_EXPECTATION);
  return parseIdentity(value, type, false, seen);
}

function parseIdentityList(value, type, seen) {
  return dataArray(value, MAX_IDENTITY_RECORDS, seen).map((item) => parseIdentity(item, type, false, seen));
}

function parseRoots(value, seen) {
  return dataArray(value, MAX_ROOTS, seen).map(pathValue);
}

function fixedIdentity(expectation) {
  return {
    entryPath: expectation.entryPath,
    executablePath: expectation.executablePath,
    platform: expectation.platform,
    uid: expectation.uid,
    entry: expectation.entry,
    target: expectation.target,
    canonicalEntryDirectory: expectation.canonicalEntryDirectory,
    directories: expectation.directories,
    directoryLinks: expectation.directoryLinks,
    fileLinks: expectation.fileLinks,
  };
}

function identityKey(expectation) {
  return createHash("sha256").update(JSON.stringify(fixedIdentity(expectation))).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseGitExpectation(value) {
  const fields = [
    "schemaVersion", "identityKey", "entryPath", "executablePath", "platform", "uid",
    "excludedRootInputs", "excludedRoots", "entry", "target", "canonicalEntryDirectory",
    "directories", "directoryLinks", "fileLinks",
  ];
  const seen = new WeakSet();
  const data = dataObject(value, fields, seen);
  exactData(data, fields);
  if (data.schemaVersion !== 1 || typeof data.platform !== "string" || !PLATFORMS.has(data.platform)) {
    fail(ERROR_CODES.INVALID_EXPECTATION);
  }
  const parsed = {
    schemaVersion: 1,
    identityKey: typeof data.identityKey === "string" && SHA256.test(data.identityKey)
      ? data.identityKey
      : fail(ERROR_CODES.INVALID_EXPECTATION),
    entryPath: pathValue(data.entryPath),
    executablePath: pathValue(data.executablePath),
    platform: data.platform,
    uid: safeInteger(data.uid, 0x7fffffff),
    excludedRootInputs: parseRoots(data.excludedRootInputs, seen),
    excludedRoots: parseRoots(data.excludedRoots, seen),
    entry: parseEntry(data.entry, seen),
    target: parseIdentity(data.target, "file", true, seen),
    canonicalEntryDirectory: pathValue(data.canonicalEntryDirectory),
    directories: parseIdentityList(data.directories, "directory", seen),
    directoryLinks: parseIdentityList(data.directoryLinks, "symlink", seen),
    fileLinks: parseIdentityList(data.fileLinks, "symlink", seen),
  };
  let encoded;
  try { encoded = JSON.stringify(parsed); } catch { fail(ERROR_CODES.INVALID_EXPECTATION); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_EXPECTATION_BYTES
    || new Set([...parsed.excludedRootInputs, ...parsed.excludedRoots]).size > MAX_ROOTS
    || parsed.directories.length + parsed.directoryLinks.length + parsed.fileLinks.length > MAX_IDENTITY_RECORDS
    || identityKey(parsed) !== parsed.identityKey) fail(ERROR_CODES.INVALID_EXPECTATION);
  return deepFreeze(parsed);
}

function validateRoots(roots) {
  if (!arrayKind(roots) || roots.length > MAX_ROOTS) fail(ERROR_CODES.INVALID_EXPECTATION);
  return roots.map(pathValue);
}

function retainedRoots(existing, additions) {
  const retained = [...existing];
  for (const root of additions) {
    if (retained.includes(root)) continue;
    if (retained.length >= MAX_ROOTS) fail(ERROR_CODES.INVALID_EXPECTATION);
    retained.push(root);
  }
  return retained;
}

function assertRootBudget(binding, rawRoots) {
  retainedRoots(retainedRoots([], binding.excludedRootInputs), [...binding.excludedRoots, ...rawRoots]);
}

function initialRoots(binding) {
  const roots = retainedRoots([], binding.excludedRootInputs);
  assertRootBudget(binding, roots);
  return roots;
}

function invalidate(error) {
  if (!(error instanceof GitPrerequisiteError) || error.code !== "git_invalid_configuration") {
    state = { kind: "invalid" };
  }
  throw error;
}

function assertReady(additionalRoots, includeVersionCheck) {
  if (state.kind === "uninitialized") fail(ERROR_CODES.UNINITIALIZED);
  if (state.kind === "invalid") fail(ERROR_CODES.INVALID);
  const additions = validateRoots(additionalRoots);
  const proposed = retainedRoots(state.roots, additions);
  assertRootBudget(state.binding, proposed);
  try {
    assertGitCurrent(state.binding, proposed);
    if (includeVersionCheck) {
      try {
        checkGitVersion(state.binding);
      } finally {
        assertGitCurrent(state.binding, proposed);
      }
    }
  } catch (error) {
    invalidate(error);
  }
  state = { ...state, roots: proposed };
  return state.binding;
}

export function initializeHostGit(excludedRoots) {
  if (state.kind === "invalid") fail(ERROR_CODES.INVALID);
  const roots = validateRoots(excludedRoots);
  if (state.kind === "ready") return assertReady(roots, true);
  const binding = resolveHostGit({ excludedRoots: roots });
  checkGitVersion(binding);
  state = { kind: "ready", binding, roots: initialRoots(binding) };
  return binding;
}

export function currentHostGit(excludedRoots = []) {
  return assertReady(excludedRoots, false);
}

function expectationFromState() {
  const binding = state.binding;
  const excludedRootInputs = [...new Set([...binding.excludedRootInputs, ...state.roots])];
  const excludedRoots = [...binding.excludedRoots];
  if (new Set([...excludedRootInputs, ...excludedRoots]).size > MAX_ROOTS) fail(ERROR_CODES.INVALID_EXPECTATION);
  const expectation = {
    schemaVersion: 1,
    identityKey: "",
    entryPath: binding.entryPath,
    executablePath: binding.executablePath,
    platform: binding.platform,
    uid: binding.uid,
    excludedRootInputs,
    excludedRoots,
    entry: { ...binding.entry },
    target: { ...binding.target },
    canonicalEntryDirectory: binding.canonicalEntryDirectory,
    directories: binding.directories.map((item) => ({ ...item })),
    directoryLinks: binding.directoryLinks.map((item) => ({ ...item })),
    fileLinks: binding.fileLinks.map((item) => ({ ...item })),
  };
  expectation.identityKey = identityKey(expectation);
  return parseGitExpectation(expectation);
}

export function exportGitExpectation(excludedRoots = []) {
  assertReady(excludedRoots, false);
  return expectationFromState();
}

function sameIdentity(left, right) {
  return left.path === right.path && left.type === right.type && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.ctimeNs === right.ctimeNs;
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => sameIdentity(item, right[index]));
}

function matchesExpectation(binding, expected) {
  return binding.entryPath === expected.entryPath
    && binding.executablePath === expected.executablePath
    && binding.platform === expected.platform
    && binding.uid === expected.uid
    && binding.canonicalEntryDirectory === expected.canonicalEntryDirectory
    && sameIdentity(binding.entry, expected.entry)
    && sameIdentity(binding.target, expected.target)
    && binding.target.sha256 === expected.target.sha256
    && sameList(binding.directories, expected.directories)
    && sameList(binding.directoryLinks, expected.directoryLinks)
    && sameList(binding.fileLinks, expected.fileLinks);
}

function entryDirectory(entryPath) {
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  const suffix = `${sep}${executableName}`;
  if (!entryPath.endsWith(suffix)) fail(ERROR_CODES.INVALID_EXPECTATION);
  return entryPath.slice(0, -executableName.length);
}

export function initializeInheritedGit(expectedValue, ownRoots) {
  if (state.kind === "invalid") fail(ERROR_CODES.INVALID);
  if (state.kind === "ready") fail(ERROR_CODES.INVALID);
  const expected = parseGitExpectation(expectedValue);
  const roots = validateRoots(ownRoots);
  if (expected.platform !== process.platform) fail(ERROR_CODES.EXPECTATION_MISMATCH);
  const exclusions = [...new Set([...expected.excludedRootInputs, ...expected.excludedRoots, ...roots])];
  if (exclusions.length > MAX_ROOTS) fail(ERROR_CODES.INVALID_EXPECTATION);
  const binding = resolveHostGit({ path: entryDirectory(expected.entryPath), excludedRoots: exclusions });
  if (!matchesExpectation(binding, expected)) fail(ERROR_CODES.EXPECTATION_MISMATCH);
  checkGitVersion(binding);
  state = { kind: "ready", binding, roots: initialRoots(binding) };
  return binding;
}
