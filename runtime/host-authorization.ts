import { LocalDatabase, repositoryDatabase, uuidv7, UUID_V7_PATTERN } from "./database.ts";
import type { ServiceAuthorizationRequest } from "./requirement-manage-contracts.ts";
import type { ProdReference } from "./requirement-contracts.ts";

const REPO_ID_PATTERN = /^[0-9a-f]{64}$/;
const INTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_NAMESPACE = "host_requirement_target_receipts_v1";
const DEFAULT_RECEIPT_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_INPUT_TTL_MS = 15 * 60 * 1_000;

export type TrustedInputSource = "interactive" | "rpc";

export interface MainHostPrincipal {
  readonly kind: "main";
  readonly windowId: string;
  readonly sessionId: string;
  readonly repoIds: readonly string[];
}

interface InputCapability {
  readonly windowId: string;
  readonly sessionId: string;
  readonly source: TrustedInputSource;
  readonly expiresAt: number;
}

export interface TargetConfirmationScope {
  readonly action: "confirmUpdate";
  readonly purpose: "target-confirmation";
  readonly implementation: "not-authorized";
  readonly repoId: string;
  readonly requirementId: string;
  readonly operationId: string;
  readonly intentHash: string;
  readonly epoch: number;
  readonly version: number;
}

export interface TargetConfirmationReceipt {
  readonly format: "host-authorization/requirement-target/v1";
  readonly receiptId: string;
  readonly actor: "user";
  readonly conclusion: "target-confirmed";
  readonly baseline: ProdReference | null;
  readonly subject: {
    readonly kind: "main";
    readonly sessionId: string;
    readonly windowId: string;
  };
  readonly scope: TargetConfirmationScope;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "active" | "revoked";
}

export type ConfirmationLookup =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly receipt: TargetConfirmationReceipt }
  | { readonly status: "expired" | "revoked" | "conflict" };

export type HostOperationBinding =
  | { readonly action: "create"; readonly repoId: string; readonly requestId: string; readonly operationId: string; readonly intentHash: string }
  | { readonly action: "updateDraft"; readonly repoId: string; readonly requirementId: string; readonly operationId: string; readonly version: number; readonly intentHash: string }
  | { readonly action: "confirmUpdate"; readonly repoId: string; readonly requirementId: string; readonly operationId: string; readonly version: number; readonly intentHash: string; readonly epoch: number; readonly receiptId: string }
  | { readonly action: "readSaved" | "readApproved" | "diff" | "metadata"; readonly repoId: string; readonly requirementId: string };

export class HostAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "HostAuthorizationError";
    this.code = code;
  }
}

function assertFiniteTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new HostAuthorizationError("invalid_time");
}

function validReceipt(value: unknown): value is TargetConfirmationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(",") !== "actor,baseline,conclusion,createdAt,expiresAt,format,receiptId,scope,state,subject") return false;
  if (receipt.format !== "host-authorization/requirement-target/v1" || receipt.actor !== "user" || receipt.conclusion !== "target-confirmed"
    || typeof receipt.receiptId !== "string" || !UUID_V7_PATTERN.test(receipt.receiptId)) return false;
  if ((receipt.state !== "active" && receipt.state !== "revoked") || !Number.isSafeInteger(receipt.createdAt) || !Number.isSafeInteger(receipt.expiresAt)) return false;
  const baseline = receipt.baseline as Record<string, unknown> | null;
  if (baseline !== null && (!baseline || Object.keys(baseline).sort().join(",") !== "commit,hash" || typeof baseline.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseline.commit) || typeof baseline.hash !== "string" || !INTENT_HASH_PATTERN.test(baseline.hash))) return false;
  const subject = receipt.subject as Record<string, unknown> | undefined;
  if (!subject || Object.keys(subject).sort().join(",") !== "kind,sessionId,windowId" || subject.kind !== "main" || typeof subject.sessionId !== "string" || typeof subject.windowId !== "string") return false;
  const scope = receipt.scope as Record<string, unknown> | undefined;
  if (!scope || Object.keys(scope).sort().join(",") !== "action,epoch,implementation,intentHash,operationId,purpose,repoId,requirementId,version") return false;
  return scope.action === "confirmUpdate" && scope.purpose === "target-confirmation" && scope.implementation === "not-authorized"
    && typeof scope.repoId === "string" && REPO_ID_PATTERN.test(scope.repoId)
    && typeof scope.requirementId === "string" && UUID_V7_PATTERN.test(scope.requirementId)
    && typeof scope.operationId === "string" && UUID_V7_PATTERN.test(scope.operationId)
    && typeof scope.intentHash === "string" && INTENT_HASH_PATTERN.test(scope.intentHash)
    && Number.isSafeInteger(scope.epoch) && Number(scope.epoch) >= 1
    && Number.isSafeInteger(scope.version) && Number(scope.version) >= 1;
}

function sameScope(left: TargetConfirmationScope, right: TargetConfirmationScope): boolean {
  return left.action === right.action && left.purpose === right.purpose && left.implementation === right.implementation && left.repoId === right.repoId
    && left.requirementId === right.requirementId && left.operationId === right.operationId
    && left.intentHash === right.intentHash && left.epoch === right.epoch && left.version === right.version;
}

