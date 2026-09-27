import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type DatabaseKind = "data" | "global" | "index";
// data.db 的记录结构升到版本 2 且不迁移旧库；索引库可重建、全局库结构未变，仍为版本 1
export const DATABASE_SCHEMA_VERSIONS: Readonly<Record<DatabaseKind, number>> = Object.freeze({ data: 2, global: 1, index: 1 });
export const DATABASE_APPLICATION_IDS: Readonly<Record<DatabaseKind, number>> = Object.freeze({
  data: 0x50494441,
  global: 0x5049474c,
  index: 0x50494958,
});
export const DATABASE_MAINTENANCE_FILE = ".database-maintenance.json";
export const DATABASE_RECOVERY_FILE = ".database-recovery-required.json";
export const DATABASE_SNAPSHOT_FILE = ".database-snapshot.json";

export class DatabaseStorageError extends Error {
  readonly code: "upgrade_required" | "outdated_database" | "maintenance_required" | "recovery_required" | "snapshot_only" | "invalid_database_file" | "wrong_database_kind";
  constructor(code: DatabaseStorageError["code"], detail: string) {
    super(`本机数据库访问被阻止：${code}，${detail}`);
    this.name = "DatabaseStorageError"; this.code = code;
  }
}

export function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function canonicalLocation(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalLocation(parent), basename(path));
  }
}

export function assertDataRootOutsideWorktrees(dataRoot: string, worktrees: string[]): void {
  if (!isAbsolute(dataRoot)) throw new Error("本机数据根必须是绝对路径");
  const actual = canonicalLocation(resolve(dataRoot));
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  for (const worktree of worktrees) {
    const root = realpathSync(worktree);
    if (contains(root, actual) || contains(actual, root)) throw new Error("本机数据根必须与所有业务worktree分离，不能位于其中或包含业务现场");
  }
}

export function databaseKind(path: string): DatabaseKind | undefined {
  const name = basename(path);
  return name === "data.db" ? "data" : name === "global.db" ? "global" : name === "index.db" ? "index" : undefined;
}

/** 只检查路径元数据，发现旧库或未结束维护时不读取正文、不新建空库。 */
export function assertDatabasePathReady(path: string): void {
  const directory = dirname(resolve(path));
  if (pathExists(join(directory, DATABASE_MAINTENANCE_FILE))) throw new DatabaseStorageError("maintenance_required", "维护范围尚未确认结束");
  if (pathExists(join(directory, DATABASE_RECOVERY_FILE))) throw new DatabaseStorageError("recovery_required", "数据库切换或恢复尚未完成核对");
  if (pathExists(join(directory, DATABASE_SNAPSHOT_FILE))) throw new DatabaseStorageError("snapshot_only", "备份或待审核副本不是活动运行库");
  if (!databaseKind(path)) return;
  for (const legacy of ["data.sqlite", "global.sqlite"]) {
    if (["", "-wal", "-shm"].some((suffix) => pathExists(join(directory, legacy + suffix)))) {
      throw new DatabaseStorageError("upgrade_required", `检测到${legacy}或其附属文件，须先取得授权并核对迁移`);
    }
  }
}

export function assertRegularDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    // SQLite可在最后一个连接关闭时删除WAL/SHM；一次检查同时取得存在性和文件类型。
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) continue;
    // 并发删除也可能返回nlink=0的元数据；仅附属文件允许这种已移除状态，主库仍须存在一个链接。
    const detachedSidecar = suffix !== "" && stat.nlink === 0;
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && !detachedSidecar) || (process.getuid && stat.uid !== process.getuid())) {
      throw new DatabaseStorageError("invalid_database_file", "数据库必须是普通文件；主文件及WAL/SHM须由当前用户独占，禁止符号链接、硬链接或目录");
    }
  }
}

export function databaseFile(directory: string, kind: DatabaseKind): string {
  if (!["data", "global", "index"].includes(kind)) throw new DatabaseStorageError("wrong_database_kind", "仅支持data/global/index");
  if (!isAbsolute(directory)) throw new DatabaseStorageError("invalid_database_file", "本机数据库目录必须是绝对路径");
  const path = join(directory, `${kind}.db`);
  assertDatabasePathReady(path);
  return path;
}

export function repositoryDatabase(dataRoot: string, repoId: string): string {
  if (!/^[0-9a-f]{64}$/.test(repoId)) throw new Error("仓库身份格式无效");
  return databaseFile(join(dataRoot, "repos", repoId), "data");
}
export function indexDatabase(dataRoot: string, repoId: string): string {
  if (!/^[0-9a-f]{64}$/.test(repoId)) throw new Error("仓库身份格式无效");
  return databaseFile(join(dataRoot, "repos", repoId), "index");
}
export function globalDatabase(dataRoot: string): string { return databaseFile(dataRoot, "global"); }
