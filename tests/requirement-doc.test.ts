import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_DOC_SECTIONS, packageSkillsDir, recordSectionIds, resolveRequirementDoc } from "../runtime/requirement-doc.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function world() {
  const root = await mkdtemp(join(tmpdir(), "requirement-doc-")); roots.push(root);
  const repoRoot = join(root, "repo"), agentDir = join(root, "agent");
  await mkdir(repoRoot, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const put = async (dir: string, content: string) => {
    await mkdir(join(dir, "requirement-doc"), { recursive: true });
    await writeFile(join(dir, "requirement-doc", "SKILL.md"), content);
    return join(dir, "requirement-doc", "SKILL.md");
  };
  return { repoRoot, agentDir, project: (c: string) => put(join(repoRoot, ".pi", "skills"), c), user: (c: string) => put(join(agentDir, "skills"), c) };
}
const skill = (sections: string, body = "按场景写。\n") => `---\nname: requirement-doc\ndescription: 需求文档规范\nsections:\n${sections}---\n${body}`;
const FOUR = skill(`  - { id: goal, title: 目标 }\n  - { id: behavior, title: 行为 }\n  - { id: build, title: 实现, record: implementation }\n  - { id: check, title: 验收, record: acceptance }\n`, "四板块写法。\n");
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("M8C-AC1：零自定义时用包内默认 skill，板块清单就是 M8A 的五大板块，两段记录分别插在实现与验收", async () => {
  const w = await world();
  const doc = await resolveRequirementDoc({ repoRoot: w.repoRoot, agentDir: w.agentDir, projectTrusted: true });
  const path = join(packageSkillsDir(), "requirement-doc", "SKILL.md");
  expect(doc.source).toBe("package");
  expect(doc.path).toBe(path);
  expect(doc.spec.skillHash).toBe(sha(await readFile(path, "utf8")));
  expect(doc.spec.sections).toEqual(DEFAULT_DOC_SECTIONS);
  expect(DEFAULT_DOC_SECTIONS.map((s) => s.id)).toEqual(["background", "requirements", "features", "implementation", "acceptance"]);
  expect(recordSectionIds(doc.spec.sections)).toEqual({ implementation: "implementation", acceptance: "acceptance" });
  expect(doc.body).toContain("由 PM 规划");
  expect(doc.body).not.toMatch(/^---/u);
});

test("M8C-AC2：查找顺序为项目 > 用户 > 包内；项目未受信任时它的 skill 不生效", async () => {
  const w = await world();
  const user = await w.user(skill("  - { id: a, title: 甲, record: implementation }\n  - { id: b, title: 乙, record: acceptance }\n", "用户版。\n"));
  const project = await w.project(FOUR);
  const trusted = await resolveRequirementDoc({ repoRoot: w.repoRoot, agentDir: w.agentDir, projectTrusted: true });
  expect(trusted).toMatchObject({ source: "project", path: project, body: "四板块写法。" });
  expect(trusted.spec.sections.map((s) => s.id)).toEqual(["goal", "behavior", "build", "check"]);
  expect(recordSectionIds(trusted.spec.sections)).toEqual({ implementation: "build", acceptance: "check" });
  const untrusted = await resolveRequirementDoc({ repoRoot: w.repoRoot, agentDir: w.agentDir, projectTrusted: false });
  expect(untrusted).toMatchObject({ source: "user", path: user, body: "用户版。" });
  expect((await resolveRequirementDoc({ agentDir: w.agentDir, projectTrusted: true })).source).toBe("user");
});

test("M8C-AC4：skill 无效时报错写明原因与文件，不退回用户层或包内默认", async () => {
  const cases: Array<[string, string]> = [
    ["---\nsections: [a\n---\n正文", "frontmatter"],
    ["没有 frontmatter 的正文", "sections"],
    [skill("  - { id: a, title: 甲 }\n  - { id: b, title: 乙, record: acceptance }\n"), "implementation"],
    [skill("  - { id: a, title: 甲, record: implementation }\n  - { id: b, title: 乙, record: implementation }\n  - { id: c, title: 丙, record: acceptance }\n"), "implementation"],
    [skill("  - { id: a, title: 甲, record: implementation }\n  - { id: a, title: 乙, record: acceptance }\n"), "编号 a 重复"],
    [skill("  - { id: 1a, title: 甲, record: implementation }\n  - { id: b, title: 乙, record: acceptance }\n"), "1a"],
    [skill("  - { id: a, title: '', record: implementation }\n  - { id: b, title: 乙, record: acceptance }\n"), "title"],
    [skill("  - { id: a, title: 甲, record: implementation, extra: 1 }\n  - { id: b, title: 乙, record: acceptance }\n"), "extra"],
    [skill("  - { id: a, title: 甲, record: design }\n  - { id: b, title: 乙, record: acceptance }\n"), "record"],
    ["---\nname: requirement-doc\nsections: []\n---\n", "sections"],
  ];
  for (const [content, reason] of cases) {
    const w = await world();
    await w.user(FOUR);
    const path = await w.project(content);
    const failure = resolveRequirementDoc({ repoRoot: w.repoRoot, agentDir: w.agentDir, projectTrusted: true });
    await expect(failure).rejects.toMatchObject({ code: "requirement_doc_invalid" });
    await expect(failure).rejects.toThrow(path);
    await expect(failure).rejects.toThrow(reason);
  }
});
