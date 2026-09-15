import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  FORMAL_QUERY_BENCHMARK,
  QUERY_CASES,
  SMOKE_QUERY_BENCHMARK,
  summarizeQueryHits,
  summarizeQuerySamples,
  assertQueryPageMetadata,
} from "./helpers/m4-query-benchmark.ts";
import type { QuerySample } from "./helpers/m4-query-benchmark.ts";

function sample(index: number, durationMs: number | null, ok = true): QuerySample {
  return {
    archiveCount: 0,
    queryId: "exact-path",
    index,
    ok,
    queryMs: durationMs,
    checkMs: durationMs,
    combinedMs: durationMs,
    responseBytes: 100 + index,
    pageBytes: 80 + index,
    generation: 1,
    baselineHash: "a".repeat(64),
    receiptChecked: ok,
    authorizationValidatedBefore: ok,
    authorizationValidatedAfter: ok,
    requirement: null,
    hitCount: ok ? 1 : null,
    hitIdentifiers: ok ? ["file:src/file0000.ts"] : [],
    hitPaths: ok ? ["src/file0000.ts"] : [],
    expectedHitObserved: ok,
    coverage: { matched: 1, returned: 1, omitted: 0, remaining: 0, sourceExcerptsTruncated: 0, complete: true, nextCursor: false },
    unknown: { performanceImprovement: "unknown", formalVerification: "not_available", unknownCodeRelations: 0, unindexedFiles: 0 },
    ...(ok ? {} : { error: { code: "fixture", message: "fixture" } }),
  };
}

async function runSmoke(output: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const helper = fileURLToPath(new URL("./helpers/m4-query-benchmark.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", helper, "--output", output, "--scenario", "smoke"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal }));
    });
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timeout);
  }
}

test("基准参数和p95算法固定，失败样本不能从分母剔除", () => {
  expect(FORMAL_QUERY_BENCHMARK).toMatchObject({
    files: 1000,
    scriptFiles: 600,
    goFiles: 300,
    specFiles: 100,
    archiveCounts: [0, 1000, 10000],
    samplesPerQuery: 100,
    maxTextBytes: 20 * 1024 * 1024,
  });
  expect(SMOKE_QUERY_BENCHMARK).toMatchObject({ samplesPerQuery: 2 });
  expect(QUERY_CASES).toEqual([
    expect.objectContaining({ id: "exact-path", combinedThresholdMs: 500 }),
    expect.objectContaining({ id: "chinese-search", combinedThresholdMs: 2000 }),
    expect.objectContaining({ id: "finite-facts", combinedThresholdMs: 2000 }),
  ]);
  const values = Array.from({ length: 100 }, (_, index) => sample(index, index + 1));
  expect(summarizeQuerySamples(values)[0]).toMatchObject({ rank: 95, queryP95Ms: 95, combinedP95Ms: 95, failures: 0 });
  values[0] = sample(0, null, false);
  expect(summarizeQuerySamples(values)[0]).toMatchObject({ rank: 95, failures: 1, combinedP95Ms: 96 });
  for (let index = 0; index < 6; index++) values[index] = sample(index, null, false);
  expect(summarizeQuerySamples(values)[0]).toMatchObject({ rank: 95, failures: 6, combinedP95Ms: null, p95IncludesFailure: true });
});

test("命中摘要拒绝空结果和错误来源，只保存有界标识而不复制正文", () => {
  expect(() => summarizeQueryHits("exact-path", [])).toThrow(/query_expected_hit_missing/);
  expect(() => summarizeQueryHits("exact-path", [{ kind: "file", id: "wrong", source: { path: "src/other.ts" } }]))
    .toThrow(/query_expected_hit_missing/);
  expect(() => summarizeQueryHits("chinese-search", [{ kind: "source", id: "fragment", source: { path: "src/file0000.ts" } }]))
    .toThrow(/query_expected_hit_missing/);
  expect(() => summarizeQueryHits("finite-facts", [{ kind: "rule", id: "benchmark.rule0", source: { path: "docs/spec/wrong.rules.json" } }]))
    .toThrow(/query_expected_hit_missing/);
  const facts = Array.from({ length: 40 }, (_, index) => ({ kind: "rule", id: index === 0 ? "benchmark.rule0" : `rule${index}`,
    source: { path: index === 0 ? "docs/spec/rule0000.rules.json" : `docs/spec/rule${index}.rules.json` },
    data: { body: `不应进入摘要${index}` } }));
  const summary = summarizeQueryHits("chinese-search", facts);
  expect(summary).toMatchObject({ hitCount: 40, expectedHitObserved: true });
  expect(summary.hitIdentifiers).toHaveLength(32);
  expect(summary.hitPaths).toHaveLength(32);
  expect(JSON.stringify(summary)).not.toContain("不应进入摘要");
});

