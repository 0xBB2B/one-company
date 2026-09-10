import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  ACCEPTANCE_SCHEMA,
  REVIEW_SCHEMA,
  ResultCollector,
  WORK_SCHEMA,
  assertOutputSchema,
  isAcceptancePass,
  isReviewPass,
  isWorkPass,
  validateResult,
} from "../runtime/result.ts";

function validWork(overrides: Record<string, unknown> = {}) {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "完成红绿重构循环",
    issues: [],
    evidence: ["tests/x.test.ts 全绿"],
    changeKind: "behavior-change",
    workState: "red-green",
    coverage: [{ ref: "AC-1", test: "校验合法对象通过" }],
    redCommands: [{ command: "bun test tests/x.test.ts", status: "failed", details: "红阶段失败" }],
    greenCommands: [{ command: "bun test tests/x.test.ts", status: "passed", details: "绿阶段通过" }],
    changedFiles: ["runtime/result.ts"],
    productionPath: ["runtime/result.ts"],
    preexistingEvidence: [],
    fakeRed: false,
    ...overrides,
  };
}

function validReview(overrides: Record<string, unknown> = {}) {
  return {
    phase: "review",
    verdict: "PASS",
    summary: "审查通过",
    issues: [],
    evidence: ["提交记录与测试一致"],
    reviewedHead: "abc1234",
    contentFingerprint: "fp-abc123",
    traceability: [{ ref: "AC-1", test: "校验合法对象通过", implementation: "validateResult" }],
    findings: [],
    ...overrides,
  };
}

function validAcceptance(overrides: Record<string, unknown> = {}) {
  return {
    phase: "acceptance",
    verdict: "PASS",
    summary: "验收通过",
    issues: [],
    evidence: ["报告核对一致"],
    acceptanceResult: "accepted",
    reportPath: "/reports/acceptance.md",
    items: [{ id: "AC-1", result: "PASS", observed: "行为一致", difference: "" }],
    uncovered: [],
    ...overrides,
  };
}

describe("assertOutputSchema", () => {
  test("三类导出格式均通过校验", () => {
    expect(() => assertOutputSchema(WORK_SCHEMA)).not.toThrow();
    expect(() => assertOutputSchema(REVIEW_SCHEMA)).not.toThrow();
    expect(() => assertOutputSchema(ACCEPTANCE_SCHEMA)).not.toThrow();
  });

  test("顶层非对象格式被拒绝", () => {
    expect(() => assertOutputSchema(Type.String())).toThrow();
  });

  test("缺少 phase 常量字段的格式被拒绝", () => {
    const missingPhase = Type.Object({ verdict: Type.String() }, { additionalProperties: false });
    expect(() => assertOutputSchema(missingPhase)).toThrow();
  });

  test("含未知关键字的格式被拒绝", () => {
    const withUnknownKeyword = {
      type: "object",
      properties: { phase: { type: "string", const: "work" } },
      required: ["phase"],
      additionalProperties: false,
      "x-unknown-keyword": true,
    };
    expect(() => assertOutputSchema(withUnknownKeyword)).toThrow();
  });
});

