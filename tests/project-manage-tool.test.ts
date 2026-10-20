import { answeringUi } from "./helpers/window-host.ts";
import type { WindowDecision } from "./helpers/window-host.ts";
import { repositoryDatabase, UUID_V7_PATTERN, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import projectManageExtension from "../src/modules/project-index/project-manage-extension.ts";
import { createProjectManageTool, PROJECT_MANAGE_PARAMETERS } from "../src/modules/project-index/project-manage-tool.ts";
import type {
  OpenProjectIndexService,
  ProjectIndexServiceHandle,
  ProjectManageHostContext,
} from "../src/modules/project-index/project-manage-tool.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { RequirementCloseService } from "../src/modules/delivery/workflow-close.ts";
import { MANAGED_WORKSPACES, workspaceLocation } from "../src/modules/delivery/workspace-manage.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";


const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(temporaryRoot(), "project-manage-tool-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const dataRoot = join(root, "data");
  await mkdir(repositoryRoot);
  await mkdir(dataRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFile(join(repositoryRoot, "README.md"), "fixture\n");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
  const identity = await repositoryIdentity(repositoryRoot);
  const repoDataRoot = join(dataRoot, "repos", identity.repoId);
  await mkdir(repoDataRoot, { recursive: true });
  for (const path of [dataRoot, join(dataRoot, "repos"), repoDataRoot]) await chmod(path, 0o700);
  const host: ProjectManageHostContext = {
    windowId: "window-main",
    sessionId: "session-main",
    repositories: new Map([[identity.repoId, { path: repositoryRoot }]]),
  };
  return { root, repositoryRoot, dataRoot, repoId: identity.repoId, host };
}

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

function context(
  sessionId: string,
  confirm: (title: string, message: string) => Promise<WindowDecision>,
  hasUI = true,
): ExtensionContext {
  return {
    cwd: "/not-used",
    mode: hasUI ? "rpc" : "print",
    hasUI,
    ui: answeringUi((window) => confirm(window.title, window.text)),
    sessionManager: { getSessionId: () => sessionId } as never,
  } as ExtensionContext;
}

function statusResult(repoId: string) {
  return {
    action: "status",
    workspace: { workspaceId: "b".repeat(64), repoId, root: "/must/not/escape", branch: "private-branch" },
    head: "c".repeat(40),
    initialized: false,
    cacheVerified: false,
    index: null,
    body: "PRD_BODY_SENTINEL",
  };
}

function budgetResult() {
  return {
    limits: { maxFileBytes: 2 * 1024 * 1024, maxTotalTextBytes: 20 * 1024 * 1024, maxEntries: 20_000, maxDepth: 64 },
    used: { entries: 12, textBytes: 3456 },
    exhausted: ["depth"],
    stoppedReason: "complete",
  };
}

function runtimeFor(
  world: Awaited<ReturnType<typeof fixture>>,
  openService: OpenProjectIndexService,
  getCurrentHost: () => ProjectManageHostContext = () => world.host,
) {
  const runtime = createProjectManageTool({
    dataRoot: world.dataRoot,
    resolveHost: async () => getCurrentHost(),
    currentHost: () => getCurrentHost(),
    openService,
  });
  runtime.startSession(world.host);
  return runtime;
}

async function call(
  runtime: ReturnType<typeof runtimeFor>,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  return runtime.tool.execute("tool-call", { request: params } as never, signal, undefined, ctx);
}

describe("project_manage 固定输入与主代理宿主边界", () => {
  test("公开 schema 仅有固定 action、repoId、init 预览位与工作区需求/操作 ID，不接受路径/身份/正文/SQL/Git 字段", () => {
    const base = { action: "init", repoId: "a".repeat(64), preview: true };
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: base })).toBe(true);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, base)).toBe(false);
    for (const forged of [
      { path: "/tmp/repo" }, { root: "/tmp/repo" }, { dataRoot: "/tmp/data" }, { cwd: "/tmp/repo" },
      { role: "main" }, { actor: "user" }, { approved: true }, { sql: "select *" }, { body: "secret" },
      { command: "git status" }, { gitArgs: ["status"] }, { limits: { maxEntries: 999_999 } },
    ]) expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { ...base, ...forged } })).toBe(false);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { action: "recovery-check", repoId: base.repoId, snapshotPath: "/tmp/x" } })).toBe(false);
  });

  test("preview 只能是 init 的 preview=true；未知、未完成 action 和 status/refresh 携带 preview 在执行层默认拒绝", async () => {
    const world = await fixture();
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}),
    }));
    const ctx = context("session-main", async () => true);
    await expect(call(runtime, { action: "workspace-prepare", repoId: world.repoId }, ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(call(runtime, { action: "workspace-prepare", repoId: world.repoId, requirementId: uuidv7() },
      context("session-main", async () => true, false))).rejects.toMatchObject({ code: "workspace_confirmation_required" });
    await expect(call(runtime, { action: "init", repoId: world.repoId, preview: true, requirementId: uuidv7() }, ctx))
      .rejects.toThrow("多余字段：requirementId；本动作允许字段：action、repoId、preview");
    await expect(runtime.tool.execute("flat", { action: "status", repoId: world.repoId } as never, undefined, undefined, ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(call(runtime, { action: "workspace-prepare", repoId: world.repoId, requirementId: uuidv7(), preview: true }, ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(call(runtime, { action: "workspace-recycle", repoId: world.repoId, requirementId: uuidv7() },
      context("session-main", async () => true, false))).rejects.toMatchObject({ code: "workspace_confirmation_required" });
    await expect(call(runtime, { action: "status", repoId: world.repoId, preview: true }, ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(call(runtime, { action: "refresh", repoId: world.repoId, preview: false }, ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    await runtime.shutdown();
  });

  test("repoId 只能选择 lifecycle Map 中的真实仓库，session/window/当前 Map 任一变化都会拒绝", async () => {
    const world = await fixture();
    let current = world.host;
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => statusResult(world.repoId),
    }), () => current);
    const ctx = context("session-main", async () => true);
    await expect(call(runtime, { action: "status", repoId: "f".repeat(64) }, ctx)).rejects.toMatchObject({ code: "foreign_repo" });
    await expect(call(runtime, { action: "status", repoId: world.repoId }, context("other-session", async () => true))).rejects.toMatchObject({ code: "stale_session" });
    current = { ...world.host, windowId: "window-replaced" };
    await expect(call(runtime, { action: "status", repoId: world.repoId }, ctx)).rejects.toMatchObject({ code: "stale_window" });
    await runtime.shutdown();
  });

  test("dataRoot 位于仓库内时在服务打开前拒绝", async () => {
    const world = await fixture();
    let opened = false;
    const runtime = createProjectManageTool({
      dataRoot: join(world.repositoryRoot, "local-index"),
      resolveHost: async () => world.host,
      currentHost: () => world.host,
      openService: async () => { opened = true; throw new Error("must not open"); },
    });
    runtime.startSession(world.host);
    await expect(call(runtime, { action: "status", repoId: world.repoId }, context("session-main", async () => true))).rejects.toMatchObject({ code: "unsafe_data_root" });
    expect(opened).toBe(false);
    await runtime.shutdown();
  });

  test("dataRoot/repos/repoId 被替换为指向 worktree 的符号链接时 HOST 在 service 打开前拒绝", async () => {
    const world = await fixture();
    const repoDataRoot = join(world.dataRoot, "repos", world.repoId);
    const trap = join(world.repositoryRoot, "index-trap");
    await rm(repoDataRoot, { recursive: true, force: true });
    await mkdir(trap);
    await symlink(trap, repoDataRoot, "dir");
    let opened = false;
    const runtime = runtimeFor(world, async () => {
      opened = true;
      return { preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) };
    });
    await expect(call(runtime, { action: "status", repoId: world.repoId }, context("session-main", async () => true))).rejects.toMatchObject({ code: "unsafe_data_root" });
    expect(opened).toBe(false);
    await runtime.shutdown();
  });
});

describe("扫描确认、启动前与结束后核对、有限输出", () => {
  test("preview 一次枚举确认不升级持续权限，init 另经真实 UI 确认后 refresh 在同 session 复用", async () => {
    const world = await fixture();
    const calls: string[] = [];
    const receivedOptions: unknown[] = [];
    let confirms = 0;
    let confirmation = "";
    const openService: OpenProjectIndexService = async (input) => {
      const workspaceId = "d".repeat(64);
      expect(input.repositoryRoot).toBe(world.repositoryRoot);
      expect(input.dataRoot).toBe(world.dataRoot);
      expect(input.repoId).toBe(world.repoId);
      const service: ProjectIndexServiceHandle = {
        async preview(options) {
          calls.push("preview"); receivedOptions.push(options);
          return { action: "preview", workspace: { workspaceId, repoId: world.repoId, root: world.repositoryRoot, branch: "main" }, files: [], skipped: [], archives: { metadata: [], issues: [] }, partial: false, databaseCreated: false };
        },
        async init(options) { calls.push("init"); receivedOptions.push(options); return { action: "init", status: "ready", generation: 1, files: 1, skipped: [], partial: false }; },
        async refresh(options) { calls.push("refresh"); receivedOptions.push(options); return { action: "refresh", status: "ready", generation: 1, files: 1, skipped: [], partial: false }; },
        async status() { calls.push("status"); return statusResult(world.repoId); },
      };
      return service;
    };
    const runtime = runtimeFor(world, openService);
    const ctx = context("session-main", async (_title, message) => { confirms += 1; confirmation = message; return true; });

    await call(runtime, { action: "init", repoId: world.repoId, preview: true }, ctx);
    await call(runtime, { action: "init", repoId: world.repoId }, ctx);
    await call(runtime, { action: "refresh", repoId: world.repoId }, ctx);

    expect(calls).toEqual(["preview", "init", "refresh"]);
    expect(confirms).toBe(2);
    expect(confirmation).toContain(`仓库根：${world.repositoryRoot}`);
    expect(confirmation).toContain("docs/prd 只枚举有限路径元数据，不读取正文");
    expect(confirmation).toContain(join(world.dataRoot, "repos", world.repoId));
    expect(confirmation).toContain("窗口关闭后 PM 与子代理仍可查询");
    for (const options of receivedOptions as Array<{ limits: Record<string, number> }>) {
      expect(options.limits).toEqual({ maxFileBytes: 2 * 1024 * 1024, maxTotalTextBytes: 20 * 1024 * 1024, maxEntries: 20_000, maxDepth: 64 });
    }
    await runtime.shutdown();
  });

  test("status 无需扫描确认但只输出绑定仓库最少 metadata；service 正文/根/branch 等额外字段不会外泄", async () => {
    const world = await fixture();
    let confirms = 0;
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), init: async () => ({}), refresh: async () => ({}),
      status: async () => statusResult(world.repoId),
    }));
    const result = await call(runtime, { action: "status", repoId: world.repoId }, context("session-main", async () => { confirms += 1; return true; }));
    const encoded = JSON.stringify(result);
    expect(confirms).toBe(0);
    expect(encoded).toContain(world.repoId);
    expect(encoded).toContain("initialized");
    expect(encoded).not.toContain("PRD_BODY_SENTINEL");
    expect(encoded).not.toContain("must/not/escape");
    expect(encoded).not.toContain("private-branch");
    expect((result.details as { truncation: unknown }).truncation)
      .toMatchObject({ truncated: false, maxBytes: 32 * 1024, maxEntries: 100, maxPathLength: 512 });
    await runtime.shutdown();
  });

  test("真实公开形状保留 building、完整预算、代次/hash/计数及必要 index 状态", async () => {
    const world = await fixture();
    const workspace = { workspaceId: "d".repeat(64), repoId: world.repoId, root: world.repositoryRoot, branch: "refs/heads/main" };
    let confirms = 0;
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}),
      async status() {
        return {
          action: "status",
          workspace,
          head: "a".repeat(40),
          initialized: true,
          cacheVerified: false,
          index: {
            ...workspace,
            status: "building",
            version: 7,
            fence: 11,
            currentGeneration: 3,
            targetGeneration: 4,
            diagnostics: [{ code: "budget_exceeded", path: null }],
            updatedAt: 1_750_000_000_000,
            body: "STATUS_BODY_SENTINEL",
          },
        };
      },
      async init() {
        return {
          action: "init",
          workspace,
          head: "a".repeat(40),
          status: "partial",
          generation: 4,
          parsedFiles: 2,
          reusedFiles: 3,
          readBytes: 4096,
          sourceCodepoints: 2048,
          files: 5,
          symbols: 8,
          codeEdges: 2,
          diagnostics: [{ code: "unsupported_language", path: "tools/check.py", body: "DIAGNOSTIC_BODY_SENTINEL" }],
          skipped: [{ path: ".env", reason: "sensitive", body: "SKIP_BODY_SENTINEL" }],
          archives: { metadata: [], issues: [] },
          budget: budgetResult(),
          body: "BUILD_BODY_SENTINEL",
        };
      },
      async refresh() {
        return {
          action: "refresh",
          workspace,
          head: "b".repeat(40),
          status: "invalid",
          generation: 5,
          parsedFiles: 0,
          reusedFiles: 5,
          readBytes: 4096,
          sourceCodepoints: 0,
          files: 5,
          symbols: 0,
          codeEdges: 0,
          diagnostics: [{ code: "unknown", path: "docs/bad.json" }],
          skipped: [],
          archives: { metadata: [], issues: [] },
          budget: budgetResult(),
        };
      },
    }));
    const ctx = context("session-main", async () => { confirms += 1; return true; });

    const status = await call(runtime, { action: "status", repoId: world.repoId }, ctx);
    expect(status.details).toMatchObject({
      action: "status",
      workspace: { workspaceId: workspace.workspaceId, repoId: world.repoId },
      head: "a".repeat(40),
      initialized: true,
      cacheVerified: false,
      partial: false,
      invalid: false,
      index: {
        status: "building",
        version: 7,
        fence: 11,
        currentGeneration: 3,
        targetGeneration: 4,
        diagnostics: [{ code: "budget_exceeded", path: null }],
        updatedAt: 1_750_000_000_000,
      },
    });
    const initialized = await call(runtime, { action: "init", repoId: world.repoId }, ctx);
    expect(initialized.details).toMatchObject({
      action: "init",
      status: "partial",
      generation: 4,
      partial: true,
      invalid: false,
      parsedFiles: 2,
      reusedFiles: 3,
      readBytes: 4096,
      sourceCodepoints: 2048,
      files: 5,
      symbols: 8,
      codeEdges: 2,
      budget: budgetResult(),
    });
    const refreshed = await call(runtime, { action: "refresh", repoId: world.repoId }, ctx);
    expect(refreshed.details).toMatchObject({
      action: "refresh",
      status: "invalid",
      generation: 5,
      partial: false,
      invalid: true,
      diagnostics: [{ code: "unknown", path: "docs/bad.json" }],
    });
    expect(confirms).toBe(1);
    expect(JSON.stringify([status, initialized, refreshed])).not.toContain("BODY_SENTINEL");
    await runtime.shutdown();
  });

  test("真实确认后操作期间切换HEAD分支，结束后核对拒绝返回结果", async () => {
    const world = await fixture();
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), refresh: async () => ({}), status: async () => ({}),
      async init() {
        await git(world.repositoryRoot, ["switch", "-c", "late-branch"]);
        return { action: "init", status: "ready", generation: 1 };
      },
    }));
    await expect(call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async () => true))).rejects.toMatchObject({ code: "repository_changed" });
    await runtime.shutdown();
  });

  test("关联worktree的真实.git指针和HEAD可正常核验；确认框显示实际被索引的主工作区", async () => {
    const original = await fixture();
    const repositoryRoot = join(original.root, "linked-worktree");
    await git(original.repositoryRoot, ["worktree", "add", "-b", "linked", repositoryRoot]);
    const world = { ...original, repositoryRoot,
      host: { ...original.host, repositories: new Map([[original.repoId, { path: repositoryRoot }]]) } };
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), refresh: async () => ({}), status: async () => ({}),
      async init() {
        return { action: "init", status: "ready", generation: 1 };
      },
    }));
    let message = "";
    expect((await call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async (_title, text) => { message = text; return true; }))).details).toMatchObject({ status: "ready" });
    expect(message).toContain(`仓库根：${await realpath(original.repositoryRoot)}`);
    expect(message).toContain("当前分支：refs/heads/main");
    await runtime.shutdown();
  });

  test("授权后 index.db 被替换为指向 worktree 的链接时，结束后核对拒绝返回结果", async () => {
    const world = await fixture();
    const databasePath = join(world.dataRoot, "repos", world.repoId, "index.db");
    const trap = join(world.repositoryRoot, "index-db-trap");
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), refresh: async () => ({}), status: async () => ({}),
      async init() {
        await writeFile(trap, "do-not-overwrite\n");
        await symlink(trap, databasePath);
        return { action: "init", status: "ready", generation: 1 };
      },
    }));
    await expect(call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async () => true))).rejects.toMatchObject({ code: "repository_changed" });
    expect(await readFile(trap, "utf8")).toBe("do-not-overwrite\n");
    await runtime.shutdown();
  });

  test("输出总项数受限、截断显式，skip/archive issue 优先于普通文件路径且正文 sentinel 不返回", async () => {
    const world = await fixture();
    const files = Array.from({ length: 150 }, (_, index) => ({ path: `src/file-${index}.ts`, kind: "code", language: "ts", size: 1, content: `SOURCE_SENTINEL_${index}` }));
    const runtime = runtimeFor(world, async () => ({
      async preview() {
        return {
          action: "preview",
          partial: true,
          databaseCreated: false,
          invalid: [{ code: "unknown", path: "docs/bad.json", body: "SPEC_SENTINEL" }],
          skipped: [{ path: ".env", reason: "sensitive", body: "PRD_SENTINEL" }],
          archives: { issues: [{ path: "docs/prd/bad", reason: "invalid_archive_name" }], metadata: [] },
          files,
          source: "SOURCE_SENTINEL",
          body: "PRD_SENTINEL",
        };
      },
      init: async () => ({}), refresh: async () => ({}), status: async () => ({}),
    }));
    const result = await call(runtime, { action: "init", repoId: world.repoId, preview: true }, context("session-main", async () => true));
    const encoded = JSON.stringify(result);
    expect(Buffer.byteLength((result.content[0] as { text: string }).text)).toBeLessThanOrEqual(32 * 1024);
    expect(encoded).toContain("sensitive");
    expect(encoded).toContain("invalid_archive_name");
    expect(encoded).not.toContain("SENTINEL");
    expect((result.details as { truncation: { truncated: boolean; omittedEntries: number; invalidOmitted: number } }).truncation).toMatchObject({ truncated: true });
    expect((result.details as { truncation: { omittedEntries: number } }).truncation.omittedEntries).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  test("无 UI、用户拒绝均不生成可复用扫描许可；底层错误使用固定消息且不带正文", async () => {
    const world = await fixture();
    let opens = 0;
    const failing: OpenProjectIndexService = async () => {
      opens += 1;
      return {
        preview: async () => { throw new Error("PRD_ERROR_SENTINEL"); },
        init: async () => { throw new Error("PRD_ERROR_SENTINEL"); },
        refresh: async () => { throw new Error("PRD_ERROR_SENTINEL"); },
        status: async () => { throw new Error("PRD_ERROR_SENTINEL"); },
      };
    };
    const runtime = runtimeFor(world, failing);
    await expect(call(runtime, { action: "init", repoId: world.repoId, preview: true }, context("session-main", async () => true, false))).rejects.toMatchObject({ code: "scan_confirmation_required" });
    await expect(call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async () => false))).rejects.toMatchObject({ code: "scan_declined" });
    expect(opens).toBe(0);
    const error = await call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async () => true)).then(() => undefined, (value) => value as Error);
    expect(error?.message).toBe("one_company_project_manage 的 init 动作失败。\n原因：项目索引操作失败；底层错误可能含正文，不回显\n建议：重试一次；仍然失败就把原因告诉用户");
    expect(error?.message).not.toContain("SENTINEL");
    await runtime.shutdown();
  });
});

