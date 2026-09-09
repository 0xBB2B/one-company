import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";

const Common = {
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
  summary: Type.String({ minLength: 1 }),
  issues: Type.Array(Type.String({ minLength: 1 })),
  evidence: Type.Array(Type.String({ minLength: 1 })),
};

export const WORK_SCHEMA = Type.Object({
  phase: Type.Literal("work"),
  ...Common,
  changeKind: Type.Union([Type.Literal("behavior-change"), Type.Literal("refactor"), Type.Literal("unclear")]),
  workState: Type.Union([Type.Literal("red-green"), Type.Literal("green-baseline-no-change"), Type.Literal("blocked")]),
  coverage: Type.Array(Type.Object({ ref: Type.String(), test: Type.String() }, { additionalProperties: false })),
  redCommands: Type.Array(Type.Object({ command: Type.String(), status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]), details: Type.String() }, { additionalProperties: false })),
  greenCommands: Type.Array(Type.Object({ command: Type.String(), status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]), details: Type.String() }, { additionalProperties: false })),
  changedFiles: Type.Array(Type.String()),
  productionPath: Type.Array(Type.String()),
  preexistingEvidence: Type.Array(Type.String()),
  fakeRed: Type.Literal(false),
}, { additionalProperties: false });

export const REVIEW_SCHEMA = Type.Object({
  phase: Type.Literal("review"),
  ...Common,
  reviewedHead: Type.String({ minLength: 1 }),
  contentFingerprint: Type.String({ minLength: 1 }),
  traceability: Type.Array(Type.Object({ ref: Type.String(), test: Type.String(), implementation: Type.String() }, { additionalProperties: false })),
  findings: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("security"), Type.Literal("robustness"), Type.Literal("traceability"), Type.Literal("tdd"), Type.Literal("scope")]),
    severity: Type.Union([Type.Literal("Blocker"), Type.Literal("Important")]),
    location: Type.String(), problem: Type.String(), fix: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ACCEPTANCE_SCHEMA = Type.Object({
  phase: Type.Literal("acceptance"),
  ...Common,
  acceptanceResult: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  reportPath: Type.String({ minLength: 1 }),
  items: Type.Array(Type.Object({ id: Type.String(), result: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]), observed: Type.String(), difference: Type.String() }, { additionalProperties: false })),
  uncovered: Type.Array(Type.String()),
}, { additionalProperties: false });

export type Phase = "plan" | "work" | "review" | "acceptance";

type WorkResult = Static<typeof WORK_SCHEMA>;
type ReviewResult = Static<typeof REVIEW_SCHEMA>;
type AcceptanceResult = Static<typeof ACCEPTANCE_SCHEMA>;

export type ValidateOutcome = { ok: true; value: unknown } | { ok: false; errors: string[] };

const SCHEMA_KEYWORDS = new Set(["type", "required", "properties", "additionalProperties", "const", "anyOf", "items", "minLength"]);

function walkSchemaNode(node: unknown, visited: Set<object>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkSchemaNode(item, visited);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (visited.has(node)) throw new Error("格式含循环引用");
  visited.add(node);
  walkSchemaKeys(node as Record<string, unknown>, visited);
  visited.delete(node);
}

function walkSchemaKeys(obj: Record<string, unknown>, visited: Set<object>): void {
  for (const key of Object.keys(obj)) {
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`格式含未知关键字: ${key}`);
    if (key === "properties") {
      const properties = obj[key] as Record<string, unknown>;
      for (const propName of Object.keys(properties)) walkSchemaNode(properties[propName], visited);
    } else if (key === "anyOf") {
      for (const item of obj[key] as unknown[]) walkSchemaNode(item, visited);
    } else if (key === "items") {
      walkSchemaNode(obj[key], visited);
    }
  }
}

export function assertOutputSchema(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("格式必须是顶层对象");
  }
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") throw new Error("格式顶层必须是 object");
  const properties = obj.properties as Record<string, unknown> | undefined;
  const phaseSchema = properties?.phase as Record<string, unknown> | undefined;
  if (!phaseSchema || typeof phaseSchema.const !== "string") {
    throw new Error("格式必须包含 phase 常量字段");
  }
  walkSchemaNode(schema, new Set());
}

