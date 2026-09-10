import { readGit } from "./git-read.ts";
import { fingerprint } from "./ranges.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { changedPaths, collectContentFingerprint } from "./git-snapshot.ts";
import { ACCEPTANCE_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, validateResult } from "./result.ts";
import type { AcceptanceResult, Phase, WorkResult } from "./result.ts";
import type { RunRecord } from "./run-store.ts";
import { currentVersion } from "./workflow-tool.ts";

const execFileAsync = promisify(execFile);

export function acceptanceReportPath(cwd: string, requirement: string): string {
  return resolve(cwd, ".pi-company", "requirements", requirement, "acceptance.md");
}

async function workspaceContent(run: RunRecord): Promise<string> {
  if (run.phase === "work") {
    try {
      const task = await readTaskDefinition(run.cwd, run.requirement, run.task);
      const files = [...task.files, task.sourceFile, ...task.refs.map((ref) => join(run.cwd, ".pi-company", "spec", ref.replace(/\/AC-\d+$/, ".md")))];
      return createHash("sha256").update(JSON.stringify(await fingerprint(run.cwd, files))).digest("hex");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return collectContentFingerprint(run.cwd, [`.pi-company/requirements/${run.requirement}/acceptance.md`]);
}

export async function bindRunResult(run: RunRecord, phase: Phase, value: unknown) {
  if (phase === "plan") {
    const lint = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/spec-docs/scripts/lint.sh");
    const requirementFile = join(run.cwd, ".pi-company", "requirements", run.requirement, "requirements.md");
    for (const args of [[lint, requirementFile], [lint, "--tasks", requirementFile]]) {
      try { await execFileAsync("bash", args, { cwd: run.cwd, timeout: 30_000 }); }
      catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`规划产物检查失败: ${[failure.stdout, failure.stderr].filter(Boolean).join("\n").trim() || failure.message}`, { cause: error });
      }
    }
  }
  const checked = phase === "plan" ? { ok: true as const }
    : validateResult({ work: WORK_SCHEMA, review: REVIEW_SCHEMA, acceptance: ACCEPTANCE_SCHEMA }[phase], phase, value);
  if (!checked.ok) throw new Error(`交付格式或语义不合法: ${checked.errors.join("；")}`);
  const version = await currentVersion({ cwd: run.cwd, requirement: run.requirement });
  return {
    ...(phase === "plan" ? { phase: "plan", verdict: "PASS", summary: String(value ?? "规划完成") } : value as Record<string, unknown>),
    binding: { requirement: run.requirement, task: run.task, cwd: await realpath(run.cwd), ...version, workspaceContent: await workspaceContent(run) },
  };
}

export async function checkAcceptanceReport(value: AcceptanceResult, expectedPath: string, commands: string[] = []): Promise<string> {
  const reportPath = await realpath(value.reportPath);
  if (reportPath !== await realpath(expectedPath)) throw new Error("验收报告位置与指定位置不一致");
  const content = await readFile(reportPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  if (frontmatter.result !== value.acceptanceResult || typeof frontmatter.date !== "string" || !frontmatter.date.trim()) {
    throw new Error("验收报告缺日期或结论与结构化结果不一致");
  }
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim().replace(/\\\|/g, "|")));
  for (const item of value.items) {
    const matched = rows.filter((row) => row[0] === item.id);
    if (matched.length !== 1 || matched[0]![1] !== item.result || matched[0]![2] !== item.observed || (matched[0]![3] ?? "") !== item.difference) {
      throw new Error(`验收报告结果与裁决不一致: ${item.id}`);
    }
  }
  const commandSection = body.match(/^## 所用命令\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  if (commandSection === undefined || commands.some((command) => !commandSection.includes(command))) throw new Error("验收报告未列出实际执行的全部命令");
  if (value.uncovered.some((item) => !body.includes(item))) throw new Error("验收报告未覆盖项与裁决不一致");
  return createHash("sha256").update(content).digest("hex");
}

interface TaskDefinition {
  sourceFile: string;
  id: string;
  refs: string[];
  files: string[];
  verify: string;
}

export async function readTaskDefinition(cwd: string, requirement: string, taskId: string): Promise<TaskDefinition> {
  const dir = join(cwd, ".pi-company", "requirements", requirement, "tasks");
  const found: TaskDefinition[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".md")) continue;
    const { frontmatter, body } = parseFrontmatter(await readFile(join(dir, name), "utf8"));
    if (frontmatter.id !== taskId) continue;
    if (!Array.isArray(frontmatter.refs) || frontmatter.refs.length === 0 || !frontmatter.refs.every((v) => typeof v === "string" && v.trim()) ||
      !Array.isArray(frontmatter.files) || !frontmatter.files.every((v) => typeof v === "string" && v.trim()) ||
      typeof frontmatter.verify !== "string" || !frontmatter.verify.trim()) throw new Error(`任务定义缺少合法 refs/files/verify: ${taskId}`);
    const section = body.match(/^## 涉及文件\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
    const declared = [...section.matchAll(/^- (?:新建|修改)（(?:生产|测试|非生产)）：(.+?) — .+$/gm)].map((match) => match[1]!.trim());
    found.push({ ...frontmatter, files: [...new Set([...frontmatter.files, ...declared])], sourceFile: join(dir, name) } as unknown as TaskDefinition);
  }
  if (found.length !== 1) throw new Error(`任务定义必须唯一且存在: ${taskId}`);
  return found[0]!;
}

