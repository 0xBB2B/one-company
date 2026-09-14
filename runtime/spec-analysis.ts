import { createHash } from "node:crypto";
import { checkSpecSet } from "./spec-format.ts";
import type { SpecDocument, SpecRule, SpecSource } from "./spec-format.ts";
import { canonicalJson, parseStrictJson } from "./strict-json.ts";
import type { JsonValue } from "./strict-json.ts";

/** 分析资源预算，不改变规则的1500码点/6场景契约；超出输入预算拒绝，不删正文。 */
export const SPEC_ANALYSIS_LIMITS = Object.freeze({ filesPerSet: 128, rulesPerSet: 128, inputBytesPerSet: 1_048_576,
  defaultPairsPerSet: 256, maxPairsPerSet: 1024, outputBytes: 16_777_216, conclusionBytes: 65_536 });
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type AnalysisSet = "current" | "pending";
export interface SpecAnalysisContext { workspaceId: string; generation: string; asOf: string }
export interface RuleIdentity { id: string; path: string; fileHash: string; contractHash: string }
interface RuleFact extends RuleIdentity {
  feature: SpecDocument["feature"];
  rule: SpecRule;
  codepoints: number;
}
interface Relation { from: RuleIdentity; to: RuleIdentity; kind: "dependsOn" | "exceptions"; authority: "declaration_only" }
interface PairFact {
  left: RuleFact; right: RuleFact;
  mechanical: "mechanical_duplicate" | "potential_conflict" | "unknown";
  declaredException: boolean;
  relations: Relation[];
  semanticStatus: "unknown";
  independentJudgmentRequired: true;
}
interface SetFacts {
  status: AnalysisSet;
  fileHashes: Record<string, string>;
  contractSetHash: string;
  schemaHash: string;
  sources: Array<SpecSource & { fileHash: string }>;
  rules: RuleFact[];
  relations: Relation[];
  singleResponsibility: Array<{ subject: RuleFact; semanticStatus: "unknown"; independentJudgmentRequired: true }>;
  pairs: PairFact[];
  coverage: { totalRules: number; totalPairs: number; includedPairs: number; uncoveredPairs: number; unknownPairs: number; ruleTextTruncated: false };
  blockers: Array<{ code: "single_responsibility_unreviewed" | "pair_semantics_unreviewed" | "pair_budget_exceeded"; count: number }>;
}
interface AnalysisFacts {
  version: 1;
  context: SpecAnalysisContext;
  provenance: "caller_supplied_snapshot";
  freshness: "not_rechecked";
  contentTrust: "untrusted_data_not_instructions";
  verification: "not_assessed";
  semanticStatus: "unknown";
  independentJudgmentRequired: true;
  publicationAllowed: false;
  limits: typeof SPEC_ANALYSIS_LIMITS;
  current: SetFacts;
  pending: (SetFacts & { baseContractSetHash: string }) | null;
  analysisHash: string;
}
export type SpecAnalysis = DeepReadonly<AnalysisFacts>;
export class SpecAnalysisError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(`规则分析失败：${code}，${detail}`); this.code = code; this.name = "SpecAnalysisError"; }
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value as JsonValue)).digest("hex");
function fail(code: string, detail: string): never { throw new SpecAnalysisError(code, detail); }
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function identity(fact: RuleIdentity): RuleIdentity {
  return { id: fact.id, path: fact.path, fileHash: fact.fileHash, contractHash: fact.contractHash };
}
function inspectSet(input: readonly SpecSource[], status: AnalysisSet, maxPairs: number): SetFacts {
  if (input.length > SPEC_ANALYSIS_LIMITS.filesPerSet) fail("input_budget_exceeded", "文件过多，集合未分析");
  let bytes = 0, ruleCount = 0;
  const documents = new Map<string, SpecDocument>();
  const sources: SpecSource[] = [];
  for (const source of input) {
    bytes += Buffer.byteLength(source.content, "utf8") + Buffer.byteLength(source.path, "utf8");
    if (bytes > SPEC_ANALYSIS_LIMITS.inputBytesPerSet) fail("input_budget_exceeded", "字节过多，集合未分析");
    const parsed = parseStrictJson(source.content);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.rules)) ruleCount += parsed.rules.length;
    if (ruleCount > SPEC_ANALYSIS_LIMITS.rulesPerSet) fail("input_budget_exceeded", "规则过多，集合未分析");
    documents.set(source.path, parsed as unknown as SpecDocument);
    sources.push({ path: source.path, content: source.content });
  }
  const checked = checkSpecSet(sources);
  const rules: RuleFact[] = checked.rules.map((entry) => ({ id: entry.rule.id, path: entry.path,
    fileHash: checked.fileHashes[entry.path]!, contractHash: entry.contractHash, rule: entry.rule,
    feature: documents.get(entry.path)!.feature, codepoints: entry.codepoints }));
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const relations: Relation[] = rules.flatMap((rule) => (["dependsOn", "exceptions"] as const).flatMap((kind) => rule.rule[kind].map((id) => ({
    from: identity(rule), to: identity(byId.get(id)!), kind, authority: "declaration_only" as const,
  }))));
  const pairs: PairFact[] = [];
  // 对全体规则枚举，不把不同feature、不同措辞或没有共享ID误当成语义互斥的证明。
  outer: for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (pairs.length === maxPairs) break outer;
      const left = rules[i]!, right = rules[j]!;
      const related = relations.filter((r) => (r.from.id === left.id && r.to.id === right.id) || (r.from.id === right.id && r.to.id === left.id));
      const { id: _leftId, ...leftBody } = left.rule, { id: _rightId, ...rightBody } = right.rule;
      const mechanical = canonicalJson(leftBody as unknown as JsonValue) === canonicalJson(rightBody as unknown as JsonValue)
        ? "mechanical_duplicate"
        : left.rule.condition === right.rule.condition && left.rule.trigger === right.rule.trigger && left.rule.expected !== right.rule.expected
          ? "potential_conflict" : "unknown";
      pairs.push({ left, right, mechanical, declaredException: related.some((r) => r.kind === "exceptions"), relations: related,
        semanticStatus: "unknown", independentJudgmentRequired: true });
    }
  }
  const totalPairs = rules.length * (rules.length - 1) / 2, uncoveredPairs = totalPairs - pairs.length;
  return { status, fileHashes: checked.fileHashes, schemaHash: checked.schemaHash, contractSetHash: checked.contractSetHash,
    sources: sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((source) => ({ ...source, fileHash: checked.fileHashes[source.path]! })),
    rules, relations, singleResponsibility: rules.map((subject) => ({ subject, semanticStatus: "unknown", independentJudgmentRequired: true })), pairs,
    coverage: { totalRules: rules.length, totalPairs, includedPairs: pairs.length, uncoveredPairs, unknownPairs: totalPairs, ruleTextTruncated: false },
    blockers: [
      ...(rules.length ? [{ code: "single_responsibility_unreviewed" as const, count: rules.length }] : []),
      ...(totalPairs ? [{ code: "pair_semantics_unreviewed" as const, count: totalPairs }] : []),
      ...(uncoveredPairs ? [{ code: "pair_budget_exceeded" as const, count: uncoveredPairs }] : []),
    ] };
}

