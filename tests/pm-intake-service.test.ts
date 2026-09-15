import { afterEach, expect, test, vi } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { approvalManifestDigest, checkApprovalManifest } from "../runtime/approval-manifest.ts";
import { partitionProdDocument } from "../runtime/prod-view.ts";
import { decisionDigest } from "../runtime/short-decision-format.ts";
import { PmIntakeStore, PM_INTAKE_NAMESPACES } from "../runtime/pm-intake-store.ts";
import { PmIntakeService } from "../runtime/pm-intake-service.ts";
import type { PmSourceDirectoryProvider, PmSubmissionProvider } from "../runtime/pm-intake-service.ts";
import type { RequirementService } from "../runtime/requirement-service.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 20_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });
async function world(): Promise<PmIntakeFixture> {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  return fixture;
}

function addQuestion(fixture: PmIntakeFixture, requestId = uuidv7()): string {
  const current = fixture.state.read(fixture.requirementId);
  fixture.db((db) => db.transaction(() => db.create("interaction_questions_v1", requestId, {
    format: "interaction-question/v1",
    requestId,
    repoId: fixture.repoId,
    basis: { requirementId: fixture.requirementId, version: current.version, epoch: current.data.epoch, prod: current.data.approved },
    candidate: null,
    proposal: { conclusion: "短信有效期是多少", scope: "验证码失败场景", references: [], supersedes: [] },
    actions: [],
    createdAt: current.data.updatedAt,
  }, requestId)));
  return requestId;
}

function persisted(fixture: PmIntakeFixture): Record<string, unknown[]> {
  return fixture.db((db) => Object.fromEntries(Object.values(PM_INTAKE_NAMESPACES).map((namespace) =>
    [namespace, db.list(namespace).map((row) => row.data)])));
}

test.each([123, true, ["reference"], null, "reference\n"])("公开service拒绝坏类型引用/调用ID而不登记：%j", async (bad) => {
  const fixture = await world();
  const provider: PmSubmissionProvider = {
    loadCurrent: async (query) => {
      const material = await fixture.submissionProvider.loadCurrent(query);
      return material && { ...material, submissionRef: bad } as never;
    },
    assertCurrent: (handle, query) => fixture.submissionProvider.assertCurrent(handle, query),
  };
  const intake = fixture.makeIntake({ submissionProvider: provider });
  const before = persisted(fixture);
  await expect(intake.openRequest(fixture.call, fixture.operationId())).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
  const wrongCall = fixture.newCall({ toolCallId: bad } as never);
  await expect(fixture.intake.openRequest(wrongCall, fixture.operationId())).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test.each(["submissionRef", "creator"] as const)("已存request的%s类型损坏，fresh读取及幂等均拒绝", async (field) => {
  const fixture = await world(), operationId = fixture.operationId();
  const view = await fixture.intake.openRequest(fixture.call, operationId);
  fixture.db((db) => {
    const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.requests, view.requestId)!;
    db.update(PM_INTAKE_NAMESPACES.requests, view.requestId, row.version, { ...row.data,
      ...(field === "submissionRef" ? { submissionRef: 123 } : { creator: { ...(row.data.creator as object), toolCallId: true } }) });
  });
  const before = persisted(fixture);
  await expect(fixture.intake.readRequest(fixture.call, view.requestId)).rejects.toThrow();
  await expect(fixture.intake.openRequest(fixture.call, operationId)).rejects.toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test("真实连续决定保留A、修改B后，接手覆盖retained实际决定；漏引用或实际行变化拒绝", async () => {
  const fixture = await createPmIntakeFixture({ retained: true }); clean.push(fixture);
  const retained = fixture.manifest.retainedSources?.find((source) => source.unitId === "goal.login");
  expect(retained).toBeDefined();
  expect(fixture.manifest.units.find((unit) => unit.id === "goal.login")!.decisionIds).toContain(retained!.decision.id);
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(view.sourceDirectory.decisionIds).toContain(retained!.decision.id);
  expect(fixture.manifest.actions[0]!.goalIds).toEqual(["scenario.failure"]);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  const approved = await fixture.service.read({ requirementId: fixture.requirementId, source: "approved" });
  const invalid = structuredClone(fixture.manifest);
  invalid.units.find((unit) => unit.id === "goal.login")!.decisionIds = [...invalid.units.find((unit) => unit.id === "scenario.failure")!.decisionIds];
  invalid.manifestHash = approvalManifestDigest(invalid);
  expect(() => checkApprovalManifest(invalid, { requirementId: fixture.requirementId, candidate: fixture.manifest.candidate,
    partition: partitionProdDocument(fixture.requirementId, approved.title, approved.body) })).toThrow();
  fixture.db((db) => { const row = db.read("short_decisions", retained!.decision.id)!;
    db.update("short_decisions", retained!.decision.id, row.version, row.data); });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
});

test("原对象交付同步核验；克隆、跨service、换call及旧head不得重新授权", async () => {
  const fixture = await world();
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.understanding.binding)).toBe(true);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  expect(() => fixture.intake.assertResultCurrent(fixture.call, structuredClone(view))).toThrow(/unproven_result/);
  expect(() => fixture.makeIntake().assertResultCurrent(fixture.call, view)).toThrow(/unproven_result/);
  expect(() => fixture.intake.assertResultCurrent(fixture.newCall(), view)).toThrow(/unproven_result/);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  const next = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
  await expect(fixture.intake.readRequest(fixture.call, view.requestId)).rejects.toThrow(/request_not_current/);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, next)).not.toThrow();
});

