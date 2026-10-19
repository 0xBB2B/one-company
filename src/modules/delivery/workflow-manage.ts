import { isPromise } from "node:util/types";
import { adviceOf, COMMON_ADVICE, withDetail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { Type } from "typebox";
import type { Static } from "typebox";
import { uuidv7 } from "../../core/storage/database.ts";
import { CheckRoundService } from "../verification/check-round.ts";
import { authorizeToolAction } from "../../core/policy/core-permissions.ts";
import { checked, hash, id, object, PmLease, positive } from "../requirement/requirement-contracts.ts";
import { checkServiceInput } from "../requirement/requirement-manage-contracts.ts";
import { escalateTask } from "../pm/task-dispatch.ts";
import { closeItemText, CloseError, RequirementCloseService } from "./workflow-close.ts";
import type { RequirementCloseServiceOptions } from "./workflow-close.ts";

const Grant = object({
  role: Type.Union([Type.Literal("main"), Type.Literal("pm")]), callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1, maxLength: 4096, pattern: "^refs/heads/" }), lease: Type.Optional(PmLease),
});
export type WorkflowManageGrant = Static<typeof Grant>;
const CloseReason = Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]);
export const WORKFLOW_MANAGE_PARAMETERS = Type.Union([
  object({ action: Type.Literal("status") }),
  object({ action: Type.Literal("advance") }),
  object({ action: Type.Literal("finish"), checkRoundId: id }),
  object({ action: Type.Literal("check-decision"), checkRoundId: id, kind: Type.Union([Type.Literal("interrupt"), Type.Literal("defer")]), revision: positive }),
  object({ action: Type.Literal("close"), reason: CloseReason, receiptId: id }),
  object({ action: Type.Literal("delivery-check") }),
  object({ action: Type.Literal("report"), note: Type.String({ minLength: 1, maxLength: 4000 }) }),
  object({ action: Type.Literal("escalate"), taskId: id, note: Type.String({ minLength: 1, maxLength: 1024 }) }),
]);
export type WorkflowManageParameters = Static<typeof WORKFLOW_MANAGE_PARAMETERS>;
export type WorkflowManageAction = WorkflowManageParameters["action"];
const WORKFLOW_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  action_not_allowed: COMMON_ADVICE.action_not_allowed,
  session_inactive: COMMON_ADVICE.session_inactive,
  open_failed: COMMON_ADVICE.open_failed,
  grant_invalid: { why: "派工身份与 PM 租约不一致", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
  invalid_shape: COMMON_ADVICE.invalid_shape,
  lease_required: { why: "这个动作只有持有租约的 PM 能做", next: "改用职责内的动作" },
} as const satisfies Record<string, FailureAdvice>;
export type WorkflowManageErrorCode = keyof typeof WORKFLOW_ADVICE;
export class WorkflowManageError extends Error {
  readonly code: WorkflowManageErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: WorkflowManageErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "WorkflowManageError"; this.code = code; this.advice = withDetail(WORKFLOW_ADVICE[code], detail);
  }
}

const ITEM_KEYS = new Set(["missing", "pending", "blockers"]);
/** 交给模型前把缺项、待办与阻塞项的内部码换成白话；被拒或仍在关闭时附上建议。 */
function explained(value: unknown, authorization?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => explained(item, authorization));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const auth = typeof row.authorization === "string" ? row.authorization : authorization;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    if (key === "authorization") continue;
    out[key] = ITEM_KEYS.has(key) && Array.isArray(item) && item.every((entry) => typeof entry === "string")
      ? item.map((code) => closeItemText(code, auth)) : explained(item, auth);
  }
  if (row.status === "rejected") out.next = Array.isArray(row.missing) && row.missing.includes("close_intent_conflict")
    ? "用原来的原因和决定编号再次 close 续办；或按已有请求的原因处理"
    : "按原因逐项处理后再试；需要用户决定的，先问用户";
  if (row.status === "closing") out.next = "等这些事项结束后，用原决定编号 receiptId、原原因 reason 再次 close 续办";
  return out;
}
export interface WorkflowManageAuthorization { readonly grant: Readonly<WorkflowManageGrant>; readonly action: WorkflowManageAction; readonly receiptId?: string; readonly reason?: string }
export interface WorkflowManageToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  grant: WorkflowManageGrant;
  /** 必须由宿主核验当前物理会话/调用者及动作许可；关闭回执须对照真实用户交互核验。 */
  authorize: (request: Readonly<WorkflowManageAuthorization>) => boolean;
  stopAgents?: RequirementCloseServiceOptions["stopAgents"];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** workflow_manage 的工具工厂：检查阶段进入/退出、PM 中断/等待决策、交付凭据、完成报告与关闭协议。 */
