import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../runtime/requirement-service.ts";
import { createSpecChangeTool } from "../runtime/spec-change.ts";
import type { SpecChangeGrant, SpecChangeToolOptions, SpecPublishGate } from "../runtime/spec-change.ts";
import { checkSpecSet } from "../runtime/spec-format.ts";
import type { SpecRule } from "../runtime/spec-format.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function rule(id: string, expected = "角色按输入方向移动"): SpecRule {
  return { id, title: "移动", condition: "角色在地面", trigger: "收到方向输入", expected, reason: "基础移动", dependsOn: [], exceptions: [],
    acceptance: [{ id: "move", given: "地面", when: "按方向", then: expected }] };
}
function document(featureId: string, rules: SpecRule[]) {
  return JSON.stringify({ $schema: "../schema.json", schemaVersion: 1, feature: { id: featureId, title: "玩家", aliases: [] }, rules }, null, 2) + "\n";
}
const MOVE = document("player", [rule("player.move")]);
const SPRINT = document("player.sprint", [rule("player.sprint", "角色进入快跑")]);

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "spec-change-"));
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
  /** 同一仓库里再建一个已批准需求：独立 worktree、租约与规则发布工具。 */
  async function requirement(seed = "export const a = 1;\n") {
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
  await writeFile(join(worktree.root, "src", "a.ts"), seed);
  await runGit(["add", "."], worktree.root); await runGit(["commit", "-qm", "seed"], worktree.root);
  const head = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: state.read(created.requirementId).version, runId: uuidv7(), expectedFence: 0 });
  const record = state.read(created.requirementId).data;
  const workspace = record.workspace!;
  const permits = new Map<string, string>();
  function grant(extra: Partial<SpecChangeGrant> = {}): SpecChangeGrant {
    return { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease), ...extra };
  }
  const host: SpecChangeToolOptions["authorize"] = (request) => permits.get(request.grant.callerId) === JSON.stringify(request.grant);
  let gate: SpecPublishGate = { checkPhaseReleased: false, evidence: null };
  async function tool(bound = grant(), authorize = host) {
    permits.set(bound.callerId, JSON.stringify(bound));
    const instance = await createSpecChangeTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize, publishGate: () => gate });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  const read = (path: string) => readFile(join(worktree.root, path), "utf8");
  const target = () => checkSpecSet([{ path: "docs/spec/player/move.rules.json", content: MOVE }, { path: "docs/spec/player/sprint.rules.json", content: SPRINT }]).contractSetHash;
  const evidence = (extra: Partial<SpecPublishGate["evidence"] & object> = {}) => ({ verificationId: uuidv7(), status: "passed" as const,
    targetSpecSetHash: target(), approvedProdHash: state.read(created.requirementId).data.approved!.hash, codeHead: head, ...extra });
  return { created, lease, workspace, worktree, head, grant, tool, read, approve, target, evidence, setGate: (next: SpecPublishGate) => { gate = next; } };
  }
  return { ...options, root, state, ...await requirement(), requirement };
}
const denied = { code: "spec_change_denied" };
const sprintFile = { path: "docs/spec/player/sprint.rules.json", baseHash: "absent", content: SPRINT };
type Summary = { status: string; targetSpecSetHash: string; baseContractSetHash: string; analysisHash: string | null; publishedHead: string | null;
  files: Array<{ path: string; status: string }> };

test("M5-AC3：spec_change 只能写 docs/spec 规则文件，PM 以外职责、伪造证据字段与越界路径一律拒绝", async () => {
  const w = await world(); const tool = await w.tool();
  for (const path of ["src/a.ts", "docs/spec/schema.json", "docs/spec/notes.md", "docs/prod/x.md", ".git/config", "../x.rules.json"]) {
    await expect(tool.execute({ action: "propose", operationId: uuidv7(), files: [{ path, baseHash: "absent", content: "{}" }] })).rejects.toMatchObject({ code: "forbidden_path" });
  }
  for (const extra of [{ evidence: { status: "passed" } }, { checkPhaseReleased: true }, { role: "pm" }, { derivedFromCode: "src/a.ts" }]) {
    await expect(tool.execute({ action: "publish", operationId: uuidv7(), ...extra })).rejects.toMatchObject({ code: "invalid_shape" });
  }
  for (const role of ["main", "worker", "explore", "reviewer", "qa", "planner"]) {
    await expect(w.tool({ ...w.grant(), role } as never)).rejects.toMatchObject(denied);
  }
  await expect(w.tool(w.grant(), () => false)).rejects.toMatchObject(denied);
  await expect(w.read("src/a.ts")).resolves.toBe("export const a = 1;\n");
});

