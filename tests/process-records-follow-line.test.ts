import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { ShortDecisionStore } from "../src/modules/requirement/short-decisions.ts";
import { ApprovalManifestStore, registeredApprovalManifestIn } from "../src/modules/requirement/approval-manifest-store.ts";
import { manifestAuthorizesImplement, supplementImplementAction, approvalManifestReference } from "../src/modules/requirement/approval-manifest.ts";
import type { ApprovalManifest } from "../src/modules/requirement/approval-manifest.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import type { InteractionContext } from "../src/modules/requirement/user-interaction-format.ts";
import { loadInteractionContinuity } from "../src/modules/requirement/interaction-continuity.ts";
import { UserInteractionCore } from "../src/modules/interaction/user-interaction.ts";
import { adviceOf } from "../src/core/exec/tool-failure.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import type { ConfirmationContext } from "../src/modules/requirement/requirement-manage-contracts.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
type Lines = Record<string, string[]>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "line-records-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const { repoId } = await repositoryIdentity(repo.root);
  const config = { repositoryRoot: repo.root, dataRoot: join(root, "data"), repoId };
  const dbPath = repositoryDatabase(config.dataRoot, repoId);
  const open = (lines?: Lines) => RequirementService.open({ ...config, authorize: () => true, authorizeManifest: () => true, ...(lines ? { lines } : {}) });

  const created = await (await open()).create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: "正文 v2" });
  const requirementId = created.requirementId;
  const receipts = [created];
  for (let i = 1; i < 9; i++) {
    const service = await open({ [requirementId]: receipts.map((r) => r.anchor) });
    const previous = receipts.at(-1)!;
    receipts.push(await service.updateDraft({ requirementId, operationId: uuidv7(), version: previous.version, title: "需求标题", body: `正文 v${previous.version + 1}` }));
  }
  const worktree = await addWorktree(repo);
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  const stateStore = await RequirementStateStore.open({ ...config, authorize: () => true });
  await stateStore.bindWorkspace({ requirementId, version: stateStore.read(requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const lineA: Lines = { [requirementId]: receipts.map((r) => r.anchor) };
  const lineB: Lines = { [requirementId]: receipts.slice(0, 4).map((r) => r.anchor) };
  const tipA = receipts[8]!, tipB = receipts[3]!;
  expect([tipA.version, tipB.version]).toEqual([10, 5]);

  const context = (lines: Lines, tip: { operationId: string }) =>
    open(lines).then((service) => service.loadConfirmationContext({ requirementId, savedOperationId: tip.operationId, operationId: uuidv7() }));
  const basisReceiptId = uuidv7();
  const decisionStore = (lines: Lines) => ShortDecisionStore.open({ ...config, lines, authorize: () => true, now: () => 1_000_000,
    admit: ({ requestHash, batch }) => ({ requestHash, subjects: batch.decisions.map(() => ({ actor: "user" as const, status: "confirmed" as const, basisReceiptId })) }) });
  const manifestStore = (lines: Lines) => new ApprovalManifestStore({ ...config, lines, authorize: () => true,
    loadExpected: async () => { throw new Error("read does not load"); } });
  const decisionIds = () => withDatabase(dbPath, (db) => db.list("short_decisions")).map((row) => row.id);
  const appendDecision = async (lines: Lines, input: { version: number; epoch: number; prd: unknown; supersedes?: string[]; conclusion?: string }) => {
    const store = await decisionStore(lines);
    return store.append(JSON.stringify({ operationId: uuidv7(), requirementId, version: input.version, epoch: input.epoch, prd: input.prd,
      decisions: [{ conclusion: input.conclusion ?? "线上新做的决定", scope: "本轮只分析", references: [], supersedes: input.supersedes ?? [] }] }));
  };
  const continuity = (lines: Lines, ctx: ConfirmationContext) =>
    loadInteractionContinuity(config.dataRoot, repoId, ctx.basis, { candidate: ctx.candidate, title: ctx.title, body: ctx.body, partition: ctx.partition }, undefined, lines[requirementId]);

  // 线 A 保存到版本 10 之后：3 条短决定 + 连续性事实 + 批准清单，再提 1 个不回答的问题
  const confirmA = await manifestConfirmInput({ ...config, lines: lineA }, { requirementId, savedOperationId: tipA.operationId });
  const decisionsOfA = decisionIds();
  const ctxA = await context(lineA, tipA);
  const asker = await UserInteractionCore.open({ ...config, lines: lineA, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => { throw new Error("ask does not load"); }, interpreter: { identity: () => ({ provider: "fixture", id: "ask", configurationHash: "a".repeat(64) }), interpret: async () => "{}" } } as never);
  cleanups.push(async () => asker.shutdown());
  asker.startSession({ sessionId: "line-records", windowId: "line-records" });
  const question = asker.ask(JSON.stringify({ basis: ctxA.basis, candidate: ctxA.candidate, partition: ctxA.partition, unitIds: [ctxA.partition.units[0]!.id], actions: ["analyze"], proposal: { conclusion: "是否保留邮箱登录", scope: "整份需求", references: [], supersedes: [] } }));

  const state = () => RequirementStateStore.open({ ...config, authorize: () => true });
  const approveOnB = async (operationId = uuidv7()) => {
    const confirm = await manifestConfirmInput({ ...config, lines: lineB }, { requirementId, savedOperationId: tipB.operationId, operationId });
    return { confirm, receipt: await (await open(lineB)).confirmUpdate(confirm) };
  };
  return { config, dbPath, open, lineA, lineB, receipts, tipA, tipB, requirementId, context, decisionStore, manifestStore, decisionIds, appendDecision,
    continuity, confirmA, decisionsOfA, ctxA, question, state, approveOnB };
}
type World = Awaited<ReturnType<typeof world>>;

const canRead = async (read: () => unknown) => { try { await read(); return true; } catch { return false; } };

test("线 A 上能读到自己做的 3 条短决定和没回答的提问", async () => {
  const w = await world();
  expect(w.decisionsOfA).toHaveLength(3);
  const view = w.continuity(w.lineA, w.ctxA);
  const seen = view.priorDecisions.map((d) => d.decisionId);
  expect(seen).toHaveLength(1);
  expect(w.decisionsOfA).toContain(seen[0]);
  expect(view.questions.map((q) => q.requestId)).toEqual([w.question.requestId]);
  const store = await w.decisionStore(w.lineA);
  for (const id of w.decisionsOfA) expect(store.read(w.requirementId, id).requirementId).toBe(w.requirementId);
});

test("线 B（线 A 截到版本 5）上读不到线 A 的 3 条短决定和那个提问", async () => {
  const w = await world();
  const ctxB = await w.context(w.lineB, w.tipB);
  expect(ctxB.version).toBe(5);
  const view = w.continuity(w.lineB, ctxB);
  expect(view.priorDecisions.map((d) => d.decisionId)).toEqual([]);
  expect(view.questions).toEqual([]);
});

test("线 B 上按编号读线 A 的短决定被拒", async () => {
  const w = await world();
  const store = await w.decisionStore(w.lineB);
  for (const id of w.decisionsOfA) expect(await canRead(() => store.read(w.requirementId, id))).toBe(false);
});

test("线 B 上用线尖版本号 5 写短决定成功，用别的线的版本号 10 被拒", async () => {
  const w = await world();
  const ctxB = await w.context(w.lineB, w.tipB);
  await expect(w.appendDecision(w.lineB, { version: 10, epoch: ctxB.epoch, prd: ctxB.basis.prd })).rejects.toMatchObject({ name: "StaleVersionError" });
  const written = await w.appendDecision(w.lineB, { version: 5, epoch: ctxB.epoch, prd: ctxB.basis.prd });
  const store = await w.decisionStore(w.lineB);
  expect(store.read(w.requirementId, written.decisionIds[0]!).requirementVersion).toBe(5);
});

test("线 B 上新做的短决定在线 A 上读不到，在线 B 上读得到", async () => {
  const w = await world();
  const ctxB = await w.context(w.lineB, w.tipB);
  const written = await w.appendDecision(w.lineB, { version: 5, epoch: ctxB.epoch, prd: ctxB.basis.prd });
  const id = written.decisionIds[0]!;
  expect((await w.decisionStore(w.lineB)).read(w.requirementId, id).decisionId).toBe(id);
  expect(await canRead(async () => (await w.decisionStore(w.lineA)).read(w.requirementId, id))).toBe(false);
});

test("线 A 上取代只在线 B 上存在的短决定被拒，且那条决定保持原状", async () => {
  const w = await world();
  const ctxB = await w.context(w.lineB, w.tipB);
  const onlyB = (await w.appendDecision(w.lineB, { version: 5, epoch: ctxB.epoch, prd: ctxB.basis.prd })).decisionIds[0]!;
  const error = await w.appendDecision(w.lineA, { version: 10, epoch: w.ctxA.epoch, prd: w.ctxA.basis.prd, supersedes: [onlyB] }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "superseded_off_line" });
  expect(`${(error as Error).message}\n${adviceOf(error)?.why ?? ""}\n${adviceOf(error)?.next ?? ""}`).toContain("不在当前对话线上");
  expect((await w.decisionStore(w.lineB)).read(w.requirementId, onlyB)).toMatchObject({ status: "confirmed", supersededBy: null });
});

test("没挂锚点的旧决定在线 A、线 B 上都算数", async () => {
  const w = await world();
  const legacy = (await w.appendDecision(w.lineA, { version: 10, epoch: w.ctxA.epoch, prd: w.ctxA.basis.prd, conclusion: "旧决定" })).decisionIds[0]!;
  withDatabase(w.dbPath, (db) => {
    const member = db.read("line_anchor_members", `short_decisions:${legacy}`);
    if (member) db.remove("line_anchor_members", `short_decisions:${legacy}`, member.version);
  });
  for (const lines of [w.lineA, w.lineB]) expect((await w.decisionStore(lines)).read(w.requirementId, legacy).decisionId).toBe(legacy);
});

test("线 B 上批准：清单不引用线 A 的 3 条决定，approved 和 saved 都是线 B 那一版的提交", async () => {
  const w = await world();
  const ctxB = await w.context(w.lineB, w.tipB);
  const { confirm, receipt } = await w.approveOnB();
  const manifest = w.manifestStore(w.lineB).read(confirm.manifest);
  const referenced = [...manifest.units, ...manifest.actions, ...manifest.questions].flatMap((u) => u.decisionIds);
  expect(referenced.length).toBeGreaterThan(0);
  for (const id of w.decisionsOfA) expect(referenced).not.toContain(id);
  const row = (await w.state()).read(w.requirementId).data;
  expect(row.approved?.commit).toBe(ctxB.saved.commit);
  expect(row.saved?.commit).toBe(ctxB.saved.commit);
  expect(receipt.version).toBeDefined();
});

test("线 B 上批准时同一事务写一个 approval 锚点，父是批准那一刻线 B 上最后一个锚点（登记批准清单的锚点）", async () => {
  const w = await world();
  await w.approveOnB();
  const anchors = withDatabase(w.dbPath, (db) => db.list<{ requirementId: string; anchor: string; kind: string; parent: string | null }>("line_anchors")).map((row) => row.data);
  const approvals = anchors.filter((a) => a.requirementId === w.requirementId && a.kind === "approval");
  expect(approvals).toHaveLength(1);
  const parent = anchors.find((a) => a.anchor === approvals[0]!.parent);
  expect(parent?.kind).toBe("manifest");
  const ancestors: string[] = [];
  for (let cursor = parent; cursor; cursor = anchors.find((a) => a.anchor === cursor!.parent)) ancestors.push(cursor.anchor);
  expect(ancestors).toContain(w.tipB.anchor);
});

test("批准后在线 A 上读取：线 A 上那 3 条决定不算数，批准依据仍读得到", async () => {
  const w = await world();
  const { confirm } = await w.approveOnB();
  const store = await w.decisionStore(w.lineA);
  for (const id of w.decisionsOfA) expect(await canRead(() => store.read(w.requirementId, id))).toBe(false);
  expect(w.manifestStore(w.lineA).read(confirm.manifest).requirementId).toBe(w.requirementId);
});

test("批准后新做的短决定在线 A、线 B 上都算数", async () => {
  const w = await world();
  await w.approveOnB();
  const row = await (await w.state()).read(w.requirementId);
  const written = await w.appendDecision(w.lineA, { version: row.version, epoch: row.data.epoch, prd: row.data.approved });
  const id = written.decisionIds[0]!;
  for (const lines of [w.lineA, w.lineB]) expect((await w.decisionStore(lines)).read(w.requirementId, id).decisionId).toBe(id);
});

test("已批准需求批准后又在改的修订草稿不按对话线筛选：别的线上做的决定在线 B 上也读得到", async () => {
  const w = await world();
  await w.approveOnB();
  const service = await w.open(w.lineB);
  const revised = await service.updateDraft({ requirementId: w.requirementId, operationId: uuidv7(), version: (await service.metadata(w.requirementId)).version, title: "需求标题", body: "批准后的修订" });
  const row = (await w.state()).read(w.requirementId);
  const written = await w.appendDecision(w.lineA, { version: row.version, epoch: row.data.epoch, prd: row.data.approved });
  expect(revised.version).toBeGreaterThan(0);
  for (const lines of [w.lineA, w.lineB]) expect((await w.decisionStore(lines)).read(w.requirementId, written.decisionIds[0]!).decisionId).toBe(written.decisionIds[0]!);
});

test("篡改线 B 上一条算数的决定后批准，照旧报 manifest_decisions_changed 或 continuity_source_changed", async () => {
  const w = await world();
  const confirm = await manifestConfirmInput({ ...w.config, lines: w.lineB }, { requirementId: w.requirementId, savedOperationId: w.tipB.operationId });
  const own = w.decisionIds().filter((id) => !w.decisionsOfA.includes(id));
  expect(own.length).toBeGreaterThan(0);
  withDatabase(w.dbPath, (db) => {
    const stored = db.read<{ scope: string }>("short_decisions", own[0]!)!;
    db.update("short_decisions", own[0]!, stored.version, { ...stored.data, scope: "被篡改的范围" });
  });
  const approver = await w.open(w.lineB);
  await expect(approver.confirmUpdate(confirm)).rejects.toMatchObject({ code: expect.stringMatching(/^(manifest_decisions_changed|continuity_source_changed)$/) });
});

async function saveAgainOnB(w: World) {
  const saved = await (await w.open(w.lineB)).updateDraft({ requirementId: w.requirementId, operationId: uuidv7(), version: 5, title: "需求标题", body: "线 B 再保存" });
  const lineB2: Lines = { [w.requirementId]: [...w.lineB[w.requirementId]!, saved.anchor] };
  const rowVersion = (await w.state()).read(w.requirementId).version;
  expect(saved.version).toBe(6);
  expect(rowVersion).toBeGreaterThan(6);
  return { saved, lineB2 };
}

test("线 B 上照版本 5 再保存成版本 6 后，在线 B 上确认并批准成功，approved 是这次保存的提交", async () => {
  const w = await world();
  const { saved, lineB2 } = await saveAgainOnB(w);
  const ctx = await w.context(lineB2, saved);
  expect(ctx.version).toBe(6);
  const confirm = await manifestConfirmInput({ ...w.config, lines: lineB2 }, { requirementId: w.requirementId, savedOperationId: saved.operationId });
  await (await w.open(lineB2)).confirmUpdate(confirm);
  const row = (await w.state()).read(w.requirementId).data;
  expect(row.approved?.commit).toBe(ctx.saved.commit);
});

test("线 B 上再保存成版本 6 后先做一次短决定再批准，成功且不报 continuity_version_source", async () => {
  const w = await world();
  const { saved, lineB2 } = await saveAgainOnB(w);
  const ctx = await w.context(lineB2, saved);
  await w.appendDecision(lineB2, { version: 6, epoch: ctx.epoch, prd: ctx.basis.prd });
  const approved = async () => {
    const confirm = await manifestConfirmInput({ ...w.config, lines: lineB2 }, { requirementId: w.requirementId, savedOperationId: saved.operationId });
    return (await w.open(lineB2)).confirmUpdate(confirm);
  };
  const error = await approved().then(() => null, (caught: unknown) => caught);
  expect(error).not.toMatchObject({ code: "continuity_version_source" });
  expect(error).toBeNull();
  const row = (await w.state()).read(w.requirementId).data;
  expect(row.approved?.commit).toBe(ctx.saved.commit);
});

const sections = (b: string) => `# A {#A}\nA目标。\n# B {#B}\n${b}\n`;

async function approveAfterRewind(w: World) {
  const { saved, lineB2 } = await saveAgainOnB(w);
  const confirm = await manifestConfirmInput({ ...w.config, lines: lineB2 }, { requirementId: w.requirementId, savedOperationId: saved.operationId });
  await (await w.open(lineB2)).confirmUpdate(confirm);
  return { lineB2, confirm };
}

test("回退后保存、解读、批准，之后修订已批准需求并再次批准成功，不报 continuity_version_source", async () => {
  const w = await world();
  const { lineB2 } = await approveAfterRewind(w);
  const service = await w.open(lineB2);
  const revised = await service.updateDraft({ requirementId: w.requirementId, operationId: uuidv7(), version: (await service.metadata(w.requirementId)).version, title: "需求标题", body: "批准后的修订" });
  const error = await (async () => {
    const confirm = await manifestConfirmInput({ ...w.config, lines: lineB2 }, { requirementId: w.requirementId, savedOperationId: revised.operationId });
    return (await w.open(lineB2)).confirmUpdate(confirm);
  })().then(() => null, (caught: unknown) => caught);
  expect(error).not.toMatchObject({ code: "continuity_version_source" });
  expect(error).toBeNull();
  expect((await w.state()).read(w.requirementId).data.approved?.commit).toBe(revised.commit);
});

async function prepareRetainedSection(w: World) {
  const id = w.requirementId;
  const lines: Lines = { [id]: [...w.lineB[id]!] };
  let saved = await (await w.open(lines)).updateDraft({ requirementId: id, operationId: uuidv7(), version: 5, title: "需求标题", body: sections("B目标。") });
  lines[id]!.push(saved.anchor);
  let confirmOperationId = uuidv7();
  const load = async () => (await w.open(lines)).loadConfirmationContext({ requirementId: id, savedOperationId: saved.operationId, operationId: confirmOperationId });
  let loaded = await load();
  let retain = false;
  const core = await UserInteractionCore.open({ ...w.config, lines, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => {
      loaded = await load();
      const document = { candidate: loaded.candidate, title: loaded.title, body: loaded.body, partition: loaded.partition };
      const result: InteractionContext = { basis: loaded.basis, currentGoal: "", candidates: [{ ...loaded.candidate, diff: loaded.difference.text || "无差异" }],
        document, savedOperationId: loaded.savedOperationId, ...loadInteractionContinuity(w.config.dataRoot, w.config.repoId, loaded.basis, document, undefined, lines[id]) };
      return result;
    },
    interpreter: {
      identity: () => ({ provider: "fixture", id: "retain-section", configurationHash: "a".repeat(64) }),
      interpret: async ({ context: current }) => {
        const document = current.document!;
        const common = { basis: "explicit", resolution: "direct", candidateId: document.candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "整份需求" };
        const units = document.partition.units.map((unit) => unit.id), goals = units.filter((unit) => unit !== "metadata");
        const evidence = retain ? current.retainedEvidence?.find((entry) => entry.unitId === "A") : undefined;
        if (retain && !evidence) throw new Error("A 段的原依据不可用");
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
          { ...common, kind: "constraint", conclusion: "需求身份元数据" }, { ...common, kind: "target", conclusion: "确认正文" },
          { ...common, kind: "action", actions: ["implement"], conclusion: "允许实施" }],
        documentReview: { faithful: true, units: units.map((unit) => ({ id: unit, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [],
          conclusionIndexes: unit === "A" && evidence ? [] : [unit === "metadata" ? 0 : 1], ...(unit === "A" && evidence ? { retainedFactIds: [evidence.fact.id] } : {}) })),
        actions: [{ action: "implement", goalIds: goals, constraintIds: [], conclusionIndexes: [2], unknown: false }], questions: [] } });
      },
    } } as never);
  cleanups.push(async () => core.shutdown());
  core.startSession({ sessionId: "retain-section", windowId: "retain-section" });
  core.save((await core.interpret(core.captureInput({ source: "interactive", text: "确认整份需求。" }, "retain-section"), id)).capability);
  saved = await (await w.open(lines)).updateDraft({ requirementId: id, operationId: uuidv7(), version: 6, title: "需求标题", body: sections("B修改后目标。") });
  lines[id]!.push(saved.anchor);
  confirmOperationId = uuidv7();
  retain = true;
  const interpreted = await core.interpret(core.captureInput({ source: "interactive", text: "A 保持原结论，B 改了并允许实施。" }, "retain-section"), id);
  core.save(interpreted.capability);
  const authorized = core.authorizeDocument(interpreted.capability, { basis: loaded.basis, candidate: loaded.candidate });
  if (!authorized) throw new Error("沿用旧依据的清单没有获得授权");
  expect(authorized.manifest.retainedSources?.length).toBeGreaterThan(0);
  const store = new ApprovalManifestStore({ ...w.config, lines, authorize: () => true,
    loadExpected: async () => { const current = await load(); return { requirementId: current.requirementId, candidate: current.candidate, partition: current.partition }; },
    admit: () => ({ receiptId: authorized.authorization.receiptId, version: authorized.authorization.basis.version,
      epoch: authorized.authorization.basis.epoch, inputProof: authorized.authorization.inputProof }) });
  const manifest = await store.register(authorized.manifest);
  const confirm = { requirementId: id, operationId: confirmOperationId, version: loaded.version, title: loaded.title, body: loaded.body, receiptId: authorized.authorization.receiptId, manifest };
  return { lines, manifest, confirm, saved, retainedDecisionId: authorized.manifest.retainedSources![0]!.decision.id };
}