test("同binding提交内容往返仍撤销旧provider handle，取消后拒绝原结果而保留历史", async () => {
  const fixture = await world();
  const controller = new AbortController();
  const view = await fixture.intake.openRequest(fixture.call, fixture.operationId(), controller.signal);
  const query = { binding: view.binding, sourceDirectoryHash: view.sourceDirectoryHash, maxBytes: 49_152, signal: controller.signal };
  fixture.submissionProvider.mutate = (understanding) => { understanding.goals[0]!.text += "变更"; };
  expect((await fixture.submissionProvider.loadCurrent(query))!.submissionHash).not.toBe(view.submissionHash);
  fixture.submissionProvider.mutate = undefined;
  expect((await fixture.submissionProvider.loadCurrent(query))!.submissionHash).toBe(view.submissionHash);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow(/submission_changed/);
  const fresh = await fixture.intake.readRequest(fixture.call, view.requestId, controller.signal);
  expect(() => fixture.intake.assertResultCurrent(fixture.call, fresh)).not.toThrow();
  controller.abort();
  expect(() => fixture.intake.assertResultCurrent(fixture.call, fresh)).toThrow(/operation_cancelled/);
  expect((persisted(fixture)[PM_INTAKE_NAMESPACES.requests] ?? []).length).toBe(1);
});

test("幂等指针错配不能组合另一个请求hash与当前理解", async () => {
  const fixture = await world(), operationId = fixture.operationId();
  const first = await fixture.intake.openRequest(fixture.call, operationId);
  fixture.submissionProvider.mutate = (understanding) => { understanding.goals[0]!.text += "另一份理解"; };
  const second = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(first.submissionHash).not.toBe(second.submissionHash);
  fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.operations, operationId)!;
    db.update(PM_INTAKE_NAMESPACES.operations, operationId, row.version, { ...row.data, resultId: second.requestId }); });
  fixture.submissionProvider.mutate = undefined;
  const before = persisted(fixture);
  await expect(fixture.intake.openRequest(fixture.call, operationId)).rejects.toThrow(/operation_conflict/);
  expect(persisted(fixture)).toEqual(before);
});

