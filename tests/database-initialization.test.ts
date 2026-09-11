import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryRoot } from "./helpers/temporary-root.ts";

function child(args: string[]) {
  const proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  proc.stdout.on("data", (data) => { output += data.toString(); });
  proc.stderr.on("data", (data) => { errors += data.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
  void closed.catch(() => {});
  return { proc, closed, output: () => output, errors: () => errors };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("测试子进程未到达指定初始化边界");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const release of [true, false]) {
  test(`真实读锁阻挡 WAL 切换：${release ? "释放后完成且保留内容" : "有界失败且不提交业务写入"}`, async () => {
    const root = await mkdtemp(join(temporaryRoot(), "wal-init-"));
    const database = join(root, "data.sqlite");
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('kept');");
    db.close();
    const holderPath = join(root, "reader.mjs");
    const openerPath = join(root, "opener.mjs");
    await writeFile(holderPath, `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('BEGIN; SELECT * FROM sentinel;');
console.log('LOCKED');
process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); process.exit(0); });
`);
    await writeFile(openerPath, `import { LocalDatabase } from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).href)};
console.log('OPENING');
const started = performance.now();
try { const db = new LocalDatabase(process.argv[2]); db.create('probe', 'once', {}); db.close(); console.log(JSON.stringify({ ok: true })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error.errcode, elapsed: performance.now() - started })); process.exitCode = 1; }
`);
    const holder = child([holderPath, database]);
    let opener: ReturnType<typeof child> | undefined;
    try {
      await waitFor(() => holder.output().includes("LOCKED"));
      opener = child([openerPath, database]);
      await waitFor(() => opener!.output().includes("OPENING"));
      if (release) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(opener.proc.exitCode).toBeNull();
        holder.proc.stdin.write("release\n");
        expect(await holder.closed).toBe(0);
      }
      const code = await opener.closed;
      const result = JSON.parse(opener.output().trim().split("\n").at(-1)!);
      expect(code, opener.errors()).toBe(release ? 0 : 1);
      expect(result.ok).toBe(release);
      if (!release) {
        expect(result.code & 0xff).toBe(5);
        expect(result.elapsed).toBeGreaterThanOrEqual(4500);
        expect(result.elapsed).toBeLessThan(7500);
        holder.proc.stdin.write("release\n");
        await holder.closed;
      }
      const check = new DatabaseSync(database);
      try {
        expect(check.prepare("SELECT value FROM sentinel").get()?.value).toBe("kept");
        expect(check.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(release ? "wal" : "delete");
        if (release) expect(check.prepare("SELECT count(*) AS n FROM records WHERE namespace = 'probe'").get()?.n).toBe(1);
        else expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'records'").get()?.n).toBe(0);
      } finally { check.close(); }
    } finally {
      holder.proc.kill("SIGKILL");
      opener?.proc.kill("SIGKILL");
      await Promise.allSettled([holder.closed, ...(opener ? [opener.closed] : [])]);
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);
}

test("多进程同时首次开库：每轮四个进程全部完成，不重复或漏掉写入", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "init-race-"));
  const script = join(root, "writer.mjs");
  await writeFile(script, `import { LocalDatabase } from ${JSON.stringify(new URL("../runtime/database.ts", import.meta.url).href)};
console.log('READY');
process.stdin.once('data', () => {
  const db = new LocalDatabase(process.argv[2]);
  try { for (let i = 0; i < 10; i++) db.append('parallel', { pid: process.pid, i }); }
  finally { db.close(); }
});
`);
  try {
    for (let round = 0; round < 10; round++) {
      const path = join(root, `${round}.sqlite`);
      const children = Array.from({ length: 4 }, () => child([script, path]));
      try {
        await waitFor(() => children.every((c) => c.output().includes("READY")));
        children.forEach((c) => c.proc.stdin.end("go\n"));
        const codes = await Promise.all(children.map((c) => c.closed));
        expect(codes, children.map((c) => c.errors()).join("\n")).toEqual([0, 0, 0, 0]);
        const check = new DatabaseSync(path);
        try {
          const events = check.prepare("SELECT sequence, data FROM events ORDER BY sequence").all();
          expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
          expect(new Set(events.map((event) => JSON.parse(String(event.data)).pid)).size).toBe(4);
          expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        } finally { check.close(); }
      } finally {
        children.forEach((c) => c.proc.kill("SIGKILL"));
        await Promise.allSettled(children.map((c) => c.closed));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);