async function approveWithRetainedSection(w: World) {
  const prepared = await prepareRetainedSection(w);
  await (await w.open(prepared.lines)).confirmUpdate(prepared.confirm);
  return prepared;
}

test("回退后保存，批准清单带沿用旧依据的段落，批准后按批准结果读取批准清单成功", async () => {
  const w = await world();
  const { lines, manifest } = await approveWithRetainedSection(w);
  const read = w.manifestStore(lines).read(manifest);
  expect(read.retainedSources?.length).toBeGreaterThan(0);
});

async function supersedeOnLineA(w: World, implement = true) {
  const id = w.requirementId;
  const base: Lines = { [id]: [...w.lineB[id]!] };
  const confirm = await manifestConfirmInput({ ...w.config, lines: base }, { requirementId: id, savedOperationId: w.tipB.operationId, implement });
  const ctx = await w.context(base, w.tipB);
  const stored = withDatabase(w.dbPath, (db) => db.read<{ manifest: ApprovalManifest }>("approval_manifests_v1", confirm.manifest.manifestHash))!.data.manifest;
  const d = [...stored.units, ...stored.actions, ...stored.questions].flatMap((u) => u.decisionIds)[0]!;
  const beforeE: Lines = { [id]: [...base[id]!] }, afterE: Lines = { [id]: [...base[id]!] };
  const e = (await w.appendDecision(afterE, { version: 5, epoch: ctx.epoch, prd: ctx.basis.prd, supersedes: [d], conclusion: "取代 D 的决定 E" })).decisionIds[0]!;
  return { d, e, beforeE, afterE, ctx, confirm };
}

