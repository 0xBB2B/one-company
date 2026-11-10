import { expect, test, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { agentManageTool, createPmTools } from "../src/app/daemon/pm-tools.ts";
import type { PmToolsInput } from "../src/app/daemon/pm-tools.ts";
import { createSubagentTools } from "../src/modules/pm/subagent-tools.ts";
import { toolFailure, toolStep } from "../src/core/exec/tool-failure.ts";

const world = vi.hoisted(() => {
  const state = { reply: (_tool: string, _params: unknown): unknown => undefined };
  const fake = (name: string) => ({ execute: async (params: unknown) => structuredClone(state.reply(name, params)), dispose() {} });
  return { state, fake };
});
vi.mock("../src/modules/pm/verification-run.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/pm/verification-run.ts")>()), createVerificationRunTool: async () => world.fake("verification_run") }));
vi.mock("../src/modules/verification/change-apply.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/verification/change-apply.ts")>()), createChangeApplyTool: async () => world.fake("change_apply") }));
vi.mock("../src/modules/pm/plan-manage.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/pm/plan-manage.ts")>()), createPlanManageTool: async () => world.fake("plan_manage") }));
vi.mock("../src/modules/delivery/workflow-manage.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/delivery/workflow-manage.ts")>()), createWorkflowManageTool: async () => world.fake("workflow_manage") }));
vi.mock("../src/modules/pm/requirement-read-tool.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/pm/requirement-read-tool.ts")>()), createRequirementReadTool: async () => world.fake("requirement_manage") }));
vi.mock("../src/modules/pm/result-submit.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/modules/pm/result-submit.ts")>()), createResultSubmitTool: () => world.fake("result_submit") }));

const id = (n: number) => `0197b7b0-6a20-7c51-8a32-b9465fb72d${String(n).padStart(2, "0")}`;
const REQ = id(10), RUN = id(11), TASK = id(12), VERIFY = id(13), ROUND = id(14), OP = id(15), REVIEW_RUN = id(16);
const HASH = "a".repeat(64), HEAD = "b".repeat(40);

type Called = { content: Array<{ text: string }>; details: unknown };
const lease = { requirementId: REQ, runId: RUN, workspaceId: HASH, fence: 1 };
const workspace = { workspaceId: HASH, branch: "refs/heads/req", path: "/tmp/ws" };
const dirs = { repositoryRoot: "/tmp/repo", dataRoot: "/tmp/data", repoId: HASH };

