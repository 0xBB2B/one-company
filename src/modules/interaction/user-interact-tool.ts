import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static, TObject, TSchema } from "typebox";
import { Value } from "typebox/value";
import { uuidv7 } from "../../core/storage/database.ts";
import { HostAuthorizationError } from "../requirement/host-authorization.ts";
import { MainIntakeInteraction, PM_INTAKE_ASK_PARAMETERS, PM_INTAKE_FORWARD_PARAMETERS, PM_INTAKE_REPLY_PARAMETERS } from "./main-intake-interaction.ts";
import { requestParameters, shapeIssue, unwrapRequest } from "../../core/exec/tool-request.ts";
import { adviceOf, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import { ApprovalUnitIds } from "../requirement/user-interaction-format.ts";
import { ASK_CHOICES, ASK_ROOT_CHECK, askQuestionIssues } from "./ask-question.ts";
import type { AskChoice } from "./ask-question.ts";

const id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", minLength: 36, maxLength: 36 });
const base = { repoId: Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 }), requirementId: id,
  savedOperationId: id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) };
const actions = Type.Array(StringEnum(["analyze", "plan", "implement", "commit", "push"] as const), { uniqueItems: true, maxItems: 5 });
const question = Type.String({ minLength: 1, maxLength: 400 });
const confirmationPurpose = Type.Optional(Type.Literal("user-confirmation"));
const schemas = {
  ask: Type.Object({ purpose: confirmationPurpose, action: Type.Literal("ask"), ...base, question, rootCheck: ASK_ROOT_CHECK, choices: ASK_CHOICES, scope: question, unitIds: ApprovalUnitIds, actions }, { additionalProperties: false }),
  reply: Type.Object({ purpose: confirmationPurpose, action: Type.Literal("reply"), ...base, operationId: Type.Optional(id) }, { additionalProperties: false }),
} satisfies Record<string, TSchema>;
const ADJUDICATE_PARAMETERS = Type.Object({ purpose: Type.Literal("adjudicate"), action: Type.Literal("reply"), repoId: base.repoId,
  requirementId: base.requirementId, itemId: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}$" }),
  itemVersion: Type.String({ pattern: "^(task|requirement|report):[0-9a-f-]{36}:[1-9][0-9]{0,15}$" }) }, { additionalProperties: false });

const PANEL_ITEM_ASK_PARAMETERS = Type.Object({ purpose: Type.Literal("panel-item"), action: Type.Literal("ask"), repoId: base.repoId, requirementId: base.requirementId,
  itemId: Type.String({ pattern: "^(task|report|requirement|halt|plan|stall|question|intake):[0-9a-f-]{36}$" }),
  itemVersion: Type.String({ minLength: 1, maxLength: 200 }), question, rootCheck: ASK_ROOT_CHECK, choices: ASK_CHOICES }, { additionalProperties: false });

const variants = {
  "user-confirmation:ask": schemas.ask, "user-confirmation:reply": schemas.reply,
  "adjudicate:reply": ADJUDICATE_PARAMETERS,
  "panel-item:ask": PANEL_ITEM_ASK_PARAMETERS,
  "pm-intake:ask": PM_INTAKE_ASK_PARAMETERS, "pm-intake:forward": PM_INTAKE_FORWARD_PARAMETERS, "pm-intake:reply": PM_INTAKE_REPLY_PARAMETERS,
} satisfies Record<string, TObject>;
export const USER_INTERACT_PARAMETERS = requestParameters(Object.values(variants));

interface AskView { caption?: string; question?: string; status?: string; answer?: { text: string; choice?: number; other?: boolean } | null }
type AskArgs = { request?: { action?: string; question?: string; choices?: AskChoice[] } };
type RenderTheme = { fg(kind: string, text: string): string; bold(text: string): string };

// 只有提问改样式；其余动作抛错，由 pi 退回它的默认显示
function askRequest(args: unknown): NonNullable<AskArgs["request"]> {
  const request = (args as AskArgs | undefined)?.request;
  if (request?.action !== "ask") throw new Error("not_ask");
  return request;
}

type AskState = { view?: AskView; header?: Text };

function askHeader(theme: RenderTheme, caption: string): string {
  return `${theme.bold("提问")}  ${theme.fg("muted", caption)}`;
}

function renderAskCall(args: unknown, theme: RenderTheme, context: { state: AskState }): Text {
  const request = askRequest(args);
  context.state.header = new Text(askHeader(theme, context.state.view?.caption ?? request.question ?? ""), 0, 0);
  return context.state.header;
}

function renderAskResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, theme: RenderTheme,
  context: { args: unknown; state: AskState; isError: boolean }): Text {
  const request = askRequest(context.args);
  if (context.isError) {
    const reason = result.content.map((block) => block.text ?? "").join("").match(/^原因：(.*)$/mu)?.[1] ?? "";
    return new Text(theme.fg("error", `没有登记：${reason}`), 0, 0);
  }
  const view = result.details as AskView;
  // 只原地改标题：在这里让 pi 重画整块会重入它正在进行的重画，问答块被加进去两份
  if (context.state.view !== view) { context.state.view = view; context.state.header?.setText(askHeader(theme, view.caption ?? request.question ?? "")); }
  const choice = view.answer?.choice ? request.choices?.[view.answer.choice - 1] : undefined;
  const answer = !view.answer ? theme.fg("muted", "你暂不回答，问题保留。")
    : `${theme.fg("muted", "你的回答  ")}${choice ? `${view.answer.choice}. ${choice.label}${choice.recommended ? theme.fg("success", "（推荐）") : ""}`
      : `${view.answer.text}${theme.fg("muted", "（自己输入）")}`}`;
  return new Text(`\n${view.question ?? ""}\n${answer}`, 0, 0);
}

