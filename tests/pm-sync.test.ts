import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPmSyncTool, syncTargetBranch } from "../src/modules/pm/pm-sync.ts";
import { localTargetBranch } from "../src/core/exec/target-branch.ts";
import type { DeliveryMode } from "../src/core/exec/git-host.ts";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const failureOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as Error).message; }
  throw new Error("没有报错");
};
function expectFailure(message: string, why: string, next: string) {
  expect(message).toMatch(/失败。\n原因：[\s\S]*\n建议：/u);
  expect(message).not.toMatch(/\b[a-z]+_[a-z_]+:/u);
  expect(message.split("\n原因：")[1]!.split("\n建议：")[0]).toContain(why);
  expect(message.split("\n建议：")[1]).toContain(next);
}
type Tool = { execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> };

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
  const delivery = { mode: "remote" as DeliveryMode };
  const options = { repositoryRoot: main, worktree, branch: "refs/heads/req", deliveryMode: async () => delivery.mode };
  const remoteRefs = () => git(main, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes");
  return { git, main, worktree, other, remote, commit, options, delivery, remoteRefs };
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
});

test("需求 worktree 有未提交改动时同步被拒，原因写未提交的改动，建议先用 git_commit 提交", async () => {
  const w = await world();
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.main, "c.ts", "c\n", "main 前进");
  const tool = createPmSyncTool({ ...w.options, alive: () => true, checkPhaseActive: () => false, quiescent: () => true }) as unknown as Tool;
  await writeFile(join(w.worktree, "b.ts"), "dirty\n");
  expectFailure(await failureOf(tool.execute("s", {})), "需求 worktree 里有未提交的改动", "先用 git_commit 提交这些改动，再同步");
});

test("当前分支不是需求分支时同步被拒，原因写明两个分支，建议停止操作交用户处理", async () => {
  const w = await world();
  const tool = createPmSyncTool({ ...w.options, alive: () => true, checkPhaseActive: () => false, quiescent: () => true }) as unknown as Tool;
  w.git(w.worktree, "checkout", "-q", "-b", "other");
  expectFailure(await failureOf(tool.execute("s", {})), "当前分支 refs/heads/other 不是需求分支 refs/heads/req", "停止操作，不要自己切换分支；交用户处理");
});

test("需求改动无法重新应用到目标分支且没有冲突文件时，原因写已恢复原提交，建议交用户处理而不再提冲突文件", async () => {
  const w = await world();
  await w.commit(w.worktree, "a.ts", "需求改的\n", "task-1");
  w.git(w.main, "rm", "-q", "a.ts"); w.git(w.main, "commit", "-qm", "main 删 a");
  const before = w.git(w.worktree, "rev-parse", "HEAD");
  const tool = createPmSyncTool({ ...w.options, alive: () => true, checkPhaseActive: () => false, quiescent: () => true }) as unknown as Tool;
  const message = await failureOf(tool.execute("s", {}));
  expectFailure(message, "需求改动无法重新应用到目标分支，已恢复原提交", "用户");
  expect(message.split("\n建议：")[1]).not.toContain("冲突文件");
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(before);
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
  expect(await localTargetBranch(w.options.repositoryRoot, w.worktree, "remote")).toMatchObject({ name: "main", ref: "refs/remotes/origin/main", sha: w.git(w.other, "rev-parse", "HEAD") });
});

test("origin 是从未推送过的空裸仓库时同步失败，原因写无法确定远端默认分支，建议让用户先推送目标分支或设好远端默认分支", async () => {
  const w = await world();
  const empty = join(dirname(w.main), "empty.git");
  w.git(w.main, "init", "-q", "--bare", empty);
  w.git(w.main, "remote", "add", "origin", empty);
  const tool = createPmSyncTool({ ...w.options, alive: () => true, checkPhaseActive: () => false, quiescent: () => true }) as unknown as Tool;
  const message = await failureOf(tool.execute("s", {}));
  expectFailure(message, "无法确定远端默认分支", "用户");
  const [reason, advice] = [message.split("\n原因：")[1]!.split("\n建议：")[0]!, message.split("\n建议：")[1]!];
  expect(reason).not.toContain("target_unknown");
  expect(reason).not.toContain("未归类");
  expect(advice).not.toContain("重试");
});

