import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture, WorktreeFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import type { TempHome } from "./helpers/temp-home.ts";
import { readDecisions } from "../runtime/decisions.ts";
import { repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { createRecord, readRecord, writeRecord, putRecord, repositoryDatabase } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { deleteRecord } from "./helpers/database-fixture.ts";
import {
  clearMigratedSourceFields,
  dedupeDecisions,
  migrationApply,
  migrationPreflight,
  migrationStatus,
  resumeMigration,
} from "../runtime/migration.ts";

const execFileAsync = promisify(execFile);

const LEGACY_ROOT = ".pi-spec/requirements";

const repoFixtures: RepoFixture[] = [];
const tempHomes: TempHome[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
});

async function makeRepo(): Promise<RepoFixture> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  return repo;
}

async function makeWorktree(repo: RepoFixture): Promise<WorktreeFixture> {
  return addWorktree(repo);
}

async function makeHome(): Promise<TempHome> {
  const home = await createTempHome();
  tempHomes.push(home);
  return home;
}

function requirementDir(worktreeRoot: string, reqId: string): string {
  return join(worktreeRoot, LEGACY_ROOT, reqId);
}

function requirementsMdContent(opts: { slug: string; title: string; status: string; body?: string }): string {
  const body = opts.body ?? `# ${opts.title}\n\n## 1. 背景\n\n占位正文，用于验证迁移逐字保留。\n`;
  return `---\nname: ${opts.slug}\ntitle: ${opts.title}\nstatus: ${opts.status}\ncreated: 2026-01-01\n---\n\n${body}`;
}

interface TaskFileSpec {
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

function taskFileContent(spec: TaskFileSpec): string {
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

function aiDecisionRecord(id: string, requirement: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    actor: "ai",
    source: "migration-test",
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

function userDecisionRecord(id: string, requirement: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    recordedAt: "2026-01-01T00:00:00.000Z",
    actor: "user",
    source: "migration-test",
    requirement,
    trigger: "触发说明",
    decision: "决定内容",
    alternatives: [],
    impact: "影响说明",
    ...overrides,
  };
}

function aiDecisionRecordWithoutId(requirement: string, decision: string): Record<string, unknown> {
  return {
    recordedAt: "2026-01-01T00:00:00.000Z",
    actor: "ai",
    source: "migration-test",
    requirement,
    trigger: "触发说明",
    decision,
    scope: "范围",
    basis: ["依据"],
    alternatives: [],
    action: "行动",
  };
}

interface SeedOptions {
  slug: string;
  title?: string;
  requirementStatus: string;
  tasks: TaskFileSpec[];
  aiDecisions?: Array<Record<string, unknown> | string>;
  userDecisions?: Array<Record<string, unknown> | string>;
  acceptance?: string;
}

async function seedLegacyRequirement(worktreeRoot: string, opts: SeedOptions): Promise<string> {
  const dir = requirementDir(worktreeRoot, opts.slug);
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

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error("fixture 内容缺少 frontmatter");
  return { frontmatter: match[1] as string, body: match[2] as string };
}

function frontmatterHasKey(frontmatter: string, key: string): boolean {
  return new RegExp(`(^|\\n)${key}:`).test(frontmatter);
}

async function noActiveWindows(): Promise<boolean | null> {
  return false;
}

async function alwaysTrue(): Promise<boolean | null> {
  return true;
}

async function alwaysNull(): Promise<boolean | null> {
  return null;
}

async function repoCommitCount(repoRoot: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["log", "--oneline"], { cwd: repoRoot });
  return stdout.split("\n").filter((line) => line.length > 0).length;
}

async function migrationProgressPath(dataRoot: string, cwd: string) {
  const identity = await repositoryIdentity(cwd);
  return { database: repositoryDatabase(dataRoot, identity.repoId), namespace: "migration", key: "progress" };
}

async function stateDocPath(dataRoot: string, cwd: string, requirement: string) {
  const identity = await repositoryIdentity(cwd);
  return requirementStateRef(dataRoot, identity.repoId, requirement);
}

async function readStateDoc(dataRoot: string, cwd: string, requirement: string) {
  const path = await stateDocPath(dataRoot, cwd, requirement);
  return readRecord(path);
}

async function windowProbeThrows(): Promise<boolean | null> {
  throw new Error("窗口探针不可用");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("migrationPreflight 只读列出与稳定指纹", () => {
  test("列出目标仓库全部 worktree 中所有需求的来源与覆盖文件，含已完成需求", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    await seedLegacyRequirement(wtA.root, {
      slug: "2026-01-01.in-progress-a",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", "2026-01-01.in-progress-a")],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: "2026-01-02.completed-b",
      requirementStatus: "accepted",
      tasks: [{ id: "T-1", title: "任务一", status: "done", step: "done", agent: "agent-x", commit: "abc1234" }],
      userDecisions: [userDecisionRecord("USER-001", "2026-01-02.completed-b")],
      acceptance: "# 验收报告\n\n通过。\n",
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const requirementIds = preflight.sources.map((s) => s.requirement);
    expect(requirementIds).toContain("2026-01-01.in-progress-a");
    expect(requirementIds).toContain("2026-01-02.completed-b");
    const sourceA = preflight.sources.find((s) => s.requirement === "2026-01-01.in-progress-a");
    const sourceB = preflight.sources.find((s) => s.requirement === "2026-01-02.completed-b");
    expect(sourceA?.files.some((f) => f.endsWith("requirements.md"))).toBe(true);
    expect(sourceB?.files.some((f) => f.endsWith("acceptance.md"))).toBe(true);
    expect(typeof preflight.fingerprint).toBe("string");
    expect(preflight.fingerprint.length).toBeGreaterThan(0);
  });

  test("独立仓库不在扫描范围内", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    await seedLegacyRequirement(repo.root, {
      slug: "2026-01-03.scoped",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const otherRepo = await makeRepo();
    await seedLegacyRequirement(otherRepo.root, {
      slug: "2026-01-04.unscoped",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const requirementIds = preflight.sources.map((s) => s.requirement);
    expect(requirementIds).toContain("2026-01-03.scoped");
    expect(requirementIds).not.toContain("2026-01-04.unscoped");
    expect(preflight.sources.every((s) => !s.worktree.startsWith(otherRepo.root))).toBe(true);
  });

  test("预检不修改任何源文件", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    await seedLegacyRequirement(repo.root, {
      slug: "2026-01-05.readonly",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-y" }],
      aiDecisions: [aiDecisionRecord("AI-001", "2026-01-05.readonly")],
    });
    const dir = requirementDir(repo.root, "2026-01-05.readonly");
    const before = await readFile(join(dir, "tasks", "01-t-1.md"), "utf8");

    await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const after = await readFile(join(dir, "tasks", "01-t-1.md"), "utf8");
    expect(after).toBe(before);
  });

  test("源未变化时重复预检的指纹一致", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    await seedLegacyRequirement(repo.root, {
      slug: "2026-01-06.stable",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    const first = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const second = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe("migrationPreflight 冲突与损坏检测", () => {
  test("同编号不同内容的决策记录报告问题", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-01-07.decision-conflict";
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", reqId, { decision: "版本 A 的决定" })],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", reqId, { decision: "版本 B 的决定" })],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);
  });

  test("同一需求在不同 worktree 的任务阶段分歧报告问题", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-01-08.task-phase-conflict";
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "done", step: "done", agent: "agent-a", commit: "aaa1111" }],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-b" }],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);
  });

  test("损坏的决策行报告问题", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const reqId = "2026-01-09.corrupted-line";
    await seedLegacyRequirement(repo.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: ["{ 这不是合法的 JSON"],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);
  });
});

describe("migrationApply 授权与写入停止前置条件", () => {
  async function seedSimpleRequirement(root: string, slug: string): Promise<void> {
    await seedLegacyRequirement(root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", slug)],
    });
  }

  test("未授权时阻塞并列明条件，源数据未变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-10.unauthorized";
    await seedSimpleRequirement(repo.root, slug);
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const before = await readFile(join(requirementDir(repo.root, slug), "requirements.md"), "utf8");

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: false,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.length).toBeGreaterThan(0);
    const after = await readFile(join(requirementDir(repo.root, slug), "requirements.md"), "utf8");
    expect(after).toBe(before);
  });

