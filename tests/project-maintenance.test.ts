import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { databaseFilesFingerprint } from "../runtime/database-recovery.ts";
import { repositoryDatabase, uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { backup, recoveryCheck, restore } from "../runtime/project-maintenance.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "project-maintenance-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const operationId = uuidv7();
  const service = await RequirementService.open({ ...options, authorize: (request) => request.repoId === options.repoId
    && (request.action === "metadata" || (request.action === "create" && request.operationId === operationId && request.intentHash === requirementIntentHash({ title: "t", body: "# 目标 {#goals}\n正文\n" }))) });
  await service.create({ requestId: uuidv7(), operationId, title: "t", body: "# 目标 {#goals}\n正文\n" });
  const prompts: string[] = [];
  let answer = true;
  const maintenance = { ...options, confirm: async (title: string) => { prompts.push(title); return answer; } };
  return { ...options, maintenance, prompts, setAnswer: (value: boolean) => { answer = value; } };
}

test("M7-AC7：恢复对账、备份须真实确认；仍有代理运行时不进入维护", async () => {
  const w = await world();
  const runs = new RunStore({ dataRoot: w.dataRoot, repoId: w.repoId, daemonStartedAt: new Date().toISOString() });
  const run = await runs.create({ kind: "role", standalone: true, role: "pi-company.worker", requirement: uuidv7(), task: "t", cwd: w.repositoryRoot,
    readPaths: [], writePaths: [], model: { provider: "p", id: "m" }, thinking: "off", mcp: [] });
  await runs.update(run.id, { state: "running" });
  await expect(backup(w.maintenance, { operationId: uuidv7() })).rejects.toMatchObject({ code: "agents_running" });
  expect(w.prompts).toEqual([]);
  await runs.update(run.id, { state: "stopped" });
  w.setAnswer(false);
  await expect(recoveryCheck(w.maintenance, { operationId: uuidv7() })).rejects.toMatchObject({ code: "declined" });
});

test("M7-AC7：恢复对账核对当前库；备份后恢复到隔离目录且标记待核对，不改动当前运行库", async () => {
  const w = await world();
  expect(await recoveryCheck(w.maintenance, { operationId: uuidv7() })).toMatchObject({ state: "restart_ready", requirementsChecked: 1 });
  const receipt = await backup(w.maintenance, { operationId: uuidv7() });
  expect(receipt).toMatchObject({ state: "completed", executable: false });
  const live = repositoryDatabase(w.dataRoot, w.repoId);
  const before = databaseFilesFingerprint(live);
  const restored = await restore(w.maintenance, { operationId: uuidv7(), backupOperationId: receipt.operationId, backupManifestHash: receipt.manifestHash });
  expect(restored).toMatchObject({ restoreStatus: "needs_review", executable: false });
  expect(restored.isolationDirectory).not.toBe(join(w.dataRoot, "repos", w.repoId));
  expect(databaseFilesFingerprint(live)).toBe(before);
  expect(w.prompts).toEqual(["确认恢复对账", "确认备份本机需求数据", "确认从备份恢复到隔离目录"]);
}, 30000);
