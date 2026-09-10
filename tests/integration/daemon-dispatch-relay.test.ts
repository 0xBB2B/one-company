import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectRawClient,
  connectTestClient,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  resolveNodeExecutable,
  resolveSdkDir,
  startDaemonForTest,
} from "../helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import type { DaemonClient } from "../../runtime/daemon-client.ts";
import { PROTOCOL_VERSION } from "../../runtime/protocol.ts";
import {
  createProviderRequestsLog,
  modelProviderEnv,
  readProviderRequestsLog,
  waitForProviderLogEntries,
  writeTestModelProviders,
} from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { appendDecision } from "../../runtime/decisions.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { repoDataDir } from "../../runtime/identity.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const activeFixtures: DaemonFixture[] = [];
const activeHandles: DaemonHandle[] = [];
const activeClients: TestClient[] = [];
const activeDaemonClients: DaemonClient[] = [];
const activeTempDirs: string[] = [];
const trackedPids: number[] = [];

function trackFixture(fixture: DaemonFixture): DaemonFixture {
  activeFixtures.push(fixture);
  return fixture;
}

function trackHandle(handle: DaemonHandle): DaemonHandle {
  activeHandles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    try {
      client.close();
    } catch {
      // 连接可能已因守护进程退出而关闭
    }
  }
  for (const client of activeDaemonClients.splice(0)) {
    client.close();
  }
  for (const handle of activeHandles.splice(0)) {
    await killDaemon(handle).catch(() => undefined);
  }
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出
    }
  }
  for (const fixture of activeFixtures.splice(0)) {
    await removeDaemonFixture(fixture).catch(() => undefined);
  }
  for (const dir of activeTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startWorld(
  scripts: TestProviderScript[],
  extraEnv: Record<string, string> = {},
): Promise<{ fixture: DaemonFixture; handle: DaemonHandle }> {
  const fixture = trackFixture(await createDaemonFixture());
  const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
  const handle = trackHandle(
    await startDaemonForTest(fixture, { extraEnv: { ...modelProviderEnv(providersPath), ...extraEnv } }),
  );
  return { fixture, handle };
}

interface WindowOverrides {
  windowId: string;
  cwd?: string;
  workspaceRoot?: string;
  repoIds?: string[];
}

async function openWindow(
  fixture: Pick<DaemonFixture, "socketPath" | "repo" | "repoId">,
  overrides: WindowOverrides,
): Promise<TestClient> {
  const client = await connectTestClient(fixture.socketPath, {
    windowId: overrides.windowId,
    cwd: overrides.cwd ?? fixture.repo.root,
    workspaceRoot: overrides.workspaceRoot ?? fixture.repo.root,
    repoIds: overrides.repoIds ?? [fixture.repoId],
  });
  activeClients.push(client);
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
      impact: "daemon-dispatch-relay 集成测试固定路径",
    },
    { dataRoot, cwd },
  );
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId },
    { dataRoot, cwd },
  );
  if (result.details.isError) throw new Error(`测试固件未能确认需求: ${result.text}`);
}

function toolReply(name: string, input: Record<string, unknown>): ScriptedReply {
  return { type: "toolcall", name, input };
}

function textReply(text: string, chunkDelayMs?: number): ScriptedReply {
  return chunkDelayMs === undefined ? { type: "text", text } : { type: "text", text, chunkDelayMs };
}

function shapeTask(id: string, role: string, writePaths: string[]): Record<string, unknown> {
  return { id, title: `任务 ${id}`, roles: [role], dependsOn: [], writePaths };
}

function proposeShapeReply(tasks: Array<Record<string, unknown>>): ScriptedReply {
  return toolReply("pi_company_propose_shape", {
    tasks,
    gates: { whiteboxReview: false, blackboxAcceptance: false },
    rationale: "daemon-dispatch-relay 集成测试固定形状",
  });
}

function dispatchRoleReply(role: string, task: string, writePaths: string[]): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role, task, writePaths, readPaths: [] });
}

function validWorkResult(): Record<string, unknown> {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "daemon-dispatch-relay 集成测试固定完成",
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
  };
}

function submitReply(): ScriptedReply {
  return toolReply("structured_output", validWorkResult());
}

const REQUIREMENT_PROVIDER = {
  providerId: "controlled-requirement-agent",
  modelId: "controlled-model",
  roleName: "requirement-agent",
};

interface RunView {
  id: string;
  kind: string;
  state: string;
  task: string;
  role?: string;
  parentRunId?: string;
  requirement?: string;
  result?: unknown;
}

