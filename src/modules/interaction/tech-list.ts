import { Type } from "typebox";
import type { Static } from "typebox";
import type { WindowLine, WindowQuestion } from "../../core/host/question-window.ts";
import { SHORT_DECISION_LIMITS } from "../requirement/short-decision-format.ts";
import { PRONOUN_FIX } from "./ask-question.ts";

export const TECH_KINDS = ["语言", "框架", "数据库", "第三方库", "中间件或外部服务", "工具"] as const;
export const TECH_SOURCES = ["用户点名", "项目规范", "AI 提议"] as const;

const oneOf = (values: readonly string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const detail = Type.String({ minLength: 1, maxLength: 200 });
export const TechItem = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }), kind: oneOf(TECH_KINDS), source: oneOf(TECH_SOURCES),
  purpose: detail, necessity: detail, alternatives: detail,
}, { additionalProperties: false });
export type TechItem = Static<typeof TechItem>;
const MAX_ITEMS = 12;
export const TECH_ITEMS = Type.Array(TechItem, { minItems: 1, maxItems: MAX_ITEMS });
const COLUMNS = [["name", "名称", 80], ["kind", "类别", 0], ["source", "来源", 0], ["purpose", "用途", 200], ["necessity", "为什么非它不可", 200], ["alternatives", "备选为什么不选", 200]] as const;
const PRONOUN_COLUMNS = ["purpose", "necessity", "alternatives"];
const present = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export const techQuestionText = (count: number) => `上面 ${count} 项新技术，同意引入吗？`;

const itemLabel = (tech: Pick<TechItem, "name" | "kind">, n: number) => `${n + 1}. ${tech.name}（${tech.kind}）`;

export const techRecordText = (items: TechItem[]) => `${techQuestionText(items.length)}\n清单：${items.map((tech, n) => itemLabel(tech, n)).join("；")}`;

export const techAgreeText = (items: TechItem[]) => `全部同意引入以下新技术：\n${items.map((tech, n) => itemLabel(tech, n)).join("\n")}`;

/** 登记技术清单时缺了什么，逐条写成给模型看的中文；全部合格时返回空数组。 */
export function techListIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return [`缺少技术清单（technologies）：要给 1 到 ${MAX_ITEMS} 项`];
  if (value.length < 1 || value.length > MAX_ITEMS) return [`技术清单要 1 到 ${MAX_ITEMS} 项，现在是 ${value.length} 项${value.length > MAX_ITEMS ? `，请分两次提交` : ""}`];
  const issues: string[] = [];
  value.forEach((raw, n) => {
    const tech = (raw ?? {}) as Record<string, unknown>;
    const where = `第 ${n + 1} 项`;
    for (const [key, label, limit] of COLUMNS) {
      const cell = tech[key];
      if (!present(cell)) { issues.push(`${where}缺少${label}（${key}）`); continue; }
      if (limit && [...cell].length > limit) issues.push(`${where}的${label}（${key}）${[...cell].length} 个字，超过 ${limit} 个字，请精简`);
      const pronouns = PRONOUN_COLUMNS.includes(key) ? [...new Set(cell.match(/[我你您]/gu) ?? [])] : [];
      if (pronouns.length) issues.push(`${where}的${label}（${key}）含“${pronouns.join("”“")}”：${PRONOUN_FIX}`);
    }
    if (present(tech.kind) && !(TECH_KINDS as readonly string[]).includes(tech.kind)) issues.push(`${where}的类别（kind）“${tech.kind}”不在可选值里，可选：${TECH_KINDS.join("、")}`);
    if (present(tech.source) && !(TECH_SOURCES as readonly string[]).includes(tech.source)) issues.push(`${where}的来源（source）“${tech.source}”不在可选值里，可选：${TECH_SOURCES.join("、")}`);
  });
  if (!issues.length) {
    const length = [...techRecordText(value as TechItem[])].length;
    const limit = SHORT_DECISION_LIMITS.textCodePoints;
    if (length > limit) issues.push(`问题记录文字合计 ${length} 个字，超过 ${limit} 个字（超了 ${length - limit} 个字），请精简名称或分两次提交`);
  }
  return issues;
}

export function techWindowQuestion(items: TechItem[], options: { caption: string; pmTask?: { key: string; title: string } }): WindowQuestion {
  const { pmTask } = options;
  const lines: WindowLine[] = [
    ...items.flatMap((tech, n): WindowLine[] => [
      ...(n > 0 ? [{ text: "" }] : []),
      { text: "", spans: [{ text: `${n + 1}. ${tech.name}`, bold: true }, { text: `  ${tech.kind} · ` }, { text: tech.source, tone: "warning" }] },
      ...([["用途", tech.purpose], ["为什么非它不可", tech.necessity], ["备选为什么不选", tech.alternatives]] as const)
        .map(([label, content]): WindowLine => ({ text: `   ${label}：${content}`, tone: "muted", indent: 3 })),
    ]),
  ];
  return {
    caption: options.caption, question: `要引入的新技术（共 ${items.length} 项）`, ...(pmTask ? { subtitle: `PM 拆计划时发现需要 · 卡住的任务：${pmTask.key} ${pmTask.title}` } : {}), lines,
    prompt: techQuestionText(items.length),
    choices: [{ label: "全部同意", description: pmTask ? `写进需求的「实现」板块，你批准新版本后 PM 接着做 ${pmTask.key}` : "按这份清单写进需求的「实现」板块；清单外的新技术仍要另外问" }],
    allowOther: true, otherLabel: "写修改意见", otherDescription: "写哪项要改、改成什么；AI 改好后再给你看整份清单",
    escapeHint: "Esc 暂不回答（清单保留，之后在对话里回答也行）", escapeOnOwnLine: true,
  };
}
