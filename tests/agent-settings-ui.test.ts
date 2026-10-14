import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentCatalogView } from "../runtime/agent-catalog-ui.ts";
import { readAgentSettings, projectSettingsPath, userSettingsPath } from "../runtime/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { openSettingsPage } from "../extensions/settings.ts";
import type { SettingsExtensionContext } from "../extensions/settings.ts";

const RIGHT = "\x1b[C", UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
const SOL = { provider: "5x", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LUNA = { provider: "5x", id: "gpt-6-luna", reasoning: true, thinkingLevelMap: { minimal: null, max: null } };
const OPENAI_SOL = { provider: "openai", id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: {} };
const LONG = { provider: "some-long-provider", id: "claude-opus-5-5-extended-context-preview", reasoning: true, thinkingLevelMap: {} };
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

function moveToRowWith(screen: Screen, word: string) {
  const here = () => selectedLine(screen.text()).split(/\s+/u).includes(word);
  for (let i = 0; i < 8 && !here(); i++) screen.press(DOWN);
  for (let i = 0; i < 16 && !here(); i++) screen.press(UP);
  if (!here()) throw new Error(`光标移不到含 ${word} 的行：\n${screen.text()}`);
}

interface ViewOptions { trusted?: boolean; user?: unknown; project?: unknown; models?: unknown[]; mainModel?: unknown; mainThinking?: string }
async function settingsView(options: ViewOptions = {}) {
  const trusted = options.trusted ?? true;
  if (options.user !== undefined) await writeSettings(userFile(), options.user);
  if (options.project !== undefined) await writeSettings(projectFile(), options.project);
  const settings = await readAgentSettings({ agentDir: agentDir(), repositoryRoot: repoDir(), projectTrusted: trusted });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p"), parseFrontmatter, projectTrusted: trusted });
  const saves: unknown[] = [], clears: unknown[] = []; let closed = false;
  const view = new AgentCatalogView({ catalog, theme, projectTrusted: trusted, untrustedProjectCount: 0, nameTaken: () => undefined, onCopy() {}, onClose: () => { closed = true; },
    settings, models: options.models ?? [SOL, LUNA], mainModel: "mainModel" in options ? options.mainModel : SOL, mainThinking: options.mainThinking ?? "high",
    onSaveSetting: (request: unknown) => saves.push(request), onClearSetting: (request: unknown) => clears.push(request) } as ConstructorParameters<typeof AgentCatalogView>[0]);
  const text = (width = 80) => view.render(width).join("\n");
  const press = (...keys: string[]) => { for (const key of keys) view.handleInput(key); };
  const screen: Screen = { text, press };
  const toSettings = () => press(RIGHT, RIGHT, RIGHT, RIGHT);
  return { view, text, press, screen, saves, clears, closed: () => closed, toSettings };
}

test("按右键到最右边的分类栏，看到“设定 3”且不再有“内部”", async () => {
  const p = await settingsView();
  p.toSettings();
  expect(p.text()).toMatch(/^ {2}worker \d+ .*│ {2}设定 3 $/mu);
  expect(p.text()).not.toContain("内部");
});

test("设定栏没有设定时三行都是内置来源、模型跟随主会话、思考跟随", async () => {
  const p = await settingsView();
  p.toSettings();
  const text = p.text();
  expect(text).toMatch(/名称 +来源 +模型 +思考/u);
  expect(text).toMatch(/› PM +内置 +跟随主会话 +跟随 *\n/u);
  expect(text).toMatch(/解释器 +内置 +跟随主会话 +跟随 *\n/u);
  expect(text).toMatch(/草稿核验器 +内置 +跟随主会话 +跟随 *\n/u);
  expect(text).not.toContain("不思考");
});

test("思考设成 null 时思考列写“跟随”，同一行写了具体模型照写；解释器的 off 仍写“不思考”", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: null }, interpreter: { model: null, thinking: "off" }, "draft-verifier": { model: null, thinking: null } }) });
  p.toSettings();
  expect(p.text()).toMatch(/PM +用户 +gpt-6-luna +跟随 *\n/u);
  expect(p.text()).toMatch(/解释器 +用户 +跟随主会话 +不思考/u);
  expect(p.text()).toMatch(/草稿核验器 +用户 +跟随主会话 +跟随 *\n/u);
});

