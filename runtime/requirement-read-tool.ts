import { randomBytes } from "node:crypto";
import { adviceOf, COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
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
  PROD_SECTION_ID_PATTERN, PROD_RESPONSE_MAX_BYTES, ProdViewError } from "./prod-view.ts";

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
const STALE = "停止操作，不要重试；在回复里说明，由上级按新状态重新安排";
const READ_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  action_not_allowed: COMMON_ADVICE.action_not_allowed,
  session_inactive: COMMON_ADVICE.session_inactive,
  open_failed: COMMON_ADVICE.open_failed,
  invalid_shape: COMMON_ADVICE.invalid_shape,
  binding_invalid: { why: "读取身份与需求、工作区或 PM 租约的绑定不一致", next: STALE },
  requirement_missing: { why: "找不到这个需求", next: STALE },
  workspace_changed: { why: "需求工作区绑定已变化", next: STALE },
  requirement_inactive: { why: "需求已不是可读取批准正文的状态", next: STALE },
  lease_stale: { why: "派出本运行的 PM 租约已失效，可能已过期或被新 PM 接管", next: STALE },
  version_changed: { why: "读取期间批准版本已变化", next: "从第一页重新读取（不带 cursor）" },
  check_round_invalid: { why: "绑定的检查轮已结束、失效或被中断", next: STALE },
  closed_metadata_only: { why: "需求正在关闭或已关闭，只能读取 metadata", next: "改用 metadata；不要再读正文" },
  cursor_invalid: { why: "翻页游标已过期、已用过，或与本次的动作、章节、maxBytes 不一致", next: "不带 cursor 从第一页重新读取，翻页时原样沿用上一页给出的 cursor 与参数" },
  diff_unavailable: { why: "本运行没有可用的差异基线，不能读取 diff", next: "改用 read 读取批准正文" },
  response_too_large: { why: "这一页的结果超出了返回上限", next: "调小 maxBytes，或用 sectionId 只读一个章节" },
  section_not_found: { why: "批准正文里没有这个章节编号", next: "先不带 sectionId 读取，按结果里 structure 列出的章节编号再读" },
  structure_unavailable: { why: "批准正文没有可识别的章节结构，不能按章节读取", next: "不带 sectionId 读取全文" },
  read_failed: { why: "读取批准正文时出错", next: "重试一次；仍然失败就在回复里说明，由上级处理" },
} as const satisfies Record<string, FailureAdvice>;
export type RequirementReadErrorCode = keyof typeof READ_ADVICE;
export class RequirementReadError extends Error {
  readonly code: RequirementReadErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: RequirementReadErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "RequirementReadError"; this.code = code; this.advice = withDetail(READ_ADVICE[code], detail);
  }
}
const PROD_VIEW_FAILURES: Record<string, RequirementReadErrorCode> = {
  prod_response_budget_exceeded: "response_too_large",
  unknown_section: "section_not_found",
  section_structure_unavailable: "structure_unavailable",
  invalid_page_range: "cursor_invalid",
};
/** 下层带原因的错误原样交出；分页与章节的固定错误换成对应原因；其余只说读取出错，不回显可能含路径或受限文本的原始消息。 */
function readFailure(error: unknown): Error {
  if (error instanceof RequirementReadError || adviceOf(error)) return error as Error;
  const mapped = error instanceof ProdViewError ? PROD_VIEW_FAILURES[error.code] : undefined;
  return new RequirementReadError(mapped ?? "read_failed");
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
  catch (error) { throw error instanceof RequirementReadError || adviceOf(error) ? error : new RequirementReadError("open_failed"); }
}

