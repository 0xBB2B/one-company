import { existsSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { checkRequirement, commit, counter, hash, id, object, positive } from "./requirement-contracts.ts";
import type { PrdReference, RequirementRecord } from "./requirement-contracts.ts";
import { prdRequirementPath, settleAbandonedSave } from "./prd-storage.ts";
import type { PrdRepositoryIdentity, PrdStorageConfig, PrdStorageWriteResult } from "./prd-storage.ts";
import { archivePathFor } from "./requirement-identity.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";
import {
  REQUIREMENT_OPERATION_NAMESPACE,
  assertRequirementWriteOwnedIn,
  claimRequirementWriteIn,
  processIsAlive,
  readRequirementWriteClaimIn,
  releaseDeadRequirementWriteIn,
  releaseRequirementWriteIn,
} from "./requirement-coordination.ts";
import type { RequirementWriteOwner } from "./requirement-coordination.ts";
import { PRD_ARCHIVE_DIRECTORY } from "../../core/policy/content-policy.ts";
import { draftLineViewIn, latestSaveAnchorIn } from "./line-anchors.ts";
import { recordSavedIn } from "./requirement-state.ts";

const OPERATION_ANCHORS = "line_operation_anchors";

const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const action = Type.Union([Type.Literal("create"), Type.Literal("updateDraft")]);
const identity = object({ dev: counter, ino: positive });
const gitResult = object({
  status: Type.Union([Type.Literal("created"), Type.Literal("saved"), Type.Literal("unchanged"), Type.Literal("recovered")]),
  commit,
  parent: nullable(commit),
  hash,
  changed: Type.Boolean(),
  repositoryRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  repositoryIdentity: identity,
});
const operationSchema = object({
  format: Type.Literal("requirement-service-operation/v1"),
  operationId: id,
  action,
  repoId: hash,
  requestId: nullable(id),
  requirementId: id,
  intentHash: hash,
  targetHash: hash,
  expectedParent: nullable(commit),
  saveVersion: positive,
  epoch: positive,
  archivePath: Type.String({ minLength: 1, maxLength: 1024 }),
  repositoryRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  expectedRepositoryIdentity: nullable(identity),
  git: nullable(gitResult),
  savedVersion: nullable(positive),
  finalVersion: nullable(positive),
  createdAt: counter,
  updatedAt: counter,
});

export type RequirementOperationAction = "create" | "updateDraft";
export interface RequirementOperation {
  format: "requirement-service-operation/v1";
  operationId: string;
  action: RequirementOperationAction;
  repoId: string;
  requestId: string | null;
  requirementId: string;
  intentHash: string;
  targetHash: string;
  expectedParent: string | null;
  saveVersion: number;
  epoch: number;
  archivePath: string;
  repositoryRoot: string;
  expectedRepositoryIdentity: PrdRepositoryIdentity | null;
  git: {
    status: PrdStorageWriteResult["status"];
    commit: string;
    parent: string | null;
    hash: string;
    changed: boolean;
    repositoryRoot: string;
    repositoryIdentity: PrdRepositoryIdentity;
  } | null;
  savedVersion: number | null;
  finalVersion: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PrepareRequirementOperation {
  operationId: string;
  action: RequirementOperationAction;
  repoId: string;
  requestId: string | null;
  requirementId: string;
  intentHash: string;
  targetHash: string;
  expectedParent: string | null;
  line: readonly string[];
  lineVersion: number;
  epoch: number;
  archivePath: string;
  repositoryRoot: string;
  expectedRepositoryIdentity: PrdRepositoryIdentity | null;
}

const NAMESPACE = REQUIREMENT_OPERATION_NAMESPACE;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkOperation(value: unknown): RequirementOperation {
  if (!Value.Check(operationSchema, value)) throw new RequirementServiceError("operation_corrupt", "持久操作记录格式冲突");
  const operation = value as RequirementOperation;
  const archivePrefix = `${PRD_ARCHIVE_DIRECTORY}/${operation.requirementId}.`;
  const archiveTitle = operation.archivePath.startsWith(archivePrefix) && operation.archivePath.endsWith(".md")
    ? operation.archivePath.slice(archivePrefix.length, -3)
    : null;
  let validArchive = false;
  if (archiveTitle !== null) {
    try { validArchive = archivePathFor(operation.requirementId, archiveTitle) === operation.archivePath; }
    catch { validArchive = false; }
  }
  const gitConsistent = operation.git === null || (
    operation.git.hash === operation.targetHash
    && operation.git.parent === operation.expectedParent
    && operation.git.repositoryRoot === operation.repositoryRoot
    && (operation.expectedRepositoryIdentity === null || same(operation.expectedRepositoryIdentity, operation.git.repositoryIdentity))
  );
  if (!validArchive
    || (operation.action === "create") !== (operation.requestId !== null)
    || operation.updatedAt < operation.createdAt
    || !gitConsistent
    || (operation.savedVersion !== null && operation.git === null)
    || (operation.finalVersion !== null && operation.savedVersion === null)) {
    throw new RequirementServiceError("operation_corrupt", "持久操作记录内部关系冲突");
  }
  return operation;
}

function mutableFields(input: Omit<PrepareRequirementOperation, "line" | "lineVersion">) {
  return {
    operationId: input.operationId,
    action: input.action,
    repoId: input.repoId,
    requestId: input.requestId,
    requirementId: input.requirementId,
    intentHash: input.intentHash,
    targetHash: input.targetHash,
    expectedParent: input.expectedParent,
    epoch: input.epoch,
    archivePath: input.archivePath,
    repositoryRoot: input.repositoryRoot,
    expectedRepositoryIdentity: input.expectedRepositoryIdentity,
  };
}

function gitRecordOf(result: PrdStorageWriteResult): NonNullable<RequirementOperation["git"]> {
  return {
    status: result.status,
    commit: result.commit,
    parent: result.changed ? result.parent : result.commit,
    hash: result.prdHash.slice("sha256:".length),
    changed: result.changed,
    repositoryRoot: result.repositoryRoot,
    repositoryIdentity: result.repositoryIdentity,
  };
}

function available(requirement: RequirementRecord): void {
  if (requirement.recovery !== "ready") throw new RequirementServiceError("recovery_required");
  if (requirement.lifecycle !== "draft" && requirement.lifecycle !== "active") throw new RequirementServiceError("lifecycle_denied");
}

export class RequirementOperations {
  private readonly path: string;
  private readonly repoId: string;
  private readonly dataRoot: string;
  private readonly now: () => number;

  constructor(options: { dataRoot: string; repoId: string; now?: () => number }) {
    this.path = repositoryDatabase(options.dataRoot, options.repoId);
    this.repoId = options.repoId;
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? Date.now;
  }

  private readIn(db: LocalDatabase, operationId: string): StoredRecord<RequirementOperation> | null {
    const stored = db.read(NAMESPACE, operationId);
    if (!stored) return null;
    const data = checkOperation(stored.data);
    const expectedRoot = prdRequirementPath({ dataRoot: this.dataRoot, repoId: this.repoId, requirementId: data.requirementId });
    if (stored.id !== operationId || data.operationId !== operationId || data.repoId !== this.repoId || data.repositoryRoot !== expectedRoot) {
      throw new RequirementServiceError("operation_conflict");
    }
    return { ...stored, data };
  }

  read(operationId: string): StoredRecord<RequirementOperation> | null {
    return withDatabase(this.path, (db) => this.readIn(db, operationId));
  }

  prepare(input: PrepareRequirementOperation, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const existing = this.readIn(db, input.operationId);
      if (existing) {
        if (!same(mutableFields(existing.data), mutableFields(input))) throw new RequirementServiceError("operation_conflict");
        if (existing.data.finalVersion === null) {
          const otherPending = db.list(NAMESPACE)
            .map((stored) => checkOperation(stored.data))
            .some((operation) => operation.requirementId === input.requirementId && operation.operationId !== input.operationId && operation.finalVersion === null);
          if (otherPending) throw new RequirementServiceError("requirement_write_pending");
          claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId: input.requirementId, operationId: input.operationId, acquiredAt: this.checkedNow() }, { allowDeadOriginalOperationRecovery: true });
        }
        return existing;
      }
      if (!db.read("requirements", input.requirementId)) throw new RequirementServiceError("unknown_requirement");
      for (const stored of db.list(NAMESPACE)) {
        const operation = checkOperation(stored.data);
        if (operation.requirementId !== input.requirementId || operation.finalVersion !== null) continue;
        const claim = readRequirementWriteClaimIn(db, this.repoId, input.requirementId);
        if (claim !== null && processIsAlive(claim.data.pid)) throw new RequirementServiceError("requirement_write_busy");
        this.settleAbandoned(db, { ...stored, data: operation });
      }
      releaseDeadRequirementWriteIn(db, this.repoId, input.requirementId);
      if (readRequirementWriteClaimIn(db, this.repoId, input.requirementId)) {
        throw new RequirementServiceError("requirement_write_pending");
      }
      const requirementStored = db.read("requirements", input.requirementId)!;
      const requirement = checkRequirement(requirementStored.data, input.requirementId, input.repoId);
      available(requirement);
      const view = draftLineViewIn(db, { version: requirementStored.version, data: requirement }, input.line);
      if (view.version !== input.lineVersion) throw new RequirementServiceError("stale_version");
      if (requirement.epoch !== input.epoch) throw new RequirementServiceError("epoch_changed");
      if (view.fileCommit !== input.expectedParent) throw new RequirementServiceError("saved_version_changed");
      const now = this.checkedNow();
      const { line: _line, lineVersion: _lineVersion, ...fields } = input;
      const data: RequirementOperation = {
        format: "requirement-service-operation/v1",
        ...fields,
        saveVersion: requirementStored.version,
        git: null,
        savedVersion: null,
        finalVersion: null,
        createdAt: now,
        updatedAt: now,
      };
      checkOperation(data);
      const stored = db.create(NAMESPACE, input.operationId, data, input.operationId);
      const unchangedTip = input.action === "updateDraft" && view.saved?.hash === input.targetHash
        ? requirement.lifecycle === "draft" ? view.tip : latestSaveAnchorIn(db, input.requirementId)
        : null;
      db.create(OPERATION_ANCHORS, input.operationId, { format: "line-operation-anchor/v1", requirementId: input.requirementId, anchor: uuidv7(), unchangedTip: unchangedTip?.anchor ?? null, parent: view.tip?.anchor ?? null });
      claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId: input.requirementId, operationId: input.operationId, acquiredAt: now }, { allowDeadOriginalOperationRecovery: false });
      return stored;
    }));
  }

  async settleAbandonedGit(requirementId: string, currentOperationId: string, configOf: (operation: RequirementOperation, validateOwned: () => void) => PrdStorageConfig): Promise<void> {
    if (!existsSync(this.path)) return;
    const candidates = withDatabase(this.path, (db) => {
      const claim = readRequirementWriteClaimIn(db, this.repoId, requirementId);
      if (claim !== null && processIsAlive(claim.data.pid)) return [];
      return db.list(NAMESPACE)
        .map((stored) => checkOperation(stored.data))
        .filter((operation) => operation.requirementId === requirementId && operation.operationId !== currentOperationId && operation.finalVersion === null && operation.git === null && db.read(OPERATION_ANCHORS, operation.operationId) !== null);
    });
    for (const operation of candidates) {
      const owner: RequirementWriteOwner = { ownerToken: uuidv7(), pid: process.pid };
      withDatabase(this.path, (db) => db.transaction(() => {
        releaseDeadRequirementWriteIn(db, this.repoId, requirementId);
        try {
          claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId, operationId: operation.operationId, acquiredAt: this.checkedNow() }, { allowDeadOriginalOperationRecovery: false });
        } catch (error) {
          if ((error as { code?: unknown }).code === "requirement_write_pending") throw new RequirementServiceError("requirement_write_busy");
          throw error;
        }
      }));
      try {
        const fresh = withDatabase(this.path, (db) => {
          const stored = this.readIn(db, operation.operationId);
          return stored && stored.data.finalVersion === null && stored.data.git === null ? db.read<{ anchor: string }>(OPERATION_ANCHORS, operation.operationId)?.data.anchor ?? null : null;
        });
        if (fresh === null) continue;
        const config = configOf(operation, () => { this.assertOwned(operation.operationId, owner); });
        const anchor = withDatabase(this.path, (db) => db.read<{ anchor: string }>(OPERATION_ANCHORS, operation.operationId))?.data.anchor;
        if (anchor === undefined) continue;
        const result = await settleAbandonedSave({
          ...config,
          operationId: operation.operationId,
          anchor,
          action: operation.action,
          expectedParent: operation.expectedParent,
          prdHash: `sha256:${operation.targetHash}`,
        });
        if (!result) continue;
        withDatabase(this.path, (db) => db.transaction(() => {
          const stored = this.readIn(db, operation.operationId);
          if (!stored || stored.data.git !== null) return;
          assertRequirementWriteOwnedIn(db, this.repoId, requirementId, operation.operationId, owner);
          const updated = { ...stored.data, git: gitRecordOf(result), updatedAt: Math.max(stored.data.updatedAt, this.checkedNow()) };
          checkOperation(updated);
          db.update(NAMESPACE, operation.operationId, stored.version, updated);
        }));
      } finally {
        withDatabase(this.path, (db) => db.transaction(() => {
          const claim = readRequirementWriteClaimIn(db, this.repoId, requirementId);
          if (claim?.data.operationId === operation.operationId && claim.data.ownerToken === owner.ownerToken) releaseRequirementWriteIn(db, this.repoId, requirementId, operation.operationId, owner);
        }));
      }
    }
  }

  private settleAbandoned(db: LocalDatabase, stored: StoredRecord<RequirementOperation>): void {
    const operation = stored.data;
    releaseDeadRequirementWriteIn(db, this.repoId, operation.requirementId);
    const row = db.read<RequirementRecord>("requirements", operation.requirementId)!;
    const anchors = db.read<{ anchor: string; parent: string | null }>(OPERATION_ANCHORS, operation.operationId);
    const applied = db.read("requirement_operations", operation.operationId) !== null;
    if (!operation.git || !anchors) {
      db.remove(NAMESPACE, operation.operationId, stored.version);
      if (anchors) db.remove(OPERATION_ANCHORS, operation.operationId, anchors.version);
      return;
    }
    const unchanged = operation.git.status === "unchanged" && operation.action === "updateDraft";
    const savedVersion = applied ? operation.saveVersion + (unchanged ? 0 : 1) : unchanged ? row.version : recordSavedIn(db, this.repoId, this.checkedNow(), { ...row, data: checkRequirement(row.data, operation.requirementId, this.repoId) }, {
      requirementId: operation.requirementId,
      version: row.version,
      operationId: operation.operationId,
      reference: { commit: operation.git.commit, hash: operation.git.hash },
      anchor: anchors.data.anchor,
      line: anchors.data.parent ? [anchors.data.parent] : [],
    }).version;
    const settled = { ...operation, savedVersion, finalVersion: savedVersion, updatedAt: Math.max(operation.updatedAt, this.checkedNow()) };
    checkOperation(settled);
    db.update(NAMESPACE, operation.operationId, stored.version, settled);
  }

  claim(operationId: string, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      if (stored.data.finalVersion !== null) return stored;
      const otherPending = db.list(NAMESPACE)
        .map((candidate) => checkOperation(candidate.data))
        .some((operation) => operation.requirementId === stored.data.requirementId && operation.operationId !== operationId && operation.finalVersion === null);
      if (otherPending) throw new RequirementServiceError("requirement_write_pending");
      claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId: stored.data.requirementId, operationId, acquiredAt: this.checkedNow() }, { allowDeadOriginalOperationRecovery: true });
      return stored;
    }));
  }

  pendingSave(requirementId: string, started: readonly string[]): RequirementOperation | null {
    if (!existsSync(this.path)) return null;
    return withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .find((operation) => operation.requirementId === requirementId && operation.finalVersion === null && started.includes(operation.operationId)) ?? null);
  }

  anchorOf(operationId: string): string {
    const stored = this.anchorRecord(operationId);
    return stored.unchangedTip ?? stored.anchor;
  }

  newAnchorOf(operationId: string): string { return this.anchorRecord(operationId).anchor; }

  parentOf(operationId: string): string | null { return this.anchorRecord(operationId).parent; }

  private anchorRecord(operationId: string): { anchor: string; unchangedTip: string | null; parent: string | null } {
    const stored = withDatabase(this.path, (db) => db.read<{ anchor: string; unchangedTip: string | null; parent: string | null }>(OPERATION_ANCHORS, operationId));
    if (!stored) throw new RequirementServiceError("operation_corrupt", "操作没有对应的锚点记录");
    return stored.data;
  }

  pendingCreate(intentHash: string): Pick<RequirementOperation, "action" | "requestId"> & { operationId: string | null } | null {
    if (!existsSync(this.path)) return null;
    return withDatabase(this.path, (db) => {
      const operations = db.list(NAMESPACE).map((stored) => checkOperation(stored.data));
      const unfinished = operations.find((operation) => operation.action === "create" && operation.finalVersion === null && operation.intentHash === intentHash);
      if (unfinished) return unfinished;
      const reserved = db.list("requirement_requests")
        .find((row) => {
          const data = row.data as { requirementId: string; intentHash: string };
          if (data.intentHash !== intentHash) return false;
          const record = db.read("requirements", data.requirementId)?.data as RequirementRecord | undefined;
          return record?.saved === null && record.lifecycle === "draft" && record.recovery === "ready"
            && !operations.some((operation) => operation.requirementId === data.requirementId);
        });
      return reserved ? { action: "create" as const, requestId: reserved.key, operationId: null } : null;
    });
  }

  assertOwned(operationId: string, owner: RequirementWriteOwner): RequirementOperation {
    return withDatabase(this.path, (db) => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      assertRequirementWriteOwnedIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      return stored.data;
    });
  }

  recordGitResult(operationId: string, result: PrdStorageWriteResult, owner: RequirementWriteOwner, unchangedSaved: PrdReference | null = null): StoredRecord<RequirementOperation> {
    return this.update(operationId, owner, (operation) => {
      const recorded = gitRecordOf(result);
      const git = result.status === "unchanged" && unchangedSaved?.hash === recorded.hash ? { ...recorded, commit: unchangedSaved.commit } : recorded;
      if (git.hash !== operation.targetHash || git.parent !== operation.expectedParent || git.repositoryRoot !== operation.repositoryRoot) {
        throw new RequirementServiceError("git_result_mismatch");
      }
      if (operation.expectedRepositoryIdentity && !same(operation.expectedRepositoryIdentity, git.repositoryIdentity)) {
        throw new RequirementServiceError("repository_identity_mismatch");
      }
      if (operation.git) {
        if (!same({ ...operation.git, status: git.status }, git)) throw new RequirementServiceError("operation_conflict");
        return operation;
      }
      return { ...operation, git };
    });
  }

  recordSavedVersion(operationId: string, savedVersion: number, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return this.update(operationId, owner, (operation) => {
      if (!operation.git) throw new RequirementServiceError("git_result_missing");
      if (operation.savedVersion !== null && operation.savedVersion !== savedVersion) throw new RequirementServiceError("operation_conflict");
      return operation.savedVersion === savedVersion ? operation : { ...operation, savedVersion };
    });
  }

  finalize(operationId: string, finalVersion: number, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      assertRequirementWriteOwnedIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      const operation = stored.data;
      if (!operation.git || operation.savedVersion === null) {
        throw new RequirementServiceError("operation_not_ready");
      }
      if (operation.finalVersion !== null && operation.finalVersion !== finalVersion) throw new RequirementServiceError("operation_conflict");
      const updated = operation.finalVersion === finalVersion
        ? operation
        : { ...operation, finalVersion, updatedAt: Math.max(operation.updatedAt, this.checkedNow()) };
      checkOperation(updated);
      const result = updated === operation
        ? stored
        : { id: stored.id, version: db.update(NAMESPACE, operationId, stored.version, updated), data: updated };
      releaseRequirementWriteIn(db, this.repoId, operation.requirementId, operationId, owner);
      return result;
    }));
  }

  /** 调用已经结束时释放物理写占用；未完成操作日志继续阻止其他操作越过恢复门槛。 */
  releaseAfterAttempt(operationId: string, owner: RequirementWriteOwner): boolean {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      const claim = readRequirementWriteClaimIn(db, this.repoId, stored.data.requirementId);
      if (!claim) return true;
      releaseRequirementWriteIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      return true;
    }));
  }

  archivePath(requirementId: string, reference: PrdReference | null): string | null {
    const matching = withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .filter((operation) => operation.requirementId === requirementId && operation.finalVersion !== null && operation.git !== null)
      .filter((operation) => reference === null || (operation.git!.commit === reference.commit && operation.git!.hash === reference.hash))
      .sort((left, right) => right.updatedAt - left.updatedAt));
    return matching[0]?.archivePath ?? null;
  }

  savedOperationFor(requirementId: string, reference: PrdReference | null, epoch: number): string | null {
    if (!reference) return null;
    const matching = withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .filter((operation) => operation.requirementId === requirementId && operation.epoch === epoch && operation.finalVersion !== null && operation.git !== null &&
        operation.git.commit === reference.commit && operation.git.hash === reference.hash)
      .sort((left, right) => right.updatedAt - left.updatedAt));
    return matching[0]?.operationId ?? null;
  }

  repositoryIdentity(requirementId: string): PrdRepositoryIdentity | null {
    const identities = withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .filter((operation) => operation.requirementId === requirementId && operation.git)
      .map((operation) => operation.git!.repositoryIdentity));
    if (identities.length === 0) return null;
    if (identities.some((value) => !same(value, identities[0]))) throw new RequirementServiceError("repository_identity_mismatch");
    return identities[0]!;
  }

  private checkedNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RequirementServiceError("invalid_time");
    return now;
  }

  private update(operationId: string, owner: RequirementWriteOwner, change: (operation: RequirementOperation) => RequirementOperation): StoredRecord<RequirementOperation> {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      assertRequirementWriteOwnedIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      const next = change(stored.data);
      if (next === stored.data) return stored;
      const updated = { ...next, updatedAt: Math.max(next.updatedAt, this.checkedNow()) };
      checkOperation(updated);
      const version = db.update(NAMESPACE, operationId, stored.version, updated);
      return { id: stored.id, version, data: updated };
    }));
  }
}
