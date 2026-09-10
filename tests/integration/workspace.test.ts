import { temporaryRoot } from "../helpers/temporary-root.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { appendDecision } from "../../runtime/decisions.ts";
import { daemonSocketPath, discoverWorkspace, repositoryIdentity } from "../../runtime/identity.ts";
import { readRecord, writeRecord } from "../../runtime/database.ts";
import { requirementStateRef } from "../../runtime/workflow-state.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { connectTestClient, killDaemon, startDaemonForTest } from "../helpers/daemon-harness.ts";
import type { DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import {
  createProviderRequestsLog,
  modelProviderEnv,
  waitForProviderLogEntries,
  writeTestModelProviders,
} from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { createWorkspaceFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import type { WorkspaceFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import type { TempHome } from "../helpers/temp-home.ts";

const execFileAsync = promisify(execFile);

interface RepoDaemon {
  root: string;
  repoId: string;
  commonDir: string;
  socketPath: string;
  handle: DaemonHandle;
  requestsLog: string;
}

interface World {
  home: TempHome;
  workspace: WorkspaceFixture;
  dataRoot: string;
  repoA: RepoDaemon;
  repoB: RepoDaemon;
}

const worlds: World[] = [];
const clients: TestClient[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const world of worlds.splice(0)) {
    const pids = [world.repoA.handle.proc.pid, world.repoB.handle.proc.pid].filter((pid): pid is number => pid !== undefined);
    await killDaemon(world.repoA.handle).catch(() => undefined);
    await killDaemon(world.repoB.handle).catch(() => undefined);
    for (const pid of pids) await waitForProcessGroupGone(pid);
    await removeRepoFixture(world.workspace).catch(() => undefined);
    await removeTempHome(world.home).catch(() => undefined);
    await rm(world.dataRoot, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listProcessGroup(pgid: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== undefined && pid > 0)
    .map(([pid]) => pid as number);
}

// 守护进程以独立进程组拉起，其后代默认继承同组：组内无进程即证明没有残留
async function waitForProcessGroupGone(pgid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remaining = await listProcessGroup(pgid);
    if (remaining.length === 0) return;
    for (const pid of remaining) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已退出
      }
    }
    await delay(100);
  }
  throw new Error(`进程组 ${pgid} 在 ${timeoutMs}ms 内仍有残留进程`);
}

function freshRequirementId(): string {
  return `2026-09-10.${randomUUID().slice(0, 8)}`;
}

function toolReply(name: string, input: Record<string, unknown>): ScriptedReply {
  return { type: "toolcall", name, input };
}

function textReply(text: string, chunkDelayMs?: number): ScriptedReply {
  return chunkDelayMs === undefined ? { type: "text", text } : { type: "text", text, chunkDelayMs };
}

function askReply(question: string): ScriptedReply {
  return toolReply("pi_company_ask", {
    question,
    options: [
      { label: "批准", description: "批准该变更" },
      { label: "驳回", description: "驳回该变更" },
    ],
    recommended: "批准",
  });
}

function shapeTask(id: string, role: string, waitFor?: { repo: string; requirement: string; stage: string }): Record<string, unknown> {
  return { id, title: `任务 ${id}`, roles: [role], dependsOn: [], writePaths: ["area-a"], ...(waitFor ? { waitFor } : {}) };
}

function proposeShapeReply(tasks: Array<Record<string, unknown>>): ScriptedReply {
  return toolReply("pi_company_propose_shape", {
    tasks,
    gates: { whiteboxReview: false, blackboxAcceptance: false },
    rationale: "workspace 集成测试固定形状",
  });
}

function dispatchRoleReply(task: string): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role: "worker", task, writePaths: ["area-a"], readPaths: [] });
}

function submitReply(): ScriptedReply {
  return toolReply("structured_output", {
    phase: "work",
    verdict: "PASS",
    summary: "workspace 集成测试固定完成",
    issues: [],
    evidence: ["测试固定证据"],
    changeKind: "refactor",
    workState: "green-baseline-no-change",
    coverage: [{ ref: "rule-1", test: "test-1" }],
    redCommands: [],
    greenCommands: [{ command: "true", status: "passed", details: "ok" }],
    changedFiles: [],
    productionPath: [],
    preexistingEvidence: [],
    fakeRed: false,
  });
}

