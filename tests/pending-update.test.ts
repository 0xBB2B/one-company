import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { CheckRoundService } from "../runtime/check-round.ts";
import { createVerificationRunTool } from "../runtime/verification-run.ts";
import type { VerificationView } from "../runtime/verification-run.ts";
import { createResultSubmitTool } from "../runtime/result-submit.ts";
import { createRequirementReadTool } from "../runtime/requirement-read-tool.ts";
import type { RequirementReadBinding } from "../runtime/requirement-read-tool.ts";
import { VERDICTS } from "../runtime/verdicts.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const BODY_2 = "# 目标 {#goals}\n保留移动并增加快跑。\n";
const BODY_3 = "# 目标 {#goals}\n保留移动、快跑并增加跳跃。\n";
const NA = { applicable: false as const, reason: "无性能影响" };
const darwin = process.platform === "darwin";

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "pending-"));
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
    ["open", "read", "bind-workspace", "acquire-pm", "check-pm", "check-scheduling", "assess-update", "events"].includes(request.action) });
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
  const rounds = await CheckRoundService.open({ ...options, authorize: () => true });
  cleanups.push(async () => rounds.dispose());
  async function verification(role: "qa" | "reviewer" | "worker", runId = uuidv7()) {
    const instance = await createVerificationRunTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: () => true,
      grant: { role, callerId: uuidv7(), runId, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch } });
    cleanups.push(() => instance.dispose()); return { instance, runId };
  }
  function submit(role: "worker" | "reviewer" | "qa", runId: string, bound = true, review?: { taskId: string; attemptRunId: string }) {
    return createResultSubmitTool({ grant: { role, callerId: uuidv7(), runId, parentRunId: lease.runId }, authorize: () => true,
      ...(bound ? { verdictBinding: { dataRoot: options.dataRoot, requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, epoch: record.epoch,
        ...(review ? { review } : {}) } } : {}) });
  }
  async function reader(role: RequirementReadBinding["role"], extra: Partial<RequirementReadBinding> = {}) {
    const binding: RequirementReadBinding = { role, callerId: uuidv7(), runId: role === "pm" ? lease.runId : uuidv7(), requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease), ...extra };
    const instance = await createRequirementReadTool({ ...options, binding, authorize: () => true });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  const assess = (revision: number, tasks: Array<{ taskId: string; impact: "unaffected" | "affected" | "unknown"; reason: string }>, extra: Partial<{ lease: typeof lease }> = {}) =>
    state.assessUpdate({ lease: structuredClone(extra.lease ?? lease), version: state.read(created.requirementId).version, revision, assessmentId: uuidv7(), tasks });
  return { ...options, state, created, lease, workspace, rounds, verification, submit, reader, approve, assess, database: repositoryDatabase(options.dataRoot, options.repoId) };
}
const finding = (kind: "blocking" | "suggestion" | "unverified") => ({ kind, targetRef: "prod:goals", evidenceRef: null, trigger: "按方向键", impact: "无法移动" });

