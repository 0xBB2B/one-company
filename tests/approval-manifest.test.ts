import { expect, test } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { partitionProdDocument } from "../runtime/prod-view.ts";
import { checkContext } from "../runtime/user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation } from "../runtime/user-interaction-format.ts";
import { createApprovalManifest, checkApprovalManifest, approvalManifestDigest, approvedManifestScope, approvalManifestReference, validateDocumentReview } from "../runtime/approval-manifest.ts";

function fixture() {
  const requirementId = uuidv7(), title = "渐进登录", body = "前言：保留邮箱。\r\n# 手机号 {#A}\r\n实现手机号登录。😀\r\n# 微信 {#B}\r\n微信需求未决，不实施。\r\n";
  const partition = partitionProdDocument(requirementId, title, body);
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null,
    to: { commit: "b".repeat(40), hash: partition.prodHash } };
  const context: InteractionContext = { basis: { requirementId, version: 1, epoch: 1, prod: null }, currentGoal: "",
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
  expect(approvedManifestScope(m, { action: "implement", goalIds: ["A"], constraintIds: ["preamble"] })).not.toBeNull();
  for (const goalIds of [["B"], ["A", "B"], ["whole-body"], []]) expect(approvedManifestScope(m, { action: "implement", goalIds, constraintIds: [] })).toBeNull();
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
  expect(approvedManifestScope(m, { action: "implement", goalIds: ["A"], constraintIds: ["preamble", "B"] })).toBeNull();
  r.units[3]!.appliesTo = ["metadata"];
  r.actions[0]!.constraintIds = ["preamble"];
  expect(approvedManifestScope(f.manifest(), { action: "implement", goalIds: ["A"], constraintIds: ["preamble"] })).not.toBeNull();
  r.units[3]!.appliesTo = [];
  expect(() => f.manifest()).toThrow(/incomplete_action_closure/);
});
test("未知影响阻止动作，未确认建议不能标确定正文，未映射相关条目不能被丢弃", () => {
  const f = fixture(); f.result.documentReview!.actions[0]!.unknown = true;
  expect(approvedManifestScope(f.manifest(), { action: "implement", goalIds: ["A"], constraintIds: ["preamble"] })).toBeNull();
  f.result.documentReview!.faithful = false;
  expect(() => f.manifest()).toThrow(/document_not_approved/);
  f.result.documentReview!.faithful = true;
  f.result.entries.push({ ...f.result.entries[2]!, conclusion: "新增未映射限制" }); f.saved.push(uuidv7());
  expect(() => f.manifest()).toThrow(/unmapped_review_entry/);
});
test("manifest严格未知字段、hash、引用及64KiB拒绝；hash不含自身且键顺序无关", () => {
  const f = fixture(), m = f.manifest();
  for (const changed of [{ ...m, manifestHash: "f".repeat(64) }, { ...m, prodBody: "payload" },
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
