import { Type } from "typebox";
import { Value } from "typebox/value";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase, StoredRecord } from "./database.ts";
import { ApprovalManifestReferenceSchema, RequirementDocSpecSchema, checkRequirement, commit, counter, hash, id, object, positive } from "./requirement-contracts.ts";
import type { ApprovalManifestReference } from "./approval-manifest.ts";
import type { RequirementDocSpec } from "./requirement-doc.ts";
import type { ProdReference, RequirementRecord } from "./requirement-contracts.ts";
import { prodRequirementPath } from "./prod-storage.ts";
import type { ProdRepositoryIdentity, ProdStorageWriteResult } from "./prod-storage.ts";
import { assertApprovableIn } from "./requirement-prototypes.ts";
import { archivePathFor } from "./requirement-identity.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";
import {
  REQUIREMENT_OPERATION_NAMESPACE,
  assertRequirementWriteOwnedIn,
  claimRequirementWriteIn,
  readRequirementWriteClaimIn,
  releaseRequirementWriteIn,
} from "./requirement-coordination.ts";
import type { RequirementWriteOwner } from "./requirement-coordination.ts";

const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const action = Type.Union([Type.Literal("create"), Type.Literal("updateDraft"), Type.Literal("confirmUpdate")]);
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
  receiptId: nullable(id),
  manifest: Type.Optional(ApprovalManifestReferenceSchema),
  docSpec: Type.Optional(RequirementDocSpecSchema),
  prototypes: Type.Optional(hash),
  archivePath: Type.String({ minLength: 1, maxLength: 1024 }),
  repositoryRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  expectedRepositoryIdentity: nullable(identity),
  git: nullable(gitResult),
  savedVersion: nullable(positive),
  approvalVersion: nullable(positive),
  finalVersion: nullable(positive),
  createdAt: counter,
  updatedAt: counter,
});

export type RequirementOperationAction = "create" | "updateDraft" | "confirmUpdate";
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
  receiptId: string | null;
  manifest?: ApprovalManifestReference;
  docSpec?: RequirementDocSpec;
  prototypes?: string;
  archivePath: string;
  repositoryRoot: string;
  expectedRepositoryIdentity: ProdRepositoryIdentity | null;
  git: {
    status: ProdStorageWriteResult["status"];
    commit: string;
    parent: string | null;
    hash: string;
    changed: boolean;
    repositoryRoot: string;
    repositoryIdentity: ProdRepositoryIdentity;
  } | null;
  savedVersion: number | null;
  approvalVersion: number | null;
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
  saveVersion: number;
  epoch: number;
  receiptId: string | null;
  manifest?: ApprovalManifestReference;
  docSpec?: RequirementDocSpec;
  prototypes?: string;
  archivePath: string;
  repositoryRoot: string;
  expectedRepositoryIdentity: ProdRepositoryIdentity | null;
}

const NAMESPACE = REQUIREMENT_OPERATION_NAMESPACE;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkOperation(value: unknown): RequirementOperation {
  if (!Value.Check(operationSchema, value)) throw new RequirementServiceError("operation_corrupt", "持久操作记录格式冲突");
  const operation = value as RequirementOperation;
  const archivePrefix = `docs/prod/${operation.requirementId}.`;
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
    || (operation.action === "confirmUpdate") !== (operation.receiptId !== null)
    || operation.updatedAt < operation.createdAt
    || (operation.docSpec !== undefined && operation.action !== "confirmUpdate")
    || (operation.prototypes !== undefined && operation.action !== "confirmUpdate")
    || (operation.action === "confirmUpdate") !== (operation.manifest !== undefined)
    || (operation.manifest !== undefined && (operation.manifest.requirementId !== operation.requirementId ||
      operation.manifest.candidate.operationId !== operation.operationId || operation.manifest.candidate.intentHash !== operation.intentHash ||
      operation.manifest.candidate.to.hash !== operation.targetHash || operation.manifest.candidate.to.commit !== operation.expectedParent))
    || !gitConsistent
    || (operation.savedVersion !== null && operation.git === null)
    || (operation.approvalVersion !== null && (operation.action !== "confirmUpdate" || operation.savedVersion === null))
    || (operation.finalVersion !== null && (operation.savedVersion === null || (operation.action === "confirmUpdate" && operation.approvalVersion === null)))) {
    throw new RequirementServiceError("operation_corrupt", "持久操作记录内部关系冲突");
  }
  return operation;
}

