import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { authorizeToolAction, CORE_TOOL_ACTIONS } from "../runtime/core-permissions.ts";
import type { CoreAction } from "../runtime/core-permissions.ts";
import { PM_INTAKE_SUBMIT_PARAMETERS, PM_INTAKE_TOOL, pmSourceDirectory } from "../runtime/pm-intake-runtime.ts";
import { scenariosWithoutOwnRef, unknownIntakeSourceRefs } from "../runtime/pm-intake-contracts.ts";
import type { IntakeSubmissionBaseline } from "../runtime/pm-intake-runtime.ts";
import { uuidv7 } from "../runtime/database.ts";
import type { PmLease, WorkspaceBinding } from "../runtime/requirement-contracts.ts";
import { createRequirementReadTool, REQUIREMENT_READ_PARAMETERS } from "../runtime/requirement-read-tool.ts";
import { toPiTool } from "../runtime/role-tools.ts";
import { AdvisedError, toolFailure, toolStep } from "../runtime/tool-failure.ts";
import type { CoreToolRuntime } from "../runtime/role-tools.ts";
import { createPlanManageTool, PLAN_MANAGE_PARAMETERS } from "../runtime/plan-manage.ts";
import { createVerificationRunTool, VERIFICATION_RUN_PARAMETERS } from "../runtime/verification-run.ts";
import { createWorkflowManageTool, WORKFLOW_MANAGE_PARAMETERS } from "../runtime/workflow-manage.ts";
import { EXPLORE_WEB_QUERY, exploreSource } from "../runtime/explore-dispatch.ts";
import type { ExploreSourceRequest } from "../runtime/explore-dispatch.ts";

export interface PmToolsInput {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  lease: PmLease;
  workspace: WorkspaceBinding;
  epoch: number;
  /** 宿主核验本 PM 物理会话仍存活；模型参数不能让它返回 true。 */
  alive: () => boolean;
  /** 核验本运行仍持有当前 PM 租约。 */
  checkLease: () => Promise<void>;
  /** 提交时的批准基线，由宿主读取当前记录，写入工具结果供接手核对比对。 */
  currentBaseline: () => IntakeSubmissionBaseline;
  /** 由运行管理器执行的子代理派工与控制；只作用于本 PM 派出的运行。 */
  agents: {
    dispatch(taskId: string, mode: { retry: { reason: string; maxTurns: number } | null; rework: { reason: string; maxTurns: number } | null;
      review: { maxTurns: number } | undefined }): Promise<unknown>;
    explore(request: { question: string; clues: string[]; source: ExploreSourceRequest }, maxTurns: number): Promise<unknown>;
    control(action: "status" | "pause" | "resume" | "stop", runId: string): Promise<unknown>;
    /** 有界能力目录：只含名称、职责、描述与来源，不含定义正文或 skill 正文。 */
    catalog(role: string | undefined, cursor: number): Promise<unknown>;
  };
}

const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const runControl = (action: "status" | "pause" | "resume" | "stop") =>
  Type.Object({ action: Type.Literal(action), runId: Type.String({ pattern: UUID_V7 }) }, { additionalProperties: false });
const PM_ACTION_SHAPES: Partial<Record<CoreAction<"agent_manage">, TSchema[]>> = {
  dispatch: [
    ...(["retry", "rework"] as const).map((kind) => Type.Object({ action: Type.Literal("dispatch"), taskId: Type.String({ pattern: UUID_V7 }),
      [kind]: Type.Optional(Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1024 }), maxTurns: Type.Integer({ minimum: 1, maximum: 100 }) },
        { additionalProperties: false })) }, { additionalProperties: false })),
    Type.Object({ action: Type.Literal("dispatch"), taskId: Type.String({ pattern: UUID_V7 }),
      review: Type.Object({ maxTurns: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("dispatch"), role: Type.Literal("explore"), question: Type.String({ minLength: 1, maxLength: 1500 }),
      clues: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 8 })), ...EXPLORE_WEB_QUERY,
      maxTurns: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }),
  ],
  status: [runControl("status")], pause: [runControl("pause")], resume: [runControl("resume")], stop: [runControl("stop")],
  catalog: [Type.Object({ action: Type.Literal("catalog"), role: Type.Optional(Type.Union(["worker", "reviewer", "qa", "explore"].map((role) => Type.Literal(role)))),
    cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })) }, { additionalProperties: false })],
};
export const PM_AGENT_MANAGE_PARAMETERS = Type.Union(CORE_TOOL_ACTIONS.agent_manage
  .filter((action) => authorizeToolAction("pm", "agent_manage", action)).flatMap((action) => PM_ACTION_SHAPES[action] ?? []));

