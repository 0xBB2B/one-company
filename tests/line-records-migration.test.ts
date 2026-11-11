import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { DatabaseMigrationError, migrateRepositoryDatabases, withMigrationLock } from "../src/core/storage/database-migration.ts";
import { isRecordCountedIn } from "../src/modules/requirement/line-anchors.ts";
import requirementManageExtension from "../src/modules/interaction/requirement-manage-extension.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import { lineRecordsV10Step } from "../src/modules/requirement/line-migration.ts";
import { prototypeRecordsV8Step, prototypeRecordsV9Step } from "../src/modules/requirement/prototype-record-migration.ts";
import { readDraftFiles, prdRequirementPath } from "../src/modules/requirement/prd-storage.ts";
import { RequirementOperations } from "../src/modules/requirement/requirement-operations.ts";
import { LineAnchorRecord } from "../src/modules/requirement/requirement-contracts.ts";
import { draftPrototypes, readPrototypeBoard } from "../src/modules/requirement/requirement-prototypes.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { requirementSummary } from "../src/modules/requirement/requirement-summary.ts";
import { manifestConfirmInput } from "./helpers/approval-fixture.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

process.umask(0o077);
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTML = "<!doctype html><html><body><h1>导出弹窗草图</h1></body></html>";
const NAME = "导出弹窗";
const STALE_HASH = "f".repeat(64);
const LOSS = "这次迁移不会丢数据。";
const BOARD_NAMESPACE = "requirement_prototypes";
const REWRITTEN = ["requirement_prototypes", "prototype_changes", "line_anchors", "line_anchor_members", "line_operation_anchors", "requirement_summaries"];
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

interface Row { id: string; namespace: string; record_key: string; version: number; data: string }
function dump(path: string): { version: number; records: Row[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      records: db.prepare("SELECT id, namespace, record_key, version, data FROM records ORDER BY namespace, record_key").all().map((row) => ({ ...row })) as unknown as Row[],
    };
  } finally { db.close(); }
}
const rowsOf = (path: string, namespace: string) => dump(path).records.filter((row) => row.namespace === namespace).map((row) => ({ key: row.record_key, version: row.version, data: JSON.parse(row.data) as any }));

const protoFile = (version: number, html: string, extra: Record<string, unknown> = {}) =>
  ({ version, hash: sha256(html), bytes: Buffer.byteLength(html), note: "说明", options: [], picked: null, ...extra });
const entry = (name: string, patch: Record<string, unknown>) =>
  ({ name, lastVersion: 1, draft: null, approved: null, removed: false, inFlight: null, lastOpinion: null, lastEnded: null, ...patch });
const board = (requirementId: string, entries: unknown[]) => ({ requirementId, entries, updatedAt: 1_700_000_000_000 });

const DRAFT_ENTRIES = [entry(NAME, { draft: protoFile(1, HTML, { options: ["简洁版", "详细版"], picked: { letter: "A", name: "简洁版" } }) })];
const APPROVED_ENTRIES = [
  entry("设置页", { approved: protoFile(1, "<html>设置页</html>") }),
  entry("导出页", { lastVersion: 3, approved: protoFile(2, "<html>导出页</html>"), lastEnded: { version: 3, reason: "用户提了意见后重派，这一版作废" } }),
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-c", "core.quotepath=off", ...args], { cwd, env: GIT_ENV })).stdout.trim();
}

