import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { canonicalJson, parseStrictJson } from "./strict-json.ts";
import type { JsonValue } from "./strict-json.ts";

interface Acceptance { id: string; given: string; when: string; then: string }
export interface SpecRule {
  id: string; title: string; condition: string; trigger: string; expected: string; reason: string;
  dependsOn: string[]; exceptions: string[]; acceptance: Acceptance[];
}
export interface SpecDocument {
  $schema?: string;
  schemaVersion: 1;
  feature: { id: string; title: string; aliases: string[] };
  rules: SpecRule[];
}
export interface SpecSource { path: string; content: string }
export interface CheckedRule { path: string; rule: SpecRule; codepoints: number; contractHash: string }
export interface CheckedSpecSet {
  fileHashes: Record<string, string>;
  rules: CheckedRule[];
  contractSetHash: string;
  schemaHash: string;
  semanticReview: { required: true; ruleIds: string[]; conflictCandidates: Array<{ left: string; right: string }> };
}
export class SpecFormatError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(`规则检查失败：${code}，${detail}`); this.name = "SpecFormatError"; this.code = code; }
}
const schema = parseStrictJson(readFileSync(new URL("../resources/spec/schema.json", import.meta.url), "utf8"));
const RULE_CODEPOINT_LIMIT = 1500;
if ((schema as Record<string, JsonValue>)["x-maxRuleCodepoints"] !== RULE_CODEPOINT_LIMIT) throw new SpecFormatError("invalid_schema", "规则码点门槛必须与批准协议一致");
const hash = (bytes: string) => createHash("sha256").update(bytes, "utf8").digest("hex");
const schemaHash = hash(canonicalJson(schema));
const jsonValue = (value: SpecDocument | SpecRule | SpecDocument["feature"]): JsonValue => value as unknown as JsonValue;
const points = (text: string) => Array.from(text).length;

function rulePoints(document: SpecDocument, rule: SpecRule): number {
  return [document.feature.title, ...document.feature.aliases, rule.title, rule.condition, rule.trigger, rule.expected, rule.reason,
    ...rule.acceptance.flatMap((scenario) => [scenario.given, scenario.when, scenario.then])].reduce((sum, text) => sum + points(text), 0);
}

/** 校验调用方已授权提供的当前文件集合；不读历史、不写文件或索引，不自动裁决单一职责。 */
export function checkSpecSet(sources: SpecSource[]): CheckedSpecSet {
  const fileHashes = Object.create(null) as Record<string, string>;
  const entries = new Map<string, { source: SpecSource; document: SpecDocument; rule: SpecRule; codepoints: number }>();
  for (const source of sources) {
    if (!source.path.startsWith("docs/spec/") || !source.path.endsWith(".rules.json") || source.path.includes("\\") || source.path.includes("\0") || posix.normalize(source.path) !== source.path) {
      throw new SpecFormatError("invalid_path", "仅接受docs/spec下的当前.rules.json文件");
    }
    if (Object.hasOwn(fileHashes, source.path)) throw new SpecFormatError("duplicate_path", source.path);
    const parsed = parseStrictJson(source.content);
    if (!Value.Check(schema as TSchema, parsed)) throw new SpecFormatError("invalid_schema", source.path);
    const document = parsed as unknown as SpecDocument;
    if (document.$schema !== undefined && posix.normalize(posix.join(posix.dirname(source.path), document.$schema)) !== "docs/spec/schema.json") {
      throw new SpecFormatError("invalid_schema_target", `${source.path}的$schema必须指向docs/spec/schema.json`);
    }
    fileHashes[source.path] = hash(source.content);
    for (const rule of document.rules) {
      if (entries.has(rule.id)) throw new SpecFormatError("duplicate_id", rule.id);
      const codepoints = rulePoints(document, rule);
      if (codepoints > RULE_CODEPOINT_LIMIT) throw new SpecFormatError("split_required", `${rule.id}包含${codepoints}码点，上限1500；不得截断正文`);
      if (new Set(rule.acceptance.map((scenario) => scenario.id)).size !== rule.acceptance.length) throw new SpecFormatError("duplicate_scenario", rule.id);
      entries.set(rule.id, { source, document, rule, codepoints });
    }
  }
  const rules: CheckedRule[] = [];
  const hashes = new Map<string, string>();
  const references = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const [id, entry] of entries) {
    const refs = [...new Set([...entry.rule.dependsOn, ...entry.rule.exceptions])].sort();
    references.set(id, refs); pending.set(id, refs.length);
    for (const ref of refs) {
      if (!entries.has(ref)) throw new SpecFormatError("missing_reference", ref);
      const children = dependents.get(ref) ?? []; children.push(id); dependents.set(ref, children);
    }
  }
  const ready = [...entries.keys()].filter((id) => pending.get(id) === 0).sort();
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!, entry = entries.get(id)!;
    const dependencies = references.get(id)!.map((ref) => [ref, hashes.get(ref)!]);
    hashes.set(id, hash(canonicalJson({ schemaHash, schemaVersion: 1, feature: jsonValue(entry.document.feature), rule: jsonValue(entry.rule), dependencies })));
    for (const child of dependents.get(id) ?? []) {
      pending.set(child, pending.get(child)! - 1);
      if (pending.get(child) === 0) ready.push(child);
    }
  }
  if (hashes.size !== entries.size) throw new SpecFormatError("reference_cycle", [...entries.keys()].find((id) => !hashes.has(id))!);
  for (const id of [...entries.keys()].sort()) {
    const entry = entries.get(id)!;
    rules.push({ path: entry.source.path, rule: entry.rule, codepoints: entry.codepoints, contractHash: hashes.get(id)! });
  }
  const conflictCandidates: Array<{ left: string; right: string }> = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!, b = rules[j]!;
      if (entries.get(a.rule.id)!.document.feature.id === entries.get(b.rule.id)!.document.feature.id && a.rule.condition === b.rule.condition && a.rule.trigger === b.rule.trigger && a.rule.expected !== b.rule.expected) {
        conflictCandidates.push({ left: a.rule.id, right: b.rule.id });
      }
    }
  }
  return { fileHashes, rules, schemaHash, contractSetHash: hash(canonicalJson({ schemaHash, rules: rules.map((entry) => [entry.rule.id, entry.contractHash]) })),
    semanticReview: { required: true, ruleIds: rules.map((entry) => entry.rule.id), conflictCandidates } };
}
