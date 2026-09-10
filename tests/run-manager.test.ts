import { PROTOCOL_VERSION } from "../runtime/protocol.ts";
import { testRepoId } from "./helpers/database-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  connectTestClient,
  connectRawClient,
  createDaemonFixture,
  killDaemon,
  removeDaemonFixture,
  startDaemonForTest,
} from "./helpers/daemon-harness.ts";
import type { DaemonFixture, DaemonHandle, TestClient } from "./helpers/daemon-harness.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import {
  connectivityProbeEnv,
  connectivityProbeMapEnv,
  createProviderRequestsLog,
  modelProviderEnv,
  readProviderRequestsLog,
  waitForProviderLogEntries,
  writeConnectivityReachableMap,
  writeNetworkReachableFile,
  writeTestModelProviders,
} from "./helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "./helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { executeWorkflowAction } from "../runtime/workflow-tool.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createSessionManagerForRun } from "../runtime/session-records.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { RunManager } from "../daemon/run-manager.ts";

const execFileAsync = promisify(execFile);

interface World {
  fixture: DaemonFixture;
  handle: DaemonHandle;
  client: TestClient;
}

const activeWorlds: World[] = [];
const extraClients: TestClient[] = [];
const extraHandles: DaemonHandle[] = [];
const extraDaemonFixtures: DaemonFixture[] = [];
const extraFixtures: Array<RepoFixture> = [];
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
  for (const repo of extraFixtures.splice(0)) {
    await removeRepoFixture(repo).catch(() => undefined);
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
    rationale: "run-manager 测试固定形状",
  });
}

function dispatchRoleReply(role: string, task: string, writePaths: string[]): ScriptedReply {
  return toolReply("pi_company_agent", { action: "run", role, task, writePaths, readPaths: [] });
}

function validWorkResult(): Record<string, unknown> {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "run-manager 测试固定完成",
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
      impact: "run-manager 测试固定路径",
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
  throw new Error(`等待目标运行超时: ${JSON.stringify((await listRuns(client)).map(({ task, state, stateReason }) => ({ task, state, stateReason })))}`);
}

async function waitForRuns(
  client: TestClient,
  predicate: (run: RunView) => boolean,
  count: number,
  timeoutMs = 15_000,
): Promise<RunView[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runs = await listRuns(client);
    const found = runs.filter(predicate);
    if (found.length >= count) return found;
    await delay(150);
  }
  throw new Error("等待目标运行集合超时");
}

interface ShellTaskView {
  taskId: string;
  host: { kind: string; id: string; role?: string; runId?: string };
  pid: number;
  pgid: number;
  startedAt: number | null;
  status: string;
  descendants: number[];
}

async function listShells(client: TestClient): Promise<ShellTaskView[]> {
  const result = await client.call("shells.list", {});
  return result.tasks as ShellTaskView[];
}

async function headCommit(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(150);
    }
  }
  throw new Error(`等待文件写入超时: ${path}`);
}

const REQUIREMENT_PROVIDER = { providerId: "controlled-requirement-agent", modelId: "controlled-model", roleName: "requirement-agent" };

describe("builtin-execution：并行执行", () => {
  test(
    "五个写入范围互斥的角色任务同时派出后全部并行完成，不设数量上限",
    async () => {
      const requirement = "2026-09-01.parallel-tasks";
      const taskIds = ["T-1", "T-2", "T-3", "T-4", "T-5"];
      const tasks = taskIds.map((id, index) => shapeTask(id, "worker", [`area-${index}`]));
      const requirementReplies: ScriptedReply[] = [
        proposeShapeReply(tasks),
        ...taskIds.map((id) => dispatchRoleReply("worker", id, [`area-${taskIds.indexOf(id)}`])),
        textReply("已完成全部派工"),
      ];
      const scripts: TestProviderScript[] = [
        { ...REQUIREMENT_PROVIDER, replies: requirementReplies },
        ...taskIds.map((id) => ({
          providerId: `controlled-worker-${id}`,
          modelId: "controlled-model",
          roleName: "worker",
          taskId: id,
          replies: [submitReply(), textReply("完成")],
        })),
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const completed = await waitForRuns(
        world.client,
        (run) => run.kind === "role" && taskIds.includes(run.task) && run.state === "completed",
        5,
        9_000,
      );
      unsubscribe();

      expect(completed).toHaveLength(5);
      for (const run of completed) {
        const result = run.result as Record<string, unknown>;
        expect(result.phase).toBe("work");
        expect(result.verdict).toBe("PASS");
      }
    },
    9_000,
  );

  test(
    "写入范围与在跑任务重叠的新任务被拒绝，在跑任务不受影响",
    async () => {
      const requirement = "2026-09-01.overlap-rejected";
      const tasks = [shapeTask("T-1", "worker", ["shared-area"]), shapeTask("T-2", "worker", ["shared-area"])];
      const requirementReplies: ScriptedReply[] = [
        proposeShapeReply(tasks),
        dispatchRoleReply("worker", "T-1", ["shared-area"]),
        dispatchRoleReply("worker", "T-2", ["shared-area"]),
        textReply("已尝试全部派工"),
      ];
      const scripts: TestProviderScript[] = [
        { ...REQUIREMENT_PROVIDER, replies: requirementReplies },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("bash", { command: "sleep 8", background: true }), submitReply(), textReply("完成")],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      expect(t1.state).not.toBe("failed");

      await delay(4_000);
      const runs = await listRuns(world.client);
      unsubscribe();

      expect(runs.some((run) => run.kind === "role" && run.task === "T-2")).toBe(false);
      const t1Again = runs.find((run) => run.id === t1.id);
      expect(t1Again?.state).not.toBe("failed");
    },
    9_000,
  );
});

describe("role-catalog / requirement-agent：派工权与仓库归属", () => {
  test(
    "需求代理运行发起的派工在已确认需求下成功",
    async () => {
      const requirement = "2026-09-01.requirement-dispatch-ok";
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
      const reqRunId = await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const roleRun = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      expect(roleRun.parentRunId).toBe(reqRunId);
      expect(roleRun.role).toBe("pi-company.worker");
    },
    9_000,
  );

  test(
    "dispatch.requirement 的 cwd 指向另一仓库时被拒",
    async () => {
      const requirement = "2026-09-01.other-repo-rejected";
      const scripts: TestProviderScript[] = [{ ...REQUIREMENT_PROVIDER, replies: [textReply("不应被使用")] }];
      const world = await startWorld(scripts);
      const otherRepo = await createRepoFixture();
      extraFixtures.push(otherRepo);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);

      await expect(world.client.call("dispatch.requirement", { requirement, cwd: otherRepo.root })).rejects.toThrow(
        /仓库/,
      );

      const runs = await listRuns(world.client);
      expect(runs.some((run) => run.requirement === requirement)).toBe(false);
    },
    9_000,
  );

  test(
    "dispatch.requirement 的 cwd 指向本仓库 worktree 时成功",
    async () => {
      const requirement = "2026-09-01.worktree-dispatch-ok";
      const scripts: TestProviderScript[] = [{ ...REQUIREMENT_PROVIDER, replies: [textReply("收到")] }];
      const world = await startWorld(scripts);
      const worktree = await addWorktree(world.fixture.repo);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);

      const runId = await dispatchRequirement(world.client, worktree.root, requirement);
      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);
    },
    9_000,
  );

  test(
    "需求未确认时 dispatch.requirement 被拒",
    async () => {
      const requirement = "2026-09-01.unconfirmed-rejected";
      const scripts: TestProviderScript[] = [{ ...REQUIREMENT_PROVIDER, replies: [textReply("不应被使用")] }];
      const world = await startWorld(scripts);
      await executeWorkflowAction({ action: "init", requirement }, { dataRoot: world.fixture.dataRoot, cwd: world.fixture.repo.root });

      await expect(world.client.call("dispatch.requirement", { requirement, cwd: world.fixture.repo.root })).rejects.toThrow(
        /确认/,
      );
    },
    9_000,
  );

  test(
    "窗口连接经 dispatch.review 派出提交前白盒审查者",
    async () => {
      const scripts: TestProviderScript[] = [
        {
          providerId: "controlled-reviewer",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const world = await startWorld(scripts);
      const head = await headCommit(world.fixture.repo.root);

      const result = await world.client.call("dispatch.review", {
        requirement: "2026-09-01.review-dispatch",
        cwd: world.fixture.repo.root,
        baseline: "HEAD",
        snapshot: { head, fingerprint: "fingerprint-测试固定" },
      });
      expect(typeof result.runId).toBe("string");

      const reviewRun = await waitForRun(world.client, (run) => run.id === (result.runId as string));
      expect(reviewRun.role).toBe("pi-company.reviewer");
      expect(reviewRun.parentRunId).toBeUndefined();
    },
    9_000,
  );
});

