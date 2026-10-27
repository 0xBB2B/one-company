import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approvedPrototypeListLines, prototypeContext, requirementPrototypeLines } from "../src/modules/prototype/prototype-dispatch.ts";
import { RunManager, registerProtocolHandlers } from "../src/app/daemon/run-manager.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { validateParams } from "../src/app/daemon/method-params.ts";
import {
  beginDesign, decidePrototype, draftPrototypes, pendingConfirmation, promoteOnApprovalIn, prototypeFilePath, readPrototypeBoard, submitDesign,
} from "../src/modules/requirement/requirement-prototypes.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

function promote(ref: { dataRoot: string; repoId: string }, input: { requirementId: string; digest: string }) {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => promoteOnApprovalIn(db, input)));
}

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const HTML = "<!doctype html><html><body><h1>登录页草图</h1></body></html>";
const MAIN_MODEL = { provider: "team-model", id: "test" };
type Handler = (params: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>;

async function world(options: { index?: boolean; disabled?: Set<string> } = {}) {
  const root = await mkdtemp(join("/tmp", "pi-t-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const userDir = join(root, "agents");
  await mkdir(userDir, { recursive: true });
  const define = (file: string, header: string, body = "你是自定义设计师。") => writeFile(join(userDir, `${file}.md`), `---\n${header}\n---\n${body}\n`);
  await define("proto-b", "name: proto-b\ndescription: B 模型设计师\nrole: prototype\nmodel: team-model/gpt-6-luna\nthinking: high");
  await define("proto-bad-model", "name: proto-bad-model\ndescription: 模型不存在\nrole: prototype\nmodel: nowhere/none");
  await define("proto-broken", "name: proto-broken\ndescription: 坏定义\nrole: not-a-role");
  await define("ui-dev", "name: ui-dev\ndescription: 写界面代码\nrole: worker");

  const w = await createPmRunWorld(cleanups, { userDir, ...(options.index ? { index: true } : {}), ...(options.disabled ? { loadDisabledAgents: () => options.disabled! } : {}) });
  const repoRoot = await realpath(w.fixture.repositoryRoot);
  const insideFile = join(repoRoot, "design-notes.md");
  await writeFile(insideFile, "仓库内笔记：登录页需要手机号输入框。\n");
  const outsideFile = join(w.fixture.root, "OUTSIDE.md");
  await writeFile(outsideFile, "仓库外的机密内容\n");

  const handlers = new Map<string, Handler>();
  const server = { registerHandler: (method: string, handler: Handler) => handlers.set(method, handler), markHandlersReady: () => {},
    onHello: null as null | ((client: unknown) => unknown), onDisconnect: null as null | ((client: unknown) => unknown) };
  registerProtocolHandlers({ server: server as never, manager: w.manager, shellRegistry: {} as never });
  const client = (connectionId: string) => ({ connectionId, sessionId: "session-a", windowId: "win" });
  const connect = (connectionId: string) => server.onHello!(client(connectionId));
  const disconnect = (connectionId: string) => server.onDisconnect!(client(connectionId));
  const call = (method: string, params: Record<string, unknown>, connectionId = "connection-a") => handlers.get(method)!(params, client(connectionId));
  const dispatchParams = (patch: Record<string, unknown> = {}) => ({ requirementId: w.fixture.requirementId, name: "登录页", brief: "手机号加验证码登录界面",
    maxTurns: 12, model: MAIN_MODEL, thinking: "off", ...patch });
  const dispatch = (patch: Record<string, unknown> = {}, connectionId = "connection-a") =>
    call("prototypes.dispatch", dispatchParams(patch), connectionId) as Promise<{ runId: string; version: number }>;
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const board = () => readPrototypeBoard(ref, w.fixture.requirementId);
  const entry = async (name = "登录页") => (await board()).entries.find((item) => item.name === name);
  const events = (name: string) => w.emit.mock.calls.filter(([event]) => event === name).map(([, data]) => data as Record<string, unknown>);
  const requestsText = () => JSON.stringify(w.provider.requests);
  const started = () => until(() => w.provider.requests.some((request) => JSON.stringify(request).includes("手机号加验证码登录界面")));
  const slow = { type: "text" as const, text: "慢慢画", chunkDelayMs: 3_000 };
  const submit = (html: string) => ({ type: "toolcall" as const, name: "one_company_result_submit", input: { action: "prototype", html, note: "手机号输入框加验证码按钮" } });
  await connect("connection-a");
  await connect("connection-b");
  return { ...w, repoRoot, insideFile, outsideFile, userDir, call, dispatch, dispatchParams, disconnect, ref, board, entry, events, requestsText, slow, submit, started };
}

function badParams(params: unknown): { code?: string; message?: string } | null {
  try { validateParams("prototypes.dispatch", params); return null; } catch (error) { return error as { code?: string; message?: string }; }
}
const validParams = { requirementId: uuidv7(), name: "登录页", brief: "手机号加验证码登录界面", maxTurns: 12, model: MAIN_MODEL, thinking: "off" };

test("入口校验：缺名称、缺要求、名称或要求超长、轮数为 0 或 101、需求编号格式不对，都以 bad_params 拒绝并写明字段", () => {
  expect(badParams(validParams)).toBeNull();
  const { name: _name, ...noName } = validParams;
  const { brief: _brief, ...noBrief } = validParams;
  expect(badParams(noName)).toMatchObject({ code: "bad_params", message: expect.stringContaining("name") });
  expect(badParams(noBrief)).toMatchObject({ code: "bad_params", message: expect.stringContaining("brief") });
  expect(badParams({ ...validParams, name: "" })).toMatchObject({ code: "bad_params", message: expect.stringContaining("name") });
  expect(badParams({ ...validParams, brief: "长".repeat(4001) })).toMatchObject({ code: "bad_params", message: expect.stringContaining("brief") });
  expect(badParams({ ...validParams, brief: "长".repeat(4000) })).toBeNull();
  for (const maxTurns of [0, 101]) expect(badParams({ ...validParams, maxTurns })).toMatchObject({ code: "bad_params", message: expect.stringContaining("maxTurns") });
  expect(badParams({ ...validParams, requirementId: "req-1" })).toMatchObject({ code: "bad_params", message: expect.stringContaining("requirementId") });
  let board: { code?: string; message?: string } | null = null;
  try { validateParams("prototypes.board", { requirementId: "req-1" }); } catch (error) { board = error as { code?: string; message?: string }; }
  expect(board).toMatchObject({ code: "bad_params", message: expect.stringContaining("requirementId") });
});

test("需求不存在（编号格式合法）时派出被拒并写明原因，没有开出会话，看板无条目", async () => {
  const w = await world();
  const before = w.provider.requests.length;
  await expect(w.dispatch({ requirementId: uuidv7() })).rejects.toMatchObject({ message: expect.stringContaining("需求") });
  expect(w.provider.requests.length).toBe(before);
  expect((await w.board()).entries).toEqual([]);
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("用内置 prototype 派出时会话用主窗口传来的模型和思考等级", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId, version } = await w.dispatch({ thinking: "low" });
  expect(version).toBe(1);
  expect(runId).toEqual(expect.any(String));
  await w.started();
  const designer = w.provider.requests.findIndex((request) => JSON.stringify(request).includes("手机号加验证码登录界面"));
  expect(w.provider.models[designer]).toBe("test");
  expect(w.provider.reasoning[designer]).toBe("low");
  await w.call("runs.stop", { runId });
});

test("用写了 B 模型和思考等级的定义派出时会话用定义里的值", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch({ agent: "proto-b", thinking: "low" });
  await w.started();
  const designer = w.provider.requests.findIndex((request) => JSON.stringify(request).includes("手机号加验证码登录界面"));
  expect(w.provider.models[designer]).toBe("gpt-6-luna");
  expect(w.provider.reasoning[designer]).toBe("high");
  await w.call("runs.stop", { runId });
});

test("指定的定义不存在、不可用或是 worker 类时被拒并写明原因，没有开出会话也没有留下在途状态", async () => {
  const w = await world();
  const before = w.provider.requests.length;
  await expect(w.dispatch({ agent: "nobody" })).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringContaining("nobody") });
  await expect(w.dispatch({ agent: "proto-broken" })).rejects.toMatchObject({ code: "agent_unavailable" });
  await expect(w.dispatch({ agent: "proto-bad-model" })).rejects.toMatchObject({ code: "model_unavailable" });
  await expect(w.dispatch({ agent: "ui-dev" })).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringContaining("worker") });
  expect(w.provider.requests.length).toBe(before);
  expect((await w.entry())?.inFlight ?? null).toBeNull();
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("指定的原型定义在关闭名单里时被拒为 agent_disabled，没有开出会话也没有登记新的原型版本", async () => {
  const w = await world({ disabled: new Set(["x-designer"]) });
  await writeFile(join(w.userDir, "x-designer.md"), "---\nname: x-designer\ndescription: 原型\nrole: prototype\n---\n你是 x-designer。\n");
  const before = w.provider.requests.length;
  await expect(w.dispatch({ agent: "x-designer" })).rejects.toMatchObject({ code: "agent_disabled", message: expect.stringContaining("x-designer 已关闭"),
    advice: { next: expect.stringContaining("用通用 prototype") } });
  expect(w.provider.requests.length).toBe(before);
  expect((await w.board()).entries).toEqual([]);
});

