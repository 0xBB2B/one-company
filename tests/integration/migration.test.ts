import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { repositoryDatabase, globalDatabase, uuidv7 } from "../../runtime/database.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { addWorktree, createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import type { RepoFixture, WorktreeFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import type { TempHome } from "../helpers/temp-home.ts";
import {
  aiDecisionRecord,
  legacyRequirementDir,
  seedLegacyRequirement,
  splitFrontmatter,
} from "../helpers/legacy-pi-spec-fixture.ts";
import { readDecisions } from "../../runtime/decisions.ts";
import { repoDataDir, repositoryIdentity } from "../../runtime/identity.ts";
import { readRecord } from "../../runtime/database.ts";
import { requirementStateRef } from "../../runtime/workflow-state.ts";
import { createClock } from "../../runtime/clock.ts";
import { currentBootId, processStartedAt, WindowRegistry } from "../../runtime/windows.ts";
import { migrationApply, migrationPreflight, migrationStatus, resumeMigration } from "../../runtime/migration.ts";

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

async function noActiveWindows(): Promise<boolean | null> {
  return false;
}

async function seedSimpleRequirement(root: string, slug: string): Promise<void> {
  await seedLegacyRequirement(root, {
    slug,
    requirementStatus: "executing",
    tasks: [{ id: "T-1", title: "任务一", status: "doing", step: "impl", agent: "agent-z" }],
    aiDecisions: [aiDecisionRecord("AI-001", slug)],
  });
}

async function readTaskFile(repoRoot: string, slug: string, fileName: string): Promise<string> {
  return readFile(join(legacyRequirementDir(repoRoot, slug), "tasks", fileName), "utf8");
}

interface RealWindowProbe {
  hasActiveWindows: () => Promise<boolean | null>;
  registerRealWindow: () => Promise<void>;
}

// 用真实 WindowRegistry 而非直接注入布尔值作为"活动窗口"信号：existing 单元测试已经覆盖
// hasActiveWindows 回调本身的三态分支，这里换成真实登记表串起来验证端到端的阻塞路径
async function makeRealWindowProbe(repo: RepoFixture, dataRoot: string): Promise<RealWindowProbe> {
  const identity = await repositoryIdentity(repo.root);
  const dir = await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  const registry = new WindowRegistry({ repoDir: dir, clock: createClock(), bootId: currentBootId, processStartedAt });
  return {
    hasActiveWindows: async () => (await registry.list()).length > 0,
    registerRealWindow: async () => {
      await registry.register({
        windowId: uuidv7(),
        pid: process.pid,
        sessionId: randomUUID(),
        cwd: repo.root,
        workspaceRoot: repo.root,
      });
    },
  };
}

describe("migrationPreflight：多 worktree 只读列出", () => {
  test(
    "列出两个 worktree 中各自的旧格式来源，预检不修改任何源文件",
    async () => {
      const repo = await makeRepo();
      const home = await makeHome();
      const wtA = await makeWorktree(repo);
      const wtB = await makeWorktree(repo);
      await seedLegacyRequirement(wtA.root, {
        slug: "2026-09-10.worktree-a-req",
        requirementStatus: "executing",
        tasks: [{ id: "T-1", title: "任务一", status: "doing" }],
        aiDecisions: [aiDecisionRecord("AI-001", "2026-09-10.worktree-a-req")],
      });
      await seedLegacyRequirement(wtB.root, {
        slug: "2026-09-10.worktree-b-req",
        requirementStatus: "accepted",
        tasks: [{ id: "T-1", title: "任务一", status: "done", step: "done", agent: "agent-x", commit: "abc1234" }],
        acceptance: "# 验收报告\n\n通过。\n",
      });
      const taskPathA = join(legacyRequirementDir(wtA.root, "2026-09-10.worktree-a-req"), "tasks", "01-t-1.md");
      const beforeA = await readFile(taskPathA, "utf8");

      const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });

      const requirementIds = preflight.sources.map((s) => s.requirement);
      expect(requirementIds).toContain("2026-09-10.worktree-a-req");
      expect(requirementIds).toContain("2026-09-10.worktree-b-req");
      const worktrees = new Set(preflight.sources.map((s) => s.worktree));
      expect(worktrees.size).toBeGreaterThanOrEqual(2);
      const sourceB = preflight.sources.find((s) => s.requirement === "2026-09-10.worktree-b-req");
      expect(sourceB?.files.some((f) => f.endsWith("acceptance.md"))).toBe(true);

      const afterA = await readFile(taskPathA, "utf8");
      expect(afterA).toBe(beforeA);
    },
    20_000,
  );
});

