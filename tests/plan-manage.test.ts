import { afterEach, expect, test, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { createPlanManageTool, PLANS, TASKS } from "../runtime/plan-manage.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { pmIntakeReviewKit } from "./helpers/pm-intake-review.ts";

vi.setConfig({ testTimeout: 30_000 });
const clean: Array<() => unknown> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

const NA = { applicable: false as const, reason: "无性能影响" };
function spec(key: string, patch: Partial<TaskSpec> = {}): TaskSpec {
  return { key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [], writePaths: ["src/"], blockedByQuestionIds: [],
    maxTurns: 30, objective: `TASK-DETAIL-SENTINEL ${key}`, passCriteria: ["正确验证码可登录"], scope: { in: ["登录接口"], out: ["微信登录"] }, performance: NA, ...patch };
}

async function world(options: { review?: boolean } = {}) {
  const fixture: PmIntakeFixture = await createPmIntakeFixture();
  clean.push(() => fixture.cleanup());
  const kit = await pmIntakeReviewKit(fixture);
  if (options.review !== false) await kit.pass();
  const record = fixture.state.read(fixture.requirementId).data;
  async function tool(role: "pm" | "reviewer" = "pm") {
    const instance = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
      grant: { role, callerId: uuidv7(), runId: role === "pm" ? fixture.lease.runId : uuidv7(), requirementId: fixture.requirementId, repoId: fixture.repoId,
        workspaceId: record.workspace!.workspaceId, ...(role === "pm" ? { lease: fixture.lease } : {}) } });
    clean.push(() => instance.dispose());
    return instance;
  }
  const db = <T>(run: Parameters<typeof withDatabase<T>>[1]) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), run);
  return { fixture, kit, tool, db };
}
type PlanView = { plan: { planVersion: number; confirmedVersion: number | null }; tasks: Array<{ taskId: string; key: string; version: number; status: string;
  detail: { path?: string; hash: string; objective?: string } }> };

test("M7-AC13：接手核对通过前正式提出计划被拒，通过后可以提出", async () => {
  const w = await world({ review: false });
  const pm = await w.tool();
  await expect(pm.execute({ action: "propose", tasks: [spec("login")] })).rejects.toMatchObject({ code: "intake_gate", detail: ["主代理还没有核对 PM 的接手理解"] });
  await w.kit.pass();
  const view = await pm.execute({ action: "propose", tasks: [spec("login")] }) as PlanView;
  expect(view.plan).toMatchObject({ planVersion: 1, confirmedVersion: null });
}, 30000);

test("M7-AC31：任务缺目标、通过条件、范围、性能条件或有效轮次上限时拒绝登记", async () => {
  const w = await world();
  const pm = await w.tool();
  for (const bad of [{ maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 1001 }, { passCriteria: [] }, { scope: { in: [], out: [] } }, { objective: "" }, { goalUnitIds: [] }]) {
    await expect(pm.execute({ action: "propose", tasks: [spec("login", bad as Partial<TaskSpec>)] })).rejects.toMatchObject({ code: "invalid_shape" });
  }
  const { performance: _performance, ...withoutPerformance } = spec("login");
  await expect(pm.execute({ action: "propose", tasks: [withoutPerformance] })).rejects.toMatchObject({ code: "invalid_shape" });
  await expect(pm.execute({ action: "propose", tasks: [spec("login", { role: "pm" as never })] })).rejects.toMatchObject({ code: "invalid_shape" });
  expect(w.db((db) => db.read(PLANS, w.fixture.requirementId))).toBeNull();
}, 30000);

test("M7-AC32：任务只能引用获准实施的需求章节，依赖须存在且无环", async () => {
  const w = await world();
  const pm = await w.tool();
  await expect(pm.execute({ action: "propose", tasks: [spec("meta", { goalUnitIds: ["metadata"] })] })).rejects.toMatchObject({ code: "unit_not_authorized" });
  await expect(pm.execute({ action: "propose", tasks: [spec("x", { goalUnitIds: ["goal.unknown"] })] })).rejects.toMatchObject({ code: "unknown_unit" });
  await expect(pm.execute({ action: "propose", tasks: [spec("a", { dependsOn: ["b"] }), spec("b", { dependsOn: ["a"] })] })).rejects.toMatchObject({ code: "dependency_invalid" });
  await expect(pm.execute({ action: "propose", tasks: [spec("a", { dependsOn: ["missing"] })] })).rejects.toMatchObject({ code: "dependency_invalid" });
  await expect(pm.execute({ action: "propose", tasks: [spec("a", { writePaths: ["docs/prod/x.md"] })] }))
    .rejects.toThrow("a 的 docs/prod/x.md 不能由 worker 写入");
}, 30000);

