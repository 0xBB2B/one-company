import { adjudicationSubject } from "./adjudication.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import { readPlanIn } from "./plan-manage.ts";
import { pendingItemsIn } from "./pm-overview.ts";
import type { PendingItem } from "./pm-overview.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";

export class PanelItemAskError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail = "") { super(detail ? `${code}: ${detail}` : code); this.name = "PanelItemAskError"; this.code = code; this.detail = detail; }
}

/** 需要登记用户决定的事项：窗口选项文字由程序固定，只有轮数上限由主代理建议；"N" 处填 1 到 1000 的整数。 */
export const FIXED_CHOICES = {
  retry: ["再给一次机会，轮数上限 N", "调整目标或范围", "终止这个任务"],
  resize: ["照做，轮数上限 N", "让 PM 拆分或精简", "终止这个任务"],
  acceptance: ["验收通过", "暂不验收"],
  requirement: ["调整需求", "取消需求", "拒绝需求"],
} as const;
export const ACCEPTANCE_OTHER = "返工（自己输入要改什么）";

export interface PanelItemTarget {
  /** 窗口标题里的事项名称。 */
  label: string;
  /** 用户在窗口里的回答可以登记为哪个决定；为 null 时回答只作为给主代理的指示。 */
  decision: { itemId: string; itemVersion: string } | null;
  fixed: readonly string[] | null;
  otherLabel?: string;
}

const deny = (code: string, detail = ""): never => { throw new PanelItemAskError(code, detail); };

/** 按当前持久记录找出被问的事项及其登记对象；事项已变化或不在待处理之列时拒绝。 */
export function panelItemTarget(ref: { dataRoot: string; repoId: string }, requirementId: string, itemId: string, itemVersion: string): PanelItemTarget {
  if (itemId === `requirement:${requirementId}`) {
    const subject = adjudicationSubject(ref, requirementId, itemId);
    if (subject.version !== itemVersion) deny("item_changed");
    return { label: "取消或拒绝整个需求", decision: { itemId, itemVersion }, fixed: FIXED_CHOICES.requirement };
  }
  const found = withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const record = db.read<RequirementRecord>("requirements", requirementId)?.data;
    const lease = db.read<{ lease?: PmLease | null }>("pm_ownership", requirementId)?.data.lease;
    if (!record || !lease || record.lifecycle !== "active") return deny("item_not_pending");
    const tasks = readPlanIn(db, requirementId)?.tasks ?? [];
    const item: PendingItem | undefined = pendingItemsIn({ ...ref, db, record, lease }, tasks).find((candidate) => candidate.itemId === itemId);
    const task = item?.kind === "adjudicate" ? tasks.find((candidate) => `task:${candidate.taskId}` === itemId) : undefined;
    return { item, resize: task !== undefined && task.sizeHold !== undefined && task.attempts.length === 0 };
  });
  const item = found.item ?? deny("item_not_pending");
  if (item.version !== itemVersion) deny("item_changed");
  if (item.kind === "adjudicate") return { label: item.label, decision: { itemId, itemVersion }, fixed: found.resize ? FIXED_CHOICES.resize : FIXED_CHOICES.retry };
  if (item.kind === "acceptance") return { label: item.label, decision: { itemId, itemVersion }, fixed: FIXED_CHOICES.acceptance, otherLabel: ACCEPTANCE_OTHER };
  if (item.kind === "adjust-requirement") {
    const requirement = `requirement:${requirementId}`;
    return { label: item.label, decision: { itemId: requirement, itemVersion: adjudicationSubject(ref, requirementId, requirement).version }, fixed: FIXED_CHOICES.requirement };
  }
  return { label: item.label, decision: null, fixed: null };
}

/** 选项文字须与程序固定的文字逐一相同且顺序一致；"N" 处只能是 1 到 1000 的整数。不符时返回给模型看的原因。 */
export function fixedChoiceIssue(fixed: readonly string[], labels: readonly string[]): string | null {
  const matches = (expected: string, actual: string) => {
    if (!expected.includes("N")) return expected === actual;
    const [head, tail] = expected.split("N");
    if (!actual.startsWith(head!) || !actual.endsWith(tail!)) return false;
    const turns = actual.slice(head!.length, actual.length - tail!.length);
    return /^[1-9][0-9]{0,3}$/.test(turns) && Number(turns) <= 1000;
  };
  if (labels.length === fixed.length && fixed.every((expected, index) => matches(expected, labels[index]!))) return null;
  return `这个事项要登记用户的决定，选项文字须依次为：${fixed.map((label) => `「${label}」`).join("、")}（N 填 1 到 1000 的轮数上限）`;
}
