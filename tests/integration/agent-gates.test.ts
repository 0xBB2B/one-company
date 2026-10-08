import { afterEach, expect, test } from "vitest";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { createClock } from "../../runtime/clock.ts";
import { checkExploreSession } from "../../runtime/explore-session.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import type { DaemonClient } from "../../runtime/daemon-client.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../runtime/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { createPlanManageTool, TASKS } from "../../runtime/plan-manage.ts";
import type { TaskSpec } from "../../runtime/plan-manage.ts";
import { createPmIntakeProviders, PM_INTAKE_TOOL } from "../../runtime/pm-intake-runtime.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { connectRawClient, killDaemon, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import type { SpawnedDaemon } from "../helpers/daemon-harness.ts";
import { PROVIDER_APPEND_ENV_VAR, PROVIDER_REQUESTS_LOG_ENV_VAR, PROVIDER_SCRIPTS_ENV_VAR } from "../helpers/model-provider-module.ts";
import { createPmIntakeFixture } from "../helpers/pm-intake-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const providerModule = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "model-provider-module.ts");
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [],
  writePaths: [`src/${key}/`], blockedByQuestionIds: [], maxTurns: 3, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["其他"] }, performance: NA, ...patch });
const definition = (name: string, extra = "") => `---\nname: ${name}\ndescription: ${name} 专业定义\nrole: worker\n${extra}---\n你是 ${name}。\n`;
const until = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("等待超时");
};

/**
 * 经真实 daemon（设了 ONE_COMPANY_TEST_PRODUCT_ROOT 时为安装产物）派出受控模型 PM：
 * 角色定义放在 daemon 实际使用的用户层 dirname(dataRoot)/agents 与项目层 .pi/agents，派工与目录查询都由 PM 的工具调用发起。
 */
