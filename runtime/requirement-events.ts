import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { uuidv7 } from "./database.ts";
import { checked, commands, commit, counter, hash, id, object, PmLease, positive, RequirementStateError } from "./requirement-contracts.ts";
import type { PmEventCursor, PmLease as PmLeaseData, ProdReference as ProdReferenceData } from "./requirement-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import type { RequirementAction, RequirementStoreOptions } from "./requirement-state.ts";
import { RequirementService } from "./requirement-service.ts";
import type { RequirementServiceOptions, ServiceAuthorizationRequest } from "./requirement-service.ts";
import { adviceIn } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";

const ArchiveRiskInput = object({
  requirementId: id,
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 8 }),
});
const BaselineReadInput = object({ lease: PmLease });
const AcknowledgeEventInput = object({
  lease: PmLease, eventId: id, sequence: positive, toRevision: positive, toCommit: commit,
  toHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
});
const AcknowledgeBaselineInput = object({ lease: PmLease, deliveryId: id });
const ConsumeDeliveryInput = object({
  lease: PmLease, handle: id, contextGeneration: positive, version: positive,
});
export type PollRequirementEventInput = Static<typeof commands.eventLease>;
export type PrepareApprovedBaselineInput = Static<typeof BaselineReadInput>;
export type AcknowledgeApprovedEventInput = Static<typeof AcknowledgeEventInput>;
export type AcknowledgeApprovedBaselineInput = Static<typeof AcknowledgeBaselineInput>;
export type ConsumePreparedDeliveryInput = Static<typeof ConsumeDeliveryInput>;
export type ReconcileArchiveRiskInput = Static<typeof ArchiveRiskInput>;

export type RequirementEventAction = "open" | "poll" | "prepare-baseline" | "consume" | "acknowledge" | "archive-risk";
export interface RequirementEventAuthorizationRequest {
  readonly action: RequirementEventAction;
  readonly repoId: string;
  readonly requirementId?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly epoch?: number;
  readonly fence?: number;
  readonly contextGeneration?: number;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly revision?: number;
  readonly commit?: string;
  readonly prodHash?: `sha256:${string}`;
  readonly version?: number;
  readonly deliveryId?: string;
  readonly handle?: string;
  readonly archivePaths?: readonly string[];
}

export interface RequirementEventServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 可信宿主同步核验调用者与PM租约；回调只收到固定元数据，不含prod正文或diff。 */
  authorize?: (request: Readonly<RequirementEventAuthorizationRequest>) => boolean;
  now?: () => number;
}

export interface ApprovedChangeDelivery {
  status: "event";
  eventId: string;
  sequence: number;
  redelivery: boolean;
  requirementId: string;
  fromRevision: number;
  toRevision: number;
  fromCommit: string;
  toCommit: string;
  fromHash: `sha256:${string}`;
  toHash: `sha256:${string}`;
  confirmationReceiptId: string;
  lifecycleEpoch: number;
  recordVersion: number;
}

export interface BaselineRequiredDelivery {
  status: "baseline_required";
  reason: "baseline_missing" | "event_gap" | "baseline_mismatch" | "context_missing";
  requirementId: string;
  revision: number;
  commit: string;
  prodHash: `sha256:${string}`;
  version: number;
  epoch: number;
}

export interface RecoveryRequiredDelivery {
  status: "recovery_required";
  reason: "history_unknown";
  requirementId: string;
  version: number;
  epoch: number;
  consumedSequence: number;
}

export interface CaughtUpDelivery {
  status: "caught_up";
  requirementId: string;
  deliveredSequence: number;
  consumedSequence: number;
  understoodRevision: number | null;
  understoodCommit: string | null;
  understoodHash: `sha256:${string}` | null;
}

export type RequirementEventDelivery = ApprovedChangeDelivery | BaselineRequiredDelivery | RecoveryRequiredDelivery | CaughtUpDelivery;

declare const opaqueDelivery: unique symbol;
export type OpaqueDeliveryHandle = string & { readonly [opaqueDelivery]: true };

