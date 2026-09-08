import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
  repoId: string;
  commonDir: string;
}

export interface RequirementIdentity {
  reqId: string;
  date: string;
  slug: string;
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
  const { stdout } = await execFileAsync("git", args, {
    cwd: dir,
    timeout: 10_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function gitCommonDir(dir: string): Promise<string> {
  const raw = (await git(["rev-parse", "--git-common-dir"], dir)).trim();
  return isAbsolute(raw) ? raw : join(dir, raw);
}

async function worktreeRoot(dir: string): Promise<string> {
  return realpath((await git(["rev-parse", "--show-toplevel"], dir)).trim());
}

export async function repositoryIdentity(dir: string): Promise<RepositoryIdentity> {
  let rawCommonDir: string;
  try {
    rawCommonDir = await gitCommonDir(dir);
  } catch (error) {
    throw gitFailure(error, dir);
  }
  const commonDir = await realpath(rawCommonDir);
  const repoId = createHash("sha256").update(commonDir).digest("hex");
  return { repoId, commonDir };
}

const REQUIREMENT_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})\.([a-zA-Z0-9][a-zA-Z0-9-]*)$/;

function isValidCalendarDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === (month as number) - 1 && parsed.getUTCDate() === day
  );
}

export function requirementIdentity(name: string): RequirementIdentity {
  const match = REQUIREMENT_ID_PATTERN.exec(name);
  if (!match) throw new Error(`不合法的需求目录名: ${name}`);
  const date = match[1] as string;
  if (!isValidCalendarDate(date)) throw new Error(`不合法的需求目录名: ${name}`);
  return { reqId: name, date, slug: match[2] as string };
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
const WORKSPACE_SCAN_MAX_DEPTH = 4;

async function scanForRepos(
  dir: string,
  depth: number,
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
    const nextDepth = depth + 1;
    if (nextDepth > WORKSPACE_SCAN_MAX_DEPTH) continue;
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
    await scanForRepos(full, nextDepth, repos, skipped);
  }
}

export async function discoverWorkspace(startDir: string): Promise<Workspace> {
  if (await isInsideRepository(startDir)) {
    const root = await worktreeRoot(startDir);
    return { repos: [{ path: root, ...(await repositoryIdentity(root)) }], skipped: [] };
  }
  const repos: WorkspaceRepo[] = [];
  const skipped: WorkspaceSkipped[] = [];
  await scanForRepos(startDir, 0, repos, skipped);
  return { repos, skipped };
}

export async function listWorktrees(dir: string): Promise<string[]> {
  let stdout: string;
  try {
    stdout = await git(["worktree", "list", "--porcelain"], dir);
  } catch (error) {
    throw gitFailure(error, dir);
  }
  const paths: string[] = [];
  for (const block of stdout.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.some((line) => line === "bare" || line.startsWith("prunable"))) continue;
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (worktreeLine) paths.push(worktreeLine.slice("worktree ".length).trim());
  }
  return paths;
}

export function dataRoot(env: Record<string, string | undefined>): string {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (agentDir !== undefined) {
    if (!isAbsolute(agentDir)) throw new Error(`PI_CODING_AGENT_DIR 必须是绝对路径: ${agentDir}`);
    return join(agentDir, "pi-company");
  }
  const home = env.HOME;
  if (!home) throw new Error("未设置 PI_CODING_AGENT_DIR 时必须设置 HOME");
  if (!isAbsolute(home)) throw new Error(`HOME 必须是绝对路径: ${home}`);
  return join(home, ".pi", "agent", "pi-company");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function repoDataDir(dataRootPath: string, repoId: string, commonDir: string): Promise<string> {
  const reposDir = join(dataRootPath, "repos");
  const dir = join(reposDir, repoId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dataRootPath, 0o700);
  await chmod(reposDir, 0o700);
  await chmod(dir, 0o700);
  const repoJsonPath = join(dir, "repo.json");
  if (!(await pathExists(repoJsonPath))) {
    const payload = { commonDir, firstSeenAt: new Date().toISOString() };
    await writeFile(repoJsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }
  return dir;
}

export function requirementDataDir(dataRootPath: string, repoId: string, reqId: string): string {
  requirementIdentity(reqId);
  return join(dataRootPath, "repos", repoId, "requirements", reqId);
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function runsDataDir(dataRootPath: string, repoId: string): string {
  return join(dataRootPath, "repos", repoId, "runs");
}

export function runDataDir(dataRootPath: string, repoId: string, runId: string): string {
  if (!UUID_V4_PATTERN.test(runId)) throw new Error(`不合法的 UUIDv4: ${runId}`);
  return join(runsDataDir(dataRootPath, repoId), runId);
}

export function daemonSocketPath(dataRootPath: string, repoId: string): string {
  return join(dataRootPath, "sock", `${repoId.slice(0, 16)}.sock`);
}
