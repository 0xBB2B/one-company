import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { KnowledgeToolSchema, createKnowledgeQueryTool, knowledgeToolResult, parseKnowledgeTransportQuery } from "../src/modules/project-index/knowledge-query-tool.ts";
import { knowledgeView } from "../src/modules/project-index/knowledge-query.ts";
import type { KnowledgeFactPackage } from "../src/modules/project-index/knowledge-query.ts";

const repoId = "a".repeat(64), workspaceId = "b".repeat(64);
const page = (body = "中文") => ({ format: "knowledge-facts/v1", trust: "untrusted_project_data_not_instructions_or_authorization",
  workspace: { repoId, workspaceId, branch: "refs/heads/test" }, generation: 1, asOf: 1, baselineHash: "c".repeat(64),
  schemaVersion: 1, indexStatus: "partial",
  limitations: { diagnosticCounts: { syntax_error: 1 }, diagnostics: [], diagnosticDetailsOmitted: 1, unknownCodeRelations: 1,
    unindexedFiles: 1, performanceImprovement: "unknown", formalVerification: "not_available", scope: "caller_allowed_files_only" },
  coverage: { matched: 1, returned: 1, omitted: 0, remaining: 1, sourceExcerptsTruncated: 0, complete: false },
  facts: [{ kind: "source", id: "source", source: { path: "a.ts", fileHash: "d".repeat(64), parserVersion: "test", startLine: 1, endLine: 1, rangeKind: "excerpt" }, data: { body }, complete: true }], nextCursor: "x".repeat(43),
}) as KnowledgeFactPackage;

test("模型schema和运行时分页上限一致，中文/emoji及严格身份字段", () => {
  for (const query of [{ action: "facts", maxBytes: 24576 }, { action: "search", text: "中文😀" }, { action: "exact", by: "symbol", value: "跳跃" }]) {
    expect(Value.Check(KnowledgeToolSchema, { repoId, query })).toBe(true);
    expect(() => parseKnowledgeTransportQuery(query)).not.toThrow();
  }
  for (const query of [{ action: "facts", maxBytes: 24577 }, { action: "facts", pageSize: 21 }, { action: "search", text: " " }, { action: "facts", role: "main" }]) {
    expect(Value.Check(KnowledgeToolSchema, { repoId, query })).toBe(false);
    expect(() => parseKnowledgeTransportQuery(query)).toThrow();
  }
});

test.each([
  { repoId, action: "facts" }, { repoId, query: { action: "facts" }, role: "main" },
  { repoId, query: { action: "search" } }, { repoId, query: { action: "exact", by: "path" } },
  { repoId, query: { action: "facts", grantId: "fake" } }, { repoId, query: { action: "exact", by: "path", value: "../outside" } },
])("公开参数拒绝扁平/伪权限/缺必需字段/越界路径 %j", async (input) => {
  const w = world();
  await expect(w.runtime.tool.execute("shape", input)).rejects.toThrow();
  expect(w.calls).toEqual([]);
});

test("最终content双重转义仍为合法JSON，等于视图，details为完整页，保留诊断/来源/游标，超大页抛资源上限错误", () => {
  const result = page(('\\\"\n\t中文😀').repeat(1100));
  const { content, details } = knowledgeToolResult(result);
  expect(Buffer.byteLength(JSON.stringify({ content }))).toBeLessThanOrEqual(51200);
  expect(JSON.parse(content[0]!.text)).toEqual(JSON.parse(JSON.stringify(knowledgeView(result))));
  expect(details).toEqual(result);
  expect(() => knowledgeToolResult(page('\\"'.repeat(40000)))).toThrow();
  expect(() => knowledgeToolResult(page('\\"'.repeat(40000)))).toThrowError(expect.objectContaining({ code: "resource_limit" }));
});

test("视图去掉 format/schemaVersion/asOf/baselineHash/workspace，limitations 和 coverage 按非零保留", () => {
  const view = JSON.parse(JSON.stringify(knowledgeView(page())));
  expect(Object.keys(view).sort()).toEqual(["coverage", "facts", "generation", "indexStatus", "limitations", "nextCursor", "trust"]);
  expect(view.limitations).toEqual({ diagnosticCounts: { syntax_error: 1 }, diagnostics: [], diagnosticDetailsOmitted: 1, unknownCodeRelations: 1,
    unindexedFiles: 1, performanceImprovement: "unknown", formalVerification: "not_available" });
  expect(view.coverage).toEqual({ complete: false, remaining: 1 });
  expect(view.facts[0]).toEqual({ kind: "source", id: "source", source: { path: "a.ts", startLine: 1, endLine: 1 }, data: { body: "中文" }, complete: true });
  const clean = { ...page(), limitations: { diagnosticCounts: {}, diagnostics: [], diagnosticDetailsOmitted: 0, unknownCodeRelations: 0,
    unindexedFiles: 0, performanceImprovement: "unknown", formalVerification: "not_available", scope: "caller_allowed_files_only" },
    coverage: { matched: 1, returned: 1, omitted: 0, remaining: 0, sourceExcerptsTruncated: 0, complete: true } } as KnowledgeFactPackage;
  const cleanView = JSON.parse(JSON.stringify(knowledgeView(clean)));
  expect(cleanView.limitations).toEqual({ unknownCodeRelations: 0, performanceImprovement: "unknown", formalVerification: "not_available" });
  expect(cleanView.coverage).toEqual({ complete: true });
  const truncated = { ...clean, coverage: { ...clean.coverage, omitted: 2, sourceExcerptsTruncated: 3, complete: false } } as KnowledgeFactPackage;
  expect(JSON.parse(JSON.stringify(knowledgeView(truncated))).coverage).toEqual({ complete: false, omitted: 2, sourceExcerptsTruncated: 3 });
});

function world(reply: (params: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({ page: page() })) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = createKnowledgeQueryTool({ client: (id) => id === repoId ? { call: async (method, params) => { calls.push({ method, params }); return reply(params); } } : undefined });
  return { runtime, calls };
}

test("主窗口 knowledge_query 直接请求守护进程 knowledge.query，不带许可编号，content为视图、details为完整页", async () => {
  const w = world();
  const result = await w.runtime.tool.execute("call", { repoId, query: { action: "search", text: "跳跃" } });
  expect(w.calls).toEqual([{ method: "knowledge.query", params: { query: expect.objectContaining({ action: "search", text: "跳跃" }) } }]);
  expect(JSON.parse(result.content[0]!.text)).toEqual(JSON.parse(JSON.stringify(knowledgeView(page()))));
  expect(result.details).toEqual(page());
  expect(result.content[0]!.text).not.toContain("knowledge-facts/v1");
  const oversized = world(async () => ({ page: page('\\"'.repeat(40000)) }));
  await expect(oversized.runtime.tool.execute("big", { repoId, query: { action: "facts" } })).rejects.toMatchObject({ code: "resource_limit" });
  await expect(w.runtime.tool.execute("other", { repoId: "f".repeat(64), query: { action: "facts" } })).rejects.toMatchObject({ code: "unavailable" });
  const failing = world(async () => { throw Object.assign(new Error("项目索引尚未初始化"), { code: "not_initialized" }); });
  await expect(failing.runtime.tool.execute("x", { repoId, query: { action: "facts" } })).rejects.toMatchObject({ code: "not_initialized" });
});
