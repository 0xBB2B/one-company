import { withDatabase, uuidv7 } from "../runtime/database.ts";
import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  addWorktree,
  createRepoFixture,
  createWorkspaceFixture,
  removeRepoFixture,
} from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import {
  dataRoot,
  daemonSocketPath,
  discoverWorkspace,
  isInsideRepository,
  listWorktrees,
  repoDataDir,
  repositoryIdentity,
} from "../runtime/identity.ts";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "one-company-test",
  GIT_AUTHOR_EMAIL: "one-company-test@example.com",
  GIT_COMMITTER_NAME: "one-company-test",
  GIT_COMMITTER_EMAIL: "one-company-test@example.com",
};

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, env: GIT_ENV, timeout: 10_000 });
}

async function initGitRepoAt(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  await writeFile(join(dir, "README.md"), "one-company depth fixture\n");
  await git(["add", "README.md"], dir);
  await git(["commit", "-m", "initial commit"], dir);
}

const repoFixtures: Array<{ root: string; worktrees: string[] } | { root: string; repos: string[] }> = [];
const tempRoots: string[] = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) {
    await removeRepoFixture(fixture);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  for (const home of tempHomes.splice(0)) {
    await removeTempHome(home);
  }
});

describe("repositoryIdentity", () => {
  test("同一仓库的主工作树与其 worktree 身份相同", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const main = await repositoryIdentity(repo.root);
    const wt = await repositoryIdentity(worktree.root);
    expect(wt.repoId).toBe(main.repoId);
    expect(wt.commonDir).toBe(main.commonDir);
  });

  test("不同仓库即使同名也身份不同", async () => {
    const parentA = await mkdtemp(join(tmpdir(), "one-company-namesake-"));
    tempRoots.push(parentA);
    const repoAPath = join(parentA, "same-name");
    await initGitRepoAt(repoAPath);
    const parentB = await mkdtemp(join(tmpdir(), "one-company-namesake-"));
    tempRoots.push(parentB);
    const repoBPath = join(parentB, "same-name");
    await initGitRepoAt(repoBPath);
    const a = await repositoryIdentity(repoAPath);
    const b = await repositoryIdentity(repoBPath);
    expect(a.repoId).not.toBe(b.repoId);
  });

  test("重命名分支后身份不变", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const before = await repositoryIdentity(repo.root);
    await git(["branch", "-m", "renamed-branch"], repo.root);
    const after = await repositoryIdentity(repo.root);
    expect(after.repoId).toBe(before.repoId);
  });

  test("从仓库内子目录调用身份不变", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const subdir = join(repo.root, "nested", "deep");
    await mkdir(subdir, { recursive: true });
    const top = await repositoryIdentity(repo.root);
    const nested = await repositoryIdentity(subdir);
    expect(nested.repoId).toBe(top.repoId);
  });

  test("repoId 为仓库 common dir realpath 的 sha256 十六进制", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const expected = createHash("sha256").update(await realpath(join(repo.root, ".git"))).digest("hex");
    expect(identity.repoId).toBe(expected);
  });

  test("非 Git 目录抛出不是 Git 仓库的错误", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "one-company-plain-"));
    tempRoots.push(plainDir);
    await expect(repositoryIdentity(plainDir)).rejects.toThrow("不是 Git 仓库");
  });

  test("目录不存在时抛出的错误消息含路径且不含不是 Git 仓库", async () => {
    const parent = await mkdtemp(join(tmpdir(), "one-company-missing-"));
    tempRoots.push(parent);
    const missing = join(parent, "does-not-exist");
    let caught: Error | undefined;
    try {
      await repositoryIdentity(missing);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain(missing);
    expect(caught?.message).not.toContain("不是 Git 仓库");
  });
});