function mutableFields(input: PrepareRequirementOperation) {
  return {
    operationId: input.operationId,
    action: input.action,
    repoId: input.repoId,
    requestId: input.requestId,
    requirementId: input.requirementId,
    intentHash: input.intentHash,
    targetHash: input.targetHash,
    expectedParent: input.expectedParent,
    saveVersion: input.saveVersion,
    epoch: input.epoch,
    receiptId: input.receiptId,
    ...(input.manifest ? { manifest: input.manifest } : {}),
    ...(input.docSpec ? { docSpec: input.docSpec } : {}),
    ...(input.prototypes ? { prototypes: input.prototypes } : {}),
    archivePath: input.archivePath,
    repositoryRoot: input.repositoryRoot,
    expectedRepositoryIdentity: input.expectedRepositoryIdentity,
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
    const expectedRoot = prodRequirementPath({ dataRoot: this.dataRoot, repoId: this.repoId, requirementId: data.requirementId });
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
        if (!same(mutableFields(existing.data), mutableFields(input))) throw new RequirementServiceError("operation_conflict", "同一 operationId 对应不同请求");
        if (existing.data.finalVersion === null) {
          const otherPending = db.list(NAMESPACE)
            .map((stored) => checkOperation(stored.data))
            .some((operation) => operation.requirementId === input.requirementId && operation.operationId !== input.operationId && operation.finalVersion === null);
          if (otherPending) throw new RequirementServiceError("requirement_write_pending");
          claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId: input.requirementId, operationId: input.operationId, acquiredAt: this.checkedNow() }, { allowDeadOriginalOperationRecovery: true });
        }
        return existing;
      }
      const conflicting = db.list(NAMESPACE)
        .map((stored) => checkOperation(stored.data))
        .some((operation) => operation.requirementId === input.requirementId && operation.finalVersion === null);
      if (conflicting || readRequirementWriteClaimIn(db, this.repoId, input.requirementId)) {
        throw new RequirementServiceError("requirement_write_pending");
      }
      const requirementStored = db.read("requirements", input.requirementId);
      if (!requirementStored) throw new RequirementServiceError("unknown_requirement");
      const requirement = checkRequirement(requirementStored.data, input.requirementId, input.repoId);
      available(requirement);
      if (requirementStored.version !== input.saveVersion) throw new RequirementServiceError("stale_version");
      if (requirement.epoch !== input.epoch) throw new RequirementServiceError("epoch_changed");
      const parent = requirement.saved?.commit ?? null;
      if (parent !== input.expectedParent) throw new RequirementServiceError("saved_version_changed");
      if (input.action === "confirmUpdate") assertApprovableIn(db, input.requirementId, input.prototypes);
      const now = this.checkedNow();
      const data: RequirementOperation = {
        format: "requirement-service-operation/v1",
        ...input,
        git: null,
        savedVersion: null,
        approvalVersion: null,
        finalVersion: null,
        createdAt: now,
        updatedAt: now,
      };
      checkOperation(data);
      const stored = db.create(NAMESPACE, input.operationId, data, input.operationId);
      claimRequirementWriteIn(db, { ...owner, repoId: this.repoId, requirementId: input.requirementId, operationId: input.operationId, acquiredAt: now }, { allowDeadOriginalOperationRecovery: false });
      return stored;
    }));
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

  assertOwned(operationId: string, owner: RequirementWriteOwner): RequirementOperation {
    return withDatabase(this.path, (db) => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      assertRequirementWriteOwnedIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      return stored.data;
    });
  }

  recordGitResult(operationId: string, result: ProdStorageWriteResult, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return this.update(operationId, owner, (operation) => {
      const git: RequirementOperation["git"] = {
        status: result.status,
        commit: result.commit,
        parent: result.changed ? result.parent : result.commit,
        hash: result.prodHash.slice("sha256:".length),
        changed: result.changed,
        repositoryRoot: result.repositoryRoot,
        repositoryIdentity: result.repositoryIdentity,
      };
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

  prepareApproval(operationId: string, approvalVersion: number, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return this.update(operationId, owner, (operation) => {
      if (operation.action !== "confirmUpdate" || !operation.receiptId || operation.savedVersion === null) throw new RequirementServiceError("approval_not_ready");
      if (operation.approvalVersion !== null && operation.approvalVersion !== approvalVersion) throw new RequirementServiceError("operation_conflict");
      return operation.approvalVersion === approvalVersion ? operation : { ...operation, approvalVersion };
    });
  }

  finalize(operationId: string, finalVersion: number, owner: RequirementWriteOwner): StoredRecord<RequirementOperation> {
    return withDatabase(this.path, (db) => db.transaction(() => {
      const stored = this.readIn(db, operationId);
      if (!stored) throw new RequirementServiceError("operation_missing");
      assertRequirementWriteOwnedIn(db, this.repoId, stored.data.requirementId, operationId, owner);
      const operation = stored.data;
      if (!operation.git || operation.savedVersion === null || (operation.action === "confirmUpdate" && operation.approvalVersion === null)) {
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

  archivePath(requirementId: string, reference: ProdReference | null): string | null {
    const matching = withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .filter((operation) => operation.requirementId === requirementId && operation.finalVersion !== null && operation.git !== null)
      .filter((operation) => reference === null || (operation.git!.commit === reference.commit && operation.git!.hash === reference.hash))
      .sort((left, right) => right.updatedAt - left.updatedAt));
    return matching[0]?.archivePath ?? null;
  }

  savedOperationFor(requirementId: string, reference: ProdReference | null, epoch: number): string | null {
    if (!reference) return null;
    const matching = withDatabase(this.path, (db) => db.list(NAMESPACE)
      .map((stored) => checkOperation(stored.data))
      .filter((operation) => operation.requirementId === requirementId && operation.epoch === epoch && operation.finalVersion !== null && operation.git !== null &&
        operation.git.commit === reference.commit && operation.git.hash === reference.hash)
      .sort((left, right) => right.updatedAt - left.updatedAt));
    return matching.find((operation) => operation.action !== "confirmUpdate")?.operationId ?? null;
  }

  repositoryIdentity(requirementId: string): ProdRepositoryIdentity | null {
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
