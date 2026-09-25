import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { checkExploreSession } from "../runtime/explore-session.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function world() {
  const w = await createPmRunWorld(cleanups);
  const workspace = await realpath(w.fixture.state.read(w.fixture.requirementId).data.workspace!.path);
  const readme = join(workspace, "README.md");
  await writeFile(readme, "pi-company 检索夹具：登录模块在 src/auth。\n");
  const other = join(w.fixture.root, "OTHER.md");
  await writeFile(other, "工作区以外的文件\n");
  const hashOf = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const research = (path: string, fileHash: string) => ({ conclusions: ["登录模块在 src/auth"], sources: [{ kind: "local_file", indexBaseline: "not_applicable", path, fileHash,
    startLine: 1, endLine: 1 }], searchedScope: { kind: "local_file", paths: [path] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] });
  const submit = (path: string, fileHash: string) => ({ type: "toolcall" as const, name: "pi_company_result_submit", input: { action: "research", result: research(path, fileHash) } });
  const exploreRequest = (requests: Context[]) => requests.find((request) => request.systemPrompt?.includes("检索来源：直接读取本地文件"));
  return { ...w, workspace, readme, other, hashOf, submit, exploreRequest };
}
const text = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("M7-AC15/AC17：PM 派出 explore 只拿到问题、线索与工作区范围，不含 prod 正文与 PM 会话；结果非阻塞地注入 PM 会话并标明不是 PASS", async () => {
  const w = await world();
  const fileHash = await w.hashOf(w.readme);
  w.provider.queue.push(w.submit(w.readme, fileHash), { type: "text", text: "PM 收到检索结果" });
  const dispatched = await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "登录模块在哪里", clues: ["可能在 src/auth"], source: { kind: "local_file" } }, maxTurns: 3 });
  expect(dispatched.maxTurns).toBe(3);
  await until(() => w.provider.requests.some((request) => text(request).includes("explore-report")));
  const request = w.exploreRequest(w.provider.requests)!;
  expect(request.systemPrompt).toContain("登录模块在哪里");
  expect(request.systemPrompt).toContain(`在 ${w.workspace} 内查看`);
  expect(JSON.stringify(request)).not.toContain("输入正确验证码后成功");
  expect(JSON.stringify(request)).not.toContain("等待核对");
  expect(request.tools?.map((tool) => tool.name).sort()).toEqual(["grep", "pi_company_result_submit", "read"]);
  const report = w.provider.requests.find((entry) => text(entry).includes("explore-report"))!;
  expect(text(report)).toContain("research 不是 PASS");
  expect(text(report)).toContain("登录模块在 src/auth");
  const run = await w.runStore.get(dispatched.runId);
  expect(run.ok && run.run).toMatchObject({ role: "pi-company.explore", parentRunId: w.pm.runId, state: "completed" });
  expect(checkExploreSession({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, dispatched.runId)).toMatchObject({ current: false, reason: "session_ended" });
});

test("M7-AC15/AC29：explore 读取工作区以外的文件被拒；到限后自动上报派出它的 PM", async () => {
  const w = await world();
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: w.other } }, { type: "text", text: "PM 收到到限报告" });
  await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "登录模块在哪里", clues: [], source: { kind: "local_file" } }, maxTurns: 1 });
  await until(() => w.provider.requests.some((request) => text(request).includes("turn_limit_reached")));
  expect(JSON.stringify(w.provider.requests)).not.toContain("工作区以外的文件");
});

