import { describe, expect, test } from "vitest";
import { Editor, getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { chooseOrWriteWindow, chooseWindow, confirmWindow, QuestionWindowView } from "../src/core/host/question-window.ts";
import type { WindowAnswer, WindowHost } from "../src/core/host/question-window.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", ENTER = "\r", ESC = "\x1b", SPACE = " ", BACKSPACE = "\x7f";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };

const tuiStub = { requestRender() {}, terminal: { rows: 40, columns: 80 } };

function view(options: Omit<ConstructorParameters<typeof QuestionWindowView>[0], "theme" | "onDone" | "tui">) {
  const done: Array<WindowAnswer[] | undefined> = [];
  const window = new QuestionWindowView({ ...options, tui: tuiStub, theme, onDone: (answers) => done.push(answers) });
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
  expect(bare(text())).toContain("      › ");
  expect(text()).toContain("\x1b_pi:fc\x07");
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 取消</>");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  for (const char of "后端 统一x") window.handleInput(char);
  window.handleInput(BACKSPACE);
  expect(bare(text())).toContain("      › 后端 统一");
  expect(text()).toContain("\x1b_pi:fc\x07");
  window.handleInput(UP);
  expect(bare(text())).toContain("      › 后端 统一\n");
  expect(text()).not.toContain("\x1b_pi:fc\x07");
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
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 取消</>");
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
      const component = factory(tuiStub, theme, undefined, resolve) as Keys;
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

test("程序选择窗口：警告色调的 caption 画在顶部边框之下、标题之上，灰色，后面空一行", () => {
  const lines = view({ tone: "warning", questions: [{ caption: "交付到本地分支", question: "合进 main，怎么合并？", choices: [{ label: "压缩合并" }] }] }).text().split("\n");
  expect(lines[0]).toBe("<warning>" + "─".repeat(80) + "</>");
  expect(lines[1]).toBe(" <muted>交付到本地分支</>");
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe(" <warning><b>合进 main，怎么合并？</b></>");
});

test("chooseWindow 带 caption 时把灰字画在标题之上", async () => {
  let rendered: string[] = [];
  await chooseWindow(fakeUi((c) => { rendered = (c as unknown as { render(width: number): string[] }).render(80); c.handleInput(ENTER); }),
    { title: "合进 main，怎么合并？", caption: "交付到本地分支", lines: [], choices: [{ label: "压缩合并" }] });
  expect(rendered.indexOf(" <muted>交付到本地分支</>")).toBeGreaterThan(0);
  expect(rendered.indexOf(" <muted>交付到本地分支</>")).toBeLessThan(rendered.findIndex((line) => line.includes("合进 main，怎么合并？")));
});

test("不可选选项的原因太长时在原因列里折行，窄终端每行都不超宽", async () => {
  const reason = "你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust";
  for (const width of [36, 44, 60, 80]) {
    let rendered: string[] = [];
    await chooseWindow(fakeUi((c) => { rendered = (c as unknown as { render(width: number): string[] }).render(width); c.handleInput(ENTER); }),
      { title: "复制到哪一层？", lines: [], choices: [{ label: "用户层" }, { label: "项目层", disabled: reason }] });
    const lines = rendered.map((line) => line.replace(/<\/?[a-zA-Z]*>/gu, ""));
    for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
    const start = lines.findIndex((line) => line.startsWith("   项目层"));
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start).join("").replaceAll(" ", "")).toContain(`项目层${reason.replaceAll(" ", "")}`);
    const end = lines.findIndex((line, n) => n > start && !line.trim());
    expect(end - start).toBeGreaterThan(width < 64 ? 1 : 0);
    for (const line of lines.slice(start + 1, end)) expect(line.startsWith(" ".repeat(visibleWidth("   项目层   ")))).toBe(true);
  }
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

test("窗口行的警告色调：主题 fg 收到 warning", () => {
  const { text } = view({ tone: "standard", questions: [{ question: "问题", choices: [{ label: "好" }], lines: [{ text: "黄色提示", tone: "warning" }] }] });
  expect(text()).toContain("<warning>黄色提示</>");
});

const WINDOW_E = { title: "把 Go 后端样例复制到哪一层？", lines: [], cancelNote: "不复制样例", choices: [
  { label: "用户层", description: "~/.pi/agent/ · 对你的所有项目生效" },
  { label: "项目层", description: "~/Projects/one-company/ · 只对这个项目生效 · 选它会把本项目设为受信任" }] };
const WINDOW_C = { title: "复制 worker 到哪一层？", lines: [{ text: "新名称：go-worker", tone: "muted" as const }], choices: [
  { label: "用户层", description: "~/.pi/agent/agents/go-worker.md" },
  { label: "项目层", description: "~/Projects/one-company/.pi/agents/go-worker.md · 选它会把本项目设为受信任" }] };

async function choiceLines(request: Parameters<typeof chooseWindow>[1], width: number) {
  let rendered: string[] = [];
  await chooseWindow(fakeUi((c) => { rendered = (c as unknown as { render(width: number): string[] }).render(width); c.handleInput(ENTER); }), request);
  const lines = rendered.map((line) => line.replace(/<\/?[a-zA-Z]*>/gu, ""));
  const start = lines.findIndex((line) => line.startsWith(" → 用户层"));
  return { lines, options: lines.slice(start, lines.findIndex((line, n) => n > start && !line.trim())) };
}

test.each([
  ["E", 80, [
    " → 用户层   ~/.pi/agent/ · 对你的所有项目生效",
    "   项目层   ~/Projects/one-company/ · 只对这个项目生效",
    "            · 选它会把本项目设为受信任"]],
  ["C", 80, [
    " → 用户层   ~/.pi/agent/agents/go-worker.md",
    "   项目层   ~/Projects/one-company/.pi/agents/go-worker.md",
    "            · 选它会把本项目设为受信任"]],
  ["E", 44, [
    " → 用户层   ~/.pi/agent/",
    "            · 对你的所有项目生效",
    "   项目层   ~/Projects/one-company/",
    "            · 只对这个项目生效",
    "            · 选它会把本项目设为受信任"]],
  ["C", 44, [
    " → 用户层   ~/.pi/agent/agents/go-worker.md",
    "   项目层   ~/Projects/one-company/.pi/",
    "            agents/go-worker.md",
    "            · 选它会把本项目设为受信任"]],
])("选项说明太长时按 · 分段折行，说明列起点固定：窗口 %s %d 列", async (which, width, expected) => {
  expect((await choiceLines(which === "E" ? WINDOW_E : WINDOW_C, width)).options).toEqual(expected);
});

test("选项说明太长时窗口每一行都不超过终端宽度", async () => {
  for (const request of [WINDOW_E, WINDOW_C]) {
    for (const width of [36, 44, 60, 80]) {
      for (const line of (await choiceLines(request, width)).lines) expect(visibleWidth(line), `${width} 列：${line}`).toBeLessThanOrEqual(width);
    }
  }
});

test("选项说明放得下一行时，选项名按最长选项名补齐再隔 3 个空格，仍是单行", async () => {
  const { options } = await choiceLines({ title: "复制到", lines: [], choices: [{ label: "用户层", description: "~/a" }, { label: "项目层级别", description: "~/b" }] }, 80);
  expect(options).toEqual([" → 用户层       ~/a", "   项目层级别   ~/b"]);
});

test("选项说明折成多行时，每一行说明都是灰色", async () => {
  let rendered: string[] = [];
  await chooseWindow(fakeUi((c) => { rendered = (c as unknown as { render(width: number): string[] }).render(80); c.handleInput(ENTER); }), WINDOW_E);
  const first = rendered.find((line) => line.includes("项目层"));
  expect(first).toContain("<muted>~/Projects/one-company/ · 只对这个项目生效</>");
  expect(rendered.some((line) => line.includes("<muted>· 选它会把本项目设为受信任</"))).toBe(true);
});

function bare(value: string) {
  return value.replace(/<\/?[a-zA-Z]*>/gu, "").replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b_[^\x07]*\x07/gu, "");
}
function barOf(rendered: string[], label: string) {
  const lines = rendered.map(bare);
  const row = lines.findIndex((line) => line.includes(label));
  let end = row + 1;
  while (end < lines.length && (lines[end]!.startsWith("      › ") || lines[end]!.startsWith(" ".repeat(8)))) end++;
  return { row, lines: lines.slice(row + 1, end), raw: rendered.slice(row + 1, end) };
}
const OTHER_LABEL = "其他（自己输入）";
const SHIFT_ENTER = "\x1b[13;2u", CTRL_J = "\n", HOME = "\x1b[H", END = "\x1b[F", DELETE = "\x1b[3~";
const paste = (value: string) => "\x1b[200~" + value + "\x1b[201~";
const click = (x: number, y: number) => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 40, shift: false, alt: false, ctrl: false });