  test("存在活动窗口时阻塞，源数据未变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-11.active-window";
    await seedSimpleRequirement(repo.root, slug);
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: alwaysTrue,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.length).toBeGreaterThan(0);
  });

  test("无法确认活动窗口（探针返回 null）时阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-12.unknown-window";
    await seedSimpleRequirement(repo.root, slug);
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: alwaysNull,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.length).toBeGreaterThan(0);
  });

  test("旧写入方式未切换时阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-13.writes-not-switched";
    await seedSimpleRequirement(repo.root, slug);
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: false,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.length).toBeGreaterThan(0);
  });

  test("预检指纹与 expectedFingerprint 不一致时阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-14.fingerprint-mismatch";
    await seedSimpleRequirement(repo.root, slug);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: "不匹配的指纹",
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.length).toBeGreaterThan(0);
  });
});

describe("migrationApply 去重与冲突阻塞", () => {
  test("两个 worktree 的相同决策记录迁入后只有一份，编号与原文一致", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-01-15.same-decision-twice";
    const decision = aiDecisionRecord("AI-001", reqId, { decision: "唯一的决定内容" });
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [decision],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [decision],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(false);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(true);
    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: reqId, actor: "ai" });
    const matching = records.filter((r) => (r as { id?: string }).id === "AI-001");
    expect(matching.length).toBe(1);
    expect((matching[0] as { decision?: string }).decision).toBe("唯一的决定内容");
  });

  test("决策冲突时 apply 阻塞，不迁移该需求", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-01-16.blocked-by-conflict";
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", reqId, { decision: "版本 A" })],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecord("AI-001", reqId, { decision: "版本 B" })],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.some((b) => b.includes(reqId))).toBe(true);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).not.toContain(reqId);
  });

  test("损坏行时 apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const reqId = "2026-01-17.blocked-by-corruption";
    await seedLegacyRequirement(repo.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      userDecisions: ["不是合法 JSON 的一行"],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
  });
});

