import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exploreReportView } from "../src/modules/explore/explore-report.ts";
import { registerAgentManageTool, registerExploreDelivery } from "../src/modules/explore/agent-manage-extension.ts";
import { authorizeToolAction, CORE_ROLES, CORE_TOOL_ACTIONS } from "../src/core/policy/core-permissions.ts";
import { registerRequirementInput } from "../src/core/host/extension-lifecycle.ts";
import { PROTOCOL_VERSION } from "../src/core/host/protocol.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const RUN = "0197b7b0-6a20-7c51-8a32-b9465fb72d11";
const OTHER_RUN = "0197b7b0-6a20-7c51-8a32-b9465fb72d12";
const MISSING_RUN = "0197b7b0-6a20-7c51-8a32-b9465fb72d13";
const REPO = "a".repeat(64);
const CUSTOM_TYPE = "one-company.explore-result";

const parent = { role: "main", parentSessionId: "s1", parentRunId: "r1", contextId: "c1", requirementBinding: null };
const webSources = Array.from({ length: 8 }, (_, i) => ({ kind: "web", indexBaseline: "not_applicable",
  url: `https://example.test/doc-${i}`, retrievedAt: 1_700_000_000_000 + i, quote: `摘录文字 ${i}：验证码五分钟后过期，这一句故意写得长一些以便占字数` }));
const queries = Array.from({ length: 9 }, (_, i) => `搜索词-${i} 验证码过期时间`);
const conclusions = Array.from({ length: 6 }, (_, i) => `结论 ${i}：验证码有效期为五分钟`);

const completed = {
  kind: "explore-report", runId: RUN, outcome: "completed", turnsUsed: 3,
  note: "research 不是 PASS：使用前核对来源、当前性与截断，必要时回读关键全文",
  research: {
    format: "explore-result/v1", kind: "research", parent,
    source: { kind: "web", indexBaseline: "not_applicable", query: "验证码过期时间" },
    conclusions, sources: webSources, searchedScope: { kind: "web", queries },
    notFound: ["没找到重发次数上限", "没找到冷却时间"], failures: ["一个网页打不开"],
    truncation: { truncated: true, reasons: ["网页过长"] }, unknown: ["未核实文档是否最新", "未核实是否有灰度", "未核实线上配置"],
  },
};
const undelivered = {
  kind: "explore-report", runId: OTHER_RUN, outcome: "turn_limit_reached", turnsUsed: 30, research: null,
  reason: "未提交 research，没有可用结果：达到轮次上限", next: "按原因决定是否调整问题、线索或轮次上限后重派", log: "/tmp/run.log",
};

const viewOf = (report: unknown, audience: "main" | "pm" = "main") => (exploreReportView as (r: unknown, a: string) => Record<string, unknown>)(report, audience);

afterEach(() => registerRequirementInput(undefined));

test("摘要的键正好是 10 个，sourceCount 为来源条数，结论、没查到、没核实、失败、截断逐项相同", () => {
  const view = viewOf(completed);
  expect(Object.keys(view)).toEqual(["runId", "outcome", "turnsUsed", "conclusions", "notFound", "unknown", "failures", "truncation", "sourceCount", "next"]);
  expect(view.sourceCount).toBe(8);
  expect(view.runId).toBe(RUN);
  expect(view.outcome).toBe("completed");
  expect(view.turnsUsed).toBe(3);
  expect(view.conclusions).toEqual(completed.research.conclusions);
  expect(view.notFound).toEqual(completed.research.notFound);
  expect(view.unknown).toEqual(completed.research.unknown);
  expect(view.failures).toEqual(completed.research.failures);
  expect(view.truncation).toEqual({ truncated: true, reasons: ["网页过长"] });
});

test("摘要里没有任何来源链接、摘录、搜索词，也没有 parent、source、format、kind、searchedScope、retrievedAt", () => {
  const text = JSON.stringify(viewOf(completed));
  for (const source of webSources) {
    expect(text).not.toContain(source.url);
    expect(text).not.toContain(source.quote);
  }
  for (const query of queries) expect(text).not.toContain(query);
  for (const key of ["parent", "source", "format", "kind", "searchedScope", "retrievedAt", "quote", "url"]) expect(text).not.toContain(`"${key}"`);
});

