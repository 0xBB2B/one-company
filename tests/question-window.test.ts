import { expect, test } from "vitest";
import { chooseWindow, confirmWindow, QuestionWindowView } from "../src/core/host/question-window.ts";
import type { WindowAnswer, WindowHost } from "../src/core/host/question-window.ts";

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
  expect(first).toContain("<accent>→ 1. 统一 {code, data}</>  <success><b>推荐</b></>");
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

test("M8D2-AC3：光标移到其他一行就能直接输入，退格可删，空内容回车不提交，离开后文字保留，Esc 取消整个窗口", () => {
  const { window, text, done } = view({ tone: "standard", questions: [{ question: "用哪种格式？", allowOther: true, choices: [{ label: "统一" }] }] });
  expect(text()).not.toContain("›");
  window.handleInput(DOWN);
  expect(text()).toContain("<accent>→ 2. 其他（自己输入）</>");
  expect(text()).toContain("<accent>›</> \x1b[7m \x1b[27m");
  expect(text()).toContain("<muted>直接输入 · 回车确认 · ↑↓ 选择 · Esc 取消</>");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  for (const char of "后端 统一x") window.handleInput(char);
  window.handleInput(BACKSPACE);
  expect(text()).toContain("<accent>›</> 后端 统一\x1b[7m \x1b[27m");
  window.handleInput(UP);
  expect(text()).toContain("<accent>›</> 后端 统一\n");
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 取消</>");
  window.handleInput(DOWN);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "后端 统一" }]]);

  const picked = view({ tone: "standard", questions: [{ question: "用哪种格式？", allowOther: true, choices: [{ label: "统一" }] }] });
  picked.window.handleInput(DOWN); picked.window.handleInput("x"); picked.window.handleInput(UP); picked.window.handleInput(ENTER);
  expect(picked.done).toEqual([[{ choices: ["统一"] }]]);

  const cancelled = view({ tone: "standard", questions: [{ question: "用哪种格式？", allowOther: true, choices: [{ label: "统一" }] }] });
  cancelled.window.handleInput(DOWN); cancelled.window.handleInput("x"); cancelled.window.handleInput(ESC);
  expect(cancelled.done).toEqual([undefined]);
});

test("M8D2-AC3：多选题里其他一行按空格是输入空格，有字就算勾上；其他一行的名称可由调用方指定", () => {
  const { window, text, done } = view({ tone: "warning", questions: [{ question: "选哪些？", allowOther: true, otherLabel: "其他（自己输入修改意见）", multiSelect: true, choices: [{ label: "甲" }] }] });
  window.handleInput(SPACE); window.handleInput(DOWN);
  expect(text()).toContain("<warning>→ [ ] 其他（自己输入修改意见）</>");
  expect(text()).toContain("<muted>直接输入 · 回车确认 · ↑↓ 选择 · Esc 取消</>");
  for (const char of "a b") window.handleInput(char);
  expect(text()).toContain("<warning>→ [x] 其他（自己输入修改意见）</>");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: ["甲"], other: "a b" }]]);
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

test("M8D-AC8：不可选的选项整行变暗并写明原因，光标跳过它，停在它上面也按不下去", async () => {
  const { window, text, done } = view({ tone: "warning", questions: [{ question: "复制解释器到哪一层？",
    choices: [{ label: "用户层", disabled: "已有 ~/.pi/agent/agents/interpreter.md" }, { label: "项目层", description: "~/p/.pi/agents/interpreter.md" }, { label: "别处", disabled: "项目未受信任" }] }] });
  expect(text()).toMatch(/^ {3}<muted>用户层 +已有 ~\/\.pi\/agent\/agents\/interpreter\.md<\/>$/mu);
  expect(text()).toContain("<warning>→ 项目层</>");
  window.handleInput(DOWN);
  expect(text()).toContain("<warning>→ 项目层</>");
  window.handleInput(UP);
  expect(text()).toContain("<warning>→ 项目层</>");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: ["项目层"] }]]);
  expect(await chooseWindow(fakeUi((c) => c.handleInput(ENTER)), { title: "复制到", lines: [],
    choices: [{ label: "用户层", disabled: "已有" }, { label: "项目层" }] })).toBe("项目层");
});

