import { posix } from "node:path";

// 仅按路径别名规整（点段、重复斜杠、目录尾斜杠），不涉及仓库边界。
export function overlaps(aRaw: string, bRaw: string): boolean {
  const a = posix.normalize(aRaw);
  const b = posix.normalize(bRaw);
  const aBase = a.endsWith("/") ? a.slice(0, -1) : a;
  const bBase = b.endsWith("/") ? b.slice(0, -1) : b;
  if (aBase === bBase) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}
