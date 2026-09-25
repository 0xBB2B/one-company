import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openSettingsPage } from "./settings.ts";
import type { SettingsExtensionContext } from "./settings.ts";
import { openShellUiPage } from "./shell-ui.ts";
import type { OpenShellPageCtx } from "../runtime/shell-page.ts";

// 两个命令共用同一个 registerCommand handler 签名，ctx 必须同时满足
// openSettingsPage 与 openShellUiPage 各自的真实入参类型才能免于强转
export type CommandsCtx = SettingsExtensionContext & OpenShellPageCtx;

export interface CommandsPi {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: CommandsCtx) => Promise<void> },
  ): void;
}

export interface RegisterCommandsOptions {
  openSettingsPage: (ctx: SettingsExtensionContext) => Promise<void>;
  openShellPage: (ctx: OpenShellPageCtx) => Promise<void>;
}

async function openSettingOrReport(
  options: RegisterCommandsOptions,
  ctx: CommandsCtx,
): Promise<void> {
  try {
    await options.openSettingsPage(ctx);
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
  pi.registerCommand("pi-company:setting", {
    description: "打开角色设置页",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("需要交互终端才能打开设置页");
        return;
      }
      await openSettingOrReport(options, ctx);
    },
  });

  pi.registerCommand("pi-company:ps", {
    description: "打开 Shell 管理页",
    handler: async (_args, ctx) => {
      await openShellPageOrReport(options, ctx);
    },
  });
}

export default function commandsExtension(pi: ExtensionAPI): void {
  registerCommands(pi, {
    openSettingsPage,
    openShellPage: openShellUiPage,
  });
}
