import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, UUID_V7_PATTERN, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { RunStore } from "../src/modules/agents/run-store.ts";
import { CheckRoundService } from "../src/modules/verification/check-round.ts";
import { createVerificationRunTool } from "../src/modules/pm/verification-run.ts";
import type { VerificationView } from "../src/modules/pm/verification-run.ts";
import { createResultSubmitTool } from "../src/modules/pm/result-submit.ts";
import { createChangeApplyTool } from "../src/modules/verification/change-apply.ts";
import { createRequirementReadTool } from "../src/modules/pm/requirement-read-tool.ts";
import { createWorkflowManageTool } from "../src/modules/delivery/workflow-manage.ts";
import { WORKFLOW_MANAGE_PARAMETERS } from "../src/modules/delivery/workflow-manage.ts";
import type { WorkflowManageGrant, WorkflowManageToolOptions } from "../src/modules/delivery/workflow-manage.ts";
import { MAIN_WORKFLOW_MANAGE_PARAMETERS, registerWorkflowManageTool } from "../src/modules/delivery/workflow-manage-extension.ts";
import { RequirementCloseService, CLOSE_OPERATIONS, COMPLETION_REPORTS, DELIVERY_RECEIPTS, decideReportIn } from "../src/modules/delivery/workflow-close.ts";
import { prototypeFilePath } from "../src/modules/requirement/requirement-prototypes.ts";
import { writePrototypeRevision } from "../src/modules/requirement/requirement-prototype-revisions.ts";
import type { CloseResult, DeliveryReceipt } from "../src/modules/delivery/workflow-close.ts";
import { resolveRepositoryRequirementDoc } from "../src/modules/requirement/requirement-doc.ts";
import type { RequirementDocSpec } from "../src/modules/requirement/requirement-doc.ts";
import { prdRequirementPath } from "../src/modules/requirement/prd-storage.ts";
import { syncTargetBranch } from "../src/modules/pm/pm-sync.ts";
import type { DeliveryMode } from "../src/core/exec/git-host.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { setLocalIdentity, withoutGitIdentity } from "./helpers/git-identity.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sections = (goal: string) => `## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n${goal}\n## 功能 {#features}\n左右移动。\n` +
  "## 实现 {#implementation}\n由 PM 规划。\n\n## 验收 {#acceptance}\n按方向键能移动。\n";
const BODY = sections("保留移动。");
const BODY_2 = sections("保留移动并增加快跑。");
const NA = { applicable: false as const, reason: "无性能影响" };
const darwin = process.platform === "darwin";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitText = async (cwd: string, ...args: string[]) => (await runGit(args, cwd)).trim();
const headFiles = async (cwd: string) => (await gitText(cwd, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean).sort();
const finding = (kind: "blocking" | "suggestion" | "unverified") => ({ kind, targetRef: "prd:goals", evidenceRef: null, trigger: "按方向键", impact: "无法移动" });

async function world(custom: { body: string; docSpec: RequirementDocSpec } | null = null) {
  const root = await mkdtemp(join(temporaryRoot(), "close-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  await setLocalIdentity(repo.root);
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const docSpec = custom?.docSpec ?? (await resolveRepositoryRequirementDoc(options.dataRoot, repo.root)).spec;
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...options, authorize: (request) => {
    if (request.repoId !== options.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  }, authorizeManifest: () => true });
  const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "acquire-pm", "check-pm", "assess-update", "events"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: custom?.body ?? BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: create.body }) });
  const created = await service.create(create);
  const worktree = await addWorktree(repo);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approveDraft = draftApprover(options, service, { requirementId: created.requirementId, operationId: created.operationId, title: "角色跳跃", body: create.body }, grantWrite);
  const approve = (body: string) => approveDraft(body, docSpec);
  await approve(custom?.body ?? BODY);
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
  const delivery = { mode: "remote" as DeliveryMode };
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
    const instance = await createWorkflowManageTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant, authorize, stopAgents, deliveryMode: async () => delivery.mode });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  async function verification(role: "qa" | "worker", runId = uuidv7()) {
    const instance = await createVerificationRunTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: () => true,
      grant: { role, callerId: uuidv7(), runId, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch } });
    cleanups.push(() => instance.dispose()); return { instance, runId };
  }
  function verdict(role: "qa", runId: string, checkRoundId: string, verificationIds: string[], findings: ReturnType<typeof finding>[] = [], summary = "结论") {
    return createResultSubmitTool({ grant: { role, callerId: uuidv7(), runId, parentRunId: lease.runId }, authorize: () => true,
      verdictBinding: { dataRoot: options.dataRoot, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, epoch: record.epoch } })
      .execute({ action: "verdict", result: { checkRoundId, verificationIds, summary, findings } }) as { verdictId: string; conclusion: string };
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
    const instance = await createWorkflowManageTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: host, stopAgents, deliveryMode: async () => delivery.mode,
      grant: { role: "main", callerId: uuidv7(), runId: uuidv7(), requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch } });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  /** PM 提交完成报告，并以一个新回执登记用户验收通过；用户决定本身的核验属于宿主，这里只用回执集合代替。 */
  async function accept(note = "交付了移动功能") {
    const submitted = await (await tool()).execute({ action: "report", note }) as { status: string; reportId: string };
    expect(submitted.status).toBe("submitted");
    const decisionId = receipt();
    withDatabase(database, (db) => db.transaction(() => decideReportIn(db, submitted.reportId, { decisionId, choice: "accept", now: Date.now() })));
    return decisionId;
  }
  const closeService = await RequirementCloseService.open({ ...options, stopAgents,
    authorize: (request) => request.action !== "close" || request.receiptId === undefined || receipts.has(request.receiptId) });
  cleanups.push(async () => closeService.dispose());
  const prdFile = join(prdRequirementPath({ dataRoot: options.dataRoot, repoId: options.repoId, requirementId: created.requirementId }), "prd.md");
  return { ...options, state, service, created, lease, workspace, worktree, database, runs, run, tool, main, accept, verification, verdict, reader, changeApply, fullEvidence, receipt, receipts,
    delivery, stopped, setStop: (mode: typeof stopBehaviour) => { stopBehaviour = mode; }, closeService, approve, prdFile };
}

