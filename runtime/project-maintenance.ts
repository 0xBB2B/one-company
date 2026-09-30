import { mkdir } from "node:fs/promises";
import { mutedLines } from "./question-window.ts";
import type { ProgramWindow } from "./question-window.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { join } from "node:path";
import { withDatabaseMaintenance } from "./database-maintenance.ts";
import type { DatabaseManagementAuthorization } from "./database-maintenance.ts";
import { reconcileDatabaseRecovery } from "./database-recovery.ts";
import { listWorktrees, repositoryIdentity } from "./identity.ts";
import { createRequirementBackup } from "./requirement-backup.ts";
import { restoreRequirementBackup } from "./requirement-recovery.ts";
import { isTerminalState, RunStore } from "./run-store.ts";

const MAINTENANCE_ADVICE = {
  declined: { why: "用户在界面上拒绝了这次操作", next: "不要重试；确实需要时先向用户说明原因再问" },
  agents_running: { why: "还有子代理在运行，不能做恢复对账、备份或恢复", next: "先停止相关运行，再做维护" },
} as const satisfies Record<string, FailureAdvice>;
export type ProjectMaintenanceErrorCode = keyof typeof MAINTENANCE_ADVICE;
export class ProjectMaintenanceError extends Error {
  readonly code: ProjectMaintenanceErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: ProjectMaintenanceErrorCode) { super(code); this.name = "ProjectMaintenanceError"; this.code = code; this.advice = MAINTENANCE_ADVICE[code]; }
}

export interface ProjectMaintenanceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 真实用户在宿主界面的确认；返回 false 即拒绝。 */
  confirm: (window: ProgramWindow) => Promise<boolean>;
}

type Input = { operationId: string };

async function context(options: ProjectMaintenanceOptions, input: Input, title: string, lines: string[]) {
  const runs = await new RunStore({ dataRoot: options.dataRoot, repoId: options.repoId, daemonStartedAt: new Date().toISOString() })
    .list({ limit: Number.MAX_SAFE_INTEGER });
  // 维护标记会让其他连接的数据库操作失败；仍在运行的代理必须先结束，不能让它们在维护中途写入失败
  if (runs.items.some((run) => !isTerminalState(run.state) && run.state !== "interrupted")) throw new ProjectMaintenanceError("agents_running");
  if (!(await options.confirm({ title, lines: mutedLines(lines) }))) throw new ProjectMaintenanceError("declined");
  const identity = await repositoryIdentity(options.repositoryRoot);
  const worktreeRoots = await listWorktrees(identity.commonDir);
  // 维护标记使其他连接在维护期间的每次数据库操作都失败，这是"写入者已停止"的程序依据
  const authorization: DatabaseManagementAuthorization = { authorized: true, writesStopped: true, authorizationId: input.operationId, principal: "main" };
  return { worktreeRoots, authorize: () => authorization, repoDirectory: join(options.dataRoot, "repos", options.repoId) };
}

export async function recoveryCheck(options: ProjectMaintenanceOptions, input: Input) {
  const ctx = await context(options, input, "确认恢复对账", ["核对当前本机运行库是否可按原状态续接；对账期间其他数据库写入会被拒绝。"]);
  return withDatabaseMaintenance({ directory: ctx.repoDirectory, worktreeRoots: ctx.worktreeRoots, operationId: input.operationId },
    (permit) => reconcileDatabaseRecovery(permit, { operationId: input.operationId, mode: "current_restart", authorize: ctx.authorize }));
}

export async function backup(options: ProjectMaintenanceOptions, input: Input) {
  const ctx = await context(options, input, "确认备份本机需求数据", ["备份本机运行库与需求版本仓库到私有备份目录；备份期间其他数据库写入会被拒绝。"]);
  return createRequirementBackup({ repoDirectory: ctx.repoDirectory, repoId: options.repoId, operationId: input.operationId,
    worktreeRoots: ctx.worktreeRoots, authorize: ctx.authorize });
}

export async function restore(options: ProjectMaintenanceOptions, input: Input & { backupOperationId: string; backupManifestHash: string }) {
  const ctx = await context(options, input, "确认从备份恢复到隔离目录",
    [`备份：${input.backupOperationId}`, "恢复结果放在独立隔离目录并标记待核对，不替换当前运行库，不恢复 PM、任务或执行授权。"]);
  const isolation = join(options.dataRoot, "restores", input.operationId, "repos", options.repoId);
  await mkdir(isolation, { recursive: true, mode: 0o700 });
  return restoreRequirementBackup({
    backupDirectory: join(ctx.repoDirectory, "backups", "requirement-backups", input.backupOperationId),
    backupOperationId: input.backupOperationId, backupManifestHash: input.backupManifestHash,
    repoDirectory: isolation, repoId: options.repoId, operationId: input.operationId, worktreeRoots: ctx.worktreeRoots, authorize: ctx.authorize,
  });
}
