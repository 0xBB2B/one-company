import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractCode, getCodeExtractorVersion } from "../runtime/code-extractor.ts";
import { LocalDatabase } from "../runtime/database.ts";
import { indexDatabase } from "../runtime/database-paths.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { IndexStore } from "../runtime/index-store.ts";
import {
  ProjectIndexService,
  ProjectIndexServiceError,
} from "../runtime/project-index-service.ts";
import type { ProjectIndexExtractor } from "../runtime/project-index-service.ts";
import { createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const repositories: RepoFixture[] = [];
const roots: string[] = [];

async function world() {
  const repo = await createRepoFixture();
  repositories.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "project-index-service-data-"));
  roots.push(dataRoot);
  const { repoId } = await repositoryIdentity(repo.root);
  return { repo, dataRoot, repoId };
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

async function service(w: Awaited<ReturnType<typeof world>>, authorize: () => boolean = () => true, extractor?: ProjectIndexExtractor) {
  return ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId, authorize, extractor });
}

function specDocument(expected = "SPEC_SENTINEL") {
  return {
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: "player.jump", title: "跳跃", aliases: ["起跳"] },
    rules: [{
      id: "player.jump.once",
      title: "只跳一次",
      condition: "角色在地面",
      trigger: "收到起跳输入",
      expected,
      reason: "避免重复起跳",
      dependsOn: [],
      exceptions: [],
      acceptance: [{ id: "once", given: "在地面", when: "起跳", then: "只起跳一次" }],
    }],
  };
}

