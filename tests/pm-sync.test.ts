import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPmSyncTool, syncTargetBranch } from "../runtime/pm-sync.ts";
import { localTargetBranch } from "../runtime/target-branch.ts";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** 主仓库在 main 上，需求 worktree 在 req 分支；withOrigin 时主仓库克隆自一个裸远端。 */
async function world(withOrigin = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pm-sync-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const main = join(base, "main"), worktree = join(base, "req"), remote = join(base, "remote.git"), other = join(base, "other");
  const identity = (cwd: string) => { git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); };
  if (withOrigin) {
    git(base, "init", "-q", "--bare", "-b", "main", remote);
    git(base, "clone", "-q", remote, other); identity(other);
    await writeFile(join(other, "a.ts"), "a\n"); git(other, "add", "."); git(other, "commit", "-qm", "seed"); git(other, "push", "-q", "origin", "main");
    git(base, "clone", "-q", remote, main);
  } else {
    git(base, "init", "-q", "-b", "main", main);
  }
  identity(main);
  if (!withOrigin) { await writeFile(join(main, "a.ts"), "a\n"); git(main, "add", "."); git(main, "commit", "-qm", "seed"); }
  git(main, "worktree", "add", "-q", "-b", "req", worktree);
  const commit = async (cwd: string, file: string, content: string, message: string) => { await writeFile(join(cwd, file), content); git(cwd, "add", file); git(cwd, "commit", "-qm", message); };
  const options = { repositoryRoot: main, worktree, branch: "refs/heads/req" };
  return { git, main, worktree, other, commit, options };
}

test("M8-AC9：目标分支前进后能 rebase 就 rebase，需求分支包含目标最新提交；已包含时不做任何事；有未提交改动时拒绝", async () => {
  const w = await world();
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  expect((await syncTargetBranch(w.options)).status).toBe("up_to_date");
  await w.commit(w.main, "c.ts", "c\n", "main 前进");
  const mainHead = w.git(w.main, "rev-parse", "HEAD"), before = w.git(w.worktree, "rev-parse", "HEAD");
  const result = await syncTargetBranch(w.options);
  expect(result).toMatchObject({ status: "rebased", target: "refs/heads/main", previousHead: before });
  expect(w.git(w.worktree, "log", "--format=%s", "-2").split("\n")).toEqual(["task-1", "main 前进"]);
  expect(w.git(w.worktree, "merge-base", "HEAD", mainHead)).toBe(mainHead);
  await writeFile(join(w.worktree, "b.ts"), "dirty\n");
  await expect(syncTargetBranch(w.options)).rejects.toThrow("worktree_dirty");
});

test("M8-AC9：rebase 冲突时改动合成一份重新应用到目标最新提交，冲突文件带标记、全部改动未暂存，分支不脱离，原提交可找回", async () => {
  const w = await world();
  await w.commit(w.worktree, "a.ts", "需求改的\n", "task-1");
  await w.commit(w.worktree, "b.ts", "b\n", "task-2");
  await w.commit(w.main, "a.ts", "别的需求改的\n", "main 改 a");
  const previousHead = w.git(w.worktree, "rev-parse", "HEAD");
  const result = await syncTargetBranch(w.options);
  expect(result).toMatchObject({ status: "conflicts", head: w.git(w.main, "rev-parse", "HEAD"), previousHead, conflicted: ["a.ts"] });
  expect(result.status === "conflicts" && [...result.changed].sort()).toEqual(["a.ts", "b.ts"]);
  expect(w.git(w.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/req");
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  expect(await readFile(join(w.worktree, "a.ts"), "utf8")).toMatch(/<<<<<<<[\s\S]*别的需求改的[\s\S]*需求改的[\s\S]*>>>>>>>/);
  expect(w.git(w.worktree, "cat-file", "-t", previousHead)).toBe("commit");
});

test("M8-AC9：有 origin 时拉取远端默认分支再同步，不联网的检查门槛使用拉取后的目标提交", async () => {
  const w = await world(true);
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.other, "c.ts", "c\n", "远端前进"); w.git(w.other, "push", "-q", "origin", "main");
  const result = await syncTargetBranch(w.options);
  expect(result).toMatchObject({ status: "rebased", target: "refs/remotes/origin/main" });
  expect(w.git(w.worktree, "log", "--format=%s", "-2").split("\n")).toEqual(["task-1", "远端前进"]);
  expect(await localTargetBranch(w.options.repositoryRoot, w.worktree)).toMatchObject({ name: "main", ref: "refs/remotes/origin/main", sha: w.git(w.other, "rev-parse", "HEAD") });
});

test("同步工具在会话失效、检查阶段或子代理执行期间拒绝", async () => {
  const w = await world();
  const state = { alive: true, check: false, quiet: true };
  const tool = createPmSyncTool({ ...w.options, alive: () => state.alive, checkPhaseActive: () => state.check, quiescent: () => state.quiet }) as unknown as
    { execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> };
  expect(JSON.parse((await tool.execute("s", {})).content[0]!.text)).toMatchObject({ status: "up_to_date" });
  state.quiet = false; await expect(tool.execute("s", {})).rejects.toThrow("writers_active");
  state.check = true; await expect(tool.execute("s", {})).rejects.toThrow("check_phase_active");
  state.alive = false; await expect(tool.execute("s", {})).rejects.toThrow("git_sync_denied");
});