async function openReadTool(options: RequirementReadToolOptions) {
  let binding: RequirementReadBinding;
  try { binding = freeze(checked(Binding, structuredClone(options.binding))); } catch { throw new RequirementReadError("binding_invalid"); }
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot,
    repoId: binding.repoId };
  const authorize = options.authorize;
  let disposed = false;
  const cursors = new Map<string, Cursor>();
  const returns = new WeakMap<object, { action: RequirementReadAuthorization["action"]; record: { version: number; data: RequirementRecord };
    scope?: ReturnType<typeof source>["approvalScope"] }>();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const deny = (code: RequirementReadErrorCode, detail?: string): never => { throw new RequirementReadError(code, detail); };
  function bounded<T>(response: T): T {
    if (Buffer.byteLength(JSON.stringify(response)) > PROD_RESPONSE_MAX_BYTES) deny("response_too_large");
    return freeze(response);
  }
  if (binding.requirementId !== binding.lease.requirementId || binding.workspaceId !== binding.lease.workspaceId ||
    (binding.role === "pm" && binding.runId !== binding.lease.runId)) deny("binding_invalid");
  function host(action: RequirementReadAuthorization["action"]) {
    if (disposed) deny("tool_closed");
    if (!authorizeToolAction(binding.role, "requirement_manage", action)) deny("action_not_allowed", `${binding.role} 不能做 ${action}`);
    let result: unknown;
    try { result = authorize(freeze({ binding, action })); } catch (error) { return deny("session_inactive", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny("session_inactive");
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
    if (!record) return deny("requirement_missing");
    const workspace = record.data.workspace;
    if (!workspace || workspace.repoId !== binding.repoId || workspace.requirementId !== binding.requirementId ||
      workspace.workspaceId !== binding.workspaceId || workspace.branch !== binding.branch) deny("workspace_changed");
    return record;
  }
  function activeSync(expected?: { version: number; data: RequirementRecord }, db?: LocalDatabase) {
    const record = current(db);
    if (record.data.lifecycle !== "active" || record.data.recovery !== "ready") deny("requirement_inactive", "需求不在活动状态");
    if (!record.data.approved) deny("requirement_inactive", "需求没有批准版本");
    if (record.data.epoch !== binding.lease.epoch) deny("requirement_inactive", "需求已换代（epoch 变化）");
    const ownerRow = db?.read("pm_ownership", binding.requirementId);
    const owner = db ? ownerRow && checked(PmRecord, ownerRow.data) : state.pmOwner(binding.requirementId);
    const lease = owner?.lease;
    if (!lease || owner!.requirementId !== binding.requirementId || lease.requirementId !== binding.requirementId || owner!.fence !== binding.lease.fence || lease.fence !== binding.lease.fence ||
      lease.runId !== binding.lease.runId || lease.workspaceId !== binding.workspaceId || lease.epoch !== binding.lease.epoch ||
      lease.contextGeneration !== binding.lease.contextGeneration || lease.expiresAt <= Date.now()) deny("lease_stale");
    if (expected && (record.version !== expected.version || record.data.revision !== expected.data.revision ||
      record.data.approved!.commit !== expected.data.approved?.commit || record.data.approved!.hash !== expected.data.approved?.hash)) deny("version_changed");
    return record;
  }
  function target(record: { version: number; data: RequirementRecord }, db?: LocalDatabase): { revision: number; reference: ProdReference } {
    if (!binding.checkRoundId) return { revision: record.data.revision, reference: record.data.approved! };
    const round = db ? readCheckRoundIn(db, binding.checkRoundId) : withDatabase(repositoryDatabase(config.dataRoot, binding.repoId), (inner) => readCheckRoundIn(inner, binding.checkRoundId!));
    if (!round || round.data.requirementId !== binding.requirementId || round.data.repoId !== binding.repoId || round.data.epoch !== binding.lease.epoch ||
      round.data.fence !== binding.lease.fence || round.data.status === "released" || round.data.invalidation !== null || round.data.decision?.kind === "interrupt" ||
      round.data.baseline.revision > record.data.revision) return deny("check_round_invalid");
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
  } catch (error) { dispose(); throw readFailure(error); }

  async function execute(input: unknown) {
    let params: ReturnType<typeof checkServiceInput<typeof REQUIREMENT_READ_PARAMETERS>>;
    try { params = checkServiceInput(REQUIREMENT_READ_PARAMETERS, input); }
    catch (error) { throw new RequirementReadError("invalid_shape", (error as Error).message); }
    try {
      host(params.action);
      purge();
      const status = current();
      if (status.data.lifecycle === "closing" || status.data.lifecycle === "closed") {
        cursors.clear();
        if (params.action !== "metadata") deny("closed_metadata_only");
        // 关闭后只允许固定身份/状态；无标题、路径、提交、hash、决定或目标摘要。
        await verifyRequirementWorkspace(config.dataRoot, status.data.workspace!);
        host("metadata");
        const final = current();
        if (final.data.lifecycle !== "closing" && final.data.lifecycle !== "closed") deny("version_changed");
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
      if (params.cursor && (!cursor || cursor.action !== params.action || cursor.sectionId !== sectionId || cursor.maxBytes !== maxBytes)) deny("cursor_invalid");
      if (cursor && (cursor.version !== before.version || cursor.revision !== goal.revision || cursor.epoch !== before.data.epoch ||
        cursor.commit !== goal.reference.commit || cursor.hash !== goal.reference.hash)) deny("version_changed");
      if (params.cursor) cursors.delete(params.cursor);
      const baseline = binding.diffBaseline;
      if (params.action === "diff") {
        if (!baseline || binding.checkRoundId || baseline.revision > before.data.revision) deny("diff_unavailable");
        const from = state.events(binding.requirementId).find((event) => event.data.kind === "prod.approved" && event.data.revision === baseline!.revision);
        if (from?.data.to?.commit !== baseline!.reference.commit || from.data.to.hash !== baseline!.reference.hash) deny("diff_unavailable", "差异基线与批准记录不符");
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
          result.version !== before.version || result.epoch !== before.data.epoch) deny("version_changed");
        title = result.title;
        structure = inspectProdStructure(result.body);
        text = selectProdSection(result.body, structure, sectionId);
      } else {
        const result = await service.diff({ requirementId: binding.requirementId, fromRevision: baseline!.revision,
          toRevision: before.data.revision });
        if (result.fromCommit !== baseline!.reference.commit || result.fromHash !== `sha256:${baseline!.reference.hash}` ||
          result.toCommit !== before.data.approved!.commit || result.toHash !== `sha256:${before.data.approved!.hash}` ||
          result.version !== before.version || result.epoch !== before.data.epoch) deny("version_changed");
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
    } catch (error) {
      cursors.clear();
      throw readFailure(error);
    }
  }
  /** 外层须在自身最后一次await/宿主回调之后调用；只认本工具原对象，不接受JSON副本作许可。 */
  function assertCurrent(result: unknown): void {
    try {
      const returned = result && typeof result === "object" ? returns.get(result) : undefined;
      if (!returned) return deny("read_failed", "结果不是本工具刚返回的对象");
      host(returned.action);
      withDatabase(repositoryDatabase(config.dataRoot, binding.repoId), (db) => db.transaction(() => {
        if (returned.scope) {
          activeSync(returned.record, db);
          target(returned.record, db);
          assertApprovalScopeReturnIn(db, binding.repoId, { ...returned.record, id: binding.requirementId }, returned.scope);
        } else {
          const actual = current(db);
          if (!["closing", "closed"].includes(actual.data.lifecycle) || actual.version !== returned.record.version ||
            actual.data.lifecycle !== returned.record.data.lifecycle || actual.data.epoch !== returned.record.data.epoch) deny("version_changed");
        }
      }));
    } catch (error) { cursors.clear(); throw readFailure(error); }
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
