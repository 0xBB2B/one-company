import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isPromise } from "node:util/types";
import { assertNoRequirementWriteClaimIn, assertNoUnfinishedRequirementOperationsIn } from "./requirement-coordination.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import type { RequirementAction, RequirementStoreOptions } from "./requirement-state.ts";
import type { PrdReference, RequirementRecord } from "./requirement-contracts.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { createPrdDocument, inspectPrdArchives, parsePrdDocument } from "./requirement-identity.ts";
import { PRD_FILE, create as createStorage, diffVersions, prdRequirementPath, readVersion, save as saveStorage, verifyVersion } from "./prd-storage.ts";
import type { PrdRepositoryIdentity, PrdStorageConfig, PrdStorageWriteResult } from "./prd-storage.ts";
import { RequirementOperations } from "./requirement-operations.ts";
import type { PrepareRequirementOperation, RequirementOperation, RequirementOperationAction } from "./requirement-operations.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import { decisionDigest } from "./short-decision-format.ts";
import { partitionPrdDocument } from "./prd-view.ts";
import { assertApprovalScopeReturnIn, registeredApprovalManifestIn, summarizeApprovalManifest } from "./approval-manifest-store.ts";
import type { RequirementWriteOwner } from "./requirement-coordination.ts";
import {
  ConfirmUpdateInput,
  LoadConfirmationInput,
  CreateRequirementInput,
  DiffRequirementInput,
  MetadataRequirementInput,
  ReadRequirementInput,
  RequirementServiceError,
  UpdateDraftInput,
  checkServiceInput,
  requirementIntentHash,
} from "./requirement-manage-contracts.ts";
import type {
  ConfirmUpdateInput as ConfirmInput,
  ConfirmationContext,
  LoadConfirmationInput as LoadConfirmationRequest,
  RequirementApprovalScope,
  CreateRequirementInput as CreateInput,
  DiffRequirementInput as DiffInput,
  ReadRequirementInput as ReadInput,
  RequirementDiffResult,
  RequirementMetadataResult,
  RequirementReadResult,
  RequirementReceipt,
  RequirementServiceAction,
  ServiceAuthorizationRequest,
  UpdateDraftInput as UpdateInput,
} from "./requirement-manage-contracts.ts";

export type { ServiceAuthorizationRequest } from "./requirement-manage-contracts.ts";
export { requirementIntentHash } from "./requirement-manage-contracts.ts";

export interface RequirementServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 可信宿主同步核验已在服务外完成的授权；回调只接收无正文元数据，不执行 UI、模型或文件 I/O。 */
  authorize?: (request: Readonly<ServiceAuthorizationRequest>) => boolean;
  authorizeManifest?: RequirementStoreOptions["authorizeManifest"];
  /** 同进程受控重存的来源，只沿updateDraft的saved-version通知传递。 */
  localMutationOrigin?: object;
}

const VALIDATION_REQUIREMENT_ID = "00000000-0000-7000-8000-000000000000";

