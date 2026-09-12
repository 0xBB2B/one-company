import { afterEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncTransactionError, LocalDatabase } from "../runtime/database.ts";
import { createDatabaseSnapshot, withDatabaseMaintenance } from "../runtime/database-maintenance.ts";
import { IndexStore, IndexStoreError } from "../runtime/index-store.ts";
import type { IndexPublication, SourceFragment, WorkspaceIdentity } from "../runtime/index-store.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const hash = (digit: string) => digit.repeat(64);
async function fixture() {
  const root = await mkdtemp(join(temporaryRoot(), "index-store-")); roots.push(root);
  const directory = join(root, "private"), workspaceA = join(root, "workspace-a"), workspaceB = join(root, "workspace-b");
  await mkdir(directory, { mode: 0o700 }); await mkdir(workspaceA, { mode: 0o700 }); await mkdir(workspaceB, { mode: 0o700 });
  const identity = (workspaceId: string, workspaceRoot: string, branch: string): WorkspaceIdentity => ({ workspaceId, repoId: hash("f"), root: workspaceRoot, branch });
  return { root, directory, databasePath: join(directory, "index.db"), workspaceA, workspaceB, identity };
}

function codePublication(path: string, word: string, fileHash = hash("a"), status: "ready" | "partial" = "ready"): IndexPublication {
  const symbolId = `${path}#main`, fragmentId = `${path}#fragment`;
  return {
    status,
    diagnostics: status === "partial" ? [{ code: "syntax_error", path }] : [],
    files: [{ path, hash: fileHash, parserVersion: "tree-sitter-typescript@fixture", status: status === "partial" ? "parse_error" : "indexed", kind: "code", language: "typescript", symbolIds: [symbolId] }],
    symbols: [{ id: symbolId, path, name: "main", kind: "function", startLine: 1, startColumn: 0, endLine: 1, endColumn: 20 }],
    codeEdges: [], features: [], rules: [], ruleEdges: [],
    sourceFragments: [{ id: fragmentId, path, kind: "code", language: "typescript", title: "main", body: `export function main() { return '${word}' }`, startLine: 1, endLine: 1, fileHash }],
    prodMetadata: [],
  };
}

function specPublication(word: string): IndexPublication {
  const path = "docs/spec/player/jump.rules.json", fileHash = hash("b");
  return {
    status: "ready", diagnostics: [],
    files: [{ path, hash: fileHash, parserVersion: "spec-schema@1", status: "indexed", kind: "spec", language: "json", symbolIds: [] }],
    symbols: [], codeEdges: [],
    features: [{ id: "player.jump", path, title: "跳跃", aliases: ["起跳"], contractHash: hash("c") }],
    rules: [{ id: "player.jump.once", featureId: "player.jump", path, title: "一次跳跃", condition: "角色在地面", trigger: "收到起跳输入", expected: word, reason: "避免重复起跳", dependsOn: [], exceptions: [], acceptance: [{ id: "jump-once", given: "角色在地面", when: "触发起跳", then: "只起跳一次" }], contractHash: hash("d"), codePointCount: 40 }],
    ruleEdges: [],
    sourceFragments: [{ id: "player.jump.once#source", path, kind: "spec", language: "json", title: "一次跳跃", body: word, startLine: 1, endLine: 12, fileHash }],
    prodMetadata: [],
  };
}

function emptyPublication(status: "ready" | "partial" | "invalid" = "ready"): IndexPublication {
  return { status, diagnostics: status === "invalid" ? [{ code: "invalid_spec", path: "docs/spec/broken.json" }] : [], files: [], symbols: [], codeEdges: [], features: [], rules: [], ruleEdges: [], sourceFragments: [], prodMetadata: [] };
}

