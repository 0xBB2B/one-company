import { withDatabase, putRecord, uuidv7 } from "../runtime/database.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "../daemon/relay-queue.ts";
import type { RelayWindow, RelayDeliverFn, RelayLocateRequirementAgentFn } from "../daemon/relay-queue.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-relay-queue-"));
  tempDirs.push(dir);
  return dir;
}

interface DeliverCall {
  event: string;
  payload: Record<string, unknown>;
  options: { repoId: string; excludeWindowId?: string };
}

function makeDeliveryStub(roster: Record<string, string[]>): { deliver: RelayDeliverFn; calls: DeliverCall[] } {
  const calls: DeliverCall[] = [];
  const deliver: RelayDeliverFn = async (event, payload, options) => {
    calls.push({ event, payload, options });
    const online = roster[options.repoId] ?? [];
    return online.filter((windowId) => windowId !== options.excludeWindowId);
  };
  return { deliver, calls };
}

function makeFailingDeliver(): RelayDeliverFn {
  return async () => {
    throw new Error("投递系统不可达");
  };
}

function makeSequenceClock(startIso: string): { now(): string } {
  let cursor = Date.parse(startIso);
  return {
    now: () => {
      const value = new Date(cursor).toISOString();
      cursor += 1_000;
      return value;
    },
  };
}

function windowStub(overrides: Partial<RelayWindow> = {}): RelayWindow {
  return { windowId: "win-a", repoIds: ["repo-a"], ...overrides };
}

interface FakeRequirementAgent {
  runId: string;
  injectCalls: string[];
  inject(message: string): void;
}

function makeRequirementAgent(runId: string): FakeRequirementAgent {
  const injectCalls: string[] = [];
  return { runId, injectCalls, inject: (message: string) => injectCalls.push(message) };
}

function makeLocator(agents: Record<string, FakeRequirementAgent>): RelayLocateRequirementAgentFn {
  return (requirement: string) => agents[requirement];
}

function readRelayRecords<T>(dataDir: string, namespace: string): T[] {
  return withDatabase(join(dataDir, "data.db"), (db) => db.list<T>(namespace).map((row) => row.data));
}

async function makeQueue(options: {
  dataDir?: string;
  deliver?: RelayDeliverFn;
  locateRequirementAgent?: RelayLocateRequirementAgentFn;
  clock?: { now(): string };
} = {}): Promise<{ queue: RelayQueue; dataDir: string }> {
  const dataDir = options.dataDir ?? (await makeDataDir());
  const deliver = options.deliver ?? makeDeliveryStub({}).deliver;
  const locateRequirementAgent = options.locateRequirementAgent ?? (() => undefined);
  const queue = new RelayQueue({ dataDir, deliver, locateRequirementAgent, clock: options.clock });
  return { queue, dataDir };
}

function askInput(overrides: Record<string, unknown> = {}) {
  return {
    requirement: "2026-09-09.relay-queue-demo",
    repoId: "repo-a",
    runId: "run-1",
    question: "接口错误码用 A 还是 B？",
    options: [
      { label: "A", description: "方案 A" },
      { label: "B", description: "方案 B" },
    ],
    recommended: "A",
    ...overrides,
  };
}

function notifyInput(overrides: Record<string, unknown> = {}) {
  return {
    requirement: "2026-09-09.relay-queue-demo",
    repoId: "repo-a",
    runId: "run-1",
    kind: "completed",
    message: "需求已完成",
    ...overrides,
  };
}

