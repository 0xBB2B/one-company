import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "../src/core/storage/database.ts";
import { DATABASE_APPLICATION_IDS, DATABASE_MAINTENANCE_FILE } from "../src/core/storage/database-paths.ts";
import type { DataMigrationStep, MigrationPlan } from "../src/core/storage/database-migration.ts";
import { createBeforeSpawn, migrationWindowContent } from "../src/core/host/database-migration-prompt.ts";
import type { WindowHost } from "../src/core/host/question-window.ts";
import { answeringUi } from "./helpers/window-host.ts";
import type { ShownWindow, WindowDecision } from "./helpers/window-host.ts";
import { aliveChild, killChild, writeMarker } from "./helpers/maintenance-marker.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

process.umask(0o077);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const ID_CONSTRAINT = `length(id) = 36 AND substr(id,15,1) = '7' AND substr(id,20,1) IN ('8','9','a','b')`;
const LOSS = "迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）";
const lossStep: DataMigrationStep = { from: 8, losses: [LOSS], migrate() {} };
const failingStep: DataMigrationStep = { from: 8, losses: [], migrate() { throw new Error("磁盘写满了"); } };

async function createDatabase(path: string, kind: "data" | "index", version: number) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE records (
      id TEXT PRIMARY KEY NOT NULL CHECK (${ID_CONSTRAINT}), namespace TEXT NOT NULL, record_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0), data TEXT NOT NULL CHECK (json_valid(data)), UNIQUE (namespace, record_key)
    ) STRICT;`);
    db.prepare("INSERT INTO records (id, namespace, record_key, version, data) VALUES (?, 'tasks', 'T-1', 3, '{}')").run(uuidv7());
    db.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_IDS[kind]}; PRAGMA user_version = ${version};`);
  } finally { db.close(); }
  await writeFile(path, await readFile(path), { mode: 0o600 });
}

function versionOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Number(db.prepare("PRAGMA user_version").get()?.user_version); } finally { db.close(); }
}