function requirementProvider(replies: ScriptedReply[]): TestProviderScript {
  return { providerId: "controlled-requirement-agent", modelId: "controlled-model", roleName: "requirement-agent", replies };
}

function workerProvider(taskId: string, replies: ScriptedReply[]): TestProviderScript {
  return { providerId: `controlled-worker-${taskId}`, modelId: "controlled-model", roleName: "worker", taskId, replies };
}

async function startRepoDaemon(home: TempHome, dataRoot: string, root: string, scripts: TestProviderScript[]): Promise<RepoDaemon> {
  const identity = await repositoryIdentity(root);
  const scriptsDir = await mkdtemp(join(tmpdir(), "workspace-provider-scripts-"));
  tempDirs.push(scriptsDir);
  const providersPath = await writeTestModelProviders(scriptsDir, scripts);
  const requestsLog = await createProviderRequestsLog();
  tempDirs.push(dirname(requestsLog));
  const socketPath = daemonSocketPath(dataRoot, identity.repoId);
  const handle = await startDaemonForTest(
    { home, repoDir: identity.commonDir, dataRoot, socketPath },
    { extraEnv: modelProviderEnv(providersPath, requestsLog) },
  );
  return { root, repoId: identity.repoId, commonDir: identity.commonDir, socketPath, handle, requestsLog };
}

// 同一台机器上多个仓库的守护进程共用一个数据根，跨仓库阶段核对才读得到对方需求状态
async function startWorld(
  scripts: (ids: { repoAId: string; repoBId: string }) => { a: TestProviderScript[]; b: TestProviderScript[] },
): Promise<World> {
  const home = await createTempHome();
  const workspace = await createWorkspaceFixture();
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  const [rootA, rootB] = workspace.repos as [string, string];
  const ids = { repoAId: (await repositoryIdentity(rootA)).repoId, repoBId: (await repositoryIdentity(rootB)).repoId };
  const chosen = scripts(ids);
  const world: World = {
    home,
    workspace,
    dataRoot,
    repoA: await startRepoDaemon(home, dataRoot, rootA, chosen.a),
    repoB: await startRepoDaemon(home, dataRoot, rootB, chosen.b),
  };
  worlds.push(world);
  return world;
}

async function connectWindow(
  socketPath: string,
  window: { windowId: string; cwd: string; workspaceRoot: string; repoIds: string[] },
): Promise<TestClient> {
  const client = await connectTestClient(socketPath, { ...window, sessionId: `${window.windowId}-session` });
  clients.push(client);
  return client;
}

async function confirmRequirement(dataRoot: string, cwd: string, requirement: string): Promise<void> {
  await executeWorkflowAction({ action: "init", requirement }, { dataRoot, cwd });
  const decision = await appendDecision(
    {
      requirement,
      actor: "user",
      source: "test",
      trigger: "确认需求",
      decision: "确认进入执行",
      alternatives: [],
      effects: ["scope"],
      impact: "workspace 集成测试固定路径",
    },
    { dataRoot, cwd },
  );
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId },
    { dataRoot, cwd },
  );
  if (result.details.isError) throw new Error(`测试固件未能确认需求: ${result.text}`);
}

async function forceStage(dataRoot: string, repoId: string, requirement: string, stage: string): Promise<void> {
  const path = requirementStateRef(dataRoot, repoId, requirement);
  const current = await readRecord(path);
  if (!current.exists) throw new Error("测试固件失败: 需求状态不存在");
  await writeRecord(path, { ...(current.data as Record<string, unknown>), stage }, { expectedVersion: current.version });
}

interface QuestionEvent {
  id: string;
  repoId: string;
  requirement: string;
  question: string;
}

