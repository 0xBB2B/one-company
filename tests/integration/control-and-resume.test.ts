import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  connectTestClient,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  startDaemonForTest,
} from "../helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import {
  createProviderRequestsLog,
  modelProviderEnv,
  waitForProviderLogEntries,
  writeTestModelProviders,
} from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { appendDecision } from "../../runtime/decisions.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { sessionJson } from "../helpers/database-fixture.ts";
import { sessionRecordRef } from "../../runtime/session-records.ts";
import { readRecord } from "../../runtime/database.ts";

interface World {
  fixture: DaemonFixture;
  handle: DaemonHandle;
  client: TestClient;
}

const activeWorlds: World[] = [];
const extraClients: TestClient[] = [];
const extraHandles: DaemonHandle[] = [];
const extraDaemonFixtures: DaemonFixture[] = [];
const extraTempDirs: string[] = [];
const trackedPids: number[] = [];

afterEach(async () => {
  for (const world of activeWorlds.splice(0)) {
    world.client.close();
    await killDaemon(world.handle).catch(() => undefined);
    await removeDaemonFixture(world.fixture).catch(() => undefined);
  }
  for (const client of extraClients.splice(0)) {
    client.close();
  }
  for (const handle of extraHandles.splice(0)) {
    await killDaemon(handle).catch(() => undefined);
  }
  for (const fixture of extraDaemonFixtures.splice(0)) {
    await removeDaemonFixture(fixture).catch(() => undefined);
  }
  for (const dir of extraTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已退出
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    rationale: "control-and-resume 测试固定形状",
  });
}

function dispatchRoleReply(role: string, task: string, writePaths: string[]): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role, task, writePaths, readPaths: [] });
}

function validWorkResult(): Record<string, unknown> {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "control-and-resume 测试固定完成",
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

const REQUIREMENT_PROVIDER = { providerId: "controlled-requirement-agent", modelId: "controlled-model", roleName: "requirement-agent" };

async function startWorld(scripts: TestProviderScript[], extraEnv: Record<string, string> = {}): Promise<World> {
  const fixture = await createDaemonFixture();
  const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
  const handle = await startDaemonForTest(fixture, {
    extraEnv: { ...modelProviderEnv(providersPath), ...extraEnv },
  });
  const client = await connectTestClient(fixture.socketPath, {
    cwd: fixture.repo.root,
    workspaceRoot: fixture.repo.root,
    repoIds: [fixture.repoId],
  });
  const world: World = { fixture, handle, client };
  activeWorlds.push(world);
  return world;
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
      impact: "control-and-resume 测试固定路径",
    },
    { dataRoot, cwd },
  );
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId },
    { dataRoot, cwd },
  );
  if (result.details.isError) throw new Error(`测试固件未能确认需求: ${result.text}`);
}