describe("取消、session_shutdown 与扩展接线", () => {
  test("session_shutdown 撤销许可、中止操作信号并等待真实操作收尾；新 session 不继承许可", async () => {
    const world = await fixture();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let settled = false;
    let receivedSignal: AbortSignal | undefined;
    let currentHost = world.host;
    const runtime = runtimeFor(world, async () => ({
      preview: async () => ({}), refresh: async () => ({}), status: async () => ({}),
      init: async (options) => {
        receivedSignal = options?.signal;
        startedResolve();
        return new Promise((resolve) => {
          receivedSignal?.addEventListener("abort", () => {
            setTimeout(() => { settled = true; resolve({ action: "init", status: "cancelled", generation: 0 }); }, 20);
          });
        });
      },
    }), () => currentHost);
    const pending = call(runtime, { action: "init", repoId: world.repoId }, context("session-main", async () => true)).then(
      () => undefined,
      (error) => error as { code: string },
    );
    await started;
    expect(receivedSignal?.aborted).toBe(false);
    const shutdown = runtime.shutdown();
    expect(receivedSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    await shutdown;
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ code: "cancelled" });

    const freshHost = { ...world.host, sessionId: "session-fresh", windowId: "window-fresh" };
    currentHost = freshHost;
    runtime.startSession(freshHost);
    await expect(call(runtime, { action: "init", repoId: world.repoId }, context("session-fresh", async () => true, false))).rejects.toMatchObject({ code: "scan_confirmation_required" });
    await runtime.shutdown();
  });

  test("session_shutdown 早于 windowReady 兑现时，旧 session 结果不能重新激活工具", async () => {
    const world = await fixture();
    let resolveWindow!: (window: unknown) => void;
    const pendingWindow = new Promise<unknown>((resolvePromise) => { resolveWindow = resolvePromise; });
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    let registeredTool: ReturnType<typeof createProjectManageTool>["tool"] | undefined;
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: ReturnType<typeof createProjectManageTool>["tool"]) { registeredTool = tool; },
    } as unknown as ExtensionAPI;
    const window = {
      windowId: world.host.windowId,
      sessionId: world.host.sessionId,
      workspace: { repos: [{ repoId: world.repoId, path: world.repositoryRoot, commonDir: join(world.repositoryRoot, ".git") }], skipped: [] },
      clients: { closeAll() {} },
    } as never;
    projectManageExtension(pi, {
      dataRoot: world.dataRoot,
      windowReady: () => pendingWindow as never,
      windowContext: () => window,
      openService: async () => ({ preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) }),
    });
    const ctx = context("session-main", async () => true);
    const startPromise = handlers.get("session_start")![0]!({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("session_shutdown")![0]!({ type: "session_shutdown", reason: "quit" }, ctx);
    resolveWindow(window);
    await startPromise;
    await expect(registeredTool!.execute("call", { request: { action: "status", repoId: world.repoId } } as never, undefined, undefined, ctx)).rejects.toMatchObject({ code: "host_unavailable" });
  });

  test("扩展只登记一个 project_manage，并注册 session_start/session_shutdown 以绑定和清理 lifecycle", async () => {
    const world = await fixture();
    const fakePi = createFakePi();
    const window = {
      windowId: world.host.windowId,
      sessionId: world.host.sessionId,
      workspace: { repos: [{ repoId: world.repoId, path: world.repositoryRoot, commonDir: join(world.repositoryRoot, ".git") }], skipped: [] },
      clients: { closeAll() {} },
    } as never;
    projectManageExtension(fakePi.pi as unknown as ExtensionAPI, {
      dataRoot: world.dataRoot,
      windowReady: async () => window,
      windowContext: () => window,
      openService: async () => ({ preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) }),
    });
    expect(fakePi.registeredTools().map((tool) => tool.name)).toEqual(["one_company_project_manage"]);
    expect(fakePi.handlerCount("session_start")).toBe(1);
    expect(fakePi.handlerCount("session_shutdown")).toBe(1);
    const ctx = context("session-main", async () => true);
    await fakePi.trigger("session_start", { type: "session_start", reason: "startup" }, ctx);
    await fakePi.trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  });
});

