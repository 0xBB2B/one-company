import { randomBytes } from "node:crypto";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { checked, checkRequirement, hash, id, object, PmLease, PmRecord, ProdReference, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { readCheckRoundIn } from "./check-round.ts";
import { RequirementService } from "./requirement-service.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { authorizeToolAction } from "./core-permissions.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { assertApprovalScopeReturnIn, registeredApprovalManifestIn, summarizeApprovalManifest } from "./approval-manifest-store.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import type { ServiceAuthorizationRequest } from "./requirement-manage-contracts.ts";
import { inspectProdStructure, pageProdResponse, selectProdSection, PROD_MAX_PAGE_BYTES, PROD_PAGE_BYTES,
  PROD_SECTION_ID_PATTERN, PROD_RESPONSE_MAX_BYTES } from "./prod-view.ts";

const Role = Type.Union([Type.Literal("pm"), Type.Literal("reviewer"), Type.Literal("qa")]);
const Binding = object({ role: Role, callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1, maxLength: 4096, pattern: "^refs/heads/" }), lease: PmLease,
  /** 可信宿主已核对的PM理解基线；模型不能自由选择旧版本。 */
  diffBaseline: Type.Optional(object({ revision: positive, reference: ProdReference })),
  /** 已开始的检查轮：defer 或等待 PM 决策期间只读该轮登记的原批准基线，由服务而非角色选择版本。 */
  checkRoundId: Type.Optional(id) });
