import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createRequirementAgentSession } from "../daemon/requirement-agent.ts";
import { createClock } from "../runtime/clock.ts";
import { appendDecision, readDecisions } from "../runtime/decisions.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { defaultRoleDir, readRoleDefinition, type RoleCatalogEntry } from "../runtime/roles.ts";
import { RunStore, type RunState } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { readRecord, writeRecord, repositoryDatabase } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { currentVersion, executeWorkflowAction } from "../runtime/workflow-tool.ts";
import { registerControlledProvider, scriptReplies, type ControlledProvider } from "./helpers/controlled-provider.ts";
import { buildInlineRoleCatalogEntry, createPassthroughGuards, writeRoleEntry } from "./helpers/role-fixture.ts";
import { createRepoFixture, removeRepoFixture, type RepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome, type TempHome } from "./helpers/temp-home.ts";
import { createFakeTimeSource, withClockPump, withTimeout } from "./helpers/fake-clock.ts";

// 覆盖用真实需求代理正文里的一段独有文本，用它在系统提示里定位角色正文的插入位置，
// 不必为测试再自造一份角色定义
const REQUIREMENT_AGENT_BODY_MARKER = "## 身份与前提";

const tempRoots: string[] = [];
const tempHomes: TempHome[] = [];
const repoFixtures: RepoFixture[] = [];
const handles: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      handle.dispose();
    } catch {
      // 清理阶段的 dispose 失败不应掩盖用例本身的断言结果
    }
  }
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createRuntime(): Promise<ModelRuntime> {
  const modelsDir = await mkdtemp(join(tmpdir(), "requirement-agent-models-"));
  tempRoots.push(modelsDir);
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(modelsDir, "models.json"),
    refreshOnCreate: false,
  });
}

async function loadDefaultRequirementAgentRole(): Promise<RoleCatalogEntry> {
  const path = join(defaultRoleDir(), "requirement-agent.md");
  const definition = await readRoleDefinition(path, parseFrontmatter);
  return { name: "requirement-agent", source: "default", path, available: true, definition };
}

interface DispatchCall {
  role: string;
  task: string;
  instructions?: string;
  writePaths: string[];
  readPaths: string[];
}

function createDispatchFake() {
  const calls: DispatchCall[] = [];
  let seq = 0;
  const dispatch = {
    async dispatchRole(input: DispatchCall) {
      calls.push(input);
      seq += 1;
      return { ok: true as const, runId: `dispatched-run-${seq}` };
    },
    async status() {
      return { ok: true as const, state: "running" };
    },
    async wait() {
      return { ok: true as const, state: "completed" };
    },
    async list() {
      return [] as Array<{ runId: string; role: string; task: string; state: string }>;
    },
    async cancel() {
      return { ok: true as const };
    },
  };
  return { dispatch, calls };
}

interface PendingQuestion {
  input: { question: string; options?: Array<{ label: string; description: string }>; recommended?: string; repoId?: string; requirement?: string };
  aborted: boolean;
  resolve(answer: string): void;
}

function createRelayFake() {
  const pending: PendingQuestion[] = [];
  const relay = {
    ask(input: PendingQuestion["input"], opts?: { signal?: AbortSignal }): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const entry: PendingQuestion = { input, aborted: false, resolve: (answer: string) => resolve(answer) };
        opts?.signal?.addEventListener("abort", () => {
          entry.aborted = true;
          reject(new Error("提问已撤回"));
        });
        pending.push(entry);
      });
    },
  };
  return { relay, pending };
}

interface World {
  home: TempHome;
  repo: RepoFixture;
  repoId: string;
  requirement: string;
  runtime: ModelRuntime;
  provider: ControlledProvider;
  role: RoleCatalogEntry;
  roleCatalog: RoleCatalogEntry[];
  runStore: RunStore;
  workspaceRepoIds: string[];
  dispatch: ReturnType<typeof createDispatchFake>["dispatch"];
  dispatchCalls: DispatchCall[];
  relay: ReturnType<typeof createRelayFake>["relay"];
  pending: PendingQuestion[];
}

function freshRequirementId(): string {
  return `2026-09-09.${randomUUID().slice(0, 8)}`;
}

const COMPLETED_STATES: RunState[] = ["completed"];

// runStore.update 只拦截第一次把该运行置为 waiting_answer 的调用，模拟运行记录更新失败；
// 随后的调用（含之后的正常提问）照常委派给真实 RunStore
function createUpdateOnceFailingRunStore(real: RunStore) {
  let shouldFailNextWaitingAnswerUpdate = true;
  return {
    create: real.create.bind(real),
    createOrReuseRequirement: real.createOrReuseRequirement.bind(real),
    get: real.get.bind(real),
    list: real.list.bind(real),
    markInterruptedOnStartup: real.markInterruptedOnStartup.bind(real),
    markOwnRunsInterrupted: real.markOwnRunsInterrupted.bind(real),
    async update(id: string, fields: Record<string, unknown>) {
      if (fields.state === "waiting_answer" && shouldFailNextWaitingAnswerUpdate) {
        shouldFailNextWaitingAnswerUpdate = false;
        throw new Error("模拟运行记录更新失败");
      }
      return real.update(id, fields as Parameters<RunStore["update"]>[1]);
    },
  };
}

// 不监听 signal，模拟一个对取消不合作的中继：ask() 永不 settle
function createUncooperativeRelayFake() {
  const pending: Array<{ input: unknown }> = [];
  const relay = {
    ask(input: unknown): Promise<string> {
      pending.push({ input });
      return new Promise<string>(() => {});
    },
  };
  return { relay, pending };
}

async function waitForPidFile(pidFile: string, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = (await readFile(pidFile, "utf8")).trim();
      if (content) return Number(content);
    } catch {
      // pidFile 尚未写入
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`超时等待 pid 文件写入: ${pidFile}`);
}

async function waitForProcessGone(pgid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`进程组 ${pgid} 在 ${timeoutMs}ms 内未消失`);
}

async function setupWorld(label: string): Promise<World> {
  const home = await createTempHome();
  tempHomes.push(home);
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  const identity = await repositoryIdentity(repo.root);
  const runtime = await createRuntime();
  const provider = registerControlledProvider(runtime, { providerId: `requirement-agent-${label}`, modelId: "controlled-model" });
  const role = await loadDefaultRequirementAgentRole();
  const worker = await writeRoleEntry({ name: "catalogrole9x2", kind: "work", tools: ["read", "write", "bash"] }, tempRoots);
  const reviewer = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "bash"] }, tempRoots);
  const { dispatch, calls } = createDispatchFake();
  const { relay, pending } = createRelayFake();
  const runStore = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: randomUUID() });
  return {
    home,
    repo,
    repoId: identity.repoId,
    requirement: freshRequirementId(),
    runtime,
    provider,
    role,
    roleCatalog: [worker, reviewer],
    runStore,
    workspaceRepoIds: [identity.repoId],
    dispatch,
    dispatchCalls: calls,
    relay,
    pending,
  };
}

