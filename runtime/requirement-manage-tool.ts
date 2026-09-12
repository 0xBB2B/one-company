import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";
import { HostAuthorizationError, HostAuthorizationManager } from "./host-authorization.ts";
import type { HostOperationBinding, TargetConfirmationScope } from "./host-authorization.ts";
import {
  ConfirmUpdateInput,
  CreateRequirementInput,
  DiffRequirementInput,
  MetadataRequirementInput,
  ReadRequirementInput,
  RequirementServiceError,
  UpdateDraftInput,
  requirementIntentHash,
} from "./requirement-manage-contracts.ts";
import { RequirementService } from "./requirement-service.ts";
import { ShortDecisionStore } from "./short-decisions.ts";
import type {
  RequirementDiffResult,
  RequirementMetadataResult,
  RequirementReadResult,
  RequirementReceipt,
  ServiceAuthorizationRequest,
} from "./requirement-manage-contracts.ts";

const REPO_ID_PATTERN = "^[0-9a-f]{64}$";
const publicParameters = Type.Object({
  action: StringEnum(["create", "updateDraft", "confirmUpdate", "read", "diff", "metadata"] as const),
  repoId: Type.String({ pattern: REPO_ID_PATTERN }),
  requestId: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN.source })),
  operationId: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN.source })),
  requirementId: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN.source })),
  version: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  source: Type.Optional(StringEnum(["saved", "approved"] as const)),
  fromRevision: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  toRevision: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });

export const REQUIREMENT_MANAGE_PARAMETERS = publicParameters;

export interface RequirementServiceHandle {
  create(input: Static<typeof CreateRequirementInput>): Promise<RequirementReceipt>;
  updateDraft(input: Static<typeof UpdateDraftInput>): Promise<RequirementReceipt>;
  confirmUpdate(input: Static<typeof ConfirmUpdateInput>): Promise<RequirementReceipt>;
  read(input: Static<typeof ReadRequirementInput>): Promise<RequirementReadResult>;
  diff(input: Static<typeof DiffRequirementInput>): Promise<RequirementDiffResult>;
  metadata(requirementId: Static<typeof MetadataRequirementInput>): Promise<RequirementMetadataResult>;
  close?: () => void;
}

export interface OpenRequirementServiceInput {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  gitExecutable: string;
  authorize: (request: ServiceAuthorizationRequest) => boolean;
}

export type OpenRequirementService = (input: OpenRequirementServiceInput) => Promise<RequirementServiceHandle>;

export interface RequirementManageHostContext {
  readonly windowId: string;
  readonly sessionId: string;
  readonly repositories: ReadonlyMap<string, { readonly path: string }>;
}

export interface CreateRequirementManageToolOptions {
  readonly dataRoot: string;
  readonly gitExecutable: string;
  readonly authorization: HostAuthorizationManager;
  readonly resolveHost: (ctx: ExtensionContext) => Promise<RequirementManageHostContext>;
  readonly openService?: OpenRequirementService;
}

interface PublicParams {
  action: "create" | "updateDraft" | "confirmUpdate" | "read" | "diff" | "metadata";
  repoId: string;
  requestId?: string;
  operationId?: string;
  requirementId?: string;
  version?: number;
  title?: string;
  body?: string;
  source?: "saved" | "approved";
  fromRevision?: number;
  toRevision?: number;
}