test("M5-AC4：候选先经格式与拆分门槛，发布依次核对验证态、检查阶段、证据绑定的候选 hash/批准 prod/实际实现", async () => {
  const w = await world(); const tool = await w.tool();
  const oversized = document("player.big", [rule("player.big", "超".repeat(1_500))]);
  await expect(tool.execute({ action: "propose", operationId: uuidv7(), files: [{ path: "docs/spec/player/big.rules.json", baseHash: "absent", content: oversized }] }))
    .rejects.toMatchObject({ code: "invalid_spec", message: expect.stringContaining("split_required") });
  await expect(tool.execute({ action: "propose", operationId: uuidv7(), files: [{ path: "docs/spec/player/move.rules.json", baseHash: sha("旧"), content: MOVE }] }))
    .rejects.toMatchObject({ code: "stale_base" });
  const operationId = uuidv7();
  const proposed = await tool.execute({ action: "propose", operationId, files: [sprintFile] }) as Summary;
  expect(proposed.status).toBe("proposed");
  expect(proposed.targetSpecSetHash).toBe(w.target());
  expect(proposed.baseContractSetHash).toBe(checkSpecSet([{ path: "docs/spec/player/move.rules.json", content: MOVE }]).contractSetHash);
  await expect(tool.execute({ action: "propose", operationId, files: [sprintFile] })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(tool.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "validation_required" });
  const validated = await tool.execute({ action: "validate", operationId }) as Summary & { blockers: unknown[] };
  expect(validated.status).toBe("validated");
  expect(validated.analysisHash).toMatch(/^[0-9a-f]{64}$/);
  expect(validated.blockers.length).toBeGreaterThan(0);
  await expect(tool.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "check_phase_active" });
  w.setGate({ checkPhaseReleased: true, evidence: null });
  await expect(tool.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "evidence_required" });
  for (const wrong of [{ status: "failed" as const }, { targetSpecSetHash: "a".repeat(64) }, { approvedProdHash: "b".repeat(64) }, { codeHead: "c".repeat(40) }]) {
    w.setGate({ checkPhaseReleased: true, evidence: w.evidence(wrong) });
    await expect(tool.execute({ action: "publish", operationId })).rejects.toMatchObject({ code: "evidence_required" });
  }
  await expect(w.read("docs/spec/player/sprint.rules.json")).rejects.toMatchObject({ code: "ENOENT" });
  w.setGate({ checkPhaseReleased: true, evidence: w.evidence() });
  const published = await tool.execute({ action: "publish", operationId }) as Summary;
  expect(published.status).toBe("published");
  expect(published.publishedHead).toBe(w.head);
  expect(published.files.map((file) => file.status)).toEqual(["written"]);
  await expect(w.read("docs/spec/player/sprint.rules.json")).resolves.toBe(SPRINT);
  const onDisk = checkSpecSet([{ path: "docs/spec/player/move.rules.json", content: await w.read("docs/spec/player/move.rules.json") },
    { path: "docs/spec/player/sprint.rules.json", content: await w.read("docs/spec/player/sprint.rules.json") }]);
  expect(onDisk.contractSetHash).toBe(published.targetSpecSetHash);
  expect(((await tool.execute({ action: "publish", operationId })) as Summary).status).toBe("published");
  expect(JSON.stringify(published)).not.toContain(w.dataRoot);
});

