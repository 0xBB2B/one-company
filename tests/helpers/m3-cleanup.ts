export interface CleanupOperation {
  label: string;
  run(): unknown | Promise<unknown>;
  timeoutMs?: number;
}

export async function within<T>(operation: () => T | Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：${timeoutMs}ms内未确认结束`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** 停止和诊断全部逐项执行；任何失败/未知均保留整组关联现场，不把超时当取消成功。 */
export async function cleanupOwnedScope(scope: {
  paths: string[];
  stop: CleanupOperation[];
  diagnose?: CleanupOperation[];
  remove: CleanupOperation[];
}): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: CleanupOperation) => {
    try { await within(operation.run, operation.label, operation.timeoutMs); }
    catch (cause) { failures.push(new Error(operation.label, { cause })); }
  };
  for (const operation of scope.stop) await attempt(operation);
  for (const operation of scope.diagnose ?? []) await attempt(operation);
  if (!failures.length) for (const operation of scope.remove) await attempt(operation);
  if (failures.length) throw new AggregateError(failures, `M3清理失败/未确认；保留关联现场：${scope.paths.join(', ')}`);
}