describe("validateResult - WORK", () => {
  test("合法 WORK 对象通过", () => {
    const result = validateResult(WORK_SCHEMA, "work", validWork());
    expect(result.ok).toBe(true);
  });

  test("多余顶层字段被拒绝", () => {
    const value = { ...validWork(), extra: "不应存在" };
    const result = validateResult(WORK_SCHEMA, "work", value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  test("缺少必填字段被拒绝", () => {
    const value = validWork() as Record<string, unknown>;
    delete value.coverage;
    const result = validateResult(WORK_SCHEMA, "work", value);
    expect(result.ok).toBe(false);
  });

  test("changeKind 枚举非法被拒绝", () => {
    const result = validateResult(WORK_SCHEMA, "work", validWork({ changeKind: "big-rewrite" }));
    expect(result.ok).toBe(false);
  });

  test("summary 为空字符串被拒绝", () => {
    const result = validateResult(WORK_SCHEMA, "work", validWork({ summary: "" }));
    expect(result.ok).toBe(false);
  });

  test("issues 元素为空字符串被拒绝", () => {
    const result = validateResult(WORK_SCHEMA, "work", validWork({ issues: [""] }));
    expect(result.ok).toBe(false);
  });

  test("fakeRed 为 true 被拒绝", () => {
    const result = validateResult(WORK_SCHEMA, "work", validWork({ fakeRed: true }));
    expect(result.ok).toBe(false);
  });

  test("期望阶段与提交对象不符时被拒绝", () => {
    const result = validateResult(WORK_SCHEMA, "review", validWork());
    expect(result.ok).toBe(false);
  });
});

describe("validateResult - REVIEW", () => {
  test("合法 REVIEW 对象通过", () => {
    const result = validateResult(REVIEW_SCHEMA, "review", validReview());
    expect(result.ok).toBe(true);
  });

  test("多余顶层字段被拒绝", () => {
    const value = { ...validReview(), extra: "不应存在" };
    const result = validateResult(REVIEW_SCHEMA, "review", value);
    expect(result.ok).toBe(false);
  });

  test("findings.severity 枚举非法被拒绝", () => {
    const value = validReview({
      findings: [{ kind: "security", severity: "Critical", location: "a.ts:1", problem: "问题", fix: "修法" }],
    });
    const result = validateResult(REVIEW_SCHEMA, "review", value);
    expect(result.ok).toBe(false);
  });

  test("reviewedHead 为空字符串被拒绝", () => {
    const result = validateResult(REVIEW_SCHEMA, "review", validReview({ reviewedHead: "" }));
    expect(result.ok).toBe(false);
  });
});

describe("validateResult - ACCEPTANCE", () => {
  test("合法 ACCEPTANCE 对象通过", () => {
    const result = validateResult(ACCEPTANCE_SCHEMA, "acceptance", validAcceptance());
    expect(result.ok).toBe(true);
  });

  test("缺少 reportPath 被拒绝", () => {
    const value = validAcceptance() as Record<string, unknown>;
    delete value.reportPath;
    const result = validateResult(ACCEPTANCE_SCHEMA, "acceptance", value);
    expect(result.ok).toBe(false);
  });

  test("items.result 枚举非法被拒绝", () => {
    const value = validAcceptance({
      items: [{ id: "AC-1", result: "UNKNOWN", observed: "观察", difference: "差异" }],
    });
    const result = validateResult(ACCEPTANCE_SCHEMA, "acceptance", value);
    expect(result.ok).toBe(false);
  });

  test("reportPath 为空字符串被拒绝", () => {
    const result = validateResult(ACCEPTANCE_SCHEMA, "acceptance", validAcceptance({ reportPath: "" }));
    expect(result.ok).toBe(false);
  });
});

describe("isWorkPass", () => {
  test("条件全部满足判 PASS", () => {
    const { pass } = isWorkPass(validWork());
    expect(pass).toBe(true);
  });

  test("workState 为 blocked 判 FAIL", () => {
    const { pass } = isWorkPass(validWork({ verdict: "FAIL", workState: "blocked" }));
    expect(pass).toBe(false);
  });

  test("issues 非空判 FAIL", () => {
    const { pass } = isWorkPass(validWork({ verdict: "FAIL", issues: ["遗留问题"] }));
    expect(pass).toBe(false);
  });

  test("coverage 为空判 FAIL", () => {
    const { pass } = isWorkPass(validWork({ verdict: "FAIL", coverage: [] }));
    expect(pass).toBe(false);
  });

  test("greenCommands 存在非 passed 判 FAIL", () => {
    const { pass } = isWorkPass(
      validWork({
        verdict: "FAIL",
        greenCommands: [{ command: "bun test", status: "failed", details: "绿阶段应全过但失败" }],
      }),
    );
    expect(pass).toBe(false);
  });

  test("behavior-change 但 redCommands 无 failed 判 FAIL", () => {
    const { pass } = isWorkPass(
      validWork({
        verdict: "FAIL",
        redCommands: [{ command: "bun test", status: "passed", details: "红阶段应先失败" }],
      }),
    );
    expect(pass).toBe(false);
  });

  test("verdict PASS 但条件不成立判语义矛盾", () => {
    const { pass, reasons } = isWorkPass(validWork({ verdict: "PASS", workState: "blocked" }));
    expect(pass).toBe(false);
    expect(reasons.some((reason) => reason.includes("矛盾"))).toBe(true);
  });

  test("verdict FAIL 但条件实际成立判语义矛盾", () => {
    const { pass, reasons } = isWorkPass(validWork({ verdict: "FAIL" }));
    expect(pass).toBe(false);
    expect(reasons.some((reason) => reason.includes("矛盾"))).toBe(true);
  });
});

describe("isReviewPass", () => {
  const snapshot = { reviewedHead: "abc1234", contentFingerprint: "fp-abc123" };

  test("条件全部满足且快照匹配判 PASS", () => {
    const { pass } = isReviewPass(validReview(), snapshot);
    expect(pass).toBe(true);
  });

  test("issues 非空判 FAIL", () => {
    const { pass } = isReviewPass(validReview({ verdict: "FAIL", issues: ["遗留问题"] }), snapshot);
    expect(pass).toBe(false);
  });

  test("findings 非空判 FAIL", () => {
    const { pass } = isReviewPass(
      validReview({
        verdict: "FAIL",
        findings: [{ kind: "security", severity: "Blocker", location: "a.ts:1", problem: "问题", fix: "修法" }],
      }),
      snapshot,
    );
    expect(pass).toBe(false);
  });

  test("traceability 为空判 FAIL", () => {
    const { pass } = isReviewPass(validReview({ verdict: "FAIL", traceability: [] }), snapshot);
    expect(pass).toBe(false);
  });

  test("evidence 为空判 FAIL", () => {
    const { pass } = isReviewPass(validReview({ verdict: "FAIL", evidence: [] }), snapshot);
    expect(pass).toBe(false);
  });

  test("reviewedHead 与快照不符判 FAIL", () => {
    const { pass } = isReviewPass(validReview({ verdict: "FAIL" }), {
      reviewedHead: "不同的 head",
      contentFingerprint: "fp-abc123",
    });
    expect(pass).toBe(false);
  });

  test("contentFingerprint 与快照不符判 FAIL", () => {
    const { pass } = isReviewPass(validReview({ verdict: "FAIL" }), {
      reviewedHead: "abc1234",
      contentFingerprint: "不同的指纹",
    });
    expect(pass).toBe(false);
  });

  test("verdict 与谓词矛盾判语义矛盾", () => {
    const { pass, reasons } = isReviewPass(validReview({ verdict: "PASS", issues: ["遗留问题"] }), snapshot);
    expect(pass).toBe(false);
    expect(reasons.some((reason) => reason.includes("矛盾"))).toBe(true);
  });
});

describe("isAcceptancePass", () => {
  const expected = { reportPath: "/reports/acceptance.md", reportConclusion: "accepted" as const };

  test("条件全部满足判 PASS", () => {
    const { pass } = isAcceptancePass(validAcceptance(), expected);
    expect(pass).toBe(true);
  });

  test("acceptanceResult 为 rejected 判 FAIL", () => {
    const { pass } = isAcceptancePass(validAcceptance({ verdict: "FAIL", acceptanceResult: "rejected" }), expected);
    expect(pass).toBe(false);
  });

  test("items 存在 FAIL 项判 FAIL", () => {
    const { pass } = isAcceptancePass(
      validAcceptance({
        verdict: "FAIL",
        items: [{ id: "AC-1", result: "FAIL", observed: "不一致", difference: "实际与预期不同" }],
      }),
      expected,
    );
    expect(pass).toBe(false);
  });

  test("items 为空判 FAIL", () => {
    const { pass } = isAcceptancePass(validAcceptance({ verdict: "FAIL", items: [] }), expected);
    expect(pass).toBe(false);
  });

  test("issues 非空判 FAIL", () => {
    const { pass } = isAcceptancePass(validAcceptance({ verdict: "FAIL", issues: ["缺项"] }), expected);
    expect(pass).toBe(false);
  });

  test("uncovered 非空判 FAIL", () => {
    const { pass } = isAcceptancePass(validAcceptance({ verdict: "FAIL", uncovered: ["AC-2 未覆盖"] }), expected);
    expect(pass).toBe(false);
  });

  test("reportPath 与指定路径不符判 FAIL", () => {
    const { pass } = isAcceptancePass(validAcceptance({ verdict: "FAIL" }), {
      reportPath: "/other/path.md",
      reportConclusion: "accepted",
    });
    expect(pass).toBe(false);
  });

  test("verdict 与谓词矛盾判语义矛盾", () => {
    const { pass, reasons } = isAcceptancePass(
      validAcceptance({ verdict: "PASS", acceptanceResult: "rejected" }),
      expected,
    );
    expect(pass).toBe(false);
    expect(reasons.some((reason) => reason.includes("矛盾"))).toBe(true);
  });
});

describe("ResultCollector - 提交与门禁", () => {
  test("合法对象被接受且正常结束后 finish 返回该结果", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    const accepted = collector.accept({ toolCallId: "call-1", value });
    expect(accepted.accepted).toBe(true);
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual(value);
  });

  test("格式错误的对象被拒绝且给出具体错误", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const result = collector.accept({ toolCallId: "call-1", value: validWork({ verdict: "MAYBE" }) });
    expect(result.accepted).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("未提交任何对象即正常结束不能构成通过", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(false);
  });

  test("提交后未 settled 即 finish 返回失败", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "call-1", value: validWork() });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(false);
  });

  for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
    test(`stopReason 为 ${stopReason} 时 finish 返回失败`, () => {
      const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
      collector.accept({ toolCallId: "call-1", value: validWork() });
      collector.markSettled({ stopReason });
      const outcome = collector.finish();
      expect(outcome.ok).toBe(false);
    });
  }

  test("相同标识的相同完成事件重复投递不计数", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    collector.accept({ toolCallId: "call-1", value });
    collector.accept({ toolCallId: "call-1", value });
    expect(collector.diagnostics().attempts).toBe(1);
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(true);
  });

  test("同一标识内容冲突使最终结算失败", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    const first = collector.accept({ toolCallId: "call-1", value });
    expect(first.accepted).toBe(true);
    const conflicting = collector.accept({
      toolCallId: "call-1",
      value: validWork({ summary: "换了一个不同的摘要" }),
    });
    expect(conflicting.accepted).toBe(false);
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(false);
  });

  test("无标识的两次提交各自独立处理", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const invalid = validWork({ verdict: "MAYBE" });
    collector.accept({ value: invalid });
    collector.accept({ value: invalid });
    expect(collector.diagnostics().attempts).toBe(2);
  });

  test("首个有效对象接受前的失败尝试允许以新调用纠正", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const failed = collector.accept({ toolCallId: "call-1", value: validWork({ verdict: "MAYBE" }) });
    expect(failed.accepted).toBe(false);
    const corrected = collector.accept({ toolCallId: "call-2", value: validWork() });
    expect(corrected.accepted).toBe(true);
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(true);
  });

  test("有效对象被接受后再提交必须失败", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "call-1", value: validWork() });
    const second = collector.accept({ toolCallId: "call-2", value: validWork({ summary: "另一个摘要" }) });
    expect(second.accepted).toBe(false);
  });

  test("diagnostics 汇总每次提交记录", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "call-1", value: validWork({ verdict: "MAYBE" }) });
    collector.accept({ toolCallId: "call-2", value: validWork() });
    const diagnostics = collector.diagnostics();
    expect(diagnostics.attempts).toBe(2);
    expect(diagnostics.valid).toBe(1);
    expect(diagnostics.records).toHaveLength(2);
    expect(diagnostics.records[0]?.accepted).toBe(false);
    expect(diagnostics.records[1]?.accepted).toBe(true);
  });

  test("ResultCollector 支持 REVIEW 阶段格式", () => {
    const collector = new ResultCollector({ schema: REVIEW_SCHEMA, phase: "review" });
    const value = validReview();
    collector.accept({ toolCallId: "call-1", value });
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(true);
  });

  test("ResultCollector 支持 ACCEPTANCE 阶段格式", () => {
    const collector = new ResultCollector({ schema: ACCEPTANCE_SCHEMA, phase: "acceptance" });
    const value = validAcceptance();
    collector.accept({ toolCallId: "call-1", value });
    collector.markSettled({ stopReason: "stop" });
    const outcome = collector.finish();
    expect(outcome.ok).toBe(true);
  });
});

