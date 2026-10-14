import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentCatalogView } from "../runtime/agent-catalog-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../runtime/agent-copy.ts";
import { readAgentSettings } from "../runtime/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "agent-ui-")); roots.push(root);
  return { root, defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p") };
}
const RIGHT = "\x1b[C", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

const BACKSPACE = "\x7f";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bg: (kind: string, text: string) => `[${kind}]${text}[/]`,
  bold: (text: string) => `**${text}**`, inverse: (text: string) => `!${text}!` };
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\[\/?[a-zA-Z]*\]|\*\*|!/gu, "");

async function page(options: { trusted?: boolean; state?: ConstructorParameters<typeof AgentCatalogView>[0]["state"]; taken?: Record<string, string>; skills?: string } = {}) {
  const d = await dirs();
  const role = async (dir: string, name: string, frontmatter: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n正文\n`);
  };
  await role(d.userDir, "ui-worker", `description: 界面设计与实现，产出 HTML 预览\nrole: worker\nmodel: 5x/gpt-6-luna\nthinking: medium\nskills: [${options.skills ?? "ui-basics"}]`);
  await role(d.userDir, "broken", "description: 坏\nrole: worker\nthinking: extreme");
  await role(d.projectDir, "reviewer", "description: 本项目的审查\nrole: reviewer\nmodel: 5x/gpt-6-sol\nthinking: high");
  const trusted = options.trusted ?? true;
  const { root: _root, ...roleDirs } = d;
  const catalog = await loadRoleCatalog({ ...roleDirs, parseFrontmatter, projectTrusted: trusted });
  const settings = await readAgentSettings({ agentDir: join(d.root, "agent"), repositoryRoot: join(d.root, "repo"), projectTrusted: trusted });
  const copies: Array<{ name: string; entry: string }> = []; let closed = false;
  const view = new AgentCatalogView({ catalog, theme, projectTrusted: trusted, untrustedProjectCount: 1, settings, models: [], mainModel: undefined, mainThinking: "high", onSaveSetting() {}, onClearSetting() {}, ...(options.state ? { state: options.state } : {}),
    nameTaken: (name) => options.taken?.[name], onCopy: (request) => copies.push({ name: request.name, entry: request.entry.name }), onClose: () => { closed = true; } });
  const lines = (width = 80) => view.render(width);
  const text = (width = 80) => plain(lines(width).join("\n"));
  const press = (...keys: string[]) => { for (const key of keys) view.handleInput(key); };
  return { view, lines, text, press, copies, closed: () => closed };
}

test("打开时停在 worker，标题写各层数量，分类标签带数量且设定与问题靠右，表格与底部两行按预览", async () => {
  const p = await page();
  const lines = p.lines().map(plain);
  expect(p.lines()[0]).toBe(`<border>${"─".repeat(80)}</>`);
  expect(p.lines().at(-1)).toBe(`<border>${"─".repeat(80)}</>`);
  expect(lines[1]).toMatch(/^ 角色定义 +内置 5 · 用户 1 · 项目 1 $/u);
  expect(lines[2]).toMatch(/^ {2}worker 2 {3}reviewer 1 {3}qa 1 {3}explore 1 {3}prototype 1 +│ {2}设定 3 {3}问题 1 $/u);
  expect(p.lines()[2]).toContain("[selectedBg]<accent>** worker 2 **</>[/]");
  expect(p.lines()[2]).toContain("<error> 问题 1 </>");
  expect(lines[2]).toHaveLength(80 - 4);
  expect(lines[4]).toMatch(/^ {3}名称 +来源 +模型 +思考/u);
  expect(lines[5]).toMatch(/^ › ui-worker +用户 +5x\/gpt-6-luna +medium *$/u);
  expect(p.text()).not.toMatch(/\bpm\b/u);
  expect(p.lines()[5].startsWith("[selectedBg]")).toBe(true);
  expect(p.text()).toContain("C 复制");
  expect(p.text()).not.toContain("只能同名");
});

test("M8D-AC8：同一职责下用户层与项目层排在内置前面，底部说明随选中行变化，被盖住的下层不再列出", async () => {
  const p = await page();
  expect(p.text()).toMatch(/› ui-worker +用户 +5x\/gpt-6-luna +medium *\n +worker +内置 +跟随主会话 +跟随 *\n/u);
  expect(p.lines().join("\n")).toContain("!<accent> 用户 </>!");
  expect(p.lines().join("\n")).toContain("<accent>5x/gpt-6-luna</>");
  expect(p.text()).toContain("界面设计与实现，产出 HTML 预览 · skills ui-basics");
  p.press(DOWN);
  expect(p.text()).toMatch(/› worker +内置/u);
  p.press(RIGHT);
  expect(p.text()).toMatch(/› reviewer +项目 +5x\/gpt-6-sol +high/u);
  expect(p.text().match(/reviewer +(内置|项目)/gu)).toHaveLength(1);
});

test("prototype 栏排在 explore 之后、设定之前，内置行跟随主会话，栏底写说明，C 复制的定义归在这一栏", async () => {
  const p = await page();
  p.press(RIGHT, RIGHT, RIGHT, RIGHT);
  expect(p.text()).toMatch(/› prototype +内置 +跟随主会话 +跟随 *\n/u);
  expect(p.text()).toContain("只能由主窗口派出，在澄清阶段出界面原型（单个 HTML）。");
  p.press(RIGHT);
  expect(p.text()).toMatch(/设定/u);
  expect(p.text()).toMatch(/名称/u);
  const d = await dirs();
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  const proto = catalog.roles.find((entry) => entry.name === "prototype")!;
  await copyAgentDefinition({ entry: proto, newName: "proto-copy", targetDir: d.userDir, layerDirs: [d.defaultDir, d.userDir, d.projectDir] });
  const reloaded = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "proto-copy")).toMatchObject({ source: "user", available: true, definition: { role: "prototype" } });
});

test("没写模型和思考的定义，模型列写“跟随主会话”、思考列写“跟随”，不再写“继承”", async () => {
  const p = await page();
  p.press(RIGHT, RIGHT);
  expect(p.text()).toMatch(/› qa +内置 +跟随主会话 +跟随 *\n/u);
  p.press(RIGHT);
  expect(p.text()).toMatch(/› explore +内置 +跟随主会话 +跟随 *\n/u);
  expect(p.text()).not.toContain("继承");
  expect(p.lines().join("\n")).toContain("<dim>跟随主会话</>");
});

test("M8D-AC8：问题分类写短原因，展开写完整原因、现在的写法与影响；项目未受信任用灰色另列一行", async () => {
  const p = await page();
  p.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
  expect(p.text()).toMatch(/文件 +层 +原因\n › broken\.md +用户 +thinking 写错了/u);
  expect(p.lines().join("\n")).toContain("<error>thinking 写错了</>");
  expect(p.text()).toContain("这份定义没有生效 · 改正文件后重新打开本页");
  expect(p.text()).not.toContain("C 复制");
  p.press(ENTER);
  expect(p.text()).toMatch(/┊ 原因 +thinking 只能是 off、minimal、low、medium、high、xhigh、max/u);
  expect(p.text()).toMatch(/┊ 现在是 +extreme/u);
  expect(p.text()).toMatch(/┊ 影响 +这份定义没有生效/u);
  const u = await page({ trusted: false });
  expect(plain(u.lines()[1])).toMatch(/内置 5 · 用户 1 $/u);
  for (let i = 0; i < 6; i++) u.press(RIGHT);
  expect(u.text()).toContain("问题 2");
  expect(u.text()).toMatch(/› \.pi\/agents\/ +项目 +项目未受信任，项目层的定义和设定没有生效/u);
  expect(u.text()).toContain("在 pi 里把这个项目设为受信任后，项目层的 1 份定义就会生效");
});

test("旧的 role 为 pm 或内部角色的定义文件在问题栏各占一行并写明已不再使用、请在设定栏修改", async () => {
  const d = await dirs();
  for (const name of ["pm", "interpreter", "draft-verifier"]) {
    await mkdir(d.userDir, { recursive: true });
    await writeFile(join(d.userDir, `${name}.md`), `---\nname: ${name}\ndescription: 旧定义\nrole: ${name}\nmodel: 5x/gpt-6-luna\n---\n正文\n`);
  }
  const catalog = await loadRoleCatalog({ defaultDir: d.defaultDir, userDir: d.userDir, projectDir: d.projectDir, parseFrontmatter, projectTrusted: true });
  const settings = await readAgentSettings({ agentDir: join(d.root, "agent"), repositoryRoot: join(d.root, "repo"), projectTrusted: true });
  const view = new AgentCatalogView({ catalog, theme, projectTrusted: true, untrustedProjectCount: 0, settings, models: [], mainModel: undefined, mainThinking: "high",
    onSaveSetting() {}, onClearSetting() {}, nameTaken: () => undefined, onCopy() {}, onClose() {} });
  const text = () => plain(view.render(200).join("\n"));
  for (let i = 0; i < 10 && !/文件 +层 +原因/u.test(text()); i++) view.handleInput(RIGHT);
  for (const prefix of ["pm.md", "interpreter.md", "draft-verifie"]) expect(text()).toContain(prefix);
  expect(text().match(/已不再使用定义文件，请在设定栏修改/gu)).toHaveLength(3);
});

test("M8D-AC8：复制在页内输入新名称，格式不对或重名当场拦下；Esc 取消回到列表并提示，下一次按键后提示消失", async () => {
  const p = await page({ taken: { "ui-worker": "用户层" } });
  p.press(DOWN, "c");
  expect(p.text()).toMatch(/复制 worker 为新定义\n\n 新名称 +worker-copy█\n 小写字母、数字、连字符，最多 64 个字符；三层里不能重名/u);
  expect(p.lines()[0]).toBe(`<border>${"─".repeat(80)}</>`);
  expect(p.lines().at(-1)).toBe(`<border>${"─".repeat(80)}</>`);
  for (let i = 0; i < 11; i++) p.press(BACKSPACE);
  p.press(..."ui-worker".split(""), ENTER);
  expect(p.text()).toContain("✗ 用户层已经有 ui-worker，换一个名字");
  for (let i = 0; i < 9; i++) p.press(BACKSPACE);
  p.press("U", "I", ENTER);
  expect(p.text()).toContain("✗ 只能用小写字母、数字和连字符，例如 ui-worker");
  p.press(BACKSPACE, BACKSPACE, ..."api-worker".split(""), ENTER);
  expect(p.copies).toEqual([{ name: "api-worker", entry: "worker" }]);
  const cancel = await page();
  cancel.press("c", ESC);
  expect(cancel.text()).toContain("已取消复制");
  cancel.press(DOWN);
  expect(cancel.text()).not.toContain("已取消复制");
});

test("M8D-AC8：复制后回到原分类，新定义被选中且名字绿色，底部显示成功提示", async () => {
  const p = await page({ state: { tab: "worker", selectName: "ui-worker", fresh: "ui-worker", notice: { tone: "ok", text: "✓ 已复制到 ~/.pi/agent/agents/ui-worker.md，打开它写专长、skills 和 mcp" } } });
  expect(p.text()).toMatch(/› ui-worker +用户/u);
  expect(p.lines().join("\n")).toContain("<success>ui-worker</>");
  expect(p.lines().join("\n")).toContain("<success>✓ 已复制到 ~/.pi/agent/agents/ui-worker.md，打开它写专长、skills 和 mcp</>");
  p.press(DOWN);
  expect(p.text()).not.toContain("已复制到");
});

test("M8D-AC8：窄终端只在放不下时才省：左边职责只给选中的显示数量，设定与问题照带数量，更窄时才截断模型名末尾", async () => {
  const p = await page();
  const lines = p.lines(56).map(plain);
  expect(lines[1]).toMatch(/内置 5 · 用户 1 · 项目 1 $/u);
  expect(lines[2]).toMatch(/^ {2}worker 2 {3}reviewer .*│ {2}设定 3 {3}问题 1 $/u);
  expect(lines[2]).not.toContain("reviewer 1");
  expect(lines.join("\n")).toMatch(/ui-worker +用户 +5x\/gpt-6-luna +medium/u);
  const tight = p.lines(44).map(plain);
  expect(tight.find((line) => line.includes("ui-worker"))).toMatch(/5x\/gpt-\S*…/u);
  for (const line of tight) expect(line.length).toBeLessThanOrEqual(44);
  expect(lines.join("\n")).toContain("界面设计与实现，产出 HTML 预览 · skills ui-basics");
  expect(lines.join("\n")).toContain("←→ 分类  ↑↓ 选择  回车 详情  C 复制  Esc 退出");
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(56);
});

test("复制：新名称三层不重复，复制后 name 字段改为新名称", async () => {
  const d = await dirs();
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!;
  const layerDirs = [d.defaultDir, d.userDir, d.projectDir];
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.projectDir, layerDirs });
  expect(await readFile(target, "utf8")).toMatch(/^name: ui-dev$/mu);
  await expect(copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.userDir, layerDirs })).rejects.toBeInstanceOf(AgentCopyError);
  await expect(copyAgentDefinition({ entry: worker, newName: "reviewer", targetDir: d.userDir, layerDirs })).rejects.toThrow("已被使用");
  await expect(copyAgentDefinition({ entry: worker, newName: "Bad Name", targetDir: d.userDir, layerDirs })).rejects.toThrow("名称只能");
  const reloaded = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "ui-dev")).toMatchObject({ source: "project", available: true });
});

test("复制内置 worker 生成的文件头部不含 model 和 thinking，仍有 skills 与 mcp 空数组", async () => {
  const d = await dirs();
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!;
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.userDir, layerDirs: [d.defaultDir, d.userDir, d.projectDir] });
  const head = (await readFile(target, "utf8")).split(/^---$/mu)[1]!;
  expect(head).not.toMatch(/^model:/mu);
  expect(head).not.toMatch(/^thinking:/mu);
  expect(head).toMatch(/^skills: \[\]$/mu);
  expect(head).toMatch(/^mcp: \[\]$/mu);
});

test("M8D-AC8：44、56、80 列下每个分类的列表、详情与命名画面，任何一行的显示宽度都不超过终端宽度", async () => {
  for (const width of [44, 56, 80]) {
    for (let tab = 0; tab < 7; tab++) {
      for (const keys of [[], [ENTER], ["c"]]) {
        const q = await page({ trusted: tab % 2 === 0 });
        q.press(...Array<string>(tab).fill(RIGHT), ...keys);
        for (const line of q.lines(width)) expect(visibleWidth(plain(line)), plain(line)).toBeLessThanOrEqual(width);
      }
    }
  }
});

const NOTICE = "✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp";
const squeeze = (text: string) => text.replace(/\s+/gu, "");
const hintRowsOf = (rows: string[], groups: string[]) => rows.map((row) => row.trim()).filter((row) => row && row.split("  ").every((group) => groups.includes(group)));

test("底部提示放不下时折成多行，整句每个字都看得到，不再以…截掉；放得下时仍只占一行", async () => {
  const wide = await page({ state: { notice: { tone: "ok", text: NOTICE } } });
  const baseline = await page({ state: { notice: { tone: "ok", text: "✓ 短" } } });
  expect(wide.lines(200)).toHaveLength(baseline.lines(200).length);
  expect(wide.lines(80).length).toBe(baseline.lines(80).length + (visibleWidth(NOTICE) + 1 > 80 ? 1 : 0));
  for (const tone of ["ok", "muted"] as const) {
    for (let width = 36; width <= 80; width++) {
      const p = await page({ state: { notice: { tone, text: NOTICE } } });
      const rows = p.lines(width).map(plain);
      expect(squeeze(rows.join("")), `${width}`).toContain(squeeze(NOTICE));
      for (const row of p.lines(width).map(plain)) expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
    }
  }
  const narrow = await page({ state: { notice: { tone: "ok", text: NOTICE } } });
  const short = await page({ state: { notice: { tone: "ok", text: "✓ 短" } } });
  expect(narrow.lines(36).length).toBeGreaterThan(short.lines(36).length);
});

test("设定栏的底部提示放不下时同样折行，整句都看得到", async () => {
  const text = "✓ PM 改为 5x/gpt-6-luna · xhigh，存到项目层，下次启动 PM 时生效";
  for (let width = 36; width <= 80; width++) {
    const p = await page({ state: { tab: "设定", notice: { tone: "ok", text } } });
    expect(squeeze(p.lines(width).map(plain).join("")), `${width}`).toContain(squeeze(text));
    for (const row of p.lines(width).map(plain)) expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
  }
});

test("底部提示折行时尽量在空格后断开，每个词完整地留在一行里", async () => {
  const words = ["alpha-one", "beta-two", "gamma-three", "delta-four", "epsilon-five", "zeta-six"];
  const p = await page({ state: { notice: { tone: "muted", text: words.join(" ") } } });
  const rows = p.lines(36).map(plain);
  for (const word of words) expect(rows.some((row) => row.includes(word)), word).toBe(true);
});

test("按键提示放不下时按一组按键折行，一组不被拆开，放得下时仍是一行", async () => {
  const screens: Array<{ hint: string; keys: string[]; open?: (p: Awaited<ReturnType<typeof page>>) => void }> = [
    { hint: "←→ 分类  ↑↓ 选择  回车 详情  C 复制  Esc 退出", keys: [] },
    { hint: "回车 收起  C 复制  Esc 收起", keys: [ENTER] },
    { hint: "←→ 分类  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出", keys: [RIGHT, RIGHT, RIGHT, RIGHT] },
    { hint: "←→ 分类  ↑↓ 选择  回车 详情  Esc 退出", keys: [RIGHT, RIGHT, RIGHT, RIGHT, RIGHT] },
    { hint: "回车 收起  Esc 收起", keys: [RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, ENTER] },
    { hint: "回车 下一步  Esc 取消", keys: ["c"] },
  ];
  for (const { hint, keys } of screens) {
    const groups = hint.split("  ");
    for (let width = 36; width <= 80; width++) {
      const p = await page();
      p.press(...keys);
      const rows = p.lines(width).map(plain);
      for (const row of rows) expect(visibleWidth(row), `${hint} ${width}: ${row}`).toBeLessThanOrEqual(width);
      const hintRows = hintRowsOf(rows, groups);
      expect(hintRows.flatMap((row) => row.split("  ")), `${hint} ${width}`).toEqual(groups);
      if (visibleWidth(` ${hint}`) <= width) expect(hintRows, `${hint} ${width}`).toHaveLength(1);
      else expect(hintRows.length, `${hint} ${width}`).toBeGreaterThan(1);
    }
  }
});

test("复制命名画面的红字错误放不下时折成多行，36 到 80 列每一行都不超宽，各行拼起来是完整的错误原文", async () => {
  const longName = "a".repeat(60);
  const cases: Array<{ error: string; type: string[] }> = [
    { error: "✗ 只能用小写字母、数字和连字符，例如 ui-worker", type: ["U", "I"] },
    { error: `✗ 用户层已经有 ${longName}，换一个名字`, type: [...longName] },
  ];
  for (const { error, type } of cases) {
    for (let width = 36; width <= 80; width++) {
      const p = await page({ taken: { [longName]: "用户层" } });
      p.press("c", ...Array<string>("ui-worker-copy".length).fill(BACKSPACE), ...type, ENTER);
      const rows = p.lines(width).map(plain);
      for (const row of rows) expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
      expect(squeeze(rows.join("")), `${width}`).toContain(squeeze(error));
    }
  }
});

const footerRows = (rows: string[]) => {
  const start = rows.findIndex((row) => row.startsWith(" ✓ "));
  const end = rows.findIndex((row, index) => index > start && row.trimStart().startsWith("←→"));
  return rows.slice(start, end).map((row) => row.slice(1).trimEnd());
};

test("复制完成提示折行：在最后一个空格、中文逗号或斜杠之后断开，与确认过的预览一致", async () => {
  const show = async (width: number, text: string) => footerRows((await page({ state: { notice: { tone: "ok", text } } })).lines(width).map(plain));
  expect(await show(36, NOTICE)).toEqual(["✓ 已复制到 ~/.pi/agent/agents/", "vue-engineer.md，", "打开它写专长、skills 和 mcp"]);
  expect(await show(80, "✓ 已复制到 ~/Projects/some-company/frontend-app/.pi/agents/vue-engineer.md，打开它写专长、skills 和 mcp"))
    .toEqual(["✓ 已复制到 ~/Projects/some-company/frontend-app/.pi/agents/vue-engineer.md，", "打开它写专长、skills 和 mcp"]);
  expect(await show(80, "✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp")).toEqual(["✓ 已复制到 ~/.pi/agent/agents/vue-engineer.md，打开它写专长、skills 和 mcp"]);
});

test("展开详情里用顿号隔开的列表值放不下时在顿号之后断开，名字不被拆开", async () => {
  const skills = ["ui-basics", "very-long-skill-name-number-one", "another-skill"];
  for (const width of [36, 40, 48, 64]) {
    const p = await page({ skills: skills.join(", ") });
    p.press(ENTER);
    const rows = p.lines(width).map(plain).filter((line) => line.includes("┊")).map((line) => line.replace(/^.*┊/u, "").trim());
    expect(rows.some((row) => row.includes("ui-basics")), `${width} ui-basics: ${rows.join("|")}`).toBe(true);
    expect(rows.some((row) => row.includes("another-skill")), `${width} another-skill: ${rows.join("|")}`).toBe(true);
  }
});
