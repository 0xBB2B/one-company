import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RunStore } from "../runtime/run-store.ts";
import { CheckRoundService } from "../runtime/check-round.ts";
import { createVerificationRunTool } from "../runtime/verification-run.ts";
import type { VerificationView } from "../runtime/verification-run.ts";
import { createResultSubmitTool } from "../runtime/result-submit.ts";
import { createChangeApplyTool } from "../runtime/change-apply.ts";
import { createRequirementReadTool } from "../runtime/requirement-read-tool.ts";
import { createSpecChangeTool } from "../runtime/spec-change.ts";
import { createWorkflowManageTool } from "../runtime/workflow-manage.ts";
import type { WorkflowManageGrant, WorkflowManageToolOptions } from "../runtime/workflow-manage.ts";
import { RequirementCloseService, COMPLETION_REPORTS, DELIVERY_RECEIPTS, decideReportIn } from "../runtime/workflow-close.ts";
import type { CloseResult, DeliveryReceipt } from "../runtime/workflow-close.ts";
import { prodRequirementPath } from "../runtime/prod-storage.ts";
import { syncTargetBranch } from "../runtime/pm-sync.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const BODY_2 = "# 目标 {#goals}\n保留移动并增加快跑。\n";
const NA = { applicable: false as const, reason: "无性能影响" };
const darwin = process.platform === "darwin";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const finding = (kind: "blocking" | "suggestion" | "unverified") => ({ kind, targetRef: "prod:goals", evidenceRef: null, trigger: "按方向键", impact: "无法移动" });

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "close-"));
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
    ["open", "read", "bind-workspace", "acquire-pm", "check-pm", "assess-update", "events"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const created = await service.create(create);
  const worktree = await addWorktree(repo);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  async function approve(body: string) {
    const confirm = { requirementId: created.requirementId, operationId: uuidv7(), version: state.read(created.requirementId).version, title: "角色跳跃", body, receiptId: uuidv7() };
    grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title: confirm.title, body }), receiptId: confirm.receiptId });
    return service.confirmUpdate(confirm);
  }
  await approve(BODY);
  await mkdir(join(worktree.root, "src"), { recursive: true });
  await writeFile(join(worktree.root, "src", "a.ts"), "export const a = 1;\n");
  await runGit(["add", "."], worktree.root); await runGit(["commit", "-qm", "seed"], worktree.root);
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: state.read(created.requirementId).version, runId: uuidv7(), expectedFence: 0 });
  const record = state.read(created.requirementId).data;
  const workspace = record.workspace!;
  const database = repositoryDatabase(options.dataRoot, options.repoId);
  const runs = new RunStore({ dataRoot: options.dataRoot, repoId: options.repoId, daemonStartedAt: new Date().toISOString() });
  async function run(kind: "requirement" | "role", role?: string) {
    const created2 = await runs.create({ kind, role, requirement: created.requirementId, parentRunId: kind === "role" ? lease.runId : undefined, task: "t", cwd: worktree.root,
      writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    await runs.update(created2.id, { state: "running" });
    return created2.id;
  }
  const receipts = new Set<string>();
  const stopped: string[] = [];
  let stopBehaviour: "stop" | "leave" | "throw" = "stop";
  const stopAgents = async (requirementId: string) => {
    stopped.push(requirementId);
    if (stopBehaviour === "throw") throw new Error("停止失败");
    if (stopBehaviour === "leave") return;
    for (const item of (await runs.list({ requirement: requirementId, limit: 100 })).items) if (item.state === "running") await runs.update(item.id, { state: "stopped" });
  };
  const host: WorkflowManageToolOptions["authorize"] = (request) => request.action !== "close" || request.receiptId === undefined || receipts.has(request.receiptId);
  async function tool(extra: Partial<WorkflowManageGrant> = {}, authorize = host) {
    const grant: WorkflowManageGrant = { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease), ...extra };
    const instance = await createWorkflowManageTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant, authorize, stopAgents });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  async function verification(role: "qa" | "worker", runId = uuidv7()) {
    const instance = await createVerificationRunTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: () => true,
      grant: { role, callerId: uuidv7(), runId, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch } });
    cleanups.push(() => instance.dispose()); return { instance, runId };
  }
  function verdict(role: "qa", runId: string, checkRoundId: string, verificationIds: string[], findings: ReturnType<typeof finding>[] = []) {
    return createResultSubmitTool({ grant: { role, callerId: uuidv7(), runId, parentRunId: lease.runId }, authorize: () => true,
      verdictBinding: { dataRoot: options.dataRoot, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, epoch: record.epoch } })
      .execute({ action: "verdict", result: { checkRoundId, verificationIds, summary: "结论", findings } }) as { verdictId: string; conclusion: string };
  }
  async function reader(role: "pm" | "qa" = "qa") {
    const instance = await createRequirementReadTool({ ...options, authorize: () => true, binding: { role, callerId: uuidv7(), runId: role === "pm" ? lease.runId : uuidv7(),
      requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease) } });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  async function changeApply() {
    const instance = await createChangeApplyTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: () => true,
      grant: { role: "worker", callerId: uuidv7(), runId: uuidv7(), requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch, writePaths: ["src/"] } });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  /** 完整走一轮：进入检查、QA 正式检查并给出裁决、退出检查。 */
  async function fullEvidence(findings: ReturnType<typeof finding>[] = []) {
    const pm = await tool();
    const round = await pm.execute({ action: "advance" }) as { checkRoundId: string };
    const qa = await verification("qa");
    const formal = await qa.instance.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
    verdict("qa", qa.runId, round.checkRoundId, [formal.verificationId], [...findings, finding("suggestion")]);
    await pm.execute({ action: "finish", checkRoundId: round.checkRoundId });
    return { pm, round, formal };
  }
  const receipt = () => { const value = uuidv7(); receipts.add(value); return value; };
  async function main() {
    const instance = await createWorkflowManageTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: host, stopAgents,
      grant: { role: "main", callerId: uuidv7(), runId: uuidv7(), requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch } });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  /** PM 提交完成报告，并以一个新回执登记用户验收通过；用户决定本身的核验属于宿主，这里只用回执集合代替。 */
  async function accept() {
    const submitted = await (await tool()).execute({ action: "report", note: "交付了移动功能" }) as { status: string; reportId: string };
    expect(submitted.status).toBe("submitted");
    const decisionId = receipt();
    withDatabase(database, (db) => db.transaction(() => decideReportIn(db, submitted.reportId, { decisionId, choice: "accept", now: Date.now() })));
    return decisionId;
  }
  const closeService = await RequirementCloseService.open({ ...options, stopAgents,
    authorize: (request) => request.action !== "close" || request.receiptId === undefined || receipts.has(request.receiptId) });
  cleanups.push(async () => closeService.dispose());
  const prodFile = join(prodRequirementPath({ dataRoot: options.dataRoot, repoId: options.repoId, requirementId: created.requirementId }), "prod.md");
  return { ...options, state, service, created, lease, workspace, worktree, database, runs, run, tool, main, accept, verification, verdict, reader, changeApply, fullEvidence, receipt, receipts,
    stopped, setStop: (mode: typeof stopBehaviour) => { stopBehaviour = mode; }, closeService, approve, prodFile };
}

