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

async function page(options: { trusted?: boolean; state?: ConstructorParameters<typeof AgentCatalogView>[0]["state"]; taken?: Record<string, string> } = {}) {
  const d = await dirs();
  const role = async (dir: string, name: string, frontmatter: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n正文\n`);
  };
  await role(d.userDir, "ui-worker", "description: 界面设计与实现，产出 HTML 预览\nrole: worker\nmodel: 5x/gpt-6-luna\nthinking: medium\nskills: [ui-basics]");
  await role(d.userDir, "interpreter", "description: 把你的原话解读成结构化的决定\nrole: interpreter\nmodel: 5x/gpt-6-luna\nthinking: off");
  await role(d.userDir, "broken", "description: 坏\nrole: worker\nthinking: extreme");
  await role(d.projectDir, "reviewer", "description: 本项目的审查\nrole: reviewer\nmodel: 5x/gpt-6-sol\nthinking: high");
  const trusted = options.trusted ?? true;
  const { root: _root, ...roleDirs } = d;
  const catalog = await loadRoleCatalog({ ...roleDirs, parseFrontmatter, projectTrusted: trusted });
  const settings = await readAgentSettings({ agentDir: join(d.root, "agent"), repositoryRoot: join(d.root, "repo"), projectTrusted: trusted });
  const copies: Array<{ name: string; entry: string }> = []; let closed = false;
  const view = new AgentCatalogView({ catalog, theme, projectTrusted: trusted, untrustedProjectCount: 1, settings, models: [], mainModel: undefined, onSaveSetting() {}, onClearSetting() {}, ...(options.state ? { state: options.state } : {}),
    nameTaken: (name) => options.taken?.[name], onCopy: (request) => copies.push({ name: request.name, entry: request.entry.name }), onClose: () => { closed = true; } });
  const lines = (width = 80) => view.render(width);
  const text = (width = 80) => plain(lines(width).join("\n"));
  const press = (...keys: string[]) => { for (const key of keys) view.handleInput(key); };
  return { view, lines, text, press, copies, closed: () => closed };
}

test("M8D-AC8：打开时停在 pm，标题写各层数量，分类标签带数量且设定与问题靠右，表格与底部两行按预览", async () => {
  const p = await page();
  const lines = p.lines().map(plain);
  expect(p.lines()[0]).toBe(`<border>${"─".repeat(80)}</>`);
  expect(p.lines().at(-1)).toBe(`<border>${"─".repeat(80)}</>`);
  expect(lines[1]).toMatch(/^ 角色定义 +内置 7 · 用户 2 · 项目 1 $/u);
  expect(lines[2]).toMatch(/^ {2}pm 1 {3}worker 2 {3}reviewer 1 {3}qa 1 {3}explore 1 +│ {2}设定 3 {3}问题 1 $/u);
  expect(p.lines()[2]).toContain("[selectedBg]<accent>** pm 1 **</>[/]");
  expect(p.lines()[2]).toContain("<error> 问题 1 </>");
  expect(lines[2]).toHaveLength(80 - 4);
  expect(lines[4]).toMatch(/^ {3}名称 +来源 +模型 +思考/u);
  expect(lines[5]).toMatch(/^ › pm +内置 +gpt-6\.1-sol +high *$/u);
  expect(p.lines()[5].startsWith("[selectedBg]")).toBe(true);
  expect(p.text()).toContain("C 复制（只能同名）");
});

test("M8D-AC8：同一职责下用户层与项目层排在内置前面，底部说明随选中行变化，被盖住的下层不再列出", async () => {
  const p = await page();
  p.press(RIGHT);
  expect(p.text()).toMatch(/› ui-worker +用户 +5x\/gpt-6-luna +medium *\n +worker +内置 +gpt-6\.1-sol +high/u);
  expect(p.lines().join("\n")).toContain("!<accent> 用户 </>!");
  expect(p.lines().join("\n")).toContain("<accent>5x/gpt-6-luna</>");
  expect(p.text()).toContain("界面设计与实现，产出 HTML 预览 · skills ui-basics");
  p.press(DOWN);
  expect(p.text()).toMatch(/› worker +内置/u);
  p.press(RIGHT);
  expect(p.text()).toMatch(/› reviewer +项目 +5x\/gpt-6-sol +high/u);
  expect(p.text().match(/reviewer +(内置|项目)/gu)).toHaveLength(1);
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
  expect(plain(u.lines()[1])).toMatch(/内置 7 · 用户 2 $/u);
  for (let i = 0; i < 6; i++) u.press(RIGHT);
  expect(u.text()).toContain("问题 2");
  expect(u.text()).toMatch(/› \.pi\/agents\/ +项目 +项目未受信任，项目层的定义和设定没有生效/u);
  expect(u.text()).toContain("在 pi 里把这个项目设为受信任后，项目层的 1 份定义就会生效");
});

test("M8D-AC8：复制在页内输入新名称，格式不对或重名当场拦下；Esc 取消回到列表并提示，下一次按键后提示消失", async () => {
  const p = await page({ taken: { "ui-worker": "用户层" } });
  p.press(RIGHT, DOWN, "c");
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
  cancel.press(RIGHT, "c", ESC);
  expect(cancel.text()).toContain("已取消复制");
  cancel.press(DOWN);
  expect(cancel.text()).not.toContain("已取消复制");
});

test("M8D-AC8：pm 复制时名称锁定，打字无效，回车即按原名复制", async () => {
  const pm = await page();
  pm.press("c");
  expect(pm.text()).toMatch(/复制 pm\n\n 名称 +pm {2}（只能同名，不能改）/u);
  pm.press("x", ENTER);
  expect(pm.copies).toEqual([{ name: "pm", entry: "pm" }]);
});

test("M8D-AC8：复制后回到原分类，新定义被选中且名字绿色，底部显示成功提示", async () => {
  const p = await page({ state: { tab: "worker", selectName: "ui-worker", fresh: "ui-worker", notice: { tone: "ok", text: "✓ 已复制到 ~/.pi/agent/agents/ui-worker.md，请直接编辑这个文件" } } });
  expect(p.text()).toMatch(/› ui-worker +用户/u);
  expect(p.lines().join("\n")).toContain("<success>ui-worker</>");
  expect(p.lines().join("\n")).toContain("<success>✓ 已复制到 ~/.pi/agent/agents/ui-worker.md，请直接编辑这个文件</>");
  p.press(DOWN);
  expect(p.text()).not.toContain("已复制到");
});

test("M8D-AC8：窄终端只在放不下时才省：左边职责只给选中的显示数量，设定与问题照带数量，更窄时才截断模型名末尾", async () => {
  const p = await page();
  p.press(RIGHT);
  const lines = p.lines(56).map(plain);
  expect(lines[1]).toMatch(/内置 7 · 用户 2 · 项目 1 $/u);
  expect(lines[2]).toMatch(/^ {2}pm {3}worker 2 {3}reviewer .*│ {2}设定 3 {3}问题 1 $/u);
  expect(lines[2]).not.toContain("pm 1");
  expect(lines.join("\n")).toMatch(/ui-worker +用户 +5x\/gpt-6-luna +medium/u);
  const tight = p.lines(44).map(plain);
  expect(tight.find((line) => line.includes("ui-worker"))).toMatch(/5x\/gpt-\S*…/u);
  for (const line of tight) expect(line.length).toBeLessThanOrEqual(44);
  expect(lines.join("\n")).toContain("界面设计与实现，产出 HTML 预览 · skills ui-basics");
  expect(lines.join("\n")).toContain("←→ 分类  ↑↓ 选择  回车 详情  C 复制  Esc 退出");
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(56);
});

test("复制：新名称三层不重复，pm 只能同名复制到尚无 pm 的层，复制后 name 字段改为新名称", async () => {
  const d = await dirs();
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!, pm = catalog.roles.find((entry) => entry.name === "pm")!;
  const layerDirs = [d.defaultDir, d.userDir, d.projectDir];
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.projectDir, layerDirs });
  expect(await readFile(target, "utf8")).toMatch(/^name: ui-dev$/mu);
  await expect(copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.userDir, layerDirs })).rejects.toBeInstanceOf(AgentCopyError);
  await expect(copyAgentDefinition({ entry: worker, newName: "reviewer", targetDir: d.userDir, layerDirs })).rejects.toThrow("已被使用");
  await expect(copyAgentDefinition({ entry: worker, newName: "Bad Name", targetDir: d.userDir, layerDirs })).rejects.toThrow("名称只能");
  await expect(copyAgentDefinition({ entry: pm, newName: "boss", targetDir: d.userDir, layerDirs })).rejects.toThrow("pm 只能同名复制");
  const interpreter = catalog.roles.find((entry) => entry.name === "interpreter")!;
  await expect(copyAgentDefinition({ entry: interpreter, newName: "fast", targetDir: d.userDir, layerDirs })).rejects.toThrow("interpreter 只能同名复制");
  expect(await readFile(await copyAgentDefinition({ entry: interpreter, newName: "interpreter", targetDir: d.userDir, layerDirs }), "utf8")).toMatch(/^role: interpreter$/mu);
  await copyAgentDefinition({ entry: pm, newName: "pm", targetDir: d.userDir, layerDirs });
  await expect(copyAgentDefinition({ entry: pm, newName: "pm", targetDir: d.userDir, layerDirs })).rejects.toThrow("已被使用");
  const reloaded = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "pm")).toMatchObject({ source: "user", overrides: ["default"] });
  expect(reloaded.roles.find((entry) => entry.name === "ui-dev")).toMatchObject({ source: "project", available: true });
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
