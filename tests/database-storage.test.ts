import { afterEach, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase, databaseFile, globalDatabase, indexDatabase, repositoryDatabase, uuidv7 } from "../src/core/storage/database.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_MAINTENANCE_FILE, DATABASE_SNAPSHOT_FILE } from "../src/core/storage/database-paths.ts";
import { createDatabaseSnapshot, withDatabaseMaintenance } from "../src/core/storage/database-maintenance.ts";
import type { DatabaseMaintenancePermit } from "../src/core/storage/database-maintenance.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { STALE_LSTART, aliveChild, exitedPid, killChild, writeMarker } from "./helpers/maintenance-marker.ts";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { repoDataDir, repositoryIdentity } from "../src/core/storage/identity.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "db-layout-")); roots.push(root);
  const directory = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(directory, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  return { root, directory, workspace, scope: { directory, worktreeRoots: [workspace] } };
}
const fileHash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

test("项目初始化在创建数据目录前拒绝主工作区、独立worktree及其链接别名", async () => {
  const repo = await createRepoFixture();
  const w = await world();
  try {
    const worktree = await addWorktree(repo);
    const identity = await repositoryIdentity(repo.root);
    const alias = join(w.root, "worktree-alias"); await symlink(worktree.root, alias);
    for (const root of [repo.root, worktree.root, alias]) {
      const target = join(root, "private-data");
      await expect(repoDataDir(target, identity.repoId, identity.commonDir)).rejects.toThrow(/worktree分离/);
      expect(existsSync(target)).toBe(false);
    }
    expect(await repoDataDir(w.directory, identity.repoId, identity.commonDir)).toContain(identity.repoId);
  } finally { await removeRepoFixture(repo); }
});

test("三个固定.db路径与用途标签，索引不能保存任务或授权", async () => {
  const w = await world(), repoId = "a".repeat(64);
  const paths = [repositoryDatabase(w.directory, repoId), indexDatabase(w.directory, repoId), globalDatabase(w.directory)];
  expect(() => databaseFile(w.directory, "../outside" as "data")).toThrow(/wrong_database_kind/);
  expect(paths).toEqual([join(w.directory, "repos", repoId, "data.db"), join(w.directory, "repos", repoId, "index.db"), join(w.directory, "global.db")]);
  for (const [i, kind] of (["data", "index", "global"] as const).entries()) {
    const db = new LocalDatabase(paths[i]!);
    try {
      if (kind === "index") {
        db.create("files", "a.ts", { hash: "a".repeat(64) });
        expect(() => db.create("tasks", "T-1", {})).toThrow(/wrong_database_kind/);
        expect(() => db.append("decisions", {})).toThrow(/wrong_database_kind/);
      } else db.create("fixture", "retained", {});
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(paths[i]! + suffix)) expect((await stat(paths[i]! + suffix)).mode & 0o777).toBe(0o600);
    } finally { db.close(); }
    const raw = new DatabaseSync(paths[i]!, { readOnly: true });
    try { expect(raw.prepare("PRAGMA application_id").get()?.application_id).toBe(DATABASE_APPLICATION_IDS[kind]); } finally { raw.close(); }
  }
});

test("索引库拒绝写入 code_bindings 命名空间的记录", async () => {
  const w = await world();
  const db = new LocalDatabase(indexDatabase(w.directory, "a".repeat(64)));
  try { expect(() => db.create("code_bindings", "b", {})).toThrow(/wrong_database_kind/); } finally { db.close(); }
});

test("索引库白名单内的命名空间仍可写", async () => {
  const w = await world();
  const db = new LocalDatabase(indexDatabase(w.directory, "a".repeat(64)));
  try {
    for (const namespace of ["workspaces", "index_generations", "files", "symbols", "code_edges", "prd_metadata"]) {
      expect(() => db.create(namespace, "k", { hash: "a".repeat(64) }), namespace).not.toThrow();
    }
  } finally { db.close(); }
});