test("M6-AC3/AC21：completed 预检列出缺项且不改状态、不撤权；只缺关闭授权时等待；取消/拒绝只核对授权与停止条件", async () => {
  const w = await world();
  if (!darwin) return;
  const pm = await w.tool();
  const main = await w.main();
  const before = w.state.read(w.created.requirementId);
  const receiptId = w.receipt();
  await expect(pm.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() })).rejects.toMatchObject({ code: "workflow_denied" });
  await expect(main.execute({ action: "report", note: "说明" })).rejects.toMatchObject({ code: "workflow_denied" });
  expect(await pm.execute({ action: "report", note: "说明" })).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["formal_check_missing"]) });
  const empty = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as CloseResult;
  expect(empty.status).toBe("rejected");
  expect((empty as { missing: string[] }).missing).toEqual(expect.arrayContaining(["formal_check_missing"]));
  const after = w.state.read(w.created.requirementId);
  expect([after.data.lifecycle, after.data.epoch, after.version]).toEqual(["active", before.data.epoch, before.version]);
  expect(w.state.pmOwner(w.created.requirementId)?.lease).toBeTruthy();
  await expect((await w.reader()).execute({ action: "metadata" })).resolves.toMatchObject({ lifecycle: "active" });
  const { pm: pm2 } = await w.fullEvidence();
  const worker = await w.run("role", "pi-company.worker");
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).missing).toEqual(expect.arrayContaining(["role_agents_running"]));
  expect(await pm2.execute({ action: "report", note: "说明" })).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["role_agents_running"]) });
  await w.runs.update(worker, { state: "stopped" });
  const check = await pm2.execute({ action: "delivery-check" }) as DeliveryReceipt;
  expect(check.deliverable).toBe(true); expect(check.suggestions).toBe(1);
  expect(JSON.stringify(check)).not.toContain("保留移动");
  const unauthorized = await main.execute({ action: "close", reason: "completed", receiptId: uuidv7(), operationId: uuidv7() }) as CloseResult;
  expect(unauthorized).toMatchObject({ status: "rejected", missing: ["close_authorization_invalid"] });
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("active");
  const blocked = await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId: uuidv7() });
  expect(blocked.missing).toEqual(["close_authorization_invalid", "completion_report_not_accepted"]);
  const waiting = await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId });
  expect(waiting).toMatchObject({ eligible: false, missing: ["completion_report_not_accepted"] });
  const accepted = await w.accept();
  expect(await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).toMatchObject({ eligible: false, missing: ["completion_report_not_accepted"] });
  const ready = await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId: accepted });
  expect(ready).toMatchObject({ eligible: true, missing: [] });

  const other = await world();
  const otherMain = await other.main();
  const worker2 = await other.run("role", "pi-company.worker");
  expect(await otherMain.execute({ action: "close", reason: "cancelled", receiptId: uuidv7(), operationId: uuidv7() })).toMatchObject({ status: "rejected", missing: ["close_authorization_invalid"] });
  await expect((await other.tool()).execute({ action: "close", reason: "cancelled", receiptId: other.receipt(), operationId: uuidv7() })).rejects.toMatchObject({ code: "workflow_denied" });
  const cancelled = await otherMain.execute({ action: "close", reason: "cancelled", receiptId: other.receipt(), operationId: uuidv7() }) as CloseResult;
  expect(cancelled).toMatchObject({ status: "closed", reason: "cancelled", archive: null });
  expect((await other.runs.get(worker2)).ok && (await other.runs.get(worker2) as { run: { state: string } }).run.state).toBe("stopped");
  const { message } = cancelled as { message: string };
  expect(message).toContain("取消"); expect(message).not.toContain("已完成");
  await expect(other.closeService.archive(other.created.requirementId)).rejects.toMatchObject({ code: "archive_unavailable" });
});

