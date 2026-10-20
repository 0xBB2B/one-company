import { registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import { describe, expect, test } from "vitest";
import {
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
} from "../src/core/host/protocol.ts";
import { validateParams } from "../src/app/daemon/method-params.ts";

const EXPECTED_METHODS = [
  "hello",
  "ping",
  "shutdown",
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.stop",
  "agents.dispatchPm",
  "agents.dispatchExplore",
  "explore.result",
  "explore.list",
  "prototypes.dispatch",
  "prototypes.designers",
  "prototypes.list",
  "prototypes.board",
  "prototypes.pending",
  "prototypes.decide",
  "prototypes.remove",
  "prototypes.removal",
  "pm.overview",
  "pm.packet",
  "pm.message",
  "workflow.manage",
  "shells.list",
  "shells.stop",
  "index.manage",
  "knowledge.query",
];

const EXPECTED_EVENTS = [
  "pm.overview.changed",
  "explore.finished",
  "explore.changed",
  "prototype.changed",
  "prototype.submitted",
  "prototype.finished",
];

const VALID_EXAMPLES: Record<string, Record<string, unknown>> = {
  hello: {
    authToken: "test-control-token",
    windowId: "win-1",
    sessionId: "session-abc",
    protocolVersion: PROTOCOL_VERSION,
  },
  ping: {},
  shutdown: {},
  "runs.get": { runId: "run-1" },
  "runs.pause": { runId: "run-1" },
  "runs.resume": { runId: "run-1" },
  "agents.dispatchPm": { requirementId: "req-1", model: { provider: "p", id: "m" }, thinking: "off" },
  "pm.overview": {},
  "agents.dispatchExplore": { request: { question: "q", clues: [], source: { kind: "local_file" } }, maxTurns: 3, model: { provider: "p", id: "m" }, thinking: "off" },
  "explore.result": { runId: "r" },
  "explore.list": {},
  "prototypes.dispatch": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", name: "登录页", brief: "手机号登录界面", maxTurns: 10, model: { provider: "p", id: "m" }, thinking: "off" },
  "prototypes.designers": {},
  "prototypes.list": {},
  "prototypes.board": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10" },
  "prototypes.pending": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", name: "登录页" },
  "prototypes.decide": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", name: "登录页", version: 1, hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", choice: "accept", opinion: null },
  "prototypes.remove": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", name: "登录页", version: 1 },
  "prototypes.removal": { requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", name: "登录页" },
  "pm.packet": { requirementId: "req-1", itemId: "task:x" },
  "pm.message": { requirementId: "req-1", text: "先做登录" },
  "workflow.manage": { requirementId: "req-1", request: { action: "status" } },
  "runs.stop": { runId: "run-1" },
  "shells.list": {},
  "shells.stop": { taskId: "task-1", expectedPid: 123, expectedStartedAt: "2026-09-09T00:00:00.000Z" },
  "index.manage": { action: "status" },
  "knowledge.query": { query: { action: "search", text: "x" } },
};

function catchError(fn: () => unknown): { code?: string; message?: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
}

test("知识RPC严格拒绝模型身份/SQL/超限及非授权路径，仅接受有界query", () => {
  const base = VALID_EXAMPLES["knowledge.query"]!;
  for (const key of ["role", "windowId", "sessionId", "workspaceId", "repositoryRoot", "repoId", "caller", "sql", "grantId"]) {
    expect(catchError(() => validateParams("knowledge.query", { ...base, [key]: "main" }))?.code).toBe("bad_params");
    expect(catchError(() => validateParams("knowledge.query", { ...base, query: { action: "facts", [key]: "main" } }))?.code).toBe("bad_params");
  }
  for (const query of [{ action: "facts", maxBytes: 24577 }, { action: "facts", pageSize: 21 },
    { action: "exact", by: "path", value: "docs/prd/secret.md" }, { action: "search", text: " " }, { action: "search", text: "中".repeat(257) }]) {
    expect(catchError(() => validateParams("knowledge.query", { ...base, query }))?.code).toBe("bad_params");
  }
  expect(() => validateParams("knowledge.query", base)).not.toThrow();
});

describe("协议常量", () => {
  test("PROTOCOL_VERSION 为 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  test("prototypes 方法的需求编号不是 UUIDv7 时以 bad_params 拒绝", () => {
    for (const method of ["prototypes.dispatch", "prototypes.board"]) {
      const params = { ...VALID_EXAMPLES[method]!, requirementId: "req-1" };
      expect(catchError(() => validateParams(method, params))?.code).toBe("bad_params");
    }
  });

  test("目录精确等于协议成品", () => {
    expect([...METHODS].sort()).toEqual([...EXPECTED_METHODS].sort());
    expect([...EVENTS].sort()).toEqual([...EXPECTED_EVENTS].sort());
  });

  test("目录内每个方法对空 params 都只抛 bad_params", () => {
    for (const method of METHODS) {
      expect(catchError(() => validateParams(method, undefined))?.code).toBe("bad_params");
    }
  });

  test("未知事件名被拒绝", () => {
    expect(catchError(() => createEvent("不存在的事件", {}))?.code).toBe("unknown_event");
    expect(catchError(() => assertKnownEvent("pm.overview.changed"))).toBeNull();
  });
});

