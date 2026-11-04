import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseWindow, mutedLines } from "../../core/host/question-window.ts";
import type { WindowLine } from "../../core/host/question-window.ts";
import { dataRoot } from "../../core/storage/data-root.ts";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { agentSwitchOf, readDisabledAgents } from "./agent-settings.ts";
import { copyExampleFiles, ExampleCopyError, examplesDir, inspectExample, layerTargets, listExamples } from "./spec-examples.ts";
import type { ExampleInspection, ExampleTargets } from "./spec-examples.ts";
import { readProjectTrust, trustProject } from "./project-trust.ts";
import { tilde } from "./settings-page-ui.ts";

export type ExamplesContext = Pick<ExtensionContext, "hasUI" | "cwd" | "ui" | "mode">;

type LayerKey = "user" | "project";

const LAYER_NAME: Record<LayerKey, string> = { user: "用户层", project: "项目层" };
const COPY = "复制", SKIP_COPY = "不复制";
const CANCELLED = "已取消，没有复制任何文件";

export function layerStatusText(inspection: ExampleInspection | null): string {
  return inspection === null ? "未受信任" : inspection.overall;
}

const workerFirst = (a: { name: string }, b: { name: string }) => Number(b.name.endsWith("-worker")) - Number(a.name.endsWith("-worker"));

interface ConfirmInput {
  inspection: ExampleInspection;
  layerDir: string;
  layer: LayerKey;
  userAgentsDir: string;
  projectAgentsDir: string | null;
  disabled: ReturnType<typeof readDisabledAgents>;
}

export function confirmLines(input: ConfirmInput): WindowLine[] {
  const { inspection, layer, layerDir } = input;
  const agents = [...inspection.agents].sort(workerFirst);
  const skillsOf = (state: string) => inspection.skills.filter((skill) => skill.state === state);
  const agentsOf = (state: string) => agents.filter((agent) => agent.state === state);
  const skillCount = skillsOf("missing").length, agentCount = agentsOf("missing").length;
  const same = skillsOf("same").length + agentsOf("same").length;
  const parts = [skillCount > 0 ? `${skillCount} 份 skill` : "", agentCount > 0 ? `${agentCount} 份角色定义` : ""].filter(Boolean);
  const lines: WindowLine[] = [{ text: parts.length === 0 ? "这一层没有要复制的。" : `复制 ${skillCount + agentCount} 份到 ${tilde(layerDir)}${sep}：${parts.join("、")}。` }];
  if (same > 0) lines.push({ text: `已经有、和样例一样的 ${same} 份，跳过。` });
  const warnings: string[] = [];
  const changed = [...skillsOf("changed").map((skill) => join("skills", skill.name)), ...agentsOf("changed").map((agent) => join("agents", `${agent.name}.md`))];
  if (changed.length > 0) warnings.push(`你改过的 ${changed.length} 份保留你的版本，不覆盖：${changed.join("、")}`);
  const fresh = agentsOf("missing");
  if (layer === "project") {
    for (const agent of fresh) {
      const userFile = join(input.userAgentsDir, `${agent.name}.md`);
      if (existsSync(userFile)) warnings.push(`${agent.name} 会替换你在用户层的同名定义 ${tilde(userFile)}。`);
    }
  }
  for (const agent of fresh) {
    if (!agentSwitchOf(agent.name, input.disabled).enabled) warnings.push(`${agent.name} 在 /one:setting 里是关闭，复制后照样关闭，派工不会用它。`);
  }
  if (layer === "user" && input.projectAgentsDir !== null) {
    for (const agent of fresh) {
      if (existsSync(join(input.projectAgentsDir, `${agent.name}.md`))) warnings.push(`项目层已有 ${agent.name}，在这个项目里用的是项目层那份，用户层这份不生效。`);
    }
  }
  if (warnings.length > 0) lines.push({ text: "" }, ...warnings.map((text) => ({ text, tone: "warning" as const })));
  return lines;
}

export function resultText(input: { label: string; layer: LayerKey; written: number; skipped: string[] }): string {
  const lines = [`✓ ${input.label}样例已复制到${LAYER_NAME[input.layer]}：新复制 ${input.written} 个文件。`];
  if (input.skipped.length > 0) lines.push(`被改过、没有覆盖：${input.skipped.map(tilde).join("、")}。`);
  return lines.join("\n  ");
}

export function copyFailureText(error: ExampleCopyError): string {
  const reason = error.code === "EACCES" || error.code === "EPERM" ? "没有权限写入"
    : error.code === "EEXIST" ? "目标位置已有别处写的同名文件" : error.message.split("\n")[0];
  return `✗ 复制没有完成：${reason} ${tilde(error.dir)}${sep}\n  已复制的 ${error.written} 个文件保留；解决后再运行 /one:examples 会接着补。`;
}

