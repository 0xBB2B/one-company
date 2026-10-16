import { describe, expect, test } from "vitest";
import { classifyFailure, NetworkPauseGate } from "../src/core/host/network-pause.ts";

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

  test("模型请求超时不算断网，归类为 business，交给 SDK 自动重试", () => {
    expect(classifyFailure(new Error("Request timed out."))).toBe("business");
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
  test("未登记的运行可以继续", () => {
    expect(new NetworkPauseGate().canProceed("run-unregistered")).toBe(true);
  });

  test("断网暂停后被拦，resume 后恢复", () => {
    const gate = new NetworkPauseGate();
    gate.requestPause("run-1");
    expect(gate.canProceed("run-1")).toBe(false);
    gate.resume("run-1");
    expect(gate.canProceed("run-1")).toBe(true);
  });

  test("resume 未登记的运行不抛出且保持可执行", () => {
    const gate = new NetworkPauseGate();
    expect(() => gate.resume("run-never-paused")).not.toThrow();
    expect(gate.canProceed("run-never-paused")).toBe(true);
  });
});

describe("分类的边界", () => {
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
