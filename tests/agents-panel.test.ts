import { describe, expect, test } from "bun:test";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { AgentsActivity } from "../runtime/agents-activity.ts";
import { AgentsPanel, createAgentsPanel, mountAgentsPanel } from "../runtime/agents-panel.ts";
import type { AgentsPanelOptions, MountAgentsPanelCtx } from "../runtime/agents-panel.ts";

interface FakeTimeSource extends TimeSource {
  advance(ms: number): void;
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

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance };
}

type RunLike = Record<string, unknown>;

const REPO_A = { repoId: "repo-a-id", name: "repo-a" };
const REPO_B = { repoId: "repo-b-id", name: "repo-b" };

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  downKittyRelease: "\x1b[1;1:3B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  escape: "\x1b",
  escapeKitty: "\x1b[27u",
  tab: "\t",
};

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
  activity.applyRunsChanged(repoId, { run, ...meta } as never);
}

function buildFiveEntryActivity(clock: ReturnType<typeof createClock>): AgentsActivity {
  const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
  pushRun(activity, REPO_A.repoId, runFixture({ id: "run-running", state: "running" }), { requirementTitle: "需求甲" });
  pushRun(activity, REPO_A.repoId, runFixture({ id: "run-paused", state: "paused" }), { requirementTitle: "需求乙" });
  pushRun(activity, REPO_B.repoId, runFixture({ id: "run-interrupted", state: "interrupted" }), {
    requirementTitle: "需求丙",
    activeShellTasks: 1,
  });
  pushRun(activity, REPO_B.repoId, runFixture({ id: "run-waiting", state: "waiting_answer" }), { requirementTitle: "需求丁" });
  pushRun(activity, REPO_A.repoId, runFixture({ id: "run-done", state: "completed" }), { requirementTitle: "需求戊" });
  return activity;
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

function createFakeClient() {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return {};
    },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 暂停确认前后展示、去重与到期都需要能精确控制某一次 call 的返回/永不返回，因此不能像 createFakeClient 那样立即 resolve；
// 迟到结算场景还需要单独兑现某一次早于最新一次的 call，因此按索引而非只按"最后一次"寻址
function createControllableClient() {
  const calls: RecordedCall[] = [];
  const pendings: ReturnType<typeof createDeferred<Record<string, unknown>>>[] = [];
  return {
    calls,
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const deferred = createDeferred<Record<string, unknown>>();
      pendings.push(deferred);
      return deferred.promise;
    },
    resolveAt: (index: number, value: Record<string, unknown> = {}) => pendings[index]?.resolve(value),
    rejectAt: (index: number, reason: unknown) => pendings[index]?.reject(reason),
    resolveLast: (value: Record<string, unknown> = {}) => pendings.at(-1)?.resolve(value),
    rejectLast: (reason: unknown) => pendings.at(-1)?.reject(reason),
  };
}

function createFakeClients(byRepo: Record<string, ReturnType<typeof createFakeClient>>) {
  return { forRepo: (repoId: string) => byRepo[repoId] };
}

// 用可观测哨兵包裹而非真实 ANSI，断言时才能确认高亮/灰显确实生效而非巧合命中其他文本
function fakeTheme() {
  return {
    fg: (kind: string, text: string) => (kind === "dim" || kind === "muted" ? `[DIM]${text}[/DIM]` : text),
    bg: (kind: string, text: string) => (kind === "selectedBg" ? `[SEL]${text}[/SEL]` : text),
  };
}

function ansiTheme() {
  return {
    fg: (_kind: string, text: string) => text,
    bg: (kind: string, text: string) => (kind === "selectedBg" ? `\x1b[34m${text}\x1b[0m` : text),
  };
}