const otherQuestion = (extra: Record<string, unknown> = {}) => ({ question: "确认原型", choices: [{ label: "通过（写进需求草稿）" }],
  allowOther: true, otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版", ...extra });
const otherView = (extra: Record<string, unknown> = {}) => view({ tone: "warning", questions: [otherQuestion(extra)] });
const typeText = (window: { handleInput(data: string): void }, value: string) => { for (const char of value) window.handleInput(char); };

test("其他行：排在选项之后，光标在普通项时提示不含直接输入，移到其他行后提示变为直接输入并出现输入栏", () => {
  const { window, text } = otherView();
  const first = plain(text());
  expect(first.indexOf("通过（写进需求草稿）")).toBeGreaterThan(-1);
  expect(first.indexOf(OTHER_LABEL)).toBeGreaterThan(first.indexOf("通过（写进需求草稿）"));
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  expect(text()).not.toContain("›");
  window.handleInput(DOWN);
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版</>");
  const bar = barOf(text().split("\n"), OTHER_LABEL);
  expect(bar.lines[0]).toMatch(/^ {6}› /u);
  expect(bar.raw[0]).toContain("\x1b_pi:fc\x07");
});

test("其他行：空输入或只有空白时回车不起作用", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  typeText(window, "  ");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
});

test("其他行：超过 otherMaxLength 时提示超出字数且回车不起作用，退格回到上限后可提交", () => {
  const { window, text, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "字".repeat(4001));
  expect(text()).toContain("超出 1 字，最多 4000 字");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  window.handleInput(BACKSPACE);
  expect(text()).not.toContain("超出");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "字".repeat(4000) }]]);
});

test("其他行：没字时离开后不显示输入栏", () => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  expect(bare(text())).toContain("›");
  window.handleInput(UP);
  expect(bare(text())).not.toContain("›");
});

test("其他行默认显示\"其他（自己输入）\"，chooseOrWriteWindow 不传 otherLabel 也能打开并返回答案", async () => {
  const lines = otherView().text().split("\n").map(bare);
  expect(lines.filter((line) => /^( → |   )/u.test(line) && line.trim())[1]).toContain(OTHER_LABEL);
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }] };
  expect(await chooseOrWriteWindow(fakeUi((c) => { c.handleInput(DOWN); typeText(c, "自己写"); c.handleInput(ENTER); }), request))
    .toEqual({ choices: [], other: "自己写" });
});

test.each([36, 44, 60, 80])("输入栏在 %d 列下不自动折行：长行左右滚动，光标所在行末尾或开头出现灰色省略号，其余行从开头显示，每行都不超宽", (width) => {
  const { window } = otherView();
  window.handleInput(DOWN);
  typeText(window, "汉".repeat(100));
  window.handleInput(SHIFT_ENTER);
  typeText(window, "abcdefghij".repeat(10));
  const check = () => {
    const rendered = window.render(width);
    for (const line of rendered) expect(visibleWidth(bare(line)), line).toBeLessThanOrEqual(width);
    const bar = barOf(rendered, OTHER_LABEL);
    expect(bar.lines.length).toBe(2);
    expect(bar.lines[0]!.startsWith("      › 汉")).toBe(true);
    expect(bar.lines[1]!.startsWith(" ".repeat(8))).toBe(true);
    return bar.raw.map((line) => ctl(line).trimEnd());
  };
  const atEnd = check();
  expect(atEnd[0]!.startsWith("      › 汉")).toBe(true);
  expect(atEnd[0]!.endsWith(MUTED_DOTS)).toBe(true);
  expect(atEnd[1]!.startsWith(" ".repeat(8) + MUTED_DOTS)).toBe(true);
  expect(atEnd[1]!.endsWith(MUTED_DOTS)).toBe(false);
  window.handleInput(HOME);
  const atHome = check();
  expect(atHome[0]!.endsWith(MUTED_DOTS)).toBe(true);
  expect(atHome[1]!.startsWith(" ".repeat(8) + "abcdef")).toBe(true);
  expect(atHome[1]!.endsWith(MUTED_DOTS)).toBe(true);
});

test("输入栏一行 100 个汉字，光标向左走出显示区后，显示区跟着光标移动：开头和末尾都是灰色省略号，光标标记所在的字就是光标处的字", () => {
  const { window } = otherView();
  window.handleInput(DOWN);
  const han = distinct(100);
  typeText(window, han);
  for (let n = 0; n < 60; n++) window.handleInput(LEFT);
  const rendered = window.render(80);
  for (const line of rendered) expect(visibleWidth(bare(line)), line).toBeLessThanOrEqual(80);
  const bar = barOf(rendered, OTHER_LABEL);
  expect(bar.lines.length).toBe(1);
  const line = ctl(bar.raw[0]!).trimEnd();
  expect(line.startsWith("      › " + MUTED_DOTS)).toBe(true);
  expect(line.endsWith(MUTED_DOTS)).toBe(true);
  expect(bar.raw[0]!.match(/\x1b_pi:fc\x07(.*?)\x1b_pi:\/fc\x07/u)?.[1]).toBe(han[40]);
});

test("输入栏收起：光标不在输入行时只有一行字就显示这一行，没有光标标记；光标移回来时展开并回到原处", () => {
  const { window, text, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "甲乙丙");
  window.handleInput(UP);
  const collapsed = barOf(text().split("\n"), OTHER_LABEL);
  expect(collapsed.lines.map((line) => line.trimEnd())).toEqual(["      › 甲乙丙"]);
  expect(collapsed.raw.join("")).not.toContain("\x1b_pi:");
  window.handleInput(DOWN);
  expect(text()).toContain(INPUT_HINT);
  expect(barOf(text().split("\n"), OTHER_LABEL).raw.join("")).toContain("\x1b_pi:fc\x07");
  typeText(window, "X");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "甲乙丙X" }]]);
});

test.each([36, 80])("输入栏收起：多行时在 %d 列下显示第一行开头加灰色\"…（共 3 行）\"，第一行太长就截短，每行不超宽", (width) => {
  const { window } = otherView();
  window.handleInput(DOWN);
  typeText(window, "汉".repeat(100));
  window.handleInput(SHIFT_ENTER); typeText(window, "二");
  window.handleInput(SHIFT_ENTER); typeText(window, "三");
  leave(window, () => window.render(width).join("\n"));
  const rendered = window.render(width);
  for (const line of rendered) expect(visibleWidth(bare(line)), line).toBeLessThanOrEqual(width);
  const bar = barOf(rendered, OTHER_LABEL);
  expect(bar.lines.length).toBe(1);
  expect(bar.lines[0]!.startsWith("      › 汉")).toBe(true);
  expect(bar.lines[0]!.trimEnd().endsWith("…（共 3 行）")).toBe(true);
  expect(bar.raw.join("")).not.toContain("\x1b_pi:");
  expect(bare(rendered.join("\n"))).not.toContain("二");
});

test("输入栏收起：只有一行很长的字时显示成一行、末尾灰色省略号、没有共几行", () => {
  const { window } = otherView();
  window.handleInput(DOWN);
  typeText(window, "汉".repeat(100));
  window.handleInput(UP);
  const rendered = window.render(80);
  for (const line of rendered) expect(visibleWidth(bare(line)), line).toBeLessThanOrEqual(80);
  const bar = barOf(rendered, OTHER_LABEL);
  expect(bar.lines.length).toBe(1);
  expect(bar.lines[0]!.startsWith("      › 汉")).toBe(true);
  expect(ctl(bar.raw[0]!).trimEnd().endsWith(MUTED_DOTS)).toBe(true);
  expect(bar.lines[0]).not.toContain("共");
});

test("输入栏收起：粘贴 42 行折叠后移走，收起行含 [paste #1 +42 lines] 和（共 42 行）", () => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  window.handleInput(paste(Array.from({ length: 42 }, (_, n) => `第${n + 1}行`).join("\n")));
  window.handleInput(UP);
  const bar = barOf(text().split("\n"), OTHER_LABEL);
  expect(bar.lines.length).toBe(1);
  expect(bar.lines[0]).toContain("[paste #1 +42 lines]");
  expect(bar.lines[0]).toContain("（共 42 行）");
});

test("输入栏按键：插入、Backspace、Delete、←→、Home、End、Shift+Enter 与 Ctrl+J 换行，回车提交", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "abc");
  window.handleInput(LEFT);
  typeText(window, "X");
  window.handleInput(HOME);
  typeText(window, "Y");
  window.handleInput(END);
  window.handleInput(BACKSPACE);
  window.handleInput(DELETE);
  window.handleInput(SHIFT_ENTER);
  typeText(window, "d");
  window.handleInput(CTRL_J);
  typeText(window, "e");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "YabX\nd\ne" }]]);
});

test("输入栏按键：Delete 删光标后一个字，→ 向右移动", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "abcd");
  window.handleInput(HOME);
  window.handleInput(RIGHT);
  window.handleInput(DELETE);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "acd" }]]);
});

