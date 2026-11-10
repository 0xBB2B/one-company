import { afterEach, expect, test, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { setLocalIdentity, withoutGitIdentity } from "./helpers/git-identity.ts";
import { adviceOf } from "../src/core/exec/tool-failure.ts";
import { addDraftFiles, AGENTS_BASE, AGENTS_DRAFT, approvedPrdBytes, DESIGN_BASE, DESIGN_DRAFT, DESIGN_MAIN_COLOR, DESIGN_MAIN_COMPONENT, SCENARIO_CHANGES } from "./helpers/approved-files-fixture.ts";
import { parseGitVersion, versionAtLeast } from "../src/core/exec/git-read.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const exists = (path: string) => lstat(path).then(() => true, () => false);

async function world(options: { draft?: boolean; emptyRepo?: boolean; gitVersion?: () => Promise<string>; draftFiles?: Record<string, string>; mainFiles?: Record<string, string>; identity?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "workspace-manage-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture({ empty: options.emptyRepo }); cleanups.push(() => removeRepoFixture(repo));
  if (options.identity !== false) await setLocalIdentity(repo.root);
  for (const [name, content] of Object.entries(options.mainFiles ?? {})) await writeFile(join(repo.root, name), content);
  if (options.mainFiles) { await runGit(["add", "."], repo.root); await runGit(["commit", "-qm", "底稿"], repo.root); }
  const identity = await repositoryIdentity(repo.root);
  const paths = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const lines: Record<string, string[]> = {};
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...paths, lines, authorize: (request) => {
    if (request.repoId !== paths.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  }, authorizeManifest: () => true });
  const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
  const state = await RequirementStateStore.open({ ...paths, authorize: (request) => request.repoId === paths.repoId && ["open", "read"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const { requirementId, anchor } = await service.create(create);
  lines[requirementId] = [anchor];
  if (options.draftFiles) lines[requirementId].push(await addDraftFiles(paths, { requirementId, line: lines[requirementId], changes: options.draftFiles }));
  const activate = draftApprover({ ...paths, lines }, service, { requirementId, operationId: create.operationId, title: "角色跳跃", body: BODY }, grantWrite);
  const location = workspaceLocation(repo.root, requirementId);
  cleanups.push(() => rm(join(location.path, "..", ".."), { recursive: true, force: true }));
  const prompts: ProgramWindow[] = [];
  let answer = true;
  const workspace = await WorkspaceManageService.open({ ...paths, gitVersion: options.gitVersion, confirm: async (window) => { prompts.push(window); return answer; } });
  const setAnswer = (value: boolean) => { answer = value; };
  async function close() {
    const receipt = uuidv7();
    const closer = await RequirementCloseService.open({ ...paths, stopAgents: async () => {}, authorize: (request) => request.action !== "close" || request.receiptId === receipt });
    cleanups.push(async () => closer.dispose());
    return closer.close({ requirementId, reason: "cancelled", receiptId: receipt });
  }
  if (!options.draft) await activate();
  return { ...paths, repo, state, requirementId, location, workspace, prompts, setAnswer, close, activate };
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
  expect((await runGit(["rev-parse", "HEAD^"], w.location.path)).trim()).toBe(init);
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
  const w = await world({ emptyRepo: true, identity: false });
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
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).rejects.toMatchObject({ code: "recycle_blocked", blockers: [`需求分支 req/${w.requirementId} 还有改动没进主仓库当前分支 main`] });
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

async function closedWorldWithWrite(status: string) {
  const w = await world();
  await w.workspace.prepare({ requirementId: w.requirementId });
  await w.close();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.create("change_sets", uuidv7(), { requirementId: w.requirementId, status }));
  return w;
}

test("取消后回收：分支上只有程序提交的批准文件，没有别的改动，直接回收，不报还有改动没进主仓库", async () => {
  const w = await world();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  await w.close();
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).resolves.toMatchObject({ status: "recycled" });
  expect(await exists(ready.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", `req/${w.requirementId}`], w.repo.root)).rejects.toThrow();
});

test.each(["applying", "partial_failure"])("回收被%s状态的受控写入记录拦住", async (status) => {
  const w = await closedWorldWithWrite(status);
  await expect(w.workspace.recycle({ requirementId: w.requirementId }))
    .rejects.toMatchObject({ code: "recycle_blocked", blockers: ["存在未完成或待恢复的受控写入"] });
}, 30000);

test.each(["stale", "applied"])("只有%s状态的受控写入记录时回收不因写入记录被拦", async (status) => {
  const w = await closedWorldWithWrite(status);
  expect(await w.workspace.recycle({ requirementId: w.requirementId })).toMatchObject({ status: "recycled" });
}, 30000);

const mainState = async (root: string) => [await runGit(["status", "--porcelain"], root), await runGit(["for-each-ref"], root)];

async function closedWithCommit(options: { gitVersion?: () => Promise<string> } = {}) {
  const w = await world(options);
  await writeFile(join(w.repo.root, "shared.txt"), "a\nb\n");
  await runGit(["add", "shared.txt"], w.repo.root); await runGit(["commit", "-qm", "共享文件"], w.repo.root);
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  await writeFile(join(ready.path, "shared.txt"), "x\nb\n");
  await runGit(["commit", "-qam", "需求改动"], ready.path);
  await w.close();
  const branch = `req/${w.requirementId}`;
  return { w, ready, branch };
}

const mergeMethods: Record<string, (branch: string, root: string) => Promise<unknown>> = {
  "压缩合并": async (branch, root) => { await runGit(["merge", "-q", "--squash", branch], root); await runGit(["commit", "-qm", "压缩合并"], root); },
  "普通合并": (branch, root) => runGit(["merge", "-q", "--no-ff", "-m", "普通合并", branch], root),
  "快进": (branch, root) => runGit(["merge", "-q", "--ff-only", branch], root),
  "逐个 cherry-pick": async (branch, root) => { await runGit(["commit", "--allow-empty", "-qm", "主分支先前进"], root); await runGit(["cherry-pick", `${branch}~2..${branch}`], root); },
};

for (const [name, merge] of Object.entries(mergeMethods)) {
  test(`回收按改动判断已合并：${name}之后回收成功，目录和本地需求分支都被删除`, async () => {
    const { w, ready, branch } = await closedWithCommit();
    await merge(branch, w.repo.root);
    await expect(w.workspace.recycle({ requirementId: w.requirementId })).resolves.toMatchObject({ status: "recycled" });
    expect(await exists(ready.path)).toBe(false);
    await expect(runGit(["rev-parse", "--verify", branch], w.repo.root)).rejects.toThrow();
  }, 30000);
}

test("回收按改动判断已合并：需求分支末端本来就在主分支历史里，回收成功", async () => {
  const { w, ready, branch } = await closedWithCommit();
  await runGit(["merge", "-q", "--ff-only", branch], w.repo.root);
  await runGit(["commit", "--allow-empty", "-qm", "主分支继续前进"], w.repo.root);
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).resolves.toMatchObject({ status: "recycled" });
  expect(await exists(ready.path)).toBe(false);
}, 30000);

test("回收按改动判断已合并：压缩合并后主分支无关改动不影响，回收成功", async () => {
  const { w, branch } = await closedWithCommit();
  await mergeMethods["压缩合并"]!(branch, w.repo.root);
  await writeFile(join(w.repo.root, "other.txt"), "other\n");
  await runGit(["add", "other.txt"], w.repo.root); await runGit(["commit", "-qm", "无关改动"], w.repo.root);
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).resolves.toMatchObject({ status: "recycled" });
}, 30000);

async function blockedError(w: Awaited<ReturnType<typeof closedWithCommit>>["w"]) {
  const error = await w.workspace.recycle({ requirementId: w.requirementId }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "recycle_blocked" });
  return (error as { advice: { why: string; next: string } }).advice;
}

test("回收按改动判断已合并：没合并时被拦，原因点名分支，下一步给三种办法，判断不改主仓库", async () => {
  const { w, ready, branch } = await closedWithCommit();
  const before = await mainState(w.repo.root);
  const advice = await blockedError(w);
  expect(w.prompts.filter((window) => window.title === "确认回收需求工作区")).toHaveLength(0);
  expect(advice.why).toContain(`需求分支 ${branch} 还有改动没进主仓库当前分支 main`);
  expect(advice.next).toContain("git pull");
  expect(advice.next).toContain("先交付或自己合并");
  expect(advice.next).toContain(`git worktree remove '${ready.path}'`);
  expect(advice.next).toContain(`git branch -D ${branch}`);
  expect(await mainState(w.repo.root)).toEqual(before);
  expect(await exists(ready.path)).toBe(true);
}, 30000);

test("回收按改动判断已合并：压缩合并后主分支又改了同一行，被拦且判断不改主仓库", async () => {
  const { w, ready, branch } = await closedWithCommit();
  await mergeMethods["压缩合并"]!(branch, w.repo.root);
  await writeFile(join(w.repo.root, "shared.txt"), "z\nb\n");
  await runGit(["commit", "-qam", "主分支又改同一行"], w.repo.root);
  const before = await mainState(w.repo.root);
  const advice = await blockedError(w);
  expect(advice.why).toContain(`需求分支 ${branch} 还有改动没进主仓库当前分支 main`);
  expect(advice.next).toContain(`git worktree remove '${ready.path}'`);
  expect(advice.next).toContain(`git branch -D ${branch}`);
  expect(await mainState(w.repo.root)).toEqual(before);
  expect(await exists(ready.path)).toBe(true);
}, 30000);

test("回收按改动判断已合并：本机 Git 低于 2.38 时被拦", async () => {
  const { w, ready } = await closedWithCommit({ gitVersion: async () => "2.37.0" });
  const advice = await blockedError(w);
  expect(advice.why).toContain("本机 Git 版本 2.37.0 低于 2.38，判断不了需求是否已合并");
  expect(advice.next).toContain("升级 Git 后再回收");
  expect(await exists(ready.path)).toBe(true);
}, 30000);

test("回收按改动判断已合并：压缩合并后工作区有未跟踪文件，仍被拦", async () => {
  const { w, ready, branch } = await closedWithCommit();
  await mergeMethods["压缩合并"]!(branch, w.repo.root);
  await writeFile(join(ready.path, "未跟踪.txt"), "x");
  const advice = await blockedError(w);
  expect(advice.why).toContain("存在未提交或未跟踪的文件");
  expect(await exists(ready.path)).toBe(true);
}, 30000);

test("回收按改动判断已合并：主仓库没检出分支时原因写主仓库当前提交", async () => {
  const { w, branch } = await closedWithCommit();
  const head = (await runGit(["rev-parse", "--short", "HEAD"], w.repo.root)).trim();
  await runGit(["checkout", "-q", "--detach"], w.repo.root);
  const advice = await blockedError(w);
  expect(advice.why).toContain(`需求分支 ${branch} 还有改动没进主仓库当前提交 ${head}`);
}, 30000);

test("回收按改动判断已合并：worktree 目录被删并 prune 后，没合并的分支仍被拦、不被删除", async () => {
  const { w, ready, branch } = await closedWithCommit();
  await rm(ready.path, { recursive: true, force: true });
  await runGit(["worktree", "prune"], w.repo.root);
  const advice = await blockedError(w);
  expect(advice.why).toContain(`需求分支 ${branch} 还有改动没进主仓库当前分支 main`);
  expect((await runGit(["rev-parse", "--verify", branch], w.repo.root)).trim()).toMatch(/^[0-9a-f]{40}$/);
}, 30000);

test("回收按改动判断已合并：worktree 目录被删并 prune 后，已压缩合并的分支照常回收", async () => {
  const { w, ready, branch } = await closedWithCommit();
  await mergeMethods["压缩合并"]!(branch, w.repo.root);
  await rm(ready.path, { recursive: true, force: true });
  await runGit(["worktree", "prune"], w.repo.root);
  await expect(w.workspace.recycle({ requirementId: w.requirementId })).resolves.toMatchObject({ status: "recycled" });
  await expect(runGit(["rev-parse", "--verify", branch], w.repo.root)).rejects.toThrow();
}, 30000);

test("Git 版本号：带后缀的输出也能取出数字并正确比较", () => {
  expect(versionAtLeast("2.39.3", "2.38")).toBe(true);
  expect(versionAtLeast("2.38.0", "2.38")).toBe(true);
  expect(versionAtLeast("2.37.9", "2.38")).toBe(false);
  expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toBe("2.39.3");
  expect(parseGitVersion("git version 2.45.1.windows.1")).toBe("2.45.1");
});

const MAIN_FILES = { "DESIGN.md": DESIGN_BASE, "AGENTS.md": AGENTS_BASE };
type World = Awaited<ReturnType<typeof world>>;
const branchOf = (w: World) => `req/${w.requirementId}`;
const mdOf = (w: World) => `docs/prd/${w.requirementId}.角色跳跃.md`;
const htmlOf = (w: World) => `docs/prd/${w.requirementId}.设置页.html`;
const showOnBranch = (w: World, path: string) => runGit(["show", `${branchOf(w)}:${path}`], w.repo.root);
const commitsOnBranch = async (w: World, base: string) => (await runGit(["rev-list", "--count", `${base}..${branchOf(w)}`], w.repo.root)).trim();
const filesInTip = async (w: World) => (await runGit(["-c", "core.quotePath=false", "show", "--name-only", "--format=", branchOf(w)], w.repo.root)).trim().split("\n").sort();

/** 批准的草稿带原型、DESIGN.md、AGENTS.md，批准之后主仓库又改了一份文件，再回头建工作区。 */
async function approvedWithFiles(mainAfter: Record<string, string> = { "DESIGN.md": DESIGN_MAIN_COLOR }) {
  const w = await world({ mainFiles: MAIN_FILES, draftFiles: SCENARIO_CHANGES });
  for (const [name, content] of Object.entries(mainAfter)) await writeFile(join(w.repo.root, name), content);
  await runGit(["add", "."], w.repo.root); await runGit(["commit", "-qm", "主仓库后来改了"], w.repo.root);
  return w;
}
const readMain = (w: World) => Promise.all(["DESIGN.md", "AGENTS.md"].map((name) => readFile(join(w.repo.root, name))));

test("先批准后建工作区：分支正好多一个提交，装着正文、原型、DESIGN.md、AGENTS.md，说明末尾单独一行 Requirement，主仓库根目录的两个文件字节不变", async () => {
  const w = await approvedWithFiles();
  const mainBefore = await readMain(w);
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(await commitsOnBranch(w, ready.baseCommit)).toBe("1");
  expect(await filesInTip(w)).toEqual(["AGENTS.md", "DESIGN.md", htmlOf(w), mdOf(w)].sort());
  expect(await showOnBranch(w, mdOf(w))).toBe((await approvedPrdBytes(w, w.requirementId)).toString("utf8"));
  expect(await showOnBranch(w, htmlOf(w))).toBe(SCENARIO_CHANGES["prototypes/设置页.v1.html"]);
  expect(await showOnBranch(w, "AGENTS.md")).toBe(AGENTS_DRAFT);
  const message = (await runGit(["log", "-1", "--format=%B", branchOf(w)], w.repo.root)).trimEnd().split("\n");
  expect(message.at(-1)).toBe(`Requirement: ${w.requirementId}`);
  expect(await readMain(w)).toEqual(mainBefore);
  expect((await runGit(["status", "--porcelain"], ready.path)).trim()).toBe("");
  expect(await w.workspace.prepare({ requirementId: w.requirementId })).toMatchObject({ status: "ready" });
  expect(await commitsOnBranch(w, ready.baseCommit)).toBe("1");
}, 60000);

test("先批准后建工作区：DESIGN.md 里草稿改的「组件」章和主仓库后来改的「颜色」章都在合并结果里，工作区里的文件和提交一致", async () => {
  const w = await approvedWithFiles();
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  const merged = DESIGN_BASE.replace("- 主色：#0f766e", "- 主色：#2563eb").replace("- 按钮：圆角 4px", "- 按钮：圆角 8px");
  expect(await showOnBranch(w, "DESIGN.md")).toBe(merged);
  expect(await readFile(join(ready.path, "DESIGN.md"), "utf8")).toBe(merged);
}, 60000);

test("先批准后建工作区：v1 草稿改了 DESIGN.md，v1、v2 批准时都没有工作区，v2 只改正文；建工作区后分支里的 DESIGN.md 含 v1 的改动，正文是 v2 的", async () => {
  const w = await world({ draft: true, mainFiles: MAIN_FILES, draftFiles: SCENARIO_CHANGES });
  const v2Body = `${BODY}验证码六位。\n`;
  await w.activate();
  await w.activate(v2Body);
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(await showOnBranch(w, "DESIGN.md")).toBe(DESIGN_DRAFT);
  expect(await readFile(join(ready.path, "DESIGN.md"), "utf8")).toBe(DESIGN_DRAFT);
  expect(await showOnBranch(w, mdOf(w))).toContain("验证码六位。");
  expect(await showOnBranch(w, mdOf(w))).toBe((await approvedPrdBytes(w, w.requirementId)).toString("utf8"));
}, 60000);

test("先批准后建工作区：草稿没改 DESIGN.md 和 AGENTS.md 时，提交里只有正文，分支里这两个文件保持主仓库的样子", async () => {
  const w = await world({ mainFiles: MAIN_FILES });
  await writeFile(join(w.repo.root, "DESIGN.md"), DESIGN_MAIN_COLOR);
  await runGit(["commit", "-qam", "主仓库后来改了"], w.repo.root);
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(await commitsOnBranch(w, ready.baseCommit)).toBe("1");
  expect(await filesInTip(w)).toEqual([mdOf(w)]);
  expect(await showOnBranch(w, "DESIGN.md")).toBe(DESIGN_MAIN_COLOR);
  expect(await showOnBranch(w, "AGENTS.md")).toBe(AGENTS_BASE);
}, 60000);

test("先批准后建工作区：两边改了 DESIGN.md 的同一处，建工作区报冲突并写明文件和章名，不建目录、不建分支、需求不绑定工作区", async () => {
  const w = await approvedWithFiles({ "DESIGN.md": DESIGN_MAIN_COMPONENT });
  const error = await w.workspace.prepare({ requirementId: w.requirementId }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const advice = adviceOf(error)!;
  expect(advice.why).toContain("DESIGN.md");
  expect(advice.why).toContain("组件");
  expect(advice.next).toContain("让设计师按最新的 DESIGN.md 重做一版");
  expect(await exists(w.location.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", branchOf(w)], w.repo.root)).rejects.toThrow();
  expect(w.state.read(w.requirementId).data.workspace).toBeNull();
}, 60000);

test("先批准后建工作区：AGENTS.md 合不上时同样不建工作区，下一步建议按最新的 AGENTS.md 重改规范", async () => {
  const w = await approvedWithFiles({ "AGENTS.md": `${AGENTS_BASE}## 测试\n- 测试写在 tests 目录。\n` });
  const error = await w.workspace.prepare({ requirementId: w.requirementId }).catch((caught: unknown) => caught);
  const advice = adviceOf(error)!;
  expect(advice.why).toContain("AGENTS.md");
  expect(advice.next).toContain("按最新的 AGENTS.md 重改规范");
  expect(await exists(w.location.path)).toBe(false);
  await expect(runGit(["rev-parse", "--verify", branchOf(w)], w.repo.root)).rejects.toThrow();
  expect(w.state.read(w.requirementId).data.workspace).toBeNull();
}, 60000);

test("先批准后建工作区：绑定之后提交失败，再调一次 prepare 补上提交，分支仍只多一个提交", async () => {
  const w = await approvedWithFiles();
  await withoutGitIdentity(w.repo.root, async () => {
    await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toThrow();
  });
  const bound = w.state.read(w.requirementId).data.workspace;
  expect(bound).not.toBeNull();
  expect(await commitsOnBranch(w, bound!.baseCommit)).toBe("0");
  const ready = await w.workspace.prepare({ requirementId: w.requirementId });
  expect(ready).toMatchObject({ status: "ready" });
  expect(await commitsOnBranch(w, ready.baseCommit)).toBe("1");
  expect(await filesInTip(w)).toEqual(["AGENTS.md", "DESIGN.md", htmlOf(w), mdOf(w)].sort());
}, 60000);

test("先批准后建工作区：绑定之后提交失败，随后正文文件在工作区里有了未提交的改动，再调 prepare 按冲突处理，不覆盖这份改动，下一步写先提交或丢弃再批准", async () => {
  const w = await approvedWithFiles();
  await withoutGitIdentity(w.repo.root, async () => {
    await expect(w.workspace.prepare({ requirementId: w.requirementId })).rejects.toThrow();
  });
  const bound = w.state.read(w.requirementId).data.workspace!;
  await mkdir(dirname(join(bound.path, mdOf(w))), { recursive: true });
  await writeFile(join(bound.path, mdOf(w)), "用户手写的内容\n");
  const error = await w.workspace.prepare({ requirementId: w.requirementId }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const advice = adviceOf(error)!;
  expect(advice.next).toContain("先提交或丢弃工作区里这些文件的改动，再批准");
  expect(advice.next).not.toContain("设计师");
  expect(await readFile(join(bound.path, mdOf(w)), "utf8")).toBe("用户手写的内容\n");
  expect(await commitsOnBranch(w, bound.baseCommit)).toBe("0");
}, 60000);

test("批准之前主仓库根目录的 DESIGN.md、AGENTS.md 不变，也没有需求分支", async () => {
  const w = await world({ draft: true, mainFiles: MAIN_FILES, draftFiles: SCENARIO_CHANGES });
  expect(await readMain(w)).toEqual([Buffer.from(DESIGN_BASE), Buffer.from(AGENTS_BASE)]);
  expect((await runGit(["for-each-ref", "--format=%(refname)", "refs/heads"], w.repo.root)).trim()).toBe("refs/heads/main");
}, 60000);