test("M7-AC15/AC18：main 派出的 explore 只交给派出它的会话，取走即删；窗口关闭时停止运行中的 explore 且结果作废", async () => {
  const w = await world();
  const readme = join(await realpath(w.fixture.repositoryRoot), "README.md");
  const fileHash = await w.hashOf(readme);
  const parent = { role: "main" as const, sessionId: "session-a", connectionId: "connection-a", model: { provider: "team-model", id: "test" }, thinking: "off" };
  w.manager.connectionOpened("connection-a");
  w.provider.queue.push(w.submit(readme, fileHash));
  const first = await w.manager.dispatchExplore({ parent, request: { question: "仓库说明写了什么", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await until(() => w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === first.runId));
  expect(w.emit.mock.calls.find(([event]) => event === "explore.finished")![1]).toEqual({ runId: first.runId, parentSessionId: "session-a" });
  expect(() => w.manager.takeMainExploreReport(first.runId, "connection-b")).toThrow();
  expect(w.manager.takeMainExploreReport(first.runId, "connection-a")).toMatchObject({ kind: "explore-report", outcome: "completed", research: { conclusions: ["登录模块在 src/auth"] } });
  expect(() => w.manager.takeMainExploreReport(first.runId, "connection-a")).toThrow();
  expect((await w.runStore.get(first.runId)).ok).toBe(false);

  w.provider.queue.push({ type: "text", text: "慢慢查", chunkDelayMs: 3_000 });
  const second = await w.manager.dispatchExplore({ parent, request: { question: "再查一次", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await w.manager.abandonMainExplores({ connectionId: "connection-a" });
  expect(() => w.manager.takeMainExploreReport(second.runId, "connection-a")).toThrow();
  expect(checkExploreSession({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, second.runId)).toMatchObject({ current: false });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  expect(w.emit.mock.calls.some(([event, data]) => event === "explore.finished" && (data as { runId: string }).runId === second.runId)).toBe(false);
});

test("M7-AC16：research 引用的本地文件 hash 由宿主按实际内容核对，不符即拒收；轮次上限须为正整数", async () => {
  const w = await world();
  w.provider.queue.push(w.submit(w.readme, "0".repeat(64)), { type: "text", text: "hash 被拒" }, { type: "text", text: "PM 收到" });
  await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "登录模块在哪里", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await until(() => w.provider.requests.some((request) => text(request).includes("invalid_binding")));
  await expect(w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "看看", clues: [], source: { kind: "local_file" } }, maxTurns: 0 })).rejects.toMatchObject({ code: "invalid_params" });
});

test("M7-AC18：PM 停止（撤权或被接管）时它派出的 explore 随之停止，检索会话失效，迟到结果不能提交", async () => {
  const w = await world();
  w.provider.queue.push({ type: "text", text: "慢慢查", chunkDelayMs: 3_000 });
  const explore = await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "登录模块在哪里", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await until(async () => { const run = await w.runStore.get(explore.runId); return run.ok && run.run.state === "running"; });
  await w.manager.stop(w.pm.runId);
  const run = await w.runStore.get(explore.runId);
  expect(run.ok && run.run.state).toBe("stopped");
  expect(checkExploreSession({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, explore.runId)).toMatchObject({ current: false });
});

test("M7-AC18：main 派出途中发起连接已断开时立即作废；PM 因失败结束时它派出的 explore 随之停止", async () => {
  const w = await world();
  const readme = join(w.fixture.repositoryRoot, "README.md");
  w.provider.queue.push({ type: "text", text: "慢慢查", chunkDelayMs: 3_000 });
  await expect(w.manager.dispatchExplore({ parent: { role: "main", sessionId: "s", connectionId: "gone", model: { provider: "team-model", id: "test" }, thinking: "off" },
    request: { question: "仓库说明", clues: [], source: { kind: "local_file" } }, maxTurns: 2 })).rejects.toMatchObject({ code: "not_found" });

  w.provider.queue.push({ type: "text", text: "慢慢查", chunkDelayMs: 3_000 });
  const explore = await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
    request: { question: "登录模块在哪里", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await (w.manager as unknown as { finishPm(runId: string, state: "failed", reason: string): Promise<void> }).finishPm(w.pm.runId, "failed", "lease_lost");
  const run = await w.runStore.get(explore.runId);
  expect(run.ok && run.run.state).toBe("stopped");
});

test("M7-AC16：PM 与 explore 都可调用 knowledge_query 查询主仓库索引，窗口不在线也可用；结果标注索引代次", async () => {
  const w = await createPmRunWorld(cleanups, { index: true });
  const pmTools = w.provider.requests.find((request) => request.tools?.some((tool) => tool.name === "pi_company_workflow_manage"))!.tools!.map((tool) => tool.name);
  expect(pmTools).toContain("pi_company_knowledge_query");
  w.provider.queue.push({ type: "toolcall", name: "pi_company_knowledge_query", input: { query: { action: "facts" } } }, { type: "text", text: "查完" },
    { type: "text", text: "PM 收到" });
  await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId }, request: { question: "项目有哪些文件", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
  await until(() => w.provider.requests.some((request) => text(request).includes("knowledge-facts/v1")));
  const explore = w.provider.requests.find((request) => request.systemPrompt?.includes("检索来源：直接读取本地文件"))!;
  expect(explore.tools?.map((tool) => tool.name).sort()).toEqual(["grep", "pi_company_knowledge_query", "pi_company_result_submit", "read"]);
  const reply = w.provider.requests.find((request) => text(request).includes("knowledge-facts/v1"))!;
  expect(text(reply)).toMatch(/\\"generation\\":[1-9]/u);
});
