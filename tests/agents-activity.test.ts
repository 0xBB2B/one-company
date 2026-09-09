import { describe, expect, test } from "bun:test";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { AgentsActivity } from "../runtime/agents-activity.ts";

interface FakeTimeSource extends TimeSource {
  advance(ms: number): void;
  jump(ms: number): void;
}

function createFakeTimeSource(): FakeTimeSource {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  function setTimeoutFake(fn: () => void, ms: number): unknown {
    const id = nextId++;
    timers.set(id, { fireAt: current + ms, fn });
    return id;
  }

  function clearTimeoutFake(handle: unknown): void {
    timers.delete(handle as number);
  }

  function advance(ms: number): void {
    const target = current + ms;
    while (true) {
      let earliestId: number | undefined;
      let earliestFireAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.fireAt <= target && entry.fireAt < earliestFireAt) {
          earliestId = id;
          earliestFireAt = entry.fireAt;
        }
      }
      if (earliestId === undefined) break;
      const entry = timers.get(earliestId);
      timers.delete(earliestId);
      current = earliestFireAt;
      entry?.fn();
    }
    current = target;
  }

  function jump(ms: number): void {
    const target = current + ms;
    current = target;
    const due: Array<{ fireAt: number; fn: () => void }> = [];
    for (const [id, entry] of timers) {
      if (entry.fireAt <= target) {
        due.push(entry);
        timers.delete(id);
      }
    }
    for (const entry of due) entry.fn();
  }

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance, jump };
}

type RunLike = Record<string, unknown>;

const REPO_A = { repoId: "repo-a-id", name: "repo-a" };
const REPO_B = { repoId: "repo-b-id", name: "repo-b" };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function runFixture(overrides: RunLike = {}): RunLike {
  const startedAt = (overrides.startedAt as string) ?? new Date(0).toISOString();
  return {
    id: "run-default",
    shellToken: "shell-default",
    kind: "requirement",
    requirement: "2026-09-09.demo",
    task: "/workspace/.bb-spec/docs/plan/2026-09-09.demo/tasks/01-demo-task.md",
    cwd: "/workspace/repo-a",
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
    state: "running",
    turns: 0,
    errorDetails: { status: "none" },
    daemonStartedAt: new Date(0).toISOString(),
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

function pushRun(
  activity: AgentsActivity,
  repoId: string,
  run: RunLike,
  meta: { requirementTitle?: string; activeShellTasks?: number; pendingShellCleanup?: number } = {},
): void {
  activity.applyRunsChanged(repoId, { run, ...meta });
}

describe("条目顺序与仓库范围", () => {
  test("仓库名·需求标题首行后紧跟角色缩进行，工作区外仓库不出现，repoId 不泄漏", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-req", state: "running", turns: 3 }), {
      requirementTitle: "示例需求",
    });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-role", kind: "role", role: "pi-company.tester", parentRunId: "run-req", state: "running" }),
    );
    pushRun(activity, REPO_B.repoId, runFixture({ id: "run-outside", state: "running" }), {
      requirementTitle: "工作区外需求",
    });

    const rows = activity.rows();
    expect(rows.map((row: RunLike) => row.id)).toEqual(["run-req", "run-role"]);
    expect(rows.find((row: RunLike) => row.id === "run-outside")).toBeUndefined();

    const [reqRow, roleRow] = rows;
    expect(reqRow.indent).toBe(0);
    expect(reqRow.title).toBe("repo-a · 示例需求");
    expect(reqRow.turns).toBe(3);
    expect(reqRow.status).toBe("running");
    expect(reqRow.activity).toBe("");
    expect(roleRow.indent).toBe(1);
    expect(roleRow.title).toBe("pi-company.tester");

    for (const row of rows) {
      for (const text of [row.title, row.activity, row.status, row.unreachableReason ?? ""]) {
        expect(String(text)).not.toContain(REPO_A.repoId);
      }
    }
  });
});

describe("行内不显示任务文件路径", () => {
  test("任务文件路径不出现在任何行字段中", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    const secretPathMarker = "01-secret-task-path";
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({
        id: "run-path",
        task: `/workspace/.bb-spec/docs/plan/2026-09-09.demo/tasks/${secretPathMarker}.md`,
        state: "running",
      }),
      { requirementTitle: "demo" },
    );

    expect(JSON.stringify(activity.rows())).not.toContain(secretPathMarker);
  });
});

