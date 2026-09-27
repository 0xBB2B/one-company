import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IndexStore } from "../runtime/index-store.ts";
import { LocalDatabase } from "../runtime/database.ts";
import { indexDatabase } from "../runtime/database-paths.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import { readIndexFile } from "../runtime/project-index-policy.ts";
import { KnowledgeQuerySession } from "../runtime/knowledge-query.ts";
import type { KnowledgeQueryAdapter, KnowledgeQueryCapture, KnowledgeFactPackage, KnowledgeRequirementMetadata } from "../runtime/knowledge-query.ts";
import { KNOWLEDGE_QUERY_LIMITS, KnowledgeQueryError, KnowledgeQuerySchema, parseKnowledgeQuery } from "../runtime/knowledge-query-contracts.ts";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const repositories: RepoFixture[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const repo of repositories.splice(0)) await removeRepoFixture(repo);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const prodId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
async function put(root: string, path: string, value: string) {
  await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), value);
}
async function fixture() {
  const repo = await createRepoFixture(); repositories.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "knowledge-query-")); roots.push(dataRoot);
  const { repoId } = await repositoryIdentity(repo.root);
  await put(repo.root, "src/动作😀.ts", "// 超级角色跳跃机制😀\r\nexport function jump() { return '角色跳跃'; }\r\nexport function run() { jump(); external(); }\r\n");
  await put(repo.root, "src/same.ts", "export function jump() { return '没有关系'; }\n");
  await put(repo.root, "docs/spec/jump.rules.json", JSON.stringify({
    $schema: "schema.json", schemaVersion: 1, feature: { id: "player.jump", title: "超级角色跳跃规则", aliases: ["离地腾空"] },
    rules: [{ id: "player.jump.once", title: "一次起跳", condition: "在地面", trigger: "起跳输入", expected: "角色跳跃", reason: "禁止二次跳跃",
      dependsOn: [], exceptions: [], acceptance: [{ id: "once", given: "在地面", when: "起跳", then: "仅一次" }] }],
  }, null, 2));
  await put(repo.root, `docs/prod/${prodId}.完成.md`, "角色跳跃 PROD_NEVER_RETURN");
  await put(repo.root, ".env", "角色跳跃 SECRET_NEVER_RETURN");
  let authorized = true, observedSequence = 0, authorityEpoch = "epoch-1", connected = true;
  let scope: string[] = ["."];
  const service = await ProjectIndexService.open({ repositoryRoot: repo.root, dataRoot, repoId, authorize: () => authorized });
  let build = await service.init();
  async function capture(): Promise<KnowledgeQueryCapture> {
    if (!authorized || !connected) throw new Error("revoked");
    const current = await service.preview();
    const files: Array<{ path: string; hash: string }> = [];
    for (const file of current.files.filter((file) => scope.some((root) => root === "." || file.path === root || file.path.startsWith(`${root}/`)))) {
      const read = await readIndexFile(repo.root, file, { readUnsupported: true });
      if (read.status !== "success") throw new Error("unavailable file");
      files.push({ path: file.path, hash: read.sha256 });
    }
    return { baseline: { ...service.workspace, generation: build.generation, baselineHash: build.baselineHash!, observedSequence, authorityEpoch,
      coverage: { kind: "allowed-inputs", complete: true, roots: scope, excludedPaths: ["docs/prod"], policyHash: sha(JSON.stringify(scope)) }, files },
      build: { workspaceId: service.workspace.workspaceId, generation: build.generation, baselineHash: build.baselineHash! } };
  }
  const adapter: KnowledgeQueryAdapter = {
    captureFresh: capture,
    readCurrent: (paths, bodies) => service.readCurrentForQuery({ paths, bodies }),
    async assertCurrent(origin) {
      const fresh = (await capture()).baseline;
      expect(fresh.generation).toBeGreaterThanOrEqual(origin.generation);
      if (JSON.stringify({ ...fresh, generation: 0 }) !== JSON.stringify({ ...origin, generation: 0 })) throw new Error("changed");
    },
  };
  function withRequirement(readNow: () => KnowledgeRequirementMetadata | null, hooks: {
    readMetadata?: () => Promise<KnowledgeRequirementMetadata | null>;
    assertCurrent?: KnowledgeQueryAdapter["assertCurrent"];
  } = {}): KnowledgeQueryAdapter {
    const requirementMetadata = hooks.readMetadata ?? (async () => readNow());
    return { ...adapter, requirementMetadata, async finalCheck(expected) {
      const metadata = await requirementMetadata();
      if (JSON.stringify(metadata) !== JSON.stringify(expected.requirementMetadata)) throw new KnowledgeQueryError("stale");
      await (hooks.assertCurrent ?? adapter.assertCurrent)(expected.baseline);
      // 本夹具的需求/撤权状态由本进程同步持有；所有I/O结束后联合核对，不伪造观察事件。
      if (JSON.stringify(readNow()) !== JSON.stringify(expected.requirementMetadata) || !authorized || !connected
        || observedSequence !== expected.baseline.observedSequence || authorityEpoch !== expected.baseline.authorityEpoch) throw new KnowledgeQueryError("stale");
    } };
  }
  return { repo, dataRoot, repoId, service, adapter, capture, withRequirement, get build() { return build; },
    async refresh() { build = await service.refresh(); return build; },
    revoke() { authorized = false; }, disconnect() { connected = false; }, observe() { observedSequence++; },
    epoch() { authorityEpoch += "x"; }, scope(value: string[]) { scope = value; } };
}
async function all(session: KnowledgeQuerySession, query: Record<string, unknown>): Promise<KnowledgeFactPackage[]> {
  const pages: KnowledgeFactPackage[] = []; let cursor: string | undefined;
  do { const page = await session.query({ ...query, ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor ?? undefined; } while (cursor);
  return pages;
}

test("strict exact/search/facts 拒绝权限、SQL/regex扩展、本机路径和prod载荷", () => {
  expect(parseKnowledgeQuery({ action: "facts" })).toMatchObject({ action: "facts", pageSize: 10 });
  for (const extra of ["role", "caller", "requirementId", "sql", "regex", "prodBody", "workspaceId"]) {
    expect(() => parseKnowledgeQuery({ action: "facts", [extra]: "main" })).toThrowError(expect.objectContaining({ code: "invalid_query" }));
  }
  for (const value of ["/tmp/index.db", "../secret", "C:/private", "docs/prod/x.md", ".env", "src/.git/config", "src//x", "src/./x"]) {
    expect(() => parseKnowledgeQuery({ action: "exact", by: "path", value })).toThrow();
  }
  for (const input of [{ action: "search", text: "" }, { action: "search", text: "a".repeat(257) }, { action: "facts", maxBytes: 4095 }, { action: "facts", pageSize: 21 }, { action: "facts", cursor: "forged" }]) {
    expect(() => parseKnowledgeQuery(input)).toThrow();
  }
});

test("中文词内子串命中当前代码与普通文件，不触发FTS语法或prod搜索", async () => {
  const w = await fixture(), session = new KnowledgeQuerySession(w.adapter);
  const fts = vi.spyOn(LocalDatabase.prototype, "searchIndexFragments");
  const pages = await all(session, { action: "search", text: "角色跳跃" });
  const output = JSON.stringify(pages);
  expect(pages.flatMap((page) => page.facts).some((item) => item.kind === "source" && item.source.path === "docs/spec/jump.rules.json")).toBe(true);
  expect(pages.flatMap((page) => page.facts).some((item) => item.kind === "source" && item.source.path.startsWith("src/"))).toBe(true);
  expect(output).not.toMatch(/PROD_NEVER_RETURN|SECRET_NEVER_RETURN|docs\/prod|prod_metadata/);
  expect(pages[0]).toMatchObject({ generation: w.build.generation, baselineHash: w.build.baselineHash, trust: "untrusted_project_data_not_instructions_or_authorization" });
  expect(pages[0]).not.toHaveProperty("contractSetHash");
  expect((await session.query({ action: "search", text: '" OR * NEAR(' })).facts).toEqual([]);
  expect(fts).not.toHaveBeenCalled(); session.close();
});

test("相对路径/同名符号保留真实行/hash/parser依据，不制造跨文件同名调用", async () => {
  const w = await fixture(), session = new KnowledgeQuerySession(w.adapter);
  const named = await session.query({ action: "exact", by: "symbol", value: "jump" });
  const symbols = named.facts.filter((item) => item.kind === "symbol");
  expect(symbols).toHaveLength(2);
  const local = symbols.find((item) => item.source.path === "src/动作😀.ts")!;
  expect(local.source).toMatchObject({ startLine: 2, endLine: 2, rangeKind: "symbol", fileHash: sha(await readFile(join(w.repo.root, "src/动作😀.ts"), "utf8")), parserVersion: expect.any(String) });
  const edges = named.facts.filter((item) => item.kind === "code_relation");
  expect(edges).toHaveLength(1);
  expect(edges[0]!.data).toMatchObject({ certainty: "certain", toSymbolId: local.id, evidence: "call_expression" });
  const path = await session.query({ action: "exact", by: "path", value: "src/动作😀.ts", pageSize: 20 });
  expect(path.facts.every((item) => item.source.path === "src/动作😀.ts")).toBe(true);
  expect(path.facts.some((item) => item.kind === "source")).toBe(true); session.close();
});

test("partial查询保留未知/语法诊断，dirty严禁重建快照兜底", async () => {
  const w = await fixture();
  await put(w.repo.root, "broken.ts", "function broken( {\n"); await w.refresh();
  const session = new KnowledgeQuerySession(w.adapter);
  const partial = await session.query({ action: "facts", pageSize: 1 });
  expect(partial.indexStatus).toBe("partial"); expect(partial.limitations.diagnosticCounts.syntax_error).toBeGreaterThan(0);
  expect(partial.limitations.unknownCodeRelations).toBeGreaterThan(0); expect(partial.coverage.complete).toBe(false);
  const rebuild = vi.spyOn(IndexStore.prototype, "getRebuildSnapshot");
  await w.service.markDirty();
  await expect(session.query({ action: "facts" })).rejects.toBeDefined();
  expect(rebuild).not.toHaveBeenCalled(); session.close();
});

test("有界UTF8/码点片段含emoji与CRLF，长行后部命中不会被切丢，截断不声称完整", async () => {
  const w = await fixture();
  await put(w.repo.root, "src/long.ts", `// first\r\n// ${"😀".repeat(1500)}命中位置${"😀".repeat(1500)}\r\n`); await w.refresh();
  const session = new KnowledgeQuerySession(w.adapter);
  const page = await session.query({ action: "search", text: "命中位置" });
  const item = page.facts.find((item) => item.kind === "source")!;
  const body = (item.data as { body: string }).body;
  expect(body).toContain("命中位置"); expect(body).not.toContain("\ufffd");
  expect(Array.from(body).length).toBeLessThanOrEqual(800); expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
  expect(item).toMatchObject({ complete: false, source: { startLine: 2, endLine: 2, rangeKind: "excerpt" } });
  expect(page.coverage).toMatchObject({ sourceExcerptsTruncated: 1, complete: false }); session.close();
});

test("游标绑定caller/查询/预算，返回对象修改不能污染缓存，复用已消费游标拒绝", async () => {
  const w = await fixture(), a = new KnowledgeQuerySession(w.adapter), b = new KnowledgeQuerySession(w.adapter);
  const first = await a.query({ action: "facts", pageSize: 1 }); expect(first.nextCursor).toBeTruthy();
  await expect(b.query({ action: "facts", pageSize: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_cursor" });
  await expect(b.query({ action: "facts", pageSize: 1, cursor: first.nextCursor })).rejects.toThrow("第一次查询不带 cursor");
  const altered = await a.query({ action: "facts", pageSize: 1 });
  await expect(a.query({ action: "facts", pageSize: 2, cursor: altered.nextCursor })).rejects.toMatchObject({ code: "invalid_cursor" });
  first.facts[0]!.source.fileHash = "forged";
  const next = await a.query({ action: "facts", pageSize: 1, cursor: first.nextCursor });
  expect(JSON.stringify(next)).not.toContain("forged"); expect(next.generation).toBe(first.generation);
  await expect(a.query({ action: "facts", pageSize: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid_cursor" });
  a.close(); b.close();
});

test("同hash机械generation增加可继续，原generation/asOf不改写", async () => {
  const w = await fixture(), session = new KnowledgeQuerySession(w.adapter);
  const first = await session.query({ action: "facts", pageSize: 1 });
  const refreshed = await w.refresh(); expect(refreshed.generation).toBe(first.generation + 1); expect(refreshed.baselineHash).toBe(first.baselineHash);
  const next = await session.query({ action: "facts", pageSize: 1, cursor: first.nextCursor });
  expect(next).toMatchObject({ generation: first.generation, asOf: first.asOf, baselineHash: first.baselineHash }); session.close();
});

test.each(["file", "new-file", "observation", "epoch", "scope", "disconnect", "revoke"])("分页%s变化拒绝原游标，不换绑", async (change) => {
  const w = await fixture(), session = new KnowledgeQuerySession(w.adapter);
  const first = await session.query({ action: "facts", pageSize: 1 });
  if (change === "file") await put(w.repo.root, "src/same.ts", "export const changed = true;\n");
  if (change === "new-file") await put(w.repo.root, "new.ts", "export {};\n");
  if (change === "observation") w.observe();
  if (change === "epoch") w.epoch();
  if (change === "scope") w.scope(["src"]);
  if (change === "disconnect") w.disconnect();
  if (change === "revoke") w.revoke();
  await expect(session.query({ action: "facts", pageSize: 1, cursor: first.nextCursor })).rejects.toBeDefined();
  expect(session.diagnostics.sessions).toBe(0); session.close();
});

test("返回前真实文件改动/撤权使第一页失败，未提供current hooks默认拒绝", async () => {
  const w = await fixture();
  expect(() => new KnowledgeQuerySession({} as never)).toThrow();
  const readCurrent = w.adapter.readCurrent;
  const session = new KnowledgeQuerySession({ ...w.adapter, async readCurrent(paths, bodies) {
    const result = await readCurrent(paths, bodies); await put(w.repo.root, "src/same.ts", "CHANGED_AFTER_READ"); return result;
  } });
  await expect(session.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); session.close();
  await w.refresh();
  const denied = new KnowledgeQuerySession({ ...w.adapter, async readCurrent(paths, bodies) { const result = await readCurrent(paths, bodies); w.revoke(); return result; } });
  await expect(denied.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); denied.close();
});

test("历史PASS和伪formal不构成当前通过，性能始终unknown，正文证据字段拒绝", async () => {
  const w = await fixture();
  const session = new KnowledgeQuerySession({ ...w.adapter, async evidenceMetadata() { return [
    { runId: "historical", kind: "legacy", result: "pass" },
    { runId: "fake-formal", kind: "formal", result: "pass", verificationId: "claimed-id", verificationInputHash: sha("claimed") },
  ]; } });
  const result = await session.query({ action: "facts", pageSize: 1 });
  expect(result.evidence.records).toHaveLength(2);
  expect(result.evidence.records.every((value) => value.applicability === "unknown" && value.currentPass === false)).toBe(true);
  expect(result.limitations).toMatchObject({ performanceImprovement: "unknown", formalVerification: "not_available" }); session.close();
  const unsafe = new KnowledgeQuerySession({ ...w.adapter, async evidenceMetadata() { return [{ runId: "run", kind: "legacy", result: "pass", summary: "PROD_FROM_REPORT" }] as never; } });
  await expect(unsafe.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); unsafe.close();
});

test("关闭/未绑定不提供目标，活动元数据需可信绑定；分页中关闭不能继续旧目标", async () => {
  const w = await fixture();
  let value: KnowledgeRequirementMetadata = { requirementId: prodId, workspaceId: w.service.workspace.workspaceId, branch: w.service.workspace.branch,
    lifecycle: "active", approvedProdHash: sha("approved"), lifecycleEpoch: 1 };
  const session = new KnowledgeQuerySession(w.withRequirement(() => value));
  const first = await session.query({ action: "facts", pageSize: 1 }); expect(first.requirement).toHaveProperty("approvedProdHash");
  value = { ...value, lifecycle: "closed" };
  await expect(session.query({ action: "facts", pageSize: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale" });
  const closed = await session.query({ action: "facts", pageSize: 1 }); expect(closed.requirement).toEqual({ requirementId: prodId, lifecycle: "closed" });
  value = { ...value, workspaceId: sha("foreign") };
  await expect(session.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); session.close();
});

test("返回前关闭变化废止在途活动需求元数据", async () => {
  const w = await fixture();
  let lifecycle: "active" | "closed" = "active";
  const session = new KnowledgeQuerySession(w.withRequirement(() => ({ requirementId: prodId, workspaceId: w.service.workspace.workspaceId, branch: w.service.workspace.branch,
    lifecycle, approvedProdHash: sha("approved"), lifecycleEpoch: 1 }), {
    async assertCurrent(origin) { await w.adapter.assertCurrent(origin); lifecycle = "closed"; },
  }));
  await expect(session.query({ action: "facts", pageSize: 1 })).rejects.toMatchObject({ code: "stale" });
  expect(session.diagnostics.sessions).toBe(0); session.close();
});

test.each(["file", "observation", "closing", "authority"])("联合返回门槛拒绝合法I/O等待中的%s变化", async (change) => {
  const w = await fixture();
  let value: KnowledgeRequirementMetadata | null = change === "closing" ? { requirementId: prodId,
    workspaceId: w.service.workspace.workspaceId, branch: w.service.workspace.branch, lifecycle: "active",
    approvedProdHash: sha("approved"), lifecycleEpoch: 1 } : null;
  expect(() => new KnowledgeQuerySession({ ...w.adapter, async requirementMetadata() { return null; } })).toThrowError(expect.objectContaining({ code: "unavailable" }));
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const adapter = w.withRequirement(() => value, {
    async readMetadata() {
      if (++calls === 2 && change !== "closing") { enter(); await paused; }
      return value;
    },
    async assertCurrent(origin) {
      if (change === "closing") { enter(); await paused; }
      await w.adapter.assertCurrent(origin);
    },
  });
  const session = new KnowledgeQuerySession(adapter);
  const outcome = session.query({ action: "search", text: "角色跳跃" }).then(() => "returned", () => "rejected");
  await entered;
  if (change === "file") await put(w.repo.root, "src/动作😀.ts", "// actual changed bytes\n");
  if (change === "observation") w.observe();
  if (change === "authority") w.revoke();
  if (change === "closing") value = { ...value!, lifecycle: "closing", lifecycleEpoch: 2 };
  release();
  expect(await outcome).toBe("rejected");
  expect(calls).toBe(2); expect(session.diagnostics.sessions).toBe(0); session.close();
});

test("真实131072码点边界中文/emoji/CRLF命中一次，不能依据哈希ID或同startLine拼片", async () => {
  const w = await fixture();
  const queries = ["角色跳跃", "边界😀起跳", "跨界落地"];
  // 第三份把CRLF放在匹配前，验证真实行号。
  const paths: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    const prefix = i === 2 ? "// first😀\r\n// " : "// ";
    const query = queries[i]!;
    const body = prefix + "😀".repeat(131072 - Array.from(prefix).length - 2) + query + "\r\n";
    const path = `src/boundary-${i}.ts`; paths.push(path);
    await put(w.repo.root, path, body);
  }
  expect((await w.refresh()).status).toBe("ready");
  const current = await w.service.readCurrentForQuery({ paths });
  expect(current.snapshot!.sourceFragments).toHaveLength(6);
  w.scope(paths);
  const session = new KnowledgeQuerySession({ ...w.adapter, async readCurrent(paths, bodies) {
    const view = await w.adapter.readCurrent(paths, bodies); view.snapshot!.sourceFragments.reverse(); return view;
  } });
  for (let i = 0; i < paths.length; i++) {
    const query = queries[i]!;
    expect(current.snapshot!.sourceFragments.filter((f) => f.path === paths[i]).every((f) => !f.body.includes(query))).toBe(true);
    const result = await session.query({ action: "search", text: query });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ kind: "source", complete: false, source: { path: paths[i], startLine: i === 2 ? 2 : 1 } });
    const body = (result.facts[0]!.data as { body: string }).body;
    expect(body).toContain(query); expect(body).not.toContain("\ufffd");
    expect(result.coverage).toMatchObject({ matched: 1, omitted: 0, remaining: 0, sourceExcerptsTruncated: 1, complete: false });
    expect(result.limitations.unindexedFiles).toBe(0);
  }
  session.close();
  const missingView = new KnowledgeQuerySession({ ...w.adapter, async readCurrent(paths) {
    const view = await w.adapter.readCurrent(paths); delete view.sourceFiles; return view;
  } });
  await expect(missingView.query({ action: "search", text: queries[0] })).rejects.toMatchObject({ code: "unavailable" }); missingView.close();
});

test("32个长中文/转义文件按最终JSON整包48KiB分页，限制字段无损", async () => {
  const w = await fixture();
  const expected = "中".repeat(1150) + '\\"\n\t😀'.repeat(10);
  for (let i = 0; i < 32; i++) await put(w.repo.root, `docs/bulk-${i}.json`, JSON.stringify({ title: "批量", expected }));
  await w.refresh();
  expect(KNOWLEDGE_QUERY_LIMITS.pageBytes).toBe(49152);
  for (const variant of KnowledgeQuerySchema.oneOf) expect(variant.properties.maxBytes.maximum).toBe(49152);
  for (const maxBytes of [49153, 65536]) expect(() => parseKnowledgeQuery({ action: "facts", maxBytes })).toThrow();
  const session = new KnowledgeQuerySession(w.adapter);
  const pages = await all(session, { action: "search", text: "批量", pageSize: 20, maxBytes: 49152 });
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) {
    const json = JSON.stringify(page);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(49152); expect(JSON.parse(json)).toEqual(page);
    expect(page.limitations).toMatchObject({ diagnosticCounts: {}, formalVerification: "not_available", performanceImprovement: "unknown", scope: "caller_allowed_files_only" });
    expect(page.coverage.omitted).toBe(0);
    expect(page).toHaveProperty("nextCursor");
  }
  const sources = pages.flatMap((page) => page.facts).filter((fact) => fact.kind === "source" && fact.source.path.startsWith("docs/bulk-"));
  expect(new Set(sources.map((fact) => fact.source.path)).size).toBe(32);
  expect(pages.at(-1)!.nextCursor).toBeNull(); expect(pages.at(-1)!.coverage.remaining).toBe(0); session.close();
});

test("范围过滤在SQLite提供正文之前完成，不读取其他worktree/prod_metadata/未授权路径正文", async () => {
  const w = await fixture();
  const foreign = await addWorktree(w.repo);
  await put(foreign.root, "other.ts", "export const OTHER_WORKTREE_BODY = '角色跳跃';");
  const other = await ProjectIndexService.open({ repositoryRoot: foreign.root, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true });
  await other.init();
  w.scope(["src/动作😀.ts"]);
  const outputRows: string[] = [], statements: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    statements.push(sql); const statement = prepare.call(this, sql), all = statement.all.bind(statement);
    statement.all = (...args) => { const rows = all(...args); outputRows.push(JSON.stringify(rows)); return rows; };
    return statement;
  });
  const session = new KnowledgeQuerySession(w.adapter);
  const result = await session.query({ action: "facts", pageSize: 20 });
  expect(result.facts.every((item) => item.source.path === "src/动作😀.ts")).toBe(true);
  expect(outputRows.join("")).not.toMatch(/OTHER_WORKTREE_BODY|没有关系|超级角色跳跃规则|PROD_NEVER_RETURN/);
  expect(statements.some((sql) => /prod_metadata|source_fragments_fts|INSERT|UPDATE|CREATE TABLE/.test(sql))).toBe(false);
  session.close();
});

test("只读接缝不创建/初始化空库，链接/硬链接/越界/默认未授权拒绝", async () => {
  const repo = await createRepoFixture(); repositories.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "knowledge-empty-")); roots.push(dataRoot);
  const { repoId } = await repositoryIdentity(repo.root);
  const service = await ProjectIndexService.open({ repositoryRoot: repo.root, dataRoot, repoId, authorize: () => true });
  await expect(service.readCurrentForQuery({ paths: ["README.md"] })).rejects.toBeDefined();
  await expect(stat(indexDatabase(dataRoot, repoId))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.readCurrentForQuery({} as never)).rejects.toMatchObject({ code: "authorization_denied" });
  const w = await fixture();
  const before = await readFile(indexDatabase(w.dataRoot, w.repoId));
  await w.service.readCurrentForQuery({ paths: ["src/same.ts"] });
  expect(await readFile(indexDatabase(w.dataRoot, w.repoId))).toEqual(before);
  for (const path of ["docs/prod/x.md", ".env", "../outside", ".pi/sessions/x.md"]) await expect(w.service.readCurrentForQuery({ paths: [path] })).rejects.toMatchObject({ code: "authorization_denied" });
  await rm(join(w.repo.root, "src/same.ts"));
  await symlink(join(w.repo.root, "src/动作😀.ts"), join(w.repo.root, "src/same.ts"));
  await expect(w.service.readCurrentForQuery({ paths: ["src/same.ts"] })).rejects.toMatchObject({ code: "unstable" });
  await rm(join(w.repo.root, "src/same.ts")); await link(join(w.repo.root, "src/动作😀.ts"), join(w.repo.root, "src/same.ts"));
  await expect(w.service.readCurrentForQuery({ paths: ["src/动作😀.ts"] })).rejects.toMatchObject({ code: "unstable" });
});

test("查询只对命中的文件读磁盘正文；readCurrentForQuery 按 bodies 子集返回已核对正文", async () => {
  const w = await fixture();
  const calls: Array<readonly string[]> = [];
  const session = new KnowledgeQuerySession({ ...w.adapter, readCurrent: (paths, bodies) => { calls.push([...bodies]); return w.adapter.readCurrent(paths, bodies); } });
  const page = await session.query({ action: "exact", by: "path", value: "src/same.ts" });
  expect(page.facts.some((fact) => fact.kind === "source" && fact.source.path === "src/same.ts")).toBe(true);
  expect(calls).toEqual([[], ["src/same.ts"]]);
  const entity = (await session.query({ action: "facts", text: "same" })).facts.find((fact) => fact.kind === "file" && fact.source.path !== "src/same.ts");
  if (entity) expect(entity.source.rangeKind).toBe("file");
  session.close();
  const paths = ["src/same.ts", "src/动作😀.ts"];
  const none = await w.service.readCurrentForQuery({ paths, bodies: [] });
  expect(none.sourceFiles).toEqual([]);
  const one = await w.service.readCurrentForQuery({ paths, bodies: ["src/动作😀.ts"] });
  expect(one.sourceFiles?.map((file) => file.path)).toEqual(["src/动作😀.ts"]);
  await expect(w.service.readCurrentForQuery({ paths, bodies: ["README.md"] })).rejects.toMatchObject({ code: "authorization_denied" });
});

test("同代次build与baseline的代次或hash不对应时拒绝", async () => {
  const w = await fixture();
  const session = new KnowledgeQuerySession({ ...w.adapter, async captureFresh() { const capture = await w.capture(); capture.build.generation++; return capture; } });
  await expect(session.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); session.close();
  const wrong = new KnowledgeQuerySession({ ...w.adapter, async captureFresh() { const capture = await w.capture(); capture.build.baselineHash = sha("wrong"); return capture; } });
  await expect(wrong.query({ action: "facts" })).rejects.toMatchObject({ code: "unavailable" }); wrong.close();
});

test("大量匹配只缓存固定500项，其余计入遗漏而不是假报全覆盖", async () => {
  const w = await fixture();
  await put(w.repo.root, "src/many.ts", Array.from({ length: 600 }, (_, index) => `function value${index}() { return ${index}; }`).join("\n"));
  await w.refresh();
  const session = new KnowledgeQuerySession(w.adapter);
  const page = await session.query({ action: "facts", pageSize: 1 });
  expect(page.coverage.matched).toBeGreaterThan(600);
  expect(page.coverage.omitted).toBeGreaterThan(100);
  expect(page.coverage.remaining).toBe(499); expect(page.coverage.complete).toBe(false);
  expect(session.diagnostics.bytes).toBeLessThanOrEqual(2 * 1024 * 1024); session.close();
});

test("最小输出预算仍保留所有阻塞类别/未覆盖统计，缓存条数与TTL有界", async () => {
  const w = await fixture();
  const store = new IndexStore(indexDatabase(w.dataRoot, w.repoId), w.service.workspace);
  const original = store.getSnapshot();
  const publication = { ...original, status: "partial" as const, diagnostics: [
    ...Array.from({ length: 40 }, () => ({ code: "budget_exceeded" as const, path: null })), { code: "unknown" as const, path: null },
  ] };
  const { workspaceId: _w, repoId: _r, root: _root, branch: _b, generation: _g, ...payload } = publication;
  store.publish(store.begin(), payload, w.build.baselineHash!);
  store.close();
  const baseCapture = w.capture;
  let now = 100;
  const adapter = { ...w.adapter, async captureFresh() { const capture = await baseCapture(); capture.baseline = { ...capture.baseline, generation: 2 }; capture.build.generation = 2; return capture; },
    async assertCurrent() { /* 本用例验证分页预算；真实文件核对另有专用用例。 */ } };
  const session = new KnowledgeQuerySession(adapter, { now: () => now });
  const result = await session.query({ action: "facts", maxBytes: 4096, pageSize: 1 });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  expect(result.limitations.diagnosticCounts).toEqual({ budget_exceeded: 40, unknown: 1 });
  expect(result.limitations.diagnosticDetailsOmitted).toBe(33); expect(result.coverage.complete).toBe(false);
  for (let i = 1; i < 8; i++) await session.query({ action: "facts", pageSize: 1 });
  const ninth = await session.query({ action: "facts", pageSize: 1 });
  expect(ninth.nextCursor).toBeTruthy();
  expect(session.diagnostics.sessions).toBe(8); expect(session.diagnostics.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  await expect(session.query({ action: "facts", pageSize: 1, maxBytes: 4096, cursor: result.nextCursor })).rejects.toMatchObject({ code: "invalid_cursor" });
  now += 30001;
  await expect(session.query({ action: "facts", pageSize: 1, maxBytes: 4096, cursor: result.nextCursor })).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(session.diagnostics.sessions).toBe(0); session.close();
});