describe("提问广播与撤回", () => {
  test("提问按 repoId 广播一次，载荷含 options/recommended 且不含内部字段 status", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a", "win-b"], "repo-x": ["win-out"] });
    const { queue } = await makeQueue({ deliver });

    const handle = await queue.ask(askInput());

    const questionCalls = calls.filter((call) => call.event === "relay.question");
    expect(questionCalls.length).toBe(1);
    const call = questionCalls[0]!;
    expect(call.options.repoId).toBe("repo-a");
    expect(call.options.excludeWindowId).toBeUndefined();
    expect(call.payload.id).toBe(handle.id);
    expect(call.payload.requirement).toBe("2026-09-09.relay-queue-demo");
    expect(call.payload.options).toEqual([
      { label: "A", description: "方案 A" },
      { label: "B", description: "方案 B" },
    ]);
    expect(call.payload.recommended).toBe("A");
    expect(Object.hasOwn(call.payload, "status")).toBe(false);
  });

  test("首答生效：作答触发向同仓库其它窗口的撤回广播且排除作答窗口，句柄兑现已答", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a", "win-b"] });
    const { queue } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());

    const result = await queue.answer(handle.id, "A", "win-a");
    expect(result.ok).toBe(true);

    const withdrawCalls = calls.filter((call) => call.event === "relay.withdraw");
    expect(withdrawCalls.length).toBe(1);
    expect(withdrawCalls[0]?.options.repoId).toBe("repo-a");
    expect(withdrawCalls[0]?.options.excludeWindowId).toBe("win-a");
    expect(withdrawCalls[0]?.payload.questionId).toBe(handle.id);

    await expect(handle.answer).resolves.toEqual({ answered: true, answer: "A" });
  });

  test("第二次作答返回已答，不再重复广播撤回", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a", "win-b"] });
    const { queue } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());
    await queue.answer(handle.id, "A", "win-a");
    const withdrawCountBefore = calls.filter((call) => call.event === "relay.withdraw").length;

    const second = await queue.answer(handle.id, "B", "win-b");

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_answered");
    expect(calls.filter((call) => call.event === "relay.withdraw").length).toBe(withdrawCountBefore);
  });

  test("未知 questionId 作答返回未找到，不抛出", async () => {
    const { queue } = await makeQueue();
    const result = await queue.answer("not-a-real-id", "A", "win-a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  test("作答后 pendingFor 不再包含该问题", async () => {
    const { deliver } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());
    await queue.answer(handle.id, "A", "win-a");

    const pending = await queue.pendingFor(windowStub({ windowId: "win-b" }));

    expect(pending.questions.map((q) => q.id)).not.toContain(handle.id);
  });

  test("运行停止时显式 withdraw：广播给同仓库窗口且不排除任何窗口，pendingFor 不再含该问题", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());
    calls.length = 0;

    await queue.withdraw(handle.id);

    const withdrawCalls = calls.filter((call) => call.event === "relay.withdraw");
    expect(withdrawCalls.length).toBe(1);
    expect(withdrawCalls[0]?.options.excludeWindowId).toBeUndefined();
    expect(withdrawCalls[0]?.payload.questionId).toBe(handle.id);

    const pending = await queue.pendingFor(windowStub());
    expect(pending.questions.map((q) => q.id)).not.toContain(handle.id);
  });

  test("尚未作答时被显式撤回，ask 句柄兑现 answered:false withdrawn", async () => {
    const { queue } = await makeQueue();
    const handle = await queue.ask(askInput());

    await queue.withdraw(handle.id);

    await expect(handle.answer).resolves.toEqual({ answered: false, reason: "withdrawn" });
  });

  test("已撤回的问题不能再作答", async () => {
    const { queue } = await makeQueue();
    const handle = await queue.ask(askInput());
    await queue.withdraw(handle.id);

    const result = await queue.answer(handle.id, "A", "win-a");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("withdrawn");
  });

  test("撤回未知 questionId 不抛出", async () => {
    const { queue } = await makeQueue();
    await expect(queue.withdraw("not-a-real-id")).resolves.toBeUndefined();
  });
});

describe("广播失败时的韧性", () => {
  test("投递桩持续失败时提问入队、作答、显式撤回均成功且句柄正常兑现", async () => {
    const { queue } = await makeQueue({ deliver: makeFailingDeliver() });

    const handle = await queue.ask(askInput());
    const answerResult = await queue.answer(handle.id, "A", "win-a");
    expect(answerResult.ok).toBe(true);
    await expect(handle.answer).resolves.toEqual({ answered: true, answer: "A" });

    const handle2 = await queue.ask(askInput());
    await expect(queue.withdraw(handle2.id)).resolves.toBeUndefined();

    const pending = await queue.pendingFor(windowStub());
    expect(pending.questions.map((q) => q.id)).toEqual([]);
  });

  test("投递桩持续失败时通知入队仍成功并转入积压", async () => {
    const { queue } = await makeQueue({ deliver: makeFailingDeliver() });

    const notice = await queue.notify(notifyInput());

    const pending = await queue.pendingFor(windowStub());
    expect(pending.notices.map((n) => n.id)).toEqual([notice.id]);
  });
});

