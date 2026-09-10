import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  defaultRoleDir,
  loadRoleCatalog,
  projectRoleDir,
  readRoleDefinition,
  roleToolAllowlist,
  userRoleDir,
} from "../runtime/roles.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type FrontmatterFields = {
  name?: string;
  description?: string;
  kind?: string;
  tools?: string | string[];
  skills?: boolean;
  context_files?: boolean;
  prompt_mode?: string;
};

function buildFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = [];
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`);
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.kind !== undefined) lines.push(`kind: ${fields.kind}`);
  if (fields.tools !== undefined) {
    const toolsValue = Array.isArray(fields.tools) ? `[${fields.tools.join(", ")}]` : fields.tools;
    lines.push(`tools: ${toolsValue}`);
  }
  if (fields.skills !== undefined) lines.push(`skills: ${fields.skills}`);
  if (fields.context_files !== undefined) lines.push(`context_files: ${fields.context_files}`);
  if (fields.prompt_mode !== undefined) lines.push(`prompt_mode: ${fields.prompt_mode}`);
  return lines.join("\n");
}

async function writeRoleFile(dir: string, name: string, fields: FrontmatterFields, body = "正文"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  await writeFile(path, `---\n${buildFrontmatter(fields)}\n---\n${body}\n`);
  return path;
}

async function writeRawRoleFile(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  await writeFile(path, content);
  return path;
}

const FULL_FIELDS: FrontmatterFields = {
  kind: "work",
  tools: ["read"],
  skills: true,
  context_files: true,
  prompt_mode: "append",
};

describe("loadRoleCatalog 三层合并", () => {
  test("同名角色按 项目 > 全局 > 包内默认 覆盖，三处独有角色均出现", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const defaultDir = join(root, "default");
    const userDir = join(root, "user");
    const projectDir = join(root, "project");

    await writeRoleFile(defaultDir, "worker", { ...FULL_FIELDS, name: "worker", description: "包内 worker" });
    await writeRoleFile(defaultDir, "requirement-agent", {
      ...FULL_FIELDS,
      name: "requirement-agent",
      description: "包内需求代理",
      kind: "manage",
    });
    await writeRoleFile(defaultDir, "only-default", {
      ...FULL_FIELDS,
      name: "only-default",
      description: "仅包内独有",
      kind: "plan",
    });

    await writeRoleFile(userDir, "worker", { ...FULL_FIELDS, name: "worker", description: "全局 worker" });
    await writeRoleFile(userDir, "only-user", { ...FULL_FIELDS, name: "only-user", description: "仅全局独有" });

    await writeRoleFile(projectDir, "worker", { ...FULL_FIELDS, name: "worker", description: "项目 worker" });
    await writeRoleFile(projectDir, "requirement-agent", {
      ...FULL_FIELDS,
      name: "requirement-agent",
      description: "项目需求代理覆盖",
      kind: "manage",
    });
    await writeRoleFile(projectDir, "only-project", {
      ...FULL_FIELDS,
      name: "only-project",
      description: "仅项目独有",
      kind: "review",
    });

    const { roles } = await loadRoleCatalog({ defaultDir, userDir, projectDir, parseFrontmatter, projectTrusted: true });

    const workers = roles.filter((r) => r.name === "worker");
    expect(workers.length).toBe(1);
    expect(workers[0]?.source).toBe("project");
    expect(workers[0]?.definition?.description).toBe("项目 worker");

    const requirementAgent = roles.find((r) => r.name === "requirement-agent");
    expect(requirementAgent?.source).toBe("project");
    expect(requirementAgent?.definition?.description).toBe("项目需求代理覆盖");

    expect(roles.find((r) => r.name === "only-default")?.source).toBe("default");
    expect(roles.find((r) => r.name === "only-user")?.source).toBe("user");
    expect(roles.find((r) => r.name === "only-project")?.source).toBe("project");
  });

  test("三层目录均不存在时视为空层，结果为空目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const { roles } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir: join(root, "no-user"),
      projectDir: join(root, "no-project"),
      parseFrontmatter,
      projectTrusted: true,
    });
    expect(roles).toEqual([]);
  });
});

describe("损坏或缺必需字段的角色定义", () => {
  test("项目层 reviewer 缺 kind 字段被标不可用，且不回退到全局合法定义", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const userDir = join(root, "user");
    const projectDir = join(root, "project");

    await writeRoleFile(userDir, "reviewer", {
      ...FULL_FIELDS,
      name: "reviewer",
      description: "全局 reviewer",
      kind: "review",
    });
    await writeRoleFile(projectDir, "reviewer", {
      name: "reviewer",
      description: "项目 reviewer 缺 kind",
      tools: ["read"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await writeRoleFile(projectDir, "worker", { ...FULL_FIELDS, name: "worker", description: "项目 worker" });

    const { roles } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir,
      projectDir,
      parseFrontmatter,
      projectTrusted: true,
    });

    const reviewer = roles.find((r) => r.name === "reviewer");
    expect(reviewer?.available).toBe(false);
    expect(reviewer?.source).toBe("project");
    expect(reviewer?.reason).toBeTruthy();
    expect(reviewer?.reason?.includes("kind")).toBe(true);

    const worker = roles.find((r) => r.name === "worker");
    expect(worker?.available).toBe(true);
  });

  test("项目层 reviewer 的 tools 非数组被标不可用", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    await writeRoleFile(projectDir, "reviewer", {
      name: "reviewer",
      description: "项目 reviewer",
      kind: "review",
      tools: "not-an-array",
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });

    const { roles } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir: join(root, "no-user"),
      projectDir,
      parseFrontmatter,
      projectTrusted: true,
    });

    const reviewer = roles.find((r) => r.name === "reviewer");
    expect(reviewer?.available).toBe(false);
    expect(reviewer?.reason?.includes("tools")).toBe(true);
  });

  test("frontmatter 无法解析的文件标不可用而不抛出，不影响其他角色", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    await writeRawRoleFile(projectDir, "broken", "---\nname: [unterminated\n---\n正文\n");
    await writeRoleFile(projectDir, "worker", { ...FULL_FIELDS, name: "worker", description: "项目 worker" });

    const { roles } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir: join(root, "no-user"),
      projectDir,
      parseFrontmatter,
      projectTrusted: true,
    });

    const broken = roles.find((r) => r.name === "broken");
    expect(broken?.available).toBe(false);
    const worker = roles.find((r) => r.name === "worker");
    expect(worker?.available).toBe(true);
  });
});

describe("readRoleDefinition 字段与类型校验", () => {
  test("合法定义解析出完整字段", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(
      dir,
      "worker",
      {
        name: "worker",
        description: "实现角色",
        kind: "work",
        tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
        skills: true,
        context_files: true,
        prompt_mode: "append",
      },
      "正文内容",
    );

    const definition = await readRoleDefinition(path, parseFrontmatter);
    expect(definition.name).toBe("worker");
    expect(definition.description).toBe("实现角色");
    expect(definition.kind).toBe("work");
    expect(definition.tools).toEqual(["read", "grep", "find", "ls", "edit", "write", "bash"]);
    expect(definition.skills).toBe(true);
    expect(definition.contextFiles).toBe(true);
    expect(definition.promptMode).toBe("append");
    expect(definition.body).toBe("正文内容");
  });

  test("缺 name 字段抛出含原因的错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "worker", {
      description: "实现角色",
      kind: "work",
      tools: ["read"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("缺 description 字段抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "worker", {
      name: "worker",
      kind: "work",
      tools: ["read"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("缺 kind 字段抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "worker", {
      name: "worker",
      description: "实现角色",
      tools: ["read"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("缺 tools 字段抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "worker", {
      name: "worker",
      description: "实现角色",
      kind: "work",
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("kind 不在合法枚举内抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "x", {
      name: "x",
      description: "d",
      kind: "invalid-kind",
      tools: ["read"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("tools 为字符串而非数组抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "x", {
      name: "x",
      description: "d",
      kind: "work",
      tools: "read,grep",
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("tools 数组含非字符串元素抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRawRoleFile(
      dir,
      "x",
      "---\nname: x\ndescription: d\nkind: work\ntools: [read, 5, write]\nskills: true\ncontext_files: true\nprompt_mode: append\n---\n正文\n",
    );
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });

  test("frontmatter 非法 YAML 抛出错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-def-"));
    tempRoots.push(dir);
    const path = await writeRawRoleFile(dir, "x", "---\nname: [unterminated\n---\n正文\n");
    await expect(readRoleDefinition(path, parseFrontmatter)).rejects.toThrow();
  });
});

describe("角色目录路径解析", () => {
  test("defaultRoleDir 指向包根 agents 目录", () => {
    expect(defaultRoleDir()).toBe(join(PACKAGE_ROOT, "agents"));
  });

  test("defaultRoleDir 目录下存在五份默认定义文件", async () => {
    const files = await readdir(defaultRoleDir());
    for (const name of ["planner", "worker", "reviewer", "acceptance", "requirement-agent"]) {
      expect(files).toContain(`${name}.md`);
    }
  });

  test("userRoleDir 拼接 agentDir 下的 agents 子目录", () => {
    expect(userRoleDir("/home/x/.pi")).toBe(join("/home/x/.pi", "agents"));
  });

  test("projectRoleDir 拼接 repoRoot 下的 .pi/agents", () => {
    expect(projectRoleDir("/repo")).toBe(join("/repo", ".pi", "agents"));
  });
});

describe("包内默认角色定义骨架", () => {
  const expected: Record<
    string,
    { kind: string; tools: string[]; skills: boolean; contextFiles: boolean; promptMode: string }
  > = {
    planner: {
      kind: "plan",
      tools: ["read", "grep", "find", "ls", "write", "edit", "bash"],
      skills: true,
      contextFiles: true,
      promptMode: "append",
    },
    worker: {
      kind: "work",
      tools: ["read", "bash", "grep", "find", "ls", "edit", "write", "structured_output"],
      skills: true,
      contextFiles: true,
      promptMode: "append",
    },
    reviewer: {
      kind: "review",
      tools: ["read", "bash", "grep", "find", "ls", "structured_output"],
      skills: true,
      contextFiles: true,
      promptMode: "append",
    },
    acceptance: { kind: "acceptance", tools: ["read", "bash", "write", "structured_output"], skills: false, contextFiles: false, promptMode: "append" },
    "requirement-agent": {
      kind: "manage",
      tools: ["read", "bash", "grep", "find", "ls", "edit", "write", "pi_company_workflow", "pi_company_agent", "pi_company_ask", "pi_company_propose_shape", "decision_record"],
      skills: true,
      contextFiles: true,
      promptMode: "append",
    },
  };

  test("五份默认定义均可用，来源为 default，frontmatter 与规范表一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const { roles } = await loadRoleCatalog({
      defaultDir: defaultRoleDir(),
      userDir: join(root, "no-user"),
      projectDir: join(root, "no-project"),
      parseFrontmatter,
      projectTrusted: true,
    });

    for (const [name, spec] of Object.entries(expected)) {
      const entry = roles.find((r) => r.name === name);
      expect(entry?.available).toBe(true);
      expect(entry?.source).toBe("default");
      expect(entry?.definition?.kind).toBe(spec.kind);
      expect(entry?.definition?.tools).toEqual(spec.tools);
      expect(entry?.definition?.skills).toBe(spec.skills);
      expect(entry?.definition?.contextFiles).toBe(spec.contextFiles);
      expect(entry?.definition?.promptMode).toBe(spec.promptMode);
    }
  });
});

describe("roleToolAllowlist", () => {
  test("返回角色定义声明的工具名数组", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(dir);
    const path = await writeRoleFile(dir, "worker", {
      name: "worker",
      description: "实现角色",
      kind: "work",
      tools: ["read", "grep", "bash"],
      skills: true,
      context_files: true,
      prompt_mode: "append",
    });
    const definition = await readRoleDefinition(path, parseFrontmatter);
    const entry = { name: "worker", source: "project" as const, path, available: true, definition };
    expect(roleToolAllowlist(entry)).toEqual(["read", "grep", "bash"]);
  });

  test("acceptance 默认角色工具集与成品一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const { roles } = await loadRoleCatalog({
      defaultDir: defaultRoleDir(),
      userDir: join(root, "no-user"),
      projectDir: join(root, "no-project"),
      parseFrontmatter,
      projectTrusted: true,
    });
    const acceptance = roles.find((r) => r.name === "acceptance");
    expect(roleToolAllowlist(acceptance!)).toEqual(["read", "bash", "write", "structured_output"]);
  });
});

describe("边界输入不静默降级", () => {
  test("skills 或 context_files 写成非布尔值时定义标不可用并说明字段", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    await writeRawRoleFile(
      projectDir,
      "acceptance",
      "---\nname: acceptance\ndescription: 验收\nkind: acceptance\ntools: [bash]\ncontext_files: off\n---\n正文\n",
    );
    const { roles } = await loadRoleCatalog({ defaultDir: join(root, "d"), userDir: join(root, "u"), projectDir, parseFrontmatter, projectTrusted: true });
    const acceptance = roles.find((role) => role.name === "acceptance");
    expect(acceptance?.available).toBe(false);
    expect(acceptance?.reason).toContain("context_files");
  });

  test("缺省 skills 与 context_files 解析为 false", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const path = await writeRoleFile(join(root, "p"), "worker", { name: "worker", description: "w", kind: "work", tools: ["read"] });
    const definition = await readRoleDefinition(path, parseFrontmatter);
    expect(definition.skills).toBe(false);
    expect(definition.contextFiles).toBe(false);
  });

  test("符号链接与大写扩展名的定义文件同样被装载，子目录与非 md 文件被忽略", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    const external = await writeRoleFile(join(root, "external"), "linked", { name: "linked", ...FULL_FIELDS, description: "链接" });
    await mkdir(projectDir, { recursive: true });
    await symlink(external, join(projectDir, "linked.md"));
    await writeFile(join(projectDir, "upper.MD"), `---\n${buildFrontmatter({ name: "upper", description: "大写", ...FULL_FIELDS })}\n---\n正文\n`);
    await mkdir(join(projectDir, "nested"), { recursive: true });
    await writeFile(join(projectDir, "notes.txt"), "不是角色");
    const { roles } = await loadRoleCatalog({ defaultDir: join(root, "d"), userDir: join(root, "u"), projectDir, parseFrontmatter, projectTrusted: true });
    expect(roles.map((role) => role.name).sort()).toEqual(["linked", "upper"]);
    expect(roles.every((role) => role.available)).toBe(true);
  });

  test("某层目录不可读时其余层照常装载并在 problems 中说明原因，目录不存在不算问题", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const userDir = join(root, "user");
    await writeFile(userDir, "这是文件不是目录");
    await writeRoleFile(join(root, "project"), "worker", { name: "worker", description: "w", ...FULL_FIELDS });
    const catalog = await loadRoleCatalog({ defaultDir: join(root, "missing"), userDir, projectDir: join(root, "project"), parseFrontmatter, projectTrusted: true });
    expect(catalog.roles.map((role) => role.name)).toEqual(["worker"]);
    expect(catalog.problems.length).toBe(1);
    expect(catalog.problems[0]?.source).toBe("user");
    expect(catalog.problems[0]?.reason.length).toBeGreaterThan(0);
  });

  test("解析函数抛出非 Error 值时不可用原因仍为可读文本", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    await writeRoleFile(projectDir, "worker", { name: "worker", description: "w", ...FULL_FIELDS });
    const throwing = () => {
      throw "字符串异常";
    };
    const { roles } = await loadRoleCatalog({ defaultDir: join(root, "d"), userDir: join(root, "u"), projectDir, parseFrontmatter: throwing, projectTrusted: true });
    expect(roles[0]?.available).toBe(false);
    expect(roles[0]?.reason).toBe("字符串异常");
  });

  test("frontmatter 的 name 与文件名不一致时标不可用", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    await writeRoleFile(projectDir, "alias", { name: "worker", description: "w", ...FULL_FIELDS });
    const { roles } = await loadRoleCatalog({ defaultDir: join(root, "d"), userDir: join(root, "u"), projectDir, parseFrontmatter, projectTrusted: true });
    const alias = roles.find((role) => role.name === "alias");
    expect(alias?.available).toBe(false);
    expect(alias?.reason).toContain("alias");
    expect(alias?.reason).toContain("worker");
  });

  test("五份默认定义的 name 与 description 与成品一致", async () => {
    const { roles } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: "/nonexistent/u", projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: true });
    const byName = new Map(roles.map((role) => [role.name, role.definition?.description]));
    expect(byName.get("planner")).toBe("规划角色：先核对任务骨架再生成自包含任务文件");
    expect(byName.get("worker")).toBe("按任务文件与验证约定先写可信失败测试，再以最小实现通过，自验收后提交工作裁决");
    expect(byName.get("reviewer")).toBe("对整个分支做一次只读白盒审查，安全与鲁棒优先，再核对验收到测试与实现的可追踪关系");
    expect(byName.get("acceptance")).toBe("只依据规则文件在真实环境执行黑盒验收，写入指定报告并提交验收裁决");
    expect(byName.get("requirement-agent")).toBe("持有单个需求的完整上下文，负责规划、提议工作流形状、派出角色、核对交付并推进阶段检查");
    for (const role of roles) expect(role.definition?.name).toBe(role.name);
  });
});

describe("不可用原因不回显文件内容", () => {
  test("符号链接指向含敏感内容的非法文件时原因不含目标内容", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const projectDir = join(root, "project");
    const secretFile = join(root, "credentials");
    await writeFile(secretFile, "---\npassword: [SUPER-SECRET-VALUE\ntoken: ghp_REALTOKEN\n---\n");
    await mkdir(projectDir, { recursive: true });
    await symlink(secretFile, join(projectDir, "leak.md"));
    const { roles } = await loadRoleCatalog({ defaultDir: join(root, "d"), userDir: join(root, "u"), projectDir, parseFrontmatter, projectTrusted: true });
    const leak = roles.find((role) => role.name === "leak");
    expect(leak?.available).toBe(false);
    expect(leak?.reason).not.toContain("SUPER-SECRET-VALUE");
    expect(leak?.reason).not.toContain("ghp_REALTOKEN");
    expect(leak?.reason?.length).toBeGreaterThan(0);
  });
});

describe("项目层角色定义的宿主信任阶段检查", () => {
  async function setupLayers() {
    const root = await mkdtemp(join(tmpdir(), "pi-company-role-catalog-"));
    tempRoots.push(root);
    const userDir = join(root, "user");
    const projectDir = join(root, "project");
    await writeRoleFile(userDir, "worker", { ...FULL_FIELDS, name: "worker", description: "全局 worker" });
    await writeRoleFile(projectDir, "worker", { ...FULL_FIELDS, name: "worker", description: "项目 worker" });
    await writeRoleFile(projectDir, "only-project", { ...FULL_FIELDS, name: "only-project", description: "仅项目独有" });
    return { root, userDir, projectDir };
  }

  test("项目未受宿主信任时忽略项目层，仅装载包内默认与用户全局两层", async () => {
    const { root, userDir, projectDir } = await setupLayers();
    const { roles, problems } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir,
      projectDir,
      parseFrontmatter,
      projectTrusted: false,
    });

    expect(roles.find((r) => r.name === "only-project")).toBeUndefined();
    const worker = roles.find((r) => r.name === "worker");
    expect(worker?.source).toBe("user");
    expect(worker?.definition?.description).toBe("全局 worker");

    const projectProblem = problems.find((p) => p.source === "project");
    expect(projectProblem?.reason).toContain("信任");
  });

  test("项目受宿主信任时正常装载项目层，问题清单不含未信任提示", async () => {
    const { root, userDir, projectDir } = await setupLayers();
    const { roles, problems } = await loadRoleCatalog({
      defaultDir: join(root, "no-default"),
      userDir,
      projectDir,
      parseFrontmatter,
      projectTrusted: true,
    });

    expect(roles.find((r) => r.name === "only-project")?.source).toBe("project");
    const worker = roles.find((r) => r.name === "worker");
    expect(worker?.source).toBe("project");
    expect(worker?.definition?.description).toBe("项目 worker");

    expect(problems.some((p) => p.source === "project" && p.reason.includes("信任"))).toBe(false);
  });

  test("项目未受宿主信任时不读取项目层目录，损坏文件与不可读目录都不产生额外问题", async () => {
    const { root, userDir, projectDir } = await setupLayers();
    await writeRawRoleFile(projectDir, "broken", "---\nname: [unterminated\n---\n正文\n");
    const fileAsDir = join(root, "project-is-file");
    await writeFile(fileAsDir, "not a directory");

    for (const dir of [projectDir, fileAsDir]) {
      const { roles, problems } = await loadRoleCatalog({
        defaultDir: join(root, "no-default"),
        userDir,
        projectDir: dir,
        parseFrontmatter,
        projectTrusted: false,
      });
      expect(roles.find((r) => r.name === "broken")).toBeUndefined();
      const projectProblems = problems.filter((p) => p.source === "project");
      expect(projectProblems).toHaveLength(1);
      expect(projectProblems[0]?.reason).toContain("信任");
    }
  });
});

describe("角色目录模块的导出边界", () => {
  test("不导出任何按 kind 判定派工的函数", async () => {
    const module: Record<string, unknown> = await import("../runtime/roles.ts");
    expect(module.assertDispatchAllowed).toBeUndefined();
  });
});
