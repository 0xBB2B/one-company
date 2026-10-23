import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultRoleDir } from "../agents/roles.ts";
import { MAX_CONVENTIONS_BYTES } from "../verification/project-conventions.ts";

export const EXAMPLE_LABELS: Record<string, string> = {
  golang: "Go 后端",
  vue: "Vue 前端",
};

export type FileState = "missing" | "same" | "changed";
export type Overall = "未复制" | "已复制" | "有改动" | "部分复制";

export interface ExampleTargets {
  skillsDir: string;
  agentsDir: string;
  conventionsFile: string;
}

export interface FileInspection {
  path: string;
  source: string;
  state: FileState;
}

export interface SkillInspection {
  name: string;
  state: FileState;
  files: FileInspection[];
}

export interface AgentInspection extends FileInspection {
  name: string;
}

export interface ExampleInspection {
  skills: SkillInspection[];
  agents: AgentInspection[];
  section: { heading: string; state: FileState };
  overall: Overall;
}

interface ExampleInput {
  examplesDir: string;
  example: string;
  targets: ExampleTargets;
}

export function examplesDir(): string {
  return join(defaultRoleDir(), "..", "examples");
}

export async function listExamples(): Promise<{ name: string; label: string }[]> {
  const entries = await readdir(examplesDir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, label: EXAMPLE_LABELS[name] ?? name }));
}

export function layerTargets(layer: "user" | "project", dirs: { agentDir: string; repoRoot: string }): ExampleTargets {
  if (layer === "user") {
    return {
      skillsDir: join(dirs.agentDir, "skills"),
      agentsDir: join(dirs.agentDir, "agents"),
      conventionsFile: join(dirs.agentDir, "AGENTS.md"),
    };
  }
  return {
    skillsDir: join(dirs.repoRoot, ".pi", "skills"),
    agentsDir: join(dirs.repoRoot, ".pi", "agents"),
    conventionsFile: join(dirs.repoRoot, "AGENTS.md"),
  };
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function compareFile(source: string, path: string): Promise<FileInspection> {
  const [expected, actual] = await Promise.all([readFile(source), readOrNull(path)]);
  const state = actual === null ? "missing" : actual.equals(expected) ? "same" : "changed";
  return { path, source, state };
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(dir, relative)));
    else files.push(relative);
  }
  return files.sort();
}

export function findSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function skillState(files: FileInspection[]): FileState {
  if (files.some((f) => f.state === "changed")) return "changed";
  if (files.some((f) => f.state === "missing")) return "missing";
  return "same";
}

function overallOf(states: FileState[]): Overall {
  if (states.every((s) => s === "missing")) return "未复制";
  if (states.every((s) => s === "same")) return "已复制";
  if (states.some((s) => s === "changed")) return "有改动";
  return "部分复制";
}

export async function inspectExample(input: ExampleInput): Promise<ExampleInspection> {
  const { examplesDir: root, example, targets } = input;
  const exampleDir = join(root, example);

  const skillsSource = join(exampleDir, "skills");
  const skillNames = (await readdir(skillsSource, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills: SkillInspection[] = [];
  for (const name of skillNames) {
    const relatives = await listFiles(join(skillsSource, name));
    const files = await Promise.all(
      relatives.map((relative) => compareFile(join(skillsSource, name, relative), join(targets.skillsDir, name, relative))),
    );
    skills.push({ name, state: skillState(files), files });
  }

  const agentsSource = join(exampleDir, "agents");
  const agentFiles = (await readdir(agentsSource)).filter((file) => file.endsWith(".md")).sort();
  const agents = await Promise.all(
    agentFiles.map(async (file) => ({
      name: file.slice(0, -".md".length),
      ...(await compareFile(join(agentsSource, file), join(targets.agentsDir, file))),
    })),
  );

  const exampleText = await readFile(join(exampleDir, "AGENTS.md"), "utf8");
  const heading = exampleText.split("\n")[0].trimEnd();
  const targetText = await readOrNull(targets.conventionsFile);
  const found = targetText === null ? null : findSection(targetText.toString("utf8"), heading);
  const sectionState: FileState = found === null ? "missing" : found.trimEnd() === exampleText.trimEnd() ? "same" : "changed";

  const overall = overallOf([...skills.map((s) => s.state), ...agents.map((a) => a.state), sectionState]);
  return { skills, agents, section: { heading, state: sectionState }, overall };
}

export function mergeConventions(before: string | null, example: string) {
  const content = before === null ? example : `${before.replace(/\n+$/, "")}\n\n${example}`;
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, bytes, over: bytes > MAX_CONVENTIONS_BYTES, excess: Math.max(0, bytes - MAX_CONVENTIONS_BYTES) };
}

export class ExampleCopyError extends Error {
  written: number;
  dir: string;
  code: string | undefined;

  constructor(written: number, dir: string, code: string | undefined, message: string) {
    super(message);
    this.name = "ExampleCopyError";
    this.written = written;
    this.dir = dir;
    this.code = code;
  }
}

export async function copyExampleFiles(input: ExampleInput & { inspection: ExampleInspection }): Promise<string[]> {
  const { agents, skills } = input.inspection;
  const pending = [...agents, ...skills.flatMap((skill) => skill.files)].filter((file) => file.state === "missing");
  const written: string[] = [];
  for (const file of pending) {
    try {
      await mkdir(dirname(file.path), { recursive: true });
      // 判定到写入之间隔着确认窗口，目标位置可能已被别处写入，不能覆盖
      await writeFile(file.path, await readFile(file.source), { flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ExampleCopyError(written.length, dirname(file.path), code, `写入 ${file.path} 失败：${(error as Error).message}`);
    }
    written.push(file.path);
  }
  return written;
}