test("按worktree隔离持久当前代次，FTS更新和删除会清除旧词", async () => {
  const w = await fixture();
  const aIdentity = w.identity(hash("1"), w.workspaceA, "refs/heads/a"), bIdentity = w.identity(hash("2"), w.workspaceB, "refs/heads/b");
  const a = new IndexStore(w.databasePath, aIdentity, { now: () => 10 });
  expect(() => a.status()).toThrowError(expect.objectContaining({ code: "no_index" }));
  const first = a.begin(0); expect(a.status()).toMatchObject({ status: "building", currentGeneration: 0, targetGeneration: 1 });
  a.publish(first, codePublication("src/a.ts", "alpha_unique"));
  expect(a.search("alpha_unique").results).toMatchObject([{ path: "src/a.ts", kind: "code" }]);
  a.close();

  const reopened = new IndexStore(w.databasePath, aIdentity);
  expect(reopened.getSnapshot()).toMatchObject({ generation: 1, files: [{ path: "src/a.ts", parserVersion: "tree-sitter-typescript@fixture" }] });
  const b = new IndexStore(w.databasePath, bIdentity);
  b.publish(b.begin(0), codePublication("src/b.ts", "bravo_unique", hash("e")));
  expect(b.search("bravo_unique").results).toHaveLength(1);
  expect(b.search("alpha_unique").results).toEqual([]);

  const update = reopened.begin(reopened.status().version);
  reopened.publish(update, codePublication("src/a.ts", "charlie_unique"));
  expect(reopened.search("alpha_unique").results).toEqual([]);
  expect(reopened.search("charlie_unique").results).toHaveLength(1);
  expect(b.search("bravo_unique").results).toHaveLength(1);

  const remove = reopened.begin(reopened.status().version);
  reopened.publish(remove, emptyPublication());
  expect(reopened.search("charlie_unique").results).toEqual([]);
  expect(reopened.getSnapshot().sourceFragments).toEqual([]);
  b.close(); reopened.close();
});

test("invalid spec发布删除旧规则正文并拒绝返回未核对current", async () => {
  const w = await fixture(), identity = w.identity(hash("3"), w.workspaceA, "refs/heads/spec");
  const store = new IndexStore(w.databasePath, identity);
  store.publish(store.begin(), specPublication("legacy_rule_secret"));
  expect(store.search("legacy_rule_secret").results).toHaveLength(1);

  const build = store.begin(store.status().version);
  const invalid = emptyPublication("invalid");
  invalid.files.push({ path: "docs/spec/broken.json", hash: hash("9"), parserVersion: "spec-schema@1", status: "invalid", kind: "spec", language: "json", symbolIds: [] });
  const state = store.publish(build, invalid);
  expect(state.status).toBe("invalid");
  expect(() => store.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
  expect(() => store.search("legacy_rule_secret")).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
  store.close();

  const raw = new LocalDatabase(w.databasePath);
  try {
    expect(raw.list<Record<string, unknown>>("rules_current").filter((row) => row.data.workspaceId === identity.workspaceId)).toEqual([]);
    expect(raw.list<Record<string, unknown>>("source_fragments").filter((row) => row.data.workspaceId === identity.workspaceId)).toEqual([]);
  } finally { raw.close(); }
});

test("取消、中断和发布事务回滚后可恢复，且不会产生重复节点", async () => {
  const w = await fixture(), identity = w.identity(hash("4"), w.workspaceA, "refs/heads/recovery");
  const store = new IndexStore(w.databasePath, identity);
  store.publish(store.begin(), codePublication("src/recovery.ts", "baseline_word"));
  const cancelled = store.begin(store.status().version);
  expect(store.cancel(cancelled).status).toBe("cancelled");
  expect(() => store.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
  store.close();

  const recovered = new IndexStore(w.databasePath, identity);
  expect(recovered.status().status).toBe("cancelled");
  const failedBuild = recovered.begin(recovered.status().version);
  const originalPrepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO records")) {
      const run = statement.run.bind(statement);
      statement.run = (...params: Parameters<typeof run>) => {
        if (params[1] === "symbols") throw new Error("injected publish failure");
        return run(...params);
      };
    }
    return statement;
  });
  expect(() => recovered.publish(failedBuild, codePublication("src/recovery.ts", "failed_word"))).toThrow("injected publish failure");
  vi.restoreAllMocks();
  expect(recovered.status().status).toBe("building");
  expect(() => recovered.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
  expect(recovered.interrupt(failedBuild).status).toBe("interrupted");

  const finalBuild = recovered.begin(recovered.status().version);
  recovered.publish(finalBuild, codePublication("src/recovery.ts", "recovered_word"));
  const snapshot = recovered.getSnapshot();
  expect(snapshot.files).toHaveLength(1); expect(snapshot.symbols).toHaveLength(1); expect(snapshot.sourceFragments).toHaveLength(1);
  expect(recovered.search("baseline_word").results).toEqual([]);
  expect(recovered.search("failed_word").results).toEqual([]);
  expect(recovered.search("recovered_word").results).toHaveLength(1);
  recovered.close();
});

