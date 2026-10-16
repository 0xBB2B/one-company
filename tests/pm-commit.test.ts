import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPmCommitTool } from "../src/modules/pm/pm-commit.ts";

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
const failureOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as Error).message; }
  throw new Error("没有报错");
};
function expectFailure(message: string, why: string | RegExp, next: string | RegExp) {
  expect(message).toMatch(/失败。\n原因：[\s\S]*\n建议：/u);
  expect(message).not.toMatch(/^[a-z]+(_[a-z]+)*:/u);
  expect(message).not.toMatch(/\b[a-z]+_[a-z_]+:/u);
  const reason = message.split("\n原因：")[1]!.split("\n建议：")[0]!, advice = message.split("\n建议：")[1]!;
  if (typeof why === "string") expect(reason).toContain(why); else expect(reason).toMatch(why);
  if (typeof next === "string") expect(advice).toContain(next); else expect(advice).toMatch(next);
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
  expectFailure(await failureOf(run(tool, { paths: ["a.ts"], message: "x" })), "检查阶段进行中，不能提交", "等检查轮结束后再提交");
});

const PROTECTED_ADVICE = "把它从 paths 里去掉，再提交其余文件";
const PROTECTED_PATHS: Array<[string, string]> = [
  [".git/config", "这是 Git 元数据，不能提交：.git/config"],
  ["src/.GIT/x", "这是 Git 元数据，不能提交：src/.GIT/x"],
  ["docs/prd/x.md", "这是需求归档目录，由程序在关闭需求时写入，不能提交：docs/prd/x.md"],
  ["AGENTS.md", "这是项目规范文件 AGENTS.md，只能经用户确认后修改，不能提交：AGENTS.md"],
  [".pi/settings.json", "这是 pi 的项目设置文件，只能由用户修改，不能提交：.pi/settings.json"],
  [".PI/Settings.json", "这是 pi 的项目设置文件，只能由用户修改，不能提交：.PI/Settings.json"],
  [".pi/agents/qa.md", "这是角色定义或 skills 目录，只能由用户修改，不能提交：.pi/agents/qa.md"],
  [".pi/skills/s/SKILL.md", "这是角色定义或 skills 目录，只能由用户修改，不能提交：.pi/skills/s/SKILL.md"],
  [".PI/Agents/qa.md", "这是角色定义或 skills 目录，只能由用户修改，不能提交：.PI/Agents/qa.md"],
  ["../x.ts", "路径在需求 worktree 之外或写法不合规：../x.ts"],
  ["/abs.ts", "路径在需求 worktree 之外或写法不合规：/abs.ts"],
];

test("路径本身是受保护的文件或越界路径时整次拒绝，错误按原因和建议写明路径，HEAD 不变", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => ["a.ts", ".git/", "src/", "docs/", "AGENTS.md", ".pi/", ".PI/"] });
  const head = r.git("rev-parse", "HEAD");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  for (const [path, why] of PROTECTED_PATHS) {
    expectFailure(await failureOf(run(tool, { paths: ["a.ts", path], message: "x" })), why, PROTECTED_ADVICE);
  }
  expect(r.git("rev-parse", "HEAD")).toBe(head);
});

test("分支被切换时拒绝并写明当前分支与需求分支；会话失效时拒绝并让模型停止操作", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false, writeScope: () => ["a.ts"] });
  r.git("checkout", "-q", "-b", "other");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  expectFailure(await failureOf(run(tool, { paths: ["a.ts"], message: "x" })), "当前分支 refs/heads/other 不是需求分支 refs/heads/req-branch", "停止操作，不要自己切换分支；交用户处理");
  const dead = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/other", alive: () => false, checkPhaseActive: () => false, writeScope: () => ["a.ts"] });
  expectFailure(await failureOf(run(dead, { paths: ["a.ts"], message: "x" })), "PM 会话已失效，不能再提交", "停止操作，不要重试");
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
  const message = await failureOf(rejected);
  expectFailure(message, "package.json、go.sum 不在本需求任何任务的写入范围内，这次提交没有执行", "先把它们从 paths 里去掉再提交其余文件");
  expect(message).not.toMatch(/src\/login\.ts/u);
  expect(r.git("rev-parse", "HEAD")).toBe(head);
  expect(r.git("diff", "--cached", "--name-only")).toBe("");
  await run(tool, { paths: ["src/login.ts", "./a.ts"], message: "login" });
  expect(r.git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["a.ts", "src/login.ts"]);
});