describe("中断条目的 Shell 任务数字段", () => {
  test("中断状态行携带 activeShellTasks，非中断行不携带该字段", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-interrupted", state: "interrupted" }), {
      requirementTitle: "demo",
      activeShellTasks: 2,
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-running", state: "running" }), {
      requirementTitle: "demo",
    });

    const rows = activity.rows();
    expect(rows.find((row: RunLike) => row.id === "run-interrupted")?.activeShellTasks).toBe(2);
    expect(rows.find((row: RunLike) => row.id === "run-running")?.activeShellTasks).toBeUndefined();
  });
});

describe("停止条目清理未确认 Shell 数", () => {
  test("清理未确认 Shell 数 >0 时不启动移除计时，60 秒后仍在", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-cleanup-pending", state: "stopped" }), {
      requirementTitle: "demo",
      pendingShellCleanup: 1,
    });

    timeSource.advance(60_000);
    const row = activity.rows().find((r: RunLike) => r.id === "run-cleanup-pending");
    expect(row).toBeDefined();
    expect(row?.pendingShellCleanup).toBe(1);
  });

  test("清理未确认 Shell 数为 0 或未携带时仍按 20 秒规则移出", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-cleanup-zero", state: "stopped" }), {
      requirementTitle: "demo",
      pendingShellCleanup: 0,
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-cleanup-none", state: "stopped" }), {
      requirementTitle: "demo",
    });

    timeSource.advance(20_000);
    const rows = activity.rows();
    expect(rows.find((r: RunLike) => r.id === "run-cleanup-zero")).toBeUndefined();
    expect(rows.find((r: RunLike) => r.id === "run-cleanup-none")).toBeUndefined();
  });
});