async function oldWorld(options: { unfinished?: boolean; badApprovedBoard?: boolean; draftEntries?: unknown[]; fromVersion?: number; halfSavedPrototype?: boolean } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "line-migration-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const { repoId } = await repositoryIdentity(repo.root);
  const dataRoot = join(root, "data");
  const config = { repositoryRoot: repo.root, dataRoot, repoId };
  const dbPath = repositoryDatabase(dataRoot, repoId);
  const directory = join(dataRoot, "repos", repoId);
  const ref = { dataRoot, repoId };
  const open = (lines?: Record<string, readonly string[]>) => RequirementService.open({ ...config, authorize: () => true, authorizeManifest: () => true, ...(lines ? { lines } : {}) });
  const input = (requirementId: string, version: number, body: string, operationId = uuidv7()) => ({ requirementId, operationId, version, title: "需求标题", body });

  const saveChain = async (steps: number, firstBody: string) => {
    const created = await (await open()).create({ requestId: uuidv7(), operationId: uuidv7(), title: "需求标题", body: `${firstBody} v2` });
    const receipts = [created];
    for (let i = 1; i < steps; i++) {
      const previous = receipts.at(-1)!;
      receipts.push(await (await open({ [created.requirementId]: receipts.map((r) => r.anchor) })).updateDraft(input(created.requirementId, previous.version, `${firstBody} v${previous.version + 1}`)));
    }
    return { requirementId: created.requirementId, receipts, lines: { [created.requirementId]: receipts.map((r) => r.anchor) } };
  };

  const draft = await saveChain(6, "草稿正文");
  const approved = await saveChain(2, "已批准正文");
  const confirm = await manifestConfirmInput({ ...config, lines: approved.lines }, { requirementId: approved.requirementId, savedOperationId: approved.receipts.at(-1)!.operationId });
  await (await open(approved.lines)).confirmUpdate(confirm);

  let unfinishedUpdate: ReturnType<typeof input> | undefined;
  let unfinishedCreate: { requestId: string; operationId: string; title: string; body: string } | undefined;
  let halfSaved: Awaited<ReturnType<typeof saveChain>> | undefined;
  if (options.unfinished) {
    halfSaved = await saveChain(2, "半路正文");
    unfinishedUpdate = input(halfSaved.requirementId, 3, "停在半路的正文");
    const original = RequirementOperations.prototype.recordGitResult;
    const spy = vi.spyOn(RequirementOperations.prototype, "recordGitResult").mockImplementationOnce(() => { throw new Error("injected git-result failure"); }).mockImplementation(original);
    await expect((await open(halfSaved.lines)).updateDraft(unfinishedUpdate)).rejects.toThrow(/git-result failure/);
    unfinishedCreate = { requestId: uuidv7(), operationId: uuidv7(), title: "没存完的需求", body: "还没存完" };
    spy.mockImplementationOnce(() => { throw new Error("injected git-result failure"); }).mockImplementation(original);
    await expect((await open()).create(unfinishedCreate)).rejects.toThrow(/git-result failure/);
  }

  const requirementIds = withDatabase(dbPath, (db) => db.list("requirements").map((row) => row.key));
  const unfinishedCreateId = unfinishedCreate ? requirementIds.find((id) => ![draft, approved, halfSaved!].some((r) => r.requirementId === id))! : undefined;

  const decisionKeys = [1, 2, 3, 4].map(() => uuidv7());
  const questionKey = uuidv7(), factKey = uuidv7();
  const designBytes = "# 设计规范\n主色 #0f766e\n", agentsBytes = "# 项目约定\n中文注释\n";
  await writeFile(join(repo.root, "DESIGN.md"), designBytes);
  await writeFile(join(repo.root, "AGENTS.md"), agentsBytes);
  const prototypeDirectory = join(directory, "prototypes", draft.requirementId);
  await mkdir(prototypeDirectory, { recursive: true });
  await writeFile(join(prototypeDirectory, `${NAME}.v1.html`), HTML);
  if (options.halfSavedPrototype) {
    const halfDirectory = join(directory, "prototypes", halfSaved!.requirementId);
    await mkdir(halfDirectory, { recursive: true });
    await writeFile(join(halfDirectory, `${NAME}.v1.html`), HTML);
  }

  withDatabase(dbPath, (db) => db.transaction(() => {
    for (const [index, key] of decisionKeys.entries()) {
      db.create("short_decisions", key, { requirementId: draft.requirementId, conclusion: `决定${index + 1}` });
      db.update("short_decisions", key, 1, { requirementId: draft.requirementId, conclusion: `决定${index + 1}（改）` });
    }
    db.create("interaction_questions_v1", questionKey, { requirementId: draft.requirementId, text: "是否保留邮箱登录" });
    db.create("interaction_resolution_facts_v1", factKey, { requirementId: draft.requirementId, fact: "用户同意分析" });
    db.create("requirement_prototype_revisions", `${approved.requirementId}:1`, { requirementId: approved.requirementId, revision: 1, prototypes: [] });
    db.create(BOARD_NAMESPACE, draft.requirementId, board(draft.requirementId, options.draftEntries ?? DRAFT_ENTRIES));
    if (options.halfSavedPrototype) db.create(BOARD_NAMESPACE, halfSaved!.requirementId, board(halfSaved!.requirementId, DRAFT_ENTRIES));
    db.create(BOARD_NAMESPACE, approved.requirementId, board(approved.requirementId, options.badApprovedBoard
      ? [...APPROVED_ENTRIES, entry("坏页", { approved: { version: 1 } })] : APPROVED_ENTRIES));
    const savedHash = (requirementId: string) => (db.read("requirements", requirementId)!.data as { saved: { hash: string } }).saved.hash.replace(/^sha256:/u, "");
    db.create("requirement_summaries", draft.requirementId, { prdHash: savedHash(draft.requirementId), summary: "草稿简介" });
    db.create("requirement_summaries", approved.requirementId, { prdHash: savedHash(approved.requirementId), summary: "已批准简介" });
    if (halfSaved) db.create("requirement_summaries", halfSaved.requirementId, { prdHash: STALE_HASH, summary: "旧版简介" });
    if (unfinishedCreateId) db.create("requirement_summaries", unfinishedCreateId, { prdHash: STALE_HASH, summary: "没保存过的简介" });
  }));

  // 旧版本没有锚点、过程记录成员和按锚点记的原型变动，需求仓库里只有 main
  withDatabase(dbPath, (db) => db.transaction(() => {
    for (const namespace of ["line_anchors", "line_anchor_members", "line_operation_anchors", "prototype_changes"]) {
      for (const row of db.list(namespace)) db.remove(namespace, row.key, row.version);
    }
  }));
  for (const requirementId of [draft, approved, halfSaved].flatMap((r) => r ? [r.requirementId] : []).concat(unfinishedCreateId ? [unfinishedCreateId] : [])) {
    const cwd = prdRequirementPath({ dataRoot, repoId, requirementId });
    const refs = (await git(cwd, "for-each-ref", "--format=%(refname)", "refs/lines/")).split("\n").filter(Boolean);
    for (const name of refs) await git(cwd, "update-ref", "-d", name);
  }
  const raw = new DatabaseSync(dbPath);
  try { raw.exec(`PRAGMA user_version = ${options.fromVersion ?? 10}`); } finally { raw.close(); }

  const repoPath = (requirementId: string) => prdRequirementPath({ dataRoot, repoId, requirementId });
  const scope = { directory: await realpath(directory), worktreeRoots: [repo.root] };
  const migrate = (steps = [lineRecordsV10Step]) => withMigrationLock(scope, async (permit) => await migrateRepositoryDatabases(permit, steps));
  const rowOf = (requirementId: string) => rowsOf(dbPath, "requirements").find((row) => row.key === requirementId)!;
  const start = (requirementId: string) => rowsOf(dbPath, "line_anchors").map((row) => row.data).filter((record) => record.requirementId === requirementId);
  const mainOf = (requirementId: string) => git(repoPath(requirementId), "rev-parse", "refs/heads/main");
  const commitCount = async (requirementId: string) => Number(await git(repoPath(requirementId), "rev-list", "--count", "refs/heads/main"));
  const allCommitCount = async (requirementId: string) => Number(await git(repoPath(requirementId), "rev-list", "--count", "--all"));
  const startCommit = (requirementId: string) => start(requirementId).find((record) => record.sequence === 1)!.fileCommit as string;
  const worktreeAndBind = async (requirementId: string) => {
    const worktree = await addWorktree(repo);
    const baseCommit = await git(worktree.root, "rev-parse", "HEAD");
    const state = await RequirementStateStore.open({ ...config, authorize: () => true });
    return state.bindWorkspace({ requirementId, version: state.read(requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  };
  return {
    repo, config, dbPath, directory, ref, open, input, draft, approved, halfSaved, unfinishedUpdate, unfinishedCreate, unfinishedCreateId, decisionKeys, questionKey, factKey,
    designBytes, agentsBytes, migrate, rowOf, start, mainOf, commitCount, allCommitCount, startCommit, repoPath, worktreeAndBind, scope,
  };
}
type World = Awaited<ReturnType<typeof oldWorld>>;

const unchangedRows = (before: ReturnType<typeof dump>, after: ReturnType<typeof dump>, namespaces?: string[]) => {
  const pick = (dumped: ReturnType<typeof dump>) => dumped.records.filter((row) => namespaces ? namespaces.includes(row.namespace) : !REWRITTEN.includes(row.namespace));
  return [pick(before), pick(after)] as const;
};

test("转换步骤：从版本 10 起，迁移框只写这次迁移不会丢数据，文件搬运在 prepareFiles", () => {
  expect(lineRecordsV10Step.from).toBe(10);
  expect(lineRecordsV10Step.losses).toEqual([LOSS]);
  expect(typeof lineRecordsV10Step.prepareFiles).toBe("function");
});

test("迁移成功：库升到 11，备份是版本 10 原样数据，回执写明迁了数据库", async () => {
  const w = await oldWorld();
  const before = dump(w.dbPath);
  const receipt = await w.migrate();
  expect(receipt.migratedData).toBe(true);
  expect(dump(receipt.backupPath!)).toEqual(before);
  expect(dump(w.dbPath).version).toBe(11);
});

test("草稿需求在空线读取：正文、版本号、决定、提问、原型都和迁移前一样，之后照版本 7 保存回执版本 8", async () => {
  const w = await oldWorld();
  const id = w.draft.requirementId;
  expect(w.rowOf(id).version).toBe(7);
  await w.migrate();
  const service = await w.open({});
  const read = await service.read({ requirementId: id, source: "saved" });
  expect(read.body).toBe("草稿正文 v7");
  expect(read.version).toBe(7);
  expect((await service.metadata(id)).version).toBe(7);
  const counted = (namespace: string, key: string) => withDatabase(w.dbPath, (db) => isRecordCountedIn(db, { namespace, key, requirementId: id, line: [] }));
  for (const key of w.decisionKeys) expect(counted("short_decisions", key)).toBe(true);
  expect(counted("interaction_questions_v1", w.questionKey)).toBe(true);
  expect(counted("interaction_resolution_facts_v1", w.factKey)).toBe(true);
  expect((await readPrototypeBoard(w.ref, id, [])).entries).toEqual(DRAFT_ENTRIES);
  const receipt = await service.updateDraft(w.input(id, 7, "草稿正文 v8"));
  expect(receipt.version).toBe(8);
});

test("短决定、提问、事实、清单、需求记录、操作记录、批准快照：data 和 version 迁移前后逐字节相同，没有成员记录", async () => {
  const w = await oldWorld();
  const before = dump(w.dbPath);
  await w.migrate();
  const after = dump(w.dbPath);
  const [beforeRows, afterRows] = unchangedRows(before, after);
  const namespaces = new Set(beforeRows.map((row) => row.namespace));
  for (const namespace of ["short_decisions", "interaction_questions_v1", "interaction_resolution_facts_v1", "requirements", "requirement_service_operations", "requirement_prototype_revisions"]) {
    expect(namespaces.has(namespace)).toBe(true);
  }
  expect(afterRows).toEqual(beforeRows);
  const memberKeys = rowsOf(w.dbPath, "line_anchor_members").map((row) => row.key);
  for (const key of w.decisionKeys) expect(memberKeys).not.toContain(`short_decisions:${key}`);
  expect(memberKeys).not.toContain(`interaction_questions_v1:${w.questionKey}`);
});

test("草稿需求有一个起点 save 锚点：父为空、版本号等于需求行版本 7、序号 1、文件提交是以 main 为父的迁移提交", async () => {
  const w = await oldWorld();
  const id = w.draft.requirementId;
  const oldVersion = w.rowOf(id).version;
  const savedRef = w.rowOf(id).data.saved!;
  await w.migrate();
  const anchors = w.start(id);
  expect(anchors).toHaveLength(1);
  expect(Value.Check(LineAnchorRecord, anchors[0])).toBe(true);
  expect(anchors[0]).toMatchObject({ requirementId: id, repoId: w.config.repoId, kind: "save", parent: null, lineVersion: oldVersion, sequence: 1 });
  expect(anchors[0].fileCommit).not.toBe(await w.mainOf(id));
  expect(await git(w.repoPath(id), "rev-parse", `${anchors[0].fileCommit}^`)).toBe(await w.mainOf(id));
  expect(anchors[0].saved).toEqual({ commit: savedRef.commit, hash: savedRef.hash });
  expect(anchors[0].anchor).toMatch(UUID_V7);
});

test("已批准需求：起点 save 锚点加以它为父的 approval 锚点，文件提交相同，需求文件仓库 main 不动，之后建工作区不报错", async () => {
  const w = await oldWorld();
  const id = w.approved.requirementId;
  const oldVersion = w.rowOf(id).version;
  const approvedRef = w.rowOf(id).data.approved!;
  const mainBefore = await w.mainOf(id), countBefore = await w.commitCount(id);
  await w.migrate();
  const anchors = w.start(id);
  expect(anchors).toHaveLength(2);
  const save = anchors.find((record) => record.kind === "save")!, approval = anchors.find((record) => record.kind === "approval")!;
  expect(save).toMatchObject({ parent: null, lineVersion: oldVersion, sequence: 1, fileCommit: mainBefore });
  expect(approval).toMatchObject({ parent: save.anchor, fileCommit: mainBefore });
  expect(save.saved).toEqual({ commit: approvedRef.commit, hash: approvedRef.hash });
  expect(approval.saved).toBeNull();
  expect(approval.sequence).toBeGreaterThan(save.sequence);
  for (const record of anchors) expect(Value.Check(LineAnchorRecord, record)).toBe(true);
  expect(await w.mainOf(id)).toBe(mainBefore);
  expect(await w.commitCount(id)).toBe(countBefore);
  await expect(w.worktreeAndBind(id)).resolves.toBeDefined();
});

test("已批准需求在空线读到的批准版正文不变", async () => {
  const w = await oldWorld();
  await w.migrate();
  const service = await w.open({});
  const read = await service.read({ requirementId: w.approved.requirementId, source: "approved" });
  expect(read.body).toBe("已批准正文 v3");
  expect((await service.metadata(w.approved.requirementId)).lifecycle).toBe("active");
});

test("原型看板：旧看板记录删除，任意对话线上叠加出的看板和迁移前逐项相同", async () => {
  const w = await oldWorld();
  await w.migrate();
  expect(rowsOf(w.dbPath, BOARD_NAMESPACE)).toEqual([]);
  const draftId = w.draft.requirementId, approvedId = w.approved.requirementId;
  const draftStart = w.start(draftId).map((record) => record.anchor);
  const approvedStart = w.start(approvedId).map((record) => record.anchor);
  for (const line of [[], draftStart]) expect((await readPrototypeBoard(w.ref, draftId, line)).entries).toEqual(DRAFT_ENTRIES);
  for (const line of [[], approvedStart, [uuidv7()]]) expect((await readPrototypeBoard(w.ref, approvedId, line)).entries).toEqual(APPROVED_ENTRIES);
  expect(rowsOf(w.dbPath, "requirement_prototype_revisions").map((row) => row.key)).toEqual([`${w.approved.requirementId}:1`]);
});

test("需求简介：换成 <需求编号>:<记录里的 prdHash> 新键，内容不变；prdHash 和 saved 对不上的旧简介也按它自己的 prdHash 换键，读当前版本时不显示", async () => {
  const w = await oldWorld({ unfinished: true });
  const ids = [w.draft.requirementId, w.approved.requirementId];
  const hashes = ids.map((id) => w.rowOf(id).data.saved.hash.replace(/^sha256:/, "") as string);
  const staleId = w.halfSaved!.requirementId;
  const before = rowsOf(w.dbPath, "requirement_summaries").filter((row) => !row.key.startsWith(w.unfinishedCreateId!));
  expect(before.map((row) => row.key).sort()).toEqual([...ids, staleId].sort());
  await w.migrate();
  expect(requirementSummary(w.config.dataRoot, w.config.repoId, ids[0]!, hashes[0]!)).toBe("草稿简介");
  expect(requirementSummary(w.config.dataRoot, w.config.repoId, ids[1]!, hashes[1]!)).toBe("已批准简介");
  expect(requirementSummary(w.config.dataRoot, w.config.repoId, staleId, w.rowOf(staleId).data.saved.hash)).toBeUndefined();
  const after = rowsOf(w.dbPath, "requirement_summaries").filter((row) => !row.key.startsWith(w.unfinishedCreateId!));
  expect(after.map((row) => row.key).sort()).toEqual([`${ids[0]}:${hashes[0]}`, `${ids[1]}:${hashes[1]}`, `${staleId}:${STALE_HASH}`].sort());
  expect(after.map((row) => row.data).sort((a, b) => a.summary.localeCompare(b.summary))).toEqual(
    [{ prdHash: hashes[0], summary: "草稿简介" }, { prdHash: hashes[1], summary: "已批准简介" }, { prdHash: STALE_HASH, summary: "旧版简介" }].sort((a, b) => a.summary.localeCompare(b.summary)));
});

test("需求还没有 saved：它的旧简介按记录自己的 prdHash 换成新键保留，内容不变，旧键不在，也不建起点锚点", async () => {
  const w = await oldWorld({ unfinished: true });
  const id = w.unfinishedCreateId!;
  expect(w.rowOf(id).data.saved).toBeNull();
  await w.migrate();
  const rows = rowsOf(w.dbPath, "requirement_summaries").filter((row) => row.key.startsWith(id));
  expect(rows.map((row) => row.key)).toEqual([`${id}:${STALE_HASH}`]);
  expect(rows[0]!.data).toEqual({ prdHash: STALE_HASH, summary: "没保存过的简介" });
  expect(w.start(id)).toEqual([]);
});

test("升级前已有的保存操作记录各补一条操作锚点：产出某个起点链保存的那次操作用那个 save 锚点，其余用新锚点、父是该需求的起点锚点，没有起点时为空", async () => {
  const w = await oldWorld({ unfinished: true });
  const operations = rowsOf(w.dbPath, "requirement_service_operations");
  expect(operations.length).toBeGreaterThanOrEqual(5);
  await w.migrate();
  const anchors = rowsOf(w.dbPath, "line_operation_anchors");
  expect(anchors.map((row) => row.key).sort()).toEqual(operations.map((row) => row.key).sort());
  const issued = new Set<string>();
  for (const operation of operations) {
    const stored = anchors.find((row) => row.key === operation.key)!;
    const chain = w.start(operation.data.requirementId);
    const startOf = chain.find((record) => record.kind === "save" && record.sequence === 1);
    const git = operation.data.finalVersion !== null ? operation.data.git as { commit: string; hash: string } | null : null;
    const produced = git ? chain.find((record) => record.kind === "save" && record.saved?.commit === git.commit && record.saved?.hash === git.hash) : undefined;
    expect(stored.data).toEqual({ format: "line-operation-anchor/v1", requirementId: operation.data.requirementId,
      anchor: produced ? produced.anchor : expect.stringMatching(UUID_V7), parent: produced ? produced.parent : startOf?.anchor ?? null, unchangedTip: null });
    issued.add(stored.data.anchor);
  }
  expect(issued.size).toBe(operations.length);
  expect(operations.some((operation) => operation.data.requirementId === w.unfinishedCreateId)).toBe(true);
});

test("升级前没做完的保存：迁移后原样续完成功，版本号 4，操作记录收尾", async () => {
  const w = await oldWorld({ unfinished: true });
  await w.migrate();
  const receipt = await (await w.open({})).updateDraft(w.unfinishedUpdate!);
  expect(receipt.status).toBe("saved");
  expect(receipt.version).toBe(4);
  expect(rowsOf(w.dbPath, "requirement_service_operations").find((row) => row.key === w.unfinishedUpdate!.operationId)!.data.finalVersion).toBe(4);
  const read = await (await w.open({})).read({ requirementId: w.halfSaved!.requirementId, source: "saved" });
  expect(read.body).toBe("停在半路的正文");
});

test("升级前没做完的创建：迁移后原样续完成功，版本号 2", async () => {
  const w = await oldWorld({ unfinished: true });
  await w.migrate();
  const receipt = await (await w.open({})).create(w.unfinishedCreate!);
  expect(receipt.requirementId).toBe(w.unfinishedCreateId);
  expect(receipt.version).toBe(2);
});

test("升级前停在半路的保存：续完之前，空线读到的仍是版本 3 的正文，起点锚点的文件提交是需求行记着的那份", async () => {
  const w = await oldWorld({ unfinished: true });
  const id = w.halfSaved!.requirementId;
  const savedCommit = w.rowOf(id).data.saved.commit as string;
  await w.migrate();
  const read = await (await w.open({})).read({ requirementId: id, source: "saved" });
  expect(read.body).toBe("半路正文 v3");
  expect(read.version).toBe(3);
  expect(w.start(id).find((record) => record.kind === "save")!.fileCommit).toBe(savedCommit);
});

test("每个需求文件仓库的 main 都能从某个 refs/lines 到达，补的引用名是新的 UUIDv7", async () => {
  const w = await oldWorld({ unfinished: true });
  const ids = [w.draft.requirementId, w.approved.requirementId, w.halfSaved!.requirementId, w.unfinishedCreateId!];
  await w.migrate();
  for (const id of ids) {
    const cwd = w.repoPath(id);
    const refs = (await git(cwd, "for-each-ref", "--format=%(refname)", "refs/lines/")).split("\n").filter(Boolean);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slice("refs/lines/".length)).toMatch(UUID_V7);
    expect(await git(cwd, "for-each-ref", "--contains", await w.mainOf(id), "--format=%(refname)", "refs/lines/")).toBe(refs[0]);
  }
});

test("草稿需求的已通过原型搬进文件仓库：main 不动，迁移提交含原型 HTML 且只经 refs/lines 可达，原文件仍在，其他需求仓库不加提交", async () => {
  const w = await oldWorld();
  const id = w.draft.requirementId;
  const mainBefore = await w.mainOf(id), countBefore = await w.commitCount(id);
  const otherCounts = await Promise.all([w.approved.requirementId].map(async (other) => [other, await w.allCommitCount(other)] as const));
  await w.migrate();
  expect(await w.mainOf(id)).toBe(mainBefore);
  expect(await w.commitCount(id)).toBe(countBefore);
  const migration = w.startCommit(id);
  expect(migration).not.toBe(mainBefore);
  expect(await git(w.repoPath(id), "rev-parse", `${migration}^`)).toBe(mainBefore);
  const holders = (await git(w.repoPath(id), "for-each-ref", "--contains", migration, "--format=%(refname)")).split("\n").filter(Boolean);
  expect(holders.length).toBeGreaterThan(0);
  for (const name of holders) expect(name).toMatch(/^refs\/lines\//);
  const paths = (await git(w.repoPath(id), "ls-tree", "-r", "--name-only", migration)).split("\n").sort();
  expect(paths).toEqual(["prd.md", `prototypes/${NAME}.v1.html`]);
  const shown = (await exec("git", ["show", `${migration}:prototypes/${NAME}.v1.html`], { cwd: w.repoPath(id), env: GIT_ENV })).stdout;
  expect(shown).toBe(HTML);
  const files = await readDraftFiles({ ...w.config, requirementId: id, commit: migration, authorize: () => true } as never);
  expect(Object.values(files.prototypes).map((bytes) => Buffer.from(bytes).toString("utf8"))).toEqual([HTML]);
  expect(await readFile(join(w.directory, "prototypes", id, `${NAME}.v1.html`), "utf8")).toBe(HTML);
  for (const [other, count] of otherCounts) expect(await w.allCommitCount(other)).toBe(count);
});

test("主仓库根目录的 DESIGN.md、AGENTS.md 迁移前后字节不变", async () => {
  const w = await oldWorld();
  await w.migrate();
  expect(await readFile(join(w.repo.root, "DESIGN.md"), "utf8")).toBe(w.designBytes);
  expect(await readFile(join(w.repo.root, "AGENTS.md"), "utf8")).toBe(w.agentsBytes);
});

test("原型看板转换中途抛错：库和迁移前字节相同，错误写明需求和原型；修好后再迁移成功，迁移提交不重复", async () => {
  const w = await oldWorld({ badApprovedBoard: true });
  const draftId = w.draft.requirementId, approvedId = w.approved.requirementId;
  const before = dump(w.dbPath);
  const mainBefore = await w.mainOf(draftId), countBefore = await w.allCommitCount(draftId);
  const error = await w.migrate().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DatabaseMigrationError);
  const failure = error as DatabaseMigrationError;
  expect(failure.code).toBe("migration_failed");
  expect(failure.step).toContain("data.db 版本 10 → 11");
  expect(failure.message).toContain(approvedId);
  expect(failure.message).toContain("坏页");
  expect(dump(w.dbPath)).toEqual(before);
  expect(await w.mainOf(draftId)).toBe(mainBefore);
  expect(await w.allCommitCount(draftId)).toBe(countBefore + 1);

  const raw = new DatabaseSync(w.dbPath);
  try {
    raw.prepare("UPDATE records SET data = ? WHERE namespace = ? AND record_key = ?").run(JSON.stringify(board(approvedId, APPROVED_ENTRIES)), BOARD_NAMESPACE, approvedId);
  } finally { raw.close(); }
  await w.migrate();
  expect(dump(w.dbPath).version).toBe(11);
  expect(await w.mainOf(draftId)).toBe(mainBefore);
  expect(await w.allCommitCount(draftId)).toBe(countBefore + 1);
  expect(w.start(draftId)).toHaveLength(1);
  expect((await readPrototypeBoard(w.ref, draftId, [])).entries).toEqual(DRAFT_ENTRIES);
});

const treeOf = async (cwd: string, commit: string) => (await git(cwd, "ls-tree", "-r", "--name-only", commit)).split("\n").filter(Boolean).sort();
const showFile = async (cwd: string, commit: string, path: string) => (await exec("git", ["show", `${commit}:${path}`], { cwd, env: GIT_ENV })).stdout;

test("只预留了编号、需求文件仓库从没建起来的需求：跳过文件搬运，迁移成功，不建锚点也不建仓库", async () => {
  const w = await oldWorld();
  const reservedId = uuidv7();
  const source = w.rowOf(w.draft.requirementId).data;
  const raw = new DatabaseSync(w.dbPath);
  try {
    raw.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, 'requirements', ?, 1, ?)")
      .run(uuidv7(), reservedId, JSON.stringify({ ...source, requirementId: reservedId, requestId: uuidv7(), saved: null, approved: null }));
  } finally { raw.close(); }
  expect(existsSync(w.repoPath(reservedId))).toBe(false);
  const receipt = await w.migrate();
  expect(receipt.migratedData).toBe(true);
  expect(dump(w.dbPath).version).toBe(11);
  expect(w.start(reservedId)).toEqual([]);
  expect(existsSync(w.repoPath(reservedId))).toBe(false);
});

const V8_DRAFT = [entry(NAME, { draft: { version: 1, hash: sha256(HTML), bytes: Buffer.byteLength(HTML), note: "说明", userNote: "按钮改蓝" } })];
const V9_DRAFT = [entry(NAME, { draft: protoFile(1, HTML) })];
test.each([[8, V8_DRAFT], [9, V9_DRAFT]])("从版本 %i 经真实前序步骤一路迁到 11：草稿原型搬进需求文件仓库，看板转换正确", async (from, draftEntries) => {
  const w = await oldWorld({ fromVersion: from, draftEntries });
  const id = w.draft.requirementId;
  const receipt = await w.migrate([prototypeRecordsV8Step, prototypeRecordsV9Step, lineRecordsV10Step]);
  expect(receipt.migratedData).toBe(true);
  expect(dump(w.dbPath).version).toBe(11);
  expect(rowsOf(w.dbPath, BOARD_NAMESPACE)).toEqual([]);
  expect(await treeOf(w.repoPath(id), w.startCommit(id))).toEqual(["prd.md", `prototypes/${NAME}.v1.html`]);
  expect(await showFile(w.repoPath(id), w.startCommit(id), `prototypes/${NAME}.v1.html`)).toBe(HTML);
  expect((await readPrototypeBoard(w.ref, id, [])).entries).toEqual(V9_DRAFT);
  expect((await readPrototypeBoard(w.ref, id, [w.start(id)[0]!.anchor])).entries).toEqual(V9_DRAFT);
  expect((await readPrototypeBoard(w.ref, w.approved.requirementId, [])).entries).toEqual(APPROVED_ENTRIES);
});

test("升级前停在半路的保存加已通过原型：main 不动，迁移提交能从 refs/lines 到达；续完那次保存成功，再换新内容保存也成功", async () => {
  const w = await oldWorld({ unfinished: true, halfSavedPrototype: true });
  const id = w.halfSaved!.requirementId;
  const mainBefore = await w.mainOf(id);
  expect(mainBefore).not.toBe(w.rowOf(id).data.saved.commit);
  await w.migrate();
  expect(await w.mainOf(id)).toBe(mainBefore);
  const migration = w.startCommit(id);
  expect(migration).not.toBe(mainBefore);
  expect(await git(w.repoPath(id), "for-each-ref", "--contains", migration, "--format=%(refname)", "refs/lines/")).not.toBe("");
  expect(await showFile(w.repoPath(id), migration, `prototypes/${NAME}.v1.html`)).toBe(HTML);
  const resumed = await (await w.open({})).updateDraft(w.unfinishedUpdate!);
  expect(resumed.status).toBe("saved");
  expect(resumed.version).toBe(4);
  const next = await (await w.open({})).updateDraft(w.input(id, 4, "换了新内容"));
  expect(next.version).toBe(5);
  expect((await (await w.open({})).read({ requirementId: id, source: "saved" })).body).toBe("换了新内容");
});

test("两个仓库同时迁移、交错执行：各自草稿的起点锚点指向自己仓库里的迁移提交，互不覆盖", async () => {
  const a = await oldWorld();
  const b = await oldWorld();
  await Promise.all([a.migrate(), b.migrate()]);
  const commits = [];
  for (const w of [a, b]) {
    const id = w.draft.requirementId;
    expect(w.start(id)).toHaveLength(1);
    const migration = w.startCommit(id);
    expect(migration).not.toBe(await w.mainOf(id));
    expect(await git(w.repoPath(id), "rev-parse", `${migration}^`)).toBe(await w.mainOf(id));
    expect(await showFile(w.repoPath(id), migration, `prototypes/${NAME}.v1.html`)).toBe(HTML);
    commits.push(migration);
  }
  expect(commits[0]).not.toBe(commits[1]);
});

test("草稿已通过原型的 HTML 找不到：迁移失败、库不变，错误写明需求、原型、缺的路径和下一步；文件放回后再迁移成功", async () => {
  const w = await oldWorld();
  const id = w.draft.requirementId;
  const file = join(w.directory, "prototypes", id, `${NAME}.v1.html`);
  await rm(file);
  const before = dump(w.dbPath);
  const error = await w.migrate().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DatabaseMigrationError);
  const failure = error as DatabaseMigrationError;
  expect(failure.code).toBe("migration_failed");
  expect(failure.message).toContain(id);
  expect(failure.message).toContain(NAME);
  expect(failure.message).toContain(file);
  expect(failure.message).toContain("把文件放回原处后再迁移");
  expect(dump(w.dbPath)).toEqual(before);
  await writeFile(file, HTML);
  await w.migrate();
  expect(dump(w.dbPath).version).toBe(11);
});

