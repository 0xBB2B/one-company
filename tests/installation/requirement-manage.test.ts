import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { repositoryIdentity, daemonSocketPath } from "../../runtime/identity.ts";
import { socketPathByteLimit } from "../../daemon/lifecycle.ts";
import { uuidv7 } from "../../runtime/database.ts";


const exec = promisify(execFile);
const productRoot = fileURLToPath(new URL("../../", import.meta.url));

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}

async function waitMissing(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`临时 daemon socket 未在 ${timeoutMs}ms 内清理`);
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

// 当前正文存储锁定 /usr/bin/git，安装验收仅在对应宿主平台执行。
test.skipIf(process.platform !== "darwin")("M1-AC12/13/15：pnpm 安装产物由真实 SDK lifecycle 加载并经 prompt/input/tool 执行 create", async () => {
  const root = await mkdtemp(join(tmpdir(), "ri-"));
  const rootStat = await stat(root);
  expect(rootStat.isDirectory()).toBe(true);
  expect(rootStat.uid).toBe(process.getuid());
  expect(rootStat.mode & 0o077).toBe(0);
  const packs = join(root, "packs");
  const consumer = join(root, "consumer");
  const repositoryRoot = join(root, "repository");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let socketPath: string | undefined;
  let bindAttempted = false;
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_COMPANY_IDLE_TIMEOUT_MS", "HOME"].map((key) => [key, process.env[key]]));
  try {
    for (const dir of [packs, consumer, repositoryRoot, agentDir, home]) await mkdir(dir, { recursive: true });
    const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
    const artifact = await packPackage(pnpm, productRoot, packs);
    const runtimeArtifact = await packPackage(pnpm, dirname(fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"))), packs);
    const typeboxArtifact = await packPackage(pnpm, await realpath(join(productRoot, "node_modules", "typebox")), packs);
    for (const file of ["extensions/index.ts", "extensions/requirement-manage.ts", "runtime/host-authorization.ts", "runtime/requirement-manage-tool.ts", "runtime/requirement-service.ts", "runtime/main-requirement-interaction.ts", "runtime/user-interact-tool.ts"]) {
      expect(artifact.files).toContain(file);
    }

    const sdkRoot = installedPackageRoot("@earendil-works/pi-coding-agent");
    const aiRoot = installedPackageRoot("@earendil-works/pi-ai");
    const tuiRoot = installedPackageRoot("@earendil-works/pi-tui");
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "requirement-manage-install-consumer",
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
    const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as { dependencies: Record<string, string>; peerDependencies: Record<string, string> };
    expect(installedPackage.dependencies).toEqual(expect.objectContaining({ typebox: "1.3.29", "web-tree-sitter": "0.27.0" }));
    expect(installedPackage.peerDependencies).toEqual(expect.objectContaining({ "@earendil-works/pi-coding-agent": "*" }));

    await git(repositoryRoot, ["init", "--initial-branch=main"]);
    await writeFile(join(repositoryRoot, "README.md"), "installation fixture\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
    const identity = await repositoryIdentity(repositoryRoot);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_OFFLINE = "1";
    process.env.PI_TELEMETRY = "0";
    process.env.PI_COMPANY_IDLE_TIMEOUT_MS = "300";
    socketPath = daemonSocketPath(join(agentDir, "pi-company"), identity.repoId);
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(socketPathByteLimit());

    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = registerControlledProvider(runtime, { providerId: "requirement-install", modelId: "controlled" });
    const requestId = uuidv7();
    const operationId = uuidv7();
    const title = "安装产物需求";
    const body = "通过真实 SDK input 进入生产授权路径";
    scriptReplies(provider, [
      { type: "toolcall", name: "pi_company_requirement_manage", input: { request: { action: "create", repoId: identity.repoId, requestId, operationId, title, body } } },
      { type: "text", text: '{"allow":true}' },
      { type: "toolcall", name: "pi_company_requirement_manage", input: { request: { action: "create", repoId: identity.repoId, requestId, operationId, title, body } } },
      { type: "text", text: "done" },
    ]);

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
    expect(loader.getExtensions().extensions.some((extension) => extension.path === join(installed, "extensions", "index.ts"))).toBe(true);

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
    const defaultUI = session.extensionRunner.getUIContext();
    const testUI: ExtensionUIContext = {
      ...defaultUI,
      confirm: async () => { throw new Error("UI.confirm forbidden"); },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined as never,
      notify: (message, type) => { notifications.push({ message, type }); },
    };
    bindAttempted = true;
    await session.bindExtensions({ uiContext: testUI, mode: "rpc" });
    expect(session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name)).toContain("pi_company_requirement_manage");

    expect(session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name)).toContain("pi_company_user_interact");
    await session.prompt("请把安装产物通过真实SDK保存需求的功能整理成未批准草稿，只分析接线", { source: "interactive" });
    await session.waitForIdle();
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "pi_company_requirement_manage");
    expect(result?.isError, JSON.stringify(result?.content)).toBe(false);
    const details = result?.details as { requirementId: string; commit: string; prodHash: string; lifecycle: string; revision: number; version: number };
    const createResults = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "pi_company_requirement_manage");
    expect(createResults).toHaveLength(2);
    expect(createResults[1]?.details).toEqual(details);
    expect(createResults[1]?.isError).toBe(false);
    expect(details.requirementId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(details.lifecycle).toBe("draft");
    expect(details.revision).toBe(0);

    const requirementRoot = join(agentDir, "pi-company", "repos", identity.repoId, "requirements", details.requirementId);
    const prod = await readFile(join(requirementRoot, "prod.md"));
    expect(prod.toString()).toContain(`requirementId: ${details.requirementId}`);
    expect(details.prodHash).toBe(`sha256:${createHash("sha256").update(prod).digest("hex")}`);
    expect(await git(requirementRoot, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(requirementRoot, ["show", "-s", "--format=%H", "HEAD"])).toBe(details.commit);

    const confirmationOperationId = uuidv7();
    const entry = (kind: "constraint" | "target" | "action", conclusion: string) => ({ kind, conclusion, scope: "仅分析安装接线，不实施",
      basis: "explicit", resolution: "direct", candidateId: confirmationOperationId, requestId: null, actions: kind === "action" ? ["analyze"] : [], references: [], supersedes: [] });
    const interpretation = { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: true,
      entries: [{ ...entry("constraint", "需求身份与标题"), unitIds: ["metadata"] }, { ...entry("target", "通过真实SDK处理需求保存"), unitIds: ["whole-body"] },
        { ...entry("action", "只分析接线"), unitIds: ["whole-body"] }] };
    scriptReplies(provider, [
      { type: "toolcall", name: "pi_company_user_interact", input: { request: { action: "forward", repoId: identity.repoId, requirementId: details.requirementId,
        savedOperationId: operationId, operationId: confirmationOperationId, version: details.version } } },
      { type: "text", text: JSON.stringify(interpretation) },
      { type: "text", text: "done" },
    ]);
    await session.prompt("安装产物需要通过真实SDK处理需求保存，本轮只分析接线，不实施", { source: "interactive" });
    await session.waitForIdle();
    expect(await git(requirementRoot, ["rev-list", "--count", "HEAD"])).toBe("1");
    const forwarded = session.messages.find((message) => message.role === "toolResult" && message.toolName === "pi_company_user_interact");
    expect(forwarded?.isError, JSON.stringify(forwarded?.content)).toBe(false);
    expect(forwarded?.details).toMatchObject({ targetRecorded: true, prodActivated: true,
      allowedScopes: [{ action: "analyze", goalIds: ["whole-body"], constraintIds: [] }] });
    expect(notifications.filter((entry) => entry.type === "error")).toEqual([]);
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
}, 90_000);
