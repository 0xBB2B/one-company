import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { BottomDock } from "../runtime/dock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host } from "../runtime/shell-registry.ts";
import { ShellPage, hostLabel, openShellPage } from "../runtime/shell-page.ts";
import type { ShellPageDecisionResult, ShellPageRepo } from "../runtime/shell-page.ts";

const MAIN_HOST: Host = { kind: "main", id: "main" };

const KEY = {
  down: "\x1b[B",
  right: "\x1b[C",
  enter: "\r",
  escape: "\x1b",
  k: "K",
};

const spawnedPgids: number[] = [];

afterEach(() => {
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 组已消失，无需处理
    }
  }
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleepMs(intervalMs);
  }
  if (!predicate()) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

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

async function spawnLocal(registry: ShellRegistry, marker: string, script = "sleep 30"): Promise<string> {
  const taskId = randomUUID();
  const result = await registry.spawn({
    taskId,
    host: MAIN_HOST,
    command: "sh",
    args: ["-c", `${script} # ${marker}`],
    mode: "background",
    runToken: randomUUID(),
  });
  if (!result.ok) throw new Error(`夹具启动失败：${result.reason}`);
  spawnedPgids.push(result.task.pgid);
  await sleepMs(150);
  return taskId;
}

function roleHost(role: string, runId = randomUUID(), id = `req-${role}`): Host {
  return { kind: "role", id, role, runId };
}

function requirementHost(id: string): Host {
  return { kind: "requirement", id };
}

interface RepoCallLog {
  method: string;
  params: Record<string, unknown>;
}

function fakeRepo(
  repoId: string,
  handlers: {
    list?: () => Record<string, unknown>[];
    stop?: (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
    markStopped?: (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  },
  requirementTitle?: string,
): ShellPageRepo & { calls: RepoCallLog[] } {
  const calls: RepoCallLog[] = [];
  const repo: ShellPageRepo & { calls: RepoCallLog[] } = {
    repoId,
    requirementTitle,
    calls,
    client: {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "shells.list") return { tasks: handlers.list?.() ?? [] };
        if (method === "shells.stop") return await handlers.stop!(params);
        if (method === "shells.markStopped") return await handlers.markStopped!(params);
        return {};
      },
    },
  };
  return repo;
}

function fakeTheme() {
  return {
    fg: (kind: string, text: string) => (kind === "dim" || kind === "muted" ? `[DIM]${text}[/DIM]` : text),
    bg: (kind: string, text: string) => (kind === "selectedBg" ? `[SEL]${text}[/SEL]` : text),
  };
}

interface DecisionTaskArg {
  taskId: string;
  host: Host;
  command: string;
  requirement: string;
}

function recordingDecision(result: ShellPageDecisionResult | (() => Promise<ShellPageDecisionResult>)): {
  recordStopDecision: (task: DecisionTaskArg) => Promise<ShellPageDecisionResult>;
  calls: DecisionTaskArg[];
} {
  const calls: DecisionTaskArg[] = [];
  return {
    calls,
    recordStopDecision: async (task) => {
      calls.push(task);
      return typeof result === "function" ? result() : result;
    },
  };
}

function basePageOptions(overrides: Record<string, unknown> = {}) {
  return {
    registry: new ShellRegistry({ clock: createClock() }),
    repos: [] as ShellPageRepo[],
    clock: createClock(),
    recordStopDecision: async () => ({ ok: true, decisionId: "USER-001" }) as ShellPageDecisionResult,
    ...overrides,
  };
}

function countUnhandledRejections(): { count: () => number; stop: () => void } {
  let count = 0;
  const handler = () => {
    count += 1;
  };
  process.on("unhandledRejection", handler);
  return {
    count: () => count,
    stop: () => process.removeListener("unhandledRejection", handler),
  };
}

