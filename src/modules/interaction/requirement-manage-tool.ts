import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { uuidv7 } from "../../core/storage/database.ts";
import { HostAuthorizationError } from "../requirement/host-authorization.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import { PRD_SECTION_ID_PATTERN } from "../requirement/prd-view.ts";
import { requestParameters, shapeIssue, unwrapRequest } from "../../core/exec/tool-request.ts";
import { toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { SUMMARY_MAX_CHARS } from "../requirement/requirement-summary.ts";
export type { OpenRequirementService, RequirementManageHostContext, RequirementServiceHandle } from "./main-requirement-interaction.ts";
const id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", minLength: 36, maxLength: 36 });
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const summary = Type.String({ minLength: 1, maxLength: SUMMARY_MAX_CHARS });
const paging = { maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 16_384 })) };
const actions = {
  create: Type.Object({ action: Type.Literal("create"), repoId, summary, title: Type.String({ maxLength: 1024 }), body: Type.String({ maxLength: 65_536 }) }, { additionalProperties: false }),
  updateDraft: Type.Object({ action: Type.Literal("updateDraft"), repoId, requirementId: id, version, summary, title: Type.String({ maxLength: 1024 }), body: Type.String({ maxLength: 65_536 }) }, { additionalProperties: false }),
  confirmUpdate: Type.Object({ action: Type.Literal("confirmUpdate"), repoId, requirementId: id, savedOperationId: id, version }, { additionalProperties: false }),
  read: Type.Object({ action: Type.Literal("read"), repoId, requirementId: id, source: Type.Optional(StringEnum(["saved", "approved"] as const)), sectionId: Type.Optional(Type.String({ pattern: PRD_SECTION_ID_PATTERN, maxLength: 96 })), ...paging }, { additionalProperties: false }),
  diff: Type.Object({ action: Type.Literal("diff"), repoId, requirementId: id, fromRevision: version, toRevision: Type.Optional(version), ...paging }, { additionalProperties: false }),
  next: Type.Object({ action: Type.Literal("next"), repoId, requirementId: id, cursor: Type.String({ pattern: "^[0-9a-f]{64}$", maxLength: 64 }) }, { additionalProperties: false }),
  metadata: Type.Object({ action: Type.Literal("metadata"), repoId, requirementId: id }, { additionalProperties: false }),
  list: Type.Object({ action: Type.Literal("list"), repoId: Type.Optional(repoId) }, { additionalProperties: false }),
};
export const REQUIREMENT_MANAGE_PARAMETERS = requestParameters(Object.values(actions));
export function createRequirementManageTool(options: { interaction: MainRequirementInteraction }): ToolDefinition<typeof REQUIREMENT_MANAGE_PARAMETERS, Record<string, unknown>> {
  const interaction = options.interaction;
  return { name: "one_company_requirement_manage", label: "管理活动需求",
    description: "参数写成 {request:{action,...}}，只填该 action 格式里的字段；requirementId、version、savedOperationId 取自此前工具结果，不要自编。保存需求草稿，create 与 updateDraft 都要写 summary：一段话（最多 200 字）说明这个功能是什么，用户批准时的确认窗口会显示它；正文板块按系统提示里的需求文档规范写，每个标题（含各级小节标题）末尾都写唯一编号（字母开头，只含字母数字._-，不重复），缺编号或重复时批准被拒；confirmUpdate只接真实saved操作ID，不接正文或批准声明。只消费当前真实用户输入。list 列出本窗口各仓库草稿与进行中需求的编号、标题与状态（不含正文，不列已关闭的），给 repoId 时只列该仓库；不知道需求编号时先 list。read默认当前approved，草稿可指定saved，章节及UTF8分页逐次核权，完整封装不超过50KiB；结果的coverage.nextCursor不为空时，用next带上它读下一页。无当前输入或模型不可用明确拒绝。",
    promptSnippet: "整理当前需求、按范围记录决定，读取当前获准目标", parameters: REQUIREMENT_MANAGE_PARAMETERS, executionMode: "sequential",
    async execute(toolCallId, raw, signal, _update, ctx) {
      try { return await run(toolCallId, raw, signal, ctx); }
      catch (error) { throw toolFailure(toolStep("one_company_requirement_manage", unwrapRequest(raw) ?? raw), error); }
    } };
  async function run(toolCallId: string, raw: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    signal?.throwIfAborted();
    const request = unwrapRequest(raw) as { action?: unknown } | undefined;
    if (!request || typeof request !== "object") throw new HostAuthorizationError("invalid_shape", "参数须为 { request: { action, ... } }");
    const action = String(request.action);
    if (!Object.hasOwn(actions, action)) throw new HostAuthorizationError("invalid_shape", `可用 action：${Object.keys(actions).join("、")}`);
    const schema = actions[action as keyof typeof actions];
    if (!Value.Check(schema, request)) throw new HostAuthorizationError("invalid_shape", shapeIssue(schema, request));
    if (Buffer.byteLength(JSON.stringify(request)) > 65_536) throw new HostAuthorizationError("invalid_shape", "参数超过 64KiB");
    const p = structuredClone(request) as Static<(typeof actions)[keyof typeof actions]>;
    if (p.action === "list") return interaction.list(toolCallId, ctx, p.repoId);
    return interaction.execute(toolCallId, ctx, p.repoId, p, async () => {
      signal?.throwIfAborted();
      switch (p.action) {
        case "create": return interaction.draft(ctx, p.repoId, "create", { title: p.title!, body: p.body! }, p.summary!);
        case "updateDraft": return interaction.draft(ctx, p.repoId, "updateDraft", { requirementId: p.requirementId!, version: p.version!, title: p.title!, body: p.body! }, p.summary!);
        case "confirmUpdate": return interaction.confirm(ctx, { repoId: p.repoId, requirementId: p.requirementId!, savedOperationId: p.savedOperationId!, operationId: uuidv7(), version: p.version! });
        case "read": case "diff": return interaction.read(ctx, { ...p, action: p.action, requirementId: p.requirementId! });
        case "next": return interaction.read(ctx, { action: "next", repoId: p.repoId, requirementId: p.requirementId!, cursor: p.cursor! });
        case "metadata": return interaction.metadata(ctx, p.repoId, p.requirementId!);
      }
    }, signal ?? ctx.signal);
  }
}
