import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity, requirementDataDir } from "../runtime/identity.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createDocument, readDocument } from "../runtime/store.ts";
import { createWorkflowTool, currentVersion, executeWorkflowAction, retryOnStaleVersion } from "../runtime/workflow-tool.ts";
import workflowExtension from "../extensions/workflow.ts";

const execFileAsync = promisify(execFile);
const REQUIREMENT = "2026-09-09.workflow-tool-demo";

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
  tasks: Record<string, { progress: string; runId?: string | null; [key: string]: unknown }>;
  followUps: unknown[];
  history: unknown[];
}

interface World {
  home: Awaited<ReturnType<typeof createTempHome>>;
  repo: Awaited<ReturnType<typeof createRepoFixture>>;
  identity: Awaited<ReturnType<typeof repositoryIdentity>>;
  requirement: string;
  tool: ReturnType<typeof createWorkflowTool>;
  runStore: RunStore;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAbsolutePath(text: string, repoRoot?: string): boolean {
  if (repoRoot && text.includes(repoRoot)) return true;
  return /\/(?!\.+\/)[A-Za-z0-9_.-]+\//.test(text);
}

function expectSuccessText(text: string, requirement: string, action: string): void {
  const pattern = new RegExp(`^${escapeRegExp(requirement)} ${action} 成功：.+，version \\d+$`);
  expect(text).toMatch(pattern);
}

function createFakePi() {
  const registered: Array<{ name: string; [key: string]: unknown }> = [];
  const pi = {
    registerTool(tool: { name: string; [key: string]: unknown }) {
      registered.push(tool);
    },
    on() {},
  };
  return { pi, registered };
}

function fakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    ui: {} as ExtensionContext["ui"],
    mode: "print",
    hasUI: false,
    cwd: "/",
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    ...overrides,
  } as ExtensionContext;
}

function statePath(dataRoot: string, repoId: string, requirement: string): string {
  return `${requirementDataDir(dataRoot, repoId, requirement)}/state.json`;
}

async function seedState(dataRoot: string, repoId: string, requirement: string, overrides: Record<string, unknown> = {}) {
  const initial: StateDoc = { requirement, stage: "draft", shape: null, tasks: {}, followUps: [], history: [], ...overrides };
  return createDocument(statePath(dataRoot, repoId, requirement), initial);
}

async function readRawState(dataRoot: string, repoId: string, requirement: string): Promise<{ version: number; data: StateDoc }> {
  const result = await readDocument(statePath(dataRoot, repoId, requirement));
  if (!result.exists) throw new Error("测试装置失败: 期望状态文档存在");
  return { version: result.version, data: result.data as StateDoc };
}

function userDecisionInput(requirement: string, overrides: Record<string, unknown> = {}) {
  return {
    requirement,
    actor: "user" as const,
    source: "workflow-tool-test",
    trigger: "确认",
    decision: "确认",
    alternatives: [],
    effects: ["scope"],
    impact: "无重大影响",
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

async function repoHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

async function setupWorld(requirement: string = REQUIREMENT): Promise<World> {
  const home = await createTempHome();
  tempHomes.push(home);
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  const identity = await repositoryIdentity(repo.root);
  const tool = createWorkflowTool({ dataRoot: home.dataRoot, cwd: repo.root });
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: new Date().toISOString() });
  return { home, repo, identity, requirement, tool, runStore };
}

async function call(world: World, params: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await world.tool.execute("call-1", params, undefined, undefined, fakeCtx({ cwd: world.repo.root }));
  return {
    text: (result.content[0] as { text: string }).text,
    details: result.details as Record<string, unknown>,
  };
}

// 业务失败现在以抛出表达（SDK 只把抛出识别为 isError），需要断言失败原因文本时先捕获异常
async function callExpectingError(world: World, params: Record<string, unknown>): Promise<Error> {
  try {
    await call(world, params);
  } catch (error) {
    return error as Error;
  }
  throw new Error("测试装置失败: 期望抛出但未抛出");
}

describe("pi_company_workflow 工具", () => {
  test("createWorkflowTool 返回名为 pi_company_workflow 的工具定义", () => {
    const tool = createWorkflowTool({ dataRoot: "/tmp/pi-company-schema-only", cwd: "/tmp/pi-company-schema-only" });
    expect(tool.name).toBe("pi_company_workflow");
  });
});

