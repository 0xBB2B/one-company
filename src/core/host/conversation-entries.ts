import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

export function branchCustomEntries<T = unknown>(sessionManager: Pick<SessionManager, "getBranch">, customType: string): T[] {
  const result: T[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === customType) result.push(entry.data as T);
  }
  return result;
}

export function appendCustomEntry(pi: Pick<ExtensionAPI, "appendEntry">, customType: string, data: unknown): void {
  pi.appendEntry(customType, data);
}