function lineFor(lines: string[], marker: string): string {
  const found = lines.find((line) => line.includes(marker));
  if (!found) throw new Error(`未找到包含 ${marker} 的渲染行`);
  return found;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clickEvent(y: number) {
  return {
    type: "click" as const,
    button: "left" as const,
    x: 0,
    y,
    screenX: 0,
    screenY: y,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe("行内字段：标题/状态/活动/轮次/耗时/待答/中断Shell数/停止清理数/不可达原因", () => {
  test("各字段的具体取值都能在对应条目所在行中找到", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    // 不可达状态按仓库生效并会清空该仓库内其他行的活动展示，因此放到 REPO_B 隔离，避免影响 REPO_A 的活动字段断言
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-turns", state: "running", turns: 71 }), { requirementTitle: "轮次需求" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-activity", state: "running" }), { requirementTitle: "活动需求" });
    activity.applyActivity({ runId: "run-activity", kind: "tool_start", toolName: "bash", toolCallId: "call-1", at: new Date(0).toISOString() });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-waiting", state: "waiting_answer" }), { requirementTitle: "甲需求" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-interrupted", state: "interrupted" }), {
      requirementTitle: "中断需求",
      activeShellTasks: 53,
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-cleanup", state: "stopped" }), {
      requirementTitle: "清理需求",
      pendingShellCleanup: 92,
    });
    pushRun(activity, REPO_B.repoId, runFixture({ id: "run-unreachable", state: "running" }), { requirementTitle: "不可达需求" });
    activity.applyConnectionState(REPO_B.repoId, { status: "unreachable", reason: "测试注入连接原因" });

    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
    const lines = panel.render(80);

    expect(lineFor(lines, "轮次需求")).toContain("71");
    expect(lineFor(lines, "活动需求")).toContain("bash");
    expect(lineFor(lines, "甲需求")).toContain("待答");
    expect(lineFor(lines, "中断需求")).toContain("53");
    expect(lineFor(lines, "清理需求")).toContain("92");
    expect(lineFor(lines, "不可达需求")).toContain("测试注入连接原因");
  });

  test("不可达但未携带 reason 时仍显示不可达", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-no-reason", state: "running" }), { requirementTitle: "无原因需求" });
    activity.applyConnectionState(REPO_A.repoId, { status: "unreachable" });

    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
    expect(lineFor(panel.render(80), "无原因需求")).toContain("不可达");
  });

  test("耗时随时钟推进变化，证明渲染反映了 elapsedMs", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-elapsed", state: "running" }), { requirementTitle: "耗时需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    const before = lineFor(panel.render(80), "耗时需求");
    timeSource.advance(90_000);
    const after = lineFor(panel.render(80), "耗时需求");

    expect(after).not.toBe(before);
  });

  test("耗时 90 秒显示为 1m30s", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-90s", state: "running" }), { requirementTitle: "九十秒需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    timeSource.advance(90_000);
    expect(lineFor(panel.render(80), "九十秒需求")).toContain("1m30s");
  });

  test("耗时 7200 秒显示含 2h", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-2h", state: "running" }), { requirementTitle: "两小时需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    timeSource.advance(7_200_000);
    expect(lineFor(panel.render(80), "两小时需求")).toContain("2h");
  });

  test("控制字符不出现在渲染输出中：活动工具名、连接不可达原因、失败提示消息三处来源都被剥离", async () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-control-activity", state: "running" }), { requirementTitle: "控制活动需求" });
    activity.applyActivity({
      runId: "run-control-activity",
      kind: "tool_start",
      toolName: "\x1b[31mbash",
      toolCallId: "call-1",
      at: new Date(0).toISOString(),
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-control-reason", state: "running" }), { requirementTitle: "控制原因需求" });
    activity.applyConnectionState(REPO_A.repoId, { status: "unreachable", reason: "\x1b]0;隐藏标题\x07可见原因" });

    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    controllable.rejectLast(new Error("\x1b[31m未确认\x1b[0m"));
    await flushMicrotasks();

    const output = panel.render(80).join("\n");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\x07");
  });

  test("控制字符剥离覆盖 C1 范围（十六进制 80-9f）与状态兜底/Shell 计数/清理计数拼接片段", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    const c1 = String.fromCharCode(0x88);
    const c1Title = String.fromCharCode(0x9b);
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-bad-state", state: `\x1b[31m非法状态${c1}` }), {
      requirementTitle: "非法状态需求",
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-bad-shell", state: "interrupted" }), {
      requirementTitle: "非法Shell需求",
      activeShellTasks: `3${c1}` as unknown as number,
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-bad-cleanup", state: "stopped" }), {
      requirementTitle: "非法清理需求",
      pendingShellCleanup: "4\x1b[31m" as unknown as number,
    });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-c1-title", state: "running" }), {
      requirementTitle: `含${c1Title}标题`,
    });

    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
    const output = panel.render(80).join("\n");

    for (let code = 0x80; code <= 0x9f; code++) expect(output).not.toContain(String.fromCharCode(code));
    expect(output).not.toContain("\x1b");
  });
});

