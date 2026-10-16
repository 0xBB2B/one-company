import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repositoryDatabase, uuidv7 } from "../src/core/storage/database.ts";
import { assertRegularDatabaseFiles } from "../src/core/storage/database-paths.ts";
import { createSessionManagerForRun, readSessionEntries } from "../src/modules/agents/session-records.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const suffix of ["-wal", "-shm"]) for (const detached of [false, true]) {
  test(`SQLite在${suffix}检查中关闭最后连接（${detached ? "已删除文件的元数据" : "删除前的元数据"}）：会话仍可读取并继续显示新增内容`, async () => {
    const dataRoot = await mkdtemp(join(temporaryRoot(), "session-file-race-"));
    roots.push(dataRoot);
    const ctx = { dataRoot, repoId: "a".repeat(64), runId: uuidv7(), cwd: dataRoot };
    const manager = createSessionManagerForRun(ctx);
    manager.appendMessage({ role: "user", content: "已有会话内容", timestamp: Date.now() });
    const path = repositoryDatabase(dataRoot, ctx.repoId);
    const holder = new DatabaseSync(path);
    holder.exec("SELECT count(*) FROM records");
    expect(fs.existsSync(path + suffix)).toBe(true);
    let released = false;
    const original = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const result = original(...args);
      if (String(args[0]) === path + suffix && !released) {
        const fd = fs.openSync(path + suffix, "r");
        try {
          holder.close();
          released = true;
          // 由SQLite自己删除附属文件；真实fd可取得并发删除后的零链接元数据。
          expect(fs.existsSync(path + "-wal")).toBe(false);
          expect(fs.existsSync(path + "-shm")).toBe(false);
          if (detached) {
            const removed = fs.fstatSync(fd);
            expect(removed.nlink).toBe(0);
            return removed;
          }
        } finally { fs.closeSync(fd); }
      }
      return result;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try {
      const texts = () => { const read = readSessionEntries(ctx); return read.ok ? read.entries.flatMap((entry) => entry.type === "message" ? [JSON.stringify(entry.message.content)] : []) : read; };
      const first = texts();
      expect(released).toBe(true);
      expect(first).toEqual([JSON.stringify("已有会话内容")]);
      manager.appendMessage({ role: "user", content: "后续新增标记", timestamp: Date.now() });
      expect(texts()).toEqual([JSON.stringify("已有会话内容"), JSON.stringify("后续新增标记")]);
    } finally { if (!released) holder.close(); }
  });
}

test("已删除主库的零链接元数据仍被拒绝", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "database-removed-"));
  roots.push(root);
  const path = join(root, "data.db");
  fs.writeFileSync(path, "fixture");
  const fd = fs.openSync(path, "r");
  try {
    fs.unlinkSync(path);
    const removed = fs.fstatSync(fd);
    expect(removed.nlink).toBe(0);
    const original = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      return String(args[0]) === path ? removed : original(...args);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    expect(() => assertRegularDatabaseFiles(path)).toThrow(/invalid_database_file/);
  } finally { fs.closeSync(fd); }
});

for (const suffix of ["", "-wal", "-shm"]) {
  test(`主库和附属文件${suffix}的硬链接仍被拒绝`, async () => {
    const root = await mkdtemp(join(temporaryRoot(), "database-hardlink-"));
    roots.push(root);
    const path = join(root, "data.db"), outside = join(root, "outside");
    fs.writeFileSync(outside, "must-preserve");
    fs.linkSync(outside, path + suffix);
    expect(() => assertRegularDatabaseFiles(path)).toThrow(/invalid_database_file/);
    expect(fs.readFileSync(outside, "utf8")).toBe("must-preserve");
  });
}

for (const code of ["EACCES", "EIO"]) {
  test(`文件检查的${code}错误仍明确拒绝，不当成文件不存在`, async () => {
    const root = await mkdtemp(join(temporaryRoot(), "session-file-error-"));
    roots.push(root);
    const path = join(root, "data.db");
    const original = fs.lstatSync;
    const error = Object.assign(new Error(`injected ${code}`), { code });
    vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === path + "-wal") throw error;
      return original(...args);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    expect(() => assertRegularDatabaseFiles(path)).toThrow(error);
  });
}