describe("pi_company_workflow 参数 schema", () => {
  const schemaTool = createWorkflowTool({ dataRoot: "/tmp/pi-company-schema-only", cwd: "/tmp/pi-company-schema-only" });

  function baseParams(overrides: Record<string, unknown> = {}) {
    return { action: "query", requirement: REQUIREMENT, ...overrides };
  }

  test("顶层 additionalProperties 为 false", () => {
    expect((schemaTool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  test("合法 query 参数通过 schema 校验", () => {
    expect(Value.Check(schemaTool.parameters, baseParams())).toBe(true);
  });

  test("未知顶层字段的参数被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ bogusField: "x" }))).toBe(false);
  });

  test("不在允许集合中的 action 被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ action: "unknown-action" }))).toBe(false);
  });

  test("task 不匹配 ^T-\\d+$ 时被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ task: "bad-task" }))).toBe(false);
  });

  test("task 匹配 ^T-\\d+$ 时通过 schema 校验", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ task: "T-1" }))).toBe(true);
  });

  test("decisionId 不匹配 ^(AI|USER)-\\d+$ 时被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ decisionId: "BAD-1" }))).toBe(false);
  });

  test("version 小于 1 时被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ version: 0 }))).toBe(false);
  });

  test("update 含未知字段时被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ update: { bogusField: "x" } }))).toBe(false);
  });

  test("含 evidence 未定义字段的参数被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ evidence: { verdict: "PASS" } }))).toBe(false);
  });

  test("含 shape 未定义字段的参数被 schema 拒绝", () => {
    expect(Value.Check(schemaTool.parameters, baseParams({ shape: { tasks: [] } }))).toBe(false);
  });
});

describe("init 与 query", () => {
  test("init 成功后 query 返回 stage draft 与 version 1", async () => {
    const world = await setupWorld();
    const initResult = await call(world, { action: "init", requirement: world.requirement });
    expect(initResult.details.isError).toBeFalsy();

    const queryResult = await call(world, { action: "query", requirement: world.requirement });
    expect(queryResult.details.isError).toBeFalsy();
    const data = queryResult.details.data as { stage: string };
    expect(data.stage).toBe("draft");
    expect(queryResult.details.version).toBe(1);
  });

  test('query 指定 fields:["stage"] 时只返回阶段字段', async () => {
    const world = await setupWorld();
    await call(world, { action: "init", requirement: world.requirement });

    const queryResult = await call(world, { action: "query", requirement: world.requirement, fields: ["stage"] });
    expect(queryResult.details.data).toEqual({ stage: "draft" });
  });
});

describe("update 字段更新", () => {
  function seedWithTaskA(world: World) {
    return seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      tasks: { "T-1": { progress: "todo", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 } },
    });
  }

  test("只提交 note 与正确 version 时更新成功，回执含需求、note 与新版本，不含整份状态", async () => {
    const world = await setupWorld();
    await seedWithTaskA(world);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "update",
      requirement: world.requirement,
      task: "T-1",
      version: before.version,
      update: { note: "备注A" },
    });

    expect(result.details.isError).toBeFalsy();
    expectSuccessText(result.text, world.requirement, "update");
    expect(result.text).toContain("note");
    expect(result.text).not.toContain("history");
    expect(result.text).not.toContain("repairRound");

    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.note).toBe("备注A");
    expect(after.version).toBe(before.version + 1);
  });

  test("update 含未知字段时整个请求不生效，note 未写入", async () => {
    const world = await setupWorld();
    await seedWithTaskA(world);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "update",
        requirement: world.requirement,
        task: "T-1",
        version: before.version,
        update: { note: "备注A", bogusField: "x" },
      }),
    ).rejects.toThrow(/不允许|参数不合法|additional properties/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.note).toBe("");
  });

  test("update 混入 stage 字段时整个请求不生效，note 未写入", async () => {
    const world = await setupWorld();
    await seedWithTaskA(world);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "update",
        requirement: world.requirement,
        task: "T-1",
        version: before.version,
        update: { note: "备注A", stage: "accepted" },
      }),
    ).rejects.toThrow(/不允许|参数不合法|additional properties/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.note).toBe("");
  });

  test("followUpIssues 追加成功且任务表不变", async () => {
    const world = await setupWorld();
    await seedWithTaskA(world);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "update",
      requirement: world.requirement,
      version: before.version,
      update: { followUpIssues: ["跟进事项A"] },
    });

    expect(result.details.isError).toBeFalsy();
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.followUps).toContain("跟进事项A");
    expect(after.data.tasks["T-1"]).toEqual(before.data.tasks["T-1"]);
  });
});

