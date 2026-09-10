import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openSettingsPage } from "./settings.ts";
import type { SettingsExtensionContext } from "./settings.ts";
import { openShellUiPage } from "./shell-ui.ts";
import type { OpenShellPageCtx } from "../runtime/shell-page.ts";

// 六个命令共用同一个 registerCommand handler 签名，ctx 必须同时满足
// openSettingsPage 与 openShellUiPage 各自的真实入参类型才能免于强转
export type CommandsCtx = SettingsExtensionContext & OpenShellPageCtx;

export interface CommandsPi {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: CommandsCtx) => Promise<void> },
  ): void;
  sendUserMessage(text: string): void;
}

export interface RegisterCommandsOptions {
  packageRoot: string;
  openSettingsPage: (ctx: SettingsExtensionContext) => Promise<void>;
  openShellPage: (ctx: OpenShellPageCtx) => Promise<void>;
}

async function loadSkillBody(packageRoot: string, skillName: string): Promise<string> {
  const path = join(packageRoot, "skills", skillName, "SKILL.md");
  try {
    const raw = await readFile(path, "utf-8");
    return stripFrontmatter(raw);
  } catch (error) {
    throw new Error(`技能文档加载失败：${path}（${(error as Error).message}）`);
  }
}

function sendFlowPrompt(pi: CommandsPi, instruction: string, skillBody: string): void {
  pi.sendUserMessage(`${instruction}\n\n${skillBody}`);
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
  pi.registerCommand("pi-company:new", {
    description: "开始处理新需求",
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("缺少需求描述");
        return;
      }
      let body: string;
      try {
        body = await loadSkillBody(options.packageRoot, "spec-flow");
      } catch (error) {
        ctx.ui.notify((error as Error).message);
        return;
      }
      sendFlowPrompt(pi, `从阶段一开始处理：${description}`, body);
    },
  });

  pi.registerCommand("pi-company:resume", {
    description: "继续处理进行中的需求",
    handler: async (args, ctx) => {
      let body: string;
      try {
        body = await loadSkillBody(options.packageRoot, "spec-flow");
      } catch (error) {
        ctx.ui.notify((error as Error).message);
        return;
      }
      sendFlowPrompt(pi, `执行断点续接，参数：${args}`, body);
    },
  });

  pi.registerCommand("pi-company:revise", {
    description: "处理已有功能的问题或 bug",
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("缺少问题描述");
        return;
      }
      let body: string;
      try {
        body = await loadSkillBody(options.packageRoot, "spec-revise");
      } catch (error) {
        ctx.ui.notify((error as Error).message);
        return;
      }
      sendFlowPrompt(pi, `处理这个问题：${description}`, body);
    },
  });

  pi.registerCommand("pi-company:sync", {
    description: "核对规范与代码是否一致",
    handler: async (args, ctx) => {
      let body: string;
      try {
        body = await loadSkillBody(options.packageRoot, "spec-sync");
      } catch (error) {
        ctx.ui.notify((error as Error).message);
        return;
      }
      sendFlowPrompt(pi, `执行对账，范围：${args}`, body);
    },
  });

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
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  registerCommands(pi, {
    packageRoot,
    openSettingsPage,
    openShellPage: openShellUiPage,
  });
}
