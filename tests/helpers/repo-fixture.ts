import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { currentHostGit } from "../../runtime/git-runtime.mjs";
import { initializeTestHostGit } from "./test-git-binding.ts";

const execFileAsync = promisify(execFile);
const GIT_SETUP_CONFIG = ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.hooksPath=/dev/null"];

interface OwnedRoot { path: string; dev: number; ino: number }
export interface RepoFixtureRootReceipt {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
export interface WorktreeFixtureRootReceipt {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
class PreserveFixtureRootError extends AggregateError {}
const repoRootReceipts = new WeakMap<object, OwnedRoot>();
const worktreeRootReceipts = new WeakMap<object, OwnedRoot>();

/** 只向持有原始 createRepoFixture 返回对象的夹具提供主根分配收据。 */
export function repoFixtureRootReceipt(fixture: RepoFixture): RepoFixtureRootReceipt | undefined {
  const receipt = repoRootReceipts.get(fixture);
  return receipt ? Object.freeze({ path: receipt.path, dev: receipt.dev, ino: receipt.ino }) : undefined;
}

/** 只向持有原始 addWorktree 返回对象的夹具提供worktree根分配收据。 */
export function worktreeFixtureRootReceipt(fixture: WorktreeFixture): WorktreeFixtureRootReceipt | undefined {
  const receipt = worktreeRootReceipts.get(fixture);
  return receipt ? Object.freeze({ path: receipt.path, dev: receipt.dev, ino: receipt.ino }) : undefined;
}

function reportPreserved(root: string, reason: string): void {
  console.error(JSON.stringify({ status: "repo_fixture_preserved", reason, root }));
}

async function allocateOwnedRoot(prefix: string): Promise<OwnedRoot> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  let info;
  try { info = await lstat(path); }
  catch (error) {
    reportPreserved(path, "分配后的根身份无法确认");
    throw new PreserveFixtureRootError([error], `Repo夹具根身份无法确认；保全自有根 ${path}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    reportPreserved(path, "分配后的根不是自产真实目录");
    throw new PreserveFixtureRootError([], `Repo夹具根不是自产真实目录；保全路径 ${path}`);
  }
  return { path, dev: info.dev, ino: info.ino };
}

async function assertOwnedRoot(root: OwnedRoot): Promise<void> {
  let current;
  try { current = await lstat(root.path); }
  catch (error) {
    throw new PreserveFixtureRootError([error], `Repo夹具自产根身份复验失败；保全自有根 ${root.path}`);
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino) {
    throw new PreserveFixtureRootError([], `Repo夹具根归属已变化；保全自有根 ${root.path}`);
  }
}

function settledCommandFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
  return typeof value.code === "number" && value.killed !== true && value.signal == null;
}

function checkedHostGit(roots: readonly string[]) {
  try { return currentHostGit(roots); }
  catch (error) { throw new PreserveFixtureRootError([error], "Git固定绑定复验失败"); }
}

async function failCreation(root: OwnedRoot, error: unknown): Promise<never> {
  if (error instanceof PreserveFixtureRootError) {
    reportPreserved(root.path, error.message);
    throw new AggregateError([error], `Repo夹具创建失败；保全自有根 ${root.path}`);
  }
  let current;
  try { current = await lstat(root.path); }
  catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") throw error;
    reportPreserved(root.path, "自产根身份复验失败");
    throw new AggregateError([error, cleanupError], `Repo夹具清理前身份复验失败；保全自有根 ${root.path}`);
  }
  if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) {
    reportPreserved(root.path, "根归属已变化");
    throw new AggregateError([error], `Repo夹具根归属已变化；保全自有根 ${root.path}`);
  }
  try { await rm(root.path, { recursive: true, force: true }); }
  catch (cleanupError) {
    reportPreserved(root.path, "自产根清理未确认");
    throw new AggregateError([error, cleanupError], `Repo夹具清理失败；保全自有根 ${root.path}`);
  }
  throw error;
}

export interface RepoFixture {
  root: string;
  worktrees: string[];
}

export interface WorktreeFixture {
  root: string;
  branch: string;
}

export interface WorkspaceFixture {
  root: string;
  repos: string[];
}

export const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "pi-company-test",
  GIT_AUTHOR_EMAIL: "pi-company-test@example.com",
  GIT_COMMITTER_NAME: "pi-company-test",
  GIT_COMMITTER_EMAIL: "pi-company-test@example.com",
};

async function git(args: string[], cwd: string, owned: OwnedRoot): Promise<void> {
  const roots = [...new Set([cwd, owned.path])];
  await assertOwnedRoot(owned);
  const executablePath = checkedHostGit(roots).executablePath;
  try {
    await execFileAsync(executablePath, [...GIT_SETUP_CONFIG, ...args], { cwd, env: GIT_ENV, timeout: 10_000 });
  } catch (commandError) {
    try { await assertOwnedRoot(owned); }
    catch (ownershipError) {
      throw new PreserveFixtureRootError([commandError, ownershipError], "Git命令失败且自产根归属复验失败");
    }
    try { checkedHostGit(roots); }
    catch (bindingError) {
      throw new PreserveFixtureRootError([commandError, bindingError], "Git命令失败且固定绑定复验失败");
    }
    if (!settledCommandFailure(commandError)) {
      throw new PreserveFixtureRootError([commandError], "Git命令结束状态无法安全确认");
    }
    throw commandError;
  }
  await assertOwnedRoot(owned);
  checkedHostGit(roots);
}

async function initRepo(root: string, owned: OwnedRoot): Promise<void> {
  await assertOwnedRoot(owned);
  await mkdir(root, { recursive: true });
  await git(["init", "-b", "main"], root, owned);
  await assertOwnedRoot(owned);
  await writeFile(join(root, "README.md"), "pi-company test fixture\n");
  await git(["add", "README.md"], root, owned);
  await git(["commit", "-m", "initial commit"], root, owned);
  await assertOwnedRoot(owned);
}

export async function createRepoFixture(): Promise<RepoFixture> {
  initializeTestHostGit([]);
  const owned = await allocateOwnedRoot("pi-company-repo-");
  try {
    await assertOwnedRoot(owned);
    checkedHostGit([owned.path]);
    await initRepo(owned.path, owned);
    await assertOwnedRoot(owned);
    const fixture = { root: owned.path, worktrees: [] };
    repoRootReceipts.set(fixture, Object.freeze({ ...owned }));
    return fixture;
  } catch (error) {
    return failCreation(owned, error);
  }
}

const preparationQueues = new Map<string, Promise<void>>();

// Git枚举worktrees时可能看到另一条add尚未写完的元数据；仅同仓库准备步骤互斥。
async function prepareWorktree(repoRoot: string, branch: string, owned: OwnedRoot): Promise<void> {
  await assertOwnedRoot(owned);
  const key = await realpath(repoRoot);
  await assertOwnedRoot(owned);
  const previous = preparationQueues.get(key) ?? Promise.resolve();
  const pending = previous.then(() => git(["worktree", "add", "-b", branch, owned.path], repoRoot, owned));
  const settled = pending.then(() => {}, () => {});
  preparationQueues.set(key, settled);
  try {
    await pending;
    await assertOwnedRoot(owned);
  } finally { if (preparationQueues.get(key) === settled) preparationQueues.delete(key); }
}

export async function addWorktree(repo: RepoFixture): Promise<WorktreeFixture> {
  const repoRoot = repo.root;
  const worktrees = repo.worktrees;
  initializeTestHostGit([repoRoot]);
  const owned = await allocateOwnedRoot("pi-company-worktree-");
  const branch = `worktree-${basename(owned.path)}`;
  try {
    await assertOwnedRoot(owned);
    checkedHostGit([repoRoot, owned.path]);
    await prepareWorktree(repoRoot, branch, owned);
    await assertOwnedRoot(owned);
    worktrees.push(owned.path);
    const fixture = { root: owned.path, branch };
    worktreeRootReceipts.set(fixture, Object.freeze({ ...owned }));
    return fixture;
  } catch (error) {
    return failCreation(owned, error);
  }
}

export async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  initializeTestHostGit([]);
  const owned = await allocateOwnedRoot("pi-company-workspace-");
  const repoA = join(owned.path, "repo-a");
  const repoB = join(owned.path, "repo-b");
  try {
    await assertOwnedRoot(owned);
    checkedHostGit([owned.path]);
    await initRepo(repoA, owned);
    await initRepo(repoB, owned);
    await assertOwnedRoot(owned);
    await mkdir(join(owned.path, "node_modules", "decoy-package", ".git"), { recursive: true });
    await assertOwnedRoot(owned);
    return { root: owned.path, repos: [repoA, repoB] };
  } catch (error) {
    return failCreation(owned, error);
  }
}

export async function removeRepoFixture(fixture: RepoFixture | WorkspaceFixture): Promise<void> {
  if ("worktrees" in fixture) {
    for (const worktree of fixture.worktrees) {
      await rm(worktree, { recursive: true, force: true });
    }
  }
  await rm(fixture.root, { recursive: true, force: true });
}
