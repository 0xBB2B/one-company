import { testRepoId, sessionJson } from "./helpers/database-fixture.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { RunStore } from "../runtime/run-store.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { createClock } from "../runtime/clock.ts";
import type { TimeSource } from "../runtime/clock.ts";
import { createSessionManagerForRun, readTranscript, sessionRecordRef } from "../runtime/session-records.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { closeActiveTranscriptView, openTranscriptView, TranscriptView } from "../runtime/transcript-view.ts";

const KEY = {
  up: "\x1b[A",
  upKittyRelease: "\x1b[1;1:3A",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  end: "\x1b[F",
  escape: "\x1b",
  enter: "\r",
};

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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const tempCwds: string[] = [];

afterEach(async () => {
  // 查看页在途状态是模块级单例；用例断言若在按 Esc 之前失败会提前退出，必须主动收尾，否则会卡住后续所有用例的打开位
  closeActiveTranscriptView();
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of tempCwds.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeRunContext() {
  const home = await createTempHome();
  tempHomes.push(home);
  const cwd = await mkdtemp(join(tmpdir(), "transcript-view-cwd-"));
  tempCwds.push(cwd);
  const repoId = testRepoId();
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "transcript-test" });
  const run = await store.create({ kind: "requirement", requirement: "2026-09-10.transcript", task: "查看", cwd, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  await store.update(run.id, { state: "running" });
  return { dataRoot: home.dataRoot, repoId, runId: run.id, cwd, store };
}

function baseUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: baseUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage["content"],
  isError: boolean,
): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: Date.now() };
}