test("轮数上限等于 maxTurns，用满后运行停止、看板在途清空、收到写明轮数用满的 finished 事件", async () => {
  const w = await world();
  const read = { type: "toolcall" as const, name: "read", input: { path: w.insideFile } };
  w.provider.queue.push(read, read, read, read);
  const { version } = await w.dispatch({ maxTurns: 2 });
  await until(() => w.events("prototype.finished").length === 1);
  expect(w.events("prototype.finished")[0]).toMatchObject({ parentSessionId: "session-a", requirementId: w.fixture.requirementId, name: "登录页", version,
    reason: expect.stringContaining("轮数用满") });
  const current = await w.entry();
  expect(current?.inFlight).toBeNull();
  expect(current?.lastEnded).toMatchObject({ version, reason: expect.stringContaining("轮数用满") });
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("设计师能读仓库里的文件，读仓库外的文件被拒", async () => {
  const w = await world();
  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: w.insideFile } },
    { type: "toolcall", name: "read", input: { path: w.outsideFile } }, w.slow);
  const { runId } = await w.dispatch();
  await w.started();
  const designer = w.provider.requests.findIndex((request) => JSON.stringify(request).includes("手机号加验证码登录界面"));
  await until(() => w.provider.requests.length >= designer + 3);
  const all = w.requestsText();
  expect(all).toContain("仓库内笔记：登录页需要手机号输入框");
  expect(all).not.toContain("仓库外的机密内容");
  await w.call("runs.stop", { runId });
});