describe("版本冲突与重试", () => {
  test("两调用方基于同一 version 先后 update：第二次失败并提示重新查询后重试，第一次内容保留", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      tasks: { "T-1": { progress: "todo", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 } },
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const ctx = { dataRoot: world.home.dataRoot, cwd: world.repo.root };

    const first = await executeWorkflowAction(
      { action: "update", requirement: world.requirement, task: "T-1", version: state.version, update: { note: "A的备注" } },
      ctx,
    );
    expect(first.ok).toBe(true);

    const second = await executeWorkflowAction(
      { action: "update", requirement: world.requirement, task: "T-1", version: state.version, update: { note: "B的备注" } },
      ctx,
    );
    expect(second.ok).toBe(false);
    expect(second.text).toContain("请重新查询后重试");

    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.note).toBe("A的备注");
  });

  test("retryOnStaleVersion 在版本交错下成功，两次调用的跟进事项都保留", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const ctx = { dataRoot: world.home.dataRoot, cwd: world.repo.root };

    let callbackRuns = 0;
    const result = await retryOnStaleVersion(ctx, world.requirement, async (state: { version: number }) => {
      callbackRuns++;
      if (callbackRuns === 1) {
        const conflicting = await executeWorkflowAction(
          { action: "update", requirement: world.requirement, version: state.version, update: { followUpIssues: ["调用方B跟进"] } },
          ctx,
        );
        expect(conflicting.ok).toBe(true);
      }
      return { followUpIssues: ["调用方A跟进"] };
    });

    expect(result.ok).toBe(true);
    expect(callbackRuns).toBe(2);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.followUps).toContain("调用方A跟进");
    expect(after.data.followUps).toContain("调用方B跟进");
  });
});

describe("advance 阶段推进到 accepted", () => {
  function seedAccepting(world: World) {
    return seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "accepting",
      shape: {
        tasks: [{ id: "T-1", roles: ["impl"] }],
        gates: { plan: true, whiteboxReview: true, blackboxAcceptance: true },
        skipped: [],
        acceptanceReport: "/reports/x.md",
        decisionId: "USER-000",
      },
    });
  }

  test("runId 指向的运行未完成（无验收结果）时失败", async () => {
    const world = await setupWorld();
    await seedAccepting(world);
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(run.id, { state: "running" });

    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    await expect(
      call(world, {
        action: "advance",
        requirement: world.requirement,
        stage: "accepted",
        runId: run.id,
        version: state.version,
      }),
    ).rejects.toThrow(/运行未完成/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("accepting");
  });

  test("runId 指向的运行结果绑定另一需求时失败回执列出不匹配", async () => {
    const world = await setupWorld();
    await seedAccepting(world);
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(run.id, { state: "running" });
    await world.runStore.update(run.id, {
      state: "completed",
      result: {
        phase: "acceptance",
        verdict: "PASS",
        acceptanceResult: "accepted",
        reportPath: "/reports/x.md",
        binding: { requirement: "2026-09-09.other-requirement", definitionFingerprint: "fp-x", codeHead: "head-x", cwd: world.repo.root },
      },
    });

    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const error = await callExpectingError(world, {
      action: "advance",
      requirement: world.requirement,
      stage: "accepted",
      runId: run.id,
      version: state.version,
    });

    expect(error.message).toContain("不一致");
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("accepting");
  });

  test("runId 指向的运行结果绑定旧版本时失败回执列出不匹配", async () => {
    const world = await setupWorld();
    await seedAccepting(world);
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(run.id, { state: "running" });
    await world.runStore.update(run.id, {
      state: "completed",
      result: {
        phase: "acceptance",
        verdict: "PASS",
        acceptanceResult: "accepted",
        reportPath: "/reports/x.md",
        binding: { requirement: world.requirement, definitionFingerprint: "outdated-fingerprint", codeHead: "outdated-head", cwd: world.repo.root },
      },
    });

    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const error = await callExpectingError(world, {
      action: "advance",
      requirement: world.requirement,
      stage: "accepted",
      runId: run.id,
      version: state.version,
    });

    expect(error.message).toContain("不一致");
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("accepting");
  });
});