async function loadEndedRecord() {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  manager.appendMessage(userMessage("运行任务"));
  manager.appendMessage(
    assistantMessage(
      [
        { type: "thinking", thinking: "先看看现状" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
      "toolUse",
    ),
  );
  manager.appendMessage(toolResultMessage("call-1", "bash", [{ type: "text", text: "ok\n" }], false));
  manager.appendMessage(assistantMessage([{ type: "text", text: "完成" }], "stop"));
  await ctx.store.update(ctx.runId, { state: "completed" });
  const result = readTranscript(ctx);
  if (!result.ok) throw new Error("夹具会话读取失败");
  return { ctx, entries: result.entries, ended: result.ended };
}

async function loadRunningRecord() {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  manager.appendMessage(userMessage("运行中任务"));
  manager.appendMessage(
    assistantMessage([{ type: "toolCall", id: "call-run", name: "bash", arguments: { command: "ls" } }], "toolUse"),
  );
  const result = readTranscript(ctx);
  if (!result.ok) throw new Error("夹具会话读取失败");
  return { ctx, entries: result.entries, ended: result.ended };
}

async function loadSimpleRecord() {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  manager.appendMessage(userMessage("本地一"));
  manager.appendMessage(userMessage("本地二"));
  manager.appendMessage(userMessage("本地三"));
  const result = readTranscript(ctx);
  if (!result.ok) throw new Error("夹具会话读取失败");
  return { ctx, entries: result.entries };
}

async function loadThrowingRecord() {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  manager.appendMessage(userMessage("正常消息"));
  const malformed = {
    type: "message",
    id: randomUUID(),
    parentId: null,
    message: { role: "user", content: null, timestamp: Date.now() },
  };
  withDatabase(repositoryDatabase(ctx.dataRoot, ctx.repoId), (db) => db.append(`session:${ctx.runId}`, malformed));
  return ctx;
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildTextEntries(view: TranscriptView, count: number): void {
  for (let i = 1; i <= count; i++) {
    view.appendDelta({ runId: "run-1", seq: i, kind: "text", summary: `line${i}` });
  }
}

function fullLines(count: number, width: number): string[] {
  const probe = new TranscriptView({});
  buildTextEntries(probe, count);
  probe.resize(width, count * 4 + 10);
  return probe.render(width).slice(0, -1);
}

function createFakeCtx(terminal: { rows: number; columns: number } = { rows: 20, columns: 80 }) {
  let options: Record<string, unknown> | undefined;
  let component: TranscriptView | undefined;
  let callCount = 0;
  let tuiRequestRenderCalls = 0;
  let doneCallCount = 0;
  const notifyCalls: Array<{ message: string; level?: string }> = [];
  return {
    ctx: {
      ui: {
        custom: (
          factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
          opts?: Record<string, unknown>,
        ) => {
          callCount += 1;
          options = opts;
          return new Promise((resolve) => {
            const done = (result: unknown) => {
              doneCallCount += 1;
              resolve(result);
            };
            // 生产 tui 接线断言的正是这个对象：宿主真实终端尺寸经它传给工厂
            const fakeTui = {
              requestRender: () => {
                tuiRequestRenderCalls += 1;
              },
              terminal,
            };
            component = factory(fakeTui, {}, {}, done) as TranscriptView;
          });
        },
        notify: (message: string, level?: string) => notifyCalls.push({ message, level }),
      },
    },
    getOptions: () => options,
    getComponent: () => component,
    getCallCount: () => callCount,
    getNotifyCalls: () => notifyCalls,
    getTuiRequestRenderCalls: () => tuiRequestRenderCalls,
    getDoneCallCount: () => doneCallCount,
  };
}

function createRejectingFakeCtx(error: Error) {
  let component: TranscriptView | undefined;
  return {
    ctx: {
      ui: {
        custom: (
          factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
        ) => {
          component = factory({ requestRender: () => {} }, {}, {}, () => {}) as TranscriptView;
          return Promise.reject(error);
        },
        notify: () => {},
      },
    },
    getComponent: () => component,
  };
}

function createFakeClient(overrides: { subscribeResult?: Record<string, unknown> } = {}) {
  const callLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  let listener: ((data: unknown) => void) | undefined;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let stateValue: { status: "connected" | "unreachable" } = { status: "connected" };
  return {
    client: {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        callLog.push({ method, params });
        if (method === "subscribe.transcript") return overrides.subscribeResult ?? { entries: [], ended: false };
        return {};
      },
      subscribe: (event: string, fn: (data: unknown) => void) => {
        subscribeCount += 1;
        if (event === "transcript") listener = fn;
        return () => {
          unsubscribeCount += 1;
        };
      },
      state: () => stateValue,
    },
    callLog,
    getListener: () => listener,
    getSubscribeCount: () => subscribeCount,
    getUnsubscribeCount: () => unsubscribeCount,
    setState: (value: { status: "connected" | "unreachable" }) => {
      stateValue = value;
    },
  };
}

function createFakeDock() {
  let openCount = 0;
  let closedCount = 0;
  return {
    dock: {
      markPageOpen: () => {
        openCount += 1;
      },
      markPageClosed: () => {
        closedCount += 1;
      },
    },
    getOpenCount: () => openCount,
    getClosedCount: () => closedCount,
  };
}

describe("TranscriptView 折行与文本清洗", () => {
  test("60 个 ASCII 字符在宽度 20 下折成 3 行，拼接等于原文且无 ESC", () => {
    const original = "A".repeat(60);
    const view = new TranscriptView({});
    view.resize(20, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: original });

    const rendered = view.render(20);
    const content = rendered.slice(1, -1);
    expect(content.length).toBe(3);
    expect(content.join("")).toBe(original);
    expect(rendered.join("")).not.toContain("\x1b");
  });

  test("60 个汉字在宽度 20 下折成 6 行，拼接等于原文且无 ESC", () => {
    const original = "汉".repeat(60);
    const view = new TranscriptView({});
    view.resize(20, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: original });

    const rendered = view.render(20);
    const content = rendered.slice(1, -1);
    expect(content.length).toBe(6);
    expect(content.join("")).toBe(original);
    expect(rendered.join("")).not.toContain("\x1b");
  });

  test("宽度为 1 时逐字符折行不丢字且不含 ESC", () => {
    const original = "ABCDE";
    const view = new TranscriptView({});
    view.resize(1, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: original });

    const rendered = view.render(1);
    const content = rendered.slice(1, -1);
    expect(content.length).toBe(5);
    expect(content.join("")).toBe(original);
    expect(rendered.join("")).not.toContain("\x1b");
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(1);
  });

  test("\\r\\n 归一为换行、裸 \\r 剥除、\\t 展开为空格，且每行宽度不超限", () => {
    const view = new TranscriptView({});
    view.resize(40, 10);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: "第一行\r\n第二行\r裸回车\t制表符后" });

    const rendered = view.render(40);
    const joined = rendered.join("\n");
    expect(joined).not.toContain("\r");
    expect(joined).not.toContain("\t");
    expect(joined).toContain("第一行");
    expect(joined).toContain("第二行");
    expect(joined).toContain("裸回车");
    expect(joined).toContain("制表符后");
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("TranscriptView 条目显示与合并", () => {
  test("跨多次 delta 的思考与文本合并为单条目，按序号顺序显示且标记可区分", () => {
    const view = new TranscriptView({});
    view.resize(80, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "thinking", delta: "先" });
    view.appendDelta({ runId: "r1", seq: 1, kind: "thinking", delta: "看看" });
    view.appendDelta({ runId: "r1", seq: 1, kind: "thinking", delta: "现状" });
    view.appendDelta({ runId: "r1", seq: 2, kind: "text", delta: "看结果" });
    view.appendDelta({ runId: "r1", seq: 2, kind: "text", delta: "后继续" });

    const lines = view.render(80).slice(0, -1);
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain("先看看现状");
    expect(lines[3]).toContain("看结果后继续");
    expect(lines[0]).not.toBe(lines[2]);
  });

  test("工具调用显示工具名称，工具结果显示结果摘要", () => {
    const view = new TranscriptView({});
    view.resize(80, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "toolcall", summary: "bash" });
    view.appendDelta({ runId: "r1", seq: 2, kind: "tool_result", summary: "ok" });

    const lines = view.render(80).slice(0, -1);
    expect(lines.some((line) => line.includes("bash"))).toBe(true);
    expect(lines.some((line) => line.includes("ok"))).toBe(true);
  });
});

