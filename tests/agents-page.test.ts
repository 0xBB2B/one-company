import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { openSettingsPage } from "../extensions/settings.ts";
import type { SettingsExtensionContext } from "../extensions/settings.ts";
import { readRoleDefinition, userRoleDir } from "../runtime/roles.ts";

const RIGHT = "\x1b[C", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };

interface Screen { text: string; keys(...keys: string[]): void; now(): string }
type Step = (screen: Screen) => void;

let root = "", savedAgentDir: string | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agents-page-")); savedAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); });
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(root, { recursive: true, force: true });
});

/** 每次页面或程序窗口出现，按顺序交给下一步处理；页面与窗口都走 ui.custom。 */
function scripted(steps: Step[], trusted = true): SettingsExtensionContext & { screens: string[] } {
  const screens: string[] = [];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = steps.shift();
        if (!step) throw new Error("脚本步骤用完了");
        const now = () => component.render(200).map((line) => line.trimEnd()).join("\n");
        const text = now();
        screens.push(text);
        step({ text, now, keys: (...keys) => { for (const key of keys) component.handleInput(key); } });
      });
    },
    notify() {},
  };
  return { hasUI: true, mode: "tui", cwd: join(root, "repo"), ui: ui as unknown as SettingsExtensionContext["ui"], isProjectTrusted: () => trusted, screens };
}
const typed = (text: string) => [...text];

test("M8D-AC8：页内输入新名称，程序窗口列出两层与完整路径，复制后回到原分类选中新定义并显示成功提示", async () => {
  await mkdir(join(root, "repo"), { recursive: true });
  let window = "";
  const ctx = scripted([
    (s) => s.keys(RIGHT, "c", ...Array(11).fill(BACKSPACE), ...typed("api-worker"), ENTER),
    (s) => { window = s.text; s.keys(ENTER); },
    (s) => {
      expect(s.text).toMatch(/› api-worker +用户/u);
      expect(s.text).toContain(`✓ 已复制到 ${join(root, "agent", "agents", "api-worker.md")}，请直接编辑这个文件`);
      s.keys(ESC);
    },
  ]);
  await openSettingsPage(ctx);
  expect(window).toContain("复制 worker 到哪一层？");
  expect(window).toContain("新名称：api-worker");
  expect(window).toMatch(new RegExp(`→ 用户层 +${join(root, "agent", "agents", "api-worker.md")}`, "u"));
  expect(window).toMatch(new RegExp(`项目层 +${join(root, "repo", ".pi", "agents", "api-worker.md")}`, "u"));
  expect(await readFile(join(root, "agent", "agents", "api-worker.md"), "utf8")).toMatch(/^name: api-worker$/mu);
});

test("M8D-AC8：内部定义同名复制；取消回到页面说明已取消；已有同名文件的层变暗写明已有文件；两层都有时不弹窗直接提示", async () => {
  await mkdir(join(root, "repo"), { recursive: true });
  const windows: string[] = [];
  const toInternal = [RIGHT, RIGHT, RIGHT, RIGHT, RIGHT];
  const ctx = scripted([
    (s) => s.keys(...toInternal, "c", ENTER),
    (s) => { windows.push(s.text); s.keys(ESC); },
    (s) => { expect(s.text).toContain("已取消复制"); s.keys("c", ENTER); },
    (s) => s.keys(DOWN, ENTER),
    (s) => {
      expect(s.text).toMatch(/› 草稿核验器 +项目/u);
      expect(s.text).toContain("draft-verifier.md，改 model 和 thinking 两行即可");
      s.keys("c", ENTER);
    },
    (s) => { windows.push(s.text); s.keys(ENTER); },
    (s) => { s.keys("c", ENTER); },
    (s) => { expect(s.text).toContain("用户层和项目层都已经有 draft-verifier，直接编辑对应文件即可"); s.keys(ESC); },
  ]);
  await openSettingsPage(ctx);
  expect(windows[0]).toContain("复制草稿核验器到哪一层？");
  expect(windows[0]).not.toContain("新名称");
  expect(windows[1]).toMatch(new RegExp(`项目层 +已有 ${join(root, "repo", ".pi", "agents", "draft-verifier.md")}`, "u"));
  expect(await readFile(join(root, "agent", "agents", "draft-verifier.md"), "utf8")).toMatch(/^name: draft-verifier$/mu);
});

test("M8D-AC8：项目未受信任时项目层选项变暗并写明原因，页面标题不显示项目层数量", async () => {
  await mkdir(join(root, "repo", ".pi", "agents"), { recursive: true });
  await writeFile(join(root, "repo", ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: d\nrole: reviewer\n---\n");
  let window = "";
  const ctx = scripted([
    (s) => { expect(s.text.split("\n")[1]).toMatch(/内置 7 · 用户 0$/u); s.keys(RIGHT, "c", ENTER); },
    (s) => { window = s.text; s.keys(ESC); },
    (s) => s.keys(ESC),
  ], false);
  await openSettingsPage(ctx);
  expect(window).toMatch(/项目层 +项目未受信任，暂不能复制到这里/u);
});

test("带引号的 model 与多行 description：设置页显示的内容与守护进程解析结果一致，不当成问题定义", async () => {
  await mkdir(join(root, "repo"), { recursive: true });
  const dir = userRoleDir(join(root, "agent"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, "quoted-worker.md");
  await writeFile(path, '---\nname: quoted-worker\ndescription: >\n  多行描述第一行\n  第二行: 含冒号\nrole: worker\nmodel: "x/m-1"\nthinking: \'high\'\n---\n\n正文\n');
  const parsed = await readRoleDefinition(path, parseFrontmatter);
  expect(parsed).toMatchObject({ model: "x/m-1", thinking: "high", description: "多行描述第一行 第二行: 含冒号\n" });
  let page = "";
  const ctx = scripted([(s) => { s.keys(RIGHT); page = s.now(); s.keys(ESC); }]);
  await openSettingsPage(ctx);
  expect(page).toContain("quoted-worker");
  expect(page).toContain(parsed.model!);
  expect(page).not.toContain('"x/m-1"');
  expect(page).not.toContain("问题");
});
