import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity, requirementDataDir } from "../runtime/identity.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createDocument, readDocument } from "../runtime/store.ts";
import {
  VALID_STAGES,
  VALID_TASK_PROGRESS,
  advanceStage,
  assertValidStage,
  assertValidTaskProgress,
  bindEvidence,
  checkEvidence,
  checkResume,
  failTask,
  finishTask,
  initRequirementState,
  recordShape,
  rejectRequirement,
  retreatStage,
  rollbackTask,
  startTask,
  updateTaskFields,
} from "../runtime/workflow-state.ts";

const execFileAsync = promisify(execFile);
const REQUIREMENT = "2026-09-09.workflow-demo";

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
});

interface StateDoc {
  requirement: string;
  stage: string;
  shape: Record<string, unknown> | null;
  tasks: Record<string, { progress: string; runId?: string; repairRound?: number; [key: string]: unknown }>;
  followUps: unknown[];
  history: unknown[];
}

function statePath(dataRoot: string, repoId: string, requirement: string): string {
  return `${requirementDataDir(dataRoot, repoId, requirement)}/state.json`;
}

async function seedState(dataRoot: string, repoId: string, requirement: string, overrides: Record<string, unknown> = {}) {
  const initial: StateDoc = {
    requirement,
    stage: "draft",
    shape: null,
    tasks: {},
    followUps: [],
    history: [],
    ...overrides,
  };
  return createDocument(statePath(dataRoot, repoId, requirement), initial);
}

async function readState(dataRoot: string, repoId: string, requirement: string): Promise<{ version: number; data: StateDoc }> {
  const result = await readDocument(statePath(dataRoot, repoId, requirement));
  if (!result.exists) throw new Error("期望状态文档存在");
  return { version: result.version, data: result.data as StateDoc };
}

async function repoHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

const ACCEPTANCE_REPORT = "/reports/workflow-demo/acceptance.md";

function userDecisionInput(requirement: string, overrides: Record<string, unknown> = {}) {
  return {
    requirement,
    actor: "user" as const,
    source: "workflow-state-test",
    trigger: "确认需求范围",
    decision: "确认按现有范围推进",
    alternatives: [],
    effects: ["scope"],
    impact: "无重大影响",
    ...overrides,
  };
}

function aiDecisionInput(requirement: string, overrides: Record<string, unknown> = {}) {
  return {
    requirement,
    actor: "ai" as const,
    source: "workflow-state-test",
    trigger: "AI 判断",
    decision: "AI 自主决定",
    alternatives: [],
    effects: ["scope"],
    scope: "workflow-state",
    basis: ["测试固定基准"],
    action: "记录决定",
    ...overrides,
  };
}

async function appendUserDecisionId(world: World, trigger: string, decision: string): Promise<string> {
  const receipt = await appendDecision(userDecisionInput(world.requirement, { trigger, decision }), {
    dataRoot: world.home.dataRoot,
    cwd: world.repo.root,
  });
  return receipt.decisionId;
}

async function appendAiDecisionId(world: World, trigger: string, decision: string): Promise<string> {
  const receipt = await appendDecision(aiDecisionInput(world.requirement, { trigger, decision }), {
    dataRoot: world.home.dataRoot,
    cwd: world.repo.root,
  });
  return receipt.decisionId;
}

async function interruptedRun(world: World, taskId = "task-a"): Promise<string> {
  const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, taskId));
  const otherGenerationStore = new RunStore({
    dataRoot: world.home.dataRoot,
    repoId: world.identity.repoId,
    daemonStartedAt: "other-daemon-generation",
  });
  await otherGenerationStore.markInterruptedOnStartup();
  return run.id;
}

function shapeInput(decisionId: string, overrides: Record<string, unknown> = {}) {
  return {
    tasks: [{ id: "task-a", roles: ["impl"] }],
    gates: { plan: true, whiteboxReview: true, blackboxAcceptance: true },
    skipped: [],
    acceptanceReport: ACCEPTANCE_REPORT,
    decisionId,
    ...overrides,
  };
}

function baseRunInput(requirement: string, cwd: string, task = "") {
  return {
    kind: "requirement" as const,
    requirement,
    task,
    cwd,
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
  };
}

async function completedRun(store: RunStore, requirement: string, cwd: string, result: unknown, task = ""): Promise<string> {
  const run = await store.create(baseRunInput(requirement, cwd, task));
  await store.update(run.id, { state: "running" });
  await store.update(run.id, { state: "completed", result });
  return run.id;
}

function planResult(
  requirement: string,
  currentVersion: { definitionFingerprint: string; codeHead: string },
  cwd: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    phase: "plan",
    verdict: "PASS",
    binding: { requirement, definitionFingerprint: currentVersion.definitionFingerprint, codeHead: currentVersion.codeHead, cwd },
    ...overrides,
  };
}

function reviewResult(
  requirement: string,
  currentVersion: { definitionFingerprint: string; codeHead: string },
  cwd: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    phase: "review",
    verdict: "PASS",
    binding: { requirement, definitionFingerprint: currentVersion.definitionFingerprint, codeHead: currentVersion.codeHead, cwd },
    ...overrides,
  };
}