test("本地检索的摘要同样没有路径、起止行、文件哈希", () => {
  const local = { ...completed, research: { ...completed.research, source: { kind: "local_file", indexBaseline: "not_applicable", root: "/repo" },
    sources: [{ kind: "local_file", indexBaseline: "not_applicable", path: "src/login.ts", fileHash: "f".repeat(64), startLine: 3, endLine: 9 }],
    searchedScope: { kind: "local_file", paths: ["src/login.ts"] } } };
  const view = viewOf(local);
  const text = JSON.stringify(view);
  expect(view.sourceCount).toBe(1);
  for (const needle of ["src/login.ts", "f".repeat(64), "startLine", "endLine", "fileHash", "path"]) expect(text).not.toContain(needle);
});

test("用法说明：给主代理的 next 要求写草稿或当依据时先按运行编号取来源核对、只决定下一步查什么时不用取；给 PM 的另有一句", () => {
  const main = viewOf(completed, "main").next as string;
  const pm = viewOf(completed, "pm").next as string;
  expect(main).toBe("结论要写进需求草稿，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。");
  expect(pm).toBe("结论要写进计划或任务，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。");
});

test("摘要 JSON 的字数不到完整报告 JSON 的一半", () => {
  expect(JSON.stringify(viewOf(completed)).length).toBeLessThan(JSON.stringify(completed).length / 2);
});

test("没交结果的报告原样返回", () => {
  expect(viewOf(undelivered)).toEqual(undelivered);
  expect(viewOf(undelivered, "pm")).toEqual(undelivered);
});

function deliveryWorld(report: unknown) {
  const order: string[] = [];
  registerRequirementInput({ revoke: () => { order.push("revoke"); }, noteOpenedItem() {}, mentionNote: () => "" });
  let listener: ((data: Record<string, unknown>) => void) | undefined;
  const client = { subscribe: (_event: string, fn: (data: Record<string, unknown>) => void) => { listener = fn; return () => {}; }, call: async () => report };
  const fake = createFakePi();
  const sendMessage = vi.fn((_message: unknown, _options: unknown) => { order.push("sendMessage"); });
  registerExploreDelivery({ ...fake.pi, sendMessage } as never, async () => ({ clients: { forRepo: () => client } as never, repoIds: ["repo-a"] }));
  return { order, sendMessage, async finish() {
    await fake.trigger("session_start", {}, { sessionManager: { getSessionId: () => "session-a" } });
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener!({ runId: String((report as { runId: string }).runId), parentSessionId: "session-a" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  } };
}

test("送达：content 是摘要 JSON，details 是完整报告，customType 不变，且先撤销用户原话再 sendMessage", async () => {
  const w = deliveryWorld(completed);
  await w.finish();
  const message = w.sendMessage.mock.calls[0]![0] as { customType: string; content: string; details: unknown; display: boolean };
  expect(message.customType).toBe(CUSTOM_TYPE);
  expect(message.content).toBe(JSON.stringify(viewOf(completed, "main")));
  expect(message.details).toEqual(completed);
  expect(message.display).toBe(true);
  expect(w.order).toEqual(["revoke", "sendMessage"]);
});

test("送达：没交结果时 content 是报告原样 JSON", async () => {
  const w = deliveryWorld(undelivered);
  await w.finish();
  const message = w.sendMessage.mock.calls[0]![0] as { content: string };
  expect(message.content).toBe(JSON.stringify(undelivered));
});

type Tool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }>; details: unknown }> };

function sourcesTool() {
  const calls: unknown[] = [];
  let tool: Tool | undefined;
  const pi = { registerTool: (registered: Tool) => { tool = registered; }, getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
  const clients = { forRepo: () => ({ call: async (...args: unknown[]) => { calls.push(args); return {}; } }) };
  registerAgentManageTool(pi, () => ({ clients: clients as never }));
  return { calls, run: (params: unknown, sessionManager: SessionManager) => tool!.execute("t", params, undefined, undefined, { sessionManager, model: { provider: "p", id: "m" } }) };
}

const assistant = { role: "assistant", content: [{ type: "text", text: "好" }], api: "anthropic-messages", provider: "p", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 2 };

function newSession() {
  const root = temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "查一下", timestamp: 1 } as never);
  manager.appendMessage(assistant as never);
  return manager;
}

function appendResult(manager: SessionManager, report: { runId: string }) {
  manager.appendCustomMessageEntry(CUSTOM_TYPE, JSON.stringify(viewOf(report)), true, report);
}