function sessionOptions(world: World, overrides: Record<string, unknown> = {}) {
  return {
    dataRoot: world.home.dataRoot,
    repoId: world.repoId,
    requirement: world.requirement,
    cwd: world.repo.root,
    role: world.role,
    roleCatalog: world.roleCatalog,
    runtime: world.runtime,
    modelRef: { provider: world.provider.providerId, id: world.provider.modelId },
    clock: createClock(),
    shellRegistry: new ShellRegistry({ clock: createClock() }),
    guards: createPassthroughGuards(),
    networkGate: new NetworkPauseGate(),
    dispatch: world.dispatch,
    relay: world.relay,
    runStore: world.runStore,
    workspaceRepoIds: world.workspaceRepoIds,
    ...overrides,
  };
}

function collect(handle: any, type: string): unknown[] {
  const events: unknown[] = [];
  handle.events.on(type, (event: unknown) => events.push(event));
  return events;
}

// 同一 handle 的 tool_end 事件流跨越多个阶段（形状提议、多轮派工…）；一次会话内先后发生的
// 多个动作共用同一条流时，前一阶段的收尾事件可能在下一次 collect 注册后才真正触发，
// 按 toolName 过滤能避免把它错当成这一阶段第一条结果
function collectToolEnds(handle: any, toolName: string): Array<{ toolCallId?: string; toolName?: string; isError?: boolean }> {
  const events: Array<{ toolCallId?: string; toolName?: string; isError?: boolean }> = [];
  handle.events.on("tool_end", (event: { toolName?: string }) => {
    if (event.toolName === toolName) events.push(event as { toolCallId?: string; toolName?: string; isError?: boolean });
  });
  return events;
}

