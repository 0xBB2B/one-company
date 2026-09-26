import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { repositoryDatabase, UUID_V7_PATTERN, withDatabase } from "./database.ts";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS } from "./database-paths.ts";
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
export interface RequirementSelection { readonly kind: "requirement-selection" }
interface SelectionClaim {
  repoId: string; requirementId: string; version: number; hash: string; databaseIdentity: string;
  sessionId: string; windowId: string; generation: number; expiresAt: number;
}
export class HostAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string, hint?: string) { super(`requirement_host_denied:${code}${hint ? `（${hint}）` : ""}`); this.name = "HostAuthorizationError"; this.code = code; }
}
/** 宿主身份与资源门槛；不签发目标批准，不读取聊天历史，不持久化用户输入。 */
export class HostAuthorizationManager {
  readonly #dataRoot: string;
  #principal: MainHostPrincipal | undefined;
  #binding: { repoId: string; requirementId: string } | undefined;
  #generation = 0;
  readonly #listeners = new Set<() => void>();
  readonly #selections = new WeakMap<object, SelectionClaim>();
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
  /** 仅供可信宿主绑定或create成功后固定身份；不得直接转发工具中的requirementId来调用。 */
  bindRequirement(repoId: string, requirementId: string, sessionId: string): void {
    this.assertRepository(repoId, sessionId);
    if (!UUID_V7_PATTERN.test(requirementId) || requirementId.length !== 36) throw new HostAuthorizationError("invalid_requirement");
    if (this.#binding && (this.#binding.repoId !== repoId || this.#binding.requirementId !== requirementId)) this.revoke();
    this.#binding = Object.freeze({ repoId, requirementId });
  }
  /** 只枚举有界生命周期元数据；选择对象只能由本实例签发，不能从模型JSON重建。 */
  prepareSelections(sessionId: string) {
    const principal = this.assertCurrentSession(sessionId), generation = this.#generation;
    const items: Array<{ selection: RequirementSelection; repoId: string; requirementId: string; lifecycle: "draft" | "active" }> = [];
    let unavailableRepositories = 0;
    for (const repoId of principal.repoIds) {
      const path = repositoryDatabase(this.#dataRoot, repoId);
      let identity: string;
      try { const stat = lstatSync(path); identity = `${stat.dev}:${stat.ino}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { unavailableRepositories++; continue; } throw error; }
      const rows = this.#read(repoId, sessionId, (db) => db.prepare("SELECT record_key,id,version,CASE WHEN length(data)<=65536 THEN data ELSE NULL END AS data FROM records WHERE namespace='requirements' AND record_key GLOB ? AND json_extract(data,'$.lifecycle') IN ('draft','active') AND json_extract(data,'$.recovery')='ready' ORDER BY id LIMIT 33")
        .all("????????-????-7???-[89ab]???-????????????"));
      if (rows.length > 32) throw new HostAuthorizationError("selection_limit");
      for (const row of rows) {
        if (typeof row.record_key !== "string" || !UUID_V7_PATTERN.test(row.record_key) || row.id !== row.record_key ||
          !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.data !== "string") throw new HostAuthorizationError("selection_metadata_invalid");
        const record = checkRequirement(JSON.parse(row.data), row.record_key, repoId);
        if (record.lifecycle !== "draft" && record.lifecycle !== "active" || record.recovery !== "ready") continue;
        if (items.length >= 32) throw new HostAuthorizationError("selection_limit");
        const selection: RequirementSelection = Object.freeze({ kind: "requirement-selection" });
        this.#selections.set(selection, { repoId, requirementId: record.requirementId, version: Number(row.version), hash: decisionDigest(record), databaseIdentity: identity,
          sessionId, windowId: principal.windowId, generation, expiresAt: Date.now() + 120_000 });
        items.push({ selection, repoId, requirementId: record.requirementId, lifecycle: record.lifecycle });
      }
    }
    if (this.#generation !== generation || this.assertCurrentSession(sessionId) !== principal) throw new HostAuthorizationError("stale_host");
    return { items, unavailableRepositories };
  }
  verifySelection(selection: RequirementSelection, sessionId: string) {
    const claim = this.#selections.get(selection), principal = this.assertCurrentSession(sessionId);
    if (!claim || claim.sessionId !== sessionId || claim.windowId !== principal.windowId || claim.generation !== this.#generation || claim.expiresAt <= Date.now()) throw new HostAuthorizationError("selection_expired");
    const result = this.#read(claim.repoId, sessionId, (db) => {
      const row = db.prepare("SELECT id,version,CASE WHEN length(data)<=65536 THEN data ELSE NULL END AS data FROM records WHERE namespace='requirements' AND record_key=?").get(claim.requirementId);
      if (!row || row.id !== claim.requirementId || row.version !== claim.version || typeof row.data !== "string") throw new HostAuthorizationError("selection_changed");
      const record = checkRequirement(JSON.parse(row.data), claim.requirementId, claim.repoId);
      if (decisionDigest(record) !== claim.hash || !["draft", "active"].includes(record.lifecycle) || record.recovery !== "ready") throw new HostAuthorizationError("selection_changed");
      return { id: claim.requirementId, version: claim.version, data: record };
    });
    const stat = lstatSync(repositoryDatabase(this.#dataRoot, claim.repoId));
    if (`${stat.dev}:${stat.ino}` !== claim.databaseIdentity || this.#generation !== claim.generation || this.assertCurrentSession(sessionId) !== principal) throw new HostAuthorizationError("selection_changed");
    return result;
  }
  bindSelection(selection: RequirementSelection, sessionId: string): void {
    const record = this.verifySelection(selection, sessionId);
    this.#selections.delete(selection);
    this.bindRequirement(record.data.repoId, record.id, sessionId);
    this.assertRequirement(record.data.repoId, record.id, sessionId);
  }
  binding(sessionId: string) { this.assertCurrentSession(sessionId); return this.#binding; }
  assertRequirement(repoId: string, requirementId: string, sessionId: string): void {
    this.assertRepository(repoId, sessionId);
    if (this.#binding?.repoId !== repoId || this.#binding.requirementId !== requirementId) throw new HostAuthorizationError("requirement_not_bound");
  }
  onRevoke(listener: () => void): () => void {
    if (this.#listeners.size >= 8) throw new HostAuthorizationError("listener_limit");
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  revoke(): void { this.#generation++; for (const listener of this.#listeners) listener(); }
  shutdown(): void { this.revoke(); this.#principal = undefined; this.#binding = undefined; }
  /** 只读打开既有data.db，缺失或用途未知时拒绝，不扫描prod或初始化空库。 */
  #read<T>(repoId: string, sessionId: string, run: (db: DatabaseSync) => T): T {
    this.assertRepository(repoId, sessionId);
    const path = repositoryDatabase(this.#dataRoot, repoId);
    assertDatabasePathReady(path); assertRegularDatabaseFiles(path);
    let info;
    try { info = lstatSync(path); } catch { throw new HostAuthorizationError("database_missing"); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new HostAuthorizationError("database_identity");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data ||
        Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1) throw new HostAuthorizationError("database_identity");
      const result = run(db);
      this.assertRepository(repoId, sessionId);
      const after = lstatSync(path);
      if (after.dev !== info.dev || after.ino !== info.ino) throw new HostAuthorizationError("database_changed");
      return result;
    } finally { db.close(); }
  }
  snapshot(repoId: string, requirementId: string, sessionId: string): { id: string; version: number; data: RequirementRecord } {
    this.assertRequirement(repoId, requirementId, sessionId);
    return this.#read(repoId, sessionId, (db) => {
      const row = db.prepare("SELECT id, version, data FROM records WHERE namespace='requirements' AND record_key=?").get(requirementId);
      if (!row || row.id !== requirementId || typeof row.data !== "string") throw new HostAuthorizationError("unknown_requirement");
      return { id: requirementId, version: Number(row.version), data: checkRequirement(JSON.parse(row.data), requirementId, repoId) };
    });
  }
  /** 读取全部相关问题（包括旧基线）而非模型挑选的一题；超限拒绝，不漏掉其余问题。 */
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
      const questions = db.prepare("SELECT id, data FROM records WHERE namespace='interaction_questions_v1' AND json_extract(data,'$.basis.requirementId')=? ORDER BY id LIMIT 21").all(requirementId);
      if (questions.length > 20) throw new HostAuthorizationError("interaction_context_limit");
      const registered = db.prepare("SELECT data FROM records WHERE namespace='approval_manifests_v1' AND json_extract(data,'$.manifest.requirementId')=? AND json_extract(data,'$.admission.version')=? AND json_extract(data,'$.admission.epoch')=? ORDER BY id LIMIT 21").all(requirementId, before.version, before.data.epoch);
      if (registered.length > 20) throw new HostAuthorizationError("interaction_context_limit");
      const ids = new Set<string>();
      for (const row of registered) {
        const stored = JSON.parse(String(row.data)) as { manifest: ApprovalManifest; admission: { receiptId: string } };
        // 清单只提供旧决定的来源关系，不产生新能力；完整原ID/receipt交给Core逐次核验。
        const manifest = withDatabase(repositoryDatabase(this.#dataRoot, repoId), (current) =>
          registeredApprovalManifestIn(current, repoId, approvalManifestReference(stored.manifest), before, stored.admission.receiptId));
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
