import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import startupTrust from "../src/modules/settings/startup-trust-extension.ts";
import { tilde } from "../src/modules/settings/settings-page-ui.ts";
import { runGit } from "./helpers/git-run.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bg: (_kind: string, text: string) => text, bold: (text: string) => `**${text}**`, inverse: (text: string) => text };
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\*\*/gu, "");

let root = "", repo = "", savedAgentDir: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-t-")));
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "agent"), { recursive: true });
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await runGit(["init", "-q"], repo);
});
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  await chmod(join(root, "agent"), 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const trustFile = () => join(process.env.PI_CODING_AGENT_DIR!, "trust.json");
const readTrust = async () => JSON.parse(await readFile(trustFile(), "utf8")) as Record<string, boolean>;
const writeTrust = (value: boolean) => writeFile(trustFile(), JSON.stringify({ [repo]: value }));

async function addAgents(count: number) {
  await mkdir(join(repo, ".pi", "agents"), { recursive: true });
  for (let i = 0; i < count; i++) await writeFile(join(repo, ".pi", "agents", `secret-name-${i}.md`), `---\nname: secret-name-${i}\n---\n正文`);
}

interface Options { reason?: string; hasUI?: boolean; width?: number; keys?: string[]; cwd?: string }
async function launch(options: Options = {}) {
  let handler: ((event: unknown, ctx: unknown) => Promise<void> | void) | undefined;
  startupTrust({ on: (event: string, fn: typeof handler) => { if (event === "session_start") handler = fn; } } as never);
  const screens: string[] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  let customCalls = 0;
  const ui = {
    theme,
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      customCalls++;
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        screens.push(component.render(options.width ?? 200).map((line) => line.trimEnd()).join("\n"));
        for (const key of options.keys ?? []) component.handleInput(key);
      });
    },
    notify(message: string, type?: string) { notices.push({ message, type }); },
  };
  const ctx = { hasUI: options.hasUI ?? true, cwd: options.cwd ?? repo, ui };
  await handler!({ type: "session_start", reason: options.reason ?? "startup" }, ctx);
  return { screen: screens[0] ?? "", screens, notices, customCalls: () => customCalls };
}

const TRUST_NOTICE = theme.fg("success", "✓ 已把本项目设为受信任，项目层的 5 份定义已生效");
const DENY_NOTICE = theme.fg("muted", "已把本项目记为不信任，项目层的定义不加载；要改时在 pi 里输入 /trust");
const LATER_NOTICE = theme.fg("muted", "这次没有加载项目层的 5 份定义，下次启动 pi 时再问");

describe("启动授信弹窗：触发条件", () => {
  test("五条都满足时弹窗", async () => {
    await addAgents(5);
    const r = await launch({ keys: [ESC] });
    expect(r.customCalls()).toBe(1);
  });

  const skipCases: Array<[string, () => Promise<Options | void>]> = [
    ["reason 为 new", async () => ({ reason: "new" })],
    ["reason 为 resume", async () => ({ reason: "resume" })],
    ["reason 为 fork", async () => ({ reason: "fork" })],
    ["reason 为 reload", async () => ({ reason: "reload" })],
    ["没有界面", async () => ({ hasUI: false })],
    ["记录为 true", async () => { await writeTrust(true); }],
    ["记录为 false", async () => { await writeTrust(false); }],
    ["项目没有 .pi/agents 目录", async () => { await rm(join(repo, ".pi"), { recursive: true, force: true }); }],
    ["启动目录有 .pi/settings.json", async () => { await writeFile(join(repo, ".pi", "settings.json"), "{}"); }],
    ["上级目录有 .agents/skills", async () => { await mkdir(join(root, ".agents", "skills"), { recursive: true }); }],
  ];
  for (const [name, prepare] of skipCases) {
    test(`不弹窗：${name}`, async () => {
      await addAgents(5);
      const options = (await prepare()) ?? {};
      const before = existsSync(trustFile()) ? await readFile(trustFile(), "utf8") : null;
      const r = await launch(options);
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toEqual([]);
      expect(existsSync(trustFile()) ? await readFile(trustFile(), "utf8") : null).toBe(before);
    });
  }

  test("不弹窗：.pi/agents 为空", async () => {
    await mkdir(join(repo, ".pi", "agents"), { recursive: true });
    const r = await launch();
    expect(r.customCalls()).toBe(0);
    expect(r.notices).toEqual([]);
    expect(existsSync(trustFile())).toBe(false);
  });
});

describe("启动授信弹窗：窗口文字", () => {
  test("标题、正文、选项、提示行符合规定，没有推荐和定义名", async () => {
    await addAgents(5);
    const r = await launch({ keys: [ESC] });
    const text = plain(r.screen);
    for (const part of ["要信任这个项目吗？", `项目：${repo}`, "项目里有角色定义，项目受信任后才会生效。",
      "你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。",
      "信任", "项目层马上生效，以后不再问", "不信任", "项目层不加载，以后不再问；要改时输入 /trust",
      "以后再说", "这次不加载，下次启动 pi 时再问", "↑↓ 选择 · 回车确认 · Esc 以后再说"]) expect(text).toContain(part);
    expect(text).not.toContain("推荐");
    expect(text).not.toContain("secret-name");
    expect(r.screen).toContain(theme.fg("muted", "你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。"));
    expect(r.screen).toContain("<warning>");
  });

  test("光标默认在信任", async () => {
    await addAgents(5);
    const r = await launch({ keys: [ESC] });
    const cursorLine = plain(r.screen).split("\n").find((line) => /^\s*→/u.test(line)) ?? "";
    expect(cursorLine).toContain("信任");
    expect(cursorLine).not.toContain("不信任");
  });
});