async function waitForCount(getLength: () => number, min: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (getLength() < min) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时等待数量达到 ${min}，当前 ${getLength()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 10000, message = "超时等待条件成立"): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function decisionInput(requirement: string, overrides: Record<string, unknown> = {}) {
  return {
    requirement,
    actor: "user" as const,
    source: "test-client",
    trigger: "确认",
    decision: "确认",
    alternatives: [],
    effects: ["scope"],
    impact: "无重大影响",
    ...overrides,
  };
}

async function queryState(dataRoot: string, cwd: string, requirement: string) {
  return executeWorkflowAction({ action: "query", requirement }, { dataRoot, cwd });
}

async function confirmRequirement(world: World, requirement: string = world.requirement): Promise<void> {
  const ctx = { dataRoot: world.home.dataRoot, cwd: world.repo.root };
  await executeWorkflowAction({ action: "init", requirement }, ctx);
  const decision = await appendDecision(decisionInput(requirement, { trigger: "确认需求", decision: "确认需求文档" }), ctx);
  const state = await queryState(world.home.dataRoot, world.repo.root, requirement);
  const result = await executeWorkflowAction(
    { action: "advance", requirement, stage: "confirmed", decisionId: decision.decisionId, version: state.details.version as number },
    ctx,
  );
  if (result.details.isError) throw new Error(`测试装置失败: 需求确认未成功: ${result.text}`);
}

async function forceStage(dataRoot: string, repoId: string, requirement: string, stage: string): Promise<void> {
  const path = requirementStateRef(dataRoot, repoId, requirement);
  const current = await readRecord(path);
  if (!current.exists) throw new Error("测试装置失败: 需求状态不存在");
  await writeRecord(path, { ...(current.data as Record<string, unknown>), stage }, { expectedVersion: current.version });
}

async function waitForShapeRecorded(world: World): Promise<void> {
  await waitForCondition(async () => {
    const state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    return !state.details.isError && (state.details.data as { shape: unknown }).shape !== null;
  }, 10000, "超时等待形状写入需求状态");
}

async function proposeAndConfirmShape(world: World, handle: any, shapePayload: Record<string, unknown>, answer = "确认"): Promise<void> {
  const requestCountBeforePropose = world.provider.requests.length;
  scriptReplies(world.provider, [
    { type: "toolcall", name: "pi_company_propose_shape", input: shapePayload },
    { type: "text", text: "已提议形状" },
  ]);
  handle.prompt("请规划并提议形状");
  await waitForCount(() => world.pending.length, 1);
  const question = world.pending.shift();
  if (!question) throw new Error("测试装置失败: 未捕获到形状确认提问");
  question.resolve(answer);
  await waitForShapeRecorded(world);
  // 只等外部状态写入不够：确认后"已提议形状"这一轮文字回合要真实再发一次模型请求才算落定，
  // 调用方若紧接着追加下一条 prompt，这一轮请求有时还没真正发出，
  // 后续断言看到的"最后一条请求"其实还是这一轮尚未完成前的旧请求
  await waitForCondition(
    () => world.provider.requests.length >= requestCountBeforePropose + 2,
    10000,
    "超时等待形状确认后的模型回合真正发出请求",
  );
}

describe("派出前提、唯一性与并发", () => {
  test("draft、rejected、accepted 阶段的需求均拒绝派出，confirmed 及之后放行", async () => {
    const world = await setupWorld("stage-gate");

    const draftReq = freshRequirementId();
    const draftResult = await createRequirementAgentSession(sessionOptions(world, { requirement: draftReq }));
    expect(draftResult.ok).toBe(false);

    const rejectedReq = freshRequirementId();
    await confirmRequirement(world, rejectedReq);
    const rejectDecision = await appendDecision(decisionInput(rejectedReq, { trigger: "裁决拒绝", decision: "拒绝需求" }), {
      dataRoot: world.home.dataRoot,
      cwd: world.repo.root,
    });
    const rejectState = await queryState(world.home.dataRoot, world.repo.root, rejectedReq);
    await executeWorkflowAction(
      { action: "reject", requirement: rejectedReq, decisionId: rejectDecision.decisionId, version: rejectState.details.version as number },
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    const rejectedResult = await createRequirementAgentSession(sessionOptions(world, { requirement: rejectedReq }));
    expect(rejectedResult.ok).toBe(false);

    const acceptedReq = freshRequirementId();
    await executeWorkflowAction({ action: "init", requirement: acceptedReq }, { dataRoot: world.home.dataRoot, cwd: world.repo.root });
    await forceStage(world.home.dataRoot, world.repoId, acceptedReq, "accepted");
    const acceptedResult = await createRequirementAgentSession(sessionOptions(world, { requirement: acceptedReq }));
    expect(acceptedResult.ok).toBe(false);

    const confirmedReq = freshRequirementId();
    await confirmRequirement(world, confirmedReq);
    const confirmedResult = await createRequirementAgentSession(sessionOptions(world, { requirement: confirmedReq }));
    expect(confirmedResult.ok).toBe(true);
    if (confirmedResult.ok && !confirmedResult.reused) handles.push(confirmedResult.handle);
  }, 20000);

  test("已确认需求第一次派出成功绑定身份，第二次派出返回现有运行身份而不新建", async () => {
    const world = await setupWorld("unique");
    await confirmRequirement(world);

    const first = await createRequirementAgentSession(sessionOptions(world));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("测试装置失败: 首次派出未成功");
    expect(first.reused).toBe(false);
    expect(typeof first.runId).toBe("string");
    handles.push(first.handle);
    expect(first.handle.state()).toBe("running");

    const second = await createRequirementAgentSession(sessionOptions(world));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("测试装置失败: 第二次派出未成功");
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect((second as { handle?: unknown }).handle).toBeUndefined();

    const page = await world.runStore.list({ kind: "requirement", requirement: world.requirement, limit: 10 });
    expect(page.items.length).toBe(1);
  }, 20000);

  test("并发两次派出只创建一个需求运行，一个复用另一个的运行身份", async () => {
    const world = await setupWorld("concurrent");
    await confirmRequirement(world);

    const [a, b] = await Promise.all([
      createRequirementAgentSession(sessionOptions(world)),
      createRequirementAgentSession(sessionOptions(world)),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const results = [a, b] as Array<{ ok: true; reused: boolean; runId: string; handle?: any }>;
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    for (const r of results) if (!r.reused && r.handle) handles.push(r.handle);

    const page = await world.runStore.list({ kind: "requirement", requirement: world.requirement, limit: 10 });
    expect(page.items.length).toBe(1);
  }, 20000);

  test("会话创建失败（模型未注册）时运行记录标为 failed 而非停留在运行态", async () => {
    const world = await setupWorld("create-failure");
    await confirmRequirement(world);

    const result = await createRequirementAgentSession(
      sessionOptions(world, { modelRef: { provider: "missing-provider-xyz", id: "missing-model-xyz" } }),
    );

    expect(result.ok).toBe(false);
    const page = await world.runStore.list({ kind: "requirement", requirement: world.requirement, limit: 10 });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.state).toBe("failed");
  }, 20000);
});

describe("形状提议校验、确认与门禁决定、阶段推进", () => {
  test("决策记录目录不可写时形状未生效，执行未开始", async () => {
    const world = await setupWorld("undecidable");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const restore = failDatabaseWrites(repositoryDatabase(world.home.dataRoot, world.repoId), "events", "stream", `decisions:${world.requirement}:user`);
    const toolEnds = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    try {
      scriptReplies(world.provider, [
        {
          type: "toolcall",
          name: "pi_company_propose_shape",
          input: {
            tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
            gates: { whiteboxReview: true, blackboxAcceptance: true },
            rationale: "单任务直接实现",
          },
        },
        { type: "text", text: "已提议形状" },
      ]);
      created.handle.prompt("请规划并提议形状");
      await waitForCount(() => world.pending.length, 1);
      const question = world.pending.shift();
      if (!question) throw new Error("测试装置失败: 未捕获到形状确认提问");
      question.resolve("确认");
      await waitForCount(() => toolEnds.length, 1);
      expect(toolEnds[0]?.isError).toBe(true);
    } finally {
      restore();
    }

    const state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((state.details.data as { shape: unknown }).shape).toBeNull();
    expect(world.dispatchCalls.length).toBe(0);
  }, 20000);

  test("不可执行的形状在提议阶段被拒绝，且不发起确认提问", async () => {
    const world = await setupWorld("invalid-shape");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const validWrite = join(world.repo.root, "output.txt");
    const invalidShapes = [
      { tasks: [{ id: "TASK-1", title: "非法任务编号", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [validWrite] }], gates: { whiteboxReview: true, blackboxAcceptance: true }, rationale: "任务 id 不合法" },
      { tasks: [{ id: "T-1", title: "角色目录外", roles: ["ghost-role"], dependsOn: [], writePaths: [validWrite] }], gates: { whiteboxReview: true, blackboxAcceptance: true }, rationale: "角色不在目录内" },
      { tasks: [{ id: "T-1", title: "写入越出 cwd", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "..", "escape.txt")] }], gates: { whiteboxReview: true, blackboxAcceptance: true }, rationale: "写入路径越出 cwd" },
      {
        tasks: [{
          id: "T-1", title: "跨仓等待非成员仓库", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [validWrite],
          waitFor: { repo: randomUUID(), requirement: "2026-09-09.other", stage: "executing" },
        }],
        gates: { whiteboxReview: true, blackboxAcceptance: true },
        rationale: "等待非本工作区成员仓库",
      },
      {
        tasks: [{
          id: "T-1", title: "跨仓等待需求名非法", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [validWrite],
          waitFor: { repo: world.repoId, requirement: "../x", stage: "executing" },
        }],
        gates: { whiteboxReview: true, blackboxAcceptance: true },
        rationale: "等待的需求名格式非法",
      },
    ];

    const toolEnds = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      ...invalidShapes.map((shape) => ({ type: "toolcall" as const, name: "pi_company_propose_shape", input: shape })),
      { type: "text", text: "已尝试提议" },
    ]);
    created.handle.prompt("请规划并提议形状");
    await waitForCount(() => toolEnds.length, invalidShapes.length);

    for (const toolEnd of toolEnds) expect(toolEnd.isError).toBe(true);
    expect(world.pending.length).toBe(0);
    const state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((state.details.data as { shape: unknown }).shape).toBeNull();
  }, 20000);

  test("非选项文本回答形状确认提问不构成确认，形状不生效", async () => {
    const world = await setupWorld("non-option-answer");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const toolEnds = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_propose_shape",
        input: {
          tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
          gates: { whiteboxReview: true, blackboxAcceptance: true },
          rationale: "单任务直接实现",
        },
      },
      { type: "text", text: "已提议形状" },
    ]);
    created.handle.prompt("请规划并提议形状");
    await waitForCount(() => world.pending.length, 1);
    const question = world.pending.shift();
    if (!question) throw new Error("测试装置失败: 未捕获到形状确认提问");
    question.resolve("确认执行");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    const state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((state.details.data as { shape: unknown }).shape).toBeNull();
  }, 20000);

  test("选项确认后形状生效并可推进到 executing，规划子运行证据与确认文案符合预期", async () => {
    const world = await setupWorld("shape-confirm-full");
    await confirmRequirement(world);

    const otherRepo = await createRepoFixture();
    repoFixtures.push(otherRepo);
    const otherIdentity = await repositoryIdentity(otherRepo.root);
    world.workspaceRepoIds.push(otherIdentity.repoId);

    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const taskWrite = join(world.repo.root, "output.txt");
    const otherRequirement = freshRequirementId();
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_propose_shape",
        input: {
          tasks: [{
            id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [taskWrite],
            waitFor: { repo: otherIdentity.repoId, requirement: otherRequirement, stage: "executing" },
          }],
          gates: { whiteboxReview: true, blackboxAcceptance: true },
          rationale: "单任务直接实现",
        },
      },
      { type: "text", text: "已提议形状" },
    ]);
    created.handle.prompt("请规划并提议形状");
    await waitForCount(() => world.pending.length, 1);
    const question = world.pending.shift();
    if (!question) throw new Error("测试装置失败: 未捕获到形状确认提问");
    expect(question.input.repoId).toBe(world.repoId);
    expect(question.input.requirement).toBe(world.requirement);
    const labels = (question.input.options ?? []).map((option) => option.label);
    expect(labels).toContain("确认");
    expect(labels).toContain("重新提议");
    const confirmationText = JSON.stringify(question.input);
    expect(confirmationText).toContain(taskWrite);
    expect(confirmationText).toContain(otherIdentity.repoId);
    expect(confirmationText).toContain("executing");

    question.resolve("确认");
    await waitForShapeRecorded(world);

    const planRuns = await world.runStore.list({ kind: "role", requirement: world.requirement, states: COMPLETED_STATES, limit: 20 });
    const planRun = planRuns.items.find((run) => run.task === "plan");
    if (!planRun) throw new Error("测试装置失败: 未找到已完成的规划子运行");
    // 确认成功后紧接的一轮模型请求里，propose_shape 工具的回执文本应携带规划子运行编号
    expect(JSON.stringify(world.provider.requests[world.provider.requests.length - 1])).toContain(planRun.id);
    expect(planRun.role?.startsWith("pi-company.")).toBe(true);
    expect(planRun.role).toContain("requirement-agent");
    expect(planRun.parentRunId).toBe(created.runId);
    const planResult = planRun.result as {
      phase?: string;
      verdict?: string;
      binding?: { requirement?: string; definitionFingerprint?: string; codeHead?: string };
    };
    expect(planResult.phase).toBe("plan");
    expect(planResult.verdict).toBe("PASS");
    const expectedVersion = await currentVersion({ cwd: world.repo.root, requirement: world.requirement });
    expect(planResult.binding?.requirement).toBe(world.requirement);
    expect(planResult.binding?.definitionFingerprint).toBe(expectedVersion.definitionFingerprint);
    expect(planResult.binding?.codeHead).toBe(expectedVersion.codeHead);

    let state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const planned = await executeWorkflowAction(
      { action: "advance", requirement: world.requirement, stage: "planned", runId: planRun.id, version: state.details.version as number },
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    expect(planned.details.isError).toBeFalsy();
    state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const executing = await executeWorkflowAction(
      { action: "advance", requirement: world.requirement, stage: "executing", version: state.details.version as number },
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    expect(executing.details.isError).toBeFalsy();
  }, 20000);

  test("端到端：模型从形状确认回执提取规划运行编号并据此推进到 executing（不依赖 runStore.list）", async () => {
    const world = await setupWorld("shape-confirm-e2e");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });

    const confirmedRequest = world.provider.requests[world.provider.requests.length - 1] as { messages: unknown[] };
    const lastMessageText = JSON.stringify(confirmedRequest.messages[confirmedRequest.messages.length - 1]);
    const runIdMatch = lastMessageText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!runIdMatch) throw new Error("测试装置失败: 确认回执文本中未找到规划运行编号");
    const planRunId = runIdMatch[0];

    let state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const toolEndsPlanned = collectToolEnds(created.handle, "pi_company_workflow");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_workflow", input: { action: "advance", requirement: world.requirement, stage: "planned", runId: planRunId, version: state.details.version } },
      { type: "text", text: "已推进到 planned" },
    ]);
    created.handle.prompt("请依据形状确认回执里的运行编号把需求推进到 planned");
    await waitForCount(() => toolEndsPlanned.length, 1);
    expect(toolEndsPlanned[0]?.isError).toBeFalsy();

    state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const toolEndsExecuting = collectToolEnds(created.handle, "pi_company_workflow");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_workflow", input: { action: "advance", requirement: world.requirement, stage: "executing", version: state.details.version } },
      { type: "text", text: "已推进到 executing" },
    ]);
    created.handle.prompt("请继续推进到 executing");
    await waitForCount(() => toolEndsExecuting.length, 1);
    expect(toolEndsExecuting[0]?.isError).toBeFalsy();

    const finalState = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((finalState.details.data as { stage: string }).stage).toBe("executing");
  }, 20000);
});

