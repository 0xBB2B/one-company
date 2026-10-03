import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseRows } from "./project-index-installed-fixture.ts";

// 独立进程持有真实排他事务；同步只读查询阻塞时，写者仍能独立提交或回滚。
const writerSource = `
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(process.argv[1]);
  db.exec('BEGIN EXCLUSIVE');
  db.prepare('UPDATE records SET data = ?').run(JSON.stringify({ sequence: 2 }));
  const watchdog = setTimeout(() => { db.exec('ROLLBACK'); db.close(); process.exit(1); }, 30000);
  const finish = (commit) => {
    clearTimeout(watchdog);
    db.exec(commit ? 'COMMIT' : 'ROLLBACK'); db.close(); process.disconnect();
  };
  process.on('message', (message) => {
    if (message === 'commit-soon') setTimeout(() => finish(true), 250);
    if (message === 'rollback') finish(false);
  });
  process.send('locked');
`;

type SqliteError = Error & { code: string; errcode: number; errstr: string };

async function competition(run: (path: string, commitSoon: () => void) => void, journalMode: "DELETE" | "WAL" = "DELETE") {
  const root = await mkdtemp('/tmp/m3-sqlite-observer-');
  await chmod(root, 0o700);
  const path = join(root, 'fixture.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}; CREATE TABLE records(namespace TEXT, data TEXT)`);
  db.prepare('INSERT INTO records VALUES (?, ?)').run('fixture', JSON.stringify({ sequence: 1 }));
  db.close(); await chmod(path, 0o600);
  const proc = spawn(process.execPath, ['--input-type=module', '-e', writerSource, path], {
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    proc.once('error', fail); proc.once('close', (code, signal) => done({ code, signal }));
  });
  void exited.catch(() => {});
  let committing = false;
  try {
    await Promise.race([
      new Promise<void>((done) => proc.once('message', (message) => { expect(message).toBe('locked'); done(); })),
      exited.then((result) => { throw new Error(`SQLite竞争写者提前退出: ${JSON.stringify(result)}`); }),
    ]);
    run(path, () => { committing = true; proc.send('commit-soon'); });
  } finally {
    if (!committing && proc.connected) proc.send('rollback');
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    try { expect(databaseRows(path, 'fixture')).toEqual([{ sequence: committing ? 2 : 1 }]); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function evidence(label: string, value: Record<string, unknown>) {
  if (process.env.M3_SQLITE_EVIDENCE) await writeFile(join(process.env.M3_SQLITE_EVIDENCE, `${process.version}-${label}.json`),
    JSON.stringify({ node: process.version, ...value }, null, 2), { mode: 0o600, flag: 'wx' });
}

test('databaseRows：真实SQLite竞争等待后读取写者实际提交，默认零等待对照返回SQLITE_BUSY', async () => {
  let result: Record<string, unknown> = {};
  try {
    await competition((path, commitSoon) => {
      const immediate = new DatabaseSync(path, { readOnly: true });
      const busyTimeout = immediate.prepare('PRAGMA busy_timeout').get()!.timeout;
      let original: unknown;
      try { immediate.prepare('SELECT data FROM records').all(); } catch (error) { original = error; }
      finally { immediate.close(); }
      expect(busyTimeout).toBe(0);
      expect(original).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
      commitSoon();
      const start = performance.now();
      try {
        expect(databaseRows(path, 'fixture')).toEqual([{ sequence: 2 }]);
      } finally {
        result = { busyTimeout, original: { code: (original as SqliteError).code, errcode: (original as SqliteError).errcode }, elapsedMs: performance.now() - start };
      }
    });
  } finally { await evidence('busy-released', result); }
}, 15_000);

test('databaseRows：真实SQLite锁超过5000ms明确抛SQLITE_BUSY，不用空数组伪装通过', async () => {
  let result: Record<string, unknown> = {};
  try {
    await competition((path) => {
      const start = performance.now();
      let error: unknown;
      try { databaseRows(path, 'fixture'); } catch (caught) { error = caught; }
      const elapsedMs = performance.now() - start;
      result = { elapsedMs, code: (error as SqliteError | undefined)?.code, errcode: (error as SqliteError | undefined)?.errcode };
      expect(error).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
      expect(elapsedMs).toBeGreaterThanOrEqual(4_900);
      // SQLite 按计划睡眠时长累计 5 秒，系统睡眠偏慢时实际用时会超出，上限只防一直卡住
      expect(elapsedMs).toBeLessThan(15_000);
    });
  } finally { await evidence('busy-expired', result); }
}, 40_000);

test('databaseRows：WAL普通写事务不阻塞只读观察，提交前读旧值、提交后读实际新值', async () => {
  await competition((path, commitSoon) => {
    expect(databaseRows(path, 'fixture')).toEqual([{ sequence: 1 }]);
    commitSoon();
  }, 'WAL');
}, 15_000);

test('databaseRows：非busy的真实SQLite错误原样失败，只读连接不创建缺失表', async () => {
  const root = await mkdtemp('/tmp/m3-sqlite-observer-');
  await chmod(root, 0o700);
  const path = join(root, 'fixture.db');
  const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  await chmod(path, 0o600);
  try {
    expect(() => databaseRows(path, 'fixture')).toThrow(/no such table: records/);
    const observed = new DatabaseSync(path, { readOnly: true });
    try { expect(observed.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'unrelated' }]); }
    finally { observed.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