describe("hostLabel", () => {
  test("main 宿主显示为主 agent", () => {
    expect(hostLabel(MAIN_HOST)).toBe("主 agent");
  });

  test("requirement 宿主显示为需求代理 + 需求标题", () => {
    expect(hostLabel(requirementHost("req-1"), "示例需求标题")).toBe("需求代理 示例需求标题");
  });

  test("requirement 宿主缺少标题时不抛出且仍标注为需求代理", () => {
    expect(() => hostLabel(requirementHost("req-1"))).not.toThrow();
    expect(hostLabel(requirementHost("req-1"))).toContain("需求代理");
  });

  test("role 宿主显示为角色名#运行身份短码，不同运行身份短码不同", () => {
    const runIdA = randomUUID();
    const runIdB = randomUUID();
    const labelA = hostLabel(roleHost("worker", runIdA));
    const labelB = hostLabel(roleHost("worker", runIdB));
    expect(labelA.startsWith("worker#")).toBe(true);
    expect(labelB.startsWith("worker#")).toBe(true);
    expect(labelA).not.toBe(labelB);
  });
});

describe("ShellPage：列表只列本工作区任务，含编号/宿主/状态/耗时/命令", () => {
  test("inWorkspace=false 的守护进程任务不出现在列表中", async () => {
    const repo = fakeRepo("repo-scope", {
      list: () => [
        { taskId: "in-scope", host: roleHost("worker"), command: "范围内命令", cwd: "/repo", pid: 1, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
        { taskId: "out-scope", host: roleHost("worker"), command: "范围外命令", cwd: "/repo", pid: 2, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: false },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("范围内命令");
    expect(text).not.toContain("范围外命令");
  });

  test("耗时字段随时钟展示为约定格式（1m30s）", async () => {
    const timeSource = createFakeTimeSource();
    timeSource.advance(90_000);
    const clock = createClock({ timeSource });
    const repo = fakeRepo("repo-elapsed", {
      list: () => [
        { taskId: "t1", host: roleHost("worker"), command: "耗时命令", cwd: "/repo", pid: 1, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [repo], clock }));
    await page.refresh();
    expect(page.render(80).join("\n")).toContain("1m30s");
  });

  test("每任务一行，编号从 1 开始", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "编号标记一");
    await spawnLocal(registry, "编号标记二");
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    const lines = page.render(100);
    expect(lines.length).toBe(2);
    expect(lines[0]).toStartWith("1");
    expect(lines[1]).toStartWith("2");
  });

  test("选中行带主题选中态标记，无箭头字符", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "唯一任务");
    const page = new ShellPage(basePageOptions({ registry, theme: fakeTheme() }));
    await page.refresh();

    const line = page.render(100)[0]!;
    expect(line).toContain("[SEL]");
    for (const arrow of ["→", "▶", "➤", ">"]) expect(line).not.toContain(arrow);
  });
});

describe("ShellPage：已结束任务仅保留结束后 20 秒内", () => {
  test("任务结束后立即仍可见，19 秒内仍可见，超过 20 秒后从列表消失", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const registry = new ShellRegistry({ clock: createClock() });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: MAIN_HOST,
      command: "sh",
      args: ["-c", "sleep 0.1 # ttl标记"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    spawnedPgids.push(result.task.pgid);
    await waitFor(() => registry.get(taskId)?.status === "exited", 3_000);

    const page = new ShellPage(basePageOptions({ registry, clock }));
    await page.refresh();
    expect(page.render(80).join("\n")).toContain("ttl标记");

    timeSource.advance(19_000);
    await page.refresh();
    expect(page.render(80).join("\n")).toContain("ttl标记");

    timeSource.advance(2_000);
    await page.refresh();
    expect(page.render(80).join("\n")).not.toContain("ttl标记");
  }, 10_000);
});

describe("ShellPage：Enter 打开详情，仅展示身份/宿主/状态/完整命令/目录/进程号/耗时与 Esc 返回", () => {
  test("详情视图不含查看输出或停止按钮字样，且完整命令未被截断", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const longMarker = "详情命令标记".repeat(20);
    await spawnLocal(registry, longMarker);
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.resize(60, 20);

    page.handleInput(KEY.enter);
    const detail = page.render(60).join("\n");

    expect(detail).toContain(longMarker);
    expect(detail).toContain("Esc 返回");
    expect(detail).not.toContain("查看输出");
    expect(detail).not.toContain("停止");
    expect(detail).toContain("主 agent");
  });

  test("Esc 从详情返回列表，不触发关闭回调", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "返回列表标记");
    let closed = 0;
    const page = new ShellPage(basePageOptions({ registry, onClose: () => { closed += 1; } }));
    await page.refresh();

    page.handleInput(KEY.enter);
    expect(page.render(80).join("\n")).toContain("Esc 返回");

    page.handleInput(KEY.escape);
    expect(closed).toBe(0);
    expect(page.render(80).join("\n")).toContain("返回列表标记");
  });

  test("列表页 Esc 触发关闭回调", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "关闭标记");
    let closed = 0;
    const page = new ShellPage(basePageOptions({ registry, onClose: () => { closed += 1; } }));
    await page.refresh();

    page.handleInput(KEY.escape);
    expect(closed).toBe(1);
  });
});

