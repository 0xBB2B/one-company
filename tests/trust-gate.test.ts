import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTrustGate } from "../src/app/extension/trust-gate.ts";
import { tilde } from "../src/modules/settings/settings-page-ui.ts";
import { runGit } from "./helpers/git-run.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bg: (_kind: string, text: string) => text, bold: (text: string) => `**${text}**`, inverse: (text: string) => text };
const plain = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\*\*/gu, "");
const REASONS = ["startup", "new", "resume", "fork", "reload"];

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

const TRUST_NOTICE = theme.fg("success", "✓ 已把本项目设为受信任，OneCompany 已启用");
const DENY_NOTICE = theme.fg("muted", "OneCompany 在这个项目停用：已记为不信任。要用时在 pi 里输入 /trust 选 Trust，再重开 pi");
const LATER_NOTICE = theme.fg("muted", "OneCompany 这次没有启用，下次启动 pi 时再问");
const DENIED_NOTICE = theme.fg("muted", "OneCompany 在这个项目停用：你选过不信任这个项目。要用时在 pi 里输入 /trust 选 Trust，再重开 pi");
const EMPTY_COMMAND_NOTICE = theme.fg("muted", "OneCompany 在这个项目停用：项目还没授信。重开 pi 时在弹窗里选信任即可启用");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(activateOnRegister = true, settings: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const toolNames: string[] = [];
  const tools = new Map<string, { name: string; parameters?: unknown; execute?: (...args: unknown[]) => Promise<unknown> }>();
  let active = ["read", "bash"];
  const setActiveCalls: string[][] = [];
  return {
    handlers, commands, setActiveCalls, tools,
    active: () => active,
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) { commands.set(name, options.handler); },
    registerTool(tool: { name: string; parameters?: unknown; execute?: (...args: unknown[]) => Promise<unknown> }) {
      toolNames.push(tool.name);
      tools.set(tool.name, tool);
      if (activateOnRegister && !active.includes(tool.name)) active = [...active, tool.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { setActiveCalls.push(names); active = [...names]; },
    getSettings: () => settings,
    getAllTools: () => ["read", "bash", "grep", ...toolNames].map((name) => ({ name })),
  };
}

interface Options { reason?: string; hasUI?: boolean; width?: number; keys?: string[]; cwd?: string; resumed?: boolean; customThrows?: boolean; skipStart?: boolean; hold?: boolean; settings?: Record<string, unknown> }
async function launch(options: Options = {}) {
  const pi = fakePi(!options.resumed, options.settings);
  const gate = createTrustGate(pi as never) as unknown as ReturnType<typeof fakePi>;
  const calls = { sessionStart: 0, otherEvent: 0, command: 0, tool: 0 };
  gate.on("session_start", () => { calls.sessionStart++; });
  gate.registerTool({
    name: "bash",
    parameters: { properties: { command: {}, timeout: {}, background: {} } },
    execute: async () => {
      if (calls.sessionStart === 0) throw new Error("shell_not_ready");
      return { content: [{ type: "text", text: "fake-bash" }] };
    },
  });
  gate.on("before_agent_start", () => { calls.otherEvent++; });
  gate.registerCommand("one:demo", { handler: () => { calls.command++; } });
  gate.registerTool({ name: "one_demo_tool", execute: async () => { calls.tool++; return { content: [{ type: "text", text: "demo-ok" }] }; } });

  const screens: string[] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const atDialog: { sessionStart: number; active: string[] }[] = [];
  let customCalls = 0;
  const ui = {
    theme,
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      customCalls++;
      if (options.customThrows) throw new Error("boom");
      atDialog.push({ sessionStart: calls.sessionStart, active: pi.active() });
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        screens.push(component.render(options.width ?? 200).map((line) => line.trimEnd()).join("\n"));
        for (const key of options.keys ?? []) component.handleInput(key);
      });
    },
    notify(message: string, type?: string) { notices.push({ message, type }); },
  };
  const ctx = { hasUI: options.hasUI ?? true, cwd: options.cwd ?? repo, ui };
  const bashCtx = { ...ctx, sessionManager: { getSessionId: () => "sess-test", getSessionFile: () => undefined }, model: undefined, thinkingLevel: undefined };
  const startSession = async (reason = options.reason ?? "startup") => {
    for (const handler of pi.handlers.get("session_start") ?? []) {
      try { await handler({ type: "session_start", reason }, ctx); } catch { /* pi 逐个 try/catch，出错后继续执行后面的处理 */ }
    }
  };
  if (options.hold) {
    void startSession();
    while (customCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  } else if (!options.skipStart) await startSession();
  return {
    screen: screens[0] ?? "", notices, calls, atDialog, customCalls: () => customCalls,
    activeTools: () => pi.active(),
    fireOtherEvent: async () => { for (const handler of pi.handlers.get("before_agent_start") ?? []) await handler({ type: "before_agent_start" }, ctx); },
    runCommand: async () => { await pi.commands.get("one:demo")!("", ctx); },
    runDemoTool: async () => JSON.stringify(await pi.tools.get("one_demo_tool")!.execute!("id", {}, undefined, undefined, bashCtx)),
    bashParameters: () => JSON.stringify(pi.tools.get("bash")!.parameters),
    runBash: async (command = "echo hi") => JSON.stringify(await pi.tools.get("bash")!.execute!("id", { command }, undefined, undefined, bashCtx)),
  };
}
type Launched = Awaited<ReturnType<typeof launch>>;

