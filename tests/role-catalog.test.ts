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
      "pi_company_requirement_manage", "pi_company_spec_change", "pi_company_user_interact", "pi_company_verification_run", "pi_company_workflow_manage"]);
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
