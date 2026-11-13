import { expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerAgentManageTool, registerExploreDelivery } from "../src/modules/explore/agent-manage-extension.ts";
import { registerWorkflowManageTool } from "../src/modules/delivery/workflow-manage-extension.ts";
import { registerGitDelivery } from "../src/modules/delivery/git-delivery-extension.ts";
import prototypeExtension from "../src/modules/prototype/prototype-extension.ts";
import { createProjectManageTool } from "../src/modules/project-index/project-manage-tool.ts";
import { createKnowledgeQueryTool } from "../src/modules/project-index/knowledge-query-tool.ts";
import { noteRequirementTitle } from "../src/core/host/tool-card.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { draw, ok, plainTheme, seen } from "./helpers/card-draw.ts";
import type { CardTool } from "./helpers/card-draw.ts";

const { REPO, window } = vi.hoisted(() => ({ REPO: "a".repeat(64), window: { repos: undefined as undefined | Array<{ repoId: string; path: string }> } }));
vi.mock("../src/core/host/extension-lifecycle.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/host/extension-lifecycle.ts")>()),
  windowContext: () => {
    if (!window.repos) throw new Error("窗口没就绪");
    return { workspace: { repos: window.repos } } as never;
  },
}));

const RUN = "01a1bdf1-abe9-7aa8-a969-2a66887b6230";
const REQ = "01a1aaf0-9038-77ec-99a8-000000000001";
const TITLE = "跨平台 Codex 桌面应用中台模型接入与更新工具";
const PROTO = "桌面接入工具安装配置原型";
const QUESTION = "OpenAI 的 Responses 接口怎么处理工具调用的流式输出";
window.repos = [{ repoId: REPO, path: "/x/one-company" }];
noteRequirementTitle(REQ, TITLE);

const fake = createFakePi();
registerAgentManageTool(fake.pi as never, () => ({ clients: {} as never }));
registerWorkflowManageTool(fake.pi as never, () => ({ clients: {} as never }));
registerGitDelivery(fake.pi as never, () => ({ clients: () => ({}) as never }));
prototypeExtension(fake.pi as never);
registerExploreDelivery(fake.pi as never, async () => ({ clients: {} as never, repoIds: [] }));
const named = (name: string) => fake.registeredTools().find((tool) => tool.name === name) as unknown as CardTool;
const agent = named("one_company_agent_manage");
const workflow = named("one_company_workflow_manage");
const git = named("one_company_git_deliver");
const prototype = named("one_company_prototype");
const project = createProjectManageTool({ dataRoot: "/tmp/pi-t-cards", resolveHost: (() => { throw new Error("x"); }) as never, currentHost: (() => { throw new Error("x"); }) as never, openService: (() => { throw new Error("x"); }) as never }).tool as unknown as CardTool;
const knowledge = createKnowledgeQueryTool({ client: () => undefined }).tool as unknown as CardTool;

const plain = (request: Record<string, unknown>) => ({ repoId: REPO, ...request });
const wrap = (request: Record<string, unknown>) => ({ request: { repoId: REPO, ...request } });
const report = (kind: "web" | "local_file", extra: Record<string, unknown> = {}) => ({
  kind: "explore-report", runId: RUN, outcome: "completed", turnsUsed: 13,
  research: {
    conclusions: Array.from({ length: 6 }, (_, i) => `结论正文 ${i}`),
    sources: Array.from({ length: 8 }, (_, i) => kind === "web"
      ? { url: `https://example.com/${i}`, retrievedAt: "2026-11-10T00:00:00Z", quote: `来源摘录 ${i}` }
      : { path: `/x/${i}.ts`, startLine: 1, endLine: 2, quote: `来源摘录 ${i}` }),
    searchedScope: kind === "web" ? { kind, queries: Array.from({ length: 9 }, (_, i) => `词 ${i}`) } : { kind, paths: ["/x/a.ts", "/x/b.ts", "/x/c.ts"] },
    notFound: ["a", "b"], unknown: ["c", "d", "e"], failures: [], truncation: { truncated: true, reasons: ["网页过长"] }, ...extra,
  },
});

test("agent_manage dispatch explore：标题写检索问题，摘要写编号和轮次上限", () => {
  const args = plain({ action: "dispatch", role: "explore", question: QUESTION, clues: [], maxTurns: 18 });
  expect(draw(agent, args, ok({ runId: RUN, maxTurns: 18 }))).toEqual([
    `<b>派出检索</b>  <muted>${QUESTION}</>`,
    "已派出  <muted>· 编号 01a1bdf1</>  <muted>· 最多 18 轮</>",
  ]);
});