describe("encodeFrame", () => {
  test("输出恰含一个换行且位于末尾", () => {
    const frame = createEvent("explore.finished", {});
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
    const f3 = createEvent("explore.finished", {});
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
    const frame = createEvent("pm.overview.changed", { text: original });
    const encoded = encodeFrame(frame);
    expect((encoded.match(/\n/g) ?? []).length).toBe(1);

    const { frames, rest } = decodeFrames(encoded);
    expect(rest).toBe("");
    expect(frames.length).toBe(1);
    expect((frames[0] as { data: { text: string } }).data.text).toBe(original);
  });

  test("非法 JSON 行进入 errors，前后帧与残余照常返回", () => {
    const a = encodeFrame(createEvent("pm.overview.changed", { runId: "r", kind: "turn", at: "t" }));
    const b = encodeFrame(createEvent("explore.finished", { exitAt: "x" }));
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
    const err = createErrorResponse("42", "pm_already_owned", "本需求已有有效 PM", { runId: "run-1" });
    expect(err).toEqual({
      t: "res",
      id: "42",
      ok: false,
      error: { code: "pm_already_owned", message: "本需求已有有效 PM", data: { runId: "run-1" } },
    });
  });

  test("带 data 的错误响应经 encode → decode 往返后被 isFrame 接受，且 data 保留", () => {
    const err = createErrorResponse("42", "pm_already_owned", "本需求已有有效 PM", { runId: "run-1", extra: [1, 2, 3] });
    const encoded = encodeFrame(err);
    expect(isFrame(JSON.parse(encoded.trim()))).toBe(true);

    const { frames, errors } = decodeFrames(encoded);
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(err);
    expect((frames[0] as { error: { data?: unknown } }).error.data).toEqual({ runId: "run-1", extra: [1, 2, 3] });
  });

  test("createEvent 生成事件帧", () => {
    const evt = createEvent("pm.overview.changed", { runId: "run-1", tool: "bash" });
    expect(evt).toEqual({ t: "evt", event: "pm.overview.changed", data: { runId: "run-1", tool: "bash" } });
  });
});

test("守护进程注册的每个方法都在协议方法清单里，否则真实连接会以未知方法拒绝", () => {
  const registered: string[] = [];
  registerProtocolHandlers({ server: { registerHandler: (method: string) => { registered.push(method); }, markHandlersReady: () => {} }, manager: {}, shellRegistry: {} } as never);
  expect(registered.filter((method) => !(METHODS as readonly string[]).includes(method))).toEqual([]);
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

  test("index.manage只接受四种固定action", () => {
    for (const action of ["init", "preview", "refresh", "status"]) {
      expect(() => validateParams("index.manage", { action })).not.toThrow();
    }
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
});

describe("validateParams — 多余字段被拒绝", () => {
  test("ping 携带未定义字段抛出 bad_params", () => {
    const error = catchError(() => validateParams("ping", { extra: true }));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("shells.list 携带未定义字段抛出 bad_params", () => {
    const error = catchError(() => validateParams("shells.list", { runId: "run-1" }));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("hello 携带未定义字段抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES.hello!, unexpected: "x" };
    const error = catchError(() => validateParams("hello", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });

  test("index.manage拒绝role/approved/grantId/SQL/Git命令和未知action", () => {
    const base = VALID_EXAMPLES["index.manage"]!;
    for (const field of ["role", "approved", "grantId", "sql", "gitCommand", "pathCommand", "repositoryRoot"]) {
      expect(catchError(() => validateParams("index.manage", { ...base, [field]: "forged" }))?.code).toBe("bad_params");
    }
    expect(catchError(() => validateParams("index.manage", { ...base, action: "ensureFresh" }))?.code).toBe("bad_params");
    expect(catchError(() => validateParams("index.manage", { ...base, action: "restartDaemon" }))?.code).toBe("bad_params");
  });
});

describe("validateParams — 字段类型被校验", () => {
  test("shells.stop 的 expectedPid 非数字抛出 bad_params", () => {
    const params = { ...VALID_EXAMPLES["shells.stop"]!, expectedPid: "123" };
    const error = catchError(() => validateParams("shells.stop", params));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("bad_params");
  });
});