describe("启动授信弹窗：选择结果", () => {
  test("直接回车选信任：记录为 true，提示成功", async () => {
    await addAgents(5);
    const r = await launch({ keys: [ENTER] });
    expect(await readTrust()).toEqual({ [repo]: true });
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.message).toBe(TRUST_NOTICE);
  });

  test("下移再回车选不信任：记录为 false", async () => {
    await addAgents(5);
    const r = await launch({ keys: [DOWN, ENTER] });
    expect(await readTrust()).toEqual({ [repo]: false });
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.message).toBe(DENY_NOTICE);
  });

  test("下移两次再回车选以后再说：不写记录", async () => {
    await addAgents(5);
    const r = await launch({ keys: [DOWN, DOWN, ENTER] });
    expect(existsSync(trustFile())).toBe(false);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.message).toBe(LATER_NOTICE);
  });

  test("按 Esc：不写记录", async () => {
    await addAgents(5);
    const r = await launch({ keys: [ESC] });
    expect(existsSync(trustFile())).toBe(false);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.message).toBe(LATER_NOTICE);
  });

  test.skipIf(process.getuid?.() === 0)("授信记录文件只读时选信任：记录不变，红字提示前面不带 pi 的 Error: 前缀", async () => {
    await addAgents(5);
    await writeFile(trustFile(), "{}");
    await chmod(trustFile(), 0o444);
    const r = await launch({ keys: [ENTER] });
    expect(r.customCalls()).toBe(1);
    expect(await readFile(trustFile(), "utf8")).toBe("{}");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.type).not.toBe("error");
    expect(r.notices[0]!.message).toMatch(/^<error>✗ 没有记下你的选择：[^\n]+<\/>$/u);
  });

  test("从仓库子目录启动：按主仓库根目录判断和记录授信", async () => {
    await addAgents(5);
    const sub = join(repo, "packages", "web");
    await mkdir(sub, { recursive: true });
    const r = await launch({ cwd: sub, keys: [ENTER] });
    expect(r.customCalls()).toBe(1);
    expect(await readTrust()).toEqual({ [repo]: true });
  });
});

describe("启动授信弹窗：窄终端", () => {
  for (const width of [36, 44, 60, 80]) {
    test(`宽 ${width} 列时每行不超宽`, async () => {
      await addAgents(5);
      const r = await launch({ width, keys: [ESC] });
      const lines = r.screen.split("\n");
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) expect(visibleWidth(plain(line))).toBeLessThanOrEqual(width);
    });
  }
});

describe("启动授信弹窗：授信记录读不出来", () => {
  const brokenCases: Array<[string, () => string, RegExp]> = [
    ["不是合法 JSON", () => '{"a": true,}', /Failed to read trust store/u],
    ["值不是 true/false/null", () => JSON.stringify({ [repo]: "yes" }), /Invalid trust store/u],
  ];
  for (const [name, content, reasonPattern] of brokenCases) {
    test(`${name}：不弹窗，只给一条红字提示，记录原样不动`, async () => {
      await addAgents(5);
      const broken = content();
      await writeFile(trustFile(), broken);
      const r = await launch({ keys: [ENTER] });
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]!.type).toBeUndefined();
      const prefix = `<error>✗ 读不了授信记录 ${tilde(trustFile())}：`;
      const suffix = "；改好这个文件后再启动 pi</>";
      const message = r.notices[0]!.message;
      expect(message.startsWith(prefix)).toBe(true);
      expect(message.endsWith(suffix)).toBe(true);
      const reason = message.slice(prefix.length, message.length - suffix.length);
      expect(reason).toMatch(reasonPattern);
      expect(reason).not.toContain("\n");
      expect(await readFile(trustFile(), "utf8")).toBe(broken);
    });
  }

  test.skipIf(process.getuid?.() === 0)("授信记录所在目录只读：不弹窗，只给一条红字提示，记录仍不存在", async () => {
    await addAgents(5);
    await chmod(join(root, "agent"), 0o555);
    const r = await launch({ keys: [ENTER] });
    expect(r.customCalls()).toBe(0);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.type).not.toBe("error");
    expect(r.notices[0]!.message).toMatch(new RegExp(`^<error>✗ 读不了授信记录 ${tilde(trustFile()).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}：[^\\n]+；改好这个文件后再启动 pi</>$`, "u"));
    expect(existsSync(trustFile())).toBe(false);
  });

  const quietCases: Array<[string, () => Promise<Options | void>]> = [
    ["reason 为 resume", async () => ({ reason: "resume" })],
    ["项目没有 .pi/agents", async () => { await rm(join(repo, ".pi"), { recursive: true, force: true }); }],
  ];
  for (const [name, prepare] of quietCases) {
    test(`记录写坏且${name}：什么都不做`, async () => {
      await addAgents(5);
      const options = (await prepare()) ?? {};
      const broken = '{"a": true,}';
      await writeFile(trustFile(), broken);
      const r = await launch(options);
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toEqual([]);
      expect(await readFile(trustFile(), "utf8")).toBe(broken);
    });
  }
});