test("M6-AC3/AC21：completed 预检列出缺项且不改状态、不撤权；只缺关闭授权时等待；取消/拒绝只核对授权与停止条件", async () => {
  const w = await world();
  if (!darwin) return;
  const pm = await w.tool();
  const main = await w.main();
  const before = w.state.read(w.created.requirementId);
  const receiptId = w.receipt();
  await expect(pm.execute({ action: "close", reason: "completed", receiptId })).rejects.toMatchObject({ code: "action_not_allowed", advice: { why: "当前角色的职责不允许这个动作：pm 不能做 close" } });
  await expect(main.execute({ action: "report", note: "说明" })).rejects.toMatchObject({ code: "action_not_allowed", advice: { why: "当前角色的职责不允许这个动作：主代理 不能做 report" } });
  expect(await pm.execute({ action: "report", note: "说明" })).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["还没有做过正式检查轮"]) });
  const empty = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(empty.status).toBe("rejected");
  expect((empty as { missing: string[] }).missing).toEqual(expect.arrayContaining(["还没有做过正式检查轮"]));
  const after = w.state.read(w.created.requirementId);
  expect([after.data.lifecycle, after.data.epoch, after.version]).toEqual(["active", before.data.epoch, before.version]);
  expect(w.state.pmOwner(w.created.requirementId)?.lease).toBeTruthy();
  await expect((await w.reader()).execute({ action: "metadata" })).resolves.toMatchObject({ lifecycle: "active" });
  const { pm: pm2 } = await w.fullEvidence();
  const worker = await w.run("role", "one-company.worker");
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).missing).toEqual(expect.arrayContaining(["role_agents_running"]));
  expect(await pm2.execute({ action: "report", note: "说明" })).toMatchObject({ status: "rejected", missing: expect.arrayContaining(["还有子代理在运行"]) });
  await w.runs.update(worker, { state: "stopped" });
  const check = await pm2.execute({ action: "delivery-check" }) as DeliveryReceipt;
  expect(check.deliverable).toBe(true); expect(check.suggestions).toBe(1);
  expect(JSON.stringify(check)).not.toContain("保留移动");
  const unauthorized = await main.execute({ action: "close", reason: "completed", receiptId: uuidv7() }) as CloseResult;
  expect(unauthorized).toMatchObject({ status: "rejected", missing: [expect.stringMatching(/^关闭依据的用户决定无效/)] });
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
  const worker2 = await other.run("role", "one-company.worker");
  expect(await otherMain.execute({ action: "close", reason: "cancelled", receiptId: uuidv7() })).toMatchObject({ status: "rejected", missing: [expect.stringMatching(/^关闭依据的用户决定无效/)], next: expect.any(String) });
  await expect((await other.tool()).execute({ action: "close", reason: "cancelled", receiptId: other.receipt() })).rejects.toMatchObject({ code: "action_not_allowed" });
  const cancelled = await otherMain.execute({ action: "close", reason: "cancelled", receiptId: other.receipt() }) as CloseResult;
  expect(cancelled).toMatchObject({ status: "closed", reason: "cancelled", archive: null });
  expect((await other.runs.get(worker2)).ok && (await other.runs.get(worker2) as { run: { state: string } }).run.state).toBe("stopped");
  const { message } = cancelled as { message: string };
  expect(message).toContain("取消"); expect(message).not.toContain("已完成");
  await expect(other.closeService.archive(other.created.requirementId)).rejects.toMatchObject({ code: "archive_unavailable" });
});

test("M6-AC11：预检通过后注入 PRD 更新、代码变化、阻塞裁决或新写入使正式关闭被拒；重复关闭不重复副作用、不改关闭原因", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const main = await w.main();
  let receiptId = await w.accept();
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).eligible).toBe(true);
  await writeFile(join(w.worktree.root, "src", "a.ts"), "export const a = 2;\n");
  const changed = await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] };
  expect(changed.missing).toEqual(expect.arrayContaining(["工作区内容与正式检查时不一致"]));
  await writeFile(join(w.worktree.root, "src", "a.ts"), "export const a = 1;\n");
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId })).eligible).toBe(true);
  await w.approve(BODY_2);
  const updated = await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] };
  expect(updated.missing).toEqual(expect.arrayContaining(["有新批准的需求版本还没复核"]));
  await w.state.assessUpdate({ lease: w.lease, version: w.state.read(w.created.requirementId).version, revision: w.state.read(w.created.requirementId).data.revision, assessmentId: uuidv7(), tasks: [{ taskId: "move", impact: "unaffected", reason: "章节未变" }] });
  const stale = await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] };
  expect(stale.missing).toEqual(expect.arrayContaining(["检查轮依据的批准版本不是当前版本"]));
  const { round: round2 } = await w.fullEvidence([finding("blocking")]);
  const blocked = await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] };
  expect(blocked.missing).toEqual(expect.arrayContaining(["QA 发现了阻塞问题"]));
  const { round: round3 } = await w.fullEvidence([finding("unverified")]);
  expect(round3.checkRoundId).not.toBe(round2.checkRoundId);
  expect((await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] }).missing).toEqual(expect.arrayContaining(["QA 还有未验证的项"]));
  await w.fullEvidence();
  const applier = await w.changeApply();
  const write = applier.execute({ action: "apply", files: [{ path: "src/b.ts", baseHash: "absent", content: "b\n" }] });
  await write;
  const dirty = await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] };
  expect(dirty.missing).toEqual(expect.arrayContaining(["工作区内容与正式检查时不一致"]));
  await rm(join(w.worktree.root, "src", "b.ts"));
  expect((await main.execute({ action: "close", reason: "completed", receiptId }) as { missing: string[] }).missing).toEqual(["用户验收的完成报告已不是最新依据"]);
  receiptId = await w.accept();
  const original = RequirementCloseService.prototype.preflight;
  const injected = vi.spyOn(RequirementCloseService.prototype, "preflight").mockImplementation(async function (this: RequirementCloseService, input) {
    const result = await original.call(this, input);
    injected.mockRestore();
    await applier.execute({ action: "apply", files: [{ path: "src/late.ts", baseHash: "absent", content: "late\n" }] });
    return result;
  });
  const raced = await main.execute({ action: "close", reason: "completed", receiptId }) as { status: string; missing: string[] };
  expect([raced.status, raced.missing]).toEqual(["rejected", ["关闭依据在确认后又发生了变化"]]);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("active");
  await rm(join(w.worktree.root, "src", "late.ts"));
  receiptId = await w.accept();
  const closed = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" } });
  const again = await main.execute({ action: "close", reason: "completed", receiptId });
  expect(JSON.stringify(again)).toContain("这次关闭已经办完");
  expect(w.state.read(w.created.requirementId).data.close?.reason).toBe("completed");
  for (const late of [await main.execute({ action: "close", reason: "cancelled", receiptId: w.receipt() }), await main.execute({ action: "close", reason: "completed", receiptId })]) {
    expect(late).toMatchObject({ status: "rejected", missing: ["这次关闭已经办完，用 status 查看结果"] });
    expect(late).not.toHaveProperty("operationId");
  }
  expect(w.state.read(w.created.requirementId).data.close?.reason).toBe("completed");
  expect(w.state.events(w.created.requirementId).filter((event) => event.data.kind === "closed")).toHaveLength(1);
  expect(withDatabase(w.database, (db) => db.list(DELIVERY_RECEIPTS)).length).toBeGreaterThan(0);
});

