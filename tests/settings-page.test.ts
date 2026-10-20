import { afterEach, beforeEach, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { openSettingsPage } from "../src/modules/settings/settings-extension.ts";
import type { SettingsExtensionContext } from "../src/modules/settings/settings-extension.ts";
import { projectSettingsPath, readAgentSettings, userSettingsPath } from "../src/modules/settings/agent-settings.ts";
import { readRoleDefinition, userRoleDir } from "../src/modules/agents/roles.ts";
import { initRepoWithOrigin, installFakeGh } from "./helpers/fake-gh.ts";

const LEFT = "\x1b[D", RIGHT = "\x1b[C", UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b", BACKSPACE = "\x7f";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bg: (kind: string, text: string) => `[${kind}]${text}[/]`,
  bold: (text: string) => `**${text}**`, inverse: (text: string) => `!!${text}!!` };
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\[\/?[a-zA-Z]*\]|\*\*|!!/gu, "");
const SOL = { provider: "5x", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LUNA = { provider: "5x", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { minimal: null, max: null } };
const GRAY_NOTE = /gpt-6-luna 不支持/u;
const SECTIONS = ["worker", "reviewer", "qa", "explore", "prototype", "models", "switches", "problems"] as const;

let root = "", savedAgentDir: string | undefined, gh: Awaited<ReturnType<typeof installFakeGh>>;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "pi-t-"))); gh = await installFakeGh(); savedAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); });
afterEach(async () => {
  await gh.restore();
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await chmod(join(root, "agent", "agents"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const agentDir = () => process.env.PI_CODING_AGENT_DIR!, repoDir = () => join(root, "repo");
const userFile = () => userSettingsPath(agentDir()), projectFile = () => projectSettingsPath(repoDir());
const agentsDir = () => join(agentDir(), "agents");
async function writeSettings(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const oneCompany = (entries: Record<string, unknown>) => ({ "one-company": entries });
const typed = (text: string) => [...text];

interface Screen { now(): string; raw(): string; press(...keys: string[]): void }
type Step = (screen: Screen) => void;

const paneOf = (text: string) => text.split("\n").map((row) => (row.includes("│") ? row.slice(row.indexOf("│") + 1) : row).trimEnd());
const selectedLine = (screen: Screen) => paneOf(screen.now()).find((line) => /^\s*[▸▾]\s/u.test(line)) ?? "";
function moveTo(screen: Screen, label: string) {
  const here = () => selectedLine(screen).split(/\s+/u).filter((word) => word && !/^[▸▾✓]$/u.test(word))[0] === label;
  for (let i = 0; i < 12 && !here(); i++) screen.press(DOWN);
  for (let i = 0; i < 24 && !here(); i++) screen.press(UP);
  if (!here()) throw new Error(`光标移不到 ${label}：\n${screen.now()}`);
}
const goTo = (screen: Screen, section: (typeof SECTIONS)[number]) => screen.press(...Array<string>(SECTIONS.indexOf(section)).fill(DOWN), RIGHT);

const failures: unknown[] = [];
async function run(ctx: SettingsExtensionContext, mainThinking = "high") {
  failures.length = 0;
  await openSettingsPage(ctx, { mainThinking: () => mainThinking });
  if (failures.length) throw failures[0];
}

/** 页面与程序窗口每次出现，按顺序交给下一步处理；两者都走 ui.custom。 */
function scripted(steps: Step[], options: { trusted?: false; models?: unknown[]; authorized?: string[] } = {}): SettingsExtensionContext {
  const trustFile = join(agentDir(), "trust.json");
  if (options.trusted !== false && !existsSync(trustFile)) { mkdirSync(agentDir(), { recursive: true }); writeFileSync(trustFile, JSON.stringify({ [repoDir()]: true })); }
  const models = options.models ?? [SOL, LUNA];
  const authorized = options.authorized ?? ["gpt-6.1-sol", "gpt-6-luna"];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = steps.shift();
        if (!step) throw new Error("脚本步骤用完了");
        const raw = () => component.render(200).map((line) => line.trimEnd()).join("\n");
        try { step({ raw, now: () => plain(raw()), press: (...keys) => { for (const key of keys) component.handleInput(key); } }); } catch (error) { failures.push(error); resolve(undefined as T); }
      });
    },
    notify() {},
  };
  return { hasUI: true, mode: "tui", cwd: repoDir(), ui: ui as unknown as SettingsExtensionContext["ui"],
    modelRegistry: { getAll: () => models, hasConfiguredAuth: (model: { id: string }) => authorized.includes(model.id) }, model: SOL } as unknown as SettingsExtensionContext;
}

test("页面打开时焦点在目录、选中 worker，先在目录选分类再按 → 进右栏", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      expect(s.now()).toMatch(/▸ worker +\d/u);
      expect(s.now()).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
      s.press(DOWN, DOWN, DOWN, DOWN, DOWN);
      expect(s.now()).toMatch(/▸ 模型 +3/u);
      s.press(RIGHT);
      expect(s.now()).toContain("←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
});

test("焦点在右栏时第一次 Esc 回目录且页面不关闭，第二次 Esc 才关闭", async () => {
  await mkdir(repoDir(), { recursive: true });
  let afterFirst = "";
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ESC);
      afterFirst = s.now();
      s.press(ESC);
    },
  ]);
  await run(ctx);
  expect(afterFirst).toContain("↑↓ 选分类  → 进右栏  Esc 退出");
  expect(afterFirst).toMatch(/▸ 模型 +3/u);
}, 5000);

