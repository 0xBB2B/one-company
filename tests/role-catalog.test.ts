import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { loadRoleRules } from "../runtime/package-rules.ts";
import { AGENT_ROLES, defaultRoleDir, loadRoleCatalog, readRoleDefinition } from "../runtime/roles.ts";
import { authorizeToolAction, CORE_TOOL_ACTIONS } from "../runtime/core-permissions.ts";
import type { CoreTool } from "../runtime/core-permissions.ts";
import { coreToolName, ROLE_HOST_TOOLS } from "../runtime/role-tools.ts";

const tempRoots: string[] = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "role-catalog-"));
  tempRoots.push(dir);
  return dir;
}

async function writeRole(dir: string, name: string, frontmatter: string, body = "正文"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  await writeFile(path, `---\n${frontmatter}\n---\n${body}\n`);
  return path;
}

describe("内置默认团队", () => {
  test("安装资源恰好提供 explore、worker、reviewer、qa、prototype 五个职责定义，都不写模型和思考", async () => {
    const files = (await readdir(defaultRoleDir())).filter((name) => name.endsWith(".md")).sort();
    expect(files).toEqual(["explore.md", "prototype.md", "qa.md", "reviewer.md", "worker.md"]);
    const { roles } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: "/nonexistent/u", projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: false });
    expect(roles.map((entry) => entry.name).sort()).toEqual(["explore", "prototype", "qa", "reviewer", "worker"]);
    for (const role of ["explore", "worker", "reviewer", "qa", "prototype"]) {
      const entry = roles.find((candidate) => candidate.name === role);
      expect(entry?.available, entry?.reason).toBe(true);
      expect(entry?.definition?.role).toBe(role);
      expect(entry?.definition?.model).toBeUndefined();
      expect(entry?.definition?.thinking).toBeUndefined();
    }
  });

  test("prototype 内置定义正文为空，描述写明只能由主窗口派出，不写模型和思考", async () => {
    const definition = await readRoleDefinition(join(defaultRoleDir(), "prototype.md"), parseFrontmatter);
    expect(definition.role).toBe("prototype");
    expect(definition.body).toBe("");
    expect(definition.description).toBe("只能由主窗口派出，在澄清阶段出界面原型（单个 HTML）。");
    expect(definition.model).toBeUndefined();
    expect(definition.thinking).toBeUndefined();
  });

  test("worker 规矩不含说明注释与章节编号，reviewer 规矩核对 worker 定义的规范而不核对说明注释；五个职责规矩都不提 spec", async () => {
    expect(loadRoleRules("worker")).not.toContain("说明注释");
    expect(loadRoleRules("worker")).not.toContain("章节编号");
    expect(loadRoleRules("reviewer")).toContain("核对 worker 定义的规范");
    expect(loadRoleRules("reviewer")).not.toContain("核对说明注释");
    for (const role of AGENT_ROLES) expect(loadRoleRules(role)).not.toMatch(/\bspec\b|spec_change|规则候选/);
  });

  test("M9：reviewer 逐条核对需求里「不做、不改」的边界并在结论里写明，QA 凭审查结论判断这类边界", async () => {
    const body = (name: string) => loadRoleRules(name);
    expect(body("reviewer")).toMatch(/核对需求边界[\s\S]*「不做、不改」[\s\S]*违反列为阻塞[\s\S]*summary 逐条写明这些边界的核对结果/);
    expect(body("qa")).toContain("审查已覆盖的不标未验证，审查没提到的才标未验证");
  });
  test("M8H-AC1：PM 角色说明写明提出或修改计划前先查一次角色目录", async () => {
    expect(loadRoleRules("pm")).toContain("每次提出或修改计划前，先用 one_company_agent_manage action=catalog 查一次可用角色定义");
  });

  test("M8D2-AC1：角色说明不重复共享规范里的搜索范围", async () => {
    for (const name of ["worker", "reviewer", "qa", "explore", "pm", "prototype"] as const) expect(loadRoleRules(name)).not.toContain("被 Git 忽略");
    expect(await readFile(join(defaultRoleDir(), "..", "shared", "03-search-scope.md"), "utf8")).toContain("被 Git 忽略");
  });
  test("M8B-AC4：主会话规则含规范与需求的分流，worker 遵守、reviewer 按项目规范把关、PM 不与之冲突，都不能改 AGENTS.md", async () => {
    const body = (name: string) => loadRoleRules(name);
    const main = await readFile(join(defaultRoleDir(), "..", "rules", "01-main-session.md"), "utf8");
    expect(main).toMatch(/规范与需求分流[\s\S]*长期遵守的约定[\s\S]*conventions-update[\s\S]*用户确认[\s\S]*这次要做成的行为或功能写进需求草稿[\s\S]*两样都有就拆开/);
    expect(main).toContain("不要用 write、edit 或命令直接改 AGENTS.md");
    expect(main).toMatch(/status=written[\s\S]*status=cancelled[\s\S]*status=revise，feedback 是用户的原话/);
    expect(main).toContain("程序会拒绝 write 与 edit");
    expect(main).not.toContain("conventionsNotice");
    expect(body("worker")).toMatch(/任务说明里有项目规范时，改动必须遵守[\s\S]*AGENTS\.md 不能改/);
    expect(body("reviewer")).toMatch(/核对项目规范[\s\S]*违反其中任何一条都列为阻塞[\s\S]*summary 写明规范的核对结果/);
    expect(body("pm")).toContain("任务说明里有项目规范时，计划与各任务的目标、通过条件不得与之冲突");
  });

  test("M8L-AC4：PM 角色说明写明计划被拒后按原因修改重交一次、仍被拒就停下等用户；主会话规则写明打开事项后先分析再用 panel-item 问答窗口给建议、决定类用固定选项登记", async () => {
    const pm = loadRoleRules("pm");
    expect(pm).toMatch(/计划提交（propose、update、confirm）被拒时，先读清拒绝原因，按原因修改后重新提交一次[\s\S]*仍被拒时停下/);
    const main = await readFile(join(defaultRoleDir(), "..", "rules", "01-main-session.md"), "utf8");
    expect(main).toMatch(/先查运行记录、需求等把原因弄清，再用 `one_company_user_interact` purpose=panel-item[\s\S]*选项文字须用卡片写明的固定文字[\s\S]*purpose=adjudicate 登记[\s\S]*回答只是给你的指示/);
  });

  test("M9：主会话规则写明测试或验收是否正式通过以需求的验收记录为依据并写出处，自己临时跑的测试不算正式通过", async () => {
    const main = await readFile(join(defaultRoleDir(), "..", "rules", "01-main-session.md"), "utf8");
    expect(main).toMatch(/是否正式通过时，以需求的验收记录为依据[\s\S]*docs\/prod 归档里的验收记录[\s\S]*写明出处[\s\S]*临时跑的测试[\s\S]*不能称为正式通过/);
  });

  test("默认 worker 按 TDD 先红后绿并提交两次运行，PM 不把测试拆成单独任务，reviewer 查看引用记录核对红绿", async () => {
    const body = (name: string) => loadRoleRules(name);
    expect(body("worker")).toMatch(/先写测试[\s\S]*确认新测试失败（红）[\s\S]*再写实现[\s\S]*全部通过（绿）[\s\S]*同时列出红、绿两次运行/);
    expect(body("worker")).toContain("只为本来就正确的已有行为补回归测试（测试写好即通过，没有红阶段），在 summary 写明不适用及理由，不列为未验证问题");
    expect(body("pm")).toContain("实现任务的 writePaths 同时包含覆盖它的测试文件，由同一个 worker 先写测试再实现，不把测试单独拆成任务");
    expect(body("pm")).toMatch(/自己处理不了[\s\S]*action=escalate 带 taskId 与 note[\s\S]*交用户裁决/);
    expect(body("pm")).toContain("每个任务的通过条件不超过 8 条、每次派工的轮数不超过 100；超过的任务登记后停在待用户裁决");
    expect(body("reviewer")).toContain("先按任务说明里的 git diff 命令查看本次改动，分清哪些定义是本次新增或修改的");
    expect(body("reviewer")).toMatch(/核对先红后绿[\s\S]*action=status 查看 worker 提交引用的验证记录[\s\S]*没有红的记录[\s\S]*列为阻塞/);
    expect(body("reviewer")).toContain("红绿可以出现在同一任务的任意一次尝试里；返修改动了可测行为时，这次返修须有新的红");
  });
});

