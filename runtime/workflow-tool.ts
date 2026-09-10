import { collectGitSnapshot } from "./git-snapshot.ts";
import { readGit } from "./git-read.ts";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { repositoryIdentity, requirementIdentity } from "./identity.ts";
import { RunStore } from "./run-store.ts";
import { StaleVersionError, repositoryDatabase, withDatabase } from "./database.ts";
import {
  advanceStage,
  checkResume,
  failTask,
  finishTask,
  initRequirementState,
  readRequirementState,
  recordShape,
  rejectRequirement,
  retreatStage,
  rollbackTask,
  startTask,
  updateTaskFields,
} from "./workflow-state.ts";
import type { ActionResult, DefinitionVersion, RequirementShape, RequirementState, WorkflowContext } from "./workflow-state.ts";

const PARAMETERS = Type.Object(
  {
    action: Type.Union([
      Type.Literal("query"), Type.Literal("list"), Type.Literal("init"), Type.Literal("update"),
      Type.Literal("advance"), Type.Literal("retreat"), Type.Literal("task-start"), Type.Literal("task-finish"),
      Type.Literal("task-fail"), Type.Literal("rollback"), Type.Literal("reject"), Type.Literal("shape-confirm"),
      Type.Literal("resume-check"),
    ]),
    requirement: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    task: Type.Optional(Type.String({ pattern: "^T-\\d+$" })),
    fields: Type.Optional(Type.Array(Type.String())),
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    update: Type.Optional(Type.Object({
      note: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()), commit: Type.Optional(Type.String()),
      blockedReason: Type.Optional(Type.String()), workspaceDir: Type.Optional(Type.String()),
      followUpIssues: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: false })),
    stage: Type.Optional(Type.String()),
    decisionId: Type.Optional(Type.String({ pattern: "^(AI|USER)-\\d+$" })),
    runId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export interface WorkflowActionResult {
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
}

export interface CreateWorkflowToolOptions {
  dataRoot: string;
  cwd?: string;
  boundRequirement?: string;
  beforeTaskFinish?: (runId: string, signal?: AbortSignal) => Promise<void>;
  onStateChange?: (state: RequirementState) => void;
}

const STALE_VERSION_MARK = "请重新查询后重试";
const MAX_RETRY_ATTEMPTS = 5;
const ABSOLUTE_PATH_PATTERN = /(^|[^\w.\-])(\/[^\s'"）)]+)/g;

function redactAbsolutePaths(message: string): string {
  return message.replace(ABSOLUTE_PATH_PATTERN, (_match, boundary: string) => `${boundary}[path]`);
}

function failReceipt(requirement: string, action: string, reason: string, staleVersion = false): WorkflowActionResult {
  const safeReason = redactAbsolutePaths(reason);
  const text = `${requirement} ${action} 失败：${safeReason}${staleVersion ? `，${STALE_VERSION_MARK}` : ""}`;
  return { ok: false, text, details: { isError: true, reason: safeReason, staleVersion } };
}

function formatReceipt(requirement: string, action: string, result: ActionResult, summary: string): WorkflowActionResult {
  if (result.ok) {
    return {
      ok: true,
      text: `${requirement} ${action} 成功：${summary}，version ${result.version}`,
      details: { isError: false, version: result.version },
    };
  }
  return failReceipt(requirement, action, result.reason, result.staleVersion === true);
}

async function requireRequirement(
  params: Record<string, unknown>,
  ctx: { dataRoot: string; cwd: string },
): Promise<{ ok: true; wctx: WorkflowContext } | { ok: false; receipt: WorkflowActionResult }> {
  const requirement = params.requirement as string | undefined;
  const action = params.action as string;
  if (!requirement) {
    return { ok: false, receipt: failReceipt("(未知需求)", action, "缺少 requirement") };
  }
  try {
    requirementIdentity(requirement);
  } catch {
    return { ok: false, receipt: failReceipt(requirement, action, "需求标识格式不合法") };
  }
  const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
  return { ok: true, wctx: { dataRoot: ctx.dataRoot, cwd, requirement } };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

function updateSummary(fields: Record<string, unknown> | undefined, followUpIssues: unknown[] | undefined): string {
  const parts: string[] = [];
  if (fields) parts.push(...Object.keys(fields));
  if (followUpIssues) parts.push("followUpIssues");
  return parts.length > 0 ? parts.join("、") : "更新";
}

async function listRequirements(
  ctx: { dataRoot: string; cwd: string },
): Promise<{ ok: true; items: Array<{ requirement: string; stage: string }> } | { ok: false; reason: string }> {
  let identity;
  try {
    identity = await repositoryIdentity(ctx.cwd);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  try {
    const items = withDatabase(repositoryDatabase(ctx.dataRoot, identity.repoId), (db) => db.list<{ stage: string }>("requirements")
      .map((record) => ({ requirement: record.key, stage: record.data.stage })));
    return { ok: true, items: items.filter((item) => item.stage !== "accepted") };
  } catch (error) { return { ok: false, reason: (error as Error).message }; }
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await readGit(cwd, args);
  return stdout.trim();
}

const MAX_DEFINITION_DEPTH = 32;

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function listFilesRecursive(dir: string, root: string, depth: number, visitedDirLinks: Set<string>): Promise<string[]> {
  if (depth > MAX_DEFINITION_DEPTH) throw new Error("定义目录层级过深，无法完整核对");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real: string;
      let target;
      try {
        real = await realpath(full);
        target = await stat(full);
      } catch (error) {
        throw new Error(`定义链接无法读取: ${full}`, { cause: error });
      }
      if (!isWithinRoot(real, root)) throw new Error(`定义链接越出仓库: ${full}`);
      if (target.isDirectory()) {
        if (visitedDirLinks.has(real)) continue;
        visitedDirLinks.add(real);
        files.push(...(await listFilesRecursive(full, root, depth + 1, visitedDirLinks)));
      } else if (target.isFile()) {
        files.push(full);
      }
    } else if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, root, depth + 1, visitedDirLinks)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function definitionFingerprint(root: string, requirement: string): Promise<string> {
  const dir = join(root, ".pi-company", "requirements", requirement);
  const files = (await Promise.all([
    listFilesRecursive(dir, root, 0, new Set()),
    listFilesRecursive(join(root, ".pi-company", "spec"), root, 0, new Set()),
  ])).flat().filter((file) => file !== join(dir, "acceptance.md")).sort();
  if (files.length === 0) return "none";
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(dir, file);
    const content = await readFile(file);
    hash.update(`${Buffer.byteLength(rel)}\0${rel}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function currentVersion(ctx: { cwd: string; requirement: string }): Promise<DefinitionVersion> {
  const root = await realpath(await gitOutput(["rev-parse", "--show-toplevel"], ctx.cwd));
  const [fingerprint, snapshot] = await Promise.all([
    definitionFingerprint(root, ctx.requirement),
    collectGitSnapshot({ repoRoot: root, excludePaths: [`.pi-company/requirements/${ctx.requirement}/acceptance.md`] }),
  ]);
  return {
    definitionFingerprint: createHash("sha256").update(`${fingerprint}\0${snapshot.fingerprint}`).digest("hex"),
    codeHead: snapshot.head,
  };
}

async function dispatch(
  params: Record<string, unknown>,
  ctx: { dataRoot: string; cwd: string },
): Promise<WorkflowActionResult> {
  const action = params.action as string;

  if (action === "list") {
    const cwd = (params.cwd as string | undefined) ?? ctx.cwd;
    const result = await listRequirements({ dataRoot: ctx.dataRoot, cwd });
    if (!result.ok) {
      const safeReason = redactAbsolutePaths(result.reason);
      return { ok: false, text: `list 失败：${safeReason}`, details: { isError: true, reason: safeReason } };
    }
    const summary = result.items.length > 0 ? result.items.map((item) => `${item.requirement}(${item.stage})`).join("、") : "无进行中需求";
    return { ok: true, text: `list 成功：${summary}`, details: { isError: false, items: result.items } };
  }

  const req = await requireRequirement(params, ctx);
  if (!req.ok) return req.receipt;
  const wctx = req.wctx;

  switch (action) {
    case "query": {
      const state = await readRequirementState(wctx);
      if (!state.exists) return failReceipt(wctx.requirement, action, "需求状态不存在");
      const fields = params.fields as string[] | undefined;
      const data = fields ? pick(state.data as unknown as Record<string, unknown>, fields) : state.data;
      const summary = fields ? fields.join("、") : "全部字段";
      return {
        ok: true,
        text: `${wctx.requirement} ${action} 成功：${summary}，version ${state.version}`,
        details: { isError: false, data, version: state.version },
      };
    }
    case "init": {
      const result = await initRequirementState(wctx);
      return formatReceipt(wctx.requirement, action, result, "初始化");
    }
    case "update": {
      const update = (params.update ?? {}) as Record<string, unknown>;
      const { followUpIssues, ...rest } = update;
      const taskId = params.task as string | undefined;
      const hasFields = Object.keys(rest).length > 0;
      const hasFollowUps = followUpIssues !== undefined;
      if (hasFields && taskId === undefined) return failReceipt(wctx.requirement, action, "缺少 task");
      if (!hasFields && !hasFollowUps) return failReceipt(wctx.requirement, action, "缺少可更新字段");
      if (params.version === undefined) return failReceipt(wctx.requirement, action, "缺少 version");
      const fields = hasFields ? rest : undefined;
      let followUps: unknown[] | undefined;
      if (hasFollowUps) {
        const state = await readRequirementState(wctx);
        if (!state.exists) return failReceipt(wctx.requirement, action, "需求状态不存在");
        followUps = [...state.data.followUps, ...(followUpIssues as unknown[])];
      }
      const result = await updateTaskFields({ expectedVersion: params.version as number, taskId, fields, followUps }, wctx);
      return formatReceipt(wctx.requirement, action, result, updateSummary(fields, followUpIssues as unknown[] | undefined));
    }
    case "advance": {
      const version = await currentVersion(wctx);
      const result = await advanceStage(
        {
          expectedVersion: params.version as number,
          targetStage: params.stage as string,
          decisionId: params.decisionId as string | undefined,
          runId: params.runId as string | undefined,
          currentVersion: version,
        },
        wctx,
      );
      return formatReceipt(wctx.requirement, action, result, params.stage as string);
    }
    case "retreat": {
      const result = await retreatStage(
        {
          expectedVersion: params.version as number,
          targetStage: params.stage as string,
          reason: params.reason as string,
          decisionId: params.decisionId as string | undefined,
          runId: params.runId as string | undefined,
        },
        wctx,
      );
      return formatReceipt(wctx.requirement, action, result, params.stage as string);
    }
    case "task-start": {
      const result = await startTask({ expectedVersion: params.version as number, taskId: params.task as string, runId: params.runId as string }, wctx);
      return formatReceipt(wctx.requirement, action, result, params.task as string);
    }
    case "task-finish": {
      const version = await currentVersion(wctx);
      const result = await finishTask(
        { expectedVersion: params.version as number, taskId: params.task as string, runId: params.runId as string, currentVersion: version },
        wctx,
      );
      return formatReceipt(wctx.requirement, action, result, params.task as string);
    }
    case "task-fail": {
      const result = await failTask(
        { expectedVersion: params.version as number, taskId: params.task as string, runId: params.runId as string, reason: params.reason as string },
        wctx,
      );
      return formatReceipt(wctx.requirement, action, result, params.task as string);
    }
    case "rollback": {
      const result = await rollbackTask(
        { expectedVersion: params.version as number, taskId: params.task as string, decisionId: params.decisionId as string | undefined },
        wctx,
      );
      return formatReceipt(wctx.requirement, action, result, params.task as string);
    }
    case "reject": {
      const result = await rejectRequirement({ expectedVersion: params.version as number, decisionId: params.decisionId as string | undefined }, wctx);
      return formatReceipt(wctx.requirement, action, result, "拒绝");
    }
    case "shape-confirm": {
      const runId = params.runId as string | undefined;
      if (!runId) return failReceipt(wctx.requirement, action, "缺少 runId");
      const identity = await repositoryIdentity(wctx.cwd);
      const runStore = new RunStore({ dataRoot: wctx.dataRoot, repoId: identity.repoId, daemonStartedAt: "workflow-tool" });
      const got = await runStore.get(runId);
      if (!got.ok) return failReceipt(wctx.requirement, action, `运行不存在或不可读: ${runId}`);
      const run = got.run;
      if (run.state !== "completed") return failReceipt(wctx.requirement, action, `运行未完成: ${run.state}`);
      const planResult = run.result as
        | { phase?: string; verdict?: string; proposedShape?: Omit<RequirementShape, "decisionId">; binding?: { requirement?: string } }
        | undefined;
      if (!planResult) return failReceipt(wctx.requirement, action, "运行结果缺失");
      const mismatches: string[] = [];
      if (planResult.phase !== "plan") mismatches.push(`phase 期望 plan 实际 ${planResult.phase}`);
      if (planResult.verdict !== "PASS") mismatches.push(`verdict 期望 PASS 实际 ${planResult.verdict}`);
      if (run.requirement !== wctx.requirement) mismatches.push("运行需求不一致");
      if (planResult.binding?.requirement !== wctx.requirement) mismatches.push("绑定需求不一致");
      if (mismatches.length > 0) return failReceipt(wctx.requirement, action, mismatches.join("; "));
      const proposedShape = planResult.proposedShape;
      if (!proposedShape) return failReceipt(wctx.requirement, action, "运行结果缺少 proposedShape");
      const shape: RequirementShape = { ...proposedShape, decisionId: params.decisionId as string };
      const result = await recordShape({ expectedVersion: params.version as number, shape }, wctx);
      return formatReceipt(wctx.requirement, action, result, "形状确认");
    }
    case "resume-check": {
      const version = await currentVersion(wctx);
      const result = await checkResume(wctx, version);
      if (!result.ok) return failReceipt(wctx.requirement, action, result.reason);
      return {
        ok: true,
        text: `${wctx.requirement} ${action} 成功：${result.stage}，version ${result.version}`,
        details: { isError: false, stage: result.stage },
      };
    }
    default:
      return failReceipt(wctx.requirement, action, "不支持的动作");
  }
}

export async function executeWorkflowAction(
  params: Record<string, unknown>,
  ctx: { dataRoot: string; cwd: string },
): Promise<WorkflowActionResult> {
  const requirement = typeof params.requirement === "string" ? params.requirement : "(未知需求)";
  const action = typeof params.action === "string" ? params.action : "(未知动作)";
  if (!Value.Check(PARAMETERS, params)) {
    const reason = [...Value.Errors(PARAMETERS, params)].map((error) => error.message).join("; ");
    return failReceipt(requirement, action, `参数不合法: ${reason}`);
  }
  try {
    return await dispatch(params, ctx);
  } catch (error) {
    const staleVersion = error instanceof StaleVersionError;
    return failReceipt(requirement, action, (error as Error).message, staleVersion);
  }
}

export async function retryOnStaleVersion(
  ctx: { dataRoot: string; cwd: string },
  requirement: string,
  buildUpdate: (state: { version: number; data: RequirementState }) => Promise<Record<string, unknown>>,
): Promise<WorkflowActionResult> {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    const state = await readRequirementState({ dataRoot: ctx.dataRoot, cwd: ctx.cwd, requirement });
    if (!state.exists) return failReceipt(requirement, "update", "需求状态不存在");
    const update = await buildUpdate({ version: state.version, data: state.data });
    const result = await executeWorkflowAction({ action: "update", requirement, version: state.version, update }, ctx);
    if (result.ok || !result.details.staleVersion) return result;
  }
  return failReceipt(requirement, "update", `版本冲突重试超限（${MAX_RETRY_ATTEMPTS} 次），${STALE_VERSION_MARK}`);
}

export function createWorkflowTool(options: CreateWorkflowToolOptions) {
  return {
    name: "pi_company_workflow",
    label: "需求工作流",
    description: "驱动需求工作流阶段推进、任务管理与形状确认",
    parameters: PARAMETERS,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "操作已中止" }], details: { isError: true } };
      }
      const cwd = options.cwd ?? ctx.cwd;
      if (options.boundRequirement && (
        (params.requirement !== undefined && params.requirement !== options.boundRequirement) ||
        (params.cwd !== undefined && await realpath(params.cwd as string) !== await realpath(cwd)) ||
        params.action === "list"
      )) throw new Error("需求代理只能操作绑定的仓库与需求");
      const boundParams = options.boundRequirement ? { ...params, requirement: options.boundRequirement, cwd } : params;
      if (params.action === "task-finish" && typeof params.runId === "string") await options.beforeTaskFinish?.(params.runId, signal);
      const result = await executeWorkflowAction(boundParams, { dataRoot: options.dataRoot, cwd });
      if (result.ok && options.boundRequirement && options.onStateChange) {
        const state = await readRequirementState({ dataRoot: options.dataRoot, cwd, requirement: options.boundRequirement });
        if (state.exists) options.onStateChange(state.data);
      }
      if (!result.ok) throw new Error(result.text);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  };
}
