import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { TASKS } from "./plan-manage.ts";
import type { PrototypeVersion, TaskRecord } from "./plan-manage.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { writeFileAtomic } from "./store.ts";
import type { FailureAdvice } from "./tool-failure.ts";

export const PROTOTYPE_MAX_BYTES = 1_048_576;

const PROTOTYPE_ADVICE = {
  prototype_unavailable: { why: "本运行不是做原型的运行，或已不是该任务当前的原型运行", next: "实现运行改用 verdict 提交结果" },
  prototype_too_large: { why: "原型超出大小上限", next: "精简原型后重交" },
  item_not_pending: { why: "这份原型已处理或不存在", next: "刷新面板后按当前事项操作" },
  item_changed: { why: "原型已有新版本", next: "请重新打开事项" },
  file_changed: { why: "原型文件与登记的指纹不一致，可能被改动过", next: "请让 PM 重新派 worker 提交原型" },
  opinion_required: { why: "返工须写明要改什么", next: "输入修改意见后再提交" },
} as const satisfies Record<string, FailureAdvice>;
export type PrototypeErrorCode = keyof typeof PROTOTYPE_ADVICE;
export class PrototypeError extends Error {
  readonly code: PrototypeErrorCode;
  readonly advice: FailureAdvice;
  readonly detail: string | undefined;
  constructor(code: PrototypeErrorCode, detail?: string) {
    super(detail ? `${code}：${detail}` : code); this.name = "PrototypeError"; this.code = code; this.detail = detail;
    this.advice = detail ? { why: `${PROTOTYPE_ADVICE[code].why}（${detail}）`, next: PROTOTYPE_ADVICE[code].next } : PROTOTYPE_ADVICE[code];
  }
}
const deny = (code: PrototypeErrorCode, detail?: string): never => { throw new PrototypeError(code, detail); };

type Ref = { dataRoot: string; repoId: string };
const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

export function prototypePath(ref: Ref, requirementId: string, key: string, version: number): string {
  return join(dirname(repositoryDatabase(ref.dataRoot, ref.repoId)), "prototypes", requirementId, `${key}.v${version}.html`);
}

export function latestPrototype(task: Pick<TaskRecord, "prototypes">): PrototypeVersion | undefined { return task.prototypes?.at(-1); }
/** 用户已通过的原型：只认最新一版，新版本出现后旧版本的通过不再算数。 */
export function approvedPrototype(task: Pick<TaskRecord, "prototypes">): PrototypeVersion | undefined {
  const latest = latestPrototype(task);
  return latest?.decision?.choice === "accept" ? latest : undefined;
}
export const prototypeItemId = (taskId: string) => `prototype:${taskId}`;
export const prototypeItemVersion = (taskId: string, prototype: PrototypeVersion) => `prototype:${taskId}:${prototype.version}:${prototype.hash}`;

/** worker 提交一版原型：文件写入本机数据目录，任务记录只存版本、指纹与路径。只收当前这次原型运行提交的内容。 */
export async function submitPrototype(binding: Ref & { requirementId: string; taskId: string; runId: string }, input: { html: string; note: string; now?: number }): Promise<PrototypeVersion> {
  const bytes = Buffer.byteLength(input.html, "utf8");
  if (bytes > PROTOTYPE_MAX_BYTES) deny("prototype_too_large", `原型 ${bytes} 字节，上限 ${PROTOTYPE_MAX_BYTES} 字节`);
  const database = repositoryDatabase(binding.dataRoot, binding.repoId);
  const revision = withDatabase(database, (db) => db.read<RequirementRecord>("requirements", binding.requirementId)?.data.revision) ?? deny("prototype_unavailable");
  const current = (): TaskRecord => {
    const task = withDatabase(database, (db) => db.read<TaskRecord>(TASKS, binding.taskId)?.data);
    if (!task || task.requirementId !== binding.requirementId || task.prototypeRun?.runId !== binding.runId || task.prototypeRun.outcome !== "running") return deny("prototype_unavailable");
    return task;
  };
  const task = current();
  const version = (task.prototypes?.length ?? 0) + 1;
  const path = prototypePath(binding, binding.requirementId, task.key, version);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, input.html);
  const prototype: PrototypeVersion = { version, hash: sha256(input.html), bytes, path, runId: binding.runId, note: input.note, submittedAt: input.now ?? Date.now(), revision };
  return withDatabase(database, (db) => db.transaction(() => {
    const row = db.read<TaskRecord>(TASKS, binding.taskId)!;
    if (row.data.prototypeRun?.runId !== binding.runId || row.data.prototypeRun.outcome !== "running" || (row.data.prototypes?.length ?? 0) + 1 !== version) deny("prototype_unavailable");
    db.update(TASKS, binding.taskId, row.version, { ...row.data, prototypes: [...(row.data.prototypes ?? []), prototype], updatedAt: prototype.submittedAt });
    return prototype;
  }));
}

export interface PrototypeConfirmation { itemId: string; itemVersion: string; taskKey: string; version: number; hash: string; bytes: number; path: string; note: string }

function pendingIn(db: LocalDatabase, requirementId: string, itemId: string): { task: TaskRecord; prototype: PrototypeVersion; rowVersion: number } {
  const record = db.read<RequirementRecord>("requirements", requirementId)?.data;
  const row = db.read<TaskRecord>(TASKS, itemId.slice("prototype:".length));
  const prototype = row ? latestPrototype(row.data) : undefined;
  if (!itemId.startsWith("prototype:") || record?.lifecycle !== "active" || !row || row.data.requirementId !== requirementId || !row.data.ui ||
    ["completed", "cancelled"].includes(row.data.status) || !prototype || prototype.decision) return deny("item_not_pending");
  return { task: row.data, prototype, rowVersion: row.version };
}

/** 确认窗口要显示的内容：只取程序记录；磁盘上的文件与登记指纹不符时拒绝，用户看到的必须是登记的那一版。 */
export async function prototypeConfirmation(ref: Ref, requirementId: string, itemId: string): Promise<PrototypeConfirmation> {
  const { task, prototype } = withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => pendingIn(db, requirementId, itemId));
  const content = await readFile(prototype.path).catch(() => null);
  if (!content || sha256(content) !== prototype.hash) deny("file_changed");
  return { itemId, itemVersion: prototypeItemVersion(task.taskId, prototype), taskKey: task.key, version: prototype.version, hash: prototype.hash,
    bytes: prototype.bytes, path: prototype.path, note: prototype.note };
}

/** 登记用户在确认窗口里的选择：只对窗口显示的那一版原型有效；返工意见是用户输入的原话。 */
export function decidePrototype(ref: Ref, input: { requirementId: string; itemId: string; itemVersion: string; choice: "accept" | "rework"; opinion: string | null; now?: number }): PrototypeVersion {
  if (input.choice === "rework" && !input.opinion?.trim()) deny("opinion_required");
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => db.transaction(() => {
    const { task, prototype, rowVersion } = pendingIn(db, input.requirementId, input.itemId);
    if (prototypeItemVersion(task.taskId, prototype) !== input.itemVersion) deny("item_changed");
    const decided: PrototypeVersion = { ...prototype, decision: { choice: input.choice, opinion: input.choice === "rework" ? input.opinion!.trim().slice(0, 4000) : null,
      decidedAt: input.now ?? Date.now(), notified: false } };
    db.update(TASKS, task.taskId, rowVersion, { ...task, prototypes: [...task.prototypes!.slice(0, -1), decided], updatedAt: decided.decision!.decidedAt });
    return decided;
  }));
}
