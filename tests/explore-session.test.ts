import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createResultSubmitTool } from "../runtime/result-submit.ts";
import { checkExploreSession, endExploreSession, endRequirementExploreSessionsIn, registerExploreSession } from "../runtime/explore-session.ts";
import type { ExploreInput, ExploreResult } from "../runtime/explore-contracts.ts";
import { createSessionManagerForRun, openSessionManagerForRun } from "../runtime/session-records.ts";
import { RequirementCloseService } from "../runtime/workflow-close.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const budget = { maxSources: 4, maxResultBytes: 8_192 };

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "explore-session-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...options, authorize: (request) => {
    if (request.repoId !== options.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  } });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "acquire-pm", "release-pm", "check-pm", "begin-close", "finish-close", "events"].includes(request.action) });
  async function requirement(title: string) {
    const create = { requestId: uuidv7(), operationId: uuidv7(), title, body: BODY };
    grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title, body: BODY }) });
    const created = await service.create(create);
    const worktree = await addWorktree(repo);
    const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
    await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
    const confirm = { requirementId: created.requirementId, operationId: uuidv7(), version: state.read(created.requirementId).version, title, body: BODY, receiptId: uuidv7() };
    grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title, body: BODY }), receiptId: confirm.receiptId });
    await service.confirmUpdate(confirm);
    const lease = await state.acquirePm({ requirementId: created.requirementId, version: state.read(created.requirementId).version, runId: uuidv7(), expectedFence: 0 });
    return { id: created.requirementId, lease, worktree };
  }
  const runs = new RunStore({ dataRoot: options.dataRoot, repoId: options.repoId, daemonStartedAt: new Date().toISOString() });
  const workspace = { repoId: options.repoId, workspaceId: sha("workspace"), branch: "refs/heads/test" };
  function input(parent: ExploreInput["parent"]): ExploreInput {
    return { format: "explore-input/v1", parent, question: "定位校验逻辑", clues: [], budget,
      source: { kind: "knowledge_query", workspace, generation: 4, baselineHash: sha("baseline"), allowedPaths: ["src/a.ts"] } };
  }
  function research(explore: ExploreInput): ExploreResult {
    return { format: "explore-result/v1", kind: "research", parent: explore.parent, source: explore.source, conclusions: ["找到"],
      sources: [{ kind: "knowledge_query", workspace, generation: 4, baselineHash: sha("baseline"), path: "src/a.ts", fileHash: sha("a"), startLine: 1, endLine: 2 }],
      searchedScope: { kind: "knowledge_query", paths: ["src/a.ts"] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] };
  }
  function submit(runId: string, explore: ExploreInput) {
    return createResultSubmitTool({ grant: { role: "explore", callerId: uuidv7(), runId, parentRunId: explore.parent.parentRunId }, exploreInput: explore, authorize: () => true, exploreSession: options })
      .execute({ action: "research", result: research(explore) });
  }
  const database = repositoryDatabase(options.dataRoot, options.repoId);
  const close = await RequirementCloseService.open({ ...options, authorize: () => true, stopAgents: async () => {} });
  cleanups.push(async () => close.dispose());
  return { ...options, state, service, requirement, runs, input, research, submit, database, close };
}

