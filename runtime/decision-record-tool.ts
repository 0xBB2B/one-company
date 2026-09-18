import { Type } from "typebox";
import type { DecisionReceipt } from "./decisions.ts";

export const LEGACY_WORKFLOW_RETIRED = "旧工作流已永久淘汰；旧决定、形状、转述及运行状态不产生执行授权。新能力未完成时拒绝执行。";

export function describeReceipt(receipt: DecisionReceipt): string {
  return `已记录 ${receipt.decisionId}：记录 ${receipt.recordId}，序号 ${receipt.sequence}`;
}

export interface CreateDecisionRecordToolOptions {
  dataRoot?: string;
  cwd?: string;
  boundRequirement?: string;
}

/** 旧工厂只返回固定拒绝，不访问输入载荷、文件或数据库。扩展不注册此工具。 */
export function createDecisionRecordTool(_options: CreateDecisionRecordToolOptions = {}) {
  return {
    name: "decision_record",
    label: "旧决定入口已淘汰",
    description: LEGACY_WORKFLOW_RETIRED,
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, _ctx?: { cwd: string }) {
      return { content: [{ type: "text" as const, text: LEGACY_WORKFLOW_RETIRED }], details: { isError: true, code: "legacy_workflow_retired" } };
    },
  };
}
