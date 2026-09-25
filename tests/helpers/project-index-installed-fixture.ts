import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess, { ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { IndexSnapshot } from "../../runtime/index-store.ts";

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
export const contentHash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
export const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
export async function eventually(check: () => boolean | Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const until = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(40);
  }
  throw new Error(`安装夹具等待超时：${label}`, { cause: lastError });
}

/** 白名单环境：不继承真实凭据、用户包设置、NODE_OPTIONS 或其他现场的 daemon 配置。 */
export function isolatedEnvironment(home: string, agentDir: string, temp: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    CI: "1", NO_COLOR: "1", LC_ALL: "C", LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "installed-fixture", GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "installed-fixture", GIT_COMMITTER_EMAIL: "fixture@localhost",
    npm_config_ignore_scripts: "true", npm_config_update_notifier: "false",
  };
}

export async function installationInput(): Promise<{ hash: string; files: Record<string, string> }> {
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as { files: string[] };
  const files: Record<string, string> = {};
  const visit = async (path: string): Promise<void> => {
    const absolute = join(sourceRoot, path);
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      files[path] = contentHash(await readFile(absolute)); return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!entry.isSymbolicLink(), "安装输入不得通过链接越界");
      await visit(join(path, entry.name));
    }
  };
  for (const path of [...new Set([...manifest.files, "package.json", "pnpm-lock.yaml", "tests/helpers/project-index-installed-fixture.ts",
    "tests/helpers/project-index-daemon-child.ts", "tests/installation/project-manage.test.ts", "tests/installation/project-index-sync.test.ts"])].sort()) await visit(path);
  return { hash: contentHash(JSON.stringify(files)), files };
}

export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export interface OwnedProcess { proc: ChildProcess; exited: Promise<ProcessResult> }
function child(args: string[], cwd: string, env: NodeJS.ProcessEnv, ipc = false): OwnedProcess {
  const proc = spawn(process.execPath, args, { cwd, env, stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
  proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  const exited = new Promise<ProcessResult>((done, fail) => {
    proc.once("error", fail);
    proc.once("close", (code, signal) => done({ code, signal, stdout, stderr }));
  });
  void exited.catch(() => {});
  return { proc, exited };
}
async function boundedExit(owned: OwnedProcess, timeout = 12_000): Promise<ProcessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([owned.exited, new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`自有进程 ${owned.proc.pid} 未退出`)), timeout);
  })]); } finally { clearTimeout(timer); }
}
async function stop(owned: OwnedProcess): Promise<ProcessResult> {
  if (owned.proc.exitCode === null && owned.proc.signalCode === null) { owned.proc.kill("SIGCONT"); owned.proc.kill("SIGTERM"); }
  try { return await boundedExit(owned); }
  catch (error) { owned.proc.kill("SIGKILL"); await boundedExit(owned); throw error; }
}

export interface HostReply {
  sessionId: string;
  pid: number;
  node: string;
  version: string;
  sdkVersion: string;
  confirmations: Array<{ title: string; message: string; approved: boolean }>;
  messages: Array<{ role: string; toolName?: string; isError?: boolean; details?: Record<string, unknown>; content: unknown }>;
  requests: string[];
  payloadEvents: number;
  onPayloadCalls: number;
  notifications: unknown[];
  tools: string[];
}
export interface Host extends OwnedProcess {
  call(action: string, input?: Record<string, unknown>): Promise<HostReply>;
  close(): Promise<void>;
}
export interface Probe {
  pid: number; node: string; nodeVersion: string; forbiddenReads: number; exited: boolean;
}
export interface InstalledRepository {
  path: string; home: string; agentDir: string; dataRoot: string; repoId: string; commonDir: string;
  indexPath: string; databasePath: string; env: NodeJS.ProcessEnv;
}

/** 只读数据库观察，不执行 refresh、ensureFresh、索引构建或授权写入。 */
export function databaseRows<T>(path: string, namespace: string): T[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // SQLite 的连接级 busy handler 只等待锁竞争，5秒耗尽及非busy错误均原样抛出。
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare("SELECT data FROM records WHERE namespace = ?").all(namespace).map((row) => JSON.parse(String(row.data)) as T);
  } finally { db.close(); }
}

