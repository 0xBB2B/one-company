import { expect, test } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRequirementManageTool } from "../src/modules/interaction/requirement-manage-tool.ts";
import { createUserInteractTool } from "../src/modules/interaction/user-interact-tool.ts";

const markTheme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>`, bg: (_kind: string, text: string) => text };
const plainTheme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text, bg: (_kind: string, text: string) => text };
const REPO = "a".repeat(64);
const COMMIT = "b81db5973f940277e660000ad15af8adb8c2631f";
const TITLE = "跨平台 Codex 桌面应用中台模型接入与更新工具";
const manage = createRequirementManageTool({ interaction: {} as never });
const interact = createUserInteractTool({ interaction: {} as never });
type Tool = typeof manage | typeof interact;
type Result = { content: Array<{ type: "text"; text: string }>; details?: unknown };
const seen: Array<{ lines: string[]; collapsed: boolean }> = [];
let serial = 0;
function requirementId(): string {
  serial += 1;
  return `01a1aaf0-9038-77ec-99a8-${serial.toString(16).padStart(12, "0")}`;
}

function draw(tool: Tool, args: unknown, result?: Result, options: { expanded?: boolean; isError?: boolean; isPartial?: boolean; theme?: typeof markTheme; width?: number } = {}): string[] {
  const { expanded = false, isError = false, isPartial = false, theme = markTheme, width = 80 } = options;
  const context = { args, state: {} as Record<string, unknown>, isError, expanded, isPartial, invalidate: () => {} } as never;
  const lines = (): string[] => [
    ...tool.renderCall!(args as never, theme as never, context).render(width),
    ...(result ? tool.renderResult!(result as never, { expanded, isPartial }, theme as never, context).render(width) : []),
  ].map((line) => line.trimEnd());
  lines();
  const out = lines();
  seen.push({ lines: out, collapsed: !expanded });
  return out;
}
const ok = (details: unknown): Result => ({ content: [{ type: "text", text: "给模型的内容" }], details });
const manageArgs = (request: Record<string, unknown>) => ({ request: { repoId: REPO, ...request } });

function updateDraftCase(status: string, version = 14) {
  const id = requirementId();
  const args = manageArgs({ action: "updateDraft", requirementId: id, version: 13, summary: "s", title: TITLE, body: "b" });
  const details = { action: "updateDraft", operationId: requirementId(), requirementId: id, commit: COMMIT, prdHash: "h", status, archivePath: "p", lifecycle: "draft", version, epoch: 1, revision: 0 };
  return { id, args, details };
}

test("进行中：只有 renderCall 时只有标题行，renderResult 收到 isPartial 时渲染 0 行", () => {
  const { args } = updateDraftCase("saved");
  expect(draw(manage, args)).toEqual([`<b>修改需求草稿</b>  <muted>${TITLE}</>`]);
  const context = { args, state: {}, isError: false, expanded: false, isPartial: true, invalidate: () => {} } as never;
  manage.renderCall!(args as never, markTheme as never, context);
  expect(manage.renderResult!({ content: [], details: undefined } as never, { expanded: false, isPartial: true }, markTheme as never, context).render(80)).toEqual([]);
});

test("updateDraft 三种状态的摘要", () => {
  for (const [status, text] of [["saved", "已保存"], ["unchanged", "没有改动"], ["recovered", "已续完"]]) {
    const { args, details } = updateDraftCase(status);
    expect(draw(manage, args, ok(details))).toEqual([`<b>修改需求草稿</b>  <muted>${TITLE}</>`, `${text}  <muted>· 第 14 版</>`]);
  }
});

test("create 的标题行用参数 title，摘要按 status；结果里的需求编号登记标题供后续卡片使用", () => {
  for (const [status, text] of [["created", "已创建"], ["recovered", "已续完"]]) {
    const id = requirementId();
    const args = manageArgs({ action: "create", summary: "s", title: TITLE, body: "b" });
    const details = { action: "create", operationId: requirementId(), requirementId: id, commit: COMMIT, prdHash: "h", status, archivePath: "p", lifecycle: "draft", version: 1, epoch: 1, revision: 0 };
    expect(draw(manage, args, ok(details))).toEqual([`<b>新建需求</b>  <muted>${TITLE}</>`, `${text}  <muted>· 第 1 版</>`]);
    expect(draw(manage, manageArgs({ action: "metadata", requirementId: id }))[0]).toBe(`<b>需求状态</b>  <muted>${TITLE}</>`);
  }
});

test("updateDraft 把参数 requirementId 对应的标题登记到表里", () => {
  const { id, args, details } = updateDraftCase("saved");
  draw(manage, args, ok(details));
  expect(draw(manage, manageArgs({ action: "confirmUpdate", requirementId: id, savedOperationId: requirementId(), version: 14 }))[0]).toBe(`<b>确认更新</b>  <muted>${TITLE}</>`);
});

function readCase(action: "read" | "next", coverage: Record<string, unknown>, version = 13) {
  const id = requirementId();
  const request = action === "read" ? { action, requirementId: id } : { action, requirementId: id, cursor: "c".repeat(64) };
  return { id, args: manageArgs(request), details: { requirementId: id, title: TITLE, version, text: "正文", coverage: { startByte: 0, endByte: 2458, totalBytes: 2458, complete: true, nextCursor: null, blocking: [], ...coverage } } };
}

test("next 读到最后一页（起始字节大于 0、没有下一页游标）时写已读完", () => {
  const last = readCase("next", { startByte: 8192, endByte: 9216, complete: false, nextCursor: null });
  expect(draw(manage, last.args, ok(last.details))[1]).toBe("第 13 版  <muted>· 读了 1.0 KB</>  <muted>· 已读完</>");
});

test("标题里带换行时卡片仍是一行标题，收起不超过 3 行", () => {
  const id = requirementId();
  const args = manageArgs({ action: "create", summary: "s", title: "第一行\n第二行\n第三行\n第四行", body: "b" });
  const lines = draw(manage, args, ok({ requirementId: id, version: 1, operationId: id, revision: 0, status: "saved" }));
  expect(lines.length).toBeLessThanOrEqual(3);
  for (const line of lines) expect(line).not.toContain("\n");
  expect(lines[0]).toContain("第一行 第二行 第三行 第四行");
});

test("read、next 的摘要：版本、KB（保留一位小数）、已读完或还有下一页", () => {
  for (const action of ["read", "next"] as const) {
    const done = readCase(action, {});
    expect(draw(manage, done.args, ok(done.details))).toEqual([`<b>读需求</b>  <muted>${TITLE}</>`, "第 13 版  <muted>· 读了 2.4 KB</>  <muted>· 已读完</>"]);
    const more = readCase(action, { startByte: 100, endByte: 1124, complete: false, nextCursor: "d".repeat(64) });
    expect(draw(manage, more.args, ok(more.details))[1]).toBe("第 13 版  <muted>· 读了 1.0 KB</>  <muted>· 还有下一页</>");
  }
});

test("read 结果回来前标题行写「需求 前8位」，结果回来后换成需求标题", () => {
  const { id, args, details } = readCase("read", {});
  expect(draw(manage, args)).toEqual([`<b>读需求</b>  <muted>需求 ${id.slice(0, 8)}</>`]);
  expect(draw(manage, args, ok(details))[0]).toBe(`<b>读需求</b>  <muted>${TITLE}</>`);
});

test("标题原地换：ToolExecutionComponent 里 read 卡片结果回来后标题只出现 1 次，不留旧标题，同编号的 metadata 卡片直接显示标题", () => {
  initTheme("dark");
  const { id, args, details } = readCase("read", {});
  const component = new ToolExecutionComponent(manage.name, "call", args, undefined, manage, { requestRender: () => {} } as never, "/");
  const text = () => component.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(text()).toContain(`需求 ${id.slice(0, 8)}`);
  component.updateResult({ content: [{ type: "text", text: "x" }], details, isError: false } as never);
  expect(text().split(TITLE).length - 1).toBe(1);
  expect(text()).not.toContain(`需求 ${id.slice(0, 8)}`);
  const meta = new ToolExecutionComponent(manage.name, "call2", manageArgs({ action: "metadata", requirementId: id }), undefined, manage, { requestRender: () => {} } as never, "/");
  expect(meta.render(80).join("\n")).toContain(TITLE);
});

test("diff 的摘要：版本区间与是否读完；查不到标题时标题行用「需求 前8位」", () => {
  const id = requirementId();
  const args = manageArgs({ action: "diff", requirementId: id, fromRevision: 2, toRevision: 3 });
  const base = { requirementId: id, fromRevision: 2, toRevision: 3 };
  expect(draw(manage, args, ok({ ...base, coverage: { startByte: 0, endByte: 10, totalBytes: 10, complete: true, nextCursor: null, blocking: [] } })))
    .toEqual([`<b>对比需求修订</b>  <muted>需求 ${id.slice(0, 8)}</>`, "第 2 版 → 第 3 版  <muted>· 已读完</>"]);
  expect(draw(manage, args, ok({ ...base, coverage: { startByte: 0, endByte: 10, totalBytes: 20, complete: false, nextCursor: "e".repeat(64), blocking: [] } }))[1])
    .toBe("第 2 版 → 第 3 版  <muted>· 还有下一页</>");
});

test("metadata 的摘要：生命周期、版本、未确认段数；没有待确认时不写第三项", () => {
  const id = requirementId();
  const args = manageArgs({ action: "metadata", requirementId: id });
  const pending = [{ unitId: "A" }, { unitId: "B" }];
  expect(draw(manage, args, ok({ requirementId: id, lifecycle: "draft", version: 8, approvalScope: { summary: { pending } } })).at(-1)).toBe("草稿  <muted>· 第 8 版</>  <muted>· 还有 2 段没确认</>");
  expect(draw(manage, args, ok({ requirementId: id, lifecycle: "active", version: 8, approvalScope: { summary: { pending: [] } } })).at(-1)).toBe("已生效  <muted>· 第 8 版</>");
  expect(draw(manage, args, ok({ requirementId: id, lifecycle: "closing", version: 9 })).at(-1)).toBe("关闭中  <muted>· 第 9 版</>");
  expect(draw(manage, args, ok({ requirementId: id, lifecycle: "closed", version: 9 })).at(-1)).toBe("已关闭  <muted>· 第 9 版</>");
});

test("confirmUpdate 的摘要：生效、没生效带原因、没生效没原因", () => {
  const id = requirementId();
  const args = manageArgs({ action: "confirmUpdate", requirementId: id, savedOperationId: requirementId(), version: 16 });
  expect(draw(manage, args, ok({ requirementId: id, prdActivated: true, version: 16 })).at(-1)).toBe("<success>需求已生效</>  <muted>· 第 16 版</>");
  expect(draw(manage, args, ok({ requirementId: id, prdActivated: false, version: 16, blockedReason: "还有段落没确认" })).at(-1)).toBe("没生效  <muted>· 还有段落没确认</>");
  expect(draw(manage, args, ok({ requirementId: id, prdActivated: false, version: 16 })).at(-1)).toBe("没生效");
});

test("list 的摘要：参数无 repoId 时对象名是「本窗口」，并登记每一项的标题", () => {
  const ids = [requirementId(), requirementId(), requirementId()];
  const requirements = ids.map((requirementId, i) => ({ requirementId, repoId: REPO, title: `需求${i}`, lifecycle: "draft" }));
  expect(draw(manage, { request: { action: "list" } }, ok({ requirements }))).toEqual(["<b>列出需求</b>  <muted>本窗口</>", "3 个需求"]);
  expect(draw(manage, manageArgs({ action: "metadata", requirementId: ids[1] }))[0]).toBe("<b>需求状态</b>  <muted>需求1</>");
});

test("list 带 repoId 而窗口没启动时，对象名是「仓库 前8位」", () => {
  const repoId = "4ba2e0aa" + "0".repeat(56);
  expect(draw(manage, manageArgs({ action: "list", repoId }), ok({ requirements: [] }))).toEqual(["<b>列出需求</b>  <muted>仓库 4ba2e0aa</>", "0 个需求"]);
});

test("user_interact 的 user-confirmation reply 画成确认更新卡片", () => {
  const id = requirementId();
  const args = { request: { action: "reply", repoId: REPO, requirementId: id, savedOperationId: requirementId(), version: 16 } };
  expect(draw(interact, args, ok({ requirementId: id, prdActivated: true, version: 16 }))).toEqual([`<b>确认更新</b>  <muted>需求 ${id.slice(0, 8)}</>`, "<success>需求已生效</>  <muted>· 第 16 版</>"]);
  expect(draw(interact, { request: { ...args.request, purpose: "user-confirmation" } }, ok({ requirementId: id, prdActivated: false, version: 16, blockedReason: "原因甲" })).at(-1)).toBe("没生效  <muted>· 原因甲</>");
});

test("adjudicate reply 的摘要：登记了的八种决定，没登记时写 next", () => {
  const id = requirementId();
  const args = { request: { purpose: "adjudicate", action: "reply", repoId: REPO, requirementId: id, itemId: `task:${requirementId()}`, itemVersion: `task:${requirementId()}:1` } };
  const labels = { retry: "再给一次机会", adjust: "调整目标或范围", keep: "保持不拆", terminate: "终止任务", cancel: "取消需求", reject: "拒绝需求", accept: "验收通过", rework: "返工" };
  expect(draw(interact, args)).toEqual([`<b>登记决定</b>  <muted>需求 ${id.slice(0, 8)}</>`]);
  for (const [choice, label] of Object.entries(labels)) {
    expect(draw(interact, args, ok({ status: "recorded", decisionId: requirementId(), choice })).at(-1)).toBe(`已登记  <muted>· ${label}</>`);
  }
  expect(draw(interact, args, ok({ status: "unclear", next: "请向用户确认后重试" })).at(-1)).toBe("没登记  <muted>· 请向用户确认后重试</>");
});

test("展开：摘要后依次是空行、调用参数、参数 JSON（去掉 request）、空行、完整结果、完整结果 JSON；再收起回到 2 行", () => {
  const { args, details } = updateDraftCase("saved");
  const result = ok(details);
  const lines = draw(manage, args, result, { expanded: true });
  expect(lines.slice(0, 2)).toEqual([`<b>修改需求草稿</b>  <muted>${TITLE}</>`, "已保存  <muted>· 第 14 版</>"]);
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe("<muted>调用参数</>");
  expect(lines[4]).toBe("{");
  const resultAt = lines.indexOf("<muted>完整结果</>");
  expect(lines[resultAt - 1]).toBe("");
  expect(lines.slice(4, resultAt - 1).join("\n")).not.toContain('"request"');
  expect(lines.slice(4, resultAt - 1).join("\n")).toContain('"action": "updateDraft"');
  expect(lines[resultAt + 1]).toBe("{");
  expect(lines.slice(resultAt + 1).join("\n")).toContain(`  "commit": "${COMMIT}"`);
  expect(draw(manage, args, result, { expanded: false })).toHaveLength(2);
});

test("失败：标题行加一行红字「失败：原因」，不含建议；展开后有调用参数和完整报错原文", () => {
  const id = requirementId();
  const args = manageArgs({ action: "confirmUpdate", requirementId: id, savedOperationId: requirementId(), version: 16 });
  const text = "one_company_requirement_manage 的 confirmUpdate 动作失败。\n原因：草稿已经被改过，要确认的不是最新一版\n建议：重新读取需求后按最新版本再试";
  const failed: Result = { content: [{ type: "text", text }] };
  const lines = draw(manage, args, failed, { isError: true });
  expect(lines).toEqual([`<b>确认更新</b>  <muted>需求 ${id.slice(0, 8)}</>`, "<error>失败：草稿已经被改过，要确认的不是最新一版</>"]);
  const open = draw(manage, args, failed, { isError: true, expanded: true });
  const joined = open.join("\n");
  expect(open.slice(0, 2)).toEqual(lines);
  expect(joined).toContain("<muted>调用参数</>");
  expect(joined).toContain("<muted>完整结果</>");
  expect(joined).toContain("原因：草稿已经被改过，要确认的不是最新一版");
  expect(joined).toContain("建议：重新读取需求后按最新版本再试");
});

test("失败文字没有「原因：」时取第一行（pi 在执行前报的参数错误）", () => {
  const args = manageArgs({ action: "list" });
  const lines = draw(manage, args, { content: [{ type: "text", text: "Validation failed for tool\n第二行" }] }, { isError: true });
  expect(lines.at(-1)).toBe("<error>失败：Validation failed for tool</>");
});

test("窄终端：标题 200 字的卡片 render(24) 不超过 3 行，被截的行以「…」结尾，每行宽度不超过 24", () => {
  const longTitle = "长".repeat(200);
  const { args, details } = updateDraftCase("saved");
  (args.request as { title: string }).title = longTitle;
  const lines = draw(manage, args, ok(details), { theme: plainTheme as never, width: 24 });
  expect(lines.length).toBeLessThanOrEqual(3);
  expect(lines[0]!.endsWith("…")).toBe(true);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
});

test("收起的卡片在 80 列下都不超过 3 行，且不打 dim，颜色只用 muted、success、error", () => {
  expect(seen.length).toBeGreaterThan(10);
  for (const { lines, collapsed } of seen) {
    if (collapsed) expect(lines.length).toBeLessThanOrEqual(3);
    const kinds = new Set(lines.join("\n").match(/<(?!b>|\/>)[a-z]+>/g) ?? []);
    for (const kind of kinds) expect(["<muted>", "<success>", "<error>"]).toContain(kind);
    expect(lines.join("\n")).not.toContain("<dim>");
  }
});

test("渲染不改发给模型的内容：收起、展开、收起前后结果对象深相等，ToolExecutionComponent 切换展开也一样", () => {
  initTheme("dark");
  const { args, details } = updateDraftCase("saved");
  const result = ok(details);
  const before = structuredClone(result);
  draw(manage, args, result);
  draw(manage, args, result, { expanded: true });
  draw(manage, args, result);
  expect(result).toEqual(before);
  const component = new ToolExecutionComponent(manage.name, "call", args, undefined, manage, { requestRender: () => {} } as never, "/");
  const given = { content: result.content, details: result.details, isError: false };
  const copy = structuredClone(given);
  component.updateResult(given as never);
  component.setExpanded(true);
  component.render(80);
  component.setExpanded(false);
  component.render(80);
  expect(given).toEqual(copy);
});
