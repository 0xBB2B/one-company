export async function within<T>(operation: () => T | Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：${timeoutMs}ms内未确认结束`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
