import { Type } from "typebox";
import { isPromise } from "node:util/types";
import { uuidv7, repositoryDatabase, withDatabase } from "./database.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import type { RequirementStoreOptions, StateAuthorizationRequest } from "./requirement-state.ts";
import { object, id, counter, checked } from "./requirement-contracts.ts";
import { ShortDecisionStore } from "./short-decisions.ts";
import type { DecisionAdmissionRequest } from "./short-decisions.ts";
import { DecisionItem, decisionDigest, parseDecisionBatch, checkDecisionRecord } from "./short-decision-format.ts";
import type { DecisionAdmission, DecisionBatch, ShortDecisionRecord } from "./short-decision-format.ts";
import {
  InteractionAction, InteractionBasis, CandidateBinding, PendingQuestion, UserInteractionError,
  checkInteraction, checkContext, checkProposal, checkInterpretation, candidateBinding, parseInteraction,
} from "./user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation, InteractionEntry } from "./user-interaction-format.ts";
import { ApprovalUnitIds } from "./user-interaction-format.ts";
import { validateDocumentReview, createApprovalManifest, checkApprovalManifest, approvedManifestScope, approvalManifestReference } from "./approval-manifest.ts";
import type { ApprovalManifest, ApprovalManifestReference, ApprovalScope } from "./approval-manifest.ts";

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
export interface InteractionAuthorization {
  readonly repoId: string;
  readonly basis: InteractionBasis;
  readonly candidate: CandidateBinding;
  readonly action: InteractionAction | "confirm-target" | "authorize-document";
  readonly manifest?: ApprovalManifestReference;
  readonly goalIds?: readonly string[];
  readonly constraintIds?: readonly string[];
  readonly receiptId: string;
  readonly scope: string;
}
const QuestionInput = object({ basis: InteractionBasis, candidate: Type.Union([CandidateBinding, Type.Null()]), proposal: DecisionItem,
  actions: Type.Array(InteractionAction, { maxItems: 6, uniqueItems: true }), unitIds: Type.Optional(ApprovalUnitIds) });
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
 * 宿主内部组件：startSession/captureInput只能由真实input事件处理器持有，RPC连接须已获用户许可。
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
    this.#input = undefined; this.#verified = undefined; this.#saving = undefined;
    if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined;
    if (input) { input.text = ""; input.controller.abort(); }
  }
  shutdown(): void { this.clearInput(); this.#session = undefined; }
  /** 宿主在closing/epoch更新/显式撤权时立即调用；各次操作仍独立查真实状态。 */
  revoke(): void { this.clearInput(); }
  captureInput(event: { source: string; text: string }, sessionId: string): InputTicket {
    this.clearInput(); this.#requireSession(sessionId);
    if (!event || typeof event !== "object" || this.#seen.has(event)) throw new UserInteractionError("input_reentry");
    this.#seen.add(event);
    const checkedInput = checkInteraction(Input, event);
    if (!checkedInput.text.trim()) throw new UserInteractionError("empty_input");
    const ticket: InputTicket = Object.freeze({ kind: "host-input-ticket" });
    const expiresAt = checked(counter, this.#now() + this.#ttl);
    this.#input = { ticket, text: checkedInput.text, source: checkedInput.source, expiresAt, controller: new AbortController(), used: false, reconsiderations: 0 };
    this.#timer = setTimeout(() => this.clearInput(), this.#ttl); this.#timer.unref();
    return ticket;
  }
  /** 问题是未生效的简短提议。答复与修订由短决策的requestId引用和supersedes表达。 */
  ask(source: string): PendingQuestion {
    this.#requireSession();
    const input = parseInteraction(QuestionInput, source); this.#assertBasis(input.basis);
    checkProposal(input.proposal, input.basis);
    if (input.candidate && decisionDigest(input.candidate.from) !== decisionDigest(input.basis.prod)) throw new UserInteractionError("candidate_baseline_mismatch");
    const refs = input.proposal.references.length + input.proposal.supersedes.length + (input.basis.prod ? 2 : 0) + (input.candidate ? 4 : 0);
    if (refs + (input.unitIds?.length ?? 0) > 16 || input.unitIds && (!input.unitIds.length || !input.candidate)) throw new UserInteractionError("reference_limit");
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
      for (const q of context.questions) if (decisionDigest(this.readQuestion(q.requestId, context.basis)) !== decisionDigest(q)) throw new UserInteractionError("question_changed");
      for (const old of context.priorDecisions) if (decisionDigest(this.readDecision(requirementId, old.decisionId)) !== decisionDigest(old)) throw new UserInteractionError("decision_changed");
      if (Buffer.byteLength(JSON.stringify({ text: input.text, context })) > 65_536) throw new UserInteractionError("request_limit");
      const source = await this.#options.interpreter.interpret({ text: input.text, context, model, signal: input.controller.signal });
      this.#assertInput(input); this.#assertBasis(context.basis); this.#assertModel(model);
      const result = frozen(checkInterpretation(source, context));
      if (context.document) validateDocumentReview(context, result);
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
      this.#verified = { capability, input, context: retained, model, result, batch: frozen(batch), admission: frozen(admission), receiptId };
      return { interpretation: structuredClone(result), capability };
    } catch {
      if (this.#input === input) this.clearInput();
      // 不传播可能包含原文、prod片段或供应商响应的错误正文。
      throw new UserInteractionError("interpretation_denied");
    }
  }
  /** 只允许宿主在准确候选重新保存后重用同条输入，原票据、来源、会话及TTL不变。 */
  async reconsiderSavedCandidate(ticket: InputTicket, requirementId: string): Promise<{ interpretation: InteractionInterpretation; capability: InteractionCapability }> {
    const input = this.#currentInput(), previous = this.#verified;
    if (ticket !== input.ticket || !previous || previous.input !== input || previous.context.basis.requirementId !== requirementId ||
      !previous.context.document || input.reconsiderations >= 3 || this.#saving || this.#authorizing) throw new UserInteractionError("reconsideration_denied");
    this.#assertModel(previous.model);
    const current = this.#state.read(requirementId);
    this.#assertInput(input);
    if (this.#verified !== previous || current.version <= previous.context.basis.version || current.data.epoch !== previous.context.basis.epoch ||
      current.data.recovery !== "ready" || !["draft", "active"].includes(current.data.lifecycle) || !current.data.saved ||
      decisionDigest(current.data.saved) === decisionDigest(previous.context.document.candidate.to)) throw new UserInteractionError("candidate_not_resaved");
    this.#verified = undefined; input.reconsiderations++; input.used = false;
    return this.interpret(ticket, requirementId);
  }
  save(capability: InteractionCapability): { operationId: string; decisionIds: string[] } {
    const verified = this.#requireVerified(capability);
    if (verified.saved) return structuredClone(verified.saved);
    if (this.#saving) throw new UserInteractionError("save_reentry");
    this.#saving = verified;
    try {
      const saved = this.#decisions.append(JSON.stringify(verified.batch));
      const records = withDatabase(this.#path(), (db) => saved.decisionIds.map((decisionId, index) => {
        const stored = db.read("short_decisions", decisionId);
        if (!stored || stored.id !== decisionId) throw new UserInteractionError("saved_decision_missing");
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
      verified.savedRecords = frozen(records); verified.saved = frozen(saved);
      if (verified.context.document && verified.result.documentReview?.faithful) verified.manifest = frozen(createApprovalManifest(verified.context, verified.result, saved.decisionIds));
      return structuredClone(saved);
    } finally { this.#saving = undefined; }
  }
  /** 合法保存的决定按活动需求读取；不要求输入、模型或原会话仍存在，也不将记录升级为能力。 */
  readDecision(requirementId: string, decisionId: string): ShortDecisionRecord { return this.#decisions.read(requirementId, decisionId); }
  /** 内部接线核验：每次比较完整候选及当前状态；返回的JSON只是元数据，不是新的能力。 */
  authorization(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }, action: InteractionAction | "confirm-target"): InteractionAuthorization | null {
    if (this.#authorizing) return null;
    this.#authorizing = true;
    try {
      const v = this.#requireVerified(capability);
      if (v.context.document || !v.saved || !v.savedRecords || decisionDigest(v.context.basis) !== decisionDigest(binding.basis)) return null;
      const candidate = v.context.candidates.find((c) => decisionDigest(candidateBinding(c)) === decisionDigest(binding.candidate));
      if (!candidate) return null;
      const related = v.result.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => relevant(entry, candidate.candidateId));
      // 完整候选不能夹带任何未生效条目或修改；已明确独立的其他候选不受牵连。
      if (related.some(({ entry }) => !confirmed(entry) || entry.resolution === "modify")) return null;
      const entries = related.map(({ entry }) => entry).filter((e) => e.candidateId === candidate.candidateId);
      const target = entries.find((e) => e.kind === "target" && e.basis === "explicit" && confirmed(e));
      if (!target || v.result.referenceResolution === "ambiguous") return null;
      const entry = action === "confirm-target" ? target : entries.find((e) => e.kind === "action" && e.basis === "explicit" && confirmed(e) && e.actions.includes(action));
      if (!entry) return null;
      const request = frozen({ repoId: this.#options.repoId, basis: structuredClone(v.context.basis), candidate: candidateBinding(candidate), action,
        receiptId: v.receiptId, scope: entry.scope });
      if (!synchronousPermission(this.#options.authorizeAction?.(request))) return null;
      if (this.#requireVerified(capability) !== v) return null;
      const records = related.map(({ index }) => v.savedRecords![index]!);
      for (const { record } of records) {
        if (decisionDigest(this.readDecision(v.context.basis.requirementId, record.decisionId)) !== decisionDigest(record)) return null;
      }
      const current = this.#state.read(v.context.basis.requirementId);
      this.#assertInput(v.input); this.#assertModel(v.model);
      // 所有可重入宿主回调结束后，在同一只读快照核对状态和相关决定；此后不再调用宿主。
      const unchanged = withDatabase(this.#path(), (db) => db.transaction(() => {
        const state = db.read("requirements", v.context.basis.requirementId);
        if (!state || state.id !== current.id || state.version !== current.version ||
          decisionDigest(state.data) !== decisionDigest(current.data) || current.version !== v.context.basis.version ||
          current.data.epoch !== v.context.basis.epoch || current.data.recovery !== "ready" ||
          !["draft", "active"].includes(current.data.lifecycle) ||
          decisionDigest(current.data.lifecycle === "active" ? current.data.approved : current.data.saved) !== decisionDigest(v.context.basis.prod)) return false;
        return records.every(({ version, record }) => {
          const stored = db.read("short_decisions", record.decisionId);
          return stored?.id === record.decisionId && stored.version === version && record.status === "confirmed" &&
            stored.data !== null && decisionDigest(stored.data) === decisionDigest(record);
        });
      }));
      return unchanged && this.#verified === v && this.#input === v.input && this.#session && !v.input.controller.signal.aborted ? request : null;
    } catch { return null; }
    finally { this.#authorizing = false; }
  }
  /** 整份文档阅读/清单许可；全pending亦可读取，不授予active或PM启动，后者另核验明确目标和动作。 */
  authorizeDocument(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }): { authorization: InteractionAuthorization; manifest: ApprovalManifest } | null {
    const authorization = this.#authorizeManifest(capability, binding);
    const manifest = this.#verified?.manifest;
    return authorization && manifest ? { authorization, manifest: structuredClone(manifest) } : null;
  }
  /** 每次按精确目标/约束集合核验；不能兑换旧完整候选的实施能力。 */
  authorizeScope(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }, scope: ApprovalScope): InteractionAuthorization | null {
    if (!scope || !this.authorizeDocument(capability, binding)) return null;
    return this.#authorizeManifest(capability, binding, scope);
  }
  #authorizeManifest(capability: InteractionCapability, binding: { basis: InteractionBasis; candidate: CandidateBinding }, scope?: ApprovalScope): InteractionAuthorization | null {
    if (this.#authorizing) return null;
    this.#authorizing = true;
    try {
      const v = this.#requireVerified(capability), doc = v.context.document;
      if (!doc || !v.manifest || !v.savedRecords || decisionDigest(binding.basis) !== decisionDigest(v.context.basis) ||
        decisionDigest(binding.candidate) !== decisionDigest(doc.candidate)) return null;
      const manifest = checkApprovalManifest(v.manifest, { requirementId: v.context.basis.requirementId, candidate: doc.candidate, partition: doc.partition });
      const action = scope ? approvedManifestScope(manifest, scope) : undefined;
      if (scope && !action) return null;
      const request: InteractionAuthorization = frozen({ repoId: this.#options.repoId, basis: structuredClone(v.context.basis), candidate: structuredClone(doc.candidate),
        action: action?.action ?? "authorize-document", receiptId: v.receiptId, scope: "manifest-bound-scope",
        manifest: approvalManifestReference(manifest), ...(action ? { goalIds: [...action.goalIds], constraintIds: [...action.constraintIds] } : {}) });
      if (!synchronousPermission(this.#options.authorizeAction?.(request)) || this.#requireVerified(capability) !== v) return null;
      // 任一审核依据变化均保守失效；独立范围的后续续行需要可信局部影响复核，本组件不提供恢复通路。
      const records = v.savedRecords;
      for (const { record } of records) if (record.status === "superseded" || decisionDigest(this.readDecision(v.context.basis.requirementId, record.decisionId)) !== decisionDigest(record)) return null;
      const current = this.#state.read(v.context.basis.requirementId);
      this.#assertInput(v.input); this.#assertModel(v.model);
      // 所有宿主回调结束后，同步只读快照核对状态与全部审核依据；待确认描述也不能被静默换绑。
      const unchanged = withDatabase(this.#path(), (db) => db.transaction(() => {
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
    } catch { return null; }
    finally { this.#authorizing = false; }
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
    for (const q of v.context.questions) if (decisionDigest(this.readQuestion(q.requestId, v.context.basis)) !== decisionDigest(q)) throw new UserInteractionError("question_changed");
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
    } catch { return false; }
  }
  #admit(request: DecisionAdmissionRequest): DecisionAdmission | null {
    try {
      const v = this.#saving;
      if (!v || this.#requireVerified(v.capability) !== v || request.repoId !== this.#options.repoId ||
        request.requestHash !== v.admission.requestHash || decisionDigest(request.batch) !== decisionDigest(v.batch)) return null;
      return v.admission;
    } catch { return null; }
  }
}