test("发布事务中途强杀不会留下半份current，重启可用新fence恢复", async () => {
  const w = await fixture(), identity = w.identity(hash("d"), w.workspaceA, "refs/heads/kill-recovery");
  const initial = new IndexStore(w.databasePath, identity);
  initial.publish(initial.begin(), codePublication("src/kill.ts", "before_kill_word")); initial.close();
  const script = join(w.root, "kill-publish.mjs"), moduleUrl = new URL("../runtime/index-store.ts", import.meta.url).href;
  await writeFile(script, `
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { IndexStore } from ${JSON.stringify(moduleUrl)};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (sql.startsWith("INSERT INTO records")) {
    const run = statement.run.bind(statement);
    statement.run = (...params) => {
      if (params[1] === "symbols") {
        writeSync(1, "IN_TRANSACTION\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return run(...params);
    };
  }
  return statement;
};
const store = new IndexStore(${JSON.stringify(w.databasePath)}, ${JSON.stringify(identity)});
const build = store.begin(store.status().version);
store.publish(build, ${JSON.stringify(codePublication("src/kill.ts", "during_kill_word"))});
`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data.toString(); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("子进程未进入发布事务")), 5_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`子进程提前退出: ${stderr}`)); });
      child.stdout.once("data", (data) => { clearTimeout(timer); data.toString().includes("IN_TRANSACTION") ? resolve() : reject(new Error("未观察到发布事务")); });
    });
    child.kill("SIGKILL"); await closed;
  } finally { child.kill("SIGKILL"); await closed; }

  const recovered = new IndexStore(w.databasePath, identity);
  expect(recovered.status().status).toBe("building");
  expect(() => recovered.getSnapshot()).toThrowError(expect.objectContaining({ code: "index_not_ready" }));
  const replacement = recovered.begin(recovered.status().version);
  recovered.publish(replacement, codePublication("src/kill.ts", "after_kill_word"));
  expect(recovered.search("before_kill_word").results).toEqual([]);
  expect(recovered.search("during_kill_word").results).toEqual([]);
  expect(recovered.search("after_kill_word").results).toHaveLength(1);
  expect(recovered.getSnapshot().files).toHaveLength(1);
  recovered.close();
});