describe("通知积压与结算", () => {
  test("通知广播载荷不含内部字段 deliveredTo", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue } = await makeQueue({ deliver });

    await queue.notify(notifyInput());

    const noticeCall = calls.find((call) => call.event === "relay.notice");
    expect(Object.hasOwn(noticeCall!.payload, "deliveredTo")).toBe(false);
  });

  test("产生时有在线窗口即视为已中继，不进入其它窗口的积压", async () => {
    const { deliver } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue } = await makeQueue({ deliver });

    await queue.notify(notifyInput());

    const pending = await queue.pendingFor(windowStub({ windowId: "win-b" }));
    expect(pending.notices).toEqual([]);
  });

  test("产生时无在线窗口则进入积压，新窗口 pendingFor 取得后 markDelivered 结算，不再对任何窗口出现", async () => {
    const { deliver } = makeDeliveryStub({});
    const { queue } = await makeQueue({ deliver });
    const notice = await queue.notify(notifyInput());

    const before = await queue.pendingFor(windowStub({ windowId: "win-a" }));
    expect(before.notices.map((n) => n.id)).toEqual([notice.id]);

    await queue.markDelivered("win-a", notice.id);

    const after = await queue.pendingFor(windowStub({ windowId: "win-b" }));
    expect(after.notices).toEqual([]);
  });

  test("离线时产生的多条问题与通知，新窗口 pendingFor 按产生顺序取得", async () => {
    const clock = makeSequenceClock("2026-09-09T00:00:00.000Z");
    const { deliver } = makeDeliveryStub({});
    const { queue } = await makeQueue({ deliver, clock });

    const handle1 = await queue.ask(askInput({ question: "第一问" }));
    const handle2 = await queue.ask(askInput({ question: "第二问" }));
    const notice1 = await queue.notify(notifyInput({ message: "第一条通知" }));
    const notice2 = await queue.notify(notifyInput({ message: "第二条通知" }));

    const pending = await queue.pendingFor(windowStub());

    expect(pending.questions.map((q) => q.id)).toEqual([handle1.id, handle2.id]);
    expect(pending.notices.map((n) => n.id)).toEqual([notice1.id, notice2.id]);
  });

  test("创建时已中继的通知在重建后仍保持结算状态", async () => {
    const dataDir = await makeDataDir();
    const { queue: queue1 } = await makeQueue({ dataDir, deliver: makeDeliveryStub({ "repo-a": ["win-a"] }).deliver });
    await queue1.notify(notifyInput());

    const { queue: queue2 } = await makeQueue({ dataDir, deliver: makeDeliveryStub({}).deliver });
    const pending = await queue2.pendingFor(windowStub({ windowId: "win-b" }));

    expect(pending.notices).toEqual([]);
  });

  test("并发 markDelivered 不抛错，且重建后仍稳定结算不重复出现", async () => {
    const dataDir = await makeDataDir();
    const { queue: queue1 } = await makeQueue({ dataDir, deliver: makeDeliveryStub({}).deliver });
    const notice = await queue1.notify(notifyInput());

    await expect(
      Promise.all([queue1.markDelivered("win-a", notice.id), queue1.markDelivered("win-b", notice.id)]),
    ).resolves.toBeDefined();

    const { queue: queue2 } = await makeQueue({ dataDir, deliver: makeDeliveryStub({}).deliver });
    const pending = await queue2.pendingFor(windowStub({ windowId: "win-c" }));

    expect(pending.notices).toEqual([]);
  });
});

describe("通知类别经同一通道投递", () => {
  for (const kind of ["completed", "blocked", "auto_resumed", "stopped", "interrupted", "contract_change"]) {
    test(`kind=${kind} 的通知被接受并投递`, async () => {
      const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a"] });
      const { queue } = await makeQueue({ deliver });

      const notice = await queue.notify(notifyInput({ kind }));

      const noticeCall = calls.find((call) => call.event === "relay.notice" && call.payload.id === notice.id);
      expect(noticeCall?.payload.kind).toBe(kind);
      expect(noticeCall?.options.repoId).toBe("repo-a");
    });
  }
});

