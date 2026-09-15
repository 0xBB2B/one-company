import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkGitVersion, resolveHostGit } from "../runtime/git-prerequisite.mjs";

const runtimeUrl = pathToFileURL(fileURLToPath(new URL("../runtime/git-runtime.mjs", import.meta.url))).href;
const gitReadUrl = pathToFileURL(fileURLToPath(new URL("../runtime/git-read.ts", import.meta.url))).href;
const productRoot = fileURLToPath(new URL("../", import.meta.url));
const roots: string[] = [];

async function temporaryRoot(prefix: string, home = false) {
  const root = await mkdtemp(join(home ? homedir() : tmpdir(), prefix));
  roots.push(root);
  await chmod(root, 0o755);
  return root;
}

async function fakeGit(version: string, name: string) {
  const root = await temporaryRoot(`.pi-company-runtime-${name}-`, true);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o755 });
  const executable = join(bin, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`git version ${version}\n`)})\n`, { mode: 0o755 });
  return { root, bin, executable };
}

function child(source: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source, ...args], {
    cwd: productRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function expectSuccess(result: ReturnType<typeof child>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("宿主 Git 运行时固定绑定", () => {
  test("未初始化拒绝，初始化和重复初始化固定同一路径且不随PATH改选", async () => {
    const first = await fakeGit("9.1.0", "first"), second = await fakeGit("9.2.0", "second");
    const result = child(`
import { currentHostGit, exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
let uninitialized;
try { currentHostGit(); } catch (error) { uninitialized = error.code; }
process.env.PATH = process.argv[1];
const first = initializeHostGit([process.argv[3]]);
const keyBefore = exportGitExpectation().identityKey;
process.env.PATH = process.argv[2];
const repeated = initializeHostGit([process.argv[3] + "/nested"]);
const exported = exportGitExpectation();
process.stdout.write(JSON.stringify({ uninitialized, first: first.executablePath, repeated: repeated.executablePath,
  keyStable: keyBefore === exported.identityKey, frozen: Object.isFrozen(exported) && Object.isFrozen(exported.target) }));
`, [first.bin, second.bin, await temporaryRoot("pi-company-runtime-own-")]);
    expect(expectSuccess(result)).toEqual({
      uninitialized: "git_runtime_uninitialized",
      first: first.executable,
      repeated: first.executable,
      keyStable: true,
      frozen: true,
    });
  });

  test("失败版本不进入缓存，实际绑定变化后锁定invalid且不自动改选", async () => {
    const invalid = await fakeGit("bad output", "invalid");
    await writeFile(invalid.executable, `#!${process.execPath}\nprocess.stdout.write("not-a-version\\n")\n`, { mode: 0o755 });
    const noCache = child(`
import { currentHostGit, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
let first, after;
try { initializeHostGit([]); } catch (error) { first = error.code; }
try { currentHostGit(); } catch (error) { after = error.code; }
process.stdout.write(JSON.stringify({ first, after }));
`, [], { PATH: invalid.bin });
    expect(expectSuccess(noCache)).toEqual({ first: "git_version_invalid", after: "git_runtime_uninitialized" });

    const stable = await fakeGit("9.3.0", "changed"), replacement = await fakeGit("9.4.0", "replacement");
    const changed = child(`
import { readFileSync, writeFileSync } from "node:fs";
import { currentHostGit, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
writeFileSync(process.argv[1], readFileSync(process.argv[2]), { mode: 0o755 });
let changed, locked;
try { currentHostGit(); } catch (error) { changed = error.code; }
try { currentHostGit(); } catch (error) { locked = error.code; }
process.stdout.write(JSON.stringify({ changed, locked }));
`, [stable.executable, replacement.executable], { PATH: stable.bin });
    expect(expectSuccess(changed)).toEqual({ changed: "git_changed", locked: "git_runtime_invalid" });
  });

  test("新增排除根会复验并锁定拒绝", async () => {
    const fake = await fakeGit("9.5.0", "excluded");
    const rejected = child(`
import { currentHostGit, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
let excluded, locked;
try { currentHostGit([process.argv[1]]); } catch (error) { excluded = error.code; }
try { currentHostGit(); } catch (error) { locked = error.code; }
process.stdout.write(JSON.stringify({ excluded, locked }));
`, [fake.root], { PATH: fake.bin });
    expect(expectSuccess(rejected)).toEqual({ excluded: "git_unsafe", locked: "git_runtime_invalid" });

    const project = await temporaryRoot("pi-company-runtime-project-");
    const projectBin = join(project, "node_modules", ".bin");
    await mkdir(projectBin, { recursive: true, mode: 0o755 });
    await writeFile(join(projectBin, process.platform === "win32" ? "git.exe" : "git"),
      await readFile(fake.executable), { mode: 0o755 });
    const unsafePath = child(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
let code;
try { initializeHostGit([process.argv[1]]); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code }));
`, [project], { PATH: projectBin });
    expect(expectSuccess(unsafePath)).toEqual({ code: "git_not_found" });
  });

  test("原始别名来源不会因父子文本关系丢失，export与child继续继承", async () => {
    const fake = await fakeGit("9.5.1", "alias-retained");
    const business = await temporaryRoot("pi-company-runtime-business-");
    const safe = await temporaryRoot("pi-company-runtime-safe-");
    const alias = join(business, "alias");
    await symlink(safe, alias);
    const parent = child(`
import { unlinkSync, symlinkSync } from "node:fs";
import { currentHostGit, exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([process.argv[1]]);
currentHostGit([process.argv[2]]);
const expectation = exportGitExpectation();
unlinkSync(process.argv[2]);
symlinkSync(process.argv[3], process.argv[2], "dir");
let current, locked;
try { currentHostGit(); } catch (error) { current = error.code; }
try { currentHostGit(); } catch (error) { locked = error.code; }
process.stdout.write(JSON.stringify({ retained: expectation.excludedRootInputs.includes(process.argv[2]), current, locked, expectation }));
`, [business, alias, fake.bin], { PATH: fake.bin });
    const parentResult = expectSuccess(parent) as { retained: boolean; current: string; locked: string; expectation: unknown };
    expect({ retained: parentResult.retained, current: parentResult.current, locked: parentResult.locked }).toEqual({
      retained: true,
      current: "git_unsafe",
      locked: "git_runtime_invalid",
    });

    const inherited = child(`
import { initializeInheritedGit } from ${JSON.stringify(runtimeUrl)};
let code;
try { initializeInheritedGit(JSON.parse(process.env.GIT_EXPECTATION), []); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code }));
`, [], { PATH: join(safe, "empty"), GIT_EXPECTATION: JSON.stringify(parentResult.expectation) });
    expect(expectSuccess(inherited).code).toBe("git_not_found");
  });

  test("排除根严格字符串去重，实际union在256成功、257拒绝且不改state或换Git", async () => {
    const first = await fakeGit("9.5.2", "root-boundary-first");
    const second = await fakeGit("9.5.3", "root-boundary-second");
    const base = await temporaryRoot("pi-company-runtime-root-boundary-");
    const bounded = child(`
