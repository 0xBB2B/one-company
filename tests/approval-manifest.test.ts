import { expect, test } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { partitionPrdDocument } from "../src/modules/requirement/prd-view.ts";
import { checkContext } from "../src/modules/requirement/user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation } from "../src/modules/requirement/user-interaction-format.ts";
import { createApprovalManifest, checkApprovalManifest, approvalManifestDigest, approvalManifestReference, validateDocumentReview,
  manifestAuthorizesImplement, implementGoalUnitIds, supplementImplementAction, checkImplementSupplement } from "../src/modules/requirement/approval-manifest.ts";
import type { ApprovalManifest } from "../src/modules/requirement/approval-manifest.ts";
import type { RequirementDocSection } from "../src/modules/requirement/requirement-doc.ts";
import { implementScope } from "../src/modules/pm/plan-manage.ts";
import { summarizeApprovalManifest } from "../src/modules/requirement/approval-manifest-store.ts";

function fixture() {
  const requirementId = uuidv7(), title = "渐进登录", body = "前言：保留邮箱。\r\n# 手机号 {#A}\r\n实现手机号登录。😀\r\n# 微信 {#B}\r\n微信需求未决，不实施。\r\n";
  const partition = partitionPrdDocument(requirementId, title, body);
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null,
    to: { commit: "b".repeat(40), hash: partition.prdHash } };
  const context: InteractionContext = { basis: { requirementId, version: 1, epoch: 1, prd: null }, currentGoal: "",
    candidates: [{ ...candidate, diff: "+手机号与明确未决微信" }], questions: [], priorDecisions: [], document: { candidate, title, body, partition } };
  const common = { basis: "explicit" as const, resolution: "direct" as const, candidateId: candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "仅手机号" };
  const result: InteractionInterpretation = { format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
    { ...common, kind: "target", conclusion: "实现手机号" },
    { ...common, kind: "constraint", conclusion: "保留邮箱" },
    { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "微信未决" },
    { ...common, kind: "action", actions: ["implement"], conclusion: "实施手机号" },
  ], documentReview: { faithful: true,
    units: partition.units.map((u) => ({ id: u.id, disposition: u.id === "B" ? "pending-description" : "confirmed",
      globalConstraint: false, appliesTo: [], dependsOn: u.id === "A" ? ["preamble"] : [], conclusionIndexes: [u.id === "B" ? 2 : u.id === "preamble" ? 1 : 0] })),
    actions: [{ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], conclusionIndexes: [3], unknown: false }], questions: [] } };
  const saved = result.entries.map(() => uuidv7());
  const expected = { requirementId, candidate, partition };
  return { context, result, saved, expected, manifest: () => createApprovalManifest(context, result, saved) };
}
test("完整文档含明确未决B，清单无正文/任意载荷，只有A依赖闭包可实施", () => {
  const f = fixture(), m = f.manifest();
  expect(checkApprovalManifest(m, f.expected)).toEqual(m);
  expect(approvalManifestDigest(m)).toBe(m.manifestHash);
  expect(approvalManifestReference(m)).toEqual({ requirementId: f.expected.requirementId, candidate: f.expected.candidate, manifestHash: m.manifestHash });
  expect(JSON.stringify(m)).not.toMatch(/前言|手机号|微信|body|conclusion|scope/);
  expect(m.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], unknown: false })]);
  expect(summarizeApprovalManifest(m)).toMatchObject({ confirmed: ["metadata", "preamble", "A"], pending: ["B"], blocked: [] });
});
for (const attack of ["metadata", "preamble", "unit", "overlap", "hash", "dependency", "cycle", "decision-index", "duplicate", "false-confirmed", "modify", "actor", "duplicate-action"] as const) {
  test(`审核拒绝${attack}省略或伪造`, () => {
    const f = fixture(), review = f.result.documentReview!;
    if (attack === "metadata") review.units.shift();
    if (attack === "preamble") review.units.splice(1, 1);
    if (attack === "unit") review.units.pop();
    if (attack === "overlap") f.context.document!.partition.units[1]!.startByte--;
    if (attack === "hash") f.context.document!.partition.units[1]!.hash = "f".repeat(64);
    if (attack === "dependency") review.units[2]!.dependsOn = ["missing"];
    if (attack === "cycle") review.units[1]!.dependsOn = ["A"];
    if (attack === "decision-index") review.units[0]!.conclusionIndexes = [19];
    if (attack === "duplicate") review.units[3]!.id = "A";
    if (attack === "false-confirmed") review.units[3]!.disposition = "confirmed";
    if (attack === "modify") f.result.entries[0]!.resolution = "modify";
    if (attack === "actor") Object.assign(review.units[0]!, { actor: "user" });
    if (attack === "duplicate-action") review.actions.push(structuredClone(review.actions[0]!));
    expect(() => { checkContext(f.context); return f.manifest(); }).toThrow();
  });
}
test("全局未决作用于A则A受阻，独立目标不被改成全量受阻", () => {
  const f = fixture(), r = f.result.documentReview!;
  r.units[3]!.globalConstraint = true; r.units[3]!.appliesTo = ["A"];
  r.actions[0]!.constraintIds.push("B");
  const m = f.manifest();
  expect(m.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ["A"], constraintIds: ["preamble", "B"], unknown: false })]);
  expect(summarizeApprovalManifest(m).blocked).toEqual(["A"]);
  r.units[3]!.appliesTo = ["metadata"];
  r.actions[0]!.constraintIds = ["preamble"];
  const independent = f.manifest();
  expect(independent.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], unknown: false })]);
  expect(summarizeApprovalManifest(independent).blocked).toEqual(["metadata"]);
  r.units[3]!.appliesTo = [];
  expect(() => f.manifest()).toThrow(/incomplete_action_closure/);
});
test("未知影响阻止动作，未确认建议不能标确定正文，未映射相关条目不能被丢弃", () => {
  const f = fixture(); f.result.documentReview!.actions[0]!.unknown = true;
  expect(summarizeApprovalManifest(f.manifest()).blocked).toEqual(["A"]);
  f.result.documentReview!.faithful = false;
  expect(() => f.manifest()).toThrow(/document_not_approved/);
  f.result.documentReview!.faithful = true;
  f.result.entries.push({ ...f.result.entries[2]!, conclusion: "新增未映射限制" }); f.saved.push(uuidv7());
  expect(() => f.manifest()).toThrow(/unmapped_review_entry/);
});
test("manifest严格未知字段、hash、引用及64KiB拒绝；hash不含自身且键顺序无关", () => {
  const f = fixture(), m = f.manifest();
  for (const changed of [{ ...m, manifestHash: "f".repeat(64) }, { ...m, prdBody: "payload" },
    { ...m, units: m.units.map((u, i) => i ? u : { ...u, decisionIds: ["USER-001"] }) },
    { ...m, units: m.units.map((u, i) => i ? u : { ...u, decisionIds: [u.decisionIds[0] + "\n"] }) }]) expect(() => checkApprovalManifest(changed, f.expected)).toThrow();
  expect(approvalManifestDigest(JSON.parse(JSON.stringify(m, null, 2)))).toBe(m.manifestHash);
  const changed = { ...m, units: m.units.map((u) => ({ ...u, decisionIds: Array.from({ length: 17 }, () => uuidv7()) })) };
  expect(() => checkApprovalManifest(changed, f.expected)).toThrow();
  expect(() => checkApprovalManifest({ ...m, attachment: "x".repeat(65_536) }, f.expected)).toThrow(/request_limit/);
});
test("同hash多candidate不能作为整份文档的伪分区；绑定完整提交及UUID", () => {
  const f = fixture(); f.context.candidates.push({ ...f.context.candidates[0]!, candidateId: uuidv7() });
  expect(() => checkContext(f.context)).toThrow(/duplicate_document_candidate/);
  const m = f.manifest();
  expect(() => checkApprovalManifest(m, { ...f.expected, requirementId: uuidv7() })).toThrow();
  expect(() => checkApprovalManifest(m, { ...f.expected, candidate: { ...f.expected.candidate, to: { ...f.expected.candidate.to, commit: "c".repeat(40) } } })).toThrow();
});
for (const attack of ["unit-full-indexes", "action-full-indexes", "reuse-full-indexes", "omit-unit-index", "omit-action-index", "metadata-goal"] as const) {
  test(`反向请求边界${attack}不依赖模型faithful判断`, () => {
    const f = fixture(), requestId = uuidv7(), r = f.result.documentReview!;
    f.result.referenceResolution = "explicit";
    f.context.questions.push({ format: "interaction-question/v1", requestId, repoId: "d".repeat(64), basis: f.context.basis,
      candidate: f.expected.candidate, actions: ["implement"], createdAt: 0, unitIds: ["A"],
      proposal: { conclusion: "仅A实施", scope: "不含B", references: [], supersedes: [] } });
    f.result.entries.push({ ...f.result.entries[1]!, conclusion: "文档元数据" }); f.saved.push(uuidv7()); r.units[0]!.conclusionIndexes = [4];
    for (const i of [0, 3]) Object.assign(f.result.entries[i]!, { requestId, resolution: "accept" });
    r.questions = [{ requestId, answeredIds: ["A"], pendingIds: [], conclusionIndexes: [0, 3] }];
    if (attack === "metadata-goal") r.actions[0]!.goalIds = ["metadata"];
    else {
      f.result.entries[2] = { ...f.result.entries[0]!, conclusion: "确认B" }; r.units[3]!.disposition = "confirmed";
      r.questions[0]!.conclusionIndexes.push(2);
      if (attack === "action-full-indexes") {
        f.result.entries[2]!.requestId = null; f.result.entries[2]!.resolution = "direct";
        r.questions[0]!.conclusionIndexes = [0, 3]; r.actions[0]!.goalIds = ["B"]; r.actions[0]!.constraintIds = [];
      }
      if (attack === "reuse-full-indexes") {
        r.units[3]!.conclusionIndexes = [0];
        Object.assign(f.result.entries[2]!, { kind: "future", basis: "proposed", resolution: "defer", candidateId: null, requestId: null });
        r.questions[0]!.conclusionIndexes = [0, 3];
      }
      if (attack === "omit-unit-index") r.questions[0]!.conclusionIndexes = [0, 3];
      if (attack === "omit-action-index") r.questions[0]!.conclusionIndexes = [0, 2];
    }
    expect(() => validateDocumentReview(f.context, f.result)).toThrow(/question_unit_escape|question_action_escape|question_entry_coverage|invalid_action_scope/);
    r.faithful = false;
    expect(() => validateDocumentReview(f.context, f.result)).toThrow(/question_unit_escape|question_action_escape|question_entry_coverage|invalid_action_scope/);
  });
}
test("持久化清单即便重算hash也不能把metadata作为动作目标", () => {
  const f = fixture(), m = f.manifest();
  m.actions[0]!.goalIds = ["metadata"]; m.actions[0]!.constraintIds = []; m.manifestHash = approvalManifestDigest(m);
  expect(() => checkApprovalManifest(m, f.expected)).toThrow(/invalid_action_scope/);
});

