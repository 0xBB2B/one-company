import { realpathSync } from "node:fs";
import { join } from "node:path";
import { chooseWindow } from "./question-window.ts";
import type { WindowHost, WindowLine } from "./question-window.ts";
import { DatabaseMigrationError, migrateRepositoryDatabases, needsMigrationPrompt, readLockedMigrationPlan, readMigrationPlan, withMigrationLock } from "../storage/database-migration.ts";
import type { DataMigrationStep, MigrationPlan, MigrationReceipt } from "../storage/database-migration.ts";
import { listWorktrees, repoDisplayName } from "../storage/identity.ts";

/** spawn 前检查的结果：proceed 为 false 时客户端停下，不拉起守护进程。 */
export type BeforeSpawnResult =
  | { proceed: true }
  | { proceed: false; code: "database_migration_declined" | "database_migration_failed"; why: string; next: string };

export type BeforeSpawn = (repo: { repoId: string; commonDir: string }) => Promise<BeforeSpawnResult>;

type MigrationHost = WindowHost & { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } };

const BUSY_RETRY_MS = 1000;
const UNUSABLE = "这个窗口里的需求和后台代理功能用不了";
export const MIGRATION_FAILED_NEXT = "请用户重开 pi 窗口再试一次迁移；仍然失败就把原因告诉用户";

export function migrationWindowContent(name: string, plan: MigrationPlan, losses: string[]): { title: string; lines: WindowLine[] } {
  const lines: string[] = [];
  if (plan.data.status === "migratable") {
    lines.push(`data.db（需求、运行记录）：版本 ${plan.data.version} → ${plan.data.target}`, ...losses.map((loss) => `  ${loss}`),
      "  迁移前先把 data.db 备份到本机数据目录的 backups/ 下");
  }
  if (plan.index.status === "migratable") lines.push(`index.db（项目索引）：版本 ${plan.index.version} → ${plan.index.target}，删掉旧索引后重新建`);
  lines.push(`不迁移，${UNUSABLE}`);
  return { title: `仓库 ${name} 的本机数据库是旧版本，要迁移吗？`, lines: lines.map((text) => ({ text })) };
}

export function migrationNoticeText(
  name: string,
  event: { kind: "start"; backsUp: boolean } | { kind: "done"; receipt: MigrationReceipt } | { kind: "failed"; error: DatabaseMigrationError; oldVersion: number }
    | { kind: "interrupted"; reason: string } | { kind: "declined" },
): string {
  switch (event.kind) {
    case "start": return event.backsUp ? `正在迁移仓库 ${name} 的本机数据库，先备份 data.db…` : `正在迁移仓库 ${name} 的本机数据库…`;
    case "done": return `仓库 ${name} 的本机数据库已迁移到当前版本。`
      + (event.receipt.migratedData ? `旧 data.db 备份在 ${event.receipt.backupPath}。` : "") + (event.receipt.removedIndex ? "索引会在第一次查询时重新建。" : "");
    case "failed": return `仓库 ${name} 的本机数据库迁移失败：${event.error.step ?? "data.db 迁移"} 时，${event.error.reason}。数据库没有改动，还是版本 ${event.oldVersion}`
      + (event.error.backupPath ? `；迁移前的备份在 ${event.error.backupPath}` : "") + `。${UNUSABLE}，重开 pi 窗口可以再试一次。`;
    case "interrupted": return `仓库 ${name} 的本机数据库迁移没有做完：${event.reason}。${UNUSABLE}，重开 pi 窗口可以再试一次。`;
    case "declined": return `仓库 ${name} 的本机数据库是旧版本，这次没有迁移，${UNUSABLE}。重开 pi 窗口可以再次选择迁移。`;
  }
}

export function createBeforeSpawn(options: { host: MigrationHost; dataRoot: string; steps: DataMigrationStep[]; worktreeRoots?: string[] }): BeforeSpawn {
  const { host, dataRoot, steps } = options;
  return async ({ repoId, commonDir }) => {
    if (host.hasUI === false) return { proceed: true };
    try { if (!needsMigrationPrompt(readMigrationPlan(dataRoot, repoId))) return { proceed: true }; }
    catch (error) { if ((error as { code?: unknown }).code !== "maintenance_required") return { proceed: true }; }

    const name = repoDisplayName(commonDir);
    // 维护模块只接受真实路径，数据根经过软链接时要先展开
    const scope = { directory: realpathSync(join(dataRoot, "repos", repoId)), worktreeRoots: options.worktreeRoots ?? await listWorktrees(commonDir) };
    for (;;) {
      try {
        return await withMigrationLock(scope, async (permit): Promise<BeforeSpawnResult> => {
          const current = readLockedMigrationPlan(permit);
          if (!needsMigrationPrompt(current)) return { proceed: true };
          const losses = steps.flatMap((step) => current.data.status === "migratable" && step.from >= current.data.version ? step.losses : []);
          const content = migrationWindowContent(name, current, losses);
          const choice = await chooseWindow(host, { ...content, choices: [{ label: "迁移" }, { label: "暂不迁移" }], escapeHint: "Esc 暂不迁移" });
          if (choice !== "迁移") {
            host.ui.notify(migrationNoticeText(name, { kind: "declined" }), "warning");
            return { proceed: false, code: "database_migration_declined", why: `守护进程不可达：仓库 ${name} 的本机数据库是旧版本，用户这次选了暂不迁移`, next: "请用户重开 pi 窗口，在提示框里选「迁移」" };
          }
          host.ui.notify(migrationNoticeText(name, { kind: "start", backsUp: current.data.status === "migratable" }), "info");
          try {
            const receipt = await migrateRepositoryDatabases(permit, steps);
            host.ui.notify(migrationNoticeText(name, { kind: "done", receipt }), "info");
            return { proceed: true };
          } catch (error) {
            if (!(error instanceof DatabaseMigrationError)) {
              // 意外错误发生时库可能已经改了一部分，不能说"数据库没有改动"
              const reason = error instanceof Error ? error.message : String(error);
              host.ui.notify(migrationNoticeText(name, { kind: "interrupted", reason }), "error");
              return { proceed: false, code: "database_migration_failed", why: `守护进程不可达：仓库 ${name} 的本机数据库迁移失败：${reason}`, next: MIGRATION_FAILED_NEXT };
            }
            const oldVersion = current.data.status === "migratable" ? current.data.version : 0;
            host.ui.notify(migrationNoticeText(name, { kind: "failed", error, oldVersion }), "error");
            return { proceed: false, code: "database_migration_failed", why: `守护进程不可达：仓库 ${name} 的本机数据库迁移失败：${error.step ?? "data.db 迁移"} 时，${error.reason}`, next: MIGRATION_FAILED_NEXT };
          }
        });
      } catch (error) {
        if (!(error instanceof DatabaseMigrationError) || error.code !== "migration_busy") throw error;
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      }
    }
  };
}