test("页面实际UTF-8预算独立于receipt外壳，精确上限接受、超一字节拒绝", () => {
  const limit = 16_384;
  const page = { generation: 1, text: "中文\\\"" };
  const used = Buffer.byteLength(JSON.stringify(page));
  page.text += "x".repeat(limit - used);
  expect(Buffer.byteLength(JSON.stringify(page))).toBe(limit);
  expect(() => assertQueryPageMetadata(page, limit)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify({ page, receipt: "a".repeat(43) }))).toBeGreaterThan(limit);
  page.text += "x";
  expect(() => assertQueryPageMetadata(page, limit)).toThrow(/query_page_budget_exceeded/);
});

test.each([undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])("generation=%s不能成为成功样本", (generation) => {
  expect(() => assertQueryPageMetadata({ generation }, 16_384)).toThrow(/query_generation_invalid/);
});

test("相同内容baselineHash下合法generation更新仍接受", () => {
  const baselineHash = "a".repeat(64);
  for (const generation of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const page = { baselineHash, generation };
    expect(() => assertQueryPageMetadata(page, 16_384)).not.toThrow();
  }
});

test("smoke通过真实SQLite、认证socket、query及随后check，并清理夹具资源", async () => {
  const parent = process.env.M4_QUERY_BENCHMARK_TEST_EVIDENCE_ROOT ?? tmpdir();
  const root = await mkdtemp(join(parent, "m4-query-benchmark-test-"));
  const output = join(root, "evidence");
  let exit: Awaited<ReturnType<typeof runSmoke>> | undefined;
  let passed = false;
  try {
    exit = await runSmoke(output, { M4_QUERY_BENCHMARK_FAULT: "" });
    expect(exit, exit.stderr).toMatchObject({ code: 0, signal: null });
    const run = JSON.parse(await readFile(join(output, "run.json"), "utf8"));
    const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(output, "closed-metadata-2/fixture-manifest.json"), "utf8"));
    const setup = JSON.parse(await readFile(join(output, "closed-metadata-2/setup.json"), "utf8"));
    const cleanup = JSON.parse(await readFile(join(output, "closed-metadata-2/cleanup.json"), "utf8"));
    const samples = (await readFile(join(output, "samples.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(run).toMatchObject({ formal: false, scenario: "smoke", performanceClaimAllowed: false,
      node: { execPath: process.execPath, version: process.version }, config: { samplesPerQuery: 2, archiveCounts: [2] } });
    expect(run.timingLayer).toContain("project.index.query");
    expect(run.excludedTimingLayers).toEqual(expect.arrayContaining(["pi SDK tool lifecycle", "cloud/model request"]));
    expect(manifest).toMatchObject({ sourceFiles: 12, distinctContentHashes: 12, scripts: 7, go: 3,
      specsIncludingSchema: 2, archiveMetadataCount: 2 });
    expect(manifest.textBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(setup).toMatchObject({ ok: true, status: "ready", indexedFiles: 12, archiveMetadataCount: 2, archiveIssues: 0 });
    expect(samples).toHaveLength(QUERY_CASES.length * 2);
    expect(samples.every((value) => value.ok && value.queryMs >= 0 && value.checkMs >= 0 && value.combinedMs >= value.queryMs + value.checkMs
      && value.responseBytes > 0 && value.receiptChecked && value.authorizationValidatedBefore && value.authorizationValidatedAfter
      && value.requirement === null && value.hitCount > 0 && value.expectedHitObserved
      && Number.isSafeInteger(value.generation) && value.generation >= 1
      && value.pageBytes <= Number(QUERY_CASES.find((query) => query.id === value.queryId)!.request.maxBytes)
      && value.coverage.complete && !value.coverage.nextCursor)).toBe(true);
    expect(samples.filter((value) => value.queryId === "exact-path").every((value) => value.hitPaths.includes("src/file0000.ts"))).toBe(true);
    expect(samples.filter((value) => value.queryId !== "exact-path").every((value) => value.hitIdentifiers.includes("rule:benchmark.rule0")
      && value.hitPaths.includes("docs/spec/rule0000.rules.json"))).toBe(true);
    expect(JSON.stringify(samples)).not.toContain("export function");
    expect(new Set(samples.map((value) => value.queryId))).toEqual(new Set(QUERY_CASES.map((query) => query.id)));
    expect(cleanup).toMatchObject({ fixtureRemoved: true, socketRootRemoved: true, rootsPreservedForDiagnostics: false,
      peerClosed: true, coordinatorClosed: true, issuerClosed: true, serverClosed: true, probeRestored: true, activeGitChildren: [],
      archiveReadProbe: { positiveControlReads: expect.any(Number), archiveBodyReadAttempts: 0, attemptedArchivePaths: [] }, errors: [], ok: true });
    expect(cleanup.archiveReadProbe.positiveControlReads).toBeGreaterThan(0);
    expect(summary).toMatchObject({ formal: false, scenario: "smoke", ok: true, sampleCount: 6, expectedSamples: 6,
      sampleCountComplete: true, failures: 0, inputsStable: true, headStable: true, referenceTargetsObserved: null,
      smokeMustNotClaimThreshold: true, stageAcceptance: "not_issued", gitSubprocesses: { activeAtEnd: [], allExited: true } });
    expect(summary.resultScope).toContain("smoke harness self-check only");
    expect((await lstat(output)).mode & 0o077).toBe(0);
    passed = true;
  } finally {
    if (passed && exit?.code === 0 && exit.signal === null) await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("关闭失败时非零退出、关闭字段如实且保留证据根，子进程结束后才限定清理注入夹具", async () => {
  const parent = process.env.M4_QUERY_BENCHMARK_TEST_EVIDENCE_ROOT ?? tmpdir();
  const root = await mkdtemp(join(parent, "m4-query-benchmark-fault-"));
  const output = join(root, "evidence");
  const exit = await runSmoke(output, { M4_QUERY_BENCHMARK_FAULT: "coordinator_close_after_success" });
  await writeFile(join(root, "failure-child.json"), `${JSON.stringify(exit, null, 2)}\n`, { mode: 0o600 });
  expect(exit).toMatchObject({ code: 1, signal: null });
  const cleanup = JSON.parse(await readFile(join(output, "closed-metadata-2/cleanup.json"), "utf8"));
  const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
  expect(cleanup).toMatchObject({ fixtureRemoved: false, socketRootRemoved: false, rootsPreservedForDiagnostics: true,
    peerClosed: true, coordinatorClosed: false, issuerClosed: true, serverClosed: true, probeRestored: true,
    activeGitChildren: [], ok: false });
  expect(cleanup.errors).toEqual(expect.arrayContaining([expect.stringContaining("injected_coordinator_close_failure")]));
  expect(summary).toMatchObject({ ok: false, failures: 0, gitSubprocesses: { activeAtEnd: [], allExited: true },
    resources: { cleanupComplete: false } });
  expect((await lstat(root)).isDirectory()).toBe(true);
  expect((await lstat(cleanup.fixtureRoot)).isDirectory()).toBe(true);
  expect((await lstat(cleanup.socketRoot)).isDirectory()).toBe(true);
  await expect(lstat(join(cleanup.socketRoot, "q.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  await rm(cleanup.fixtureRoot, { recursive: true, force: true });
  await rm(cleanup.socketRoot, { recursive: true, force: true });
  await expect(lstat(cleanup.fixtureRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(cleanup.socketRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(root, "post-child-fixture-cleanup.json"), `${JSON.stringify({
    child: { code: exit.code, signal: exit.signal }, activeGitChildren: cleanup.activeGitChildren,
    fixtureRemovedAfterChildExit: true, socketRootRemovedAfterChildExit: true, evidenceRootPreserved: root,
  }, null, 2)}\n`, { mode: 0o600 });
}, 180_000);