test("问题审核按实际unitIds覆盖已答与未答；部分答复不关闭整题", () => {
  const f = fixture(), requestId = uuidv7();
  f.context.questions.push({ format: "interaction-question/v1", requestId, repoId: "d".repeat(64), basis: f.context.basis,
    candidate: f.expected.candidate, actions: ["implement"], createdAt: 0, unitIds: ["A", "B"],
    proposal: { conclusion: "确认A和B", scope: "当前文档", references: [], supersedes: [] } });
  f.result.referenceResolution = "explicit";
  f.result.entries.push({ ...f.result.entries[1]!, conclusion: "文档身份元数据" }); f.saved.push(uuidv7());
  f.result.documentReview!.units[0]!.conclusionIndexes = [4];
  f.result.entries[0]!.requestId = requestId;
  f.result.documentReview!.questions = [{ requestId, answeredIds: ["A"], pendingIds: ["B"], conclusionIndexes: [0] }];
  expect(f.manifest().questions[0]).toMatchObject({ answeredIds: ["A"], pendingIds: ["B"], decisionIds: [f.saved[0]] });
  f.result.documentReview!.questions[0]!.pendingIds = [];
  expect(() => validateDocumentReview(f.context, f.result)).toThrow(/question_scope_mismatch/);
});

test("段数不设单独上限：25 段的需求，一个动作与一个提问各覆盖全部 25 段，仍能生成并核验清单", () => {
  const requirementId = uuidv7(), title = "多段需求", ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const body = ids.map((id) => `## 段 ${id} {#${id}}\n内容 ${id}。\n`).join("");
  const partition = partitionPrdDocument(requirementId, title, body);
  expect(partition.units).toHaveLength(26);
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null,
    to: { commit: "b".repeat(40), hash: partition.prdHash } };
  const requestId = uuidv7();
  const context: InteractionContext = { basis: { requirementId, version: 1, epoch: 1, prd: null }, currentGoal: "",
    candidates: [{ ...candidate, diff: "+多段" }], priorDecisions: [], document: { candidate, title, body, partition },
    questions: [{ format: "interaction-question/v1", requestId, repoId: "d".repeat(64), basis: { requirementId, version: 1, epoch: 1, prd: null },
      candidate, actions: ["implement"], createdAt: 0, unitIds: ids, proposal: { conclusion: "确认全部段落", scope: "当前文档", references: [], supersedes: [] } }] };
  const common = { basis: "explicit" as const, resolution: "direct" as const, candidateId: candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "全部段落" };
  const result: InteractionInterpretation = { format: "interaction-interpretation/v1", referenceResolution: "explicit", entries: [
    { ...common, kind: "target", requestId, conclusion: "实现全部段落" },
    { ...common, kind: "action", actions: ["implement"], conclusion: "实施全部段落" },
    { ...common, kind: "constraint", conclusion: "文档身份元数据" },
  ], documentReview: { faithful: true,
    units: partition.units.map((u) => ({ id: u.id, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [u.id === "metadata" ? 2 : 0] })),
    actions: [{ action: "implement", goalIds: ids, constraintIds: [], conclusionIndexes: [1], unknown: false }],
    questions: [{ requestId, answeredIds: ids, pendingIds: [], conclusionIndexes: [0] }] } };
  checkContext(context);
  const m = createApprovalManifest(context, result, [uuidv7(), uuidv7(), uuidv7()]);
  expect(checkApprovalManifest(m, { requirementId, candidate, partition })).toEqual(m);
  expect(m.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ids, constraintIds: [], unknown: false })]);
  expect(summarizeApprovalManifest(m).blocked).toEqual([]);
});