async function world() {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const record = fixture.state.read(fixture.requirementId).data;
  fixture.db((db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", fixture.requirementId)!;
    db.update("pm_ownership", fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
    db.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, title: "角色跳跃", operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  const agentDir = dirname(fixture.dataRoot), userAgents = join(agentDir, "agents"), projectAgents = join(fixture.repositoryRoot, ".pi", "agents");
  await mkdir(join(agentDir, "skills", "ui-kit"), { recursive: true });
  await writeFile(join(agentDir, "skills", "ui-kit", "SKILL.md"), "# UI 规范\n按钮统一用主色。\n");
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...understanding } = material!.understanding;
  const files = { scripts: join(fixture.root, "scripts.json"), log: join(fixture.root, "requests.jsonl"), append: join(fixture.root, "append.jsonl") };
  await writeFile(files.scripts, JSON.stringify([
    { providerId: "gate-model", modelId: "test", replies: [{ type: "toolcall", name: PM_INTAKE_TOOL, input: { action: "ask", purpose: "pm-intake", understanding } }, { type: "text", text: "等待核对" }] },
    { providerId: "spec-model", modelId: "test", replies: [] }, { providerId: "nokey-model", modelId: "test", noAuth: true, replies: [] }]));
  const home = await createTempHome(); cleanups.push(() => removeTempHome(home));
  let daemon: SpawnedDaemon | undefined, client: DaemonClient | undefined;
  const start = async () => {
    const { commonDir } = await repositoryIdentity(fixture.repositoryRoot);
    daemon = spawnDaemonProcess({ home, repoDir: commonDir, dataRoot: fixture.dataRoot, extraEnv: { ONE_COMPANY_MODEL_PROVIDER_MODULE: providerModule,
      [PROVIDER_SCRIPTS_ENV_VAR]: files.scripts, [PROVIDER_REQUESTS_LOG_ENV_VAR]: files.log, [PROVIDER_APPEND_ENV_VAR]: files.append } });
    const current = daemon;
    cleanups.push(async () => { await client?.close?.(); await killDaemon(current).catch(() => undefined); });
    await Promise.race([waitForSocketReady(daemonSocketPath(fixture.dataRoot, fixture.repoId)), current.exited.then(() => { throw new Error("daemon_exited_before_ready"); })]);
    const workspace = record.workspace!.path, clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
    client = await connectDaemon({ repoDir: workspace, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock, connectOnly: true,
      hello: { windowId: uuidv7(), sessionId: SessionManager.inMemory(workspace).getSessionId() } });
    return client;
  };
  const reply = (providerId: string, ...replies: ScriptedReply[]) => appendFile(files.append, replies.map((item) => `${JSON.stringify({ providerId, reply: item })}\n`).join(""));
  const requests = async () => (await readFile(files.log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { providerId: string; text: string; last: string });
  const pmRequests = async () => (await requests()).filter((entry) => entry.providerId === "gate-model");
  /** PM 发出第 n 次模型请求后，返回该请求里最后一条工具结果文字。 */
  const toolResult = async (n: number) => { await until(async () => (await pmRequests()).length >= n); return (await pmRequests())[n - 1]!.last; };
  const runs = () => new RunStore({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, daemonStartedAt: new Date().toISOString() });
  const task = (key: string) => withDatabase(repositoryDatabase(fixture.dataRoot, fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);

  /** 派出 PM、主代理核对通过，随后由测试进程以 PM 身份提出并确认计划。 */
  async function readyPm(tasks: TaskSpec[]) {
    const connected = await start();
    const pm = await connected.call("agents.dispatchPm", { requirementId: fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" }) as { runId: string };
    await until(async () => (await pmRequests()).length === 2);
    const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
    const view = await intake.openRequest(fixture.call, fixture.operationId());
    await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
    await until(async () => (await pmRequests()).length === 3);
    const lease = fixture.state.pmOwner(fixture.requirementId)!.lease!;
    const plan = await createPlanManageTool({ repositoryRoot: fixture.repositoryRoot, dataRoot: fixture.dataRoot, authorize: () => true,
      grant: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: fixture.requirementId, repoId: fixture.repoId, workspaceId: lease.workspaceId, lease } });
    cleanups.push(() => plan.dispose());
    await plan.execute({ action: "propose", tasks });
    await plan.execute({ action: "confirm", planVersion: 1 });
    return pm;
  }
  return { fixture, userAgents, projectAgents, agentDir, reply, toolResult, pmRequests, runs, task, readyPm, start, requests, client: () => client!, scripts: files.scripts };
}

test("M9-AC14：daemon 从 dirname(dataRoot)/agents 与受信任项目的 .pi/agents 发现定义；缺 role、同层重名与仓库外祖先目录不进入能力目录，项目未受信任时不加载", async () => {
  const w = await world();
  await mkdir(w.userAgents, { recursive: true }); await mkdir(w.projectAgents, { recursive: true });
  await writeFile(join(w.userAgents, "ui-dev.md"), definition("ui-dev"));
  await writeFile(join(w.userAgents, "helper.md"), "---\nname: helper\ndescription: 宿主自带定义\n---\n帮忙。\n");
  await writeFile(join(w.userAgents, "dup-a.md"), definition("dup"));
  await writeFile(join(w.userAgents, "dup-b.md"), definition("dup"));
  await writeFile(join(w.projectAgents, "proj-dev.md"), definition("proj-dev"));
  await mkdir(join(dirname(w.fixture.repositoryRoot), ".pi", "agents"), { recursive: true });
  await writeFile(join(dirname(w.fixture.repositoryRoot), ".pi", "agents", "ancestor-dev.md"), definition("ancestor-dev"));
  await w.readyPm([spec("dup-task", { agent: "dup" }), spec("cover", { goalUnitIds: ["scenario.failure"] })]);
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "catalog", role: "worker" } });
  const untrusted = await w.toolResult(4);
  expect(untrusted).toContain("ui-dev");
  for (const hidden of ["proj-dev", "helper", "\\\"dup\\\"", "ancestor-dev"]) expect(untrusted).not.toContain(hidden);
  new ProjectTrustStore(w.agentDir).set(w.fixture.repositoryRoot, true);
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "catalog", role: "worker" } },
    { type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", taskId: w.task("dup-task").taskId } }, { type: "text", text: "完成" });
  const trusted = await w.toolResult(5);
  expect(trusted).toContain("proj-dev");
  expect(trusted).not.toContain("ancestor-dev");
  expect(await w.toolResult(6)).toContain("未找到角色定义 dup");
  expect((await w.runs().list({ limit: 50 })).items.filter((run) => run.kind === "role")).toEqual([]);
}, 120_000);

test("M9-AC15/AC16：零匹配走默认 worker、指定专业定义按定义派出并加载 skill；指定不存在、缺 skill、缺模型、思考等级不受支持或越权声明工具时明确拒绝、不静默改默认、不建运行", async () => {
  const w = await world();
  await mkdir(w.userAgents, { recursive: true });
  await writeFile(join(w.userAgents, "ui-dev.md"), definition("ui-dev", "model: spec-model/test\nskills: [ui-kit]\n"));
  await writeFile(join(w.userAgents, "ghost-skill.md"), definition("ghost-skill", "skills: [missing]\n"));
  await writeFile(join(w.userAgents, "bad-model.md"), definition("bad-model", "model: nowhere/none\n"));
  await writeFile(join(w.userAgents, "deep-think.md"), definition("deep-think", "model: spec-model/test\nthinking: minimal\n"));
  await writeFile(join(w.userAgents, "tool-grab.md"), definition("tool-grab", "tools: [bash, write]\n"));
  await w.readyPm([spec("a", { agent: "nobody" }), spec("b", { agent: "ghost-skill" }), spec("c", { agent: "bad-model" }), spec("d", { agent: "deep-think" }), spec("e", { agent: "tool-grab" }),
    spec("ui", { agent: "ui-dev", agentReason: "界面任务" }), spec("plain", { goalUnitIds: ["scenario.failure"] })]);
  const dispatch = (key: string): ScriptedReply => ({ type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", taskId: w.task(key).taskId } });
  await w.reply("spec-model", { type: "text", text: "按 UI 规范开工" });
  await w.reply("gate-model", dispatch("a"), dispatch("b"), dispatch("c"), dispatch("d"), dispatch("e"), dispatch("ui"), dispatch("plain"), { type: "text", text: "完成" }, { type: "text", text: "开工" });
  expect(await w.toolResult(4)).toContain("未找到角色定义 nobody");
  expect(await w.toolResult(5)).toContain("找不到 skill missing（ghost-skill 声明）");
  expect(await w.toolResult(6)).toContain("模型不可用：本机的模型配置里找不到模型 nowhere/none");
  expect(await w.toolResult(7)).toContain("不支持思考等级 minimal");
  expect(await w.toolResult(8)).toContain("tool-grab 定义不可用");
  await w.toolResult(10);
  const roles = (await w.runs().list({ limit: 50 })).items.filter((run) => run.kind === "role");
  const detail = await Promise.all(roles.map(async (run) => { const got = await w.runs().get(run.id); return got.ok ? got.run : null; }));
  expect(detail.map((run) => [run?.task, run?.agent?.name, run?.agent?.source, run?.model.provider]).sort()).toEqual([
    [w.task("plain").taskId, "worker", "default", "gate-model"], [w.task("ui").taskId, "ui-dev", "user", "spec-model"]].sort());
  expect(detail.find((run) => run?.agent?.name === "ui-dev")?.agent?.skills.map((skill) => skill.name)).toEqual(["ui-kit"]);
  for (const key of ["a", "b", "c", "d", "e"]) expect(w.task(key).status).toBe("pending");
  const specRequests = (await w.requests()).filter((entry) => entry.providerId === "spec-model");
  expect(specRequests[0]?.text).toContain("按钮统一用主色");
}, 120_000);

test("M9-AC16：指定定义的模型在本机配置里有、但没有可用凭据时派工明确拒绝，写明原因，不改用默认模型、不建运行", async () => {
  const w = await world();
  await mkdir(w.userAgents, { recursive: true });
  await writeFile(join(w.userAgents, "no-key.md"), definition("no-key", "model: nokey-model/test\n"));
  await w.readyPm([spec("k", { agent: "no-key" }), spec("plain", { goalUnitIds: ["scenario.failure"] })]);
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", taskId: w.task("k").taskId } }, { type: "text", text: "等用户处理" });
  expect(await w.toolResult(4)).toContain("模型不可用：nokey-model/test 没有可用的凭据");
  expect((await w.runs().list({ limit: 50 })).items.filter((run) => run.kind === "role")).toEqual([]);
  expect(w.task("k").status).toBe("pending");
  expect((await w.requests()).filter((entry) => entry.providerId === "nokey-model")).toEqual([]);
}, 120_000);

test("M9-AC9/AC16：未认证连接与已有有效 PM 时再派 PM 均被拒；专业 worker 暂停期间改了定义，续接被拒并以 config_changed 停止", async () => {
  const w = await world();
  await mkdir(w.userAgents, { recursive: true });
  await writeFile(join(w.userAgents, "ui-dev.md"), definition("ui-dev", "model: spec-model/test\n"));
  await w.readyPm([spec("ui", { agent: "ui-dev" }), spec("cover", { goalUnitIds: ["scenario.failure"] })]);
  const raw = await connectRawClient(daemonSocketPath(w.fixture.dataRoot, w.fixture.repoId)); cleanups.push(() => raw.close());
  await expect(raw.call("agents.dispatchPm", { requirementId: w.fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" })).rejects.toThrow();
  const client = w.client();
  await expect(client.call("agents.dispatchPm", { requirementId: w.fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" }))
    .rejects.toMatchObject({ code: "pm_already_owned" });
  await w.reply("spec-model", { type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", taskId: w.task("ui").taskId } }, { type: "text", text: "等待" });
  let runId = "";
  await until(async () => { runId = (await w.runs().list({ limit: 50 })).items.find((run) => run.kind === "role" && run.state === "running")?.id ?? ""; return runId !== ""; });
  // 受控模型的延迟回复不响应中止，暂停要等这段回复结束才能确认
  await until(async () => (await client.call("runs.pause", { runId }) as { confirmed: boolean }).confirmed);
  await writeFile(join(w.userAgents, "ui-dev.md"), definition("ui-dev", "model: spec-model/test\n").replace("你是 ui-dev。", "你是改过的 ui-dev。"));
  await expect(client.call("runs.resume", { runId })).rejects.toMatchObject({ code: "config_changed" });
  expect(await w.runs().get(runId)).toMatchObject({ ok: true, run: { state: "stopped", stopCause: { reason: "config_changed" } } });
}, 120_000);

test("M9-AC9：已通过接手的 PM 被停止后重新派出，新 PM 须重新接手，主代理核对通过前派 worker 被拒", async () => {
  const w = await world();
  const first = await w.readyPm([spec("login"), spec("cover", { goalUnitIds: ["scenario.failure"] })]);
  const client = w.client();
  await w.reply("gate-model", { type: "text", text: "收到核对结论" });
  await until(async () => (await client.call("runs.stop", { runId: first.runId }) as { confirmed: boolean }).confirmed);
  const intakeAsk = JSON.parse(await readFile(w.scripts, "utf8"))[0].replies[0] as ScriptedReply;
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", taskId: w.task("login").taskId } }, intakeAsk, { type: "text", text: "等待核对" });
  const second = await client.call("agents.dispatchPm", { requirementId: w.fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" }) as { runId: string; fence: number };
  expect(second.runId).not.toBe(first.runId);
  expect(await w.toolResult(4)).toContain("开始受限接手");
  const denied = await w.toolResult(5);
  for (const reason of ["原因：接手核对还没通过，或 PM 租约已失效", "当前 PM 还没有提交接手理解", "现在是新派出的 PM，需要重新接手", "PM 已换代，需要重新接手"]) expect(denied).toContain(reason);
  expect(denied).not.toMatch(/understanding_baseline_missing|new_pm_run|intake_gate/);
  expect((await w.runs().list({ limit: 50 })).items.filter((run) => run.kind === "role")).toEqual([]);
  expect(w.task("login").status).toBe("pending");
}, 120_000);

/** PM 派出一个还在检索中的 explore：explore 用用户层定义改走 spec-model，回复故意放慢，派出后一直处于运行中。 */
async function pmWithRunningExplore() {
  const w = await world();
  await mkdir(w.userAgents, { recursive: true });
  await writeFile(join(w.userAgents, "explore.md"), "---\nname: explore\ndescription: 测试用检索\nrole: explore\nmodel: spec-model/test\n---\n你是只读检索代理。\n");
  const pm = await w.readyPm([spec("login"), spec("plain", { goalUnitIds: ["scenario.failure"] })]);
  await w.reply("spec-model", { type: "text", text: "慢慢查", chunkDelayMs: 60_000 });
  await w.reply("gate-model", { type: "toolcall", name: "one_company_agent_manage", input: { action: "dispatch", role: "explore", question: "登录模块在哪里", clues: [], maxTurns: 2 } },
    { type: "text", text: "等检索结果" });
  const explore = async () => (await w.runs().list({ limit: 50 })).items.find((run) => run.role === "one-company.explore");
  await until(async () => (await explore())?.state === "running");
  const exploreId = (await explore())!.id;
  const run = async (id: string) => { const got = await w.runs().get(id); return got.ok ? got.run : null; };
  const session = () => checkExploreSession({ dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId }, exploreId);
  return { w, pm, exploreId, run, session };
}

test("M9-AC10：安装产物中主代理停止 PM（撤权）时，PM 派出的 explore 随之停止、记为随父停止，检索会话失效", async () => {
  const { w, pm, exploreId, run, session } = await pmWithRunningExplore();
  expect(session()).toMatchObject({ current: true });
  await w.client().call("runs.stop", { runId: pm.runId });
  await until(async () => (await run(exploreId))?.state === "stopped");
  expect(await run(exploreId)).toMatchObject({ state: "stopped", stopCause: { reason: "parent_stopped" } });
  expect(await run(pm.runId)).toMatchObject({ state: "stopped" });
  expect(session()).toMatchObject({ current: false });
}, 120_000);

test("M9-AC10：安装产物中旧 PM 租约失效后派出新 PM（接管）时，旧 PM 与它派出的 explore 都停止并记为被新 PM 取代，旧检索会话失效", async () => {
  const { w, pm, exploreId, run, session } = await pmWithRunningExplore();
  w.fixture.db((db) => {
    const row = db.read<{ lease: { expiresAt: number } }>("pm_ownership", w.fixture.requirementId)!;
    db.update("pm_ownership", w.fixture.requirementId, row.version, { ...row.data, lease: { ...row.data.lease, expiresAt: Date.now() - 1 } });
  });
  await w.reply("gate-model", { type: "text", text: "新 PM 接手" });
  const next = await w.client().call("agents.dispatchPm", { requirementId: w.fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" }) as { runId: string };
  expect(next.runId).not.toBe(pm.runId);
  await until(async () => (await run(exploreId))?.state === "stopped");
  expect(await run(exploreId)).toMatchObject({ state: "stopped", stopCause: { reason: "superseded_by_new_pm" } });
  expect(await run(pm.runId)).toMatchObject({ state: "stopped", stopCause: { reason: "superseded_by_new_pm" } });
  expect(session()).toMatchObject({ current: false });
}, 120_000);
