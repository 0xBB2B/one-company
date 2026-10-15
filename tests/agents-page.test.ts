import { afterEach, beforeEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { openSettingsPage } from "../extensions/settings.ts";
import type { SettingsExtensionContext } from "../extensions/settings.ts";
import { readRoleDefinition, userRoleDir } from "../runtime/roles.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };

interface Screen { text: string; keys(...keys: string[]): void; now(): string }
type Step = (screen: Screen) => void;

let root = "", savedAgentDir: string | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agents-page-")); savedAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); });
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await chmod(join(root, "agent", "agents"), 0o755).catch(() => undefined);
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
  return { hasUI: true, mode: "tui", cwd: join(root, "repo"), ui: ui as unknown as SettingsExtensionContext["ui"], isProjectTrusted: () => trusted, modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, model: undefined, screens };
}
const typed = (text: string) => [...text];

test("M8D-AC8：页内输入新名称，程序窗口列出两层与完整路径，复制后回到原分类选中新定义并显示成功提示", async () => {
  await mkdir(join(root, "repo"), { recursive: true });
  let window = "";
  const ctx = scripted([
    (s) => s.keys("c", ...Array(11).fill(BACKSPACE), ...typed("api-worker"), ENTER),
    (s) => { window = s.text; s.keys(ENTER); },
    (s) => {
      expect(s.text).toMatch(/› api-worker +用户/u);
      expect(s.text).toContain(`✓ 已复制到 ${join(root, "agent", "agents", "api-worker.md")}，打开它写专长、skills 和 mcp`);
      s.keys(ESC);
    },
  ]);
  await openSettingsPage(ctx, { mainThinking: () => "high" });
  expect(window).toContain("复制 worker 到哪一层？");
  expect(window).toContain("新名称：api-worker");
  expect(window).toMatch(new RegExp(`→ 用户层 +${join(root, "agent", "agents", "api-worker.md")}`, "u"));
  expect(window).toMatch(new RegExp(`项目层 +${join(root, "repo", ".pi", "agents", "api-worker.md")}`, "u"));
  expect(await readFile(join(root, "agent", "agents", "api-worker.md"), "utf8")).toMatch(/^name: api-worker$/mu);
});

test("M8D-AC8：项目未受信任时项目层选项变暗并写明原因，页面标题不显示项目层数量", async () => {
  await mkdir(join(root, "repo", ".pi", "agents"), { recursive: true });
  await writeFile(join(root, "repo", ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: d\nrole: reviewer\n---\n");
  let window = "";
  const ctx = scripted([
    (s) => { expect(s.text.split("\n")[1]).toMatch(/内置 5 · 用户 0$/u); s.keys("c", ENTER); },
    (s) => { window = s.text; s.keys(ESC); },
    (s) => s.keys(ESC),
  ], false);
  await openSettingsPage(ctx, { mainThinking: () => "high" });
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
  const ctx = scripted([(s) => { page = s.now(); s.keys(ESC); }]);
  await openSettingsPage(ctx, { mainThinking: () => "high" });
  expect(page).toContain("quoted-worker");
  expect(page).toContain(parsed.model!);
  expect(page).not.toContain('"x/m-1"');
  expect(page).not.toContain("问题");
});

const agentsDir = () => join(root, "agent", "agents");
const SOURCE = () => join(agentsDir(), "ui-w.md");

/** 页面里选中用户层的 ui-w，输入新名称 copy-w 并到选层窗口；之后的动作交给 atWindow，选层回车，最后一屏交给 afterCopy 检查。 */
async function copyWith(atWindow: () => void, afterCopy: (s: PageScreen) => void) {
  await mkdir(join(root, "repo"), { recursive: true });
  await mkdir(agentsDir(), { recursive: true });
  await writeFile(SOURCE(), "---\nname: ui-w\ndescription: d\nrole: worker\n---\n正文\n");
  const ctx = scripted([
    (s) => { expect(s.text).toMatch(/› ui-w +用户/u); s.keys("c", ...Array(30).fill(BACKSPACE), ...typed("copy-w"), ENTER); },
    (s) => { atWindow(); s.keys(ENTER); },
    (s) => { afterCopy(s); s.keys(ESC); },
  ]);
  await expect(openSettingsPage(ctx, { mainThinking: () => "high" })).resolves.toBeUndefined();
}
type PageScreen = Parameters<Step>[0];

test("复制时源定义文件已被删除：页面不退出，底部灰字写源文件已经不存在", async () => {
  await copyWith(() => rmSync(SOURCE()), (s) => {
    expect(s.text).toContain("复制没有完成：源文件已经不存在，重新打开本页再试");
    expect(s.text).toContain("内置 5");
  });
});

test("选层之后目标位置刚出现同名文件：页面不退出，底部灰字写目标路径已经存在，换一个名字再复制", async () => {
  const target = join(agentsDir(), "copy-w.md");
  await copyWith(() => symlinkSync(join(root, "nowhere"), target), (s) => {
    expect(s.text).toContain(`复制没有完成：${target} 已经存在，换一个名字再复制`);
  });
});

test("目标目录没有写权限：页面不退出，底部灰字写没有权限写入该目录", async (context) => {
  if (process.getuid?.() === 0) context.skip();
  await copyWith(() => chmodSync(agentsDir(), 0o555), (s) => {
    expect(s.text).toContain(`复制没有完成：没有权限写入 ${agentsDir()}`);
  });
  await expect(readFile(join(agentsDir(), "copy-w.md"), "utf8")).rejects.toThrow();
});

test("其他意外错误：页面不退出，底部灰字写错误信息首行", async () => {
  await copyWith(() => { rmSync(SOURCE()); mkdirSync(SOURCE()); }, (s) => {
    expect(s.text).toMatch(/复制没有完成：.*EISDIR/u);
    expect(s.text).not.toContain("源文件已经不存在");
  });
});