test("模型为 null 时即使本机没有任何有凭据的模型，这一行也不写“不可用”，底部不报错", async () => {
  const p = await settingsView({ models: [], mainModel: undefined });
  p.toSettings();
  expect(p.text()).not.toContain("不可用");
  expect(p.text()).not.toContain("✗");
});

test("底部一行写用途、来源说明和生效时机，随选中行变化", async () => {
  const p = await settingsView({ user: oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "low" } }), project: oneCompany({ "draft-verifier": { model: "gpt-6-luna", thinking: "high" } }) });
  p.toSettings();
  expect(p.text()).toContain("PM：活动需求的负责人，拆任务、派工、调度 · 内置默认值 · 下次启动 PM 时生效");
  p.press(DOWN);
  expect(p.text()).toContain("解释器：把用户原话解读成结构化决定 · 来自用户层 · 下次调用时生效");
  p.press(DOWN);
  expect(p.text()).toContain("草稿核验器：核对需求草稿是不是用户原话要求的 · 来自项目层 · 下次调用时生效");
});

test("设定栏按键提示写明回车修改与 R 清除本层", async () => {
  const p = await settingsView();
  p.toSettings();
  expect(p.text()).toContain("←→ 分类  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出");
});

test("设定栏里按 Esc 直接退出页面", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ESC);
  expect(p.closed()).toBe(true);
});

test("来源标签随层显示，解释器的 off 显示为不思考，PM 的 off 照写 off", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "off" }, interpreter: { model: "gpt-6-luna", thinking: "off" } }) });
  p.toSettings();
  expect(p.text()).toMatch(/PM +用户 +gpt-6\.1-sol +off *\n/u);
  expect(p.text()).toMatch(/解释器 +用户 +gpt-6-luna +不思考/u);
});

test("模型设成跟随主会话（null）时模型列显示“跟随主会话”", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: null, thinking: "high" } }) });
  p.toSettings();
  expect(p.text()).toMatch(/PM +用户 +跟随主会话 +high/u);
  expect(p.text()).not.toContain("不可用");
});

test("回车进入第 1 步：列出有凭据的模型和提供方，末项跟随主会话写明现在是什么，当前生效项打勾", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: "high" } }) });
  p.toSettings();
  p.press(ENTER);
  const text = p.text();
  expect(text).toMatch(/修改 PM 的模型 +第 1 步，共 3 步/u);
  expect(text).toMatch(/gpt-6\.1-sol +5x/u);
  expect(text).toMatch(/✓ +gpt-6-luna +5x/u);
  expect(text).not.toMatch(/✓ +gpt-6\.1-sol/u);
  expect(text).toMatch(/跟随主会话 +现在是 5x\/gpt-6\.1-sol/u);
  expect(text).toContain("只列出本机配了凭据的模型");
  expect(text).toContain("↑↓ 选择  回车 下一步  Esc 取消");
});

test("没有可选模型时第 1 步只有跟随主会话，并提示先在 pi 里登录；选它后保存的 model 为 null", async () => {
  const p = await settingsView({ models: [] });
  p.toSettings();
  p.press(ENTER);
  const text = p.text();
  expect(text).toMatch(/修改 PM 的模型 +第 1 步，共 3 步/u);
  expect(text).toMatch(/跟随主会话 +现在是 5x\/gpt-6\.1-sol/u);
  expect(text).not.toMatch(/gpt-6-luna|gpt-6\.1-sol +5x/u);
  expect(text).toContain("本机还没有其他配了凭据的模型，先在 pi 里登录模型服务");
  expect(text).toContain("回车 下一步  Esc 取消");
  p.press(ENTER);
  moveTo(p.screen, "high");
  p.press(ENTER);
  moveTo(p.screen, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: null, thinking: "high", layer: "project" }]);
});