/**
 * 输入为调用方获准提供的完整当前集合及可选完整目标集合；pending不是补丁，不隐式覆盖/拼接当前文件。
 * 文件原字节和完整规则保留在事实包中。引用边只证明声明存在，不能证明例外范围或用户批准。
 * 本函数不检查磁盘当前性、不调用模型、不读索引/历史、不发布；消费者必须独立核验现场和权限。
 */
export function analyzeSpecSets(input: { context: SpecAnalysisContext; current: readonly SpecSource[]; pending?: readonly SpecSource[]; maxPairsPerSet?: number }): SpecAnalysis {
  const context = object(input.context, ["workspaceId", "generation", "asOf"]);
  text(context.workspaceId); text(context.generation); text(context.asOf);
  const maxPairs = input.maxPairsPerSet ?? SPEC_ANALYSIS_LIMITS.defaultPairsPerSet;
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 0 || maxPairs > SPEC_ANALYSIS_LIMITS.maxPairsPerSet) fail("invalid_budget", "规则对预算超出允许范围");
  const current = inspectSet(input.current, "current", maxPairs);
  const pending = input.pending === undefined ? null : { ...inspectSet(input.pending, "pending", maxPairs), baseContractSetHash: current.contractSetHash };
  const facts: Omit<AnalysisFacts, "analysisHash"> = { version: 1, context: { ...input.context }, provenance: "caller_supplied_snapshot", freshness: "not_rechecked",
    contentTrust: "untrusted_data_not_instructions", verification: "not_assessed", semanticStatus: "unknown", independentJudgmentRequired: true,
    publicationAllowed: false, limits: SPEC_ANALYSIS_LIMITS, current, pending };
  const result = { ...facts, analysisHash: digest(facts) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > SPEC_ANALYSIS_LIMITS.outputBytes) fail("output_budget_exceeded", "完整事实包超限，未输出截断正文或通过结论");
  return freeze(result);
}