describe("状态查表不走原型链", () => {
  test("state 为 toString/constructor/__proto__ 或缺失时不渲染函数源码、换行或 undefined", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    for (const [index, state] of ["toString", "constructor", "__proto__", "valueOf", undefined].entries()) {
      pushRun(activity, REPO_A.repoId, runFixture({ id: `run-proto-${index}`, state: state as unknown as string }), {
        requirementTitle: `原型键需求${index}`,
      });
    }
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
    const lines = panel.render(80);
    for (const line of lines) {
      expect(line).not.toContain("native code");
      expect(line).not.toContain("\n");
      expect(line).not.toContain("[object Object]");
      expect(line).not.toContain("undefined");
    }
  });
});

describe("行内状态为中文标签，轮次格式为「第 N 轮」", () => {
  test("各 RunState 都映射到对应中文标签", () => {
    const stateLabels: Array<[string, string]> = [
      ["running", "运行中"],
      ["pausing", "暂停中"],
      ["paused", "已暂停"],
      ["paused_network", "网络暂停"],
      ["waiting_answer", "等待答复"],
      ["interrupted", "已中断"],
      ["completed", "已完成"],
      ["failed", "失败"],
      ["stopped", "已停止"],
      ["queued", "排队"],
    ];
    for (const [state, label] of stateLabels) {
      const clock = createClock({ timeSource: createFakeTimeSource() });
      const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
      pushRun(activity, REPO_A.repoId, runFixture({ id: "run-state", state }), { requirementTitle: "状态需求" });
      const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
      expect(lineFor(panel.render(80), "状态需求")).toContain(label);
    }
  });

  test("轮次数以「第 N 轮」格式出现", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-round", state: "running", turns: 3 }), { requirementTitle: "轮次格式需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });
    expect(lineFor(panel.render(80), "轮次格式需求")).toContain("第 3 轮");
  });
});

describe("结束条目灰显", () => {
  test("已结束（completed）条目用 theme.fg(dim/muted) 包裹，未结束条目不包裹", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-live", state: "running" }), { requirementTitle: "存活需求" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-ended", state: "completed" }), { requirementTitle: "结束需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

    const lines = panel.render(80);
    expect(lineFor(lines, "结束需求")).toContain("[DIM]");
    expect(lineFor(lines, "存活需求")).not.toContain("[DIM]");
  });
});

describe("按状态展示相符的按钮，三个按钮字样始终共存", () => {
  test("运行中/已暂停/中断/等待答复四种条目各自展示应有按钮标签", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = buildFiveEntryActivity(clock);
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    const lines = panel.render(80);

    const runningLine = lineFor(lines, "需求甲");
    expect(runningLine).toContain("暂停");
    expect(runningLine).toContain("停止");
    expect(runningLine).toContain("查看");

    const pausedLine = lineFor(lines, "需求乙");
    expect(pausedLine).toContain("继续");
    expect(pausedLine).toContain("停止");
    expect(pausedLine).toContain("查看");

    const interruptedLine = lineFor(lines, "需求丙");
    expect(interruptedLine).toContain("续接");
    expect(interruptedLine).toContain("停止");
    expect(interruptedLine).toContain("查看");

    const waitingLine = lineFor(lines, "需求丁");
    expect(waitingLine).toContain("停止");
    expect(waitingLine).toContain("查看");
  });
});

describe("选中按钮高亮位移，三个按钮共存，无箭头字符", () => {
  test("默认选中首个按钮并带主题高亮哨兵，渲染文本不含箭头字符", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-x", state: "running" }), { requirementTitle: "选中态需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

    const line = lineFor(panel.render(80), "选中态需求");
    expect(line).toContain("[SEL]暂停[/SEL]");
    expect(line).toContain("停止");
    expect(line).toContain("查看");
    for (const arrow of ["→", "▶", "➤", ">"]) expect(line).not.toContain(arrow);
  });

  test("按 → 后高亮位移到下一个按钮，三个按钮字样仍共存", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-x", state: "running" }), { requirementTitle: "选中态需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

    panel.handleInput(KEY.right);
    const line = lineFor(panel.render(80), "选中态需求");
    expect(line).toContain("[SEL]停止[/SEL]");
    expect(line).toContain("暂停");
    expect(line).toContain("查看");
  });
});

