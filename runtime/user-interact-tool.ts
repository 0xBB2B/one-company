import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";
import { HostAuthorizationError } from "./host-authorization.ts";
import { MainIntakeInteraction, PM_INTAKE_ASK_PARAMETERS, PM_INTAKE_FORWARD_PARAMETERS, PM_INTAKE_REPLY_PARAMETERS } from "./main-intake-interaction.ts";
import { requestParameters, shapeIssue, unwrapRequest } from "./tool-request.ts";
import { adviceOf, toolFailure, toolStep } from "./tool-failure.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import { ApprovalUnitIds } from "./user-interaction-format.ts";

const id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", minLength: 36, maxLength: 36 });
const base = { repoId: Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 }), requirementId: id,
  savedOperationId: id, operationId: id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) };
const actions = Type.Array(StringEnum(["analyze", "plan", "implement", "commit", "push"] as const), { uniqueItems: true, maxItems: 6 });
const question = Type.String({ minLength: 1, maxLength: 400 });
const confirmationPurpose = Type.Optional(Type.Literal("user-confirmation"));
const schemas = {
  ask: Type.Object({ purpose: confirmationPurpose, action: Type.Literal("ask"), ...base, question, scope: question, unitIds: ApprovalUnitIds, actions }, { additionalProperties: false }),
  reply: Type.Object({ purpose: confirmationPurpose, action: Type.Literal("reply"), ...base }, { additionalProperties: false }),
  forward: Type.Object({ purpose: confirmationPurpose, action: Type.Literal("forward"), ...base }, { additionalProperties: false }),
} satisfies Record<string, TSchema>;
const ADJUDICATE_PARAMETERS = Type.Object({ purpose: Type.Literal("adjudicate"), action: Type.Literal("reply"), repoId: base.repoId,
  requirementId: base.requirementId, operationId: base.operationId, itemId: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}$" }),
  itemVersion: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}:[1-9][0-9]{0,15}$" }) }, { additionalProperties: false });

const variants = {
  "user-confirmation:ask": schemas.ask, "user-confirmation:reply": schemas.reply, "user-confirmation:forward": schemas.forward,
  "adjudicate:reply": ADJUDICATE_PARAMETERS,
  "pm-intake:ask": PM_INTAKE_ASK_PARAMETERS, "pm-intake:forward": PM_INTAKE_FORWARD_PARAMETERS, "pm-intake:reply": PM_INTAKE_REPLY_PARAMETERS,
} satisfies Record<string, TObject>;
export const USER_INTERACT_PARAMETERS = requestParameters(Object.values(variants));

export function createUserInteractTool(options: {
  interaction: MainRequirementInteraction;
  intake?: MainIntakeInteraction;
}): ToolDefinition<typeof USER_INTERACT_PARAMETERS, unknown> {
  return { name: "one_company_user_interact", label: "需求澄清、决定与接手复核",
    description: "参数写成 {request:{purpose,action,...}}，只填该 purpose 与 action 格式里的字段；operationId 每次新生成 UUIDv7，其余 ID、版本取自此前工具结果或决策包，不要自编。默认或purpose=user-confirmation时，ask展示有界用户问题，reply/forward只消费当前真实输入。purpose=pm-intake时，ask创建接手复核请求，forward重取当前请求，reply由真实Main登记四类核对结果；purpose=adjudicate时，reply按用户当前原话登记用户决定（itemVersion取决策包上的版本，事项已变化时被拒）：itemId=task:<任务ID>时为待裁决任务的再给一次机会（须有轮数）、调整目标或范围、终止任务；itemId=requirement:<需求ID>时为取消或拒绝整个需求；itemId=report:<报告ID>时为验收通过或返工PM的完成报告；取消、拒绝或通过登记后以返回的decisionId作为workflow_manage close的receiptId；原话不清楚时不登记；不接受主体、角色、回执、理解正文或绑定字段。",
    promptSnippet: "按明确purpose处理用户确认或PM接手复核", parameters: USER_INTERACT_PARAMETERS, executionMode: "sequential",
    async execute(toolCallId, wrapped, signal, _update, ctx) {
      try { return await run(toolCallId, wrapped, signal, ctx); }
      catch (error) { throw toolFailure(toolStep("one_company_user_interact", unwrapRequest(wrapped) ?? wrapped), error); }
    } };
  async function run(toolCallId: string, wrapped: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    signal?.throwIfAborted();
    const raw = unwrapRequest(wrapped) as { purpose?: unknown; action?: unknown } | undefined;
    if (!raw || typeof raw !== "object") throw new HostAuthorizationError("invalid_shape", "参数须为 { request: { purpose, action, ... } }");
    const key = `${raw.purpose ?? "user-confirmation"}:${String(raw.action)}`;
    if (!Object.hasOwn(variants, key)) throw new HostAuthorizationError("invalid_shape", `可用 purpose:action：${Object.keys(variants).join("、")}`);
    const variant = variants[key as keyof typeof variants];
    if (!Value.Check(variant, raw)) throw new HostAuthorizationError("invalid_shape", shapeIssue(variant, raw));
    if (raw.purpose === "pm-intake") {
      if (!options.intake) throw new HostAuthorizationError("pm_intake_unavailable");
      // 没有原因说明的下层错误不回传原始消息，免得带出接手理解正文
    try { return await options.intake.execute(toolCallId, raw, ctx, signal); }
    catch (error) { throw adviceOf(error) ? error : new HostAuthorizationError("interaction_denied"); }
    }
    if (raw.purpose === "adjudicate") {
      const p = raw as { repoId: string; requirementId: string; itemId: string; itemVersion: string; operationId: string };
      return options.interaction.execute(toolCallId, ctx, p.repoId, { ...p }, async () => {
        signal?.throwIfAborted();
        return options.interaction.adjudicate(ctx, { repoId: p.repoId, requirementId: p.requirementId, itemId: p.itemId, itemVersion: p.itemVersion });
      }, signal ?? ctx.signal);
    }
    const normalized = structuredClone(raw) as Record<string, unknown>;
    delete normalized.purpose;
    const p = normalized as Record<string, unknown> & { action: "ask" | "reply" | "forward"; repoId: string; requirementId: string;
      operationId: string; savedOperationId: string; version: number; question?: string; scope?: string; unitIds?: string[]; actions?: never[] };
    return options.interaction.execute(toolCallId, ctx, p.repoId, p, async () => {
      signal?.throwIfAborted();
      return p.action === "ask" ? options.interaction.ask(ctx, { ...p, question: p.question!, scope: p.scope!, unitIds: p.unitIds!, actions: p.actions! })
        : options.interaction.confirm(ctx, p);
    }, signal ?? ctx.signal);
  }
}