test("M7-AC6：计划与任务结构在 data.db，任务说明只在私有文件，数据库只留引用与指纹", async () => {
  const w = await world();
  const pm = await w.tool();
  const view = await pm.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"], dependsOn: ["login"] })] }) as PlanView;
  const stored = w.db((db) => db.read<{ detail: { path: string; hash: string }; dependsOn: string[] }>(TASKS, view.tasks[1]!.taskId)!.data);
  expect(stored.dependsOn).toEqual([view.tasks[0]!.taskId]);
  expect(await readFile(stored.detail.path, "utf8")).toContain("TASK-DETAIL-SENTINEL failure");
  expect((await stat(stored.detail.path)).mode & 0o777).toBe(0o600);
  const database = repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId);
  const bytes = (await Promise.all(["", "-wal"].map((suffix) => readFile(database + suffix).catch(() => Buffer.alloc(0))))).map((b) => b.toString("latin1")).join("");
  expect(bytes).not.toContain("TASK-DETAIL-SENTINEL");
  const read = await (await w.tool("reviewer")).execute({ action: "read" }) as PlanView;
  expect(read.tasks.map((task) => task.detail.objective)).toEqual(["TASK-DETAIL-SENTINEL login", "TASK-DETAIL-SENTINEL failure"]);
}, 30000);

test("M7-AC31：冻结前须覆盖全部获准实施章节；版本每次修改递增，过期版本的修改与冻结被拒", async () => {
  const w = await world();
  const pm = await w.tool();
  const first = await pm.execute({ action: "propose", tasks: [spec("login")] }) as PlanView;
  await expect(pm.execute({ action: "confirm", planVersion: 1 })).rejects.toMatchObject({ code: "coverage_incomplete", detail: ["scenario.failure"] });
  const second = await pm.execute({ action: "update", planVersion: 1, add: [spec("failure", { goalUnitIds: ["scenario.failure"] })],
    modify: [{ taskId: first.tasks[0]!.taskId, version: 1, spec: spec("login", { passCriteria: ["正确验证码可登录", "登录后跳转首页"] }) }] }) as PlanView;
  expect(second.plan.planVersion).toBe(2);
  expect(second.tasks.find((task) => task.key === "login")).toMatchObject({ taskId: first.tasks[0]!.taskId, version: 2 });
  await expect(pm.execute({ action: "update", planVersion: 1, cancel: [{ taskId: first.tasks[0]!.taskId, version: 2 }] })).rejects.toMatchObject({ code: "version_conflict" });
  await expect(pm.execute({ action: "confirm", planVersion: 1 })).rejects.toMatchObject({ code: "version_conflict" });
  const confirmed = await pm.execute({ action: "confirm", planVersion: 2 }) as PlanView;
  expect(confirmed.plan.confirmedVersion).toBe(2);
}, 30000);

test("M7-AC7：reviewer 只能读取计划，不能提出、修改、冻结或复核", async () => {
  const w = await world();
  const reviewer = await w.tool("reviewer");
  for (const params of [{ action: "propose", tasks: [spec("x")] }, { action: "confirm", planVersion: 1 },
    { action: "update", planVersion: 1, add: [spec("x")] }, { action: "assess-update", revision: 1, assessmentId: uuidv7(), tasks: [], global: { assessment: "unaffected", rationale: "无" } }]) {
    await expect(reviewer.execute(params)).rejects.toMatchObject({ code: "action_not_allowed",
      advice: { why: `当前角色的职责不允许这个动作：reviewer 不能做 ${params.action}` } });
  }
  expect(await reviewer.execute({ action: "read" })).toEqual({ plan: null });
}, 30000);