describe("focus/blur 控制选中态是否渲染", () => {
  test("blur 后不再渲染高亮哨兵，focus 后恢复", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-x", state: "running" }), { requirementTitle: "选中态需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

    panel.blur();
    expect(lineFor(panel.render(80), "选中态需求")).not.toContain("[SEL]");

    panel.focus();
    expect(lineFor(panel.render(80), "选中态需求")).toContain("[SEL]");
  });
});

describe("Kitty 协议释放事件不重复触发按键", () => {
  test("↓ 的按下+释放只移动一次光标", () => {
    setKittyProtocolActive(true);
    try {
      const clock = createClock({ timeSource: createFakeTimeSource() });
      const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
      pushRun(activity, REPO_A.repoId, runFixture({ id: "run-0", state: "running" }), { requirementTitle: "光标甲" });
      pushRun(activity, REPO_A.repoId, runFixture({ id: "run-1", state: "running" }), { requirementTitle: "光标乙" });
      pushRun(activity, REPO_A.repoId, runFixture({ id: "run-2", state: "running" }), { requirementTitle: "光标丙" });
      const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

      panel.handleInput(KEY.down);
      panel.handleInput(KEY.downKittyRelease);

      const lines = panel.render(80);
      expect(lineFor(lines, "光标乙")).toContain("[SEL]");
      expect(lineFor(lines, "光标丙")).not.toContain("[SEL]");
    } finally {
      setKittyProtocolActive(false);
    }
  });

  test("Tab 的按下+释放只切换一次单项/批量", async () => {
    setKittyProtocolActive(true);
    try {
      const clock = createClock({ timeSource: createFakeTimeSource() });
      const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
      pushRun(activity, REPO_A.repoId, runFixture({ id: "run-a", state: "running" }), { requirementTitle: "需求A" });
      pushRun(activity, REPO_B.repoId, runFixture({ id: "run-b", state: "running" }), { requirementTitle: "需求B" });
      const clientA = createFakeClient();
      const clientB = createFakeClient();
      const clients = createFakeClients({ [REPO_A.repoId]: clientA, [REPO_B.repoId]: clientB });
      const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

      panel.handleInput(KEY.tab);
      panel.handleInput("\x1b[9;1:3u");
      await flushMicrotasks();
      panel.handleInput(KEY.enter);
      await flushMicrotasks();

      expect(clientA.calls).toHaveLength(1);
      expect(clientB.calls).toHaveLength(1);
    } finally {
      setKittyProtocolActive(false);
    }
  });
});

describe("容量上限与滚动，↓ 移动到末项后 Enter 执行到正确目标", () => {
  test("12 个条目时面板内容行数不超过 availableRows 上限，末项 Enter 执行的是末项所在仓库的客户端", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
    for (let i = 0; i < 12; i++) {
      const repo = i < 6 ? REPO_A : REPO_B;
      pushRun(activity, repo.repoId, runFixture({ id: `run-${i}`, state: "running" }), { requirementTitle: `需求-${i}` });
    }
    const repoAClient = createFakeClient();
    const repoBClient = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: repoAClient, [REPO_B.repoId]: repoBClient });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {}, availableRows: () => 4 });

    expect(panel.render(80).length).toBeLessThanOrEqual(4);

    for (let i = 0; i < 11; i++) panel.handleInput(KEY.down);
    expect(panel.render(80).length).toBeLessThanOrEqual(4);

    panel.handleInput(KEY.enter);
    expect(repoBClient.calls).toHaveLength(1);
    expect(repoBClient.calls[0]?.params.runId).toBe("run-11");
    expect(repoAClient.calls).toHaveLength(0);
  });
});