export type RequirementReadBinding = Static<typeof Binding>;
const paging = { cursor: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: PROD_MAX_PAGE_BYTES })) };
export const REQUIREMENT_READ_PARAMETERS = Type.Union([
  object({ action: Type.Literal("read"), ...paging,
    sectionId: Type.Optional(Type.String({ pattern: PROD_SECTION_ID_PATTERN })) }),
  object({ action: Type.Literal("diff"), ...paging }),
  object({ action: Type.Literal("metadata") }),
]);
export type RequirementReadParameters = Static<typeof REQUIREMENT_READ_PARAMETERS>;
export interface RequirementReadAuthorization {
  readonly binding: Readonly<RequirementReadBinding>;
  readonly action: "read" | "diff" | "metadata";
}
export interface RequirementReadToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  binding: RequirementReadBinding;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造true。 */
  authorize: (request: Readonly<RequirementReadAuthorization>) => boolean;
}
export class RequirementReadError extends Error {
  readonly code: "requirement_read_denied";
  constructor() { super("requirement_read_denied"); this.name = "RequirementReadError"; this.code = "requirement_read_denied"; }
}
interface Cursor {
  action: "read" | "diff";
  sectionId?: string;
  maxBytes: number;
  offset: number;
  sectionOffset: number;
  version: number;
  revision: number;
  commit: string;
  hash: string;
  epoch: number;
  expiresAt: number;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/**
 * 可信宿主使用的只读角色工具工厂，不注册daemon工具、不授予主代理草稿能力。
 * 每页复读准确批准版本；仅保留有界随机游标元数据，不缓存正文、diff或详细摘要。
 * 异步工作区核验之后再同步核验状态和宿主许可；外部进程在最后核验之后的竞争不是原子隔离。
 */
export async function createRequirementReadTool(options: RequirementReadToolOptions) {
  try { return await openReadTool(options); }
  catch { throw new RequirementReadError(); }
}

async function openReadTool(options: RequirementReadToolOptions) {
  const binding = freeze(checked(Binding, structuredClone(options.binding)));
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot,
    repoId: binding.repoId };
  const authorize = options.authorize;
  let disposed = false;
  const cursors = new Map<string, Cursor>();
  const returns = new WeakMap<object, { action: RequirementReadAuthorization["action"]; record: { version: number; data: RequirementRecord };
    scope?: ReturnType<typeof source>["approvalScope"] }>();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const deny = (): never => { throw new RequirementReadError(); };
  function bounded<T>(response: T): T {
    if (Buffer.byteLength(JSON.stringify(response)) > PROD_RESPONSE_MAX_BYTES) deny();
    return freeze(response);
  }
  if (binding.requirementId !== binding.lease.requirementId || binding.workspaceId !== binding.lease.workspaceId ||
    (binding.role === "pm" && binding.runId !== binding.lease.runId)) deny();
  function host(action: RequirementReadAuthorization["action"]) {
    if (disposed || !authorizeToolAction(binding.role, "requirement_manage", action)) deny();
    let result: unknown;
    try { result = authorize(freeze({ binding, action })); } catch { return deny(); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny();
  }
  host("metadata");
  const state = await RequirementStateStore.open({ ...config, authorize: (request) => {
    // 私有状态句柄只有固定只读动作；真实宿主授权由host核验，PM有效性由checkPm核验。
    if (disposed || request.repoId !== binding.repoId || !["open", "read", "events", "check-pm"].includes(request.action)) return false;
    const requirementId = request.input.requirementId;
    return requirementId === undefined || requirementId === binding.requirementId;
  } });
  function current(db?: LocalDatabase) {
    const row = db?.read("requirements", binding.requirementId);
    const record = db ? row && { ...row, data: checkRequirement(row.data, binding.requirementId, binding.repoId) } : state.read(binding.requirementId);
    if (!record) return deny();
    const workspace = record.data.workspace;
    if (!workspace || workspace.repoId !== binding.repoId || workspace.requirementId !== binding.requirementId ||
      workspace.workspaceId !== binding.workspaceId || workspace.branch !== binding.branch) deny();
    return record;
  }
  function activeSync(expected?: { version: number; data: RequirementRecord }, db?: LocalDatabase) {
    const record = current(db);
    if (record.data.lifecycle !== "active" || record.data.recovery !== "ready" || !record.data.approved ||
      record.data.epoch !== binding.lease.epoch) deny();
    const ownerRow = db?.read("pm_ownership", binding.requirementId);
    const owner = db ? ownerRow && checked(PmRecord, ownerRow.data) : state.pmOwner(binding.requirementId);
    const lease = owner?.lease;
    if (!lease || owner!.requirementId !== binding.requirementId || lease.requirementId !== binding.requirementId || owner!.fence !== binding.lease.fence || lease.fence !== binding.lease.fence ||
      lease.runId !== binding.lease.runId || lease.workspaceId !== binding.workspaceId || lease.epoch !== binding.lease.epoch ||
      lease.contextGeneration !== binding.lease.contextGeneration || lease.expiresAt <= Date.now()) deny();
    if (expected && (record.version !== expected.version || record.data.revision !== expected.data.revision ||
      record.data.approved!.commit !== expected.data.approved?.commit || record.data.approved!.hash !== expected.data.approved?.hash)) deny();
    return record;
  }
  function target(record: { version: number; data: RequirementRecord }, db?: LocalDatabase): { revision: number; reference: ProdReference } {
    if (!binding.checkRoundId) return { revision: record.data.revision, reference: record.data.approved! };
    const round = db ? readCheckRoundIn(db, binding.checkRoundId) : withDatabase(repositoryDatabase(config.dataRoot, binding.repoId), (inner) => readCheckRoundIn(inner, binding.checkRoundId!));
    if (!round || round.data.requirementId !== binding.requirementId || round.data.repoId !== binding.repoId || round.data.epoch !== binding.lease.epoch ||
      round.data.fence !== binding.lease.fence || round.data.status === "released" || round.data.invalidation !== null || round.data.decision?.kind === "interrupt" ||
      round.data.baseline.revision > record.data.revision) return deny();
    return { revision: round.data.baseline.revision, reference: round.data.baseline.approved };
  }
  async function validate(action: RequirementReadAuthorization["action"], expected?: { version: number; data: RequirementRecord }) {
    host(action);
    activeSync(expected);
    // 校验实际Git worktree、分支、PM run claim和SQLite lease/fence，不以宿主回调代替这些检查。
    await state.checkPm(binding.lease);
    host(action);
    return activeSync(expected);
  }
  function purge() { for (const [key, cursor] of cursors) if (cursor.expiresAt <= Date.now()) cursors.delete(key); }
  function dispose() {
    disposed = true; cursors.clear(); unsubscribe?.(); unsubscribe = undefined;
    if (timer) clearInterval(timer); timer = undefined;
  }
  try {
    host("metadata");
    current();
    unsubscribe = state.onAccessInvalidated(binding.requirementId, () => cursors.clear());
    timer = setInterval(purge, 1_000); timer.unref();
  } catch { dispose(); return deny(); }

  async function execute(input: unknown) {
    try {
      const params = checkServiceInput(REQUIREMENT_READ_PARAMETERS, input);
      host(params.action);
      purge();
      const status = current();
      if (status.data.lifecycle === "closing" || status.data.lifecycle === "closed") {
        cursors.clear();
        if (params.action !== "metadata") deny();
        // 关闭后只允许固定身份/状态；无标题、路径、提交、hash、决定或目标摘要。
        await verifyRequirementWorkspace(config.dataRoot, status.data.workspace!);
        host("metadata");
        const final = current();
        if (final.data.lifecycle !== "closing" && final.data.lifecycle !== "closed") deny();
        const response = bounded({ kind: "metadata" as const, requirementId: binding.requirementId, lifecycle: final.data.lifecycle });
        returns.set(response, { action: "metadata", record: final });
        assertCurrent(response);
        return response;
      }
      const before = await validate(params.action);
      if (params.action === "metadata") {
        await validate("metadata", before);
        host("metadata");
        const final = activeSync(before);
        const origin = source(final);
        const response = bounded({ kind: "metadata" as const, requirementId: binding.requirementId, lifecycle: "active" as const, source: origin });
        returns.set(response, { action: "metadata", record: final, scope: origin.approvalScope });
        assertCurrent(response);
        return response;
      }
      const sectionId = params.action === "read" ? params.sectionId : undefined;
      const maxBytes = params.maxBytes ?? PROD_PAGE_BYTES;
      const goal = target(before);
      const cursor = params.cursor ? cursors.get(params.cursor) : undefined;
      if (params.cursor && (!cursor || cursor.action !== params.action || cursor.sectionId !== sectionId || cursor.maxBytes !== maxBytes ||
        cursor.version !== before.version || cursor.revision !== goal.revision || cursor.epoch !== before.data.epoch ||
        cursor.commit !== goal.reference.commit || cursor.hash !== goal.reference.hash)) deny();
      if (params.cursor) cursors.delete(params.cursor);
      const baseline = binding.diffBaseline;
      if (params.action === "diff") {
        if (!baseline || binding.checkRoundId || baseline.revision > before.data.revision) deny();
        const from = state.events(binding.requirementId).find((event) => event.data.kind === "prod.approved" && event.data.revision === baseline!.revision);
        if (from?.data.to?.commit !== baseline!.reference.commit || from.data.to.hash !== baseline!.reference.hash) deny();
      }
      const service = await RequirementService.open({ ...config, authorize: (request: Readonly<ServiceAuthorizationRequest>) => {
        if (request.repoId !== binding.repoId || !["metadata", params.action === "read" ? "readApproved" : "diff"].includes(request.action) ||
          (request.requirementId !== undefined && request.requirementId !== binding.requirementId) ||
          (request.epoch !== undefined && request.epoch !== before.data.epoch) ||
          (request.version !== undefined && request.version !== before.version) ||
          (request.prodHash !== undefined && request.prodHash !== `sha256:${goal.reference.hash}`)) return false;
        host(params.action);
        activeSync(before);
        return true;
      } });
      let text: string;
      let title: string | undefined;
      let structure: ReturnType<typeof inspectProdStructure> | undefined;
      let difference: { fromRevision: number; toRevision: number; fromCommit: string; toCommit: string; fromHash: string; toHash: string } | undefined;
      if (params.action === "read") {
        const result = await service.read({ requirementId: binding.requirementId, source: "approved", ...(binding.checkRoundId ? { revision: goal.revision } : {}) });
        if (result.commit !== goal.reference.commit || result.prodHash !== `sha256:${goal.reference.hash}` ||
          result.version !== before.version || result.epoch !== before.data.epoch) deny();
        title = result.title;
        structure = inspectProdStructure(result.body);
        text = selectProdSection(result.body, structure, sectionId);
      } else {
        const result = await service.diff({ requirementId: binding.requirementId, fromRevision: baseline!.revision,
          toRevision: before.data.revision });
        if (result.fromCommit !== baseline!.reference.commit || result.fromHash !== `sha256:${baseline!.reference.hash}` ||
          result.toCommit !== before.data.approved!.commit || result.toHash !== `sha256:${before.data.approved!.hash}` ||
          result.version !== before.version || result.epoch !== before.data.epoch) deny();
        text = result.diff;
        difference = { fromRevision: result.fromRevision, toRevision: result.toRevision, fromCommit: result.fromCommit,
          toCommit: result.toCommit, fromHash: result.fromHash, toHash: result.toHash };
      }
      const nextCursor = randomBytes(32).toString("hex");
      const origin = source(before);
      const result = pageProdResponse({ text, startByte: cursor?.offset ?? 0, maxBytes, structure,
        startSection: cursor?.sectionOffset ?? 0, response: (page, structurePage, hasMore) => {
          const full = params.action === "read" && sectionId === undefined && page.complete && structurePage?.complete === true;
          return { kind: params.action, source: origin,
            coverage: { representation: params.action === "read" ? "parsed_prod_body" : "approved_diff",
              sectionId: sectionId ?? null, startByte: page.startByte, endByte: page.endByte, totalBytes: page.totalBytes,
              selectedTextComplete: page.complete, entireProdCovered: full, nextCursor: hasMore ? nextCursor : null,
              blocking: full ? [] : ["incomplete_prod_read", "global_constraints_and_unresolved_may_be_outside_page"],
              businessCompleteness: "not_mechanically_proven", verification: "not_evaluated", performance: "unknown" },
            ...(title !== undefined ? { title } : {}), ...(difference ? { difference } : {}), text: page.text,
            ...(structurePage ? { structure: structurePage } : {}) };
        } });
      const response = bounded(result.response);
      if (result.hasMore) {
        while (cursors.size >= 32) cursors.delete(cursors.keys().next().value!);
        cursors.set(nextCursor, { action: params.action, sectionId, maxBytes, offset: result.page.endByte, sectionOffset: result.endSection,
          version: before.version, revision: goal.revision, commit: goal.reference.commit,
          hash: goal.reference.hash, epoch: before.data.epoch, expiresAt: Date.now() + 30_000 });
      }
      await validate(params.action, before);
      returns.set(response, { action: params.action, record: before, scope: origin.approvalScope });
      assertCurrent(response);
      return response;
    } catch {
      cursors.clear();
      // 任意下层错误可能含Git/文件路径或受限文本，只返回固定安全错误码。
      return deny();
    }
  }
  /** 外层须在自身最后一次await/宿主回调之后调用；只认本工具原对象，不接受JSON副本作许可。 */
  function assertCurrent(result: unknown): void {
    try {
      const returned = result && typeof result === "object" ? returns.get(result) : undefined;
      if (!returned) return deny();
      host(returned.action);
      withDatabase(repositoryDatabase(config.dataRoot, binding.repoId), (db) => db.transaction(() => {
        if (returned.scope) {
          activeSync(returned.record, db);
          target(returned.record, db);
          assertApprovalScopeReturnIn(db, binding.repoId, { ...returned.record, id: binding.requirementId }, returned.scope);
        } else {
          const actual = current(db);
          if (!["closing", "closed"].includes(actual.data.lifecycle) || actual.version !== returned.record.version ||
            actual.data.lifecycle !== returned.record.data.lifecycle || actual.data.epoch !== returned.record.data.epoch) deny();
        }
      }));
    } catch { cursors.clear(); return deny(); }
  }
  function source(record: { version: number; data: RequirementRecord }) {
    const approvalScope = record.data.approvalManifest
      ? withDatabase(repositoryDatabase(config.dataRoot, binding.repoId), (db) => db.transaction(() => ({ status: "available" as const,
        summary: summarizeApprovalManifest(registeredApprovalManifestIn(db, binding.repoId, record.data.approvalManifest!.reference,
          { ...record, id: binding.requirementId })) })))
      : { status: "unavailable" as const };
    const goal = target(record);
    return { approvalScope, requirementId: binding.requirementId, repoId: binding.repoId, workspaceId: binding.workspaceId, branch: binding.branch,
      role: binding.role, purpose: binding.checkRoundId ? "check_round_original_baseline" : binding.role === "qa" ? "black_box_acceptance" : "approved_requirement_read",
      ...(binding.checkRoundId ? { checkRoundId: binding.checkRoundId } : {}),
      commit: goal.reference.commit, prodHash: `sha256:${goal.reference.hash}`, revision: goal.revision,
      version: record.version, lifecycleEpoch: record.data.epoch, asOf: Date.now() };
  }
  return Object.freeze({ name: "requirement_manage", parameters: REQUIREMENT_READ_PARAMETERS, execute, assertCurrent, dispose });
}
