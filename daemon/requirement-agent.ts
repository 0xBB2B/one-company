import { resolve as resolvePath, sep } from "node:path";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../runtime/clock.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { requirementDataDir, requirementIdentity } from "../runtime/identity.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import type { RoleCatalogEntry } from "../runtime/roles.ts";
import { isTerminalState, RunStore } from "../runtime/run-store.ts";
import type { ShellRegistry } from "../runtime/shell-registry.ts";
import { createDecisionRecordTool } from "../runtime/decision-record-tool.ts";
import { readDocument, withDirLock } from "../runtime/store.ts";
import { STAGE_ORDER } from "../runtime/workflow-state.ts";
import { createWorkflowTool, currentVersion, executeWorkflowAction } from "../runtime/workflow-tool.ts";
import type { RoleSessionGuards, RoleSessionHandle, RoleSessionState, RoleSessionStopOutcome } from "./role-session.ts";
import { bestEffortRealpath, createRoleSession } from "./role-session.ts";

export const AGENT_PARAMETERS = Type.Object(
  {
    action: Type.Union([
      Type.Literal("run"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("list"),
      Type.Literal("cancel"),
      Type.Literal("submit"),
    ]),
    role: Type.Optional(Type.String()),
    task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
    instructions: Type.Optional(Type.String()),
    writePaths: Type.Optional(Type.Array(Type.String())),
    readPaths: Type.Optional(Type.Array(Type.String())),
    dependencies: Type.Optional(Type.Array(Type.String())),
    outputSchema: Type.Optional(Type.Unknown()),
    runId: Type.Optional(Type.String()),
    result: Type.Optional(Type.Unknown()),
    reportPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ASK_PARAMETERS = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.String() }, { additionalProperties: false }))),
    recommended: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PROPOSE_SHAPE_PARAMETERS = Type.Object(
  {
    tasks: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          title: Type.String(),
          roles: Type.Array(Type.String()),
          dependsOn: Type.Array(Type.String()),
          writePaths: Type.Array(Type.String()),
          waitFor: Type.Optional(Type.Object({ repo: Type.String(), requirement: Type.String(), stage: Type.String() }, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    gates: Type.Object({ whiteboxReview: Type.Boolean(), blackboxAcceptance: Type.Boolean() }, { additionalProperties: false }),
    rationale: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface ShapeTaskDeclaration {
  id: string;
  title: string;
  roles: string[];
  dependsOn: string[];
  writePaths: string[];
  waitFor?: { repo: string; requirement: string; stage: string };
}

export interface ShapeDeclaration {
  tasks: ShapeTaskDeclaration[];
  gates: { whiteboxReview: boolean; blackboxAcceptance: boolean };
  skipped: Array<{ gate: string; decisionId: string }>;
  acceptanceReport: string | null;
  decisionId: string;
}

interface RequirementStateLike {
  stage: string;
  shape: ShapeDeclaration | null;
  tasks: Record<string, unknown>;
  followUps: unknown[];
}

export interface RequirementAgentDispatch {
  dispatchRole(input: {
    role: string;
    task: string;
    instructions?: string;
    writePaths: string[];
    readPaths: string[];
    reportPath?: string;
  }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  status(runId: string): Promise<{ ok: true; state: string } | { ok: false; reason: string }>;
  wait(runId: string): Promise<{ ok: true; state: string } | { ok: false; reason: string }>;
  list(): Promise<Array<{ runId: string; role: string; task: string; state: string }>>;
  cancel(runId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RequirementAgentRelay {
  ask(
    input: {
      question: string;
      options?: Array<{ label: string; description: string }>;
      recommended?: string;
      repoId: string;
      requirement: string;
    },
    opts?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface CreateRequirementAgentSessionOptions {
  dataRoot: string;
  repoId: string;
  requirement: string;
  cwd: string;
  role: RoleCatalogEntry;
  roleCatalog: RoleCatalogEntry[];
  runtime: ModelRuntime;
  modelRef: { provider: string; id: string };
  clock: Clock;
  shellRegistry: ShellRegistry;
  guards: RoleSessionGuards;
  networkGate: NetworkPauseGate;
  dispatch: RequirementAgentDispatch;
  relay: RequirementAgentRelay;
  runStore: RunStore;
  workspaceRepoIds: string[];
}

export type RequirementAgentHandleState = RoleSessionState | "waiting_answer";

export interface RequirementAgentHandle {
  events: RoleSessionHandle["events"];
  state(): RequirementAgentHandleState;
  prompt(text: string): void;
  injectSupplement(text: string): void;
  result(): Promise<unknown>;
  pause(): Promise<{ confirmed: boolean; reason?: string }>;
  resume(): Promise<void>;
  stop(): Promise<RoleSessionStopOutcome>;
  dispose(): void;
}

export type CreateRequirementAgentSessionResult =
  | { ok: false; reason: string }
  | { ok: true; reused: true; runId: string }
  | { ok: true; reused: false; runId: string; handle: RequirementAgentHandle };

interface RequirementAgentToolContext {
  dataRoot: string;
  repoId: string;
  requirement: string;
  cwd: string;
  roleCatalog: RoleCatalogEntry[];
  roleName: string;
  runId: string;
  runStore: RunStore;
  workspaceRepoIds: string[];
  dispatch: RequirementAgentDispatch;
  relay: RequirementAgentRelay;
  modelRef: { provider: string; id: string };
}

const BLOCKED_STAGES = new Set(["draft", "rejected", "accepted"]);
const REPO_ID_PATTERN = /^[0-9a-f]{64}$/;

async function queryRequirementState(ctx: { dataRoot: string; cwd: string; requirement: string }): Promise<{ data: RequirementStateLike; version: number }> {
  const result = await executeWorkflowAction({ action: "query", requirement: ctx.requirement }, { dataRoot: ctx.dataRoot, cwd: ctx.cwd });
  if (result.details.isError) throw new Error(result.text);
  return { data: result.details.data as RequirementStateLike, version: result.details.version as number };
}

export function buildRequirementAgentPrompt(input: {
  requirement: string;
  cwd: string;
  roleCatalog: RoleCatalogEntry[];
  shape: ShapeDeclaration | null;
}): string {
  const catalogList = input.roleCatalog
    .filter((entry) => entry.available && entry.definition)
    .map((entry) => `- ${entry.name}：${entry.definition!.description.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const sections = [
    `## 需求身份与工作目录\n需求：${input.requirement}\n工作目录：${input.cwd}`,
    `## 规范索引与需求文档位置\n规范索引位于仓库 .pi-company/spec/INDEX.md（术语表在同目录 GLOSSARY.md）；本需求文档位于仓库内 .pi-company/requirements/${input.requirement}/。`,
    `## 可用角色目录\n${catalogList.length > 0 ? catalogList : "无可用角色"}`,
    [
      "## 工具使用规则",
      "- 先经 pi_company_propose_shape 提议任务集与门禁形状并等待确认，未确认前不得派工；形状默认含白盒审查与黑盒验收两项门禁。",
      "- 形状确认成功的回执文本携带规划运行编号；请以该编号先用 pi_company_workflow 的 advance 推进到 planned，再 advance 推进到 executing。",
      "- 状态推进、任务登记、后续问题记录只经 pi_company_workflow。",
      "- 需要用户决策时只经 pi_company_ask 提问。",
      "- 补充需求改变已确认的任务集或形状时须重新提议并等待确认，否则直接并入当前执行。",
      "- 归因为独立问题的条目只经 pi_company_workflow 的 update.followUpIssues 写入后续问题清单，不新增任务、不触发重新提议。",
      "- 不得直接联系其他需求代理。",
    ].join("\n"),
    "## 交付核对要求\n自行完成的任务须先经 pi_company_agent 的 submit 动作提交与实现角色相同的结构化交付，再以其运行编号调用 pi_company_workflow 的 task-finish 核对完成。",
  ];
  if (input.shape) {
    sections.push(`## 当前已确认形状\n${JSON.stringify(input.shape)}`);
  }
  return sections.join("\n\n");
}

function isWorkspaceMember(workspaceRepoIds: string[], repo: string): boolean {
  return REPO_ID_PATTERN.test(repo) && workspaceRepoIds.includes(repo);
}

export async function awaitCrossRepoStage(
  workspaceRepoIds: string[],
  dataRoot: string,
  waitFor: { repo: string; requirement: string; stage: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isWorkspaceMember(workspaceRepoIds, waitFor.repo)) {
    return { ok: false, reason: `等待的仓库不是本工作区成员: ${waitFor.repo}` };
  }
  let path: string;
  let result;
  try {
    path = `${requirementDataDir(dataRoot, waitFor.repo, waitFor.requirement)}/state.json`;
    result = await readDocument(path);
  } catch (error) {
    return { ok: false, reason: `对方仓库需求状态无法读取: ${(error as Error).message}` };
  }
  if (!result.exists) {
    return { ok: false, reason: `对方仓库需求状态不存在: ${waitFor.repo}/${waitFor.requirement}` };
  }
  const data = result.data as { stage: string };
  if (data.stage === "rejected") {
    return { ok: false, reason: `对方仓库需求 ${waitFor.requirement} 已被拒绝，不会到达阶段 ${waitFor.stage}` };
  }
  const targetIndex = (STAGE_ORDER as readonly string[]).indexOf(waitFor.stage);
  const currentIndex = (STAGE_ORDER as readonly string[]).indexOf(data.stage);
  if (targetIndex === -1 || currentIndex === -1 || currentIndex < targetIndex) {
    return { ok: false, reason: `对方仓库需求 ${waitFor.requirement} 尚未到达阶段 ${waitFor.stage}（当前 ${data.stage}）` };
  }
  return { ok: true };
}

export function assertShapeAllows(
  shape: ShapeDeclaration | null,
  taskId: string,
  role: string,
): { ok: true; task: ShapeTaskDeclaration } | { ok: false; reason: string } {
  if (!shape) return { ok: false, reason: "尚未确认形状，请先提议并等待确认" };
  const task = shape.tasks.find((entry) => entry.id === taskId);
  if (!task || !task.roles.includes(role)) {
    return { ok: false, reason: `任务 ${taskId} 与角色 ${role} 不在已确认形状内，需重新提议形状` };
  }
  return { ok: true, task };
}

function isWithinRoot(candidateReal: string, rootReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep);
}

export async function checkWritePaths(input: {
  cwd: string;
  writePaths: string[];
  declaredWritePaths: string[];
}): Promise<{ ok: true } | { ok: false; violations: string[] }> {
  const cwdReal = await bestEffortRealpath(resolvePath(input.cwd));
  const declaredReal = await Promise.all(input.declaredWritePaths.map((path) => bestEffortRealpath(resolvePath(input.cwd, path))));
  const violations: string[] = [];
  for (const path of input.writePaths) {
    const real = await bestEffortRealpath(resolvePath(input.cwd, path));
    const withinCwd = isWithinRoot(real, cwdReal);
    const withinDeclared = declaredReal.some((declared) => isWithinRoot(real, declared));
    if (!withinCwd || !withinDeclared) violations.push(path);
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

async function validateProposedShape(
  params: { tasks: ShapeTaskDeclaration[] },
  ctx: RequirementAgentToolContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cwdReal = await bestEffortRealpath(resolvePath(ctx.cwd));
  for (const task of params.tasks) {
    if (!/^T-\d+$/.test(task.id)) return { ok: false, reason: `任务 id 不合法: ${task.id}` };
    for (const role of task.roles) {
      const entry = ctx.roleCatalog.find((candidate) => candidate.name === role);
      if (!entry || !entry.available) return { ok: false, reason: `角色不在目录内: ${role}` };
    }
    for (const path of task.writePaths) {
      const real = await bestEffortRealpath(resolvePath(ctx.cwd, path));
      if (!isWithinRoot(real, cwdReal)) return { ok: false, reason: `写入路径越出 cwd: ${path}` };
    }
    if (task.waitFor) {
      try {
        requirementIdentity(task.waitFor.requirement);
      } catch {
        return { ok: false, reason: `等待的需求名格式非法: ${task.waitFor.requirement}` };
      }
      if (!isWorkspaceMember(ctx.workspaceRepoIds, task.waitFor.repo)) {
        return { ok: false, reason: `等待的仓库不是本工作区成员: ${task.waitFor.repo}` };
      }
    }
  }
  return { ok: true };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: { isError: false } };
}

export function registerAgentTool(pi: ExtensionAPI, ctx: RequirementAgentToolContext): void {
  pi.registerTool({
    name: "pi_company_agent",
    label: "派出角色",
    description: "在已确认形状内派出角色、查询状态、等待、列出、取消运行，或为自行完成任务提交交付",
    parameters: AGENT_PARAMETERS,
    async execute(_toolCallId, params) {
      if (params.action === "run") {
        const role = params.role;
        const task = params.task;
        if (!role || !task) throw new Error("run 动作缺少 role 或 task");
        const roleEntry = ctx.roleCatalog.find((entry) => entry.name === role);
        if (!roleEntry || !roleEntry.available) throw new Error(`角色不在目录内: ${role}`);

        const state = await queryRequirementState(ctx);
        const allowed = assertShapeAllows(state.data.shape, task, role);
        if (!allowed.ok) throw new Error(allowed.reason);

        if (allowed.task.waitFor) {
          const waitResult = await awaitCrossRepoStage(ctx.workspaceRepoIds, ctx.dataRoot, allowed.task.waitFor);
          if (!waitResult.ok) throw new Error(waitResult.reason);
        }

        const requestedWritePaths = params.writePaths ?? [];
        const writeCheck = await checkWritePaths({ cwd: ctx.cwd, writePaths: requestedWritePaths, declaredWritePaths: allowed.task.writePaths });
        if (!writeCheck.ok) throw new Error(`写入路径越出授权范围: ${writeCheck.violations.join("、")}`);

        if (role === "acceptance" && !params.reportPath) {
          throw new Error("run 动作派 acceptance 时缺少 reportPath");
        }

        const dispatched = await ctx.dispatch.dispatchRole({
          role,
          task,
          instructions: params.instructions,
          writePaths: requestedWritePaths,
          readPaths: params.readPaths ?? [],
          reportPath: params.reportPath,
        });
        if (!dispatched.ok) throw new Error(dispatched.reason);
        return textResult(`已派工: ${dispatched.runId}`);
      }

      if (params.action === "submit") {
        const task = params.task;
        if (!task) throw new Error("submit 动作缺少 task");
        if (params.result === undefined) throw new Error("submit 动作缺少 result");
        const state = await queryRequirementState(ctx);
        const shapeTask = state.data.shape?.tasks.find((entry) => entry.id === task);
        if (!shapeTask || shapeTask.roles.length > 0) {
          throw new Error(`任务 ${task} 已分派角色或未在已确认形状内，不能自行完成，需重新提议形状`);
        }
        const version = await currentVersion({ cwd: ctx.cwd, requirement: ctx.requirement });
        const submitRun = await ctx.runStore.create({
          kind: "role",
          role: `pi-company.${ctx.roleName}`,
          parentRunId: ctx.runId,
          requirement: ctx.requirement,
          task,
          cwd: ctx.cwd,
          writePaths: [],
          readPaths: [],
          model: ctx.modelRef,
          thinking: "high",
          mcp: [],
        });
        await ctx.runStore.update(submitRun.id, { state: "running" });
        await ctx.runStore.update(submitRun.id, {
          state: "completed",
          result: {
            ...(params.result as Record<string, unknown>),
            phase: "work",
            binding: {
              requirement: ctx.requirement,
              task,
              definitionFingerprint: version.definitionFingerprint,
              codeHead: version.codeHead,
              cwd: ctx.cwd,
            },
          },
        });
        return textResult(`已提交交付，运行编号: ${submitRun.id}`);
      }

      if (params.action === "list") {
        const items = await ctx.dispatch.list();
        return textResult(JSON.stringify(items));
      }

      const runId = params.runId;
      if (!runId) throw new Error(`${params.action} 动作缺少 runId`);
      if (params.action === "status") {
        const result = await ctx.dispatch.status(runId);
        if (!result.ok) throw new Error(result.reason);
        return textResult(`状态: ${result.state}`);
      }
      if (params.action === "wait") {
        const result = await ctx.dispatch.wait(runId);
        if (!result.ok) throw new Error(result.reason);
        return textResult(`状态: ${result.state}`);
      }
      const result = await ctx.dispatch.cancel(runId);
      if (!result.ok) throw new Error(result.reason);
      return textResult("已取消");
    },
  });
}

export function registerAskTool(pi: ExtensionAPI, ctx: RequirementAgentToolContext, askState: { count: number }): void {
  pi.registerTool({
    name: "pi_company_ask",
    label: "向用户提问",
    description: "就产品或方案决策向用户提问并阻塞等待答复",
    parameters: ASK_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      askState.count += 1;
      if (askState.count === 1) {
        try {
          await ctx.runStore.update(ctx.runId, { state: "waiting_answer" });
        } catch (error) {
          askState.count -= 1;
          throw error;
        }
      }
      try {
        const answer = await ctx.relay.ask(
          { question: params.question, options: params.options, recommended: params.recommended, repoId: ctx.repoId, requirement: ctx.requirement },
          { signal },
        );
        return textResult(answer);
      } finally {
        askState.count -= 1;
        if (askState.count === 0) {
          await ctx.runStore.update(ctx.runId, { state: "running" }).catch(() => {});
        }
      }
    },
  });
}

function describeShapeForConfirmation(params: {
  tasks: ShapeTaskDeclaration[];
  gates: { whiteboxReview: boolean; blackboxAcceptance: boolean };
  rationale: string;
}): string {
  const taskLines = params.tasks
    .map((task) => {
      const roles = task.roles.length > 0 ? task.roles.join("、") : "需求代理自行完成";
      const writePaths = task.writePaths.length > 0 ? task.writePaths.join("、") : "无";
      const waitFor = task.waitFor
        ? `；等待仓库 ${task.waitFor.repo} 的需求 ${task.waitFor.requirement} 到达阶段 ${task.waitFor.stage}`
        : "";
      return `- ${task.id} ${task.title}（角色：${roles}；写入范围：${writePaths}${waitFor}）`;
    })
    .join("\n");
  const gateLines = Object.entries(params.gates)
    .map(([gate, enabled]) => `${gate}: ${enabled ? "启用" : "跳过"}`)
    .join("、");
  return `请确认以下工作流形状：\n${taskLines}\n门禁：${gateLines}\n理由：${params.rationale}`;
}

export function registerProposeShapeTool(pi: ExtensionAPI, ctx: RequirementAgentToolContext): void {
  pi.registerTool({
    name: "pi_company_propose_shape",
    label: "提议工作流形状",
    description: "校验并提议任务集与门禁声明，经用户确认后记录为已确认形状",
    parameters: PROPOSE_SHAPE_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      const validation = await validateProposedShape(params, ctx);
      if (!validation.ok) throw new Error(validation.reason);

      const planRun = await ctx.runStore.create({
        kind: "role",
        role: `pi-company.${ctx.roleName}`,
        parentRunId: ctx.runId,
        requirement: ctx.requirement,
        task: "plan",
        cwd: ctx.cwd,
        writePaths: [],
        readPaths: [],
        model: ctx.modelRef,
        thinking: "high",
        mcp: [],
      });
      await ctx.runStore.update(planRun.id, { state: "running" });

      try {
        const answer = await ctx.relay.ask(
          {
            question: describeShapeForConfirmation(params),
            options: [
              { label: "确认", description: "确认此形状，进入执行" },
              { label: "重新提议", description: "驳回并要求重新提议" },
            ],
            recommended: "确认",
            repoId: ctx.repoId,
            requirement: ctx.requirement,
          },
          { signal },
        );
        if (answer !== "确认") throw new Error(`用户未确认形状: ${answer}`);

        const skipped: Array<{ gate: string; decisionId: string }> = [];
        for (const [gate, enabled] of Object.entries(params.gates)) {
          if (enabled) continue;
          const decision = await appendDecision(
            {
              requirement: ctx.requirement,
              actor: "user",
              source: "requirement-agent",
              trigger: `跳过门禁 ${gate}`,
              decision: `确认跳过 ${gate}`,
              alternatives: [],
              effects: ["gate"],
              impact: params.rationale,
            },
            { dataRoot: ctx.dataRoot, cwd: ctx.cwd },
          );
          skipped.push({ gate, decisionId: decision.decisionId });
        }

        const version = await currentVersion({ cwd: ctx.cwd, requirement: ctx.requirement });
        await ctx.runStore.update(planRun.id, {
          state: "completed",
          result: {
            phase: "plan",
            verdict: "PASS",
            summary: params.rationale,
            proposedShape: { tasks: params.tasks, gates: params.gates, skipped, acceptanceReport: null },
            binding: {
              requirement: ctx.requirement,
              definitionFingerprint: version.definitionFingerprint,
              codeHead: version.codeHead,
              cwd: ctx.cwd,
            },
          },
        });

        const confirmDecision = await appendDecision(
          {
            requirement: ctx.requirement,
            actor: "user",
            source: "requirement-agent",
            trigger: "确认形状",
            decision: "确认任务集与门禁声明",
            alternatives: [],
            effects: ["scope"],
            impact: params.rationale,
          },
          { dataRoot: ctx.dataRoot, cwd: ctx.cwd },
        );

        const state = await queryRequirementState(ctx);
        const confirmResult = await executeWorkflowAction(
          { action: "shape-confirm", requirement: ctx.requirement, runId: planRun.id, decisionId: confirmDecision.decisionId, version: state.version },
          { dataRoot: ctx.dataRoot, cwd: ctx.cwd },
        );
        if (confirmResult.details.isError) throw new Error(confirmResult.text);
        return textResult(`${confirmResult.text}；规划运行编号 ${planRun.id}`);
      } catch (error) {
        await ctx.runStore.update(planRun.id, { state: "failed", stateReason: (error as Error).message }).catch(() => {});
        throw error;
      }
    },
  });
}

const SUPPLEMENT_GUIDANCE =
  "以下是主会话转发的补充。请先判断该补充是否改变已确认形状的任务集或形状：改变则须重新经 pi_company_propose_shape 提议并等待确认，否则直接并入当前执行。";

function requirementAgentExtension(ctx: RequirementAgentToolContext, askState: { count: number }) {
  return async (pi: ExtensionAPI): Promise<void> => {
    pi.registerTool(createWorkflowTool({ dataRoot: ctx.dataRoot, cwd: ctx.cwd }));
    pi.registerTool(createDecisionRecordTool({ dataRoot: ctx.dataRoot, cwd: ctx.cwd }));
    registerAgentTool(pi, ctx);
    registerAskTool(pi, ctx, askState);
    registerProposeShapeTool(pi, ctx);

    pi.on("before_agent_start", async (event) => {
      const state = await queryRequirementState(ctx);
      const promptText = buildRequirementAgentPrompt({
        requirement: ctx.requirement,
        cwd: ctx.cwd,
        roleCatalog: ctx.roleCatalog,
        shape: state.data.shape,
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${promptText}` };
    });
  };
}

export async function createRequirementAgentSession(options: CreateRequirementAgentSessionOptions): Promise<CreateRequirementAgentSessionResult> {
  if (!options.role.available || !options.role.definition) {
    return { ok: false, reason: options.role.reason ?? `角色定义不可用: ${options.role.name}` };
  }

  const queryCtx = { dataRoot: options.dataRoot, cwd: options.cwd };
  const stateResult = await executeWorkflowAction({ action: "query", requirement: options.requirement }, queryCtx);
  if (stateResult.details.isError) {
    return { ok: false, reason: (stateResult.details.reason as string | undefined) ?? stateResult.text };
  }
  const stage = (stateResult.details.data as { stage: string }).stage;
  if (BLOCKED_STAGES.has(stage)) {
    return { ok: false, reason: `需求处于 ${stage} 阶段，不可派出需求代理` };
  }

  const requirementDir = requirementDataDir(options.dataRoot, options.repoId, options.requirement);
  let found: { reused: boolean; runId: string; shellToken: string };
  try {
    found = await withDirLock(requirementDir, async () => {
      const page = await options.runStore.list({ kind: "requirement", requirement: options.requirement, limit: 200 });
      const active = page.items.find((run) => !isTerminalState(run.state) && run.state !== "interrupted");
      if (active) return { reused: true as const, runId: active.id, shellToken: active.shellToken };
      const run = await options.runStore.create({
        kind: "requirement",
        requirement: options.requirement,
        task: "需求代理会话",
        cwd: options.cwd,
        writePaths: [options.cwd],
        readPaths: [options.cwd],
        model: options.modelRef,
        thinking: "high",
        mcp: [],
      });
      await options.runStore.update(run.id, { state: "running" });
      return { reused: false as const, runId: run.id, shellToken: run.shellToken };
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  if (found.reused) return { ok: true, reused: true, runId: found.runId };

  const built = await buildRequirementAgentHandle(options, found.runId, found.shellToken, false);
  if (!built.ok) return built;
  return { ok: true, reused: false, runId: found.runId, handle: built.handle };
}

async function buildRequirementAgentHandle(
  options: CreateRequirementAgentSessionOptions,
  runId: string,
  shellToken: string,
  resume: boolean,
): Promise<{ ok: true; handle: RequirementAgentHandle } | { ok: false; reason: string }> {
  const definition = options.role.definition;
  if (!definition) return { ok: false, reason: options.role.reason ?? `角色定义不可用: ${options.role.name}` };

  const askState = { count: 0 };
  const toolCtx: RequirementAgentToolContext = {
    dataRoot: options.dataRoot,
    repoId: options.repoId,
    requirement: options.requirement,
    cwd: options.cwd,
    roleCatalog: options.roleCatalog,
    roleName: options.role.name,
    runId,
    runStore: options.runStore,
    workspaceRepoIds: options.workspaceRepoIds,
    dispatch: options.dispatch,
    relay: options.relay,
    modelRef: options.modelRef,
  };

  let innerHandle: RoleSessionHandle;
  try {
    innerHandle = await createRoleSession({
      dataRoot: options.dataRoot,
      repoId: options.repoId,
      runId,
      shellToken,
      cwd: options.cwd,
      roleName: options.role.name,
      role: options.role,
      task: "持有需求上下文，规划、提议工作流形状并按形状统筹推进",
      readPaths: [options.cwd],
      writePaths: [options.cwd],
      runtime: options.runtime,
      modelRef: options.modelRef,
      clock: options.clock,
      shellRegistry: options.shellRegistry,
      guards: options.guards,
      networkGate: options.networkGate,
      resume,
      // 需求代理靠 ask/dispatch 等工具自行驱动多轮编排，任一次纯文字回合结束都不代表任务完成，
      // 收尾时机完全由 stop() 决定
      contract: { kind: "plain", completion: "idle-only" },
      extraExtensionFactories: [requirementAgentExtension(toolCtx, askState)],
    });
  } catch (error) {
    await options.runStore.update(runId, { state: "failed", stateReason: (error as Error).message }).catch(() => {});
    return { ok: false, reason: (error as Error).message };
  }

  const handle: RequirementAgentHandle = {
    events: innerHandle.events,
    state: () => {
      const inner = innerHandle.state();
      if (inner === "completed" || inner === "failed" || inner === "stopped") return inner;
      return askState.count > 0 ? "waiting_answer" : inner;
    },
    prompt: (text) => innerHandle.prompt(text),
    injectSupplement: (text) => innerHandle.prompt(`${SUPPLEMENT_GUIDANCE}\n\n${text}`),
    result: () => innerHandle.result(),
    pause: () => innerHandle.pause(),
    resume: () => innerHandle.resume(),
    stop: async () => {
      const outcome = await innerHandle.stop();
      await options.runStore.update(runId, { state: "stopped" }).catch(() => {});
      return outcome;
    },
    dispose: () => innerHandle.dispose(),
  };

  return { ok: true, handle };
}

export async function resumeRequirementAgentSession(
  options: CreateRequirementAgentSessionOptions & { runId: string },
): Promise<{ ok: true; handle: RequirementAgentHandle } | { ok: false; reason: string }> {
  const existing = await options.runStore.get(options.runId);
  if (!existing.ok) return { ok: false, reason: existing.reason };
  return buildRequirementAgentHandle(options, options.runId, existing.run.shellToken, true);
}