describe("TranscriptView 只读展示与安全", () => {
  test("工具结果中的凭据样式文本与独立标记文本原样保留", () => {
    const view = new TranscriptView({});
    view.resize(120, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "tool_result", summary: "Authorization: Bearer abc123\nMARKER-XYZ" });

    const content = view.render(120).slice(0, -1).join("\n");
    expect(content).toContain("Bearer abc123");
    expect(content).toContain("MARKER-XYZ");
  });

  test("ESC/C0/C1 控制字符不透传到终端输出", () => {
    const view = new TranscriptView({});
    view.resize(120, 20);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: "before\x1b[31mred\x07after" });

    const content = view.render(120).slice(0, -1).join("\n");
    expect(content).toContain("before");
    expect(content).toContain("red");
    expect(content).toContain("after");
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content)).toBe(false);
  });

  test("输入普通字符与 Enter 都不消费且不改变渲染", () => {
    const view = new TranscriptView({});
    view.resize(80, 10);
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: "hello" });
    const before = view.render(80);

    const consumedChar = view.handleInput("x");
    const consumedEnter = view.handleInput(KEY.enter);
    const after = view.render(80);

    expect(consumedChar).toBe(false);
    expect(consumedEnter).toBe(false);
    expect(after).toEqual(before);
  });
});

describe("TranscriptView 视口滚动与跟随（视口尺寸取自 resize）", () => {
  test("打开时视口在底部并跟随最新", () => {
    const width = 80;
    const height = 4;
    const count = 10;
    const all = fullLines(count, width);
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    expect(view.render(width).slice(0, -1)).toEqual(all.slice(-height));
  });

  test("↑ 多次后停止跟随，新增内容不移动视口窗口", () => {
    const width = 80;
    const height = 4;
    const count = 10;
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    view.handleInput(KEY.up);
    view.handleInput(KEY.up);
    const consumed = view.handleInput(KEY.up);
    expect(consumed).toBe(true);

    const before = view.render(width).slice(0, -1);
    view.appendDelta({ runId: "run-1", seq: count + 1, kind: "text", summary: `line${count + 1}` });
    const after = view.render(width).slice(0, -1);

    expect(after).toEqual(before);
  });

  test("End 后恢复跟随并回到底部", () => {
    const width = 80;
    const height = 4;
    const count = 11;
    const all = fullLines(count, width);
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    view.handleInput(KEY.up);
    view.handleInput(KEY.up);
    view.handleInput(KEY.up);
    const consumed = view.handleInput(KEY.end);
    expect(consumed).toBe(true);

    expect(view.render(width).slice(0, -1)).toEqual(all.slice(-height));
  });

  test("PgUp 按视口高度整页上移，PgDn 整页下移回到原位置", () => {
    const width = 80;
    const height = 4;
    const count = 11;
    const all = fullLines(count, width);
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    const bottom = view.render(width).slice(0, -1);
    expect(bottom).toEqual(all.slice(-height));

    const consumedUp = view.handleInput(KEY.pageUp);
    expect(consumedUp).toBe(true);
    expect(view.render(width).slice(0, -1)).toEqual(all.slice(-height * 2, -height));

    const consumedDown = view.handleInput(KEY.pageDown);
    expect(consumedDown).toBe(true);
    expect(view.render(width).slice(0, -1)).toEqual(bottom);
  });

  test("超过视口高度时可持续上滚到最早条目并被夹住", () => {
    const width = 80;
    const height = 4;
    const count = 10;
    const all = fullLines(count, width);
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    for (let i = 0; i < 50; i++) view.handleInput(KEY.up);

    expect(view.render(width).slice(0, -1)).toEqual(all.slice(0, height));
  });

  test("Kitty 释放事件被丢弃，不移动视口也不被消费", () => {
    const width = 80;
    const height = 4;
    const count = 10;
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);
    const before = view.render(width).slice(0, -1);

    const consumed = view.handleInput(KEY.upKittyRelease);

    expect(consumed).toBe(false);
    expect(view.render(width).slice(0, -1)).toEqual(before);
  });

  test("视口高度取自宿主 resize：24 行时内容行数按 24 计", () => {
    const width = 80;
    const height = 24;
    const count = 30;
    const view = new TranscriptView({});
    buildTextEntries(view, count);
    view.resize(width, height);

    expect(view.render(width).slice(0, -1).length).toBe(height);
  });
});