describe("定义格式", () => {
  test("合法定义解析 name/description/role 及可选 model、thinking、mcp、skills", async () => {
    const dir = await tempDir();
    const path = await writeRole(dir, "ui-designer",
      "name: ui-designer\ndescription: 界面设计与实现\nrole: worker\nmodel: openai/gpt-x\nthinking: high\nmcp: [figma]\nskills: [ui-review]");
    expect(await readRoleDefinition(path, parseFrontmatter)).toEqual({
      name: "ui-designer", description: "界面设计与实现", role: "worker", model: "openai/gpt-x", thinking: "high", mcp: ["figma"], skills: ["ui-review"], body: "正文",
    });
  });

  test.each([
    ["tools 字段", "name: w\ndescription: d\nrole: worker\ntools: [bash]"],
    ["旧 kind 字段", "name: w\ndescription: d\nrole: worker\nkind: work"],
    ["main 职责", "name: w\ndescription: d\nrole: main"],
    ["planner 职责", "name: w\ndescription: d\nrole: planner"],
    ["缺少 role", "name: w\ndescription: d"],
    ["缺少 description", "name: w\nrole: worker"],
    ["name 含大写", "name: W\ndescription: d\nrole: worker"],
    ["model 以斜杠结尾", "name: w\ndescription: d\nrole: worker\nmodel: gpt/"],
    ["thinking 非法", "name: w\ndescription: d\nrole: worker\nthinking: extreme"],
    ["mcp 不是数组", "name: w\ndescription: d\nrole: worker\nmcp: figma"],
    ["skills 重复", "name: w\ndescription: d\nrole: worker\nskills: [a, a]"],
  ])("拒绝%s", async (_label, frontmatter) => {
    const dir = await tempDir();
    await expect(readRoleDefinition(await writeRole(dir, "w", frontmatter), parseFrontmatter)).rejects.toThrow();
  });

  test("description 以码点计，1024 通过、1025 拒绝", async () => {
    const dir = await tempDir();
    const ok = await writeRole(dir, "a", `name: a\ndescription: ${"界".repeat(1024)}\nrole: worker`);
    const over = await writeRole(dir, "b", `name: b\ndescription: ${"界".repeat(1025)}\nrole: worker`);
    expect((await readRoleDefinition(ok, parseFrontmatter)).description).toHaveLength(1024);
    await expect(readRoleDefinition(over, parseFrontmatter)).rejects.toThrow("1024");
  });
});

