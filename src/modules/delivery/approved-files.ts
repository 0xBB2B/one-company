import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandOutputTail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { gitIn } from "../../core/exec/target-branch.ts";
import { AdvisedError } from "../../core/exec/tool-failure.ts";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { LineAnchorRecord } from "../requirement/requirement-contracts.ts";
import { archivePathFor, parsePrdDocument, prototypeArchivePathFor } from "../requirement/requirement-identity.ts";
import { readDraftFiles } from "../requirement/prd-storage.ts";

export type ConventionFile = "DESIGN.md" | "AGENTS.md";
export interface ApprovedConflict { file: ConventionFile; chapter: string }
export interface ApprovedFilesPlan { writes: Record<string, Uint8Array>; deletes: string[]; conflicts: ApprovedConflict[] }
export interface ApprovedFilesInput {
  requirementId: string;
  title: string;
  files: { prd: Uint8Array; design: Uint8Array | null; designBase: Uint8Array | null; agents: Uint8Array | null; agentsBase: Uint8Array | null; prototypes: Record<string, Uint8Array> };
  current: { design: string | null; agents: string | null };
  existingPaths: string[];
}

const NO_HEADING = "文件开头";
const text = (value: Uint8Array | null): string | null => value === null ? null : Buffer.from(value).toString("utf8");

export function mergeWithBase(base: string | null, ours: string | null, theirs: string): { content: string; conflictChapters: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "approved-merge-"));
  try {
    const names = { ours: join(dir, "ours"), base: join(dir, "base"), theirs: join(dir, "theirs") };
    writeFileSync(names.ours, ours ?? ""); writeFileSync(names.base, base ?? ""); writeFileSync(names.theirs, theirs);
    const run = spawnSync("git", ["merge-file", "-p", "--diff3", names.ours, names.base, names.theirs], { encoding: "utf8", maxBuffer: 1 << 26 });
    if (run.error || run.status === null || run.status < 0 || run.status > 127) throw new Error(`合并 DESIGN.md/AGENTS.md 失败：${run.error?.message ?? run.stderr}`);
    const chapters: string[] = [];
    let heading = NO_HEADING, inOurs = false;
    for (const line of run.stdout.split("\n")) {
      if (line.startsWith("<<<<<<<")) { inOurs = true; if (!chapters.includes(heading)) chapters.push(heading); continue; }
      if (line.startsWith("|||||||")) inOurs = false;
      if (line.startsWith("## ")) {
        heading = line.slice(3).trim();
        if (inOurs && !chapters.includes(heading)) chapters.push(heading);
      }
    }
    return { content: run.stdout, conflictChapters: run.status === 0 ? [] : chapters };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function planApprovedFiles(input: ApprovedFilesInput): ApprovedFilesPlan {
  const writes: Record<string, Uint8Array> = { [archivePathFor(input.requirementId, input.title)]: input.files.prd };
  for (const [key, bytes] of Object.entries(input.files.prototypes)) writes[prototypeArchivePathFor(input.requirementId, key.replace(/\.v\d+$/, ""))] = bytes;
  const conflicts: ApprovedConflict[] = [];
  const merge = (file: ConventionFile, theirs: Uint8Array | null, base: Uint8Array | null, ours: string | null) => {
    if (theirs === null || (base !== null && Buffer.from(theirs).equals(base))) return;
    const merged = mergeWithBase(text(base), ours, text(theirs)!);
    for (const chapter of merged.conflictChapters) conflicts.push({ file, chapter });
    if (merged.conflictChapters.length === 0) writes[file] = Buffer.from(merged.content);
  };
  merge("DESIGN.md", input.files.design, input.files.designBase, input.current.design);
  merge("AGENTS.md", input.files.agents, input.files.agentsBase, input.current.agents);
  return { writes, deletes: input.existingPaths.filter((path) => !(path in writes)), conflicts };
}

const approvedMessage = (requirementId: string) => ({ subject: `docs(prd): 提交批准的需求文件 ${requirementId}`, trailer: `Requirement: ${requirementId}` });
const FILES_KEY = "Approved-Files: ";
const DIRTY_NEXT = "先提交或丢弃工作区里这些文件的改动，再批准";

/** 分支（或基线提交）里现有的 DESIGN.md、AGENTS.md 和这个需求已提交的 docs/prd 文件路径。 */
export async function readBranchFiles(cwd: string, rev: string, requirementId: string): Promise<{ current: { design: string | null; agents: string | null }; existingPaths: string[] }> {
  const blob = (file: ConventionFile) => gitIn(cwd, ["cat-file", "blob", `${rev}:${file}`]).then((out) => out.stdout, () => null);
  const listed = await gitIn(cwd, ["ls-tree", "-r", "--name-only", "-z", rev, "--", "docs/prd/"]).then((out) => out.stdout, () => "");
  return { current: { design: await blob("DESIGN.md"), agents: await blob("AGENTS.md") },
    existingPaths: listed.split("\0").filter((path) => path.startsWith(`docs/prd/${requirementId}.`)) };
}

/** 这些路径在 worktree 里有未提交、已暂存或同名未跟踪的改动。 */
async function dirtyPaths(worktree: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const status = (await gitIn(worktree, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...paths.map((path) => `:(literal)${path}`)])).stdout;
  const dirty = new Set(status.split("\0").map((entry) => entry.slice(3)));
  return paths.filter((path) => dirty.has(path));
}