test("M6-AC19/M7A-AC2：裁决按阻塞/建议/未验证分级并关联目标与证据；worker 与 reviewer 只能引用自己的 debug 结果，reviewer 裁决绑定被审任务尝试；QA 必须绑定检查轮且不能是 PM 自身", async () => {
  const w = await world();
  if (!darwin) return;
  const worker = await w.verification("worker");
  const debug = await worker.instance.execute({ action: "run", kind: "debug", command: "true", performance: NA }) as VerificationView;
  const unbound = w.submit("worker", worker.runId, false);
  expect(() => unbound.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "自测通过", findings: [] } })).toThrow(/verdict_unavailable/);
  const workerSubmit = w.submit("worker", worker.runId);
  for (const bad of [{ status: "PASS" }, { verdict: "PASS", summary: "x", findings: [] }, { checkRoundId: null, verificationIds: [], summary: "x", findings: [{ kind: "pass", targetRef: "a", evidenceRef: null, trigger: "t", impact: "i" }] },
    { checkRoundId: null, verificationIds: [debug.verificationId, debug.verificationId], summary: "x", findings: [] }]) {
    expect(() => workerSubmit.execute({ action: "verdict", result: bad })).toThrow(/invalid_shape/);
  }
  expect(() => workerSubmit.execute({ action: "verdict", result: { summary: "完成", status: "completed", changed_files: ["src/a.ts"], verificationIds: "x" } }))
    .toThrow("invalid_shape：多余字段：status、changed_files；缺少字段：checkRoundId、findings；字段值格式不符：verificationIds；本动作允许字段：checkRoundId、verificationIds、summary、findings");
  expect(() => workerSubmit.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [debug.verificationId, debug.verificationId], summary: "x", findings: [] } }))
    .toThrow("invalid_shape：重复的验证引用");
  const own = workerSubmit.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [debug.verificationId], summary: "自测通过", findings: [finding("suggestion")] } }) as { conclusion: string; isPass: boolean };
  expect([own.conclusion, own.isPass]).toEqual(["clear", false]);
  const stranger = w.submit("worker", uuidv7());
  expect(() => stranger.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [debug.verificationId], summary: "偷用", findings: [] } })).toThrow(/out_of_scope/);
  expect(() => w.submit("reviewer", uuidv7()).execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "未绑定被审任务", findings: [] } })).toThrow(/invalid_binding/);
  const reviewed = { taskId: uuidv7(), attemptRunId: worker.runId };
  const reviewer = await w.verification("reviewer");
  await expect(reviewer.instance.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "kind_forbidden" });
  const reviewTest = await reviewer.instance.execute({ action: "run", kind: "debug", command: "touch src/review-wrote.ts", performance: NA }) as VerificationView;
  expect(reviewTest.status).toBe("failed");
  await expect(stat(join(w.workspace.path, "src", "review-wrote.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  const reviewerSubmit = w.submit("reviewer", reviewer.runId, true, reviewed);
  expect(() => reviewerSubmit.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [debug.verificationId], summary: "借 worker 自测", findings: [] } })).toThrow(/out_of_scope/);
  const rejected = reviewerSubmit.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [reviewTest.verificationId], summary: "任务级审查",
    findings: [finding("suggestion"), finding("blocking")] } }) as { conclusion: string; verdictId: string };
  expect(rejected.conclusion).toBe("blocked");
  const taskReview = withDatabase(w.database, (db) => db.read<{ review: unknown; checkRoundId: unknown }>(VERDICTS, rejected.verdictId)!.data);
  expect(taskReview).toMatchObject({ review: reviewed, checkRoundId: null });

  const round = await w.rounds.openRound({ lease: w.lease });
  const qa = await w.verification("qa");
  const formal = await qa.instance.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  expect(() => workerSubmit.execute({ action: "verdict", result: { checkRoundId: null, verificationIds: [formal.verificationId], summary: "借正式结果", findings: [] } })).toThrow(/out_of_scope/);
  expect(() => w.submit("qa", w.lease.runId).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "PM 自评", findings: [] } })).toThrow(/out_of_scope/);
  expect(() => w.submit("qa", qa.runId).execute({ action: "verdict", result: { checkRoundId: uuidv7(), verificationIds: [formal.verificationId], summary: "错轮", findings: [] } })).toThrow(/invalid_binding/);
  expect(() => w.submit("qa", qa.runId).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [debug.verificationId], summary: "借 debug", findings: [] } })).toThrow(/out_of_scope/);
  const blocked = w.submit("qa", qa.runId).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "黑盒验收",
    findings: [finding("suggestion"), finding("unverified"), finding("blocking")] } }) as { conclusion: string };
  expect(() => w.submit("reviewer", uuidv7(), true, reviewed).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId],
    summary: "检查轮里审查", findings: [] } })).toThrow(/out_of_scope/);
  expect(() => w.submit("qa", uuidv7()).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [], summary: "无证据", findings: [] } })).toThrow(/out_of_scope/);
  const unverified = w.submit("qa", uuidv7()).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "验收",
    findings: [finding("suggestion"), finding("unverified")] } }) as { conclusion: string };
  const clear = w.submit("qa", uuidv7()).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "验收", findings: [finding("suggestion")] } }) as { conclusion: string };
  expect([blocked.conclusion, unverified.conclusion, clear.conclusion]).toEqual(["blocked", "unverified", "clear"]);
  const stored = withDatabase(w.database, (db) => db.list(VERDICTS)).map((row) => row.data as { role: string; conclusion: string; findings: unknown[] });
  expect(stored).toHaveLength(5);
  expect(stored.every((verdict) => !("verdict" in verdict) && !("status" in verdict))).toBe(true);
  w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId });
  expect(() => w.submit("qa", qa.runId).execute({ action: "verdict", result: { checkRoundId: round.checkRoundId, verificationIds: [formal.verificationId], summary: "迟到", findings: [] } })).not.toThrow();
});

