import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { agentManageTool } from "../src/app/daemon/pm-tools.ts";
import type { PmToolsInput } from "../src/app/daemon/pm-tools.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskRecord } from "../src/modules/pm/plan-manage.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { CheckRoundService } from "../src/modules/verification/check-round.ts";
import type { TaskSpec } from "../src/modules/pm/plan-manage.ts";
import { defaultRoleDir, loadRoleCatalog } from "../src/modules/agents/roles.ts";
import { disabledAgentNames } from "../src/modules/settings/agent-settings.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [],
  writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 3, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["其他"] }, performance: NA, ...patch });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function world(initialDisabled: Set<string> = new Set<string>()) {
  const disabled = initialDisabled;
  const w = await createPmRunWorld(cleanups, { loadDisabledAgents: () => disabled });
  const root = await mkdtemp(join(tmpdir(), "agent-selection-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const userDir = join(root, "agents"), skillDir = join(root, "skills");
  await mkdir(join(skillDir, "ui-kit"), { recursive: true });
  const skill = "# UI 规范\n按钮统一用主色。\n";
  await writeFile(join(skillDir, "ui-kit", "SKILL.md"), skill);
  const define = async (name: string, extra: string, body = `你是 ${name}。`, role = "worker") => {
    await mkdir(userDir, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${name} 专业定义\nrole: ${role}\n${extra}---\n${body}\n`;
    await writeFile(join(userDir, `${name}.md`), content);
    return content;
  };
  const options = (w.manager as unknown as { options: Record<string, unknown> }).options;
  options.loadRoleCatalog = async () => (await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir, projectDir: join(root, "none"), parseFrontmatter, projectTrusted: false })).roles;
  options.skillDirs = [skillDir];
  const task = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null });
  return { ...w, userDir, skillDir, skill, define, task, dispatch, disabled, options };
}
const prompt = (request: Context | undefined) => request?.systemPrompt ?? "";

test("M7-AC22/AC23/AC24：能力目录有界；任务指定专业定义时按定义派工、按需加载 skills，运行记录保存定义与 skills 指纹", async () => {
  const w = await world();
  const content = await w.define("ui-dev", "skills: [ui-kit]\n");
  const catalog = await w.manager.agentCatalog("worker", 0);
  expect(catalog.items.map((item) => item.name)).toEqual(expect.arrayContaining(["ui-dev", "worker"]));
  expect(catalog.items.every((item) => item.role === "worker")).toBe(true);
  expect(JSON.stringify(catalog)).not.toContain("你是 ui-dev");
  expect(JSON.stringify(await w.manager.agentCatalog(undefined, 0))).not.toContain("\"pm\"");
  for (const internal of ["interpreter", "draft-verifier"]) expect(JSON.stringify(await w.manager.agentCatalog(undefined, 0))).not.toContain(`"${internal}"`);

  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev", agentReason: "界面任务" }), spec("plain", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "开工" }, { type: "text", text: "PM 收到" });
  const run = await w.dispatch("ui");
  await until(() => w.provider.requests.some((request) => prompt(request).includes("你是 ui-dev")));
  const system = prompt(w.provider.requests.find((request) => prompt(request).includes("你是 ui-dev")));
  expect(system).toContain("按钮统一用主色");
  const record = await w.runStore.get(run.runId);
  expect(record.ok && record.run.agent).toMatchObject({ name: "ui-dev", source: "user", hash: sha(content),
    skills: [{ name: "ui-kit", path: join(w.userDir, "..", "skills", "ui-kit", "SKILL.md"), hash: sha(w.skill) }] });
});

test("M7-AC22/AC23：指定定义不存在、声明的 skill 缺失、模型不存在或思考等级不受支持时拒绝派工，不静默改用默认", async () => {
  const w = await world();
  await w.define("ghost-skill", "skills: [missing]\n");
  await w.define("bad-model", "model: nowhere/none\n");
  await w.define("deep-think", "thinking: minimal\n");
  await w.plan.execute({ action: "propose", tasks: [
    spec("a", { agent: "nobody" }), spec("b", { agent: "ghost-skill", goalUnitIds: ["scenario.failure"] }),
    spec("c", { agent: "bad-model" }), spec("d", { agent: "deep-think", goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("a")).rejects.toMatchObject({ code: "agent_unavailable" });
  await expect(w.dispatch("b")).rejects.toMatchObject({ code: "skill_unavailable" });
  await expect(w.dispatch("c")).rejects.toMatchObject({ code: "model_unavailable" });
  await expect(w.dispatch("d")).rejects.toMatchObject({ code: "thinking_unsupported" });
});

test("PM 指定 prototype 类定义承担 worker 任务时派出失败，原因写明只能由主窗口派出；角色目录不列 prototype 类", async () => {
  const w = await world();
  await mkdir(w.userDir, { recursive: true });
  await writeFile(join(w.userDir, "proto-dev.md"), "---\nname: proto-dev\ndescription: 原型\nrole: prototype\n---\n你是 proto-dev。\n");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "proto-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("ui")).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringContaining("只能由主窗口派出") });
  const listed = await w.manager.agentCatalog(undefined, 0);
  expect(listed.items.map((item) => item.role)).not.toContain("prototype");
  expect(listed.items.map((item) => item.name)).not.toContain("prototype");
  expect(listed.items.map((item) => item.name)).not.toContain("proto-dev");
});

test("M7-AC25：运行中改了定义文件，暂停后续接时发现配置已变即安全停止，不用旧配置续跑", async () => {
  const w = await world();
  await w.define("ui-dev", "");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  const run = await w.dispatch("ui");
  await until(async () => { const current = await w.runStore.get(run.runId); return current.ok && current.run.state === "running"; });
  await w.manager.pause(run.runId);
  await w.define("ui-dev", "", "你是改过的 ui-dev。");
  await expect(w.manager.resume(run.runId)).rejects.toMatchObject({ code: "config_changed" });
  const stopped = await w.runStore.get(run.runId);
  expect(stopped.ok && stopped.run.state).toBe("stopped");
  expect(stopped.ok && stopped.run.stopCause).toEqual({ reason: "config_changed" });
});

test("M7-AC26：专业 worker 运行中不能开启正式检查；专项审查里写职责不是 reviewer 的定义时计划提交被拒；需求停止时专业实例一并停止", async () => {
  const w = await world();
  await w.define("ui-dev", "");
  await w.define("code-reviewer", "");
  await expect(w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev", reviewers: [{ agent: "code-reviewer", reason: "代码质量" }] } as Partial<TaskSpec>), spec("rest", { goalUnitIds: ["scenario.failure"] })] }))
    .rejects.toMatchObject({ code: "agent_invalid", detail: [expect.stringContaining("code-reviewer")] });
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  const run = await w.dispatch("ui");
  await until(async () => { const current = await w.runStore.get(run.runId); return current.ok && current.run.state === "running"; });
  const rounds = await CheckRoundService.open({ deliveryMode: async () => "remote" as const, repositoryRoot: w.fixture.repositoryRoot, dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, authorize: () => true });
  cleanups.push(() => rounds.dispose());
  await expect(rounds.openRound({ lease: w.lease })).rejects.toMatchObject({ code: "workers_active" });
  await w.manager.stopRequirement(w.fixture.requirementId, { reason: "requirement_closing" });
  const stopped = await w.runStore.get(run.runId);
  expect(stopped.ok && stopped.run.state).toBe("stopped");
});

test("M7-AC8：定义正文不含任何职责说明、模型也不遵守提示时，工具集合与写入限制仍由程序执行", async () => {
  const w = await world();
  await w.define("bare", "", "（无说明）");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "bare" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(
    { type: "toolcall", name: "one_company_plan_manage", input: { action: "confirm", planVersion: 1 } },
    { type: "toolcall", name: "one_company_change_apply", input: { action: "apply",
      files: [{ path: "docs/prd/x.md", baseHash: "absent", content: "x" }] } },
    { type: "toolcall", name: "bash", input: { command: "echo hacked > src/x.ts" } },
    { type: "text", text: "结束" }, { type: "text", text: "PM 收到" });
  await w.dispatch("ui");
  await until(() => w.provider.requests.some((request) => JSON.stringify(request.messages.at(-1) ?? "").includes("原因：这个路径不允许写入")));
  const tools = w.provider.requests.find((request) => prompt(request).includes("（无说明）"))!.tools!.map((tool) => tool.name);
  expect(tools).not.toContain("one_company_plan_manage");
  expect(tools).not.toContain("bash");
  const all = JSON.stringify(w.provider.requests);
  expect(all).toContain("Tool one_company_plan_manage not found");
  expect(all).toContain("原因：这个路径不允许写入");
});

test("关闭名单里的定义不出现在可用定义清单，名单改变后同一个 manager 立即生效", async () => {
  const w = await world();
  await w.define("py-worker", "");
  const baseline = await w.manager.agentCatalog("worker", 0);
  expect(baseline.items.map((item) => item.name)).toContain("py-worker");
  w.disabled.add("py-worker");
  const hidden = await w.manager.agentCatalog("worker", 0);
  expect(hidden.items.map((item) => item.name)).not.toContain("py-worker");
  expect(hidden.total).toBe(baseline.total - 1);
  w.disabled.clear();
  const shown = await w.manager.agentCatalog("worker", 0);
  expect(shown.items.map((item) => item.name)).toContain("py-worker");
  expect(shown.total).toBe(baseline.total);
});

test("任务指定的定义确认后被关闭，派工被拒为 agent_disabled，消息写明已关闭、建议原文，且不新增运行记录", async () => {
  const w = await world();
  await w.define("py-worker", "");
  await w.plan.execute({ action: "propose", tasks: [spec("py", { agent: "py-worker" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.disabled.add("py-worker");
  const before = (await w.runStore.list({ limit: 100 })).items.length;
  await expect(w.dispatch("py")).rejects.toMatchObject({ code: "agent_disabled", message: expect.stringContaining("py-worker 已关闭"),
    advice: { next: "改用开着的定义，或不指定（用通用 worker）后重新派；用户点名要这个定义时先问用户" } });
  expect((await w.runStore.list({ limit: 100 })).items.length).toBe(before);
});

test("被关闭的原型定义不出现在原型设计师清单，名单清空后重新出现", async () => {
  const w = await world();
  await mkdir(w.userDir, { recursive: true });
  await writeFile(join(w.userDir, "x-designer.md"), "---\nname: x-designer\ndescription: 原型\nrole: prototype\n---\n你是 x-designer。\n");
  expect((await w.manager.prototypeDesigners()).map((item) => item.name)).toContain("x-designer");
  w.disabled.add("x-designer");
  expect((await w.manager.prototypeDesigners()).map((item) => item.name)).not.toContain("x-designer");
  w.disabled.clear();
  expect((await w.manager.prototypeDesigners()).map((item) => item.name)).toContain("x-designer");
});

test("关闭名单含通用 worker 与 py-worker 时：通用 worker 仍可派、py-worker 被拒为 agent_disabled，清单含 worker 不含 py-worker", async () => {
  const w = await world(disabledAgentNames({ user: ["worker"], project: [] }));
  await w.define("py-worker", "");
  await w.plan.execute({ action: "propose", tasks: [spec("plain"), spec("py", { agent: "py-worker", goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.disabled.add("py-worker");
  w.provider.queue.push({ type: "text", text: "开工" }, { type: "text", text: "PM 收到" });
  await expect(w.dispatch("plain")).resolves.toMatchObject({ runId: expect.any(String) });
  await expect(w.dispatch("py")).rejects.toMatchObject({ code: "agent_disabled", message: expect.stringContaining("py-worker 已关闭") });
  const names = (await w.manager.agentCatalog("worker", 0)).items.map((item) => item.name);
  expect(names).toContain("worker");
  expect(names).not.toContain("py-worker");
});

const PM_FIRST_LINE = "你是一个活动需求的唯一 PM";
const verdict = (summary: string, findings: Array<{ kind: "blocking" | "unverified"; trigger: string }> = []): ScriptedReply => ({ type: "toolcall", name: "one_company_result_submit",
  input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary,
    findings: findings.map((finding) => ({ ...finding, targetRef: "prd:goal.login", evidenceRef: null, impact: "没有失败提示" })) } } });
const SUMMARIES = { reviewer: "通用审查无异议", "go-reviewer": "go 侧结论", "vue-reviewer": "vue 侧结论" } as const;

async function reviewWorld(initialDisabled?: Set<string>) {
  const w = await world(initialDisabled);
  await w.define("go-reviewer", "", "你是 go-reviewer。", "reviewer");
  await w.define("vue-reviewer", "", "你是 vue-reviewer。", "reviewer");
  await w.plan.execute({ action: "propose", tasks: [spec("login"), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const { dataRoot, repoId } = w.fixture;
  const taskId = w.task("login").taskId;
  const record = () => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.read<TaskRecord>(TASKS, taskId)!.data);
  withDatabase(repositoryDatabase(dataRoot, repoId), (db) => {
    const row = db.read<TaskRecord>(TASKS, taskId)!;
    db.update(TASKS, taskId, row.version, { ...row.data, status: "awaiting_review", reviewers: ["go-reviewer", "vue-reviewer"].map((agent) => ({ agent, reason: "专项审查" })),
      attempts: [{ runId: uuidv7(), maxTurns: 2, turnsUsed: 1, reason: null, outcome: "completed" }] });
  });
  const review = () => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId, retry: null, review: { maxTurns: 12 } }) as unknown as Promise<{ runIds: string[]; failed: Array<{ agent: string; reason: string }>; maxTurns: number }>;
  const patchTask = (change: Partial<TaskRecord>) => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => {
    const row = db.read<TaskRecord>(TASKS, taskId)!;
    db.update(TASKS, taskId, row.version, { ...row.data, ...change });
  });
  const reviewRunIds = async () => {
    const items = (await w.runStore.list({ limit: 100 })).items;
    const runs = await Promise.all(items.map((item) => w.runStore.get(item.id)));
    return runs.flatMap((run) => run.ok && run.run.role === "one-company.reviewer" ? [run.run.id] : []).sort();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const reviewRunNames = async () => {
    const items = (await w.runStore.list({ limit: 100 })).items;
    const runs = await Promise.all(items.map((item) => w.runStore.get(item.id)));
    return runs.flatMap((run) => run.ok && run.run.role === "one-company.reviewer" ? [run.run.agent?.name] : []).sort();
  };
  const open = new Map<string, () => void>();
  const served = new Set<string>();
  const replies: Record<string, ScriptedReply> = Object.fromEntries(Object.entries(SUMMARIES).map(([name, summary]) => [name, verdict(summary)]));
  w.provider.awaitReply = async (request) => {
    const system = prompt(request);
    const name = ["go-reviewer", "vue-reviewer"].find((candidate) => system.includes(`你是 ${candidate}。`)) ?? (system.includes("审查任务：") ? "reviewer" : undefined);
    if (!name || served.has(name)) return { type: "text", text: "收到" };
    served.add(name);
    return new Promise<ScriptedReply>((resolve) => open.set(name, () => resolve(replies[name]!)));
  };
  cleanups.push(() => { for (const resolve of open.values()) resolve(); });
  const release = async (name: string) => { await until(() => open.has(name)); open.get(name)!(); };
  const requestOf = (marker: string) => w.provider.requests.find((request) => prompt(request).includes(marker));
  const pmRequests = () => w.provider.requests.filter((request) => prompt(request).includes(PM_FIRST_LINE));
  const settled = () => record().reviews.filter((entry) => entry.outcome !== "running").length;
  return { ...w, taskId, record, review, patchTask, reviewRunIds, settle, reviewRunNames, replies, release, requestOf, pmRequests, settled };
}
const lastText = (request: Context | undefined) => JSON.stringify(request?.messages.at(-1) ?? "");

test("派一次审查（轮数上限 12）：任务专项审查为 go-reviewer、vue-reviewer 时同时出现 reviewer、go-reviewer、vue-reviewer 三个运行，三条审查记录的轮数上限都是 12", async () => {
  const t = await reviewWorld();
  await t.review();
  expect(await t.reviewRunNames()).toEqual(["go-reviewer", "reviewer", "vue-reviewer"]);
  expect(t.record().reviews.map((entry) => [entry.agent, entry.maxTurns]).sort()).toEqual([["go-reviewer", 12], ["reviewer", 12], ["vue-reviewer", 12]]);
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
  await until(() => t.record().status === "completed");
});

test("通用 reviewer 用通用审查规矩（含核对先红后绿），专项审查用专项审查规矩（含只按本任务加载的 skills）", async () => {
  const t = await reviewWorld();
  await t.review();
  const generic = () => t.provider.requests.find((request) => prompt(request).includes("审查任务：") && !prompt(request).includes("你是 go-reviewer。") && !prompt(request).includes("你是 vue-reviewer。"));
  await until(() => generic() !== undefined && t.requestOf("你是 go-reviewer。") !== undefined && t.requestOf("你是 vue-reviewer。") !== undefined);
  expect(prompt(generic())).toContain("核对先红后绿");
  expect(prompt(t.requestOf("你是 go-reviewer。"))).toContain("只按本任务加载的 skills");
  expect(prompt(t.requestOf("你是 go-reviewer。"))).not.toContain("核对先红后绿");
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
});

test("派之前关掉 go-reviewer：只启动 reviewer 与 vue-reviewer，go-reviewer 记为 skipped（disabled），整轮结束后 PM 收到的汇总含「go-reviewer 已关闭，本轮未审」", async () => {
  const t = await reviewWorld();
  t.disabled.add("go-reviewer");
  const before = t.pmRequests().length;
  await t.review();
  expect(await t.reviewRunNames()).toEqual(["reviewer", "vue-reviewer"]);
  expect(t.record().reviews.find((entry) => entry.agent === "go-reviewer")).toMatchObject({ outcome: "skipped", skipReason: "disabled" });
  for (const name of ["reviewer", "vue-reviewer"]) await t.release(name);
  await until(() => t.pmRequests().length > before);
  expect(lastText(t.pmRequests().at(-1))).toContain("go-reviewer 已关闭，本轮未审");
});

test("派之前删掉 acme-reviewer 定义文件：acme-reviewer 记为 skipped（missing），PM 收到的汇总含「acme-reviewer 已不存在，本轮未审」", async () => {
  const t = await reviewWorld();
  await t.define("acme-reviewer", "", "你是 acme-reviewer。", "reviewer");
  withDatabase(repositoryDatabase(t.fixture.dataRoot, t.fixture.repoId), (db) => {
    const row = db.read<TaskRecord>(TASKS, t.taskId)!;
    db.update(TASKS, t.taskId, row.version, { ...row.data, reviewers: [...(row.data.reviewers ?? []), { agent: "acme-reviewer", reason: "专项审查" }] });
  });
  await rm(join(t.userDir, "acme-reviewer.md"));
  const before = t.pmRequests().length;
  await t.review();
  expect(await t.reviewRunNames()).toEqual(["go-reviewer", "reviewer", "vue-reviewer"]);
  expect(t.record().reviews.find((entry) => entry.agent === "acme-reviewer")).toMatchObject({ outcome: "skipped", skipReason: "missing" });
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
  await until(() => t.pmRequests().length > before);
  expect(lastText(t.pmRequests().at(-1))).toContain("acme-reviewer 已不存在，本轮未审");
});

test("通用 reviewer 的模型不可用：整次派审查被拒，没有新运行记录，任务审查记录不变", async () => {
  const t = await reviewWorld();
  await t.define("reviewer", "model: nowhere/none\n", "", "reviewer");
  const before = (await t.runStore.list({ limit: 100 })).items.length;
  await expect(t.review()).rejects.toMatchObject({ code: "model_unavailable" });
  expect((await t.runStore.list({ limit: 100 })).items.length).toBe(before);
  expect(t.record().reviews).toEqual([]);
  expect(t.record().status).toBe("awaiting_review");
});

test("只有两个审查结束时 PM 收不到审查消息；第三个结束后收到一条，按 reviewer、go-reviewer、vue-reviewer 分三段，每段有代理名、结论与 summary", async () => {
  const t = await reviewWorld();
  t.replies["vue-reviewer"] = verdict(SUMMARIES["vue-reviewer"], [{ kind: "unverified", trigger: "vue 触发" }]);
  const before = t.pmRequests().length;
  await t.review();
  await t.release("reviewer");
  await t.release("go-reviewer");
  await until(() => t.settled() === 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(t.pmRequests().length).toBe(before);
  await t.release("vue-reviewer");
  await until(() => t.pmRequests().length > before);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(t.pmRequests().length).toBe(before + 1);
  const message = lastText(t.pmRequests().at(-1));
  const start = (name: string) => message.search(new RegExp(`(?<![\\w-])${name}(?![\\w-])`));
  const order = ["reviewer", "go-reviewer", "vue-reviewer"];
  const conclusions = ["通过", "通过", "未验证"];
  order.forEach((name, index) => {
    const from = start(name);
    expect(from).toBeGreaterThanOrEqual(0);
    const segment = message.slice(from, index + 1 < order.length ? start(order[index + 1]!) : undefined);
    expect(segment).toContain(SUMMARIES[name as keyof typeof SUMMARIES]);
    expect(segment).toContain(conclusions[index]!);
  });
  expect(start("reviewer")).toBeLessThan(start("go-reviewer"));
  expect(start("go-reviewer")).toBeLessThan(start("vue-reviewer"));
});

test("go-reviewer 与 vue-reviewer 都打回，PM 派返修：worker 的任务说明里两条意见分别带「go-reviewer ·」「vue-reviewer ·」", async () => {
  const t = await reviewWorld();
  t.replies["go-reviewer"] = verdict(SUMMARIES["go-reviewer"], [{ kind: "blocking", trigger: "go 触发" }]);
  t.replies["vue-reviewer"] = verdict(SUMMARIES["vue-reviewer"], [{ kind: "unverified", trigger: "vue 触发" }]);
  await t.review();
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
  await until(() => t.record().status === "awaiting_rework");
  await t.manager.dispatchTask({ pmRunId: t.pm.runId, taskId: t.taskId, retry: null, rework: { reason: "按审查意见返修", maxTurns: 3 } });
  await until(() => t.requestOf("审查打回后的返修") !== undefined);
  const system = prompt(t.requestOf("审查打回后的返修"));
  expect(system).toContain("- [blocking] go-reviewer · prd:goal.login：go 触发 → 没有失败提示");
  expect(system).toContain("- [unverified] vue-reviewer · prd:goal.login：vue 触发 → 没有失败提示");
});

test("项目 .pi/skills 放了同名 skill 时，专项审查的系统提示词用项目那份而不是包内那份", async () => {
  const t = await reviewWorld();
  await t.define("go-reviewer", "skills: [go-pitfalls]\n", "你是 go-reviewer。", "reviewer");
  const projectSkills = join(t.fixture.repositoryRoot, ".pi", "skills");
  await mkdir(join(projectSkills, "go-pitfalls"), { recursive: true });
  await mkdir(join(t.skillDir, "go-pitfalls"), { recursive: true });
  await writeFile(join(projectSkills, "go-pitfalls", "SKILL.md"), "# Go 坑\nMARKER-PROJECT\n");
  await writeFile(join(t.skillDir, "go-pitfalls", "SKILL.md"), "# Go 坑\nMARKER-PACKAGE\n");
  t.options.skillDirs = [projectSkills, t.skillDir];
  await t.review();
  await until(() => t.requestOf("你是 go-reviewer。") !== undefined);
  expect(prompt(t.requestOf("你是 go-reviewer。"))).toContain("MARKER-PROJECT");
  expect(prompt(t.requestOf("你是 go-reviewer。"))).not.toContain("MARKER-PACKAGE");
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
});

test("agent_manage 工具描述写明带 review 派一次审查、程序同时派出通用和专项审查，以及用户明确指定的定义不可用或已关闭时的处理", () => {
  const { description } = agentManageTool({ alive: () => true, agents: {} } as unknown as PmToolsInput);
  expect(description).toContain("带 review 派一次审查，程序同时派出通用和专项审查");
  expect(description).toContain("返回本轮启动成功的审查运行编号");
  expect(description).toContain("用户明确指定的定义不可用或已关闭时");
});

test("A 整轮汇总按本轮还有没有审查在跑判断：三个审查在跑时任务被改成 needs_update，三个审查逐个结束后 PM 只收到一条汇总，且汇总不含 running", async () => {
  const t = await reviewWorld();
  const before = t.pmRequests().length;
  await t.review();
  t.patchTask({ status: "needs_update" });
  await t.release("reviewer");
  await until(() => t.settled() === 1);
  await t.release("go-reviewer");
  await until(() => t.settled() === 2);
  await t.settle();
  expect(t.pmRequests().length).toBe(before);
  await t.release("vue-reviewer");
  await until(() => t.pmRequests().length > before);
  await t.settle();
  expect(t.pmRequests().length).toBe(before + 1);
  const message = lastText(t.pmRequests().at(-1));
  for (const name of Object.keys(SUMMARIES)) expect(message).toContain(name);
  expect(message).not.toContain("running");
});

test("B 同一轮重派而要派的代理全被跳过：go-reviewer 没交结论后被关闭再派审查，不抛错，runIds 为空，任务完成，PM 收到含「go-reviewer 已关闭，本轮未审」的汇总", async () => {
  const t = await reviewWorld();
  t.replies["go-reviewer"] = { type: "text", text: "没有提交结论" };
  await t.review();
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
  await until(() => t.record().status === "awaiting_review");
  await t.settle();
  t.disabled.add("go-reviewer");
  const before = t.pmRequests().length;
  const result = await t.review();
  expect(result.runIds).toEqual([]);
  expect(t.record().status).toBe("completed");
  await until(() => t.pmRequests().length > before);
  await t.settle();
  expect(t.pmRequests().length).toBe(before + 1);
  expect(lastText(t.pmRequests().at(-1))).toContain("go-reviewer 已关闭，本轮未审");
});

test("C 部分会话创建失败：go-reviewer 创建失败时派审查不抛错，runIds 只含另外两个，go-reviewer 记为 failed，其余结束后 PM 收到一条含 go-reviewer 一段的汇总", async () => {
  const t = await reviewWorld();
  const create = t.runStore.create.bind(t.runStore);
  vi.spyOn(t.runStore, "create").mockImplementation(async (input) => {
    if (input.agent?.name === "go-reviewer") throw new Error("会话创建失败");
    return create(input);
  });
  const before = t.pmRequests().length;
  const result = await t.review();
  expect(result.runIds).toHaveLength(2);
  expect(result.failed).toEqual([{ agent: "go-reviewer", reason: expect.stringContaining("会话创建失败") }]);
  expect(t.record().reviews.find((entry) => entry.agent === "go-reviewer")).toMatchObject({ outcome: "failed" });
  for (const name of ["reviewer", "vue-reviewer"]) await t.release(name);
  await until(() => t.pmRequests().length > before);
  await t.settle();
  expect(t.pmRequests().length).toBe(before + 1);
  const message = lastText(t.pmRequests().at(-1));
  expect(message).toContain("go-reviewer");
  expect(message).toContain(SUMMARIES.reviewer);
  expect(message).toContain(SUMMARIES["vue-reviewer"]);
});

test("C 所有会话都创建失败：派审查不抛错，runIds 为空，任务不停在 reviewing，PM 收到一条汇总", async () => {
  const t = await reviewWorld();
  vi.spyOn(t.runStore, "create").mockRejectedValue(new Error("会话创建失败"));
  const before = t.pmRequests().length;
  const result = await t.review();
  expect(result.runIds).toEqual([]);
  expect(result.failed.map((entry) => entry.agent).sort()).toEqual(["go-reviewer", "reviewer", "vue-reviewer"]);
  for (const entry of result.failed) expect(entry.reason).toContain("会话创建失败");
  expect(t.record().status).not.toBe("reviewing");
  await until(() => t.pmRequests().length > before);
  await t.settle();
  expect(t.pmRequests().length).toBe(before + 1);
});

test("D 专项审查遇到 disabled、missing 以外的解析错误（go-reviewer 模型不可用）：整次派审查被拒，没有新运行记录，任务审查记录不变", async () => {
  const t = await reviewWorld();
  await t.define("go-reviewer", "model: nowhere/none\n", "你是 go-reviewer。", "reviewer");
  const before = (await t.runStore.list({ limit: 100 })).items.length;
  await expect(t.review()).rejects.toMatchObject({ code: "model_unavailable" });
  expect((await t.runStore.list({ limit: 100 })).items.length).toBe(before);
  expect(t.record().reviews).toEqual([]);
  expect(t.record().status).toBe("awaiting_review");
});

test("E 正常派审查的返回值：runIds 含本轮启动的三个运行编号，maxTurns 是给的轮数上限 12", async () => {
  const t = await reviewWorld();
  const result = await t.review();
  expect([...result.runIds].sort()).toEqual(await t.reviewRunIds());
  expect(result.runIds).toHaveLength(3);
  expect(result.maxTurns).toBe(12);
  expect(result.failed).toEqual([]);
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
});

test("派 worker 时运行记录写入任务的轮数上限 maxTurns", async () => {
  const w = await world();
  await w.plan.execute({ action: "propose", tasks: [spec("plain", { goalUnitIds: ["goal.login", "scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "开工" }, { type: "text", text: "PM 收到" });
  const dispatched = await w.dispatch("plain");
  const run = await w.runStore.get(dispatched.runId);
  expect(run.ok && (run.run as { maxTurns?: number }).maxTurns).toBe(3);
});

test("派审查时每个审查代理的运行记录都写入派工的轮数上限 maxTurns", async () => {
  const t = await reviewWorld();
  const { runIds } = await t.review();
  expect(runIds).toHaveLength(3);
  for (const runId of runIds) {
    const run = await t.runStore.get(runId);
    expect(run.ok && (run.run as { maxTurns?: number }).maxTurns).toBe(12);
  }
  for (const name of Object.keys(SUMMARIES)) await t.release(name);
});
