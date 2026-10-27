import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { RunStepBook, stepText } from "../src/modules/agents/run-steps.ts";

function fakeHandle(initial = "running") {
  const h = { events: new EventEmitter(), current: initial, turns: 0, state: () => h.current, turnsUsed: () => h.turns };
  return h;
}

describe("步骤文字", () => {
  test.each([
    ["read", { path: "src/a.ts" }, "读 src/a.ts"],
    ["read", { path: 42 }, "读"],
    ["read", null, "读"],
    ["read", undefined, "读"],
    ["grep", { pattern: "foo", path: "src/" }, '搜 "foo" 在 src/'],
    ["grep", { pattern: "foo" }, '搜 "foo"'],
    ["find", { pattern: "*.ts", path: "src" }, "找文件 *.ts 在 src"],
    ["find", { pattern: "*.ts" }, "找文件 *.ts"],
    ["ls", { path: "src" }, "列目录 src"],
    ["ls", {}, "列目录 ."],
    ["one_company_knowledge_query", { action: "exact", value: "登录" }, '查项目知识 "登录"'],
    ["one_company_knowledge_query", { action: "search", text: "登录" }, '查项目知识 "登录"'],
    ["one_company_knowledge_query", { action: "facts", text: "登录" }, '查项目知识 "登录"'],
    ["one_company_knowledge_query", { action: "facts" }, "查项目知识"],
    ["one_company_knowledge_query", { action: "next" }, "查项目知识"],
    ["one_company_change_apply", { action: "prepare", files: [{ path: "a.ts" }, { path: "b.ts" }] }, "预检改动 a.ts、b.ts"],
    ["one_company_change_apply", { action: "apply", files: [{ path: "a.ts", content: "x" }, { path: "b.ts", content: null }] }, "写入 a.ts、b.ts"],
    ["one_company_change_apply", { action: "import", files: [{ path: "a.ts" }] }, "导入 a.ts"],
    ["one_company_change_apply", { action: "status" }, "查写入结果"],
    ["one_company_verification_run", { action: "run", kind: "debug", command: "pnpm test\n--run" }, "跑命令 pnpm test --run"],
    ["one_company_verification_run", { action: "run", command: "a\tb" }, "跑命令 a b"],
    ["one_company_verification_run", { action: "status" }, "查命令结果"],
    ["one_company_verification_run", { action: "stop" }, "停命令"],
    ["one_company_requirement_manage", { action: "anything" }, "读需求"],
    ["one_company_plan_manage", { action: "anything" }, "读计划"],
    ["one_company_result_submit", {}, "交结果"],
    ["mcp__github__search", { q: "x" }, "mcp__github__search"],
  ])("%s %j -> %s", (tool, args, expected) => {
    expect(stepText(tool, args)).toBe(expected);
  });

  test("参数缺失或类型不对时不抛错", () => {
    for (const args of [null, undefined, 5, "s", [], { files: "x" }, { files: [null, 3, { path: 1 }] }]) {
      expect(() => stepText("one_company_change_apply", args)).not.toThrow();
      expect(() => stepText("grep", args)).not.toThrow();
    }
  });

  test("2000 个字符的 command 记下的文字不超过 1000 个字符", () => {
    const text = stepText("one_company_verification_run", { action: "run", command: "x".repeat(2000) });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.startsWith("跑命令 x")).toBe(true);
  });

  test("其他控制字符也换成一个空格", () => {
    expect(stepText("one_company_verification_run", { action: "run", command: "a\u000bb\u001b[31mc\u0007d" })).toBe("跑命令 a b [31mc d");
  });

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])("action 是对象自带属性名 %s 时按不认识的动作处理", (action) => {
    expect(stepText("one_company_change_apply", { action, files: [{ path: "a.ts" }] })).toBe("one_company_change_apply");
    expect(stepText("one_company_verification_run", { action, command: "x" })).toBe("one_company_verification_run");
  });
});