test("任务说明写明需求标题、原型名称、第几版、要求和轮数上限", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch();
  await w.started();
  const all = w.requestsText();
  for (const expected of ["PM接手", "登录页", "第 1 版", "手机号加验证码登录界面", "12"]) expect(all).toContain(expected);
  await w.call("runs.stop", { runId });
});

test("提意见后重派时设计师能读上一版文件，任务说明带用户意见原话", async () => {
  const w = await world();
  const opinion = "按钮放大一点，主色换成深蓝";
  const first = uuidv7();
  const params = { requirementId: w.fixture.requirementId, name: "登录页" };
  await beginDesign(w.ref, { ...params, runId: first, agent: "prototype" });
  await submitDesign(w.ref, { ...params, runId: first, html: HTML, note: "第一版" });
  const pending = await pendingConfirmation(w.ref, params);
  await decidePrototype(w.ref, { ...params, version: pending.version, hash: pending.hash, choice: "opinion", note: null, opinion });
  const previousPath = prototypeFilePath(w.ref, { ...params, version: 1 });

  w.provider.queue.push({ type: "toolcall", name: "read", input: { path: previousPath } }, w.slow);
  const { runId, version } = await w.dispatch();
  expect(version).toBe(2);
  await until(() => w.requestsText().includes("登录页草图"));
  const all = w.requestsText();
  expect(all).toContain(opinion);
  expect(all).toContain(previousPath);
  expect(all).toContain("登录页草图");
  await w.call("runs.stop", { runId });
});

