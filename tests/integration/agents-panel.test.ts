import { temporaryRoot } from "../helpers/temporary-root.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import agentsUiExtension from "../../extensions/agents-ui.ts";
import type { AgentsUiDeps } from "../../extensions/agents-ui.ts";
import { currentDock } from "../../extensions/lifecycle.ts";
import type { WindowContextValue } from "../../extensions/lifecycle.ts";
import { AgentsActivity } from "../../runtime/agents-activity.ts";
import type { AgentsPanel } from "../../runtime/agents-panel.ts";
import { createClock } from "../../runtime/clock.ts";
import { collectGitSnapshot } from "../../runtime/git-snapshot.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import type { DaemonClient } from "../../runtime/daemon-client.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import type { RepositoryIdentity } from "../../runtime/identity.ts";
import { createFakeTimeSource } from "../helpers/fake-clock.ts";
import type { FakeTimeSource } from "../helpers/fake-clock.ts";
import { killDaemon, resolveSdkDir, startDaemonForTest } from "../helpers/daemon-harness.ts";
import type { DaemonHandle } from "../helpers/daemon-harness.ts";
import { createFakePi } from "../helpers/fake-pi.ts";
import { modelProviderEnv, writeTestModelProviders } from "../helpers/daemon-model-fixture.ts";
import type { TestProviderScript } from "../helpers/daemon-model-fixture.ts";
import type { ScriptedReply } from "../helpers/controlled-provider.ts";
import { GIT_ENV, createRepoFixture, removeRepoFixture } from "../helpers/repo-fixture.ts";
import type { RepoFixture } from "../helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";
import type { TempHome } from "../helpers/temp-home.ts";
import { pressKeys, renderComponent } from "../helpers/virtual-terminal.ts";

const execFileAsync = promisify(execFile);

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  escape: "\x1b",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await delay(50);
  }
}

async function headCommit(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, env: GIT_ENV });
  return stdout.trim();
}

function textReply(text: string, chunkDelayMs?: number): ScriptedReply {
  return chunkDelayMs === undefined ? { type: "text", text } : { type: "text", text, chunkDelayMs };
}

function reviewSubmission(head: string, fingerprint: string): ScriptedReply {
  return {
    type: "toolcall",
    name: "structured_output",
    input: {
      phase: "review",
      verdict: "PASS",
      summary: "集成测试固定审查通过",
      issues: [],
      evidence: ["集成测试固定证据"],
      reviewedHead: head,
      contentFingerprint: fingerprint,
      traceability: [{ ref: "AC-1", test: "test-1", implementation: "impl-1" }],
      findings: [],
    },
  };
}

// 承载一个 pi-tui Component：编辑栏（顶部）→ 原状态栏（不可选中的汇总文本）→ Agents 面板（widget，最下方）；
// "查看" 打开时只替换编辑栏一行，状态栏与面板保持可见——照 cross-window-panel / transcript-view 的位置约定拼装成一个可挂进 VirtualTerminal 的宿主外壳
class IntegrationShell implements Component {
  editorText = "";
  readonly statusSummaryText = "会话状态汇总：仅供展示，不可选中";
  private widgetFactory: ((tui: unknown, theme: unknown) => Component) | undefined;
  private widgetComponent: Component | undefined;
  private customComponent: Component | undefined;
  private dockKeyHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  private readonly fakeTui = {
    mode: "regular" as const,
    hasOverlay: () => false,
    getFocusedComponent: () => undefined,
    requestRender: () => {},
    terminal: { rows: 40, columns: 100 },
  };

