import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  EVENTS,
  METHODS,
  PROTOCOL_VERSION,
  assertKnownEvent,
  assertKnownMethod,
  assertProtocolVersion,
  createErrorResponse,
  createEvent,
  createRequest,
  createResponse,
  decodeFrames,
  encodeFrame,
  isFrame,
  validateParams,
} from "../runtime/protocol.ts";

const EXPECTED_METHODS = [
  "hello",
  "ping",
  "shutdown",
  "dispatch.requirement",
  "dispatch.review",
  "runs.list",
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.stop",
  "runs.resumeInterrupted",
  "runs.pauseAll",
  "runs.resumeAll",
  "runs.stopAll",
  "subscribe.activity",
  "subscribe.transcript",
  "unsubscribe",
  "relay.pending",
  "relay.answer",
  "relay.forward",
  "shells.list",
  "shells.stop",
  "shells.markStopped",
  "mcp.register",
];

const EXPECTED_EVENTS = [
  "activity",
  "transcript",
  "runs.changed",
  "relay.question",
  "relay.notice",
  "relay.withdraw",
  "shells.changed",
  "daemon.idle",
];

const EXPECTED_ERROR_CODES = [
  "protocol_version",
  "unknown_method",
  "unknown_event",
  "bad_params",
  "not_found",
  "already_active",
  "not_confirmed",
  "shape_violation",
  "daemon_busy",
  "internal",
];

const VALID_EXAMPLES: Record<string, Record<string, unknown>> = {
  hello: {
    windowId: "win-1",
    pid: 4321,
    sessionId: "session-abc",
    cwd: "/repo",
    workspaceRoot: "/workspace",
    repoIds: ["repo-1", "repo-2"],
    protocolVersion: PROTOCOL_VERSION,
  },
  ping: {},
  shutdown: {},
  "dispatch.requirement": { requirement: "实现登录页", cwd: "/repo" },
  "runs.list": {},
  "runs.get": { runId: "run-1" },
  "runs.pause": { runId: "run-1" },
  "runs.resume": { runId: "run-1" },
  "runs.stop": { runId: "run-1" },
  "runs.resumeInterrupted": { runId: "run-1" },
  "runs.pauseAll": {},
  "runs.resumeAll": {},
  "runs.stopAll": {},
  "subscribe.activity": {},
  "subscribe.transcript": { runId: "run-1" },
  unsubscribe: { subscriptionId: "sub-1" },
  "relay.pending": {},
  "relay.answer": { questionId: "q-1", answer: "同意", windowId: "win-1" },
  "relay.forward": { requirement: "需求描述", message: "补充说明", windowId: "win-1" },
  "shells.list": {},
  "shells.stop": { taskId: "task-1", expectedPid: 123, expectedStartedAt: "2026-09-09T00:00:00.000Z" },
  "shells.markStopped": {
    taskId: "task-1",
    expectedPid: 123,
    expectedStartedAt: "2026-09-09T00:00:00.000Z",
    decisionId: "decision-1",
  },
  "mcp.register": { adapterEntry: "./adapter.ts", configPath: "/config.json" },
  "dispatch.review": {
    requirement: "实现登录页",
    cwd: "/repo",
    baseline: "main",
    snapshot: { head: "abc123", fingerprint: "sha256:deadbeef" },
  },
};

function catchError(fn: () => unknown): { code?: string; message?: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

describe("协议常量", () => {
  test("PROTOCOL_VERSION 为 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test("目录精确等于协议成品", () => {
    expect([...METHODS].sort()).toEqual([...EXPECTED_METHODS].sort());
    expect([...EVENTS].sort()).toEqual([...EXPECTED_EVENTS].sort());
    expect([...ERROR_CODES].sort()).toEqual([...EXPECTED_ERROR_CODES].sort());
  });

  test("目录内每个方法对空 params 都只抛 bad_params", () => {
    for (const method of METHODS) {
      expect(catchError(() => validateParams(method, undefined))?.code).toBe("bad_params");
    }
  });

  test("未知事件名被拒绝", () => {
    expect(catchError(() => createEvent("不存在的事件", {}))?.code).toBe("unknown_event");
    expect(catchError(() => assertKnownEvent("activity"))).toBeNull();
  });
});

