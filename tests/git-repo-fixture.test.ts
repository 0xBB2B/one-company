import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  cleanupGitDaemonFixtures,
  ownedTempRoot,
  runJsonChild,
  withGitDaemonFixtures,
} from "./helpers/git-daemon-fixture.ts";
import { initializeTestHostGit } from "./helpers/test-git-binding.ts";

const productRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureUrl = pathToFileURL(fileURLToPath(new URL("./helpers/repo-fixture.ts", import.meta.url))).href;
const runtimeUrl = pathToFileURL(fileURLToPath(new URL("../runtime/git-runtime.mjs", import.meta.url))).href;
const realGit = initializeTestHostGit([]).executablePath;

const loadFixtureSource = `
const loadedFixture = await import(fixtureUrl);
const fixture = loadedFixture.createRepoFixture ? loadedFixture : loadedFixture.default;
`;
const errorCodesSource = `
function errorCodes(error) {
  if (!error || typeof error !== "object") return [];
  return [...("code" in error ? [error.code] : []), ...(Array.isArray(error.errors) ? error.errors.flatMap(errorCodes) : [])];
}
`;

afterEach(() => cleanupGitDaemonFixtures());

describe("repo fixture 的宿主 Git 绑定", () => {
  test("导入模块不初始化Git，也不执行Git或分配仓库根", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-import-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let calls = 0;
childProcess.execFile = () => { calls += 1; throw new Error("unexpected execFile"); };
childProcess.spawnSync = () => { calls += 1; throw new Error("unexpected spawnSync"); };
syncBuiltinESMExports();
const before = readdirSync(process.env.TMPDIR).sort();
await import(${JSON.stringify(fixtureUrl)});
const after = readdirSync(process.env.TMPDIR).sort();
process.stdout.write(JSON.stringify({ calls, unchanged: JSON.stringify(before) === JSON.stringify(after) }));
`, [], { env: { PATH: "", TMPDIR: scopeRoot } });
    expect(result).toEqual({ calls: 0, unchanged: true });
  }));

  test("缺Git时入口在任何repo分配和exec前拒绝", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-missing-scope-");
    const result = await runJsonChild(productRoot, `
import { readdirSync } from "node:fs";
const fixtureUrl = ${JSON.stringify(fixtureUrl)};
${loadFixtureSource}
const prefixes = ["pi-company-repo-", "pi-company-workspace-", "pi-company-worktree-"];
const allocated = () => readdirSync(process.env.TMPDIR).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
const before = allocated(), failures = [];
for (const run of [
  () => fixture.createRepoFixture(),
  () => fixture.createWorkspaceFixture(),
  () => fixture.addWorktree({ root: process.env.TMPDIR, worktrees: [] }),
]) {
  try { await run(); } catch (error) { failures.push({ code: error.code, message: error.message }); }
}
process.stdout.write(JSON.stringify({ failures, before, after: allocated() }));
`, [], { env: { PATH: "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      failures: [{ code: "git_not_found" }, { code: "git_not_found" }, { code: "git_not_found" }],
      before: [],
      after: [],
    });
    expect((result.failures as Array<{ message: string }>).every((failure) => failure.message.includes("必须预先安装Git"))).toBe(true);
  }));

  test.each(["empty", "decoy"] as const)("绑定后PATH=%s仍以绝对路径完成repo和worktree", async (pathMode) => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot(`repo-fixture-${pathMode}-scope-`);
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl, mode] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
const binding = initializeHostGit([]);
const decoyBin = join(process.env.TMPDIR, "decoy-bin");
mkdirSync(decoyBin, { mode: 0o700 });
writeFileSync(join(decoyBin, "git"), ${JSON.stringify(`#!${process.execPath}\nprocess.exit(91);\n`)}, { mode: 0o755 });
process.env.PATH = mode === "empty" ? "" : decoyBin;
process.env.GIT_DIR = "/forbidden/user/repo/.git";
process.env.GIT_WORK_TREE = "/forbidden/user/repo";
process.env.GIT_INDEX_FILE = "/forbidden/user/repo/index";
process.env.GIT_CONFIG_COUNT = "9";
const nativeExecFile = childProcess.execFile;
const fakeGitCalls = [];
// 受控接缝只记录调用；nativeExecFile仍在父scope的TMPDIR内执行宿主已绑定的真实Git。
childProcess.execFile = (executable, args, options, callback) => {
  fakeGitCalls.push({ executable, args: [...args], cwd: options.cwd, env: {
    PATH: options.env.PATH ?? null, HOME: options.env.HOME ?? null, GIT_DIR: options.env.GIT_DIR ?? null,
    GIT_WORK_TREE: options.env.GIT_WORK_TREE ?? null, GIT_INDEX_FILE: options.env.GIT_INDEX_FILE ?? null,
    GIT_CONFIG_COUNT: options.env.GIT_CONFIG_COUNT ?? null, GIT_CONFIG_GLOBAL: options.env.GIT_CONFIG_GLOBAL ?? null,
    GIT_CONFIG_SYSTEM: options.env.GIT_CONFIG_SYSTEM ?? null, GIT_CONFIG_NOSYSTEM: options.env.GIT_CONFIG_NOSYSTEM ?? null,
    GIT_TERMINAL_PROMPT: options.env.GIT_TERMINAL_PROMPT ?? null,
  } });
  return nativeExecFile(executable, args, options, callback);
};
syncBuiltinESMExports();
${loadFixtureSource}
const repo = await fixture.createRepoFixture();
const worktree = await fixture.addWorktree(repo);
const workspace = await fixture.createWorkspaceFixture();
const created = existsSync(join(repo.root, ".git")) && existsSync(join(worktree.root, ".git"))
  && workspace.repos.every((root) => existsSync(join(root, ".git")));
await fixture.removeRepoFixture(repo);
await fixture.removeRepoFixture(workspace);
process.stdout.write(JSON.stringify({ binding: binding.executablePath, created, fakeGitCalls }));
`, [runtimeUrl, fixtureUrl, pathMode], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({ binding: realGit, created: true });
    const calls = result.fakeGitCalls as Array<{ executable: string; args: string[]; cwd: string; env: Record<string, string | null> }>;
    expect(calls).toHaveLength(10);
    expect(calls.every((call) => call.executable === realGit)).toBe(true);
    expect(calls.every((call) => call.cwd.startsWith(scopeRoot))).toBe(true);
    expect(calls.every((call) => call.args.includes("maintenance.auto=false") && call.args.includes("gc.auto=0")
      && call.args.includes("core.hooksPath=/dev/null"))).toBe(true);
    for (const call of calls) {
      expect(call.env).toMatchObject({
        GIT_DIR: null,
        GIT_WORK_TREE: null,
        GIT_INDEX_FILE: null,
        GIT_CONFIG_COUNT: null,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      });
    }
  }));

  test("命令等待期间固定绑定变化后拒绝交付结果并保全精确自有根", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-mutated-scope-");
    const result = await runJsonChild(productRoot, `${errorCodesSource}
import childProcess from "node:child_process";
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [runtimeUrl, fixtureUrl] = process.argv.slice(1);
const nativeLstat = fs.lstatSync;
let changed = false, target = "";
// 只在真实Git命令回调后模拟绑定身份变化，不修改宿主Git文件本身。
fs.lstatSync = (path, options) => {
  const value = nativeLstat(path, options);
  if (!changed || String(path) !== target) return value;
  return new Proxy(value, { get(item, key) {
    if (key === "ctimeNs") return item.ctimeNs + 1n;
    const result = Reflect.get(item, key, item);
    return typeof result === "function" ? result.bind(item) : result;
  } });
};
syncBuiltinESMExports();
const { initializeHostGit } = await import(runtimeUrl);
const binding = initializeHostGit([]);
target = binding.executablePath;
const nativeExecFile = childProcess.execFile;
childProcess.execFile = (executable, args, options, callback) => nativeExecFile(executable, args, options, (error, stdout, stderr) => {
  changed = true;
  callback(error, stdout, stderr);
});
syncBuiltinESMExports();
${loadFixtureSource}
let delivered = false, message = "", codes = [];
try { await fixture.createRepoFixture(); delivered = true; }
catch (error) { message = error.message; codes = errorCodes(error); }
const root = /保全自有根 ([^ ]+)/u.exec(message)?.[1] ?? "";
process.stdout.write(JSON.stringify({ delivered, message, codes, root, rootExists: Boolean(root && existsSync(root)) }));
`, [runtimeUrl, fixtureUrl], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({ delivered: false, rootExists: true });
    expect(result.message).toContain("保全自有根");
    expect(result.codes).toContain("git_changed");
  }));

  test("绑定Git命令失败保留真实退出原因且不改选PATH中的同名程序", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-failure-scope-");
    const result = await runJsonChild(productRoot, `${errorCodesSource}
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
const binding = initializeHostGit([]);
const decoyBin = join(process.env.TMPDIR, "fallback-bin");
mkdirSync(decoyBin, { mode: 0o700 });
writeFileSync(join(decoyBin, "git"), ${JSON.stringify(`#!${process.execPath}\nprocess.exit(0);\n`)}, { mode: 0o755 });
process.env.PATH = decoyBin;
const fakeGitCalls = [];
childProcess.execFile = (executable, args, options, callback) => {
  fakeGitCalls.push({ executable, args: [...args], cwd: options.cwd });
  const error = Object.assign(new Error("controlled Git exit 23"), { code: 23, killed: false, signal: null });
  queueMicrotask(() => callback(error, "", "controlled failure"));
};
syncBuiltinESMExports();
${loadFixtureSource}
let message = "", codes = [];
try { await fixture.createRepoFixture(); } catch (error) { message = error.message; codes = errorCodes(error); }
const remaining = readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("pi-company-repo-"));
process.stdout.write(JSON.stringify({ binding: binding.executablePath, message, codes, remaining, fakeGitCalls }));
`, [runtimeUrl, fixtureUrl], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({ binding: realGit, codes: [23], remaining: [] });
    expect(result.message).toContain("controlled Git exit 23");
    const calls = result.fakeGitCalls as Array<{ executable: string; args: string[]; cwd: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe(realGit);
    expect(calls[0]!.cwd.startsWith(scopeRoot)).toBe(true);
  }));

  test("首次lstat前根被替换成symlink时零Git且不写替代目标", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-first-lstat-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl, scopeRoot] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
initializeHostGit([]);
const originalTarget = join(scopeRoot, "first-lstat-original");
const replacementTarget = join(scopeRoot, "first-lstat-replacement");
mkdirSync(replacementTarget);
writeFileSync(join(replacementTarget, "marker.txt"), "replacement marker\\n");
const nativeMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
let allocatedRoot = "", calls = 0;
fs.promises.mkdtemp = async (...args) => {
  allocatedRoot = await nativeMkdtemp(...args);
  renameSync(allocatedRoot, originalTarget);
  symlinkSync(replacementTarget, allocatedRoot, "dir");
  return allocatedRoot;
};
childProcess.execFile = () => { calls += 1; throw new Error("Git不应执行"); };
syncBuiltinESMExports();
${loadFixtureSource}
let delivered = false, message = "";
try { await fixture.createRepoFixture(); delivered = true; }
catch (error) { message = error.message; }
process.stdout.write(JSON.stringify({
  delivered, message, calls, allocatedRoot,
  marker: readFileSync(join(replacementTarget, "marker.txt"), "utf8"),
  readmeWritten: existsSync(join(replacementTarget, "README.md")),
  originalExists: existsSync(originalTarget),
}));
`, [runtimeUrl, fixtureUrl, scopeRoot], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      delivered: false,
      calls: 0,
      marker: "replacement marker\n",
      readmeWritten: false,
      originalExists: true,
    });
    expect(result.message).toContain("不是自产真实目录");
  }));

  test("首条真实Git回调后根变化会保全且停止后续写入和exec", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-first-git-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl, scopeRoot] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
