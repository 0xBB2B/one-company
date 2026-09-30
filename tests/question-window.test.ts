import { expect, test } from "vitest";
import { chooseWindow, confirmWindow, QuestionWindowView } from "../runtime/question-window.ts";
import type { WindowAnswer, WindowHost } from "../runtime/question-window.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", ENTER = "\r", ESC = "\x1b", SPACE = " ", BACKSPACE = "\x7f";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };

function view(options: Omit<ConstructorParameters<typeof QuestionWindowView>[0], "theme" | "onDone">) {
  const done: Array<WindowAnswer[] | undefined> = [];
  const window = new QuestionWindowView({ ...options, theme, onDone: (answers) => done.push(answers) });
  return { window, done, text: (width = 80) => window.render(width).join("\n") };
}

test("程序确认窗口：边框与标题用警告色，需求名正常色，其余说明灰色，改动行分红绿，按钮与提示全中文", () => {
  const { text } = view({ tone: "warning", questions: [{ question: "确认更新项目规范 AGENTS.md", choices: [{ label: "确认" }, { label: "取消" }],
    lines: [{ text: "需求：角色跳跃" }, { text: "编号：0192", tone: "muted" }, { text: "+ 新增一行", tone: "added" }, { text: "- 删除一行", tone: "removed" }] }] });
  const rendered = text();
  expect(rendered).toContain("<warning>" + "─".repeat(80) + "</>");
  expect(rendered).toContain("<warning><b>确认更新项目规范 AGENTS.md</b></>");
  expect(rendered).toMatch(/^ 需求：角色跳跃$/mu);
  expect(rendered).toContain("<muted>编号：0192</>");
  expect(rendered).toContain("<toolDiffAdded>+ 新增一行</>");
  expect(rendered).toContain("<toolDiffRemoved>- 删除一行</>");
  expect(rendered).toContain("<warning>→ 确认</>");
  expect(rendered).toMatch(/^ {3}取消$/mu);
  expect(rendered).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 取消</>");
  expect(rendered).not.toMatch(/Yes|No|navigate/u);
});

test("程序确认窗口：回车选中当前项，↓ 后回车选取消，Esc 等于取消且没有答案", () => {
  const confirm = view({ tone: "warning", questions: [{ question: "批准需求", choices: [{ label: "确认" }, { label: "取消" }] }] });
  confirm.window.handleInput(ENTER);
  expect(confirm.done).toEqual([[{ choices: ["确认"] }]]);
  const cancel = view({ tone: "warning", questions: [{ question: "批准需求", choices: [{ label: "确认" }, { label: "取消" }] }] });
  cancel.window.handleInput(DOWN); cancel.window.handleInput(ENTER);
  expect(cancel.done).toEqual([[{ choices: ["取消"] }]]);
  const escape = view({ tone: "warning", questions: [{ question: "批准需求", choices: [{ label: "确认" }, { label: "取消" }] }] });
  escape.window.handleInput(ESC);
  expect(escape.done).toEqual([undefined]);
});

test("程序选择窗口：选项说明和选项写在同一行并用灰色", () => {
  const { text } = view({ tone: "warning", questions: [{ question: "PR 已就绪，怎么合并？",
    choices: [{ label: "自己 review", description: "PR 留着等你看" }, { label: "自动合并", description: "等检查通过后合并" }] }] });
  expect(text()).toMatch(/<warning>→ 自己 review<\/> +<muted>PR 留着等你看<\/>/u);
  expect(text()).toMatch(/^ {3}自动合并 +<muted>等检查通过后合并<\/>$/mu);
  const withNote = view({ tone: "warning", questions: [{ question: "PR 已就绪，怎么合并？", cancelNote: "取消等于自己 review", choices: [{ label: "自己 review" }] }] });
  expect(withNote.text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 取消（取消等于自己 review）</>");
});

test("通用问答窗口：多个问题用顶部标签切换，选项编号、推荐标记与下一行灰色说明，单选回车后跳到下一题", () => {
  const { window, text, done } = view({ tone: "standard", questions: [
    { header: "接口格式", question: "用哪种返回格式？", choices: [{ label: "统一 {code, data}", description: "改动集中在后端", recommended: true }, { label: "沿用现有格式" }] },
    { header: "登录方式", question: "支持哪些登录方式？", multiSelect: true, choices: [{ label: "邮箱登录" }, { label: "手机号验证码" }, { label: "微信登录" }] },
  ] });
  const first = text();
  expect(first).toContain("<border>" + "─".repeat(80) + "</>");
  expect(first).toMatch(/<accent><b> 接口格式 <\/b><\/>.*<muted> 登录方式 <\/>.*<muted> 提交 <\/>/u);
  expect(first).toContain("<b>用哪种返回格式？</b>");
  expect(first).toContain("<accent>→ 1. 统一 {code, data}（推荐）</>");
  expect(first).toMatch(/^ {6}<muted>改动集中在后端<\/>$/mu);
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  const second = text();
  expect(second).toContain("<success> ✓ 接口格式 </>");
  expect(second).toContain("<accent>→ [ ] 1. 邮箱登录</>");
  window.handleInput(SPACE); window.handleInput(DOWN); window.handleInput(SPACE);
  expect(text()).toContain("[x] 2. 手机号验证码");
  window.handleInput(ENTER);
  const review = text();
  expect(review).toContain("接口格式：统一 {code, data}");
  expect(review).toContain("登录方式：邮箱登录、手机号验证码");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: ["统一 {code, data}"] }, { choices: ["邮箱登录", "手机号验证码"] }]]);
});