test("M6-AC6/AC4/AC15：closing 生效即撤权，代理未停止或收尾失败保持 closing 与拒读；收尾成功才 closed 并向主代理返回无正文结果与清空上下文建议；本机 PRD 字节保留", async () => {
  const w = await world();
  if (!darwin) return;
  const pmRun = await w.run("requirement");
  const { pm } = await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  const bytes = await readFile(w.prdFile);
  w.setStop("throw");
  const first = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(first).toMatchObject({ status: "closing", pending: ["还有运行没停止"] });
  const closing = w.state.read(w.created.requirementId);
  expect(closing.data.lifecycle).toBe("closing"); expect(closing.data.epoch).toBe(w.lease.epoch + 1);
  expect(w.state.pmOwner(w.created.requirementId)?.lease).toBeNull();
  await expect((await w.reader()).execute({ action: "read" })).rejects.toMatchObject({ code: "closed_metadata_only" });
  await expect((await w.reader("pm")).execute({ action: "metadata" })).resolves.toMatchObject({ lifecycle: "closing" });
  await expect((await w.changeApply()).execute({ action: "apply", files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求不在活动状态" } });
  await expect((await w.verification("qa")).instance.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求不在活动状态" } });
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是 PM 接手时的状态：需求不在活动状态" } });
  await expect(w.service.metadata(w.created.requirementId)).resolves.toMatchObject({ lifecycle: "closing", approved: null, archivePath: null });
  w.setStop("leave");
  expect(await main.execute({ action: "close", reason: "completed", receiptId })).toMatchObject({ status: "closing", pending: ["还有运行没停止"] });
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
  w.setStop("stop");
  const done = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(done).toMatchObject({ status: "closed", reason: "completed", archive: { status: "archived" },
    message: `需求 ${w.created.requirementId} 已完成，PM 及相关子代理已结束。建议清空上下文后再开始新的需求，避免旧需求影响后续判断。` });
  expect((await w.runs.get(pmRun) as { run: { state: string } }).run.state).toBe("stopped");
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
  await expect(readFile(w.prdFile)).resolves.toEqual(bytes);
  await expect((await w.reader()).execute({ action: "metadata" })).resolves.toEqual({ kind: "metadata", requirementId: w.created.requirementId, lifecycle: "closed" });
  expect(w.stopped.length).toBe(3);
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
});

test("M6-AC10：只有 completed 关闭可归档最终 PRD；同内容幂等，不同内容阻塞不覆盖；归档失败保持待恢复且需求仍 closed", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  const archivePath = (await w.service.metadata(w.created.requirementId)).archivePath!;
  const target = join(w.worktree.root, ...archivePath.split("/"));
  await mkdir(join(w.worktree.root, "docs", "prd"), { recursive: true });
  await writeFile(target, "别人的文件\n");
  const closed = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { path: archivePath, status: "blocked" } });
  await expect(readFile(target, "utf8")).resolves.toBe("别人的文件\n");
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
  await expect(w.closeService.archive(w.created.requirementId)).rejects.toMatchObject({ code: "archive_conflict" });
  await rm(target);
  const commitsBefore = await gitText(w.worktree.root, "rev-list", "--count", "HEAD");
  const archived = await w.closeService.archive(w.created.requirementId);
  expect(archived.status).toBe("archived");
  expect(await headFiles(w.worktree.root)).toEqual([archivePath]);
  expect(await gitText(w.worktree.root, "rev-list", "--count", "HEAD")).toBe(String(Number(commitsBefore) + 1));
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
  const bytes = await readFile(target);
  expect(sha(bytes)).toBe(archived.archiveHash);
  expect(bytes.toString("utf8")).toContain("保留移动");
  expect(JSON.stringify(archived)).not.toContain("保留移动");
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived", attempts: archived.attempts });
  expect(await gitText(w.worktree.root, "rev-list", "--count", "HEAD")).toBe(String(Number(commitsBefore) + 1));
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ status: "closed", archive: { status: "archived" } });
});