import { currentHostGit, exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
const binding = initializeHostGit([process.argv[1]]);
const initial = exportGitExpectation();
const occupied = new Set([...initial.excludedRootInputs, ...initial.excludedRoots]).size;
const additions = Array.from({ length: 256 - occupied }, (_, index) => process.argv[1] + "/root-" + index);
currentHostGit(additions);
currentHostGit([additions[0]]);
const full = exportGitExpectation();
process.env.PATH = process.argv[2];
let overflow;
try { currentHostGit([process.argv[1] + "/overflow"]); } catch (error) { overflow = error.code; }
const after = currentHostGit();
const final = exportGitExpectation();
process.stdout.write(JSON.stringify({
  fullCount: new Set([...full.excludedRootInputs, ...full.excludedRoots]).size,
  overflow,
  unchanged: JSON.stringify(full.excludedRootInputs) === JSON.stringify(final.excludedRootInputs),
  sameGit: binding.executablePath === after.executablePath,
}));
`, [base, second.bin], { PATH: first.bin });
    expect(expectSuccess(bounded)).toEqual({
      fullCount: 256,
      overflow: "git_expectation_invalid",
      unchanged: true,
      sameGit: true,
    });
  });

  test("重复initialize在版本检查后对既有追加根和本次新增根分别复验", async () => {
    const scenario = async (changedRoot: "old" | "new") => {
      const fake = await fakeGit("9.5.4", `repeat-version-${changedRoot}`);
      const aliases = await temporaryRoot(`pi-company-runtime-version-aliases-${changedRoot}-`);
      const safeOld = await temporaryRoot(`pi-company-runtime-version-old-${changedRoot}-`);
      const safeNew = await temporaryRoot(`pi-company-runtime-version-new-${changedRoot}-`);
      const oldAlias = join(aliases, "old"), newAlias = join(aliases, "new");
      await symlink(safeOld, oldAlias);
      await symlink(safeNew, newAlias);
      const counter = join(fake.root, "version-count");
      const changedAlias = changedRoot === "old" ? oldAlias : newAlias;
      await writeFile(fake.executable, `#!${process.execPath}
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(count));
if (count === 2) {
  unlinkSync(${JSON.stringify(changedAlias)});
  symlinkSync(${JSON.stringify(fake.bin)}, ${JSON.stringify(changedAlias)}, "dir");
}
process.stdout.write("git version 9.5.4\\n");
`, { mode: 0o755 });
      const changed = child(`
