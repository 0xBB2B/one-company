import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { AsyncTransactionError, DatabaseUnavailableError, LocalDatabase, StaleVersionError, TransactionCleanupError } from "../src/core/storage/database.ts";
import { DATABASE_MAINTENANCE_FILE, DATABASE_SNAPSHOT_FILE, pathExists } from "../src/core/storage/database-paths.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
const connections: LocalDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(name = "data.db") {
  const root = mkdtempSync(join(temporaryRoot(), "db-statement-cache-")); roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, name), db = new LocalDatabase(path); connections.push(db);
  return { root, path, db };
}
function open(path: string) { const db = new LocalDatabase(path); connections.push(db); return db; }
// 只用于核对缓存容量与撤销引用，不作为业务调用入口。
function cache(db: LocalDatabase) { return (db as unknown as { recordStatements: Map<string, unknown> }).recordStatements; }
function warm(db: LocalDatabase, namespace = "probe") {
  db.create(namespace, "warm", { value: 1 });
  expect(db.read(namespace, "warm")?.data).toEqual({ value: 1 });
  expect(db.list(namespace)).toHaveLength(1);
  db.update(namespace, "warm", 1, { value: 2 });
  db.remove(namespace, "warm", 2);
}
function blocked(db: LocalDatabase, category: RegExp | typeof DatabaseUnavailableError) {
  for (const action of [
    () => db.read("probe", "warm"), () => db.list("probe"), () => db.create("probe", "late", {}),
    () => db.update("probe", "warm", 1, {}), () => db.remove("probe", "warm", 1),
    () => db.append("probe", {}), () => db.events("probe"), () => db.transaction(() => undefined),
  ]) expect(action).toThrow(category);
}

test("固定记录SQL只编译五次；不同namespace/key/id/版本逐次绑定，调用数量不扩大缓存", () => {
  const { db } = fixture();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  for (let i = 0; i < 30; i++) warm(db, `namespace-${i}`);
  expect(prepare).toHaveBeenCalledTimes(5);
  expect(cache(db).size).toBe(5);
  db.create("a", "same", { value: "a" }); db.create("b", "same", { value: "b" });
  expect(db.read("a", "same")?.data).toEqual({ value: "a" });
  expect(db.read("b", "same")?.data).toEqual({ value: "b" });
  expect(db.read("a", "missing")).toBeNull();
  expect(() => db.update("a", "same", 0, {})).toThrow(StaleVersionError);
  expect(() => db.remove("b", "same", 0)).toThrow(StaleVersionError);
  expect(db.list("a").map(row => row.data)).toEqual([{ value: "a" }]);
  expect(prepare).toHaveBeenCalledTimes(5);
});