async function world(options: { data?: number; index?: number; repoId?: string; name?: string } = { data: 8, index: 1 }) {
  const root = await mkdtemp(join(temporaryRoot(), "mp-")); roots.push(root);
  const dataRoot = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(dataRoot, { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  return { root, dataRoot, workspace, ...(await addRepo(dataRoot, options)) };
}

async function addRepo(dataRoot: string, options: { data?: number; index?: number; repoId?: string; name?: string }) {
  const repoId = options.repoId ?? "b".repeat(64);
  const directory = join(dataRoot, "repos", repoId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (options.data !== undefined) await createDatabase(join(directory, "data.db"), "data", options.data);
  if (options.index !== undefined) await createDatabase(join(directory, "index.db"), "index", options.index);
  return {
    repoId, directory, dataPath: join(directory, "data.db"), indexPath: join(directory, "index.db"),
    commonDir: `/x/y/${options.name ?? "企微BOT"}/.git`,
  };
}

type World = Awaited<ReturnType<typeof world>>;

function setup(w: World, answer: (shown: ShownWindow) => WindowDecision | Promise<WindowDecision>, steps: DataMigrationStep[] = [lossStep], hasUI?: boolean) {
  const notices: Array<{ text: string; level?: string }> = [];
  const shown: ShownWindow[] = [];
  const ui = answeringUi((window) => { shown.push(window); return answer(window); });
  const custom = vi.spyOn(ui, "custom");
  const host = { ...(hasUI === undefined ? {} : { hasUI }), ui: { ...ui, custom: ui.custom, notify: (text: string, level?: string) => { notices.push({ text, level }); } } } as unknown as WindowHost;
  const beforeSpawn = createBeforeSpawn({ host, dataRoot: w.dataRoot, steps, worktreeRoots: [w.workspace] });
  return { beforeSpawn, notices, shown, custom, host };
}

const backupPattern = (w: World) =>
  new RegExp(`${join(w.directory, "backups").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f-]{36}/data\\.db`);

test("migrationWindowContent：data 8 与 index 1 时标题和内容逐行一致", () => {
  const plan: MigrationPlan = {
    data: { kind: "data", status: "migratable", version: 8, target: 9 },
    index: { kind: "index", status: "migratable", version: 1, target: 2 },
  };
  const content = migrationWindowContent("企微BOT", plan, [LOSS]);
  expect(content.title).toBe("仓库 企微BOT 的本机数据库是旧版本，要迁移吗？");
  expect(content.lines.map((line) => line.text)).toEqual([
    "data.db（需求、运行记录）：版本 8 → 9",
    `  ${LOSS}`,
    "  迁移前先把 data.db 备份到本机数据目录的 backups/ 下",
    "index.db（项目索引）：版本 1 → 2，删掉旧索引后重新建",
    "不迁移，这个窗口里的需求和后台代理功能用不了",
  ]);
});

test("migrationWindowContent：只有 index 可迁移时只列 index 行和不迁移行", () => {
  const plan: MigrationPlan = {
    data: { kind: "data", status: "missing" },
    index: { kind: "index", status: "migratable", version: 1, target: 2 },
  };
  const content = migrationWindowContent("企微BOT", plan, []);
  expect(content.lines.map((line) => line.text)).toEqual([
    "index.db（项目索引）：版本 1 → 2，删掉旧索引后重新建",
    "不迁移，这个窗口里的需求和后台代理功能用不了",
  ]);
});

test("选「迁移」：迁移框内容正确，通知依次为开始和成功，库迁到当前版本", async () => {
  const w = await world();
  const { beforeSpawn, notices, shown } = setup(w, () => "迁移");
  const result = await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
  expect(result).toEqual({ proceed: true });
  expect(shown).toHaveLength(1);
  // answeringUi 把三个空格开头的行都当选项，缩进的说明行也会混进来，所以只核对最后两项是选项
  expect(shown[0]!.choices.slice(-2)).toEqual(["迁移", "暂不迁移"]);
  expect(shown[0]!.choices.slice(0, -2)).toEqual(["迁移会丢掉原型记录里的「补充说明」（这个功能已经去掉了）", "迁移前先把 data.db 备份到本机数据目录的 backups/ 下"]);
  expect(shown[0]!.text).toContain("→ 迁移");
  expect(shown[0]!.text).toContain("↑↓ 选择 · 回车确认 · Esc 暂不迁移");
  expect(shown[0]!.title).toBe("仓库 企微BOT 的本机数据库是旧版本，要迁移吗？");
  expect(notices.map((n) => n.level)).toEqual(["info", "info"]);
  expect(notices[0]!.text).toBe("正在迁移仓库 企微BOT 的本机数据库，先备份 data.db…");
  expect(notices[1]!.text).toMatch(new RegExp(`^仓库 企微BOT 的本机数据库已迁移到当前版本。旧 data.db 备份在 ${backupPattern(w).source}。索引会在第一次查询时重新建。$`));
  expect(versionOf(w.dataPath)).toBe(9);
  expect(existsSync(w.indexPath)).toBe(false);
});

test("只迁 index.db：开始通知不提备份，成功通知不带备份路径", async () => {
  const w = await world({ index: 1 });
  const { beforeSpawn, notices } = setup(w, () => "迁移");
  expect(await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir })).toEqual({ proceed: true });
  expect(notices.map((n) => n.text)).toEqual([
    "正在迁移仓库 企微BOT 的本机数据库…",
    "仓库 企微BOT 的本机数据库已迁移到当前版本。索引会在第一次查询时重新建。",
  ]);
});

test.each([
  ["两个库都是当前版本", { data: 9, index: 2 }, undefined],
  ["两个库都不存在", {}, undefined],
  ["data.db 版本 5 太旧", { data: 5, index: 1 }, undefined],
  ["没有 pi 界面", { data: 8, index: 1 }, false],
] as const)("%s：不弹框，直接 proceed", async (_name, options, hasUI) => {
  const w = await world(options);
  const { beforeSpawn, custom } = setup(w, () => "迁移", [lossStep], hasUI);
  expect(await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir })).toEqual({ proceed: true });
  expect(custom).not.toHaveBeenCalled();
});

const declinedWhy = "守护进程不可达：仓库 企微BOT 的本机数据库是旧版本，用户这次选了暂不迁移";
const declinedNext = "请用户重开 pi 窗口，在提示框里选「迁移」";
const declinedWarning = "仓库 企微BOT 的本机数据库是旧版本，这次没有迁移，这个窗口里的需求和后台代理功能用不了。重开 pi 窗口可以再次选择迁移。";

test.each([["选「暂不迁移」", "暂不迁移" as WindowDecision], ["按 Esc", false as WindowDecision]])("%s：库不变，warning 通知，结果 declined", async (_name, decision) => {
  const w = await world();
  const { beforeSpawn, notices } = setup(w, () => decision);
  const result = await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
  expect(result).toEqual({ proceed: false, code: "database_migration_declined", why: declinedWhy, next: declinedNext });
  expect(notices).toEqual([{ text: declinedWarning, level: "warning" }]);
  expect(versionOf(w.dataPath)).toBe(8);
  expect(existsSync(w.indexPath)).toBe(true);
});

