import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClock } from "../runtime/clock.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import type { Holder } from "../runtime/ranges.ts";
import { RangeClaims } from "../runtime/ranges.ts";
import { RunStore } from "../runtime/run-store.ts";
import {
  afterCommand,
  beforeCommand,
  checkWrite,
  snapshotWorkspace,
  verifyWorkspace,
} from "../runtime/write-guard.ts";
import { changedPaths } from "../runtime/git-snapshot.ts";
import { bindEvidence, checkEvidence, checkResume, initRequirementState, listEvidenceStages } from "../runtime/workflow-state.ts";
import type { WorkflowContext } from "../runtime/workflow-state.ts";
import { WindowRegistry } from "../runtime/windows.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const execFileAsync = promisify(execFile);

const CURRENT_VERSION = { definitionFingerprint: "fp-write-guard-test", codeHead: "head-write-guard-test" };

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const extraDirs: string[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function makeClaims(repoRoot: string): RangeClaims {
  return new RangeClaims({
    repoDir: repoRoot,
    repoRoot,
    clock: createClock(),
    runState: async () => null,
    holderGone: async () => ({ gone: false, reason: "默认未失联" }),
    activeShellTasks: async () => 0,
  });
}

async function makeRepoWithFiles(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  await writeFile(join(repo.root, "occupied.txt"), "占用文件\n");
  await writeFile(join(repo.root, "own.txt"), "本任务文件\n");
  await mkdir(join(repo.root, "shared-dir"), { recursive: true });
  await writeFile(join(repo.root, "shared-dir", "keep.txt"), "占位\n");
  await runGit(["add", "occupied.txt", "own.txt", "shared-dir/keep.txt"], repo.root);
  await runGit(["commit", "-m", "seed occupied/own/shared-dir"], repo.root);
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
    windowId: randomUUID(),
    pid: 1,
    sessionId: "session-write-guard-test",
    cwd: "/tmp/example-cwd",
    workspaceRoot: "/tmp/example-root",
    ...overrides,
  };
}

async function makeWindowsRegistry(): Promise<WindowRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "write-guard-windows-"));
  extraDirs.push(dir);
  return new WindowRegistry({
    repoDir: dir,
    clock: createClock(),
    bootId: async () => "boot-fixed",
    processStartedAt: async (pid: number) => `start-${pid}`,
  });
}

async function selfWindow(): Promise<{ windows: WindowRegistry; windowId: string }> {
  const windows = await makeWindowsRegistry();
  const windowId = randomUUID();
  await windows.register(windowInput({ windowId, pid: 1 }));
  return { windows, windowId };
}

// 假 git：rev-parse 返回固定值，status 保持空（不干扰范围核对），diff 故意喂超大输出——
// 用来验证 beforeCommand 不会因为分支快照顺带读了一份巨大 diff 而直接拒绝执行命令
async function withHugeDiffFakeGit<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "write-guard-huge-diff-"));
  const scriptPath = join(dir, "git");
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then',
      "  echo deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "  exit 0",
      "fi",
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then',
      "  echo main",
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      "  exit 0",
      "fi",
      "head -c 70000000 /dev/zero",
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}

