import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { HostAuthorizationError } from "./host-authorization.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import { ApprovalUnitIds } from "./user-interaction-format.ts";
const id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", minLength: 36, maxLength: 36 });
const base = { repoId: Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 }), requirementId: id,
  savedOperationId: id, operationId: id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) };
const actions = Type.Array(StringEnum(["analyze", "plan", "implement", "close", "commit", "push"] as const), { uniqueItems: true, maxItems: 6 });
const question = Type.String({ minLength: 1, maxLength: 400 });
const schemas = {
  ask: Type.Object({ action: Type.Literal("ask"), ...base, question, scope: question, unitIds: ApprovalUnitIds, actions }, { additionalProperties: false }),
  reply: Type.Object({ action: Type.Literal("reply"), ...base }, { additionalProperties: false }),
  forward: Type.Object({ action: Type.Literal("forward"), ...base }, { additionalProperties: false }),
};
export const USER_INTERACT_PARAMETERS = Type.Object({ action: StringEnum(["ask", "reply", "forward"] as const), ...base,
  question: Type.Optional(question), scope: Type.Optional(question), unitIds: Type.Optional(ApprovalUnitIds), actions: Type.Optional(actions) }, { additionalProperties: false });
export function createUserInteractTool(options: { interaction: MainRequirementInteraction }): ToolDefinition<typeof USER_INTERACT_PARAMETERS, Record<string, unknown>> {
  return { name: "pi_company_user_interact", label: "需求澄清与决定",
    description: "ask展示有界问题及实际单位/动作范围，仅保存pending元数据。reply/forward只消费当前真实输入，不接受answer/message、主体、receipt或工具转述；加载全部相关问题，不按模型挑选一题批准。目标与动作分开，不启动PM。",
    promptSnippet: "按实际问题范围澄清并记录当前输入的简短决定", parameters: USER_INTERACT_PARAMETERS, executionMode: "sequential",
    async execute(toolCallId, raw, signal, _update, ctx) {
      signal?.throwIfAborted(); const schema = schemas[raw.action];
      if (!schema || !Value.Check(schema, raw)) throw new HostAuthorizationError("invalid_shape");
      const p = structuredClone(raw);
      return options.interaction.execute(toolCallId, ctx, p.repoId, p, async () => {
        signal?.throwIfAborted();
        return p.action === "ask" ? options.interaction.ask(ctx, { ...p, question: p.question!, scope: p.scope!, unitIds: p.unitIds!, actions: p.actions! })
          : options.interaction.confirm(ctx, p);
      }, signal ?? ctx.signal);
    } };
}