test("输入栏 ↑↓ 在各行间移动，首行 ↑ 到上一个选项，回到输入行时回到离开时的光标位置；其他行是最后一项，末行 ↓ 仍留在输入行", () => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  typeText(window, "一"); window.handleInput(SHIFT_ENTER);
  typeText(window, "二"); window.handleInput(SHIFT_ENTER);
  typeText(window, "三");
  window.handleInput(UP);
  window.handleInput(UP);
  typeText(window, "X");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一X", "二", "三"]);
  window.handleInput(UP);
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  window.handleInput(DOWN);
  expect(text()).toContain("直接输入");
  typeText(window, "Y");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一XY", "二", "三"]);
  window.handleInput(DOWN); window.handleInput(DOWN);
  typeText(window, "Z");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一XY", "二", "三Z"]);
  window.handleInput(DOWN);
  expect(text()).toContain(INPUT_HINT);
  expect(barOf(text().split("\n"), OTHER_LABEL).raw.join("")).toContain("\x1b_pi:fc\x07");
  typeText(window, "W");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一XY", "二", "三ZW"]);
});

test("输入栏 ↑ 在各行之间移动：光标在第二行按 ↑ 到第一行，再输入的字出现在第一行，再 ↑ 到上一个选项", () => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  typeText(window, "一"); window.handleInput(SHIFT_ENTER);
  typeText(window, "二"); window.handleInput(SHIFT_ENTER);
  typeText(window, "三");
  window.handleInput(UP);
  window.handleInput(UP);
  typeText(window, "X");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一X", "二", "三"]);
  window.handleInput(UP);
  expect(text()).not.toContain(INPUT_HINT);
  window.handleInput(DOWN);
  typeText(window, "Y");
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["一XY", "二", "三"]);
});

test("输入栏回车：首尾空白去掉，中间换行保留", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "  第一行");
  window.handleInput(SHIFT_ENTER);
  typeText(window, "第二行  ");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "第一行\n第二行" }]]);
});

test("输入栏回车：只有换行和空白时不提交", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  window.handleInput(SHIFT_ENTER);
  typeText(window, " ");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
});

test("粘贴超过 10 行显示为 [paste #序号 +行数 lines]，单行超过 1000 字显示为 [paste #序号 字数 chars]，提交换回原文", () => {
  const { window, text, done } = otherView();
  window.handleInput(DOWN);
  const lines = Array.from({ length: 42 }, (_, n) => `第${n + 1}行`).join("\n"), long = "长".repeat(1200);
  window.handleInput(paste(lines));
  expect(bare(text())).toContain("[paste #1 +42 lines]");
  expect(bare(text())).not.toContain("第20行");
  window.handleInput(paste(long));
  expect(bare(text())).toContain("[paste #2 1200 chars]");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: lines + long }]]);
});

test("粘贴折叠部分按原文算字数：折叠 3990 字再输入 11 字，超出 1 字显示在输入栏最后一行下面且回车不提交", () => {
  const { window, text, done } = otherView();
  window.handleInput(DOWN);
  window.handleInput(paste("折".repeat(3990)));
  typeText(window, "尾".repeat(11));
  const lines = text().split("\n").map(bare);
  const last = lines.findIndex((line) => line.includes("尾".repeat(11)));
  expect(last).toBeGreaterThan(-1);
  expect(lines[last + 1]).toContain("超出 1 字，最多 4000 字");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
});

test("鼠标点击输入栏：展开时点字定位到那个字前面；收起成一行时点字或点\"…（共 N 行）\"，光标移到输入行并展开，定位到第一行里被点的字前面或第一行末尾；点在选项文字上状态不变", () => {
  const setup = () => {
    const made = otherView();
    made.window.handleInput(DOWN);
    typeText(made.window, "一二三四五六七"); made.window.handleInput(SHIFT_ENTER); typeText(made.window, "八九");
    leave(made.window, made.text);
    expect(made.text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
    return made;
  };
  const at = (made: ReturnType<typeof setup>, startsWith: string) => made.window.render(80).map(bare).findIndex((line) => line.startsWith(startsWith));

  const first = setup();
  expect(at(first, "        八九")).toBe(-1);
  first.window.handleMouse(click(8 + visibleWidth("一二三四"), at(first, "      › 一二三四五六七")));
  expect(first.text()).toContain("直接输入");
  typeText(first.window, "X");
  first.window.handleInput(ENTER);
  expect(first.done).toEqual([[{ choices: [], other: "一二三四X五六七\n八九" }]]);

  const second = setup();
  second.window.handleMouse(click(8 + visibleWidth("一二三四五六七") + 2, at(second, "      › 一二三四五六七")));
  expect(second.text()).toContain("直接输入");
  typeText(second.window, "Y");
  expect(barOf(second.window.render(80), OTHER_LABEL).lines.map((line) => line.slice(8).trimEnd())).toEqual(["一二三四五六七Y", "八九"]);

  const expanded = setup();
  const barRow = at(expanded, "      › 一二三四五六七");
  expanded.window.handleMouse(click(8, barRow));
  const secondRow = at(expanded, "        八九");
  expect(secondRow).toBeGreaterThan(-1);
  expanded.window.handleMouse(click(8 + visibleWidth("八"), secondRow));
  typeText(expanded.window, "Q");
  expect(contentOf(expanded.window.render(80), OTHER_LABEL)).toEqual(["一二三四五六七", "八Q九"]);

  const third = setup();
  third.window.handleMouse(click(6, at(third, " → 通过（写进需求草稿）")));
  expect(third.text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  third.window.handleInput(ENTER);
  expect(third.done).toEqual([[{ choices: ["通过（写进需求草稿）"] }]]);
});

test("输入栏有字时按 Esc：没有 escapeChoice 的窗口收到 undefined", () => {
  const { window, done } = view({ tone: "warning", questions: [{ question: "确认原型", choices: [{ label: "通过" }], allowOther: true }] });
  window.handleInput(DOWN);
  typeText(window, "乙");
  window.handleInput(ESC);
  expect(done).toEqual([undefined]);
});

test("escapeChoice：按 Esc 返回指定答案；没有 escapeChoice 的窗口按 Esc 仍返回 undefined", () => {
  const withEscape = otherView();
  withEscape.window.handleInput(ESC);
  expect(withEscape.done).toEqual([[{ choices: ["放弃这一版"] }]]);
  const without = view({ tone: "warning", questions: [{ question: "确认原型", choices: [{ label: "通过" }], allowOther: true }] });
  without.window.handleInput(ESC);
  expect(without.done).toEqual([undefined]);
});

test("escapeChoice：在输入行里有字时按 Esc 也返回指定答案", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "乙");
  window.handleInput(ESC);
  expect(done).toEqual([[{ choices: ["放弃这一版"] }]]);
});

test("chooseOrWriteWindow 透传 escapeChoice，signal 中断时返回 undefined", async () => {
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }] };
  expect(await chooseOrWriteWindow(fakeUi((c) => { c.handleInput(DOWN); typeText(c, " 用 B "); c.handleInput(ENTER); }), request))
    .toEqual({ choices: [], other: "用 B" });
  expect(await chooseOrWriteWindow(fakeUi((c) => c.handleInput(ESC)), request)).toEqual({ choices: ["放弃这一版"] });
  const abort = new AbortController();
  const pending = chooseOrWriteWindow(fakeUi(() => {}), request, abort.signal);
  abort.abort();
  expect(await pending).toBeUndefined();
});

test("chooseOrWriteWindow 窗口已显示、输入行里有字时被中断，返回 undefined 而不是 Esc 的指定答案", async () => {
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }] };
  const abort = new AbortController();
  const host = fakeUi((c) => { c.handleInput(DOWN); typeText(c, "用 B"); });
  const pending = chooseOrWriteWindow(host, request, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(host.shown).toBe(1);
  abort.abort();
  expect(await pending).toBeUndefined();
});

test("光标在\"其他\"输入行时底部提示也是直接输入那组，Esc 那一段用 escapeHint", () => {
  const { window, text } = otherView({ otherLabel: "返工（自己输入要改什么）" });
  window.handleInput(DOWN);
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版</>");
});

const INPUT_HINT = "直接输入";
const ctl = (value: string) => value.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b_[^\x07]*\x07/gu, "").replace("<warning>›</>", "›");
const MUTED_DOTS = "<muted>…</>";
const distinct = (count: number) => Array.from({ length: count }, (_, n) => String.fromCodePoint(0x4e00 + n)).join("");
const leave = (window: { handleInput(data: string): void }, render: () => string) => { for (let n = 0; n < 20 && render().includes(INPUT_HINT); n++) window.handleInput(UP); };
const viewRows = (rows: number) => {
  const done: Array<WindowAnswer[] | undefined> = [];
  const window = new QuestionWindowView({ tui: { requestRender() {}, terminal: { rows, columns: 80 } }, theme, onDone: (answers) => done.push(answers), tone: "warning", questions: [otherQuestion()] } as never);
  return { window, done, text: (width = 80) => window.render(width).join("\n") };
};