const publicActionSchemas = {
  create: Type.Object({ action: Type.Literal("create"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requestId: Type.String({ pattern: UUID_V7_PATTERN.source }), operationId: Type.String({ pattern: UUID_V7_PATTERN.source }), title: Type.String(), body: Type.String() }, { additionalProperties: false }),
  updateDraft: Type.Object({ action: Type.Literal("updateDraft"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requirementId: Type.String({ pattern: UUID_V7_PATTERN.source }), operationId: Type.String({ pattern: UUID_V7_PATTERN.source }), version: Type.Integer({ minimum: 1 }), title: Type.String(), body: Type.String() }, { additionalProperties: false }),
  confirmUpdate: Type.Object({ action: Type.Literal("confirmUpdate"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requirementId: Type.String({ pattern: UUID_V7_PATTERN.source }), operationId: Type.String({ pattern: UUID_V7_PATTERN.source }), version: Type.Integer({ minimum: 1 }), title: Type.String(), body: Type.String() }, { additionalProperties: false }),
  read: Type.Object({ action: Type.Literal("read"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requirementId: Type.String({ pattern: UUID_V7_PATTERN.source }), source: StringEnum(["saved", "approved"] as const) }, { additionalProperties: false }),
  diff: Type.Object({ action: Type.Literal("diff"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requirementId: Type.String({ pattern: UUID_V7_PATTERN.source }), fromRevision: Type.Integer({ minimum: 1 }), toRevision: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
  metadata: Type.Object({ action: Type.Literal("metadata"), repoId: Type.String({ pattern: REPO_ID_PATTERN }), requirementId: Type.String({ pattern: UUID_V7_PATTERN.source }) }, { additionalProperties: false }),
} as const;

async function defaultOpenService(input: OpenRequirementServiceInput): Promise<RequirementServiceHandle> {
  return RequirementService.open(input);
}

function checkedParams(value: unknown): PublicParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequirementServiceError("invalid_shape", "参数不符合固定字段白名单");
  const action = (value as { action?: unknown }).action;
  if (typeof action !== "string" || !(action in publicActionSchemas)) throw new RequirementServiceError("invalid_action", "未知 requirement_manage action");
  if (!Value.Check(publicActionSchemas[action as keyof typeof publicActionSchemas], value)) throw new RequirementServiceError("invalid_shape", "参数不符合该 action 的固定字段白名单");
  return structuredClone(value) as PublicParams;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value as Record<string, unknown> };
}

function currentSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function ensureHostMatches(host: RequirementManageHostContext, ctx: ExtensionContext, authorization: HostAuthorizationManager): void {
  const sessionId = currentSessionId(ctx);
  if (host.sessionId !== sessionId) throw new HostAuthorizationError("stale_session", "工具上下文与当前 session 不一致");
  const principal = authorization.assertCurrentSession(sessionId);
  if (principal.windowId !== host.windowId) throw new HostAuthorizationError("stale_window", "工具上下文与当前 lifecycle 窗口不一致");
}

async function withService<T>(options: CreateRequirementManageToolOptions, host: RequirementManageHostContext, binding: HostOperationBinding, run: (service: RequirementServiceHandle) => Promise<T>): Promise<T> {
  const repository = host.repositories.get(binding.repoId);
  if (!repository) throw new HostAuthorizationError("foreign_repo", "repoId 不属于已接入 workspace");
  options.authorization.prepareRepository(binding.repoId, host.sessionId);
  const service = await (options.openService ?? defaultOpenService)({
    repositoryRoot: repository.path,
    dataRoot: options.dataRoot,
    repoId: binding.repoId,
    gitExecutable: options.gitExecutable,
    authorize: options.authorization.authorizer(binding, host.sessionId),
  });
  try {
    return await run(service);
  } finally {
    service.close?.();
  }
}

async function loadMetadata(options: CreateRequirementManageToolOptions, host: RequirementManageHostContext, repoId: string, requirementId: string): Promise<RequirementMetadataResult> {
  return withService(options, host, { action: "metadata", repoId, requirementId }, (service) => service.metadata(requirementId));
}

function activeMetadata(metadata: RequirementMetadataResult): void {
  if (metadata.lifecycle !== "draft" && metadata.lifecycle !== "active") throw new HostAuthorizationError("lifecycle_denied", "closing/closed 需求只允许读取 metadata");
  if (metadata.recovery !== "ready") throw new HostAuthorizationError("recovery_required", "需求状态需要恢复，拒绝正文读取与目标确认");
}

async function confirmationReceipt(options: CreateRequirementManageToolOptions, host: RequirementManageHostContext, params: Required<Pick<PublicParams, "repoId" | "requirementId" | "operationId" | "version" | "title" | "body">>, ctx: ExtensionContext) {
  const intentHash = requirementIntentHash({ title: params.title, body: params.body });
  const before = await loadMetadata(options, host, params.repoId, params.requirementId);
  activeMetadata(before);
  const scope: TargetConfirmationScope = { action: "confirmUpdate", purpose: "target-confirmation", implementation: "not-authorized", repoId: params.repoId,
    requirementId: params.requirementId, operationId: params.operationId, intentHash, epoch: before.epoch, version: params.version };
  const lookup = options.authorization.confirmation(scope, host.sessionId);
  if (lookup.status === "valid") return { receipt: lookup.receipt, intentHash, epoch: before.epoch };
  if (lookup.status !== "missing") throw new HostAuthorizationError(`receipt_${lookup.status}`, "已有 operationId 的授权回执已过期、撤销或与当前目标不符");
  if (before.version !== params.version) throw new HostAuthorizationError("stale_version", "确认目标绑定的 version 已变化");
  if (!ctx.hasUI) throw new HostAuthorizationError("ui_required", "目标确认需要真实宿主 UI");
  const approved = await ctx.ui.confirm(
    "确认需求目标",
    `本操作仅确认需求目标，不授权规划、派工、代码修改或其他实施动作。\n\n需求 ${params.requirementId}\n目标指纹 ${intentHash}\n\n标题：${params.title}\n\n${params.body}`,
  );
  if (!approved) throw new HostAuthorizationError("user_declined", "用户取消或拒绝目标确认");
  const after = await loadMetadata(options, host, params.repoId, params.requirementId);
  activeMetadata(after);
  if (after.epoch !== before.epoch || after.version !== before.version) throw new HostAuthorizationError("authorization_stale", "确认期间需求 epoch/version 已变化");
  const baseline = before.lifecycle === "active" ? before.approved : before.saved;
  const receipt = options.authorization.recordConfirmation(scope, host.sessionId,
    baseline ? { commit: baseline.commit, hash: baseline.prodHash.slice("sha256:".length) } : null);
  return { receipt, intentHash, epoch: before.epoch };
}

async function persistTargetDecision(
  options: CreateRequirementManageToolOptions,
  host: RequirementManageHostContext,
  binding: Extract<HostOperationBinding, { action: "confirmUpdate" }>,
  receipt: Awaited<ReturnType<typeof confirmationReceipt>>["receipt"],
  title: string,
): Promise<void> {
  const authorize = options.authorization.authorizer(binding, host.sessionId);
  const request: ServiceAuthorizationRequest = { ...binding, prodHash: undefined };
  const repository = host.repositories.get(binding.repoId);
  if (!repository) throw new HostAuthorizationError("foreign_repo");
  const decisions = await ShortDecisionStore.open({
    repositoryRoot: repository.path, dataRoot: options.dataRoot, repoId: binding.repoId,
    authorize: ({ action, repoId }) => repoId === binding.repoId && ["open", "read", "record-decisions"].includes(action) && authorize(request),
    admit: ({ requestHash, batch }) => {
      if (!authorize(request) || batch.requirementId !== binding.requirementId || batch.operationId !== binding.operationId
        || batch.version !== receipt.scope.version || batch.epoch !== receipt.scope.epoch
        || JSON.stringify(batch.prod) !== JSON.stringify(receipt.baseline)) return null;
      return { requestHash, subjects: batch.decisions.map(() => ({ actor: "user" as const, status: "confirmed" as const, basisReceiptId: receipt.receiptId })) };
    },
  });
  decisions.append(JSON.stringify({ operationId: binding.operationId, requirementId: binding.requirementId,
    version: receipt.scope.version, epoch: receipt.scope.epoch, prod: receipt.baseline,
    decisions: [{ conclusion: `确认需求目标：${title}`, scope: "确认请求所绑定的目标变更；保存及状态登记成功后生效，实施权限须另行核验。",
      references: [`confirmation:${receipt.receiptId}`], supersedes: [] }] }));
}

export function createRequirementManageTool(options: CreateRequirementManageToolOptions): ToolDefinition<typeof publicParameters, Record<string, unknown>> {
  return {
    name: "pi_company_requirement_manage",
    label: "管理活动需求",
    description: "创建、保存、确认或读取当前活动需求。参数不接受角色、主体、路径、提交哈希或授权声明；关闭需求只返回 metadata。",
    promptSnippet: "通过受控入口创建、确认或读取活动需求",
    parameters: publicParameters,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const params = checkedParams(rawParams);
      const host = await options.resolveHost(ctx);
      ensureHostMatches(host, ctx, options.authorization);
      if (!host.repositories.has(params.repoId)) throw new HostAuthorizationError("foreign_repo", "repoId 不属于已接入 workspace");

      switch (params.action) {
        case "create": {
          const input = { requestId: params.requestId!, operationId: params.operationId!, title: params.title!, body: params.body! };
          const intentHash = requirementIntentHash({ title: input.title, body: input.body });
          const binding: HostOperationBinding = { action: "create", repoId: params.repoId, requestId: input.requestId, operationId: input.operationId, intentHash };
          return textResult(await withService(options, host, binding, (service) => service.create(input)));
        }
        case "updateDraft": {
          const input = { requirementId: params.requirementId!, operationId: params.operationId!, version: params.version!, title: params.title!, body: params.body! };
          const binding: HostOperationBinding = { action: "updateDraft", repoId: params.repoId, requirementId: input.requirementId,
            operationId: input.operationId, version: input.version, intentHash: requirementIntentHash({ title: input.title, body: input.body }) };
          return textResult(await withService(options, host, binding, (service) => service.updateDraft(input)));
        }
        case "confirmUpdate": {
          const confirmation = await confirmationReceipt(options, host, params as Required<Pick<PublicParams, "repoId" | "requirementId" | "operationId" | "version" | "title" | "body">>, ctx);
          const input = { requirementId: params.requirementId!, operationId: params.operationId!, version: params.version!, title: params.title!, body: params.body!, receiptId: confirmation.receipt.receiptId };
          const binding: HostOperationBinding = { action: "confirmUpdate", repoId: params.repoId, requirementId: input.requirementId,
            operationId: input.operationId, version: input.version, intentHash: confirmation.intentHash, epoch: confirmation.epoch, receiptId: input.receiptId };
          await persistTargetDecision(options, host, binding, confirmation.receipt, input.title);
          return textResult(await withService(options, host, binding, (service) => service.confirmUpdate(input)));
        }
        case "read": {
          const input = { requirementId: params.requirementId!, source: params.source! };
          const action = input.source === "saved" ? "readSaved" : "readApproved";
          return textResult(await withService(options, host, { action, repoId: params.repoId, requirementId: input.requirementId }, (service) => service.read(input)));
        }
        case "diff": {
          const input = { requirementId: params.requirementId!, fromRevision: params.fromRevision!, ...(params.toRevision === undefined ? {} : { toRevision: params.toRevision }) };
          return textResult(await withService(options, host, { action: "diff", repoId: params.repoId, requirementId: input.requirementId }, (service) => service.diff(input)));
        }
        case "metadata":
          return textResult(await loadMetadata(options, host, params.repoId, params.requirementId!));
      }
    },
  };
}