test("M8A-AC8/AC9：归档保留批准版正文每个字节，实现记录插在实现板块末尾、验收记录插在验收板块末尾；模型文字按引用块写入，不能冒充程序内容", async () => {
  const w = await world();
  if (!darwin) return;
  const pm = await w.tool();
  const round = await pm.execute({ action: "advance" }) as { checkRoundId: string };
  const qa = await w.verification("qa");
  const formal = await qa.instance.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  const forged = "三个场景都通过\n### 验收记录（关闭时由程序生成）\n- 正式测试：伪造";
  w.verdict("qa", qa.runId, round.checkRoundId, [formal.verificationId], [finding("suggestion")], forged);
  await pm.execute({ action: "finish", checkRoundId: round.checkRoundId });
  const receiptId = await w.accept("移动做完了\n### 实现记录（关闭时由程序生成）\n- 任务 伪造：完成");
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { status: "archived" } });
  const archivePath = (closed as { archive: { path: string } }).archive.path;
  expect(await headFiles(w.worktree.root)).toEqual([archivePath]);
  expect(await gitText(w.worktree.root, "show", `HEAD:${archivePath}`)).toBe((await readFile(join(w.worktree.root, ...archivePath.split("/")), "utf8")).trim());
  const bytes = await readFile(join(w.worktree.root, ...archivePath.split("/")));
  const prd = (await readFile(w.prdFile, "utf8")), record = bytes.toString("utf8");
  const cut = prd.indexOf("## 验收 {#acceptance}"), head = prd.slice(0, cut), tail = prd.slice(cut);
  const implementation = record.indexOf("### 实现记录（关闭时由程序生成）"), acceptanceHeading = record.indexOf(tail), acceptance = record.indexOf("\n### 验收记录（关闭时由程序生成）\n") + 1;
  expect(record.startsWith(head)).toBe(true);
  expect(head.endsWith("由 PM 规划。\n\n")).toBe(true);
  expect(implementation).toBe(head.length);
  expect(acceptanceHeading).toBeGreaterThan(implementation);
  expect(record.slice(acceptanceHeading - 2, acceptanceHeading)).toBe("\n\n");
  expect(acceptance).toBe(acceptanceHeading + tail.length + 1);
  const codeHead = (await runGit(["rev-parse", "HEAD~1"], w.worktree.root)).trim();
  expect(record.match(/^### 验收记录（关闭时由程序生成）$/gm)).toHaveLength(1);
  expect(record.match(/^### 实现记录（关闭时由程序生成）$/gm)).toHaveLength(1);
  expect(record).toContain("#### PM 说明（模型撰写，仅供参考）\n\n> 移动做完了\n> ### 实现记录（关闭时由程序生成）\n> - 任务 伪造：完成");
  expect(record).toContain("#### worker 任务\n\n任务名与可写范围是 PM 在计划中登记的值。\n\n- 无");
  expect(record).toContain(`#### 提交\n\n在主分支运行 \`git log --grep ${w.created.requirementId}\` 可列出本需求的提交。\n`);
  expect(record).not.toContain("提交说明由模型撰写");
  for (const expected of [`检查轮：${round.checkRoundId}`, `代码提交：${codeHead}`, "`true`", "结果：通过", "退出码：0", "用时：", "性能：不适用（模型撰写的理由：无性能影响）",
    "QA 结论：无阻塞、无未验证项", "QA 说明（模型撰写，仅供参考）：", "> 三个场景都通过", "> ### 验收记录（关闭时由程序生成）", "> - 正式测试：伪造",
    "[建议] prd:goals"]) expect(record).toContain(expected);
  expect(record).not.toMatch(/^- 正式测试：伪造/m);
  const status = w.closeService.status(w.created.requirementId) as { archive: { archiveHash: string } };
  expect(status.archive.archiveHash).toBe(sha(bytes));
  expect(JSON.stringify(status)).not.toContain("三个场景都通过");
});

test("M8C-AC3/AC5：归档按批准时的规范快照插入两段记录，验收记录板块在前、另有额外板块时也插在所属板块末尾", async () => {
  const docSpec: RequirementDocSpec = { skillHash: `sha256:${"a".repeat(64)}`, sections: [{ id: "goal", title: "目标" }, { id: "check", title: "验收", record: "acceptance" },
    { id: "build", title: "实现", record: "implementation" }, { id: "risk", title: "风险" }] };
  const body = "## 目标 {#goal}\n保留移动。\n## 验收 {#check}\n按方向键能移动。\n## 实现 {#build}\n由 PM 规划。\n## 风险 {#risk}\n无。\n";
  const w = await world({ body, docSpec });
  if (!darwin) return;
  expect(w.state.read(w.created.requirementId).data.docSpec).toEqual(docSpec);
  const pm = await w.tool();
  const round = await pm.execute({ action: "advance" }) as { checkRoundId: string };
  const qa = await w.verification("qa");
  const formal = await qa.instance.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  w.verdict("qa", qa.runId, round.checkRoundId, [formal.verificationId], [], "通过");
  await pm.execute({ action: "finish", checkRoundId: round.checkRoundId });
  const receiptId = await w.accept("做完了");
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { status: "archived" } });
  const record = (await readFile(join(w.worktree.root, ...(closed as { archive: { path: string } }).archive.path.split("/")), "utf8"));
  const at = (text: string) => record.indexOf(text);
  expect(at("按方向键能移动。\n")).toBeLessThan(at("### 验收记录（关闭时由程序生成）"));
  expect(at("### 验收记录（关闭时由程序生成）")).toBeLessThan(at("## 实现 {#build}"));
  expect(at("由 PM 规划。\n")).toBeLessThan(at("### 实现记录（关闭时由程序生成）"));
  expect(at("### 实现记录（关闭时由程序生成）")).toBeLessThan(at("## 风险 {#risk}"));
  const prd = await readFile(w.prdFile, "utf8"), checkEnd = prd.indexOf("## 实现 {#build}");
  expect(record.startsWith(prd.slice(0, checkEnd))).toBe(true);
  expect(record.endsWith(prd.slice(prd.indexOf("## 风险 {#risk}")))).toBe(true);
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
  expect(await pm.execute({ action: "report", note: "没改就再交" })).toMatchObject({ status: "rejected", missing: ["用户要求返工后交付依据没有变化"] });
  expect((await w.closeService.preflight({ requirementId: w.created.requirementId, reason: "completed", receiptId: reworkId })).missing).toEqual(["completion_report_not_accepted"]);
  await w.fullEvidence();
  const accepted = await w.accept();
  const codeHead = await gitText(w.worktree.root, "rev-parse", "HEAD");
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId: accepted });
  expect(closed).toMatchObject({ status: "closed", reason: "completed" });
  const closeStatus = w.closeService.status(w.created.requirementId);
  expect(closeStatus).toMatchObject({ archive: { status: "archived" }, delivery: { worktree: w.worktree.root, branch: w.workspace.branch, codeHead } });
  expect(await gitText(w.worktree.root, "rev-parse", "HEAD~1")).toBe(codeHead);
  expect(JSON.stringify(closeStatus)).not.toContain("保留移动");
});

test("M8-AC9：需求分支未包含目标分支当前提交时不能开启检查轮，同步后可以", async () => {
  const w = await world();
  if (!darwin) return;
  await writeFile(join(w.repositoryRoot, "main-only.ts"), "export const m = 1;\n");
  await runGit(["add", "."], w.repositoryRoot); await runGit(["commit", "-qm", "别的需求合入"], w.repositoryRoot);
  const pm = await w.tool();
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "sync_required" });
  expect(await syncTargetBranch({ repositoryRoot: w.repositoryRoot, worktree: w.worktree.root, branch: w.workspace.branch, deliveryMode: async () => "remote" })).toMatchObject({ status: "rebased" });
  expect(await pm.execute({ action: "advance" })).toMatchObject({ status: "open" });
});