test("看板转换各种组合：在做、等确认、已删除、有意见、已批准加草稿、草稿加在做并存；空线和起点线叠加结果都和转换前逐项相同", async () => {
  const designBase = sha256("# 设计规范\n");
  const inFlight = (status: "designing" | "awaiting", version: number, extra: Record<string, unknown> = {}) =>
    ({ version, runId: uuidv7(), agent: "designer", status, file: null, designBase, designs: null, ...extra });
  const bothHtml = "<html>双版页 v2</html>", coexistHtml = "<html>并存页 v2</html>";
  const entries = [
    entry("在做页", { inFlight: inFlight("designing", 1) }),
    entry("待确认页", { inFlight: inFlight("awaiting", 1, { file: protoFile(1, "<html>待确认</html>"), designs: [{ letter: "A", hash: sha256("设计A"), bytes: 20 }, { letter: "B", hash: sha256("设计B"), bytes: 20 }] }) }),
    entry("删掉页", { approved: protoFile(1, "<html>删掉</html>"), removed: true }),
    entry("空页", { removed: true }),
    entry("意见页", { lastOpinion: { version: 1, opinion: "按钮改蓝色" } }),
    entry("双版页", { lastVersion: 2, approved: protoFile(1, "<html>双版页 v1</html>"), draft: protoFile(2, bothHtml, { options: ["简洁版"], picked: { letter: "A", name: "简洁版" } }) }),
    entry("并存页", { lastVersion: 3, draft: protoFile(2, coexistHtml), inFlight: inFlight("designing", 3) }),
  ];
  const w = await oldWorld({ draftEntries: entries });
  const id = w.draft.requirementId;
  const directory = join(w.directory, "prototypes", id);
  await writeFile(join(directory, "双版页.v2.html"), bothHtml);
  await writeFile(join(directory, "并存页.v2.html"), coexistHtml);
  await w.migrate();
  for (const line of [[], [w.start(id)[0]!.anchor]]) expect((await readPrototypeBoard(w.ref, id, line)).entries).toEqual(entries);
});