export function validateResult(schema: TSchema, expectedPhase: Phase, value: unknown): ValidateOutcome {
  const errors: string[] = [];
  const phase = value !== null && typeof value === "object" ? (value as Record<string, unknown>).phase : undefined;
  if (phase !== expectedPhase) errors.push(`phase 必须为 ${expectedPhase}`);
  if (!Value.Check(schema, value)) {
    for (const error of Value.Errors(schema, value)) errors.push(error.message);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

type Verdict = { pass: boolean; reasons: string[] };

function resolveVerdict(verdict: "PASS" | "FAIL", semantic: Verdict): Verdict {
  if (verdict === "PASS") {
    if (semantic.pass) return { pass: true, reasons: [] };
    return { pass: false, reasons: ["verdict 为 PASS 但语义条件不成立，判定矛盾", ...semantic.reasons] };
  }
  if (!semantic.pass) return { pass: false, reasons: semantic.reasons };
  return { pass: false, reasons: ["verdict 为 FAIL 但语义条件实际成立，判定矛盾"] };
}

export function isWorkPass(value: WorkResult): Verdict {
  const reasons: string[] = [];
  if (value.workState === "blocked") reasons.push("workState 为 blocked");
  if (value.issues.length > 0) reasons.push("issues 非空");
  if (value.coverage.length === 0) reasons.push("coverage 为空");
  if (!value.greenCommands.every((command) => command.status === "passed")) reasons.push("greenCommands 存在未通过项");
  if (value.changeKind === "behavior-change" && !value.redCommands.some((command) => command.status === "failed")) {
    reasons.push("behavior-change 但 redCommands 无 failed 记录");
  }
  return resolveVerdict(value.verdict, { pass: reasons.length === 0, reasons });
}

export function isReviewPass(value: ReviewResult, snapshot: { reviewedHead: string; contentFingerprint: string }): Verdict {
  const reasons: string[] = [];
  if (value.issues.length > 0) reasons.push("issues 非空");
  if (value.findings.length > 0) reasons.push("findings 非空");
  if (value.traceability.length === 0) reasons.push("traceability 为空");
  if (value.evidence.length === 0) reasons.push("evidence 为空");
  if (value.reviewedHead !== snapshot.reviewedHead) reasons.push("reviewedHead 与快照不符");
  if (value.contentFingerprint !== snapshot.contentFingerprint) reasons.push("contentFingerprint 与快照不符");
  return resolveVerdict(value.verdict, { pass: reasons.length === 0, reasons });
}

export function isAcceptancePass(
  value: AcceptanceResult,
  expected: { reportPath: string; reportConclusion: "accepted" | "rejected" },
): Verdict {
  const reasons: string[] = [];
  if (value.acceptanceResult !== "accepted") reasons.push("acceptanceResult 非 accepted");
  if (value.items.length === 0) reasons.push("items 为空");
  else if (!value.items.every((item) => item.result === "PASS")) reasons.push("items 存在 FAIL 项");
  if (value.issues.length > 0) reasons.push("issues 非空");
  if (value.uncovered.length > 0) reasons.push("uncovered 非空");
  if (value.reportPath !== expected.reportPath) reasons.push("reportPath 与指定路径不符");
  if (expected.reportConclusion !== "accepted") reasons.push("报告结论非 accepted");
  return resolveVerdict(value.verdict, { pass: reasons.length === 0, reasons });
}

export type StopReason = "stop" | "error" | "aborted" | "length" | "toolUse";

export type AcceptInput = { toolCallId?: string; value: unknown };
export type AcceptOutcome = { accepted: boolean; errors: string[] };

type AttemptRecord = {
  toolCallId?: string;
  accepted: boolean;
  errors: string[];
  value: unknown;
  duplicateEvents: number;
  conflictingEvents: number;
};

export type FinishOutcome = { ok: true; result: unknown } | { ok: false; reason: string };

export type DiagnosticRecord = {
  toolCallId?: string;
  accepted: boolean;
  errors: string[];
  duplicateEvents: number;
  conflictingEvents: number;
};

export type Diagnostics = {
  attempts: number;
  valid: number;
  records: DiagnosticRecord[];
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
}

function normalizeToolCallId(toolCallId: string | undefined): string | undefined {
  return toolCallId?.trim() ? toolCallId : undefined;
}

export class ResultCollector {
  private readonly schema: TSchema;
  private readonly phase: Phase;
  private readonly records: AttemptRecord[] = [];
  private settled = false;
  private stopReason: StopReason | undefined;

  constructor(options: { schema: TSchema; phase: Phase }) {
    this.schema = options.schema;
    this.phase = options.phase;
  }

  private push(record: Omit<AttemptRecord, "duplicateEvents" | "conflictingEvents">): AcceptOutcome {
    this.records.push({ ...record, duplicateEvents: 0, conflictingEvents: 0 });
    return { accepted: record.accepted, errors: record.errors };
  }

  accept(input: AcceptInput): AcceptOutcome {
    const toolCallId = normalizeToolCallId(input.toolCallId);
    const { value } = input;
    if (toolCallId !== undefined) {
      const priors = this.records.filter((record) => record.toolCallId === toolCallId);
      const duplicate = priors.find((record) => sameValue(record.value, value));
      if (duplicate) {
        duplicate.duplicateEvents += 1;
        return { accepted: duplicate.accepted, errors: duplicate.errors };
      }
      if (priors.length > 0) {
        priors[0]!.conflictingEvents += 1;
        return this.push({ toolCallId, accepted: false, errors: ["与同一提交标识下已记录的内容冲突"], value });
      }
    }
    if (this.settled) {
      return this.push({ toolCallId, accepted: false, errors: ["运行已结束，提交不再接受"], value });
    }
    if (this.records.some((record) => record.accepted)) {
      return this.push({ toolCallId, accepted: false, errors: ["已存在有效结果，禁止再次提交"], value });
    }
    const outcome = validateResult(this.schema, this.phase, value);
    return this.push({ toolCallId, accepted: outcome.ok, errors: outcome.ok ? [] : outcome.errors, value });
  }

  markSettled(input: { stopReason: StopReason }): void {
    if (this.settled && this.stopReason !== "stop") return;
    this.settled = true;
    this.stopReason = input.stopReason;
  }

  finish(): FinishOutcome {
    if (!this.settled) return { ok: false, reason: "运行未正常结束" };
    if (this.stopReason !== "stop") return { ok: false, reason: `运行以 ${this.stopReason} 结束` };
    const validRecords = this.records.filter((record) => record.accepted);
    if (validRecords.length !== 1) return { ok: false, reason: "有效结构化结果数量不为一" };
    return { ok: true, result: validRecords[0]!.value };
  }

  diagnostics(): Diagnostics {
    return {
      attempts: this.records.length,
      valid: this.records.filter((record) => record.accepted).length,
      records: this.records.map((record) => ({
        toolCallId: record.toolCallId,
        accepted: record.accepted,
        errors: record.errors,
        duplicateEvents: record.duplicateEvents,
        conflictingEvents: record.conflictingEvents,
      })),
    };
  }
}
