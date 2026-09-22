import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { authorizeToolAction } from "./core-permissions.ts";
import { checkExploreInput, checkExploreResult, ExploreContractError } from "./explore-contracts.ts";
import type { ExploreInput } from "./explore-contracts.ts";
import { checked, id, object } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";

const Grant = object({
  role: Type.Union([Type.Literal("explore"), Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("qa")]),
  callerId: id, runId: id, parentRunId: Type.String({ minLength: 1, maxLength: 256 }),
});
export type ResultSubmitGrant = Static<typeof Grant>;
export const RESULT_SUBMIT_PARAMETERS = Type.Union([
  object({ action: Type.Literal("research"), result: Type.Unknown() }),
  object({ action: Type.Literal("verdict"), result: Type.Unknown() }),
]);
export type ResultSubmitParameters = Static<typeof RESULT_SUBMIT_PARAMETERS>;
export type ResultSubmitAction = ResultSubmitParameters["action"];
export type ResultSubmitErrorCode = "result_submit_denied" | "invalid_shape" | "invalid_binding" | "out_of_scope" | "resource_limit" | "verdict_unavailable";
export class ResultSubmitError extends Error {
  readonly code: ResultSubmitErrorCode;
  constructor(code: ResultSubmitErrorCode) { super(code); this.name = "ResultSubmitError"; this.code = code; }
}
export interface ResultSubmitAuthorization { readonly grant: Readonly<ResultSubmitGrant>; readonly action: ResultSubmitAction }
export interface ResultSubmitToolOptions {
  grant: ResultSubmitGrant;
  /** explore 的最小输入由派出它的可信父代理提供；research 结果只能绑定这份输入。 */
  exploreInput?: ExploreInput;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造true。 */
  authorize: (request: Readonly<ResultSubmitAuthorization>) => boolean;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function createResultSubmitTool(options: ResultSubmitToolOptions) {
  const deny: () => never = () => { throw new ResultSubmitError("result_submit_denied"); };
  let grant: ResultSubmitGrant;
  try { grant = freeze(checked(Grant, structuredClone(options.grant))); } catch { return deny(); }
  const exploreInput = options.exploreInput === undefined ? undefined : checkExploreInput(options.exploreInput);
  if (exploreInput && exploreInput.parent.parentRunId !== grant.parentRunId) deny();
  let disposed = false;
  function host(action: ResultSubmitAction) {
    if (disposed || !authorizeToolAction(grant.role, "result_submit", action)) deny();
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action })); } catch { return deny(); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny();
  }
  function execute(input: unknown) {
    let params: ResultSubmitParameters;
    try { params = checkServiceInput(RESULT_SUBMIT_PARAMETERS, input); } catch { throw new ResultSubmitError("invalid_shape"); }
    host(params.action);
    if (params.action === "verdict") throw new ResultSubmitError("verdict_unavailable");
    if (!exploreInput) deny();
    let result;
    try { result = checkExploreResult(params.result, exploreInput); }
    catch (error) { throw new ResultSubmitError(error instanceof ExploreContractError ? error.code : "invalid_shape"); }
    host("research");
    return freeze({ kind: "research" as const, accepted: true, isPass: false, parentRunId: grant.parentRunId, runId: grant.runId,
      sourceKind: result.source.kind, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      sources: result.sources.length, truncated: result.truncation.truncated, unknown: result.unknown.length, failures: result.failures.length });
  }
  return { execute, dispose() { disposed = true; } };
}