const contentOf = (rendered: string[], label: string) => barOf(rendered, label).lines.map((line) => line.slice(8).trimEnd());

test("光标在输入行上时输入栏保留 pi 编辑器的假光标标记，不出现 \\x1b[7m；光标不在该行时没有标记", () => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  typeText(window, "ab");
  window.handleInput(LEFT);
  const raw = barOf(text().split("\n"), OTHER_LABEL).raw.join("");
  expect(raw).toContain("\x1b_pi:fc\x07");
  expect(raw).toContain("\x1b_pi:/fc\x07");
  expect(raw).not.toContain("\x1b[7m");
  expect(raw).toContain("\x1b_pi:c\x07");
  window.handleInput(UP);
  const left = barOf(text().split("\n"), OTHER_LABEL).raw.join("");
  expect(left).not.toContain("\x1b_pi:fc\x07");
  expect(left).not.toContain("\x1b_pi:c\x07");
  expect(left).not.toContain("\x1b[7m");
});

test("输入栏超过可见行数：只显示一段并跟着光标上下移动，上面和下面藏起来的行数写在灰色提示行里，没藏行时不写", () => {
  const { window } = viewRows(24);
  const render = () => window.render(80);
  window.handleInput(DOWN);
  for (let n = 1; n <= 12; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, String(n)); }

  let bar = barOf(render(), OTHER_LABEL);
  expect(ctl(bar.raw[0]!).trimEnd()).toBe("      › <muted>↑ 上面还有 5 行</>");
  expect(bar.lines.map((line) => line.slice(8).trimEnd()).slice(1)).toEqual(["6", "7", "8", "9", "10", "11", "12"]);
  expect(bar.lines.join("\n")).not.toContain("下面还有");

  for (let n = 0; n < 8; n++) window.handleInput(UP);
  bar = barOf(render(), OTHER_LABEL);
  const above = /^ {6}› ↑ 上面还有 (\d+) 行$/u.exec(bar.lines[0]!.trimEnd());
  const below = /^ {8}↓ 下面还有 (\d+) 行$/u.exec(bar.lines.at(-1)!.trimEnd());
  expect(above).not.toBeNull();
  expect(below).not.toBeNull();
  expect(Number(above![1]) + Number(below![1]) + 7).toBe(12);
  expect(ctl(bar.raw.at(-1)!).trimEnd()).toBe("        <muted>↓ 下面还有 " + below![1] + " 行</>");
  const cursorRow = bar.raw.findIndex((line) => line.includes("\x1b_pi:fc\x07"));
  expect(bar.lines[cursorRow]!.slice(8).trimEnd()).toBe("4");

  for (let n = 0; n < 3; n++) window.handleInput(UP);
  bar = barOf(render(), OTHER_LABEL);
  expect(bar.lines[0]!.trimEnd()).toBe("      › 1");
  expect(bar.lines.length).toBe(8);
  expect(ctl(bar.raw[7]!).trimEnd()).toBe("        <muted>↓ 下面还有 5 行</>");
  expect(bar.lines.slice(0, 7).join("\n")).not.toContain("上面还有");
});

test("点击输入栏的\"上面还有 N 行\"提示行不改变光标位置", () => {
  const { window } = viewRows(24);
  window.handleInput(DOWN);
  for (let n = 1; n <= 12; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, String(n)); }
  const row = window.render(80).map(bare).findIndex((line) => line.includes("↑ 上面还有"));
  expect(row).toBeGreaterThan(-1);
  window.handleMouse(click(10, row) as never);
  typeText(window, "Z");
  expect(contentOf(window.render(80), OTHER_LABEL).at(-1)).toBe("12Z");
});

test("输入栏行数超过可见行数时，↑ 从第 8 行逐行上移到第 1 行，再 ↑ 才到上一个选项；↓ 从第 1 行逐行下移到第 8 行，其他行是最后一项，再 ↓ 仍留在输入行", () => {
  const small = { requestRender() {}, terminal: { rows: 10, columns: 80 } };
  const done: Array<WindowAnswer[] | undefined> = [];
  const window = new QuestionWindowView({ tui: small, theme, onDone: (answers) => done.push(answers), tone: "warning", questions: [otherQuestion()] } as never);
  const text = () => window.render(80).join("\n");
  window.handleInput(DOWN);
  for (let n = 1; n <= 8; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, String(n)); }
  for (let n = 0; n < 7; n++) {
    window.handleInput(UP);
    expect(text(), `第 ${n + 1} 次 ↑`).toContain(INPUT_HINT);
  }
  typeText(window, "X");
  expect(contentOf(window.render(80), OTHER_LABEL)).toContain("1X");
  window.handleInput(UP);
  expect(text()).not.toContain(INPUT_HINT);
  window.handleInput(DOWN);
  expect(text()).toContain(INPUT_HINT);
  for (let n = 0; n < 7; n++) {
    window.handleInput(DOWN);
    expect(text(), `第 ${n + 1} 次 ↓`).toContain(INPUT_HINT);
  }
  typeText(window, "Z");
  expect(contentOf(window.render(80), OTHER_LABEL)).toContain("8Z");
  window.handleInput(DOWN);
  expect(text()).toContain(INPUT_HINT);
  typeText(window, "W");
  expect(contentOf(window.render(80), OTHER_LABEL)).toContain("8ZW");
});

test.each([
  ["move", "left"], ["press", "left"], ["drag", "left"], ["release", "left"], ["wheel", "left"], ["click", "right"],
])("鼠标只认左键单击：%s（%s）事件不动光标", (type, button) => {
  const { window, text } = otherView();
  window.handleInput(DOWN);
  typeText(window, "一二三");
  window.handleInput(UP);
  const row = window.render(80).map(bare).findIndex((line) => line.startsWith("      › 一二三"));
  expect(window.handleMouse({ ...click(8, row), type, button, wheelDelta: 1 } as never)).toBeUndefined();
  expect(text()).not.toContain(INPUT_HINT);
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
});

test("小粘贴（3 行）原样插入：输入栏显示 3 行，提交的 other 是原文", () => {
  const { window, text, done } = otherView();
  window.handleInput(DOWN);
  window.handleInput(paste("甲\n乙\n丙"));
  expect(contentOf(text().split("\n"), OTHER_LABEL)).toEqual(["甲", "乙", "丙"]);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "甲\n乙\n丙" }]]);
});

test("长行里光标往左移时显示区先不动，碰到左边缘才跟着左移，两头都显示灰色省略号", () => {
  const { window } = otherView();
  window.handleInput(DOWN);
  const text = "用B方案顶部分栏A和C不要顶部分栏里的标签按使用频率排序最常用的放最左边深色模式下分栏底色用比背景亮一级的灰色";
  typeText(window, text);
  const barLine = () => window.render(80).map((line) => bare(line).trimEnd()).find((line) => line.startsWith("      › "))!;
  const atEnd = barLine();
  for (let i = 0; i < 5; i++) window.handleInput(LEFT);
  expect(barLine()).toBe(atEnd);
  for (let i = 0; i < 40; i++) window.handleInput(LEFT);
  const moved = window.render(80).find((line) => bare(line).startsWith("      › "))!;
  expect(moved).toContain(MUTED_DOTS);
  expect(moved.indexOf(MUTED_DOTS)).not.toBe(moved.lastIndexOf(MUTED_DOTS));
  expect(moved).toContain("\x1b_pi:fc\x07");
});

const scrolledRight = () => {
  const han = distinct(100);
  const made = otherView();
  made.window.handleInput(DOWN);
  typeText(made.window, han);
  made.window.handleInput(HOME);
  for (let n = 0; n < 50; n++) made.window.handleInput(RIGHT);
  return { ...made, han };
};

test.each([9, 10])("长行向右滚动后点击输入栏第一个能看到的字（x=%d）：新输入插在这个字前面", (x) => {
  const { window, done, han } = scrolledRight();
  const rendered = window.render(80);
  const bar = barOf(rendered, OTHER_LABEL);
  expect(bar.lines[0]!.startsWith("      › …")).toBe(true);
  const visible = bar.lines[0]![9]!;
  const index = han.indexOf(visible);
  expect(index).toBeGreaterThan(0);
  window.handleMouse(click(x, bar.row + 1) as never);
  typeText(window, "X");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: han.slice(0, index) + "X" + han.slice(index) }]]);
});