test("M6-AC11：预检通过后注入 prod 更新、代码变化、阻塞裁决或新写入使正式关闭被拒；重复关闭不重复副作用、不改关闭原因", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const main = await w.main();
  let receiptId = await w.accept();
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).eligible).toBe(true);
  await writeFile(join(w.worktree.root, "src", "a.ts"), "export const a = 2;\n");
  const changed = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] };
  expect(changed.missing).toEqual(expect.arrayContaining(["delivery_content_mismatch"]));
  await writeFile(join(w.worktree.root, "src", "a.ts"), "export const a = 1;\n");
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).eligible).toBe(true);
  await w.approve(BODY_2);
  const updated = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] };
  expect(updated.missing).toEqual(expect.arrayContaining(["pending_update"]));
  await w.state.assessUpdate({ lease: w.lease, version: w.state.read(w.created.requirementId).version, revision: w.state.read(w.created.requirementId).data.revision, assessmentId: uuidv7(), tasks: [{ taskId: "move", impact: "unaffected", reason: "章节未变" }] });
  const stale = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] };
  expect(stale.missing).toEqual(expect.arrayContaining(["check_round_prod_mismatch"]));
  const { round: round2 } = await w.fullEvidence([finding("blocking")]);
  const blocked = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] };
  expect(blocked.missing).toEqual(expect.arrayContaining(["qa_blocking_findings"]));
  const { round: round3 } = await w.fullEvidence([finding("unverified")]);
  expect(round3.checkRoundId).not.toBe(round2.checkRoundId);
  expect((await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] }).missing).toEqual(expect.arrayContaining(["qa_unverified_findings"]));
  await w.fullEvidence();
  const applier = await w.changeApply();
  const write = applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/b.ts", baseHash: "absent", content: "b\n" }] });
  await write;
  const dirty = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] };
  expect(dirty.missing).toEqual(expect.arrayContaining(["delivery_content_mismatch"]));
  await rm(join(w.worktree.root, "src", "b.ts"));
  expect((await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] }).missing).toEqual(["completion_report_stale"]);
  receiptId = await w.accept();
  const spec = await createSpecChangeTool({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, authorize: () => true, publishGate: () => ({ checkPhaseReleased: true, evidence: null }),
    grant: { role: "pm", callerId: uuidv7(), runId: w.lease.runId, requirementId: w.created.requirementId, repoId: w.repoId, workspaceId: w.workspace.workspaceId, branch: w.workspace.branch, lease: structuredClone(w.lease) } });
  cleanups.push(async () => spec.dispose());
  const original = RequirementCloseService.prototype.preflight;
  const injected = vi.spyOn(RequirementCloseService.prototype, "preflight").mockImplementation(async function (this: RequirementCloseService, input) {
    const result = await original.call(this, input);
    injected.mockRestore();
    const rule = { id: "late.rule", title: "晚到", condition: "c", trigger: "t", expected: "e", reason: "r", dependsOn: [], exceptions: [], acceptance: [{ id: "a", given: "g", when: "w", then: "t" }] };
    await spec.execute({ action: "propose", operationId: uuidv7(), files: [{ path: "docs/spec/player/late.rules.json", baseHash: "absent",
      content: JSON.stringify({ $schema: "../schema.json", schemaVersion: 1, feature: { id: "late", title: "晚到", aliases: [] }, rules: [rule] }, null, 2) + "\n" }] });
    return result;
  });
  const raced = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { status: string; missing: string[] };
  expect([raced.status, raced.missing]).toEqual(["rejected", ["close_basis_changed"]]);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("active");
  expect((await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as { missing: string[] }).missing).toEqual(expect.arrayContaining(["spec_candidates_unpublished"]));
  withDatabase(w.database, (db) => db.transaction(() => { for (const row of db.list("spec_proposals")) db.remove("spec_proposals", row.key, row.version); }));
  receiptId = await w.accept();
  const operationId = uuidv7();
  const closed = await main.execute({ action: "close", reason: "completed", receiptId, operationId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" } });
  const again = await main.execute({ action: "close", reason: "completed", receiptId, operationId }) as CloseResult;
  expect(again).toMatchObject({ status: "closed", reason: "completed" });
  expect(await main.execute({ action: "close", reason: "cancelled", receiptId: w.receipt(), operationId: uuidv7() })).toMatchObject({ status: "rejected", missing: ["close_intent_conflict"] });
  expect(await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() })).toMatchObject({ status: "rejected", missing: ["close_intent_conflict"] });
  expect(w.state.read(w.created.requirementId).data.close?.reason).toBe("completed");
  expect(w.state.events(w.created.requirementId).filter((event) => event.data.kind === "closed")).toHaveLength(1);
  expect(withDatabase(w.database, (db) => db.list(DELIVERY_RECEIPTS)).length).toBeGreaterThan(0);
});