test("agent_manage dispatch pm：标题写需求标题，查不到标题写「需求 前8位」", () => {
  expect(draw(agent, plain({ action: "dispatch", role: "pm", requirementId: REQ }), ok({ runId: RUN }))).toEqual([`<b>派出 PM</b>  <muted>${TITLE}</>`, "已派出  <muted>· 编号 01a1bdf1</>"]);
  const other = "01a1aaf0-9038-77ec-99a8-0000000000ff";
  expect(draw(agent, plain({ action: "dispatch", role: "pm", requirementId: other }), ok({ runId: RUN }))[0]).toBe("<b>派出 PM</b>  <muted>需求 01a1aaf0</>");
});

test("agent_manage sources：联网检索写搜索词个数，本地检索写读过的文件数", () => {
  const args = { action: "sources", runId: RUN };
  expect(draw(agent, args, ok(report("web")))).toEqual(["<b>检索来源</b>  <muted>编号 01a1bdf1</>", "取到 8 条来源  <muted>· 搜索词 9 个</>"]);
  expect(draw(agent, args, ok(report("local_file")))[1]).toBe("取到 8 条来源  <muted>· 读过 3 个文件</>");
});

test("agent_manage status 写运行状态和轮次，八种状态各有说法", () => {
  const args = plain({ action: "status", runId: RUN });
  expect(draw(agent, args, ok({ run: { state: "running", turns: 5 } }))).toEqual(["<b>查看运行</b>  <muted>编号 01a1bdf1</>", "运行中  <muted>· 第 5 轮</>"]);
  const names = { queued: "排队中", running: "运行中", pausing: "暂停中", paused: "已暂停", completed: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断" };
  for (const [state, text] of Object.entries(names)) expect(draw(agent, args, ok({ run: { state, turns: 2 } }))[1]).toBe(`${text}  <muted>· 第 2 轮</>`);
});

test("agent_manage pause、resume、stop：动作名各不相同，摘要写状态，有 reason 时加原因", () => {
  for (const [action, title] of [["pause", "暂停运行"], ["resume", "续接运行"], ["stop", "停止运行"]]) {
    const args = plain({ action, runId: RUN });
    expect(draw(agent, args, ok({ state: "stopped", confirmed: true }))).toEqual([`<b>${title}</b>  <muted>编号 01a1bdf1</>`, "已停止"]);
    expect(draw(agent, args, ok({ state: "stopped", confirmed: true, reason: "用户要求" }))[1]).toBe("已停止  <muted>· 用户要求</>");
  }
});

test("agent_manage message：转话给 PM，按 delivered 写已转给 PM 或 PM 续接后转给它", () => {
  const args = plain({ action: "message", requirementId: REQ, text: "说明" });
  expect(draw(agent, args, ok({ delivered: "now" }))).toEqual([`<b>转话给 PM</b>  <muted>${TITLE}</>`, "已转给 PM"]);
  expect(draw(agent, args, ok({ delivered: "after_resume" }))[1]).toBe("PM 续接后转给它");
});

test("prototype designers、dispatch：列出设计师数量；派出写版本和编号", () => {
  expect(draw(prototype, { request: { action: "designers", repoId: REPO } }, ok({ items: [{ name: "a" }, { name: "b" }] }))).toEqual(["<b>列出原型设计师</b>", "2 位设计师"]);
  const args = wrap({ action: "dispatch", requirementId: REQ, name: PROTO, brief: "画", maxTurns: 10 });
  expect(draw(prototype, args, ok({ runId: RUN, version: 2 }))).toEqual([`<b>派出原型设计</b>  <muted>${PROTO}</>`, "已派出  <muted>· 第 2 版</>  <muted>· 编号 01a1bdf1</>"]);
});

const statusArgs = wrap({ action: "status", requirementId: REQ });
const entry = (extra: Record<string, unknown>, name = PROTO) => ({ name, lastVersion: 3, removed: false, ...extra });

test("prototype status：按先后取第一条符合的状态", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ removed: true, inFlight: { version: 2, status: "designing" } }, "第 2 版设计中"],
    [{ removed: true, inFlight: { version: 2, status: "awaiting" } }, "第 2 版等你确认"],
    [{ removed: true, draft: { version: 1 } }, "已从草稿移除"],
    [{ inFlight: { version: 3, status: "awaiting" }, draft: { version: 2 } }, "第 3 版等你确认"],
    [{ inFlight: { version: 3, status: "designing" } }, "第 3 版设计中"],
    [{ draft: { version: 3 }, approved: { version: 2 } }, "第 3 版已通过"],
    [{ approved: { version: 2 } }, "第 2 版已随需求批准"],
    [{ lastEnded: { version: 3, reason: "轮次用完" } }, "第 3 版没交稿：轮次用完"],
    [{}, "还没交稿"],
  ];
  for (const [extra, text] of cases) {
    expect(draw(prototype, statusArgs, ok({ entries: [entry(extra)] }))).toEqual([`<b>原型状态</b>  <muted>${TITLE}</>`, `${PROTO}：${text}`]);
  }
});