async function listRuns(client: TestClient): Promise<RunView[]> {
  const result = await client.call("runs.list", { limit: 200 });
  return result.items as RunView[];
}

async function waitForRun(
  client: TestClient,
  predicate: (run: RunView) => boolean,
  timeoutMs = 10_000,
): Promise<RunView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await listRuns(client);
    const found = runs.find(predicate);
    if (found) return found;
    await delay(150);
  }
  throw new Error("等待目标运行超时");
}

function waitForEvent<T = Record<string, unknown>>(client: TestClient, event: string, timeoutMs = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${event} 超时（${timeoutMs}ms）`)), timeoutMs);
    const unsubscribe = client.onEvent(event, (data) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(data as T);
    });
  });
}

function collectEvents(client: TestClient, event: string): Record<string, unknown>[] {
  const received: Record<string, unknown>[] = [];
  client.onEvent(event, (data) => received.push(data));
  return received;
}

async function waitForLength(getter: () => unknown[], count: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getter().length >= count) return;
    await delay(50);
  }
  throw new Error(`等待事件数量达到 ${count} 超时（${timeoutMs}ms），实际 ${getter().length}`);
}

describe("daemon-host 单实例与按需拉起", () => {
  test(
    "两个窗口并发连接同一未拉起的仓库时按需拉起且只有一个守护进程实例服务两端",
    async () => {
      const fixture = trackFixture(await createDaemonFixture());
      const sdkDir = resolveSdkDir();
      const execPath = resolveNodeExecutable();
      const env = { ...fixture.home.env, PI_CODING_AGENT_DIR: fixture.home.agentDir };
      const hello = (windowId: string) => ({
        windowId,
        pid: process.pid,
        sessionId: `${windowId}-session`,
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
      });

      // 两个窗口各自独立走生产客户端的按需拉起逻辑（socket 不存在则 spawn），而非测试夹具直接手动拉起守护进程
      const [windowA, windowB] = await Promise.all([
        connectDaemon({ repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir, execPath, env, hello: hello("window-a") }),
        connectDaemon({ repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir, execPath, env, hello: hello("window-b") }),
      ]);
      activeDaemonClients.push(windowA, windowB);
      expect(windowA.state().status).toBe("connected");
      expect(windowB.state().status).toBe("connected");

      const probe = await openWindow(fixture, { windowId: "probe" });
      const probeAgain = await openWindow(fixture, { windowId: "probe-again" });
      expect(typeof probe.helloResult.daemonPid).toBe("number");
      expect(probeAgain.helloResult.daemonPid).toBe(probe.helloResult.daemonPid);
      trackedPids.push(probe.helloResult.daemonPid as number);

      const runsA = await windowA.call("runs.list", {});
      const runsB = await windowB.call("runs.list", {});
      expect(Array.isArray(runsA.items)).toBe(true);
      expect(Array.isArray(runsB.items)).toBe(true);
    },
    25_000,
  );
});

describe("requirement-agent 派出前提", () => {
  test(
    "draft 形态需求派出被拒绝",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-draft-rejected";
      const scripts: TestProviderScript[] = [{ ...REQUIREMENT_PROVIDER, replies: [textReply("不应被使用")] }];
      const { fixture } = await startWorld(scripts);
      const window = await openWindow(fixture, { windowId: "window-draft" });
      await executeWorkflowAction({ action: "init", requirement }, { dataRoot: fixture.dataRoot, cwd: fixture.repo.root });

      await expect(window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root })).rejects.toThrow(/确认/);
    },
    15_000,
  );

  test(
    "confirmed 形态需求派出成功",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-confirmed-ok";
      const scripts: TestProviderScript[] = [
        { ...REQUIREMENT_PROVIDER, replies: [textReply("需求已确认，准备提议工作流形状", 30_000)] },
      ];
      const { fixture } = await startWorld(scripts);
      const window = await openWindow(fixture, { windowId: "window-confirmed" });
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);

      const result = await window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });
      expect(typeof result.runId).toBe("string");
      expect((result.runId as string).length).toBeGreaterThan(0);
    },
    15_000,
  );

  test(
    "已有活动需求代理运行时重复派出被拒绝，且既有运行保持唯一",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-already-active";
      const scripts: TestProviderScript[] = [
        { ...REQUIREMENT_PROVIDER, replies: [textReply("需求已确认，准备提议工作流形状", 30_000)] },
      ];
      const { fixture } = await startWorld(scripts);
      const window = await openWindow(fixture, { windowId: "window-reuse" });
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);

      const first = await window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });
      const firstRunId = first.runId as string;

      await expect(window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root })).rejects.toThrow(
        /已有活动/,
      );

      const runs = await listRuns(window);
      const matching = runs.filter((run) => run.kind === "requirement" && run.requirement === requirement);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.id).toBe(firstRunId);
    },
    15_000,
  );
});

describe("workflow-shape 形状提议确认", () => {
  test(
    "确认前不派出任何角色，确认后按提议形状派出对应角色",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-shape-confirm";
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-worker-shape-confirm-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const { fixture } = await startWorld(scripts);
      const window = await openWindow(fixture, { windowId: "window-shape" });
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);

      const questionPromise = waitForEvent<{ id: string }>(window, "relay.question");
      await window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });
      const question = await questionPromise;

      const runsBeforeConfirm = await listRuns(window);
      expect(runsBeforeConfirm.some((run) => run.kind === "role" && run.task === "T-1")).toBe(false);

      const answerResult = await window.call("relay.answer", {
        questionId: question.id,
        answer: "确认",
        windowId: "window-shape",
      });
      expect(answerResult.accepted).toBe(true);

      const roleRun = await waitForRun(window, (run) => run.kind === "role" && run.task === "T-1");
      expect(roleRun.role).toBe("pi-company.worker");
    },
    15_000,
  );
});

describe("user-relay 提问投递本工作区窗口首答生效", () => {
  test(
    "同仓库两窗口都收到提问，工作区外窗口收不到；一方作答后另一方收到撤回，工作区外窗口也收不到撤回",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-first-answer-wins";
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]), textReply("等待确认", 30_000)],
        },
      ];
      const { fixture } = await startWorld(scripts);
      const outsideDir = await mkdtemp(join(tmpdir(), "dispatch-relay-outside-"));
      activeTempDirs.push(outsideDir);

      const windowA = await openWindow(fixture, { windowId: "window-a" });
      const windowB = await openWindow(fixture, { windowId: "window-b" });
      const windowC = await openWindow(fixture, {
        windowId: "window-c",
        cwd: outsideDir,
        workspaceRoot: outsideDir,
        repoIds: [],
      });

      const questionOnA = waitForEvent<{ id: string }>(windowA, "relay.question");
      const questionOnB = waitForEvent<{ id: string }>(windowB, "relay.question");
      const questionsOnC = collectEvents(windowC, "relay.question");

      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await windowA.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });

      const [onA, onB] = await Promise.all([questionOnA, questionOnB]);
      expect(onA.id).toBe(onB.id);
      await delay(800);
      expect(questionsOnC.length).toBe(0);

      const withdrawOnB = waitForEvent<{ questionId: string }>(windowB, "relay.withdraw");
      const withdrawsOnA = collectEvents(windowA, "relay.withdraw");
      const withdrawsOnC = collectEvents(windowC, "relay.withdraw");

      const answerResult = await windowA.call("relay.answer", { questionId: onA.id, answer: "确认", windowId: "window-a" });
      expect(answerResult.accepted).toBe(true);

      const withdraw = await withdrawOnB;
      expect(withdraw.questionId).toBe(onA.id);
      await delay(800);
      expect(withdrawsOnA.length).toBe(0);
      expect(withdrawsOnC.length).toBe(0);

      const lateAnswer = await windowB.call("relay.answer", { questionId: onA.id, answer: "驳回", windowId: "window-b" });
      expect(lateAnswer.accepted).toBe(false);
      expect(lateAnswer.reason).toBe("already_answered");
    },
    15_000,
  );
});

describe("user-relay 无窗口排队推送", () => {
  test(
    "离线期间产生的提问与完成通知，新窗口连接后按产生顺序各推送一次",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-offline-backlog";
      const fixture = trackFixture(await createDaemonFixture());

      const repoDir = await repoDataDir(fixture.dataRoot, fixture.repoId, fixture.repoDir);
      const seedQueue = new RelayQueue({ dataDir: repoDir, deliver: async () => [], locateRequirementAgent: () => undefined });
      const seededQuestion = await seedQueue.ask({
        requirement,
        repoId: fixture.repoId,
        runId: randomUUID(),
        question: "离线排队测试问题",
        options: [],
        recommended: "",
      });
      await delay(10);
      const seededNotice = await seedQueue.notify({
        requirement,
        repoId: fixture.repoId,
        runId: randomUUID(),
        kind: "stopped",
        message: "离线排队测试完成通知",
      });

      trackHandle(await startDaemonForTest(fixture));

      // hello 响应与 onHello 积压推送可能落在同一个 socket 数据块里同步处理完；
      // 监听器必须先于 hello 调用挂上，否则响应帧与推送帧一起到达时会在监听器注册前被处理掉而丢失
      const raw = await connectRawClient(fixture.socketPath);
      activeClients.push({ ...raw, helloResult: {} });
      const received: Array<{ type: string; id: string }> = [];
      raw.onEvent("relay.question", (data) => received.push({ type: "question", id: data.id as string }));
      raw.onEvent("relay.notice", (data) => received.push({ type: "notice", id: data.id as string }));
      await raw.call("hello", {
        windowId: "window-late",
        pid: process.pid,
        sessionId: "window-late-session",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
        protocolVersion: PROTOCOL_VERSION,
      });

      // 守护进程装配（加载 SDK、发现角色目录等）晚于 socket 就绪，onHello 的积压推送要等装配完工才触发
      await waitForLength(() => received, 2, 15_000);

      expect(received).toEqual([
        { type: "question", id: seededQuestion.id },
        { type: "notice", id: seededNotice.id },
      ]);
    },
    25_000,
  );
});

describe("requirement-agent 代理间不直连", () => {
  test(
    "角色代理尝试直接给另一个角色代理的运行发消息：调用被当作无此能力处理，消息未送达目标运行",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-no-direct-role-contact";
      const directMessageMarker = "越权直连消息-试图指挥T-2直接执行";
      const requestsLogPath = await createProviderRequestsLog();
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "worker", ["area-a"]), shapeTask("T-2", "worker", ["area-b"])]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            dispatchRoleReply("worker", "T-2", ["area-b"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-worker-no-direct-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [
            // worker 角色会话没有注册 pi_company_agent（只有需求代理才有），此调用应被当作未知工具处理
            toolReply("pi_company_agent", {
              action: "run",
              role: "worker",
              task: "T-2",
              instructions: directMessageMarker,
              writePaths: [],
              readPaths: [],
            }),
            submitReply(),
            textReply("完成"),
          ],
        },
        {
          providerId: "controlled-worker-no-direct-T-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-2",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const fixture = trackFixture(await createDaemonFixture());
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      trackHandle(await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLogPath) }));
      const window = await openWindow(fixture, { windowId: "window-no-direct-role" });
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);

      const questionPromise = waitForEvent<{ id: string }>(window, "relay.question");
      await window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });
      const question = await questionPromise;
      await window.call("relay.answer", { questionId: question.id, answer: "确认", windowId: "window-no-direct-role" });

      const t1 = await waitForRun(window, (run) => run.kind === "role" && run.task === "T-1" && run.state === "completed", 15_000);
      const t2 = await waitForRun(window, (run) => run.kind === "role" && run.task === "T-2" && run.state === "completed", 15_000);

      // 直连尝试被当作未知工具处理，不影响 T-1 自身正常提交并完成
      expect((t1.result as Record<string, unknown> | undefined)?.verdict).toBe("PASS");
      expect((t2.result as Record<string, unknown> | undefined)?.verdict).toBe("PASS");

      const requests = await readProviderRequestsLog(requestsLogPath);
      const t2Requests = requests.filter((entry) => entry.providerId === "controlled-worker-no-direct-T-2");
      expect(t2Requests.length).toBeGreaterThan(0);
      expect(t2Requests.some((entry) => entry.text.includes(directMessageMarker))).toBe(false);
    },
    20_000,
  );

  test(
    "向非己方需求转发消息被拒绝且未送达",
    async () => {
      const requirement = "2026-09-10.dispatch-relay-no-direct-contact";
      const requestsLogPath = await createProviderRequestsLog();
      const scripts: TestProviderScript[] = [
        { ...REQUIREMENT_PROVIDER, replies: [textReply("需求代理运行中，等待后续指示", 30_000)] },
      ];
      const fixture = trackFixture(await createDaemonFixture());
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      trackHandle(await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLogPath) }));
      const window = await openWindow(fixture, { windowId: "window-no-direct" });
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await window.call("dispatch.requirement", { requirement, cwd: fixture.repo.root });
      await waitForRun(
        window,
        (run) => run.kind === "requirement" && run.requirement === requirement && run.state === "running",
      );
      const before = await waitForProviderLogEntries(requestsLogPath, (entries) => entries.length >= 1, 8_000);

      const result = await window.call("relay.forward", {
        requirement: "2026-09-10.dispatch-relay-unknown-target-agent",
        message: "尝试直接联系另一个需求代理",
        windowId: "window-no-direct",
      });
      expect(result.delivered).toBe(false);

      await delay(800);
      const after = await readProviderRequestsLog(requestsLogPath);
      expect(after.length).toBe(before.length);
    },
    15_000,
  );
});