test("M6-AC18：绑定需求的 explore 在关闭、父撤权或 PM 接管后停止且迟到结果拒收；无关 main 无需求检索不受影响；结束的搜索会话不跨需求复用", async () => {
  const w = await world();
  const first = await w.requirement("需求一");
  const second = await w.requirement("需求二");
  const mainRun = await w.runs.create({ kind: "requirement", requirement: second.id, task: "问答", cwd: w.repositoryRoot, writePaths: [], readPaths: [], model: { provider: "t", id: "t" }, thinking: "off", mcp: [] });
  await w.runs.update(mainRun.id, { state: "running" });
  const mainInput = w.input({ role: "main", parentSessionId: "main-session", parentRunId: mainRun.id, contextId: "ctx", requirementBinding: null });
  const pmInput = w.input({ role: "PM", parentSessionId: "pm-session", parentRunId: first.lease.runId, contextId: "ctx", requirementBinding: { requirementId: first.id, epoch: first.lease.epoch, pmFence: first.lease.fence } });
  const secondPm = w.input({ role: "PM", parentSessionId: "pm-session-2", parentRunId: second.lease.runId, contextId: "ctx", requirementBinding: { requirementId: second.id, epoch: second.lease.epoch, pmFence: second.lease.fence } });
  const mainId = uuidv7(), pmId = uuidv7(), secondId = uuidv7();
  registerExploreSession(w, mainId, mainInput);
  registerExploreSession(w, pmId, pmInput);
  registerExploreSession(w, secondId, secondPm);
  expect(() => registerExploreSession(w, pmId, pmInput)).toThrow(/session_reused/);
  expect(() => registerExploreSession(w, uuidv7(), { ...pmInput, parent: { ...pmInput.parent, requirementBinding: { requirementId: first.id, epoch: first.lease.epoch + 1, pmFence: first.lease.fence } } } as ExploreInput)).toThrow(/requirement_inactive/);
  expect(() => registerExploreSession(w, uuidv7(), { ...pmInput, parent: { ...pmInput.parent, requirementBinding: { requirementId: first.id, epoch: first.lease.epoch, pmFence: first.lease.fence + 1 } } } as ExploreInput)).toThrow(/pm_binding_invalid/);
  expect(() => submit(uuidv7(), mainInput)).toThrow(/stale_session/);
  expect(w.submit(mainId, mainInput)).toMatchObject({ kind: "research", accepted: true, isPass: false });
  expect(w.submit(pmId, pmInput)).toMatchObject({ kind: "research", accepted: true });

  const closing = w.state.beginClose({ requirementId: first.id, version: w.state.read(first.id).version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(checkExploreSession(w, pmId)).toMatchObject({ current: false, reason: "requirement_closed" });
  expect(() => w.submit(pmId, pmInput)).toThrow(/stale_session/);
  expect(checkExploreSession(w, mainId)).toMatchObject({ current: true });
  expect(checkExploreSession(w, secondId)).toMatchObject({ current: true });
  w.state.finishClose({ requirementId: first.id, version: closing.version, operationId: closing.data.close!.operationId });
  const ended = withDatabase(w.database, (db) => db.transaction(() => endRequirementExploreSessionsIn(db, w.repoId, first.id, "requirement_closed")));
  expect(ended).toEqual([pmId]);
  expect(checkExploreSession(w, pmId)).toMatchObject({ current: false, reason: "session_ended" });
  expect(checkExploreSession(w, mainId)).toMatchObject({ current: true });

  w.state.releasePm(second.lease);
  const takeover = await w.state.acquirePm({ requirementId: second.id, version: w.state.read(second.id).version, runId: uuidv7(), expectedFence: second.lease.fence + 1 });
  expect(takeover.fence).toBe(second.lease.fence + 2);
  expect(checkExploreSession(w, secondId)).toMatchObject({ current: false, reason: "pm_taken_over" });
  expect(() => w.submit(secondId, secondPm)).toThrow(/stale_session/);
  expect(() => registerExploreSession(w, secondId, secondPm)).toThrow(/session_reused/);

  await w.runs.update(mainRun.id, { state: "stopped" });
  expect(checkExploreSession(w, mainId)).toMatchObject({ current: false, reason: "parent_revoked" });
  expect(() => w.submit(mainId, mainInput)).toThrow(/stale_session/);
  const lateMain = uuidv7();
  registerExploreSession(w, lateMain, { ...mainInput, parent: { ...mainInput.parent, parentRunId: "main-live" } });
  expect(w.submit(lateMain, { ...mainInput, parent: { ...mainInput.parent, parentRunId: "main-live" } })).toMatchObject({ accepted: true });
  expect(endExploreSession(w, lateMain, "task_finished")).toMatchObject({ status: "ended", endedReason: "task_finished" });
  expect(() => w.submit(lateMain, { ...mainInput, parent: { ...mainInput.parent, parentRunId: "main-live" } })).toThrow(/stale_session/);
  function submit(runId: string, explore: ExploreInput) { return w.submit(runId, explore); }
});

test("M6-AC5/AC7：已关闭需求的 PM/子会话不续接，新运行的会话不带旧内容；未关闭或 PM 崩溃不产生完成通知", async () => {
  const w = await world();
  const requirement = await w.requirement("需求");
  const pmRun = await w.runs.create({ kind: "requirement", requirement: requirement.id, task: "PM", cwd: requirement.worktree.root, writePaths: [], readPaths: [], model: { provider: "t", id: "t" }, thinking: "off", mcp: [] });
  const ref = { dataRoot: w.dataRoot, repoId: w.repoId, runId: pmRun.id };
  const manager = createSessionManagerForRun({ ...ref, cwd: requirement.worktree.root });
  manager.appendMessage({ role: "user", content: "旧需求正文摘要", timestamp: Date.now() });
  expect(openSessionManagerForRun(ref).ok).toBe(true);
  await w.runs.update(pmRun.id, { state: "running" });
  await w.runs.update(pmRun.id, { state: "failed", stateReason: "崩溃" });
  expect(() => w.close.notify(requirement.id, () => true)).toThrow(/notice_missing/);
  expect(w.close.status(requirement.id)).toEqual({ status: "none" });
  const closing = w.state.beginClose({ requirementId: requirement.id, version: w.state.read(requirement.id).version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(openSessionManagerForRun(ref)).toMatchObject({ ok: false, reason: "closed" });
  w.state.finishClose({ requirementId: requirement.id, version: closing.version, operationId: closing.data.close!.operationId });
  expect(openSessionManagerForRun(ref)).toMatchObject({ ok: false, reason: "closed" });
  const fresh = await w.requirement("新需求");
  const newRun = await w.runs.create({ kind: "requirement", requirement: fresh.id, task: "PM", cwd: fresh.worktree.root, writePaths: [], readPaths: [], model: { provider: "t", id: "t" }, thinking: "off", mcp: [] });
  const created = createSessionManagerForRun({ dataRoot: w.dataRoot, repoId: w.repoId, runId: newRun.id, cwd: fresh.worktree.root });
  expect(created.getBranch().filter((entry) => entry.type === "message")).toHaveLength(0);
  expect(JSON.stringify(created.getBranch())).not.toContain("旧需求正文摘要");
  expect(openSessionManagerForRun({ dataRoot: w.dataRoot, repoId: w.repoId, runId: newRun.id }).ok).toBe(true);
});
