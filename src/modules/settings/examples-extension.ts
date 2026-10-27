import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseWindow, mutedLines } from "../../core/host/question-window.ts";
import type { WindowChoice, WindowLine } from "../../core/host/question-window.ts";
import { dataRoot } from "../../core/storage/data-root.ts";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { writeFileAtomic } from "../../core/storage/store.ts";
import { lineDiff, symlinkTarget } from "../verification/project-conventions.ts";
import { agentSwitchOf, readDisabledAgents } from "./agent-settings.ts";
import { copyExampleFiles, ExampleCopyError, examplesDir, inspectExample, layerTargets, listExamples, mergeConventions } from "./spec-examples.ts";
import type { ExampleInspection, ExampleTargets } from "./spec-examples.ts";
import { readProjectTrust, trustProject } from "./project-trust.ts";
import { tilde } from "./settings-page-ui.ts";

export type ExamplesContext = Pick<ExtensionContext, "hasUI" | "cwd" | "ui" | "mode">;

type LayerKey = "user" | "project";
type Outcome = "written" | "declined" | "over" | "changed" | "failed" | "none";

const LAYER_NAME: Record<LayerKey, string> = { user: "用户层", project: "项目层" };
const CLASSES = [["新复制", "missing"], ["已一致", "same"], ["被改过，跳过", "changed"]] as const;
const WRITE = "写入", SKIP_WRITE = "不写入", COPY = "复制", SKIP_COPY = "不复制";
const CANCELLED = "已取消，没有复制任何文件";

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function layerStatusText(inspection: ExampleInspection | null): string {
  return inspection === null ? "未受信任" : inspection.overall;
}

function classLines(items: { name: string; state: string }[]): WindowLine[] {
  return CLASSES.flatMap(([title, state]) => {
    const names = items.filter((item) => item.state === state).map((item) => item.name);
    return names.length === 0 ? [] : [{ text: `  ${title} ${names.length}：${names.join("、")}`, tone: state === "changed" ? "warning" as const : "normal" as const }];
  });
}

const workerFirst = (a: { name: string }, b: { name: string }) => Number(b.name.endsWith("-worker")) - Number(a.name.endsWith("-worker"));

interface ConfirmInput {
  inspection: ExampleInspection;
  targets: ExampleTargets;
  layer: LayerKey;
  userAgentsDir: string;
  projectAgentsDir: string | null;
  disabled: ReturnType<typeof readDisabledAgents>;
  conventions: { before: string | null; over: boolean; bytes: number; excess: number };
}

export function confirmLines(input: ConfirmInput): WindowLine[] {
  const { inspection, targets, layer, conventions } = input;
  const lines: WindowLine[] = [{ text: `skills → ${tilde(targets.skillsDir)}${sep}` }, ...classLines(inspection.skills)];
  const agents = [...inspection.agents].sort(workerFirst);
  lines.push({ text: `角色定义 → ${tilde(targets.agentsDir)}${sep}` }, ...classLines(agents));
  const fresh = agents.filter((agent) => agent.state === "missing");
  if (fresh.length > 0) {
    const replaced = layer === "project" && fresh.some((agent) => existsSync(join(input.userAgentsDir, `${agent.name}.md`))) ? "用户层" : "内置";
    const states = fresh.map((agent) => agentSwitchOf(agent.name, input.disabled).enabled ? "开启" : "关闭");
    const names = fresh.map((agent) => agent.name).join("、");
    const switches = fresh.length === 1 ? `${names} 现在是${states[0]}`
      : states.every((state) => state === states[0]) ? `${names} 现在都是${states[0]}`
      : fresh.map((agent, i) => `${agent.name} ${i === 0 ? "现在是" : "是"}${states[i]}`).join("，");
    lines.push({ text: `  复制后替换同名的${replaced}定义。开关按定义名记，${switches}。`, tone: "muted" });
  }
  if (layer === "user" && input.projectAgentsDir !== null) {
    for (const agent of fresh) {
      if (existsSync(join(input.projectAgentsDir, `${agent.name}.md`))) {
        lines.push({ text: `  项目层已有 ${agent.name}，在这个项目里用的是项目层那份，用户层这份不生效。`, tone: "warning" });
      }
    }
  }
  const { heading, state } = inspection.section;
  lines.push({ text: `AGENTS.md → ${tilde(targets.conventionsFile)}` });
  if (state === "same") lines.push({ text: `  已有「${heading}」一段，和样例一致，不动` });
  else if (state === "changed") lines.push({ text: `  已有「${heading}」一段，和样例不一样，不动`, tone: "warning" });
  else if (conventions.over) {
    lines.push({ text: `  合并后 ${conventions.bytes} 字节，超过 16 KB 上限 ${conventions.excess} 字节，这次不写。`, tone: "warning" },
      { text: "  精简 AGENTS.md 后再运行 /one:examples，会只补写这一段。", tone: "warning" });
  } else if (conventions.before === null) lines.push({ text: "  还没有 AGENTS.md，新建一份，下一步给你看全文再写" });
  else lines.push({ text: `  追加「${heading}」一段，下一步给你看差异再写` });
  return lines;
}