test("线 A 上决定 E 取代了 D，回到 E 之前的线 B 上读 D 仍是有效（confirmed、未被取代）", async () => {
  const w = await world();
  const { d, beforeE } = await supersedeOnLineA(w);
  expect((await w.decisionStore(beforeE)).read(w.requirementId, d)).toMatchObject({ status: "confirmed", supersededBy: null });
});

test("线 A 上 E 取代了 D，线 B 上可以用新决定 F 取代 D", async () => {
  const w = await world();
  const { d, beforeE, ctx } = await supersedeOnLineA(w);
  const f = await w.appendDecision(beforeE, { version: 5, epoch: ctx.epoch, prd: ctx.basis.prd, supersedes: [d], conclusion: "线 B 上取代 D 的决定 F" }).catch((caught: unknown) => caught);
  expect(f).toMatchObject({ decisionIds: [expect.any(String)] });
  expect((await w.decisionStore(beforeE)).read(w.requirementId, d)).toMatchObject({ status: "superseded", supersededBy: (f as { decisionIds: string[] }).decisionIds[0] });
});

test("线 A 上 E 取代了 D，线 B 上读取登记过的、引用 D 的批准清单不报错，旧决定里有 D", async () => {
  const w = await world();
  const { d, beforeE } = await supersedeOnLineA(w);
  const auth = new HostAuthorizationManager({ dataRoot: w.config.dataRoot });
  auth.startWindow({ kind: "main", windowId: "b2", sessionId: "b2", repoIds: [w.config.repoId] });
  const records = (() => { try { return auth.interactionRecords(w.config.repoId, w.requirementId, "b2", undefined, beforeE[w.requirementId]!); } catch (caught) { return caught; } })();
  expect(records).not.toBeInstanceOf(Error);
  expect((records as { priorDecisions: Array<{ decisionId: string }> }).priorDecisions.map((r) => r.decisionId)).toContain(d);
});