test("长行里光标往右越过右边缘时显示区跟着右移：开头出现灰色省略号，光标标记可见，光标所在的字在可见文字最右边附近", () => {
  const { window } = otherView();
  window.handleInput(DOWN);
  typeText(window, distinct(100));
  window.handleInput(HOME);
  const first = window.render(80)[barOf(window.render(80), OTHER_LABEL).row + 1]!;
  expect(ctl(first).startsWith("      › " + MUTED_DOTS)).toBe(false);
  let raw = first;
  for (let n = 0; n < 200 && !ctl(raw).startsWith("      › " + MUTED_DOTS); n++) {
    window.handleInput(RIGHT);
    const rendered = window.render(80);
    for (const line of rendered) expect(visibleWidth(bare(line)), line).toBeLessThanOrEqual(80);
    raw = rendered[barOf(rendered, OTHER_LABEL).row + 1]!;
  }
  expect(ctl(raw).startsWith("      › " + MUTED_DOTS)).toBe(true);
  expect(raw).toContain("\x1b_pi:fc\x07");
  const cursorChar = raw.match(/\x1b_pi:fc\x07(.*?)\x1b_pi:\/fc\x07/u)![1]!;
  const visible = bare(raw).trimEnd().replace(/…$/u, "");
  expect([...visible].slice(-2)).toContain(cursorChar);
});

test("滚动提示和超字提示的顺序：看得到的行之后先是\"下面还有 N 行\"，再下一行才是\"超出 N 字\"", () => {
  const window = new QuestionWindowView({ tui: { requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, onDone: () => {}, tone: "warning", questions: [otherQuestion({ otherMaxLength: 30 })] } as never);
  window.handleInput(DOWN);
  for (let n = 1; n <= 12; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, "甲甲甲"); }
  for (let n = 0; n < 11; n++) window.handleInput(UP);
  const rendered = window.render(80);
  const at = rendered.findIndex((line) => line.includes("↓ 下面还有"));
  expect(at).toBeGreaterThan(-1);
  expect(ctl(rendered[at]!).trimEnd()).toBe("        <muted>↓ 下面还有 5 行</>");
  expect(bare(rendered[at + 1]!)).toMatch(/超出 \d+ 字，最多 30 字/u);
});

test("收起成一行的输入栏：点击\"三\"，光标定位到\"三\"前面", () => {
  const { window, done } = otherView();
  window.handleInput(DOWN);
  typeText(window, "一二三四五");
  window.handleInput(UP);
  const row = window.render(80).map(bare).findIndex((line) => line.startsWith("      › 一二三四五"));
  expect(row).toBeGreaterThan(-1);
  window.handleMouse(click(8 + visibleWidth("一二"), row) as never);
  typeText(window, "X");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "一二X三四五" }]]);
});

test("编辑器\"上移\"键被改绑后点击多行收起行：在有限时间内返回", { timeout: 2000 }, () => {
  const original = getKeybindings();
  const { window, text } = otherView();
  window.handleInput(DOWN);
  typeText(window, "一二三"); window.handleInput(SHIFT_ENTER); typeText(window, "四五");
  leave(window, text);
  const row = window.render(80).map(bare).findIndex((line) => line.startsWith("      › 一二三"));
  expect(row).toBeGreaterThan(-1);
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorUp": "ctrl+p" }));
  try {
    window.handleMouse(click(8 + visibleWidth("一"), row) as never);
  } finally {
    setKeybindings(original);
  }
});

