import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Static } from "typebox";
import { appendDecision } from "./decisions.ts";
import { dataRoot as resolveDataRoot } from "./identity.ts";
import type { DecisionReceipt } from "./decisions.ts";

const PARAMETERS = Type.Object(
  {
    requirement: Type.String({ description: "需求身份，形如 2026-09-08.order-export" }),
    cwd: Type.Optional(Type.String({ description: "用于解析仓库身份的目录，默认当前工作目录" })),
    actor: Type.Union([Type.Literal("ai"), Type.Literal("user")]),
    source: Type.String({ minLength: 1, description: "产生决定的流程步骤" }),
    trigger: Type.String({ minLength: 1 }),
    decision: Type.String({ minLength: 1 }),
    alternatives: Type.Array(Type.String({ minLength: 1 })),
    effects: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    scope: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    basis: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Null()])),
    action: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    impact: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    supersedes: Type.Optional(Type.Union([Type.Array(Type.String({ pattern: "^(AI|USER)-\\d+$" })), Type.Null()])),
  },
  { additionalProperties: false },
);

type Parameters = Static<typeof PARAMETERS>;

export function describeReceipt(receipt: DecisionReceipt): string {
  return `已记录 ${receipt.decisionId}：记录 ${receipt.recordId}，序号 ${receipt.sequence}`;
}

export interface CreateDecisionRecordToolOptions {
  dataRoot?: string;
  cwd?: string;
  boundRequirement?: string;
}

export function createDecisionRecordTool(options: CreateDecisionRecordToolOptions = {}) {
  return {
    name: "decision_record",
    label: "记录决定",
    description: "把一次决定追加到需求台账",
    parameters: PARAMETERS,
    async execute(_toolCallId: string, params: Parameters, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<{ content: Array<{ type: "text"; text: string }>; details: { isError: boolean; receipt?: DecisionReceipt } }> {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "操作已中止" }], details: { isError: true } };
      }
      if (!Value.Check(PARAMETERS, params)) {
        const reason = [...Value.Errors(PARAMETERS, params)].map((error) => error.message).join("; ");
        return {
          content: [{ type: "text", text: `参数不合法: ${reason}` }],
          details: { isError: true },
        };
      }
      try {
        if (options.boundRequirement && (params.requirement !== options.boundRequirement ||
          (params.cwd !== undefined && await realpath(params.cwd) !== await realpath(options.cwd ?? ctx.cwd)))) {
          throw new Error("需求代理只能记录绑定仓库与需求的决定");
        }
        if (options.boundRequirement && params.actor === "user") throw new Error("用户决定只能由真实中继答复记录");
        const receipt = await appendDecision(params as unknown as Record<string, unknown>, {
          dataRoot: options.dataRoot ?? resolveDataRoot(process.env),
          cwd: params.cwd ?? options.cwd ?? ctx.cwd,
        });
        return {
          content: [{ type: "text", text: describeReceipt(receipt) }],
          details: { isError: false, receipt },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          details: { isError: true },
        };
      }
    },
  };
}
