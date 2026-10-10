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
import { checkExploreSession, EXPLORE_STALE_TEXT } from "./explore-session.ts";
import { COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import type { ExploreSessionConfig } from "./explore-session.ts";
import { PrototypeError, submitPrototype } from "./prototype.ts";
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
/** 做原型的 worker 看到的参数：html 是完整的单个 HTML 文件，note 用一句话说明画了什么。 */
export const PROTOTYPE_SUBMIT_PARAMETERS = object({ action: Type.Literal("prototype"), html: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1, maxLength: 1024 }) });
export const RESULT_SUBMIT_PARAMETERS = Type.Union([
  object({ action: Type.Literal("research"), result: Type.Unknown() }),
  VERDICT_SUBMIT_PARAMETERS,
  PROTOTYPE_SUBMIT_PARAMETERS,
]);
export type ResultSubmitParameters = Static<typeof RESULT_SUBMIT_PARAMETERS>;
export type ResultSubmitAction = ResultSubmitParameters["action"];
const RESULT_SUBMIT_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  action_not_allowed: COMMON_ADVICE.action_not_allowed,
  session_inactive: COMMON_ADVICE.session_inactive,
  grant_invalid: { why: "派工身份记录不合规或与派出它的上级不一致", next: "停止操作，不要重试；在回复里说明，由上级处理" },
  research_unavailable: { why: "本运行不是检索运行，没有可绑定的检索任务", next: "改用 verdict 提交本任务结果" },
  invalid_shape: { why: "提交内容的字段不符合格式", next: "按原因改正字段后重交" },
  invalid_binding: { why: "提交内容与派工绑定不一致", next: "按派工给定的任务、检查轮和验证编号提交" },
  out_of_scope: { why: "提交内容超出了本运行允许的范围", next: "按原因改正后重交" },
  out_of_scope_changes: { why: "工作区里有本任务写入范围以外的文件被改动", next: "先用命令把这些文件恢复成最新提交里的样子：已跟踪的文件用 git show HEAD:<路径> > <路径> 取回，新建的文件删掉（沙箱里 git checkout 与 git restore 用不了）；需要新增或升级第三方依赖时不要自己装，恢复后在 findings 里写明要什么、为什么，由 PM 交用户裁决；然后重交" },
  resource_limit: { why: "提交内容超出了允许的数量或长度", next: "精简内容后重交" },
  verdict_unavailable: { why: "本运行没有可提交裁决的任务绑定", next: "检索运行改用 research 提交；做原型的运行改用 prototype 提交" },
  prototype_unavailable: { why: "本运行不是做原型的运行，或已不是该任务当前的原型运行", next: "实现运行改用 verdict 提交结果" },
  prototype_too_large: { why: "原型超出大小上限", next: "精简原型后重交" },
  stale_session: { why: "本次检索已不是当前有效的检索，结果不会再被收下", next: "停止操作，不要重试" },
  submit_failed: { why: "保存提交内容时出错", next: "重试一次；仍然失败就在回复里说明原因，由上级处理" },
} as const satisfies Record<string, FailureAdvice>;
export type ResultSubmitErrorCode = keyof typeof RESULT_SUBMIT_ADVICE;
export class ResultSubmitError extends Error {
  readonly code: ResultSubmitErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: ResultSubmitErrorCode, hint?: string) {
    super(hint ? `${code}：${hint}` : code); this.name = "ResultSubmitError"; this.code = code; this.advice = withDetail(RESULT_SUBMIT_ADVICE[code], hint);
  }
}
export interface ResultSubmitAuthorization { readonly grant: Readonly<ResultSubmitGrant>; readonly action: ResultSubmitAction }
export interface ResultSubmitToolOptions {
  grant: ResultSubmitGrant;
  /** explore 的最小输入由派出它的可信父代理提供；research 结果只能绑定这份输入。 */
  exploreInput?: ExploreInput;
  /** worker/reviewer/QA 的裁决绑定由可信派工服务提供；缺失时 verdict 动作不可用。 */
  verdictBinding?: VerdictBinding;
  /** 做原型的运行绑定的任务；有它时只收 prototype，不收 verdict。 */
  prototypeBinding?: { dataRoot: string; repoId: string; requirementId: string; taskId: string };
  /** worker 运行由派工服务提供：返回工作区里不在本需求任何未取消任务写入范围内、却有改动的路径；有这样的路径时拒收结果。 */
  outOfScopeChanges?: () => Promise<string[]>;
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
  const deny: (code: ResultSubmitErrorCode, hint?: string) => never = (code, hint) => { throw new ResultSubmitError(code, hint); };
  let grant: ResultSubmitGrant;
  try { grant = freeze(checked(Grant, structuredClone(options.grant))); } catch { return deny("grant_invalid"); }
  const exploreInput = options.exploreInput === undefined ? undefined : checkExploreInput(options.exploreInput);
  if (exploreInput && exploreInput.parent.parentRunId !== grant.parentRunId) deny("grant_invalid");
  let disposed = false;
  function host(action: ResultSubmitAction) {
    if (disposed) deny("tool_closed");
    if (!authorizeToolAction(grant.role, "result_submit", action)) deny("action_not_allowed", `${grant.role} 不能提交 ${action}`);
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action })); } catch (error) { return deny("session_inactive", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny("session_inactive");
  }
  function inScope<T>(submit: () => T | Promise<T>): T | Promise<T> {
    if (!options.outOfScopeChanges) return submit();
    return options.outOfScopeChanges().then((paths) => {
      if (paths.length) deny("out_of_scope_changes", `${paths.slice(0, 20).join("、")}${paths.length > 20 ? ` 等共 ${paths.length} 个` : ""}`);
      return submit();
    });
  }
  function execute(input: unknown) {
    let params: ResultSubmitParameters;
    try { params = checkServiceInput(RESULT_SUBMIT_PARAMETERS, input); } catch {
      const raw = input && typeof input === "object" ? input as { action?: unknown; result?: unknown } : {};
      throw new ResultSubmitError("invalid_shape", raw.action === "verdict" ? shapeIssue(VERDICT_PAYLOAD, raw.result) : undefined);
    }
    host(params.action);
    if (params.action === "prototype") {
      if (!options.prototypeBinding) throw new ResultSubmitError("prototype_unavailable");
      const binding = options.prototypeBinding;
      return inScope(() => submitPrototype({ ...binding, runId: grant.runId }, { html: params.html, note: params.note }).then((prototype) => {
        host("prototype");
        return freeze({ kind: "prototype" as const, accepted: true, isPass: false, version: prototype.version, hash: prototype.hash, bytes: prototype.bytes, runId: grant.runId });
      }, (error: unknown) => {
        throw error instanceof PrototypeError && (error.code === "prototype_unavailable" || error.code === "prototype_too_large")
          ? new ResultSubmitError(error.code, error.detail) : new ResultSubmitError("submit_failed", (error as Error).message);
      }));
    }
    if (params.action === "verdict") {
      const binding = options.verdictBinding;
      if (!binding || options.prototypeBinding || grant.role === "explore") throw new ResultSubmitError("verdict_unavailable");
      const role = grant.role;
      return inScope(() => {
        let verdict;
        try { verdict = submitVerdict(binding, { role, runId: grant.runId, parentRunId: grant.parentRunId }, params.result); }
        catch (error) { throw error instanceof VerdictError ? new ResultSubmitError(error.code, error.detail) : new ResultSubmitError("submit_failed", (error as Error).message); }
        host("verdict");
        return freeze({ kind: "verdict" as const, accepted: true, isPass: false, verdictId: verdict.verdictId, conclusion: verdict.conclusion,
          checkRoundId: verdict.checkRoundId, findings: verdict.findings.length, runId: grant.runId });
      });
    }
    if (!exploreInput) deny("research_unavailable");
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
    if (options.verify && !options.verify(result)) throw new ResultSubmitError("invalid_binding", "research 引用的来源与实际内容不一致");
    if (options.exploreSession) {
      const decision = checkExploreSession(options.exploreSession, grant.runId);
      if (!decision.current) throw new ResultSubmitError("stale_session", EXPLORE_STALE_TEXT[decision.reason]);
      if (decision.session.parentRunId !== grant.parentRunId) throw new ResultSubmitError("stale_session", "派出检索的上级已不是本运行登记的上级");
    }
    host("research");
    options.onResearch?.(result);
    return freeze({ kind: "research" as const, accepted: true, isPass: false, parentRunId: grant.parentRunId, runId: grant.runId,
      sourceKind: result.source.kind, resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      sources: result.sources.length, truncated: result.truncation.truncated, unknown: result.unknown.length, failures: result.failures.length });
  }
  return { execute, dispose() { disposed = true; } };
}
