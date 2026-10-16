import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const [productRoot, fixturePath, expectedCode = "valid", language = "js"] = process.argv.slice(2);
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("测试禁止联网"); };
// 使用宿主同类的 TypeScript 加载器；被测模块和解析资源必须来自安装产物。
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: true, tryNative: false });
const { withSyntaxTree } = await jiti.import(join(productRoot, "src/modules/project-index/syntax-parser.ts"));
const cases = JSON.parse(await readFile(fixturePath, "utf8"));
let count = 0;
if (expectedCode === "valid") {
  for (const fixture of cases) {
    await withSyntaxTree(fixture.language, fixture.source, (tree) => {
      assert.equal(tree.rootNode.hasError, false);
      const nodes = tree.rootNode.descendantsOfType(fixture.nodeType);
      assert.equal(nodes.length, 1);
      if (fixture.name) assert.equal(nodes[0].childForFieldName("name").text, fixture.name);
      if (fixture.text) assert.equal(nodes[0].text, fixture.text);
      assert.equal(fixture.source.slice(nodes[0].startIndex, nodes[0].endIndex), nodes[0].text);
    });
    count++;
  }
  await assert.rejects(withSyntaxTree("python", "", () => null), { code: "unsupported_language" });
  const { LocalDatabase, databaseFile, uuidv7 } = await jiti.import(join(productRoot, "src/core/storage/database.ts"));
  const { parseDecisionBatch } = await jiti.import(join(productRoot, "src/modules/requirement/short-decision-format.ts"));
  const decision = { operationId: uuidv7(), requirementId: uuidv7(), version: 1, epoch: 1, prod: null,
    decisions: [{ conclusion: "😀".repeat(400), scope: "只分析", references: ["G-1"], supersedes: [] }] };
  assert.equal(parseDecisionBatch(JSON.stringify(decision)).decisions[0].conclusion, decision.decisions[0].conclusion);
  assert.throws(() => parseDecisionBatch(JSON.stringify({ ...decision, actor: "user" })), /invalid_shape/);
  decision.decisions[0].conclusion += "中";
  assert.throws(() => parseDecisionBatch(JSON.stringify(decision)), /text_limit/);
  const { withDatabaseMaintenance, createDatabaseSnapshot } = await jiti.import(join(productRoot, "src/core/storage/database-maintenance.ts"));
  const storage = await mkdtemp(join(tmpdir(), "installed-storage-"));
  try {
    const { RequirementStateStore } = await jiti.import(join(productRoot, "src/modules/requirement/requirement-state.ts"));
    await assert.rejects(RequirementStateStore.open({ dataRoot: storage, repoId: "a".repeat(64), repositoryRoot: storage }), /authorization_required/);
    const { ShortDecisionStore } = await jiti.import(join(productRoot, "src/modules/requirement/short-decisions.ts"));
    await assert.rejects(ShortDecisionStore.open({ dataRoot: storage, repoId: "a".repeat(64), repositoryRoot: storage }), /authorization_required/);
    const path = databaseFile(storage, "data");
    const database = new LocalDatabase(path);
    database.create("fixture", "retained", { value: 42 }); database.close();
    const snapshot = await withDatabaseMaintenance({ directory: storage, worktreeRoots: [] }, (permit) => createDatabaseSnapshot(permit, "data"));
    assert.equal(snapshot.executable, false); assert.equal(snapshot.restoreStatus, "needs_review");
    assert.throws(() => new LocalDatabase(snapshot.snapshotPath), /snapshot_only/);
    const index = new LocalDatabase(databaseFile(storage, "index"));
    try { assert.throws(() => index.create("tasks", "forbidden", {}), /wrong_database_kind/); } finally { index.close(); }
  } finally { await rm(storage, { recursive: true, force: true }); }
} else if (expectedCode === "warm-invalid") {
  await withSyntaxTree("js", "let a = 1;", () => null);
  const path = join(productRoot, "resources/tree-sitter/tree-sitter-javascript.wasm");
  const bytes = await readFile(path);
  try {
    await writeFile(path, Buffer.from("damaged"));
    await assert.rejects(withSyntaxTree("js", "let a = 2;", () => null), { code: "resource_invalid" });
  } finally { await writeFile(path, bytes); }
} else {
  await assert.rejects(withSyntaxTree(language, "", () => null), (error) => {
    assert.equal(error.code, expectedCode);
    assert.match(error.message, /不会自动下载或编译资源/);
    return true;
  });
}
assert.equal(networkAttempts, 0);
console.log(JSON.stringify({ status: "PASS", mode: expectedCode, count, networkAttempts, cwd: process.cwd(), runtime: `Node ${process.versions.node}`, executable: process.execPath }));
