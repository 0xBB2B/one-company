import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RunManager } from "../daemon/run-manager.ts";
import { createPmTools } from "../daemon/pm-tools.ts";
import { createClock } from "../runtime/clock.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { WorkspaceManageService } from "../runtime/workspace-manage.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import { createFakeTimeSource } from "./helpers/fake-clock.ts";
import { notePlanRejection, planRejectionsIn, stallIn } from "../runtime/pm-attention.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("等待超时");
}

async function manager(base: { repositoryRoot: string; dataRoot: string; repoId: string }, root: string, clock = createClock()) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: "pm-model", modelId: "test" });
  cleanups.push(() => clock.stopGapWatcher());
  const runStore = new RunStore({ dataRoot: base.dataRoot, repoId: base.repoId, daemonStartedAt: new Date().toISOString() });
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(root, "none-u"), projectDir: join(root, "none-p"), parseFrontmatter, projectTrusted: false });
  const runs = new RunManager({ ...base, runStore, shellRegistry: new ShellRegistry({ clock, database: repositoryDatabase(base.dataRoot, base.repoId) }),
    networkGate: new NetworkPauseGate(), roleCatalog: catalog.roles, runtime, clock, workspaceRepoIds: [base.repoId], emit: vi.fn() });
  runs.markStarted();
  cleanups.push(async () => { for (const run of (await runStore.list({ limit: 100 })).items) await runs.stop(run.id, { reason: "main_agent" }).catch(() => {}); });
  return { provider, runStore, runs };
}

/** 没有批准清单的需求：用于核验派出前置条件。 */
async function plainWorld(options: { prepare?: boolean; activate?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "pm-dispatch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const { repoId } = await repositoryIdentity(repo.root);
  const base = { repositoryRoot: repo.root, dataRoot: join(root, "agent", "one-company"), repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...base, authorize: (request) => {
    if (request.repoId !== repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  } });
  const state = await RequirementStateStore.open({ ...base, authorize: (request) => request.repoId === repoId && ["open", "read"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const { requirementId } = await service.create(create);
  if (options.activate !== false) {
    const confirm = { requirementId, operationId: uuidv7(), version: state.read(requirementId).version, title: "角色跳跃", body: BODY, receiptId: uuidv7() };
    grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title: confirm.title, body: BODY }), receiptId: confirm.receiptId });
    await service.confirmUpdate(confirm);
    if (options.prepare !== false) {
      const workspace = await WorkspaceManageService.open({ ...base, confirm: async () => true });
      const ready = await workspace.prepare({ requirementId, operationId: uuidv7() });
      cleanups.push(() => rm(join(ready.path, "..", ".."), { recursive: true, force: true }));
    }
  }
  const { runs } = await manager(base, root);
  return { dispatch: () => runs.dispatchPm({ requirementId, model: { provider: "pm-model", id: "test" }, thinking: "off" }) };
}

/** 带实施授权批准清单的需求：夹具原有的 PM 租约置为过期，工作区登记为 ready。 */
async function world(clock?: ReturnType<typeof createClock>) {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    db.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    db.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, title: "角色跳跃", operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const base = { repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, repoId: fixture.repoId };
  const { provider, runStore, runs } = await manager(base, fixture.root, clock);
  const dispatch = () => runs.dispatchPm({ requirementId: fixture.requirementId, model: { provider: "pm-model", id: "test" }, thinking: "off" });
  return { ...base, state: fixture.state, requirementId: fixture.requirementId, provider, runStore, manager: runs, dispatch };
}

function toolNames(request: Context | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name).sort();
}