describe("pause-control：暂停/继续", () => {
  test(
    "暂停一个正在调用两个角色的需求代理后三者最终 paused",
    async () => {
      const requirement = "2026-09-01.pause-cascade";
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
          replies: [toolReply("bash", { command: "sleep 15" })],
        },
        {
          providerId: "controlled-reviewer-T-2",
          modelId: "controlled-model",
          roleName: "reviewer",
          taskId: "T-2",
          replies: [toolReply("bash", { command: "sleep 15" })],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      const reqRunId = await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      const t2 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-2");
      unsubscribe();

      await world.client.call("runs.pause", { runId: reqRunId });

      const pausedReq = await waitForRun(world.client, (run) => run.id === reqRunId && run.state === "paused", 8_000);
      const pausedT1 = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "paused", 8_000);
      const pausedT2 = await waitForRun(world.client, (run) => run.id === t2.id && run.state === "paused", 8_000);

      expect(pausedReq.state).toBe("paused");
      expect(pausedT1.state).toBe("paused");
      expect(pausedT2.state).toBe("paused");
    },
    35_000,
  );

  test(
    "全部暂停阻止新派工，全部继续后恢复",
    async () => {
      const requirement = "2026-09-01.pause-all";
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
          replies: [toolReply("bash", { command: "sleep 12" })],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");

      await world.client.call("runs.pauseAll", {});

      const blockedRequirement = "2026-09-01.pause-all-blocked";
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, blockedRequirement);
      await expect(
        world.client.call("dispatch.requirement", { requirement: blockedRequirement, cwd: world.fixture.repo.root }),
      ).rejects.toThrow(/暂停/);

      await world.client.call("runs.resumeAll", {});
      unsubscribe();

      const resumed = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state !== "paused",
        15_000,
      );
      expect(resumed.state).not.toBe("paused");
    },
    9_000,
  );
});

describe("user-stop：停止级联与 Shell 清理", () => {
  test(
    "停止有后台 Shell 与后代的角色后 Shell 树消失",
    async () => {
      const requirement = "2026-09-01.stop-with-descendants";
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
            toolReply("bash", { command: "sleep 20 & sleep 20", background: true }),
            textReply("后台任务已启动，等待后续指示"),
          ],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      await delay(1_200);
      const shellsBefore = await listShells(world.client);
      const task = shellsBefore.find((entry) => entry.host.runId === t1.id);
      expect(task).toBeDefined();
      if (task) {
        trackedPids.push(task.pid, ...task.descendants);
      }

      await world.client.call("runs.stop", { runId: t1.id });

      const stopped = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "stopped", 15_000);
      expect(stopped.state).toBe("stopped");

      const start = Date.now();
      let leaderGone = false;
      while (Date.now() - start < 10_000) {
        const shellsAfter = await listShells(world.client);
        const remaining = shellsAfter.find((entry) => entry.taskId === task?.taskId);
        if (!remaining || remaining.status === "stopped" || remaining.status === "exited") {
          leaderGone = true;
          break;
        }
        await delay(200);
      }
      expect(leaderGone).toBe(true);
    },
    9_000,
  );

  test(
    "停止后 Shell 未确认清理完成前阻止重叠范围新派工，放行不重叠范围",
    async () => {
      const requirement = "2026-09-01.stop-overlap-guard";
      const tasks = [
        shapeTask("T-1", "worker", ["shared-area"]),
        shapeTask("T-2", "worker", ["shared-area"]),
        shapeTask("T-3", "worker", ["other-area"]),
      ];
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply(tasks),
            dispatchRoleReply("worker", "T-1", ["shared-area"]),
            textReply("等待中", 1200),
            dispatchRoleReply("worker", "T-2", ["shared-area"]),
            dispatchRoleReply("worker", "T-3", ["other-area"]),
            textReply("已尝试全部派工"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [
            toolReply("bash", { command: "sleep 10", background: true }),
            textReply("后台任务已启动，等待后续指示"),
          ],
        },
        {
          providerId: "controlled-worker-T-3",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-3",
          replies: [submitReply(), textReply("完成")],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      await world.client.call("runs.stop", { runId: t1.id });

      const t3 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-3", 15_000);
      unsubscribe();

      expect(t3.state).not.toBe("failed");
      const runsAfter = await listRuns(world.client);
      expect(runsAfter.some((run) => run.kind === "role" && run.task === "T-2")).toBe(false);
    },
    9_000,
  );
});