function acceptanceResult(
  requirement: string,
  currentVersion: { definitionFingerprint: string; codeHead: string },
  cwd: string,
  reportPath: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    phase: "acceptance",
    verdict: "PASS",
    acceptanceResult: "accepted",
    reportPath,
    binding: { requirement, definitionFingerprint: currentVersion.definitionFingerprint, codeHead: currentVersion.codeHead, cwd },
    ...overrides,
  };
}

function workResult(
  requirement: string,
  task: string,
  currentVersion: { definitionFingerprint: string; codeHead: string },
  cwd: string,
  commit: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    phase: "work",
    verdict: "PASS",
    changedFiles: ["a.ts"],
    workState: "red-green",
    preexistingEvidence: [],
    binding: { requirement, task, definitionFingerprint: currentVersion.definitionFingerprint, codeHead: currentVersion.codeHead, cwd },
    delivery: { commit, verificationOk: true },
    ...overrides,
  };
}

async function setupWorld() {
  const home = await createTempHome();
  tempHomes.push(home);
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  const identity = await repositoryIdentity(repo.root);
  const requirement = REQUIREMENT;
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: new Date().toISOString() });
  const currentVersion = { definitionFingerprint: "fp-1", codeHead: "head-1" };
  return { home, repo, identity, requirement, ctx, runStore, currentVersion };
}

type World = Awaited<ReturnType<typeof setupWorld>>;

function currentState(world: World) {
  return readState(world.home.dataRoot, world.identity.repoId, world.requirement);
}

async function toConfirmed(world: World): Promise<string> {
  await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
  const decision = await appendDecision(userDecisionInput(world.requirement), { dataRoot: world.home.dataRoot, cwd: world.repo.root });
  const state = await currentState(world);
  const result = await advanceStage(
    { expectedVersion: state.version, targetStage: "confirmed", decisionId: decision.decisionId },
    world.ctx,
  );
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 confirmed");
  return decision.decisionId;
}

async function toPlanned(world: World): Promise<string> {
  await toConfirmed(world);
  const runId = await completedRun(world.runStore, world.requirement, world.repo.root, planResult(world.requirement, world.currentVersion, world.repo.root));
  const state = await currentState(world);
  const result = await advanceStage(
    { expectedVersion: state.version, targetStage: "planned", runId, currentVersion: world.currentVersion },
    world.ctx,
  );
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 planned");
  return runId;
}

async function toExecuting(world: World, shapeOverrides: Record<string, unknown> = {}): Promise<void> {
  await toPlanned(world);
  const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
  let state = await currentState(world);
  const shapeResult = await recordShape({ expectedVersion: state.version, shape: shapeInput(shapeDecisionId, shapeOverrides) }, world.ctx);
  if (!shapeResult.ok) throw new Error("测试装置失败: 无法记录形状");
  state = await currentState(world);
  const result = await advanceStage({ expectedVersion: state.version, targetStage: "executing" }, world.ctx);
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 executing");
}

