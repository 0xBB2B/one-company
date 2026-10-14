import { Type } from "typebox";
import type { Static } from "typebox";
import { id } from "./requirement-contracts.ts";

export const PrototypeDispatchInput = Type.Object({
  requirementId: id,
  name: Type.String({ minLength: 1, maxLength: 40 }),
  brief: Type.String({ minLength: 1, maxLength: 4000 }),
  maxTurns: Type.Integer({ minimum: 1, maximum: 100 }),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  model: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
  thinking: Type.String(),
}, { additionalProperties: false });
export type PrototypeDispatchInput = Static<typeof PrototypeDispatchInput>;

export interface MainPrototypeOverview {
  runId: string; requirementId: string; name: string; version: number; agent: string; turns: number; maxTurns: number; elapsedMs: number;
}

export function prototypeContext(input: { title: string; name: string; version: number; brief: string; maxTurns: number;
  previous: { path: string; opinion: string | null } | null }): string {
  return [
    `需求：${input.title}`,
    `原型名称：${input.name}（第 ${input.version} 版）`,
    `要求：\n${input.brief}`,
    ...(input.previous ? [`上一版文件：${input.previous.path}`,
      ...(input.previous.opinion ? [`用户对上一版的返工原话：${input.previous.opinion}`] : [])] : []),
    `对话轮次上限：${input.maxTurns}。用满后运行时会停止，请在额度内提交原型。`,
  ].join("\n");
}
