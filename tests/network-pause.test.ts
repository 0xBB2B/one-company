import { describe, expect, test } from "bun:test";
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

describe("ConnectivityProbe", () => {
  test("未探测过时状态为初始值", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: async () => true, intervalMs: 5_000 });
    expect(probe.status()).toEqual({ reachable: null, consecutiveFailures: 0, probes: 0 });
  });

  test("首次探测即可达时不触发恢复回调", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: async () => true, intervalMs: 5_000 });
    let recovered = 0;
    probe.onRecovered(() => recovered++);
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(probe.status()).toEqual({ reachable: true, consecutiveFailures: 0, probes: 1 });
    expect(recovered).toBe(0);
  });

  test("连续可达不重复触发恢复回调", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: async () => true, intervalMs: 5_000 });
    let recovered = 0;
    probe.onRecovered(() => recovered++);
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(recovered).toBe(0);
  });

  test("先失败三次再成功时恢复边沿只触发一次", async () => {
    const results = [false, false, false, true];
    let index = 0;
    const probeFn = async () => results[index++] ?? true;
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    let recovered = 0;
    probe.onRecovered(() => recovered++);
    probe.start();
    for (let i = 0; i < 4; i++) {
      timeSource.advance(5_000);
      await flushMicrotasks();
    }
    expect(probe.status()).toEqual({ reachable: true, consecutiveFailures: 0, probes: 4 });
    expect(recovered).toBe(1);
  });

  test("探测函数抛异常等同返回 false 且不向外抛出", async () => {
    const probeFn = async () => {
      throw new Error("探测异常");
    };
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    let recovered = 0;
    probe.onRecovered(() => recovered++);
    probe.start();
    expect(async () => {
      timeSource.advance(5_000);
      await flushMicrotasks();
    }).not.toThrow();
    await flushMicrotasks();
    expect(probe.status().reachable).toBe(false);
    expect(probe.status().consecutiveFailures).toBe(1);
    expect(recovered).toBe(0);
  });

  test("stop 后不再周期探测", async () => {
    let calls = 0;
    const probeFn = async () => {
      calls++;
      return true;
    };
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    probe.stop();
    timeSource.advance(20_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test("stop 后 start 将 consecutiveFailures 归零", async () => {
    const probeFn = async () => false;
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(probe.status().consecutiveFailures).toBe(2);
    probe.stop();
    probe.start();
    expect(probe.status().consecutiveFailures).toBe(0);
  });

  test("onRecovered 注销函数调用后不再触发", async () => {
    const results = [false, true, false, true];
    let index = 0;
    const probeFn = async () => results[index++] ?? true;
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    let recovered = 0;
    const unsubscribe = probe.onRecovered(() => recovered++);
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(recovered).toBe(1);
    unsubscribe();
    timeSource.advance(5_000);
    await flushMicrotasks();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(recovered).toBe(1);
  });

  test("睡眠 5 分钟跳变唤醒后只多探测一次且不计入失败", async () => {
    let calls = 0;
    const probeFn = async () => {
      calls++;
      return true;
    };
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    probe.start();
    timeSource.jump(300_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(probe.status()).toEqual({ reachable: true, consecutiveFailures: 0, probes: 1 });
  });

  test("重复调用 start 三次后一个周期内探测函数只调用一次，stop 后推进多个周期不再探测", async () => {
    let calls = 0;
    const probeFn = async () => {
      calls++;
      return true;
    };
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    probe.start();
    probe.start();
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    probe.stop();
    timeSource.advance(20_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test("探测函数返回永不 resolve 的 Promise 时推进十个周期只产生一次在飞探测", async () => {
    let calls = 0;
    let resolveFirst: (value: boolean) => void = () => {};
    const probeFn = () =>
      new Promise<boolean>((resolve) => {
        calls++;
        if (calls === 1) resolveFirst = resolve;
      });
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    probe.start();
    for (let i = 0; i < 10; i++) {
      timeSource.advance(5_000);
      await flushMicrotasks();
    }
    expect(calls).toBe(1);
    resolveFirst(true);
    await flushMicrotasks();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(calls).toBe(2);
  });

  test("探测在飞状态下调用 stop 后即使晚到 resolve 也不触发恢复且状态保持不可达", async () => {
    let calls = 0;
    let resolveSecond: (value: boolean) => void = () => {};
    const probeFn = () =>
      new Promise<boolean>((resolve) => {
        calls++;
        if (calls === 1) {
          resolve(false);
        } else {
          resolveSecond = resolve;
        }
      });
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    let recovered = 0;
    probe.onRecovered(() => recovered++);
    probe.start();
    timeSource.advance(5_000);
    await flushMicrotasks();
    expect(probe.status().reachable).toBe(false);
    timeSource.advance(5_000);
    probe.stop();
    resolveSecond(true);
    await flushMicrotasks();
    expect(recovered).toBe(0);
    expect(probe.status().reachable).toBe(false);
  });

  test("onRecovered 回调之一抛错不影响另一回调被调用且不产生未捕获的 Promise rejection", async () => {
    const results = [false, true, false, true];
    let index = 0;
    const probeFn = async () => results[index++] ?? true;
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const probe = new ConnectivityProbe({ clock, probe: probeFn, intervalMs: 5_000 });
    let secondCalls = 0;
    let unhandledRejections = 0;
    const onUnhandledRejection = () => unhandledRejections++;
    process.on("unhandledRejection", onUnhandledRejection);
    probe.onRecovered(() => {
      throw new Error("第一个回调抛错");
    });
    probe.onRecovered(() => secondCalls++);
    probe.start();
    for (let i = 0; i < 4; i++) {
      timeSource.advance(5_000);
      await flushMicrotasks();
    }
    process.removeListener("unhandledRejection", onUnhandledRejection);
    expect(secondCalls).toBe(2);
    expect(unhandledRejections).toBe(0);
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

  test("探测返回 null 时视为不可判定，不改状态也不计数", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const results: Array<boolean | null> = [false, null, null, true];
    let index = 0;
    let recovered = 0;
    const probe = new ConnectivityProbe({ clock, probe: async () => (index < results.length ? results[index++]! : true), intervalMs: 1_000 });
    probe.onRecovered(() => {
      recovered++;
    });
    probe.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(probe.status().reachable).toBe(false);
    for (let i = 0; i < 2; i++) {
      timeSource.advance(1_000);
      await flushMicrotasks();
    }
    expect(probe.status()).toEqual({ reachable: false, consecutiveFailures: 1, probes: 1 });
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(recovered).toBe(1);
  });

  test("旧探测悬挂时 stop 再 start 后新代际仍能探测", async () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    let hang = true;
    const probe = new ConnectivityProbe({
      clock,
      probe: () => {
        calls++;
        return hang ? new Promise<boolean>(() => {}) : Promise.resolve(true);
      },
      intervalMs: 1_000,
    });
    probe.start();
    timeSource.advance(1_000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    probe.stop();
    hang = false;
    probe.start();
    timeSource.advance(3_000);
    await flushMicrotasks();
    expect(calls).toBeGreaterThan(1);
  });
});
