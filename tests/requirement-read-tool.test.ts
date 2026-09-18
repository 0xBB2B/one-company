import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { createRequirementReadTool } from "../runtime/requirement-read-tool.ts";
import type { RequirementReadBinding, RequirementReadToolOptions } from "../runtime/requirement-read-tool.ts";
import * as storage from "../runtime/prod-storage.ts";
import { inspectProdStructure } from "../runtime/prod-view.ts";
import { createRepoFixture, addWorktree, removeRepoFixture, GIT_ENV } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { testHostGitExecutable } from "./helpers/test-git-binding.ts";

const HOST_GIT = testHostGitExecutable([]);

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动，空格跳跃😀。不做二段跳。\n# 黑盒场景 {#scenario.jump}\n前置：角色在地面。操作：起跳后空中再次按空格。结果：第二次不再起跳，最终落地。\n# 整体约束 {#constraints}\n暂停时所有动作输入无效。\n# 未决 {#unresolved}\n跳跃高度未确认，相关验收阻塞。\n";

async function world(body = BODY) {
  const root = await mkdtemp(join(temporaryRoot(), "prod-read-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId, gitExecutable: HOST_GIT };
  // 测试准备只为确切操作/正文指纹/批准凭据发放许可，不把always-true当作产品身份验证。
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...options, authorize: (request) => {
    if (request.repoId !== options.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  } });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "acquire-pm", "release-pm", "begin-close", "finish-close", "block-recovery"].includes(request.action) });
  async function create(body = BODY) {
    const input = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body };
    grants.set(input.operationId, { action: "create", intent: requirementIntentHash({ title: input.title, body }) });
    return service.create(input);
  }
  async function save(requirementId: string, body: string, approve = true) {
    const input = { requirementId, operationId: uuidv7(), version: state.read(requirementId).version, title: "角色跳跃", body };
    const receiptId = approve ? uuidv7() : undefined;
    grants.set(input.operationId, { action: approve ? "confirmUpdate" : "updateDraft", intent: requirementIntentHash({ title: input.title, body }), receiptId });
    return approve ? service.confirmUpdate({ ...input, receiptId: receiptId! }) : service.updateDraft(input);
  }
  async function bind(requirementId: string) {
    const worktree = await addWorktree(repo);
    const baseCommit = (await exec(HOST_GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    await state.bindWorkspace({ requirementId, version: state.read(requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
    return worktree;
  }
  const created = await create(body);
  const worktree = await bind(created.requirementId);
  const approved = await save(created.requirementId, body);
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  const workspace = state.read(created.requirementId).data.workspace!;
  const sessions = new Map<string, string>();
  function binding(role: RequirementReadBinding["role"] = "pm"): RequirementReadBinding {
    return { callerId: uuidv7(), runId: role === "pm" ? lease.runId : uuidv7(), role,
      requirementId: created.requirementId, repoId: options.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch,
      lease: structuredClone(lease), diffBaseline: { revision: 1, reference: { commit: approved.commit, hash: approved.prodHash.slice(7) } } };
  }
  const host: RequirementReadToolOptions["authorize"] = (request) => sessions.get(request.binding.callerId) === JSON.stringify(request.binding);
  async function tool(bound = binding(), authorize = host) {
    sessions.set(bound.callerId, JSON.stringify(bound));
    const instance = await createRequirementReadTool({ ...options, binding: bound, authorize });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  function close(finish = false) {
    const operationId = uuidv7();
    const closing = state.beginClose({ requirementId: created.requirementId, version: state.read(created.requirementId).version,
      intent: { operationId, receiptId: uuidv7(), reason: "cancelled" } });
    if (finish) state.finishClose({ requirementId: created.requirementId, version: closing.version, operationId });
  }
  return { ...options, root, repo, service, state, created, approved, lease, workspace, worktree, binding, sessions, host, tool, create, save, bind, close };
}
const denied = { code: "requirement_read_denied" };
function content(result: unknown) { return result as { text: string; source: { commit: string; revision: number; role: string };
  structure: ReturnType<typeof inspectProdStructure> & { totalSections: number; startSection: number; endSection: number;
    remainingSections: number; complete: boolean };
  coverage: { nextCursor: string | null; entireProdCovered: boolean; blocking: string[]; startByte: number; endByte: number;
    totalBytes: number; selectedTextComplete: boolean; performance: string; verification: string } } }

const LONG_STRUCTURE_BODY = Array.from({ length: 256 }, (_, i) =>
  `# Heading {#s${String(i).padStart(3, "0")}${"x".repeat(92)}}\nX\n`).join("");
function bounded(result: unknown) {
  const json = JSON.stringify(result);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(49_152);
  expect(json.indexOf('"source":')).toBeLessThan(json.indexOf('"text":'));
  expect(json.indexOf('"coverage":')).toBeLessThan(json.indexOf('"text":'));
  return content(result);
}

test.each([
  ["256个最长ID", LONG_STRUCTURE_BODY],
  ["双引号", '"'.repeat(32_768)],
  ["反斜杠", "\\".repeat(32_768)],
  ["控制字符", "\u0001".repeat(32_768)],
  ["中文emoji与转义混合", '中😀"\\\u0001'.repeat(4_000)],
])("整包预算与复合续页无损重组：%s", async (_name, body) => {
  const w = await world(body!); const tool = await w.tool(w.binding("qa"));
  const expected = inspectProdStructure(body!);
  const sections: typeof expected.sections = [];
  let cursor: string | undefined, combined = "", pages = 0;
  do {
    expect(++pages).toBeLessThan(16);
    const result = bounded(await tool.execute({ action: "read", maxBytes: 32_768, ...(cursor ? { cursor } : {}) }));
    expect(result.source).toMatchObject({ commit: w.approved.commit, revision: 1, role: "qa" });
    expect(result.coverage.startByte).toBe(Buffer.byteLength(combined));
    expect(result.coverage.endByte).toBe(Buffer.byteLength(combined) + Buffer.byteLength(result.text));
    expect(result.coverage.totalBytes).toBe(Buffer.byteLength(body!));
    expect(result.structure.startSection).toBe(sections.length);
    expect(result.structure.totalSections).toBe(expected.sections.length);
    expect(result.structure.remainingSections).toBe(expected.sections.length - result.structure.endSection);
    expect(result.structure.complete).toBe(result.structure.startSection === 0 && result.structure.endSection === expected.sections.length);
    expect(result.text.length + result.structure.sections.length).toBeGreaterThan(0);
    expect(result.coverage.entireProdCovered).toBe(false);
    expect(result.coverage.blocking).toEqual(["incomplete_prod_read", "global_constraints_and_unresolved_may_be_outside_page"]);
    expect(result.coverage.performance).toBe("unknown"); expect(result.coverage.verification).toBe("not_evaluated");
    combined += result.text; sections.push(...result.structure.sections);
    expect(result.structure.endSection).toBe(sections.length);
    cursor = result.coverage.nextCursor ?? undefined;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(combined).toBe(body); expect(sections).toEqual(expected.sections);
}, 20_000);

test("4字节text与256个最长ID首包也计整体预算，不丢结构续取信息", async () => {
  const w = await world(LONG_STRUCTURE_BODY); const tool = await w.tool();
  const result = bounded(await tool.execute({ action: "read", maxBytes: 4 }));
  expect(Buffer.byteLength(result.text)).toBe(4);
  expect(result.structure.totalSections).toBe(256);
  expect(result.structure.endSection).toBeGreaterThan(0);
  expect(result.structure.remainingSections).toBeGreaterThan(0);
  expect(result.coverage.nextCursor).toMatch(/^[a-f0-9]{64}$/);
  expect(result.coverage.entireProdCovered).toBe(false);
  expect(result.coverage.blocking).toContain("global_constraints_and_unresolved_may_be_outside_page");
});

test.each(["close", "update"] as const)("结构专用续页仍重验当前权限：%s", async (change) => {
  const w = await world(LONG_STRUCTURE_BODY); const tool = await w.tool();
  const first = bounded(await tool.execute({ action: "read", maxBytes: 32_768 }));
  expect(first.text).toBe(LONG_STRUCTURE_BODY);
  expect(first.structure.remainingSections).toBeGreaterThan(0);
  expect(first.coverage.nextCursor).not.toBeNull();
  if (change === "close") w.close(); else await w.save(w.created.requirementId, LONG_STRUCTURE_BODY + "更新\n");
  const probe = vi.spyOn(storage, "readVersion");
  await expect(tool.execute({ action: "read", maxBytes: 32_768, cursor: first.coverage.nextCursor })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
});

test("大转义diff按整包预算续读，来源仍是准确批准提交对", async () => {
  const w = await world(); const tool = await w.tool();
  const approved = await w.save(w.created.requirementId, '"\\\u0001'.repeat(10_000));
  const probe = vi.spyOn(RequirementService.prototype, "diff");
  let cursor: string | undefined, combined = "", pages = 0;
  do {
    expect(++pages).toBeLessThan(16);
    const result = await tool.execute({ action: "diff", maxBytes: 32_768, ...(cursor ? { cursor } : {}) });
    const page = bounded(result);
    expect(result).toMatchObject({ difference: { fromCommit: w.approved.commit, toCommit: approved.commit, fromRevision: 1, toRevision: 2 } });
    expect(page.coverage.startByte).toBe(Buffer.byteLength(combined));
    expect(page.coverage.endByte).toBeGreaterThan(page.coverage.startByte);
    expect(page.coverage.entireProdCovered).toBe(false);
    expect(page.coverage.blocking).toContain("global_constraints_and_unresolved_may_be_outside_page");
    combined += page.text; cursor = page.coverage.nextCursor ?? undefined;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(combined).toBe((await probe.mock.results[0]!.value).diff);
}, 20_000);

test("整包固定信息超预算时只给安全错误，不把巨额正文藏进错误", async () => {
  const w = await world(); const tool = await w.tool();
  const original = RequirementService.prototype.read;
  vi.spyOn(RequirementService.prototype, "read").mockImplementationOnce(async function (input) {
    const result = await original.call(this, input);
    return { ...result, title: "秘密".repeat(49_152) };
  });
  await expect(tool.execute({ action: "read" })).rejects.toThrow(/^requirement_read_denied$/);
});

test("PM/planner/reviewer/QA绑定真实SQLite与独立worktree，只读当前批准版本且来源无私有路径", async () => {
  const w = await world();
  await w.save(w.created.requirementId, "绝不能泄漏的当前草稿", false);
  for (const role of ["pm", "planner", "reviewer", "qa"] as const) {
    const tool = await w.tool(w.binding(role));
    const result = content(await tool.execute({ action: "read" }));
    expect(result.text).toBe(BODY);
    expect(result.source).toMatchObject({ commit: w.approved.commit, revision: 1, role });
    expect(result.coverage.entireProdCovered).toBe(true);
    expect(JSON.stringify(result)).not.toContain(w.dataRoot);
    expect(JSON.stringify(result)).not.toContain(w.worktree.root);
    expect(JSON.stringify(result)).not.toContain("绝不能泄漏");
  }
});

test("分页有界、中文emoji无损；最后局部页仍保守阻塞整体覆盖，section不丢全局未决警告", async () => {
  const w = await world(); const tool = await w.tool(w.binding("qa"));
  let cursor: string | undefined, combined = "";
  do {
    const result = content(await tool.execute({ action: "read", maxBytes: 31, ...(cursor ? { cursor } : {}) }));
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(31);
    expect(result.text).not.toContain("�");
    expect(result.coverage.entireProdCovered).toBe(false);
    expect(result.coverage.blocking).toContain("global_constraints_and_unresolved_may_be_outside_page");
    combined += result.text; cursor = result.coverage.nextCursor ?? undefined;
  } while (cursor);
  expect(combined).toBe(BODY);
  const section = content(await tool.execute({ action: "read", sectionId: "scenario.jump" }));
  expect(section.text).toContain("前置"); expect(section.text).not.toContain("高度");
  expect(section.coverage.blocking).toContain("incomplete_prod_read");
}, 60_000);

test("伪角色/身份/path/ref/checkRound参数及worker工厂拒绝，正文探针为零", async () => {
  const w = await world(); const tool = await w.tool();
  const probe = vi.spyOn(storage, "readVersion");
  for (const extra of [{ role: "main" }, { actor: "user" }, { requirementId: uuidv7() }, { source: "saved" },
    { path: "prod.md" }, { ref: "HEAD" }, { checkRoundId: uuidv7() }, { toRevision: 1 }]) {
    await expect(tool.execute({ action: "read", ...extra })).rejects.toMatchObject(denied);
  }
  await expect(w.tool({ ...w.binding(), role: "worker" } as never)).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
});

test("draft、其他需求、伪宿主身份、过期epoch/fence/run/workspace拒绝前不读正文", async () => {
  const w = await world();
  const draft = await w.create("draft不读"); await w.bind(draft.requirementId);
  const probe = vi.spyOn(storage, "readVersion");
  const draftWorkspace = w.state.read(draft.requirementId).data.workspace!;
  const draftTool = await w.tool({ ...w.binding(), requirementId: draft.requirementId, workspaceId: draftWorkspace.workspaceId,
    branch: draftWorkspace.branch, lease: { ...w.lease, requirementId: draft.requirementId, workspaceId: draftWorkspace.workspaceId } });
  await expect(draftTool.execute({ action: "read" })).rejects.toMatchObject(denied);
  await expect(draftTool.execute({ action: "metadata" })).rejects.toMatchObject(denied);
  for (const change of [{ lease: { ...w.lease, fence: w.lease.fence + 1 } },
    { lease: { ...w.lease, epoch: w.lease.epoch + 1 } },
    { lease: { ...w.lease, expiresAt: 0 } }, { workspaceId: "f".repeat(64) },
    { branch: "refs/heads/not-bound" },
    { requirementId: draft.requirementId, lease: { ...w.lease, requirementId: draft.requirementId } }]) {
    try { const tool = await w.tool({ ...w.binding(), ...change }); await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied); }
    catch (error) { expect(error).toMatchObject(denied); }
  }
  const bound = w.binding(); const tool = await w.tool(bound);
  w.sessions.set(bound.callerId, JSON.stringify({ ...bound, runId: uuidv7() }));
  await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
});

test("游标不能篡改/跨角色工厂/页范围/需求复用，dispose废止能力", async () => {
  const w = await world(); const tool = await w.tool(); const other = await w.tool(w.binding("qa"));
  const first = content(await tool.execute({ action: "read", maxBytes: 32 }));
  const cursor = first.coverage.nextCursor!;
  const probe = vi.spyOn(storage, "readVersion");
  await expect(other.execute({ action: "read", maxBytes: 32, cursor })).rejects.toMatchObject(denied);
  await expect(tool.execute({ action: "read", maxBytes: 32, cursor: "a".repeat(64) })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
  const next = content(await tool.execute({ action: "read", maxBytes: 32 }));
  probe.mockClear();
  await expect(tool.execute({ action: "read", maxBytes: 33, cursor: next.coverage.nextCursor })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
  tool.dispose(); await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied);
});

test("批准diff使用绑定旧批准到当前批准，不用HEAD或中间草稿，模型不能指定from/to", async () => {
  const w = await world(); const tool = await w.tool();
  await w.save(w.created.requirementId, "草稿中间态", false);
  const second = await w.save(w.created.requirementId, BODY + "新增批准目标\n");
  await w.save(w.created.requirementId, "HEAD未批准秘密", false);
  const result = await tool.execute({ action: "diff" });
  expect(result).toMatchObject({ kind: "diff", difference: { fromCommit: w.approved.commit, toCommit: second.commit, fromRevision: 1, toRevision: 2 } });
  expect(content(result).text).toContain("+新增批准目标");
  expect(content(result).text).not.toMatch(/草稿中间态|HEAD未批准秘密/);
  await expect(tool.execute({ action: "diff", fromRevision: 1, toRevision: 1 })).rejects.toMatchObject(denied);
});

test("closing/closed不提供正文/diff或旧页，只返回固定最少metadata，拒绝前不读正文", async () => {
  const w = await world(); const tool = await w.tool();
  const cursor = content(await tool.execute({ action: "read", maxBytes: 32 })).coverage.nextCursor;
  w.close(); const probe = vi.spyOn(storage, "readVersion"); const diffProbe = vi.spyOn(storage, "diffVersions");
  for (const input of [{ action: "read" }, { action: "read", maxBytes: 32, cursor }, { action: "diff" }]) {
    await expect(tool.execute(input)).rejects.toMatchObject(denied);
  }
  expect(await tool.execute({ action: "metadata" })).toEqual({ kind: "metadata", requirementId: w.created.requirementId, lifecycle: "closing" });
  const current = w.state.read(w.created.requirementId);
  w.state.finishClose({ requirementId: w.created.requirementId, version: current.version, operationId: current.data.close!.operationId });
  expect(await tool.execute({ action: "metadata" })).toEqual({ kind: "metadata", requirementId: w.created.requirementId, lifecycle: "closed" });
  expect(probe).not.toHaveBeenCalled(); expect(diffProbe).not.toHaveBeenCalled();
});

test("service读取后关闭/宿主返回前撤权都拒绝，不回显下层受限错误", async () => {
  const w = await world(); const tool = await w.tool();
  const original = RequirementService.prototype.read;
  vi.spyOn(RequirementService.prototype, "read").mockImplementationOnce(async function (input) {
    const result = await original.call(this, input); w.close(); return result;
  });
  await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied);
  vi.restoreAllMocks();
  const second = await world(); const bound = second.binding(); let readFinished = false;
  const next = await second.tool(bound, (request) => second.host(request) && !readFinished);
  vi.spyOn(RequirementService.prototype, "read").mockImplementationOnce(async function (input) {
    const result = await original.call(this, input); readFinished = true; return result;
  });
  await expect(next.execute({ action: "read" })).rejects.toMatchObject(denied);
  vi.restoreAllMocks();
  const third = await world(); const failing = await third.tool();
  vi.spyOn(RequirementService.prototype, "read").mockRejectedValueOnce(new Error("秘密受限正文 /private/dataRoot/prod.md"));
  await expect(failing.execute({ action: "read" })).rejects.toThrow(/^requirement_read_denied$/);
});

test("批准版本变化立即拒绝旧页；真实worktree分支变化拒绝", async () => {
  const w = await world(); const tool = await w.tool();
  const cursor = content(await tool.execute({ action: "read", maxBytes: 32 })).coverage.nextCursor;
  await w.save(w.created.requirementId, BODY + "追加\n");
  const probe = vi.spyOn(storage, "readVersion");
  await expect(tool.execute({ action: "read", maxBytes: 32, cursor })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
  await exec(HOST_GIT, ["checkout", "-b", "changed-binding"], { cwd: w.worktree.root, env: GIT_ENV });
  await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied);
  expect(probe).not.toHaveBeenCalled();
});

test("无稳定ID可完整读取但明确structure unavailable；旧PM fence不能借新owner继续", async () => {
  const w = await world(); const tool = await w.tool(w.binding("qa"));
  await w.save(w.created.requirementId, "# 自然标题\n中文😀且无稳定ID");
  expect(await tool.execute({ action: "read" })).toMatchObject({ text: "# 自然标题\n中文😀且无稳定ID", structure: { status: "section_structure_unavailable" } });
  await expect(tool.execute({ action: "read", sectionId: "guessed" })).rejects.toMatchObject(denied);
  w.state.releasePm(w.lease);
  await w.state.acquirePm({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version,
    runId: uuidv7(), expectedFence: w.lease.fence + 1 });
  const probe = vi.spyOn(storage, "readVersion");
  await expect(tool.execute({ action: "read" })).rejects.toMatchObject(denied); expect(probe).not.toHaveBeenCalled();
});