async function toTaskDone(world: World, taskId = "task-a"): Promise<string> {
  await toExecuting(world);
  let state = await currentState(world);
  const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, taskId));
  const started = await startTask({ expectedVersion: state.version, taskId, runId: workRun.id }, world.ctx);
  if (!started.ok) throw new Error("测试装置失败: 无法登记 doing");
  await world.runStore.update(workRun.id, { state: "running" });
  const commit = await repoHeadCommit(world.repo.root);
  await world.runStore.update(workRun.id, {
    state: "completed",
    result: workResult(world.requirement, taskId, world.currentVersion, world.repo.root, commit),
  });
  state = await currentState(world);
  const finished = await finishTask({ expectedVersion: state.version, taskId, runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
  if (!finished.ok) throw new Error("测试装置失败: 无法完成任务");
  return workRun.id;
}

async function toReviewing(world: World): Promise<void> {
  await toTaskDone(world);
  const state = await currentState(world);
  const result = await advanceStage({ expectedVersion: state.version, targetStage: "reviewing" }, world.ctx);
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 reviewing");
}

async function toAccepting(world: World): Promise<string> {
  await toReviewing(world);
  const runId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
  const state = await currentState(world);
  const result = await advanceStage(
    { expectedVersion: state.version, targetStage: "accepting", runId, currentVersion: world.currentVersion },
    world.ctx,
  );
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 accepting");
  return runId;
}

async function toAccepted(world: World): Promise<void> {
  await toAccepting(world);
  const runId = await completedRun(
    world.runStore,
    world.requirement,
    world.repo.root,
    acceptanceResult(world.requirement, world.currentVersion, world.repo.root, ACCEPTANCE_REPORT),
  );
  const state = await currentState(world);
  const result = await advanceStage(
    { expectedVersion: state.version, targetStage: "accepted", runId, currentVersion: world.currentVersion },
    world.ctx,
  );
  if (!result.ok) throw new Error("测试装置失败: 无法推进到 accepted");
}

describe("阶段与任务进度合法值校验", () => {
  test("assertValidStage 拒绝未知阶段并在错误信息中列出合法集合", () => {
    let error: Error | undefined;
    try {
      assertValidStage("unknown-stage");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(Error);
    for (const stage of VALID_STAGES) expect(error?.message).toContain(stage);
  });

  test("assertValidStage 接受全部合法阶段值", () => {
    for (const stage of VALID_STAGES) expect(() => assertValidStage(stage)).not.toThrow();
  });

  test("assertValidTaskProgress 拒绝未知任务进度并在错误信息中列出合法集合", () => {
    let error: Error | undefined;
    try {
      assertValidTaskProgress("unknown-progress");
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(Error);
    for (const progress of VALID_TASK_PROGRESS) expect(error?.message).toContain(progress);
  });

  test("assertValidTaskProgress 拒绝把子运行状态 paused 写成任务进度", () => {
    expect(() => assertValidTaskProgress("paused")).toThrow();
  });

  test("assertValidTaskProgress 接受全部合法任务进度值", () => {
    for (const progress of VALID_TASK_PROGRESS) expect(() => assertValidTaskProgress(progress)).not.toThrow();
  });

  test("advanceStage 传入未知阶段被拒绝且原阶段与版本不变", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const before = await currentState(world);
    const result = await advanceStage({ expectedVersion: before.version, targetStage: "unknown-stage" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
    expect(after.version).toBe(before.version);
  });
});

describe("阶段推进 advanceStage 正常路径", () => {
  test("从 draft 依次推进到 accepted", async () => {
    const world = await setupWorld();
    await toAccepted(world);
    const after = await currentState(world);
    expect(after.data.stage).toBe("accepted");
  });

  test("直接 draft → accepted 被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "accepted", currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
  });
});

describe("阶段推进的前提核对", () => {
  test("confirmed 前提: 决定编号不存在于用户决策台账时被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "confirmed", decisionId: "USER-999" },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
  });

  test("confirmed 前提: 决定编号为 AI 决策台账编号时被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const aiDecisionId = await appendAiDecisionId(world, "AI 判断范围", "AI 自主确认范围");
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "confirmed", decisionId: aiDecisionId }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
  });

  test("planned 前提: runId 指向的运行未完成时保持原阶段并给出缺失原因", async () => {
    const world = await setupWorld();
    await toConfirmed(world);
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "planned", runId: run.id, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    const after = await currentState(world);
    expect(after.data.stage).toBe("confirmed");
  });

  test("planned 前提: 结果绑定另一需求时推进被拒绝并说明不匹配项", async () => {
    const world = await setupWorld();
    await toConfirmed(world);
    const runId = await completedRun(
      world.runStore,
      world.requirement,
      world.repo.root,
      planResult("2026-09-09.other-requirement", world.currentVersion, world.repo.root),
    );
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "planned", runId, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("confirmed");
  });

  test("planned 前提: 指纹或 HEAD 不一致时推进被拒绝并说明不匹配项", async () => {
    const world = await setupWorld();
    await toConfirmed(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, planResult(world.requirement, world.currentVersion, world.repo.root));
    const state = await currentState(world);
    const result = await advanceStage(
      {
        expectedVersion: state.version,
        targetStage: "planned",
        runId,
        currentVersion: { definitionFingerprint: "fp-mismatch", codeHead: world.currentVersion.codeHead },
      },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("confirmed");
  });

  test("executing 前提: 未记录形状时被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "executing" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("executing 前提: 形状声明的任务未全部登记在任务表中时被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "planned",
      shape: shapeInput("USER-000", {
        tasks: [
          { id: "task-a", roles: ["impl"] },
          { id: "task-b", roles: ["impl"] },
        ],
      }),
      tasks: {
        "task-a": { progress: "todo", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 },
      },
    });
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "executing" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("reviewing 前提: 存在未完成任务时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "reviewing" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("executing");
  });

  test("reviewing 前提: 以形状任务集为准，形状任务未登记（并非仅任务表内未 done）时仍被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "executing",
      shape: shapeInput("USER-000", {
        tasks: [
          { id: "task-a", roles: ["impl"] },
          { id: "task-b", roles: ["impl"] },
        ],
      }),
      tasks: {
        "task-a": { progress: "done", runId: null, description: "", agent: "", note: "", commit: "abc1234", reason: "", repairRound: 0 },
      },
    });
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "reviewing" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("executing");
  });

  test("accepting 前提: 结果 verdict 为 FAIL 时被拒绝", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(
      world.runStore,
      world.requirement,
      world.repo.root,
      reviewResult(world.requirement, world.currentVersion, world.repo.root, { verdict: "FAIL" }),
    );
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "accepting", runId, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("reviewing");
  });

  test("accepting 前提: 结果 phase 不是 review 时被拒绝", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, planResult(world.requirement, world.currentVersion, world.repo.root));
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "accepting", runId, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("reviewing");
  });

  test("accepted 前提: reportPath 与形状记录的 acceptanceReport 不一致时被拒绝", async () => {
    const world = await setupWorld();
    await toAccepting(world);
    const runId = await completedRun(
      world.runStore,
      world.requirement,
      world.repo.root,
      acceptanceResult(world.requirement, world.currentVersion, world.repo.root, "/reports/wrong-path.md"),
    );
    const state = await currentState(world);
    const result = await advanceStage(
      { expectedVersion: state.version, targetStage: "accepted", runId, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("accepting");
  });
});