export interface PreparedBaselineDelivery {
  kind: "baseline";
  handle: OpaqueDeliveryHandle;
  requirementId: string;
  deliveryId: string;
  throughSequence: number;
  revision: number;
  commit: string;
  prodHash: `sha256:${string}`;
  version: number;
  epoch: number;
  contextGeneration: number;
  expiresAt: number;
}

export type PreparedRequirementDelivery = PreparedBaselineDelivery;

export interface ArchiveRiskResult {
  requirementId: string;
  lifecycle: "draft" | "active" | "closing" | "closed";
  closeReason: "completed" | "cancelled" | "rejected" | null;
  recovery: "ready" | "needs_review";
  recoveryReason: "archive_found" | "history_unknown" | "identity_conflict" | null;
  epoch: number;
  version: number;
  result: "unchanged" | "blocked" | "terminal_retained";
}

interface PendingDelivery {
  prepared: PreparedRequirementDelivery;
  lease: PmLeaseData;
  authorization: RequirementEventAuthorizationRequest;
  state: RequirementStateStore;
  finalCheck: Record<string, unknown>;
}

const REQUIREMENT_EVENT_ADVICE: Readonly<Record<string, FailureAdvice>> = {
  archive_identity_conflict: { why: "同一需求编号对应了不同的归档文件", next: "停止操作，把这段原因告诉用户" },
  archive_path_not_allowed: { why: "归档路径不在允许的目录内", next: "停止操作，把这段原因告诉用户" },
  archive_paths_too_large: { why: "需要核对的归档路径太多", next: "停止操作，把这段原因告诉用户" },
  authorization_required: { why: "宿主没有授权这次需求事件操作", next: "停止操作，把这段原因告诉主代理" },
  baseline_changed: { why: "理解基线在投递期间发生了变化", next: "等下一次自动投递，不用处理" },
  delivery_binding_changed: { why: "投递期间 PM 租约或需求版本发生了变化", next: "等下一次自动投递，不用处理" },
  disposed: { why: "需求事件服务已关闭", next: "等下一次自动投递，不用处理" },
  duplicate_archive_path: { why: "有重复的归档路径", next: "停止操作，把这段原因告诉用户" },
  epoch_changed: { why: "需求在投递期间被关闭或重新开启", next: "停止操作，把这段原因告诉主代理" },
  expired_delivery_handle: { why: "投递凭据已过期", next: "等下一次自动投递；反复出现就把这段原因告诉主代理" },
  invalid_prod_hash: { why: "需求正文的指纹格式不对", next: "停止操作，把这段原因告诉用户" },
  recovery_required: { why: "需求记录需要恢复核对", next: "停止正式规划与派工，把这段原因告诉主代理，由用户处理" },
  unknown_delivery_handle: { why: "投递凭据不存在或已过期被清除", next: "等下一次自动投递；反复出现就把这段原因告诉主代理" },
};
export class RequirementEventServiceError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string) {
    super(`需求事件操作被拒绝：${code}`);
    this.name = "RequirementEventServiceError";
    this.code = code;
    this.advice = adviceIn(REQUIREMENT_EVENT_ADVICE, code);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(hashValue: string): `sha256:${string}` {
  if (!/^[0-9a-f]{64}$/.test(hashValue)) throw new RequirementEventServiceError("invalid_prod_hash");
  return `sha256:${hashValue}`;
}

function rawHash(hashValue: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hashValue)) throw new RequirementEventServiceError("invalid_prod_hash");
  return hashValue.slice("sha256:".length);
}

function leaseAuthorization(action: RequirementEventAction, repoId: string, lease: PmLeaseData): RequirementEventAuthorizationRequest {
  return { action, repoId, requirementId: lease.requirementId, workspaceId: lease.workspaceId, runId: lease.runId,
    epoch: lease.epoch, fence: lease.fence, contextGeneration: lease.contextGeneration };
}

function sameReference(left: ProdReferenceData, right: ProdReferenceData): boolean {
  return left.commit === right.commit && left.hash === right.hash;
}