test("同步工具在会话失效、检查阶段或子代理执行期间拒绝", async () => {
  const w = await world();
  const state = { alive: true, check: false, quiet: true };
  const tool = createPmSyncTool({ ...w.options, alive: () => state.alive, checkPhaseActive: () => state.check, quiescent: () => state.quiet }) as unknown as Tool;
  expect(JSON.parse((await tool.execute("s", {})).content[0]!.text)).toMatchObject({ status: "up_to_date" });
  state.quiet = false; expectFailure(await failureOf(tool.execute("s", {})), "子代理执行或受管写入还没结束", "等子代理结束后再同步");
  state.check = true; expectFailure(await failureOf(tool.execute("s", {})), "检查阶段进行中，不能同步", "等检查轮结束后再同步");
  state.alive = false; expectFailure(await failureOf(tool.execute("s", {})), "PM 会话已失效，不能再同步", "停止操作，不要重试");
});

const alive = { alive: () => true, checkPhaseActive: () => false, quiescent: () => true };

test("仅本地档位且有 origin：同步到主仓库当前分支的最新提交，不包含只在 origin 上的提交，也不更新 refs/remotes", async () => {
  const w = await world(true);
  w.delivery.mode = "local";
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.other, "c.ts", "c\n", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  await w.commit(w.main, "d.ts", "d\n", "只在本地 main");
  const refsBefore = w.remoteRefs();
  const result = await syncTargetBranch(w.options);
  expect(result).toMatchObject({ status: "rebased", target: "refs/heads/main", head: w.git(w.worktree, "rev-parse", "HEAD") });
  expect(w.git(w.worktree, "log", "--format=%s", "-2").split("\n")).toEqual(["task-1", "只在本地 main"]);
  expect(w.git(w.worktree, "merge-base", "--is-ancestor", w.git(w.main, "rev-parse", "main"), "HEAD")).toBe("");
  expect(w.git(w.worktree, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("c.ts");
  expect(w.remoteRefs()).toBe(refsBefore);
});

test("仅本地档位且 origin 比本地 main 多一个提交：需求分支已包含本地 main，同步什么都不做，不拉取", async () => {
  const w = await world(true);
  w.delivery.mode = "local";
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.other, "c.ts", "c\n", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  const before = w.git(w.worktree, "rev-parse", "HEAD"), refsBefore = w.remoteRefs();
  expect(await syncTargetBranch(w.options)).toMatchObject({ status: "up_to_date", target: "refs/heads/main", head: before });
  expect(w.remoteRefs()).toBe(refsBefore);
});

test("仅本地档位时 origin 连不上也能同步，整个过程不联网", async () => {
  const w = await world(true);
  w.delivery.mode = "local";
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.main, "d.ts", "d\n", "只在本地 main");
  w.git(w.main, "remote", "set-url", "origin", join(dirname(w.main), "不存在.git"));
  expect(await syncTargetBranch(w.options)).toMatchObject({ status: "rebased", target: "refs/heads/main" });
});

test("仅本地档位且没有 origin：同步到主仓库当前分支", async () => {
  const w = await world();
  w.delivery.mode = "local";
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.main, "c.ts", "c\n", "main 前进");
  expect(await syncTargetBranch(w.options)).toMatchObject({ status: "rebased", target: "refs/heads/main" });
  expect(w.git(w.worktree, "log", "--format=%s", "-2").split("\n")).toEqual(["task-1", "main 前进"]);
});

test("档位每次用到时重新读：同一个同步工具先按仅本地、再按远程档位，目标分支随之变化", async () => {
  const w = await world(true);
  w.delivery.mode = "local";
  await w.commit(w.worktree, "b.ts", "b\n", "task-1");
  await w.commit(w.other, "c.ts", "c\n", "只在远端"); w.git(w.other, "push", "-q", "origin", "main");
  const tool = createPmSyncTool({ ...w.options, ...alive }) as unknown as Tool;
  expect(JSON.parse((await tool.execute("s", {})).content[0]!.text)).toMatchObject({ status: "up_to_date", target: "refs/heads/main" });
  w.delivery.mode = "remote";
  expect(JSON.parse((await tool.execute("s", {})).content[0]!.text)).toMatchObject({ status: "rebased", target: "refs/remotes/origin/main" });
  expect(w.git(w.worktree, "log", "--format=%s", "-2").split("\n")).toEqual(["task-1", "只在远端"]);
});

test("仅本地档位下主仓库是 detached HEAD：同步失败，原因写主仓库当前没有检出分支，建议请用户在主仓库检出要合进去的分支", async () => {
  const w = await world();
  w.delivery.mode = "local";
  w.git(w.main, "checkout", "-q", "--detach");
  const tool = createPmSyncTool({ ...w.options, ...alive }) as unknown as Tool;
  expectFailure(await failureOf(tool.execute("s", {})), "主仓库当前没有检出分支", "请用户在主仓库检出要合进去的分支后再继续");
});