test("prototype status：没有原型写「还没有原型」；5 个原型只写前 2 个，第 2 行末尾写还有几个", () => {
  expect(draw(prototype, statusArgs, ok({ entries: [] }))[1]).toBe("还没有原型");
  const entries = ["甲", "乙", "丙", "丁", "戊"].map((name) => entry({ approved: { version: 1 } }, name));
  const lines = draw(prototype, statusArgs, ok({ entries }));
  expect(lines).toHaveLength(3);
  expect(lines[1]).toBe("甲：第 1 版已随需求批准");
  expect(lines[2]).toMatch(/^乙：第 1 版已随需求批准/);
  expect(lines[2]!.endsWith("<muted>· 还有 3 个原型</>")).toBe(true);
  expect(draw(prototype, statusArgs, ok({ entries: entries.slice(0, 3) }))[2]!.endsWith("<muted>· 还有 1 个原型</>")).toBe(true);
  expect(draw(prototype, statusArgs, ok({ entries: entries.slice(0, 2) })).join("")).not.toContain("还有");
});

const bare = (line: string) => line.replace(/<\/?[a-z]*>/g, "");
const LONG_NAME = "桌面接入工具安装配置与首次启动引导流程及权限申请说明原型";
const protoEntries = (first: Record<string, unknown>, count: number) => Array.from({ length: count }, (_, i) => i === 0 ? first : entry({ approved: { version: 1 } }, `原型${i}`));

test("prototype status 超宽：名字比状态长时截名字加省略号，状态和「还有 K 个原型」完整", () => {
  const entries = protoEntries(entry({ approved: { version: 1 } }, "短名"), 4);
  entries[1] = entry({ inFlight: { version: 3, status: "awaiting" } }, LONG_NAME);
  const lines = draw(prototype, statusArgs, ok({ entries }), { width: 78 });
  expect(lines[1]).toBe("短名：第 1 版已随需求批准");
  expect(lines[2]).toMatch(/^桌.+…：第 3 版等你确认\s*<muted>· 还有 2 个原型<\/>$/);
  expect(lines[2]).not.toContain(LONG_NAME);
  for (const line of lines) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(78);
});

test("prototype status 超宽：没交稿原因很长时原型名完整，原因从右边截加省略号，「还有 K 个原型」完整", () => {
  const reason = "设计师在第 18 轮用完轮数上限，还没写出可以打开的页面文件";
  const entries = protoEntries(entry({}, "甲"), 4);
  entries[1] = entry({ lastEnded: { version: 1, reason } }, "支付结果页原型");
  const lines = draw(prototype, statusArgs, ok({ entries }), { width: 78 });
  expect(lines[2]).toMatch(/^支付结果页原型：第 1 版没交稿：设计师.*…\s*<muted>· 还有 2 个原型<\/>$/);
  expect(lines[2]).not.toContain(reason);
  for (const line of lines) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(78);
});

test("prototype status 超宽：第一行（没有计数）同样截较长的那段，行尾无多余内容", () => {
  const lines = draw(prototype, statusArgs, ok({ entries: [entry({ inFlight: { version: 3, status: "awaiting" } }, LONG_NAME)] }), { width: 50 });
  expect(lines[1]).toMatch(/^桌.+…：第 3 版等你确认$/);
  expect(visibleWidth(bare(lines[1]!))).toBeLessThanOrEqual(50);
});

