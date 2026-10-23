import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase, SyncResult } from "../../core/storage/database.ts";

export const PLAN_REJECTIONS = "pm_plan_rejections";
export const PM_STALLS = "pm_stalls";

/** reason 是程序固定的拒绝原因；detail 是拒绝时带出的明细，可能含 PM 提交的内容。 */
export interface PlanRejection { action: string; reason: string; detail: string; at: number }
/** count 是这个 PM 连续被拒的总次数，rejections 只留最近两次的原因。 */
export interface PlanRejections { pmRunId: string; count: number; rejections: PlanRejection[]; autoWoken: boolean; lastText?: string }
export interface PmStall { pmRunId: string; at: number; lastText: string; log: string }

/** 计入被拒次数的只有改了计划就能解决的内容问题（含目标被已有尝试的任务占住）；身份、租约、接手门槛、待复核更新、并发改动与任务状态不允许（要等而不是改）都不算。 */
export const PLAN_CONTENT_CODES: ReadonlySet<string> = new Set(["invalid_shape", "plan_exists", "plan_missing", "unknown_unit",
  "unit_not_authorized", "dependency_invalid", "agent_invalid", "coverage_incomplete", "goal_held"]);

interface Ref { dataRoot: string; repoId: string }

function write<T>(ref: Ref, run: (db: LocalDatabase) => T & SyncResult<T>): T {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction<T>(() => run(db)));
}
function put<T>(db: LocalDatabase, namespace: string, key: string, data: T | null): void {
  const row = db.read<T>(namespace, key);
  if (data === null) { if (row) db.remove(namespace, key, row.version); return; }
  if (row) db.update(namespace, key, row.version, data); else db.create(namespace, key, data);
}

export function planRejectionsIn(db: LocalDatabase, requirementId: string): PlanRejections | null {
  return db.read<PlanRejections>(PLAN_REJECTIONS, requirementId)?.data ?? null;
}

/** 登记一次被拒并返回这个 PM 累计的次数；换了 PM 从头计。 */
export function notePlanRejection(ref: Ref, requirementId: string, pmRunId: string, rejection: PlanRejection): number {
  return write(ref, (db) => {
    const current = planRejectionsIn(db, requirementId);
    const next: PlanRejections = current?.pmRunId === pmRunId
      ? { ...current, count: current.count + 1, rejections: [...current.rejections, rejection].slice(-2) }
      : { pmRunId, count: 1, rejections: [rejection], autoWoken: false };
    put(db, PLAN_REJECTIONS, requirementId, next);
    return next.count;
  });
}

export function markPlanRejectionWoken(ref: Ref, requirementId: string): void {
  write(ref, (db) => { const current = planRejectionsIn(db, requirementId); if (current) put(db, PLAN_REJECTIONS, requirementId, { ...current, autoWoken: true }); });
}

/** 被拒两次后 PM 停下时留下它最后写的话，卡片里作为 PM 的说明。 */
export function notePlanRejectionText(ref: Ref, requirementId: string, lastText: string): void {
  write(ref, (db) => { const current = planRejectionsIn(db, requirementId); if (current) put(db, PLAN_REJECTIONS, requirementId, { ...current, lastText }); });
}

export function clearPlanRejections(ref: Ref, requirementId: string): void {
  write(ref, (db) => put(db, PLAN_REJECTIONS, requirementId, null));
}

export function stallIn(db: LocalDatabase, requirementId: string): PmStall | null {
  return db.read<PmStall>(PM_STALLS, requirementId)?.data ?? null;
}

export function noteStall(ref: Ref, requirementId: string, stall: PmStall): void {
  write(ref, (db) => put(db, PM_STALLS, requirementId, stall));
}

export function clearStall(ref: Ref, requirementId: string): void {
  write(ref, (db) => { if (stallIn(db, requirementId)) put(db, PM_STALLS, requirementId, null); });
}
