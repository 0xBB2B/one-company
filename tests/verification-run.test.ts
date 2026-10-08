import { afterEach, expect, test, vi } from "vitest";
import { writeGuardLaunch } from "../runtime/command-boundary.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { defaultRoleDir } from "../runtime/roles.ts";
import { join } from "node:path";
import { LocalDatabase, repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { claimRequirementWriteIn, releaseRequirementWriteIn } from "../runtime/requirement-coordination.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createChangeApplyTool } from "../runtime/change-apply.ts";
import { activeCheckRoundIn, CheckRoundService, formalEvidence, CHECK_ROUNDS, VERIFICATION_RUNS } from "../runtime/check-round.ts";
import type { CheckRoundServiceOptions } from "../runtime/check-round.ts";
import { createVerificationRunTool } from "../runtime/verification-run.ts";
import { submitVerdict } from "../runtime/verdicts.ts";
import type { VerificationRunGrant, VerificationRunToolOptions, VerificationView } from "../runtime/verification-run.ts";
import * as store from "../runtime/store.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const BODY_2 = "# 目标 {#goals}\n保留移动并增加快跑。\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const darwin = process.platform === "darwin";
// 项目里遗留的规则文件只是普通输入文件，不参与任何校验
const MOVE = JSON.stringify({ feature: "player", note: "移动" }, null, 2) + "\n";
const NA = { applicable: false as const, reason: "纯逻辑改动，无性能影响" };

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "verification-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...options, authorize: (request) => {
    if (request.repoId !== options.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  }, authorizeManifest: () => true });
  const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "acquire-pm", "release-pm", "check-pm", "begin-close", "block-recovery"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const created = await service.create(create);
  const worktree = await addWorktree(repo);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const approve = draftApprover(options, service, { requirementId: created.requirementId, operationId: created.operationId, title: "角色跳跃", body: BODY }, grantWrite);
  await approve(BODY);
  await mkdir(join(worktree.root, "docs", "spec", "player"), { recursive: true });
  await writeFile(join(worktree.root, "docs", "spec", "player", "move.rules.json"), MOVE);
  await mkdir(join(worktree.root, "src"), { recursive: true });
  await writeFile(join(worktree.root, "src", "a.ts"), "export const a = 1;\n");
  await runGit(["add", "."], worktree.root); await runGit(["commit", "-qm", "seed"], worktree.root);
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: state.read(created.requirementId).version, runId: uuidv7(), expectedFence: 0 });
  const record = state.read(created.requirementId).data;
  const workspace = record.workspace!;
  const database = repositoryDatabase(options.dataRoot, options.repoId);
  const roundPermits = new Set<string>();
  const roundHost: CheckRoundServiceOptions["authorize"] = (request) => request.lease === undefined || roundPermits.has(request.lease.runId);
  roundPermits.add(lease.runId);
  const rounds = await CheckRoundService.open({ ...options, authorize: roundHost });
  cleanups.push(async () => rounds.dispose());
  const permits = new Map<string, string>();
  function grant(extra: Partial<VerificationRunGrant> = {}): VerificationRunGrant {
    return { role: "qa", callerId: uuidv7(), runId: uuidv7(), requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch, ...extra };
  }
  const host: VerificationRunToolOptions["authorize"] = (request) => permits.get(request.grant.callerId) === JSON.stringify(request.grant);
  async function tool(bound = grant(), authorize = host, reviewedAttemptRunIds?: string[]) {
    permits.set(bound.callerId, JSON.stringify(bound));
    const instance = await createVerificationRunTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize,
      ...(reviewedAttemptRunIds ? { reviewedAttemptRunIds } : {}) });
    cleanups.push(() => instance.dispose()); return instance;
  }
  async function changeApply(runId = uuidv7()) {
    const bound = { role: "worker" as const, callerId: uuidv7(), runId, requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch, writePaths: ["src/"] };
    const instance = await createChangeApplyTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize: () => true });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  const runs = new RunStore({ dataRoot: options.dataRoot, repoId: options.repoId, daemonStartedAt: new Date().toISOString() });
  async function workerRun() {
    const run = await runs.create({ kind: "role", role: "one-company.worker", requirement: created.requirementId, parentRunId: lease.runId, task: "实现", cwd: worktree.root,
      writePaths: ["src/"], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    await runs.update(run.id, { state: "running" });
    return run.id;
  }
  const read = (path: string) => readFile(join(worktree.root, path), "utf8");
  const write = (path: string, content: string) => writeFile(join(worktree.root, path), content);
  const open = () => rounds.openRound({ lease: structuredClone(lease) });
  return { ...options, root, state, created, lease, workspace, worktree, database, rounds, grant, tool, changeApply, runs, workerRun, read, write, open, approve };
}
const base = sha("export const a = 1;\n");

test("M6-AC12/AC13：本轮 worker、未完成写入或写占用未收尾不能进入检查；检查阶段拒绝受管理写入与新 debug，命令只能写输出目录，进程未结束不释放", async () => {
  const w = await world();
  const workerId = await w.workerRun();
  await expect(w.open()).rejects.toMatchObject({ code: "workers_active" });
  await w.runs.update(workerId, { state: "completed" });
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => { if (path.endsWith("b.ts")) throw new Error("模拟磁盘故障"); return original(path, content); });
  const applier = await w.changeApply();
  const partial = uuidv7();
  expect(((await applier.execute({ action: "apply", operationId: partial, files: [{ path: "src/b.ts", baseHash: "absent", content: "b\n" }] })) as { status: string }).status).toBe("partial_failure");
  vi.restoreAllMocks();
  await expect(w.open()).rejects.toMatchObject({ code: "writes_pending" });
  expect(((await applier.execute({ action: "apply", operationId: partial, files: [{ path: "src/b.ts", baseHash: "absent", content: "b\n" }] })) as { status: string }).status).toBe("applied");
  const owner = { ownerToken: uuidv7(), pid: process.pid };
  withDatabase(w.database, (db) => db.transaction(() => { claimRequirementWriteIn(db, { ...owner, repoId: w.repoId, requirementId: w.created.requirementId, operationId: uuidv7(), acquiredAt: 1 }, { allowDeadOriginalOperationRecovery: false }); }));
  await expect(w.open()).rejects.toMatchObject({ code: "requirement_write_busy" });
  withDatabase(w.database, (db) => db.transaction(() => { const claim = db.read<{ operationId: string }>("requirement_service_write_coordination", w.created.requirementId)!; releaseRequirementWriteIn(db, w.repoId, w.created.requirementId, claim.data.operationId, owner); }));
  await expect(w.rounds.openRound({ lease: { ...w.lease, fence: w.lease.fence + 1 } })).rejects.toMatchObject({ code: "stale_pm_lease" });
  const round = await w.open();
  expect(round.status).toBe("open");
  expect(round.baseline.inputCount).toBeGreaterThan(0);
  await expect(w.open()).rejects.toMatchObject({ code: "check_round_active" });

  await expect(applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "check_phase_active" });
  await expect(w.read("src/c.ts")).rejects.toMatchObject({ code: "ENOENT" });
  const worker = await w.tool(w.grant({ role: "worker" }));
  await expect(worker.execute({ action: "run", kind: "debug", command: "true", performance: NA })).rejects.toMatchObject({ code: "check_phase_active" });
  await expect(worker.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "kind_forbidden" });
  const qa = await w.tool();
  await expect(qa.execute({ action: "run", kind: "debug", command: "true", performance: NA })).rejects.toMatchObject({ code: "kind_forbidden" });
  if (!darwin) return;
  const escaping = await qa.execute({ action: "run", kind: "formal", command: "echo hacked > src/a.ts; echo also >> docs/spec/player/move.rules.json", performance: NA }) as VerificationView;
  expect(escaping.status).toBe("failed");
  await expect(w.read("src/a.ts")).resolves.toBe("export const a = 1;\n");
  await expect(w.read("docs/spec/player/move.rules.json")).resolves.toBe(MOVE);
  const outputs = await qa.execute({ action: "run", kind: "formal", command: "printf hi > \"$TMPDIR/../outputs/ok.txt\" && cat \"$TMPDIR/../outputs/ok.txt\"", performance: NA }) as VerificationView;
  expect(outputs.status).toBe("passed");
  await expect(readFile(join(outputs.outputRoot, "outputs", "ok.txt"), "utf8")).resolves.toBe("hi");
  await expect(readFile(join(outputs.outputRoot, "outputs", "stdout.log"), "utf8")).resolves.toBe("hi");
  const forged = join(w.dataRoot, "repos", w.repoId, "forged.txt");
  const denied = await qa.execute({ action: "run", kind: "formal", command: `cat ${JSON.stringify(join(w.dataRoot, "repos", w.repoId, "data.db"))} > /dev/null && echo x > ${JSON.stringify(forged)}`, performance: NA }) as VerificationView;
  expect(denied.status).toBe("failed");
  await expect(readFile(join(denied.outputRoot, "outputs", "stderr.log"), "utf8")).resolves.toContain("forged.txt");
  await expect(readFile(forged, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const slow = qa.execute({ action: "run", kind: "formal", command: "sleep 5", performance: NA }) as Promise<VerificationView>;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = w.rounds.status(round.checkRoundId);
  expect(status.active).toHaveLength(1);
  expect(() => w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId })).toThrow(/verification_active/);
  expect(w.rounds.requestStop({ lease: w.lease, checkRoundId: round.checkRoundId }).status).toBe("stopping");
  expect(() => w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId })).toThrow(/verification_active/);
  await expect(qa.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "round_not_open" });
  await expect(applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "check_phase_active" });
  const stopped = await qa.execute({ action: "stop", verificationId: status.active[0]! }) as VerificationView;
  expect(stopped.status).toBe("cancelled");
  expect((await slow).status).toBe("cancelled");
  await expect(stat(join(stopped.outputRoot, "outputs"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(stopped.outputRoot, "manifest.json"))).resolves.toBeTruthy();
  expect(w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId }).status).toBe("released");
  expect(((await applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })) as { status: string }).status).toBe("applied");
  const debug = await worker.execute({ action: "run", kind: "debug", command: "true", performance: NA }) as VerificationView;
  expect(debug.status).toBe("passed"); expect(debug.checkRoundId).toBeNull();
});