test("换回线 A，D 仍是被 E 取代", async () => {
  const w = await world();
  const { d, e, afterE } = await supersedeOnLineA(w);
  expect((await w.decisionStore(afterE)).read(w.requirementId, d)).toMatchObject({ status: "superseded", supersededBy: e });
});

test("迁移前留下的共享旧决定在线 A 上被取代后，线 B 上它仍有效，线 A 上是已取代", async () => {
  const w = await world();
  const legacy = (await w.appendDecision(w.lineA, { version: 10, epoch: w.ctxA.epoch, prd: w.ctxA.basis.prd, conclusion: "旧决定" })).decisionIds[0]!;
  withDatabase(w.dbPath, (db) => {
    const member = db.read("line_anchor_members", `short_decisions:${legacy}`);
    if (member) db.remove("line_anchor_members", `short_decisions:${legacy}`, member.version);
  });
  const e = (await w.appendDecision(w.lineA, { version: 10, epoch: w.ctxA.epoch, prd: w.ctxA.basis.prd, supersedes: [legacy], conclusion: "线 A 上取代旧决定" })).decisionIds[0]!;
  expect((await w.decisionStore(w.lineA)).read(w.requirementId, legacy)).toMatchObject({ status: "superseded", supersededBy: e });
  expect((await w.decisionStore(w.lineB)).read(w.requirementId, legacy)).toMatchObject({ status: "confirmed", supersededBy: null });
});

