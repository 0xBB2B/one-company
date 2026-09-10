import { uuidv7 } from "../runtime/database.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClock } from "../runtime/clock.ts";
import { RunStore } from "../runtime/run-store.ts";
import { WindowRegistry } from "../runtime/windows.ts";
import {
  activeForeignHosts,
  scopedCommitPaths,
  snapshotBranchState,
  verifyBranchState,
} from "../runtime/branch-guard.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const execFileAsync = promisify(execFile);

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const extraDirs: string[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeRepoWithFiles(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  await writeFile(join(repo.root, "occupied.txt"), "占用文件\n");
  await writeFile(join(repo.root, "own.txt"), "本任务文件\n");
  await runGit(["add", "occupied.txt", "own.txt"], repo.root);
  await runGit(["commit", "-m", "seed occupied/own"], repo.root);
  return repo;
}

async function makeBranchedRepo(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await makeRepoWithFiles();
  await writeFile(join(repo.root, "second.txt"), "第二次提交\n");
  await runGit(["add", "second.txt"], repo.root);
  await runGit(["commit", "-m", "second commit"], repo.root);
  await runGit(["branch", "other"], repo.root);
  return repo;
}

async function makeDirRangeRepo(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(repo.root, "a"), { recursive: true });
  await mkdir(join(repo.root, "b"), { recursive: true });
  await writeFile(join(repo.root, "a", "keep.txt"), "a 范围文件\n");
  await writeFile(join(repo.root, "b", "secret.txt"), "b 范围文件\n");
  await runGit(["add", "a/keep.txt", "b/secret.txt"], repo.root);
  await runGit(["commit", "-m", "seed a/b"], repo.root);
  return repo;
}

interface BranchSnapshot {
  head: string;
  branch: string | null;
}

async function captureBranchSnapshot(repoRoot: string): Promise<BranchSnapshot> {
  const head = (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
  const rawBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
  return { head, branch: rawBranch === "HEAD" ? null : rawBranch };
}

function runInput(requirement: string, cwd: string, task: string) {
  return {
    kind: "requirement" as const,
    requirement,
    task,
    cwd,
    writePaths: [],
    readPaths: [],
    model: { provider: "anthropic", id: "claude-test" },
    thinking: "high",
    mcp: [],
  };
}

function windowInput(overrides: Record<string, unknown> = {}) {
  return {
    windowId: uuidv7(),
    pid: 1,
    sessionId: "session-shared-branch-guard-test",
    cwd: "/tmp/example-cwd",
    workspaceRoot: "/tmp/example-root",
    ...overrides,
  };
}

async function makeWindowsRegistry(): Promise<WindowRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "shared-branch-guard-windows-"));
  extraDirs.push(dir);
  return new WindowRegistry({
    repoDir: dir,
    clock: createClock(),
    bootId: async () => "boot-fixed",
    processStartedAt: async (pid: number) => `start-${pid}`,
  });
}

async function makeRunStore(): Promise<RunStore> {
  const home = await createTempHome();
  tempHomes.push(home);
  return new RunStore({ dataRoot: home.dataRoot, repoId: "a".repeat(64), daemonStartedAt: "shared-branch-guard-test" });
}

describe("verifyBranchState：存在活动宿主时判违规，无活动宿主时只报告变化", () => {
  test("git switch 切换分支：存在活动宿主时判违规并列出宿主", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["switch", "other"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(true);
    expect(result.hosts).toContain("window-other");
  });

  test("git checkout 切换分支：存在活动宿主时判违规", async () => {
    const repo = await makeBranchedRepo();
    await runGit(["switch", "other"], repo.root);
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["checkout", "main"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(true);
  });

  test("git reset --hard 重置共享现场：存在活动宿主时判违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["reset", "--hard", "HEAD~1"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(true);
  });

  test("边界：借 shell 函数间接切换分支的脚本同样判违规（不依赖命令文本匹配）", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await execFileAsync("sh", ["-c", "gco() { git checkout \"$@\"; }; gco other"], { cwd: repo.root });

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(true);
  });

  test("边界：git status 不改变分支现场，不触发违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["status"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(false);
    expect(result.changed).toBe(false);
  });

  test("无活动宿主时分支切换只报告变化不判违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["switch", "other"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: [] });
    expect(result.violation).toBe(false);
    expect(result.changed).toBe(true);
  });

  test("同分支内快进提交（git commit）：存在活动宿主也不判违规，只报告 changed:true", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(false);
    expect(result.changed).toBe(true);
  });

  test("边界：git checkout -b 新建并切换到新分支（分支名变化）：存在活动宿主时判违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await runGit(["checkout", "-b", "brand-new-branch"], repo.root);

    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });
    expect(result.violation).toBe(true);
  });
});

describe("snapshotBranchState：只读 head/branch，不受工作区体量拖累", () => {
  test("边界：工作区差异体量巨大（超出常规 maxBuffer）时仍返回 head/branch 且不抛", async () => {
    const repo = await makeBranchedRepo();

    const before = await captureBranchSnapshot(repo.root);
    await writeFile(join(repo.root, "own.txt"), Buffer.alloc(65 * 1024 * 1024, "x"));
    const result = await snapshotBranchState({ repoRoot: repo.root });

    expect(result.head).toBe(before.head);
    expect(result.branch).toBe("main");
  }, 15_000);
});