function approvedFilesAdvice(conflicts: ApprovedConflict[], dirty: string[]): FailureAdvice {
  const parts = [...(conflicts.length > 0 ? [approvedFilesConflictAdvice(conflicts)] : []),
    ...(dirty.length > 0 ? [{ why: `工作区里这些文件有未提交的改动：${dirty.join("、")}`, next: DIRTY_NEXT }] : [])];
  return { why: parts.map((part) => part.why).join("；"), next: parts.map((part) => part.next).join("；") };
}

/** 批准那一刻这条线的文件提交。 */
export function approvalFileCommit(dataRoot: string, repoId: string, requirementId: string): string {
  const anchors = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<LineAnchorRecord>("line_anchors"))
    .map((row) => row.data).filter((row) => row.requirementId === requirementId && row.kind === "approval");
  return anchors.reduce((last, row) => row.sequence > last.sequence ? row : last).fileCommit!;
}

/** 分支上最近一个本需求的程序批准提交记下的草稿文件提交；没有这样的提交返回 undefined。 */
async function lastApprovedFileCommit(cwd: string, rev: string, requirementId: string): Promise<string | undefined> {
  const subject = approvedMessage(requirementId).subject;
  const out = (await gitIn(cwd, ["log", "--format=%x01%s%x00%(trailers:key=Approved-Files,valueonly)", "--fixed-strings", `--grep=${subject}`, rev])).stdout;
  for (const record of out.split("\x01").slice(1)) {
    const [title, trailers = ""] = record.split("\0");
    const last = trailers.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    if (title === subject && last) return last;
  }
  return undefined;
}

/** 写进去后会和 HEAD 不同的路径。 */
async function changedPaths(worktree: string, writes: Record<string, Uint8Array>, deletes: string[]): Promise<{ writes: Array<[string, Uint8Array]>; deletes: string[] }> {
  const inHead = (path: string) => gitIn(worktree, ["cat-file", "blob", `HEAD:${path}`]).then((out) => out.stdout, () => null);
  const changedWrites: Array<[string, Uint8Array]> = [];
  for (const entry of Object.entries(writes)) if (await inHead(entry[0]) !== Buffer.from(entry[1]).toString("utf8")) changedWrites.push(entry);
  const changedDeletes: string[] = [];
  for (const path of deletes) if (await inHead(path) !== null) changedDeletes.push(path);
  return { writes: changedWrites, deletes: changedDeletes };
}

/**
 * 三方合并的底稿用上一次写进分支的那版草稿，不用分支现有内容：现有内容已混入别人的改动，拿它当底稿会把草稿没变的文件误判成要改回草稿的样子。
 * rev 为 null 表示分支还没有任何提交。
 */
export async function planApprovedFromDraft(input: { dataRoot: string; repoId: string; requirementId: string; fileCommit: string; cwd: string; rev: string | null; checkDirty: boolean }): Promise<ApprovedFilesPlan> {
  const files = await readDraftFiles({ dataRoot: input.dataRoot, repoId: input.repoId, requirementId: input.requirementId, commit: input.fileCommit, authorize: () => true });
  const branch = input.rev === null ? { current: { design: null, agents: null }, existingPaths: [] } : await readBranchFiles(input.cwd, input.rev, input.requirementId);
  const recorded = input.rev === null ? undefined : await lastApprovedFileCommit(input.cwd, input.rev, input.requirementId);
  if (recorded === input.fileCommit) return { writes: {}, deletes: [], conflicts: [] };
  const previous = recorded ? await readDraftFiles({ dataRoot: input.dataRoot, repoId: input.repoId, requirementId: input.requirementId, commit: recorded, authorize: () => true }) : null;
  const sameAsPrevious = (now: Uint8Array | null, before: Uint8Array | null | undefined) => now !== null && before != null && Buffer.from(now).equals(before);
  const plan = planApprovedFiles({ requirementId: input.requirementId, title: parsePrdDocument(files.prd, input.requirementId).title,
    files: { ...files, design: sameAsPrevious(files.design, previous?.design) ? null : files.design, designBase: previous?.design ?? files.designBase,
      agents: sameAsPrevious(files.agents, previous?.agents) ? null : files.agents, agentsBase: previous?.agents ?? files.agentsBase }, ...branch });
  let dirty: string[] = [];
  if (input.checkDirty) {
    const changed = await changedPaths(input.cwd, plan.writes, plan.deletes);
    dirty = await dirtyPaths(input.cwd, [...changed.writes.map(([path]) => path), ...changed.deletes]);
  }
  if (plan.conflicts.length > 0 || dirty.length > 0) throw new AdvisedError("approved_files_conflict", approvedFilesAdvice(plan.conflicts, dirty));
  return plan;
}