test("页内输入新名称，程序窗口列出两层与完整路径，复制后回到原分类选中新定义，新名字是绿色并显示成功提示", async () => {
  await mkdir(repoDir(), { recursive: true });
  let window = "";
  const ctx = scripted([
    (s) => s.press(RIGHT, "c", ...Array(11).fill(BACKSPACE), ...typed("api-worker"), ENTER),
    (s) => { window = s.now(); s.press(ENTER); },
    (s) => {
      expect(s.now()).toMatch(/▸ api-worker +用户/u);
      expect(s.raw()).toContain("<success>api-worker</>");
      expect(s.now()).toContain(`✓ 已复制到 ${join(agentDir(), "agents", "api-worker.md")}，打开它写专长、skills 和 mcp`);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(window).toContain("复制 worker 到哪一层？");
  expect(window).toContain("新名称：api-worker");
  expect(window).toMatch(new RegExp(`→ 用户层 +${join(agentDir(), "agents", "api-worker.md")}`, "u"));
  expect(window).toMatch(new RegExp(`项目层 +${join(repoDir(), ".pi", "agents", "api-worker.md")}`, "u"));
  expect(await readFile(join(agentDir(), "agents", "api-worker.md"), "utf8")).toMatch(/^name: api-worker$/mu);
});

test("项目未受信任时项目层选项变暗并写明原因，页面不列项目层的定义", async () => {
  await mkdir(join(repoDir(), ".pi", "agents"), { recursive: true });
  await writeFile(join(repoDir(), ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: d\nrole: reviewer\n---\n");
  let window = "";
  const ctx = scripted([
    (s) => {
      expect(s.now()).toContain("! 项目未受信任：项目层的定义和设定都没有生效");
      s.press(DOWN, RIGHT);
      expect(s.now()).not.toMatch(/reviewer +项目/u);
      s.press(LEFT, UP, RIGHT, "c", ENTER);
    },
    (s) => { window = s.now(); s.press(ESC); },
    (s) => s.press(ESC, ESC),
  ], { trusted: false });
  await run(ctx);
  expect(window).toMatch(/项目层 +项目未受信任，暂不能复制到这里/u);
});

async function writeTrust(entries: Record<string, boolean>) {
  await writeSettings(join(agentDir(), "trust.json"), entries);
}

test("受信任与否按 trust.json 里离仓库最近的一条判断：父目录信任、仓库不信任时，项目层不生效", async () => {
  await mkdir(repoDir(), { recursive: true });
  await writeTrust({ [root]: true, [repoDir()]: false });
  await writeSettings(userFile(), oneCompany({ "git-delivery": "remote" }));
  await writeSettings(projectFile(), oneCompany({ "git-delivery": "local" }));
  const ctx = scripted([
    (s) => {
      expect(s.now()).toContain("! 项目未受信任：项目层的定义和设定都没有生效");
      goTo(s, "switches");
      expect(s.now()).toMatch(/▸ Git 交付 +用户 +远程/u);
      s.press(ESC, ESC);
    },
  ], {});
  await run(ctx);
});

test("trust.json 里仓库记为信任时项目层生效", async () => {
  await mkdir(repoDir(), { recursive: true });
  await writeTrust({ [root]: false, [repoDir()]: true });
  await writeSettings(userFile(), oneCompany({ "git-delivery": "remote" }));
  await writeSettings(projectFile(), oneCompany({ "git-delivery": "local" }));
  const ctx = scripted([
    (s) => {
      expect(s.now()).not.toContain("项目未受信任");
      goTo(s, "switches");
      expect(s.now()).toMatch(/▸ Git 交付 +项目 +仅本地/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
});

test("带引号的 model 与多行 description：设置页显示的内容与守护进程解析结果一致，不当成问题定义", async () => {
  await mkdir(repoDir(), { recursive: true });
  const dir = userRoleDir(agentDir());
  await mkdir(dir, { recursive: true });
  const path = join(dir, "quoted-worker.md");
  await writeFile(path, '---\nname: quoted-worker\ndescription: >\n  多行描述第一行\n  第二行: 含冒号\nrole: worker\nmodel: "x/m-1"\nthinking: \'high\'\n---\n\n正文\n');
  const parsed = await readRoleDefinition(path, parseFrontmatter);
  expect(parsed).toMatchObject({ model: "x/m-1", thinking: "high", description: "多行描述第一行 第二行: 含冒号\n" });
  let page = "";
  const ctx = scripted([(s) => { page = s.now(); s.press(ESC); }]);
  await run(ctx);
  expect(page).toContain("quoted-worker");
  expect(page).toContain(parsed.model!);
  expect(page).not.toContain('"x/m-1"');
  expect(page).not.toContain("问题");
});

const SOURCE = () => join(agentsDir(), "ui-w.md");
type PageScreen = Screen;

/** 选中用户层的 ui-w，输入新名称 copy-w 到选层窗口；之后的动作交给 atWindow，选层回车，最后一屏交给 afterCopy 检查。 */
async function copyWith(atWindow: () => void, afterCopy: (s: PageScreen) => void) {
  await mkdir(repoDir(), { recursive: true });
  await mkdir(agentsDir(), { recursive: true });
  await writeFile(SOURCE(), "---\nname: ui-w\ndescription: d\nrole: worker\n---\n正文\n");
  const ctx = scripted([
    (s) => { s.press(RIGHT); expect(s.now()).toMatch(/▸ ui-w +用户/u); s.press("c", ...Array(30).fill(BACKSPACE), ...typed("copy-w"), ENTER); },
    (s) => { atWindow(); s.press(ENTER); },
    (s) => { afterCopy(s); s.press(ESC, ESC); },
  ]);
  await expect(run(ctx)).resolves.toBeUndefined();
}

test("复制时源定义文件已被删除：页面不退出，底部灰字写源文件已经不存在", async () => {
  await copyWith(() => rmSync(SOURCE()), (s) => {
    expect(s.now()).toContain("复制没有完成：源文件已经不存在，重新打开本页再试");
    expect(s.raw()).toContain("<muted>复制没有完成：源文件已经不存在，重新打开本页再试</>");
    expect(s.now()).toContain("/one:setting");
  });
});

test("选层之后目标位置刚出现同名文件：页面不退出，底部灰字写目标路径已经存在，换一个名字再复制", async () => {
  const target = join(agentsDir(), "copy-w.md");
  await copyWith(() => symlinkSync(join(root, "nowhere"), target), (s) => {
    expect(s.now()).toContain(`复制没有完成：${target} 已经存在，换一个名字再复制`);
  });
});

test("目标目录没有写权限：页面不退出，底部灰字写没有权限写入该目录", async (context) => {
  if (process.getuid?.() === 0) context.skip();
  await copyWith(() => chmodSync(agentsDir(), 0o555), (s) => {
    expect(s.now()).toContain(`复制没有完成：没有权限写入 ${agentsDir()}`);
  });
  await expect(readFile(join(agentsDir(), "copy-w.md"), "utf8")).rejects.toThrow();
});

test("其他意外错误：页面不退出，底部灰字写错误信息首行", async () => {
  await copyWith(() => { rmSync(SOURCE()); mkdirSync(SOURCE()); }, (s) => {
    expect(s.now()).toMatch(/复制没有完成：.*EISDIR/u);
    expect(s.now()).not.toContain("源文件已经不存在");
  });
});

test("选 gpt-6-luna、xhigh、项目层后项目设置文件写入 pm 条目，重开后回到模型分类的 PM 行，来源是项目，名字是绿色，底部绿字写生效时机", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
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
      expect(s.now()).toMatch(/▸ PM +项目 +gpt-6-luna +xhigh/u);
      expect(s.raw()).toMatch(/<success>PM +<\/>/u);
      expect(s.raw()).toContain("<success>✓ PM 改为 gpt-6-luna · xhigh，存到项目层，下次启动 PM 时生效</>");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].pm).toEqual({ model: "gpt-6-luna", thinking: "xhigh" });
  expect(existsSync(userFile())).toBe(false);
}, 5000);

test("任一步连续 Esc 退出，两层设置文件都没有改动，底部写已取消修改", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ENTER, ENTER, ENTER, ESC, ESC, ESC);
      expect(s.now()).toContain("已取消修改");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(existsSync(userFile())).toBe(false);
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("项目不受信任时第 3 步项目层不可选，回车存到用户层，项目设置文件不被创建", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ENTER);
      moveTo(s, "gpt-6.1-sol");
      s.press(ENTER);
      moveTo(s, "medium");
      s.press(ENTER);
      expect(s.now()).toMatch(/项目层 +项目未受信任，项目层的设定不会生效/u);
      expect(selectedLine(s)).toMatch(/用户层/u);
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ PM +用户 +gpt-6\.1-sol +medium/u);
      expect(s.now()).toContain("存到用户层，下次启动 PM 时生效");
      s.press(ESC, ESC);
    },
  ], { trusted: false });
  await run(ctx);
  expect((await readJson(userFile()))["one-company"].pm).toEqual({ model: "gpt-6.1-sol", thinking: "medium" });
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("没有任何配了凭据的模型时选跟随主会话，文件里 model 为 null，列表显示跟随主会话", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ENTER);
      expect(s.now()).toContain("本机还没有其他配了凭据的模型，先在 pi 里登录模型服务");
      s.press(ENTER);
      moveTo(s, "high");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ PM +项目 +跟随主会话 +high *\n/u);
      expect(s.now()).toMatch(/PM 改为 跟随主会话 · high，存到项目层/u);
      s.press(ESC, ESC);
    },
  ], { models: [], authorized: [] });
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].pm).toEqual({ model: null, thinking: "high" });
}, 5000);