// 假 git：除 merge-base 外全部转交真实 git，merge-base 固定按注入退出码失败
async function withMergeBaseExitCode<T>(exitCode: number, fn: () => Promise<T>): Promise<T> {
  const realGitPath = (await execFileAsync("which", ["git"])).stdout.trim();
  const dir = await mkdtemp(join(tmpdir(), "write-guard-mergebase-"));
  const scriptPath = join(dir, "git");
  await writeFile(
    scriptPath,
    ["#!/bin/sh", 'if [ "$1" = "merge-base" ]; then', `  exit ${exitCode}`, "fi", `exec "${realGitPath}" "$@"`, ""].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}

// 假 git：所有子命令一律失败，模拟核对阶段本身遭遇 git 故障（而非命令本身失败）
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "write-guard-broken-git-"));
  const scriptPath = join(dir, "git");
  await writeFile(scriptPath, "#!/bin/sh\necho 'fatal: broken git' >&2\nexit 1\n");
  await chmod(scriptPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeCrossRangeRepo(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  await mkdir(join(repo.root, "a"), { recursive: true });
  await mkdir(join(repo.root, "a2"), { recursive: true });
  await mkdir(join(repo.root, "b"), { recursive: true });
  await writeFile(join(repo.root, "a", "keep.txt"), "a 范围文件\n");
  await writeFile(join(repo.root, "a2", "keep.txt"), "a2 范围文件\n");
  await writeFile(join(repo.root, "b", "secret.txt"), "b 范围文件\n");
  await runGit(["add", "a/keep.txt", "a2/keep.txt", "b/secret.txt"], repo.root);
  await runGit(["commit", "-m", "seed a/a2/b"], repo.root);
  return repo;
}

async function bindStagesEvidence(
  repo: Awaited<ReturnType<typeof createRepoFixture>>,
  home: Awaited<ReturnType<typeof createTempHome>>,
  requirement: string,
  stages: string[],
): Promise<WorkflowContext> {
  const identity = await repositoryIdentity(repo.root);
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: "write-guard-test" });
  const ctx: WorkflowContext = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  await initRequirementState(ctx);
  for (const stage of stages) {
    const evidenceRun = await runStore.create(runInput(requirement, repo.root, `evidence-${stage}`));
    await runStore.update(evidenceRun.id, { state: "running" });
    await runStore.update(evidenceRun.id, {
      state: "completed",
      result: {
        phase: stage,
        verdict: "PASS",
        binding: {
          requirement,
          definitionFingerprint: CURRENT_VERSION.definitionFingerprint,
          codeHead: CURRENT_VERSION.codeHead,
          cwd: repo.root,
        },
      },
    });
    await bindEvidence({ stage, runId: evidenceRun.id, currentVersion: CURRENT_VERSION }, ctx);
  }
  return ctx;
}

async function setupRunAndEvidence(
  repo: Awaited<ReturnType<typeof createRepoFixture>>,
  home: Awaited<ReturnType<typeof createTempHome>>,
  requirement: string,
): Promise<{ runStore: RunStore; ctx: WorkflowContext; runId: string }> {
  const ctx = await bindStagesEvidence(repo, home, requirement, ["work"]);
  const identity = await repositoryIdentity(repo.root);
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: "write-guard-test" });
  const run = await runStore.create(runInput(requirement, repo.root, "under-test"));
  await runStore.update(run.id, { state: "running" });
  return { runStore, ctx, runId: run.id };
}

