import { expect, test } from "vitest";
import { registerAgentManageTool, registerExploreDelivery } from "../src/modules/explore/agent-manage-extension.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { draw, markTheme, ok } from "./helpers/card-draw.ts";
import type { CardTool } from "./helpers/card-draw.ts";

const RUN = "01a1bdf1-abe9-7aa8-a969-2a66887b6230";
const RUN_UNASKED = "01a1c000-abe9-7aa8-a969-2a66887b6230";
const QUESTION = "OpenAI 的 Responses 接口怎么处理工具调用的流式输出";

const fake = createFakePi();
registerAgentManageTool(fake.pi as never, () => ({ clients: {} as never }));
registerExploreDelivery(fake.pi as never, async () => ({ clients: {} as never, repoIds: [] }));
const agent = fake.registeredTools().find((tool) => tool.name === "one_company_agent_manage") as unknown as CardTool;
const renderer = fake.messageRenderer("one-company.explore-result")!;

const web = (extra: Record<string, unknown> = {}) => ({
  conclusions: Array.from({ length: 6 }, (_, i) => `结论正文 ${i}`),
  sources: Array.from({ length: 8 }, (_, i) => ({ url: `https://example.com/${i}`, retrievedAt: "2026-11-10T00:00:00Z", quote: `来源摘录 ${i}` })),
  searchedScope: { kind: "web", queries: Array.from({ length: 9 }, (_, i) => `词 ${i}`) },
  notFound: ["a", "b"], unknown: ["c", "d", "e"], failures: [], truncation: { truncated: true, reasons: ["网页过长"] }, ...extra,
});
const reportOf = (runId: string, research: unknown, extra: Record<string, unknown> = {}) => ({ kind: "explore-report", runId, outcome: "completed", turnsUsed: 13, research, ...extra });
const messageOf = (details: unknown) => ({ customType: "one-company.explore-result", content: JSON.stringify({ runId: "x", conclusions: ["摘要"] }), details, display: true, timestamp: 1 });

function card(message: unknown, options: { expanded?: boolean; theme?: unknown; outputPad?: number; width?: number } = {}): string[] {
  const { expanded = false, theme = markTheme, outputPad = 1, width = 80 } = options;
  const component = renderer(message, { expanded, outputPad, keyHint: () => "", keyText: () => "" }, theme);
  return component.render(width).map((line) => line.trim()).filter((line) => line !== "");
}

function askFirst(runId: string): void {
  draw(agent, { action: "dispatch", role: "explore", repoId: "a".repeat(64), question: QUESTION, clues: [], maxTurns: 18 }, ok({ runId, maxTurns: 18 }));
}

test("没有派出检索卡片记下问题时，标题行对象名写「编号 前8位」", () => {
  expect(card(messageOf(reportOf(RUN_UNASKED, web())))[0]).toBe("<b>检索结果</b>  <muted>编号 01a1c000</>");
});

test("收起：3 行，标题写检索问题，不含任何结论正文", () => {
  askFirst(RUN);
  const message = messageOf(reportOf(RUN, web()));
  // 假主题的颜色标记会被算进行宽，放宽到 120 列才不被截断
  const lines = card(message, { width: 120 });
  expect(lines).toEqual([
    `<b>检索结果</b>  <muted>${QUESTION}</>`,
    "完成  <muted>· 13 轮</>  <muted>· 结论 6 条</>  <muted>· 来源 8 条</>",
    "<muted>· 没查到 2 条</>  <muted>· 没核实 3 条</>  <muted>· 网页没读全</>  <muted>· 编号 01a1bdf1</>",
  ]);
  expect(lines.join("\n")).not.toContain("结论正文");
  expect(lines.join("\n")).not.toContain("<dim>");
});

test("计数为 0：没查到、没核实为空且没截断时，第 2 行只有编号", () => {
  const research = web({ notFound: [], unknown: [], truncation: { truncated: false, reasons: [] } });
  expect(card(messageOf(reportOf(RUN, research)))[2]).toBe("<muted>· 编号 01a1bdf1</>");
  expect(card(messageOf(reportOf(RUN, web({ notFound: ["a"], unknown: [], truncation: { truncated: false, reasons: [] } }))))[2]).toBe("<muted>· 没查到 1 条</>  <muted>· 编号 01a1bdf1</>");
});

test("本地检索被截断时写「文件没读全」", () => {
  const research = web({
    sources: [{ path: "/x/a.ts", startLine: 1, endLine: 2, quote: "q" }],
    searchedScope: { kind: "local_file", paths: ["/x/a.ts"] }, notFound: [], unknown: [],
  });
  const lines = card(messageOf(reportOf(RUN, research)));
  expect(lines[1]).toBe("完成  <muted>· 13 轮</>  <muted>· 结论 6 条</>  <muted>· 来源 1 条</>");
  expect(lines[2]).toBe("<muted>· 文件没读全</>  <muted>· 编号 01a1bdf1</>");
});

test("没交结果：research 为 null 时第 2 行写错误红的原因，共 2 行", () => {
  const reason = "未提交 research，没有可用结果：用完轮次上限仍没有提交结果";
  expect(card(messageOf(reportOf(RUN, null, { outcome: "turn_limit_reached", reason, next: "重派", log: "/x/log" })))).toEqual([
    `<b>检索结果</b>  <muted>${QUESTION}</>`,
    "<error>没有结果：用完轮次上限仍没有提交结果</>",
  ]);
});

test("没交结果：原因本身带「：」时只切掉第一个「：」之前的部分", () => {
  const reason = "未提交 research，没有可用结果：会话出错：连接断开";
  expect(card(messageOf(reportOf(RUN, null, { outcome: "failed", reason })))[1]).toBe("<error>没有结果：会话出错：连接断开</>");
});

test("展开：有完整结果和来源摘录原文，没有调用参数；再收起回到 3 行", () => {
  const message = messageOf(reportOf(RUN, web()));
  const open = card(message, { expanded: true }).join("\n");
  expect(open).toContain("<muted>完整结果</>");
  expect(open).toContain("来源摘录 7");
  expect(open).not.toContain("调用参数");
  expect(card(message, { expanded: false })).toHaveLength(3);
});

test("卡片自己铺 customMessageBg 底色：每行都有底色，上下各 1 行空行，左右边距用 outputPad", () => {
  const theme = { ...markTheme, bg: (kind: string, text: string) => `[${kind}]${text}` };
  const message = messageOf(reportOf(RUN, web()));
  const draw80 = (outputPad: number) => renderer(message, { expanded: false, outputPad, keyHint: () => "", keyText: () => "" }, theme).render(80);
  const lines = draw80(1);
  for (const line of lines) expect(line.startsWith("[customMessageBg]")).toBe(true);
  expect(lines[0]!.replace("[customMessageBg]", "").trim()).toBe("");
  expect(lines.at(-1)!.replace("[customMessageBg]", "").trim()).toBe("");
  expect(lines).toHaveLength(5);
  expect(lines[1]!.replace("[customMessageBg]", "")).toMatch(/^ <b>检索结果<\/b>/);
  expect(draw80(3)[1]!.replace("[customMessageBg]", "")).toMatch(/^ {3}<b>检索结果<\/b>/);
});

test("发给模型的内容不变：消息对象收起、展开、收起渲染后与渲染前深相等", () => {
  const message = messageOf(reportOf(RUN, web()));
  const before = structuredClone(message);
  card(message);
  card(message, { expanded: true });
  card(message);
  expect(message).toEqual(before);
});
