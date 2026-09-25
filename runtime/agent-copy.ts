import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleCatalogEntry } from "./roles.ts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class AgentCopyError extends Error {}

/**
 * 把一个角色定义复制为新定义：名字在内置、用户、项目三层都不能已存在；
 * pm 职责唯一，只能同名复制到尚无 pm 的层，用于覆盖内置 pm。
 */
export async function copyAgentDefinition(input: { entry: RoleCatalogEntry; newName: string; targetDir: string; layerDirs: string[] }): Promise<string> {
  const definition = input.entry.definition;
  if (!definition) throw new AgentCopyError("无效定义不能复制");
  if (!NAME_PATTERN.test(input.newName)) throw new AgentCopyError("名称只能用小写字母、数字或连字符，最多 64 字符");
  if (definition.role === "pm" && input.newName !== "pm") throw new AgentCopyError("pm 职责唯一，只能同名复制为 pm 用于覆盖");
  const exists = (dir: string) => access(join(dir, `${input.newName}.md`)).then(() => true, () => false);
  const taken = definition.role === "pm" ? await exists(input.targetDir) : (await Promise.all(input.layerDirs.map(exists))).some(Boolean);
  if (taken) throw new AgentCopyError(`名称 ${input.newName} 已被使用`);
  const content = (await readFile(input.entry.path, "utf8")).replace(/^name:.*$/mu, `name: ${input.newName}`);
  await mkdir(input.targetDir, { recursive: true });
  const target = join(input.targetDir, `${input.newName}.md`);
  await writeFile(target, content, { flag: "wx" });
  return target;
}
