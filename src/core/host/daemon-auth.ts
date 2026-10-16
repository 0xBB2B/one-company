import { randomBytes } from "node:crypto";
import { globalDatabase, withDatabase } from "../storage/database.ts";

// 控制凭证只保存在受管命令不可读取的数据目录中，不通过环境变量或运行记录传递。
export function controlToken(dataRoot: string): string {
  return withDatabase(globalDatabase(dataRoot), (db) => db.transaction(() => {
    const existing = db.read<{ token: string }>("daemon_auth", "control");
    if (existing) {
      if (!/^[0-9a-f]{64}$/.test(existing.data.token)) throw new Error("控制凭证记录无效");
      return existing.data.token;
    }
    const token = randomBytes(32).toString("hex");
    db.create("daemon_auth", "control", { token });
    return token;
  }));
}
