import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseWindow, mutedLines } from "../../core/host/question-window.ts";
import { dataRoot } from "../../core/storage/data-root.ts";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { projectRoleDir } from "../agents/roles.ts";
import { distrustProject, readProjectTrust, trustFilePath, trustProject } from "./project-trust.ts";
import { tilde } from "./settings-page-ui.ts";

const TRUST = "信任", DISTRUST = "不信任", LATER = "以后再说";

async function projectDefinitionCount(repoRoot: string): Promise<number> {
  try {
    return (await readdir(projectRoleDir(repoRoot))).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

async function askProjectTrust(ctx: ExtensionContext, agentDir: string, repoRoot: string, count: number): Promise<void> {
  const choice = await chooseWindow(ctx, {
    title: "要信任这个项目吗？",
    lines: [
      { text: `项目：${tilde(repoRoot)}` },
      { text: "项目里有角色定义，项目受信任后才会生效。" },
      ...mutedLines(["你的选择会记进 pi 的授信记录，和在 pi 里输入 /trust 一样。"]),
    ],
    choices: [
      { label: TRUST, description: "项目层马上生效，以后不再问" },
      { label: DISTRUST, description: "项目层不加载，以后不再问；要改时输入 /trust" },
      { label: LATER, description: "这次不加载，下次启动 pi 时再问" },
    ],
    escapeHint: "Esc 以后再说",
  });
  const muted = (text: string) => ctx.ui.notify(ctx.ui.theme.fg("muted", text));
  try {
    if (choice === TRUST) {
      trustProject(agentDir, repoRoot);
      ctx.ui.notify(ctx.ui.theme.fg("success", `✓ 已把本项目设为受信任，项目层的 ${count} 份定义已生效`));
    } else if (choice === DISTRUST) {
      distrustProject(agentDir, repoRoot);
      muted("已把本项目记为不信任，项目层的定义不加载；要改时在 pi 里输入 /trust");
    } else {
      muted(`这次没有加载项目层的 ${count} 份定义，下次启动 pi 时再问`);
    }
  } catch (error) {
    ctx.ui.notify(ctx.ui.theme.fg("error", `✗ 没有记下你的选择：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`));
  }
}

export default function startupTrustExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !ctx.hasUI) return;
    const agentDir = dirname(dataRoot(process.env));
    const repoRoot = await primaryWorktreeRoot(ctx.cwd);
    const count = await projectDefinitionCount(repoRoot);
    if (count < 1 || hasTrustRequiringProjectResources(ctx.cwd)) return;
    const { trust, reason } = readProjectTrust(agentDir, repoRoot);
    if (trust === "unreadable") {
      ctx.ui.notify(ctx.ui.theme.fg("error", `✗ 读不了授信记录 ${tilde(trustFilePath(agentDir))}：${reason}；改好这个文件后再启动 pi`));
      return;
    }
    if (trust !== "unset") return;
    await askProjectTrust(ctx, agentDir, repoRoot, count);
  });
}
