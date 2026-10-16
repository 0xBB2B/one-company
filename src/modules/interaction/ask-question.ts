import { Type } from "typebox";
import type { Static } from "typebox";
import { SHORT_DECISION_LIMITS } from "../requirement/short-decision-format.ts";

export const AskChoice = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  reason: Type.String({ minLength: 1, maxLength: 200 }),
  recommended: Type.Optional(Type.Boolean()),
  recommendedReason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, { additionalProperties: false });
export type AskChoice = Static<typeof AskChoice>;
export const ASK_ROOT_CHECK = Type.String({ minLength: 1, maxLength: 300 });
export const ASK_CHOICES = Type.Array(AskChoice, { minItems: 2, maxItems: 4 });
export interface AskQuestion { question: string; rootCheck: string; choices: AskChoice[] }

const text = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** 问题记录只存问题加各选项名称，推荐项标"（推荐）"；用户点选的那一项连同它的说明另作为用户原话交给模型，根源自检与推荐理由只在窗口里给用户看。 */
export function askRecordText(ask: AskQuestion): string {
  return `${ask.question}\n选项：${ask.choices.map((choice, i) => `${i + 1}. ${choice.label}${choice.recommended ? "（推荐）" : ""}`).join("；")}`;
}

/** 主代理登记问题时缺了什么，逐条写成给模型看的中文；全部写全时返回空数组。 */
export function askQuestionIssues(value: { question?: unknown; rootCheck?: unknown; choices?: unknown }): string[] {
  const issues: string[] = [];
  if (!text(value.rootCheck)) issues.push("缺少根源自检（rootCheck）：用一两句话说明这个问题针对的根源，以及为什么这些选项是从根源解决而不是临时修补");
  if (!Array.isArray(value.choices)) { issues.push("缺少选项（choices）：要给 2 到 4 个选项"); return issues; }
  const choices = value.choices as Array<Record<string, unknown> | null>;
  if (choices.length < 2 || choices.length > 4) issues.push(`选项要 2 到 4 个，现在是 ${choices.length} 个`);
  choices.forEach((choice, i) => {
    if (!text(choice?.label)) issues.push(`第 ${i + 1} 个选项缺少选什么（label）`);
    if (!text(choice?.reason)) issues.push(`第 ${i + 1} 个选项缺少理由（reason）：一句话说明好处或坏处`);
    if (choice?.recommended !== true && choice?.recommendedReason !== undefined) issues.push(`第 ${i + 1} 个选项不是推荐项，不能写推荐理由`);
  });
  const recommended = choices.filter((choice) => choice?.recommended === true);
  if (recommended.length === 0) issues.push("没有标出推荐项：要恰好推荐一个选项（recommended: true）并写推荐理由（recommendedReason）");
  else if (recommended.length > 1) issues.push(`推荐了 ${recommended.length} 个选项，只能推荐一个`);
  else if (!text(recommended[0]!.recommendedReason)) issues.push("推荐项缺少推荐理由（recommendedReason）");
  if (!issues.length && text(value.question)) {
    const length = [...askRecordText(value as AskQuestion)].length;
    if (length > SHORT_DECISION_LIMITS.textCodePoints) issues.push(`问题和各选项名称加起来 ${length} 个字，超过 ${SHORT_DECISION_LIMITS.textCodePoints} 个字，请精简`);
  }
  return issues;
}
