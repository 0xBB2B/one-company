import type { ExtensionContext, SessionStartEvent, ThemeColor } from "@earendil-works/pi-coding-agent";
import { chooseWindow, mutedLines } from "../../core/host/question-window.ts";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { distrustProject, readProjectTrust, trustFilePath, trustProject } from "../../core/host/project-trust.ts";
import { tilde } from "./settings-page-ui.ts";

export type DisabledReason = { kind: "pending" } | { kind: "empty" } | { kind: "denied" } | { kind: "unreadable"; detail: string } | { kind: "error"; detail: string };
export type SessionTrust = { enabled: true } | { enabled: false; reason: DisabledReason };

const TRUST = "信任", DISTRUST = "不信任", LATER = "这次不用";
const EMPTY = { enabled: false, reason: { kind: "empty" } } as const;
const DENIED = { enabled: false, reason: { kind: "denied" } } as const;

export function disabledNotice(reason: DisabledReason, agentDir: string, theme: ExtensionContext["ui"]["theme"]): string {
  if (reason.kind === "denied") return theme.fg("muted", "OneCompany 在这个项目停用：你选过不信任这个项目。要用时在 pi 里输入 /trust 选 Trust，再重开 pi");
  if (reason.kind === "pending") return theme.fg("muted", "OneCompany 还在判断这个项目的授信，稍等再试");
  if (reason.kind === "error") return theme.fg("error", `✗ OneCompany 这次没有启用：判断授信时出错：${reason.detail}；解决后重开 pi`);
  if (reason.kind === "unreadable") return theme.fg("error", `✗ OneCompany 在这个项目停用：读不了授信记录 ${tilde(trustFilePath(agentDir))}：${reason.detail}；改好这个文件后重开 pi`);
  return theme.fg("muted", "OneCompany 在这个项目停用：项目还没授信。重开 pi 时在弹窗里选信任即可启用");
}

async function askProjectTrust(ctx: ExtensionContext, agentDir: string, repoRoot: string): Promise<SessionTrust> {
  const choice = await chooseWindow(ctx, {
    title: "要在这个项目里使用 OneCompany 吗？",
    lines: [
      { text: `项目：${tilde(repoRoot)}` },
      { text: "OneCompany 只在受信任的项目里运行。信任后，项目里的 .pi 设置、角色定义和 skill 也会一起生效。" },
      ...mutedLines(["你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。"]),
    ],
    choices: [
      { label: TRUST, description: "启用 OneCompany，以后不再问" },
      { label: DISTRUST, description: "这个项目不用 OneCompany，以后不再问；要改时输入 /trust" },
      { label: LATER, description: "这次不启用，下次启动 pi 时再问" },
    ],
    escapeHint: "Esc 这次不用",
  });
  const notify = (tone: ThemeColor, text: string) => ctx.ui.notify(ctx.ui.theme.fg(tone, text));
  try {
    if (choice === TRUST) {
      trustProject(agentDir, repoRoot);
      notify("success", "✓ 已把本项目设为受信任，OneCompany 已启用");
      return { enabled: true };
    }
    if (choice === DISTRUST) {
      distrustProject(agentDir, repoRoot);
      notify("muted", "OneCompany 在这个项目停用：已记为不信任。要用时在 pi 里输入 /trust 选 Trust，再重开 pi");
      return DENIED;
    }
  } catch (error) {
    notify("error", `✗ 没有记下你的选择：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}；OneCompany 这次没有启用`);
    return EMPTY;
  }
  notify("muted", "OneCompany 这次没有启用，下次启动 pi 时再问");
  return EMPTY;
}

export async function resolveSessionTrust(event: SessionStartEvent, ctx: ExtensionContext, agentDir: string): Promise<SessionTrust> {
  const repoRoot = await primaryWorktreeRoot(ctx.cwd);
  const { trust, reason } = readProjectTrust(agentDir, repoRoot);
  if (trust === "trusted") return { enabled: true };
  if (trust === "denied") {
    if (ctx.hasUI) ctx.ui.notify(disabledNotice(DENIED.reason, agentDir, ctx.ui.theme));
    return DENIED;
  }
  if (trust === "unreadable") {
    const unreadable: DisabledReason = { kind: "unreadable", detail: reason ?? "" };
    if (ctx.hasUI) ctx.ui.notify(disabledNotice(unreadable, agentDir, ctx.ui.theme));
    return { enabled: false, reason: unreadable };
  }
  if (!ctx.hasUI) return EMPTY;
  if (event.reason !== "startup") {
    ctx.ui.notify(ctx.ui.theme.fg("muted", "OneCompany 这次没有启用，下次启动 pi 时再问"));
    return EMPTY;
  }
  return askProjectTrust(ctx, agentDir, repoRoot);
}
