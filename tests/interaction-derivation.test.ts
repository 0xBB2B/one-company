import { expect, test } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { partitionProdDocument } from "../runtime/prod-view.ts";
import type { InteractionContext } from "../runtime/user-interaction-format.ts";
import { approvedManifestScope, createApprovalManifest, validateDocumentReview } from "../runtime/approval-manifest.ts";
import { deriveInterpretation } from "../runtime/interaction-derivation.ts";

function fixture() {
  const requirementId = uuidv7(), title = "渐进登录", body = "前言：保留邮箱。\r\n# 手机号 {#A}\r\n实现手机号登录。\r\n# 微信 {#B}\r\n微信需求未决，不实施。\r\n";
  const partition = partitionProdDocument(requirementId, title, body);
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null, to: { commit: "b".repeat(40), hash: partition.prodHash } };
  const context: InteractionContext = { basis: { requirementId, version: 1, epoch: 1, prod: null }, currentGoal: "",
    candidates: [{ ...candidate, diff: "+手机号与明确未决微信" }], questions: [], priorDecisions: [], document: { candidate, title, body, partition } };
  const common = { basis: "explicit" as const, resolution: "direct" as const, candidateId: candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "仅手机号" };
  const output = { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: true,
    unitHints: [{ id: "A", globalConstraint: false, appliesTo: [], dependsOn: ["preamble"] }],
    entries: [
      { ...common, kind: "target", conclusion: "实现手机号", unitIds: ["A"] },
      { ...common, kind: "constraint", conclusion: "保留邮箱", unitIds: ["preamble"] },
      { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "微信未决", unitIds: ["B"] },
      { ...common, kind: "action", actions: ["implement"], conclusion: "实施手机号", unitIds: ["A"] },
    ] as Array<Record<string, unknown>> };
  return { context, output, candidate, derive: () => deriveInterpretation(JSON.stringify(output), context) };
}

test("按每条决定涉及的段机械生成逐段审阅：编号、处理结论、动作目标与依赖闭包都由程序算出，并通过原有核对", () => {
  const f = fixture(), result = f.derive();
  expect(result.documentReview).toEqual({ faithful: true, questions: [],
    units: [
      { id: "metadata", disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [0] },
      { id: "preamble", disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [1] },
      { id: "A", disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: ["preamble"], conclusionIndexes: [0] },
      { id: "B", disposition: "pending-description", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [2] },
    ],
    actions: [{ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], conclusionIndexes: [3], unknown: false }] });
  expect(result.entries.every((entry) => !("unitIds" in entry))).toBe(true);
  expect(() => validateDocumentReview(f.context, result)).not.toThrow();
  const manifest = createApprovalManifest(f.context, result, result.entries.map(() => uuidv7()));
  expect(approvedManifestScope(manifest, { action: "implement", goalIds: ["A"], constraintIds: ["preamble"] })).not.toBeNull();
});

test("metadata 段只跟随同一候选里明确确认、不挂在提问下的目标决定，且永远不作动作目标", () => {
  const f = fixture();
  f.output.entries[3]!.unitIds = ["metadata", "A"];
  const review = f.derive().documentReview!;
  expect(review.units[0]).toMatchObject({ id: "metadata", conclusionIndexes: [0] });
  expect(review.actions).toEqual([{ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], conclusionIndexes: [3], unknown: false }]);
  const deferred = fixture();
  deferred.output.entries[0]!.resolution = "defer";
  expect(deferred.derive().documentReview!.units[0]).toMatchObject({ id: "metadata", conclusionIndexes: [] });
});

test("没有决定涉及的正文段不会被默认确认，交由原有核对拒绝", () => {
  const f = fixture();
  f.output.entries[2]!.unitIds = [];
  const result = f.derive();
  expect(result.documentReview!.units[3]).toMatchObject({ id: "B", conclusionIndexes: [] });
  expect(() => validateDocumentReview(f.context, result)).toThrow(/review_entry_mismatch/);
});

test("动作只涉及没有明确目标的段时不生成范围，动作条目未被映射而被核对拒绝", () => {
  const f = fixture();
  f.output.entries[3]!.unitIds = ["preamble"];
  const result = f.derive();
  expect(result.documentReview!.actions).toEqual([]);
  expect(() => validateDocumentReview(f.context, result)).toThrow(/unmapped_review_entry/);
});

test("模型自己写逐段审阅、缺少 faithful、或在没有草稿时给出涉及段，均按格式不合格拒绝", () => {
  const withReview = fixture();
  Object.assign(withReview.output, { documentReview: { faithful: true, units: [], actions: [], questions: [] } });
  expect(() => withReview.derive()).toThrow(/invalid_shape/);
  const noFaithful = fixture();
  delete (noFaithful.output as Record<string, unknown>).faithful;
  expect(() => noFaithful.derive()).toThrow(/invalid_shape/);
  const noDocument = fixture();
  delete noDocument.context.document;
  expect(() => noDocument.derive()).toThrow(/invalid_shape/);
  const plain = { format: "interaction-interpretation/v1", referenceResolution: "none", entries: [{ ...noDocument.output.entries[0]!, unitIds: undefined }] };
  delete plain.entries[0]!.unitIds;
  expect(deriveInterpretation(JSON.stringify(plain), noDocument.context)).toEqual(plain);
  expect(deriveInterpretation(JSON.stringify({ ...plain, faithful: true, unitHints: [] }), noDocument.context)).toEqual(plain);
  expect(() => deriveInterpretation(JSON.stringify({ ...plain, faithful: false }), noDocument.context)).toThrow(/invalid_shape/);
  expect(() => deriveInterpretation(JSON.stringify({ ...plain, unitHints: [{ id: "A", globalConstraint: false, appliesTo: [], dependsOn: [] }] }), noDocument.context))
    .toThrow(/invalid_shape/);
});

test("M9：动作列了一条目标里的某段就覆盖整条目标，漏列同条目标的其他段不收窄授权；分开确认的另一条目标不被带入", () => {
  const whole = fixture();
  whole.output.entries[0]!.unitIds = ["A", "B"];
  whole.output.entries[2] = { ...whole.output.entries[0]!, kind: "constraint", conclusion: "保留邮箱", unitIds: ["preamble"] };
  const result = whole.derive();
  expect(result.documentReview!.actions).toMatchObject([{ action: "implement", goalIds: ["A", "B"], conclusionIndexes: [3] }]);
  expect(() => validateDocumentReview(whole.context, result)).not.toThrow();

  const separate = fixture();
  separate.output.entries[2] = { ...separate.output.entries[0]!, conclusion: "微信也要", unitIds: ["B"] };
  expect(separate.derive().documentReview!.actions).toMatchObject([{ action: "implement", goalIds: ["A"] }]);
});
