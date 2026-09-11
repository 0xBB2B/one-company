import { describe, expect, test } from "vitest";
import { classifyFailure, ConnectivityProbe, NetworkPauseGate } from "../runtime/network-pause.ts";
import { createClock } from "../runtime/clock.ts";

interface FakeTimeSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function withName(message: string, name: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function withStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyFailure", () => {
  test("ECONNRESET 归类为 connection", () => {
    expect(classifyFailure(withCode("reset", "ECONNRESET"))).toBe("connection");
  });

  test("ECONNREFUSED 归类为 connection", () => {
    expect(classifyFailure(withCode("refused", "ECONNREFUSED"))).toBe("connection");
  });

  test("ENOTFOUND 归类为 connection", () => {
    expect(classifyFailure(withCode("not found", "ENOTFOUND"))).toBe("connection");
  });

  test("ETIMEDOUT 归类为 connection", () => {
    expect(classifyFailure(withCode("timed out", "ETIMEDOUT"))).toBe("connection");
  });

  test("EAI_AGAIN 归类为 connection", () => {
    expect(classifyFailure(withCode("dns retry", "EAI_AGAIN"))).toBe("connection");
  });

  test("错误名 FetchError 归类为 connection", () => {
    expect(classifyFailure(withName("fetch error", "FetchError"))).toBe("connection");
  });

  test("错误名 TimeoutError 归类为 connection", () => {
    expect(classifyFailure(withName("timeout", "TimeoutError"))).toBe("connection");
  });

  test("消息含 fetch failed 归类为 connection", () => {
    expect(classifyFailure(new Error("fetch failed"))).toBe("connection");
  });

  test("消息含 socket hang up 归类为 connection", () => {
    expect(classifyFailure(new Error("socket hang up"))).toBe("connection");
  });

  test("消息含 network 归类为 connection", () => {
    expect(classifyFailure(new Error("network error occurred"))).toBe("connection");
  });

  test("消息含 timed out 归类为 connection", () => {
    expect(classifyFailure(new Error("request timed out"))).toBe("connection");
  });

  test("status 401 归类为 auth", () => {
    expect(classifyFailure(withStatus("denied", 401))).toBe("auth");
  });

  test("status 403 归类为 auth", () => {
    expect(classifyFailure(withStatus("forbidden", 403))).toBe("auth");
  });

  test("statusCode 401 归类为 auth", () => {
    expect(classifyFailure(Object.assign(new Error("denied"), { statusCode: 401 }))).toBe("auth");
  });

  test("消息含 unauthorized 归类为 auth", () => {
    expect(classifyFailure(new Error("unauthorized request"))).toBe("auth");
  });

  test("消息含 invalid api key 归类为 auth", () => {
    expect(classifyFailure(new Error("invalid api key supplied"))).toBe("auth");
  });

  test("消息含 authentication 归类为 auth", () => {
    expect(classifyFailure(new Error("authentication failed"))).toBe("auth");
  });

  test("status 429 归类为 quota", () => {
    expect(classifyFailure(withStatus("too many requests", 429))).toBe("quota");
  });

  test("消息含 quota 归类为 quota", () => {
    expect(classifyFailure(new Error("quota exceeded"))).toBe("quota");
  });

  test("消息含 insufficient credits 归类为 quota", () => {
    expect(classifyFailure(new Error("insufficient credits"))).toBe("quota");
  });

  test("消息含 billing 归类为 quota", () => {
    expect(classifyFailure(new Error("billing issue"))).toBe("quota");
  });

  test("消息含 rate limit 归类为 quota", () => {
    expect(classifyFailure(new Error("rate limit hit"))).toBe("quota");
  });

  test("错误名 AbortError 归类为 cancelled", () => {
    expect(classifyFailure(withName("aborted by caller", "AbortError"))).toBe("cancelled");
  });

  test("消息含 aborted 归类为 cancelled", () => {
    expect(classifyFailure(new Error("operation aborted"))).toBe("cancelled");
  });

  test("400 业务错误归类为 business", () => {
    expect(classifyFailure(withStatus("bad request", 400))).toBe("business");
  });

  test("普通 Error 无特征归类为 business", () => {
    expect(classifyFailure(new Error("something went wrong"))).toBe("business");
  });

  test("非 Error 字符串按消息特征判断为 connection", () => {
    expect(classifyFailure("network unreachable")).toBe("connection");
  });

  test("非 Error 字符串无法判断特征时归类为 business", () => {
    expect(classifyFailure("random failure text")).toBe("business");
  });

  test("状态码 400 与消息含 network 混合时以状态码优先判定为 business", () => {
    expect(classifyFailure({ status: 400, message: "network name invalid" })).toBe("business");
  });

  test("状态码 400 与消息含 rate limit 混合时以状态码优先判定为 business", () => {
    expect(classifyFailure({ status: 400, message: "rate limit field malformed" })).toBe("business");
  });

  test("状态码 402 归类为 quota", () => {
    expect(classifyFailure({ status: 402 })).toBe("quota");
  });

  test("状态码 404 与消息含 network 混合时以状态码优先判定为 business", () => {
    expect(classifyFailure({ status: 404, message: "network unreachable" })).toBe("business");
  });

  test("字符串状态码 401 归类为 auth", () => {
    expect(classifyFailure({ status: "401" })).toBe("auth");
  });

  test("字符串状态码 429 归类为 quota", () => {
    expect(classifyFailure({ statusCode: "429" })).toBe("quota");
  });

  test("cause 链上的 ENOTFOUND 归类为 connection", () => {
    const error = new Error("upstream call failed", { cause: withCode("x", "ENOTFOUND") });
    expect(classifyFailure(error)).toBe("connection");
  });

  test("AggregateError.errors 中的 ECONNREFUSED 归类为 connection", () => {
    const error = new AggregateError([withCode("a", "ECONNREFUSED")], "all failed");
    expect(classifyFailure(error)).toBe("connection");
  });

  test("TypeError 携带 cause.code ECONNREFUSED 归类为 connection", () => {
    const error = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(classifyFailure(error)).toBe("connection");
  });

  test("消息同时含 network 与 authentication 时以 auth 文案优先判定为 auth", () => {
    expect(classifyFailure(new Error("network authentication required"))).toBe("auth");
  });
});

