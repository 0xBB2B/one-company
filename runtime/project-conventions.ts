import { createHash } from "node:crypto";
import type { FailureAdvice } from "./tool-failure.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { checked, hash, object } from "./requirement-contracts.ts";
import { writeFileAtomic } from "./store.ts";

export const PROJECT_CONVENTIONS = "project_conventions";
export const CONVENTIONS_FILE = "AGENTS.md";
/** 规范全文上限：批准版本随每次派工进入 PM、worker、reviewer 的上下文，须保持简短。 */
export const MAX_CONVENTIONS_BYTES = 16 * 1024;
const RECORD_KEY = "current";

const ApprovedConventions = object({
  format: Type.Literal("project-conventions/v1"), repoId: hash, content: Type.String({ maxLength: MAX_CONVENTIONS_BYTES }), hash, approvedAt: Type.Integer({ minimum: 0 }),
});
export type ApprovedConventions = Static<typeof ApprovedConventions>;

const CONVENTIONS_ADVICE = {
  too_large: { why: "项目规范内容超出大小上限", next: "精简 AGENTS.md 内容后再提交" },
  changed_concurrently: { why: "确认期间 AGENTS.md 被别处改动", next: "先用 conventions-status 读取最新内容，再重新提交" },
} as const satisfies Record<string, FailureAdvice>;
export class ProjectConventionsError extends Error {
  readonly code: keyof typeof CONVENTIONS_ADVICE;
  readonly advice: FailureAdvice;
  constructor(code: ProjectConventionsError["code"]) { super(code); this.name = "ProjectConventionsError"; this.code = code; this.advice = CONVENTIONS_ADVICE[code]; }
}

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

export function approvedConventionsIn(db: LocalDatabase, repoId: string): ApprovedConventions | null {
  const row = db.read<unknown>(PROJECT_CONVENTIONS, RECORD_KEY);
  if (!row) return null;
  const data = checked(ApprovedConventions, row.data);
  return data.repoId === repoId ? data : null;
}

export function readApprovedConventions(dataRoot: string, repoId: string): ApprovedConventions | null {
  return withDatabase(repositoryDatabase(dataRoot, repoId), (db) => approvedConventionsIn(db, repoId));
}

export function conventionsContext(approved: ApprovedConventions | null): string | null {
  if (!approved) return null;
  return [`项目规范（来源：用户在界面确认过的 ${CONVENTIONS_FILE}，指纹 ${approved.hash.slice(0, 12)}；本任务的改动必须遵守）：`, approved.content.trimEnd()].join("\n");
}

async function readDisk(repositoryRoot: string): Promise<string | null> {
  try { return await readFile(join(repositoryRoot, CONVENTIONS_FILE), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export interface ConventionsStatus { approvedHash: string | null; diskHash: string | null; differs: boolean }

export async function conventionsStatus(input: { repositoryRoot: string; dataRoot: string; repoId: string }): Promise<ConventionsStatus> {
  const approved = readApprovedConventions(input.dataRoot, input.repoId);
  const disk = await readDisk(input.repositoryRoot);
  const diskHash = disk === null ? null : sha256(disk);
  return { approvedHash: approved?.hash ?? null, diskHash, differs: diskHash !== (approved?.hash ?? null) };
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

export type ConventionsUpdateResult = { status: "unchanged" | "cancelled"; hash: string } | { status: "approved"; hash: string; previousHash: string | null };

// 批准只能来自宿主界面的确认，模型参数里没有任何字段能代替它
export async function updateConventions(input: { repositoryRoot: string; dataRoot: string; repoId: string; content: string;
  confirm: (title: string, message: string) => Promise<boolean>; now?: () => number }): Promise<ConventionsUpdateResult> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_CONVENTIONS_BYTES) throw new ProjectConventionsError("too_large");
  const database = repositoryDatabase(input.dataRoot, input.repoId);
  const before = withDatabase(database, (db) => approvedConventionsIn(db, input.repoId));
  const next = sha256(input.content);
  if (before?.hash === next) return { status: "unchanged", hash: next };
  const message = [
    before ? `与当前批准版本（指纹 ${before.hash.slice(0, 12)}）相比的改动：` : "这是第一次批准项目规范，全文如下：",
    ...lineDiff(before?.content ?? "", input.content),
    "",
    `确认后写入仓库根目录 ${CONVENTIONS_FILE}，此后派出的 PM、worker、reviewer 都按这一版规范工作。`,
  ].join("\n");
  if (!(await input.confirm(`确认更新项目规范 ${CONVENTIONS_FILE}`, message))) return { status: "cancelled", hash: next };
  await writeFileAtomic(join(input.repositoryRoot, CONVENTIONS_FILE), input.content);
  withDatabase(database, (db) => db.transaction(() => {
    const row = db.read<unknown>(PROJECT_CONVENTIONS, RECORD_KEY);
    const current = row ? checked(ApprovedConventions, row.data) : null;
    if ((current?.hash ?? null) !== (before?.hash ?? null)) throw new ProjectConventionsError("changed_concurrently");
    const data = checked(ApprovedConventions, { format: "project-conventions/v1", repoId: input.repoId, content: input.content, hash: next,
      approvedAt: (input.now ?? Date.now)() });
    if (row) db.update(PROJECT_CONVENTIONS, RECORD_KEY, row.version, data);
    else db.create(PROJECT_CONVENTIONS, RECORD_KEY, data);
  }));
  return { status: "approved", hash: next, previousHash: before?.hash ?? null };
}
