import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import { readPlanIn, unsentTask } from "../pm/plan-manage.ts";
import { pendingItemsIn } from "./pm-overview.ts";
import type { PmLease, RequirementRecord } from "../requirement/requirement-contracts.ts";
import { checked } from "../requirement/requirement-contracts.ts";
import { planRejectionsIn, stallIn } from "../pm/pm-attention.ts";
import { sessionFilePath } from "../agents/session-records.ts";
import { ACCEPTANCE_OTHER, FIXED_CHOICES } from "./panel-item-ask.ts";
import { readVerdictsIn } from "../pm/verdicts.ts";
import { COMPLETION_REPORTS, CompletionReport, DELIVERY_RECEIPTS, DeliveryReceipt } from "../delivery/workflow-close.ts";

export class DecisionPacketError extends Error {
  readonly code: string;
  constructor(code: string) { super(`decision_packet_denied:${code}`); this.name = "DecisionPacketError"; this.code = code; }
}

const MODEL_NOTE = "（模型输出，仅供参考，不是用户决定）";
/** 要登记用户决定的事项：主代理分析后用问答窗口给建议，选项文字须是程序固定的那几条。 */
function windowLine(itemId: string, version: string, fixed: readonly string[]): string {
  return `请核对记录、分析后用 one_company_user_interact purpose=panel-item itemId=${itemId} itemVersion=${version} 向用户给出建议，选项文字须依次为：${fixed.map((label) => `「${label}」`).join("、")}（N 填建议的轮数上限，1 到 1000）`;
}
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
      const held = task.holdNote !== undefined && unsentTask(task) ? [`PM 上报${MODEL_NOTE}：${quoted(task.holdNote, 1024)}`] : [];
      const attempts = task.attempts.flatMap((attempt, index) => {
        const verdict = verdicts.find((entry) => entry.runId === attempt.runId);
        return [`尝试 ${index + 1}：${attempt.turnsUsed}/${attempt.maxTurns} 轮 · 结局 ${attempt.outcome}`,
          ...(attempt.reason ? [`  PM 的说法${MODEL_NOTE}：${quoted(attempt.reason, 400)}`] : []),
          ...(attempt.escalation ? [`  PM 上报${MODEL_NOTE}：${quoted(attempt.escalation, 1024)}`] : []),
          ...(verdict ? [`  子代理自述${MODEL_NOTE}：${verdict.conclusion} · ${quoted(verdict.summary, 400)}`] : [])];
      });
      const resize = task.sizeHold !== undefined && unsentTask(task);
      return [...head, `任务 ${task.key}（${task.role}）目标章节：${task.goalUnitIds.join("、")}`, ...(resize ? [`拆分上限：${task.sizeHold!.join("；")}`] : []), ...held, ...attempts,
        resize ? "可选：1 照做（须由用户给出轮数上限，最多 1000）；2 让 PM 拆分或精简（PM 直接修改任务，不需要改 PRD）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。"
          : task.holdNote !== undefined && unsentTask(task) ? "可选：1 再给一次机会（须由用户给出轮数上限）；2 调整目标或范围（PM 直接修改任务，不需要改 PRD）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。"
          : "可选：1 再给一次机会（须由用户给出轮数上限）；2 调整目标或范围（经 PRD 修改与批准后生效）；3 终止这个任务（整个需求暂停，须调整需求或取消需求）。",
        windowLine(itemId, item.version, resize ? FIXED_CHOICES.resize : FIXED_CHOICES.retry),
        `用户在窗口里选中或自己写后，以 one_company_user_interact purpose=adjudicate itemId=${itemId} itemVersion=${item.version} 登记。`].join("\n");
    }
    if (item.kind === "adjust-requirement") {
      return [...head, "有任务已被用户终止，需求整体暂停。",
        "可选：1 调整需求：修改 PRD 并经用户批准新版本，PM 随后自动恢复并重新规划；2 取消或拒绝整个需求。",
        windowLine(itemId, item.version, FIXED_CHOICES.requirement),
        `用户选调整需求时修改草稿并请用户批准新版本；选取消或拒绝时以 one_company_user_interact purpose=adjudicate itemId=requirement:${requirementId} itemVersion=requirement:${requirementId}:${requirementVersion} 登记，再以返回的 decisionId 调用 workflow_manage close。`].join("\n");
    }
    if (item.kind === "acceptance") {
      const report = checked(CompletionReport, db.read<unknown>(COMPLETION_REPORTS, itemId.slice("report:".length))!.data);
      const receipt = checked(DeliveryReceipt, db.read<unknown>(DELIVERY_RECEIPTS, report.deliveryReceiptId)!.data);
      const verdicts = readVerdictsIn(db, ref.repoId, requirementId).filter((verdict) => report.basis.verdictIds.includes(verdict.verdictId));
      const workers = tasks.filter((task) => task.role === "worker");
      return [...head, "以下事实由程序从持久记录生成：",
        `交付凭据 ${receipt.receiptId} · 代码 ${receipt.codeHead} · 阻塞 ${receipt.blockers.length} 项 · 非阻塞建议 ${receipt.suggestions} 条`,
        `检查轮 ${receipt.checkRoundId ?? "无"} · 适用的正式验证 ${receipt.verificationIds.length} 项`,
        ...verdicts.filter((verdict) => verdict.role === "qa").map((verdict) => `QA 结论：${verdict.conclusion}`),
        ...workers.map((task) => {
          const review = verdicts.find((verdict) => verdict.review?.taskId === task.taskId);
          return `worker 任务 ${task.key}：${task.status} · 任务级审查 ${review?.conclusion ?? "无"}`;
        }),
        ...tasks.filter((task) => task.role !== "worker").map((task) => `${task.role} 任务 ${task.key}：${task.status}`),
        `需求分支本地提交 ${report.commits.length} 个${report.commitsTruncated ? `（仅列最近 ${report.commits.length} 个）` : ""}，提交说明由 PM 撰写${MODEL_NOTE}：`,
        ...report.commits.map((commit) => `  ${commit.sha.slice(0, 12)} ${quoted(commit.subject, 200)}`),
        `PM 的说明${MODEL_NOTE}：${quoted(report.note, 4000)}`,
        "可选：1 验收通过（随后以完成关闭需求）；2 返工（请用户说明要改什么，意见交回 PM）。",
        `${windowLine(itemId, item.version, FIXED_CHOICES.acceptance)}；返工意见由用户写在“${ACCEPTANCE_OTHER}”一行`,
        `用户在窗口里选中或写下返工意见后，以 one_company_user_interact purpose=adjudicate itemId=${itemId} itemVersion=${item.version} 登记。`].join("\n");
    }
    const advise = `请读运行记录与批准需求分析原因，再用 one_company_user_interact purpose=panel-item itemId=${itemId} itemVersion=${item.version} 向用户给出建议`;
    const log = sessionFilePath({ ...ref, runId: lease.runId });
    if (item.kind === "plan-rejected") {
      const rejected = planRejectionsIn(db, requirementId)!;
      const first = rejected.count - rejected.rejections.length + 1;
      return [...head, ...rejected.rejections.map((rejection, index) => `第 ${first + index} 次被拒（${rejection.action}）：${rejection.reason}${rejection.detail ? `；PM 提交的内容${MODEL_NOTE}：${quoted(rejection.detail, 400)}` : ""}`),
        ...(rejected.lastText ? [`PM 的说明${MODEL_NOTE}：${quoted(rejected.lastText, 1024)}`] : []), `运行记录 ${log}`,
        "可选：1 给 PM 补充说明后再试（转给 PM，被拒次数清零）；2 调整需求（修改草稿并经用户批准新版本）；3 取消需求。",
        `${advise}；用户选 1 时用 agent_manage message 把说明转给 PM，选 2、3 按需求修改或关闭流程处理。`].join("\n");
    }
    if (item.kind === "stall") {
      const stall = stallIn(db, requirementId)!;
      const plan = readPlanIn(db, requirementId)?.plan;
      return [...head, "PM 这一轮已结束：没有派出任务，没有在跑的子任务，也没有待你处理的事项；没有新的消息或事件，PM 不会自己继续。",
        `停下时间 ${new Date(stall.at).toISOString()} · 计划 ${plan ? `v${plan.planVersion}${plan.confirmedVersion === null ? " 未确认" : " 已确认"}` : "未提出"} · 运行记录 ${stall.log}`,
        `PM 最后写的话${MODEL_NOTE}：${stall.lastText ? quoted(stall.lastText, 1024) : "（没有写）"}`,
        `${advise}；能由 PM 自己处理的用 agent_manage message 把说明转给 PM，需要用户决定的向用户说明并询问。`].join("\n");
    }
    if (item.kind === "intake-review") {
      return [...head, "PM 已提交接手理解，等待主代理核对。", "请用 one_company_user_interact purpose=pm-intake 开始接手核对。"].join("\n");
    }
    const questionId = itemId.slice("question:".length);
    const question = db.read<{ proposal?: { conclusion?: string } }>("interaction_questions_v1", questionId)?.data;
    return [...head, `问题${MODEL_NOTE}：${question?.proposal?.conclusion ? quoted(question.proposal.conclusion, 400) : "（问题记录不可读）"}`,
      `请分析后用 one_company_user_interact purpose=panel-item itemId=${itemId} itemVersion=${item.version} 向用户转达该问题并给出建议；用户答复后按需求确认流程处理。`].join("\n");
  });
}