describe("retreat 受控回退", () => {
  test("reviewing → executing 附 reason 与 decisionId 成功", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, { stage: "reviewing" });
    const decisionId = await appendUserDecisionId(world, "reviewing 回退", "退回 executing 补充修复");
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "retreat",
      requirement: world.requirement,
      stage: "executing",
      reason: "补充修复",
      decisionId,
      version: state.version,
    });

    expect(result.details.isError).toBeFalsy();
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("executing");
  });

  test("缺 decisionId 时回退失败", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, { stage: "reviewing" });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "retreat",
        requirement: world.requirement,
        stage: "executing",
        reason: "补充修复",
        version: state.version,
      }),
    ).rejects.toThrow(/缺少决定编号/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("reviewing");
  });

  test("目标阶段不在允许回退路径内时失败", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, { stage: "executing" });
    const decisionId = await appendUserDecisionId(world, "越级回退", "尝试越级回退");
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "retreat",
        requirement: world.requirement,
        stage: "planned",
        reason: "尝试越级回退",
        decisionId,
        version: state.version,
      }),
    ).rejects.toThrow(/不允许从/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("executing");
  });
});

describe("reject 裁决", () => {
  test("无 decisionId 时失败", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(call(world, { action: "reject", requirement: world.requirement, version: state.version })).rejects.toThrow(
      /缺少用户裁决决定编号/,
    );
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.stage).toBe("draft");
  });
});

describe("task-finish 任务完成", () => {
  test("runId 指向的运行未完成（缺交付证据）时失败", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "executing",
      tasks: { "T-1": { progress: "doing", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 } },
    });
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "T-1"));
    await world.runStore.update(workRun.id, { state: "running" });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "task-finish",
        requirement: world.requirement,
        task: "T-1",
        runId: workRun.id,
        version: state.version,
      }),
    ).rejects.toThrow(/运行未完成/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.progress).toBe("doing");
  });

  test("证据齐全时成功，任务变为 done", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      stage: "executing",
      tasks: { "T-1": { progress: "doing", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 } },
    });
    const commit = await repoHeadCommit(world.repo.root);
    const version = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });
    const workRun = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "T-1"));
    await world.runStore.update(workRun.id, { state: "running" });
    await world.runStore.update(workRun.id, {
      state: "completed",
      result: {
        phase: "work",
        verdict: "PASS",
        changedFiles: ["a.ts"],
        workState: "red-green",
        preexistingEvidence: [],
        binding: { requirement: world.requirement, task: "T-1", ...version, cwd: world.repo.root },
        delivery: { commit, verificationOk: true },
      },
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "task-finish",
      requirement: world.requirement,
      task: "T-1",
      runId: workRun.id,
      version: state.version,
    });

    expect(result.details.isError).toBeFalsy();
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.tasks["T-1"]?.progress).toBe("done");
  });
});

