import { afterEach, describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import type { Workspace } from "../runtime/identity.ts";
import { createRecord } from "../runtime/database.ts";
import { requirementStateRef } from "../runtime/workflow-state.ts";
import { validateParams } from "../runtime/protocol.ts";
import { registerDispatchTools, default as dispatchExtension } from "../extensions/dispatch.ts";
import { DaemonCallError } from "../runtime/daemon-client.ts";
import type { DaemonClient, WorkspaceClientsHandle } from "../runtime/daemon-client.ts";

const execFileAsync = promisify(execFile);

const REQUIREMENT = "2026-09-09.dispatch-tools-demo";

const TOOL_NAMES = [
  "pi_company_dispatch",
  "pi_company_review",
  "pi_company_reply",
  "pi_company_forward",
  "pi_company_agents",
] as const;

const RAW_GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "pi-company-test",
  GIT_AUTHOR_EMAIL: "pi-company-test@example.com",
  GIT_COMMITTER_NAME: "pi-company-test",
  GIT_COMMITTER_EMAIL: "pi-company-test@example.com",
};

const EMPTY_WORKSPACE: Workspace = { repos: [], skipped: [] };

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const plainDirs: string[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of plainDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeDaemon {
  client: DaemonClient;
  calls: RecordedCall[];
}

type Handler = (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

function createFakeDaemonClient(handlers: Record<string, Handler>): FakeDaemon {
  const calls: RecordedCall[] = [];
  const client: DaemonClient = {
    async call(method, params = {}) {
      validateParams(method, params);
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`fake daemon 未编排方法: ${method}`);
      return handler(params);
    },
    subscribe: () => () => {},
    state: () => ({ status: "connected" }),
    close: () => {},
  };
  return { client, calls };
}

function createUnreachableDaemonClient(reason: string): FakeDaemon {
  const calls: RecordedCall[] = [];
  const client: DaemonClient = {
    call() {
      return Promise.reject(new Error(`守护进程不可达: ${reason}`));
    },
    subscribe: () => () => {},
    state: () => ({ status: "unreachable", reason }),
    close: () => {},
  };
  return { client, calls };
}

function createFakeWorkspaceClients(map: Record<string, DaemonClient>): WorkspaceClientsHandle {
  return {
    forRepo: (repoId: string) => map[repoId],
    all: () => Object.values(map),
    skipped: () => [],
    closeAll: () => {},
  };
}

interface RenderableComponent {
  render(width: number): string[];
}

interface RegisteredTool {
  name: string;
  parameters: unknown;
  renderShell?: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  renderCall?: (args: unknown, theme: unknown, ctx: unknown) => RenderableComponent;
  renderResult?: (result: unknown, options: unknown, theme: unknown, ctx: unknown) => RenderableComponent;
}

function createFakePi() {
  const registered: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: RegisteredTool) {
      registered.push(tool);
    },
    on() {},
  };
  return { pi, registered };
}

function contextAccessor(clients: WorkspaceClientsHandle, workspace: Workspace, overrides: Record<string, unknown> = {}) {
  return () => ({ clients, windowId: "window-test", workspace, ...overrides });
}