describe("补充经中继转发到需求代理", () => {
  test("转发到有活动需求代理的需求：定位桩收到消息并回执已投递", async () => {
    const agent = makeRequirementAgent("run-active");
    const { queue } = await makeQueue({ locateRequirementAgent: makeLocator({ "2026-09-09.active-req": agent }) });

    const result = await queue.forward({ requirement: "2026-09-09.active-req", message: "契约变更已裁定：采用方案 A" });

    expect(result.delivered).toBe(true);
    expect(agent.injectCalls).toEqual(["契约变更已裁定：采用方案 A"]);
  });

  test("转发到不存在的需求：不投递并回执原因", async () => {
    const { queue } = await makeQueue({ locateRequirementAgent: makeLocator({}) });

    const result = await queue.forward({ requirement: "2026-09-09.missing-req", message: "补充内容" });

    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(typeof result.reason).toBe("string");
  });

  test("需求代理 inject 抛错时 forward 回执 delivered:false 而不是抛出", async () => {
    const agent: FakeRequirementAgent = {
      runId: "run-broken",
      injectCalls: [],
      inject: () => {
        throw new Error("注入失败");
      },
    };
    const { queue } = await makeQueue({ locateRequirementAgent: makeLocator({ "2026-09-09.broken-req": agent }) });

    const result = await queue.forward({ requirement: "2026-09-09.broken-req", message: "补充内容" });

    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(typeof result.reason).toBe("string");
  });

  test("契约变更通知产生后，裁定结果可作为补充转发给发起该需求的代理", async () => {
    const agent = makeRequirementAgent("run-contract");
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue } = await makeQueue({ deliver, locateRequirementAgent: makeLocator({ "2026-09-09.contract-req": agent }) });

    await queue.notify(notifyInput({ requirement: "2026-09-09.contract-req", kind: "contract_change", message: "请求变更接口签名" }));
    const noticeCall = calls.find((call) => call.event === "relay.notice");
    expect(noticeCall?.payload.kind).toBe("contract_change");

    const forwarded = await queue.forward({ requirement: "2026-09-09.contract-req", message: "主会话裁定：批准变更" });
    expect(forwarded.delivered).toBe(true);
    expect(agent.injectCalls).toContain("主会话裁定：批准变更");
  });
});

describe("重建与持久化", () => {
  test("重建后未答问题仍为 pending 且可继续作答", async () => {
    const dataDir = await makeDataDir();
    const { queue: queue1 } = await makeQueue({ dataDir });
    const handle = await queue1.ask(askInput());

    const { queue: queue2 } = await makeQueue({ dataDir });
    const pending = await queue2.pendingFor(windowStub());
    expect(pending.questions.map((q) => q.id)).toEqual([handle.id]);

    const result = await queue2.answer(handle.id, "A", "win-rebuilt");
    expect(result.ok).toBe(true);
  });

  test("relay 目录与记录文件权限分别为 0700 与 0600", async () => {
    const dataDir = await makeDataDir();
    const { queue } = await makeQueue({ dataDir, deliver: makeDeliveryStub({ "repo-a": ["win-a"] }).deliver });
    await queue.ask(askInput());
    await queue.notify(notifyInput());

    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDir, "data.db"))).mode & 0o777).toBe(0o600);
  });
});

describe("损坏记录与读取失败", () => {
  test.each(["relay_questions", "relay_notices"])("%s 坏结构被拒绝且原记录不变", async (namespace) => {
    const { queue, dataDir } = await makeQueue();
    const ref = { database: join(dataDir, "data.db"), namespace, key: uuidv7() };
    putRecord(ref, { corrupt: true });
    await expect(queue.pendingFor(windowStub())).rejects.toThrow("记录");
    expect(readRelayRecords(dataDir, namespace)).toEqual([{ corrupt: true }]);
  });

  test("数据库路径被目录占用时每次读取都失败", async () => {
    const dataDir = await makeDataDir();
    await mkdir(join(dataDir, "data.db"));
    const { queue } = await makeQueue({ dataDir });
    await expect(queue.pendingFor(windowStub())).rejects.toThrow();
    await expect(queue.pendingFor(windowStub())).rejects.toThrow();
  });
});

