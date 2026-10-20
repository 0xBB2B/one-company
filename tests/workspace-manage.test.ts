import { afterEach, expect, test, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { UUID_V7_PATTERN, uuidv7, withDatabase, repositoryDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { verifyRequirementWorkspace } from "../src/modules/requirement/requirement-workspace.ts";
import { RequirementCloseService } from "../src/modules/delivery/workflow-close.ts";
import type { ProgramWindow } from "../src/core/host/question-window.ts";
import { MANAGED_WORKSPACES, WorkspaceManageService, workspaceLocation } from "../src/modules/delivery/workspace-manage.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function world(options: { draft?: boolean; emptyRepo?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "workspace-manage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture({ empty: options.emptyRepo }); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const paths = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...paths, authorize: (request) => {
    if (request.repoId !== paths.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  }, authorizeManifest: () => true });
  const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
  const state = await RequirementStateStore.open({ ...paths, authorize: (request) => request.repoId === paths.repoId && ["open", "read"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const { requirementId } = await service.create(create);
  const activate = draftApprover(paths, service, { requirementId, operationId: create.operationId, title: "角色跳跃", body: BODY }, grantWrite);
  const location = workspaceLocation(repo.root, requirementId);
  cleanups.push(() => rm(join(location.path, "..", ".."), { recursive: true, force: true }));
  const prompts: ProgramWindow[] = [];
  let answer = true;
  const workspace = await WorkspaceManageService.open({ ...paths, confirm: async (window) => { prompts.push(window); return answer; } });
  const setAnswer = (value: boolean) => { answer = value; };
  async function close() {
    const receipt = uuidv7();
    const closer = await RequirementCloseService.open({ ...paths, stopAgents: async () => {}, authorize: (request) => request.action !== "close" || request.receiptId === receipt });
    cleanups.push(async () => closer.dispose());
    return closer.close({ requirementId, reason: "cancelled", receiptId: receipt });
  }
  if (!options.draft) await activate();
  return { ...paths, repo, state, requirementId, location, workspace, prompts, setAnswer, close };
}

test("M8A-AC7：草稿阶段创建工作区被拒，不弹确认、不建目录或记录", async () => {
  const w = await world({ draft: true });
  await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "requirement_not_active" });
  expect(w.prompts).toHaveLength(0);
  expect(await exists(w.location.path)).toBe(false);
  expect(w.workspace.read(w.requirementId)).toBeNull();
}, 30000);

test("M8A-AC7：已生效但没有工作区的需求可以取消", async () => {
  const w = await world();
  expect(w.state.read(w.requirementId).data).toMatchObject({ lifecycle: "active", workspace: null });
  await w.close();
  expect(w.state.read(w.requirementId).data.lifecycle).toBe("closed");
}, 30000);

test("M7-AC10：创建须真实确认；拒绝则不建分支、目录或记录", async () => {
  const w = await world();
  w.setAnswer(false);
  await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "declined" });
  expect(await exists(w.location.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", w.location.branch], w.repo.root)).rejects.toThrow();
  expect(w.workspace.read(w.requirementId)).toBeNull();
});

test("空仓库开工：确认窗口说明将建 init 空提交，确认后以它为基线建工作区，已暂存的文件仍留在暂存区", async () => {
  const w = await world({ emptyRepo: true });
  await writeFile(join(w.repo.root, "staged.txt"), "staged\n");
  await runGit(["add", "staged.txt"], w.repo.root);
  const prepared = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(w.prompts[0]!.lines.map((line) => line.text)).toContain("基线提交：仓库还没有任何提交，确认后先在 main 分支上建一个空提交（说明为 init）作为基线");
  expect((await runGit(["log", "--format=%s", "main"], w.repo.root)).trim()).toBe("init");
  const init = (await runGit(["rev-parse", "main"], w.repo.root)).trim();
  expect((await runGit(["ls-tree", init], w.repo.root)).trim()).toBe("");
  expect(await runGit(["status", "--porcelain=v1"], w.repo.root)).toBe("A  staged.txt\n");
  expect(prepared).toMatchObject({ status: "ready", baseCommit: init });
  expect((await runGit(["rev-parse", "HEAD"], w.location.path)).trim()).toBe(init);
}, 30000);

test("M7-AC10：空仓库开工被拒时不建 init 提交、分支、目录或记录", async () => {
  const w = await world({ emptyRepo: true });
  w.setAnswer(false);
  await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "declined" });
  await expect(runGit(["rev-parse", "--verify", "HEAD"], w.repo.root)).rejects.toThrow();
  expect(await runGit(["for-each-ref", "refs/heads"], w.repo.root)).toBe("");
  expect(await exists(w.location.path)).toBe(false);
  expect(w.workspace.read(w.requirementId)).toBeNull();
}, 30000);