test("有迁移提交的草稿迁移后批准：批准成功，批准锚点存在，按批准锚点的文件提交能读到原型 HTML", async () => {
  const w = await oldWorld();
  const id = w.draft.requirementId;
  await w.migrate();
  await w.worktreeAndBind(id);
  const lines = { [id]: [w.start(id)[0]!.anchor] };
  const { digest } = await draftPrototypes(w.ref, id, lines[id]!);
  const confirm = { ...(await manifestConfirmInput({ ...w.config, lines }, { requirementId: id, savedOperationId: w.draft.receipts.at(-1)!.operationId })), prototypes: digest };
  await (await w.open(lines)).confirmUpdate(confirm);
  const approval = w.start(id).find((record) => record.kind === "approval");
  expect(approval).toBeDefined();
  expect(await treeOf(w.repoPath(id), approval!.fileCommit)).toContain(`prototypes/${NAME}.v1.html`);
  expect(await showFile(w.repoPath(id), approval!.fileCommit, `prototypes/${NAME}.v1.html`)).toBe(HTML);
});

test("迁移后在没有锚点的旧对话里启动（空线）：不插已恢复消息", async () => {
  const w = await oldWorld();
  await w.migrate();
  const fake = createFakePi();
  const sendMessage = vi.fn();
  const client = { state: () => ({ status: "connected" as const }), subscribe: () => () => {}, call: async () => ({}) };
  const window = { windowId: "window-1", sessionId: "session-1", workspace: { repos: [{ repoId: w.config.repoId, path: w.repo.root }] }, clients: { forRepo: () => client } };
  requirementManageExtension({ ...fake.pi, sendMessage } as never, { authorization: new HostAuthorizationManager({ dataRoot: w.config.dataRoot }), dataRoot: w.config.dataRoot,
    windowReady: async () => window as never, windowContext: () => window as never, daemonLogPath: () => join(w.directory, "daemon.log") } as never);
  const ctx = { mode: "print", hasUI: false, sessionManager: { getSessionId: () => "session-1", getBranch: () => [] } };
  await fake.trigger("session_start", { reason: "startup" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(sendMessage).not.toHaveBeenCalled();
});
