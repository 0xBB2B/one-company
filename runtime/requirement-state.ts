import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import type { Static } from "typebox";
import { LocalDatabase, repositoryDatabase, StaleVersionError, uuidv7, withDatabase } from "./database.ts";
import type { StoredRecord, SyncResult } from "./database.ts";
import { pathExists, assertDataRootOutsideWorktrees } from "./database-paths.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { canonicalJson } from "./strict-json.ts";
import type { JsonValue } from "./strict-json.ts";
import { checked, checkRequirement, commands, hash, id, object, counter, positive, OwnerClaim, PmRecord, PmLease, RequestRecord, RequirementEvent, RequirementStateError } from "./requirement-contracts.ts";
import type { RequirementRecord, ProdReference, WorkspaceBinding } from "./requirement-contracts.ts";
import { inspectRequirementWorkspace, verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { readGit } from "./git-read.ts";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn, releaseDeadRequirementWriteIn } from "./requirement-coordination.ts";

export type RequirementAction = "open" | "reserve" | "read" | "saved-version" | "approved-version" | "bind-workspace" | "acquire-pm" | "renew-pm" | "release-pm" | "check-pm" | "check-scheduling" | "events" | "acknowledge" | "begin-close" | "finish-close" | "block-recovery" | "record-decisions" | "read-decisions";
export interface StateAuthorizationRequest { action: RequirementAction; repoId: string; input: Readonly<Record<string, unknown>> }
export interface RequirementStoreOptions {
  dataRoot: string;
  repoId: string;
  repositoryRoot: string;
  /** 可信宿主提供同步核验；必须核对真实主体及所引用的批准/保存/准备/收尾凭据，不得从模型参数自报身份。 */
  authorize?: (request: StateAuthorizationRequest) => boolean;
  now?: () => number;
}
const LEASE_MS = 30_000;
const Operation = object({ requirementId: id, digest: hash, sequence: positive });
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
  private mutate<T>(action: RequirementAction, input: Record<string, unknown>, operation: (db: LocalDatabase) => T & SyncResult<T>): T {
    this.authorize(action, input);
    return withDatabase(this.path(), (db) => db.transaction<T>(() => {
      this.authorize(action, input);
      const result = operation(db);
      this.authorize(action, input);
      return result;
    }));
  }
  private active(record: RequirementRecord, allowDraft = false): void {
    if (record.recovery !== "ready") throw new RequirementStateError("recovery_required");
    if (record.lifecycle !== "active" && !(allowDraft && record.lifecycle === "draft")) throw new RequirementStateError("lifecycle_denied");
  }
  private version(record: StoredRecord, expected: number): void { if (record.version !== expected) throw new StaleVersionError(); }
  private write(db: LocalDatabase, record: StoredRecord<RequirementRecord>, data: RequirementRecord, kind: RequirementEvent["kind"], from: ProdReference | null = null, to: ProdReference | null = null, receiptId: string | null = null) {
    data.updatedAt = Math.max(data.updatedAt, this.now());
    checkRequirement(data, data.requirementId, this.options.repoId);
    const version = db.update("requirements", data.requirementId, record.version, data);
    const event = checked(RequirementEvent, { requirementId: data.requirementId, repoId: data.repoId, kind, version, epoch: data.epoch, revision: data.revision, from, to, receiptId, recoveryReason: data.recoveryReason });
    const queued = db.append(eventStream(data.requirementId), event);
    return { record: { id: record.id, version, data }, event: queued };
  }
  private owner(db: LocalDatabase, requirementId: string) {
    const stored = db.read("pm_ownership", requirementId);
    if (!stored) return null;
    const data = checked(PmRecord, stored.data);
    if (data.requirementId !== requirementId || (data.lease && (data.lease.requirementId !== requirementId || data.lease.fence !== data.fence))) throw new RequirementStateError("invalid_pm_owner");
    return { ...stored, data };
  }
  private revoke(db: LocalDatabase, requirementId: string): void {
    const owner = this.owner(db, requirementId);
    if (owner) db.update("pm_ownership", requirementId, owner.version, { ...owner.data, fence: increment(owner.data.fence), lease: null });
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
    const previous = this.read(request.requirementId);
    if (!previous.data.workspace) throw new RequirementStateError("workspace_not_ready");
    await verifyRequirementWorkspace(this.options.dataRoot, previous.data.workspace);
    return this.mutate("approved-version", request, (db) => {
      const record = this.get(db, request.requirementId); this.active(record.data, true);
      if (!record.data.workspace || !equal(record.data.workspace, previous.data.workspace)) throw new RequirementStateError("workspace_binding_changed");
      this.checkClaims(db, record.data.workspace);
      if (!equal(record.data.saved, request.reference)) throw new RequirementStateError("saved_version_mismatch");
      const digest = createHash("sha256").update(canonicalJson(request)).digest("hex");
      const consumed = db.read("requirement_approval_uses", request.receiptId);
      if (consumed) {
        const use = checked(Operation, consumed.data);
        if (use.requirementId !== record.id || use.digest !== digest || record.data.approvalReceiptId !== request.receiptId || !equal(record.data.approved, request.reference)) throw new RequirementStateError("approval_conflict");
        return record;
      }
      this.version(record, request.version);
      const revision = increment(record.data.revision);
      const result = this.write(db, record, { ...record.data, lifecycle: "active", revision, approved: request.reference, approvalReceiptId: request.receiptId,
        pendingRevision: record.data.lifecycle === "active" ? revision : null }, "prod.approved", record.data.approved, request.reference, request.receiptId);
      db.create("requirement_approval_uses", request.receiptId, { requirementId: record.id, digest, sequence: result.event.sequence });
      return result.record;
    });
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
      const lease = checked(PmLease, { requirementId: record.id, workspaceId: record.data.workspace.workspaceId, runId: request.runId, epoch: record.data.epoch,
        fence: increment(owner?.data.fence ?? 0), expiresAt: now + LEASE_MS });
      const ownership = { requirementId: record.id, fence: lease.fence, lease, seenSequence: owner?.data.seenSequence ?? 0 };
      if (owner) db.update("pm_ownership", record.id, owner.version, ownership);
      else db.create("pm_ownership", record.id, ownership);
      this.write(db, record, record.data, "pm.acquired");
      return lease;
    });
  }
  private validateOwner(db: LocalDatabase, lease: PmLease) {
    const record = this.get(db, lease.requirementId); this.active(record.data);
    const owner = this.owner(db, record.id);
    if (!owner?.data.lease || owner.data.fence !== lease.fence || owner.data.lease.runId !== lease.runId || record.data.epoch !== lease.epoch ||
      owner.data.lease.epoch !== lease.epoch || owner.data.lease.workspaceId !== lease.workspaceId || owner.data.lease.expiresAt <= this.now() || !record.data.workspace || record.data.workspace.workspaceId !== lease.workspaceId) throw new RequirementStateError("stale_pm_lease");
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

  beginClose(input: Static<typeof commands.close>): StoredRecord<RequirementRecord> {
    const request = checked(commands.close, input);
    return this.mutate("begin-close", request, (db) => {
      const record = this.get(db, request.requirementId);
      if (record.data.close) {
        if (!equal(record.data.close, request.intent)) throw new RequirementStateError("close_intent_conflict");
        return record;
      }
      this.active(record.data, true); this.version(record, request.version);
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
      if (record.data.recovery === "needs_review") return record;
      this.revoke(db, record.id);
      return this.write(db, record, { ...record.data, recovery: "needs_review", recoveryReason: request.reason, epoch: increment(record.data.epoch) }, "recovery.blocked").record;
    });
  }
}