describe("鼠标行号映射与渲染共用窗口计算", () => {
  test("普通终端模式：点击不消费事件，也不触发执行", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-mouse", state: "running" }), { requirementTitle: "鼠标需求" });
    const client = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: client });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {}, captureMode: "regular" });

    const result = panel.handleMouse?.(clickEvent(0));
    expect(result).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  test("全屏模式：点击目标条目触发其当前选中按钮的执行", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-mouse", state: "running" }), { requirementTitle: "鼠标需求" });
    const client = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: client });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {}, captureMode: "fullscreen" });

    const result = panel.handleMouse?.(clickEvent(0));
    expect(result?.handled).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.params.runId).toBe("run-mouse");
  });

  test("12 条目、容量 4、有失败提示时，点击 y=0 命中渲染首行对应运行；点击提示行不下发", async () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
    for (let i = 0; i < 12; i++) {
      const repo = i < 6 ? REPO_A : REPO_B;
      pushRun(activity, repo.repoId, runFixture({ id: `run-${i}`, state: "running" }), { requirementTitle: `需求-${i}` });
    }
    const repoAClient = createControllableClient();
    const repoBClient = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: repoAClient, [REPO_B.repoId]: repoBClient });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {}, availableRows: () => 4, captureMode: "fullscreen" });

    panel.handleInput(KEY.enter);
    repoAClient.rejectLast(new Error("请求未确认（测试注入）"));
    await flushMicrotasks();

    const lines = panel.render(80);
    expect(lines.length).toBeLessThanOrEqual(4);
    const noticeIndex = lines.findIndex((line) => !/需求-\d+/.test(line));
    expect(noticeIndex).toBeGreaterThanOrEqual(0);

    const firstLineRunId = /需求-(\d+)/.exec(lines[0] ?? "")?.[1];
    expect(firstLineRunId).toBeDefined();
    const targetClient = Number(firstLineRunId) < 6 ? repoAClient : repoBClient;
    const callsBeforeRowClick = targetClient.calls.length;

    panel.handleMouse?.(clickEvent(0));
    expect(targetClient.calls.length).toBe(callsBeforeRowClick + 1);
    expect(targetClient.calls.at(-1)?.params.runId).toBe(`run-${firstLineRunId}`);

    const totalCallsBeforeNoticeClick = repoAClient.calls.length + repoBClient.calls.length;
    panel.handleMouse?.(clickEvent(noticeIndex));
    expect(repoAClient.calls.length + repoBClient.calls.length).toBe(totalCallsBeforeNoticeClick);
  });
});

describe("Tab 切换单项/批量，批量执行时对全部仓库广播", () => {
  test("默认单项模式只对光标条目执行；Tab 切至批量后对两个仓库广播；再次 Tab 切回单项后仅执行光标条目", async () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A, REPO_B] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-a", state: "running" }), { requirementTitle: "需求A" });
    pushRun(activity, REPO_B.repoId, runFixture({ id: "run-b", state: "running" }), { requirementTitle: "需求B" });
    const clientA = createFakeClient();
    const clientB = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: clientA, [REPO_B.repoId]: clientB });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(clientA.calls).toHaveLength(1);
    expect(clientB.calls).toHaveLength(0);

    panel.handleInput(KEY.tab);
    await flushMicrotasks();
    panel.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(clientA.calls).toHaveLength(2);
    expect(clientB.calls).toHaveLength(1);

    panel.handleInput(KEY.tab);
    await flushMicrotasks();
    panel.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(clientA.calls).toHaveLength(3);
    expect(clientB.calls).toHaveLength(1);
  });

  test("发送中按 Tab 切换单项/批量不清除在途标记，未确认前重复 Enter 不重复下发", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-tab-inflight", state: "running" }), { requirementTitle: "在途需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    expect(controllable.calls).toHaveLength(1);

    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.tab);
    panel.handleInput(KEY.enter);

    expect(controllable.calls).toHaveLength(1);
  });
});