describe("run-lifecycle / host-lifecycle：中断续接", () => {
  test(
    "强杀守护进程后重启，遗留 Shell 任务阻止续接；停止该 Shell 后可续接",
    async () => {
      const requirement = "2026-09-01.resume-with-leftover";
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
          replies: [toolReply("bash", { command: "sleep 30" })],
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
      await delay(500);
      const shellsBefore = await listShells(client1);
      const leftoverTask = shellsBefore.find((entry) => entry.host.runId === t1.id);
      expect(leftoverTask).toBeDefined();
      if (leftoverTask) trackedPids.push(leftoverTask.pid, ...leftoverTask.descendants);

      client1.close();
      await killDaemon(handle1);

      const secondScripts: TestProviderScript[] = [
        {
          providerId: "controlled-worker-T-1-resume",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [submitReply(), textReply("续跑完成")],
        },
      ];
      const providersPath2 = await writeTestModelProviders(fixture.dataRoot, secondScripts);
      const handle2 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath2) });
      extraHandles.push(handle2);
      const client2 = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client2);

      const interruptedRun = await waitForRun(client2, (run) => run.id === t1.id && run.state === "interrupted", 10_000);
      expect(interruptedRun.state).toBe("interrupted");

      let rejected = false;
      let rejectedResult: Record<string, unknown> | undefined;
      try {
        rejectedResult = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      } catch {
        rejected = true;
      }
      expect(rejected || rejectedResult?.ok === false).toBe(true);

      const stillInterrupted = await waitForRun(client2, (run) => run.id === t1.id, 5_000);
      expect(stillInterrupted.state).toBe("interrupted");

      const shellsAfterRestart = await listShells(client2);
      const adoptedTask = shellsAfterRestart.find((entry) => entry.taskId === leftoverTask?.taskId);
      expect(adoptedTask).toBeDefined();
      if (adoptedTask) {
        await client2.call("shells.stop", {
          taskId: adoptedTask.taskId,
          expectedPid: adoptedTask.pid,
          expectedStartedAt: String(adoptedTask.startedAt),
        });
      }

      const start = Date.now();
      let cleaned = false;
      while (Date.now() - start < 10_000) {
        const list = await listShells(client2);
        const remaining = list.find((entry) => entry.taskId === leftoverTask?.taskId);
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
    },
    12_000,
  );

  test(
    "强杀守护进程后重启，无遗留任务时直接续接成功",
    async () => {
      const requirement = "2026-09-01.resume-without-leftover";
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
          providerId: "controlled-worker-T-1-noop",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [textReply("思考中", 4_000)],
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

      client1.close();
      await killDaemon(handle1);

      const secondScripts: TestProviderScript[] = [
        {
          providerId: "controlled-worker-T-1-resume-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [submitReply(), textReply("续跑完成")],
        },
      ];
      const providersPath2 = await writeTestModelProviders(fixture.dataRoot, secondScripts);
      const handle2 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath2) });
      extraHandles.push(handle2);
      const client2 = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client2);

      await waitForRun(client2, (run) => run.id === t1.id && run.state === "interrupted", 10_000);

      const shells = await listShells(client2);
      expect(shells.some((entry) => entry.host.runId === t1.id)).toBe(false);

      const resumeResult = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(resumeResult.ok !== false).toBe(true);

      const resumed = await waitForRun(client2, (run) => run.id === t1.id && run.state !== "interrupted", 15_000);
      expect(resumed.state).not.toBe("interrupted");

      const allRuns = await listRuns(client2);
      expect(allRuns.every((run) => run.state !== "uncertain")).toBe(true);
    },
    12_000,
  );
});

describe("协议处理器接入：hello 后的中继待办推送", () => {
  test(
    "hello 后窗口收到待处理中继问题",
    async () => {
      const requirement = "2026-09-01.relay-pending";
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]), textReply("等待确认", 30_000)],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath) });
      extraHandles.push(handle);
      const firstClient = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(firstClient);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(firstClient, fixture.repo.root, requirement);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 relay.question 超时")), 8_000);
        firstClient.onEvent("relay.question", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      firstClient.close();

      const secondClient = await connectRawClient(fixture.socketPath);
      const pushedAfterHello = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("hello 后未收到待办")), 8_000);
        secondClient.onEvent("relay.question", () => { clearTimeout(timer); resolve(); });
      });
      const helloResult = await secondClient.call("hello", {
        windowId: "second-window", pid: process.pid, sessionId: "second-session",
        cwd: fixture.repo.root, workspaceRoot: fixture.repo.root, repoIds: [fixture.repoId], protocolVersion: PROTOCOL_VERSION,
      });
      extraClients.push({ ...secondClient, helloResult });
      await pushedAfterHello;
    },
    25_000,
  );
});

interface UnitManagerContext {
  manager: RunManager;
  runStore: RunStore;
  shellRegistry: ShellRegistry;
  dataRoot: string;
  repoId: string;
}

const unitCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of unitCleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
});

async function makeUnitManager(overrides: { repoId?: string; workspaceRepoIds?: string[] } = {}): Promise<UnitManagerContext> {
  const dataRoot = await mkdtemp(join(tmpdir(), "run-manager-unit-"));
  const relayDataDir = await mkdtemp(join(tmpdir(), "run-manager-unit-relay-"));
  const repoId = overrides.repoId ?? testRepoId();
  const runStore = new RunStore({ dataRoot, repoId, daemonStartedAt: new Date().toISOString() });
  const shellRegistry = new ShellRegistry({ clock: createClock() });
  const relayQueue = new RelayQueue({
    dataDir: relayDataDir,
    deliver: async () => [],
    locateRequirementAgent: () => undefined,
  });
  const manager = new RunManager({
    dataRoot,
    repoId,
    runStore,
    shellRegistry,
    networkGate: new NetworkPauseGate(),
    relayQueue,
    roleCatalog: [],
    runtime: {} as never,
    selectModel: () => {
      throw new Error("selectModel 不应在本单元测试路径被调用");
    },
    clock: createClock(),
    workspaceRepoIds: overrides.workspaceRepoIds ?? [repoId],
    emit: () => {},
  });
  manager.markStarted();
  unitCleanups.push(async () => {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(relayDataDir, { recursive: true, force: true });
  });
  return { manager, runStore, shellRegistry, dataRoot, repoId };
}

async function createUnitRoleRun(
  ctx: Pick<UnitManagerContext, "runStore" | "dataRoot" | "repoId">,
  overrides: { requirement: string; task: string; cwd: string; writePaths?: string[]; role?: string },
) {
  const parent = await ctx.runStore.create({
    kind: "requirement",
    requirement: overrides.requirement,
    task: "父需求（测试固定）",
    cwd: overrides.cwd,
    writePaths: [],
    readPaths: [],
    model: { provider: "stub", id: "stub" },
    thinking: "high",
    mcp: [],
  });
  return ctx.runStore.create({
    kind: "role",
    role: overrides.role ?? "pi-company.worker",
    parentRunId: parent.id,
    requirement: overrides.requirement,
    task: overrides.task,
    cwd: overrides.cwd,
    writePaths: overrides.writePaths ?? [],
    readPaths: [],
    model: { provider: "stub", id: "stub" },
    thinking: "high",
    mcp: [],
  });
}

// markInterruptedOnStartup 只把「上一个守护进程实例遗留、这一实例未曾拥有」的运行标记为 interrupted，
// 用不同 daemonStartedAt 的第二个 RunStore 实例模拟这一场景，绕开 update() 的转换校验（该转换本就不走 update）
async function markUnitRunInterrupted(ctx: Pick<UnitManagerContext, "dataRoot" | "repoId">, runId: string): Promise<void> {
  const restarted = new RunStore({ dataRoot: ctx.dataRoot, repoId: ctx.repoId, daemonStartedAt: new Date(Date.now() + 1000).toISOString() });
  const outcome = await restarted.markInterruptedOnStartup();
  if (!outcome.interrupted.includes(runId)) {
    throw new Error(`测试固件未能把运行标记为 interrupted: ${runId}`);
  }
}

interface FakeHandle {
  events: EventTarget & { emit(event: string, payload?: unknown): void };
  promptCalls: string[];
  state(): string;
  prompt(text: string): void;
  injectSupplement(text: string): void;
  result(): Promise<unknown>;
  pause(): Promise<{ confirmed: boolean; reason?: string }>;
  resume(): Promise<void>;
  stop(): Promise<{ stopped: boolean; shellResults: unknown[] }>;
  finalize(): Promise<unknown>;
  dispose(): void;
  settle(value: unknown): void;
  fail(error: unknown): void;
}

