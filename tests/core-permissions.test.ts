import { expect, test } from "vitest";
import type { TSchema } from "typebox";
import { CORE_ROLES, CORE_TOOL_ACTIONS, authorizeToolAction, classifyManagedWritePath,
  writePathAllowed } from "../runtime/core-permissions.ts";
import type { CoreRole, CoreTool } from "../runtime/core-permissions.ts";
import { REQUIREMENT_MANAGE_PARAMETERS } from "../runtime/requirement-manage-tool.ts";
import { USER_INTERACT_PARAMETERS } from "../runtime/user-interact-tool.ts";
import { KnowledgeToolSchema } from "../runtime/knowledge-query-tool.ts";
import { PROJECT_MANAGE_PARAMETERS } from "../runtime/project-manage-tool.ts";
import { REQUIREMENT_READ_PARAMETERS } from "../runtime/requirement-read-tool.ts";
import { CHANGE_APPLY_PARAMETERS } from "../runtime/change-apply.ts";
import { VERIFICATION_RUN_PARAMETERS } from "../runtime/verification-run.ts";
import { RESULT_SUBMIT_PARAMETERS } from "../runtime/result-submit.ts";
import { WORKFLOW_MANAGE_PARAMETERS } from "../runtime/workflow-manage.ts";
import { MAIN_AGENT_MANAGE_PARAMETERS } from "../extensions/agent-manage.ts";

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
    if (properties?.request) visit(properties.request);
  };
  visit(schema);
  return [...found].sort();
}

test("固定七类职责与10个核心工具，action 枚举固定", () => {
  expect([...CORE_ROLES]).toEqual(["main", "pm", "explore", "worker", "reviewer", "qa", "prototype"]);
  expect(Object.keys(CORE_TOOL_ACTIONS)).toEqual(["project_manage", "knowledge_query", "requirement_manage", "plan_manage",
    "agent_manage", "user_interact", "change_apply", "verification_run", "result_submit", "workflow_manage"]);
  expect(CORE_TOOL_ACTIONS.project_manage).toEqual(["init", "status", "refresh", "recovery-check", "backup", "restore",
    "workspace-prepare", "workspace-recycle", "conventions-update"]);
  expect(CORE_TOOL_ACTIONS.requirement_manage).toEqual(["create", "updateDraft", "confirmUpdate", "read", "diff", "next", "metadata", "list"]);
  expect(CORE_TOOL_ACTIONS.plan_manage).toEqual(["propose", "read", "update", "confirm", "assess-update"]);
  expect(CORE_TOOL_ACTIONS.workflow_manage).toEqual(["status", "advance", "finish", "check-decision", "report", "escalate", "close", "delivery-check"]);
  expect(Object.isFrozen(CORE_TOOL_ACTIONS)).toBe(true);
});

const granted = (role: CoreRole, tool: CoreTool) => CORE_TOOL_ACTIONS[tool].filter((action) => authorizeToolAction(role, tool, action));

test("七角色工具集合逐项固定", () => {
  const tools = (role: CoreRole) => (Object.keys(CORE_TOOL_ACTIONS) as CoreTool[]).filter((tool) => granted(role, tool).length > 0).sort();
  expect(tools("main")).toEqual(["agent_manage", "knowledge_query", "project_manage", "requirement_manage", "user_interact", "workflow_manage"]);
  expect(tools("pm")).toEqual(["agent_manage", "knowledge_query", "plan_manage", "requirement_manage", "user_interact",
    "verification_run", "workflow_manage"]);
  expect(tools("explore")).toEqual(["knowledge_query", "result_submit"]);
  expect(tools("prototype")).toEqual(["knowledge_query", "result_submit"]);
  expect(tools("worker")).toEqual(["change_apply", "knowledge_query", "result_submit", "verification_run"]);
  expect(tools("reviewer")).toEqual(["knowledge_query", "plan_manage", "requirement_manage", "result_submit", "verification_run"]);
  expect(tools("qa")).toEqual(["requirement_manage", "result_submit", "verification_run"]);
});

