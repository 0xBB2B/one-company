import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
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

const NOTE_LABEL = "通过并补充说明（自己输入）";
const noteQuestion = (extra: Record<string, unknown> = {}) => ({ question: "确认原型", choices: [{ label: "通过（写进需求草稿）" }, { label: NOTE_LABEL, writable: true }],
  allowOther: true, otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版", ...extra });
const noteView = (extra: Record<string, unknown> = {}) => view({ tone: "warning", questions: [noteQuestion(extra)] });
const typeText = (window: { handleInput(data: string): void }, value: string) => { for (const char of value) window.handleInput(char); };

test("可输入选项：三行按顺序渲染，光标在普通项时提示不含直接输入，移到可输入项后提示变为直接输入并出现输入栏", () => {
  const { window, text } = noteView();
  const first = plain(text());
  expect(first.indexOf("通过（写进需求草稿）")).toBeGreaterThan(-1);
  expect(first.indexOf(NOTE_LABEL)).toBeGreaterThan(first.indexOf("通过（写进需求草稿）"));
  expect(first.indexOf(OTHER_LABEL)).toBeGreaterThan(first.indexOf(NOTE_LABEL));
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  expect(text()).not.toContain("›");
  window.handleInput(DOWN);
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版</>");
  const bar = barOf(text().split("\n"), NOTE_LABEL);
  expect(bar.lines[0]).toMatch(/^ {6}› /u);
  expect(bar.raw[0]).toContain("\x1b_pi:fc\x07");
});

test("可输入选项：空输入或只有空白时回车不起作用", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  typeText(window, "  ");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
});

test("可输入选项：超过 otherMaxLength 时提示超出字数且回车不起作用，退格回到上限后可提交", () => {
  const { window, text, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "字".repeat(4001));
  expect(text()).toContain("超出 1 字，最多 4000 字");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
  window.handleInput(BACKSPACE);
  expect(text()).not.toContain("超出");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "字".repeat(4000) }]]);
});

test("可输入选项：提交时 other 去掉首尾空白，choices 为该项名称", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "  用 B  ");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "用 B" }]]);
});

test("可输入选项：可输入项与其他行各自保留文字和光标位置，离开后显示文字但没有光标块", () => {
  const { window, text, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "乙丙");
  window.handleInput(LEFT);
  window.handleInput(DOWN);
  typeText(window, "甲丁");
  window.handleInput(LEFT);
  window.handleInput(UP);
  const left = barOf(text().split("\n"), OTHER_LABEL);
  expect(left.lines[0]!.trimEnd()).toBe("      › 甲丁");
  expect(left.raw.join("")).not.toContain("\x1b_pi:fc\x07");
  const kept = barOf(text().split("\n"), NOTE_LABEL);
  expect(kept.lines[0]!.trimEnd()).toBe("      › 乙丙");
  expect(kept.raw.join("")).toContain("\x1b_pi:fc\x07");
  typeText(window, "X");
  window.handleInput(DOWN);
  typeText(window, "Y");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [], other: "甲Y丁" }]]);
});

test("可输入选项：没字的输入行离开后不显示输入栏", () => {
  const { window, text } = noteView();
  window.handleInput(DOWN);
  expect(bare(text())).toContain("›");
  window.handleInput(UP);
  expect(bare(text())).not.toContain("›");
});

test("其他行默认显示\"其他（自己输入）\"，chooseOrWriteWindow 不传 otherLabel 也能打开并返回答案", async () => {
  const lines = noteView().text().split("\n").map(bare);
  expect(lines.filter((line) => /^( → |   )/u.test(line) && line.trim())[2]).toContain(OTHER_LABEL);
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }, { label: NOTE_LABEL, writable: true }] };
  expect(await chooseOrWriteWindow(fakeUi((c) => { c.handleInput(DOWN); c.handleInput(DOWN); typeText(c, "自己写"); c.handleInput(ENTER); }), request))
    .toEqual({ choices: [], other: "自己写" });
});