const goalSections: RequirementDocSection[] = [{ id: "A", title: "手机号", goal: true }];
function unapproved() {
  const f = fixture();
  f.result.entries.pop(); f.saved.pop(); f.result.documentReview!.actions = [];
  return f;
}
function supplemented(f = unapproved(), sections = goalSections) {
  const base = f.manifest(), decisionId = uuidv7();
  const next = supplementImplementAction({ manifest: base, goalIds: implementGoalUnitIds(base, sections), decisionId });
  return { f, base, decisionId, next };
}
function rehash(m: ApprovalManifest): ApprovalManifest { m.manifestHash = approvalManifestDigest(m); return m; }

test("补授权清单与旧清单相比只多一个implement动作，其余深度相等，摘要只有reference不同", () => {
  const f = unapproved(), base = f.manifest(), decisionId = uuidv7(), before = structuredClone(base);
  const next = supplementImplementAction({ manifest: base, goalIds: implementGoalUnitIds(base, goalSections), decisionId });
  expect(base).toEqual(before);
  expect(manifestAuthorizesImplement(base)).toBe(false);
  expect(manifestAuthorizesImplement(next)).toBe(true);
  expect(next.units).toEqual(base.units);
  expect(next.questions).toEqual(base.questions);
  expect(next.retainedSources).toEqual(base.retainedSources);
  expect(next.actions).toEqual([...base.actions,
    expect.objectContaining({ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], unknown: false, decisionIds: [decisionId] })]);
  expect(next.actions).toHaveLength(base.actions.length + 1);
  expect(checkApprovalManifest(next, f.expected)).toEqual(next);
  expect(next.manifestHash).not.toBe(base.manifestHash);
  expect(() => checkImplementSupplement({ base, next, decisionId })).not.toThrow();
  const { reference: baseRef, ...baseSummary } = summarizeApprovalManifest(base);
  const { reference: nextRef, ...nextSummary } = summarizeApprovalManifest(next);
  expect(nextSummary).toEqual(baseSummary);
  expect(nextRef).toEqual(approvalManifestReference(next));
  expect(nextRef).not.toEqual(baseRef);
});