describe("migrationApply 成功迁移", () => {
  async function seedAndApply(repo: RepoFixture, home: TempHome, slug: string) {
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-z", note: "进行中备注" }],
      aiDecisions: [aiDecisionRecord("AI-001", slug)],
      userDecisions: [userDecisionRecord("USER-001", slug)],
      acceptance: "# 验收报告\n\n占位验收内容，须逐字保留。\n",
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    return result;
  }

  test("条件齐全时 apply 成功并可在本机查询状态与决策", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-18.apply-success";
    const result = await seedAndApply(repo, home, slug);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migrated).toContain(slug);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).toContain(slug);
    const aiRecords = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "ai" });
    expect(aiRecords.some((r) => (r as { id?: string }).id === "AI-001")).toBe(true);
    const userRecords = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "user" });
    expect(userRecords.some((r) => (r as { id?: string }).id === "USER-001")).toBe(true);
  });

  test("任务文件不再含运行字段但正文逐字不变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-19.task-fields-cleared";
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const before = splitFrontmatter(await (async () => {
      await seedLegacyRequirement(repo.root, {
        slug,
        requirementStatus: "executing",
        tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-z", note: "进行中备注" }],
        aiDecisions: [aiDecisionRecord("AI-001", slug)],
      });
      return readFile(taskPath, "utf8");
    })());
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(true);

    const after = splitFrontmatter(await readFile(taskPath.replace("/.pi-spec/", "/.pi-company/"), "utf8"));
    expect(after.body).toBe(before.body);
    expect(frontmatterHasKey(after.frontmatter, "status")).toBe(false);
    expect(frontmatterHasKey(after.frontmatter, "step")).toBe(false);
    expect(frontmatterHasKey(after.frontmatter, "agent")).toBe(false);
    expect(frontmatterHasKey(after.frontmatter, "note")).toBe(false);
    expect(frontmatterHasKey(after.frontmatter, "id")).toBe(true);
  });

  test("需求文档 status 字段被移除但正文逐字不变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-20.requirement-status-cleared";
    const reqPath = join(requirementDir(repo.root, slug), "requirements.md");
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const before = splitFrontmatter(await readFile(reqPath, "utf8"));
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(true);

    const after = splitFrontmatter(await readFile(reqPath.replace("/.pi-spec/", "/.pi-company/"), "utf8"));
    expect(after.body).toBe(before.body);
    expect(frontmatterHasKey(after.frontmatter, "status")).toBe(false);
    expect(frontmatterHasKey(after.frontmatter, "name")).toBe(true);
  });

  test("验收报告文件逐字不变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-21.acceptance-untouched";
    const acceptanceContent = "# 验收报告\n\n占位验收内容，须逐字保留。\n";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "accepted",
      tasks: [{ id: "T-1", title: "任务一", status: "done", step: "done", agent: "agent-z", commit: "abc9999" }],
      acceptance: acceptanceContent,
    });
    const acceptancePath = join(requirementDir(repo.root, slug), "acceptance.md");
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(true);

    const after = await readFile(acceptancePath.replace("/.pi-spec/", "/.pi-company/"), "utf8");
    expect(after).toBe(acceptanceContent);
  });

  test("迁移过程不产生任何 git 提交", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-22.no-git-writes";
    const before = await repoCommitCount(repo.root);
    const result = await seedAndApply(repo, home, slug);
    expect(result.ok).toBe(true);

    const after = await repoCommitCount(repo.root);
    expect(after).toBe(before);
  });
});

describe("migrationApply 中断与 resumeMigration 恢复", () => {
  async function seedSlug(repo: RepoFixture, slug: string): Promise<void> {
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-z" }],
      aiDecisions: [aiDecisionRecord("AI-001", slug)],
    });
  }

  test("写目标后校验前中断（beforeVerify 抛错）：status 未完成，源数据仍在", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-23.interrupt-before-verify";
    await seedSlug(repo, slug);
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const beforeSource = await readFile(taskPath, "utf8");
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeVerify: async () => {
          throw new Error("模拟写目标后中断");
        },
      },
    });

    expect(result.ok).toBe(false);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).not.toContain(slug);
    const afterSource = await readFile(taskPath, "utf8");
    expect(afterSource).toBe(beforeSource);
  });

  test("校验通过、清理前中断（beforeClear 抛错）：status 未完成，源运行字段仍在", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-24.interrupt-before-clear";
    await seedSlug(repo, slug);
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟清理前中断");
        },
      },
    });

    expect(result.ok).toBe(false);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).not.toContain(slug);
    const afterSource = splitFrontmatter(await readFile(taskPath, "utf8"));
    expect(frontmatterHasKey(afterSource.frontmatter, "status")).toBe(true);
  });

  test("resumeMigration 恢复后无重复记录", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-25.resume-no-duplicate";
    await seedSlug(repo, slug);
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const interrupted = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟中断，稍后恢复");
        },
      },
    });
    expect(interrupted.ok).toBe(false);

    const resumed = await resumeMigration({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(resumed.ok).toBe(true);
    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "ai" });
    const matching = records.filter((r) => (r as { id?: string }).id === "AI-001");
    expect(matching.length).toBe(1);
  });

  test("中断期间源被修改后重试报告变化，不覆盖已迁移目标", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-26.resume-source-changed";
    await seedSlug(repo, slug);
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const interrupted = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟中断，源即将被修改");
        },
      },
    });
    expect(interrupted.ok).toBe(false);

    await writeFile(
      taskPath,
      taskFileContent({ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-changed" }),
    );

    const resumed = await resumeMigration({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(resumed.ok).toBe(false);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).not.toContain(slug);
  });
});

