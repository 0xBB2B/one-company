import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase, uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import { bindEvidence, checkEvidence, initRequirementState } from "../runtime/workflow-state.ts";
import type { WorkflowContext } from "../runtime/workflow-state.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const CURRENT_VERSION = { definitionFingerprint: "fp-write-guard-test", codeHead: "head-write-guard-test" };
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function runInput(requirement: string, cwd: string, task: string) {
  return { kind: "role" as const, standalone: true, role: "pi-company.worker", requirement, task, cwd, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] };
}

async function bindStagesEvidence(
  repo: Awaited<ReturnType<typeof createRepoFixture>>,
  home: Awaited<ReturnType<typeof createTempHome>>,
  requirement: string,
  stages: string[],
): Promise<WorkflowContext> {
  const identity = await repositoryIdentity(repo.root);
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: "write-guard-test" });
  const ctx: WorkflowContext = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  await initRequirementState(ctx);
  for (const stage of stages) {
    const evidenceRun = await runStore.create(runInput(requirement, repo.root, `evidence-${stage}`));
    await runStore.update(evidenceRun.id, { state: "running" });
    await runStore.update(evidenceRun.id, {
      state: "completed",
      result: {
        phase: stage,
        verdict: "PASS",
        summary: "验证保护夹具", issues: [], evidence: ["own.txt:1"],
        ...(stage === "work" ? { changeKind: "refactor", workState: "green-baseline-no-change", coverage: [{ ref: "AC-1", test: "own.txt:1" }], redCommands: [], greenCommands: [{ command: "cat own.txt", status: "passed", details: "通过" }], changedFiles: [], productionPath: ["own.txt"], preexistingEvidence: ["own.txt:1"], fakeRed: false } : { reviewedHead: CURRENT_VERSION.codeHead, contentFingerprint: "保护夹具", traceability: [{ ref: "AC-1", test: "own.txt:1", implementation: "own.txt:1" }], findings: [] }),
        binding: {
          requirement,
          definitionFingerprint: CURRENT_VERSION.definitionFingerprint,
          codeHead: CURRENT_VERSION.codeHead,
          cwd: repo.root,
        },
      },
    });
    expect(await bindEvidence({ stage, runId: evidenceRun.id, currentVersion: CURRENT_VERSION }, ctx)).toEqual({ ok: true });
  }
  return ctx;
}

async function world() {
  const repo = await createRepoFixture();
  cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome();
  cleanup.push(() => removeTempHome(home));
  for (const path of ["own.txt", "occupied.txt"]) await writeFile(join(repo.root, path), "original\n");
  await mkdir(join(repo.root, "shared-dir"));
  await writeFile(join(repo.root, "shared-dir/keep.txt"), "original\n");
  await runGit(["add", "own.txt", "occupied.txt", "shared-dir"], repo.root);
  await runGit(["commit", "-m", "range fixture"], repo.root);
  const repoId = (await repositoryIdentity(repo.root)).repoId;
  const clock = createClock();
  cleanup.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(home.dataRoot, repoId) });
  cleanup.push(async () => {
    for (const task of shells.list()) if (["starting", "running", "stopping", "uncertain"].includes(task.status)) await shells.stop(task.taskId);
  });
  const runs = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "range-test" });
  const own = await runs.create(runInput("2026-09-10.own", repo.root, "own"));
  const foreign = await runs.create(runInput("2026-09-10.foreign", repo.root, "foreign"));
  for (const run of [own, foreign]) await runs.update(run.id, { state: "running" });
  const guard = await createRangeProtection({ cwd: repo.root, dataRoot: home.dataRoot, holder: { kind: "role", runId: own.id, requirement: own.requirement }, writePaths: ["own.txt", "allowed/"], clock, shells });
  const other = await createRangeProtection({ cwd: repo.root, dataRoot: home.dataRoot, holder: { kind: "role", runId: foreign.id, requirement: foreign.requirement }, writePaths: ["occupied.txt", "shared-dir/"], clock, shells });
  cleanup.push(async () => {
    for (const run of [own, foreign]) {
      const found = await runs.get(run.id);
      if (found.ok && found.run.state === "running") await runs.update(run.id, { state: "completed" });
    }
    await guard.release(); await other.release();
  });
  expect((await other.checkWrite("occupied.txt")).ok).toBe(true);
  const host = { kind: "role" as const, id: own.id, runId: own.id };
  const shell = createManagedBashOperations({ registry: shells, host, runToken: uuidv7(), guard: guard.commandGuard });
  return { repo, home, repoId, clock, shells, runs, own, foreign, guard, other, shell };
}