describe("NetworkPauseGate", () => {
  test("未登记的运行 canProceed 为 allowed", () => {
    const gate = new NetworkPauseGate();
    expect(gate.canProceed("run-unregistered")).toEqual({ allowed: true });
  });

  test("network 原因暂停后 canProceed 被拦并标明原因", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-1", "network");
    expect(gate.canProceed("run-1")).toEqual({ allowed: false, reason: "network" });
  });

  test("manual 原因暂停后 canProceed 被拦并标明原因", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-2", "manual");
    expect(gate.canProceed("run-2")).toEqual({ allowed: false, reason: "manual" });
  });

  test("resume 后运行恢复可执行", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-3", "network");
    gate.resume("run-3");
    expect(gate.canProceed("run-3")).toEqual({ allowed: true });
  });

  test("resume 后 listPaused 不包含该运行", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-resume", "network");
    gate.resume("run-resume");
    expect(gate.listPaused()).not.toContainEqual({ runId: "run-resume", reason: "network" });
  });

  test("resumeAll 只解除指定原因的运行", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-network", "network");
    gate.requestPause("run-manual", "manual");
    gate.resumeAll("network");
    expect(gate.canProceed("run-network")).toEqual({ allowed: true });
    expect(gate.canProceed("run-manual")).toEqual({ allowed: false, reason: "manual" });
  });

  test("同一运行先 network 后 manual 时以 manual 为准，resumeAll(network) 不解除它", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-4", "network");
    gate.requestPause("run-4", "manual");
    gate.resumeAll("network");
    expect(gate.canProceed("run-4")).toEqual({ allowed: false, reason: "manual" });
  });

  test("listPaused 无参数时返回全部暂停运行", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-a", "network");
    gate.requestPause("run-b", "manual");
    const paused = gate.listPaused();
    expect(paused).toContainEqual({ runId: "run-a", reason: "network" });
    expect(paused).toContainEqual({ runId: "run-b", reason: "manual" });
  });

  test("listPaused 按原因过滤", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-a", "network");
    gate.requestPause("run-b", "manual");
    expect(gate.listPaused("network")).toEqual([{ runId: "run-a", reason: "network" }]);
  });

  test("resume 未登记的运行不抛出且保持可执行", () => {
    const gate = new NetworkPauseGate();
    expect(() => gate.resume("run-never-paused")).not.toThrow();
    expect(gate.canProceed("run-never-paused")).toEqual({ allowed: true });
  });
});

