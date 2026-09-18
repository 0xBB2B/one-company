import { LEGACY_WORKFLOW_RETIRED } from "./decision-record-tool.ts";

export type DecisionActor = "ai" | "user";
export interface AppendDecisionOptions { dataRoot: string; cwd: string }
export interface ReadDecisionsOptions extends AppendDecisionOptions { requirement: string; actor: DecisionActor }
export interface InspectDecisionOptions extends AppendDecisionOptions { requirement: string; id: string }
export interface DecisionReceipt {
  schema: "decision-receipt/v1"; receiptId: string; decisionId: string; actor: DecisionActor;
  repoId: string; requirement: string; recordId: string; sequence: number; decisionHash: string; recordedAt: string;
}
/** 数据保全使用的流名称不授予读取或写入权限。 */
export const decisionStream = (requirement: string, actor: DecisionActor): string => `decisions:${requirement}:${actor}`;
function retired(): never { throw new Error(LEGACY_WORKFLOW_RETIRED); }
export function validateDecisionInput(_input: Record<string, unknown>): void { retired(); }
export function nextDecisionId(_existingIds: string[], _actor: DecisionActor): string { return retired(); }
export function buildRecord(_input: Record<string, unknown>, _meta: { id: string; recordedAt: string }): Record<string, unknown> { return retired(); }
/** 旧记录原样保全；不提供旧正文读取、构建或授权转换。 */
export async function appendDecision(_input: Record<string, unknown>, _options: AppendDecisionOptions): Promise<DecisionReceipt> { return retired(); }
export async function readDecisions(_options: ReadDecisionsOptions): Promise<unknown[]> { return retired(); }
export async function inspectDecision(_options: InspectDecisionOptions): Promise<unknown | null> { return retired(); }
