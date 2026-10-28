import type { Clock } from "../../core/policy/clock.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import type { AgentSessionHandle } from "./agent-session.ts";
import { CORE_TOOL_PREFIX } from "./role-tools.ts";

export type RunStepStatus = "running" | "done" | "error";
export interface RunStep { id: string; parentId?: string; text: string; status: RunStepStatus }
export type RunStepsState = "queued" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped" | "interrupted";
export interface RunStepsView { state: RunStepsState; reason?: string; turns: number; maxTurns: number | null; elapsedMs: number; steps: RunStep[] }

const MAX_STEP_TEXT = 1000;
// 已结束的子代理不能回看；打开着的窗口拿到结束状态后 0.5 秒内就停止取数，所以留 60 秒足够
const ENDED_KEEP_MS = 60_000;
const ENDING_EVENTS = ["completed", "failed", "turn_limit_reached", "ended_without_result", "stopped"] as const;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const field = (args: unknown, key: string): unknown => (typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined);
const withTarget = (label: string, target: string | undefined) => (target === undefined ? label : `${label} ${target}`);

function filePaths(args: unknown): string {
  const files = field(args, "files");
  if (!Array.isArray(files)) return "";
  return files.map((file) => str(field(file, "path"))).filter((path): path is string => path !== undefined).join("、");
}

function describe(toolName: string, args: unknown): string {
  if (toolName === "read") return withTarget("读", str(field(args, "path")));
  if (toolName === "grep" || toolName === "find") {
    const pattern = str(field(args, "pattern"));
    const path = str(field(args, "path"));
    const head = toolName === "grep" ? withTarget("搜", pattern === undefined ? undefined : `"${pattern}"`) : withTarget("找文件", pattern);
    return path === undefined ? head : `${head} 在 ${path}`;
  }
  if (toolName === "ls") return `列目录 ${str(field(args, "path")) ?? "."}`;
  if (!toolName.startsWith(CORE_TOOL_PREFIX)) return toolName;
  const action = field(args, "action");
  switch (toolName.slice(CORE_TOOL_PREFIX.length)) {
    case "knowledge_query": {
      const query = field(args, "query"), kind = field(query, "action");
      const value = kind === "exact" ? str(field(query, "value")) : kind === "search" || kind === "facts" ? str(field(query, "text")) : undefined;
      return withTarget("查项目知识", value === undefined ? undefined : `"${value}"`);
    }
    case "change_apply":
      switch (action) {
        case "prepare": return withTarget("预检改动", filePaths(args) || undefined);
        case "apply": return withTarget("写入", filePaths(args) || undefined);
        case "import": return withTarget("导入", filePaths(args) || undefined);
        case "status": return "查写入结果";
        default: return toolName;
      }
    case "verification_run":
      if (action === "run") return withTarget("跑命令", str(field(args, "command")));
      return action === "status" ? "查命令结果" : action === "stop" ? "停命令" : toolName;
    case "requirement_manage": return "读需求";
    case "plan_manage": return "读计划";
    case "result_submit": return "交结果";
    default: return toolName;
  }
}

export function stepText(toolName: string, args: unknown): string {
  return sanitizeText(describe(toolName, args).replace(/[\x00-\x1f\x7f-\x9f]/g, " "), MAX_STEP_TEXT);
}

type TrackedHandle = Pick<AgentSessionHandle, "events" | "state" | "turnsUsed">;
interface Entry {
  steps: RunStep[];
  handle?: TrackedHandle;
  owner?: string;
  maxTurns: number | null;
  startedAt: number;
  ended?: { state: string; reason?: string; turns: number; endedAt: number };
  settled?: boolean;
}

export class RunStepBook {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;

  constructor(options: { clock: Clock }) {
    this.clock = options.clock;
  }

  track(runId: string, handle: TrackedHandle, options: { maxTurns?: number; owner?: string } = {}): void {
    const entry: Entry = { steps: [], handle, owner: options.owner, maxTurns: options.maxTurns ?? null, startedAt: Date.now() };
    this.entries.set(runId, entry);
    handle.events.on("tool_start", (event: { toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }) => {
      entry.steps.push({ id: event.toolCallId, ...(event.parentToolCallId === undefined ? {} : { parentId: event.parentToolCallId }), text: stepText(event.toolName, event.args), status: "running" });
    });
    handle.events.on("tool_end", (event: { toolCallId: string; isError: boolean }) => {
      const step = entry.steps.find((candidate) => candidate.id === event.toolCallId);
      if (step) step.status = event.isError ? "error" : "done";
    });
    for (const name of ENDING_EVENTS) {
      handle.events.on(name, (event?: { reason?: string }) => {
        if (entry.settled) return;
        this.end(runId, entry, { state: handle.state(), reason: name === "failed" ? event?.reason : undefined, turns: handle.turnsUsed(), endedAt: Date.now() });
      });
    }
  }

  settle(runId: string, result: { state: "completed" | "failed" | "stopped"; reason?: string }): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    const { turns, endedAt } = entry.ended ?? { turns: entry.handle!.turnsUsed(), endedAt: Date.now() };
    entry.settled = true;
    this.end(runId, entry, { state: result.state, reason: result.reason, turns, endedAt });
  }

  private end(runId: string, entry: Entry, ended: NonNullable<Entry["ended"]>): void {
    const first = entry.ended === undefined;
    entry.ended = ended;
    entry.handle = undefined;
    if (first) this.clock.setTimeoutExcludingSleep(() => { if (this.entries.get(runId) === entry) this.entries.delete(runId); }, ENDED_KEEP_MS);
  }

  steps(runId: string): RunStep[] | undefined {
    return this.entries.get(runId)?.steps.map((step) => ({ ...step }));
  }

  mainStatus(runId: string, connectionId: string): { state: string; reason?: string; turns: number; maxTurns: number | null; startedAt: number; endedAt?: number } | undefined {
    const entry = this.entries.get(runId);
    if (!entry || entry.owner === undefined || entry.owner !== connectionId) return undefined;
    const { maxTurns, startedAt } = entry;
    if (entry.ended) return { state: entry.ended.state, ...(entry.ended.reason === undefined ? {} : { reason: entry.ended.reason }), turns: entry.ended.turns, maxTurns, startedAt, endedAt: entry.ended.endedAt };
    return { state: entry.handle!.state(), turns: entry.handle!.turnsUsed(), maxTurns, startedAt };
  }
}
