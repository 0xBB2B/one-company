import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isPromise } from "node:util/types";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import type { ApprovalManifest } from "./approval-manifest.ts";
import { HostAuthorizationManager } from "./host-authorization.ts";
import { checkPmUnderstanding, intakeBindingsEqual } from "./pm-intake-contracts.ts";
import type { IntakeBinding, IntakeReviewRecord, IntakeSourceDirectory, IntakeSourceRef, PmUnderstanding } from "./pm-intake-contracts.ts";
import { PmIntakeStore, intakeManifestDecisionIds } from "./pm-intake-store.ts";
import type { IntakeBindingBasis, IntakeCurrentProof, StoredIntakeRequest } from "./pm-intake-store.ts";
import { inspectProdStructure, partitionProdDocument } from "./prod-view.ts";
import { RequirementService } from "./requirement-service.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import type { PmLease } from "./requirement-contracts.ts";
import { decisionDigest } from "./short-decision-format.ts";
import { canonicalJson } from "./strict-json.ts";

export interface MainIntakeCall { readonly kind: "main-intake-call" }
export interface MainIntakeCallIdentity {
  readonly repoId: string;
  readonly requirementId: string;
  readonly windowId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
}
export interface MainIntakeCallResolver {
  resolve(call: MainIntakeCall): Readonly<MainIntakeCallIdentity> | null;
}

export interface PmSourceDirectoryHandle { readonly kind: "pm-source-directory-handle" }
export interface PmSourceDirectoryQuery {
  readonly baseline: Readonly<IntakeBindingBasis>;
  readonly binding?: Readonly<IntakeBinding>;
  readonly stableSectionIds: readonly string[];
  readonly manifestUnitIds: readonly string[];
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}
export interface PmSourceDirectoryMaterial {
  readonly handle: PmSourceDirectoryHandle;
  /** 可信生产者给出的完整业务场景章节集合；服务将它原样固定为 requiredScenarioIds。 */
  readonly scenarioIds: readonly string[];
  /** 当前需求全部可信未决问题ID；store会在同一SQLite快照中核对全集，不能由PM裁剪。 */
  readonly questionIds: readonly string[];
}
export interface PmSourceDirectoryProvider {
  loadCurrent(query: Readonly<PmSourceDirectoryQuery>): Promise<PmSourceDirectoryMaterial | null>;
  assertCurrent(handle: PmSourceDirectoryHandle, query: Readonly<Omit<PmSourceDirectoryQuery, "signal">>): void;
}

export interface PmSubmissionHandle { readonly kind: "pm-submission-handle" }
export interface PmSubmissionQuery {
  readonly binding: Readonly<IntakeBinding>;
  readonly sourceDirectoryHash: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}
export interface PmSubmissionMaterial {
  readonly handle: PmSubmissionHandle;
  readonly submissionRef: string;
  readonly submissionHash: string;
  readonly understanding: unknown;
}
export interface PmSubmissionProvider {
  loadCurrent(query: Readonly<PmSubmissionQuery>): Promise<PmSubmissionMaterial | null>;
  assertCurrent(handle: PmSubmissionHandle, query: Readonly<Omit<PmSubmissionQuery, "signal">>): void;
}

export interface IntakeReviewDecision {
  result: IntakeReviewRecord["result"];
  shortIssues: string[];
}

export interface IntakeRequestView {
  requestId: string;
  binding: IntakeBinding;
  submissionRef: string;
  submissionHash: string;
  sourceDirectoryHash: string;
  sourceDirectory: IntakeSourceDirectory;
  understanding: PmUnderstanding;
  understandingStatus: "accepted" | "uncovered";
  uncoveredScenarioIds: string[];
  createdAt: number;
  userAuthorizationCreated: false;
}
export interface IntakeReviewView {
  record: IntakeReviewRecord;
  userAuthorizationCreated: false;
}

export class PmIntakeServiceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`PM 接手服务被拒绝：${code}`);
    this.name = "PmIntakeServiceError";
    this.code = code;
  }
}