describe("migrationStatus", () => {
  test("未处理的需求出现在 remaining 中", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-01-27.remaining";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });

    expect(status.remaining).toContain(slug);
    expect(status.completed).not.toContain(slug);
  });
});

describe("dedupeDecisions", () => {
  test("相同编号相同内容的记录只保留一条", () => {
    const record = aiDecisionRecord("AI-001", "2026-01-28.dedupe", { decision: "唯一决定" });
    const deduped = dedupeDecisions([record, { ...record }]);
    expect(deduped.length).toBe(1);
  });

  test("不同记录全部保留", () => {
    const recordA = aiDecisionRecord("AI-001", "2026-01-29.dedupe-keep", { decision: "决定 A" });
    const recordB = aiDecisionRecord("AI-002", "2026-01-29.dedupe-keep", { decision: "决定 B" });
    const deduped = dedupeDecisions([recordA, recordB]);
    expect(deduped.length).toBe(2);
  });
});

describe("clearMigratedSourceFields", () => {
  test("清除任务与需求文档的运行字段，正文逐字不变", async () => {
    const repo = await makeRepo();
    const slug = "2026-01-30.clear-fields";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-z", commit: "def4567", note: "备注" }],
    });
    const dir = requirementDir(repo.root, slug);
    const taskPath = join(dir, "tasks", "01-t-1.md");
    const reqPath = join(dir, "requirements.md");
    const beforeTaskBody = splitFrontmatter(await readFile(taskPath, "utf8")).body;
    const beforeReqBody = splitFrontmatter(await readFile(reqPath, "utf8")).body;

    await clearMigratedSourceFields({ requirementDir: dir });

    const afterTask = splitFrontmatter(await readFile(taskPath, "utf8"));
    const afterReq = splitFrontmatter(await readFile(reqPath, "utf8"));
    expect(afterTask.body).toBe(beforeTaskBody);
    expect(afterReq.body).toBe(beforeReqBody);
    expect(frontmatterHasKey(afterTask.frontmatter, "status")).toBe(false);
    expect(frontmatterHasKey(afterTask.frontmatter, "step")).toBe(false);
    expect(frontmatterHasKey(afterTask.frontmatter, "agent")).toBe(false);
    expect(frontmatterHasKey(afterTask.frontmatter, "commit")).toBe(false);
    expect(frontmatterHasKey(afterTask.frontmatter, "note")).toBe(false);
    expect(frontmatterHasKey(afterReq.frontmatter, "status")).toBe(false);
    expect(frontmatterHasKey(afterReq.frontmatter, "title")).toBe(true);
  });
});

describe("迁移后本机状态字段完整性", () => {
  test("成功迁移后状态文档 stage 与各任务 progress/agent/commit/note 与源一致，history 含迁移来源条目", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-10.state-fields-preserved";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [
        { id: "T-1", title: "任务一", status: "done", step: "done", agent: "agent-a", commit: "aaa1111", note: "任务一备注" },
        { id: "T-2", title: "任务二", status: "doing", step: "impl", agent: "agent-b", note: "任务二备注" },
      ],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(true);

    const doc = await readStateDoc(home.dataRoot, repo.root, slug);
    expect(doc.exists).toBe(true);
    if (!doc.exists) return;
    const data = doc.data as {
      stage: string;
      tasks: Record<string, { progress: string; agent?: string; commit?: string; note?: string }>;
      history: unknown[];
    };
    expect(data.stage).toBe("executing");
    expect(data.tasks["T-1"]?.progress).toBe("done");
    expect(data.tasks["T-1"]?.agent).toBe("agent-a");
    expect(data.tasks["T-1"]?.commit).toBe("aaa1111");
    expect(data.tasks["T-1"]?.note).toBe("任务一备注");
    expect(data.tasks["T-2"]?.progress).toBe("doing");
    expect(data.tasks["T-2"]?.agent).toBe("agent-b");
    expect(data.tasks["T-2"]?.note).toBe("任务二备注");
    expect(data.history.length).toBeGreaterThan(0);
    const historyText = JSON.stringify(data.history).toLowerCase();
    expect(historyText.includes("migrat") || historyText.includes("迁移")).toBe(true);
  });
});

