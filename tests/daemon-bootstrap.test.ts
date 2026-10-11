import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectTestClient, waitForSocketReady } from "./helpers/daemon-harness.ts";
import { daemonSocketPath, repositoryIdentity } from "../runtime/identity.ts";


const exec = promisify(execFile);
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeExecutables = [...new Set([process.execPath, process.env.M3_BOOTSTRAP_NODE22].filter((value): value is string => !!value))];
const records: Record<string, unknown>[] = [];
const owned: Array<{ proc: ChildProcess; closed: Promise<Exit>; result?: Exit }> = [];
type Exit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };
let root: string;
let installed: string;
let sdkRoot: string;
let env: NodeJS.ProcessEnv;
let artifactHash: string;
let installedHashes: Record<string, string> = {};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function bounded<T>(task: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("bootstrap 测试等待超时")), ms); })])
    .finally(() => clearTimeout(timer));
}

function child(node: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const proc = spawn(node, args, { cwd: join(root, "cwd"), env: { ...env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const entry: (typeof owned)[number] = { proc, closed: new Promise<Exit>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal, stderr }));
  }) };
  void entry.closed.then((result) => { entry.result = result; }, () => {});
  owned.push(entry);
  return entry;
}

beforeAll(async () => {
  // 短且独立的根目录避免 macOS socket 长度限制；所有数据均属本次安装测试。
  root = await realpath(await mkdtemp("/tmp/m3b-"));
  await chmod(root, 0o700);
  for (const name of ["packs", "consumer", "home", "agent", "tmp", "cwd"]) await mkdir(join(root, name), { mode: 0o700 });
  env = {
    PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
    TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "home/config"), XDG_CACHE_HOME: join(root, "home/cache"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  };
  const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
  expect((await exec(process.execPath, [pnpm, "--version"], { env })).stdout.trim()).toBe("11.7.0");
  async function pack(cwd: string) {
    const output = await exec(process.execPath, [pnpm, "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", join(root, "packs")], { cwd, env, timeout: 30_000 });
    const result = JSON.parse(output.stdout) as { filename: string; files: Array<{ path: string }> };
    return { path: resolve(cwd, result.filename), files: result.files.map((file) => file.path) };
  }
  const artifact = await pack(sourceRoot);
  artifactHash = hash(await readFile(artifact.path));
  expect(artifact.files).toContain("daemon/bootstrap.mjs");
  expect(artifact.files).toContain("daemon/loader.mjs");
  const dependencyPacks: Record<string, string> = {};
  for (const name of ["jiti", "typebox", "web-tree-sitter"]) dependencyPacks[name] = `file:${(await pack(await realpath(join(sourceRoot, "node_modules", name)))).path}`;
  const dependencies: Record<string, string> = { "@0xbb2b/one-company": `file:${artifact.path}` };
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
    const path = await realpath(join(sourceRoot, "node_modules", name));
    dependencies[name] = `link:${path}`;
    if (name.endsWith("pi-coding-agent")) sdkRoot = path;
  }
  const consumer = join(root, "consumer");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", packageManager: "pnpm@11.7.0", dependencies }), { mode: 0o600 });
  await writeFile(join(consumer, "pnpm-workspace.yaml"), `autoInstallPeers: false\noverrides:\n${Object.entries(dependencyPacks).map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`).join("\n")}\n`, { mode: 0o600 });
  for (const flag of ["--lockfile-only", "--frozen-lockfile"]) await exec(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", flag], { cwd: consumer, env, timeout: 30_000 });
  installed = await realpath(join(consumer, "node_modules/@0xbb2b/one-company"));
  expect(installed.startsWith(`${consumer}/node_modules/`)).toBe(true);
  expect(installed).not.toBe(await realpath(sourceRoot));
  for (const file of ["daemon/bootstrap.mjs", "daemon/loader.mjs", "daemon/main.ts", "daemon/sdk.ts", "runtime/daemon-client.ts", "package.json"]) {
    installedHashes[file] = hash(await readFile(join(installed, file)));
    if (file !== "package.json") expect(installedHashes[file], file).toBe(hash(await readFile(join(sourceRoot, file))));
  }
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  // pnpm pack 移除 packageManager 并重排 JSON；其他分发字段必须逐项相等。
  const { packageManager, ...sourceManifest } = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  expect(packageManager).toBe("pnpm@11.7.0");
  expect(manifest).toEqual(sourceManifest);
  expect(manifest.dependencies.jiti).toBe("2.7.0");
  expect(manifest.devDependencies.jiti).toBeUndefined();
  // 任意 cwd 的同名模块不能接管正式 loader 的依赖解析。
  await mkdir(join(root, "cwd/node_modules/jiti"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "cwd/node_modules/jiti/package.json"), JSON.stringify({ type: "module", main: "index.js" }), { mode: 0o600 });
  await writeFile(join(root, "cwd/node_modules/jiti/index.js"), 'throw new Error("CWD_JITI_MUST_NOT_LOAD");\n', { mode: 0o600 });
}, 120_000);

afterAll(async () => {
  const unknown: number[] = [];
  for (const entry of owned) {
    if (!entry.result) entry.proc.kill("SIGTERM");
    try { await bounded(entry.closed, 8_000); }
    catch { entry.proc.kill("SIGKILL"); try { await bounded(entry.closed, 3_000); } catch { unknown.push(entry.proc.pid ?? -1); } }
  }
  const finalHashes: Record<string, string> = {};
  for (const file of Object.keys(installedHashes)) finalHashes[file] = hash(await readFile(join(installed, file)));
  const report = { artifactHash, installed, root, installedHashes, finalHashes, records, processes: owned.map((entry) => ({ pid: entry.proc.pid,
    code: entry.result?.code, signal: entry.result?.signal, stderrHash: hash(entry.result?.stderr ?? ""), exited: !!entry.result })), unknown };
  if (process.env.M3_BOOTSTRAP_EVIDENCE) {
    const evidence = process.env.M3_BOOTSTRAP_EVIDENCE;
    await mkdir(evidence, { recursive: true, mode: 0o700 }); await chmod(evidence, 0o700);
    await writeFile(join(evidence, "installed-results.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  if (unknown.length) throw new Error(`bootstrap 测试孩子退出状态未知，保留现场 ${root}`);
  if (root) await rm(root, { recursive: true, force: true });
  expect(finalHashes).toEqual(installedHashes);
}, 30_000);

for (const node of nodeExecutables) describe(`正式安装 bootstrap (${node})`, () => {
  test("共享 loader 不启动 daemon，TS 缓存及 SDK/SQLite 的原生实例一致且不落磁盘缓存", async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const root = ${JSON.stringify(installed)};
      const sdkDir = ${JSON.stringify(sdkRoot)};
      const nativeSdk = await import(pathToFileURL(sdkDir + '/dist/index.js'));
      const nativeSignalListeners = process.listeners('SIGTERM');
      const { daemonLoader } = await import(pathToFileURL(root + '/daemon/loader.mjs'));
      assert.equal(daemonLoader.options.fsCache, false);
      assert.equal(daemonLoader.options.tryNative, false);
      const coordinator = pathToFileURL(root + '/daemon/project-index-host.ts').href;
      assert.strictEqual(await daemonLoader.import(coordinator), await daemonLoader.import(coordinator));
      const { loadSdk } = await daemonLoader.import(pathToFileURL(root + '/daemon/sdk.ts').href);
      assert.strictEqual(await loadSdk(sdkDir), nativeSdk);
      const aiUrl = daemonLoader.esmResolve('@earendil-works/pi-ai');
      assert.strictEqual(await daemonLoader.import('@earendil-works/pi-ai'), await import(aiUrl));
      assert.strictEqual(await daemonLoader.import('node:sqlite'), await import('node:sqlite'));
      assert.deepEqual(process.listeners('SIGTERM'), nativeSignalListeners);
    `;
    const result = await bounded(child(node, ["--input-type=module", "-e", script], { JITI_FS_CACHE: join(root, "forbidden-cache"), JITI_TRY_NATIVE: "true" }).closed);
    expect(result.stderr).not.toContain("CWD_JITI_MUST_NOT_LOAD"); expect(result.code, result.stderr).toBe(0);
    expect(existsSync(join(root, "forbidden-cache"))).toBe(false);
    expect(existsSync(join(root, "tmp/jiti"))).toBe(false);
    records.push({ node, scenario: "loader-native-identity", code: result.code });
  }, 30_000);

  test.each(["shutdown", "SIGTERM"])("真实 hello、唯一性与 %s 退出", async (method) => {
    const scenarioRoot = await mkdtemp(join(root, "s-"));
    const repo = join(scenarioRoot, "repo"), dataRoot = join(scenarioRoot, "d"), home = join(scenarioRoot, "h");
    for (const dir of [repo, home]) await mkdir(dir, { mode: 0o700 });
    await exec("git", ["-c", "core.hooksPath=/dev/null", "init", "--initial-branch=main"], { cwd: repo, env, timeout: 10_000 });
    const identity = await repositoryIdentity(repo);
    const socket = daemonSocketPath(dataRoot, identity.repoId);
    const extra = { HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), ONE_COMPANY_REPO_DIR: identity.commonDir,
      ONE_COMPANY_DATA_ROOT: dataRoot, ONE_COMPANY_SDK_DIR: sdkRoot, ONE_COMPANY_IDLE_TIMEOUT_MS: "30000" };
    const first = child(node, [join(installed, "daemon/bootstrap.mjs")], extra);
    await Promise.race([waitForSocketReady(socket), first.closed.then((exit) => { throw new Error(`bootstrap 在 hello 前退出 ${exit.code}: ${exit.stderr}`); })]);
    const client = await bounded(connectTestClient(socket, {}, { dataRoot }));
    try {
      expect(client.helloResult.daemonPid).toBe(first.proc.pid);
      expect(client.helloResult.repoId).toBe(identity.repoId);
      expect(client.helloResult.protocolVersion).toBe(2);
      expect(typeof client.helloResult.daemonInstanceId).toBe("string");
      const duplicate = child(node, [join(installed, "daemon/bootstrap.mjs")], extra);
      expect((await bounded(duplicate.closed)).code).toBe(0);
      expect(first.result).toBeUndefined();
      await bounded(client.call("ping"));
      if (method === "SIGTERM") first.proc.kill("SIGTERM");
      else await bounded(client.call("shutdown"));
      const exit = await bounded(first.closed);
      expect(exit).toMatchObject({ code: 0, signal: null });
      expect(existsSync(socket)).toBe(false);
      const version = (await exec(node, ["--version"], { env })).stdout.trim();
      records.push({ node, version, scenario: method, pid: first.proc.pid, hello: client.helloResult, exit: { code: exit.code, signal: exit.signal } });
    } finally { client.close(); }
  }, 40_000);

  test.each(["missing-sdk-env", "missing-sdk-dir", "old-sdk", "missing-main", "missing-jiti"])("%s 明确非零退出，不降级", async (scenario) => {
    const extra: NodeJS.ProcessEnv = { ONE_COMPANY_REPO_DIR: join(root, "cwd"), ONE_COMPANY_DATA_ROOT: join(root, "error-data"), ONE_COMPANY_SDK_DIR: sdkRoot };
    let moved: string | undefined;
    let expected: string;
    if (scenario === "missing-sdk-env") { delete extra.ONE_COMPANY_SDK_DIR; expected = "缺少环境变量: ONE_COMPANY_SDK_DIR"; }
    else if (scenario === "missing-sdk-dir") { extra.ONE_COMPANY_SDK_DIR = join(root, "missing-sdk"); expected = "SDK 目录缺失"; }
    else if (scenario === "old-sdk") {
      extra.ONE_COMPANY_SDK_DIR = join(root, "old-sdk"); await mkdir(extra.ONE_COMPANY_SDK_DIR, { recursive: true, mode: 0o700 });
      await writeFile(join(extra.ONE_COMPANY_SDK_DIR, "package.json"), '{"version":"0.84.0"}', { mode: 0o600 }); expected = "SDK 版本过低";
    } else if (scenario === "missing-main") { moved = join(installed, "daemon/main.ts"); expected = "main.ts"; }
    else {
      const require = createRequire(join(installed, "package.json"));
      moved = join(dirname(require.resolve("jiti/package.json")), "lib/jiti.mjs"); expected = "jiti";
    }
    if (moved) await rename(moved, `${moved}.bootstrap-test-save`);
    try {
      const result = await bounded(child(node, [join(installed, "daemon/bootstrap.mjs")], extra).closed);
      expect(result.code).toBe(1); expect(result.signal).toBeNull(); expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
      expect(existsSync(join(root, "error-data"))).toBe(false);
      records.push({ node, scenario, code: result.code, stderrHash: hash(result.stderr) });
    } finally { if (moved) await rename(`${moved}.bootstrap-test-save`, moved); }
  }, 30_000);
});
