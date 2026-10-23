import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openExamplesPage } from "../../modules/settings/examples-extension.ts";
import type { ExamplesContext } from "../../modules/settings/examples-extension.ts";
import { openSettingsPage } from "../../modules/settings/settings-extension.ts";
import type { SettingsExtensionContext } from "../../modules/settings/settings-extension.ts";
import { openShellUiPage } from "../../modules/shell/shell-ui-extension.ts";
import type { OpenShellPageCtx } from "../../modules/shell/shell-page.ts";

// 两个命令共用同一个 registerCommand handler 签名，ctx 必须同时满足
// openSettingsPage 与 openShellUiPage 各自的真实入参类型才能免于强转
export type CommandsCtx = SettingsExtensionContext & OpenShellPageCtx;

export interface CommandsPi {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: CommandsCtx) => Promise<void> },
  ): void;
  getThinkingLevel(): string;
}

export interface RegisterCommandsOptions {
  openExamplesPage: (ctx: ExamplesContext) => Promise<void>;
  openSettingsPage: (ctx: SettingsExtensionContext, options: { mainThinking: () => string }) => Promise<void>;
  openShellPage: (ctx: OpenShellPageCtx) => Promise<void>;
}

async function openSettingOrReport(
  pi: CommandsPi,
  options: RegisterCommandsOptions,
  ctx: CommandsCtx,
): Promise<void> {
  try {
    await options.openSettingsPage(ctx, { mainThinking: () => pi.getThinkingLevel() });
  } catch (error) {
    ctx.ui.notify((error as Error).message);
  }
}

async function openExamplesOrReport(
  options: RegisterCommandsOptions,
  ctx: CommandsCtx,
): Promise<void> {
  try {
    await options.openExamplesPage(ctx);
  } catch (error) {
    ctx.ui.notify((error as Error).message);
  }
}

async function openShellPageOrReport(
  options: RegisterCommandsOptions,
  ctx: CommandsCtx,
): Promise<void> {
  try {
    await options.openShellPage(ctx);
  } catch (error) {
    ctx.ui.notify((error as Error).message);
  }
}

export function registerCommands(pi: CommandsPi, options: RegisterCommandsOptions): void {
  pi.registerCommand("one:setting", {
    description: "打开设置页",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("需要交互终端才能打开设置页");
        return;
      }
      await openSettingOrReport(pi, options, ctx);
    },
  });

  pi.registerCommand("one:examples", {
    description: "复制设计规范样例",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("需要交互终端才能打开样例");
        return;
      }
      await openExamplesOrReport(options, ctx);
    },
  });

  pi.registerCommand("one:ps", {
    description: "打开 Shell 管理页",
    handler: async (_args, ctx) => {
      await openShellPageOrReport(options, ctx);
    },
  });
}

export default function commandsExtension(pi: ExtensionAPI): void {
  registerCommands(pi, {
    openExamplesPage,
    openSettingsPage,
    openShellPage: openShellUiPage,
  });
}