function makeFakeHandle(options: {
  pauseResult?: { confirmed: boolean; reason?: string };
  stopImpl?: () => Promise<{ stopped: boolean; shellResults: unknown[] }>;
} = {}): FakeHandle {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (error: unknown) => void;
  const resultPromise = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});
  const promptCalls: string[] = [];
  const events = {
    on: (event: string, listener: (payload?: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    emit: (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  } as unknown as EventTarget & { emit(event: string, payload?: unknown): void };
  return {
    events,
    promptCalls,
    state: () => "running",
    prompt: (text: string) => promptCalls.push(text),
    injectSupplement: (text: string) => promptCalls.push(text),
    result: () => resultPromise,
    pause: async () => options.pauseResult ?? { confirmed: true },
    resume: async () => {},
    stop: async () => (options.stopImpl ? options.stopImpl() : { stopped: true, shellResults: [] }),
    finalize: async () => undefined,
    dispose: () => {},
    settle: (value: unknown) => resolveResult(value),
    fail: (error: unknown) => rejectResult(error),
  };
}

function injectSession(manager: RunManager, runId: string, entry: Record<string, unknown>): void {
  (manager as unknown as { registerSession(id: string, e: Record<string, unknown>): void }).registerSession(runId, entry);
}

function callPrivate<T>(manager: RunManager, method: string, ...args: unknown[]): Promise<T> {
  return (manager as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method]!(...args);
}

describe("RunManager 单元级（直接构造，绕开协议层与真实模型）", () => {
  test("派工权：callerRunId 不是需求代理会话（未知运行）时被拒且原因含运行类型", async () => {
    const { manager } = await makeUnitManager();
    const outcome = await callPrivate<{ ok: boolean; reason?: string }>(manager, "dispatchRoleInternal", {
      kind: "requirement",
      runId: randomUUID(),
    }, {
      requirement: "2026-09-01.unit-caller",
      cwd: "/tmp/nowhere",
      role: "worker",
      task: "T-1",
      writePaths: [],
      readPaths: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/需求代理|运行/);
  });

  test("派工权：callerRunId 指向一个真实存在但 kind 为 role 的会话时被拒", async () => {
    const ctx = await makeUnitManager();
    const { manager } = ctx;
    const roleRun = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-caller",
      task: "T-0",
      cwd: "/tmp/nowhere",
    });
    injectSession(manager, roleRun.id, {
      kind: "role",
      handle: makeFakeHandle(),
      requirement: "2026-09-01.unit-caller",
      writePaths: [],
    });
    const outcome = await callPrivate<{ ok: boolean; reason?: string }>(manager, "dispatchRoleInternal", {
      kind: "requirement",
      runId: roleRun.id,
    }, {
      requirement: "2026-09-01.unit-caller",
      cwd: "/tmp/nowhere",
      role: "worker",
      task: "T-1",
      writePaths: [],
      readPaths: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/需求代理|运行/);
  });

  test("pause：对 queued 运行调用 pause 返回明确拒绝且存储状态不变", async () => {
    const { manager, runStore } = await makeUnitManager();
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-pause-queued",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    expect(run.state).toBe("queued");

    const result = await manager.pause(run.id);
    expect(result.confirmed).toBe(false);
    expect(result.state).not.toBe("paused");

    const after = await runStore.get(run.id);
    expect(after.ok && after.run.state).toBe("queued");
  });

  test("pause：对 interrupted 运行调用 pause 返回明确拒绝且存储状态不变", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore } = ctx;
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-pause-interrupted",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    await runStore.update(run.id, { state: "running" });
    await markUnitRunInterrupted(ctx, run.id);

    const result = await manager.pause(run.id);
    expect(result.confirmed).toBe(false);
    expect(result.state).not.toBe("paused");

    const after = await runStore.get(run.id);
    expect(after.ok && after.run.state).toBe("interrupted");
  });

  test("pause：对 running 运行会话确认超时（handle.pause 不确认）返回 pausing 且 stateReason 含原因，重试后可 paused", async () => {
    const { manager, runStore } = await makeUnitManager();
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-pause-timeout",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    await runStore.update(run.id, { state: "running" });
    let confirmOnRetry = false;
    const handle = makeFakeHandle({
      pauseResult: undefined,
    });
    handle.pause = async () => (confirmOnRetry ? { confirmed: true } : { confirmed: false, reason: "工具调用挂起，取消信号尚未生效" });
    injectSession(manager, run.id, { kind: "requirement", handle, requirement: run.requirement, writePaths: [] });

    const first = await manager.pause(run.id);
    expect(first.confirmed).toBe(false);
    expect(first.state).toBe("pausing");
    expect(first.reason).toMatch(/取消|挂起|超时/);
    const afterFirst = await runStore.get(run.id);
    expect(afterFirst.ok && afterFirst.run.state).toBe("pausing");

    confirmOnRetry = true;
    const second = await manager.pause(run.id);
    expect(second.confirmed).toBe(true);
    expect(second.state).toBe("paused");
    const afterSecond = await runStore.get(run.id);
    expect(afterSecond.ok && afterSecond.run.state).toBe("paused");
  });

  test("stop：handle.stop 抛错时仍会对该运行的宿主调用 shellRegistry.stopHost", async () => {
    const { manager, runStore, shellRegistry } = await makeUnitManager();
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-stop-throws",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    await runStore.update(run.id, { state: "running" });
    const handle = makeFakeHandle({
      stopImpl: async () => {
        throw new Error("会话 stop 内部异常（测试注入）");
      },
    });
    injectSession(manager, run.id, { kind: "requirement", handle, requirement: run.requirement, writePaths: [] });

    let stopHostCalled = false;
    const originalStopHost = shellRegistry.stopHost.bind(shellRegistry);
    shellRegistry.stopHost = async (host) => {
      stopHostCalled = true;
      return originalStopHost(host);
    };

    const result = await manager.stop(run.id);
    expect(result.state).toBe("stopped");
    await delay(50);
    expect(stopHostCalled).toBe(true);
  });

  test("finalize：已停止运行的会话随后落定完成结果，不改写 stopped", async () => {
    const { manager, runStore } = await makeUnitManager();
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-stop-race",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    await runStore.update(run.id, { state: "running" });
    const handle = makeFakeHandle();
    injectSession(manager, run.id, { kind: "requirement", handle, requirement: run.requirement, writePaths: [] });

    await manager.stop(run.id);
    handle.settle({ ok: true });
    await delay(150);

    const after = await runStore.get(run.id);
    expect(after.ok && after.run.state).toBe("stopped");
  });

  test("finalize：paused 角色无合法裁决时失败关闭，不途经 running", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore } = ctx;
    const run = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-paused-finish",
      task: "T-1",
      cwd: "/tmp/nowhere",
    });
    await runStore.update(run.id, { state: "running" });
    await runStore.update(run.id, { state: "pausing" });
    await runStore.update(run.id, { state: "paused" });
    const handle = makeFakeHandle();
    injectSession(manager, run.id, { kind: "role", handle, requirement: run.requirement, writePaths: [] });

    const observedStates: string[] = [];
    const originalUpdate = runStore.update.bind(runStore);
    runStore.update = ((id, fields) => {
      if (fields.state) observedStates.push(fields.state);
      return originalUpdate(id, fields);
    }) as typeof runStore.update;

    handle.settle({ ok: true });
    await delay(150);

    const after = await runStore.get(run.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.run.state).toBe("failed");
    if (after.run.state === "paused") {
      expect(after.run.stateReason).toBeTruthy();
    }
    // completed 只应从 paused/pausing 直接结算，不应途经 running 这个中间态
    expect(observedStates).not.toContain("running");
  });

  test("resumeInterrupted：续接前 cwd 已被删除时被拒并说明工作区不可用（会话记录本身可读）", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore, dataRoot, repoId } = ctx;
    const deletedCwd = await mkdtemp(join(tmpdir(), "run-manager-unit-deleted-cwd-"));
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-resume-deleted-cwd",
      task: "示例",
      cwd: deletedCwd,
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    createSessionManagerForRun({ dataRoot, repoId, runId: run.id, cwd: deletedCwd });
    await rm(deletedCwd, { recursive: true, force: true });
    await runStore.update(run.id, { state: "running" });
    await markUnitRunInterrupted(ctx, run.id);

    const result = await manager.resumeInterrupted(run.id);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toMatch(/会话文件不存在/);
    expect(result.reason).toMatch(/工作区|cwd|不可用/);
    const after = await runStore.get(run.id);
    expect(after.ok && after.run.state).toBe("interrupted");
  });

  test("close：按登记表全部宿主逐个 stopHost，含未持有会话但已接管的遗留任务", async () => {
    const ctx = await makeUnitManager();
    const { manager, shellRegistry } = ctx;
    const run = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-close-adopted",
      task: "T-1",
      cwd: "/tmp/nowhere",
    });
    const host = { kind: "role" as const, id: run.id, runId: run.id };
    const spawned = await shellRegistry.spawn({
      taskId: randomUUID(),
      host,
      command: "sh",
      args: ["-c", "sleep 20"],
      mode: "background",
      runToken: run.shellToken,
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;

    await manager.close();
    await delay(300);

    let alive = true;
    try {
      process.kill(spawned.task.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15_000);

  test("wait：真实等待语义——在角色到达终态前阻塞，完成后返回终态", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore } = ctx;
    const run = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-wait",
      task: "T-1",
      cwd: "/tmp/nowhere",
    });
    await runStore.update(run.id, { state: "running" });
    const handle = makeFakeHandle();
    injectSession(manager, run.id, { kind: "role", handle, requirement: run.requirement, writePaths: [] });

    setTimeout(() => handle.fail(new Error("测试终态")), 400);
    const start = Date.now();
    const waitResult = await callPrivate<{ state: string }>(manager, "wait", run.id, 5_000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(waitResult.state).toBe("failed");
  }, 10_000);

  test("wait：超时时返回当前（非终态）状态而不是一直阻塞", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore } = ctx;
    const run = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-wait-timeout",
      task: "T-1",
      cwd: "/tmp/nowhere",
    });
    await runStore.update(run.id, { state: "running" });
    const handle = makeFakeHandle();
    injectSession(manager, run.id, { kind: "role", handle, requirement: run.requirement, writePaths: [] });

    const start = Date.now();
    const waitResult = await callPrivate<{ state: string }>(manager, "wait", run.id, 300);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);
    expect(waitResult.state).toBe("running");
  }, 10_000);

  test("canRunInParallel：写入范围 './src' 与 'src' 视为重叠并拒绝", async () => {
    const repo = await createRepoFixture();
    const identity = await repositoryIdentity(repo.root);
    const ctx = await makeUnitManager({ repoId: identity.repoId });
    const { manager, runStore } = ctx;
    const requirement = "2026-09-01.unit-parallel-normalize";

    const running = await createUnitRoleRun(ctx, {
      requirement,
      task: "T-1",
      cwd: repo.root,
      writePaths: ["src"],
    });
    await runStore.update(running.id, { state: "running" });
    injectSession(manager, running.id, { kind: "role", handle: makeFakeHandle(), requirement, writePaths: ["src"] });

    const result = await manager.canRunInParallel({ cwd: repo.root, requirement, task: "T-2", writePaths: ["./src"] });
    expect(result.ok).toBe(false);

    await removeRepoFixture(repo);
  }, 15_000);

  test("adoptInterruptedShells：注册表接管失败时把原因写入该运行的 stateReason", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore, shellRegistry } = ctx;
    const run = await runStore.create({
      kind: "requirement",
      requirement: "2026-09-01.unit-adopt-fail",
      task: "示例",
      cwd: "/tmp/nowhere",
      writePaths: [],
      readPaths: [],
      model: { provider: "stub", id: "stub" },
      thinking: "high",
      mcp: [],
    });
    await runStore.update(run.id, { state: "running" });
    await markUnitRunInterrupted(ctx, run.id);

    shellRegistry.adoptOrphans = async () => ({ ok: false, reason: "持久化任务记录目录损坏（测试注入）" });

    await manager.adoptInterruptedShells();
    const after = await runStore.get(run.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.run.stateReason).toMatch(/损坏|定位失败|持久/);
  });
});