for (const marker of [DATABASE_MAINTENANCE_FILE, DATABASE_SNAPSHOT_FILE]) {
  test(`缓存命中后每次仍检查${marker}，普通文件/目录/悬空链接都拒绝`, () => {
    const { root, db } = fixture(); warm(db);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    for (const kind of ["file", "directory", "symlink"]) {
      const target = join(root, marker);
      if (kind === "file") writeFileSync(target, "fixture", { mode: 0o600 });
      else if (kind === "directory") mkdirSync(target, { mode: 0o700 });
      else symlinkSync(join(root, "missing"), target);
      blocked(db, /maintenance_required|snapshot_only/);
      rmSync(target, { recursive: kind === "directory" });
      warm(db);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
}

test("缺失探测不吞权限、非目录和链接循环错误；连接已有缓存也不能越过真实权限错误", () => {
  const { root, db } = fixture(); warm(db);
  expect(pathExists(join(root, "absent"))).toBe(false);
  const file = join(root, "file"); writeFileSync(file, "fixture");
  expect(() => pathExists(join(file, "child"))).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  const loop = join(root, "loop"); symlinkSync(loop, loop);
  expect(pathExists(loop)).toBe(true);
  expect(() => pathExists(join(loop, "child"))).toThrow(expect.objectContaining({ code: "ELOOP" }));
  chmodSync(root, 0o000);
  try {
    expect(() => pathExists(join(root, "absent"))).toThrow(expect.objectContaining({ code: "EACCES" }));
    blocked(db, /EACCES/);
  } finally { chmodSync(root, 0o700); }
  warm(db);
});

test("缓存不改变索引namespace授权及数据库/WAL/SHM权限", () => {
  const { db, path } = fixture("index.db"); warm(db, "files");
  for (const action of [() => db.create("tasks", "bad", {}), () => db.read("tasks", "bad"), () => db.list("tasks"), () => db.update("tasks", "bad", 1, {}), () => db.remove("tasks", "bad", 1)]) {
    expect(action).toThrow(/wrong_database_kind/);
  }
  for (const suffix of ["", "-wal", "-shm"]) expect(lstatSync(path + suffix).mode & 0o777).toBe(0o600);
});

test("普通事务回滚丢弃缓存但保留合法连接，另一连接观察真实提交及过期版本", () => {
  const { db, path } = fixture(); warm(db);
  const other = open(path); warm(other);
  const statements = [...cache(db).values()];
  db.transaction(() => { db.create("probe", "saved", { value: 1 }); db.append("probe", { saved: true }); });
  expect(other.read("probe", "saved")?.version).toBe(1);
  expect(() => db.transaction(() => {
    db.update("probe", "saved", 1, { value: 2 }); db.append("probe", { rolledBack: true });
    db.remove("probe", "saved", 1);
  })).toThrow(StaleVersionError);
  expect(cache(db).size).toBe(0);
  expect(other.read("probe", "saved")?.data).toEqual({ value: 1 });
  expect(other.events("probe").map(event => event.data)).toEqual([{ saved: true }]);
  other.update("probe", "saved", 1, { value: 3 });
  expect(() => db.update("probe", "saved", 1, {})).toThrow(StaleVersionError);
  expect(db.read("probe", "saved")?.data).toEqual({ value: 3 });
  for (const statement of cache(db).values()) expect(statements).not.toContain(statement);
  for (const statement of cache(other).values()) expect(statements).not.toContain(statement);
  other.close();
  expect(cache(other).size).toBe(0);
  expect(db.read("probe", "saved")?.version).toBe(2);
});

test("真实SQLite在schema变化后重新编译缓存语句，新增trigger生效，缺表报错不重建", () => {
  const { db, path } = fixture(); warm(db);
  const raw = new DatabaseSync(path);
  try {
    raw.exec("CREATE TRIGGER reject_probe BEFORE INSERT ON records WHEN new.namespace = 'probe' BEGIN SELECT raise(ABORT, 'schema trigger rejects'); END;");
    expect(() => db.create("probe", "blocked", {})).toThrow("schema trigger rejects");
    raw.exec("DROP TRIGGER reject_probe; CREATE INDEX probe_namespace ON records(namespace);");
    db.create("probe", "accepted", {});
    expect(db.read("probe", "accepted")).not.toBeNull();
    raw.exec("DROP TABLE records;");
    expect(() => db.read("probe", "accepted")).toThrow(/no such table/);
    expect(() => db.create("probe", "late", {})).toThrow(/no such table/);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='records'").get()).toBeUndefined();
    raw.exec("PRAGMA user_version=99");
  } finally { raw.close(); }
  db.close();
  expect(() => open(path)).toThrow(/不支持的数据库版本/);
});

test("锁竞争使缓存语句本次失败且不自动重试，解锁后的新调用可重新绑定", () => {
  const { db, path } = fixture(); warm(db);
  // 仅缩短测试等待；产品仍保留原来的busy_timeout。
  (db as unknown as { connection: DatabaseSync }).connection.exec("PRAGMA busy_timeout=0");
  const raw = new DatabaseSync(path);
  const run = vi.spyOn(StatementSync.prototype, "run");
  try {
    raw.exec("BEGIN IMMEDIATE");
    expect(() => db.create("probe", "locked", {})).toThrow(/locked/);
    expect(run).toHaveBeenCalledTimes(1);
    raw.exec("ROLLBACK");
    expect(db.read("probe", "locked")).toBeNull();
    db.create("probe", "new-operation", { value: "new" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(db.read("probe", "new-operation")?.data).toEqual({ value: "new" });
  } finally { raw.close(); }
});

test("参数序列化的同步重入不会覆盖外层绑定，get/all结果在后续调用后保持独立", () => {
  const { db, path } = fixture(); warm(db);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  db.create("probe", "outer", { toJSON() { db.create("probe", "inner", { value: "inner" }); return { value: "outer" }; } });
  const before = db.list("probe"), outer = db.read("probe", "outer");
  db.update("probe", "outer", 1, { toJSON() { db.update("probe", "inner", 1, { value: "inner-changed" }); return { value: "changed" }; } });
  expect(db.read("probe", "inner")?.data).toEqual({ value: "inner-changed" });
  expect(outer?.data).toEqual({ value: "outer" });
  expect(before.find(row => row.key === "outer")?.data).toEqual({ value: "outer" });
  expect(db.read("probe", "outer")?.data).toEqual({ value: "changed" });
  expect(prepare).not.toHaveBeenCalled();
  expect(cache(db).size).toBe(5);
  const other = open(path);
  expect(other.read("probe", "outer")).toMatchObject({ version: 2, data: { value: "changed" } });
  expect(other.read("probe", "inner")).toMatchObject({ version: 2, data: { value: "inner-changed" } });
});

for (const operation of ["create", "update"] as const) {
  for (const reason of ["marker", "closed", "namespace"] as const) {
    test(`${operation}入口拒绝${reason}时不执行参数toJSON`, () => {
      const { db, root } = fixture(reason === "namespace" ? "index.db" : "data.db");
      if (reason === "marker") writeFileSync(join(root, DATABASE_MAINTENANCE_FILE), "{}", { mode: 0o600 });
      if (reason === "closed") db.close();
      let serialized = false;
      const data = { toJSON() { serialized = true; return {}; } };
      const action = () => operation === "create" ? db.create("probe", "outer", data) : db.update("probe", "outer", 1, data);
      expect(action).toThrow(reason === "closed" ? DatabaseUnavailableError : reason === "marker" ? /maintenance_required/ : /wrong_database_kind/);
      expect(serialized).toBe(false);
    });
  }

  for (const revocation of ["marker", "getter-marker", "close-failure", "promise", "promise-close-failure", "thenable", "thenable-close-failure"] as const) {
    test(`${operation}序列化重入${revocation}后拒绝外层写入，另一真实连接确认无持久变更`, async () => {
      const { db, root, path } = fixture(); warm(db);
      if (operation === "update") db.create("probe", "outer", { value: "original" });
      const other = open(path);
      const observer = new DatabaseSync(path, { readOnly: true });
      const snapshot = () => ({
        records: observer.prepare("SELECT id, namespace, record_key, version, data FROM records ORDER BY id").all(),
        events: observer.prepare("SELECT id, stream, sequence, data FROM events ORDER BY id").all(),
      });
      const before = snapshot();
      const marker = revocation === "marker" || revocation === "getter-marker";
      const poison = revocation.startsWith("promise") || revocation.startsWith("thenable");
      const closeFailure = revocation.endsWith("close-failure");
      const injected = new Error("injected serialization close failure");
      const close = vi.spyOn(DatabaseSync.prototype, "close");
      if (closeFailure) close.mockImplementation(() => { throw injected; });
      const run = vi.spyOn(StatementSync.prototype, "run");
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      let serialized = 0, thenReads = 0, originAttempts = 0;
      let late: Promise<void> | undefined, innerError: unknown, outerError: unknown;
      const checkInvalidOrigin = () => {
        originAttempts++;
        let touched = false;
        const data = { toJSON() { touched = true; return {}; } };
        expect(() => operation === "create" ? other.create("probe", "late", data) : other.update("probe", "outer", 1, data)).toThrow(DatabaseUnavailableError);
        expect(touched).toBe(false);
        blocked(db, DatabaseUnavailableError);
        expect(() => new LocalDatabase(path)).toThrow(DatabaseUnavailableError);
      };
      const serialize = () => {
        serialized++;
        if (marker) writeFileSync(join(root, DATABASE_MAINTENANCE_FILE), "{}", { mode: 0o600 });
        else {
          try {
            if (!poison) db.close();
            else (db.transaction.bind(db) as (fn: () => unknown) => unknown)(() => {
              db.create("probe", "before-poison", {});
              db.append("probe", { point: "before-poison" });
              late = Promise.resolve().then(checkInvalidOrigin);
              if (revocation.startsWith("promise")) return late;
              return { get then() {
                thenReads++;
                return (_resolve: unknown, reject: (error: unknown) => void) => {
                  checkInvalidOrigin();
                  reject(new Error("controlled thenable rejection"));
                };
              } };
            });
          } catch (error) { innerError = error; }
        }
        return { value: "forbidden" };
      };
      // JSON.stringify还会调用数据属性getter；它与toJSON共享同一受控重入边界。
      const data = revocation === "getter-marker" ? { get value() { return serialize().value; } } : { toJSON: serialize };
      try {
        try {
          if (operation === "create") db.create("probe", "outer", data);
          else db.update("probe", "outer", 1, data);
        } catch (error) { outerError = error; }
        await late;
        // 在重试close或删除marker前观察，避免用后续清理掩盖已提交的越权写入。
        expect(snapshot()).toEqual(before);
        expect(outerError).toBeInstanceOf(marker ? Error : DatabaseUnavailableError);
        if (marker) expect((outerError as Error).message).toMatch(/maintenance_required/);
        expect(serialized).toBe(1);
        expect(run).toHaveBeenCalledTimes(poison ? 2 : 0);
        // poison仅为events的序号/写入编译两条语句；另两条来自上面的只读观察。
        expect(prepare).toHaveBeenCalledTimes(poison ? 4 : 2);
        if (poison) {
          expect(innerError).toBeInstanceOf(AsyncTransactionError);
          expect((innerError as AsyncTransactionError).cleanupErrors).toEqual(closeFailure ? [injected] : []);
          expect(originAttempts).toBe(revocation.startsWith("thenable") ? 2 : 1);
          expect(thenReads).toBe(revocation.startsWith("thenable") ? 1 : 0);
        } else if (closeFailure) expect(innerError).toBe(injected);
        expect(close).toHaveBeenCalledTimes(marker ? 0 : 1);
        expect(cache(db).size).toBe(marker ? 5 : 0);
        blocked(db, marker ? /maintenance_required/ : DatabaseUnavailableError);
      } finally {
        close.mockRestore();
        observer.close();
      }
      if (marker) rmSync(join(root, DATABASE_MAINTENANCE_FILE));
      else { db.close(); db.close(); blocked(db, DatabaseUnavailableError); }
      expect(other.read("probe", "before-poison")).toBeNull();
      expect(other.events("probe")).toEqual([]);
      // 恢复后的新操作由未失效连接显式发起，不重放失败的外层调用。
      other.create("probe", "new-operation", { value: "new" });
      expect(other.read("probe", "new-operation")?.data).toEqual({ value: "new" });
    });
  }
}

test("close先撤销缓存，即使原生close失败也不能调用或重开；显式清理可重复", () => {
  const { db, path } = fixture(); warm(db);
  const close = DatabaseSync.prototype.close;
  const spy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function () {
    expect(cache(db).size).toBe(0);
    throw new Error("injected close failure");
  });
  expect(() => db.close()).toThrow("injected close failure");
  blocked(db, DatabaseUnavailableError);
  spy.mockImplementation(function () { return close.call(this); });
  db.close(); db.close();
  const recovered = open(path); warm(recovered);
  expect(cache(recovered).size).toBe(5);
  blocked(db, DatabaseUnavailableError);
});

for (const fault of ["none", "rollback", "close"]) {
  test(`已热缓存的违规Promise延续与清理${fault}路径撤销引用，不遗留状态/事件或换连接补写`, async () => {
    const { db, path } = fixture(); warm(db);
    const other = open(path); warm(other);
    const exec = DatabaseSync.prototype.exec;
    const close = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
      if (sql === "ROLLBACK") {
        expect(cache(db).size).toBe(0);
        if (fault === "rollback") throw new Error("injected rollback failure");
      }
      return exec.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function () {
      expect(cache(db).size).toBe(0);
      if (fault === "close") throw new Error("injected close failure");
      return close.call(this);
    });
    let late!: Promise<void>, attempted = false, failure: unknown;
    try {
      (db.transaction.bind(db) as (fn: () => unknown) => unknown)(() => {
        db.create("probe", "before", {}); db.append("probe", {});
        late = Promise.resolve().then(() => {
          attempted = true; blocked(db, DatabaseUnavailableError); blocked(other, DatabaseUnavailableError);
          expect(() => new LocalDatabase(path)).toThrow(DatabaseUnavailableError);
        });
        return late;
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AsyncTransactionError);
    expect((failure as AsyncTransactionError).cleanupErrors).toHaveLength(fault === "none" ? 0 : 1);
    expect(cache(db).size).toBe(0);
    await late;
    expect(attempted).toBe(true);
    vi.restoreAllMocks(); db.close();
    expect(other.list("probe")).toEqual([]); expect(other.events("probe")).toEqual([]);
    warm(other);
    blocked(db, DatabaseUnavailableError);
  });
}

test("同步业务ROLLBACK失败也撤销缓存，保留原错误且不自动重试", () => {
  const { db, path } = fixture(); warm(db);
  const original = new Error("business failure"), exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (sql) {
    if (sql === "ROLLBACK") throw new Error("injected rollback failure");
    return exec.call(this, sql);
  });
  let failure: unknown;
  try { db.transaction(() => { db.create("probe", "before", {}); throw original; }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(TransactionCleanupError);
  expect((failure as Error).cause).toBe(original);
  expect(cache(db).size).toBe(0);
  blocked(db, DatabaseUnavailableError);
  vi.restoreAllMocks(); db.close();
  expect(open(path).list("probe")).toEqual([]);
});