describe("形状与目录约束派工", () => {
  test("形状外角色与角色目录外角色的派工均被拒绝，形状内角色派工成功", async () => {
    const world = await setupWorld("role-bounds");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const taskWrite = join(world.repo.root, "output.txt");
    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [taskWrite] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });

    const toolEnds = collectToolEnds(created.handle, "pi_company_agent");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "reviewer", task: "T-1", writePaths: [taskWrite], readPaths: [] } },
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "ghost-role", task: "T-1", writePaths: [taskWrite], readPaths: [] } },
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [taskWrite], readPaths: [] } },
      { type: "text", text: "派工完成" },
    ]);
    created.handle.prompt("按形状执行 T-1");
    await waitForCount(() => toolEnds.length, 3);

    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(toolEnds[2]?.isError).toBe(false);
    expect(world.dispatchCalls.length).toBe(1);
    expect(world.dispatchCalls[0]?.role).toBe("catalogrole9x2");
  }, 20000);
});

describe("写入范围与 cwd 边界（包含式）", () => {
  test("形状声明目录时其下文件派工成功；越出形状目录、指向仓库外的符号链接、越出 cwd 的路径均被拒绝并在响应中列出路径", async () => {
    const world = await setupWorld("write-scope");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const scopedDir = join(world.repo.root, "src");
    await mkdir(scopedDir, { recursive: true });
    const inScopeFile = join(scopedDir, "a.ts");
    const outsideRoot = await mkdtemp(join(tmpdir(), "requirement-agent-outside-"));
    tempRoots.push(outsideRoot);
    await writeFile(join(outsideRoot, "target.txt"), "外部内容");
    const symlinkPath = join(world.repo.root, "linked-out.txt");
    await symlink(join(outsideRoot, "target.txt"), symlinkPath);
    const outOfScopeFile = join(world.repo.root, "not-in-shape.txt");
    const escapePath = join(world.repo.root, "..", "escape.txt");

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [scopedDir] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });

    const toolEnds = collectToolEnds(created.handle, "pi_company_agent");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [outOfScopeFile], readPaths: [] } },
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [symlinkPath], readPaths: [] } },
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [escapePath], readPaths: [] } },
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [inScopeFile], readPaths: [] } },
      { type: "text", text: "派工完成" },
    ]);
    created.handle.prompt("按形状执行 T-1");
    await waitForCount(() => toolEnds.length, 4);

    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(toolEnds[2]?.isError).toBe(true);
    expect(toolEnds[3]?.isError).toBe(false);

    const rejectionText = JSON.stringify(world.provider.requests);
    expect(rejectionText).toContain(outOfScopeFile);
    expect(rejectionText).toContain(symlinkPath);
    expect(rejectionText).toContain(escapePath);

    expect(world.dispatchCalls.length).toBe(1);
    expect(world.dispatchCalls[0]?.writePaths).toEqual([inScopeFile]);
  }, 20000);
});