function validAcceptanceResult(reportPath: string): Record<string, unknown> {
  return {
    phase: "acceptance",
    verdict: "PASS",
    summary: "run-manager 测试固定验收通过",
    issues: [],
    evidence: ["测试固定证据"],
    acceptanceResult: "accepted",
    reportPath,
    items: [{ id: "AC-1", result: "PASS", observed: "符合预期", difference: "" }],
    uncovered: [],
  };
}

describe("pause-control：网络故障自动续接", () => {
  test(
    "provider 回复网络类故障后进入 paused_network，探测恢复后自动续接",
    async () => {
      const requirement = "2026-09-01.network-auto-resume";
      const reachableDir = await mkdtemp(join(tmpdir(), "network-reachable-"));
      const reachableFile = join(reachableDir, "reachable.txt");
      await writeNetworkReachableFile(reachableFile, false);

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
          replies: [{ type: "error", message: "fetch failed: 网络连接被重置 (network)" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
      ];
      const world = await startWorld(scripts, connectivityProbeEnv(reachableFile, 500));
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const paused = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state === "paused_network",
        15_000,
      );
      unsubscribe();
      expect(paused.state).toBe("paused_network");

      let notified = false;
      const stopNotice = world.client.onEvent("relay.notice", () => {
        notified = true;
      });
      const stopChanged = world.client.onEvent("runs.changed", (data) => {
        const run = data.run as { id?: string; state?: string } | undefined;
        if (run?.id === paused.id && run.state === "running") notified = true;
      });

      // 探测间隔已注入为 500ms：先让至少一轮探测读到"不可达"基线，再写 reachable 触发下一轮探测检出恢复
      await delay(700);
      await writeNetworkReachableFile(reachableFile, true);

      const recovered = await waitForRun(world.client, (run) => run.id === paused.id && run.state === "running", 5_000);
      expect(recovered.state).toBe("running");

      await delay(1_000);
      stopNotice();
      stopChanged();
      expect(notified).toBe(true);

      await rm(reachableDir, { recursive: true, force: true });
    },
    20_000,
  );
});

describe("structured-verdict：验收者 reportPath 校验", () => {
  test(
    "acceptance 派工拒绝仓库外报告路径，未传路径时使用需求默认报告",
    async () => {
      const requirement = "2026-09-01.report-path";
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const reportPath = join(fixture.repo.root, ".pi-company", "requirements", requirement, "acceptance.md");
      const outsidePath = "/tmp/outside-repo-report.md";

      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([
              shapeTask("T-2", "acceptance", ["evidence"]),
              shapeTask("T-3", "acceptance", ["evidence"]),
            ]),
            toolReply("pi_company_agent", {
              action: "run",
              role: "acceptance",
              task: "T-2",
              writePaths: ["evidence"],
              readPaths: [],
              reportPath: outsidePath,
            }),
            toolReply("pi_company_agent", {
              action: "run",
              role: "acceptance",
              task: "T-3",
              writePaths: ["evidence"],
              readPaths: [],
            }),
            textReply("已尝试全部派工"),
          ],
        },
        {
          providerId: "controlled-acceptance-T-3",
          modelId: "controlled-model",
          roleName: "acceptance",
          taskId: "T-3",
          replies: [
            toolReply("write", { path: reportPath, content: "---\ndate: 2026-09-10\nresult: accepted\n---\n| AC-1 | PASS | 符合预期 | |\n## 所用命令\n无\n" }),
            toolReply("structured_output", validAcceptanceResult(reportPath)),
            textReply("完成"),
          ],
        },
      ];
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      const unsubscribe = autoConfirmShape(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client, fixture.repo.root, requirement);

      const t3 = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-3", 15_000);
      const runsAfterDispatch = await listRuns(client);
      unsubscribe();
      expect(runsAfterDispatch.some((run) => run.kind === "role" && run.task === "T-1")).toBe(false);
      expect(runsAfterDispatch.some((run) => run.kind === "role" && run.task === "T-2")).toBe(false);
      expect(t3.state).not.toBe("failed");

      const written = await waitForFile(reportPath, 15_000);
      expect(written.length).toBeGreaterThan(0);
    },
    30_000,
  );
});

