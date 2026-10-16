import { afterEach, expect, test } from "vitest";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionManagerForRun, readSessionEntries, sessionFilePath, sessionRecordRef } from "../src/modules/agents/session-records.ts";
import { withDatabase, putRecord, readRecord, uuidv7, repositoryDatabase } from "../src/core/storage/database.ts";
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


test("会话条目只存私有文件，data.db 只留元数据；重复创建拒绝且不覆盖历史", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  writeCompleteFixture(manager);
  const before = sessionJson(ctx);
  expect(() => createSessionManagerForRun(ctx)).toThrow();
  expect(sessionJson(ctx)).toBe(before);
  expect(before).toContain("MARKER-XYZ");
  const file = sessionFilePath(ctx);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
  expect(Object.keys(readRecord<Record<string, unknown>>(sessionRecordRef(ctx)).data).sort()).toEqual(["cwd", "leafId"]);
  const database = repositoryDatabase(ctx.dataRoot, ctx.repoId);
  const bytes = (await Promise.all(["", "-wal"].map((suffix) => readFile(database + suffix).catch(() => Buffer.alloc(0))))).map((buffer) => buffer.toString("latin1")).join("");
  expect(bytes).not.toContain("MARKER-XYZ");
  expect(withDatabase(database, (db) => db.events(`session:${ctx.runId}`))).toEqual([]);
});

const storedLeaf = (ctx: Awaited<ReturnType<typeof makeRunContext>>) => readRecord<{ leafId: string | null }>(sessionRecordRef(ctx)).data.leafId;

test("切换分支与重置位置都写进会话元数据，条目文件不变", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx);
  const first = manager.appendMessage(userMessage("第一条"));
  manager.appendMessage(userMessage("第二条"));
  const before = sessionJson(ctx);
  manager.branch(first);
  expect(storedLeaf(ctx)).toBe(first);
  manager.resetLeaf();
  expect(storedLeaf(ctx)).toBeNull();
  expect(sessionJson(ctx)).toBe(before);
  const read = readSessionEntries(ctx);
  expect(read.ok && read.entries.slice(1)).toEqual(manager.getEntries());
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
  const restore = failDatabaseWrites(repositoryDatabase(ctx.dataRoot, ctx.repoId), "records", "namespace", "sessions");
  try { manager.appendMessage(userMessage("写入失败")); } finally { restore(); }
  manager.appendMessage(userMessage("失败后追加"));
  expect(errors).toHaveLength(1);
  expect(() => manager.resetLeaf()).toThrow();
  expect(storedLeaf(ctx)).toBe(id);
  expect(sessionJson(ctx)).not.toContain("失败后追加");
});

test("工具原始结果与结构化提交原样保存，读回条目完全一致", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx); writeCompleteFixture(manager);
  manager.appendMessage(assistantMessage([{ type: "toolCall", id: "submit-1", name: "structured_output", arguments: { verdict: "PASS" } }], "toolUse"));
  const read = readSessionEntries(ctx);
  if (!read.ok) throw new Error(read.detail);
  expect(read.entries.slice(1)).toEqual(manager.getEntries());
  expect(sessionJson(ctx)).toContain("Authorization: Bearer abc123");
  expect(sessionJson(ctx)).toContain("MARKER-XYZ");
});

test("压缩后按 SDK 视图重建上下文，原始完整历史仍保存在私有会话文件", async () => {
  const ctx = await makeRunContext();
  const manager = createSessionManagerForRun(ctx); const ids = writeCompleteFixture(manager);
  manager.appendCompaction("完成了两次工具调用", ids.textCallId, 999);
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("运行任务");
  expect(sessionJson(ctx)).toContain("运行任务");
});

test("会话缺失时读取明确失败", async () => {
  const ctx = await makeRunContext();
  expect(readSessionEntries(ctx)).toMatchObject({ ok: false, reason: "missing" });
});

test.each([null, { header: null }, { header: { type: "invalid", id: "header" } }])("损坏的会话元数据不冒充空记录: %j", async (data) => {
  const ctx = await makeRunContext(); createSessionManagerForRun(ctx); putRecord(sessionRecordRef(ctx), data);
  expect(readSessionEntries(ctx)).toMatchObject({ ok: false, reason: "corrupt" });
});

test.each([
  { type: "message", id: "bad", parentId: "unknown", message: { role: "user", content: "test" } },
  { type: "message", id: "bad", parentId: null, message: { role: "user", content: null } },
])("坏消息或悬空父引用被拒绝: %j", async (entry) => {
  const ctx = await makeRunContext(); createSessionManagerForRun(ctx);
  appendFileSync(sessionFilePath(ctx), `${JSON.stringify(entry)}\n`);
  expect(readSessionEntries(ctx).ok).toBe(false);
});