describe("提问阻塞、作答、停止撤回与运行态", () => {
  test("提问期间运行记录 state 为 waiting_answer，作答后回 running，relay 载荷带仓库与需求身份", async () => {
    const world = await setupWorld("ask-answer");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_ask",
        input: { question: "接口错误码采用 A 还是 B？", options: [{ label: "A", description: "沿用现有约定" }, { label: "B", description: "引入新约定" }], recommended: "A" },
      },
      { type: "text", text: "已处理" },
    ]);
    created.handle.prompt("需要用户决策一个产品问题");

    await waitForCount(() => world.pending.length, 1);
    const question = world.pending[0]!;
    expect(question.input.repoId).toBe(world.repoId);
    expect(question.input.requirement).toBe(world.requirement);
    expect(created.handle.state()).toBe("waiting_answer");
    const askedRun = await world.runStore.get(created.runId);
    expect(askedRun.ok).toBe(true);
    if (askedRun.ok) expect(askedRun.run.state).toBe("waiting_answer");

    world.pending.shift()!.resolve("ANSWER-9F2");
    await waitForCondition(() => created.handle.state() !== "waiting_answer", 10000, "超时等待提问结束后状态恢复");
    expect(created.handle.state()).toBe("running");
    const answeredRun = await world.runStore.get(created.runId);
    expect(answeredRun.ok).toBe(true);
    if (answeredRun.ok) expect(answeredRun.run.state).toBe("running");
    expect(JSON.stringify(world.provider.requests)).toContain("ANSWER-9F2");
  }, 20000);

  test("提问期间停止：relay 观测到 signal 撤回，运行终态为 stopped 且不再是 waiting_answer", async () => {
    const world = await setupWorld("ask-stop");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_ask",
        input: { question: "接口错误码采用 A 还是 B？", options: [{ label: "A", description: "沿用现有约定" }, { label: "B", description: "引入新约定" }], recommended: "A" },
      },
      { type: "text", text: "不会用到" },
    ]);
    created.handle.prompt("需要用户决策一个产品问题");
    await waitForCount(() => world.pending.length, 1);
    const question = world.pending[0]!;

    await created.handle.stop();

    expect(question.aborted).toBe(true);
    expect(created.handle.state()).toBe("stopped");
    const stoppedRun = await world.runStore.get(created.runId);
    expect(stoppedRun.ok).toBe(true);
    if (stoppedRun.ok) expect(stoppedRun.run.state).toBe("stopped");
  }, 20000);

  test("置 waiting_answer 的运行记录更新失败时计数回退：state() 不停留在 waiting_answer，随后提问仍可正常进入 waiting_answer", async () => {
    const world = await setupWorld("ask-update-fails");
    await confirmRequirement(world);
    const faultyRunStore = createUpdateOnceFailingRunStore(world.runStore);
    const created = await createRequirementAgentSession(sessionOptions(world, { runStore: faultyRunStore }));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const toolEndsFirstAsk = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_ask", input: { question: "第一问：运行记录更新会失败" } },
      { type: "text", text: "第一问结束" },
    ]);
    created.handle.prompt("需要用户决策一个产品问题");
    await waitForCount(() => toolEndsFirstAsk.length, 1);
    expect(created.handle.state()).not.toBe("waiting_answer");

    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_ask", input: { question: "第二问：应正常进入 waiting_answer" } },
      { type: "text", text: "第二问结束" },
    ]);
    created.handle.prompt("再次需要用户决策");
    await waitForCount(() => world.pending.length, 1);
    expect(created.handle.state()).toBe("waiting_answer");
    world.pending.shift()!.resolve("A");
    await waitForCondition(() => created.handle.state() !== "waiting_answer", 10000, "超时等待第二次提问结束后状态恢复");
  }, 20000);

  test("relay 不响应 signal（ask 永不 settle）时 stop() 后 state() 仍为 stopped 而非 waiting_answer", async () => {
    const world = await setupWorld("ask-stop-uncooperative-relay");
    await confirmRequirement(world);
    const { relay: uncooperativeRelay, pending: uncooperativePending } = createUncooperativeRelayFake();
    const created = await createRequirementAgentSession(sessionOptions(world, { relay: uncooperativeRelay }));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_ask", input: { question: "接口错误码采用 A 还是 B？" } },
      { type: "text", text: "不会用到" },
    ]);
    created.handle.prompt("需要用户决策一个产品问题");
    await waitForCount(() => uncooperativePending.length, 1);
    expect(created.handle.state()).toBe("waiting_answer");

    await created.handle.stop();
    expect(created.handle.state()).toBe("stopped");
  }, 20000);
});

describe("补充并入或重议", () => {
  test("不影响形状的补充直接并入，需要新增任务的补充触发重新提议且引导语要求判断是否重新提议", async () => {
    const world = await setupWorld("supplement");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });
    const tasksBefore = Object.keys(
      ((await queryState(world.home.dataRoot, world.repo.root, world.requirement)).details.data as { tasks: Record<string, unknown> }).tasks,
    );

    const pendingBefore = world.pending.length;
    const idleAfterFirst = collect(created.handle, "idle");
    scriptReplies(world.provider, [{ type: "text", text: "补充已知悉，无需变更任务集" }]);
    const firstSupplementText = "仅调整文案措辞，不影响任务集与形状";
    created.handle.injectSupplement(firstSupplementText);
    await waitForCount(() => idleAfterFirst.length, 1);
    expect(world.pending.length).toBe(pendingBefore);
    expect(
      Object.keys(((await queryState(world.home.dataRoot, world.repo.root, world.requirement)).details.data as { tasks: Record<string, unknown> }).tasks),
    ).toEqual(tasksBefore);
    expect(JSON.stringify(world.provider.requests[world.provider.requests.length - 1])).toContain(firstSupplementText);

    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_propose_shape",
        input: {
          tasks: [
            { id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] },
            { id: "T-2", title: "补充需求引入的新任务", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "extra.txt")] },
          ],
          gates: { whiteboxReview: true, blackboxAcceptance: true },
          rationale: "补充需求引入新任务，需要重新提议",
        },
      },
      { type: "text", text: "已重新提议形状" },
    ]);
    const secondSupplementText = "补充需求：新增一项能力";
    created.handle.injectSupplement(secondSupplementText);
    await waitForCount(() => world.pending.length, pendingBefore + 1);

    const supplementRequestText = JSON.stringify(world.provider.requests[world.provider.requests.length - 1]);
    expect(supplementRequestText).toContain(secondSupplementText);
    expect(supplementRequestText).toContain("重新提议");
    expect(
      Object.keys(((await queryState(world.home.dataRoot, world.repo.root, world.requirement)).details.data as { tasks: Record<string, unknown> }).tasks),
    ).toEqual(tasksBefore);

    world.pending.shift()!.resolve("确认");
    await waitForCondition(async () => {
      const state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
      return Object.keys((state.details.data as { tasks: Record<string, unknown> }).tasks).length === 2;
    }, 10000, "超时等待重新提议后的形状写入任务表");

    expect(
      Object.keys(((await queryState(world.home.dataRoot, world.repo.root, world.requirement)).details.data as { tasks: Record<string, unknown> }).tasks).sort(),
    ).toEqual(["T-1", "T-2"]);
  }, 20000);
});

