import { Type } from "typebox";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { StoredRecord } from "./database.ts";
import { evaluateIntakeContinuity, PmUnderstandingSchema } from "./pm-intake-contracts.ts";
import type { IntakeBinding, IntakeReviewRecord, IntakeSourceDirectory, PmUnderstanding } from "./pm-intake-contracts.ts";
import { pmUnderstandingHash } from "./pm-intake-service.ts";
import type { PmSourceDirectoryHandle, PmSourceDirectoryProvider, PmSourceDirectoryQuery, PmSubmissionHandle, PmSubmissionProvider,
  PmSubmissionQuery } from "./pm-intake-service.ts";
import { intakeManifestDecisionIds, PmIntakeStore } from "./pm-intake-store.ts";
import type { IntakeBindingBasis } from "./pm-intake-store.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import { readSessionEntries } from "./session-records.ts";
import { checkDecisionRecord } from "./short-decision-format.ts";

export const PM_INTAKE_TOOL = "pi_company_user_interact";
export const PM_UNDERSTANDING_CONTENT = Type.Omit(PmUnderstandingSchema, ["format", "binding"]);
export const PM_INTAKE_SUBMIT_PARAMETERS = Type.Object({
  action: Type.Literal("ask"), purpose: Type.Literal("pm-intake"), understanding: PM_UNDERSTANDING_CONTENT,
}, { additionalProperties: false });

type Ref = { dataRoot: string; repoId: string };
export interface IntakeSubmissionBaseline { approvedRevision: number; approvedProdHash: string; approvalManifestHash: string }
type UnderstandingContent = Omit<PmUnderstanding, "format" | "binding">;

/** PM 最近一次被工具成功受理、且受理时批准基线与给定基线一致的接手理解；正文只在该运行的私有会话文件里。 */
export function latestPmSubmission(ref: Ref & { runId: string; baseline: IntakeSubmissionBaseline }): { toolCallId: string; content: UnderstandingContent } | null {
  const read = readSessionEntries(ref);
  if (!read.ok) return null;
  const calls = new Map<string, UnderstandingContent>();
  let latest: { toolCallId: string; content: UnderstandingContent } | null = null;
  for (const entry of read.entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        const args = block.type === "toolCall" ? block.arguments as { purpose?: unknown; understanding?: unknown } : undefined;
        if (block.type === "toolCall" && block.name === PM_INTAKE_TOOL && args?.purpose === "pm-intake") calls.set(block.id, args.understanding as UnderstandingContent);
      }
    } else if (message.role === "toolResult" && !message.isError && calls.has(message.toolCallId)
      && sameBaseline((message.details as { intakeBaseline?: IntakeSubmissionBaseline } | undefined)?.intakeBaseline, ref.baseline)) {
      latest = { toolCallId: message.toolCallId, content: calls.get(message.toolCallId)! };
    }
  }
  return latest;
}

function sameBaseline(value: IntakeSubmissionBaseline | undefined, expected: IntakeSubmissionBaseline): boolean {
  return value?.approvedRevision === expected.approvedRevision && value.approvedProdHash === expected.approvedProdHash
    && value.approvalManifestHash === expected.approvalManifestHash;
}

export function pmSubmissionFor(ref: Ref, binding: IntakeBinding): { submissionRef: string; submissionHash: string; understanding: PmUnderstanding } | null {
  const latest = latestPmSubmission({ ...ref, runId: binding.pmRunId, baseline: { approvedRevision: binding.approvedRevision,
    approvedProdHash: binding.approvedProdHash, approvalManifestHash: binding.approvalManifestHash } });
  if (!latest) return null;
  const understanding = { format: "pm-understanding/v1" as const, binding: structuredClone(binding), ...structuredClone(latest.content) };
  return { submissionRef: `pm/${binding.pmRunId}/${latest.toolCallId}`, submissionHash: pmUnderstandingHash(understanding), understanding };
}

function requirementRow(ref: Ref, requirementId: string): StoredRecord<RequirementRecord> {
  const row = withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.read<RequirementRecord>("requirements", requirementId));
  if (!row) throw new Error("unknown_requirement");
  return row;
}

function scenarioIdsFor(ref: Ref, query: Pick<PmSourceDirectoryQuery, "baseline" | "stableSectionIds" | "manifestUnitIds">): string[] {
  const confirmed = requirementRow(ref, query.baseline.requirementId).data.approvalManifest?.confirmed ?? [];
  return confirmed.filter((id) => query.stableSectionIds.includes(id) && query.manifestUnitIds.includes(id));
}

function questionIdsFor(ref: Ref, requirementId: string): string[] {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.list("interaction_questions_v1")
    .filter((row) => (row.data as { basis?: { requirementId?: unknown } } | null)?.basis?.requirementId === requirementId).map((row) => row.id)).sort();
}

/**
 * PM 接手可引用的出处清单，与主代理核对时的清单同源：场景取批准清单中已确认、带稳定编号的单位
 * （全部标题都带编号时分区单位即稳定编号，metadata/preamble/whole-body 不是场景）。
 */
