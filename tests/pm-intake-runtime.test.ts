import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { createPmIntakeProviders, evaluatePmIntakeGate, pmDecisionNotes, pmSourceDirectory } from "../src/modules/pm/pm-intake-runtime.ts";
import { intakeSubmitTool } from "../src/app/daemon/pm-tools.ts";
import { scenariosWithoutOwnRef, unknownIntakeSourceRefs } from "../src/modules/pm/pm-intake-contracts.ts";
import type { IntakeReviewRecord, PmUnderstanding } from "../src/modules/pm/pm-intake-contracts.ts";
import { pmUnderstandingHash } from "../src/modules/pm/pm-intake-service.ts";
import { pmIntakeReviewKit } from "./helpers/pm-intake-review.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { addQuestion } from "./helpers/pm-intake-service-test-support.ts";

vi.setConfig({ testTimeout: 30_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });

async function world() {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  const kit = await pmIntakeReviewKit(fixture);
  const gate = () => evaluatePmIntakeGate({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, lease: fixture.lease });
  return { fixture, ...kit, gate };
}

test("PM 接手可引用的出处清单与主代理核对时构造的清单一致；提交内容里清单外的出处被逐个指出", async () => {
  const kit = await world(), fixture = kit.fixture;
  kit.submit(kit.content);
  const view = await kit.intake.openRequest(fixture.call, fixture.operationId());
  const directory = pmSourceDirectory({ dataRoot: fixture.dataRoot, repoId: fixture.repoId }, fixture.requirementId);
  expect(directory).toEqual(view.sourceDirectory);
  const notes = pmDecisionNotes({ dataRoot: fixture.dataRoot, repoId: fixture.repoId }, fixture.requirementId);
  expect(notes.map((note) => note.id)).toEqual(directory!.decisionIds);
  expect(notes.length > 0 && notes.every((note) => note.status === "confirmed" && note.unitIds.every((id) => directory!.prdUnitIds.includes(id)) && note.conclusion.length > 0)).toBe(true);
  expect(unknownIntakeSourceRefs(kit.content, directory!)).toEqual([]);
  const forged = structuredClone(kit.content);
  forged.goals[0]!.sourceRefs.push({ kind: "decision", id: "guessed-decision" });
  forged.scenarioCoverage[0]!.scenarioId = "guessed-scenario";
  expect(unknownIntakeSourceRefs(forged, directory!)).toEqual(["decision:guessed-decision", "prd-scenario:guessed-scenario"]);
  // 场景覆盖项的出处里没有该场景本身时，主代理核对会拒收；PM 提交时就要指出是哪几个场景
  expect(scenariosWithoutOwnRef(kit.content)).toEqual([]);
  const unitOnly = structuredClone(kit.content), first = unitOnly.scenarioCoverage[0]!;
  first.sourceRefs = first.sourceRefs.map((ref) => ref.kind === "prd-scenario" ? { kind: "prd-unit" as const, id: ref.id } : ref);
  expect(scenariosWithoutOwnRef(unitOnly)).toEqual([first.scenarioId]);
  const tool = intakeSubmitTool({ alive: () => true, checkLease: async () => {}, dataRoot: fixture.dataRoot, repoId: fixture.repoId, lease: fixture.lease, currentBaseline: () => null } as never);
  const call = (understanding: unknown) => (tool.execute as (id: string, params: unknown) => Promise<unknown>)("call", { action: "ask", purpose: "pm-intake", understanding });
  await expect(call(unitOnly)).rejects.toThrow(`这些场景覆盖项的出处里没有引用场景本身：${first.scenarioId}`);
  await expect(call(kit.content)).resolves.toMatchObject({ content: [{ text: expect.stringContaining("submitted") }] });
  kit.submit(unitOnly);
  await expect(kit.intake.openRequest(fixture.call, fixture.operationId())).rejects.toMatchObject({ code: "unknown_source" });
});

test("M7-AC13：主代理经真实提供方读到 PM 会话里的提交，核对通过前门槛拒绝，通过后放行", async () => {
  const w = await world();
  expect(w.gate()).toEqual({ allowed: false, reasons: ["review_missing"] });
  const callId = w.submit(w.content);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.submissionRef).toBe(`pm/${w.fixture.lease.runId}/${callId}`);
  expect(view.understanding.goals).toEqual(w.content.goals);
  expect(w.gate()).toMatchObject({ allowed: false, reasons: ["review_missing"] });
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(w.gate()).toMatchObject({ allowed: true });
});

test("M9-AC2：有一版保存了但还没批准的草稿时，主代理照样能打开并登记 PM 接手理解的核对，核对只认已批准版本", async () => {
  const w = await world(), id = w.fixture.lease.requirementId;
  w.submit(w.content);
  const saved = await w.fixture.service.read({ requirementId: id, source: "saved" });
  await w.fixture.service.updateDraft({ requirementId: id, version: w.fixture.state.read(id).version, operationId: uuidv7(), title: saved.title, body: `${saved.body}补充一句。\n` });
  expect(w.fixture.state.read(id).data.saved!.hash).not.toBe(w.fixture.state.read(id).data.approved!.hash);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.understanding.goals).toEqual(w.content.goals);
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(w.gate()).toMatchObject({ allowed: true });
});

test("接手核对通过后，主代理再就这个需求向用户提问，不让已通过的核对失效", async () => {
  const w = await world();
  w.submit(w.content);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(w.gate()).toMatchObject({ allowed: true });
  addQuestion(w.fixture);
  expect(w.gate()).toMatchObject({ allowed: true });
});