describe("独立问题只记录", () => {
  test("独立问题只写入后续问题清单，任务表与形状保持不变", async () => {
    const world = await setupWorld("followup");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "输入校验", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });
    const before = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const beforeData = before.details.data as { tasks: Record<string, unknown>; shape: unknown; followUps: unknown[] };

    const toolEnds = collectToolEnds(created.handle, "pi_company_workflow");
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_workflow",
        input: {
          action: "update",
          requirement: world.requirement,
          version: before.details.version,
          update: { followUpIssues: ["启动器存在一个与本任务无关的独立缺陷"] },
        },
      },
      { type: "text", text: "已记入后续问题清单" },
    ]);
    created.handle.prompt("白盒审查报告了一个独立的启动器问题");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBeFalsy();

    const after = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const afterData = after.details.data as { tasks: Record<string, unknown>; shape: unknown; followUps: unknown[] };
    expect(afterData.tasks).toEqual(beforeData.tasks);
    expect(afterData.shape).toEqual(beforeData.shape);
    expect(afterData.followUps.length).toBe(beforeData.followUps.length + 1);
    expect(afterData.followUps.join(" ")).toContain("启动器");
  }, 20000);
});

describe("自行完成的提交与核对", () => {
  test("缺证据的完成请求被拒绝，submit 生成绑定但未经独立复跑仍不能完成", async () => {
    const world = await setupWorld("self-complete");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const selfTaskWrite = join(world.repo.root, "notes.md");
    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "补充说明文档", roles: [], dependsOn: [], writePaths: [selfTaskWrite] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "简单文档任务由需求代理自行完成",
    });

    let state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    const startResult = await executeWorkflowAction(
      { action: "task-start", requirement: world.requirement, task: "T-1", runId: created.runId, version: state.details.version as number },
      { dataRoot: world.home.dataRoot, cwd: world.repo.root },
    );
    expect(startResult.details.isError).toBeFalsy();

    const toolEndsMissingEvidence = collectToolEnds(created.handle, "pi_company_workflow");
    state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_workflow", input: { action: "task-finish", requirement: world.requirement, task: "T-1", runId: created.runId, version: state.details.version } },
      { type: "text", text: "完成请求已提交" },
    ]);
    created.handle.prompt("自行完成 T-1，请求标记完成");
    await waitForCount(() => toolEndsMissingEvidence.length, 1);
    expect(toolEndsMissingEvidence[0]?.isError).toBe(true);
    let after = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((after.details.data as { tasks: Record<string, { progress: string }> }).tasks["T-1"]?.progress).toBe("doing");

    const toolEndsSubmit = collectToolEnds(created.handle, "pi_company_agent");
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_agent",
        input: {
          action: "submit",
          task: "T-1",
          result: {
            phase: "work",
            verdict: "PASS",
            summary: "已补充说明文档",
            issues: [],
            evidence: ["自测通过"],
            changeKind: "refactor",
            workState: "green-baseline-no-change",
            coverage: [{ ref: "demo/readme/AC-1", test: "README.md:1" }],
            redCommands: [],
            greenCommands: [{ command: "cat README.md", status: "passed", details: "读取成功" }],
            changedFiles: [],
            productionPath: ["README.md"],
            preexistingEvidence: ["既有证据"],
            fakeRed: false,
          },
        },
      },
      { type: "text", text: "已提交交付" },
    ]);
    created.handle.prompt("自行完成任务的交付已就绪，请提交");
    await waitForCount(() => toolEndsSubmit.length, 1);
    expect(toolEndsSubmit[0]?.isError).toBeFalsy();

    const submittedRuns = await world.runStore.list({ kind: "role", requirement: world.requirement, states: COMPLETED_STATES, limit: 20 });
    const submitRun = submittedRuns.items.find((run) => run.task === "T-1");
    if (!submitRun) throw new Error("测试装置失败: 未找到 submit 产生的子运行");
    expect(submitRun.role?.startsWith("pi-company.")).toBe(true);
    expect(submitRun.role).toContain("requirement-agent");
    expect(submitRun.parentRunId).toBe(created.runId);

    const toolEndsFinish = collectToolEnds(created.handle, "pi_company_workflow");
    state = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_workflow", input: { action: "task-finish", requirement: world.requirement, task: "T-1", runId: submitRun.id, version: state.details.version } },
      { type: "text", text: "已完成" },
    ]);
    created.handle.prompt("交付已核实，请完成 T-1");
    await waitForCount(() => toolEndsFinish.length, 1);
    expect(toolEndsFinish[0]?.isError).toBe(true);

    after = await queryState(world.home.dataRoot, world.repo.root, world.requirement);
    expect((after.details.data as { tasks: Record<string, { progress: string }> }).tasks["T-1"]?.progress).toBe("doing");
  }, 20000);

  test("submit 只接受角色序列为空的任务，已分派角色的任务 submit 被拒绝并提示重新提议", async () => {
    const world = await setupWorld("submit-role-bound");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-1", title: "实现核心逻辑", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务由角色实现",
    });

    const idleEvents = collect(created.handle, "idle");
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_agent",
        input: {
          action: "submit",
          task: "T-1",
          result: {
            verdict: "PASS",
            summary: "尝试自行完成",
            issues: [],
            evidence: [],
            changeKind: "docs",
            workState: "green-baseline-no-change",
            coverage: [],
            redCommands: [],
            greenCommands: [],
            changedFiles: [],
            productionPath: [],
            preexistingEvidence: ["既有证据"],
            fakeRed: false,
            delivery: { commit: null, verificationOk: true },
          },
        },
      },
      { type: "text", text: "已尝试提交" },
    ]);
    created.handle.prompt("尝试为已分派角色的任务自行完成");
    await waitForCount(() => idleEvents.length, 1);

    expect(JSON.stringify(world.provider.requests[world.provider.requests.length - 1])).toContain("重新提议");
    const submittedRuns = await world.runStore.list({ kind: "role", requirement: world.requirement, states: COMPLETED_STATES, limit: 20 });
    expect(submittedRuns.items.some((run) => run.task === "T-1")).toBe(false);
  }, 20000);
});

