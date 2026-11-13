import { expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentManageTool } from "../src/modules/explore/agent-manage-extension.ts";
import { registerWorkflowManageTool } from "../src/modules/delivery/workflow-manage-extension.ts";
import type { WorkspaceClientsHandle } from "../src/core/host/daemon-client.ts";

const REPO = "a".repeat(64);
const REQ = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const RUN = "0197b7b0-6a20-7c51-8a32-b9465fb72d11";

type Tool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }>; details: unknown }> };

function setup(register: (pi: ExtensionAPI, context: () => { clients: WorkspaceClientsHandle }) => void, respond: (method: string, params: unknown) => unknown) {
  let tool: Tool | undefined;
  const calls: Array<[string, unknown]> = [];
  const pi = { registerTool: (registered: Tool) => { tool = registered; }, getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
  const clients = { forRepo: () => ({ call: async (method: string, params: unknown) => { calls.push([method, params]); return respond(method, params); } }) } as unknown as WorkspaceClientsHandle;
  register(pi, () => ({ clients }));
  const ctx = { model: { provider: "prov", id: "mod" } };
  const run = async (params: unknown) => {
    const result = await tool!.execute("t", params, undefined, undefined, ctx);
    return { text: result.content[0]!.text, content: JSON.parse(result.content[0]!.text) as unknown, details: result.details };
  };
  return { run, calls };
}

const explore = { action: "dispatch", role: "explore", repoId: REPO, question: "登录在哪", maxTurns: 30 };

test("agent_manage 派 explore：content 正好是 runId，details 另有 maxTurns", async () => {
  const full = { runId: RUN, maxTurns: 30 };
  const w = setup(registerAgentManageTool, () => full);
  const result = await w.run(explore);
  expect(result.content).toEqual({ runId: RUN });
  expect(result.details).toEqual(full);
});

test("agent_manage 派 PM：content 正好是 runId，details 另有 fence", async () => {
  const full = { runId: RUN, fence: 2 };
  const w = setup(registerAgentManageTool, () => full);
  const result = await w.run({ action: "dispatch", role: "pm", repoId: REPO, requirementId: REQ });
  expect(result.content).toEqual({ runId: RUN });
  expect(result.details).toEqual(full);
});

test("agent_manage status：content 正好是 run 的 state、stateReason、turns、log，details 是完整返回", async () => {
  const full = { run: { id: RUN, kind: "pm", requirement: REQ, state: "running", stateReason: "x", stopCause: { reason: "main_agent" }, startedAt: 1, updatedAt: 2, turns: 3,
    usage: { input: 10, output: 5 }, log: "/日志路径" } };
  const w = setup(registerAgentManageTool, () => full);
  const result = await w.run({ action: "status", repoId: REPO, runId: RUN });
  expect(result.content).toEqual({ run: { state: "running", stateReason: "x", turns: 3, log: "/日志路径" } });
  expect(result.details).toEqual(full);
});

test("agent_manage status 查主窗口检索：run 里没有的保留字段不写，delivery 只在 details", async () => {
  const full = { run: { id: RUN, kind: "explore", state: "running", turns: 2, delivery: "检索结果正文" } };
  const w = setup(registerAgentManageTool, () => full);
  const result = await w.run({ action: "status", repoId: REPO, runId: RUN });
  expect(result.content).toEqual({ run: { state: "running", turns: 2 } });
  expect(result.details).toEqual(full);
});

test.each([
  ["pause", { action: "pause", repoId: REPO, runId: RUN }],
  ["resume", { action: "resume", repoId: REPO, runId: RUN }],
  ["stop", { action: "stop", repoId: REPO, runId: RUN }],
  ["message", { action: "message", repoId: REPO, requirementId: REQ, text: "说明" }],
])("agent_manage %s：content 与 JSON.stringify(返回值) 逐字相同，details 等于返回值", async (_name, params) => {
  const full = { run: { id: RUN, state: "paused", extra: { a: 1 } }, accepted: true };
  const w = setup(registerAgentManageTool, () => full);
  const result = await w.run(params);
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

test("agent_manage 参数不合格时报错文字不变", async () => {
  const w = setup(registerAgentManageTool, () => ({}));
  await expect(w.run({ action: "status", repoId: REPO })).rejects.toThrow("原因：参数不符合该动作的格式");
});

const CLOSE = { action: "close", repoId: REPO, requirementId: REQ, reason: "completed", receiptId: RUN };

test("workflow_manage close 已关闭：content 保留 status、message、archive.status，operationId、reason、archive.path 只在 details", async () => {
  const full = { result: { status: "closed", operationId: RUN, reason: "completed", archive: { path: "docs/prd/a.md", status: "archived" }, message: "需求已关闭" } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run(CLOSE);
  expect(result.content).toEqual({ result: { status: "closed", message: "需求已关闭", archive: { status: "archived" } } });
  expect(result.text).toMatch(/"status":"closed"/);
  expect(result.details).toEqual(full);
});

test("workflow_manage close 以取消关闭、没有归档：content 里 archive 照写 null", async () => {
  const full = { result: { status: "closed", operationId: RUN, reason: "cancelled", archive: null, message: "已取消" } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run(CLOSE);
  expect(result.content).toEqual({ result: { status: "closed", message: "已取消", archive: null } });
  expect(result.details).toEqual(full);
});

test("workflow_manage close 已关闭但归档卡住：archive 里保留 status、reason、next", async () => {
  const full = { result: { status: "closed", operationId: RUN, reason: "completed", message: "已关闭，归档没办完",
    archive: { path: "docs/prd/a.md", status: "blocked", reason: "工作区有未提交改动", next: "提交后再 close" } } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run(CLOSE);
  expect(result.content).toEqual({ result: { status: "closed", message: "已关闭，归档没办完", archive: { status: "blocked", reason: "工作区有未提交改动", next: "提交后再 close" } } });
  expect(result.text).toMatch(/"status":"closed"/);
  expect(result.details).toEqual(full);
});

test("workflow_manage close 被拒绝：content 正好是 status、missing、next", async () => {
  const full = { result: { status: "rejected", missing: ["缺决定"], next: "先登记决定" } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run(CLOSE);
  expect(result.content).toEqual(full);
  expect(result.details).toEqual(full);
});

test("workflow_manage close 办到一半：content 保留 status、pending、next，operationId 只在 details", async () => {
  const full = { result: { status: "closing", operationId: RUN, pending: ["回收工作区"], next: "再 close 一次" } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run(CLOSE);
  expect(result.content).toEqual({ result: { status: "closing", pending: ["回收工作区"], next: "再 close 一次" } });
  expect(result.details).toEqual(full);
});

test("workflow_manage delivery-check：content 正好是 deliverable、blockers，回执其余字段只在 details", async () => {
  const full = { result: { receiptId: RUN, codeHead: "c".repeat(40), epoch: 4, verificationIds: [RUN], verdictIds: [RUN], approvedPrdHash: "d".repeat(64),
    inputHash: "e".repeat(64), deliverable: false, blockers: ["缺验收记录"] } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run({ action: "delivery-check", repoId: REPO, requirementId: REQ });
  expect(result.content).toEqual({ result: { deliverable: false, blockers: ["缺验收记录"] } });
  expect(result.details).toEqual(full);
});

test("workflow_manage status：content 与 JSON.stringify(返回值) 逐字相同，details 等于返回值", async () => {
  const full = { result: { close: { status: "open", reason: null, operationId: RUN, archive: null, delivery: null } } };
  const w = setup(registerWorkflowManageTool, () => full);
  const result = await w.run({ action: "status", repoId: REPO, requirementId: REQ });
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

test("workflow_manage 参数不合格时报错文字不变", async () => {
  const w = setup(registerWorkflowManageTool, () => ({}));
  await expect(w.run({ action: "close", repoId: REPO, requirementId: REQ })).rejects.toThrow("原因：参数不符合该动作的格式");
});