test("M6-AC1/AC20：记录真实退出码、超时、取消，性能条件在运行前固定；自填结果字段、改标签或 hash 都不能把 debug 升级为正式证据", async () => {
  const w = await world();
  for (const extra of [{ status: "passed" }, { verdict: "PASS" }, { checkRoundId: uuidv7() }, { baseline: {} }, { exitCode: 0 }]) {
    await expect((await w.tool()).execute({ action: "run", kind: "formal", command: "true", ...extra })).rejects.toMatchObject({ code: "invalid_shape" });
  }
  await expect((await w.tool()).execute({ action: "run", kind: "formal", command: "true" })).rejects.toMatchObject({ code: "invalid_shape" });
  await expect((await w.tool()).execute({ action: "run", kind: "formal", command: "true", performance: { applicable: true } })).rejects.toMatchObject({ code: "invalid_shape" });
  for (const role of ["main", "explore", "planner"]) await expect(w.tool(w.grant({ role } as never))).rejects.toMatchObject({ code: "grant_invalid" });
  await expect(w.tool(w.grant(), () => false)).rejects.toMatchObject({ code: "session_inactive" });
  await expect(w.tool(w.grant({ epoch: 9 }))).resolves.toBeTruthy();
  await expect((await w.tool(w.grant({ epoch: 9 }))).execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求已换代（epoch 变化）" } });
  if (!darwin) return;
  const worker = await w.tool(w.grant({ role: "worker" }));
  const passed = await worker.execute({ action: "run", kind: "debug", command: "exit 0", performance: { applicable: true, thresholds: "p95 < 500ms，1000 文件，热态" } }) as VerificationView;
  const failed = await worker.execute({ action: "run", kind: "debug", command: "exit 3", performance: NA }) as VerificationView;
  const timeout = await worker.execute({ action: "run", kind: "debug", command: "sleep 30", timeoutMs: 1000, performance: NA }) as VerificationView;
  expect([passed.status, passed.exitCode]).toEqual(["passed", 0]);
  expect([failed.status, failed.exitCode]).toEqual(["failed", 3]);
  expect([timeout.status, timeout.signal]).toEqual(["timeout", "SIGKILL"]);
  expect(passed.performance).toEqual({ applicable: true, thresholds: "p95 < 500ms，1000 文件，热态" });
  const other = await w.tool(w.grant({ role: "worker" }));
  await expect(other.execute({ action: "status", verificationId: passed.verificationId })).rejects.toMatchObject({ code: "not_found" });
  await expect(other.execute({ action: "stop", verificationId: passed.verificationId })).rejects.toMatchObject({ code: "not_found" });
  const evidence = await formalEvidence(w, passed.verificationId);
  expect(evidence).toMatchObject({ kind: "debug", status: "passed", applicable: false, reasons: ["debug_result"] });
  const round = await w.open();
  withDatabase(w.database, (db) => db.transaction(() => {
    const run = db.read<Record<string, unknown>>(VERIFICATION_RUNS, passed.verificationId)!;
    db.update(VERIFICATION_RUNS, passed.verificationId, run.version, { ...run.data, kind: "formal", checkRoundId: round.checkRoundId });
  }));
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toContain("round_binding_invalid");
  withDatabase(w.database, (db) => db.transaction(() => {
    const run = db.read<Record<string, unknown>>(VERIFICATION_RUNS, passed.verificationId)!;
    db.update(VERIFICATION_RUNS, passed.verificationId, run.version, { ...run.data, baseline: round.baseline });
  }));
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toEqual(["round_binding_invalid", "round_not_released"]);
});

test("M6-AC2/AC14：证据适用性按实际内容重算；检查期间外部改动或观察到 A→B→A 使本轮失效；prod 变化后旧结果原样保留但不再适用", async () => {
  const w = await world();
  if (!darwin) return;
  const qa = await w.tool();
  const first = await w.open();
  const passed = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  expect(passed.status).toBe("passed");
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toEqual(["round_not_released"]);
  w.rounds.release({ lease: w.lease, checkRoundId: first.checkRoundId });
  expect(await formalEvidence(w, passed.verificationId)).toMatchObject({ status: "passed", applicable: true, reasons: [] });
  await w.write("src/a.ts", "export const a = 2;\n");
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toEqual(["input_changed"]);
  await w.write("src/a.ts", "export const a = 1;\n");
  expect((await formalEvidence(w, passed.verificationId))!.applicable).toBe(true);
  await w.write("docs/spec/player/move.rules.json", "{}\n");
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toEqual(["input_changed"]);
  await w.write("docs/spec/player/move.rules.json", MOVE);
  withDatabase(w.database, (db) => db.transaction(() => {
    const run = db.read<Record<string, unknown>>(VERIFICATION_RUNS, passed.verificationId)!;
    db.update(VERIFICATION_RUNS, passed.verificationId, run.version, { ...run.data, baseline: { ...(run.data.baseline as object), inputHash: sha("伪造") } });
  }));
  expect((await formalEvidence(w, passed.verificationId))!.reasons).toEqual(["round_binding_invalid", "input_changed"]);

  const second = await w.open();
  const running = qa.execute({ action: "run", kind: "formal", command: "sleep 1", performance: NA }) as Promise<VerificationView>;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await w.write("src/a.ts", "export const a = 3;\n");
  await w.write("src/a.ts", "export const a = 1;\n");
  expect(w.rounds.observeInputChange({ checkRoundId: second.checkRoundId, paths: ["src/a.ts"] }).invalidation?.reason).toBe("observed_change");
  const observed = await running;
  expect([observed.status, observed.exitCode, observed.invalidation?.reason]).toEqual(["invalidated", 0, "observed_change"]);
  await expect(qa.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "round_not_open" });
  const applier = await w.changeApply();
  await expect(applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "check_phase_active" });
  const releasedSecond = w.rounds.release({ lease: w.lease, checkRoundId: second.checkRoundId });
  expect([releasedSecond.status, releasedSecond.invalidation?.reason]).toEqual(["released", "observed_change"]);

  const third = await w.open();
  const changing = qa.execute({ action: "run", kind: "formal", command: "sleep 1", performance: NA }) as Promise<VerificationView>;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await w.write("src/new.ts", "export const n = 1;\n");
  const changed = await changing;
  expect([changed.status, changed.invalidation?.reason]).toEqual(["invalidated", "input_changed"]);
  expect(w.rounds.status(third.checkRoundId).invalidation?.reason).toBe("input_changed");
  await rm(join(w.worktree.root, "src", "new.ts"));
  await expect(qa.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "round_not_open" });
  w.rounds.release({ lease: w.lease, checkRoundId: third.checkRoundId });

  const fourth = await w.open();
  await w.write("src/a.ts", "export const a = 4;\n");
  await expect(qa.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "input_changed" });
  expect(w.rounds.status(fourth.checkRoundId).invalidation?.reason).toBe("input_changed");
  await w.write("src/a.ts", "export const a = 1;\n");
  w.rounds.release({ lease: w.lease, checkRoundId: fourth.checkRoundId });

  const fifth = await w.open();
  const good = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  w.rounds.release({ lease: w.lease, checkRoundId: fifth.checkRoundId });
  expect((await formalEvidence(w, good.verificationId))!.applicable).toBe(true);
  await w.approve(BODY_2);
  const after = await formalEvidence(w, good.verificationId);
  expect(after!.reasons).toEqual(["prod_changed"]);
  expect(after!.approvedProdHash).toBe(good.baseline.approved.hash);
  expect((await qa.execute({ action: "status", verificationId: good.verificationId }) as VerificationView).status).toBe("passed");
  await expect(w.open()).rejects.toMatchObject({ code: "pending_update" });
});

