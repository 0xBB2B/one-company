import { posix } from "node:path";
import { PROD_ARCHIVE_DIRECTORY } from "./content-policy.ts";

export const CORE_ROLES = Object.freeze(["main", "pm", "explore", "worker", "reviewer", "qa"] as const);
export type CoreRole = (typeof CORE_ROLES)[number];

export const CORE_TOOL_ACTIONS = Object.freeze({
  project_manage: Object.freeze(["init", "status", "refresh", "recovery-check", "backup", "restore", "workspace-prepare", "workspace-recycle", "conventions-status", "conventions-update"] as const),
  knowledge_query: Object.freeze(["exact", "search", "facts"] as const),
  requirement_manage: Object.freeze(["create", "updateDraft", "confirmUpdate", "read", "diff", "metadata"] as const),
  plan_manage: Object.freeze(["propose", "read", "update", "confirm", "assess-update"] as const),
  agent_manage: Object.freeze(["dispatch", "status", "pause", "resume", "stop", "catalog", "message"] as const),
  user_interact: Object.freeze(["ask", "reply", "forward"] as const),
  change_apply: Object.freeze(["prepare", "apply", "import", "status"] as const),
  verification_run: Object.freeze(["run", "stop", "status"] as const),
  result_submit: Object.freeze(["research", "verdict"] as const),
  workflow_manage: Object.freeze(["status", "advance", "finish", "repair", "check-decision", "report", "escalate", "close", "delivery-check"] as const),
});
export type CoreTool = keyof typeof CORE_TOOL_ACTIONS;
export type CoreAction<T extends CoreTool> = (typeof CORE_TOOL_ACTIONS)[T][number];

type Grants = { readonly [T in CoreTool]?: readonly CoreAction<T>[] };
const all = <T extends CoreTool>(tool: T) => CORE_TOOL_ACTIONS[tool];
const REQUIREMENT_READ_ONLY = ["read", "diff", "metadata"] as const;
const MATRIX: Readonly<Record<CoreRole, Grants>> = Object.freeze({
  main: {
    project_manage: all("project_manage"), knowledge_query: all("knowledge_query"), requirement_manage: all("requirement_manage"),
    user_interact: all("user_interact"), agent_manage: all("agent_manage"), workflow_manage: all("workflow_manage").filter((action) => action !== "report" && action !== "escalate"),
  },
  pm: {
    knowledge_query: all("knowledge_query"), requirement_manage: REQUIREMENT_READ_ONLY, plan_manage: all("plan_manage"),
    agent_manage: all("agent_manage").filter((action) => action !== "message"), user_interact: all("user_interact"),
    verification_run: all("verification_run"), workflow_manage: all("workflow_manage").filter((action) => action !== "close"),
  },
  explore: { knowledge_query: all("knowledge_query"), result_submit: ["research"] },
  worker: { knowledge_query: all("knowledge_query"), change_apply: all("change_apply"), verification_run: all("verification_run"), result_submit: ["verdict"] },
  reviewer: {
    knowledge_query: all("knowledge_query"), requirement_manage: REQUIREMENT_READ_ONLY, plan_manage: ["read"],
    verification_run: all("verification_run"), result_submit: ["verdict"],
  },
  qa: { requirement_manage: REQUIREMENT_READ_ONLY, verification_run: all("verification_run"), result_submit: ["verdict"] },
});

function isCoreRole(value: unknown): value is CoreRole {
  return typeof value === "string" && (CORE_ROLES as readonly string[]).includes(value);
}
function isCoreTool(value: unknown): value is CoreTool {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CORE_TOOL_ACTIONS, value);
}

export function authorizeToolAction(role: unknown, tool: unknown, action: unknown): boolean {
  if (!isCoreRole(role) || !isCoreTool(tool) || typeof action !== "string") return false;
  const granted = MATRIX[role][tool] as readonly string[] | undefined;
  return granted !== undefined && granted.includes(action);
}

export function toolActionsForRole(role: CoreRole): { [T in CoreTool]?: string[] } {
  if (!isCoreRole(role)) throw new Error(`未知职责: ${String(role)}`);
  const result: { [T in CoreTool]?: string[] } = {};
  for (const [tool, actions] of Object.entries(MATRIX[role])) result[tool as CoreTool] = [...(actions as readonly string[])];
  return result;
}

export type ManagedWritePathClass = "code" | "prod_archive" | "git_metadata" | "agent_definition" | "project_conventions" | "outside";

export function classifyManagedWritePath(repoRelativePath: string): ManagedWritePathClass {
  if (repoRelativePath === "" || repoRelativePath.includes("\\") || repoRelativePath.includes("\u0000") || posix.isAbsolute(repoRelativePath)) return "outside";
  const normalized = posix.normalize(repoRelativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return "outside";
  const parts = normalized.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) return "git_metadata";
  const [first, second] = parts.map((part) => part.toLowerCase());
  const [archiveFirst, archiveSecond] = PROD_ARCHIVE_DIRECTORY.split("/");
  if (first === archiveFirst && second === archiveSecond) return "prod_archive";
  if (first === ".pi" && (second === "agents" || second === "skills")) return "agent_definition";
  // 项目规范只能经用户在界面确认后由主会话改；文件系统可能不区分大小写，按小写比较
  if (parts.length === 1 && first === "agents.md") return "project_conventions";
  return "code";
}

export function writePathAllowed(repoRelativePath: string): boolean {
  return classifyManagedWritePath(repoRelativePath) === "code";
}