describe("recordShape 门禁声明", () => {
  test("门禁声明为 false 且未附用户决定编号时记录形状被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const state = await currentState(world);
    const result = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(shapeDecisionId, { gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false }, skipped: [] }),
      },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.shape).toBeNull();
  });

  test("门禁声明为 false 且附用户决定编号时记录形状成功并记录跳过依据", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const skip = await appendDecision(
      userDecisionInput(world.requirement, { trigger: "跳过黑盒验收", decision: "本需求不做黑盒验收" }),
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    const state = await currentState(world);
    const result = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(shapeDecisionId, {
          gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false },
          skipped: [{ gate: "blackboxAcceptance", decisionId: skip.decisionId }],
        }),
      },
      world.ctx,
    );
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.shape?.gates).toEqual({ plan: true, whiteboxReview: true, blackboxAcceptance: false });
    expect(JSON.stringify(after.data)).toContain(skip.decisionId);
  });

  test("门禁跳过使用 AI 决定编号时被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const aiSkipId = await appendAiDecisionId(world, "AI 判断跳过黑盒验收", "AI 自行决定跳过黑盒验收");
    const state = await currentState(world);
    const result = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(shapeDecisionId, {
          gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false },
          skipped: [{ gate: "blackboxAcceptance", decisionId: aiSkipId }],
        }),
      },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.shape).toBeNull();
  });

  test("形状确认决定编号为 AI 编号时记录形状被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const aiDecisionId = await appendAiDecisionId(world, "AI 判断形状", "AI 自行确认任务集");
    const state = await currentState(world);
    const result = await recordShape({ expectedVersion: state.version, shape: shapeInput(aiDecisionId) }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.shape).toBeNull();
  });

  test("缺少形状确认决定编号时记录形状被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const shape = shapeInput(shapeDecisionId) as Record<string, unknown>;
    delete shape.decisionId;
    const state = await currentState(world);
    const result = await recordShape({ expectedVersion: state.version, shape }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.shape).toBeNull();
  });

  test("形状任务集为空时记录形状被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const state = await currentState(world);
    const result = await recordShape({ expectedVersion: state.version, shape: shapeInput(shapeDecisionId, { tasks: [] }) }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.shape).toBeNull();
  });
});

describe("越过黑盒验收门禁的推进路径", () => {
  test("形状声明不含黑盒验收且附决定时经 accepting 越过黑盒门禁推进到 accepted 并记录跳过依据", async () => {
    const world = await setupWorld();
    const skip = await appendDecision(
      userDecisionInput(world.requirement, { trigger: "跳过黑盒验收", decision: "本需求不做黑盒验收" }),
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    await toReviewing(world);
    const shapeDecisionId = await appendUserDecisionId(world, "重新确认形状", "跳过黑盒验收后重新确认形状");
    let state = await currentState(world);
    const shapeResult = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(shapeDecisionId, {
          gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false },
          skipped: [{ gate: "blackboxAcceptance", decisionId: skip.decisionId }],
        }),
      },
      world.ctx,
    );
    expect(shapeResult.ok).toBe(true);

    const reviewRunId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
    state = await currentState(world);
    const toAcceptingResult = await advanceStage(
      { expectedVersion: state.version, targetStage: "accepting", runId: reviewRunId, currentVersion: world.currentVersion },
      world.ctx,
    );
    expect(toAcceptingResult.ok).toBe(true);

    state = await currentState(world);
    const toAcceptedResult = await advanceStage({ expectedVersion: state.version, targetStage: "accepted" }, world.ctx);
    expect(toAcceptedResult.ok).toBe(true);

    const after = await currentState(world);
    expect(after.data.stage).toBe("accepted");
    expect(JSON.stringify(after.data)).toContain(skip.decisionId);
  });
});

