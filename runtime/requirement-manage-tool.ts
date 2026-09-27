import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { HostAuthorizationError } from "./host-authorization.ts";
import { MainRequirementInteraction } from "./main-requirement-interaction.ts";
import { PROD_SECTION_ID_PATTERN } from "./prod-view.ts";
import { requestParameters, shapeIssue, unwrapRequest } from "./tool-request.ts";
export type { OpenRequirementService, RequirementManageHostContext, RequirementServiceHandle } from "./main-requirement-interaction.ts";
const id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", minLength: 36, maxLength: 36 });
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const paging = { cursor: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$", maxLength: 64 })), maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 16_384 })) };
const actions = {
  create: Type.Object({ action: Type.Literal("create"), repoId, requestId: id, operationId: id, title: Type.String({ maxLength: 1024 }), body: Type.String({ maxLength: 65_536 }) }, { additionalProperties: false }),
  updateDraft: Type.Object({ action: Type.Literal("updateDraft"), repoId, requirementId: id, operationId: id, version, title: Type.String({ maxLength: 1024 }), body: Type.String({ maxLength: 65_536 }) }, { additionalProperties: false }),
  confirmUpdate: Type.Object({ action: Type.Literal("confirmUpdate"), repoId, requirementId: id, savedOperationId: id, operationId: id, version }, { additionalProperties: false }),
  read: Type.Object({ action: Type.Literal("read"), repoId, requirementId: id, source: Type.Optional(StringEnum(["saved", "approved"] as const)), sectionId: Type.Optional(Type.String({ pattern: PROD_SECTION_ID_PATTERN, maxLength: 96 })), ...paging }, { additionalProperties: false }),
  diff: Type.Object({ action: Type.Literal("diff"), repoId, requirementId: id, fromRevision: version, toRevision: Type.Optional(version), ...paging }, { additionalProperties: false }),
  metadata: Type.Object({ action: Type.Literal("metadata"), repoId, requirementId: id }, { additionalProperties: false }),
};
export const REQUIREMENT_MANAGE_PARAMETERS = requestParameters(Object.values(actions));
export function createRequirementManageTool(options: { interaction: MainRequirementInteraction }): ToolDefinition<typeof REQUIREMENT_MANAGE_PARAMETERS, Record<string, unknown>> {
  const interaction = options.interaction;
  return { name: "pi_company_requirement_manage", label: "管理活动需求",
    description: "参数写成 {request:{action,...}}，只填该 action 格式里的字段；requestId、operationId 每次新生成 UUIDv7，requirementId、version、savedOperationId 取自此前工具结果，不要自编。保存需求草稿；正文按场景分节，每个标题（含各级小节标题）末尾都写稳定编号如「## 地面快跑 {#sprint}」「### 验收 {#sprint.acceptance}」（字母开头，只含字母数字._-，不重复），缺一个编号整篇只能作一段批准；confirmUpdate只接真实saved操作ID，不接正文或批准声明。只消费当前真实用户输入。read默认当前approved，草稿可指定saved，章节及UTF8分页逐次核权，完整封装不超过50KiB。无当前输入或模型不可用明确拒绝，不弹全量审批。",
    promptSnippet: "整理当前需求、按范围记录决定，读取当前获准目标", parameters: REQUIREMENT_MANAGE_PARAMETERS, executionMode: "sequential",
    async execute(toolCallId, raw, signal, _update, ctx) {
      signal?.throwIfAborted();
      const request = unwrapRequest(raw) as { action?: unknown } | undefined;
      if (!request || typeof request !== "object") throw new HostAuthorizationError("invalid_shape", "参数须为 { request: { action, ... } }");
      const action = String(request.action);
      if (!Object.hasOwn(actions, action)) throw new HostAuthorizationError("invalid_shape", `可用 action：${Object.keys(actions).join("、")}`);
      const schema = actions[action as keyof typeof actions];
      if (!Value.Check(schema, request)) throw new HostAuthorizationError("invalid_shape", shapeIssue(schema, request));
      if (Buffer.byteLength(JSON.stringify(request)) > 65_536) throw new HostAuthorizationError("invalid_shape", "参数超过 64KiB");
      const p = structuredClone(request) as Static<(typeof actions)[keyof typeof actions]>;
      return interaction.execute(toolCallId, ctx, p.repoId, p, async () => {
        signal?.throwIfAborted();
        switch (p.action) {
          case "create": return interaction.draft(ctx, p.repoId, "create", { requestId: p.requestId!, operationId: p.operationId!, title: p.title!, body: p.body! });
          case "updateDraft": return interaction.draft(ctx, p.repoId, "updateDraft", { requirementId: p.requirementId!, operationId: p.operationId!, version: p.version!, title: p.title!, body: p.body! });
          case "confirmUpdate": return interaction.confirm(ctx, { repoId: p.repoId, requirementId: p.requirementId!, savedOperationId: p.savedOperationId!, operationId: p.operationId!, version: p.version! });
          case "read": case "diff": return interaction.read(ctx, { ...p, action: p.action, requirementId: p.requirementId! });
          case "metadata": return interaction.metadata(ctx, p.repoId, p.requirementId!);
        }
      }, signal ?? ctx.signal);
    } };
}