async function expectEnabled(r: Launched) {
  expect(r.calls.sessionStart).toBe(1);
  await r.fireOtherEvent();
  expect(r.calls.otherEvent).toBe(1);
  await r.runCommand();
  expect(r.calls.command).toBe(1);
  expect(await r.runDemoTool()).toContain("demo-ok");
  expect(r.calls.tool).toBe(1);
  expect(r.activeTools()).toEqual(expect.arrayContaining(["read", "bash", "one_demo_tool"]));
  expect(await r.runBash()).toContain("fake-bash");
  expect(r.bashParameters()).toContain("background");
}
async function expectDisabled(r: Launched) {
  expect(r.calls.sessionStart).toBe(0);
  await r.fireOtherEvent();
  expect(r.calls.otherEvent).toBe(0);
  await r.runCommand();
  expect(r.calls.command).toBe(0);
  await expect(r.runDemoTool()).rejects.toThrow(/OneCompany (在这个项目停用|这次没有启用|还在判断)/u);
  expect(r.calls.tool).toBe(0);
  expect(r.activeTools()).not.toContain("one_demo_tool");
  expect(r.activeTools()).toEqual(expect.arrayContaining(["read", "bash"]));
  expect(await r.runBash()).toContain("hi");
  expect(await r.runBash()).not.toContain("fake-bash");
  expect(r.bashParameters()).not.toContain("background");
}

describe("授信记录决定本次会话启用或停用", () => {
  for (const reason of REASONS) {
    test(`记录为信任：reason=${reason} 启用，没有提示`, async () => {
      await writeTrust(true);
      const r = await launch({ reason });
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toEqual([]);
      await expectEnabled(r);
    });
    test(`记录为不信任：reason=${reason} 停用`, async () => {
      await writeTrust(false);
      await expectDisabled(await launch({ reason }));
    });
    test(`记录为空：reason=${reason} 无界面时停用`, async () => {
      await expectDisabled(await launch({ reason, hasUI: false }));
    });
    test(`记录写坏：reason=${reason} 停用`, async () => {
      await writeFile(trustFile(), '{"a": true,}');
      await expectDisabled(await launch({ reason }));
    });
  }

  test("记录的值不合法：停用", async () => {
    await writeFile(trustFile(), JSON.stringify({ [repo]: "yes" }));
    await expectDisabled(await launch());
  });

  test.skipIf(process.getuid?.() === 0)("授信记录所在目录只读且文件不存在：停用", async () => {
    await chmod(join(root, "agent"), 0o555);
    await expectDisabled(await launch());
  });

  test("会话开始后记录改成不信任：本次子扩展的事件处理和命令照常执行", async () => {
    await writeTrust(true);
    const r = await launch();
    await writeTrust(false);
    await expectEnabled(r);
  });

  test("会话开始后记录改成信任：本次仍然停用", async () => {
    await writeTrust(false);
    const r = await launch();
    await writeTrust(true);
    await expectDisabled(r);
  });

  test("从仓库子目录启动：按主仓库根目录的记录判断", async () => {
    await writeTrust(true);
    const sub = join(repo, "packages", "web");
    await mkdir(sub, { recursive: true });
    await expectEnabled(await launch({ cwd: sub }));
  });
});