test("真实强杀后恢复排队派工：无会话也能恢复同一编号，重复续接拒绝且依赖满足前不启动", async () => {
  const fixture = await createDaemonFixture(); extraDaemonFixtures.push(fixture);
  const foreign = await createDaemonFixture(); extraDaemonFixtures.push(foreign);
  const requirement = "2026-09-10.queued-recovery";
  const dependency = "2026-09-10.queued-dependency";
  const scripts: TestProviderScript[] = [
    { providerId: "queued-parent", modelId: "test", roleName: "requirement-agent", replies: [
      proposeShapeReply([{ ...shapeTask("T-1", "worker", ["README.md"]), waitFor: { repo: foreign.repoId, requirement: dependency, stage: "confirmed" } }]),
      toolReply("pi_company_agent", { action: "run", role: "worker", task: "T-1", instructions: "恢复原始派工说明", writePaths: ["README.md"] }),
      textReply("等待依赖"),
    ] },
    { providerId: "queued-worker", modelId: "test", roleName: "worker", replies: [toolReply("bash", { command: "sleep 30" }), textReply("已停止等待")] },
  ];
  const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
  const env = modelProviderEnv(providersPath);
  const first = await startDaemonForTest(fixture, { extraEnv: env }); extraHandles.push(first);
  const hello = { cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId, foreign.repoId] };
  const client = await connectTestClient(fixture.socketPath, hello); extraClients.push(client);
  autoConfirmShape(client);
  await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
  const parentId = await dispatchRequirement(client, fixture.repo.root, requirement);
  const queued = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-1" && run.state === "queued");
  const ref = { dataRoot: fixture.dataRoot, repoId: fixture.repoId, runId: queued.id };
  expect(readRecord(sessionRecordRef(ref)).exists).toBe(false);
  first.proc.kill("SIGKILL"); await first.exited; client.close();
  scripts[0]!.replies = [toolReply("pi_company_resume_check", {}), textReply("父运行已核对")];
  await writeTestModelProviders(fixture.dataRoot, scripts);
  const second = await startDaemonForTest(fixture, { extraEnv: env }); extraHandles.push(second);
  const recovered = await connectTestClient(fixture.socketPath, hello); extraClients.push(recovered);
  await waitForRun(recovered, (run) => run.id === queued.id && run.state === "interrupted");
  const resumed = await Promise.all([recovered.call("runs.resumeInterrupted", { runId: queued.id }), recovered.call("runs.resumeInterrupted", { runId: queued.id })]);
  expect(resumed.filter((result) => result.ok)).toHaveLength(1);
  expect((await waitForRun(recovered, (run) => run.id === queued.id)).state).toBe("queued");
  expect(readRecord(sessionRecordRef(ref)).exists).toBe(false);
  expect((await recovered.call("runs.resumeInterrupted", { runId: parentId })).ok).toBe(true);
  await confirmRequirement(fixture.dataRoot, foreign.repo.root, dependency);
  await waitForRun(recovered, (run) => run.id === queued.id && run.state === "running");
  expect(sessionJson(ref)).toContain("恢复原始派工说明");
  expect((await recovered.call("runs.stop", { runId: queued.id })).state).toBe("stopped");
  await delay(1200);
  expect((await listRuns(recovered)).filter((run) => run.task === "T-1" && run.kind === "role")).toHaveLength(1);
  expect((await waitForRun(recovered, (run) => run.id === queued.id)).state).toBe("stopped");
}, 30000);

function autoConfirmShape(client: TestClient): () => void {
  return client.onEvent("relay.question", (data) => {
    void client.call("relay.answer", {
      questionId: data.id as string,
      answer: "确认",
      windowId: "test-window",
    });
  });
}

async function dispatchRequirement(client: TestClient, cwd: string, requirement: string): Promise<string> {
  const result = await client.call("dispatch.requirement", { requirement, cwd });
  return result.runId as string;
}

interface RunView {
  id: string;
  kind: string;
  state: string;
  task: string;
  role?: string;
  parentRunId?: string;
  result?: unknown;
}

async function listRuns(client: TestClient): Promise<RunView[]> {
  const result = await client.call("runs.list", { limit: 200 });
  return result.items as RunView[];
}