describe("discoverWorkspace", () => {
  test("从父目录发现两个独立仓库且不含 node_modules 下的伪仓库", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const found = await discoverWorkspace(workspace.root);
    const paths = found.repos.map((r) => r.path).sort();
    expect(paths).toEqual((await Promise.all(workspace.repos.map((repo) => realpath(repo)))).sort());
    for (const repo of found.repos) {
      expect(repo.path).not.toContain("node_modules");
    }
  });

  test("深度 4 层的仓库可被发现", async () => {
    const parent = await mkdtemp(join(tmpdir(), "one-company-depth-"));
    tempRoots.push(parent);
    const repoAtDepth4 = join(parent, "l1", "l2", "l3", "l4");
    await initGitRepoAt(repoAtDepth4);
    const found = await discoverWorkspace(parent);
    expect(found.repos.map((r) => r.path)).toContain(await realpath(repoAtDepth4));
  });

  test("深度 5 层的仓库同样被递归发现", async () => {
    const parent = await mkdtemp(join(tmpdir(), "one-company-depth-"));
    tempRoots.push(parent);
    const repoAtDepth5 = join(parent, "m1", "m2", "m3", "m4", "m5");
    await initGitRepoAt(repoAtDepth5);
    const found = await discoverWorkspace(parent);
    expect(found.repos.map((r) => r.path)).toContain(await realpath(repoAtDepth5));
  });

  test("从仓库内启动只返回该仓库", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const [repoA] = workspace.repos;
    const found = await discoverWorkspace(repoA);
    expect(found.repos.length).toBe(1);
    expect(await realpath(found.repos[0]?.path ?? "")).toBe(await realpath(repoA));
  });

  test("从 worktree 内启动只返回该仓库", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const found = await discoverWorkspace(worktree.root);
    expect(found.repos.length).toBe(1);
    expect(found.repos[0]?.repoId).toBe((await repositoryIdentity(repo.root)).repoId);
  });

  test("从仓库根的普通子目录启动时成员 path 为仓库根", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const workdir = join(repo.root, "workdir");
    await mkdir(workdir, { recursive: true });
    const found = await discoverWorkspace(workdir);
    expect(found.repos.length).toBe(1);
    expect(await realpath(found.repos[0]?.path ?? "")).toBe(await realpath(repo.root));
  });

  test("从 worktree 的普通子目录启动时成员 path 为 worktree 根", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const workdir = join(worktree.root, "workdir");
    await mkdir(workdir, { recursive: true });
    const found = await discoverWorkspace(workdir);
    expect(found.repos.length).toBe(1);
    expect(await realpath(found.repos[0]?.path ?? "")).toBe(await realpath(worktree.root));
  });

  test("含不可读子目录时仍发现其余仓库并记录 skipped", async () => {
    const parent = await mkdtemp(join(tmpdir(), "one-company-skip-"));
    tempRoots.push(parent);
    const repoA = join(parent, "repo-a");
    await initGitRepoAt(repoA);
    const blockedDir = join(parent, "blocked");
    await mkdir(blockedDir, { recursive: true });
    await chmod(blockedDir, 0o000);
    try {
      const found = await discoverWorkspace(parent);
      expect(found.repos.map((r) => r.path)).toContain(await realpath(repoA));
      const skippedEntry = found.skipped.find((s) => s.path === blockedDir);
      expect(skippedEntry).toBeDefined();
      expect(skippedEntry?.reason).toBeTruthy();
    } finally {
      await chmod(blockedDir, 0o700);
    }
  });

  test("无不可读目录时 skipped 为空数组", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const found = await discoverWorkspace(workspace.root);
    expect(found.skipped).toEqual([]);
  });
});

describe("isInsideRepository", () => {
  test("仓库内返回 true", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    expect(await isInsideRepository(repo.root)).toBe(true);
  });

  test("worktree 内返回 true", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    expect(await isInsideRepository(worktree.root)).toBe(true);
  });

  test("非 Git 目录返回 false", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "one-company-plain-"));
    tempRoots.push(plainDir);
    expect(await isInsideRepository(plainDir)).toBe(false);
  });
});

describe("listWorktrees", () => {
  test("包含主工作树与新增的 worktree 路径", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const worktrees = await listWorktrees(repo.root);
    expect(worktrees).toContain(await realpath(repo.root));
    expect(worktrees).toContain(await realpath(worktree.root));
  });

  test("rm -rf 删除 worktree 且未 prune 时不返回该已删除路径", async () => {
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const worktreeRealPath = await realpath(worktree.root);
    await rm(worktree.root, { recursive: true, force: true });
    const worktrees = await listWorktrees(repo.root);
    expect(worktrees).toContain(await realpath(repo.root));
    expect(worktrees).not.toContain(worktreeRealPath);
  });

  test("对非 Git 目录调用抛出不是 Git 仓库的错误", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "one-company-plain-"));
    tempRoots.push(plainDir);
    await expect(listWorktrees(plainDir)).rejects.toThrow("不是 Git 仓库");
  });
});