describe("任务生命周期", () => {
  test("startTask 后任务进度为 doing 并记录 runId", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    const state = await currentState(world);
    const result = await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
    expect(after.data.tasks["task-a"]?.runId).toBe(workRun.id);
  });

  test("startTask 对已 failed 的任务允许重新启动为 doing", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const firstRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: firstRun.id }, world.ctx);
    state = await currentState(world);
    await failTask({ expectedVersion: state.version, taskId: "task-a", runId: firstRun.id, reason: "首次尝试失败" }, world.ctx);
    const retryRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    state = await currentState(world);
    const result = await startTask({ expectedVersion: state.version, taskId: "task-a", runId: retryRun.id }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
    expect(after.data.tasks["task-a"]?.runId).toBe(retryRun.id);
  });

  test("finishTask 仅有运行启动回执（未完成）时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 delivery.verificationOk=false 时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const commit = await repoHeadCommit(world.repo.root);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, commit, { delivery: { commit, verificationOk: false } }),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 changedFiles 非空但 commit 在仓库中不存在时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const missingCommit = "0".repeat(40);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, missingCommit),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 changedFiles 非空且 commit 存在于绑定 cwd 仓库时完成任务", async () => {
    const world = await setupWorld();
    await toTaskDone(world);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("done");
  });

  test("finishTask 在 changedFiles 为空且 workState=green-baseline-no-change 且有既有证据时完成任务", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "", {
        changedFiles: [],
        workState: "green-baseline-no-change",
        preexistingEvidence: ["既有测试 tests/x.test.ts 已覆盖该行为"],
        delivery: { commit: "", verificationOk: true },
      }),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("done");
  });

  test("finishTask 在 changedFiles 为空但缺少既有证据时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "", {
        changedFiles: [],
        workState: "green-baseline-no-change",
        preexistingEvidence: [],
        delivery: { commit: "", verificationOk: true },
      }),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 changedFiles 为空但 workState 不是 green-baseline-no-change 时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "", {
        changedFiles: [],
        workState: "red-green",
        preexistingEvidence: ["既有实现已满足"],
        delivery: { commit: "", verificationOk: true },
      }),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在结果绑定另一任务时被拒绝并说明不匹配项", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const commit = await repoHeadCommit(world.repo.root);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-b", world.currentVersion, world.repo.root, commit),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 结果 verdict 为 FAIL 时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const commit = await repoHeadCommit(world.repo.root);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, commit, { verdict: "FAIL" }),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 commit 为 HEAD 时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "HEAD"),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 commit 为分支名时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "main"),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 commit 为非十六进制字符串时被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, "zzzzzzz"),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 commit 不足 7 位十六进制时被拒绝（即便能被 git 解析为缩写）", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const shortCommit = (await repoHeadCommit(world.repo.root)).slice(0, 6);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, world.repo.root, shortCommit),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("finishTask 在 binding.cwd 指向本需求仓库之外时被拒绝，即便提交在该仓库中存在", async () => {
    const world = await setupWorld();
    const otherRepo = await createRepoFixture();
    repoFixtures.push(otherRepo);
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    const otherCommit = await repoHeadCommit(otherRepo.root);
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: workResult(world.requirement, "task-a", world.currentVersion, otherRepo.root, otherCommit),
    });
    state = await currentState(world);
    const result = await finishTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, currentVersion: world.currentVersion }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("failTask 记录 failed 与原因并累加返修轮次", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    state = await currentState(world);
    const result = await failTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, reason: "测试断言未覆盖边界" }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("failed");
    expect(after.data.tasks["task-a"]?.reason).toBe("测试断言未覆盖边界");
    expect(after.data.tasks["task-a"]?.repairRound).toBe(1);
  });
});

describe("任务进度回滚 rollbackTask", () => {
  test("failed → todo 回滚在原运行未停止时被拒绝，附决定编号且运行已停止后成功", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    state = await currentState(world);
    await failTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, reason: "外部检测到失败" }, world.ctx);

    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "回滚任务", decision: "允许重试任务 task-a" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });

    state = await currentState(world);
    const withoutDecision = await rollbackTask({ expectedVersion: state.version, taskId: "task-a" }, world.ctx);
    expect(withoutDecision.ok).toBe(false);

    state = await currentState(world);
    const whileActive = await rollbackTask({ expectedVersion: state.version, taskId: "task-a", decisionId: decision.decisionId }, world.ctx);
    expect(whileActive.ok).toBe(false);
    let after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("failed");

    await world.runStore.update(workRun.id, { state: "stopped" });
    state = await currentState(world);
    const afterStopped = await rollbackTask({ expectedVersion: state.version, taskId: "task-a", decisionId: decision.decisionId }, world.ctx);
    expect(afterStopped.ok).toBe(true);
    after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("todo");
  });

  test("accepted 需求禁止 rollbackTask", async () => {
    const world = await setupWorld();
    await toAccepted(world);
    const state = await currentState(world);
    const result = await rollbackTask({ expectedVersion: state.version, taskId: "task-a", decisionId: "USER-001" }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("accepted");
  });

  test("rollbackTask 使用 AI 决定编号被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    let state = await currentState(world);
    await startTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id }, world.ctx);
    await world.runStore.update(workRun.id, { state: "running" });
    state = await currentState(world);
    await failTask({ expectedVersion: state.version, taskId: "task-a", runId: workRun.id, reason: "外部检测到失败" }, world.ctx);
    await world.runStore.update(workRun.id, { state: "stopped" });
    const aiDecisionId = await appendAiDecisionId(world, "AI 判断可重试", "AI 自行允许回滚任务 task-a");
    state = await currentState(world);
    const result = await rollbackTask({ expectedVersion: state.version, taskId: "task-a", decisionId: aiDecisionId }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("failed");
  });

  test("rollbackTask 对已中断（interrupted）原运行应允许回滚（done → todo）", async () => {
    const world = await setupWorld();
    const runId = await interruptedRun(world);
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "executing",
      shape: shapeInput("USER-000"),
      tasks: {
        "task-a": { progress: "done", runId, description: "", agent: "", note: "", commit: "abc1234", reason: "", repairRound: 0 },
      },
    });
    const decisionId = await appendUserDecisionId(world, "回滚已完成任务", "允许重试任务 task-a");
    const state = await currentState(world);
    const result = await rollbackTask({ expectedVersion: state.version, taskId: "task-a", decisionId }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("todo");
  });
});

