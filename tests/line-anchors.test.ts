import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7, repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import type { LocalDatabase } from "../src/core/storage/database.ts";
import type { LineAnchorRecord } from "../src/modules/requirement/requirement-contracts.ts";
import {
  LINE_ANCHOR_ENTRY, attachRecordIn, countedAnchorsIn, createLineAnchorIn, isRecordCountedIn,
  latestSaveAnchorIn, lineVersionIn, lineViewIn, memberAnchorIn, resolveLineTipIn,
} from "../src/modules/requirement/line-anchors.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const repoId = "a".repeat(64);
const commit = "c".repeat(40);

async function workspace() {
  const root = await mkdtemp(join(temporaryRoot(), "line-anchors-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = repositoryDatabase(root, repoId);
  return <T>(fn: (db: LocalDatabase) => T): T => withDatabase(path, (db) => db.transaction(() => fn(db) as never)) as T;
}

type Kind = LineAnchorRecord["kind"];
function add(db: LocalDatabase, requirementId: string, line: string[], kind: Kind, now: number, fileCommit?: string) {
  const base = { repoId, requirementId, anchor: uuidv7(), line, now, ...(fileCommit ? { fileCommit } : {}) };
  return kind === "save" ? createLineAnchorIn(db, { ...base, kind, saved: { commit: fileCommit ?? commit, hash: "b".repeat(64) } }) : createLineAnchorIn(db, { ...base, kind });
}

function tree(db: LocalDatabase, requirementId: string) {
  const A = add(db, requirementId, [], "save", 1);
  const B = add(db, requirementId, [A.anchor], "save", 2);
  const C = add(db, requirementId, [A.anchor, B.anchor], "decision", 3);
  const D = add(db, requirementId, [A.anchor, B.anchor], "save", 4);
  return { A, B, C, D };
}

test("对话线含A,B,C时线尖是C，算数集合是A,B,C，版本号3", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C } = tree(db, req); const line = [A.anchor, B.anchor, C.anchor];
    expect(resolveLineTipIn(db, req, line)?.anchor).toBe(C.anchor);
    expect(countedAnchorsIn(db, req, line)).toEqual(new Set(line));
    expect(lineVersionIn(db, req, line)).toBe(3);
  });
});

test("对话线含A,B,D时线尖是D，C不算数，版本号4", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req); const line = [A.anchor, B.anchor, D.anchor];
    expect(resolveLineTipIn(db, req, line)?.anchor).toBe(D.anchor);
    const counted = countedAnchorsIn(db, req, line);
    expect(counted).toEqual(new Set(line));
    expect(counted.has(C.anchor)).toBe(false);
    expect(lineVersionIn(db, req, line)).toBe(4);
  });
});

test("对话线不含该需求任何锚点时，线尖是最近一次保存的锚点", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { C, D } = tree(db, req);
    expect(latestSaveAnchorIn(db, req)?.anchor).toBe(D.anchor);
    expect(resolveLineTipIn(db, req, [])?.anchor).toBe(D.anchor);
    expect(C.kind).toBe("decision");
  });
});

test("需求没有任何锚点时线尖为空，版本号为空，算数集合为空", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    expect(resolveLineTipIn(db, req, [])).toBeNull();
    expect(latestSaveAnchorIn(db, req)).toBeNull();
    expect(lineVersionIn(db, req, [])).toBeNull();
    expect(countedAnchorsIn(db, req, []).size).toBe(0);
  });
});

test("对话线里的锚点编号在数据库查不到时跳过，继续往前找", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B } = tree(db, req);
    expect(resolveLineTipIn(db, req, [A.anchor, B.anchor, uuidv7(), uuidv7()])?.anchor).toBe(B.anchor);
  });
});

test("对话线锚点全部查不到时回到最近一次保存的锚点", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { D } = tree(db, req);
    expect(resolveLineTipIn(db, req, [uuidv7()])?.anchor).toBe(D.anchor);
  });
});