test("仅本地档位且有 origin：需求分支未包含主仓库当前分支的最新提交时不能开启检查轮，按本地分支同步后可以，不要求包含 origin 上的提交", async () => {
  const w = await world();
  if (!darwin) return;
  w.delivery.mode = "local";
  const remote = join(await mkdtemp(join(temporaryRoot(), "close-origin-")), "remote.git");
  cleanups.push(() => rm(join(remote, ".."), { recursive: true, force: true }));
  await runGit(["init", "-q", "--bare", "-b", "main", remote], w.repositoryRoot);
  await runGit(["remote", "add", "origin", remote], w.repositoryRoot);
  await runGit(["push", "-q", "origin", "main"], w.repositoryRoot);
  await runGit(["fetch", "-q", "origin"], w.repositoryRoot); await runGit(["remote", "set-head", "origin", "main"], w.repositoryRoot);
  const other = join(await mkdtemp(join(temporaryRoot(), "close-other-")), "clone");
  cleanups.push(() => rm(join(other, ".."), { recursive: true, force: true }));
  await runGit(["clone", "-q", remote, other], w.repositoryRoot);
  await writeFile(join(other, "remote-only.ts"), "export const r = 1;\n");
  await runGit(["add", "."], other); await runGit(["commit", "-qm", "只在远端"], other); await runGit(["push", "-q", "origin", "main"], other);
  await writeFile(join(w.repositoryRoot, "main-only.ts"), "export const m = 1;\n");
  await runGit(["add", "."], w.repositoryRoot); await runGit(["commit", "-qm", "别的需求合入"], w.repositoryRoot);
  await runGit(["remote", "set-url", "origin", join(remote, "不存在.git")], w.repositoryRoot);
  const pm = await w.tool();
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ code: "sync_required" });
  expect(await syncTargetBranch({ repositoryRoot: w.repositoryRoot, worktree: w.worktree.root, branch: w.workspace.branch, deliveryMode: async () => "local" })).toMatchObject({ status: "rebased", target: "refs/heads/main" });
  expect(await pm.execute({ action: "advance" })).toMatchObject({ status: "open" });
  expect(await gitText(w.worktree.root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("remote-only.ts");
});

test("仅本地档位且主仓库没检出分支：开检查轮报主仓库当前没有检出分支，不报目标分支未拉取", async () => {
  const w = await world();
  if (!darwin) return;
  w.delivery.mode = "local";
  await runGit(["checkout", "-q", "--detach"], w.repositoryRoot);
  const pm = await w.tool();
  await expect(pm.execute({ action: "advance" })).rejects.toMatchObject({ advice: { why: "主仓库当前没有检出分支", next: "请用户在主仓库检出要合进去的分支后再继续" } });
});

const PROTOTYPES = [{ name: "设置页", version: 3, html: "<html>设置页 v3</html>\n" }, { name: "命令行输出", version: 1, html: "<html>命令行输出 v1</html>\n" }];

async function approvePrototypes(w: Awaited<ReturnType<typeof world>>, items = PROTOTYPES) {
  const requirementId = w.created.requirementId;
  for (const item of items) {
    const file = prototypeFilePath(w, { requirementId, name: item.name, version: item.version });
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, item.html);
  }
  const revision = w.state.read(requirementId).data.revision;
  withDatabase(w.database, (db) => writePrototypeRevision(db, { requirementId, revision,
    prototypes: items.map((item) => ({ name: item.name, version: item.version, hash: sha(item.html), bytes: Buffer.byteLength(item.html) })) }));
  return { revision, file: (item: (typeof PROTOTYPES)[number]) => prototypeFilePath(w, { requirementId, name: item.name, version: item.version }) };
}

async function closeCompleted(w: Awaited<ReturnType<typeof world>>) {
  await w.fullEvidence();
  const receiptId = await w.accept();
  return await (await w.main()).execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
}

const htmlTarget = (w: Awaited<ReturnType<typeof world>>, name: string) => join(w.worktree.root, "docs", "prd", `${w.created.requirementId}.${name}.html`);
const storedArchive = (w: Awaited<ReturnType<typeof world>>) => withDatabase(w.database, (db) => db.read<{ archive: { prototypes: unknown } }>(CLOSE_OPERATIONS, w.created.requirementId)!.data.archive);

test("归档把最终批准版本的原型 html 和正文一起写进归档目录，内容与原型文件逐字节相同，关闭记录登记每份原型", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w);
  const closed = await closeCompleted(w);
  expect(closed).toMatchObject({ status: "closed", archive: { status: "archived" } });
  const dir = join(w.worktree.root, "docs", "prd");
  const names = await readdir(dir);
  expect(names.filter((name) => name.endsWith(".md"))).toHaveLength(1);
  expect(names.filter((name) => name.endsWith(".html")).sort()).toEqual([`${w.created.requirementId}.命令行输出.html`, `${w.created.requirementId}.设置页.html`].sort());
  expect(names).toHaveLength(3);
  for (const item of PROTOTYPES) expect(await readFile(htmlTarget(w, item.name))).toEqual(Buffer.from(item.html));
  expect(await headFiles(w.worktree.root)).toEqual(names.map((name) => `docs/prd/${name}`).sort());
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
  expect(storedArchive(w).prototypes).toEqual(PROTOTYPES.map((item) => ({ path: `docs/prd/${w.created.requirementId}.${item.name}.html`, name: item.name, version: item.version, hash: sha(item.html) })));
});

test("归档位置已有内容不同的同名原型 html 时归档受阻、不覆盖，清掉后再归档成功", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w);
  await mkdir(join(w.worktree.root, "docs", "prd"), { recursive: true });
  await writeFile(htmlTarget(w, "设置页"), "别人的文件\n");
  const closed = await closeCompleted(w);
  expect(closed).toMatchObject({ status: "closed", archive: { status: "blocked" } });
  await expect(readFile(htmlTarget(w, "设置页"), "utf8")).resolves.toBe("别人的文件\n");
  await expect(w.closeService.archive(w.created.requirementId)).rejects.toMatchObject({ code: "archive_conflict", advice: { why: "归档位置已有内容不同的文件" } });
  await rm(htmlTarget(w, "设置页"));
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived" });
  expect(await readFile(htmlTarget(w, "设置页"))).toEqual(Buffer.from(PROTOTYPES[0].html));
  expect(await headFiles(w.worktree.root)).toHaveLength(3);
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
});