describe("受控回退 retreatStage", () => {
  test("planned → confirmed 在原 plan 运行终态且附理由与决定编号时成功", async () => {
    const world = await setupWorld();
    const planRunId = await toPlanned(world);
    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "范围调整", decision: "退回确认阶段重议范围" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", decisionId: decision.decisionId, runId: planRunId },
      world.ctx,
    );
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("confirmed");
  });

  test("原运行仍处于活动状态时回退被拒绝", async () => {
    const world = await setupWorld();
    await toPlanned(world);
    const activeRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(activeRun.id, { state: "running" });
    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "范围调整", decision: "退回确认阶段重议范围" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", decisionId: decision.decisionId, runId: activeRun.id },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("缺决定编号时回退被拒绝", async () => {
    const world = await setupWorld();
    const planRunId = await toPlanned(world);
    const state = await currentState(world);
    const result = await retreatStage({ expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", runId: planRunId }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("accepted 需求禁止任何回退", async () => {
    const world = await setupWorld();
    await toAccepted(world);
    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "回退请求", decision: "尝试回退已验收需求" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "executing", reason: "尝试回退", decisionId: decision.decisionId },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("accepted");
  });

  test("不在允许路径内的回退（executing → planned）被拒绝", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "回退请求", decision: "尝试越级回退" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "planned", reason: "尝试越级回退", decisionId: decision.decisionId },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("executing");
  });

  test("retreatStage 使用 AI 决定编号被拒绝", async () => {
    const world = await setupWorld();
    const planRunId = await toPlanned(world);
    const aiDecisionId = await appendAiDecisionId(world, "AI 判断范围调整", "AI 自行决定退回确认阶段");
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", decisionId: aiDecisionId, runId: planRunId },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("存在未停止的运行时回退被拒绝且原因列出该运行标识，调用方另传已停止的 runId 也无效", async () => {
    const world = await setupWorld();
    const activeRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(activeRun.id, { state: "running" });
    const stoppedRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(stoppedRun.id, { state: "running" });
    await world.runStore.update(stoppedRun.id, { state: "stopped" });
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "planned",
      shape: null,
      tasks: {},
      history: [{ stage: "planned", at: new Date().toISOString(), runId: activeRun.id, decisionId: null, reason: null }],
    });
    const decisionId = await appendUserDecisionId(world, "范围调整", "退回确认阶段重议范围");
    const state = await currentState(world);
    const result = await retreatStage(
      { expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", decisionId, runId: stoppedRun.id },
      world.ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(activeRun.id);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("history 中该阶段登记的原运行为 interrupted 时应允许回退，无需调用方另传 runId", async () => {
    const world = await setupWorld();
    const runId = await interruptedRun(world);
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "planned",
      shape: null,
      tasks: {},
      history: [{ stage: "planned", at: new Date().toISOString(), runId, decisionId: null, reason: null }],
    });
    const decisionId = await appendUserDecisionId(world, "范围调整", "退回确认阶段重议范围");
    const state = await currentState(world);
    const result = await retreatStage({ expectedVersion: state.version, targetStage: "confirmed", reason: "范围调整", decisionId }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("confirmed");
  });

  test("reviewing → executing 回退在 history 登记的原运行为终态时成功", async () => {
    const world = await setupWorld();
    const doneRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(doneRun.id, { state: "running" });
    await world.runStore.update(doneRun.id, { state: "completed", result: { phase: "work", verdict: "PASS" } });
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "reviewing",
      shape: shapeInput("USER-000"),
      tasks: {},
      history: [{ stage: "reviewing", at: new Date().toISOString(), runId: doneRun.id, decisionId: null, reason: null }],
    });
    const decisionId = await appendUserDecisionId(world, "reviewing 回退", "退回 executing 补充修复");
    const state = await currentState(world);
    const result = await retreatStage({ expectedVersion: state.version, targetStage: "executing", reason: "补充修复", decisionId }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("executing");
  });

  test("accepting → executing 回退在 history 登记的原运行为终态时成功", async () => {
    const world = await setupWorld();
    const doneRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(doneRun.id, { state: "running" });
    await world.runStore.update(doneRun.id, { state: "completed", result: { phase: "review", verdict: "PASS" } });
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "accepting",
      shape: shapeInput("USER-000"),
      tasks: {},
      history: [{ stage: "accepting", at: new Date().toISOString(), runId: doneRun.id, decisionId: null, reason: null }],
    });
    const decisionId = await appendUserDecisionId(world, "accepting 回退", "退回 executing 补充修复");
    const state = await currentState(world);
    const result = await retreatStage({ expectedVersion: state.version, targetStage: "executing", reason: "补充修复", decisionId }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("executing");
  });
});

describe("版本化与并发", () => {
  test("两个调用方读取同一 version 后先后更新，后者得到版本冲突", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const decision = await appendDecision(userDecisionInput(world.requirement), { dataRoot: world.home.dataRoot, cwd: world.repo.root });
    const readA = await currentState(world);
    const readB = await currentState(world);

    const first = await advanceStage({ expectedVersion: readA.version, targetStage: "confirmed", decisionId: decision.decisionId }, world.ctx);
    expect(first.ok).toBe(true);

    const second = await advanceStage({ expectedVersion: readB.version, targetStage: "confirmed", decisionId: decision.decisionId }, world.ctx);
    expect(second.ok).toBe(false);
  });

  test("版本冲突时 updateTaskFields 第二次调用结果携带 staleVersion:true", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const readA = await currentState(world);
    const readB = await currentState(world);

    const first = await updateTaskFields({ expectedVersion: readA.version, taskId: "task-a", fields: { note: "第一次更新" } }, world.ctx);
    expect(first.ok).toBe(true);

    const second = await updateTaskFields({ expectedVersion: readB.version, taskId: "task-a", fields: { note: "第二次更新" } }, world.ctx);
    expect(second.ok).toBe(false);
    if (!second.ok) expect((second as { staleVersion?: boolean }).staleVersion).toBe(true);
  });

  test("非版本冲突的失败（缺决定编号）结果不携带 staleVersion", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "confirmed" }, world.ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result as { staleVersion?: boolean }).staleVersion).toBeUndefined();
  });

  test("版本冲突失败原因只陈述事实，不包含操作提示", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const readA = await currentState(world);
    const readB = await currentState(world);

    await updateTaskFields({ expectedVersion: readA.version, taskId: "task-a", fields: { note: "第一次更新" } }, world.ctx);
    const second = await updateTaskFields({ expectedVersion: readB.version, taskId: "task-a", fields: { note: "第二次更新" } }, world.ctx);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain("版本已变化");
      expect(second.reason).not.toContain("请重新读取后重试");
    }
  });
});