initializeHostGit([]);
const originalTarget = join(scopeRoot, "first-git-original");
const replacementTarget = join(scopeRoot, "first-git-replacement");
mkdirSync(replacementTarget);
writeFileSync(join(replacementTarget, "marker.txt"), "replacement marker\\n");
const nativeExecFile = childProcess.execFile;
let calls = 0, swapped = false, allocatedRoot = "";
childProcess.execFile = (executable, args, options, callback) => {
  calls += 1;
  allocatedRoot ||= options.cwd;
  return nativeExecFile(executable, args, options, (error, stdout, stderr) => {
    if (!swapped && calls === 1 && !error) {
      swapped = true;
      renameSync(allocatedRoot, originalTarget);
      symlinkSync(replacementTarget, allocatedRoot, "dir");
    }
    callback(error, stdout, stderr);
  });
};
syncBuiltinESMExports();
${loadFixtureSource}
let delivered = false, message = "";
try { await fixture.createRepoFixture(); delivered = true; }
catch (error) { message = error.message; }
process.stdout.write(JSON.stringify({
  delivered, message, calls, swapped,
  marker: readFileSync(join(replacementTarget, "marker.txt"), "utf8"),
  readmeWritten: existsSync(join(replacementTarget, "README.md")),
  originalGitExists: existsSync(join(originalTarget, ".git")),
}));
`, [runtimeUrl, fixtureUrl, scopeRoot], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      delivered: false,
      calls: 1,
      swapped: true,
      marker: "replacement marker\n",
      readmeWritten: false,
      originalGitExists: true,
    });
    expect(result.message).toContain("保全自有根");
  }));

  test("最终真实Git await结算时根变化不会成功交付", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-final-await-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl, scopeRoot] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
initializeHostGit([]);
const originalTarget = join(scopeRoot, "final-await-original");
const replacementTarget = join(scopeRoot, "final-await-replacement");
mkdirSync(replacementTarget);
writeFileSync(join(replacementTarget, "marker.txt"), "replacement marker\\n");
const nativeExecFile = childProcess.execFile;
let calls = 0, swapped = false, allocatedRoot = "";
childProcess.execFile = (executable, args, options, callback) => {
  calls += 1;
  allocatedRoot ||= options.cwd;
  return nativeExecFile(executable, args, options, (error, stdout, stderr) => {
    if (!swapped && calls === 3 && !error) {
      swapped = true;
      renameSync(allocatedRoot, originalTarget);
      symlinkSync(replacementTarget, allocatedRoot, "dir");
    }
    callback(error, stdout, stderr);
  });
};
syncBuiltinESMExports();
${loadFixtureSource}
let delivered = false, message = "";
try { await fixture.createRepoFixture(); delivered = true; }
catch (error) { message = error.message; }
process.stdout.write(JSON.stringify({
  delivered, message, calls, swapped,
  marker: readFileSync(join(replacementTarget, "marker.txt"), "utf8"),
  readmeWritten: existsSync(join(replacementTarget, "README.md")),
  committedReadme: existsSync(join(originalTarget, "README.md")),
}));
`, [runtimeUrl, fixtureUrl, scopeRoot], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      delivered: false,
      calls: 3,
      swapped: true,
      marker: "replacement marker\n",
      readmeWritten: false,
      committedReadme: true,
    });
    expect(result.message).toContain("保全自有根");
  }));

  test("workspace父根变化会停止repo-a后的写入并保全替代目标", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-workspace-root-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
const [runtimeUrl, fixtureUrl, scopeRoot] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
initializeHostGit([]);
const originalTarget = join(scopeRoot, "workspace-original");
const replacementTarget = join(scopeRoot, "workspace-replacement");
mkdirSync(replacementTarget);
writeFileSync(join(replacementTarget, "marker.txt"), "replacement marker\\n");
const nativeExecFile = childProcess.execFile;
let calls = 0, swapped = false;
childProcess.execFile = (executable, args, options, callback) => {
  calls += 1;
  return nativeExecFile(executable, args, options, (error, stdout, stderr) => {
    if (!swapped && calls === 1 && !error) {
      swapped = true;
      const workspaceRoot = dirname(options.cwd);
      renameSync(workspaceRoot, originalTarget);
      symlinkSync(replacementTarget, workspaceRoot, "dir");
    }
    callback(error, stdout, stderr);
  });
};
syncBuiltinESMExports();
${loadFixtureSource}
let delivered = false, message = "";
try { await fixture.createWorkspaceFixture(); delivered = true; }
catch (error) { message = error.message; }
process.stdout.write(JSON.stringify({
  delivered, message, calls, swapped,
  marker: readFileSync(join(replacementTarget, "marker.txt"), "utf8"),
  replacementRepoAReadme: existsSync(join(replacementTarget, "repo-a", "README.md")),
  originalRepoAGit: existsSync(join(originalTarget, "repo-a", ".git")),
}));
`, [runtimeUrl, fixtureUrl, scopeRoot], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      delivered: false,
      calls: 1,
      swapped: true,
      marker: "replacement marker\n",
      replacementRepoAReadme: false,
      originalRepoAGit: true,
    });
    expect(result.message).toContain("保全自有根");
  }));

  test("worktree使用调用时repo引用并在新根变化后拒绝交付", async () => withGitDaemonFixtures(async () => {
    const scopeRoot = await ownedTempRoot("repo-fixture-worktree-root-scope-");
    const result = await runJsonChild(productRoot, `
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [runtimeUrl, fixtureUrl, scopeRoot] = process.argv.slice(1);
const { initializeHostGit } = await import(runtimeUrl);
initializeHostGit([]);
const replacementRepo = join(scopeRoot, "mutated-repo-reference");
const originalTarget = join(scopeRoot, "worktree-original");
const replacementTarget = join(scopeRoot, "worktree-replacement");
mkdirSync(replacementRepo);
mkdirSync(replacementTarget);
writeFileSync(join(replacementTarget, "marker.txt"), "replacement marker\\n");
const nativeMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
const nativeExecFile = childProcess.execFile;
const replacementWorktrees = [];
let repo, mutateRepo = false, monitorWorktree = false;
let calls = 0, swapped = false, commandCwd = "";
fs.promises.mkdtemp = async (...args) => {
  const root = await nativeMkdtemp(...args);
  if (mutateRepo) {
    repo.root = replacementRepo;
    repo.worktrees = replacementWorktrees;
  }
  return root;
};
childProcess.execFile = (executable, args, options, callback) => nativeExecFile(executable, args, options, (error, stdout, stderr) => {
  if (monitorWorktree) {
    calls += 1;
    commandCwd = options.cwd;
    if (!swapped && args.includes("worktree") && !error) {
      swapped = true;
      const worktreeRoot = args.at(-1);
      renameSync(worktreeRoot, originalTarget);
      symlinkSync(replacementTarget, worktreeRoot, "dir");
    }
  }
  callback(error, stdout, stderr);
});
syncBuiltinESMExports();
${loadFixtureSource}
repo = await fixture.createRepoFixture();
const originalRepoRoot = repo.root;
const originalWorktrees = repo.worktrees;
mutateRepo = true;
monitorWorktree = true;
let delivered = false, message = "";
try { await fixture.addWorktree(repo); delivered = true; }
catch (error) { message = error.message; }
await fixture.removeRepoFixture({ root: originalRepoRoot, worktrees: originalWorktrees });
process.stdout.write(JSON.stringify({
  delivered, message, calls, swapped, commandCwd, originalRepoRoot,
  originalWorktrees: originalWorktrees.length,
  replacementWorktrees: replacementWorktrees.length,
  marker: readFileSync(join(replacementTarget, "marker.txt"), "utf8"),
  replacementReadme: existsSync(join(replacementTarget, "README.md")),
  originalGit: existsSync(join(originalTarget, ".git")),
}));
`, [runtimeUrl, fixtureUrl, scopeRoot], { env: { PATH: process.env.PATH ?? "", TMPDIR: scopeRoot } });
    expect(result).toMatchObject({
      delivered: false,
      calls: 1,
      swapped: true,
      originalWorktrees: 0,
      replacementWorktrees: 0,
      marker: "replacement marker\n",
      replacementReadme: false,
      originalGit: true,
    });
    expect(result.commandCwd).toBe(result.originalRepoRoot);
    expect(result.message).toContain("保全自有根");
  }));
});