test("通用问答窗口：←→ 切换问题，提交页可取消；只有一题时没有标签页也没有提交页", () => {
  const multi = view({ tone: "standard", questions: [
    { header: "甲", question: "问题甲", choices: [{ label: "a" }] }, { header: "乙", question: "问题乙", choices: [{ label: "b" }] }] });
  multi.window.handleInput(RIGHT);
  expect(multi.text()).toContain("<b>问题乙</b>");
  multi.window.handleInput(LEFT);
  expect(multi.text()).toContain("<b>问题甲</b>");
  multi.window.handleInput(RIGHT); multi.window.handleInput(RIGHT);
  expect(multi.text()).toContain("核对你的回答");
  multi.window.handleInput(DOWN); multi.window.handleInput(ENTER);
  expect(multi.done).toEqual([undefined]);
  const single = view({ tone: "standard", questions: [{ header: "甲", question: "问题甲", choices: [{ label: "a" }, { label: "b" }] }] });
  expect(single.text()).not.toContain("提交");
  single.window.handleInput(DOWN); single.window.handleInput(UP); single.window.handleInput(ENTER);
  expect(single.done).toEqual([[{ choices: ["a"] }]]);
});

test("通用问答窗口：其他（自己输入）进入输入行，退格可删，空内容不能确认，Esc 回到选项并保留已输入的文字", () => {
  const { window, text, done } = view({ tone: "standard", questions: [{ question: "用哪种格式？", allowOther: true, choices: [{ label: "统一" }] }] });
  window.handleInput(DOWN);
  expect(text()).toContain("<accent>→ 2. 其他（自己输入）</>");
  window.handleInput(ENTER);
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  for (const char of "后端统一x") window.handleInput(char);
  window.handleInput(BACKSPACE);
  expect(text()).toContain("<accent>›</> 后端统一");
  expect(text()).toContain("<muted>输入后回车确认 · Esc 返回选项</>");
  window.handleInput(ESC);
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 取消</>");
  expect(done).toEqual([]);
  window.handleInput(ENTER);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "后端统一" }]]);
});

test("长说明按窗口宽度折行，不超出宽度", () => {
  const { window } = view({ tone: "warning", questions: [{ question: "确认", lines: [{ text: "很长的路径".repeat(20), tone: "muted" }], choices: [{ label: "确认" }] }] });
  const plain = window.render(40).map((line) => line.replace(/<\/?[a-zA-Z]*>/gu, ""));
  expect(plain.filter((line) => line.includes("很长的路径")).length).toBeGreaterThan(1);
});

type Keys = { handleInput(data: string): void };
function fakeUi(script: (component: Keys) => void, hasUI = true): WindowHost & { shown: number } {
  const host = { hasUI, shown: 0, ui: { custom<T>(factory: (...args: unknown[]) => unknown) {
    host.shown++;
    return new Promise<T>((resolve) => {
      const component = factory({ requestRender() {} }, theme, undefined, resolve) as Keys;
      script(component);
    });
  } } } as unknown as WindowHost & { shown: number };
  return host;
}

test("confirmWindow 只有选中确认才返回 true；取消、Esc、没有界面、被中止都返回 false", async () => {
  const request = { title: "确认创建需求工作区", lines: [{ text: "需求：角色跳跃" }] };
  expect(await confirmWindow(fakeUi((c) => c.handleInput(ENTER)), request)).toBe(true);
  expect(await confirmWindow(fakeUi((c) => { c.handleInput(DOWN); c.handleInput(ENTER); }), request)).toBe(false);
  expect(await confirmWindow(fakeUi((c) => c.handleInput(ESC)), request)).toBe(false);
  const headless = fakeUi(() => {}, false);
  expect(await confirmWindow(headless, request)).toBe(false);
  expect(headless.shown).toBe(0);
  const abort = new AbortController();
  const pending = confirmWindow(fakeUi(() => {}), request, abort.signal);
  abort.abort();
  expect(await pending).toBe(false);
});

test("chooseWindow 返回选中项的名字，Esc 返回 undefined", async () => {
  const request = { title: "复制到", lines: [], choices: [{ label: "用户层", description: "/u" }, { label: "项目层", description: "/p" }] };
  expect(await chooseWindow(fakeUi((c) => { c.handleInput(DOWN); c.handleInput(ENTER); }), request)).toBe("项目层");
  expect(await chooseWindow(fakeUi((c) => c.handleInput(ESC)), request)).toBeUndefined();
});