test("第 2 步：所选模型不支持的等级变灰并写原因，光标上下都跳过；当前值打勾；跟随主会话总是可选", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: "gpt-6-luna", thinking: "high" } }) });
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "gpt-6-luna");
  p.press(ENTER);
  const text = p.text();
  expect(text).toMatch(/修改 PM 的思考等级 +第 2 步，共 3 步/u);
  for (const level of ["off", "low", "medium", "high", "xhigh"]) expect(text, level).toMatch(new RegExp(`${level} *\\n`, "u"));
  expect(text).toMatch(new RegExp(`minimal +${GRAY_NOTE.source}`, "u"));
  expect(text).toMatch(new RegExp(`max +${GRAY_NOTE.source}`, "u"));
  expect(text).toMatch(/✓ +high/u);
  expect(text).toContain("↑↓ 选择  回车 下一步  Esc 上一步");
  const visited = new Set<string>();
  for (const key of [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, UP, UP, UP, UP, UP, UP, UP, UP]) {
    p.press(key);
    visited.add(selectedLine(p.text()).replace(/[›✓]/gu, "").trim().split(/\s+/u)[0]!);
  }
  expect([...visited].sort()).toEqual(expect.arrayContaining(["off", "xhigh", "跟随主会话"]));
  expect(visited.has("minimal")).toBe(false);
  expect(visited.has("max")).toBe(false);
});

test("第 2 步在 max 后面多一项“跟随主会话”，后面写主窗口当前思考等级", async () => {
  const p = await settingsView({ mainThinking: "high" });
  p.toSettings();
  p.press(ENTER, ENTER);
  const lines = p.text().split("\n");
  const max = lines.findIndex((line) => /\bmax\b/u.test(line)), follow = lines.findIndex((line, index) => index > max && line.includes("跟随主会话"));
  expect(max).toBeGreaterThan(0);
  expect(follow).toBe(max + 1);
  expect(lines[follow]).toMatch(/跟随主会话 +现在是 high *$/u);
});

test("主窗口思考等级是 off 时：PM 写“现在是 off”，解释器和草稿核验器写“现在是 不思考”", async () => {
  const p = await settingsView({ mainThinking: "off" });
  p.toSettings();
  p.press(ENTER, ENTER);
  expect(p.text()).toMatch(/跟随主会话 +现在是 off *\n/u);
  const q = await settingsView({ mainThinking: "off" });
  q.toSettings();
  q.press(DOWN, ENTER, ENTER);
  expect(q.text()).toMatch(/跟随主会话 +现在是 不思考 *\n/u);
  const r = await settingsView({ mainThinking: "off" });
  r.toSettings();
  r.press(DOWN, DOWN, ENTER, ENTER);
  expect(r.text()).toMatch(/跟随主会话 +现在是 不思考 *\n/u);
});

test("第 2 步当前生效的思考是跟随时，✓ 打在“跟随主会话”上，别的等级没有 ✓", async () => {
  const p = await settingsView({ user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: null } }) });
  p.toSettings();
  p.press(ENTER, ENTER);
  const checked = p.text().split("\n").filter((line) => line.includes("✓"));
  expect(checked).toHaveLength(1);
  expect(checked[0]).toMatch(/✓ +跟随主会话/u);
});

test("没有设定时第 2 步光标默认停在“跟随主会话”，直接回车再选项目层，保存请求的 thinking 为 null", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER, ENTER);
  expect(selectedLine(p.text())).toMatch(/跟随主会话/u);
  p.press(ENTER);
  moveTo(p.screen, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: null, thinking: null, layer: "project" }]);
});

test("选了不支持部分等级的模型后，“跟随主会话”仍可选，保存请求的 thinking 为 null", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p.screen, "跟随主会话");
  expect(selectedLine(p.text())).toMatch(/跟随主会话/u);
  p.press(ENTER);
  moveTo(p.screen, "用户层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: null, layer: "user" }]);
});

test("主窗口思考是 max、选了不支持 max 的模型时，“跟随主会话”仍可选、备注现在是 max，保存的 thinking 为 null", async () => {
  const p = await settingsView({ mainThinking: "max" });
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "gpt-6-luna");
  p.press(ENTER);
  expect(p.text()).toMatch(/max +gpt-6-luna 不支持/u);
  moveTo(p.screen, "跟随主会话");
  expect(selectedLine(p.text())).toMatch(/跟随主会话 +现在是 max/u);
  p.press(ENTER);
  moveTo(p.screen, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: null, layer: "project" }]);
});