test("归档位置已有内容相同的原型 html 时跳过写入，归档仍成功", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w);
  await mkdir(join(w.worktree.root, "docs", "prd"), { recursive: true });
  await writeFile(htmlTarget(w, "设置页"), PROTOTYPES[0].html);
  const before = (await stat(htmlTarget(w, "设置页"))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "archived" } });
  expect((await stat(htmlTarget(w, "设置页"))).mtimeMs).toBe(before);
  expect(await readFile(htmlTarget(w, "命令行输出"))).toEqual(Buffer.from(PROTOTYPES[1].html));
  expect(await headFiles(w.worktree.root)).toHaveLength(3);
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
});

test("原型源文件内容与批准时的指纹不符时归档受阻，错误写明哪份原型第几版和下一步，正文也不写出", async () => {
  const w = await world();
  if (!darwin) return;
  const approved = await approvePrototypes(w);
  await writeFile(approved.file(PROTOTYPES[0]), "<html>被改过</html>\n");
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "blocked" } });
  const failure = await w.closeService.archive(w.created.requirementId).then(() => null, (error: unknown) => error as { name: string; code: string; advice: { why: string; next: string } });
  expect(failure).toMatchObject({ name: "CloseError", code: expect.any(String) });
  expect(failure!.advice.why).toContain("设置页");
  expect(failure!.advice.why).toContain("3");
  expect(failure!.advice.next.length).toBeGreaterThan(0);
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ archive: { status: "blocked" } });
  expect(await readdir(join(w.worktree.root, "docs", "prd")).catch(() => [] as string[])).toEqual([]);
});

test("原型源文件已不存在时归档受阻（不是待重试），错误写明哪份原型第几版，不带系统原始报错", async () => {
  const w = await world();
  if (!darwin) return;
  const approved = await approvePrototypes(w);
  await rm(approved.file(PROTOTYPES[0]));
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "blocked" } });
  const failure = await w.closeService.archive(w.created.requirementId).then(() => null, (error: unknown) => error as { name: string; code: string; advice: { why: string; next: string } });
  expect(failure).toMatchObject({ name: "CloseError" });
  expect(failure!.advice.why).toContain("设置页");
  expect(failure!.advice.why).toContain("3");
  expect(failure!.advice.why).not.toMatch(/ENOENT/);
  expect(failure!.advice.next.length).toBeGreaterThan(0);
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ archive: { status: "blocked" } });
  expect(await readdir(join(w.worktree.root, "docs", "prd")).catch(() => [] as string[])).toEqual([]);
});

test("原型源文件不存在与指纹不符是同一类受阻原因", async () => {
  const reasonOf = async (mutate: (file: string) => Promise<void>) => {
    const w = await world();
    const approved = await approvePrototypes(w);
    await mutate(approved.file(PROTOTYPES[0]));
    await closeCompleted(w);
    const failure = await w.closeService.archive(w.created.requirementId).then(() => null, (error: unknown) => error as { code: string; advice: { why: string } });
    return failure!;
  };
  if (!darwin) return;
  const missing = await reasonOf((file) => rm(file));
  const changed = await reasonOf((file) => writeFile(file, "<html>被改过</html>\n"));
  expect(missing.code).toBe(changed.code);
  expect(missing.advice.why).toBe(changed.advice.why);
});

test("原型源文件不存在时受阻原因要能看出文件已不存在或被删，指纹不符时同一原因也成立", async () => {
  const reasonOf = async (mutate: (file: string) => Promise<void>) => {
    const w = await world();
    const approved = await approvePrototypes(w);
    await mutate(approved.file(PROTOTYPES[0]));
    await closeCompleted(w);
    const failure = await w.closeService.archive(w.created.requirementId).then(() => null, (error: unknown) => error as { advice: { why: string } });
    return failure!.advice.why;
  };
  if (!darwin) return;
  expect(await reasonOf((file) => rm(file))).toMatch(/不存在|删/);
  expect(await reasonOf((file) => writeFile(file, "<html>被改过</html>\n"))).toMatch(/不存在|删/);
});

test("某份原型的目标位置暂时是目录导致归档中断，恢复后续办补齐全部文件并最终归档", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w);
  await mkdir(htmlTarget(w, "命令行输出"), { recursive: true });
  const closed = await closeCompleted(w) as { archive: { status: string } };
  expect(closed.archive.status).not.toBe("archived");
  await rm(htmlTarget(w, "命令行输出"), { recursive: true });
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived" });
  const names = await readdir(join(w.worktree.root, "docs", "prd"));
  expect(names).toHaveLength(3);
  expect(await headFiles(w.worktree.root)).toHaveLength(3);
  for (const item of PROTOTYPES) expect(await readFile(htmlTarget(w, item.name))).toEqual(Buffer.from(item.html));
});

test("早先版本带原型、最终批准版本不带原型时，归档的原型清单为空且不写早先原型的 html", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w, [PROTOTYPES[0]]);
  await w.approve(BODY_2);
  expect(w.state.read(w.created.requirementId).data.revision).toBeGreaterThan(1);
  await w.state.assessUpdate({ lease: w.lease, version: w.state.read(w.created.requirementId).version, revision: w.state.read(w.created.requirementId).data.revision, assessmentId: uuidv7(), tasks: [{ taskId: "move", impact: "unaffected", reason: "章节未变" }] });
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "archived" } });
  expect(storedArchive(w).prototypes).toEqual([]);
  expect((await readdir(join(w.worktree.root, "docs", "prd"))).filter((name) => name.endsWith(".html"))).toEqual([]);
  expect((await headFiles(w.worktree.root)).filter((name) => name.endsWith(".html"))).toEqual([]);
});

