import { expect, test } from "vitest";
import { Value } from "typebox/value";
import type { MigrationRecord, MigrationRecords } from "../src/core/storage/database-migration.ts";
import { confirmWindowContent } from "../src/modules/prototype/prototype-windows.ts";
import { prototypeRecordsV8Step } from "../src/modules/requirement/prototype-record-migration.ts";
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

test("转换后的看板和版本快照都通过当前结构校验", () => {
  const fake = migrated();
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
  expect(() => prototypeRecordsV8Step.migrate(fake.records)).toThrow(Error);
  try {
    prototypeRecordsV8Step.migrate(fake.records);
  } catch (error) {
    expect((error as Error).message).toContain(`原型记录（需求 ${REQUIREMENT_ID}，原型「登录页」）读不出来`);
    expect((error as Error).message).toContain("version");
  }
});

test("看板 entry 整个缺了交稿内容键时，报错同样写明需求、原型名和字段路径", () => {
  const bad = boardV8();
  delete (bad.entries[0] as Partial<ReturnType<typeof entryApproved>>).draft;
  const fake = fakeRecords({ requirement_prototypes: [{ key: REQUIREMENT_ID, data: bad }] });
  expect(() => prototypeRecordsV8Step.migrate(fake.records)).toThrow(`原型记录（需求 ${REQUIREMENT_ID}，原型「登录页」）读不出来`);
  expect(() => prototypeRecordsV8Step.migrate(fake.records)).toThrow("draft");
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
