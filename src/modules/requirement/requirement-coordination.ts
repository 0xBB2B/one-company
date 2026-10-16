import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, StoredRecord } from "../../core/storage/database.ts";
import { UUID_V7_PATTERN } from "../../core/storage/database.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";

export const REQUIREMENT_WRITE_COORDINATION_NAMESPACE = "requirement_service_write_coordination";
export const REQUIREMENT_OPERATION_NAMESPACE = "requirement_service_operations";

export interface RequirementWriteOwner {
  ownerToken: string;
  pid: number;
}

export interface RequirementWriteClaim extends RequirementWriteOwner {
  format: "requirement-service-write-claim/v3";
  repoId: string;
  requirementId: string;
  operationId: string;
  acquiredAt: number;
}

export interface RequirementWriteClaimInput extends RequirementWriteOwner {
  repoId: string;
  requirementId: string;
  operationId: string;
  acquiredAt: number;
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function checkOwner(owner: RequirementWriteOwner): void {
  if (!UUID_V7_PATTERN.test(owner.ownerToken) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new RequirementServiceError("invalid_write_owner");
  }
}

function checkClaim(value: unknown, requirementId?: string, repoId?: string): RequirementWriteClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "acquiredAt,format,operationId,ownerToken,pid,repoId,requirementId") throw new RequirementServiceError("write_claim_corrupt");
  const claim = value as Partial<RequirementWriteClaim>;
  if (claim.format !== "requirement-service-write-claim/v3"
    || typeof claim.repoId !== "string" || !/^[0-9a-f]{64}$/.test(claim.repoId)
    || !UUID_V7_PATTERN.test(claim.requirementId ?? "")
    || !UUID_V7_PATTERN.test(claim.operationId ?? "")
    || !UUID_V7_PATTERN.test(claim.ownerToken ?? "")
    || !Number.isSafeInteger(claim.pid) || (claim.pid ?? 0) <= 0
    || !Number.isSafeInteger(claim.acquiredAt) || (claim.acquiredAt ?? -1) < 0
    || (requirementId !== undefined && claim.requirementId !== requirementId)
    || (repoId !== undefined && claim.repoId !== repoId)) {
    throw new RequirementServiceError("write_claim_corrupt");
  }
  return claim as RequirementWriteClaim;
}

function operationStatus(value: unknown, requirementId: string): { operationId: string; unfinished: boolean } {
  if (!value || typeof value !== "object") throw new RequirementServiceError("operation_corrupt");
  const operation = value as { format?: unknown; operationId?: unknown; requirementId?: unknown; finalVersion?: unknown };
  if (operation.format !== "requirement-service-operation/v1"
    || !UUID_V7_PATTERN.test(typeof operation.operationId === "string" ? operation.operationId : "")
    || operation.requirementId !== requirementId
    || !(operation.finalVersion === null || (Number.isSafeInteger(operation.finalVersion) && Number(operation.finalVersion) > 0))) {
    throw new RequirementServiceError("operation_corrupt");
  }
  return { operationId: operation.operationId as string, unfinished: operation.finalVersion === null };
}

export function readRequirementWriteClaimIn(
  db: LocalDatabase,
  repoId: string,
  requirementId: string,
): StoredRecord<RequirementWriteClaim> | null {
  const stored = db.read(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId);
  if (!stored) return null;
  return { ...stored, data: checkClaim(stored.data, requirementId, repoId) };
}

