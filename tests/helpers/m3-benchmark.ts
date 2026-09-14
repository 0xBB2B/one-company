import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, version } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** 内核层测量；不启动daemon/宿主/模型，不签发M3阶段验收。 */
export const FROZEN = Object.freeze({ files: 1000, scriptFiles: 600, goFiles: 300, specFiles: 100,
  archiveCounts: [0, 1000, 10000], coldSamples: 5, restartSamples: 10, updateSamples: 100,
  eventSamples: 100, resourceRounds: 10, maxTextBytes: 20 * 1024 * 1024,
  updateTimeoutMs: 10_000, pollIntervalMs: 10, resourceIntervalMs: 25, settleMs: 250 });
export const SMOKE = Object.freeze({ ...FROZEN, files: 7, scriptFiles: 4, goFiles: 1, specFiles: 2,
  archiveCounts: [1], coldSamples: 1, restartSamples: 1, updateSamples: 2, eventSamples: 1, resourceRounds: 2 });
export type BenchmarkConfig = { [K in keyof typeof FROZEN]: typeof FROZEN[K] extends number ? number : number[] };
export type Sample = { category: string; index: number; ok: boolean; durationMs: number | null;
  error?: string; [key: string]: unknown };
export type ChildJob = { mode: "cold" | "restart" | "live" | "events"; index: number; repo: string; dataRoot: string;
  fixtureRoot: string; output: string; git: string; config: BenchmarkConfig; smoke: boolean; archives: number };
