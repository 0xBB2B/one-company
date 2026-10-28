import { readGit } from "../exec/git-read.ts";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { repositoryDatabase, withDatabase } from "./database.ts";
import { assertDataRootOutsideWorktrees } from "./database-paths.ts";
import { sanitizeText } from "../policy/text-sanitize.ts";

export interface RepositoryIdentity {
  repoId: string;
  commonDir: string;
}

export interface WorkspaceRepo {
  path: string;
  repoId: string;
  commonDir: string;
}

export interface WorkspaceSkipped {
  path: string;
  reason: string;
}

export interface Workspace {
  repos: WorkspaceRepo[];
  skipped: WorkspaceSkipped[];
}

function isNotGitRepoError(error: unknown): boolean {
  const stderr = (error as { stderr?: string } | undefined)?.stderr ?? "";
  return stderr.includes("not a git repository");
}

function gitFailure(error: unknown, dir: string): Error {
  if (isNotGitRepoError(error)) return new Error(`不是 Git 仓库: ${dir}`, { cause: error });
  return new Error(`无法读取仓库信息（${dir}）: ${(error as Error).message}`, { cause: error });
}

// 判定依赖 git 的英文文案，所以固定子进程的 locale
async function git(args: string[], dir: string): Promise<string> {
  const { stdout } = await readGit(dir, args);
  return stdout;
}

async function gitCommonDir(dir: string): Promise<string> {
  const raw = (await git(["rev-parse", "--git-common-dir"], dir)).trim();
  return isAbsolute(raw) ? raw : join(dir, raw);
}

async function worktreeRoot(dir: string): Promise<string> {
  const capturedDir = dir;
  const rawRoot = (await git(["rev-parse", "--show-toplevel"], capturedDir)).trim();
  const root = await realpath(rawRoot);
  return root;
}

export async function repositoryIdentity(dir: string): Promise<RepositoryIdentity> {
  const capturedDir = dir;
  let rawCommonDir: string;
  try {
    rawCommonDir = await gitCommonDir(capturedDir);
  } catch (error) {
    throw gitFailure(error, capturedDir);
  }
  const commonDir = await realpath(rawCommonDir);
  const repoId = createHash("sha256").update(commonDir).digest("hex");
  return { repoId, commonDir };
}

export async function isInsideRepository(dir: string): Promise<boolean> {
  try {
    await gitCommonDir(dir);
    return true;
  } catch (error) {
    if (isNotGitRepoError(error)) return false;
    throw gitFailure(error, dir);
  }
}

const WORKSPACE_SCAN_SKIP = new Set(["node_modules", ".git"]);

async function scanForRepos(
  dir: string,
  repos: WorkspaceRepo[],
  skipped: WorkspaceSkipped[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ path: dir, reason: (error as Error).message });
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || WORKSPACE_SCAN_SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    let root: string | undefined;
    try {
      root = await worktreeRoot(full);
    } catch (error) {
      if (!isNotGitRepoError(error)) {
        skipped.push({ path: full, reason: gitFailure(error, full).message });
        continue;
      }
    }
    if (root !== undefined && root === (await realpath(full))) {
      repos.push({ path: root, ...(await repositoryIdentity(root)) });
      continue;
    }
    await scanForRepos(full, repos, skipped);
  }
}

export async function discoverWorkspace(startDir: string): Promise<Workspace> {
  if (await isInsideRepository(startDir)) {
    const root = await worktreeRoot(startDir);
    return { repos: [{ path: root, ...(await repositoryIdentity(root)) }], skipped: [] };
  }
  const repos: WorkspaceRepo[] = [];
  const skipped: WorkspaceSkipped[] = [];
  await scanForRepos(startDir, repos, skipped);
  return { repos, skipped };
}

export async function primaryWorktreeRoot(dir: string): Promise<string> {
  try {
    return (await listWorktrees(dir))[0] ?? dir;
  } catch {
    return dir;
  }
}

export async function listWorktrees(dir: string): Promise<string[]> {
  const capturedDir = dir;
  let stdout: string;
  try {
    stdout = await git(["worktree", "list", "--porcelain"], capturedDir);
  } catch (error) {
    throw gitFailure(error, capturedDir);
  }
  const paths: string[] = [];
  for (const block of stdout.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.some((line) => line === "bare" || line.startsWith("prunable"))) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (worktreeLine) {
      const path = await realpath(worktreeLine.slice("worktree ".length).trim());
      paths.push(path);
    }
  }
  return paths;
}

export { dataRoot } from "./data-root.ts";

export async function repoDataDir(dataRootPath: string, repoId: string, commonDir: string): Promise<string> {
  const captured = { dataRootPath, repoId, commonDir };
  const worktrees = await listWorktrees(captured.commonDir);
  assertDataRootOutsideWorktrees(captured.dataRootPath, worktrees);
  // 维护状态必须先核对，不能先建立替代目录或空库。
  const database = repositoryDatabase(captured.dataRootPath, captured.repoId);
  const reposDir = join(captured.dataRootPath, "repos");
  const dir = join(reposDir, captured.repoId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(captured.dataRootPath, 0o700);
  await chmod(reposDir, 0o700);
  await chmod(dir, 0o700);
  assertDataRootOutsideWorktrees(captured.dataRootPath, worktrees);
  withDatabase(database, (db) => db.transaction(() => {
    const existing = db.read<{ commonDir: string }>("repository", captured.repoId);
    if (existing && existing.data.commonDir !== captured.commonDir) throw new Error("仓库身份与记录不一致");
    if (!existing) db.create("repository", captured.repoId, { commonDir: captured.commonDir, firstSeenAt: new Date().toISOString() });
  }));
  return dir;
}

export function daemonSocketPath(dataRootPath: string, repoId: string): string {
  return join(dataRootPath, "sock", `${repoId.slice(0, 16)}.sock`);
}

export function repoDisplayName(commonDir: string): string {
  const segments = commonDir.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  // 目录名可能是代理执行命令建出来的，会显示在终端里
  return sanitizeText(last === ".git" ? segments.at(-2) ?? "" : last.replace(/\.git$/, ""));
}
