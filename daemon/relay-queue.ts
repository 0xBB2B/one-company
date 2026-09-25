import { withDatabase, uuidv7, databaseFile } from "../runtime/database.ts";

export interface RelayDeliverOptions { repoId: string; excludeWindowId?: string }
export type RelayDeliverFn = (event: string, payload: Record<string, unknown>, options: RelayDeliverOptions) => Promise<string[]>;
export interface RelayClock { now(): string }
export type RelayNoticeKind = "stopped" | "blocked" | "interrupted";
export interface RelayNotice { id: string; requirement: string; repoId: string; runId: string; kind: RelayNoticeKind; message: string; createdAt: string; deliveredTo: string[] }
export interface RelayNotifyInput { requirement: string; repoId: string; runId: string; kind: RelayNoticeKind; message: string }
export type RelayEvent =
  | { type: "notice_enqueued"; notice: RelayNotice }
  | { type: "deliver_failed"; event: string; repoId: string; reason: string };
export type RelayListener = (event: RelayEvent) => void;
export interface RelayQueueOptions { dataDir: string; deliver: RelayDeliverFn; clock?: RelayClock }

/** 只发送固定运行状态通知；不恢复旧问题、旧正文或字符串授权链。 */
export class RelayQueue {
  private readonly database: string;
  private readonly deliver: RelayDeliverFn;
  private readonly clock: RelayClock;
  private readonly listeners = new Set<RelayListener>();
  constructor(options: RelayQueueOptions) {
    this.database = databaseFile(options.dataDir, "data");
    this.deliver = options.deliver;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }
  private emit(event: RelayEvent): void { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  async notify(input: RelayNotifyInput): Promise<{ id: string }> {
    if (!["stopped", "blocked", "interrupted"].includes(input.kind)) throw new Error("状态通知只支持 stopped、blocked、interrupted");
    const id = uuidv7();
    const notice: RelayNotice = { id, requirement: input.requirement, repoId: input.repoId, runId: input.runId, kind: input.kind,
      message: "运行状态发生变化，请查询状态元数据；通知不表示进程已停止或需求已完成", createdAt: this.clock.now(), deliveredTo: [] };
    withDatabase(this.database, (db) => db.transaction(() => {
      const event = db.append("relay", { kind: "notice", id });
      db.create("relay_notices", id, { ...notice, sequence: event.sequence }, id);
    }));
    this.emit({ type: "notice_enqueued", notice });
    try {
      const { deliveredTo: _deliveredTo, ...payload } = notice;
      const delivered = await this.deliver("relay.notice", payload, { repoId: notice.repoId });
      for (const windowId of delivered) await this.markDelivered(windowId, id);
    } catch { this.emit({ type: "deliver_failed", event: "relay.notice", repoId: notice.repoId, reason: "状态通知投递失败" }); }
    return { id };
  }
  async markDelivered(windowId: string, noticeId: string): Promise<void> {
    withDatabase(this.database, (db) => db.transaction(() => {
      const record = db.read<RelayNotice>("relay_notices", noticeId);
      if (!record || record.data.deliveredTo.includes(windowId)) return;
      db.update("relay_notices", noticeId, record.version, { ...record.data, deliveredTo: [...record.data.deliveredTo, windowId] });
    }));
  }
  subscribe(listener: RelayListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
