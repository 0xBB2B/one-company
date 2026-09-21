import { expect, test } from "vitest";
import type { TSchema } from "typebox";
import { CORE_ROLES, CORE_TOOL_ACTIONS, authorizeToolAction, classifyManagedWritePath, toolActionsForRole,
  writePathAllowed } from "../runtime/core-permissions.ts";
import { REQUIREMENT_MANAGE_PARAMETERS } from "../runtime/requirement-manage-tool.ts";
import { USER_INTERACT_PARAMETERS } from "../runtime/user-interact-tool.ts";
import { KnowledgeToolSchema } from "../runtime/knowledge-query-tool.ts";
import { PROJECT_MANAGE_PARAMETERS } from "../runtime/project-manage-tool.ts";
import { REQUIREMENT_READ_PARAMETERS } from "../runtime/requirement-read-tool.ts";

function actionLiterals(schema: TSchema): string[] {
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (Array.isArray(value.anyOf)) value.anyOf.forEach(visit);
    const properties = value.properties as Record<string, Record<string, unknown>> | undefined;
    const action = properties?.action;
    if (action) {
      if (typeof action.const === "string") found.add(action.const);
      if (Array.isArray(action.enum)) for (const item of action.enum) found.add(String(item));
    }
    if (properties?.query) visit(properties.query);
  };
  visit(schema);
  return [...found].sort();
}

test("固定六类职责与11个核心工具，action 枚举与计划 §9.1 一致", () => {
  expect([...CORE_ROLES]).toEqual(["main", "pm", "explore", "worker", "reviewer", "qa"]);
  expect(Object.keys(CORE_TOOL_ACTIONS)).toEqual(["project_manage", "knowledge_query", "requirement_manage", "plan_manage",
    "agent_manage", "user_interact", "change_apply", "spec_change", "verification_run", "result_submit", "workflow_manage"]);
  expect(CORE_TOOL_ACTIONS.project_manage).toEqual(["init", "status", "refresh", "recovery-check", "backup", "restore",
    "workspace-prepare", "workspace-recycle"]);
  expect(CORE_TOOL_ACTIONS.requirement_manage).toEqual(["create", "updateDraft", "confirmUpdate", "read", "diff", "metadata"]);
  expect(CORE_TOOL_ACTIONS.plan_manage).toEqual(["propose", "read", "update", "confirm", "assess-update"]);
  expect(CORE_TOOL_ACTIONS.spec_change).toEqual(["propose", "validate", "publish"]);
  expect(CORE_TOOL_ACTIONS.workflow_manage).toEqual(["init", "status", "advance", "finish", "repair", "check-decision", "close",
    "delivery-check"]);
  expect(Object.isFrozen(CORE_TOOL_ACTIONS)).toBe(true);
});

test("六角色工具集合与计划 §9.2 逐项相等", () => {
  const tools = (role: (typeof CORE_ROLES)[number]) => Object.keys(toolActionsForRole(role)).sort();
  expect(tools("main")).toEqual(["agent_manage", "knowledge_query", "project_manage", "requirement_manage", "user_interact", "workflow_manage"]);
  expect(tools("pm")).toEqual(["agent_manage", "knowledge_query", "plan_manage", "requirement_manage", "spec_change", "user_interact",
    "verification_run", "workflow_manage"]);
  expect(tools("explore")).toEqual(["knowledge_query", "result_submit"]);
  expect(tools("worker")).toEqual(["change_apply", "knowledge_query", "result_submit", "verification_run"]);
  expect(tools("reviewer")).toEqual(["knowledge_query", "plan_manage", "requirement_manage", "result_submit", "verification_run"]);
  expect(tools("qa")).toEqual(["requirement_manage", "result_submit", "verification_run"]);
});