export const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function jsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
export function appendSample(output: string, sample: Sample): void {
  appendFileSync(join(output, "samples.jsonl"), `${JSON.stringify(sample)}\n`, { mode: 0o600 });
}
export function summarize(samples: Sample[]) {
  return [...new Set(samples.map((item) => item.category))].map((category) => {
    const all = samples.filter((item) => item.category === category);
    // 失败占据排序末端；不得剔除失败后重新缩小分母。
    const ordered = all.map((item) => item.ok && item.durationMs !== null ? item.durationMs : Infinity).sort((a, b) => a - b);
    const rank = Math.ceil(0.95 * ordered.length);
    const p95 = ordered[rank - 1];
    const threshold = category === "cold" ? 60_000 : category === "watch-update" || category === "approved-event" ? 2_000 : null;
    return { category, count: all.length, failures: all.filter((item) => !item.ok).length, rank,
      p95Ms: Number.isFinite(p95) ? p95 : null, p95IncludesFailure: !Number.isFinite(p95), thresholdMs: threshold,
      withinThresholdCount: threshold === null ? null : all.filter((item) => item.ok && item.durationMs !== null && item.durationMs <= threshold).length,
      thresholdResult: threshold === null ? "not_defined" : Number.isFinite(p95) && p95 <= threshold ? "within_reference" : "outside_reference" };
  });
}
export function specText(id: number, revision = 0): string {
  return `${JSON.stringify({ $schema: "schema.json", schemaVersion: 1,
    feature: { id: `bench.feature${id}`, title: `功能${id}`, aliases: [`别名${id}`] },
    rules: [{ id: `bench.rule${id}`, title: `规则${id}`, condition: "收到输入", trigger: "处理请求",
      expected: `返回结果${String(revision).padStart(4, "0")}`, reason: "保持结果可检查", dependsOn: [], exceptions: [],
      acceptance: [{ id: "result", given: "输入有效", when: "处理", then: `结果为${String(revision).padStart(4, "0")}` }] }] })}\n`;
}
export function gitEnv(home: string): NodeJS.ProcessEnv {
  // 不继承Git仓库、配置注入、hook或用户身份；所有Git写入只发生在夹具根。
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "m3-benchmark", GIT_AUTHOR_EMAIL: "benchmark@localhost", GIT_COMMITTER_NAME: "m3-benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@localhost", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
}
export function gitRun(git: string, cwd: string, args: string[], home: string): string {
  return execFileSync(git, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "core.fsmonitor=false", ...args],
    { cwd, env: gitEnv(home), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(root: string, config: BenchmarkConfig, archives: number, git: string, output: string) {
  const repo = join(root, "repo");
  await mkdir(repo, { mode: 0o700 });
  const manifest: Array<{ path: string; bytes: number; sha256: string; kind: string }> = [];
  const put = async (path: string, text: string, kind: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(repo, path), text, { mode: 0o600, flag: "wx" });
    manifest.push({ path, bytes: Buffer.byteLength(text), sha256: sha(text), kind });
  };
  const extensions = ["ts", "tsx", "js", "jsx"];
  for (let i = 0; i < config.scriptFiles; i++) {
    const extension = extensions[i % 4];
    const text = extension === "tsx" || extension === "jsx"
      ? `export function component${i}() { return <span>value${i}</span>; }\n`
      : `export function value${i}() { return ${i}; }\n`;
    await put(`src/file${String(i).padStart(4, "0")}.${extension}`, text, extension);
  }
  for (let i = 0; i < config.goFiles; i++) await put(`go/file${String(i).padStart(4, "0")}.go`,
    `package bench\nfunc Value${i}() int { return ${i} }\n`, "go");
  const schema = await readFile(new URL("../../resources/spec/schema.json", import.meta.url), "utf8");
  await put("docs/spec/schema.json", schema, "schema");
  for (let i = 0; i < config.specFiles - 1; i++) await put(`docs/spec/rule${String(i).padStart(4, "0")}.rules.json`, specText(i), "spec");
  const sourceFiles = manifest.length;
  const textBytes = manifest.reduce((sum, item) => sum + item.bytes, 0);
  if (sourceFiles !== config.files || new Set(manifest.map((item) => item.sha256)).size !== config.files || textBytes > config.maxTextBytes) {
    throw new Error("夹具规模、内容唯一性或文本预算不匹配");
  }
  await mkdir(join(repo, "docs/prod"), { recursive: true, mode: 0o700 });
  for (let i = 0; i < archives; i++) {
    const id = `019b76da-a800-7000-8000-${i.toString(16).padStart(12, "0")}`;
    // 正文仅由生成器写入；产品探针期间不读取、不计算磁盘正文hash。
    await put(`docs/prod/${id}.benchmark.md`, `M3_ARCHIVE_BODY_CANARY_${i}\n`, "archive-excluded");
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path, "en"));
  jsonFile(join(output, "fixture-manifest.json"), { generator: "m3-deterministic-v1", sourceFiles, textBytes,
    scriptFiles: config.scriptFiles, goFiles: config.goFiles, specFilesIncludingSchema: config.specFiles,
    archives, manifestHash: sha(JSON.stringify(manifest)), files: manifest });
  gitRun(git, repo, ["init", "--template=", "-b", "main"], root);
  gitRun(git, repo, ["add", "--", "src", "go", "docs/spec"], root);
  gitRun(git, repo, ["commit", "-m", "benchmark fixture"], root);
  return repo;
}
function help(): string {
  return `内核层M3基准（无daemon/宿主/模型；不测knowledge_query）\n` +
    `用法：node --experimental-strip-types tests/helpers/m3-benchmark.ts --output <新绝对目录> [--scenario all|cold|restart|live|events] [--git /usr/bin/git] [--smoke]\n` +
    `正式参数固定：${JSON.stringify(FROZEN)}\n` +
    `--smoke仅开发冒烟：${JSON.stringify(SMOKE)}；不计为性能证据。\n` +
    `cold=新进程/新库；restart=先独立建库后新进程复用；live=真实watch更新及同进程多轮启停；events=真实批准提交/租约/投递。\n` +
    `每个归档规模单独串行执行；失败保留，不清OS缓存、不强制GC。输出目录须全新，0700；报告0600。\n`;
}
async function launch(job: ChildJob, nodeArgs: string[]): Promise<{ ok: boolean; wallMs: number; code: number | null; signal: string | null; processGroupClean: boolean }> {
  mkdirSync(job.output, { mode: 0o700 });
  const configPath = join(job.output, "job.json");
  jsonFile(configPath, job);
  const start = performance.now();
  const child = spawn(process.execPath, [...nodeArgs, fileURLToPath(new URL("m3-benchmark-child.ts", import.meta.url)), configPath], {
    cwd: job.fixtureRoot, env: { ...gitEnv(job.fixtureRoot), PI_OFFLINE: "1", PI_TELEMETRY: "0", NODE_DISABLE_COMPILE_CACHE: "1" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const log = (name: string, data: Buffer) => appendFileSync(join(job.output, name), data, { mode: 0o600 });
  child.stdout.on("data", (data: Buffer) => log("stdout.log", data));
  child.stderr.on("data", (data: Buffer) => log("stderr.log", data));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const stop = () => {
    timedOut = true;
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 15_000);
  };
  const deadline = setTimeout(stop, job.smoke ? 120_000 : 30 * 60_000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    // 只处理本次spawn创建的独立进程组，不根据旧PID或名称清理其他进程。
    const residualGroup = signalGroup(0);
    if (residualGroup) {
      signalGroup("SIGTERM");
      for (let i = 0; i < 100 && signalGroup(0); i++) await delay(50);
      if (signalGroup(0)) signalGroup("SIGKILL");
      for (let i = 0; i < 100 && signalGroup(0); i++) await delay(50);
    }
    const processGroupClean = !signalGroup(0);
    const record = { ok: !timedOut && !residualGroup && processGroupClean && result.code === 0,
      wallMs: performance.now() - start, ...result, timedOut, residualGroup, processGroupClean };
    jsonFile(join(job.output, "process.json"), record);
    return record;
  } finally {
    clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(help()); return; }
  let output = "", scenario = "all", git = "/usr/bin/git", smoke = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`重复参数：${arg}`);
    seen.add(arg);
    if (arg === "--smoke") smoke = true;
    else if (["--output", "--scenario", "--git"].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`缺少参数：${arg}`);
      if (arg === "--output") output = value; else if (arg === "--scenario") scenario = value; else git = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!output || !isAbsolute(output) || !isAbsolute(git) || !["all", "cold", "restart", "live", "events"].includes(scenario)) throw new Error(help());
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("进程组清理仅支持POSIX平台，拒绝无保护降级");
  if (!["v22.19.0", "v26.8.2"].includes(process.version)) throw new Error(`未锁定的Node版本：${process.version}；拒绝静默换版本`);
  output = resolve(output);
  const parent = await realpath(dirname(output));
  output = join(parent, relative(dirname(output), output));
  process.umask(0o077);
  await mkdir(output, { mode: 0o700 }); // 不复用或覆盖已有输出目录。
  chmodSync(output, 0o700);
  const config = smoke ? SMOKE : FROZEN;
  const scriptRoot = fileURLToPath(new URL("../../", import.meta.url));
  const inputPaths = ["tests/helpers/m3-benchmark.ts", "tests/helpers/m3-benchmark-child.ts", "pnpm-lock.yaml", "package.json",
    "SQLITE-KNOWLEDGE-REBUILD-PLAN.md", "M0-BASELINE-REPORT.md", "resources/tree-sitter/manifest.json",
    "runtime/project-index-sync.ts", "runtime/project-index-service.ts", "runtime/project-index-policy.ts", "runtime/index-store.ts",
    "runtime/code-extractor.ts", "runtime/syntax-parser.ts", "runtime/database.ts", "runtime/requirement-events.ts",
    "runtime/requirement-service.ts", "runtime/requirement-state.ts", "runtime/prod-storage.ts"];
  const hashes = async () => Promise.all(inputPaths.map(async (path) => ({ path, sha256: sha(await readFile(join(scriptRoot, path))) })));
  const before = await hashes();
  const disk = await statfs(output);
  const nodeArgs = ["--experimental-strip-types"];
  jsonFile(join(output, "run.json"), { level: "kernel", evidence: smoke ? "development-smoke-not-performance" : "measurement-not-stage-acceptance",
    scenario, config, argv: process.argv, cwd: process.cwd(), node: { executable: await realpath(process.execPath), version: process.version,
      executableSha256: sha(await readFile(process.execPath)), arch: process.arch, versions: process.versions, childArgs: nodeArgs },
    git: { executable: await realpath(git), version: gitRun(git, output, ["--version"], output) },
    host: { platform: process.platform, release: release(), version: version(), cpu: cpus()[0]?.model, cpuCount: cpus().length,
      memoryBytes: totalmem(), diskBlockSize: disk.bsize, diskBlocks: disk.blocks, diskAvailableBlocks: disk.bavail },
    coldDefinition: "new process/new database; OS cache untouched", p95: "sort all samples; ceil(.95*N); failures sort as infinity",
    resourceMethod: "same-process rounds; no forced GC; 25ms sampled peak plus phase boundaries; no absolute leak-free claim",
    knowledgeQuery: "not_measured_M4_M9", modelTime: "not_invoked", inputs: before,
    head: gitRun(git, scriptRoot, ["rev-parse", "HEAD"], output), startedAt: new Date().toISOString() });
  console.log(JSON.stringify({ output, level: "kernel", scenario, smoke, config }));
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const processes: Array<{ archives: number; mode: ChildJob["mode"]; index: number; output: string; ok: boolean;
    wallMs: number; code: number | null; signal: string | null }> = [];
  const groups: Array<{ archives: number; summaries: ReturnType<typeof summarize>; sampleCount: number }> = [];
  let failures = 0;
  try {
    for (const archives of config.archiveCounts) {
      if (interrupted) break;
      const groupOutput = join(output, `archives-${archives}`);
      await mkdir(groupOutput, { mode: 0o700 });
      const fixtureRoot = await realpath(await mkdtemp(join(await realpath("/tmp"), smoke ? "m3-benchmark-dev-fixture-" : "m3-benchmark-fixture-")));
      let fixtureSafeToRemove = true;
      try {
        const repo = await fixture(fixtureRoot, config, archives, git, groupOutput);
        const run = async (mode: ChildJob["mode"], index: number, dataRoot: string) => {
          if (interrupted) return false;
          const childOutput = join(groupOutput, `${mode}-${index}`);
          const result = await launch({ mode, index, repo, dataRoot, fixtureRoot, output: childOutput, git, config, smoke, archives }, nodeArgs);
          processes.push({ archives, mode, index, output: childOutput, ...result });
          if (!result.ok) failures++;
          if (!result.processGroupClean) { fixtureSafeToRemove = false; interrupted = true; }
          return result.ok;
        };
        const reuseRoot = join(fixtureRoot, "reuse-data");
        if (["all", "cold"].includes(scenario)) {
          for (let i = 0; i < config.coldSamples; i++) await run("cold", i, i === config.coldSamples - 1 ? reuseRoot : join(fixtureRoot, `cold-data-${i}`));
        } else if (scenario === "restart") await run("cold", -1, reuseRoot);
        if (["all", "restart"].includes(scenario)) {
          for (let i = 0; i < config.restartSamples; i++) await run("restart", i, reuseRoot);
        }
        if (["all", "live"].includes(scenario)) await run("live", 0, join(fixtureRoot, "live-data"));
        if (["all", "events"].includes(scenario)) await run("events", 0, join(fixtureRoot, "event-data"));
      } catch (error) {
        failures++;
        jsonFile(join(groupOutput, "setup-error.json"), { error: String(error) });
      } finally {
        // 所有本脚本启动的Node已close；只删除本轮生成的夹具，报告保留。
        if (fixtureSafeToRemove) await rm(fixtureRoot, { recursive: true, force: true });
        let exists = true; try { await lstat(fixtureRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
        jsonFile(join(groupOutput, "cleanup.json"), { fixtureRoot, removed: !exists, fixtureSafeToRemove });
        if (exists) failures++;
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    for (const archives of config.archiveCounts) {
      const groupSamples: Sample[] = [];
      for (const processResult of processes.filter((item) => item.archives === archives)) {
        const childSamples: Sample[] = [];
        try {
          const text = await readFile(join(processResult.output, "samples.jsonl"), "utf8");
          for (const line of text.trim().split("\n").filter(Boolean)) {
            try { childSamples.push(JSON.parse(line) as Sample); }
            catch { failures++; }
          }
        } catch { failures++; }
        const expected: Array<[string, number]> = processResult.mode === "live" ? [["watch-update", config.updateSamples], ["resource-round", config.resourceRounds]]
          : processResult.mode === "events" ? [["approved-event", config.eventSamples]] : [[processResult.mode === "cold" && processResult.index < 0 ? "restart-warmup" : processResult.mode, 1]];
        for (const [category, count] of expected) {
          const actual = childSamples.filter((item) => item.category === category).length;
          if (actual !== count) failures++;
          for (let index = actual; index < count; index++) childSamples.push({ category,
            index: count === 1 ? processResult.index : index, ok: false, durationMs: null, error: "child_exited_without_sample" });
        }
        groupSamples.push(...childSamples);
      }
      groups.push({ archives, summaries: summarize(groupSamples), sampleCount: groupSamples.length });
    }
    const after = await hashes();
    const inputsChanged = JSON.stringify(before) !== JSON.stringify(after);
    const referenceTargetsMet = smoke ? null : !interrupted && failures === 0 && groups.every((group) => group.summaries.every((item) => item.thresholdResult !== "outside_reference"));
    jsonFile(join(output, "summary.json"), { level: "kernel", smoke, scenario, processes, groups, failures, interrupted, inputsChanged,
      referenceTargetsMet, smokeReferenceComparisonsNotEvidence: smoke,
      inputsAfter: after, complete: !interrupted && failures === 0 && !inputsChanged,
      stageAcceptance: "not_issued", resourceConvergence: "inspect_same_process_trend_and_limitations_not_process_exit",
      uncovered: ["daemon/host end-to-end", "model behavior", "knowledge query", "physical sleep", "long-term/absolute memory leak freedom"] });
    if (failures || interrupted || inputsChanged || referenceTargetsMet === false) process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