const STATE_SCOPE: Record<RequirementServiceAction, ReadonlySet<RequirementAction>> = {
  create: new Set(["open", "reserve", "read", "saved-version", "block-recovery"]),
  updateDraft: new Set(["open", "read", "saved-version", "block-recovery"]),
  confirmUpdate: new Set(["open", "read", "approved-version", "block-recovery"]),
  readSaved: new Set(["open", "read", "block-recovery"]),
  readApproved: new Set(["open", "read", "events", "block-recovery"]),
  diff: new Set(["open", "read", "events", "block-recovery"]),
  metadata: new Set(["open", "read"]),
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function storageHash(hash: string): `sha256:${string}` {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new RequirementServiceError("invalid_prd_hash");
  return `sha256:${hash}`;
}

function sameReference(left: PrdReference | null, right: PrdReference | null): boolean {
  return left?.commit === right?.commit && left?.hash === right?.hash && (left === null) === (right === null);
}

function available(record: RequirementRecord): void {
  if (record.recovery !== "ready") throw new RequirementServiceError("recovery_required");
  if (record.lifecycle !== "draft" && record.lifecycle !== "active") throw new RequirementServiceError("lifecycle_denied");
}

function authorizationForWrite(
  repoId: string,
  action: RequirementOperationAction | "confirmUpdate",
  input: CreateInput | UpdateInput | ConfirmInput,
  intentHash: string,
  requirementId?: string,
  version?: number,
  epoch?: number,
  prdHash?: `sha256:${string}`,
): ServiceAuthorizationRequest {
  return {
    action,
    repoId,
    ...(action === "create" ? { requestId: (input as CreateInput).requestId } : {}),
    operationId: input.operationId,
    requirementId,
    intentHash,
    prdHash,
    version,
    epoch,
    ...(action === "confirmUpdate" ? { receiptId: (input as ConfirmInput).receiptId, manifest: (input as ConfirmInput).manifest } : {}),
  };
}

export class RequirementService {
  private readonly options: RequirementServiceOptions;
  private readonly operations: RequirementOperations;
  private readonly ownerTokens = new Map<string, string>();
  private readonly runningOperations = new Set<string>();

  private constructor(options: RequirementServiceOptions) {
    this.options = { ...options };
    this.operations = new RequirementOperations(options);
  }

  static async open(options: RequirementServiceOptions): Promise<RequirementService> {
    const captured = { ...options };
    const service = new RequirementService(captured);
    const request: ServiceAuthorizationRequest = { action: "metadata", repoId: captured.repoId };
    service.authorize(request);
    await service.state(request);
    service.authorize(request);
    return service;
  }

  private authorize(input: ServiceAuthorizationRequest): void {
    const request = deepFreeze(structuredClone(input));
    let result: unknown;
    try { result = this.options.authorize?.(request); }
    catch { throw new RequirementServiceError("authorization_required"); }
    if (isPromise(result)) {
      void Promise.prototype.then.call(result, () => undefined, () => undefined);
      throw new RequirementServiceError("authorization_required", "授权回调必须同步返回 true");
    }
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      let then: unknown;
      try { then = (result as { then?: unknown }).then; }
      catch { throw new RequirementServiceError("authorization_required"); }
      if (typeof then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new RequirementServiceError("authorization_required", "授权回调必须同步返回 true");
      }
    }
    if (result !== true) throw new RequirementServiceError("authorization_required");
  }

  private async state(request: ServiceAuthorizationRequest): Promise<RequirementStateStore> {
    const allowed = STATE_SCOPE[request.action];
    const stateOptions: RequirementStoreOptions = {
      dataRoot: this.options.dataRoot,
      repoId: this.options.repoId,
      repositoryRoot: this.options.repositoryRoot,
      authorizeManifest: this.options.authorizeManifest,
      ...(request.action === "updateDraft" && this.options.localMutationOrigin ? { localMutationOrigin: this.options.localMutationOrigin } : {}),
      authorize: ({ action }) => {
        if (!allowed.has(action)) return false;
        this.authorize(request);
        return true;
      },
    };
    return RequirementStateStore.open(stateOptions);
  }

  private storageConfig(
    request: ServiceAuthorizationRequest,
    requirementId: string,
    expectedRepositoryIdentity: PrdRepositoryIdentity | null,
    validateCurrent: () => void,
  ): PrdStorageConfig {
    return {
      dataRoot: this.options.dataRoot,
      repoId: this.options.repoId,
      requirementId,
      repositoryRoot: this.options.repositoryRoot,
      expectedRepositoryIdentity: expectedRepositoryIdentity ?? undefined,
      authorize: () => {
        validateCurrent();
        this.authorize(request);
        validateCurrent();
        return true;
      },
    };
  }

  private async assertNoObservedArchive(
    state: RequirementStateStore,
    requirementId: string,
  ): Promise<void> {
    const before = state.read(requirementId);
    available(before.data);
    const roots = new Set([this.options.repositoryRoot, before.data.workspace?.path].filter((value): value is string => Boolean(value)));
    let reason: "archive_found" | "identity_conflict" | null = null;
    const paths = new Set<string>();
    try {
      for (const root of roots) {
        const inspection = await inspectPrdArchives(root, requirementId);
        if (inspection.conflict) reason = "identity_conflict";
        for (const path of inspection.paths) paths.add(path);
      }
      if (paths.size > 1) reason = "identity_conflict";
      else if (paths.size === 1 && reason === null) reason = "archive_found";
    } catch {
      reason = "identity_conflict";
    }
    if (reason === null) return;
    const current = state.read(requirementId);
    if (current.data.recovery === "ready") {
      state.blockForRecovery({ requirementId, version: current.version, reason });
    }
    throw new RequirementServiceError("recovery_required", reason);
  }

  private ownerFor(operationId: string): RequirementWriteOwner {
    let ownerToken = this.ownerTokens.get(operationId);
    if (!ownerToken) {
      ownerToken = uuidv7();
      this.ownerTokens.set(operationId, ownerToken);
    }
    return { ownerToken, pid: process.pid };
  }

  private async verifyWorkingCopy(operation: Pick<RequirementOperation, "repositoryRoot" | "targetHash">): Promise<void> {
    const path = join(operation.repositoryRoot, PRD_FILE);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new RequirementServiceError("working_copy_mismatch"); }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
        throw new RequirementServiceError("working_copy_mismatch");
      }
      const bytes = await handle.readFile();
      const current = await lstat(path);
      if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1
        || createHash("sha256").update(bytes).digest("hex") !== operation.targetHash) {
        throw new RequirementServiceError("working_copy_mismatch");
      }
    } finally {
      await handle.close();
    }
  }

  async create(input: CreateInput): Promise<RequirementReceipt> {
    const request = checkServiceInput(CreateRequirementInput, input);
    const intentHash = requirementIntentHash({ title: request.title, body: request.body });
    createPrdDocument(VALIDATION_REQUIREMENT_ID, request.title, request.body);
    const initialAuthorization = authorizationForWrite(this.options.repoId, "create", request, intentHash);
    this.authorize(initialAuthorization);
    const state = await this.state(initialAuthorization);
    const reserved = state.reserve({ requestId: request.requestId, intentHash });
    available(reserved.data);
    await this.assertNoObservedArchive(state, reserved.id);
    const document = createPrdDocument(reserved.id, request.title, request.body);
    const authorization = authorizationForWrite(
      this.options.repoId,
      "create",
      request,
      intentHash,
      reserved.id,
      reserved.version,
      reserved.data.epoch,
      storageHash(document.prdHash),
    );
    return this.write("create", request, reserved, document, authorization);
  }

  async updateDraft(input: UpdateInput): Promise<RequirementReceipt> {
    const request = checkServiceInput(UpdateDraftInput, input);
    const intentHash = requirementIntentHash({ title: request.title, body: request.body });
    const initialAuthorization = authorizationForWrite(this.options.repoId, "updateDraft", request, intentHash, request.requirementId, request.version);
    this.authorize(initialAuthorization);
    const initialState = await this.state(initialAuthorization);
    const before = initialState.read(request.requirementId);
    available(before.data);
    await this.assertNoObservedArchive(initialState, request.requirementId);
    const document = createPrdDocument(request.requirementId, request.title, request.body);
    const authorization = authorizationForWrite(
      this.options.repoId,
      "updateDraft",
      request,
      intentHash,
      request.requirementId,
      request.version,
      before.data.epoch,
      storageHash(document.prdHash),
    );
    this.authorize(authorization);
    return this.write("updateDraft", request, before, document, authorization);
  }

  async confirmUpdate(input: ConfirmInput): Promise<RequirementReceipt> {
    const request = checkServiceInput(ConfirmUpdateInput, input);
    return this.approve(request);
  }

  private async approve(input: ConfirmInput): Promise<RequirementReceipt> {
    const intentHash = requirementIntentHash({ title: input.title, body: input.body });
    const initialAuthorization = authorizationForWrite(this.options.repoId, "confirmUpdate", input, intentHash, input.requirementId, input.version);
    this.authorize(initialAuthorization);
    const initialState = await this.state(initialAuthorization);
    const before = initialState.read(input.requirementId);
    available(before.data);
    withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) => {
      assertNoUnfinishedRequirementOperationsIn(db, input.requirementId);
      assertNoRequirementWriteClaimIn(db, this.options.repoId, input.requirementId);
    });
    await this.assertNoObservedArchive(initialState, input.requirementId);
    const document = createPrdDocument(input.requirementId, input.title, input.body);
    const authorization = authorizationForWrite(
      this.options.repoId,
      "confirmUpdate",
      input,
      intentHash,
      input.requirementId,
      input.version,
      before.data.epoch,
      storageHash(document.prdHash),
    );
    this.authorize(authorization);
    const ref = input.manifest;
    if (ref.requirementId !== input.requirementId || ref.candidate.operationId !== input.operationId ||
      ref.candidate.intentHash !== intentHash || !sameReference(ref.candidate.to, before.data.saved) ||
      ref.candidate.to.hash !== document.prdHash) throw new RequirementServiceError("manifest_candidate_mismatch");
    const identity = this.operations.repositoryIdentity(input.requirementId);
    if (!identity) throw new RequirementServiceError("repository_identity_missing");
    const validate = () => {
      const current = initialState.read(input.requirementId); available(current.data);
      if (current.version !== before.version || current.data.epoch !== before.data.epoch ||
        !sameReference(current.data.saved, ref.candidate.to)) throw new RequirementServiceError("manifest_stale");
    };
    const saved = await readVersion({ ...this.storageConfig(authorization, input.requirementId, identity, validate),
      commit: ref.candidate.to.commit, expectedHash: storageHash(ref.candidate.to.hash) });
    if (!Buffer.from(saved.bytes).equals(Buffer.from(document.bytes))) throw new RequirementServiceError("manifest_candidate_mismatch");
    validate();
    if (before.data.approvalReceiptId === input.receiptId && sameReference(before.data.approved, ref.candidate.to) &&
      decisionDigest(before.data.approvalManifest?.reference ?? null) === decisionDigest(ref)) {
      return this.approvedReceipt(input, before, document.archivePath);
    }
    const allowed = this.options.authorizeManifest?.(deepFreeze({ requirementId: input.requirementId,
      version: input.version, receiptId: input.receiptId, manifest: structuredClone(ref) }));
    if (isPromise(allowed)) void Promise.prototype.then.call(allowed, () => undefined, () => undefined);
    if (allowed !== true) throw new RequirementServiceError("manifest_authorization_required");
    validate();
    withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) =>
      registeredApprovalManifestIn(db, this.options.repoId, ref, before, input.receiptId));
    if (before.data.workspace) await verifyRequirementWorkspace(this.options.dataRoot, before.data.workspace);
    await this.verifyWorkingCopy({
      repositoryRoot: prdRequirementPath({ dataRoot: this.options.dataRoot, repoId: this.options.repoId, requirementId: input.requirementId }),
      targetHash: document.prdHash,
    });
    this.authorize(authorization);
    const approved = await (await this.state(authorization)).recordApprovedVersion({
      requirementId: input.requirementId,
      version: input.version,
      receiptId: input.receiptId,
      reference: ref.candidate.to,
      manifest: ref,
      ...(input.docSpec ? { docSpec: input.docSpec } : {}),
      ...(input.prototypes ? { prototypes: input.prototypes } : {}),
    });
    this.authorize(authorization);
    return this.approvedReceipt(input, approved, document.archivePath);
  }

  private approvedReceipt(input: ConfirmInput, record: { id: string; version: number; data: RequirementRecord }, archivePath: string): RequirementReceipt {
    const reference = input.manifest.candidate.to;
    return {
      action: "confirmUpdate",
      operationId: input.operationId,
      requirementId: input.requirementId,
      commit: reference.commit,
      prdHash: storageHash(reference.hash),
      status: "unchanged",
      archivePath,
      lifecycle: record.data.lifecycle as "draft" | "active",
      version: record.version,
      epoch: record.data.epoch,
      revision: record.data.revision,
      ...this.approvalScope(record),
    };
  }

  private async write(
    action: RequirementOperationAction,
    input: CreateInput | UpdateInput,
    before: { id: string; version: number; data: RequirementRecord },
    document: ReturnType<typeof createPrdDocument>,
    authorization: ServiceAuthorizationRequest,
  ): Promise<RequirementReceipt> {
    if (this.runningOperations.has(input.operationId)) throw new RequirementServiceError("requirement_write_busy");
    this.runningOperations.add(input.operationId);
    const owner = this.ownerFor(input.operationId);
    try {
      const receipt = await this.writeOwned(action, input, before, document, authorization, owner);
      this.ownerTokens.delete(input.operationId);
      return receipt;
    } catch (error) {
      try {
        if (this.operations.releaseAfterAttempt(input.operationId, owner)) this.ownerTokens.delete(input.operationId);
      } catch (cleanupError) {
        const code = (cleanupError as { code?: unknown }).code;
        if (code !== "operation_missing" && code !== "write_claim_lost") {
          throw new AggregateError([error, cleanupError], "需求写入失败且写占用释放失败");
        }
        this.ownerTokens.delete(input.operationId);
      }
      throw error;
    } finally {
      this.runningOperations.delete(input.operationId);
    }
  }

  private async writeOwned(
    action: RequirementOperationAction,
    input: CreateInput | UpdateInput,
    before: { id: string; version: number; data: RequirementRecord },
    document: ReturnType<typeof createPrdDocument>,
    authorization: ServiceAuthorizationRequest,
    owner: RequirementWriteOwner,
  ): Promise<RequirementReceipt> {
    available(before.data);
    const existing = this.operations.read(input.operationId);
    let operation: RequirementOperation;
    if (existing) {
      operation = existing.data;
      const expected = {
        action,
        requestId: action === "create" ? (input as CreateInput).requestId : null,
        requirementId: before.id,
        intentHash: authorization.intentHash!,
        targetHash: document.prdHash,
        archivePath: document.archivePath,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (operation[key as keyof RequirementOperation] !== value) throw new RequirementServiceError("requirement_write_pending", "内容和这次不同");
      }
      if (operation.finalVersion === null) operation = this.operations.claim(operation.operationId, owner).data;
    } else {
      if (action !== "create" && before.version !== (input as UpdateInput).version) {
        throw new RequirementServiceError("stale_version");
      }
      const expectedRepositoryIdentity = this.operations.repositoryIdentity(before.id);
      const prepared: PrepareRequirementOperation = {
        operationId: input.operationId,
        action,
        repoId: this.options.repoId,
        requestId: action === "create" ? (input as CreateInput).requestId : null,
        requirementId: before.id,
        intentHash: authorization.intentHash!,
        targetHash: document.prdHash,
        expectedParent: before.data.saved?.commit ?? null,
        saveVersion: before.version,
        epoch: before.data.epoch,
        archivePath: document.archivePath,
        repositoryRoot: prdRequirementPath({ dataRoot: this.options.dataRoot, repoId: this.options.repoId, requirementId: before.id }),
        expectedRepositoryIdentity,
      };
      this.authorize(authorization);
      operation = this.operations.prepare(prepared, owner).data;
    }

    if (operation.finalVersion !== null) {
      return this.completedReceipt(operation, document, authorization);
    }

    const storageState = await this.state(authorization);
    const validateOwnedActive = () => {
      const current = storageState.read(operation.requirementId);
      available(current.data);
      if (current.data.epoch !== operation.epoch) throw new RequirementServiceError("epoch_changed");
      if (operation.git === null && operation.savedVersion === null
        && (current.version !== operation.saveVersion || (current.data.saved?.commit ?? null) !== operation.expectedParent)) {
        throw new RequirementServiceError("state_changed_before_storage");
      }
      this.operations.assertOwned(operation.operationId, owner);
    };
    const config = this.storageConfig(authorization, operation.requirementId, operation.expectedRepositoryIdentity, validateOwnedActive);
    let git: PrdStorageWriteResult;
    if (operation.git) {
      const verified = await verifyVersion({
        ...config,
        commit: operation.git.commit,
        expectedHash: storageHash(operation.git.hash),
      });
      await this.verifyWorkingCopy(operation);
      validateOwnedActive();
      git = {
        status: operation.git.status,
        action: operation.action,
        operationId: operation.operationId,
        commit: verified.commit,
        parent: operation.expectedParent,
        prdHash: verified.prdHash,
        changed: operation.git.changed,
        repositoryRoot: verified.repositoryRoot,
        repositoryIdentity: verified.repositoryIdentity,
      };
    } else if (action === "create") {
      if (operation.expectedParent === null) {
        git = await createStorage({ ...config, operationId: operation.operationId, expectedParent: null, bytes: document.bytes });
      } else {
        const verified = await verifyVersion({
          ...config,
          commit: operation.expectedParent,
          expectedHash: storageHash(operation.targetHash),
        });
        await this.verifyWorkingCopy(operation);
        git = {
          status: "unchanged",
          action: "create",
          operationId: operation.operationId,
          commit: verified.commit,
          parent: operation.expectedParent,
          prdHash: verified.prdHash,
          changed: false,
          repositoryRoot: verified.repositoryRoot,
          repositoryIdentity: verified.repositoryIdentity,
        };
      }
    } else {
      git = await saveStorage({ ...config, action, operationId: operation.operationId, expectedParent: operation.expectedParent, bytes: document.bytes });
    }

    operation = this.operations.recordGitResult(operation.operationId, git, owner).data;
    const reference: PrdReference = { commit: operation.git!.commit, hash: operation.git!.hash };
    if (operation.savedVersion === null) {
      const current = (await this.state(authorization)).read(operation.requirementId);
      available(current.data);
      const beforeSave = current.version === operation.saveVersion
        && (current.data.saved?.commit ?? null) === operation.expectedParent;
      const saveAlreadyRecorded = current.version === operation.saveVersion + 1
        && sameReference(current.data.saved, reference);
      if (current.data.epoch !== operation.epoch || (!beforeSave && !saveAlreadyRecorded)) {
        throw new RequirementServiceError("state_changed_after_git");
      }
    }

    let saved: { id: string; version: number; data: RequirementRecord };
    if (operation.savedVersion === null) {
      const saveState = await this.state(authorization);
      saved = saveState.recordSavedVersion({
        requirementId: operation.requirementId,
        version: operation.saveVersion,
        operationId: operation.operationId,
        reference,
      });
      this.authorize(authorization);
      operation = this.operations.recordSavedVersion(operation.operationId, saved.version, owner).data;
    } else {
      saved = (await this.state(authorization)).read(operation.requirementId);
      available(saved.data);
      if (saved.data.epoch !== operation.epoch || !sameReference(saved.data.saved, reference)) {
        throw new RequirementServiceError("operation_state_mismatch");
      }
      if (saved.version !== operation.savedVersion) throw new RequirementServiceError("operation_state_mismatch");
    }

    this.authorize(authorization);
    operation = this.operations.finalize(operation.operationId, saved.version, owner).data;
    return this.currentReceipt(operation, authorization);
  }

  private validateReceiptState(operation: RequirementOperation, record: RequirementRecord, version: number): void {
    available(record);
    if (!operation.git || operation.finalVersion === null || operation.finalVersion !== version || record.epoch !== operation.epoch) {
      throw new RequirementServiceError("operation_state_mismatch");
    }
    const reference = { commit: operation.git.commit, hash: operation.git.hash };
    if (!sameReference(record.saved, reference)) {
      throw new RequirementServiceError("operation_state_mismatch");
    }
  }

  private async currentReceipt(operation: RequirementOperation, authorization: ServiceAuthorizationRequest): Promise<RequirementReceipt> {
    const state = await this.state(authorization);
    let current = state.read(operation.requirementId);
    this.validateReceiptState(operation, current.data, current.version);
    this.authorize(authorization);
    current = state.read(operation.requirementId);
    this.validateReceiptState(operation, current.data, current.version);
    return {
      action: operation.action,
      operationId: operation.operationId,
      requirementId: operation.requirementId,
      commit: operation.git!.commit,
      prdHash: storageHash(operation.git!.hash),
      status: operation.git!.status,
      archivePath: operation.archivePath,
      lifecycle: current.data.lifecycle as "draft" | "active",
      version: current.version,
      epoch: current.data.epoch,
      revision: current.data.revision,
      ...this.approvalScope(current),
    };
  }

  private async completedReceipt(
    operation: RequirementOperation,
    document: ReturnType<typeof createPrdDocument>,
    authorization: ServiceAuthorizationRequest,
  ): Promise<RequirementReceipt> {
    if (!operation.git || operation.targetHash !== document.prdHash) throw new RequirementServiceError("operation_state_mismatch");
    const state = await this.state(authorization);
    const validateFinal = () => {
      const current = state.read(operation.requirementId);
      this.validateReceiptState(operation, current.data, current.version);
    };
    validateFinal();
    const config = this.storageConfig(authorization, operation.requirementId, operation.expectedRepositoryIdentity, validateFinal);
    await verifyVersion({ ...config, commit: operation.git.commit, expectedHash: storageHash(operation.git.hash) });
    await this.verifyWorkingCopy(operation);
    validateFinal();
    return this.currentReceipt(operation, authorization);
  }

  async read(input: ReadInput): Promise<RequirementReadResult> {
    const request = checkServiceInput(ReadRequirementInput, input);
    const action = request.source === "saved" ? "readSaved" : "readApproved";
    const initialAuthorization: ServiceAuthorizationRequest = { action, repoId: this.options.repoId, requirementId: request.requirementId };
    this.authorize(initialAuthorization);
    const state = await this.state(initialAuthorization);
    const before = state.read(request.requirementId);
    available(before.data);
    await this.assertNoObservedArchive(state, request.requirementId);
    let reference = request.source === "saved" ? before.data.saved : before.data.approved;
    if (!reference) throw new RequirementServiceError("version_unavailable");
    if (request.revision !== undefined) {
      if (request.source !== "approved" || request.revision > before.data.revision) throw new RequirementServiceError("invalid_revision_range");
      const event = state.events(request.requirementId).find((entry) => entry.data.kind === "prd.approved" && entry.data.revision === request.revision && entry.data.to !== null);
      if (!event) throw new RequirementServiceError("unknown_revision");
      reference = event.data.to!;
    }
    const authorization: ServiceAuthorizationRequest = {
      ...initialAuthorization,
      prdHash: storageHash(reference.hash),
      version: before.version,
      epoch: before.data.epoch,
    };
    this.authorize(authorization);
    const identity = this.operations.repositoryIdentity(request.requirementId);
    if (!identity) throw new RequirementServiceError("repository_identity_missing");
    const validateCurrent = () => {
      const current = state.read(request.requirementId);
      available(current.data);
      const selected = request.revision !== undefined ? reference : request.source === "saved" ? current.data.saved : current.data.approved;
      if (current.version !== before.version || current.data.epoch !== before.data.epoch || !sameReference(selected, reference)) {
        throw new RequirementServiceError("state_changed_during_read");
      }
    };
    const result = await readVersion({
      ...this.storageConfig(authorization, request.requirementId, identity, validateCurrent),
      commit: reference.commit,
      expectedHash: storageHash(reference.hash),
    });
    const parsed = parsePrdDocument(result.bytes, request.requirementId);
    validateCurrent();
    this.authorize(authorization);
    validateCurrent();
    const after = state.read(request.requirementId);
    return {
      requirementId: request.requirementId,
      source: request.source,
      commit: result.commit,
      prdHash: result.prdHash,
      version: after.version,
      epoch: after.data.epoch,
      title: parsed.title,
      body: parsed.body,
      ...(request.source === "approved" ? this.approvalScope(after) : {}),
    };
  }

  /** 只核对存储里当前批准版本的正文与登记指纹一致，不取正文。 */
  async verifyApproved(requirementId: string): Promise<{ commit: string; prdHash: `sha256:${string}`; version: number; epoch: number }> {
    const id = checkServiceInput(MetadataRequirementInput, requirementId);
    const initialAuthorization: ServiceAuthorizationRequest = { action: "readApproved", repoId: this.options.repoId, requirementId: id };
    this.authorize(initialAuthorization);
    const state = await this.state(initialAuthorization);
    const before = state.read(id);
    available(before.data);
    await this.assertNoObservedArchive(state, id);
    const reference = before.data.approved;
    if (!reference) throw new RequirementServiceError("version_unavailable");
    const authorization: ServiceAuthorizationRequest = { ...initialAuthorization, prdHash: storageHash(reference.hash), version: before.version, epoch: before.data.epoch };
    this.authorize(authorization);
    const identity = this.operations.repositoryIdentity(id);
    if (!identity) throw new RequirementServiceError("repository_identity_missing");
    const validateCurrent = () => {
      const current = state.read(id);
      available(current.data);
      if (current.version !== before.version || current.data.epoch !== before.data.epoch || !sameReference(current.data.approved, reference)) {
        throw new RequirementServiceError("state_changed_during_read");
      }
    };
    const verified = await verifyVersion({ ...this.storageConfig(authorization, id, identity, validateCurrent),
      commit: reference.commit, expectedHash: storageHash(reference.hash) });
    validateCurrent();
    this.authorize(authorization);
    return { commit: verified.commit, prdHash: verified.prdHash, version: before.version, epoch: before.data.epoch };
  }

  async diff(input: DiffInput): Promise<RequirementDiffResult> {
    const request = checkServiceInput(DiffRequirementInput, input);
    const initialAuthorization: ServiceAuthorizationRequest = { action: "diff", repoId: this.options.repoId, requirementId: request.requirementId };
    this.authorize(initialAuthorization);
    const state = await this.state(initialAuthorization);
    const before = state.read(request.requirementId);
    available(before.data);
    await this.assertNoObservedArchive(state, request.requirementId);
    if (!before.data.approved) throw new RequirementServiceError("version_unavailable");
    const toRevision = request.toRevision ?? before.data.revision;
    if (toRevision < request.fromRevision || toRevision > before.data.revision) throw new RequirementServiceError("invalid_revision_range");
    const approved = state.events(request.requirementId)
      .filter((event) => event.data.kind === "prd.approved" && event.data.to !== null)
      .map((event) => ({ revision: event.data.revision, reference: event.data.to!, summary: event.data.approvalManifest! }));
    const from = approved.find((event) => event.revision === request.fromRevision)?.reference;
    const toEvent = approved.find((event) => event.revision === toRevision);
    if (!from || !toEvent) throw new RequirementServiceError("unknown_revision");
    const to = toEvent.reference;
    const authorization: ServiceAuthorizationRequest = {
      ...initialAuthorization,
      prdHash: storageHash(to.hash),
      version: before.version,
      epoch: before.data.epoch,
    };
    this.authorize(authorization);
    const identity = this.operations.repositoryIdentity(request.requirementId);
    if (!identity) throw new RequirementServiceError("repository_identity_missing");
    const validateCurrent = () => {
      const current = state.read(request.requirementId);
      available(current.data);
      if (current.version !== before.version || current.data.epoch !== before.data.epoch || !sameReference(current.data.approved, before.data.approved)) {
        throw new RequirementServiceError("state_changed_during_read");
      }
    };
    const result = await diffVersions({
      ...this.storageConfig(authorization, request.requirementId, identity, validateCurrent),
      fromCommit: from.commit,
      toCommit: to.commit,
      expectedFromHash: storageHash(from.hash),
      expectedToHash: storageHash(to.hash),
    });
    validateCurrent();
    this.authorize(authorization);
    validateCurrent();
    const after = state.read(request.requirementId);
    return {
      requirementId: request.requirementId,
      fromRevision: request.fromRevision,
      toRevision,
      fromCommit: result.fromCommit,
      toCommit: result.toCommit,
      fromHash: result.fromHash,
      toHash: result.toHash,
      version: after.version,
      epoch: after.data.epoch,
      diff: result.diff,
      ...(toRevision === after.data.revision ? this.approvalScope(after) : { approvalScope: { status: "available", summary: toEvent.summary } }),
    };
  }

  private approvalScope(record: { id: string; version: number; data: RequirementRecord }): { approvalScope?: RequirementApprovalScope } {
    return withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) => db.transaction(() => {
      const manifest = record.data.approvalManifest;
      const scope: RequirementApprovalScope | undefined = manifest && { status: "available", summary: summarizeApprovalManifest(
        registeredApprovalManifestIn(db, this.options.repoId, manifest.reference, record)) };
      assertApprovalScopeReturnIn(db, this.options.repoId, record, scope);
      return scope ? { approvalScope: scope } : {};
    }));
  }

  /** 内部宿主接缝：仅加载当前真实saved操作，不开放历史/ref/path选择。正文与diff不落库。 */
  async loadConfirmationContext(input: LoadConfirmationRequest): Promise<ConfirmationContext> {
    const request = checkServiceInput(LoadConfirmationInput, input);
    const authorization: ServiceAuthorizationRequest = { action: "readSaved", repoId: this.options.repoId,
      requirementId: request.requirementId, operationId: request.savedOperationId };
    this.authorize(authorization);
    const state = await this.state(authorization);
    const before = state.read(request.requirementId); available(before.data);
    await this.assertNoObservedArchive(state, request.requirementId);
    const operation = this.operations.read(request.savedOperationId);
    if (!operation || operation.data.requirementId !== request.requirementId || !operation.data.git || operation.data.finalVersion === null ||
      operation.data.epoch !== before.data.epoch || !sameReference(before.data.saved, { commit: operation.data.git.commit, hash: operation.data.git.hash })) {
      throw new RequirementServiceError("saved_operation_mismatch");
    }
    const saved = before.data.saved!;
    const bound = { ...authorization, version: before.version, epoch: before.data.epoch, prdHash: storageHash(saved.hash) };
    const validate = () => {
      const current = state.read(request.requirementId); available(current.data);
      const actual = this.operations.read(request.savedOperationId);
      const final = withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) => db.read("requirements", request.requirementId));
      if (!final || final.version !== before.version || decisionDigest(final.data) !== decisionDigest(before.data) ||
        current.version !== before.version || decisionDigest(current.data) !== decisionDigest(before.data) ||
        !actual || actual.version !== operation.version || decisionDigest(actual.data) !== decisionDigest(operation.data)) {
        throw new RequirementServiceError("state_changed_during_read");
      }
    };
    if (before.data.workspace) await verifyRequirementWorkspace(this.options.dataRoot, before.data.workspace);
    const config = this.storageConfig(bound, request.requirementId, operation.data.git.repositoryIdentity, validate);
    const result = await readVersion({ ...config, commit: saved.commit, expectedHash: storageHash(saved.hash) });
    await this.verifyWorkingCopy(operation.data);
    const parsed = parsePrdDocument(result.bytes, request.requirementId);
    const intentHash = requirementIntentHash({ title: parsed.title, body: parsed.body });
    if (intentHash !== operation.data.intentHash) throw new RequirementServiceError("saved_operation_mismatch");
    const partition = partitionPrdDocument(request.requirementId, parsed.title, parsed.body);
    if (partition.prdHash !== saved.hash) throw new RequirementServiceError("saved_operation_mismatch");
    let difference: ConfirmationContext["difference"];
    if (!before.data.approved) {
      difference = { kind: "full_candidate", from: null, to: saved, text: Buffer.from(result.bytes).toString("utf8") };
    } else {
      const diff = await diffVersions({ ...config, fromCommit: before.data.approved.commit, toCommit: saved.commit,
        expectedFromHash: storageHash(before.data.approved.hash), expectedToHash: storageHash(saved.hash) });
      difference = { kind: "diff", from: before.data.approved, to: saved, text: diff.diff };
    }
    if (before.data.workspace) await verifyRequirementWorkspace(this.options.dataRoot, before.data.workspace);
    this.authorize(bound); validate();
    // Core的basis是当前生命周期依据；初次无approved的差异以difference.from=null明确表示。
    const prd = before.data.lifecycle === "active" ? before.data.approved : saved;
    return { requirementId: request.requirementId, repoId: this.options.repoId, version: before.version, epoch: before.data.epoch,
      basis: { requirementId: request.requirementId, version: before.version, epoch: before.data.epoch, prd },
      candidate: { candidateId: request.operationId, operationId: request.operationId, intentHash, from: prd, to: saved },
      savedOperationId: request.savedOperationId, saved, approved: before.data.approved, workspace: before.data.workspace,
      title: parsed.title, body: parsed.body, partition, difference };
  }

  async metadata(requirementId: string): Promise<RequirementMetadataResult> {
    const id = checkServiceInput(MetadataRequirementInput, requirementId);
    const authorization: ServiceAuthorizationRequest = { action: "metadata", repoId: this.options.repoId, requirementId: id };
    this.authorize(authorization);
    const before = (await this.state(authorization)).read(id);
    const readable = before.data.lifecycle === "draft" || before.data.lifecycle === "active";
    const archivePath = readable ? this.operations.archivePath(id, before.data.saved) : null;
    const savedOperationId = readable ? this.operations.savedOperationFor(id, before.data.saved, before.data.epoch) : null;
    const after = (await this.state(authorization)).read(id);
    if (after.version !== before.version || after.data.epoch !== before.data.epoch) throw new RequirementServiceError("state_changed_during_read");
    this.authorize(authorization);
    const final = withDatabase(repositoryDatabase(this.options.dataRoot, this.options.repoId), (db) => db.read("requirements", id));
    if (!final || final.version !== after.version || decisionDigest(final.data) !== decisionDigest(after.data)) {
      throw new RequirementServiceError("state_changed_during_read");
    }
    return {
      requirementId: id,
      lifecycle: after.data.lifecycle,
      recovery: after.data.recovery,
      version: after.version,
      epoch: after.data.epoch,
      revision: after.data.revision,
      saved: readable && after.data.saved ? { commit: after.data.saved.commit, prdHash: storageHash(after.data.saved.hash) } : null,
      approved: readable && after.data.approved ? { commit: after.data.approved.commit, prdHash: storageHash(after.data.approved.hash) } : null,
      archivePath,
      savedOperationId,
      ...(["draft", "active"].includes(after.data.lifecycle) ? this.approvalScope(after) : {}),
    };
  }
}