describe("执行：发送中乐观标签、去重、按令牌校验结算并按真实结果更新按钮", () => {
  test("发送期间显示暂停中且重复 Enter 不重复下发；模拟 runs.changed 确认后乐观标签清除、按钮变为已暂停态", async () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-pause-flow", state: "running" }), { requirementTitle: "暂停流程需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    panel.handleInput(KEY.enter);
    expect(controllable.calls).toHaveLength(1);
    expect(controllable.calls[0]?.params.runId).toBe("run-pause-flow");

    const pendingText = lineFor(panel.render(80), "暂停流程需求");
    expect(pendingText).toContain("暂停中");

    controllable.resolveLast({});
    await flushMicrotasks();
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-pause-flow", state: "paused" }), { requirementTitle: "暂停流程需求" });

    const confirmedText = lineFor(panel.render(80), "暂停流程需求");
    expect(confirmedText).not.toContain("暂停中");
    expect(confirmedText).toContain("继续");
    expect(confirmedText).toContain("停止");
    expect(confirmedText).toContain("查看");
  });

  test("到期检测只由 tick() 触发，render() 是纯投影：不调用 tick() 时推进 30 秒不产生未确认提示", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-pure-render", state: "running" }), { requirementTitle: "纯投影需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    timeSource.advance(30_000);
    panel.render(80);

    expect(activity.notice()).toBeUndefined();
  });

  test("调用 tick() 后 30 秒在途标记到期：activity.notice() 含未确认，随后渲染显示按钮已恢复", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-timeout", state: "running" }), { requirementTitle: "超时需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    expect(lineFor(panel.render(80), "超时需求")).toContain("暂停中");

    timeSource.advance(30_000);
    panel.tick();

    expect(activity.notice()?.message).toContain("未确认");
    const afterTimeoutLine = lineFor(panel.render(80), "超时需求");
    expect(afterTimeoutLine).not.toContain("暂停中");
    expect(afterTimeoutLine).toContain("暂停");
  });

  test("迟到结算按令牌校验：到期后旧回执延迟到达不清除新一轮的在途标记", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-late", state: "running" }), { requirementTitle: "迟到需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    timeSource.advance(30_000);
    panel.tick();
    expect(activity.notice()?.message).toContain("未确认");

    panel.handleInput(KEY.enter);
    expect(controllable.calls).toHaveLength(2);

    controllable.resolveAt(0, {});
    await flushMicrotasks();
    expect(lineFor(panel.render(80), "迟到需求")).toContain("暂停中");

    panel.handleInput(KEY.enter);
    expect(controllable.calls).toHaveLength(2);

    controllable.resolveAt(1, {});
    await flushMicrotasks();
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-late", state: "paused" }), { requirementTitle: "迟到需求" });
    expect(lineFor(panel.render(80), "迟到需求")).not.toContain("暂停中");
  });
});

describe("失败：条目仍在、独立提示行出现，19 秒仍在、20 秒消失，新提示替换并重新计时", () => {
  test("客户端失败不隐藏条目，提示是与条目区分开的独立行；19 秒仍在，20 秒消失", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-a", state: "running" }), { requirementTitle: "甲需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    controllable.rejectLast(new Error("请求未确认（测试注入）"));
    await flushMicrotasks();

    const linesAfterFailure = panel.render(80);
    expect(lineFor(linesAfterFailure, "甲需求")).toBeDefined();
    const noticeLine = linesAfterFailure.find((line) => !line.includes("甲需求"));
    expect(noticeLine).toBeDefined();

    timeSource.advance(19_000);
    expect(panel.render(80).some((line) => !line.includes("甲需求"))).toBe(true);

    timeSource.advance(1_000);
    expect(panel.render(80).every((line) => line.includes("甲需求"))).toBe(true);
  });

  test("新的失败提示替换旧提示并重新计时（旧提示原本已到期的时间点仍显示新提示）", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-a", state: "running" }), { requirementTitle: "甲需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {} });

    panel.handleInput(KEY.enter);
    controllable.rejectLast(new Error("第一次请求未确认（测试注入）"));
    await flushMicrotasks();

    timeSource.advance(15_000);
    panel.handleInput(KEY.enter);
    controllable.rejectLast(new Error("第二次请求未确认（测试注入）"));
    await flushMicrotasks();

    // 距第一次失败已 20 秒，但距第二次失败仅 5 秒，提示应仍在
    timeSource.advance(5_000);
    expect(panel.render(80).some((line) => !line.includes("甲需求"))).toBe(true);

    timeSource.advance(15_000);
    expect(panel.render(80).every((line) => line.includes("甲需求"))).toBe(true);
  });

  test("有提示时总行数仍不超过 availableRows 上限", async () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-a", state: "running" }), { requirementTitle: "甲需求" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-b", state: "running" }), { requirementTitle: "乙需求" });
    const controllable = createControllableClient();
    const clients = createFakeClients({ [REPO_A.repoId]: controllable });
    const panel = new AgentsPanel({ activity, clock, clients, onView: () => {}, availableRows: () => 2 });

    panel.handleInput(KEY.enter);
    controllable.rejectLast(new Error("请求未确认（测试注入）"));
    await flushMicrotasks();

    expect(panel.render(80).length).toBeLessThanOrEqual(2);
  });
});