export async function createWorkflowManageTool(options: WorkflowManageToolOptions) {
  try { return await openWorkflowManageTool(options); }
  catch (error) { throw adviceOf(error) ? error : new WorkflowManageError("open_failed", (error as Error).message); }
}

async function openWorkflowManageTool(options: WorkflowManageToolOptions) {
  const grant = freeze(checked(Grant, structuredClone(options.grant)));
  const deny: (code: WorkflowManageErrorCode, detail?: string) => never = (code, detail) => { throw new WorkflowManageError(code, detail); };
  if ((grant.role === "pm") !== (grant.lease !== undefined)) deny("grant_invalid");
  if (grant.lease && (grant.lease.requirementId !== grant.requirementId || grant.lease.workspaceId !== grant.workspaceId || grant.lease.runId !== grant.runId)) deny("grant_invalid");
  let disposed = false;
  function host(action: WorkflowManageAction, extra: { receiptId?: string; reason?: string } = {}) {
    if (disposed) deny("tool_closed");
    if (!authorizeToolAction(grant.role, "workflow_manage", action)) deny("action_not_allowed", `${grant.role === "main" ? "主代理" : grant.role} 不能做 ${action}`);
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action, ...extra })); }
    catch (error) { if (adviceOf(error)) throw error; return deny("session_inactive", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny("session_inactive");
  }
  host("status");
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: grant.repoId };
  const rounds = await CheckRoundService.open({ ...config, authorize: (request) => !disposed && request.requirementId === grant.requirementId &&
    (request.lease === undefined || (grant.lease !== undefined && request.lease.runId === grant.lease.runId && request.lease.fence === grant.lease.fence)) });
  const close = await RequirementCloseService.open({ ...config, stopAgents: options.stopAgents, authorize: (request) => {
    if (disposed || request.requirementId !== grant.requirementId) return false;
    if (request.action === "close" || request.action === "archive") { host("close", { receiptId: request.receiptId, reason: request.reason }); return true; }
    if (request.action === "delivery-check") { host("delivery-check"); return true; }
    if (request.action === "status") { host("status"); return true; }
    if (request.action === "report") { host("report"); return true; }
    return false;
  } });
  function lease(): PmLease {
    if (!grant.lease) deny("lease_required");
    return structuredClone(grant.lease);
  }
  async function execute(input: unknown) {
    let params: WorkflowManageParameters;
    try { params = checkServiceInput(WORKFLOW_MANAGE_PARAMETERS, input); } catch (error) { throw new WorkflowManageError("invalid_shape", (error as Error).message); }
    host(params.action);
    return explained(await run(params));
  }
  async function run(params: WorkflowManageParameters) {
    switch (params.action) {
        case "status": return freeze({ close: close.status(grant.requirementId) });
        case "advance": return rounds.openRound({ lease: lease() });
        case "finish": return rounds.release({ lease: lease(), checkRoundId: params.checkRoundId });
        case "check-decision": return rounds.decide({ lease: lease(), checkRoundId: params.checkRoundId, kind: params.kind, revision: params.revision });
        case "delivery-check": return close.deliveryCheck(grant.requirementId);
        case "report": return close.report({ requirementId: grant.requirementId, pmRunId: lease().runId, note: params.note });
        case "escalate": {
          const task = escalateTask({ dataRoot: options.dataRoot, repoId: grant.repoId, lease: lease(), taskId: params.taskId, note: params.note });
          return freeze({ taskId: task.taskId, key: task.key, status: task.status, next: "已交用户裁决；在用户决定前不能再派这个任务" });
        }
        case "close": {
          const result = await close.close({ requirementId: grant.requirementId, reason: params.reason, receiptId: params.receiptId });
          if (result.status !== "closed" || !result.archive || result.archive.status === "archived") return result;
          host("close", { receiptId: params.receiptId, reason: params.reason });
          let archive;
          try { archive = await close.archive(grant.requirementId); }
          catch (error) {
            if (!(error instanceof CloseError)) throw error;
            return freeze({ ...result, archive: { path: result.archive.path, status: "blocked" as const, reason: error.advice.why, next: error.advice.next } });
          }
          return freeze({ ...result, archive: { path: archive.path, status: archive.status } });
        }
    }
  }
  return { execute, dispose() { disposed = true; rounds.dispose(); close.dispose(); } };
}