const APPROVAL_REJECTION = /^(manifest_decisions_changed|manifest_input_changed|continuity_changed|continuity_decision_changed|continuity_source_changed|manifest_decision_mismatch)$/;

test("解读登记清单之后、批准之前，当前线上新记决定取代了清单引用的决定：批准被拒，需求仍是草稿", async () => {
  const w = await world();
  const { afterE, confirm } = await supersedeOnLineA(w);
  const error = await (await w.open(afterE)).confirmUpdate(confirm).then(() => null, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: expect.stringMatching(APPROVAL_REJECTION) });
  expect((await w.state()).read(w.requirementId).data.lifecycle).toBe("draft");
});

async function interpretedOnLine(w: World) {
  const id = w.requirementId;
  const lines: Lines = { [id]: [...w.lineB[id]!] };
  const confirmOperationId = uuidv7();
  const load = async () => (await w.open(lines)).loadConfirmationContext({ requirementId: id, savedOperationId: w.tipB.operationId, operationId: confirmOperationId });
  let loaded = await load();
  const core = await UserInteractionCore.open({ ...w.config, lines, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => {
      loaded = await load();
      const document = { candidate: loaded.candidate, title: loaded.title, body: loaded.body, partition: loaded.partition };
      const result: InteractionContext = { basis: loaded.basis, currentGoal: "", candidates: [{ ...loaded.candidate, diff: loaded.difference.text || "无差异" }],
        document, savedOperationId: loaded.savedOperationId, ...loadInteractionContinuity(w.config.dataRoot, w.config.repoId, loaded.basis, document, undefined, lines[id]) };
      return result;
    },
    interpreter: {
      identity: () => ({ provider: "fixture", id: "confirm-all", configurationHash: "a".repeat(64) }),
      interpret: async ({ context: current }) => {
        const document = current.document!;
        const common = { basis: "explicit", resolution: "direct", candidateId: document.candidate.candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "整份需求" };
        const units = document.partition.units.map((unit) => unit.id);
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
          { ...common, kind: "constraint", conclusion: "需求身份元数据" }, { ...common, kind: "target", conclusion: "确认正文" },
          { ...common, kind: "action", actions: ["implement"], conclusion: "允许实施" }],
        documentReview: { faithful: true, units: units.map((unit) => ({ id: unit, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [unit === "metadata" ? 0 : 1] })),
        actions: [{ action: "implement", goalIds: units.filter((unit) => unit !== "metadata"), constraintIds: [], conclusionIndexes: [2], unknown: false }], questions: [] } });
      },
    } } as never);
  cleanups.push(async () => core.shutdown());
  core.startSession({ sessionId: "confirm-all", windowId: "confirm-all" });
  const interpreted = await core.interpret(core.captureInput({ source: "interactive", text: "确认整份需求。" }, "confirm-all"), id);
  core.save(interpreted.capability);
  const authorize = () => core.authorizeDocument(interpreted.capability, { basis: loaded.basis, candidate: loaded.candidate });
  return { core, lines, authorize, loaded: () => loaded };
}