test("M5-AC4/AC2：验证后外部改动规则文件或批准 prod 变化，发布拒绝且不写", async () => {
  const w = await world(); const tool = await w.tool();
  const edited = uuidv7();
  await tool.execute({ action: "propose", operationId: edited, files: [sprintFile] });
  await tool.execute({ action: "validate", operationId: edited });
  await writeFile(join(w.worktree.root, "docs", "spec", "player", "move.rules.json"), document("player", [rule("player.move", "外部改写")]));
  w.setGate({ checkPhaseReleased: true, evidence: w.evidence() });
  await expect(tool.execute({ action: "publish", operationId: edited })).rejects.toMatchObject({ code: "stale_base" });
  await expect(w.read("docs/spec/player/sprint.rules.json")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(tool.execute({ action: "validate", operationId: edited })).rejects.toMatchObject({ code: "stale_base" });
  await writeFile(join(w.worktree.root, "docs", "spec", "player", "move.rules.json"), MOVE);

  const reapproved = uuidv7();
  await tool.execute({ action: "propose", operationId: reapproved, files: [sprintFile] });
  await tool.execute({ action: "validate", operationId: reapproved });
  await w.approve(`${BODY}# 追加 {#more}\n新增快跑。\n`);
  w.setGate({ checkPhaseReleased: true, evidence: w.evidence() });
  await expect(tool.execute({ action: "publish", operationId: reapproved })).rejects.toMatchObject({ code: "prod_changed" });
  await expect(w.read("docs/spec/player/sprint.rules.json")).rejects.toMatchObject({ code: "ENOENT" });
});

test("M5-AC7：旧 fence、旧 epoch、他人 run 与宿主撤权不能提案或发布", async () => {
  const w = await world();
  const good = [sprintFile];
  const staleEpoch = await w.tool(w.grant({ lease: { ...w.lease, epoch: w.lease.epoch + 1 } }));
  await expect(staleEpoch.execute({ action: "propose", operationId: uuidv7(), files: good })).rejects.toMatchObject(denied);
  const foreignRun = uuidv7();
  const otherRun = await w.tool(w.grant({ runId: foreignRun, lease: { ...w.lease, runId: foreignRun } }));
  await expect(otherRun.execute({ action: "propose", operationId: uuidv7(), files: good })).rejects.toMatchObject(denied);
  const current = await w.tool();
  const operationId = uuidv7();
  await current.execute({ action: "propose", operationId, files: good });
  w.state.releasePm(w.lease);
  await w.state.acquirePm({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version, runId: uuidv7(), expectedFence: w.state.pmOwner(w.created.requirementId)?.fence ?? 0 });
  await expect(current.execute({ action: "validate", operationId })).rejects.toMatchObject(denied);
  await expect(current.execute({ action: "publish", operationId })).rejects.toMatchObject(denied);
  await expect(w.read("docs/spec/player/sprint.rules.json")).rejects.toMatchObject({ code: "ENOENT" });
});

test("M8-AC9：两个 PM 在各自绑定的 worktree 为同一规则发布不同候选，互不覆盖，证据不能串用", async () => {
  const w = await world();
  const other = await w.requirement("export const a = 2;\n");
  expect(other.workspace.workspaceId).not.toBe(w.workspace.workspaceId);
  const mine = { path: "docs/spec/player/sprint.rules.json", baseHash: "absent", content: SPRINT };
  const theirs = { ...mine, content: document("player.sprint", [rule("player.sprint", "角色冲刺")]) };
  const [toolA, toolB] = [await w.tool(), await other.tool()];
  const [opA, opB] = [uuidv7(), uuidv7()];
  await toolA.execute({ action: "propose", operationId: opA, files: [mine] }); await toolA.execute({ action: "validate", operationId: opA });
  const proposedB = await toolB.execute({ action: "propose", operationId: opB, files: [theirs] }) as Summary; await toolB.execute({ action: "validate", operationId: opB });
  const evidenceB = other.evidence({ targetSpecSetHash: proposedB.targetSpecSetHash });
  w.setGate({ checkPhaseReleased: true, evidence: evidenceB });
  await expect(toolA.execute({ action: "publish", operationId: opA })).rejects.toMatchObject({ code: "evidence_required" });
  await expect(toolA.execute({ action: "publish", operationId: opB })).rejects.toMatchObject({ code: "not_found" });
  w.setGate({ checkPhaseReleased: true, evidence: w.evidence() });
  expect((await toolA.execute({ action: "publish", operationId: opA }) as Summary).status).toBe("published");
  other.setGate({ checkPhaseReleased: true, evidence: evidenceB });
  expect((await toolB.execute({ action: "publish", operationId: opB }) as Summary).status).toBe("published");
  await expect(w.read(mine.path)).resolves.toBe(SPRINT);
  await expect(other.read(mine.path)).resolves.toBe(theirs.content);
});
