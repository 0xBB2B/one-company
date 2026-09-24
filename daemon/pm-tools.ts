import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { PM_INTAKE_SUBMIT_PARAMETERS, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import type { IntakeSubmissionBaseline } from "../runtime/pm-intake-runtime.ts";
import { createSpecPublishGate } from "../runtime/check-round.ts";
import { uuidv7 } from "../runtime/database.ts";
import type { PmLease, WorkspaceBinding } from "../runtime/requirement-contracts.ts";
import { createRequirementReadTool, REQUIREMENT_READ_PARAMETERS } from "../runtime/requirement-read-tool.ts";
import { toPiTool } from "../runtime/role-tools.ts";
import type { CoreToolRuntime } from "../runtime/role-tools.ts";
import { createSpecChangeTool, SPEC_CHANGE_PARAMETERS } from "../runtime/spec-change.ts";
import { createVerificationRunTool, VERIFICATION_RUN_PARAMETERS } from "../runtime/verification-run.ts";
import { createWorkflowManageTool, WORKFLOW_MANAGE_PARAMETERS } from "../runtime/workflow-manage.ts";

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
  stopAgents: (requirementId: string) => Promise<void>;
}

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
    const workflow = track(await createWorkflowManageTool({ ...shared, authorize, stopAgents: input.stopAgents, grant: { ...identity(), lease: input.lease } }));
    const verification = track(await createVerificationRunTool({ ...shared, authorize, grant: { ...identity(), epoch: input.epoch } }));
    const spec = track(await createSpecChangeTool({ ...shared, authorize, grant: { ...identity(), lease: input.lease },
      publishGate: createSpecPublishGate({ dataRoot: input.dataRoot, repoId: input.repoId }) }));
    return {
      tools: [
        toPiTool("requirement_manage", "读取本需求已批准的 prod 正文、章节或准确版本差异（read/diff/metadata）；不能读取草稿、其他需求或已关闭需求。", REQUIREMENT_READ_PARAMETERS, read),
        toPiTool("workflow_manage", "查看状态、进入/退出检查阶段、提交中断或等待决策、交付核对与关闭。", WORKFLOW_MANAGE_PARAMETERS, workflow),
        toPiTool("verification_run", "在绑定工作区的受控沙箱里运行正式检查命令，或查询、停止运行。", VERIFICATION_RUN_PARAMETERS, verification),
        toPiTool("spec_change", "提出、校验并在证据满足后发布最小规则候选。", SPEC_CHANGE_PARAMETERS, spec),
        intakeSubmitTool(input),
      ],
      dispose() { for (const runtime of runtimes) runtime.dispose(); },
    };
  } catch (error) {
    for (const runtime of runtimes) runtime.dispose();
    throw error;
  }
}

/** PM 提交接手理解：正文随工具调用只落在本运行的私有会话文件，主代理经接手核对读取。 */
function intakeSubmitTool(input: PmToolsInput): ToolDefinition {
  return {
    name: PM_INTAKE_TOOL,
    label: "user_interact",
    description: "提交接手理解（purpose=pm-intake）：目标、非目标、约束、允许动作、未决项及影响、场景覆盖，每项附来源 ID。提交后等待主代理核对。",
    parameters: PM_INTAKE_SUBMIT_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (!input.alive() || !Value.Check(PM_INTAKE_SUBMIT_PARAMETERS, params)) throw new Error("pm_intake_submit_denied");
      await input.checkLease();
      return { content: [{ type: "text", text: JSON.stringify({ status: "submitted", next: "等待主代理核对接手理解" }) }],
        details: { intakeBaseline: input.currentBaseline() } };
    },
  } as ToolDefinition;
}
