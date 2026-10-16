import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openSettingsPage } from "../extensions/settings.ts";
import type { SettingsExtensionContext } from "../extensions/settings.ts";
import { copyAgentDefinition } from "../runtime/agent-copy.ts";
import { readAgentSettings } from "../runtime/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { SettingsPageView } from "../runtime/settings-page-ui.ts";

const RIGHT = "\x1b[C", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };

let root = "", savedAgentDir: string | undefined;
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  savedAgentDir = undefined;
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await mkdtemp(join(tmpdir(), "pi-t-"));
  return { defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p") };
}
type Dirs = Awaited<ReturnType<typeof setup>>;
const layerDirs = (d: Dirs) => [d.defaultDir, d.userDir, d.projectDir];
const loadCatalog = (d: Dirs) => loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
async function writeRole(dir: string, name: string, head: string, body = "") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\n${head}\n---\n${body}`);
}
const headOf = (content: string) => content.split(/^---$/mu)[1]!;
const bodyOf = (content: string) => content.split(/^---$/mu).slice(2).join("---");

test("复制内置 worker 为新名字：头部只有 name、description、role、skills 空数组、mcp 空数组，没有 model 和 thinking，正文为空", async () => {
  const d = await setup();
  const worker = (await loadCatalog(d)).roles.find((entry) => entry.name === "worker")!;
  const target = await copyAgentDefinition({ entry: worker, newName: "vue-engineer", targetDir: d.userDir, layerDirs: layerDirs(d) });
  const content = await readFile(target, "utf8");
  const keys = headOf(content).split("\n").filter(Boolean).map((line) => line.split(":")[0]);
  expect(keys).toEqual(["name", "description", "role", "skills", "mcp"]);
  expect(headOf(content)).toMatch(/^name: vue-engineer$/mu);
  expect(headOf(content)).toMatch(/^skills: \[\]$/mu);
  expect(headOf(content)).toMatch(/^mcp: \[\]$/mu);
  expect(bodyOf(content).trim()).toBe("");
});

test("复制头部没写 skills 和 mcp 的用户定义：补上 skills 和 mcp 空数组，model、thinking、正文原样保留", async () => {
  const d = await setup();
  await writeRole(d.userDir, "go-engineer", "description: 写 Go\nrole: worker\nmodel: gpt-6.1-sol\nthinking: high", "\n擅长 Go，注释只写为什么\n");
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "go-engineer")!;
  const target = await copyAgentDefinition({ entry, newName: "go-copy", targetDir: d.userDir, layerDirs: layerDirs(d) });
  const content = await readFile(target, "utf8");
  expect(headOf(content)).toMatch(/^name: go-copy$/mu);
  expect(headOf(content)).toMatch(/^description: 写 Go$/mu);
  expect(headOf(content)).toMatch(/^model: gpt-6\.1-sol$/mu);
  expect(headOf(content)).toMatch(/^thinking: high$/mu);
  expect(headOf(content)).toMatch(/^skills: \[\]$/mu);
  expect(headOf(content)).toMatch(/^mcp: \[\]$/mu);
  expect(bodyOf(content)).toBe(bodyOf(await readFile(join(d.userDir, "go-engineer.md"), "utf8")));
});

test("复制已写 skills 和 mcp 的定义：写了的原样保留，不被改成空数组", async () => {
  const d = await setup();
  await writeRole(d.userDir, "vue-engineer", "description: 写 Vue\nrole: worker\nskills: [a]\nmcp: [docs]", "擅长 Vue\n");
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "vue-engineer")!;
  const target = await copyAgentDefinition({ entry, newName: "vue-copy", targetDir: d.userDir, layerDirs: layerDirs(d) });
  const head = headOf(await readFile(target, "utf8"));
  expect(head).toMatch(/^skills: \[a\]$/mu);
  expect(head).toMatch(/^mcp: \[docs\]$/mu);
  expect(head.match(/^skills:/gmu)).toHaveLength(1);
  expect(head.match(/^mcp:/gmu)).toHaveLength(1);
});

test("只写了 skills 没写 mcp 时，只补 mcp 空数组", async () => {
  const d = await setup();
  await writeRole(d.userDir, "half", "description: d\nrole: worker\nskills: [a]");
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "half")!;
  const target = await copyAgentDefinition({ entry, newName: "half-copy", targetDir: d.userDir, layerDirs: layerDirs(d) });
  const head = headOf(await readFile(target, "utf8"));
  expect(head).toMatch(/^skills: \[a\]$/mu);
  expect(head).toMatch(/^mcp: \[\]$/mu);
});

async function viewOf(d: Dirs) {
  const catalog = await loadCatalog(d);
  const settings = await readAgentSettings({ agentDir: join(root, "agent"), repositoryRoot: join(root, "repo"), projectTrusted: true });
  const view = new SettingsPageView({ catalog, theme, projectTrusted: true, untrustedProjectCount: 0, settings, models: [], mainModel: undefined, mainThinking: "high",
    onSaveSetting() {}, onClearSetting() {}, onSaveSwitch() {}, onClearSwitch() {}, nameTaken: () => undefined, onCopy() {}, onClose() {} });
  const lines = (width = 80) => view.render(width).map((line) => line.trimEnd());
  return { view, lines, text: (width = 80) => lines(width).join("\n") };
}

test("展开内置 worker 详情：正文行写空，说明流程规矩由程序加上，且位于 MCP 行之后、文件行之前", async () => {
  const d = await setup();
  await writeRole(d.userDir, "vue-engineer", "description: 写 Vue\nrole: worker\nskills: [a]\nmcp: [docs]", "擅长 Vue\n");
  const p = await viewOf(d);
  p.view.handleInput(RIGHT);
  p.view.handleInput("\x1b[B");
  p.view.handleInput(ENTER);
  const lines = p.lines();
  expect(p.text()).toMatch(/[▸▾] worker/u);
  const at = (key: RegExp) => lines.findIndex((line) => key.test(line));
  const mcp = at(/┊ MCP/u), body = at(/┊ 正文/u), file = at(/┊ 文件/u);
  expect(lines[body]).toMatch(/┊ 正文 +空 · 流程规矩由程序加上，正文只写专长和偏好$/u);
  expect(mcp).toBeGreaterThan(-1);
  expect(body).toBe(mcp + 1);
  expect(file).toBe(body + 1);
});

test("展开写了正文的 vue-engineer 详情：正文行写已写，说明流程规矩优先于正文，且位于 MCP 行之后、文件行之前", async () => {
  const d = await setup();
  await writeRole(d.userDir, "vue-engineer", "description: 写 Vue\nrole: worker\nskills: [a]\nmcp: [docs]", "擅长 Vue\n");
  const p = await viewOf(d);
  p.view.handleInput(RIGHT);
  p.view.handleInput(ENTER);
  const lines = p.lines();
  expect(p.text()).toMatch(/vue-engineer/u);
  const at = (key: RegExp) => lines.findIndex((line) => key.test(line));
  const mcp = at(/┊ MCP/u), body = at(/┊ 正文/u), file = at(/┊ 文件/u);
  expect(lines[body]).toMatch(/┊ 正文 +已写 · 流程规矩由程序加上，优先于正文$/u);
  expect(body).toBe(mcp + 1);
  expect(file).toBe(body + 1);
});

test("36 到 80 列下展开详情，每一行的显示宽度都不超过终端宽度", async () => {
  const d = await setup();
  await writeRole(d.userDir, "vue-engineer", "description: 写 Vue\nrole: worker\nskills: [a]\nmcp: [docs]", "擅长 Vue\n");
  for (let width = 36; width <= 80; width++) {
    for (const downs of [0, 1]) {
      const p = await viewOf(d);
      p.view.handleInput(RIGHT);
      for (let i = 0; i < downs; i++) p.view.handleInput("\x1b[B");
      p.view.handleInput(ENTER);
      expect(p.text(width)).toContain("正文");
      for (const line of p.lines(width)) expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  }
});

test("头部写了 tools 的定义不生效，进问题栏，原因是不认识的字段，详情里没有工具", async () => {
  const d = await setup();
  await writeRole(d.userDir, "tooly", "description: 带工具\nrole: worker\ntools: [bash]");
  const catalog = await loadCatalog(d);
  const entry = catalog.roles.find((item) => item.name === "tooly");
  expect(entry?.available).toBe(false);
  expect(entry?.problem?.display).toBe("不认识的字段：tools");
  const p = await viewOf(d);
  for (let i = 0; i < 7; i++) p.view.handleInput("\x1b[B");
  p.view.handleInput(RIGHT);
  p.view.handleInput(ENTER);
  expect(p.text()).toMatch(/tooly\.md/u);
  expect(p.text()).toMatch(/┊ 原因 +不认识的字段：tools/u);
  expect(p.text()).not.toMatch(/┊ 工具/u);
});

test("页面复制完成后底部提示：已复制到新文件路径，打开它写专长、skills 和 mcp", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-t-"));
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "repo"), { recursive: true });
  const screens: string[] = [];
  const steps: Array<(keys: (...k: string[]) => void, text: string) => void> = [
    (keys) => keys(RIGHT, "c", ...Array(11).fill(BACKSPACE), ..."vue-engineer", ENTER),
    (keys) => keys(ENTER),
    (keys, text) => { screens.push(text); keys(ESC); },
  ];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = steps.shift();
        if (!step) throw new Error("脚本步骤用完了");
        step((...keys) => { for (const key of keys) component.handleInput(key); }, component.render(200).map((line) => line.trimEnd()).join("\n"));
      });
    },
    notify() {},
  };
  const ctx = { hasUI: true, mode: "tui", cwd: join(root, "repo"), ui, isProjectTrusted: () => true, modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, model: undefined } as unknown as SettingsExtensionContext;
  await openSettingsPage(ctx, { mainThinking: () => "high", onGitDeliveryChanged() {} });
  expect(screens[0]).toContain(`✓ 已复制到 ${join(root, "agent", "agents", "vue-engineer.md")}，打开它写专长、skills 和 mcp`);
});

test("源文件是 Windows 换行且开头带 BOM 时照样能复制，新文件统一用 \\n 换行", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  try {
    const userDir = join(root, "u");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "crlf.md"), "﻿---\r\nname: crlf\r\ndescription: d\r\nrole: worker\r\n---\r\n擅长 Go\r\n");
    const catalog = await loadRoleCatalog({ defaultDir: join(root, "none"), userDir, projectDir: join(root, "p"), parseFrontmatter, projectTrusted: false });
    const entry = catalog.roles.find((candidate) => candidate.name === "crlf")!;
    const copied = await copyAgentDefinition({ entry, newName: "crlf-copy", targetDir: userDir, layerDirs: [userDir] });
    expect(await readFile(copied, "utf8")).toBe("---\nname: crlf-copy\ndescription: d\nrole: worker\nskills: []\nmcp: []\n---\n擅长 Go\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("正文按原样保留：首尾空行与第一行的缩进都不变", async () => {
  const d = await setup();
  await writeRole(d.userDir, "indent", "description: d\nrole: worker", "\n\n    缩进代码块\n\n");
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "indent")!;
  const target = await copyAgentDefinition({ entry, newName: "indent-copy", targetDir: d.userDir, layerDirs: layerDirs(d) });
  expect((await readFile(target, "utf8")).endsWith("\n---\n\n\n    缩进代码块\n\n")).toBe(true);
});

test("键名带引号或冒号前有空格时也认作已写，不重复补，复制出的定义能正常加载", async () => {
  const d = await setup();
  await writeRole(d.userDir, "quoted", 'description: d\nrole: worker\n"skills": [a]\nmcp : [b]');
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "quoted")!;
  await copyAgentDefinition({ entry, newName: "quoted-copy", targetDir: d.userDir, layerDirs: layerDirs(d) });
  const copied = (await loadCatalog(d)).roles.find((item) => item.name === "quoted-copy")!;
  expect(copied.available).toBe(true);
  expect(copied.definition).toMatchObject({ skills: ["a"], mcp: ["b"] });
});

test("开头那行 --- 后带空格、或整份文件只用 \\r 换行时也能复制", async () => {
  const d = await setup();
  await mkdir(d.userDir, { recursive: true });
  await writeFile(join(d.userDir, "spaced.md"), "--- \nname: spaced\ndescription: d\nrole: worker\n---\n正文\n");
  await writeFile(join(d.userDir, "cr.md"), "---\rname: cr\rdescription: d\rrole: worker\r---\r正文\r");
  for (const name of ["spaced", "cr"]) {
    const entry = (await loadCatalog(d)).roles.find((item) => item.name === name)!;
    expect(entry.available).toBe(true);
    await copyAgentDefinition({ entry, newName: `${name}-copy`, targetDir: d.userDir, layerDirs: layerDirs(d) });
    const copied = (await loadCatalog(d)).roles.find((item) => item.name === `${name}-copy`)!;
    expect(copied.available).toBe(true);
    expect(copied.definition!.body).toBe("正文");
  }
});

test("源文件在打开页面后被改成没有设置段时，复制报可读的原因而不是抛出意外错误", async () => {
  const d = await setup();
  await writeRole(d.userDir, "later", "description: d\nrole: worker");
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "later")!;
  await writeFile(join(d.userDir, "later.md"), "没有设置段了\n");
  await expect(copyAgentDefinition({ entry, newName: "later-copy", targetDir: d.userDir, layerDirs: layerDirs(d) }))
    .rejects.toThrow("源文件开头的设置段格式不对，没有复制");
});

test("内置 explore 也能复制成新名字", async () => {
  const d = await setup();
  const entry = (await loadCatalog(d)).roles.find((item) => item.name === "explore" && item.source === "default")!;
  const target = await copyAgentDefinition({ entry, newName: "web-explore", targetDir: d.userDir, layerDirs: layerDirs(d) });
  expect(headOf(await readFile(target, "utf8"))).toMatch(/^name: web-explore$/mu);
  expect((await loadCatalog(d)).roles.find((item) => item.name === "web-explore")?.definition?.role).toBe("explore");
});