export function claimRequirementWriteIn(
  db: LocalDatabase,
  input: RequirementWriteClaimInput,
  options: { allowDeadOriginalOperationRecovery: boolean },
): StoredRecord<RequirementWriteClaim> {
  checkOwner(input);
  if (!UUID_V7_PATTERN.test(input.requirementId) || !UUID_V7_PATTERN.test(input.operationId)
    || !Number.isSafeInteger(input.acquiredAt) || input.acquiredAt < 0) {
    throw new RequirementServiceError("invalid_write_claim");
  }
  const existing = readRequirementWriteClaimIn(db, input.repoId, input.requirementId);
  if (existing) {
    if (existing.data.operationId !== input.operationId) throw new RequirementServiceError("requirement_write_pending");
    if (existing.data.ownerToken === input.ownerToken && existing.data.pid === input.pid) return existing;
    if (processIsAlive(existing.data.pid)) throw new RequirementServiceError("requirement_write_busy");
    if (!options.allowDeadOriginalOperationRecovery) throw new RequirementServiceError("write_recovery_required");
    const recovered: RequirementWriteClaim = {
      ...existing.data,
      ownerToken: input.ownerToken,
      pid: input.pid,
      acquiredAt: input.acquiredAt,
    };
    const version = db.update(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, input.requirementId, existing.version, recovered);
    return { id: existing.id, version, data: recovered };
  }
  const claim: RequirementWriteClaim = {
    format: "requirement-service-write-claim/v3",
    repoId: input.repoId,
    requirementId: input.requirementId,
    operationId: input.operationId,
    ownerToken: input.ownerToken,
    pid: input.pid,
    acquiredAt: input.acquiredAt,
  };
  return db.create(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, input.requirementId, claim);
}

export function assertRequirementWriteOwnedIn(
  db: LocalDatabase,
  repoId: string,
  requirementId: string,
  operationId: string,
  owner: RequirementWriteOwner,
): RequirementWriteClaim {
  checkOwner(owner);
  const stored = readRequirementWriteClaimIn(db, repoId, requirementId);
  if (!stored || stored.data.operationId !== operationId || stored.data.ownerToken !== owner.ownerToken || stored.data.pid !== owner.pid) {
    throw new RequirementServiceError("write_claim_lost");
  }
  return stored.data;
}

export function releaseRequirementWriteIn(
  db: LocalDatabase,
  repoId: string,
  requirementId: string,
  operationId: string,
  owner: RequirementWriteOwner,
): void {
  assertRequirementWriteOwnedIn(db, repoId, requirementId, operationId, owner);
  const stored = readRequirementWriteClaimIn(db, repoId, requirementId)!;
  db.remove(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId, stored.version);
}

export function releaseDeadRequirementWriteIn(db: LocalDatabase, repoId: string, requirementId: string): void {
  const stored = readRequirementWriteClaimIn(db, repoId, requirementId);
  if (!stored || processIsAlive(stored.data.pid)) return;
  db.remove(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId, stored.version);
}

export function assertNoRequirementWriteClaimIn(db: LocalDatabase, repoId: string, requirementId: string): void {
  if (readRequirementWriteClaimIn(db, repoId, requirementId)) throw new RequirementServiceError("requirement_write_busy");
}

export function assertNoUnfinishedRequirementOperationsIn(db: LocalDatabase, requirementId: string): void {
  const unfinished = db.list(REQUIREMENT_OPERATION_NAMESPACE).some((stored) => {
    const raw = stored.data as { requirementId?: unknown };
    if (raw?.requirementId !== requirementId) return false;
    return operationStatus(stored.data, requirementId).unfinished;
  });
  if (unfinished) throw new RequirementServiceError("unfinished_requirement_operation");
}

/**
 * 供关闭、备份和恢复服务使用的元数据接口。它不读取 prod 正文；死亡占用不会按时间自动清除。
 */
export class RequirementWriteCoordinator {
  private readonly path: string;
  private readonly repoId: string;

  constructor(options: { dataRoot: string; repoId: string }) {
    this.path = repositoryDatabase(options.dataRoot, options.repoId);
    this.repoId = options.repoId;
  }

  inspect(requirementId?: string): RequirementWriteClaim[] {
    return withDatabase(this.path, (db) => {
      if (requirementId) {
        const claim = readRequirementWriteClaimIn(db, this.repoId, requirementId);
        return claim ? [claim.data] : [];
      }
      return db.list(REQUIREMENT_WRITE_COORDINATION_NAMESPACE).map((stored) => checkClaim(stored.data, stored.key, this.repoId));
    });
  }

  assertQuiescent(requirementId?: string): void {
    const claims = this.inspect(requirementId);
    if (claims.length > 0) throw new RequirementServiceError("requirement_write_busy");
  }
}