describe("授信弹窗：触发条件", () => {
  test("startup + 有界面 + 记录为空时弹窗", async () => {
    const r = await launch({ keys: [ESC] });
    expect(r.customCalls()).toBe(1);
  });

  test("弹窗出现时，子扩展还没启动、OneCompany 工具已去掉", async () => {
    const r = await launch({ keys: [ESC] });
    expect(r.atDialog[0]!.sessionStart).toBe(0);
    expect(r.atDialog[0]!.active).not.toContain("one_demo_tool");
    expect(r.atDialog[0]!.active).toEqual(expect.arrayContaining(["read", "bash"]));
  });

  test("无界面：不弹窗，不提示，不写记录", async () => {
    const r = await launch({ hasUI: false });
    expect(r.customCalls()).toBe(0);
    expect(r.notices).toEqual([]);
    expect(existsSync(trustFile())).toBe(false);
  });

  for (const reason of ["new", "resume", "fork", "reload"]) {
    test(`reason 为 ${reason}：不弹窗，不写记录，提示下次启动再问`, async () => {
      const r = await launch({ reason });
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toEqual([{ message: LATER_NOTICE, type: undefined }]);
      expect(existsSync(trustFile())).toBe(false);
    });
  }

  test("记录为信任或不信任时不弹窗", async () => {
    await writeTrust(true);
    expect((await launch()).customCalls()).toBe(0);
    await writeTrust(false);
    expect((await launch()).customCalls()).toBe(0);
  });
});