export class InstalledProjectFixture {
  readonly root: string;
  installed = "";
  sdkRoot = "";
  artifactFiles: string[] = [];
  artifactHash = "";
  readonly processes: OwnedProcess[] = [];
  readonly hosts: Host[] = [];
  readonly probes: string[] = [];
  readonly registrations: Array<{ settingsFile: string; source: string; resolvedRoot: string; installedRoot: string }> = [];
  readonly packs: Array<{ cwd: string; before: Awaited<ReturnType<typeof installationInput>>; after?: Awaited<ReturnType<typeof installationInput>> }> = [];
  private closeTask: Promise<void> | undefined;
  private constructor(root: string) { this.root = root; }

  static async create(): Promise<InstalledProjectFixture> {
    const root = await realpath(await mkdtemp("/tmp/m3i-"));
    await chmod(root, 0o700);
    const fixture = new InstalledProjectFixture(root);
    try { await fixture.install(); return fixture; }
    catch (error) { await fixture.close(true); throw error; }
  }

  /** 只测试夹具收尾协议；合成句柄不派出进程，也不替换任何产品实现。 */
  static async cleanupSmoke(): Promise<void> {
    const root = await realpath(await mkdtemp("/tmp/m3c-"));
    await chmod(root, 0o700);
    const previous = process.env.M3_INSTALL_EVIDENCE;
    const evidence = join(root, "evidence");
    const fixture = new InstalledProjectFixture(root);
    const visited: string[] = [];
    const handle = (name: string): ChildProcess => {
      const proc = new ChildProcess();
      proc.kill = () => { visited.push(name); throw new Error(`synthetic stop failure: ${name}`); };
      return proc;
    };
    const rejected = Promise.reject<ProcessResult>(new Error("synthetic exit unknown"));
    void rejected.catch(() => {});
    fixture.processes.push({ proc: handle("pending"), exited: new Promise(() => {}) },
      { proc: handle("rejected"), exited: rejected },
      { proc: handle("ended"), exited: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) });
    try {
      process.env.M3_INSTALL_EVIDENCE = evidence;
      await assert.rejects(fixture.close(), AggregateError);
      assert.deepEqual(visited, ["ended", "rejected", "pending"]);
      const report = JSON.parse(await readFile(join(evidence, `${root.split("/").at(-1)}.json`), "utf8"));
      assert.deepEqual(report.processes.map((item: { state: string }) => item.state), ["unknown", "unknown", "exited"]);
      assert.equal(report.preserved, true); assert.ok(existsSync(root));
      assert.ok(report.cleanupErrors.length >= 3);
    } finally {
      if (previous === undefined) delete process.env.M3_INSTALL_EVIDENCE;
      else process.env.M3_INSTALL_EVIDENCE = previous;
      // 句柄全部为未派出的合成对象，确认没有真实孩子后回收本测试现场。
      assert.ok(fixture.processes.every((owned) => owned.proc.pid === undefined));
      await rm(root, { recursive: true, force: true });
    }
  }

  private async install(): Promise<void> {
    const packs = join(this.root, "p"), consumer = join(this.root, "c"), home = join(this.root, "h"), agent = join(this.root, "a"), temp = join(this.root, "t");
    for (const dir of [packs, consumer, home, agent, temp]) await mkdir(dir, { mode: 0o700 });
    const env = isolatedEnvironment(home, agent, temp);
    const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
    assert.equal((await exec(process.execPath, [pnpm, "--version"], { env })).stdout.trim(), "11.7.0");
    const pack = async (cwd: string) => {
      const inputs: InstalledProjectFixture["packs"][number] = { cwd, before: await installationInput() };
      this.packs.push(inputs);
      let output;
      try { output = await exec(process.execPath, [pnpm, "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", packs], { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }); }
      finally { inputs.after = await installationInput(); }
      const result = JSON.parse(output.stdout) as { filename: string; files: Array<{ path: string }> };
      return { path: resolve(cwd, result.filename), files: result.files.map((entry) => entry.path) };
    };
    const artifact = await pack(sourceRoot);
    this.artifactFiles = artifact.files;
    this.artifactHash = contentHash(await readFile(artifact.path));
    const tree = await pack(dirname(fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"))));
    const typebox = await pack(await realpath(join(sourceRoot, "node_modules/typebox")));
    const jitiRoot = await realpath(join(sourceRoot, "node_modules/jiti"));
    assert.equal(JSON.parse(await readFile(join(jitiRoot, "package.json"), "utf8")).version, "2.7.0");
    const jiti = await pack(jitiRoot);
    const sdk = (specifier: string) => dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
    this.sdkRoot = sdk("@earendil-works/pi-coding-agent");
    assert.equal(JSON.parse(await readFile(join(this.sdkRoot, "package.json"), "utf8")).version, "0.85.1");
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "m3-installed-consumer", version: "1.0.0", private: true, type: "module", packageManager: "pnpm@11.7.0", dependencies: {
      "@0xbb2b/pi-company": `file:${artifact.path}`,
      "@earendil-works/pi-coding-agent": `link:${this.sdkRoot}`,
      "@earendil-works/pi-ai": `link:${sdk("@earendil-works/pi-ai")}`,
      "@earendil-works/pi-tui": `link:${sdk("@earendil-works/pi-tui")}`,
    } }));
    await writeFile(join(consumer, "pnpm-workspace.yaml"), `autoInstallPeers: false\noverrides:\n  typebox: ${JSON.stringify(`file:${typebox.path}`)}\n  web-tree-sitter: ${JSON.stringify(`file:${tree.path}`)}\n  jiti: ${JSON.stringify(`file:${jiti.path}`)}\n`);
    for (const flags of [["--lockfile-only"], ["--frozen-lockfile"]]) {
      await exec(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", ...flags], { cwd: consumer, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    }
    this.installed = await realpath(join(consumer, "node_modules/@0xbb2b/pi-company"));
    assert.notEqual(this.installed, await realpath(sourceRoot));
    assert.ok(this.installed.startsWith(`${consumer}/`));
    // 子进程测试装置本身从 consumer 启动；仅动态导入已安装产品，绝不导入源码版产品。
    await copyFile(self, join(consumer, "host.ts"));
    await writeFile(join(consumer, "probe.ts"), `${await readFile(new URL("./project-index-daemon-child.ts", import.meta.url), "utf8")}\nglobalThis.fetch = async () => { throw new Error("安装夹具禁止外部网络请求"); };\n`);
  }

  async product<T>(file: string): Promise<T> {
    // 普通ESM只加载产品自己的loader；所有安装TS共用正式daemon的模块缓存。
    const { daemonLoader } = await import(pathToFileURL(join(this.installed, "daemon/loader.mjs")).href);
    return await daemonLoader.import(pathToFileURL(join(this.installed, file)).href) as T;
  }
  async git(path: string, args: string[]): Promise<string> {
    const env = isolatedEnvironment(join(this.root, "h"), join(this.root, "a"), join(this.root, "t"));
    return (await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: path, env, timeout: 20_000 })).stdout.trim();
  }
  async repository(name: string, clone?: string): Promise<InstalledRepository> {
    assert.match(name, /^[a-z][a-z0-9]*$/);
    const path = join(this.root, name), home = join(this.root, `${name}h`), agentDir = join(this.root, `${name}a`);
    for (const dir of [home, agentDir]) await mkdir(dir, { mode: 0o700 });
    if (clone) await this.git(this.root, ["clone", clone, path]);
    else {
      await mkdir(path);
      await this.git(path, ["init", "--initial-branch=main"]);
      await writeFile(join(path, "source.ts"), "export const initial = 1;\n");
      await this.git(path, ["add", "."]); await this.git(path, ["commit", "-m", "fixture"]);
    }
    const identity = await this.product<typeof import("../../runtime/identity.ts")>("runtime/identity.ts");
    const { repoId, commonDir } = await identity.repositoryIdentity(path);
    const dataRoot = join(agentDir, "pi-company");
    await identity.repoDataDir(dataRoot, repoId, commonDir);
    const env = isolatedEnvironment(home, agentDir, join(this.root, "t"));
    const repository = { path, home, agentDir, dataRoot, repoId, commonDir, env,
      indexPath: join(dataRoot, "repos", repoId, "index.db"), databasePath: join(dataRoot, "repos", repoId, "data.db") };
    // SDK 官方本地包安装入口，注册的路径是 pnpm 安装后的真实产物，不是源码根。
    await exec(process.execPath, [join(this.sdkRoot, "dist/cli.js"), "install", this.installed], { cwd: path, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const settingsFile = join(agentDir, "settings.json");
    const disk = JSON.parse(await readFile(settingsFile, "utf8")) as { packages: Array<string | { source: string }> };
    assert.ok(Array.isArray(disk.packages)); assert.equal(disk.packages.length, 1, "隔离设置只能注册这一个产物");
    const source = typeof disk.packages[0] === "string" ? disk.packages[0] : disk.packages[0]!.source;
    assert.equal(typeof source, "string");
    // SDK本地source相对所属settings目录保存；用实际SDK解析，再核对文件系统身份。
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { DefaultPackageManager } = await import(pathToFileURL(join(this.sdkRoot, "dist/core/package-manager.js")).href);
    const settings = SettingsManager.create(path, agentDir);
    const manager = new DefaultPackageManager({ cwd: path, agentDir, settingsManager: settings });
    const resolvedPath: string | undefined = manager.getInstalledPath(source, "user");
    assert.ok(resolvedPath, "SDK必须能解析安装source");
    const resolvedRoot = await realpath(resolvedPath);
    this.registrations.push({ settingsFile, source, resolvedRoot, installedRoot: this.installed });
    assert.equal(resolvedRoot, this.installed, "SDK解析必须精确命中本次pnpm安装根");
    await settings.flush(); assert.deepEqual(settings.drainErrors(), []);
    return repository;
  }

  async daemon(repo: InstalledRepository) {
    const probePath = join(this.root, `probe-${this.probes.length}.json`);
    this.probes.push(probePath);
    const owned = child(["--import", join(this.root, "c/probe.ts"), join(this.installed, "daemon/bootstrap.mjs")], repo.path, {
      ...repo.env, PI_COMPANY_SDK_DIR: this.sdkRoot, PI_COMPANY_REPO_DIR: repo.commonDir,
      PI_COMPANY_DATA_ROOT: repo.dataRoot, PI_COMPANY_IDLE_TIMEOUT_MS: "60000",
      M3_ASSEMBLY_PROBE: probePath, M3_ASSEMBLY_REPOSITORY: repo.path,
    });
    this.processes.push(owned);
    const identity = await this.product<typeof import("../../runtime/identity.ts")>("runtime/identity.ts");
    const socket = identity.daemonSocketPath(repo.dataRoot, repo.repoId);
    await Promise.race([eventually(() => existsSync(socket), "已安装daemon socket"), owned.exited.then((result) => { throw new Error(`daemon提前退出：${JSON.stringify(result)}`); })]);
    return { ...owned, probe: async () => JSON.parse(await readFile(probePath, "utf8")) as Probe,
      stop: () => stop(owned), socket };
  }

  async host(repo: InstalledRepository): Promise<Host> {
    const owned = child([join(this.root, "c/host.ts"), "--host"], repo.path, {
      ...repo.env, M3_INSTALLED_PRODUCT: this.installed, M3_INSTALLED_SDK: this.sdkRoot,
      M3_INSTALLED_REPO: repo.repoId, PI_COMPANY_IDLE_TIMEOUT_MS: "60000",
    }, true);
    this.processes.push(owned);
    let next = 0;
    const pending = new Map<number, { done: (value: HostReply) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const ready = new Promise<void>((done, fail) => {
      owned.proc.on("message", (raw) => {
        const message = raw as { id?: number; ready?: boolean; value: HostReply; error?: string };
        if (message.ready) { done(); return; }
        if (message.id === undefined) { if (message.error) fail(new Error(message.error)); return; }
        const entry = pending.get(message.id); if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.fail(new Error(message.error)); else entry.done(message.value);
      });
      void owned.exited.then((result) => {
        const error = new Error(`宿主已退出：${JSON.stringify(result)}`); fail(error);
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.fail(error); } pending.clear();
      }, fail);
    });
    let closed = false;
    const host: Host = { ...owned,
      call(action, input = {}) { return new Promise((done, fail) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`宿主调用超时 ${action}`)); }, 30_000);
        pending.set(id, { done, fail, timer });
        owned.proc.send?.({ id, action, input }, (error) => { if (error) { clearTimeout(timer); pending.delete(id); fail(error); } });
      }); },
      async close() {
        if (closed) return; closed = true;
        if (owned.proc.exitCode !== null || owned.proc.signalCode !== null) { await boundedExit(owned); return; }
        owned.proc.kill("SIGCONT");
        try { await host.call("close"); const result = await boundedExit(owned); assert.equal(result.code, 0, result.stderr); }
        catch (error) { await stop(owned); throw error; }
      },
    };
    this.hosts.push(host);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("宿主未就绪")), 30_000); })]); }
    finally { clearTimeout(timer); }
    return host;
  }

  async snapshot(repo: InstalledRepository): Promise<IndexSnapshot> {
    // getSnapshot 是只读已发布结果；只有 index.db 存在才允许实例化，避免观察建立新库。
    assert.ok(existsSync(repo.indexPath), "尚未发布index.db");
    const index = await this.product<typeof import("../../runtime/index-store.ts")>("runtime/index-store.ts");
    const workspaces = databaseRows<{ workspaceId: string; repoId: string; root: string; branch: string }>(repo.indexPath, "workspaces");
    const workspace = workspaces.find((item) => item.root === repo.path);
    assert.ok(workspace, "找不到已发布workspace");
    const store = new index.IndexStore(repo.indexPath, { workspaceId: workspace.workspaceId, repoId: workspace.repoId, root: workspace.root, branch: workspace.branch });
    try { return store.getSnapshot(); } finally { store.close(); }
  }
  async hasFile(repo: InstalledRepository, path: string, content?: string): Promise<boolean> {
    try { return (await this.snapshot(repo)).files.some((file) => file.path === path && (content === undefined || file.hash === contentHash(content))); }
    catch { return false; }
  }
  close(preserve = false): Promise<void> {
    return this.closeTask ??= this.finishClose(preserve);
  }
  private async finishClose(preserve: boolean): Promise<void> {
    const failures: unknown[] = [];
    for (const host of [...this.hosts].reverse()) { try { await host.close(); } catch (error) { failures.push(error); } }
    for (const proc of [...this.processes].reverse()) { try { await stop(proc); } catch (error) { failures.push(error); } }
    // 每个孩子独立有界确认；stop失败或未知也不能使证据写入永久等待。
    const processes: Array<Record<string, unknown>> = [];
    for (const owned of this.processes) {
      try {
        const result = await boundedExit(owned, 1_000);
        processes.push({ pid: owned.proc.pid, state: "exited", code: result.code, signal: result.signal,
          stdoutHash: contentHash(result.stdout), stderrHash: contentHash(result.stderr), stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
      } catch (error) {
        failures.push(error); processes.push({ pid: owned.proc.pid, state: "unknown" });
      }
    }
    const evidence = process.env.M3_INSTALL_EVIDENCE;
    if (evidence) {
      assert.ok(isAbsolute(evidence), "M3_INSTALL_EVIDENCE 必须为外部绝对目录");
      assert.ok(!resolve(evidence).startsWith(resolve(sourceRoot)), "证据不得写入产品源码树");
      await mkdir(evidence, { recursive: true, mode: 0o700 });
      await writeFile(join(evidence, `${this.root.split("/").at(-1)}.json`), JSON.stringify({
        node: process.execPath, version: process.version, sdk: "0.85.1", artifactHash: this.artifactHash,
        root: this.root, preserved: preserve || failures.length > 0,
        artifactFiles: this.artifactFiles, packs: this.packs, finalInput: await installationInput(), registrations: this.registrations, processes,
        probes: await Promise.all(this.probes.map(async (path) => existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : { missing: path })),
        cleanupErrors: failures.map(String),
      }, null, 2), { mode: 0o600 });
    }
    if (failures.length) throw new AggregateError(failures, `清理失败，保留安装现场 ${this.root}`);
    if (!preserve) await rm(this.root, { recursive: true, force: true });
  }
}

/** SDK 测试前端：确认答案来自独立IPC控制面，不由工具参数或模型文字授予。 */
async function runHost(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("安装夹具禁止外部网络请求"); };
  // daemon由父夹具登记并启动；意外自动拉起必须失败，不能留下父进程无法等待的脱离进程。
  const originalSpawn = childProcess.spawn;
  let unexpectedDaemonSpawns = 0;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    if (Array.isArray(args[1]) && args[1].some((arg) => String(arg).endsWith("/daemon/bootstrap.mjs"))) {
      unexpectedDaemonSpawns++;
      throw new Error("安装夹具禁止未登记的daemon自动拉起");
    }
    return Reflect.apply(originalSpawn, childProcess, args);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import("@earendil-works/pi-ai");
  const cwd = await realpath(process.cwd()), agentDir = process.env.PI_CODING_AGENT_DIR!;
  const sdkVersion = JSON.parse(await readFile(join(process.env.M3_INSTALLED_SDK!, "package.json"), "utf8")).version as string;
  assert.equal(sdkVersion, "0.85.1");
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  type Reply = { calls?: ToolCall[]; text?: string };
  const queue: Reply[] = [], approvals: boolean[] = [];
  const requests: string[] = [], confirmations: HostReply["confirmations"] = [], notifications: unknown[] = [];
  let payloadEvents = 0, onPayloadCalls = 0, timestamp = 0;
  runtime.registerProvider("installed-controlled", { apiKey: "fixture", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
    models: [{ id: "controlled", name: "controlled", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = ai.createAssistantMessageEventStream(), reply = queue.shift();
      requests.push(JSON.stringify(context));
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: ++timestamp,
        content: reply?.calls?.length ? reply.calls : [{ type: "text", text: reply?.text ?? "unexpected unscripted request" }],
        stopReason: reply?.calls?.length ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        assert.ok(reply, "无受控模型响应，禁止回落外部LLM");
        assert.equal(typeof options?.onPayload, "function", "必须执行真实SDK payload接线");
        await options!.onPayload!({ fixture: "installed-controlled", messages: context.messages }, model); onPayloadCalls++;
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: reply.calls?.length ? "toolUse" : "stop", message });
      })().catch((error) => stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } }));
      return stream;
    },
  });
  const settings = sdk.SettingsManager.create(cwd, agentDir);
  settings.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { pi.on("before_provider_request", () => { payloadEvents++; }); }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const installedExtensions = loader.getExtensions().extensions.filter((extension) => !extension.path.startsWith("<inline:"));
  assert.equal(installedExtensions.length, 1);
  assert.equal(await realpath(installedExtensions[0]!.path), join(process.env.M3_INSTALLED_PRODUCT!, "extensions/index.ts"));
  let session: AgentSession | undefined;
  let bound = false, disposed = false;
  const close = async () => {
    if (disposed) return; disposed = true;
    const errors: unknown[] = [];
    if (session) {
      try {
        const abort = !session.isIdle ? session.abort() : Promise.resolve();
        await abort; await session.waitForIdle();
      } catch (error) { errors.push(error); }
      try { if (bound) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      catch (error) { errors.push(error); }
      finally { session.dispose(); }
    }
    try { await settings.flush(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "SDK宿主清理失败");
  };
  try {
    ({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
      modelRuntime: runtime, model: runtime.getModels("installed-controlled")[0], sessionManager: sdk.SessionManager.inMemory(cwd),
      tools: ["pi_company_project_manage", "pi_company_knowledge_query", "read", "write", "edit", "bash", "pi_company_git_commit"],
    }));
    const ui: ExtensionUIContext = { ...session.extensionRunner.getUIContext(),
      confirm: async (title, message) => {
        const approved = approvals.shift();
        assert.notEqual(approved, undefined, `未安排可信前端确认：${title}`);
        confirmations.push({ title, message, approved: approved! }); return approved!;
      },
      notify: (message, kind) => { notifications.push({ kind, message }); },
      setStatus: (key, message) => { notifications.push({ key, message }); },
      select: async () => undefined, input: async () => undefined, editor: async () => undefined, custom: async () => undefined as never,
    };
    bound = true; await session.bindExtensions({ uiContext: ui, mode: "rpc" });
    const get = (): HostReply => {
      assert.equal(unexpectedDaemonSpawns, 0, "发生了未登记daemon拉起尝试，不能作为正式安装通过");
      return { sessionId: session!.sessionId, pid: process.pid, node: process.execPath, version: process.version, sdkVersion,
        confirmations, requests, payloadEvents, onPayloadCalls, notifications,
        messages: session!.messages as unknown as HostReply["messages"], tools: session!.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name) };
    };
    process.on("message", (raw) => {
      const { id, action, input } = raw as { id: number; action: string; input: Record<string, unknown> };
      void (async () => {
        if (action === "close") { await close(); process.send?.({ id, value: get() }, () => { process.disconnect?.(); }); return; }
        if (action === "approve") approvals.push(input.value === true);
        else if (action === "project" || action === "tool" || action === "text") {
          const name = action === "project" ? "pi_company_project_manage" : String(input.name ?? "write");
          const calls: ToolCall[] = action === "text" || input.textOnly === true ? [] : [{ type: "toolCall", id: `installed-${timestamp + 1}`, name,
            arguments: action === "project" ? { ...input, repoId: process.env.M3_INSTALLED_REPO } : input.args as Record<string, unknown> }];
          queue.push({ calls, text: "controlled answer" });
          if (calls.length) queue.push({ text: "controlled follow-up" });
          await session!.prompt("测试前端发起当前项目操作", { source: "interactive" }).then(() => session!.waitForIdle()).finally(() => { queue.length = 0; });
        } else if (action !== "get") throw new Error(`未知夹具动作 ${action}`);
        process.send?.({ id, value: get() });
      })().catch((error) => process.send?.({ id, error: error instanceof Error ? error.stack : String(error) }));
    });
    process.once("SIGTERM", () => { void close().then(() => { process.disconnect?.(); }, (error) => { console.error(error); process.exitCode = 1; process.disconnect?.(); }); });
    process.send?.({ ready: true });
  } catch (error) { await close(); throw error; }
}

export async function fixtureSmoke(): Promise<void> {
  const root = await realpath(await mkdtemp("/tmp/m3s-"));
  try {
    assert.ok(isAbsolute(root)); assert.equal(await realpath(root), root);
    const env = isolatedEnvironment(join(root, "h"), join(root, "a"), root);
    assert.equal(env.PI_OFFLINE, "1"); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(contentHash("same"), contentHash(Buffer.from("same")));
    assert.equal(databaseRows(join(root, "missing.db"), "records").length, 0);
    assert.equal(existsSync(join(root, "missing.db")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv.includes("--host")) await runHost().catch((error) => { process.send?.({ error: String(error) }); console.error(error); process.exitCode = 1; process.disconnect?.(); });
  else if (process.argv.includes("--smoke")) { await fixtureSmoke(); console.log("fixture smoke passed; 正式安装未运行"); }
}