describe("TranscriptView 运行状态标注", () => {
  test("运行中状态显示运行中标记", () => {
    const view = new TranscriptView({});
    view.resize(80, 5);
    view.setStatus("running");
    const rendered = view.render(80);
    expect(rendered[rendered.length - 1]).toContain("运行中");
  });

  test("已结束运行通过 loadFromRecord 显示本机记录并标注已结束", async () => {
    const { entries, ended } = await loadEndedRecord();
    expect(ended).toBe(true);

    const view = new TranscriptView({});
    view.resize(120, 20);
    view.loadFromRecord(entries);
    view.setStatus(ended ? "ended" : "unreachable");

    const rendered = view.render(120);
    const content = rendered.slice(0, -1).join("\n");
    expect(content).toContain("先看看现状");
    expect(content).toContain("完成");
    expect(rendered[rendered.length - 1]).toContain("已结束");
    expect(rendered[rendered.length - 1]).not.toContain("运行中");
  });

  test("订阅中断后标注不可达且保留已显示内容", () => {
    const view = new TranscriptView({});
    view.resize(80, 10);
    view.setStatus("running");
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: "重要内容" });

    view.setStatus("unreachable");
    const rendered = view.render(80);

    expect(rendered[rendered.length - 1]).toContain("不可达");
    expect(rendered[rendered.length - 1]).not.toContain("运行中");
    expect(rendered.slice(0, -1).join("\n")).toContain("重要内容");
  });

  test("本地记录不可读状态显示记录不可读标记", () => {
    const view = new TranscriptView({});
    view.resize(80, 5);
    view.setStatus("unreadable");
    const rendered = view.render(80);
    expect(rendered[rendered.length - 1]).toContain("记录不可读");
  });
});

describe("TranscriptView 请求重绘", () => {
  test("appendDelta/setStatus/invalidate 后都调用宿主 tui.requestRender", () => {
    let count = 0;
    const view = new TranscriptView({ tui: { requestRender: () => { count += 1; } } });
    view.resize(80, 5);

    const beforeAppend = count;
    view.appendDelta({ runId: "r1", seq: 1, kind: "text", summary: "hi" });
    expect(count).toBeGreaterThan(beforeAppend);

    const beforeStatus = count;
    view.setStatus("ended");
    expect(count).toBeGreaterThan(beforeStatus);

    const beforeInvalidate = count;
    view.invalidate();
    expect(count).toBeGreaterThan(beforeInvalidate);
  });
});

