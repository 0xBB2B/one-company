import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalDatabase, repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { claimRequirementWriteIn, releaseRequirementWriteIn } from "../runtime/requirement-coordination.ts";
import { RunStore } from "../runtime/run-store.ts";
import { createChangeApplyTool } from "../runtime/change-apply.ts";
import { createSpecChangeTool } from "../runtime/spec-change.ts";
import { CheckRoundService, createSpecPublishGate, formalEvidence, CHECK_ROUNDS, VERIFICATION_RUNS } from "../runtime/check-round.ts";
import type { CheckRoundServiceOptions } from "../runtime/check-round.ts";
import { createVerificationRunTool } from "../runtime/verification-run.ts";
import type { VerificationRunGrant, VerificationRunToolOptions, VerificationView } from "../runtime/verification-run.ts";
import { checkSpecSet } from "../runtime/spec-format.ts";
import type { SpecRule } from "../runtime/spec-format.ts";
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
function rule(id: string, expected = "角色按输入方向移动"): SpecRule {
  return { id, title: "移动", condition: "角色在地面", trigger: "收到方向输入", expected, reason: "基础移动", dependsOn: [], exceptions: [],
    acceptance: [{ id: "move", given: "地面", when: "按方向", then: expected }] };
}
function document(featureId: string, rules: SpecRule[]) {
  return JSON.stringify({ $schema: "../schema.json", schemaVersion: 1, feature: { id: featureId, title: "玩家", aliases: [] }, rules }, null, 2) + "\n";
}
const MOVE = document("player", [rule("player.move")]);
const SPRINT = document("player.sprint", [rule("player.sprint", "角色进入快跑")]);
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
  } });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "acquire-pm", "release-pm", "check-pm", "begin-close"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const created = await service.create(create);
  const worktree = await addWorktree(repo);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  async function approve(body: string) {
    const confirm = { requirementId: created.requirementId, operationId: uuidv7(), version: state.read(created.requirementId).version, title: "角色跳跃", body, receiptId: uuidv7() };
    grants.set(confirm.operationId, { action: "confirmUpdate", intent: requirementIntentHash({ title: confirm.title, body }), receiptId: confirm.receiptId });
    return service.confirmUpdate(confirm);
  }
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
  async function tool(bound = grant(), authorize = host) {
    permits.set(bound.callerId, JSON.stringify(bound));
    const instance = await createVerificationRunTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize });
    cleanups.push(() => instance.dispose()); return instance;
  }
  async function changeApply(runId = uuidv7()) {
    const bound = { role: "worker" as const, callerId: uuidv7(), runId, requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch, writePaths: ["src/"] };
    const instance = await createChangeApplyTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize: () => true });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  async function specChange() {
    const bound = { role: "pm" as const, callerId: uuidv7(), runId: lease.runId, requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease) };
    const instance = await createSpecChangeTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize: () => true,
      publishGate: createSpecPublishGate(options) });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  const runs = new RunStore({ dataRoot: options.dataRoot, repoId: options.repoId, daemonStartedAt: new Date().toISOString() });
  async function workerRun() {
    const run = await runs.create({ kind: "role", role: "pi-company.worker", requirement: created.requirementId, parentRunId: lease.runId, task: "实现", cwd: worktree.root,
      writePaths: ["src/"], readPaths: [], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    await runs.update(run.id, { state: "running" });
    return run.id;
  }
  const read = (path: string) => readFile(join(worktree.root, path), "utf8");
  const write = (path: string, content: string) => writeFile(join(worktree.root, path), content);
  const open = (extra: { targetSpecProposal?: string } = {}) => rounds.openRound({ lease: structuredClone(lease), ...extra });
  const target = () => checkSpecSet([{ path: "docs/spec/player/move.rules.json", content: MOVE }, { path: "docs/spec/player/sprint.rules.json", content: SPRINT }]).contractSetHash;
  return { ...options, root, state, created, lease, workspace, worktree, database, rounds, grant, tool, changeApply, specChange, runs, workerRun, read, write, open, approve, target };
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
  const denied = await qa.execute({ action: "run", kind: "formal", command: `ls ${JSON.stringify(join(w.dataRoot, "repos", w.repoId, "requirements"))} && cat ${JSON.stringify(join(w.dataRoot, "repos", w.repoId, "data.db"))} > /dev/null`, performance: NA }) as VerificationView;
  expect(denied.status).toBe("failed");

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
  for (const role of ["main", "explore", "planner"]) await expect(w.tool(w.grant({ role } as never))).rejects.toMatchObject({ code: "verification_denied" });
  await expect(w.tool(w.grant(), () => false)).rejects.toMatchObject({ code: "verification_denied" });
  await expect(w.tool(w.grant({ epoch: 9 }))).resolves.toBeTruthy();
  await expect((await w.tool(w.grant({ epoch: 9 }))).execute({ action: "run", kind: "formal", command: "true", performance: NA })).rejects.toMatchObject({ code: "verification_denied" });
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
  const gate = createSpecPublishGate(w);
  await expect(gate({ grant: { requirementId: w.created.requirementId, repoId: w.repoId }, proposal: { targetSpecSetHash: w.target(), approvedProdHash: w.state.read(w.created.requirementId).data.approved!.hash } }))
    .resolves.toEqual({ checkPhaseReleased: false, evidence: null });
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
  await w.write("docs/spec/player/move.rules.json", document("player", [rule("player.move", "改了")]));
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

test("M6-AC14：崩溃后重新打开服务把无进程的运行中验证标为中断并释放阶段占用；spec 发布门槛只接受已释放轮次中仍适用的正式通过证据", async () => {
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

  const spec = await w.specChange();
  const operationId = uuidv7();
  await spec.execute({ action: "propose", operationId, files: [{ path: "docs/spec/player/sprint.rules.json", baseHash: "absent", content: SPRINT }] });
  await spec.execute({ action: "validate", operationId });
  await expect(spec.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "evidence_required" });
  await expect(w.open({ targetSpecProposal: uuidv7() })).rejects.toMatchObject({ code: "proposal_invalid" });
  const bound = await w.open({ targetSpecProposal: operationId });
  expect(bound.baseline.targetSpecSetHash).toBe(w.target());
  await expect(spec.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "check_phase_active" });
  const formal = await qa.execute({ action: "run", kind: "formal", command: "true", performance: NA }) as VerificationView;
  expect(formal.status).toBe("passed");
  w.rounds.release({ lease: w.lease, checkRoundId: bound.checkRoundId });
  const published = await spec.execute({ action: "publish", operationId }) as { status: string };
  expect(published.status).toBe("published");
  await expect(w.read("docs/spec/player/sprint.rules.json")).resolves.toBe(SPRINT);
  expect(await formalEvidence(w, formal.verificationId)).toMatchObject({ applicable: false, reasons: ["input_changed"] });
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
