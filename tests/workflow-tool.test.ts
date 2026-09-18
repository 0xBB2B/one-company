import { afterEach, describe, expect, test, vi } from "vitest";
import { Value } from "typebox/value";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { createRecord, readRecord, repositoryDatabase, withDatabase, uuidv7 } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { collectGitSnapshot, collectContentFingerprint } from "../runtime/git-snapshot.ts";
import { createWorkflowTool, currentVersion, executeWorkflowAction, retryOnStaleVersion } from "../runtime/workflow-tool.ts";
import workflowExtension from "../extensions/workflow.ts";

const exec = promisify(execFile);
const REQUIREMENT = "2026-09-09.workflow-tool-demo";
const SECRET = "合成旧目标，仅用于验证元数据过滤";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function world() {
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root };
  const database = repositoryDatabase(ctx.dataRoot, identity.repoId);
  const ref = requirementStateRef(ctx.dataRoot, identity.repoId, REQUIREMENT);
  const tool = createWorkflowTool(ctx);
  // 历史记录夹具不经过批准服务，不授予执行能力。
  const seed = (stage = "draft", key = REQUIREMENT) => createRecord({ ...ref, key }, {
    requirement: key, stage, shape: { decisionId: "USER-001", skipped: ["plan"], description: SECRET },
    tasks: { "T-1": { progress: "doing", runId: null, note: SECRET, workspaceDir: SECRET, blockedReason: SECRET }, [SECRET]: { progress: "todo" } },
    history: [SECRET], followUps: [SECRET],
  });
  const snapshot = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return JSON.stringify({ records: db.prepare("SELECT * FROM records ORDER BY id").all(), events: db.prepare("SELECT * FROM events ORDER BY id").all() }); }
    finally { db.close(); }
  };
  const call = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("test", params, signal, undefined, ctx);
  return { home, repo, identity, ctx, database, ref, seed, snapshot, call, tool };
}

