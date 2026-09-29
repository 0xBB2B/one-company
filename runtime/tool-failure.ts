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

export function withDetail(base: FailureAdvice, detail?: string): FailureAdvice {
  return detail ? { why: `${base.why}：${detail}`, next: base.next } : base;
}

const STOP = "停止操作，不要重试；在回复里说明，由上级处理";
export const COMMON_ADVICE = {
  tool_closed: { why: "本工具已关闭，所在会话已结束或已被撤权", next: STOP },
  action_not_allowed: { why: "当前角色的职责不允许这个动作", next: "改用职责内的动作；确实需要时在回复里说明，由上级处理" },
  session_inactive: { why: "宿主确认本会话已不再有效，可能已结束、被停止或被取代", next: STOP },
  open_failed: { why: "工具初始化失败", next: "重试一次；仍然失败就在回复里说明原因，由上级处理" },
  invalid_shape: { why: "参数不符合该动作的格式", next: "按工具说明改正字段后重试" },
  internal_state: { why: "本机记录与预期不一致", next: "停止操作，把这段原因告诉用户" },
} as const satisfies Record<string, FailureAdvice>;

/** 外部命令失败时的原文摘要：取 stderr（没有就取消息）最后几行，限长。 */
export function commandOutputTail(error: unknown, lines = 3, limit = 300): string {
  const record = error !== null && typeof error === "object" ? error as { stderr?: unknown; message?: unknown } : {};
  const raw = typeof record.stderr === "string" && record.stderr.trim() ? record.stderr : typeof record.message === "string" ? record.message : String(error);
  const tail = raw.split("\n").map((line) => line.trim()).filter(Boolean).slice(-lines).join(" / ");
  return tail.length > limit ? `…${tail.slice(-limit)}` : tail;
}

/** 按码查原因与建议；码不在表里时说明是未归类的拒绝，仍给出下一步。 */
export function adviceIn(table: Readonly<Record<string, FailureAdvice>>, code: string, detail?: string): FailureAdvice {
  const base = Object.hasOwn(table, code) ? table[code]! : { why: `未归类的拒绝（${code}）`, next: "重试一次；仍然失败就把这段原因告诉用户" };
  return withDetail(base, detail);
}