test("新锚点记录格式完整，首个save锚点父为null、lineVersion为2、saved是传入的保存正文引用", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const anchor = uuidv7();
    const saved = { commit, hash: "d".repeat(64) };
    const rec = createLineAnchorIn(db, { repoId, requirementId: req, anchor, kind: "save", line: [], now: 123, saved });
    expect(rec).toEqual({ format: "line-anchor/v1", repoId, requirementId: req, anchor, parent: null, kind: "save", lineVersion: 2, sequence: 1, fileCommit: null, saved, createdAt: 123 });
    expect(db.read("line_anchors", anchor)?.data).toEqual(rec);
  });
});

test("非save锚点的saved是null", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const save = add(db, req, [], "save", 1);
    const decision = add(db, req, [save.anchor], "decision", 2);
    expect(decision.saved).toBeNull();
    expect(db.read("line_anchors", decision.anchor)?.data).toMatchObject({ saved: null });
  });
});

test("线上没有该需求锚点时，新锚点的父是该需求最近一次保存的锚点", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { D } = tree(db, req);
    const E = add(db, req, [], "decision", 5);
    expect(E.parent).toBe(D.anchor);
    expect(E.lineVersion).toBe(D.lineVersion);
  });
});

test("save锚点版本号是父加1，其他kind沿用父的版本号", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    expect([A.lineVersion, B.lineVersion, C.lineVersion, D.lineVersion]).toEqual([2, 3, 3, 4]);
    for (const [i, kind] of (["question", "manifest", "prototype", "conventions", "approval"] as Kind[]).entries()) {
      expect(add(db, req, [A.anchor, B.anchor, D.anchor], kind, 10 + i).lineVersion).toBe(4);
    }
  });
});

test("fileCommit给出时用给出的，没给时沿用父锚点的，SHA-256长度也接受", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const A = add(db, req, [], "save", 1, commit);
    expect(A.fileCommit).toBe(commit);
    const B = add(db, req, [A.anchor], "decision", 2);
    expect(B.fileCommit).toBe(commit);
    const long = "d".repeat(64);
    const C = add(db, req, [A.anchor, B.anchor], "save", 3, long);
    expect(C.fileCommit).toBe(long);
    expect(add(db, req, [A.anchor, B.anchor, C.anchor], "question", 4).fileCommit).toBe(long);
  });
});

test("两次用同一个线尖写入都成功，得到父相同的两个兄弟锚点", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B } = tree(db, req); const line = [A.anchor, B.anchor];
    const E = add(db, req, line, "decision", 5); const F = add(db, req, line, "decision", 6);
    expect(E.anchor).not.toBe(F.anchor);
    expect(E.parent).toBe(B.anchor);
    expect(F.parent).toBe(B.anchor);
  });
});

test("没有line_anchor_members记录的过程记录在任意线上都算数", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    for (const line of [[A.anchor, B.anchor, C.anchor], [A.anchor, B.anchor, D.anchor], []]) {
      expect(isRecordCountedIn(db, { namespace: "short_decisions", key: "legacy", requirementId: req, line })).toBe(true);
    }
  });
});

test("挂在C上的记录在A,B,C线上算数，在A,B,D线上不算数", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    attachRecordIn(db, { namespace: "short_decisions", key: "k1", requirementId: req, anchor: C.anchor });
    expect(db.read("line_anchor_members", "short_decisions:k1")?.data).toEqual({ format: "line-anchor-member/v1", requirementId: req, anchor: C.anchor });
    expect(isRecordCountedIn(db, { namespace: "short_decisions", key: "k1", requirementId: req, line: [A.anchor, B.anchor, C.anchor] })).toBe(true);
    expect(isRecordCountedIn(db, { namespace: "short_decisions", key: "k1", requirementId: req, line: [A.anchor, B.anchor, D.anchor] })).toBe(false);
  });
});

