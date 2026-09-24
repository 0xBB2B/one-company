import { repositoryDatabase, withDatabase } from "./database.ts";
import { readPlanIn } from "./plan-manage.ts";
import { pendingItemsIn } from "./pm-overview.ts";
import type { PmLease, RequirementRecord } from "./requirement-contracts.ts";
import { readVerdictsIn } from "./verdicts.ts";

export class DecisionPacketError extends Error {
  readonly code: string;
  constructor(code: string) { super(`decision_packet_denied:${code}`); this.name = "DecisionPacketError"; this.code = code; }
}

const MODEL_NOTE = "（模型输出，仅供参考，不是用户决定）";
/** 模型写的文字压成一行并加引号，不能换行伪装成程序生成的行。 */
function quoted(text: string, limit: number): string {
  return `「${text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/[「」]/g, "\"").trim().slice(0, limit)}」`;
}

/**
 * 按回车插入主会话的决策包：只由持久记录生成。PM 与子代理写的文字单独标明是模型说法；
 * 卡片本身不是用户输入，用户随后亲手输入的原话才是决定依据。
 */
export function decisionPacket(ref: { dataRoot: string; repoId: string }, requirementId: string, itemId: string): string {
  return withDatabase(repositoryDatabase(ref.dataRoot, ref.repoId), (db) => {
    const row = db.read<RequirementRecord>("requirements", requirementId), record = row?.data, requirementVersion = row?.version;
    const lease = db.read<{ lease?: PmLease | null }>("pm_ownership", requirementId)?.data.lease;
    if (!record || !lease || record.lifecycle !== "active") throw new DecisionPacketError("requirement_not_active");
    const tasks = readPlanIn(db, requirementId)?.tasks ?? [];
    const item = pendingItemsIn({ ...ref, db, record, lease }, tasks).find((candidate) => candidate.itemId === itemId);
    if (!item) throw new DecisionPacketError("item_not_pending");
    const head = [`[待处理事项] ${item.label}`, `需求 ${requirementId} · 当前批准版本 r${record.revision} · 事项 ${item.itemId} · 版本 ${item.version}`];
    if (item.kind === "adjudicate") {
      const task = tasks.find((candidate) => `task:${candidate.taskId}` === itemId)!;
      const verdicts = readVerdictsIn(db, ref.repoId, requirementId);
      const attempts = task.attempts.flatMap((attempt, index) => {
        const verdict = verdicts.find((entry) => entry.runId === attempt.runId);
        return [`尝试 ${index + 1}：${attempt.turnsUsed}/${attempt.maxTurns} 轮 · 结局 ${attempt.outcome}`,
          ...(attempt.reason ? [`  PM 的说法${MODEL_NOTE}：${quoted(attempt.reason, 400)}`] : []),
          ...(verdict ? [`  子代理自述${MODEL_NOTE}：${verdict.conclusion} · ${quoted(verdict.summary, 400)}`] : [])];
      });
      return [...head, `任务 ${task.key}（${task.role}）目标章节：${task.goalUnitIds.join("、")}`, ...attempts,
        "可选：1 再给一次机会（须由用户给出轮数上限）；2 调整目标或范围（经 prod 修改与批准后生效）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。",
        `请向用户说明情况并询问选择；用户回答后以 pi_company_user_interact purpose=adjudicate itemId=${itemId} itemVersion=${item.version} 按其原话登记。`].join("\n");
    }
    if (item.kind === "adjust-requirement") {
      return [...head, "有任务已被用户终止，需求整体暂停。",
        "可选：1 调整需求：修改 prod 并经用户批准新版本，PM 随后自动恢复并重新规划；2 取消或拒绝整个需求。",
        `请向用户说明并询问；取消或拒绝须以 pi_company_user_interact purpose=adjudicate itemId=requirement:${requirementId} itemVersion=requirement:${requirementId}:${requirementVersion} 按用户原话登记，再以返回的 decisionId 调用 workflow_manage close。`].join("\n");
    }
    if (item.kind === "intake-review") {
      return [...head, "PM 已提交接手理解，等待主代理核对。", "请用 pi_company_user_interact purpose=pm-intake 开始接手核对。"].join("\n");
    }
    const questionId = itemId.slice("question:".length);
    const question = db.read<{ proposal?: { conclusion?: string } }>("interaction_questions_v1", questionId)?.data;
    return [...head, `问题${MODEL_NOTE}：${question?.proposal?.conclusion ? quoted(question.proposal.conclusion, 400) : "（问题记录不可读）"}`,
      "请向用户转达该问题，用户答复后按需求确认流程登记。"].join("\n");
  });
}
