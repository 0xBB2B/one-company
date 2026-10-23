import { describe, expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { defaultRoleDir, loadRoleCatalog } from "../src/modules/agents/roles.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLES_DIR = join(PACKAGE_ROOT, "examples");

const STACKS = [
  {
    dir: "golang",
    prefix: "go",
    skills: ["api-design", "auth-constraints", "authz-constraints", "config-constraints", "database-constraints", "golang-constraints", "golang-testing", "observability-constraints", "service-constraints", "version-policy"],
  },
  { dir: "vue", prefix: "vue", skills: ["frontend-constraints", "version-policy", "vue-constraints"] },
] as const;

const exampleDir = (stack: string) => join(EXAMPLES_DIR, stack);
const roleNames = (prefix: string) => [`${prefix}-worker`, `${prefix}-reviewer`];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function loadCatalog(userDir: string) {
  return loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir, projectDir: "/nonexistent/p", parseFrontmatter, projectTrusted: true });
}

async function packageSkillNames(): Promise<string[]> {
  const entries = await readdir(join(PACKAGE_ROOT, "skills"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

describe.each(STACKS)("$dir 样例目录结构", ({ dir, prefix, skills }) => {
  test("有 AGENTS.md", async () => {
    const content = await readFile(join(exampleDir(dir), "AGENTS.md"), "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test("skills/ 下恰好是约定的目录，每个目录只有一份 SKILL.md", async () => {
    const entries = await readdir(join(exampleDir(dir), "skills"), { withFileTypes: true });
    expect(entries.filter((entry) => !entry.isDirectory())).toEqual([]);
    expect(entries.map((entry) => entry.name).sort()).toEqual([...skills].sort());
    const extras: string[] = [];
    for (const skill of skills) {
      const files = await readdir(join(exampleDir(dir), "skills", skill));
      if (files.length !== 1 || files[0] !== "SKILL.md") extras.push(`${skill}: ${files.join(",")}`);
    }
    expect(extras).toEqual([]);
  });

  test("agents/ 下恰好是 worker 和 reviewer 两份定义", async () => {
    const files = await readdir(join(exampleDir(dir), "agents"));
    expect(files.sort()).toEqual(roleNames(prefix).map((name) => `${name}.md`).sort());
  });
});

describe("样例文件不含夹具二字", () => {
  test("examples/ 下所有文件都不含“夹具”", async () => {
    const offenders: string[] = [];
    for (const file of await listFiles(EXAMPLES_DIR)) {
      if ((await readFile(file, "utf8")).includes("夹具")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe.each(STACKS)("$dir 样例角色定义", ({ dir, prefix }) => {
  test("放在用户层时读成可用的用户层定义，职责对应 worker / reviewer", async () => {
    const { roles } = await loadCatalog(join(exampleDir(dir), "agents"));
    const found = roleNames(prefix).map((name) => {
      const entry = roles.find((candidate) => candidate.name === name);
      return { name, source: entry?.source, available: entry?.available, reason: entry?.reason, role: entry?.definition?.role };
    });
    expect(found).toEqual([
      { name: `${prefix}-worker`, source: "user", available: true, reason: undefined, role: "worker" },
      { name: `${prefix}-reviewer`, source: "user", available: true, reason: undefined, role: "reviewer" },
    ]);
  });

  test("skills 名单里的每个名字都能在包内 skills/ 或本样例 skills/ 找到", async () => {
    const { roles } = await loadCatalog(join(exampleDir(dir), "agents"));
    const known = new Set([...(await packageSkillNames()), ...(await readdir(join(exampleDir(dir), "skills")))]);
    const missing: string[] = [];
    for (const name of roleNames(prefix)) {
      const skills = roles.find((entry) => entry.name === name)?.definition?.skills ?? [];
      for (const skill of skills) if (!known.has(skill)) missing.push(`${name}.md: ${skill}`);
    }
    expect(missing).toEqual([]);
  });

  test("worker 和 reviewer 的 skills 名单完全相同，顺序也相同", async () => {
    const { roles } = await loadCatalog(join(exampleDir(dir), "agents"));
    expect(roleNames(prefix).map((name) => roles.find((entry) => entry.name === name)?.source)).toEqual(["user", "user"]);
    const [worker, reviewer] = roleNames(prefix).map((name) => roles.find((entry) => entry.name === name)?.definition?.skills);
    expect(worker?.length ?? 0).toBeGreaterThan(0);
    expect(reviewer).toEqual(worker);
  });

  test("skills 名单开头几项与包内同名内置定义的 skills 名单一致", async () => {
    const builtin = (await loadCatalog("/nonexistent/u")).roles;
    const { roles } = await loadCatalog(join(exampleDir(dir), "agents"));
    const mismatched: string[] = [];
    for (const name of roleNames(prefix)) {
      const base = builtin.find((entry) => entry.name === name)?.definition?.skills ?? [];
      const mine = roles.find((entry) => entry.name === name)?.definition?.skills ?? [];
      expect(base.length).toBeGreaterThan(0);
      expect(roles.find((entry) => entry.name === name)?.source).toBe("user");
      if (JSON.stringify(mine.slice(0, base.length)) !== JSON.stringify(base)) mismatched.push(`${name}.md: 开头应为 ${base.join(",")}，实际 ${mine.join(",")}`);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("样例自带 skill 名", () => {
  test("两个样例共 13 份 skill 名，都不和包内 skills/ 下的目录重名", async () => {
    const own: string[] = [];
    for (const { dir } of STACKS) own.push(...(await readdir(join(exampleDir(dir), "skills"))));
    expect(own).toHaveLength(13);
    const builtin = new Set(await packageSkillNames());
    expect(own.filter((name) => builtin.has(name))).toEqual([]);
  });
});

describe.each(STACKS)("$dir 样例 skills 被 pi 读取", ({ dir, skills }) => {
  test("没有诊断，name 等于目录名，禁用模型自动调用，数量与约定一致", async () => {
    const { skills: loaded, diagnostics } = loadSkillsFromDir({ dir: join(exampleDir(dir), "skills"), source: "test" });
    expect(diagnostics).toEqual([]);
    expect(loaded).toHaveLength(skills.length);
    const wrongName = loaded.filter((skill) => skill.name !== skill.baseDir.split("/").pop()).map((skill) => skill.name);
    expect(wrongName).toEqual([]);
    const enabled = loaded.filter((skill) => skill.disableModelInvocation !== true).map((skill) => skill.name);
    expect(enabled).toEqual([]);
  });
});
