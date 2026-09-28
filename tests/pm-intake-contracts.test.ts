import { expect, test } from "vitest";
import {
  IntakeContractError,
  PM_INTAKE_LIMITS,
  checkIntakeReviewRecord,
  checkPmUnderstanding,
  evaluateIntakeContinuity,
  intakeBindingsEqual,
} from "../runtime/pm-intake-contracts.ts";
import type {
  IntakeBinding,
  IntakeContinuityFacts,
  IntakeImpactLink,
  IntakeReviewRecord,
  IntakeSourceDirectory,
  PmUnderstanding,
} from "../runtime/pm-intake-contracts.ts";

const v7 = (value: number): string => `0197b7b0-6a20-7c51-8a32-${value.toString(16).padStart(12, "0")}`;
const h = (character: string): string => character.repeat(64);
const c = (character: string): string => character.repeat(40);
const approvalScope = (character: string): string => `intake-approval-scope/v1:${h(character)}`;
const actionScope = (character: string): string => `intake-action-scope/v1:${h(character)}`;
const ref = (kind: "prod-unit" | "prod-scenario" | "decision" | "question", id: string) => ({ kind, id });
const impactRef = (kind: "prod-unit" | "prod-scenario" | "decision" | "question", id: string,
  baseline: "from" | "to" = "from") => ({ kind, id, baseline });
const clone = <T>(value: T): T => structuredClone(value);

const directory: IntakeSourceDirectory = {
  prodUnitIds: ["goal.login", "constraint.current"],
  prodScenarioIds: ["scenario.normal", "scenario.failure"],
  decisionIds: ["decision.analysis-only"],
  questionIds: ["question.expiry"],
  requiredScenarioIds: ["scenario.normal", "scenario.failure"],
};

function binding(revision = 1): IntakeBinding {
  const digit = String(Math.min(revision, 9));
  return {
    repoId: h("a"),
    requirementId: v7(1),
    approvedProdCommit: c(digit),
    approvedRevision: revision,
    approvedProdHash: h(digit),
    approvalManifestHash: h(String.fromCharCode(96 + revision)),
    approvalScopeVersion: approvalScope(digit),
    actionScopeVersion: actionScope("f"),
    workspaceId: h("b"),
    workspaceRef: "refs/heads/req/intake",
    epoch: 3,
    pmRunId: v7(2),
    pmFence: 7,
    contextGeneration: 4,
  };
}

function understanding(bound = binding()): PmUnderstanding {
  return {
    format: "pm-understanding/v1",
    binding: bound,
    goals: [{ text: "增加手机号登录", sourceRefs: [ref("prod-unit", "goal.login")] }],
    nonGoals: [{ text: "本次不做微信登录", sourceRefs: [ref("decision", "decision.analysis-only")] }],
    constraints: [{ text: "保留邮箱登录", sourceRefs: [ref("prod-unit", "constraint.current")] }],
    allowedActions: [{ text: "当前只做影响分析", sourceRefs: [ref("decision", "decision.analysis-only")] }],
    unresolved: [{ text: "短信有效期", impact: "影响验证码验收时间窗口", sourceRefs: [ref("question", "question.expiry")] }],
    scenarioCoverage: [
      { scenarioId: "scenario.normal", status: "covered", summary: "覆盖手机号正常登录", sourceRefs: [ref("prod-scenario", "scenario.normal")] },
      { scenarioId: "scenario.failure", status: "covered", summary: "覆盖验证码失败", sourceRefs: [ref("prod-scenario", "scenario.failure")] },
    ],
  };
}

function review(bound = binding(), result: IntakeReviewRecord["result"] = "passed"): IntakeReviewRecord {
  return {
    format: "pm-intake-review/v1",
    reviewId: v7(3),
    requestId: v7(4),
    binding: bound,
    submissionRef: "session/intake/submission-1",
    submissionHash: h("d"),
    reviewer: { windowId: "window-main", sessionId: "session-main", toolCallId: "tool-call-1" },
    result,
    sourceRefs: [ref("prod-unit", "goal.login"), ref("prod-scenario", "scenario.normal")],
    shortIssues: result === "passed" ? [] : [result === "pm_correction_required" ? "PM误解非目标" : "prod缺少失败场景"],
  };
}

