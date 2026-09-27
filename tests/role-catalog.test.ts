import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENT_ROLES, defaultRoleDir, loadRoleCatalog, readRoleDefinition } from "../runtime/roles.ts";
import { coreToolName, coreToolsForRole, ROLE_HOST_TOOLS } from "../runtime/role-tools.ts";

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
  test("安装资源恰好提供 pm、explore、worker、reviewer、qa 五个定义，不含 planner", async () => {
    const files = (await readdir(defaultRoleDir())).filter((name) => name.endsWith(".md")).sort();
    expect(files).toEqual(["explore.md", "pm.md", "qa.md", "reviewer.md", "worker.md"]);
    const { roles } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: "/nonexistent/u", projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: false });
    for (const role of AGENT_ROLES) {
      const entry = roles.find((candidate) => candidate.name === role);
      expect(entry?.available, entry?.reason).toBe(true);
      expect(entry?.definition?.role).toBe(role);
      expect(entry?.definition?.model).toBeUndefined();
      expect(entry?.definition?.thinking).toBeUndefined();
      expect(entry?.definition?.body.trim().length).toBeGreaterThan(0);
    }
  });

  test("默认 worker 按 Go 官方库写法给新增或修改的定义写说明注释，reviewer 把缺失或不符列为阻塞；角色定义不再提 spec", async () => {
    const { roles } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: "/nonexistent/u", projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: false });
    const body = (name: string) => roles.find((candidate) => candidate.name === name)!.definition!.body;
    expect(body("worker")).toMatch(/新增或修改的每个函数、方法、类、类型\/接口与导出常量写说明注释[\s\S]*参照 Go 官方库[\s\S]*参数[\s\S]*返回值/);
    expect(body("worker")).not.toContain("注释默认不写");
    expect(body("reviewer")).toMatch(/核对说明注释[\s\S]*有副作用的写明副作用[\s\S]*没有副作用的不要求注明，未改动的旧定义不要求补写，只按上述要点核对，不追加其他写法要求（如函数返回值的单位、示例）；缺失或不符列为阻塞。结论 summary 写明说明注释的核对结果/);
    for (const role of AGENT_ROLES) expect(body(role)).not.toMatch(/\bspec\b|spec_change|规则候选/);
  });

  test("默认 worker 按 TDD 先红后绿并提交两次运行，PM 不把测试拆成单独任务，reviewer 查看引用记录核对红绿", async () => {
    const { roles } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: "/nonexistent/u", projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: false });
    const body = (name: string) => roles.find((candidate) => candidate.name === name)!.definition!.body;
    expect(body("worker")).toMatch(/先写测试[\s\S]*确认新测试失败（红）[\s\S]*再写实现[\s\S]*全部通过（绿）[\s\S]*同时列出红、绿两次运行/);
    expect(body("pm")).toContain("实现任务的 writePaths 同时包含覆盖它的测试文件，由同一个 worker 先写测试再实现，不把测试单独拆成任务");
    expect(body("reviewer")).toMatch(/核对先红后绿[\s\S]*action=status 查看 worker 提交引用的验证记录[\s\S]*没有红的记录[\s\S]*列为阻塞/);
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
    ["model 不是 provider/id", "name: w\ndescription: d\nrole: worker\nmodel: gpt"],
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
  test("核心工具集合由权限矩阵生成并统一加前缀", () => {
    expect(coreToolsForRole("pm").map(coreToolName).sort()).toEqual(["pi_company_agent_manage", "pi_company_knowledge_query", "pi_company_plan_manage",
      "pi_company_requirement_manage", "pi_company_user_interact", "pi_company_verification_run", "pi_company_workflow_manage"]);
    expect(coreToolsForRole("explore").sort()).toEqual(["knowledge_query", "result_submit"]);
    expect(coreToolsForRole("qa").sort()).toEqual(["requirement_manage", "result_submit", "verification_run"]);
  });

  test("任何职责都没有 bash、write、edit；qa 没有宿主读取工具，explore 只有本地只读", () => {
    for (const role of AGENT_ROLES) for (const tool of ["bash", "write", "edit"]) expect(ROLE_HOST_TOOLS[role]).not.toContain(tool);
    expect(ROLE_HOST_TOOLS.qa).toEqual([]);
    expect([...ROLE_HOST_TOOLS.explore]).toEqual(["read", "grep", "find", "ls"]);
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

  test("pm 职责唯一：其他名字声明 role: pm 被拒", async () => {
    const root = await tempDir();
    await writeRole(join(root, "u"), "boss", "name: boss\ndescription: 第二个 PM\nrole: pm");
    const boss = (await load(join(root, "u"), join(root, "p"))).roles.find((role) => role.name === "boss")!;
    expect(boss).toMatchObject({ available: false });
    expect(boss.reason).toContain("pm 职责只能由名为 pm 的定义承担");
  });
});
