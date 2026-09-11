import { uuidv7 } from "../../runtime/database.ts";
import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectTestClient,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  startDaemonForTest,
} from "../helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "../helpers/daemon-harness.ts";
import {
  connectivityProbeEnv,
  modelProviderEnv,
  writeNetworkReachableFile,
  writeTestModelProviders,
} from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { createFakeTimeSource, withClockPump } from "../helpers/fake-clock.ts";
import { appendDecision } from "../../runtime/decisions.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { createClock } from "../../runtime/clock.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { startHeartbeat, WindowRegistry } from "../../runtime/windows.ts";

interface World {
  fixture: DaemonFixture;
  handle: DaemonHandle;
  client: TestClient;
}

const activeWorlds: World[] = [];
const plainTempDirs: string[] = [];
const spawnedPgids: number[] = [];

afterEach(async () => {
  for (const world of activeWorlds.splice(0)) {
    world.client.close();
    await killDaemon(world.handle).catch(() => undefined);
    await removeDaemonFixture(world.fixture).catch(() => undefined);
  }
  for (const dir of plainTempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
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
  return { type: "text", text, chunkDelayMs };
}

function shapeTask(id: string, role: string, writePaths: string[]): Record<string, unknown> {
  return { id, title: `任务 ${id}`, roles: [role], dependsOn: [], writePaths };
}

function proposeShapeReply(tasks: Array<Record<string, unknown>>): ScriptedReply {
  return toolReply("pi_company_propose_shape", {
    tasks,
    gates: { whiteboxReview: false, blackboxAcceptance: false },
    rationale: "network-and-sleep 集成测试固定形状",
  });
}

function dispatchRoleReply(role: string, task: string, writePaths: string[]): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role, task, writePaths, readPaths: [] });
}

function validWorkResult(): Record<string, unknown> {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "network-and-sleep 集成测试固定完成",
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
      impact: "network-and-sleep 集成测试固定路径",
    },
    { dataRoot, cwd },
  );
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId },
    { dataRoot, cwd },
  );
  if (result.details.isError) throw new Error(`测试固件未能确认需求: ${result.text}`);
}

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
  stateReason?: string;
}

async function listRuns(client: TestClient): Promise<RunView[]> {
  const result = await client.call("runs.list", { limit: 200 });
  return result.items as RunView[];
}

async function waitForRun(client: TestClient, predicate: (run: RunView) => boolean, timeoutMs = 15_000): Promise<RunView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await listRuns(client);
    const found = runs.find(predicate);
    if (found) return found;
    await delay(150);
  }
  throw new Error(`等待目标运行超时: ${JSON.stringify((await listRuns(client)).map(({ task, state, stateReason }) => ({ task, state, stateReason })))}`);
}