test("设计师交合格稿后看板变成 awaiting，收到 submitted 事件，运行不再列在面板里", async () => {
  const w = await world();
  w.provider.queue.push(w.submit(HTML), { type: "text", text: "已交稿" });
  const { version } = await w.dispatch();
  await until(() => w.events("prototype.submitted").length === 1);
  expect(w.events("prototype.submitted")[0]).toEqual({ parentSessionId: "session-a", requirementId: w.fixture.requirementId, name: "登录页", version });
  expect((await w.entry())?.inFlight).toMatchObject({ status: "awaiting", version, file: { note: "手机号输入框加验证码按钮" } });
  expect(w.events("prototype.changed").length).toBeGreaterThan(0);
  await until(async () => ((await w.call("prototypes.list", {})).items as unknown[]).length === 0);
  expect(w.events("prototype.finished")).toEqual([]);
});

test("设计师交不合格稿时收到原因，看板仍是 designing", async () => {
  const w = await world();
  w.provider.queue.push(w.submit("这不是 HTML 页面"), w.slow);
  const { runId } = await w.dispatch();
  await until(() => w.requestsText().includes("交稿内容不是 HTML 页面"));
  expect((await w.entry())?.inFlight).toMatchObject({ status: "designing", file: null });
  expect(w.events("prototype.submitted")).toEqual([]);
  await w.call("runs.stop", { runId });
});

test("面板只列本连接运行中的设计：名称、版本、定义名、轮数、上限、已用时间；派出与结束都发变化信号", async () => {
  const w = await world();
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch({ agent: "proto-b" });
  expect(w.events("prototype.changed").length).toBeGreaterThan(0);
  const { items } = await w.call("prototypes.list", {}) as { items: Array<Record<string, unknown>> };
  expect(items).toEqual([{ runId, requirementId: w.fixture.requirementId, name: "登录页", version: 1, agent: "proto-b", turns: expect.any(Number),
    maxTurns: 12, elapsedMs: expect.any(Number) }]);
  await expect(w.call("prototypes.list", {}, "connection-b")).resolves.toEqual({ items: [] });
  const changed = w.events("prototype.changed").length;
  await w.call("runs.stop", { runId });
  expect(w.events("prototype.changed").length).toBeGreaterThan(changed);
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("runs.steps 只认派出连接：派出连接查到运行中、轮数上限为派出时的值；停止后仍查到 stopped 和已记下的步骤", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch();
  await expect(w.call("runs.steps", { runId })).resolves.toMatchObject({ state: "running", maxTurns: 12, steps: [] });
  await expect(w.call("runs.steps", { runId }, "connection-b")).rejects.toMatchObject({ code: "not_found", message: "守护进程里没有这个子代理的步骤" });
  await w.call("runs.stop", { runId });
  await expect(w.call("runs.steps", { runId })).resolves.toMatchObject({ state: "stopped", maxTurns: 12, steps: [] });
});

test("runs.get 与 runs.stop 只认派出连接，暂停与续接被拒；停止后看板在途清空并收到 finished 事件", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId, version } = await w.dispatch();
  await expect(w.call("runs.get", { runId })).resolves.toMatchObject({ run: { id: runId, state: "running" } });
  await expect(w.call("runs.get", { runId }, "connection-b")).rejects.toMatchObject({ code: "not_found" });
  await expect(w.call("runs.stop", { runId }, "connection-b")).rejects.toMatchObject({ code: "not_found" });
  for (const method of ["runs.pause", "runs.resume"]) await expect(w.call(method, { runId })).rejects.toMatchObject({ code: "invalid_params" });
  await expect(w.call("runs.stop", { runId })).resolves.toMatchObject({ state: "stopped", confirmed: true });
  expect((await w.entry())?.inFlight).toBeNull();
  expect(w.events("prototype.finished")).toEqual([expect.objectContaining({ parentSessionId: "session-a", name: "登录页", version, reason: expect.any(String) })]);
  expect((await w.entry())?.lastEnded?.reason).toBe(w.events("prototype.finished")[0]!.reason);
});

