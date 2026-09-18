import { afterEach, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryDatabase, uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { DatabaseSync } from "node:sqlite";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import type { EventProcessConfig } from "./helpers/requirement-events-process.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { testHostGitExecutable } from "./helpers/test-git-binding.ts";

const HOST_GIT = testHostGitExecutable([]);

const helper = fileURLToPath(new URL("./helpers/requirement-events-process.ts", import.meta.url));
const evidenceDirectory = process.env.M3_AC_COVERAGE_EVIDENCE;
const worlds: World[] = [];
const BODY1 = "PROCESS_PRIVATE_BODY_ONE";
const BODY2 = "PROCESS_PRIVATE_BODY_TWO";
const BODY3 = "PROCESS_PRIVATE_BODY_THREE";
const DRAFT = "PROCESS_PRIVATE_DRAFT_EXCLUDED";

async function bounded<T>(pending: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}未在${timeout}ms内确认`)), timeout);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function launch() {
  const child = spawn(process.execPath, ["--experimental-strip-types", helper], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  let sequence = 0;
  let closed = false;
  let stdout = "";
  let stderr = "";
  const replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const trace: unknown[] = [];
  child.stdout.on("data", (data) => { stdout += String(data); });
  child.stderr.on("data", (data) => { stderr += String(data); });
  child.on("message", (reply: any) => {
    const waiting = replies.get(reply.id);
    if (!waiting) return;
    replies.delete(reply.id);
    trace.push(reply);
    if (reply.ok) waiting.resolve(reply.result);
    else waiting.reject(new Error(`child command failed: ${JSON.stringify(reply.error)}`));
  });
  child.on("error", (error) => { for (const waiting of replies.values()) waiting.reject(error); replies.clear(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      for (const waiting of replies.values()) waiting.reject(new Error("child closed before reply"));
      replies.clear();
      resolve({ code, signal });
    });
  });
  async function call(command: string, input?: unknown): Promise<any> {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      replies.set(id, { resolve, reject });
      child.send({ id, command, input }, (error) => {
        if (error) { replies.delete(id); reject(error); }
      });
    });
    return bounded(result, `child ${child.pid} ${command}`);
  }
  return { child, call, exited, trace, isClosed: () => closed,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (!closed) {
        const result = await call("shutdown");
        expect(result).toEqual({ disposed: true, pending: 0 });
      }
      const exit = await bounded(exited, `child ${child.pid} close`);
      expect(exit).toEqual({ code: 0, signal: null });
      return exit;
    },
  };
}

type Process = ReturnType<typeof launch>;
interface World {
  root: string;
  repo?: RepoFixture;
  children: Process[];
  checks: Record<string, unknown>;
}

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-events-process-"));
  await chmod(root, 0o700);
  const record: World = { root, children: [], checks: {} };
  worlds.push(record);
  const repo = await createRepoFixture();
  record.repo = repo;
  await chmod(repo.root, 0o700);
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId,
    gitExecutable: HOST_GIT, authorize: () => true };
  const service = await RequirementService.open(options);
  const state = await RequirementStateStore.open(options);
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "进程事件测试", body: BODY1 });
  const worktree = await addWorktree(repo);
  await chmod(worktree.root, 0o700);
  // 绑定所需的实际Git提交从已创建的测试仓库读取，不使用需求Git的HEAD。
  const head = execFileSync(HOST_GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, encoding: "utf8" }).trim();
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit: head });
  const approved = await service.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(), version: bound.version,
    title: "进程事件测试", body: BODY1, receiptId: uuidv7() });
  const effectsPath = join(root, "effects.txt");
  await writeFile(effectsPath, "", { mode: 0o600 });
  const now = Date.now();
  const config: EventProcessConfig = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot,
    repoId: options.repoId, gitExecutable: options.gitExecutable, requirementId: created.requirementId, effectsPath, now };
  async function child(clock = now) {
    const process = launch();
    record.children.push(process);
    const runtime = await process.call("open", { ...config, now: clock });
    expect(runtime.executable).toBe(globalThis.process.execPath);
    expect(runtime.version).toBe(globalThis.process.version);
    expect(runtime.pid).not.toBe(globalThis.process.pid);
    return process;
  }
  async function approve(body: string, draft?: string) {
    if (draft) await service.updateDraft({ requirementId: created.requirementId, operationId: uuidv7(),
      version: state.read(created.requirementId).version, title: "进程事件测试", body: draft });
    return service.confirmUpdate({ requirementId: created.requirementId, operationId: uuidv7(),
      version: state.read(created.requirementId).version, title: "进程事件测试", body, receiptId: uuidv7() });
  }
  async function assertNoBodyInDatabase() {
    const path = repositoryDatabase(options.dataRoot, options.repoId);
    const database = new DatabaseSync(path);
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const rows = JSON.stringify(database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
        expect([BODY1, BODY2, BODY3, DRAFT].some((body) => rows.includes(body))).toBe(false);
        expect(/"(?:body|prodBody|patch|diff|rawContent|transcript)"\s*:/.test(rows.replaceAll('\\"', '"'))).toBe(false);
      }
      record.checks.databaseTablesChecked = tables.map((table) => table.name);
      record.checks.databaseBodyOrPatch = false;
      const byteChecks: string[] = [];
      for (const suffix of ["", "-wal", "-shm"]) {
        const bytes = await readFile(`${path}${suffix}`).catch((error: NodeJS.ErrnoException) => {
          if (suffix && error.code === "ENOENT") return null;
          throw error;
        });
        if (!bytes) continue;
        expect([BODY1, BODY2, BODY3, DRAFT, "diff --git a/prod.md"].some((text) => bytes.includes(text))).toBe(false);
        byteChecks.push(suffix || ".db");
      }
      record.checks.databaseByteFilesChecked = byteChecks;
    } finally { database.close(); }
  }
  return { root, record, options, state, service, created, approved, effectsPath, child, approve, assertNoBodyInDatabase };
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const w of worlds.splice(0)) {
    const stopped: unknown[] = [];
    let safeToDelete = true;
    for (const child of w.children) {
      try { stopped.push({ pid: child.child.pid, ...(await child.stop()) }); }
      catch (error) { failures.push(error); safeToDelete = false; stopped.push({ pid: child.child.pid, closed: child.isClosed(), stopUnconfirmed: true }); }
    }
    if (safeToDelete) {
      if (w.repo) await removeRepoFixture(w.repo);
      await rm(w.root, { recursive: true, force: true });
    }
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      await chmod(evidenceDirectory, 0o700);
      await writeFile(join(evidenceDirectory, `process-${uuidv7()}.json`), JSON.stringify({ runtime: { version: process.version, executable: process.execPath },
        checks: w.checks, stopped, fixturesRemoved: safeToDelete, fixturePaths: { root: w.root, repo: w.repo },
        children: w.children.map((child) => ({ pid: child.child.pid, trace: child.trace, output: child.output() })) }, null, 2), { mode: 0o600 });
    }
    if (!safeToDelete) console.error(`进程停止未确认，保留fixtures：${JSON.stringify({ root: w.root, repo: w.repo })}`);
  }
  if (failures.length) throw new AggregateError(failures, "跨进程夹具收尾失败，未强制退出或删除未知现场");
}, 60_000);

test("M3-AC6/5：A独立Node消费ack并退出，B新Node有效lease恢复cursor与当前active基线，不重放副作用", async () => {
  const w = await world();
  const a = await w.child();
  const first = await a.call("acquire");
  expect(first.notice).toMatchObject({ status: "baseline_required", reason: "baseline_missing", revision: 1 });
  await a.call("baseline", { expectedBody: BODY1 });
  const second = await w.approve(BODY2, DRAFT);
  const consumed = await a.call("event", { fromBody: BODY1, toBody: BODY2, excludedBody: DRAFT });
  expect(consumed).toMatchObject({ sinkCalls: 1, cursor: { understoodRevision: 2, understoodCommit: second.commit }, next: { status: "caught_up" } });
  await a.stop();
  expect(a.isClosed()).toBe(true);
  // A已经真实退出但未主动release租约；可信时钟只推进到旧租约到期后。
  const third = await w.approve(BODY3);
  const b = await w.child(first.lease.expiresAt + 1);
  expect(b.child.pid).not.toBe(a.child.pid);
  const takeover = await b.call("acquire");
  expect(takeover.lease.fence).toBe(first.lease.fence + 1);
  expect(takeover.lease.runId).not.toBe(first.lease.runId);
  expect(takeover.cursor).toMatchObject({ consumedSequence: consumed.cursor.consumedSequence, understoodRevision: 2, understoodCommit: second.commit });
  expect(takeover.notice).toMatchObject({ status: "baseline_required", reason: "context_missing", revision: 3, commit: third.commit, prodHash: third.prodHash });
  expect(await b.call("old-lease", first.lease)).toEqual({ rejected: true });
  const baseline = await b.call("baseline", { expectedBody: BODY3 });
  expect(baseline).toMatchObject({ bodyMatched: true, revision: 3, commit: third.commit,
    cursor: { consumedSequence: consumed.cursor.consumedSequence, understoodRevision: 2 } });
  const resumed = await b.call("event", { fromBody: BODY2, toBody: BODY3 });
  expect(resumed).toMatchObject({ sinkCalls: 1, event: { fromRevision: 2, toRevision: 3, fromCommit: second.commit, toCommit: third.commit },
    cursor: { understoodRevision: 3 }, next: { status: "caught_up" } });
  expect((await readFile(w.effectsPath, "utf8")).trim().split("\n")).toEqual([consumed.event.eventId, resumed.event.eventId]);
  await w.assertNoBodyInDatabase();
  w.record.checks.recovery = { oldPidClosedBeforeTakeover: true, effects: 2, repeatedEffects: 0,
    oldFence: first.lease.fence, newFence: takeover.lease.fence, recoveredCursor: consumed.cursor.consumedSequence, currentRevision: 3 };
}, 45_000);

test("M3-AC8：B独立Node提交closing后，A仍持真实prepared handle在最终DB门槛拒绝正文，不靠同进程撤销回调", async () => {
  const w = await world();
  const a = await w.child();
  const b = await w.child();
  await a.call("acquire");
  const held = await a.call("hold");
  expect(held).toMatchObject({ pending: 1, cleanupTimerPaused: true, invalidations: 0 });
  const closing = await b.call("close");
  expect(closing).toMatchObject({ lifecycle: "closing", epoch: held.preparedEpoch + 1 });
  expect(closing.pid).not.toBe(a.child.pid);
  // IPC回执是明确屏障：B的closing事务成功之后才让A消费。
  const rejected = await a.call("consume-held");
  expect(rejected).toEqual({ presentBefore: true, expired: false, invalidations: 0, sinkCalls: 0,
    errorCode: "lifecycle_denied", pendingAfter: 0, lifecycle: "closing", bodyReadsAfterClosing: 0 });
  expect(await readFile(w.effectsPath, "utf8")).toBe("");
  await w.assertNoBodyInDatabase();
  w.record.checks.closingRace = rejected;
}, 30_000);
