import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { indexDatabase } from "../../runtime/database-paths.ts";
import { IndexStore } from "../../runtime/index-store.ts";
import { uuidv7 } from "../../runtime/database.ts";

const exec = promisify(execFile);
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const TS_SENTINEL = "TS_CURRENT_SOURCE_SENTINEL";
const GO_SENTINEL = "GO_CURRENT_SOURCE_SENTINEL";
const SPEC_SENTINEL = "SPEC_CURRENT_SOURCE_SENTINEL";
const PROD_SENTINEL = "PROD_ARCHIVE_BODY_SENTINEL_MUST_NOT_LEAK";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", args, { cwd, env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}

async function waitMissing(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`临时 daemon socket 未在 ${timeoutMs}ms 内清理`);
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function installedPackageRoot(specifier: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
}

async function packPackage(pnpm: string, path: string, destination: string): Promise<{ path: string; files: string[] }> {
  const raw = (await exec(process.execPath, [pnpm, "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", destination], {
    cwd: path,
    env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" },
    maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const result = JSON.parse(raw) as { filename: string; files: Array<{ path: string }> };
  return { path: resolve(path, result.filename), files: result.files.map((entry) => entry.path) };
}

function validSpec() {
  return {
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: "install.current", title: "安装索引", aliases: ["当前索引"] },
    rules: [{
      id: "install.current.visible",
      title: "当前规则可检索",
      condition: "项目已经接入",
      trigger: "执行索引",
      expected: SPEC_SENTINEL,
      reason: "验证安装产物使用当前规则",
      dependsOn: [],
      exceptions: [],
      acceptance: [{ id: "search-current", given: "存在当前规则", when: "建立索引", then: "规则进入当前索引" }],
    }],
  };
}

// 安装验收使用锁定宿主 Node、/usr/bin/git、离线包和完全独立的 HOME/agentDir/dataRoot。
test.skipIf(process.platform !== "darwin")("M2-AC1/4/5/6/7：安装产物经真实 lifecycle 执行 preview/init/status/重复init/refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-company-project-manage-install-"));
  const packs = join(root, "packs");
  const consumer = join(root, "consumer");
  const repositoryRoot = join(root, "repository");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let socketPath: string | undefined;
  let bindAttempted = false;
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_COMPANY_IDLE_TIMEOUT_MS", "HOME"].map((key) => [key, process.env[key]]));
  try {
    for (const directory of [packs, consumer, repositoryRoot, agentDir, home]) await mkdir(directory, { recursive: true });
    const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
    const artifact = await packPackage(pnpm, productRoot, packs);
    const runtimeArtifact = await packPackage(pnpm, dirname(fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"))), packs);
    const typeboxArtifact = await packPackage(pnpm, await realpath(join(productRoot, "node_modules", "typebox")), packs);
    for (const file of [
      "extensions/index.ts",
      "extensions/project-manage.ts",
      "runtime/project-manage-tool.ts",
      "runtime/project-index-service.ts",
      "runtime/project-index-policy.ts",
      "runtime/index-store.ts",
      "runtime/code-extractor.ts",
    ]) expect(artifact.files).toContain(file);

    const sdkRoot = installedPackageRoot("@earendil-works/pi-coding-agent");
    const aiRoot = installedPackageRoot("@earendil-works/pi-ai");
    const tuiRoot = installedPackageRoot("@earendil-works/pi-tui");
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "project-manage-install-consumer",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@11.7.0",
      dependencies: {
        "@0xbb2b/pi-company": `file:${artifact.path}`,
        "@earendil-works/pi-ai": `link:${aiRoot}`,
        "@earendil-works/pi-coding-agent": `link:${sdkRoot}`,
        "@earendil-works/pi-tui": `link:${tuiRoot}`,
      },
    }));
    await writeFile(join(consumer, "pnpm-workspace.yaml"), [
      "autoInstallPeers: false",
      "overrides:",
      `  typebox: ${JSON.stringify(`file:${typeboxArtifact.path}`)}`,
      `  web-tree-sitter: ${JSON.stringify(`file:${runtimeArtifact.path}`)}`,
      "",
    ].join("\n"));
    const installEnv = { ...process.env, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" };
    await exec(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", "--lockfile-only"], { cwd: consumer, env: installEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    await exec(process.execPath, [pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: consumer, env: installEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const installed = await realpath(join(consumer, "node_modules", "@0xbb2b", "pi-company"));
    expect(installed).not.toBe(productRoot);

    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "cmd"), { recursive: true });
    await mkdir(join(repositoryRoot, "docs", "spec"), { recursive: true });
    await mkdir(join(repositoryRoot, "docs", "prod"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "main.ts"), `export function currentTs() { return "${TS_SENTINEL}"; }\n`);
    await writeFile(join(repositoryRoot, "cmd", "main.go"), `package main\nconst currentGo = "${GO_SENTINEL}"\nfunc main() {}\n`);
    await copyFile(join(productRoot, "resources", "spec", "schema.json"), join(repositoryRoot, "docs", "spec", "schema.json"));
    await writeFile(join(repositoryRoot, "docs", "spec", "current.rules.json"), JSON.stringify(validSpec()));
    const archiveId = uuidv7();
    await writeFile(join(repositoryRoot, "docs", "prod", `${archiveId}.已完成需求.md`), `${PROD_SENTINEL}\n不允许进入FTS或工具输出。\n`);
    await writeFile(join(repositoryRoot, "README.md"), "installation fixture\n");
    await git(repositoryRoot, ["add", "."]);
    await git(repositoryRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
    const identity = await repositoryIdentity(repositoryRoot);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_OFFLINE = "1";
    process.env.PI_TELEMETRY = "0";
    process.env.PI_COMPANY_IDLE_TIMEOUT_MS = "300";
    const dataRoot = join(agentDir, "pi-company");
    const databasePath = indexDatabase(dataRoot, identity.repoId);
    socketPath = daemonSocketPath(dataRoot, identity.repoId);

    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = registerControlledProvider(runtime, { providerId: "project-install", modelId: "controlled" });
    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [join(installed, "extensions", "index.ts")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);

    ({ session } = await createAgentSession({
      cwd: repositoryRoot,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModels(provider.providerId)[0],
      resourceLoader: loader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(repositoryRoot),
      noTools: "builtin",
    }));
    const confirmations: Array<{ title: string; message: string }> = [];
    const defaultUI = session.extensionRunner.getUIContext();
    const testUI: ExtensionUIContext = {
      ...defaultUI,
      confirm: async (title, message) => {
        confirmations.push({ title, message });
        return title.includes("项目索引范围");
      },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined as never,
      notify: () => {},
    };
    bindAttempted = true;
    await session.bindExtensions({ uiContext: testUI, mode: "rpc" });
    expect(session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name)).toContain("pi_company_project_manage");

    const toolResults: Array<{ details: Record<string, unknown>; text: string }> = [];
    const invoke = async (input: Record<string, unknown>, prompt: string) => {
      scriptReplies(provider, [
        { type: "toolcall", name: "pi_company_project_manage", input },
        { type: "text", text: "done" },
      ]);
      const before = session!.messages.length;
      await session!.prompt(prompt, { source: "interactive" });
      await session!.waitForIdle();
      const message = session!.messages.slice(before).find((item) => item.role === "toolResult" && item.toolName === "pi_company_project_manage");
      expect(message?.isError, JSON.stringify(message?.content)).toBe(false);
      const text = message?.content.find((item) => item.type === "text")?.text ?? "";
      const captured = { details: message?.details as Record<string, unknown>, text };
      toolResults.push(captured);
      return captured;
    };

    expect(await pathExists(databasePath)).toBe(false);
    const preview = await invoke({ action: "init", repoId: identity.repoId, preview: true }, "只预览当前项目索引范围");
    expect(await pathExists(databasePath)).toBe(false);
    expect(preview.details).toMatchObject({ action: "preview", partial: false, databaseCreated: false });
    expect(preview.text).toContain("src/main.ts");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.message).toContain(repositoryRoot);
    expect(confirmations[0]!.message).toContain(join(dataRoot, "repos", identity.repoId));
    expect(confirmations[0]!.message).toContain("docs/prod 只枚举有限路径元数据，不读取正文");

    const initialized = await invoke({ action: "init", repoId: identity.repoId }, "建立当前项目索引");
    expect(await pathExists(databasePath)).toBe(true);
    expect(initialized.details).toMatchObject({ action: "init", status: "ready", generation: 1, parsedFiles: 2, reusedFiles: 0 });
    expect(confirmations).toHaveLength(1);
    const workspace = initialized.details.workspace as { workspaceId: string; repoId: string };
    expect(workspace).toEqual({ workspaceId: expect.stringMatching(/^[0-9a-f]{64}$/), repoId: identity.repoId });

    const store = new IndexStore(databasePath, {
      workspaceId: workspace.workspaceId,
      repoId: identity.repoId,
      root: repositoryRoot,
      branch: "refs/heads/main",
    });
    try {
      const snapshot = store.getSnapshot();
      expect(snapshot.files.map((item) => item.path)).toEqual(expect.arrayContaining(["src/main.ts", "cmd/main.go", "docs/spec/current.rules.json", "docs/spec/schema.json"]));
      expect(snapshot.rules.map((item) => item.id)).toContain("install.current.visible");
      expect(store.search(TS_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(GO_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(SPEC_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(PROD_SENTINEL).results).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain(PROD_SENTINEL);
      expect(snapshot.prodMetadata).toContainEqual(expect.objectContaining({ source: "archive", requirementId: archiveId, path: `docs/prod/${archiveId}.已完成需求.md` }));
    } finally { store.close(); }

    const status = await invoke({ action: "status", repoId: identity.repoId }, "查看当前项目索引状态");
    expect(status.details).toMatchObject({ action: "status", initialized: true, index: { status: "ready", currentGeneration: 1 } });

    const repeated = await invoke({ action: "init", repoId: identity.repoId }, "重复初始化并复用未变化文件");
    expect(repeated.details).toMatchObject({ action: "init", status: "ready", generation: 2, parsedFiles: 0, reusedFiles: 2 });
    const refreshed = await invoke({ action: "refresh", repoId: identity.repoId }, "刷新并复用未变化文件");
    expect(refreshed.details).toMatchObject({ action: "refresh", status: "ready", generation: 3, parsedFiles: 0, reusedFiles: 2 });
    expect(confirmations).toHaveLength(1);

    const allToolOutput = JSON.stringify(toolResults);
    for (const sentinel of [TS_SENTINEL, GO_SENTINEL, SPEC_SENTINEL, PROD_SENTINEL]) expect(allToolOutput).not.toContain(sentinel);
    const finalStore = new IndexStore(databasePath, {
      workspaceId: workspace.workspaceId,
      repoId: identity.repoId,
      root: repositoryRoot,
      branch: "refs/heads/main",
    });
    try {
      const snapshot = finalStore.getSnapshot();
      expect(new Set(snapshot.symbols.map((item) => item.id)).size).toBe(snapshot.symbols.length);
      expect(new Set(snapshot.codeEdges.map((item) => item.id)).size).toBe(snapshot.codeEdges.length);
    } finally { finalStore.close(); }
  } finally {
    const cleanupErrors: unknown[] = [];
    if (session) {
      if (!session.isIdle) {
        try { await session.abort(); await session.waitForIdle(); }
        catch (error) { cleanupErrors.push(error); }
      }
      if (bindAttempted) {
        try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        catch (error) { cleanupErrors.push(error); }
      }
      session.dispose();
    }
    if (socketPath) {
      try { await waitMissing(socketPath); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
    else throw new AggregateError(cleanupErrors, `安装测试清理失败，保留现场：${root}`);
  }
}, 120_000);