describe("查看按钮触发 onView 回调而非客户端调用", () => {
  test("选中查看按钮并 Enter 时调用 onView 并传入 runId", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-view", state: "waiting_answer" }), { requirementTitle: "查看需求" });
    const client = createFakeClient();
    const clients = createFakeClients({ [REPO_A.repoId]: client });
    const viewed: string[] = [];
    const panel = new AgentsPanel({ activity, clock, clients, onView: (runId: string) => viewed.push(runId) });

    panel.handleInput(KEY.right);
    panel.handleInput(KEY.enter);

    expect(viewed).toEqual(["run-view"]);
    expect(client.calls).toHaveLength(0);
  });
});

describe("hasRows 供宿主判断面板是否存在可选条目", () => {
  test("无条目时为假，出现条目后为真", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    expect(panel.hasRows()).toBe(false);
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-only", state: "running" }), { requirementTitle: "唯一需求" });
    expect(panel.hasRows()).toBe(true);
  });
});

describe("宽度按显示列裁剪，不约束标签语言", () => {
  test("60 个汉字标题渲染行显示宽度不超过 80", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-wide", state: "running" }), { requirementTitle: "汉".repeat(60) });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    const lines = panel.render(80);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  test("标题中的 ESC/控制字符不出现在渲染输出中", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-control", state: "running" }), {
      requirementTitle: "恶意\x1b[31m标题\x07标记",
    });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    const output = panel.render(80).join("\n");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\x07");
  });

  test("主题高亮插入真实 ANSI 时不计入显示宽度，且不约束标签语言", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-ansi", state: "running" }), { requirementTitle: "ANSI需求" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: ansiTheme(), onView: () => {} });

    const line = lineFor(panel.render(80), "ANSI需求");
    expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(line).toContain("\x1b[34m");
    expect(line.length - line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeGreaterThanOrEqual(9);
  });
});

describe("createAgentsPanel 工厂函数", () => {
  test("产出的面板与直接构造 AgentsPanel 行为一致", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-factory", state: "running" }), { requirementTitle: "工厂需求" });
    const panel = createAgentsPanel({ activity, clock, clients: createFakeClients({}), onView: () => {} });

    const lines = panel.render(80);
    expect(lines.some((line) => line.includes("工厂需求"))).toBe(true);
  });
});

