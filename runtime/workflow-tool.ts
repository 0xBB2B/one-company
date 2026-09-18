import { realpath } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { repositoryIdentity } from "./identity.ts";
import { readGit } from "./git-read.ts";
import { repositoryDatabase, UUID_V7_PATTERN } from "./database.ts";
import { assertLegacyRequirementId, checkedRequirement, withLegacyReadDatabase, VALID_TASK_PROGRESS } from "./workflow-state.ts";
import type { DefinitionVersion, RequirementState } from "./workflow-state.ts";
import { LEGACY_WORKFLOW_RETIRED } from "./decision-record-tool.ts";

const METADATA_FIELDS = ["requirement", "stage", "tasks"] as const;
export const LEGACY_METADATA_LIMIT = 100;
export const LEGACY_METADATA_BYTES = 16_384;
const PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("query"), Type.Literal("list")]),
  requirement: Type.Optional(Type.String({ maxLength: 128 })), cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LEGACY_METADATA_LIMIT })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  byteLimit: Type.Optional(Type.Integer({ minimum: 2048, maximum: LEGACY_METADATA_BYTES })),
  fields: Type.Optional(Type.Array(Type.Union(METADATA_FIELDS.map((field) => Type.Literal(field))), { maxItems: METADATA_FIELDS.length })),
}, { additionalProperties: false });
export interface MetadataPageOptions { limit?: number; offset?: number; byteLimit?: number }
export function checkedMetadataPage(options: MetadataPageOptions) {
  const { limit = LEGACY_METADATA_LIMIT, offset = 0, byteLimit = LEGACY_METADATA_BYTES } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEGACY_METADATA_LIMIT || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLimit) || byteLimit < 2048 || byteLimit > LEGACY_METADATA_BYTES) throw new Error("元数据分页参数无效");
  return { limit, offset, byteLimit };
}
/** 只控制展示；停止遍历不使用此分页。unknown记录只计数，不回传未验证的键。 */
export function legacyMetadataPage<T>(items: T[], options: MetadataPageOptions, unknown = 0, unconfirmed = false) {
  const { limit, offset, byteLimit } = checkedMetadataPage(options);
  const selected: T[] = []; let bytes = 1024;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > byteLimit) break;
    selected.push(item); bytes += size;
  }
  const remaining = Math.max(0, items.length - offset - selected.length);
  return { items: selected, coverage: { total: items.length + unknown, validated: items.length, returned: selected.length, offset,
    remaining, unknown, truncated: remaining > 0 || offset > 0 || unknown > 0, nextOffset: remaining > 0 ? offset + selected.length : null,
    byteLimit, ...(unconfirmed ? { unconfirmed: items.length + unknown, unconfirmedOutsidePage: items.length + unknown - selected.length, notice: "状态记录不是进程停止证明；未展示项和未知项仍需核对" } : { notice: "仅旧状态元数据，不证明当前授权或验收；未知项已保全待核对" }) } };
}
export interface WorkflowActionResult { ok: boolean; text: string; details: Record<string, unknown> }
export interface CreateWorkflowToolOptions {
  dataRoot: string; cwd?: string; boundRequirement?: string;
  beforeTaskFinish?: (runId: string, signal?: AbortSignal) => Promise<void>;
  onStateChange?: (state: RequirementState) => void;
}
function retired(): WorkflowActionResult { return { ok: false, text: LEGACY_WORKFLOW_RETIRED, details: { isError: true, code: "legacy_workflow_retired" } }; }
export async function currentVersion(_ctx: { cwd: string; requirement: string }): Promise<DefinitionVersion> { throw new Error(LEGACY_WORKFLOW_RETIRED); }
async function queryIdentity(cwd: string): Promise<string> {
  const actual = await realpath(cwd);
  const repo = await repositoryIdentity(actual);
  const root = await realpath((await readGit(actual, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const gitDir = (await readGit(actual, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  let branch: string;
  try { branch = (await readGit(actual, ["symbolic-ref", "-q", "HEAD"])).stdout.trim(); }
  catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    branch = `detached:${(await readGit(actual, ["rev-parse", "--verify", "HEAD"])).stdout.trim()}`;
  }
  return JSON.stringify({ actual, repoId: repo.repoId, root, gitDir, branch });
}
function validRow(row: Record<string, unknown>): void {
  if (typeof row.id !== "string" || !UUID_V7_PATTERN.test(row.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.data !== "string") throw new Error("元数据记录无效");
}
export async function executeWorkflowAction(params: Record<string, unknown>, ctx: { dataRoot: string; cwd: string }): Promise<WorkflowActionResult> {
  if (params.action !== "query" && params.action !== "list") return retired();
  if (!Value.Check(PARAMETERS, params)) return { ok: false, text: "只允许有界的白名单状态元数据查询", details: { isError: true } };
  try {
    const cwd = await realpath(ctx.cwd);
    if (params.cwd !== undefined && await realpath(params.cwd as string) !== cwd) throw new Error("查询不能切换现场");
    const baseline = await queryIdentity(cwd);
    const identity = await repositoryIdentity(cwd);
    const details = withLegacyReadDatabase(repositoryDatabase(ctx.dataRoot, identity.repoId), (db) => {
      if (params.action === "list") {
        const items: Array<{ requirement: string; stage: string }> = []; let unknown = 0;
        for (const row of db.prepare("SELECT id, record_key, version, data FROM records WHERE namespace = 'requirements' ORDER BY id").all()) {
          if (typeof row.record_key === "string" && UUID_V7_PATTERN.test(row.record_key)) continue;
          try {
            validRow(row); assertLegacyRequirementId(row.record_key);
            const state = checkedRequirement(JSON.parse(row.data as string), row.record_key);
            items.push({ requirement: state.requirement, stage: state.stage });
          } catch { unknown++; }
        }
        return { isError: false, ...legacyMetadataPage(items, params as MetadataPageOptions, unknown) };
      }
      assertLegacyRequirementId(params.requirement);
      const row = db.prepare("SELECT id, version, data FROM records WHERE namespace = 'requirements' AND record_key = ?").get(params.requirement);
      if (!row) throw new Error("需求状态不存在"); validRow(row);
      const state = checkedRequirement(JSON.parse(row.data as string), params.requirement);
      const tasks: Array<{ id: string; progress: string; runId: string | null }> = []; let unknown = 0;
      for (const [id, task] of Object.entries(state.tasks)) {
        if (!/^T-\d{1,10}$/.test(id) || !task || typeof task !== "object" || !(VALID_TASK_PROGRESS as readonly unknown[]).includes(task.progress)
          || !(task.runId === null || typeof task.runId === "string" && UUID_V7_PATTERN.test(task.runId))) { unknown++; continue; }
        if (task.runId !== null) {
          const run = db.prepare("SELECT record_key, json_extract(data, '$.id') AS id, json_extract(data, '$.requirement') AS requirement, json_extract(data, '$.task') AS task FROM records WHERE namespace = 'runs' AND record_key = ?").get(task.runId);
          if (!run || run.id !== task.runId || run.record_key !== run.id || run.requirement !== state.requirement || run.task !== id) { unknown++; continue; }
        }
        tasks.push({ id, progress: task.progress, runId: task.runId });
      }
      const page = legacyMetadataPage(tasks, params as MetadataPageOptions, unknown, true);
      const metadata = { requirement: state.requirement, stage: state.stage, tasks: Object.fromEntries(page.items.map(({ id, ...task }) => [id, task])) };
      const fields = params.fields as Array<keyof typeof metadata> | undefined;
      const data = fields ? Object.fromEntries(fields.map((field) => [field, metadata[field]])) : metadata;
      const coverage = fields && !fields.includes("tasks")
        ? { ...page.coverage, returned: 0, remaining: tasks.length, unconfirmedOutsidePage: tasks.length + unknown, truncated: tasks.length + unknown > 0, nextOffset: tasks.length ? 0 : null }
        : page.coverage;
      return { isError: false, data, version: Number(row.version), coverage };
    });
    if (baseline !== await queryIdentity(cwd)) throw new Error("现场身份已变化");
    return { ok: true, text: "旧需求状态元数据（不产生执行权限；覆盖及未确认项见coverage）", details };
  } catch { return { ok: false, text: "旧需求状态未初始化、不可读或现场身份不符", details: { isError: true, code: "legacy_metadata_unavailable" } }; }
}
export async function retryOnStaleVersion(_ctx: { dataRoot: string; cwd: string }, _requirement: string, _buildUpdate: (state: { version: number; data: RequirementState }) => Promise<Record<string, unknown>>): Promise<WorkflowActionResult> { return retired(); }
export function createWorkflowTool(options: CreateWorkflowToolOptions) {
  let binding: string | undefined;
  return {
    name: "pi_company_workflow", label: "旧需求状态", description: "只查询有界的旧需求元数据；不提供变更、授权或恢复能力", parameters: PARAMETERS,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      if (signal?.aborted) throw new Error("操作已中止");
      if (params.action !== "query" && params.action !== "list") throw new Error(LEGACY_WORKFLOW_RETIRED);
      const cwd = options.cwd ?? ctx.cwd;
      try {
        const current = await queryIdentity(cwd);
        if (binding !== undefined && binding !== current || await queryIdentity(ctx.cwd) !== current
          || params.cwd !== undefined && await realpath(params.cwd as string) !== await realpath(cwd)) throw new Error("现场身份不符");
        binding = current;
      } catch { throw new Error("只能查询可信当前仓库及工作区的状态元数据"); }
      if (options.boundRequirement && (params.action === "list" || params.requirement !== undefined && params.requirement !== options.boundRequirement)) throw new Error("只能查询绑定需求的状态元数据");
      const boundParams = options.boundRequirement ? { ...params, requirement: options.boundRequirement, cwd } : params;
      const result = await executeWorkflowAction(boundParams, { dataRoot: options.dataRoot, cwd });
      if (!result.ok) throw new Error(result.text);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  };
}