test("M7-AC13、M8A-AC7：PM 只在工作区 ready、需求 active 且有实施授权时派出，已生效但没有工作区时被拒，受限接手上下文不含 prod 正文", async () => {
  await expect((await plainWorld({ prepare: false })).dispatch()).rejects.toMatchObject({ code: "workspace_not_ready" });
  await expect((await plainWorld({ activate: false })).dispatch()).rejects.toMatchObject({ code: "requirement_not_active" });
  await expect((await plainWorld()).dispatch()).rejects.toMatchObject({ code: "implement_not_authorized" });
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "等待" }]);
  const { runId, fence } = await w.dispatch();
  expect(fence).toBe(2);
  await until(() => w.provider.requests.length === 1);
  const request = w.provider.requests[0]!;
  expect(request.systemPrompt).toContain(w.requirementId);
  expect(request.systemPrompt).toContain("受限接手");
  expect(request.systemPrompt).toMatch(/- prod-unit：metadata/);
  expect(request.systemPrompt).toContain("- prod-scenario（必需场景）：");
  expect(request.systemPrompt).toContain("- decision：");
  expect(request.systemPrompt).toMatch(/\n  - [0-9a-f-]{36}（confirmed，涉及 [^）]+）：\S/);
  expect(JSON.stringify(request)).not.toContain("输入正确验证码后成功");
  expect(toolNames(request)).toEqual(["find", "grep", "ls", "one_company_agent_manage", "one_company_git_commit", "one_company_git_sync", "one_company_plan_manage", "one_company_requirement_manage", "one_company_user_interact",
    "one_company_verification_run", "one_company_workflow_manage", "read"]);
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { kind: "requirement", state: "running", requirement: w.requirementId } });
}, 30000);

test("M8D2-AC2：派 PM 时上下文含用户级与项目 AGENTS.md 此刻的磁盘内容并标明来源；两份都没有时照常启动、不带规范", async () => {
  const plain = await world();
  scriptReplies(plain.provider, [{ type: "text", text: "等待" }]);
  await plain.dispatch();
  await until(() => plain.provider.requests.length === 1);
  expect(plain.provider.requests[0]!.systemPrompt).not.toContain("规范（来源");

  const w = await world();
  await writeFile(join(dirname(w.dataRoot), "AGENTS.md"), "# 用户规范\n- 说明用白话写。\n");
  await writeFile(join(w.repositoryRoot, "AGENTS.md"), "# 项目规范\n- 导出常量用大写下划线命名。\n");
  scriptReplies(w.provider, [{ type: "text", text: "等待" }]);
  await w.dispatch();
  await until(() => w.provider.requests.length === 1);
  const prompt = w.provider.requests[0]!.systemPrompt!;
  expect(prompt).toContain("用户规范（来源：用户级 AGENTS.md；必须遵守）：\n# 用户规范\n- 说明用白话写。");
  expect(prompt).toContain("项目规范（来源：仓库根目录 AGENTS.md；本任务的改动必须遵守）：\n# 项目规范\n- 导出常量用大写下划线命名。");
  expect(prompt.indexOf("用户规范（来源")).toBeLessThan(prompt.indexOf("项目规范（来源"));
}, 60000);

test("M7-AC5：同一需求只有一个有效 PM；停止后再派出取得更高 fence，旧运行的工具失效", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  const first = await w.dispatch();
  await expect(w.dispatch()).rejects.toThrow();
  const firstLease = (await RequirementStateStore.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId,
    authorize: () => true })).pmOwner(w.requirementId)!.lease!;
  const record = w.state.read(w.requirementId).data;
  const stale = await createPmTools({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, lease: firstLease, workspace: record.workspace!,
    epoch: record.epoch, alive: () => true, stopAgents: async () => {} });
  cleanups.push(() => stale.dispose());
  expect(await w.manager.stop(first.runId, { reason: "main_agent" })).toMatchObject({ confirmed: true });
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "stopped", stopCause: { reason: "main_agent" } } });
  const second = await w.dispatch();
  expect(second.fence).toBeGreaterThan(first.fence);
  const read = stale.tools.find((tool) => tool.name === "one_company_requirement_manage")!;
  await expect(read.execute("late", { action: "metadata" }, undefined, undefined, undefined as never)).rejects.toThrow();
}, 30000);

test("M7-AC9：按需求停止结束全部运行，关闭协议依赖的运行终态真实登记", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }]);
  const { runId } = await w.dispatch();
  await w.manager.stopRequirement(w.requirementId, { reason: "requirement_closing" });
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { state: "stopped", stopCause: { reason: "requirement_closing" } } });
  const owner = (await RequirementStateStore.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true })).pmOwner(w.requirementId);
  expect(owner?.lease ?? null).toBeNull();
}, 30000);