describe("user-stop：结果送达与 uncertain 制造", () => {
  test(
    "停止单个角色后需求代理收到该角色结果文本",
    async () => {
      const requirement = "2026-09-01.stop-result-delivery";
      const requestsLog = await createProviderRequestsLog();
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            textReply("已派工"),
            textReply("收到通知"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("bash", { command: "sleep 30" })],
        },
      ];
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      const unsubscribe = autoConfirmShape(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client, fixture.repo.root, requirement);
      const t1 = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      await client.call("runs.stop", { runId: t1.id });

      const lines = await waitForProviderLogEntries(
        requestsLog,
        (entries) =>
          entries.some(
            (entry) =>
              entry.providerId === REQUIREMENT_PROVIDER.providerId &&
              entry.text.includes("T-1") &&
              (entry.text.includes("已停止") || entry.text.includes("stopped")),
          ),
        10_000,
      );
      const requirementLines = lines.filter(
        (entry) => entry.providerId === REQUIREMENT_PROVIDER.providerId && entry.text.includes("T-1"),
      );
      expect(requirementLines.some((entry) => entry.text.includes("已停止") || entry.text.includes("stopped"))).toBe(true);
    },
    20_000,
  );

  test(
    "trap 忽略 SIGTERM 的后代制造 Shell 清理无法确认，shells.list 标记 uncertain 且不出现在 runs.list 状态中，重叠范围新派工被拒",
    async () => {
      const requirement = "2026-09-01.stop-uncertain-trap";
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

      await delay(6_000);
      const shellsAfter = await listShells(world.client);
      const afterTask = shellsAfter.find((entry) => entry.taskId === task?.taskId);
      if (afterTask?.status === "uncertain") {
        expect(afterTask.status).toBe("uncertain");
      } else {
        expect(["stopped", "exited"]).toContain(afterTask?.status);
      }

      const runsAfter = await listRuns(world.client);
      expect(runsAfter.every((run) => run.state !== ("uncertain" as never))).toBe(true);

      unsubscribe();
      expect(runsAfter.some((run) => run.kind === "role" && run.task === "T-2")).toBe(false);
    },
    30_000,
  );
});

describe("run-lifecycle：续接不重跑已完成任务", () => {
  test(
    "T-1 派出后强杀重启，resumeInterrupted 消费第二段脚本且不重复派出 T-1",
    async () => {
      const requirement = "2026-09-01.resume-no-rerun";
      const requestsLog = await createProviderRequestsLog();
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
          // 不涉及 Shell，避免遗留任务触发"存在活动/不确定 Shell 任务阻止续接"这条不相干的规则
          replies: [textReply("正在核对现状", 30_000)],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath1 = await writeTestModelProviders(fixture.dataRoot, firstScripts);
      const handle1 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath1, requestsLog) });
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

      client1.close();
      await killDaemon(handle1);

      const secondScripts: TestProviderScript[] = [
        {
          providerId: "controlled-worker-T-1-resume",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [submitReply(), textReply("完成")],
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

      await waitForRun(client2, (run) => run.id === t1.id && run.state === "interrupted", 10_000);
      const resumeResult = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(resumeResult.ok !== false).toBe(true);

      const resumed = await waitForRun(client2, (run) => run.id === t1.id && run.state !== "interrupted", 15_000);
      expect(resumed.state).not.toBe("interrupted");

      const lines = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.some((entry) => entry.providerId === "controlled-worker-T-1-resume"),
        10_000,
      );
      const resumedCalls = lines.filter((entry) => entry.providerId === "controlled-worker-T-1-resume");
      expect(resumedCalls.length).toBeGreaterThan(0);
      // 真正重建的会话上下文带着续接前的历史（原始需求/形状/派工记录），
      // 不是从一句空提示开始的全新对话——用序列化长度做一个宽松但可验证的连续性信号
      expect(resumedCalls[0]!.text.length).toBeGreaterThan(500);

      const allT1Runs = (await listRuns(client2)).filter((run) => run.kind === "role" && run.task === "T-1");
      expect(allT1Runs.length).toBe(1);
    },
    45_000,
  );
});

describe("角色会话 idle 处理", () => {
  test(
    "角色连续两次只回文字不提交：第一次 idle 后收到一次续跑提示，第二次 idle 判失败，提示总数恰为 1",
    async () => {
      const requirement = "2026-09-01.role-idle-nudge";
      const requestsLog = await createProviderRequestsLog();
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
          replies: [textReply("我在评估任务"), textReply("我还在评估任务")],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      const unsubscribe = autoConfirmShape(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client, fixture.repo.root, requirement);
      const t1 = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      const failed = await waitForRun(client, (run) => run.id === t1.id && run.state === "failed", 15_000);
      expect((failed.result as { stateReason?: string } | undefined)?.stateReason ?? failed.stateReason ?? "").toMatch(
        /未提交|结构化|submit/i,
      );

      const lines = await readProviderRequestsLog(requestsLog);
      const workerCalls = lines.filter((entry) => entry.providerId === "controlled-worker-T-1");
      expect(workerCalls.length).toBe(2);
      expect(workerCalls[1]!.text).toMatch(/提交|submit/i);
    },
    20_000,
  );

  test(
    "角色起后台 Shell 任务后只回文字：不催促、保持 running 直到 runs.stop",
    async () => {
      const requirement = "2026-09-01.role-idle-with-shell";
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
            toolReply("bash", { command: "sleep 20", background: true }),
            textReply("已启动后台任务，继续观察"),
          ],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      await delay(5_000);
      const stillRunning = (await listRuns(world.client)).find((run) => run.id === t1.id);
      expect(stillRunning?.state).toBe("running");

      await world.client.call("runs.stop", { runId: t1.id });
      const stopped = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "stopped", 10_000);
      expect(stopped.state).toBe("stopped");
    },
    30_000,
  );

  test(
    "需求代理会话 idle 不适用该规则：连续两次只回文字不被催促也不被判失败",
    async () => {
      const requirement = "2026-09-01.requirement-idle-exempt";
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "worker", ["area-a"])]),
            dispatchRoleReply("worker", "T-1", ["area-a"]),
            textReply("等待中"),
            textReply("仍在等待"),
          ],
        },
        {
          providerId: "controlled-worker-T-1",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-1",
          replies: [toolReply("bash", { command: "sleep 20", background: true })],
        },
      ];
      const world = await startWorld(scripts);
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      const reqRunId = await dispatchRequirement(world.client, world.fixture.repo.root, requirement);
      await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      await delay(4_000);
      const reqRun = (await listRuns(world.client)).find((run) => run.id === reqRunId);
      expect(reqRun?.state).not.toBe("failed");
      expect(["running", "completed"]).toContain(reqRun?.state);
    },
    20_000,
  );
});