test.each([36, 44, 60, 80])("输入栏在 %d 列下自动折行：第一行前缀 6 空格 › 1 空格，续行 8 空格，换行后的字母另起一行，每行都不超宽", (width) => {
  const { window } = noteView();
  window.handleInput(DOWN);
  const han = "汉".repeat(100), letters = "abcdefghij".repeat(5);
  typeText(window, han);
  window.handleInput(SHIFT_ENTER);
  typeText(window, letters);
  const rendered = window.render(width);
  for (const line of rendered) expect(visibleWidth(line.replace(/<\/?[a-zA-Z]*>/gu, "")), line).toBeLessThanOrEqual(width);
  const bar = barOf(rendered, NOTE_LABEL).lines;
  expect(bar[0]!.startsWith("      › ")).toBe(true);
  for (const line of bar.slice(1)) expect(line.startsWith(" ".repeat(8))).toBe(true);
  const content = bar.map((line) => line.slice(8).trimEnd());
  const hanLines = content.filter((line) => line.includes("汉")), letterLines = content.filter((line) => /[a-j]/u.test(line));
  expect(hanLines.length).toBeGreaterThan(1);
  expect(hanLines.join("")).toBe(han);
  expect(letterLines.join("")).toBe(letters);
  expect(letterLines.some((line) => line.includes("汉"))).toBe(false);
});

test("输入栏按键：插入、Backspace、Delete、←→、Home、End、Shift+Enter 与 Ctrl+J 换行，回车提交", () => {
  const { window, done } = noteView();
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
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "YabX\nd\ne" }]]);
});

test("输入栏按键：Delete 删光标后一个字，→ 向右移动", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "abcd");
  window.handleInput(HOME);
  window.handleInput(RIGHT);
  window.handleInput(DELETE);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "acd" }]]);
});

test("输入栏 ↑↓ 在显示行间移动，首行 ↑ 到上一个选项，末行 ↓ 到下一个选项，回到输入行时回到离开时的光标位置", () => {
  const { window, text } = noteView();
  window.handleInput(DOWN);
  typeText(window, "一"); window.handleInput(SHIFT_ENTER);
  typeText(window, "二"); window.handleInput(SHIFT_ENTER);
  typeText(window, "三");
  window.handleInput(UP);
  window.handleInput(UP);
  typeText(window, "X");
  expect(barOf(text().split("\n"), NOTE_LABEL).lines.map((line) => line.slice(8).trimEnd())).toEqual(["一X", "二", "三"]);
  window.handleInput(UP);
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  window.handleInput(DOWN);
  expect(text()).toContain("直接输入");
  typeText(window, "Y");
  expect(barOf(text().split("\n"), NOTE_LABEL).lines.map((line) => line.slice(8).trimEnd())).toEqual(["一XY", "二", "三"]);
  window.handleInput(DOWN); window.handleInput(DOWN);
  typeText(window, "Z");
  expect(barOf(text().split("\n"), NOTE_LABEL).lines.map((line) => line.slice(8).trimEnd())).toEqual(["一XY", "二", "三Z"]);
  window.handleInput(DOWN);
  const other = barOf(text().split("\n"), OTHER_LABEL);
  expect(other.raw.join("")).toContain("\x1b_pi:fc\x07");
  expect(barOf(text().split("\n"), NOTE_LABEL).raw.join("")).not.toContain("\x1b_pi:fc\x07");
  window.handleInput(DOWN);
  expect(barOf(text().split("\n"), OTHER_LABEL).raw.join("")).toContain("\x1b_pi:fc\x07");
});

test("输入栏回车：首尾空白去掉，中间换行保留", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "  第一行");
  window.handleInput(SHIFT_ENTER);
  typeText(window, "第二行  ");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "第一行\n第二行" }]]);
});

test("输入栏回车：只有换行和空白时不提交", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  window.handleInput(SHIFT_ENTER);
  typeText(window, " ");
  window.handleInput(ENTER);
  expect(done).toEqual([]);
});