test("草稿核验器设成 { model: null, thinking: off } 时思考列写“不思考”", async () => {
  const p = await settingsView({ user: oneCompany({ "draft-verifier": { model: null, thinking: "off" } }) });
  p.toSettings();
  expect(p.text()).toMatch(/草稿核验器 +用户 +跟随主会话 +不思考/u);
});

test("第 3 步标题里模型和思考都是跟随时写“跟随主会话 · 跟随”", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER, ENTER, ENTER);
  expect(p.text()).toMatch(/PM 改为 跟随主会话 · 跟随，存到哪一层 +第 3 步，共 3 步/u);
});

test("第 2 步选的是跟随主会话时，按主窗口当前模型判断支持的等级", async () => {
  const p = await settingsView({ mainModel: LUNA });
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "跟随主会话");
  p.press(ENTER);
  expect(p.text()).toMatch(/minimal +(5x\/)?gpt-6-luna 不支持/u);
  expect(p.text()).toMatch(/max +(5x\/)?gpt-6-luna 不支持/u);
});

test("第 3 步：项目层和用户层各写文件位置与适用范围，标题写明改成什么", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p.screen, "xhigh");
  p.press(ENTER);
  const text = p.text();
  expect(text).toMatch(/PM 改为 gpt-6-luna · xhigh，存到哪一层 +第 3 步，共 3 步/u);
  expect(text).toMatch(/项目层 +\.pi\/settings\.json · 只对这个项目生效/u);
  expect(text).toMatch(/用户层 +~\/\.pi\/agent\/settings\.json · 所有项目/u);
  expect(text).toContain("↑↓ 选择  回车 保存  Esc 上一步");
});

test("选 gpt-6-luna、xhigh、项目层后，回调收到完整的保存请求", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER);
  moveTo(p.screen, "gpt-6-luna");
  p.press(ENTER);
  moveTo(p.screen, "xhigh");
  p.press(ENTER);
  moveTo(p.screen, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: "xhigh", layer: "project" }]);
});

test("选用户层时保存请求的 layer 是 user，改的是选中的那一行角色", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(DOWN, ENTER);
  moveTo(p.screen, "gpt-6.1-sol");
  p.press(ENTER);
  moveTo(p.screen, "low");
  p.press(ENTER);
  moveTo(p.screen, "用户层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "interpreter", model: "gpt-6.1-sol", thinking: "low", layer: "user" }]);
});

test("项目未受信任时第 3 步项目层不可选并写明原因，光标停在用户层，回车存到用户层", async () => {
  const p = await settingsView({ trusted: false });
  p.toSettings();
  p.press(ENTER, ENTER, ENTER);
  const text = p.text();
  expect(text).toMatch(/项目层 +项目未受信任，项目层的设定不会生效/u);
  expect(text).toContain("在 pi 里把这个项目设为受信任后，才能存到项目层");
  expect(selectedLine(text)).toMatch(/用户层/u);
  p.press(UP);
  expect(selectedLine(p.text())).toMatch(/用户层/u);
  p.press(ENTER);
  expect(p.saves).toMatchObject([{ role: "pm", layer: "user" }]);
});

test("Esc 逐步退回上一步，第一步 Esc 取消，什么也不保存，底部写已取消修改", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press(ENTER, ENTER, ENTER);
  expect(p.text()).toMatch(/第 3 步，共 3 步/u);
  p.press(ESC);
  expect(p.text()).toMatch(/第 2 步，共 3 步/u);
  p.press(ESC);
  expect(p.text()).toMatch(/第 1 步，共 3 步/u);
  p.press(ESC);
  expect(p.text()).toContain("已取消修改");
  expect(p.text()).toContain("R 清除本层");
  expect(p.saves).toEqual([]);
  expect(p.closed()).toBe(false);
});

test("来源是内置的按 R 只提示已经是内置默认值，不发清除请求", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press("r");
  expect(p.text()).toContain("已经是内置默认值");
  expect(p.clears).toEqual([]);
});

