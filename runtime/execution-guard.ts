import { types as utilTypes } from "node:util";

export const DEFAULT_GUARDED_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ExecutionGuard {
  /** 必须同步完成且返回 undefined；用于实际启动、close 和结果交付边界复验。 */
  assertCurrent(): void;
  maxOutputBytes?: number;
}

export class ExecutionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionGuardError";
  }
}

function hasThenDescriptor(value: object): boolean {
  let current: object | null = value;
  const seen = new Set<object>();
  try {
    while (current && !seen.has(current)) {
      seen.add(current);
      if (Object.getOwnPropertyDescriptor(current, "then")) return true;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return true;
  }
  return false;
}

export function assertExecutionGuardCurrent(assertCurrent: () => void): void {
  const result = assertCurrent() as unknown;
  if (result === undefined) return;
  if (utilTypes.isPromise(result)) {
    void Promise.prototype.then.call(result, () => undefined, () => undefined);
    throw new ExecutionGuardError("执行保护必须同步完成，不能返回 Promise");
  }
  if ((typeof result === "object" && result !== null) || typeof result === "function") {
    if (hasThenDescriptor(result as object)) {
      throw new ExecutionGuardError("执行保护必须同步完成，不能返回 thenable");
    }
  }
  throw new ExecutionGuardError("执行保护必须同步完成且返回 undefined");
}

export function guardedOutputLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_GUARDED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_GUARDED_OUTPUT_BYTES) {
    throw new ExecutionGuardError(`执行保护输出上限无效，必须为 1..${DEFAULT_GUARDED_OUTPUT_BYTES} 字节`);
  }
  return limit;
}
