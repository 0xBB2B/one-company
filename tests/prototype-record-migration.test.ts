import { expect, test } from "vitest";
import { Value } from "typebox/value";
import type { MigrationRecord, MigrationRecords } from "../src/core/storage/database-migration.ts";
import { confirmWindowContent } from "../src/modules/prototype/prototype-windows.ts";
import { prototypeRecordsV8Step, prototypeRecordsV9Step } from "../src/modules/requirement/prototype-record-migration.ts";
import { PrototypeBoard } from "../src/modules/requirement/requirement-prototypes.ts";
import { PrototypeRevision } from "../src/modules/requirement/requirement-prototype-revisions.ts";

const REQUIREMENT_ID = "01900000-0000-7000-8000-000000000001";
const RUN_ID = "01900000-0000-7000-8000-000000000002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const file = (version: number, hash: string, userNote: string | null) => ({ version, hash, bytes: 1200, note: "设计说明", userNote });

const entryApproved = () => ({
  name: "登录页", lastVersion: 2, draft: file(2, HASH_A, "按钮改蓝色"), approved: file(2, HASH_A, "按钮改蓝色"), removed: false,
  inFlight: null, lastOpinion: null, lastEnded: null,
});
const entryAwaiting = () => ({
  name: "设置页", lastVersion: 1, draft: null, approved: null, removed: false,
  inFlight: { version: 1, runId: RUN_ID, agent: "designer", status: "awaiting", file: file(1, HASH_B, null) },
  lastOpinion: null, lastEnded: null,
});
const entryEmpty = () => ({
  name: "空页", lastVersion: 1, draft: null, approved: null, removed: true, inFlight: null, lastOpinion: null, lastEnded: null,
});
const boardV8 = () => ({ requirementId: REQUIREMENT_ID, entries: [entryApproved(), entryAwaiting(), entryEmpty()], updatedAt: 1_700_000_000_000 });
const revisionV8 = () => ({
  requirementId: REQUIREMENT_ID, revision: 3,
  prototypes: [
    { name: "登录页", version: 2, hash: HASH_A, bytes: 1200, userNote: "按钮改蓝色" },
    { name: "设置页", version: 1, hash: HASH_C, bytes: 800, userNote: "标题加粗" },
  ],
});

function fakeRecords(initial: Record<string, MigrationRecord[]>) {
  const store = new Map(Object.entries(initial).map(([namespace, rows]) => [namespace, rows.map((row) => ({ ...row }))]));
  const replaced: Array<{ namespace: string; key: string; data: unknown }> = [];
  const records: MigrationRecords = {
    list: (namespace) => store.get(namespace) ?? [],
    replace: (namespace, key, data) => {
      replaced.push({ namespace, key, data });
      const row = store.get(namespace)?.find((item) => item.key === key);
      if (row) row.data = data;
    },
  };
  const latest = (namespace: string, key: string) => replaced.filter((call) => call.namespace === namespace && call.key === key).at(-1)?.data as any;
  return { records, replaced, latest };
}

const migrateBoth = (records: MigrationRecords) => {
  prototypeRecordsV8Step.migrate(records);
  prototypeRecordsV9Step.migrate(records);
};

const migrated = () => {
  const fake = fakeRecords({
    requirement_prototypes: [{ key: REQUIREMENT_ID, data: boardV8() }],
    requirement_prototype_revisions: [{ key: `${REQUIREMENT_ID}:3`, data: revisionV8() }],
    requirements: [{ key: REQUIREMENT_ID, data: { title: "原样" } }],
  });
  prototypeRecordsV8Step.migrate(fake.records);
  return fake;
};

test("转换步骤从版本 8 起，迁移框只列补充说明这一项损失", () => {
  expect(prototypeRecordsV8Step.from).toBe(8);
  expect(prototypeRecordsV8Step.losses).toEqual(["迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）"]);
});

test("看板里 draft、approved、inFlight.file 三处都加 options 空数组和 picked null，并去掉 userNote", () => {
  const board = migrated().latest("requirement_prototypes", REQUIREMENT_ID);
  const [approved, awaiting] = board.entries;
  for (const content of [approved.draft, approved.approved, awaiting.inFlight.file]) {
    expect(content.options).toEqual([]);
    expect(content.picked).toBeNull();
    expect(content).not.toHaveProperty("userNote");
  }
  expect(approved.draft).toEqual({ version: 2, hash: HASH_A, bytes: 1200, note: "设计说明", options: [], picked: null });
});