async function putLegacyRulesFile(root: string): Promise<void> {
  await mkdir(join(root, "docs/spec"), { recursive: true });
  await writeFile(join(root, "docs/spec/jump.rules.json"), JSON.stringify(specDocument()));
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function childUntilLine(child: ReturnType<typeof spawn>, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`未等到子进程输出：${output}`)), 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 ${code}：${output}`)); });
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) { clearTimeout(timer); resolve(output); }
    });
  });
}

async function runHelper(input: Record<string, string>): Promise<{ parseCount: number; status: string; generation: number }> {
  const helper = new URL("./helpers/project-index-process.ts", import.meta.url);
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
  const result = await exec(process.execPath, [helper.pathname, encoded], { cwd: process.cwd(), timeout: 20_000, env: process.env });
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { parseCount: number; status: string; generation: number };
}

afterEach(async () => {
  for (const repo of repositories.splice(0).reverse()) await removeRepoFixture(repo);
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

test("open默认拒绝；preview/status只核验并且不创建index.db", async () => {
  const w = await world();
  await expect(ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId }))
    .rejects.toMatchObject({ code: "authorization_denied" });

  await put(w.repo.root, "src/main.ts", "export function main() {}\n");
  const index = await service(w);
  const preview = await index.preview();
  expect(preview).toMatchObject({ action: "preview", databaseCreated: false, partial: false });
  expect(preview.files).toContainEqual({ path: "src/main.ts", kind: "code", language: "ts", size: 26 });
  expect((await index.status()).initialized).toBe(false);
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await index.init({ signal: cancelled.signal })).toMatchObject({ status: "cancelled", readBytes: 0, parsedFiles: 0 });
  await expect(stat(indexDatabase(w.dataRoot, w.repoId))).rejects.toMatchObject({ code: "ENOENT" });
});

test("dataRoot仓库目录链接到worktree时在chmod和开库前拒绝，且不改目标权限或落库", async () => {
  const w = await world();
  await mkdir(join(w.dataRoot, "repos"));
  const index = await service(w);
  const targetMode = (await stat(w.repo.root)).mode & 0o777;
  await symlink(w.repo.root, join(w.dataRoot, "repos", w.repoId), "dir");

  await expect(index.init()).rejects.toMatchObject({ code: "invalid_data_root" });
  await expect(index.status()).rejects.toMatchObject({ code: "invalid_data_root" });
  await expect(ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true }))
    .rejects.toMatchObject({ code: "invalid_data_root" });
  await expect(stat(join(w.repo.root, "index.db"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(w.repo.root)).mode & 0o777).toBe(targetMode);
});

test("init接通真实Tree-sitter、遗留规则文件、未知语言、FTS与1基行/UTF-16 offset", async () => {
  const w = await world();
  const source = [
    "import { remote } from 'pkg';",
    "export function target() {}",
    "export const run = () => target();",
    "remote();",
  ].join("\r\n");
  await put(w.repo.root, "src/中文😀.ts", source);
  await put(w.repo.root, "tools/check.py", "print('UNSUPPORTED_SENTINEL')\n");
  await putLegacyRulesFile(w.repo.root);
  const secondSpec = specDocument("落地");
  secondSpec.rules[0]!.id = "player.jump.land";
  secondSpec.rules[0]!.condition = "角色正在下落";
  secondSpec.rules[0]!.trigger = "接触地面";
  await writeFile(join(w.repo.root, "docs/spec/land.rules.json"), JSON.stringify(secondSpec));

  const index = await service(w);
  const result = await index.init();
  expect(result.status).toBe("partial");
  expect(result.diagnostics).toContainEqual({ code: "unsupported_language", path: "tools/check.py" });
  expect(await readdir(join(w.dataRoot, "repos", w.repoId))).toEqual(["index.db"]);
  await expect(stat(join(w.dataRoot, "repos", w.repoId, "data.db"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(w.dataRoot, "global.db"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(result).not.toHaveProperty("spec");
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    const snapshot = store.getSnapshot();
    const target = snapshot.symbols.find((item) => item.name === "target")!;
    const run = snapshot.symbols.find((item) => item.name === "run")!;
    expect(target).toMatchObject({ kind: "function", startLine: 2, startOffset: source.indexOf("function target") });
    expect(run.kind).toBe("function");
    expect(snapshot.symbols.some((item) => item.kind === "import")).toBe(true);
    expect(snapshot.symbols.some((item) => item.kind === "export")).toBe(true);
    expect(snapshot.codeEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSymbolId: run.id, toSymbolId: expect.any(String), certainty: "certain", evidence: "call_expression", path: "src/中文😀.ts", startLine: 3 }),
      expect.objectContaining({ fromSymbolId: null, toSymbolId: null, certainty: "unknown", evidence: "call_expression", name: "remote" }),
    ]));
    expect(snapshot.files.find((item) => item.path === "tools/check.py")).toMatchObject({ kind: "code", status: "unsupported", hash: sha("print('UNSUPPORTED_SENTINEL')\n") });
    expect(store.search("UNSUPPORTED_SENTINEL").results).toHaveLength(1);
    expect(store.search("SPEC_SENTINEL").results).toHaveLength(1);
    expect(snapshot.files.find((item) => item.path === "docs/spec/jump.rules.json")).toMatchObject({ kind: "config", status: "indexed" });
  } finally { store.close(); }
});

test("Go range局部函数变量在正式索引中保持未知目标，循环外恢复包级引用", async () => {
  const w = await world();
  await put(w.repo.root, "range.go", "package p\nfunc target() <-chan func() {return nil}\nfunc caller() { for target := range target() { target() }; target() }\n");
  const index = await service(w);
  expect((await index.init()).status).toBe("ready");
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    const snapshot = store.getSnapshot();
    const edges = snapshot.codeEdges.filter(edge => edge.name === "target").sort((a, b) => a.startColumn! - b.startColumn!);
    expect(edges).toHaveLength(3);
    const target = snapshot.symbols.find(symbol => symbol.name === "target")!.id;
    expect(edges[0]).toMatchObject({ certainty: "certain", toSymbolId: target });
    expect(edges[1]).toMatchObject({ certainty: "unknown", toSymbolId: null, path: "range.go" });
    expect(edges[2]).toMatchObject({ certainty: "certain", toSymbolId: target });
  } finally { store.close(); }
});

test("未变hash+同语言版本跨refresh复用；同size/mtime变化仍按hash重解析；版本变化只重解析对应语言", async () => {
  const w = await world();
  await put(w.repo.root, "src/a.ts", "export const word = 'alpha';\n");
  await put(w.repo.root, "web/a.js", "export const value = 'same';\n");
  const counts = new Map<string, number>();
  const versions = { ts: getCodeExtractorVersion("ts"), js: getCodeExtractorVersion("js") };
  const extractor: ProjectIndexExtractor = {
    version(language) { return language === "ts" ? versions.ts : language === "js" ? versions.js : getCodeExtractorVersion(language); },
    async extract(input) { counts.set(input.language, (counts.get(input.language) ?? 0) + 1); return extractCode(input); },
  };
  const index = await service(w, () => true, extractor);
  expect((await index.init()).parsedFiles).toBe(2);
  counts.clear();
  expect(await index.refresh()).toMatchObject({ parsedFiles: 0, reusedFiles: 2 });
  expect(counts.size).toBe(0);
  const afterRepeat = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    const snapshot = afterRepeat.getSnapshot();
    expect(new Set(snapshot.symbols.map((item) => item.id)).size).toBe(snapshot.symbols.length);
    expect(new Set(snapshot.codeEdges.map((item) => item.id)).size).toBe(snapshot.codeEdges.length);
  } finally { afterRepeat.close(); }

  const path = join(w.repo.root, "src/a.ts");
  const before = await stat(path);
  await writeFile(path, "export const word = 'bravo';\n");
  await utimes(path, before.atime, before.mtime);
  counts.clear();
  expect(await index.refresh()).toMatchObject({ parsedFiles: 1, reusedFiles: 1 });
  expect(counts.get("ts")).toBe(1);
  expect(counts.get("js") ?? 0).toBe(0);

  versions.ts = `${versions.ts}:test-revision`;
  counts.clear();
  expect(await index.refresh()).toMatchObject({ parsedFiles: 1, reusedFiles: 1 });
  expect(counts.get("ts")).toBe(1);
  expect(counts.get("js") ?? 0).toBe(0);
});

test("parser_unavailable缓存不会永久复用，资源恢复后相同hash和版本会重新提取", async () => {
  const w = await world();
  await put(w.repo.root, "src/recover.ts", "export function recovered() {}\n");
  let unavailable = true;
  let attempts = 0;
  const extractor: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    async extract(input) {
      attempts++;
      if (unavailable) throw new Error("temporary parser failure");
      return extractCode(input);
    },
  };
  const index = await service(w, () => true, extractor);
  const failed = await index.init();
  expect(failed).toMatchObject({ status: "partial", parsedFiles: 1, reusedFiles: 0 });
  expect(failed.diagnostics).toContainEqual({ code: "parser_unavailable", path: "src/recover.ts" });

  unavailable = false;
  const recovered = await index.refresh();
  expect(recovered).toMatchObject({ status: "ready", parsedFiles: 1, reusedFiles: 0 });
  expect(attempts).toBe(2);
  const hot = await index.refresh();
  expect(hot).toMatchObject({ status: "ready", parsedFiles: 0, reusedFiles: 1 });
  expect(attempts).toBe(2);

  await writeFile(join(w.repo.root, "src/recover.ts"), "export function broken( {\n");
  expect(await index.refresh()).toMatchObject({ status: "partial", parsedFiles: 1, reusedFiles: 0 });
  expect(attempts).toBe(3);
  expect(await index.refresh()).toMatchObject({ status: "partial", parsedFiles: 0, reusedFiles: 1 });
  expect(attempts).toBe(3);
});

test("代码语法错误发布partial并替换旧文件正文，不让旧FTS冒充当前实现", async () => {
  const w = await world();
  const path = join(w.repo.root, "src/main.ts");
  await put(w.repo.root, "src/main.ts", "export function main() { return 'OLD_CODE_SENTINEL'; }\n");
  const index = await service(w);
  expect((await index.init()).status).toBe("ready");
  let store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  expect(store.search("OLD_CODE_SENTINEL").results).toHaveLength(1);
  store.close();

  await writeFile(path, "export function broken( { return 'NEW_BROKEN_SENTINEL';\n");
  expect(await index.refresh()).toMatchObject({ status: "partial" });
  store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    expect(store.search("OLD_CODE_SENTINEL").results).toEqual([]);
    expect(store.search("NEW_BROKEN_SENTINEL").results).toHaveLength(1);
    expect(store.getSnapshot().files.find((item) => item.path === "src/main.ts")?.status).toBe("parse_error");
  } finally { store.close(); }
});

test("归档只登记完整UUID路径，正文不可读也能初始化；非法名和重复UUID明确报告", async () => {
  const w = await world();
  const id = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  await put(w.repo.root, "src/main.ts", "export {}\n");
  await put(w.repo.root, `docs/prod/${id}.完成A.md`, "ARCHIVE_SECRET_A");
  await put(w.repo.root, `docs/prod/${id}.完成B.md`, "ARCHIVE_SECRET_B");
  await put(w.repo.root, "docs/prod/not-a-uuid.md", "ARCHIVE_SECRET_BAD");
  await chmod(join(w.repo.root, "docs/prod", `${id}.完成A.md`), 0o000);
  const index = await service(w);
  const result = await index.init();
  await chmod(join(w.repo.root, "docs/prod", `${id}.完成A.md`), 0o600);
  expect(result.archives.metadata).toHaveLength(2);
  expect(result.archives.metadata.every((item) => item.lifecycle === "unknown" && item.epoch === null && item.hash === null)).toBe(true);
  expect(result.archives.issues.filter((item) => item.reason === "duplicate_requirement_id")).toHaveLength(2);
  expect(result.archives.issues).toContainEqual(expect.objectContaining({ path: "docs/prod/not-a-uuid.md", reason: "invalid_archive_name" }));
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    expect(store.search("ARCHIVE_SECRET_A").results).toEqual([]);
    expect(store.search("ARCHIVE_SECRET_B").results).toEqual([]);
  } finally { store.close(); }
});

test("归档目录里的原型 html 不进归档登记，也不报归档名问题", async () => {
  const w = await world();
  const id = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  await put(w.repo.root, "src/main.ts", "export {}\n");
  await put(w.repo.root, `docs/prod/${id}.完成A.md`, "ARCHIVE_BODY");
  await put(w.repo.root, `docs/prod/${id}.设置页.html`, "<html>PROTOTYPE_SENTINEL</html>");
  await put(w.repo.root, `docs/prod/${id}.命令行输出.html`, "<html>PROTOTYPE_SENTINEL</html>");
  const index = await service(w);
  const result = await index.init();
  expect(result.archives.metadata.map((item) => item.fileName)).toEqual([`${id}.完成A.md`]);
  expect(result.archives.issues).toEqual([]);
  const refreshed = await index.refresh();
  expect(refreshed.archives.issues).toEqual([]);
  expect(refreshed.archives.metadata).toHaveLength(1);
});

test("归档目录里不以需求编号开头的 html 仍报归档名无效，以需求编号开头的原型 html 不报", async () => {
  const w = await world();
  const id = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  await put(w.repo.root, "src/main.ts", "export {}\n");
  await put(w.repo.root, "docs/prod/notes.html", "<html></html>");
  await put(w.repo.root, `docs/prod/${id}.设置页.html`, "<html></html>");
  const result = await (await service(w)).init();
  expect(result.archives.issues).toEqual([expect.objectContaining({ path: "docs/prod/notes.html", reason: "invalid_archive_name" })]);
});

test("取消把building落为cancelled，重新打开可用新fence恢复", async () => {
  const w = await world();
  await put(w.repo.root, "src/a-first.ts", "export function first() {}\n");
  await put(w.repo.root, "src/z-wait.ts", "export function waiting() {}\n");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocking: ProjectIndexExtractor = {
    version: getCodeExtractorVersion,
    extract(input) {
      if (input.path === "src/a-first.ts") return extractCode(input);
      entered();
      return new Promise((resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true });
      });
    },
  };
  const index = await service(w, () => true, blocking);
  const pending = index.init();
  await started;
  expect(index.cancel()).toBe(true);
  const cancelled = await pending;
  expect(cancelled).toMatchObject({ status: "cancelled", generation: 0, parsedFiles: 1, readBytes: expect.any(Number) });
  expect(cancelled.readBytes).toBeGreaterThan(0);
  expect((await index.status()).index?.status).toBe("cancelled");

  const recovered = await service(w);
  expect(await recovered.init()).toMatchObject({ status: "ready", generation: 1 });
});

test("真实SIGKILL留下building但不返回旧current；新进程恢复且未变文件跨进程parseCount为0", async () => {
  const w = await world();
  await put(w.repo.root, "src/kill.ts", "export function survive() {}\n");
  const helper = new URL("./helpers/project-index-process.ts", import.meta.url);
  const encoded = Buffer.from(JSON.stringify({ mode: "hang", repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId })).toString("base64url");
  const child = spawn(process.execPath, [helper.pathname, encoded], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await childUntilLine(child, "EXTRACTOR_WAITING");
    child.kill("SIGKILL");
    await closed;
  } finally {
    child.kill("SIGKILL");
    await closed;
  }

  const index = await service(w);
  expect((await index.status()).index?.status).toBe("building");
  expect(await index.init()).toMatchObject({ status: "ready", generation: 1 });
  const childResult = await runHelper({ mode: "count", repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId });
  expect(childResult).toMatchObject({ parseCount: 0, status: "ready", generation: 2 });
});

test("分支身份变化和逐文件授权过期均拒绝，错误不带Git/OS/源码正文", async () => {
  const w = await world();
  await put(w.repo.root, "src/secret.ts", "export const NEVER_LEAK_THIS = true;\n");
  let reads = 0;
  const index = await service(w, () => ++reads < 5);
  let denied: unknown;
  try { await index.init(); } catch (error) { denied = error; }
  expect(denied).toBeInstanceOf(ProjectIndexServiceError);
  expect(denied).toMatchObject({ code: "authorization_denied", metadata: { retryable: false } });
  expect(JSON.stringify(denied)).not.toContain("NEVER_LEAK_THIS");

  const stable = await service(w);
  await exec("git", ["branch", "-m", "renamed"], { cwd: w.repo.root, env: GIT_ENV });
  let changed: unknown;
  try { await stable.status(); } catch (error) { changed = error; }
  expect(changed).toMatchObject({ code: "identity_changed" });
  expect((changed as Error).message).not.toMatch(/fatal|rev-parse|ENOENT|NEVER_LEAK_THIS/);
});

test("真实默认解析器的运行时与语法加载瞬时失败后同进程刷新可恢复", async () => {
  const w = await world();
  await put(w.repo.root, "main.go", "package main\nfunc main() {}\n");
  const script = `
    import { Parser, Language } from 'web-tree-sitter';
    import { ProjectIndexService } from ${JSON.stringify(new URL("../runtime/project-index-service.ts", import.meta.url).href)};
    const init = Parser.init, load = Language.load;
    let initCalls = 0, loadCalls = 0;
    Parser.init = async function (...args) { if (++initCalls === 1) throw new Error('temporary runtime failure'); return init.apply(this, args); };
    Language.load = async function (...args) { if (++loadCalls === 1) throw new Error('temporary grammar failure'); return load.apply(this, args); };
    const options = ${JSON.stringify({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId })};
    const service = await ProjectIndexService.open({ ...options, authorize: () => true });
    const results = [await service.init(), await service.refresh(), await service.refresh(), await service.refresh()];
    console.log(JSON.stringify({ states: results.map(r => r.status), parsed: results.map(r => r.parsedFiles), reused: results.map(r => r.reusedFiles), initCalls, loadCalls }));
  `;
  const child = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), timeout: 20_000 });
  expect(JSON.parse(child.stdout.trim())).toEqual({ states: ["partial", "partial", "ready", "ready"], parsed: [0, 0, 1, 0], reused: [0, 0, 0, 1], initCalls: 2, loadCalls: 2 });
});

test("query逐路径返回前再授权；读取期间开始新构建禁止旧代次返回", async () => {
  const w = await world();
  await put(w.repo.root, "src/query.ts", "export const CURRENT = true;\n");
  let revokeOnReturn = false, dirtyOnRead = false;
  let dirtyStore: IndexStore | undefined;
  const index = await ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId,
    authorize(request) {
      if (request.action === "query" && request.phase === "after" && dirtyOnRead) {
        dirtyOnRead = false; dirtyStore!.begin();
      }
      return !(revokeOnReturn && request.action === "query" && request.phase === "return" && request.path !== null);
    },
  });
  await index.init();
  revokeOnReturn = true;
  await expect(index.readCurrentForQuery({ paths: ["src/query.ts"] })).rejects.toMatchObject({ code: "authorization_denied" });
  revokeOnReturn = false;
  dirtyStore = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    dirtyOnRead = true;
    await expect(index.readCurrentForQuery({ paths: ["src/query.ts"] })).rejects.toBeDefined();
    expect(dirtyStore.status().status).toBe("building");
  } finally { dirtyStore.close(); }
});

test.each(["root", "repos", "repository"])("query拒绝受控%s目录过宽权限，返回检查不chmod或改数据库", async (target) => {
  const w = await world(); await put(w.repo.root, "src/query.ts", "// private query\n");
  let widenOnRead = false;
  const directory = target === "root" ? w.dataRoot : target === "repos" ? join(w.dataRoot, "repos") : join(w.dataRoot, "repos", w.repoId);
  const index = await ProjectIndexService.open({ repositoryRoot: w.repo.root, dataRoot: w.dataRoot, repoId: w.repoId,
    authorize(request) {
      if (widenOnRead && request.action === "query" && request.phase === "after") { widenOnRead = false; chmodSync(directory, 0o755); }
      return true;
    },
  });
  await index.init();
  const dbPath = indexDatabase(w.dataRoot, w.repoId);
  const before = await readFile(dbPath);
  const good = await index.readCurrentForQuery({ paths: ["src/query.ts"] });
  expect(good.sourceFiles).toMatchObject([{ body: "// private query\n", startLine: 1, endLine: 2, fileHash: sha("// private query\n") }]);
  await chmod(directory, 0o755);
  await expect(index.readCurrentForQuery({ paths: ["src/query.ts"] })).rejects.toMatchObject({ code: "invalid_data_root" });
  expect((await stat(directory)).mode & 0o777).toBe(0o755); expect(await readFile(dbPath)).toEqual(before);
  await chmod(directory, 0o700); widenOnRead = true;
  await expect(index.readCurrentForQuery({ paths: ["src/query.ts"] })).rejects.toMatchObject({ code: "invalid_data_root" });
  expect((await stat(directory)).mode & 0o777).toBe(0o755); expect(await readFile(dbPath)).toEqual(before);
  await chmod(directory, 0o700);
  expect((await index.readCurrentForQuery({ paths: ["src/query.ts"] })).status.status).toBe("ready");
  expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
});

test("超过10MiB且不超过20MiB的文本集合完整索引，两轮读取与片段上限如实公开", async () => {
  const w = await world();
  const fileBytes = 2 * 1024 * 1024;
  for (let index = 0; index < 6; index++) await put(w.repo.root, `bulk/file-${index}.txt`, String(index).repeat(fileBytes));
  const index = await service(w);
  const result = await index.init({ limits: { maxTotalTextBytes: 13 * 1024 * 1024 } });
  expect(result.budget.used.textBytes).toBeGreaterThan(10 * 1024 * 1024);
  expect(result.budget.used.textBytes).toBeLessThanOrEqual(13 * 1024 * 1024);
  expect(result.readBytes).toBe(result.budget.used.textBytes * 2);
  expect(result.sourceCodepoints).toBeGreaterThan(10 * 1024 * 1024);
  expect(result.skipped.some((item) => item.reason === "total_text_limit")).toBe(false);
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), index.workspace);
  try {
    const snapshot = store.getSnapshot();
    expect(snapshot.sourceFragments.every((item) => Array.from(item.body).length <= 131_072)).toBe(true);
    expect(snapshot.files.filter((item) => item.path.startsWith("bulk/"))).toHaveLength(6);
    expect(snapshot.files.every((item) => /^[0-9a-f]{64}$/.test(item.hash))).toBe(true);
  } finally { store.close(); }
});
