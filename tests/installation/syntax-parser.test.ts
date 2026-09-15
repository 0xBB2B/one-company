import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const probe = fileURLToPath(new URL("../helpers/syntax-installation-probe.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/syntax-cases.json", import.meta.url));

// 安装验收需 OS 级禁网，未实现其他平台的测试隔离后端时明确未执行。
test.skipIf(process.platform !== "darwin")("M0-AC1/2：真实产品安装产物在任意 cwd 离线解析，缺失/损坏/版本不符不降级", async () => {
  const node = process.execPath;
  const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
  const root = await mkdtemp(join(tmpdir(), "pi-company-parser-install-"));
  const env = {
    PATH: process.env.PATH!, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    NODE_COMPILE_CACHE: join(root, "node-cache"), JITI_FS_CACHE: "false",
    XDG_CACHE_HOME: join(root, "cache"), npm_config_store_dir: join(root, "store"),
    npm_config_ignore_scripts: "true", npm_config_update_notifier: "false",
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
  };
  const sandbox = "(version 1)(allow default)(deny network*)";
  const run = async (command: string, args: string[], cwd = root) => {
    try {
      return await exec("/usr/bin/sandbox-exec", ["-p", sandbox, command, ...args], {
        cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      console.error("离线安装命令失败", { command, args, cwd, store: env.npm_config_store_dir,
        stdout: failure.stdout, stderr: failure.stderr });
      throw error;
    }
  };
  let passed = false;
  try {
    for (const dir of [env.HOME, env.TMPDIR, env.NODE_COMPILE_CACHE, env.PI_CODING_AGENT_DIR, join(root, "packs"), join(root, "consumer"), join(root, "other cwd 中文")]) {
      await mkdir(dir, { recursive: true });
    }
    async function pack(path: string) {
      const { stdout } = await run(node, [pnpm, "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", join(root, "packs")], path);
      const result = JSON.parse(stdout);
      return { path: resolve(path, result.filename), files: result.files.map((file: { path: string }) => file.path) as string[] };
    }
    const artifact = await pack(productRoot);
    const runtime = await pack(dirname(require.resolve("web-tree-sitter/web-tree-sitter.wasm")));
    const typebox = await pack(await realpath(join(productRoot, "node_modules/typebox")));
    const jitiRoot = await realpath(join(productRoot, "node_modules/jiti"));
    expect(JSON.parse(await readFile(join(jitiRoot, "package.json"), "utf8")).version).toBe("2.7.0");
    const jiti = await pack(jitiRoot);
    for (const entry of ["runtime/short-decision-format.ts", "runtime/short-decisions.ts", "runtime/requirement-state.ts", "runtime/requirement-contracts.ts", "runtime/requirement-workspace.ts", "runtime/database-paths.ts", "runtime/database-maintenance.ts", "runtime/spec-format.ts", "runtime/strict-json.ts", "resources/spec/schema.json", "runtime/syntax-parser.ts", "resources/tree-sitter/manifest.json", "resources/tree-sitter/tree-sitter-go.wasm", "resources/tree-sitter/tree-sitter-tsx.wasm", "resources/tree-sitter/tree-sitter-typescript.wasm", "resources/tree-sitter/tree-sitter-javascript.wasm"]) {
      expect(artifact.files).toContain(entry);
    }
    expect(artifact.files.some((file) => /(?:^|\/)(?:data|index|global)\.(?:db|sqlite)(?:-|$)/.test(file))).toBe(false);
    expect(artifact.files.some((file) => file.startsWith("tests/") || file.startsWith("node_modules/") || file.startsWith(".git/"))).toBe(false);
    await writeFile(join(root, "consumer/package.json"), JSON.stringify({ name: "parser-install-consumer", version: "1.0.0", private: true,
      packageManager: "pnpm@11.7.0", dependencies: { "@0xbb2b/pi-company": `file:${artifact.path}` } }));
    // 宿主提供 peer 包；运行依赖固定为本机 tarball，仍使用 pnpm 的隔离链接布局。
    await writeFile(join(root, "consumer/pnpm-workspace.yaml"), `autoInstallPeers: false\noverrides:\n  typebox: ${JSON.stringify(`file:${typebox.path}`)}\n  web-tree-sitter: ${JSON.stringify(`file:${runtime.path}`)}\n  jiti: ${JSON.stringify(`file:${jiti.path}`)}\n`);
    await run(node, [pnpm, "install", "--offline", "--ignore-scripts", "--lockfile-only"], join(root, "consumer"));
    await run(node, [pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], join(root, "consumer"));
    const installed = await realpath(join(root, "consumer/node_modules/@0xbb2b/pi-company"));
    expect(installed).not.toBe(await realpath(productRoot));
    const installedRequire = createRequire(join(installed, "package.json"));
    const installedRuntime = dirname(installedRequire.resolve("web-tree-sitter/web-tree-sitter.wasm"));
    const installedJiti = installedRequire.resolve("jiti/package.json");
    expect(installedJiti.startsWith(join(root, "consumer") + "/")).toBe(true);
    expect(JSON.parse(await readFile(installedJiti, "utf8")).version).toBe("2.7.0");
    const installedManifest = join(installed, "resources/tree-sitter/manifest.json");
    const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    const runtimePackage = JSON.parse(await readFile(join(installedRuntime, "package.json"), "utf8"));
    expect(installedPackage.dependencies.jiti).toBe("2.7.0");
    expect(installedPackage.dependencies["web-tree-sitter"]).toBe("0.27.0");
    expect(runtimePackage.version).toBe("0.27.0");
    expect(installedPackage.scripts?.preinstall).toBe("node runtime/git-prerequisite.mjs --check");
    for (const hook of ["install", "postinstall"]) expect(installedPackage.scripts?.[hook]).toBeUndefined();
    for (const hook of ["preinstall", "install", "postinstall"]) expect(runtimePackage.scripts?.[hook]).toBeUndefined();
    const manifest = JSON.parse(await readFile(installedManifest, "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.runtime.version).toBe("0.27.0");
    expect(Object.keys(manifest.grammars).sort()).toEqual(["go", "javascript", "tsx", "typescript"]);
    for (const [name, resource] of Object.entries({ runtime: manifest.runtime, ...manifest.grammars }) as Array<[string, any]>) {
      const path = name === "runtime" ? join(installedRuntime, resource.file) : join(installed, "resources/tree-sitter", resource.file);
      expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(resource.sha256);
      expect(resource.tarball).toBe(`https://registry.npmjs.org/${resource.package}/-/${resource.package}-${resource.version}.tgz`);
      expect(resource.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(await readFile(join(installed, "resources/tree-sitter", resource.license), "utf8")).toContain("Permission is hereby granted, free of charge");
    }
    const installedPackages = await readdir(join(root, "consumer/node_modules/.pnpm"));
    expect(installedPackages.filter((name) => /^(tree-sitter-|(?:codegraph|node-gyp-build)(?:@|$))/.test(name))).toEqual([]);
    const hostRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const hostPackage = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
    const cli = join(hostRoot, hostPackage.bin.pi);
    await run(node, [cli, "install", installed], join(root, "other cwd 中文"));
    const settings = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
    expect(settings.packages.map((path: string) => resolve(env.PI_CODING_AGENT_DIR, path))).toContain(installed);

    async function probeInstalled(mode: string, cwd: string, language = "js") {
      for (const executable of [node]) {
        const { stdout } = await run(executable, [probe, installed, fixtures, mode, language], cwd);
        const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
        expect(result.status).toBe("PASS");
        expect(result.networkAttempts).toBe(0);
        if (mode === "valid") expect(result.count).toBe(5);
      }
    }
    await probeInstalled("valid", "/");
    await probeInstalled("valid", join(root, "other cwd 中文"));
    const failures: Array<{ path: string; code: string; contents?: string; language?: string }> = [
      { path: join(installedRuntime, "web-tree-sitter.wasm"), code: "resource_missing" },
      { path: join(installedRuntime, "web-tree-sitter.wasm"), code: "resource_invalid", contents: "damaged runtime" },
      ...Object.entries({ typescript: "ts", tsx: "tsx", javascript: "js", go: "go" }).flatMap(([grammar, language]) => [
        { path: join(installed, `resources/tree-sitter/tree-sitter-${grammar}.wasm`), code: "resource_missing", language },
        { path: join(installed, `resources/tree-sitter/tree-sitter-${grammar}.wasm`), code: "resource_invalid", contents: "damaged grammar", language },
      ]),
      { path: installedManifest, code: "resource_missing" },
      { path: installedManifest, code: "resource_invalid", contents: "{" },
      { path: installedManifest, code: "resource_incompatible", contents: JSON.stringify({ ...manifest, grammars: { ...manifest.grammars, javascript: { ...manifest.grammars.javascript, abiVersion: 13 } } }) },
      { path: join(installedRuntime, "package.json"), code: "resource_incompatible", contents: JSON.stringify({ ...JSON.parse(await readFile(join(installedRuntime, "package.json"), "utf8")), version: "0.26.0" }) },
    ];
    for (const failure of failures) {
      const original = await readFile(failure.path);
      try {
        if (failure.contents === undefined) await rm(failure.path);
        else await writeFile(failure.path, failure.contents);
        await probeInstalled(failure.code, join(root, "other cwd 中文"), failure.language);
      } finally { await writeFile(failure.path, original); }
    }
    await probeInstalled("warm-invalid", "/");
    await probeInstalled("valid", "/");
    console.log(JSON.stringify({ artifactSha256: createHash("sha256").update(await readFile(artifact.path)).digest("hex"),
      resourceSha256: Object.fromEntries(Object.entries(manifest.grammars).map(([name, entry]) => [name, (entry as { sha256: string }).sha256])),
      runtimes: [`Node ${process.versions.node}`], validRuns: 3, failureRuns: failures.length, warmInvalidRuns: 1, network: "OS deny network*", installation: "pnpm isolated layout + exact dependency tarballs, pi install registered" }));
    // 业务夹具仅依赖标准文件，不导入产品或其数据库。
    const business = join(root, "business");
    await mkdir(business);
    await writeFile(join(business, "spec.json"), '{"schemaVersion":1}');
    await writeFile(join(business, "prod.md"), "# 人工文件夹具\n");
    await run(node, ["--input-type=module", "-e", "import{readFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(JSON.parse(readFileSync('spec.json','utf8')).schemaVersion,1);assert(readFileSync('prod.md','utf8').startsWith('#'));"], business);
    passed = true;
  } finally {
    // execFile 的回调在子进程 close 后完成；仅成功且命令全部收尾才删除安装现场。
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error("离线安装夹具失败，保留现场：", root);
  }
}, 120_000);