test("批准授权（authorizeDocument）：线 A 上 E 取代了解读引用的决定后被拒，线 B（E 之前）上同一份解读仍通过", async () => {
  const w = await world();
  const { lines, authorize, loaded } = await interpretedOnLine(w);
  const first = authorize();
  expect(first).not.toBeNull();
  const referenced = [...first!.manifest.units, ...first!.manifest.actions, ...first!.manifest.questions].flatMap((u) => u.decisionIds)[0]!;
  const lineWithE: Lines = { [w.requirementId]: [...lines[w.requirementId]!] };
  await w.appendDecision(lineWithE, { version: 5, epoch: loaded().epoch, prd: loaded().basis.prd, supersedes: [referenced], conclusion: "线 A 上取代" });
  expect(authorize()).not.toBeNull();
  lines[w.requirementId]!.push(lineWithE[w.requirementId]!.at(-1)!);
  expect(authorize()).toBeNull();
});

test("授权实施（authorizeImplement）：批准后新记决定 E 取代了这次补授权决定，授权被拒（批准后的记录在每条线上都算数）", async () => {
  const w = await world();
  const id = w.requirementId;
  const lines: Lines = { [id]: [...w.lineB[id]!] };
  const confirm = await manifestConfirmInput({ ...w.config, lines }, { requirementId: id, savedOperationId: w.tipB.operationId, implement: false });
  await (await w.open(lines)).confirmUpdate(confirm);
  const row = (await w.state()).read(id);
  const basis = { requirementId: id, version: row.version, epoch: row.data.epoch, prd: row.data.approved };
  const context: InteractionContext = { basis, currentGoal: "", candidates: [], questions: [], priorDecisions: [],
    implementAuthorization: { revision: row.data.revision, manifest: row.data.approvalManifest!.reference } };
  const core = await UserInteractionCore.open({ ...w.config, lines, authorize: () => true, authorizeAction: () => true, loadContext: async () => structuredClone(context),
    interpreter: { identity: () => ({ provider: "fixture", id: "implement", configurationHash: "a".repeat(64) }),
      interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
        { kind: "action", basis: "explicit", resolution: "direct", candidateId: null, requestId: null, actions: ["implement"], conclusion: "开始实施", scope: "整份已批准需求", references: [], supersedes: [] }] }) } } as never);
  cleanups.push(async () => core.shutdown());
  core.startSession({ sessionId: "implement", windowId: "implement" });
  const { capability } = await core.interpret(core.captureInput({ source: "interactive", text: "授权实施" }, "implement"), id);
  const saved = core.save(capability);
  expect(core.authorizeImplement(capability)).not.toBeNull();
  const lineWithE: Lines = { [id]: [...lines[id]!] };
  await w.appendDecision(lineWithE, { version: row.version, epoch: row.data.epoch, prd: row.data.approved, supersedes: [saved.decisionIds[0]!], conclusion: "线 A 上取代补授权" });
  expect(core.authorizeImplement(capability)).toBeNull();
});