describe("project_manage 项目规范 AGENTS.md：只有用户在窗口里选写入才写文件", () => {
  const RULES_V1 = "# 项目规范\n\n- 导出常量用大写下划线命名。\n";
  const RULES_V2 = "# 项目规范\n\n- 导出常量用大写下划线命名。\n- 不使用泛型。\n";
  const service: OpenProjectIndexService = async () => ({ preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) });
  const details = (result: unknown) => (result as { details: Record<string, unknown> }).details;
  const update = (world: Awaited<ReturnType<typeof fixture>>, content: string, ctx: ExtensionContext) =>
    call(runtimeFor(world, service), { action: "conventions-update", repoId: world.repoId, content }, ctx);

  test("M8D2-AC3：首次提出时窗口展示全文，选写入才写文件；选不写入、按 Esc、没有界面、内容过长或参数里伪造确认都不写；再次提出时展示与磁盘现有内容的差异", async () => {
    const world = await fixture();
    const file = join(world.repositoryRoot, "AGENTS.md");
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { action: "conventions-update", repoId: world.repoId, content: RULES_V1, approved: true } })).toBe(false);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { action: "conventions-status", repoId: world.repoId } })).toBe(false);
    await expect(update(world, RULES_V1, context("session-main", async () => "写入", false))).rejects.toMatchObject({ code: "conventions_confirmation_required" });
    for (const decision of ["不写入", false] as const) {
      expect(details(await update(world, RULES_V1, context("session-main", async () => decision)))).toMatchObject({ status: "cancelled" });
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    const noDialog = context("session-main", async () => { throw new Error("不应弹窗"); });
    await expect(update(world, "x".repeat(16 * 1024 + 1), noDialog)).rejects.toMatchObject({ code: "invalid_shape" });
    expect(details(await update(world, "规".repeat(6000), noDialog)))
      .toMatchObject({ status: "blocked", reason: "项目规范内容超出大小上限", next: "精简 AGENTS.md 内容后再提交" });

    const shown: Array<{ title: string; text: string }> = [];
    const write = context("session-main", async (title, text) => { shown.push({ title, text }); return "写入"; });
    expect(details(await update(world, RULES_V1, write))).toMatchObject({ status: "written" });
    expect(shown[0]!.title).toBe("把这些改动写入项目规范 AGENTS.md？");
    expect(shown[0]!.text).toContain("仓库里还没有 AGENTS.md，要写入的全文如下：");
    expect(shown[0]!.text).toContain("+ - 导出常量用大写下划线命名。");
    expect(shown[0]!.text).toContain("写入后，此后派出的 PM、worker、reviewer 都按新内容工作。");
    expect(shown[0]!.text).toMatch(/ → 写入\n {3}不写入\n {3}其他（自己输入修改意见）\n/u);
    expect(shown[0]!.text).toContain("↑↓ 选择 · 回车确认 · Esc 取消（不写入）");
    await expect(readFile(file, "utf8")).resolves.toBe(RULES_V1);
    expect(details(await update(world, RULES_V1, write))).toMatchObject({ status: "unchanged" });
    expect(shown).toHaveLength(1);

    await writeFile(file, RULES_V1 + "- 手工加的一条。\n");
    await update(world, RULES_V2, write);
    expect(shown[1]!.text).toContain("与仓库里现有的 AGENTS.md 相比的改动：");
    expect(shown[1]!.text).toContain("+ - 不使用泛型。");
    expect(shown[1]!.text).toContain("- - 手工加的一条。");
    expect(shown[1]!.text).toContain("  - 导出常量用大写下划线命名。");
    expect(shown[1]!.text).not.toContain("指纹");
    await expect(readFile(file, "utf8")).resolves.toBe(RULES_V2);
  });

  test("M8D2-AC3：输入修改意见时不写文件，用户原话交回主窗口；确认期间磁盘被改时拒绝并写明原因", async () => {
    const world = await fixture();
    const file = join(world.repositoryRoot, "AGENTS.md");
    await writeFile(file, RULES_V1);
    const revised = details(await update(world, RULES_V2, context("session-main", async () => ({ other: "只禁止业务代码用泛型" }))));
    expect(revised).toMatchObject({ status: "revise", feedback: "只禁止业务代码用泛型" });
    expect(revised.next).toContain("重新提交 conventions-update");
    await expect(readFile(file, "utf8")).resolves.toBe(RULES_V1);

    const changed = details(await update(world, RULES_V2, context("session-main", async () => { await writeFile(file, "别处改的\n"); return "写入"; })));
    expect(changed).toMatchObject({ status: "blocked", reason: "确认期间 AGENTS.md 被别处改动", next: "重新读取仓库根目录的 AGENTS.md，在最新内容上修改后再提交" });
    await expect(readFile(file, "utf8")).resolves.toBe("别处改的\n");
  });
});