test("另一需求的隔离intake元数据变化不使当前原对象失效", async () => {
  const fixture = await world(), view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const otherRequirement = uuidv7(), requestId = uuidv7(), operationId = uuidv7();
  const binding = { ...view.binding, requirementId: otherRequirement };
  const sourceDirectoryHash = decisionDigest({ format: "pm-intake-source-directory/v1", binding, sourceDirectory: view.sourceDirectory });
  const record = { format: "pm-intake-request/v1", requestId, binding, sourceDirectoryHash, submissionRef: "pm/other",
    submissionHash: "f".repeat(64), creator: { windowId: "other", sessionId: "other", toolCallId: "other" }, createdAt: view.createdAt };
  fixture.db((db) => db.transaction(() => {
    db.create(PM_INTAKE_NAMESPACES.directories, sourceDirectoryHash, { format: "pm-intake-directory/v1", binding, sourceDirectory: view.sourceDirectory, sourceDirectoryHash, createdAt: view.createdAt });
    db.create(PM_INTAKE_NAMESPACES.requests, requestId, record, requestId);
    db.create(PM_INTAKE_NAMESPACES.operations, operationId, { format: "pm-intake-operation/v1", operationId, operation: "request", resultId: requestId,
      intentHash: decisionDigest({ operation: "request", binding, submissionRef: record.submissionRef, submissionHash: record.submissionHash, sourceDirectoryHash }), createdAt: view.createdAt }, operationId);
    db.create(PM_INTAKE_NAMESPACES.heads, otherRequirement, { format: "pm-intake-head/v1", requirementId: otherRequirement, binding, requestId, reviewId: null, updatedAt: view.createdAt });
  }));
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
  fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.heads, otherRequirement)!;
    db.update(PM_INTAKE_NAMESPACES.heads, otherRequirement, row.version, { ...row.data, updatedAt: view.createdAt + 1 }); });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).not.toThrow();
});

test.each(["revoke", "close", "release"] as const)("%s后拒绝原对象交付，已登记历史不删除", async (mode) => {
  const fixture = await world(), view = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const before = persisted(fixture);
  if (mode === "revoke") fixture.host.revoke();
  else if (mode === "release") fixture.state.releasePm(fixture.lease);
  else await fixture.state.beginClose({ requirementId: fixture.requirementId, version: fixture.state.read(fixture.requirementId).version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  expect(() => fixture.intake.assertResultCurrent(fixture.call, view)).toThrow();
  expect(persisted(fixture)).toEqual(before);
});

test("最后provider回调改变request实际行，read proof拒绝交付旧字段", async () => {
  const fixture = await world();
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  let assertions = 0;
  fixture.sourceProvider.assertHook = () => {
    if (++assertions !== 4) return;
    fixture.db((db) => { const row = db.read<Record<string, unknown>>(PM_INTAKE_NAMESPACES.requests, request.requestId)!;
      db.update(PM_INTAKE_NAMESPACES.requests, request.requestId, row.version, { ...row.data, submissionRef: "pm/changed" }); });
  };
  await expect(fixture.intake.readRequest(fixture.call, request.requestId)).rejects.toThrow();
  expect(assertions).toBe(4);
});

test.each(["open", "read", "review"] as const)("%s最后DB核验之后不再调用可变Main resolver", async (mode) => {
  const fixture = await world();
  const request = mode === "open" ? undefined : await fixture.intake.openRequest(fixture.call, fixture.operationId());
  let checks = 0, finalChecked = false, lateResolverCalls = 0;
  class ObservedStore extends PmIntakeStore {
    override assertReturnCurrent(...args: Parameters<PmIntakeStore["assertReturnCurrent"]>) {
      super.assertReturnCurrent(...args);
      if (++checks === 2) finalChecked = true;
    }
  }
  const store = new ObservedStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId });
  const intake = new PmIntakeService({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, state: fixture.state,
    requirementService: fixture.service, authorization: fixture.host, store,
    sourceDirectoryProvider: fixture.sourceProvider, submissionProvider: fixture.submissionProvider,
    mainCallResolver: { resolve(call) {
      if (finalChecked) { lateResolverCalls++; addQuestion(fixture); }
      return call === fixture.call ? fixture.identity : null;
    } } });
  if (mode === "open") await intake.openRequest(fixture.call, fixture.operationId());
  else if (mode === "read") await intake.readRequest(fixture.call, request!.requestId);
  else await intake.recordReview(fixture.call, request!.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(finalChecked).toBe(true); expect(lateResolverCalls).toBe(0);
  expect(fixture.db((db) => db.list("interaction_questions_v1"))).toHaveLength(0);
});

test("取消检查只读取原生AbortSignal，不执行伪信号的getter", async () => {
  const fixture = await world(); let reads = 0;
  const forged = { get aborted() { reads++; addQuestion(fixture); return false; } } as AbortSignal;
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId(), forged)).rejects.toMatchObject({ code: "invalid_signal" });
  expect(reads).toBe(0);
  expect(fixture.db((db) => db.list("interaction_questions_v1"))).toHaveLength(0);
});

