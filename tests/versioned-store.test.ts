import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalDatabase, createRecord, readRecord, writeRecord, StaleVersionError } from "../runtime/database.ts";
import { writeFileAtomic } from "../runtime/store.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(temporaryRoot(), "store-")); roots.push(root);
  return { root, database: join(root, "data.db"), namespace: "state", key: "requirement" };
}

test("未创建记录的读取无磁盘副作用；首次创建与重复创建具有唯一语义", async () => {
  const ref = await fixture();
  expect(readRecord(ref)).toEqual({ exists: false });
  expect(await readdir(ref.root)).toEqual([]);
  createRecord(ref, { stage: "draft" });
  expect(() => createRecord(ref, {})).toThrow();
  expect(readRecord(ref)).toMatchObject({ exists: true, version: 1, data: { stage: "draft" } });
});

test("过期版本拒绝且原内容完整；不同记录不会被覆盖", async () => {
  const ref = await fixture();
  createRecord(ref, { stage: "draft" });
  createRecord({ ...ref, key: "other" }, { stage: "accepted" });
  writeRecord(ref, { stage: "confirmed" }, { expectedVersion: 1 });
  expect(() => writeRecord(ref, { stage: "lost" }, { expectedVersion: 1 })).toThrow(StaleVersionError);
  expect(readRecord(ref)).toMatchObject({ version: 2, data: { stage: "confirmed" } });
  expect(readRecord({ ...ref, key: "other" })).toMatchObject({ version: 1, data: { stage: "accepted" } });
});

test("未提交事务被强杀后全部回滚；已提交记录与序号保留且可继续写入", async () => {
  const ref = await fixture();
  const script = join(ref.root, "crash.mjs");
  await writeFile(script, `import { LocalDatabase } from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).pathname)};
import { writeSync } from "node:fs";
const db = new LocalDatabase(process.argv[2]);
db.append("history", { committed: true });
db.transaction(() => {
  db.create("state", "partial", { visible: false });
  db.append("history", { committed: false });
  writeSync(1, "ready\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
`);
  const child = spawn(process.execPath, [script, ref.database], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("写入进程未确认事务已写入")), 3000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("写入进程提前退出")); });
      child.stdout.once("data", (chunk) => { clearTimeout(timer); resolve(chunk.toString()); });
    });
    expect(ready).toContain("ready");
    child.kill("SIGKILL");
    await exited;
    const db = new LocalDatabase(ref.database);
    try {
      expect(db.read("state", "partial")).toBeNull();
      expect(db.events("history").map((event) => event.data)).toEqual([{ committed: true }]);
      expect(db.append("history", { resumed: true }).sequence).toBe(2);
    } finally { db.close(); }
  } finally { child.kill("SIGKILL"); await exited; }
}, 10_000);

test("多记录事务在序列化失败时回滚，不留下半成品", async () => {
  const ref = await fixture();
  const db = new LocalDatabase(ref.database);
  try {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => db.transaction(() => { db.create("state", "first", {}); db.append("history", cyclic); })).toThrow();
    expect(db.list("state")).toEqual([]);
    expect(db.events("history")).toEqual([]);
  } finally { db.close(); }
});

test("数据库符号链接与坏文件均拒绝，不能覆盖指向内容", async () => {
  const ref = await fixture();
  const target = join(ref.root, "sentinel");
  await writeFile(target, "原始内容");
  await symlink(target, ref.database);
  expect(() => new LocalDatabase(ref.database)).toThrow("符号链接");
  expect(await readFile(target, "utf8")).toBe("原始内容");
  await rm(ref.database);
  await writeFile(ref.database, "损坏数据库");
  expect(() => new LocalDatabase(ref.database)).toThrow();
  expect(await readFile(ref.database, "utf8")).toBe("损坏数据库");
});

test("悬空数据库符号链接不能创建仓库之外的新文件", async () => {
  const ref = await fixture();
  const target = join(ref.root, "missing.sqlite");
  await symlink(target, ref.database);
  expect(() => new LocalDatabase(ref.database)).toThrow("符号链接");
  expect(await readdir(ref.root)).toEqual(["data.db"]);
});

test("数据库及 WAL/SHM 仅属主可读写", async () => {
  const ref = await fixture();
  const db = new LocalDatabase(ref.database);
  try {
    db.create("state", "first", {});
    for (const name of await readdir(ref.root)) expect((await stat(join(ref.root, name))).mode & 0o777).toBe(0o600);
  } finally { db.close(); }
});

test("Git 定义文件原子替换失败清理临时文件，成功写入后读到新正文", async () => {
  const ref = await fixture();
  const path = join(ref.root, "definition.md");
  await writeFileAtomic(path, "正文 A");
  expect(await readFile(path, "utf8")).toBe("正文 A");
  await writeFileAtomic(path, "正文 B");
  expect(await readFile(path, "utf8")).toBe("正文 B");
  const blocked = join(ref.root, "directory");
  await mkdir(blocked);
  await expect(writeFileAtomic(blocked, "不能写入")).rejects.toThrow();
  expect((await readdir(ref.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
});