test("用途不符或未知旧布局的.db不被当成缓存重建", async () => {
  const w = await world();
  const data = databaseFile(w.directory, "data"), index = databaseFile(w.directory, "index");
  const db = new LocalDatabase(data); db.create("requirements", "r", { lifecycle: "closed" }); db.close();
  await copyFile(data, index);
  const before = await fileHash(index);
  expect(() => new LocalDatabase(index)).toThrow(/wrong_database_kind/);
  expect(await fileHash(index)).toBe(before);
  await rm(index);
  const unknown = new DatabaseSync(index); unknown.exec("CREATE TABLE private_note(value TEXT)"); unknown.close();
  expect(() => new LocalDatabase(index)).toThrow(/wrong_database_kind/);
});

const OLD_VERSION_MESSAGE = (file: string) => new RegExp(`outdated_database.*${file}.*来自旧版本.*请备份后删除本机数据目录并重新初始化`);

test.each([
  { kind: "data", version: 0, error: /wrong_database_kind/ },
  { kind: "data", version: 1, error: OLD_VERSION_MESSAGE("data\\.db") },
  { kind: "data", version: 2, error: OLD_VERSION_MESSAGE("data\\.db") },
  { kind: "data", version: 3, error: OLD_VERSION_MESSAGE("data\\.db") },
  { kind: "data", version: 99, error: /不支持的数据库版本/ },
  { kind: "index", version: 1, error: OLD_VERSION_MESSAGE("index\\.db") },
  { kind: "index", version: 99, error: /不支持的数据库版本/ },
].map((c) => [c.kind, c.version, c.error] as const))("%s.db 版本号 %s 在切换WAL前拒绝，源库字节不变", async (kind, version, error) => {
  const w = await world();
  const path = databaseFile(w.directory, kind);
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA application_id=${DATABASE_APPLICATION_IDS[kind]}; PRAGMA user_version=${version}; CREATE TABLE sentinel(value TEXT);`);
  raw.close();
  const before = await fileHash(path);
  expect(() => new LocalDatabase(path)).toThrow(error);
  expect(await fileHash(path)).toBe(before);
  expect(existsSync(path + "-wal")).toBe(false);
});

test("新建的 data.db、index.db、global.db 版本号分别是 4、2、1", async () => {
  const w = await world();
  const expected = { data: 4, index: 2, global: 1 } as const;
  for (const kind of ["data", "index", "global"] as const) {
    const path = databaseFile(w.directory, kind);
    new LocalDatabase(path).close();
    const raw = new DatabaseSync(path, { readOnly: true });
    try { expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(expected[kind]); } finally { raw.close(); }
  }
});

test("只删除索引库不影响需求、任务、授权记录及全局设置", async () => {
  const w = await world();
  const dataPath = databaseFile(w.directory, "data"), indexPath = databaseFile(w.directory, "index"), globalPath = databaseFile(w.directory, "global");
  const data = new LocalDatabase(dataPath); data.create("requirements", "r", { lifecycle: "closed" }); data.create("tasks", "t", { state: "done" }); data.create("receipts", "a", { revoked: true }); data.close();
  const global = new LocalDatabase(globalPath); global.create("role_settings", "fixture", {}); global.close();
  const beforeData = await fileHash(dataPath), beforeGlobal = await fileHash(globalPath);
  const index = new LocalDatabase(indexPath); index.create("files", "a.ts", {}); index.close();
  await rm(indexPath);
  const rebuilt = new LocalDatabase(indexPath); expect(rebuilt.list("files")).toEqual([]); rebuilt.close();
  expect(await fileHash(dataPath)).toBe(beforeData); expect(await fileHash(globalPath)).toBe(beforeGlobal);
  const reopened = new LocalDatabase(dataPath);
  try { expect(reopened.read("requirements", "r")?.data).toEqual({ lifecycle: "closed" }); expect(reopened.read("receipts", "a")?.data).toEqual({ revoked: true }); } finally { reopened.close(); }
});

test("数据库与WAL/SHM别名不能越过文件保护", async () => {
  const w = await world();
  const outside = join(w.root, "outside"), target = join(w.directory, "data.db");
  await writeFile(outside, "must-preserve");
  for (const suffix of ["", "-wal", "-shm"]) {
    await symlink(outside, target + suffix);
    expect(() => new LocalDatabase(target)).toThrow(/invalid_database_file/);
    expect(await readFile(outside, "utf8")).toBe("must-preserve");
    await rm(target + suffix);
  }
  await link(outside, target);
  expect(() => new LocalDatabase(target)).toThrow(/invalid_database_file/);
});

test("维护期间新旧连接都拒绝操作；过期或伪造permit不能备份", async () => {
  const w = await world(); const path = databaseFile(w.directory, "data");
  const db = new LocalDatabase(path); db.create("tasks", "t", {});
  let saved!: DatabaseMaintenancePermit;
  try {
    await withDatabaseMaintenance(w.scope, async (permit) => {
      saved = permit;
      expect(() => db.create("tasks", "late", {})).toThrow(/maintenance_required/);
      expect(() => db.read("tasks", "t")).toThrow(/maintenance_required/);
      expect(() => new LocalDatabase(path)).toThrow(/maintenance_required/);
      await expect(withDatabaseMaintenance(w.scope, () => null)).rejects.toThrow(/maintenance_already_exists/);
    });
    expect(db.read("tasks", "t")).not.toBeNull();
    expect(() => createDatabaseSnapshot(saved, "data")).toThrow(/invalid_or_expired_permit/);
    expect(() => createDatabaseSnapshot({} as DatabaseMaintenancePermit, "data")).toThrow(/invalid_or_expired_permit/);
  } finally { db.close(); }
});

test("快照包含仅在WAL中提交的记录，源字节保全且回执无正文", async () => {
  const w = await world(); const path = databaseFile(w.directory, "data");
  const initial = new LocalDatabase(path); initial.close();
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA wal_autocheckpoint=0");
  const secret = "WAL_ONLY_BODY_fixture_928";
  writer.prepare("INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "fixture", "wal", 1, JSON.stringify({ secret }));
  try {
    expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false);
    expect((await readFile(path + "-wal")).includes(Buffer.from(secret))).toBe(true);
    const before = await fileHash(path), walBefore = await fileHash(path + "-wal");
    const receipt = await withDatabaseMaintenance(w.scope, (permit) => createDatabaseSnapshot(permit, "data"));
    expect(receipt.state).toBe("prepared"); expect(receipt.executable).toBe(false); expect(receipt.restoreStatus).toBe("needs_review");
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(() => new LocalDatabase(receipt.snapshotPath)).toThrow(/snapshot_only/);
    expect(await fileHash(path)).toBe(before); expect(await fileHash(path + "-wal")).toBe(walBefore);
    expect((await stat(receipt.snapshotPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(receipt.snapshotPath, "..", DATABASE_SNAPSHOT_FILE))).mode & 0o777).toBe(0o600);
    const snapshot = new DatabaseSync(receipt.snapshotPath, { readOnly: true });
    try { expect(snapshot.prepare("SELECT data FROM records WHERE record_key='wal'").get()?.data).toBe(JSON.stringify({ secret })); } finally { snapshot.close(); }
  } finally { writer.close(); }
});

test("备份中发现外部写入则拒绝完成，不覆盖外部新内容", async () => {
  const w = await world(); const path = databaseFile(w.directory, "data");
  const initial = new LocalDatabase(path); initial.close();
  const writer = new DatabaseSync(path);
  const prepare = DatabaseSync.prototype.prepare;
  let triggered = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    const statement = prepare.call(this, sql);
    if (sql === "VACUUM main INTO ?") {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const result = run(...args);
        triggered = true;
        prepare.call(writer, "INSERT INTO records(id,namespace,record_key,version,data) VALUES(?,?,?,?,?)").run(uuidv7(), "fixture", "external", 1, "{}");
        return result;
      };
    }
    return statement;
  });
  try {
    await expect(withDatabaseMaintenance(w.scope, (permit) => createDatabaseSnapshot(permit, "data"))).rejects.toThrow(/source_changed/);
    expect(triggered).toBe(true);
    expect(writer.prepare("SELECT count(*) AS n FROM records WHERE record_key='external'").get()?.n).toBe(1);
    const [id] = await readdir(join(w.directory, "backups"));
    const meta = JSON.parse(await readFile(join(w.directory, "backups", id!, DATABASE_SNAPSHOT_FILE), "utf8"));
    expect(meta.state).toBe("failed"); expect(meta.executable).toBe(false);
  } finally { vi.restoreAllMocks(); writer.close(); }
});

test("业务根及其别名不得作为维护数据目录，读不出的维护标记不自动清", async () => {
  const w = await world();
  await expect(withDatabaseMaintenance({ directory: w.workspace, worktreeRoots: [w.workspace] }, () => null)).rejects.toThrow(/storage_overlaps_worktree/);
  const alias = join(w.root, "alias"); await symlink(w.workspace, alias);
  await expect(withDatabaseMaintenance({ directory: alias, worktreeRoots: [w.workspace] }, () => null)).rejects.toThrow(/private_directory_required/);
  await writeFile(join(w.directory, DATABASE_MAINTENANCE_FILE), '{"state":"interrupted"}', { mode: 0o600 });
  await expect(withDatabaseMaintenance(w.scope, () => null)).rejects.toThrow(/maintenance_already_exists/);
  expect(() => databaseFile(w.directory, "data")).toThrow(/maintenance_required/);
});

test("维护标记被外部改写时不删除新标记，并保留原操作失败", async () => {
  const w = await world();
  const original = new Error("original operation failure");
  let error: unknown;
  try {
    await withDatabaseMaintenance(w.scope, async () => {
      await writeFile(join(w.directory, DATABASE_MAINTENANCE_FILE), '{"state":"external"}');
      throw original;
    });
  } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as Error).cause).toBe(original);
  expect(await readFile(join(w.directory, DATABASE_MAINTENANCE_FILE), "utf8")).toBe('{"state":"external"}');
  expect(() => databaseFile(w.directory, "data")).toThrow(/maintenance_required/);
});

for (const kind of ["global", "index"] as const) {
  test(`${kind}.db快照保持用途且始终禁止直接作为运行库`, async () => {
    const w = await world(); const db = new LocalDatabase(databaseFile(w.directory, kind));
    db.create(kind === "index" ? "files" : "role_settings", "fixture", {}); db.close();
    const receipt = await withDatabaseMaintenance(w.scope, (permit) => createDatabaseSnapshot(permit, kind));
    expect(receipt.applicationId).toBe(DATABASE_APPLICATION_IDS[kind]);
    expect(() => new LocalDatabase(receipt.snapshotPath)).toThrow(/snapshot_only/);
  });
}

test("未知版本只记录备份失败，不伪报完成或替换源库", async () => {
  const w = await world(); const path = databaseFile(w.directory, "data");
  const initial = new LocalDatabase(path); initial.close();
  const raw = new DatabaseSync(path); raw.exec("PRAGMA user_version=99"); raw.close();
  const before = await fileHash(path);
  await expect(withDatabaseMaintenance(w.scope, (permit) => createDatabaseSnapshot(permit, "data"))).rejects.toThrow(/unrecognized_source_layout/);
  expect(await fileHash(path)).toBe(before);
  const [id] = await readdir(join(w.directory, "backups"));
  const meta = JSON.parse(await readFile(join(w.directory, "backups", id!, DATABASE_SNAPSHOT_FILE), "utf8"));
  expect(meta.state).toBe("failed"); expect(meta.executable).toBe(false);
});

test("维护进程被强杀后，下次打开数据库自动清掉残留标记并照常打开", async () => {
  const w = await world();
  const script = join(w.root, "hold.mjs");
  await writeFile(script, `import {withDatabaseMaintenance} from ${JSON.stringify(new URL("../src/core/storage/database-maintenance.ts", import.meta.url).href)};
process.stdin.resume();
await withDatabaseMaintenance(${JSON.stringify(w.scope)}, async () => { console.log('LOCKED'); await new Promise(() => {}); });
`);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("维护子进程未就绪")), 3000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("维护子进程提前退出")); });
      child.stdout.once("data", (data) => { clearTimeout(timer); data.toString().includes("LOCKED") ? resolve() : reject(new Error("维护标记未确认")); });
    });
    child.kill("SIGKILL"); await closed;
    expect(() => databaseFile(w.directory, "data")).not.toThrow();
    expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(false);
    await expect(withDatabaseMaintenance(w.scope, () => null)).resolves.toBeNull();
  } finally { child.kill("SIGKILL"); await closed; }
});

async function expectBlocked(directory: string, markerPath: string, sentence: string) {
  const before = await readFile(markerPath, "utf8");
  const failure = (() => { try { new LocalDatabase(join(directory, "data.db")); } catch (error) { return error as Error; } })();
  expect(failure?.message).toMatch(/maintenance_required/);
  expect(failure?.message).toContain(sentence);
  expect(await readFile(markerPath, "utf8")).toBe(before);
  return failure!.message;
}

test("维护标记记着已退出的进程时打开数据库成功并删掉标记", async () => {
  const w = await world();
  const pid = await exitedPid();
  const marker = await writeMarker(w.directory, pid, `pid:${pid}:lstart:${STALE_LSTART}`);
  new LocalDatabase(join(w.directory, "data.db")).close();
  expect(existsSync(marker)).toBe(false);
});

test("维护标记记着仍存活进程号、但启动时间和现在查到的不同时同样可清", async () => {
  const w = await world(); const child = await aliveChild();
  try {
    const marker = await writeMarker(w.directory, child.pid!, `pid:${child.pid}:lstart:${STALE_LSTART}`);
    new LocalDatabase(join(w.directory, "data.db")).close();
    expect(existsSync(marker)).toBe(false);
  } finally { await killChild(child); }
});

test("instance写法的标记记着已退出的进程时打开成功并删掉标记", async () => {
  const w = await world(); const pid = await exitedPid();
  const marker = await writeMarker(w.directory, pid, `pid:${pid}:instance:${uuidv7()}`);
  new LocalDatabase(join(w.directory, "data.db")).close();
  expect(existsSync(marker)).toBe(false);
});

test("本进程正在维护时从另一个连接打开：报还在备份、恢复或对账，不提删除，标记不动", async () => {
  const w = await world(); const path = join(w.directory, "data.db");
  new LocalDatabase(path).close();
  await withDatabaseMaintenance(w.scope, async () => {
    const message = await expectBlocked(w.directory, join(w.directory, DATABASE_MAINTENANCE_FILE), `本机数据正在备份、恢复或对账（进程 ${process.pid}），等它结束再试`);
    expect(message).toContain(`进程 ${process.pid}`);
    expect(message).toContain("等它结束再试");
    expect(message).not.toContain("删除");
  });
});

test("标记记着本进程pid时不比对身份字符串，一律按还在处理", async () => {
  const w = await world();
  const marker = await writeMarker(w.directory, process.pid, `pid:${process.pid}:lstart:${STALE_LSTART}`);
  const message = await expectBlocked(w.directory, marker, `本机数据正在备份、恢复或对账（进程 ${process.pid}），等它结束再试`);
  expect(message).toContain(`进程 ${process.pid}`);
  expect(message).toContain("等它结束再试");
  expect(message).not.toContain("删除");
});

test("instance写法的标记记着仍存活的进程时判断不了，报错带标记完整路径，标记不动", async () => {
  const w = await world(); const child = await aliveChild();
  try {
    const marker = await writeMarker(w.directory, child.pid!, `pid:${child.pid}:instance:${uuidv7()}`);
    const message = await expectBlocked(w.directory, marker, `判断不了留标记的进程是否还在；确认没有别的窗口在备份、恢复或对账后，删除 ${marker}`);
    expect(message).toContain(`删除 ${marker}`);
  } finally { await killChild(child); }
});

for (const content of ["{}", '{"state":"external"}']) {
  test(`维护标记内容为${content}时读不出，报错带标记完整路径，标记内容不变`, async () => {
    const w = await world(); const marker = join(w.directory, DATABASE_MAINTENANCE_FILE);
    await writeFile(marker, content, { mode: 0o600 });
    const message = await expectBlocked(w.directory, marker, `维护标记读不出；确认没有别的窗口在备份、恢复或对账后，删除 ${marker}`);
    expect(message).toContain(`删除 ${marker}`);
  });
}

test("维护标记里的进程身份和owner.pid对不上时按读不出处理", async () => {
  const w = await world(); const pid = await exitedPid();
  const marker = await writeMarker(w.directory, pid, `pid:${pid + 1}:lstart:${STALE_LSTART}`);
  await expectBlocked(w.directory, marker, `维护标记读不出；确认没有别的窗口在备份、恢复或对账后，删除 ${marker}`);
});

test("维护标记不是JSON时按读不出处理", async () => {
  const w = await world(); const marker = join(w.directory, DATABASE_MAINTENANCE_FILE);
  await writeFile(marker, "not json", { mode: 0o600 });
  await expectBlocked(w.directory, marker, `维护标记读不出；确认没有别的窗口在备份、恢复或对账后，删除 ${marker}`);
});

test("清理可清的维护标记时只删标记文件，目录里的其他文件不动", async () => {
  const w = await world(); const pid = await exitedPid();
  const marker = await writeMarker(w.directory, pid, `pid:${pid}:lstart:${STALE_LSTART}`);
  await mkdir(join(w.directory, "backups", "any-id"), { recursive: true });
  const kept = join(w.directory, "backups", "any-id", "x.txt");
  await writeFile(kept, "keep");
  new LocalDatabase(join(w.directory, "data.db")).close();
  expect(existsSync(marker)).toBe(false);
  expect(await readFile(kept, "utf8")).toBe("keep");
});

test("留有可清的维护标记时开始维护先清掉标记再照常进行；标记不能清时仍报maintenance_already_exists", async () => {
  const w = await world(); const pid = await exitedPid();
  const marker = await writeMarker(w.directory, pid, `pid:${pid}:lstart:${STALE_LSTART}`);
  await expect(withDatabaseMaintenance(w.scope, () => "done")).resolves.toBe("done");
  expect(existsSync(marker)).toBe(false);
  await writeMarker(w.directory, process.pid, `pid:${process.pid}:lstart:${STALE_LSTART}`);
  await expect(withDatabaseMaintenance(w.scope, () => null)).rejects.toThrow(/maintenance_already_exists/);
});

test("两个进程同时发现同一个可清的维护标记时都能打开成功", async () => {
  const w = await world(); const pid = await exitedPid();
  new LocalDatabase(join(w.directory, "data.db")).close();
  const marker = await writeMarker(w.directory, pid, `pid:${pid}:lstart:${STALE_LSTART}`);
  const script = join(w.root, "open.mjs");
  await writeFile(script, `import {LocalDatabase} from ${JSON.stringify(new URL("../src/core/storage/database.ts", import.meta.url).href)};
new LocalDatabase(${JSON.stringify(join(w.directory, "data.db"))}).close();`);
  const run = () => new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    child.once("close", (code) => resolve({ code, err }));
  });
  const results = await Promise.all([run(), run()]);
  expect(results.map((r) => r.code), results.map((r) => r.err).join("\n")).toEqual([0, 0]);
  expect(existsSync(marker)).toBe(false);
});
