import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { checkSpecSet, mechanicalConflicts, SpecFormatError } from "./spec-format.ts";
import type { MechanicalConflict, SpecSource } from "./spec-format.ts";

const SPEC_DIRECTORY = "docs/spec";

async function specSources(root: string): Promise<SpecSource[]> {
  const directory = join(root, ...SPEC_DIRECTORY.split("/"));
  let names: string[];
  try { names = (await readdir(directory, { recursive: true })) as string[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const sources: SpecSource[] = [];
  for (const name of names.map((entry) => entry.split(sep).join("/")).sort()) {
    if (!name.endsWith(".rules.json")) continue;
    const absolute = join(directory, ...name.split("/"));
    if (!(await lstat(absolute)).isFile()) continue;
    sources.push({ path: posix.join(SPEC_DIRECTORY, name), content: await readFile(absolute, "utf8") });
  }
  return sources;
}

/** 当前 docs/spec 的机械冲突；格式错误由调用方另行按格式检查处理，这里视为无可比较的规则。 */
export async function mechanicalConflictsIn(root: string): Promise<MechanicalConflict[]> {
  try { return mechanicalConflicts(checkSpecSet(await specSources(root))); }
  catch (error) { if (error instanceof SpecFormatError) return []; throw error; }
}

/** 供 CI 使用：只检查当前 docs/spec 的格式与机械冲突，不启动守护进程、模型或数据库，不读 docs/prod。 */
export async function runSpecCheck(root: string): Promise<{ ok: boolean; lines: string[] }> {
  const sources = await specSources(root);
  let set;
  try { set = checkSpecSet(sources); }
  catch (error) { if (error instanceof SpecFormatError) return { ok: false, lines: [error.message] }; throw error; }
  const conflicts = mechanicalConflicts(set);
  if (conflicts.length === 0) return { ok: true, lines: [`规则检查通过：${sources.length} 个文件，${set.rules.length} 条规则`] };
  return { ok: false, lines: conflicts.map((entry) => entry.kind === "duplicate"
    ? `重复规则：${entry.left} 与 ${entry.right} 内容相同`
    : `规则冲突：${entry.left} 与 ${entry.right} 条件和触发相同但期望不同，且未声明例外`) };
}