describe("dataRoot", () => {
  test("设置 PI_CODING_AGENT_DIR 时以其为准", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const customAgentDir = join(home.home, "custom-agent-dir");
    const env = { ...home.env, PI_CODING_AGENT_DIR: customAgentDir };
    expect(dataRoot(env)).toBe(join(customAgentDir, "one-company"));
  });

  test("未设置 PI_CODING_AGENT_DIR 时回退到 HOME/.pi/agent", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const env = { ...home.env };
    delete env.PI_CODING_AGENT_DIR;
    expect(dataRoot(env)).toBe(join(home.home, ".pi", "agent", "one-company"));
  });

  test("HOME 与 PI_CODING_AGENT_DIR 都缺失时抛出含 HOME 的错误", () => {
    expect(() => dataRoot({})).toThrow("HOME");
  });

  test("PI_CODING_AGENT_DIR 非绝对路径时抛出错误", () => {
    expect(() => dataRoot({ HOME: "/tmp/one-company-home", PI_CODING_AGENT_DIR: "relative/dir" })).toThrow();
  });

  test("HOME 非绝对路径时抛出错误", () => {
    expect(() => dataRoot({ HOME: "relative/home" })).toThrow();
  });
});

describe("repoDataDir", () => {
  test("首次访问创建目录并写入 SQLite 仓库记录", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const dir = await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    const parsed = withDatabase(join(dir, "data.db"), (db) => db.read("repository", identity.repoId)!.data);
    expect(parsed.commonDir).toBe(identity.commonDir);
    expect(parsed.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("目录权限为 0o700", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const dir = await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    const info = await stat(dir);
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("第二次访问不改写 firstSeenAt", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const dir = await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    const first = withDatabase(join(dir, "data.db"), (db) => db.read("repository", identity.repoId)!.data);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    const second = withDatabase(join(dir, "data.db"), (db) => db.read("repository", identity.repoId)!.data);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
  });

  test("返回路径不在仓库目录内", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const dir = await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    expect(dir.startsWith(repo.root)).toBe(false);
  });

  test("删除 worktree 后仓库数据目录仍可访问", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const identity = await repositoryIdentity(repo.root);
    const dir = await repoDataDir(home.dataRoot, identity.repoId, identity.commonDir);
    await writeFile(join(dir, "marker.txt"), "kept\n");
    await git(["worktree", "remove", "--force", worktree.root], repo.root);
    repo.worktrees = repo.worktrees.filter((w) => w !== worktree.root);
    const marker = await readFile(join(dir, "marker.txt"), "utf8");
    expect(marker).toBe("kept\n");
  });

  test("umask 0o022 下首次创建的三层目录与 SQLite 仓库记录 权限符合预期", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    const freshRoot = join(home.home, "fresh-data-root");
    const previousUmask = process.umask(0o022);
    try {
      const dir = await repoDataDir(freshRoot, identity.repoId, identity.commonDir);
      const rootInfo = await stat(freshRoot);
      const reposInfo = await stat(join(freshRoot, "repos"));
      const leafInfo = await stat(dir);
      const databaseInfo = await stat(join(dir, "data.db"));
      expect(rootInfo.mode & 0o777).toBe(0o700);
      expect(reposInfo.mode & 0o777).toBe(0o700);
      expect(leafInfo.mode & 0o777).toBe(0o700);
      expect(databaseInfo.mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe("daemonSocketPath", () => {
  test("返回数据根 sock 目录下以 repoId 前 16 位命名的 socket 路径", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const identity = await repositoryIdentity(repo.root);
    expect(daemonSocketPath(home.dataRoot, identity.repoId)).toBe(
      join(home.dataRoot, "sock", `${identity.repoId.slice(0, 16)}.sock`),
    );
  });

  test("同仓库不同 worktree 得到相同守护进程路径", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const mainIdentity = await repositoryIdentity(repo.root);
    const worktreeIdentity = await repositoryIdentity(worktree.root);
    expect(daemonSocketPath(home.dataRoot, worktreeIdentity.repoId)).toBe(
      daemonSocketPath(home.dataRoot, mainIdentity.repoId),
    );
  });
});

describe("git 判定不依赖环境", () => {
  test("中文 locale 下非 Git 目录仍抛出不是 Git 仓库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-nongit-"));
    tempRoots.push(dir);
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = "zh_CN.UTF-8";
    try {
      await expect(repositoryIdentity(dir)).rejects.toThrow("不是 Git 仓库");
      await expect(listWorktrees(dir)).rejects.toThrow("不是 Git 仓库");
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  });

  test("父目录扫描与仓库内启动得到的成员 path 完全相同", async () => {
    const workspace = await createWorkspaceFixture();
    repoFixtures.push(workspace);
    const fromParent = await discoverWorkspace(workspace.root);
    const fromInside = await discoverWorkspace(workspace.repos[0]!);
    expect(fromParent.repos.map((r) => r.path)).toContain(fromInside.repos[0]?.path);
  });
});