test("粘贴超过 10 行显示为 [paste #序号 +行数 lines]，单行超过 1000 字显示为 [paste #序号 字数 chars]，提交换回原文", () => {
  const { window, text, done } = noteView();
  window.handleInput(DOWN);
  const lines = Array.from({ length: 42 }, (_, n) => `第${n + 1}行`).join("\n"), long = "长".repeat(1200);
  window.handleInput(paste(lines));
  expect(bare(text())).toContain("[paste #1 +42 lines]");
  expect(bare(text())).not.toContain("第20行");
  window.handleInput(paste(long));
  expect(bare(text())).toContain("[paste #2 1200 chars]");
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: lines + long }]]);
});

test("粘贴折叠部分按原文算字数：折叠 3990 字再输入 11 字，超出 1 字显示在输入栏最后一行下面且回车不提交", () => {
  const { window, text, done } = noteView();
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

test("鼠标点击输入栏的文字，光标移到那个输入行并定位到被点的字前面；点在行尾后面的空白定位到行尾；点在选项文字上状态不变", () => {
  const setup = () => {
    const made = noteView();
    made.window.handleInput(DOWN); made.window.handleInput(DOWN);
    typeText(made.window, "一二三四五六七"); made.window.handleInput(SHIFT_ENTER); typeText(made.window, "八九");
    for (let n = 0; n < 5 && bare(made.text()).includes("直接输入"); n++) made.window.handleInput(UP);
    expect(made.text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
    return made;
  };
  const at = (made: ReturnType<typeof setup>, startsWith: string) => made.window.render(80).map(bare).findIndex((line) => line.startsWith(startsWith));

  const first = setup();
  first.window.handleMouse(click(8 + visibleWidth("一二三四"), at(first, "      › 一二三四五六七")));
  expect(first.text()).toContain("直接输入");
  typeText(first.window, "X");
  first.window.handleInput(ENTER);
  expect(first.done).toEqual([[{ choices: [], other: "一二三四X五六七\n八九" }]]);

  const second = setup();
  second.window.handleMouse(click(70, at(second, "        八九")));
  typeText(second.window, "Y");
  expect(barOf(second.window.render(80), OTHER_LABEL).lines.map((line) => line.slice(8).trimEnd())).toEqual(["一二三四五六七", "八九Y"]);

  const third = setup();
  third.window.handleMouse(click(6, at(third, " → 通过（写进需求草稿）")));
  expect(third.text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
  third.window.handleInput(ENTER);
  expect(third.done).toEqual([[{ choices: ["通过（写进需求草稿）"] }]]);
});

test("输入栏有字时按 Esc：没有 escapeChoice 的窗口收到 undefined", () => {
  const { window, done } = view({ tone: "warning", questions: [{ question: "确认原型", choices: [{ label: "通过" }, { label: NOTE_LABEL, writable: true }], allowOther: true }] });
  window.handleInput(DOWN);
  typeText(window, "乙");
  window.handleInput(ESC);
  expect(done).toEqual([undefined]);
});

test("escapeChoice：按 Esc 返回指定答案；没有 escapeChoice 的窗口按 Esc 仍返回 undefined", () => {
  const withEscape = noteView();
  withEscape.window.handleInput(ESC);
  expect(withEscape.done).toEqual([[{ choices: ["放弃这一版"] }]]);
  const without = view({ tone: "warning", questions: [{ question: "确认原型", choices: [{ label: "通过" }], allowOther: true }] });
  without.window.handleInput(ESC);
  expect(without.done).toEqual([undefined]);
});

test("escapeChoice：在输入行里有字时按 Esc 也返回指定答案", () => {
  const { window, done } = noteView();
  window.handleInput(DOWN);
  typeText(window, "乙");
  window.handleInput(ESC);
  expect(done).toEqual([[{ choices: ["放弃这一版"] }]]);
});

test("chooseOrWriteWindow 透传 writable 和 escapeChoice，signal 中断时返回 undefined", async () => {
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }, { label: NOTE_LABEL, writable: true }] };
  expect(await chooseOrWriteWindow(fakeUi((c) => { c.handleInput(DOWN); typeText(c, " 用 B "); c.handleInput(ENTER); }), request))
    .toEqual({ choices: [NOTE_LABEL], other: "用 B" });
  expect(await chooseOrWriteWindow(fakeUi((c) => c.handleInput(ESC)), request)).toEqual({ choices: ["放弃这一版"] });
  const abort = new AbortController();
  const pending = chooseOrWriteWindow(fakeUi(() => {}), request, abort.signal);
  abort.abort();
  expect(await pending).toBeUndefined();
});

test("chooseOrWriteWindow 窗口已显示、输入行里有字时被中断，返回 undefined 而不是 Esc 的指定答案", async () => {
  const request = { title: "确认原型", lines: [], otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版",
    choices: [{ label: "通过（写进需求草稿）" }, { label: NOTE_LABEL, writable: true }] };
  const abort = new AbortController();
  const host = fakeUi((c) => { c.handleInput(DOWN); typeText(c, "用 B"); });
  const pending = chooseOrWriteWindow(host, request, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(host.shown).toBe(1);
  abort.abort();
  expect(await pending).toBeUndefined();
});

test("光标在\"其他\"输入行时底部提示也是直接输入那组，Esc 那一段用 escapeHint", () => {
  const { window, text } = view({ tone: "warning", questions: [{ question: "确认原型", choices: [{ label: "通过（写进需求草稿）" }, { label: NOTE_LABEL, writable: true }],
    allowOther: true, otherLabel: "返工（自己输入要改什么）", otherMaxLength: 4000, escapeChoice: "放弃这一版", escapeHint: "Esc 放弃这一版" }] });
  window.handleInput(DOWN); window.handleInput(DOWN);
  expect(text()).toContain("<muted>直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版</>");
});

const INPUT_HINT = "直接输入";
const contentOf = (rendered: string[], label: string) => barOf(rendered, label).lines.map((line) => line.slice(8).trimEnd());

test("光标在输入行上时输入栏保留 pi 编辑器的假光标标记，不出现 \\x1b[7m；光标不在该行时没有标记", () => {
  const { window, text } = noteView();
  window.handleInput(DOWN);
  typeText(window, "ab");
  window.handleInput(LEFT);
  const raw = barOf(text().split("\n"), NOTE_LABEL).raw.join("");
  expect(raw).toContain("\x1b_pi:fc\x07");
  expect(raw).toContain("\x1b_pi:/fc\x07");
  expect(raw).not.toContain("\x1b[7m");
  expect(raw).toContain("\x1b_pi:c\x07");
  window.handleInput(UP);
  const left = barOf(text().split("\n"), NOTE_LABEL).raw.join("");
  expect(left).not.toContain("\x1b_pi:fc\x07");
  expect(left).not.toContain("\x1b_pi:c\x07");
  expect(left).not.toContain("\x1b[7m");
});

test("输入栏长文字自动折行后，↑ 先在显示行之间上移，到第一显示行再按 ↑ 才到上一个选项", () => {
  const { window } = noteView();
  const text = () => window.render(36).join("\n");
  window.handleInput(DOWN);
  typeText(window, "汉".repeat(50));
  const rows = barOf(window.render(36), NOTE_LABEL).lines.length;
  expect(rows).toBeGreaterThanOrEqual(3);
  for (let n = 0; n < rows - 1; n++) {
    window.handleInput(UP);
    expect(text()).toContain(INPUT_HINT);
  }
  window.handleInput(UP);
  expect(text()).not.toContain(INPUT_HINT);
});

test("输入栏长文字自动折行后，按一次 ↑ 光标停在倒数第二个显示行", () => {
  const { window } = noteView();
  window.handleInput(DOWN);
  typeText(window, "汉".repeat(50));
  const before = barOf(window.render(36), NOTE_LABEL).lines.length;
  window.handleInput(UP);
  typeText(window, "X");
  const lines = contentOf(window.render(36), NOTE_LABEL);
  expect(lines.length).toBeGreaterThanOrEqual(before);
  expect(lines.findIndex((line) => line.includes("X"))).toBe(before - 2);
});

test("含粘贴标记的折行：标记在第二显示行时按 ↑，光标仍在输入行并到第一显示行", () => {
  const { window } = noteView();
  const text = () => window.render(36).join("\n");
  window.handleInput(DOWN);
  typeText(window, "abcdefghij ");
  window.handleInput(paste(Array.from({ length: 42 }, (_, n) => `第${n + 1}行`).join("\n")));
  typeText(window, "xyz");
  const before = contentOf(window.render(36), NOTE_LABEL);
  expect(before.length).toBeGreaterThanOrEqual(2);
  expect(before[1]).toContain("xyz");
  window.handleInput(UP);
  expect(text()).toContain(INPUT_HINT);
  typeText(window, "Q");
  const after = contentOf(window.render(36), NOTE_LABEL);
  expect(after[0]).toContain("Q");
});

test("输入栏行数超过可见行数时，↑ 从第 8 行逐行上移到第 1 行，再 ↑ 才到上一个选项；↓ 同理", () => {
  const small = { requestRender() {}, terminal: { rows: 10, columns: 80 } };
  const done: Array<WindowAnswer[] | undefined> = [];
  const window = new QuestionWindowView({ tui: small, theme, onDone: (answers) => done.push(answers), tone: "warning", questions: [noteQuestion()] } as never);
  const text = () => window.render(80).join("\n");
  window.handleInput(DOWN);
  for (let n = 1; n <= 8; n++) { if (n > 1) window.handleInput(SHIFT_ENTER); typeText(window, String(n)); }
  for (let n = 0; n < 7; n++) {
    window.handleInput(UP);
    expect(text(), `第 ${n + 1} 次 ↑`).toContain(INPUT_HINT);
  }
  typeText(window, "X");
  expect(contentOf(window.render(80), NOTE_LABEL)).toContain("1X");
  window.handleInput(UP);
  expect(text()).not.toContain(INPUT_HINT);
  window.handleInput(DOWN);
  expect(text()).toContain(INPUT_HINT);
  for (let n = 0; n < 7; n++) window.handleInput(DOWN);
  typeText(window, "Z");
  expect(contentOf(window.render(80), NOTE_LABEL)).toContain("8Z");
  expect(contentOf(window.render(80), OTHER_LABEL)).toEqual([]);
  window.handleInput(DOWN);
  typeText(window, "W");
  expect(contentOf(window.render(80), NOTE_LABEL)).not.toContain("W");
  expect(contentOf(window.render(80), OTHER_LABEL)).toEqual(["W"]);
});

test.each([
  ["move", "left"], ["press", "left"], ["drag", "left"], ["release", "left"], ["wheel", "left"], ["click", "right"],
])("鼠标只认左键单击：%s（%s）事件不动光标", (type, button) => {
  const { window, text } = noteView();
  window.handleInput(DOWN);
  typeText(window, "一二三");
  window.handleInput(UP);
  const row = window.render(80).map(bare).findIndex((line) => line.startsWith("      › 一二三"));
  expect(window.handleMouse({ ...click(8, row), type, button, wheelDelta: 1 } as never)).toBeUndefined();
  expect(text()).not.toContain(INPUT_HINT);
  expect(text()).toContain("<muted>↑↓ 选择 · 回车确认 · Esc 放弃这一版</>");
});

test("小粘贴（3 行）原样插入：输入栏显示 3 行，提交的 other 是原文", () => {
  const { window, text, done } = noteView();
  window.handleInput(DOWN);
  window.handleInput(paste("甲\n乙\n丙"));
  expect(contentOf(text().split("\n"), NOTE_LABEL)).toEqual(["甲", "乙", "丙"]);
  window.handleInput(ENTER);
  expect(done).toEqual([[{ choices: [NOTE_LABEL], other: "甲\n乙\n丙" }]]);
});
