import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);

const insideGit = (path: string) => path.split(sep).includes(".git");

/** 搜索目标在 .git 内或被 Git 忽略时不得搜索；不在 Git 仓库内的路径不受限。 */
export async function searchTargetExcluded(cwd: string, target: string): Promise<boolean> {
  const path = resolve(cwd, target);
  if (insideGit(path)) return true;
  const directory = await stat(path).then((entry) => entry.isDirectory() ? path : dirname(path), () => dirname(path));
  return exec("git", ["-C", directory, "check-ignore", "-q", "--", path]).then(() => true, () => false);
}

// grep 的行形如 `路径:行号: 内容` 或上下文行 `路径-行号- 内容`；find/ls 每行就是路径
const pathOf = (tool: string, line: string) => tool === "grep" ? line.replace(/[:-]\d+[:-] .*$|:\d+: \(unable to read file\)$/u, "") : line.trim();
const gitEntry = (path: string) => /(?:^|\/)\.git(?:\/|$)/u.test(path);

/** rg/fd 带 --hidden 会搜进 .git，交付前去掉这些条目。 */
export function withoutGitEntries(tool: string, text: string): string {
  return text.split("\n").filter((line) => !gitEntry(pathOf(tool, line))).join("\n");
}

/** 会话 tool_call 钩子：grep/find/ls 指向 .git 或被忽略路径时拦下；省略 path 时按会话 cwd 判定。 */
export async function checkSearchCall(event: { toolName: string; input: unknown }, cwd: string): Promise<{ block: true; reason: string } | undefined> {
  if (!SEARCH_TOOLS.has(event.toolName)) return undefined;
  const input = event.input as Record<string, unknown> | null;
  const target = input && typeof input.path === "string" ? input.path : cwd;
  return await searchTargetExcluded(cwd, target) ? { block: true, reason: `不搜索 .git 或被 Git 忽略的路径: ${target}` } : undefined;
}

/** 会话 tool_result 钩子：去掉 grep/find/ls 结果中的 .git 条目。 */
export function filterSearchResult(event: { toolName: string; content: Array<{ type: string; text?: string }> }) {
  if (!SEARCH_TOOLS.has(event.toolName)) return undefined;
  return { content: event.content.map((part) => part.type === "text" && part.text !== undefined ? { ...part, text: withoutGitEntries(event.toolName, part.text) } : part) } as never;
}