test("看板里为 null 的交稿内容保持 null，其他字段原样", () => {
  const board = migrated().latest("requirement_prototypes", REQUIREMENT_ID);
  const empty = board.entries[2];
  expect(empty).toEqual(entryEmpty());
  expect(board.entries[1].inFlight).toMatchObject({ version: 1, runId: RUN_ID, agent: "designer", status: "awaiting" });
  expect(board.entries[1].draft).toBeNull();
  expect(board.requirementId).toBe(REQUIREMENT_ID);
  expect(board.updatedAt).toBe(1_700_000_000_000);
});

test("版本快照每项加 picked null、去掉 userNote，其他字段原样", () => {
  const revision = migrated().latest("requirement_prototype_revisions", `${REQUIREMENT_ID}:3`);
  expect(revision).toEqual({
    requirementId: REQUIREMENT_ID, revision: 3,
    prototypes: [
      { name: "登录页", version: 2, hash: HASH_A, bytes: 1200, picked: null },
      { name: "设置页", version: 1, hash: HASH_C, bytes: 800, picked: null },
    ],
  });
});

test("v8 步骤之后再跑 v9 步骤，看板和版本快照都通过当前结构校验", () => {
  const fake = migrated();
  prototypeRecordsV9Step.migrate(fake.records);
  expect(Value.Check(PrototypeBoard, fake.latest("requirement_prototypes", REQUIREMENT_ID))).toBe(true);
  expect(Value.Check(PrototypeRevision, fake.latest("requirement_prototype_revisions", `${REQUIREMENT_ID}:3`))).toBe(true);
});

test("其他命名空间的记录没有被 replace 调用过", () => {
  const namespaces = new Set(migrated().replaced.map((call) => call.namespace));
  expect(namespaces).toEqual(new Set(["requirement_prototypes", "requirement_prototype_revisions"]));
});

test("看板记录转换后读不出来时抛错，写明需求、原型名和字段路径", () => {
  const bad = boardV8();
  delete (bad.entries[0]!.draft as Partial<ReturnType<typeof file>>).version;
  const fake = fakeRecords({ requirement_prototypes: [{ key: REQUIREMENT_ID, data: bad }] });
  expect(() => migrateBoth(fake.records)).toThrow(Error);
  try {
    migrateBoth(fake.records);
  } catch (error) {
    expect((error as Error).message).toContain(`原型记录（需求 ${REQUIREMENT_ID}，原型「登录页」）读不出来`);
    expect((error as Error).message).toContain("version");
  }
});

test("看板 entry 整个缺了交稿内容键时，报错同样写明需求、原型名和字段路径", () => {
  const bad = boardV8();
  delete (bad.entries[0] as Partial<ReturnType<typeof entryApproved>>).draft;
  const fake = fakeRecords({ requirement_prototypes: [{ key: REQUIREMENT_ID, data: bad }] });
  expect(() => migrateBoth(fake.records)).toThrow(`原型记录（需求 ${REQUIREMENT_ID}，原型「登录页」）读不出来`);
  expect(() => migrateBoth(fake.records)).toThrow("draft");
});

test("版本快照转换后读不出来时抛错，写明需求、版本号和出错那一项的原型名", () => {
  const bad = revisionV8();
  delete (bad.prototypes[1] as Partial<(typeof bad.prototypes)[number]>).hash;
  const fake = fakeRecords({ requirement_prototype_revisions: [{ key: `${REQUIREMENT_ID}:3`, data: bad }] });
  try {
    prototypeRecordsV8Step.migrate(fake.records);
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toContain(`原型版本快照（需求 ${REQUIREMENT_ID}，第 3 版，原型「设置页」）读不出来`);
    expect((error as Error).message).toContain("hash");
  }
});

test("等确认的版本转换后方案清单为空，确认窗口只列通过", () => {
  const options = migrated().latest("requirement_prototypes", REQUIREMENT_ID).entries[1].inFlight.file.options as string[];
  expect(options).toEqual([]);
  const content = confirmWindowContent({
    requirementTitle: "需求", draftVersion: 1, name: "设置页", version: 1, path: "/tmp/p.html", bytes: 800, hash: HASH_B, note: "说明", previousOpinion: null, options,
  }, true);
  expect(content.choices.map((choice) => choice.label)).toEqual(["通过（写进需求草稿）"]);
});