/** 提交前再查一次未提交改动；只提交和 HEAD 不同的路径，`commit --only` 使暂存区和工作区里的其他改动保持原样；失败时只把这次写过的路径恢复成提交前的样子。 */
export async function commitApprovedFiles(input: { worktree: string; requirementId: string; fileCommit: string; writes: Record<string, Uint8Array>; deletes: string[] }): Promise<void> {
  const inHead = (path: string) => gitIn(input.worktree, ["cat-file", "blob", `HEAD:${path}`]).then((out) => out.stdout, () => null);
  const { writes, deletes } = await changedPaths(input.worktree, input.writes, input.deletes);
  const paths = [...writes.map(([path]) => path), ...deletes];
  if (paths.length === 0) return;
  const dirty = await dirtyPaths(input.worktree, paths);
  if (dirty.length > 0) throw new AdvisedError("approved_files_conflict", approvedFilesAdvice([], dirty));
  const literal = paths.map((path) => `:(literal)${path}`);
  try {
    for (const [path, bytes] of writes) {
      await mkdir(dirname(join(input.worktree, path)), { recursive: true });
      await writeFile(join(input.worktree, path), bytes);
    }
    for (const path of deletes) await rm(join(input.worktree, path), { force: true });
    await gitIn(input.worktree, ["add", "-A", "-f", "--", ...literal]);
    const message = approvedMessage(input.requirementId);
    await gitIn(input.worktree, ["commit", "--quiet", "--only", "-m", message.subject, "-m", `${FILES_KEY}${input.fileCommit}\n${message.trailer}`, "--", ...literal]);
  } catch (error) {
    await gitIn(input.worktree, ["reset", "-q", "--", ...literal]).catch(() => undefined);
    for (const path of paths) {
      if (await inHead(path) !== null) await gitIn(input.worktree, ["checkout", "HEAD", "--", `:(literal)${path}`]).catch(() => undefined);
      else await rm(join(input.worktree, path), { force: true }).catch(() => undefined);
    }
    throw new Error(`提交批准的文件失败：${commandOutputTail(error)}；请用户检查需求工作区的 Git 设置（例如配置 Git 用户名和邮箱）后重试`);
  }
}

/** rev-list 范围里的提交全是程序提交的批准文件：固定提交说明、单个父提交，且只改了这个需求的批准文件路径。 */
export async function onlyApprovedFilesCommits(cwd: string, tip: string, requirementId: string): Promise<boolean> {
  const message = approvedMessage(requirementId);
  const listed = (await gitIn(cwd, ["rev-list", "--parents", tip, "--not", "HEAD"])).stdout.trim();
  for (const line of listed === "" ? [] : listed.split("\n")) {
    const [commit, ...parents] = line.split(" ");
    if (parents.length !== 1) return false;
    const text = (await gitIn(cwd, ["show", "--no-patch", "--format=%s%n%b", commit!])).stdout.trimEnd().split("\n");
    if (text.length !== 3 || text[0] !== message.subject || !text[1]!.startsWith(FILES_KEY) || text[2] !== message.trailer) return false;
    const changed = (await gitIn(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", commit!])).stdout.split("\0").filter(Boolean);
    if (!changed.every((path) => path === "DESIGN.md" || path === "AGENTS.md" || path.startsWith(`docs/prd/${requirementId}.`))) return false;
  }
  return true;
}

export function approvedFilesConflictAdvice(conflicts: ApprovedConflict[]): FailureAdvice {
  const files = new Set(conflicts.map((conflict) => conflict.file));
  const next = [...(files.has("DESIGN.md") ? ["让设计师按最新的 DESIGN.md 重做一版"] : []), ...(files.has("AGENTS.md") ? ["按最新的 AGENTS.md 重改规范"] : [])].join("；");
  return { why: `这一版批准的内容和需求分支里现有的文件合不上：${conflicts.map((conflict) => `${conflict.file} 的「${conflict.chapter}」`).join("、")}`, next };
}