const tasks = [{ taskId: "task.login", version: 2 }, { taskId: "task.qa", version: 1 }];
function link(from: IntakeBinding, to: IntakeBinding, sequence: number, number: number,
  assessment: "unaffected" | "affected" | "unknown" = "unaffected"): IntakeImpactLink {
  return {
    format: "pm-intake-impact-link/v1",
    linkId: v7(10 + number),
    previousLinkId: number === 1 ? null : v7(9 + number),
    rootReview: {
      reviewId: v7(3), requestId: v7(4),
      submissionRef: "session/intake/submission-1", submissionHash: h("d"),
    },
    from,
    to,
    approvedEvent: {
      eventId: v7(20 + number), sequence,
      fromCommit: from.approvedProdCommit, toCommit: to.approvedProdCommit,
      fromRevision: from.approvedRevision, toRevision: to.approvedRevision,
      fromHash: from.approvedProdHash, toHash: to.approvedProdHash,
    },
    taskAssessments: tasks.map((task, index) => ({ ...task,
      assessment: index === 0 ? assessment : "unaffected",
      rationale: index === 0 && assessment !== "unaffected" ? "目标可能影响登录任务" : "该任务依据未变",
      sourceRefs: [impactRef("prod-unit", "goal.login")],
    })),
    globalAssessment: {
      assessment: assessment === "unknown" ? "unknown" : assessment === "affected" ? "affected" : "unaffected",
      rationale: assessment === "unaffected" ? "无全局影响" : "需要继续处理影响",
      sourceRefs: [impactRef("prod-unit", "constraint.current")],
    },
  };
}

function facts(current = binding(), root = review()): IntakeContinuityFacts {
  return {
    format: "pm-intake-continuity-facts/v1",
    currentBinding: current,
    currentState: {
      lifecycle: "active",
      requirementRecordVersion: 9,
      leaseExpiresAt: 2_000,
      observedAt: 1_000,
      actionAuthorizationReportedCurrent: true,
      sourceDirectoryReportedCurrent: true,
      pendingApprovedUpdate: false,
    },
    sourceDirectory: clone(directory),
    historicalSourceDirectories: intakeBindingsEqual(current, root.binding).equal
      ? []
      : [{ binding: clone(root.binding), sourceDirectory: clone(directory) }],
    rootReview: root,
    understandingBaseline: { submissionRef: root.submissionRef, submissionHash: root.submissionHash },
    rootEventSequence: 10,
    impactLinks: [],
    completeTaskSets: [],
  };
}

function chained(assessment: "unaffected" | "affected" | "unknown" = "unaffected"): IntakeContinuityFacts {
  const r1 = binding(1), r2 = binding(2), r3 = binding(3);
  const l1 = link(r1, r2, 11, 1, assessment), l2 = link(r2, r3, 12, 2);
  return {
    ...facts(r3, review(r1)),
    historicalSourceDirectories: [
      { binding: clone(r1), sourceDirectory: clone(directory) },
      { binding: clone(r2), sourceDirectory: clone(directory) },
    ],
    impactLinks: [l1, l2],
    completeTaskSets: [
      { eventId: l1.approvedEvent.eventId, tasks },
      { eventId: l2.approvedEvent.eventId, tasks },
    ],
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(IntakeContractError);
    expect((error as IntakeContractError).code).toBe(code);
    return;
  }
  throw new Error(`预期拒绝：${code}`);
}

test("理解契约覆盖目标、边界、动作、未决影响、必要场景和类型化来源，且不改原文", () => {
  const input = understanding();
  input.goals[0]!.text = " 增加手机号登录 ";
  const result = checkPmUnderstanding(input, directory);
  expect(result).toMatchObject({ status: "accepted", uncoveredScenarioIds: [] });
  expect(result).not.toHaveProperty("executionEnabled");
  expect(result).not.toHaveProperty("scheduling");
  expect(result.understanding).toEqual(input);
  expect(result.understanding).not.toBe(input);
  expect(result.understanding.goals[0]!.text).toBe(" 增加手机号登录 ");
  expect(JSON.stringify(result.understanding)).not.toMatch(/rawInput|transcript|taskPlan/);
});

test("必要场景缺项或明确未覆盖返回uncovered，未知来源则明确拒绝", () => {
  const missing = understanding();
  missing.scenarioCoverage.pop();
  expect(checkPmUnderstanding(missing, directory)).toMatchObject({
    status: "uncovered", uncoveredScenarioIds: ["scenario.failure"],
  });

  const uncovered = understanding();
  uncovered.scenarioCoverage[1]!.status = "uncovered";
  expect(checkPmUnderstanding(uncovered, directory)).toMatchObject({ status: "uncovered", uncoveredScenarioIds: ["scenario.failure"] });

  const unknown = understanding();
  unknown.goals[0]!.sourceRefs = [ref("prod-unit", "goal.unknown")];
  expectCode(() => checkPmUnderstanding(unknown, directory), "unknown_source");

  const wronglyTyped = understanding();
  wronglyTyped.scenarioCoverage[0]!.sourceRefs = [ref("prod-unit", "goal.login")];
  expectCode(() => checkPmUnderstanding(wronglyTyped, directory), "unknown_source");
});

