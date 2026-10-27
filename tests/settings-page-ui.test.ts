import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SettingsPageView, tilde } from "../src/modules/settings/settings-page-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../src/modules/agents/agent-copy.ts";
import { projectSettingsPath, readAgentSettings, userSettingsPath } from "../src/modules/settings/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../src/modules/agents/roles.ts";
import { initRepoWithOrigin, installFakeGh } from "./helpers/fake-gh.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";
const SOL = { provider: "5x", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LUNA = { provider: "5x", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { minimal: null, max: null } };
const OPENAI_SOL = { provider: "openai", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LONG = { provider: "some-long-provider", id: "claude-opus-5-5-extended-context-preview", reasoning: true, thinkingLevelMap: {} };
const GRAY_NOTE = /gpt-6-luna 不支持/u;
const NOTICE = "✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp";
const MODEL_HINT = "←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层";
const AGENT_HINT = "←/Esc 回左栏  ↑↓ 选择  回车 详情  空格 开关  C 复制";
const AGENT_HINT_OPEN = "←/Esc 回左栏  ↑↓ 选择  回车 收起  空格 开关  C 复制";
const MODE_FOOT = "Git 交付：远程＝推送并开 PR；仅本地＝合进主仓库当前分支";
const METHODS_FOOT = "合并方式：远程和仅本地都只用勾了的方式，压缩合并是推荐方式";
const SPACE = " ";

const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bg: (kind: string, text: string) => `[${kind}]${text}[/]`,
  bold: (text: string) => `**${text}**`, inverse: (text: string) => `!!${text}!!` };
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\[\/?[a-zA-Z]*\]|\*\*|!!/gu, "");
const squeeze = (text: string) => text.replace(/\s+/gu, "");

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function writeJson(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
const oneCompany = (entries: Record<string, unknown>) => ({ "one-company": entries });

interface PageOptions {
  trust?: "trusted" | "denied" | "unset"; state?: Record<string, unknown>; taken?: Record<string, string>; skills?: string; clean?: boolean; legacy?: boolean; longPath?: boolean; projectWorker?: boolean; noRole?: boolean; acmeWorker?: boolean; pairedBroken?: boolean; myWorker?: boolean; userWorker?: boolean;
  user?: unknown; project?: unknown; models?: unknown[]; mainModel?: unknown; mainThinking?: string;
  origin?: string | null; ghHosts?: string[]; glabHosts?: string[];
}
async function page(options: PageOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-t-")); roots.push(base);
  const root = options.longPath ? join(base, "a-rather-long-directory-name-used-to-force-wrapping") : base;
  const roleDirs = { defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p") };
  const agentDir = join(root, "agent"), repositoryRoot = join(root, "repo");
  const role = async (dir: string, name: string, frontmatter: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n正文\n`);
  };
  await role(roleDirs.userDir, "ui-worker", `description: 界面设计与实现，产出 HTML 预览\nrole: worker\nmodel: 5x/gpt-6-luna\nthinking: medium\nskills: [${options.skills ?? "ui-basics"}]`);
  await role(roleDirs.projectDir, "reviewer", "description: 本项目的审查\nrole: reviewer\nmodel: 5x/gpt-6-sol\nthinking: high");
  if (!options.clean) await role(roleDirs.userDir, "broken", "description: 坏\nrole: worker\nthinking: extreme");
  if (options.projectWorker) await role(roleDirs.projectDir, "proj-worker", "description: 项目的 worker\nrole: worker");
  if (options.myWorker) await role(roleDirs.userDir, "my-worker", "description: 我自己的 worker\nrole: worker");
  if (options.userWorker) await role(roleDirs.userDir, "worker", "description: 我的通用 worker\nrole: worker");
  if (options.acmeWorker) await role(roleDirs.userDir, "acme-worker", "description: 没有搭档的专项\nrole: worker");
  if (options.pairedBroken) {
    await role(roleDirs.userDir, "x-worker", "description: 正常的专项\nrole: worker");
    await role(roleDirs.userDir, "x-reviewer", "role: reviewer");
  }
  if (options.noRole) await role(roleDirs.userDir, "other", "description: 别的工具的定义");
  if (options.legacy) for (const name of ["pm", "interpreter", "draft-verifier"]) await role(roleDirs.userDir, name, `description: 旧定义\nrole: ${name}\nmodel: 5x/gpt-6-luna`);
  if (options.user !== undefined) await writeJson(userSettingsPath(agentDir), options.user);
  if (options.project !== undefined) await writeJson(projectSettingsPath(repositoryRoot), options.project);
  const trust = options.trust ?? "trusted", trusted = trust === "trusted";
  const catalog = await loadRoleCatalog({ ...roleDirs, parseFrontmatter, projectTrusted: trusted });
  const gh = await installFakeGh();
  let settings: Awaited<ReturnType<typeof readAgentSettings>>;
  try {
    if (options.origin !== undefined) await initRepoWithOrigin(repositoryRoot, options.origin);
    if (options.ghHosts) gh.ghLoggedIn(options.ghHosts);
    if (options.glabHosts) await gh.glabLoggedIn(options.glabHosts);
    settings = await readAgentSettings({ agentDir, repositoryRoot, projectTrusted: trusted });
  } finally {
    await gh.restore();
  }
  const toggles: string[] = [];
  const copies: Array<{ name: string; entry: string }> = [], saves: unknown[] = [], clears: unknown[] = [], switchSaves: unknown[] = [], switchClears: unknown[] = [];
  let closed = false;
  const view = new SettingsPageView({
    catalog, theme, projectTrust: trust, untrustedProjectCount: 1, settings, models: options.models ?? [SOL, LUNA],
    mainModel: "mainModel" in options ? options.mainModel : SOL, mainThinking: options.mainThinking ?? "high",
    ...(options.state ? { state: options.state } : {}),
    nameTaken: (name: string) => options.taken?.[name],
    onCopy: (request: { entry: { name: string }; name: string }) => copies.push({ name: request.name, entry: request.entry.name }),
    onSaveSetting: (request: unknown) => saves.push(request), onClearSetting: (request: unknown) => clears.push(request),
    onSaveSwitch: (request: unknown) => switchSaves.push(request), onClearSwitch: (request: unknown) => switchClears.push(request),
    onToggleAgent: (entry: { name: string }) => toggles.push(entry.name),
    onClose: () => { closed = true; },
  });
  const lines = (width = 80) => view.render(width);
  const rows = (width = 80) => lines(width).map(plain);
  const text = (width = 80) => rows(width).join("\n");
  const pane = (width = 80) => paneParts(rows(width)).join("\n");
  const right = (width = 80) => rightParts(rows(width)).join("\n");
  const press = (...keys: string[]) => { for (const key of keys) view.handleInput(key); };
  return { view, root, toggles, right, lines, rows, text, pane, press, copies, saves, clears, switchSaves, switchClears, closed: () => closed };
}
type Page = Awaited<ReturnType<typeof page>>;

const rightParts = (rows: string[]) => rows.map((row) => (row.includes("│") ? row.slice(row.indexOf("│") + 1) : row).trimEnd());
const paneParts = (rows: string[]) => rows.filter((row) => row.includes("│")).map((row) => row.slice(row.indexOf("│") + 1).trimEnd());
const navCells = (rows: string[]) => rows.filter((row) => row.includes("│")).map((row) => row.slice(0, row.indexOf("│")).replace(/\s+/gu, " ").trim());
const selectedPaneLine = (p: Page) => paneParts(p.rows()).find((line) => /^\s*[▸▾]\s/u.test(line)) ?? "";
const firstWord = (line: string) => line.split(/\s+/u).filter((word) => word && !/^[▸▾✓]$/u.test(word))[0];
function moveTo(p: Page, label: string) {
  const here = () => firstWord(selectedPaneLine(p)) === label;
  for (let i = 0; i < 12 && !here(); i++) p.press(DOWN);
  for (let i = 0; i < 24 && !here(); i++) p.press(UP);
  if (!here()) throw new Error(`光标移不到 ${label}：\n${p.pane()}`);
}
function moveToRowWith(p: Page, word: string) {
  const here = () => selectedPaneLine(p).includes(word);
  for (let i = 0; i < 12 && !here(); i++) p.press(DOWN);
  for (let i = 0; i < 24 && !here(); i++) p.press(UP);
  if (!here()) throw new Error(`光标移不到含 ${word} 的行：\n${p.pane()}`);
}
const SECTIONS = ["worker", "reviewer", "qa", "explore", "prototype", "models", "switches", "problems"] as const;
const inPane = (index: number) => [...Array<string>(index).fill(DOWN), RIGHT];
const enterSection = (p: Page, section: (typeof SECTIONS)[number]) => p.press(...inPane(SECTIONS.indexOf(section)));
const toModels = (p: Page) => enterSection(p, "models");
const toSwitches = (p: Page) => enterSection(p, "switches");

test("80 列打开：边框、标题、目录顺序与份数、worker 行带 ▸，没有问题时目录没有「问题」", async () => {
  const p = await page({ clean: true });
  const rows = p.rows();
  expect(rows[0]).toBe("─".repeat(80));
  expect(rows.at(-1)).toBe("─".repeat(80));
  expect(rows[1]).toMatch(/^ 设置 +\/one:setting $/u);
  expect(visibleWidth(rows[1]!)).toBe(80);
  expect(p.lines()[1]).toMatch(/<accent>[^\n]*设置/u);
  expect(p.lines()[1]).toMatch(/<muted>[^<]*\/one:setting/u);
  expect(rows.find((row) => row.includes("┬"))).toBe(`${"─".repeat(20)}┬${"─".repeat(59)}`);
  expect(rows.find((row) => row.includes("┴"))).toBe(`${"─".repeat(20)}┴${"─".repeat(59)}`);
  const cells = navCells(rows);
  expect(cells.slice(0, 10)).toEqual(["角色定义", "▸ worker 8", "reviewer 7", "qa 1", "explore 1", "prototype 1", "", "设定", "模型 3", "开关 2"]);
  expect(cells.slice(10).every((cell) => cell === "")).toBe(true);
  expect(p.text()).not.toContain("问题");
  expect(p.lines().join("\n")).toContain("<muted>");
});

test("有写错的定义时目录出现「问题」和条数，与上面的「开关」隔一个空行，红字", async () => {
  const p = await page();
  const cells = navCells(p.rows());
  expect(cells.slice(8, 12)).toEqual(["模型 3", "开关 2", "", "问题 1"]);
  expect(p.lines().find((line) => /问题 +1/u.test(plain(line)))).toMatch(/<error>[^\n]*问题/u);
});

test("设置文件也写错时「问题」条数相加", async () => {
  const p = await page({ project: oneCompany({ "git-delivery": "yes" }) });
  expect(navCells(p.rows())).toContain("问题 2");
});

test("项目授信记录为空时标题下多一行黄字写还没设为受信任，「问题」条数多一条", async () => {
  const u = await page({ trust: "unset" });
  const rows = u.rows();
  expect(rows[2]).toBe(" ! 项目还没设为受信任：项目层的定义和设定都没有生效");
  expect(u.lines()[2]).toContain("<warning>");
  expect(rows[3]).toBe(`${"─".repeat(20)}┬${"─".repeat(59)}`);
  expect(navCells(rows)).toContain("问题 2");
});

test("项目授信记录为不信任时标题下多一行黄字写项目未受信任，「问题」条数多一条", async () => {
  const u = await page({ trust: "denied" });
  const rows = u.rows();
  expect(rows[2]).toBe(" ! 项目未受信任：项目层的定义和设定都没有生效");
  expect(u.lines()[2]).toContain("<warning>");
  expect(rows[3]).toBe(`${"─".repeat(20)}┬${"─".repeat(59)}`);
  expect(navCells(rows)).toContain("问题 2");
});

test("项目已受信任时标题下没有黄字提示", async () => {
  const t = await page();
  expect(t.text()).not.toContain("项目未受信任");
  expect(t.text()).not.toContain("项目还没设为受信任");
  expect(t.rows()[2]).toContain("┬");
});

test("打开时焦点在目录，选中 worker，右栏显示 worker 的定义", async () => {
  const p = await page();
  const first = paneParts(p.rows());
  expect(first[0]!.trim()).toBe("worker  写代码");
  expect(first[1]!.trim()).toBe("");
  expect(first[2]).toMatch(/^\s*名称 +来源 +状态 +模型 +思考\s*$/u);
  expect(p.pane()).toMatch(/ui-worker +用户 +开启 +5x\/gpt-6-luna +medium/u);
  expect(p.text()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
});

test("焦点在目录时目录选中行铺底色；焦点进右栏后目录选中行改为强调色粗体不铺底色，右栏选中行铺底色", async () => {
  const p = await page();
  const navPart = (raw: string) => raw.slice(0, raw.indexOf("│"));
  const navRow = () => p.lines().find((line) => /worker +8/u.test(plain(line)) && plain(line).includes("│"))!;
  expect(navPart(navRow())).toContain("[selectedBg]");
  p.press(RIGHT);
  moveTo(p, "ui-worker");
  expect(navPart(navRow())).not.toContain("[selectedBg]");
  expect(navPart(navRow())).toMatch(/<accent>[^\n]*\*\*/u);
  const paneRow = p.lines().find((line) => plain(line).includes("▸ ui-worker"))!;
  expect(paneRow.slice(paneRow.indexOf("│"))).toContain("[selectedBg]");
});

test("目录里 ↓ 换分类，右栏跟着换：模型分类显示 PM、解释器、草稿核验器三行", async () => {
  const p = await page();
  p.press(...Array<string>(5).fill(DOWN));
  const rows = paneParts(p.rows());
  expect(rows[0]!.trim()).toBe("模型  PM 和两个内部代理用哪个模型");
  expect(p.pane()).toMatch(/名称 +来源 +模型 +思考/u);
  expect(p.pane()).toMatch(/PM +内置 +跟随主会话 +跟随/u);
  expect(p.pane()).toMatch(/解释器 +内置/u);
  expect(p.pane()).toMatch(/草稿核验器 +内置/u);
  expect(navCells(p.rows())).toContain("▸ 模型 3");
  p.press(UP);
  expect(paneParts(p.rows())[0]!.trim()).toBe("prototype  需求涉及界面时出 HTML 原型");
});

test("目录里 ↑ 到顶不越界，↓ 跳过标题和空行直达问题，到底不越界", async () => {
  const p = await page();
  p.press(UP, UP);
  expect(navCells(p.rows())).toContain("▸ worker 8");
  p.press(...Array<string>(20).fill(DOWN));
  expect(navCells(p.rows())).toContain("▸ 问题 1");
  expect(paneParts(p.rows())[0]!.trim()).toBe("问题  这些文件写错了，没有生效");
});

test("→ 和回车都能进右栏，← 回目录，按键提示随焦点变化", async () => {
  const p = await page();
  p.press(...Array<string>(5).fill(DOWN), RIGHT);
  expect(p.text()).toContain("←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层");
  expect(selectedPaneLine(p)).toMatch(/^\s*▸ PM/u);
  p.press(LEFT);
  expect(p.text()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
  p.press(ENTER);
  expect(p.text()).toContain("←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层");
});

test("目录里按 Esc 调 onClose", async () => {
  const nav = await page();
  nav.press(ESC);
  expect(nav.closed()).toBe(true);
});

test("右栏列表里 Esc 与 ← 一样：焦点回目录，目录光标停在原分类，页面不关闭；再按 Esc 才关闭", async () => {
  const p = await page();
  p.press(DOWN, DOWN, DOWN, DOWN, DOWN, RIGHT, ESC);
  expect(p.closed()).toBe(false);
  expect(navCells(p.rows())).toContain("▸ 模型 3");
  expect(p.lines().find((line) => /模型 +3/u.test(plain(line)) && plain(line).includes("│"))!.split("│")[0]).toContain("[selectedBg]");
  expect(p.text()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
  p.press(ESC);
  expect(p.closed()).toBe(true);
});

test("Esc 与 ← 回目录后的整屏完全相同", async () => {
  const byEsc = await page(), byLeft = await page();
  byEsc.press(RIGHT, DOWN, ENTER, ESC);
  byLeft.press(RIGHT, DOWN, ENTER, LEFT);
  expect(byEsc.rows()).toEqual(byLeft.rows());
  expect(byEsc.view.state()).toEqual(byLeft.view.state());
});

test("worker 展开详情后 Esc 回目录，详情收起，再 → 进右栏光标是 ▸ 不是 ▾", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "ui-worker");
  p.press(ENTER);
  expect(selectedPaneLine(p)).toMatch(/^\s*▾ ui-worker/u);
  p.press(ESC);
  expect(p.pane()).not.toContain("┊");
  p.press(RIGHT);
  expect(selectedPaneLine(p)).toMatch(/^\s*▸ worker/u);
  expect(p.pane()).not.toContain("┊");
  expect(p.closed()).toBe(false);
});

test("模型分步修改：第一步 Esc 取消并提示已取消修改，焦点留在右栏、页面不关闭、不保存；再 Esc 回目录，仍不关闭", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER, ENTER, ESC, ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.text()).toContain(MODEL_HINT);
  expect(p.closed()).toBe(false);
  expect(p.saves).toEqual([]);
  p.press(ESC);
  expect(p.text()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
  expect(p.closed()).toBe(false);
});

test("开关分步修改：Esc 取消后焦点留在右栏，页面不关闭", async () => {
  const p = await page();
  toSwitches(p);
  p.press(ENTER, ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.text()).toContain(MODEL_HINT);
  expect(p.closed()).toBe(false);
  expect(p.switchSaves).toEqual([]);
});

test("复制起名里 Esc 取消并提示已取消复制，焦点留在右栏，页面不关闭，不复制", async () => {
  const p = await page();
  p.press(RIGHT, "c", ESC);
  expect(p.text()).toContain("已取消复制");
  expect(p.text()).toContain(AGENT_HINT);
  expect(p.closed()).toBe(false);
  expect(p.copies).toEqual([]);
});

test("窄屏 44 列：右栏 Esc 回目录且只画目录，再 Esc 调 onClose", async () => {
  const p = await page();
  p.press(...inPane(5));
  expect(p.text(44)).toContain("←/Esc 回目录");
  p.press(ESC);
  expect(p.closed()).toBe(false);
  const rows = p.rows(44);
  expect(rows.some((row) => row.includes("│"))).toBe(false);
  expect(p.text(44)).not.toMatch(/名称 +来源/u);
  expect(p.text(44)).toContain("↑↓ 选分类  → 进入  Esc 退出");
  p.press(ESC);
  expect(p.closed()).toBe(true);
});

test("右栏的按键提示都不含“Esc 退出”", async () => {
  for (const section of SECTIONS) {
    const p = await page();
    enterSection(p, section);
    expect(p.text(), section).not.toContain("Esc 退出");
    expect(p.text(), section).toContain("←/Esc 回左栏");
  }
});

test("八个分类的右栏第一行是分类名加两空格加说明", async () => {
  const expected = ["worker  写代码", "reviewer  代码审查：实现是否合理", "qa  功能验收：行为是否符合目标", "explore  只读查资料", "prototype  需求涉及界面时出 HTML 原型",
    "模型  PM 和两个内部代理用哪个模型", "开关  Git 交付怎么交、用哪些合并方式", "问题  这些文件写错了，没有生效"];
  for (const [index, line] of expected.entries()) {
    const p = await page();
    p.press(...Array<string>(index).fill(DOWN));
    const first = paneParts(p.rows())[0]!;
    expect(first.trim(), SECTIONS[index]).toBe(line);
    expect(p.lines().find((raw) => plain(raw).includes(line.split("  ")[0]!) && plain(raw).includes("│"))).toMatch(/<accent>/u);
  }
});

test("焦点在目录时底部写分类说明；职责分类写定义份数和各层份数", async () => {
  const expected = ["worker：写代码 · 8 份定义（用户 1 · 内置 7）", "reviewer：代码审查：实现是否合理 · 7 份定义（项目 1 · 内置 6）", "qa：功能验收：行为是否符合目标 · 1 份定义（内置 1）",
    "explore：只读查资料 · 1 份定义（内置 1）", "prototype：需求涉及界面时出 HTML 原型 · 1 份定义（内置 1）", "模型：PM 和两个内部代理用哪个模型", "开关：Git 交付怎么交、用哪些合并方式", "问题：这些文件写错了，没有生效"];
  for (const [index, line] of expected.entries()) {
    const p = await page();
    p.press(...Array<string>(index).fill(DOWN));
    expect(p.text(), SECTIONS[index]).toContain(line);
  }
});

test("同一职责下通用定义在分隔线上，用户层与项目层排在内置前面，被盖住的下层不再列出，底部说明随选中行变化", async () => {
  const p = await page();
  p.press(RIGHT);
  expect(paneOrder(p, ["worker", SEPARATOR, "ui-worker", "go-worker", "java-worker", "node-worker", "python-worker", "react-worker", "vue-worker"]))
    .toEqual(["worker", SEPARATOR, "ui-worker", "go-worker", "java-worker", "node-worker", "python-worker", "react-worker", "vue-worker"]);
  moveTo(p, "ui-worker");
  expect(p.pane()).toMatch(/^ +worker +内置 +必须 +跟随主会话 +跟随 *$/mu);
  expect(p.pane()).toMatch(/▸ ui-worker +用户 +开启 +5x\/gpt-6-luna +medium/u);
  expect(p.lines().join("\n")).toContain("<accent>5x/gpt-6-luna</>");
  expect(p.text()).toContain("界面设计与实现，产出 HTML 预览 · skills ui-basics");
  moveTo(p, "worker");
  expect(selectedPaneLine(p)).toMatch(/▸ worker +内置/u);
  p.press(LEFT, DOWN, RIGHT);
  expect(p.pane()).toMatch(/▸ reviewer +项目 +必须 +5x\/gpt-6-sol +high/u);
  expect(p.pane().match(/^\s*[▸▾]?\s*reviewer +(内置|项目)/gmu)).toHaveLength(1);
});

test("没写模型和思考的定义，模型列写“跟随主会话”、思考列写“跟随”，不写“继承”", async () => {
  const p = await page();
  p.press(DOWN, DOWN, RIGHT);
  expect(p.pane()).toMatch(/▸ qa +内置 +必须 +跟随主会话 +跟随 *(\n|$)/u);
  p.press(LEFT, DOWN, RIGHT);
  expect(p.pane()).toMatch(/▸ explore +内置 +必须 +跟随主会话 +跟随 *(\n|$)/u);
  expect(p.text()).not.toContain("继承");
  expect(p.lines().join("\n")).toContain("<dim>跟随主会话</>");
});

test("prototype 分类内置行跟随主会话，底部写说明，复制出的定义归在这一类", async () => {
  const p = await page();
  enterSection(p, "prototype");
  expect(p.pane()).toMatch(/▸ prototype +内置 +必须 +跟随主会话 +跟随 *(\n|$)/u);
  expect(p.text()).toContain("只能由主窗口派出，在澄清阶段出界面原型（单个 HTML）。");
  const d = await roleDirsOnly();
  const catalog = await loadRoleCatalog({ ...d.dirs, parseFrontmatter, projectTrusted: true });
  const proto = catalog.roles.find((entry) => entry.name === "prototype")!;
  await copyAgentDefinition({ entry: proto, newName: "proto-copy", targetDir: d.dirs.userDir, layerDirs: [d.dirs.defaultDir, d.dirs.userDir, d.dirs.projectDir] });
  const reloaded = await loadRoleCatalog({ ...d.dirs, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "proto-copy")).toMatchObject({ source: "user", available: true, definition: { role: "prototype" } });
});

async function roleDirsOnly() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-")); roots.push(root);
  return { root, dirs: { defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p") } };
}

test("职责回车展开出说明、skills、MCP、正文、文件五行详情，光标变 ▾，再回车收起", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "ui-worker");
  p.press(ENTER);
  expect(selectedPaneLine(p)).toMatch(/^\s*▾ ui-worker/u);
  const detail = p.pane().split("\n").filter((line) => line.includes("┊"));
  const at = ["说明", "skills", "MCP", "正文", "文件"].map((label) => detail.findIndex((line) => line.includes(label)));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(p.text()).toContain(AGENT_HINT_OPEN);
  p.press(ENTER);
  expect(selectedPaneLine(p)).toMatch(/^\s*▸ ui-worker/u);
  expect(p.pane()).not.toContain("┊");
});

test("展开详情里用顿号隔开的列表值放不下时在顿号之后断开，名字不被拆开", async () => {
  const skills = ["ui-basics", "very-long-skill-name-number-one", "another-skill"];
  for (const width of [36, 40, 48, 64]) {
    const p = await page({ skills: skills.join(", ") });
    p.press(RIGHT);
    moveTo(p, "ui-worker");
    p.press(ENTER);
    const detail = p.rows(width).filter((line) => line.includes("┊")).map((line) => line.replace(/^.*┊/u, "").trim());
    expect(detail.some((row) => row.includes("ui-basics")), `${width} ui-basics: ${detail.join("|")}`).toBe(true);
    expect(detail.some((row) => row.includes("another-skill")), `${width} another-skill: ${detail.join("|")}`).toBe(true);
  }
});

test("复制：C 进入命名画面，格式不对或重名当场拦下，合规名触发 onCopy", async () => {
  const p = await page({ taken: { "ui-worker": "用户层" } });
  p.press(RIGHT);
  moveTo(p, "worker");
  p.press("c");
  const naming = p.pane();
  expect(paneParts(p.rows())[0]!.trim()).toBe("复制 worker 为新定义");
  expect(naming).toMatch(/ 新名称 +worker-copy█/u);
  expect(squeeze(naming)).toContain(squeeze("小写字母、数字、连字符，最多 64 个字符；三层里不能重名"));
  expect(p.text()).toContain("回车 下一步  Esc 取消");
  for (let i = 0; i < 11; i++) p.press(BACKSPACE);
  p.press(..."ui-worker".split(""), ENTER);
  expect(squeeze(p.pane())).toContain(squeeze("✗ 用户层已经有 ui-worker，换一个名字"));
  expect(p.lines().join("\n")).toMatch(/<error>[^\n]*用户层已经有/u);
  for (let i = 0; i < 9; i++) p.press(BACKSPACE);
  p.press("U", "I", ENTER);
  expect(squeeze(p.pane())).toContain(squeeze("✗ 只能用小写字母、数字和连字符，例如 ui-worker"));
  p.press(BACKSPACE, BACKSPACE, ..."api-worker".split(""), ENTER);
  expect(p.copies).toEqual([{ name: "api-worker", entry: "worker" }]);
});

test("复制命名里 Esc 回到列表并提示已取消复制，下一次按键后提示消失", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "ui-worker");
  p.press("c", ESC);
  expect(p.text()).toContain("已取消复制");
  expect(p.pane()).toMatch(/▸ ui-worker/u);
  expect(p.copies).toEqual([]);
  p.press(DOWN);
  expect(p.text()).not.toContain("已取消复制");
});

test("复制完成后回到原分类，新定义被选中且名字绿色，底部显示成功提示，再按键后提示消失", async () => {
  const text = "✓ 已复制到 ~/.pi/agent/agents/ui-worker.md，打开它写专长、skills 和 mcp";
  const p = await page({ state: { section: "worker", focus: "pane", selectName: "ui-worker", fresh: "ui-worker", notice: { tone: "ok", text } } });
  expect(selectedPaneLine(p)).toMatch(/▸ ui-worker +用户/u);
  expect(p.lines().join("\n")).toMatch(/<success>ui-worker/u);
  expect(p.lines().join("\n")).toContain(`<success>${text}</>`);
  p.press(DOWN);
  expect(p.text()).not.toContain("已复制到");
});

test("C 只在职责分类有效，R 在职责分类无效", async () => {
  const p = await page();
  toModels(p);
  p.press("c");
  expect(p.pane()).not.toContain("复制");
  const q = await page();
  q.press(RIGHT, "r");
  expect(q.clears).toEqual([]);
  expect(q.text()).not.toContain("内置默认值");
});

test("问题分类写短原因，展开依次写原因、现在是、影响，底部写没有生效；未受信任那条灰色", async () => {
  const p = await page();
  enterSection(p, "problems");
  expect(p.pane()).toMatch(/文件 +层 +原因/u);
  moveToRowWith(p, "broken.md");
  expect(selectedPaneLine(p)).toMatch(/broken\.md +用户 +thinking 写错了/u);
  expect(p.lines().join("\n")).toContain("<error>thinking 写错了");
  expect(squeeze(p.text())).toContain(squeeze("这份定义没有生效 · 改正文件后重新打开本页"));
  expect(p.text()).toContain("←/Esc 回左栏  ↑↓ 选择  回车 详情");
  p.press(ENTER);
  expect(squeeze(p.pane().replaceAll("┊", ""))).toContain(squeeze("原因 thinking 只能是 off、minimal、low、medium、high、xhigh、max"));
  expect(p.pane()).toMatch(/┊ 现在是 +extreme/u);
  expect(p.pane()).toMatch(/┊ 影响 +这份定义没有生效/u);
  for (const row of p.rows(80)) expect(visibleWidth(row), row).toBeLessThanOrEqual(80);
  expect(p.text()).toContain("←/Esc 回左栏  ↑↓ 选择  回车 收起");
  const u = await page({ trust: "denied" });
  enterSection(u, "problems");
  moveToRowWith(u, ".pi/agents/");
  expect(selectedPaneLine(u)).toMatch(/\.pi\/agents\/ +项目/u);
  expect(u.lines().join("\n")).toMatch(/<muted>项目未受信任，/u);
  u.press(ENTER);
  expect(squeeze(u.text())).toContain(squeeze("在 pi 里把这个项目设为受信任后，项目层的 1 份定义就会生效"));
});

test("授信记录为空时问题分类第一条灰字写项目还没设为受信任", async () => {
  const u = await page({ trust: "unset" });
  enterSection(u, "problems");
  moveToRowWith(u, ".pi/agents/");
  expect(selectedPaneLine(u)).toMatch(/\.pi\/agents\/ +项目/u);
  expect(u.lines().join("\n")).toMatch(/<muted>项目还没设为受信任，/u);
  expect(u.text()).not.toContain("项目未受信任");
  u.press(ENTER);
  expect(squeeze(u.pane().replaceAll("┊", ""))).toContain(squeeze("原因 项目还没设为受信任，项目层的定义和设定不会加载"));
});

test("设置文件里 git-delivery 写成 yes：展开依次是原因、现在是 \"yes\"、影响“这一项没有生效，改用下一层”、文件", async () => {
  const p = await page({ project: oneCompany({ "git-delivery": "yes" }) });
  enterSection(p, "problems");
  moveToRowWith(p, "settings.json");
  p.press(ENTER);
  expect(squeeze(p.pane())).toMatch(/┊原因.*git-delivery.*┊现在是"yes".*┊影响这一项没有生效，改用下一层.*┊文件.*settings\.json/u);
});

test("设置文件里角色那一项思考等级写错：影响是这一项没有生效，改用下一层", async () => {
  const p = await page({ project: oneCompany({ pm: { model: "gpt-6-luna", thinking: "super" } }) });
  enterSection(p, "problems");
  moveToRowWith(p, "settings.json");
  expect(selectedPaneLine(p)).toContain("项目");
  expect(selectedPaneLine(p)).toContain("super");
  p.press(ENTER);
  expect(p.pane()).toMatch(/┊ 影响 +这一项没有生效，改用下一层/u);
});

test("设置文件里不认识的键：影响是这一项没有生效，改用下一层", async () => {
  const p = await page({ project: oneCompany({ "git-deliver": true }) });
  enterSection(p, "problems");
  moveToRowWith(p, "settings.json");
  p.press(ENTER);
  expect(p.pane()).toMatch(/┊ 影响 +这一项没有生效，改用下一层/u);
});

test("设置文件不是 JSON、one-company 不是对象：影响是这一层的设定都没有生效，改用下一层，没有“现在是”", async () => {
  for (const project of ["{ not json", { "one-company": 3 }]) {
    const p = await page({ project });
    enterSection(p, "problems");
    moveToRowWith(p, "settings.json");
    expect(selectedPaneLine(p)).toMatch(/项目/u);
    p.press(ENTER);
    expect(p.pane()).toMatch(/┊ 影响 +这一层的设定都没有生效，改用下一层/u);
    expect(p.pane()).not.toContain("现在是");
  }
});

test("用户层坏文件在问题分类的层标签是“用户”，agent 目录名叫 .pi 时也一样", async () => {
  const p = await page({ user: "{ not json" });
  enterSection(p, "problems");
  expect(p.pane()).toMatch(/用户 +文件不是合法的 JSON/u);
  expect(p.pane()).not.toMatch(/项目 +文件不是合法的 JSON/u);
});

test("旧的 pm、解释器、草稿核验器定义列在问题里，选中时底部写模型和思考等级改在「模型」里", async () => {
  const p = await page({ legacy: true });
  enterSection(p, "problems");
  for (const file of ["pm.md", "interpreter.md", "draft-verifier.md"]) {
    moveToRowWith(p, file);
    expect(squeeze(p.text(200))).toContain(squeeze("这份定义没有生效，模型和思考等级改在「模型」里"));
  }
});

test("模型分类没有设定时三行都是内置来源、模型跟随主会话、思考跟随", async () => {
  const p = await page();
  toModels(p);
  expect(p.pane()).toMatch(/名称 +来源 +模型 +思考/u);
  expect(p.pane()).toMatch(/▸ PM +内置 +跟随主会话 +跟随 *\n/u);
  expect(p.pane()).toMatch(/解释器 +内置 +跟随主会话 +跟随 *\n/u);
  expect(p.pane()).toMatch(/草稿核验器 +内置 +跟随主会话 +跟随 *(\n|$)/u);
  expect(p.pane()).not.toContain("不思考");
});

test("思考为 null 写“跟随”，解释器的 off 写“不思考”，PM 的 off 照写 off，模型为 null 写“跟随主会话”", async () => {
  const p = await page({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: null }, interpreter: { model: null, thinking: "off" }, "draft-verifier": { model: null, thinking: null } }) });
  toModels(p);
  expect(p.pane()).toMatch(/PM +用户 +gpt-6-luna +跟随 *\n/u);
  expect(p.pane()).toMatch(/解释器 +用户 +跟随主会话 +不思考/u);
  expect(p.pane()).toMatch(/草稿核验器 +用户 +跟随主会话 +跟随 *(\n|$)/u);
  const q = await page({ user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "off" } }) });
  toModels(q);
  expect(q.pane()).toMatch(/PM +用户 +gpt-6\.1-sol +off *\n/u);
});

test("模型为 null 时即使本机没有任何有凭据的模型，也不写“不可用”，底部不报错", async () => {
  const p = await page({ models: [], mainModel: undefined });
  toModels(p);
  expect(p.text()).not.toContain("不可用");
  expect(p.text()).not.toContain("✗");
});

test("模型行底部写用途、来源说明和生效时机，随选中行变化", async () => {
  const p = await page({ user: oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "low" } }), project: oneCompany({ "draft-verifier": { model: "gpt-6-luna", thinking: "high" } }) });
  toModels(p);
  expect(p.text()).toContain("PM：活动需求的负责人，拆任务、派工、调度 · 内置默认值 · 下次启动 PM 时生效");
  p.press(DOWN);
  expect(p.text()).toContain("解释器：把用户原话解读成结构化决定 · 来自用户层 · 下次调用时生效");
  p.press(DOWN);
  expect(p.text()).toContain("草稿核验器：核对需求草稿是不是用户原话要求的 · 来自项目层 · 下次调用时生效");
});

test("设定的模型没有凭据时模型列红字写“不可用”，选中时底部红字写明后果", async () => {
  const p = await page({
    user: oneCompany({ interpreter: { model: "claude-opus-5-5", thinking: "medium" }, "draft-verifier": { model: "claude-opus-5-5", thinking: "medium" } }),
    project: oneCompany({ pm: { model: "claude-opus-5-5", thinking: "high" } }),
  });
  toModels(p);
  expect(p.pane()).toMatch(/PM +项目 +claude-opus-5-5 ?不可用/u);
  expect(p.lines().join("\n")).toMatch(/<error>claude-opus-5-5 ?不可用/u);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，启动 PM 会失败；回车重新选");
  expect(p.lines().join("\n")).toMatch(/<error>✗ claude-opus-5-5/u);
  p.press(DOWN);
  expect(p.pane()).toMatch(/解释器 +用户 +claude-opus-5-5 ?不可用/u);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，批准需求时解读会失败；回车重新选");
  p.press(DOWN);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，起草或修改需求草稿时核验会失败；回车重新选");
});

test("模型有凭据的行不写“不可用”", async () => {
  const p = await page();
  toModels(p);
  expect(p.text()).not.toContain("不可用");
});

test("设定里的裸模型名在本机有多个提供方时这一行不可用，底部写“多个提供方”而不是没有凭据", async () => {
  const p = await page({ models: [OPENAI_SOL, SOL, LUNA], mainModel: { provider: "anthropic", id: "claude-x", reasoning: true, thinkingLevelMap: {} },
    user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "high" } }) });
  toModels(p);
  expect(p.pane()).toMatch(/PM +用户 +gpt-6\.1-sol ?不可用/u);
  const rows = p.rows(60);
  for (const row of rows) expect(visibleWidth(row), row).toBeLessThanOrEqual(60);
  const start = rows.findIndex((line) => line.trimStart().startsWith("✗ "));
  expect(start).toBeGreaterThan(-1);
  const end = rows.findIndex((line, index) => index > start && line.includes("←"));
  const footer = rows.slice(start, end).map((line) => line.trimStart()).join("");
  expect(footer).toContain("多个提供方");
  expect(footer).toContain("启动 PM 会失败");
  expect(footer).not.toContain("没有可用的凭据");
});

test("设定里的模型不在可选模型里时，底部仍写没有可用的凭据和后果", async () => {
  const p = await page({ models: [OPENAI_SOL, SOL, LUNA], user: oneCompany({ pm: { model: "claude-opus-5-5", thinking: "high" } }) });
  toModels(p);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，启动 PM 会失败；回车重新选");
});

test("修改模型第 1 步：列出有凭据的模型和提供方，末项跟随主会话写明现在是什么，当前生效项打勾", async () => {
  const p = await page({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: "high" } }) });
  toModels(p);
  p.press(ENTER);
  const text = p.pane();
  expect(text).toMatch(/修改 PM 的模型 +第 1 步，共 3 步/u);
  expect(text).toMatch(/gpt-6\.1-sol +5x/u);
  expect(text).toMatch(/✓ +gpt-6-luna +5x/u);
  expect(text).not.toMatch(/✓ +gpt-6\.1-sol/u);
  expect(text).toMatch(/跟随主会话 +现在是 5x\/gpt-6\.1-sol/u);
  expect(text).toContain("只列出本机配了凭据的模型");
  expect(selectedPaneLine(p)).toMatch(/^\s*▸ /u);
  expect(p.text()).toContain("↑↓ 选择  回车 下一步  Esc 取消");
});

test("没有可选模型时第 1 步只有跟随主会话，并提示先在 pi 里登录；选它后保存的 model 为 null", async () => {
  const p = await page({ models: [] });
  toModels(p);
  p.press(ENTER);
  const text = p.pane();
  expect(text).toMatch(/修改 PM 的模型 +第 1 步，共 3 步/u);
  expect(text).toMatch(/跟随主会话 +现在是 5x\/gpt-6\.1-sol/u);
  expect(text).not.toMatch(/gpt-6-luna|gpt-6\.1-sol +5x/u);
  expect(text).toContain("本机还没有其他配了凭据的模型，先在 pi 里登录模型服务");
  expect(p.text()).toContain("回车 下一步  Esc 取消");
  p.press(ENTER);
  moveTo(p, "high");
  p.press(ENTER);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: null, thinking: "high", layer: "project" }]);
});

test("第 2 步：所选模型不支持的等级变灰并写原因，光标跳过灰项；当前值打勾；跟随主会话总是可选", async () => {
  const p = await page({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: "high" } }) });
  toModels(p);
  p.press(ENTER);
  moveTo(p, "gpt-6-luna");
  p.press(ENTER);
  const text = p.pane();
  expect(text).toMatch(/修改 PM 的思考等级 +第 2 步，共 3 步/u);
  for (const level of ["off", "low", "medium", "high", "xhigh"]) expect(text, level).toMatch(new RegExp(`${level} *(\\n|$)`, "u"));
  expect(text).toMatch(new RegExp(`minimal +${GRAY_NOTE.source}`, "u"));
  expect(text).toMatch(new RegExp(`max +${GRAY_NOTE.source}`, "u"));
  expect(text).toMatch(/✓ +high/u);
  expect(p.text()).toContain("↑↓ 选择  回车 下一步  Esc 上一步");
  const visited = new Set<string>();
  for (const key of [...Array<string>(8).fill(DOWN), ...Array<string>(8).fill(UP)]) { p.press(key); visited.add(firstWord(selectedPaneLine(p))!); }
  expect([...visited].sort()).toEqual(expect.arrayContaining(["off", "xhigh", "跟随主会话"]));
  expect(visited.has("minimal")).toBe(false);
  expect(visited.has("max")).toBe(false);
});

test("第 2 步在 max 后面多一项“跟随主会话”，后面写主窗口当前思考等级", async () => {
  const p = await page({ mainThinking: "high" });
  toModels(p);
  p.press(ENTER, ENTER);
  const lines = p.pane().split("\n");
  const max = lines.findIndex((line) => /\bmax\b/u.test(line)), follow = lines.findIndex((line, index) => index > max && line.includes("跟随主会话"));
  expect(max).toBeGreaterThan(0);
  expect(follow).toBe(max + 1);
  expect(lines[follow]).toMatch(/跟随主会话 +现在是 high *$/u);
});

test("主窗口思考等级是 off 时：PM 写“现在是 off”，解释器和草稿核验器写“现在是 不思考”", async () => {
  const p = await page({ mainThinking: "off" });
  toModels(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/跟随主会话 +现在是 off *\n/u);
  const q = await page({ mainThinking: "off" });
  toModels(q);
  q.press(DOWN, ENTER, ENTER);
  expect(q.pane()).toMatch(/跟随主会话 +现在是 不思考 *\n/u);
  const r = await page({ mainThinking: "off" });
  toModels(r);
  r.press(DOWN, DOWN, ENTER, ENTER);
  expect(r.pane()).toMatch(/跟随主会话 +现在是 不思考 *\n/u);
});

test("第 2 步当前生效的思考是跟随时，✓ 打在“跟随主会话”上，别的等级没有 ✓", async () => {
  const p = await page({ user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: null } }) });
  toModels(p);
  p.press(ENTER, ENTER);
  const checked = p.pane().split("\n").filter((line) => line.includes("✓"));
  expect(checked).toHaveLength(1);
  expect(checked[0]).toMatch(/✓ +跟随主会话/u);
});

test("没有设定时第 2 步光标默认停在“跟随主会话”，直接回车再选项目层，保存请求的 thinking 为 null", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER, ENTER);
  expect(selectedPaneLine(p)).toMatch(/跟随主会话/u);
  p.press(ENTER);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: null, thinking: null, layer: "project" }]);
});

test("选了不支持部分等级的模型后，“跟随主会话”仍可选，保存请求的 thinking 为 null", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER);
  moveTo(p, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p, "跟随主会话");
  p.press(ENTER);
  moveTo(p, "用户层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: null, layer: "user" }]);
});

test("主窗口思考是 max、选了不支持 max 的模型时，“跟随主会话”仍可选、备注现在是 max，保存的 thinking 为 null", async () => {
  const p = await page({ mainThinking: "max" });
  toModels(p);
  p.press(ENTER);
  moveTo(p, "gpt-6-luna");
  p.press(ENTER);
  expect(p.pane()).toMatch(/max +gpt-6-luna 不支持/u);
  moveTo(p, "跟随主会话");
  expect(selectedPaneLine(p)).toMatch(/跟随主会话 +现在是 max/u);
  p.press(ENTER);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: null, layer: "project" }]);
});

test("第 2 步选的是跟随主会话时，按主窗口当前模型判断支持的等级", async () => {
  const p = await page({ mainModel: LUNA });
  toModels(p);
  p.press(ENTER);
  moveTo(p, "跟随主会话");
  p.press(ENTER);
  expect(p.pane()).toMatch(/minimal +(5x\/)?gpt-6-luna 不支持/u);
  expect(p.pane()).toMatch(/max +(5x\/)?gpt-6-luna 不支持/u);
});

test("第 3 步标题里模型和思考都是跟随时写“跟随主会话 · 跟随”", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER, ENTER, ENTER);
  expect(p.pane()).toMatch(/PM 改为 跟随主会话 · 跟随，存到哪一层 +第 3 步，共 3 步/u);
});

test("第 3 步：项目层和用户层各写文件位置与适用范围，标题写明改成什么", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER);
  moveTo(p, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p, "xhigh");
  p.press(ENTER);
  const text = p.pane();
  expect(text).toMatch(/PM 改为 gpt-6-luna · xhigh，存到哪一层 +第 3 步，共 3 步/u);
  expect(text).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(text).toMatch(/用户层 +~\/\.pi\/agent\/settings\.json · 所有项目/u);
  expect(p.text()).toContain("↑↓ 选择  回车 保存  Esc 上一步");
});

test("选 gpt-6-luna、xhigh、项目层后，onSaveSetting 收到完整的保存请求", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER);
  moveTo(p, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p, "xhigh");
  p.press(ENTER);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: "xhigh", layer: "project" }]);
});

test("选用户层时保存请求的 layer 是 user，改的是选中的那一行角色", async () => {
  const p = await page();
  toModels(p);
  p.press(DOWN, ENTER);
  moveTo(p, "gpt-6.1-sol");
  p.press(ENTER);
  moveTo(p, "low");
  p.press(ENTER);
  moveTo(p, "用户层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "interpreter", model: "gpt-6.1-sol", thinking: "low", layer: "user" }]);
});

test("两家提供方都有 gpt-6.1-sol 时，选 openai 那一行保存的 model 是 openai/gpt-6.1-sol；唯一的 gpt-6-luna 不带提供方", async () => {
  const models = [OPENAI_SOL, SOL, LUNA];
  const p = await page({ models });
  toModels(p);
  p.press(ENTER);
  moveToRowWith(p, "openai");
  p.press(ENTER);
  moveTo(p, "high");
  p.press(ENTER);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "openai/gpt-6.1-sol", thinking: "high", layer: "project" }]);
  const q = await page({ models });
  toModels(q);
  q.press(ENTER);
  moveTo(q, "gpt-6-luna");
  q.press(ENTER);
  moveTo(q, "high");
  q.press(ENTER);
  moveTo(q, "项目层");
  q.press(ENTER);
  expect(q.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: "high", layer: "project" }]);
});

const DENIED_NOTE = "你在 pi 里选过不信任这个项目。要存到项目层，先在 pi 里输入 /trust 选 Trust，再重开本页";
const UNSET_NOTE = "选项目层会把这个项目设为受信任，和在 pi 里输入 /trust 选 Trust 一样；项目里已有的 .pi 设置和角色定义也会一起生效";

test("授信记录为不信任时第 3 步项目层不可选并写你选过不信任，光标停在用户层，回车存到用户层", async () => {
  const p = await page({ trust: "denied" });
  toModels(p);
  p.press(ENTER, ENTER, ENTER);
  const text = p.pane();
  expect(text).toMatch(/项目层 +你在 pi 里选过不信任这个项目/u);
  expect(squeeze(text)).toContain(squeeze(DENIED_NOTE));
  expect(selectedPaneLine(p)).toMatch(/用户层/u);
  p.press(UP);
  expect(selectedPaneLine(p)).toMatch(/用户层/u);
  p.press(ENTER);
  expect(p.saves).toMatchObject([{ role: "pm", layer: "user" }]);
});

test("授信记录为空时第 3 步项目层可选并写选它会设为受信任，光标默认在项目层，下面灰字说明，回车保存到项目层", async () => {
  const p = await page({ trust: "unset" });
  toModels(p);
  p.press(ENTER, ENTER, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 选它会把本项目设为受信任/u);
  expect(squeeze(p.pane())).toContain(squeeze(UNSET_NOTE));
  expect(p.lines().join("\n")).toMatch(/<(dim|muted)>[^\n]*选项目层会把这个项目设为受信任/u);
  expect(selectedPaneLine(p)).toMatch(/项目层/u);
  p.press(DOWN);
  expect(selectedPaneLine(p)).toMatch(/用户层/u);
  p.press(UP, ENTER);
  expect(p.saves).toMatchObject([{ role: "pm", layer: "project" }]);
});

test("授信记录是信任时第 3 步项目层写只对这个项目生效，没有灰字", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER, ENTER, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(p.pane()).not.toContain("选它会把本项目设为受信任");
  expect(squeeze(p.pane())).not.toContain(squeeze("选项目层会把这个项目设为受信任"));
  expect(squeeze(p.pane())).not.toContain(squeeze("你在 pi 里选过不信任"));
});

test("Esc 逐步退回上一步，第一步 Esc 取消，什么也不保存，底部写已取消修改，页面不关闭", async () => {
  const p = await page();
  toModels(p);
  p.press(ENTER, ENTER, ENTER);
  expect(p.pane()).toMatch(/第 3 步，共 3 步/u);
  p.press(ESC);
  expect(p.pane()).toMatch(/第 2 步，共 3 步/u);
  p.press(ESC);
  expect(p.pane()).toMatch(/第 1 步，共 3 步/u);
  p.press(ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.text()).toContain("R 清除本层");
  expect(p.saves).toEqual([]);
  expect(p.closed()).toBe(false);
});

test("模型来源是内置时按 R 只提示已经是内置默认值，不发清除请求", async () => {
  const p = await page();
  toModels(p);
  p.press("R");
  expect(p.rows().map((line) => line.trim())).toContain("已经是内置默认值");
  expect(p.clears).toEqual([]);
});

test("模型来源是项目或用户时按 R，onClearSetting 收到带层的清除请求", async () => {
  const p = await page({ project: oneCompany({ pm: { model: "gpt-6-luna", thinking: "low" } }) });
  toModels(p);
  p.press("r");
  expect(p.clears).toEqual([{ role: "pm", layer: "project" }]);
  const q = await page({ user: oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "low" } }) });
  toModels(q);
  q.press(DOWN, "R");
  expect(q.clears).toEqual([{ role: "interpreter", layer: "user" }]);
});

test("开关分类有 Git 交付和合并方式两行，没有设定时来源内置：Git 交付按探测结果，合并方式三种都勾", async () => {
  const p = await page();
  toSwitches(p);
  expect(p.pane()).toMatch(/名称 +来源 +状态/u);
  expect(p.pane()).toMatch(/▸ Git 交付 +内置 +仅本地/u);
  expect(p.pane()).toMatch(/ 合并方式 +内置 +压缩 · 普通合并 · rebase/u);
  const q = await page({ origin: "git@github.com:acme/shop.git", ghHosts: ["github.com"] });
  toSwitches(q);
  expect(q.pane()).toMatch(/▸ Git 交付 +内置 +远程/u);
});

test("开关分类的第一行写分类说明", async () => {
  const p = await page();
  toSwitches(p);
  expect(paneParts(p.rows())[0]!.trim()).toBe("开关  Git 交付怎么交、用哪些合并方式");
});

test("开关分类按设定所在的层显示来源和状态：用户层远程、项目层仅本地", async () => {
  const u = await page({ user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(u);
  expect(u.pane()).toMatch(/▸ Git 交付 +用户 +远程/u);
  const q = await page({ project: oneCompany({ "git-delivery": "local" }), user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(q);
  expect(q.pane()).toMatch(/▸ Git 交付 +项目 +仅本地/u);
});

test("合并方式一行按压缩合并、普通合并、rebase 合并的顺序列出勾了的，用 · 隔开", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["squash", "merge", "rebase"], /合并方式 +用户 +压缩 · 普通合并 · rebase\s*$/mu],
    [["rebase", "squash"], /合并方式 +用户 +压缩合并 · rebase 合并\s*$/mu],
    [["merge"], /合并方式 +用户 +普通合并\s*$/mu],
    [["rebase"], /合并方式 +用户 +rebase 合并\s*$/mu],
  ];
  for (const [methods, expected] of cases) {
    const p = await page({ user: oneCompany({ "merge-methods": methods }) });
    toSwitches(p);
    expect(p.pane(), methods.join()).toMatch(expected);
  }
});

test("Git 交付底部写两档含义、来源说明和立即生效：用户层、项目层", async () => {
  const u = await page({ user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(u);
  expect(squeeze(u.text())).toContain(squeeze(`${MODE_FOOT} · 来自用户层 · 立即生效`));
  const q = await page({ project: oneCompany({ "git-delivery": "local" }) });
  toSwitches(q);
  expect(squeeze(q.text())).toContain(squeeze(`${MODE_FOOT} · 来自项目层 · 立即生效`));
});

test("Git 交付没设定时底部写内置依据：origin 主机 gh 登录过 → 远程", async () => {
  const p = await page({ origin: "git@github.com:acme/shop.git", ghHosts: ["github.com"] });
  toSwitches(p);
  expect(squeeze(p.text())).toContain(squeeze(`${MODE_FOOT} · 内置默认值：origin 在 github.com，gh 已登录 → 远程 · 立即生效`));
});

test("Git 交付没设定时底部写内置依据：只有 glab 登录过 → 远程", async () => {
  const p = await page({ origin: "https://code.example.com/acme/shop.git", glabHosts: ["code.example.com"] });
  toSwitches(p);
  expect(squeeze(p.text())).toContain(squeeze(`${MODE_FOOT} · 内置默认值：origin 在 code.example.com，glab 已登录 → 远程 · 立即生效`));
});

test("Git 交付没设定时底部写内置依据：origin 主机 gh 和 glab 都没登录 → 仅本地", async () => {
  const p = await page({ origin: "https://git.example.com/acme/shop.git" });
  toSwitches(p);
  expect(squeeze(p.text())).toContain(squeeze(`${MODE_FOOT} · 内置默认值：origin 在 git.example.com，gh 和 glab 都没登录这台主机 → 仅本地 · 立即生效`));
});

test("Git 交付没设定时底部写内置依据：没有 origin → 仅本地", async () => {
  const p = await page({ origin: null });
  toSwitches(p);
  expect(squeeze(p.text())).toContain(squeeze(`${MODE_FOOT} · 内置默认值：没有 origin → 仅本地 · 立即生效`));
});

test("选中合并方式时底部写规则、来源说明和立即生效", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN);
  expect(squeeze(p.text())).toContain(squeeze(`${METHODS_FOOT} · 内置默认值：三种都勾 · 立即生效`));
  const u = await page({ user: oneCompany({ "merge-methods": ["merge"] }) });
  toSwitches(u);
  u.press(DOWN);
  expect(squeeze(u.text())).toContain(squeeze(`${METHODS_FOOT} · 来自用户层 · 立即生效`));
  const q = await page({ project: oneCompany({ "merge-methods": ["squash"] }) });
  toSwitches(q);
  q.press(DOWN);
  expect(squeeze(q.text())).toContain(squeeze(`${METHODS_FOOT} · 来自项目层 · 立即生效`));
});

test("修改 Git 交付第 1 步：标题、两个选项和说明，现值打勾，光标默认在另一项", async () => {
  const p = await page();
  toSwitches(p);
  p.press(ENTER);
  const text = p.pane();
  expect(text).toMatch(/修改 Git 交付 +第 1 步，共 2 步/u);
  expect(squeeze(text)).toContain(squeeze("远程 推送需求分支、开 PR，在 GitHub/GitLab 上合并"));
  expect(squeeze(text)).toContain(squeeze("仅本地 在本机合进主仓库当前分支，不推送"));
  expect(text).toMatch(/✓ +仅本地/u);
  expect(selectedPaneLine(p)).toMatch(/远程/u);
  const q = await page({ user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(q);
  q.press(ENTER);
  expect(q.pane()).toMatch(/✓ +远程/u);
  expect(selectedPaneLine(q)).toMatch(/仅本地/u);
});

test("修改 Git 交付两步走完：第 2 步写标题、项目层和用户层说明，选用户层后 onSaveSwitch 收到 mode 和 layer", async () => {
  const p = await page();
  toSwitches(p);
  p.press(ENTER, ENTER);
  const text = p.pane();
  expect(text).toMatch(/Git 交付 改为远程，存到哪一层 +第 2 步，共 2 步/u);
  expect(text).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(text).toMatch(/用户层 +~\/\.pi\/agent\/settings\.json · 所有项目/u);
  moveTo(p, "用户层");
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "git-delivery", mode: "remote", layer: "user" }]);
});

test("把远程改为仅本地：第 2 步标题写改为仅本地，保存 mode 为 local", async () => {
  const p = await page({ user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/Git 交付 改为仅本地，存到哪一层/u);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "git-delivery", mode: "local", layer: "project" }]);
});

test("授信记录为不信任时 Git 交付第 2 步项目层不可选并写你选过不信任，光标停在用户层", async () => {
  const p = await page({ trust: "denied" });
  toSwitches(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/项目层 +你在 pi 里选过不信任这个项目/u);
  expect(squeeze(p.pane())).toContain(squeeze(DENIED_NOTE));
  expect(selectedPaneLine(p)).toMatch(/用户层/u);
  p.press(UP);
  expect(selectedPaneLine(p)).toMatch(/用户层/u);
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "git-delivery", mode: "remote", layer: "user" }]);
});

test("授信记录为空时 Git 交付第 2 步项目层可选，光标在项目层，下面灰字说明，回车保存到项目层", async () => {
  const p = await page({ trust: "unset" });
  toSwitches(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 选它会把本项目设为受信任/u);
  expect(squeeze(p.pane())).toContain(squeeze(UNSET_NOTE));
  expect(selectedPaneLine(p)).toMatch(/项目层/u);
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "git-delivery", mode: "remote", layer: "project" }]);
});

test("授信记录是信任时 Git 交付第 2 步项目层写只对这个项目生效，没有灰字", async () => {
  const p = await page();
  toSwitches(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(squeeze(p.pane())).not.toContain(squeeze("选项目层会把这个项目设为受信任"));
  expect(squeeze(p.pane())).not.toContain(squeeze("你在 pi 里选过不信任"));
});

test("Git 交付 Esc 逐步退回，第 1 步 Esc 取消并提示已取消修改，什么也不保存", async () => {
  const p = await page();
  toSwitches(p);
  p.press(ENTER, ENTER);
  expect(p.pane()).toMatch(/第 2 步，共 2 步/u);
  p.press(ESC);
  expect(p.pane()).toMatch(/第 1 步，共 2 步/u);
  p.press(ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.switchSaves).toEqual([]);
  expect(p.closed()).toBe(false);
});

test("修改合并方式第 1 步：标题、三行复选框按生效值勾好，压缩合并带推荐，下方写说明和按键提示", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER);
  const text = p.pane();
  expect(text).toMatch(/修改合并方式 +第 1 步，共 2 步/u);
  expect(squeeze(text)).toContain(squeeze("[x] 压缩合并 推荐 一个需求在主分支上是一个提交"));
  expect(squeeze(text)).toContain(squeeze("[x] 普通合并 保留每个提交，另加一个合并提交"));
  expect(squeeze(text)).toContain(squeeze("[x] rebase 合并 保留每个提交，历史是一条直线"));
  expect(squeeze(text)).toContain(squeeze("远程和仅本地都生效。远程时只列出仓库也允许的方式；交付窗口里压缩合并排第一、标推荐。"));
  expect(p.text()).toContain("↑↓ 选择  空格 勾选  回车 下一步  Esc 取消");
  expect(squeeze(p.text())).toContain(squeeze(`${METHODS_FOOT} · 内置默认值：三种都勾 · 立即生效`));
  const q = await page({ user: oneCompany({ "merge-methods": ["merge"] }) });
  toSwitches(q);
  q.press(DOWN, ENTER);
  expect(squeeze(q.pane())).toContain(squeeze("[ ] 压缩合并"));
  expect(squeeze(q.pane())).toContain(squeeze("[x] 普通合并"));
  expect(squeeze(q.pane())).toContain(squeeze("[ ] rebase 合并"));
});

test("空格勾选或取消光标所在的方式", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, DOWN, SPACE);
  expect(squeeze(p.pane())).toContain(squeeze("[ ] 普通合并"));
  expect(squeeze(p.pane())).toContain(squeeze("[x] 压缩合并"));
  p.press(SPACE);
  expect(squeeze(p.pane())).toContain(squeeze("[x] 普通合并"));
});

test("合并方式取消普通合并后进第 2 步：标题用顿号列出勾了的，保存的数组按压缩、普通、rebase 的顺序", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, DOWN, SPACE, ENTER);
  expect(p.pane()).toMatch(/合并方式 改为 压缩合并、rebase 合并，存到哪一层/u);
  moveTo(p, "用户层");
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "merge-methods", methods: ["squash", "rebase"], layer: "user" }]);
});

test("合并方式取消压缩合并和 rebase 合并后第 2 步标题写改为普通合并，保存 methods 为 merge", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, DOWN, DOWN, SPACE, ENTER);
  expect(p.pane()).toMatch(/合并方式 改为 普通合并，存到哪一层/u);
  moveTo(p, "项目层");
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "merge-methods", methods: ["merge"], layer: "project" }]);
});

test("合并方式全都没勾时回车停在第 1 步并出红字，不保存", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, DOWN, SPACE, DOWN, SPACE, ENTER);
  expect(p.pane()).toMatch(/第 1 步，共 2 步/u);
  expect(p.text()).toContain("✗ 至少勾一种合并方式");
  expect(p.lines().join("\n")).toMatch(/<error>[^\n]*✗ 至少勾一种合并方式/u);
  expect(p.switchSaves).toEqual([]);
});

test("合并方式第 2 步 Esc 退回第 1 步并保留勾选，再 Esc 取消并提示已取消修改", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, ENTER);
  p.press(ESC);
  expect(p.pane()).toMatch(/第 1 步，共 2 步/u);
  expect(squeeze(p.pane())).toContain(squeeze("[ ] 压缩合并"));
  p.press(ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.switchSaves).toEqual([]);
  expect(p.closed()).toBe(false);
});

test("授信记录为不信任时合并方式第 2 步项目层不可选并写你选过不信任，保存到用户层", async () => {
  const p = await page({ trust: "denied" });
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, ENTER);
  expect(p.pane()).toMatch(/项目层 +你在 pi 里选过不信任这个项目/u);
  expect(squeeze(p.pane())).toContain(squeeze(DENIED_NOTE));
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "merge-methods", methods: ["merge", "rebase"], layer: "user" }]);
});

test("授信记录为空时合并方式第 2 步项目层可选，光标在项目层，下面灰字说明，回车保存到项目层", async () => {
  const p = await page({ trust: "unset" });
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 选它会把本项目设为受信任/u);
  expect(squeeze(p.pane())).toContain(squeeze(UNSET_NOTE));
  expect(selectedPaneLine(p)).toMatch(/项目层/u);
  p.press(ENTER);
  expect(p.switchSaves).toEqual([{ key: "merge-methods", methods: ["merge", "rebase"], layer: "project" }]);
});

test("授信记录是信任时合并方式第 2 步项目层写只对这个项目生效，没有灰字", async () => {
  const p = await page();
  toSwitches(p);
  p.press(DOWN, ENTER, SPACE, ENTER);
  expect(p.pane()).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(squeeze(p.pane())).not.toContain(squeeze("选项目层会把这个项目设为受信任"));
});

test("来源是内置时按 R 提示已经是内置默认值，不调用清除：Git 交付和合并方式各一次", async () => {
  const p = await page();
  toSwitches(p);
  p.press("R");
  expect(p.rows().map((line) => line.trim())).toContain("已经是内置默认值");
  p.press(DOWN, "r");
  expect(p.rows().map((line) => line.trim())).toContain("已经是内置默认值");
  expect(p.switchClears).toEqual([]);
});

test("按 R 时 onClearSwitch 收到当前行的 key 和生效层", async () => {
  const u = await page({ user: oneCompany({ "git-delivery": "remote" }) });
  toSwitches(u);
  u.press("r");
  expect(u.switchClears).toEqual([{ key: "git-delivery", layer: "user" }]);
  const q = await page({ project: oneCompany({ "git-delivery": "local" }) });
  toSwitches(q);
  q.press("R");
  expect(q.switchClears).toEqual([{ key: "git-delivery", layer: "project" }]);
  const m = await page({ user: oneCompany({ "merge-methods": ["merge"] }), project: oneCompany({ "merge-methods": ["squash"] }) });
  toSwitches(m);
  m.press(DOWN, "R");
  expect(m.switchClears).toEqual([{ key: "merge-methods", layer: "project" }]);
  const n = await page({ user: oneCompany({ "merge-methods": ["merge"] }) });
  toSwitches(n);
  n.press(DOWN, "R");
  expect(n.switchClears).toEqual([{ key: "merge-methods", layer: "user" }]);
});

test("旧版写的 git-delivery: true 在问题里：原因、现在是 true，底部写现在的写法和处理办法", async () => {
  const p = await page({ clean: true, user: oneCompany({ "git-delivery": true }) });
  enterSection(p, "problems");
  expect(paneParts(p.rows(200)).join("\n")).toMatch(/settings\.json +用户 +git-delivery 只能写 remote 或 local/u);
  expect(squeeze(p.text())).toContain(squeeze("现在的写法：true · 删掉这一项或在开关里重新选一次即可"));
  p.press(ENTER);
  expect(squeeze(p.pane())).toMatch(/┊原因.*git-delivery只能写remote或local.*┊现在是true.*┊影响这一项没有生效，改用下一层/u);
});

test("merge-methods 写错在问题里：原因写一到三个且不能重复，现在的写法是原样", async () => {
  const p = await page({ clean: true, project: oneCompany({ "merge-methods": ["squash", "squash"] }) });
  enterSection(p, "problems");
  expect(squeeze(p.text())).toContain(squeeze('现在的写法：["squash","squash"] · 删掉这一项或在开关里重新选一次即可'));
  p.press(ENTER);
  expect(squeeze(p.pane()).replaceAll("┊", "")).toMatch(/原因.*merge-methods只能是squash、merge、rebase里的一到三个，不能重复.*现在是\["squash","squash"\]/u);
});

test("该层写错的 git-delivery 不生效：项目层写 true 时开关行取用户层", async () => {
  const p = await page({ user: oneCompany({ "git-delivery": "remote" }), project: oneCompany({ "git-delivery": true }) });
  toSwitches(p);
  expect(p.pane()).toMatch(/▸ Git 交付 +用户 +远程/u);
});

test("notice 代替底部说明显示：ok 绿色、muted 灰色、error 红色", async () => {
  for (const [tone, kind] of [["ok", "success"], ["muted", "muted"], ["error", "error"]] as const) {
    const p = await page({ state: { notice: { tone, text: "提示内容" } } });
    expect(p.lines().join("\n"), tone).toContain(`<${kind}>提示内容</>`);
    expect(p.text(), tone).not.toContain("worker：写代码");
  }
});

test("44 列焦点在目录时只画目录，没有分隔竖线，提示换成“→ 进入”", async () => {
  const p = await page();
  const rows = p.rows(44);
  expect(rows.some((row) => row.includes("│"))).toBe(false);
  expect(p.text(44)).toContain("角色定义");
  expect(p.text(44)).toMatch(/worker +8/u);
  expect(p.text(44)).not.toMatch(/名称 +来源/u);
  expect(p.text(44)).toContain("↑↓ 选分类  → 进入  Esc 退出");
});

test("44 列 → 进右栏后只画右栏，首行“设置 › 模型”，提示换成“←/Esc 回目录”；回车改模型后首行“设置 › 模型 › PM”", async () => {
  const p = await page();
  p.press(...inPane(5));
  const rows = p.rows(44);
  expect(rows.some((row) => row.includes("│"))).toBe(false);
  expect(rows[1]!.trim()).toBe("设置 › 模型");
  expect(p.text(44)).toContain("←/Esc 回目录");
  expect(p.text(44)).not.toContain("回左栏");
  expect(p.text(44)).not.toContain("角色定义");
  p.press(ENTER);
  expect(p.rows(44)[1]!.trim()).toBe("设置 › 模型 › PM");
});

test("44 列职责分类首行“设置 › worker”，命名时首行“设置 › worker › 复制”，开关修改首行“设置 › 开关 › Git 交付”", async () => {
  const p = await page();
  p.press(RIGHT);
  expect(p.rows(44)[1]!.trim()).toBe("设置 › worker");
  p.press("c");
  expect(p.rows(44)[1]!.trim()).toBe("设置 › worker › 复制");
  const q = await page();
  toSwitches(q);
  q.press(ENTER);
  expect(q.rows(44)[1]!.trim()).toBe("设置 › 开关 › Git 交付");
});

test("窄终端放不下的文字末尾用 … 截断", async () => {
  const p = await page();
  p.press(RIGHT);
  const row = p.rows(36).find((line) => line.includes("ui-worker"))!;
  expect(row).toContain("…");
  expect(visibleWidth(row)).toBeLessThanOrEqual(36);
});

test("59 列是窄布局、60 列是宽布局", async () => {
  const p = await page();
  expect(p.rows(59).some((row) => row.includes("│"))).toBe(false);
  expect(p.rows(60).some((row) => row.includes("│"))).toBe(true);
});

test("36 到 38 列时选中任一职责分类，目录不超宽，选中的分类名和数量都在", async () => {
  const roles = ["worker", "reviewer", "qa", "explore", "prototype"];
  for (let width = 36; width <= 38; width++) {
    for (const [index, role] of roles.entries()) {
      const p = await page();
      p.press(...Array<string>(index).fill(DOWN));
      const rows = p.rows(width);
      for (const row of rows) expect(visibleWidth(row), `${role} ${width}: ${row}`).toBeLessThanOrEqual(width);
      expect(rows.find((row) => row.includes(role)), `${role} ${width}`).toMatch(new RegExp(`${role} +\\d+`, "u"));
    }
  }
});

interface Screen { label: string; options?: PageOptions; keys: string[] }
const toSection = (name: (typeof SECTIONS)[number], ...more: string[]) => [...inPane(SECTIONS.indexOf(name)), ...more];
const TRUST_CYCLE = ["trusted", "denied", "unset"] as const;
const SCREENS: Screen[] = [
  { label: "目录", keys: [] },
  { label: "记录为空的目录", options: { trust: "unset" }, keys: [] },
  { label: "不信任的目录", options: { trust: "denied" }, keys: [] },
  ...SECTIONS.flatMap((name, index): Screen[] => [
    { label: `${name} 列表`, options: { trust: TRUST_CYCLE[index % 3] }, keys: toSection(name) },
    ...(["models", "switches"].includes(name) ? [] : [{ label: `${name} 展开`, options: { trust: TRUST_CYCLE[index % 3] }, keys: toSection(name, ENTER) }]),
  ]),
  { label: "复制命名", keys: [RIGHT, "c"] },
  { label: "模型第 1 步", options: { models: [SOL, LONG] }, keys: toSection("models", ENTER) },
  { label: "模型第 2 步", options: { models: [SOL, LONG] }, keys: toSection("models", ENTER, ENTER) },
  { label: "模型第 3 步", options: { models: [SOL, LONG] }, keys: toSection("models", ENTER, ENTER, ENTER) },
  { label: "记录为空的模型第 3 步", options: { trust: "unset", models: [SOL, LONG] }, keys: toSection("models", ENTER, ENTER, ENTER) },
  { label: "不信任的模型第 3 步", options: { trust: "denied" }, keys: toSection("models", ENTER, ENTER, ENTER) },
  { label: "没有可选模型的第 1 步", options: { models: [] }, keys: toSection("models", ENTER) },
  { label: "模型不可用的列表", options: { user: oneCompany({ "draft-verifier": { model: "claude-opus-5-5-extended-context-preview-x", thinking: "medium" } }) }, keys: toSection("models", DOWN, DOWN) },
  { label: "跟随值的列表", options: { models: [SOL, LONG], mainThinking: "off", user: oneCompany({ pm: { model: "claude-opus-5-5-extended-context-preview", thinking: null }, interpreter: { model: null, thinking: "off" } }) }, keys: toSection("models") },
  { label: "第 2 步多出的跟随主会话", options: { mainThinking: "xhigh" }, keys: toSection("models", DOWN, ENTER, ENTER) },
  { label: "开关第 1 步", keys: toSection("switches", ENTER) },
  { label: "开关第 2 步", keys: toSection("switches", ENTER, ENTER) },
  { label: "记录为空的开关第 2 步", options: { trust: "unset" }, keys: toSection("switches", ENTER, ENTER) },
  { label: "不信任的开关第 2 步", options: { trust: "denied" }, keys: toSection("switches", ENTER, ENTER) },
  { label: "记录为空的合并方式第 2 步", options: { trust: "unset" }, keys: toSection("switches", DOWN, ENTER, ENTER) },
  { label: "不信任的合并方式第 2 步", options: { trust: "denied" }, keys: toSection("switches", DOWN, ENTER, ENTER) },
  { label: "记录为空的问题展开", options: { trust: "unset" }, keys: toSection("problems", ENTER) },
  { label: "合并方式第 1 步", keys: toSection("switches", DOWN, ENTER) },
  { label: "合并方式第 2 步", keys: toSection("switches", DOWN, ENTER, ENTER) },
  { label: "合并方式全取消后的第 1 步", keys: toSection("switches", DOWN, ENTER, " ", DOWN, " ", DOWN, " ", ENTER) },
  { label: "问题展开含设置文件", options: { project: oneCompany({ "git-delivery": "yes" }) }, keys: toSection("problems", DOWN, ENTER) },
  { label: "带提示的目录", options: { state: { notice: { tone: "ok", text: NOTICE } } }, keys: [] },
];

test("36、44、56、59、60、80 列下每个画面每一行的显示宽度都不超过终端宽度", async () => {
  for (const screen of SCREENS) {
    const p = await page(screen.options);
    p.press(...screen.keys);
    for (const width of [36, 44, 56, 59, 60, 80]) {
      for (const row of p.rows(width)) expect(visibleWidth(row), `${screen.label} ${width} 列：${row}`).toBeLessThanOrEqual(width);
    }
  }
});

test("36 到 80 列下每个画面都不超宽（逐列）", async () => {
  for (const screen of SCREENS) {
    const p = await page(screen.options);
    p.press(...screen.keys);
    for (let width = 36; width <= 80; width++) {
      for (const row of p.rows(width)) expect(visibleWidth(row), `${screen.label} ${width} 列：${row}`).toBeLessThanOrEqual(width);
    }
  }
});

test("底部提示放不下时折成多行，整句每个字都看得到，不以…截掉；放得下时仍只占一行", async () => {
  const wide = await page({ state: { notice: { tone: "ok", text: NOTICE } } });
  const baseline = await page({ state: { notice: { tone: "ok", text: "✓ 短" } } });
  expect(wide.lines(200)).toHaveLength(baseline.lines(200).length);
  expect(baseline.lines(36).length).toBeLessThan(wide.lines(36).length);
  for (const tone of ["ok", "muted"] as const) {
    for (let width = 36; width <= 80; width++) {
      const p = await page({ state: { notice: { tone, text: NOTICE } } });
      expect(squeeze(p.rows(width).join("")), `${width}`).toContain(squeeze(NOTICE));
    }
  }
});

test("模型行的成功提示放不下时同样折行，整句都看得到", async () => {
  const text = "✓ PM 改为 5x/gpt-6-luna · xhigh，存到项目层，下次启动 PM 时生效";
  for (let width = 36; width <= 80; width++) {
    const p = await page({ state: { section: "models", focus: "pane", selectName: "pm", notice: { tone: "ok", text } } });
    expect(squeeze(p.rows(width).join("")), `${width}`).toContain(squeeze(text));
  }
});

test("底部提示折行时尽量在空格后断开，每个词完整地留在一行里", async () => {
  const words = ["alpha-one", "beta-two", "gamma-three", "delta-four", "epsilon-five", "zeta-six"];
  const p = await page({ state: { notice: { tone: "muted", text: words.join(" ") } } });
  const rows = p.rows(36);
  for (const word of words) expect(rows.some((row) => row.includes(word)), word).toBe(true);
});

test("复制完成提示折行：在最后一个空格、中文逗号或斜杠之后断开", async () => {
  const footerRows = (rows: string[]) => {
    const start = rows.findIndex((row) => row.startsWith(" ✓ "));
    const end = rows.findIndex((row, index) => index > start && /^\s*(↑↓|←)/u.test(row));
    return rows.slice(start, end).map((row) => row.slice(1).trimEnd());
  };
  const show = async (width: number, text: string) => footerRows((await page({ state: { notice: { tone: "ok", text } } })).rows(width));
  expect(await show(36, NOTICE)).toEqual(["✓ 已复制到 ~/.pi/agent/agents/", "vue-engineer.md，", "打开它写专长、skills 和 mcp"]);
  expect(await show(80, "✓ 已复制到 ~/Projects/some-company/frontend-app/.pi/agents/vue-engineer.md，打开它写专长、skills 和 mcp"))
    .toEqual(["✓ 已复制到 ~/Projects/some-company/frontend-app/.pi/agents/vue-engineer.md，", "打开它写专长、skills 和 mcp"]);
  expect(await show(80, "✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp")).toEqual(["✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp"]);
});

test("模型行底部说明在 36 列下折行后，任何一行都不以顿号或逗号开头", async () => {
  const p = await page();
  toModels(p);
  const rows = p.rows(36);
  expect(rows.some((row) => row.trimStart().startsWith("PM："))).toBe(true);
  for (const row of rows) expect(row.trimStart(), row).not.toMatch(/^[、，]/u);
});

test("按键提示放不下时按两个空格分组折行，一组不被拆开，放得下时仍是一行", async () => {
  const screens: Array<{ hint: string; keys: string[] }> = [
    { hint: "↑↓ 选分类  → 进右栏  Esc 退出", keys: [] },
    { hint: AGENT_HINT, keys: [RIGHT] },
    { hint: AGENT_HINT_OPEN, keys: [RIGHT, ENTER] },
    { hint: "←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层", keys: toSection("models") },
    { hint: "←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层", keys: toSection("switches") },
    { hint: "←/Esc 回左栏  ↑↓ 选择  回车 详情", keys: toSection("problems") },
    { hint: "←/Esc 回左栏  ↑↓ 选择  回车 收起", keys: toSection("problems", ENTER) },
    { hint: "回车 下一步  Esc 取消", keys: [RIGHT, "c"] },
    { hint: "↑↓ 选择  回车 下一步  Esc 取消", keys: toSection("models", ENTER) },
    { hint: "↑↓ 选择  回车 下一步  Esc 上一步", keys: toSection("models", ENTER, ENTER) },
    { hint: "↑↓ 选择  回车 保存  Esc 上一步", keys: toSection("models", ENTER, ENTER, ENTER) },
  ];
  for (const { hint, keys } of screens) {
    for (let width = 36; width <= 80; width++) {
      const shown = width < 60 ? hint.replace("←/Esc 回左栏", "←/Esc 回目录").replace("→ 进右栏", "→ 进入") : hint;
      const groups = shown.split("  ");
      const p = await page();
      p.press(...keys);
      const rows = p.rows(width);
      const hintRows = rows.map((row) => row.trim()).filter((row) => row && row.split("  ").every((group) => groups.includes(group)));
      expect(hintRows.flatMap((row) => row.split("  ")), `${shown} ${width}`).toEqual(groups);
      if (visibleWidth(` ${shown}`) <= width) expect(hintRows, `${shown} ${width}`).toHaveLength(1);
      else expect(hintRows.length, `${shown} ${width}`).toBeGreaterThan(1);
    }
  }
});

test("复制命名画面的红字错误放不下时折成多行，36 到 80 列各行拼起来是完整的错误原文", async () => {
  const longName = "a".repeat(60);
  const cases: Array<{ error: string; type: string[] }> = [
    { error: "✗ 只能用小写字母、数字和连字符，例如 ui-worker", type: ["U", "I"] },
    { error: `✗ 用户层已经有 ${longName}，换一个名字`, type: [...longName] },
  ];
  for (const { error, type } of cases) {
    for (let width = 36; width <= 80; width++) {
      const p = await page({ taken: { [longName]: "用户层" } });
      p.press(RIGHT, "c", ...Array<string>("ui-worker-copy".length).fill(BACKSPACE), ...type, ENTER);
      expect(squeeze(rightParts(p.rows(width)).join("")), `${width}`).toContain(squeeze(error));
    }
  }
});

test("state() 在右栏选中解释器时返回模型分类、右栏焦点、解释器，用它构造新视图后光标还原", async () => {
  const p = await page();
  toModels(p);
  p.press(DOWN);
  expect(p.view.state()).toEqual({ section: "models", focus: "pane", selectName: "interpreter" });
  const q = await page({ state: p.view.state() });
  expect(selectedPaneLine(q)).toMatch(/▸ 解释器/u);
  expect(paneParts(q.rows())[0]!.trim()).toBe("模型  PM 和两个内部代理用哪个模型");
});

test("state() 对定义行用定义名、对开关行用 git-delivery、在目录时焦点是 nav，都能还原", async () => {
  const d = await page();
  d.press(RIGHT);
  moveTo(d, "ui-worker");
  expect(d.view.state()).toEqual({ section: "worker", focus: "pane", selectName: "ui-worker" });
  const d2 = await page({ state: d.view.state() });
  expect(selectedPaneLine(d2)).toMatch(/▸ ui-worker/u);
  const s = await page();
  toSwitches(s);
  expect(s.view.state()).toEqual({ section: "switches", focus: "pane", selectName: "git-delivery" });
  const nav = await page();
  nav.press(DOWN, DOWN);
  expect(nav.view.state()).toMatchObject({ section: "qa", focus: "nav" });
  const nav2 = await page({ state: nav.view.state() });
  expect(navCells(nav2.rows())).toContain("▸ qa 1");
  expect(nav2.text()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
});

test("复制：新名称三层不重复，复制后 name 字段改为新名称", async () => {
  const { dirs } = await roleDirsOnly();
  const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!;
  const layerDirs = [dirs.defaultDir, dirs.userDir, dirs.projectDir];
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: dirs.projectDir, layerDirs });
  expect(await readFile(target, "utf8")).toMatch(/^name: ui-dev$/mu);
  await expect(copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: dirs.userDir, layerDirs })).rejects.toBeInstanceOf(AgentCopyError);
  await expect(copyAgentDefinition({ entry: worker, newName: "reviewer", targetDir: dirs.userDir, layerDirs })).rejects.toThrow("已被使用");
  await expect(copyAgentDefinition({ entry: worker, newName: "Bad Name", targetDir: dirs.userDir, layerDirs })).rejects.toThrow("名称只能");
  const reloaded = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "ui-dev")).toMatchObject({ source: "project", available: true });
});

test("复制内置 worker 生成的文件头部不含 model 和 thinking，仍有 skills 与 mcp 空数组", async () => {
  const { dirs } = await roleDirsOnly();
  const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!;
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: dirs.userDir, layerDirs: [dirs.defaultDir, dirs.userDir, dirs.projectDir] });
  const head = (await readFile(target, "utf8")).split(/^---$/mu)[1]!;
  expect(head).not.toMatch(/^model:/mu);
  expect(head).not.toMatch(/^thinking:/mu);
  expect(head).toMatch(/^skills: \[\]$/mu);
  expect(head).toMatch(/^mcp: \[\]$/mu);
});

test("80 列下在 PM 上回车改模型、在开关上回车改开关、在 worker 上按 C 命名时，目录仍完整显示，当前分类行是焦点在右栏的样式", async () => {
  const cases: Array<[RegExp, string[], string]> = [[/模型 +3/u, toSection("models", ENTER), "模型"], [/开关 +2/u, toSection("switches", ENTER), "开关"], [/worker +8/u, [RIGHT, "c"], "worker"]];
  for (const [cell, keys] of cases) {
    const p = await page();
    p.press(...keys);
    const joined = navCells(p.rows()).join("|");
    for (const name of ["worker", "reviewer", "qa", "explore", "prototype", "模型", "开关"]) expect(joined, `${cell.source} ${name}`).toContain(name);
    const raw = p.lines().find((line) => plain(line).includes("│") && cell.test(plain(line).slice(0, plain(line).indexOf("│"))))!;
    const navPart = raw.slice(0, raw.indexOf("│"));
    expect(navPart, cell.source).not.toContain("[selectedBg]");
    expect(navPart, cell.source).toMatch(/<accent>[^\n]*\*\*/u);
  }
});

test("展开详情里很长的文件路径折成多行完整显示，不用 … 截断，每行不超宽", async () => {
  for (let width = 36; width <= 80; width++) {
    const p = await page({ longPath: true });
    p.press(RIGHT);
    moveTo(p, "ui-worker");
    p.press(ENTER);
    const home = homedir();
    const full = join(p.root, "u", "ui-worker.md");
    const expected = full.startsWith(home) ? `~${full.slice(home.length)}` : full;
    expect(squeeze(rightParts(p.rows(width)).join("").replaceAll("┊", "")), `${width}`).toContain(squeeze(expected));
    for (const row of p.rows(width)) expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
  }
});

const startCol = (row: string, needle: string) => {
  const from = row.includes("│") ? row.indexOf("│") + 1 : 0;
  const index = row.indexOf(needle, from);
  return index < 0 ? -1 : visibleWidth(row.slice(0, index));
};
const rowWith = (rows: string[], needle: string) => rows.find((row) => startCol(row, needle) >= 0) ?? "";

test("宽布局 60 和 80 列下，两条分隔线之间每一行的 │ 都恰好在第 21 个显示列，含目录空行和比目录长的右栏行", async () => {
  const screens: Array<[string, PageOptions, string[]]> = [
    ["目录", {}, []], ["职责展开", {}, [RIGHT, ENTER]], ["命名", {}, [RIGHT, "c"]], ["模型第 1 步", {}, toSection("models", ENTER)],
    ["模型第 3 步", { models: [SOL, LONG] }, toSection("models", ENTER, ENTER, ENTER)], ["开关第 2 步", { trust: "denied" }, toSection("switches", ENTER, ENTER)],
    ["记录为空的开关第 2 步", { trust: "unset" }, toSection("switches", ENTER, ENTER)], ["记录为空的模型第 3 步", { trust: "unset" }, toSection("models", ENTER, ENTER, ENTER)],
    ["问题展开", { trust: "denied" }, toSection("problems", ENTER)],
  ];
  for (const [label, options, keys] of screens) {
    const p = await page(options);
    p.press(...keys);
    for (const width of [60, 80]) {
      const rows = p.rows(width);
      const top = rows.findIndex((row) => row.includes("┬")), bottom = rows.findIndex((row) => row.includes("┴"));
      expect(top, label).toBeGreaterThan(-1);
      for (const row of rows.slice(top + 1, bottom)) {
        expect(row.includes("│"), `${label} ${width}: ${row}`).toBe(true);
        expect(visibleWidth(row.slice(0, row.indexOf("│"))), `${label} ${width}: ${row}`).toBe(20);
      }
    }
  }
});

test("宽布局职责表格：表头的来源、模型、思考与数据行的来源标签、模型、思考同一起始列", async () => {
  const p = await page();
  p.press(RIGHT);
  const rows = p.rows();
  const head = rowWith(rows, "名称");
  const user = rows.find((row) => row.includes("ui-worker") && row.includes("│"))!;
  const builtin = rows.find((row) => row.includes(" 内置 ") && row.includes("│") && row.includes("worker") && !row.includes("ui-worker"))!;
  expect(startCol(head, "来源")).toBe(startCol(user, " 用户 "));
  expect(startCol(head, "来源")).toBe(startCol(builtin, " 内置 "));
  expect(startCol(head, "模型")).toBe(startCol(user, "5x/gpt-6-luna"));
  expect(startCol(head, "模型")).toBe(startCol(builtin, "跟随主会话"));
  expect(startCol(head, "思考")).toBe(startCol(user, "medium"));
  expect(startCol(head, "思考")).toBe(visibleWidth(builtin.slice(0, builtin.lastIndexOf("跟随"))));
});

test("宽布局模型表格：表头的来源、模型、思考与 PM 行同一起始列", async () => {
  const p = await page({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: "high" } }) });
  toModels(p);
  const rows = p.rows();
  const head = rowWith(rows, "名称"), pm = rows.find((row) => row.includes("PM ") && row.includes("gpt-6-luna") && row.includes("│"))!;
  expect(startCol(head, "来源")).toBe(startCol(pm, " 用户 "));
  expect(startCol(head, "模型")).toBe(startCol(pm, "gpt-6-luna"));
  expect(startCol(head, "思考")).toBe(startCol(pm, "high"));
});

test("宽布局开关表格：表头的来源、状态与 Git 交付行同一起始列", async () => {
  const p = await page({ user: oneCompany({ "git-delivery": "remote", "merge-methods": ["merge"] }) });
  toSwitches(p);
  const rows = p.rows();
  const head = rowWith(rows, "名称"), row = rows.find((r) => r.includes("Git 交付") && r.includes("│") && r.includes("远程"))!;
  const methodRow = rows.find((r) => r.includes("合并方式") && r.includes("│") && r.includes("普通合并"))!;
  expect(startCol(head, "来源")).toBe(startCol(row, " 用户 "));
  expect(startCol(head, "状态")).toBe(startCol(row, "远程"));
  expect(startCol(head, "来源")).toBe(startCol(methodRow, " 用户 "));
  expect(startCol(head, "状态")).toBe(startCol(methodRow, "普通合并"));
});

test("宽布局问题表格：表头的层、原因与数据行同一起始列", async () => {
  const p = await page();
  enterSection(p, "problems");
  const rows = p.rows(200);
  const head = rows.find((r) => /文件 +层 +原因/u.test(r))!, row = rows.find((r) => r.includes("broken.md"))!;
  expect(startCol(head, "层")).toBe(startCol(row, " 用户 "));
  expect(startCol(head, "原因")).toBe(startCol(row, "thinking 写错了"));
});

test("目录里标签左对齐，份数单独成一列，各行数字起始列相同", async () => {
  const p = await page();
  const cells = navCells(p.rows()).length && p.rows().filter((row) => row.includes("│")).map((row) => row.slice(0, row.indexOf("│")));
  const labels = ["worker", "reviewer", "qa", "explore", "prototype", "模型", "开关", "问题"];
  const found = labels.map((label) => (cells as string[]).find((cell) => cell.includes(label) && /\d+\s*$/u.test(cell))!);
  expect(found.every(Boolean)).toBe(true);
  const numberCols = found.map((cell) => visibleWidth(cell.slice(0, cell.search(/\d+\s*$/u))));
  expect(new Set(numberCols).size).toBe(1);
  const labelCols = found.map((cell, index) => visibleWidth(cell.slice(0, cell.indexOf(labels[index]!))));
  expect(new Set(labelCols).size).toBe(1);
});

test("修改模型的三步里，底部继续写 PM 的说明，按键提示是步骤自己的", async () => {
  const hints = ["↑↓ 选择  回车 下一步  Esc 取消", "↑↓ 选择  回车 下一步  Esc 上一步", "↑↓ 选择  回车 保存  Esc 上一步"];
  for (const [index, hint] of hints.entries()) {
    const p = await page();
    p.press(...toSection("models", ...Array<string>(index + 1).fill(ENTER)));
    expect(squeeze(p.text()), `第 ${index + 1} 步`).toContain(squeeze("PM：活动需求的负责人，拆任务、派工、调度 · 内置默认值 · 下次启动 PM 时生效"));
    expect(p.text()).toContain(hint);
  }
});

test("修改开关的两步里，底部继续写 Git 交付的说明，按键提示是步骤自己的", async () => {
  const hints = ["↑↓ 选择  回车 下一步  Esc 取消", "↑↓ 选择  回车 保存  Esc 上一步"];
  for (const [index, hint] of hints.entries()) {
    const p = await page();
    p.press(...toSection("switches", ...Array<string>(index + 1).fill(ENTER)));
    expect(squeeze(p.text()), `第 ${index + 1} 步`).toContain(squeeze(`${MODE_FOOT} · 内置默认值：没有 origin → 仅本地 · 立即生效`));
    expect(p.text()).toContain(hint);
  }
});

test("修改合并方式的两步里，底部显示合并方式的说明，按键提示是步骤自己的", async () => {
  const hints = ["↑↓ 选择  空格 勾选  回车 下一步  Esc 取消", "↑↓ 选择  回车 保存  Esc 上一步"];
  for (const [index, hint] of hints.entries()) {
    const p = await page();
    p.press(...toSection("switches", DOWN, ...Array<string>(index + 1).fill(ENTER)));
    expect(squeeze(p.text()), `第 ${index + 1} 步`).toContain(squeeze(`${METHODS_FOOT} · 内置默认值：三种都勾 · 立即生效`));
    expect(p.text()).toContain(hint);
  }
});

test("项目、用户、内置三层都有 worker 定义时，目录焦点底部按项目、用户、内置写份数", async () => {
  const p = await page({ projectWorker: true });
  expect(p.text()).toContain("worker：写代码 · 9 份定义（项目 1 · 用户 1 · 内置 7）");
});

test("问题分类里按 C 和 R 不起作用：不触发回调，不进入命名或修改，不出现提示", async () => {
  const p = await page();
  enterSection(p, "problems");
  const before = p.text();
  p.press("c", "C", "r", "R");
  expect(p.copies).toEqual([]);
  expect(p.saves).toEqual([]);
  expect(p.clears).toEqual([]);
  expect(p.switchClears).toEqual([]);
  expect(p.text()).toBe(before);
});

test("缺少 role 字段的定义文件在问题分类里显示一行，短原因是不是 one-company 的定义，没有导入", async () => {
  const p = await page({ noRole: true });
  enterSection(p, "problems");
  const row = paneParts(p.rows(200)).find((line) => line.includes("other.md"));
  expect(row).toMatch(/other\.md +用户 +不是 one-company 的定义，没有导入/u);
});

const isDataRow = (line: string, name: string) => firstWord(line) === name && /用户|项目|内置/u.test(line);
const rowOf = (p: Page, name: string, width = 80) => rightParts(p.rows(width)).find((line) => isDataRow(line, name)) ?? "";
const detailText = (p: Page) => squeeze(p.pane().replaceAll("┊", ""));

test("定义开关：worker 分类表头写名称、来源、状态、模型、思考；通用定义状态是必须，专项开启；用户层关掉的显示关闭", async () => {
  const p = await page({ user: oneCompany({ "disabled-agents": ["python-worker"] }) });
  p.press(RIGHT);
  expect(paneParts(p.rows())[2]).toMatch(/^\s*名称 +来源 +状态 +模型 +思考\s*$/u);
  expect(rowOf(p, "worker")).toContain("必须");
  expect(rowOf(p, "go-worker")).toContain("开启");
  expect(rowOf(p, "python-worker")).toContain("关闭");
  expect(rowOf(p, "python-worker")).not.toContain("开启");
});

test("定义开关：状态用颜色区分，必须灰、开启绿、关闭灰且名字也灰", async () => {
  const p = await page({ user: oneCompany({ "disabled-agents": ["python-worker"] }) });
  p.press(RIGHT);
  const line = (name: string) => { const raw = p.lines().find((l) => plain(l).includes("│") && isDataRow(plain(l).slice(plain(l).indexOf("│") + 1), name))!; return raw.slice(raw.indexOf("│")); };
  expect(line("worker")).toMatch(/<(muted|dim)>[^<]*必须/u);
  expect(line("go-worker")).toMatch(/<success>[^<]*开启/u);
  expect(line("python-worker")).toMatch(/<(muted|dim)>[^<]*python-worker/u);
  expect(line("python-worker")).toMatch(/<(muted|dim)>[^<]*关闭/u);
});

test("定义开关：36 列进入右栏时去掉思考列、保留状态列，每行都不超过 36 列", async () => {
  const p = await page({ user: oneCompany({ "disabled-agents": ["python-worker"] }) });
  p.press(RIGHT);
  const text = p.text(36);
  expect(text).toMatch(/名称 +来源 +状态/u);
  expect(text).not.toContain("思考");
  for (const row of p.rows(36)) expect(visibleWidth(row), row).toBeLessThanOrEqual(36);
  expect(rowOf(p, "go-worker", 36)).toContain("开启");
});

test("定义开关：在通用定义 reviewer 上按空格不触发开关回调，底部黄字写通用定义不能关闭", async () => {
  const p = await page();
  p.press(DOWN, RIGHT);
  moveTo(p, "reviewer");
  p.press(SPACE);
  expect(p.toggles).toEqual([]);
  expect(squeeze(p.text())).toContain(squeeze("reviewer 是通用定义，流程离不开它，不能关闭"));
  expect(p.lines().join("\n")).toMatch(/<warning>[^\n]*reviewer 是通用定义/u);
});

test("定义开关：在 go-worker 上按空格触发开关回调，参数是 go-worker 条目", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "go-worker");
  p.press(SPACE);
  expect(p.toggles).toEqual(["go-worker"]);
});

test("定义开关：定义分类的操作提示带空格 开关，展开时回车 详情换成回车 收起", async () => {
  const p = await page();
  p.press(RIGHT);
  expect(p.text()).toContain(AGENT_HINT);
  p.press(ENTER);
  expect(p.text()).toContain(AGENT_HINT_OPEN);
});

test("定义开关：展开 go-worker 写开启默认值和自动加 go-reviewer", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "go-worker");
  p.press(ENTER);
  expect(detailText(p)).toContain(squeeze("开启 · 默认值 · 切换后全局生效"));
  expect(detailText(p)).toContain(squeeze("用了它的任务自动加 go-reviewer"));
  expect(p.pane()).toMatch(/┊ 开关/u);
  expect(p.pane()).toMatch(/┊ 审查/u);
});

test("定义开关：展开关闭的定义写关闭和来自哪一层，项目层关闭写来自项目层", async () => {
  const u = await page({ user: oneCompany({ "disabled-agents": ["go-worker"] }) });
  u.press(RIGHT);
  moveTo(u, "go-worker");
  u.press(ENTER);
  expect(detailText(u)).toContain(squeeze("关闭 · 来自用户层"));
  const j = await page({ project: oneCompany({ "disabled-agents": ["go-worker"] }) });
  j.press(RIGHT);
  moveTo(j, "go-worker");
  j.press(ENTER);
  expect(detailText(j)).toContain(squeeze("关闭 · 来自项目层"));
});

test("定义开关：展开项目层的定义，开关行写切换后本项目生效", async () => {
  const p = await page({ projectWorker: true });
  p.press(RIGHT);
  moveTo(p, "proj-worker");
  p.press(ENTER);
  expect(detailText(p)).toContain(squeeze("开启 · 默认值 · 切换后本项目生效"));
});

test("定义开关：展开没有配对审查的用户定义 acme-worker 没有审查行", async () => {
  const p = await page({ acmeWorker: true });
  p.press(RIGHT);
  moveTo(p, "acme-worker");
  p.press(ENTER);
  expect(p.pane()).toMatch(/┊ 开关/u);
  expect(p.pane()).not.toMatch(/┊ 审查/u);
});

test("定义开关：展开通用定义 worker 没有开关行和审查行", async () => {
  const p = await page();
  p.press(RIGHT);
  moveTo(p, "worker");
  p.press(ENTER);
  expect(p.pane()).toMatch(/┊ 说明/u);
  expect(p.pane()).not.toMatch(/┊ 开关/u);
  expect(p.pane()).not.toMatch(/┊ 审查/u);
});

const rawRow = (p: Page, name: string, width = 80) => {
  const raw = p.lines(width).find((l) => plain(l).includes("│") && isDataRow(plain(l).slice(plain(l).indexOf("│") + 1), name))!;
  return raw.slice(raw.indexOf("│"));
};
const switchRow = (p: Page) => p.lines().find((l) => plain(l).includes("┊") && plain(l).includes("开关")) ?? "";

test("定义开关：开启后另一层仍写着关闭时，这一行名字是灰色，不是绿色高亮", async () => {
  const warning = { tone: "warning", text: "go-worker 仍是关闭：项目层设置文件里也写了关闭" };
  const p = await page({ project: oneCompany({ "disabled-agents": ["go-worker"] }), state: { section: "worker", focus: "pane", selectName: "go-worker", fresh: "go-worker", notice: warning } });
  expect(rowOf(p, "go-worker")).toContain("关闭");
  expect(rawRow(p, "go-worker")).not.toMatch(/<success>[^<]*go-worker/u);
  expect(rawRow(p, "go-worker")).toMatch(/<(muted|dim)>[^<]*go-worker/u);
  const on = await page({ state: { section: "worker", focus: "pane", selectName: "go-worker", fresh: "go-worker", notice: { tone: "ok", text: "已开启 go-worker · 全局生效" } } });
  expect(rawRow(on, "go-worker")).toMatch(/<success>go-worker/u);
});

test("定义开关：展开 x-worker 时，同名前缀的 x-reviewer 定义格式错误，没有审查行", async () => {
  const p = await page({ pairedBroken: true });
  p.press(RIGHT);
  moveTo(p, "x-worker");
  p.press(ENTER);
  expect(p.pane()).toMatch(/┊ 开关/u);
  expect(p.pane()).not.toMatch(/┊ 审查/u);
});

test("定义开关：39、44、60 列进入 worker 和 reviewer 分类右栏，每行都不超过终端宽度", async () => {
  for (const section of ["worker", "reviewer"] as const) {
    for (const width of [39, 44, 60]) {
      const p = await page();
      enterSection(p, section);
      for (const row of p.rows(width)) expect(visibleWidth(row), `${section} ${width} ${row}`).toBeLessThanOrEqual(width);
      expect(p.text(width), `${section} ${width}`).toContain("状态");
    }
  }
});

test("定义开关：80 列 reviewer 分类里 python-reviewer、react-reviewer 名字完整不带省略号，表头仍有思考", async () => {
  const p = await page();
  enterSection(p, "reviewer");
  expect(rowOf(p, "python-reviewer")).toContain("python-reviewer");
  expect(rowOf(p, "react-reviewer")).toContain("react-reviewer");
  expect(p.pane()).not.toContain("…");
  expect(p.pane()).toMatch(/名称 +来源 +状态 +模型 +思考/u);
});

test("定义开关：展开后开关行开启是绿色，关闭是灰色", async () => {
  const on = await page();
  on.press(RIGHT);
  moveTo(on, "go-worker");
  on.press(ENTER);
  expect(switchRow(on)).toMatch(/<success>[^<]*开启/u);
  const off = await page({ user: oneCompany({ "disabled-agents": ["go-worker"] }) });
  off.press(RIGHT);
  moveTo(off, "go-worker");
  off.press(ENTER);
  expect(switchRow(off)).toMatch(/<(muted|dim)>[^<]*关闭/u);
});

test("路径是家目录或在家目录下才写成 ~，名字以家目录名开头的别的目录原样显示", () => {
  const home = homedir();
  expect(tilde(home)).toBe("~");
  expect(tilde(join(home, ".pi", "agent", "AGENTS.md"))).toBe("~/.pi/agent/AGENTS.md");
  expect(tilde(`${home}2/proj/AGENTS.md`)).toBe(`${home}2/proj/AGENTS.md`);
  expect(tilde(`${home}x/a`)).toBe(`${home}x/a`);
});

const SEPARATOR = "---";
const paneOrder = (p: Page, expected: string[], width = 80) => {
  const all = p.rows(width), start = all.findIndex((row) => /^\s*名称 +来源/u.test(rightParts([row])[0]!));
  const end = all.findIndex((row, index) => index > start && (/^─+$/u.test(row) || row.includes("┴")));
  return rightParts(all.slice(start + 1, end))
    .map((line) => (/^ {3}─+$/u.test(line) ? SEPARATOR : /^\s*[▸▾]?\s*\S+\s+(用户|项目|内置)\s/u.test(line) ? firstWord(line)! : undefined))
    .filter((name) => name !== undefined)
    .map((name) => (name.endsWith("…") ? expected.find((full) => full.startsWith(name.slice(0, -1))) ?? name : name));
};
const REVIEWER_ORDER = ["reviewer", SEPARATOR, "go-reviewer", "java-reviewer", "node-reviewer", "python-reviewer", "react-reviewer", "vue-reviewer"];
const WORKER_ORDER = ["worker", SEPARATOR, "my-worker", "ui-worker", "go-worker", "java-worker", "node-worker", "python-worker", "react-worker", "vue-worker"];
const separatorLines = (p: Page, width: number) => p.lines(width).filter((line) => /^ {3}─+$/u.test(plain(line).slice(plain(line).includes("│") ? plain(line).indexOf("│") + 1 : 0).trimEnd()));

test("通用定义排第一行：用户层有 my-worker 时 worker 第一，下面一条分隔线，其他定义用户层在前、内置在后、同类按名字排", async () => {
  const p = await page({ myWorker: true });
  p.press(RIGHT);
  expect(paneOrder(p, WORKER_ORDER)).toEqual(WORKER_ORDER);
  expect(rowOf(p, "worker")).toContain("内置");
});

test("通用定义排第一行：用户层的 worker.md 覆盖内置 worker 后第一行仍是 worker，来源写用户，且内置 worker 不再重复列出", async () => {
  const p = await page({ userWorker: true });
  p.press(RIGHT);
  expect(paneOrder(p, WORKER_ORDER)).toEqual(["worker", SEPARATOR, "ui-worker", "go-worker", "java-worker", "node-worker", "python-worker", "react-worker", "vue-worker"]);
  expect(rowOf(p, "worker")).toContain("用户");
  expect(rowOf(p, "worker")).not.toContain("内置");
});

test("通用定义排第一行：项目层的 reviewer 覆盖内置后仍在第一行，来源写项目，专项 reviewer 在分隔线下", async () => {
  const p = await page();
  p.press(DOWN, RIGHT);
  expect(paneOrder(p, REVIEWER_ORDER)).toEqual(["reviewer", SEPARATOR, "go-reviewer", "java-reviewer", "node-reviewer", "python-reviewer", "react-reviewer", "vue-reviewer"]);
  expect(rowOf(p, "reviewer")).toContain("项目");
});

test("分区里只有通用定义时不画分隔线：qa、explore、prototype 各只有一行", async () => {
  for (const [section, name] of [["qa", "qa"], ["explore", "explore"], ["prototype", "prototype"]] as const) {
    const p = await page();
    enterSection(p, section);
    expect(paneOrder(p, [name]), section).toEqual([name]);
    expect(p.rows().filter((row) => /^ {3}─+$/u.test(row.slice(row.indexOf("│") + 1).trimEnd())), section).toEqual([]);
  }
});

test("分隔线：前面 3 列空白，后面灰色（dim）的 ─ 画到右栏最右边", async () => {
  const p = await page({ myWorker: true });
  p.press(RIGHT);
  const lines = separatorLines(p, 80);
  expect(lines).toHaveLength(1);
  const rightSide = lines[0]!.slice(lines[0]!.indexOf("│") + 1);
  expect(plain(rightSide)).toBe(`   ${"─".repeat(59 - 3)}`);
  expect(rightSide).toContain(`<dim>${"─".repeat(59 - 3)}</>`);
  expect(plain(rightSide).slice(0, 3)).toBe("   ");
});

test("分隔线不可选：光标在 worker 按 ↓ 到 my-worker，再按 ↑ 回 worker；一路 ↓ 到底依次经过每个定义行且不在分隔线上停留", async () => {
  const p = await page({ myWorker: true });
  p.press(RIGHT);
  const selected = () => firstWord(selectedPaneLine(p));
  expect(selected()).toBe("worker");
  p.press(DOWN);
  expect(selected()).toBe("my-worker");
  p.press(UP);
  expect(selected()).toBe("worker");
  const walked = [selected()];
  for (let i = 0; i < 12; i++) { p.press(DOWN); walked.push(selected()); }
  expect(walked.slice(0, 9)).toEqual(WORKER_ORDER.filter((name) => name !== SEPARATOR));
  expect(walked.slice(8).every((name) => name === "vue-worker")).toBe(true);
  for (let i = 0; i < 12; i++) p.press(UP);
  expect(selected()).toBe("worker");
});

test("回车、空格、C 只作用在定义行：分隔线上方的 worker 与下方的 my-worker 各自操作自己", async () => {
  const p = await page({ myWorker: true });
  p.press(RIGHT, DOWN, SPACE);
  expect(p.toggles).toEqual(["my-worker"]);
  p.press(UP, SPACE);
  expect(p.toggles).toEqual(["my-worker"]);
  expect(squeeze(p.text())).toContain(squeeze("worker 是通用定义，流程离不开它，不能关闭"));
  p.press(DOWN, "C", "x", ENTER);
  expect(p.copies).toEqual([{ name: "my-worker-copyx", entry: "my-worker" }]);
});

test("通用定义展开详情时，详情在 worker 行和分隔线之间；收起后分隔线紧跟 worker 行", async () => {
  const p = await page({ myWorker: true });
  p.press(RIGHT, ENTER);
  const right = rightParts(p.rows());
  const worker = right.findIndex((line) => /^\s*▾\s+worker\b/u.test(line)), separator = right.findIndex((line) => /^ {3}─+$/u.test(line));
  const description = right.findIndex((line) => line.includes("说明"));
  expect(worker).toBeGreaterThan(-1);
  expect(description).toBeGreaterThan(worker);
  expect(separator).toBeGreaterThan(description);
  expect(right.findIndex((line) => line.includes("文件"))).toBeLessThan(separator);
  expect(right.slice(separator + 1).find((line) => line.trim() !== "")).toMatch(/my-worker/u);
  p.press(ENTER);
  const collapsed = rightParts(p.rows());
  expect(collapsed.findIndex((line) => /^ {3}─+$/u.test(line))).toBe(collapsed.findIndex((line) => /^\s*▸\s+worker\b/u.test(line)) + 1);
});

test("目录里每个分区的数字是定义个数，不算分隔线：worker 有 my-worker 时是 9，只有通用定义的 qa 仍是 1", async () => {
  const p = await page({ myWorker: true });
  expect(navCells(p.rows())).toEqual(expect.arrayContaining(["▸ worker 9", "reviewer 7", "qa 1"]));
  expect(p.text()).toContain("worker：写代码 · 9 份定义（用户 2 · 内置 7）");
});

test("窄终端 36、44 列只显示右栏：分隔线不超过终端宽度，前 3 列空白、─ 画到终端最右边", async () => {
  for (const width of [36, 44]) {
    const p = await page({ myWorker: true });
    p.press(RIGHT);
    const rows = p.rows(width);
    for (const row of rows) expect(visibleWidth(row), `${width} 列：${row}`).toBeLessThanOrEqual(width);
    expect(rows.filter((row) => row === `   ${"─".repeat(width - 3)}`), `${width} 列`).toHaveLength(1);
    expect(separatorLines(p, width)[0], `${width} 列`).toContain(`<dim>${"─".repeat(width - 3)}</>`);
    expect(paneOrder(p, WORKER_ORDER, width), `${width} 列`).toEqual(WORKER_ORDER);
  }
});

test("宽终端 60、80 列左右并排：分隔线画到右栏最右边，每行不超过终端宽度，页面高度够，最后一行定义不被截掉", async () => {
  for (const width of [60, 80]) {
    const p = await page({ myWorker: true });
    const rows = p.rows(width);
    for (const row of rows) expect(visibleWidth(row), `${width} 列：${row}`).toBeLessThanOrEqual(width);
    const paneWidth = width - 21;
    expect(rightParts(rows).filter((line) => line === `   ${"─".repeat(paneWidth - 3)}`), `${width} 列`).toHaveLength(1);
    expect(paneOrder(p, WORKER_ORDER, width), `${width} 列`).toEqual(WORKER_ORDER);
    const last = rows.findIndex((row) => row.includes("vue-w")), bottom = rows.findIndex((row) => row.includes("┴"));
    expect(last, `${width} 列`).toBeGreaterThan(-1);
    expect(bottom, `${width} 列`).toBeGreaterThan(last);
  }
});

test("用户层既覆盖 worker 又有 my-worker 时：worker 来源是用户且第一，my-worker 在分隔线下的用户层里排前面", async () => {
  const p = await page({ myWorker: true, userWorker: true });
  p.press(RIGHT);
  expect(paneOrder(p, WORKER_ORDER)).toEqual(["worker", SEPARATOR, "my-worker", "ui-worker", "go-worker", "java-worker", "node-worker", "python-worker", "react-worker", "vue-worker"]);
  expect(rowOf(p, "worker")).toContain("用户");
});
