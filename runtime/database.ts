import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
const Driver: new (path: string) => Connection = typeof Bun === "undefined"
  ? require("node:sqlite").DatabaseSync
  : require("bun:sqlite").Database;

const ID_CONSTRAINT = `length(id) = 36 AND substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND substr(id,15,1) = '7' AND substr(id,20,1) IN ('8','9','a','b') AND length(replace(id,'-','')) = 32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'`;

export function repositoryDatabase(dataRoot: string, repoId: string): string {
  if (!/^[0-9a-f]{64}$/.test(repoId)) throw new Error("仓库身份格式无效");
  return join(dataRoot, "repos", repoId, "data.sqlite");
}

export function globalDatabase(dataRoot: string): string {
  return join(dataRoot, "global.sqlite");
}

export interface StoredRecord<T = unknown> {
  id: string;
  version: number;
  data: T;
}

export class StaleVersionError extends Error {
  constructor() { super("版本已变化，请重新读取后重试"); this.name = "StaleVersionError"; }
}

export class LocalDatabase {
  private readonly connection: Connection;
  private inTransaction = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (!lstatSync(path).isFile()) throw new Error("数据库必须是普通文件，禁止符号链接或目录");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.connection = new Driver(path);
    try {
      chmodSync(path, 0o600);
      this.connection.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const version = Number(this.connection.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== 0 && version !== 1) throw new Error(`不支持的数据库版本: ${version}`);
      if (version === 0) this.transaction(() => {
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
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) { this.connection.close(); throw error; }
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error("不允许嵌套数据库事务");
    this.connection.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("数据库事务不能执行异步操作");
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    } finally { this.inTransaction = false; }
  }

  read<T = unknown>(namespace: string, key: string): StoredRecord<T> | null {
    const row = this.connection.prepare("SELECT id, version, data FROM records WHERE namespace = ? AND record_key = ?").get(namespace, key);
    return row ? { id: String(row.id), version: Number(row.version), data: JSON.parse(String(row.data)) as T } : null;
  }

  create<T>(namespace: string, key: string, data: T, id = uuidv7()): StoredRecord<T> {
    this.connection.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, ?, ?, 1, ?)").run(id, namespace, key, JSON.stringify(data));
    return { id, version: 1, data };
  }

  update<T>(namespace: string, key: string, version: number, data: T): number {
    const result = this.connection.prepare("UPDATE records SET data = ?, version = version + 1 WHERE namespace = ? AND record_key = ? AND version = ?").run(JSON.stringify(data), namespace, key, version);
    if (Number(result.changes) !== 1) throw new StaleVersionError();
    return version + 1;
  }

  remove(namespace: string, key: string, version: number): void {
    const result = this.connection.prepare("DELETE FROM records WHERE namespace = ? AND record_key = ? AND version = ?").run(namespace, key, version);
    if (Number(result.changes) !== 1) throw new StaleVersionError();
  }

  list<T = unknown>(namespace: string): Array<StoredRecord<T> & { key: string }> {
    return this.connection.prepare("SELECT id, record_key, version, data FROM records WHERE namespace = ? ORDER BY id").all(namespace)
      .map((row) => ({ id: String(row.id), key: String(row.record_key), version: Number(row.version), data: JSON.parse(String(row.data)) as T }));
  }

  append<T>(stream: string, data: T): { id: string; sequence: number; data: T } {
    const insert = () => {
      const sequence = Number(this.connection.prepare("SELECT coalesce(max(sequence), 0) + 1 AS next FROM events WHERE stream = ?").get(stream)?.next);
      const id = uuidv7();
      this.connection.prepare("INSERT INTO events (id, stream, sequence, data) VALUES (?, ?, ?, ?)").run(id, stream, sequence, JSON.stringify(data));
      return { id, sequence, data };
    };
    return this.inTransaction ? insert() : this.transaction(insert);
  }

  events<T = unknown>(stream: string, after = 0): Array<{ id: string; sequence: number; data: T }> {
    return this.connection.prepare("SELECT id, sequence, data FROM events WHERE stream = ? AND sequence > ? ORDER BY sequence").all(stream, after)
      .map((row) => ({ id: String(row.id), sequence: Number(row.sequence), data: JSON.parse(String(row.data)) as T }));
  }

  close(): void { this.connection.close(); }
}

export function withDatabase<T>(path: string, fn: (db: LocalDatabase) => T): T {
  const db = new LocalDatabase(path);
  try { return fn(db); } finally { db.close(); }
}

export interface RecordRef {
  database: string;
  namespace: string;
  key: string;
}

export function readRecord<T = unknown>(ref: RecordRef): { exists: false } | ({ exists: true } & StoredRecord<T>) {
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