describe("授信弹窗：窗口文字", () => {
  test("标题、正文、选项、提示行符合规定，没有推荐", async () => {
    const r = await launch({ keys: [ESC] });
    const text = plain(r.screen);
    for (const part of ["要在这个项目里使用 OneCompany 吗？", `项目：${tilde(repo)}`,
      "OneCompany 只在受信任的项目里运行。信任后，项目里的 .pi 设置、角色定义和 skill 也会一起生效。",
      "你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。",
      "信任", "启用 OneCompany，以后不再问", "不信任", "这个项目不用 OneCompany，以后不再问；要改时输入 /trust",
      "这次不用", "这次不启用，下次启动 pi 时再问", "↑↓ 选择 · 回车确认 · Esc 这次不用"]) expect(text).toContain(part);
    expect(text).not.toContain("推荐");
    expect(r.screen).toContain(theme.fg("muted", "你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。"));
    expect(r.screen).toContain("<warning>");
  });

  test("正文按 项目、说明、灰字 的顺序出现", async () => {
    const r = await launch({ keys: [ESC] });
    const text = plain(r.screen);
    const a = text.indexOf("项目："), b = text.indexOf("OneCompany 只在受信任的项目里运行"), c = text.indexOf("你的选择会记进");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  test("光标默认在信任", async () => {
    const r = await launch({ keys: [ESC] });
    const cursorLine = plain(r.screen).split("\n").find((line) => /^\s*→/u.test(line)) ?? "";
    expect(cursorLine).toContain("信任");
    expect(cursorLine).not.toContain("不信任");
  });

  for (const width of [36, 44, 60, 80]) {
    test(`宽 ${width} 列时每行不超宽`, async () => {
      const r = await launch({ width, keys: [ESC] });
      const lines = r.screen.split("\n");
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) expect(visibleWidth(plain(line))).toBeLessThanOrEqual(width);
    });
  }
});

describe("授信弹窗：选择结果", () => {
  test("直接回车选信任：记为 true，启用，同一次会话里子扩展 session_start 被执行", async () => {
    const r = await launch({ keys: [ENTER] });
    expect(await readTrust()).toEqual({ [repo]: true });
    expect(r.notices).toEqual([{ message: TRUST_NOTICE, type: undefined }]);
    await expectEnabled(r);
  });

  test("下移再回车选不信任：记为 false，停用", async () => {
    const r = await launch({ keys: [DOWN, ENTER] });
    expect(await readTrust()).toEqual({ [repo]: false });
    expect(r.notices).toEqual([{ message: DENY_NOTICE, type: undefined }]);
    await expectDisabled(r);
  });

  test("下移两次再回车选这次不用：不写记录，停用", async () => {
    const r = await launch({ keys: [DOWN, DOWN, ENTER] });
    expect(existsSync(trustFile())).toBe(false);
    expect(r.notices).toEqual([{ message: LATER_NOTICE, type: undefined }]);
    await expectDisabled(r);
  });

  test("按 Esc：不写记录，停用", async () => {
    const r = await launch({ keys: [ESC] });
    expect(existsSync(trustFile())).toBe(false);
    expect(r.notices).toEqual([{ message: LATER_NOTICE, type: undefined }]);
    await expectDisabled(r);
  });

  for (const [name, keys] of [["信任", [ENTER]], ["不信任", [DOWN, ENTER]]] as const) {
    test.skipIf(process.getuid?.() === 0)(`trust.json 只读时选${name}：记录不变，停用，红字提示`, async () => {
      await writeFile(trustFile(), "{}");
      await chmod(trustFile(), 0o444);
      const r = await launch({ keys: [...keys] });
      expect(r.customCalls()).toBe(1);
      expect(await readFile(trustFile(), "utf8")).toBe("{}");
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]!.type).not.toBe("error");
      expect(r.notices[0]!.message).toMatch(/^<error>✗ 没有记下你的选择：[^\n]+；OneCompany 这次没有启用<\/>$/u);
      await expectDisabled(r);
    });
  }

  test("从仓库子目录启动：弹窗选信任记在主仓库根目录", async () => {
    const sub = join(repo, "packages", "web");
    await mkdir(sub, { recursive: true });
    await launch({ cwd: sub, keys: [ENTER] });
    expect(await readTrust()).toEqual({ [repo]: true });
  });
});

describe("启动时不弹窗的提示", () => {
  test("记录为不信任：不弹窗，muted 提示，停用", async () => {
    await writeTrust(false);
    const r = await launch();
    expect(r.customCalls()).toBe(0);
    expect(r.notices).toEqual([{ message: DENIED_NOTICE, type: undefined }]);
  });

  test("记录为不信任且 reason 为 reload：同样提示", async () => {
    await writeTrust(false);
    const r = await launch({ reason: "reload" });
    expect(r.notices).toEqual([{ message: DENIED_NOTICE, type: undefined }]);
  });

  const brokenCases: Array<[string, () => string, RegExp]> = [
    ["不是合法 JSON", () => '{"a": true,}', /Failed to read trust store/u],
    ["值不是 true/false/null", () => JSON.stringify({ [repo]: "yes" }), /Invalid trust store/u],
  ];
  for (const [name, content, reasonPattern] of brokenCases) {
    test(`记录${name}：不弹窗，一条 error 色提示，记录原样不动`, async () => {
      const broken = content();
      await writeFile(trustFile(), broken);
      const r = await launch({ keys: [ENTER] });
      expect(r.customCalls()).toBe(0);
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]!.type).not.toBe("error");
      const prefix = `<error>✗ OneCompany 在这个项目停用：读不了授信记录 ${tilde(trustFile())}：`;
      const suffix = "；改好这个文件后重开 pi</>";
      const message = r.notices[0]!.message;
      expect(message.startsWith(prefix)).toBe(true);
      expect(message.endsWith(suffix)).toBe(true);
      const reason = message.slice(prefix.length, message.length - suffix.length);
      expect(reason).toMatch(reasonPattern);
      expect(reason).not.toContain("\n");
      expect(await readFile(trustFile(), "utf8")).toBe(broken);
    });
  }

  test.skipIf(process.getuid?.() === 0)("授信记录所在目录只读：不弹窗，一条 error 色提示，记录仍不存在", async () => {
    await chmod(join(root, "agent"), 0o555);
    const r = await launch({ keys: [ENTER] });
    expect(r.customCalls()).toBe(0);
    expect(r.notices).toHaveLength(1);
    const escaped = tilde(trustFile()).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    expect(r.notices[0]!.message).toMatch(new RegExp(`^<error>✗ OneCompany 在这个项目停用：读不了授信记录 ${escaped}：[^\\n]+；改好这个文件后重开 pi</>$`, "u"));
    expect(existsSync(trustFile())).toBe(false);
  });
});