describe("活动来自实际工具事件", () => {
  test("工具开始后显示对应工具名，结束后清空", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-tool", state: "running" }), { requirementTitle: "demo" });

    activity.applyActivity({
      runId: "run-tool",
      kind: "tool_start",
      toolName: "read",
      toolCallId: "call-1",
      filePath: "/workspace/repo-a/README.md",
      at: iso(0),
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-tool")?.activity).toBe("read");

    activity.applyActivity({
      runId: "run-tool",
      kind: "tool_end",
      toolName: "read",
      toolCallId: "call-1",
      filePath: "/workspace/repo-a/README.md",
      at: iso(1),
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-tool")?.activity).toBe("");
  });

  test("并发工具：另一工具结束后仍显示尚未结束的先行工具", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-concurrent", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyActivity({ runId: "run-concurrent", kind: "tool_start", toolName: "read", toolCallId: "call-read", at: iso(0) });
    activity.applyActivity({ runId: "run-concurrent", kind: "tool_start", toolName: "grep", toolCallId: "call-grep", at: iso(1) });
    activity.applyActivity({ runId: "run-concurrent", kind: "tool_end", toolName: "grep", toolCallId: "call-grep", at: iso(2) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-concurrent")?.activity).toBe("read");

    activity.applyActivity({ runId: "run-concurrent", kind: "tool_end", toolName: "read", toolCallId: "call-read", at: iso(3) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-concurrent")?.activity).toBe("");
  });

  test("同名工具并发：不同 toolCallId 的调用互不干扰对方结束前的展示", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-same-tool", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyActivity({ runId: "run-same-tool", kind: "tool_start", toolName: "bash", toolCallId: "call-1", at: iso(0) });
    activity.applyActivity({ runId: "run-same-tool", kind: "tool_start", toolName: "bash", toolCallId: "call-2", at: iso(1) });
    activity.applyActivity({ runId: "run-same-tool", kind: "tool_end", toolName: "bash", toolCallId: "call-1", at: iso(2) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-same-tool")?.activity).toBe("bash");

    activity.applyActivity({ runId: "run-same-tool", kind: "tool_end", toolName: "bash", toolCallId: "call-2", at: iso(3) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-same-tool")?.activity).toBe("");
  });

  test("同一文件两次编辑（原样路径）按不同文件计数为 1", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-edit", state: "running" }), { requirementTitle: "demo" });

    const filePath = "/workspace/repo-a/src/a.ts";
    activity.applyActivity({ runId: "run-edit", kind: "tool_start", toolName: "edit", toolCallId: "call-1", filePath, at: iso(0) });
    activity.applyActivity({ runId: "run-edit", kind: "tool_end", toolName: "edit", toolCallId: "call-1", filePath, at: iso(1) });
    activity.applyActivity({ runId: "run-edit", kind: "tool_start", toolName: "edit", toolCallId: "call-2", filePath, at: iso(2) });
    activity.applyActivity({ runId: "run-edit", kind: "tool_end", toolName: "edit", toolCallId: "call-2", filePath, at: iso(3) });

    expect(activity.rows().find((r: RunLike) => r.id === "run-edit")?.filesEditedCount).toBe(1);
  });

  test("同一文件的多余斜杠/单点路径写法按同一文件计数为 1", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-edit-norm", state: "running" }), {
      requirementTitle: "demo",
    });

    const variants = ["/w/repo/src/a.ts", "/w/repo//src/a.ts", "/w/repo/./src/a.ts"];
    variants.forEach((filePath, index) => {
      activity.applyActivity({
        runId: "run-edit-norm",
        kind: "tool_start",
        toolName: "edit",
        toolCallId: `call-${index}`,
        filePath,
        at: iso(index * 2),
      });
      activity.applyActivity({
        runId: "run-edit-norm",
        kind: "tool_end",
        toolName: "edit",
        toolCallId: `call-${index}`,
        filePath,
        at: iso(index * 2 + 1),
      });
    });

    expect(activity.rows().find((r: RunLike) => r.id === "run-edit-norm")?.filesEditedCount).toBe(1);
  });

  test("同一文件 edit 与 write 各一次仍按同一文件计数为 1", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-edit-write", state: "running" }), {
      requirementTitle: "demo",
    });

    const filePath = "/w/repo/src/a.ts";
    activity.applyActivity({ runId: "run-edit-write", kind: "tool_start", toolName: "edit", toolCallId: "call-1", filePath, at: iso(0) });
    activity.applyActivity({ runId: "run-edit-write", kind: "tool_end", toolName: "edit", toolCallId: "call-1", filePath, at: iso(1) });
    activity.applyActivity({ runId: "run-edit-write", kind: "tool_start", toolName: "write", toolCallId: "call-2", filePath, at: iso(2) });
    activity.applyActivity({ runId: "run-edit-write", kind: "tool_end", toolName: "write", toolCallId: "call-2", filePath, at: iso(3) });

    expect(activity.rows().find((r: RunLike) => r.id === "run-edit-write")?.filesEditedCount).toBe(1);
  });

  test("未知 runId 的活动事件被丢弃，随后到达的同一运行活动为空", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    activity.applyActivity({ runId: "run-ghost", kind: "tool_start", toolName: "read", toolCallId: "call-ghost", at: iso(0) });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-ghost", state: "running" }), { requirementTitle: "demo" });

    expect(activity.rows().find((r: RunLike) => r.id === "run-ghost")?.activity).toBe("");
  });

  test("行内不泄漏工具事件的文件路径", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-leak", state: "running" }), { requirementTitle: "demo" });

    const filePath = "/workspace/repo-a/src/leak-marker.ts";
    activity.applyActivity({ runId: "run-leak", kind: "tool_start", toolName: "edit", toolCallId: "call-leak", filePath, at: iso(0) });

    expect(JSON.stringify(activity.rows())).not.toContain(filePath);
  });
});