describe("跨仓等待的判定", () => {
  test("派工把已确认的跨仓等待条件交给运行管理器", async () => {
    const world = await setupWorld("cross-repo");
    await confirmRequirement(world);

    const otherRepo = await createRepoFixture();
    repoFixtures.push(otherRepo);
    const otherIdentity = await repositoryIdentity(otherRepo.root);
    const otherRequirement = freshRequirementId();
    const otherCtx = { dataRoot: world.home.dataRoot, cwd: otherRepo.root };
    await executeWorkflowAction({ action: "init", requirement: otherRequirement }, otherCtx);
    const otherConfirmDecision = await appendDecision(decisionInput(otherRequirement, { trigger: "确认需求", decision: "确认需求文档" }), otherCtx);
    const otherConfirmState = await queryState(world.home.dataRoot, otherRepo.root, otherRequirement);
    await executeWorkflowAction(
      { action: "advance", requirement: otherRequirement, stage: "confirmed", decisionId: otherConfirmDecision.decisionId, version: otherConfirmState.details.version as number },
      otherCtx,
    );

    world.workspaceRepoIds.push(otherIdentity.repoId);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const waitTaskWrite = join(world.repo.root, "integration.txt");
    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{
        id: "T-1", title: "前端联调", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [waitTaskWrite],
        waitFor: { repo: otherIdentity.repoId, requirement: otherRequirement, stage: "executing" },
      }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "联调任务等待后端进入执行阶段",
    });

    const toolEnds = collectToolEnds(created.handle, "pi_company_agent");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [waitTaskWrite], readPaths: [] } },
      { type: "text", text: "已派工" },
    ]);
    created.handle.prompt("执行 T-1");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBeFalsy();
    expect(world.dispatchCalls).toHaveLength(1);
    expect(world.dispatchCalls[0]?.waitFor).toEqual({ repo: otherIdentity.repoId, requirement: otherRequirement, stage: "executing" });
  }, 20000);

  test("waitFor.requirement 格式非法：日历非法但形如 YYYY-MM-DD.slug 的需求名不会导致未捕获抛出", async () => {
    const world = await setupWorld("waitfor-requirement-format");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    // 月份 13、日期 45：结构上匹配需求名的正则，但日历上不合法，用来试探提议期与派工期两层校验
    const borderlineRequirement = "2026-13-45.borderline";
    const toolEndsPropose = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "pi_company_propose_shape",
        input: {
          tasks: [{
            id: "T-1", title: "跨仓联调", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")],
            waitFor: { repo: world.repoId, requirement: borderlineRequirement, stage: "executing" },
          }],
          gates: { whiteboxReview: true, blackboxAcceptance: true },
          rationale: "等待跨仓阶段",
        },
      },
      { type: "text", text: "已尝试提议" },
    ]);
    created.handle.prompt("请规划并提议形状");
    await waitForCondition(() => toolEndsPropose.length > 0 || world.pending.length > 0, 10000, "超时等待提议阶段的响应");

    if (world.pending.length > 0) {
      const question = world.pending.shift()!;
      question.resolve("确认");
      await waitForShapeRecorded(world);

      const toolEndsDispatch = collectToolEnds(created.handle, "pi_company_agent");
      scriptReplies(world.provider, [
        { type: "toolcall", name: "pi_company_agent", input: { action: "run", role: "catalogrole9x2", task: "T-1", writePaths: [join(world.repo.root, "output.txt")], readPaths: [] } },
        { type: "text", text: "已知悉" },
      ]);
      created.handle.prompt("按形状执行 T-1");
      await waitForCount(() => toolEndsDispatch.length, 1);
      expect(toolEndsDispatch[0]?.isError).toBe(true);
      expect(world.dispatchCalls.length).toBe(0);
    } else {
      expect(toolEndsPropose[0]?.isError).toBe(true);
    }
  }, 20000);
});

describe("系统提示骨架顺序", () => {
  test("角色正文、需求身份与目录、可用角色目录按此相对顺序出现在系统提示中，追加在宿主默认提示之后，形状仅在确认后才出现", async () => {
    const world = await setupWorld("prompt-order");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [{ type: "text", text: "已知悉" }]);
    const idleEvents = collect(created.handle, "idle");
    created.handle.prompt("开始工作");
    await waitForCount(() => idleEvents.length, 1);

    const firstPrompt = world.provider.requests[0]?.systemPrompt ?? "";
    const markerIndex = firstPrompt.indexOf(REQUIREMENT_AGENT_BODY_MARKER);
    // 宿主默认提示自身会回显 cwd 等信息，骨架顺序只对追加部分（角色正文之后）断言
    const requirementIndex = firstPrompt.indexOf(world.requirement, markerIndex);
    const cwdIndex = firstPrompt.indexOf(world.repo.root, markerIndex);
    const catalogIndex = firstPrompt.indexOf("catalogrole9x2", markerIndex);
    // markerIndex 严格大于 0 才能证明角色正文前面还存在宿主默认提示内容，而非替换掉它
    expect(markerIndex).toBeGreaterThan(0);
    expect(requirementIndex).toBeGreaterThan(markerIndex);
    expect(cwdIndex).toBeGreaterThan(markerIndex);
    expect(catalogIndex).toBeGreaterThan(requirementIndex);
    expect(catalogIndex).toBeGreaterThan(cwdIndex);
    expect(firstPrompt).not.toContain("T-77");
    // 工具使用规则小节须用成品定义里的生产标题，不是探针测试临时占位的名字
    expect(firstPrompt.split("\n").some((line) => line.trim() === "## 工具使用规则")).toBe(true);
    // 宿主默认系统提示原样保留，不做任何剔除或改写
    expect(firstPrompt).toContain("Current working directory:");
    expect(firstPrompt).toContain("advance");
    expect(firstPrompt).toContain("planned");
    expect(firstPrompt).toContain("executing");
    // 规范索引与需求文档位置须指向真实产物路径 .pi-company/，不得残留旧的 .bb-spec/ 命名；
    // 定点核对该说明所在行，避免误伤宿主提示里指向本仓库检出路径（其父目录名恰好含 .bb-spec）的文档链接
    const specIndexLine = firstPrompt.split("\n").find((line) => line.includes(".pi-company/spec/INDEX.md"));
    if (!specIndexLine) throw new Error("测试装置失败: 系统提示未包含规范索引与需求文档位置说明");
    expect(specIndexLine).toContain(".pi-company/spec/INDEX.md");
    expect(specIndexLine).toContain(".pi-company/requirements/");
    expect(specIndexLine).not.toContain(".bb-spec");

    await proposeAndConfirmShape(world, created.handle, {
      tasks: [{ id: "T-77", title: "唯一形状节点标记", roles: ["catalogrole9x2"], dependsOn: [], writePaths: [join(world.repo.root, "output.txt")] }],
      gates: { whiteboxReview: true, blackboxAcceptance: true },
      rationale: "单任务直接实现",
    });

    scriptReplies(world.provider, [{ type: "text", text: "继续" }]);
    created.handle.prompt("形状已确认，请继续");
    // 形状写入与"继续"这一轮请求实际发出之间没有硬先后保证；轮询最后一条请求的系统提示
    // 直到真正带上 T-77，而不是假定第一次 idle 就对应这次追加提示
    await waitForCondition(() => {
      const lastPrompt = world.provider.requests[world.provider.requests.length - 1]?.systemPrompt ?? "";
      return lastPrompt.includes("T-77");
    }, 10000, "超时等待最后一条请求的系统提示写入形状标记 T-77");

    const laterPrompt = world.provider.requests[world.provider.requests.length - 1]?.systemPrompt ?? "";
    expect(laterPrompt).toContain("T-77");
  }, 20000);
});