describe("encodeFrame", () => {
  test("输出恰含一个换行且位于末尾", () => {
    const frame = createEvent("daemon.idle", {});
    const line = encodeFrame(frame);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
  });

  test("编码后可被 JSON.parse 还原为等价对象", () => {
    const frame = createRequest("ping", {});
    const line = encodeFrame(frame);
    const parsed = JSON.parse(line.slice(0, -1));
    expect(parsed).toEqual(frame);
  });
});

describe("decodeFrames", () => {
  test("空缓冲区返回空帧数组与空 rest", () => {
    const { frames, rest } = decodeFrames("");
    expect(frames).toEqual([]);
    expect(rest).toBe("");
  });

  test("一次写入含三帧全部解出", () => {
    const f1 = createRequest("ping", {});
    const f2 = createResponse(f1.id, { pong: true });
    const f3 = createEvent("daemon.idle", {});
    const buffer = encodeFrame(f1) + encodeFrame(f2) + encodeFrame(f3);
    const { frames, rest } = decodeFrames(buffer);
    expect(frames.length).toBe(3);
    expect(rest).toBe("");
    expect((frames[0] as { t: string }).t).toBe("req");
    expect((frames[1] as { t: string }).t).toBe("res");
    expect((frames[2] as { t: string }).t).toBe("evt");
  });

  test("单帧被拆成两次写入时先留存 rest 再拼接解出", () => {
    const frame = createRequest("ping", {});
    const line = encodeFrame(frame);
    const splitPoint = Math.floor(line.length / 2);
    const part1 = line.slice(0, splitPoint);
    const part2 = line.slice(splitPoint);

    const first = decodeFrames(part1);
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe(part1);

    const second = decodeFrames(first.rest + part2);
    expect(second.frames.length).toBe(1);
    expect(second.rest).toBe("");
  });

  test("一次写入含完整帧加半帧，第二次写入补全半帧", () => {
    const f1 = createRequest("ping", {});
    const f2 = createRequest("shutdown", {});
    const line2 = encodeFrame(f2);
    const splitPoint = Math.floor(line2.length / 2);
    const write1 = encodeFrame(f1) + line2.slice(0, splitPoint);
    const write2 = line2.slice(splitPoint);

    const first = decodeFrames(write1);
    expect(first.frames.length).toBe(1);
    expect(first.rest).toBe(line2.slice(0, splitPoint));

    const second = decodeFrames(first.rest + write2);
    expect(second.frames.length).toBe(1);
    expect(second.rest).toBe("");
  });

  test("U+2028 与 U+2029 不被当作分隔符且往返后字符串相等", () => {
    const original = "line1 line2 tail";
    const frame = createEvent("transcript", { text: original });
    const encoded = encodeFrame(frame);
    expect((encoded.match(/\n/g) ?? []).length).toBe(1);

    const { frames, rest } = decodeFrames(encoded);
    expect(rest).toBe("");
    expect(frames.length).toBe(1);
    expect((frames[0] as { data: { text: string } }).data.text).toBe(original);
  });

  test("非法 JSON 行进入 errors，前后帧与残余照常返回", () => {
    const a = encodeFrame(createEvent("activity", { runId: "r", kind: "turn", at: "t" }));
    const b = encodeFrame(createEvent("daemon.idle", { exitAt: "x" }));
    const result = decodeFrames(`${a}不是合法JSON\n${b}{"t":"evt","event"`);
    expect(result.frames.length).toBe(2);
    expect(result.rest).toBe('{"t":"evt","event"');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.line).toBe("不是合法JSON");
  });

  test("空行与纯空白行被跳过", () => {
    const result = decodeFrames("\n  \n\r\n");
    expect(result.frames).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.rest).toBe("");
  });

  test("非帧形状的 JSON 行进入 errors", () => {
    const result = decodeFrames('123\nnull\n"hi"\n[1,2]\n{"method":"ping"}\n');
    expect(result.frames).toEqual([]);
    expect(result.errors.length).toBe(5);
  });

  test("t 正确但必需字段残缺的帧进入 errors", () => {
    const result = decodeFrames('{"t":"req"}\n{"t":"res"}\n{"t":"evt"}\n{"t":"req","id":null,"method":123}\n{"t":"res","id":"1","ok":false,"error":{}}\n');
    expect(result.frames).toEqual([]);
    expect(result.errors.length).toBe(5);
  });
});

