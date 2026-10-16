import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkSearchCall, filterSearchResult } from "./search-exclusion.ts";

/** 主会话的 grep/find/ls 同样不搜 .git 与被 Git 忽略的路径。 */
export default function searchExclusionExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => checkSearchCall(event, ctx.cwd));
  pi.on("tool_result", async (event) => filterSearchResult(event));
}