function sameLease(left: PmLeaseData, right: PmLeaseData): boolean {
  return left.requirementId === right.requirementId && left.workspaceId === right.workspaceId && left.runId === right.runId &&
    left.epoch === right.epoch && left.fence === right.fence && left.contextGeneration === right.contextGeneration &&
    left.expiresAt === right.expiresAt;
}

function cursorResult(requirementId: string, cursor: PmEventCursor): CaughtUpDelivery {
  return {
    status: "caught_up", requirementId, deliveredSequence: cursor.deliveredSequence, consumedSequence: cursor.consumedSequence,
    understoodRevision: cursor.understoodRevision, understoodCommit: cursor.understood?.commit ?? null,
    understoodHash: cursor.understood ? sha256(cursor.understood.hash) : null,
  };
}

/**
 * PM可靠消费已批准prod事件的内部接缝。基线只登记 PM 的理解基线，不投递正文：准备阶段核对存储里的
 * 批准正文与登记指纹一致后签发一次性句柄，消费时同步做最终核验，再由确认推进游标。
 */
export class RequirementEventService {
  private static readonly MAX_PENDING = 32;
  private readonly options: RequirementEventServiceOptions;
  private readonly pending = new Map<string, PendingDelivery>();
  private readonly invalidationSubscriptions = new Map<string, () => void>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private constructor(options: RequirementEventServiceOptions) { this.options = { ...options }; }

  static async open(options: RequirementEventServiceOptions): Promise<RequirementEventService> {
    checked(hash, options.repoId);
    const service = new RequirementEventService(options);
    const authorization: RequirementEventAuthorizationRequest = { action: "open", repoId: options.repoId };
    service.authorize(authorization);
    await service.state(authorization, new Set(["open"]));
    service.authorize(authorization);
    return service;
  }

  private now(): number { return checked(counter, this.options.now?.() ?? Date.now()); }