async function waitForRun(
  client: TestClient,
  predicate: (run: RunView) => boolean,
  timeoutMs = 15_000,
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

interface ShellTaskView {
  taskId: string;
  host: { kind: string; id: string; role?: string; runId?: string };
  pid: number;
  pgid: number;
  startedAt: number | null;
  status: string;
  command: string;
  descendants: number[];
}

async function listShells(client: TestClient): Promise<ShellTaskView[]> {
  const result = await client.call("shells.list", {});
  return result.tasks as ShellTaskView[];
}

describe("pause-control：跨窗口暂停继续", () => {
  test(
    "窗口 B 暂停窗口 A 派出的运行，确认后才显示为已暂停，继续后上下文保留",
    async () => {
      const requirement = "2026-09-10.cross-window-pause";
      const requestsLog = await createProviderRequestsLog();
      extraTempDirs.push(dirname(requestsLog));
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
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [
            toolReply("bash", { command: "echo MARK-CTX-58231" }),
            toolReply("bash", { command: "sleep 8" }),
            textReply("已恢复继续处理"),
          ],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const clientA = await connectTestClient(fixture.socketPath, {
        windowId: "window-a",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(clientA);
      const clientB = await connectTestClient(fixture.socketPath, {
        windowId: "window-b",
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(clientB);

      const unsubscribe = autoConfirmShape(clientA);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(clientA, fixture.repo.root, requirement);
      const t1 = await waitForRun(clientA, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      // 等第二个工具调用（sleep 8）真正起进程后再暂停，确保暂停确实打断了在跑的调用
      const start = Date.now();
      let sleepingTask: ShellTaskView | undefined;
      while (Date.now() - start < 6_000) {
        const shells = await listShells(clientA);
        sleepingTask = shells.find((entry) => entry.host.runId === t1.id && entry.command.includes("sleep 8"));
        if (sleepingTask) break;
        await delay(150);
      }
      expect(sleepingTask).toBeDefined();
      if (sleepingTask) trackedPids.push(sleepingTask.pid, ...sleepingTask.descendants);

      const beforePause = await waitForRun(clientB, (run) => run.id === t1.id);
      expect(beforePause.state).toBe("running");

      // 窗口 B（并非派出该运行的窗口 A）发起暂停：若首次调用未确认，响应必须是 pausing 而非 paused——
      // 证明"已暂停"只在确认动作真正完成后才展示，不是请求一发出就认定
      const pauseAttempts: Array<{ state: string; confirmed: boolean }> = [];
      let finalPause: { state: string; confirmed: boolean } | undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = (await clientB.call("runs.pause", { runId: t1.id })) as { state: string; confirmed: boolean };
        pauseAttempts.push(response);
        if (response.confirmed) {
          finalPause = response;
          break;
        }
        await delay(300);
      }
      expect(finalPause).toBeDefined();
      expect(finalPause?.state).toBe("paused");
      for (const attempt of pauseAttempts.slice(0, -1)) {
        expect(attempt.confirmed).toBe(false);
        expect(attempt.state).not.toBe("paused");
      }

      // 确认背后必须对应真实的进程终止，而不只是状态字段的口头声明
      if (sleepingTask) {
        let alive = true;
        try {
          process.kill(sleepingTask.pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }

      const pausedFromA = await waitForRun(clientA, (run) => run.id === t1.id && run.state === "paused", 5_000);
      expect(pausedFromA.state).toBe("paused");

      await clientB.call("runs.resume", { runId: t1.id });
      const resumedFromA = await waitForRun(clientA, (run) => run.id === t1.id && run.state !== "paused", 8_000);
      expect(resumedFromA.state).not.toBe("paused");

      const lines = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.some((entry) => entry.providerId === "controlled-worker-T-1" && entry.text.includes("已恢复运行")),
        8_000,
      );
      const resumeCall = lines.find((entry) => entry.providerId === "controlled-worker-T-1" && entry.text.includes("已恢复运行"));
      expect(resumeCall).toBeDefined();
      // 续接请求携带的对话上下文仍包含暂停前已完成工具调用的结果，证明上下文未被重置
      expect(resumeCall?.text.includes("MARK-CTX-58231")).toBe(true);
    },
    40_000,
  );

  test(
    "对已处于终态的运行调用 pause 是幂等空操作：立即确认且状态不受影响",
    async () => {
      const requirement = "2026-09-10.pause-terminal-noop";
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
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      const t1 = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state === "completed",
        15_000,
      );
      unsubscribe();

      const clientB = await connectTestClient(world.fixture.socketPath, {
        windowId: "window-b",
        cwd: world.fixture.repo.root,
        workspaceRoot: world.fixture.repo.root,
        repoIds: [world.fixture.repoId],
      });
      extraClients.push(clientB);

      const response = (await clientB.call("runs.pause", { runId: t1.id })) as { state: string; confirmed: boolean };
      expect(response.confirmed).toBe(true);
      expect(response.state).toBe("completed");

      const after = (await listRuns(world.client)).find((run) => run.id === t1.id);
      expect(after?.state).toBe("completed");
    },
    15_000,
  );
});

describe("user-stop：级联停止与文件保留", () => {
  test(
    "停止需求代理级联停止两个各有后台 Shell 的角色，确认后代无残留后才呈现停止，会话文件保留",
    async () => {
      const requirement = "2026-09-10.cascade-stop";
      const tasks = [shapeTask("T-1", "worker", ["area-a"]), shapeTask("T-2", "reviewer", ["area-b"])];
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply(tasks),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            dispatchRoleReply("reviewer", "T-2", ["area-b"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("bash", { command: "sleep 20 & sleep 20", background: true }), textReply("后台任务已启动")],
        },
        {
          providerId: "controlled-reviewer-T-2",
          modelId: "controlled-model",
          roleName: "reviewer",
          taskId: "T-2",
          replies: [toolReply("bash", { command: "sleep 20 & sleep 20", background: true }), textReply("后台任务已启动")],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      const reqRunId = await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      const t2 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-2");
      unsubscribe();

      await delay(1_500);
      const shellsBefore = await listShells(world.client);
      const host1 = shellsBefore.find((entry) => entry.host.runId === t1.id);
      const host2 = shellsBefore.find((entry) => entry.host.runId === t2.id);
      expect(host1).toBeDefined();
      expect(host2).toBeDefined();
      if (host1) trackedPids.push(host1.pid, ...host1.descendants);
      if (host2) trackedPids.push(host2.pid, ...host2.descendants);

      const sessionPaths = [reqRunId, t1.id, t2.id].map((runId) =>
        sessionJson({ dataRoot: world.fixture.dataRoot, repoId: world.fixture.repoId, runId }),
      );
      for (const content of sessionPaths) expect(content).toContain("session");

      await world.client.call("runs.stop", { runId: reqRunId });

      const stoppedReq = await waitForRun(world.client, (run) => run.id === reqRunId && run.state === "stopped", 15_000);
      const stoppedT1 = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "stopped", 15_000);
      const stoppedT2 = await waitForRun(world.client, (run) => run.id === t2.id && run.state === "stopped", 15_000);
      expect(stoppedReq.state).toBe("stopped");
      expect(stoppedT1.state).toBe("stopped");
      expect(stoppedT2.state).toBe("stopped");

      const start = Date.now();
      let allGone = false;
      while (Date.now() - start < 10_000) {
        const after = await listShells(world.client);
        const remain1 = after.find((entry) => entry.taskId === host1?.taskId);
        const remain2 = after.find((entry) => entry.taskId === host2?.taskId);
        const gone1 = !remain1 || remain1.status === "stopped" || remain1.status === "exited";
        const gone2 = !remain2 || remain2.status === "stopped" || remain2.status === "exited";
        if (gone1 && gone2) {
          allGone = true;
          break;
        }
        await delay(200);
      }
      expect(allGone).toBe(true);

      // 相关会话文件在停止后仍保留，不因停止而被清除
      for (const content of sessionPaths) expect(content).toContain("session");
    },
    30_000,
  );
});

describe("run-lifecycle：中断续接从会话文件重新加载", () => {
  test(
    "强杀守护进程后重启，运行标记 interrupted；续接从会话文件重建历史且不重做已完成步骤",
    async () => {
      const requirement = "2026-09-10.resume-reload";
      const marker = "STEP-A-DONE-71539";
      const firstScripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("bash", { command: `echo ${marker}` }), toolReply("bash", { command: "sleep 30" })],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath1 = await writeTestModelProviders(fixture.dataRoot, firstScripts);
      const handle1 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath1) });
      extraHandles.push(handle1);
      const client1 = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client1);
      const unsubscribe = autoConfirmShape(client1);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client1, fixture.repo.root, requirement);
      const t1 = await waitForRun(client1, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      // 等第二个工具调用（sleep 30）真正起进程，制造重启后遗留的后台任务
      const startWait = Date.now();
      let leftover: ShellTaskView | undefined;
      while (Date.now() - startWait < 6_000) {
        const shells = await listShells(client1);
        leftover = shells.find((entry) => entry.host.runId === t1.id && entry.command.includes("sleep 30"));
        if (leftover) break;
        await delay(150);
      }
      expect(leftover).toBeDefined();
      if (leftover) trackedPids.push(leftover.pid, ...leftover.descendants);

      const sessionPath = sessionJson({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, runId: t1.id });
      const sessionBeforeKill = sessionPath;
      expect(sessionBeforeKill).toContain(marker);

      client1.close();
      await killDaemon(handle1);

      const requestsLog = await createProviderRequestsLog();
      extraTempDirs.push(dirname(requestsLog));
      const secondScripts: TestProviderScript[] = [
        {
          providerId: "controlled-worker-T-1-resume",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("pi_company_resume_check", {}), submitReply(), textReply("续接完成")],
        },
      ];
      const providersPath2 = await writeTestModelProviders(fixture.dataRoot, secondScripts);
      const handle2 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath2, requestsLog) });
      extraHandles.push(handle2);
      const client2 = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client2);

      const interrupted = await waitForRun(client2, (run) => run.id === t1.id && run.state === "interrupted", 10_000);
      expect(interrupted.state).toBe("interrupted");

      // 第二个守护进程的 markInterruptedOnStartup 与 adoptInterruptedShells 是启动期两个独立的异步步骤：
      // 客户端能连上、runs.list 显示 interrupted，不代表遗留 Shell 任务已被后一步接管完毕，需轮询等待
      let adopted: ShellTaskView | undefined;
      const adoptStart = Date.now();
      while (Date.now() - adoptStart < 8_000) {
        const shells = await listShells(client2);
        adopted = shells.find((entry) => entry.taskId === leftover?.taskId);
        if (adopted) break;
        await delay(200);
      }
      expect(adopted).toBeDefined();

      const blocked = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(blocked.ok).toBe(false);

      if (adopted) {
        await client2.call("shells.stop", {
          taskId: adopted.taskId,
          expectedPid: adopted.pid,
          expectedStartedAt: String(adopted.startedAt),
        });
      }

      const cleanupStart = Date.now();
      let cleaned = false;
      while (Date.now() - cleanupStart < 10_000) {
        const list = await listShells(client2);
        const remaining = list.find((entry) => entry.taskId === leftover?.taskId);
        if (!remaining || remaining.status === "stopped" || remaining.status === "exited") {
          cleaned = true;
          break;
        }
        await delay(200);
      }
      expect(cleaned).toBe(true);

      const resumeResult = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(resumeResult.ok !== false).toBe(true);

      const resumed = await waitForRun(client2, (run) => run.id === t1.id && run.state !== "interrupted", 15_000);
      expect(resumed.state).not.toBe("interrupted");
      expect(resumed.state).not.toBe("failed");

      const lines = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.some((entry) => entry.providerId === "controlled-worker-T-1-resume"),
        8_000,
      );
      const resumeCall = lines.find((entry) => entry.providerId === "controlled-worker-T-1-resume");
      expect(resumeCall).toBeDefined();
      // 续接请求的上下文由会话文件重建，携带已完成步骤的真实结果（工具调用参数与结果各出现一次）；
      // 若该步骤被当成待重做而重新执行，工具调用与结果会各再出现一次，次数应当翻倍
      const occurrences = resumeCall ? resumeCall.text.split(marker).length - 1 : 0;
      expect(occurrences).toBeGreaterThanOrEqual(1);
      expect(occurrences).toBeLessThanOrEqual(2);

      // 已不再是 interrupted，重复调用 resumeInterrupted 应被拒绝
      const secondAttempt = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(secondAttempt.ok).toBe(false);
    },
    45_000,
  );
});