// 假 context 携带的 gitTimeoutMs / gitMaxBuffer：测试用来把默认 10s/64MiB 收紧到可断言的量级，
// 实现需在同名字段上对齐（见报告）
function registerTools(clients: WorkspaceClientsHandle, workspace: Workspace, overrides: Record<string, unknown> = {}): RegisteredTool[] {
  const { pi, registered } = createFakePi();
  registerDispatchTools(pi as unknown as ExtensionAPI, contextAccessor(clients, workspace, overrides));
  return registered;
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} 未注册`);
  return tool;
}

function fakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    ui: {} as ExtensionContext["ui"],
    mode: "print",
    hasUI: false,
    cwd: "/",
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    ...overrides,
  } as ExtensionContext;
}

async function callTool(
  tool: RegisteredTool,
  params: Record<string, unknown>,
  cwd: string,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params, undefined, undefined, fakeCtx({ cwd }));
  return { text: result.content[0]?.text ?? "", details: result.details };
}

interface RepoWorld {
  home: Awaited<ReturnType<typeof createTempHome>>;
  repo: Awaited<ReturnType<typeof createRepoFixture>>;
  identity: Awaited<ReturnType<typeof repositoryIdentity>>;
}

async function setupRepoWorld(): Promise<RepoWorld> {
  const home = await createTempHome();
  tempHomes.push(home);
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  const identity = await repositoryIdentity(repo.root);
  return { home, repo, identity };
}

// 独立父目录（非 cwd 的兄弟目录），杜绝实现靠 readdir 反推 cwd 同级目录来蒙混仓库名
async function setupNestedRepoWorld(): Promise<RepoWorld> {
  const home = await createTempHome();
  tempHomes.push(home);
  const wrapper = await mkdtemp(join(tmpdir(), "pi-company-nested-"));
  plainDirs.push(wrapper);
  const root = join(wrapper, "repo");
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root, env: RAW_GIT_ENV });
  await writeFile(join(root, "README.md"), "pi-company nested fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root, env: RAW_GIT_ENV });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: root, env: RAW_GIT_ENV });
  const identity = await repositoryIdentity(root);
  return { home, repo: { root, worktrees: [] }, identity };
}

type Raced<T> = { kind: "resolved"; value: T; elapsedMs: number } | { kind: "timedOut" };

// 限制测试等待时间，及时报告子进程的中止或超时未生效。
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<Raced<T>> {
  const start = Date.now();
  return Promise.race([
    promise.then((value) => ({ kind: "resolved" as const, value, elapsedMs: Date.now() - start })),
    new Promise<Raced<T>>((resolve) => setTimeout(() => resolve({ kind: "timedOut" }), ms)),
  ]);
}

function buildWorkspace(worlds: RepoWorld[]): Workspace {
  return {
    repos: worlds.map((world) => ({ path: world.repo.root, repoId: world.identity.repoId, commonDir: world.identity.commonDir })),
    skipped: [],
  };
}

const statePath = requirementStateRef;

function seedRequirementState(dataRoot: string, repoId: string, requirement: string, stage: string) {
  return createRecord(statePath(dataRoot, repoId, requirement), {
    requirement,
    stage,
    shape: null,
    tasks: {},
    followUps: [],
    history: [],
  });
}

async function repoHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

async function withTempEnv<T>(home: RepoWorld["home"], fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home.home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
}

function fakeTheme(): unknown {
  const identity = (_color: unknown, text: string) => text;
  return {
    fg: identity,
    bg: identity,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  };
}

function fakeRenderContext(args: unknown): unknown {
  return {
    args,
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: undefined,
    cwd: "/",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
}

describe("默认导出 dispatchExtension 的单参契约", () => {
  test("函数只声明一个形参", () => {
    expect(dispatchExtension.length).toBe(1);
  });
});

describe("五个工具名与参数 schema", () => {
  const registered = registerTools(createFakeWorkspaceClients({}), EMPTY_WORKSPACE);

  test("恰好注册五个约定名称的工具", () => {
    expect(registered.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("pi_company_dispatch 的 schema 接受 requirement 与 cwd，拒绝多余字段与 mcp", () => {
    const tool = findTool(registered, "pi_company_dispatch");
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo" })).toBe(true);
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", extra: "x" })).toBe(false);
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", mcp: { adapterEntry: "a", configPath: "b" } })).toBe(false);
  });

  test("pi_company_review 的 schema 要求 baseline，拒绝调用方提供 snapshot/mcp 或其他多余字段", () => {
    const tool = findTool(registered, "pi_company_review");
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", baseline: "main" })).toBe(true);
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo" })).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        requirement: REQUIREMENT,
        cwd: "/repo",
        baseline: "main",
        mcp: { adapterEntry: "a", configPath: "b" },
      }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        requirement: REQUIREMENT,
        cwd: "/repo",
        baseline: "main",
        snapshot: { head: "abc1234", fingerprint: "fp" },
      }),
    ).toBe(false);
  });

  test("pi_company_reply 的 schema 拒绝空 answer 与多余字段", () => {
    const tool = findTool(registered, "pi_company_reply");
    expect(Value.Check(tool.parameters, { questionId: "q-1", answer: "好的" })).toBe(true);
    expect(Value.Check(tool.parameters, { questionId: "q-1", answer: "" })).toBe(false);
    expect(Value.Check(tool.parameters, { questionId: "q-1", answer: "好的", extra: "x" })).toBe(false);
  });

  test("pi_company_forward 的 schema 拒绝空 message 与多余字段", () => {
    const tool = findTool(registered, "pi_company_forward");
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", message: "补充" })).toBe(true);
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", message: "" })).toBe(false);
    expect(Value.Check(tool.parameters, { requirement: REQUIREMENT, cwd: "/repo", message: "补充", extra: "x" })).toBe(false);
  });

  test("pi_company_agents 的 schema 只接受约定的 action 枚举，拒绝多余字段", () => {
    const tool = findTool(registered, "pi_company_agents");
    const actions = ["list", "status", "pause", "resume", "stop", "pauseAll", "resumeAll", "stopAll", "resumeInterrupted"];
    for (const action of actions) {
      expect(Value.Check(tool.parameters, { action })).toBe(true);
    }
    expect(Value.Check(tool.parameters, { action: "unknown-action" })).toBe(false);
    expect(Value.Check(tool.parameters, { action: "pause", runId: "run-1", cwd: "/repo" })).toBe(true);
    expect(Value.Check(tool.parameters, { action: "list", extra: "x" })).toBe(false);
  });
});

describe("dispatch 派出需求代理前提与身份传递", () => {
  test("draft 需求派出被拒绝并说明未确认，且未触达守护进程", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "draft");
    const daemon = createFakeDaemonClient({ "dispatch.requirement": () => ({ id: "run-should-not-happen" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("未确认");
    expect(daemon.calls.length).toBe(0);
  });

  test("confirmed 需求派出成功并返回运行身份，请求不含角色参数", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createFakeDaemonClient({ "dispatch.requirement": () => ({ id: "run-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain("run-1");
    expect(daemon.calls.length).toBe(1);
    expect(daemon.calls[0]?.method).toBe("dispatch.requirement");
    expect(daemon.calls[0]?.params.role).toBeUndefined();
    expect(daemon.calls[0]?.params.kind).toBeUndefined();
  });

  test("confirmed 需求已有活动运行时，第二次派出返回现有运行身份而非失败", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    let attempt = 0;
    const daemon = createFakeDaemonClient({
      "dispatch.requirement": () => {
        attempt += 1;
        if (attempt === 1) return { id: "run-1" };
        throw new DaemonCallError("already_active", "需求已有活动运行", { runId: "run-1" });
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const [first, second] = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      const params = { requirement: REQUIREMENT, cwd: world.repo.root };
      return [await callTool(tool, params, world.repo.root), await callTool(tool, params, world.repo.root)];
    });

    expect(first.details.isError).toBeFalsy();
    expect(second.details.isError).not.toBe(true);
    expect(second.text).toContain("run-1");
  });

  test("守护进程返回 cwd 不属于本仓库的原因时原样透出", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createFakeDaemonClient({
      "dispatch.requirement": () => {
        throw new Error("cwd 不属于本仓库");
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("cwd 不属于本仓库");
  });

  test("dispatch 对非绝对路径 cwd 拒绝并说明需要绝对路径，且不触达守护进程", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createFakeDaemonClient({ "dispatch.requirement": () => ({ id: "run-should-not-happen" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const results = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      const outcomes = [];
      for (const cwd of [".", "../x", "relative/path"]) {
        outcomes.push(await callTool(tool, { requirement: REQUIREMENT, cwd }, world.repo.root));
      }
      return outcomes;
    });

    for (const result of results) {
      expect(result.details.isError).toBe(true);
      expect(result.text).toContain("绝对路径");
    }
    expect(daemon.calls.length).toBe(0);
  });

  test("confirmed 之后的进行中阶段（含 retreat 回到的 executing）仍能派出，draft/rejected/accepted 拒绝", async () => {
    const ALLOWED_STAGES = ["planned", "executing", "reviewing", "accepting"];
    for (const stage of ALLOWED_STAGES) {
      const world = await setupRepoWorld();
      await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, stage);
      const daemon = createFakeDaemonClient({ "dispatch.requirement": () => ({ id: `run-${stage}` }) });
      const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
      const workspace = buildWorkspace([world]);

      const result = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
        return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
      });

      expect(result.details.isError).toBeFalsy();
      expect(result.text).not.toContain("尚未确认");
      expect(daemon.calls.length).toBe(1);
    }

    const REJECTED_STAGES = ["draft", "rejected", "accepted"];
    for (const stage of REJECTED_STAGES) {
      const world = await setupRepoWorld();
      await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, stage);
      const daemon = createFakeDaemonClient({ "dispatch.requirement": () => ({ id: "run-should-not-happen" }) });
      const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
      const workspace = buildWorkspace([world]);

      const result = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
        return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
      });

      expect(result.details.isError).toBe(true);
      expect(daemon.calls.length).toBe(0);
    }
  });
});

describe("review 派出提交前白盒审查者", () => {
  test("调用 dispatch.review 时自行计算快照：head 等于当前提交，fingerprint 非空且随工作区改动而变化", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "dispatch.review": (params) => ({ id: "review-1", received: params }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);
    const head = await repoHeadCommit(world.repo.root);

    const first = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(first.details.isError).toBeFalsy();
    const firstSnapshot = daemon.calls[0]?.params.snapshot as { head: string; fingerprint: string };
    expect(firstSnapshot.head).toBe(head);
    expect(firstSnapshot.fingerprint.length).toBeGreaterThan(0);
    expect(daemon.calls[0]?.params.baseline).toBe("main");

    await writeFile(join(world.repo.root, "changed.txt"), "新增内容\n");

    const second = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(second.details.isError).toBeFalsy();
    const secondSnapshot = daemon.calls[1]?.params.snapshot as { head: string; fingerprint: string };
    expect(secondSnapshot.fingerprint).not.toBe(firstSnapshot.fingerprint);
  });

  test("大 diff（已跟踪文件改动超过 1 MiB）时 review 仍成功派出，不因输出超限失败", async () => {
    const world = await setupRepoWorld();
    const workspace = buildWorkspace([world]);
    const bigContent = `${"x".repeat(1024 * 1024 + 4096)}\n`;
    await writeFile(join(world.repo.root, "README.md"), bigContent);
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-big" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain("review-big");
  });

  test("未跟踪文件内容变化时快照 fingerprint 变化，未改动时保持一致", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);
    await writeFile(join(world.repo.root, "a.txt"), "A");

    const first = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(first.details.isError).toBeFalsy();
    const fingerprintFirst = (daemon.calls[0]?.params.snapshot as { fingerprint: string }).fingerprint;

    const repeat = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(repeat.details.isError).toBeFalsy();
    const fingerprintRepeat = (daemon.calls[1]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintRepeat).toBe(fingerprintFirst);

    await writeFile(join(world.repo.root, "a.txt"), "B");
    const second = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(second.details.isError).toBeFalsy();
    const fingerprintSecond = (daemon.calls[2]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintSecond).not.toBe(fingerprintFirst);
  });

  test("未跟踪目录内文件内容变化时快照 fingerprint 变化（未跟踪目录不塌缩）", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);
    await mkdir(join(world.repo.root, "newdir"), { recursive: true });
    await writeFile(join(world.repo.root, "newdir", "a.ts"), "内容A\n");

    const first = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(first.details.isError).toBeFalsy();
    const fingerprintFirst = (daemon.calls[0]?.params.snapshot as { fingerprint: string }).fingerprint;

    await writeFile(join(world.repo.root, "newdir", "a.ts"), "内容B\n");
    const second = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(second.details.isError).toBeFalsy();
    const fingerprintSecond = (daemon.calls[1]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintSecond).not.toBe(fingerprintFirst);
  });

  test("未跟踪符号链接指向仓库外文件：指纹按目标路径字符串计算，不读取目标内容", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);
    const outsideFile = join(world.home.home, "outside-target.txt");
    await writeFile(outsideFile, "外部内容V1\n");
    await symlink(outsideFile, join(world.repo.root, "link.txt"));

    const byTarget = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(byTarget.details.isError).toBeFalsy();
    const fingerprintByTarget = (daemon.calls[0]?.params.snapshot as { fingerprint: string }).fingerprint;

    await writeFile(outsideFile, "外部内容V2\n");
    const afterContentChange = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(afterContentChange.details.isError).toBeFalsy();
    const fingerprintAfterContentChange = (daemon.calls[1]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintAfterContentChange).toBe(fingerprintByTarget);

    await rm(join(world.repo.root, "link.txt"));
    const anotherOutsideFile = join(world.home.home, "another-outside-target.txt");
    await writeFile(anotherOutsideFile, "外部内容V2\n");
    await symlink(anotherOutsideFile, join(world.repo.root, "link.txt"));
    const afterTargetPathChange = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(afterTargetPathChange.details.isError).toBeFalsy();
    const fingerprintAfterTargetPathChange = (daemon.calls[2]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintAfterTargetPathChange).not.toBe(fingerprintByTarget);
  });

  test("未跟踪文件不可读时拒绝派审，恢复可读后正常派审", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);
    const lockedPath = join(world.repo.root, "locked.txt");
    await writeFile(lockedPath, "");
    await chmod(lockedPath, 0o000);

    try {
      const result = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace), "pi_company_review");
        return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
      });
      expect(result.details.isError).toBe(true);
      expect(daemon.calls).toHaveLength(0);
    } finally {
      await chmod(lockedPath, 0o644);
    }

    await writeFile(lockedPath, "");
    const resultEmpty = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });
    expect(resultEmpty.details.isError).toBeFalsy();
    const fingerprintEmpty = (daemon.calls[0]?.params.snapshot as { fingerprint: string }).fingerprint;
    expect(fingerprintEmpty).toMatch(/^[a-f0-9]{64}$/);
  });

  test("空仓库（无提交）时 review 回执含尚无提交，不含 fatal: 或 Command failed", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const emptyRepoRoot = await mkdtemp(join(tmpdir(), "pi-company-empty-repo-"));
    plainDirs.push(emptyRepoRoot);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: emptyRepoRoot, env: RAW_GIT_ENV });
    const identity = await repositoryIdentity(emptyRepoRoot);
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [identity.repoId]: daemon.client });
    const workspace: Workspace = { repos: [{ path: emptyRepoRoot, repoId: identity.repoId, commonDir: identity.commonDir }], skipped: [] };

    const result = await withTempEnv(home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: emptyRepoRoot, baseline: "main" }, emptyRepoRoot);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("尚无提交");
    expect(result.text).not.toContain("fatal:");
    expect(result.text).not.toContain("Command failed");
  });

  test(
    "git 挂起时，AbortSignal 触发后 review 在 1 秒内返回含已停止等待与核对字样的中止回执",
    async () => {
      const world = await setupRepoWorld();
      const workspace = buildWorkspace([world]);
      const blockedConfig = join(world.repo.root, "blocked-config");
      await execFileAsync("mkfifo", [blockedConfig]);
      await execFileAsync("git", ["config", "include.path", blockedConfig], { cwd: world.repo.root, env: RAW_GIT_ENV });
      const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
      const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });

      // 命名管道使真实 Git 阻塞在配置读取，取消必须终止受管进程。
      const raced = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace), "pi_company_review");
        const controller = new AbortController();
        const promise = tool.execute(
          "call-1",
          { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" },
          controller.signal,
          undefined,
          fakeCtx({ cwd: world.repo.root }),
        );
        controller.abort();
        return await raceWithTimeout(promise, 1500);
      });

      expect(raced.kind).toBe("resolved");
      if (raced.kind !== "resolved") return;
      expect(raced.elapsedMs).toBeLessThan(1000);
      const result = raced.value as { details: { isError: boolean }; content: Array<{ text: string }> };
      expect(result.details.isError).toBe(true);
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("已停止等待");
      expect(text).toContain("核对");
      expect(text).not.toContain("未执行");
      expect(text).not.toContain("未发生");
    },
    3000,
  );

  test(
    "git 命令超时（通过 context 注入 gitTimeoutMs）时回执含 git 命令超时，不含守护进程",
    async () => {
      const world = await setupRepoWorld();
      const workspace = buildWorkspace([world]);
      const blockedConfig = join(world.repo.root, "blocked-config");
      await execFileAsync("mkfifo", [blockedConfig]);
      await execFileAsync("git", ["config", "include.path", blockedConfig], { cwd: world.repo.root, env: RAW_GIT_ENV });
      const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
      const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });

      // 限制等待时间，以验证 Git 配置读取阻塞时的超时回执。
      const raced = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace, { gitTimeoutMs: 500 }), "pi_company_review");
        const promise = tool.execute(
          "call-1",
          { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" },
          undefined,
          undefined,
          fakeCtx({ cwd: world.repo.root }),
        );
        return await raceWithTimeout(promise, 2500);
      });

      expect(raced.kind).toBe("resolved");
      if (raced.kind !== "resolved") return;
      const result = raced.value as { details: { isError: boolean }; content: Array<{ text: string }> };
      expect(result.details.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("git 命令超时");
      expect(result.content[0]?.text ?? "").not.toContain("守护进程");
    },
    4000,
  );

  test("git diff 输出超过注入的 gitMaxBuffer 时回执含变更过大", async () => {
    const world = await setupRepoWorld();
    const workspace = buildWorkspace([world]);
    await writeFile(join(world.repo.root, "README.md"), "x".repeat(4096));
    const daemon = createFakeDaemonClient({ "dispatch.review": () => ({ id: "review-1" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace, { gitMaxBuffer: 1024 }), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("变更过大");
  });
});

describe("reply 广播到工作区全部仓库", () => {
  test("问题来自仓库 B：A 拒绝、B 接受时仍视为成功", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupRepoWorld();
    const daemonA = createFakeDaemonClient({ "relay.answer": () => ({ accepted: false }) });
    const daemonB = createFakeDaemonClient({ "relay.answer": () => ({ accepted: true }) });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-1", answer: "好的" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).not.toContain("已由其他窗口作答");
    expect(daemonA.calls.some((call) => call.method === "relay.answer")).toBe(true);
    expect(daemonB.calls.some((call) => call.method === "relay.answer")).toBe(true);
  });

  test("广播后全部仓库均可达且均未接受时返回已由其他窗口作答", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupRepoWorld();
    const daemonA = createFakeDaemonClient({ "relay.answer": () => ({ accepted: false }) });
    const daemonB = createFakeDaemonClient({ "relay.answer": () => ({ accepted: false }) });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-1", answer: "好的" }, worldA.repo.root);
    });

    expect(result.text).toContain("已由其他窗口作答");
  });

  test("A 不可达、B 未接受时回执带出 A 的不可达原因，不误报已由其他窗口作答", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupRepoWorld();
    const daemonA = createUnreachableDaemonClient("网络已断开");
    const daemonB = createFakeDaemonClient({ "relay.answer": () => ({ accepted: false }) });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-1", answer: "好的" }, worldA.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("网络已断开");
    expect(result.text).not.toContain("已由其他窗口作答");
  });

  test("全部仓库均报告问题不存在时回执说明问题不存在", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupRepoWorld();
    const notFound: Handler = () => {
      throw new DaemonCallError("not_found", "问题不存在");
    };
    const daemonA = createFakeDaemonClient({ "relay.answer": notFound });
    const daemonB = createFakeDaemonClient({ "relay.answer": notFound });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-missing", answer: "好的" }, worldA.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不存在");
  });

  test("全部不可达时回执截断不可达原因且不泄漏绝对路径", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupRepoWorld();
    const longPath = `/private/tmp/pi-company-socket-${"segment".repeat(20)}.sock`;
    const logTail = "x".repeat(5 * 1024);
    const rawReason = `连接失败: ${longPath}\n日志尾: ${logTail}`;
    const daemonA = createUnreachableDaemonClient(rawReason);
    const daemonB = createUnreachableDaemonClient(rawReason);
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-1", answer: "好的" }, worldA.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain(longPath);
    expect(result.text).not.toContain(logTail);
    expect(/(^|[\s:])\/[^\s]+/.test(result.text)).toBe(false);
    expect(result.text.length).toBeLessThan(500);
  });
});

describe("forward 转发补充需求", () => {
  test("需求进行中且仓库属于工作区时转发成功", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "executing");
    const daemon = createFakeDaemonClient({ "relay.forward": () => ({ delivered: true }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_forward");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, message: "补充说明" }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemon.calls.length).toBe(1);
    expect(daemon.calls[0]?.method).toBe("relay.forward");
    expect(daemon.calls[0]?.params.requirement).toBe(REQUIREMENT);
    expect(daemon.calls[0]?.params.message).toBe("补充说明");
  });

  test("cwd 指向的仓库不在工作区内时返回明确错误，且未调用守护进程", async () => {
    const world = await setupRepoWorld();
    const outsideRepo = await createRepoFixture();
    repoFixtures.push(outsideRepo);
    const daemon = createFakeDaemonClient({ "relay.forward": () => ({ delivered: true }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_forward");
      return callTool(tool, { requirement: REQUIREMENT, cwd: outsideRepo.root, message: "补充说明" }, outsideRepo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(daemon.calls.length).toBe(0);
  });

  test("需求在本仓库尚无进行中状态时返回明确错误，且未调用守护进程", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "relay.forward": () => ({ delivered: true }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_forward");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, message: "补充说明" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(daemon.calls.length).toBe(0);
  });
});

describe("agents 查询与控制运行", () => {
  test("list 合并两个可达仓库的运行，按 workspace.repos 目录名分段", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const daemonA = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-a-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const daemonB = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-b-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain(basename(worldA.repo.root));
    expect(result.text).toContain(basename(worldB.repo.root));
    expect(result.text).toContain("run-a-1");
    expect(result.text).toContain("run-b-1");
  });

  test("list 全部仓库不可达时回执为不可达而非无运行中的代理", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const daemonA = createUnreachableDaemonClient("网络已断开A");
    const daemonB = createUnreachableDaemonClient("网络已断开B");
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain("无运行中的代理");
  });

  test("list 用 allSettled：A 可达 B 不可达时，回执按 workspace.repos 目录名分段列出各自结果", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const daemonA = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-a-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const daemonB = createUnreachableDaemonClient("网络已断开");
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain(basename(worldA.repo.root));
    expect(result.text).toContain(basename(worldB.repo.root));
    expect(result.text).toContain("run-a-1");
    expect(result.text).toContain("不可达");
  });

  test("list 不可达原因截断且不泄漏绝对路径", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const longPath = `/private/tmp/pi-company-socket-${"segment".repeat(20)}.sock`;
    const logTail = "x".repeat(5 * 1024);
    const rawReason = `连接失败: ${longPath}\n日志尾: ${logTail}`;
    const daemonA = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-a-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const daemonB = createUnreachableDaemonClient(rawReason);
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).not.toContain(longPath);
    expect(result.text).not.toContain(logTail);
    expect(/(^|[\s:])\/[^\s]+/.test(result.text)).toBe(false);
    expect(result.text.length).toBeLessThan(500);
  });

  test("list 不可达原因为 URL 时完整保留，不被当作文件路径截断", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const urlReason = "端点 https://api.example.com/v1/messages 不可达";
    const daemonA = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-a-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const daemonB = createUnreachableDaemonClient(urlReason);
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain("https://api.example.com/v1/messages");
  });

  test("broadcastTargets 按 repoId 去重：主目录与其 worktree 同 repoId 时 list 只列一次、只调用一次", async () => {
    const worldA = await setupRepoWorld();
    const worktree = await addWorktree(worldA.repo);
    const daemonA = createFakeDaemonClient({
      "runs.list": () => ({ items: [{ id: "run-a-1", kind: "requirement", requirement: REQUIREMENT, state: "running" }], total: 1, runningCount: 1 }),
    });
    const clients = createFakeWorkspaceClients({ [worldA.identity.repoId]: daemonA.client });
    const workspace: Workspace = {
      repos: [
        { path: worldA.repo.root, repoId: worldA.identity.repoId, commonDir: worldA.identity.commonDir },
        { path: worktree.root, repoId: worldA.identity.repoId, commonDir: worldA.identity.commonDir },
      ],
      skipped: [],
    };

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "list" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    const occurrences = (result.text.match(/run-a-1/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(daemonA.calls.filter((call) => call.method === "runs.list").length).toBe(1);
  });

  test("broadcastTargets 按 repoId 去重：主目录与其 worktree 同 repoId 时 pauseAll 只调用一次、计数不重复", async () => {
    const worldA = await setupRepoWorld();
    const worktree = await addWorktree(worldA.repo);
    const daemonA = createFakeDaemonClient({ "runs.pauseAll": () => ({ pausedCount: 3 }) });
    const clients = createFakeWorkspaceClients({ [worldA.identity.repoId]: daemonA.client });
    const workspace: Workspace = {
      repos: [
        { path: worldA.repo.root, repoId: worldA.identity.repoId, commonDir: worldA.identity.commonDir },
        { path: worktree.root, repoId: worldA.identity.repoId, commonDir: worldA.identity.commonDir },
      ],
      skipped: [],
    };

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pauseAll" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemonA.calls.filter((call) => call.method === "runs.pauseAll").length).toBe(1);
    const occurrences = (result.text.match(/3/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("pause 在守护进程仅回执 pausing（未确认暂停）时不报已暂停", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "runs.pause": () => ({ id: "run-1", state: "pausing" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pause", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).not.toContain("已暂停");
  });

  test("pause 在守护进程回执 paused（已确认暂停）时报告已暂停", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "runs.pause": () => ({ id: "run-1", state: "paused" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pause", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(result.text).toContain("已暂停");
  });

  test("resume 调用 runs.resume 并按真实状态回执", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "runs.resume": () => ({ id: "run-1", state: "running" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "resume", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemon.calls.some((call) => call.method === "runs.resume")).toBe(true);
  });

  test("stop 调用 runs.stop 并按真实状态回执", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "runs.stop": () => ({ id: "run-1", state: "stopped" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "stop", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemon.calls.some((call) => call.method === "runs.stop")).toBe(true);
  });

  test("resumeInterrupted 正常路径调用 runs.resumeInterrupted 并按真实状态回执", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({ "runs.resumeInterrupted": () => ({ id: "run-1", state: "running" }) });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "resumeInterrupted", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemon.calls.some((call) => call.method === "runs.resumeInterrupted")).toBe(true);
  });

  test("resumeInterrupted 被拒时回执含守护进程给出的原因，多任务范围（含斜杠）不被截断", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({
      "runs.resumeInterrupted": () => {
        throw new DaemonCallError("shape_violation", "任务 T-1/T-2 关联运行未停止", { tasks: ["T-1", "T-2"] });
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "resumeInterrupted", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("T-1/T-2");
  });

  test("resumeInterrupted 被拒且原因为中文业务文案（含斜杠）时完整保留，不被当作路径截断", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({
      "runs.resumeInterrupted": () => {
        throw new DaemonCallError("not_found", "读/写范围冲突，请先释放");
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "resumeInterrupted", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("读/写范围冲突，请先释放");
  });

  test("pauseAll 广播到工作区内每个仓库，回执含 workspace.repos 目录名与真实计数，不出现 [object Object]", async () => {
    const worldA = await setupRepoWorld();
    const worldB = await setupNestedRepoWorld();
    const daemonA = createFakeDaemonClient({ "runs.pauseAll": () => ({ pausedCount: 5 }) });
    const daemonB = createFakeDaemonClient({ "runs.pauseAll": () => ({ pausedCount: 7 }) });
    const clients = createFakeWorkspaceClients({
      [worldA.identity.repoId]: daemonA.client,
      [worldB.identity.repoId]: daemonB.client,
    });
    const workspace = buildWorkspace([worldA, worldB]);

    const result = await withTempEnv(worldA.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pauseAll" }, worldA.repo.root);
    });

    expect(result.details.isError).toBeFalsy();
    expect(daemonA.calls.some((call) => call.method === "runs.pauseAll")).toBe(true);
    expect(daemonB.calls.some((call) => call.method === "runs.pauseAll")).toBe(true);
    expect(result.text).toContain(basename(worldA.repo.root));
    expect(result.text).toContain(basename(worldB.repo.root));
    expect(result.text).toContain("5");
    expect(result.text).toContain("7");
    expect(result.text).not.toContain("[object Object]");
  });
});

describe("守护进程不可达时五个工具的行为", () => {
  test("dispatch 在守护进程不可达时返回不可达原因，不在窗口内执行", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createUnreachableDaemonClient("连接已重置");
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不可达");
    expect(daemon.calls.length).toBe(0);
  });

  test("review 在守护进程不可达时返回不可达原因", async () => {
    const world = await setupRepoWorld();
    const daemon = createUnreachableDaemonClient("连接已重置");
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不可达");
  });

  test("reply 在守护进程不可达时返回不可达原因", async () => {
    const world = await setupRepoWorld();
    const daemon = createUnreachableDaemonClient("连接已重置");
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_reply");
      return callTool(tool, { questionId: "q-1", answer: "好的" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不可达");
  });

  test("forward 在守护进程不可达时返回不可达原因", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "executing");
    const daemon = createUnreachableDaemonClient("连接已重置");
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_forward");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, message: "补充说明" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不可达");
  });

  test("agents 在守护进程不可达时返回不可达原因", async () => {
    const world = await setupRepoWorld();
    const daemon = createUnreachableDaemonClient("连接已重置");
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pause", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).toContain("不可达");
  });
});

describe("五个工具的 catch 分支也经 briefReason 兜底", () => {
  const longPath = "/Users/x/.pi/agent/pi-company/repos/abc/daemon.sock";
  const logTail = "x".repeat(5 * 1024);
  const rawReason = `连接失败: ${longPath}\n日志尾: ${logTail}`;

  test("dispatch 在守护进程 reject 含绝对路径与日志尾时，回执不含该路径且长度受限", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createFakeDaemonClient({
      "dispatch.requirement": () => {
        throw new Error(rawReason);
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain(longPath);
    expect(result.text.length).toBeLessThan(500);
  });

  test("review 在守护进程 reject 含绝对路径与日志尾时，回执不含该路径且长度受限", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({
      "dispatch.review": () => {
        throw new Error(rawReason);
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_review");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, baseline: "main" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain(longPath);
    expect(result.text.length).toBeLessThan(500);
  });

  test("forward 在守护进程 reject 含绝对路径与日志尾时，回执不含该路径且长度受限", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "executing");
    const daemon = createFakeDaemonClient({
      "relay.forward": () => {
        throw new Error(rawReason);
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_forward");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root, message: "补充说明" }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain(longPath);
    expect(result.text.length).toBeLessThan(500);
  });

  test("agents pause（单运行）在守护进程 reject 含绝对路径与日志尾时，回执不含该路径且长度受限", async () => {
    const world = await setupRepoWorld();
    const daemon = createFakeDaemonClient({
      "runs.pause": () => {
        throw new Error(rawReason);
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_agents");
      return callTool(tool, { action: "pause", runId: "run-1", cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
    expect(result.text).not.toContain(longPath);
    expect(result.text.length).toBeLessThan(500);
  });
});

describe("信号中止与非 Error 拒绝的兜底", () => {
  test(
    "守护进程对某方法永不响应时，AbortSignal 触发后 execute 在 1 秒内返回含已停止等待与核对字样的中止回执",
    async () => {
      const world = await setupRepoWorld();
      await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
      const daemon = createFakeDaemonClient({ "dispatch.requirement": () => new Promise(() => {}) });
      const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
      const workspace = buildWorkspace([world]);

      const result = await withTempEnv(world.home, async () => {
        const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
        const controller = new AbortController();
        const start = Date.now();
        const promise = tool.execute(
          "call-1",
          { requirement: REQUIREMENT, cwd: world.repo.root },
          controller.signal,
          undefined,
          fakeCtx({ cwd: world.repo.root }),
        );
        controller.abort();
        const settled = await promise;
        expect(Date.now() - start).toBeLessThan(1000);
        return settled;
      });

      expect((result as { details: { isError: boolean } }).details.isError).toBe(true);
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
      expect(text).toContain("已停止等待");
      expect(text).toContain("核对");
      expect(text).not.toContain("未执行");
      expect(text).not.toContain("未发生");
    },
    2000,
  );

  test("守护进程以非 Error 值 reject 时，工具仍返回 isError 结果而非抛出", async () => {
    const world = await setupRepoWorld();
    await seedRequirementState(world.home.dataRoot, world.identity.repoId, REQUIREMENT, "confirmed");
    const daemon = createFakeDaemonClient({
      "dispatch.requirement": () => {
        throw "字符串错误";
      },
    });
    const clients = createFakeWorkspaceClients({ [world.identity.repoId]: daemon.client });
    const workspace = buildWorkspace([world]);

    const result = await withTempEnv(world.home, async () => {
      const tool = findTool(registerTools(clients, workspace), "pi_company_dispatch");
      return callTool(tool, { requirement: REQUIREMENT, cwd: world.repo.root }, world.repo.root);
    });

    expect(result.details.isError).toBe(true);
  });
});

describe("renderCall 与 renderResult 的渲染契约", () => {
  const registered = registerTools(createFakeWorkspaceClients({}), EMPTY_WORKSPACE);
  const sampleArgs: Record<string, Record<string, unknown>> = {
    pi_company_dispatch: { requirement: REQUIREMENT, cwd: "/repo" },
    pi_company_review: { requirement: REQUIREMENT, cwd: "/repo", baseline: "main" },
    pi_company_reply: { questionId: "q-1", answer: "好的" },
    pi_company_forward: { requirement: REQUIREMENT, cwd: "/repo", message: "补充" },
    pi_company_agents: { action: "list" },
  };

  for (const name of TOOL_NAMES) {
    test(`${name} 声明 renderShell 为 self`, () => {
      const tool = findTool(registered, name);
      expect(tool.renderShell).toBe("self");
    });

    test(`${name} 的 renderCall 渲染为长度 0 的数组`, () => {
      const tool = findTool(registered, name);
      if (!tool.renderCall) throw new Error(`${name} 未提供 renderCall`);
      const args = sampleArgs[name] as Record<string, unknown>;
      const component = tool.renderCall(args, fakeTheme(), fakeRenderContext(args));
      expect(component.render(80)).toEqual([]);
    });

    test(`${name} 的 renderResult 渲染为长度 0 的数组`, () => {
      const tool = findTool(registered, name);
      if (!tool.renderResult) throw new Error(`${name} 未提供 renderResult`);
      const args = sampleArgs[name] as Record<string, unknown>;
      const syntheticResult = { content: [{ type: "text", text: "示例回执" }], details: { isError: false } };
      const component = tool.renderResult(syntheticResult, { expanded: false, isPartial: false }, fakeTheme(), fakeRenderContext(args));
      expect(component.render(80)).toEqual([]);
    });
  }
});
