import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: GIT_ENV, timeout: 10_000 });
}

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(["init", "-b", "main"], root);
  await writeFile(join(root, "README.md"), "pi-company test fixture\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "initial commit"], root);
}

async function initRepoOrClean(root: string): Promise<void> {
  try {
    await initRepo(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createRepoFixture(): Promise<RepoFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-repo-"));
  await initRepoOrClean(root);
  return { root, worktrees: [] };
}

export async function addWorktree(repo: RepoFixture): Promise<WorktreeFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-worktree-"));
  const branch = `worktree-${basename(root)}`;
  try {
    await git(["worktree", "add", "-b", branch, root], repo.root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  repo.worktrees.push(root);
  return { root, branch };
}

export async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-workspace-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  try {
    await initRepo(repoA);
    await initRepo(repoB);
    await mkdir(join(root, "node_modules", "decoy-package", ".git"), { recursive: true });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { root, repos: [repoA, repoB] };
}

export async function removeRepoFixture(fixture: RepoFixture | WorkspaceFixture): Promise<void> {
  if ("worktrees" in fixture) {
    for (const worktree of fixture.worktrees) {
      await rm(worktree, { recursive: true, force: true });
    }
  }
  await rm(fixture.root, { recursive: true, force: true });
}