describe("ShellPage：详情按进入时固定的任务身份，刷新后不串成另一任务", () => {
  test("详情打开期间守护进程返回顺序变化且原任务消失：详情不显示新任务的目录/进程号", async () => {
    let listCallCount = 0;
    const repo = fakeRepo("repo-identity", {
      list: () => {
        listCallCount += 1;
        if (listCallCount === 1) {
          return [
            { taskId: "task-x", host: roleHost("worker"), command: "命令X", cwd: "/dir-x", pid: 111, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
          ];
        }
        return [
          { taskId: "task-y", host: roleHost("worker"), command: "命令Y", cwd: "/dir-y", pid: 999, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
        ];
      },
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    page.handleInput(KEY.enter);
    const before = page.render(80).join("\n");
    expect(before).toContain("111");
    expect(before).toContain("/dir-x");

    await page.refresh();
    const after = page.render(80).join("\n");
    expect(after).not.toContain("999");
    expect(after).not.toContain("/dir-y");
    expect(after.includes("111") || after.includes("无法核对") || after.includes("已结束")).toBe(true);
  });
});

describe("ShellPage：K 打开停止确认，默认取消", () => {
  test("确认页展示编号、宿主、命令；默认选中取消；Esc 取消后进程仍存活", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const taskId = await spawnLocal(registry, "取消标记");
    const page = new ShellPage(basePageOptions({ registry, theme: fakeTheme() }));
    await page.refresh();

    page.handleInput(KEY.k);
    const confirmText = page.render(80).join("\n");
    expect(confirmText).toContain("主 agent");
    expect(confirmText).toContain("取消标记");
    expect(confirmText).toContain("[SEL]取消[/SEL]");

    page.handleInput(KEY.escape);
    expect(registry.get(taskId)?.status).not.toBe("stopped");
    expect(registry.get(taskId)?.status).not.toBe("stopping");
  }, 10_000);

  test("确认页内 Enter（未移动选中，仍为默认取消）不停止进程", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const taskId = await spawnLocal(registry, "默认取消标记");
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.enter);
    await sleepMs(200);

    expect(registry.get(taskId)?.status).not.toBe("stopped");
    expect(registry.get(taskId)?.status).not.toBe("stopping");
  }, 10_000);

  test("确认页 Esc 只取消返回列表，不关闭整页；列表页再按 Esc 才关闭", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "两段退出标记");
    let closed = 0;
    const page = new ShellPage(basePageOptions({ registry, onClose: () => { closed += 1; } }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.escape);

    expect(closed).toBe(0);
    expect(page.render(80).join("\n")).toContain("两段退出标记");

    page.handleInput(KEY.escape);
    expect(closed).toBe(1);
  }, 10_000);
});

describe("ShellPage：确认停止——先正在停止，清理确认后才报告已停止；只影响该任务及后代", () => {
  test("本窗口后台任务：确认后立即显示停止中，等待真实清理确认后显示已停止；同宿主其他任务不受影响", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const targetId = await spawnLocal(registry, "目标任务标记");
    const otherId = await spawnLocal(registry, "无关任务标记");
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);

    const stoppingText = page.render(80).join("\n");
    expect(stoppingText).toContain("停止中");

    await waitFor(() => registry.get(targetId)?.status === "stopped", 8_000);
    await page.refresh();
    const finalText = page.render(80).join("\n");
    expect(finalText).toContain("已停止");

    expect(registry.get(otherId)?.status).not.toBe("stopped");
  }, 15_000);
});

