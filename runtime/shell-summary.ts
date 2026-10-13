import type { Clock } from "./clock.ts";
import type { Host, ShellRegistry, TaskActivity } from "./shell-registry.ts";
import { sanitizeText } from "./text-sanitize.ts";

export interface ShellSummaryClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ShellSummaryRepo {
  repoId: string;
  client: ShellSummaryClient;
}

export interface ShellStatusBar {
  setStatus(text: string | undefined): void;
}

export interface ShellSummaryGroup {
  label: string;
  count: number;
}

export interface ShellSummary {
  total: number;
  uncertain: number;
  groups: ShellSummaryGroup[];
  errors: string[];
}

export interface ShellSummaryInput {
  registry: ShellRegistry;
  repos: ShellSummaryRepo[];
}

export interface PublishShellStatusInput extends ShellSummaryInput {
  clock: Clock;
  statusBar: ShellStatusBar;
}

// 状态栏文本按码点兜底截断；显示宽度由宿主 footer 自行处理
const MAX_STATUS_TEXT_LENGTH = 8_000;

interface DaemonShellEntry {
  host: Host;
  activity: TaskActivity;
  inWorkspace?: boolean;
}

interface CountAccumulator {
  total: number;
  uncertain: number;
  groupCounts: Map<string, number>;
  groupOrder: string[];
}

function groupLabel(host: Host): string {
  return host.kind === "main" ? "主 agent" : (host.role ?? "worker").replace(/^one-company\./, "");
}

function newAccumulator(): CountAccumulator {
  return { total: 0, uncertain: 0, groupCounts: new Map(), groupOrder: [] };
}

// 待确认任务身份尚未核对清楚，不能计入"确定在跑"的总数与角色分组，只在 uncertain 里单独体现
function addEntry(acc: CountAccumulator, entry: DaemonShellEntry): void {
  if (entry.activity === "ended" || entry.inWorkspace === false) return;
  if (entry.activity === "uncertain") {
    acc.uncertain += 1;
    return;
  }
  acc.total += 1;
  const label = groupLabel(entry.host);
  if (!acc.groupCounts.has(label)) acc.groupOrder.push(label);
  acc.groupCounts.set(label, (acc.groupCounts.get(label) ?? 0) + 1);
}

function finalize(acc: CountAccumulator, errors: string[]): ShellSummary {
  return {
    total: acc.total,
    uncertain: acc.uncertain,
    groups: acc.groupOrder.map((label) => ({ label, count: acc.groupCounts.get(label) as number })),
    errors,
  };
}

export async function summarizeShells(input: ShellSummaryInput): Promise<ShellSummary> {
  const acc = newAccumulator();
  for (const task of input.registry.list()) addEntry(acc, { host: task.host, activity: task.activity });
  const errors: string[] = [];
  for (const repo of input.repos) {
    try {
      const result = await repo.client.call("shells.list");
      const tasks = (result.tasks ?? []) as DaemonShellEntry[];
      for (const task of tasks) addEntry(acc, task);
    } catch (error) {
      errors.push(`${repo.repoId}：${(error as Error).message}`);
    }
  }
  return finalize(acc, errors);
}

export function formatShellSummary(summary: ShellSummary): string | undefined {
  const hasErrors = summary.errors.length > 0;
  if (summary.total === 0 && summary.uncertain === 0 && !hasErrors) return undefined;

  const parts: string[] = [];
  if (summary.total > 0) {
    const groupText = summary.groups.map((g) => `${g.label}：${g.count}`).join(" · ");
    parts.push(groupText ? `shell：${summary.total} · ${groupText}` : `shell：${summary.total}`);
  }
  if (summary.uncertain > 0) parts.push(`待确认：${summary.uncertain}`);
  if (hasErrors) parts.push(summary.errors.join("; "));
  // 状态栏只占一行：通用净化保留换行以服务多行场景，这里额外把换行折叠成空格
  return sanitizeText(parts.join(" · "), MAX_STATUS_TEXT_LENGTH).replace(/\n/g, " ");
}

export function publishShellStatus(input: PublishShellStatusInput): Promise<void> {
  return summarizeShells(input).then((summary) => {
    input.statusBar.setStatus(formatShellSummary(summary));
  });
}

export function startShellStatusRefresh(input: PublishShellStatusInput, intervalMs: number): () => void {
  let inFlight = false;
  const handle = input.clock.setIntervalExcludingSleep(() => {
    if (inFlight) return;
    inFlight = true;
    publishShellStatus(input).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  return () => input.clock.clearTimer(handle);
}
