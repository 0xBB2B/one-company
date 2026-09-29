import { Type } from "typebox";
import { COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import type { Static, TSchema } from "typebox";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { checkExploreInput } from "./explore-contracts.ts";
import type { ExploreInput } from "./explore-contracts.ts";
import { checked, counter, hash, id, object, positive } from "./requirement-contracts.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import { isTerminalState } from "./run-store.ts";
import type { RunRecord } from "./run-store.ts";

export const EXPLORE_SESSIONS = "explore_sessions";
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const ExploreSession = object({
  format: Type.Literal("explore-session/v1"), runId: id, repoId: hash, parentRunId: Type.String({ minLength: 1, maxLength: 256 }),
  parentRole: Type.Union([Type.Literal("main"), Type.Literal("PM")]), requirementId: nullable(id), epoch: nullable(positive), pmFence: nullable(positive),
  status: Type.Union([Type.Literal("active"), Type.Literal("ended")]), endedReason: nullable(Type.String({ maxLength: 64 })), createdAt: counter, endedAt: nullable(counter),
});
export type ExploreSession = Static<typeof ExploreSession>;
export type ExploreStaleReason = "session_missing" | "session_ended" | "requirement_closed" | "epoch_changed" | "pm_taken_over" | "parent_revoked";
export type ExploreSessionDecision = { current: true; session: ExploreSession } | { current: false; reason: ExploreStaleReason };
const EXPLORE_SESSION_ADVICE = {
  invalid_shape: COMMON_ADVICE.invalid_shape,
  session_reused: { why: "这个运行编号已登记过检索会话", next: "重新派出一次检索" },
  requirement_inactive: { why: "需求不在活动状态，或需求已换代（epoch 变化）", next: "重新读取需求状态后再决定是否派出检索" },
  pm_binding_invalid: { why: "派出检索的 PM 已不是这个需求当前的 PM", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" },
} as const satisfies Record<string, FailureAdvice>;
export type ExploreSessionErrorCode = keyof typeof EXPLORE_SESSION_ADVICE;
export class ExploreSessionError extends Error {
  readonly code: ExploreSessionErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: ExploreSessionErrorCode) { super(code); this.name = "ExploreSessionError"; this.code = code; this.advice = EXPLORE_SESSION_ADVICE[code]; }
}
export const EXPLORE_STALE_TEXT: Record<ExploreStaleReason, string> = {
  session_missing: "找不到本次检索会话的登记",
  session_ended: "本次检索会话已结束",
  requirement_closed: "需求已关闭或不在活动状态",
  epoch_changed: "需求已换代（epoch 变化）",
  pm_taken_over: "派出检索的 PM 已被新 PM 接管",
  parent_revoked: "派出检索的上级运行已结束",
};
export interface ExploreSessionConfig { dataRoot: string; repoId: string }

function readSessionIn(db: LocalDatabase, runId: string) {
  const row = db.read<unknown>(EXPLORE_SESSIONS, runId);
  return row ? { version: row.version, data: checked(ExploreSession, row.data) } : null;
}
function requirementIn(db: LocalDatabase, requirementId: string) { return db.read<RequirementRecord>("requirements", requirementId)?.data ?? null; }
function ownerIn(db: LocalDatabase, requirementId: string) { return db.read<{ fence?: number; lease?: PmLease | null }>("pm_ownership", requirementId)?.data ?? null; }
function parentRunIn(db: LocalDatabase, parentRunId: string) { return db.read<RunRecord>("runs", parentRunId)?.data ?? null; }

/** 登记一次 explore 搜索会话：绑定可信父身份与需求 epoch/PM fence；同一 runId 不能再次登记或跨需求复用。 */
export function registerExploreSession(config: ExploreSessionConfig, runId: string, input: ExploreInput): ExploreSession {
  checked(id, runId);
  const explore = checkExploreInput(input);
  return withDatabase(repositoryDatabase(config.dataRoot, config.repoId), (db) => db.transaction(() => {
    if (readSessionIn(db, runId)) throw new ExploreSessionError("session_reused");
    const binding = explore.parent.requirementBinding;
    if (binding) {
      const record = requirementIn(db, binding.requirementId);
      if (!record || record.repoId !== config.repoId || record.lifecycle !== "active" || record.recovery !== "ready" || record.epoch !== binding.epoch) throw new ExploreSessionError("requirement_inactive");
      if (explore.parent.role === "PM") {
        const owner = ownerIn(db, binding.requirementId);
        const fence = (binding as { pmFence?: number }).pmFence;
        if (!owner?.lease || owner.fence !== fence || owner.lease.runId !== explore.parent.parentRunId) throw new ExploreSessionError("pm_binding_invalid");
      }
    }
    const session = checked(ExploreSession, { format: "explore-session/v1", runId, repoId: config.repoId, parentRunId: explore.parent.parentRunId, parentRole: explore.parent.role,
      requirementId: binding?.requirementId ?? null, epoch: binding?.epoch ?? null, pmFence: explore.parent.role === "PM" ? (binding as { pmFence: number }).pmFence : null,
      status: "active", endedReason: null, createdAt: Date.now(), endedAt: null });
    db.create(EXPLORE_SESSIONS, runId, session);
    return session;
  }));
}

/** 当前性按数据库事实判定：需求关闭/epoch 变化、PM 接管、父运行结束或会话已回收都使迟到结果不能当作当前。 */
export function checkExploreSessionIn(db: LocalDatabase, config: ExploreSessionConfig, runId: string): ExploreSessionDecision {
  const stored = readSessionIn(db, runId);
  if (!stored || stored.data.repoId !== config.repoId) return { current: false, reason: "session_missing" };
  const session = stored.data;
  if (session.status === "ended") return { current: false, reason: "session_ended" };
  if (session.requirementId !== null) {
    const record = requirementIn(db, session.requirementId);
    if (!record || record.lifecycle !== "active" || record.recovery !== "ready") return { current: false, reason: "requirement_closed" };
    if (record.epoch !== session.epoch) return { current: false, reason: "epoch_changed" };
    if (session.parentRole === "PM") {
      const owner = ownerIn(db, session.requirementId);
      if (!owner?.lease || owner.fence !== session.pmFence || owner.lease.runId !== session.parentRunId) return { current: false, reason: "pm_taken_over" };
    }
  }
  const parent = parentRunIn(db, session.parentRunId);
  if (parent && isTerminalState(parent.state)) return { current: false, reason: "parent_revoked" };
  return { current: true, session };
}
export function checkExploreSession(config: ExploreSessionConfig, runId: string): ExploreSessionDecision {
  checked(id, runId);
  return withDatabase(repositoryDatabase(config.dataRoot, config.repoId), (db) => checkExploreSessionIn(db, config, runId));
}

export function endExploreSessionIn(db: LocalDatabase, runId: string, reason: string): ExploreSession | null {
  const stored = readSessionIn(db, runId);
  if (!stored) return null;
  if (stored.data.status === "ended") return stored.data;
  const next = checked(ExploreSession, { ...stored.data, status: "ended", endedReason: reason.slice(0, 64), endedAt: Date.now() });
  db.update(EXPLORE_SESSIONS, runId, stored.version, next);
  return next;
}
/** 任务结束回收搜索会话；已结束的会话不能再提交结果，也不能被同 runId 复用。 */
export function endExploreSession(config: ExploreSessionConfig, runId: string, reason: string): ExploreSession | null {
  checked(id, runId);
  return withDatabase(repositoryDatabase(config.dataRoot, config.repoId), (db) => db.transaction(() => endExploreSessionIn(db, runId, reason)));
}
/** 需求关闭或撤权时只结束绑定该需求的搜索会话；main 的无需求检索不受影响。 */
export function endRequirementExploreSessionsIn(db: LocalDatabase, repoId: string, requirementId: string, reason: string): string[] {
  const ended: string[] = [];
  for (const row of db.list<unknown>(EXPLORE_SESSIONS)) {
    const session = checked(ExploreSession, row.data);
    if (session.repoId !== repoId || session.requirementId !== requirementId || session.status === "ended") continue;
    endExploreSessionIn(db, session.runId, reason);
    ended.push(session.runId);
  }
  return ended;
}