test("理解分组、引用总量和每项文本采用固定边界，不截断", () => {
  const tooMany = understanding();
  tooMany.constraints = Array.from({ length: 33 }, () => ({ text: "约束", sourceRefs: [ref("prod-unit", "constraint.current")] }));
  expectCode(() => checkPmUnderstanding(tooMany, directory), "invalid_shape");

  const tooManyRefs = understanding();
  const largeDirectory: IntakeSourceDirectory = { ...directory, prodUnitIds: Array.from({ length: 5 }, (_, i) => `unit.${i}`) };
  tooManyRefs.goals = Array.from({ length: 32 }, (_, group) => ({ text: `目标${group}`,
    sourceRefs: Array.from({ length: 5 }, (_, i) => ref("prod-unit", `unit.${i}`)) }));
  expectCode(() => checkPmUnderstanding(tooManyRefs, largeDirectory), "resource_limit");

  const textAt = understanding();
  textAt.goals[0]!.text = "😀".repeat(PM_INTAKE_LIMITS.textCodepoints);
  expect(() => checkPmUnderstanding(textAt, directory)).not.toThrow();
  textAt.goals[0]!.text += "界";
  expectCode(() => checkPmUnderstanding(textAt, directory), "resource_limit");
});

test("来源目录和每项引用拒绝重复，要求的场景必须属于当前目录", () => {
  expectCode(() => checkPmUnderstanding(understanding(), { ...directory, decisionIds: ["decision.analysis-only", "decision.analysis-only"] }), "duplicate_source");
  expectCode(() => checkPmUnderstanding(understanding(), { ...directory, requiredScenarioIds: ["scenario.missing"] }), "invalid_source_directory");
  const duplicate = understanding();
  duplicate.goals[0]!.sourceRefs = [ref("prod-unit", "goal.login"), ref("prod-unit", "goal.login")];
  expectCode(() => checkPmUnderstanding(duplicate, directory), "duplicate_source");
});

test("核对记录只有受控元数据形状，passed与短问题保持一致", () => {
  const result = checkIntakeReviewRecord(review(), directory);
  expect(result).toEqual({ status: "accepted", record: expect.anything() });
  expect(result.record).toEqual(review());

  expectCode(() => checkIntakeReviewRecord({ ...review(), shortIssues: ["不能一边passed一边留问题"] }, directory), "invalid_shape");
  expectCode(() => checkIntakeReviewRecord({ ...review(binding(), "pm_correction_required"), shortIssues: [] }, directory), "invalid_shape");
  expectCode(() => checkIntakeReviewRecord({ ...review(binding(), "prod_revision_required"), shortIssues: Array(9).fill("问题") }, directory), "invalid_shape");
});

test.each(["understanding", "body", "rawInput", "diff", "transcript", "details", "actor", "user", "receipt"])(
  "核对记录拒绝详细副本或身份/回执未知字段：%s", (field) => {
    const value = review() as unknown as Record<string, unknown>;
    value[field] = field === "actor" ? "user" : { copied: true };
    expectCode(() => checkIntakeReviewRecord(value, directory), "invalid_shape");
  },
);

test("核对记录的提交引用不是正文容器，未知来源和超长短问题拒绝", () => {
  expectCode(() => checkIntakeReviewRecord({ ...review(), submissionRef: "含 空格的正文" }, directory), "invalid_shape");
  expectCode(() => checkIntakeReviewRecord({ ...review(), sourceRefs: [ref("question", "question.unknown")] }, directory), "unknown_source");
  expectCode(() => checkIntakeReviewRecord({ ...review(binding(), "clarification_required"), shortIssues: ["问".repeat(401)] }, directory), "resource_limit");
});

test("首次无passed记录、理解基线丢失和新物理PM都要求重新核对", () => {
  const first = facts();
  first.rootReview = null;
  first.understandingBaseline = null;
  expect(evaluateIntakeContinuity(first)).toMatchObject({ status: "review_required", reasons: ["review_missing"], contractReady: false, reviewRequired: true });

  const lost = facts();
  lost.understandingBaseline = null;
  expect(evaluateIntakeContinuity(lost)).toMatchObject({ status: "review_required", reasons: expect.arrayContaining(["understanding_baseline_missing"]) });

  for (const [field, reason] of [["pmRunId", "new_pm_run"], ["pmFence", "new_pm_fence"], ["contextGeneration", "context_changed"]] as const) {
    const current = binding();
    if (field === "pmRunId") current[field] = v7(99);
    else current[field]++;
    expect(evaluateIntakeContinuity(facts(current))).toMatchObject({ status: "review_required", reasons: expect.arrayContaining([reason]) });
  }
});