import { currentHostGit, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
currentHostGit([process.argv[1]]);
let repeat, next;
try { initializeHostGit([process.argv[2]]); } catch (error) { repeat = error.code; }
try { currentHostGit(); } catch (error) { next = error.code; }
process.stdout.write(JSON.stringify({ repeat, next }));
`, [oldAlias, newAlias], { PATH: fake.bin });
      return expectSuccess(changed);
    };
    expect(await scenario("old")).toEqual({ repeat: "git_unsafe", next: "git_runtime_invalid" });
    expect(await scenario("new")).toEqual({ repeat: "git_unsafe", next: "git_runtime_invalid" });
  });

  test("重复initialize的版本失败仍执行完整roots后验并保持真实失败", async () => {
    const fake = await fakeGit("9.5.5", "repeat-version-failure");
    const counter = join(fake.root, "version-count");
    await writeFile(fake.executable, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(count));
process.stdout.write(count === 2 ? "not-a-version\\n" : "git version 9.5.5\\n");
`, { mode: 0o755 });
    const result = child(`
import { currentHostGit, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
let repeat, next;
try { initializeHostGit([]); } catch (error) { repeat = error.code; }
try { currentHostGit(); } catch (error) { next = error.code; }
process.stdout.write(JSON.stringify({ repeat, next }));
`, [], { PATH: fake.bin });
    expect(expectSuccess(result)).toEqual({ repeat: "git_version_invalid", next: "git_runtime_invalid" });
  });
});