test("空仓库开工时没配 Git 用户名和邮箱，报出 Git 的原因，不建分支、目录或记录", async () => {
  const w = await world({ emptyRepo: true });
  await runGit(["config", "user.useConfigOnly", "true"], w.repo.root);
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) vi.stubEnv(name, undefined);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null"); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  try {
    const error = await w.workspace.prepare({ requirementId: w.requirementId }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "git_failed" });
    expect((error as Error).message).toMatch(/git commit-tree --no-gpg-sign：[\s\S]*no email was given/);
  } finally { vi.unstubAllEnvs(); }
  expect(await runGit(["for-each-ref", "refs/heads"], w.repo.root)).toBe("");
  expect(await exists(w.location.path)).toBe(false);
  expect(w.workspace.read(w.requirementId)).toBeNull();
}, 30000);

test("M7-AC10：创建按 UUID 分支与固定目录建立 worktree 并绑定需求，基线为主仓库 HEAD", async () => {
  const w = await world();
  const head = (await runGit(["rev-parse", "HEAD"], w.repo.root)).trim();
  await writeFile(join(w.repo.root, "未提交.txt"), "主仓库改动");
  const before = w.state.read(w.requirementId).version;
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(ready).toMatchObject({ status: "ready", branch: `refs/heads/req/${w.requirementId}`, baseCommit: head, path: w.location.path });
  expect(w.location.path).toBe(join(dirname(w.repo.root), ".one-company-worktrees", basename(w.repo.root), w.requirementId));
  expect(w.prompts).toHaveLength(1);
  expect(w.prompts[0]!.title).toBe("确认创建需求工作区");
  expect(w.prompts[0]!.lines[0]).toEqual({ text: "需求：角色跳跃" });
  expect(w.prompts[0]!.lines.slice(1).every((line) => line.tone === "muted")).toBe(true);
  expect(w.prompts[0]!.lines.map((line) => line.text)).toEqual(expect.arrayContaining([`编号：${w.requirementId}`, `基线提交：${head}`]));
  expect(ready.title).toBe("角色跳跃");
  expect((await runGit(["symbolic-ref", "HEAD"], ready.path)).trim()).toBe(ready.branch);
  expect(await exists(join(ready.path, "未提交.txt"))).toBe(false);
  const binding = w.state.read(w.requirementId).data.workspace!;
  expect(binding).toMatchObject({ branch: ready.branch, baseCommit: head });
  expect(binding.prepareOperationId).toMatch(UUID_V7_PATTERN);
  expect(w.workspace.requirementVersion(w.requirementId)).toBe(before + 1);
  expect(await w.workspace.prepare({ requirementId: w.requirementId })).toMatchObject({ status: "ready", path: ready.path });
  expect(w.prompts).toHaveLength(1);
}, 30000);

