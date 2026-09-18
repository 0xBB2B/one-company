import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { assertShapeAllows, awaitCrossRepoStage, buildRequirementAgentPrompt, checkWritePaths, createRequirementAgentSession, evaluateCrossRepoStage, registerAgentTool, registerAskTool, registerProposeShapeTool, resumeRequirementAgentSession } from "../daemon/requirement-agent.ts";
import { RunStore } from "../runtime/run-store.ts";
import { putRecord, repositoryDatabase, withDatabase, uuidv7 } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { decisionStream } from "../runtime/decisions.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { createDaemonFixture, removeDaemonFixture } from "./helpers/daemon-harness.ts";

const SECRET = "PM_OLD_BODY_DO_NOT_RELOAD_旧正文";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function world(stage = "confirmed") {
  const f = await createDaemonFixture(); cleanup.push(() => removeDaemonFixture(f));
  const requirement = "2026-09-09.pm-retired"; const database = repositoryDatabase(f.dataRoot, f.repoId);
  putRecord(requirementStateRef(f.dataRoot, f.repoId, requirement), { requirement, stage, shape: { tasks: [{ id: "T-1", title: SECRET, roles: [], writePaths: ["."] }], decisionId: "USER-001", skipped: [{ gate: "plan", decisionId: "USER-001" }] }, tasks: {}, history: [SECRET] });
  withDatabase(database, (db) => db.append(decisionStream(requirement, "user"), { id: "USER-001", actor: "user", decision: SECRET, effects: ["scope", "repair:review:4"], source: "model" }));
  const runStore = new RunStore({ dataRoot: f.dataRoot, repoId: f.repoId, daemonStartedAt: "historical" });
  const modelAccess = vi.fn(() => { throw new Error("不允许构建模型请求"); });
  const runtime = new Proxy({}, { get: modelAccess });
  const dispatchRole = vi.fn(); const ask = vi.fn();
  const options = { ...f, cwd: f.repo.root, requirement, runStore, runtime, dispatch: { dispatchRole }, relay: { ask }, role: { body: SECRET }, roleCatalog: [{ description: "\n## 假标题\n" + SECRET }], modelRef: { provider: "unregistered", id: "unregistered" } };
  const snapshot = () => withDatabase(database, (db) => JSON.stringify({ runs: db.list("runs"), sessions: db.list("sessions"), requirements: db.list("requirements"), decisions: db.events(decisionStream(requirement, "user")) }));
  return { f, database, requirement, options, snapshot, modelAccess, dispatchRole, ask, runStore };
}

