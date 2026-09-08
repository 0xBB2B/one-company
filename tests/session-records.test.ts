import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { runDataDir } from "../runtime/identity.ts";
import {
  createSessionManagerForRun,
  openSessionManagerForRun,
  readTranscript,
  sessionFilePath,
  synthesizeInterruptedResults,
  transcriptSeq,
} from "../runtime/session-records.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const tempCwds: string[] = [];

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of tempCwds.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeRunContext() {
  const home = await createTempHome();
  tempHomes.push(home);
  const cwd = await mkdtemp(join(tmpdir(), "session-records-cwd-"));
  tempCwds.push(cwd);
  return { dataRoot: home.dataRoot, repoId: randomUUID(), runId: randomUUID(), cwd };
}

function expectOk<T extends { ok: boolean }>(result: T): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok:true result");
  return result;
}

function expectFail<T extends { ok: boolean }>(result: T): T {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected ok:false result");
  return result;
}

function corruptWholeFile(): string {
  return '{"type":"session","version":3,"id":"broken","timestamp":"2026';
}

async function truncateLine(path: string, lineNumber: number): Promise<void> {
  const raw = await readFile(path, "utf8");
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = hadTrailingNewline ? raw.slice(0, -1).split("\n") : raw.split("\n");
  const index = lineNumber - 1;
  const target = lines[index];
  if (target === undefined) throw new Error(`行号超出范围: ${lineNumber}`);
  lines[index] = target.slice(0, Math.floor(target.length / 2));
  await writeFile(path, lines.join("\n") + (hadTrailingNewline ? "\n" : ""), "utf8");
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

// header(1) + 6 message 条目(2-7)：部分损坏测试依赖此固定行数与顺序定位行号。
function writeCompleteFixture(manager: SessionManager) {
  const userId = manager.appendMessage(userMessage("运行任务"));
  const thinkCallId = manager.appendMessage(
    assistantMessage(
      [
        { type: "thinking", thinking: "先看看现状" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
      "toolUse",
    ),
  );
  const result1Id = manager.appendMessage(toolResultMessage("call-1", "bash", [{ type: "text", text: "ok\n" }], false));
  const textCallId = manager.appendMessage(
    assistantMessage(
      [
        { type: "text", text: "看结果后继续" },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "whoami" } },
      ],
      "toolUse",
    ),
  );
  const result2Id = manager.appendMessage(
    toolResultMessage(
      "call-2",
      "bash",
      [
        { type: "text", text: "Authorization: Bearer abc123" },
        { type: "text", text: "MARKER-XYZ" },
      ],
      true,
    ),
  );
  const finalId = manager.appendMessage(assistantMessage([{ type: "text", text: "完成" }], "stop"));
  return { userId, thinkCallId, result1Id, textCallId, result2Id, finalId };
}

function writeTruncatedFixture(manager: SessionManager) {
  manager.appendMessage(userMessage("运行任务"));
  manager.appendMessage(
    assistantMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
  );
  manager.appendMessage(toolResultMessage("call-1", "bash", [{ type: "text", text: "ok\n" }], false));
  manager.appendMessage(
    assistantMessage([{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "cat secret" } }], "toolUse"),
  );
}

function writeDoubleDanglingFixture(manager: SessionManager) {
  manager.appendMessage(userMessage("并发处理"));
  manager.appendMessage(
    assistantMessage(
      [
        { type: "toolCall", id: "call-x", name: "bash", arguments: { command: "a" } },
        { type: "toolCall", id: "call-y", name: "bash", arguments: { command: "b" } },
      ],
      "toolUse",
    ),
  );
}

describe("sessionFilePath", () => {
  test("返回运行目录下 session.jsonl 的路径", async () => {
    const ctx = await makeRunContext();
    const expected = join(runDataDir(ctx.dataRoot, ctx.repoId, ctx.runId), "session.jsonl");
    expect(sessionFilePath(ctx)).toBe(expected);
  });
});

describe("createSessionManagerForRun", () => {
  test("创建的会话文件权限仅当前用户可读写", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    const info = await stat(sessionFilePath(ctx));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("创建的运行目录权限仅当前用户可读写执行", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    const info = await stat(dirname(sessionFilePath(ctx)));
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("返回的 SessionManager 可用于追加会话条目", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    expect(manager.getEntries().length).toBeGreaterThan(0);
  });

  test("对已存在的会话文件重复创建报错且不覆盖原文件", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    const rawBefore = await readFile(sessionFilePath(ctx), "utf8");

    expect(() => createSessionManagerForRun(ctx)).toThrow();

    const rawAfter = await readFile(sessionFilePath(ctx), "utf8");
    expect(rawAfter).toBe(rawBefore);
  });
});

