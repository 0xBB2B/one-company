import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPromise } from "node:util/types";
import { assertDatabasePathReady, assertRegularDatabaseFiles, DATABASE_APPLICATION_IDS } from "./database-paths.ts";
import { createTransactionOrigin, finishTransactionOrigin, hasInvalidTransactionOrigin, invalidateTransactionOrigin, observeRejectedPromise, runOutsideTransactionOrigin, runWithTransactionOrigin, transactionOriginHasAsyncWork } from "./transaction-context.ts";
import type { SyncResult } from "./database.ts";

const METADATA_LIMIT = 100;
const METADATA_BYTES = 16_384;

/** 非 UUID 的需求 ID 视为未知记录，只做长度校验，不据此推断任何授权。 */
export function assertRecordRequirementId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 128) throw new Error("需求身份无效");
}

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
      if (Number(db.prepare("PRAGMA application_id").get()?.application_id) !== DATABASE_APPLICATION_IDS.data || Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 1) throw new Error("运行库身份无效");
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

export interface MetadataPageOptions { limit?: number; offset?: number; byteLimit?: number }
export function checkedMetadataPage(options: MetadataPageOptions) {
  const { limit = METADATA_LIMIT, offset = 0, byteLimit = METADATA_BYTES } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > METADATA_LIMIT || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLimit) || byteLimit < 2048 || byteLimit > METADATA_BYTES) throw new Error("元数据分页参数无效");
  return { limit, offset, byteLimit };
}
/** 只控制展示；停止遍历不使用此分页。unknown记录只计数，不回传未验证的键。 */
export function metadataPage<T>(items: T[], options: MetadataPageOptions, unknown = 0, unconfirmed = false) {
  const { limit, offset, byteLimit } = checkedMetadataPage(options);
  const selected: T[] = []; let bytes = 1024;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > byteLimit) break;
    selected.push(item); bytes += size;
  }
  const remaining = Math.max(0, items.length - offset - selected.length);
  return { items: selected, coverage: { total: items.length + unknown, validated: items.length, returned: selected.length, offset,
    remaining, unknown, truncated: remaining > 0 || offset > 0 || unknown > 0, nextOffset: remaining > 0 ? offset + selected.length : null,
    byteLimit, ...(unconfirmed ? { unconfirmed: items.length + unknown, unconfirmedOutsidePage: items.length + unknown - selected.length, notice: "状态记录不是进程停止证明；未展示项和未知项仍需核对" } : { notice: "仅运行状态元数据，不证明当前授权或验收；未知项已保全待核对" }) } };
}