function stringPattern(pattern: RegExp) {
  return { test(value: unknown): value is string { return typeof value === "string" && pattern.exec(value)?.[0] === value; } };
}
const UUID = stringPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const HASH = stringPattern(/^[0-9a-f]{64}$/);
const OPAQUE = stringPattern(/^[A-Za-z0-9][A-Za-z0-9._:/#@+|-]{0,255}$/);
const MAX_INNER_BYTES = 49_152;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const noUserAuthorization = Object.freeze({ userAuthorizationCreated: false as const });
function deny(code: string): never { throw new PmIntakeServiceError(code); }
const same = (left: unknown, right: unknown): boolean => decisionDigest(left) === decisionDigest(right);
const stableDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value as Parameters<typeof canonicalJson>[0])).digest("hex");
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function pmUnderstandingHash(value: PmUnderstanding): string {
  return stableDigest(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function bounded<T>(value: T, code = "response_budget_exceeded"): T {
  let text: string;
  try { text = JSON.stringify(value); } catch { return deny("invalid_shape"); }
  if (Buffer.byteLength(text, "utf8") > MAX_INNER_BYTES) deny(code);
  return value;
}
function syncOnly(run: () => unknown, code: string): void {
  let result: unknown;
  try { result = run(); } catch (error) { throw error; }
  if (isPromise(result)) {
    void Promise.prototype.then.call(result, () => undefined, () => undefined);
    deny(code);
  }
  if (result !== null && (typeof result === "object" || typeof result === "function")) {
    let then: unknown;
    try { then = (result as { then?: unknown }).then; } catch { return deny(code); }
    if (typeof then === "function") { void Promise.resolve(result).catch(() => undefined); deny(code); }
  }
}
function exactDecision(value: unknown): IntakeReviewDecision {
  let copy: IntakeReviewDecision;
  try { copy = structuredClone(value) as IntakeReviewDecision; } catch { return deny("invalid_review_decision"); }
  if (!copy || typeof copy !== "object" || Object.keys(copy).sort().join("\0") !== ["result", "shortIssues"].sort().join("\0") ||
    !["passed", "pm_correction_required", "prod_revision_required", "clarification_required"].includes(copy.result) || !Array.isArray(copy.shortIssues)) {
    deny("invalid_review_decision");
  }
  return copy;
}
function sourceRefs(understanding: PmUnderstanding): IntakeSourceRef[] {
  const groups = [understanding.goals, understanding.nonGoals, understanding.constraints, understanding.allowedActions,
    understanding.unresolved, understanding.scenarioCoverage];
  const result: IntakeSourceRef[] = [], seen = new Set<string>();
  for (const item of groups.flat()) for (const ref of item.sourceRefs) {
    const key = `${ref.kind}\0${ref.id}`;
    if (!seen.has(key)) { seen.add(key); result.push({ ...ref }); }
  }
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

interface PreparedContext {
  identity: Readonly<MainIntakeCallIdentity>;
  hostGeneration: number;
  signal: AbortSignal;
  basis: IntakeBindingBasis;
  binding: IntakeBinding;
  lease: PmLease;
  manifest: ApprovalManifest;
  sourceDirectory: IntakeSourceDirectory;
  sourceDirectoryHash: string;
  sourceHandle: PmSourceDirectoryHandle;
  sourceQuery: PmSourceDirectoryQuery;
  proof: IntakeCurrentProof;
}
interface LoadedSubmission {
  handle: PmSubmissionHandle;
  submissionRef: string;
  submissionHash: string;
  understanding: PmUnderstanding;
  status: "accepted" | "uncovered";
  uncoveredScenarioIds: string[];
  query: PmSubmissionQuery;
}

export interface PmIntakeServiceOptions {
  dataRoot: string;
  repoId: string;
  state: RequirementStateStore;
  requirementService: RequirementService;
  authorization: HostAuthorizationManager;
  mainCallResolver?: MainIntakeCallResolver;
  sourceDirectoryProvider?: PmSourceDirectoryProvider;
  submissionProvider?: PmSubmissionProvider;
  store?: PmIntakeStore;
  now?: () => number;
  /** 同进程 performance.now() 时间域中的可信绝对截止时间；不进入工具参数、数据库或 provider 查询。 */
  deadlineMonotonic?: number;
}

/** M4 需求侧服务：只登记接手元数据和主代理核对，不启动PM、plan、task或调度。 */
export class PmIntakeService {
  readonly #options: PmIntakeServiceOptions;
  readonly #store: PmIntakeStore;
  readonly #views = new WeakMap<object, { call: MainIntakeCall; prepared: PreparedContext; submission: LoadedSubmission;
    proof: IntakeCurrentProof; bytes: string }>();
  constructor(options: PmIntakeServiceOptions) {
    if (!HASH.test(options.repoId)) deny("invalid_repo");
    if (options.deadlineMonotonic !== undefined &&
      (!Number.isFinite(options.deadlineMonotonic) || options.deadlineMonotonic < 0)) deny("invalid_deadline");
    if (options.store && options.deadlineMonotonic !== undefined) deny("deadline_store_binding_unsupported");
    this.#options = { ...options };
    this.#store = options.store ?? new PmIntakeStore({ dataRoot: options.dataRoot, repoId: options.repoId,
      now: options.now, deadlineMonotonic: options.deadlineMonotonic });
  }

  #signal(signal: AbortSignal): void {
    let aborted: boolean;
    try { aborted = signalAborted.call(signal) as boolean; } catch { return deny("invalid_signal"); }
    if (aborted) deny("operation_cancelled");
  }

  /** 最后DB检查后仅核对原生取消状态、固定截止时间与真实Host代次，不调用resolver/provider。 */
  #fixedRuntimeCurrent(prepared: Pick<PreparedContext, "hostGeneration" | "signal">): void {
    this.#signal(prepared.signal);
    if (this.#options.authorization.generation !== prepared.hostGeneration) deny("main_call_changed");
    if (this.#options.deadlineMonotonic !== undefined && performance.now() >= this.#options.deadlineMonotonic) {
      deny("main_deadline_elapsed");
    }
  }

  #main(call: MainIntakeCall, expected?: MainIntakeCallIdentity, generation?: number): Readonly<MainIntakeCallIdentity> {
    const resolver = this.#options.mainCallResolver;
    if (!resolver || !call || typeof call !== "object") deny("main_call_provider_unavailable");
    let identity: Readonly<MainIntakeCallIdentity> | null;
    try { identity = resolver.resolve(call); } catch { return deny("untrusted_main_call"); }
    if (!identity || identity.repoId !== this.#options.repoId || !UUID.test(identity.requirementId) ||
      [identity.windowId, identity.sessionId, identity.toolCallId].some((id) => !OPAQUE.test(id))) deny("untrusted_main_call");
    if (expected && !same(identity, expected)) deny("main_call_changed");
    try {
      const principal = this.#options.authorization.assertCurrentSession(identity.sessionId);
      if (principal.windowId !== identity.windowId) deny("untrusted_main_call");
      this.#options.authorization.assertRequirement(identity.repoId, identity.requirementId, identity.sessionId);
      if (generation !== undefined && this.#options.authorization.generation !== generation) deny("main_call_changed");
    } catch (error) {
      if (error instanceof PmIntakeServiceError) throw error;
      return deny("untrusted_main_call");
    }
    if (generation !== undefined && this.#options.authorization.generation !== generation) deny("main_call_changed");
    return freeze({ ...identity });
  }

  #runtimeCurrent(call: MainIntakeCall, prepared: Pick<PreparedContext, "identity" | "hostGeneration" | "signal">): void {
    this.#signal(prepared.signal);
    this.#main(call, prepared.identity, prepared.hostGeneration);
    this.#signal(prepared.signal);
  }

  #owner(requirementId: string): PmLease {
    const owner = this.#options.state.pmOwner(requirementId);
    if (!owner?.lease || !owner.context || owner.fence !== owner.lease.fence || owner.context.runId !== owner.lease.runId ||
      owner.context.fence !== owner.lease.fence || owner.context.generation !== owner.lease.contextGeneration) deny("pm_not_ready");
    return structuredClone(owner.lease);
  }

  async #checkPm(lease: PmLease, call: MainIntakeCall, prepared: Pick<PreparedContext, "identity" | "hostGeneration" | "signal">): Promise<void> {
    this.#runtimeCurrent(call, prepared);
    await this.#options.state.checkPm(lease);
    this.#runtimeCurrent(call, prepared);
  }

  #manifest(requirementId: string): ApprovalManifest {
    const record = this.#options.state.read(requirementId);
    if (!record.data.approvalManifest) deny("approval_manifest_unavailable");
    return withDatabase(repositoryDatabase(this.#options.dataRoot, this.#options.repoId), (db) => db.transaction(() =>
      registeredApprovalManifestIn(db, this.#options.repoId, record.data.approvalManifest!.reference, record)));
  }

  async #prepareContext(call: MainIntakeCall, signal: AbortSignal): Promise<PreparedContext> {
    this.#signal(signal);
    const identity = this.#main(call), hostGeneration = this.#options.authorization.generation;
    const runtime = { identity, hostGeneration, signal };
    this.#runtimeCurrent(call, runtime);
    if (!this.#options.sourceDirectoryProvider) deny("source_directory_provider_unavailable");
    if (!this.#options.submissionProvider) deny("submission_provider_unavailable");
    const initial = this.#options.state.read(identity.requirementId);
    const lease = this.#owner(identity.requirementId);
    if (initial.data.lifecycle !== "active" || initial.data.recovery !== "ready" || !initial.data.approved || !initial.data.workspace ||
      !initial.data.approvalManifest || initial.data.saved?.commit !== initial.data.approved.commit || initial.data.saved.hash !== initial.data.approved.hash) {
      deny("intake_not_ready");
    }
    await this.#checkPm(lease, call, runtime);
    const read = await this.#options.requirementService.read({ requirementId: identity.requirementId, source: "approved" });
    this.#runtimeCurrent(call, runtime);
    await this.#checkPm(lease, call, runtime);
    const current = this.#options.state.read(identity.requirementId);
    if (current.version !== initial.version || !same(current.data, initial.data) || read.version !== current.version || read.epoch !== current.data.epoch ||
      read.commit !== current.data.approved!.commit || read.prodHash !== `sha256:${current.data.approved!.hash}`) deny("binding_changed");
    const partition = partitionProdDocument(identity.requirementId, read.title, read.body);
    if (partition.prodHash !== current.data.approved!.hash) deny("approved_prod_changed");
    const structure = inspectProdStructure(read.body);
    if (structure.status !== "available") deny("source_directory_unavailable");
    const manifest = this.#manifest(identity.requirementId);
    if (manifest.totalBytes !== partition.totalBytes || manifest.units.length !== partition.units.length || manifest.units.some((unit, index) => {
      const actual = partition.units[index];
      return !actual || unit.id !== actual.id || unit.hash !== actual.hash || unit.startByte !== actual.startByte || unit.endByte !== actual.endByte;
    })) deny("approved_partition_changed");
    const basis: IntakeBindingBasis = {
      repoId: this.#options.repoId,
      requirementId: identity.requirementId,
      approvedProdCommit: current.data.approved!.commit,
      approvedRevision: current.data.revision,
      approvedProdHash: current.data.approved!.hash,
      approvalManifestHash: manifest.manifestHash,
      workspaceId: current.data.workspace!.workspaceId,
      workspaceRef: current.data.workspace!.branch,
      epoch: current.data.epoch,
      pmRunId: lease.runId,
      pmFence: lease.fence,
      contextGeneration: lease.contextGeneration,
    };
    const stableSectionIds = structure.sections.map((section) => section.id);
    const sourceQuery: PmSourceDirectoryQuery = Object.freeze({ baseline: freeze(structuredClone(basis)),
      stableSectionIds: Object.freeze([...stableSectionIds]), manifestUnitIds: Object.freeze(manifest.units.map((unit) => unit.id)),
      maxBytes: MAX_INNER_BYTES, signal });
    const material = await this.#options.sourceDirectoryProvider.loadCurrent(sourceQuery);
    this.#runtimeCurrent(call, runtime);
    await this.#checkPm(lease, call, runtime);
    if (!material || !material.handle || typeof material.handle !== "object" || material.handle.kind !== "pm-source-directory-handle" ||
      !Array.isArray(material.scenarioIds) || material.scenarioIds.length === 0 || material.scenarioIds.length > 32 ||
      material.scenarioIds.some((id) => typeof id !== "string" || !OPAQUE.test(id)) || new Set(material.scenarioIds).size !== material.scenarioIds.length ||
      !Array.isArray(material.questionIds) || material.questionIds.length > 128 ||
      material.questionIds.some((id) => typeof id !== "string" || !OPAQUE.test(id)) || new Set(material.questionIds).size !== material.questionIds.length) {
      deny("source_directory_unavailable");
    }
    const manifestIds = new Set(manifest.units.map((unit) => unit.id));
    if (material.scenarioIds.some((id) => !stableSectionIds.includes(id) || !manifestIds.has(id))) deny("source_directory_mismatch");
    const decisionIds = intakeManifestDecisionIds(manifest);
    const sourceDirectory: IntakeSourceDirectory = {
      prodUnitIds: manifest.units.map((unit) => unit.id),
      prodScenarioIds: [...material.scenarioIds],
      decisionIds,
      questionIds: sortedUnique(material.questionIds),
      requiredScenarioIds: [...material.scenarioIds],
    };
    const captured = this.#store.captureCurrent(basis, sourceDirectory);
    const finalSourceQuery: PmSourceDirectoryQuery = Object.freeze({ ...sourceQuery, binding: freeze(structuredClone(captured.binding)) });
    syncOnly(() => this.#options.sourceDirectoryProvider!.assertCurrent(material.handle, finalSourceQuery), "async_source_directory_assertion");
    this.#runtimeCurrent(call, runtime);
    return { identity, hostGeneration, signal, basis, binding: captured.binding, lease, manifest, sourceDirectory,
      sourceDirectoryHash: captured.sourceDirectoryHash, sourceHandle: material.handle, sourceQuery: finalSourceQuery, proof: captured.proof };
  }

  #sourceAssertionQuery(prepared: PreparedContext): Readonly<Omit<PmSourceDirectoryQuery, "signal">> {
    return freeze({ baseline: structuredClone(prepared.sourceQuery.baseline), binding: structuredClone(prepared.binding),
      stableSectionIds: [...prepared.sourceQuery.stableSectionIds], manifestUnitIds: [...prepared.sourceQuery.manifestUnitIds],
      maxBytes: prepared.sourceQuery.maxBytes });
  }

  #submissionAssertionQuery(submission: LoadedSubmission): Readonly<Omit<PmSubmissionQuery, "signal">> {
    return freeze({ binding: structuredClone(submission.query.binding), sourceDirectoryHash: submission.query.sourceDirectoryHash,
      maxBytes: submission.query.maxBytes });
  }

  async #submission(call: MainIntakeCall, prepared: PreparedContext): Promise<LoadedSubmission> {
    this.#runtimeCurrent(call, prepared);
    const query: PmSubmissionQuery = Object.freeze({ binding: freeze(structuredClone(prepared.binding)),
      sourceDirectoryHash: prepared.sourceDirectoryHash, maxBytes: MAX_INNER_BYTES, signal: prepared.signal });
    const material = await this.#options.submissionProvider!.loadCurrent(query);
    this.#runtimeCurrent(call, prepared);
    await this.#checkPm(prepared.lease, call, prepared);
    if (!material || !material.handle || typeof material.handle !== "object" || material.handle.kind !== "pm-submission-handle" ||
      !OPAQUE.test(material.submissionRef) || !HASH.test(material.submissionHash)) deny("submission_unavailable");
    const checked = checkPmUnderstanding(material.understanding, prepared.sourceDirectory);
    if (!intakeBindingsEqual(checked.understanding.binding, prepared.binding).equal) deny("submission_binding_mismatch");
    if (pmUnderstandingHash(checked.understanding) !== material.submissionHash) deny("submission_hash_mismatch");
    const loaded: LoadedSubmission = { handle: material.handle, submissionRef: material.submissionRef,
      submissionHash: material.submissionHash, understanding: checked.understanding, status: checked.status,
      uncoveredScenarioIds: checked.uncoveredScenarioIds, query };
    syncOnly(() => this.#options.sourceDirectoryProvider!.assertCurrent(prepared.sourceHandle, this.#sourceAssertionQuery(prepared)),
      "async_source_directory_assertion");
    this.#runtimeCurrent(call, prepared);
    syncOnly(() => this.#options.submissionProvider!.assertCurrent(material.handle, this.#submissionAssertionQuery(loaded)),
      "async_submission_assertion");
    this.#runtimeCurrent(call, prepared);
    this.#store.assertReturnCurrent(prepared.proof, this.#finalCallback(call, prepared, loaded));
    this.#fixedRuntimeCurrent(prepared);
    return loaded;
  }

  #finalCallback(call: MainIntakeCall, prepared: PreparedContext, submission: LoadedSubmission): () => void {
    const sourceQuery = this.#sourceAssertionQuery(prepared), submissionQuery = this.#submissionAssertionQuery(submission);
    return () => {
      this.#runtimeCurrent(call, prepared);
      syncOnly(() => this.#options.sourceDirectoryProvider!.assertCurrent(prepared.sourceHandle, sourceQuery), "async_source_directory_assertion");
      this.#runtimeCurrent(call, prepared);
      syncOnly(() => this.#options.submissionProvider!.assertCurrent(submission.handle, submissionQuery), "async_submission_assertion");
      this.#runtimeCurrent(call, prepared);
    };
  }

  #view(stored: StoredIntakeRequest, submission: LoadedSubmission): IntakeRequestView {
    if (stored.record.submissionRef !== submission.submissionRef || stored.record.submissionHash !== submission.submissionHash ||
      pmUnderstandingHash(submission.understanding) !== stored.record.submissionHash) deny("submission_changed");
    const view: IntakeRequestView = { requestId: stored.record.requestId, binding: structuredClone(stored.record.binding),
      submissionRef: stored.record.submissionRef, submissionHash: stored.record.submissionHash,
      sourceDirectoryHash: stored.record.sourceDirectoryHash, sourceDirectory: structuredClone(stored.sourceDirectory),
      understanding: structuredClone(submission.understanding), understandingStatus: submission.status,
      uncoveredScenarioIds: [...submission.uncoveredScenarioIds], createdAt: stored.record.createdAt, ...noUserAuthorization };
    bounded({ ...view, understanding: undefined });
    return bounded(view);
  }

  #deliver<T extends IntakeRequestView | IntakeReviewView>(call: MainIntakeCall, prepared: PreparedContext, submission: LoadedSubmission,
    proof: IntakeCurrentProof, view: T): T {
    freeze(view);
    const bytes = JSON.stringify(view);
    this.#store.assertReturnCurrent(proof, this.#finalCallback(call, prepared, submission));
    this.#fixedRuntimeCurrent(prepared);
    this.#views.set(view, { call, prepared, submission, proof, bytes });
    return view;
  }

  /** 只核验本实例返回的原对象；不重读/重新授权并换绑旧结果。 */
  assertResultCurrent(call: MainIntakeCall, originalView: IntakeRequestView | IntakeReviewView): void {
    const claimed = originalView && typeof originalView === "object" ? this.#views.get(originalView) : undefined;
    if (!claimed || claimed.call !== call) deny("unproven_result");
    try {
      if (JSON.stringify(originalView) !== claimed.bytes) deny("result_changed");
      this.#store.assertReturnCurrent(claimed.proof, this.#finalCallback(call, claimed.prepared, claimed.submission));
      this.#fixedRuntimeCurrent(claimed.prepared);
    } catch (error) { this.#views.delete(originalView); throw error; }
  }

  async openRequest(call: MainIntakeCall, operationId: string, signal = new AbortController().signal): Promise<IntakeRequestView> {
    if (!UUID.test(operationId)) deny("invalid_operation");
    const prepared = await this.#prepareContext(call, signal);
    const submission = await this.#submission(call, prepared);
    const request = this.#store.prepareRequest({ operationId, proof: prepared.proof, submissionRef: submission.submissionRef,
      submissionHash: submission.submissionHash, creator: { windowId: prepared.identity.windowId,
        sessionId: prepared.identity.sessionId, toolCallId: prepared.identity.toolCallId } });
    this.#view({ record: this.#store.requestMetadata(request), sourceDirectory: prepared.sourceDirectory,
      currentProof: prepared.proof, idempotent: false }, submission);
    const stored = this.#store.commitRequest(request, this.#finalCallback(call, prepared, submission));
    this.#runtimeCurrent(call, prepared);
    return this.#deliver(call, prepared, submission, stored.currentProof, this.#view(stored, submission));
  }

  async readRequest(call: MainIntakeCall, requestId: string, signal = new AbortController().signal): Promise<IntakeRequestView> {
    const prepared = await this.#prepareContext(call, signal);
    const existing = this.#store.readRequest(requestId, prepared.proof);
    if (prepared.identity.requirementId !== existing.record.binding.requirementId) deny("foreign_request");
    if (!intakeBindingsEqual(prepared.binding, existing.record.binding).equal || prepared.sourceDirectoryHash !== existing.record.sourceDirectoryHash ||
      !same(prepared.sourceDirectory, existing.sourceDirectory)) deny("request_not_current");
    const submission = await this.#submission(call, prepared);
    if (submission.submissionRef !== existing.record.submissionRef || submission.submissionHash !== existing.record.submissionHash) deny("submission_changed");
    return this.#deliver(call, prepared, submission, existing.currentProof, this.#view(existing, submission));
  }

  async recordReview(call: MainIntakeCall, requestId: string, operationId: string, decisionValue: IntakeReviewDecision,
    signal = new AbortController().signal): Promise<IntakeReviewView> {
    if (!UUID.test(operationId)) deny("invalid_operation");
    const prepared = await this.#prepareContext(call, signal);
    const decision = exactDecision(decisionValue), existing = this.#store.readRequest(requestId, prepared.proof);
    if (!intakeBindingsEqual(prepared.binding, existing.record.binding).equal || prepared.sourceDirectoryHash !== existing.record.sourceDirectoryHash) deny("request_not_current");
    const submission = await this.#submission(call, prepared);
    if (submission.submissionRef !== existing.record.submissionRef || submission.submissionHash !== existing.record.submissionHash) deny("submission_changed");
    if (decision.result === "passed" && submission.status !== "accepted") deny("scenario_coverage_incomplete");
    const record: IntakeReviewRecord = {
      format: "pm-intake-review/v1", reviewId: uuidv7(), requestId, binding: structuredClone(prepared.binding),
      submissionRef: submission.submissionRef, submissionHash: submission.submissionHash,
      reviewer: { windowId: prepared.identity.windowId, sessionId: prepared.identity.sessionId, toolCallId: prepared.identity.toolCallId },
      result: decision.result, sourceRefs: sourceRefs(submission.understanding), shortIssues: [...decision.shortIssues],
    };
    bounded({ record, ...noUserAuthorization });
    const review = this.#store.prepareReview({ operationId, proof: existing.currentProof, record });
    const stored = this.#store.commitReview(review, this.#finalCallback(call, prepared, submission));
    this.#runtimeCurrent(call, prepared);
    return this.#deliver(call, prepared, submission, stored.currentProof, bounded({ record: structuredClone(stored.record), ...noUserAuthorization }));
  }

  recordImpact(): never { return deny("impact_provider_unavailable"); }
}