describe("verifyBranchState：merge-base 判定失败与不可判定的归因区分", () => {
  test("merge-base 以退出码 128（git 本身故障）失败：判为无法判定，不算违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);

    // 不存在的对象使真实 Git 返回 128，不能误判为非祖先。
    before.head = "f".repeat(40);
    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });

    expect(result.violation).toBe(false);
    expect(result.changed).toBe(true);
    expect((result as { undetermined?: boolean }).undetermined).toBe(true);
    expect((result as { reason?: string }).reason ?? "").toContain("无法判定");
  }, 15_000);

  test("边界：merge-base 以退出码 1（明确判定非后代）失败：仍按现场改写判违规", async () => {
    const repo = await makeBranchedRepo();
    const before = await captureBranchSnapshot(repo.root);
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);

    const unrelated = (await runGit(["commit-tree", "HEAD^{tree}", "-m", "independent root"], repo.root)).trim();
    await runGit(["reset", "--hard", unrelated], repo.root);
    const result = await verifyBranchState({ repoRoot: repo.root, before, activeHosts: ["window-other"] });

    expect(result.violation).toBe(true);
    expect((result as { undetermined?: boolean }).undetermined).toBeFalsy();
  }, 15_000);
});

describe("activeForeignHosts：另一窗口存活或另一 runId 运行中时列出，否则为空", () => {
  test("另一窗口存活记录存在时列出该宿主", async () => {
    const windows = await makeWindowsRegistry();
    const runStore = await makeRunStore();
    const selfWindowId = uuidv7();
    const otherWindowId = uuidv7();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 201 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 202 }));

    const hosts = await activeForeignHosts({ runStore, windows, windowId: selfWindowId, runId: "run-self" });
    expect(hosts.some((host) => host.includes(otherWindowId))).toBe(true);
  });

  test("无其它窗口且无其它运行中任务时为空", async () => {
    const windows = await makeWindowsRegistry();
    const runStore = await makeRunStore();
    const selfWindowId = uuidv7();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 211 }));

    const hosts = await activeForeignHosts({ runStore, windows, windowId: selfWindowId, runId: "run-self" });
    expect(hosts).toEqual([]);
  });

  test("边界：其它 runId 处于运行中时列出", async () => {
    const windows = await makeWindowsRegistry();
    const runStore = await makeRunStore();
    const selfWindowId = uuidv7();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 221 }));
    const otherRun = await runStore.create(runInput("2026-09-09.activehost-demo", "/tmp/example-cwd", "other-task"));
    await runStore.update(otherRun.id, { state: "running" });

    const hosts = await activeForeignHosts({ runStore, windows, windowId: selfWindowId, runId: "run-self" });
    expect(hosts.some((host) => host.includes(otherRun.id))).toBe(true);
  });
});

describe("scopedCommitPaths：提交范围只含本任务获准的路径", () => {
  // 返回形状为本轮新增设计：{ paths, blocked }——paths 是可直接提交的路径清单，
  // blocked 是因跨范围重命名等原因被排除的条目（各带 paths 与 reason），供调用方解释"为什么少了这个文件"
  test("同时改动本范围文件与他人范围文件时只返回本范围路径", async () => {
    const repo = await makeRepoWithFiles();
    await execFileAsync("sh", ["-c", "echo mine >> own.txt && echo foreign >> occupied.txt"], { cwd: repo.root });

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: ["own.txt"] });
    expect(result.paths).toContain("own.txt");
    expect(result.paths).not.toContain("occupied.txt");
  });

  test("边界：本范围内新增的未跟踪文件同样纳入提交范围", async () => {
    const repo = await makeRepoWithFiles();
    await writeFile(join(repo.root, "new-in-scope.txt"), "属于本范围\n");

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: ["new-in-scope.txt"] });
    expect(result.paths).toContain("new-in-scope.txt");
  });

  test("两端都在本范围目录内的重命名整条纳入", async () => {
    const repo = await makeDirRangeRepo();
    await runGit(["mv", "a/keep.txt", "a/keep-renamed.txt"], repo.root);

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: ["a/"] });
    expect(result.paths).toContain("a/keep.txt");
    expect(result.paths).toContain("a/keep-renamed.txt");
  });

  test("跨范围重命名（他人范围移入本范围）：两端都不纳入提交清单，带阻断原因", async () => {
    const repo = await makeDirRangeRepo();
    await runGit(["mv", "b/secret.txt", "a/stolen.txt"], repo.root);

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: ["a/"] });
    expect(result.paths).not.toContain("b/secret.txt");
    expect(result.paths).not.toContain("a/stolen.txt");
    expect(result.blocked.length).toBeGreaterThan(0);
    const blockedPaths = result.blocked.flatMap((entry) => entry.paths);
    expect(blockedPaths).toContain("b/secret.txt");
    expect(blockedPaths).toContain("a/stolen.txt");
    expect(result.blocked.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  test("跨范围重命名（本范围移出到他人范围）：两端都不纳入提交清单，带阻断原因", async () => {
    const repo = await makeDirRangeRepo();
    await runGit(["mv", "a/keep.txt", "b/moved.txt"], repo.root);

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: ["a/"] });
    expect(result.paths).not.toContain("a/keep.txt");
    expect(result.paths).not.toContain("b/moved.txt");
    expect(result.blocked.length).toBeGreaterThan(0);
    const blockedPaths = result.blocked.flatMap((entry) => entry.paths);
    expect(blockedPaths).toContain("a/keep.txt");
    expect(blockedPaths).toContain("b/moved.txt");
  });

  test("错误场景：获准范围为空时提交路径清单为空", async () => {
    const repo = await makeRepoWithFiles();
    await execFileAsync("sh", ["-c", "echo foreign >> occupied.txt"], { cwd: repo.root });

    const result = await scopedCommitPaths({ repoRoot: repo.root, writePaths: [] });
    expect(result.paths).toEqual([]);
  });
});
