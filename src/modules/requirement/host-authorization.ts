import { lstatSync } from "node:fs";
import { COMMON_ADVICE, withDetail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { DatabaseSync } from "node:sqlite";
import { repositoryDatabase, UUID_V7_PATTERN, withDatabase } from "../../core/storage/database.ts";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, DATABASE_SCHEMA_VERSIONS } from "../../core/storage/database-paths.ts";
import { checkRequirement } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { checkInteraction, PendingQuestion } from "./user-interaction-format.ts";
import { checkDecisionRecord, decisionDigest } from "./short-decision-format.ts";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { approvalManifestReference } from "./approval-manifest.ts";
import type { ApprovalManifest } from "./approval-manifest.ts";
import { loadInteractionContinuity } from "./interaction-continuity.ts";
import type { InteractionBasis, DocumentAnalysis } from "./user-interaction-format.ts";

export interface MainHostPrincipal {
  readonly kind: "main";
  readonly windowId: string;
  readonly sessionId: string;
  readonly repoIds: readonly string[];
}
export interface ListedRequirement { readonly repoId: string; readonly requirementId: string; readonly lifecycle: "draft" | "active" }
const WAIT_USER = "等用户在主窗口说出新的一句话后再操作";
const REREAD = "重新读取需求后按最新版本再试";
const STOP = "停止操作，不要重试；把这段原因告诉用户";
const HOST_ADVICE: Record<string, FailureAdvice> = {
  invalid_shape: COMMON_ADVICE.invalid_shape,
  question_format: { why: "问题没有按要求写全", next: "按原因补全后重新登记问题" },
  window_answer_not_decision: { why: "用户是在提问窗口里选的，这只算回答，不能当作批准或裁决", next: "请用户在主窗口直接说要批准什么或怎么裁决" },
  invalid_principal: { why: "主窗口身份不合规", next: STOP },
  host_unavailable: { why: "主窗口与守护进程的连接不可用，可能未连接、心跳失败或会话已切换", next: "稍等几秒重试；仍不可用就请用户重开窗口" },
  untrusted_host: { why: "当前会话不是这个窗口登记的会话", next: "在当前主窗口会话里重新发起" },
  foreign_repo: { why: "repoId 不是当前窗口工作区里的仓库", next: "改用当前工作区列出的仓库编号" },
  invalid_requirement: { why: "需求编号格式不对", next: "改用此前工具结果给出的需求编号" },
  stale_host: { why: "窗口或会话已切换，本次操作作废", next: "在当前窗口里重新发起" },
  requirement_list_limit: { why: "草稿和进行中的需求太多，超出一次能列出的上限（32 个）", next: "请用户先关闭或取消不再需要的需求" },
  requirement_list_invalid: { why: "需求列表里有记录不合规", next: STOP },
  adjudication_declined: { why: "用户在确认窗口里没有确认这次裁决", next: "不要重试；告诉用户这句话没有登记成裁决" },
  decision_declined: { why: "用户在确认窗口里没有确认这次批准", next: "不要重试；按用户的意思继续澄清或修改草稿" },
  listener_limit: { why: "监听数量超出上限", next: STOP },
  database_missing: { why: "找不到本机需求数据库", next: "请用户确认已初始化项目并在主窗口重试" },
  database_identity: { why: "本机需求数据库文件不安全（经过链接或有多个硬链接）", next: "请用户检查本机数据目录" },
  database_changed: { why: "读取期间本机需求数据库被替换", next: "重试一次；反复出现就请用户检查本机数据目录" },
  unknown_requirement: { why: "找不到这个需求", next: "核对需求编号" },
  lifecycle_denied: { why: "需求不在草稿或活动状态，或需要先恢复核对", next: REREAD },
  state_changed: { why: "处理期间需求被改动", next: REREAD },
  interaction_context_limit: { why: "待处理的问题或决定太多，超出上限", next: "先处理已有的问题和决定，再继续" },
  decision_identity: { why: "决定记录与编号不一致", next: STOP },
  question_identity: { why: "问题记录与编号不一致", next: STOP },
  current_input_required: { why: "这个操作要基于用户当前说的话，但现在没有可用的用户原话（还没有，或已被用过、被撤销）", next: WAIT_USER },
  result_record_missing: { why: "结果依据的记录已不存在", next: REREAD },
  result_decision_superseded: { why: "结果依据的用户决定已被新的决定取代", next: "重新读取需求，按用户最新的决定处理" },
  stale_result: { why: "返回结果前需求已被改动，这次结果作废", next: REREAD },
  result_records_changed: { why: "返回结果前依据的记录已被改动", next: REREAD },
  result_scope_changed: { why: "返回结果前批准范围已变化", next: REREAD },
  manifest_unregistered: { why: "批准清单没有登记", next: "先按用户原话确认批准范围" },
  unproven_result: { why: "结果不是本工具刚生成的", next: STOP },
  stale_candidate: { why: "待确认的版本已不是最新", next: REREAD },
  adjudication_mismatch: { why: "决定针对的不是这个需求", next: "核对需求编号与事项" },
  candidate_required: { why: "没有待确认的需求版本", next: "先保存需求草稿" },
  input_changed: { why: "处理期间用户又说了新的话", next: "按用户最新的原话重新处理" },
  internal_model_unavailable: { why: "解释器或草稿核验器要用的模型不可用", next: "请用户在 /one:setting 的「模型」里检查这个角色的模型，或在主窗口选定模型、在本机配置该模型的凭据；不要自行改用别的模型重试" },
  model_unavailable: { why: "当前模型不可用或没有配置凭据，无法核验草稿", next: "请用户检查模型配置或改选模型" },
  draft_input_limit: { why: "草稿与用户原话合计超出 64 KiB", next: "精简草稿后重试" },
  draft_cancelled: { why: "草稿核验被取消", next: "需要时重新保存" },
  draft_not_requested: { why: "核验模型的回答格式不对，无法判断用户是否要求这份草稿", next: "重试一次；仍然失败就请用户换一个模型" },
  draft_check_failed: { why: "调用核验模型失败，没有得到核验结果（不是核验不通过）", next: "稍后重试；反复失败就请用户检查模型或网络" },
  draft_interpretation_denied: { why: "核验器认为草稿与用户原话不符", next: "按核验器说明改正草稿中与用户原话不符的部分后重试" },
  resave_state_mismatch: { why: "重新保存的状态已变化", next: REREAD },
  item_changed: { why: "事项在用户做决定后已变化", next: "重新读取待裁决事项，请用户按当前情况重新决定" },
  item_not_pending: { why: "这个事项已经不在待处理之列", next: "请用户重新打开面板查看当前事项" },
  prototype_changed: { why: "原型在批准过程中变了", next: "请重新批准" },
  prd_sections_required: { why: "需求正文不符合需求文档规范", next: "按需求文档规范改正正文后重新保存" },
  requirement_doc_invalid: { why: "读取需求文档规范失败", next: "请用户检查需求文档规范文件" },
  resave_request_mismatch: { why: "确认的保存操作与待确认的不是同一次", next: "用最近一次保存结果里的 savedOperationId 确认" },
  manifest_mismatch: { why: "批准清单与待确认版本不一致", next: REREAD },
  question_scope_mismatch: { why: "问题引用了待确认版本里不存在的章节", next: "只引用待确认版本里的章节编号" },
  question_limit: { why: "待回答的问题已达上限", next: "先请用户回答已有的问题" },
  question_display_unavailable: { why: "向用户提问要在交互界面里显示，当前会话没有界面", next: "请用户在有界面的主窗口里继续" },
  cursor_expired: { why: "翻页游标不是上一页结果给出的 nextCursor，或已用过", next: "用 read 或 diff 从第一页重新读取" },
  invalid_approval_unit_id: { why: "需求正文的标题编号不合规：编号须以字母开头、只含字母数字和 . _ -、不超过 96 个字符、互不重复，且不能用 metadata、preamble、whole-body", next: "改正正文里的标题编号后重新保存" },
  response_limit: { why: "maxBytes 太小，放不下任何内容", next: "调大 maxBytes 后重试" },
  interaction_busy: { why: "上一个需求操作还没结束", next: "等上一个操作结束后再试" },
  stale_operation_result: { why: "这个操作编号之前已失败过，不能再用", next: "换一个新生成的操作编号重试" },
  operation_conflict: { why: "同一操作编号已用于内容不同的请求", next: "换一个新生成的操作编号重试" },
  delivery_expired: { why: "找不到这次调用的结果送达记录", next: "重新发起一次" },
  pm_intake_unavailable: { why: "当前窗口没有接手复核能力", next: STOP },
  interaction_denied: { why: "需求操作被拒绝，底层没有给出可说明的原因", next: "重试一次；仍然失败就把这段原因告诉用户" },
};
export class HostAuthorizationError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string, hint?: string) {
    super(`requirement_host_denied:${code}${hint ? `（${hint}）` : ""}`); this.name = "HostAuthorizationError"; this.code = code;
    const base = HOST_ADVICE[code];
    this.advice = base ? withDetail(base, hint) : { why: hint ?? `需求操作被拒绝（${code}）`, next: "按原因改正后重试；仍然失败就把这段原因告诉用户" };
  }
}
/** 宿主身份与资源门槛；不签发目标批准，不读取聊天历史，不持久化用户输入。 */
export class HostAuthorizationManager {
  readonly #dataRoot: string;
  #principal: MainHostPrincipal | undefined;
  #generation = 0;
  readonly #listeners = new Set<() => void>();
  constructor(options: { dataRoot: string }) { this.#dataRoot = options.dataRoot; }
  get generation(): number { return this.#generation; }
  startWindow(principal: MainHostPrincipal): void {
    this.shutdown();
    if (principal.kind !== "main" || !principal.windowId || !principal.sessionId || !principal.repoIds.length ||
      principal.repoIds.some((repoId) => !/^[0-9a-f]{64}$/.test(repoId))) throw new HostAuthorizationError("invalid_principal");
    this.#principal = Object.freeze({ ...principal, repoIds: Object.freeze([...new Set(principal.repoIds)]) });
  }
  assertCurrentSession(sessionId: string): MainHostPrincipal {
    if (!this.#principal || this.#principal.sessionId !== sessionId) throw new HostAuthorizationError("untrusted_host");
    return this.#principal;
  }
  assertRepository(repoId: string, sessionId: string): void {
    if (!this.assertCurrentSession(sessionId).repoIds.includes(repoId)) throw new HostAuthorizationError("foreign_repo");
  }
  /** 列出本窗口各仓库里状态正常的草稿与进行中需求，只读生命周期元数据。 */
  listRequirements(sessionId: string): ListedRequirement[] {
    const principal = this.assertCurrentSession(sessionId), generation = this.#generation;
    const items: ListedRequirement[] = [];
    for (const repoId of principal.repoIds) {
      try { lstatSync(repositoryDatabase(this.#dataRoot, repoId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const rows = this.#read(repoId, sessionId, (db) => db.prepare("SELECT record_key,id,version,CASE WHEN length(data)<=65536 THEN data ELSE NULL END AS data FROM records WHERE namespace='requirements' AND record_key GLOB ? AND json_extract(data,'$.lifecycle') IN ('draft','active') AND json_extract(data,'$.recovery')='ready' ORDER BY id LIMIT 33")
        .all("????????-????-7???-[89ab]???-????????????"));
      for (const row of rows) {
        if (typeof row.record_key !== "string" || !UUID_V7_PATTERN.test(row.record_key) || row.id !== row.record_key ||
          !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.data !== "string") throw new HostAuthorizationError("requirement_list_invalid");
        const record = checkRequirement(JSON.parse(row.data), row.record_key, repoId);
        if (record.lifecycle !== "draft" && record.lifecycle !== "active" || record.recovery !== "ready") continue;
        if (items.length >= 32) throw new HostAuthorizationError("requirement_list_limit");
        items.push(Object.freeze({ repoId, requirementId: record.requirementId, lifecycle: record.lifecycle }));
      }
    }
    if (this.#generation !== generation || this.assertCurrentSession(sessionId) !== principal) throw new HostAuthorizationError("stale_host");
    return items;
  }
  onRevoke(listener: () => void): () => void {
    if (this.#listeners.size >= 8) throw new HostAuthorizationError("listener_limit");
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  revoke(): void { this.#generation++; for (const listener of this.#listeners) listener(); }
  shutdown(): void { this.revoke(); this.#principal = undefined; }
  /** 只读打开既有data.db，缺失或用途未知时拒绝，不扫描PRD或初始化空库。 */
  #read<T>(repoId: string, sessionId: string, run: (db: DatabaseSync) => T): T {
    this.assertRepository(repoId, sessionId);
    const path = repositoryDatabase(this.#dataRoot, repoId);
    assertDatabasePathReady(path); assertRegularDatabaseFiles(path);
    let info;
    try { info = lstatSync(path); } catch { throw new HostAuthorizationError("database_missing"); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new HostAuthorizationError("database_identity");
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data ||
        Number(db.prepare("PRAGMA user_version").get()?.user_version) !== DATABASE_SCHEMA_VERSIONS.data) throw new HostAuthorizationError("database_identity");
      const result = run(db);
      this.assertRepository(repoId, sessionId);
      const after = lstatSync(path);
      if (after.dev !== info.dev || after.ino !== info.ino) throw new HostAuthorizationError("database_changed");
      return result;
    } finally { db.close(); }
  }
  snapshot(repoId: string, requirementId: string, sessionId: string): { id: string; version: number; data: RequirementRecord } {
    this.assertRepository(repoId, sessionId);
    return this.#read(repoId, sessionId, (db) => {
      const row = db.prepare("SELECT id, version, data FROM records WHERE namespace='requirements' AND record_key=?").get(requirementId);
      if (!row || row.id !== requirementId || typeof row.data !== "string") throw new HostAuthorizationError("unknown_requirement");
      return { id: requirementId, version: Number(row.version), data: checkRequirement(JSON.parse(row.data), requirementId, repoId) };
    });
  }
  /** 读取全部相关问题（包括旧基线）而非模型挑选的一题。 */
  interactionRecords(repoId: string, requirementId: string, sessionId: string, context?: { basis: InteractionBasis; document: DocumentAnalysis }) {
    const before = this.snapshot(repoId, requirementId, sessionId);
    if (!["draft", "active"].includes(before.data.lifecycle) || before.data.recovery !== "ready") throw new HostAuthorizationError("lifecycle_denied");
    if (context) {
      if (context.basis.requirementId !== requirementId || context.basis.version !== before.version || context.basis.epoch !== before.data.epoch) throw new HostAuthorizationError("state_changed");
      const result = loadInteractionContinuity(this.#dataRoot, repoId, context.basis, context.document);
      const after = this.snapshot(repoId, requirementId, sessionId);
      if (before.version !== after.version || decisionDigest(before.data) !== decisionDigest(after.data)) throw new HostAuthorizationError("state_changed");
      return result;
    }
    return this.#read(repoId, sessionId, (db) => {
      // 问题的requirementId位于basis；不以候选版本过滤来隐藏旧问题。
      const questions = db.prepare("SELECT id, data FROM records WHERE namespace='interaction_questions_v1' AND json_extract(data,'$.basis.requirementId')=? ORDER BY id").all(requirementId);
      const registered = db.prepare("SELECT data FROM records WHERE namespace='approval_manifests_v1' AND json_extract(data,'$.manifest.requirementId')=? AND json_extract(data,'$.admission.version')=? AND json_extract(data,'$.admission.epoch')=? ORDER BY id LIMIT 21").all(requirementId, before.version, before.data.epoch);
      if (registered.length > 20) throw new HostAuthorizationError("interaction_context_limit");
      const ids = new Set<string>();
      for (const row of registered) {
        const stored = JSON.parse(String(row.data)) as { manifest: ApprovalManifest; admission: { receiptId: string } };
        // 清单只提供旧决定的来源关系，不产生新能力；完整原ID/receipt交给Core逐次核验。
        let manifest: ApprovalManifest;
        try {
          manifest = withDatabase(repositoryDatabase(this.#dataRoot, repoId), (current) =>
            registeredApprovalManifestIn(current, repoId, approvalManifestReference(stored.manifest), before, stored.admission.receiptId));
        } catch (error) {
          // 登记后用户又有新输入的清单已经过期，只是不再提供旧决定；若让读取失败，这一版草稿就再也存不了
          if ((error as { code?: unknown } | null)?.code === "manifest_input_changed") continue;
          throw error;
        }
        for (const id of [...manifest.units, ...manifest.actions, ...manifest.questions].flatMap((u) => u.decisionIds)) ids.add(id);
      }
      if (ids.size > 20) throw new HostAuthorizationError("interaction_context_limit");
      const priorDecisions = [...ids].map((id) => {
        const row = db.prepare("SELECT id,data FROM records WHERE namespace='short_decisions' AND record_key=?").get(id);
        if (!row || row.id !== id) throw new HostAuthorizationError("decision_identity");
        const record = checkDecisionRecord(JSON.parse(String(row.data)));
        if (record.repoId !== repoId || record.requirementId !== requirementId) throw new HostAuthorizationError("decision_identity");
        return record;
      });
      const after = this.snapshot(repoId, requirementId, sessionId);
      if (before.version !== after.version || decisionDigest(before.data) !== decisionDigest(after.data)) throw new HostAuthorizationError("state_changed");
      return { questions: questions.map((row) => {
        const q = checkInteraction(PendingQuestion, JSON.parse(String(row.data)));
        if (q.requestId !== row.id || q.repoId !== repoId) throw new HostAuthorizationError("question_identity");
        return q;
      }), priorDecisions };

    });
  }
}
