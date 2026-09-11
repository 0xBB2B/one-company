import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommands } from "../extensions/commands.ts";
import type { CommandsPi, RegisterCommandsOptions } from "../extensions/commands.ts";

const SPEC_FLOW_BODY = "# spec-flow 正文标记 SPEC-FLOW-BODY-9f2";
const SPEC_REVISE_BODY = "# spec-revise 正文标记 SPEC-REVISE-BODY-4a1";
const SPEC_SYNC_BODY = "# spec-sync 正文标记 SPEC-SYNC-BODY-7c3";

async function writeSkill(root: string, skillName: string, body: string): Promise<void> {
  const dir = join(root, "skills", skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: 测试夹具\n---\n\n${body}\n`,
  );
}

async function writeBrokenFrontmatterSkill(root: string, skillName: string): Promise<string> {
  const dir = join(root, "skills", skillName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, `---\nname: ${skillName}\ndescription: "未闭合的引号\n---\n\n# 正文\n`);
  return path;
}

async function makePackageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-commands-"));
  await writeSkill(root, "spec-flow", SPEC_FLOW_BODY);
  await writeSkill(root, "spec-revise", SPEC_REVISE_BODY);
  await writeSkill(root, "spec-sync", SPEC_SYNC_BODY);
  return root;
}

function makeFakePi() {
  const registrations: Record<
    string,
    { description: string; handler: (args: string, ctx: unknown) => Promise<void> }
  > = {};
  const sentMessages: string[] = [];
  const pi: CommandsPi = {
    registerCommand(name, options) {
      registrations[name] = options;
    },
    sendUserMessage(text) {
      sentMessages.push(text);
    },
  };
  return { pi, registrations, sentMessages };
}

function makeFakeCtx(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    ctx: {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
      },
      ...overrides,
    },
    notifications,
  };
}

function makeOptions(overrides: Partial<RegisterCommandsOptions> = {}): {
  options: RegisterCommandsOptions;
  settingsCalls: unknown[];
  shellCalls: unknown[];
} {
  const settingsCalls: unknown[] = [];
  const shellCalls: unknown[] = [];
  return {
    options: {
      packageRoot: overrides.packageRoot ?? "",
      openSettingsPage: overrides.openSettingsPage ?? (async (ctx: unknown) => {
        settingsCalls.push(ctx);
      }),
      openShellPage: overrides.openShellPage ?? (async (ctx: unknown) => {
        shellCalls.push(ctx);
      }),
    },
    settingsCalls,
    shellCalls,
  };
}

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await makePackageRoot();
  tempRoots.push(root);
  const { pi, registrations, sentMessages } = makeFakePi();
  const { options, settingsCalls, shellCalls } = makeOptions({ packageRoot: root });
  registerCommands(pi, options);
  return { registrations, sentMessages, settingsCalls, shellCalls, packageRoot: root };
}

describe("命令注册集合", () => {
  test("恰好注册六个命令，且不含任何 spec-* 别名", async () => {
    const { registrations } = await setup();
    const names = Object.keys(registrations).sort();
    expect(names).toEqual(
      ["pi-company:new", "pi-company:resume", "pi-company:revise", "pi-company:setting", "pi-company:sync", "pi-company:ps"].sort(),
    );
    expect(names.every((name) => name.startsWith("pi-company:"))).toBe(true);
  });

  test("每个命令的描述非空", async () => {
    const { registrations } = await setup();
    for (const name of Object.keys(registrations)) {
      expect(registrations[name]!.description.length).toBeGreaterThan(0);
    }
  });
});

describe("/pi-company:new", () => {
  test("发送的消息含完整描述（多词、含空格与中文标点）与 spec-flow 正文，不含 frontmatter", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();
    const description = "给用户中心加一个「导出订单」功能，支持 CSV 与 Excel";

    await registrations["pi-company:new"]!.handler(description, ctx);

    expect(sentMessages.length).toBe(1);
    const message = sentMessages[0]!;
    expect(message).toContain(`从阶段一开始处理：${description}`);
    expect(message).toContain(SPEC_FLOW_BODY);
    expect(message).not.toContain("name: spec-flow");
    expect(message).not.toContain("description: 测试夹具");
  });

  test("空描述时提示缺少描述，且不发送消息", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:new"]!.handler("   ", ctx);

    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
  });

  test("spec-flow 技能文档缺失时通知含具体路径与原因，不发送消息", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-commands-missing-"));
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:new"]!.handler("需求描述", ctx);

    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    const message = notifications[notifications.length - 1]!.message;
    expect(message).toContain(join(root, "skills", "spec-flow", "SKILL.md"));
  });

  test("spec-flow 技能文档不可读（为目录而非文件）时通知含路径与原因，不发送消息", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-commands-unreadable-"));
    tempRoots.push(root);
    await mkdir(join(root, "skills", "spec-flow", "SKILL.md"), { recursive: true });
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:new"]!.handler("需求描述", ctx);

    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    const message = notifications[notifications.length - 1]!.message;
    expect(message).toContain(join(root, "skills", "spec-flow", "SKILL.md"));
  });

  test("spec-flow 技能文档 frontmatter 损坏（未闭合引号导致 yaml 解析失败）时通知含路径与原因，不发送消息", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-commands-broken-frontmatter-"));
    tempRoots.push(root);
    const skillPath = await writeBrokenFrontmatterSkill(root, "spec-flow");
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:new"]!.handler("需求描述", ctx);

    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    const message = notifications[notifications.length - 1]!.message;
    expect(message).toContain(skillPath);
  });
});