const ASK = {
  caption: "提问 · 按住空格时长控制跳跃高度（第 2 版）",
  question: "起跳时机怎么定？现在按下空格就立即起跳，那一刻还不知道你会按多久。",
  rootCheck: "冲突的根源是\"初速度由按住时长决定\"和\"按下即起跳\"不能同时成立；下面是在两者之间选一条改，而不是加个延时凑合。",
  allowOther: true, escapeHint: "Esc 暂不回答（问题保留，之后在对话里回答也行）",
  choices: [
    { label: "按下立即起跳，按住期间继续增加向上速度", description: "手感即时，但这就变成\"按住加速\"，不再是改起跳初速度。" },
    { label: "松开空格时起跳，按满 0.3 秒自动起跳", description: "初速度按完整按住时长计算，完全符合你的描述；短按会晚一点点离地。", recommended: true,
      recommendedReason: "只有这样\"起跳初速度\"才真正由按住时长决定。" },
  ],
};
const plain = (text: string) => text.replace(/<\/?[a-z]*>/gu, "");

test("M8D-AC9：主代理提问窗口按确认的预览显示：灰色标题行、问题加粗、根源自检灰色、选项白色、理由灰色、推荐项挂绿色推荐与推荐理由，光标停在推荐项", () => {
  const { window, text, done } = view({ tone: "standard", questions: [ASK] });
  const lines = text().split("\n");
  expect(lines[0]).toBe("<border>" + "─".repeat(80) + "</>");
  expect(lines[1]).toBe(" <muted>提问 · 按住空格时长控制跳跃高度（第 2 版）</>");
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe(" <b>起跳时机怎么定？现在按下空格就立即起跳，那一刻还不知道你会按多久。</b>");
  expect(lines[5]).toBe(" <muted>根源自检  冲突的根源是\"初速度由按住时长决定\"和\"按下即起跳\"不能同时成立；下面是</>");
  expect(lines[6]).toBe(" <muted>          在两者之间选一条改，而不是加个延时凑合。</>");
  expect(lines.slice(8, 15)).toEqual([
    "   1. 按下立即起跳，按住期间继续增加向上速度",
    "      <muted>手感即时，但这就变成\"按住加速\"，不再是改起跳初速度。</>",
    " <accent>→ 2. 松开空格时起跳，按满 0.3 秒自动起跳</>  <success><b>推荐</b></>",
    "      <muted>初速度按完整按住时长计算，完全符合你的描述；短按会晚一点点离地。</>",
    "      <success>推荐理由：只有这样\"起跳初速度\"才真正由按住时长决定。</>",
    "   3. 其他（自己输入）",
    "",
  ]);
  expect(lines[15]).toBe(" <muted>↑↓ 选择 · 回车确认 · Esc 暂不回答（问题保留，之后在对话里回答也行）</>");
  window.handleInput(UP);
  expect(text()).toContain("<accent>→ 1. 按下立即起跳，按住期间继续增加向上速度</>");
  expect(text()).toContain("   2. 松开空格时起跳，按满 0.3 秒自动起跳  <success><b>推荐</b></>");
  window.handleInput(DOWN); window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: ["松开空格时起跳，按满 0.3 秒自动起跳"] }]]);
});

test("M8D-AC9：窄终端 56 列时放不下的文字换行不截断，续行对齐，标点不单独占行，英文数字不从中间切开", () => {
  const lines = view({ tone: "standard", questions: [ASK] }).text(56).split("\n").map(plain);
  for (const line of lines) expect([...line].reduce((w, c) => w + (/[\u2E80-\uFFEF]/u.test(c) ? 2 : 1), 0), line).toBeLessThanOrEqual(56);
  expect(lines).toContain(" 根源自检  冲突的根源是\"初速度由按住时长决定\"和\"按下即起");
  expect(lines).toContain("      推荐理由：只有这样\"起跳初速度\"才真正由按住时长决");
  expect(lines).toContain("      定。");
  for (const line of lines) expect(line.trimStart(), line).not.toMatch(/^[。，、；：？！）」』》]/u);
  const tight = view({ tone: "standard", questions: [{ ...ASK, choices: [{ label: "甲", description: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九。" }, ASK.choices[1]!] }] });
  const tightLines = tight.text(56).split("\n").map(plain);
  expect(tightLines.some((line) => line.trimStart().startsWith("。"))).toBe(false);
  expect(tightLines.join("\n")).not.toMatch(/0\.\n|\n\s*3 秒/u);
});
