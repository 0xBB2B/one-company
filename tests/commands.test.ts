import { describe, expect, test } from "vitest";
import { registerCommands } from "../src/app/extension/commands.ts";
import type { CommandsPi, RegisterCommandsOptions } from "../src/app/extension/commands.ts";

function makeFakePi() {
  const registrations: Record<
    string,
    { description: string; handler: (args: string, ctx: unknown) => Promise<void> }
  > = {};
  const pi: CommandsPi = {
    registerCommand(name, options) {
      registrations[name] = options;
    },
    getThinkingLevel: () => "xhigh",
  };
  return { pi, registrations };
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

function setup() {
  const { pi, registrations } = makeFakePi();
  const { options, settingsCalls, shellCalls } = makeOptions();
  registerCommands(pi, options);
  return { registrations, settingsCalls, shellCalls };
}

describe("命令注册集合", () => {
  test("恰好注册两个命令，且不含任何 spec-* 别名", () => {
    const { registrations } = setup();
    const names = Object.keys(registrations).sort();
    expect(names).toEqual(["one:ps", "one:setting"]);
    expect(names.every((name) => name.startsWith("one:"))).toBe(true);
  });

  test("每个命令的描述非空", () => {
    const { registrations } = setup();
    for (const name of Object.keys(registrations)) {
      expect(registrations[name]!.description.length).toBeGreaterThan(0);
    }
  });

  test("one:setting 的描述是打开设置页", () => {
    const { registrations } = setup();
    expect(registrations["one:setting"]!.description).toBe("打开设置页");
  });

  test("不再注册 one:agents 和 one:git-delivery", () => {
    const { registrations } = setup();
    expect(registrations).not.toHaveProperty("one:agents");
    expect(registrations).not.toHaveProperty("one:git-delivery");
  });
});

describe("/one:setting", () => {
  test("交互终端下调用打开设置页回调", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, settingsCalls } = makeOptions();
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(1);
  });

  test("传给设置页的 mainThinking 返回 pi 当前的思考等级", async () => {
    const { pi, registrations } = makeFakePi();
    const received: Array<{ mainThinking: () => string }> = [];
    const { options } = makeOptions({ openSettingsPage: async (_ctx, page) => { received.push(page); } });
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(received).toHaveLength(1);
    expect(received[0]!.mainThinking()).toBe("xhigh");
  });

  test("传给设置页的选项里只有主窗口思考等级", async () => {
    const { pi, registrations } = makeFakePi();
    const received: Array<Record<string, unknown>> = [];
    const { options } = makeOptions({ openSettingsPage: async (_ctx, page) => { received.push(page); } });
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(received).toHaveLength(1);
    expect(Object.keys(received[0]!)).toEqual(["mainThinking"]);
  });

  test("打开设置页回调抛错时通知具体原因，不调用其他入口", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, shellCalls } = makeOptions({
      openSettingsPage: async () => {
        throw new Error("设置页加载失败：缺少角色目录");
      },
    });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: true, mode: "tui" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(shellCalls.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[notifications.length - 1]!.message).toContain("设置页加载失败：缺少角色目录");
  });

  test("hasUI=false 时通知原因，不调用打开设置页回调", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, settingsCalls } = makeOptions();
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: false, mode: "tui" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(0);
    expect(notifications.map((item) => item.message)).toEqual(["需要交互终端才能打开设置页"]);
  });

  test("mode 不为 tui 时通知原因，不调用打开设置页回调", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, settingsCalls } = makeOptions();
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx({ hasUI: true, mode: "other" });

    await registrations["one:setting"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(0);
    expect(notifications.map((item) => item.message)).toEqual(["需要交互终端才能打开设置页"]);
  });
});

describe("/one:ps", () => {
  test("调用打开 Shell 管理页回调", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, shellCalls } = makeOptions();
    registerCommands(pi, options);
    const { ctx } = makeFakeCtx();

    await registrations["one:ps"]!.handler("", ctx);

    expect(shellCalls.length).toBe(1);
  });

  test("打开 Shell 管理页回调抛错时通知具体原因，不调用其他入口", async () => {
    const { pi, registrations } = makeFakePi();
    const { options, settingsCalls } = makeOptions({
      openShellPage: async () => {
        throw new Error("Shell 管理页加载失败：守护进程未连接");
      },
    });
    registerCommands(pi, options);
    const { ctx, notifications } = makeFakeCtx();

    await registrations["one:ps"]!.handler("", ctx);

    expect(settingsCalls.length).toBe(0);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[notifications.length - 1]!.message).toContain("Shell 管理页加载失败：守护进程未连接");
  });
});