describe("createRequest / createResponse / createErrorResponse / createEvent", () => {
  test("连续调用生成的请求 id 递增且不重复", () => {
    const r1 = createRequest("ping", {});
    const r2 = createRequest("ping", {});
    expect(typeof r1.id).toBe("string");
    expect(r1.id).not.toBe(r2.id);
    expect(Number(r2.id)).toBeGreaterThan(Number(r1.id));
  });

  test("createRequest 生成的帧形状正确", () => {
    const req = createRequest("runs.get", { runId: "run-1" });
    expect(req.t).toBe("req");
    expect(req.method).toBe("runs.get");
    expect(req.params).toEqual({ runId: "run-1" });
  });

  test("createResponse 生成成功响应帧", () => {
    const res = createResponse("42", { runId: "run-1" });
    expect(res).toEqual({ t: "res", id: "42", ok: true, result: { runId: "run-1" } });
  });

  test("createErrorResponse 生成失败响应帧", () => {
    const err = createErrorResponse("42", "not_found", "run 不存在");
    expect(err).toEqual({ t: "res", id: "42", ok: false, error: { code: "not_found", message: "run 不存在" } });
  });

  test("createErrorResponse 不传 data 时 error 不含 data 键", () => {
    const err = createErrorResponse("42", "not_found", "run 不存在");
    expect("data" in err.error).toBe(false);
  });

  test("createErrorResponse 支持可选 data 参数并原样保留", () => {
    const err = createErrorResponse("42", "already_active", "需求已有活动运行", { runId: "run-1" });
    expect(err).toEqual({
      t: "res",
      id: "42",
      ok: false,
      error: { code: "already_active", message: "需求已有活动运行", data: { runId: "run-1" } },
    });
  });

  test("带 data 的错误响应经 encode → decode 往返后被 isFrame 接受，且 data 保留", () => {
    const err = createErrorResponse("42", "already_active", "需求已有活动运行", { runId: "run-1", extra: [1, 2, 3] });
    const encoded = encodeFrame(err);
    expect(isFrame(JSON.parse(encoded.trim()))).toBe(true);

    const { frames, errors } = decodeFrames(encoded);
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(err);
    expect((frames[0] as { error: { data?: unknown } }).error.data).toEqual({ runId: "run-1", extra: [1, 2, 3] });
  });

  test("createEvent 生成事件帧", () => {
    const evt = createEvent("activity", { runId: "run-1", tool: "bash" });
    expect(evt).toEqual({ t: "evt", event: "activity", data: { runId: "run-1", tool: "bash" } });
  });
});

describe("assertKnownMethod", () => {
  test("已知方法不抛出", () => {
    for (const name of EXPECTED_METHODS) {
      expect(() => assertKnownMethod(name)).not.toThrow();
    }
  });

  test("未知方法抛出 unknown_method", () => {
    const error = catchError(() => assertKnownMethod("foo.bar"));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("unknown_method");
  });
});

describe("assertProtocolVersion", () => {
  test("版本一致不抛出", () => {
    expect(() => assertProtocolVersion(PROTOCOL_VERSION)).not.toThrow();
  });

  test("版本不一致抛出 protocol_version", () => {
    const error = catchError(() => assertProtocolVersion(PROTOCOL_VERSION + 1));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("protocol_version");
  });
});

describe("validateParams — 方法目录合法示例", () => {
  for (const method of EXPECTED_METHODS) {
    test(`${method} 的合法参数示例通过校验`, () => {
      const example = VALID_EXAMPLES[method]!;
      expect(() => validateParams(method, example)).not.toThrow();
    });
  }

  test("dispatch.requirement 携带可选 mcp 字段时通过校验", () => {
    const params = {
      requirement: "实现登录页",
      cwd: "/repo",
      mcp: { adapterEntry: "./adapter.ts", configPath: "/config.json" },
    };
    expect(() => validateParams("dispatch.requirement", params)).not.toThrow();
  });

  test("runs.list 携带可选分页字段时通过校验", () => {
    expect(() => validateParams("runs.list", { offset: 0, limit: 20 })).not.toThrow();
  });

  test("subscribe.transcript 携带可选 fromSeq 时通过校验", () => {
    expect(() => validateParams("subscribe.transcript", { runId: "run-1", fromSeq: 5 })).not.toThrow();
  });

  test("dispatch.review 携带可选 mcp 字段时通过校验", () => {
    const params = {
      ...VALID_EXAMPLES["dispatch.review"]!,
      mcp: { adapterEntry: "./adapter.ts", configPath: "/config.json" },
    };
    expect(() => validateParams("dispatch.review", params)).not.toThrow();
  });
});