test("沿用旧依据的段落所依据的决定在当前线上被取代：批准被拒，需求仍是草稿；没经过那次取代的另一条线上批准通过", async () => {
  const w = await world();
  const { lines, confirm, saved, retainedDecisionId } = await prepareRetainedSection(w);
  const ctx = await w.context(lines, saved);
  const lineWithE: Lines = { [w.requirementId]: [...lines[w.requirementId]!] };
  await w.appendDecision(lineWithE, { version: ctx.version, epoch: ctx.epoch, prd: ctx.basis.prd, supersedes: [retainedDecisionId], conclusion: "取代被沿用的依据" });
  const rejected = await (await w.open(lineWithE)).confirmUpdate(confirm).then(() => null, (caught: unknown) => caught);
  expect(rejected).toMatchObject({ code: expect.stringMatching(/^(manifest_decisions_changed|manifest_input_changed|continuity_changed|continuity_decision_changed|continuity_source_changed|manifest_retained_escape)$/) });
  expect((await w.state()).read(w.requirementId).data.lifecycle).toBe("draft");
  const approved = await (await w.open(lines)).confirmUpdate(confirm).then(() => null, (caught: unknown) => caught);
  const afterRow = (await w.state()).read(w.requirementId).data;
  expect(approved).toBeNull();
  expect(afterRow.approved?.commit).toBe(ctx.saved.commit);
});