test("最终批准版本没有原型时归档只有正文，关闭记录的原型清单为空", async () => {
  const w = await world();
  if (!darwin) return;
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "archived" } });
  const names = await readdir(join(w.worktree.root, "docs", "prd"));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/\.md$/);
  expect(await headFiles(w.worktree.root)).toEqual([`docs/prd/${names[0]}`]);
  expect(storedArchive(w).prototypes).toEqual([]);
});

type Closing = { status: "closing"; operationId: string; pending: string[]; next: string };
type Rejected = { status: "rejected"; missing: string[]; operationId?: string };

test("close 由程序生成合规编号并随结果返回", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId: await w.accept() }) as CloseResult & { operationId: string };
  expect(closed.status).toBe("closed");
  expect(closed.operationId).toMatch(UUID_V7_PATTERN);
});

test("close 参数带 operationId 是 invalid_shape，主窗口侧与守护进程侧都一样", async () => {
  const w = await world();
  const main = await w.main();
  const receiptId = w.receipt();
  await expect(main.execute({ action: "close", reason: "completed", receiptId, operationId: uuidv7() })).rejects.toMatchObject({ code: "invalid_shape" });
  const tools: Array<{ execute: (id: string, params: unknown) => Promise<unknown> }> = [];
  registerWorkflowManageTool({ registerTool: (tool: never) => { tools.push(tool); } } as never, () => ({}) as never);
  await expect(tools[0].execute("call", { action: "close", repoId: w.repoId, requirementId: w.created.requirementId, reason: "completed", receiptId, operationId: uuidv7() })).rejects.toMatchObject({ code: "invalid_shape" });
});

test("关闭返回 closing 时建议写明原决定编号与原原因；原样再调 close 由程序用原编号续办，先 closing 后 closed", async () => {
  const w = await world();
  if (!darwin) return;
  await w.run("requirement");
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  w.setStop("leave");
  const first = await main.execute({ action: "close", reason: "completed", receiptId }) as unknown as Closing;
  expect(first.status).toBe("closing");
  expect(first.operationId).toMatch(UUID_V7_PATTERN);
  expect(first.next).toContain("原决定编号 receiptId、原原因 reason");
  expect(first.next).not.toContain("照抄");
  expect(await main.execute({ action: "close", reason: "completed", receiptId })).toMatchObject({ status: "closing", operationId: first.operationId });
  w.setStop("stop");
  expect(await main.execute({ action: "close", reason: "completed", receiptId })).toMatchObject({ status: "closed", operationId: first.operationId, reason: "completed", archive: { status: "archived" } });
  expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closed");
});

test("已有在办关闭时换 receiptId 或 reason 再调 close 被拒，不带 operationId，建议写明用原原因和原决定编号续办，关闭状态不变", async () => {
  const w = await world();
  if (!darwin) return;
  await w.run("requirement");
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  w.setStop("leave");
  await main.execute({ action: "close", reason: "completed", receiptId });
  const before = w.state.read(w.created.requirementId);
  for (const changed of [{ reason: "completed", receiptId: w.receipt() }, { reason: "cancelled", receiptId }]) {
    const again = await main.execute({ action: "close", ...changed }) as unknown as Rejected & { next: string };
    expect(again).toMatchObject({ status: "rejected", missing: ["需求已有另一个关闭请求在办理"] });
    expect(again.next).toContain("用原来的原因和决定编号再次 close 续办");
    expect(again).not.toHaveProperty("operationId");
    expect(w.state.read(w.created.requirementId).version).toBe(before.version);
    expect(w.state.read(w.created.requirementId).data.lifecycle).toBe("closing");
  }
});

test("关闭已办完后再调 close 被拒并说明这次关闭已经办完，状态不变", async () => {
  const w = await world();
  if (!darwin) return;
  await w.run("requirement");
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  expect(await main.execute({ action: "close", reason: "completed", receiptId })).toMatchObject({ status: "closed" });
  const closedVersion = w.state.read(w.created.requirementId).version;
  const done = await main.execute({ action: "close", reason: "completed", receiptId });
  expect(JSON.stringify(done)).toContain("这次关闭已经办完");
  expect(done).toMatchObject({ status: "rejected" });
  expect(w.state.read(w.created.requirementId).version).toBe(closedVersion);
});

async function closeBlockedByArchiveConflict(w: Awaited<ReturnType<typeof world>>) {
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  const archivePath = (await w.service.metadata(w.created.requirementId)).archivePath!;
  const target = join(w.worktree.root, ...archivePath.split("/"));
  await mkdir(join(w.worktree.root, "docs", "prd"), { recursive: true });
  await writeFile(target, "别人的文件\n");
  const closed = await main.execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { status: "blocked" } });
  return { main, receiptId, target };
}

test("关闭办完但归档被挡后，清掉冲突再用原原因和原决定编号调 close：归档成功，状态查询看到已归档", async () => {
  const w = await world();
  if (!darwin) return;
  const { main, receiptId, target } = await closeBlockedByArchiveConflict(w);
  await rm(target);
  const retried = await main.execute({ action: "close", reason: "completed", receiptId });
  expect(retried).toMatchObject({ status: "closed", archive: { status: "archived" } });
  expect(await readFile(target, "utf8")).toContain("保留移动");
  expect(await headFiles(w.worktree.root)).toHaveLength(1);
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ status: "closed", archive: { status: "archived" } });
});