describe("shape-confirm 形状确认", () => {
  async function createPlanRunWithProposedShape(world: World, proposedShape: Record<string, unknown>): Promise<string> {
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root));
    await world.runStore.update(run.id, { state: "running" });
    await world.runStore.update(run.id, {
      state: "completed",
      result: {
        phase: "plan",
        verdict: "PASS",
        summary: "计划完成",
        proposedShape,
        binding: { requirement: world.requirement, definitionFingerprint: "irrelevant", codeHead: "irrelevant", cwd: world.repo.root },
      },
    });
    return run.id;
  }

  test("形状不含黑盒验收且无跳过决定时失败", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const confirmDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const runId = await createPlanRunWithProposedShape(world, {
      tasks: [{ id: "T-1", roles: ["impl"] }],
      gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false },
      skipped: [],
      acceptanceReport: "/reports/x.md",
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "shape-confirm",
        requirement: world.requirement,
        runId,
        decisionId: confirmDecisionId,
        version: state.version,
      }),
    ).rejects.toThrow(/声明为跳过但缺少用户决定编号/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.shape).toBeNull();
  });

  test("附决定时成功", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const skipDecisionId = await appendUserDecisionId(world, "跳过黑盒验收", "本需求不做黑盒验收");
    const confirmDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const runId = await createPlanRunWithProposedShape(world, {
      tasks: [{ id: "T-1", roles: ["impl"] }],
      gates: { plan: true, whiteboxReview: true, blackboxAcceptance: false },
      skipped: [{ gate: "blackboxAcceptance", decisionId: skipDecisionId }],
      acceptanceReport: "/reports/x.md",
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "shape-confirm",
      requirement: world.requirement,
      runId,
      decisionId: confirmDecisionId,
      version: state.version,
    });

    expect(result.details.isError).toBeFalsy();
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect((after.data.shape as { gates: { blackboxAcceptance: boolean } } | null)?.gates.blackboxAcceptance).toBe(false);
  });
});

describe("resume-check 续接核对", () => {
  test("对无状态需求返回阻塞而非完成", async () => {
    const world = await setupWorld();
    await expect(call(world, { action: "resume-check", requirement: world.requirement })).rejects.toThrow(/需求状态不存在/);
  });

  test("成功回执的 version 是数字，不出现 version undefined", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const result = await call(world, { action: "resume-check", requirement: world.requirement });
    expect(result.details.isError).toBeFalsy();
    expect(result.text).not.toContain("version undefined");
    expect(result.text).toMatch(/version \d+$/);
  });
});

describe("list 需求列表", () => {
  test("返回进行中的需求，不包含已验收需求", async () => {
    const world = await setupWorld();
    const inProgressA = "2026-09-09.workflow-list-a";
    const inProgressB = "2026-09-09.workflow-list-b";
    const accepted = "2026-09-09.workflow-list-c";
    await seedState(world.home.dataRoot, world.identity.repoId, inProgressA, { stage: "draft" });
    await seedState(world.home.dataRoot, world.identity.repoId, inProgressB, { stage: "executing" });
    await seedState(world.home.dataRoot, world.identity.repoId, accepted, { stage: "accepted" });

    const result = await call(world, { action: "list" });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain(inProgressA);
    expect(result.text).toContain(inProgressB);
    expect(result.text).not.toContain(accepted);
  });
});

describe("迁移动作（未注入处理器）", () => {
  test("migrate-preflight 未注入处理器时以抛出表达失败", async () => {
    const world = await setupWorld();
    await expect(call(world, { action: "migrate-preflight", requirement: world.requirement })).rejects.toThrow(/迁移功能未接入/);
  });

  test("migrate-apply 未注入处理器时以抛出表达失败", async () => {
    const world = await setupWorld();
    await expect(call(world, { action: "migrate-apply", requirement: world.requirement })).rejects.toThrow(/迁移功能未接入/);
  });

  test("migrate-status 未注入处理器时以抛出表达失败", async () => {
    const world = await setupWorld();
    await expect(call(world, { action: "migrate-status", requirement: world.requirement })).rejects.toThrow(/迁移功能未接入/);
  });
});