test("action 级上限收窄：分支工作区只归 main，PM/reviewer/QA 只读需求，explore 只交 research", () => {
  for (const action of ["workspace-prepare", "workspace-recycle", "backup", "restore", "recovery-check"]) {
    expect(authorizeToolAction("main", "project_manage", action)).toBe(true);
    for (const role of ["pm", "explore", "worker", "reviewer", "qa"]) expect(authorizeToolAction(role, "project_manage", action)).toBe(false);
  }
  for (const role of ["pm", "reviewer", "qa"]) {
    for (const action of ["read", "diff", "next", "metadata"]) expect(authorizeToolAction(role, "requirement_manage", action)).toBe(true);
    for (const action of ["create", "updateDraft", "confirmUpdate"]) expect(authorizeToolAction(role, "requirement_manage", action)).toBe(false);
  }
  expect(granted("main", "requirement_manage")).toEqual(CORE_TOOL_ACTIONS.requirement_manage);
  expect(granted("explore", "knowledge_query")).toEqual(["exact", "search", "facts", "next"]);
  expect(granted("explore", "result_submit")).toEqual(["research"]);
  expect(authorizeToolAction("explore", "result_submit", "verdict")).toBe(false);
  for (const role of ["worker", "reviewer", "qa"]) {
    expect(authorizeToolAction(role, "result_submit", "verdict")).toBe(true);
    expect(authorizeToolAction(role, "result_submit", "research")).toBe(false);
  }
  expect(granted("reviewer", "plan_manage")).toEqual(["read"]);
  expect(granted("pm", "workflow_manage")).toEqual(["status", "advance", "finish", "check-decision", "report", "escalate", "delivery-check"]);
  expect(granted("main", "workflow_manage")).toEqual(["status", "advance", "finish", "check-decision", "close", "delivery-check"]);
  for (const role of CORE_ROLES) expect(authorizeToolAction(role, "workflow_manage", "init")).toBe(false);
  for (const role of CORE_ROLES) if (role !== "worker") expect(authorizeToolAction(role, "change_apply", "apply")).toBe(false);
  for (const role of CORE_ROLES) if (role !== "main" && role !== "pm") expect(authorizeToolAction(role, "agent_manage", "dispatch")).toBe(false);
  expect(authorizeToolAction("main", "agent_manage", "message")).toBe(true);
  for (const role of CORE_ROLES) if (role !== "main") expect(authorizeToolAction(role, "agent_manage", "message")).toBe(false);
  expect(granted("main", "agent_manage")).toEqual(["dispatch", "status", "pause", "resume", "stop", "message"]);
  expect(granted("pm", "user_interact")).toEqual(["ask"]);
});

test("自报或伪造的职责、工具与 action 一律拒绝，不因大小写、空白或专业名称扩权", () => {
  for (const role of ["planner", "PM", "Main", " main", "worker\n", "security-expert", "", undefined, null, 1, {}, ["main"]]) {
    expect(authorizeToolAction(role, "knowledge_query", "search")).toBe(false);
  }
  for (const tool of ["bash", "write", "edit", "mcp", "one_company_git_commit", "knowledge_query ", "", undefined]) {
    expect(authorizeToolAction("main", tool, "search")).toBe(false);
  }
  for (const action of ["run", "preview", "search ", "", undefined, null, ["search"]]) {
    expect(authorizeToolAction("main", "knowledge_query", action)).toBe(false);
  }
  expect(authorizeToolAction("__proto__", "knowledge_query", "search")).toBe(false);
  expect(authorizeToolAction("main", "constructor", "search")).toBe(false);
  expect(authorizeToolAction("main", "knowledge_query", "toString")).toBe(false);
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
  within(MAIN_AGENT_MANAGE_PARAMETERS, "agent_manage");
});