function collectQuestions(client: TestClient): QuestionEvent[] {
  const received: QuestionEvent[] = [];
  client.onEvent("relay.question", (data) => received.push(data as unknown as QuestionEvent));
  return received;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(`等待超时（${timeoutMs}ms）: ${label}`);
}

interface RunView {
  id: string;
  kind: string;
  state: string;
  task: string;
  requirement?: string;
  stateReason?: string;
}

async function listRuns(client: TestClient): Promise<RunView[]> {
  const result = await client.call("runs.list", { limit: 200 });
  return result.items as RunView[];
}

async function waitForRun(client: TestClient, predicate: (run: RunView) => boolean, timeoutMs: number): Promise<RunView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = (await listRuns(client)).find(predicate);
    if (found) return found;
    await delay(150);
  }
  throw new Error(`等待目标运行超时（${timeoutMs}ms）`);
}

describe("workspace-coordination：可见范围", () => {
  test("父目录发现两个仓库并跳过 node_modules 诱饵，仓库内只见自己，无关目录一个都看不到", async () => {
    const workspace = await createWorkspaceFixture();
    const unrelated = await mkdtemp(join(tmpdir(), "workspace-unrelated-"));
    tempDirs.push(unrelated);
    try {
      const parentView = await discoverWorkspace(workspace.root);
      expect(parentView.repos.map((repo) => repo.path).sort()).toEqual([...workspace.repos].sort());
      expect(parentView.repos.some((repo) => repo.path.includes("node_modules"))).toBe(false);

      const insideView = await discoverWorkspace(workspace.repos[0]!);
      expect(insideView.repos.map((repo) => repo.path)).toEqual([workspace.repos[0]!]);

      const unrelatedView = await discoverWorkspace(unrelated);
      expect(unrelatedView.repos).toEqual([]);
    } finally {
      await removeRepoFixture(workspace);
    }
  });

  test(
    "父目录窗口收到两个仓库的提问，仓库内窗口只收本仓库的，无关窗口一条都收不到且待办为空",
    async () => {
      const requirementA = freshRequirementId();
      const requirementB = freshRequirementId();
      const world = await startWorld(() => ({
        a: [requirementProvider([askReply("前端仓库的问题"), textReply("前端收到回答", 30_000)])],
        b: [requirementProvider([askReply("后端仓库的问题"), textReply("后端收到回答", 30_000)])],
      }));
      const { repoA, repoB, workspace } = world;
      const bothRepoIds = [repoA.repoId, repoB.repoId];

      const parentOnA = await connectWindow(repoA.socketPath, { windowId: "parent-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const parentOnB = await connectWindow(repoB.socketPath, { windowId: "parent-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const insideA = await connectWindow(repoA.socketPath, { windowId: "repo-a-window", cwd: repoA.root, workspaceRoot: repoA.root, repoIds: [repoA.repoId] });
      const insideAOnB = await connectWindow(repoB.socketPath, { windowId: "repo-a-window", cwd: repoA.root, workspaceRoot: repoA.root, repoIds: [repoA.repoId] });
      const unrelated = await connectWindow(repoA.socketPath, { windowId: "unrelated-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: ["0".repeat(64)] });

      const parentQuestions = collectQuestions(parentOnA);
      const parentQuestionsB = collectQuestions(parentOnB);
      const insideAQuestions = collectQuestions(insideA);
      const insideAOnBQuestions = collectQuestions(insideAOnB);
      const unrelatedQuestions = collectQuestions(unrelated);

      await confirmRequirement(world.dataRoot, repoA.root, requirementA);
      await confirmRequirement(world.dataRoot, repoB.root, requirementB);
      await parentOnA.call("dispatch.requirement", { requirement: requirementA, cwd: repoA.root });
      await parentOnB.call("dispatch.requirement", { requirement: requirementB, cwd: repoB.root });

      await waitFor(() => (parentQuestions.length >= 1 && parentQuestionsB.length >= 1 ? true : undefined), 15_000, "父目录窗口收到两仓库提问");
      expect(parentQuestions.map((q) => q.repoId)).toEqual([repoA.repoId]);
      expect(parentQuestionsB.map((q) => q.repoId)).toEqual([repoB.repoId]);

      await waitFor(() => (insideAQuestions.length >= 1 ? true : undefined), 5_000, "仓库 A 窗口收到本仓库提问");
      expect(insideAQuestions.map((q) => q.repoId)).toEqual([repoA.repoId]);

      await delay(1_000);
      expect(insideAOnBQuestions).toEqual([]);
      expect(unrelatedQuestions).toEqual([]);

      const pendingForUnrelated = await unrelated.call("relay.pending", {});
      expect(pendingForUnrelated.questions).toEqual([]);
      expect(pendingForUnrelated.notices).toEqual([]);

      const pendingForInsideAOnB = await insideAOnB.call("relay.pending", {});
      expect(pendingForInsideAOnB.questions).toEqual([]);
    },
    45_000,
  );
});

describe("workspace-coordination：契约变更经主会话裁定并转发", () => {
  test(
    "后端代理发起契约变更提问，主会话作答后转发给前端代理，前端代理的下一轮上下文含该补充",
    async () => {
      const requirementA = freshRequirementId();
      const requirementB = freshRequirementId();
      const contractQuestion = "契约变更：错误码结构改为 A-BBB-CCCC，影响前端仓库";
      const ruling = "主会话裁定：批准错误码结构变更，前端同步调整解析";
      const world = await startWorld(() => ({
        a: [requirementProvider([textReply("前端代理待命"), textReply("前端已并入补充"), textReply("前端结束")])],
        b: [requirementProvider([askReply(contractQuestion), textReply("后端收到裁定"), textReply("后端结束")])],
      }));
      const { repoA, repoB, workspace } = world;
      const bothRepoIds = [repoA.repoId, repoB.repoId];
      const mainOnA = await connectWindow(repoA.socketPath, { windowId: "main-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const mainOnB = await connectWindow(repoB.socketPath, { windowId: "main-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const questionsFromB = collectQuestions(mainOnB);

      await confirmRequirement(world.dataRoot, repoA.root, requirementA);
      await confirmRequirement(world.dataRoot, repoB.root, requirementB);
      await mainOnA.call("dispatch.requirement", { requirement: requirementA, cwd: repoA.root });
      await mainOnB.call("dispatch.requirement", { requirement: requirementB, cwd: repoB.root });

      const question = await waitFor(() => questionsFromB.find((q) => q.question.includes("契约变更")), 15_000, "主会话收到后端契约变更提问");
      expect(question.repoId).toBe(repoB.repoId);
      expect(question.requirement).toBe(requirementB);

      const answered = await mainOnB.call("relay.answer", { questionId: question.id, answer: ruling, windowId: "main-window" });
      expect(answered.accepted).toBe(true);
      await waitForProviderLogEntries(repoB.requestsLog, (entries) => entries.some((entry) => entry.text.includes(ruling)), 10_000);

      await waitForProviderLogEntries(repoA.requestsLog, (entries) => entries.length >= 1, 10_000);
      const forwarded = await mainOnA.call("relay.forward", { requirement: requirementA, message: ruling, windowId: "main-window" });
      expect(forwarded.delivered).toBe(true);
      const frontendEntries = await waitForProviderLogEntries(
        repoA.requestsLog,
        (entries) => entries.some((entry) => entry.text.includes(ruling)),
        10_000,
      );
      expect(frontendEntries.some((entry) => entry.text.includes(contractQuestion))).toBe(false);
    },
    45_000,
  );

  test(
    "跨仓库直连被拒：向后端守护进程转发前端需求不送达，前端代理上下文从未出现该消息",
    async () => {
      const requirementA = freshRequirementId();
      const requirementB = freshRequirementId();
      const directMessage = "后端代理直接联系前端代理：请立刻改契约";
      const world = await startWorld(() => ({
        a: [requirementProvider([textReply("前端代理待命"), textReply("前端结束")])],
        b: [requirementProvider([textReply("后端代理待命"), textReply("后端结束")])],
      }));
      const { repoA, repoB, workspace } = world;
      const bothRepoIds = [repoA.repoId, repoB.repoId];
      const mainOnA = await connectWindow(repoA.socketPath, { windowId: "main-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const mainOnB = await connectWindow(repoB.socketPath, { windowId: "main-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });

      await confirmRequirement(world.dataRoot, repoA.root, requirementA);
      await confirmRequirement(world.dataRoot, repoB.root, requirementB);
      await mainOnA.call("dispatch.requirement", { requirement: requirementA, cwd: repoA.root });
      await mainOnB.call("dispatch.requirement", { requirement: requirementB, cwd: repoB.root });
      await waitForProviderLogEntries(repoA.requestsLog, (entries) => entries.length >= 1, 10_000);
      await waitForProviderLogEntries(repoB.requestsLog, (entries) => entries.length >= 1, 10_000);

      const rejected = await mainOnB.call("relay.forward", { requirement: requirementA, message: directMessage, windowId: "main-window" });
      expect(rejected.delivered).toBe(false);
      expect(typeof rejected.reason).toBe("string");

      await delay(1_000);
      const frontendEntries = await waitForProviderLogEntries(repoA.requestsLog, () => true, 1_000);
      expect(frontendEntries.some((entry) => entry.text.includes(directMessage))).toBe(false);
      const backendEntries = await waitForProviderLogEntries(repoB.requestsLog, () => true, 1_000);
      expect(backendEntries.some((entry) => entry.text.includes(directMessage))).toBe(false);
    },
    45_000,
  );
});

describe("workspace-coordination：跨仓库等待", () => {
  test(
    "形状声明等待后端需求 accepted：运行排队可查，到达后自动启动同一运行",
    async () => {
      const requirementA = freshRequirementId();
      const requirementB = freshRequirementId();
      const world = await startWorld(({ repoBId }) => ({
        a: [
          requirementProvider([
            proposeShapeReply([shapeTask("T-1", "worker", { repo: repoBId, requirement: requirementB, stage: "accepted" })]),
            dispatchRoleReply("T-1"),
            textReply("任务已排队，等待后端"),
            textReply("已派工"),
            textReply("结束"),
          ]),
          workerProvider("T-1", [submitReply(), textReply("完成")]),
        ],
        b: [requirementProvider([textReply("后端待命")])],
      }));
      const { repoA, repoB, workspace, dataRoot } = world;
      const [rootA, rootB] = workspace.repos as [string, string];
      const bothRepoIds = [repoA.repoId, repoB.repoId];
      const mainOnA = await connectWindow(repoA.socketPath, { windowId: "main-window", cwd: workspace.root, workspaceRoot: workspace.root, repoIds: bothRepoIds });
      const questions = collectQuestions(mainOnA);

      await confirmRequirement(dataRoot, rootA, requirementA);
      await confirmRequirement(dataRoot, rootB, requirementB);
      await forceStage(dataRoot, repoB.repoId, requirementB, "executing");
      await mainOnA.call("dispatch.requirement", { requirement: requirementA, cwd: rootA });

      const shapeQuestion = await waitFor(() => questions.find((q) => q.question.includes("请确认以下工作流形状")), 15_000, "收到形状确认提问");
      expect(shapeQuestion.question).toContain(requirementB);
      expect(shapeQuestion.question).toContain("accepted");
      await mainOnA.call("relay.answer", { questionId: shapeQuestion.id, answer: "确认", windowId: "main-window" });

      const queued = await waitForRun(mainOnA, (run) => run.kind === "role" && run.task === "T-1" && run.state === "queued", 15_000);
      expect(queued.stateReason).toContain("尚未到达阶段 accepted");
      expect(queued.stateReason).toContain("当前 executing");
      await forceStage(dataRoot, repoB.repoId, requirementB, "accepted");
      const workerRun = await waitForRun(mainOnA, (run) => run.id === queued.id && run.state !== "queued", 15_000);
      expect(workerRun.task).toBe("T-1");
    },
    60_000,
  );
});