describe("标识去重、结束终态与诊断计数", () => {
  test("同标识相同内容但键顺序不同视为重复投递，不增加尝试数", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    collector.accept({ toolCallId: "call-1", value });
    const second = collector.accept({ toolCallId: "call-1", value: reordered });
    expect(second.accepted).toBe(true);
    expect(collector.diagnostics().attempts).toBe(1);
  });

  test("同标识历史上任一记录相同即视为重复，不再压入冲突记录", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    collector.accept({ toolCallId: "call-1", value });
    collector.accept({ toolCallId: "call-1", value: validWork({ summary: "别的" }) });
    collector.accept({ toolCallId: "call-1", value });
    expect(collector.diagnostics().attempts).toBe(2);
  });

  test("空白标识按无标识独立处理", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const first = collector.accept({ toolCallId: "", value: validWork({ verdict: "MAYBE" }) });
    const second = collector.accept({ toolCallId: "  ", value: validWork() });
    expect(first.accepted).toBe(false);
    expect(second.accepted).toBe(true);
    expect(collector.diagnostics().attempts).toBe(2);
  });

  test("markSettled 首次为异常结束后再次标记为 stop 不能翻成通过", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "call-1", value: validWork() });
    collector.markSettled({ stopReason: "error" });
    collector.markSettled({ stopReason: "stop" });
    expect(collector.finish().ok).toBe(false);
  });

  test("markSettled 之后的提交记为失败尝试且不能通过", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.markSettled({ stopReason: "stop" });
    const late = collector.accept({ toolCallId: "call-1", value: validWork() });
    expect(late.accepted).toBe(false);
    expect(late.errors.join("")).toContain("结束");
    expect(collector.finish().ok).toBe(false);
  });

  test("diagnostics 逐条记录重复与冲突次数，不含提交正文", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    const value = validWork();
    collector.accept({ toolCallId: "call-1", value });
    collector.accept({ toolCallId: "call-1", value });
    collector.accept({ toolCallId: "call-1", value: validWork({ summary: "冲突" }) });
    const diagnostics = collector.diagnostics();
    expect(diagnostics.attempts).toBe(2);
    expect(diagnostics.records[0]).toEqual({ toolCallId: "call-1", accepted: true, errors: [], duplicateEvents: 1, conflictingEvents: 1 });
    expect(JSON.stringify(diagnostics)).not.toContain(value.summary);
  });

  test("validateResult 通过时返回对象本身", () => {
    const value = validWork();
    const outcome = validateResult(WORK_SCHEMA, "work", value);
    expect(outcome).toEqual({ ok: true, value });
  });

  test("自引用的格式对象被判为不合法而不是栈溢出", () => {
    const schema: Record<string, unknown> = { type: "object", properties: { phase: { const: "work" } } };
    (schema.properties as Record<string, unknown>).self = schema;
    expect(() => assertOutputSchema(schema)).toThrow("循环");
  });

  test("isAcceptancePass 在报告结论为 rejected 时不成立", () => {
    const outcome = isAcceptancePass(validAcceptance(), { reportPath: "/reports/acceptance.md", reportConclusion: "rejected" });
    expect(outcome.pass).toBe(false);
  });

  test("isWorkPass 在 refactor 且无失败 redCommand 时成立", () => {
    const outcome = isWorkPass(validWork({ changeKind: "refactor", redCommands: [] }));
    expect(outcome.pass).toBe(true);
  });

  test("ACCEPTANCE 多余顶层字段被拒绝", () => {
    const outcome = validateResult(ACCEPTANCE_SCHEMA, "acceptance", validAcceptance({ extra: 1 }));
    expect(outcome.ok).toBe(false);
  });
});