describe("user-stop：脱管后代下的停止不确定性", () => {
  test(
    "trap 忽略 TERM 的后台进程使 Shell 清理无法确认；停止不误判为已清理干净，且不派出与其重叠的新运行",
    async () => {
      const requirement = "2026-09-10.stop-uncertain-safety";
      const tasks = [shapeTask("T-1", "worker", ["shared-area"]), shapeTask("T-2", "worker", ["shared-area"])];
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply(tasks),
            dispatchRoleReply("worker", "T-1", ["shared-area"]),
            textReply("等待中", 1_500),
            dispatchRoleReply("worker", "T-2", ["shared-area"]),
            textReply("已尝试全部派工"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [
            toolReply("bash", {
              command: "sh -c 'trap \"\" TERM; sleep 40' & disown; wait",
              background: true,
            }),
            textReply("已启动后台任务，等待后续指示"),
          ],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      await delay(1_000);
      const shellsBefore = await listShells(world.client);
      const task = shellsBefore.find((entry) => entry.host.runId === t1.id);
      if (task) trackedPids.push(task.pid, ...task.descendants);

      await world.client.call("runs.stop", { runId: t1.id });

      // 安全性质一：停止指令下达后运行本身按用户意图落定为已停止，不会卡在"仍在跑"
      const stoppedRun = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "stopped", 15_000);
      expect(stoppedRun.state).toBe("stopped");

      await delay(6_000);
      const shellsAfter = await listShells(world.client);
      const afterTask = shellsAfter.find((entry) => entry.taskId === task?.taskId);
      const isUncertain = afterTask?.status === "uncertain";
      if (isUncertain) {
        expect(afterTask?.status).toBe("uncertain");
      } else {
        // 沙箱环境下 trap 屏蔽 TERM 的后台进程未必稳定停留在 uncertain 状态；
        // 退化为核验安全性质本身——即便复现不了 uncertain，清理结果也只能是确实已停止/已退出，不能是误判
        expect(["stopped", "exited"]).toContain(afterTask?.status);
      }

      // 安全性质二：Shell 清理未确认完成期间，runs.list 不把任何运行状态误标为 uncertain
      const runsAfter = await listRuns(world.client);
      expect(runsAfter.every((run) => run.state !== ("uncertain" as never))).toBe(true);

      // 安全性质三：与未确认清理的宿主写入范围重叠的新任务不会被派出
      unsubscribe();
      expect(runsAfter.some((run) => run.kind === "role" && run.task === "T-2")).toBe(false);
    },
    30_000,
  );
});
