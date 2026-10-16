import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

async function deepestExistingAncestor(absPath: string): Promise<{ real: string; remainder: string[] }> {
  let current = absPath.endsWith(sep) ? absPath.slice(0, -1) || sep : absPath;
  const remainder: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      return { real, remainder };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`无法解析路径祖先: ${absPath}`);
      remainder.unshift(basename(current));
      current = parent;
    }
  }
}

// 符号链接可能把仓库内一个合法路径指向别处（仓库外，或仓库内的另一个范围）：字符串层面的规整看不出这点，
// 占用与范围判定必须落在"最深已存在祖先"的真实路径拼回剩余段之后，词法路径只用于逃逸时的报错文案
export async function resolveRealRepoPath(repoRoot: string, absTarget: string, isDir: boolean): Promise<string> {
  const realRoot = await realpath(repoRoot);
  const { real, remainder } = await deepestExistingAncestor(absTarget);
  const resolvedTarget = remainder.length > 0 ? join(real, ...remainder) : real;
  const rel = relative(realRoot, resolvedTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径逃逸仓库边界（符号链接指向仓库外）: ${absTarget}`);
  }
  const posixRel = rel.split(sep).join("/");
  return isDir ? `${posixRel}/` : posixRel;
}