test("空caller、UTF-16符号偏移和完整引用位置依据可持久化", async () => {
  const w = await fixture(), identity = w.identity(hash("e"), w.workspaceA, "refs/heads/edge-evidence");
  const store = new IndexStore(w.databasePath, identity), build = store.begin();
  const publication = codePublication("src/edge.ts", "edge_word");
  publication.symbols[0] = { ...publication.symbols[0]!, startOffset: 0, endOffset: 20 };
  publication.codeEdges.push({
    id: "edge:top-level", fromSymbolId: null, toSymbolId: publication.symbols[0]!.id, kind: "calls", certainty: "certain",
    name: "main", evidence: "call_expression", path: "src/edge.ts", startLine: 2, startColumn: 0, endLine: 2, endColumn: 6,
  });
  store.publish(build, publication);
  expect(store.getSnapshot()).toMatchObject({
    symbols: [{ startLine: 1, startOffset: 0, endOffset: 20 }],
    codeEdges: [{ fromSymbolId: null, certainty: "certain", evidence: "call_expression", path: "src/edge.ts", startLine: 2, endColumn: 6 }],
  });

  const invalidBuild = store.begin(store.status().version), unresolved = codePublication("src/edge.ts", "unknown_edge_word");
  unresolved.codeEdges.push({ id: "edge:unknown", fromSymbolId: null, toSymbolId: null, kind: "calls", certainty: "certain" });
  expect(() => store.publish(invalidBuild, unresolved)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  unresolved.codeEdges[0] = { id: "edge:partial", fromSymbolId: null, toSymbolId: unresolved.symbols[0]!.id, kind: "calls", certainty: "certain", name: "main", evidence: "call_expression", path: "src/edge.ts", startLine: 2, startColumn: 0, endLine: 2 } as never;
  expect(() => store.publish(invalidBuild, unresolved)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  store.cancel(invalidBuild); store.close();
});

test("后发构建提高fence，旧构建不能偷覆盖", async () => {
  const w = await fixture(), identity = w.identity(hash("5"), w.workspaceA, "refs/heads/fence");
  const firstClient = new IndexStore(w.databasePath, identity), secondClient = new IndexStore(w.databasePath, identity);
  const oldBuild = firstClient.begin(), newBuild = secondClient.begin();
  expect(newBuild.fence).toBe(oldBuild.fence + 1);
  expect(() => firstClient.publish(oldBuild, codePublication("src/old.ts", "old_fence_word"))).toThrowError(expect.objectContaining({ code: "stale_build" }));
  secondClient.publish(newBuild, codePublication("src/new.ts", "new_fence_word"));
  expect(firstClient.search("old_fence_word").results).toEqual([]);
  expect(firstClient.search("new_fence_word").results).toHaveLength(1);
  firstClient.close(); secondClient.close();
});

test("archive只保存未知风险线索，同UUID多路径保留且普通索引大小写保守排除", async () => {
  const w = await fixture(), identity = w.identity(hash("6"), w.workspaceA, "refs/heads/policy");
  for (const name of ["data.db", "global.db", "other.db"]) expect(() => new IndexStore(join(w.directory, name), identity)).toThrowError(expect.objectContaining({ code: "wrong_database_kind" }));
  expect(() => new IndexStore(join(w.workspaceA, "index.db"), identity)).toThrowError(expect.objectContaining({ code: "invalid_identity" }));

  const store = new IndexStore(w.databasePath, identity), build = store.begin();
  const requirementId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  const withBody = emptyPublication();
  withBody.prodMetadata.push({ requirementId, source: "local", path: `requirements/${requirementId}/prod.md`, fileName: "prod.md", lifecycle: "active", epoch: 1, hash: hash("a"), prodBody: "forbidden" } as never);
  expect(() => store.publish(build, withBody)).toThrowError(expect.objectContaining({ code: "metadata_body_forbidden" }));

  const claimedArchive = emptyPublication();
  claimedArchive.prodMetadata.push({ requirementId, source: "archive", path: `docs/prod/${requirementId}.伪完成.md`, fileName: `${requirementId}.伪完成.md`, lifecycle: "closed", epoch: 2, hash: hash("b") } as never);
  expect(() => store.publish(build, claimedArchive)).toThrowError(expect.objectContaining({ code: "metadata_body_forbidden" }));

  const metadata = emptyPublication();
  metadata.prodMetadata.push(
    { requirementId, source: "local", path: `requirements/${requirementId}/prod.md`, fileName: "prod.md", lifecycle: "active", epoch: 3, hash: hash("a") },
    { requirementId, source: "archive", path: `Docs/Prod/${requirementId}.完成一.md`, fileName: `${requirementId}.完成一.md`, lifecycle: "unknown", epoch: null, hash: null },
    { requirementId, source: "archive", path: `DOCS/PROD/${requirementId}.完成二.md`, fileName: `${requirementId}.完成二.md`, lifecycle: "unknown", epoch: null, hash: null },
  );
  store.publish(build, metadata);
  const storedMetadata = store.getSnapshot().prodMetadata;
  expect(storedMetadata).toHaveLength(3);
  expect(storedMetadata).toEqual(expect.arrayContaining(metadata.prodMetadata));
  expect(storedMetadata.filter((item) => item.source === "archive")).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `Docs/Prod/${requirementId}.完成一.md`, lifecycle: "unknown", epoch: null, hash: null }),
    expect.objectContaining({ path: `DOCS/PROD/${requirementId}.完成二.md`, lifecycle: "unknown", epoch: null, hash: null }),
  ]));

  const badPathBuild = store.begin(store.status().version), badPath = codePublication("Docs/Prod/closed.md", "must_not_index");
  expect(() => store.publish(badPathBuild, badPath)).toThrowError(expect.objectContaining({ code: "invalid_path" }));
  const dotGit = codePublication("src/.GIT/config", "must_not_index");
  expect(() => store.publish(badPathBuild, dotGit)).toThrowError(expect.objectContaining({ code: "invalid_path" }));
  store.cancel(badPathBuild); store.close();
});