describe("会话记录内容原样保存", () => {
  test("工具结果中的凭据文本与独立标记文本原样保留不被改写", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const raw = await readFile(sessionFilePath(ctx), "utf8");
    expect(raw).toContain("Bearer abc123");
    expect(raw).toContain("MARKER-XYZ");
  });

  test("结构化提交条目持久化，重开后仍可读取", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    manager.appendCustomEntry("commit", { sha: "deadbeef", message: "落地会话记录" });

    const reopened = openSessionManagerForRun(ctx);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const custom = reopened.manager.getEntries().find((entry) => entry.type === "custom");
    expect(custom).toBeDefined();
    if (custom?.type !== "custom") return;
    expect(custom.data).toEqual({ sha: "deadbeef", message: "落地会话记录" });
  });
});

describe("openSessionManagerForRun 续接", () => {
  test("关闭后重开消息数与关闭前一致", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    const before = manager.getEntries().filter((entry) => entry.type === "message").length;

    const reopened = openSessionManagerForRun(ctx);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const after = reopened.manager.getEntries().filter((entry) => entry.type === "message").length;
    expect(after).toBe(before);
  });

  test("追加压缩条目后重开按压缩后视图重建上下文，文件保留完整历史", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    const ids = writeCompleteFixture(manager);
    const linesBeforeCompaction = (await readFile(sessionFilePath(ctx), "utf8")).trim().split("\n").length;

    manager.appendCompaction("完成了两次工具调用", ids.textCallId, 999);

    const linesAfterCompaction = (await readFile(sessionFilePath(ctx), "utf8")).trim().split("\n").length;
    expect(linesAfterCompaction).toBeGreaterThan(linesBeforeCompaction);

    const reopened = openSessionManagerForRun(ctx);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const context = reopened.manager.buildSessionContext();
    const serialized = JSON.stringify(context.messages);
    expect(serialized).not.toContain("运行任务");
    expect(serialized).toContain("完成");

    const rawAfterReload = await readFile(sessionFilePath(ctx), "utf8");
    expect(rawAfterReload).toContain("运行任务");
    expect(rawAfterReload.trim().split("\n").length).toBe(linesAfterCompaction);
  });
});