describe("openTranscriptView 顺序与实时更新", () => {
  test("先加载本地记录再订阅：subscribe.transcript 携带本地记录末尾序号", async () => {
    const { ctx, entries } = await loadRunningRecord();
    const lastSeq = entries[entries.length - 1]!.seq;
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const restoreCalls: string[] = [];

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: (runId: string) => restoreCalls.push(runId),
    });

    await waitFor(() => fakeClient.callLog.some((entry) => entry.method === "subscribe.transcript"));
    const subscribeCall = fakeClient.callLog.find((entry) => entry.method === "subscribe.transcript");
    expect(subscribeCall?.params.runId).toBe(ctx.runId);
    expect(subscribeCall?.params.fromSeq).toBe(lastSeq);

    await waitFor(() => fakeCtx.getComponent() !== undefined);
    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;

    expect(fakeDock.getOpenCount()).toBe(1);
    expect(fakeDock.getClosedCount()).toBe(1);
    expect(restoreCalls).toEqual([ctx.runId]);
  });

  test("订阅回调按 runId 过滤：只有匹配的 runId 事件才追加显示", async () => {
    const { ctx } = await loadRunningRecord();
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeClient.getListener() !== undefined);

    fakeClient.getListener()!({ runId: ctx.runId, seq: 9001, kind: "text", delta: "本次事件专属标记" });
    fakeClient.getListener()!({ runId: "other-run-id", seq: 9002, kind: "text", delta: "不应显示的标记" });

    await waitFor(() => fakeCtx.getComponent()!.render(80).join("\n").includes("本次事件专属标记"));
    const content = fakeCtx.getComponent()!.render(80).join("\n");
    expect(content).not.toContain("不应显示的标记");

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });

  test("订阅结果携带的历史条目按 seq 与本地记录去重", async () => {
    const { ctx } = await loadSimpleRecord();
    const fakeClient = createFakeClient({
      subscribeResult: {
        ended: false,
        entries: [
          { seq: 2, kind: "text", summary: "远程二" },
          { seq: 3, kind: "text", summary: "远程三" },
          { seq: 4, kind: "text", summary: "远程四" },
        ],
      },
    });
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });

    await waitFor(() => (fakeCtx.getComponent()?.render(80).join("\n") ?? "").includes("远程四"));
    const content = fakeCtx.getComponent()!.render(80).join("\n");
    expect(content).toContain("本地二");
    expect(content).toContain("本地三");
    expect(content).toContain("远程四");
    expect(content).not.toContain("远程二");
    expect(content).not.toContain("远程三");

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });
});

describe("openTranscriptView 状态分支", () => {
  test("本地记录已结束时标注已结束", async () => {
    const { ctx } = await loadEndedRecord();
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const rendered = fakeCtx.getComponent()!.render(80);
    expect(rendered[rendered.length - 1]).toContain("已结束");

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });

  test("client.state() 变为 unreachable 且时钟推进 1 秒后标注不可达，保留已展示内容", async () => {
    const { ctx } = await loadRunningRecord();
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const fakeClient = createFakeClient();

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const beforeContent = fakeCtx.getComponent()!.render(80).slice(0, -1).join("\n");
    expect(beforeContent).toContain("运行中任务");

    fakeClient.setState({ status: "unreachable" });
    timeSource.advance(1_000);

    const rendered = fakeCtx.getComponent()!.render(80);
    expect(rendered[rendered.length - 1]).toContain("不可达");
    expect(rendered.slice(0, -1).join("\n")).toContain("运行中任务");

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });

  test("本地记录缺失时标注记录不可读并通知，不显示运行中", async () => {
    const ctx = await makeRunContext();
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const fakeClient = createFakeClient();

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const rendered = fakeCtx.getComponent()!.render(80);
    expect(rendered[rendered.length - 1]).toContain("记录不可读");
    expect(rendered[rendered.length - 1]).not.toContain("运行中");
    expect(fakeCtx.getNotifyCalls().length).toBeGreaterThan(0);

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });
});

describe("openTranscriptView 已结束为终态", () => {
  test("本地记录已结束时不发起订阅、不启动状态轮询，且订阅被拒绝或 state() 显示不可达也仍标已结束", async () => {
    const { ctx } = await loadEndedRecord();
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let stateCalls = 0;
    let subscribeTranscriptCalled = 0;
    let localSubscribeCalled = 0;

    const fakeClient = {
      call: async (method: string) => {
        if (method === "subscribe.transcript") {
          subscribeTranscriptCalled += 1;
          throw new Error("不应对已结束会话发起订阅（测试注入）");
        }
        return {};
      },
      subscribe: (_event: string, _fn: (data: unknown) => void) => {
        localSubscribeCalled += 1;
        return () => {};
      },
      state: () => {
        stateCalls += 1;
        return { status: "unreachable" as const };
      },
    };

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const rendered = fakeCtx.getComponent()!.render(80);
    expect(rendered[rendered.length - 1]).toContain("已结束");

    timeSource.advance(1_000);
    const afterTick = fakeCtx.getComponent()!.render(80);
    expect(afterTick[afterTick.length - 1]).toContain("已结束");
    expect(afterTick[afterTick.length - 1]).not.toContain("不可达");

    expect(subscribeTranscriptCalled).toBe(0);
    expect(localSubscribeCalled).toBe(0);
    expect(stateCalls).toBe(0);

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });
});

