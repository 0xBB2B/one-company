import { afterEach, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { repositoryDatabase, withDatabase, UUID_V7_PATTERN, uuidv7 } from "../runtime/database.ts";
import { RunStore } from "../runtime/run-store.ts";
import { appendDecision, readDecisions } from "../runtime/decisions.ts";
import { executeWorkflowAction } from "../runtime/workflow-tool.ts";
import { createSessionManagerForRun, openSessionManagerForRun, readTranscript } from "../runtime/session-records.ts";
import { RelayQueue } from "../daemon/relay-queue.ts";
import { createClock } from "../runtime/clock.ts";
import { RangeClaims } from "../runtime/ranges.ts";
import { WindowRegistry } from "../runtime/windows.ts";
import { writeErrorDetails, readErrorDetails } from "../runtime/error-details.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const { repoId } = await repositoryIdentity(repo.root);
  const repoDir = join(home.dataRoot, "repos", repoId);
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "sqlite-test" });
  const requirement = "2026-09-10.sqlite-business";
  const input = { kind: "requirement" as const, requirement, task: "需求代理", cwd: repo.root, writePaths: [], readPaths: [repo.root], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] };
  return { repo, home, repoId, repoDir, clock, store, requirement, input };
}

test("公开工作流和决策入口直接读写 SQLite，两个需求启动只产生一个活动运行", async () => {
  const w = await fixture();
  const ctx = { dataRoot: w.home.dataRoot, cwd: w.repo.root };
  expect((await executeWorkflowAction({ action: "init", requirement: w.requirement }, ctx)).details.isError).toBe(false);
  const decisions = await Promise.all(Array.from({ length: 5 }, (_, i) => appendDecision({ requirement: w.requirement, actor: "user", source: "用户", trigger: "确认", decision: `确认 ${i}`, effects: ["scope"], alternatives: [], impact: "无" }, ctx)));
  expect(new Set(decisions.map((receipt) => receipt.decisionId)).size).toBe(5);
  expect(decisions.every((receipt) => UUID_V7_PATTERN.test(receipt.recordId))).toBe(true);
  expect(await readDecisions({ ...ctx, requirement: w.requirement, actor: "user" })).toHaveLength(5);
  const started = await Promise.all([w.store.createOrReuseRequirement(w.input), w.store.createOrReuseRequirement(w.input)]);
  expect(started[0]!.run.id).toBe(started[1]!.run.id);
  expect(started.map((result) => result.reused).sort()).toEqual([false, true]);
  expect((await readdir(w.repoDir)).every((name) => name.startsWith("data.sqlite"))).toBe(true);
});

test("SDK 会话与原始错误详情从 SQLite 恢复，不生成会话或诊断文件", async () => {
  const w = await fixture();
  const run = await w.store.create(w.input);
  const ref = { dataRoot: w.home.dataRoot, repoId: w.repoId, runId: run.id };
  const session = createSessionManagerForRun({ ...ref, cwd: w.repo.root });
  session.appendMessage({ role: "user", content: [{ type: "text", text: "可恢复的对话" }], timestamp: Date.now() });
  expect(session.getSessionFile()).toBeUndefined();
  const restored = openSessionManagerForRun(ref);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(restored.detail);
  expect(restored.manager.getEntries()).toEqual(session.getEntries());
  const transcript = readTranscript(ref);
  expect(transcript.ok && transcript.entries[0]?.summary).toBe("可恢复的对话");
  const saved = await writeErrorDetails(ref, { runId: run.id, model: run.model, error: new Error("原始失败") });
  expect(saved.saved).toBe(true);
  const details = await readErrorDetails(ref);
  expect(details.readable && details.details.original.message).toBe("原始失败");
  expect((await readdir(w.repoDir)).every((name) => name.startsWith("data.sqlite"))).toBe(true);
});

test("多个运行存储实例交错登记回合与命令不丢失活动", async () => {
  const w = await fixture();
  const run = await w.store.create(w.input);
  const other = new RunStore({ dataRoot: w.home.dataRoot, repoId: w.repoId, daemonStartedAt: "other" });
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const store = index % 2 ? w.store : other;
    return Promise.all([store.recordTurn(run.id), store.recordCommand(run.id, `command-${index}`)]);
  }));
  const found = await w.store.get(run.id);
  if (!found.ok) throw new Error(found.reason);
  expect(found.run.turns).toBe(20);
  expect(new Set(found.run.commands).size).toBe(20);
});

test("两实例中继首答唯一，回执合并且重建实例可查询", async () => {
  const w = await fixture();
  const options = { dataDir: w.repoDir, deliver: async () => [], locateRequirementAgent: () => undefined };
  const a = new RelayQueue(options); const b = new RelayQueue(options);
  const run = await w.store.create(w.input);
  const question = await a.ask({ requirement: w.requirement, repoId: w.repoId, runId: run.id, question: "确认？", options: [], recommended: "确认" });
  const answers = await Promise.all([b.answer(question.id, "确认", uuidv7()), a.answer(question.id, "取消", uuidv7())]);
  expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  expect((await question.answer).answered).toBe(true);
  const notice = await a.notify({ requirement: w.requirement, repoId: w.repoId, runId: run.id, kind: "completed", message: "完成" });
  await Promise.all([a.markDelivered("窗口甲", notice.id), b.markDelivered("窗口乙", notice.id)]);
  const record = withDatabase(repositoryDatabase(w.home.dataRoot, w.repoId), (db) => db.read<{ deliveredTo: string[] }>("relay_notices", notice.id));
  expect(record?.data.deliveredTo.sort()).toEqual(["窗口乙", "窗口甲"].sort());
  expect(await b.pendingFor({ windowId: "新窗口", repoIds: [w.repoId] })).toEqual({ questions: [], notices: [] });
});

test("跨实例占用互斥，注销后的迟到心跳不能复活窗口", async () => {
  const w = await fixture();
  const options = { repoRoot: w.repo.root, repoDir: w.repoDir, clock: w.clock, runState: async () => "running", holderGone: async () => ({ gone: false as const, reason: "存活" }), activeShellTasks: async () => 0 };
  const a = new RangeClaims(options); const b = new RangeClaims(options);
  const first = await a.claim({ kind: "role", runId: uuidv7(), requirement: w.requirement }, ["README.md"]);
  const second = await b.claim({ kind: "role", runId: uuidv7(), requirement: w.requirement }, ["README.md"]);
  expect(first.granted).toBe(true); expect(second.granted).toBe(false);
  const windows = new WindowRegistry({ repoDir: w.repoDir, clock: w.clock, bootId: async () => "boot", processStartedAt: async () => "start" });
  const windowId = uuidv7();
  await windows.register({ windowId, pid: process.pid, sessionId: "sdk-session", cwd: w.repo.root, workspaceRoot: w.repo.root });
  await windows.unregister(windowId); await windows.heartbeat(windowId);
  expect(await windows.isAlive(windowId)).toBe(false);
});