describe("窗口超过屏幕高度", () => {
  const SHIFT_UP = "\x1b[1;2A", SHIFT_DOWN = "\x1b[1;2B";
  const ABOVE = /^ ↑ 上面还有 (\d+) 行$/u, BELOW = /^ ↓ 下面还有 (\d+) 行$/u;
  const BORDER = /^─{80}$/u;
  const marks = (count: number) => Array.from({ length: count }, (_, n) => ({ text: `内容${n + 1}行`, tone: "normal" as const }));
  const longQuestion = (extra: Record<string, unknown> = {}) => ({ caption: "提问 · 测试", question: "要选哪一个", lines: marks(100),
    choices: [{ label: "选项甲" }, { label: "选项乙" }], cancelNote: "不写入", ...extra });
  const wheel = (wheelDelta: number) => ({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 40, shift: false, alt: false, ctrl: false, wheelDelta });
  const handled = (result: unknown) => (result as { handled?: boolean } | undefined)?.handled;

  function tall(rows: number | undefined, questions: Array<Record<string, unknown>>, tone: "warning" | "standard" = "warning") {
    const terminal = { rows: rows ?? 0, columns: 80 };
    const done: Array<WindowAnswer[] | undefined> = [];
    const tui = rows === undefined ? { requestRender() {} } : { requestRender() {}, terminal };
    const window = new QuestionWindowView({ tone, questions, theme, onDone: (answers) => done.push(answers), tui } as never);
    window.render(80);
    return { window, done, terminal, raw: (width = 80) => window.render(width), plain: (width = 80) => window.render(width).map(bare), text: (width = 80) => window.render(width).join("\n") };
  }
  const one = (rows: number | undefined, extra: Record<string, unknown> = {}, tone: "warning" | "standard" = "warning") => tall(rows, [longQuestion(extra)], tone);

  const firstChoice = (plain: string[]) => plain.findIndex((line) => line.includes("选项甲"));
  function frame(plain: string[]) {
    const first = firstChoice(plain);
    const content = plain.slice(1, first - 1);
    const shown = content.filter((line) => !ABOVE.test(line.trimEnd()) && !BELOW.test(line.trimEnd()));
    const above = Number(content.map((line) => ABOVE.exec(line.trimEnd())).find(Boolean)?.[1] ?? 0);
    const below = Number(content.map((line) => BELOW.exec(line.trimEnd())).find(Boolean)?.[1] ?? 0);
    return { first, shown: shown.length, above, below };
  }
  const fullTotal = (extra: Record<string, unknown> = {}, tone: "warning" | "standard" = "warning") => {
    const plain = one(10000, extra, tone).plain();
    return firstChoice(plain) - 2;
  };
  const pressTimes = (window: QuestionWindowView, data: string, times: number) => { for (let n = 0; n < times; n++) window.handleInput(data); };
  const tones = ["warning", "standard"] as const;

  test.each([[5, false], [6, true]])("内容有 %i 行：刚好放得下时输出和没限高时完全相同，多一行才限高", (count, limited) => {
    const extra = { lines: marks(count), caption: undefined };
    const small = one(24, extra), unlimited = one(undefined, extra);
    if (limited) {
      expect(small.raw()).toHaveLength(14);
      expect(small.text()).toContain("下面还有");
      return;
    }
    expect(small.raw()).toEqual(unlimited.raw());
    expect(small.raw()).toHaveLength(14);
    expect(small.text()).not.toMatch(/上面还有|下面还有|Shift\+↑↓/u);
  });

  test("tui 没有 terminal 字段时不限高，长内容全部输出", () => {
    const { plain, text } = one(undefined);
    expect(plain().length).toBeGreaterThan(100);
    expect(text()).toContain("内容100行");
    expect(text()).not.toMatch(/上面还有|下面还有|Shift\+↑↓/u);
  });

  test.each(tones.flatMap((tone) => [[24, 14], [84, 50], [10, 11], [5, 11]].map(([rows, cap]) => [tone, rows, cap] as const)))(
    "%s 语气 终端 %i 行：总行数等于上限 %i，选项、提示、上下边框都在", (tone, rows, cap) => {
      const { plain } = one(rows, {}, tone);
      const lines = plain();
      expect(lines).toHaveLength(cap);
      expect(lines.join("\n")).toContain("选项甲");
      expect(lines.join("\n")).toContain("选项乙");
      expect(lines.join("\n")).toContain("Esc 取消（不写入）");
      expect(lines[0]).toMatch(BORDER);
      expect(lines.at(-1)).toMatch(BORDER);
    });

  test.each(tones)("%s 语气 刚打开：内容从最上面开始，末行是灰色的下面还有 N 行，N 等于没显示出来的内容行数，内容和选项间空一行", (tone) => {
    const { raw, plain } = one(24, {}, tone);
    const lines = plain(), total = fullTotal({}, tone);
    const { first, shown, above, below } = frame(lines);
    expect(lines[1]).toContain("提问 · 测试");
    expect(lines.join("\n")).toContain("要选哪一个");
    expect(lines.join("\n")).toContain("内容1行");
    expect(above).toBe(0);
    expect(lines.join("\n")).not.toContain("上面还有");
    expect(below).toBe(total - shown);
    expect(raw()[first - 2]).toBe(` <muted>↓ 下面还有 ${below} 行</>`);
    expect(lines[first - 1]).toBe("");
  });

  test("提示行：超高时单选带 Shift+↑↓ 滚动内容，cancelNote 写在括号里", () => {
    expect(one(24).text()).toContain("<muted>↑↓ 选择 · 回车确认 · Shift+↑↓ 滚动内容 · Esc 取消（不写入）</>");
  });

  test("提示行：多选", () => {
    expect(one(24, { multiSelect: true, cancelNote: undefined }).text()).toContain("↑↓ 选择 · 空格勾选 · 回车确认 · Shift+↑↓ 滚动内容 · Esc 取消</>");
  });

  test("提示行：多问题窗口里 Shift+↑↓ 滚动内容 排在 ←→ 切换问题 前面", () => {
    const { text } = tall(24, [longQuestion({ header: "甲" }), longQuestion({ header: "乙" })], "standard");
    expect(text()).toContain("↑↓ 选择 · 回车确认 · Shift+↑↓ 滚动内容 · ←→ 切换问题 · Esc 取消（不写入）</>");
  });

  test.each([[80], [40]])("提示行：光标在其他输入行时含 Shift+↑↓ 滚动内容，宽度 %i 折行后总行数仍等于上限", (width) => {
    const { window, plain } = one(24, { allowOther: true, cancelNote: undefined });
    pressTimes(window, DOWN, 2);
    const lines = plain(width);
    expect(lines).toHaveLength(14);
    const hint = lines.slice(-4, -1).join("").replace(/\s/gu, "");
    expect(hint).toContain("直接输入·回车确认·Shift+Enter换行·↑↓选择·Shift+↑↓滚动内容·Esc取消");
  });

  test("Shift+↓ 每次下移 3 行、Shift+↑ 每次上移 3 行，选项和提示的文字位置、总行数、光标都不变，两个提示行数之和与显示行数凑成内容总行数", () => {
    const { window, plain, text } = one(24);
    window.handleInput(DOWN);
    const total = fullTotal();
    const base = plain();
    const baseTail = base.slice(frame(base).first);
    for (let step = 1; step <= 4; step++) {
      window.handleInput(SHIFT_DOWN);
      const lines = plain(), now = frame(lines);
      expect(now.above).toBe(3 * step);
      expect(now.first).toBe(frame(base).first);
      expect(lines.slice(now.first)).toEqual(baseTail);
      expect(lines).toHaveLength(14);
      expect(text()).toContain("<warning>→ 选项乙</>");
      expect(now.above + now.below + now.shown).toBe(total);
    }
    for (let step = 3; step >= 0; step--) {
      window.handleInput(SHIFT_UP);
      const now = frame(plain());
      expect(now.above).toBe(3 * step);
    }
    expect(plain()).toEqual(base);
  });

  test("滚到最后没有下面还有且能看到最后一行，继续 Shift+↓ 不变；滚回最上面没有上面还有，继续 Shift+↑ 不变", () => {
    const { window, plain, text } = one(24);
    const top = plain();
    pressTimes(window, SHIFT_DOWN, 60);
    const bottom = plain(), now = frame(bottom);
    expect(now.below).toBe(0);
    expect(bottom.join("\n")).not.toContain("下面还有");
    expect(text()).toContain("内容100行");
    expect(now.above + now.shown).toBe(fullTotal());
    window.handleInput(SHIFT_DOWN);
    expect(plain()).toEqual(bottom);
    pressTimes(window, SHIFT_UP, 60);
    expect(plain()).toEqual(top);
    expect(top.join("\n")).not.toContain("上面还有");
    window.handleInput(SHIFT_UP);
    expect(plain()).toEqual(top);
  });

  test.each([[1], [5], [120]])("滚轮向下 wheelDelta=%i 等于按一次 Shift+↓（3 行），handled 为 true", (delta) => {
    const wheeled = one(24), keyed = one(24);
    expect(handled(wheeled.window.handleMouse(wheel(delta) as never))).toBe(true);
    keyed.window.handleInput(SHIFT_DOWN);
    expect(wheeled.raw()).toEqual(keyed.raw());
    expect(frame(wheeled.plain()).above).toBe(3);
  });

  test.each([[-1], [-7]])("滚轮向上 wheelDelta=%i 等于按一次 Shift+↑（3 行）", (delta) => {
    const wheeled = one(24), keyed = one(24);
    pressTimes(wheeled.window, SHIFT_DOWN, 3); pressTimes(keyed.window, SHIFT_DOWN, 3);
    expect(handled(wheeled.window.handleMouse(wheel(delta) as never))).toBe(true);
    keyed.window.handleInput(SHIFT_UP);
    expect(wheeled.raw()).toEqual(keyed.raw());
    expect(frame(wheeled.plain()).above).toBe(6);
  });

  test("内容放得下时滚轮返回 undefined，内容不变", () => {
    const { window, raw } = one(24, { lines: marks(2) });
    const before = raw();
    expect(window.handleMouse(wheel(1) as never)).toBeUndefined();
    expect(window.handleMouse(wheel(-1) as never)).toBeUndefined();
    expect(raw()).toEqual(before);
  });

  test("Shift+↑↓ 不改变选项光标；滚动后回车选中光标所在项，Esc 仍取消", () => {
    const picked = one(24);
    picked.window.handleInput(DOWN);
    pressTimes(picked.window, SHIFT_DOWN, 5); pressTimes(picked.window, SHIFT_UP, 2);
    expect(picked.text()).toContain("<warning>→ 选项乙</>");
    picked.window.handleInput(ENTER);
    expect(picked.done).toEqual([[{ choices: ["选项乙"] }]]);
    const plainEnter = one(24);
    plainEnter.window.handleInput(DOWN); plainEnter.window.handleInput(ENTER);
    expect(plainEnter.done).toEqual(picked.done);
    const cancelled = one(24);
    pressTimes(cancelled.window, SHIFT_DOWN, 3); cancelled.window.handleInput(ESC);
    expect(cancelled.done).toEqual([undefined]);
  });

  test("光标在其他输入行上，内容放不下时 Shift+↑↓ 滚内容，不动输入框的文字和光标", () => {
    const { window, done, plain } = one(24, { allowOther: true });
    pressTimes(window, DOWN, 2);
    typeText(window, "ab"); window.handleInput(LEFT);
    const before = frame(plain()).above;
    pressTimes(window, SHIFT_DOWN, 3);
    const scrolled = frame(plain()).above;
    expect(scrolled).toBeGreaterThan(before);
    window.handleInput(SHIFT_UP);
    expect(frame(plain()).above).toBeLessThan(scrolled);
    typeText(window, "X");
    window.handleInput(ENTER);
    expect(done).toEqual([[{ choices: [], other: "aXb" }]]);
  });

  test("内容放得下时 Shift+↑↓ 不滚动", () => {
    const { window, raw } = one(24, { lines: marks(2) });
    const before = raw();
    pressTimes(window, SHIFT_DOWN, 2); window.handleInput(SHIFT_UP);
    expect(raw()).toEqual(before);
    expect(raw().join("\n")).not.toMatch(/上面还有|下面还有/u);
  });

  const manyChoices = (extra: Record<string, unknown> = {}) => Array.from({ length: 20 }, (_, n) => ({ label: `选项${String(n + 1).padStart(2, "0")}`, ...extra }));
  const label = (n: number) => `选项${String(n).padStart(2, "0")}`;

  test("选项有 20 个、内容 30 行：总行数等于上限，内容区固定 3 行（两行正文加下提示），选项区只显示一段，上下隐藏个数按项计", () => {
    const { window, plain } = one(24, { choices: manyChoices(), lines: marks(30), caption: undefined });
    const lines = plain();
    expect(lines).toHaveLength(14);
    expect(lines[1]).toContain("要选哪一个");
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^ ↓ 下面还有 \d+ 行$/u);
    expect(lines[4]).toBe("");
    const region = lines.slice(5, -3);
    expect(region.some((line) => /^ ↓ 下面还有 \d+ 项$/u.test(line))).toBe(true);
    expect(region.some((line) => line.includes("上面还有"))).toBe(false);
    window.handleInput(SHIFT_DOWN);
    expect(plain().slice(4)).toEqual(lines.slice(4));
    expect(plain().slice(1, 4)).not.toEqual(lines.slice(1, 4));
  });

  test.each(tones)("%s 语气：按 DOWN 走到底再 UP 走回最上，每一步光标所在选项都显示，隐藏项数写对", (tone) => {
    const { window, plain, text } = one(24, { choices: manyChoices() }, tone);
    const check = (n: number) => {
      const lines = plain();
      expect(lines).toHaveLength(14);
      expect(text()).toMatch(tone === "warning" ? new RegExp(`<warning>→ ${label(n)}</>`, "u") : new RegExp(`→ ${n}\\. ${label(n)}`, "u"));
      const visible = lines.flatMap((line) => { const found = /选项(\d\d)/u.exec(line); return found ? [Number(found[1])] : []; });
      const aboveHint = lines.map((line) => /^ ↑ 上面还有 (\d+) 项$/u.exec(line)).find(Boolean), belowHint = lines.map((line) => /^ ↓ 下面还有 (\d+) 项$/u.exec(line)).find(Boolean);
      expect(Number(aboveHint?.[1] ?? 0)).toBe(Math.min(...visible) - 1);
      expect(Number(belowHint?.[1] ?? 0)).toBe(20 - Math.max(...visible));
    };
    check(1);
    for (let n = 2; n <= 20; n++) { window.handleInput(DOWN); check(n); }
    for (let n = 19; n >= 1; n--) { window.handleInput(UP); check(n); }
  });

  test("选项带说明占多行：光标所在选项的第一行（含 →）每一步都显示", () => {
    const { window, text } = one(24, { choices: manyChoices({ description: "说明文字很长".repeat(30) }) });
    for (let n = 1; n <= 20; n++) {
      if (n > 1) window.handleInput(DOWN);
      expect(text()).toContain(`<warning>→ ${label(n)}`);
    }
  });

  test("多问题窗口第一题滚到底后回车，第二题和核对页都从最上面开始", () => {
    const { window, plain } = tall(24, [..."甲乙丙"].map((header) => longQuestion({ header, question: `问题${header}`, choices: [{ label: "选项甲" }] })), "standard");
    pressTimes(window, SHIFT_DOWN, 60);
    expect(plain().join("\n")).toContain("内容100行");
    window.handleInput(ENTER);
    expect(plain().join("\n")).toContain("问题乙");
    expect(plain().join("\n")).not.toContain("上面还有");
    pressTimes(window, SHIFT_DOWN, 60); window.handleInput(ENTER);
    expect(plain().join("\n")).toContain("问题丙");
    expect(plain().join("\n")).not.toContain("上面还有");
    pressTimes(window, SHIFT_DOWN, 60); window.handleInput(ENTER);
    expect(plain().join("\n")).toContain("核对你的回答");
    expect(plain().join("\n")).not.toContain("上面还有");
    pressTimes(window, SHIFT_DOWN, 60);
    window.handleInput(LEFT);
    expect(plain().join("\n")).toContain("问题丙");
    expect(plain().join("\n")).not.toContain("上面还有");
  });

  test("核对页答案放不下时限高，提交取消和提示固定在下方，Shift+↑↓ 滚动答案列表", () => {
    const letters = [..."甲乙丙丁戊己庚辛壬癸"];
    const { window, plain, text } = tall(24, letters.map((header) => ({ header, question: `问题${header}`, choices: [{ label: `答案${header}` }] })));
    pressTimes(window, ENTER, 10);
    expect(text()).toContain("核对你的回答");
    const top = plain();
    expect(top).toHaveLength(14);
    expect(top.at(-1)).toMatch(BORDER);
    expect(text()).toContain("<warning>→ 提交</>");
    expect(top.join("\n")).toContain("Shift+↑↓ 滚动内容");
    expect(top.join("\n")).toMatch(/下面还有 \d+ 行/u);
    window.handleInput(SHIFT_DOWN);
    const scrolled = plain();
    expect(scrolled.join("\n")).toContain("上面还有 3 行");
    expect(scrolled).toHaveLength(14);
    expect(scrolled.slice(-6)).toEqual(top.slice(-6));
    pressTimes(window, SHIFT_DOWN, 20);
    expect(plain().join("\n")).toContain("癸：答案癸");
    expect(plain().join("\n")).not.toContain("下面还有");
  });

  test("内容放不下时点击输入栏所在行，光标定位到输入栏，收起和展开两种状态都行", () => {
    const collapsed = one(24, { allowOther: true, choices: [{ label: "选项甲" }] });
    collapsed.window.handleInput(DOWN);
    typeText(collapsed.window, "abc");
    collapsed.window.handleInput(UP);
    const row = collapsed.plain().findIndex((line) => line.startsWith("      › abc"));
    expect(row).toBeGreaterThan(-1);
    collapsed.window.handleMouse(click(8, row) as never);
    typeText(collapsed.window, "Z");
    expect(collapsed.text()).toContain("<warning>→ 其他（自己输入）</>");
    expect(collapsed.plain().some((line) => line.startsWith("      › ") && line.includes("Z"))).toBe(true);

    const expanded = one(24, { allowOther: true, choices: [{ label: "选项甲" }] });
    expanded.window.handleInput(DOWN);
    typeText(expanded.window, "abc");
    const barRow = expanded.plain().findIndex((line) => line.startsWith("      › abc"));
    expanded.window.handleMouse(click(8 + visibleWidth("a"), barRow) as never);
    typeText(expanded.window, "Z");
    expect(expanded.plain().some((line) => line.startsWith("      › aZbc"))).toBe(true);
  });

  test("滚到最后后终端变矮或变高再 render：总行数不超过新上限，上面还有、显示的内容、下面还有三项之和等于内容总行数", () => {
    const { terminal, window, plain } = one(24);
    const total = fullTotal();
    pressTimes(window, SHIFT_DOWN, 60);
    for (const [rows, cap] of [[40, 24], [12, 11], [84, 50], [24, 14]]) {
      terminal.rows = rows!;
      const lines = plain();
      const now = frame(lines);
      expect(lines.length).toBeLessThanOrEqual(cap!);
      expect(now.above + now.shown + now.below).toBe(total);
      expect(now.shown).toBeGreaterThan(0);
    }
  });

  test.each(tones)("%s 语气：滚到最后后内容最后一行可见", (tone) => {
    const { window, text } = one(24, {}, tone);
    pressTimes(window, SHIFT_DOWN, 60);
    expect(text()).toContain("内容100行");
    expect(text()).toContain("选项甲");
  });

  test("standard 语气下问题文字折成 30 行、没有 lines：问题文字跟着内容滚动，选项固定", () => {
    const question = "问".repeat(39 * 30);
    const { window, plain } = one(24, { question, lines: undefined, caption: undefined }, "standard");
    const top = plain();
    expect(top).toHaveLength(14);
    expect(top.join("\n")).toMatch(/下面还有 \d+ 行/u);
    expect(top.join("\n")).not.toContain("上面还有");
    const tail = top.slice(frame(top).first);
    window.handleInput(SHIFT_DOWN);
    const scrolled = plain();
    expect(scrolled.join("\n")).toContain("上面还有 3 行");
    expect(scrolled).toHaveLength(14);
    expect(scrolled.slice(frame(scrolled).first)).toEqual(tail);
  });

  test.each(tones.flatMap((tone) => [80, 40].map((width) => [tone, width] as const)))("%s 语气 宽度 %i：顶部、滚动中、滚到底的每一行都不超过宽度", (tone, width) => {
    const { window, raw } = one(24, {}, tone);
    const check = () => { for (const line of raw(width)) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(width); };
    check();
    pressTimes(window, SHIFT_DOWN, 5); check();
    pressTimes(window, SHIFT_DOWN, 60); check();
  });

  const allContentRows = (plain: string[]) => plain.flatMap((line) => { const found = /内容(\d+)行/u.exec(line); return found ? [Number(found[1])] : []; });
  const sweep = (window: QuestionWindowView, plain: () => string[], key: string) => {
    const seen = new Set<number>();
    let previous = "";
    for (let n = 0; n < 200; n++) {
      const current = plain().join("\n");
      for (const row of allContentRows(plain())) seen.add(row);
      if (current === previous) break;
      previous = current;
      window.handleInput(key);
    }
    return seen;
  };
  const everyRow = (count: number) => Array.from({ length: count }, (_, n) => n + 1);

  test.each([
    ["5 个选项", 24, 5], ["20 个选项", 24, 20], ["选项 6 个", 24, 6], ["选项 7 个", 24, 7], ["选项 8 个", 24, 8], ["矮终端 20 个选项", 5, 20],
  ] as const)("%s 终端 %i 行：Shift+↓ 滚到底不漏任何内容行，Shift+↑ 能回到第一行", (_name, rows, count) => {
    const choices = Array.from({ length: count }, (_, n) => ({ label: n === 0 ? "选项甲" : `选项${n}` }));
    const { window, plain } = one(rows, { choices, lines: marks(40), caption: undefined });
    const down = sweep(window, plain, SHIFT_DOWN);
    expect([...down].sort((a, b) => a - b)).toEqual(everyRow(40));
    const up = sweep(window, plain, SHIFT_UP);
    expect(up.has(1)).toBe(true);
    expect(plain().join("\n")).toContain("要选哪一个");
    expect(plain().join("\n")).not.toContain("上面还有");
  });

  test("问题只有一行没有 lines、选项 20 个：内容不用滚动，不出现 Shift+↑↓ 和行数提示，只有项数提示，Shift+↓ 不改变输出", () => {
    const { window, raw, text } = one(24, { choices: manyChoices(), lines: undefined, caption: undefined });
    expect(raw()).toHaveLength(14);
    expect(text()).toContain("要选哪一个");
    expect(text()).not.toMatch(/Shift\+↑↓|上面还有 \d+ 行|下面还有 \d+ 行/u);
    expect(text()).toMatch(/下面还有 \d+ 项/u);
    const before = raw();
    window.handleInput(SHIFT_DOWN);
    expect(raw()).toEqual(before);
  });

  test("矮终端 5 行（上限 11）、20 个选项、内容 40 行：DOWN 走到底再 UP 走回顶，每一步总行数等于 11 且光标所在选项可见", () => {
    const { window, raw, text } = one(5, { choices: manyChoices(), lines: marks(40) });
    const check = (n: number) => {
      expect(raw()).toHaveLength(11);
      expect(text()).toContain(`<warning>→ ${label(n)}</>`);
    };
    check(1);
    for (let n = 2; n <= 20; n++) { window.handleInput(DOWN); check(n); }
    for (let n = 19; n >= 1; n--) { window.handleInput(UP); check(n); }
  });

  const reviewOf = (count: number, answer: (header: string) => string) => {
    const result = tall(24, [..."甲乙丙丁戊己庚辛壬癸"].slice(0, count).map((header) => ({ header, question: `问题${header}`, choices: [{ label: answer(header) }] })));
    pressTimes(result.window, ENTER, count);
    return result;
  };

  test.each([[40], [60]])("核对页内容放不下、宽度 %i：每行都不超过宽度，提示文字完整", (width) => {
    const { plain } = reviewOf(4, (header) => Array(12).fill("答案内容").join(" ") + header);
    const lines = plain(width);
    expect(lines.join("\n")).toContain("核对你的回答");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const hint = lines.join("").replace(/\s/gu, "");
    expect(hint).toContain("Shift+↑↓滚动内容");
    expect(hint).toContain("Esc取消");
  });

  test("核对页内容放不下时提示顺序：选择、确认、滚动内容、回去修改、取消", () => {
    expect(reviewOf(10, (header) => `答案${header}`).text()).toContain("↑↓ 选择 · 回车确认 · Shift+↑↓ 滚动内容 · ←→ 回去修改 · Esc 取消</>");
  });

  test("内容放得下且光标在其他输入行：Shift+↑ 不被吞掉，输入框收到和直接给编辑器一样的按键", () => {
    const { window, done, plain } = one(24, { allowOther: true, choices: [{ label: "选项甲" }], lines: marks(1) });
    const editor = new Editor({ requestRender() {}, terminal: { rows: 24, columns: 80 } } as never, { borderColor: (text: string) => text, selectList: {} } as never, { paddingX: 0 });
    const feed = (data: string) => { window.handleInput(data); editor.handleInput(data); };
    window.handleInput(DOWN);
    for (const data of ["a", "b", SHIFT_ENTER, "c", "d", SHIFT_UP, "Z"]) feed(data);
    expect(plain().join("\n")).not.toMatch(/上面还有 \d+ 行/u);
    window.handleInput(ENTER);
    expect(done).toEqual([[{ choices: [], other: editor.getExpandedText().trim() }]]);
  });

  test("光标在其他行、输入 9 行、内容放不下：输入框每一可见行连同光标行、提示行和下边框都显示，总行数允许超过上限", () => {
    const typeRows = (window: QuestionWindowView) => {
      window.handleInput(DOWN);
      for (let n = 1; n <= 9; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, `行${n}`); }
    };
    const fit = one(24, { allowOther: true, choices: [{ label: "选项甲" }], lines: marks(1), cancelNote: undefined });
    typeRows(fit.window);
    const expected = barOf(fit.raw(), OTHER_LABEL);
    const overflow = one(24, { allowOther: true, choices: [{ label: "选项甲" }], cancelNote: undefined });
    typeRows(overflow.window);
    const rendered = overflow.raw();
    const actual = barOf(rendered, OTHER_LABEL);
    expect(actual.lines).toEqual(expected.lines);
    expect(actual.raw.some((line) => line.includes("\x1b_pi:fc\x07"))).toBe(true);
    expect(bare(rendered.at(-2)!)).toContain("Esc 取消");
    expect(bare(rendered.at(-2)!)).toContain("Shift+↑↓ 滚动内容");
    expect(rendered.at(-1)).toMatch(/─{80}/u);
    expect(overflow.text()).toContain("直接输入");
  });

  const tailChoices = () => Array.from({ length: 20 }, (_, n) => ({ label: label(n + 1) }));

  test("选项很多、窗口起点不在第一项：点击输入栏的实际行把光标定位到输入栏里点中的位置", () => {
    const { window, plain } = one(24, { allowOther: true, choices: tailChoices() });
    pressTimes(window, DOWN, 20);
    typeText(window, "abc");
    const lines = plain();
    expect(lines.some((line) => /^ ↑ 上面还有 \d+ 项$/u.test(line))).toBe(true);
    const row = lines.findIndex((line) => line.startsWith("      › abc"));
    expect(row).toBeGreaterThan(-1);
    window.handleMouse(click(8 + visibleWidth("a"), row) as never);
    typeText(window, "Z");
    expect(plain().some((line) => line.startsWith("      › aZbc"))).toBe(true);
  });

  test("输入栏不在可见选项里：点击窗口任何一行都不会把光标移到输入栏，打字也不进输入框", () => {
    const { window, plain, text } = one(24, { allowOther: true, choices: tailChoices() });
    pressTimes(window, DOWN, 20);
    typeText(window, "abc");
    pressTimes(window, UP, 20);
    const lines = plain();
    expect(lines.some((line) => line.startsWith("      › "))).toBe(false);
    for (let y = 0; y < lines.length; y++) window.handleMouse(click(8, y) as never);
    typeText(window, "Z");
    expect(text()).toContain(`<warning>→ ${label(1)}</>`);
    pressTimes(window, DOWN, 20);
    expect(barOf(window.render(80), OTHER_LABEL).lines.map((line) => line.trimEnd())).toContain("      › abc");
  });

  const squeezed = (lines: string[]) => lines.join("").replace(/\s/gu, "");

  test.each([[120], [200]])("光标所在选项的 description 和推荐理由（理由 %i 字）整组显示，总行数允许超过上限，其余选项收起", (reasonLength) => {
    const { raw, plain } = one(24, { lines: marks(30), caption: undefined, allowOther: true, choices: [
      { label: "选项甲", recommended: true, description: "说".repeat(116) + "末尾甲", recommendedReason: "荐".repeat(reasonLength - 4) + "末尾荐" },
      { label: "选项乙", description: "短说明" }] }, "standard");
    const lines = plain();
    expect(squeezed(lines)).toContain("末尾甲");
    expect(squeezed(lines)).toContain("末尾荐");
    expect(lines.join("\n")).toContain("下面还有 2 项");
    expect(raw().at(-1)).toMatch(/─{80}/u);
    expect(lines.at(-3)).toBe("");
  });

  test("光标所在选项的 description 折成 10 行以上时每一折行都显示，总行数允许超过上限", () => {
    const description = "首标" + "说".repeat(180) + "中标" + "说".repeat(180) + "末标";
    const { plain } = one(24, { lines: marks(30), caption: undefined, choices: [{ label: "选项甲", description }, { label: "选项乙", description: "短" }] });
    const lines = plain();
    const joined = squeezed(lines);
    expect(joined).toContain("首标");
    expect(joined).toContain("中标");
    expect(joined).toContain("末标");
    expect(joined.match(/说/gu)!.length).toBe(360);
    expect(lines.at(-1)).toMatch(/─{80}/u);
  });

  test("光标移到别的选项后，那个选项整组显示，原来的选项收起", () => {
    const long = (mark: string) => "说".repeat(400) + mark;
    const { window, plain } = one(24, { lines: marks(30), caption: undefined, choices: [
      { label: "选项甲", description: long("末尾甲") }, { label: "选项乙", description: long("末尾乙") }] });
    expect(squeezed(plain())).toContain("末尾甲");
    expect(squeezed(plain())).not.toContain("末尾乙");
    window.handleInput(DOWN);
    expect(squeezed(plain())).toContain("末尾乙");
    expect(squeezed(plain())).not.toContain("末尾甲");
  });

  test("项目规范窗口在矮分屏（rows 18，上限 11）：总行数等于上限，内容区有下面还有，三个选项和滚动提示都在，Shift+↓ 能读完 20 行", () => {
    const { window, raw, plain, text } = one(18, { caption: undefined, cancelNote: undefined, allowOther: true, lines: marks(20),
      choices: [{ label: "写入" }, { label: "不写入" }] });
    const lines = plain();
    expect(raw()).toHaveLength(11);
    expect(lines.slice(1, -6).some((line) => /^ ↓ 下面还有 \d+ 行$/u.test(line))).toBe(true);
    expect(text()).toContain("<warning>→ 写入</>");
    expect(lines).toContain("   不写入");
    expect(lines).toContain("   其他（自己输入）");
    expect(lines.join("\n")).toContain("Shift+↑↓ 滚动内容");
    expect([...sweep(window, plain, SHIFT_DOWN)].sort((a, b) => a - b)).toEqual(everyRow(20));
  });
});
