import { ApprovalManifestStore } from "../../src/modules/requirement/approval-manifest-store.ts";
import { approvalManifestReference } from "../../src/modules/requirement/approval-manifest.ts";
import type { ApprovalManifestReference } from "../../src/modules/requirement/approval-manifest.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";
import { loadInteractionContinuity } from "../../src/modules/requirement/interaction-continuity.ts";
import type { RequirementDocSpec } from "../../src/modules/requirement/requirement-doc.ts";
import type { ConfirmUpdateInput, RequirementReceipt } from "../../src/modules/requirement/requirement-manage-contracts.ts";
import { RequirementService } from "../../src/modules/requirement/requirement-service.ts";
import { decisionDigest } from "../../src/modules/requirement/short-decision-format.ts";
import type { InteractionContext } from "../../src/modules/requirement/user-interaction-format.ts";
import { UserInteractionCore } from "../../src/modules/interaction/user-interaction.ts";

export interface ApprovalConfig { repositoryRoot: string; dataRoot: string; repoId: string }
export interface ManifestApprovalRequest {
  requirementId: string;
  /** 当前保存版本对应的 create/updateDraft 操作编号。 */
  savedOperationId: string;
  operationId?: string;
  /** 默认 true：除 metadata 外的段落都作为实施目标，带一个 implement 动作。 */
  implement?: boolean;
}

/**
 * 按真实交互核心确认整份当前保存版本并登记批准清单，返回交给 confirmUpdate 的完整输入。
 * 调用方的 RequirementService 必须带 authorizeManifest 才能批准。
 */
export async function manifestConfirmInput(config: ApprovalConfig, request: ManifestApprovalRequest):
  Promise<ConfirmUpdateInput & { manifest: ApprovalManifestReference }> {
  const operationId = request.operationId ?? uuidv7(), implement = request.implement ?? true;
  const service = await RequirementService.open({ ...config, authorize: () => true });
  const load = () => service.loadConfirmationContext({ requirementId: request.requirementId, savedOperationId: request.savedOperationId, operationId });
  let context = await load();
  const core = await UserInteractionCore.open({ ...config, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => {
      context = await load();
      const document = { candidate: context.candidate, title: context.title, body: context.body, partition: context.partition };
      const result: InteractionContext = { basis: context.basis, currentGoal: "", candidates: [{ ...context.candidate, diff: context.difference.text || "无差异" }],
        document, savedOperationId: context.savedOperationId, ...loadInteractionContinuity(config.dataRoot, config.repoId, context.basis, document) };
      return result;
    },
    interpreter: {
      identity: () => ({ provider: "fixture", id: "approve-whole-document", configurationHash: "a".repeat(64) }),
      interpret: async ({ context: current }) => {
        const document = current.document!;
        const common = { basis: "explicit", resolution: "direct", candidateId: document.candidate.candidateId, requestId: null,
          actions: [], references: [], supersedes: [], scope: "整份需求" };
        const units = document.partition.units.map((unit) => unit.id);
        const entries: object[] = [{ ...common, kind: "constraint", conclusion: "需求身份元数据" }, { ...common, kind: "target", conclusion: "确认整份需求正文" }];
        if (implement) entries.push({ ...common, kind: "action", actions: ["implement"], conclusion: "允许实施" });
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries, documentReview: { faithful: true,
          units: units.map((id) => ({ id, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [id === "metadata" ? 0 : 1] })),
          actions: implement ? [{ action: "implement", goalIds: units.filter((id) => id !== "metadata"), constraintIds: [],
            conclusionIndexes: [2], unknown: false }] : [], questions: [] } });
      },
    } });
  try {
    core.startSession({ sessionId: "approval-fixture", windowId: "approval-fixture" });
    const interpreted = await core.interpret(core.captureInput({ source: "interactive", text: "确认整份需求。" }, "approval-fixture"), request.requirementId);
    core.save(interpreted.capability);
    const document = () => core.authorizeDocument(interpreted.capability, { basis: context.basis, candidate: context.candidate });
    const authorized = document();
    if (!authorized) throw new Error("approval fixture: document not authorized");
    const store = new ApprovalManifestStore({ ...config, authorize: () => true,
      loadExpected: async () => { const current = await load(); return { requirementId: current.requirementId, candidate: current.candidate, partition: current.partition }; },
      admit: (access) => {
        const current = document();
        return current && decisionDigest(approvalManifestReference(current.manifest)) === decisionDigest(access.reference)
          ? { receiptId: current.authorization.receiptId, version: current.authorization.basis.version,
            epoch: current.authorization.basis.epoch, inputProof: current.authorization.inputProof } : null;
      } });
    const manifest = await store.register(authorized.manifest);
    return { requirementId: request.requirementId, operationId, version: context.version, title: context.title, body: context.body,
      receiptId: authorized.authorization.receiptId, manifest };
  } finally { core.shutdown(); }
}

/** 登记清单并用一个带 authorizeManifest 的服务实例批准当前保存版本。 */
export async function approveWithManifest(config: ApprovalConfig, request: ManifestApprovalRequest & { docSpec?: RequirementDocSpec }): Promise<RequirementReceipt> {
  const confirm = await manifestConfirmInput(config, request);
  const approver = await RequirementService.open({ ...config, authorize: () => true, authorizeManifest: () => true });
  return approver.confirmUpdate({ ...confirm, ...(request.docSpec ? { docSpec: request.docSpec } : {}) });
}

export type WriteGrant = (request: { action: "updateDraft" | "confirmUpdate"; operationId: string; title: string; body: string; receiptId?: string }) => void;
/**
 * 返回批准函数：正文与上次保存的不同时先存草稿，再登记清单并用调用方的 service 批准。
 * grant 在每次写之前调用，供调用方给自己的 authorize 发放许可；service 须带 authorizeManifest。
 */
export function draftApprover(config: ApprovalConfig, service: RequirementService,
  saved: { requirementId: string; operationId: string; title: string; body: string }, grant: WriteGrant = () => {}, implement = true) {
  let last = { operationId: saved.operationId, body: saved.body };
  return async (body = last.body, docSpec?: RequirementDocSpec): Promise<RequirementReceipt> => {
    if (body !== last.body) {
      const draft = { requirementId: saved.requirementId, operationId: uuidv7(), version: (await service.metadata(saved.requirementId)).version, title: saved.title, body };
      grant({ action: "updateDraft", ...draft });
      last = { operationId: (await service.updateDraft(draft)).operationId, body };
    }
    const confirm = await manifestConfirmInput(config, { requirementId: saved.requirementId, savedOperationId: last.operationId, implement });
    grant({ action: "confirmUpdate", ...confirm });
    return service.confirmUpdate({ ...confirm, ...(docSpec ? { docSpec } : {}) });
  };
}