const retiredActions = ["init", "update", "advance", "retreat", "reject", "task-start", "task-finish", "task-fail", "rollback", "shape-confirm", "resume-check", "migrate-preflight", "migrate-apply", "migrate-status"];
describe("公开旧动作永久拒绝", () => {
  test.each(retiredActions)("%s 不创建数据库，也不调用状态变更或交付回调", async (action) => {
    const w = await world(); const beforeTaskFinish = vi.fn(); const onStateChange = vi.fn();
    const tool = createWorkflowTool({ ...w.ctx, beforeTaskFinish, onStateChange });
    const params = { action, requirement: REQUIREMENT, version: 1, stage: "accepted", decisionId: "USER-001", runId: uuidv7() };
    expect(await executeWorkflowAction(params, w.ctx)).toMatchObject({ ok: false, details: { isError: true, code: "legacy_workflow_retired" } });
    await expect(tool.execute("test", params, undefined, undefined, w.ctx)).rejects.toThrow("永久淘汰");
    expect(beforeTaskFinish).not.toHaveBeenCalled(); expect(onStateChange).not.toHaveBeenCalled();
    expect(existsSync(w.database)).toBe(false);
  });
  test.each(retiredActions)("%s 即使已有USER、shape、PASS也不改变历史数据库", async (action) => {
    const w = await world(); w.seed("accepting"); const runId = uuidv7();
    withDatabase(w.database, (db) => {
      db.append(`decisions:${REQUIREMENT}:user`, { id: "USER-001", actor: "user", decision: SECRET });
      db.create("runs", runId, { requirement: REQUIREMENT, state: "completed", result: { phase: "acceptance", verdict: "PASS" } });
    });
    const before = w.snapshot();
    await expect(w.call({ action, requirement: REQUIREMENT, task: "T-1", version: 1, decisionId: "USER-001", runId, stage: "accepted" })).rejects.toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test.each([
    { update: { note: "备注A" } }, { update: { note: "备注A", bogusField: "x" } },
    { update: { note: "备注A", stage: "accepted" } }, { update: { followUpIssues: ["A"] } },
    { update: { blockedReason: "A", workspaceDir: "/workspace/T-1" } }, {}, { task: "T-1", version: 0 },
  ])("update任意字段组合均拒绝且版本不变：%j", async (patch) => {
    const w = await world(); w.seed(); const before = w.snapshot();
    await expect(w.call({ action: "update", requirement: REQUIREMENT, ...patch })).rejects.toThrow("永久淘汰");
    expect(w.snapshot()).toBe(before);
  });
  test("旧retryOnStaleVersion不执行builder，不重试或写入", async () => {
    const w = await world(); w.seed(); const before = w.snapshot(); const builder = vi.fn();
    expect(await retryOnStaleVersion(w.ctx, REQUIREMENT, builder)).toMatchObject({ ok: false, details: { code: "legacy_workflow_retired" } });
    expect(builder).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before);
  });
});

describe("pi_company_workflow 参数 schema", () => {
  const schema = createWorkflowTool({ dataRoot: "/missing" }).parameters;
  test("工具名和additionalProperties不变", () => {
    expect(createWorkflowTool({ dataRoot: "/missing" }).name).toBe("pi_company_workflow");
    expect(schema.additionalProperties).toBe(false);
  });
  test.each([{ action: "query", requirement: REQUIREMENT }, { action: "list" }, { action: "query", fields: ["stage"] }])("白名单查询参数通过：%j", (params) => { expect(Value.Check(schema, params)).toBe(true); });
  test.each([
    { bogusField: "x" }, { action: "unknown-action" }, { task: "bad-task" }, { task: "T-1" },
    { decisionId: "BAD-1" }, { version: 0 }, { version: 1 }, { update: { bogusField: "x" } },
    { evidence: { verdict: "PASS" } }, { shape: { tasks: [] } }, { fields: ["history"] }, { fields: ["shape"] }, { fields: ["followUps"] },
  ])("额外字段或旧动作拒绝：%j", (patch) => { expect(Value.Check(schema, { action: "query", requirement: REQUIREMENT, ...patch })).toBe(false); });
});

describe("只读元数据和身份隔离", () => {
  test("主窗口绑定后真实分支或同库worktree改变均拒绝", async () => {
    const w = await world(); w.seed(); await w.call({ action: "list" }); const before = w.snapshot();
    const other = await addWorktree(w.repo);
    await expect(w.tool.execute("test", { action: "list" }, undefined, undefined, { cwd: other.root })).rejects.toThrow("只能查询可信当前仓库及工作区");
    await exec("git", ["checkout", "-b", "external-switch"], { cwd: w.repo.root });
    await expect(w.call({ action: "list" })).rejects.toThrow("只能查询可信当前仓库及工作区"); expect(w.snapshot()).toBe(before);
  });
  test("缺库query/list拒绝且不创建主库或目录，现存空库list返回空覆盖", async () => {
    const w = await world(); const repoDir = join(w.home.dataRoot, "repos", w.identity.repoId);
    for (const action of ["query", "list"]) expect(await executeWorkflowAction({ action, ...(action === "query" ? { requirement: REQUIREMENT } : {}) }, w.ctx)).toMatchObject({ ok: false, details: { code: "legacy_metadata_unavailable" } });
    expect(existsSync(w.database)).toBe(false); expect(existsSync(repoDir)).toBe(false);
    withDatabase(w.database, () => {}); const before = w.snapshot(); const inode = (await stat(w.database)).ino;
    expect((await w.call({ action: "list" })).details).toMatchObject({ items: [], coverage: { total: 0, returned: 0, unknown: 0, remaining: 0, truncated: false } });
    expect(await executeWorkflowAction({ action: "query", requirement: REQUIREMENT }, w.ctx)).toMatchObject({ ok: false, details: { code: "legacy_metadata_unavailable" } });
    expect(w.snapshot()).toBe(before); expect((await stat(w.database)).ino).toBe(inode);
  });
  test("权限不安全的现存库拒绝且不chmod或回显底层数据", async () => {
    const w = await world(); w.seed(); const before = w.snapshot(); await chmod(w.database, 0o644);
    try {
      const result = await executeWorkflowAction({ action: "list" }, w.ctx);
      expect(result).toMatchObject({ ok: false, details: { code: "legacy_metadata_unavailable" } });
      expect(JSON.stringify(result)).not.toContain(SECRET); expect(JSON.stringify(result)).not.toContain(w.database);
      expect((await stat(w.database)).mode & 0o777).toBe(0o644);
    } finally { await chmod(w.database, 0o600); }
    expect(w.snapshot()).toBe(before);
  });
  test("list分页覆盖保留未知阻塞与精确后续位置，不回显坏key", async () => {
    const w = await world(); for (let i = 0; i < 6; i++) w.seed("draft", `2026-09-09.page-${i}`);
    createRecord({ ...w.ref, key: SECRET }, { stage: "accepted" }); const before = w.snapshot();
    const first = await w.call({ action: "list", limit: 2 }); const second = await w.call({ action: "list", limit: 2, offset: 2 });
    expect(first.details.coverage).toMatchObject({ total: 7, validated: 6, returned: 2, remaining: 4, unknown: 1, nextOffset: 2, truncated: true });
    expect(second.details.coverage).toMatchObject({ total: 7, returned: 2, offset: 2, remaining: 2, nextOffset: 4, unknown: 1 });
    expect(first.details.items).not.toEqual(second.details.items); expect(JSON.stringify([first, second])).not.toContain(SECRET); expect(w.snapshot()).toBe(before);
  });
  test("合法task/run正向绑定，错绑和非法任务仅计unknown，字段过滤不隐去未确认覆盖", async () => {
    const w = await world(); const runId = uuidv7(), foreignId = uuidv7();
    withDatabase(w.database, (db) => {
      db.create("runs", runId, { id: runId, requirement: REQUIREMENT, task: "T-1" });
      db.create("runs", foreignId, { id: foreignId, requirement: "2026-09-09.other", task: "T-2" });
      db.create("requirements", REQUIREMENT, { requirement: REQUIREMENT, stage: "executing", shape: null, history: [], followUps: [], tasks: {
        "T-1": { progress: "doing", runId }, "T-2": { progress: "doing", runId: foreignId },
        "T-3": { progress: "todo", runId: null }, "T-4": { progress: "paused", runId: null },
        "T-10000000000": { progress: "todo", runId: null }, [SECRET]: { progress: "todo", runId: null },
      } });
    });
    const before = w.snapshot(); const first = await w.call({ action: "query", requirement: REQUIREMENT, limit: 1 });
    expect(first.details.data).toMatchObject({ tasks: { "T-1": { progress: "doing", runId } } });
    expect(first.details.coverage).toMatchObject({ total: 6, validated: 2, returned: 1, remaining: 1, unknown: 4, unconfirmed: 6, unconfirmedOutsidePage: 5, nextOffset: 1 });
    const second = await w.call({ action: "query", requirement: REQUIREMENT, limit: 1, offset: 1 });
    expect(second.details.data).toMatchObject({ tasks: { "T-3": { progress: "todo", runId: null } } });
    expect(second.details.coverage).toMatchObject({ returned: 1, remaining: 0, unknown: 4, nextOffset: null });
    const filtered = await w.call({ action: "query", requirement: REQUIREMENT, fields: ["stage"] });
    expect(filtered.details.data).toEqual({ stage: "executing" });
    expect(filtered.details.coverage).toMatchObject({ total: 6, returned: 0, remaining: 2, unconfirmedOutsidePage: 6, unknown: 4, truncated: true });
    expect(JSON.stringify([first, second, filtered])).not.toContain(SECRET); expect(w.snapshot()).toBe(before);
  });
  test("字节预算截断仍报告总数和页外未确认，不隐藏待核对记录", async () => {
    const w = await world(); w.seed();
    withDatabase(w.database, (db) => { const r = db.read<{ tasks: Record<string, unknown> }>("requirements", REQUIREMENT)!;
      db.update("requirements", REQUIREMENT, r.version, { ...r.data, tasks: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`T-${i}`, { progress: "todo", runId: null }])) }); });
    const result = await w.call({ action: "query", requirement: REQUIREMENT, byteLimit: 2048, limit: 100 });
    const coverage = result.details.coverage as { returned: number; remaining: number; unconfirmedOutsidePage: number; nextOffset: number };
    expect(coverage.returned).toBeGreaterThan(0); expect(coverage.returned).toBeLessThan(100);
    expect(coverage.remaining).toBe(100 - coverage.returned); expect(coverage.unconfirmedOutsidePage).toBe(100 - coverage.returned); expect(coverage.nextOffset).toBe(coverage.returned);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(2048);
  });
  test.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { byteLimit: 2047 }, { byteLimit: 16385 }])("非法分页参数不执行查询：%j", async (page) => {
    const w = await world(); w.seed(); const before = w.snapshot();
    expect(Value.Check(w.tool.parameters, { action: "list", ...page })).toBe(false);
    expect(await executeWorkflowAction({ action: "list", ...page }, w.ctx)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before);
  });
  test("错误记录身份安全拒绝，list只计unknown且原字节不变", async () => {
    const w = await world(); w.seed();
    const db = new DatabaseSync(w.database);
    try { db.prepare("UPDATE records SET data = ? WHERE namespace = 'requirements'").run(JSON.stringify({ requirement: SECRET, stage: "draft", tasks: {}, shape: null, history: [], followUps: [] })); } finally { db.close(); }
    const before = w.snapshot();
    const result = await executeWorkflowAction({ action: "query", requirement: REQUIREMENT }, w.ctx);
    expect(result).toMatchObject({ ok: false, details: { code: "legacy_metadata_unavailable" } });
    const list = await w.call({ action: "list" }); expect(list.details).toMatchObject({ items: [], coverage: { total: 1, unknown: 1, truncated: true } });
    expect(JSON.stringify([result, list])).not.toContain(SECRET); expect(w.snapshot()).toBe(before);
  });
  test("query历史draft返回stage和version，原记录不变", async () => {
    const w = await world(); w.seed(); const before = w.snapshot();
    const result = await w.call({ action: "query", requirement: REQUIREMENT });
    expect(result.details).toMatchObject({ isError: false, version: 1, data: { requirement: REQUIREMENT, stage: "draft" } });
    expect(JSON.stringify(result)).not.toContain(SECRET); expect(w.snapshot()).toBe(before);
  });
  test('query 指定 fields:["stage"] 时只返回阶段字段', async () => {
    const w = await world(); w.seed();
    expect((await w.call({ action: "query", requirement: REQUIREMENT, fields: ["stage"] })).details.data).toEqual({ stage: "draft" });
  });
  test("list保留各历史阶段元数据并排除新UUID，不把accepted当当前完成", async () => {
    const w = await world(); w.seed(); w.seed("executing", "2026-09-09.executing"); w.seed("accepted", "2026-09-09.accepted");
    const id = uuidv7(); createRecord({ ...w.ref, key: id }, { lifecycle: "active" });
    const before = w.snapshot(); const result = await w.call({ action: "list" });
    expect(result.details.items).toEqual(expect.arrayContaining([
      { requirement: REQUIREMENT, stage: "draft" }, { requirement: "2026-09-09.executing", stage: "executing" }, { requirement: "2026-09-09.accepted", stage: "accepted" },
    ]));
    expect(JSON.stringify(result)).not.toContain(id); expect(JSON.stringify(result)).not.toContain(SECRET); expect(w.snapshot()).toBe(before);
  });
  test("params.cwd不能切换仓库，另一可信工具仅查询本仓库元数据", async () => {
    const w = await world(); w.seed(); const other = await createRepoFixture(); cleanup.push(() => removeRepoFixture(other));
    const identity = await repositoryIdentity(other.root);
    createRecord(requirementStateRef(w.ctx.dataRoot, identity.repoId, "2026-09-09.other"), { requirement: "2026-09-09.other", stage: "draft", shape: null, tasks: {}, history: [], followUps: [] });
    const before = w.snapshot();
    await expect(w.call({ action: "list", cwd: other.root })).rejects.toThrow("只能查询可信当前仓库及工作区");
    expect(await executeWorkflowAction({ action: "list", cwd: other.root }, w.ctx)).toMatchObject({ ok: false, details: { code: "legacy_metadata_unavailable" } });
    const ctx = { ...w.ctx, cwd: other.root };
    const result = await createWorkflowTool(ctx).execute("test", { action: "list" }, undefined, undefined, ctx);
    expect(result.details.items).toEqual([{ requirement: "2026-09-09.other", stage: "draft" }]); expect(w.snapshot()).toBe(before);
  });
  test("绑定工具拒绝跨需求、跨仓库和list，允许绑定需求查询", async () => {
    const w = await world(); w.seed(); const before = w.snapshot();
    const tool = createWorkflowTool({ ...w.ctx, boundRequirement: REQUIREMENT });
    for (const params of [{ action: "list" }, { action: "query", requirement: "2026-09-09.other" }]) {
      await expect(tool.execute("test", params, undefined, undefined, w.ctx)).rejects.toThrow("只能查询绑定");
    }
    await expect(tool.execute("test", { action: "query", cwd: w.home.home }, undefined, undefined, w.ctx)).rejects.toThrow("只能查询可信当前仓库及工作区");
    expect((await tool.execute("test", { action: "query" }, undefined, undefined, w.ctx)).details.version).toBe(1);
    expect(w.snapshot()).toBe(before);
  });
  test.each(["bad name", "../../../../etc", "../../README.md", "legacy", "2026-02-30.invalid", "2026-09-09." + "a".repeat(118), "0197b7b0-6a20-7c51-8a32-b9465fb72d10"])("非法requirement不泄漏路径：%s", async (requirement) => {
    const w = await world();
    for (const action of ["query", "advance", "resume-check"]) {
      const result = await executeWorkflowAction({ action, requirement }, w.ctx);
      expect(result.ok).toBe(false); expect(result.text).not.toContain(w.repo.root); expect(result.text).not.toContain(requirement);
    }
    expect(existsSync(w.database)).toBe(false);
  });
  test("list不存在cwd的错误不泄漏绝对路径", async () => {
    const w = await world(); const cwd = join(w.repo.root, "missing");
    const result = await executeWorkflowAction({ action: "list", cwd }, w.ctx);
    expect(result.ok).toBe(false); expect(result.text).not.toContain(cwd);
  });
  test("query数据库不可打开时失败且原状态未改变", async () => {
    const w = await world(); w.seed(); const before = readRecord(w.ref);
    await rename(w.database, `${w.database}.saved`); await mkdir(w.database);
    try { await expect(w.call({ action: "query", requirement: REQUIREMENT })).rejects.toThrow("不可读"); }
    finally { await rm(w.database, { recursive: true }); await rename(`${w.database}.saved`, w.database); }
    expect(readRecord(w.ref)).toEqual(before);
  });
  test("已中止的AbortSignal抛出失败且不写入", async () => {
    const w = await world(); w.seed(); const before = w.snapshot();
    await expect(w.call({ action: "update", requirement: REQUIREMENT }, AbortSignal.abort())).rejects.toThrow("已中止");
    expect(w.snapshot()).toBe(before);
  });
  test("extensions/workflow.ts注册恰一次且工具名正确", () => {
    const registered: string[] = [];
    workflowExtension({ registerTool: (tool: { name: string }) => registered.push(tool.name), on() {} } as unknown as ExtensionAPI);
    expect(registered).toEqual(["pi_company_workflow"]);
  });
});

