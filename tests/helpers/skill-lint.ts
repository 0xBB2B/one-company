import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const MAX_LINES = 200;
const FIELDS = ["问题", "怎么认出", "修法", "出处"] as const;
type Field = (typeof FIELDS)[number];

export interface SkillItem {
  title: string;
  fields: Partial<Record<Field, string>>;
  order: Field[];
}

export interface SkillDoc {
  name: string;
  description: string;
  body: string;
  lineCount: number;
}

const packageRoot = new URL("../../", import.meta.url);

function lineCountOf(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

export function parseSkillText(text: string): SkillDoc {
  const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown }>(text);
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : "",
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
    body,
    lineCount: lineCountOf(text),
  };
}

export function skillItems(body: string): SkillItem[] {
  const items: SkillItem[] = [];
  let current: SkillItem | undefined;
  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      current = { title: line.slice(4).trim(), fields: {}, order: [] };
      items.push(current);
      continue;
    }
    if (!current) continue;
    for (const field of FIELDS) {
      const prefix = `- ${field}：`;
      if (line.startsWith(prefix) && current.fields[field] === undefined) {
        current.fields[field] = line.slice(prefix.length).trim();
        current.order.push(field);
      }
    }
  }
  return items;
}

export function lintSkillText(dirName: string, text: string, keywords: string[]): string[] {
  const errors: string[] = [];
  const doc = parseSkillText(text);
  if (doc.name !== dirName) errors.push(`name「${doc.name}」与目录名「${dirName}」不一致`);
  if (doc.description === "") errors.push("description 为空");
  if (doc.lineCount > MAX_LINES) errors.push(`共 ${doc.lineCount} 行，超过 ${MAX_LINES} 行`);
  const items = skillItems(doc.body);
  if (items.length === 0) errors.push("没有检查项");
  items.forEach((item, index) => {
    const label = `第 ${index + 1} 项「${item.title}」`;
    const missing = FIELDS.filter((field) => item.fields[field] === undefined);
    for (const field of missing) errors.push(`${label}缺「- ${field}：」行`);
    if (missing.length === 0 && item.order.join() !== FIELDS.join()) {
      errors.push(`${label}四行顺序不对：${item.order.join("、")}`);
    }
    const source = item.fields["出处"];
    if (source !== undefined && !/https:\/\/\S/.test(source)) errors.push(`${label}出处没有 https 链接`);
  });
  for (const keyword of keywords) {
    if (!doc.body.includes(keyword)) errors.push(`缺关键词「${keyword}」`);
  }
  return errors;
}

export async function skillLintErrors(name: string, keywords: string[]): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(fileURLToPath(new URL(`skills/${name}/SKILL.md`, packageRoot)), "utf8");
  } catch {
    return [`文件 skills/${name}/SKILL.md 不存在`];
  }
  return lintSkillText(name, text, keywords);
}
