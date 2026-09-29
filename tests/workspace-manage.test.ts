import { afterEach, expect, test } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { uuidv7, withDatabase, repositoryDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { verifyRequirementWorkspace } from "../runtime/requirement-workspace.ts";
import { RequirementCloseService } from "../runtime/workflow-close.ts";
import { MANAGED_WORKSPACES, WorkspaceManageService, workspaceLocation } from "../runtime/workspace-manage.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function world(options: { draft?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "workspace-manage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const paths = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...paths, authorize: (request) => {
    if (request.repoId !== paths.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  } });
  const state = await RequirementStateStore.open({ ...paths, authorize: (request) => request.repoId === paths.repoId && ["open", "read"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const { requirementId } = await service.create(create);
  async function activate() {
    const confirm = { requirementId, operationId: uuidv7(), version: state.read(requirementId).version, title: "角色跳跃", body: BODY, receiptId: uuidv7() };
    grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title: confirm.title, body: BODY }), receiptId: confirm.receiptId });
    await service.confirmUpdate(confirm);
  }
  const location = workspaceLocation(repo.root, requirementId);
  cleanups.push(() => rm(join(location.path, "..", ".."), { recursive: true, force: true }));
  const prompts: string[] = [];
  let answer = true;
  const workspace = await WorkspaceManageService.open({ ...paths, confirm: async (title, message) => { prompts.push(`${title}\n${message}`); return answer; } });
  const setAnswer = (value: boolean) => { answer = value; };
  async function close() {
    const receipt = uuidv7();
    const closer = await RequirementCloseService.open({ ...paths, stopAgents: async () => {}, authorize: (request) => request.action !== "close" || request.receiptId === receipt });
    cleanups.push(async () => closer.dispose());
    return closer.close({ requirementId, reason: "cancelled", receiptId: receipt, operationId: uuidv7() });
  }
  if (!options.draft) await activate();
  return { ...paths, repo, state, requirementId, location, workspace, prompts, setAnswer, close };
}

test("M8A-AC7：草稿阶段创建工作区被拒，不弹确认、不建目录或记录", async () => {
  const w = await world({ draft: true });
  await expect(w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "requirement_not_active" });
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
  await expect(w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "declined" });
  expect(await exists(w.location.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", w.location.branch], w.repo.root)).rejects.toThrow();
  expect(w.workspace.read(w.requirementId)).toBeNull();
});

test("M7-AC10：创建按 UUID 分支与固定目录建立 worktree 并绑定需求，基线为主仓库 HEAD", async () => {
  const w = await world();
  const head = (await runGit(["rev-parse", "HEAD"], w.repo.root)).trim();
  await writeFile(join(w.repo.root, "未提交.txt"), "主仓库改动");
  const operationId = uuidv7(), before = w.state.read(w.requirementId).version;
  const ready = await w.workspace.prepare({ requirementId: w.requirementId, operationId });
  expect(ready).toMatchObject({ status: "ready", branch: `refs/heads/req/${w.requirementId}`, baseCommit: head, path: w.location.path });
  expect(w.location.path).toBe(join(dirname(w.repo.root), ".one-company-worktrees", basename(w.repo.root), w.requirementId));
  expect(w.prompts).toHaveLength(1);
  expect(w.prompts[0]).toContain(head);
  expect((await runGit(["symbolic-ref", "HEAD"], ready.path)).trim()).toBe(ready.branch);
  expect(await exists(join(ready.path, "未提交.txt"))).toBe(false);
  const binding = w.state.read(w.requirementId).data.workspace!;
  expect(binding).toMatchObject({ branch: ready.branch, baseCommit: head, prepareOperationId: operationId });
  expect(w.workspace.requirementVersion(w.requirementId)).toBe(before + 1);
  expect(await w.workspace.prepare({ requirementId: w.requirementId, operationId })).toMatchObject({ status: "ready" });
  expect(await w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() })).toMatchObject({ status: "ready", path: ready.path });
  expect(w.prompts).toHaveLength(1);
}, 30000);