test("prototype status 宽度刚好够时显示与完整文字完全相同", () => {
  const entries = protoEntries(entry({ approved: { version: 1 } }, "甲"), 3);
  const lines = draw(prototype, statusArgs, ok({ entries }), { width: 120 });
  expect(lines[1]).toBe("甲：第 1 版已随需求批准");
  expect(lines[2]).toBe("原型1：第 1 版已随需求批准  <muted>· 还有 1 个原型</>");
});

test("prototype status 窄到可截文字只剩省略号也放不下时，整行从右边截，每行不超宽", () => {
  const entries = protoEntries(entry({ inFlight: { version: 3, status: "awaiting" } }, LONG_NAME), 4);
  const lines = draw(prototype, statusArgs, ok({ entries }), { width: 12, theme: plainTheme as never });
  for (const line of lines.slice(1)) {
    expect(line.endsWith("…")).toBe(true);
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  }
});

test("workflow_manage delivery-check 超宽：只截卡住原因加省略号，「还不能交付」和「共 N 项」完整", () => {
  const args = { action: "delivery-check", repoId: REPO, requirementId: REQ };
  const reason = "计划里还有三个任务没有做完而且最近一次审查提出的问题还没有逐条处理完毕需要继续";
  const lines = draw(workflow, args, ok({ result: { deliverable: false, blockers: [reason, "b", "c"] } }), { width: 60 });
  expect(lines[1]).toMatch(/^还不能交付  <muted>· 计划.+…<\/>  <muted>· 共 3 项<\/>$/);
  for (const line of lines) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(60);
});

test("workflow_manage delivery-check 超宽且只有 1 项：卡住原因截断，行尾没有计数", () => {
  const args = { action: "delivery-check", repoId: REPO, requirementId: REQ };
  const lines = draw(workflow, args, ok({ result: { deliverable: false, blockers: ["计划里还有三个任务没有做完".repeat(5)] } }), { width: 40 });
  expect(lines[1]).toMatch(/^还不能交付  <muted>· 计划.+…<\/>$/);
  expect(visibleWidth(bare(lines[1]!))).toBeLessThanOrEqual(40);
});

test("workflow_manage delivery-check 窄到卡住原因只剩省略号也放不下时，整行从右边截，每行不超宽", () => {
  const args = { action: "delivery-check", repoId: REPO, requirementId: REQ };
  const lines = draw(workflow, args, ok({ result: { deliverable: false, blockers: ["计划没做完", "b", "c"] } }), { width: 12, theme: plainTheme as never });
  expect(lines[1]!.endsWith("…")).toBe(true);
  expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(12);
});

