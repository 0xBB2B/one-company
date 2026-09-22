import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static } from "typebox";
import { LocalDatabase, repositoryDatabase, StaleVersionError, uuidv7, withDatabase } from "./database.ts";
import type { StoredRecord, SyncResult } from "./database.ts";
import { pathExists, assertDataRootOutsideWorktrees } from "./database-paths.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { canonicalJson } from "./strict-json.ts";
import type { JsonValue } from "./strict-json.ts";
import { checked, checkRequirement, commands, hash, id, object, counter, positive, ApprovedProdChange, BaselineDelivery, LegacyPmRecord, OwnerClaim, PmContext, PmEventCursor, PmRecord, PmLease, RequestRecord, RequirementEvent, RequirementStateError } from "./requirement-contracts.ts";
import type { ApprovedProdChange as ApprovedProdChangeData, BaselineDelivery as BaselineDeliveryData, PmContext as PmContextData, PmEventCursor as PmEventCursorData, PmRecord as PmRecordData, RequirementRecord, ProdReference, WorkspaceBinding } from "./requirement-contracts.ts";
import { inspectRequirementWorkspace, verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { readGit } from "./git-read.ts";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn, releaseDeadRequirementWriteIn } from "./requirement-coordination.ts";

import { registeredApprovalManifestIn, summarizeApprovalManifest } from "./approval-manifest-store.ts";
import type { ApprovalManifestReference } from "./approval-manifest.ts";

export type RequirementAction = "open" | "reserve" | "read" | "saved-version" | "approved-version" | "bind-workspace" | "acquire-pm" | "renew-pm" | "release-pm" | "check-pm" | "check-scheduling" | "rotate-pm-context" | "restore-approved-context" | "events" | "acknowledge" | "deliver-approved-event" | "acknowledge-approved-event" | "issue-approved-baseline" | "check-approved-return" | "begin-close" | "finish-close" | "block-recovery" | "assess-update" | "record-decisions" | "read-decisions";
export interface StateAuthorizationRequest { action: RequirementAction; repoId: string; input: Readonly<Record<string, unknown>> }
export interface RequirementAccessState { record: StoredRecord<RequirementRecord> | null; pmLeaseHash: string }
export interface RequirementAccessChange {
  repoId: string; requirementId: string; action: RequirementAction; operationId: string | null;
  before: RequirementAccessState; after: RequirementAccessState; origin?: object;
}
export interface RequirementStoreOptions {
  dataRoot: string;
  repoId: string;
  repositoryRoot: string;
  /** 可信宿主提供同步核验；必须核对真实主体及所引用的批准/保存/准备/收尾凭据，不得从模型参数自报身份。 */
  authorize?: (request: StateAuthorizationRequest) => boolean;
  now?: () => number;
  /** 仅本次可信updateDraft调用持有，不序列化或持久化。 */
  localMutationOrigin?: object;
  /** 带manifest的批准需要独立可信入口；记录保全授权不能替代新交互许可。 */
  authorizeManifest?: (input: { requirementId: string; version: number; receiptId: string; manifest: ApprovalManifestReference }) => boolean;
}
export type ApprovedEventPoll =
  | { status: "caught_up"; cursor: PmEventCursorData }
  | { status: "baseline_required"; reason: "baseline_missing" | "event_gap" | "baseline_mismatch" | "context_missing"; cursor: PmEventCursorData; revision: number; reference: ProdReference; version: number; epoch: number }
  | { status: "recovery_required"; reason: "history_unknown"; cursor: PmEventCursorData; version: number; epoch: number }
  | { status: "event"; eventId: string; sequence: number; redelivery: boolean; event: ApprovedProdChangeData; cursor: PmEventCursorData };
const LEASE_MS = 30_000;
const Operation = object({ requirementId: id, digest: hash, sequence: positive });
const BaselineReturn = object({
  lease: PmLease, deliveryId: id, version: positive, epoch: positive, revision: positive, reference: object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }), hash }),
});
const EventReturn = object({
  lease: PmLease, eventId: id, sequence: positive, version: positive, epoch: positive,
  fromRevision: positive, toRevision: positive,
  from: object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }), hash }),
  to: object({ commit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }), hash }),
});
const eventStream = (requirementId: string) => `requirement_events:${requirementId}`;
const equal = (a: unknown, b: unknown) => canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
function increment(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new RequirementStateError("counter_exhausted");
  return value + 1;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}

