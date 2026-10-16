import { expect, test } from "vitest";
import { uuidv7 } from "../src/core/storage/database.ts";
import { partitionProdDocument } from "../src/modules/requirement/prod-view.ts";
import type { InteractionContext, UserInteractionError } from "../src/modules/requirement/user-interaction-format.ts";
import { createApprovalManifest, validateDocumentReview } from "../src/modules/requirement/approval-manifest.ts";
import { summarizeApprovalManifest } from "../src/modules/requirement/approval-manifest-store.ts";
import { deriveInterpretation } from "../src/modules/interaction/interaction-derivation.ts";

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
  expect(manifest.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], unknown: false })]);
  expect(summarizeApprovalManifest(manifest).blocked).toEqual([]);
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

test("按格式不合格拒绝时写明原因：多出的字段、有草稿却漏写 faithful、没有草稿却给出涉及段", () => {
  const why = (run: () => unknown) => { try { run(); } catch (error) { return (error as UserInteractionError).advice.why; } throw new Error("没有拒绝"); };
  const withReview = fixture();
  Object.assign(withReview.output, { documentReview: { faithful: true, units: [], actions: [], questions: [] } });
  expect(why(() => withReview.derive())).toContain("documentReview");
  const noFaithful = fixture();
  delete (noFaithful.output as Record<string, unknown>).faithful;
  expect(why(() => noFaithful.derive())).toContain("faithful");
  const noDocument = fixture();
  delete noDocument.context.document;
  expect(why(() => noDocument.derive())).toContain("unitIds");
});