export function pmSourceDirectory(ref: Ref, requirementId: string): IntakeSourceDirectory | null {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const row = db.read<RequirementRecord>("requirements", requirementId);
    if (!row?.data.approvalManifest) return null;
    const manifest = registeredApprovalManifestIn(db, ref.repoId, row.data.approvalManifest.reference, row);
    const unitIds = manifest.units.map((unit) => unit.id);
    const scenarioIds = (row.data.approvalManifest.confirmed ?? []).filter((id) => unitIds.includes(id) && !["metadata", "preamble", "whole-body"].includes(id));
    const questionIds = db.list("interaction_questions_v1")
      .filter((q) => (q.data as { basis?: { requirementId?: unknown } } | null)?.basis?.requirementId === requirementId).map((q) => q.id).sort();
    return { prodUnitIds: unitIds, prodScenarioIds: scenarioIds, decisionIds: intakeManifestDecisionIds(manifest), questionIds, requiredScenarioIds: scenarioIds };
  });
}

export interface PmDecisionNote { id: string; status: string; unitIds: string[]; conclusion: string }

/** 出处清单里每个决定的状态、涉及单位与结论原文；只供 PM 与主代理核对决定内容，不参与授权。 */
export function pmDecisionNotes(ref: Ref, requirementId: string): PmDecisionNote[] {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const row = db.read<RequirementRecord>("requirements", requirementId);
    if (!row?.data.approvalManifest) return [];
    const manifest = registeredApprovalManifestIn(db, ref.repoId, row.data.approvalManifest.reference, row);
    return intakeManifestDecisionIds(manifest).map((id) => {
      const decision = checkDecisionRecord(db.read("short_decisions", id)?.data);
      const unitIds = [...manifest.units.filter((unit) => unit.decisionIds.includes(id)).map((unit) => unit.id),
        ...manifest.actions.filter((action) => action.decisionIds.includes(id)).flatMap((action) => action.goalIds),
        ...(manifest.retainedSources ?? []).filter((source) => source.decision.id === id).map((source) => source.unitId)];
      return { id, status: decision.status, unitIds: [...new Set(unitIds)], conclusion: decision.conclusion };
    });
  });
}

/** 主代理接手核对的两个数据提供方：场景清单取批准清单的已确认条目，理解取 PM 私有会话里最近一次受理的提交。 */
export function createPmIntakeProviders(dataRoot: string): { sourceDirectoryProvider: PmSourceDirectoryProvider; submissionProvider: PmSubmissionProvider } {
  const sources = new WeakMap<object, string>();
  const submissions = new WeakMap<object, string>();
  const sourceKey = (query: Pick<PmSourceDirectoryQuery, "baseline" | "stableSectionIds" | "manifestUnitIds">) => {
    const ref = { dataRoot, repoId: query.baseline.repoId };
    return JSON.stringify([scenarioIdsFor(ref, query), questionIdsFor(ref, query.baseline.requirementId)]);
  };
  return {
    sourceDirectoryProvider: {
      async loadCurrent(query) {
        const ref = { dataRoot, repoId: query.baseline.repoId };
        const handle: PmSourceDirectoryHandle = Object.freeze({ kind: "pm-source-directory-handle" });
        sources.set(handle, sourceKey(query));
        return { handle, scenarioIds: scenarioIdsFor(ref, query), questionIds: questionIdsFor(ref, query.baseline.requirementId) };
      },
      assertCurrent(handle, query) {
        if (sources.get(handle) !== sourceKey(query)) throw new Error("source_directory_changed");
      },
    },
    submissionProvider: {
      async loadCurrent(query: Readonly<PmSubmissionQuery>) {
        const submission = pmSubmissionFor({ dataRoot, repoId: query.binding.repoId }, query.binding);
        if (!submission) return null;
        const handle: PmSubmissionHandle = Object.freeze({ kind: "pm-submission-handle" });
        submissions.set(handle, submission.submissionHash);
        return { handle, ...submission };
      },
      assertCurrent(handle, query) {
        if (submissions.get(handle) !== pmSubmissionFor({ dataRoot, repoId: query.binding.repoId }, query.binding)?.submissionHash) throw new Error("submission_changed");
      },
    },
  };
}

export type IntakeGateResult = { allowed: true } | { allowed: false; reasons: string[] };

/**
 * 正式规划与 worker 派工的强门槛：接手核对须通过、仍对应本 PM 租约与当前批准绑定，且批准清单含实施授权。
 * 批准版本前进时，要求核对后的每个版本都被本 PM 做出、不含 unknown 的影响复核覆盖；复核须先按序收到差异，较新版本的复核覆盖其前的连续版本。
 * 只读现有记录并调用 M4 连续性判定，不签发任何权限。
 */