test("M6-AC6/AC4/AC15：closing 生效即撤权，代理未停止或收尾失败保持 closing 与拒读；收尾成功才 closed 并向主代理返回无正文结果与清空上下文建议；本机 prod 字节保留", async () => {
  const w = await world();
  if (!darwin) return;
  const pmRun = await w.run("requirement");
  const { pm } = await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  const bytes = await readFile(w.prodFile);
  w.setStop("throw");
  const operationId = uuidv7();
  const first = await main.execute({ action: "close", reason: "completed", receiptId, operationId }) as CloseResult;
  expect(first).toMatchObject({ status: "closing", pending: ["agents_running"] });
  const closing = w.state.read(w.created.requirementId);
  expect(closing.data.lifecycle).toBe("closing"); expect(closing.data.epoch).toBe(w.lease.epoch + 1);
  expect(w.state.pmOwner(w.created.requirementId)?.lease).toBeNull();
  await expect((await w.reader()).execute({ action: "read" })).rejects.toMatchObject({ code: "requirement_read_denied" });
  await expect((await w.reader("pm")).execute({ action: "metadata" })).resolves.toMatchObject({ lifecycle: "closing" });
  await expect((await w.changeApply()).execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "change_apply_denied" });
  await expect((await w.verification("qa")).instance.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "verification_denied" });
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "check_round_denied" });
  await expect(w.service.metadata(w.created.requirementId)).resolves.toMatchObject({ lifecycle: "closing", approved: null, archivePath: null });
  w.setStop("leave");
  expect(await main.execute({ action: "close", reason: "completed", receiptId, operationId })).toMatchObject({ status: "closing", pending: ["agents_running"] });
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
  w.setStop("stop");
  const done = await main.execute({ action: "close", reason: "completed", receiptId, operationId }) as CloseResult;
  expect(done).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" },
    message: `需求 ${w.created.requirementId} 已完成，PM 及相关子代理已结束。建议清空上下文后再开始新的需求，避免旧需求影响后续判断。` });
  expect((await w.runs.get(pmRun) as { run: { state: string } }).run.state).toBe("stopped");
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
  await expect(readFile(w.prodFile)).resolves.toEqual(bytes);
  await expect((await w.reader()).execute({ action: "metadata" })).resolves.toEqual({ kind: "metadata", requirementId: w.created.requirementId, lifecycle: "closed" });
  expect(w.stopped.length).toBe(3);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
});

