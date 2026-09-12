import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AsyncTransactionError, DatabaseUnavailableError, LocalDatabase, StaleVersionError, TransactionCleanupError, uuidv7, withDatabase } from "../runtime/database.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { withoutSqliteExperimentalWarning } from "./helpers/node-warnings.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(temporaryRoot(), "transaction-safety-")); roots.push(root);
  const path = join(root, "data.db");
  return { path, db: new LocalDatabase(path) };
}
function unchecked(db: LocalDatabase, fn: () => unknown) {
  // 测试故意绕过静态类型限制，直接验证运行时保护。
  return (db.transaction.bind(db) as (callback: () => unknown) => unknown)(fn);
}
function expectUnavailable(db: LocalDatabase) {
  for (const action of [
    () => db.create("probe", "blocked", {}), () => db.update("probe", "blocked", 1, {}),
    () => db.remove("probe", "blocked", 1), () => db.append("probe", {}),
    () => db.transaction(() => undefined), () => db.read("probe", "blocked"),
    () => db.list("probe"), () => db.events("probe"),
  ]) expect(action).toThrow(DatabaseUnavailableError);
}
function expectEmpty(path: string) {
  const other = new LocalDatabase(path);
  try { expect(other.list("probe")).toEqual([]); expect(other.events("probe")).toEqual([]); }
  finally { other.close(); }
}
async function isolatedProbe(source: string): Promise<Record<string, unknown>> {
  const databaseModule = new URL("../runtime/database.ts", import.meta.url).href;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
import { existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AsyncTransactionError, DatabaseUnavailableError, LocalDatabase } from ${JSON.stringify(databaseModule)};
${source}
`], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  expect(withoutSqliteExperimentalWarning(stderr)).toBe("");
  return JSON.parse(stdout) as Record<string, unknown>;
}

for (const method of ["on", "once", "prependListener", "prependOnceListener"] as const) {
  test(`事务内不能向既有EventEmitter注册${method}延迟写回调`, async () => {
    const { path, db } = await fixture();
    const emitter = new EventEmitter();
    let registrationRejected = false, called = false;
    expect(() => unchecked(db, () => {
      db.create("probe", "before", {});
      try { emitter[method]("later", () => { called = true; db.create("probe", "late", {}); }); }
      catch { registrationRejected = true; }
    })).toThrow(AsyncTransactionError);
    expect(registrationRejected).toBe(true);
    expect(emitter.listenerCount("later")).toBe(0);
    emitter.emit("later");
    expect(called).toBe(false);
    expectUnavailable(db);
    expectEmpty(path);
    let normal = 0;
    const handler = () => { normal += 1; };
    emitter.on("normal", handler);
    emitter.emit("normal");
    emitter.removeListener("normal", handler);
    expect(normal).toBe(1);
    db.close();
  });
}

test("同步随机字节可用，异步随机字节回调使事务回滚且拒绝迟到写入", async () => {
  const { path, db } = await fixture();
  expect(db.transaction(() => randomBytes(4).length)).toBe(4);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let attempted = false;
  expect(() => unchecked(db, () => {
    db.create("probe", "before", {});
    randomBytes(8, (error) => {
      expect(error).toBeNull();
      attempted = true;
      expectUnavailable(db);
      expect(() => new LocalDatabase(path)).toThrow(DatabaseUnavailableError);
      finish();
    });
  })).toThrow(AsyncTransactionError);
  await done;
  expect(attempted).toBe(true);
  expectEmpty(path);
  db.close();
});

test("事务内EventTarget订阅也被拒绝，事务外订阅不受影响", async () => {
  const { path, db } = await fixture();
  const target = new EventTarget();
  const handler = () => db.create("probe", "late", {});
  expect(() => unchecked(db, () => {
    db.create("probe", "before", {});
    target.addEventListener("later", handler);
  })).toThrow(AsyncTransactionError);
  expect(() => target.dispatchEvent(new Event("later"))).not.toThrow();
  expectEmpty(path);
  let called = false;
  const normal = () => { called = true; };
  target.addEventListener("normal", normal);
  target.dispatchEvent(new Event("normal"));
  target.removeEventListener("normal", normal);
  expect(called).toBe(true);
  db.close();
});

for (const kind of ["async", "promise", "thenable", "promise-own-then"] as const) {
  test(`M1-AC10：${kind} 的await前后及定时写入全部失效，旧连接不可重用`, async () => {
    const { path, db } = await fixture();
    let late!: Promise<void>;
    const attempted: string[] = [];
    const operation = () => {
      db.create("probe", "before", {});
      db.append("probe", { point: "before" });
      late = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        attempted.push("after-await");
        expectUnavailable(db);
        await new Promise((resolve) => setTimeout(resolve, 20));
        attempted.push("timer");
        expectUnavailable(db);
      })();
      if (kind === "thenable") return { then(resolve: () => void, reject: (error: unknown) => void) { void late.then(resolve, reject); } };
      if (kind === "promise-own-then") Object.defineProperty(late, "then", { get() { throw new Error("不得调用不可信的then getter"); } });
      return late;
    };
    try {
      expect(() => unchecked(db, kind === "async" ? async () => await operation() : operation)).toThrow(AsyncTransactionError);
      expectUnavailable(db);
      // await 原生Promise不通过其自定义then；确实等到延迟代码全部执行才检查另一个连接。
      await late;
      expect(attempted).toEqual(["after-await", "timer"]);
      expectEmpty(path);
      db.close(); db.close();
      expectUnavailable(db);
    } finally { db.close(); }
  });
}

for (const source of ["promise", "timer", "nextTick"] as const) {
  test(`M1-AC10：未返回的${source}延续使原事务拒绝，并阻断旧连接和换连接`, async () => {
    const { path, db } = await fixture();
    const latePath = join(path, "..", `late-${source}.db`);
    const errors: unknown[] = [];
    let continued!: () => void;
    const finished = new Promise<void>((resolve) => { continued = () => {
      for (const action of [
        () => db.read("probe", "before"),
        () => db.create("probe", "late", {}),
        () => db.append("probe", { point: "late" }),
        () => db.transaction(() => undefined),
        () => { const replacement = new LocalDatabase(latePath); replacement.close(); },
      ]) {
        try { action(); } catch (error) { errors.push(error); }
      }
      resolve();
    }; });

    try {
      expect(() => db.transaction(() => {
        db.create("probe", "before", {});
        db.append("probe", { point: "before" });
        if (source === "promise") void Promise.resolve().then(continued);
        else if (source === "timer") setTimeout(continued, 10);
        else process.nextTick(continued);
        // 回调故意返回void；运行时必须发现其创建的异步来源。
      })).toThrow(AsyncTransactionError);
      await finished;
      expect(errors).toHaveLength(5);
      expect(errors.every((error) => error instanceof DatabaseUnavailableError)).toBe(true);
      expect(existsSync(latePath)).toBe(false);
      expectEmpty(path);
      const recovered = new LocalDatabase(path);
      try {
        recovered.transaction(() => recovered.create("probe", "recovered", {}));
        expect(recovered.read("probe", "recovered")).not.toBeNull();
      } finally { recovered.close(); }
    } finally { db.close(); }
  });
}

test("事务外预先创建的返回Promise迟到拒绝被局部处理", async () => {
  const { path, db } = await fixture();
  db.close();
  const result = await isolatedProbe(`
const path = ${JSON.stringify(path)};
const db = new LocalDatabase(path);
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error instanceof Error ? error.message : String(error)));
let rejectReturned;
const returned = new Promise((_resolve, reject) => { rejectReturned = reject; });
setTimeout(() => rejectReturned(new Error("late precreated rejection")), 20);
let category;
try {
  db.transaction(() => {
    db.create("probe", "before", {});
    db.append("probe", { point: "before" });
    return returned;
  });
} catch (error) { category = error instanceof AsyncTransactionError ? error.name : "unexpected"; }
let oldConnection;
try { db.create("probe", "after", {}); } catch (error) { oldConnection = error instanceof DatabaseUnavailableError; }
await new Promise((resolve) => setTimeout(resolve, 60));
const outside = new LocalDatabase(path);
const beforeOutside = { records: outside.list("probe").map((row) => row.key), events: outside.events("probe").map((event) => event.data) };
outside.transaction(() => outside.create("probe", "outside", {}));
const outsideRecord = outside.read("probe", "outside") !== null;
outside.close(); db.close();
console.log(JSON.stringify({ category, oldConnection, unhandled, beforeOutside, outsideRecord }));
`);
  expect(result).toEqual({
    category: "AsyncTransactionError",
    oldConnection: true,
    unhandled: [],
    beforeOutside: { records: [], events: [] },
    outsideRecord: true,
  });
});

test("vm上下文原生Promise的未返回延续保持事务来源隔离", async () => {
  const { path, db } = await fixture();
  db.close();
  const latePath = join(path, "..", "vm-origin-new.db");
  const result = await isolatedProbe(`