test("提交路径含项目设置文件时按受保护文件拒绝、不提交", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => [".pi/", "a.ts"] });
  await mkdir(join(r.root, ".pi"), { recursive: true });
  await writeFile(join(r.root, ".pi", "settings.json"), "{}\n");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  const head = r.git("rev-parse", "HEAD");
  for (const path of [".pi/settings.json", ".PI/Settings.json"]) {
    expectFailure(await failureOf(run(tool, { paths: ["a.ts", path], message: "x" })), "这是 pi 的项目设置文件，只能由用户修改，不能提交", PROTECTED_ADVICE);
  }
  expect(r.git("rev-parse", "HEAD")).toBe(head);
});

async function dirRepo() {
  const r = await repo();
  for (const dir of [".pi", "docs/prd", "src"]) await mkdir(join(r.root, dir), { recursive: true });
  await writeFile(join(r.root, ".pi", "settings.json"), "{}\n");
  await writeFile(join(r.root, "docs", "prd", "x.md"), "x\n");
  await writeFile(join(r.root, "AGENTS.md"), "rules\n");
  await writeFile(join(r.root, "src", "ok.ts"), "ok\n");
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => ["a.ts", "src/", ".pi/", ".PI", "docs/", "AGENTS.md", "."] });
  return { ...r, tool };
}

test("paths 里的目录下含受保护的文件时整次拒绝，原因写明目录与其中的文件，HEAD 不变、什么都不暂存", async () => {
  const r = await dirRepo();
  const head = r.git("rev-parse", "HEAD");
  const next = "把 paths 改成具体的文件，去掉受保护的文件后再提交";
  expectFailure(await failureOf(run(r.tool, { paths: [".pi"], message: "x" })), /目录 \.pi 里包含不能提交的文件 \.pi\/settings\.json/u, next);
  expectFailure(await failureOf(run(r.tool, { paths: [".pi/"], message: "x" })), /目录 \.pi\/? 里包含不能提交的文件 \.pi\/settings\.json/u, next);
  expectFailure(await failureOf(run(r.tool, { paths: ["docs"], message: "x" })), /目录 docs 里包含不能提交的文件 docs\/prd\/x\.md/u, next);
  expect(r.git("rev-parse", "HEAD")).toBe(head);
  expect(r.git("diff", "--cached", "--name-only")).toBe("");
});

test("paths 写成大小写不同的目录名，目录下含受保护的文件时同样拒绝", async (context) => {
  const r = await dirRepo();
  if (!existsSync(join(r.root, ".PI"))) context.skip();
  const head = r.git("rev-parse", "HEAD");
  expectFailure(await failureOf(run(r.tool, { paths: [".PI"], message: "x" })), /目录 \.PI 里包含不能提交的文件 /u, "把 paths 改成具体的文件，去掉受保护的文件后再提交");
  expect(r.git("rev-parse", "HEAD")).toBe(head);
});

test("paths 是不含受保护文件的目录时照常提交其中的改动", async () => {
  const r = await dirRepo();
  await run(r.tool, { paths: ["src"], message: "src" });
  expect(r.git("show", "--name-only", "--format=", "HEAD")).toBe("src/ok.ts");
});

test("paths 写 \".\" 时按路径写法不合规拒绝，不进入目录扫描", async () => {
  const r = await dirRepo();
  const head = r.git("rev-parse", "HEAD");
  const message = await failureOf(run(r.tool, { paths: ["src", "."], message: "x" }));
  expectFailure(message, "写法不合规", /\S/u);
  expect(message).not.toMatch(/目录 \. 里包含/u);
  expect(r.git("rev-parse", "HEAD")).toBe(head);
  expect(r.git("diff", "--cached", "--name-only")).toBe("");
});

async function trackedPiRepo() {
  const r = await repo();
  await mkdir(join(r.root, ".pi", "agents"), { recursive: true });
  await writeFile(join(r.root, ".pi", "settings.json"), "{}\n");
  await writeFile(join(r.root, ".pi", "agents", "pm.md"), "pm\n");
  r.git("add", "."); r.git("commit", "-qm", "pi");
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => [".pi/", "a.ts"] });
  const rejects = async (paths: string[]) => {
    const head = r.git("rev-parse", "HEAD"), staged = r.git("diff", "--cached", "--name-only");
    expectFailure(await failureOf(run(tool, { paths, message: "x" })), /\.pi\/(settings\.json|agents\/pm\.md)/u, /\S/u);
    expect(r.git("rev-parse", "HEAD")).toBe(head);
    expect(r.git("diff", "--cached", "--name-only")).toBe(staged);
  };
  return { ...r, rejects };
}

