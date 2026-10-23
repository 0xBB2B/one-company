import type { ProgramWindow, WindowAnswer, WindowChoice, WindowLine } from "../../core/host/question-window.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../../core/storage/store.ts";

export const CONVENTIONS_FILE = "AGENTS.md";
/** 规范全文上限：项目规范随每次派工进入子代理的上下文，须保持简短。 */
export const MAX_CONVENTIONS_BYTES = 16 * 1024;

const CONVENTIONS_ADVICE = {
  too_large: { why: "项目规范内容超出大小上限", next: "精简 AGENTS.md 内容后再提交" },
  changed_concurrently: { why: "确认期间 AGENTS.md 被别处改动", next: "重新读取仓库根目录的 AGENTS.md，在最新内容上修改后再提交" },
} as const satisfies Record<string, FailureAdvice>;
export class ProjectConventionsError extends Error {
  readonly code: keyof typeof CONVENTIONS_ADVICE;
  readonly advice: FailureAdvice;
  constructor(code: ProjectConventionsError["code"]) { super(code); this.name = "ProjectConventionsError"; this.code = code; this.advice = CONVENTIONS_ADVICE[code]; }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** 子代理启动时要遵守的两份规范：用户级 AGENTS.md 与主仓库根目录的 AGENTS.md，按磁盘上此刻的内容给出；都没有时为 null。 */
export async function agentConventionsContext(input: { agentDir: string; repositoryRoot: string }): Promise<string | null> {
  const user = await readOptional(join(input.agentDir, CONVENTIONS_FILE)), project = await readOptional(join(input.repositoryRoot, CONVENTIONS_FILE));
  const blocks = [
    ...(user?.trim() ? [`用户规范（来源：用户级 ${CONVENTIONS_FILE}；必须遵守）：\n${user.trimEnd()}`] : []),
    ...(project?.trim() ? [`项目规范（来源：仓库根目录 ${CONVENTIONS_FILE}；本任务的改动必须遵守）：\n${project.trimEnd()}`] : []),
  ];
  return blocks.length ? blocks.join("\n\n") : null;
}

async function canonical(path: string): Promise<string> {
  try { return join(await realpath(dirname(path)), basename(path)).toLowerCase(); }
  catch { return path.toLowerCase(); }
}

/** 主窗口的 edit、write 指向某个已接入仓库根目录的 AGENTS.md 时拦下：项目规范只经 conventions-update 的窗口写入。 */
export async function checkConventionsWrite(event: { toolName: string; input: unknown }, cwd: string, repositoryRoots: string[]): Promise<{ block: true; reason: string } | undefined> {
  if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
  const raw = (event.input as { path?: unknown } | null)?.path;
  if (typeof raw !== "string") return undefined;
  // SDK 写入前会去掉前导 @ 并展开 ~，这里按同样的写法还原真实目标
  const path = raw.replace(/^@/u, "").replace(/^~(?=$|\/)/u, homedir());
  const target = await canonical(resolve(cwd, path));
  for (const root of repositoryRoots) {
    if (target === await canonical(join(root, CONVENTIONS_FILE))) {
      return { block: true, reason: `项目规范 ${CONVENTIONS_FILE} 不能用 edit 或 write 直接改；改用 one_company_project_manage conventions-update 提交完整新内容，由用户在窗口里选择后写入` };
    }
  }
  return undefined;
}

export function lineDiff(before: string, after: string): string[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n"), b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(`  ${a[i]}`); i++; j++; }
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push(`+ ${b[j++]}`);
    else lines.push(`- ${a[i++]}`);
  }
  return lines;
}

function abbreviateHome(path: string): string {
  const raw = homedir(), home = raw.endsWith(sep) ? raw.slice(0, -sep.length) : raw;
  return home && path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

export async function symlinkTarget(file: string): Promise<string | null> {
  try {
    if (!(await lstat(file)).isSymbolicLink()) return null;
    return await realpath(file);
  } catch { return null; }
}

const WRITE = "写入", SKIP = "不写入";
export type ConventionsWindow = ProgramWindow & { choices: WindowChoice[]; otherLabel: string; cancelNote: string };
export type ConventionsUpdateResult = { status: "unchanged" | "cancelled" | "written" } | { status: "revise"; feedback: string };

// 写入只凭用户在窗口里选"写入"，模型参数里没有任何字段能代替它
export async function updateConventions(input: { repositoryRoot: string; content: string;
  decide: (window: ConventionsWindow) => Promise<WindowAnswer | undefined> }): Promise<ConventionsUpdateResult> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_CONVENTIONS_BYTES) throw new ProjectConventionsError("too_large");
  const file = join(input.repositoryRoot, CONVENTIONS_FILE);
  const before = await readOptional(file);
  if (before === input.content) return { status: "unchanged" };
  const linkTarget = await symlinkTarget(file);
  const lines: WindowLine[] = [
    ...(linkTarget ? [{ text: `${CONVENTIONS_FILE} 是软链接，实际写到 ${abbreviateHome(linkTarget)}`, tone: "warning" } satisfies WindowLine] : []),
    { text: before === null ? `仓库里还没有 ${CONVENTIONS_FILE}，要写入的全文如下：` : `与仓库里现有的 ${CONVENTIONS_FILE} 相比的改动：`, tone: "muted" },
    ...lineDiff((before ?? "").replace(/\r\n/g, "\n"), input.content.replace(/\r\n/g, "\n")).map((line): WindowLine =>
      ({ text: line, tone: line.startsWith("+ ") ? "added" : line.startsWith("- ") ? "removed" : "muted" })),
    { text: "" },
    { text: "写入后，此后派出的 PM、worker、reviewer 都按新内容工作。", tone: "muted" },
  ];
  const answer = await input.decide({ title: `把这些改动写入项目规范 ${CONVENTIONS_FILE}？`, lines,
    choices: [{ label: WRITE }, { label: SKIP }], otherLabel: "其他（自己输入修改意见）", cancelNote: SKIP });
  if (answer?.other) return { status: "revise", feedback: answer.other };
  if (answer?.choices[0] !== WRITE) return { status: "cancelled" };
  if (await readOptional(file) !== before) throw new ProjectConventionsError("changed_concurrently");
  await writeFileAtomic(file, input.content, { followSymlink: true });
  return { status: "written" };
}