export function evaluatePmIntakeGate(ref: Ref & { lease: PmLease; now?: number }): IntakeGateResult {
  const now = ref.now ?? Date.now();
  const store = new PmIntakeStore({ dataRoot: ref.dataRoot, repoId: ref.repoId });
  const row = requirementRow(ref, ref.lease.requirementId), record = row.data;
  const head = store.readHead(ref.lease.requirementId);
  if (!head) return { allowed: false, reasons: ["review_missing"] };
  if (!record.approved || !record.workspace || !record.approvalManifest) return { allowed: false, reasons: ["requirement_not_ready"] };
  if (!implementAuthorized(ref, row)) return { allowed: false, reasons: ["action_authorization_not_reported_current"] };
  const review = head.review;
  if (review && record.revision > review.binding.approvedRevision) return advancedGate(ref, record, review, now);
  const basis: IntakeBindingBasis = {
    repoId: ref.repoId, requirementId: record.requirementId, approvedProdCommit: record.approved.commit, approvedRevision: record.revision,
    approvedProdHash: record.approved.hash, approvalManifestHash: record.approvalManifest.reference.manifestHash,
    workspaceId: record.workspace.workspaceId, workspaceRef: record.workspace.branch, epoch: record.epoch,
    pmRunId: ref.lease.runId, pmFence: ref.lease.fence, contextGeneration: ref.lease.contextGeneration,
  };
  let binding: IntakeBinding;
  try { binding = store.captureCurrent(basis, head.directory).binding; }
  catch (error) { return { allowed: false, reasons: [(error as { code?: string }).code ?? "binding_not_current"] }; }
  const owner = withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.read<{ lease?: PmLease }>("pm_ownership", ref.lease.requirementId)?.data);
  const submission = pmSubmissionFor(ref, binding);
  const historical: Array<{ binding: IntakeBinding; sourceDirectory: IntakeSourceDirectory }> = review && JSON.stringify(review.binding) !== JSON.stringify(binding)
    ? [{ binding: review.binding, sourceDirectory: head.directory }] : [];
  const evaluation = evaluateIntakeContinuity({
    format: "pm-intake-continuity-facts/v1",
    currentBinding: binding,
    currentState: { lifecycle: record.lifecycle, requirementRecordVersion: row.version, leaseExpiresAt: owner?.lease?.expiresAt ?? 0, observedAt: now,
      actionAuthorizationReportedCurrent: true, sourceDirectoryReportedCurrent: true, pendingApprovedUpdate: record.pendingRevision !== null },
    sourceDirectory: head.directory,
    historicalSourceDirectories: historical,
    rootReview: review,
    understandingBaseline: submission ? { submissionRef: submission.submissionRef, submissionHash: submission.submissionHash } : null,
    rootEventSequence: 0,
    impactLinks: [],
    completeTaskSets: [],
  });
  return evaluation.contractReady ? { allowed: true } : { allowed: false, reasons: [...evaluation.reasons] };
}

function advancedGate(ref: Ref & { lease: PmLease }, record: RequirementRecord, review: IntakeReviewRecord, now: number): IntakeGateResult {
  const reasons: string[] = [];
  const binding = review.binding;
  if (review.result !== "passed") reasons.push(review.result);
  if (record.lifecycle !== "active") reasons.push("requirement_not_active");
  if (record.pendingRevision !== null) reasons.push("pending_approved_update");
  if (binding.pmRunId !== ref.lease.runId || binding.pmFence !== ref.lease.fence || binding.contextGeneration !== ref.lease.contextGeneration) reasons.push("new_pm_fence");
  if (binding.epoch !== record.epoch) reasons.push("epoch_changed");
  if (binding.workspaceId !== record.workspace!.workspaceId || binding.workspaceRef !== record.workspace!.branch) reasons.push("workspace_changed");
  const submission = pmSubmissionFor(ref, binding);
  if (!submission || submission.submissionRef !== review.submissionRef || submission.submissionHash !== review.submissionHash) reasons.push("understanding_baseline_mismatch");
  const { owner, assessments } = withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => ({
    owner: db.read<{ lease?: PmLease }>("pm_ownership", ref.lease.requirementId)?.data,
    assessments: db.list<{ requirementId?: string; toRevision?: number; unknown?: number; runId?: string; fence?: number }>("impact_assessments")
      .map((entry) => entry.data).filter((entry) => entry.requirementId === ref.lease.requirementId),
  }));
  if (owner?.lease?.runId !== ref.lease.runId || owner.lease.fence !== ref.lease.fence || owner.lease.expiresAt <= now) reasons.push("lease_not_current");
  for (let revision = binding.approvedRevision + 1; revision <= record.revision; revision++) {
    const covered = assessments.some((entry) => entry.toRevision! >= revision && entry.unknown === 0 && entry.runId === ref.lease.runId && entry.fence === ref.lease.fence);
    if (!covered) { reasons.push("impact_link_gap"); break; }
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true };
}

/** 批准清单是否含已确认的实施授权；派出 PM 与 PM 内的正式规划、派工都以它为准。 */
export function implementAuthorized(ref: Ref, row: StoredRecord<RequirementRecord>): boolean {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() =>
    registeredApprovalManifestIn(db, ref.repoId, row.data.approvalManifest!.reference, row).actions.some((entry) => entry.action === "implement" && !entry.unknown)));
}