describe("openSessionManagerForRun 缺失与整体损坏", () => {
  test("会话文件缺失时返回 ok:false reason:missing 而不抛出", async () => {
    const ctx = await makeRunContext();
    const result = openSessionManagerForRun(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });

  test("会话文件损坏时返回 ok:false reason:corrupt 而不抛出", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    await writeFile(sessionFilePath(ctx), corruptWholeFile(), "utf8");

    const result = openSessionManagerForRun(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
    expect(result.detail).toBeDefined();
  });
});

describe("openSessionManagerForRun 部分损坏", () => {
  test("末行截断为半截 JSON 时返回 corrupt 且 detail 含行号", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    const totalLines = (await readFile(sessionFilePath(ctx), "utf8")).trim().split("\n").length;

    await truncateLine(sessionFilePath(ctx), totalLines);

    const result = expectFail(openSessionManagerForRun(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
    expect(String(result.detail)).toContain(String(totalLines));
  });

  test("中间某行截断为半截 JSON 时返回 corrupt 且 detail 含行号", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    const brokenLine = 4;

    await truncateLine(sessionFilePath(ctx), brokenLine);

    const result = expectFail(openSessionManagerForRun(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
    expect(String(result.detail)).toContain(String(brokenLine));
  });
});

describe("synthesizeInterruptedResults 中断恢复", () => {
  test("未完成的工具调用追加固定中断结果条目且原调用条目字节不变", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeTruncatedFixture(manager);

    const rawBefore = await readFile(sessionFilePath(ctx), "utf8");
    const call2LineBefore = rawBefore
      .trim()
      .split("\n")
      .find((line) => line.includes('"call-2"') && line.includes("toolCall"));
    expect(call2LineBefore).toBeDefined();

    const outcome = expectOk(synthesizeInterruptedResults(ctx));
    expect(outcome.appended).toEqual([{ toolCallId: "call-2", toolName: "bash" }]);

    const rawAfter = await readFile(sessionFilePath(ctx), "utf8");
    const call2LineAfter = rawAfter
      .trim()
      .split("\n")
      .find((line) => line.includes('"call-2"') && line.includes("toolCall"));
    expect(call2LineAfter).toBe(call2LineBefore);
    expect(rawAfter).toContain("调用因守护进程中断");

    const reopened = openSessionManagerForRun(ctx);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const interrupted = reopened.manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "call-2");
    expect(interrupted).toBeDefined();
    if (interrupted?.type !== "message" || interrupted.message.role !== "toolResult") return;
    expect(interrupted.message.isError).toBe(true);
    expect(interrupted.message.content.some((block) => block.type === "text" && block.text === "调用因守护进程中断")).toBe(
      true,
    );
  });

  test("完整会话不追加中断结果，返回空清单且文件字节不变", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);
    const rawBefore = await readFile(sessionFilePath(ctx), "utf8");

    const outcome = expectOk(synthesizeInterruptedResults(ctx));
    expect(outcome.appended).toEqual([]);

    const rawAfter = await readFile(sessionFilePath(ctx), "utf8");
    expect(rawAfter).toBe(rawBefore);
  });

  test("追加中断结果后会话仍可正常重新打开", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeTruncatedFixture(manager);
    expectOk(synthesizeInterruptedResults(ctx));

    const result = openSessionManagerForRun(ctx);
    expect(result.ok).toBe(true);
  });

  test("会话文件缺失时返回 ok:false reason:missing 而不抛出", async () => {
    const ctx = await makeRunContext();
    const result = expectFail(synthesizeInterruptedResults(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });

  test("会话文件损坏时返回 ok:false reason:corrupt 而不抛出", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    await writeFile(sessionFilePath(ctx), corruptWholeFile(), "utf8");

    const result = expectFail(synthesizeInterruptedResults(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
  });

  test("重复调用是幂等的，第二次不追加且文件字节不变", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeTruncatedFixture(manager);

    const first = expectOk(synthesizeInterruptedResults(ctx));
    expect(first.appended.length).toBe(1);
    const rawAfterFirst = await readFile(sessionFilePath(ctx), "utf8");

    const second = expectOk(synthesizeInterruptedResults(ctx));
    expect(second.appended).toEqual([]);
    const rawAfterSecond = await readFile(sessionFilePath(ctx), "utf8");
    expect(rawAfterSecond).toBe(rawAfterFirst);
  });

  test("同一 assistant 消息内多个悬空工具调用按文件顺序各补一条，重载后上下文顺序为 user、assistant、两条 toolResult", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeDoubleDanglingFixture(manager);

    const outcome = expectOk(synthesizeInterruptedResults(ctx));
    expect(outcome.appended).toEqual([
      { toolCallId: "call-x", toolName: "bash" },
      { toolCallId: "call-y", toolName: "bash" },
    ]);

    const reopened = expectOk(openSessionManagerForRun(ctx));
    const context = reopened.manager.buildSessionContext();
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);

    const toolResultIds = context.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => (message.role === "toolResult" ? message.toolCallId : undefined));
    expect(toolResultIds).toEqual(["call-x", "call-y"]);
  });
});

describe("readTranscript ended 状态", () => {
  test("完整会话以 stop 收尾时 ended 为 true", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const result = expectOk(readTranscript(ctx));
    expect(result.ended).toBe(true);
  });

  test("截断会话（末条为等待中的工具调用）时 ended 为 false", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeTruncatedFixture(manager);

    const result = expectOk(readTranscript(ctx));
    expect(result.ended).toBe(false);
  });

  test("补入中断结果后 ended 仍为 false", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeTruncatedFixture(manager);
    expectOk(synthesizeInterruptedResults(ctx));

    const result = expectOk(readTranscript(ctx));
    expect(result.ended).toBe(false);
  });
});

describe("readTranscript ended 状态（中止态）", () => {
  test("以 aborted 收尾且带悬空调用的会话，补入中断结果后 ended 仍为 true", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    manager.appendMessage(userMessage("运行任务"));
    manager.appendMessage(
      assistantMessage([{ type: "toolCall", id: "call-abort", name: "bash", arguments: { command: "ls" } }], "aborted"),
    );
    expect(expectOk(readTranscript(ctx)).ended).toBe(true);

    const synthesized = expectOk(synthesizeInterruptedResults(ctx));
    expect(synthesized.appended.map((call) => call.toolCallId)).toEqual(["call-abort"]);
    expect(expectOk(readTranscript(ctx)).ended).toBe(true);
  });

  test("会话文件不可读时返回 corrupt 而不抛出", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    manager.appendMessage(userMessage("x"));
    const file = sessionFilePath(ctx);
    await chmod(file, 0o000);
    try {
      const outcome = readTranscript(ctx);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe("corrupt");
    } finally {
      await chmod(file, 0o600);
    }
  });
});