const ansiTheme = { fg: (_kind: string, text: string) => `\x1b[90m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, bg: (_kind: string, text: string) => text };
const RESET_ALL = "\x1b[0m";
const deliveryArgs = { action: "delivery-check", repoId: REPO, requirementId: REQ };
const LONG_REASON = "计划里还有三个任务没有做完而且最近一次审查提出的问题还没有逐条处理完毕需要继续";

test("prototype status 超宽且用真实色码：被截的行里没有清除全部样式的 \\x1b[0m", () => {
  const entries = protoEntries(entry({ approved: { version: 1 } }, "短名"), 4);
  entries[1] = entry({ inFlight: { version: 3, status: "awaiting" } }, LONG_NAME);
  const lines = draw(prototype, statusArgs, ok({ entries }), { width: 78, theme: ansiTheme as never });
  expect(lines[2]).toContain("…");
  expect(lines[2]).not.toContain(RESET_ALL);
});

test("workflow_manage delivery-check 超宽且用真实色码：没有 \\x1b[0m，被截的卡住原因末尾的省略号仍在灰色里", () => {
  const lines = draw(workflow, deliveryArgs, ok({ result: { deliverable: false, blockers: [LONG_REASON, "b", "c"] } }), { width: 60, theme: ansiTheme as never });
  expect(lines[1]).not.toContain(RESET_ALL);
  expect(lines[1]).toMatch(/\x1b\[90m[^\x1b]*…\x1b\[39m/);
});

test("prototype status 可见总宽刚好等于渲染宽度时显示完整文字，少 1 列开始截且行尾计数完整", () => {
  const entries = protoEntries(entry({ approved: { version: 1 } }, "甲"), 3);
  const full = draw(prototype, statusArgs, ok({ entries }), { width: 200, theme: plainTheme as never })[2]!;
  const total = visibleWidth(full);
  const exact = draw(prototype, statusArgs, ok({ entries }), { width: total, theme: plainTheme as never });
  expect(exact[2]).toBe(full);
  expect(exact.slice(1).join("")).not.toContain("…");
  const tight = draw(prototype, statusArgs, ok({ entries }), { width: total - 1, theme: plainTheme as never });
  expect(tight[2]).toContain("…");
  expect(tight[2]!.endsWith("· 还有 1 个原型")).toBe(true);
  for (const line of tight) expect(visibleWidth(line)).toBeLessThanOrEqual(total - 1);
});

test("workflow_manage delivery-check 可见总宽刚好等于渲染宽度时显示完整文字，少 1 列开始截且行尾计数完整", () => {
  const result = ok({ result: { deliverable: false, blockers: ["计划没做完", "b", "c"] } });
  const full = draw(workflow, deliveryArgs, result, { width: 200, theme: plainTheme as never })[1]!;
  const total = visibleWidth(full);
  const exact = draw(workflow, deliveryArgs, result, { width: total, theme: plainTheme as never });
  expect(exact[1]).toBe(full);
  expect(exact.slice(1).join("")).not.toContain("…");
  const tight = draw(workflow, deliveryArgs, result, { width: total - 1, theme: plainTheme as never });
  expect(tight[1]).toContain("…");
  expect(tight[1]!.endsWith("共 3 项")).toBe(true);
  for (const line of tight) expect(visibleWidth(line)).toBeLessThanOrEqual(total - 1);
});

test("project_manage refresh：结果截断了摘要也不写「有截断」", () => {
  const result = ok({ action: "refresh", status: "ready", files: 5, skipped: [], skippedCount: 2, diagnosticCount: 0, truncation: { truncated: true } });
  expect(draw(project, wrap({ action: "refresh" }), result)[1]).toBe("完成  <muted>· 5 个文件</>  <muted>· 跳过 2 个</>");
});

test("prototype confirm、remove：摘要是工具返回的那句话", () => {
  const said = "用户已在窗口里作出决定，结果以程序记录为准";
  expect(draw(prototype, wrap({ action: "confirm", requirementId: REQ, name: PROTO }), ok(said))).toEqual([`<b>确认原型</b>  <muted>${PROTO}</>`, said]);
  expect(draw(prototype, wrap({ action: "remove", requirementId: REQ, name: PROTO }), ok("用户选择保留，没有移除"))).toEqual([`<b>删除原型</b>  <muted>${PROTO}</>`, "用户选择保留，没有移除"]);
});

test("prototype status 展开：有调用参数、完整结果，完整结果里有 updatedAt 和各版本的 hash", () => {
  const details = { entries: [entry({ draft: { version: 3, hash: "h-draft", updatedAt: 1 }, approved: { version: 2, hash: "h-approved", updatedAt: 2 } })] };
  const text = draw(prototype, statusArgs, ok(details), { expanded: true }).join("\n");
  expect(text).toContain("<muted>调用参数</>");
  expect(text).toContain("<muted>完整结果</>");
  for (const word of ['"updatedAt"', '"hash": "h-draft"', '"hash": "h-approved"']) expect(text).toContain(word);
});

test("workflow_manage status：关闭状态三种写法", () => {
  const args = { action: "status", repoId: REPO, requirementId: REQ };
  for (const [status, text] of [["none", "没在关闭"], ["closing", "关闭中"], ["closed", "已关闭"]]) {
    expect(draw(workflow, args, ok({ result: { close: { status } } }))).toEqual([`<b>需求流程</b>  <muted>${TITLE}</>`, text]);
  }
});

test("workflow_manage delivery-check：可以交付为绿色，否则写第 1 条阻塞，多于 1 条加共几项", () => {
  const args = { action: "delivery-check", repoId: REPO, requirementId: REQ };
  expect(draw(workflow, args, ok({ result: { deliverable: true, blockers: [] } }))).toEqual([`<b>需求流程</b>  <muted>${TITLE}</>`, "<success>可以交付</>"]);
  expect(draw(workflow, args, ok({ result: { deliverable: false, blockers: ["计划没做完"] } }))[1]).toBe("还不能交付  <muted>· 计划没做完</>");
  expect(draw(workflow, args, ok({ result: { deliverable: false, blockers: ["计划没做完", "b", "c"] } }))[1]).toBe("还不能交付  <muted>· 计划没做完</>  <muted>· 共 3 项</>");
});

test("workflow_manage close：已关闭为绿色，关闭中和没关闭带 next", () => {
  const args = { action: "close", repoId: REPO, requirementId: REQ, reason: "completed", receiptId: RUN };
  expect(draw(workflow, args, ok({ result: { status: "closed" } }))).toEqual([`<b>关闭需求</b>  <muted>${TITLE}</>`, "<success>已关闭</>"]);
  expect(draw(workflow, args, ok({ result: { status: "closing", next: "再关一次" } }))[1]).toBe("关闭中  <muted>· 再关一次</>");
  expect(draw(workflow, args, ok({ result: { status: "rejected", next: "先登记决定" } }))[1]).toBe("没关闭  <muted>· 先登记决定</>");
});

test("git_deliver：delivered 按合并状态写，其余状态各有说法", () => {
  const args = { repoId: REPO, requirementId: REQ };
  const url = "https://github.com/acme/x/pull/12";
  const head = `<b>交付</b>  <muted>${TITLE}</>`;
  expect(draw(git, args, ok({ status: "delivered", url, merge: { state: "merged" } }))).toEqual([head, `已合并  <muted>· ${url}</>`]);
  for (const [state, text] of [["queued", "已排队合并"], ["review", "等审查"], ["failed", "合并没成功"]]) {
    expect(draw(git, args, ok({ status: "delivered", url, merge: { state } }))[1]).toBe(`${text}  <muted>· ${url}</>`);
  }
  expect(draw(git, args, ok({ status: "merged-locally", target: "main" }))[1]).toBe("已合进 main");
  expect(draw(git, args, ok({ status: "not-merged", reason: "用户没选合并" }))[1]).toBe("没合并  <muted>· 用户没选合并</>");
  expect(draw(git, args, ok({ status: "cancelled" }))[1]).toBe("已取消");
  expect(draw(git, args, ok({ status: "rejected", reason: "没归档" }))[1]).toBe("没交付  <muted>· 没归档</>");
  expect(draw(git, args, ok({ status: "conflict", reason: "a.ts 冲突" }))[1]).toBe("有冲突  <muted>· a.ts 冲突</>");
});

const skipped = Array.from({ length: 11 }, (_, i) => ({ path: `skip/${i}.bin`, reason: "二进制" }));

test("project_manage init：标题写仓库目录名；摘要写状态、文件数、跳过数，结果截断了也不写「有截断」", () => {
  const args = wrap({ action: "init" });
  expect(draw(project, args, ok({ action: "init", status: "ready", files: 166, skipped, skippedCount: 11, diagnosticCount: 0, truncation: { truncated: true } })))
    .toEqual(["<b>初始化项目索引</b>  <muted>one-company</>", "完成  <muted>· 166 个文件</>  <muted>· 跳过 11 个</>"]);
  expect(draw(project, args, ok({ action: "init", status: "ready", files: 166, skipped, skippedCount: 11, diagnosticCount: 0, truncation: { truncated: false } }))[1]).toBe("完成  <muted>· 166 个文件</>  <muted>· 跳过 11 个</>");
  for (const [status, text] of [["partial", "完成"], ["invalid", "索引无效"], ["cancelled", "已取消"]]) {
    expect(draw(project, wrap({ action: "refresh" }), ok({ action: "refresh", status, files: 1, skipped: [], skippedCount: 0, diagnosticCount: 0, truncation: { truncated: false } }))[1]).toMatch(new RegExp(`^${text}  `));
  }
  expect(draw(project, wrap({ action: "refresh" }), ok({ action: "refresh", status: "ready", files: 1, skipped: [], skippedCount: 0, diagnosticCount: 0 }))[0]).toBe("<b>刷新项目索引</b>  <muted>one-company</>");
});

test("project_manage init 展开：有 skipped 的逐项清单", () => {
  const text = draw(project, wrap({ action: "init" }), ok({ action: "init", status: "ready", files: 166, skipped, truncation: { truncated: true } }), { expanded: true }).join("\n");
  expect(text).toContain("<muted>完整结果</>");
  for (const item of skipped) expect(text).toContain(item.path);
});

test("project_manage init 预览：写文件数和跳过数", () => {
  const files = Array.from({ length: 3 }, (_, i) => ({ path: `src/${i}.ts` }));
  expect(draw(project, wrap({ action: "init", preview: true }), ok({ action: "init", files, skipped: skipped.slice(0, 1) })))
    .toEqual(["<b>预览项目索引</b>  <muted>one-company</>", "预览  <muted>· 3 个文件</>  <muted>· 跳过 1 个</>"]);
});

test("project_manage status：没初始化，或按索引状态写六种说法", () => {
  const args = wrap({ action: "status" });
  expect(draw(project, args, ok({ action: "status", initialized: false }))).toEqual(["<b>项目索引状态</b>  <muted>one-company</>", "还没初始化"]);
  const names = { ready: "就绪", building: "建立中", partial: "部分完成", invalid: "无效", cancelled: "已取消", interrupted: "中断了" };
  for (const [status, text] of Object.entries(names)) expect(draw(project, args, ok({ action: "status", initialized: true, index: { status } }))[1]).toBe(text);
});

test("project_manage workspace-prepare：两行，第 2 行是 muted 的目录；分支去掉 refs/heads/", () => {
  const lines = draw(project, wrap({ action: "workspace-prepare", requirementId: REQ }), ok({ action: "workspace-prepare", status: "ready", branch: "refs/heads/req/lean", path: "/x/wt/lean" }));
  expect(lines[0]).toBe(`<b>准备需求工作区</b>  <muted>${TITLE}</>`);
  expect(lines[1]).toBe("就绪  <muted>· 分支 req/lean</>");
  expect(lines[2]!.trim()).toBe("<muted>/x/wt/lean</>");
  expect(lines).toHaveLength(3);
});

test("project_manage workspace-recycle、recovery-check、backup、restore、conventions-update 的摘要", () => {
  expect(draw(project, wrap({ action: "workspace-recycle", requirementId: REQ }), ok({ action: "workspace-recycle", status: "recycled" }))).toEqual([`<b>回收需求工作区</b>  <muted>${TITLE}</>`, "已回收"]);
  for (const [action, title] of [["recovery-check", "恢复核对"], ["backup", "备份"], ["restore", "恢复"]]) {
    const args = wrap({ action });
    const first = draw(project, args, ok({ action, status: "completed" }));
    expect(first).toEqual([`<b>${title}</b>  <muted>one-company</>`, "完成"]);
    for (const status of ["restart_ready", "reconciled"]) expect(draw(project, args, ok({ action, status }))[1]).toBe("完成");
    expect(draw(project, args, ok({ action, status: "needs_review" }))[1]).toBe("已恢复，待核对");
  }
  for (const [status, text] of [["written", "已写入"], ["unchanged", "内容没变"], ["cancelled", "没写入"], ["revise", "你要修改"]]) {
    expect(draw(project, wrap({ action: "conventions-update", content: "x" }), ok({ action: "conventions-update", status }))).toEqual(["<b>更新项目规范</b>  <muted>one-company</>", text]);
  }
});

test("project_manage 结果 blocked：摘要一律「没办成」加原因", () => {
  for (const action of ["init", "workspace-prepare", "conventions-update", "backup"]) {
    const lines = draw(project, wrap({ action, requirementId: REQ, content: "x" }), ok({ action, status: "blocked", reason: "仓库有未提交的改动", next: "先处理" }));
    expect(lines[1]).toBe("没办成  <muted>· 仓库有未提交的改动</>");
    expect(lines).toHaveLength(2);
  }
});

test("project_manage 窗口没就绪时仓库标签写「仓库 前8位」", () => {
  window.repos = undefined;
  try {
    expect(draw(project, wrap({ action: "status" }))).toEqual([`<b>项目索引状态</b>  <muted>仓库 ${REPO.slice(0, 8)}</>`]);
  } finally {
    window.repos = [{ repoId: REPO, path: "/x/one-company" }];
  }
});

test("knowledge_query：四种查法的标题和同一种摘要", () => {
  const page = (facts: number, nextCursor: string | null) => ok({ facts: Array.from({ length: facts }, (_, i) => ({ id: String(i) })), nextCursor });
  const search = { repoId: REPO, query: { action: "search", text: "approvalScope" } };
  expect(draw(knowledge, search, page(12, null))).toEqual(["<b>查代码</b>  <muted>搜索「approvalScope」</>", "找到 12 条  <muted>· 已读完</>"]);
  expect(draw(knowledge, search, page(20, "cur"))[1]).toBe("找到 20 条  <muted>· 还有下一页</>");
  expect(draw(knowledge, { repoId: REPO, query: { action: "exact", value: "registerTool" } }, page(1, null))).toEqual(["<b>查代码</b>  <muted>registerTool</>", "找到 1 条  <muted>· 已读完</>"]);
  expect(draw(knowledge, { repoId: REPO, query: { action: "facts", text: "审批" } }, page(0, null))[0]).toBe("<b>查代码</b>  <muted>搜索「审批」</>");
  expect(draw(knowledge, { repoId: REPO, query: { action: "facts" } }, page(3, null))[0]).toBe("<b>查代码</b>  <muted>项目事实</>");
  expect(draw(knowledge, { repoId: REPO, query: { action: "next", cursor: "cur" } }, page(3, null))[0]).toBe("<b>查代码</b>  <muted>下一页</>");
});

test("进行中：只有 renderCall 时每个工具只有 1 行标题行", () => {
  expect(draw(project, wrap({ action: "init" }))).toEqual(["<b>初始化项目索引</b>  <muted>one-company</>"]);
  expect(draw(agent, { action: "sources", runId: RUN })).toEqual(["<b>检索来源</b>  <muted>编号 01a1bdf1</>"]);
  expect(draw(prototype, wrap({ action: "confirm", requirementId: REQ, name: PROTO }))).toEqual([`<b>确认原型</b>  <muted>${PROTO}</>`]);
  expect(draw(git, { repoId: REPO, requirementId: REQ })).toEqual([`<b>交付</b>  <muted>${TITLE}</>`]);
  expect(draw(workflow, { action: "status", repoId: REPO, requirementId: REQ })).toHaveLength(1);
  expect(draw(knowledge, { repoId: REPO, query: { action: "facts" } })).toEqual(["<b>查代码</b>  <muted>项目事实</>"]);
});

test("失败：确认原型只写原因一行，不含建议；取检索来源失败同样", () => {
  const text = `one_company_prototype 的 confirm 动作失败。\n原因：原型「${PROTO}」没有待你确认的版本，当前第 3 版已通过\n建议：刷新后按看板当前状态操作`;
  const lines = draw(prototype, wrap({ action: "confirm", requirementId: REQ, name: PROTO }), { content: [{ type: "text", text }] }, { isError: true, width: 120 });
  expect(lines).toEqual([`<b>确认原型</b>  <muted>${PROTO}</>`, `<error>失败：原型「${PROTO}」没有待你确认的版本，当前第 3 版已通过</>`]);
  expect(lines.join("\n")).not.toContain("建议");
  const sources = "one_company_agent_manage 的 sources 动作失败。\n原因：本会话里没有这个编号的检索结果\n建议：核对运行编号";
  expect(draw(agent, { action: "sources", runId: RUN }, { content: [{ type: "text", text: sources }] }, { isError: true })[1]).toBe("<error>失败：本会话里没有这个编号的检索结果</>");
});

test("失败展开：有调用参数和完整结果，工具卡片失败时不读 details", () => {
  const text = "one_company_git_deliver 失败。\n原因：需求没有归档\n建议：先关闭";
  const lines = draw(git, { repoId: REPO, requirementId: REQ }, { content: [{ type: "text", text }] }, { isError: true, expanded: true });
  expect(lines[1]).toBe("<error>失败：需求没有归档</>");
  expect(lines.join("\n")).toContain("<muted>调用参数</>");
});

test("标题很长时被截断成一行，加省略号，不超过终端宽度", () => {
  const long = "很长的检索问题".repeat(30);
  const lines = draw(agent, plain({ action: "dispatch", role: "explore", question: long, clues: [], maxTurns: 18 }), ok({ runId: RUN, maxTurns: 18 }), { theme: plainTheme as never });
  expect(lines[0]!.endsWith("…")).toBe(true);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
});

test("所有收起用例不超过 3 行，全部输出没有 dim", () => {
  expect(seen.length).toBeGreaterThan(40);
  for (const item of seen) {
    for (const line of item.lines) expect(line).not.toContain("<dim>");
    if (item.collapsed) expect(item.lines.length).toBeLessThanOrEqual(3);
  }
});

test("假 pi 记下的消息渲染器只有 one-company.explore-result", () => {
  expect(fake.messageRendererTypes()).toEqual(["one-company.explore-result"]);
});
