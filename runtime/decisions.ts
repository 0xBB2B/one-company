import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { repoDataDir, repositoryIdentity, requirementDataDir } from "./identity.ts";
import { appendLine, readLines, withDirLock } from "./store.ts";

export type DecisionActor = "ai" | "user";

export interface AppendDecisionOptions {
  dataRoot: string;
  cwd: string;
}

export interface ReadDecisionsOptions {
  dataRoot: string;
  cwd: string;
  requirement: string;
  actor: DecisionActor;
}

export interface InspectDecisionOptions {
  dataRoot: string;
  cwd: string;
  requirement: string;
  id: string;
}

export interface DecisionReceipt {
  schema: "decision-receipt/v1";
  receiptId: string;
  decisionId: string;
  actor: DecisionActor;
  repoId: string;
  requirement: string;
  ledgerPath: string;
  lineNumber: number;
  decisionHash: string;
  recordedAt: string;
}

const REQUIRED_STRING_FIELDS = ["requirement", "source", "trigger", "decision"] as const;
const AI_REQUIRED_FIELDS = ["scope", "basis", "action"] as const;
const USER_FORBIDDEN_FIELDS = ["scope", "basis", "action"] as const;
const LEDGER_FILE: Record<DecisionActor, string> = { ai: "ai-decisions.jsonl", user: "user-decisions.jsonl" };
const ID_PREFIX: Record<DecisionActor, string> = { ai: "AI", user: "USER" };

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function validateDecisionInput(input: Record<string, unknown>): void {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (isMissing(input[field])) throw new Error(`缺少必需字段: ${field}`);
  }
  if (!Array.isArray(input.effects) || input.effects.length === 0) {
    throw new Error("缺少必需字段: effects");
  }
  if (!Array.isArray(input.alternatives)) throw new Error("缺少必需字段: alternatives");
  const actor = input.actor;
  if (actor === "ai") {
    if (AI_REQUIRED_FIELDS.some((field) => isMissing(input[field]))) {
      throw new Error("AI 决定必须同时提供 scope、basis、action");
    }
    if (isPresent(input.impact)) throw new Error("AI 决定不得携带 impact");
    return;
  }
  if (actor === "user") {
    const forbidden = USER_FORBIDDEN_FIELDS.find((field) => isPresent(input[field]));
    if (forbidden) throw new Error(`用户决定不得携带 ${forbidden}`);
    if (isMissing(input.impact)) throw new Error("用户决定必须提供 impact");
    return;
  }
  throw new Error(`未知的 actor: ${String(actor)}`);
}

export function nextDecisionId(existingIds: string[], actor: DecisionActor): string {
  const prefix = ID_PREFIX[actor];
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function buildRecord(input: Record<string, unknown>, meta: { id: string; recordedAt: string }): Record<string, unknown> {
  const base = {
    id: meta.id,
    recordedAt: meta.recordedAt,
    actor: input.actor,
    source: input.source,
    requirement: input.requirement,
    trigger: input.trigger,
    decision: input.decision,
    effects: input.effects,
  };
  const record: Record<string, unknown> =
    input.actor === "ai"
      ? { ...base, scope: input.scope, basis: input.basis, alternatives: input.alternatives, action: input.action }
      : { ...base, alternatives: input.alternatives, impact: input.impact };
  if (isPresent(input.supersedes)) record.supersedes = input.supersedes;
  return record;
}

export async function appendDecision(input: Record<string, unknown>, options: AppendDecisionOptions): Promise<DecisionReceipt> {
  validateDecisionInput(input);
  const actor = input.actor as DecisionActor;
  const requirement = input.requirement as string;
  const identity = await repositoryIdentity(options.cwd);
  await repoDataDir(options.dataRoot, identity.repoId, identity.commonDir);
  const dir = requirementDataDir(options.dataRoot, identity.repoId, requirement);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  return withDirLock(dir, async () => {
    const aiPath = join(dir, LEDGER_FILE.ai);
    const userPath = join(dir, LEDGER_FILE.user);
    const [aiRecords, userRecords] = await Promise.all([readLines(aiPath), readLines(userPath)]);

    const supersedes = input.supersedes as string[] | null | undefined;
    if (isPresent(supersedes) && (supersedes as string[]).length > 0) {
      const targets = supersedes as string[];
      if (new Set(targets).size !== targets.length) throw new Error("supersedes 含重复编号");
      const existingIds = new Set([...aiRecords, ...userRecords].map((record) => (record as { id: string }).id));
      for (const target of targets) {
        if (!existingIds.has(target)) throw new Error(`supersedes 指向不存在的决定: ${target}`);
      }
    }

    const ownRecords = actor === "ai" ? aiRecords : userRecords;
    const ownIds = ownRecords.map((record) => (record as { id: string }).id);
    const id = nextDecisionId(ownIds, actor);
    const recordedAt = new Date().toISOString();
    const record = buildRecord(input, { id, recordedAt });

    const ledgerPath = actor === "ai" ? aiPath : userPath;
    const { lineNumber, line } = await appendLine(ledgerPath, record);
    const decisionHash = createHash("sha256").update(line).digest("hex");

    return {
      schema: "decision-receipt/v1",
      receiptId: randomUUID(),
      decisionId: id,
      actor,
      repoId: identity.repoId,
      requirement,
      ledgerPath,
      lineNumber,
      decisionHash,
      recordedAt,
    };
  });
}

export async function readDecisions(options: ReadDecisionsOptions): Promise<unknown[]> {
  const identity = await repositoryIdentity(options.cwd);
  const dir = requirementDataDir(options.dataRoot, identity.repoId, options.requirement);
  return readLines(join(dir, LEDGER_FILE[options.actor]));
}

export async function inspectDecision(options: InspectDecisionOptions): Promise<unknown | null> {
  const actor: DecisionActor = options.id.startsWith("USER-") ? "user" : "ai";
  const records = await readDecisions({ dataRoot: options.dataRoot, cwd: options.cwd, requirement: options.requirement, actor });
  return records.find((record) => (record as { id?: string }).id === options.id) ?? null;
}