test("准确同一binding与外部当前事实齐备时只得到contractReady", () => {
  const value = facts();
  const result = evaluateIntakeContinuity(value);
  expect(result).toEqual({
    status: "contract_ready", reasons: [], contractReady: true, reviewRequired: false, impact: "not_applicable",
    affectedTasks: [], unknownTasks: [],
  });
  expect(value).toEqual(facts());

  const renewed = facts();
  renewed.currentState.requirementRecordVersion++;
  renewed.currentState.leaseExpiresAt += 5_000;
  expect(evaluateIntakeContinuity(renewed).contractReady).toBe(true);
});

test("binding逐项变化都不能直接沿用旧记录", () => {
  const mutations: Array<[string, (value: IntakeBinding) => void, string]> = [
    ["repoId", (value) => { value.repoId = h("9"); }, "requirement_binding_changed"],
    ["requirementId", (value) => { value.requirementId = v7(90); }, "requirement_binding_changed"],
    ["approvedProdCommit", (value) => { value.approvedProdCommit = c("9"); }, "approved_binding_changed_without_revision"],
    ["approvedProdHash", (value) => { value.approvedProdHash = h("9"); }, "approved_binding_changed_without_revision"],
    ["approvalManifestHash", (value) => { value.approvalManifestHash = h("9"); }, "approved_binding_changed_without_revision"],
    ["approvalScopeVersion", (value) => { value.approvalScopeVersion = approvalScope("9"); }, "approved_binding_changed_without_revision"],
    ["actionScopeVersion", (value) => { value.actionScopeVersion = actionScope("9"); }, "action_scope_changed"],
    ["workspaceId", (value) => { value.workspaceId = h("9"); }, "workspace_changed"],
    ["workspaceRef", (value) => { value.workspaceRef = "refs/heads/other"; }, "workspace_changed"],
    ["epoch", (value) => { value.epoch++; }, "epoch_changed"],
    ["pmRunId", (value) => { value.pmRunId = v7(91); }, "new_pm_run"],
    ["pmFence", (value) => { value.pmFence++; }, "new_pm_fence"],
    ["contextGeneration", (value) => { value.contextGeneration++; }, "context_changed"],
  ];
  for (const [name, mutate, reason] of mutations) {
    const current = binding(); mutate(current);
    const result = evaluateIntakeContinuity(facts(current));
    expect(result.contractReady, name).toBe(false);
    expect(result.reasons, name).toContain(reason);
  }
  const revisionOnly = binding(); revisionOnly.approvedRevision++;
  expect(evaluateIntakeContinuity(facts(revisionOnly))).toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["impact_link_gap"]) });
});

test("对象键重排不影响binding比较，字段变化仍可见", () => {
  const reordered = Object.fromEntries(Object.entries(binding()).reverse());
  expect(intakeBindingsEqual(binding(), reordered)).toEqual({ equal: true });
  expect(intakeBindingsEqual(binding(), { ...binding(), epoch: 4 }).equal).toBe(false);
});

test("R1→R2→R3逐次完整unaffected影响链可保持契约就绪且不改原事实", () => {
  const value = chained();
  const before = clone(value);
  const result = evaluateIntakeContinuity(value);
  expect(value).toEqual(before);
  expect(result).toEqual({
    status: "contract_ready", reasons: [], contractReady: true, reviewRequired: false, impact: "unaffected",
    affectedTasks: [], unknownTasks: [],
  });
});