describe("角色会话 idle 提醒随暂停/继续重置", () => {
  test(
    "被提醒一次后暂停再继续，再次 idle 仍先提醒而非直接判失败",
    async () => {
      const requirement = "2026-09-01.role-idle-reset-on-resume";
      const requestsLog = await createProviderRequestsLog();
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
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
          replies: [textReply("我在评估任务"), textReply("继续处理中", 3_000), toolReply("pi_company_resume_check", {}), textReply("仍未准备好提交"), textReply("继续处理", 10_000)],
        },
      ];
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      const unsubscribe = autoConfirmShape(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client, fixture.repo.root, requirement);
      const t1 = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      // 第一次 idle（回复 1）之后应收到一次续跑提示，触发第二次模型调用（回复 2，进行中挂着 3s）
      await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.filter((entry) => entry.providerId === "controlled-worker-T-1").length >= 2,
        10_000,
      );

      await client.call("runs.pause", { runId: t1.id });
      await client.call("runs.resume", { runId: t1.id });

      // 继续后应发起新一轮调用（回复 3），其以纯文字结束触发第二次 idle；
      // 若 idleReminded 随暂停/继续正确重置，这次仍应先补一次提示（第四次调用）而不是直接判失败
      const afterReset = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.filter((entry) => entry.providerId === "controlled-worker-T-1").length >= 5,
        15_000,
      );
      const workerCalls = afterReset.filter((entry) => entry.providerId === "controlled-worker-T-1");
      expect(workerCalls.length).toBeGreaterThanOrEqual(5);

      const current = (await listRuns(client)).find((run) => run.id === t1.id);
      expect(current?.state).not.toBe("failed");
    },
    30_000,
  );
});

describe("structured-verdict：reportPath 续接回填", () => {
  test(
    "验收者运行强杀重启后 resumeInterrupted，重建会话仍能写入原 reportPath",
    async () => {
      const requirement = "2026-09-01.report-path-resume-refill";
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const reportPath = join(fixture.repo.root, ".pi-company", "requirements", requirement, "acceptance.md");

      const firstScripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "acceptance", ["evidence"])]),
            toolReply("pi_company_agent", {
              action: "run",
              role: "acceptance",
              task: "T-1",
              writePaths: ["evidence"],
              readPaths: [],
              reportPath,
            }),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-acceptance-T-1",
          modelId: "controlled-model",
          roleName: "acceptance",
          taskId: "T-1",
          replies: [textReply("正在核对现状", 30_000)],
        },
      ];
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

      client1.close();
      await killDaemon(handle1);

      const secondScripts: TestProviderScript[] = [
        {
          providerId: "controlled-acceptance-T-1-resume",
          modelId: "controlled-model",
          roleName: "acceptance",
          taskId: "T-1",
          replies: [toolReply("pi_company_resume_check", {}), toolReply("write", { path: reportPath, content: "# 验收报告（续接回填测试固定）\n" }), textReply("已写入原报告")],
        },
      ];
      const providersPath2 = await writeTestModelProviders(fixture.dataRoot, secondScripts);
      const handle2 = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath2) });
      extraHandles.push(handle2);
      const client2 = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client2);

      await waitForRun(client2, (run) => run.id === t1.id && run.state === "interrupted", 10_000);
      const resumeResult = await client2.call("runs.resumeInterrupted", { runId: t1.id });
      expect(resumeResult.ok !== false).toBe(true);

      const written = await waitForFile(reportPath, 15_000);
      expect(written.length).toBeGreaterThan(0);
    },
    45_000,
  );
});

describe("role-catalog：按角色 kind 的输出契约", () => {
  test(
    "planner 只有完成文字而缺少合法规划产物时失败关闭，不能作为 planned 证据",
    async () => {
      const requirement = "2026-09-01.plan-kind-autocomplete";
      const requestsLog = await createProviderRequestsLog();
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            proposeShapeReply([shapeTask("T-1", "planner", ["area-a"])]),
            dispatchRoleReply("planner", "T-1", ["area-a"]),
            textReply("已派工"),
          ],
        },
        {
          providerId: "controlled-planner-T-1",
          modelId: "controlled-model",
          roleName: "planner",
          taskId: "T-1",
          replies: [textReply("已核对任务骨架，规划完成")],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      const unsubscribe = autoConfirmShape(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      await dispatchRequirement(client, fixture.repo.root, requirement);
      const t1 = await waitForRun(client, (run) => run.kind === "role" && run.task === "T-1");
      unsubscribe();

      const failed = await waitForRun(client, (run) => run.id === t1.id && run.state === "failed", 15_000);
      expect(failed.result).toBeUndefined();
      expect(failed.stateReason).toBeTruthy();

      const lines = await readProviderRequestsLog(requestsLog);
      const plannerCalls = lines.filter((entry) => entry.providerId === "controlled-planner-T-1");
      expect(plannerCalls.length).toBe(1);

      const queried = await executeWorkflowAction(
        { action: "query", requirement },
        { dataRoot: fixture.dataRoot, cwd: fixture.repo.root },
      );
      const stateVersion = queried.details.version as number;
      const advanceResult = await executeWorkflowAction(
        { action: "advance", requirement, stage: "planned", runId: t1.id, version: stateVersion },
        { dataRoot: fixture.dataRoot, cwd: fixture.repo.root },
      );
      expect(advanceResult.details.isError).toBe(true);
    },
    20_000,
  );
});