describe("写入失败与异常兜底", () => {
  test("state.json 所在目录只读时写入失败，以抛出表达失败原因", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const dir = requirementDataDir(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await chmod(dir, 0o500);
    try {
      await expect(
        call(world, {
          action: "update",
          requirement: world.requirement,
          version: state.version,
          update: { followUpIssues: ["x"] },
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test("已中止的 AbortSignal 传入 execute 时返回 isError 且不写入", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await world.tool.execute(
      "call-1",
      { action: "update", requirement: world.requirement, version: state.version, update: { followUpIssues: ["x"] } },
      AbortSignal.abort(),
      undefined,
      fakeCtx({ cwd: world.repo.root }),
    );

    expect((result as { details: { isError: boolean } }).details.isError).toBe(true);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.followUps).toEqual([]);
  });
});

describe("extensions/workflow.ts 注册", () => {
  test("默认导出对假 pi 调用 registerTool 恰一次且工具名正确", () => {
    const { pi, registered } = createFakePi();
    workflowExtension(pi as unknown as ExtensionAPI);
    expect(registered.length).toBe(1);
    expect(registered[0]?.name).toBe("pi_company_workflow");
  });
});

describe("shape-confirm 与 advance/task-finish 同口径的证据校验", () => {
  test("对绑定到其他需求的计划运行返回失败回执，形状未写入", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const otherRequirement = "2026-09-09.workflow-tool-other";
    const confirmDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const run = await world.runStore.create(baseRunInput(otherRequirement, world.repo.root));
    await world.runStore.update(run.id, { state: "running" });
    await world.runStore.update(run.id, {
      state: "completed",
      result: {
        phase: "plan",
        verdict: "PASS",
        summary: "计划完成",
        proposedShape: {
          tasks: [{ id: "T-1", roles: ["impl"] }],
          gates: { plan: true, whiteboxReview: true, blackboxAcceptance: true },
          skipped: [],
          acceptanceReport: "/reports/x.md",
        },
        binding: { requirement: otherRequirement, definitionFingerprint: "irrelevant", codeHead: "irrelevant", cwd: world.repo.root },
      },
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "shape-confirm",
        requirement: world.requirement,
        runId: run.id,
        decisionId: confirmDecisionId,
        version: state.version,
      }),
    ).rejects.toThrow(/不一致/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.shape).toBeNull();
  });

  test("对 phase 不是 plan 的运行返回失败回执，形状未写入", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const confirmDecisionId = await appendUserDecisionId(world, "确认形状", "确认任务集与门禁声明");
    const run = await world.runStore.create(baseRunInput(world.requirement, world.repo.root, "T-1"));
    await world.runStore.update(run.id, { state: "running" });
    await world.runStore.update(run.id, {
      state: "completed",
      result: {
        phase: "work",
        verdict: "PASS",
        changedFiles: ["a.ts"],
        workState: "red-green",
        preexistingEvidence: [],
        proposedShape: {
          tasks: [{ id: "T-1", roles: ["impl"] }],
          gates: { plan: true, whiteboxReview: true, blackboxAcceptance: true },
          skipped: [],
          acceptanceReport: "/reports/x.md",
        },
        binding: { requirement: world.requirement, task: "T-1", definitionFingerprint: "irrelevant", codeHead: "irrelevant", cwd: world.repo.root },
        delivery: { commit: "irrelevant", verificationOk: true },
      },
    });
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "shape-confirm",
        requirement: world.requirement,
        runId: run.id,
        decisionId: confirmDecisionId,
        version: state.version,
      }),
    ).rejects.toThrow(/phase 期望 plan/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.data.shape).toBeNull();
  });
});

describe("requirement 参数在读盘/计算前的校验", () => {
  test("advance 对格式非法或含路径穿越的 requirement 以抛出表达失败且不泄漏绝对路径", async () => {
    const world = await setupWorld();
    for (const requirement of ["bad name", "../../../../etc"]) {
      const error = await callExpectingError(world, { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: "USER-1" });
      expect(containsAbsolutePath(error.message)).toBe(false);
    }
  });

  test("resume-check 对格式非法或含路径穿越的 requirement 以抛出表达失败且不泄漏绝对路径", async () => {
    const world = await setupWorld();
    for (const requirement of ["bad name", "../../../../etc"]) {
      const error = await callExpectingError(world, { action: "resume-check", requirement });
      expect(containsAbsolutePath(error.message)).toBe(false);
    }
  });

  test("advance 对拼接读盘命中仓库内已存在文件的 requirement 以抛出表达失败且不泄漏仓库绝对路径", async () => {
    const world = await setupWorld();
    const requirement = "../../README.md";
    const error = await callExpectingError(world, { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: "USER-1" });
    expect(error.message.includes(world.repo.root)).toBe(false);
    expect(containsAbsolutePath(error.message)).toBe(false);
  });

  test("resume-check 对拼接读盘命中仓库内已存在文件的 requirement 以抛出表达失败且不泄漏仓库绝对路径", async () => {
    const world = await setupWorld();
    const requirement = "../../README.md";
    const error = await callExpectingError(world, { action: "resume-check", requirement });
    expect(error.message.includes(world.repo.root)).toBe(false);
    expect(containsAbsolutePath(error.message)).toBe(false);
  });

  test("list 的 cwd 指向不存在目录触发仓库读取错误时以抛出表达失败且不泄漏绝对路径", async () => {
    const world = await setupWorld();
    const brokenCwd = join(world.repo.root, "missing-subdir");
    const error = await callExpectingError(world, { action: "list", cwd: brokenCwd });
    expect(error.message.includes(brokenCwd)).toBe(false);
    expect(containsAbsolutePath(error.message)).toBe(false);
  });
});