test("第 2 步选“跟随主会话”保存后，文件里 thinking 为 null，列表思考列写跟随，保存提示写跟随", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
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
      expect(s.now()).toMatch(/▸ PM +用户 +gpt-6-luna +跟随 *\n/u);
      expect(s.now()).toContain("✓ PM 改为 gpt-6-luna · 跟随，存到用户层，下次启动 PM 时生效");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx, "xhigh");
  expect((await readJson(userFile()))["one-company"].pm).toEqual({ model: "gpt-6-luna", thinking: null });
}, 5000);

test("第 1 步和第 2 步都选跟随主会话，保存后列表和提示都写跟随主会话 · 跟随", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(DOWN, ENTER);
      moveTo(s, "跟随主会话");
      s.press(ENTER);
      moveTo(s, "跟随主会话");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ 解释器 +项目 +跟随主会话 +跟随 *\n/u);
      expect(s.now()).toContain("✓ 解释器 改为 跟随主会话 · 跟随，存到项目层，下次调用时生效");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"].interpreter).toEqual({ model: null, thinking: null });
}, 5000);

test("清除用户层里模型和思考都跟随的设定后，提示写内置默认值：跟随主会话", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: null, thinking: null } }));
  const ctx = scripted([
    (s) => { goTo(s, "models"); s.press("R"); },
    (s) => {
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除用户层的 PM 设定，现在用内置默认值：跟随主会话");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("设置文件里 thinking 写 null 时列表写跟随，问题分类没有这一条", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: null } }));
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      expect(s.now()).toMatch(/▸ PM +用户 +gpt-6-luna +跟随 *\n/u);
      expect(s.now()).not.toMatch(/问题 +\d/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("来源为项目的 PM 按 R 后项目层这一项被删，改用内置默认值并提示", async () => {
  await writeSettings(projectFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: "low" } }));
  const ctx = scripted([
    (s) => { goTo(s, "models"); s.press("R"); },
    (s) => {
      expect(s.now()).toMatch(/▸ PM +内置 +跟随主会话 +跟随/u);
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除项目层的 PM 设定，现在用内置默认值：跟随主会话");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  const after = await readAgentSettings({ agentDir: agentDir(), repositoryRoot: repoDir(), projectTrusted: true });
  expect(after.layers.project.pm).toBeUndefined();
  expect(after.values.pm.source).toBe("default");
}, 5000);

test("项目层清除后下一层是用户层时，现在用用户层的值", async () => {
  await writeSettings(userFile(), oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "low" } }));
  await writeSettings(projectFile(), oneCompany({ pm: { model: "gpt-6-luna", thinking: "xhigh" } }));
  const ctx = scripted([
    (s) => { goTo(s, "models"); s.press("R"); },
    (s) => {
      expect(s.now()).toMatch(/已清除项目层的 PM 设定，现在用.*gpt-6\.1-sol · low/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  const after = await readAgentSettings({ agentDir: agentDir(), repositoryRoot: repoDir(), projectTrusted: true });
  expect(after.layers.project.pm).toBeUndefined();
  expect(after.layers.user.pm).toEqual({ model: "gpt-6.1-sol", thinking: "low" });
}, 5000);

test("来源为内置的 PM 按 R 只提示已经是内置默认值，不创建设置文件", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([(s) => { goTo(s, "models"); s.press("R"); expect(s.now()).toContain("已经是内置默认值"); s.press(ESC, ESC); }]);
  await run(ctx);
  expect(existsSync(userFile())).toBe(false);
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("设定里的模型没有凭据时这一行写不可用，选中时底部写明后果，模型列表里也不列它", async () => {
  await writeSettings(userFile(), oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "medium" } }));
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(DOWN);
      expect(s.now()).toMatch(/解释器 +用户 +gpt-6-luna ?不可用/u);
      expect(s.now()).toContain("✗ gpt-6-luna 没有可用的凭据，批准需求时解读会失败；回车重新选");
      s.press(ENTER);
      expect(s.now()).not.toMatch(/gpt-6-luna +5x/u);
      s.press(ESC, ESC, ESC);
    },
  ], { authorized: ["gpt-6.1-sol"] });
  await run(ctx);
}, 5000);