describe("步骤簿", () => {
  test("三次调用后按开始先后记录，成功与报错各自落状态，父调用编号被记下", () => {
    const book = new RunStepBook();
    const h = fakeHandle();
    book.track("r1", h);
    h.events.emit("tool_start", { toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
    h.events.emit("tool_start", { toolCallId: "t2", toolName: "one_company_plan_manage", args: {} });
    h.events.emit("tool_start", { toolCallId: "t3", toolName: "grep", args: { pattern: "p" }, parentToolCallId: "t2" });
    h.events.emit("tool_end", { toolCallId: "t1", toolName: "read", isError: false });
    h.events.emit("tool_end", { toolCallId: "t2", toolName: "one_company_plan_manage", isError: true });
    const steps = book.steps("r1")!;
    expect(steps.map((s) => s.status)).toEqual(["done", "error", "running"]);
    expect(steps.map((s) => s.id)).toEqual(["t1", "t2", "t3"]);
    expect(steps[2]!.parentId).toBe(steps[1]!.id);
    expect(steps[0]!.parentId).toBeUndefined();
    expect(steps[0]!.text).toBe(stepText("read", { path: "a.ts" }));
    expect(steps[2]!.text).toBe(stepText("grep", { pattern: "p" }));
  });

  test("刚 track 还没有调用时返回空数组", () => {
    const book = new RunStepBook();
    book.track("r1", fakeHandle());
    expect(book.steps("r1")).toEqual([]);
  });

  test("没 track 过的运行编号返回 undefined", () => {
    expect(new RunStepBook().steps("nope")).toBeUndefined();
  });

  test("steps 返回副本，改返回值不影响下次结果", () => {
    const book = new RunStepBook();
    const h = fakeHandle();
    book.track("r1", h);
    h.events.emit("tool_start", { toolCallId: "t1", toolName: "ls", args: {} });
    const first = book.steps("r1")!;
    first.pop();
    expect(book.steps("r1")).toHaveLength(1);
    const again = book.steps("r1")!;
    again[0]!.status = "error";
    expect(book.steps("r1")![0]!.status).toBe("running");
  });
});

describe("主窗口可见的运行状态", () => {
  test("同一连接读到句柄当前状态与已用轮数，maxTurns 取 track 时的值", () => {
    const book = new RunStepBook();
    const h = fakeHandle();
    h.turns = 3;
    const before = Date.now();
    book.track("r1", h, { owner: "c1", maxTurns: 20 });
    const status = book.mainStatus("r1", "c1")!;
    expect(status.state).toBe("running");
    expect(status.turns).toBe(3);
    expect(status.maxTurns).toBe(20);
    expect(status.startedAt).toBeGreaterThanOrEqual(before);
    expect(status.endedAt).toBeUndefined();
    h.current = "paused"; h.turns = 4;
    expect(book.mainStatus("r1", "c1")).toMatchObject({ state: "paused", turns: 4 });
  });

  test("没给 maxTurns 时为 null", () => {
    const book = new RunStepBook();
    book.track("r1", fakeHandle(), { owner: "c1" });
    expect(book.mainStatus("r1", "c1")!.maxTurns).toBeNull();
  });

  test("换连接读到 undefined", () => {
    const book = new RunStepBook();
    book.track("r1", fakeHandle(), { owner: "c1" });
    expect(book.mainStatus("r1", "c2")).toBeUndefined();
  });

  test("没带 owner 的运行 mainStatus 为 undefined", () => {
    const book = new RunStepBook();
    book.track("r1", fakeHandle());
    expect(book.mainStatus("r1", "c1")).toBeUndefined();
  });

  test("没 track 过的运行 mainStatus 为 undefined", () => {
    expect(new RunStepBook().mainStatus("nope", "c1")).toBeUndefined();
  });

  test("failed 后记下结束快照，之后句柄状态再变也不影响", () => {
    const book = new RunStepBook();
    const h = fakeHandle();
    book.track("r1", h, { owner: "c1" });
    h.turns = 5; h.current = "failed";
    h.events.emit("failed", { reason: "x" });
    h.current = "running"; h.turns = 9;
    const status = book.mainStatus("r1", "c1")!;
    expect(status).toMatchObject({ state: "failed", reason: "x", turns: 5 });
    expect(typeof status.endedAt).toBe("number");
    expect(status.endedAt).toBeGreaterThanOrEqual(status.startedAt);
  });

  test.each([
    ["completed", "completed"],
    ["turn_limit_reached", "turn_limit_reached"],
    ["ended_without_result", "ended_without_result"],
    ["stopped", "stopped"],
  ])("%s 事件使状态变为 %s 并有结束时间", (event, state) => {
    const book = new RunStepBook();
    const h = fakeHandle();
    book.track("r1", h, { owner: "c1" });
    h.current = state;
    h.events.emit(event, {});
    h.current = "running";
    const status = book.mainStatus("r1", "c1")!;
    expect(status.state).toBe(state);
    expect(typeof status.endedAt).toBe("number");
  });
});