test("取来源：返回本会话里该编号检索结果的全部来源和检索范围，details 是完整报告，不经守护进程", async () => {
  const manager = newSession();
  appendResult(manager, completed);
  const tool = sourcesTool();
  const result = await tool.run({ action: "sources", runId: RUN }, manager);
  expect(JSON.parse(result.content[0]!.text)).toEqual({ runId: RUN, sources: webSources, searchedScope: { kind: "web", queries } });
  expect(result.details).toEqual(completed);
  expect(tool.calls).toEqual([]);
});

test("取来源：编号不在本会话或对应没交结果的报告时失败并说明原因", async () => {
  const manager = newSession();
  appendResult(manager, completed);
  appendResult(manager, undelivered);
  const tool = sourcesTool();
  await expect(tool.run({ action: "sources", runId: MISSING_RUN }, manager)).rejects.toThrow("原因：本会话里没有这个编号的检索结果");
  await expect(tool.run({ action: "sources", runId: OTHER_RUN }, manager)).rejects.toThrow("原因：本会话里没有这个编号的检索结果");
  expect(tool.calls).toEqual([]);
});

test("取来源：检索结果不在当前分支上时取不到", async () => {
  const manager = newSession();
  const before = manager.getLeafId()!;
  appendResult(manager, completed);
  manager.branch(before);
  await expect(sourcesTool().run({ action: "sources", runId: RUN }, manager)).rejects.toThrow("原因：本会话里没有这个编号的检索结果");
});

test("重开会话：换新注册的工具实例，按同一编号取来源，结果与重开前逐字相同", async () => {
  const manager = newSession();
  appendResult(manager, completed);
  const before = await sourcesTool().run({ action: "sources", runId: RUN }, manager);
  const reopened = SessionManager.open(manager.getSessionFile()!);
  const after = await sourcesTool().run({ action: "sources", runId: RUN }, reopened);
  expect(after.content[0]!.text).toBe(before.content[0]!.text);
  expect(after.details).toEqual(before.details);
});

test.each([
  ["多带 repoId", { action: "sources", runId: RUN, repoId: REPO }],
  ["缺 runId", { action: "sources" }],
  ["runId 不是 UUIDv7", { action: "sources", runId: "not-a-uuid" }],
])("取来源参数不合格（%s）按参数格式失败", async (_name, params) => {
  await expect(sourcesTool().run(params, newSession())).rejects.toThrow("参数不符合该动作的格式");
});

test("授权：main 和 pm 可用 sources，其他角色不可用；main 的 agent_manage 清单含 sources；枚举落在核心表内", () => {
  expect(authorizeToolAction("main", "agent_manage", "sources")).toBe(true);
  expect(authorizeToolAction("pm", "agent_manage", "sources")).toBe(true);
  for (const role of CORE_ROLES) if (role !== "main" && role !== "pm") expect(authorizeToolAction(role, "agent_manage", "sources")).toBe(false);
  expect(CORE_TOOL_ACTIONS.agent_manage).toContain("sources");
  expect(CORE_TOOL_ACTIONS.agent_manage.filter((action) => authorizeToolAction("main", "agent_manage", action))).toEqual(["dispatch", "status", "pause", "resume", "stop", "message", "sources"]);
});

test("主代理规矩第 7 条写明要当依据时先按运行编号取来源核对，并指向 agent_manage action=sources", () => {
  const rules = readFileSync(join(import.meta.dirname, "..", "rules", "01-main-session.md"), "utf8");
  const line = rules.split("\n").find((text) => text.startsWith("7. "))!;
  expect(line).toBe("7. **检索**：回答功能或行为问题前先查代码，回答里写出依据的文件与行号；行号取自知识查询结果里的起止行或 `grep -n` 的输出，读文件工具返回的正文不带行号，不要自己数；归档、说明注释和代码说的不一样时，以代码为准，并说清哪里不一样。查当前代码用 `one_company_knowledge_query`，查函数说明可直接 grep 注释；需要广泛检索或联网时用 agent_manage 派 explore，结果以卡片送回，只有结论、没查到、没核实和来源条数。检索结果要当依据时先按运行编号取来源核对：结论要写进需求草稿，或当作回答用户的依据时，先用 agent_manage action=sources 取来源；只用来决定下一步再查什么时不用取。");
});

test("窗口与守护进程之间的通信版本不变", () => {
  expect(PROTOCOL_VERSION).toBe(8);
});