test("项目设置文件写错时问题分类出现这一条", async () => {
  await writeSettings(projectFile(), "{ not json");
  const ctx = scripted([
    (s) => {
      expect(s.now()).toMatch(/问题 +1/u);
      goTo(s, "problems");
      expect(s.now()).toMatch(/settings\.json +项目 +文件不是合法的 JSON/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("把 PM 存到项目层后，项目设置文件里原有的其他字段原样保留", async () => {
  await writeSettings(projectFile(), { theme: "dark", packages: ["x"] });
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ENTER);
      moveTo(s, "gpt-6-luna");
      s.press(ENTER);
      moveTo(s, "high");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => s.press(ESC, ESC),
  ]);
  await run(ctx);
  expect(await readJson(projectFile())).toEqual({ theme: "dark", packages: ["x"], "one-company": { pm: { model: "gpt-6-luna", thinking: "high" } } });
}, 5000);

test("Git 交付选远程存到用户层：用户设置文件写 git-delivery 为 remote，其他内容不变，重开后来源用户、状态远程、名字是绿色，提示写立即生效", async () => {
  await initRepoWithOrigin(repoDir(), null);
  await writeSettings(userFile(), { theme: "dark" });
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      expect(s.now()).toMatch(/▸ Git 交付 +内置 +仅本地/u);
      s.press(ENTER);
      moveTo(s, "远程");
      s.press(ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ Git 交付 +用户 +远程/u);
      expect(s.raw()).toMatch(/<success>Git 交付 *<\/>/u);
      expect(s.raw()).toContain("<success>✓ Git 交付 改为远程，存到用户层，立即生效</>");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(await readJson(userFile())).toEqual({ theme: "dark", "one-company": { "git-delivery": "remote" } });
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("Git 交付选仅本地存到项目层：项目设置文件写 git-delivery 为 local，提示写存到项目层", async () => {
  await writeSettings(userFile(), oneCompany({ "git-delivery": "remote" }));
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      s.press(ENTER);
      moveTo(s, "仅本地");
      s.press(ENTER);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ Git 交付 +项目 +仅本地/u);
      expect(s.now()).toContain("✓ Git 交付 改为仅本地，存到项目层，立即生效");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"]["git-delivery"]).toBe("local");
  expect((await readJson(userFile()))["one-company"]["git-delivery"]).toBe("remote");
}, 5000);

test("Git 交付按 R 清除项目层的 local：git-delivery 被删，提示现在用内置默认值：远程（origin 在 github.com，gh 已登录）", async () => {
  await initRepoWithOrigin(repoDir(), "git@github.com:acme/shop.git");
  gh.ghLoggedIn(["github.com"]);
  await writeSettings(projectFile(), oneCompany({ "git-delivery": "local" }));
  const ctx = scripted([
    (s) => { goTo(s, "switches"); s.press("R"); },
    (s) => {
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除项目层的 Git 交付 设定，现在用内置默认值：远程（origin 在 github.com，gh 已登录）");
      expect(s.now()).toMatch(/▸ Git 交付 +内置 +远程/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"]?.["git-delivery"]).toBeUndefined();
}, 5000);

test("Git 交付按 R 清除项目层的设定后下一层是用户层的值：提示现在用用户层，写出远程", async () => {
  await writeSettings(userFile(), oneCompany({ "git-delivery": "remote" }));
  await writeSettings(projectFile(), oneCompany({ "git-delivery": "local" }));
  const ctx = scripted([
    (s) => { goTo(s, "switches"); s.press("R"); },
    (s) => {
      expect(s.now()).toMatch(/✓ 已清除项目层的 Git 交付 设定，现在用用户层.*远程/u);
      expect(s.now()).toMatch(/▸ Git 交付 +用户 +远程/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"]?.["git-delivery"]).toBeUndefined();
  expect((await readJson(userFile()))["one-company"]["git-delivery"]).toBe("remote");
}, 5000);

test("项目层已写 local 时在开关里选远程存到用户层：用户文件写 remote，重开后这一行来源仍是项目、状态仅本地", async () => {
  await writeSettings(projectFile(), oneCompany({ "git-delivery": "local" }));
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      s.press(ENTER);
      moveTo(s, "远程");
      s.press(ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ Git 交付 +项目 +仅本地/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(userFile()))["one-company"]["git-delivery"]).toBe("remote");
}, 5000);

test("合并方式取消压缩合并和 rebase 合并后存到用户层：文件写 [merge]，状态普通合并，名字是绿色，提示写立即生效", async () => {
  await mkdir(repoDir(), { recursive: true });
  await writeSettings(userFile(), { theme: "dark" });
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      expect(s.now()).toMatch(/合并方式 +内置 +压缩 · 普通合并 · rebase/u);
      s.press(DOWN, ENTER, " ", DOWN, DOWN, " ", ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ 合并方式 +用户 +普通合并/u);
      expect(s.raw()).toMatch(/<success>合并方式 *<\/>/u);
      expect(s.raw()).toContain("<success>✓ 合并方式 改为 普通合并，存到用户层，立即生效</>");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(await readJson(userFile())).toEqual({ theme: "dark", "one-company": { "merge-methods": ["merge"] } });
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("合并方式全部取消后回车停在第 1 步，红字提示，再勾一种能存到项目层，文件按固定顺序写数组", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      s.press(DOWN, ENTER, " ", DOWN, " ", DOWN, " ", ENTER);
      expect(s.now()).toContain("第 1 步，共 2 步");
      expect(s.raw()).toMatch(/<error>[^\n]*✗ 至少勾一种合并方式/u);
      s.press(" ", UP, UP, " ", ENTER);
      expect(s.now()).toMatch(/合并方式 改为 压缩合并、rebase 合并，存到哪一层/u);
      moveTo(s, "项目层");
      s.press(ENTER);
    },
    (s) => {
      expect(s.now()).toMatch(/▸ 合并方式 +项目 +压缩合并 · rebase 合并/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(projectFile()))["one-company"]["merge-methods"]).toEqual(["squash", "rebase"]);
}, 5000);

test("合并方式按 R 清除用户层的设定：merge-methods 被删，提示现在用内置默认值：压缩合并、普通合并、rebase 合并", async () => {
  await writeSettings(userFile(), oneCompany({ "merge-methods": ["merge"] }));
  const ctx = scripted([
    (s) => { goTo(s, "switches"); s.press(DOWN, "R"); },
    (s) => {
      expect(s.now().split("\n").map((line) => line.trim())).toContain("✓ 已清除用户层的合并方式 设定，现在用内置默认值：压缩合并、普通合并、rebase 合并");
      expect(s.now()).toMatch(/▸ 合并方式 +内置 +压缩 · 普通合并 · rebase/u);
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect((await readJson(userFile()))["one-company"]?.["merge-methods"]).toBeUndefined();
}, 5000);

test("Git 交付和合并方式来源为内置时按 R 只提示已经是内置默认值，不创建设置文件", async () => {
  await mkdir(repoDir(), { recursive: true });
  const ctx = scripted([(s) => {
    goTo(s, "switches");
    s.press("R");
    expect(s.now()).toContain("已经是内置默认值");
    s.press(DOWN, "R");
    expect(s.now()).toContain("已经是内置默认值");
    s.press(ESC, ESC);
  }]);
  await run(ctx);
  expect(existsSync(userFile())).toBe(false);
  expect(existsSync(projectFile())).toBe(false);
}, 5000);

test("用户设置文件不是合法 JSON 时在模型里保存到用户层：底部用 error 色写没有保存并带文件路径，文件不变，页面仍开着", async () => {
  await mkdir(repoDir(), { recursive: true });
  await writeSettings(userFile(), "{ not json");
  const ctx = scripted([
    (s) => {
      goTo(s, "models");
      s.press(ENTER);
      moveTo(s, "gpt-6-luna");
      s.press(ENTER);
      moveTo(s, "high");
      s.press(ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      const line = s.now().split("\n").find((row) => row.includes("✗ 没有保存："));
      expect(line).toBeDefined();
      expect(line).toContain(userFile());
      expect(s.raw()).toContain("<error>✗ 没有保存：");
      expect(s.now()).toContain("/one:setting");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(await readFile(userFile(), "utf8")).toBe("{ not json");
}, 5000);

test("用户设置文件不是合法 JSON 时在开关里保存到用户层：底部用 error 色写没有保存并带文件路径，文件不变，页面仍开着", async () => {
  await mkdir(repoDir(), { recursive: true });
  await writeSettings(userFile(), "{ not json");
  const ctx = scripted([
    (s) => {
      goTo(s, "switches");
      s.press(ENTER);
      moveTo(s, "远程");
      s.press(ENTER);
      moveTo(s, "用户层");
      s.press(ENTER);
    },
    (s) => {
      const line = s.now().split("\n").find((row) => row.includes("✗ 没有保存："));
      expect(line).toBeDefined();
      expect(line).toContain(userFile());
      expect(s.raw()).toContain("<error>✗ 没有保存：");
      expect(s.now()).toContain("/one:setting");
      s.press(ESC, ESC);
    },
  ]);
  await run(ctx);
  expect(await readFile(userFile(), "utf8")).toBe("{ not json");
}, 5000);