describe("连接状态对活动展示的影响", () => {
  test("不可达清空活动并显示原因；恢复连接后旧活动不复现，需等待新工具事件", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-reconnect", state: "running" }), {
      requirementTitle: "demo",
    });
    activity.applyActivity({ runId: "run-reconnect", kind: "tool_start", toolName: "read", toolCallId: "call-1", at: iso(0) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-reconnect")?.activity).toBe("read");

    activity.applyConnectionState(REPO_A.repoId, { status: "unreachable", reason: "连接超时（测试注入）" });
    let row = activity.rows().find((r: RunLike) => r.id === "run-reconnect");
    expect(row?.unreachable).toBe(true);
    expect(row?.unreachableReason).toBe("连接超时（测试注入）");
    expect(row?.activity).toBe("");

    activity.applyConnectionState(REPO_A.repoId, { status: "connected" });
    row = activity.rows().find((r: RunLike) => r.id === "run-reconnect");
    expect(row?.unreachable).toBe(false);
    expect(row?.activity).toBe("");

    activity.applyActivity({ runId: "run-reconnect", kind: "tool_start", toolName: "write", toolCallId: "call-2", at: iso(1) });
    row = activity.rows().find((r: RunLike) => r.id === "run-reconnect");
    expect(row?.activity).toBe("write");
  });

  test("starting 状态按不可达处理，提供 reason 时显示", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-starting", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyConnectionState(REPO_A.repoId, { status: "starting", reason: "守护进程重启中（测试注入）" });
    const row = activity.rows().find((r: RunLike) => r.id === "run-starting");
    expect(row?.unreachable).toBe(true);
    expect(row?.unreachableReason).toBe("守护进程重启中（测试注入）");
    expect(row?.activity).toBe("");
  });

  test("重复上报 connected 不清空当前活动", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-redundant-connected", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyConnectionState(REPO_A.repoId, { status: "connected" });
    activity.applyActivity({
      runId: "run-redundant-connected",
      kind: "tool_start",
      toolName: "read",
      toolCallId: "call-1",
      at: iso(0),
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-redundant-connected")?.activity).toBe("read");

    activity.applyConnectionState(REPO_A.repoId, { status: "connected" });
    expect(activity.rows().find((r: RunLike) => r.id === "run-redundant-connected")?.activity).toBe("read");
  });
});

describe("终止条目转灰色摘要并 20 秒后移出", () => {
  test("结束、失败、用户停止条目 19 秒仍在、20 秒移出，多次重绘不续时", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-completed", state: "completed" }), {
      requirementTitle: "demo",
    });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-failed", state: "failed", stateReason: "工具调用失败（测试注入）" }),
      { requirementTitle: "demo" },
    );
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-stopped", state: "stopped" }), {
      requirementTitle: "demo",
    });

    timeSource.advance(19_000);
    activity.rows();
    activity.rows();
    let rows = activity.rows();
    for (const id of ["run-completed", "run-failed", "run-stopped"]) {
      const row = rows.find((r: RunLike) => r.id === id);
      expect(row).toBeDefined();
      expect(row?.archived).toBe(true);
    }

    timeSource.advance(1_000);
    rows = activity.rows();
    for (const id of ["run-completed", "run-failed", "run-stopped"]) {
      expect(rows.find((r: RunLike) => r.id === id)).toBeUndefined();
    }
  });
});

describe("已移出条目不因重复终态事件复活", () => {
  test("移出后再次收到同一运行的终态事件不复活、不重新计时", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-once-removed", state: "completed" }), {
      requirementTitle: "demo",
    });
    timeSource.advance(20_000);
    expect(activity.rows().find((r: RunLike) => r.id === "run-once-removed")).toBeUndefined();

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-once-removed", state: "completed" }), {
      requirementTitle: "demo",
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-once-removed")).toBeUndefined();

    timeSource.advance(19_000);
    expect(activity.rows().find((r: RunLike) => r.id === "run-once-removed")).toBeUndefined();
  });
});

describe("墓碑定长", () => {
  test("连续 600 个不同运行终态移出后，最早的运行 ID 被挤出墓碑可再次出现，最近的仍被丢弃", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    const TOMBSTONE_PROBE_COUNT = 600;
    for (let i = 0; i < TOMBSTONE_PROBE_COUNT; i += 1) {
      pushRun(activity, REPO_A.repoId, runFixture({ id: `run-tomb-${i}`, state: "completed" }), {
        requirementTitle: "demo",
      });
    }

    timeSource.advance(20_000);
    const remainingIds = new Set(activity.rows().map((row: RunLike) => row.id));
    for (let i = 0; i < TOMBSTONE_PROBE_COUNT; i += 1) {
      expect(remainingIds.has(`run-tomb-${i}`)).toBe(false);
    }

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-tomb-0", state: "completed" }), {
      requirementTitle: "demo",
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-tomb-0")).toBeDefined();

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-tomb-599", state: "completed" }), {
      requirementTitle: "demo",
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-tomb-599")).toBeUndefined();
  });
});