test("M7-AC30：有过尝试且未完成的任务不能取消，其目标不能被新增或修改的任务揽走", async () => {
  const w = await world();
  const pm = await w.tool();
  const view = await pm.execute({ action: "propose", tasks: [spec("login"), spec("failure", { goalUnitIds: ["scenario.failure"] })] }) as PlanView;
  const login = view.tasks.find((task) => task.key === "login")!, failure = view.tasks.find((task) => task.key === "failure")!;
  w.db((db) => {
    const row = db.read<Record<string, unknown>>(TASKS, login.taskId)!;
    db.update(TASKS, login.taskId, row.version, { ...row.data, status: "awaiting_parent",
      attempts: [{ runId: uuidv7(), maxTurns: 30, turnsUsed: 30, reason: null, outcome: "turn_limit_reached" }] });
  });
  await expect(pm.execute({ action: "update", planVersion: 1, cancel: [{ taskId: login.taskId, version: 1 }] })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(pm.execute({ action: "update", planVersion: 1, add: [spec("login-again")] })).rejects.toMatchObject({ code: "task_not_ready" });
  await expect(pm.execute({ action: "update", planVersion: 1, modify: [{ taskId: failure.taskId, version: 1,
    spec: spec("failure", { goalUnitIds: ["scenario.failure", "goal.login"] }) }] })).rejects.toMatchObject({ code: "task_not_ready" });
  const retried = await pm.execute({ action: "update", planVersion: 1, modify: [{ taskId: login.taskId, version: 1, spec: spec("login", { maxTurns: 40 }) }] }) as PlanView;
  expect(retried.tasks.find((task) => task.key === "login")).toMatchObject({ version: 2 });
}, 30000);

test("M7-AC30：未完成的 QA 任务只占住 QA 的目标，QA 报问题后仍可追加同目标的 worker 返修任务", async () => {
  const w = await world();
  const pm = await w.tool();
  const view = await pm.execute({ action: "propose", tasks: [spec("login"), spec("qa", { role: "qa", writePaths: [], dependsOn: ["login"] })] }) as PlanView;
  const qa = view.tasks.find((task) => task.key === "qa")!;
  w.db((db) => {
    const row = db.read<Record<string, unknown>>(TASKS, qa.taskId)!;
    db.update(TASKS, qa.taskId, row.version, { ...row.data, status: "awaiting_parent",
      attempts: [{ runId: uuidv7(), maxTurns: 30, turnsUsed: 3, reason: null, outcome: "incomplete" }] });
  });
  await expect(pm.execute({ action: "update", planVersion: 1, add: [spec("qa-again", { role: "qa", writePaths: [] })] })).rejects.toMatchObject({ code: "task_not_ready" });
  const repaired = await pm.execute({ action: "update", planVersion: 1, add: [spec("login-fix", { dependsOn: ["login"] })] }) as PlanView;
  expect(repaired.tasks.map((task) => task.key)).toContain("login-fix");
}, 30000);

test("M7-AC30：已有尝试的任务修改时须保留原有目标，不能先改走目标再另起新任务", async () => {
  const w = await world();
  const pm = await w.tool();
  const view = await pm.execute({ action: "propose", tasks: [spec("login")] }) as PlanView;
  const login = view.tasks[0]!;
  w.db((db) => {
    const row = db.read<Record<string, unknown>>(TASKS, login.taskId)!;
    db.update(TASKS, login.taskId, row.version, { ...row.data, status: "awaiting_parent",
      attempts: [{ runId: uuidv7(), maxTurns: 30, turnsUsed: 30, reason: null, outcome: "turn_limit_reached" }] });
  });
  await expect(pm.execute({ action: "update", planVersion: 1, modify: [{ taskId: login.taskId, version: 1,
    spec: spec("login", { goalUnitIds: ["scenario.failure"] }) }] })).rejects.toMatchObject({ code: "task_not_ready" });
  const widened = await pm.execute({ action: "update", planVersion: 1, modify: [{ taskId: login.taskId, version: 1,
    spec: spec("login", { goalUnitIds: ["goal.login", "scenario.failure"] }) }] }) as PlanView;
  expect(widened.tasks[0]).toMatchObject({ version: 2 });
}, 30000);