export async function openExamplesPage(ctx: ExamplesContext): Promise<void> {
  const agentDir = dirname(dataRoot(process.env));
  const repoRoot = await primaryWorktreeRoot(ctx.cwd);
  const trust = readProjectTrust(agentDir, repoRoot);
  const projectDenied = trust === "denied";
  const root = examplesDir();
  const targetsOf: Record<LayerKey, ExampleTargets> = { user: layerTargets("user", { agentDir, repoRoot }), project: layerTargets("project", { agentDir, repoRoot }) };
  const inspect = (example: string, layer: LayerKey) => inspectExample({ examplesDir: root, example, targets: targetsOf[layer] });
  const cancelled = () => ctx.ui.notify(CANCELLED);

  const rows = await Promise.all((await listExamples()).map(async (item) => ({
    ...item,
    user: await inspect(item.name, "user"),
    project: projectDenied ? null : await inspect(item.name, "project"),
  })));
  const chosen = await chooseWindow(ctx, {
    title: "要用哪套设计规范样例？",
    lines: mutedLines(["选中后再选复制到哪一层；skills 和角色定义一起复制。"]),
    choices: rows.map((row) => ({ label: row.name, description: `${row.label} · 用户层：${layerStatusText(row.user)} · 项目层：${layerStatusText(row.project)}` })),
    cancelNote: SKIP_COPY,
  });
  const row = rows.find((item) => item.name === chosen);
  if (!row) return cancelled();

  const userDone = row.user.overall === "已复制", projectDone = row.project?.overall === "已复制";
  if (userDone && (projectDone || projectDenied)) {
    ctx.ui.notify(projectDone ? `${row.label}样例在用户层和项目层都已全部复制，和样例一致。`
      : `${row.label}样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。`);
    return;
  }
  const layerChoice = await chooseWindow(ctx, {
    title: `把 ${row.label}样例复制到哪一层？`,
    lines: [],
    choices: [
      { label: LAYER_NAME.user, description: `${tilde(agentDir)}${sep} · 对你的所有项目生效`, ...(userDone ? { disabled: "已全部复制，和样例一致" } : {}) },
      { label: LAYER_NAME.project, description: `${tilde(repoRoot)}${sep} · 只对这个项目生效${trust === "unset" ? " · 选它会把本项目设为受信任" : ""}`,
        ...(projectDenied ? { disabled: "你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust" } : projectDone ? { disabled: "已全部复制，和样例一致" } : {}) },
    ],
    cancelNote: SKIP_COPY,
  });
  const layer: LayerKey | undefined = layerChoice === LAYER_NAME.user ? "user" : layerChoice === LAYER_NAME.project ? "project" : undefined;
  if (!layer) return cancelled();

  const targets = targetsOf[layer];
  // 第一个窗口之后可能已有别处写入，按此刻的文件重新判定，避免覆盖
  const inspection = await inspect(row.name, layer);
  const disabled = readDisabledAgents({ agentDir, repositoryRoot: repoRoot, projectTrusted: trust === "trusted" || layer === "project" });
  const decision = await chooseWindow(ctx, {
    title: `把 ${row.label}样例复制到${LAYER_NAME[layer]}？`,
    lines: confirmLines({ inspection, layerDir: dirname(targets.skillsDir), layer, userAgentsDir: targetsOf.user.agentsDir, projectAgentsDir: trust === "trusted" || layer === "project" ? targetsOf.project.agentsDir : null, disabled }),
    choices: [{ label: COPY }, { label: SKIP_COPY }],
    cancelNote: SKIP_COPY,
  });
  if (decision !== COPY) return cancelled();

  let trustWritten = false;
  if (layer === "project") {
    const current = readProjectTrust(agentDir, repoRoot);
    if (current === "denied") {
      ctx.ui.notify("✗ 复制没有完成：你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust", "error");
      return;
    }
    if (current === "unset") {
      try {
        trustProject(agentDir, repoRoot);
      } catch (error) {
        ctx.ui.notify(`✗ 复制没有完成：${(error as Error).message.split("\n")[0]}`, "error");
        return;
      }
      trustWritten = true;
    }
  }

  let written: string[];
  try {
    written = await copyExampleFiles({ examplesDir: root, example: row.name, targets, inspection });
  } catch (error) {
    if (!(error instanceof ExampleCopyError)) throw error;
    ctx.ui.notify(copyFailureText(error) + (trustWritten ? "\n  · 已把本项目设为受信任" : ""), "error");
    return;
  }

  const skipped = [...inspection.skills.flatMap((skill) => skill.files), ...inspection.agents].filter((file) => file.state === "changed").map((file) => file.path);
  ctx.ui.notify(resultText({ label: row.label, layer, written: written.length, skipped }) + (trustWritten ? " · 已把本项目设为受信任" : ""));
}
