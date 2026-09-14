import { afterEach, expect, test, vi } from "vitest";
import { Value } from "typebox/value";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KnowledgeToolSchema, createKnowledgeQueryTool, knowledgeContent, parseKnowledgeTransportQuery } from "../runtime/knowledge-query-tool.ts";
import type { KnowledgeFactPackage } from "../runtime/knowledge-query.ts";
import type { ProjectSyncController } from "../runtime/project-sync-client.ts";
import { ProjectBaselineHooks } from "../runtime/project-baseline-hooks.ts";
import { BaselineFixture, baselineHash, deferred } from "./helpers/project-baseline-fixture.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const repoId = "a".repeat(64), workspaceId = "b".repeat(64);
const page = (body = "中文") => ({ format: "knowledge-facts/v1", trust: "untrusted_project_data_not_instructions_or_authorization",
  workspace: { repoId, workspaceId, branch: "refs/heads/test" }, generation: 1, asOf: 1, baselineHash: "c".repeat(64),
  schemaVersion: 1, schemaHash: null, contractSetHash: null, specStatus: "absent", indexStatus: "partial",
  limitations: { diagnosticCounts: { syntax_error: 1 }, diagnostics: [], diagnosticDetailsOmitted: 1, unknownCodeRelations: 1,
    unindexedFiles: 1, codeRuleBindings: "not_available", performanceImprovement: "unknown", formalVerification: "not_available", scope: "caller_allowed_files_only" },
  coverage: { matched: 1, returned: 1, omitted: 0, remaining: 1, sourceExcerptsTruncated: 0, complete: false },
  evidence: { status: "not_available", records: [], omitted: 0 }, requirement: null,
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
  const w = await world(); await w.bind("shape");
  await expect(w.runtime.tool.execute("shape", input, undefined, undefined, w.ctx)).rejects.toThrow();
  expect(w.runtime.diagnostics.pending).toBe(0);
});

test("最终content双重转义仍为合法JSON，保留诊断/来源/游标，不截字符串", () => {
  const result = page(('\\\"\n\t中文😀').repeat(1100));
  const coreBytes = Buffer.byteLength(JSON.stringify(result));
  expect(coreBytes).toBeLessThanOrEqual(24576);
  const content = knowledgeContent(result);
  expect(Buffer.byteLength(JSON.stringify({ content }))).toBeLessThanOrEqual(51200);
  expect(JSON.parse(content[0]!.text)).toEqual(result);
  expect(() => knowledgeContent(page('\\"'.repeat(40000)))).toThrow();
});