describe("update 参数缺失时的校验", () => {
  test("携带任务字段但未指定 task 时失败，不写入且 version 不变", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(
      call(world, {
        action: "update",
        requirement: world.requirement,
        version: before.version,
        update: { note: "备注A" },
      }),
    ).rejects.toThrow(/缺少 task/);
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.version).toBe(before.version);
  });

  test("update 与 followUpIssues 均为空时失败，不空转写", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    await expect(call(world, { action: "update", requirement: world.requirement, version: before.version })).rejects.toThrow(
      /缺少可更新字段/,
    );
    const after = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);
    expect(after.version).toBe(before.version);
  });

  test("缺少 version 时失败原因指向缺参数而非版本已变化", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const error = await callExpectingError(world, {
      action: "update",
      requirement: world.requirement,
      update: { followUpIssues: ["跟进事项A"] },
    });

    expect(error.message).not.toContain("版本已变化");
    expect(error.message).toContain("version");
  });

  test("支持更新 blockedReason 与 workspaceDir，更新后 query 该任务可见两字段", async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement, {
      tasks: { "T-1": { progress: "todo", runId: null, description: "", agent: "", note: "", commit: null, reason: "", repairRound: 0 } },
    });
    const before = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const result = await call(world, {
      action: "update",
      requirement: world.requirement,
      task: "T-1",
      version: before.version,
      update: { blockedReason: "等待外部依赖", workspaceDir: "/workspace/T-1" },
    });

    expect(result.details.isError).toBeFalsy();
    const query = await call(world, { action: "query", requirement: world.requirement });
    const tasks = (query.details.data as { tasks: Record<string, { blockedReason?: string; workspaceDir?: string }> }).tasks;
    expect(tasks["T-1"]?.blockedReason).toBe("等待外部依赖");
    expect(tasks["T-1"]?.workspaceDir).toBe("/workspace/T-1");
  });
});