describe("GitExpectation 与继承重建", () => {
  test("干净PATH子进程独立重建同一Git，不依赖序列化WeakSet", async () => {
    const ownRoot = await temporaryRoot("pi-company-runtime-child-");
    const parent = child(`
import { exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([process.argv[1]]);
process.stdout.write(JSON.stringify(exportGitExpectation()));
`, [ownRoot]);
    expect(parent.status, parent.stderr).toBe(0);
    const expected = JSON.parse(parent.stdout) as { executablePath: string; identityKey: string };
    const inherited = child(`
import { initializeInheritedGit } from ${JSON.stringify(runtimeUrl)};
const expected = JSON.parse(process.env.GIT_EXPECTATION);
const binding = initializeInheritedGit(expected, [process.argv[1]]);
process.stdout.write(JSON.stringify({ executablePath: binding.executablePath, key: expected.identityKey }));
`, [ownRoot], { PATH: join(ownRoot, "empty"), GIT_EXPECTATION: parent.stdout });
    expect(expectSuccess(inherited)).toEqual({ executablePath: expected.executablePath, key: expected.identityKey });
  });

  test("parser按固定数据描述符读取，不执行getter/toJSON或遍历未知深值", async () => {
    const parent = child(`
import { exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
process.stdout.write(JSON.stringify(exportGitExpectation()));
`);
    expect(parent.status, parent.stderr).toBe(0);
    const probes = child(`
import { parseGitExpectation } from ${JSON.stringify(runtimeUrl)};
const original = JSON.parse(process.env.GIT_EXPECTATION);
const results = {};
function probe(name, value, calls = () => 0) {
  try { parseGitExpectation(value); results[name] = "accepted"; }
  catch (error) { results[name] = error.code; }
  results[name + "Calls"] = calls();
}
let unknownCalls = 0;
const unknownGetter = { ...original };
Object.defineProperty(unknownGetter, "unknown", { enumerable: true, get() { unknownCalls += 1; return true; } });
probe("unknownGetter", unknownGetter, () => unknownCalls);
let toJSONCalls = 0;
const toJSON = { ...original };
Object.defineProperty(toJSON, "toJSON", { enumerable: false, value() { toJSONCalls += 1; return {}; } });
probe("toJSON", toJSON, () => toJSONCalls);
let pathCalls = 0;
const knownAccessor = { ...original, entry: { ...original.entry } };
Object.defineProperty(knownAccessor.entry, "path", { enumerable: true, get() { pathCalls += 1; return original.entry.path; } });
probe("knownAccessor", knownAccessor, () => pathCalls);
let arrayCalls = 0;
const arrayGetter = { ...original, directories: [...original.directories] };
Object.defineProperty(arrayGetter.directories, "0", { enumerable: true, get() { arrayCalls += 1; return original.directories[0]; } });
probe("arrayGetter", arrayGetter, () => arrayCalls);
const arrayExtra = { ...original, directories: [...original.directories] };
arrayExtra.directories.extra = true;
probe("arrayExtra", arrayExtra);
const arraySparse = { ...original, directories: [...original.directories] };
delete arraySparse.directories[0];
probe("arraySparse", arraySparse);
const manyUnknown = { ...original };
for (let index = 0; index < 1000; index++) manyUnknown["unknown" + index] = index;
probe("manyUnknown", manyUnknown);
let deep = null;
for (let index = 0; index < 5000; index++) deep = { child: deep };
probe("deepUnknown", { ...original, unknown: deep });
const cyclic = { ...original };
cyclic.entry = cyclic;
probe("cycle", cyclic);
probe("prototype", Object.assign(Object.create({ inherited: true }), original));
probe("symbol", Object.assign({ ...original }, { [Symbol("unknown")]: true }));
probe("function", { ...original, platform() {} });
const longDecimal = { ...original, entry: { ...original.entry, dev: "1".repeat(129) } };
const fixed = (value) => ({ entryPath: value.entryPath, executablePath: value.executablePath, platform: value.platform,
  uid: value.uid, entry: value.entry, target: value.target, canonicalEntryDirectory: value.canonicalEntryDirectory,
  directories: value.directories, directoryLinks: value.directoryLinks, fileLinks: value.fileLinks });
const { createHash } = await import("node:crypto");
longDecimal.identityKey = createHash("sha256").update(JSON.stringify(fixed(longDecimal))).digest("hex");
probe("longDecimal", longDecimal);
process.stdout.write(JSON.stringify(results));
`, [], { GIT_EXPECTATION: parent.stdout });
    const result = expectSuccess(probes);
    for (const name of ["unknownGetter", "toJSON", "knownAccessor", "arrayGetter", "arrayExtra", "arraySparse",
      "manyUnknown", "deepUnknown", "cycle", "prototype", "symbol", "function", "longDecimal"]) {
      expect(result[name]).toBe("git_expectation_invalid");
    }
    expect(result.unknownGetterCalls).toBe(0);
    expect(result.toJSONCalls).toBe(0);
    expect(result.knownAccessorCalls).toBe(0);
    expect(result.arrayGetterCalls).toBe(0);
  });

  test("JSON.parse后的净数据在65536字节通过、65537字节拒绝", async () => {
    const parent = child(`
import { exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
process.stdout.write(JSON.stringify(exportGitExpectation()));
`);
    expect(parent.status, parent.stderr).toBe(0);
    const boundary = child(`
import { createHash } from "node:crypto";
import { parseGitExpectation } from ${JSON.stringify(runtimeUrl)};
const original = JSON.parse(process.env.GIT_EXPECTATION);
const fixed = (value) => ({ entryPath: value.entryPath, executablePath: value.executablePath, platform: value.platform,
  uid: value.uid, entry: value.entry, target: value.target, canonicalEntryDirectory: value.canonicalEntryDirectory,
  directories: value.directories, directoryLinks: value.directoryLinks, fileLinks: value.fileLinks });
function rekey(value) {
  value.identityKey = createHash("sha256").update(JSON.stringify(fixed(value))).digest("hex");
  return value;
}
const size = (value) => Buffer.byteLength(JSON.stringify(rekey(value)), "utf8");
const record = { path: "/", type: "directory", dev: original.target.dev, ino: original.target.ino,
  uid: original.target.uid, gid: original.target.gid, mode: original.target.mode };
const exact = { ...original, directories: [], directoryLinks: [], fileLinks: [] };
const maxPath = "/" + "a".repeat(4095);
while (true) {
  const trial = { ...record, path: maxPath };
  exact.directories.push(trial);
  if (size(exact) <= 65536) continue;
  exact.directories.pop();
  break;
}
let remaining = 65536 - size(exact);
if (remaining > 0) {
  exact.directories.push({ ...record });
  const minimumDelta = size(exact) - (65536 - remaining);
  if (remaining < minimumDelta) {
    const previous = exact.directories.at(-2);
    previous.path = previous.path.slice(0, -(minimumDelta - remaining));
  } else {
    exact.directories.at(-1).path += "a".repeat(remaining - minimumDelta);
  }
}
rekey(exact);
const encoded = JSON.stringify(exact);
const direct = parseGitExpectation(exact);
const decoded = JSON.parse(encoded);
const parsed = parseGitExpectation(decoded);
const over = JSON.parse(encoded);
over.directories.at(-1).path += "b";
rekey(over);
let overCode;
try { parseGitExpectation(over); } catch (error) { overCode = error.code; }
process.stdout.write(JSON.stringify({ exactBytes: Buffer.byteLength(encoded), directFrozen: Object.isFrozen(direct),
  parsedFrozen: Object.isFrozen(parsed), overBytes: Buffer.byteLength(JSON.stringify(over)), overCode }));
`, [], { GIT_EXPECTATION: parent.stdout });
    expect(expectSuccess(boundary)).toEqual({
      exactBytes: 65536,
      directFrozen: true,
      parsedFrozen: true,
      overBytes: 65537,
      overCode: "git_expectation_invalid",
    });
  });

  test("未知字段、错hash、错类型、超限和链接重建都拒绝", async () => {
    const aliasTarget = await fakeGit("9.6.0", "inherit-target");
    const aliasRoot = await temporaryRoot(".pi-company-runtime-alias-", true);
    const aliasBin = `${aliasRoot}//alias-bin`;
    await symlink(aliasTarget.bin, join(aliasRoot, "alias-bin"));
    const parent = child(`
import { exportGitExpectation, initializeHostGit } from ${JSON.stringify(runtimeUrl)};
initializeHostGit([]);
process.stdout.write(JSON.stringify(exportGitExpectation()));
`, [], { PATH: aliasBin });
    expect(parent.status, parent.stderr).toBe(0);
    const expectation = JSON.parse(parent.stdout) as Record<string, unknown>;

    const invalid = child(`
import { initializeInheritedGit } from ${JSON.stringify(runtimeUrl)};
const original = JSON.parse(process.env.GIT_EXPECTATION);
const attempts = [
  { ...original, unknown: true },
  { ...original, identityKey: "0".repeat(64) },
  { ...original, target: { ...original.target, ctimeNs: 1 } },
  { ...original, entryPath: "/" + "a".repeat(4096) },
  { ...original, excludedRoots: Array.from({ length: 257 }, (_, i) => "/tmp/root-" + i) },
  { ...original, directories: Array.from({ length: 129 }, () => original.directories[0]) },
];
const codes = [];
for (const value of attempts) { try { initializeInheritedGit(value, []); codes.push("accepted"); } catch (error) { codes.push(error.code); } }
process.stdout.write(JSON.stringify(codes));
`, [], { PATH: join(aliasRoot, "empty"), GIT_EXPECTATION: parent.stdout });
    expect(expectSuccess(invalid)).toEqual([
      "git_expectation_invalid", "git_expectation_invalid", "git_expectation_invalid",
      "git_expectation_invalid", "git_expectation_invalid", "git_expectation_invalid",
    ]);

    await rm(join(aliasRoot, "alias-bin"));
    await symlink(aliasTarget.bin, join(aliasRoot, "alias-bin"));
    const changed = child(`
import { initializeInheritedGit } from ${JSON.stringify(runtimeUrl)};
let code;
try { initializeInheritedGit(JSON.parse(process.env.GIT_EXPECTATION), []); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code }));
`, [], { PATH: join(aliasRoot, "empty"), GIT_EXPECTATION: JSON.stringify(expectation) });
    expect(expectSuccess(changed).code).toBe("git_expectation_mismatch");
  });
});

test.skipIf(process.platform !== "darwin")("真实宿主Git通过同一路径执行只读sandbox命令", async () => {
  const repository = await temporaryRoot("pi-company-runtime-read-");
  const binding = resolveHostGit();
  const checked = checkGitVersion(binding);
  const initialized = spawnSync(binding.executablePath, ["init", "-b", "main"], { cwd: repository, encoding: "utf8" });
  expect(initialized.status, initialized.stderr).toBe(0);
  const result = child(`
import { initializeHostGit } from ${JSON.stringify(runtimeUrl)};
import { gitExecutable, readGit } from ${JSON.stringify(gitReadUrl)};
initializeHostGit([process.argv[1]]);
const executable = await gitExecutable();
const read = await readGit(process.argv[1], ["rev-parse", "--show-toplevel"]);
process.stdout.write(JSON.stringify({ executable, root: read.stdout.trim() }));
`, [repository]);
  expect(expectSuccess(result)).toEqual({ executable: checked.executablePath, root: repository });
  expect(await readFile(join(repository, ".git", "config"), "utf8")).not.toContain("xcrun");
});