test("受控写入的资源分类：change_apply 可写代码、测试、配置与 docs/spec 等普通文件，不写 docs/prod、.git、.pi/agents、.pi/skills", () => {
  expect(classifyManagedWritePath("src/a.ts")).toBe("code");
  expect(classifyManagedWritePath("docs/specs/a.rules.json")).toBe("code");
  expect(classifyManagedWritePath("docs/spec/player/jump.rules.json")).toBe("code");
  expect(classifyManagedWritePath("docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.需求.md")).toBe("prod_archive");
  expect(classifyManagedWritePath("DOCS/PROD/x.md")).toBe("prod_archive");
  expect(classifyManagedWritePath(".git/HEAD")).toBe("git_metadata");
  expect(classifyManagedWritePath("sub/.git")).toBe("git_metadata");
  expect(classifyManagedWritePath("src/../docs/prod/x.md")).toBe("prod_archive");
  for (const outside of ["../x.ts", "/abs/x.ts", "", "a\\b.ts", "a\u0000b"]) expect(classifyManagedWritePath(outside)).toBe("outside");
  for (const root of [".", "./", "src/../", "a/b/../../"]) {
    expect(classifyManagedWritePath(root), root).toBe("outside");
    expect(writePathAllowed(root), root).toBe(false);
  }
  for (const dir of ["src/", "src"]) expect(classifyManagedWritePath(dir), dir).toBe("code");
  expect(writePathAllowed("src/a.ts")).toBe(true);
  expect(writePathAllowed("docs/spec/player/jump.rules.json")).toBe(true);
  expect(classifyManagedWritePath(".pi/agents/worker.md")).toBe("agent_definition");
  for (const conventions of ["AGENTS.md", "agents.md", "./AGENTS.md"]) expect(classifyManagedWritePath(conventions)).toBe("project_conventions");
  expect(writePathAllowed("AGENTS.md")).toBe(false);
  expect(classifyManagedWritePath("docs/AGENTS.md")).toBe("code");
  expect(classifyManagedWritePath(".PI/Agents/x.md")).toBe("agent_definition");
  for (const skill of [".pi/skills/requirement-doc/SKILL.md", ".PI/Skills/x/SKILL.md"]) expect(classifyManagedWritePath(skill)).toBe("agent_definition");
  for (const path of ["docs/prod/x.md", ".git/config", ".pi/agents/worker.md", ".pi/skills/requirement-doc/SKILL.md", "../x.ts", "/abs/x.ts"]) expect(writePathAllowed(path)).toBe(false);
  for (const settings of [".pi/settings.json", ".PI/Settings.json"]) {
    expect(classifyManagedWritePath(settings)).toBe("host_settings");
    expect(writePathAllowed(settings)).toBe(false);
  }
  expect(classifyManagedWritePath(".pi/other.json")).toBe("code");
  expect(writePathAllowed(".pi/other.json")).toBe(true);
});

test("已实现全部 action 的工具，schema 与核心表双向一致", () => {
  const exact = (schema: TSchema, tool: keyof typeof CORE_TOOL_ACTIONS) => expect(actionLiterals(schema)).toEqual([...CORE_TOOL_ACTIONS[tool]].sort());
  exact(REQUIREMENT_MANAGE_PARAMETERS, "requirement_manage");
  exact(USER_INTERACT_PARAMETERS, "user_interact");
  exact(CHANGE_APPLY_PARAMETERS, "change_apply");
  exact(VERIFICATION_RUN_PARAMETERS, "verification_run");
  exact(RESULT_SUBMIT_PARAMETERS, "result_submit");
  exact(WORKFLOW_MANAGE_PARAMETERS, "workflow_manage");
  exact(PROJECT_MANAGE_PARAMETERS, "project_manage");
});

test("prototype 只能交原型结果，没有写入和运行验证的权限", () => {
  expect(authorizeToolAction("prototype", "result_submit", "prototype")).toBe(true);
  expect(granted("prototype", "result_submit")).toEqual(["prototype"]);
  expect(granted("prototype", "knowledge_query")).toEqual(CORE_TOOL_ACTIONS.knowledge_query);
  expect(granted("prototype", "change_apply")).toEqual([]);
  expect(granted("prototype", "verification_run")).toEqual([]);
});