const path = ${JSON.stringify(path)};
const latePath = ${JSON.stringify(latePath)};
const db = new LocalDatabase(path);
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error instanceof Error ? error.name : String(error)));
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
let attempts = 0;
const blocked = [];
const attempted = (action) => () => {
  attempts++;
  try { action(); }
  catch (error) { blocked.push(error instanceof DatabaseUnavailableError); throw error; }
};
const done = () => { if (--remaining === 0) finish(); };
let remaining = 3;
let category;
try {
  db.transaction(() => {
    db.create("probe", "before", {});
    db.append("probe", { point: "before" });
    runInNewContext(` + "`" + `
      void Promise.resolve().then(oldRecord).finally(done);
      void Promise.resolve().then(oldEvent).finally(done);
      void Promise.resolve().then(newConnection).finally(done);
    ` + "`" + `, {
      oldRecord: attempted(() => db.create("probe", "after", {})),
      oldEvent: attempted(() => db.append("probe", { point: "after" })),
      newConnection: attempted(() => new LocalDatabase(latePath)),
      done,
    });
  });
} catch (error) { category = error instanceof AsyncTransactionError ? error.name : "unexpected"; }
await finished;
await new Promise((resolve) => setTimeout(resolve, 30));
let oldConnection;
try { db.read("probe", "before"); } catch (error) { oldConnection = error instanceof DatabaseUnavailableError; }
const outside = new LocalDatabase(path);
const beforeOutside = { records: outside.list("probe").map((row) => row.key), events: outside.events("probe").map((event) => event.data) };
outside.transaction(() => outside.create("probe", "outside", {}));
const outsideRecord = outside.read("probe", "outside") !== null;
outside.close(); db.close();
console.log(JSON.stringify({ category, attempts, blocked, oldConnection, sourceConnectionCreated: existsSync(latePath), unhandled, beforeOutside, outsideRecord }));
`);
  expect(result).toEqual({
    category: "AsyncTransactionError",
    attempts: 3,
    blocked: [true, true, true],
    oldConnection: true,
    sourceConnectionCreated: false,
    unhandled: [],
    beforeOutside: { records: [], events: [] },
    outsideRecord: true,
  });
});

test("未返回Promise中的失效写入拒绝被局部处理，不产生无关未处理拒绝", async () => {
  const { path, db } = await fixture();
  const unhandled: unknown[] = [];
  const handler = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", handler);
  let attempted = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  try {
    expect(() => db.transaction(() => {
      db.create("probe", "before", {});
      void Promise.resolve().then(() => {
        attempted = true;
        db.create("probe", "late", {});
      }).finally(finish);
    })).toThrow(AsyncTransactionError);
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempted).toBe(true);
    expect(unhandled).toEqual([]);
    expectEmpty(path);
  } finally { process.off("unhandledRejection", handler); db.close(); }
});

test("thenable只读取一次then且在失效后才执行，迟到拒绝不产生未处理异常", async () => {
  const { path, db } = await fixture();
  let getCount = 0;
  let continued = false;
  let replacementError: unknown;
  const latePath = join(path, "..", "late-thenable.db");
  const unhandled: unknown[] = [];
  const handler = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", handler);
  try {
    const thenable = { get then() {
      getCount++;
      return (_resolve: unknown, reject: (error: unknown) => void) => {
        expectUnavailable(db);
        setTimeout(() => {
          continued = true;
          try { new LocalDatabase(latePath); } catch (error) { replacementError = error; }
          reject(new Error("late fixture rejection"));
        }, 10);
      };
    } };
    expect(() => unchecked(db, () => thenable)).toThrow(AsyncTransactionError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getCount).toBe(1); expect(continued).toBe(true); expect(unhandled).toEqual([]);
    expect(replacementError).toBeInstanceOf(DatabaseUnavailableError);
    expect(existsSync(latePath)).toBe(false);
    expectEmpty(path);
  } finally { process.off("unhandledRejection", handler); db.close(); }
});

test("async延续直接抛出失效错误也被接住，不投递失败事务事件", async () => {
  const { path, db } = await fixture();
  let attempted = false;
  const unhandled: unknown[] = [];
  const handler = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", handler);
  try {
    expect(() => unchecked(db, async () => {
      db.append("probe", { point: "before" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      attempted = true;
      db.append("probe", { point: "after" });
    })).toThrow(AsyncTransactionError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(attempted).toBe(true); expect(unhandled).toEqual([]); expectEmpty(path);
  } finally { process.off("unhandledRejection", handler); db.close(); }
});

test("M1-AC11：正常提交、业务异常及过期版本回滚后合法连接仍可用", async () => {
  const { db } = await fixture();
  try {
    db.transaction(() => { db.create("probe", "saved", { value: 1 }); db.append("probe", { point: "committed" }); });
    expect(() => db.transaction(() => { db.create("probe", "rolled-back", {}); db.append("probe", {}); throw new Error("business failure"); })).toThrow("business failure");
    expect(() => db.transaction(() => { db.append("probe", {}); db.update("probe", "saved", 0, {}); })).toThrow(StaleVersionError);
    expect(db.list("probe").map((record) => record.key)).toEqual(["saved"]);
    expect(db.events("probe").map((event) => event.data)).toEqual([{ point: "committed" }]);
    db.transaction(() => db.update("probe", "saved", 1, { value: 2 }));
    expect(db.read("probe", "saved")?.version).toBe(2);
  } finally { db.close(); }
});

for (const fault of ["rollback", "close", "both"] as const) {
  test(`违规事务${fault}清理失败仍封禁连接，重复清理后另一连接无残留`, async () => {
    const { path, db } = await fixture();
    const exec = DatabaseSync.prototype.exec;
    const close = DatabaseSync.prototype.close;
    let error: unknown;
    let continued = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql === "ROLLBACK" && fault !== "close") throw new Error("injected rollback failure");
      return exec.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function () {
      if (fault !== "rollback") throw new Error("injected close failure");
      return close.call(this);
    });
    try {
      try { unchecked(db, async () => {
        db.create("probe", "before", {}); db.append("probe", {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        continued = true;
        db.create("probe", "late", {});
      }); } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(AsyncTransactionError);
      expect((error as AsyncTransactionError).cleanupErrors).toHaveLength(fault === "both" ? 2 : 1);
      expectUnavailable(db);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(continued).toBe(true);
    } finally { vi.restoreAllMocks(); db.close(); db.close(); }
    expectUnavailable(db); expectEmpty(path);
    const replacement = new LocalDatabase(path);
    try { replacement.transaction(() => replacement.create("probe", "new-operation", {})); }
    finally { replacement.close(); }
  });
}

test("withDatabase收尾失败不覆盖异步违规类别或恢复连接权限", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "wrapper-safety-")); roots.push(root);
  const path = join(root, "data.db");
  let captured!: LocalDatabase;
  let failure: unknown;
  try {
    withDatabase(path, (db) => {
      captured = db;
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(() => { throw new Error("injected close failure"); });
      unchecked(db, () => { db.create("probe", "before", {}); return Promise.reject(new Error("late fixture")); });
    });
  } catch (error) { failure = error; }
  finally { vi.restoreAllMocks(); captured.close(); }
  expect(failure).toBeInstanceOf(AsyncTransactionError);
  expect((failure as AsyncTransactionError).cleanupErrors).toHaveLength(2);
  expectUnavailable(captured); expectEmpty(path);
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("业务异常的ROLLBACK失败保留原始原因并封禁连接，不报成功", async () => {
  const { path, db } = await fixture();
  const original = new Error("original business failure");
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure");
    return exec.call(this, sql);
  });
  try {
    let error: unknown;
    try { db.transaction(() => { db.create("probe", "before", {}); throw original; }); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(TransactionCleanupError);
    expect((error as Error).cause).toBe(original); expectUnavailable(db);
  } finally { vi.restoreAllMocks(); db.close(); }
  expectEmpty(path);
});