test("来源是项目或用户的按 R，回调收到清除请求", async () => {
  const p = await settingsView({ project: oneCompany({ pm: { model: "gpt-6-luna", thinking: "low" } }) });
  p.toSettings();
  p.press("r");
  expect(p.clears).toMatchObject([{ role: "pm" }]);
  const q = await settingsView({ user: oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "low" } }) });
  q.toSettings();
  q.press(DOWN, "R");
  expect(q.clears).toMatchObject([{ role: "interpreter" }]);
});

test("生效的模型在本机找不到有凭据的同名模型时，这一行写“不可用”，选中时底部写明后果", async () => {
  const p = await settingsView({
    user: oneCompany({ interpreter: { model: "claude-opus-5-5", thinking: "medium" }, "draft-verifier": { model: "claude-opus-5-5", thinking: "medium" } }),
    project: oneCompany({ pm: { model: "claude-opus-5-5", thinking: "high" } }),
  });
  p.toSettings();
  expect(p.text()).toMatch(/PM +项目 +claude-opus-5-5 ?不可用/u);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，启动 PM 会失败；回车重新选");
  p.press(DOWN);
  expect(p.text()).toMatch(/解释器 +用户 +claude-opus-5-5 ?不可用/u);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，批准需求时解读会失败；回车重新选");
  p.press(DOWN);
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，起草或修改需求草稿时核验会失败；回车重新选");
});

test("模型有凭据的行不写“不可用”", async () => {
  const p = await settingsView();
  p.toSettings();
  expect(p.text()).not.toContain("不可用");
});

test("问题分类列出设定文件写错的那一条，项目未受信任那条改成包含定义和设定", async () => {
  const p = await settingsView({ project: "{ not json" });
  p.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
  expect(p.text()).toMatch(/settings\.json +项目 +文件不是合法的 JSON，这一层的设定都没有生效/u);
  const u = await settingsView({ trusted: false });
  u.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
  expect(u.text()).toContain("项目未受信任，项目层的定义和设定没有生效");
});

test("各分类和每一步的画面，在 44、56、80 列下都不超出终端宽度", async () => {
  for (const width of [44, 56, 80]) {
    for (const trusted of [true, false]) {
      for (const keys of [[], [ENTER], [ENTER, ENTER], [ENTER, ENTER, ENTER]]) {
        const q = await settingsView({ trusted });
        q.toSettings();
        q.press(...keys);
        for (const line of q.text(width).split("\n")) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
      }
    }
  }
});

test("三步选择画面的按键提示放不下时按一组按键折行，一组不被拆开，36 到 80 列下每行都不超出终端宽度", async () => {
  const groupsOf = (hint: string) => hint.split("  ");
  const screens: Array<{ hint: string; keys: string[]; models?: unknown[] }> = [
    { hint: "↑↓ 选择  回车 下一步  Esc 取消", keys: [ENTER] },
    { hint: "回车 下一步  Esc 取消", keys: [ENTER], models: [] },
    { hint: "↑↓ 选择  回车 下一步  Esc 上一步", keys: [ENTER, ENTER] },
    { hint: "↑↓ 选择  回车 保存  Esc 上一步", keys: [ENTER, ENTER, ENTER] },
  ];
  for (const { hint, keys, models } of screens) {
    const groups = groupsOf(hint);
    for (let width = 36; width <= 80; width++) {
      const q = await settingsView({ ...(models ? { models } : {}) });
      q.toSettings();
      q.press(...keys);
      const rows = q.text(width).split("\n");
      for (const row of rows) expect(visibleWidth(row), `${hint} ${width}: ${row}`).toBeLessThanOrEqual(width);
      const hintRows = rows.map((row) => row.trim()).filter((row) => row && row.split("  ").every((group) => groups.includes(group)));
      expect(hintRows.flatMap((row) => row.split("  ")), `${hint} ${width}`).toEqual(groups);
      if (visibleWidth(` ${hint}`) <= width) expect(hintRows, `${hint} ${width}`).toHaveLength(1);
    }
  }
});