describe("孤儿子角色行标题", () => {
  test("父行移出后孤儿子角色标题为「仓库名 · 需求标题 › 角色名」", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-orphan-parent", state: "completed" }), {
      requirementTitle: "示例需求",
    });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-orphan-child", kind: "role", role: "pi-company.worker", parentRunId: "run-orphan-parent", state: "running" }),
    );

    timeSource.advance(20_000);
    const row = activity.rows().find((r: RunLike) => r.id === "run-orphan-child");
    expect(row?.title).toBe("repo-a · 示例需求 › pi-company.worker");
    expect(row?.indent).toBe(0);
    expect(new Set(row?.buttons as unknown[])).toEqual(new Set(["pause", "stop", "view"]));
  });

  test("run.role 缺失时孤儿子角色标题的角色名显示为「角色」", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-orphan-parent-2", state: "completed" }), {
      requirementTitle: "示例需求",
    });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-orphan-child-2", kind: "role", parentRunId: "run-orphan-parent-2", state: "running" }),
    );

    timeSource.advance(20_000);
    const row = activity.rows().find((r: RunLike) => r.id === "run-orphan-child-2");
    expect(row?.title).toBe("repo-a · 示例需求 › 角色");
  });
});

describe("孤儿子角色行的父标题来自登记时的快照", () => {
  test("父从未出现时孤儿标题为「仓库名 · 角色名」", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({
        id: "run-orphan-no-parent-seen",
        kind: "role",
        role: "pi-company.worker",
        parentRunId: "run-never-arrived",
        state: "running",
      }),
    );

    const row = activity.rows().find((r: RunLike) => r.id === "run-orphan-no-parent-seen");
    expect(row?.title).toBe("repo-a · pi-company.worker");
  });
});

describe("缺 toolCallId 的工具事件被丢弃", () => {
  test("tool_start 无 toolCallId 时活动为空、编辑数为 0", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-missing-call-id", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyActivity({ runId: "run-missing-call-id", kind: "tool_start", toolName: "read", at: iso(0) });
    expect(activity.rows().find((r: RunLike) => r.id === "run-missing-call-id")?.activity).toBe("");

    activity.applyActivity({
      runId: "run-missing-call-id",
      kind: "tool_start",
      toolName: "edit",
      filePath: "/w/repo/src/a.ts",
      at: iso(1),
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-missing-call-id")?.filesEditedCount).toBe(0);
  });
});

describe("首次 connected 上报不清空早到的活动", () => {
  test("仓库从未上报连接状态时，活动先到，首次 connected 上报不清空活动", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-first-connected", state: "running" }), {
      requirementTitle: "demo",
    });

    activity.applyActivity({
      runId: "run-first-connected",
      kind: "tool_start",
      toolName: "read",
      toolCallId: "call-1",
      at: iso(0),
    });
    expect(activity.rows().find((r: RunLike) => r.id === "run-first-connected")?.activity).toBe("read");

    activity.applyConnectionState(REPO_A.repoId, { status: "connected" });
    expect(activity.rows().find((r: RunLike) => r.id === "run-first-connected")?.activity).toBe("read");
  });
});

describe("需求标题缺失时的回退标题", () => {
  test("requirementTitle 缺失时首行标题回退为「仓库名 · run.requirement」", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-fallback-title", state: "running", requirement: "2026-09-09.fallback-demo" }),
    );

    const row = activity.rows().find((r: RunLike) => r.id === "run-fallback-title");
    expect(row?.title).toBe("repo-a · 2026-09-09.fallback-demo");
  });
});

describe("父需求行移出后子角色行独立计时", () => {
  test("父需求 completed 移出后仍运行中的子角色行仍可见；子角色 completed 后按 20 秒规则移出", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-parent", state: "completed" }), {
      requirementTitle: "demo",
    });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-child", kind: "role", role: "pi-company.worker", parentRunId: "run-parent", state: "running" }),
    );

    timeSource.advance(20_000);
    let rows = activity.rows();
    expect(rows.find((r: RunLike) => r.id === "run-parent")).toBeUndefined();
    expect(rows.find((r: RunLike) => r.id === "run-child")).toBeDefined();

    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-child", kind: "role", role: "pi-company.worker", parentRunId: "run-parent", state: "completed" }),
    );

    timeSource.advance(19_000);
    expect(activity.rows().find((r: RunLike) => r.id === "run-child")).toBeDefined();

    timeSource.advance(1_000);
    expect(activity.rows().find((r: RunLike) => r.id === "run-child")).toBeUndefined();
  });
});