test("M6-AC17：已批准更新登记 pendingRevision；逐任务复核仍有 unknown 不解除，全部判定后才解除；多次更新按顺序复核，旧修订复核不能覆盖最新", async () => {
  const w = await world();
  await w.approve(BODY_2);
  const second = w.state.read(w.created.requirementId).data;
  expect(second.pendingRevision).toBe(second.revision);
  await expect(w.rounds.openRound({ lease: w.lease })).rejects.toMatchObject({ code: "pending_update" });
  await expect(w.state.checkScheduling(w.lease)).rejects.toThrow(/pending_update/);
  await expect(w.assess(second.revision, [{ taskId: "move", impact: "unaffected", reason: "x" }], { lease: { ...w.lease, fence: w.lease.fence + 1 } })).rejects.toMatchObject({ code: "stale_pm_lease",
    advice: { why: "本 PM 的租约已失效，可能已过期或被新 PM 接管", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" } });
  await expect(w.assess(second.revision - 1, [{ taskId: "move", impact: "unaffected", reason: "x" }])).rejects.toThrow(/assessment_conflict/);
  await expect(w.assess(second.revision, [])).rejects.toThrow(/invalid_shape/);
  const stillUnknown = await w.assess(second.revision, [{ taskId: "move", impact: "unaffected", reason: "章节未变" }, { taskId: "sprint", impact: "unknown", reason: "待分析" }]);
  expect(stillUnknown.data.pendingRevision).toBe(second.revision);
  await w.approve(BODY_3);
  const third = w.state.read(w.created.requirementId).data;
  expect(third.pendingRevision).toBe(third.revision);
  await expect(w.assess(second.revision, [{ taskId: "sprint", impact: "affected", reason: "补任务" }])).rejects.toThrow(/assessment_conflict/);
  const resolved = await w.assess(third.revision, [{ taskId: "move", impact: "unaffected", reason: "章节未变" }, { taskId: "sprint", impact: "affected", reason: "补任务" }, { taskId: "jump", impact: "affected", reason: "新增" }]);
  expect(resolved.data.pendingRevision).toBeNull();
  expect(resolved.data.revision).toBe(third.revision);
  expect(withDatabase(w.database, (db) => db.list("impact_assessments"))).toHaveLength(2);
  const events = w.state.events(w.created.requirementId).map((event) => event.data.kind);
  expect(events.filter((kind) => kind === "update.assessed")).toHaveLength(1);
  await expect(w.rounds.openRound({ lease: w.lease })).resolves.toMatchObject({ status: "open", baseline: { revision: third.revision } });
});

test("M6-AC16：defer 期间绑定检查轮的读取只取该轮登记的原批准基线；无绑定读取取最新批准；interrupt 或释放后绑定读取拒绝", async () => {
  const w = await world();
  const round = await w.rounds.openRound({ lease: w.lease });
  const original = w.state.read(w.created.requirementId).data.approved!;
  await w.approve(BODY_2);
  const latest = w.state.read(w.created.requirementId).data;
  const revision = latest.revision;
  const bound = await w.reader("qa", { checkRoundId: round.checkRoundId });
  const waiting = await bound.execute({ action: "read" }) as { text: string; source: { commit: string; revision: number; purpose: string; checkRoundId?: string } };
  expect(waiting.text).toContain("保留移动。"); expect(waiting.text).not.toContain("快跑");
  expect(waiting.source).toMatchObject({ commit: original.commit, revision: revision - 1, purpose: "check_round_original_baseline", checkRoundId: round.checkRoundId });
  w.rounds.decide({ lease: w.lease, checkRoundId: round.checkRoundId, kind: "defer", revision });
  const deferred = await bound.execute({ action: "read" }) as { text: string; source: { commit: string } };
  expect(deferred.text).toContain("保留移动。"); expect(deferred.source.commit).toBe(original.commit);
  const unbound = await w.reader("qa");
  const current = await unbound.execute({ action: "read" }) as { text: string; source: { commit: string; purpose: string } };
  expect(current.text).toContain("快跑"); expect(current.source).toMatchObject({ commit: latest.approved!.commit, purpose: "black_box_acceptance" });
  await expect(bound.execute({ action: "diff", fromRevision: 1 })).rejects.toMatchObject({ code: "diff_unavailable" });
  await expect(w.reader("qa", { checkRoundId: uuidv7() }).then((tool) => tool.execute({ action: "read" }))).rejects.toMatchObject({ code: "check_round_invalid" });
  await expect(w.reader("qa", { checkRoundId: round.checkRoundId, lease: { ...w.lease, fence: w.lease.fence + 1 } }).then((tool) => tool.execute({ action: "read" }))).rejects.toMatchObject({ code: "lease_stale" });
  const metadata = await bound.execute({ action: "metadata" }) as { source: { revision: number } };
  expect(metadata.source.revision).toBe(revision - 1);
  w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId });
  await expect(bound.execute({ action: "read" })).rejects.toMatchObject({ code: "check_round_invalid" });

  await w.assess(revision, [{ taskId: "move", impact: "unaffected", reason: "章节未变" }]);
  const second = await w.rounds.openRound({ lease: w.lease });
  const reader = await w.reader("reviewer", { checkRoundId: second.checkRoundId });
  await expect(reader.execute({ action: "read" })).resolves.toMatchObject({ source: { commit: latest.approved!.commit } });
  await w.approve(BODY_3);
  w.rounds.decide({ lease: w.lease, checkRoundId: second.checkRoundId, kind: "interrupt", revision: revision + 1 });
  await expect(reader.execute({ action: "read" })).rejects.toMatchObject({ code: "check_round_invalid" });
});