describe("openTranscriptView 宿主 tui 接线", () => {
  test("视图高度取自宿主 tui.terminal.rows：rows=10 时渲染行数不超过 10", async () => {
    const ctx = await makeRunContext();
    const fakeCtx = createFakeCtx({ rows: 10, columns: 80 });
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const view = fakeCtx.getComponent()!;
    for (let i = 0; i < 30; i++) view.appendDelta({ runId: ctx.runId, seq: 10_000 + i, kind: "text", summary: `补充第${i}行` });

    // 预算 = min(自然行数, max(5, ⌊rows/2⌋)) = min(自然行数, max(5,5)) = 5
    expect(view.render(80).length).toBeLessThanOrEqual(5);

    view.handleInput(KEY.escape);
    await openPromise;
  });

  test("内容行数少于预算时按自然行数渲染，不补齐：rows=40 且只有 3 行内容时渲染 4 行（3 内容 + 1 状态）", async () => {
    const ctx = await makeRunContext();
    const fakeCtx = createFakeCtx({ rows: 40, columns: 80 });
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const view = fakeCtx.getComponent()!;
    // 单条目：标签 1 行 + 折成 2 行的正文（100 个 'B' 在 80 列下折 2 行）= 3 行内容
    view.appendDelta({ runId: ctx.runId, seq: 40_000, kind: "text", summary: "B".repeat(100) });

    // 预算 = min(4, max(5, ⌊40/2⌋)) = min(4, 20) = 4；不足预算不补齐
    expect(view.render(80).length).toBe(4);

    view.handleInput(KEY.escape);
    await openPromise;
  });

  test("增量到达后调用宿主 tui.requestRender（生产 tui 对象，而非内部占位对象）", async () => {
    const ctx = await makeRunContext();
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const before = fakeCtx.getTuiRequestRenderCalls();
    fakeCtx.getComponent()!.appendDelta({ runId: ctx.runId, seq: 20_000, kind: "text", summary: "新增内容" });
    expect(fakeCtx.getTuiRequestRenderCalls()).toBeGreaterThan(before);

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });

  test("滚动上界与渲染共用同一宽度：terminal.columns=40 时按折行后的行数滚动，而非按 80 列判定不能滚", async () => {
    const ctx = await makeRunContext();
    const fakeCtx = createFakeCtx({ rows: 20, columns: 40 });
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);
    const view = fakeCtx.getComponent()!;

    const longText = "A".repeat(1000);
    view.appendDelta({ runId: ctx.runId, seq: 30_000, kind: "text", summary: longText });

    // 探针视口取得足够高，拿到 40 列折行后的全部行；预算 = min(自然行数, max(5, ⌊20/2⌋)) = min(自然行数,10)，内容占预算减一
    const probe = new TranscriptView({});
    probe.resize(40, 200);
    probe.appendDelta({ runId: ctx.runId, seq: 30_000, kind: "text", summary: longText });
    const allAt40 = probe.render(40).slice(0, -1);
    const contentRows = 10 - 1;

    const bottom = view.render(40).slice(0, -1);
    expect(bottom).toEqual(allAt40.slice(-contentRows));

    view.handleInput(KEY.up);
    const afterOneUp = view.render(40).slice(0, -1);
    expect(afterOneUp).toEqual(allAt40.slice(-contentRows - 1, -1));

    view.handleInput(KEY.end);
    view.handleInput(KEY.escape);
    await openPromise;
  });

  test("尺寸单一真相：折行与滚动按 render 实际传入的插槽宽度而非 tui.terminal.columns（整屏列数）", async () => {
    const ctx = await makeRunContext();
    // 整屏 40 列，但宿主把组件渲染在更窄的 30 列插槽里——尺寸的唯一真相应是 render(width) 的实参
    const fakeCtx = createFakeCtx({ rows: 20, columns: 40 });
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);
    const view = fakeCtx.getComponent()!;

    const slotWidth = 30;
    const longText = "A".repeat(1000);
    view.appendDelta({ runId: ctx.runId, seq: 50_000, kind: "text", summary: longText });

    const probe = new TranscriptView({});
    probe.resize(slotWidth, 10000);
    probe.appendDelta({ runId: ctx.runId, seq: 50_000, kind: "text", summary: longText });
    const allAtSlotWidth = probe.render(slotWidth).slice(0, -1);
    const contentRows = 10 - 1;

    const bottom = view.render(slotWidth).slice(0, -1);
    expect(bottom).toEqual(allAtSlotWidth.slice(-contentRows));

    view.handleInput(KEY.up);
    const afterOneUp = view.render(slotWidth).slice(0, -1);
    expect(afterOneUp).toEqual(allAtSlotWidth.slice(-contentRows - 1, -1));

    view.handleInput(KEY.end);
    view.handleInput(KEY.escape);
    await openPromise;
  });
});