test("动作范围可沿逐段完整revision链变化，但无链、错scope、旧末端和当前撤权均拒绝", () => {
  const valid = chained();
  valid.impactLinks[0]!.to.actionScopeVersion = actionScope("a");
  valid.impactLinks[1]!.from.actionScopeVersion = actionScope("a");
  valid.impactLinks[1]!.to.actionScopeVersion = actionScope("b");
  valid.currentBinding.actionScopeVersion = actionScope("b");
  valid.historicalSourceDirectories[1]!.binding.actionScopeVersion = actionScope("a");
  expect(evaluateIntakeContinuity(valid)).toMatchObject({ status: "contract_ready", reasons: [], contractReady: true });

  const noChainCurrent = binding();
  noChainCurrent.actionScopeVersion = actionScope("9");
  expect(evaluateIntakeContinuity(facts(noChainCurrent))).toMatchObject({
    status: "review_required", reasons: expect.arrayContaining(["action_scope_changed"]), contractReady: false,
  });

  const wrongAdjacent = clone(valid);
  wrongAdjacent.impactLinks[1]!.from = {
    ...wrongAdjacent.impactLinks[1]!.from,
    actionScopeVersion: actionScope("c"),
  };
  wrongAdjacent.historicalSourceDirectories.push({
    binding: clone(wrongAdjacent.impactLinks[1]!.from), sourceDirectory: clone(directory),
  });
  expect(evaluateIntakeContinuity(wrongAdjacent)).toMatchObject({
    contractReady: false, reasons: expect.arrayContaining(["impact_link_out_of_order"]),
  });

  const oldTerminal = clone(valid);
  oldTerminal.currentBinding = { ...oldTerminal.currentBinding, actionScopeVersion: actionScope("f") };
  expect(evaluateIntakeContinuity(oldTerminal)).toMatchObject({
    contractReady: false, reasons: expect.arrayContaining(["impact_link_terminal_not_current"]),
  });

  for (const field of ["actionAuthorizationReportedCurrent", "pendingApprovedUpdate"] as const) {
    const blocked = clone(valid);
    blocked.currentState[field] = field === "pendingApprovedUpdate";
    expect(evaluateIntakeContinuity(blocked).contractReady, field).toBe(false);
  }
});

test("历史root和早期link引用按完整binding目录核验，删除当前ID不改写旧记录", () => {
  const rootOnly = chained();
  rootOnly.sourceDirectory.prodScenarioIds = ["scenario.failure"];
  rootOnly.sourceDirectory.requiredScenarioIds = ["scenario.failure"];
  expect(evaluateIntakeContinuity(rootOnly)).toMatchObject({ status: "contract_ready", contractReady: true });

  const earlyLinkOnly = chained();
  earlyLinkOnly.historicalSourceDirectories[0]!.sourceDirectory.prodUnitIds.push("constraint.r1-only");
  earlyLinkOnly.impactLinks[0]!.taskAssessments[0]!.sourceRefs = [impactRef("prod-unit", "constraint.r1-only", "from")];
  earlyLinkOnly.impactLinks[0]!.globalAssessment.sourceRefs = [impactRef("prod-unit", "constraint.r1-only", "from")];
  expect(earlyLinkOnly.sourceDirectory.prodUnitIds).not.toContain("constraint.r1-only");
  expect(evaluateIntakeContinuity(earlyLinkOnly)).toMatchObject({ status: "contract_ready", contractReady: true });

  const missingHistory = chained();
  missingHistory.historicalSourceDirectories.shift();
  expectCode(() => evaluateIntakeContinuity(missingHistory), "invalid_source_directory");

  const wrongBaseline = clone(earlyLinkOnly);
  wrongBaseline.impactLinks[0]!.taskAssessments[0]!.sourceRefs[0]!.baseline = "to";
  wrongBaseline.impactLinks[0]!.globalAssessment.sourceRefs[0]!.baseline = "to";
  expectCode(() => evaluateIntakeContinuity(wrongBaseline), "unknown_source");

  const unknownCurrent = chained();
  unknownCurrent.impactLinks[1]!.globalAssessment.sourceRefs = [impactRef("prod-unit", "unit.current-unknown", "to")];
  expectCode(() => evaluateIntakeContinuity(unknownCurrent), "unknown_source");
});