/** 新UUID需求的内部元数据基础；不创建prod文件、不派工、不开放模型工具。 */
export class RequirementStateStore {
  private static readonly accessListeners = new Map<string, Set<(change: RequirementAccessChange) => void>>();
  private readonly options: RequirementStoreOptions;
  private constructor(options: RequirementStoreOptions) {
    checked(hash, options.repoId);
    this.options = { ...options };
  }
  static async open(options: RequirementStoreOptions): Promise<RequirementStateStore> {
    const store = new RequirementStateStore(options);
    const { repositoryRoot, repoId, dataRoot } = store.options;
    store.authorize("open", { repositoryRoot });
    const identity = await repositoryIdentity(repositoryRoot);
    if (identity.repoId !== repoId) throw new RequirementStateError("foreign_repository");
    assertDataRootOutsideWorktrees(dataRoot, await listWorktrees(identity.commonDir));
    store.authorize("open", { repositoryRoot });
    return store;
  }
  private authorize(action: RequirementAction, input: Record<string, unknown>): void {
    const request = deepFreeze({ action, repoId: this.options.repoId, input: structuredClone(input) });
    const result = this.options.authorize?.(request);
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new RequirementStateError("authorization_required");
  }
  private now(): number { return checked(counter, this.options.now?.() ?? Date.now()); }
  private path(): string { return repositoryDatabase(this.options.dataRoot, this.options.repoId); }
  private get(db: LocalDatabase, requirementId: string): StoredRecord<RequirementRecord> {
    const stored = db.read("requirements", checked(id, requirementId));
    if (!stored) throw new RequirementStateError("unknown_requirement");
    const data = checkRequirement(stored.data, requirementId, this.options.repoId);
    if (stored.id !== requirementId) throw new RequirementStateError("identity_conflict");
    if (data.approvalReceiptId) {
      const use = db.read("requirement_approval_uses", data.approvalReceiptId);
      if (!use || checked(Operation, use.data).requirementId !== requirementId) throw new RequirementStateError("approval_record_missing");
    }
    if (data.workspace) this.checkClaims(db, data.workspace);
    return { ...stored, data };
  }
  onAccessInvalidated(requirementId: string, listener: (change: RequirementAccessChange) => void): () => void {
    this.read(requirementId);
    const key = `${this.path()}:${requirementId}`;
    let listeners = RequirementStateStore.accessListeners.get(key);
    if (!listeners) RequirementStateStore.accessListeners.set(key, listeners = new Set());
    listeners.add(listener);
    const registered = listeners;
    return () => {
      registered.delete(listener);
      if (registered.size === 0) RequirementStateStore.accessListeners.delete(key);
    };
  }
  private notifyAccessInvalidated(change: RequirementAccessChange): void {
    for (const listener of [...(RequirementStateStore.accessListeners.get(`${this.path()}:${change.requirementId}`) ?? [])]) {
      try { listener(change); } catch { /* 缓存观察者不能撤销已提交的状态变化。 */ }
    }
  }
  private accessState(db: LocalDatabase, requirementId: string): RequirementAccessState {
    const row = db.read("requirements", requirementId);
    return { record: row ? { ...row, data: checkRequirement(row.data, requirementId, this.options.repoId) } : null,
      pmLeaseHash: createHash("sha256").update(JSON.stringify(db.read<{ lease?: unknown }>("pm_ownership", requirementId)?.data.lease ?? null)).digest("hex") };
  }
  private accessChange(action: RequirementAction, input: Record<string, unknown>, requirementId: string, before: RequirementAccessState, after: RequirementAccessState): RequirementAccessChange {
    const change = { repoId: this.options.repoId, requirementId, action, operationId: typeof input.operationId === "string" ? input.operationId : null,
      before: deepFreeze(before), after: deepFreeze(after), ...(action === "saved-version" && this.options.localMutationOrigin ? { origin: this.options.localMutationOrigin } : {}) };
    return Object.freeze(change);
  }
  private mutate<T>(action: RequirementAction, input: Record<string, unknown>, operation: (db: LocalDatabase) => T & SyncResult<T>, finalAuthorization?: () => void): T {
    this.authorize(action, input);
    // 精确清单许可必须是写事务前最后一个宿主回调；随后只核对同步DB依据，避免撤权重入窗口。
    finalAuthorization?.();
    const candidate = input.requirementId ?? (input.lease as { requirementId?: unknown } | undefined)?.requirementId;
    const requirementId = typeof candidate === "string" ? candidate : null;
    let change: RequirementAccessChange | undefined;
    const result = withDatabase(this.path(), (db) => db.transaction<T>(() => {
      if (!finalAuthorization) this.authorize(action, input);
      const before = requirementId ? this.accessState(db, requirementId) : null;
      const result = operation(db);
      if (!finalAuthorization) this.authorize(action, input);
      if (requirementId && before) {
        const after = this.accessState(db, requirementId);
        if (!equal(before, after)) change = this.accessChange(action, input, requirementId, before, after);
      }
      return result;
    }));
    if (change) this.notifyAccessInvalidated(change);
    return result;
  }
  private finalCheck<T>(
    action: RequirementAction,
    input: Record<string, unknown>,
    operation: (db: LocalDatabase, now: number) => T & SyncResult<T>,
  ): T {
    this.authorize(action, input);
    const now = this.now();
    const requirementId = checked(id, (input.lease as { requirementId: string }).requirementId);
    let change: RequirementAccessChange | undefined;
    const result = withDatabase(this.path(), (db) => db.transaction<T>(() => {
      const before = this.accessState(db, requirementId), result = operation(db, now), after = this.accessState(db, requirementId);
      if (!equal(before, after)) change = this.accessChange(action, input, requirementId, before, after);
      return result;
    }));
    // 仅恢复拒绝分支会改变访问状态；提交且退出事务后清缓存，成功交付分支不会回调观察者。
    if (change) this.notifyAccessInvalidated(change);
    return result;
  }
  private active(record: RequirementRecord, allowDraft = false): void {
    if (record.recovery !== "ready") throw new RequirementStateError("recovery_required");
    if (record.lifecycle !== "active" && !(allowDraft && record.lifecycle === "draft")) throw new RequirementStateError("lifecycle_denied");
  }
  private version(record: StoredRecord, expected: number): void { if (record.version !== expected) throw new StaleVersionError(); }
  private write(db: LocalDatabase, record: StoredRecord<RequirementRecord>, data: RequirementRecord, kind: RequirementEvent["kind"], from: ProdReference | null = null, to: ProdReference | null = null, receiptId: string | null = null, now = this.now()) {
    data.updatedAt = Math.max(data.updatedAt, now);
    checkRequirement(data, data.requirementId, this.options.repoId);
    const version = db.update("requirements", data.requirementId, record.version, data);
    const event = checked(RequirementEvent, { requirementId: data.requirementId, repoId: data.repoId, kind, version, epoch: data.epoch, revision: data.revision, from, to, receiptId, recoveryReason: data.recoveryReason,
      ...(kind === "prod.approved" && data.approvalManifest ? { approvalManifest: data.approvalManifest } : {}) });
    const queued = db.append(eventStream(data.requirementId), event);
    return { record: { id: record.id, version, data }, event: queued };
  }
  private owner(db: LocalDatabase, requirementId: string) {
    const stored = db.read("pm_ownership", requirementId);
    if (!stored) return null;
    let data: PmRecordData;
    if (Value.Check(LegacyPmRecord, stored.data)) {
      const legacy = checked(LegacyPmRecord, stored.data);
      if (legacy.lease && (legacy.lease.requirementId !== requirementId || legacy.lease.fence !== legacy.fence)) {
        throw new RequirementStateError("invalid_pm_owner");
      }
      // 读取只归一化视图，不恢复旧租约；接管或撤权事务保留sequence并提升原fence。
      data = { ...legacy, lease: null };
    } else data = checked(PmRecord, stored.data);
    const context = data.context ? checked(PmContext, data.context) : null;
    if (data.requirementId !== requirementId ||
      (data.lease && (data.lease.requirementId !== requirementId || data.lease.fence !== data.fence ||
        !context || context.runId !== data.lease.runId || context.fence !== data.lease.fence ||
        context.generation !== data.lease.contextGeneration)) ||
      (!data.lease && context !== null && context.baseline !== null)) throw new RequirementStateError("invalid_pm_owner");
    return { ...stored, data };
  }
  private revoke(db: LocalDatabase, requirementId: string): void {
    const owner = this.owner(db, requirementId);
    if (owner) db.update("pm_ownership", requirementId, owner.version, { ...owner.data, fence: increment(owner.data.fence), lease: null,
      ...(owner.data.context ? { context: { ...owner.data.context, baseline: null } } : {}) });
  }
  private eventCursor(owner: StoredRecord<PmRecordData>): PmEventCursorData {
    const data = owner.data.prodEvents ? checked(PmEventCursor, owner.data.prodEvents) : this.cursorData(owner.data.requirementId);
    if (data.requirementId !== owner.data.requirementId || data.deliveredSequence < data.consumedSequence ||
      ((data.understood === null) !== (data.understoodRevision === null)) ||
      (data.baselineDelivery !== null && data.baselineDelivery.mode === "cursor_recovery" &&
        data.baselineDelivery.throughSequence > data.deliveredSequence)) {
      throw new RequirementStateError("invalid_pm_event_cursor");
    }
    return data;
  }
  private cursorData(requirementId: string): PmEventCursorData {
    return { format: "pm-prod-event-cursor/v1", requirementId, deliveredSequence: 0, consumedSequence: 0,
      understoodRevision: null, understood: null, baselineDelivery: null };
  }
  private approvedEvents(db: LocalDatabase, requirementId: string, after = 0) {
    return db.events(eventStream(requirementId), after).flatMap((event) => {
      const audit = checked(RequirementEvent, event.data);
      if (audit.requirementId !== requirementId || audit.repoId !== this.options.repoId) throw new RequirementStateError("event_identity_conflict");
      if (audit.kind !== "prod.approved") return [];
      if (!audit.to || !audit.receiptId || ((audit.from === null) !== (audit.revision === 1))) throw new RequirementStateError("approved_event_invalid");
      const data = checked(ApprovedProdChange, {
        format: "approved-prod-change/v1", requirementId, repoId: this.options.repoId,
        fromRevision: audit.from === null ? null : audit.revision - 1, toRevision: audit.revision,
        from: audit.from, to: audit.to, receiptId: audit.receiptId, lifecycleEpoch: audit.epoch,
        recordVersion: audit.version, changedSections: null, impactReason: "section_structure_unavailable",
        ...(audit.approvalManifest ? { approvalManifest: audit.approvalManifest } : {}),
      });
      return [{ ...event, data }];
    });
  }
  private putEventCursor(db: LocalDatabase, owner: StoredRecord<PmRecordData>, data: PmEventCursorData): void {
    checked(PmEventCursor, data);
    db.update("pm_ownership", data.requirementId, owner.version, { ...owner.data, prodEvents: data });
  }
  private context(owner: StoredRecord<PmRecordData>): PmContextData {
    const context = owner.data.context ? checked(PmContext, owner.data.context) : null;
    if (!owner.data.lease || !context || context.runId !== owner.data.lease.runId || context.fence !== owner.data.lease.fence ||
      context.generation !== owner.data.lease.contextGeneration) throw new RequirementStateError("invalid_pm_context");
    return context;
  }
  private historyUnknown(
    record: StoredRecord<RequirementRecord>,
    cursor: PmEventCursorData,
    events: Array<{ sequence: number; data: ApprovedProdChangeData }>,
  ): boolean {
    const last = events.at(-1);
    return !last || cursor.consumedSequence > last.sequence || last.data.toRevision !== record.data.revision ||
      !record.data.approved || !equal(last.data.to, record.data.approved);
  }
  private blockUnknownHistory(db: LocalDatabase, record: StoredRecord<RequirementRecord>, now = this.now()): StoredRecord<RequirementRecord> {
    this.revoke(db, record.id);
    return this.write(db, record, { ...record.data, recovery: "needs_review", recoveryReason: "history_unknown",
      epoch: increment(record.data.epoch) }, "recovery.blocked", null, null, null, now).record;
  }
  private contextHasUsableBaseline(
    record: StoredRecord<RequirementRecord>,
    owner: StoredRecord<PmRecordData>,
    cursor: PmEventCursorData,
  ): boolean {
    const baseline = this.context(owner).baseline;
    if (baseline === null || baseline.runId !== owner.data.lease!.runId || baseline.fence !== owner.data.lease!.fence ||
      baseline.contextGeneration !== owner.data.lease!.contextGeneration || baseline.epoch !== record.data.epoch) return false;
    const matchesCursor = cursor.understoodRevision !== null && cursor.understood !== null &&
      baseline.revision === cursor.understoodRevision && equal(baseline.reference, cursor.understood);
    const matchesCurrent = record.data.approved !== null && baseline.revision === record.data.revision &&
      equal(baseline.reference, record.data.approved);
    return matchesCursor || matchesCurrent;
  }
  private baselineReason(
    record: StoredRecord<RequirementRecord>,
    owner: StoredRecord<PmRecordData>,
    cursor: PmEventCursorData,
    events: Array<{ sequence: number; data: ApprovedProdChangeData }>,
  ): Extract<ApprovedEventPoll, { status: "baseline_required" }>["reason"] | null {
    const next = events.find((event) => event.sequence > cursor.consumedSequence);
    if (cursor.understood === null || cursor.understoodRevision === null) return "baseline_missing";
    if (next && next.data.fromRevision !== cursor.understoodRevision) return "event_gap";
    if (next && !equal(next.data.from, cursor.understood)) return "baseline_mismatch";
    if (!next && (cursor.understoodRevision !== record.data.revision || !equal(cursor.understood, record.data.approved))) return "event_gap";
    if (!this.contextHasUsableBaseline(record, owner, cursor)) return "context_missing";
    return null;
  }