describe("openTranscriptView openRunIds 不泄漏", () => {
  test("readTranscript 抛出时首次打开标记录不可读并通知，且不泄漏 open 状态使同一 runId 可再次打开", async () => {
    const ctx = await loadThrowingRecord();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const fakeCtx1 = createFakeCtx();
    const fakeClient1 = createFakeClient();
    const first = openTranscriptView({
      ctx: fakeCtx1.ctx,
      client: fakeClient1.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    first.catch(() => {});

    await waitFor(() => fakeCtx1.getComponent() !== undefined);
    const rendered = fakeCtx1.getComponent()!.render(80);
    expect(rendered[rendered.length - 1]).toContain("记录不可读");
    expect(fakeCtx1.getNotifyCalls().length).toBeGreaterThan(0);

    fakeCtx1.getComponent()!.handleInput(KEY.escape);
    await first;

    const fakeCtx2 = createFakeCtx();
    const fakeClient2 = createFakeClient();
    const second = openTranscriptView({
      ctx: fakeCtx2.ctx,
      client: fakeClient2.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    second.catch(() => {});

    await waitFor(() => fakeCtx2.getComponent() !== undefined);
    expect(fakeCtx2.getComponent()).toBeInstanceOf(TranscriptView);

    fakeCtx2.getComponent()!.handleInput(KEY.escape);
    await second;
  });
});

describe("openTranscriptView 单页限制", () => {
  test("不同 runId 的第二次打开在第一页未关闭时被拒绝，关闭后可再次打开", async () => {
    const { ctx: ctx1 } = await loadEndedRecord();
    const { ctx: ctx2 } = await loadEndedRecord();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const fakeCtx1 = createFakeCtx();
    const fakeClient1 = createFakeClient();
    const first = openTranscriptView({
      ctx: fakeCtx1.ctx,
      client: fakeClient1.client,
      clock,
      runId: ctx1.runId,
      dataRoot: ctx1.dataRoot,
      repoId: ctx1.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx1.getComponent() !== undefined);

    const fakeCtx2 = createFakeCtx();
    const fakeClient2 = createFakeClient();
    const second = openTranscriptView({
      ctx: fakeCtx2.ctx,
      client: fakeClient2.client,
      clock,
      runId: ctx2.runId,
      dataRoot: ctx2.dataRoot,
      repoId: ctx2.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    second.catch(() => {});
    // 不直接 await second：若第二页被误打开会一直挂着等 Esc，用结算窗口代替，收尾时再主动关闭
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fakeCtx2.getCallCount()).toBe(0);

    fakeCtx2.getComponent()?.handleInput(KEY.escape);
    fakeCtx1.getComponent()!.handleInput(KEY.escape);
    await Promise.race([Promise.all([first, second]), new Promise((resolve) => setTimeout(resolve, 300))]);

    expect(fakeDock.getClosedCount()).toBeGreaterThanOrEqual(1);

    const fakeCtx3 = createFakeCtx();
    const fakeClient3 = createFakeClient();
    const third = openTranscriptView({
      ctx: fakeCtx3.ctx,
      client: fakeClient3.client,
      clock,
      runId: ctx2.runId,
      dataRoot: ctx2.dataRoot,
      repoId: ctx2.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });
    await waitFor(() => fakeCtx3.getComponent() !== undefined);
    expect(fakeCtx3.getComponent()).toBeInstanceOf(TranscriptView);

    fakeCtx3.getComponent()!.handleInput(KEY.escape);
    await third;
  });
});

describe("closeActiveTranscriptView 幂等", () => {
  test("Esc 已置关闭状态、finally 仍在等待 unsubscribe 期间再次调用 closeActiveTranscriptView：done 只被调用一次", async () => {
    const { ctx } = await loadRunningRecord();
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const deferredUnsubscribe = createDeferred<Record<string, unknown>>();
    let unsubscribeCallCount = 0;

    const fakeClient = {
      call: async (method: string) => {
        if (method === "subscribe.transcript") return { subscriptionId: "sub-1", entries: [], ended: false };
        if (method === "unsubscribe") {
          unsubscribeCallCount += 1;
          return deferredUnsubscribe.promise;
        }
        return {};
      },
      subscribe: (_event: string, _fn: (data: unknown) => void) => () => {},
      state: () => ({ status: "connected" as const }),
    };

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });

    await waitFor(() => fakeCtx.getComponent() !== undefined);
    fakeCtx.getComponent()!.handleInput(KEY.escape);

    // Esc 触发后 finally 会走到 client.call("unsubscribe", ...)；用延迟兑现的假实现制造"仍在收尾"的窗口。
    // 断言可能中途失败，但 deferredUnsubscribe 必须被兑现、openPromise 必须被等到，否则模块级的单页在途状态会卡住后续用例
    try {
      await waitFor(() => unsubscribeCallCount === 1);
      expect(fakeCtx.getDoneCallCount()).toBe(1);

      closeActiveTranscriptView();
      expect(fakeCtx.getDoneCallCount()).toBe(1);
    } finally {
      deferredUnsubscribe.resolve({});
      await openPromise;
    }
    expect(fakeCtx.getDoneCallCount()).toBe(1);
  });
});

describe("openTranscriptView 关闭链路与竞态", () => {
  test("Esc 早于 subscribe.transcript 兑现：不留下未匹配的监听，restoreSelection 仍执行", async () => {
    const { ctx } = await loadRunningRecord();
    const fakeCtx = createFakeCtx();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const deferredSubscribe = createDeferred<Record<string, unknown>>();
    const restoreCalls: string[] = [];
    let subscribeLocalCalled = 0;
    let unsubscribeCalled = 0;

    const fakeClient = {
      call: async (method: string) => {
        if (method === "subscribe.transcript") return deferredSubscribe.promise;
        return {};
      },
      subscribe: (_event: string, _fn: (data: unknown) => void) => {
        subscribeLocalCalled += 1;
        return () => {
          unsubscribeCalled += 1;
        };
      },
      state: () => ({ status: "connected" as const }),
    };

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: (runId: string) => restoreCalls.push(runId),
    });

    await waitFor(() => fakeCtx.getComponent() !== undefined);
    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;

    expect(restoreCalls).toEqual([ctx.runId]);
    expect(fakeDock.getClosedCount()).toBe(1);

    deferredSubscribe.resolve({ entries: [], ended: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(subscribeLocalCalled).toBe(unsubscribeCalled);
  });

  test("ctx.ui.custom 被拒绝时仍执行 dock.markPageClosed 与 restoreSelection", async () => {
    const { ctx } = await loadEndedRecord();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const fakeClient = createFakeClient();
    const restoreCalls: string[] = [];
    const fakeCtx = createRejectingFakeCtx(new Error("宿主渲染失败（测试注入）"));

    await expect(
      openTranscriptView({
        ctx: fakeCtx.ctx,
        client: fakeClient.client,
        clock,
        runId: ctx.runId,
        dataRoot: ctx.dataRoot,
        repoId: ctx.repoId,
        dock: fakeDock.dock,
        restoreSelection: (runId: string) => restoreCalls.push(runId),
      }),
    ).rejects.toThrow();

    expect(fakeDock.getClosedCount()).toBe(1);
    expect(restoreCalls).toEqual([ctx.runId]);
  });
});

describe("openTranscriptView 幂等", () => {
  test("同一 runId 二次打开被忽略：ctx.ui.custom 只调用一次", async () => {
    const { ctx } = await loadEndedRecord();
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });
    const restoreCalls: string[] = [];

    const first = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: (runId: string) => restoreCalls.push(runId),
    });
    await waitFor(() => fakeCtx.getComponent() !== undefined);

    const second = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: (runId: string) => restoreCalls.push(runId),
    });
    await second;

    expect(fakeCtx.getCallCount()).toBe(1);

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await first;
  });
});

describe("openTranscriptView 展示方式", () => {
  test("ctx.ui.custom 以非浮层方式展示 TranscriptView 组件", async () => {
    const { ctx } = await loadEndedRecord();
    const fakeCtx = createFakeCtx();
    const fakeClient = createFakeClient();
    const fakeDock = createFakeDock();
    const clock = createClock({ timeSource: createFakeTimeSource() });

    const openPromise = openTranscriptView({
      ctx: fakeCtx.ctx,
      client: fakeClient.client,
      clock,
      runId: ctx.runId,
      dataRoot: ctx.dataRoot,
      repoId: ctx.repoId,
      dock: fakeDock.dock,
      restoreSelection: () => {},
    });

    await waitFor(() => fakeCtx.getComponent() !== undefined);
    expect(fakeCtx.getComponent()).toBeInstanceOf(TranscriptView);
    expect(fakeCtx.getOptions()?.overlay).toBeFalsy();

    fakeCtx.getComponent()!.handleInput(KEY.escape);
    await openPromise;
  });
});