test("已提交的受保护文件所在的 .pi 目录被整个删掉后，paths 写 .pi 仍整次拒绝，什么都不提交、不暂存", async () => {
  const r = await trackedPiRepo();
  await rm(join(r.root, ".pi"), { recursive: true });
  await r.rejects([".pi"]);
  expect(r.git("diff", "--cached", "--name-only")).toBe("");
});

test("已跟踪的 .pi/settings.json 被修改后，paths 写 .pi 整次拒绝", async () => {
  const r = await trackedPiRepo();
  await writeFile(join(r.root, ".pi", "settings.json"), '{"changed":true}\n');
  await r.rejects([".pi"]);
});

test("已跟踪的 .pi/settings.json 被重命名走后，paths 写 .pi 整次拒绝", async () => {
  const r = await trackedPiRepo();
  await mkdir(join(r.root, "src"), { recursive: true });
  r.git("mv", ".pi/settings.json", "src/settings.json");
  await r.rejects([".pi"]);
});

test(".pi 目录被换成指向别处的符号链接后，paths 写 .pi 整次拒绝", async () => {
  const r = await trackedPiRepo();
  await mkdir(join(r.root, "elsewhere"), { recursive: true });
  await writeFile(join(r.root, "elsewhere", "other.json"), "{}\n");
  await rm(join(r.root, ".pi"), { recursive: true });
  await symlink(join(r.root, "elsewhere"), join(r.root, ".pi"));
  await r.rejects([".pi"]);
});

test(".pi 目录被换成普通文件后，paths 写 .pi 整次拒绝", async () => {
  const r = await trackedPiRepo();
  await rm(join(r.root, ".pi"), { recursive: true });
  await writeFile(join(r.root, ".pi"), "not a dir\n");
  await r.rejects([".pi"]);
});

test("写入范围是仓库根时，paths 写 ./ 或 src/../ 按写法不合规拒绝，HEAD 与暂存区不变，未提交的 .pi/settings.json 和 AGENTS.md 不会被提交", async () => {
  const r = await repo();
  await mkdir(join(r.root, ".pi"), { recursive: true });
  await writeFile(join(r.root, ".pi", "settings.json"), "{}\n");
  await writeFile(join(r.root, "AGENTS.md"), "rules\n");
  await writeFile(join(r.root, "a.ts"), "a2\n");
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => ["./"] });
  const head = r.git("rev-parse", "HEAD");
  for (const path of ["./", "src/../"]) {
    expectFailure(await failureOf(run(tool, { paths: [path], message: "x" })), "写法不合规", /\S/u);
    expect(r.git("rev-parse", "HEAD")).toBe(head);
    expect(r.git("diff", "--cached", "--name-only")).toBe("");
  }
  expect(r.git("ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/AGENTS\.md|\.pi\//u);
});

const reasonOf = (message: string) => message.split("\n原因：")[1]!.split("\n建议：")[0]!;

test("paths 里的文件没有任何改动时提交失败，原因是 git 的输出，不含命令行和提交说明，建议不叫重试", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false, writeScope: () => ["a.ts", "other.ts"] });
  await writeFile(join(r.root, "other.ts"), "o\n");
  const head = r.git("rev-parse", "HEAD");
  const message = await failureOf(run(tool, { paths: ["a.ts"], message: "独特提交说明-xyz" }));
  expect(reasonOf(message)).toContain("git 命令失败（退出码 1）");
  expect(reasonOf(message)).toContain("nothing");
  expect(message).not.toContain("Command failed");
  expect(message).not.toContain("独特提交说明-xyz");
  expect(message.split("\n建议：")[1]).not.toContain("重试一次");
  expect(r.git("rev-parse", "HEAD")).toBe(head);
});

test("paths 写不存在且从未跟踪的文件时，原因带 git 的 pathspec 报错，不含 Command failed", async () => {
  const r = await repo();
  const tool = createPmCommitTool({ requirementId: REQUIREMENT, worktree: r.root, branch: "refs/heads/req-branch", alive: () => true, checkPhaseActive: () => false, writeScope: () => ["ghost.ts"] });
  const message = await failureOf(run(tool, { paths: ["ghost.ts"], message: "独特提交说明-xyz" }));
  expect(reasonOf(message)).toContain("git 命令失败（退出码 1）");
  expect(reasonOf(message)).toContain("pathspec");
  expect(message).not.toContain("Command failed");
  expect(message).not.toContain("独特提交说明-xyz");
});
