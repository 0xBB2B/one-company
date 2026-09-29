import { unwrapRequest } from "./tool-request.ts";

export interface FailureAdvice { readonly why: string; readonly next: string }

export class AdvisedError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string, advice: FailureAdvice) {
    super(`${code}: ${advice.why}`); this.name = "AdvisedError"; this.code = code; this.advice = advice;
  }
}

function isAdvice(value: unknown): value is FailureAdvice {
  if (value === null || typeof value !== "object") return false;
  const advice = value as Record<string, unknown>;
  return typeof advice.why === "string" && advice.why !== "" && typeof advice.next === "string" && advice.next !== "";
}

/** 错误自带的原因与建议；经守护进程转发的错误放在 data.advice。 */
export function adviceOf(error: unknown): FailureAdvice | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const own = (error as { advice?: unknown }).advice;
  if (isAdvice(own)) return own;
  const data = (error as { data?: unknown }).data;
  const carried = data !== null && typeof data === "object" ? (data as { advice?: unknown }).advice : undefined;
  return isAdvice(carried) ? carried : undefined;
}

export function toolStep(toolName: string, params: unknown): string {
  const request = unwrapRequest(params) ?? params;
  const action = request !== null && typeof request === "object" ? (request as { action?: unknown }).action : undefined;
  return typeof action === "string" ? `${toolName} 的 ${action} 动作` : toolName;
}

export function failureText(step: string, error: unknown): string {
  const advice = adviceOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const why = advice?.why ?? `未归类的错误（${message}）`;
  const next = advice?.next ?? "可以重试一次；仍然失败就把这段原因告诉用户";
  return `${step}失败。\n原因：${why}\n建议：${next}`;
}

/** 交给模型的工具错误：消息只含哪一步失败、为什么、建议下一步；内部错误码留在 code 上供程序分支，不进消息。 */
export class ToolFailure extends Error {
  readonly code: string | undefined;
  constructor(step: string, error: unknown) {
    super(failureText(step, error), { cause: error });
    this.name = "ToolFailure";
    const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    this.code = typeof code === "string" ? code : undefined;
  }
}

export function toolFailure(step: string, error: unknown): ToolFailure {
  return error instanceof ToolFailure ? error : new ToolFailure(step, error);
}