test("M6-AC16：检查中收到已批准更新只能由有效 PM 记录 interrupt/defer；interrupt 等进程结束才退出，defer 保持原基线继续并可提交原轮结果", async () => {
  const w = await world();
  if (!darwin) return;
  const qa = await w.tool();
  const round = await w.open();
  const before = w.state.read(w.created.requirementId).data;
  await w.approve(BODY_2);
  const after = w.state.read(w.created.requirementId).data;
  expect(after.pendingRevision).toBe(after.revision);
  expect(() => w.rounds.decide({ lease: { ...w.lease, fence: w.lease.fence + 1 }, checkRoundId: round.checkRoundId, kind: "defer", revision: after.revision })).toThrow(/stale_pm_lease/);
  expect(() => w.rounds.decide({ lease: w.lease, checkRoundId: round.checkRoundId, kind: "defer", revision: before.revision })).toThrow(/decision_conflict/);
  const deferred = w.rounds.decide({ lease: w.lease, checkRoundId: round.checkRoundId, kind: "defer", revision: after.revision });
  expect([deferred.status, deferred.decision?.kind]).toEqual(["open", "defer"]);
  expect(() => w.rounds.decide({ lease: w.lease, checkRoundId: round.checkRoundId, kind: "interrupt", revision: after.revision })).toThrow(/decision_conflict/);
  const original = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  expect(original.status).toBe("passed");
  expect(original.baseline.approved).toEqual(before.approved);
  expect(original.baseline.revision).toBe(before.revision);
  const evidence = await formalEvidence(w, original.verificationId);
  expect(evidence!.reasons).toEqual(["round_not_released", "prod_changed"]);
  const applier = await w.changeApply();
  await expect(applier.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/c.ts", baseHash: "absent", content: "c\n" }] })).rejects.toMatchObject({ code: "check_phase_active" });
  w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId });
  await expect(w.open()).rejects.toMatchObject({ code: "pending_update" });

  const interruptWorld = await world();
  const qa2 = await interruptWorld.tool();
  const round2 = await interruptWorld.open();
  const slow = qa2.execute({ action: "run", kind: "formal", command: "sleep 5", performance: NA }) as Promise<VerificationView>;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await interruptWorld.approve(BODY_2);
  const revision = interruptWorld.state.read(interruptWorld.created.requirementId).data.revision;
  const interrupted = interruptWorld.rounds.decide({ lease: interruptWorld.lease, checkRoundId: round2.checkRoundId, kind: "interrupt", revision });
  expect(interrupted.status).toBe("stopping");
  expect(() => interruptWorld.rounds.release({ lease: interruptWorld.lease, checkRoundId: round2.checkRoundId })).toThrow(/verification_active/);
  await qa2.execute({ action: "stop", verificationId: interruptWorld.rounds.status(round2.checkRoundId).active[0]! });
  expect((await slow).status).toBe("cancelled");
  const released = interruptWorld.rounds.release({ lease: interruptWorld.lease, checkRoundId: round2.checkRoundId });
  expect([released.status, released.invalidation?.reason]).toEqual(["released", "interrupted"]);
});