function within(path: string, boundary: string): boolean {
  return path === boundary || path.startsWith(`${boundary}${sep}`);
}

export async function verifyTaskDelivery(input: { run: RunRecord; execute(command: string): Promise<void> }): Promise<Record<string, unknown>> {
  const { run } = input;
  if (run.state !== "completed") throw new Error("交付运行尚未正常完成");
  const saved = run.result as Record<string, unknown> | undefined;
  if (!saved?.binding) throw new Error("交付缺少系统绑定");
  const { binding, delivery: _delivery, ...raw } = saved;
  const checked = validateResult(WORK_SCHEMA, "work", raw);
  if (!checked.ok) throw new Error(`交付不合法: ${checked.errors.join("；")}`);
  const result = raw as WorkResult;
  if (result.verdict !== "PASS") throw new Error("交付裁决未通过");
  const current = await currentVersion({ cwd: run.cwd, requirement: run.requirement });
  const recorded = binding as Record<string, unknown>;
  if (recorded.requirement !== run.requirement || recorded.task !== run.task || recorded.cwd !== await realpath(run.cwd) ||
    recorded.workspaceContent !== await workspaceContent(run)) throw new Error("交付版本或工作现场已变化，须重新核对交付");
  if (recorded.codeHead !== current.codeHead) {
    await readGit(run.cwd, ["merge-base", "--is-ancestor", String(recorded.codeHead), current.codeHead]);
  }
  const task = await readTaskDefinition(run.cwd, run.requirement, run.task);
  const root = await realpath(run.cwd);
  for (const ref of task.refs) {
    const coverage = result.coverage.filter((item) => item.ref === ref);
    if (coverage.length !== 1) throw new Error(`验收映射缺失或重复: ${ref}`);
    const match = coverage[0]!.test.match(/^(.+?):(\d+)(?::.*)?$/);
    if (!match) throw new Error(`测试映射必须定位到文件与行号: ${ref}`);
    const file = await realpath(resolve(root, match[1]!));
    if (!within(file, root) || !task.files.some((path) => resolve(root, path) === file)) throw new Error(`测试不在任务验证范围: ${ref}`);
    const lines = (await readFile(file, "utf8")).split("\n");
    if (Number(match[2]) < 1 || Number(match[2]) > lines.length || !lines[Number(match[2]) - 1]!.trim()) throw new Error(`测试位置无法定位: ${ref}`);
  }
  if (result.coverage.some((item) => !task.refs.includes(item.ref))) throw new Error("交付包含任务之外的验收映射");
  if (!result.greenCommands.some((item) => item.command === task.verify && item.status === "passed")) throw new Error("最终验证命令与任务约定不一致");
  const allowed = run.writePaths.map((path) => resolve(root, path));
  const changes = await changedPaths(root);
  if (result.changedFiles.some((path) => !allowed.some((scope) => within(resolve(root, path), scope)))) throw new Error("交付改动清单越出授权范围");
  if (changes.some((path) => [...allowed, ...task.files.map((file) => resolve(root, file))].some((scope) => within(resolve(root, path), scope)))) throw new Error("获准范围仍有未提交改动，请经正常提交入口提交交付文件后再核验");
  if (result.changedFiles.length === 0 && (result.workState !== "green-baseline-no-change" || result.preexistingEvidence.length === 0)) throw new Error("无改动交付缺少既有行为证据");
  if (result.changedFiles.length > 0) {
    const committed = (await readGit(root, ["diff", "--name-only", String(run.sourceVersion?.codeHead ?? recorded.codeHead), current.codeHead])).stdout.split("\n").filter(Boolean);
    if (result.changedFiles.some((path) => !committed.some((file) => resolve(root, file) === resolve(root, path)))) throw new Error("提交未包含声明的交付改动");
  }
  await input.execute(task.verify);
  const after = await currentVersion({ cwd: root, requirement: run.requirement });
  if (after.definitionFingerprint !== current.definitionFingerprint || after.codeHead !== current.codeHead || await workspaceContent(run) !== recorded.workspaceContent) throw new Error("复跑期间代码、定义或工作现场发生变化，验证失效");
  const evidenceFiles = [...task.files, task.sourceFile, ...task.refs.map((ref) => join(root, ".pi-company", "spec", ref.replace(/\/AC-\d+$/, ".md")))];
  const fileFingerprints = await fingerprint(root, evidenceFiles);
  return { ...await bindRunResult(run, "work", result), delivery: { verificationOk: true, commit: result.changedFiles.length > 0 ? current.codeHead : null, command: task.verify, fileFingerprints } };
}