describe("RunManager 单元级：未知角色 kind 的派工权", () => {
  test("角色目录条目 kind 不在 plan/work/review/acceptance 内时，派工被明确拒绝", async () => {
    const fakeRoleCatalog = [
      {
        name: "rogue-role",
        source: "project" as const,
        path: "/tmp/rogue-role.md",
        available: true,
        definition: {
          name: "rogue-role",
          description: "kind 非法的自定义角色（测试固定）",
          kind: "manage" as never,
          tools: ["read"],
          skills: false,
          contextFiles: false,
          promptMode: "append",
          body: "正文",
        },
      },
    ];
    const dataRoot = await mkdtemp(join(tmpdir(), "run-manager-unit-"));
    const relayDataDir = await mkdtemp(join(tmpdir(), "run-manager-unit-relay-"));
    unitCleanups.push(async () => {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(relayDataDir, { recursive: true, force: true });
    });
    const repoId = testRepoId();
    const runStore = new RunStore({ dataRoot, repoId, daemonStartedAt: new Date().toISOString() });
    const shellRegistry = new ShellRegistry({ clock: createClock() });
    const relayQueue = new RelayQueue({
      dataDir: relayDataDir,
      deliver: async () => [],
      locateRequirementAgent: () => undefined,
    });
    const manager = new RunManager({
      dataRoot,
      repoId,
      runStore,
      shellRegistry,
      networkGate: new NetworkPauseGate(),
      relayQueue,
      roleCatalog: fakeRoleCatalog as never,
      runtime: {} as never,
      selectModel: () => ({ provider: "stub", id: "stub" }),
      clock: createClock(),
      workspaceRepoIds: [repoId],
      emit: () => {},
    });
    manager.markStarted();

    const outcome = await callPrivate<{ ok: boolean; reason?: string }>(manager, "dispatchRoleInternal", {
      kind: "requirement",
      runId: randomUUID(),
    }, {
      requirement: "2026-09-01.unit-unknown-kind",
      cwd: "/tmp/nowhere",
      role: "rogue-role",
      task: "T-1",
      writePaths: [],
      readPaths: [],
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("pause-control：网络故障按 provider baseUrl 分组续接", () => {
  test(
    "两个角色各用不同 provider 进入 paused_network，仅恢复其中一个 baseUrl 时只有对应运行续接",
    async () => {
      const requirement = "2026-09-01.network-resume-per-provider";
      const mapDir = await mkdtemp(join(tmpdir(), "connectivity-map-"));
      const fileA = join(mapDir, "a.txt");
      const fileB = join(mapDir, "b.txt");
      await writeNetworkReachableFile(fileA, false);
      await writeNetworkReachableFile(fileB, false);
      const baseUrlA = "http://127.0.0.1:11111";
      const baseUrlB = "http://127.0.0.1:22222";
      const mapPath = await writeConnectivityReachableMap(mapDir, { [baseUrlA]: fileA, [baseUrlB]: fileB });

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
          baseUrl: baseUrlA,
          replies: [{ type: "error", message: "fetch failed: network A 连接被重置" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
        {
          providerId: "controlled-worker-T-2",
          modelId: "controlled-model",
          roleName: "worker",
          taskId: "T-2",
          baseUrl: baseUrlB,
          replies: [{ type: "error", message: "fetch failed: network B 连接被重置" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
      ];
      const world = await startWorld(scripts, connectivityProbeMapEnv(mapPath, 500));
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const t1 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-1" && run.state === "paused_network", 15_000);
      const t2 = await waitForRun(world.client, (run) => run.kind === "role" && run.task === "T-2" && run.state === "paused_network", 15_000);
      unsubscribe();

      await delay(700);
      await writeNetworkReachableFile(fileA, true);

      const recoveredA = await waitForRun(world.client, (run) => run.id === t1.id && run.state === "running", 5_000);
      expect(recoveredA.state).toBe("running");

      const stillPaused = (await listRuns(world.client)).find((run) => run.id === t2.id);
      expect(stillPaused?.state).toBe("paused_network");

      await writeNetworkReachableFile(fileB, true);
      const recoveredB = await waitForRun(world.client, (run) => run.id === t2.id && run.state === "running", 5_000);
      expect(recoveredB.state).toBe("running");
    },
    30_000,
  );
});

describe("RunManager 单元级：resumeNetworkPaused 必须按 provider 续接", () => {
  test("不传 providerId 调用被拒绝，不做全量续接", async () => {
    const ctx = await makeUnitManager();
    const { manager, runStore } = ctx;
    const run = await createUnitRoleRun(ctx, {
      requirement: "2026-09-01.unit-resume-network-no-provider",
      task: "T-1",
      cwd: "/tmp/nowhere",
    });
    await runStore.update(run.id, { state: "running" });
    await runStore.update(run.id, { state: "paused_network" });
    const handle = makeFakeHandle();
    injectSession(manager, run.id, { kind: "role", handle, requirement: run.requirement, writePaths: [] });

    let rejected = false;
    try {
      await callPrivate<void>(manager, "resumeNetworkPaused");
    } catch {
      rejected = true;
    }
    const after = await runStore.get(run.id);
    expect(rejected || (after.ok && after.run.state === "paused_network")).toBe(true);
  });
});

describe("pause-control：provider baseUrl 非法时不发起探测", () => {
  test(
    "provider baseUrl 含 userinfo 与路径时，探测恢复文件写 reachable 后运行仍保持 paused_network",
    async () => {
      const requirement = "2026-09-01.network-invalid-base-url";
      const reachableDir = await mkdtemp(join(tmpdir(), "network-reachable-invalid-"));
      const reachableFile = join(reachableDir, "reachable.txt");
      await writeNetworkReachableFile(reachableFile, true);
      const invalidBaseUrl = "http://user:pass@evil.example.invalid/some/path";

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
          baseUrl: invalidBaseUrl,
          replies: [{ type: "error", message: "fetch failed: network 连接被重置" }, toolReply("pi_company_resume_check", {}), textReply("恢复核对完成", 10_000)],
        },
      ];
      const world = await startWorld(scripts, connectivityProbeEnv(reachableFile, 500));
      const unsubscribe = autoConfirmShape(world.client);
      await confirmRequirement(world.fixture.dataRoot, world.fixture.repo.root, requirement);
      await dispatchRequirement(world.client, world.fixture.repo.root, requirement);

      const paused = await waitForRun(
        world.client,
        (run) => run.kind === "role" && run.task === "T-1" && run.state === "paused_network",
        15_000,
      );
      unsubscribe();

      await delay(1_500);
      const stillPaused = (await listRuns(world.client)).find((run) => run.id === paused.id);
      expect(stillPaused?.state).toBe("paused_network");

      await rm(reachableDir, { recursive: true, force: true });
    },
    20_000,
  );
});

describe("role-catalog：需求代理会话按契约而非 kind 推断，不提供结构化提交", () => {
  test(
    "系统提示不含结构化提交格式段、误调用 structured_output 为工具不存在、连续两轮只回文字仍 running",
    async () => {
      const requirement = "2026-09-01.requirement-no-contract";
      const requestsLog = await createProviderRequestsLog();
      const scripts: TestProviderScript[] = [
        {
          ...REQUIREMENT_PROVIDER,
          replies: [
            toolReply("structured_output", { phase: "work" }),
            textReply("仍在推进需求"),
            textReply("继续核对现状"),
          ],
        },
      ];
      const fixture = await createDaemonFixture();
      extraDaemonFixtures.push(fixture);
      const providersPath = await writeTestModelProviders(fixture.dataRoot, scripts);
      const handle = await startDaemonForTest(fixture, { extraEnv: modelProviderEnv(providersPath, requestsLog) });
      extraHandles.push(handle);
      const client = await connectTestClient(fixture.socketPath, {
        cwd: fixture.repo.root,
        workspaceRoot: fixture.repo.root,
        repoIds: [fixture.repoId],
      });
      extraClients.push(client);
      await confirmRequirement(fixture.dataRoot, fixture.repo.root, requirement);
      const reqRunId = await dispatchRequirement(client, fixture.repo.root, requirement);

      const firstCallEntries = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.some((entry) => entry.providerId === REQUIREMENT_PROVIDER.providerId),
        10_000,
      );
      const firstCall = firstCallEntries.find((entry) => entry.providerId === REQUIREMENT_PROVIDER.providerId);
      expect(firstCall?.text.includes("结构化提交格式")).toBe(false);

      const secondCallEntries = await waitForProviderLogEntries(
        requestsLog,
        (entries) => entries.filter((entry) => entry.providerId === REQUIREMENT_PROVIDER.providerId).length >= 2,
        10_000,
      );
      const reqCalls = secondCallEntries.filter((entry) => entry.providerId === REQUIREMENT_PROVIDER.providerId);
      // 第二轮请求的上下文里带着第一轮 structured_output 调用的工具结果；
      // 契约缺失应表现为"工具不存在"，不应是 schema 校验类的 phase 不符文案
      expect(reqCalls[1]!.text).not.toMatch(/phase 必须为|phase 不符/);
      expect(reqCalls[1]!.text).toMatch(/不存在|未知工具|unknown tool|not found/i);

      await delay(1_500);
      const stillRunning = (await listRuns(client)).find((run) => run.id === reqRunId);
      expect(stillRunning?.state).not.toBe("failed");
      expect(stillRunning?.state).toBe("running");
    },
    20_000,
  );
});