describe("源任务文件清理保留声明式字段", () => {
  test("清理后 id/title/depends_on/files/refs/verify 保留且值不变，正文逐字不变", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-11.task-declarative-fields-kept";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [
        {
          id: "T-1",
          title: "任务一",
          status: "doing",
          step: "impl",
          agent: "agent-z",
          commit: "def7890",
          note: "备注",
          refs: ["spec/foo/AC-1"],
          verify: "bun test tests/foo.test.ts",
        },
      ],
    });
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const before = splitFrontmatter(await readFile(taskPath, "utf8"));

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(true);

    const after = splitFrontmatter(await readFile(taskPath.replace("/.pi-spec/", "/.pi-company/"), "utf8"));
    expect(after.body).toBe(before.body);
    for (const key of ["id", "title", "depends_on", "files", "refs", "verify"]) {
      expect(frontmatterHasKey(after.frontmatter, key)).toBe(true);
    }
    expect(after.frontmatter).toContain("verify: bun test tests/foo.test.ts");
    expect(after.frontmatter).toContain("refs: [spec/foo/AC-1]");
    for (const key of ["status", "step", "agent", "commit", "note", "parallel"]) {
      expect(frontmatterHasKey(after.frontmatter, key)).toBe(false);
    }
  });
});

describe("预检对问题需求目录做错误隔离", () => {
  test("缺少 requirements.md 的目录：预检不抛出且记一条 problem，apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-12.missing-requirements-md";
    const dir = requirementDir(repo.root, slug);
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(join(dir, "tasks", "01-t-1.md"), taskFileContent({ id: "T-1", title: "任务一", status: "doing" }));

    let preflight: Awaited<ReturnType<typeof migrationPreflight>> | undefined;
    let preflightError: unknown;
    try {
      preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    } catch (error) {
      preflightError = error;
    }
    expect(preflightError).toBeUndefined();
    expect(preflight?.problems.some((p) => p.requirement === slug)).toBe(true);

    let applyError: unknown;
    let applyResult: Awaited<ReturnType<typeof migrationApply>> | undefined;
    try {
      applyResult = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight?.fingerprint ?? "",
        hasActiveWindows: noActiveWindows,
      });
    } catch (error) {
      applyError = error;
    }
    expect(applyError).toBeUndefined();
    expect(applyResult?.ok).toBe(false);
  });

  test("目录名不合法（如 archive）：预检不抛出且记一条 problem，apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const dir = join(repo.root, LEGACY_ROOT, "archive");
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(join(dir, "requirements.md"), requirementsMdContent({ slug: "archive", title: "归档", status: "executing" }));
    await writeFile(join(dir, "tasks", "01-t-1.md"), taskFileContent({ id: "T-1", title: "任务一", status: "doing" }));

    let preflight: Awaited<ReturnType<typeof migrationPreflight>> | undefined;
    let preflightError: unknown;
    try {
      preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    } catch (error) {
      preflightError = error;
    }
    expect(preflightError).toBeUndefined();
    expect(preflight?.problems.some((p) => p.requirement === "archive")).toBe(true);

    let applyError: unknown;
    let applyResult: Awaited<ReturnType<typeof migrationApply>> | undefined;
    try {
      applyResult = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight?.fingerprint ?? "",
        hasActiveWindows: noActiveWindows,
      });
    } catch (error) {
      applyError = error;
    }
    expect(applyError).toBeUndefined();
    expect(applyResult?.ok).toBe(false);
  });

  test("决策行为非对象（如 null）：预检不抛出且记一条 problem，apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-13.null-decision-line";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: ["null"],
    });

    let preflight: Awaited<ReturnType<typeof migrationPreflight>> | undefined;
    let preflightError: unknown;
    try {
      preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    } catch (error) {
      preflightError = error;
    }
    expect(preflightError).toBeUndefined();
    expect(preflight?.problems.some((p) => p.requirement === slug)).toBe(true);

    let applyError: unknown;
    let applyResult: Awaited<ReturnType<typeof migrationApply>> | undefined;
    try {
      applyResult = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight?.fingerprint ?? "",
        hasActiveWindows: noActiveWindows,
      });
    } catch (error) {
      applyError = error;
    }
    expect(applyError).toBeUndefined();
    expect(applyResult?.ok).toBe(false);
  });
});

describe("hasActiveWindows 探针异常时的阻塞行为", () => {
  test("探针抛错时视为无法确认，apply 阻塞而不抛出", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-14.probe-throws";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    let applyError: unknown;
    let result: Awaited<ReturnType<typeof migrationApply>> | undefined;
    try {
      result = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight.fingerprint,
        hasActiveWindows: windowProbeThrows,
      });
    } catch (error) {
      applyError = error;
    }

    expect(applyError).toBeUndefined();
    expect(result?.ok).toBe(false);
  });
});

describe("无 id 决策记录的去重与重试", () => {
  test("写目标后进度记录丢失（模拟崩溃）重试：目标只有一条记录且 apply 最终成功", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-15.no-id-decision-resume";
    const decisionText = "唯一的无编号决定";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [aiDecisionRecordWithoutId(slug, decisionText)],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const interrupted = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeVerify: async () => {
          throw new Error("模拟写目标后崩溃");
        },
      },
    });
    expect(interrupted.ok).toBe(false);

    const progressPath = await migrationProgressPath(home.dataRoot, repo.root);
    deleteRecord(progressPath);

    const resumed = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "ai" });
    const matching = records.filter((r) => (r as { decision?: string }).decision === decisionText);
    expect(matching.length).toBe(1);
    expect(resumed.ok).toBe(true);
  });
});

