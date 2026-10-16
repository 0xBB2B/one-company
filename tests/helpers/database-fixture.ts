import { readFileSync } from "node:fs";
import { sessionFilePath } from "../../src/modules/agents/session-records.ts";
import { DatabaseSync as Database } from "node:sqlite";
import { createHash } from "node:crypto";
import { readRecord, putRecord, uuidv7, withDatabase, repositoryDatabase } from "../../src/core/storage/database.ts";
import type { RecordRef } from "../../src/core/storage/database.ts";

export function testRepoId(label = uuidv7()): string {
  return createHash("sha256").update(label).digest("hex");
}

export function recordJson(ref: RecordRef): string {
  const record = readRecord(ref);
  if (!record.exists) throw new Error("测试记录不存在");
  return JSON.stringify({ version: record.version, data: record.data });
}

export function mutateRecord(ref: RecordRef, mutate: (data: Record<string, unknown>) => void): void {
  const record = readRecord<Record<string, unknown>>(ref);
  if (!record.exists) throw new Error("测试记录不存在");
  mutate(record.data);
  putRecord(ref, record.data);
}

export function deleteRecord(ref: RecordRef): void {
  withDatabase(ref.database, (db) => {
    const record = db.read(ref.namespace, ref.key);
    if (record) db.remove(ref.namespace, ref.key, record.version);
  });
}

export function sessionJson(ref: { dataRoot: string; repoId: string; runId: string }): string {
  return readFileSync(sessionFilePath(ref), "utf8");
}

export function failDatabaseWrites(path: string, table: "records" | "events", field: string, value: string): () => void {
  const db = new Database(path);
  const suffix = uuidv7().replaceAll("-", "");
  const names = ["INSERT", "UPDATE", "DELETE"].map((operation) => ({ operation, name: `reject_${suffix}_${operation}` }));
  try {
    for (const { operation, name } of names) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} WHEN ${row}.${field} = '${value.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT, '测试数据库拒绝写入'); END`);
    }
  } finally { db.close(); }
  return () => {
    const db = new Database(path);
    try { for (const { name } of names) db.exec(`DROP TRIGGER ${name}`); } finally { db.close(); }
  };
}