test("历史来源目录拒绝错绑、当前串用、重复冲突、无关binding和固定预算超限", () => {
  const wrongBinding = chained();
  wrongBinding.historicalSourceDirectories[0]!.binding.requirementId = v7(90);
  expectCode(() => evaluateIntakeContinuity(wrongBinding), "invalid_source_directory");

  const currentReuse = chained();
  currentReuse.historicalSourceDirectories.push({ binding: clone(currentReuse.currentBinding), sourceDirectory: clone(directory) });
  expectCode(() => evaluateIntakeContinuity(currentReuse), "invalid_source_directory");

  const duplicate = chained();
  duplicate.historicalSourceDirectories.push(clone(duplicate.historicalSourceDirectories[0]!));
  expectCode(() => evaluateIntakeContinuity(duplicate), "duplicate_source");

  const conflict = chained();
  const conflictingDirectory = clone(conflict.historicalSourceDirectories[0]!);
  conflictingDirectory.sourceDirectory.prodUnitIds.push("unit.conflict");
  conflict.historicalSourceDirectories.push(conflictingDirectory);
  expectCode(() => evaluateIntakeContinuity(conflict), "duplicate_source");

  const unrelated = chained();
  unrelated.historicalSourceDirectories.push({ binding: binding(4), sourceDirectory: clone(directory) });
  expectCode(() => evaluateIntakeContinuity(unrelated), "invalid_source_directory");

  const tooMany = chained() as unknown as Record<string, unknown>;
  tooMany.historicalSourceDirectories = Array.from({ length: PM_INTAKE_LIMITS.historicalSourceDirectories + 1 }, () => ({
    binding: binding(1), sourceDirectory: clone(directory),
  }));
  expectCode(() => evaluateIntakeContinuity(tooMany), "invalid_shape");

  const tooLarge = chained();
  for (const historical of tooLarge.historicalSourceDirectories) {
    historical.sourceDirectory.decisionIds = Array.from({ length: 128 }, (_, index) => `decision.${index}.${"x".repeat(220)}`);
  }
  expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBeGreaterThan(PM_INTAKE_LIMITS.jsonBytes);
  expectCode(() => evaluateIntakeContinuity(tooLarge), "resource_limit");
});

test("影响引用必须显式标from或to，普通理解和新核对记录仍使用当前来源引用", () => {
  const missingBaseline = chained() as unknown as { impactLinks: Array<{ globalAssessment: { sourceRefs: unknown[] } }> };
  missingBaseline.impactLinks[0]!.globalAssessment.sourceRefs = [ref("prod-unit", "constraint.current")];
  expectCode(() => evaluateIntakeContinuity(missingBaseline), "invalid_shape");
  expect(checkPmUnderstanding(understanding(), directory).status).toBe("accepted");
  expect(checkIntakeReviewRecord(review(), directory).status).toBe("accepted");
});

test("每段影响链绑定同一root review身份，换任一身份或首中段拼接都拒绝", () => {
  for (const field of ["reviewId", "requestId", "submissionRef", "submissionHash"] as const) {
    const value = chained();
    if (field === "reviewId") value.rootReview![field] = v7(80);
    else if (field === "requestId") value.rootReview![field] = v7(81);
    else if (field === "submissionRef") value.rootReview![field] = "session/intake/replacement";
    else value.rootReview![field] = h("e");
    value.understandingBaseline = {
      submissionRef: value.rootReview!.submissionRef,
      submissionHash: value.rootReview!.submissionHash,
    };
    expect(evaluateIntakeContinuity(value), field).toMatchObject({
      contractReady: false, reasons: expect.arrayContaining(["impact_link_root_mismatch"]),
    });
  }

  for (const index of [0, 1]) {
    const value = chained();
    value.impactLinks[index]!.rootReview.reviewId = v7(90 + index);
    expect(evaluateIntakeContinuity(value), `link-${index}`).toMatchObject({
      contractReady: false, reasons: expect.arrayContaining(["impact_link_root_mismatch"]),
    });
  }
});

test("连续事实嵌套对象键顺序不影响完整链判断", () => {
  const value = chained();
  for (const linkValue of value.impactLinks) {
    linkValue.rootReview = Object.fromEntries(Object.entries(linkValue.rootReview).reverse()) as typeof linkValue.rootReview;
  }
  value.historicalSourceDirectories = value.historicalSourceDirectories.map((entry) =>
    Object.fromEntries(Object.entries(entry).reverse()) as typeof entry);
  expect(evaluateIntakeContinuity(value)).toMatchObject({ status: "contract_ready", reasons: [], contractReady: true });
});

test("缺R2、乱序、重复冲突和末端非当前均阻塞", () => {
  const gap = chained();
  gap.impactLinks = [link(binding(1), binding(3), 11, 1)];
  gap.historicalSourceDirectories = gap.historicalSourceDirectories.filter((entry) => entry.binding.approvedRevision === 1);
  gap.completeTaskSets = [{ eventId: gap.impactLinks[0]!.approvedEvent.eventId, tasks }];
  expect(evaluateIntakeContinuity(gap).reasons).toContain("impact_link_gap");

  const outOfOrder = chained();
  outOfOrder.impactLinks.reverse();
  expect(evaluateIntakeContinuity(outOfOrder).reasons).toContain("impact_link_out_of_order");

  const duplicate = chained();
  duplicate.impactLinks[1]!.linkId = duplicate.impactLinks[0]!.linkId;
  expect(evaluateIntakeContinuity(duplicate).reasons).toContain("impact_link_duplicate");

  const terminal = chained();
  terminal.currentBinding = binding(4);
  expect(evaluateIntakeContinuity(terminal).reasons).toContain("impact_link_terminal_not_current");
});