describe("共享子格式与终态收敛", () => {
  test("同一子格式对象被多个属性复用时仍合法", () => {
    const shared = Type.String();
    const schema = Type.Object({ phase: Type.Literal("work"), a: shared, b: shared }, { additionalProperties: false });
    expect(() => assertOutputSchema(schema)).not.toThrow();
  });

  test("先以 stop 结束再报 error 时向失败收敛", () => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "call-1", value: validWork() });
    collector.markSettled({ stopReason: "stop" });
    collector.markSettled({ stopReason: "error" });
    expect(collector.finish().ok).toBe(false);
  });
});


describe("裁决结算失败关闭", () => {
  test.each([
    [WORK_SCHEMA, "work", validWork({ greenCommands: [] })],
    [REVIEW_SCHEMA, "review", validReview({ issues: ["存在阻断"] })],
    [ACCEPTANCE_SCHEMA, "acceptance", validAcceptance({ items: [] })],
  ])("拒绝语义矛盾的通过裁决 %s", (schema, phase, value) => {
    const collector = new ResultCollector({ schema, phase });
    expect(collector.accept({ toolCallId: "first", value }).accepted).toBe(false);
    collector.markSettled({ stopReason: "stop" });
    expect(collector.finish().ok).toBe(false);
  });

  test.each(["second", "first", undefined])("合法结果之后的新增或冲突提交使最终结算失败 %s", (toolCallId) => {
    const collector = new ResultCollector({ schema: WORK_SCHEMA, phase: "work" });
    collector.accept({ toolCallId: "first", value: validWork() });
    collector.accept({ toolCallId, value: validWork({ summary: "另一提交" }) });
    collector.markSettled({ stopReason: "stop" });
    expect(collector.finish().ok).toBe(false);
  });
});