test("同一个记录键在不同命名空间互不影响", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req); const line = [A.anchor, B.anchor, D.anchor];
    attachRecordIn(db, { namespace: "questions", key: "k", requirementId: req, anchor: C.anchor });
    expect(isRecordCountedIn(db, { namespace: "questions", key: "k", requirementId: req, line })).toBe(false);
    expect(isRecordCountedIn(db, { namespace: "short_decisions", key: "k", requirementId: req, line })).toBe(true);
  });
});

test("有批准锚点时，批准之后创建的锚点上的记录在任何线上都算数", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    const E = add(db, req, [A.anchor, B.anchor, D.anchor], "approval", 5);
    const F = add(db, req, [A.anchor, B.anchor, D.anchor, E.anchor], "decision", 6);
    const G = add(db, req, [A.anchor, B.anchor, C.anchor], "question", 7);
    for (const [key, anchor] of [["e", E.anchor], ["f", F.anchor], ["g", G.anchor], ["d", D.anchor], ["c", C.anchor]] as const) {
      attachRecordIn(db, { namespace: "short_decisions", key, requirementId: req, anchor });
    }
    for (const line of [[A.anchor, B.anchor, C.anchor], [A.anchor, B.anchor, D.anchor], []]) {
      const counted = (key: string) => isRecordCountedIn(db, { namespace: "short_decisions", key, requirementId: req, line });
      expect([counted("e"), counted("f"), counted("g"), counted("d")]).toEqual([true, true, true, true]);
      expect(counted("c")).toBe(false);
    }
  });
});

test("有批准锚点时，算数的锚点集合与对话线无关", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    const E = add(db, req, [A.anchor, B.anchor, D.anchor], "approval", 5);
    const F = add(db, req, [A.anchor, B.anchor, D.anchor, E.anchor], "decision", 6);
    const expected = new Set([A.anchor, B.anchor, D.anchor, E.anchor, F.anchor]);
    expect(countedAnchorsIn(db, req, [A.anchor, B.anchor, C.anchor])).toEqual(expected);
    expect(countedAnchorsIn(db, req, [])).toEqual(expected);
  });
});

test("混入另一个需求的锚点时互不影响", async () => {
  const run = await workspace(); const req = uuidv7(); const other = uuidv7();
  run((db) => {
    const { A, B, C } = tree(db, req);
    const X = add(db, other, [], "save", 10);
    const Y = add(db, other, [X.anchor], "save", 11);
    const mixed = [A.anchor, X.anchor, B.anchor, C.anchor, Y.anchor];
    expect(resolveLineTipIn(db, req, mixed)?.anchor).toBe(C.anchor);
    expect(countedAnchorsIn(db, req, mixed)).toEqual(new Set([A.anchor, B.anchor, C.anchor]));
    expect(resolveLineTipIn(db, other, mixed)?.anchor).toBe(Y.anchor);
    expect(countedAnchorsIn(db, other, mixed)).toEqual(new Set([X.anchor, Y.anchor]));
    expect(latestSaveAnchorIn(db, req)?.requirementId).toBe(req);
    expect(Y.parent).toBe(X.anchor);
  });
});

test("多次批准时算数集合以第一次批准为准：第一次批准及祖先加上它之后写入的全部锚点", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    const E = add(db, req, [A.anchor, B.anchor, D.anchor], "approval", 5);
    const S = add(db, req, [A.anchor, B.anchor, C.anchor], "save", 6);
    const E2 = add(db, req, [A.anchor, B.anchor, C.anchor, S.anchor], "approval", 7);
    const expected = new Set([A.anchor, B.anchor, D.anchor, E.anchor, S.anchor, E2.anchor]);
    for (const line of [[A.anchor, B.anchor, C.anchor], [A.anchor, B.anchor, D.anchor, E.anchor], [A.anchor, B.anchor, C.anchor, S.anchor, E2.anchor], []]) {
      const counted = countedAnchorsIn(db, req, line);
      expect(counted).toEqual(expected);
      expect(counted.has(C.anchor)).toBe(false);
    }
  });
});

