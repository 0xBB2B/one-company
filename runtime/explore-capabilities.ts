import { posix } from "node:path";
import { checkExploreInput, checkedUrl, ExploreContractError, isForbiddenFileName, isForbiddenRelativePath } from "./explore-contracts.ts";
import type { ExploreInput } from "./explore-contracts.ts";

/**
 * explore 的非业务能力白名单只做判定，不读文件、不发请求：
 * 本地检索与联网能力按输入来源分离，缺网络或外发授权只能报告"仅本地/未执行"。
 */
export const EXPLORE_HOST_TOOLS = Object.freeze({
  local: Object.freeze(["read", "grep", "find", "ls"] as const),
  network: Object.freeze(["web_search", "web_fetch"] as const),
});
type LocalTool = (typeof EXPLORE_HOST_TOOLS.local)[number];
type NetworkTool = (typeof EXPLORE_HOST_TOOLS.network)[number];

export interface ExploreCapabilityGrant {
  /** 可信宿主签发的 explore 输入，来源种类决定可用能力。 */
  readonly input: ExploreInput;
  /** 宿主实际具备的网络能力；缺省视为不可用。 */
  readonly networkAvailable?: boolean;
}
export type ExploreCapabilityDenial = "invalid_shape" | "tool_forbidden" | "forbidden_path" | "out_of_scope"
  | "network_unauthorized" | "disclosure_unauthorized" | "network_unavailable";
export type ExploreCapabilityDecision =
  | { readonly allowed: true; readonly tool: LocalTool | NetworkTool; readonly scope: "local" | "network" }
  | { readonly allowed: false; readonly code: ExploreCapabilityDenial; readonly report: "not_executed" | "local_only" };

const LOCAL = new Set<string>(EXPLORE_HOST_TOOLS.local);
const NETWORK = new Set<string>(EXPLORE_HOST_TOOLS.network);
const REQUEST_KEYS: Record<string, readonly string[]> = {
  read: ["tool", "path"], grep: ["tool", "path"], find: ["tool", "path"], ls: ["tool", "path"],
  web_search: ["tool", "query", "contentHash"], web_fetch: ["tool", "url", "contentHash"],
};

function shape(request: unknown): Record<string, unknown> | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const value = request as Record<string, unknown>;
  if (typeof value.tool !== "string") return null;
  const keys = REQUEST_KEYS[value.tool];
  if (keys && (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => typeof value[key] !== "string"))) return null;
  return value;
}
function isUnder(value: string, root: string): boolean {
  return value === root || value.startsWith(root === "/" ? "/" : `${root}/`);
}

export function checkExploreCapability(grant: ExploreCapabilityGrant, request: unknown): ExploreCapabilityDecision {
  const input = checkExploreInput(grant.input);
  const localGranted = input.source.kind !== "web";
  const report = localGranted ? "local_only" : "not_executed";
  const deny = (code: ExploreCapabilityDenial): ExploreCapabilityDecision => ({ allowed: false, code, report: code === "network_unauthorized" || code === "network_unavailable" ? report : "not_executed" });
  const value = shape(request);
  if (!value) return deny("invalid_shape");
  const tool = value.tool as string;
  if (!LOCAL.has(tool) && !NETWORK.has(tool)) return deny("tool_forbidden");
  if (LOCAL.has(tool)) {
    if (input.source.kind !== "local_file") return deny("out_of_scope");
    const path = value.path as string;
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return deny("out_of_scope");
    const root = input.source.allowedRoot;
    if (!isUnder(path, root)) return deny("out_of_scope");
    const relative = posix.relative(root, path);
    if (isForbiddenFileName(path) || (relative !== "" && isForbiddenRelativePath(relative))) return deny("forbidden_path");
    if ((tool === "read" || tool === "grep") && !input.source.allowedPaths.includes(path)) return deny("out_of_scope");
    return { allowed: true, tool: tool as LocalTool, scope: "local" };
  }
  if (input.source.kind !== "web") return deny("network_unauthorized");
  if (grant.networkAvailable !== true) return deny("network_unavailable");
  if (value.contentHash !== input.source.disclosure.contentHash) return deny("disclosure_unauthorized");
  if (tool === "web_search") {
    if (value.query !== input.source.query) return deny("out_of_scope");
    return { allowed: true, tool, scope: "network" };
  }
  let url: URL;
  try { url = checkedUrl(value.url as string); }
  catch (error) { if (error instanceof ExploreContractError) return deny("out_of_scope"); throw error; }
  if (!input.source.allowedDomains.includes(url.hostname)) return deny("out_of_scope");
  return { allowed: true, tool: "web_fetch", scope: "network" };
}