test("约束段落是目标依赖闭包减去目标本身，包含作用于目标的全局条件", () => {
  const f = unapproved(), r = f.result.documentReview!;
  r.units[3]!.globalConstraint = true; r.units[3]!.appliesTo = ["A"];
  const { next } = supplemented(f);
  const action = next.actions.find((a) => a.action === "implement")!;
  expect(action.goalIds).toEqual(["A"]);
  expect([...action.constraintIds].sort()).toEqual(["B", "preamble"]);
  expect(summarizeApprovalManifest(next).blocked).toEqual(["A"]);
});

test("实施目标段落只取实施目标板块下的已确认段落；待定、排除、其他板块的段不算，无已确认段落时为空", () => {
  const unit = (id: string, disposition = "confirmed") => ({ id, disposition });
  const stub = { units: [unit("metadata"), unit("requirements"), unit("features"), unit("features.hold"), unit("features.release", "pending-description"),
    unit("features.old", "excluded"), unit("acceptance")], actions: [] } as never;
  const sections: RequirementDocSection[] = [{ id: "requirements", title: "需求" }, { id: "features", title: "功能", goal: true }, { id: "acceptance", title: "验收", record: "acceptance" }];
  expect([...implementGoalUnitIds(stub, sections)].sort()).toEqual(["features", "features.hold"]);
  expect([...implementGoalUnitIds(stub, [{ id: "features.release", title: "待定", goal: true }])]).toEqual([]);
});