describe("订阅事件与监听器隔离", () => {
  test("提问入队与作答分别触发一次订阅事件，取消订阅后不再收到", async () => {
    const { queue } = await makeQueue();
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = queue.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    const handle = await queue.ask(askInput());
    expect(events.some((event) => event.type === "question_enqueued" && (event.question as { id?: string })?.id === handle.id)).toBe(
      true,
    );

    await queue.answer(handle.id, "A", "win-a");
    expect(events.some((event) => event.type === "question_answered" && event.questionId === handle.id)).toBe(true);

    unsubscribe();
    const countBeforeNotify = events.length;
    await queue.notify(notifyInput());
    expect(events.length).toBe(countBeforeNotify);
  });

  test("一个监听器抛错不影响其它监听器收到事件，调用方不受影响", async () => {
    const { queue } = await makeQueue();
    const received: unknown[] = [];
    queue.subscribe(() => {
      throw new Error("监听器故障");
    });
    queue.subscribe((event) => received.push(event));

    const handle = await queue.ask(askInput());

    expect(received.length).toBeGreaterThan(0);
    expect(handle.id).toBeTruthy();
  });

  test("投递失败时经 subscribe 上报 deliver_failed 事件", async () => {
    const { queue } = await makeQueue({ deliver: makeFailingDeliver() });
    const events: Array<Record<string, unknown>> = [];
    queue.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    await queue.ask(askInput());

    const failureEvents = events.filter((event) => event.type === "deliver_failed");
    expect(failureEvents.length).toBeGreaterThan(0);
    expect(failureEvents[0]?.event).toBe("relay.question");
    expect(failureEvents[0]?.repoId).toBe("repo-a");
    expect(typeof failureEvents[0]?.reason).toBe("string");
  });
});

describe("数据库写入失败恢复", () => {
  test("入队失败不产生问题或事件，恢复后可正常提问", async () => {
    const { queue, dataDir } = await makeQueue();
    const path = join(dataDir, "data.db");
    withDatabase(path, () => {});
    const restore = failDatabaseWrites(path, "records", "namespace", "relay_questions");
    try { await expect(queue.ask(askInput())).rejects.toThrow("拒绝写入"); } finally { restore(); }
    expect(readRelayRecords(dataDir, "relay_questions")).toEqual([]);
    expect(withDatabase(path, (db) => db.events("relay"))).toEqual([]);
    const handle = await queue.ask(askInput());
    expect((await queue.pendingFor(windowStub())).questions.map((q) => q.id)).toEqual([handle.id]);
  });
});