test("迁移步骤抛错：error 通知写明步骤、原因、备份路径，结果 failed，库仍是旧版本", async () => {
  const w = await world();
  const { beforeSpawn, notices } = setup(w, () => "迁移", [failingStep]);
  const result = await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
  expect(result.proceed).toBe(false);
  if (result.proceed) return;
  expect(result.code).toBe("database_migration_failed");
  expect(result.why).toContain("守护进程不可达：仓库 企微BOT 的本机数据库迁移失败：");
  expect(result.next).toBe("请用户重开 pi 窗口再试一次迁移；仍然失败就把原因告诉用户");
  const error = notices.at(-1)!;
  expect(error.level).toBe("error");
  expect(error.text).toContain("data.db 版本 8 → 9 时");
  expect(error.text).toContain("磁盘写满了");
  expect(error.text).toContain("数据库没有改动，还是版本 8");
  expect(error.text).toMatch(backupPattern(w));
  expect(error.text).toContain("这个窗口里的需求和后台代理功能用不了，重开 pi 窗口可以再试一次。");
  expect(versionOf(w.dataPath)).toBe(8);
  expect(versionOf(w.indexPath)).toBe(1);
});

test("迁移中出了意料之外的错：发 error 通知，结果 failed，通知不说数据库没有改动", async () => {
  const w = await world({ data: 9, index: 1 });
  await mkdir(`${w.indexPath}-shm`, { mode: 0o700 });
  await writeFile(join(`${w.indexPath}-shm`, "occupied"), "", { mode: 0o600 });
  const { beforeSpawn, notices } = setup(w, () => "迁移");
  const result = await beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
  expect(result.proceed).toBe(false);
  if (result.proceed) return;
  expect(result.code).toBe("database_migration_failed");
  expect(result.why).toContain("守护进程不可达：仓库 企微BOT 的本机数据库迁移失败：");
  expect(result.next).toBe("请用户重开 pi 窗口再试一次迁移；仍然失败就把原因告诉用户");
  expect(notices.map((n) => n.level)).toEqual(["info", "error"]);
  expect(notices[1]!.text).toMatch(/^仓库 企微BOT 的本机数据库迁移没有做完：.+。这个窗口里的需求和后台代理功能用不了，重开 pi 窗口可以再试一次。$/);
  expect(notices[1]!.text).not.toContain("数据库没有改动");
});

test("维护标记被占：不弹框，释放后弹框", async () => {
  const w = await world(); const child = await aliveChild();
  try {
    const marker = await writeMarker(w.directory, child.pid!, `pid:${child.pid}:instance:${uuidv7()}`);
    const { beforeSpawn, custom } = setup(w, () => "迁移");
    const pending = beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(custom).not.toHaveBeenCalled();
    await rm(marker);
    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(await pending).toEqual({ proceed: true });
    expect(existsSync(join(w.directory, DATABASE_MAINTENANCE_FILE))).toBe(false);
  } finally { await killChild(child); }
});

test("维护标记被占期间库已被别处迁到当前版本：释放后不弹框，直接 proceed", async () => {
  const w = await world(); const child = await aliveChild();
  try {
    const marker = await writeMarker(w.directory, child.pid!, `pid:${child.pid}:instance:${uuidv7()}`);
    const { beforeSpawn, custom } = setup(w, () => "迁移");
    const pending = beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(w.dataPath); await rm(w.indexPath);
    await createDatabase(w.dataPath, "data", 9);
    await rm(marker);
    expect(await pending).toEqual({ proceed: true });
    expect(custom).not.toHaveBeenCalled();
  } finally { await killChild(child); }
});

test("两个仓库同时调用：一次只显示一个窗口，各自标题带自己的仓库名，一个停下不影响另一个", async () => {
  const w = await world({ data: 8, index: 1, repoId: "a".repeat(64), name: "仓库甲" });
  const other = await addRepo(w.dataRoot, { data: 8, index: 1, repoId: "c".repeat(64), name: "仓库乙" });
  const notices: Array<{ text: string; level?: string }> = [];
  const shown: ShownWindow[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const ui = answeringUi(async (window) => {
    shown.push(window);
    if (shown.length === 1) { await firstGate; return "暂不迁移"; }
    return "迁移";
  });
  const host = { ui: { ...ui, notify: (text: string, level?: string) => { notices.push({ text, level }); } } } as unknown as WindowHost;
  const beforeSpawn = createBeforeSpawn({ host, dataRoot: w.dataRoot, steps: [lossStep], worktreeRoots: [w.workspace] });
  const first = beforeSpawn({ repoId: w.repoId, commonDir: w.commonDir });
  await vi.waitFor(() => expect(shown).toHaveLength(1));
  const second = beforeSpawn({ repoId: other.repoId, commonDir: other.commonDir });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(shown).toHaveLength(1);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(shown[0]!.title).toBe("仓库 仓库甲 的本机数据库是旧版本，要迁移吗？");
  expect(shown[1]!.title).toBe("仓库 仓库乙 的本机数据库是旧版本，要迁移吗？");
  expect(firstResult).toMatchObject({ proceed: false, code: "database_migration_declined" });
  expect(secondResult).toEqual({ proceed: true });
  expect(versionOf(w.dataPath)).toBe(8);
  expect(versionOf(other.dataPath)).toBe(9);
}, 15000);