describe("ShellPage：目标自然结束显示真实结束状态而非虚构停止", () => {
  test("确认页打开期间目标自行退出并刷新后，列表显示真实的已结束状态", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const taskId = randomUUID();
    const result = await registry.spawn({
      taskId,
      host: MAIN_HOST,
      command: "sh",
      args: ["-c", "sleep 0.2 # 自然结束标记"],
      mode: "background",
      runToken: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    spawnedPgids.push(result.task.pgid);

    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.handleInput(KEY.k);

    await waitFor(() => registry.get(taskId)?.status === "exited", 5_000);
    page.handleInput(KEY.escape);
    await page.refresh();

    const finalText = page.render(80).join("\n");
    expect(finalText).toContain("已结束");
    expect(finalText).not.toContain("已停止");
  }, 10_000);
});

describe("ShellPage：停止失败路径——保持不确定态并显示原因，不回落运行中，无未处理拒绝", () => {
  test("本地 registry.stop 返回 ok:false：行内显示原因且不显示运行中/已停止", async () => {
    const rejection = countUnhandledRejections();
    try {
      const registry = new ShellRegistry({ clock: createClock() });
      const taskId = await spawnLocal(registry, "本地失败标记");
      const failureReason = "停止失败：目标已被其他进程接管（测试注入）";
      registry.stop = async () => ({ ok: false, reason: failureReason });
      const page = new ShellPage(basePageOptions({ registry }));
      await page.refresh();

      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await sleepMs(100);

      const text = page.render(80).join("\n");
      expect(text).toContain(failureReason);
      expect(text).not.toContain("运行中");
      expect(text).not.toContain("已停止");
      await sleepMs(50);
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  }, 10_000);

  test("守护进程 shells.stop 抛错/不可达：行内显示原因，且无未处理拒绝", async () => {
    const rejection = countUnhandledRejections();
    try {
      const repo = fakeRepo("repo-stop-fail", {
        list: () => [
          { taskId: "daemon-fail", host: roleHost("worker"), command: "daemon 命令", cwd: "/repo", pid: 4242, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
        ],
        stop: async () => {
          throw new Error("守护进程不可达（测试注入）");
        },
      });
      const page = new ShellPage(basePageOptions({ repos: [repo] }));
      await page.refresh();

      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await sleepMs(100);

      const text = page.render(80).join("\n");
      expect(text).toContain("守护进程不可达（测试注入）");
      expect(text).not.toContain("运行中");
      expect(text).not.toContain("已停止");
      await sleepMs(50);
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  }, 10_000);
});

describe("ShellPage：守护进程清理不确定时保留任务并显示原因", () => {
  test("shells.stop 回执 activity=uncertain：确认后行内保留任务并显示原因，不显示已停止", async () => {
    const startedAtIso = new Date(0).toISOString();
    const repo = fakeRepo("repo-uncertain", {
      list: () => [
        { taskId: "daemon-task-1", host: roleHost("worker"), command: "daemon 命令", cwd: "/repo", pid: 4242, startedAt: startedAtIso, status: "running", activity: "active", inWorkspace: true },
      ],
      stop: (params) => ({
        task: {
          taskId: "daemon-task-1",
          host: roleHost("worker"),
          command: "daemon 命令",
          cwd: "/repo",
          pid: params.expectedPid,
          startedAt: startedAtIso,
          status: "uncertain",
          activity: "uncertain",
          inWorkspace: true,
          reason: "清理确认超时（测试注入）",
        },
      }),
    });

    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await sleepMs(50);

    const stopCall = repo.calls.find((c) => c.method === "shells.stop");
    expect(stopCall?.params.taskId).toBe("daemon-task-1");
    expect(stopCall?.params.expectedPid).toBe(4242);
    expect(stopCall?.params.expectedStartedAt).toBe(startedAtIso);

    const text = page.render(80).join("\n");
    expect(text).toContain("不确定");
    expect(text).toContain("清理确认超时（测试注入）");
    expect(text).not.toContain("已停止");
  });
});

describe("ShellPage：不确定任务用户裁定为已停止——决策先写入再登记，登记失败保留原因", () => {
  async function makeUncertainLocalTask(): Promise<{ registry: ShellRegistry; taskId: string }> {
    let baselineTaken = false;
    const registry = new ShellRegistry({
      clock: createClock(),
      probes: {
        pidStartedAt: async () => {
          if (!baselineTaken) {
            baselineTaken = true;
            return 1_000_000;
          }
          return 1_000_000 + 999_999;
        },
      },
    });
    const taskId = randomUUID();
    const started = await registry.spawn({
      taskId,
      host: MAIN_HOST,
      command: "sh",
      args: ["-c", "sleep 30 # 裁定标记"],
      mode: "background",
      runToken: randomUUID(),
    });
    if (!started.ok) throw new Error(`夹具启动失败：${started.reason}`);
    spawnedPgids.push(started.task.pgid);
    await waitFor(() => registry.get(taskId)?.status === "uncertain", 5_000);
    return { registry, taskId };
  }

  test("决策写入成功：任务变为已停止，决策记录携带该任务身份，requirement 为固定主会话桶", async () => {
    const { registry, taskId } = await makeUncertainLocalTask();
    const decision = recordingDecision({ ok: true, decisionId: "USER-042" });
    const page = new ShellPage(basePageOptions({ registry, recordStopDecision: decision.recordStopDecision }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await sleepMs(50);

    expect(decision.calls.length).toBe(1);
    expect(decision.calls[0]?.taskId).toBe(taskId);
    expect(decision.calls[0]?.host).toEqual(MAIN_HOST);
    expect(decision.calls[0]?.requirement).toBeDefined();
    expect((decision.calls[0]?.requirement ?? "").length).toBeGreaterThan(0);
    expect(decision.calls[0]?.requirement ?? "").not.toContain("req-");

    expect(registry.get(taskId)?.status).toBe("stopped");
    await page.refresh();
    expect(page.render(80).join("\n")).toContain("已停止");
  }, 10_000);

  test("决策写入失败：任务保持不确定，显示失败原因", async () => {
    const { registry, taskId } = await makeUncertainLocalTask();
    const failureReason = "决策记录写入失败：磁盘只读（测试注入）";
    const decision = recordingDecision({ ok: false, reason: failureReason });
    const page = new ShellPage(basePageOptions({ registry, recordStopDecision: decision.recordStopDecision }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await sleepMs(50);

    expect(decision.calls.length).toBe(1);
    expect(registry.get(taskId)?.status).toBe("uncertain");
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("不确定");
    expect(text).toContain(failureReason);
  }, 10_000);

  test("本地 markStoppedByUser 返回 ok:false：显示登记失败原因，任务保持不确定", async () => {
    const rejection = countUnhandledRejections();
    try {
      const { registry, taskId } = await makeUncertainLocalTask();
      const registryFailureReason = "登记失败：任务已被清理（测试注入）";
      registry.markStoppedByUser = () => ({ ok: false, reason: registryFailureReason });
      const decision = recordingDecision({ ok: true, decisionId: "USER-100" });
      const page = new ShellPage(basePageOptions({ registry, recordStopDecision: decision.recordStopDecision }));
      await page.refresh();

      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await sleepMs(50);

      expect(registry.get(taskId)?.status).toBe("uncertain");
      await page.refresh();
      const text = page.render(80).join("\n");
      expect(text).toContain(registryFailureReason);
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  }, 10_000);

  test("守护进程 shells.markStopped 拒绝：显示原因，requirement 为守护进程任务的需求身份，无未处理拒绝", async () => {
    const rejection = countUnhandledRejections();
    try {
      const repo = fakeRepo("repo-mark-fail", {
        list: () => [
          { taskId: "daemon-uncertain", host: roleHost("worker", randomUUID(), "req-daemon-uncertain"), command: "daemon 命令", cwd: "/repo", pid: 1, startedAt: new Date(0).toISOString(), status: "uncertain", activity: "uncertain", inWorkspace: true, reason: "清理超时（测试注入）" },
        ],
        markStopped: async () => {
          throw new Error("守护进程拒绝裁定（测试注入）");
        },
      });
      const decision = recordingDecision({ ok: true, decisionId: "USER-200" });
      const page = new ShellPage(basePageOptions({ repos: [repo], recordStopDecision: decision.recordStopDecision }));
      await page.refresh();

      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await sleepMs(50);

      expect(decision.calls[0]?.requirement).toBe("req-daemon-uncertain");
      const text = page.render(80).join("\n");
      expect(text).toContain("守护进程拒绝裁定（测试注入）");
      await sleepMs(50);
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  }, 10_000);

  test("裁定在途去重：同一不确定任务连续两次 K→Enter 只写一条决策，处理期间行内提示处理中", async () => {
    const { registry } = await makeUncertainLocalTask();
    let resolveDecision!: (value: ShellPageDecisionResult) => void;
    const gate = new Promise<ShellPageDecisionResult>((resolve) => { resolveDecision = resolve; });
    const decision = recordingDecision(() => gate);
    const page = new ShellPage(basePageOptions({ registry, recordStopDecision: decision.recordStopDecision }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();

    expect(decision.calls.length).toBe(1);
    const inFlightText = page.render(80).join("\n");
    expect(inFlightText).toContain("处理中");

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();

    expect(decision.calls.length).toBe(1);

    resolveDecision({ ok: true, decisionId: "USER-DEDUP" });
    await flushMicrotasks();
  }, 10_000);
});

describe("ShellPage：刷新竞态——停止回执与 refresh 几乎同时到达时已停止行不被整表覆盖回运行中", () => {
  test("stop 回执在陈旧的 refresh 之后到达：最终仍显示已停止", async () => {
    const startedAtIso = new Date(0).toISOString();
    let resolveStop!: (value: Record<string, unknown>) => void;
    const stopGate = new Promise<Record<string, unknown>>((resolve) => { resolveStop = resolve; });
    const repo = fakeRepo("repo-race", {
      list: () => [
        { taskId: "race-task", host: roleHost("worker"), command: "竞态命令", cwd: "/repo", pid: 55, startedAt: startedAtIso, status: "running", activity: "active", inWorkspace: true },
      ],
      stop: () => stopGate,
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();

    const staleRefresh = page.refresh();
    await staleRefresh;

    resolveStop({
      task: { taskId: "race-task", host: roleHost("worker"), command: "竞态命令", cwd: "/repo", pid: 55, startedAt: startedAtIso, status: "stopped", activity: "ended", inWorkspace: true },
    });
    await flushMicrotasks();

    const text = page.render(80).join("\n");
    expect(text).toContain("已停止");
  });
});

describe("ShellPage：外来文本净化——命令/目录/原因/角色名不得原样带控制字符进渲染，超长命令按宽度截断", () => {
  test("命令、目录、原因、角色名含 ESC/\\r/\\n 时渲染行不含它们", async () => {
    const repo = fakeRepo("repo-dirty", {
      list: () => [
        {
          taskId: "dirty-task",
          host: roleHost("wor\x1bker"),
          command: "命令\x1b[31m红色\x1b[0m\r\n第二行",
          cwd: "/repo\r\n/子目录",
          pid: 1,
          startedAt: new Date(0).toISOString(),
          status: "uncertain",
          activity: "uncertain",
          inWorkspace: true,
          reason: "原因\x1b[31m红色\x1b[0m\r\n换行原因",
        },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text.split("\n").some((line) => line.includes("换行原因"))).toBe(true);
  });

  test("超长命令按渲染宽度截断", async () => {
    const repo = fakeRepo("repo-long-cmd", {
      list: () => [
        { taskId: "long-cmd", host: roleHost("worker"), command: "指".repeat(500), cwd: "/repo", pid: 1, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    const lines = page.render(60);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe("ShellPage：空列表、读取失败与含 reason 行的滚动上限", () => {
  test("无任何任务时列表明确提示无活动 Shell", async () => {
    const page = new ShellPage(basePageOptions());
    await page.refresh();
    expect(page.render(80).join("\n")).toContain("无活动 Shell");
  });

  test("仓库读取失败时展示具体错误（含 repoId 归属），且不显示无活动 Shell 措辞", async () => {
    const repo = fakeRepo("repo-broken", {});
    repo.client.call = async () => {
      throw new Error("守护进程不可达（测试注入）");
    };
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("守护进程不可达（测试注入）");
    expect(text).toContain("repo-broken");
    expect(text).not.toContain("无活动 Shell");
  });

  test("多仓库时仅一个失败：错误文本可按 repoId 区分是哪个仓库读取失败，另一仓库任务正常展示", async () => {
    const brokenRepo = fakeRepo("repo-a-broken", {});
    brokenRepo.client.call = async () => {
      throw new Error("连接超时（测试注入）");
    };
    const healthyRepo = fakeRepo("repo-b-healthy", {
      list: () => [
        { taskId: "healthy-task", host: roleHost("worker"), command: "健康仓库命令", cwd: "/repo", pid: 1, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [brokenRepo, healthyRepo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("repo-a-broken");
    expect(text).not.toContain("repo-b-healthy");
    expect(text).toContain("健康仓库命令");
  });

  test("30 个任务、其中 10 条带 reason（占两行）、终端 10 行：渲染行数仍不超过 10，末项可通过持续 ↓ 到达", async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      taskId: `daemon-${i}`,
      host: roleHost("worker", randomUUID(), `req-${i}`),
      command: `任务命令-${i}`,
      cwd: "/repo",
      pid: 1000 + i,
      startedAt: new Date(0).toISOString(),
      status: i < 10 ? "uncertain" : "running",
      activity: i < 10 ? "uncertain" : "active",
      inWorkspace: true,
      reason: i < 10 ? `原因-${i}` : undefined,
    }));
    const repo = fakeRepo("repo-many", { list: () => tasks });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    page.resize(80, 10);
    await page.refresh();

    expect(page.render(80).length).toBeLessThanOrEqual(10);

    for (let i = 0; i < 29; i++) page.handleInput(KEY.down);
    const lines = page.render(80);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.some((l) => l.includes("任务命令-29"))).toBe(true);
  });
});

describe("ShellPage：守护进程任务载荷字段缺失/类型错误时 refresh 整周期不抛，错误行含仓库归属", () => {
  test("command/cwd 非字符串：refresh 不产生未处理拒绝，错误行显示该仓库读取失败并带 repoId，其余仓库数据继续展示", async () => {
    const rejection = countUnhandledRejections();
    try {
      const malformedRepo = fakeRepo("repo-malformed", {
        list: () => [
          {
            taskId: "bad-task",
            host: roleHost("worker"),
            command: 12345 as unknown as string,
            cwd: undefined as unknown as string,
            pid: 1,
            startedAt: new Date(0).toISOString(),
            status: "running",
            activity: "active",
            inWorkspace: true,
          },
        ],
      });
      const healthyRepo = fakeRepo("repo-still-healthy", {
        list: () => [
          { taskId: "good-task", host: roleHost("worker"), command: "健康命令", cwd: "/repo", pid: 2, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
        ],
      });
      const page = new ShellPage(basePageOptions({ repos: [malformedRepo, healthyRepo] }));

      await expect(page.refresh()).resolves.toBeUndefined();
      await sleepMs(20);
      expect(rejection.count()).toBe(0);

      const text = page.render(80).join("\n");
      expect(text).toContain("repo-malformed");
      expect(text).toContain("健康命令");

      await expect(page.refresh()).resolves.toBeUndefined();
      await sleepMs(20);
      expect(rejection.count()).toBe(0);
      expect(page.render(80).join("\n")).toContain("健康命令");
    } finally {
      rejection.stop();
    }
  });
});

describe("openShellPage：ctx.ui.custom 挂载、fakeTui 被用于 requestRender、按注入时钟自行 refresh", () => {
  function fakeCtx() {
    let component: ShellPage | undefined;
    let options: Record<string, unknown> | undefined;
    let requestRenderCalls = 0;
    const fakeTui = { requestRender: () => { requestRenderCalls += 1; } };
    return {
      ctx: {
        ui: {
          custom: (
            factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
            opts?: Record<string, unknown>,
          ) => {
            options = opts;
            return new Promise((resolve) => {
              const done = (result: unknown) => resolve(result);
              component = factory(fakeTui, {}, {}, done) as ShellPage;
            });
          },
        },
      },
      getComponent: () => component,
      getOptions: () => options,
      requestRenderCalls: () => requestRenderCalls,
    };
  }

  test("以非浮层方式挂载，fakeTui 被真正传给页面：本地任务停止完成后 requestRender 被调用", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const targetId = await spawnLocal(registry, "生产链路标记");
    const fc = fakeCtx();
    const dock = new BottomDock({ getEditorText: () => "", isCompletionOpen: () => false, isOverlayOpen: () => false });

    const openPromise = openShellPage({
      ctx: fc.ctx,
      registry,
      repos: [],
      clock: createClock(),
      dock,
      recordStopDecision: async () => ({ ok: true, decisionId: "USER-001" }),
    });

    await waitFor(() => fc.getComponent() !== undefined, 3_000);
    expect(fc.getOptions()?.overlay).toBeFalsy();

    const callsBeforeStop = fc.requestRenderCalls();
    fc.getComponent()!.handleInput(KEY.k);
    fc.getComponent()!.handleInput(KEY.right);
    fc.getComponent()!.handleInput(KEY.enter);

    await waitFor(() => registry.get(targetId)?.status === "stopped", 8_000);
    await sleepMs(50);
    expect(fc.requestRenderCalls()).toBeGreaterThan(callsBeforeStop);

    fc.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  }, 15_000);

  test("页面按注入时钟每秒自行 refresh：不手动调用 page.refresh() 也能看到停止中到已停止的推进", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    const targetId = await spawnLocal(registry, "自动刷新标记");
    const fc = fakeCtx();
    const timeSource = createFakeTimeSource();
    const pageClock = createClock({ timeSource });
    const dock = new BottomDock({ getEditorText: () => "", isCompletionOpen: () => false, isOverlayOpen: () => false });

    const openPromise = openShellPage({
      ctx: fc.ctx,
      registry,
      repos: [],
      clock: pageClock,
      dock,
      recordStopDecision: async () => ({ ok: true, decisionId: "USER-001" }),
    });

    await waitFor(() => fc.getComponent() !== undefined, 3_000);
    fc.getComponent()!.handleInput(KEY.k);
    fc.getComponent()!.handleInput(KEY.right);
    fc.getComponent()!.handleInput(KEY.enter);

    await waitFor(() => registry.get(targetId)?.status === "stopped", 8_000);

    timeSource.advance(1_000);
    await flushMicrotasks();

    expect(fc.getComponent()!.render(80).join("\n")).toContain("已停止");

    fc.getComponent()!.handleInput(KEY.escape);
    await openPromise;
    pageClock.stopGapWatcher();
  }, 15_000);

  test("ctx.ui.custom 被拒绝时仍执行 dock.markPageClosed", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    let closedCount = 0;
    const rejectingCtx = {
      ui: {
        custom: async () => {
          throw new Error("宿主渲染失败（测试注入）");
        },
      },
    };

    await expect(
      openShellPage({
        ctx: rejectingCtx,
        registry,
        repos: [],
        clock: createClock(),
        dock: { markPageOpen: () => {}, markPageClosed: () => { closedCount += 1; } },
        recordStopDecision: async () => ({ ok: true, decisionId: "USER-001" }),
      }),
    ).rejects.toThrow();

    expect(closedCount).toBe(1);
  });
});

describe("openShellPage：与共享 BottomDock 的按键隔离，关闭后焦点由 dock 自行恢复", () => {
  test("页面打开期间 ↓/Enter 不到达面板；关闭后 dock 焦点回到打开前的状态", async () => {
    const registry = new ShellRegistry({ clock: createClock() });
    await spawnLocal(registry, "隔离标记");
    const panelCalls: string[] = [];
    const panel = { hasRows: () => true, handleInput: (data: string) => { panelCalls.push(data); return true; } };
    const dock = new BottomDock({ panel, getEditorText: () => "", isCompletionOpen: () => false, isOverlayOpen: () => false });

    dock.handleKey(KEY.down);
    expect(dock.focus()).toBe("panel");
    const callsBeforePageOpen = panelCalls.length;

    let component: ShellPage | undefined;
    const ctx = {
      ui: {
        custom: (
          factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
        ) =>
          new Promise((resolve) => {
            component = factory({ requestRender: () => {} }, {}, {}, (result: unknown) => resolve(result)) as ShellPage;
          }),
      },
    };

    const openPromise = openShellPage({
      ctx,
      registry,
      repos: [],
      clock: createClock(),
      dock,
      recordStopDecision: async () => ({ ok: true, decisionId: "USER-001" }),
    });
    await waitFor(() => component !== undefined, 3_000);

    const isolatedResult = dock.handleKey(KEY.down);
    dock.handleKey(KEY.enter);
    expect(isolatedResult).toBeUndefined();
    expect(panelCalls.length).toBe(callsBeforePageOpen);

    component!.handleInput(KEY.escape);
    await openPromise;

    expect(dock.focus()).toBe("panel");
  }, 10_000);
});