  private authorize(input: RequirementEventAuthorizationRequest): void {
    if (this.disposed) throw new RequirementEventServiceError("disposed");
    const request = freeze(structuredClone(input));
    let result: unknown;
    try { result = this.options.authorize?.(request); }
    catch { throw new RequirementEventServiceError("authorization_required"); }
    if (isPromise(result)) {
      void Promise.prototype.then.call(result, () => undefined, () => undefined);
      throw new RequirementEventServiceError("authorization_required");
    }
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      let then: unknown;
      try { then = (result as { then?: unknown }).then; }
      catch { throw new RequirementEventServiceError("authorization_required"); }
      if (typeof then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new RequirementEventServiceError("authorization_required");
      }
    }
    if (result !== true) throw new RequirementEventServiceError("authorization_required");
  }

  private async state(
    request: RequirementEventAuthorizationRequest,
    allowed: ReadonlySet<RequirementAction>,
  ): Promise<RequirementStateStore> {
    const options: RequirementStoreOptions = {
      dataRoot: this.options.dataRoot, repoId: this.options.repoId, repositoryRoot: this.options.repositoryRoot,
      now: this.options.now,
      authorize: ({ action }) => {
        if (!allowed.has(action)) return false;
        this.authorize(request);
        return true;
      },
    };
    return RequirementStateStore.open(options);
  }

  private async requirementService(request: RequirementEventAuthorizationRequest): Promise<RequirementService> {
    const options: RequirementServiceOptions = {
      ...this.options,
      authorize: (inner: Readonly<ServiceAuthorizationRequest>) => {
        if (inner.repoId !== this.options.repoId || !["metadata", "readApproved"].includes(inner.action) ||
          (inner.requirementId !== undefined && inner.requirementId !== request.requirementId) ||
          (inner.epoch !== undefined && inner.epoch !== request.epoch)) return false;
        this.authorize({ ...request, epoch: inner.epoch ?? request.epoch, version: inner.version,
          prodHash: inner.prodHash ?? request.prodHash });
        return true;
      },
    };
    return RequirementService.open(options);
  }

  private releaseUnusedSubscriptions(): void {
    const required = new Set([...this.pending.values()].map((item) => item.lease.requirementId));
    for (const [requirementId, unsubscribe] of this.invalidationSubscriptions) {
      if (!required.has(requirementId)) { unsubscribe(); this.invalidationSubscriptions.delete(requirementId); }
    }
    if (this.pending.size === 0 && this.cleanupTimer) { clearTimeout(this.cleanupTimer); this.cleanupTimer = null; }
  }

  private discardRequirement(requirementId: string): void {
    for (const [handle, delivery] of this.pending) if (delivery.lease.requirementId === requirementId) this.pending.delete(handle);
    this.releaseUnusedSubscriptions();
  }

  private checkDelivery(delivery: PendingDelivery): void {
    delivery.state.checkApprovedBaselineReturnSync(delivery.finalCheck as never);
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [handle, delivery] of this.pending) {
      if (delivery.prepared.expiresAt <= now) this.pending.delete(handle);
    }
    this.releaseUnusedSubscriptions();
  }

  private scheduleCleanup(): void {
    if (this.disposed || this.pending.size === 0 || this.cleanupTimer) return;
    const expiry = Math.min(...[...this.pending.values()].map((item) => item.prepared.expiresAt));
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      try {
        this.purgeExpired();
        // 外部进程只能通过当前元数据被发现；消费边界仍每次同步拒绝失效结果，不等待此定时清理。
        for (const [handle, delivery] of [...this.pending]) {
          try { this.checkDelivery(delivery); } catch { this.pending.delete(handle); }
        }
      } catch { this.pending.clear(); }
      this.releaseUnusedSubscriptions();
      this.scheduleCleanup();
    }, Math.max(1, Math.min(1_000, expiry - this.now())));
    this.cleanupTimer.unref?.();
  }

  /** 可信持有者结束时释放本服务自有缓存。 */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.releaseUnusedSubscriptions();
  }

  private retain(delivery: PendingDelivery): PreparedRequirementDelivery {
    this.purgeExpired();
    const requirementId = delivery.lease.requirementId;
    if (!this.invalidationSubscriptions.has(requirementId)) {
      this.invalidationSubscriptions.set(requirementId,
        delivery.state.onAccessInvalidated(requirementId, () => this.discardRequirement(requirementId)));
    }
    try { this.checkDelivery(delivery); }
    catch (error) { this.releaseUnusedSubscriptions(); throw error; }
    while (this.pending.size >= RequirementEventService.MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    this.pending.set(delivery.prepared.handle, delivery);
    this.releaseUnusedSubscriptions();
    this.scheduleCleanup();
    return delivery.prepared;
  }

  async poll(input: PollRequirementEventInput): Promise<RequirementEventDelivery> {
    const request = checked(commands.eventLease, input);
    const authorization = leaseAuthorization("poll", this.options.repoId, request.lease);
    this.authorize(authorization);
    const state = await this.state(authorization, new Set(["open", "read", "deliver-approved-event", "check-approved-return"]));
    const result = await state.nextApprovedEvent(request);
    if (result.status === "recovery_required") {
      return { status: "recovery_required", reason: result.reason, requirementId: request.lease.requirementId,
        version: result.version, epoch: result.epoch, consumedSequence: result.cursor.consumedSequence };
    }
    if (result.status === "event") {
      const eventAuthorization = { ...authorization, eventId: result.eventId, sequence: result.sequence,
        revision: result.event.toRevision, commit: result.event.to.commit, prodHash: sha256(result.event.to.hash) };
      this.authorize(eventAuthorization);
      const event = result.event;
      return {
        status: "event", eventId: result.eventId, sequence: result.sequence, redelivery: result.redelivery,
        requirementId: event.requirementId, fromRevision: event.fromRevision!, toRevision: event.toRevision,
        fromCommit: event.from!.commit, toCommit: event.to.commit, fromHash: sha256(event.from!.hash), toHash: sha256(event.to.hash),
        confirmationReceiptId: event.receiptId, lifecycleEpoch: event.lifecycleEpoch, recordVersion: event.recordVersion,
      };
    }
    if (result.status === "baseline_required") {
      this.authorize({ ...authorization, revision: result.revision, commit: result.reference.commit, prodHash: sha256(result.reference.hash) });
      await state.approvedEventCursor(request);
      return { status: "baseline_required", reason: result.reason, requirementId: request.lease.requirementId,
        revision: result.revision, commit: result.reference.commit, prodHash: sha256(result.reference.hash),
        version: result.version, epoch: result.epoch };
    }
    this.authorize(authorization);
    const cursor = await state.approvedEventCursor(request);
    return cursorResult(request.lease.requirementId, cursor);
  }

  async prepareCurrentBaseline(input: PrepareApprovedBaselineInput): Promise<PreparedBaselineDelivery> {
    const request = checked(BaselineReadInput, input);
    const authorization = leaseAuthorization("prepare-baseline", this.options.repoId, request.lease);
    this.authorize(authorization);
    const state = await this.state(authorization, new Set(["open", "read", "check-approved-return", "issue-approved-baseline"]));
    const requirement = await state.approvedBaselineRequirement(request);
    if (requirement.status === "recovery_required") throw new RequirementEventServiceError("recovery_required");
    const service = await this.requirementService(authorization);
    const verified = await service.verifyApproved(request.lease.requirementId);
    if (verified.epoch !== request.lease.epoch) throw new RequirementEventServiceError("epoch_changed");
    const metadata = await service.metadata(request.lease.requirementId);
    const reference = { commit: verified.commit, hash: rawHash(verified.prodHash) };
    if (metadata.version !== verified.version || metadata.epoch !== verified.epoch || metadata.revision !== requirement.revision ||
      !metadata.approved || metadata.approved.commit !== verified.commit || metadata.approved.prodHash !== verified.prodHash ||
      !sameReference(reference, requirement.reference)) throw new RequirementEventServiceError("baseline_changed");
    const delivery = await state.issueApprovedBaseline({ lease: request.lease, version: verified.version, epoch: verified.epoch,
      revision: metadata.revision, reference });
    const handle = uuidHandle();
    const prepared = freeze({ kind: "baseline" as const, handle, requirementId: request.lease.requirementId,
      deliveryId: delivery.deliveryId, throughSequence: delivery.throughSequence, revision: delivery.revision,
      commit: delivery.reference.commit, prodHash: sha256(delivery.reference.hash), version: delivery.recordVersion,
      epoch: delivery.epoch, contextGeneration: request.lease.contextGeneration, expiresAt: request.lease.expiresAt });
    const finalCheck = { lease: request.lease, deliveryId: delivery.deliveryId, version: verified.version,
      epoch: verified.epoch, revision: delivery.revision, reference: delivery.reference };
    return this.retain({ prepared, lease: request.lease, authorization, state, finalCheck }) as PreparedBaselineDelivery;
  }

  consumePreparedDelivery(input: ConsumePreparedDeliveryInput): void {
    const request = checked(ConsumeDeliveryInput, input);
    this.purgeExpired();
    const pending = this.pending.get(request.handle);
    if (!pending) throw new RequirementEventServiceError("unknown_delivery_handle");
    this.pending.delete(request.handle);
    this.releaseUnusedSubscriptions();
    if (pending.prepared.expiresAt <= this.now()) throw new RequirementEventServiceError("expired_delivery_handle");
    if (!sameLease(pending.lease, request.lease) || request.contextGeneration !== request.lease.contextGeneration ||
      request.contextGeneration !== pending.prepared.contextGeneration || request.version !== pending.prepared.version ||
      request.lease.requirementId !== pending.prepared.requirementId) {
      throw new RequirementEventServiceError("delivery_binding_changed");
    }
    const authorization = { ...pending.authorization, action: "consume" as const, handle: request.handle,
      version: pending.prepared.version, contextGeneration: pending.prepared.contextGeneration };
    this.authorize(authorization);
    this.checkDelivery(pending);
  }

  async acknowledgeBaseline(input: AcknowledgeApprovedBaselineInput): Promise<void> {
    const request = checked(AcknowledgeBaselineInput, input);
    const authorization = { ...leaseAuthorization("acknowledge", this.options.repoId, request.lease), deliveryId: request.deliveryId };
    this.authorize(authorization);
    const state = await this.state(authorization, new Set(["open", "read", "acknowledge-approved-event"]));
    await state.acknowledgeApprovedBaseline(request);
    this.authorize(authorization);
  }

  async acknowledgeEvent(input: AcknowledgeApprovedEventInput): Promise<void> {
    const request = checked(AcknowledgeEventInput, input);
    const authorization = { ...leaseAuthorization("acknowledge", this.options.repoId, request.lease),
      eventId: request.eventId, sequence: request.sequence, revision: request.toRevision,
      commit: request.toCommit, prodHash: request.toHash as `sha256:${string}` };
    this.authorize(authorization);
    const state = await this.state(authorization, new Set(["open", "read", "acknowledge-approved-event", "check-approved-return"]));
    await state.acknowledgeApprovedEvent({ lease: request.lease, eventId: request.eventId, sequence: request.sequence,
      revision: request.toRevision, reference: { commit: request.toCommit, hash: rawHash(request.toHash) } });
    this.authorize(authorization);
  }

  async reconcileArchiveRisk(input: ReconcileArchiveRiskInput): Promise<ArchiveRiskResult> {
    const request = checked(ArchiveRiskInput, input);
    if (new Set(request.paths).size !== request.paths.length) throw new RequirementEventServiceError("duplicate_archive_path");
    if (request.paths.reduce((total, path) => total + Array.from(path).length, 0) > 16_384) {
      throw new RequirementEventServiceError("archive_paths_too_large");
    }
    const authorization: RequirementEventAuthorizationRequest = { action: "archive-risk", repoId: this.options.repoId,
      requirementId: request.requirementId, archivePaths: Object.freeze([...request.paths]) };
    this.authorize(authorization);
    const state = await this.state(authorization, new Set(["open", "read", "block-recovery"]));
    let current = state.read(request.requirementId);
    const roots = new Set([this.options.repositoryRoot, current.data.workspace?.path].filter((value): value is string => Boolean(value))
      .map((root) => resolve(join(root, "docs", "prod"))));
    for (const path of request.paths) {
      if (!isAbsolute(path) || resolve(path) !== path || !roots.has(dirname(path))) throw new RequirementEventServiceError("archive_path_not_allowed");
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(.+)\.md$/u.exec(basename(path));
      if (!match || match[1] !== request.requirementId || !match[2] || match[2] === "." || match[2] === ".." ||
        /[\u0000-\u001f\u007f/\\]/u.test(match[2])) throw new RequirementEventServiceError("archive_identity_conflict");
    }
    let result: ArchiveRiskResult["result"] = "unchanged";
    if (current.data.lifecycle === "closing" || current.data.lifecycle === "closed") {
      result = "terminal_retained";
    } else if (request.paths.length > 0 && (current.data.recovery === "ready" ||
      (request.paths.length > 1 && current.data.recoveryReason !== "identity_conflict"))) {
      current = state.blockForRecovery({ requirementId: request.requirementId, version: current.version,
        reason: request.paths.length > 1 ? "identity_conflict" : "archive_found" });
      result = "blocked";
    }
    this.authorize(authorization);
    const after = state.read(request.requirementId);
    if (after.version !== current.version || after.data.epoch !== current.data.epoch) throw new RequirementStateError("state_changed_during_read");
    return { requirementId: request.requirementId, lifecycle: after.data.lifecycle,
      closeReason: after.data.close?.reason ?? null, recovery: after.data.recovery, recoveryReason: after.data.recoveryReason,
      epoch: after.data.epoch, version: after.version, result };
  }
}

function uuidHandle(): OpaqueDeliveryHandle {
  return uuidv7() as OpaqueDeliveryHandle;
}