test("M6-AC10：只有 completed 关闭可归档最终 prod；同内容幂等，不同内容阻塞不覆盖；归档失败保持待恢复且需求仍 closed", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  const archivePath = (await w.service.metadata(w.created.requirementId)).archivePath!;
  const target = join(w.worktree.root, ...archivePath.split("/"));
  await mkdir(join(w.worktree.root, "docs", "prod"), { recursive: true });
  await writeFile(target, "别人的文件\n");
  const closed = await main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { path: archivePath, status: "blocked" } });
  await expect(readFile(target, "utf8")).resolves.toBe("别人的文件\n");
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
  await expect(w.closeService.archive(w.created.requirementId)).rejects.toMatchObject({ code: "archive_conflict" });
  await rm(target);
  const archived = await w.closeService.archive(w.created.requirementId);
  expect(archived.status).toBe("archived");
  const bytes = await readFile(target);
  expect(sha(bytes)).toBe(archived.prodHash);
  expect(bytes.toString("utf8")).toContain("保留移动");
  expect(JSON.stringify(archived)).not.toContain("保留移动");
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived", attempts: archived.attempts });
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ status: "closed", archive: { status: "archived" } });
});

test("M7B-AC1/AC5：完成报告绑定交付依据，新报告作废旧报告；用户返工后依据未变不能重新提交，经新的检查轮后可重新提交且只认新报告的通过", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const pm = await w.tool();
  const first = await pm.execute({ action: "report", note: "第一次" }) as { status: string; reportId: string };
  const second = await pm.execute({ action: "report", note: "第二次" }) as { status: string; reportId: string };
  const status = (reportId: string) => withDatabase(w.database, (db) => (db.read<{ status: string }>(COMPLETION_REPORTS, reportId)!.data.status));
  expect([status(first.reportId), status(second.reportId)]).toEqual(["superseded", "pending"]);
  expect(() => withDatabase(w.database, (db) => decideReportIn(db, first.reportId, { decisionId: uuidv7(), choice: "accept", now: Date.now() }))).toThrow(/not_found/);
  const reworkId = w.receipt();
  withDatabase(w.database, (db) => decideReportIn(db, second.reportId, { decisionId: reworkId, choice: "rework", now: Date.now() }));
  expect(await pm.execute({ action: "report", note: "没改就再交" })).toMatchObject({ status: "rejected", missing: ["rework_not_addressed"] });
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId: reworkId })).missing).toEqual(["completion_report_not_accepted"]);
  await w.fullEvidence();
  const accepted = await w.accept();
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId: accepted, operationId: uuidv7() });
  expect(closed).toMatchObject({ status: "closed", reason: "completed" });
  const closeStatus = w.closeService.status(w.created.requirementId);
  expect(closeStatus).toMatchObject({ archive: { status: "archived" }, delivery: { worktree: w.worktree.root, branch: w.workspace.branch,
    codeHead: (await runGit(["rev-parse", "HEAD"], w.worktree.root)).trim() } });
  expect(JSON.stringify(closeStatus)).not.toContain("保留移动");
});

