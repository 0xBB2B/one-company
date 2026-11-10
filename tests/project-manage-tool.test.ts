import { answeringUi } from "./helpers/window-host.ts";
import type { WindowDecision } from "./helpers/window-host.ts";
import { repositoryDatabase, UUID_V7_PATTERN, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { RequirementCloseService } from "../src/modules/delivery/workflow-close.ts";
import { MANAGED_WORKSPACES, workspaceLocation } from "../src/modules/delivery/workspace-manage.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { LINE_ANCHOR_ENTRY, currentLine, lineViewIn } from "../src/modules/requirement/line-anchors.ts";
import { readDraftFiles } from "../src/modules/requirement/prd-storage.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { STALE_LSTART, exitedPid, writeMarker } from "./helpers/maintenance-marker.ts";


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

describe("project_manage 项目规范 AGENTS.md：只有用户在窗口里选写进草稿才记进需求草稿", () => {
  const ROOT_RULES = "# 项目规范\n\n- 导出常量用大写下划线命名。\n";
  const RULES_V1 = ROOT_RULES + "- 不使用泛型。\n";
  const RULES_V2 = RULES_V1 + "- 注释用中文。\n";
  const BODY = "# 目标 {#goals}\n导出订单。\n";
  const TITLE = "把这些改动写进需求「订单导出」的草稿？";
  const NOTE = "批准需求后随需求分支写入，此后这个需求派出的 PM、worker、reviewer 都按新内容工作。";
  const idle: OpenProjectIndexService = async () => ({ preview: async () => ({}), init: async () => ({}), refresh: async () => ({}), status: async () => ({}) });
  const details = (result: unknown) => (result as { details: Record<string, unknown> }).details;
  const utf8 = (bytes: Uint8Array | null) => bytes === null ? null : Buffer.from(bytes).toString("utf8");

  async function draftWorld(options: { rootRules?: string | null; approve?: boolean } = {}) {
    const world = await fixture();
    const rootFile = join(world.repositoryRoot, "AGENTS.md");
    const rootRules = options.rootRules === undefined ? ROOT_RULES : options.rootRules;
    if (rootRules !== null) await writeFile(rootFile, rootRules);
    const paths = { repositoryRoot: world.repositoryRoot, dataRoot: world.dataRoot, repoId: world.repoId };
    const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
    const requirements = await RequirementService.open({ ...paths, authorize: (request) => {
      if (request.repoId !== paths.repoId) return false;
      if (request.action === "metadata") return true;
      const grant = request.operationId ? grants.get(request.operationId) : undefined;
      return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
    }, authorizeManifest: () => true });
    const create = { requestId: uuidv7(), operationId: uuidv7(), title: "订单导出", body: BODY };
    grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
    const { requirementId } = await requirements.create(create);
    const approveNow = async () => {
      const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
      await draftApprover(paths, requirements, { requirementId, operationId: create.operationId, title: "订单导出", body: BODY }, grantWrite)();
    };
    if (options.approve) await approveNow();
    const reserveOnly = async () => {
      const store = await RequirementStateStore.open({ ...paths, authorize: () => true, authorizeManifest: () => true });
      return store.reserve({ requestId: uuidv7(), intentHash: "b".repeat(64) }).id;
    };
    const db = <T>(run: Parameters<typeof withDatabase<T>>[1]) => withDatabase(repositoryDatabase(world.dataRoot, world.repoId), run);
    const baseAnchor = db((d) => d.list<{ kind: string; sequence: number; requirementId: string; anchor: string }>("line_anchors")
      .map((row) => row.data).filter((record) => record.requirementId === requirementId && record.kind === "save").sort((x, y) => x.sequence - y.sequence)[0]!.anchor);
    const branch: unknown[] = [{ type: "custom", customType: LINE_ANCHOR_ENTRY, data: { repoId: world.repoId, requirementId, anchor: baseAnchor } }];
    const fakePi = createFakePi();
    const pi = { ...fakePi.pi, appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); } };
    const window = { windowId: world.host.windowId, sessionId: world.host.sessionId,
      workspace: { repos: [{ repoId: world.repoId, path: world.repositoryRoot, commonDir: join(world.repositoryRoot, ".git") }], skipped: [] }, clients: { closeAll() {} } } as never;
    projectManageExtension(pi as unknown as ExtensionAPI, { dataRoot: world.dataRoot, windowReady: async () => window, windowContext: () => window, openService: idle });
    const shown: Array<{ title: string; text: string; choices: string[] }> = [];
    const ctxFor = (decide: (window: { title: string; text: string; choices: string[] }) => WindowDecision | Promise<WindowDecision>, hasUI = true) => ({
      cwd: "/not-used", mode: hasUI ? "rpc" : "print", hasUI,
      ui: answeringUi((w) => { shown.push(w); return decide(w); }),
      sessionManager: { getSessionId: () => world.host.sessionId, getBranch: () => branch } as never,
    }) as unknown as ExtensionContext;
    const first = ctxFor(async () => true);
    await fakePi.trigger("session_start", { type: "session_start", reason: "startup" }, first);
    const tool = fakePi.registeredTools()[0] as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    const update = (ctx: ExtensionContext, content: string, id: string | null = requirementId) =>
      tool.execute("tool-call", { request: { action: "conventions-update", repoId: world.repoId, ...(id === null ? {} : { requirementId: id }), content } }, undefined, undefined, ctx);
    const line = () => currentLine({ getBranch: () => branch } as never)[requirementId] ?? [];
    const filesAt = async (anchors: string[]) => {
      const commit = db((d) => lineViewIn(d, requirementId, anchors).tip!.fileCommit!);
      const files = await readDraftFiles({ dataRoot: world.dataRoot, repoId: world.repoId, requirementId, repositoryRoot: world.repositoryRoot, commit, authorize: () => true } as never);
      return { agents: utf8(files.agents), agentsBase: utf8(files.agentsBase) };
    };
    const conventionsAnchors = () => db((d) => d.list<{ kind: string; requirementId: string; anchor: string; parent: string | null }>("line_anchors").map((row) => row.data)
      .filter((record) => record.requirementId === requirementId && record.kind === "conventions"));
    return { ...world, rootFile, requirementId, baseAnchor, branch, shown, ctxFor, update, line, filesAt, conventionsAnchors, requirements, approveNow, reserveOnly };
  }

  test("conventions-update 必须带 requirementId：不带时参数校验失败，带了 approved 之类的字段也失败", async () => {
    const world = await fixture();
    const base = { action: "conventions-update", repoId: world.repoId, content: RULES_V1 };
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { ...base, requirementId: uuidv7() } })).toBe(true);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: base })).toBe(false);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { ...base, requirementId: uuidv7(), approved: true } })).toBe(false);
    expect(Value.Check(PROJECT_MANAGE_PARAMETERS, { request: { action: "conventions-status", repoId: world.repoId, requirementId: uuidv7() } })).toBe(false);
  });

  test("不带 requirementId 调用工具：被拒、不弹窗、不写任何东西", async () => {
    const w = await draftWorld();
    await expect(w.update(w.ctxFor(async () => { throw new Error("不应弹窗"); }), RULES_V1, null)).rejects.toThrow(/requirementId/u);
    expect(w.shown).toEqual([]);
    expect(w.conventionsAnchors()).toEqual([]);
  });

  test("需求已批准：被拒，原因写清要先指定一个草稿需求，不弹窗、不写任何东西", async () => {
    const w = await draftWorld({ approve: true });
    const outcome = await w.update(w.ctxFor(async () => { throw new Error("不应弹窗"); }), RULES_V1)
      .then((result) => JSON.stringify(result), (error: { message?: string; advice?: unknown }) => JSON.stringify({ message: error.message, advice: error.advice }));
    expect(outcome).toContain("要先指定一个草稿需求");
    expect(w.shown).toEqual([]);
    expect(w.conventionsAnchors()).toEqual([]);
    await expect(readFile(w.rootFile, "utf8")).resolves.toBe(ROOT_RULES);
  });

  test("没有界面时拒绝；内容过长时参数校验失败；超过规范大小上限时返回 blocked，都不弹窗", async () => {
    const w = await draftWorld();
    await expect(w.update(w.ctxFor(async () => true, false), RULES_V1)).rejects.toMatchObject({ code: "conventions_confirmation_required" });
    const noDialog = w.ctxFor(async () => { throw new Error("不应弹窗"); });
    await expect(w.update(noDialog, "x".repeat(16 * 1024 + 1))).rejects.toMatchObject({ code: "invalid_shape" });
    expect(details(await w.update(noDialog, "规".repeat(6000))))
      .toMatchObject({ status: "blocked", reason: "项目规范内容超出大小上限", next: "精简 AGENTS.md 内容后再提交" });
    expect(w.conventionsAnchors()).toEqual([]);
  });

  test("窗口文字：标题、说明行、三个选项、Esc 说明与规定一字不差", async () => {
    const w = await draftWorld();
    expect(details(await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1))).toMatchObject({ status: "written" });
    expect(w.shown[0]!.title).toBe(TITLE);
    expect(w.shown[0]!.choices.slice(-3)).toEqual(["写进草稿", "不写", "其他（自己输入修改意见）"]);
    expect(w.shown[0]!.text).toContain(NOTE);
    expect(w.shown[0]!.text).toContain("与仓库里现有的 AGENTS.md 相比的改动：");
    expect(w.shown[0]!.text).toContain("+ - 不使用泛型。");
    expect(w.shown[0]!.text).toContain("Esc 不写");
    expect(w.shown[0]!.text).not.toContain("写入项目规范");
    expect(w.shown[0]!.text).not.toContain("不写入");
  });

  test("选写进草稿：主仓库根目录 AGENTS.md 字节不变，这条线的文件状态有新 AGENTS.md 和 AGENTS.base.md，对话里多一条该需求的 conventions 锚点（父是原线尖）", async () => {
    const w = await draftWorld();
    const before = await readFile(w.rootFile);
    expect(details(await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1))).toMatchObject({ status: "written" });
    expect((await readFile(w.rootFile)).equals(before)).toBe(true);
    expect(w.line()).toHaveLength(2);
    const [record] = w.conventionsAnchors();
    expect(w.conventionsAnchors()).toHaveLength(1);
    expect(record).toMatchObject({ anchor: w.line()[1], parent: w.baseAnchor });
    expect(w.branch.at(-1)).toMatchObject({ customType: LINE_ANCHOR_ENTRY, data: { repoId: w.repoId, requirementId: w.requirementId, anchor: record!.anchor } });
    expect(await w.filesAt(w.line())).toEqual({ agents: RULES_V1, agentsBase: ROOT_RULES });
  });

  test("同一条线上再改一次：窗口对比的是上一次写进草稿的内容，AGENTS.base.md 仍是第一次存下的主仓库内容", async () => {
    const w = await draftWorld();
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1);
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V2);
    const text = w.shown[1]!.text;
    expect(text).toContain("与仓库里现有的 AGENTS.md 相比的改动：");
    expect(text).toContain("+ - 注释用中文。");
    expect(text).toContain("  - 不使用泛型。");
    expect(text).not.toContain("+ - 不使用泛型。");
    expect(w.line()).toHaveLength(3);
    expect(w.conventionsAnchors()).toHaveLength(2);
    expect(await w.filesAt(w.line())).toEqual({ agents: RULES_V2, agentsBase: ROOT_RULES });
    await expect(readFile(w.rootFile, "utf8")).resolves.toBe(ROOT_RULES);
  });

  test("对话线回到第一次修改之前：这个需求的文件状态里没有 AGENTS.md", async () => {
    const w = await draftWorld();
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1);
    expect(await w.filesAt(w.line())).toMatchObject({ agents: RULES_V1 });
    w.branch.length = 1;
    expect(w.line()).toEqual([w.baseAnchor]);
    expect(await w.filesAt(w.line())).toEqual({ agents: null, agentsBase: null });
  });

  test("回到第一次修改之前后再改：窗口对比的是主仓库根目录的 AGENTS.md，不是被丢掉的那次内容", async () => {
    const w = await draftWorld();
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1);
    w.branch.length = 1;
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V2);
    expect(w.shown[1]!.text).toContain("+ - 不使用泛型。");
    expect(w.shown[1]!.text).toContain("+ - 注释用中文。");
    expect(await w.filesAt(w.line())).toEqual({ agents: RULES_V2, agentsBase: ROOT_RULES });
  });

  test("主仓库根目录原来没有 AGENTS.md：写进草稿后线上有 AGENTS.md、没有 AGENTS.base.md，窗口写明还没有", async () => {
    const w = await draftWorld({ rootRules: null });
    expect(details(await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1))).toMatchObject({ status: "written" });
    expect(w.shown[0]!.text).toContain("仓库里还没有 AGENTS.md，要写入的全文如下：");
    expect(existsSync(w.rootFile)).toBe(false);
    expect(await w.filesAt(w.line())).toEqual({ agents: RULES_V1, agentsBase: null });
  });

  test("选不写、按 Esc：返回 cancelled，不加锚点、不改草稿文件、不改主仓库根目录", async () => {
    const w = await draftWorld();
    for (const decision of ["不写", false] as const) {
      expect(details(await w.update(w.ctxFor(async () => decision), RULES_V1))).toMatchObject({ status: "cancelled" });
    }
    expect(w.line()).toEqual([w.baseAnchor]);
    expect(w.conventionsAnchors()).toEqual([]);
    expect(await w.filesAt(w.line())).toEqual({ agents: null, agentsBase: null });
    await expect(readFile(w.rootFile, "utf8")).resolves.toBe(ROOT_RULES);
  });

  test("选其他写修改意见：返回 revise 和用户原话，不加锚点、不改草稿文件", async () => {
    const w = await draftWorld();
    const revised = details(await w.update(w.ctxFor(async () => ({ other: "只禁止业务代码用泛型" })), RULES_V1));
    expect(revised).toMatchObject({ status: "revise", feedback: "只禁止业务代码用泛型" });
    expect(revised.next).toContain("重新提交 conventions-update");
    expect(w.line()).toEqual([w.baseAnchor]);
    expect(await w.filesAt(w.line())).toEqual({ agents: null, agentsBase: null });
  });

  test("内容和对比对象相同：线上没有草稿 AGENTS.md 时与主仓库根目录比，已有时与草稿比；相同时返回 unchanged、不弹窗", async () => {
    const w = await draftWorld();
    const noDialog = w.ctxFor(async () => { throw new Error("不应弹窗"); });
    expect(details(await w.update(noDialog, ROOT_RULES))).toMatchObject({ status: "unchanged" });
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1);
    const shownBefore = w.shown.length;
    expect(details(await w.update(noDialog, RULES_V1))).toMatchObject({ status: "unchanged" });
    expect(w.shown).toHaveLength(shownBefore);
    expect(w.line()).toHaveLength(2);
  });

  test("草稿里已有 AGENTS.md 时，内容改回主仓库根目录的内容不算 unchanged：要弹窗并再写一次", async () => {
    const w = await draftWorld();
    await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1);
    expect(details(await w.update(w.ctxFor(async () => "写进草稿"), ROOT_RULES))).toMatchObject({ status: "written" });
    expect(w.shown).toHaveLength(2);
    expect(await w.filesAt(w.line())).toMatchObject({ agents: ROOT_RULES });
  });

  test("窗口开着时这个需求在别处被批准：再选写进草稿被拒，原因写清要先指定一个草稿需求，草稿、对话、主仓库都不变", async () => {
    const w = await draftWorld();
    const outcome = await w.update(w.ctxFor(async () => { await w.approveNow(); return "写进草稿"; }), RULES_V1)
      .then((result) => JSON.stringify(result), (error: { message?: string; advice?: unknown }) => JSON.stringify({ message: error.message, advice: error.advice }));
    expect(outcome).toContain("要先指定一个草稿需求");
    expect(w.conventionsAnchors()).toEqual([]);
    expect(w.line()).toEqual([w.baseAnchor]);
    expect(await w.filesAt(w.line())).toEqual({ agents: null, agentsBase: null });
    await expect(readFile(w.rootFile, "utf8")).resolves.toBe(ROOT_RULES);
  });

  test("确认期间主仓库根目录 AGENTS.md 被改动：照常写进草稿，AGENTS.base.md 是窗口弹出时对比的那份", async () => {
    const w = await draftWorld();
    const result = await w.update(w.ctxFor(async () => { await writeFile(w.rootFile, "# 别处改过\n"); return "写进草稿"; }), RULES_V1);
    expect(details(result)).toMatchObject({ status: "written" });
    expect(await w.filesAt(w.line())).toEqual({ agents: RULES_V1, agentsBase: ROOT_RULES });
  });

  test("需求编号存在但还没保存过正文：被拒，原因写清这个需求还没有保存过正文，不弹窗、不写东西", async () => {
    const w = await draftWorld();
    const reservedId = await w.reserveOnly();
    const outcome = await w.update(w.ctxFor(async () => { throw new Error("不应弹窗"); }), RULES_V1, reservedId)
      .then((result) => JSON.stringify(result), (error: { message?: string; advice?: unknown }) => JSON.stringify({ message: error.message, advice: error.advice }));
    expect(outcome).toContain("这个需求还没有保存过正文");
    expect(outcome).not.toContain("完整提交哈希");
    expect(w.shown).toEqual([]);
    expect(w.conventionsAnchors()).toEqual([]);
  });

  test("对话线上最后一个锚点在库里找不到：先把最近一次保存钉进对话，再在它后面写，新锚点的父就是那次保存", async () => {
    const w = await draftWorld();
    const missing = uuidv7();
    w.branch.push({ type: "custom", customType: LINE_ANCHOR_ENTRY, data: { repoId: w.repoId, requirementId: w.requirementId, anchor: missing } });
    expect(details(await w.update(w.ctxFor(async () => "写进草稿"), RULES_V1))).toMatchObject({ status: "written" });
    const [record] = w.conventionsAnchors();
    expect(w.conventionsAnchors()).toHaveLength(1);
    expect(record).toMatchObject({ parent: w.baseAnchor });
    expect(w.line().slice(-2)).toEqual([w.baseAnchor, record!.anchor]);
    expect(await w.filesAt([record!.anchor])).toEqual({ agents: RULES_V1, agentsBase: ROOT_RULES });
  });

  test("工具说明里 conventions-update 一段：要带 requirementId，内容记进这个需求的草稿，批准需求、工作区建好后随需求分支写入", () => {
    const world = { dataRoot: "/unused", resolveHost: async () => { throw new Error("unused"); }, currentHost: () => { throw new Error("unused"); }, openService: idle };
    const description = createProjectManageTool(world as never).tool.description;
    const segment = description.slice(description.indexOf("conventions-update 以"));
    expect(segment).toMatch(/requirementId/u);
    expect(segment).toMatch(/记进这个需求的草稿/u);
    expect(segment).toMatch(/批准需求[、，]\s*工作区建好后随需求分支写入/u);
    expect(segment).not.toContain("用户选「写入」后才写文件");
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
    await promisify(execFile)("git", ["merge", "-q", "--ff-only", `req/${w.requirementId}`], { cwd: w.repositoryRoot });
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

  test("数据目录留有可清的维护标记时 backup 清掉标记后返回 completed", async () => {
    const w = await requirementWorld();
    const pid = await exitedPid();
    const marker = await writeMarker(dirname(repositoryDatabase(w.dataRoot, w.repoId)), pid, `pid:${pid}:lstart:${STALE_LSTART}`);
    expect(details(await call(w.runtime, { action: "backup", repoId: w.repoId }, w.ctx))).toMatchObject({ status: "completed" });
    expect(existsSync(marker)).toBe(false);
    await w.runtime.shutdown();
  }, 60000);

  test("数据目录留有可清的维护标记时 recovery-check 清掉标记后返回 restart_ready", async () => {
    const w = await requirementWorld();
    const pid = await exitedPid();
    const marker = await writeMarker(dirname(repositoryDatabase(w.dataRoot, w.repoId)), pid, `pid:${pid}:lstart:${STALE_LSTART}`);
    expect(details(await call(w.runtime, { action: "recovery-check", repoId: w.repoId }, w.ctx))).toMatchObject({ status: "restart_ready" });
    expect(existsSync(marker)).toBe(false);
    await w.runtime.shutdown();
  }, 60000);

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
