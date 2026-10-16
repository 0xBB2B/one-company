import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { temporaryRoot } from "./helpers/temporary-root.ts";

// 子进程同时覆盖原生 TS 与正式 loader；探针只观察索引使用的 open，保留身份服务的 readFile/Git 元数据读取。
const childProgram = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

process.umask(0o077);
const [mode, project, scratch] = process.argv.slice(2);
const root = await fs.realpath(scratch);
const repo = join(root, "repo");
const linked = join(root, "linked");
const dataRoot = join(root, "data");
const exec = promisify(execFile);
const gitEnv = {
  PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "linked-worktree-test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "linked-worktree-test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (args) => exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: gitEnv, timeout: 10000 });
const indexGitOpens = [];
const indexGitBodyReads = [];
const originalOpen = fs.open;
fs.open = async (...args) => {
  const path = String(args[0]);
  const watched = (path.startsWith(repo + "/") || path.startsWith(linked + "/"))
    && path.split("/").some(part => part.toLowerCase() === ".git");
  if (watched) indexGitOpens.push(path);
  const handle = await originalOpen(...args);
  if (!watched) return handle;
  return new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (["read", "readFile", "readv", "createReadStream"].includes(String(property))) {
        return (...readArgs) => {
          indexGitBodyReads.push(path);
          return Reflect.apply(value, target, readArgs);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
syncBuiltinESMExports();
const url = (path) => pathToFileURL(join(project, path)).href;
const load = mode === "loader"
  ? (await import(url("src/app/daemon/loader.mjs"))).daemonLoader.import
  : (path) => import(path);
const { ProjectIndexService } = await load(url("src/modules/project-index/project-index-service.ts"));
const { repositoryIdentity } = await load(url("src/core/storage/identity.ts"));
const { IndexStore } = await load(url("src/modules/project-index/index-store.ts"));
const { indexDatabase } = await load(url("src/core/storage/database-paths.ts"));
const { readIndexFile, scanIndexWorkspace } = await load(url("src/modules/project-index/project-index-policy.ts"));
const record = { node: process.version, mode, installed: false, indexGitOpens, indexGitBodyReads };
let linkedIndex;
try {
  await fs.mkdir(repo, { mode: 0o700 });
  await fs.mkdir(dataRoot, { mode: 0o700 });
  await git(["init", "-b", "main"]);
  await fs.writeFile(join(repo, "main.ts"), "export function mainOnly() {}\n");
  await git(["add", "main.ts"]);
  await git(["commit", "-m", "fixture"]);
  await git(["worktree", "add", "-b", "linked", linked]);
  assert.equal((await fs.lstat(join(repo, ".git"))).isDirectory(), true);
  assert.equal((await fs.lstat(join(linked, ".git"))).isFile(), true);
  await fs.writeFile(join(linked, "main.ts"), "export function linkedOnly() {}\n");
  const identity = await repositoryIdentity(repo);
  assert.deepEqual(await repositoryIdentity(linked), identity);
  const options = { dataRoot, repoId: identity.repoId, authorize: () => true };
  linkedIndex = await ProjectIndexService.open({ ...options, repositoryRoot: linked });
  const mainIndex = await ProjectIndexService.open({ ...options, repositoryRoot: repo });
  assert.notEqual(linkedIndex.workspace.workspaceId, mainIndex.workspace.workspaceId);
  assert.notEqual(linkedIndex.workspace.branch, mainIndex.workspace.branch);
  const scan = await scanIndexWorkspace({ root: linked, dataRoot });
  record.scanFiles = scan.files.map(file => file.path);
  const marker = await readIndexFile(linked, ".git");
  record.markerReadStatus = marker.status;
  // 先实际 init，再核对排除断言：失败时保留公开错误及 interrupted 状态。
  record.init = await linkedIndex.init();
  assert.equal(record.init.status, "ready");
  assert.deepEqual(marker, { status: "skipped", path: ".git", reason: "excluded_file" });
  assert.deepEqual(record.scanFiles, ["main.ts"]);
  assert.equal(scan.skipped.find(item => item.path === ".git").reason, "excluded_file");
  assert.equal((await mainIndex.init()).status, "ready");

  const snapshot = (service) => {
    const store = new IndexStore(indexDatabase(dataRoot, identity.repoId), service.workspace);
    try {
      const current = store.getSnapshot();
      for (const rows of [current.files, current.symbols, current.sourceFragments]) {
        assert.equal(rows.some(row => row.path.split("/").some(part => part.toLowerCase() === ".git")), false);
      }
      assert.deepEqual(store.search("gitdir").results, []);
      return { current, main: store.search("mainOnly").results.length,
        linked: store.search("linkedOnly").results.length, fresh: store.search("linkedFresh").results.length };
    } finally { store.close(); }
  };
  const mainBefore = snapshot(mainIndex);
  const linkedBefore = snapshot(linkedIndex);
  assert.equal(mainBefore.main, 1);
  assert.equal(mainBefore.linked, 0);
  assert.equal(linkedBefore.main, 0);
  assert.equal(linkedBefore.linked, 1);
  assert.equal(linkedBefore.current.symbols.some(symbol => symbol.name === "linkedOnly"), true);

  await fs.writeFile(join(linked, "main.ts"), "export function linkedFresh() {}\n");
  record.refresh = await linkedIndex.refresh();
  assert.equal(record.refresh.status, "ready");
  assert.deepEqual(snapshot(mainIndex), mainBefore);
  const linkedAfter = snapshot(linkedIndex);
  assert.equal(linkedAfter.linked, 0);
  assert.equal(linkedAfter.fresh, 1);
  assert.equal(linkedAfter.current.symbols.some(symbol => symbol.name === "linkedOnly"), false);
  assert.equal(linkedAfter.current.symbols.some(symbol => symbol.name === "linkedFresh"), true);
  assert.equal((await mainIndex.refresh()).status, "ready");
  assert.deepEqual(snapshot(linkedIndex), linkedAfter);
  // 新服务在同一附加 worktree 复用当前索引，不重新解析未变代码。
  const reopened = await ProjectIndexService.open({ ...options, repositoryRoot: linked });
  assert.equal((await reopened.init()).parsedFiles, 0);
  assert.equal(snapshot(reopened).fresh, 1);
  assert.deepEqual(indexGitOpens, []);
  assert.deepEqual(indexGitBodyReads, []);
  record.passed = true;
} catch (error) {
  record.error = { name: error.name, code: error.code, message: error.message, metadata: error.metadata };
  if (linkedIndex) record.failureStatus = await linkedIndex.status().catch(() => null);
  process.exitCode = 1;
} finally {
  fs.open = originalOpen;
  syncBuiltinESMExports();
  // 所有索引调用与 Git 子进程均已返回；只回收本测试创建的私有现场。
  for (const path of [linked, repo, dataRoot]) await fs.rm(path, { recursive: true, force: true });
  record.cleaned = true;
  console.log(JSON.stringify(record));
}
`;

for (const mode of ["native", "loader"]) test(`M3-AC1/3/9：真实附加 worktree init/refresh 隔离与 Git 正文零读取（${mode}）`, async () => {
  const scratch = await mkdtemp(join(temporaryRoot(), "m3-linked-worktree-test-"));
  try {
    const helper = join(scratch, "linked-index.mjs");
    await writeFile(helper, childProgram, { mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath, [helper, mode, process.cwd(), scratch], {
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      node: process.version, mode, installed: false, passed: true, cleaned: true,
      indexGitOpens: [], indexGitBodyReads: [], markerReadStatus: "skipped",
      scanFiles: ["main.ts"], init: { status: "ready" }, refresh: { status: "ready" },
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 40_000);