  reserve(input: Static<typeof commands.reserve>): StoredRecord<RequirementRecord> {
    const request = checked(commands.reserve, input);
    return this.mutate("reserve", request, (db) => {
      const existing = db.read("requirement_requests", request.requestId);
      if (existing) {
        const reference = checked(RequestRecord, existing.data);
        if (reference.intentHash !== request.intentHash) throw new RequirementStateError("request_conflict");
        return this.get(db, reference.requirementId);
      }
      const requirementId = uuidv7(), now = this.now();
      if (db.read("requirements", requirementId)) throw new RequirementStateError("identity_collision");
      const data: RequirementRecord = { format: "requirement-lifecycle/v1", requirementId, repoId: this.options.repoId, ...request,
        lifecycle: "draft", revision: 0, epoch: 1, saved: null, approved: null, approvalReceiptId: null, workspace: null,
        pendingRevision: null, close: null, recovery: "ready", recoveryReason: null, createdAt: now, updatedAt: now };
      const stored = db.create("requirements", requirementId, data, requirementId);
      db.create("requirement_requests", request.requestId, { requirementId, intentHash: request.intentHash });
      db.append(eventStream(requirementId), checked(RequirementEvent, { requirementId, repoId: this.options.repoId, kind: "reserved", version: 1, epoch: 1, revision: 0, from: null, to: null, receiptId: null, recoveryReason: null }));
      return stored;
    });
  }
  read(requirementId: string): StoredRecord<RequirementRecord> {
    checked(id, requirementId); this.authorize("read", { requirementId });
    const path = this.path();
    if (!pathExists(path)) throw new RequirementStateError("unknown_requirement");
    const record = withDatabase(path, (db) => this.get(db, requirementId));
    this.authorize("read", { requirementId }); return record;
  }

