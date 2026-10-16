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

const RETRY_NEXT = "可以重试一次；仍然失败就把这段原因告诉用户";
const NO_RETRY_NEXT = "不要重试，把这段原因告诉用户";

function outputText(value: unknown): string | undefined {
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}

interface CommandFailureKind { program: string; label: string; output: "always" | "if-any" | "never"; next: string }

function commandFailureKind(error: unknown): CommandFailureKind | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const { cmd, stdout, stderr, code, killed, signal } = error as Record<string, unknown>;
  if (typeof cmd !== "string" || outputText(stdout) === undefined || outputText(stderr) === undefined) return undefined;
  const program = cmd.trim().split(/\s+/)[0]!;
  const kind = (label: string, output: CommandFailureKind["output"], next: string) => ({ program, label, output, next });
  if (typeof code === "number") return kind(`命令失败（退出码 ${code}）`, "always", "根据命令输出判断：参数或文件写错就改正后再试；看不懂就把这段原因告诉用户");
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return kind("命令输出太多，超过程序的读取上限", "never", NO_RETRY_NEXT);
  if (code === "ENOENT") return kind("命令无法启动：找不到这个程序，或者工作目录不存在", "never", "确认工作目录还在；仍然失败就把这段原因告诉用户，可能需要安装这个程序");
  if (code === "EACCES") return kind("命令无法启动：没有权限运行这个程序，或者没有权限进入工作目录", "never", NO_RETRY_NEXT);
  if (code === "ABORT_ERR") return kind("命令被取消", "never", "不要重试，等待用户或上级的下一步安排");
  if (code !== null || typeof signal !== "string") return undefined;
  if (killed === true) return kind("命令超时，被程序停止", "if-any", "可以重试一次；仍然超时就把这段原因告诉用户");
  if (killed === false) return kind(`命令被信号 ${signal} 停止`, "if-any", RETRY_NEXT);
  return undefined;
}

function describe(kind: CommandFailureKind, tail: string | undefined): string {
  const detail = kind.output === "always" ? tail ?? "命令没有输出" : kind.output === "if-any" ? tail : undefined;
  return detail ? `${kind.label}：${detail}` : kind.label;
}

function tailOf(raw: string, lines: number, limit: number): string {
  const tail = raw.split("\n").map((line) => line.trim()).filter(Boolean).slice(-lines).join(" / ");
  return tail.length > limit ? `…${tail.slice(-limit)}` : tail;
}

function outputTail(error: unknown, lines: number, limit: number): string | undefined {
  const record = error !== null && typeof error === "object" ? error as { stderr?: unknown; stdout?: unknown } : {};
  const text = (value: unknown): string | undefined => { const output = outputText(value); return output?.trim() ? output : undefined; };
  const output = text(record.stderr) ?? text(record.stdout);
  return output === undefined ? undefined : tailOf(output, lines, limit);
}

export function failureText(step: string, error: unknown): string {
  const advice = adviceOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const kind = advice ? undefined : commandFailureKind(error);
  const why = advice?.why ?? (kind ? `${kind.program} ${describe(kind, outputTail(error, 3, 300))}` : `未归类的错误（${message}）`);
  const next = advice?.next ?? kind?.next ?? RETRY_NEXT;
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

/** 外部命令失败时给调用方拼进报错的一句话：非零退出取命令输出摘要，其余类别取描述句。 */
export function commandOutputTail(error: unknown, lines = 3, limit = 300): string {
  const tail = outputTail(error, lines, limit);
  const kind = commandFailureKind(error);
  if (kind) return kind.output === "always" ? tail ?? "命令没有输出" : describe(kind, tail);
  if (tail !== undefined) return tail;
  const message = error !== null && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  return tailOf(typeof message === "string" ? message : String(error), lines, limit);
}

/** 按码查原因与建议；码不在表里时说明是未归类的拒绝，仍给出下一步。 */
export function adviceIn(table: Readonly<Record<string, FailureAdvice>>, code: string, detail?: string): FailureAdvice {
  const base = Object.hasOwn(table, code) ? table[code]! : { why: `未归类的拒绝（${code}）`, next: "重试一次；仍然失败就把这段原因告诉用户" };
  return withDetail(base, detail);
}