describe("版本冲突回执格式", () => {
  test('版本冲突回执中"请重新查询后重试"只出现一次且不含"请重新读取后重试"', async () => {
    const world = await setupWorld();
    await seedState(world.home.dataRoot, world.identity.repoId, world.requirement);
    const ctx = { dataRoot: world.home.dataRoot, cwd: world.repo.root };
    const state = await readRawState(world.home.dataRoot, world.identity.repoId, world.requirement);

    const first = await executeWorkflowAction(
      { action: "update", requirement: world.requirement, version: state.version, update: { followUpIssues: ["A"] } },
      ctx,
    );
    expect(first.ok).toBe(true);
    const second = await executeWorkflowAction(
      { action: "update", requirement: world.requirement, version: state.version, update: { followUpIssues: ["B"] } },
      ctx,
    );
    expect(second.ok).toBe(false);
    const occurrences = (second.text.match(/请重新查询后重试/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(second.text).not.toContain("请重新读取后重试");
  });
});

describe("currentVersion 定义指纹计算", () => {
  function definitionDir(world: World): string {
    return join(world.repo.root, ".pi-company", "requirements", world.requirement);
  }

  test("需求定义目录缺失时指纹为 none", async () => {
    const world = await setupWorld();
    const version = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });
    expect(version.definitionFingerprint).toBe("none");
  });

  test("写入定义文件后指纹在两次计算间保持稳定", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "内容A\n");
    await writeFile(join(dir, "b.md"), "内容B\n");

    const first = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });
    const second = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });
    expect(first.definitionFingerprint).toBe(second.definitionFingerprint);
    expect(first.definitionFingerprint).not.toBe("none");
  });

  test("修改定义文件内容后指纹变化", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "内容A\n");
    const before = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    await writeFile(join(dir, "a.md"), "内容A-已修改\n");
    const after = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    expect(after.definitionFingerprint).not.toBe(before.definitionFingerprint);
  });

  test("定义文件改名后指纹变化", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.md"), "内容A\n");
    const before = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    await rename(join(dir, "a.md"), join(dir, "a-renamed.md"));
    const after = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    expect(after.definitionFingerprint).not.toBe(before.definitionFingerprint);
  });

  test("目录内符号链接指向的文件内容变化后指纹应变化", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    const target = join(world.repo.root, "linked-source.md");
    await writeFile(target, "外部内容V1\n");
    await symlink(target, join(dir, "link.md"));
    const before = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    await writeFile(target, "外部内容V2\n");
    const after = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    expect(after.definitionFingerprint).not.toBe(before.definitionFingerprint);
  });

  test("不同的文件名与内容布局不应产生相同指纹（路径与内容之间需要分隔）", async () => {
    const worldA = await setupWorld("2026-09-09.fingerprint-collision-a");
    const dirA = definitionDir(worldA);
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, "ab"), "c");
    const versionA = await currentVersion({ cwd: worldA.repo.root, requirement: worldA.requirement });

    const worldB = await setupWorld("2026-09-09.fingerprint-collision-b");
    const dirB = definitionDir(worldB);
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, "a"), "bc");
    const versionB = await currentVersion({ cwd: worldB.repo.root, requirement: worldB.requirement });

    expect(versionA.definitionFingerprint).not.toBe(versionB.definitionFingerprint);
  });

  test("两个文件与一个含 NUL 字节的单文件不应产生相同指纹（记录之间需要框定）", async () => {
    const worldA = await setupWorld("2026-09-09.fingerprint-frame-a");
    const dirA = definitionDir(worldA);
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, "a"), "b");
    await writeFile(join(dirA, "c"), "d");
    const versionA = await currentVersion({ cwd: worldA.repo.root, requirement: worldA.requirement });

    const worldB = await setupWorld("2026-09-09.fingerprint-frame-b");
    const dirB = definitionDir(worldB);
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, "a"), Buffer.from([0x62, 0x63, 0x00, 0x64]));
    const versionB = await currentVersion({ cwd: worldB.repo.root, requirement: worldB.requirement });

    expect(versionA.definitionFingerprint).not.toBe(versionB.definitionFingerprint);
  });

  test("已有一个链接指向某文件时新增另一链接指向同一文件后指纹应变化", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    const target = join(world.repo.root, "shared.md");
    await writeFile(target, "共享内容\n");
    await symlink(target, join(dir, "link1.md"));
    const before = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    await symlink(target, join(dir, "link2.md"));
    const after = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    expect(after.definitionFingerprint).not.toBe(before.definitionFingerprint);
  });

  test("定义目录内指向仓库外目录的符号链接，其目标内容变化不影响指纹", async () => {
    const world = await setupWorld();
    const dir = definitionDir(world);
    await mkdir(dir, { recursive: true });
    const outsideFile = join(world.home.home, "outside.md");
    await writeFile(outsideFile, "仓库外内容V1\n");
    await symlink(outsideFile, join(dir, "escape-link.md"));
    const before = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    await writeFile(outsideFile, "仓库外内容V2\n");
    const after = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });

    expect(after.definitionFingerprint).toBe(before.definitionFingerprint);
  });
});

describe("list 动作的 cwd 覆盖", () => {
  test("params.cwd 指向另一个仓库时返回该仓库的进行中需求", async () => {
    const world = await setupWorld();
    const otherRepo = await createRepoFixture();
    repoFixtures.push(otherRepo);
    const otherIdentity = await repositoryIdentity(otherRepo.root);
    const otherRequirement = "2026-09-09.workflow-list-other-repo";
    await seedState(world.home.dataRoot, otherIdentity.repoId, otherRequirement, { stage: "draft" });

    const result = await call(world, { action: "list", cwd: otherRepo.root });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain(otherRequirement);
  });
});
