import { afterEach, expect, test, vi } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { createPlanManageTool, TASKS } from "../src/modules/pm/plan-manage.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { pmIntakeReviewKit } from "./helpers/pm-intake-review.ts";

const hooks = vi.hoisted(() => ({ beforeWrite: undefined as (() => void) | undefined }));
vi.mock("../src/core/storage/store.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/storage/store.ts")>();
  return { ...original, writeFileAtomic: async (path: string, content: string) => { hooks.beforeWrite?.(); return original.writeFileAtomic(path, content); } };
});
vi.setConfig({ testTimeout: 30_000 });
const clean: Array<() => unknown> = [];
afterEach(async () => { hooks.beforeWrite = undefined; for (const fn of clean.splice(0).reverse()) await fn(); });

test("M7-AC30：计划修改读完快照后任务被派工改动时，提交以冲突拒绝，不抹掉尝试记录", async () => {
  const fixture = await createPmIntakeFixture(); clean.push(() => fixture.cleanup());
  await (await pmIntakeReviewKit(fixture)).pass();
  const record = fixture.state.read(fixture.requirementId).data;
  const pm = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
    grant: { role: "pm", callerId: uuidv7(), runId: fixture.lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId,
      workspaceId: record.workspace!.workspaceId, lease: fixture.lease } });
  clean.push(() => pm.dispose());
  const NA = { applicable: false as const, reason: "无" };
  const spec = (maxTurns: number) => ({ key: "login", role: "worker", goalUnitIds: ["goal.login", "scenario.failure"], constraintUnitIds: [], dependsOn: [],
    writePaths: ["src/"], blockedByQuestionIds: [], maxTurns, objective: "登录", passCriteria: ["可登录"], scope: { in: ["登录"], out: [] }, performance: NA });
  const view = await pm.execute({ action: "propose", tasks: [spec(10)] }) as { tasks: Array<{ taskId: string }> };
  const taskId = view.tasks[0]!.taskId, attemptRun = uuidv7();
  const db = <T>(run: (db: import("../src/core/storage/database.ts").LocalDatabase) => T) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), run);
  hooks.beforeWrite = () => {
    hooks.beforeWrite = undefined;
    db((d) => { const row = d.read<Record<string, unknown>>(TASKS, taskId)!;
      d.update(TASKS, taskId, row.version, { ...row.data, status: "running", attempts: [{ runId: attemptRun, maxTurns: 10, turnsUsed: 0, reason: null, outcome: "running" }] }); });
  };
  await expect(pm.execute({ action: "update", planVersion: 1, modify: [{ taskId, version: 1, spec: spec(20) }] })).rejects.toMatchObject({ code: "version_conflict" });
  expect(db((d) => d.read<{ attempts: Array<{ runId: string }> }>(TASKS, taskId)!.data.attempts.map((attempt) => attempt.runId))).toEqual([attemptRun]);
});