test("连接断开后看板在途清空，记下的原因是主窗口断开，不再发事件", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  await w.dispatch();
  await w.disconnect("connection-a");
  await until(async () => (await w.entry())?.inFlight === null);
  expect((await w.entry())?.lastEnded?.reason).toContain("主窗口断开");
  expect(w.events("prototype.finished")).toEqual([]);
});

test("守护进程重启后所有 designing 状态的在途原型被清掉", async () => {
  const w = await world();
  await beginDesign(w.ref, { requirementId: w.fixture.requirementId, name: "登录页", runId: uuidv7(), agent: "prototype" });
  expect((await w.entry())?.inFlight).toMatchObject({ status: "designing" });
  const restarted = new RunManager((w.manager as unknown as { options: ConstructorParameters<typeof RunManager>[0] }).options);
  restarted.markStarted();
  await until(async () => (await w.entry())?.inFlight === null);
  expect((await w.entry())?.lastEnded?.reason).toContain("重启");
});

test("prototypes.board 返回需求的原型看板", async () => {
  const w = await world();
  w.provider.queue.push(w.submit(HTML), { type: "text", text: "已交稿" });
  await w.dispatch();
  await until(() => w.events("prototype.submitted").length === 1);
  const viaRpc = await w.call("prototypes.board", { requirementId: w.fixture.requirementId });
  expect(viaRpc).toEqual(JSON.parse(JSON.stringify(await w.board())));
});

test("prototypes.designers 只列 prototype 类可用定义：名称、描述与来源，不含 worker 类和格式有误的定义", async () => {
  const w = await world();
  const { items } = await w.call("prototypes.designers", {}) as { items: Array<{ name: string; description: string; source: string }> };
  const names = items.map((item) => item.name);
  expect(names).toEqual(expect.arrayContaining(["proto-b", "prototype"]));
  expect(names).not.toContain("ui-dev");
  expect(names).not.toContain("proto-broken");
  expect(items.find((item) => item.name === "proto-b")).toEqual({ name: "proto-b", description: "B 模型设计师", source: "user" });
  expect(items.find((item) => item.name === "prototype")).toMatchObject({ description: expect.any(String), source: expect.any(String) });
});

