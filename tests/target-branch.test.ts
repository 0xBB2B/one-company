import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedOutBranch, fetchTargetBranch, gitIn, localTargetBranch } from "../src/core/exec/target-branch.ts";
import { AdvisedError } from "../src/core/exec/tool-failure.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function world(withOrigin: boolean) {
  const base = await realpath(await mkdtemp(join(temporaryRoot(), "tb-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const main = join(base, "main"), worktree = join(base, "req"), remote = join(base, "remote.git"), other = join(base, "other");
  const identity = (cwd: string) => { git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); };
  const commit = async (cwd: string, file: string, message: string) => { await writeFile(join(cwd, file), `${message}\n`); git(cwd, "add", file); git(cwd, "commit", "-qm", message); };
  if (withOrigin) {
    git(base, "init", "-q", "--bare", "-b", "main", remote);
    git(base, "clone", "-q", remote, other); identity(other);
    await commit(other, "a.ts", "seed"); git(other, "push", "-q", "origin", "main");
    git(base, "clone", "-q", remote, main); identity(main);
  } else {
    git(base, "init", "-q", "-b", "main", main); identity(main);
    await commit(main, "a.ts", "seed");
  }
  git(main, "worktree", "add", "-q", "-b", "req", worktree);
  return { git, main, worktree, other, commit };
}

test("checkedOutBranch：返回主仓库当前检出的分支，即使有 origin 也不取远端", async () => {
  const w = await world(true);
  await w.commit(w.main, "b.ts", "本地前进");
  expect(await checkedOutBranch(w.main, w.worktree)).toEqual({ name: "main", ref: "refs/heads/main", remote: null, sha: w.git(w.main, "rev-parse", "main") });
});

test("checkedOutBranch：主仓库检出别的分支时返回那个分支", async () => {
  const w = await world(false);
  w.git(w.main, "checkout", "-q", "-b", "release");
  expect(await checkedOutBranch(w.main, w.worktree)).toMatchObject({ name: "release", ref: "refs/heads/release", remote: null });
});

test("checkedOutBranch：主仓库 detached HEAD 时报错，原因写主仓库当前没有检出分支，建议请用户检出要合进去的分支", async () => {
  const w = await world(false);
  w.git(w.main, "checkout", "-q", "--detach");
  const error = await checkedOutBranch(w.main, w.worktree).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AdvisedError);
  expect((error as AdvisedError).advice).toEqual({ why: "主仓库当前没有检出分支", next: "请用户在主仓库检出要合进去的分支后再继续" });
});

test.each(["fetchTargetBranch", "localTargetBranch"] as const)("%s 仅本地档位且有 origin：取主仓库当前分支，不取 origin 的默认分支", async (name) => {
  const w = await world(true);
  await w.commit(w.other, "c.ts", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  w.git(w.main, "fetch", "-q", "origin");
  await w.commit(w.main, "d.ts", "只在本地");
  const find = name === "fetchTargetBranch" ? fetchTargetBranch : localTargetBranch;
  expect(await find(w.main, w.worktree, "local")).toEqual({ name: "main", ref: "refs/heads/main", remote: null, sha: w.git(w.main, "rev-parse", "main") });
});

test("fetchTargetBranch 仅本地档位：origin 连不上也不报错，不更新 refs/remotes", async () => {
  const w = await world(true);
  await w.commit(w.other, "c.ts", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  const refsBefore = w.git(w.main, "for-each-ref", "refs/remotes");
  w.git(w.main, "remote", "set-url", "origin", join(w.main, "不存在.git"));
  expect(await fetchTargetBranch(w.main, w.worktree, "local")).toMatchObject({ ref: "refs/heads/main", remote: null });
  expect(w.git(w.main, "for-each-ref", "refs/remotes")).toBe(refsBefore);
});

test("fetchTargetBranch 远程档位且有 origin：拉取并返回 origin 的默认分支", async () => {
  const w = await world(true);
  await w.commit(w.other, "c.ts", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  expect(await fetchTargetBranch(w.main, w.worktree, "remote")).toEqual({ name: "main", ref: "refs/remotes/origin/main", remote: "origin", sha: w.git(w.other, "rev-parse", "HEAD") });
});

test("远程档位没有 origin：取主仓库当前分支", async () => {
  const w = await world(false);
  const expected = { name: "main", ref: "refs/heads/main", remote: null, sha: w.git(w.main, "rev-parse", "main") };
  expect(await fetchTargetBranch(w.main, w.worktree, "remote")).toEqual(expected);
  expect(await localTargetBranch(w.main, w.worktree, "remote")).toEqual(expected);
});

test("localTargetBranch 远程档位有 origin：取上次拉取记下的远端默认分支，从未拉取过则报 sync_required", async () => {
  const w = await world(true);
  w.git(w.main, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  await expect(localTargetBranch(w.main, w.worktree, "remote")).rejects.toThrow(/sync_required/);
  await fetchTargetBranch(w.main, w.worktree, "remote");
  expect(await localTargetBranch(w.main, w.worktree, "remote")).toMatchObject({ name: "main", ref: "refs/remotes/origin/main", remote: "origin" });
});

test("localTargetBranch 仅本地档位：从未拉取过 origin 也不报 sync_required", async () => {
  const w = await world(true);
  w.git(w.main, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  expect(await localTargetBranch(w.main, w.worktree, "local")).toMatchObject({ ref: "refs/heads/main", remote: null });
});

test("checkedOutBranch：主仓库目录已不是 Git 仓库时报 Git 的原始错误，不说没检出分支", async () => {
  const dir = await mkdtemp(join(temporaryRoot(), "not-repo-"));
  const error = await checkedOutBranch(dir, dir).then(() => null, (e: unknown) => e as Error & { advice?: { why: string } });
  expect(error).toBeInstanceOf(Error);
  expect(error?.advice?.why).not.toBe("主仓库当前没有检出分支");
  await rm(dir, { recursive: true, force: true });
});

test("gitIn：Git 不读完标准输入就退出时，照常返回 Git 的结果，写入出错不让进程崩溃", async () => {
  const w = await world(false);
  const result = await gitIn(w.main, ["rev-parse", "HEAD"], "x".repeat(4 * 1024 * 1024));
  expect(result.stdout.trim()).toBe(w.git(w.main, "rev-parse", "HEAD"));
});