test("关闭办完但归档没完成时，换 reason 或 receiptId 再调 close 被拒，状态不变", async () => {
  const w = await world();
  if (!darwin) return;
  const { main, receiptId, target } = await closeBlockedByArchiveConflict(w);
  await rm(target);
  const before = w.state.read(w.created.requirementId);
  for (const changed of [{ reason: "completed", receiptId: w.receipt() }, { reason: "cancelled", receiptId }]) {
    const again = await main.execute({ action: "close", ...changed });
    expect(again).toMatchObject({ status: "rejected", missing: ["需求已有另一个关闭请求在办理"] });
    expect(w.state.read(w.created.requirementId).version).toBe(before.version);
  }
  expect(w.closeService.status(w.created.requirementId)).toMatchObject({ archive: { status: "blocked" } });
  await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("没有归档的关闭办完后再调 close 被拒并说明这次关闭已经办完", async () => {
  const w = await world();
  const main = await w.main();
  const receiptId = w.receipt();
  expect(await main.execute({ action: "close", reason: "cancelled", receiptId })).toMatchObject({ status: "closed", archive: null });
  const done = await main.execute({ action: "close", reason: "cancelled", receiptId });
  expect(done).toMatchObject({ status: "rejected" });
  expect(JSON.stringify(done)).toContain("这次关闭已经办完");
});

test("主窗口侧工具说明不含新生成、UUIDv7、照抄与 operationId，close 的参数里没有 operationId", () => {
  const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
  registerWorkflowManageTool({ registerTool: (tool: never) => { tools.push(tool); } } as never, () => ({}) as never);
  const [tool] = tools;
  expect(tool.name).toBe("one_company_workflow_manage");
  for (const word of ["新生成", "UUIDv7", "照抄", "operationId"]) expect(tool.description).not.toContain(word);
  for (const schema of [MAIN_WORKFLOW_MANAGE_PARAMETERS, WORKFLOW_MANAGE_PARAMETERS]) {
    const close = (schema as unknown as { anyOf: Array<{ properties: Record<string, unknown> }> }).anyOf.find((variant) => JSON.stringify(variant.properties.action).includes("close"))!;
    expect(Object.keys(close.properties)).not.toContain("operationId");
  }
});

test("两个窗口几乎同时关闭时，后到的一方被拒且结果不带 operationId", async () => {
  const w = await world();
  if (!darwin) return;
  await w.run("requirement");
  await w.fullEvidence();
  const main = await w.main();
  const receiptId = await w.accept();
  w.setStop("leave");
  const original = RequirementStateStore.prototype.beginClose;
  const earlier = uuidv7();
  vi.spyOn(RequirementStateStore.prototype, "beginClose").mockImplementationOnce(function (this: RequirementStateStore, input, guard) {
    original.call(this, { ...input, intent: { ...input.intent, operationId: earlier } }, guard);
    return original.call(this, input, guard);
  });
  const raced = await main.execute({ action: "close", reason: "completed", receiptId });
  expect(raced).toMatchObject({ status: "rejected", missing: ["需求已有另一个关闭请求在办理"] });
  expect(raced).not.toHaveProperty("operationId");
});

test("完成关闭把归档和原型提交进需求分支：只提交这些文件，事先另放的改动保持未提交，说明首行是归档标题、末行是 Requirement", async () => {
  const w = await world();
  if (!darwin) return;
  await approvePrototypes(w);
  await writeFile(join(w.worktree.root, "notes.txt"), "另放的改动\n");
  await w.fullEvidence();
  const receiptId = await w.accept();
  const codeHead = await gitText(w.worktree.root, "rev-parse", "HEAD");
  const closed = await (await w.main()).execute({ action: "close", reason: "completed", receiptId }) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { status: "archived" } });
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("?? notes.txt");
  expect(await headFiles(w.worktree.root)).toEqual([(closed as { archive: { path: string } }).archive.path, ...PROTOTYPES.map((item) => `docs/prd/${w.created.requirementId}.${item.name}.html`)].sort());
  expect(await gitText(w.worktree.root, "rev-parse", "HEAD~1")).toBe(codeHead);
  const lines = (await gitText(w.worktree.root, "log", "-1", "--format=%B")).split("\n");
  expect(lines[0]).toBe(`docs(prd): 归档需求 ${w.created.requirementId}`);
  expect(lines[1]).toBe("");
  expect(lines.at(-1)).toBe(`Requirement: ${w.created.requirementId}`);
});

test("没配 Git 用户名和邮箱时关闭办完但归档待重试并带 Git 的报错；配好后再归档只补提交，不重写文件", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const receiptId = await w.accept();
  const main = await w.main();
  const closed = await withoutGitIdentity(w.repositoryRoot, () => main.execute({ action: "close", reason: "completed", receiptId })) as CloseResult;
  expect(closed).toMatchObject({ status: "closed", archive: { status: "pending" } });
  const archivePath = (closed as { archive: { path: string } }).archive.path;
  const target = join(w.worktree.root, ...archivePath.split("/"));
  const status = w.closeService.status(w.created.requirementId) as { archive: { status: string; lastError: string } };
  expect(status.archive.status).toBe("pending");
  expect(status.archive.lastError).toMatch(/identity|who you are|user\.(name|email)/i);
  const codeHead = await gitText(w.worktree.root, "rev-parse", "HEAD");
  const before = (await stat(target)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const archived = await w.closeService.archive(w.created.requirementId);
  expect(archived).toMatchObject({ status: "archived", lastError: null });
  expect((await stat(target)).mtimeMs).toBe(before);
  expect(await gitText(w.worktree.root, "rev-parse", "HEAD~1")).toBe(codeHead);
  expect(await headFiles(w.worktree.root)).toEqual([archivePath]);
  expect(await gitText(w.worktree.root, "status", "--porcelain")).toBe("");
});

test("对已归档的需求再调 archive 仍是 archived，分支上的提交数不变", async () => {
  const w = await world();
  if (!darwin) return;
  expect(await closeCompleted(w)).toMatchObject({ status: "closed", archive: { status: "archived" } });
  const count = await gitText(w.worktree.root, "rev-list", "--count", "HEAD");
  const head = await gitText(w.worktree.root, "rev-parse", "HEAD");
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived" });
  expect(await gitText(w.worktree.root, "rev-list", "--count", "HEAD")).toBe(count);
  expect(await gitText(w.worktree.root, "rev-parse", "HEAD")).toBe(head);
});

test("待重试时 HEAD 里已有内容一致的归档，再调 archive 直接 archived，分支上的提交不变", async () => {
  const w = await world();
  if (!darwin) return;
  await w.fullEvidence();
  const receiptId = await w.accept();
  const main = await w.main();
  const closed = await withoutGitIdentity(w.repositoryRoot, () => main.execute({ action: "close", reason: "completed", receiptId })) as CloseResult;
  expect(closed).toMatchObject({ archive: { status: "pending" } });
  const archivePath = (closed as { archive: { path: string } }).archive.path;
  await runGit(["add", "--", archivePath], w.worktree.root); await runGit(["commit", "-qm", "手动归档"], w.worktree.root);
  const head = await gitText(w.worktree.root, "rev-parse", "HEAD");
  expect(await w.closeService.archive(w.created.requirementId)).toMatchObject({ status: "archived" });
  expect(await gitText(w.worktree.root, "rev-parse", "HEAD")).toBe(head);
});