async function world() {
  const f = await BaselineFixture.create(); cleanup.push(() => f.close());
  const snapshot = f.snapshot.bind(f);
  f.snapshot = async () => ({ ...await snapshot(), repoId, workspaceId });
  const ctx = { sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
  const hooks = new ProjectBaselineHooks({ provider: f }); hooks.bindContext(ctx); cleanup.push(() => hooks.shutdown());
  let active = true, verifications = 0;
  const controller: ProjectSyncController = {
    binding: { repoId, windowId: "window", sessionId: "session" }, workspace: { repoId, workspaceId, root: f.root, branch: f.branch },
    isActive: () => active, captureFreshBaseline: async () => { throw new Error("not used"); }, assertCurrent: async () => { throw new Error("not used"); },
    subscribe: () => () => {}, subscribeInvalidation: () => () => {},
    async knowledgeQuery() { const baseline = await f.snapshot(); return { page: page(), assertLive: () => { if (!active) throw new Error("disconnected"); }, verify: async () => { verifications++; await f.assertCurrent(baseline); } }; },
  };
  let current: ProjectSyncController | undefined = controller;
  const runtime = createKnowledgeQueryTool({ controller: () => current }); cleanup.push(() => runtime.shutdown());
  let timestamp = 0;
  const bind = async (id: string | string[]) => {
    await hooks.beginRequest(); await hooks.beforeProviderRequest();
    const message = { role: "assistant", api: "test", provider: "test", timestamp: ++timestamp, stopReason: "toolUse",
      content: (Array.isArray(id) ? id : [id]).map((id) => ({ type: "toolCall", id, name: runtime.tool.name, arguments: { repoId, query: { action: "facts" } } })) } as AssistantMessage;
    hooks.messageStart(message); expect(await hooks.messageEnd(message)).toBe(true);
  };
  return { f, ctx, hooks, runtime, controller, bind, replace: () => { current = undefined; }, disconnect: () => { active = false; }, verifications: () => verifications };
}

test("真实请求绑定及tool_result再次门槛；无绑定/重复回执/会话改变拒绝", async () => {
  const w = await world();
  await expect(w.runtime.tool.execute("unknown", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx)).rejects.toThrow();
  await w.bind("ok");
  const result = await w.runtime.tool.execute("ok", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  expect(result.details).toEqual({});
  expect(w.verifications()).toBe(1);
  const finish = await w.runtime.checkResult("ok", result.content, w.ctx);
  expect(w.runtime.diagnostics.pending).toBe(1);
  finish();
  expect(w.runtime.diagnostics.pending).toBe(0);
  expect(w.verifications()).toBe(2);
  await expect(w.runtime.checkResult("ok", result.content, w.ctx)).rejects.toThrow();
});

test.each(["assert-call", "query", "verify", "check-result"])("每个工具await返回边界 %s 都同步拒绝断连", async (boundary) => {
  const w = await world(); await w.bind("boundary");
  if (boundary === "assert-call") {
    const original = w.hooks.assertCall.bind(w.hooks);
    vi.spyOn(w.hooks, "assertCall").mockImplementation(async (id) => { const result = await original(id); queueMicrotask(w.disconnect); return result; });
  } else {
    const original = w.controller.knowledgeQuery!.bind(w.controller);
    w.controller.knowledgeQuery = async (...args) => {
      const delivery = await original(...args);
      if (boundary === "query") queueMicrotask(w.disconnect);
      let count = 0;
      return { ...delivery, verify: async (signal) => {
        await delivery.verify(signal);
        count++;
        if (boundary === "verify" || boundary === "check-result" && count === 2) {
          queueMicrotask(() => queueMicrotask(w.disconnect));
        }
      } };
    };
  }
  const operation = w.runtime.tool.execute("boundary", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  if (boundary !== "check-result") await expect(operation).rejects.toThrow();
  else {
    const result = await operation;
    await expect(w.runtime.checkResult("boundary", result.content, w.ctx)).rejects.toThrow();
  }
  expect(w.runtime.diagnostics.pending).toBe(0);
});

test.each(["request", "self-write"])("外层交付同步守卫不借%s后的fresh状态换绑", async (kind) => {
  const w = await world(); await w.bind(["result", "write"]);
  const result = await w.runtime.tool.execute("result", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  const assertLive = await w.runtime.checkResult("result", result.content, w.ctx);
  if (kind === "request") await w.bind("next");
  else await w.hooks.withMutation("write", { paths: ["a.ts"], expectedWrites: [{ path: "a.ts", hash: baselineHash("C") }] }, async () => w.f.write("a.ts", "C"));
  expect(w.hooks.gate.diagnostics.stale).toBe(false);
  expect(() => assertLive()).toThrow();
});

test("32在途同步预留、重复callId拒绝；失败释放后新调用可用，shutdown拒迟到结果", async () => {
  const w = await world(); const ids = Array.from({ length: 40 }, (_, i) => `parallel-${i}`);
  await w.bind([...ids, "recover", "late"]);
  const entered = deferred<void>(), release = deferred<void>(); let count = 0;
  const original = w.controller.knowledgeQuery!.bind(w.controller);
  w.controller.knowledgeQuery = async () => { if (++count === 32) entered.resolve(); await release.promise; throw new Error("controlled failure"); };
  const operations = ids.map((id) => w.runtime.tool.execute(id, { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx));
  const outcomes = Promise.allSettled(operations);
  expect(w.runtime.diagnostics.pending).toBe(32);
  await expect(w.runtime.tool.execute(ids[0]!, { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx)).rejects.toThrow();
  await entered.promise;
  expect(count).toBe(32);
  release.resolve();
  expect((await outcomes).filter((row) => row.status === "rejected")).toHaveLength(40);
  expect(w.runtime.diagnostics.pending).toBe(0);
  w.controller.knowledgeQuery = original;
  const result = await w.runtime.tool.execute("recover", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  (await w.runtime.checkResult("recover", result.content, w.ctx))();
  const blocked = deferred<void>(), finish = deferred<void>();
  w.controller.knowledgeQuery = async (...args) => { const delivery = await original(...args); blocked.resolve(); await finish.promise; return delivery; };
  const late = w.runtime.tool.execute("late", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  const rejected = expect(late).rejects.toThrow();
  await blocked.promise; w.runtime.shutdown(); finish.resolve(); await rejected;
  expect(w.runtime.diagnostics.pending).toBe(0);
});

test("结果钩子独立signal在最后await之后取消，同步交付拒绝且释放名额", async () => {
  const w = await world(); await w.bind("cancel-result");
  const result = await w.runtime.tool.execute("cancel-result", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  const cancel = new AbortController();
  const finish = await w.runtime.checkResult("cancel-result", result.content, { ...w.ctx, signal: cancel.signal });
  cancel.abort(); expect(() => finish()).toThrow();
  expect(w.runtime.diagnostics.pending).toBe(0);
});

test("在途取消等实际工作结束才释放预算，迟到页面不能送达", async () => {
  const w = await world(); await w.bind("cancel-inflight");
  const entered = deferred<void>(), release = deferred<void>(), cancel = new AbortController();
  const original = w.controller.knowledgeQuery!.bind(w.controller);
  w.controller.knowledgeQuery = async (...args) => { const delivery = await original(...args); entered.resolve(); await release.promise; return delivery; };
  const operation = w.runtime.tool.execute("cancel-inflight", { repoId, query: { action: "facts" } }, cancel.signal, undefined, w.ctx);
  const rejected = expect(operation).rejects.toThrow();
  await entered.promise; cancel.abort();
  expect(w.runtime.diagnostics.pending).toBe(1);
  release.resolve(); await rejected;
  expect(w.runtime.diagnostics.pending).toBe(0);
});

test("pending和inflight共用32预算，取消pending立即释放且旧结果拒绝", async () => {
  const w = await world(); const ids = Array.from({ length: 33 }, (_, i) => `budget-${i}`); await w.bind(ids);
  const cancel = new AbortController();
  const first = await w.runtime.tool.execute(ids[0]!, { repoId, query: { action: "facts" } }, cancel.signal, undefined, w.ctx);
  const finish = await w.runtime.checkResult(ids[0]!, first.content, w.ctx);
  expect(w.runtime.diagnostics.pending).toBe(1);
  const release = deferred<void>(), entered = deferred<void>(); let count = 0;
  const original = w.controller.knowledgeQuery!.bind(w.controller);
  w.controller.knowledgeQuery = async (...args) => { if (++count === 31) entered.resolve(); await release.promise; return original(...args); };
  const operations = ids.slice(1, 32).map((id) => w.runtime.tool.execute(id, { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx));
  const settled = Promise.allSettled(operations);
  await entered.promise;
  expect(w.runtime.diagnostics.pending).toBe(32);
  await expect(w.runtime.tool.execute(ids[32]!, { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx)).rejects.toThrow();
  cancel.abort();
  expect(w.runtime.diagnostics.pending).toBe(31);
  expect(() => finish()).toThrow();
  await expect(w.runtime.checkResult(ids[0]!, first.content, w.ctx)).rejects.toThrow();
  release.resolve();
  expect((await settled).every((row) => row.status === "fulfilled")).toBe(true);
  expect(w.runtime.diagnostics.pending).toBe(31);
  w.runtime.shutdown(); expect(w.runtime.diagnostics.pending).toBe(0);
});

test.each(["file", "disconnect", "controller", "content", "session"])("返回竞争 %s 不返回旧事实", async (mode) => {
  const w = await world(); await w.bind("race");
  const result = await w.runtime.tool.execute("race", { repoId, query: { action: "facts" } }, undefined, undefined, w.ctx);
  if (mode === "file") await w.f.write("a.ts", "changed with no observation");
  if (mode === "disconnect") w.disconnect();
  if (mode === "controller") w.replace();
  if (mode === "content") result.content[0]!.text += " ";
  const ctx = mode === "session" ? { ...w.ctx, sessionManager: {} } as ExtensionContext : w.ctx;
  await expect(w.runtime.checkResult("race", result.content, ctx)).rejects.toThrow();
});