test("影响链event必须准确绑定sequence/commit/revision/hash且不能跨PM/context", () => {
  for (const mutate of [
    (item: IntakeImpactLink) => { item.approvedEvent.sequence++; },
    (item: IntakeImpactLink) => { item.approvedEvent.toCommit = c("f"); },
    (item: IntakeImpactLink) => { item.approvedEvent.toRevision++; },
    (item: IntakeImpactLink) => { item.approvedEvent.toHash = h("f"); },
  ]) {
    const value = chained(); mutate(value.impactLinks[0]!);
    expect(evaluateIntakeContinuity(value).contractReady).toBe(false);
  }
  const changedContext = chained();
  changedContext.impactLinks[0]!.to.contextGeneration++;
  changedContext.historicalSourceDirectories[1]!.binding.contextGeneration++;
  expect(evaluateIntakeContinuity(changedContext).reasons).toContain("context_changed");
});

test("每段必须覆盖外部给出的完整task ID/version集合：漏任务、陌生任务和版本漂移拒绝", () => {
  const missing = chained();
  missing.impactLinks[0]!.taskAssessments.pop();
  expect(evaluateIntakeContinuity(missing).reasons).toContain("impact_link_missing_task");

  const unknown = chained();
  unknown.impactLinks[0]!.taskAssessments.push({ taskId: "task.unknown", version: 1, assessment: "unaffected", rationale: "未知任务", sourceRefs: [impactRef("prod-unit", "goal.login")] });
  expect(evaluateIntakeContinuity(unknown).reasons).toContain("impact_link_unknown_task");

  const version = chained();
  version.impactLinks[0]!.taskAssessments[0]!.version++;
  expect(evaluateIntakeContinuity(version).reasons).toContain("impact_link_unknown_task");
});

test("影响链引用总量受128限制", () => {
  const value = chained();
  const manyRefs = Array.from({ length: 32 }, (_, index) => impactRef("prod-unit", `unit.${index}`));
  value.sourceDirectory.prodUnitIds = ["goal.login", "constraint.current", ...manyRefs.map((item) => item.id)];
  for (const historical of value.historicalSourceDirectories) {
    historical.sourceDirectory.prodUnitIds = clone(value.sourceDirectory.prodUnitIds);
  }
  for (const link of value.impactLinks) {
    link.globalAssessment.sourceRefs = manyRefs;
    for (const item of link.taskAssessments) item.sourceRefs = manyRefs;
  }
  expectCode(() => evaluateIntakeContinuity(value), "resource_limit");
});

test("affected要求更新/验证，unknown继续阻塞，不误报交付完成", () => {
  const affected = evaluateIntakeContinuity(chained("affected"));
  expect(affected).toMatchObject({ status: "impact_action_required", contractReady: false, impact: "affected",
    affectedTasks: [{ taskId: "task.login", version: 2 }] });

  const unknown = evaluateIntakeContinuity(chained("unknown"));
  expect(unknown).toMatchObject({ status: "impact_action_required", contractReady: false, impact: "unknown",
    unknownTasks: [{ taskId: "task.login", version: 2 }] });
});

test("新批准更新、非活动、租约过期及外部当前性声明缺失都默认阻塞", () => {
  const mutations: Array<[keyof IntakeContinuityFacts["currentState"], unknown, string]> = [
    ["pendingApprovedUpdate", true, "pending_approved_update"],
    ["lifecycle", "closing", "requirement_not_active"],
    ["leaseExpiresAt", 1_000, "lease_not_current"],
    ["actionAuthorizationReportedCurrent", false, "action_authorization_not_reported_current"],
    ["sourceDirectoryReportedCurrent", false, "source_directory_not_reported_current"],
  ];
  for (const [field, next, reason] of mutations) {
    const value = facts();
    (value.currentState as Record<string, unknown>)[field] = next;
    expect(evaluateIntakeContinuity(value)).toMatchObject({ status: "blocked", contractReady: false, reasons: expect.arrayContaining([reason]) });
  }
});