const PM_GONE = () => new AdvisedError("pm_session_gone",
  { why: "本 PM 会话已结束、被停止或已被新 PM 取代", next: "停止操作，不要重试；由主代理决定是否重新派出 PM" });

export interface PmTools {
  tools: ToolDefinition[];
  dispose(): void;
}

/** 按当前租约为 PM 组装已实现的核心工具；每个工具内部仍按职责矩阵与租约逐次核验。 */
export async function createPmTools(input: PmToolsInput): Promise<PmTools> {
  const base = { requirementId: input.lease.requirementId, repoId: input.repoId, workspaceId: input.workspace.workspaceId, branch: input.workspace.branch };
  const shared = { repositoryRoot: input.repositoryRoot, dataRoot: input.dataRoot };
  const identity = () => ({ role: "pm" as const, callerId: uuidv7(), runId: input.lease.runId, ...base });
  const authorize = () => input.alive();
  const runtimes: CoreToolRuntime[] = [];
  const track = <T extends CoreToolRuntime>(runtime: T): T => { runtimes.push(runtime); return runtime; };
  try {
    const read = track(await createRequirementReadTool({ ...shared, authorize, binding: { ...identity(), lease: input.lease } }));
    const workflow = track(await createWorkflowManageTool({ ...shared, authorize, grant: { ...identity(), lease: input.lease } }));
    const verification = track(await createVerificationRunTool({ ...shared, authorize, grant: { ...identity(), epoch: input.epoch } }));
    const { branch: _branch, ...planIdentity } = identity();
    const plan = track(await createPlanManageTool({ ...shared, authorize, grant: { ...planIdentity, lease: input.lease } }));
    return {
      tools: [
        toPiTool("requirement_manage", "读取本需求已批准的 prod 正文、章节（read）或两个批准版本之间的准确差异（diff，按 fromRevision/toRevision 查，可重复查）；metadata 看状态；结果的 coverage.nextCursor 不为空时用 next 带上它读下一页；不能读取草稿、其他需求或已关闭需求。", REQUIREMENT_READ_PARAMETERS, read),
        toPiTool("workflow_manage", "查看状态、进入/退出检查阶段、提交中断或等待决策、交付核对；交付核对通过后以 report 提交完成报告（note 写给用户的说明）等待用户验收；等待你处置的任务自己处理不了时，以 escalate（taskId 与 note：卡在哪、需要用户决定什么）交用户裁决；还没派出的任务遇到需要用户决定的问题（如缺原型、要新增依赖）也可以 escalate。关闭需求只能由用户经主代理决定。", WORKFLOW_MANAGE_PARAMETERS, workflow),
        toPiTool("verification_run", "在绑定工作区的受控沙箱里运行正式检查命令，或查询、停止运行；status 也能查看本需求子代理提交里引用的验证记录（命令、退出码和输出末尾）。", VERIFICATION_RUN_PARAMETERS, verification),
        toPiTool("plan_manage", "维护本需求计划：propose 提出、update 修改、confirm 冻结为可执行基线（AI 决策，不是用户授权）、read 读取、assess-update 逐任务影响复核。接手核对通过且有实施授权才能提出或修改。", PLAN_MANAGE_PARAMETERS, plan),
        intakeSubmitTool(input),
        agentManageTool(input),
      ],
      dispose() { for (const runtime of runtimes) runtime.dispose(); },
    };
  } catch (error) {
    for (const runtime of runtimes) runtime.dispose();
    throw error;
  }
}

/** PM 提交接手理解：正文随工具调用只落在本运行的私有会话文件，主代理经接手核对读取。 */
export function intakeSubmitTool(input: PmToolsInput): ToolDefinition {
  return {
    name: PM_INTAKE_TOOL,
    label: "user_interact",
    description: "提交接手理解（purpose=pm-intake）：目标、非目标、约束、允许动作、未决项及影响、场景覆盖，每项附来源 ID。提交后等待主代理核对。",
    parameters: PM_INTAKE_SUBMIT_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      try { return await submit(params); }
      catch (error) { throw toolFailure(PM_INTAKE_TOOL, error); }
    },
  } as ToolDefinition;
  async function submit(params: unknown) {
    if (!input.alive()) throw PM_GONE();
    if (!Value.Check(PM_INTAKE_SUBMIT_PARAMETERS, params)) throw new AdvisedError("invalid_shape",
      { why: "接手理解的字段不符合格式", next: "按工具说明补齐目标、非目标、约束、允许动作、未决项与场景覆盖，每项附出处编号后重交" });
    await input.checkLease();
    const directory = pmSourceDirectory({ dataRoot: input.dataRoot, repoId: input.repoId }, input.lease.requirementId);
    if (!directory) throw new AdvisedError("pm_intake_source_directory_unavailable",
      { why: "读不到本需求的接手出处目录，无法核对引用的出处编号", next: "停止提交，在回复里说明，由主代理处理" });
    const unknown = unknownIntakeSourceRefs((params as { understanding: Parameters<typeof unknownIntakeSourceRefs>[0] }).understanding, directory);
    if (unknown.length) throw new AdvisedError("pm_intake_unknown_source",
      { why: `引用了任务上下文里没有的出处编号：${unknown.join("、")}`, next: "只引用任务上下文列出的出处编号，改正后重交" });
    const withoutOwnRef = scenariosWithoutOwnRef((params as { understanding: Parameters<typeof scenariosWithoutOwnRef>[0] }).understanding);
    if (withoutOwnRef.length) throw new AdvisedError("pm_intake_unknown_source",
      { why: `这些场景覆盖项的出处里没有引用场景本身：${withoutOwnRef.join("、")}`, next: "每个场景覆盖项的 sourceRefs 里加上 kind 为 prod-scenario、id 为该场景编号的一条，改正后重交" });
    return { content: [{ type: "text", text: JSON.stringify({ status: "submitted", next: "等待主代理核对接手理解" }) }],
      details: { intakeBaseline: input.currentBaseline() } };
  }
}

