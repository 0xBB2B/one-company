import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readAgentSettings, projectSettingsPath, userSettingsPath } from "../runtime/agent-settings.ts";
import { openSettingsPage } from "../extensions/settings.ts";
import type { SettingsExtensionContext } from "../extensions/settings.ts";

const RIGHT = "\x1b[C", UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
const SOL = { provider: "5x", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LUNA = { provider: "5x", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { minimal: null, max: null } };
const GRAY_NOTE = /gpt-6-luna 不支持/u;

let root = "", savedAgentDir: string | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-t-")); savedAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); });
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await rm(root, { recursive: true, force: true });
});

const agentDir = () => process.env.PI_CODING_AGENT_DIR!, repoDir = () => join(root, "repo");
const userFile = () => userSettingsPath(agentDir()), projectFile = () => projectSettingsPath(repoDir());
async function writeSettings(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const oneCompany = (entries: Record<string, { model: string | null; thinking: string | null }>) => ({ "one-company": entries });

interface Screen { text(): string; press(...keys: string[]): void }
const selectedLine = (text: string) => text.split("\n").find((line) => /^\s*›\s/u.test(line)) ?? "";
function moveTo(screen: Screen, label: string) {
  const here = () => selectedLine(screen.text()).split(/\s+/u).filter((word) => word && word !== "›" && word !== "✓")[0] === label;
  for (let i = 0; i < 8 && !here(); i++) screen.press(DOWN);
  for (let i = 0; i < 16 && !here(); i++) screen.press(UP);
  if (!here()) throw new Error(`光标移不到 ${label}：\n${screen.text()}`);
}

interface PageScreen extends Screen { now(): string }
type Step = (screen: PageScreen) => void;

const failures: unknown[] = [];
async function run(ctx: SettingsExtensionContext, mainThinking = "high") {
  failures.length = 0;
  await openSettingsPage(ctx, { mainThinking: () => mainThinking });
  if (failures.length) throw failures[0];
}

function scripted(steps: Step[], options: { trusted?: boolean; models?: unknown[]; authorized?: string[] } = {}): SettingsExtensionContext & { screens: string[] } {
  const screens: string[] = [];
  const models = options.models ?? [SOL, LUNA];
  const authorized = options.authorized ?? ["gpt-6.1-sol", "gpt-6-luna"];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = steps.shift();
        if (!step) throw new Error("脚本步骤用完了");
        const now = () => component.render(200).map((line) => line.trimEnd()).join("\n");
        screens.push(now());
        const press = (...keys: string[]) => { for (const key of keys) component.handleInput(key); };
        try { step({ text: now, now, press }); } catch (error) { failures.push(error); resolve(undefined as T); }
      });
    },
    notify() {},
  };
  return { hasUI: true, mode: "tui", cwd: repoDir(), ui: ui as unknown as SettingsExtensionContext["ui"], isProjectTrusted: () => options.trusted ?? true,
    modelRegistry: { getAll: () => models, hasConfiguredAuth: (model: { id: string }) => authorized.includes(model.id) }, model: SOL, screens } as unknown as SettingsExtensionContext & { screens: string[] };
}
const toSettings = (s: PageScreen) => s.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);

test("页面：选 gpt-6-luna、xhigh、项目层后项目设置文件写入 pm 条目，重开后 PM 来源是项目，底部绿字写生效时机", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER);
      moveTo(s, "gpt-6-luna");
      s.press(ENTER);
      expect(s.now()).toMatch(new RegExp(`minimal +${GRAY_NOTE.source}`, "u"));
      moveTo(s, "xhigh");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/› PM +项目 +gpt-6-luna +xhigh/u);
      expect(s.now()).toContain("✓ PM 改为 gpt-6-luna · xhigh，存到项目层，下次启动 PM 时生效");
      s.press(ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].pm).toEqual({ model: "gpt-6-luna", thinking: "xhigh" });
  expect(existsSync(userFile())).toBe(false);
}, 5000);

test("页面：任一步连续 Esc 退出，两层设置文件都没有改动，底部写已取消修改", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER, ENTER, ENTER, ESC, ESC, ESC);
      expect(s.now()).toContain("已取消修改");
      s.press(ESC);
    },
  ]);
  await run(ctx);
  expect(existsSync(userFile())).toBe(false);
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("页面：项目不受信任时第 3 步项目层不可选，回车存到用户层，项目设置文件不被创建", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER);
      moveTo(s, "gpt-6.1-sol");
      s.press(ENTER);
      moveTo(s, "medium");
      s.press(ENTER);
      expect(s.now()).toMatch(/项目层 +项目未受信任，项目层的设定不会生效/u);
      expect(selectedLine(s.now())).toMatch(/用户层/u);
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/› PM +用户 +gpt-6\.1-sol +medium/u);
      expect(s.now()).toContain("存到用户层，下次启动 PM 时生效");
      s.press(ESC);
    },
  ], { trusted: false });
  await run(ctx);
  expect((await readJson(userFile()))["one-company"].pm).toEqual({ model: "gpt-6.1-sol", thinking: "medium" });
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("页面：没有任何配了凭据的模型时选跟随主会话，文件里 model 为 null，列表显示跟随主会话", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER);
      expect(s.now()).toContain("本机还没有其他配了凭据的模型，先在 pi 里登录模型服务");
      s.press(ENTER);
      moveTo(s, "high");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/› PM +项目 +跟随主会话 +high *\n/u);
      expect(s.now()).toMatch(/PM 改为 跟随主会话 · high，存到项目层/u);
      s.press(ESC);
    },
  ], { models: [], authorized: [] });
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].pm).toEqual({ model: null, thinking: "high" });
}, 5000);