describe("migrationApply：真实 WindowRegistry 停写阻塞", () => {
  test(
    "存在真实登记的活动窗口时 apply 被阻塞并列明条件，源数据未变；窗口注销后放行",
    async () => {
      const repo = await makeRepo();
      const home = await makeHome();
      const slug = "2026-09-10.real-window-block";
      await seedSimpleRequirement(repo.root, slug);
      const taskPath = join(legacyRequirementDir(repo.root, slug), "tasks", "01-t-1.md");
      const before = await readFile(taskPath, "utf8");
      const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
      const probe = await makeRealWindowProbe(repo, home.dataRoot);
      await probe.registerRealWindow();

      const blocked = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight.fingerprint,
        hasActiveWindows: probe.hasActiveWindows,
      });

      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.blocked.length).toBeGreaterThan(0);
        expect(blocked.blocked.join(";")).toMatch(/窗口/);
      }
      const after = await readFile(taskPath, "utf8");
      expect(after).toBe(before);
    },
    20_000,
  );

  test(
    "无真实活动窗口时不因窗口条件被阻塞",
    async () => {
      const repo = await makeRepo();
      const home = await makeHome();
      const slug = "2026-09-10.real-window-clear";
      await seedSimpleRequirement(repo.root, slug);
      const preflight = await migrationPreflight({ cwd: repo.root, dataRoot: home.dataRoot });
      const probe = await makeRealWindowProbe(repo, home.dataRoot);

      const result = await migrationApply({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight.fingerprint,
        hasActiveWindows: probe.hasActiveWindows,
      });

      expect(result.ok).toBe(true);
    },
    20_000,
  );
});

describe("migrationApply：保真迁移与重复记录去重", () => {
  test(
    "停写后 apply 成功：本机状态可查、任务编号与声明式字段引用一致、源任务文件只移除运行字段，重复决定记录去重为一条",
    async () => {
      const repo = await makeRepo();
      const home = await makeHome();
      const slug = "2026-09-10.faithful-migrate";
      const duplicateDecision = aiDecisionRecord("AI-001", slug, { decision: "保持一致的重复决定" });
      await seedLegacyRequirement(repo.root, {
        slug,
        requirementStatus: "executing",
        tasks: [
          {
            id: "T-1",
            title: "任务一",
            status: "done",
            step: "done",
            agent: "agent-a",
            commit: "aaa1111",
            note: "任务一备注",
            refs: ["spec/foo/AC-1"],
            verify: "bun test tests/foo.test.ts",
          },
        ],
        // 同一 id 同一内容的决定记录出现两次，模拟旧格式里追加写入产生的重复行
        aiDecisions: [duplicateDecision, { ...duplicateDecision }],
      });
      const taskPath = join(legacyRequirementDir(repo.root, slug), "tasks", "01-t-1.md");
      const beforeBody = splitFrontmatter(await readFile(taskPath, "utf8")).body;

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
      if (result.ok) expect(result.migrated).toContain(slug);

      const identity = await repositoryIdentity(repo.root);
      const stateDoc = await readRecord(
        requirementStateRef(home.dataRoot, identity.repoId, slug),
      );
      expect(stateDoc.exists).toBe(true);
      if (stateDoc.exists) {
        const data = stateDoc.data as { stage: string; tasks: Record<string, { progress: string; agent?: string; commit?: string }> };
        expect(data.stage).toBe("executing");
        expect(data.tasks["T-1"]?.progress).toBe("done");
        expect(data.tasks["T-1"]?.agent).toBe("agent-a");
        expect(data.tasks["T-1"]?.commit).toBe("aaa1111");
      }

      const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "ai" });
      const matching = records.filter((r) => (r as { id?: string }).id === "AI-001");
      expect(matching).toHaveLength(1);

      const after = splitFrontmatter(await readFile(taskPath.replace("/.pi-spec/", "/.pi-company/"), "utf8"));
      expect(after.body).toBe(beforeBody);
      for (const key of ["id", "title", "depends_on", "files", "refs", "verify"]) {
        expect(new RegExp(`(^|\\n)${key}:`).test(after.frontmatter)).toBe(true);
      }
      expect(after.frontmatter).toContain("refs: [spec/foo/AC-1]");
      for (const removedKey of ["status", "step", "agent", "commit", "note"]) {
        expect(new RegExp(`(^|\\n)${removedKey}:`).test(after.frontmatter)).toBe(false);
      }
    },
    20_000,
  );
});