/** PM 的 agent_manage：按已冻结任务派出 worker、reviewer（含重试、审查、返修），派出 explore，列出角色目录，并控制本 PM 派出的运行。 */
export function agentManageTool(input: PmToolsInput): ToolDefinition {
  return {
    name: "one_company_agent_manage",
    label: "agent_manage",
    description: "dispatch 按已冻结计划中的任务派出子代理，轮次上限取任务登记值；任务首次尝试未完成时可带 retry（原因与新的轮次上限）重试一次，再未完成即等待用户裁决。worker 任务完成后进入待审查，带 review（轮次上限）派 reviewer 审查该任务；审查打回后带 rework（原因与新的轮次上限）派 worker 返修一次，再次打回即等待用户裁决。所在目录与执行中、待审查、待返修任务重叠的 worker 任务不能同时派出。dispatch role=explore 派出只读检索（问题、线索与轮次上限；不给 webQuery 时在需求工作区内检索本地文件，给出 webQuery 则联网检索），立即返回运行编号，结果到达后自动注入本会话，可同时派出多个。status/pause/resume/stop 控制本 PM 派出的运行。catalog 按职责分页列出可用角色定义（名称、描述、来源），供在计划任务里用 agent 指定专业定义；用户明确指定的定义不可用时，不自行改用其他定义，向用户提问。",
    parameters: PM_AGENT_MANAGE_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      try { return await manage(rawParams); }
      catch (error) { throw toolFailure(toolStep("one_company_agent_manage", rawParams), error); }
    },
  } as ToolDefinition;
  async function manage(rawParams: unknown) {
    if (!input.alive()) throw PM_GONE();
    if (rawParams && typeof rawParams === "object" && "prototype" in rawParams) throw new AdvisedError("invalid_shape",
      { why: "原型由主窗口在澄清阶段出，PM 不能派原型设计师", next: "去掉 prototype 参数；需要原型时请主代理在澄清阶段处理" });
    if (!Value.Check(PM_AGENT_MANAGE_PARAMETERS, rawParams)) throw new AdvisedError("invalid_shape",
      { why: "参数不符合该动作的格式（retry、rework、review 三者最多给一个；轮次上限是 1 到 100 的整数）", next: "按工具说明改正字段后重试" });
    const params = rawParams as { action: "dispatch" | "status" | "pause" | "resume" | "stop" | "catalog"; taskId?: string; runId?: string;
      retry?: { reason: string; maxTurns: number }; rework?: { reason: string; maxTurns: number }; review?: { maxTurns: number }; role?: string; question?: string; clues?: string[]; webQuery?: string; maxTurns?: number; cursor?: number };
    if (!authorizeToolAction("pm", "agent_manage", params.action)) throw new AdvisedError("action_not_allowed",
      { why: `PM 的职责不允许 agent_manage 的 ${params.action} 动作`, next: "改用 PM 职责内的动作" });
    const result = params.action === "catalog"
      ? await input.agents.catalog(params.role, params.cursor ?? 0)
      : params.action === "dispatch" && params.role === "explore"
      ? await input.agents.explore({ question: params.question!, clues: params.clues ?? [], source: exploreSource(params) }, params.maxTurns!)
      : params.action === "dispatch"
      ? await input.agents.dispatch(params.taskId!, { retry: params.retry ?? null, rework: params.rework ?? null, review: params.review })
      : await input.agents.control(params.action as "status" | "pause" | "resume" | "stop", params.runId!);
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
  }
}