test("真实批准prod、独立worktree、PM lease和可信provider可登记请求、读取及passed复核", async () => {
  const fixture = await world();
  const beforeRequirement = fixture.state.read(fixture.requirementId);
  const beforeOwner = fixture.db((db) => db.read("pm_ownership", fixture.requirementId));
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(request).toMatchObject({ understandingStatus: "accepted", uncoveredScenarioIds: [], executionEnabled: false,
    scheduling: "not_implemented", userAuthorizationCreated: false });
  expect(request.binding).toMatchObject(fixture.basis);
  expect(request.sourceDirectory).toEqual(fixture.sourceDirectory);
  expect(await fixture.intake.readRequest(fixture.newCall(), request.requestId)).toEqual(request);

  const review = await fixture.intake.recordReview(fixture.newCall(), request.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(review).toMatchObject({ record: { requestId: request.requestId, result: "passed" }, executionEnabled: false,
    scheduling: "not_implemented", userAuthorizationCreated: false });
  expect(fixture.state.read(fixture.requirementId)).toEqual(beforeRequirement);
  expect(fixture.db((db) => db.read("pm_ownership", fixture.requirementId))).toEqual(beforeOwner);
  const all = persisted(fixture);
  expect(all[PM_INTAKE_NAMESPACES.requests]).toHaveLength(1);
  expect(all[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(1);
  const serialized = JSON.stringify(all);
  expect(serialized).not.toMatch(/输入正确验证码|错误验证码显示失败|understanding|prodBody|transcript|userAuthorizationCreated/);
  expect(fixture.db((db) => db.list("receipts").length)).toBe(0);
});

test("source或submission provider缺失时默认拒绝，不使用fixture或旧流程兜底", async () => {
  const fixture = await world();
  await expect(fixture.makeIntake({ sourceDirectoryProvider: null }).openRequest(fixture.call, fixture.operationId()))
    .rejects.toMatchObject({ code: "source_directory_provider_unavailable" });
  await expect(fixture.makeIntake({ submissionProvider: null }).openRequest(fixture.call, fixture.operationId()))
    .rejects.toMatchObject({ code: "submission_provider_unavailable" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
});

test("来源handle和Main call不能由同形JSON重建", async () => {
  const fixture = await world();
  const source: PmSourceDirectoryProvider = {
    async loadCurrent(query) {
      const material = await fixture.sourceProvider.loadCurrent(query);
      return material && { ...material, handle: structuredClone(material.handle) };
    },
    assertCurrent: (handle, query) => fixture.sourceProvider.assertCurrent(handle, query),
  };
  await expect(fixture.makeIntake({ sourceDirectoryProvider: source }).openRequest(fixture.call, fixture.operationId())).rejects.toThrow(/source_changed/);
  await expect(fixture.intake.openRequest(structuredClone(fixture.call), fixture.operationId())).rejects.toMatchObject({ code: "untrusted_main_call" });
});

test("可信来源目录不强制scenario前缀，但拒绝正文外、重复或漏掉当前问题", async () => {
  const fixture = await world();
  fixture.sourceProvider.scenarioIds = ["goal.login"];
  fixture.submissionProvider.mutate = (value) => {
    value.goals = value.goals.filter((item) => !item.sourceRefs.some((ref) => ref.kind === "prod-scenario" && ref.id === "scenario.failure"));
    value.scenarioCoverage = value.scenarioCoverage.filter((item) => item.scenarioId === "goal.login");
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).resolves.toMatchObject({
    sourceDirectory: { requiredScenarioIds: ["goal.login"] }, understandingStatus: "accepted",
  });

  const unknown = await world();
  unknown.sourceProvider.scenarioIds = ["not.in.prod"];
  await expect(unknown.intake.openRequest(unknown.call, unknown.operationId())).rejects.toMatchObject({ code: "source_directory_mismatch" });

  const duplicate = await world();
  duplicate.sourceProvider.scenarioIds = ["goal.login", "goal.login"];
  await expect(duplicate.intake.openRequest(duplicate.call, duplicate.operationId())).rejects.toMatchObject({ code: "source_directory_unavailable" });

  const omitted = await world();
  addQuestion(omitted);
  await expect(omitted.intake.openRequest(omitted.call, omitted.operationId())).rejects.toMatchObject({ code: "source_directory_mismatch" });
});

test("可信来源可声明当前全部问题，理解引用按实际问题目录核对", async () => {
  const fixture = await world();
  const questionId = addQuestion(fixture);
  fixture.sourceProvider.questionIds = [questionId];
  fixture.submissionProvider.mutate = (value) => value.unresolved.push({ text: "短信有效期未决", impact: "影响失败等待窗口",
    sourceRefs: [{ kind: "question", id: questionId }] });
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(request.sourceDirectory.questionIds).toEqual([questionId]);
  expect(request.understanding.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ sourceRefs: [{ kind: "question", id: questionId }] })]));
});

test("每个异步边界后都检查取消，即使provider忽略signal仍不得登记", async () => {
  const sourceRace = await world();
  const sourceAbort = new AbortController();
  sourceRace.sourceProvider.loadHook = () => sourceAbort.abort();
  await expect(sourceRace.intake.openRequest(sourceRace.call, sourceRace.operationId(), sourceAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  const submissionRace = await world();
  const submissionAbort = new AbortController();
  submissionRace.submissionProvider.loadHook = () => submissionAbort.abort();
  await expect(submissionRace.intake.openRequest(submissionRace.call, submissionRace.operationId(), submissionAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  const readRace = await world();
  const readAbort = new AbortController();
  const service = { read: async (...args: Parameters<RequirementService["read"]>) => {
    const result = await readRace.service.read(...args); readAbort.abort(); return result;
  } } as unknown as RequirementService;
  await expect(readRace.makeIntake({ requirementService: service }).openRequest(readRace.call, readRace.operationId(), readAbort.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });

  for (const fixture of [sourceRace, submissionRace, readRace]) {
    expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
  }
});

test("Host撤权后即使重建相同window/session/需求绑定也不能取得原调用身份", async () => {
  const fixture = await world();
  fixture.sourceProvider.loadHook = () => {
    fixture.host.revoke();
    fixture.host.startWindow({ kind: "main", windowId: fixture.identity.windowId, sessionId: fixture.identity.sessionId, repoIds: [fixture.repoId] });
    fixture.host.bindRequirement(fixture.repoId, fixture.requirementId, fixture.identity.sessionId);
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).rejects.toMatchObject({ code: "main_call_changed" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
});

test("逐个provider最终断言必须同步，外层void不能吞掉Promise", async () => {
  const sourceFixture = await world();
  const asyncSource: PmSourceDirectoryProvider = {
    loadCurrent: (query) => sourceFixture.sourceProvider.loadCurrent(query),
    assertCurrent: (() => Promise.resolve()) as unknown as PmSourceDirectoryProvider["assertCurrent"],
  };
  await expect(sourceFixture.makeIntake({ sourceDirectoryProvider: asyncSource }).openRequest(sourceFixture.call, sourceFixture.operationId()))
    .rejects.toMatchObject({ code: "async_source_directory_assertion" });

  const submissionFixture = await world();
  const asyncSubmission: PmSubmissionProvider = {
    loadCurrent: (query) => submissionFixture.submissionProvider.loadCurrent(query),
    assertCurrent: (() => Promise.resolve()) as unknown as PmSubmissionProvider["assertCurrent"],
  };
  await expect(submissionFixture.makeIntake({ submissionProvider: asyncSubmission }).openRequest(submissionFixture.call, submissionFixture.operationId()))
    .rejects.toMatchObject({ code: "async_submission_assertion" });
});

test("最终回调增加问题或取代决定时，即使requirement version不变也拒绝且不留请求", async () => {
  for (const mutation of ["question", "decision"] as const) {
    const fixture = await world();
    const requirementVersion = fixture.state.read(fixture.requirementId).version;
    let changed = false;
    fixture.sourceProvider.assertHook = () => {
      if (changed) return;
      changed = true;
      if (mutation === "question") addQuestion(fixture);
      else fixture.db((db) => db.transaction(() => {
        const id = fixture.manifest.actions[0]!.decisionIds[0]!, row = db.read<Record<string, unknown>>("short_decisions", id)!;
        db.update("short_decisions", id, row.version, { ...row.data, status: "superseded", supersededBy: uuidv7() });
      }));
    };
    await expect(fixture.intake.openRequest(fixture.call, fixture.operationId())).rejects.toThrow();
    expect(fixture.state.read(fixture.requirementId).version).toBe(requirementVersion);
    expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
  }
});

test("提交后到最终交付前取消会保留已登记事实，但拒绝返回", async () => {
  const fixture = await world();
  const controller = new AbortController();
  fixture.sourceProvider.assertHook = () => {
    if (persisted(fixture)[PM_INTAKE_NAMESPACES.requests].length === 1) controller.abort();
  };
  await expect(fixture.intake.openRequest(fixture.call, fixture.operationId(), controller.signal))
    .rejects.toMatchObject({ code: "operation_cancelled" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(1);
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(0);
});

test("同operationId同业务意图可由新toolCallId幂等重试，异意图冲突", async () => {
  const fixture = await world();
  const operationId = fixture.operationId();
  const first = await fixture.intake.openRequest(fixture.call, operationId);
  const second = await fixture.intake.openRequest(fixture.newCall(), operationId);
  expect(second.requestId).toBe(first.requestId);
  fixture.submissionProvider.mutate = (value) => { value.goals[0]!.text = "不同业务理解"; };
  await expect(fixture.intake.openRequest(fixture.newCall(), operationId)).rejects.toMatchObject({ code: "operation_conflict" });
});

test("review幂等意图不含随机reviewId/toolCallId，异结果仍冲突且终态不可覆盖", async () => {
  const fixture = await world();
  const request = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  const operationId = fixture.operationId();
  const first = await fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId, { result: "passed", shortIssues: [] });
  const retry = await fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId, { result: "passed", shortIssues: [] });
  expect(retry.record.reviewId).toBe(first.record.reviewId);
  expect(retry.record.reviewer).toEqual(first.record.reviewer);
  await expect(fixture.intake.recordReview(fixture.newCall(), request.requestId, operationId,
    { result: "pm_correction_required", shortIssues: ["理解错误"] })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(fixture.intake.recordReview(fixture.newCall(), request.requestId, fixture.operationId(),
    { result: "passed", shortIssues: [] })).rejects.toMatchObject({ code: "request_not_current" });
  expect(persisted(fixture)[PM_INTAKE_NAMESPACES.reviews]).toHaveLength(1);
});

test("完整返回预算按实际UTF-8序列化计算，超限不截断也不登记", async () => {
  const fixture = await world();
  fixture.submissionProvider.mutate = (value) => { value.goals[0]!.text = "😀".repeat(400); };
  const accepted = await fixture.intake.openRequest(fixture.call, fixture.operationId());
  expect(Buffer.byteLength(JSON.stringify(accepted), "utf8")).toBeLessThanOrEqual(49_152);

  const tooLarge = await world();
  tooLarge.submissionProvider.mutate = (value) => {
    const item = value.goals[0]!;
    value.goals = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(item), text: `${index}${"\\".repeat(399)}` }));
    value.nonGoals = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.constraints = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
    value.allowedActions = Array.from({ length: 32 }, () => ({ ...structuredClone(item), text: "\\".repeat(400) }));
  };
  await expect(tooLarge.intake.openRequest(tooLarge.call, tooLarge.operationId())).rejects.toThrow(/resource_limit|response_budget_exceeded/);
  expect(persisted(tooLarge)[PM_INTAKE_NAMESPACES.requests]).toHaveLength(0);
});