export function createUserInteractTool(options: {
  interaction: MainRequirementInteraction;
  intake?: MainIntakeInteraction;
}): ToolDefinition<typeof USER_INTERACT_PARAMETERS, unknown> {
  return { name: "one_company_user_interact", label: "需求澄清、决定与接手复核",
    description: "参数写成 {request:{purpose,action,...}}，只填该 purpose 与 action 格式里的字段；ID、版本取自此前工具结果或决策包，不要自编；operationId 由程序生成，平时不填；只有报错或结果给出原操作编号、要续做那次没完成的保存时，才照抄那个编号填进来，并带上原来的内容。默认或purpose=user-confirmation时，ask向用户提问：写明问题本身（question）、根源自检（rootCheck，一两句话说明这个问题针对的根源，以及为什么这些选项是从根源解决而不是临时修补）、2 到 4 个选项（choices，每个写 label 选什么与 reason 一句理由），并恰好把一个选项标为 recommended 且写 recommendedReason；开放式问题也要给出至少 2 个候选答案；scope 用一句话写这个问题涉及的范围，unitIds 填问题涉及的草稿段落编号（标题末尾写的编号，至少一个），actions 只列这个问题真正涉及的动作（analyze、plan、implement、commit、push），没有就填空数组；reply只消费当前真实输入。purpose=pm-intake时，ask创建接手复核请求，forward重取当前请求，reply由真实Main登记四类核对结果；purpose=panel-item时，ask针对面板事项（itemId、itemVersion取自决策包）用同样的问答窗口给出建议：要登记用户决定的事项，选项文字须为决策包写明的固定文字，用户在窗口里的回答可再以purpose=adjudicate登记；其余事项的回答只作为给你的指示；purpose=adjudicate时，reply按用户当前原话登记用户决定（itemVersion取决策包上的版本，事项已变化时被拒）：itemId=task:<任务ID>时为待裁决任务的再给一次机会（须有轮数）、调整目标或范围、终止任务；itemId=requirement:<需求ID>时为取消或拒绝整个需求；itemId=report:<报告ID>时为验收通过或返工PM的完成报告；取消、拒绝或通过登记后以返回的decisionId作为workflow_manage close的receiptId；原话不清楚时不登记；不接受主体、角色、回执、理解正文或绑定字段。",
    promptSnippet: "按明确purpose处理用户确认或PM接手复核", parameters: USER_INTERACT_PARAMETERS, executionMode: "sequential",
    renderCall: (args, theme, context) => renderAskCall(args, theme, context),
    renderResult: (result, _options, theme, context) => renderAskResult(result, theme, context),
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
    if (key === "user-confirmation:ask" || key === "panel-item:ask") {
      const issues = askQuestionIssues(raw as { question?: unknown; rootCheck?: unknown; choices?: unknown });
      if (issues.length) throw new HostAuthorizationError("question_format", issues.join("；"));
    }
    if (!Value.Check(variant, raw)) throw new HostAuthorizationError("invalid_shape", shapeIssue(variant, raw));
    if (raw.purpose === "pm-intake") {
      if (!options.intake) throw new HostAuthorizationError("pm_intake_unavailable");
      // 没有原因说明的下层错误不回传原始消息，免得带出接手理解正文
    try { return await options.intake.execute(toolCallId, raw, ctx, signal); }
    catch (error) { throw adviceOf(error) ? error : new HostAuthorizationError("interaction_denied"); }
    }
    if (raw.purpose === "panel-item") {
      const p = raw as Static<typeof PANEL_ITEM_ASK_PARAMETERS>;
      return options.interaction.execute(toolCallId, ctx, p.repoId, { ...p }, async () => {
        signal?.throwIfAborted();
        return options.interaction.askPanelItem(ctx, p, signal ?? ctx.signal);
      }, signal ?? ctx.signal);
    }
    if (raw.purpose === "adjudicate") {
      const p = raw as { repoId: string; requirementId: string; itemId: string; itemVersion: string };
      return options.interaction.execute(toolCallId, ctx, p.repoId, { ...p }, async () => {
        signal?.throwIfAborted();
        return options.interaction.adjudicate(ctx, { repoId: p.repoId, requirementId: p.requirementId, itemId: p.itemId, itemVersion: p.itemVersion });
      }, signal ?? ctx.signal);
    }
    const normalized = structuredClone(raw) as Record<string, unknown>;
    delete normalized.purpose;
    const p = normalized as Record<string, unknown> & { action: "ask" | "reply"; repoId: string; requirementId: string;
      operationId: string; savedOperationId: string; version: number; question?: string; rootCheck?: string; choices?: AskChoice[]; scope?: string; unitIds?: string[]; actions?: never[] };
    const resume = p.action === "reply" && p.operationId !== undefined;
    if (!resume) p.operationId = uuidv7();
    return options.interaction.execute(toolCallId, ctx, p.repoId, p, async () => {
      signal?.throwIfAborted();
      return p.action === "ask" ? options.interaction.ask(ctx, { ...p, question: p.question!, rootCheck: p.rootCheck!, choices: p.choices!, scope: p.scope!, unitIds: p.unitIds!, actions: p.actions! }, signal ?? ctx.signal)
        : options.interaction.confirm(ctx, p, resume);
    }, signal ?? ctx.signal);
  }
}