test("会话出错结束时看板在途清空、记下含出错的原因，并收到 finished 事件", async () => {
  const w = await world();
  const { version } = await w.dispatch();
  await until(() => w.events("prototype.finished").length === 1);
  expect(w.events("prototype.finished")[0]).toMatchObject({ parentSessionId: "session-a", name: "登录页", version, reason: expect.stringContaining("出错") });
  expect((await w.entry())?.inFlight).toBeNull();
  expect((await w.entry())?.lastEnded?.reason).toContain("出错");
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("派出途中会话创建失败时派出被拒，看板在途被清并记下原因", async () => {
  const w = await world();
  const stuck = uuidv7();
  withDatabase(repositoryDatabase(w.ref.dataRoot, w.ref.repoId), (db) => db.create("requirements", stuck, {
    format: "requirement-lifecycle/v1", requirementId: stuck, repoId: w.ref.repoId, requestId: uuidv7(), intentHash: "a".repeat(64), lifecycle: "draft", revision: 0,
    epoch: 1, saved: null, approved: null, approvalReceiptId: null, workspace: null, pendingRevision: null, close: null, recovery: "ready", recoveryReason: null,
    createdAt: 1, updatedAt: 1 }));
  const before = w.provider.requests.length;
  await expect(w.dispatch({ requirementId: stuck })).rejects.toMatchObject({ code: "subagent_session_failed" });
  const board = await readPrototypeBoard(w.ref, stuck);
  expect(board.entries[0]).toMatchObject({ name: "登录页", inFlight: null, lastEnded: { version: 1, reason: expect.any(String) } });
  expect(w.provider.requests.length).toBe(before);
});

test("派出途中发起连接已断开时派出被拒，看板在途被清", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  await expect(w.dispatch({}, "connection-gone")).rejects.toMatchObject({ code: "not_found" });
  expect((await w.entry())?.inFlight).toBeNull();
  expect((await w.entry())?.lastEnded?.reason).toContain("主窗口断开");
  await expect(w.call("prototypes.list", {}, "connection-gone")).resolves.toEqual({ items: [] });
});

test("设计师会话带知识查询工具", async () => {
  const w = await world({ index: true });
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch();
  await w.started();
  const request = w.provider.requests.find((entry) => JSON.stringify(entry).includes("手机号加验证码登录界面"))!;
  expect(request.tools?.map((tool) => tool.name)).toContain("one_company_knowledge_query");
  await w.call("runs.stop", { runId });
});

async function awaitingPrototype(w: Awaited<ReturnType<typeof world>>, html = HTML) {
  const before = w.events("prototype.submitted").length;
  w.provider.queue.push(w.submit(html), { type: "text", text: "已交稿" });
  const { version } = await w.dispatch();
  await until(() => w.events("prototype.submitted").length === before + 1);
  return version;
}
const pendingInput = (w: Awaited<ReturnType<typeof world>>) => ({ requirementId: w.fixture.requirementId, name: "登录页" });
const decideInput = async (w: Awaited<ReturnType<typeof world>>, choice: "accept" | "abandon") => {
  const pending = await w.call("prototypes.pending", pendingInput(w));
  return w.call("prototypes.decide", { ...pendingInput(w), version: pending.version, hash: pending.hash, choice, opinion: null });
};

test("prototypes.pending 有待确认版本时带需求标题、草稿版本号（当前版本加一）和文件信息", async () => {
  const w = await world();
  const version = await awaitingPrototype(w);
  const pending = await w.call("prototypes.pending", pendingInput(w));
  const revision = w.fixture.state.read(w.fixture.requirementId).data.revision;
  expect(pending).toMatchObject({ requirementTitle: expect.any(String), draftVersion: revision + 1, name: "登录页", version, bytes: Buffer.byteLength(HTML),
    path: prototypeFilePath(w.ref, { requirementId: w.fixture.requirementId, name: "登录页", version }), note: "手机号输入框加验证码按钮", previousOpinion: null });
  expect((pending.requirementTitle as string).length).toBeGreaterThan(0);
  expect(pending.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("prototypes.pending 在设计中时被拒，原因写明还在设计中", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { runId } = await w.dispatch();
  await w.started();
  await expect(w.call("prototypes.pending", pendingInput(w))).rejects.toMatchObject({ message: expect.stringContaining("还在设计中") });
  await w.call("runs.stop", { runId });
});

test("prototypes.pending 在这一版已通过进草稿后被拒，原因写明已通过", async () => {
  const w = await world();
  await awaitingPrototype(w);
  await decideInput(w, "accept");
  await expect(w.call("prototypes.pending", pendingInput(w))).rejects.toMatchObject({ message: expect.stringMatching(/已通过/u) });
});

test("prototypes.pending 在原型已从草稿移除后被拒，原因写明已移除", async () => {
  const w = await world();
  await awaitingPrototype(w);
  await decideInput(w, "accept");
  await w.call("prototypes.remove", { ...pendingInput(w), version: 1 });
  await expect(w.call("prototypes.pending", pendingInput(w))).rejects.toMatchObject({ message: expect.stringContaining("移除") });
});

test("prototypes.pending 在上一版因文件被改作废后被拒，原因写明文件被改过、这一版已作废", async () => {
  const w = await world();
  const version = await awaitingPrototype(w);
  await writeFile(prototypeFilePath(w.ref, { requirementId: w.fixture.requirementId, name: "登录页", version }), "<html>被改过</html>");
  await expect(w.call("prototypes.pending", pendingInput(w))).rejects.toMatchObject({ message: expect.stringContaining("文件在交稿后被改过") });
  await expect(w.call("prototypes.pending", pendingInput(w))).rejects.toMatchObject({ message: expect.stringMatching(/作废/u) });
});

test("prototypes.removal 本次草稿新通过的原型：草稿版本号是当前版本加一，approvedRevision 为 null", async () => {
  const w = await world();
  const version = await awaitingPrototype(w);
  await decideInput(w, "accept");
  const revision = w.fixture.state.read(w.fixture.requirementId).data.revision;
  const removal = await w.call("prototypes.removal", pendingInput(w));
  expect(removal).toMatchObject({ requirementTitle: expect.any(String), draftVersion: revision + 1, name: "登录页", version, approvedRevision: null });
});

test("prototypes.removal 已在需求里批准过的原型：approvedRevision 等于当前需求版本", async () => {
  const w = await world();
  const version = await awaitingPrototype(w);
  await decideInput(w, "accept");
  const { digest } = await draftPrototypes(w.ref, w.fixture.requirementId);
  promote(w.ref, { requirementId: w.fixture.requirementId, digest });
  const revision = w.fixture.state.read(w.fixture.requirementId).data.revision;
  const removal = await w.call("prototypes.removal", pendingInput(w));
  expect(removal).toMatchObject({ draftVersion: revision + 1, name: "登录页", version, approvedRevision: revision });
});

test("prototypes.removal 对已移除的条目和不存在的名称都被拒并写明草稿里没有", async () => {
  const w = await world();
  await awaitingPrototype(w);
  await decideInput(w, "accept");
  await w.call("prototypes.remove", { ...pendingInput(w), version: 1 });
  await expect(w.call("prototypes.removal", pendingInput(w))).rejects.toMatchObject({ message: expect.stringContaining("草稿里没有") });
  await expect(w.call("prototypes.removal", { requirementId: w.fixture.requirementId, name: "不存在" })).rejects.toMatchObject({ message: expect.stringContaining("草稿里没有") });
});

test("需求关闭时这个需求下还在运行的设计师被停止，这一版不再在途，结束原因写明需求已关闭", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { version } = await w.dispatch();
  await w.started();
  await w.manager.stopRequirement(w.fixture.requirementId, { reason: "requirement_closing" });
  await until(async () => (await w.entry())?.inFlight === null);
  expect((await w.entry())?.lastEnded).toMatchObject({ version, reason: expect.stringContaining("需求已关闭") });
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("需求的旧运行因新 PM 接管而结束时，还在运行的设计师继续运行，这一版仍在途", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  const { version } = await w.dispatch();
  await w.started();
  await w.manager.stopRequirement(w.fixture.requirementId, { reason: "superseded_by_new_pm" });
  const entry = await w.entry();
  expect(entry?.inFlight).toMatchObject({ version });
  expect(entry?.lastEnded ?? null).toBeNull();
});

type DispatchWorld = Awaited<ReturnType<typeof world>>;
function changeRequirementDuringDispatch(w: DispatchWorld, change: (record: Record<string, unknown>) => Record<string, unknown>) {
  const original = (w.manager as unknown as { requirementTitle: (id: string) => Promise<string> }).requirementTitle.bind(w.manager);
  vi.spyOn(w.manager as never, "requirementTitle").mockImplementationOnce((async (requirementId: string) => {
    withDatabase(repositoryDatabase(w.ref.dataRoot, w.ref.repoId), (db) => {
      const row = db.read<Record<string, unknown>>("requirements", requirementId)!;
      db.update("requirements", requirementId, row.version, change(row.data));
    });
    return original(requirementId);
  }) as never);
}

test("派出已被接受、会话还没建好时需求被取消：这一版不再在途，结束原因写需求已取消，派出被拒并建议先建新需求", async () => {
  const w = await world();
  w.provider.queue.push(w.slow);
  changeRequirementDuringDispatch(w, (record) => ({ ...record, lifecycle: "closed",
    close: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } }));
  await expect(w.dispatch()).rejects.toMatchObject({ message: expect.stringContaining("需求已取消"),
    advice: { next: expect.stringContaining("新需求") } });
  const entry = await w.entry();
  expect(entry?.inFlight).toBeNull();
  expect(entry?.lastEnded?.reason).toContain("需求已取消");
  await expect(w.call("prototypes.list", {})).resolves.toEqual({ items: [] });
});

test("派出已被接受、会话还没建好时需求进入等恢复核对：只停这一次派出的设计师，早已运行的另一个设计师不受影响，原因写等用户恢复核对并建议请用户先处理", async () => {
  const w = await world();
  w.provider.queue.push(w.slow, w.slow);
  await w.dispatch({ name: "设置页" });
  await w.started();
  changeRequirementDuringDispatch(w, (record) => ({ ...record, recovery: "needs_review", recoveryReason: "archive_found" }));
  await expect(w.dispatch({ name: "登录页" })).rejects.toMatchObject({ message: expect.stringContaining("需求正在等用户恢复核对"),
    advice: { next: expect.stringContaining("恢复核对") } });
  const stopped = await w.entry("登录页");
  expect(stopped?.inFlight).toBeNull();
  expect(stopped?.lastEnded?.reason).toContain("需求正在等用户恢复核对");
  expect((await w.entry("设置页"))?.inFlight).toMatchObject({ version: 1 });
  expect((await w.entry("设置页"))?.lastEnded ?? null).toBeNull();
});

const NOTE = "用 B 方案（顶部分栏），A 和 C 不要";
const noted = [{ name: "设置页", version: 1, hash: "a".repeat(64), bytes: 10, userNote: NOTE },
  { name: "命令行输出", version: 2, hash: "b".repeat(64), bytes: 10, userNote: null }];

test("任务说明的原型清单里，带说明的原型下面紧跟一行用户通过时的说明，没有说明的不加", () => {
  const lines = requirementPrototypeLines(3, noted, (item) => `/p/${item.name}`).split("\n");
  const first = lines.findIndex((line) => line.includes("设置页"));
  expect(lines[first + 1]).toBe(`  用户通过时的说明：${NOTE}`);
  expect(lines[lines.findIndex((line) => line.includes("命令行输出")) + 1]).toBeUndefined();
  expect(lines.filter((line) => line.includes("用户通过时的说明"))).toHaveLength(1);
});

test("PM 看的原型清单里，带说明的写成用户说明括号，没有说明的和原来一样，空列表仍写这一版没有原型", () => {
  expect(approvedPrototypeListLines(noted)).toEqual(["当前批准版本附带的原型：", `- 设置页 第 1 版（用户说明：${NOTE}）`, "- 命令行输出 第 2 版"]);
  expect(approvedPrototypeListLines([])).toEqual(["这一版没有原型"]);
});

test("任务说明在有意见时写用户对上一版的意见原话，不出现返工字样", () => {
  const text = prototypeContext({ title: "登录", name: "登录页", version: 2, brief: "要求", maxTurns: 12, previous: { path: "/p/v1.html", opinion: "改成横向滚动" } });
  expect(text).toContain("用户对上一版的意见原话：改成横向滚动");
  expect(text).not.toContain("返工");
});