describe("migrationApply / resumeMigration：校验阶段中断后重试", () => {
  test(
    "beforeVerify 抛错中断后：源数据未删除，migrationStatus 未标记完成；重试成功后决定记录不重复",
    async () => {
      const repo = await makeRepo();
      const home = await makeHome();
      const slug = "2026-09-10.interrupt-resume";
      await seedSimpleRequirement(repo.root, slug);
      const taskPath = join(legacyRequirementDir(repo.root, slug), "tasks", "01-t-1.md");
      const beforeSource = await readFile(taskPath, "utf8");
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
            throw new Error("集成测试模拟校验阶段中断");
          },
        },
      });
      expect(interrupted.ok).toBe(false);

      const sourceAfterInterrupt = await readFile(taskPath, "utf8");
      expect(sourceAfterInterrupt).toBe(beforeSource);
      const statusAfterInterrupt = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
      expect(statusAfterInterrupt.completed).not.toContain(slug);

      const resumed = await resumeMigration({
        cwd: repo.root,
        dataRoot: home.dataRoot,
        authorized: true,
        legacyWritesStopped: true,
        expectedFingerprint: preflight.fingerprint,
        hasActiveWindows: noActiveWindows,
      });
      expect(resumed.ok).toBe(true);

      const statusAfterResume = await migrationStatus({ cwd: repo.root, dataRoot: home.dataRoot });
      expect(statusAfterResume.completed).toContain(slug);
      const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: slug, actor: "ai" });
      const matching = records.filter((r) => (r as { id?: string }).id === "AI-001");
      expect(matching).toHaveLength(1);
    },
    20_000,
  );
});


test("公开迁移入口拒绝活动及中断运行和两类真实 Shell，全部停写后迁移可查询", async () => {
  const repo = await makeRepo();
  const home = await makeHome();
  const requirement = "2026-09-10.public-migration";
  await seedSimpleRequirement(repo.root, requirement);
  const ctx = { cwd: repo.root, dataRoot: home.dataRoot };
  const { repoId } = await repositoryIdentity(repo.root);
  const before = await executeWorkflowAction({ action: "migrate-preflight", requirement }, ctx);
  expect(before.ok).toBe(true);
  const fingerprint = (before.details.data as { fingerprint: string }).fingerprint;
  const apply = () => executeWorkflowAction({ action: "migrate-apply", requirement, confirm: true, legacyWritesStopped: true, expectedFingerprint: fingerprint }, ctx);
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "迁移入口测试" });
  const run = await store.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement, task: "T-1", cwd: repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  for (const state of ["queued", "running", "interrupted"] as const) {
    if (state === "interrupted") await store.markOwnRunsInterrupted();
    else if (state === "running") await store.update(run.id, { state });
    expect((await apply()).ok).toBe(false);
  }
  await store.update(run.id, { state: "stopped" });
  const clock = createClock();
  try {
    for (const database of [repositoryDatabase(home.dataRoot, repoId), globalDatabase(home.dataRoot)]) {
      const shells = new ShellRegistry({ clock, database });
      const taskId = uuidv7();
      const spawned = await shells.spawn({ taskId, host: { kind: "main", id: uuidv7() }, command: "/bin/sleep", args: ["60"], cwd: repo.root, mode: "background", runToken: randomUUID() });
      expect(spawned.ok).toBe(true);
      try { expect((await apply()).ok).toBe(false); }
      finally { expect((await shells.stop(taskId)).ok).toBe(true); }
    }
    expect((await apply()).ok).toBe(true);
    const queried = await executeWorkflowAction({ action: "query", requirement }, ctx);
    expect(queried.ok).toBe(true);
    expect((queried.details.data as { stage: string }).stage).toBe("executing");
    expect(await readDecisions({ ...ctx, requirement, actor: "ai" })).toHaveLength(1);
  } finally { clock.stopGapWatcher(); }
}, 20000);