describe("apply 校验按字段逐项核对目标与源", () => {
  test("beforeVerify 钩子篡改目标状态文档的任务字段后 apply 失败，源未清理", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-16.field-level-verify";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", agent: "agent-real", note: "真实备注" }],
    });
    const taskPath = join(requirementDir(repo.root, slug), "tasks", "01-t-1.md");
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeVerify: async () => {
          const path = await stateDocPath(home.dataRoot, repo.root, slug);
          const doc = await readRecord(path);
          if (!doc.exists) throw new Error("目标状态文档尚未写入");
          const data = doc.data as { tasks: Record<string, unknown>; [key: string]: unknown };
          const tampered = {
            ...data,
            tasks: { ...data.tasks, "T-1": { progress: "doing", agent: "agent-real", note: "被篡改的备注" } },
          };
          await writeRecord(path, tampered, { expectedVersion: doc.version });
        },
      },
    });

    expect(result.ok).toBe(false);
    const afterSource = splitFrontmatter(await readFile(taskPath, "utf8"));
    expect(frontmatterHasKey(afterSource.frontmatter, "status")).toBe(true);
  });
});

describe("migrationStatus 呈现中断与失败状态", () => {
  test("beforeClear 中断后 inProgress 含该需求", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-17.status-in-progress";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const interrupted = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟清理前中断");
        },
      },
    });
    expect(interrupted.ok).toBe(false);

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.inProgress).toContain(slug);
  });

  test("清理进行到一半崩溃后重试能收敛完成，不被指纹守卫卡死", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-19.half-cleared";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const base = {
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      hasActiveWindows: noActiveWindows,
    };
    await migrationApply({
      ...base,
      expectedFingerprint: preflight.fingerprint,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟清理前中断");
        },
      },
    });
    const requirementDoc = join(repo.root, ".pi-spec", "requirements", slug, "requirements.md");
    const original = await readFile(requirementDoc, "utf8");
    await writeFile(requirementDoc, original.replace(/^status:.*\n/m, ""));

    const again = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const resumed = await resumeMigration({ ...base, expectedFingerprint: again.fingerprint });
    expect(resumed.ok).toBe(true);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).toContain(slug);
  });

  test("核对后源被外部改写：重试报告变化并阻塞该需求，源字段不被清除", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-21.external-write";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const base = {
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      hasActiveWindows: noActiveWindows,
    };
    await migrationApply({
      ...base,
      expectedFingerprint: preflight.fingerprint,
      hooks: {
        beforeClear: async () => {
          throw new Error("模拟清理前中断");
        },
      },
    });
    const tasksDir = join(repo.root, ".pi-spec", "requirements", slug, "tasks");
    const taskFile = join(tasksDir, (await readdir(tasksDir)).find((name) => name.endsWith(".md")) as string);
    const original = await readFile(taskFile, "utf8");
    await writeFile(taskFile, original.replace(/^status:.*$/m, "status: done\nagent: someone"));

    const again = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const resumed = await resumeMigration({ ...base, expectedFingerprint: again.fingerprint });
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.blocked.join("\n")).toContain(slug);
    expect(await readFile(taskFile, "utf8")).toContain("status: done");
  });

  test("progress.json 损坏时的问题说明含进度文件路径", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    await seedLegacyRequirement(repo.root, {
      slug: "2026-02-20.progress-path",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "todo" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    const identity = await repositoryIdentity(repo.root);
    const progressFile = await migrationProgressPath(home.dataRoot, repo.root);
    const dirMode = (await stat(join(home.dataRoot, "repos", identity.repoId))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    putRecord(progressFile, { requirements: null });
    const damaged = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const problem = damaged.problems.find((p) => p.kind === "progress-unreadable");
    expect(problem?.detail).toContain("迁移进度结构无效");
  });

  test("beforeVerify 中断后 failed 含该需求与原因", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-02-18.status-failed";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const interrupted = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeVerify: async () => {
          throw new Error("模拟写目标后中断");
        },
      },
    });
    expect(interrupted.ok).toBe(false);

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    const failedMentionsSlug = status.failed.some((entry) => JSON.stringify(entry).includes(slug));
    expect(failedMentionsSlug).toBe(true);
  });
});

describe("多需求仓库中断后重试，未变化的需求应能继续完成", () => {
  test("第二个需求在清理前中断，不改任何源重试后两个需求都 completed", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slugA = "2026-03-01.multi-requirement-a";
    const slugB = "2026-03-01.multi-requirement-b";
    await seedLegacyRequirement(repo.root, {
      slug: slugA,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    await seedLegacyRequirement(repo.root, {
      slug: slugB,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight1 = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    let beforeClearCalls = 0;
    const first = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight1.fingerprint,
      hasActiveWindows: noActiveWindows,
      hooks: {
        beforeClear: async () => {
          beforeClearCalls += 1;
          if (beforeClearCalls === 2) throw new Error("模拟第二个需求清理前中断");
        },
      },
    });
    expect(first.migrated.length).toBe(1);

    const preflight2 = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const second = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight2.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(second.ok).toBe(true);
    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).toContain(slugA);
    expect(status.completed).toContain(slugB);
  });
});