test("M7-AC5：旧 PM 租约过期后再派出即接管，旧会话立即停止且其工具失效", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  const first = await w.dispatch();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", w.requirementId)!;
    db.update("pm_ownership", w.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
  });
  const second = await w.dispatch();
  expect(second.fence).toBeGreaterThan(first.fence);
  expect(await w.runStore.get(first.runId)).toMatchObject({ ok: true, run: { state: "stopped", stopCause: { reason: "superseded_by_new_pm" } } });
  expect(await w.runStore.get(second.runId)).toMatchObject({ ok: true, run: { state: "running" } });
}, 30000);

test("M8C-AC8：PM 续租失败时停止并记下原因与错误码；停止行为不变，租约已失效的旧运行照常停止", async () => {
  const time = createFakeTimeSource();
  const w = await world(createClock({ timeSource: time, sleepGapThresholdMs: Number.MAX_SAFE_INTEGER }));
  scriptReplies(w.provider, [{ type: "text", text: "一" }]);
  const renew = vi.spyOn(RequirementStateStore.prototype, "renewPm").mockRejectedValue(Object.assign(new Error("租约已被接管"), { code: "lease_superseded" }));
  cleanups.push(() => renew.mockRestore());
  const { runId } = await w.dispatch();
  time.advance(10_000);
  await until(async () => { const run = await w.runStore.get(runId); return run.ok && run.run.state === "stopped"; });
  expect(await w.runStore.get(runId)).toMatchObject({ ok: true, run: { state: "stopped", stopCause: { reason: "lease_renewal_failed", code: "lease_superseded" } } });
}, 30000);

test("M7-AC10：需求已 active 但托管工作区尚未 ready 时不派 PM", async () => {
  const w = await world();
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.read<{ status: string }>("managed_workspaces", w.requirementId)!;
    db.update("managed_workspaces", w.requirementId, row.version, { ...row.data, status: "preparing" });
  });
  await expect(w.dispatch()).rejects.toMatchObject({ code: "workspace_not_ready" });
  expect((await w.runStore.list({ limit: 10 })).items).toHaveLength(0);
}, 30000);

test("M7-AC5：两个派出请求同时竞争同一需求，只有一个取得租约，另一个被拒且不留下运行中的会话", async () => {
  const w = await world();
  scriptReplies(w.provider, [{ type: "text", text: "一" }, { type: "text", text: "二" }]);
  const results = await Promise.allSettled([w.dispatch(), w.dispatch()]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const running = (await w.runStore.list({ limit: 10 })).items.filter((run) => run.state === "running");
  expect(running).toHaveLength(1);
  const owner = (await RequirementStateStore.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true })).pmOwner(w.requirementId);
  expect(owner?.lease?.runId).toBe(running[0]!.id);
}, 30000);