test("有批准锚点后，线尖、版本号、新锚点的父都取最后写入的锚点，和对话线无关", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    const E = add(db, req, [A.anchor, B.anchor, D.anchor], "approval", 5);
    const lineC = [A.anchor, B.anchor, C.anchor]; const lineE = [A.anchor, B.anchor, D.anchor, E.anchor];
    expect(resolveLineTipIn(db, req, lineC)?.anchor).toBe(E.anchor);
    expect(resolveLineTipIn(db, req, lineE)?.anchor).toBe(E.anchor);
    expect(lineVersionIn(db, req, lineC)).toBe(lineVersionIn(db, req, lineE));
    const G = add(db, req, lineC, "decision", 6);
    expect(G.parent).toBe(E.anchor);
    const S = add(db, req, lineC, "save", 7);
    expect(S.parent).toBe(G.anchor);
    for (const line of [lineC, lineE, []]) {
      expect(resolveLineTipIn(db, req, line)?.anchor).toBe(S.anchor);
      expect(lineVersionIn(db, req, line)).toBe(S.lineVersion);
    }
  });
});

test("批准之后的锚点按写入先后算数，now相同或更小也算数", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    const E = add(db, req, [A.anchor, B.anchor, D.anchor], "approval", 50);
    const F = add(db, req, [A.anchor, B.anchor, C.anchor], "decision", 50);
    const H = add(db, req, [A.anchor, B.anchor, C.anchor], "save", 2);
    for (const line of [[A.anchor, B.anchor, C.anchor], []]) {
      const counted = countedAnchorsIn(db, req, line);
      expect(counted.has(F.anchor)).toBe(true);
      expect(counted.has(H.anchor)).toBe(true);
      expect(counted.has(E.anchor)).toBe(true);
    }
    expect(resolveLineTipIn(db, req, [])?.anchor).toBe(H.anchor);
  });
});

test("最近一次保存按写入先后取，now相同取后写入的，后写入的now更小也取它", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { D } = tree(db, req);
    expect(latestSaveAnchorIn(db, req)?.anchor).toBe(D.anchor);
    add(db, req, [], "save", 100);
    const S2 = add(db, req, [], "save", 100);
    expect(latestSaveAnchorIn(db, req)?.anchor).toBe(S2.anchor);
    const S3 = add(db, req, [], "save", 5);
    expect(latestSaveAnchorIn(db, req)?.anchor).toBe(S3.anchor);
  });
});

test("需求的第一个锚点不是save时lineVersion是1，之后在这条线上保存得到2", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const X = add(db, req, [], "decision", 1);
    expect(X.lineVersion).toBe(1);
    expect(lineVersionIn(db, req, [X.anchor])).toBe(1);
    const Y = add(db, req, [X.anchor], "save", 2);
    expect(Y.lineVersion).toBe(2);
  });
});

test("lineViewIn返回的tip、counted、version与三个单独函数一致", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { A, B, C, D } = tree(db, req);
    for (const line of [[A.anchor, B.anchor, C.anchor], [A.anchor, B.anchor, D.anchor], []]) {
      const view = lineViewIn(db, req, line);
      expect(view.tip?.anchor).toBe(resolveLineTipIn(db, req, line)?.anchor);
      expect(view.counted).toEqual(countedAnchorsIn(db, req, line));
      expect(view.version).toBe(lineVersionIn(db, req, line));
    }
  });
});

test("memberAnchorIn返回记录挂的锚点编号，没挂返回null", async () => {
  const run = await workspace(); const req = uuidv7();
  run((db) => {
    const { C } = tree(db, req);
    attachRecordIn(db, { namespace: "short_decisions", key: "k1", requirementId: req, anchor: C.anchor });
    expect(memberAnchorIn(db, "short_decisions", "k1")).toBe(C.anchor);
    expect(memberAnchorIn(db, "short_decisions", "none")).toBeNull();
    expect(memberAnchorIn(db, "questions", "k1")).toBeNull();
  });
});

test("LINE_ANCHOR_ENTRY是one-company.line-anchor", () => {
  expect(LINE_ANCHOR_ENTRY).toBe("one-company.line-anchor");
});