  readonly ui = {
    setWidget: (_key: string, content: unknown, _options?: { placement?: string }): void => {
      if (typeof content !== "function") {
        this.widgetFactory = undefined;
        this.widgetComponent = undefined;
        return;
      }
      this.widgetFactory = content as (tui: unknown, theme: unknown) => Component;
      this.widgetComponent = this.widgetFactory(this.fakeTui, {});
    },
    onTerminalInput: (
      handler: (data: string) => { consume?: boolean; data?: string } | undefined,
    ): (() => void) => {
      this.dockKeyHandler = handler;
      return () => {
        if (this.dockKeyHandler === handler) this.dockKeyHandler = undefined;
      };
    },
    getEditorText: (): string => this.editorText,
    notify: (_message: string, _level?: string): void => {},
    custom: <T,>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
      _options?: { overlay?: boolean },
    ): Promise<T> => {
      return new Promise((resolve) => {
        const done = (result: T): void => {
          this.customComponent = undefined;
          resolve(result);
        };
        this.customComponent = factory(this.fakeTui, {}, {}, done);
      });
    },
  };

  panel(): AgentsPanel | undefined {
    return this.widgetComponent as AgentsPanel | undefined;
  }

  viewingTranscript(): boolean {
    return this.customComponent !== undefined;
  }

  // render() 只暴露查看页的首行（用于拼装成输入栏那一行），实时跟随断言需要查看页的完整多行内容
  viewingLines(width: number): string[] | undefined {
    return this.customComponent?.render(width);
  }

  setEditorText(text: string): void {
    this.editorText = text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.customComponent ? this.customComponent.render(width)[0] ?? "" : `> ${this.editorText}`);
    lines.push(this.statusSummaryText);
    if (this.widgetComponent) lines.push(...this.widgetComponent.render(width));
    return lines;
  }

  handleInput(data: string): void {
    if (this.customComponent) {
      this.customComponent.handleInput?.(data);
      return;
    }
    const result = this.dockKeyHandler?.(data);
    if (result?.consume) return;
    this.applyEditorKey(data);
  }

  invalidate(): void {}

  private applyEditorKey(data: string): void {
    if (data === "\x7f" || data === "\b") {
      this.editorText = this.editorText.slice(0, -1);
      return;
    }
    if (/^[\x20-\x7e]$/.test(data)) this.editorText += data;
  }
}

interface World {
  home: TempHome;
  repo: RepoFixture;
  identity: RepositoryIdentity;
  agentDir: string;
  dataRoot: string;
  handle: DaemonHandle;
  client: DaemonClient;
  prevAgentDirEnv: string | undefined;
}

const activeWorlds: World[] = [];

afterEach(async () => {
  for (const world of activeWorlds.splice(0)) {
    world.client.close();
    await killDaemon(world.handle).catch(() => undefined);
    if (world.prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = world.prevAgentDirEnv;
    await removeRepoFixture(world.repo).catch(() => undefined);
    await removeTempHome(world.home).catch(() => undefined);
    await rm(world.dataRoot, { recursive: true, force: true });
  }
});

async function startWorld(input: TestProviderScript[] | ((repo: RepoFixture) => Promise<TestProviderScript[]>)): Promise<World> {
  const home = await createTempHome();
  const repo = await createRepoFixture();
  const scripts = typeof input === "function" ? await input(repo) : input;
  const identity = await repositoryIdentity(repo.root);
  const agentDir = home.agentDir;
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  await rmdir(home.dataRoot);
  await symlink(dataRoot, home.dataRoot);
  const socketPath = daemonSocketPath(dataRoot, identity.repoId);
  const providersPath = await writeTestModelProviders(dataRoot, scripts);
  const handle = await startDaemonForTest(
    { home, repoDir: identity.commonDir, dataRoot, socketPath },
    { extraEnv: modelProviderEnv(providersPath) },
  );
  const prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const client = await connectDaemon({
    repoDir: repo.root,
    dataRoot,
    sdkDir: resolveSdkDir(),
    hello: {
      windowId: "test-window",
      pid: process.pid,
      sessionId: "test-session",
      cwd: repo.root,
      workspaceRoot: repo.root,
    },
  });
  const world: World = { home, repo, identity, agentDir, dataRoot, handle, client, prevAgentDirEnv };
  activeWorlds.push(world);
  return world;
}

interface Mounted {
  harness: IntegrationShell;
  fakeClock: FakeTimeSource;
  getActivity: () => AgentsActivity | undefined;
  fakePi: ReturnType<typeof createFakePi>;
  ctx: { mode: string; hasUI: boolean; cwd: string; ui: IntegrationShell["ui"] };
}

async function mountShell(world: World): Promise<Mounted> {
  const harness = new IntegrationShell();
  const fakeClock = createFakeTimeSource();
  let capturedActivity: AgentsActivity | undefined;
  const fakePi = createFakePi();

  const windowContextValue: WindowContextValue = {
    windowId: "test-window",
    sessionId: "test-session",
    workspace: {
      repos: [{ repoId: world.identity.repoId, path: world.repo.root, commonDir: world.identity.commonDir }],
      skipped: [],
    },
    clients: {
      forRepo: (id: string) => (id === world.identity.repoId ? world.client : undefined),
      all: () => [world.client],
      skipped: () => [],
      workspace: () => ({
        repos: [{ repoId: world.identity.repoId, path: world.repo.root, commonDir: world.identity.commonDir }],
        skipped: [],
      }),
      closeAll: () => {},
    },
  };

  const deps: AgentsUiDeps = {
    windowReady: () => Promise.resolve(windowContextValue),
    createClock: () => createClock({ timeSource: fakeClock }),
    createAgentsActivity: (options) => {
      capturedActivity = new AgentsActivity(options);
      return capturedActivity;
    },
  };
  agentsUiExtension(fakePi.pi, deps);

  const ctx = { mode: "tui", hasUI: true, cwd: world.repo.root, ui: harness.ui };
  await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
  await waitFor(() => harness.panel() !== undefined, 5_000);

  return { harness, fakeClock, getActivity: () => capturedActivity, fakePi, ctx };
}

async function unmountShell(mounted: Mounted): Promise<void> {
  await mounted.fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, mounted.ctx);
}

