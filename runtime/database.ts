import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { isPromise } from "node:util/types";
import { assertDatabasePathReady, assertRegularDatabaseFiles, databaseKind, DATABASE_APPLICATION_IDS, DatabaseStorageError } from "./database-paths.ts";
import { createTransactionOrigin, finishTransactionOrigin, hasInvalidTransactionOrigin, invalidateTransactionOrigin, observeRejectedPromise, runOutsideTransactionOrigin, runWithTransactionOrigin, transactionOriginHasAsyncWork } from "./transaction-context.ts";
export { repositoryDatabase, globalDatabase, indexDatabase, databaseFile } from "./database-paths.ts";

export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type SqlValue = string | number | bigint | null | Uint8Array;
interface Statement {
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
  run(...params: SqlValue[]): { changes: number | bigint };
}
interface Connection {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const require = createRequire(import.meta.url);
const Driver: new (path: string) => Connection = require("node:sqlite").DatabaseSync;

const DATABASE_BUSY_TIMEOUT_MS = 5_000;
const busyWait = new Int32Array(new SharedArrayBuffer(4));

// journal_mode 的锁升级可能直接返回 SQLITE_BUSY；只重试幂等配置，不重放业务事务。
function enableWal(connection: Connection): void {
  const deadline = performance.now() + DATABASE_BUSY_TIMEOUT_MS;
  try {
    for (;;) {
      const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
      connection.exec(`PRAGMA busy_timeout = ${remaining}`);
      try {
        const current = connection.prepare("PRAGMA journal_mode").get()?.journal_mode;
        if (current === "wal") return;
        const selected = connection.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
        if (selected !== "wal") throw new Error("数据库未能启用 WAL 日志模式");
        return;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        const wait = deadline - performance.now();
        if (typeof code !== "number" || (code & 0xff) !== 5 || wait <= 0) throw error;
        Atomics.wait(busyWait, 0, 0, Math.min(10, wait));
      }
    }
  } finally { connection.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`); }
}

const ID_CONSTRAINT = `length(id) = 36 AND substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND substr(id,15,1) = '7' AND substr(id,20,1) IN ('8','9','a','b') AND length(replace(id,'-','')) = 32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'`;

const INDEX_NAMESPACES = new Set(["workspaces", "index_generations", "files", "symbols", "code_edges", "features_current", "rules_current", "rule_edges_current", "code_bindings", "source_fragments", "prod_metadata"]);

export interface StoredRecord<T = unknown> {
  id: string;
  version: number;
  data: T;
}

export class StaleVersionError extends Error {
  constructor() { super("版本已变化，请重新读取后重试"); this.name = "StaleVersionError"; }
}

export class AsyncTransactionError extends Error {
  readonly code = "async_transaction";
  readonly cleanupErrors: unknown[] = [];
  constructor() {
    super("数据库事务不能执行异步操作；该连接已失效");
    this.name = "AsyncTransactionError";
  }
}

export class DatabaseUnavailableError extends Error {
  constructor() { super("数据库连接已关闭或失效，禁止继续使用"); this.name = "DatabaseUnavailableError"; }
}

export class TransactionCleanupError extends AggregateError {
  constructor(original: unknown, cleanupErrors: unknown[]) {
    super([original, ...cleanupErrors], "事务清理失败；连接已失效，实际状态需要核对", { cause: original });
    this.name = "TransactionCleanupError";
  }
}

export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export class LocalDatabase {
  private readonly connection: Connection;
  private readonly path: string;
  private inTransaction = false;
  private unavailable = false;
  private closed = false;

  private assertAvailable(): void {
    if (this.unavailable || this.closed || hasInvalidTransactionOrigin()) throw new DatabaseUnavailableError();
    assertDatabasePathReady(this.path);
  }

  private assertNamespace(namespace: string, event = false): void {
    if (databaseKind(this.path) === "index" && !(event ? namespace === "index_events" : INDEX_NAMESPACES.has(namespace))) {
      throw new DatabaseStorageError("wrong_database_kind", "索引库不能保存或读取运行状态、任务及授权");
    }
  }

  constructor(path: string) {
    // 失效事务的异步延续不能通过新连接绕过保护；必须先于路径和文件操作拒绝。
    if (hasInvalidTransactionOrigin()) throw new DatabaseUnavailableError();
    this.path = resolve(path);
    assertDatabasePathReady(this.path);
    assertRegularDatabaseFiles(this.path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.connection = new Driver(this.path);
    try {
      const kind = databaseKind(this.path);
      if (kind) {
        this.connection.exec("PRAGMA busy_timeout = 5000; BEGIN");
        let identity;
        try {
          identity = { id: Number(this.connection.prepare("PRAGMA application_id").get()?.application_id),
            version: Number(this.connection.prepare("PRAGMA user_version").get()?.user_version),
            objects: Number(this.connection.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.n) };
        } finally { this.connection.exec("ROLLBACK"); }
        if (identity.version !== 0 && identity.version !== 1) throw new Error(`不支持的数据库版本: ${identity.version}`);
        if ((identity.version === 0 && identity.objects !== 0) || (identity.id !== DATABASE_APPLICATION_IDS[kind] && (identity.id !== 0 || identity.version !== 0 || identity.objects !== 0))) {
          throw new DatabaseStorageError("wrong_database_kind", "数据库用途或版本来源不明，不自动接管或重建");
        }
      }
      chmodSync(this.path, 0o600);
      this.connection.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
      enableWal(this.connection);
      this.connection.exec("PRAGMA synchronous = FULL;");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 0 && version !== 1) throw new Error(`不支持的数据库版本: ${version}`);
      if (version === 0) this.transaction(() => {
        // 取得写锁后复核版本，不能用等待锁之前的旧版本覆盖其他进程的初始化。
        const lockedVersion = Number(this.connection.prepare("PRAGMA user_version").get()?.user_version);
        if (lockedVersion === 1) {
          if (kind && Number(this.connection.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS[kind]) throw new DatabaseStorageError("wrong_database_kind", "数据库身份已变化");
          return;
        }
        if (lockedVersion !== 0) throw new Error(`不支持的数据库版本: ${lockedVersion}`);
        this.connection.exec(`
          CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY NOT NULL CHECK (${ID_CONSTRAINT}),
            namespace TEXT NOT NULL,
            record_key TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0),
            data TEXT NOT NULL CHECK (json_valid(data)),
            UNIQUE (namespace, record_key)
          ) STRICT;
          CREATE UNIQUE INDEX IF NOT EXISTS active_requirement ON records(json_extract(data, '$.requirement'))
            WHERE namespace = 'runs' AND json_extract(data, '$.kind') = 'requirement'
            AND json_extract(data, '$.state') IN ('queued', 'running', 'pausing', 'paused', 'paused_network', 'waiting_answer');
          CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY NOT NULL CHECK (${ID_CONSTRAINT}),
            stream TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            data TEXT NOT NULL CHECK (json_valid(data)),
            UNIQUE (stream, sequence)
          ) STRICT;
          PRAGMA application_id = ${kind ? DATABASE_APPLICATION_IDS[kind] : 0};
          PRAGMA user_version = 1;
        `);
      });
      if (kind && Number(this.connection.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS[kind]) throw new DatabaseStorageError("wrong_database_kind", "数据库身份已变化");
      assertRegularDatabaseFiles(this.path);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
    } catch (error) { this.connection.close(); throw error; }
  }

  transaction<T>(fn: () => T & SyncResult<T>): T {
    this.assertAvailable();
    if (this.inTransaction) throw new Error("不允许嵌套数据库事务");
    this.connection.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    const origin = createTransactionOrigin();
    try {
      let result!: T;
      let nativePromise = false;
      let then: unknown;
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        runWithTransactionOrigin(origin, () => {
          result = fn();
          nativePromise = isPromise(result);
          then = !nativePromise && result != null ? (result as { then?: unknown }).then : undefined;
        });
      } catch (error) { callbackFailed = true; callbackError = error; }

      if (transactionOriginHasAsyncWork(origin) || nativePromise || typeof then === "function") {
        // 先撤销来源和连接能力，再回滚/关闭。来源只传播给该回调创建的异步延续。
        this.unavailable = true;
        invalidateTransactionOrigin(origin);
        if (nativePromise) {
          // 返回值可能在事务外或其他vm上下文中创建，始终只处理该返回Promise的拒绝。
          observeRejectedPromise(result as Promise<unknown>);
        } else if (typeof then === "function") {
          // 捕获已核对的 then，避免再次触发 getter；在来源之外消费迟到拒绝。
          runOutsideTransactionOrigin(() => {
            const drained = new Promise((resolve, reject) => {
              runWithTransactionOrigin(origin, () => Reflect.apply(then as Function, result, [resolve, reject]));
            });
            void drained.catch(() => {});
          });
        }
        throw new AsyncTransactionError();
      }

      finishTransactionOrigin(origin);
      if (callbackFailed) throw callbackError;
      this.assertAvailable();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      finishTransactionOrigin(origin);
      const cleanupErrors: unknown[] = [];
      try { this.connection.exec("ROLLBACK"); }
      catch (cleanupError) { this.unavailable = true; cleanupErrors.push(cleanupError); }
      if (this.unavailable) {
        try { this.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (error instanceof AsyncTransactionError) {
        error.cleanupErrors.push(...cleanupErrors);
        throw error;
      }
      if (cleanupErrors.length) throw new TransactionCleanupError(error, cleanupErrors);
      throw error;
    } finally { this.inTransaction = false; }
  }

  read<T = unknown>(namespace: string, key: string): StoredRecord<T> | null {
    this.assertAvailable();
    this.assertNamespace(namespace);
    const row = this.connection.prepare("SELECT id, version, data FROM records WHERE namespace = ? AND record_key = ?").get(namespace, key);
    return row ? { id: String(row.id), version: Number(row.version), data: JSON.parse(String(row.data)) as T } : null;
  }

  create<T>(namespace: string, key: string, data: T, id = uuidv7()): StoredRecord<T> {
    this.assertAvailable();
    this.assertNamespace(namespace);
    this.connection.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, ?, ?, 1, ?)").run(id, namespace, key, JSON.stringify(data));
    return { id, version: 1, data };
  }

  update<T>(namespace: string, key: string, version: number, data: T): number {
    this.assertAvailable();
    this.assertNamespace(namespace);
    const result = this.connection.prepare("UPDATE records SET data = ?, version = version + 1 WHERE namespace = ? AND record_key = ? AND version = ?").run(JSON.stringify(data), namespace, key, version);
    if (Number(result.changes) !== 1) throw new StaleVersionError();
    return version + 1;
  }

  remove(namespace: string, key: string, version: number): void {
    this.assertAvailable();
    this.assertNamespace(namespace);
    const result = this.connection.prepare("DELETE FROM records WHERE namespace = ? AND record_key = ? AND version = ?").run(namespace, key, version);
    if (Number(result.changes) !== 1) throw new StaleVersionError();
  }

  list<T = unknown>(namespace: string): Array<StoredRecord<T> & { key: string }> {
    this.assertAvailable();
    this.assertNamespace(namespace);
    return this.connection.prepare("SELECT id, record_key, version, data FROM records WHERE namespace = ? ORDER BY id").all(namespace)
      .map((row) => ({ id: String(row.id), key: String(row.record_key), version: Number(row.version), data: JSON.parse(String(row.data)) as T }));
  }

  append<T>(stream: string, data: T): { id: string; sequence: number; data: T } {
    this.assertAvailable();
    this.assertNamespace(stream, true);
    const insert = () => {
      const sequence = Number(this.connection.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM events WHERE stream = ?").get(stream)?.next);
      const id = uuidv7();
      this.connection.prepare("INSERT INTO events (id, stream, sequence, data) VALUES (?, ?, ?, ?)").run(id, stream, sequence, JSON.stringify(data));
      return { id, sequence, data };
    };
    return this.inTransaction ? insert() : this.transaction(insert);
  }

  events<T = unknown>(stream: string, after = 0): Array<{ id: string; sequence: number; data: T }> {
    this.assertAvailable();
    this.assertNamespace(stream, true);
    return this.connection.prepare("SELECT id, sequence, data FROM events WHERE stream = ? AND sequence > ? ORDER BY sequence").all(stream, after)
      .map((row) => ({ id: String(row.id), sequence: Number(row.sequence), data: JSON.parse(String(row.data)) as T }));
  }

  close(): void {
    this.unavailable = true;
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}

export function withDatabase<T>(path: string, fn: (db: LocalDatabase) => T): T {
  const db = new LocalDatabase(path);
  let result: T;
  try { result = fn(db); }
  catch (error) {
    try { db.close(); }
    catch (cleanupError) {
      if (error instanceof AsyncTransactionError) error.cleanupErrors.push(cleanupError);
      else throw new TransactionCleanupError(error, [cleanupError]);
    }
    throw error;
  }
  db.close();
  return result;
}

export interface RecordRef {
  database: string;
  namespace: string;
  key: string;
}

export function readRecord<T = unknown>(ref: RecordRef): { exists: false } | ({ exists: true } & StoredRecord<T>) {
  assertDatabasePathReady(ref.database);
  if (!existsSync(ref.database)) return { exists: false };
  return withDatabase(ref.database, (db) => {
    const record = db.read<T>(ref.namespace, ref.key);
    return record ? { exists: true, ...record } : { exists: false };
  });
}

export function createRecord(ref: RecordRef, data: unknown): StoredRecord {
  return withDatabase(ref.database, (db) => db.create(ref.namespace, ref.key, data));
}

export function writeRecord(ref: RecordRef, data: unknown, options: { expectedVersion: number }): { version: number } {
  return withDatabase(ref.database, (db) => ({ version: db.update(ref.namespace, ref.key, options.expectedVersion, data) }));
}

export function putRecord(ref: RecordRef, data: unknown): void {
  withDatabase(ref.database, (db) => db.transaction(() => {
    const record = db.read(ref.namespace, ref.key);
    if (record) db.update(ref.namespace, ref.key, record.version, data);
    else db.create(ref.namespace, ref.key, data);
  }));
}