describe("分层加载", () => {
  test("同名定义按项目 > 用户 > 内置生效；项目未受信任时项目层不生效", async () => {
    const root = await tempDir();
    const defaultDir = join(root, "d"), userDir = join(root, "u"), projectDir = join(root, "p");
    await writeRole(defaultDir, "worker", "name: worker\ndescription: 内置\nrole: worker");
    await writeRole(userDir, "worker", "name: worker\ndescription: 用户\nrole: worker");
    await writeRole(projectDir, "worker", "name: worker\ndescription: 项目\nrole: worker");
    const trusted = await loadRoleCatalog({ defaultDir, userDir, projectDir, parseFrontmatter, projectTrusted: true });
    expect(trusted.roles.find((entry) => entry.name === "worker")?.definition?.description).toBe("项目");
    const untrusted = await loadRoleCatalog({ defaultDir, userDir, projectDir, parseFrontmatter, projectTrusted: false });
    expect(untrusted.roles.find((entry) => entry.name === "worker")?.definition?.description).toBe("用户");
    expect(untrusted.problems.map((problem) => problem.source)).toEqual(["project"]);
  });

  test("无效定义标为不可用并给出原因，目录缺失正常", async () => {
    const root = await tempDir();
    await writeRole(join(root, "u"), "bad", "name: bad\ndescription: d\nrole: worker\ntools: [bash]");
    const { roles, problems } = await loadRoleCatalog({ defaultDir: join(root, "missing"), userDir: join(root, "u"), projectDir: join(root, "p"), parseFrontmatter, projectTrusted: true });
    expect(roles).toMatchObject([{ name: "bad", available: false }]);
    expect(roles[0]?.reason).toContain("tools");
    expect(problems).toEqual([]);
  });
});