describe("并发操作下的一致性", () => {
  test("并发作答同一问题：恰一个成功另一个已答，句柄答案与落盘一致，撤回恰一次且排除首答窗口，订阅只收到一次 question_answered", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a", "win-b"] });
    const { queue, dataDir } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());
    const events: Array<Record<string, unknown>> = [];
    queue.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    const attempts = [
      { windowId: "win-a", answer: "A" },
      { windowId: "win-b", answer: "B" },
    ];
    const results = await Promise.all(attempts.map((attempt) => queue.answer(handle.id, attempt.answer, attempt.windowId)));

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const loser = losers[0]!;
    if (!loser.ok) expect(loser.reason).toBe("already_answered");

    const winnerIndex = results.findIndex((result) => result.ok);
    const winnerAttempt = attempts[winnerIndex]!;

    await expect(handle.answer).resolves.toEqual({ answered: true, answer: winnerAttempt.answer });

    const rawRecords = await readRelayRecords<{ id: string; status: string; answer?: string; answeredBy?: string }>(
      dataDir, "relay_questions",
    );
    const answeredRecords = rawRecords.filter((record) => record.id === handle.id && record.status === "answered");
    expect(answeredRecords.length).toBe(1);
    expect(answeredRecords[0]?.answer).toBe(winnerAttempt.answer);
    expect(answeredRecords[0]?.answeredBy).toBe(winnerAttempt.windowId);

    const withdrawCalls = calls.filter((call) => call.event === "relay.withdraw");
    expect(withdrawCalls.length).toBe(1);
    expect(withdrawCalls[0]?.options.excludeWindowId).toBe(winnerAttempt.windowId);

    const answeredEvents = events.filter((event) => event.type === "question_answered");
    expect(answeredEvents.length).toBe(1);
  });

  test("作答与撤回并发：终态只有一种，落盘最后记录与句柄结算一致，不出现已撤回却仍算已答", async () => {
    const { deliver } = makeDeliveryStub({ "repo-a": ["win-a"] });
    const { queue, dataDir } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());

    const [answerResult] = await Promise.all([queue.answer(handle.id, "A", "win-a"), queue.withdraw(handle.id)]);

    const settled = await handle.answer;
    const rawRecords = await readRelayRecords<{ id: string; status: string; answer?: string; answeredBy?: string }>(
      dataDir, "relay_questions",
    );
    const finalRecords = rawRecords.filter((record) => record.id === handle.id);
    const lastRecord = finalRecords[finalRecords.length - 1];
    expect(lastRecord).toBeDefined();

    if (settled.answered) {
      expect(answerResult.ok).toBe(true);
      expect(lastRecord?.status).toBe("answered");
      expect(lastRecord?.answer).toBe("A");
      expect(lastRecord?.answeredBy).toBe("win-a");
    } else {
      expect(lastRecord?.status).toBe("withdrawn");
    }
  });

  test("两个窗口并发 markDelivered 同一通知，deliveredTo 同时含两者，无回执丢失", async () => {
    const { deliver } = makeDeliveryStub({});
    const { queue, dataDir } = await makeQueue({ deliver });
    const notice = await queue.notify(notifyInput());

    await Promise.all([queue.markDelivered("win-a", notice.id), queue.markDelivered("win-b", notice.id)]);

    const rawRecords = await readRelayRecords<{ id: string; deliveredTo: string[] }>(dataDir, "relay_notices");
    const finalRecords = rawRecords.filter((record) => record.id === notice.id);
    const lastRecord = finalRecords[finalRecords.length - 1];
    expect(lastRecord?.deliveredTo?.slice().sort()).toEqual(["win-a", "win-b"]);
  });

  test("并发 markDelivered 期间落盘失败：两次调用都 reject，通知不对任何窗口隐身，恢复权限后再次 markDelivered 成功且落盘与查询一致", async () => {
    const dataDir = await makeDataDir();
    const { deliver } = makeDeliveryStub({});
    const { queue } = await makeQueue({ dataDir, deliver });
    const notice = await queue.notify(notifyInput());

    const relayDir = join(dataDir, "relay");
    const restore = failDatabaseWrites(join(dataDir, "data.db"), "records", "namespace", "relay_notices");
    let results: PromiseSettledResult<void>[];
    try {
      results = await Promise.allSettled([queue.markDelivered("win-a", notice.id), queue.markDelivered("win-b", notice.id)]);
    } finally {
      restore();
    }
    expect(results.every((result) => result.status === "rejected")).toBe(true);

    const pendingA = await queue.pendingFor(windowStub({ windowId: "win-a" }));
    expect(pendingA.notices.map((n) => n.id)).toContain(notice.id);
    const pendingB = await queue.pendingFor(windowStub({ windowId: "win-b" }));
    expect(pendingB.notices.map((n) => n.id)).toContain(notice.id);

    const rawBefore = await readRelayRecords<{ id: string; deliveredTo: string[] }>(dataDir, "relay_notices");
    const lastBefore = rawBefore.filter((record) => record.id === notice.id).pop();
    expect(lastBefore?.deliveredTo ?? []).toEqual([]);

    await queue.markDelivered("win-a", notice.id);

    const rawAfter = await readRelayRecords<{ id: string; deliveredTo: string[] }>(dataDir, "relay_notices");
    const lastAfter = rawAfter.filter((record) => record.id === notice.id).pop();
    expect(lastAfter?.deliveredTo).toEqual(["win-a"]);

    const pendingAfter = await queue.pendingFor(windowStub({ windowId: "win-b" }));
    expect(pendingAfter.notices.map((n) => n.id)).not.toContain(notice.id);
  });

  test("并发作答且写入失败：双方 reject，问题回落 pending 无残留 answered 记录且未广播撤回，恢复权限后可再次作答成功", async () => {
    const { deliver, calls } = makeDeliveryStub({ "repo-a": ["win-a", "win-b"] });
    const { queue, dataDir } = await makeQueue({ deliver });
    const handle = await queue.ask(askInput());

    const relayDir = join(dataDir, "relay");
    const restore = failDatabaseWrites(join(dataDir, "data.db"), "records", "namespace", "relay_questions");
    let results: PromiseSettledResult<Awaited<ReturnType<typeof queue.answer>>>[];
    try {
      results = await Promise.allSettled([queue.answer(handle.id, "A", "win-a"), queue.answer(handle.id, "B", "win-b")]);
    } finally {
      restore();
    }

    const rejected = results.filter((result) => result.status === "rejected");
    const alreadyAnswered = results.filter(
      (result) => result.status === "fulfilled" && !result.value.ok && result.value.reason === "already_answered",
    );
    expect(rejected.length).toBe(2);
    expect(alreadyAnswered.length).toBe(0);

    const pending = await queue.pendingFor(windowStub({ windowId: "win-a" }));
    expect(pending.questions.map((q) => q.id)).toContain(handle.id);

    const rawRecords = await readRelayRecords<{ id: string; status: string }>(dataDir, "relay_questions");
    const answeredRecords = rawRecords.filter((record) => record.id === handle.id && record.status === "answered");
    expect(answeredRecords.length).toBe(0);

    const withdrawCalls = calls.filter((call) => call.event === "relay.withdraw");
    expect(withdrawCalls.length).toBe(0);

    const result = await queue.answer(handle.id, "A", "win-a");
    expect(result.ok).toBe(true);
  });
});