test("M6-AC14：崩溃后重新打开服务把无进程的运行中验证标为中断并释放阶段占用", async () => {
  const w = await world();
  if (!darwin) return;
  const qa = await w.tool();
  const round = await w.open();
  const passed = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  withDatabase(w.database, (db) => db.transaction(() => {
    const run = db.read<Record<string, unknown>>(VERIFICATION_RUNS, passed.verificationId)!;
    db.update(VERIFICATION_RUNS, passed.verificationId, run.version, { ...run.data, status: "running", pid: 2_000_000_000, finishedAt: null });
    const stored = db.read<Record<string, unknown>>(CHECK_ROUNDS, round.checkRoundId)!;
    db.update(CHECK_ROUNDS, round.checkRoundId, stored.version, { ...stored.data, active: [passed.verificationId] });
  }));
  expect(() => w.rounds.release({ lease: w.lease, checkRoundId: round.checkRoundId })).toThrow(/verification_active/);
  const reopened = await CheckRoundService.open({ repositoryRoot: w.repositoryRoot, dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true });
  cleanups.push(async () => reopened.dispose());
  expect(reopened.status(round.checkRoundId).active).toEqual([]);
  expect((await qa.execute({ action: "status", verificationId: passed.verificationId }) as VerificationView).status).toBe("interrupted");
  reopened.release({ lease: w.lease, checkRoundId: round.checkRoundId });
});