const fileV9 = (version: number, hash: string) => ({ version, hash, bytes: 1200, note: "设计说明", options: [], picked: null });
const entryV9 = (name: string, patch: Record<string, unknown>) => ({
  name, lastVersion: 3, draft: null, approved: null, removed: false, inFlight: null, lastOpinion: null, lastEnded: null, ...patch,
});
const designingV9 = () => entryV9("在做页", { inFlight: { version: 3, runId: RUN_ID, agent: "designer", status: "designing", file: null } });
const awaitingV9 = () => entryV9("等确认页", {
  inFlight: { version: 3, runId: RUN_ID, agent: "designer", status: "awaiting", file: fileV9(3, HASH_B) },
  lastOpinion: { version: 3, opinion: "按钮再大一点" },
});
const approvedV9 = () => entryV9("通过页", { draft: fileV9(2, HASH_A), approved: fileV9(2, HASH_A), lastEnded: { version: 1, reason: "旧原因" } });
const boardV9 = () => ({ requirementId: REQUIREMENT_ID, entries: [designingV9(), awaitingV9(), approvedV9()], updatedAt: 1_700_000_000_000 });

const migratedV9 = () => {
  const fake = fakeRecords({ requirement_prototypes: [{ key: REQUIREMENT_ID, data: boardV9() }] });
  prototypeRecordsV9Step.migrate(fake.records);
  return fake.latest("requirement_prototypes", REQUIREMENT_ID);
};

const V9_REASON = "升级后交原型要带 DESIGN.md，这一版作废，请重派";

test("v9 步骤从版本 9 起，迁移框列固定的一句损失", () => {
  expect(prototypeRecordsV9Step.from).toBe(9);
  expect(prototypeRecordsV9Step.losses).toEqual(["升级前还在做、或还在等你确认的原型会作废，需要重派（它们交稿时没带 DESIGN.md）"]);
});

test("v9 步骤把在做和等确认的原型 inFlight 置空，lastEnded 写这一版的版本号和固定原因", () => {
  const [designing, awaiting] = migratedV9().entries;
  expect(designing.inFlight).toBeNull();
  expect(designing.lastEnded).toEqual({ version: 3, reason: V9_REASON });
  expect(awaiting.inFlight).toBeNull();
  expect(awaiting.lastEnded).toEqual({ version: 3, reason: V9_REASON });
});

test("v9 步骤不动 lastOpinion、draft、approved、removed，也不动没有 inFlight 的条目", () => {
  const board = migratedV9();
  expect(board.entries[1].lastOpinion).toEqual({ version: 3, opinion: "按钮再大一点" });
  expect(board.entries[2]).toEqual(approvedV9());
  expect(board.entries[0]).toEqual({ ...designingV9(), inFlight: null, lastEnded: { version: 3, reason: V9_REASON } });
});

test("v9 步骤转换后的看板通过当前结构校验", () => {
  expect(Value.Check(PrototypeBoard, migratedV9())).toBe(true);
});

test("v9 步骤不碰看板以外的命名空间", () => {
  const fake = fakeRecords({
    requirement_prototypes: [{ key: REQUIREMENT_ID, data: boardV9() }],
    requirement_prototype_revisions: [{ key: `${REQUIREMENT_ID}:3`, data: { requirementId: REQUIREMENT_ID, revision: 3, prototypes: [] } }],
  });
  prototypeRecordsV9Step.migrate(fake.records);
  expect(new Set(fake.replaced.map((call) => call.namespace))).toEqual(new Set(["requirement_prototypes"]));
});

test("v9 步骤遇到结构不合格的看板时抛错，写明需求编号和原型名", () => {
  const bad = boardV9();
  delete (bad.entries[2] as Partial<ReturnType<typeof approvedV9>>).draft;
  const fake = fakeRecords({ requirement_prototypes: [{ key: REQUIREMENT_ID, data: bad }] });
  expect(() => prototypeRecordsV9Step.migrate(fake.records)).toThrow(`原型记录（需求 ${REQUIREMENT_ID}，原型「通过页」）读不出来`);
});