test("action 级上限按计划 §9.1/§9.3 收窄：分支工作区只归 main，PM/reviewer/QA 只读需求，explore 只交 research", () => {
  for (const action of ["workspace-prepare", "workspace-recycle", "backup", "restore", "recovery-check"]) {
    expect(authorizeToolAction("main", "project_manage", action)).toBe(true);
    for (const role of ["pm", "explore", "worker", "reviewer", "qa"]) expect(authorizeToolAction(role, "project_manage", action)).toBe(false);
  }
  for (const role of ["pm", "reviewer", "qa"]) {
    for (const action of ["read", "diff", "metadata"]) expect(authorizeToolAction(role, "requirement_manage", action)).toBe(true);
    for (const action of ["create", "updateDraft", "confirmUpdate"]) expect(authorizeToolAction(role, "requirement_manage", action)).toBe(false);
  }
  expect(toolActionsForRole("main").requirement_manage).toEqual(CORE_TOOL_ACTIONS.requirement_manage);
  expect(toolActionsForRole("explore")).toEqual({ knowledge_query: ["exact", "search", "facts"], result_submit: ["research"] });
  expect(authorizeToolAction("explore", "result_submit", "verdict")).toBe(false);
  for (const role of ["worker", "reviewer", "qa"]) {
    expect(authorizeToolAction(role, "result_submit", "verdict")).toBe(true);
    expect(authorizeToolAction(role, "result_submit", "research")).toBe(false);
  }
  expect(toolActionsForRole("reviewer").plan_manage).toEqual(["read"]);
  expect(toolActionsForRole("pm").workflow_manage).toEqual(["status", "advance", "finish", "repair", "check-decision", "close", "delivery-check"]);
  expect(authorizeToolAction("pm", "workflow_manage", "init")).toBe(false);
  for (const role of CORE_ROLES) if (role !== "worker") expect(authorizeToolAction(role, "change_apply", "apply")).toBe(false);
  for (const role of CORE_ROLES) if (role !== "pm") expect(authorizeToolAction(role, "spec_change", "publish")).toBe(false);
  for (const role of CORE_ROLES) if (role !== "main" && role !== "pm") expect(authorizeToolAction(role, "agent_manage", "dispatch")).toBe(false);
});

test("自报或伪造的职责、工具与 action 一律拒绝，不因大小写、空白或专业名称扩权", () => {
  for (const role of ["planner", "PM", "Main", " main", "worker\n", "security-expert", "", undefined, null, 1, {}, ["main"]]) {
    expect(authorizeToolAction(role, "knowledge_query", "search")).toBe(false);
  }
  for (const tool of ["bash", "write", "edit", "mcp", "pi_company_git_commit", "knowledge_query ", "", undefined]) {
    expect(authorizeToolAction("main", tool, "search")).toBe(false);
  }
  for (const action of ["run", "preview", "search ", "", undefined, null, ["search"]]) {
    expect(authorizeToolAction("main", "knowledge_query", action)).toBe(false);
  }
  expect(authorizeToolAction("__proto__", "knowledge_query", "search")).toBe(false);
  expect(authorizeToolAction("main", "constructor", "search")).toBe(false);
  expect(authorizeToolAction("main", "knowledge_query", "toString")).toBe(false);
  expect(() => toolActionsForRole("planner" as never)).toThrow();
});

test("已注册工具的 action 枚举都落在核心表内", () => {
  const within = (schema: TSchema, tool: keyof typeof CORE_TOOL_ACTIONS) => {
    const actions = actionLiterals(schema);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(CORE_TOOL_ACTIONS[tool]).toContain(action);
  };
  within(REQUIREMENT_MANAGE_PARAMETERS, "requirement_manage");
  within(REQUIREMENT_READ_PARAMETERS, "requirement_manage");
  within(USER_INTERACT_PARAMETERS, "user_interact");
  within(KnowledgeToolSchema, "knowledge_query");
  within(PROJECT_MANAGE_PARAMETERS, "project_manage");
});

test("受控写入的资源分类：change_apply 只写代码/测试/配置，spec_change 只写 docs/spec 规则文件", () => {
  expect(classifyManagedWritePath("src/a.ts")).toBe("code");
  expect(classifyManagedWritePath("docs/specs/a.rules.json")).toBe("code");
  expect(classifyManagedWritePath("docs/spec/player/jump.rules.json")).toBe("spec");
  expect(classifyManagedWritePath("docs/spec/schema.json")).toBe("spec");
  expect(classifyManagedWritePath("Docs/Spec/a.rules.json")).toBe("spec");
  expect(classifyManagedWritePath("docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.需求.md")).toBe("prod_archive");
  expect(classifyManagedWritePath("DOCS/PROD/x.md")).toBe("prod_archive");
  expect(classifyManagedWritePath(".git/HEAD")).toBe("git_metadata");
  expect(classifyManagedWritePath("sub/.git")).toBe("git_metadata");
  expect(classifyManagedWritePath("src/../docs/prod/x.md")).toBe("prod_archive");
  expect(classifyManagedWritePath("./docs/spec/x.rules.json")).toBe("spec");
  for (const outside of ["../x.ts", "/abs/x.ts", "", "a\\b.ts", "a\u0000b"]) expect(classifyManagedWritePath(outside)).toBe("outside");
  expect(writePathAllowed("change_apply", "src/a.ts")).toBe(true);
  for (const path of ["docs/spec/x.rules.json", "docs/prod/x.md", ".git/config", "../x.ts"]) expect(writePathAllowed("change_apply", path)).toBe(false);
  expect(writePathAllowed("spec_change", "docs/spec/player/jump.rules.json")).toBe(true);
  for (const path of ["docs/spec/schema.json", "docs/spec/notes.md", "src/a.ts", "docs/prod/x.md", "docs/spec/../../x.rules.json"]) {
    expect(writePathAllowed("spec_change", path)).toBe(false);
  }
});