describe("按职责生成的工具集", () => {
  const grantedTools = (role: string) => (Object.keys(CORE_TOOL_ACTIONS) as CoreTool[])
    .filter((tool) => CORE_TOOL_ACTIONS[tool].some((action) => authorizeToolAction(role, tool, action)));
  test("核心工具集合由权限矩阵生成并统一加前缀", () => {
    expect(grantedTools("pm").map(coreToolName).sort()).toEqual(["one_company_agent_manage", "one_company_knowledge_query", "one_company_plan_manage",
      "one_company_requirement_manage", "one_company_user_interact", "one_company_verification_run", "one_company_workflow_manage"]);
    expect(grantedTools("explore").sort()).toEqual(["knowledge_query", "result_submit"]);
    expect(grantedTools("prototype").sort()).toEqual(["knowledge_query", "result_submit"]);
    expect(grantedTools("qa").sort()).toEqual(["requirement_manage", "result_submit", "verification_run"]);
  });

  test("任何职责都没有 bash、write、edit；qa 没有宿主读取工具，explore 只有本地只读", () => {
    for (const role of AGENT_ROLES) for (const tool of ["bash", "write", "edit"]) expect(ROLE_HOST_TOOLS[role]).not.toContain(tool);
    expect(ROLE_HOST_TOOLS.qa).toEqual([]);
    expect([...ROLE_HOST_TOOLS.explore]).toEqual(["read", "grep", "find", "ls"]);
    expect([...ROLE_HOST_TOOLS.prototype]).toEqual(["read", "grep", "find", "ls"]);
    for (const role of ["pm", "worker", "reviewer"] as const) expect([...ROLE_HOST_TOOLS[role]]).toEqual(["read", "grep", "find", "ls"]);
  });
});