describe("checkWrite：获准范围与占用核对", () => {
  test("本任务获准范围内的路径允许写入", async () => {
    const repo = await makeRepoWithFiles();
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own", requirement: "2026-09-09.checkwrite-pass" };
    const claimed = await claims.claim(holder, ["own.txt"]);
    expect(claimed.granted).toBe(true);

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "own.txt",
      writePaths: ["own.txt"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(true);
  });

  test("边界：获准范围声明为目录 dir/ 时其下文件路径允许写入", async () => {
    const repo = await makeRepoWithFiles();
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own-dir", requirement: "2026-09-09.checkwrite-dirscope" };
    const claimed = await claims.claim(holder, ["shared-dir/"]);
    expect(claimed.granted).toBe(true);

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "shared-dir/keep.txt",
      writePaths: ["shared-dir/"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(true);
  });

  test("他人已占用的文件拒绝写入并在原因中说明持有者", async () => {
    const repo = await makeRepoWithFiles();
    const claims = makeClaims(repo.root);
    const foreignHolder: Holder = { kind: "requirement", runId: "run-foreign", requirement: "2026-09-09.foreign" };
    const claimed = await claims.claim(foreignHolder, ["occupied.txt"]);
    expect(claimed.granted).toBe(true);

    const ownHolder: Holder = { kind: "requirement", runId: "run-own", requirement: "2026-09-09.checkwrite-conflict" };
    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "occupied.txt",
      writePaths: ["own.txt"],
      holder: ownHolder,
      claims,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("run-foreign");
  });

  test("边界：获准范围外但当前无人占用的路径同样拒绝", async () => {
    const repo = await makeRepoWithFiles();
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own", requirement: "2026-09-09.checkwrite-outofscope" };
    await claims.claim(holder, ["own.txt"]);

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "occupied.txt",
      writePaths: ["own.txt"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(false);
  });

  test("错误场景：跨仓库路径一律拒绝", async () => {
    const repo = await makeRepoWithFiles();
    const otherRepo = await createRepoFixture();
    repoFixtures.push(otherRepo);
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own", requirement: "2026-09-09.checkwrite-crossrepo" };
    await claims.claim(holder, ["own.txt"]);

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: join(otherRepo.root, "README.md"),
      writePaths: ["own.txt"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("checkWrite：符号链接不得越出仓库边界（以最深已存在祖先 realpath 判定）", () => {
  test("叶子路径本身是指向仓库外的符号链接：拒绝写入", async () => {
    const repo = await makeRepoWithFiles();
    const outsideDir = await mkdtemp(join(tmpdir(), "write-guard-outside-"));
    extraDirs.push(outsideDir);
    await symlink(outsideDir, join(repo.root, "escape-link"));
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own-symlink", requirement: "2026-09-09.checkwrite-symlink" };

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "escape-link",
      writePaths: ["escape-link"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(false);
  });

  test("边界：路径的中间目录是指向仓库外的符号链接，其下尚未创建的文件同样拒绝", async () => {
    const repo = await makeRepoWithFiles();
    const outsideDir = await mkdtemp(join(tmpdir(), "write-guard-outside-"));
    extraDirs.push(outsideDir);
    await symlink(outsideDir, join(repo.root, "linked-dir"));
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own-symlink-dir", requirement: "2026-09-09.checkwrite-symlink-dir" };

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "linked-dir/new-file.txt",
      writePaths: ["linked-dir/new-file.txt"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(false);
  });
});

describe("checkWrite：仓库内符号链接绕过占用与获准范围（不逃逸仓库边界）", () => {
  test("a/link 指向他人范围 b/：经符号链接写入被拒绝且原因含真实落点", async () => {
    const repo = await makeCrossRangeRepo();
    await symlink("../b", join(repo.root, "a", "link"));
    const claims = makeClaims(repo.root);
    const foreignHolder: Holder = { kind: "requirement", runId: "run-foreign-b", requirement: "2026-09-09.symlink-bypass-foreign" };
    await claims.claim(foreignHolder, ["b/"]);
    const holder: Holder = { kind: "requirement", runId: "run-own-symlink-bypass", requirement: "2026-09-09.symlink-bypass-own" };

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "a/link/secret.txt",
      writePaths: ["a/"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("b/secret.txt");
  });

  test("边界：a/link2 指向本范围 a2/：经符号链接写入允许", async () => {
    const repo = await makeCrossRangeRepo();
    await symlink("../a2", join(repo.root, "a", "link2"));
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own-symlink-allow", requirement: "2026-09-09.symlink-bypass-allow" };

    const result = await checkWrite({
      repoRoot: repo.root,
      cwd: repo.root,
      path: "a/link2/note.txt",
      writePaths: ["a/", "a2/"],
      holder,
      claims,
    });
    expect(result.allowed).toBe(true);
  });

  test("错误场景：writePaths 含逃逸路径时返回 allowed:false 而不抛", async () => {
    const repo = await makeCrossRangeRepo();
    const claims = makeClaims(repo.root);
    const holder: Holder = { kind: "requirement", runId: "run-own-scope-escape", requirement: "2026-09-09.symlink-bypass-scope-escape" };

    let thrown: Error | undefined;
    let result: Awaited<ReturnType<typeof checkWrite>> | undefined;
    try {
      result = await checkWrite({
        repoRoot: repo.root,
        cwd: repo.root,
        path: "a/keep.txt",
        writePaths: ["../x"],
        holder,
        claims,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeUndefined();
    expect(result?.allowed).toBe(false);
  });
});

describe("changedPaths：-uall 且重命名条目同时纳入新旧路径", () => {
  test("git mv 后 changedPaths 同时包含新旧路径", async () => {
    const repo = await makeRepoWithFiles();
    await runGit(["mv", "own.txt", "own-renamed.txt"], repo.root);
    const paths = await changedPaths(repo.root);
    expect(paths).toContain("own.txt");
    expect(paths).toContain("own-renamed.txt");
  });
});

describe("beforeCommand/afterCommand：无法静态确认范围的命令执行后核对", () => {
  test("越界修改他人占用文件：afterCommand 返回该路径、运行标 failed；被占用方所属需求的全部阶段证据失效，本任务证据不受影响", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const ownRequirement = "2026-09-09.write-guard-own";
    const foreignRequirement = "2026-09-09.write-guard-victim";
    const claims = makeClaims(repo.root);
    const foreignHolder: Holder = { kind: "requirement", runId: "run-victim", requirement: foreignRequirement };
    await claims.claim(foreignHolder, ["occupied.txt"]);

    const ownCtx = await bindStagesEvidence(repo, home, ownRequirement, ["work"]);
    const foreignCtx = await bindStagesEvidence(repo, home, foreignRequirement, ["work", "review"]);

    const identity = await repositoryIdentity(repo.root);
    const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: "write-guard-test" });
    const run = await runStore.create(runInput(ownRequirement, repo.root, "under-test"));
    await runStore.update(run.id, { state: "running" });
    const holder: Holder = { kind: "requirement", runId: run.id, requirement: ownRequirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId: run.id, workflowCtx: ownCtx, windows, windowId });
    await execFileAsync("sh", ["-c", "echo overwrite >> occupied.txt"], { cwd: repo.root });
    const result = await afterCommand(token);

    expect(result.violations).toContain("occupied.txt");

    const updated = await runStore.get(run.id);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.run.state).toBe("failed");
      expect(updated.run.stateReason ?? "").toContain("occupied.txt");
    }

    const foreignWork = await checkEvidence({ stage: "work", currentVersion: CURRENT_VERSION }, foreignCtx);
    const foreignReview = await checkEvidence({ stage: "review", currentVersion: CURRENT_VERSION }, foreignCtx);
    expect(foreignWork.ok).toBe(false);
    expect(foreignReview.ok).toBe(false);

    const foreignStages = await listEvidenceStages(foreignCtx);
    expect(foreignStages).toContain("work");
    expect(foreignStages).toContain("review");

    const foreignResume = await checkResume(foreignCtx, CURRENT_VERSION);
    expect(foreignResume.ok).toBe(false);
    if (!foreignResume.ok) expect(foreignResume.reason).toContain("失效");

    const ownWork = await checkEvidence({ stage: "work", currentVersion: CURRENT_VERSION }, ownCtx);
    expect(ownWork.ok).toBe(true);
  });

  test("同一运行第二次越界或运行已终态时：afterCommand 不抛且仍使被占用方证据失效", async () => {
    const repo = await makeRepoWithFiles();
    await writeFile(join(repo.root, "occupied-2.txt"), "第二个占用文件\n");
    await runGit(["add", "occupied-2.txt"], repo.root);
    await runGit(["commit", "-m", "add occupied-2"], repo.root);
    const home = await createTempHome();
    tempHomes.push(home);
    const ownRequirement = "2026-09-09.write-guard-repeat";
    const foreignRequirement1 = "2026-09-09.write-guard-repeat-victim-1";
    const foreignRequirement2 = "2026-09-09.write-guard-repeat-victim-2";
    const claims = makeClaims(repo.root);
    await claims.claim({ kind: "requirement", runId: "run-victim-1", requirement: foreignRequirement1 }, ["occupied.txt"]);
    await claims.claim({ kind: "requirement", runId: "run-victim-2", requirement: foreignRequirement2 }, ["occupied-2.txt"]);

    const ownCtx = await bindStagesEvidence(repo, home, ownRequirement, ["work"]);
    await bindStagesEvidence(repo, home, foreignRequirement1, ["work"]);
    const foreignCtx2 = await bindStagesEvidence(repo, home, foreignRequirement2, ["work"]);

    const identity = await repositoryIdentity(repo.root);
    const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: "write-guard-test" });
    const run = await runStore.create(runInput(ownRequirement, repo.root, "under-test"));
    await runStore.update(run.id, { state: "running" });
    const holder: Holder = { kind: "requirement", runId: run.id, requirement: ownRequirement };
    const { windows, windowId } = await selfWindow();

    const firstToken = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId: run.id, workflowCtx: ownCtx, windows, windowId });
    await execFileAsync("sh", ["-c", "echo v1 >> occupied.txt"], { cwd: repo.root });
    const firstResult = await afterCommand(firstToken);
    expect(firstResult.violations).toContain("occupied.txt");

    const secondToken = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId: run.id, workflowCtx: ownCtx, windows, windowId });
    await execFileAsync("sh", ["-c", "echo v2 >> occupied-2.txt"], { cwd: repo.root });
    let secondResult: { violations: string[] } | undefined;
    let threw: Error | undefined;
    try {
      secondResult = await afterCommand(secondToken);
    } catch (error) {
      threw = error as Error;
    }
    expect(threw).toBeUndefined();
    expect(secondResult?.violations).toContain("occupied-2.txt");

    const foreignWork2 = await checkEvidence({ stage: "work", currentVersion: CURRENT_VERSION }, foreignCtx2);
    expect(foreignWork2.ok).toBe(false);
  });

  test("边界：他人范围为目录，其下新建的未跟踪文件被 afterCommand 返回", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-dir";
    const foreignRequirement = "2026-09-09.foreign-dir";
    const claims = makeClaims(repo.root);
    await claims.claim({ kind: "requirement", runId: "run-foreign-dir", requirement: foreignRequirement }, ["shared-dir/"]);
    await bindStagesEvidence(repo, home, foreignRequirement, ["work"]);

    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });
    await execFileAsync("sh", ["-c", "echo new > shared-dir/new.txt"], { cwd: repo.root });
    const result = await afterCommand(token);

    expect(result.violations).toContain("shared-dir/new.txt");
  });

  test("边界：git mv 越界移动他人占用文件同样被 afterCommand 返回", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-mv";
    const foreignRequirement = "2026-09-09.foreign-mv";
    const claims = makeClaims(repo.root);
    await claims.claim({ kind: "requirement", runId: "run-foreign-mv", requirement: foreignRequirement }, ["occupied.txt"]);
    await bindStagesEvidence(repo, home, foreignRequirement, ["work"]);

    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });
    await runGit(["mv", "occupied.txt", "occupied-mv.txt"], repo.root);
    const result = await afterCommand(token);

    expect(result.violations).toContain("occupied.txt");
  });

  test("正常路径：只写本任务范围时核对通过、运行状态不变、且不判分支违规", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-pass";
    const foreignRequirement = "2026-09-09.foreign-pass";
    const claims = makeClaims(repo.root);
    await claims.claim({ kind: "requirement", runId: "run-foreign-pass", requirement: foreignRequirement }, ["occupied.txt"]);

    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });
    await execFileAsync("sh", ["-c", "echo mine >> own.txt"], { cwd: repo.root });
    const result = await afterCommand(token);

    expect(result.violations).toEqual([]);
    expect(result.branchViolation).toBeFalsy();
    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.run.state).toBe("running");

    const evidenceCheck = await checkEvidence({ stage: "work", currentVersion: CURRENT_VERSION }, ctx);
    expect(evidenceCheck.ok).toBe(true);
  });

  test("边界：他人范围外的大量文件改动不触发越界判定", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-bulk";
    const foreignRequirement = "2026-09-09.foreign-bulk";
    const claims = makeClaims(repo.root);
    await claims.claim({ kind: "requirement", runId: "run-foreign-bulk", requirement: foreignRequirement }, ["occupied.txt"]);

    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(repo.root, `outside-range-${i}.txt`), `内容-${i}\n`);
    }
    const result = await afterCommand(token);

    expect(result.violations).toEqual([]);
    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.run.state).toBe("running");
  });
});

