import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { CheckRoundService } from "./check-round.ts";
import { authorizeToolAction } from "./core-permissions.ts";
import { checked, hash, id, object, PmLease, positive } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import { escalateTask, TaskDispatchError } from "./task-dispatch.ts";
import { CloseError, RequirementCloseService } from "./workflow-close.ts";
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
  object({ action: Type.Literal("repair") }),
  object({ action: Type.Literal("check-decision"), checkRoundId: id, kind: Type.Union([Type.Literal("interrupt"), Type.Literal("defer")]), revision: positive }),
  object({ action: Type.Literal("close"), reason: CloseReason, receiptId: id, operationId: id }),
  object({ action: Type.Literal("delivery-check") }),
  object({ action: Type.Literal("report"), note: Type.String({ minLength: 1, maxLength: 4000 }) }),
  object({ action: Type.Literal("escalate"), taskId: id, note: Type.String({ minLength: 1, maxLength: 1024 }) }),
]);
export type WorkflowManageParameters = Static<typeof WORKFLOW_MANAGE_PARAMETERS>;
export type WorkflowManageAction = WorkflowManageParameters["action"];
export type WorkflowManageErrorCode = "workflow_denied" | "invalid_shape" | "lease_required" | "unavailable" | "task_not_ready";
export class WorkflowManageError extends Error {
  readonly code: WorkflowManageErrorCode;
  constructor(code: WorkflowManageErrorCode, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "WorkflowManageError"; this.code = code; }
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
  catch { throw new WorkflowManageError("workflow_denied"); }
}

async function openWorkflowManageTool(options: WorkflowManageToolOptions) {
  const grant = freeze(checked(Grant, structuredClone(options.grant)));
  const deny: (code?: WorkflowManageErrorCode) => never = (code = "workflow_denied") => { throw new WorkflowManageError(code); };
  if ((grant.role === "pm") !== (grant.lease !== undefined)) deny();
  if (grant.lease && (grant.lease.requirementId !== grant.requirementId || grant.lease.workspaceId !== grant.workspaceId || grant.lease.runId !== grant.runId)) deny();
  let disposed = false;
  function host(action: WorkflowManageAction, extra: { receiptId?: string; reason?: string } = {}) {
    if (disposed || !authorizeToolAction(grant.role, "workflow_manage", action)) deny();
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action, ...extra })); } catch { return deny(); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny();
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
    try { params = checkServiceInput(WORKFLOW_MANAGE_PARAMETERS, input); } catch { throw new WorkflowManageError("invalid_shape"); }
    host(params.action);
    switch (params.action) {
        case "repair": deny("unavailable");
        case "status": return freeze({ close: close.status(grant.requirementId) });
        case "advance": return rounds.openRound({ lease: lease() });
        case "finish": return rounds.release({ lease: lease(), checkRoundId: params.checkRoundId });
        case "check-decision": return rounds.decide({ lease: lease(), checkRoundId: params.checkRoundId, kind: params.kind, revision: params.revision });
        case "delivery-check": return close.deliveryCheck(grant.requirementId);
        case "report": return close.report({ requirementId: grant.requirementId, pmRunId: lease().runId, note: params.note });
        case "escalate": {
          try {
            const task = escalateTask({ dataRoot: options.dataRoot, repoId: grant.repoId, lease: lease(), taskId: params.taskId, note: params.note });
            return freeze({ taskId: task.taskId, key: task.key, status: task.status, next: "已交用户裁决；在用户决定前不能再派这个任务" });
          } catch (error) {
            if (error instanceof TaskDispatchError) throw new WorkflowManageError(error.code === "task_not_ready" ? "task_not_ready" : "workflow_denied", error.detail.join("；"));
            throw error;
          }
        }
        case "close": {
          const result = await close.close({ requirementId: grant.requirementId, reason: params.reason, receiptId: params.receiptId, operationId: params.operationId });
          if (result.status !== "closed" || !result.archive || result.archive.status === "archived") return result;
          host("close", { receiptId: params.receiptId, reason: params.reason });
          let archive;
          try { archive = await close.archive(grant.requirementId); }
          catch (error) { if (!(error instanceof CloseError)) throw error; archive = { ...result.archive, status: "blocked" as const }; }
          return freeze({ ...result, archive: { path: archive.path, status: archive.status } });
        }
    }
  }
  return { execute, dispose() { disposed = true; rounds.dispose(); close.dispose(); } };
}