// 派工脚本已经在 startWorld 时随 scripts 数组整体登记进守护进程启动环境，这里只负责触发派工
async function dispatchReviewRun(world: World, requirement: string): Promise<string> {
  const snapshot = await collectGitSnapshot({ repoRoot: world.repo.root });
  const result = await world.client.call("dispatch.review", {
    requirement,
    cwd: world.repo.root,
    baseline: "HEAD",
    snapshot: { head: snapshot.head, fingerprint: snapshot.fingerprint },
  });
  return result.runId as string;
}

function renderShell(harness: IntegrationShell): Promise<string[]> {
  return renderComponent(harness, 100, 40);
}

function pressShellKeys(harness: IntegrationShell, keys: string[]): Promise<string[][]> {
  return pressKeys(harness, keys, 100, 40);
}

describe("集成：Agents 面板顺序与导航", () => {
  test(
    "空输入按 ↓ 直接进入代理面板，面板内 Esc 回到输入栏",
    async () => {
      const requirement = "2026-09-10.nav-demo";
      const scripts: TestProviderScript[] = [
        {
          providerId: "controlled-reviewer-nav",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [textReply("持续运行中", 20_000)],
        },
      ];
      const world = await startWorld(scripts);
      const mounted = await mountShell(world);
      try {
        await dispatchReviewRun(world, requirement);
        await waitFor(() => mounted.harness.panel()?.hasRows() === true);

        const before = await renderShell(mounted.harness);
        expect(before.some((line) => line.startsWith("> "))).toBe(true);

        const afterDown = await pressShellKeys(mounted.harness, [KEY.down]);
        expect(currentDock()?.focus()).toBe("panel");
        expect(afterDown[0]?.some((line) => line.includes("暂停") || line.includes("停止"))).toBe(true);

        const afterEscape = await pressShellKeys(mounted.harness, [KEY.escape]);
        expect(currentDock()?.focus()).toBe("editor");
        expect(afterEscape[0]?.some((line) => line.startsWith("> "))).toBe(true);
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});

describe("集成：状态栏与汇总文本", () => {
  test(
    "原状态栏与汇总文本在面板导航期间始终可见，且不出现在可选中的行里",
    async () => {
      const requirement = "2026-09-10.status-demo";
      const scripts: TestProviderScript[] = [
        {
          providerId: "controlled-reviewer-status",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [textReply("持续运行中", 20_000)],
        },
      ];
      const world = await startWorld(scripts);
      const mounted = await mountShell(world);
      try {
        await dispatchReviewRun(world, requirement);
        await waitFor(() => mounted.harness.panel()?.hasRows() === true);

        const before = await renderShell(mounted.harness);
        expect(before).toContain(mounted.harness.statusSummaryText);

        // 进入面板后反复上下移动光标，状态栏文本内容与行数必须原样保留，
        // 且它本身从未被面板当作一个可选中的行渲染（面板行都带状态/轮次/耗时字段，纯汇总文本行没有）
        const traces = await pressShellKeys(mounted.harness, [KEY.down, KEY.down, KEY.up, KEY.down]);
        for (const snapshot of traces) {
          expect(snapshot).toContain(mounted.harness.statusSummaryText);
          const statusLineIndex = snapshot.indexOf(mounted.harness.statusSummaryText);
          expect(statusLineIndex).toBe(1);
        }

        const panelSelectable = mounted.harness.panel()?.selectedRunId();
        expect(panelSelectable).toBeDefined();
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});

describe("集成：面板不抢按键", () => {
  test(
    "输入栏非空或设置页占用时，↓ 不进入面板",
    async () => {
      const requirement = "2026-09-10.no-steal-demo";
      const scripts: TestProviderScript[] = [
        {
          providerId: "controlled-reviewer-nosteal",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [textReply("持续运行中", 20_000)],
        },
      ];
      const world = await startWorld(scripts);
      const mounted = await mountShell(world);
      try {
        await dispatchReviewRun(world, requirement);
        await waitFor(() => mounted.harness.panel()?.hasRows() === true);

        mounted.harness.setEditorText("draft");
        await pressShellKeys(mounted.harness, [KEY.down]);
        expect(currentDock()?.focus()).toBe("editor");
        const rendered = await renderShell(mounted.harness);
        expect(rendered.some((line) => line.startsWith("> draft"))).toBe(true);

        mounted.harness.setEditorText("");
        currentDock()?.markPageOpen();
        try {
          await pressShellKeys(mounted.harness, [KEY.down]);
          expect(currentDock()?.focus()).toBe("editor");
        } finally {
          currentDock()?.markPageClosed();
        }
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});

describe("集成：查看页", () => {
  test(
    "面板内按查看后输入栏替换为实时跟随视图，Esc 回到原选中位置",
    async () => {
      const requirement = "2026-09-10.view-demo";
      const scripts: TestProviderScript[] = [
        {
          providerId: "controlled-reviewer-view",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [textReply("持续运行中", 20_000)],
        },
      ];
      const world = await startWorld(scripts);
      const mounted = await mountShell(world);
      try {
        const runId = await dispatchReviewRun(world, requirement);
        await waitFor(() => mounted.harness.panel()?.hasRows() === true);

        await pressShellKeys(mounted.harness, [KEY.down]);
        expect(currentDock()?.focus()).toBe("panel");

        // running 状态按钮为 暂停/停止/查看，光标默认落在"暂停"，右移两次到"查看"再回车
        await pressShellKeys(mounted.harness, [KEY.right, KEY.right, KEY.enter]);
        await waitFor(() => mounted.harness.viewingTranscript(), 5_000);

        const viewing = await renderShell(mounted.harness);
        expect(viewing.some((line) => line.startsWith("> "))).toBe(false);
        expect(viewing.some((line) => line.includes("运行中") || line.includes("已结束") || line.includes("不可达") || line.includes("记录不可读"))).toBe(true);

        await pressShellKeys(mounted.harness, [KEY.escape]);
        await waitFor(() => !mounted.harness.viewingTranscript(), 5_000);
        await waitFor(() => currentDock()?.focus() === "panel", 5_000);

        const restored = await renderShell(mounted.harness);
        expect(restored.some((line) => line.startsWith("> "))).toBe(true);
        expect(mounted.harness.panel()?.selectedRunId()).toBe(runId);
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});

describe("集成：查看页实时跟随", () => {
  test(
    "查看页停留期间会话产生新的文本内容，不关闭重开即应展现最新内容",
    async () => {
      const requirement = "2026-09-10.live-follow-demo";
      const MARKER = `独立标记-实时跟随-${randomUUID()}`;
      const scripts: TestProviderScript[] = [
        { providerId: "controlled-reviewer-live", modelId: "controlled-model", roleName: "reviewer", replies: [textReply(MARKER, 2_500)] },
      ];
      const world = await startWorld(scripts);
      const mounted = await mountShell(world);
      try {
        await dispatchReviewRun(world, requirement);
        await waitFor(() => mounted.harness.panel()?.hasRows() === true);

        await pressShellKeys(mounted.harness, [KEY.down]);
        await pressShellKeys(mounted.harness, [KEY.right, KEY.right, KEY.enter]);
        await waitFor(() => mounted.harness.viewingTranscript(), 5_000);

        const beforeText = (mounted.harness.viewingLines(120) ?? []).join("\n");
        expect(beforeText).not.toContain(MARKER);

        // 受控 provider 延迟 2.5 秒后才把这条真实回复落盘；查看页停留期间应当自动展现最新内容，而不必关闭重开
        await delay(4_000);
        const afterText = (mounted.harness.viewingLines(120) ?? []).join("\n");

        await pressShellKeys(mounted.harness, [KEY.escape]);
        await waitFor(() => !mounted.harness.viewingTranscript(), 5_000);

        expect(afterText).toContain(MARKER);
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});

describe("集成：结束条目 20 秒保留", () => {
  test(
    "运行结束后条目第 19 秒仍在列表中，跨过 20 秒后被移出",
    async () => {
      const requirement = "2026-09-10.retention-demo";
      const world = await startWorld(async (repo) => {
        const snapshot = await collectGitSnapshot({ repoRoot: repo.root });
        return [
        {
          providerId: "controlled-reviewer-retention",
          modelId: "controlled-model",
          roleName: "reviewer",
          replies: [reviewSubmission(snapshot.head, snapshot.fingerprint), textReply("完成")],
        },
        ];
      });
      const mounted = await mountShell(world);
      try {
        const snapshot = await collectGitSnapshot({ repoRoot: world.repo.root });
        const result = await world.client.call("dispatch.review", {
          requirement,
          cwd: world.repo.root,
          baseline: "HEAD",
          snapshot: { head: snapshot.head, fingerprint: snapshot.fingerprint },
        });
        expect(typeof result.runId).toBe("string");

        await waitFor(() => {
          const rows = mounted.getActivity()?.rows() ?? [];
          return rows.some((row) => row.status === "completed");
        }, 15_000);

        const atCompletion = await renderShell(mounted.harness);
        expect(atCompletion.some((line) => line.includes("已完成"))).toBe(true);

        mounted.fakeClock.advance(19_000);
        const at19s = await renderShell(mounted.harness);
        expect(at19s.some((line) => line.includes("已完成"))).toBe(true);

        mounted.fakeClock.advance(2_000);
        const at21s = await renderShell(mounted.harness);
        expect(at21s.some((line) => line.includes("已完成"))).toBe(false);
      } finally {
        await unmountShell(mounted);
      }
    },
    30_000,
  );
});


test("晚打开面板通过真实订阅快照显示此前已派出的运行", async () => {
  const requirement = "2026-09-10.initial-panel-snapshot";
  const world = await startWorld([{ providerId: "controlled-snapshot", modelId: "controlled-model", roleName: "reviewer", replies: [textReply("等待资料", 20000)] }]);
  const runId = await dispatchReviewRun(world, requirement);
  const subscribed = await world.client.call("subscribe.activity", {});
  expect((subscribed.snapshot as Array<{ id: string }>).some((run) => run.id === runId)).toBe(true);
  const mounted = await mountShell(world);
  try {
    await waitFor(() => mounted.getActivity()?.rows().some((row) => row.id === runId) === true);
    expect((await renderShell(mounted.harness)).join("\n")).toContain("pi-company.reviewer");
  } finally { await unmountShell(mounted); }
}, 30000);