describe("证据绑定与核对", () => {
  test("bindEvidence 写入证据文件后 checkEvidence 通过", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
    const bound = await bindEvidence({ stage: "review", runId, currentVersion: world.currentVersion }, world.ctx);
    expect(bound.ok).toBe(true);
    const checked = await checkEvidence({ stage: "review", currentVersion: world.currentVersion }, world.ctx);
    expect(checked.ok).toBe(true);
  });

  test("绑定后定义指纹变化，checkEvidence 返回待重新核对", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
    await bindEvidence({ stage: "review", runId, currentVersion: world.currentVersion }, world.ctx);
    const changedFingerprint = { definitionFingerprint: "fp-2", codeHead: world.currentVersion.codeHead };
    const checked = await checkEvidence({ stage: "review", currentVersion: changedFingerprint }, world.ctx);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("重新核对");
  });
});

describe("续接核对 checkResume", () => {
  test("状态文档缺失时返回明确阻塞", async () => {
    const world = await setupWorld();
    const result = await checkResume(world.ctx);
    expect(result.ok).toBe(false);
  });

  test("状态文档损坏时返回明确阻塞", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    await writeFile(statePath(world.home.dataRoot, world.identity.repoId, world.requirement), "not-json{{{", "utf8");
    const result = await checkResume(world.ctx);
    expect(result.ok).toBe(false);
  });

  test("任务处于 doing 但关联运行未停止时返回明确阻塞，不把任务初始化为完成", async () => {
    const world = await setupWorld();
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "task-a"));
    await world.runStore.update(run.id, { state: "running" });
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "executing",
      shape: shapeInput("USER-000"),
      tasks: { "task-a": { progress: "doing", runId: run.id, repairRound: 0 } },
    });
    const result = await checkResume(world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("doing");
  });

  test("无阻塞条件时返回成功", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const result = await checkResume(world.ctx);
    expect(result.ok).toBe(true);
  });

  test("成功时返回状态文档当前版本 version", async () => {
    const world = await setupWorld();
    const created = await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const result = await checkResume(world.ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result as { version?: number }).version).toBe(created.version);
  });

  test("已绑定证据与传入当前版本不一致时返回阻塞并说明待重新核对", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
    await bindEvidence({ stage: "review", runId, currentVersion: world.currentVersion }, world.ctx);
    const changedVersion = { definitionFingerprint: "fp-changed", codeHead: world.currentVersion.codeHead };
    const result = await checkResume(world.ctx, changedVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("待重新核对");
  });
});

