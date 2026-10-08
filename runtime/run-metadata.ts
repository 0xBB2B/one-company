import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS, DATABASE_SCHEMA_VERSIONS } from "./database-paths.ts";
import { createTransactionOrigin, finishTransactionOrigin, hasInvalidTransactionOrigin, invalidateTransactionOrigin, observeRejectedPromise, runOutsideTransactionOrigin, runWithTransactionOrigin, transactionOriginHasAsyncWork } from "./transaction-context.ts";
import type { SyncResult } from "./database.ts";

/** 现存运行库的SQLite只读连接：不创建主库/目录、不升级或chmod；WAL附属文件按驱动读协议管理。 */
export function withReadOnlyDatabase<T>(path: string, read: (db: DatabaseSync) => T & SyncResult<T>): T {
  if (hasInvalidTransactionOrigin()) throw new Error("运行库不可读");
  const check = () => {
    assertDatabasePathReady(path);
    assertRegularDatabaseFiles(path);
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) throw new Error("运行库权限无效");
    for (const suffix of ["", "-wal", "-shm"]) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (!stat && suffix === "") throw new Error("运行库尚未初始化");
      if (stat && (stat.mode & 0o077)) throw new Error("运行库权限无效");
    }
    return lstatSync(path);
  };
  try {
    const before = check();
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const origin = createTransactionOrigin();
    try {
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== DATABASE_SCHEMA_VERSIONS.data) throw new Error("运行库身份无效");
      let result!: T;
      let nativePromise = false;
      let then: unknown;
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        runWithTransactionOrigin(origin, () => {
          result = read(db);
          nativePromise = isPromise(result);
          then = !nativePromise && result != null ? (result as { then?: unknown }).then : undefined;
        });
      } catch (error) { callbackFailed = true; callbackError = error; }
      if (transactionOriginHasAsyncWork(origin) || nativePromise || typeof then === "function") {
        invalidateTransactionOrigin(origin);
        if (nativePromise) observeRejectedPromise(result as Promise<unknown>);
        else if (typeof then === "function") runOutsideTransactionOrigin(() => {
          const drained = new Promise((resolve, reject) => {
            runWithTransactionOrigin(origin, () => Reflect.apply(then as Function, result, [resolve, reject]));
          });
          void drained.catch(() => {});
        });
        throw new Error("运行库读取必须同步完成");
      }
      if (callbackFailed) throw callbackError;
      const after = check();
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("运行库身份已变化");
      return result;
    } finally { finishTransactionOrigin(origin); db.close(); }
  } catch { throw new Error("运行库尚未初始化、不可读或需要维护核对"); }
}