export type SemanticConclusion = "single_responsibility" | "split_required" | "conflict" | "legal_exception" | "different_conditions" | "unknown";
type EvidenceField = "title" | "condition" | "trigger" | "expected" | "reason" | `acceptance.${number}.given` | `acceptance.${number}.when` | `acceptance.${number}.then`;
export interface SemanticReviewStatement {
  analysisHash: string;
  set: AnalysisSet;
  contractSetHash: string;
  kind: "single_responsibility" | "pair";
  rules: RuleIdentity[];
  conclusion: SemanticConclusion;
  reasoning: string;
  scenario: { given: string; when: string; outcomes: Array<{ ruleId: string; expected: string }> };
  evidence: Array<{ ruleId: string; field: EvidenceField; quote: string }>;
  uncertainties: string[];
  split: Array<{ behavior: string; given: string; when: string; then: string }>;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_statement", "必须是固定字段对象");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) fail("invalid_statement", "字段缺失或未知字段");
  return record;
}
function text(value: unknown, max = 1500): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) fail("invalid_statement", "必须是有界非空文字");
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("invalid_statement", "数组数量不合法");
  return value;
}
function evidenceText(rule: DeepReadonly<SpecRule>, field: string): string {
  if (["title", "condition", "trigger", "expected", "reason"].includes(field)) return rule[field as "title"];
  const match = /^acceptance\.(0|[1-5])\.(given|when|then)$/.exec(field);
  if (!match || !rule.acceptance[Number(match[1])]) fail("invalid_evidence", "引用字段不存在");
  return rule.acceptance[Number(match[1])]![match[2] as "given" | "when" | "then"];
}

