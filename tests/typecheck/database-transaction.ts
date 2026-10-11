import type { LocalDatabase } from "../../runtime/database.ts";

// 由 typecheck 编译，不执行数据库操作。
export function checkTransactionTypes(db: LocalDatabase, thenable: PromiseLike<void>) {
  const result: number = db.transaction(() => 42);
  db.transaction(() => undefined);
  db.transaction(() => ({ then: "ordinary field", result }));
  // @ts-expect-error async 回调不是同步事务
  db.transaction(async () => 42);
  // @ts-expect-error 普通函数返回 Promise 同样违规
  db.transaction(() => Promise.resolve(42));
  // @ts-expect-error 自定义 thenable 不得作为事务结果
  db.transaction(() => thenable);
}