describe("readTranscript 序号稳定性", () => {
  test("同一文件两次读取序号相同", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const first = expectOk(readTranscript(ctx));
    const second = expectOk(readTranscript(ctx));
    expect(second.entries).toEqual(first.entries);
  });

  test("追加新条目后旧条目序号与内容不变", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const before = expectOk(readTranscript(ctx));

    manager.appendMessage(assistantMessage([{ type: "text", text: "补充说明" }], "stop"));

    const after = expectOk(readTranscript(ctx));
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
  });

  test("追加压缩条目不改变既有条目序号", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    const ids = writeCompleteFixture(manager);

    const before = expectOk(readTranscript(ctx));

    manager.appendCompaction("完成了两次工具调用", ids.textCallId, 999);

    const after = expectOk(readTranscript(ctx));
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
  });
});

describe("readTranscript 与 transcriptSeq", () => {
  test("解析出思考/文本/工具调用/结果/错误条目且序号单调递增", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const result = expectOk(readTranscript(ctx));
    expect(result.entries.length).toBeGreaterThan(0);

    const kinds = new Set(result.entries.map((entry) => entry.kind));
    for (const kind of ["thinking", "text", "toolcall", "tool_result", "error"] as const) {
      expect(kinds.has(kind)).toBe(true);
    }

    for (const entry of result.entries) {
      expect(typeof entry.summary).toBe("string");
    }
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i].seq).toBeGreaterThan(result.entries[i - 1].seq);
    }
  });

  test("fromSeq 起读只返回该序号之后的条目", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const full = expectOk(readTranscript(ctx));
    expect(full.entries.length).toBeGreaterThan(1);
    const midSeq = full.entries[Math.floor(full.entries.length / 2)].seq;

    const partial = expectOk(readTranscript({ ...ctx, fromSeq: midSeq }));
    expect(partial.entries.length).toBeGreaterThan(0);
    expect(partial.entries.every((entry) => entry.seq > midSeq)).toBe(true);
    expect(partial.entries).toEqual(full.entries.filter((entry) => entry.seq > midSeq));
  });

  test("transcriptSeq 等于最新条目序号", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    writeCompleteFixture(manager);

    const transcript = expectOk(readTranscript(ctx));
    const lastEntry = transcript.entries[transcript.entries.length - 1];
    expect(lastEntry).toBeDefined();
    if (!lastEntry) return;

    const seqResult = expectOk(transcriptSeq(ctx));
    expect(seqResult.seq).toBe(lastEntry.seq);
  });

  test("会话文件缺失时 readTranscript 返回 ok:false reason:missing", async () => {
    const ctx = await makeRunContext();
    const result = expectFail(readTranscript(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });

  test("会话文件损坏时 readTranscript 返回 ok:false reason:corrupt 而非空会话", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    await writeFile(sessionFilePath(ctx), corruptWholeFile(), "utf8");

    const result = expectFail(readTranscript(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
    expect(result.detail).toBeDefined();
  });

  test("会话文件缺失时 transcriptSeq 返回 ok:false reason:missing", async () => {
    const ctx = await makeRunContext();
    const result = expectFail(transcriptSeq(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("missing");
  });

  test("会话文件损坏时 transcriptSeq 返回 ok:false reason:corrupt", async () => {
    const ctx = await makeRunContext();
    createSessionManagerForRun(ctx);
    await writeFile(sessionFilePath(ctx), corruptWholeFile(), "utf8");

    const result = expectFail(transcriptSeq(ctx));
    if (result.ok) return;
    expect(result.reason).toBe("corrupt");
  });
});

describe("readTranscript 转录顺序", () => {
  test("转录条目顺序与夹具写入顺序逐项对齐", async () => {
    const ctx = await makeRunContext();
    const manager = createSessionManagerForRun(ctx);
    manager.appendMessage(
      assistantMessage(
        [
          { type: "thinking", thinking: "步骤一" },
          { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "pwd" } },
        ],
        "toolUse",
      ),
    );
    manager.appendMessage(toolResultMessage("call-a", "bash", [{ type: "text", text: "步骤一结果" }], false));
    manager.appendMessage(assistantMessage([{ type: "text", text: "步骤二说明" }], "stop"));

    const result = expectOk(readTranscript(ctx));
    expect(result.entries.map((entry) => entry.kind)).toEqual(["thinking", "toolcall", "tool_result", "text"]);
    expect(result.entries[0]?.summary).toContain("步骤一");
    expect(result.entries[2]?.summary).toContain("步骤一结果");
    expect(result.entries[3]?.summary).toContain("步骤二说明");
  });
});