  pmOwner(requirementId: string): PmRecord | null {
    checked(id, requirementId); this.authorize("read", { requirementId });
    if (!pathExists(this.path())) throw new RequirementStateError("unknown_requirement");
    const result = withDatabase(this.path(), (db) => { this.get(db, requirementId); return this.owner(db, requirementId)?.data ?? null; });
    this.authorize("read", { requirementId }); return result;
  }

  async bindWorkspace(input: Static<typeof commands.bind>): Promise<StoredRecord<RequirementRecord>> {
    const request = checked(commands.bind, input);
    this.authorize("bind-workspace", request);
    const binding = await inspectRequirementWorkspace(this.options.dataRoot, this.options.repoId, request);
    const head = (await readGit(binding.path, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== binding.baseCommit) throw new RequirementStateError("base_commit_changed");
    return this.mutate("bind-workspace", request, (db) => {
      const record = this.get(db, request.requirementId); this.active(record.data, true);
      if (record.data.workspace) {
        if (!equal(record.data.workspace, binding)) throw new RequirementStateError("workspace_already_bound");
        this.checkClaims(db, binding); return record;
      }
      this.version(record, request.version);
      for (const key of this.claimKeys(binding)) {
        const occupied = db.read("managed_workspace_claims", key);
        if (occupied) throw new RequirementStateError("workspace_occupied");
        db.create("managed_workspace_claims", key, { requirementId: record.id, workspaceId: binding.workspaceId });
      }
      return this.write(db, record, { ...record.data, workspace: binding }, "workspace.bound").record;
    });
  }
  private claimKeys(binding: WorkspaceBinding): string[] {
    return [`workspace:${binding.workspaceId}`, `branch:${binding.branch}`, `path:${createHash("sha256").update(binding.path).digest("hex")}`];
  }
  private checkClaims(db: LocalDatabase, binding: WorkspaceBinding): void {
    for (const key of this.claimKeys(binding)) {
      const stored = db.read("managed_workspace_claims", key);
      if (!stored) throw new RequirementStateError("workspace_claim_missing");
      const claim = checked(OwnerClaim, stored.data);
      if (claim.requirementId !== binding.requirementId || claim.workspaceId !== binding.workspaceId) throw new RequirementStateError("workspace_occupied");
    }
  }

  recordSavedVersion(input: Static<typeof commands.save>): StoredRecord<RequirementRecord> {
    const request = checked(commands.save, input);
    const digest = createHash("sha256").update(canonicalJson(request)).digest("hex");
    return this.mutate("saved-version", request, (db) => {
      const record = this.get(db, request.requirementId); this.active(record.data, true);
      const existing = db.read("requirement_operations", request.operationId);
      if (existing) {
        const operation = checked(Operation, existing.data);
        if (operation.requirementId !== record.id || operation.digest !== digest) throw new RequirementStateError("operation_conflict");
        return record;
      }
      this.version(record, request.version);
      if (equal(record.data.saved, request.reference)) {
        const existingSave = db.events(eventStream(record.id)).reverse().find((event) => {
          const data = checked(RequirementEvent, event.data);
          return data.requirementId === record.id && data.repoId === this.options.repoId && data.kind === "prod.saved" && equal(data.to, request.reference);
        });
        if (!existingSave) throw new RequirementStateError("saved_event_missing");
        db.create("requirement_operations", request.operationId, { requirementId: record.id, digest, sequence: existingSave.sequence });
        return record;
      }
      const result = this.write(db, record, { ...record.data, saved: request.reference }, "prod.saved", record.data.saved, request.reference);
      db.create("requirement_operations", request.operationId, { requirementId: record.id, digest, sequence: result.event.sequence });
      return result.record;
    });
  }
  async recordApprovedVersion(input: Static<typeof commands.approve>): Promise<StoredRecord<RequirementRecord>> {
    const request = checked(commands.approve, input); this.authorize("approved-version", request);
    if (this.options.authorizeManifest && !request.manifest) throw new RequirementStateError("manifest_required");
    const previous = this.read(request.requirementId);
    if (!previous.data.workspace) throw new RequirementStateError("workspace_not_ready");
    await verifyRequirementWorkspace(this.options.dataRoot, previous.data.workspace);
    // Core使用独立SQLite核验快照；作为写事务前最后一次授权，事务内不再调用宿主。
    const authorizeManifest = request.manifest ? () => {
      if (previous.data.approvalReceiptId === request.receiptId &&
        equal(previous.data.approvalManifest?.reference ?? null, request.manifest)) return;
      const allowed = this.options.authorizeManifest?.(deepFreeze({ requirementId: request.requirementId,
        version: request.version, receiptId: request.receiptId, manifest: structuredClone(request.manifest!) }));
      if (isPromise(allowed)) void Promise.prototype.then.call(allowed, () => undefined, () => undefined);
      if (allowed !== true) throw new RequirementStateError("manifest_authorization_required");
    } : undefined;
    const approvalTime = this.now();
    return this.mutate("approved-version", request, (db) => {
      const record = this.get(db, request.requirementId); this.active(record.data, true);
      if (!record.data.workspace || !equal(record.data.workspace, previous.data.workspace)) throw new RequirementStateError("workspace_binding_changed");
      this.checkClaims(db, record.data.workspace);
      if (!equal(record.data.saved, request.reference)) throw new RequirementStateError("saved_version_mismatch");
      const digest = createHash("sha256").update(canonicalJson(request)).digest("hex");
      const consumed = db.read("requirement_approval_uses", request.receiptId);
      if (consumed) {
        const use = checked(Operation, consumed.data);
        if (use.requirementId !== record.id || use.digest !== digest || record.data.approvalReceiptId !== request.receiptId || !equal(record.data.approved, request.reference) ||
          !equal(record.data.approvalManifest?.reference ?? null, request.manifest ?? null)) throw new RequirementStateError("approval_conflict");
        return record;
      }
      this.version(record, request.version);
      let approvalManifest;
      if (request.manifest) {
        const final = this.get(db, request.requirementId);
        if (final.version !== record.version || !equal(final.data, record.data)) throw new RequirementStateError("manifest_stale");
        approvalManifest = summarizeApprovalManifest(registeredApprovalManifestIn(db, this.options.repoId, request.manifest, final, request.receiptId));
      }
      const revision = increment(record.data.revision);
      const { approvalManifest: _previousManifest, ...baseline } = record.data;
      const result = this.write(db, record, { ...baseline, ...(approvalManifest ? { approvalManifest } : {}), lifecycle: "active", revision, approved: request.reference, approvalReceiptId: request.receiptId,
        pendingRevision: record.data.lifecycle === "active" ? revision : null }, "prod.approved", record.data.approved, request.reference, request.receiptId, approvalTime);
      db.create("requirement_approval_uses", request.receiptId, { requirementId: record.id, digest, sequence: result.event.sequence });
      return result.record;
    }, authorizeManifest);
  }

  async acquirePm(input: Static<typeof commands.acquire>): Promise<PmLease> {
    const request = checked(commands.acquire, input); this.authorize("acquire-pm", request);
    const previous = this.read(request.requirementId); this.active(previous.data);
    if (!previous.data.workspace) throw new RequirementStateError("workspace_not_ready");
    await verifyRequirementWorkspace(this.options.dataRoot, previous.data.workspace);
    return this.mutate("acquire-pm", request, (db) => {
      const record = this.get(db, request.requirementId); this.active(record.data); this.version(record, request.version);
      if (!record.data.workspace || !equal(record.data.workspace, previous.data.workspace)) throw new RequirementStateError("workspace_binding_changed");
      this.checkClaims(db, record.data.workspace);
      const owner = this.owner(db, record.id), now = this.now();
      if (owner?.data.lease && owner.data.lease.expiresAt > now) throw new RequirementStateError("pm_already_owned");
      if ((owner?.data.fence ?? 0) !== request.expectedFence) throw new RequirementStateError("stale_fence");
      const runClaim = db.read("pm_run_claims", request.runId);
      if (runClaim) {
        const claim = checked(OwnerClaim, runClaim.data);
        if (claim.requirementId !== record.id || claim.workspaceId !== record.data.workspace.workspaceId) throw new RequirementStateError("pm_run_already_bound");
      } else db.create("pm_run_claims", request.runId, { requirementId: record.id, workspaceId: record.data.workspace.workspaceId });
      const fence = increment(owner?.data.fence ?? 0);
      const contextGeneration = increment(owner?.data.context?.generation ?? 0);
      const lease = checked(PmLease, { requirementId: record.id, workspaceId: record.data.workspace.workspaceId, runId: request.runId,
        epoch: record.data.epoch, fence, contextGeneration, expiresAt: now + LEASE_MS });
      const context = checked(PmContext, { format: "pm-physical-context/v1", runId: request.runId, fence,
        generation: contextGeneration, baseline: null });
      const prodEvents = owner?.data.prodEvents ? { ...owner.data.prodEvents, baselineDelivery: null } : undefined;
      const ownership = { requirementId: record.id, fence: lease.fence, lease, context, seenSequence: owner?.data.seenSequence ?? 0,
        ...(prodEvents ? { prodEvents } : {}) };
      if (owner) db.update("pm_ownership", record.id, owner.version, ownership);
      else db.create("pm_ownership", record.id, ownership);
      this.write(db, record, record.data, "pm.acquired");
      return lease;
    });
  }
  private validateOwner(db: LocalDatabase, lease: PmLease, now = this.now()) {
    const record = this.get(db, lease.requirementId); this.active(record.data);
    const owner = this.owner(db, record.id);
    if (!owner?.data.lease || owner.data.fence !== lease.fence || owner.data.lease.runId !== lease.runId || record.data.epoch !== lease.epoch ||
      owner.data.lease.epoch !== lease.epoch || owner.data.lease.workspaceId !== lease.workspaceId ||
      owner.data.lease.contextGeneration !== lease.contextGeneration || owner.data.lease.expiresAt <= now ||
      !record.data.workspace || record.data.workspace.workspaceId !== lease.workspaceId) throw new RequirementStateError("stale_pm_lease");
    this.checkClaims(db, record.data.workspace);
    const runClaim = db.read("pm_run_claims", lease.runId);
    if (!runClaim || !equal(checked(OwnerClaim, runClaim.data), { requirementId: record.id, workspaceId: lease.workspaceId })) throw new RequirementStateError("pm_run_binding_changed");
    return { record, owner };
  }
  private async workspaceForLease(action: RequirementAction, lease: PmLease): Promise<void> {
    this.authorize(action, lease);
    const record = this.read(lease.requirementId); this.active(record.data);
    if (!record.data.workspace || record.data.workspace.workspaceId !== lease.workspaceId) throw new RequirementStateError("workspace_binding_changed");
    await verifyRequirementWorkspace(this.options.dataRoot, record.data.workspace);
  }
  async checkPm(input: PmLease): Promise<void> {
    const lease = checked(PmLease, input); await this.workspaceForLease("check-pm", lease);
    this.mutate("check-pm", lease, (db) => { this.validateOwner(db, lease); });
  }
  async checkScheduling(input: PmLease): Promise<void> {
    const lease = checked(PmLease, input); await this.workspaceForLease("check-scheduling", lease);
    this.mutate("check-scheduling", lease, (db) => {
      const { record } = this.validateOwner(db, lease);
      if (record.data.pendingRevision !== null) throw new RequirementStateError("pending_update");
    });
  }
  async renewPm(input: PmLease): Promise<PmLease> {
    const lease = checked(PmLease, input); await this.workspaceForLease("renew-pm", lease);
    return this.mutate("renew-pm", lease, (db) => {
      const { owner } = this.validateOwner(db, lease);
      const updated = checked(PmLease, { ...owner.data.lease!, expiresAt: this.now() + LEASE_MS });
      db.update("pm_ownership", lease.requirementId, owner.version, { ...owner.data, lease: updated }); return updated;
    });
  }
  releasePm(input: PmLease): void {
    const lease = checked(PmLease, input);
    this.mutate("release-pm", lease, (db) => { const { record } = this.validateOwner(db, lease); this.revoke(db, record.id); this.write(db, record, record.data, "pm.released"); });
  }

  async rotatePmContext(input: Static<typeof commands.rotateContext>): Promise<PmLease> {
    const request = checked(commands.rotateContext, input);
    await this.workspaceForLease("rotate-pm-context", request.lease);
    return this.mutate("rotate-pm-context", request, (db) => {
      const { owner } = this.validateOwner(db, request.lease);
      const contextGeneration = increment(request.lease.contextGeneration);
      const lease = checked(PmLease, { ...owner.data.lease!, contextGeneration });
      const context = checked(PmContext, { format: "pm-physical-context/v1", runId: lease.runId, fence: lease.fence,
        generation: contextGeneration, baseline: null });
      const cursor = this.eventCursor(owner);
      db.update("pm_ownership", lease.requirementId, owner.version, { ...owner.data, lease, context,
        prodEvents: { ...cursor, baselineDelivery: null } });
      return lease;
    });
  }

  async restoreApprovedContext(input: Static<typeof commands.restoreContext>): Promise<void> {
    const request = checked(commands.restoreContext, input);
    await this.workspaceForLease("restore-approved-context", request.lease);
    this.mutate("restore-approved-context", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      if (!record.data.approved || record.version !== request.version || record.data.epoch !== request.epoch ||
        record.data.revision !== request.revision || !equal(record.data.approved, request.reference)) {
        throw new RequirementStateError("baseline_changed");
      }
      const context = this.context(owner);
      const baseline = { runId: request.lease.runId, fence: request.lease.fence,
        contextGeneration: request.lease.contextGeneration, revision: request.revision, reference: request.reference,
        recordVersion: request.version, epoch: request.epoch };
      db.update("pm_ownership", request.lease.requirementId, owner.version, { ...owner.data,
        context: { ...context, baseline } });
    });
  }