describe("停用时执行 OneCompany 命令", () => {
  test("记录为空：原命令不执行，一行 muted 说明", async () => {
    const r = await launch({ keys: [ESC] });
    const before = r.notices.length;
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.slice(before)).toEqual([{ message: EMPTY_COMMAND_NOTICE, type: undefined }]);
  });

  test("记录为不信任：原命令不执行，一行 muted 说明", async () => {
    await writeTrust(false);
    const r = await launch();
    const before = r.notices.length;
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.slice(before)).toEqual([{ message: DENIED_NOTICE, type: undefined }]);
  });

  test("记录读不了：原命令不执行，一行与启动时相同的 error 色说明", async () => {
    await writeFile(trustFile(), '{"a": true,}');
    const r = await launch();
    const startNotice = r.notices[0]!.message;
    const before = r.notices.length;
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.slice(before)).toEqual([{ message: startNotice, type: undefined }]);
    expect(startNotice).toMatch(/^<error>✗ OneCompany 在这个项目停用：读不了授信记录 /u);
  });

  test("按会话开始时的记录写说明：开始后记录改了，说明不变", async () => {
    await writeTrust(false);
    const r = await launch();
    await writeTrust(true);
    const before = r.notices.length;
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.slice(before)).toEqual([{ message: DENIED_NOTICE, type: undefined }]);
  });

  test("无界面且记录为空：命令也只发说明", async () => {
    const r = await launch({ hasUI: false });
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.map((n) => n.message)).toEqual([EMPTY_COMMAND_NOTICE]);
  });
});

describe("提示的类型", () => {
  test("各种情形下 notify 的第二参数都不是 error", async () => {
    const all: Array<{ message: string; type?: string }> = [];
    await writeTrust(false);
    all.push(...(await launch()).notices);
    await writeFile(trustFile(), '{"a": true,}');
    all.push(...(await launch()).notices);
    await rm(trustFile());
    all.push(...(await launch({ keys: [ESC] })).notices, ...(await launch({ reason: "reload" })).notices, ...(await launch({ keys: [ENTER] })).notices);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const notice of all) expect(notice.type).not.toBe("error");
  });
});

describe("启用时补回 OneCompany 工具", () => {
  test("会话开始时可用列表不含 OneCompany 工具：补回，且不额外打开别的工具", async () => {
    await writeTrust(true);
    const r = await launch({ resumed: true });
    expect(r.activeTools()).toContain("one_demo_tool");
    expect(r.activeTools()).not.toContain("grep");
    expect(r.activeTools()).toEqual(expect.arrayContaining(["read", "bash"]));
  });
});

