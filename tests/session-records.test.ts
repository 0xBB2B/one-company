import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionManagerForRun, openSessionManagerForRun, readTranscript, sessionRecordRef, synthesizeInterruptedResults, transcriptSeq } from "../runtime/session-records.ts";
import { withDatabase, putRecord, uuidv7, repositoryDatabase } from "../runtime/database.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { testRepoId, sessionJson, failDatabaseWrites } from "./helpers/database-fixture.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function makeRunContext() {
  const dataRoot = await mkdtemp(join(temporaryRoot(), "session-db-")); dirs.push(dataRoot);
  return { dataRoot, repoId: testRepoId(), runId: uuidv7(), cwd: dataRoot };
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


test("SDK 会话由 SQLite 保存，重复创建拒绝且不覆盖历史", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  writeCompleteFixture(manager);
  const before = sessionJson(ctx);
  expect(() => createSessionManagerForRun(ctx)).toThrow();
  expect(sessionJson(ctx)).toBe(before);
  expect(manager.getSessionFile()).toBeUndefined();
  expect((await readdir(join(ctx.dataRoot, "repos", ctx.repoId))).every((name) => name.startsWith("data.sqlite"))).toBe(true);
});

test("仅切换分支或重置位置后重开仍恢复同一上下文", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  const first = manager.appendMessage(userMessage("第一条"));
  manager.appendMessage(userMessage("第二条"));
  manager.branch(first);
  const reopened = openSessionManagerForRun(ctx);
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(reopened.manager.getLeafId()).toBe(first);
  expect(reopened.manager.buildSessionContext()).toEqual(manager.buildSessionContext());
  reopened.manager.resetLeaf();
  const reset = openSessionManagerForRun(ctx);
  if (!reset.ok) throw new Error(reset.detail);
  expect(reset.manager.getLeafId()).toBeNull();
  expect(reset.manager.buildSessionContext().messages).toEqual([]);
  expect(reset.manager.getEntries()).toHaveLength(2);
});

test("中断补全只处理当前分支的工具调用", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  const first = manager.appendMessage(userMessage("第一条"));
  writeDoubleDanglingFixture(manager);
  manager.branch(first);
  expect(synthesizeInterruptedResults(ctx)).toEqual({ ok: true, appended: [] });
});

test("两个会话写入者不能用旧上下文覆盖已提交位置", async () => {
  const ctx = await makeRunContext();
  const first = createSessionManagerForRun(ctx);
  const second = openSessionManagerForRun(ctx);
  if (!second.ok) throw new Error(second.detail);
  const id = first.appendMessage(userMessage("先提交"));
  expect(() => second.manager.appendMessage(userMessage("过期追加"))).toThrow("版本已变化");
  const reopened = openSessionManagerForRun(ctx);
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(reopened.manager.getLeafId()).toBe(id);
  expect(reopened.manager.getEntries()).toHaveLength(1);
});

test("受管理会话拒绝换身份和切换文件存储", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  const id = manager.appendMessage(userMessage("消息"));
  expect(() => manager.newSession()).toThrow("不能替换");
  expect(() => manager.createBranchedSession(id)).toThrow("不能替换");
  expect(() => manager.setSessionFile(join(ctx.cwd, "escape.jsonl"))).toThrow("不能替换");
});

test("写入失败只通知一次，恢复数据库后也不能保存已污染的内存历史", async () => {
  const ctx = await makeRunContext();
  const errors: Error[] = [];
  const manager = createSessionManagerForRun({ ...ctx, onPersistError: (error) => errors.push(error) });
  const id = manager.appendMessage(userMessage("已保存"));
  const restore = failDatabaseWrites(repositoryDatabase(ctx.dataRoot, ctx.repoId), "events", "stream", `session:${ctx.runId}`);
  try { manager.appendMessage(userMessage("写入失败")); } finally { restore(); }
  manager.appendMessage(userMessage("失败后追加"));
  expect(errors).toHaveLength(1);
  expect(() => manager.resetLeaf()).toThrow();
  const reopened = openSessionManagerForRun(ctx);
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(reopened.manager.getLeafId()).toBe(id);
  expect(reopened.manager.getEntries()).toHaveLength(1);
});

test("工具原始结果与结构化提交原样保存，重开条目完全一致", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx); writeCompleteFixture(manager);
  manager.appendMessage(assistantMessage([{ type: "toolCall", id: "submit-1", name: "structured_output", arguments: { verdict: "PASS" } }], "toolUse"));
  const reopened = openSessionManagerForRun(ctx);
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(reopened.manager.getEntries()).toEqual(manager.getEntries());
  expect(sessionJson(ctx)).toContain("Authorization: Bearer abc123");
  expect(sessionJson(ctx)).toContain("MARKER-XYZ");
});