describe("mountAgentsPanel 的宿主能力检测、placement、requestRender 与 footer 定位", () => {
  class FooterComponent {
    render(): string[] {
      return ["FOOTER"];
    }
    invalidate(): void {}
  }

  function baseOptions(): AgentsPanelOptions {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-mount", state: "running" }), { requirementTitle: "挂载需求" });
    return { activity, clock, clients: createFakeClients({}), onView: () => {} };
  }

  test("mode 非 tui（即便 ui 能力齐全）时返回未挂载与原因，且不抛错", () => {
    const ctx: MountAgentsPanelCtx = {
      mode: "print",
      hasUI: true,
      ui: { setWidget: () => {}, onTerminalInput: () => () => {} },
    };
    expect(() => {
      const result = mountAgentsPanel(ctx, baseOptions());
      expect(result.mounted).toBe(false);
      expect(result.reason).toBeDefined();
    }).not.toThrow();
  });

  test("mode 为 tui 但 hasUI 为 false（即便 ui 能力齐全）时未挂载，原因含无终端能力字样", () => {
    const ctx: MountAgentsPanelCtx = {
      mode: "tui",
      hasUI: false,
      ui: { setWidget: () => {}, onTerminalInput: () => () => {} },
    };
    const result = mountAgentsPanel(ctx, baseOptions());
    expect(result.mounted).toBe(false);
    expect(result.reason).toContain("无终端能力");
  });

  test("tui 模式但缺少 ui 时未挂载", () => {
    const ctx: MountAgentsPanelCtx = { mode: "tui", hasUI: true };
    const result = mountAgentsPanel(ctx, baseOptions());
    expect(result.mounted).toBe(false);
  });

  test("tui 模式但 ui 缺 setWidget 时未挂载", () => {
    const ctx: MountAgentsPanelCtx = { mode: "tui", hasUI: true, ui: { onTerminalInput: () => () => {} } };
    const result = mountAgentsPanel(ctx, baseOptions());
    expect(result.mounted).toBe(false);
  });

  test("tui 模式但 ui 缺 onTerminalInput 时未挂载", () => {
    const ctx: MountAgentsPanelCtx = { mode: "tui", hasUI: true, ui: { setWidget: () => {} } };
    const result = mountAgentsPanel(ctx, baseOptions());
    expect(result.mounted).toBe(false);
  });

  test("能力齐全时挂载成功：placement 为 belowEditor，面板在 footer 之后，工厂注入的 theme 生效，invalidate 触发宿主 requestRender，卸载函数移除面板", () => {
    const hostChildren: unknown[] = [new FooterComponent()];
    let mountedComponent: unknown;
    let capturedFactory: ((tui: unknown, theme: unknown) => unknown) | undefined;
    let capturedOptions: { placement?: string } | undefined;
    const ctx: MountAgentsPanelCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget: (_key: string, content: unknown, options?: { placement?: string }) => {
          capturedOptions = options;
          if (content === undefined) {
            const idx = hostChildren.indexOf(mountedComponent);
            if (idx >= 0) hostChildren.splice(idx, 1);
            mountedComponent = undefined;
            return;
          }
          capturedFactory = content as (tui: unknown, theme: unknown) => unknown;
        },
        onTerminalInput: () => () => {},
      },
    };

    const result = mountAgentsPanel(ctx, baseOptions());
    expect(result.mounted).toBe(true);
    expect(capturedOptions?.placement).toBe("belowEditor");

    let requestRenderCalls = 0;
    const fakeTui = {
      requestRender: () => {
        requestRenderCalls++;
      },
    };
    mountedComponent = capturedFactory?.(fakeTui, fakeTheme());
    hostChildren.push(mountedComponent);
    expect(hostChildren).toHaveLength(2);
    expect(hostChildren[0]).toBeInstanceOf(FooterComponent);
    expect(hostChildren[1]).not.toBeInstanceOf(FooterComponent);

    const component = mountedComponent as { render(width: number): string[]; invalidate(): void };
    expect(lineFor(component.render(80), "挂载需求")).toContain("[SEL]");

    const callsBeforeInvalidate = requestRenderCalls;
    component.invalidate();
    expect(requestRenderCalls).toBe(callsBeforeInvalidate + 1);

    result.unmount?.();
    expect(hostChildren).toHaveLength(1);
    expect(hostChildren[0]).toBeInstanceOf(FooterComponent);
  });
});

describe("selectedRunId/selectRun 用于查看页关闭后恢复选中", () => {
  test("selectedRunId 返回当前光标行 runId；selectRun 定位到指定行并高亮；未知 id 夹到最近合法行", () => {
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const activity = new AgentsActivity({ clock, workspaceRepos: [REPO_A] });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-0", state: "running" }), { requirementTitle: "光标甲" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-1", state: "running" }), { requirementTitle: "光标乙" });
    pushRun(activity, REPO_A.repoId, runFixture({ id: "run-2", state: "running" }), { requirementTitle: "光标丙" });
    const panel = new AgentsPanel({ activity, clock, clients: createFakeClients({}), theme: fakeTheme(), onView: () => {} });

    expect(panel.selectedRunId()).toBe("run-0");

    panel.selectRun("run-2");
    expect(panel.selectedRunId()).toBe("run-2");
    expect(lineFor(panel.render(80), "光标丙")).toContain("[SEL]");

    panel.selectRun("run-missing");
    expect(["run-0", "run-1", "run-2"]).toContain(panel.selectedRunId());
  });
});