describe("beforeCommand/afterCommand：与分支守卫组合", () => {
  test("存在其它存活窗口时，命令期间切换分支被判违规并列出宿主", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-violation";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    const otherWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 101 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 102 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await runGit(["switch", "other"], repo.root);
    const result = await afterCommand(token);

    expect(result.branchViolation).toBeDefined();
    expect(result.branchViolation?.hosts.some((host) => host.includes(otherWindowId))).toBe(true);

    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.run.state).toBe("failed");
      expect(updated.run.stateReason ?? "").toContain("分支");
    }
  });

  test("同分支内快进提交（git commit）：不判分支违规，运行状态不变", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-ff";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    const otherWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 131 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 132 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);
    const result = await afterCommand(token);

    expect(result.branchViolation).toBeFalsy();
    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.run.state).toBe("running");
  });

  test("边界：git status 不改变分支现场，不触发分支违规", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-status";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    const otherWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 111 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 112 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await runGit(["status"], repo.root);
    const result = await afterCommand(token);

    expect(result.branchViolation).toBeFalsy();
  });

  test("无其它存活宿主时分支切换只报告变化不判违规", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-alone";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 121 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await runGit(["switch", "other"], repo.root);
    const result = await afterCommand(token);

    expect(result.branchViolation).toBeFalsy();
  });

  test("边界：命令期间工作区差异体量巨大也不导致 beforeCommand 拒绝执行", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-hugediff";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    let thrown: Error | undefined;
    try {
      await withHugeDiffFakeGit(() =>
        beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId }),
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeUndefined();
  }, 15_000);

  test("merge-base 无法判定时：afterCommand 不因分支现场变化标记运行失败", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-undetermined";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    const otherWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 141 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 142 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);

    const result = await withMergeBaseExitCode(128, () => afterCommand(token));

    expect(result.branchViolation).toBeFalsy();
    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.run.state).toBe("running");
  }, 15_000);

  test("merge-base 无法判定时：核对结果对调用方可见（violations 含无法判定原因、stateReason 留痕、state 不变）", async () => {
    const repo = await makeBranchedRepo();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-branch-undetermined-visible";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };

    const windows = await makeWindowsRegistry();
    const selfWindowId = randomUUID();
    const otherWindowId = randomUUID();
    await windows.register(windowInput({ windowId: selfWindowId, pid: 151 }));
    await windows.register(windowInput({ windowId: otherWindowId, pid: 152 }));

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId: selfWindowId });
    await writeFile(join(repo.root, "own.txt"), "本任务文件 v2\n");
    await runGit(["add", "own.txt"], repo.root);
    await runGit(["commit", "-m", "own 正常推进"], repo.root);

    const result = await withMergeBaseExitCode(128, () => afterCommand(token));

    const visibleText = result.violations.join("\n");
    expect(visibleText).toContain("无法判定");

    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.run.state).toBe("running");
      expect(updated.run.stateReason ?? "").toContain("无法判定");
    }
  }, 15_000);

  test("留痕本身失败（runStore.update 抛错）不得顶掉命令后核对的返回值", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-record-failure";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });

    runStore.update = async (): Promise<never> => {
      throw new Error("模拟运行存储更新故障");
    };

    let thrown: Error | undefined;
    let result: Awaited<ReturnType<typeof afterCommand>> | undefined;
    await withBrokenGit(async () => {
      try {
        result = await afterCommand(token);
      } catch (error) {
        thrown = error as Error;
      }
    });

    expect(thrown).toBeUndefined();
    expect(result).toBeDefined();
    const visibleText = (result?.violations ?? []).join("\n");
    expect(visibleText.length).toBeGreaterThan(0);
  }, 15_000);

  test("核对过程本身遭遇 git 故障：运行记录出现含“核对失败”的 stateReason，不再完全静默", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-verify-broken";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows, windowId } = await selfWindow();

    const token = await beforeCommand({ repoRoot: repo.root, holder, claims, runStore, runId, workflowCtx: ctx, windows, windowId });

    await withBrokenGit(async () => {
      try {
        await afterCommand(token);
      } catch {
        // 核对阶段本身失败是否继续对外抛出不是本用例关心的点，关心的是失败是否留痕
      }
    });

    const updated = await runStore.get(runId);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.run.stateReason ?? "").toContain("核对失败");
  }, 15_000);
});