test("设定栏里 PM 那一行的底部灰字在 36 列下折行后，任何一行都不以顿号或逗号开头", async () => {
  const p = await settingsView();
  p.toSettings();
  const rows = p.text(36).split("\n");
  expect(rows.some((row) => row.trimStart().startsWith("PM："))).toBe(true);
  for (const row of rows) {
    expect(visibleWidth(row), row).toBeLessThanOrEqual(36);
    expect(row.trimStart(), row).not.toMatch(/^[、，]/u);
  }
});

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
const toSettings = (s: PageScreen) => s.press(RIGHT, RIGHT, RIGHT, RIGHT);

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
      s.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
      expect(s.now()).toMatch(/settings\.json +项目 +文件不是合法的 JSON/u);
      s.press(ESC);
    },
  ]);
  await run(ctx);
}, 5000);

test("36 到 80 列下，设定栏列表和三步选择、未受信任、模型不可用、没有可选模型的每一行都不超出终端宽度", async () => {
  const toLongModel = (p: Awaited<ReturnType<typeof settingsView>>) => { p.press(UP, UP, UP, UP, UP, DOWN); };
  const screens: Array<[string, Awaited<ReturnType<typeof settingsView>>]> = [];
  const open = async (label: string, options: ViewOptions, keys: string[], pick = false) => {
    const p = await settingsView({ models: [SOL, LONG], ...options });
    p.toSettings();
    p.press(DOWN, DOWN, ...keys.slice(0, 1));
    if (keys.length) { if (pick) toLongModel(p); p.press(...keys.slice(1)); }
    screens.push([label, p]);
  };
  await open("设定栏列表", {}, []);
  await open("第 1 步", {}, [ENTER]);
  await open("第 2 步", {}, [ENTER, ENTER], true);
  await open("第 3 步", {}, [ENTER, ENTER, ENTER], true);
  await open("未受信任的第 3 步", { trusted: false }, [ENTER, ENTER, ENTER], true);
  await open("模型不可用的列表", { user: oneCompany({ "draft-verifier": { model: "claude-opus-5-5-extended-context-preview-x", thinking: "medium" } }) }, []);
  await open("没有可选模型的第 1 步", { models: [] }, [ENTER]);
  for (const [label, p] of screens) {
    for (let width = 36; width <= 80; width++) {
      for (const line of p.text(width).split("\n")) expect(visibleWidth(line), `${label} ${width} 列：${line}`).toBeLessThanOrEqual(width);
    }
  }
});

test("36 到 80 列下，第 2 步多出的“跟随主会话”项和跟随值的列表每一行都不超出终端宽度", async () => {
  const screens: Array<[string, Awaited<ReturnType<typeof settingsView>>]> = [];
  for (const mainThinking of ["off", "xhigh"]) {
    for (const user of [undefined, oneCompany({ pm: { model: "claude-opus-5-5-extended-context-preview", thinking: null }, interpreter: { model: null, thinking: null }, "draft-verifier": { model: null, thinking: "off" } })]) {
      for (const keys of [[], [ENTER, ENTER], [DOWN, ENTER, ENTER], [DOWN, DOWN, ENTER, ENTER], [ENTER, ENTER, ENTER]]) {
        const p = await settingsView({ models: [SOL, LONG], mainThinking, ...(user ? { user } : {}) });
        p.toSettings();
        p.press(...keys);
        if (keys.length !== 3 && keys.length > 0) expect(p.text(80)).toMatch(new RegExp(`跟随主会话 +现在是 (${mainThinking}|不思考)`, "u"));
        screens.push([`${mainThinking} ${user ? "有设定" : "默认"} ${keys.length}`, p]);
      }
    }
  }
  for (const [label, p] of screens) {
    for (let width = 36; width <= 80; width++) {
      for (const line of p.text(width).split("\n")) expect(visibleWidth(line), `${label} ${width} 列：${line}`).toBeLessThanOrEqual(width);
    }
  }
});

test("两家提供方都有 gpt-6.1-sol 时，选 openai 那一行保存的 model 是 openai/gpt-6.1-sol；唯一的 gpt-6-luna 仍不带提供方", async () => {
  const models = [OPENAI_SOL, SOL, LUNA];
  const p = await settingsView({ models });
  p.toSettings();
  p.press(ENTER);
  moveToRowWith(p.screen, "openai");
  p.press(ENTER);
  moveTo(p.screen, "high");
  p.press(ENTER);
  moveTo(p.screen, "项目层");
  p.press(ENTER);
  expect(p.saves).toEqual([{ role: "pm", model: "openai/gpt-6.1-sol", thinking: "high", layer: "project" }]);
  const q = await settingsView({ models });
  q.toSettings();
  q.press(ENTER);
  moveTo(q.screen, "gpt-6-luna");
  q.press(ENTER);
  moveTo(q.screen, "high");
  q.press(ENTER);
  moveTo(q.screen, "项目层");
  q.press(ENTER);
  expect(q.saves).toEqual([{ role: "pm", model: "gpt-6-luna", thinking: "high", layer: "project" }]);
});