describe("旧定义入口拒绝与通用当前内容指纹", () => {
  test("currentVersion不读取旧定义，即使不存在、内容改变、改名或外链也拒绝", async () => {
    const w = await world(); const ctx = { ...w.ctx, requirement: REQUIREMENT };
    await expect(currentVersion(ctx)).rejects.toThrow("永久淘汰");
    const dir = join(w.repo.root, ".pi-company", "requirements", REQUIREMENT); await mkdir(dir, { recursive: true });
    const file = join(dir, "synthetic.md"); await writeFile(file, SECRET);
    await expect(currentVersion(ctx)).rejects.toThrow("永久淘汰");
    await writeFile(file, SECRET + "2"); await rename(file, join(dir, "renamed.md"));
    await symlink(join(w.home.home, "missing"), join(dir, "outside-link"));
    await expect(currentVersion(ctx)).rejects.toThrow("永久淘汰");
    expect(await readFile(join(dir, "renamed.md"), "utf8")).toBe(SECRET + "2"); expect(existsSync(w.database)).toBe(false);
  });
  test("通用指纹稳定，并检测同HEAD的代码、当前spec和暂存内容变化", async () => {
    const w = await world(); const collect = () => collectGitSnapshot({ repoRoot: w.repo.root });
    const first = await collect(); expect(await collect()).toEqual(first);
    await writeFile(join(w.repo.root, "README.md"), "改变代码现场"); const second = await collect();
    expect(second.head).toBe(first.head); expect(second.fingerprint).not.toBe(first.fingerprint);
    await mkdir(join(w.repo.root, "docs/spec"), { recursive: true }); await writeFile(join(w.repo.root, "docs/spec/rule.json"), "{}");
    const third = await collect(); expect(third.fingerprint).not.toBe(second.fingerprint);
    await exec("git", ["add", "README.md"], { cwd: w.repo.root }); expect((await collect()).fingerprint).not.toBe(third.fingerprint);
  });
  test("通用内容指纹对修改、改名、新增同目标链接敏感且不解引用外链", async () => {
    const w = await world(); const collect = () => collectContentFingerprint(w.repo.root);
    const target = join(w.repo.root, "source.txt"); await writeFile(target, "A"); const first = await collect();
    await writeFile(target, "B"); const second = await collect(); expect(second).not.toBe(first);
    await rename(target, join(w.repo.root, "renamed.txt")); const third = await collect(); expect(third).not.toBe(second);
    const outside = join(w.home.home, "outside.txt"); await writeFile(outside, "private-A");
    await symlink(outside, join(w.repo.root, "link1")); const fourth = await collect();
    await writeFile(outside, "private-B"); expect(await collect()).toBe(fourth);
    await symlink(outside, join(w.repo.root, "link2")); expect(await collect()).not.toBe(fourth);
  });
  test("通用指纹框定路径与内容，区分拼接碰撞和NUL布局", async () => {
    const w = await world(); const collect = () => collectContentFingerprint(w.repo.root);
    await writeFile(join(w.repo.root, "ab"), "c"); const a = await collect();
    await rm(join(w.repo.root, "ab")); await writeFile(join(w.repo.root, "a"), "bc"); expect(await collect()).not.toBe(a);
    await writeFile(join(w.repo.root, "a"), "b"); await writeFile(join(w.repo.root, "c"), "d"); const b = await collect();
    await rm(join(w.repo.root, "c")); await writeFile(join(w.repo.root, "a"), Buffer.from([0x62, 0x63, 0, 0x64])); expect(await collect()).not.toBe(b);
  });
});