describe("读盘失败时的行为", () => {
  test("state.json 损坏时 advanceStage 返回 ok:false 而不是抛出", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    await writeFile(statePath(world.home.dataRoot, world.identity.repoId, world.requirement), "not-json{{{", "utf8");
    let threw = false;
    let result: Awaited<ReturnType<typeof advanceStage>> | undefined;
    try {
      result = await advanceStage({ expectedVersion: 1, targetStage: "confirmed", decisionId: "USER-001" }, world.ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  test("state.json 损坏时 finishTask 返回 ok:false 而不是抛出", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    await writeFile(statePath(world.home.dataRoot, world.identity.repoId, world.requirement), "not-json{{{", "utf8");
    let threw = false;
    let result: Awaited<ReturnType<typeof finishTask>> | undefined;
    try {
      result = await finishTask(
        { expectedVersion: 1, taskId: "task-a", runId: "irrelevant", currentVersion: world.currentVersion },
        world.ctx,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  test("state.json 损坏时 startTask 返回 ok:false 而不是抛出", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    await writeFile(statePath(world.home.dataRoot, world.identity.repoId, world.requirement), "not-json{{{", "utf8");
    let threw = false;
    let result: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      result = await startTask({ expectedVersion: 1, taskId: "task-a", runId: "irrelevant" }, world.ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  test("证据文件损坏时 checkEvidence 返回 ok:false 且 reason 含待重新核对，而不是抛出", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const runId = await completedRun(world.runStore, world.requirement, world.repo.root, reviewResult(world.requirement, world.currentVersion, world.repo.root));
    await bindEvidence({ stage: "review", runId, currentVersion: world.currentVersion }, world.ctx);
    const evidenceFilePath = `${requirementDataDir(world.home.dataRoot, world.identity.repoId, world.requirement)}/evidence/review.json`;
    await writeFile(evidenceFilePath, "not-json{{{", "utf8");
    let threw = false;
    let result: Awaited<ReturnType<typeof checkEvidence>> | undefined;
    try {
      result = await checkEvidence({ stage: "review", currentVersion: world.currentVersion }, world.ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.reason).toContain("待重新核对");
  });
});

describe("跳过 plan / whiteboxReview 门禁的推进路径", () => {
  test("形状声明跳过 plan 门禁且附决定时 confirmed → planned 无需运行证据", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const skipDecisionId = await appendUserDecisionId(world, "跳过 plan 门禁", "本需求跳过 plan 审阅");
    const shapeDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明（跳过 plan）");
    let state = await currentState(world);
    const shapeResult = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(shapeDecisionId, {
          gates: { plan: false, whiteboxReview: true, blackboxAcceptance: true },
          skipped: [{ gate: "plan", decisionId: skipDecisionId }],
        }),
      },
      world.ctx,
    );
    expect(shapeResult.ok).toBe(true);

    const confirmDecisionId = await appendUserDecisionId(world, "确认范围", "确认按现有范围推进");
    state = await currentState(world);
    const confirmed = await advanceStage({ expectedVersion: state.version, targetStage: "confirmed", decisionId: confirmDecisionId }, world.ctx);
    expect(confirmed.ok).toBe(true);

    state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "planned" }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("planned");
  });

  test("形状声明跳过 whiteboxReview 门禁且附决定时 reviewing → accepting 无需运行证据", async () => {
    const world = await setupWorld();
    await toReviewing(world);
    const skipDecisionId = await appendUserDecisionId(world, "跳过白盒评审", "本需求跳过白盒评审");
    const reshapeDecisionId = await appendUserDecisionId(world, "重新确认形状", "跳过白盒评审后重新确认形状");
    let state = await currentState(world);
    const shapeResult = await recordShape(
      {
        expectedVersion: state.version,
        shape: shapeInput(reshapeDecisionId, {
          gates: { plan: true, whiteboxReview: false, blackboxAcceptance: true },
          skipped: [{ gate: "whiteboxReview", decisionId: skipDecisionId }],
        }),
      },
      world.ctx,
    );
    expect(shapeResult.ok).toBe(true);

    state = await currentState(world);
    const result = await advanceStage({ expectedVersion: state.version, targetStage: "accepting" }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("accepting");
  });
});

describe("updateTaskFields", () => {
  test("拒绝未知字段", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const state = await currentState(world);
    const result = await updateTaskFields({ expectedVersion: state.version, taskId: "task-a", fields: { unknownField: "x" } }, world.ctx);
    expect(result.ok).toBe(false);
  });

  test("拒绝把 stage 或 progress 混入字段更新", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const state = await currentState(world);
    const result = await updateTaskFields({ expectedVersion: state.version, taskId: "task-a", fields: { progress: "done" } }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.progress).toBe("todo");
  });

  test("接受 note/agent/commit/description 与 followUps 更新", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const state = await currentState(world);
    const result = await updateTaskFields(
      {
        expectedVersion: state.version,
        taskId: "task-a",
        fields: { note: "备注", agent: "impl-engineer", commit: "abc1234", description: "描述" },
        followUps: ["跟进事项"],
      },
      world.ctx,
    );
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.note).toBe("备注");
    expect(after.data.followUps).toEqual(["跟进事项"]);
  });

  test("接受 blockedReason 与 workspaceDir 更新并写入任务记录", async () => {
    const world = await setupWorld();
    await toExecuting(world);
    const state = await currentState(world);
    const result = await updateTaskFields(
      {
        expectedVersion: state.version,
        taskId: "task-a",
        fields: { blockedReason: "等待外部审批", workspaceDir: "/tmp/task-a-workspace" },
      },
      world.ctx,
    );
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.tasks["task-a"]?.blockedReason).toBe("等待外部审批");
    expect(after.data.tasks["task-a"]?.workspaceDir).toBe("/tmp/task-a-workspace");
  });
});

describe("initRequirementState", () => {
  test("需求状态已存在时初始化被拒绝", async () => {
    const world = await setupWorld();
    const first = await initRequirementState(world.ctx);
    expect(first.ok).toBe(true);
    const second = await initRequirementState(world.ctx);
    expect(second.ok).toBe(false);
  });
});

describe("rejectRequirement", () => {
  test("无用户决定编号时被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await currentState(world);
    const result = await rejectRequirement({ expectedVersion: state.version }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
  });

  test("附用户裁决决定编号时置为 rejected", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const decision = await appendDecision(userDecisionInput(world.requirement, { trigger: "裁决", decision: "拒绝本需求" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const state = await currentState(world);
    const result = await rejectRequirement({ expectedVersion: state.version, decisionId: decision.decisionId }, world.ctx);
    expect(result.ok).toBe(true);
    const after = await currentState(world);
    expect(after.data.stage).toBe("rejected");
  });

  test("使用 AI 决定编号裁决时被拒绝", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const aiDecisionId = await appendAiDecisionId(world, "AI 裁决", "AI 自行判断拒绝需求");
    const state = await currentState(world);
    const result = await rejectRequirement({ expectedVersion: state.version, decisionId: aiDecisionId }, world.ctx);
    expect(result.ok).toBe(false);
    const after = await currentState(world);
    expect(after.data.stage).toBe("draft");
  });
});