test("M9：动作列了一条目标里的某段就覆盖整条目标，漏列同条目标的其他段不收窄动作范围；分开确认的另一条目标不被带入", () => {
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

/** 上一版里 preamble 与 A 已被用户明确确认、字节没变；这一版只新增了 B。 */
function placeholderFixture(implementation = "由 PM 规划。") {
  const requirementId = uuidv7(), title = "手机号登录", body = `# 手机号 {#A}\n实现手机号登录。\n# 实现 {#impl}\n${implementation}\n# 背景 {#bg}\n用户未说明\n`;
  const partition = partitionProdDocument(requirementId, title, body);
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "a".repeat(64), from: null, to: { commit: "b".repeat(40), hash: partition.prodHash } };
  const context: InteractionContext = { basis: { requirementId, version: 1, epoch: 1, prod: null }, currentGoal: "",
    candidates: [{ ...candidate, diff: "+手机号登录" }], questions: [], priorDecisions: [], document: { candidate, title, body, partition } };
  const common = { basis: "explicit" as const, resolution: "direct" as const, candidateId: candidate.candidateId, requestId: null as string | null, actions: [], references: [], supersedes: [], scope: "手机号登录" };
  const output = { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: false,
    entries: [
      { ...common, kind: "target", conclusion: "实现手机号登录", unitIds: ["A"] },
      { ...common, kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "不确定由 PM 规划是否保留", unitIds: ["impl", "bg"] },
      { ...common, kind: "action", actions: ["implement"], conclusion: "实施手机号登录", unitIds: ["A", "impl"] },
    ] as Array<Record<string, unknown>> };
  return { context, output, derive: () => deriveInterpretation(JSON.stringify(output), context) };
}

test("只写规范占位文字的段被解释器标成待定或没提到时，用户明确确认了同一草稿的目标就由程序算作已确认，整份改判忠实，占位段不作动作目标", () => {
  const f = placeholderFixture(), result = f.derive();
  expect(result.entries.map((e) => e.kind)).toEqual(["target", "action"]);
  expect(result.documentReview).toMatchObject({ faithful: true, actions: [{ action: "implement", goalIds: ["A"], constraintIds: [] }] });
  for (const id of ["impl", "bg"]) expect(result.documentReview!.units.find((u) => u.id === id)).toMatchObject({ disposition: "confirmed", conclusionIndexes: [0] });
  expect(() => validateDocumentReview(f.context, result)).not.toThrow();
  const silent = placeholderFixture();
  silent.output.entries.splice(1, 1);
  expect(silent.derive().documentReview!.units.find((u) => u.id === "impl")).toMatchObject({ disposition: "confirmed", conclusionIndexes: [0] });
});

test("用户要改占位段、待定挂在问题下、没有明确确认目标、或段里不只有占位文字时，不由程序代判", () => {
  const pending = (f: ReturnType<typeof placeholderFixture>) => f.derive().documentReview!.units.find((u) => u.id === "impl")!.disposition;
  const modify = placeholderFixture();
  modify.output.entries[1]!.resolution = "modify";
  expect(pending(modify)).toBe("pending-description");
  const asked = placeholderFixture();
  asked.output.entries[1]!.requestId = uuidv7();
  expect(pending(asked)).toBe("pending-description");
  const noTarget = placeholderFixture();
  noTarget.output.entries[0]!.resolution = "defer";
  expect(pending(noTarget)).toBe("pending-description");
  const content = placeholderFixture("由 PM 规划，缓存用 Redis。");
  expect(pending(content)).toBe("pending-description");
  expect(content.derive().documentReview!.units.find((u) => u.id === "bg")).toMatchObject({ disposition: "confirmed" });
});

function retainedFixture() {
  const f = fixture();
  const evidence = (unitId: string, kind: "target" | "constraint") => {
    const unit = f.context.document!.partition.units.find((candidate) => candidate.id === unitId)!;
    return { fact: { id: uuidv7(), version: 1, hash: "c".repeat(64) }, decision: { id: uuidv7(), version: 1, hash: "d".repeat(64) },
      sourceBasis: { ...f.context.basis }, sourceBinding: f.candidate, unitId, unitHash: unit.hash, kind };
  };
  const retained = [evidence("preamble", "constraint"), evidence("A", "target")];
  f.context.retainedEvidence = retained;
  const common = { basis: "explicit" as const, resolution: "direct" as const, candidateId: f.candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "仅微信" };
  f.output.unitHints = [];
  f.output.entries = [{ ...common, kind: "target", conclusion: "新增微信登录", unitIds: ["B"] }];
  return { ...f, retained, common };
}

test("M8D-AC3：没改动且以前确认过的段落，解释器只列为待定时由程序沿用原依据，待定条目去掉，整份改判为忠实", () => {
  const f = retainedFixture();
  f.output.faithful = false;
  f.output.entries.push({ ...f.common, kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "旧段落这次没提", unitIds: ["preamble", "A"] });
  const result = f.derive(), units = result.documentReview!.units;
  expect(result.entries).toHaveLength(1);
  expect(result.documentReview!.faithful).toBe(true);
  expect(units.find((u) => u.id === "preamble")).toMatchObject({ disposition: "confirmed", conclusionIndexes: [], retainedFactIds: [f.retained[0]!.fact.id] });
  expect(units.find((u) => u.id === "A")).toMatchObject({ disposition: "confirmed", conclusionIndexes: [], retainedFactIds: [f.retained[1]!.fact.id] });
  expect(units.find((u) => u.id === "B")).toMatchObject({ disposition: "confirmed", conclusionIndexes: [0] });
});

test("M8D-AC3：解释器完全没提到的没改动段落同样由程序沿用原依据", () => {
  const f = retainedFixture();
  const units = f.derive().documentReview!.units;
  expect(units.find((u) => u.id === "A")).toMatchObject({ conclusionIndexes: [], retainedFactIds: [f.retained[1]!.fact.id] });
  expect(units.find((u) => u.id === "preamble")).toMatchObject({ retainedFactIds: [f.retained[0]!.fact.id] });
});

test("解释器给没改动的段引错了原依据编号时，程序改用清单里该段的原依据并通过核对；给改动过的段写沿用仍被拒绝", () => {
  const f = retainedFixture();
  f.output.unitHints = [{ id: "A", globalConstraint: false, appliesTo: [], dependsOn: [], retainedFactIds: [f.retained[0]!.fact.id] }];
  const result = f.derive();
  expect(result.documentReview!.units.find((u) => u.id === "A")).toMatchObject({ retainedFactIds: [f.retained[1]!.fact.id] });
  expect(() => validateDocumentReview(f.context, result)).not.toThrow();
  const changed = retainedFixture();
  changed.output.unitHints = [{ id: "B", globalConstraint: false, appliesTo: [], dependsOn: [], retainedFactIds: [changed.retained[1]!.fact.id] }];
  expect(() => validateDocumentReview(changed.context, changed.derive())).toThrow(expect.objectContaining({ code: "retained_source_missing" }));
});

test("M8D-AC3：用户要修改或排除的段落、挂在问题下的待定条目，不由程序沿用", () => {
  const modify = retainedFixture();
  modify.output.faithful = false;
  modify.output.entries.push({ ...modify.common, kind: "target", resolution: "modify", conclusion: "手机号改成只支持大陆号码", unitIds: ["A"] });
  const changed = modify.derive();
  expect(changed.documentReview!.faithful).toBe(false);
  expect(changed.documentReview!.units.find((u) => u.id === "A")).toMatchObject({ disposition: "pending-description", conclusionIndexes: [1] });
  expect(changed.documentReview!.units.find((u) => u.id === "A")!.retainedFactIds).toBeUndefined();
  const asked = retainedFixture(), requestId = uuidv7();
  asked.context.questions = [{ format: "interaction-question/v1", requestId, repoId: "e".repeat(64), basis: asked.context.basis, candidate: asked.candidate,
    proposal: { conclusion: "手机号要不要限制地区？", scope: "仅 A", references: [], supersedes: [] }, actions: [], createdAt: 1, unitIds: ["A"] }];
  asked.output.faithful = false;
  asked.output.entries.push({ ...asked.common, kind: "unresolved", basis: "uncertain", resolution: "defer", requestId, conclusion: "地区限制未答", unitIds: ["A"] });
  const pending = asked.derive();
  expect(pending.entries).toHaveLength(2);
  expect(pending.documentReview!.faithful).toBe(false);
  expect(pending.documentReview!.units.find((u) => u.id === "A")!.retainedFactIds).toBeUndefined();
});

test("M8D-AC3：沿用的原依据是排除时该段标为已排除；同一段里排除与确认混在一起时不由程序沿用", () => {
  const excluded = retainedFixture();
  excluded.retained[1]!.kind = "exclusion" as never;
  expect(excluded.derive().documentReview!.units.find((u) => u.id === "A")).toMatchObject({ disposition: "excluded", retainedFactIds: [excluded.retained[1]!.fact.id] });
  const mixed = retainedFixture();
  mixed.context.retainedEvidence = [...mixed.retained, { ...mixed.retained[1]!, fact: { ...mixed.retained[1]!.fact, id: uuidv7() }, kind: "exclusion" }];
  expect(mixed.derive().documentReview!.units.find((u) => u.id === "A")!.retainedFactIds).toBeUndefined();
});

test("M9：本轮明确的实施动作列了沿用原目标依据的段落时，这些段落也列入动作范围；没列的、或沿用的只是约束的段落不列入", () => {
  const f = retainedFixture();
  f.output.entries.push({ ...f.common, kind: "action", actions: ["implement"], conclusion: "继续实施这一版", unitIds: ["preamble", "A", "B"] });
  const result = f.derive();
  expect(result.documentReview!.actions).toEqual([{ action: "implement", goalIds: ["A", "B"], constraintIds: [], conclusionIndexes: [1], unknown: false }]);
  expect(() => validateDocumentReview(f.context, result)).not.toThrow();
  const manifest = createApprovalManifest(f.context, result, result.entries.map(() => uuidv7()));
  expect(manifest.actions).toEqual([expect.objectContaining({ action: "implement", goalIds: ["A", "B"], constraintIds: [], unknown: false })]);
  expect(summarizeApprovalManifest(manifest).blocked).toEqual([]);
  const narrow = retainedFixture();
  narrow.output.entries.push({ ...narrow.common, kind: "action", actions: ["implement"], conclusion: "只实施微信", unitIds: ["B"] });
  expect(narrow.derive().documentReview!.actions.map((action) => action.goalIds)).toEqual([["B"]]);
});