describe("validateParams — 缺字段被拒绝", () => {
  test("hello 缺少 windowId 抛出 bad_params 并在消息中列出字段", () => {
    const { windowId: _windowId, ...rest } = VALID_EXAMPLES.hello!;
    const error = catchError(() => validateParams("hello", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("windowId");
  });

  test("runs.get 缺少 runId 抛出 bad_params", () => {
    const error = catchError(() => validateParams("runs.get", {}));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("runId");
  });

  test("shells.stop 缺少 expectedPid 抛出 bad_params", () => {
    const { expectedPid: _expectedPid, ...rest } = VALID_EXAMPLES["shells.stop"]!;
    const error = catchError(() => validateParams("shells.stop", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("expectedPid");
  });

  test("relay.answer 缺少 answer 抛出 bad_params", () => {
    const { answer: _answer, ...rest } = VALID_EXAMPLES["relay.answer"]!;
    const error = catchError(() => validateParams("relay.answer", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("answer");
  });

  test("mcp.register 缺少 configPath 抛出 bad_params", () => {
    const { configPath: _configPath, ...rest } = VALID_EXAMPLES["mcp.register"]!;
    const error = catchError(() => validateParams("mcp.register", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("configPath");
  });

  test("dispatch.review 缺少 snapshot 抛出 bad_params", () => {
    const { snapshot: _snapshot, ...rest } = VALID_EXAMPLES["dispatch.review"]!;
    const error = catchError(() => validateParams("dispatch.review", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("snapshot");
  });

  test("shells.markStopped 缺少 decisionId 抛出 bad_params", () => {
    const { decisionId: _decisionId, ...rest } = VALID_EXAMPLES["shells.markStopped"]!;
    const error = catchError(() => validateParams("shells.markStopped", rest));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("decisionId");
  });
});

describe("validateParams — 多余字段被拒绝", () => {
  test("ping 携带未定义字段抛出 bad_params", () => {
    const error = catchError(() => validateParams("ping", { extra: true }));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("runs.pauseAll 携带未定义字段抛出 bad_params", () => {
    const error = catchError(() => validateParams("runs.pauseAll", { runId: "run-1" }));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("hello 携带未定义字段抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES.hello!, unexpected: "x" };
    const error = catchError(() => validateParams("hello", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("dispatch.review 携带未定义字段抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES["dispatch.review"]!, unexpected: "x" };
    const error = catchError(() => validateParams("dispatch.review", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("shells.markStopped 携带未定义字段抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES["shells.markStopped"]!, unexpected: "x" };
    const error = catchError(() => validateParams("shells.markStopped", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("dispatch.review 的 snapshot 内携带未定义字段抛出 bad_params", () => {
    const base = VALID_EXAMPLES["dispatch.review"]!;
    const params = { ...base, snapshot: { ...(base.snapshot as object), unexpected: "x" } };
    const error = catchError(() => validateParams("dispatch.review", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });
});

describe("validateParams — 字段类型被校验", () => {
  test("dispatch.review 的 snapshot.head 非字符串抛出 bad_params", () => {
    const base = VALID_EXAMPLES["dispatch.review"]!;
    const params = { ...base, snapshot: { ...(base.snapshot as object), head: 42 } };
    const error = catchError(() => validateParams("dispatch.review", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("head");
  });

  test("shells.markStopped 的 expectedPid 非数字抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES["shells.markStopped"]!, expectedPid: "123" };
    const error = catchError(() => validateParams("shells.markStopped", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
    expect(error?.message).toContain("expectedPid");
  });

  test("shells.stop 的 expectedPid 非数字抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES["shells.stop"]!, expectedPid: "123" };
    const error = catchError(() => validateParams("shells.stop", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });
});