function fieldMatches(request: ServiceAuthorizationRequest, field: keyof ServiceAuthorizationRequest, expected: unknown): boolean {
  return request[field] !== undefined && request[field] === expected;
}

/**
 * 只接受 lifecycle 建立的主窗口身份与真实宿主 input/UI 产生的能力。
 * SQLite 句柄在服务调用前打开；authorize() 只做同步内存判断和已打开句柄的同步读取。
 */
export class HostAuthorizationManager {
  private readonly dataRoot: string;
  private readonly now: () => number;
  private readonly receiptTtlMs: number;
  private readonly inputTtlMs: number;
  private principal: MainHostPrincipal | undefined;
  private inputCapability: InputCapability | undefined;
  private readonly databases = new Map<string, LocalDatabase>();

  constructor(options: { dataRoot: string; now?: () => number; receiptTtlMs?: number; inputTtlMs?: number }) {
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? Date.now;
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.inputTtlMs = options.inputTtlMs ?? DEFAULT_INPUT_TTL_MS;
    if (!Number.isSafeInteger(this.receiptTtlMs) || this.receiptTtlMs <= 0 || !Number.isSafeInteger(this.inputTtlMs) || this.inputTtlMs <= 0) {
      throw new HostAuthorizationError("invalid_ttl");
    }
  }

  startWindow(principal: MainHostPrincipal): void {
    this.shutdown();
    if (!principal.windowId || !principal.sessionId || principal.repoIds.length === 0 || principal.repoIds.some((repoId) => !REPO_ID_PATTERN.test(repoId))) {
      throw new HostAuthorizationError("invalid_principal");
    }
    this.principal = Object.freeze({ ...principal, repoIds: Object.freeze([...new Set(principal.repoIds)]) });
  }

  captureInput(source: string, sessionId: string): void {
    const principal = this.requirePrincipal(sessionId);
    if (source !== "interactive" && source !== "rpc") {
      this.inputCapability = undefined;
      if (source === "extension") return;
      throw new HostAuthorizationError("invalid_input_source", "未知 input 来源不能产生宿主授权");
    }
    const now = this.currentTime();
    this.inputCapability = Object.freeze({ windowId: principal.windowId, sessionId: principal.sessionId, source, expiresAt: now + this.inputTtlMs });
  }

  shutdown(): void {
    this.inputCapability = undefined;
    this.principal = undefined;
    for (const database of this.databases.values()) database.close();
    this.databases.clear();
  }

  assertCurrentSession(sessionId: string): MainHostPrincipal {
    return this.requirePrincipal(sessionId);
  }

  prepareRepository(repoId: string, sessionId: string): void {
    this.requireRepo(repoId, sessionId);
    if (!this.databases.has(repoId)) this.databases.set(repoId, new LocalDatabase(repositoryDatabase(this.dataRoot, repoId)));
  }

  hasDraftCapability(repoId: string, sessionId: string): boolean {
    const principal = this.requireRepo(repoId, sessionId);
    const capability = this.inputCapability;
    return capability !== undefined && capability.windowId === principal.windowId && capability.sessionId === principal.sessionId && capability.expiresAt >= this.currentTime();
  }

  confirmation(scope: TargetConfirmationScope, sessionId: string): ConfirmationLookup {
    this.requireRepo(scope.repoId, sessionId);
    this.assertScope(scope);
    const stored = this.database(scope.repoId).read(RECEIPT_NAMESPACE, scope.operationId);
    if (!stored) return { status: "missing" };
    if (!validReceipt(stored.data) || stored.id !== (stored.data as TargetConfirmationReceipt).receiptId) return { status: "conflict" };
    const receipt = stored.data;
    this.requirePrincipal(sessionId);
    if (receipt.subject.kind !== "main" || !sameScope(receipt.scope, scope)) return { status: "conflict" };
    if (receipt.state !== "active") return { status: "revoked" };
    if (receipt.expiresAt < this.currentTime()) return { status: "expired" };
    return { status: "valid", receipt };
  }

  recordConfirmation(scope: TargetConfirmationScope, sessionId: string, baseline: ProdReference | null = null): TargetConfirmationReceipt {
    this.requireRepo(scope.repoId, sessionId);
    this.assertScope(scope);
    const database = this.database(scope.repoId);
    return database.transaction(() => {
      const existing = database.read(RECEIPT_NAMESPACE, scope.operationId);
      if (existing) {
        const lookup = this.confirmation(scope, sessionId);
        if (lookup.status === "valid") return lookup.receipt;
        throw new HostAuthorizationError(`receipt_${lookup.status}`, "已有同 operationId 回执无效或范围不一致");
      }
      const principal = this.requirePrincipal(sessionId);
      const createdAt = this.currentTime();
      const receipt: TargetConfirmationReceipt = Object.freeze({
        format: "host-authorization/requirement-target/v1",
        receiptId: uuidv7(),
        actor: "user",
        conclusion: "target-confirmed",
        baseline: baseline ? Object.freeze({ ...baseline }) : null,
        subject: Object.freeze({ kind: "main", sessionId: principal.sessionId, windowId: principal.windowId }),
        scope: Object.freeze({ ...scope }),
        createdAt,
        expiresAt: createdAt + this.receiptTtlMs,
        state: "active",
      });
      database.create(RECEIPT_NAMESPACE, scope.operationId, receipt, receipt.receiptId);
      return receipt;
    });
  }