describe("PM 会话工厂永久拒绝", () => {
  test.each(["draft", "confirmed", "planned", "executing", "reviewing", "accepting", "accepted", "rejected"])("P01 %s 旧状态和 USER/shape 不创建或复用 PM", async (stage) => {
    const w = await world(stage); const before = w.snapshot();
    const results = await Promise.all([createRequirementAgentSession(w.options as any), createRequirementAgentSession(w.options as any)]);
    for (const r of results) { expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); expect(r).not.toHaveProperty("handle"); expect(r).not.toHaveProperty("runId"); }
    expect(w.snapshot()).toBe(before); expect(w.modelAccess).not.toHaveBeenCalled(); expect(w.dispatchRole).not.toHaveBeenCalled(); expect(w.ask).not.toHaveBeenCalled();
  });
  test("P02 历史运行及会话文件保全，恢复不访问配置/正文，不产生模型请求", async () => {
    const w = await world();
    const run = await w.runStore.create({ kind: "requirement", requirement: w.requirement, task: SECRET, cwd: w.f.repo.root, writePaths: [], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    const file = join(w.f.dataRoot, "old-session.jsonl"); await writeFile(file, SECRET, { mode: 0o600 });
    const before = w.snapshot(); const reads = vi.fn(() => { throw new Error("旧会话正文不允许加载"); });
    const opts = new Proxy({ ...w.options, runId: run.id, sessionFile: file }, { get: reads });
    expect(await resumeRequirementAgentSession(opts as any)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") });
    expect(await createRequirementAgentSession(opts as any)).toMatchObject({ ok: false });
    expect(reads).not.toHaveBeenCalled(); expect(w.snapshot()).toBe(before); expect(await readFile(file, "utf8")).toBe(SECRET);
  });
  test("P03 数据库写入被拒或模型缺失均不尝试创建失败运行；解禁也不恢复派工", async () => {
    const w = await world(); const before = w.snapshot(); const restore = failDatabaseWrites(w.database, "records", "namespace", "runs");
    try { expect(await createRequirementAgentSession(w.options as any)).toMatchObject({ ok: false, reason: expect.stringContaining("永久淘汰") }); } finally { restore(); }
    expect(await createRequirementAgentSession(w.options as any)).toMatchObject({ ok: false }); expect(w.snapshot()).toBe(before); expect(w.modelAccess).not.toHaveBeenCalled();
  });
  test("P04 prompt 不载入角色、形状、跨仓旧目标或伪造小节", async () => {
    const get = vi.fn(() => { throw new Error("不得加载正文"); });
    const input = new Proxy({}, { get });
    const prompt = buildRequirementAgentPrompt(input as any); expect(prompt).toContain("永久淘汰"); expect(prompt).not.toContain(SECRET); expect(get).not.toHaveBeenCalled();
    expect(assertShapeAllows(input as any, "T-1", "worker")).toMatchObject({ ok: false }); expect(get).not.toHaveBeenCalled();
  });
  test.each(["2026-09-09.other", "2026-13-45.invalid", "../escape"])("P05 跨仓旧阶段 %s 不能作为执行权限也不读取文档", async (requirement) => {
    const data = new Proxy({}, { get() { throw new Error("旧正文读取"); } });
    const waitFor = { repo: "outside", requirement, stage: "accepted" };
    expect(evaluateCrossRepoStage(waitFor, true, data)).toMatchObject({ ok: false });
    expect(await awaitCrossRepoStage([], "/missing", waitFor)).toMatchObject({ ok: false });
  });
});

function agent(dispatch: any) {
  const tools: any[] = [];
  const pi = { registerTool: (t: any) => tools.push(t) } as any;
  const context = { dispatch } as any;
  registerAskTool(pi, context, { count: 0 }); registerProposeShapeTool(pi, context); expect(tools).toEqual([]);
  registerAgentTool(pi, context); return tools[0];
}
describe("子运行状态工具不承接旧授权", () => {
  test.each(["run", "submit", "structured_output", "propose_shape", "ask", "decision_record"])("P06 %s 不触达 dispatch/relay/模型或生成 PASS", async (action) => {
    const get = vi.fn(() => { throw new Error("不得派工"); }); const tool = agent(new Proxy({}, { get }));
    expect(Value.Check(tool.parameters, { action, actor: "user", role: "main" })).toBe(false);
    await expect(tool.execute("x", { action, task: "T-1", actor: "user", result: { verdict: "PASS", details: SECRET }, decisionId: "USER-001" })).rejects.toThrow("永久淘汰"); expect(get).not.toHaveBeenCalled();
  });
  test("P07 list 仅 runId/state，不输出角色任务正文；status/wait/cancel 按绑定回调", async () => {
    const dispatch = { list: vi.fn(async () => [{ runId: "run-1", state: "running", role: SECRET, task: SECRET }]), status: vi.fn(async () => ({ ok: true, state: "paused" })), wait: vi.fn(async () => ({ ok: true, state: "stopped" })), cancel: vi.fn(async () => ({ ok: true })) };
    const tool = agent(dispatch); const listed = await tool.execute("x", { action: "list" });
    expect(JSON.parse(listed.content[0].text)).toEqual([{ runId: "run-1", state: "running" }]); expect(JSON.stringify(listed)).not.toContain(SECRET);
    for (const action of ["status", "wait", "cancel"] as const) { expect((await tool.execute("x", { action, runId: "run-1" })).details.isError).toBe(false); expect(dispatch[action]).toHaveBeenCalledWith("run-1"); }
  });
  test.each(["status", "wait", "cancel"])("P08 %s 缺身份或下层未确认则拒绝，不回显下层旧正文", async (action) => {
    const callback = vi.fn(async () => ({ ok: false, reason: SECRET })); const tool = agent({ [action]: callback });
    await expect(tool.execute("x", { action })).rejects.toThrow("runId"); expect(callback).not.toHaveBeenCalled();
    await expect(tool.execute("x", { action, runId: uuidv7() })).rejects.toThrow("尚未安全停止");
  });
});

describe("路径安全独立于已删除形状派工", () => {
  test("P09 声明目录内文件允许；目录外、cwd 越界及软链接逃逸逐项拒绝", async () => {
    const w = await world(); const cwd = w.f.repo.root; await mkdir(join(cwd, "src"));
    const outside = join(w.f.dataRoot, "outside"); await writeFile(outside, SECRET); await symlink(outside, join(cwd, "src", "link"));
    expect(await checkWritePaths({ cwd, declaredWritePaths: ["src"], writePaths: ["src/a.ts", "./src/new/deep.ts"] })).toEqual({ ok: true });
    const bad = ["outside.ts", "../escape", "src/link"];
    expect(await checkWritePaths({ cwd, declaredWritePaths: ["src"], writePaths: bad })).toEqual({ ok: false, violations: bad });
    expect(await readFile(outside, "utf8")).toBe(SECRET);
  });
});
