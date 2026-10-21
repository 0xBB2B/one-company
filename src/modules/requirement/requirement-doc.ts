import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { PRD_SECTION_ID_PATTERN } from "./prd-view.ts";
import type { RequirementDocSpecSchema } from "./requirement-contracts.ts";

/** 批准时存进需求记录的规范快照；之后修改 skill 不影响已批准的需求。 */
export type RequirementDocSpec = Static<typeof RequirementDocSpecSchema>;
export type RequirementDocSection = RequirementDocSpec["sections"][number];
export interface ResolvedRequirementDoc { source: "project" | "user" | "package"; path: string; spec: RequirementDocSpec; body: string }

export class RequirementDocError extends Error {
  readonly code = "requirement_doc_invalid";
}

export function packageSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..", "skills");
}

/** 两段程序记录各自插入的板块编号。 */
export function recordSectionIds(sections: readonly RequirementDocSection[]): { implementation: string; acceptance: string } {
  return { implementation: sections.find((s) => s.record === "implementation")!.id, acceptance: sections.find((s) => s.record === "acceptance")!.id };
}

/**
 * 按项目 .pi/skills（项目受信任时）> 用户 agentDir/skills > 包内默认的顺序取第一份 requirement-doc/SKILL.md；
 * 取到的那份无效即报错，不再往后找。
 */
export async function resolveRequirementDoc(input: { repoRoot?: string; agentDir: string; projectTrusted: boolean }): Promise<ResolvedRequirementDoc> {
  const layers: Array<[ResolvedRequirementDoc["source"], string]> = [
    ...(input.repoRoot && input.projectTrusted ? [["project", join(input.repoRoot, ".pi", "skills")] as [ResolvedRequirementDoc["source"], string]] : []),
    ["user", join(input.agentDir, "skills")], ["package", packageSkillsDir()]];
  for (const [source, dir] of layers) {
    const path = join(dir, "requirement-doc", "SKILL.md");
    let content: string;
    try { content = await readFile(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const invalid = (reason: string): never => { throw new RequirementDocError(`需求文档规范 ${path} 无效：${reason}`); };
    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try { parsed = parseFrontmatter<Record<string, unknown>>(content); } catch (error) { return invalid(`frontmatter 不是合法 YAML（${(error as Error).message.split("\n")[0]}）`); }
    return { source, path, body: parsed.body, spec: { sections: checkSections(parsed.frontmatter.sections, invalid),
      skillHash: `sha256:${createHash("sha256").update(content).digest("hex")}` } };
  }
  throw new RequirementDocError(`找不到需求文档规范 requirement-doc/SKILL.md（包内默认 ${packageSkillsDir()} 缺失）`);
}

/** 产品里需求所在仓库的规范：agentDir 与 daemon 一致取数据根的上级目录，项目层只在该仓库受信任时生效；信任和文件都按主工作区取，这样在 worktree 里打开时和设置页、守护进程的结果一致。 */
export async function resolveRepositoryRequirementDoc(dataRoot: string, repoRoot: string): Promise<ResolvedRequirementDoc> {
  const agentDir = dirname(dataRoot);
  const primaryRoot = await primaryWorktreeRoot(repoRoot);
  return resolveRequirementDoc({ repoRoot: primaryRoot, agentDir, projectTrusted: new ProjectTrustStore(agentDir).get(primaryRoot) === true });
}

function checkSections(value: unknown, invalid: (reason: string) => never): RequirementDocSection[] {
  if (!Array.isArray(value) || !value.length) invalid("frontmatter 须有非空的 sections 板块清单");
  const idPattern = new RegExp(PRD_SECTION_ID_PATTERN), seen = new Set<string>();
  const sections = (value as unknown[]).map((item, index) => {
    const at = `sections 第 ${index + 1} 项`;
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid(`${at} 须是含 id、title 的对象`);
    const unknown = Object.keys(item).filter((key) => !["id", "title", "record", "goal"].includes(key));
    if (unknown.length) invalid(`${at} 有未知字段 ${unknown.join("、")}`);
    const { id, title, record, goal } = item as Record<string, unknown>;
    if (typeof id !== "string" || !idPattern.test(id)) invalid(`${at} 的编号 ${String(id)} 须字母开头、只含字母数字._-`);
    if (typeof title !== "string" || !title.trim() || /[\r\n]/u.test(title)) invalid(`${at} 的 title 须是非空单行文字`);
    if (record !== undefined && record !== "implementation" && record !== "acceptance") invalid(`${at} 的 record 只能是 implementation 或 acceptance`);
    if (goal !== undefined && goal !== true) invalid(`${at} 的 goal 只能写 true`);
    if (seen.has(id as string)) invalid(`板块编号 ${String(id)} 重复`);
    seen.add(id as string);
    return { id: id as string, title: title as string, ...(record ? { record: record as "implementation" | "acceptance" } : {}), ...(goal ? { goal: true as const } : {}) };
  });
  for (const record of ["implementation", "acceptance"] as const) {
    const count = sections.filter((section) => section.record === record).length;
    if (count !== 1) invalid(`须恰好有一个板块标 record: ${record}，当前 ${count} 个`);
  }
  // 批准并授权实施时，这些板块下已确认的段落就是实施目标
  if (!sections.some((section) => section.goal)) invalid("须至少有一个板块标 goal: true，标出批准后要实施的板块");
  const nested = sections.find((outer) => sections.some((inner) => inner.id.startsWith(`${outer.id}.`)));
  if (nested) invalid(`板块编号 ${sections.find((inner) => inner.id.startsWith(`${nested.id}.`))!.id} 以另一板块编号 ${nested.id} 加点开头，无法判断小节归属`);
  return sections;
}
