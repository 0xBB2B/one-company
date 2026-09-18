import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createRecord, readRecord, putRecord, writeRecord, repositoryDatabase, withDatabase, LocalDatabase, StaleVersionError, AsyncTransactionError } from "../runtime/database.ts";
import { decisionStream } from "../runtime/decisions.ts";
import { checkAcceptanceReport } from "../runtime/delivery.ts";
import type { AcceptanceResult } from "../runtime/result.ts";
import {
  VALID_STAGES, VALID_TASK_PROGRESS, advanceStage, assertValidStage, assertValidTaskProgress,
  bindEvidence, checkEvidence, checkResume, failTask, finishTask, initRequirementState,
  invalidateEvidence, listEvidenceStages, readRequirementState, recordShape, rejectRequirement,
  requirementStateRef, retreatStage, rollbackTask, skippedGates, startTask, updateTaskFields,
} from "../runtime/workflow-state.ts";
import type { RequirementState, RequirementShape } from "../runtime/workflow-state.ts";

const REQUIREMENT = "2026-09-09.workflow-demo";
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function world() {
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT };
  const database = repositoryDatabase(ctx.dataRoot, identity.repoId);
  const ref = requirementStateRef(ctx.dataRoot, identity.repoId, REQUIREMENT);
  const runStore = new RunStore({ dataRoot: ctx.dataRoot, repoId: identity.repoId, daemonStartedAt: "state-test" });
  const currentVersion = { definitionFingerprint: "fp-1", codeHead: "head-1" };
  const shape: RequirementShape = { tasks: [{ id: "task-a", roles: ["impl"] }], gates: { plan: false, whiteboxReview: false, blackboxAcceptance: false },
    skipped: ["plan", "whiteboxReview", "blackboxAcceptance"].map((gate) => ({ gate, decisionId: "USER-001" })), acceptanceReport: "synthetic-report", decisionId: "USER-001" };
  // 直接准备无授权历史记录；不模拟批准服务，也不调用旧推进链。
  const seed = (stage = "reviewing", progress = "todo", runId: string | null = null) => createRecord(ref, {
    requirement: REQUIREMENT, stage, shape, tasks: { "task-a": { progress, runId, description: "历史任务", agent: "", note: "", commit: null, reason: "", repairRound: 0, blockedReason: "", workspaceDir: "" } },
    followUps: ["历史跟进"], history: [{ stage, at: "2026-09-09T00:00:00.000Z", runId, decisionId: "USER-001", reason: "合成历史" }],
  } satisfies RequirementState);
  const snapshot = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return JSON.stringify({ records: db.prepare("SELECT * FROM records ORDER BY id").all(), events: db.prepare("SELECT * FROM events ORDER BY id").all() }); }
    finally { db.close(); }
  };
  const run = async (state: "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted" = "completed", result: unknown = reviewResult(), task = "", requirement = REQUIREMENT) => {
    const created = await runStore.create({ kind: "role", role: "pi-company.worker", standalone: true, requirement, task, cwd: repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    if (state === "interrupted") await runStore.markInterruptedOnStartup();
    else if (state !== "queued") {
      await runStore.update(created.id, { state: "running" });
      if (state !== "running") await runStore.update(created.id, { state, result });
    }
    return created.id;
  };
  function reviewResult(patch: Record<string, unknown> = {}) {
    return { phase: "review", verdict: "PASS", summary: "合成结果", issues: [], evidence: ["README.md:1"], reviewedHead: currentVersion.codeHead,
      contentFingerprint: currentVersion.definitionFingerprint, traceability: [{ ref: "demo/AC-1", test: "README.md:1", implementation: "README.md:1" }], findings: [],
      binding: { requirement: REQUIREMENT, ...currentVersion, cwd: repo.root }, ...patch };
  }
  function workResult(patch: Record<string, unknown> = {}) {
    return { phase: "work", verdict: "PASS", summary: "合成结果", issues: [], evidence: ["README.md:1"], changeKind: "refactor", coverage: [{ ref: "demo/AC-1", test: "README.md:1" }],
      redCommands: [], greenCommands: [{ command: "pnpm test", status: "passed", details: "合成结果" }], productionPath: ["README.md"], fakeRed: false,
      changedFiles: ["README.md"], workState: "red-green", preexistingEvidence: [], binding: { requirement: REQUIREMENT, task: "task-a", ...currentVersion, cwd: repo.root }, ...patch };
  }
  return { home, repo, identity, ctx, database, ref, seed, shape, currentVersion, runStore, run, reviewResult, workResult, snapshot };
}
type World = Awaited<ReturnType<typeof world>>;
const state = (w: World) => readRecord<RequirementState>(w.ref);

const operations = {
  advanceStage: (w: World) => advanceStage({ expectedVersion: 1, targetStage: "accepted", decisionId: "USER-001", currentVersion: w.currentVersion }, w.ctx),
  retreatStage: (w: World) => retreatStage({ expectedVersion: 1, targetStage: "executing", reason: "修复", decisionId: "USER-001" }, w.ctx),
  recordShape: (w: World) => recordShape({ expectedVersion: 1, shape: w.shape }, w.ctx),
  startTask: (w: World) => startTask({ expectedVersion: 1, taskId: "task-a", runId: "old-run" }, w.ctx),
  finishTask: (w: World) => finishTask({ expectedVersion: 1, taskId: "task-a", runId: "old-run", currentVersion: w.currentVersion }, w.ctx),
  rollbackTask: (w: World) => rollbackTask({ expectedVersion: 1, taskId: "task-a", decisionId: "USER-001" }, w.ctx),
  rejectRequirement: (w: World) => rejectRequirement({ expectedVersion: 1, decisionId: "USER-001" }, w.ctx),
  updateTaskFields: (w: World) => updateTaskFields({ expectedVersion: 1, taskId: "task-a", fields: { note: "新备注", agent: "impl", commit: "abc1234", description: "新描述", blockedReason: "等待", workspaceDir: "/tmp/fixture" }, followUps: ["新事项"] }, w.ctx),
  checkResume: (w: World) => checkResume(w.ctx, w.currentVersion),
};
describe("旧执行状态永久拒绝", () => {
  for (const [name, operation] of Object.entries(operations)) {
    test.each(VALID_STAGES)(`${name}在%s历史阶段拒绝，USER/AI/skipped不能授权且数据不变`, async (stage) => {
      const w = await world(); w.seed(stage, stage === "accepted" ? "done" : "failed");
      withDatabase(w.database, (db) => {
        for (const actor of ["user", "ai"] as const) db.append(decisionStream(REQUIREMENT, actor), { id: actor === "user" ? "USER-001" : "AI-001", actor, requirement: REQUIREMENT, effects: ["scope", "repair:review:4"], decision: "合成历史决定" });
      });
      const before = w.snapshot();
      expect(await operation(w)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
      expect(skippedGates(w.shape)).toEqual([]); expect(w.snapshot()).toBe(before);
    });
  }
  test.each([undefined, "AI-001", "USER-999", "USER-001"])("缺失、AI、未知或旧USER决定%s均不能授权旧变更", async (decisionId) => {
    const w = await world(); w.seed("planned"); const before = w.snapshot();
    expect(await advanceStage({ expectedVersion: 1, targetStage: "confirmed", decisionId }, w.ctx)).toMatchObject({ ok: false });
    expect(await rollbackTask({ expectedVersion: 1, taskId: "task-a", decisionId }, w.ctx)).toMatchObject({ ok: false });
    expect(await rejectRequirement({ expectedVersion: 1, decisionId }, w.ctx)).toMatchObject({ ok: false });
    expect(await retreatStage({ expectedVersion: 1, targetStage: "confirmed", reason: "范围变化", decisionId }, w.ctx)).toMatchObject({ ok: false });
    expect(w.snapshot()).toBe(before);
  });
  test.each(["missing-decision", "ai-decision", "empty-tasks", "missing-skip", "ai-skip"])("旧shape缺项或伪授权%s不能写入", async (variant) => {
    const w = await world(); w.seed("planned"); const shape = structuredClone(w.shape);
    if (variant === "missing-decision") delete (shape as Partial<RequirementShape>).decisionId;
    if (variant === "ai-decision") shape.decisionId = "AI-001";
    if (variant === "empty-tasks") shape.tasks = [];
    if (variant === "missing-skip") shape.skipped = [];
    if (variant === "ai-skip") shape.skipped = [{ gate: "blackboxAcceptance", decisionId: "AI-001" }];
    const before = w.snapshot(); expect(await recordShape({ expectedVersion: 1, shape }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); expect(w.snapshot()).toBe(before);
  });
  test("未知阶段拒绝且原阶段版本不变", async () => {
    const w = await world(); w.seed("draft"); const before = w.snapshot();
    expect(await advanceStage({ expectedVersion: 1, targetStage: "unknown-stage" }, w.ctx)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before);
  });
  test.each(["queued", "running", "completed", "failed", "stopped", "interrupted"] as const)("原运行%s不能用作回退或完成权限", async (status) => {
    const w = await world(); const runId = await w.run(status); w.seed("executing", "doing", runId); const before = w.snapshot();
    expect(await finishTask({ expectedVersion: 1, taskId: "task-a", runId, currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(await retreatStage({ expectedVersion: 1, targetStage: "confirmed", runId, reason: "历史回退", decisionId: "USER-001" }, w.ctx)).toMatchObject({ ok: false });
    expect(await rollbackTask({ expectedVersion: 1, taskId: "task-a", decisionId: "USER-001" }, w.ctx)).toMatchObject({ ok: false });
    expect(w.snapshot()).toBe(before);
  });
  test.each(["HEAD", "main", "zzzzzzz", "abcdef", "0".repeat(40)])("历史交付commit=%s不能完成任务", async (commit) => {
    const w = await world(); const runId = await w.run("completed", w.workResult({ delivery: { commit, verificationOk: true } }), "task-a");
    w.seed("executing", "doing", runId); const before = w.snapshot();
    expect(await finishTask({ expectedVersion: 1, taskId: "task-a", runId, currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(w.snapshot()).toBe(before);
  });
  test.each([
    { delivery: { verificationOk: false } },
    { changedFiles: [], workState: "green-baseline-no-change", preexistingEvidence: ["旧证据"] },
    { changedFiles: [], workState: "green-baseline-no-change", preexistingEvidence: [] },
    { changedFiles: [], workState: "red-green", preexistingEvidence: ["旧证据"] },
  ])("历史交付组合不授予done：%j", async (patch) => {
    const w = await world(); const runId = await w.run("completed", w.workResult(patch), "task-a"); w.seed("executing", "doing", runId); const before = w.snapshot();
    expect(await finishTask({ expectedVersion: 1, taskId: "task-a", runId, currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before);
  });
  test.each([{ unknownField: "x" }, { stage: "accepted" }, { progress: "done" }])("字段注入被拒绝且历史任务不变：%j", async (fields) => {
    const w = await world(); w.seed("executing"); const before = w.snapshot();
    expect(await updateTaskFields({ expectedVersion: 1, taskId: "task-a", fields }, w.ctx)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before);
  });
  test("缺失或损坏状态不能经旧入口恢复，也不被覆盖成完成", async () => {
    const w = await world(); expect(await checkResume(w.ctx)).toMatchObject({ ok: false });
    putRecord(w.ref, "损坏的需求记录"); const before = state(w);
    for (const operation of Object.values(operations)) expect(await operation(w)).toMatchObject({ ok: false });
    expect(state(w)).toEqual(before);
    await expect(readRequirementState(w.ctx)).rejects.toThrow("运行库尚未初始化、不可读或需要维护核对");
  });
});

describe("历史状态读取与基础校验", () => {
  test("缺库只读拒绝且不建库，现存库缺记录明确exists false", async () => {
    const w = await world();
    await expect(readRequirementState(w.ctx)).rejects.toThrow("运行库尚未初始化、不可读或需要维护核对");
    expect(existsSync(w.database)).toBe(false);
    withDatabase(w.database, () => {}); const before = w.snapshot();
    expect(await readRequirementState(w.ctx)).toEqual({ exists: false }); expect(w.snapshot()).toBe(before);
  });
  test("assertValidStage拒绝未知值并明确指出非法值", () => { expect(() => assertValidStage("unknown-stage")).toThrow("不合法的阶段: unknown-stage"); });
  test("assertValidStage接受全部合法历史阶段值", () => { for (const stage of VALID_STAGES) expect(() => assertValidStage(stage)).not.toThrow(); });
  test("assertValidTaskProgress拒绝未知值并明确指出非法值", () => { expect(() => assertValidTaskProgress("unknown-progress")).toThrow("不合法的任务进度: unknown-progress"); });
  test("assertValidTaskProgress拒绝把paused当作任务进度", () => { expect(() => assertValidTaskProgress("paused")).toThrow(); });
  test("assertValidTaskProgress接受全部合法任务进度值", () => { for (const progress of VALID_TASK_PROGRESS) expect(() => assertValidTaskProgress(progress)).not.toThrow(); });
  test("空草稿初始化不产生批准，重复初始化不覆盖原状态", async () => {
    const w = await world(); expect(await initRequirementState(w.ctx)).toEqual({ ok: true, version: 1 });
    const before = await readRequirementState(w.ctx); expect(before).toMatchObject({ exists: true, version: 1, data: { stage: "draft", shape: null, tasks: {}, history: [] } });
    expect(await initRequirementState(w.ctx)).toMatchObject({ ok: false }); expect(await readRequirementState(w.ctx)).toEqual(before);
    expect(await advanceStage({ expectedVersion: 1, targetStage: "confirmed" }, w.ctx)).toMatchObject({ ok: false });
  });
});

async function failureWorld() {
  const w = await world(); const a = await w.run("failed", { verdict: "FAIL" }, "task-a"); const b = await w.run("failed", { verdict: "FAIL" }, "task-b");
  w.seed("executing", "doing", a);
  const initial = state(w); if (!initial.exists) throw new Error("夹具缺失");
  writeRecord(w.ref, { ...initial.data, tasks: { ...initial.data.tasks, "task-b": { ...initial.data.tasks["task-a"]!, runId: b } } }, { expectedVersion: initial.version });
  return { ...w, a, b };
}
describe("真实失败登记与版本并发", () => {
  test("failTask不能串用另一真实仓库同名任务的失败运行", async () => {
    const w = await world(); const other = await world(); const runId = await other.run("failed", {}, "task-a");
    w.seed("executing", "doing", runId); const before = w.snapshot(), foreignBefore = other.snapshot();
    expect(await failTask({ expectedVersion: 1, taskId: "task-a", runId, reason: "跨库伪造失败" }, w.ctx)).toEqual({ ok: false, reason: "缺少真实失败运行" });
    expect(w.snapshot()).toBe(before); expect(other.snapshot()).toBe(foreignBefore);
  });
  test("failTask记录failed和原因，累加轮次但不授予重试", async () => {
    const w = await failureWorld(); const before = state(w); if (!before.exists) throw new Error("夹具缺失"); const runBefore = await w.runStore.get(w.a);
    expect(await failTask({ expectedVersion: before.version, taskId: "task-a", runId: w.a, reason: "边界断言失败" }, w.ctx)).toEqual({ ok: true, version: before.version + 1 });
    expect(state(w)).toMatchObject({ data: { tasks: { "task-a": { progress: "failed", reason: "边界断言失败", repairRound: 1 } } } });
    expect(await w.runStore.get(w.a)).toEqual(runBefore); const frozen = w.snapshot();
    expect(await startTask({ expectedVersion: before.version + 1, taskId: "task-a", runId: w.a }, w.ctx)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(frozen);
  });
  test("两个调用方同version登记不同失败，后者staleVersion且只陈述事实", async () => {
    const w = await failureWorld(); const before = state(w); if (!before.exists) throw new Error("夹具缺失");
    const first = await failTask({ expectedVersion: before.version, taskId: "task-a", runId: w.a, reason: "A失败" }, w.ctx); expect(first.ok).toBe(true);
    const second = await failTask({ expectedVersion: before.version, taskId: "task-b", runId: w.b, reason: "B失败" }, w.ctx);
    expect(second).toEqual({ ok: false, staleVersion: true, reason: "版本已变化" });
    expect(state(w)).toMatchObject({ data: { tasks: { "task-a": { reason: "A失败" }, "task-b": { progress: "doing", reason: "" } } } });
  });
  test("同步record原语拒绝过期版本，重新读取后的合法更新保留双方内容", async () => {
    const w = await world(); const before = w.seed();
    writeRecord(w.ref, { ...before.data, followUps: ["B"] }, { expectedVersion: before.version });
    expect(() => writeRecord(w.ref, { ...before.data, followUps: ["A"] }, { expectedVersion: before.version })).toThrow(StaleVersionError);
    const next = state(w); if (!next.exists) throw new Error("夹具缺失");
    writeRecord(w.ref, { ...next.data, followUps: [...next.data.followUps, "A"] }, { expectedVersion: next.version });
    expect(state(w)).toMatchObject({ data: { followUps: ["B", "A"] } });
  });
  test.each(["queued", "running", "completed", "stopped", "interrupted"] as const)("failTask拒绝%s运行而非相信模型自报失败", async (status) => {
    const w = await world(); const runId = await w.run(status, { verdict: "FAIL" }, "task-a"); w.seed("executing", "doing", runId); const before = w.snapshot();
    expect(await failTask({ expectedVersion: 1, taskId: "task-a", runId, reason: "自报失败" }, w.ctx)).toEqual({ ok: false, reason: "缺少真实失败运行" }); expect(w.snapshot()).toBe(before);
  });
  test.each(["requirement", "task", "runId"])("failTask核对%s身份，不串用失败运行", async (mismatch) => {
    const w = await world(); const runId = await w.run("failed", {}, mismatch === "task" ? "task-b" : "task-a", mismatch === "requirement" ? "2026-09-09.other" : REQUIREMENT);
    w.seed("executing", "doing", mismatch === "runId" ? "different" : runId); const before = w.snapshot();
    const result = await failTask({ expectedVersion: 1, taskId: "task-a", runId, reason: "失败" }, w.ctx);
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty("staleVersion"); expect(w.snapshot()).toBe(before);
  });
});

describe("旧证据批准拒绝与真实减权保护", () => {
  test("bindEvidence与checkEvidence永久拒绝，不输出旧结果或改变数据库", async () => {
    const w = await world(); w.seed(); const runId = await w.run();
    createRecord({ database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "review" }, { runId, ...w.currentVersion, summary: "不得返回的旧结果" });
    const before = w.snapshot();
    for (const result of [await bindEvidence({ stage: "review", runId, currentVersion: w.currentVersion }, w.ctx), await checkEvidence({ stage: "review", currentVersion: w.currentVersion }, w.ctx)]) {
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); expect(JSON.stringify(result)).not.toContain("不得返回的旧结果");
    }
    expect(w.snapshot()).toBe(before);
  });
  test("真实失效写入故障不留半份记录，不改变历史阶段与版本", async () => {
    const w = await world(); w.seed(); const before = w.snapshot();
    const restore = failDatabaseWrites(w.database, "records", "namespace", `evidence:${REQUIREMENT}`);
    try { await expect(invalidateEvidence(w.ctx, "review", "实际变更")).rejects.toThrow(); }
    finally { restore(); }
    expect(w.snapshot()).toBe(before); expect(await listEvidenceStages(w.ctx)).not.toContain("review");
  });
  test("同步事务中状态、事件和证据全部提交或全部回滚", async () => {
    const w = await world(); const initial = w.seed(); const stream = "test-atomic-events";
    const apply = () => withDatabase(w.database, (db) => db.transaction(() => {
      const current = db.read<RequirementState>("requirements", REQUIREMENT)!;
      db.update("requirements", REQUIREMENT, current.version, { ...current.data, followUps: ["同步元数据"] });
      db.append(stream, { kind: "test-state-update" }); db.create(`evidence:${REQUIREMENT}`, "atomic", { inputHash: "fixture" });
    }));
    const restore = failDatabaseWrites(w.database, "records", "namespace", `evidence:${REQUIREMENT}`);
    try { expect(apply).toThrow(); } finally { restore(); }
    expect(state(w)).toMatchObject({ version: initial.version, data: initial.data });
    expect(withDatabase(w.database, (db) => db.events(stream))).toEqual([]);
    apply(); expect(state(w)).toMatchObject({ version: initial.version + 1, data: { followUps: ["同步元数据"] } });
    expect(withDatabase(w.database, (db) => db.events(stream))).toHaveLength(1); expect(await listEvidenceStages(w.ctx)).toContain("atomic");
  });
  test("违规异步事务回滚并封禁连接，等待迟到状态和事件写入确实被拒绝", async () => {
    const w = await world(); w.seed(); const before = state(w); const db = new LocalDatabase(w.database);
    let continued = false; let delayed = false; let finish!: () => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    const invalid = async () => {
      const r = db.read<RequirementState>("requirements", REQUIREMENT)!;
      db.update("requirements", REQUIREMENT, r.version, { ...r.data, followUps: ["不允许提交"] });
      await Promise.resolve(); continued = true;
      expect(() => db.append("test-late-events", {})).toThrow("失效");
      setTimeout(() => { try { delayed = true; expect(() => db.create("late", "state", {})).toThrow("失效"); } finally { finish(); } }, 5);
    };
    try {
      expect(() => db.transaction(invalid as unknown as () => void)).toThrow(AsyncTransactionError);
      await ended; expect(continued).toBe(true); expect(delayed).toBe(true);
      expect(() => db.transaction(() => db.append("test-late-events", {}))).toThrow("失效");
      expect(state(w)).toEqual(before); expect(withDatabase(w.database, (other) => other.events("test-late-events"))).toEqual([]);
      expect(withDatabase(w.database, (other) => other.list("late"))).toEqual([]);
    } finally { db.close(); }
  });
  test("真实失效提高记录版本，迟到条件写入及旧绑定不能覆盖失效标记", async () => {
    const w = await world(); w.seed(); const runId = await w.run();
    const ref = { database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "review" };
    const observed = createRecord(ref, { runId, invalid: false });
    await invalidateEvidence(w.ctx, "review", "核验期间越界"); const invalidated = readRecord(ref);
    expect(invalidated).toMatchObject({ exists: true, version: observed.version + 1, data: { invalid: true, reason: "核验期间越界" } });
    expect(() => writeRecord(ref, observed.data, { expectedVersion: observed.version })).toThrow(StaleVersionError);
    expect(await bindEvidence({ stage: "review", runId, currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(readRecord(ref)).toEqual(invalidated);
  });
  test.each(["definitionFingerprint", "codeHead"] as const)("历史%s相同或改变均不能从旧证据核对取得通过", async (field) => {
    const w = await world(); w.seed();
    createRecord({ database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "review" }, { ...w.currentVersion, invalid: false }); const before = w.snapshot();
    for (const currentVersion of [w.currentVersion, { ...w.currentVersion, [field]: "changed" }]) {
      expect(await checkEvidence({ stage: "review", currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    }
    expect(w.snapshot()).toBe(before);
  });
  test("失效保留阶段记录，旧bind/check/resume均不能恢复通过", async () => {
    const w = await world(); w.seed(); const runId = await w.run();
    const ref = { database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "review" };
    const original = createRecord(ref, { runId, invalid: false }); const stateBefore = state(w);
    await invalidateEvidence(w.ctx, "review", "越界");
    expect(await listEvidenceStages(w.ctx)).toContain("review");
    expect(readRecord(ref)).toMatchObject({ exists: true, version: original.version + 1, data: { stage: "review", invalid: true, reason: "越界", invalidatedAt: expect.any(String) } });
    const invalidated = w.snapshot();
    for (const result of [await bindEvidence({ stage: "review", runId, currentVersion: w.currentVersion }, w.ctx), await checkEvidence({ stage: "review", currentVersion: w.currentVersion }, w.ctx), await checkResume(w.ctx, w.currentVersion)]) expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(w.snapshot()).toBe(invalidated); expect(state(w)).toEqual(stateBefore);
  });
  test("未绑定阶段可真实失效，缺失和损坏旧证据核对固定拒绝且不修复", async () => {
    const w = await world();
    expect(await checkEvidence({ stage: "missing", currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    await invalidateEvidence(w.ctx, "never-bound", "无对应证据");
    expect(await listEvidenceStages(w.ctx)).toContain("never-bound");
    expect(readRecord({ database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "never-bound" })).toMatchObject({ data: { invalid: true } });
    putRecord({ database: w.database, namespace: `evidence:${REQUIREMENT}`, key: "review" }, "损坏记录"); const before = w.snapshot();
    expect(await checkEvidence({ stage: "review", currentVersion: w.currentVersion }, w.ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); expect(w.snapshot()).toBe(before);
  });
  test.each(["running", "missing-binding", "foreign-requirement", "foreign-cwd", "phase", "verdict", "fingerprint", "head", "run-identity", "task-identity"])("旧证据载荷%s永久拒绝且无写入，不提供旧批准链", async (mismatch) => {
    const w = await world(); w.seed(); let result: Record<string, unknown> = w.reviewResult();
    if (mismatch === "missing-binding") delete result.binding;
    if (mismatch === "phase") result.phase = "plan";
    if (mismatch === "verdict") { result.verdict = "FAIL"; result.issues = ["实际失败"]; }
    if (mismatch === "foreign-cwd") {
      const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
      result.binding = { ...result.binding as object, cwd: other.root };
    }
    const field = { "foreign-requirement": "requirement", fingerprint: "definitionFingerprint", head: "codeHead", "task-identity": "task" }[mismatch];
    if (field) result.binding = { ...result.binding as object, [field]: "different" };
    const runId = await w.run(mismatch === "running" ? "running" : "completed", result, "", mismatch === "run-identity" ? "2026-09-09.other" : REQUIREMENT);
    const before = w.snapshot(); const outcome = await bindEvidence({ stage: "review", runId, currentVersion: w.currentVersion }, w.ctx);
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(w.snapshot()).toBe(before);
  });
  test.each(["FAIL", "other-task", "foreign-cwd"])("旧work载荷%s永久拒绝，不返回或重建旧证据", async (variant) => {
    const w = await world(); w.seed("executing"); const result = w.workResult(variant === "FAIL" ? { verdict: "FAIL", issues: ["实际失败"] } : {});
    if (variant === "other-task") result.binding = { ...result.binding, task: "task-b" };
    if (variant === "foreign-cwd") {
      const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other)); result.binding = { ...result.binding, cwd: other.root };
    }
    const runId = await w.run("completed", result, "task-a"); const before = w.snapshot();
    const outcome = await bindEvidence({ stage: "work-task-a", runId, currentVersion: w.currentVersion }, w.ctx);
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); expect(w.snapshot()).toBe(before);
  });
  test("旧plan载荷无论需求或phase均拒绝，不重建证据", async () => {
    const w = await world(); w.seed();
    for (const patch of [{ phase: "work" }, { binding: { requirement: "2026-09-09.other", ...w.currentVersion, cwd: w.repo.root } }]) {
      const runId = await w.run("completed", { phase: "plan", verdict: "PASS", binding: { requirement: REQUIREMENT, ...w.currentVersion, cwd: w.repo.root }, ...patch });
      expect((await bindEvidence({ stage: "plan", runId, currentVersion: w.currentVersion }, w.ctx)).ok).toBe(false);
    }
    expect(await listEvidenceStages(w.ctx)).toEqual([]);
  });
  test("真实list/invalidate按任务、需求和仓库隔离，只减权目标阶段", async () => {
    const w = await world(); w.seed("executing");
    const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
    const contexts = [w.ctx, { ...w.ctx, requirement: "2026-09-09.other" }, { ...w.ctx, cwd: other.root }];
    const records = await Promise.all(contexts.map(async (ctx) => {
      const identity = await repositoryIdentity(ctx.cwd); const database = repositoryDatabase(ctx.dataRoot, identity.repoId);
      for (const stage of ["work-task-a", "work-task-b"]) withDatabase(database, (db) => db.create(`evidence:${ctx.requirement}`, stage, { stage, invalid: false }));
      return () => withDatabase(database, (db) => db.list(`evidence:${ctx.requirement}`));
    }));
    const before = records.map((read) => read());
    await invalidateEvidence(w.ctx, "work-task-a", "真实文件变化");
    for (const ctx of contexts) expect((await listEvidenceStages(ctx)).sort()).toEqual(["work-task-a", "work-task-b"]);
    expect(records[0]!().find((r) => r.key === "work-task-a")).toMatchObject({ version: 2, data: { invalid: true } });
    expect(records[0]!().find((r) => r.key === "work-task-b")).toEqual(before[0]!.find((r) => r.key === "work-task-b"));
    expect(records[1]!()).toEqual(before[1]); expect(records[2]!()).toEqual(before[2]);
  });
  test("验收报告路径不匹配通过真实报告primitive拒绝", async () => {
    const w = await world(); const expected = join(w.repo.root, "expected.md"), other = join(w.repo.root, "other.md");
    const content = "---\ndate: 2026-09-09\nresult: accepted\n---\n## 验收结果\n| AC-1 | PASS | 符合 | |\n## 所用命令\npnpm test\n";
    await writeFile(expected, content); await writeFile(other, content);
    const result: AcceptanceResult = { phase: "acceptance", verdict: "PASS", summary: "合成报告", issues: [], evidence: ["AC-1"], acceptanceResult: "accepted", reportPath: other,
      items: [{ id: "AC-1", result: "PASS", observed: "符合", difference: "" }], uncovered: [] };
    await expect(checkAcceptanceReport(result, expected, ["pnpm test"])).rejects.toThrow("位置不一致");
    expect(await checkAcceptanceReport({ ...result, reportPath: expected }, expected, ["pnpm test"])).toBe(createHash("sha256").update(content).digest("hex"));
  });
});