describe("ConnectivityProbe：通用异步 tick 调度器", () => {
  test("start 后按固定间隔调用 probe", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    expect(calls).toBe(0);
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    scheduler.stop();
  });

  test("上一轮探测仍挂起时，下一轮定时器触发不会重入（调用计数不变）", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return new Promise(() => {});
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    timeSource.advance(3_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    scheduler.stop();
  });

  test("stop 后即使定时器曾触发过也不再调用 probe", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    scheduler.stop();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test("旧代际探测晚到 resolve 不会清掉新代际的在飞守卫（代际令牌）", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    let resolveOld: (() => void) | null = null;
    let hangNew = true;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        if (resolveOld === null) return new Promise<void>((resolve) => { resolveOld = resolve; });
        return hangNew ? new Promise<void>(() => {}) : Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);

    scheduler.stop();
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);

    resolveOld!();
    await flushMicrotasks();
    timeSource.advance(2_000);
    await flushMicrotasks();
    // 旧代际 settle 不该把新代际的在飞状态清空，新一轮定时器触发不应额外重入
    expect(calls).toBe(2);
    scheduler.stop();
  });

  test("睡眠数分钟跳变唤醒后只多触发一次", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);

    timeSource.jump(5 * 60_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    scheduler.stop();
  });

  test("probe 函数抛出异常不向外抛出，且下一轮仍会触发", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        throw new Error("探测函数同步抛错");
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    expect(() => timeSource.advance(1_000)).not.toThrow();
    await flushMicrotasks();
    expect(calls).toBe(1);
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    scheduler.stop();
  });

  test("probe 函数返回被拒绝的 Promise 不向外抛出，且下一轮仍会触发", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.reject(new Error("探测函数异步拒绝"));
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    scheduler.stop();
  });

  test("重复调用 start 是幂等的：只有一个定时器在跑", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    scheduler.start();
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    scheduler.stop();
  });

  test("重复调用 stop 是安全的", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const scheduler = new ConnectivityProbe({ clock, probe: () => Promise.resolve(), intervalMs: 1_000 });
    scheduler.start();
    expect(() => {
      scheduler.stop();
      scheduler.stop();
    }).not.toThrow();
  });

  test("未 start 直接 stop 不抛出且不调用 probe", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    expect(() => scheduler.stop()).not.toThrow();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(calls).toBe(0);
  });

  test("并发多次 start/stop 交替后最终仍只有一次有效调度在跑", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    scheduler.stop();
    scheduler.start();
    scheduler.stop();
    scheduler.start();

    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
    scheduler.stop();
  });
});

describe("分类与探测器的边界", () => {
  test("循环 cause 链不会栈溢出且按连接类判定", () => {
    const a = withCode("a", "ECONNRESET") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(classifyFailure(a)).toBe("connection");
    const self = new Error("self") as Error & { cause?: unknown };
    self.cause = self;
    expect(classifyFailure(self)).toBe("business");
  });

  test("5xx 状态码归为业务类而非连接中断", () => {
    expect(classifyFailure(Object.assign(new Error("gateway timed out"), { status: 504 }))).toBe("business");
    expect(classifyFailure(Object.assign(new Error("network unavailable"), { status: 503 }))).toBe("business");
  });

  test("取消优先于 cause 链中的连接错误", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError", cause: withCode("reset", "ECONNRESET") });
    expect(classifyFailure(abort)).toBe("cancelled");
  });
});

describe("调度器：在途探测期间 stop 后再 start", () => {
  test("探测挂起时调用 stop()，随后 start() 并推进时钟：新回合正常触发（inFlight 不卡死）", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const scheduler = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return new Promise(() => {});
      },
      intervalMs: 1_000,
    });
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);

    scheduler.stop();
    scheduler.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(2);

    scheduler.stop();
  });
});