describe("/pi-company:resume", () => {
  test("发送消息保留 --verify 参数并含 spec-flow 正文", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();

    await registrations["pi-company:resume"]!.handler("--verify", ctx);

    expect(sentMessages.length).toBe(1);
    const message = sentMessages[0]!;
    expect(message).toContain("执行断点续接，参数：--verify");
    expect(message).toContain(SPEC_FLOW_BODY);
  });

  test("无参数时参数原样为空，仍发送消息", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();

    await registrations["pi-company:resume"]!.handler("", ctx);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!).toContain("执行断点续接，参数：");
  });
});

describe("/pi-company:revise", () => {
  test("发送的消息含完整问题描述与 spec-revise 正文，不含 frontmatter", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();
    const description = "登录页在 Safari 上点击「记住我」无效，多词 多空格 描述";

    await registrations["pi-company:revise"]!.handler(description, ctx);

    expect(sentMessages.length).toBe(1);
    const message = sentMessages[0]!;
    expect(message).toContain(`处理这个问题：${description}`);
    expect(message).toContain(SPEC_REVISE_BODY);
    expect(message).not.toContain("name: spec-revise");
  });

  test("空描述时提示缺少描述，且不发送消息", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:revise"]!.handler("", ctx);

    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
  });
});

describe("/pi-company:sync", () => {
  test("带域名参数时保留域名范围", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();

    await registrations["pi-company:sync"]!.handler("agents", ctx);

    expect(sentMessages.length).toBe(1);
    const message = sentMessages[0]!;
    expect(message).toContain("执行对账，范围：agents");
    expect(message).toContain(SPEC_SYNC_BODY);
  });

  test("无参数时范围为空但仍发送消息", async () => {
    const { registrations, sentMessages } = await setup();
    const { ctx } = makeFakeCtx();

    await registrations["pi-company:sync"]!.handler("", ctx);

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]!).toContain("执行对账，范围：");
  });
});

describe("/pi-company:setting", () => {
  test("交互终端下调用打开设置页回调", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, settingsCalls } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["pi-company:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(1);
    expect(sentMessages.length).toBe(0);
  });

  test("打开设置页回调抛错时通知具体原因，不发送消息、不调用其他入口", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, shellCalls } = makeOptions({
      packageRoot: root,
      openSettingsPage: async () => {
        throw new Error("设置页加载失败：缺少角色目录");
      },
    });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["pi-company:setting"]!.handler("", ctx);

    expect(sentMessages.length).toBe(0);
    expect(shellCalls.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[notifications.length - 1]!.message).toContain("设置页加载失败：缺少角色目录");
  });

  test("hasUI=false 时通知原因，不调用打开设置页回调", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, settingsCalls } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: false, mode: "tui" });

    await registrations["pi-company:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(0);
    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
  });

  test("mode 不为 tui 时通知原因，不调用打开设置页回调", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, settingsCalls } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: true, mode: "other" });

    await registrations["pi-company:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(0);
    expect(sentMessages.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
  });
});

describe("/pi-company:ps", () => {
  test("调用打开 Shell 管理页回调", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, shellCalls } = makeOptions({ packageRoot: root });
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx();

    await registrations["pi-company:ps"]!.handler("", ctx);

    expect(shellCalls.length).toBe(1);
    expect(sentMessages.length).toBe(0);
  });

  test("打开 Shell 管理页回调抛错时通知具体原因，不发送消息、不调用其他入口", async () => {
    const root = await makePackageRoot();
    tempRoots.push(root);
    const { pi, registrations, sentMessages } = makeFakePi();
    const { options, settingsCalls } = makeOptions({
      packageRoot: root,
      openShellPage: async () => {
        throw new Error("Shell 管理页加载失败：守护进程未连接");
      },
    });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx();

    await registrations["pi-company:ps"]!.handler("", ctx);

    expect(sentMessages.length).toBe(0);
    expect(settingsCalls.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[notifications.length - 1]!.message).toContain("Shell 管理页加载失败：守护进程未连接");
  });
});