test("FTS参数、条数、截断和错误输出固定，非法语法不泄露SQLite细节", async () => {
  const w = await fixture(), identity = w.identity(hash("7"), w.workspaceA, "refs/heads/search");
  const store = new IndexStore(w.databasePath, identity);
  const first = codePublication("src/search-a.ts", "searchable_token"), second = codePublication("src/search-b.ts", "searchable_token", hash("b"));
  first.files.push(...second.files); first.symbols.push(...second.symbols); first.sourceFragments.push(...second.sourceFragments);
  store.publish(store.begin(), first);
  expect(store.search("searchable_token", 1)).toMatchObject({ results: [{ kind: "code" }], truncated: true });
  expect(store.search("searchable_token", 2)).toMatchObject({ results: [{ kind: "code" }, { kind: "code" }], truncated: false });
  for (const query of ["", "\u0000", '"unterminated']) {
    let error: unknown;
    try { store.search(query); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(IndexStoreError);
    expect((error as IndexStoreError).code).toBe("invalid_fts_query");
    expect((error as Error).message).toBe("索引搜索语法无效");
    expect((error as Error).message).not.toMatch(/sqlite|fts5|unterminated/i);
  }
  expect(() => store.search("searchable_token", 21)).toThrowError(expect.objectContaining({ code: "invalid_fts_query" }));
  store.close();
});

test("已有user_version 1索引库会登记专属schema并回填合法source_fragments", async () => {
  const w = await fixture(), identity = w.identity(hash("c"), w.workspaceA, "refs/heads/schema-upgrade");
  const initial = new IndexStore(w.databasePath, identity);
  initial.publish(initial.begin(), codePublication("src/upgrade.ts", "upgrade_backfill_token")); initial.close();
  const oldLayout = new DatabaseSync(w.databasePath, { allowExtension: false });
  try {
    oldLayout.exec(`
      DROP TRIGGER source_fragments_fts_delete;
      DROP TRIGGER source_fragments_fts_update;
      DROP TRIGGER source_fragments_fts_insert;
      DROP TRIGGER source_fragments_validate_update;
      DROP TRIGGER source_fragments_validate_insert;
      DROP TABLE source_fragments_fts;
      DROP TABLE index_schema_metadata;
    `);
    expect(oldLayout.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  } finally { oldLayout.close(); }
  const upgraded = new IndexStore(w.databasePath, identity);
  expect(upgraded.search("upgrade_backfill_token").results).toHaveLength(1);
  upgraded.close();
});

test("source_fragments与FTS随同步事务一起回滚，异步违规连接仍失效", async () => {
  const w = await fixture();
  const db = new LocalDatabase(w.databasePath);
  const fragment: SourceFragment & { workspaceId: string; generation: number } = {
    workspaceId: hash("8"), generation: 1, id: "fragment", path: "src/tx.ts", kind: "code", language: "typescript", title: null,
    body: "transaction_secret", startLine: 1, endLine: 1, fileHash: hash("a"),
  };
  expect(() => db.create("source_fragments", "case-prod", { ...fragment, path: "Docs/Prod/closed.md" })).toThrow(/invalid source fragment/);
  expect(() => db.create("source_fragments", "case-git", { ...fragment, path: "src/.GIT/config" })).toThrow(/invalid source fragment/);
  expect(() => db.transaction(() => {
    db.create("source_fragments", "tx", fragment);
    throw new Error("rollback fixture");
  })).toThrow("rollback fixture");
  expect(db.list("source_fragments")).toEqual([]);
  expect(() => (db.transaction.bind(db) as (fn: () => unknown) => unknown)(async () => {
    db.create("source_fragments", "async", fragment);
  })).toThrow(AsyncTransactionError);
  expect(() => db.list("source_fragments")).toThrow(/连接已关闭或失效/);
  db.close();
  const other = new LocalDatabase(w.databasePath);
  try { expect(other.list("source_fragments")).toEqual([]); } finally { other.close(); }
});

test("含FTS专属schema的index.db可做一致快照，仍保持user_version 1", async () => {
  const w = await fixture(), identity = w.identity(hash("9"), w.workspaceA, "refs/heads/backup");
  const store = new IndexStore(w.databasePath, identity);
  store.publish(store.begin(), codePublication("src/backup.ts", "backup_token")); store.close();
  const receipt = await withDatabaseMaintenance({ directory: w.directory, worktreeRoots: [w.workspaceA] }, (permit) => createDatabaseSnapshot(permit, "index"));
  const snapshot = new DatabaseSync(receipt.snapshotPath, { readOnly: true, allowExtension: false });
  try {
    expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(snapshot.prepare("SELECT schema_version FROM index_schema_metadata WHERE schema_key='current'").get()?.schema_version).toBe(1);
    expect(snapshot.prepare("SELECT count(*) AS n FROM source_fragments_fts WHERE source_fragments_fts MATCH ?").get("backup_token")?.n).toBe(1);
  } finally { snapshot.close(); }
});