test("M8D-AC4：主代理给 PM 发消息时 PM 收到程序加的主代理转述标签；PM 暂停时排队到恢复后送达；没有 PM 或超长时拒绝并写明原因", async () => {
  const w = await world();
  await expect(w.manager.messagePm({ requirementId: w.requirementId, text: "先做登录" })).rejects.toMatchObject({ code: "pm_not_running" });
  scriptReplies(w.provider, [{ type: "text", text: "等待" }, { type: "text", text: "收到" }, { type: "text", text: "收到" }]);
  const { runId } = await w.dispatch();
  await until(() => w.provider.requests.length === 1);
  await expect(w.manager.messagePm({ requirementId: w.requirementId, text: "x".repeat(4001) })).rejects.toMatchObject({ code: "invalid_params" });
  expect(await w.manager.messagePm({ requirementId: w.requirementId, text: "先做登录再做注册" })).toEqual({ delivered: "now" });
  await until(() => w.provider.requests.length === 2);
  const delivered = JSON.stringify(w.provider.requests[1]!.messages.at(-1));
  expect(delivered).toContain("【主代理转述】");
  expect(delivered).toContain("不改变任务、计划或授权");
  expect(delivered).toContain("先做登录再做注册");
  await w.manager.pause(runId);
  expect(await w.manager.messagePm({ requirementId: w.requirementId, text: "登录页先不做记住我" })).toEqual({ delivered: "after_resume" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(w.provider.requests).toHaveLength(2);
  await w.manager.resume(runId);
  await until(() => w.provider.requests.length === 3);
  expect(JSON.stringify(w.provider.requests[2]!.messages)).toContain("登录页先不做记住我");
}, 30000);

test("M8L-AC2：PM 一轮结束、没有在跑的子任务和待处理事项时登记停下提醒，带最后的话与运行记录；被唤醒后旧提醒清掉，再停下时按新的一轮重记", async () => {
  const w = await world();
  const stall = () => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => stallIn(db, w.requirementId));
  scriptReplies(w.provider, [{ type: "text", text: "接手完成，接下来规划。" }, { type: "text", text: "收到，继续规划。" }]);
  const { runId } = await w.dispatch();
  await until(() => stall() !== null);
  expect(stall()).toMatchObject({ pmRunId: runId, lastText: "接手完成，接下来规划。", log: expect.stringContaining(runId) });
  await w.manager.messagePm({ requirementId: w.requirementId, text: "继续" });
  await until(() => stall()?.lastText === "收到，继续规划。");
}, 30000);

test("M8L-AC1：计划第 1 次被拒后 PM 停下时程序自动唤醒它一次并附被拒原因；唤醒后仍停下转为停下提醒；主代理转话后被拒次数清零", async () => {
  const w = await world();
  const ref = { dataRoot: w.dataRoot, repoId: w.repoId };
  const read = <T>(get: (db: Parameters<typeof stallIn>[0]) => T) => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), get);
  scriptReplies(w.provider, [{ type: "text", text: "计划被拒，先停下。", chunkDelayMs: 400 }, { type: "text", text: "我再想想。" }, { type: "text", text: "好的" }]);
  const { runId } = await w.dispatch();
  await until(() => w.provider.requests.length === 1);
  notePlanRejection(ref, w.requirementId, runId, { action: "propose", reason: "任务目标不在用户批准的实施范围内", detail: "features.air", at: Date.now() });
  await until(() => w.provider.requests.length === 2);
  const woken = JSON.stringify(w.provider.requests[1]!.messages.at(-1));
  expect(woken).toContain("features.air");
  expect(woken).toContain("按原因修改");
  await until(() => read((db) => stallIn(db, w.requirementId)) !== null);
  expect(read((db) => planRejectionsIn(db, w.requirementId))).toMatchObject({ count: 1, autoWoken: true });
  expect(w.provider.requests).toHaveLength(2);
  await w.manager.messagePm({ requirementId: w.requirementId, text: "把空中验收放进约束段" });
  expect(read((db) => planRejectionsIn(db, w.requirementId))).toBeNull();
}, 30000);

test("M8L-AC1：计划已被拒 2 次时 PM 停下不再自动唤醒，也不出停下提醒，由“待你裁决”事项交用户", async () => {
  const w = await world();
  const ref = { dataRoot: w.dataRoot, repoId: w.repoId };
  scriptReplies(w.provider, [{ type: "text", text: "两次都被拒，等用户决定。", chunkDelayMs: 400 }]);
  const { runId } = await w.dispatch();
  await until(() => w.provider.requests.length === 1);
  for (const reason of ["原因一", "原因二"]) notePlanRejection(ref, w.requirementId, runId, { action: "propose", reason, detail: "", at: Date.now() });
  // 回复延迟 400 毫秒才结束这一轮，再多等一段确认这一轮结束后既没有被唤醒也没有登记停下提醒
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(w.provider.requests).toHaveLength(1);
  expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => stallIn(db, w.requirementId))).toBeNull();
  expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => planRejectionsIn(db, w.requirementId))).toMatchObject({ count: 2, lastText: "两次都被拒，等用户决定。" });
}, 30000);
