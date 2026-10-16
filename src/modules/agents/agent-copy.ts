import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NAME_PATTERN } from "./roles.ts";
import type { RoleCatalogEntry } from "./roles.ts";

export class AgentCopyError extends Error {}

/**
 * 把一个角色定义复制为新定义：名字在内置、用户、项目三层都不能已存在。
 */
export async function copyAgentDefinition(input: { entry: RoleCatalogEntry; newName: string; targetDir: string; layerDirs: string[] }): Promise<string> {
  const definition = input.entry.definition;
  if (!definition) throw new AgentCopyError("无效定义不能复制");
  if (!NAME_PATTERN.test(input.newName)) throw new AgentCopyError("名称只能用小写字母、数字或连字符，最多 64 字符");
  const exists = (dir: string) => access(join(dir, `${input.newName}.md`)).then(() => true, () => false);
  const taken = (await Promise.all(input.layerDirs.map(exists))).some(Boolean);
  if (taken) throw new AgentCopyError(`名称 ${input.newName} 已被使用`);
  // 和 pi 解析定义时切设置段的方式一致，设置段之后的正文按原样保留
  const raw = (await readFile(input.entry.path, "utf8")).replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const end = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
  if (end === -1) throw new AgentCopyError("源文件开头的设置段格式不对，没有复制");
  const head = raw.slice(4, end).replace(/^name:.*$/mu, `name: ${input.newName}`);
  const added = (["skills", "mcp"] as const).filter((key) => definition[key] === undefined).map((key) => `\n${key}: []`).join("");
  const content = `---\n${head}${added}\n---${raw.slice(end + 4)}`;
  await mkdir(input.targetDir, { recursive: true });
  const target = join(input.targetDir, `${input.newName}.md`);
  await writeFile(target, content, { flag: "wx" });
  return target;
}