  revokeConfirmation(repoId: string, operationId: string, sessionId: string): void {
    this.requireRepo(repoId, sessionId);
    const database = this.database(repoId);
    database.transaction(() => {
      const stored = database.read(RECEIPT_NAMESPACE, operationId);
      if (!stored || !validReceipt(stored.data) || stored.id !== stored.data.receiptId) throw new HostAuthorizationError("receipt_missing");
      if (stored.data.state === "revoked") return;
      database.update(RECEIPT_NAMESPACE, operationId, stored.version, { ...stored.data, state: "revoked" });
    });
  }

  authorizer(binding: HostOperationBinding, sessionId: string): (request: ServiceAuthorizationRequest) => boolean {
    this.prepareRepository(binding.repoId, sessionId);
    return (request) => {
      try {
        const principal = this.requireRepo(binding.repoId, sessionId);
        if (principal.sessionId !== sessionId || request.repoId !== binding.repoId) return false;
        // RequirementService.open 只用这条无 requirementId 的 metadata 请求核对仓库级宿主接线；
        // 具体动作随后仍须通过下方完整字段与正文返回前复核。
        if (request.action === "metadata" && request.requirementId === undefined) return true;
        switch (binding.action) {
          case "create":
            return request.action === "create" && this.hasDraftCapability(binding.repoId, sessionId)
              && fieldMatches(request, "requestId", binding.requestId) && fieldMatches(request, "operationId", binding.operationId)
              && fieldMatches(request, "intentHash", binding.intentHash);
          case "updateDraft":
            return request.action === "updateDraft" && this.hasDraftCapability(binding.repoId, sessionId)
              && fieldMatches(request, "requirementId", binding.requirementId) && fieldMatches(request, "operationId", binding.operationId)
              && fieldMatches(request, "version", binding.version) && fieldMatches(request, "intentHash", binding.intentHash);
          case "confirmUpdate": {
            if (request.action === "metadata") return fieldMatches(request, "requirementId", binding.requirementId);
            if (request.action !== "confirmUpdate" || !fieldMatches(request, "requirementId", binding.requirementId)
              || !fieldMatches(request, "operationId", binding.operationId) || !fieldMatches(request, "version", binding.version)
              || !fieldMatches(request, "intentHash", binding.intentHash)
              || (request.epoch !== undefined && request.epoch !== binding.epoch)
              || !fieldMatches(request, "receiptId", binding.receiptId)) return false;
            const scope: TargetConfirmationScope = { action: "confirmUpdate", purpose: "target-confirmation", implementation: "not-authorized", repoId: binding.repoId,
              requirementId: binding.requirementId, operationId: binding.operationId, intentHash: binding.intentHash, epoch: binding.epoch, version: binding.version };
            const lookup = this.confirmation(scope, sessionId);
            return lookup.status === "valid" && lookup.receipt.receiptId === binding.receiptId;
          }
          case "readSaved":
          case "readApproved":
          case "diff":
          case "metadata":
            return request.action === binding.action && fieldMatches(request, "requirementId", binding.requirementId);
        }
      } catch {
        return false;
      }
    };
  }

  private currentTime(): number {
    const value = this.now();
    assertFiniteTime(value);
    return value;
  }

  private requirePrincipal(sessionId: string): MainHostPrincipal {
    const principal = this.principal;
    if (!principal || principal.kind !== "main" || principal.sessionId !== sessionId) throw new HostAuthorizationError("untrusted_host");
    return principal;
  }

  private requireRepo(repoId: string, sessionId: string): MainHostPrincipal {
    if (!REPO_ID_PATTERN.test(repoId)) throw new HostAuthorizationError("invalid_repo");
    const principal = this.requirePrincipal(sessionId);
    if (!principal.repoIds.includes(repoId)) throw new HostAuthorizationError("foreign_repo");
    return principal;
  }

  private database(repoId: string): LocalDatabase {
    const database = this.databases.get(repoId);
    if (!database) throw new HostAuthorizationError("repository_not_prepared");
    return database;
  }

  private assertScope(scope: TargetConfirmationScope): void {
    if (scope.action !== "confirmUpdate" || scope.purpose !== "target-confirmation" || scope.implementation !== "not-authorized" || !REPO_ID_PATTERN.test(scope.repoId)
      || !UUID_V7_PATTERN.test(scope.requirementId) || !UUID_V7_PATTERN.test(scope.operationId) || !INTENT_HASH_PATTERN.test(scope.intentHash)
      || !Number.isSafeInteger(scope.epoch) || scope.epoch < 1 || !Number.isSafeInteger(scope.version) || scope.version < 1) throw new HostAuthorizationError("invalid_scope");
  }
}