test("M7-AC14：未被工具受理的提交不计入；核对不通过、PM 改交理解或丢失基线后旧核对不能放行", async () => {
  const w = await world();
  w.submit(w.content);
  w.submit({ ...w.content, goals: [{ text: "未受理的改写", sourceRefs: w.content.goals[0]!.sourceRefs }] }, true);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.understanding.goals).toEqual(w.content.goals);
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "pm_correction_required", shortIssues: ["目标理解有误"] });
  expect(w.gate()).toMatchObject({ allowed: false, reasons: ["pm_correction_required"] });

  const v = await world();
  v.submit(v.content);
  const passed = await v.intake.openRequest(v.fixture.call, v.fixture.operationId());
  await v.intake.recordReview(v.fixture.call, passed.requestId, v.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(v.gate()).toMatchObject({ allowed: true });
  v.submit({ ...v.content, goals: [{ text: "PM 自行改交的新理解", sourceRefs: v.content.goals[0]!.sourceRefs }] });
  expect(v.gate()).toMatchObject({ allowed: false, reasons: ["understanding_baseline_mismatch"] });
});

test("M7-AC14：伪造的提交不能被当作 PM 的理解——只读取当前租约运行自己的会话", async () => {
  const w = await world();
  const providers = createPmIntakeProviders(w.fixture.dataRoot);
  const captured = w.fixture.captureCurrent();
  expect(await providers.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal })).toBeNull();
  await expect(w.intake.openRequest(w.fixture.call, w.fixture.operationId())).rejects.toThrow();
});

test("M7-AC14：针对旧批准基线受理的理解不能被当作对当前基线的理解", async () => {
  const w = await world();
  w.submit(w.content, false, { ...w.current, approvedRevision: w.current.approvedRevision - 1 });
  w.submit(w.content, false, { ...w.current, approvedPrdHash: "0".repeat(64) });
  await expect(w.intake.openRequest(w.fixture.call, w.fixture.operationId())).rejects.toThrow();
  w.submit(w.content);
  expect((await w.intake.openRequest(w.fixture.call, w.fixture.operationId())).understanding.goals).toEqual(w.content.goals);
});

test("M8M-AC4：需求累计提过 129 个问题时，PM 仍能交接手理解、主代理仍能打开核对且通过后放行", async () => {
  const w = await world();
  for (let i = 0; i < 129; i++) addQuestion(w.fixture);
  w.submit(w.content);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.sourceDirectory.questionIds).toHaveLength(129);
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(w.gate()).toMatchObject({ allowed: true });
});

const DIRECT_CORRECTIONS = 64;

test(`M8M-AC4：PM 被要求改交 ${DIRECT_CORRECTIONS + 1} 次、接手记录超过 256 行后，主代理仍能打开第 ${DIRECT_CORRECTIONS + 2} 份并登记核对`, async () => {
  const w = await world();
  const goals = (i: number) => [{ text: `第 ${i} 次理解`, sourceRefs: w.content.goals[0]!.sourceRefs }];
  // 直接写入与正式流程同样的“改交请求 + 核对结论”，省掉每轮重复的当前状态核对
  for (let i = 0; i < DIRECT_CORRECTIONS; i++) {
    const captured = w.fixture.captureCurrent();
    const understanding: PmUnderstanding = { format: "pm-understanding/v1", binding: captured.binding, ...w.content, goals: goals(i) };
    const submissionRef = `pm/${w.fixture.lease.runId}/call-direct-${i}`, submissionHash = pmUnderstandingHash(understanding);
    const creator = { windowId: w.fixture.identity.windowId, sessionId: w.fixture.identity.sessionId, toolCallId: w.fixture.identity.toolCallId };
    const prepared = w.fixture.intakeStore.prepareRequest({ operationId: w.fixture.operationId(), proof: captured.proof, submissionRef, submissionHash, creator });
    const stored = w.fixture.intakeStore.commitRequest(prepared, () => {});
    const refs = new Map<string, IntakeReviewRecord["sourceRefs"][number]>();
    for (const item of [understanding.goals, understanding.nonGoals, understanding.constraints, understanding.allowedActions, understanding.unresolved, understanding.scenarioCoverage].flat()) {
      for (const ref of item.sourceRefs) refs.set(`${ref.kind}\0${ref.id}`, { ...ref });
    }
    const record: IntakeReviewRecord = { format: "pm-intake-review/v1", reviewId: uuidv7(), requestId: stored.record.requestId, binding: structuredClone(captured.binding),
      submissionRef, submissionHash, reviewer: creator, result: "pm_correction_required",
      sourceRefs: [...refs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), shortIssues: ["目标理解有误"] };
    w.fixture.intakeStore.commitReview(w.fixture.intakeStore.prepareReview({ operationId: w.fixture.operationId(), proof: stored.currentProof, record }), () => {});
  }
  w.submit({ ...w.content, goals: goals(DIRECT_CORRECTIONS) });
  const corrected = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  await w.intake.recordReview(w.fixture.call, corrected.requestId, w.fixture.operationId(), { result: "pm_correction_required", shortIssues: ["目标理解有误"] });
  const rows = w.fixture.db((db) => (db.connection.prepare("SELECT COUNT(*) AS n FROM records WHERE namespace LIKE 'pm_intake_%'").get() as { n: number }).n);
  expect(rows).toBeGreaterThan(256);
  w.submit(w.content);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.understanding.goals).toEqual(w.content.goals);
  await expect(w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] })).resolves.toBeDefined();
}, 120_000);