describe("暂停与中断不启动移除计时", () => {
  test("60 秒后暂停、中断条目仍在", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-paused", state: "paused" }), { requirementTitle: "demo" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-interrupted-60s", state: "interrupted" }), {
      requirementTitle: "demo",
      activeShellTasks: 2,
    });

    timeSource.advance(60_000);
    const rows = activity.rows();
    for (const id of ["run-paused", "run-interrupted-60s"]) {
      expect(rows.find((r: RunLike) => r.id === id)).toBeDefined();
    }
  });
});

describe("临时操作失败提示", () => {
  test("20 秒后恢复；第二次错误自出现起重新计时并替换旧提示；多次重绘不续时", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    activity.reportActionFailure("暂停请求失败（测试注入 A）");
    timeSource.advance(5_000);
    activity.reportActionFailure("停止请求失败（测试注入 B）");

    timeSource.advance(15_000);
    expect(activity.notice()?.message).toBe("停止请求失败（测试注入 B）");

    activity.rows();
    activity.rows();

    timeSource.advance(4_999);
    expect(activity.notice()?.message).toBe("停止请求失败（测试注入 B）");

    timeSource.advance(1);
    expect(activity.notice()).toBeUndefined();
  });
});

describe("耗时扣除睡眠间隔", () => {
  test("注入睡眠间隔后耗时只计清醒时长", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    clock.startGapWatcher();
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });

    const startedAt = new Date(timeSource.now()).toISOString();
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-elapsed", state: "running", startedAt, updatedAt: startedAt }),
      { requirementTitle: "demo" },
    );

    timeSource.advance(10_000);
    timeSource.jump(300_000);
    timeSource.advance(5_000);

    const row = activity.rows().find((r: RunLike) => r.id === "run-elapsed");
    expect(row?.elapsedMs).toBe(15_000);
  });
});

describe("startedAt 缺失或畸形时耗时归零", () => {
  test("startedAt 缺失时 elapsedMs 为 0", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-no-started", state: "running", startedAt: undefined }),
      { requirementTitle: "demo" },
    );

    timeSource.advance(5_000);
    const row = activity.rows().find((r: RunLike) => r.id === "run-no-started");
    expect(row?.elapsedMs).toBe(0);
  });

  test("startedAt 畸形时 elapsedMs 为 0", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(
      activity,
      REPO_A.repoId,
      runFixture({ id: "run-bad-started", state: "running", startedAt: "not-a-date" }),
      { requirementTitle: "demo" },
    );

    timeSource.advance(5_000);
    const row = activity.rows().find((r: RunLike) => r.id === "run-bad-started");
    expect(row?.elapsedMs).toBe(0);
  });
});

describe("各状态按钮集合", () => {
  function buttonsFor(state: string, meta: { activeShellTasks?: number } = {}): unknown[] {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-buttons", state }), {
      requirementTitle: "demo",
      ...meta,
    });
    return (activity.rows().find((r: RunLike) => r.id === "run-buttons")?.buttons as unknown[]) ?? [];
  }

  test("运行中：暂停/停止/查看", () => {
    expect(new Set(buttonsFor("running"))).toEqual(new Set(["pause", "stop", "view"]));
  });

  test("已暂停：继续/停止/查看", () => {
    expect(new Set(buttonsFor("paused"))).toEqual(new Set(["resume", "stop", "view"]));
  });

  test("中断：续接/停止/查看", () => {
    expect(new Set(buttonsFor("interrupted", { activeShellTasks: 1 }))).toEqual(
      new Set(["resumeInterrupted", "stop", "view"]),
    );
  });

  test("等待答复：停止/查看，且待答标记为真", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-waiting", state: "waiting_answer" }), {
      requirementTitle: "demo",
    });
    const row = activity.rows().find((r: RunLike) => r.id === "run-waiting");
    expect(new Set(row?.buttons as unknown[])).toEqual(new Set(["stop", "view"]));
    expect(row?.waiting).toBe(true);
  });

  test("排队中/正在暂停/网络暂停：停止/查看", () => {
    for (const state of ["queued", "pausing", "paused_network"]) {
      expect((buttonsFor(state) as string[]).slice().sort()).toEqual(["stop", "view"]);
    }
  });

  test("已终止（完成/失败/停止）无可用按钮", () => {
    for (const state of ["completed", "failed", "stopped"]) {
      expect(buttonsFor(state)).toEqual([]);
    }
  });

  test("未知运行状态兜底为停止/查看，而非 undefined", () => {
    expect((buttonsFor("bogus_state") as string[]).slice().sort()).toEqual(["stop", "view"]);
  });
});