/** 只验证JSON结构、真实引用和原文引证。条件可复现性、推理真值、独立性和批准均须另行判断。 */
export function validateSemanticReview(analysis: SpecAnalysis, raw: string): DeepReadonly<{
  structuralStatus: "valid";
  semanticStatus: "unverified_statement";
  authority: "none";
  independentJudgmentRequired: true;
  userDecisionRequired: boolean;
  blocking: true;
  publicationAllowed: false;
  statement: SemanticReviewStatement;
}> {
  if (Buffer.byteLength(raw, "utf8") > SPEC_ANALYSIS_LIMITS.conclusionBytes) fail("statement_budget_exceeded", "结论超限，不截断");
  const value = object(parseStrictJson(raw), ["analysisHash", "set", "contractSetHash", "kind", "rules", "conclusion", "reasoning", "scenario", "evidence", "uncertainties", "split"]);
  if (value.analysisHash !== analysis.analysisHash || (value.set !== "current" && value.set !== "pending")) fail("stale_statement", "分析集合不匹配");
  const set = value.set === "current" ? analysis.current : analysis.pending;
  if (!set || set.contractSetHash !== value.contractSetHash) fail("stale_statement", "规则集合不匹配");
  if (value.kind !== "single_responsibility" && value.kind !== "pair") fail("invalid_statement", "审查类型未知");
  const arity = value.kind === "pair" ? 2 : 1;
  const subjects = list(value.rules, arity, arity).map((item) => {
    const ref = object(item, ["id", "path", "fileHash", "contractHash"]);
    const fact = set.rules.find((rule) => rule.id === ref.id);
    if (!fact || Object.entries(identity(fact)).some(([key, expected]) => ref[key] !== expected)) fail("stale_statement", "规则ID、路径或hash不匹配");
    return fact;
  });
  if (new Set(subjects.map((s) => s.id)).size !== arity) fail("invalid_statement", "重复审查对象");
  if (arity === 2 && !set.pairs.some((p) => subjects.some((s) => s.id === p.left.id) && subjects.some((s) => s.id === p.right.id))) fail("uncovered_pair", "规则对未纳入事实包，需扩大预算重新审查");
  const allowed = arity === 1 ? ["single_responsibility", "split_required", "unknown"] : ["conflict", "legal_exception", "different_conditions", "unknown"];
  if (!allowed.includes(value.conclusion as string)) fail("invalid_statement", "结论与审查类型不匹配");
  text(value.reasoning);
  const scenario = object(value.scenario, ["given", "when", "outcomes"]);
  text(scenario.given); text(scenario.when);
  const outcomes = list(scenario.outcomes, arity, arity).map((item) => {
    const outcome = object(item, ["ruleId", "expected"]);
    const rule = subjects.find((s) => s.id === outcome.ruleId);
    if (!rule || outcome.expected !== rule.rule.expected) fail("invalid_evidence", "场景必须列出每条规则完整的声明结果，不以推测替换");
    return rule.id;
  });
  if (new Set(outcomes).size !== arity) fail("invalid_evidence", "场景缺少另一方结果");
  const evidence = list(value.evidence, arity, 24).map((item) => {
    const quote = object(item, ["ruleId", "field", "quote"]);
    text(quote.field, 64); text(quote.quote);
    const rule = subjects.find((s) => s.id === quote.ruleId);
    if (!rule || !evidenceText(rule.rule, quote.field).includes(quote.quote)) fail("invalid_evidence", "依据不是所引用字段的原文");
    return rule.id;
  });
  if (subjects.some((s) => !evidence.includes(s.id))) fail("invalid_evidence", "每方均须原文依据");
  const uncertainties = list(value.uncertainties, value.conclusion === "unknown" ? 1 : 0, 12);
  uncertainties.forEach((item) => text(item));
  if (value.conclusion !== "unknown" && uncertainties.length) fail("invalid_statement", "存在未决条件时应标unknown");
  if (value.conclusion === "legal_exception" && !set.relations.some((r) => r.kind === "exceptions" && subjects.some((s) => s.id === r.from.id) && subjects.some((s) => s.id === r.to.id))) fail("invalid_statement", "缺少已定义例外引用，须明确疑点");
  const split = list(value.split, value.conclusion === "split_required" ? 2 : 0, value.conclusion === "split_required" ? 6 : 0);
  split.forEach((item) => {
    const part = object(item, ["behavior", "given", "when", "then"]);
    Object.values(part).forEach((field) => text(field));
  });
  if (new Set(split.map((part) => (part as Record<string, unknown>).behavior)).size !== split.length) fail("invalid_statement", "拆分行为不能重复");
  return freeze({ structuralStatus: "valid", semanticStatus: "unverified_statement", authority: "none", independentJudgmentRequired: true,
    userDecisionRequired: ["conflict", "legal_exception", "split_required", "unknown"].includes(value.conclusion as string), blocking: true,
    publicationAllowed: false, statement: value as unknown as SemanticReviewStatement });
}