describe("冲突检测覆盖进入本机状态的全部字段", () => {
  test("跨 worktree 需求 status 分叉记 problem 且 apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-03-02.requirement-status-conflict";
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "reviewing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(false);
  });

  test("跨 worktree 任务 note 分叉记 problem 且 apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const wtA = await makeWorktree(repo);
    const wtB = await makeWorktree(repo);
    const reqId = "2026-03-03.task-note-conflict";
    await seedLegacyRequirement(wtA.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-a", note: "版本 A 的备注" }],
    });
    await seedLegacyRequirement(wtB.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-a", note: "版本 B 的备注" }],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(false);
  });

  test("单 worktree 账本内同编号不同内容的决策记录记 problem 且 apply 阻塞", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const reqId = "2026-03-04.single-worktree-decision-conflict";
    await seedLegacyRequirement(repo.root, {
      slug: reqId,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
      aiDecisions: [
        aiDecisionRecord("AI-001", reqId, { decision: "版本 A 的决定" }),
        aiDecisionRecord("AI-001", reqId, { decision: "版本 B 的决定" }),
      ],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === reqId)).toBe(true);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(false);
  });
});

describe("本机已存在目标状态文档时的保护", () => {
  test("状态文档已存在但进度无该需求条目时阻塞，不覆盖既有内容", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-03-05.preexisting-state-doc";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const path = await stateDocPath(home.dataRoot, repo.root, slug);
    await createRecord(path, {
      requirement: slug,
      stage: "planned",
      shape: null,
      tasks: {},
      followUps: ["existing-followup"],
      history: [],
    });

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    const doc = await readRecord(path);
    expect(doc.exists).toBe(true);
    if (doc.exists) {
      const data = doc.data as { stage: string; followUps: unknown[] };
      expect(data.stage).toBe("planned");
      expect(data.followUps).toEqual(["existing-followup"]);
    }
  });
});

describe("任务文件缺 id 时的错误隔离", () => {
  test("任务文件缺 id 记 problem 且 apply 阻塞，源字段未被清理", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-03-06.task-missing-id";
    const dir = requirementDir(repo.root, slug);
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(join(dir, "requirements.md"), requirementsMdContent({ slug, title: "示例", status: "executing" }));
    const taskPath = join(dir, "tasks", "01-no-id.md");
    const taskContent = [
      "---",
      "title: 任务一",
      "depends_on: []",
      "files: []",
      "refs: []",
      "parallel: true",
      "status: doing",
      "---",
      "",
      "# 任务一",
      "",
      "占位任务正文，用于验证迁移逐字保留。",
      "",
    ].join("\n");
    await writeFile(taskPath, taskContent);

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === slug)).toBe(true);

    const before = await readFile(taskPath, "utf8");
    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(false);
    const after = await readFile(taskPath, "utf8");
    expect(after).toBe(before);
  });
});

describe("旧数据根目录不可访问时的错误处理", () => {
  test("legacy 需求根目录不可读时记 problem，而非视为零来源成功", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const legacyRoot = join(repo.root, LEGACY_ROOT);
    await mkdir(legacyRoot, { recursive: true });
    await chmod(legacyRoot, 0o000);

    try {
      const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
      expect(preflight.problems.length).toBeGreaterThan(0);
    } finally {
      await chmod(legacyRoot, 0o700);
    }
  });
});

describe("本机已有状态文档的归属判据", () => {
  test("本机文档缺少迁移来源 history 时即使内容与源恰好一致也需阻塞，不覆盖既有 shape/followUps/history", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-04-01.attribution-content-coincidence";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "planned",
      tasks: [
        { id: "T-1", title: "任务一", status: "todo" },
        { id: "T-2", title: "任务二", status: "todo" },
      ],
    });
    const path = await stateDocPath(home.dataRoot, repo.root, slug);
    const preexisting = {
      requirement: slug,
      stage: "planned",
      shape: {
        tasks: [
          { id: "T-1", roles: ["impl"] },
          { id: "T-2", roles: ["impl"] },
        ],
        gates: { plan: true, whiteboxReview: true, blackboxAcceptance: true },
        skipped: [],
        acceptanceReport: null,
        decisionId: "USER-007",
      },
      tasks: {
        "T-1": {
          progress: "todo",
          runId: null,
          description: "",
          agent: "",
          note: "",
          commit: null,
          reason: "",
          repairRound: 0,
          blockedReason: "",
          workspaceDir: "",
        },
        "T-2": {
          progress: "todo",
          runId: null,
          description: "",
          agent: "",
          note: "",
          commit: null,
          reason: "",
          repairRound: 0,
          blockedReason: "",
          workspaceDir: "",
        },
      },
      followUps: ["existing-followup"],
      history: [
        { stage: "draft", at: "2026-01-01T00:00:00.000Z", runId: null, decisionId: null, reason: null },
        { stage: "confirmed", at: "2026-01-02T00:00:00.000Z", runId: null, decisionId: "USER-001", reason: null },
      ],
    };
    await createRecord(path, preexisting);

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === slug && p.kind === "target-state-exists")).toBe(true);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(result.ok).toBe(false);

    const doc = await readRecord(path);
    expect(doc.exists).toBe(true);
    if (doc.exists) {
      const data = doc.data as typeof preexisting;
      expect(data.shape).toEqual(preexisting.shape);
      expect(data.followUps).toEqual(preexisting.followUps);
      expect(data.history).toEqual(preexisting.history);
    }
  });
});