describe("判断授信时出错", () => {
  const errorNotice = (reason: string) => theme.fg("error", `✗ OneCompany 这次没有启用：判断授信时出错：${reason}；解决后重开 pi`);
  const relativeAgentDir = () => { process.env.PI_CODING_AGENT_DIR = "relative/dir"; };

  test("授信判断的 session_start 处理被调用前，子扩展的事件处理不执行", async () => {
    const r = await launch({ skipStart: true });
    await r.fireOtherEvent();
    expect(r.calls.otherEvent).toBe(0);
  });

  test("数据目录解析出错：停用，一条 error 色提示，不传 error 级别", async () => {
    relativeAgentDir();
    const r = await launch();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.type).not.toBe("error");
    expect(r.notices[0]!.message).toMatch(/^<error>✗ OneCompany 这次没有启用：判断授信时出错：[^\n]+；解决后重开 pi<\/>$/u);
    await expectDisabled(r);
  });

  test("弹窗过程出错：停用，提示带出错原因第一行", async () => {
    const r = await launch({ customThrows: true });
    expect(r.notices).toEqual([{ message: errorNotice("boom"), type: undefined }]);
    await expectDisabled(r);
  });

  test("停用期间执行命令：原命令不执行，回同一句", async () => {
    const r = await launch({ customThrows: true });
    const before = r.notices.length;
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices.slice(before)).toEqual([{ message: errorNotice("boom"), type: undefined }]);
  });
});

describe("停用时 bash 按 pi 自己的设置", () => {
  test("pi 当前设置里配了命令前缀：停用后 bash 执行命令带上前缀", async () => {
    await writeTrust(false);
    const r = await launch({ settings: { shellCommandPrefix: "export ONE_TEST_PREFIX=1;" } });
    expect(await r.runBash("echo prefix=$ONE_TEST_PREFIX")).toContain("prefix=1");
  });

  test("项目 .pi/settings.json 的前缀没被 pi 加载时：停用后 bash 不带这个前缀", async () => {
    await mkdir(join(repo, ".pi"), { recursive: true });
    await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo PROJECT_PREFIX_RAN;" }));
    await writeTrust(false);
    const r = await launch({ settings: {} });
    const output = await r.runBash("echo body");
    expect(output).toContain("body");
    expect(output).not.toContain("PROJECT_PREFIX_RAN");
  });

  test("pi 当前设置里配了 shellPath：停用后 bash 用这个 shell 执行", async () => {
    const shell = join(root, "my-shell");
    await symlink("/bin/sh", shell);
    await writeTrust(false);
    const r = await launch({ settings: { shellPath: shell } });
    expect(await r.runBash("echo shell=$0")).toContain(`shell=${shell}`);
  });

  test("shellPath 以 ~/ 开头：按家目录展开", async () => {
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await symlink("/bin/sh", join(root, "my-shell"));
      await writeTrust(false);
      const r = await launch({ settings: { shellPath: "~/my-shell" } });
      expect(await r.runBash("echo shell=$0")).toContain(`shell=${join(root, "my-shell")}`);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  test("停用后 bash 照 pi 原版暴露会话环境变量", async () => {
    await writeTrust(false);
    const r = await launch();
    expect(await r.runBash("echo id=$PI_SESSION_ID")).toContain("id=sess-test");
  });
});

describe("授信判断还没完成时执行命令", () => {
  const PENDING_NOTICE = theme.fg("muted", "OneCompany 还在判断这个项目的授信，稍等再试");

  test("会话还没开始判断：原命令不执行，回一句灰字", async () => {
    const r = await launch({ skipStart: true });
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices).toEqual([{ message: PENDING_NOTICE, type: undefined }]);
  });

  test("弹窗还开着：原命令不执行，回同一句", async () => {
    const r = await launch({ hold: true });
    await r.runCommand();
    expect(r.calls.command).toBe(0);
    expect(r.notices).toEqual([{ message: PENDING_NOTICE, type: undefined }]);
  });
});

describe("无界面时判断授信出错", () => {
  test("停用且不提示", async () => {
    process.env.PI_CODING_AGENT_DIR = "relative/dir";
    const r = await launch({ hasUI: false });
    expect(r.notices).toEqual([]);
    expect(r.calls.sessionStart).toBe(0);
    await r.fireOtherEvent();
    expect(r.calls.otherEvent).toBe(0);
    expect(r.activeTools()).not.toContain("one_demo_tool");
  });
});
