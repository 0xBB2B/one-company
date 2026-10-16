import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CHANGE_APPLY_PARAMETERS, createChangeApplyTool } from "../verification/change-apply.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import { listChangedPaths } from "../../core/exec/git-snapshot.ts";
import { createPlanManageTool, PLAN_MANAGE_PARAMETERS, readPlanIn } from "./plan-manage.ts";
import type { TaskRecord } from "./plan-manage.ts";
import type { PmLease, WorkspaceBinding } from "../requirement/requirement-contracts.ts";
import { createRequirementReadTool, REQUIREMENT_READ_PARAMETERS } from "./requirement-read-tool.ts";
import { overlaps } from "../../core/policy/ranges.ts";
import { createResultSubmitTool, VERDICT_SUBMIT_PARAMETERS } from "./result-submit.ts";
import { toPiTool } from "../agents/role-tools.ts";
import type { CoreToolRuntime } from "../agents/role-tools.ts";
import { createVerificationRunTool, VERIFICATION_RUN_PARAMETERS } from "./verification-run.ts";

export interface SubagentToolsInput {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  runId: string;
  pmLease: PmLease;
  workspace: WorkspaceBinding;
  epoch: number;
  task: TaskRecord;
  /** 任务级审查时绑定被审的 worker 尝试，工具按 reviewer 职责组装；缺省按任务职责。 */
  review?: { attemptRunId: string };
  /** 宿主核验本子代理会话与其父 PM 租约仍有效；模型参数不能让它返回 true。 */
  alive: () => boolean;
}

/** 按职责为 worker、reviewer、qa 组装核心工具；每个工具内部仍按职责矩阵与绑定逐次核验。 */
export async function createSubagentTools(input: SubagentToolsInput): Promise<{ tools: ToolDefinition[]; dispose(): void }> {
  const role = input.review ? "reviewer" : input.task.role;
  if (role !== "worker" && role !== "reviewer" && role !== "qa") throw new Error(`子代理工具不支持职责 ${role}`);
  const shared = { repositoryRoot: input.repositoryRoot, dataRoot: input.dataRoot };
  const scope = { requirementId: input.task.requirementId, repoId: input.repoId, workspaceId: input.workspace.workspaceId };
  const identity = { callerId: uuidv7(), runId: input.runId, ...scope, branch: input.workspace.branch };
  const authorize = () => input.alive();
  const runtimes: CoreToolRuntime[] = [];
  const track = <T extends CoreToolRuntime>(runtime: T): T => { runtimes.push(runtime); return runtime; };
  const tools: ToolDefinition[] = [];
  try {
    const verification = track(await createVerificationRunTool({ ...shared, authorize, grant: { ...identity, role, epoch: input.epoch },
      ...(input.review ? { reviewedAttemptRunIds: input.task.attempts.map((attempt) => attempt.runId) } : {}) }));
    tools.push(toPiTool("verification_run", role === "worker" ? "在绑定工作区的受控沙箱里运行调试命令（debug），或查询、停止运行。"
      : role === "reviewer" ? "在绑定工作区的只读沙箱里运行被审任务范围的测试（debug），或查询、停止运行；status 也能查看被审任务各次 worker 尝试提交里引用的验证记录（含先红后绿的记录）。"
        : "在检查阶段运行正式检查（formal），或查询、停止运行。", VERIFICATION_RUN_PARAMETERS, verification));
    if (role === "worker") {
      const change = track(await createChangeApplyTool({ ...shared, authorize, grant: { ...identity, role, epoch: input.epoch, writePaths: input.task.writePaths } }));
      tools.push(toPiTool("change_apply", `只在授权范围 ${input.task.writePaths.join("、")} 内预检、写入或导入代码与测试。prepare 可省略 baseHash，结果会给出各文件当前的 baseHash；apply 可省略 baseHash，自动用本会话对该文件最近一次 prepare 的值，也可照填；新建文件未 prepare 时填 absent。operationId 每次新生成 UUIDv7。`, CHANGE_APPLY_PARAMETERS, change));
    } else {
      const read = track(await createRequirementReadTool({ ...shared, authorize, binding: { ...identity, role, lease: input.pmLease } }));
      tools.push(toPiTool("requirement_manage", `${role === "qa" ? "读取已批准的需求正文、章节或差异（黑盒验收基线）。" : "读取已批准的需求正文、章节或差异。"}结果的 coverage.nextCursor 不为空时用 next 带上它读下一页。`,
        REQUIREMENT_READ_PARAMETERS, read));
    }
    if (role === "reviewer") {
      const plan = track(await createPlanManageTool({ ...shared, authorize, grant: { role, callerId: identity.callerId, runId: input.runId, ...scope } }));
      tools.push(toPiTool("plan_manage", "只读当前计划与任务说明。", PLAN_MANAGE_PARAMETERS, plan));
    }
    const result = createResultSubmitTool({ authorize, grant: { role, callerId: identity.callerId, runId: input.runId, parentRunId: input.pmLease.runId },
      ...(role === "worker" ? { outOfScopeChanges: async () => {
        const allowed = withDatabase(repositoryDatabase(input.dataRoot, input.repoId), (db) => readPlanIn(db, input.task.requirementId)?.tasks ?? [])
          .filter((task) => task.status !== "cancelled").flatMap((task) => task.writePaths);
        return (await listChangedPaths(input.workspace.path)).filter((path) => !allowed.some((scope) => overlaps(scope, path)));
      } } : {}),
      verdictBinding: { dataRoot: input.dataRoot, ...scope, epoch: input.epoch,
        ...(input.review ? { review: { taskId: input.task.taskId, attemptRunId: input.review.attemptRunId } } : {}) } });
    runtimes.push(result);
    tools.push(toPiTool("result_submit", role === "worker" ? "提交本任务结果（action=verdict）：summary 写做了什么，verificationIds 列本运行的调试验证编号，checkRoundId 填 null；未完成或有问题时在 findings 按阻塞、未验证分级列出，没有就给空数组；结果不是通过证明。"
      : role === "reviewer" ? "提交对被审任务改动的审查裁决（action=verdict，checkRoundId 为 null）：只能引用本运行的测试，按阻塞、建议、未验证分级。"
        : "提交引用本检查轮正式验证结果的裁决（action=verdict），按阻塞、建议、未验证分级。", VERDICT_SUBMIT_PARAMETERS, result));
    return { tools, dispose() { for (const runtime of runtimes) runtime.dispose(); } };
  } catch (error) {
    for (const runtime of runtimes) runtime.dispose();
    throw error;
  }
}