describe("覆盖与导入规则", () => {
  const load = (userDir: string, projectDir: string, projectTrusted = true) =>
    loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir, projectDir, parseFrontmatter, projectTrusted });

  test("同名按项目 > 用户 > 内置覆盖，并标出被覆盖的来源", async () => {
    const root = await tempDir();
    await writeRole(join(root, "u"), "worker", "name: worker\ndescription: 用户 worker\nrole: worker");
    await writeRole(join(root, "p"), "worker", "name: worker\ndescription: 项目 worker\nrole: worker");
    const worker = (await load(join(root, "u"), join(root, "p"))).roles.find((role) => role.name === "worker")!;
    expect(worker).toMatchObject({ source: "project", overrides: ["default", "user"], definition: { description: "项目 worker" } });
    const untrusted = (await load(join(root, "u"), join(root, "p"), false)).roles.find((role) => role.name === "worker")!;
    expect(untrusted).toMatchObject({ source: "user", overrides: ["default"] });
  });

  test("缺 role 的其他宿主定义不导入也不破坏默认团队；无效定义不顶掉下层有效定义", async () => {
    const root = await tempDir();
    await writeRole(join(root, "u"), "worker", "name: worker\ndescription: 其他宿主的 worker");
    await writeRole(join(root, "u"), "helper", "name: helper\ndescription: 其他宿主的 helper");
    await writeRole(join(root, "p"), "reviewer", "name: reviewer\ndescription: 坏定义\nrole: reviewer\nthinking: extreme");
    const catalog = await load(join(root, "u"), join(root, "p"));
    expect(catalog.roles.find((role) => role.name === "worker")).toMatchObject({ source: "default", available: true });
    expect(catalog.roles.find((role) => role.name === "helper")).toBeUndefined();
    expect(catalog.roles.find((role) => role.name === "reviewer")).toMatchObject({ source: "default", available: true });
    expect(catalog.problems.map((problem) => problem.reason).join("\n")).toMatch(/缺少 role[\s\S]*未覆盖default层的 reviewer/u);
  });

  const RETIRED = "已不再使用定义文件，模型和思考等级改在「模型」里";

  test.each(["pm", "interpreter", "draft-verifier"])("用户层 role 写 %s 的定义文件不生效、不进角色目录，问题里记一条固定原因", async (role) => {
    const root = await tempDir();
    const path = await writeRole(join(root, "u"), role, `name: ${role}\ndescription: 旧定义\nrole: ${role}\nmodel: 5x/gpt-6-luna\nthinking: low`);
    const { roles, problems } = await load(join(root, "u"), join(root, "p"));
    expect(roles.map((entry) => entry.name).sort()).toEqual(["explore", "prototype", "qa", "reviewer", "worker"]);
    expect(problems.filter((problem) => problem.reason === RETIRED)).toMatchObject([{ source: "user", dir: path }]);
  });

  test("项目层 role 写 pm 的定义文件，项目受信任时同样不生效并记一条问题", async () => {
    const root = await tempDir();
    const path = await writeRole(join(root, "p"), "pm", "name: pm\ndescription: 旧定义\nrole: pm");
    const { roles, problems } = await load(join(root, "u"), join(root, "p"));
    expect(roles.find((entry) => entry.name === "pm")).toBeUndefined();
    expect(problems.filter((problem) => problem.reason === RETIRED)).toMatchObject([{ source: "project", dir: path }]);
  });

  test("其他名字声明 role 为 pm 或内部角色时也不生效，且不顶掉同名的有效定义", async () => {
    const root = await tempDir();
    await writeRole(join(root, "u"), "boss", "name: boss\ndescription: 第二个 PM\nrole: pm");
    await writeRole(join(root, "u"), "worker", "name: worker\ndescription: 冒名\nrole: interpreter");
    const { roles, problems } = await load(join(root, "u"), join(root, "p"));
    expect(roles.find((entry) => entry.name === "boss")).toBeUndefined();
    expect(roles.find((entry) => entry.name === "worker")).toMatchObject({ source: "default", available: true, definition: { role: "worker" } });
    expect(problems.filter((problem) => problem.reason === RETIRED)).toHaveLength(2);
  });
});

test("M8D-AC8：写错的定义带出错字段、文件里的写法和给人看的原因", async () => {
  const dir = await tempDir();
  await writeRole(dir, "broken", "name: broken\ndescription: d\nrole: worker\nthinking: extreme");
  await writeRole(dir, "badmodel", "name: badmodel\ndescription: d\nrole: worker\nmodel: gpt/");
  const { roles } = await loadRoleCatalog({ defaultDir: "/nonexistent/d", userDir: dir, projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: false });
  expect(roles.find((entry) => entry.name === "broken")!.problem).toEqual({ field: "thinking", value: "extreme", display: "thinking 只能是 off、minimal、low、medium、high、xhigh、max" });
  expect(roles.find((entry) => entry.name === "badmodel")!.problem).toEqual({ field: "model", value: "gpt/", display: "model 要写成模型名或 provider/id，例如 gpt-6-luna 或 5x/gpt-6-luna" });
});