export function conventionsWindow(input: { layer: LayerKey; file: string; before: string | null; merged: string; linkTarget?: string | null }) {
  const title = input.layer === "user" ? `把这些改动写入用户规范 ${tilde(input.file)}？` : "把这些改动写入项目规范 AGENTS.md？";
  const lines: WindowLine[] = [
    ...(input.linkTarget ? [{ text: `AGENTS.md 是软链接，实际写到 ${tilde(input.linkTarget)}`, tone: "warning" } satisfies WindowLine] : []),
    { text: input.before === null ? "还没有 AGENTS.md，要写入的全文如下：" : "与现有的 AGENTS.md 相比的改动：", tone: "muted" },
    ...lineDiff((input.before ?? "").replace(/\r\n/g, "\n"), input.merged.replace(/\r\n/g, "\n")).map((text): WindowLine => ({ text, tone: text.startsWith("+ ") ? "added" : "muted" })),
    { text: "" },
    { text: "写入后，此后派出的 PM、worker、reviewer 都按新内容工作。", tone: "muted" },
  ];
  const choices: WindowChoice[] = [{ label: WRITE }, { label: SKIP_WRITE }];
  return { title, lines, choices, cancelNote: SKIP_WRITE };
}

export function resultText(input: { label: string; layer: LayerKey; written: number; skipped: string[]; inspection: ExampleInspection; conventionsFile: string; outcome: Outcome; writeError?: Error; writeDir?: string }): string {
  const { heading, state } = input.inspection.section;
  const wrote = input.outcome === "written";
  const lines = [`✓ ${input.label}样例已复制到${LAYER_NAME[input.layer]}：新复制 ${input.written} 个文件${wrote ? `，AGENTS.md 已写入「${heading}」` : ""}。`];
  const untouched = state === "changed" ? `AGENTS.md 的「${heading}」一段也没动` : "";
  if (input.skipped.length > 0) lines.push(`被改过、没有覆盖：${input.skipped.map(tilde).join("、")}${untouched && `；${untouched}`}。`);
  if (input.outcome === "declined") lines.push("AGENTS.md 没有写入；想补上就再运行 /one:examples。");
  else if (input.outcome === "over") lines.push("AGENTS.md 合并后超过 16 KB 上限，没有写入；精简后再运行 /one:examples 补写。");
  else if (input.outcome === "changed") lines.push(`确认期间 ${tilde(input.conventionsFile)} 被别处改动，这次没有写入；再运行 /one:examples 补写。`);
  else if (input.outcome === "failed" && input.writeError) {
    const code = (input.writeError as NodeJS.ErrnoException).code;
    const reason = code === "EACCES" || code === "EPERM" ? `没有权限写入 ${tilde(input.writeDir ?? dirname(input.conventionsFile))}${sep}` : code ?? input.writeError.message.split("\n")[0];
    lines.push(`AGENTS.md 没有写入：${reason}；解决后再运行 /one:examples 补写。`);
  } else if (wrote && input.skipped.length === 0) lines.push("此后派出的代理按新规范工作。");
  return lines.join("\n  ");
}

export function copyFailureText(error: ExampleCopyError): string {
  const reason = error.code === "EACCES" || error.code === "EPERM" ? "没有权限写入"
    : error.code === "EEXIST" ? "目标位置已有别处写的同名文件" : error.message.split("\n")[0];
  return `✗ 复制没有完成：${reason} ${tilde(error.dir)}${sep}\n  已复制的 ${error.written} 个文件保留，AGENTS.md 没有动；解决后再运行 /one:examples 会接着补。`;
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
    lines: mutedLines(["选中后再选复制到哪一层；skills、角色定义和 AGENTS.md 那一段一起复制。"]),
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
  // 第一个窗口之后可能已有别处写入，按此刻的文件重新判定，避免覆盖或重复追加
  const inspection = await inspect(row.name, layer);
  const exampleText = await readFile(join(root, row.name, "AGENTS.md"), "utf8");
  const before = await readTextOrNull(targets.conventionsFile);
  const merged = mergeConventions(before, exampleText);
  const disabled = readDisabledAgents({ agentDir, repositoryRoot: repoRoot, projectTrusted: trust === "trusted" || layer === "project" });
  const decision = await chooseWindow(ctx, {
    title: `把 ${row.label}样例复制到${LAYER_NAME[layer]}？`,
    lines: confirmLines({ inspection, targets, layer, userAgentsDir: targetsOf.user.agentsDir, projectAgentsDir: trust === "trusted" || layer === "project" ? targetsOf.project.agentsDir : null, disabled,
      conventions: { before, over: merged.over, bytes: merged.bytes, excess: merged.excess } }),
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

  let outcome: Outcome = "none";
  let writeError: Error | undefined, writeDir = dirname(targets.conventionsFile);
  if (inspection.section.state === "missing") {
    if (merged.over) outcome = "over";
    else {
      const linkTarget = await symlinkTarget(targets.conventionsFile);
      const answer = await chooseWindow(ctx, conventionsWindow({ layer, file: targets.conventionsFile, before, merged: merged.content, linkTarget }));
      if (answer !== WRITE) outcome = "declined";
      else if (await readTextOrNull(targets.conventionsFile) !== before) outcome = "changed";
      else {
        try {
          await writeFileAtomic(targets.conventionsFile, merged.content, { followSymlink: true });
          outcome = "written";
        } catch (error) {
          writeError = error as Error;
          if (linkTarget) writeDir = dirname(linkTarget);
          outcome = "failed";
        }
      }
    }
  }
  const skipped = [...inspection.skills.flatMap((skill) => skill.files), ...inspection.agents].filter((file) => file.state === "changed").map((file) => file.path);
  ctx.ui.notify(resultText({ label: row.label, layer, written: written.length, skipped, inspection, conventionsFile: targets.conventionsFile, outcome, writeError, writeDir }) + (trustWritten ? " · 已把本项目设为受信任" : ""));
}