  events(requirementId: string, after = 0) {
    checked(id, requirementId); checked(counter, after); this.authorize("events", { requirementId, after });
    if (!pathExists(this.path())) throw new RequirementStateError("unknown_requirement");
    const events = withDatabase(this.path(), (db) => {
      this.get(db, requirementId);
      return db.events(eventStream(requirementId), after).map((event) => {
        const data = checked(RequirementEvent, event.data);
        if (data.requirementId !== requirementId || data.repoId !== this.options.repoId) throw new RequirementStateError("event_identity_conflict");
        return { ...event, data };
      });
    });
    this.authorize("events", { requirementId, after }); return events;
  }
  async acknowledge(input: Static<typeof commands.acknowledge>): Promise<void> {
    const request = checked(commands.acknowledge, input); await this.workspaceForLease("acknowledge", request.lease);
    this.mutate("acknowledge", request, (db) => {
      const { owner } = this.validateOwner(db, request.lease);
      const current = owner.data.seenSequence;
      if (request.sequence <= current) return;
      const next = db.events(eventStream(request.lease.requirementId), current)[0];
      if (request.sequence !== current + 1 || next?.sequence !== request.sequence) throw new RequirementStateError("event_gap");
      const event = checked(RequirementEvent, next.data);
      if (event.requirementId !== request.lease.requirementId || event.repoId !== this.options.repoId) throw new RequirementStateError("event_identity_conflict");
      db.update("pm_ownership", request.lease.requirementId, owner.version, { ...owner.data, seenSequence: request.sequence });
      // 接收事件不是逐任务影响复核，不解除pendingRevision或改写历史验证输入。
    });
  }