test("页面：第 2 步选“跟随主会话”保存后，文件里 thinking 为 null，列表思考列写跟随，保存提示写跟随", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER);
      moveTo(s, "gpt-6-luna");
      s.press(ENTER);
      expect(s.now()).toMatch(/跟随主会话 +现在是 xhigh *\n/u);
      moveTo(s, "跟随主会话");
      s.press(ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/› PM +用户 +gpt-6-luna +跟随 *\n/u);
      expect(s.now()).toContain("✓ PM 改为 gpt-6-luna · 跟随，存到用户层，下次启动 PM 时生效");
      s.press(ESC);
    },
  ]);
  await run(ctx, "xhigh");
  expect((await readJson(userFile()))["one-company"].pm).toEqual({ model: "gpt-6-luna", thinking: null });
}, 5000);

test("页面：第 1 步和第 2 步都选跟随主会话，保存后列表和提示都写跟随主会话 · 跟随", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(DOWN, ENTER);
      moveTo(s, "跟随主会话");
      s.press(ENTER);
      moveTo(s, "跟随主会话");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/› 解释器 +项目 +跟随主会话 +跟随 *\n/u);
      expect(s.now()).toContain("✓ 解释器 改为 跟随主会话 · 跟随，存到项目层，下次调用时生效");
      s.press(ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].interpreter).toEqual({ model: null, thinking: null });
}, 5000);

test("页面：清除用户层里模型和思考都跟随的设定后，提示写内置默认值：跟随主会话", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: null, thinking: null } }));
  const ctx = scripted([
    (s) => { toSettings(s); s.press("R"); },
    (s) => {
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除用户层的 PM 设定，现在用内置默认值：跟随主会话");
      s.press(ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("页面：设置文件里 thinking 写 null 时列表写跟随，问题栏没有这一条", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: null } }));
  const ctx = scripted([
    (s) => {
      toSettings(s);
      expect(s.now()).toMatch(/› PM +用户 +gpt-6-luna +跟随 *\n/u);
      expect(s.now()).not.toMatch(/问题 \d/u);
      s.press(ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("页面：来源为项目的 PM 按 R 后项目层这一项被删，改用内置默认值并提示", async () => {
  await writeSettings(projectFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: "low" } }));
  const ctx = scripted([
    (s) => { toSettings(s); s.press("R"); },
    (s) => {
      expect(s.now()).toMatch(/› PM +内置 +跟随主会话 +跟随/u);
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除项目层的 PM 设定，现在用内置默认值：跟随主会话");
      s.press(ESC);
    },
  ]);
  await run(ctx);
  const after = await readAgentSettings({ agentDir: agentDir(), repositoryRoot: repoDir(), projectTrusted: true });
  expect(after.layers.project.pm).toBeUndefined();
  expect(after.values.pm.source).toBe("default");
}, 5000);

test("页面：项目层清除后下一层是用户层时，现在用用户层的值", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "low" } }));
  await writeSettings(projectFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: "xhigh" } }));
  const ctx = scripted([
    (s) => { toSettings(s); s.press("R"); },
    (s) => {
      expect(s.now()).toMatch(/已清除项目层的 PM 设定，现在用.*gpt-6\.1-sol · low/u);
      s.press(ESC);
    },
  ]);
  await run(ctx);
  const after = await readAgentSettings({ agentDir: agentDir(), repositoryRoot: repoDir(), projectTrusted: true });
  expect(after.layers.project.pm).toBeUndefined();
  expect(after.layers.user.pm).toEqual({ model: "gpt-6.1-sol", thinking: "low" });
}, 5000);

test("页面：来源为内置的 PM 按 R 只提示已经是内置默认值，不创建设置文件", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([(s) => { toSettings(s); s.press("R"); expect(s.now()).toContain("已经是内置默认值"); s.press(ESC); }]);
  await run(ctx);
  expect(existsSync(userFile())).toBe(false);
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("页面：设定里的模型没有凭据时这一行写不可用，选中时底部写明后果，模型列表里也不列它", async () => {
  await writeSettings(userFile(), oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "medium" } }));
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(DOWN);
      expect(s.now()).toMatch(/解释器 +用户 +gpt-6-luna ?不可用/u);
      expect(s.now()).toContain("✗ gpt-6-luna 没有可用的凭据，批准需求时解读会失败；回车重新选");
      s.press(ENTER);
      expect(s.now()).not.toMatch(/gpt-6-luna +5x/u);
      s.press(ESC, ESC);
    },
  ], { authorized: ["gpt-6.1-sol"] });
  await run(ctx);
}, 5000);

test("页面：项目设置文件写错时问题栏出现这一条", async () => {
  await writeSettings(projectFile(), "{ not json");
  const ctx = scripted([
    (s) => {
      expect(s.now()).toMatch(/问题 1/u);
      s.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
      expect(s.now()).toMatch(/settings\.json +项目 +文件不是合法的 JSON/u);
      s.press(ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("页面：把 PM 存到项目层后，项目设置文件里原有的其他字段原样保留", async () => {
  await writeSettings(projectFile(), { theme: "dark", packages: ["x"] });
  const ctx = scripted([
    (s) => {
      toSettings(s);
      s.press(ENTER);
      moveTo(s, "gpt-6-luna");
      s.press(ENTER);
      moveTo(s, "high");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => s.press(ESC),
  ]);
  await run(ctx);
  expect(await readJson(projectFile())).toEqual({ theme: "dark", packages: ["x"], "one-company": { pm: { model: "gpt-6-luna", thinking: "high" } } });
}, 5000);