test("M7-AC11：创建在 worktree 已建、绑定前中断时，原样再调用原编号续办且不重复建分支或再次确认", async () => {
  const w = await world();
  const operationId = uuidv7();
  const head = (await runGit(["rev-parse", "HEAD"], w.repo.root)).trim();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.create(MANAGED_WORKSPACES, w.requirementId, { format: "managed-workspace/v1",
    requirementId: w.requirementId, title: "角色跳跃", operationId, baseCommit: head, branch: w.location.branch, path: w.location.path, status: "preparing", recycleOperationId: null }));
  await mkdir(join(w.location.path, ".."), { recursive: true });
  await runGit(["worktree", "add", "-b", `req/${w.requirementId}`, w.location.path, head], w.repo.root);
  expect(await w.workspace.prepare({ requirementId: w.requirementId })).toMatchObject({ status: "ready" });
  expect(w.prompts).toHaveLength(0);
  expect(w.state.read(w.requirementId).data.workspace).toMatchObject({ path: w.location.path, prepareOperationId: operationId });
}, 30000);

test("M7-AC11：目标目录被身份不明的内容占用或同名分支指向别处时阻塞，不覆盖", async () => {
  const w = await world();
  await mkdir(w.location.path, { recursive: true });
  await writeFile(join(w.location.path, "用户文件.txt"), "保留");
  await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "path_conflict" });
  expect(await readdir(w.location.path)).toEqual(["用户文件.txt"]);

  const v = await world();
  await runGit(["commit", "--allow-empty", "-qm", "另一提交"], v.repo.root);
  await runGit(["branch", `req/${v.requirementId}`, "HEAD"], v.repo.root);
  await runGit(["reset", "-q", "--hard", "HEAD~1"], v.repo.root);
  await expect(v.workspace.prepare({ requirementId: v.requirementId })).rejects.toMatchObject({ code: "branch_conflict" });
}, 30000);

test("M7-AC10：外部切换 worktree 分支后旧绑定核验失败", async () => {
  const w = await world();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  await verifyRequirementWorkspace(w.dataRoot, w.state.read(w.requirementId).data.workspace!);
  await runGit(["switch", "-q", "-c", "外部分支"], ready.path);
  await expect(verifyRequirementWorkspace(w.dataRoot, w.state.read(w.requirementId).data.workspace!)).rejects.toMatchObject({ code: "workspace_binding_changed" });
}, 30000);

test("M7-AC11：活动需求不能回收；关闭后有未交付内容默认保留并报告，清理后才回收且幂等", async () => {
  const w = await world();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "requirement_not_closed" });
  await w.close();
  expect(w.state.read(w.requirementId).data.lifecycle).toBe("closed");

  await writeFile(join(ready.path, "未跟踪.txt"), "x");
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "recycle_blocked", blockers: ["存在未提交或未跟踪的文件"] });
  await runGit(["add", "."], ready.path); await runGit(["commit", "-qm", "未合并"], ready.path);
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "recycle_blocked", blockers: ["分支存在未合并进主仓库当前分支的提交"] });
  expect(await exists(ready.path)).toBe(true);

  await runGit(["merge", "-q", "--ff-only", `req/${w.requirementId}`], w.repo.root);
  w.setAnswer(false);
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "declined" });
  expect(await exists(ready.path)).toBe(true);
  w.setAnswer(true);
  const recycled = await w.workspace.recycle({ requirementId: w.requirementId });
  expect(recycled).toMatchObject({ status: "recycled" });
  const operationId = recycled.recycleOperationId;
  expect(operationId).toMatch(UUID_V7_PATTERN);
  expect(w.prompts.at(-1)!.title).toBe("确认回收需求工作区");
  expect(w.prompts.at(-1)!.lines[0]).toEqual({ text: "需求：角色跳跃" });
  expect(await exists(ready.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", `req/${w.requirementId}`], w.repo.root)).rejects.toThrow();
  expect(await w.workspace.recycle({ requirementId: w.requirementId })).toMatchObject({ status: "recycled", recycleOperationId: operationId });
  expect((await runGit(["rev-parse", "HEAD"], w.repo.root)).trim()).toMatch(/^[0-9a-f]{40}$/);
}, 30000);