describe("角色目录描述单行化", () => {
  test("角色描述含换行与伪标题时，系统提示里该角色一行内完整呈现，不产生新的小节标题", async () => {
    const world = await setupWorld("catalog-description-fold");
    const trickyRole = buildInlineRoleCatalogEntry({
      name: "trickyrole7z1",
      kind: "work",
      tools: ["read", "bash"],
      description: "处理跨仓协调事务。\n## 伪造小节ZZQ7\n这不是真正的小节标题，只是描述里的换行内容。",
    });
    world.roleCatalog.push(trickyRole);
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [{ type: "text", text: "已知悉" }]);
    const idleEvents = collect(created.handle, "idle");
    created.handle.prompt("开始工作");
    await waitForCount(() => idleEvents.length, 1);

    const firstPrompt = world.provider.requests[0]?.systemPrompt ?? "";
    const catalogLines = firstPrompt.split("\n");
    const roleLine = catalogLines.find((line) => line.includes("trickyrole7z1"));
    if (!roleLine) throw new Error("测试装置失败: 系统提示未包含目录角色行");
    expect(roleLine).toContain("伪造小节ZZQ7");
    expect(roleLine).toContain("这不是真正的小节标题");
    expect(catalogLines.some((line) => line.trim().startsWith("## 伪造小节ZZQ7"))).toBe(false);
  }, 20000);
});

describe("数据库写入失败", () => {
  test("数据库拒绝创建运行时返回失败且不遗留活动需求运行", async () => {
    const world = await setupWorld("database-failure");
    await confirmRequirement(world);
    const restore = failDatabaseWrites(repositoryDatabase(world.home.dataRoot, world.repoId), "records", "namespace", "runs");
    try {
      const result = await createRequirementAgentSession(sessionOptions(world));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("拒绝写入");
      expect((await world.runStore.list({ limit: 100 })).items).toEqual([]);
    } finally { restore(); }
    const result = await createRequirementAgentSession(sessionOptions(world));
    expect(result.ok).toBe(true);
    if (result.ok && !result.reused) handles.push(result.handle);
  });
});

describe("停止透传真实结果", () => {
  test("stop() 透传角色会话的真实 Shell 清理结果：任务终态非 uncertain，stopped 由结果合成而非恒为 true", async () => {
    const world = await setupWorld("stop-real-shell");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const pidFile = join(world.repo.root, "bash.pid");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10` } },
      { type: "text", text: "done" },
    ]);
    created.handle.prompt("启动一个后台任务");

    const pid = await waitForPidFile(pidFile);
    expect(pid).toBeGreaterThan(0);

    let stopOutcome: { stopped: boolean; shellResults: Array<{ result: { ok: boolean; task?: { status: string; pgid?: number } } }> } | undefined;
    try {
      stopOutcome = await withTimeout(created.handle.stop(), 8000, "stop() 未在合理时间内返回");
      expect(stopOutcome.shellResults.length).toBeGreaterThan(0);
      const entry = stopOutcome.shellResults.find((e) => e.result.ok);
      expect(entry).toBeDefined();
      if (entry?.result.ok) expect(entry.result.task?.status).not.toBe("uncertain");
      expect(stopOutcome.stopped).toBe(true);
      await waitForProcessGone(pid);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 进程组已消失，无需处理
      }
    }
  }, 15000);

  test("relay 不响应 signal（ask 永不 settle）时 stop() 仍在有界时间内 resolve，state 为 stopped", async () => {
    const world = await setupWorld("stop-bounded-uncooperative-relay");
    await confirmRequirement(world);
    const { relay: uncooperativeRelay, pending: uncooperativePending } = createUncooperativeRelayFake();
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const created = await createRequirementAgentSession(sessionOptions(world, { relay: uncooperativeRelay, clock }));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_ask", input: { question: "接口错误码采用 A 还是 B？" } },
      { type: "text", text: "不会用到" },
    ]);
    created.handle.prompt("需要用户决策一个产品问题");
    await waitForCount(() => uncooperativePending.length, 1);
    expect(created.handle.state()).toBe("waiting_answer");

    const stopPromise = created.handle.stop();
    timeSource.advance(5000);
    const startedAt = Date.now();
    const stopOutcome = await withClockPump(timeSource, () => withTimeout(stopPromise, 6000, "stop() 未在有界时间内返回"));
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(6000);
    expect(created.handle.state()).toBe("stopped");
    expect(Array.isArray(stopOutcome.shellResults)).toBe(true);
  }, 15000);
});

describe("decision_record 在需求代理会话内可用", () => {
  test("模型调用 decision_record 后该需求的 ai-decisions.jsonl 出现记录，tool_end 非 isError", async () => {
    const world = await setupWorld("decision-record-tool");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const toolEnds = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      {
        type: "toolcall",
        name: "decision_record",
        input: {
          requirement: world.requirement,
          actor: "ai",
          source: "requirement-agent",
          trigger: "澄清跨仓契约",
          decision: "采用方案 A",
          alternatives: ["方案 B"],
          effects: ["architecture"],
          scope: "接口契约",
          basis: ["评审结论"],
          action: "更新契约文档",
        },
      },
      { type: "text", text: "已记录决定" },
    ]);
    created.handle.prompt("请记录一个决定");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBeFalsy();

    const records = await readDecisions({ dataRoot: world.home.dataRoot, cwd: world.repo.root, requirement: world.requirement, actor: "ai" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => (record as { decision?: string }).decision === "采用方案 A")).toBe(true);
  }, 20000);
});

describe("需求代理会话不注册 structured_output", () => {
  test("调用 structured_output 被拒绝且不锁死会话，随后 pi_company_workflow 仍可正常调用", async () => {
    const world = await setupWorld("no-structured-output");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    const toolEndsStructured = collect(created.handle, "tool_end") as Array<{ isError?: boolean }>;
    scriptReplies(world.provider, [
      { type: "toolcall", name: "structured_output", input: { phase: "work", verdict: "PASS" } },
      { type: "text", text: "已尝试提交" },
    ]);
    created.handle.prompt("尝试提交结构化结果");
    await waitForCount(() => toolEndsStructured.length, 1);
    expect(toolEndsStructured[0]?.isError).toBe(true);
    expect(created.handle.state()).not.toBe("stopped");
    expect(created.handle.state()).not.toBe("failed");

    const toolEndsWorkflow = collectToolEnds(created.handle, "pi_company_workflow");
    scriptReplies(world.provider, [
      { type: "toolcall", name: "pi_company_workflow", input: { action: "query", requirement: world.requirement } },
      { type: "text", text: "已查询" },
    ]);
    created.handle.prompt("请查询当前需求状态");
    await waitForCount(() => toolEndsWorkflow.length, 1);
    expect(toolEndsWorkflow[0]?.isError).toBeFalsy();
  }, 20000);
});

describe("需求代理 handle 不暴露 finalize", () => {
  test('"finalize" in handle 为 false，正常终结经 stop()', async () => {
    const world = await setupWorld("no-finalize");
    await confirmRequirement(world);
    const created = await createRequirementAgentSession(sessionOptions(world));
    if (!created.ok || created.reused) throw new Error("测试装置失败: 会话未成功创建");
    handles.push(created.handle);

    expect("finalize" in created.handle).toBe(false);
  }, 20000);
});