test("压缩后按 SDK 视图重建上下文，原始完整历史仍保存在 SQLite", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx); const ids = writeCompleteFixture(manager);
  manager.appendCompaction("完成了两次工具调用", ids.textCallId, 999);
  const before = sessionJson(ctx);
  const reopened = openSessionManagerForRun(ctx);
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(JSON.stringify(reopened.manager.buildSessionContext().messages)).not.toContain("运行任务");
  expect(sessionJson(ctx)).toContain("运行任务");
  expect(sessionJson(ctx)).toBe(before);
});

test("会话缺失时打开、转录、序号及中断补全均明确失败", async () => {
  const ctx = await makeRunContext();
  for (const result of [openSessionManagerForRun(ctx), readTranscript(ctx), transcriptSeq(ctx), synthesizeInterruptedResults(ctx)]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  }
});

test.each([null, { header: null }, { header: { type: "invalid", id: "header" } }])("损坏的会话元数据不冒充空记录: %j", async (data) => {
  const ctx = await makeRunContext(); createSessionManagerForRun(ctx); putRecord(sessionRecordRef(ctx), data);
  for (const result of [openSessionManagerForRun(ctx), readTranscript(ctx), transcriptSeq(ctx), synthesizeInterruptedResults(ctx)]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("corrupt");
  }
});

test.each([
  { type: "message", id: "bad", parentId: "unknown", message: { role: "user", content: "test" } },
  { type: "message", id: "bad", parentId: null, message: { role: "user", content: null } },
])("坏消息或悬空父引用被拒绝: %j", async (entry) => {
  const ctx = await makeRunContext(); createSessionManagerForRun(ctx);
  withDatabase(repositoryDatabase(ctx.dataRoot, ctx.repoId), (db) => db.append(`session:${ctx.runId}`, entry));
  expect(readTranscript(ctx).ok).toBe(false);
  expect(openSessionManagerForRun(ctx).ok).toBe(false);
});

test("多条悬空调用按顺序补中断结果，再次补全不产生重复记录", async () => {
  const ctx = await makeRunContext(); const manager = createSessionManagerForRun(ctx); writeDoubleDanglingFixture(manager);
  const original = sessionJson(ctx);
  const result = synthesizeInterruptedResults(ctx);
  expect(result.ok && result.appended.map((entry) => entry.toolCallId)).toEqual(["call-x", "call-y"]);
  expect(sessionJson(ctx).startsWith(original)).toBe(true);
  const after = sessionJson(ctx);
  const second = synthesizeInterruptedResults(ctx);
  expect(second.ok && second.appended).toEqual([]);
  expect(sessionJson(ctx)).toBe(after);
  expect(openSessionManagerForRun(ctx).ok).toBe(true);
});

test("完整会话无需补写中断结果", async () => {
  const ctx = await makeRunContext(); const manager = createSessionManagerForRun(ctx); writeCompleteFixture(manager);
  const before = sessionJson(ctx); const result = synthesizeInterruptedResults(ctx);
  expect(result.ok && result.appended).toEqual([]); expect(sessionJson(ctx)).toBe(before);
});

test("转录终态来自运行状态，普通文字回合结束不能把运行误判结束", async () => {
  const ctx = await makeRunContext(); const manager = createSessionManagerForRun(ctx); writeCompleteFixture(manager);
  expect(readTranscript(ctx).ok && (readTranscript(ctx) as { ended: boolean }).ended).toBe(false);
  putRecord({ ...sessionRecordRef(ctx), namespace: "runs" }, { state: "completed" });
  expect(readTranscript(ctx).ok && (readTranscript(ctx) as { ended: boolean }).ended).toBe(true);
});

test("转录序号稳定、追加不改旧序号，支持从序号后读取", async () => {
  const ctx = await makeRunContext(); const manager = createSessionManagerForRun(ctx); writeCompleteFixture(manager);
  const before = readTranscript(ctx); if (!before.ok) throw new Error(before.detail);
  expect(readTranscript(ctx)).toEqual(before);
  const last = before.entries.at(-1)!.seq;
  manager.appendMessage(userMessage("新消息"));
  const next = readTranscript({ ...ctx, fromSeq: last });
  expect(next.ok && next.entries.map((entry) => entry.summary)).toEqual(["新消息"]);
  expect(transcriptSeq(ctx)).toEqual({ ok: true, seq: last + 1 });
  const all = readTranscript(ctx); if (!all.ok) throw new Error(all.detail);
  expect(all.entries.slice(0, before.entries.length)).toEqual(before.entries);
  expect(new Set(before.entries.map((entry) => entry.kind))).toEqual(new Set(["text", "thinking", "toolcall", "tool_result", "error"]));
});
