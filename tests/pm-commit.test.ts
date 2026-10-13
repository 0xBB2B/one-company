import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPmCommitTool } from "../runtime/pm-commit.ts";

const REQUIREMENT = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-commit-")));
  cleanups.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "req-branch");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  await writeFile(join(root, "a.ts"), "a\n"); await writeFile(join(root, "old.ts"), "old\n");
  git("add", "."); git("commit", "-qm", "seed");
  return { root, git };
}
const run = (tool: ReturnType<typeof createPmCommitTool>, params: unknown) =>
  (tool as unknown as { execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }> }).execute("c", params);

test("PM 只提交列出的文件（含删除），保留其他已暂存内容，提交说明末尾由程序加上需求编号，返回提交编号", async () => {
  const r = await repo();
  let checkPhase = false;
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => checkPhase,
    writeScope: () => ["a.ts", "b.ts", "old.ts"] });
  await writeFile(join(r.root, "a.ts"), "a2\n"); await writeFile(join(r.root, "b.ts"), "b\n"); await unlink(join(r.root, "old.ts"));
  await writeFile(join(r.root, "staged.ts"), "s\n"); r.git("add", "staged.ts");
  const result = JSON.parse((await run(tool, { paths: ["a.ts", "b.ts", "old.ts"], message: "task-1: 完成登录" })).content[0]!.text);
  expect(result.commit).toBe(r.git("rev-parse", "HEAD"));
  expect(r.git("show", "--name-status", "--format=", "HEAD").split("\n").sort()).toEqual(["A\tb.ts", "D\told.ts", "M\ta.ts"]);
  expect(r.git("diff", "--cached", "--name-only")).toBe("staged.ts");
  expect(r.git("log", "-1", "--format=%s")).toBe("task-1: 完成登录");
  expect(r.git("log", "-1", "--format=%(trailers:key=Requirement,valueonly)")).toBe(REQUIREMENT);

  checkPhase = true;
  await writeFile(join(r.root, "a.ts"), "a3\n");
  await expect(run(tool, { paths: ["a.ts"], message: "x" })).rejects.toThrow("check_phase_active");
});

test("拒绝 .git、归档与越界路径；分支被切换或会话失效时拒绝", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false, writeScope: () => ["a.ts"] });
  for (const path of [".git/config", "docs/prod/x.md", "AGENTS.md", "../x.ts", "/abs.ts"]) {
    await expect(run(tool, { paths: [path], message: "x" })).rejects.toThrow("forbidden_path");
  }
  r.git("checkout", "-q", "-b", "other");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  await expect(run(tool, { paths: ["a.ts"], message: "x" })).rejects.toThrow("branch_changed");
  const dead = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/other", alive: () => false, checkPhaseActive: () => false, writeScope: () => ["a.ts"] });
  await expect(run(dead, { paths: ["a.ts"], message: "x" })).rejects.toThrow("git_commit_denied");
});

test("提交的路径不在本需求任务写入范围内时整次拒绝、什么都不提交，并写明是哪些文件", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => ["src/", "a.ts"] });
  const head = r.git("rev-parse", "HEAD");
  await mkdir(join(r.root, "src"), { recursive: true });
  for (const path of ["src/login.ts", "package.json", "go.sum"]) await writeFile(join(r.root, path), "x\n");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  const rejected = run(tool, { paths: ["src/login.ts", "a.ts", "package.json", "go.sum"], message: "x" });
  await expect(rejected).rejects.toThrow(/out_of_scope.*package\.json、go\.sum/u);
  await expect(rejected).rejects.not.toThrow(/src\/login\.ts/u);
  expect(r.git("rev-parse", "HEAD")).toBe(head);
  expect(r.git("diff", "--cached", "--name-only")).toBe("");
  await run(tool, { paths: ["src/login.ts", "./a.ts"], message: "login" });
  expect(r.git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.ts", "src/login.ts"]);
});

test("提交路径含项目设置文件时报 forbidden_path、不提交", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => [".pi/", "a.ts"] });
  await mkdir(join(r.root, ".pi"), { recursive: true });
  await writeFile(join(r.root, ".pi", "settings.json"), "{}\n");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  const head = r.git("rev-parse", "HEAD");
  for (const path of [".pi/settings.json", ".PI/Settings.json"]) {
    await expect(run(tool, { paths: ["a.ts", path], message: "x" })).rejects.toThrow("forbidden_path");
  }
  expect(r.git("rev-parse", "HEAD")).toBe(head);
});
