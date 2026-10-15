import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import {
  prototypeChangeLines, prototypeChanges, prototypesAtRevision, writePrototypeRevision,
} from "../runtime/requirement-prototype-revisions.ts";

const REPO = "a".repeat(64);
let dataRoot: string;
let ref: { dataRoot: string; repoId: string };
let requirementId: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join("/tmp", "pi-t-"));
  mkdirSync(dataRoot, { recursive: true });
  ref = { dataRoot, repoId: REPO };
  requirementId = uuidv7();
});
afterEach(() => { rmSync(dataRoot, { recursive: true, force: true }); });

const file = (name: string, version: number) => ({ name, version, hash: (name + version).length.toString(16).padStart(64, "0"), bytes: 100 + version });
const write = (revision: number, prototypes: ReturnType<typeof file>[], id = requirementId) =>
  withDatabase(repositoryDatabase(dataRoot, REPO), (db) => writePrototypeRevision(db, { requirementId: id, revision, prototypes }));

test("写下第 2 版需求的原型快照后，按版本号读回名称、版本、指纹和字节数", async () => {
  const prototypes = [file("设置页", 3), file("命令行输出", 1)];
  await write(2, prototypes);
  const read = await prototypesAtRevision(ref, requirementId, 2);
  expect([...read].sort((a, b) => a.name.localeCompare(b.name))).toEqual([...prototypes].sort((a, b) => a.name.localeCompare(b.name)));
});

test("版本号为 0 或该版本没有快照时读回空列表", async () => {
  await write(2, [file("设置页", 1)]);
  expect(await prototypesAtRevision(ref, requirementId, 0)).toEqual([]);
  expect(await prototypesAtRevision(ref, requirementId, 1)).toEqual([]);
  expect(await prototypesAtRevision(ref, uuidv7(), 2)).toEqual([]);
});

test("同一版本的快照写下后再写不同内容会报错，内容不变", async () => {
  await write(1, [file("设置页", 1)]);
  expect(() => write(1, [file("设置页", 2)])).toThrow();
  expect((await prototypesAtRevision(ref, requirementId, 1)).map((item) => [item.name, item.version])).toEqual([["设置页", 1]]);
});

test("不同需求的同一版本号互不影响", async () => {
  const other = uuidv7();
  await write(1, [file("设置页", 1)]);
  await write(1, [file("别的页", 4)], other);
  expect((await prototypesAtRevision(ref, requirementId, 1)).map((item) => item.name)).toEqual(["设置页"]);
  expect((await prototypesAtRevision(ref, other, 1)).map((item) => item.name)).toEqual(["别的页"]);
});

test("两个版本比较时把换版、新增、移除分开列出，没变的不列", () => {
  const from = [file("设置页", 2), file("旧外观弹窗", 1), file("不变页", 1)];
  const to = [file("设置页", 3), file("命令行输出", 1), file("不变页", 1)];
  expect(prototypeChanges(from, to)).toEqual({
    added: [{ name: "命令行输出", version: 1 }],
    replaced: [{ name: "设置页", from: 2, to: 3 }],
    removed: [{ name: "旧外观弹窗", version: 1 }],
  });
});

test("两个版本的原型完全一样时三类变化都是空的", () => {
  const same = [file("设置页", 2), file("命令行输出", 1)];
  expect(prototypeChanges(same, same)).toEqual({ added: [], replaced: [], removed: [] });
  expect(prototypeChanges([], [])).toEqual({ added: [], replaced: [], removed: [] });
});

test("上一版没有任何原型时，这一版的原型都算新增", () => {
  expect(prototypeChanges([], [file("设置页", 1)])).toEqual({ added: [{ name: "设置页", version: 1 }], replaced: [], removed: [] });
});

test("变化说明按换版、新增、移除的顺序写成一行", () => {
  const changes = { added: [{ name: "命令行输出", version: 1 }], replaced: [{ name: "设置页", from: 2, to: 3 }], removed: [{ name: "旧外观弹窗", version: 1 }] };
  expect(prototypeChangeLines(changes)).toBe("原型变化：设置页 换成第 3 版；命令行输出 新确认第 1 版；旧外观弹窗 移除");
});

test("只有一类变化时只写那一类", () => {
  expect(prototypeChangeLines({ added: [{ name: "命令行输出", version: 1 }], replaced: [], removed: [] })).toBe("原型变化：命令行输出 新确认第 1 版");
  expect(prototypeChangeLines({ added: [], replaced: [], removed: [{ name: "旧外观弹窗", version: 1 }] })).toBe("原型变化：旧外观弹窗 移除");
});

test("没有任何变化时变化说明是空字符串", () => {
  expect(prototypeChangeLines({ added: [], replaced: [], removed: [] })).toBe("");
});
