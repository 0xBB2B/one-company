import { afterEach, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalDatabase, StaleVersionError, UUID_V7_PATTERN, uuidv7 } from "../runtime/database.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(temporaryRoot(), "sqlite-")); dirs.push(dir);
  return { dir, path: join(dir, "data.sqlite") };
}

test("UUIDv7 主键包含时间且批量生成不重复", () => {
  const before = Date.now();
  const ids = Array.from({ length: 10000 }, uuidv7);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(UUID_V7_PATTERN.test(id)).toBe(true);
  expect(parseInt(ids[0]!.replaceAll("-", "").slice(0, 12), 16)).toBeGreaterThanOrEqual(before);
});

test("数据库拒绝非 UUIDv7 主键、重复业务标识和过期版本", async () => {
  const { path } = await fixture();
  const db = new LocalDatabase(path);
  try {
    expect(() => db.create("tasks", "T-1", {}, "bad-id")).toThrow();
    const record = db.create("tasks", "T-1", { progress: "todo" });
    expect(record.id).toMatch(UUID_V7_PATTERN);
    expect(() => db.create("tasks", "T-1", {})).toThrow();
    db.update("tasks", "T-1", record.version, { progress: "doing" });
    expect(() => db.update("tasks", "T-1", record.version, { progress: "done" })).toThrow(StaleVersionError);
    expect(db.read("tasks", "T-1")?.data).toEqual({ progress: "doing" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally { db.close(); }
});

test("事务失败回滚全部记录与事件，异步事务被拒绝", async () => {
  const { path } = await fixture();
  const db = new LocalDatabase(path);
  try {
    expect(() => db.transaction(() => {
      db.create("runs", "a", {}); db.append("notices", { text: "test" }); throw new Error("中断");
    })).toThrow("中断");
    expect(db.list("runs")).toEqual([]);
    expect(db.events("notices")).toEqual([]);
    expect(() => db.transaction(() => Promise.resolve())).toThrow("异步操作");
  } finally { db.close(); }
});

test("Node 与 Bun 多进程共享 SQLite，追加序号连续且记录不丢失", async () => {
  const { dir, path } = await fixture();
  const script = join(dir, "writer.mjs");
  await writeFile(script, `import { LocalDatabase } from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).pathname)};\nconst db = new LocalDatabase(process.argv[2]);\ntry { for (let i = 0; i < 30; i++) db.append("shared", { pid: process.pid, i }); } finally { db.close(); }\n`);
  await Promise.all([exec("node", [script, path]), exec(process.execPath, [script, path]), exec("node", [script, path])]);
  const db = new LocalDatabase(path);
  try {
    const events = db.events("shared");
    expect(events).toHaveLength(90);
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(90);
  } finally { db.close(); }
});

test("提交前强杀写入进程，重开数据库后保留历史并回滚整笔事务", async () => {
  const { dir, path } = await fixture();
  const initial = new LocalDatabase(path);
  initial.create("tasks", "T-1", { progress: "todo" });
  initial.append("shared", { state: "committed" });
  initial.close();
  const script = join(dir, "interrupted-writer.mjs");
  await writeFile(script, `import { LocalDatabase } from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).pathname)};
const db = new LocalDatabase(process.argv[2]);
db.transaction(() => {
  db.update("tasks", "T-1", 1, { progress: "done" });
  db.create("tasks", "T-2", {});
  db.append("shared", { state: "uncommitted" });
  process.stdout.write("READY\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
`);
  const writer = spawn("node", [script, path], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>((resolve) => writer.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("写入进程未进入事务")), 3000);
      writer.once("error", (error) => { clearTimeout(timer); reject(error); });
      writer.once("exit", () => { clearTimeout(timer); reject(new Error("写入进程提前退出")); });
      writer.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        if (chunk.toString().trim() === "READY") resolve();
        else reject(new Error("写入进程未确认事务已写入"));
      });
    });
    writer.kill("SIGKILL");
    await exited;
    const reopened = new LocalDatabase(path);
    try {
      expect(reopened.read("tasks", "T-1")?.data).toEqual({ progress: "todo" });
      expect(reopened.read("tasks", "T-2")).toBeNull();
      expect(reopened.events("shared").map((event) => event.data)).toEqual([{ state: "committed" }]);
      expect(reopened.append("shared", { state: "after-restart" }).sequence).toBe(2);
    } finally { reopened.close(); }
  } finally {
    writer.kill("SIGKILL");
    await exited;
  }
}, 5000);