test("M6-AC9：epoch 递增后遗留的检查轮不再占用检查阶段", async () => {
  const w = await world();
  const round = await w.open();
  expect(withDatabase(w.database, (db) => activeCheckRoundIn(db, w.repoId, w.created.requirementId))?.data.checkRoundId).toBe(round.checkRoundId);
  w.state.blockForRecovery({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version, reason: "history_unknown" });
  expect(withDatabase(w.database, (db) => activeCheckRoundIn(db, w.repoId, w.created.requirementId))).toBeNull();
});

test("M6-AC1：数据库直写不能为其他调用者创建验证记录；LocalDatabase 事务失败时不留半条记录", async () => {
  const w = await world();
  if (!darwin) return;
  const qa = await w.tool();
  const round = await w.open();
  const create = LocalDatabase.prototype.create;
  vi.spyOn(LocalDatabase.prototype, "create").mockImplementation(function (this: LocalDatabase, ...args) {
    if (args[0] === VERIFICATION_RUNS) throw new Error("模拟日志提交失败");
    return create.apply(this, args);
  });
  await expect(qa.execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toThrow("模拟日志提交失败");
  vi.restoreAllMocks();
  expect(withDatabase(w.database, (db) => db.list(VERIFICATION_RUNS))).toHaveLength(0);
  expect(w.rounds.status(round.checkRoundId).active).toEqual([]);
  await expect(readFile(join(w.dataRoot, "repos", w.repoId, "verification"))).rejects.toBeTruthy();
  const stored = withDatabase(w.database, (db) => db.list(CHECK_ROUNDS));
  expect(stored).toHaveLength(1);
  expect((stored[0]!.data as { verifications: string[] }).verifications).toEqual([]);
});

test("结束后的结果带回 stdout、stderr 末尾并标明截断；日志被换成链接时不跟随读取", async () => {
  if (!darwin) return;
  const w = await world();
  const worker = await w.tool(w.grant({ role: "worker" }));
  const short = await worker.execute({ action: "run", kind: "debug", command: "echo 地面快跑 ok; echo warn >&2", performance: NA }) as VerificationView;
  expect(short.output).toEqual({ stdout: { text: "地面快跑 ok\n", truncated: false }, stderr: { text: "warn\n", truncated: false } });
  const long = await worker.execute({ action: "run", kind: "debug", command: "for i in $(seq 1 3000); do echo line-$i; done", performance: NA }) as VerificationView;
  expect(long.output!.stdout.truncated).toBe(true);
  expect(Buffer.byteLength(long.output!.stdout.text)).toBeLessThanOrEqual(8192);
  expect(long.output!.stdout.text.endsWith("line-3000\n")).toBe(true);
  const secret = join(w.dataRoot, "secret.txt");
  await writeFile(secret, "SECRET-VALUE\n");
  await rm(join(short.outputRoot, "outputs", "stdout.log"));
  await symlink(secret, join(short.outputRoot, "outputs", "stdout.log"));
  const linked = await worker.execute({ action: "status", verificationId: short.verificationId }) as VerificationView;
  expect(linked.output!.stdout).toEqual({ text: "", truncated: false });
});

test("M8A-AC10：reviewer 只读查看被审任务各次 worker 尝试在提交里引用的验证记录（含先红后绿与返修），查不到未引用的、别的任务的，也不能停止它们", async () => {
  if (!darwin) return;
  const w = await world();
  const workerGrant = w.grant({ role: "worker" });
  const worker = await w.tool(workerGrant);
  const red = await worker.execute({ action: "run", kind: "debug", command: "echo 'sprint.acceptance 失败'; exit 1", performance: NA }) as VerificationView;
  const green = await worker.execute({ action: "run", kind: "debug", command: "echo 'sprint.acceptance 通过'", performance: NA }) as VerificationView;
  const uncited = await worker.execute({ action: "run", kind: "debug", command: "echo 其他", performance: NA }) as VerificationView;
  submitVerdict({ dataRoot: w.dataRoot, requirementId: w.created.requirementId, repoId: w.repoId, workspaceId: w.workspace.workspaceId, epoch: workerGrant.epoch },
    { role: "worker", runId: workerGrant.runId, parentRunId: w.lease.runId },
    { checkRoundId: null, verificationIds: [red.verificationId, green.verificationId], summary: "先红后绿", findings: [] });
  const reworkGrant = w.grant({ role: "worker" });
  const reworkGreen = await (await w.tool(reworkGrant)).execute({ action: "run", kind: "debug", command: "echo '返修后通过'", performance: NA }) as VerificationView;
  submitVerdict({ dataRoot: w.dataRoot, requirementId: w.created.requirementId, repoId: w.repoId, workspaceId: w.workspace.workspaceId, epoch: reworkGrant.epoch },
    { role: "worker", runId: reworkGrant.runId, parentRunId: w.lease.runId },
    { checkRoundId: null, verificationIds: [reworkGreen.verificationId], summary: "只改注释", findings: [] });
  const reviewer = await w.tool(w.grant({ role: "reviewer" }), undefined, [workerGrant.runId, reworkGrant.runId]);
  expect(await reviewer.execute({ action: "status", verificationId: reworkGreen.verificationId })).toMatchObject({ status: "passed" });
  expect(await reviewer.execute({ action: "status", verificationId: red.verificationId })).toMatchObject({ status: "failed", output: { stdout: { text: "sprint.acceptance 失败\n" } } });
  expect(await reviewer.execute({ action: "status", verificationId: green.verificationId })).toMatchObject({ status: "passed" });
  await expect(reviewer.execute({ action: "status", verificationId: uncited.verificationId })).rejects.toMatchObject({ code: "not_found" });
  await expect(reviewer.execute({ action: "stop", verificationId: red.verificationId })).rejects.toMatchObject({ code: "not_found" });
  const otherTask = await w.tool(w.grant({ role: "reviewer" }), undefined, [uuidv7()]);
  await expect(otherTask.execute({ action: "status", verificationId: red.verificationId })).rejects.toMatchObject({ code: "not_found" });
  const qa = await w.tool(w.grant({ role: "qa" }), undefined, [workerGrant.runId]);
  await expect(qa.execute({ action: "status", verificationId: red.verificationId })).rejects.toMatchObject({ code: "not_found" });
  await w.write("src/a.ts", "export const a = 2;\n");
  const diff = await reviewer.execute({ action: "run", kind: "debug", command: "git --no-optional-locks diff HEAD -- src/", performance: NA }) as VerificationView;
  expect(diff).toMatchObject({ status: "passed" });
  expect(diff.output!.stdout.text).toContain("+export const a = 2;");
});

test("debug 命令可写工作区（含 docs/spec 这类普通文件）、继承完整环境变量；数据目录、Git 元数据、归档与角色定义不可写", async () => {
  if (!darwin) return;
  const w = await world();
  const worker = await w.tool(w.grant({ role: "worker" }));
  process.env.ONE_COMPANY_VERIFY_MARK = "inherited";
  const writes = await worker.execute({ action: "run", kind: "debug", command: 'test "$ONE_COMPANY_VERIFY_MARK" = inherited && echo gen > src/generated.txt', performance: NA }) as VerificationView;
  delete process.env.ONE_COMPANY_VERIFY_MARK;
  // 运行中改了受保护输入，本次运行按既有规则标失效；写入本身未被拦
  expect(writes.status).toBe("invalidated");
  await expect(w.read("src/generated.txt")).resolves.toBe("gen\n");
  await worker.execute({ action: "run", kind: "debug", command: "mkdir -p docs/spec && echo x > docs/spec/x.rules.json", performance: NA });
  await expect(w.read("docs/spec/x.rules.json")).resolves.toBe("x\n");
  for (const target of ["docs/prod/x.md", ".pi/agents/worker.md", ".pi/skills/requirement-doc/SKILL.md", "AGENTS.md"]) {
    const run = await worker.execute({ action: "run", kind: "debug", command: `mkdir -p ${JSON.stringify(join(target, ".."))} && echo x > ${JSON.stringify(target)}`, performance: NA }) as VerificationView;
    expect(run.status).toBe("failed");
    await expect(w.read(target)).rejects.toMatchObject({ code: "ENOENT" });
  }
  const agentDir = join(w.dataRoot, "..");
  for (const target of [join(agentDir, "agents", "pm.md"), join(agentDir, "skills", "x", "SKILL.md"), join(agentDir, "trust.json"), join(w.repositoryRoot, ".pi", "agents", "pm.md"),
    join(w.repositoryRoot, ".pi", "skills", "requirement-doc", "SKILL.md")]) {
    const run = await worker.execute({ action: "run", kind: "debug", command: `mkdir -p ${JSON.stringify(join(target, ".."))}; echo x > ${JSON.stringify(target)}`, performance: NA }) as VerificationView;
    expect(run.status).toBe("failed");
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }
  const linkedTarget = join(w.dataRoot, "..", "dotfiles-skills");
  await mkdir(linkedTarget, { recursive: true });
  await symlink(linkedTarget, join(agentDir, "skills"));
  const viaLink = await worker.execute({ action: "run", kind: "debug", command: `mkdir -p ${JSON.stringify(join(agentDir, "skills", "y"))} && echo x > ${JSON.stringify(join(agentDir, "skills", "y", "SKILL.md"))}`, performance: NA }) as VerificationView;
  expect(viaLink.status).toBe("failed");
  await expect(readFile(join(linkedTarget, "y", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const dotfiles = join(w.dataRoot, "..", "dotfiles-pi");
  await mkdir(dotfiles, { recursive: true });
  await symlink(dotfiles, join(w.repositoryRoot, ".pi"));
  const viaParent = await worker.execute({ action: "run", kind: "debug", command: `mkdir -p ${JSON.stringify(join(w.repositoryRoot, ".pi", "agents"))} && echo x > ${JSON.stringify(join(w.repositoryRoot, ".pi", "agents", "pm.md"))}`, performance: NA }) as VerificationView;
  expect(viaParent.status).toBe("failed");
  await expect(readFile(join(dotfiles, "agents", "pm.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const packageFile = join(defaultRoleDir(), "..", "agents", "pm.md");
  const packageBefore = await readFile(packageFile, "utf8");
  const tampered = await worker.execute({ action: "run", kind: "debug", command: `echo x >> ${JSON.stringify(packageFile)}`, performance: NA }) as VerificationView;
  expect(tampered.status).toBe("failed");
  expect(await readFile(packageFile, "utf8")).toBe(packageBefore);
  const hook = join((await repositoryIdentity(w.repositoryRoot)).commonDir, "hooks", "pre-commit");
  const git = await worker.execute({ action: "run", kind: "debug", command: `echo x > "$(git rev-parse --git-common-dir)/hooks/pre-commit"`, performance: NA }) as VerificationView;
  expect(git.status).toBe("failed");
  await expect(readFile(hook, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const forged = join(w.dataRoot, "forged.txt");
  const denied = await worker.execute({ action: "run", kind: "debug", command: `echo x > ${JSON.stringify(forged)}`, performance: NA }) as VerificationView;
  expect(denied.status).toBe("failed");
  await expect(readFile(forged, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const renamed = `${w.dataRoot}-moved`;
  const bypass = await worker.execute({ action: "run", kind: "debug",
    command: `mv ${JSON.stringify(w.dataRoot)} ${JSON.stringify(renamed)} && echo x > ${JSON.stringify(join(renamed, "forged.txt"))}; mv ${JSON.stringify(renamed)} ${JSON.stringify(w.dataRoot)}`, performance: NA }) as VerificationView;
  expect(bypass.status).toBe("failed");
  await expect(readFile(forged, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("没有隔离后端的平台在启动前明确拒绝", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(() => writeGuardLaunch("touch forbidden", { deniedWrites: [], allowedWrites: [], deniedSockets: [], scratch: "/unused" })).toThrow("隔离后端");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