describe("pause-control：断网局部暂停", () => {
  test(
    "受控 provider 抛连接类故障后只有受影响的运行进入 paused_network，同批次另一角色不受影响",
    async () => {
      const requirement = "2026-09-10.network-partial-pause";
      const reachableDir = await mkdtemp(join(tmpdir(), "network-reachable-"));
      const reachableFile = join(reachableDir, "reachable.txt");
      await writeNetworkReachableFile(reachableFile, false);

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
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [{ type: "error", message: "fetch failed: 网络连接被重置 (network)" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
        {
          providerId: "controlled-worker-T-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-2",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const world = await startWorld(scripts, connectivityProbeEnv(reachableFile, 500));
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const pausedT1 = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state === "paused_network",
        15_000,
      );
      const completedT2 = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-2" && run.state === "completed",
        15_000,
      );
      unsubscribe();

      expect(pausedT1.state).toBe("paused_network");
      expect(completedT2.state).toBe("completed");

      const stillPaused = (await listRuns(world.client)).find((run) => run.id === pausedT1.id);
      expect(stillPaused?.state).toBe("paused_network");

      await rm(reachableDir, { recursive: true, force: true });
    },
    30_000,
  );
});

describe("pause-control：故障分类", () => {
  test(
    "认证错误、额度错误、业务错误均直接结算为 failed 且各自保留真实归因，不进入 paused_network",
    async () => {
      const requirement = "2026-09-10.failure-classification";
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([
              shapeTask("T-1", "worker", ["area-a"]),
              shapeTask("T-2", "worker", ["area-b"]),
              shapeTask("T-3", "worker", ["area-c"]),
            ]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            dispatchRoleReply("worker", "T-2", ["area-b"]),
            dispatchRoleReply("worker", "T-3", ["area-c"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [{ type: "error", message: "unauthorized: invalid api key supplied" }],
        },
        {
          providerId: "controlled-worker-T-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-2",
          replies: [{ type: "error", message: "quota exceeded for this billing period" }],
        },
        {
          providerId: "controlled-worker-T-3",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-3",
          replies: [{ type: "error", message: "请求参数不合法，缺少必填字段" }],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const failedT1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1" && run.state === "failed", 15_000);
      const failedT2 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-2" && run.state === "failed", 15_000);
      const failedT3 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-3" && run.state === "failed", 15_000);
      unsubscribe();

      expect(failedT1.state).toBe("failed");
      expect(failedT1.stateReason ?? "").toContain("invalid api key");
      expect(failedT2.state).toBe("failed");
      expect(failedT2.stateReason ?? "").toContain("quota exceeded");
      expect(failedT3.state).toBe("failed");
      expect(failedT3.stateReason ?? "").toContain("请求参数不合法");
    },
    30_000,
  );
});

describe("pause-control：联网自动续接与手动暂停并存", () => {
  test(
    "网络恢复后仅网络暂停的运行核对续接并通知，手动暂停的运行保持不变",
    async () => {
      const requirement = "2026-09-10.network-resume-with-manual-pause";
      const reachableDir = await mkdtemp(join(tmpdir(), "network-reachable-"));
      const reachableFile = join(reachableDir, "reachable.txt");
      await writeNetworkReachableFile(reachableFile, false);

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
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [{ type: "error", message: "fetch failed: 网络连接被重置 (network)" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
        {
          providerId: "controlled-worker-T-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-2",
          replies: [toolReply("bash", { command: "sleep 15" })],
        },
      ];
      const world = await startWorld(scripts, connectivityProbeEnv(reachableFile, 500));
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const pausedNet = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state === "paused_network",
        15_000,
      );
      const t2 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-2");
      unsubscribe();

      await world.client.call("runs.pause", { runId: t2.id });
      const pausedManual = await waitForRun(world.client, (run) => run.id === t2.id && run.state === "paused", 8_000);
      expect(pausedManual.state).toBe("paused");

      let notified = false;
      const stopNotice = world.client.onEvent("relay.notice", () => {
        notified = true;
      });
      const stopChanged = world.client.onEvent("runs.changed", (data) => {
        const run = data.run as { id?: string; state?: string } | undefined;
        if (run?.id === pausedNet.id && run.state === "running") notified = true;
      });

      // 探测间隔已注入为 500ms：先让至少一轮探测读到"不可达"基线，再写 reachable 触发下一轮探测检出恢复
      await delay(700);
      await writeNetworkReachableFile(reachableFile, true);

      const recovered = await waitForRun(world.client, (run) => run.id === pausedNet.id && run.state === "running", 5_000);
      expect(recovered.state).toBe("running");

      await delay(1_000);
      stopNotice();
      stopChanged();
      expect(notified).toBe(true);

      const stillManualPaused = (await listRuns(world.client)).find((run) => run.id === t2.id);
      expect(stillManualPaused?.state).toBe("paused");

      await rm(reachableDir, { recursive: true, force: true });
    },
    30_000,
  );
});

describe("daemon-host：睡眠不计入超时", () => {
  test(
    "空闲计时不因注入的 5 分钟时钟跳变判定空闲退出",
    async () => {
      const fixture = await createDaemonFixture();
      const skewFile = join(fixture.home.home, "clock-skew.json");
      await writeFile(skewFile, "0");
      const idleTimeoutMs = 3_000;
      const handle = await startDaemonForTest(fixture, { idleTimeoutMs, clockSkewFile: skewFile });
      try {
        await delay(500);
        await writeFile(skewFile, String(5 * 60 * 1000));
        await delay(500);
        expect(handle.proc.exitCode).toBeNull();
        expect(handle.proc.signalCode).toBeNull();
      } finally {
        await killDaemon(handle).catch(() => undefined);
        await removeDaemonFixture(fixture).catch(() => undefined);
      }
    },
    15_000,
  );

  test(
    "共用同一把时钟的 60 秒超时后台 Shell 与窗口心跳，在 5 分钟跳变后均不判定为超时或失联",
    async () => {
      const timeSource = createFakeTimeSource();
      const clock = createClock({ timeSource });
      const shellRegistry = new ShellRegistry({ clock });
      const taskId = randomUUID();
      const spawned = await shellRegistry.spawn({
        taskId,
        host: { kind: "main", id: "sleep-test-window" },
        command: "sh",
        args: ["-c", "sleep 300"],
        mode: "background",
        timeoutSeconds: 60,
        runToken: randomUUID(),
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      spawnedPgids.push(spawned.task.pgid);

      const windowRepoDir = await mkdtemp(join(tmpdir(), "sleep-test-window-repo-"));
      plainTempDirs.push(windowRepoDir);
      const windowId = uuidv7();
      const windowRegistry = new WindowRegistry({
        repoDir: windowRepoDir,
        clock,
        bootId: async () => "boot-fixed",
        processStartedAt: async (pid: number) => `start-${pid}`,
      });
      await windowRegistry.register({
        windowId,
        pid: process.pid,
        sessionId: "sleep-test-session",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const stopHeartbeat = startHeartbeat(windowRegistry, windowId);

      try {
        timeSource.jump(5 * 60_000);
        await delay(50);

        expect(shellRegistry.get(taskId)?.status).not.toBe("timed_out");
        expect(await windowRegistry.isAlive(windowId)).toBe(true);
        const holderGone = await windowRegistry.holderGone(windowId);
        expect(holderGone.gone).toBe(false);
      } finally {
        stopHeartbeat();
        await withClockPump(timeSource, () => shellRegistry.stop(taskId)).catch(() => {});
        await windowRegistry.unregister(windowId).catch(() => {});
      }
    },
    15_000,
  );
});