test("M8-AC9：需求分支未包含目标分支当前提交时不能开启检查轮，同步后可以；同步后的机械规则冲突阻止开启检查", async () => {
  const w = await world();
  if (!darwin) return;
  await writeFile(join(w.repositoryRoot, "main-only.ts"), "export const m = 1;\n");
  await runGit(["add", "."], w.repositoryRoot); await runGit(["commit", "-qm", "别的需求合入"], w.repositoryRoot);
  const pm = await w.tool();
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "sync_required" });
  expect(await syncTargetBranch({ repositoryRoot: w.repositoryRoot, worktree: w.worktree.root, branch: w.workspace.branch })).toMatchObject({ status: "rebased" });
  const rule = (id: string, expected: string) => ({ id, title: id, condition: "角色在地面", trigger: "按下跳跃", expected, reason: "r", dependsOn: [], exceptions: [],
    acceptance: [{ id: "a", given: "g", when: "w", then: "t" }] });
  const spec = (rules: unknown[]) => JSON.stringify({ schemaVersion: 1, feature: { id: "jump", title: "跳跃", aliases: [] }, rules }, null, 2) + "\n";
  await mkdir(join(w.worktree.root, "docs", "spec", "player"), { recursive: true });
  await writeFile(join(w.worktree.root, "docs", "spec", "player", "a.rules.json"), spec([rule("jump.up", "起跳")]));
  await writeFile(join(w.worktree.root, "docs", "spec", "player", "b.rules.json"), JSON.stringify({ schemaVersion: 1, feature: { id: "jump", title: "跳跃", aliases: [] },
    rules: [rule("jump.down", "下蹲")] }, null, 2) + "\n");
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "spec_conflict" });
  await rm(join(w.worktree.root, "docs", "spec", "player", "b.rules.json"));
  expect(await pm.execute({ action: "advance" })).toMatchObject({ status: "open" });
});
