import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LEGACY_ROOT = ".pi-spec/requirements";

export function legacyRequirementDir(worktreeRoot: string, reqId: string): string {
  return join(worktreeRoot, LEGACY_ROOT, reqId);
}

function requirementsMdContent(opts: { slug: string; title: string; status: string; body?: string }): string {
  const body = opts.body ?? `# ${opts.title}\n\n## 1. 背景\n\n占位正文，用于验证迁移逐字保留。\n`;
  return `---\nname: ${opts.slug}\ntitle: ${opts.title}\nstatus: ${opts.status}\ncreated: 2026-01-01\n---\n\n${body}`;
}

export interface LegacyTaskFileSpec {
  id: string;
  title: string;
  status: string;
  step?: string;
  agent?: string;
  commit?: string;
  note?: string;
  refs?: string[];
  verify?: string;
  body?: string;
}

function taskFileContent(spec: LegacyTaskFileSpec): string {
  const lines = [
    "---",
    `id: ${spec.id}`,
    `title: ${spec.title}`,
    "depends_on: []",
    "files: []",
    `refs: [${(spec.refs ?? []).join(", ")}]`,
    "parallel: true",
    `status: ${spec.status}`,
  ];
  if (spec.step !== undefined) lines.push(`step: ${spec.step}`);
  if (spec.agent !== undefined) lines.push(`agent: ${spec.agent}`);
  if (spec.commit !== undefined) lines.push(`commit: ${spec.commit}`);
  if (spec.note !== undefined) lines.push(`note: "${spec.note}"`);
  if (spec.verify !== undefined) lines.push(`verify: ${spec.verify}`);
  lines.push("---", "", `# ${spec.title}`, "", spec.body ?? "## 1. 目标\n\n占位任务正文，用于验证迁移逐字保留。\n");
  return lines.join("\n");
}

function decisionLine(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

export function aiDecisionRecord(id: string, requirement: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    actor: "ai",
    source: "integration-test",
    requirement,
    trigger: "触发说明",
    decision: "决定内容",
    scope: "范围",
    basis: ["依据"],
    alternatives: [],
    action: "行动",
    ...overrides,
  };
}

export interface SeedLegacyRequirementOptions {
  slug: string;
  title?: string;
  requirementStatus: string;
  tasks: LegacyTaskFileSpec[];
  aiDecisions?: Array<Record<string, unknown> | string>;
  userDecisions?: Array<Record<string, unknown> | string>;
  acceptance?: string;
}

export async function seedLegacyRequirement(worktreeRoot: string, opts: SeedLegacyRequirementOptions): Promise<string> {
  const dir = legacyRequirementDir(worktreeRoot, opts.slug);
  await mkdir(join(dir, "tasks"), { recursive: true });
  await writeFile(
    join(dir, "requirements.md"),
    requirementsMdContent({ slug: opts.slug, title: opts.title ?? opts.slug, status: opts.requirementStatus }),
  );
  for (const [index, task] of opts.tasks.entries()) {
    const fileName = `${String(index + 1).padStart(2, "0")}-${task.id.toLowerCase()}.md`;
    await writeFile(join(dir, "tasks", fileName), taskFileContent(task));
  }
  const aiLines = (opts.aiDecisions ?? []).map((r) => (typeof r === "string" ? r : decisionLine(r)));
  const userLines = (opts.userDecisions ?? []).map((r) => (typeof r === "string" ? r : decisionLine(r)));
  await writeFile(join(dir, "ai-decisions.jsonl"), aiLines.length ? `${aiLines.join("\n")}\n` : "");
  await writeFile(join(dir, "user-decisions.jsonl"), userLines.length ? `${userLines.join("\n")}\n` : "");
  if (opts.acceptance !== undefined) {
    await writeFile(join(dir, "acceptance.md"), opts.acceptance);
  }
  return dir;
}

export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error("fixture 内容缺少 frontmatter");
  return { frontmatter: match[1] as string, body: match[2] as string };
}
