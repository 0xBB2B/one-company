import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { ShortDecisionStore } from "../src/modules/requirement/short-decisions.ts";
import { ApprovalManifestStore } from "../src/modules/requirement/approval-manifest-store.ts";
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
