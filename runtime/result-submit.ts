import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { authorizeToolAction } from "./core-permissions.ts";
import { checkExploreInput, checkExploreResult, ExploreContractError, ExploreResultSchema } from "./explore-contracts.ts";
import { fillResearchSources } from "./explore-dispatch.ts";
import type { ExploreInput, ExploreResult } from "./explore-contracts.ts";
import { checked, id, object } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import { checkExploreSession } from "./explore-session.ts";
import type { ExploreSessionConfig } from "./explore-session.ts";
import { shapeIssue } from "./tool-request.ts";
import { submitVerdict, VERDICT_PAYLOAD, VerdictError } from "./verdicts.ts";
import type { VerdictBinding } from "./verdicts.ts";

const Grant = object({
  role: Type.Union([Type.Literal("explore"), Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("qa")]),
  callerId: id, runId: id, parentRunId: Type.String({ minLength: 1, maxLength: 256 }),
});
export type ResultSubmitGrant = Static<typeof Grant>;
/** worker、reviewer、QA 看到的参数：result 直接给出裁决格式，模型不必猜字段。 */
export const VERDICT_SUBMIT_PARAMETERS = object({ action: Type.Literal("verdict"), result: VERDICT_PAYLOAD });
export const RESULT_SUBMIT_PARAMETERS = Type.Union([
  object({ action: Type.Literal("research"), result: Type.Unknown() }),
  VERDICT_SUBMIT_PARAMETERS,
]);
export type ResultSubmitParameters = Static<typeof RESULT_SUBMIT_PARAMETERS>;
export type ResultSubmitAction = ResultSubmitParameters["action"];
export type ResultSubmitErrorCode = "result_submit_denied" | "invalid_shape" | "invalid_binding" | "out_of_scope" | "resource_limit" | "verdict_unavailable" | "stale_session";
export class ResultSubmitError extends Error {
  readonly code: ResultSubmitErrorCode;
  constructor(code: ResultSubmitErrorCode, hint?: string) { super(hint ? `${code}：${hint}` : code); this.name = "ResultSubmitError"; this.code = code; }
}
export interface ResultSubmitAuthorization { readonly grant: Readonly<ResultSubmitGrant>; readonly action: ResultSubmitAction }
export interface ResultSubmitToolOptions {
  grant: ResultSubmitGrant;
  /** explore 的最小输入由派出它的可信父代理提供；research 结果只能绑定这份输入。 */
  exploreInput?: ExploreInput;
  /** worker/reviewer/QA 的裁决绑定由可信派工服务提供；缺失时 verdict 动作不可用。 */
  verdictBinding?: VerdictBinding;
  /** 已登记的 explore 搜索会话：需求关闭、父撤权、PM 接管或会话回收后 research 一律拒收。 */
  exploreSession?: ExploreSessionConfig;
  /** 宿主按实际内容核对 research 引用的来源；不一致即拒收。 */
  verify?: (result: ExploreResult) => boolean;
  /** 宿主收下已通过核验的 research，用于按派出方送回；不经模型转述。 */
  onResearch?: (result: ExploreResult) => void;
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
    try { params = checkServiceInput(RESULT_SUBMIT_PARAMETERS, input); } catch {
      const raw = input && typeof input === "object" ? input as { action?: unknown; result?: unknown } : {};
      throw new ResultSubmitError("invalid_shape", raw.action === "verdict" ? shapeIssue(VERDICT_PAYLOAD, raw.result) : undefined);
    }
    host(params.action);
    if (params.action === "verdict") {
      if (!options.verdictBinding || grant.role === "explore") throw new ResultSubmitError("verdict_unavailable");
      let verdict;
      try { verdict = submitVerdict(options.verdictBinding, { role: grant.role, runId: grant.runId, parentRunId: grant.parentRunId }, params.result); }
      catch (error) { throw error instanceof VerdictError ? new ResultSubmitError(error.code, error.detail) : new ResultSubmitError("invalid_shape"); }
      host("verdict");
      return freeze({ kind: "verdict" as const, accepted: true, isPass: false, verdictId: verdict.verdictId, conclusion: verdict.conclusion,
        checkRoundId: verdict.checkRoundId, findings: verdict.findings.length, runId: grant.runId });
    }
    if (!exploreInput) deny();
    let result;
    // 模型可省略父身份与检索来源，由宿主按派工输入补上；若自行给出则仍须与派工输入一致
    const submitted = params.result && typeof params.result === "object" && !Array.isArray(params.result) ? params.result : {};
    const candidate = { format: "explore-result/v1", kind: "research", parent: exploreInput.parent, source: exploreInput.source,
      ...fillResearchSources(submitted as Record<string, unknown>, exploreInput) };
    try { result = checkExploreResult(candidate, exploreInput); }
    catch (error) {
      const code = error instanceof ExploreContractError ? error.code : "invalid_shape";
      throw new ResultSubmitError(code, code === "invalid_shape" ? shapeIssue(ExploreResultSchema, candidate) : error instanceof ExploreContractError ? error.detail : undefined);
    }
    if (options.verify && !options.verify(result)) throw new ResultSubmitError("invalid_binding");
    if (options.exploreSession) {
      const decision = checkExploreSession(options.exploreSession, grant.runId);
      if (!decision.current || decision.session.parentRunId !== grant.parentRunId) throw new ResultSubmitError("stale_session");
    }
    host("research");
    options.onResearch?.(result);
    return freeze({ kind: "research" as const, accepted: true, isPass: false, parentRunId: grant.parentRunId, runId: grant.runId,
      sourceKind: result.source.kind, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      sources: result.sources.length, truncated: result.truncation.truncated, unknown: result.unknown.length, failures: result.failures.length });
  }
  return { execute, dispose() { disposed = true; } };
}