describe("operationId 由程序生成：模型不填，中断后的续做由程序认出", () => {
  const BODY = "# 目标 {#goals}\n保留移动。\n";
  const idle: OpenProjectIndexService = async () => ({ preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) });
  const details = (result: unknown) => (result as { details: Record<string, unknown> }).details;
  const UUIDS = new RegExp(UUID_V7_PATTERN.source.slice(1, -1), "g");

  async function requirementWorld() {
    const world = await fixture();
    const paths = { repositoryRoot: world.repositoryRoot, dataRoot: world.dataRoot, repoId: world.repoId };
    const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
    const service = await RequirementService.open({ ...paths, authorize: (request) => {
      if (request.repoId !== paths.repoId) return false;
      if (request.action === "metadata") return true;
      const grant = request.operationId ? grants.get(request.operationId) : undefined;
      return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
    }, authorizeManifest: () => true });
    const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
    const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
    grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
    const { requirementId } = await service.create(create);
    await draftApprover(paths, service, { requirementId, operationId: create.operationId, title: "角色跳跃", body: BODY }, grantWrite)();
    const runtime = runtimeFor(world, idle);
    const ctx = context("session-main", async () => true);
    const record = () => withDatabase(repositoryDatabase(world.dataRoot, world.repoId), (db) => db.read<{ status: string; operationId: string }>(MANAGED_WORKSPACES, requirementId));
    async function close() {
      const receipt = uuidv7();
      const closer = await RequirementCloseService.open({ ...paths, stopAgents: async () => {}, authorize: (request) => request.action !== "close" || request.receiptId === receipt });
      try { await closer.close({ requirementId, reason: "cancelled", receiptId: receipt }); } finally { closer.dispose(); }
    }
    return { ...world, requirementId, runtime, ctx, record, close };
  }

  test("五个动作的 schema：任何动作都不接受 operationId，restore 的 backupOperationId 与 backupManifestHash 仍必填", () => {
    const repoId = "a".repeat(64);
    const requirementId = uuidv7();
    const check = (request: Record<string, unknown>) => Value.Check(PROJECT_MANAGE_PARAMETERS, { request });
    const restore = { action: "restore", repoId, backupOperationId: uuidv7(), backupManifestHash: "b".repeat(64) };
    expect(check({ action: "workspace-prepare", repoId, requirementId })).toBe(true);
    expect(check({ action: "workspace-prepare", repoId, requirementId, operationId: uuidv7() })).toBe(false);
    expect(check({ action: "workspace-recycle", repoId, requirementId })).toBe(true);
    expect(check({ action: "workspace-recycle", repoId, requirementId, operationId: uuidv7() })).toBe(false);
    expect(check({ action: "recovery-check", repoId })).toBe(true);
    expect(check({ action: "recovery-check", repoId, operationId: uuidv7() })).toBe(false);
    expect(check({ action: "backup", repoId })).toBe(true);
    expect(check({ action: "backup", repoId, operationId: uuidv7() })).toBe(false);
    expect(check(restore)).toBe(true);
    expect(check({ ...restore, operationId: uuidv7() })).toBe(false);
    expect(check({ action: "restore", repoId, backupOperationId: restore.backupOperationId })).toBe(false);
    expect(check({ action: "restore", repoId, backupManifestHash: restore.backupManifestHash })).toBe(false);
  });

  test("workspace-prepare、backup、restore 带 operationId 被拒为 invalid_shape", async () => {
    const w = await requirementWorld();
    const backup = details(await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx));
    const restore = { action: "restore", repoId: w.repoId, backupOperationId: backup.operationId, backupManifestHash: backup.manifestHash };
    for (const request of [{ action: "workspace-prepare", repoId: w.repoId, requirementId: w.requirementId }, { action: "backup", repoId: w.repoId }, restore]) {
      await expect(call(w.runtime, { ...request, operationId: uuidv7() }, w.ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    }
    await w.runtime.shutdown();
  }, 30000);

  test("workspace-prepare 不填 operationId 成功：结果带合规 UUIDv7，且就是记录里的操作编号", async () => {
    const w = await requirementWorld();
    const result = details(await call(w.runtime, { action: "workspace-prepare", repoId: w.repoId, requirementId: w.requirementId }, w.ctx));
    expect(result).toMatchObject({ status: "ready" });
    expect(result.operationId).toMatch(UUID_V7_PATTERN);
    expect(w.record()!.data.operationId).toBe(result.operationId);
    const again = details(await call(w.runtime, { action: "workspace-prepare", repoId: w.repoId, requirementId: w.requirementId }, w.ctx));
    expect(again).toMatchObject({ status: "ready", operationId: result.operationId });
    await w.runtime.shutdown();
  });

  test("workspace-recycle 不填 operationId 成功且结果带 UUIDv7；带 operationId 被参数校验拒绝", async () => {
    const w = await requirementWorld();
    await call(w.runtime, { action: "workspace-prepare", repoId: w.repoId, requirementId: w.requirementId }, w.ctx);
    await w.close();
    await expect(call(w.runtime, { action: "workspace-recycle", repoId: w.repoId, requirementId: w.requirementId, operationId: uuidv7() }, w.ctx))
      .rejects.toMatchObject({ code: "invalid_shape" });
    const result = details(await call(w.runtime, { action: "workspace-recycle", repoId: w.repoId, requirementId: w.requirementId }, w.ctx));
    expect(result).toMatchObject({ status: "recycled" });
    expect(result.operationId).toMatch(UUID_V7_PATTERN);
    await w.runtime.shutdown();
  });

  test("recovery-check 不填 operationId 成功且结果带 UUIDv7；带 operationId 被参数校验拒绝", async () => {
    const w = await requirementWorld();
    await expect(call(w.runtime, { action: "recovery-check", repoId: w.repoId, operationId: uuidv7() }, w.ctx)).rejects.toMatchObject({ code: "invalid_shape" });
    const result = details(await call(w.runtime, { action: "recovery-check", repoId: w.repoId }, w.ctx));
    expect(result).toMatchObject({ status: "restart_ready" });
    expect(result.operationId).toMatch(UUID_V7_PATTERN);
    await w.runtime.shutdown();
  });

  test("backup 与 restore 不填 operationId 成功：各自结果带合规 UUIDv7，restore 只需备份结果里的编号和哈希", async () => {
    const w = await requirementWorld();
    const backup = details(await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx));
    expect(backup).toMatchObject({ status: "completed" });
    expect(backup.operationId).toMatch(UUID_V7_PATTERN);
    const restored = details(await call(w.runtime,
      { action: "restore", repoId: w.repoId, backupOperationId: backup.operationId, backupManifestHash: backup.manifestHash }, w.ctx));
    expect(restored).toMatchObject({ status: "needs_review" });
    expect(restored.operationId).toMatch(UUID_V7_PATTERN);
    expect(restored.operationId).not.toBe(backup.operationId);
    await w.runtime.shutdown();
  }, 30000);

  test("工作区准备中断后再调 workspace-prepare：程序用记录里的原编号续完，工作区变 ready", async () => {
    const w = await requirementWorld();
    const original = uuidv7();
    const location = workspaceLocation(await realpath(w.repositoryRoot), w.requirementId);
    const head = await git(w.repositoryRoot, ["rev-parse", "HEAD"]);
    withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.create(MANAGED_WORKSPACES, w.requirementId, { format: "managed-workspace/v1",
      requirementId: w.requirementId, title: "角色跳跃", operationId: original, baseCommit: head, branch: location.branch, path: location.path, status: "preparing", recycleOperationId: null }));
    await mkdir(join(location.path, ".."), { recursive: true });
    await git(w.repositoryRoot, ["worktree", "add", "-b", `req/${w.requirementId}`, location.path, head]);

    const resumed = details(await call(w.runtime, { action: "workspace-prepare", repoId: w.repoId, requirementId: w.requirementId }, w.ctx));
    expect(resumed).toMatchObject({ status: "ready", operationId: original });
    expect(w.record()!.data.status).toBe("ready");
    expect(w.record()!.data.operationId).toBe(original);
    await w.runtime.shutdown();
  }, 30000);

  test("备份中途失败：报错说明会从头开始新的备份，不含照抄与编号；再调 backup 从头做一次新的并成功，编号与失败那次不同，可用于 restore", async () => {
    const w = await requirementWorld();
    const unfinishedId = uuidv7();
    const database = repositoryDatabase(w.dataRoot, w.repoId);
    withDatabase(database, (db) => db.create("requirement_service_operations", unfinishedId, {
      format: "requirement-service-operation/v1", operationId: unfinishedId, repoId: w.repoId,
      requirementId: w.requirementId, finalVersion: null, git: null,
    }));
    const outcome = await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx)
      .then((result) => JSON.stringify(result), (error: Error) => error.message);
    expect(outcome).toContain("会从头开始一次新的备份或恢复");
    expect(outcome).not.toContain("照抄");
    expect((outcome.match(UUIDS) ?? []).filter((value) => value !== unfinishedId)).toEqual([]);
    const backupFamily = join(w.dataRoot, "repos", w.repoId, "backups", "requirement-backups");
    const failedIds = await readdir(backupFamily);
    expect(failedIds).toHaveLength(1);

    withDatabase(database, (db) => db.remove("requirement_service_operations", unfinishedId, db.read("requirement_service_operations", unfinishedId)!.version));
    const fresh = details(await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx));
    expect(fresh).toMatchObject({ status: "completed" });
    expect(fresh.operationId).toMatch(UUID_V7_PATTERN);
    expect(failedIds).not.toContain(fresh.operationId);
    const restored = details(await call(w.runtime,
      { action: "restore", repoId: w.repoId, backupOperationId: fresh.operationId, backupManifestHash: fresh.manifestHash }, w.ctx));
    expect(restored).toMatchObject({ status: "needs_review" });
    await w.runtime.shutdown();
  }, 60000);

  test("恢复中途失败：报错说明会从头开始新的恢复，不含照抄与编号；再调 restore 从头做一次新的并成功，编号与失败那次不同", async () => {
    const w = await requirementWorld();
    const backup = details(await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx));
    const restoreRequest = { action: "restore", repoId: w.repoId, backupOperationId: backup.operationId, backupManifestHash: backup.manifestHash };
    const extra = join(w.dataRoot, "repos", w.repoId, "backups", "requirement-backups", backup.operationId, "payload", "extra.txt");
    await writeFile(extra, "多余文件", { mode: 0o600 });
    const outcome = await call(w.runtime, restoreRequest, w.ctx).then((result) => JSON.stringify(result), (error: Error) => error.message);
    expect(outcome).toContain("backup_payload_mismatch");
    expect(outcome).toContain("会从头开始一次新的备份或恢复");
    expect(outcome).not.toContain("照抄");
    expect((outcome.match(UUIDS) ?? []).filter((value) => value !== backup.operationId)).toEqual([]);
    const restoreFamily = join(w.dataRoot, "restores");
    const failedIds = await readdir(restoreFamily);
    expect(failedIds).toHaveLength(1);

    await rm(extra);
    const fresh = details(await call(w.runtime, restoreRequest, w.ctx));
    expect(fresh).toMatchObject({ status: "needs_review" });
    expect(fresh.operationId).toMatch(UUID_V7_PATTERN);
    expect(failedIds).not.toContain(fresh.operationId);
    expect(fresh.operationId).not.toBe(backup.operationId);
    expect(await readdir(restoreFamily)).toHaveLength(2);
    await w.runtime.shutdown();
  }, 60000);

  test("工具说明与 workspace-manage 报错文字不出现“新生成”“UUIDv7”，说明里不要求填 operationId", async () => {
    const world = await fixture();
    const runtime = runtimeFor(world, idle);
    const clean = (text: string) => text.replaceAll("重新生成", "");
    expect(clean(runtime.tool.description)).not.toMatch(/新生成|UUIDv7|照抄/u);
    expect(runtime.tool.description).not.toContain("operationId");
    const source = await readFile(new URL("../src/modules/delivery/workspace-manage.ts", import.meta.url), "utf8");
    expect(clean(source)).not.toMatch(/新生成|UUIDv7/u);
    await runtime.shutdown();
  });

  test("源码里没有按操作编号续做的报错常量与关闭续办错误码", async () => {
    const { stdout } = await exec("grep", ["-rEl", "resume_not_found|resume_finished|RESUME_NOT_FOUND|RESUME_FINISHED|close_operation_mismatch|close_not_found|close_content_mismatch", join(import.meta.dirname, "..", "src")]).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    expect(stdout.trim()).toBe("");
  });
});
