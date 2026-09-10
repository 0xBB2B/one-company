import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { RunManager } from "../../daemon/run-manager.ts";
import { RelayQueue } from "../../daemon/relay-queue.ts";
import { createClock } from "../../runtime/clock.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { repositoryDatabase, UUID_V7_PATTERN, uuidv7, withDatabase } from "../../runtime/database.ts";
import { appendDecision, readDecisions } from "../../runtime/decisions.ts";
import { collectGitSnapshot } from "../../runtime/git-snapshot.ts";
import { NetworkPauseGate } from "../../runtime/network-pause.ts";
import { defaultRoleDir, loadRoleCatalog } from "../../runtime/roles.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { openSessionManagerForRun } from "../../runtime/session-records.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { readRequirementState } from "../../runtime/workflow-state.ts";
import { executeWorkflowAction } from "../../runtime/workflow-tool.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { createRepoFixture, removeRepoFixture, GIT_ENV } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const tool = (name: string, input: Record<string, unknown>): ScriptedReply => ({ type: "toolcall", name, input });
const text = (value: string): ScriptedReply => ({ type: "text", text: value });

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`完整工作流等待超时: ${JSON.stringify(value)}`);
}

test("默认完整工作流：规划真文件、用户确认、合法提交、独立复跑、白盒审查、真实验收报告和自动结束", async () => {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const requirement = "2026-09-10.complete-workflow";
  const reqDir = join(repo.root, ".pi-company/requirements", requirement);
  const taskDir = join(reqDir, "tasks");
  const reportPath = join(reqDir, "acceptance.md");
  await mkdir(join(repo.root, ".pi-company/spec/demo"), { recursive: true });
  await mkdir(reqDir, { recursive: true });
  const rules = "- C-1：调用命令时输出 hello。\n\n### AC-1 输出问候 ← C-1\n- 触发: 操作 调用命令\n- Given: 应用可运行\n- When: 调用问候命令\n- Then: 输出 hello\n";
  await writeFile(join(repo.root, ".pi-company/spec/demo/greeting.md"), `---\nname: greeting\ndescription: 命令输出问候\n---\n# 问候\n\n## 目的\n输出可验证的问候。\n\n## 逻辑\n读取命令输出。\n\n## 约束\n${rules.split("\n\n###")[0]}\n\n## 例子\n执行命令得到 hello。\n\n## 验收\n###${rules.split("\n\n###")[1]}`);
  await writeFile(join(repo.root, ".pi-company/spec/INDEX.md"), "- [demo/greeting](demo/greeting.md) — 命令输出问候\n");
  await writeFile(join(reqDir, "requirements.md"), "---\nname: complete-workflow\ntitle: 输出问候\ncreated: 2026-09-10\n---\n# 输出问候\n\n## 1. 背景\n命令缺少问候。\n\n## 2. 目标与非目标\n### 非目标\n- 不提供网络服务。\n### 目标\n- 输出 1 行 hello。\n\n## 3. 规范变更\n| 规范 | 变更 | 说明 |\n|---|---|---|\n| demo/greeting | 新增 | 输出问候 |\n\n## 4. 边界与已知坑\n- 退出码为 0。\n");
  await writeFile(join(repo.root, "app.js"), 'console.log("old");\n');
  await writeFile(join(repo.root, "package.json"), '{"type":"commonjs"}\n');
  await exec("git", ["add", "."], { cwd: repo.root, env: GIT_ENV });
  await exec("git", ["commit", "-m", "准备需求定义"], { cwd: repo.root, env: GIT_ENV });

  await exec("git", ["config", "user.name", "Test"], { cwd: repo.root, env: GIT_ENV });
  await exec("git", ["config", "user.email", "test@example.test"], { cwd: repo.root, env: GIT_ENV });
  const { repoId } = await repositoryIdentity(repo.root);
  const ctx = { dataRoot: home.dataRoot, cwd: repo.root, requirement };
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const store = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "default-workflow" });
  const shells = new ShellRegistry({ clock, database: repositoryDatabase(home.dataRoot, repoId) });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(home.home, "models.json"), refreshOnCreate: false });
  const providers = Object.fromEntries(["requirement-agent", "planner", "worker", "reviewer", "acceptance"].map((name) => [name, registerControlledProvider(runtime, { providerId: `full-${name}`, modelId: "test" })]));
  const shift = providers["requirement-agent"]!.queue.shift.bind(providers["requirement-agent"]!.queue);
  providers["requirement-agent"]!.queue.shift = () => shift() ?? text("等待补充");
  const catalog = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir: join(home.agentDir, "agents"), projectDir: join(repo.root, ".pi/agents"), projectTrusted: false, parseFrontmatter });
  let manager: RunManager;
  const relay = new RelayQueue({ dataDir: join(home.dataRoot, "repos", repoId), deliver: async () => [], locateRequirementAgent: (req) => manager.locateRequirementAgent(req) });
  manager = new RunManager({ dataRoot: home.dataRoot, repoId, runStore: store, shellRegistry: shells, networkGate: new NetworkPauseGate(), relayQueue: relay, roleCatalog: catalog.roles, runtime, selectModel: ({ roleName }) => ({ provider: providers[roleName]!.providerId, id: "test" }), clock, workspaceRepoIds: [repoId], emit: () => {} });
  manager.markStarted(); cleanup.push(() => manager.close());
  expect((await executeWorkflowAction({ action: "init", requirement }, ctx)).ok).toBe(true);
  const decision = await appendDecision({ requirement, actor: "user", source: "主会话", trigger: "确认需求", decision: "实现问候命令", effects: ["scope"], alternatives: [], impact: "新增输出" }, ctx);
  expect((await executeWorkflowAction({ action: "advance", requirement, stage: "confirmed", version: 1, decisionId: decision.decisionId }, ctx)).ok).toBe(true);
  scriptReplies(providers["requirement-agent"]!, [text("等待测试编排")]);
  const parent = await manager.dispatchRequirement({ requirement, cwd: repo.root });
  const messages = () => {
    const opened = openSessionManagerForRun({ dataRoot: home.dataRoot, repoId, runId: parent.runId });
    if (!opened.ok) throw new Error(opened.detail);
    return opened.manager.getEntries().filter((entry) => entry.type === "message").map((entry) => entry.message);
  };
  await until(async () => JSON.stringify(messages()), (value) => value.includes("等待测试编排"));
  let step = 0;
  async function invoke(reply: ScriptedReply, answerShape = false) {
    const marker = `步骤完成-${++step}`;
    scriptReplies(providers["requirement-agent"]!, [reply, text(marker)]);
    manager.locateRequirementAgent(requirement)!.inject(`继续步骤 ${step}`);
    if (answerShape) {
      const pending = await until(() => relay.pendingFor({ windowId: "test", repoIds: [repoId] }), (value) => value.questions.length > 0);
      expect((await relay.answer(pending.questions[0]!.id, "确认", uuidv7())).ok).toBe(true);
    }
    await until(async () => JSON.stringify(messages()), (value) => value.includes(marker));
    const failures = messages().filter((message) => message.role === "toolResult" && message.isError);
    expect(failures).toEqual([]);
  }
  async function workflow(action: string, fields: Record<string, unknown> = {}) {
    const state = await readRequirementState(ctx);
    if (!state.exists) throw new Error("需求丢失");
    await invoke(tool("pi_company_workflow", { action, version: state.version, ...fields }));
  }
  async function roleRun(role: string, task: string, writePaths: string[]) {
    await invoke(tool("pi_company_agent", { action: "run", role, task, writePaths }));
    const runs = await until(() => store.list({ requirement, kind: "role", limit: 100 }), (value) => value.items.some((run) => run.role === `pi-company.${role}` && ["completed", "failed"].includes(run.state)));
    const run = runs.items.find((run) => run.role === `pi-company.${role}`)!;
    expect({ state: run.state, reason: run.stateReason }).toEqual({ state: "completed", reason: "" });
    return run;
  }

  await invoke(tool("decision_record", { requirement, actor: "ai", source: "需求代理", trigger: "规划前检", decision: "单一命令切片可验证", effects: ["planning-preflight"], scope: "本需求", basis: ["现有命令输出 old"], action: "规划一个任务", alternatives: [] }));
  const verify = "node verify.cjs";
  const taskBody = `---\nid: T-1\ntitle: 输出问候\ndepends_on: []\nfiles: [${join(repo.root, "app.js")}]\nrefs: [demo/greeting/AC-1]\nverify: ${verify}\n---\n# 输出问候\n\n## 目标\n命令输出 hello。\n\n## 业务规则\n来源：demo/greeting。\n${rules}\n## 涉及文件\n- 修改（生产）：${join(repo.root, "app.js")} — 输出问候\n- 新建（测试）：${join(repo.root, "verify.cjs")} — 验证输出\n\n## 函数清单\n- app.js：main — 输出问候\n\n## 协作关系\n测试调用命令，无外部依赖。\n\n## 验证方式\n- 真实入口：node app.js\n- 必须成立：输出 hello\n- 场景：正常输出，错误输出拒绝；无并发与外部服务\n- 模拟边界：仅模型响应受控，命令真实执行\n- 三层责任：目标测试 node verify.cjs；回归同命令；集成由本测试完成\n`;
  scriptReplies(providers.planner!, [tool("write", { path: join(taskDir, "T-1.md"), content: taskBody }), tool("write", { path: join(taskDir, "INDEX.md"), content: "# 任务\n- [T-1 输出问候](T-1.md) — 单一命令切片\n" }), text("规划完成")]);
  const plan = await roleRun("planner", "T-1", [taskDir + "/"]);
  await workflow("advance", { stage: "planned", runId: plan.id });
  await invoke(tool("pi_company_propose_shape", { tasks: [{ id: "T-1", title: "输出问候", roles: ["worker", "reviewer", "acceptance"], dependsOn: [], writePaths: ["app.js", "verify.cjs"] }], gates: { whiteboxReview: true, blackboxAcceptance: true }, rationale: "一个切片，默认双阶段检查" }), true);
  await workflow("advance", { stage: "executing" });
  const check = 'const {execFileSync}=require("node:child_process");require("node:assert/strict").equal(execFileSync(process.execPath,["app.js"],{encoding:"utf8"}),"hello\\n");\n';
  const work = { phase: "work", verdict: "PASS", summary: "输出 hello", issues: [], evidence: ["verify.cjs:1"], changeKind: "behavior-change", workState: "red-green", coverage: [{ ref: "demo/greeting/AC-1", test: "verify.cjs:1" }], redCommands: [{ command: verify, status: "failed", details: "old 不等于 hello" }], greenCommands: [{ command: verify, status: "passed", details: "输出匹配" }], changedFiles: ["app.js", "verify.cjs"], productionPath: ["app.js"], preexistingEvidence: [], fakeRed: false };
  scriptReplies(providers.worker!, [tool("write", { path: "verify.cjs", content: check }), tool("bash", { command: verify }), tool("write", { path: "app.js", content: 'console.log("hello");\n' }), tool("bash", { command: verify }), tool("pi_company_git_commit", { paths: ["app.js", "verify.cjs"], message: "实现问候" }), tool("structured_output", work), text("完成")]);
  const worker = await roleRun("worker", "T-1", ["app.js", "verify.cjs"]);
  const workerSession = openSessionManagerForRun({ dataRoot: home.dataRoot, repoId, runId: worker.id });
  if (!workerSession.ok) throw new Error(workerSession.detail);
  const workerErrors = workerSession.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError);
  expect(workerErrors.slice(1)).toEqual([]);
  await workflow("task-start", { task: "T-1", runId: worker.id });
  await workflow("task-finish", { task: "T-1", runId: worker.id });
  const verified = await store.get(worker.id);
  expect(verified.ok && (verified.run.result as { delivery: { verificationOk: boolean } }).delivery.verificationOk).toBe(true);
  await workflow("advance", { stage: "reviewing" });
  const snapshot = await collectGitSnapshot({ repoRoot: repo.root });
  scriptReplies(providers.reviewer!, [tool("read", { path: "app.js" }), tool("bash", { command: verify }), tool("structured_output", { phase: "review", verdict: "PASS", summary: "真实命令通过", issues: [], evidence: ["verify.cjs:1"], reviewedHead: snapshot.head, contentFingerprint: snapshot.fingerprint, traceability: [{ ref: "demo/greeting/AC-1", test: "verify.cjs:1", implementation: "app.js:1" }], findings: [] }), text("完成")]);
  const reviewer = await roleRun("reviewer", "T-1", []);
  await workflow("advance", { stage: "accepting", runId: reviewer.id });
  const report = "---\ndate: 2026-09-10\nresult: accepted\n---\n## 验收结果\n| AC-1 | PASS | 输出 hello | |\n## 所用命令\nnode app.js\n";
  scriptReplies(providers.acceptance!, [tool("bash", { command: "node app.js" }), tool("write", { path: reportPath, content: report }), tool("structured_output", { phase: "acceptance", verdict: "PASS", summary: "命令验收通过", issues: [], evidence: ["实际命令输出"], acceptanceResult: "accepted", reportPath, items: [{ id: "AC-1", result: "PASS", observed: "输出 hello", difference: "" }], uncovered: [] }), text("完成")]);
  const acceptance = await roleRun("acceptance", "T-1", []);
  const state = await readRequirementState(ctx); if (!state.exists) throw new Error("需求丢失");
  scriptReplies(providers["requirement-agent"]!, [tool("pi_company_workflow", { action: "advance", stage: "accepted", runId: acceptance.id, version: state.version }), text("需求完成")]);
  manager.locateRequirementAgent(requirement)!.inject("完成验收推进");
  const ended = await until(() => store.get(parent.runId), (value) => value.ok && ["completed", "failed"].includes(value.run.state));
  expect(ended.ok && ended.run.state).toBe("completed");
  const finalState = await readRequirementState(ctx);
  expect(finalState.exists && finalState.data.stage).toBe("accepted");
  expect(await readFile(reportPath, "utf8")).toBe(report);
  expect((await readDecisions({ ...ctx, actor: "ai" })).length).toBeGreaterThan(0);
  withDatabase(repositoryDatabase(home.dataRoot, repoId), (db) => {
    for (const namespace of ["requirements", "runs", "sessions", "shells", `evidence:${requirement}`]) {
      for (const record of db.list(namespace)) expect(UUID_V7_PATTERN.test(record.id)).toBe(true);
    }
  });
}, 60000);