describe("beforeCommand：windows 与 windowId 为必需参数，缺失即抛出而非静默关闭分支守卫", () => {
  test("缺 windows 时抛出", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-missing-windows";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windowId } = await selfWindow();

    let thrown: Error | undefined;
    try {
      await beforeCommand({
        repoRoot: repo.root,
        holder,
        claims,
        runStore,
        runId,
        workflowCtx: ctx,
        windowId,
      } as Parameters<typeof beforeCommand>[0]);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
  });

  test("缺 windowId 时抛出", async () => {
    const repo = await makeRepoWithFiles();
    const home = await createTempHome();
    tempHomes.push(home);
    const requirement = "2026-09-09.write-guard-missing-windowid";
    const claims = makeClaims(repo.root);
    const { runStore, ctx, runId } = await setupRunAndEvidence(repo, home, requirement);
    const holder: Holder = { kind: "requirement", runId, requirement };
    const { windows } = await selfWindow();

    let thrown: Error | undefined;
    try {
      await beforeCommand({
        repoRoot: repo.root,
        holder,
        claims,
        runStore,
        runId,
        workflowCtx: ctx,
        windows,
      } as Parameters<typeof beforeCommand>[0]);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
  });
});

describe("snapshotWorkspace/verifyWorkspace：只读角色的工作区写入核对（按内容指纹比对）", () => {
  test("快照后工作区无变化：写入清单为空", async () => {
    const repo = await makeRepoWithFiles();
    const snapshot = await snapshotWorkspace({ repoRoot: repo.root });
    const result = await verifyWorkspace({ repoRoot: repo.root, snapshot });
    expect(result.writes).toEqual([]);
  });

  test("快照后新增未跟踪文件：写入清单包含该文件", async () => {
    const repo = await makeRepoWithFiles();
    const snapshot = await snapshotWorkspace({ repoRoot: repo.root });
    await writeFile(join(repo.root, "readonly-role-oops.txt"), "只读角色不该写入\n");
    const result = await verifyWorkspace({ repoRoot: repo.root, snapshot });
    expect(result.writes).toContain("readonly-role-oops.txt");
  });

  test("边界：排除给定路径后该写入不出现在清单中", async () => {
    const repo = await makeRepoWithFiles();
    const snapshot = await snapshotWorkspace({ repoRoot: repo.root });
    await writeFile(join(repo.root, "allowed-log.txt"), "允许的日志\n");
    const result = await verifyWorkspace({ repoRoot: repo.root, snapshot, excludePaths: ["allowed-log.txt"] });
    expect(result.writes).toEqual([]);
  });

  test("边界：命令前已 dirty 的文件被进一步修改，仍算作写入（按内容指纹而非路径集合比对）", async () => {
    const repo = await makeRepoWithFiles();
    await writeFile(join(repo.root, "own.txt"), "dirty-v1\n");
    const snapshot = await snapshotWorkspace({ repoRoot: repo.root });
    await writeFile(join(repo.root, "own.txt"), "dirty-v2\n");
    const result = await verifyWorkspace({ repoRoot: repo.root, snapshot });
    expect(result.writes).toContain("own.txt");
  });

  test("边界：命令把已 dirty 的文件还原为与 HEAD 一致，仍算作写入", async () => {
    const repo = await makeRepoWithFiles();
    await writeFile(join(repo.root, "own.txt"), "dirty-v1\n");
    const snapshot = await snapshotWorkspace({ repoRoot: repo.root });
    await runGit(["checkout", "--", "own.txt"], repo.root);
    const result = await verifyWorkspace({ repoRoot: repo.root, snapshot });
    expect(result.writes).toContain("own.txt");
  });
});
