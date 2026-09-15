import { afterEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { BottomDock } from "../runtime/dock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import type { Host, TaskRecord } from "../runtime/shell-registry.ts";
import { ShellPage, hostLabel, openShellPage } from "../runtime/shell-page.ts";
import type { ShellPageRepo } from "../runtime/shell-page.ts";

const MAIN_HOST: Host = { kind: "main", id: "main" };

const KEY = {
  down: "\x1b[B",
  up: "\x1b[A",
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
  },
  requirementTitle?: string,
): ShellPageRepo & { calls: RepoCallLog[] } {
  const calls: RepoCallLog[] = [];
  const repo: ShellPageRepo & { calls: RepoCallLog[] } = {
    repoId,
    requirementTitle,
    calls,
    client: {
      connectionIdentity: () => ({ daemonInstanceId: "fixture-daemon", connectionId: repoId, connectionSequence: 1 }),
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "shells.list") return { tasks: handlers.list?.() ?? [] };
        if (method === "shells.stop") return await handlers.stop!(params);
        throw new Error(`非白名单 RPC：${method}`);
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

function basePageOptions(overrides: Record<string, unknown> = {}) {
  return {
    registry: new ShellRegistry({ clock: createClock() }),
    repos: [] as ShellPageRepo[],
    clock: createClock(),
    ...overrides,
  };
}

function localTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "local-task",
    host: MAIN_HOST,
    command: "本地测试命令",
    cwd: "/local",
    mode: "background",
    pid: 101,
    pgid: 101,
    startedAt: 1_000,
    status: "running",
    activity: "active",
    exitCode: null,
    descendants: [],
    descendantsScanned: false,
    identityVerified: true,
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
        { taskId: "in-scope", host: roleHost("worker"), command: "范围内命令", cwd: "/repo", pid: 101, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
        { taskId: "out-scope", host: roleHost("worker"), command: "范围外命令", cwd: "/repo", pid: 2, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: false },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("in-scope");
    expect(text).not.toContain("out-scope");
    expect(text).not.toContain("范围内命令");
    expect(text).not.toContain("范围外命令");
  });

  test("耗时字段随时钟展示为约定格式（1m30s）", async () => {
    const timeSource = createFakeTimeSource();
    timeSource.advance(90_000);
    const clock = createClock({ timeSource });
    const repo = fakeRepo("repo-elapsed", {
      list: () => [
        { taskId: "t1", host: roleHost("worker"), command: "耗时命令", cwd: "/repo", pid: 101, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
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
    expect(lines[0]!.startsWith("1")).toBe(true);
    expect(lines[1]!.startsWith("2")).toBe(true);
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
    expect(before).toContain("[旧工作目录不提供]");
    expect(before).not.toContain("/dir-x");

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
  test("shells.stop 回执 status=error：确认后保留任务和未确认原因，不显示已停止", async () => {
    const startedAtIso = new Date(0).toISOString();
    const repo = fakeRepo("repo-uncertain", {
      list: () => [
        { taskId: "daemon-task-1", host: roleHost("worker"), command: "daemon 命令", cwd: "/repo", pid: 4242, startedAt: startedAtIso, status: "running", activity: "active", inWorkspace: true },
      ],
      stop: () => ({ status: "error", reason: "清理确认超时（测试注入）" }),
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

describe("ShellPage：不确定任务只能请求实际停止，不能人工裁定", () => {
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

  test("本地身份核验失败仍为不确定，不调用人工标记也不生成 USER", async () => {
    const { registry, taskId } = await makeUncertainLocalTask();
    const mark = vi.spyOn(registry, "markStoppedByUser");
    const stop = vi.spyOn(registry, "stop");
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.handleInput(KEY.k);
    const confirm = page.render(80).join("\n");
    expect(confirm).toContain("停止尚未确认");
    expect(confirm).not.toContain("视为已停止");
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await waitFor(() => stop.mock.results.length === 1, 1_000);
    await stop.mock.results[0]!.value;
    await flushMicrotasks();
    expect(mark).not.toHaveBeenCalled();
    expect(registry.get(taskId)?.status).toBe("uncertain");
    expect(JSON.stringify(registry.get(taskId))).not.toContain("USER-");
    expect(page.render(80).join("\n")).not.toContain("已停止");
  }, 10_000);

  test("不确定任务默认取消及 Esc 不发停止、不裁定，原状态与原因保留", async () => {
    const { registry, taskId } = await makeUncertainLocalTask();
    const mark = vi.spyOn(registry, "markStoppedByUser");
    const stop = vi.spyOn(registry, "stop");
    const before = registry.get(taskId);
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.handleInput(KEY.k);
    page.handleInput(KEY.enter);
    page.handleInput(KEY.k);
    page.handleInput(KEY.escape);
    await flushMicrotasks();
    expect(stop).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(registry.get(taskId)).toEqual(before);
    expect(page.render(80).join("\n")).toContain("不确定");
  }, 10_000);

  test("本地实际停止失败显示原因，无人工裁定及未处理拒绝", async () => {
    const rejection = countUnhandledRejections();
    try {
      const { registry, taskId } = await makeUncertainLocalTask();
      const mark = vi.spyOn(registry, "markStoppedByUser");
      const stop = vi.spyOn(registry, "stop").mockResolvedValue({ ok: false, reason: "实际停止未确认（测试注入）" });
      const page = new ShellPage(basePageOptions({ registry }));
      await page.refresh();
      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await flushMicrotasks();
      expect(stop).toHaveBeenCalledWith(taskId);
      expect(mark).not.toHaveBeenCalled();
      expect(registry.get(taskId)?.status).toBe("uncertain");
      expect(page.render(80).join("\n")).toContain("实际停止未确认");
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  }, 10_000);

  test("守护进程停止失败保留原因，仅发送绑定 PID/起始时间的 shells.stop", async () => {
    const rejection = countUnhandledRejections();
    try {
      const startedAt = new Date(0).toISOString();
      const repo = fakeRepo("repo-stop-uncertain", {
        list: () => [{ taskId: "daemon-uncertain", host: roleHost("worker"), command: "", cwd: "", pid: 101, startedAt, status: "uncertain", activity: "uncertain", inWorkspace: true }],
        stop: async () => { throw new Error("实际停止被拒绝（测试注入）"); },
      });
      const page = new ShellPage(basePageOptions({ repos: [repo] }));
      await page.refresh();
      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await flushMicrotasks();
      expect(repo.calls).toEqual([
        { method: "shells.list", params: {} },
        { method: "shells.stop", params: { taskId: "daemon-uncertain", expectedPid: 101, expectedStartedAt: startedAt } },
      ]);
      expect(JSON.stringify(repo.calls)).not.toContain("USER");
      expect(page.render(80).join("\n")).toContain("实际停止被拒绝");
      expect(page.render(80).join("\n")).not.toContain("已停止");
      expect(rejection.count()).toBe(0);
    } finally {
      rejection.stop();
    }
  });

  test("不确定任务停止在途去重，状态回执无确认仍显示未确认", async () => {
    let resolveStop!: (result: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((resolve) => { resolveStop = resolve; });
    const task = { taskId: "uncertain-dedup", host: roleHost("worker"), command: "", cwd: "", pid: 4, startedAt: new Date(0).toISOString(), status: "uncertain", activity: "uncertain", inWorkspace: true };
    const repo = fakeRepo("repo-dedup", { list: () => [task], stop: () => gate });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    for (let i = 0; i < 2; i++) {
      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
    }
    expect(repo.calls.filter((c) => c.method === "shells.stop")).toHaveLength(1);
    expect(page.render(80).join("\n")).toContain("停止中");
    expect(page.render(80).join("\n")).not.toContain("已停止");
    resolveStop({ status: "stopped" });
    await flushMicrotasks();
    expect(page.render(80).join("\n")).toContain("停止未确认");
    expect(page.render(80).join("\n")).not.toContain("已停止");
    expect(repo.calls.some((c) => c.method === "shells.markStopped")).toBe(false);
    expect(JSON.stringify(repo.calls)).not.toContain("USER");
  });
});

describe("ShellPage：刷新竞态不抹除停止未确认提示", () => {
  test("stop 状态回执在陈旧 refresh 之后到达：再刷新仍未确认", async () => {
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

    resolveStop({ status: "stopped" });
    await flushMicrotasks();
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("停止未确认");
    expect(text).not.toContain("已停止");
  });
});

describe("ShellPage：外来文本净化——命令/目录/原因/角色名不得原样带控制字符进渲染，超长命令按宽度截断", () => {
  test("命令、目录、原因、角色名含 ESC/\\r/\\n 时渲染行不含它们", async () => {
    const repo = fakeRepo("repo-dirty", {
      list: () => [
        {
          taskId: "dirty-task",
          host: roleHost("wor\x1bker", randomUUID(), "req-dirty"),
          command: "命令\x1b[31m红色\x1b[0m\r\n第二行",
          cwd: "/repo\r\n/子目录",
          pid: 101,
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
    expect(text).toContain("进程停止未确认");
    expect(text).not.toContain("换行原因");
  });

  test("超长命令按渲染宽度截断", async () => {
    const repo = fakeRepo("repo-long-cmd", {
      list: () => [
        { taskId: "long-cmd", host: roleHost("worker"), command: "指".repeat(500), cwd: "/repo", pid: 101, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
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
        { taskId: "healthy-task", host: roleHost("worker"), command: "健康仓库命令", cwd: "/repo", pid: 101, startedAt: new Date(0).toISOString(), status: "running", activity: "active", inWorkspace: true },
      ],
    });
    const page = new ShellPage(basePageOptions({ repos: [brokenRepo, healthyRepo] }));
    await page.refresh();
    const text = page.render(80).join("\n");
    expect(text).toContain("repo-a-broken");
    expect(text).not.toContain("repo-b-healthy");
    expect(text).toContain("healthy-task");
    expect(text).not.toContain("健康仓库命令");
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
    expect(lines.some((l) => l.includes("daemon-29"))).toBe(true);
  });
});

describe("ShellPage：守护进程任务载荷字段缺失/类型错误时 refresh 整周期不抛，错误行含仓库归属", () => {
  test("PID 非法：refresh 不产生未处理拒绝，错误行显示仓库归属，其余仓库元数据继续展示", async () => {
    const rejection = countUnhandledRejections();
    try {
      const malformedRepo = fakeRepo("repo-malformed", {
        list: () => [
          {
            taskId: "bad-task",
            host: roleHost("worker"),
            command: 12345 as unknown as string,
            cwd: undefined as unknown as string,
            pid: NaN,
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
      expect(text).toContain("good-task");

      await expect(page.refresh()).resolves.toBeUndefined();
      await sleepMs(20);
      expect(rejection.count()).toBe(0);
      expect(page.render(80).join("\n")).toContain("good-task");
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

describe("ShellPage：复合行身份隔离详情、选择和停止请求", () => {
  test("两个仓库相同 taskId 的详情与并行停止互不串用，失败只落到原仓库", async () => {
    const stopA = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { resolveA = resolve; }));
    const stopB = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { resolveB = resolve; }));
    let resolveA!: (value: Record<string, unknown>) => void;
    let resolveB!: (value: Record<string, unknown>) => void;
    const startedAt = new Date(0).toISOString();
    const task = (pid: number) => ({ taskId: "shared-task", host: roleHost("worker", "shared-run"), command: "", cwd: "", pid, startedAt, status: "running", activity: "active", inWorkspace: true });
    const repoA = fakeRepo("repo-A", { list: () => [task(111)], stop: stopA });
    const repoB = fakeRepo("repo-B", { list: () => [task(222)], stop: stopB });
    const page = new ShellPage(basePageOptions({ repos: [repoA, repoB] }));
    await page.refresh();

    page.handleInput(KEY.enter);
    expect(page.render(100).join("\n")).toContain("进程号：111");
    expect(page.render(100).join("\n")).toContain("repo-A");
    page.handleInput(KEY.escape);
    page.handleInput(KEY.down);
    page.handleInput(KEY.enter);
    expect(page.render(100).join("\n")).toContain("进程号：222");
    expect(page.render(100).join("\n")).toContain("repo-B");
    page.handleInput(KEY.escape);

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    page.handleInput(KEY.up);
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).toHaveBeenCalledOnce();
    expect(repoA.calls.find((call) => call.method === "shells.stop")?.params).toEqual({ taskId: "shared-task", expectedPid: 111, expectedStartedAt: startedAt });
    expect(repoB.calls.find((call) => call.method === "shells.stop")?.params).toEqual({ taskId: "shared-task", expectedPid: 222, expectedStartedAt: startedAt });

    resolveA({ status: "error", reason: "A-only failure" });
    await flushMicrotasks();
    const afterA = page.render(120).join("\n");
    expect(afterA.match(/A-only failure/g)).toHaveLength(1);
    expect(afterA).toContain("停止中");
    resolveB({ status: "stopped" });
    await flushMicrotasks();
  });

  test("本地与 daemon 相同 taskId 仍显示不同来源并分别停止", async () => {
    const task = localTask({ taskId: "same-id", pid: 301, startedAt: 2_000 });
    const registry = new ShellRegistry({ clock: createClock() });
    registry.list = () => [task];
    registry.get = () => task;
    const stopLocal = vi.spyOn(registry, "stop").mockResolvedValue({ ok: false, reason: "local-only" });
    const repo = fakeRepo("repo-remote", {
      list: () => [{ taskId: "same-id", host: roleHost("worker"), command: "", cwd: "", pid: 302, startedAt: "2000", status: "running", activity: "active", inWorkspace: true }],
      stop: () => ({ status: "error", reason: "daemon-only" }),
    });
    const page = new ShellPage(basePageOptions({ registry, repos: [repo] }));
    await page.refresh();
    const list = page.render(120).join("\n");
    expect(list).toContain("本机:");
    expect(list).toContain("仓库:repo-remote");

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    page.handleInput(KEY.down);
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(stopLocal).toHaveBeenCalledWith("same-id");
    expect(repo.calls.filter((call) => call.method === "shells.stop")).toHaveLength(1);
    expect(page.render(120).join("\n")).toContain("local-only");
    expect(page.render(120).join("\n")).toContain("daemon-only");
  });

  test("同仓库重复 taskId 在顺序变化后仍按 PID/startedAt 保留选择", async () => {
    const startedAt = "3000";
    const task = (pid: number) => ({ taskId: "duplicate", host: roleHost("worker", "stable-run"), command: "", cwd: "", pid, startedAt, status: "running", activity: "active", inWorkspace: true });
    let tasks = [task(311), task(322)];
    const stop = vi.fn().mockResolvedValue({ status: "stopped" });
    const repo = fakeRepo("repo-order", { list: () => tasks, stop });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    page.handleInput(KEY.down);
    tasks = [task(322), task(311)];
    await page.refresh();
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(repo.calls.filter((call) => call.method === "shells.stop")).toHaveLength(1);
    expect(repo.calls.find((call) => call.method === "shells.stop")?.params).toMatchObject({ expectedPid: 322, expectedStartedAt: startedAt });
  });

  test("目标消失后以新 PID 重现时，迟到回执不覆盖新行且新请求可独立发送", async () => {
    let tasks: Record<string, unknown>[] = [{ taskId: "reused", host: roleHost("worker", "stable-run"), command: "", cwd: "", pid: 401, startedAt: "1000", status: "running", activity: "active", inWorkspace: true }];
    let resolveOld!: (value: Record<string, unknown>) => void;
    const oldGate = new Promise<Record<string, unknown>>((resolve) => { resolveOld = resolve; });
    const stop = vi.fn().mockImplementationOnce(() => oldGate).mockResolvedValueOnce({ status: "stopped" });
    const repo = fakeRepo("repo-reuse", { list: () => tasks, stop });
    const page = new ShellPage(basePageOptions({ repos: [repo] }));
    await page.refresh();
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);

    tasks = [];
    await page.refresh();
    tasks = [{ taskId: "reused", host: roleHost("worker", "stable-run"), command: "", cwd: "", pid: 402, startedAt: "2000", status: "running", activity: "active", inWorkspace: true }];
    await page.refresh();
    resolveOld({ status: "error", reason: "old-late-failure" });
    await flushMicrotasks();
    expect(page.render(100).join("\n")).toContain("@402");
    expect(page.render(100).join("\n")).not.toContain("old-late-failure");
    expect(page.render(100).join("\n")).not.toContain("停止中");

    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(repo.calls.filter((call) => call.method === "shells.stop").at(-1)?.params).toMatchObject({ expectedPid: 402, expectedStartedAt: "2000" });
  });
});

describe("ShellPage：本地结束证明和停止回执严格核对", () => {
  test("descendantsScanned 缺失或 false 时 20 秒后仍保留；true 后才计时，证明撤销后旧 TTL 清零", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let task = localTask({ status: "exited", activity: "ended", identityVerified: true, descendantsScanned: false });
    const registry = new ShellRegistry({ clock });
    registry.list = () => [task];
    registry.get = () => task;
    const page = new ShellPage(basePageOptions({ registry, clock }));

    await page.refresh();
    timeSource.advance(20_001);
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("未核实");

    task = { ...task, descendantsScanned: undefined as unknown as boolean };
    timeSource.advance(20_001);
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("未核实");

    task = { ...task, descendantsScanned: true };
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("已结束");
    timeSource.advance(10_000);
    task = { ...task, descendantsScanned: false };
    await page.refresh();
    timeSource.advance(20_001);
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("未核实");

    task = { ...task, descendantsScanned: true };
    await page.refresh();
    timeSource.advance(20_001);
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("无活动 Shell");
  });

  test("ok:true 只有结果身份与原请求一致且完整证明为 true 才显示确认结束", async () => {
    let current = localTask({ taskId: "strict-stop", pid: 501, startedAt: 5_000 });
    const original = current;
    const registry = new ShellRegistry({ clock: createClock() });
    registry.list = () => [current];
    registry.get = () => current;
    vi.spyOn(registry, "stop").mockImplementation(async () => {
      current = localTask({ ...original, pid: 502, status: "stopped", activity: "ended", descendantsScanned: true, identityVerified: true, stoppedBy: "signal" });
      return { ok: true, task: current };
    });
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();
    const text = page.render(100).join("\n");
    expect(text).toContain("停止未确认");
    expect(text).not.toContain("已停止");
  });

  test("StopResult 自称有完整证明但 registry 当前记录仍在运行时不能确认", async () => {
    const current = localTask({ taskId: "stale-result" });
    const registry = new ShellRegistry({ clock: createClock() });
    registry.list = () => [current];
    registry.get = () => current;
    vi.spyOn(registry, "stop").mockResolvedValue({
      ok: true,
      task: { ...current, status: "stopped", activity: "ended", descendantsScanned: true, identityVerified: true, stoppedBy: "signal" },
    });
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    page.handleInput(KEY.k);
    page.handleInput(KEY.right);
    page.handleInput(KEY.enter);
    await flushMicrotasks();
    expect(page.render(100).join("\n")).toContain("停止未确认");
    expect(page.render(100).join("\n")).not.toContain("已停止");
  });

  test("StopResult 的 taskId/host/PID/startedAt 或扫描证明任一不符都不能确认", async () => {
    const cases: Array<[string, (task: TaskRecord) => TaskRecord]> = [
      ["taskId", (task) => ({ ...task, taskId: "other-task" })],
      ["host", (task) => ({ ...task, host: { kind: "main", id: "other-host" } })],
      ["pid", (task) => ({ ...task, pid: task.pid + 1 })],
      ["startedAt", (task) => ({ ...task, startedAt: (task.startedAt ?? 0) + 1 })],
      ["descendantsScanned", (task) => ({ ...task, descendantsScanned: false })],
    ];
    for (const [label, mutate] of cases) {
      const original = localTask({ taskId: `strict-${label}`, status: "running", activity: "active" });
      let current = original;
      const registry = new ShellRegistry({ clock: createClock() });
      registry.list = () => [current];
      registry.get = () => current;
      vi.spyOn(registry, "stop").mockImplementation(async () => {
        current = mutate({ ...original, status: "stopped", activity: "ended", descendantsScanned: true, identityVerified: true, stoppedBy: "signal" });
        return { ok: true, task: current };
      });
      const page = new ShellPage(basePageOptions({ registry }));
      await page.refresh();
      page.handleInput(KEY.k);
      page.handleInput(KEY.right);
      page.handleInput(KEY.enter);
      await flushMicrotasks();
      const text = page.render(100).join("\n");
      expect(text, label).toContain("停止未确认");
      expect(text, label).not.toContain("已停止");
    }
  });

  test("USER 终态即使扫描和身份均为 true 也始终未核实", async () => {
    const task = localTask({ status: "stopped", activity: "ended", descendantsScanned: true, identityVerified: true, stoppedBy: "user" });
    const registry = new ShellRegistry({ clock: createClock() });
    registry.list = () => [task];
    registry.get = () => task;
    const page = new ShellPage(basePageOptions({ registry }));
    await page.refresh();
    expect(page.render(100).join("\n")).toContain("未核实");
    expect(page.render(100).join("\n")).not.toContain("已停止  ");
  });
});

test("远端查询在途时本地证明或PID变化，最终刷新不能还原旧记录", async () => {
  for (const mutation of ["proof", "pid"] as const) {
    const time = createFakeTimeSource(), clock = createClock({ timeSource: time });
    let task = localTask({ pid: 111, pgid: 111, status: "stopped", activity: "ended", descendantsScanned: true });
    let hold = false, finish!: (value: Record<string, unknown>) => void;
    const client = { connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "current", connectionSequence: 1 }),
      call: async () => hold ? new Promise<Record<string, unknown>>((resolve) => { finish = resolve; }) : { tasks: [] } };
    const registry = { list: () => [task], get: () => task } as unknown as ShellRegistry;
    const page = new ShellPage(basePageOptions({ registry, clock, repos: [{ repoId: "remote", client }] }));
    await page.refresh(); time.advance(20_001); hold = true;
    const pending = page.refresh();
    if (mutation === "proof") task.descendantsScanned = false;
    else task = localTask({ pid: 222, pgid: 222, startedAt: 2000 });
    finish({ tasks: [] }); await pending;
    const text = page.render(160).join("\n"); expect(text).not.toContain("无活动 Shell");
    if (mutation === "proof") expect(text).toContain("未核实");
    else { page.handleInput(KEY.enter); expect(page.render(160).join("\n")).toContain("进程号：222"); }
    clock.stopGapWatcher();
  }
});

test("同对象连接epoch变化后旧list不报空、旧stop回执不进入新行", async () => {
  let sequence = 1, resolveStop!: (value: Record<string, unknown>) => void, resolveList!: (value: Record<string, unknown>) => void, holdList = false;
  const task = { ...localTask(), taskId: "same-task" };
  const client = { connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "same-object", connectionSequence: sequence }),
    call: async (method: string) => method === "shells.stop" ? new Promise<Record<string, unknown>>((resolve) => { resolveStop = resolve; })
      : holdList ? new Promise<Record<string, unknown>>((resolve) => { resolveList = resolve; }) : { tasks: [task] } };
  const page = new ShellPage(basePageOptions({ repos: [{ repoId: "remote", resolveClient: () => client }] }));
  await page.refresh(); page.handleInput("K"); page.handleInput(KEY.right); page.handleInput(KEY.enter);
  sequence++; await page.refresh();
  expect(page.render(160).join("\n")).not.toContain("停止中");
  resolveStop({ status: "error", reason: "OLD-CONNECTION-ONLY" }); await flushMicrotasks();
  expect(page.render(160).join("\n")).not.toContain("OLD-CONNECTION-ONLY");
  holdList = true; const pending = page.refresh(); sequence++;
  resolveList({ tasks: [] }); await pending;
  expect(page.render(160).join("\n")).toContain("未知"); expect(page.render(160).join("\n")).not.toContain("无活动 Shell");
});

test.each([null, undefined, "错误\x1b[2J\n伪造", { message: "对象错误\x1b[2J\n伪造" }])("未知异常%j只产生有界未知，不崩溃或报空", async (error) => {
  const client = { connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "c", connectionSequence: 1 }), call: async () => { throw error; } };
  const page = new ShellPage(basePageOptions({ repos: [{ repoId: "remote", client }] }));
  await expect(page.refresh()).resolves.toBeUndefined();
  const lines = page.render(160); expect(lines.join("\n")).toContain("未知"); expect(lines.join("\n")).not.toContain("无活动 Shell");
  expect(lines.some((line) => /[\x00-\x1f\x7f-\x9f]/.test(line))).toBe(false);
});

test("缺失列表和host非字符串身份属于未知数据，不转换成空或渲染崩溃", async () => {
  for (const response of [{}, { tasks: null }, { tasks: [{ ...localTask(), host: { kind: "role", id: 123, role: "worker" } }] }]) {
    const client = { connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "c", connectionSequence: 1 }), call: async () => response };
    const page = new ShellPage(basePageOptions({ repos: [{ repoId: "remote", client }] }));
    await page.refresh(); expect(() => page.render(160)).not.toThrow();
    expect(page.render(160).join("\n")).toContain("未知"); expect(page.render(160).join("\n")).not.toContain("无活动 Shell");
  }
});

describe("ShellPage：缺连接属于未知覆盖，不当作空结果", () => {
  test("全部或部分仓库缺 client 时不发请求且不显示无活动；恢复 client 后可重新查询", async () => {
    const calls: string[] = [];
    const connectedClient = { connectionIdentity: () => ({ daemonInstanceId: "fixture", connectionId: "connection", connectionSequence: 1 }),
      call: async (method: string) => { calls.push(method); return { tasks: [] }; } };
    const missingA: ShellPageRepo = { repoId: "repo-missing-a" };
    const missingB: ShellPageRepo = { repoId: "repo-missing-b" };
    const allMissing = new ShellPage(basePageOptions({ repos: [missingA, missingB] }));
    allMissing.resize(12, 1);
    await allMissing.refresh();
    expect(calls).toEqual([]);
    expect(allMissing.render(12)).toHaveLength(1);
    expect(allMissing.render(12)[0]).toContain("未知");
    expect(allMissing.render(12).join("\n")).not.toContain("无活动 Shell");

    const partial = new ShellPage(basePageOptions({ repos: [{ repoId: "repo-ok", client: connectedClient }, missingA] }));
    await partial.refresh();
    expect(calls).toEqual(["shells.list"]);
    expect(partial.render(80).join("\n")).toContain("覆盖不完整");
    expect(partial.render(80).join("\n")).not.toContain("无活动 Shell");

    missingA.client = connectedClient;
    await partial.refresh();
    expect(calls).toEqual(["shells.list", "shells.list", "shells.list"]);
    expect(partial.render(80).join("\n")).toContain("无活动 Shell");
  });
});