async function supplementImplement(w: World, lines: Lines) {
  const id = w.requirementId;
  const record = (await w.state()).read(id);
  const baseRef = record.data.approvalManifest!.reference;
  const current = withDatabase(w.dbPath, (db) => registeredApprovalManifestIn(db, w.config.repoId, baseRef, record));
  const goalIds = current.units.filter((unit) => unit.disposition === "confirmed" && unit.id !== "metadata").map((unit) => unit.id);
  const context: InteractionContext = { basis: { requirementId: id, version: record.version, epoch: record.data.epoch, prd: record.data.approved }, currentGoal: "",
    candidates: [], questions: [], priorDecisions: [], implementAuthorization: { revision: record.data.revision, manifest: baseRef } };
  const core = await UserInteractionCore.open({ ...w.config, lines, authorize: () => true, authorizeAction: () => true, loadContext: async () => structuredClone(context),
    interpreter: { identity: () => ({ provider: "fixture", id: "implement", configurationHash: "a".repeat(64) }),
      interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
        { kind: "action", basis: "explicit", resolution: "direct", candidateId: null, requestId: null, actions: ["implement"], conclusion: "开始实施", scope: "整份已批准需求", references: [], supersedes: [] }] }) } } as never);
  cleanups.push(async () => core.shutdown());
  core.startSession({ sessionId: "supplement", windowId: "supplement" });
  const { capability } = await core.interpret(core.captureInput({ source: "interactive", text: "授权实施" }, "supplement"), id);
  core.save(capability);
  const authorization = core.authorizeImplement(capability);
  if (!authorization) throw new Error("core.authorizeImplement 返回空");
  const manifest = supplementImplementAction({ manifest: current, goalIds, decisionId: authorization.decisionId });
  const next = approvalManifestReference(manifest);
  const store = new ApprovalManifestStore({ ...w.config, authorize: () => true,
    loadExpected: async () => ({ requirementId: id, candidate: manifest.candidate, partition: { prdHash: manifest.candidate.to.hash, totalBytes: manifest.totalBytes,
      units: manifest.units.map(({ id: unitId, hash, startByte, endByte }) => ({ id: unitId, hash, startByte, endByte })) } }),
    admit: () => { const again = core.authorizeImplement(capability);
      return again ? { receiptId: again.receiptId, version: again.version, epoch: again.epoch, inputProof: again.inputProof } : null; } });
  await store.registerImplementSupplement({ base: baseRef, manifest, decisionId: authorization.decisionId });
  await (await w.open(lines)).authorizeImplement({ requirementId: id, version: authorization.version, receiptId: authorization.receiptId, manifest: next });
  return { next, decisionId: authorization.decisionId };
}

const authorizedToImplement = async (w: World, next: ReturnType<typeof approvalManifestReference>) => {
  const row = (await w.state()).read(w.requirementId);
  return manifestAuthorizesImplement(withDatabase(w.dbPath, (db) => registeredApprovalManifestIn(db, w.config.repoId, next, row)));
};

test("线 A 上有解读事实和没回答的提问，回到线 B 不带实施地批准，再补授权实施成功，需求变成已授权实施", async () => {
  const w = await world();
  const lines: Lines = { [w.requirementId]: [...w.lineB[w.requirementId]!] };
  await (await w.open(lines)).confirmUpdate(await manifestConfirmInput({ ...w.config, lines }, { requirementId: w.requirementId, savedOperationId: w.tipB.operationId, implement: false }));
  const { next } = await supplementImplement(w, lines);
  expect(await authorizedToImplement(w, next)).toBe(true);
});

test("线 A 上 E 取代了 D，回到线 B 批准引用 D 的清单（不带实施），再补授权实施成功", async () => {
  const w = await world();
  const { beforeE, confirm } = await supersedeOnLineA(w, false);
  await (await w.open(beforeE)).confirmUpdate(confirm);
  const { next } = await supplementImplement(w, beforeE);
  expect(await authorizedToImplement(w, next)).toBe(true);
});

test("补授权实施完成后，当前线上新记决定取代了那条授权实施决定：之后按批准结果读取批准清单被拒", async () => {
  const w = await world();
  const lines: Lines = { [w.requirementId]: [...w.lineB[w.requirementId]!] };
  await (await w.open(lines)).confirmUpdate(await manifestConfirmInput({ ...w.config, lines }, { requirementId: w.requirementId, savedOperationId: w.tipB.operationId, implement: false }));
  const { next, decisionId } = await supplementImplement(w, lines);
  const row = (await w.state()).read(w.requirementId);
  await w.appendDecision(lines, { version: row.version, epoch: row.data.epoch, prd: row.data.approved, supersedes: [decisionId], conclusion: "撤回授权实施" });
  expect(() => w.manifestStore(lines).read(next)).toThrow();
});

test("普通段落引用 D，线 A 上 E 取代 D 后，回到线 B 批准成功", async () => {
  const w = await world();
  const { beforeE, confirm, d } = await supersedeOnLineA(w);
  await expect((await w.open(beforeE)).confirmUpdate(confirm)).resolves.toBeDefined();
  expect((await w.state()).read(w.requirementId).data.approved?.commit).toBe(w.tipB.commit);
  expect((await w.decisionStore(beforeE)).read(w.requirementId, d)).toMatchObject({ status: "confirmed" });
});