describe("进度丢失后重试不得重写已清理完成的需求", () => {
  test("迁移完成后 progress 丢失仍能恢复状态，重新出现的旧定义目录阻塞重试", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slugA = "2026-04-02.resume-no-rewrite-a";
    const slugB = "2026-04-02.resume-no-rewrite-b";
    await seedLegacyRequirement(repo.root, {
      slug: slugA,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "done", agent: "agent-a", commit: "aaa1111", note: "完成备注" }],
    });
    const preflightA = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const firstResult = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflightA.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(firstResult.ok).toBe(true);

    const docBefore = await readStateDoc(home.dataRoot, repo.root, slugA);
    expect(docBefore.exists).toBe(true);

    await seedLegacyRequirement(repo.root, {
      slug: slugB,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    const progPath = await migrationProgressPath(home.dataRoot, repo.root);
    deleteRecord(progPath);

    const preflight2 = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight2.problems.some((p) => p.requirement === slugA)).toBe(false);

    const secondResult = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight2.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(secondResult.ok).toBe(false);

    const docAfter = await readStateDoc(home.dataRoot, repo.root, slugA);
    expect(docAfter.exists).toBe(true);
    if (docBefore.exists && docAfter.exists) {
      expect(docAfter.data).toEqual(docBefore.data);
    }

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.completed).toContain(slugA);
    expect(status.remaining).toContain(slugB);
  });
});

describe("进度文件损坏时的错误处理", () => {
  test("progress.json 写成半截 JSON 时预检记录 progress-unreadable 问题", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-04-03.progress-corrupted-preflight";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight1 = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const applied = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight1.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(applied.ok).toBe(true);

    const progPath = await migrationProgressPath(home.dataRoot, repo.root);
    putRecord(progPath, { requirements: null });

    const preflight2 = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight2.problems.some((p) => p.kind === "progress-unreadable")).toBe(true);
  });

  test("progress.json 写成半截 JSON 时已完成需求不出现在 remaining", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slug = "2026-04-04.progress-corrupted-status";
    await seedLegacyRequirement(repo.root, {
      slug,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    const applied = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });
    expect(applied.ok).toBe(true);

    const progPath = await migrationProgressPath(home.dataRoot, repo.root);
    putRecord(progPath, { requirements: null });

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.remaining).not.toContain(slug);
  });
});

describe("problem 的阻塞粒度收敛到单需求", () => {
  test("两个需求中一个任务缺 id 时只阻塞该需求，另一个正常迁移完成并清理源", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    const slugGood = "2026-04-05.per-requirement-blocking-good";
    const slugBad = "2026-04-05.per-requirement-blocking-bad";
    await seedLegacyRequirement(repo.root, {
      slug: slugGood,
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });
    const dirBad = requirementDir(repo.root, slugBad);
    await mkdir(join(dirBad, "tasks"), { recursive: true });
    await writeFile(join(dirBad, "requirements.md"), requirementsMdContent({ slug: slugBad, title: "缺 id 任务", status: "executing" }));
    const badTaskContent = [
      "---",
      "title: 任务一",
      "depends_on: []",
      "files: []",
      "refs: []",
      "parallel: true",
      "status: doing",
      "---",
      "",
      "# 任务一",
      "",
      "占位任务正文，用于验证迁移逐字保留。",
      "",
    ].join("\n");
    await writeFile(join(dirBad, "tasks", "01-no-id.md"), badTaskContent);

    const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(preflight.problems.some((p) => p.requirement === slugGood)).toBe(false);
    expect(preflight.problems.some((p) => p.requirement === slugBad)).toBe(true);

    const result = await migrationApply({
      cwd: repo.root,
      dataRoot: home.dataRoot,
      authorized: true,
      legacyWritesStopped: true,
      expectedFingerprint: preflight.fingerprint,
      hasActiveWindows: noActiveWindows,
    });

    expect(result.ok).toBe(false);
    expect(result.blocked.some((b) => b.includes(slugBad))).toBe(true);
    expect(result.migrated).toContain(slugGood);

    const status = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
    expect(status.inProgress).toContain(slugGood);

    const goodTaskPath = join(requirementDir(repo.root, slugGood), "tasks", "01-t-1.md");
    const afterGood = splitFrontmatter(await readFile(goodTaskPath, "utf8"));
    expect(frontmatterHasKey(afterGood.frontmatter, "status")).toBe(false);
  });
});

describe("预检只读，不物化本机数据区", () => {
  test("migrationPreflight 不创建 repos/<repoId> 目录", async () => {
    const repo = await makeRepo();
    const home = await makeHome();
    await seedLegacyRequirement(repo.root, {
      slug: "2026-04-06.preflight-read-only",
      requirementStatus: "executing",
      tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
    });

    await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

    const identity = await repositoryIdentity(repo.root);
    const repoDir = join(home.dataRoot, "repos", identity.repoId);
    expect(await pathExists(repoDir)).toBe(false);
  });
});