test("旧清单已有有效implement或没有目标段落时拒绝补授权；unknown的implement不算授权", () => {
  const { base, decisionId, next } = supplemented();
  expect(() => supplementImplementAction({ manifest: next, goalIds: ["A"], decisionId: uuidv7() })).toThrow();
  expect(() => supplementImplementAction({ manifest: base, goalIds: [], decisionId })).toThrow();
  const f = fixture(), approved = f.manifest();
  expect(manifestAuthorizesImplement(approved)).toBe(true);
  expect(() => supplementImplementAction({ manifest: approved, goalIds: ["A"], decisionId })).toThrow();
  const unknown = unapproved(); unknown.result.documentReview!.actions = [];
  const m = unknown.manifest(); m.actions = [{ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], unknown: true, decisionIds: [uuidv7()] }];
  expect(manifestAuthorizesImplement(rehash(m))).toBe(false);
});

for (const tamper of ["disposition", "push", "extra-decision", "other-decision", "decision-in-unit", "not-implement", "question"] as const) {
  test(`结构核对拒绝补授权清单被篡改：${tamper}`, () => {
    const { base, decisionId, next } = supplemented();
    const m = structuredClone(next), implement = m.actions[m.actions.length - 1]!;
    if (tamper === "disposition") m.units.find((u) => u.id === "B")!.disposition = "confirmed";
    if (tamper === "push") m.actions.push({ action: "push", goalIds: ["A"], constraintIds: ["preamble"], unknown: false, decisionIds: [decisionId] });
    if (tamper === "extra-decision") implement.decisionIds = [decisionId, uuidv7()];
    if (tamper === "other-decision") implement.decisionIds = [uuidv7()];
    if (tamper === "decision-in-unit") m.units[2]!.decisionIds.push(decisionId);
    if (tamper === "not-implement") implement.action = "commit";
    if (tamper === "question") m.questions.push({ requestId: uuidv7(), answeredIds: [], pendingIds: ["B"], decisionIds: [] });
    rehash(m);
    expect(() => checkImplementSupplement({ base, next: m, decisionId })).toThrow();
  });
}

test("结构核对拒绝传入的决定编号与清单里的不一致，也拒绝没有多出implement的清单", () => {
  const { base, next } = supplemented();
  expect(() => checkImplementSupplement({ base, next, decisionId: uuidv7() })).toThrow();
  expect(() => checkImplementSupplement({ base, next: base, decisionId: uuidv7() })).toThrow();
});

test("同一份需求，补授权后的清单与批准时就带implement的清单算出相同的实施范围", () => {
  const { next } = supplemented();
  const direct = fixture().manifest();
  expect([...implementScope(next, goalSections)].sort()).toEqual([...implementScope(direct, goalSections)].sort());
  expect([...implementScope(next, goalSections)]).toEqual(["A"]);
});

test("补授权被拒时给出的原因：已经授权实施、实施目标为空", () => {
  const { base, decisionId, next } = supplemented();
  const why = (run: () => unknown) => { try { run(); } catch (error) { return (error as { advice?: { why: string } }).advice?.why ?? ""; } return ""; };
  expect(why(() => supplementImplementAction({ manifest: next, goalIds: ["A"], decisionId: uuidv7() }))).toContain("已经授权实施");
  expect(why(() => supplementImplementAction({ manifest: base, goalIds: [], decisionId }))).toContain("实施目标");
});