test("生产写入检查允许获准文件和目录，拒绝越界、他人占用和符号链接绕行", async () => {
  const w = await world();
  expect((await w.guard.checkWrite("own.txt")).ok).toBe(true);
  expect((await w.guard.checkWrite("allowed/new.txt")).ok).toBe(true);
  expect((await w.guard.checkWrite("README.md")).ok).toBe(false);
  expect((await w.guard.checkWrite("occupied.txt")).ok).toBe(false);
  await mkdir(join(w.repo.root, "allowed"));
  await symlink(join(w.repo.root, "shared-dir"), join(w.repo.root, "allowed/link"));
  expect((await w.guard.checkWrite("allowed/link/new.txt")).ok).toBe(false);
  await symlink(w.home.home, join(w.repo.root, "allowed/outside"));
  expect((await w.guard.checkWrite("allowed/outside/new.txt")).ok).toBe(false);
  expect((await w.guard.checkWrite(join(w.home.home, "outside.txt"))).ok).toBe(false);
});

test("生产主会话与角色同时申请相同文件只有一方获准，独立文件继续", async () => {
  const w = await world();
  const main = await createRangeProtection({ cwd: w.repo.root, dataRoot: w.home.dataRoot, holder: { kind: "main", windowId: uuidv7() }, writePaths: [w.repo.root], clock: w.clock, shells: w.shells });
  cleanup.push(() => main.release());
  const results = await Promise.all([w.guard.checkWrite("own.txt"), main.checkWrite("own.txt")]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect((await main.checkWrite("independent.txt")).ok).toBe(true);
  expect((await main.checkWrite("occupied.txt")).ok).toBe(false);
});

test("真实受管命令阻止他人范围写入，允许本任务写入", async () => {
  const w = await world();
  const before = await readFile(join(w.repo.root, "occupied.txt"));
  const bad = await w.shell.exec("printf bad > occupied.txt", w.repo.root, { onData: () => {}, timeout: 5 });
  expect(bad.exitCode).not.toBe(0);
  expect(await readFile(join(w.repo.root, "occupied.txt"))).toEqual(before);
  const good = await w.shell.exec("printf good > own.txt", w.repo.root, { onData: () => {}, timeout: 5 });
  expect(good.exitCode).toBe(0);
  expect(await readFile(join(w.repo.root, "own.txt"), "utf8")).toBe("good");
});

test.each(["occupied.txt", "shared-dir/new.txt"])("生产命令后核对发现外部修改 %s，使违规运行失败及被影响需求证据失效", async (path) => {
  const w = await world();
  const ownCtx = await bindStagesEvidence(w.repo, w.home, w.own.requirement, ["work"]);
  const foreignCtx = await bindStagesEvidence(w.repo, w.home, w.foreign.requirement, ["work", "review"]);
  const token = await w.guard.commandGuard.before();
  // 用沙箱外的测试写入模拟外部进程改变验证对象。
  await writeFile(join(w.repo.root, path), "external change\n");
  const violations = await w.guard.commandGuard.after(token, { exitCode: 0 });
  expect(violations).toContain(path);
  const run = await w.runs.get(w.own.id);
  expect(run.ok && run.run.state).toBe("failed");
  for (const stage of ["work", "review"]) expect((await checkEvidence({ stage, currentVersion: CURRENT_VERSION }, foreignCtx)).ok).toBe(false);
  expect((await checkEvidence({ stage: "work", currentVersion: CURRENT_VERSION }, ownCtx)).ok).toBe(true);
  expect(await w.guard.commandGuard.after(token, { exitCode: 0 })).toContain(path);
});

test("主会话接手前读取仓库 Shell 登记，终态运行仍有后台命令时保留保护", async () => {
  const w = await world();
  const taskId = uuidv7();
  const spawned = await w.shells.spawn({ taskId, host: { kind: "role", id: w.foreign.id, runId: w.foreign.id }, command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], cwd: w.repo.root, mode: "background", runToken: uuidv7() });
  expect(spawned.ok).toBe(true);
  await w.runs.update(w.foreign.id, { state: "completed" });
  const windowShells = new ShellRegistry({ clock: w.clock });
  const main = await createRangeProtection({ cwd: w.repo.root, dataRoot: w.home.dataRoot, holder: { kind: "main", windowId: uuidv7() }, writePaths: [w.repo.root], clock: w.clock, shells: windowShells });
  cleanup.push(() => main.release());
  expect(windowShells.list()).toHaveLength(0);
  expect((await main.checkWrite("occupied.txt")).ok).toBe(false);
  expect((await w.shells.stop(taskId)).ok).toBe(true);
  expect((await main.checkWrite("occupied.txt")).ok).toBe(true);
}, 15_000);
