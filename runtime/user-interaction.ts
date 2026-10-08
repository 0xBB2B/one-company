import { Type } from "typebox";
import { isPromise } from "node:util/types";
import { uuidv7, repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { createHash } from "node:crypto";
import { RequirementOperations } from "./requirement-operations.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "./requirement-coordination.ts";
import type { RequirementAccessChange, RequirementAccessState } from "./requirement-state.ts";
import type { RequirementStoreOptions, StateAuthorizationRequest } from "./requirement-state.ts";
import { object, id, counter, checked } from "./requirement-contracts.ts";
import { ShortDecisionStore } from "./short-decisions.ts";
import type { DecisionAdmissionRequest } from "./short-decisions.ts";
import { DecisionItem, decisionDigest, parseDecisionBatch, checkDecisionRecord, ShortDecisionError } from "./short-decision-format.ts";
import type { DecisionAdmission, DecisionBatch, ShortDecisionRecord } from "./short-decision-format.ts";
import {
  InteractionAction, InteractionBasis, CandidateBinding, PendingQuestion, UserInteractionError,
  checkInteraction, checkContext, checkProposal, checkInterpretation, parseInteraction,
} from "./user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation, InteractionEntry } from "./user-interaction-format.ts";
import { ApprovalUnitIds, ApprovalPartition } from "./user-interaction-format.ts";
import { adviceOf } from "./tool-failure.ts";
import { INTERACTION_CONTINUITY_NAMESPACE, recordInteractionResolutionIn, loadInteractionContinuity, assertRetainedEvidenceIn, continuityInputProofIn } from "./interaction-continuity.ts";
import { validateDocumentReview, createApprovalManifest, checkApprovalManifest, approvalManifestReference } from "./approval-manifest.ts";
import type { ApprovalManifest, ApprovalManifestReference } from "./approval-manifest.ts";

export type { InteractionAction, InteractionBasis, CandidateBinding, PendingQuestion, InteractionContext, InteractionInterpretation } from "./user-interaction-format.ts";
export { UserInteractionError } from "./user-interaction-format.ts";
export interface InteractionModelIdentity { readonly provider: string; readonly id: string; readonly configurationHash: string }
export interface InteractionInterpreter {
  /** 真实适配器从宿主当前选择读取；fixture必须明确标为受控解释器。 */
  identity(): InteractionModelIdentity;
  interpret(input: { text: string; context: InteractionContext; model: InteractionModelIdentity; signal: AbortSignal }): Promise<string>;
}
export interface UserInteractionOptions extends RequirementStoreOptions {
  interpreter: InteractionInterpreter;
  /** 必需的可信同步动作门槛，与当前输入许可取交集；闭包绑定真实主体，不接收模型自报权限。 */
  authorizeAction: (request: InteractionAuthorization) => boolean;
  /** 可信服务提供已核对的当前正文与候选准确diff；不能直接接模型工具传入的解释结论。 */
  loadContext: (requirementId: string, signal: AbortSignal) => Promise<InteractionContext>;
  inputTtlMs?: number;
}
/** 仅对象身份有效，不可从JSON重建，不向模型工具暴露。 */
export interface InteractionCapability { readonly kind: "interaction-capability" }
export interface InputTicket { readonly kind: "host-input-ticket" }
export interface CandidateResavePermit { readonly kind: "candidate-resave-permit" }
export interface CandidateResaveExpectation { operationId: string; intentHash: string; targetHash: string; origin: object }
interface CandidateResave { permit: CandidateResavePermit; previous: Verified; expected: CandidateResaveExpectation; before: RequirementAccessState; change?: RequirementAccessChange; completed: boolean }
export interface InteractionAuthorization {
  readonly repoId: string;
  readonly basis: InteractionBasis;
  readonly candidate: CandidateBinding;
  readonly action: InteractionAction | "authorize-document";
  readonly manifest?: ApprovalManifestReference;
  readonly goalIds?: readonly string[];
  readonly constraintIds?: readonly string[];
  readonly receiptId: string;
  readonly scope: string;
  readonly inputProof?: string;
}
const QuestionInput = object({ basis: InteractionBasis, candidate: Type.Union([CandidateBinding, Type.Null()]), proposal: DecisionItem,
  actions: Type.Array(InteractionAction, { maxItems: 5, uniqueItems: true }), unitIds: Type.Optional(ApprovalUnitIds), partition: Type.Optional(ApprovalPartition) });
const Input = object({ source: Type.Union([Type.Literal("interactive"), Type.Literal("rpc")]), text: Type.String({ minLength: 1 }) });
const Session = object({ sessionId: Type.String({ minLength: 1, maxLength: 128 }), windowId: Type.String({ minLength: 1, maxLength: 128 }) });
const QUESTIONS = "interaction_questions_v1";
interface ActiveInput {
  ticket: InputTicket; text: string; source: "interactive" | "rpc"; expiresAt: number; controller: AbortController; used: boolean; reconsiderations: number;
}
interface Verified {
  capability: InteractionCapability; input: ActiveInput; context: InteractionContext; model: InteractionModelIdentity;
  result: InteractionInterpretation; batch: DecisionBatch; admission: DecisionAdmission; receiptId: string;
  saved?: { operationId: string; decisionIds: string[] };
  savedRecords?: Array<{ version: number; record: ShortDecisionRecord }>;
  manifest?: ApprovalManifest;
  continuitySaved?: boolean;
  continuityRecord?: { version: number; hash: string };
  inputProof?: string;
  savedInputProof?: string;
  originalRevisions?: Array<{ version: number; record: ShortDecisionRecord }>;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function confirmed(entry: InteractionEntry): boolean {
  return ["explicit", "delegated"].includes(entry.basis) && !["defer", "unclear"].includes(entry.resolution);
}
function relevant(entry: InteractionEntry, candidateId: string): boolean {
  // 无关联的未来讨论未纳入执行；其他无关联约束/未知项不能被推定为与当前候选无关。
  return entry.candidateId === candidateId || entry.candidateId === null && entry.kind !== "future";
}
function synchronousPermission(value: unknown): boolean {
  if (isPromise(value)) {
    void Promise.prototype.then.call(value, () => undefined, () => undefined);
    return false;
  }
  if (value && (typeof value === "object" || typeof value === "function")) {
    // 消费非法异步返回的迟到拒绝；异步完成永远不会恢复本次许可。
    void Promise.resolve(value).catch(() => undefined);
    return false;
  }
  return value === true;
}
/**
 * 宿主内部组件：startSession/captureInput只能由真实input事件处理器持有。
 * 任意同进程恶意扩展不在隔离保证内；工具注册层不得转发原话、角色或能力参数。
 * 原文只驻留当前输入和一次无工具模型调用；释放JS引用不承诺擦除GC/远端已收到的字节。
 */
export class UserInteractionCore {
  readonly #options: UserInteractionOptions;
  readonly #state: RequirementStateStore;
  #decisions!: ShortDecisionStore;
  #session: { sessionId: string; windowId: string } | undefined;
  #input: ActiveInput | undefined;
  #verified: Verified | undefined;
  #resave: CandidateResave | undefined;
  #saving: Verified | undefined;
  #authorizing = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #seen = new WeakSet<object>();
  readonly #ttl: number;
  private constructor(options: UserInteractionOptions, state: RequirementStateStore) {
    this.#options = { ...options }; this.#state = state; this.#ttl = options.inputTtlMs ?? 900_000;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl <= 0 || this.#ttl > 900_000) throw new UserInteractionError("invalid_ttl");
  }
  static async open(options: UserInteractionOptions): Promise<UserInteractionCore> {
    const core = new UserInteractionCore(options, await RequirementStateStore.open(options));
    core.#decisions = await ShortDecisionStore.open({ ...options, authorize: (request) => core.#storeAccess(request), admit: (request) => core.#admit(request) });
    return core;
  }
  startSession(binding: { sessionId: string; windowId: string }): void {
    this.shutdown(); this.#session = frozen(checkInteraction(Session, binding));
  }
  clearInput(): void {
    const input = this.#input;
    this.#input = undefined; this.#verified = undefined; this.#saving = undefined; this.#resave = undefined;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    if (input) { input.text = ""; input.controller.abort(); }
  }
  shutdown(): void { this.clearInput(); this.#session = undefined; }
  /** 宿主在closing/epoch更新/显式撤权时立即调用；各次操作仍独立查真实状态。 */
  revoke(): void { this.clearInput(); }
  captureInput(event: { source: string; text: string }, sessionId: string, deadline?: number): InputTicket {
    this.clearInput(); this.#requireSession(sessionId);
    if (!event || typeof event !== "object" || this.#seen.has(event)) throw new UserInteractionError("input_reentry");
    this.#seen.add(event);
    const checkedInput = checkInteraction(Input, event);
    if (!checkedInput.text.trim()) throw new UserInteractionError("empty_input");
    const ticket: InputTicket = Object.freeze({ kind: "host-input-ticket" });
    const now = this.#now(), expiresAt = checked(counter, Math.min(now + this.#ttl, deadline ?? now + this.#ttl));
    if (expiresAt <= now) throw new UserInteractionError("input_expired");
    this.#input = { ticket, text: checkedInput.text, source: checkedInput.source, expiresAt, controller: new AbortController(), used: false, reconsiderations: 0 };
    this.#timer = setTimeout(() => this.clearInput(), expiresAt - now); this.#timer.unref();
    return ticket;
  }
  /** 问题是未生效的简短提议。答复与修订由短决策的requestId引用和supersedes表达。 */
  ask(source: string): PendingQuestion {
    this.#requireSession();
    const input = parseInteraction(QuestionInput, source); this.#assertBasis(input.basis);
    checkProposal(input.proposal, input.basis);
    if (input.candidate && decisionDigest(input.candidate.from) !== decisionDigest(input.basis.prod)) throw new UserInteractionError("candidate_baseline_mismatch");
    if (input.unitIds && (!input.unitIds.length || !input.candidate)) throw new UserInteractionError("question_units_without_candidate");
    if (input.partition && (input.partition.prodHash !== input.candidate?.to.hash || input.unitIds?.some((id) => !input.partition!.units.some((u) => u.id === id)))) throw new UserInteractionError("question_partition_mismatch");
    const question = checkInteraction(PendingQuestion, { format: "interaction-question/v1", ...input,
      requestId: uuidv7(), repoId: this.#options.repoId, createdAt: this.#now() });
    this.#access("record-decisions", { requirementId: input.basis.requirementId });
    withDatabase(this.#path(), (db) => db.transaction(() => {
      this.#assertBasis(input.basis); this.#access("record-decisions", { requirementId: input.basis.requirementId });
      db.create(QUESTIONS, question.requestId, question, question.requestId);
    }));
    return question;
  }
  readQuestion(requestId: string, basis: InteractionBasis): PendingQuestion {
    this.#requireSession(); checked(id, requestId); this.#assertBasis(basis);
    this.#access("read-decisions", { requirementId: basis.requirementId, requestId });
    const stored = withDatabase(this.#path(), (db) => db.read(QUESTIONS, requestId));
    if (!stored || stored.id !== requestId) throw new UserInteractionError("unknown_question");
    const q = checkInteraction(PendingQuestion, stored.data); checkProposal(q.proposal, basis);
    if (q.requestId !== requestId || q.repoId !== this.#options.repoId || decisionDigest(q.basis) !== decisionDigest(basis)) throw new UserInteractionError("question_identity_mismatch");
    this.#assertBasis(basis); this.#access("read-decisions", { requirementId: basis.requirementId, requestId }); return q;
  }
  async interpret(ticket: InputTicket, requirementId: string): Promise<{ interpretation: InteractionInterpretation; capability: InteractionCapability }> {
    const input = this.#currentInput();
    if (ticket !== input.ticket || input.used) throw new UserInteractionError("invalid_input_ticket");
    input.used = true;
    try {
      checked(id, requirementId);
      const before = this.#state.read(requirementId);
      if (!["draft", "active"].includes(before.data.lifecycle) || before.data.recovery !== "ready") throw new UserInteractionError("lifecycle_denied");
      const model = frozen(structuredClone(this.#options.interpreter.identity()));
      if (!model.provider || !model.id || !/^[0-9a-f]{64}$/.test(model.configurationHash)) throw new UserInteractionError("model_unavailable");
      const context = frozen(checkContext(await this.#options.loadContext(requirementId, input.controller.signal)));
      this.#assertInput(input);
      if (context.basis.requirementId !== requirementId) throw new UserInteractionError("foreign_requirement");
      if (input.reconsiderations > 0 && !context.document) throw new UserInteractionError("document_review_required");
      this.#assertBasis(context.basis);
      if (context.document && decisionDigest(this.#state.read(requirementId).data.saved) !== decisionDigest(context.document.candidate.to)) throw new UserInteractionError("candidate_not_saved");
      this.#checkQuestions(context, true);
      const inputProof = context.document ? context.inputProof ?? withDatabase(this.#path(), (db) => continuityInputProofIn(db, requirementId)) : undefined;
      for (const old of context.priorDecisions) if (decisionDigest(this.readDecision(requirementId, old.decisionId)) !== decisionDigest(old)) throw new UserInteractionError("decision_changed");
      if (Buffer.byteLength(JSON.stringify({ text: input.text, context })) > 65_536) throw new UserInteractionError("request_limit");
      const source = await this.#options.interpreter.interpret({ text: input.text, context, model, signal: input.controller.signal });
      this.#assertInput(input); this.#assertBasis(context.basis); this.#assertModel(model);
      const result = frozen(checkInterpretation(source, context));
      if (context.document) {
        validateDocumentReview(context, result);
        for (const [index, entry] of result.entries.entries()) for (const oldId of entry.supersedes) {
          const origin = context.revisionSources?.find((source) => source.decision.id === oldId);
          if (!context.savedOperationId) continue;
          const units = result.documentReview!.units.filter((unit) => unit.conclusionIndexes.includes(index)).map((unit) => unit.id);
          if (!origin || origin.unitIds.some((unit) => unit.id !== "metadata" && !units.includes(unit.id) &&
            !(entry.kind === "exclusion" && !context.document!.partition.units.some((current) => current.id === unit.id)))) throw new UserInteractionError("revision_scope_mismatch");
        }
        if (result.referenceResolution === "single-question") {
          const revised = new Set(result.entries.flatMap((entry) => entry.supersedes));
          if (result.entries.some((entry) => entry.kind === "constraint" && entry.requestId === null && entry.references.some((id) => revised.has(id)))) throw new UserInteractionError("revision_source_reused");
        }
      }
      for (const entry of result.entries) {
        if (entry.basis === "delegated" && !result.entries.some((e) => e.kind === "delegation" && e.basis === "explicit" && confirmed(e) && e.candidateId === entry.candidateId)) throw new UserInteractionError("delegation_required");
      }
      const receiptId = uuidv7(), operationId = uuidv7();
      const batch = parseDecisionBatch(JSON.stringify({ ...context.basis, operationId, decisions: result.entries.map((e) => {
        const candidate = context.candidates.find((c) => c.candidateId === e.candidateId);
        const references = [...new Set([...e.references, ...(e.requestId ? [e.requestId] : []),
          ...(candidate ? [candidate.candidateId, candidate.intentHash, candidate.to.commit, candidate.to.hash] : [])])];
        return { conclusion: e.conclusion, scope: e.scope, references, supersedes: e.supersedes };
      }) }));
      const admission: DecisionAdmission = { requestHash: decisionDigest({ repoId: this.#options.repoId, batch }),
        subjects: result.entries.map((e) => ({ actor: ["ai-choice", "suggestion"].includes(e.kind) ? "ai" : "user",
          status: confirmed(e) ? "confirmed" : "pending", basisReceiptId: confirmed(e) ? receiptId : null })) };
      const capability: InteractionCapability = Object.freeze({ kind: "interaction-capability" });
      // 完整候选正文只用于本次模型输入；能力仅保留分区与审核元数据。原输入按TTL留在有界内存供宿主重解释。
      const retained = context.document ? frozen({ ...context, currentGoal: "", candidates: context.candidates.map((c) => ({ ...c, diff: "" })),
        document: { ...context.document, title: "", body: "" } }) : context;
      this.#verified = { capability, input, context: retained, model, result, batch: frozen(batch), admission: frozen(admission), receiptId, inputProof };
      return { interpretation: structuredClone(result), capability };
    } catch (error) {
      if (this.#input === input) this.clearInput();
      // 本模块与短决定格式的核验错误只含程序生成的原因，原样交给主代理；其余可能带原文、prod片段或供应商响应正文，只报笼统原因
      if (error instanceof UserInteractionError || error instanceof ShortDecisionError) throw error;
      throw new UserInteractionError("interpretation_denied");
    }
  }
  /** 保存前先撤掉行为能力，原输入只留作本次准确重存的重解释材料。 */
  prepareCandidateResave(ticket: InputTicket, expected: CandidateResaveExpectation): CandidateResavePermit {
    const v = this.#verified;
    if (!v || this.#resave || this.#requireVerified(v.capability) !== v || v.input.ticket !== ticket || !v.context.document ||
      v.result.documentReview?.faithful !== false || v.input.reconsiderations >= 3 || this.#saving || this.#authorizing) throw new UserInteractionError("reconsideration_denied");
    checked(id, expected.operationId);
    if (!/^[0-9a-f]{64}$/.test(expected.intentHash) || !/^[0-9a-f]{64}$/.test(expected.targetHash) || !expected.origin ||
      expected.targetHash === v.context.document.candidate.to.hash) throw new UserInteractionError("candidate_not_resaved");
    const record = this.#state.read(v.context.basis.requirementId);
    const before = withDatabase(this.#path(), (db) => db.transaction(() => {
      const current = db.read("requirements", record.id);
      if (!current || current.version !== record.version || decisionDigest(current.data) !== decisionDigest(record.data)) throw new UserInteractionError("basis_changed");
      return { record, pmLeaseHash: createHash("sha256").update(JSON.stringify(db.read<{ lease?: unknown }>("pm_ownership", record.id)?.data.lease ?? null)).digest("hex") };
    }));
    const permit: CandidateResavePermit = Object.freeze({ kind: "candidate-resave-permit" });
    this.#verified = undefined;
    this.#resave = { permit, previous: v, expected: { ...expected }, before: frozen(before), completed: false };
    return permit;
  }
  observeCandidateResave(permit: CandidateResavePermit, change: RequirementAccessChange): void {
    const r = this.#resave;
    try {
      if (!r || r.permit !== permit || r.change || change.origin !== r.expected.origin || change.action !== "saved-version" ||
        change.operationId !== r.expected.operationId || change.repoId !== this.#options.repoId ||
        decisionDigest(change.before) !== decisionDigest(r.before)) throw new UserInteractionError("resave_origin_mismatch");
      this.#assertInput(r.previous.input); this.#assertModel(r.previous.model);
      const a = change.after.record, b = change.before.record;
      if (!a || !b || change.requirementId !== b.id || a.id !== b.id || a.version !== b.version + 1 ||
        !a.data.saved || a.data.saved.hash !== r.expected.targetHash || change.after.pmLeaseHash !== change.before.pmLeaseHash ||
        decisionDigest({ ...a.data, saved: b.data.saved, updatedAt: b.data.updatedAt }) !== decisionDigest(b.data)) throw new UserInteractionError("resave_state_mismatch");
      r.change = change;
    } catch (error) { this.clearInput(); throw error; }
  }
  completeCandidateResave(permit: CandidateResavePermit): void {
    const r = this.#resave;
    try {
      if (!r || r.permit !== permit || !r.change || r.completed) throw new UserInteractionError("reconsideration_denied");
      this.#checkResave(r); r.completed = true;
    } catch (error) { this.clearInput(); throw error; }
  }
  cancelCandidateResave(permit: CandidateResavePermit): void { if (this.#resave?.permit === permit) this.clearInput(); }
  #checkResave(r: CandidateResave): void {
    this.#assertInput(r.previous.input); this.#assertModel(r.previous.model);
    const op = new RequirementOperations(this.#options).read(r.expected.operationId), after = r.change?.after;
    if (!op || !after?.record || op.data.action !== "updateDraft" || op.data.requirementId !== after.record.id ||
      op.data.saveVersion !== r.before.record!.version || op.data.finalVersion !== after.record.version || op.data.savedVersion !== after.record.version ||
      op.data.intentHash !== r.expected.intentHash || op.data.targetHash !== r.expected.targetHash || op.data.epoch !== after.record.data.epoch ||
      op.data.git?.commit !== after.record.data.saved?.commit || op.data.git?.hash !== after.record.data.saved?.hash) throw new UserInteractionError("resave_not_finalized");
    withDatabase(this.#path(), (db) => db.transaction(() => {
      const current = db.read("requirements", after.record!.id), operation = db.read(REQUIREMENT_OPERATION_NAMESPACE, r.expected.operationId);
      const pm = createHash("sha256").update(JSON.stringify(db.read<{ lease?: unknown }>("pm_ownership", after.record!.id)?.data.lease ?? null)).digest("hex");
      if (!current || current.version !== after.record!.version || decisionDigest(current.data) !== decisionDigest(after.record!.data) ||
        pm !== after.pmLeaseHash || !operation || operation.version !== op.version || decisionDigest(operation.data) !== decisionDigest(op.data)) throw new UserInteractionError("resave_state_mismatch");
    }));
  }
  /** 仅消费已完成重存的私有permit，不捕获新输入、不刷新截止时间。 */
  async reconsiderSavedCandidate(ticket: InputTicket, requirementId: string, permit?: CandidateResavePermit): Promise<{ interpretation: InteractionInterpretation; capability: InteractionCapability }> {
    const r = this.#resave, input = this.#currentInput();
    if (!r || permit !== r.permit || !r.completed || ticket !== input.ticket || r.previous.context.basis.requirementId !== requirementId ||
      r.previous.input !== input || input.reconsiderations >= 3) throw new UserInteractionError("reconsideration_denied");
    try { this.#checkResave(r); } catch (error) { this.clearInput(); throw error; }
    this.#resave = undefined; input.reconsiderations++; input.used = false;
    return this.interpret(ticket, requirementId);
  }
  save(capability: InteractionCapability): { operationId: string; decisionIds: string[] } {
    const verified = this.#requireVerified(capability);
    if (verified.saved) { this.#finishSaved(verified); return structuredClone(verified.saved); }
    if (this.#saving) throw new UserInteractionError("save_reentry");
    this.#saving = verified;
    try {
      const revised = new Set(verified.result.entries.flatMap((entry) => entry.supersedes));
      verified.originalRevisions = frozen(withDatabase(this.#path(), (db) => [...revised].map((decisionId) => {
        const row = db.read("short_decisions", decisionId), original = verified.context.priorDecisions.find((record) => record.decisionId === decisionId);
        if (!row || !original || decisionDigest(row.data) !== decisionDigest(original)) throw new UserInteractionError("decision_changed");
        return { version: row.version, record: original };
      })));
      const saved = this.#decisions.append(JSON.stringify(verified.batch));
      // 先保留实际已提交的操作结果；后续事实核验失败只能续办此操作，不能重写决定。
      verified.saved = frozen(saved);
      this.#captureSavedRecords(verified);
      this.#finishSaved(verified);
      return structuredClone(saved);
    } finally { this.#saving = undefined; }
  }
  #captureSavedRecords(verified: Verified): void {
      const saved = verified.saved;
      if (!saved) throw new UserInteractionError("saved_decision_missing");
      const records = withDatabase(this.#path(), (db) => saved.decisionIds.map((decisionId, index) => {
        const stored = db.read("short_decisions", decisionId);
        if (!stored || stored.id !== decisionId || stored.version !== 1) throw new UserInteractionError("saved_decision_missing");
        const record = checkDecisionRecord(stored.data);
        const { recordedAt: _recordedAt, ...facts } = record;
        const expected = { format: "short-decision/v1", decisionId, operationId: verified.batch.operationId,
          requirementId: verified.batch.requirementId, repoId: this.#options.repoId,
          requirementVersion: verified.batch.version, epoch: verified.batch.epoch, prod: verified.batch.prod,
          ...verified.batch.decisions[index], ...verified.admission.subjects[index], supersededBy: null };
        if (decisionDigest(facts) !== decisionDigest(expected)) throw new UserInteractionError("saved_decision_changed");
        return { version: stored.version, record };
      }));
      // 单题短答借用的独立约束来源也属于审核依据；保存后仍逐次核验，取代不能被复制的新记录掩盖。
      if (verified.context.document && verified.result.referenceResolution === "single-question") {
        const sourceIds = new Set(verified.result.entries.filter((e) => e.kind === "constraint" && e.requestId === null && e.resolution === "direct").flatMap((e) => e.references));
        for (const source of verified.context.priorDecisions.filter((d) => sourceIds.has(d.decisionId))) {
          const stored = withDatabase(this.#path(), (db) => db.read("short_decisions", source.decisionId));
          if (!stored || stored.id !== source.decisionId || decisionDigest(stored.data) !== decisionDigest(source)) throw new UserInteractionError("decision_changed");
          records.push({ version: stored.version, record: source });
        }
      }
      verified.savedRecords = frozen(records);
  }
  #assertSavedRevisions(db: LocalDatabase, v: Verified, records = v.savedRecords): void {
    if (!v.saved || !v.savedRecords || !records) throw new UserInteractionError("saved_decision_missing");
    for (const { version, record } of records) {
      const row = db.read("short_decisions", record.decisionId);
      if (!row || row.id !== record.decisionId || row.version !== version || decisionDigest(row.data) !== decisionDigest(record)) throw new UserInteractionError("decision_changed");
    }
    if (v.continuitySaved && v.context.document &&
      (!v.savedInputProof || continuityInputProofIn(db, v.context.basis.requirementId) !== v.savedInputProof)) throw new UserInteractionError("continuity_changed");
    if (v.continuitySaved && v.continuityRecord) {
      const fact = db.read(INTERACTION_CONTINUITY_NAMESPACE, v.saved.operationId);
      if (!fact || fact.version !== v.continuityRecord.version || decisionDigest(fact.data) !== v.continuityRecord.hash) throw new UserInteractionError("continuity_fact_changed");
    }
    for (const original of v.originalRevisions ?? []) {
      const replacements = records.filter(({ record }) => record.operationId === v.saved!.operationId && record.supersedes.includes(original.record.decisionId));
      if (!replacements.length && records !== v.savedRecords) continue;
      if (replacements.length !== 1) throw new UserInteractionError("revision_link_mismatch");
      const replacement = replacements[0]!.record, row = db.read("short_decisions", original.record.decisionId);
      if (!row || row.id !== original.record.decisionId || row.version !== original.version + 1 ||
        decisionDigest(row.data) !== decisionDigest({ ...original.record, status: "superseded", supersededBy: replacement.decisionId })) throw new UserInteractionError("revision_source_changed");
    }
  }
  #finishSaved(v: Verified): void {
    if (!v.saved || !v.savedRecords) throw new UserInteractionError("saved_decision_missing");
    if (!v.continuitySaved) {
      this.#requireVerified(v.capability);
      withDatabase(this.#path(), (db) => db.transaction(() => {
        this.#assertSavedRevisions(db, v);
        if (v.context.document) {
          const originals = new Map((v.originalRevisions ?? []).map(({ version, record }) => [record.decisionId, { id: record.decisionId, version, data: record }]));
          if (continuityInputProofIn(db, v.context.basis.requirementId, { excludeOperationId: v.saved!.operationId, originals }) !== v.inputProof) throw new UserInteractionError("continuity_changed");
        }
        for (const { version, record } of v.savedRecords!) {
          const row = db.read("short_decisions", record.decisionId);
          if (!row || row.version !== version || decisionDigest(row.data) !== decisionDigest(record)) throw new UserInteractionError("decision_changed");
        }
        recordInteractionResolutionIn(db, this.#options.repoId, v.context, v.result, v.saved!, v.receiptId);
        const fact = db.read(INTERACTION_CONTINUITY_NAMESPACE, v.saved!.operationId);
        if (fact) v.continuityRecord = { version: fact.version, hash: decisionDigest(fact.data) };
        if (v.context.document) v.savedInputProof = continuityInputProofIn(db, v.context.basis.requirementId);
      }));
      v.continuitySaved = true;
    }
    if (!v.manifest && v.context.document && v.result.documentReview?.faithful) v.manifest = frozen(createApprovalManifest(v.context, v.result, v.saved.decisionIds));
  }
  #checkQuestions(context: InteractionContext, checkView: boolean, verified?: Verified): void {
    let inputCheck: Parameters<typeof loadInteractionContinuity>[4];
    if (verified?.saved && context.document) {
      withDatabase(this.#path(), (db) => this.#assertSavedRevisions(db, verified));
      inputCheck = { excludeOperationId: verified.saved.operationId,
        originals: new Map((verified.originalRevisions ?? []).map(({ version, record }) => [record.decisionId, { id: record.decisionId, version, data: record }])),
        replacements: new Map(verified.savedRecords!.filter(({ record }) => record.operationId === verified.saved!.operationId)
          .map(({ version, record }) => [record.decisionId, { id: record.decisionId, version, data: record }])) };
    }
    if (context.document && context.savedOperationId && (checkView || inputCheck)) {
      const actual = loadInteractionContinuity(this.#options.dataRoot, this.#options.repoId, context.basis, context.document, inputCheck);
      if (decisionDigest(actual.questions) !== decisionDigest(context.questions) || decisionDigest(actual.effectiveQuestions) !== decisionDigest(context.effectiveQuestions ?? []) ||
        decisionDigest(actual.retainedEvidence) !== decisionDigest(context.retainedEvidence ?? []) || decisionDigest(actual.continuityIssues) !== decisionDigest(context.continuityIssues ?? []) ||
        decisionDigest(actual.revisionSources) !== decisionDigest(context.revisionSources ?? []) || decisionDigest(actual.priorDecisions) !== decisionDigest(context.priorDecisions) || actual.inputProof !== context.inputProof) throw new UserInteractionError("continuity_changed");
    }
    withDatabase(this.#path(), (db) => {
      for (const q of context.questions) {
        const row = db.read(QUESTIONS, q.requestId);
        if (!row || row.id !== q.requestId || decisionDigest(row.data) !== decisionDigest(q)) throw new UserInteractionError("question_changed");
        if (!context.savedOperationId && decisionDigest(q.basis) !== decisionDigest(context.basis)) throw new UserInteractionError("question_identity_mismatch");
      }
      for (const e of context.retainedEvidence ?? []) {
        if (inputCheck?.originals.has(e.decision.id)) continue; // 已在同一输入对照中验证本次准确取代，不能进入新manifest。
        if (!context.document) throw new UserInteractionError("document_review_required");
        assertRetainedEvidenceIn(db, this.#options.repoId, context.basis, context.document, e);
      }
    });
  }
  /** 合法保存的决定按活动需求读取；不要求输入、模型或原会话仍存在，也不将记录升级为能力。 */
  readDecision(requirementId: string, decisionId: string): ShortDecisionRecord { return this.#decisions.read(requirementId, decisionId); }
  /** 整份文档阅读/清单许可；全pending亦可读取，不授予active或PM启动，后者另核验明确目标和动作。 */
  authorizeDocument(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }): { authorization: InteractionAuthorization; manifest: ApprovalManifest } | null {
    const authorization = this.#authorizeManifest(capability, binding);
    const manifest = this.#verified?.manifest;
    return authorization && manifest ? { authorization, manifest: structuredClone(manifest) } : null;
  }
  #authorizeManifest(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }): InteractionAuthorization | null {
    if (this.#authorizing) return null;
    this.#authorizing = true;
    try {
      const v = this.#requireVerified(capability), doc = v.context.document;
      if (!doc || !v.manifest || !v.savedRecords || decisionDigest(binding.basis) !== decisionDigest(v.context.basis) ||
        decisionDigest(binding.candidate) !== decisionDigest(doc.candidate)) return null;
      const manifest = checkApprovalManifest(v.manifest, { requirementId: v.context.basis.requirementId, candidate: doc.candidate, partition: doc.partition });
      const request: InteractionAuthorization = frozen({ repoId: this.#options.repoId, basis: structuredClone(v.context.basis), candidate: structuredClone(doc.candidate),
        action: "authorize-document", receiptId: v.receiptId, scope: "manifest-bound-scope",
        manifest: approvalManifestReference(manifest), ...(v.savedInputProof ? { inputProof: v.savedInputProof } : {}) });
      if (!synchronousPermission(this.#options.authorizeAction?.(request)) || this.#requireVerified(capability) !== v) return null;
      // 任一审核依据变化均保守失效；独立范围的后续续行需要可信局部影响复核，本组件不提供恢复通路。
      const records = v.savedRecords;
      for (const { record } of records) if (record.status === "superseded" || decisionDigest(this.readDecision(v.context.basis.requirementId, record.decisionId)) !== decisionDigest(record)) return null;
      const current = this.#state.read(v.context.basis.requirementId);
      this.#assertInput(v.input); this.#assertModel(v.model);
      // 所有宿主回调结束后，同步只读快照核对状态与全部审核依据；待确认描述也不能被静默换绑。
      const unchanged = withDatabase(this.#path(), (db) => db.transaction(() => {
        this.#assertSavedRevisions(db, v);
        for (const e of manifest.retainedSources ?? []) assertRetainedEvidenceIn(db, this.#options.repoId, v.context.basis, doc, e);
        const state = db.read("requirements", v.context.basis.requirementId);
        if (!state || state.id !== current.id || state.version !== current.version || current.version !== v.context.basis.version ||
          decisionDigest(state.data) !== decisionDigest(current.data) || current.data.epoch !== v.context.basis.epoch ||
          current.data.recovery !== "ready" || !["draft", "active"].includes(current.data.lifecycle) ||
          decisionDigest(current.data.saved) !== decisionDigest(doc.candidate.to) ||
          decisionDigest(current.data.lifecycle === "active" ? current.data.approved : current.data.saved) !== decisionDigest(v.context.basis.prod)) return false;
        return records.every(({ version, record }) => {
          const stored = db.read("short_decisions", record.decisionId);
          return stored?.id === record.decisionId && stored.version === version && record.status !== "superseded" &&
            decisionDigest(stored.data) === decisionDigest(record);
        });
      }));
      return unchanged && this.#verified === v && this.#input === v.input && this.#session && !v.input.controller.signal.aborted ? request : null;
    } catch (error) {
      // 带原因的核对失败按设计表示这次不放行；数据库或程序出错要如实上报，不能说成草稿需要修改或澄清
      if (adviceOf(error)) return null;
      throw error;
    } finally { this.#authorizing = false; }
  }
  #path(): string { return repositoryDatabase(this.#options.dataRoot, this.#options.repoId); }
  #now(): number { return checked(counter, this.#options.now?.() ?? Date.now()); }
  #requireSession(sessionId?: string): void {
    if (!this.#session || sessionId !== undefined && this.#session.sessionId !== sessionId) throw new UserInteractionError("untrusted_session");
  }
  #currentInput(): ActiveInput {
    this.#requireSession(); const input = this.#input;
    if (!input || input.expiresAt <= this.#now() || input.controller.signal.aborted) { this.clearInput(); throw new UserInteractionError("input_expired"); }
    return input;
  }
  #assertInput(input: ActiveInput): void { if (this.#currentInput() !== input) throw new UserInteractionError("input_changed"); }
  #assertModel(model: InteractionModelIdentity): void {
    if (decisionDigest(this.#options.interpreter.identity()) !== decisionDigest(model)) throw new UserInteractionError("model_changed");
  }
  #assertBasis(basis: InteractionBasis): void {
    const current = this.#state.read(basis.requirementId);
    const prod = current.data.lifecycle === "active" ? current.data.approved : current.data.saved;
    if (!["draft", "active"].includes(current.data.lifecycle) || current.data.recovery !== "ready" ||
      current.version !== basis.version || current.data.epoch !== basis.epoch || decisionDigest(prod) !== decisionDigest(basis.prod)) {
      this.clearInput(); throw new UserInteractionError("basis_changed");
    }
  }
  #access(action: "read-decisions" | "record-decisions", input: Record<string, unknown>): void {
    const result = this.#options.authorize?.(frozen({ action, repoId: this.#options.repoId, input: structuredClone(input) }));
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new UserInteractionError("authorization_required");
  }
  #requireVerified(capability: InteractionCapability): Verified {
    const v = this.#verified;
    if (!v || capability !== v.capability) throw new UserInteractionError("invalid_capability");
    this.#assertInput(v.input); this.#assertBasis(v.context.basis); this.#assertModel(v.model);
    if (v.saved && !v.savedRecords) this.#captureSavedRecords(v);
    this.#checkQuestions(v.context, !v.saved, v);
    if (!v.saved && v.context.document && withDatabase(this.#path(), (db) => continuityInputProofIn(db, v.context.basis.requirementId)) !== v.inputProof) throw new UserInteractionError("continuity_changed");
    if (!v.saved) for (const old of v.context.priorDecisions) if (decisionDigest(this.readDecision(v.context.basis.requirementId, old.decisionId)) !== decisionDigest(old)) throw new UserInteractionError("decision_changed");
    this.#assertInput(v.input);
    if (this.#verified !== v) throw new UserInteractionError("input_changed");
    return v;
  }
  #storeAccess(request: StateAuthorizationRequest): boolean {
    try {
      const saving = this.#saving;
      const allowed = this.#options.authorize?.(request);
      if (isPromise(allowed)) void Promise.prototype.then.call(allowed, () => undefined, () => undefined);
      if (allowed !== true) return false;
      if (request.action !== "record-decisions") return true;
      return saving !== undefined && this.#saving === saving && this.#requireVerified(saving.capability) === saving;
    } catch (error) {
      // 带原因的失效按设计算作没有授权；数据库或程序出错要如实上报，不能说成没有授权
      if (adviceOf(error)) return false;
      throw error;
    }
  }
  #admit(request: DecisionAdmissionRequest): DecisionAdmission | null {
    try {
      const v = this.#saving;
      if (!v || this.#requireVerified(v.capability) !== v || request.repoId !== this.#options.repoId ||
        request.requestHash !== v.admission.requestHash || decisionDigest(request.batch) !== decisionDigest(v.batch)) return null;
      return v.admission;
    } catch (error) {
      if (adviceOf(error)) return null;
      throw error;
    }
  }
}