async function pmTools(agents: Partial<PmToolsInput["agents"]> = {}) {
  const built = await createPmTools({ ...dirs, deliveryMode: async () => "remote" as const, lease, workspace, epoch: 1, alive: () => true, checkLease: async () => {},
    currentBaseline: () => ({}), agents: { dispatch: async () => ({}), explore: async () => ({}), control: async () => ({}), catalog: async () => ({}), ...agents } } as never);
  return (name: string) => built.tools.find((tool) => tool.name === `one_company_${name}`)!;
}
async function subagentTools(role: "worker" | "reviewer" | "qa") {
  const task = { taskId: TASK, requirementId: REQ, role: role === "reviewer" ? "worker" : role, writePaths: ["src/"], attempts: [] };
  const built = await createSubagentTools({ ...dirs, runId: RUN, pmLease: lease, workspace, epoch: 1, task, alive: () => true,
    ...(role === "reviewer" ? { review: { attemptRunId: REVIEW_RUN } } : {}) } as never);
  return (name: string) => built.tools.find((tool) => tool.name === `one_company_${name}`)!;
}
async function call(tool: ToolDefinition, params: unknown, full: unknown): Promise<{ sent: unknown; text: string; details: unknown }> {
  world.state.reply = () => full;
  const result = await (tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", params);
  return { sent: JSON.parse(result.content[0]!.text), text: result.content[0]!.text, details: result.details };
}

const verification = (patch: Record<string, unknown> = {}) => ({ verificationId: VERIFY, kind: "formal", status: "passed", checkRoundId: ROUND, exitCode: 0, signal: null, reason: null, invalidation: null,
  baseline: { revision: 1, codeHead: HEAD, inputHash: HASH, inputCount: 3 }, performance: { applicable: false, reason: "纯逻辑" }, outputRoot: "/tmp/out", startedAt: 100, finishedAt: 200,
  output: { stdout: { text: "ok\n", truncated: false }, stderr: { text: "warn\n", truncated: true } }, ...patch });
const verificationSent = (full: Record<string, unknown>) => {
  const { baseline: _b, performance: _p, outputRoot: _o, startedAt: _s, finishedAt: _f, ...kept } = full;
  return kept;
};

test.each(["run", "stop", "status"] as const)("PM 的 verification_run %s：content 去掉 baseline、performance、outputRoot、startedAt、finishedAt，其余字段与完整结果相同，details 是完整结果", async (action) => {
  const tool = (await pmTools())("verification_run");
  const full = verification({ invalidation: { reason: "interrupted", detail: "被中断" }, status: "failed", exitCode: 1, signal: "SIGTERM", reason: "命令失败" });
  const params = action === "run" ? { action, kind: "formal", command: "pnpm test", performance: { applicable: false, reason: "x" } } : { action, verificationId: VERIFY };
  const result = await call(tool, params, full);
  expect(result.sent).toStrictEqual(verificationSent(full));
  expect(result.sent).toMatchObject({ verificationId: VERIFY, checkRoundId: ROUND, kind: "formal", status: "failed", exitCode: 1, signal: "SIGTERM", reason: "命令失败",
    invalidation: { reason: "interrupted", detail: "被中断" }, output: { stdout: { text: "ok\n", truncated: false }, stderr: { text: "warn\n", truncated: true } } });
  expect(result.details).toEqual(full);
});

test.each(["worker", "reviewer", "qa"] as const)("%s 的 verification_run：运行中 output 为 null 照发，调试检查的 checkRoundId 为 null 照发", async (role) => {
  const tool = (await subagentTools(role))("verification_run");
  const full = verification({ kind: role === "qa" ? "formal" : "debug", status: "running", checkRoundId: role === "qa" ? ROUND : null, exitCode: null, finishedAt: null, output: null });
  const result = await call(tool, { action: "status", verificationId: VERIFY }, full);
  expect(result.sent).toStrictEqual(verificationSent(full));
  expect(result.sent).toHaveProperty("output", null);
  expect(result.sent).toHaveProperty("exitCode", null);
  expect(result.details).toEqual(full);
});

test("verification_run 失败时报错文字与改前相同，不经过取视图", async () => {
  const tool = (await pmTools())("verification_run");
  const failure = new Error("沙箱起不来");
  world.state.reply = () => { throw failure; };
  const expected = toolFailure(toolStep("one_company_verification_run", { action: "status", verificationId: VERIFY }), failure).message;
  await expect((tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", { action: "status", verificationId: VERIFY })).rejects.toThrow(expected);
});

const applied = (patch: Record<string, unknown> = {}) => ({ status: "partial_failure", operationId: OP, baseHead: HEAD, files: [
  { path: "src/a.ts", baseHash: HASH, targetHash: "c".repeat(64), status: "written" },
  { path: "src/b.ts", baseHash: "absent", targetHash: "d".repeat(64), status: "stale", reason: "文件已被改动" },
] , ...patch });

test("change_apply prepare：content 的 files 每项只有 path、baseHash，没有 baseHead 和 targetHash，details 是完整结果", async () => {
  const tool = (await subagentTools("worker"))("change_apply");
  const full = { status: "ready", baseHead: HEAD, files: [{ path: "src/a.ts", baseHash: HASH, targetHash: "c".repeat(64) }, { path: "src/new.ts", baseHash: "absent", targetHash: "d".repeat(64) }] };
  const result = await call(tool, { action: "prepare", files: [{ path: "src/a.ts", content: "x" }] }, full);
  expect(result.sent).toStrictEqual({ status: "ready", files: [{ path: "src/a.ts", baseHash: HASH }, { path: "src/new.ts", baseHash: "absent" }] });
  expect(result.details).toEqual(full);
});

test.each(["apply", "import", "status"] as const)("change_apply %s：content 有 operationId、status，files 每项只有 path、status，reason 有时才带，没有 baseHead、baseHash、targetHash", async (action) => {
  const tool = (await subagentTools("worker"))("change_apply");
  const full = applied();
  const params = action === "status" ? { action, operationId: OP } : { action, files: [{ path: "src/a.ts", content: "x" }] };
  const result = await call(tool, params, full);
  expect(result.sent).toStrictEqual({ operationId: OP, status: "partial_failure", files: [{ path: "src/a.ts", status: "written" }, { path: "src/b.ts", status: "stale", reason: "文件已被改动" }] });
  expect(result.details).toEqual(full);
});

test("change_apply 写入全部成功时 files 每项没有 reason 字段", async () => {
  const tool = (await subagentTools("worker"))("change_apply");
  const full = applied({ status: "applied", files: [{ path: "src/a.ts", baseHash: HASH, targetHash: "c".repeat(64), status: "written" }] });
  const result = await call(tool, { action: "apply", files: [{ path: "src/a.ts", content: "x" }] }, full);
  expect(result.sent).toStrictEqual({ operationId: OP, status: "applied", files: [{ path: "src/a.ts", status: "written" }] });
});

test("change_apply 失败时报错文字与改前相同", async () => {
  const tool = (await subagentTools("worker"))("change_apply");
  const failure = new Error("写入中途报错");
  world.state.reply = () => { throw failure; };
  const params = { action: "apply", files: [{ path: "src/a.ts", content: "x" }] };
  await expect((tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", params))
    .rejects.toThrow(toolFailure(toolStep("one_company_change_apply", params), failure).message);
});

const task = (patch: Record<string, unknown> = {}) => ({ format: "plan-task/v1", taskId: TASK, requirementId: REQ, version: 2, key: "login", role: "worker",
  goalUnitIds: ["goal.login"], constraintUnitIds: ["constraint.a"], closure: [{ unitId: "goal.login", hash: HASH }], dependsOn: [id(20)], writePaths: ["src/login/"], blockedByQuestionIds: [id(21)], maxTurns: 5,
  agent: "ui-worker", agentReason: "界面任务", reviewers: [{ agent: "ui-reviewer", reason: "界面审查", auto: true }],
  detail: { path: "/tmp/detail.json", hash: HASH },
  status: "completed",
  attempts: [{ runId: RUN, maxTurns: 5, turnsUsed: 4, reason: "首次", outcome: "completed", rework: true, escalation: "卡住了" }],
  reviews: [{ runId: REVIEW_RUN, attemptRunId: RUN, maxTurns: 3, turnsUsed: 2, agent: "reviewer", round: 1, outcome: "clear", skipReason: "missing" }],
  userDecision: { decisionId: id(22), choice: "retry", maxTurns: 6, revision: 1, taskVersion: 2, usedByRunId: null, notified: true, round: 1, escalation: "原话" },
  sizeHold: ["任务偏大"], holdNote: "先拆", attemptBase: 1, cycleStarts: [1], replanAllowance: 1, lastAssessedRevision: 1, updatedAt: 99, ...patch });
const plan = (patch: Record<string, unknown> = {}) => ({ format: "plan/v1", requirementId: REQ, planVersion: 3, confirmedVersion: 2, confirmedTasks: [{ taskId: TASK, version: 2 }],
  taskIds: [TASK], knownUnits: [{ unitId: "goal.login", hash: HASH }], prdRevision: 1, confirmedRevision: 1, updatedAt: 98, ...patch });
const taskSent = {
  taskId: TASK, version: 2, key: "login", status: "completed", role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: ["constraint.a"], dependsOn: [id(20)], writePaths: ["src/login/"],
  blockedByQuestionIds: [id(21)], maxTurns: 5, agent: "ui-worker", agentReason: "界面任务", reviewers: [{ agent: "ui-reviewer", reason: "界面审查", auto: true }],
  attempts: [{ runId: RUN, outcome: "completed", turnsUsed: 4 }],
  reviews: [{ runId: REVIEW_RUN, outcome: "clear", turnsUsed: 2, agent: "reviewer" }],
  sizeHold: ["任务偏大"], holdNote: "先拆", userDecision: { choice: "retry", maxTurns: 6 },
};
const DROPPED_TASK_KEYS = ["format", "requirementId", "closure", "attemptBase", "cycleStarts", "replanAllowance", "lastAssessedRevision", "updatedAt"];

test.each(["propose", "update", "confirm"] as const)("PM 的 plan_manage %s：content 的 plan 只有 planVersion、confirmedVersion，tasks 每项没有 closure、format、requirementId、updatedAt 等内部字段和 detail 的 path、hash，details 是完整结果", async (action) => {
  const tool = (await pmTools())("plan_manage");
  const full = { plan: plan(), tasks: [task()] };
  const params = action === "propose" ? { action, tasks: [] } : action === "update" ? { action, tasks: [] } : { action, planVersion: 3 };
  const result = await call(tool, params, full) as { sent: { plan: unknown; tasks: Array<Record<string, any>> }; details: unknown };
  expect(result.sent.plan).toStrictEqual({ planVersion: 3, confirmedVersion: 2 });
  expect(result.sent.tasks).toHaveLength(1);
  const sent = result.sent.tasks[0]!;
  expect({ ...sent, detail: undefined }).toEqual(taskSent);
  for (const key of DROPPED_TASK_KEYS) expect(sent).not.toHaveProperty(key);
  expect(sent.detail?.path).toBeUndefined();
  expect(sent.detail?.hash).toBeUndefined();
  expect(sent.attempts[0]).not.toHaveProperty("maxTurns");
  expect(sent.attempts[0]).not.toHaveProperty("escalation");
  expect(sent.reviews[0]).not.toHaveProperty("attemptRunId");
  expect(sent.reviews[0]).not.toHaveProperty("round");
  expect(sent.userDecision).not.toHaveProperty("decisionId");
  expect(result.sent).not.toHaveProperty("chances");
  expect(result.details).toEqual(full);
});

test("plan_manage read：tasks 的 detail 只有 objective、passCriteria、scope、performance，没有 path 和 hash", async () => {
  const tool = (await pmTools())("plan_manage");
  const detail = { hash: HASH, objective: "实现登录", passCriteria: ["能登录"], scope: { in: ["login"], out: ["注册"] }, performance: { applicable: false, reason: "无" } };
  const full = { plan: plan(), tasks: [task({ detail })] };
  const result = await call(tool, { action: "read" }, full) as { sent: { tasks: Array<Record<string, any>> }; details: unknown };
  expect(result.sent.tasks[0]!.detail).toStrictEqual({ objective: "实现登录", passCriteria: ["能登录"], scope: { in: ["login"], out: ["注册"] }, performance: { applicable: false, reason: "无" } });
  expect({ ...result.sent.tasks[0], detail: undefined }).toEqual(taskSent);
  expect(result.details).toEqual(full);
});

test("reviewer 的 plan_manage read 同样发视图", async () => {
  const tool = (await subagentTools("reviewer"))("plan_manage");
  const detail = { hash: HASH, objective: "实现登录", passCriteria: ["能登录"], scope: { in: ["login"], out: [] }, performance: { applicable: false, reason: "无" } };
  const full = { plan: plan(), tasks: [task({ detail })] };
  const result = await call(tool, { action: "read" }, full) as { sent: { plan: unknown; tasks: Array<Record<string, any>> } };
  expect(result.sent.plan).toStrictEqual({ planVersion: 3, confirmedVersion: 2 });
  expect(result.sent.tasks[0]).not.toHaveProperty("closure");
  expect(result.sent.tasks[0]!.detail).not.toHaveProperty("path");
});

test("plan_manage update 改了已执行过的任务时 content 顶层带 chances，值与完整结果相同", async () => {
  const tool = (await pmTools())("plan_manage");
  const chances = ["login 开始新的计数周期：重新计 2 次执行机会和 1 次返修机会"];
  const full = { plan: plan(), tasks: [task()], chances };
  const result = await call(tool, { action: "update", tasks: [] }, full) as { sent: Record<string, unknown> };
  expect(result.sent.chances).toEqual(chances);
  expect(result.sent.plan).toStrictEqual({ planVersion: 3, confirmedVersion: 2 });
});

test("plan_manage assess-update：与其他动作一样只发视图", async () => {
  const tool = (await pmTools())("plan_manage");
  const full = { plan: plan({ planVersion: 4 }), tasks: [task({ status: "needs_update", lastAssessedRevision: 2 })] };
  const result = await call(tool, { action: "assess-update", revision: 2, tasks: [] }, full) as { sent: { plan: unknown; tasks: Array<Record<string, any>> }; details: unknown };
  expect(result.sent.plan).toStrictEqual({ planVersion: 4, confirmedVersion: 2 });
  expect(result.sent.tasks[0]).toMatchObject({ taskId: TASK, status: "needs_update" });
  expect(result.sent.tasks[0]).not.toHaveProperty("lastAssessedRevision");
  expect(result.details).toEqual(full);
});

test("plan_manage 任务没有 agent、reviewers、userDecision、sizeHold 时视图里也不出现这些字段", async () => {
  const tool = (await pmTools())("plan_manage");
  const bare = task();
  for (const key of ["agent", "agentReason", "reviewers", "userDecision", "sizeHold", "holdNote"]) delete (bare as Record<string, unknown>)[key];
  const result = await call(tool, { action: "read" }, { plan: plan({ confirmedVersion: null }), tasks: [{ ...bare, attempts: [], reviews: [] }] }) as { sent: { plan: unknown; tasks: Array<Record<string, any>> } };
  expect(result.sent.plan).toStrictEqual({ planVersion: 3, confirmedVersion: null });
  for (const key of ["agent", "agentReason", "reviewers", "userDecision", "sizeHold", "holdNote"]) expect(result.sent.tasks[0]).not.toHaveProperty(key);
  expect(result.sent.tasks[0]).toMatchObject({ attempts: [], reviews: [] });
});

test("plan_manage 没有计划时 content 是 {\"plan\":null}，details 是完整结果", async () => {
  const tool = (await pmTools())("plan_manage");
  const result = await call(tool, { action: "read" }, { plan: null });
  expect(result.text).toBe("{\"plan\":null}");
  expect(result.details).toEqual({ plan: null });
});

test("plan_manage 失败时报错文字与改前相同", async () => {
  const tool = (await pmTools())("plan_manage");
  const failure = new Error("没有实施授权");
  world.state.reply = () => { throw failure; };
  await expect((tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", { action: "read" }))
    .rejects.toThrow(toolFailure(toolStep("one_company_plan_manage", { action: "read" }), failure).message);
});

const round = (patch: Record<string, unknown> = {}) => ({ checkRoundId: ROUND, requirementId: REQ, status: "open", baseline: { revision: 1, codeHead: HEAD, inputHash: HASH, inputCount: 3 },
  invalidation: null, decision: null, verifications: [VERIFY], active: [id(30)], ...patch });
const roundSent = (full: Record<string, unknown>) => { const { baseline: _b, requirementId: _r, ...kept } = full; return kept; };

test.each([
  ["advance", { action: "advance" }, round()],
  ["finish", { action: "finish", checkRoundId: ROUND }, round({ status: "released" })],
  ["check-decision", { action: "check-decision", checkRoundId: ROUND, kind: "defer", revision: 2 }, round({ decision: { kind: "defer", revision: 2, at: 5 }, invalidation: { reason: "interrupted", detail: "有新版本" } })],
])("PM 的 workflow_manage %s：content 没有 baseline、requirementId，其余检查轮字段都在，details 是完整结果", async (_action, params, full) => {
  const tool = (await pmTools())("workflow_manage");
  const result = await call(tool, params, full);
  expect(result.sent).toStrictEqual(roundSent(full));
  expect(result.details).toEqual(full);
});

test("PM 的 workflow_manage delivery-check：content 只有 deliverable、blockers、suggestions", async () => {
  const tool = (await pmTools())("workflow_manage");
  const full = { format: "delivery-receipt/v1", receiptId: id(40), requirementId: REQ, repoId: HASH, workspaceId: HASH, branch: "refs/heads/req", epoch: 1, revision: 1, approvedPrdHash: HASH,
    codeHead: HEAD, inputHash: HASH, checkRoundId: ROUND, verificationIds: [VERIFY], verdictIds: [id(41)], pendingRevision: null, deliverable: false, blockers: ["还有子代理在运行"], suggestions: 2, createdAt: 7 };
  const result = await call(tool, { action: "delivery-check" }, full);
  expect(result.sent).toStrictEqual({ deliverable: false, blockers: ["还有子代理在运行"], suggestions: 2 });
  expect(result.details).toEqual(full);
});

test("PM 的 workflow_manage report 成功：content 有 status，没有 reportId", async () => {
  const tool = (await pmTools())("workflow_manage");
  const full = { status: "submitted", reportId: id(42) };
  const result = await call(tool, { action: "report", note: "说明" }, full);
  expect(result.sent).toStrictEqual({ status: "submitted" });
  expect(result.details).toEqual(full);
});

test.each([
  ["report 被拒", { action: "report", note: "说明" }, { status: "rejected", missing: ["还没有做过正式检查轮"], next: "按原因逐项处理后再试；需要用户决定的，先问用户" }],
  ["status", { action: "status" }, { close: { status: "none", steps: { agentsStopped: false }, extra: [1, 2] } }],
  ["escalate", { action: "escalate", taskId: TASK, note: "卡住" }, { taskId: TASK, key: "login", status: "awaiting_user", next: "已交用户裁决；在用户决定前不能再派这个任务" }],
])("PM 的 workflow_manage %s：content 与 JSON.stringify(完整结果) 逐字相同，details 是完整结果", async (_name, params, full) => {
  const tool = (await pmTools())("workflow_manage");
  const result = await call(tool, params, full);
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

test("workflow_manage 失败时报错文字与改前相同", async () => {
  const tool = (await pmTools())("workflow_manage");
  const failure = new Error("需求已不是 PM 接手时的状态");
  world.state.reply = () => { throw failure; };
  await expect((tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", { action: "advance" }))
    .rejects.toThrow(toolFailure(toolStep("one_company_workflow_manage", { action: "advance" }), failure).message);
});

test.each(["worker", "reviewer", "qa"] as const)("%s 的 result_submit 成功时 content 与 JSON.stringify(完整结果) 逐字相同，details 是完整结果", async (role) => {
  const tool = (await subagentTools(role))("result_submit");
  const full = { kind: "verdict", accepted: true, isPass: false, verdictId: id(50), conclusion: "unverified", checkRoundId: null, findings: 2, runId: RUN };
  const result = await call(tool, { action: "verdict", result: {} }, full);
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

const readFull = (kind: "read" | "diff") => ({ kind, source: { approvalScope: { status: "available", summary: { confirmed: ["features", "acceptance"], pending: ["requirements.open"], excluded: [], blocked: [], reference: "r" } }, requirementId: REQ, repoId: HASH,
  workspaceId: HASH, branch: "refs/heads/req", role: "qa", purpose: "black_box_acceptance", commit: HEAD, prdHash: `sha256:${HASH}`, revision: 1, version: 3, lifecycleEpoch: 1, asOf: 5 },
  coverage: { representation: "parsed_prd_body", sectionId: null, startByte: 0, endByte: 9, totalBytes: 9, selectedTextComplete: true, entirePrdCovered: kind === "read", nextCursor: null,
    blocking: [], businessCompleteness: "not_mechanically_proven", verification: "not_evaluated", performance: "unknown" },
  ...(kind === "read" ? { title: "角色跳跃" } : { difference: { fromRevision: 1, toRevision: 2, fromCommit: HEAD, toCommit: HEAD, fromHash: HASH, toHash: HASH } }),
  text: "# 目标\n保留移动。\n",
  ...(kind === "read" ? { structure: { status: "available", businessCompleteness: "not_mechanically_proven", sections: [{ id: "goals", startByte: 0, endByte: 9, hash: HASH }],
    totalSections: 1, startSection: 0, endSection: 1, remainingSections: 0, complete: true } } : {}) });

test.each(["reviewer", "qa", "pm"] as const)("%s 的 requirement_manage read、diff：content 只留视图字段，details 是完整结果", async (who) => {
  const tool = who === "pm" ? (await pmTools())("requirement_manage") : (await subagentTools(who))("requirement_manage");
  const read = await call(tool, { action: "read" }, readFull("read"));
  expect(read.sent).toStrictEqual({ source: { revision: 1, approvalScope: { summary: { confirmed: ["features", "acceptance"] } } },
    coverage: { nextCursor: null, blocking: [], selectedTextComplete: true, entirePrdCovered: true },
    title: "角色跳跃", text: "# 目标\n保留移动。\n", structure: { sections: [{ id: "goals" }] } });
  expect(read.details).toEqual(readFull("read"));
  expect(read.text.indexOf('"coverage":')).toBeLessThan(read.text.indexOf('"text":'));
  const diff = await call(tool, { action: "diff", fromRevision: 1 }, readFull("diff"));
  expect(diff.sent).toStrictEqual({ source: { revision: 1, approvalScope: { summary: { confirmed: ["features", "acceptance"] } } },
    coverage: { nextCursor: null, blocking: [], selectedTextComplete: true, entirePrdCovered: false }, text: "# 目标\n保留移动。\n" });
  expect(diff.details).toEqual(readFull("diff"));
});

test("requirement_manage 的 metadata 结果 content 与完整结果逐字相同，details 是完整结果", async () => {
  const full = { kind: "metadata", requirementId: REQ, lifecycle: "closing" };
  for (const tool of [(await subagentTools("reviewer"))("requirement_manage"), (await subagentTools("qa"))("requirement_manage"), (await pmTools())("requirement_manage")]) {
    const result = await call(tool, { action: "metadata" }, full);
    expect(result.text).toBe(JSON.stringify(full));
    expect(result.details).toEqual(full);
  }
});

function agents(overrides: Partial<PmToolsInput["agents"]>) {
  return agentManageTool({ alive: () => true, checkLease: async () => {}, agents: { dispatch: async () => ({}), explore: async () => ({}), control: async () => ({}), catalog: async () => ({}), ...overrides } } as unknown as PmToolsInput);
}
const runAgent = async (tool: ToolDefinition, params: unknown) => {
  const result = await (tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", params);
  return { sent: JSON.parse(result.content[0]!.text), text: result.content[0]!.text, details: result.details };
};

test("PM 的 agent_manage dispatch 派任务：content 没有 maxTurns，runId 照有，details 是完整结果", async () => {
  const full = { runId: RUN, maxTurns: 5 };
  const result = await runAgent(agents({ dispatch: async () => full }), { action: "dispatch", taskId: TASK });
  expect(result.sent).toStrictEqual({ runId: RUN });
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage dispatch 派审查：content 有 runIds、failed，没有 maxTurns", async () => {
  const full = { runIds: [RUN, REVIEW_RUN], failed: [{ agent: "ui-reviewer", reason: "角色定义已关闭" }], maxTurns: 3 };
  const result = await runAgent(agents({ dispatch: async () => full }), { action: "dispatch", taskId: TASK, review: { maxTurns: 3 } });
  expect(result.sent).toStrictEqual({ runIds: [RUN, REVIEW_RUN], failed: [{ agent: "ui-reviewer", reason: "角色定义已关闭" }] });
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage dispatch 派 explore：content 没有 maxTurns，runId 照有", async () => {
  const full = { runId: RUN, maxTurns: 30 };
  const result = await runAgent(agents({ explore: async () => full }), { action: "dispatch", role: "explore", question: "登录在哪", maxTurns: 30 });
  expect(result.sent).toStrictEqual({ runId: RUN });
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage status：content 只有 ok 和 run 的 state、stateReason、stopCause、turns、log", async () => {
  const full = { ok: true, run: { id: RUN, kind: "role", requirement: REQ, parentRunId: id(60), state: "stopped", stateReason: "用户停止", stopCause: { reason: "user" }, turns: 3, log: "/日志",
    usage: { input: 1, output: 2 }, pausedMs: 5, pausedAt: null, startedAt: 1, updatedAt: 2, endedAt: 3 } };
  const result = await runAgent(agents({ control: async () => full }), { action: "status", runId: RUN });
  expect(result.sent).toStrictEqual({ ok: true, run: { state: "stopped", stateReason: "用户停止", stopCause: { reason: "user" }, turns: 3, log: "/日志" } });
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage status 查不到时 { ok: false, reason } 原样发", async () => {
  const full = { ok: false, reason: "找不到这次运行" };
  const result = await runAgent(agents({ control: async () => full }), { action: "status", runId: RUN });
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage catalog：content 有 items 的 name、description、source、role 和 nextCursor，没有 total", async () => {
  const full = { items: [{ name: "ui-worker", description: "界面开发", source: "user", role: "worker", path: "/agents/ui-worker.md", extra: 1 }], total: 7, nextCursor: 1 };
  const result = await runAgent(agents({ catalog: async () => full }), { action: "catalog", role: "worker" });
  expect(result.sent).toStrictEqual({ items: [{ name: "ui-worker", description: "界面开发", source: "user", role: "worker" }], nextCursor: 1 });
  expect(result.details).toEqual(full);
});

test("PM 的 agent_manage catalog 没有下一页时 nextCursor 照发", async () => {
  const full = { items: [], total: 0, nextCursor: null };
  const result = await runAgent(agents({ catalog: async () => full }), { action: "catalog" });
  expect(result.sent).toStrictEqual({ items: [], nextCursor: null });
});

test.each(["pause", "resume", "stop"] as const)("PM 的 agent_manage %s：content 与 JSON.stringify(完整结果) 逐字相同，details 是完整结果", async (action) => {
  const full = { ok: true, run: { id: RUN, state: "paused", usage: { input: 1 }, extra: { a: 1 } } };
  const result = await runAgent(agents({ control: async () => full }), { action, runId: RUN });
  expect(result.text).toBe(JSON.stringify(full));
  expect(result.details).toEqual(full);
});

test("PM 会话失效时 agent_manage dispatch 的报错文字与改前相同", async () => {
  const tool = agentManageTool({ alive: () => false, agents: {} } as unknown as PmToolsInput);
  await expect((tool.execute as unknown as (id: string, params: unknown) => Promise<Called>)("c", { action: "dispatch", taskId: TASK }))
    .rejects.toThrow("one_company_agent_manage 的 dispatch 动作失败。\n原因：本 PM 会话已结束、被停止或已被新 PM 取代\n建议：停止操作，不要重试；由主代理决定是否重新派出 PM");
});