  async nextApprovedEvent(input: Static<typeof commands.eventLease>): Promise<ApprovedEventPoll> {
    const request = checked(commands.eventLease, input);
    await this.workspaceForLease("deliver-approved-event", request.lease);
    return this.mutate("deliver-approved-event", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      if (!record.data.approved) throw new RequirementStateError("approved_version_missing");
      const cursor = this.eventCursor(owner);
      const all = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, all)) {
        const blocked = this.blockUnknownHistory(db, record);
        return { status: "recovery_required", reason: "history_unknown", cursor,
          version: blocked.version, epoch: blocked.data.epoch };
      }
      const next = all.find((event) => event.sequence > cursor.consumedSequence);
      const reason = this.baselineReason(record, owner, cursor, all);
      if (reason) return { status: "baseline_required", reason, cursor, revision: record.data.revision,
        reference: record.data.approved, version: record.version, epoch: record.data.epoch };
      if (!next) return { status: "caught_up", cursor };
      const redelivery = cursor.deliveredSequence >= next.sequence;
      const updated = { ...cursor, deliveredSequence: Math.max(cursor.deliveredSequence, next.sequence) };
      if (!equal(updated, cursor)) this.putEventCursor(db, owner, updated);
      return { status: "event", eventId: next.id, sequence: next.sequence, redelivery, event: next.data, cursor: updated };
    });
  }

  async approvedBaselineRequirement(input: Static<typeof commands.eventLease>): Promise<
    Extract<ApprovedEventPoll, { status: "baseline_required" | "recovery_required" }>
  > {
    const request = checked(commands.eventLease, input);
    await this.workspaceForLease("check-approved-return", request.lease);
    return this.mutate("check-approved-return", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      if (!record.data.approved) throw new RequirementStateError("approved_version_missing");
      const cursor = this.eventCursor(owner);
      const all = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, all)) {
        const blocked = this.blockUnknownHistory(db, record);
        return { status: "recovery_required" as const, reason: "history_unknown" as const, cursor,
          version: blocked.version, epoch: blocked.data.epoch };
      }
      const reason = this.baselineReason(record, owner, cursor, all);
      if (!reason) throw new RequirementStateError("baseline_not_required");
      return { status: "baseline_required" as const, reason, cursor, revision: record.data.revision,
        reference: record.data.approved, version: record.version, epoch: record.data.epoch };
    });
  }

  async issueApprovedBaseline(input: Static<typeof commands.issueBaseline>): Promise<BaselineDeliveryData> {
    const request = checked(commands.issueBaseline, input);
    await this.workspaceForLease("issue-approved-baseline", request.lease);
    const result = this.mutate("issue-approved-baseline", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      if (!record.data.approved || record.version !== request.version || record.data.epoch !== request.epoch ||
        record.data.revision !== request.revision || !equal(record.data.approved, request.reference)) {
        throw new RequirementStateError("baseline_changed");
      }
      const cursor = this.eventCursor(owner);
      const events = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, events)) {
        this.blockUnknownHistory(db, record);
        return null;
      }
      const reason = this.baselineReason(record, owner, cursor, events);
      if (!reason) throw new RequirementStateError("baseline_not_required");
      const mode = reason === "context_missing" ? "context_refresh" as const : "cursor_recovery" as const;
      const throughSequence = events.at(-1)!.sequence;
      const existing = cursor.baselineDelivery;
      const delivery = existing && existing.throughSequence === throughSequence && existing.revision === request.revision &&
        existing.recordVersion === request.version && existing.epoch === request.epoch && existing.runId === request.lease.runId &&
        existing.fence === request.lease.fence && existing.contextGeneration === request.lease.contextGeneration &&
        existing.mode === mode && equal(existing.reference, request.reference)
        ? existing
        : checked(BaselineDelivery, {
          deliveryId: uuidv7(), throughSequence, revision: request.revision, reference: request.reference,
          recordVersion: request.version, epoch: request.epoch, runId: request.lease.runId, fence: request.lease.fence,
          contextGeneration: request.lease.contextGeneration, mode,
        });
      const updated: PmEventCursorData = { ...cursor,
        deliveredSequence: mode === "cursor_recovery" ? Math.max(cursor.deliveredSequence, throughSequence) : cursor.deliveredSequence,
        baselineDelivery: delivery };
      if (!equal(updated, cursor)) this.putEventCursor(db, owner, updated);
      return delivery;
    });
    if (!result) throw new RequirementStateError("recovery_required");
    return result;
  }

  checkApprovedBaselineReturnSync(input: Static<typeof BaselineReturn>): void {
    const request = checked(BaselineReturn, input);
    const valid = this.finalCheck("check-approved-return", request, (db, now) => {
      const { record, owner } = this.validateOwner(db, request.lease, now);
      const cursor = this.eventCursor(owner);
      const events = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, events)) {
        this.blockUnknownHistory(db, record, now);
        return false;
      }
      const delivery = cursor.baselineDelivery;
      if (!delivery || delivery.deliveryId !== request.deliveryId || delivery.runId !== request.lease.runId ||
        delivery.fence !== request.lease.fence || delivery.contextGeneration !== request.lease.contextGeneration ||
        !record.data.approved || record.version !== request.version || record.version !== delivery.recordVersion ||
        record.data.epoch !== request.epoch || record.data.epoch !== delivery.epoch ||
        record.data.revision !== request.revision || record.data.revision !== delivery.revision ||
        !equal(record.data.approved, request.reference) || !equal(record.data.approved, delivery.reference)) {
        throw new RequirementStateError("stale_baseline_delivery");
      }
      return true;
    });
    if (!valid) throw new RequirementStateError("recovery_required");
  }

  async acknowledgeApprovedBaseline(input: Static<typeof commands.acknowledgeBaseline>): Promise<void> {
    const request = checked(commands.acknowledgeBaseline, input);
    await this.workspaceForLease("acknowledge-approved-event", request.lease);
    const valid = this.mutate("acknowledge-approved-event", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      const cursor = this.eventCursor(owner);
      const events = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, events)) {
        this.blockUnknownHistory(db, record);
        return false;
      }
      const delivery = cursor.baselineDelivery;
      if (!delivery || delivery.deliveryId !== request.deliveryId || delivery.runId !== request.lease.runId ||
        delivery.fence !== request.lease.fence || delivery.contextGeneration !== request.lease.contextGeneration ||
        !record.data.approved || record.version !== delivery.recordVersion || record.data.epoch !== delivery.epoch ||
        record.data.revision !== delivery.revision || !equal(record.data.approved, delivery.reference)) {
        throw new RequirementStateError("stale_baseline_delivery");
      }
      if (delivery.mode === "cursor_recovery" && cursor.consumedSequence > delivery.throughSequence) {
        throw new RequirementStateError("stale_baseline_delivery");
      }
      const updatedCursor: PmEventCursorData = delivery.mode === "cursor_recovery"
        ? { ...cursor, consumedSequence: delivery.throughSequence,
          deliveredSequence: Math.max(cursor.deliveredSequence, delivery.throughSequence),
          understoodRevision: delivery.revision, understood: delivery.reference }
        : cursor;
      const context = this.context(owner);
      const baseline = { runId: request.lease.runId, fence: request.lease.fence,
        contextGeneration: request.lease.contextGeneration, revision: delivery.revision, reference: delivery.reference,
        recordVersion: delivery.recordVersion, epoch: delivery.epoch };
      const updated = { ...owner.data, context: { ...context, baseline }, prodEvents: updatedCursor };
      if (!equal(updated, owner.data)) db.update("pm_ownership", request.lease.requirementId, owner.version, updated);
      // 上下文基线确认与持久消费位置分开；context_refresh不会倒退或跳过逻辑事件。
      return true;
    });
    if (!valid) throw new RequirementStateError("recovery_required");
  }

  checkApprovedEventReturnSync(input: Static<typeof EventReturn>): void {
    const request = checked(EventReturn, input);
    const valid = this.finalCheck("check-approved-return", request, (db, now) => {
      const { record, owner } = this.validateOwner(db, request.lease, now);
      const cursor = this.eventCursor(owner);
      const events = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, events)) {
        this.blockUnknownHistory(db, record, now);
        return false;
      }
      const event = events.find((candidate) => candidate.sequence === request.sequence);
      const nextSequence = events.find((candidate) => candidate.sequence > cursor.consumedSequence)?.sequence;
      if (record.version !== request.version || record.data.epoch !== request.epoch ||
        cursor.consumedSequence >= request.sequence || cursor.deliveredSequence < request.sequence ||
        request.sequence !== nextSequence || !event || event.id !== request.eventId ||
        event.data.fromRevision !== request.fromRevision || event.data.toRevision !== request.toRevision ||
        !equal(event.data.from, request.from) || !equal(event.data.to, request.to) ||
        !this.contextHasUsableBaseline(record, owner, cursor)) {
        throw new RequirementStateError("stale_event_delivery");
      }
      return true;
    });
    if (!valid) throw new RequirementStateError("recovery_required");
  }

  async acknowledgeApprovedEvent(input: Static<typeof commands.acknowledgeApproved>): Promise<void> {
    const request = checked(commands.acknowledgeApproved, input);
    await this.workspaceForLease("acknowledge-approved-event", request.lease);
    const valid = this.mutate("acknowledge-approved-event", request, (db) => {
      const { record, owner } = this.validateOwner(db, request.lease);
      const cursor = this.eventCursor(owner);
      const events = this.approvedEvents(db, record.id);
      if (this.historyUnknown(record, cursor, events)) {
        this.blockUnknownHistory(db, record);
        return false;
      }
      const event = events.find((candidate) => candidate.sequence === request.sequence);
      if (!event || event.id !== request.eventId || event.data.toRevision !== request.revision ||
        !equal(event.data.to, request.reference)) throw new RequirementStateError("event_identity_conflict");
      if (request.sequence <= cursor.consumedSequence) return true;
      const nextSequence = events.find((candidate) => candidate.sequence > cursor.consumedSequence)?.sequence;
      if (request.sequence !== nextSequence || cursor.deliveredSequence < request.sequence ||
        cursor.understoodRevision !== event.data.fromRevision || !equal(cursor.understood, event.data.from) ||
        !this.contextHasUsableBaseline(record, owner, cursor)) throw new RequirementStateError("event_gap");
      const updatedCursor = { ...cursor, consumedSequence: request.sequence,
        understoodRevision: event.data.toRevision, understood: event.data.to };
      const context = this.context(owner);
      const baseline = { runId: request.lease.runId, fence: request.lease.fence,
        contextGeneration: request.lease.contextGeneration, revision: event.data.toRevision, reference: event.data.to,
        recordVersion: event.data.recordVersion, epoch: request.lease.epoch };
      db.update("pm_ownership", request.lease.requirementId, owner.version, { ...owner.data,
        context: { ...context, baseline }, prodEvents: updatedCursor });
      // 消费确认推进逻辑cursor与本次物理上下文基线，不解除pendingRevision、不派worker或改写验证证据。
      return true;
    });
    if (!valid) throw new RequirementStateError("recovery_required");
  }

  async approvedEventCursor(input: Static<typeof commands.eventLease>): Promise<PmEventCursorData> {
    const request = checked(commands.eventLease, input);
    await this.workspaceForLease("check-approved-return", request.lease);
    return this.mutate("check-approved-return", request, (db) => {
      const { owner } = this.validateOwner(db, request.lease);
      return this.eventCursor(owner);
    });
  }

  /** 已确认更新的逐任务影响复核：全部任务不再 unknown 才解除 pendingRevision；记录本身不改写历史验证输入。 */
  async assessUpdate(input: Static<typeof commands.assess>): Promise<StoredRecord<RequirementRecord>> {
    const request = checked(commands.assess, input);
    await this.workspaceForLease("assess-update", request.lease);
    return this.mutate("assess-update", request, (db) => {
      const { record } = this.validateOwner(db, request.lease);
      this.version(record, request.version);
      if (record.data.pendingRevision !== request.revision || record.data.revision !== request.revision || !record.data.approved) throw new RequirementStateError("assessment_conflict");
      const existing = db.read<{ requirementId: string; toRevision: number }>("impact_assessments", request.assessmentId);
      if (existing) {
        if (existing.data.requirementId !== record.id || existing.data.toRevision !== request.revision) throw new RequirementStateError("assessment_conflict");
        return record;
      }
      const unknown = request.tasks.filter((task) => task.impact === "unknown").length;
      db.create("impact_assessments", request.assessmentId, { requirementId: record.id, fromRevision: request.revision - 1, toRevision: request.revision,
        toHash: record.data.approved.hash, tasks: request.tasks, unknown, runId: request.lease.runId, fence: request.lease.fence, at: this.now() });
      if (unknown > 0) return record;
      return this.write(db, record, { ...record.data, pendingRevision: null }, "update.assessed", null, record.data.approved).record;
    });
  }
  /** guard 在同一事务内以同步数据库依据再核对关闭前提并登记关闭意图；任一依据变化则本次关闭不生效。 */
  beginClose(input: Static<typeof commands.close>, guard?: (db: LocalDatabase) => void): StoredRecord<RequirementRecord> {
    const request = checked(commands.close, input);
    return this.mutate("begin-close", request, (db) => {
      const record = this.get(db, request.requirementId);
      if (record.data.close) {
        if (!equal(record.data.close, request.intent)) throw new RequirementStateError("close_intent_conflict");
        return record;
      }
      this.active(record.data, true); this.version(record, request.version);
      guard?.(db);
      if (request.intent.reason === "completed") {
        if (!record.data.approved || record.data.pendingRevision !== null) throw new RequirementStateError("completion_blocked");
        assertNoRequirementWriteClaimIn(db, this.options.repoId, record.id);
        assertNoUnfinishedRequirementOperationsIn(db, record.id);
      } else {
        releaseDeadRequirementWriteIn(db, this.options.repoId, record.id);
      }
      // 先结束受管写入窗口，才提交关闭意图；与写占用的获取共用同库事务互斥。
      assertNoRequirementWriteClaimIn(db, this.options.repoId, record.id);
      this.revoke(db, record.id);
      return this.write(db, record, { ...record.data, lifecycle: "closing", epoch: increment(record.data.epoch), close: request.intent }, "closing", null, null, request.intent.receiptId).record;
    });
  }
  finishClose(input: Static<typeof commands.finish>): StoredRecord<RequirementRecord> {
    const request = checked(commands.finish, input);
    return this.mutate("finish-close", request, (db) => {
      const record = this.get(db, request.requirementId);
      if (!record.data.close || record.data.close.operationId !== request.operationId) throw new RequirementStateError("close_intent_conflict");
      if (record.data.lifecycle === "closed") return record;
      if (record.data.lifecycle !== "closing" || record.data.recovery !== "ready") throw new RequirementStateError("lifecycle_denied");
      this.version(record, request.version);
      if (this.owner(db, record.id)?.data.lease) throw new RequirementStateError("pm_not_revoked");
      releaseDeadRequirementWriteIn(db, this.options.repoId, record.id);
      assertNoRequirementWriteClaimIn(db, this.options.repoId, record.id);
      return this.write(db, record, { ...record.data, lifecycle: "closed" }, "closed", null, null, record.data.close.receiptId).record;
    });
  }
  blockForRecovery(input: Static<typeof commands.block>): StoredRecord<RequirementRecord> {
    const request = checked(commands.block, input);
    return this.mutate("block-recovery", request, (db) => {
      const record = this.get(db, request.requirementId); this.version(record, request.version);
      if (record.data.recovery === "needs_review") {
        if (record.data.recoveryReason === request.reason || record.data.recoveryReason === "identity_conflict" || request.reason !== "identity_conflict") return record;
        return this.write(db, record, { ...record.data, recoveryReason: "identity_conflict" }, "recovery.blocked").record;
      }
      this.revoke(db, record.id);
      return this.write(db, record, { ...record.data, recovery: "needs_review", recoveryReason: request.reason, epoch: increment(record.data.epoch) }, "recovery.blocked").record;
    });
  }
}