test("M7-AC11：创建在 worktree 已建、绑定前中断时，同一操作续办且不重复建分支或再次确认", async () => {
  const w = await world();
  const operationId = uuidv7();
  const head = (await runGit(["rev-parse", "HEAD"], w.repo.root)).trim();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.create(MANAGED_WORKSPACES, w.requirementId, { format: "managed-workspace/v1",
    requirementId: w.requirementId, operationId, baseCommit: head, branch: w.location.branch, path: w.location.path, status: "preparing", recycleOperationId: null }));
  await mkdir(join(w.location.path, ".."), { recursive: true });
  await runGit(["worktree", "add", "-b", `req/${w.requirementId}`, w.location.path, head], w.repo.root);
  expect(await w.workspace.prepare({ requirementId: w.requirementId, operationId })).toMatchObject({ status: "ready" });
  expect(w.prompts).toHaveLength(0);
  expect(w.state.read(w.requirementId).data.workspace?.path).toBe(w.location.path);
}, 30000);

test("M7-AC11：目标目录被身份不明的内容占用或同名分支指向别处时阻塞，不覆盖", async () => {
  const w = await world();
  await mkdir(w.location.path, { recursive: true });
  await writeFile(join(w.location.path, "用户文件.txt"), "保留");
  await expect(w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "path_conflict" });
  expect(await readdir(w.location.path)).toEqual(["用户文件.txt"]);

  const v = await world();
  await runGit(["commit", "--allow-empty", "-qm", "另一提交"], v.repo.root);
  await runGit(["branch", `req/${v.requirementId}`, "HEAD"], v.repo.root);
  await runGit(["reset", "-q", "--hard", "HEAD~1"], v.repo.root);
  await expect(v.workspace.prepare({ requirementId: v.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "branch_conflict" });
}, 30000);

test("M7-AC10：外部切换 worktree 分支后旧绑定核验失败", async () => {
  const w = await world();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() });
  await verifyRequirementWorkspace(w.dataRoot, w.state.read(w.requirementId).data.workspace!);
  await runGit(["switch", "-q", "-c", "外部分支"], ready.path);
  await expect(verifyRequirementWorkspace(w.dataRoot, w.state.read(w.requirementId).data.workspace!)).rejects.toMatchObject({ code: "workspace_binding_changed" });
}, 30000);

test("M7-AC11：活动需求不能回收；关闭后有未交付内容默认保留并报告，清理后才回收且幂等", async () => {
  const w = await world();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId, operationId: uuidv7() });
  await expect(w.workspace.recycle({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "requirement_not_closed" });
  await w.close();
  expect(w.state.read(w.requirementId).data.lifecycle).toBe("closed");

  await writeFile(join(ready.path, "未跟踪.txt"), "x");
  await expect(w.workspace.recycle({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "recycle_blocked", blockers: ["存在未提交或未跟踪的文件"] });
  await runGit(["add", "."], ready.path); await runGit(["commit", "-qm", "未合并"], ready.path);
  await expect(w.workspace.recycle({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "recycle_blocked", blockers: ["分支存在未合并进主仓库当前分支的提交"] });
  expect(await exists(ready.path)).toBe(true);

  await runGit(["merge", "-q", "--ff-only", `req/${w.requirementId}`], w.repo.root);
  w.setAnswer(false);
  await expect(w.workspace.recycle({ requirementId: w.requirementId, operationId: uuidv7() })).rejects.toMatchObject({ code: "declined" });
  expect(await exists(ready.path)).toBe(true);
  w.setAnswer(true);
  const operationId = uuidv7();
  expect(await w.workspace.recycle({ requirementId: w.requirementId, operationId })).toMatchObject({ status: "recycled", recycleOperationId: operationId });
  expect(await exists(ready.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", `req/${w.requirementId}`], w.repo.root)).rejects.toThrow();
  expect(await w.workspace.recycle({ requirementId: w.requirementId, operationId: uuidv7() })).toMatchObject({ status: "recycled", recycleOperationId: operationId });
  expect((await runGit(["rev-parse", "HEAD"], w.repo.root)).trim()).toMatch(/^[0-9a-f]{40}$/);
}, 30000);