describe("持久化写失败不产生分叉状态", () => {
  test("答复持久化失败时 answer 抛出、句柄保持待答，pendingFor 仍视该问题为待答，恢复权限后可再次作答", async () => {
    const dataDir = await makeDataDir();
    const { queue } = await makeQueue({ dataDir });
    const handle = await queue.ask(askInput());

    const relayDir = join(dataDir, "relay");
    const restore = failDatabaseWrites(join(dataDir, "data.db"), "records", "namespace", "relay_questions");
    try {
      await expect(queue.answer(handle.id, "A", "win-a")).rejects.toThrow();
    } finally {
      // 权限先复原：handle.answer 是否兑现是下面单独断言的对象，不能让它在这里卡住导致
      // afterEach 清理临时目录时因权限未恢复而失败
      restore();
    }

    const pending = await queue.pendingFor(windowStub());
    expect(pending.questions.map((q) => q.id)).toContain(handle.id);

    let settled: "resolved" | "rejected" | "pending" = "pending";
    handle.answer.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe("pending");

    const result = await queue.answer(handle.id, "A", "win-a");
    expect(result.ok).toBe(true);
  });
});

describe("pendingFor 返回投影而非内部引用", () => {
  test("返回的问题/通知不含 status/deliveredTo，外部修改返回对象不影响队列后续查询", async () => {
    const { deliver } = makeDeliveryStub({});
    const { queue } = await makeQueue({ deliver });
    await queue.ask(askInput());
    await queue.notify(notifyInput());

    const first = await queue.pendingFor(windowStub());
    expect(first.questions.length).toBe(1);
    expect(first.notices.length).toBe(1);
    expect(Object.hasOwn(first.questions[0]!, "status")).toBe(false);
    expect(Object.hasOwn(first.notices[0]!, "deliveredTo")).toBe(false);

    (first.questions[0] as Record<string, unknown>).status = "answered";
    const mutableNotice = first.notices[0] as unknown as { deliveredTo: string[] };
    mutableNotice.deliveredTo = [];
    mutableNotice.deliveredTo.push("win-intruder");

    const second = await queue.pendingFor(windowStub({ windowId: "win-second" }));
    expect(second.questions.length).toBe(1);
    expect(second.notices.length).toBe(1);
  });
});