test("PM理解错误与prod缺漏/重要歧义给出不同复核原因", () => {
  const pmWrong = facts(binding(), review(binding(), "pm_correction_required"));
  pmWrong.understandingBaseline = { submissionRef: pmWrong.rootReview!.submissionRef, submissionHash: pmWrong.rootReview!.submissionHash };
  expect(evaluateIntakeContinuity(pmWrong).reasons).toContain("pm_correction_required");
  expect(evaluateIntakeContinuity(pmWrong).reasons).not.toContain("prod_revision_required");

  const prodMissing = facts(binding(), review(binding(), "prod_revision_required"));
  prodMissing.understandingBaseline = { submissionRef: prodMissing.rootReview!.submissionRef, submissionHash: prodMissing.rootReview!.submissionHash };
  expect(evaluateIntakeContinuity(prodMissing).reasons).toContain("prod_revision_required");
  expect(evaluateIntakeContinuity(prodMissing).reasons).not.toContain("pm_correction_required");

  const clarification = facts(binding(), review(binding(), "clarification_required"));
  clarification.understandingBaseline = { submissionRef: clarification.rootReview!.submissionRef, submissionHash: clarification.rootReview!.submissionHash };
  expect(evaluateIntakeContinuity(clarification).reasons).toContain("clarification_required");
});

function exactBudgetUnderstanding(): { value: PmUnderstanding; directory: IntakeSourceDirectory } {
  const sourceDirectory: IntakeSourceDirectory = {
    prodUnitIds: ["unit.one"], prodScenarioIds: ["scenario.one"], decisionIds: [], questionIds: [], requiredScenarioIds: ["scenario.one"],
  };
  const item = () => ({ text: "x", sourceRefs: [ref("prod-unit", "unit.one")] });
  const value: PmUnderstanding = {
    format: "pm-understanding/v1", binding: binding(),
    goals: Array.from({ length: 32 }, item),
    nonGoals: Array.from({ length: 32 }, item),
    constraints: Array.from({ length: 32 }, item),
    allowedActions: Array.from({ length: 31 }, item),
    unresolved: [],
    scenarioCoverage: [{ scenarioId: "scenario.one", status: "covered", summary: "x", sourceRefs: [ref("prod-scenario", "scenario.one")] }],
  };
  const slots = [
    ...value.goals.map((entry) => () => entry), ...value.nonGoals.map((entry) => () => entry),
    ...value.constraints.map((entry) => () => entry), ...value.allowedActions.map((entry) => () => entry),
    ...value.scenarioCoverage.map((entry) => () => entry),
  ];
  let remaining = PM_INTAKE_LIMITS.jsonBytes - Buffer.byteLength(JSON.stringify(value));
  for (const get of slots) {
    if (remaining <= 0) break;
    const target = get();
    const addition = Math.min(PM_INTAKE_LIMITS.textCodepoints - target.text.length, remaining);
    target.text += "x".repeat(addition);
    remaining -= addition;
  }
  if (remaining !== 0) throw new Error("无法构造精确JSON预算");
  return { value, directory: sourceDirectory };
}

test("Unicode码点与完整JSON UTF-8/转义预算按32768边界执行", () => {
  const exact = exactBudgetUnderstanding();
  expect(Buffer.byteLength(JSON.stringify(exact.value))).toBe(PM_INTAKE_LIMITS.jsonBytes);
  expect(checkPmUnderstanding(exact.value, exact.directory).status).toBe("accepted");
  exact.value.goals[0]!.text += "x";
  expect(Buffer.byteLength(JSON.stringify(exact.value))).toBe(PM_INTAKE_LIMITS.jsonBytes + 1);
  expectCode(() => checkPmUnderstanding(exact.value, exact.directory), "resource_limit");

  const escaped = exactBudgetUnderstanding();
  for (const item of escaped.value.goals) item.text = "\u0001".repeat(400);
  expect(Array.from(escaped.value.goals[0]!.text)).toHaveLength(400);
  expect(Buffer.byteLength(JSON.stringify(escaped.value))).toBeGreaterThan(PM_INTAKE_LIMITS.jsonBytes);
  expectCode(() => checkPmUnderstanding(escaped.value, escaped.directory), "resource_limit");
});

test("严格schema拒绝Binding格式、连续事实详细副本和未知字段", () => {
  for (const mutation of [
    (value: IntakeBinding) => { value.requirementId = "not-uuid"; },
    (value: IntakeBinding) => { value.approvedProdCommit = "abc"; },
    (value: IntakeBinding) => { value.approvalScopeVersion = h("a"); },
    (value: IntakeBinding) => { value.actionScopeVersion = h("a"); },
  ]) {
    const value = understanding(); mutation(value.binding);
    expectCode(() => checkPmUnderstanding(value, directory), "invalid_shape");
  }
  for (const field of ["understanding", "body", "rawInput", "diff", "transcript", "authorizationReceipt"]) {
    const value = facts() as unknown as Record<string, unknown>;
    value[field] = "forbidden";
    expectCode(() => evaluateIntakeContinuity(value), "invalid_shape");
  }
});