test("设定里的裸模型名在本机有多个提供方时，这一行不可用，底部写“多个提供方”而不是没有凭据", async () => {
  const p = await settingsView({ models: [OPENAI_SOL, SOL, LUNA], mainModel: { provider: "anthropic", id: "claude-x", reasoning: true, thinkingLevelMap: {} },
    user: oneCompany({ pm: { model: "gpt-6.1-sol", thinking: "high" } }) });
  p.toSettings();
  expect(p.text()).toMatch(/PM +用户 +gpt-6\.1-sol ?不可用/u);
  const rows = p.text(60).split("\n");
  for (const row of rows) expect(visibleWidth(row), row).toBeLessThanOrEqual(60);
  const start = rows.findIndex((line) => line.trimStart().startsWith("✗ "));
  expect(start).toBeGreaterThan(-1);
  const end = rows.findIndex((line, index) => index > start && (/^─+$/u.test(line) || line.includes("←→ 分类")));
  const footer = rows.slice(start, end).map((line) => line.trimStart()).join("");
  expect(footer).toContain("多个提供方");
  expect(footer).toContain("启动 PM 会失败");
  expect(footer).not.toContain("没有可用的凭据");
});

test("设定里的模型不在可选模型里时，底部仍写没有可用的凭据和后果", async () => {
  const p = await settingsView({ models: [OPENAI_SOL, SOL, LUNA], user: oneCompany({ pm: { model: "claude-opus-5-5", thinking: "high" } }) });
  p.toSettings();
  expect(p.text()).toContain("✗ claude-opus-5-5 没有可用的凭据，启动 PM 会失败；回车重新选");
});

test("来源为内置时按 R，底部提示恰好是“已经是内置默认值”", async () => {
  const p = await settingsView();
  p.toSettings();
  p.press("R");
  expect(p.text().split("\n").map((line) => line.trim())).toContain("已经是内置默认值");
});

test("项目设置文件里思考等级写错时，问题栏的文件列显示路径，展开写影响是这一项没有生效改用下一层", async () => {
  const p = await settingsView({ project: oneCompany({ pm: { model: "gpt-6-luna", thinking: "super" } }) });
  p.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
  const row = p.text().split("\n").find((line) => line.includes("项目") && line.includes("super")) ?? "";
  expect(row).toMatch(/\S*\/\S*settings\.json/u);
  expect(row).toContain("super");
  p.press(ENTER);
  expect(p.text()).toMatch(/影响 +这一项没有生效，改用下一层/u);
});

test("agent 目录名叫 .pi 时，用户层坏文件在问题栏的层标签仍是“用户”", async () => {
  process.env.PI_CODING_AGENT_DIR = join(root, "home", ".pi");
  const p = await settingsView({ user: "{ not json" });
  p.press(RIGHT, RIGHT, RIGHT, RIGHT, RIGHT);
  expect(p.text()).toMatch(/用户 +文件不是合法的 JSON/u);
  expect(p.text()).not.toMatch(/项目 +文件不是合法的 JSON/u);
});

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

test("清除请求带上层：来源为项目是 project，来源为用户是 user", async () => {
  const p = await settingsView({ project: oneCompany({ pm: { model: "gpt-6-luna", thinking: "low" } }) });
  p.toSettings();
  p.press("r");
  expect(p.clears).toEqual([{ role: "pm", layer: "project" }]);
  const q = await settingsView({ user: oneCompany({ interpreter: { model: "gpt-6-luna", thinking: "low" } }) });
  q.toSettings();
  q.press(DOWN, "r");
  expect(q.clears).toEqual([{ role: "interpreter", layer: "user" }]);
});
