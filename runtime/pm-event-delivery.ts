import { repositoryDatabase, withDatabase } from "./database.ts";
import { PmIntakeStore } from "./pm-intake-store.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import { RequirementEventService } from "./requirement-events.ts";

export interface PmEventDeliveryInput {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  lease: PmLease;
  /** 同步把差异交给本 PM 物理会话；返回后即视为已进入该会话上下文。 */
  deliver: (text: string) => void;
}

export type PmEventDeliveryResult = "caught_up" | "awaiting_review" | "recovery_required";

/** 主代理已按本租约、本物理上下文核对通过，且核对的正是当前批准版本。 */
function reviewedCurrent(input: PmEventDeliveryInput): boolean {
  const head = new PmIntakeStore({ dataRoot: input.dataRoot, repoId: input.repoId }).readHead(input.lease.requirementId);
  const binding = head?.review?.result === "passed" ? head.review.binding : null;
  const record = withDatabase(repositoryDatabase(input.dataRoot, input.repoId), (db) => db.read<RequirementRecord>("requirements", input.lease.requirementId))?.data;
  return !!binding && !!record?.approved && binding.pmRunId === input.lease.runId && binding.pmFence === input.lease.fence &&
    binding.contextGeneration === input.lease.contextGeneration && binding.approvedRevision === record.revision && binding.approvedProdHash === record.approved.hash;
}

/**
 * 把已批准更新按序投递给持有租约的 PM：理解基线只在主代理核对通过当前批准版本后建立；
 * 之后每个事件的准确差异交给 PM 会话再确认消费，缺口、乱序与旧租约由需求状态服务拒绝。
 */
export async function deliverApprovedEvents(input: PmEventDeliveryInput): Promise<PmEventDeliveryResult> {
  const { lease } = input;
  const service = await RequirementEventService.open({ repositoryRoot: input.repositoryRoot, dataRoot: input.dataRoot, repoId: input.repoId,
    authorize: (request) => request.repoId === input.repoId && (request.requirementId === undefined ||
      (request.requirementId === lease.requirementId && request.runId === lease.runId && request.fence === lease.fence)) });
  try {
    for (;;) {
      const polled = await service.poll({ lease });
      if (polled.status === "caught_up") return "caught_up";
      if (polled.status === "recovery_required") return "recovery_required";
      if (polled.status === "baseline_required") {
        if (!reviewedCurrent(input)) return "awaiting_review";
        const prepared = await service.prepareCurrentBaseline({ lease });
        // PM 已在接手时自行读取完整正文，这里只登记基线，不再重复注入正文
        service.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: prepared.contextGeneration, version: prepared.version }, () => {});
        await service.acknowledgeBaseline({ lease, deliveryId: prepared.deliveryId });
        continue;
      }
      const prepared = await service.prepareDiff({ lease, eventId: polled.eventId, sequence: polled.sequence });
      service.consumePreparedDelivery({ lease, handle: prepared.handle, contextGeneration: prepared.contextGeneration, version: prepared.version }, (content) => {
        if (content.kind !== "diff") return;
        input.deliver([
          `已批准更新：revision ${content.fromRevision} → ${content.toRevision}（事件 ${content.sequence}，prod hash ${content.toHash}）。`,
          "准确差异如下：", content.diff,
          `请据此分析对规则、代码与各任务的影响，用 pi_company_plan_manage assess-update（revision ${content.toRevision}）逐任务复核，再按需局部调整计划。`,
        ].join("\n"));
      });
      await service.acknowledgeEvent({ lease, eventId: prepared.eventId, sequence: prepared.sequence, toRevision: prepared.toRevision,
        toCommit: prepared.toCommit, toHash: prepared.toHash });
    }
  } finally { service.dispose(); }
}
