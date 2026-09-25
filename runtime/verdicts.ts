import { Type } from "typebox";
import type { Static } from "typebox";
import { readCheckRoundIn, readVerificationIn } from "./check-round.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { checked, counter, hash, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";

export const VERDICTS = "verdicts";
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const Finding = object({
  kind: Type.Union([Type.Literal("blocking"), Type.Literal("suggestion"), Type.Literal("unverified")]),
  targetRef: text(256), evidenceRef: Type.Union([text(256), Type.Null()]), trigger: text(1024), impact: text(1024),
});
export type Finding = Static<typeof Finding>;
export const VERDICT_PAYLOAD = object({
  checkRoundId: Type.Union([id, Type.Null()]), verificationIds: Type.Array(id, { maxItems: 64 }),
  summary: text(2048), findings: Type.Array(Finding, { maxItems: 256 }),
});
export type VerdictPayload = Static<typeof VERDICT_PAYLOAD>;
export const Verdict = object({
  format: Type.Literal("verdict/v1"), verdictId: id, requirementId: id, repoId: hash, workspaceId: hash, epoch: positive, runId: id, parentRunId: Type.String({ minLength: 1, maxLength: 256 }),
  role: Type.Union([Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("qa")]),
  checkRoundId: Type.Union([id, Type.Null()]), review: Type.Union([object({ taskId: id, attemptRunId: id }), Type.Null()]),
  verificationIds: Type.Array(id), summary: text(2048), findings: Type.Array(Finding),
  conclusion: Type.Union([Type.Literal("clear"), Type.Literal("blocked"), Type.Literal("unverified")]), createdAt: counter,
});
export type Verdict = Static<typeof Verdict>;
export interface VerdictBinding {
  dataRoot: string; requirementId: string; repoId: string; workspaceId: string; epoch: number;
  /** reviewer 运行由派工服务绑定被审任务及其尝试；缺失时 reviewer 不能提交裁决。 */
  review?: { taskId: string; attemptRunId: string };
}
export type VerdictErrorCode = "invalid_shape" | "invalid_binding" | "out_of_scope";
export class VerdictError extends Error {
  readonly code: VerdictErrorCode;
  constructor(code: VerdictErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "VerdictError"; this.code = code; }
}

/** 结论只由程序按分级计算：任一阻塞项即 blocked，仅有未验证项即 unverified，其余为 clear；建议项不影响结论。 */
export function conclusionOf(findings: readonly Finding[]): Verdict["conclusion"] {
  if (findings.some((finding) => finding.kind === "blocking")) return "blocked";
  if (findings.some((finding) => finding.kind === "unverified")) return "unverified";
  return "clear";
}

export function readVerdictsIn(db: LocalDatabase, repoId: string, requirementId: string): Verdict[] {
  return db.list<unknown>(VERDICTS).map((row) => checked(Verdict, row.data)).filter((verdict) => verdict.repoId === repoId && verdict.requirementId === requirementId);
}

/**
 * worker 与 reviewer 的裁决只能引用自己的 debug 结果且不绑定检查轮，reviewer 的裁决绑定派工时被审的任务尝试；QA 的裁决必须绑定检查轮并只引用该轮的正式结果。
 * 记录不接受 PASS 之类的自填结论字段，也不能改写已存在的裁决。
 */
export function submitVerdict(binding: VerdictBinding, grant: { role: "worker" | "reviewer" | "qa"; runId: string; parentRunId: string }, input: unknown): Verdict {
  let payload: VerdictPayload;
  try { payload = checked(VERDICT_PAYLOAD, input); } catch { throw new VerdictError("invalid_shape"); }
  if (new Set(payload.verificationIds).size !== payload.verificationIds.length) throw new VerdictError("invalid_shape", "重复的验证引用");
  return withDatabase(repositoryDatabase(binding.dataRoot, binding.repoId), (db) => db.transaction(() => {
    const record = db.read<RequirementRecord>("requirements", binding.requirementId)?.data;
    if (!record || record.repoId !== binding.repoId || record.lifecycle !== "active" || record.recovery !== "ready" || record.epoch !== binding.epoch ||
      record.workspace?.workspaceId !== binding.workspaceId) throw new VerdictError("invalid_binding");
    const ownDebug = grant.role !== "qa";
    if (grant.role === "reviewer" && !binding.review) throw new VerdictError("invalid_binding", "reviewer 没有绑定被审任务");
    if (ownDebug) {
      if (payload.checkRoundId !== null) throw new VerdictError("out_of_scope", `${grant.role} 不能绑定检查轮`);
    } else {
      if (payload.checkRoundId === null) throw new VerdictError("out_of_scope", "独立裁决必须绑定检查轮");
      if (payload.verificationIds.length === 0) throw new VerdictError("out_of_scope", "独立裁决必须引用该轮的正式结果");
      const round = readCheckRoundIn(db, payload.checkRoundId);
      if (!round || round.data.repoId !== binding.repoId || round.data.requirementId !== binding.requirementId || round.data.epoch !== binding.epoch) throw new VerdictError("invalid_binding");
      if (round.data.runId === grant.runId) throw new VerdictError("out_of_scope", "PM 自身不能充当独立裁决");
    }
    for (const verificationId of payload.verificationIds) {
      const run = readVerificationIn(db, verificationId)?.data;
      if (!run || run.repoId !== binding.repoId || run.requirementId !== binding.requirementId || run.epoch !== binding.epoch) throw new VerdictError("invalid_binding", verificationId);
      if (ownDebug ? (run.kind !== "debug" || run.runId !== grant.runId) : (run.kind !== "formal" || run.checkRoundId !== payload.checkRoundId)) {
        throw new VerdictError("out_of_scope", verificationId);
      }
    }
    const verdict = checked(Verdict, { format: "verdict/v1", verdictId: uuidv7(), requirementId: binding.requirementId, repoId: binding.repoId, workspaceId: binding.workspaceId,
      epoch: binding.epoch, runId: grant.runId, parentRunId: grant.parentRunId, role: grant.role, checkRoundId: payload.checkRoundId,
      review: grant.role === "reviewer" ? { ...binding.review! } : null, verificationIds: payload.verificationIds,
      summary: payload.summary, findings: payload.findings, conclusion: conclusionOf(payload.findings), createdAt: Date.now() });
    db.create(VERDICTS, verdict.verdictId, verdict, verdict.verdictId);
    return verdict;
  }));
}
