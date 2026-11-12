export interface LineSwitchItem {
  requirementId: string;
  title: string;
  lifecycle: "draft" | "active" | "closing" | "closed";
  before: string | null;
  tip: string;
  tipVersion: number | null;
  currentVersion: number | null;
  afterApproval: boolean;
  lastSaved: number | null;
  failure?: { reason: string; conversationVersion: number | null; logPath?: string };
}

export interface LineSwitchReport { restored: LineSwitchItem[]; approved: LineSwitchItem[]; failed: LineSwitchItem[] }

const bySavedThenTitle = (a: LineSwitchItem, b: LineSwitchItem) =>
  (a.lastSaved ?? Infinity) - (b.lastSaved ?? Infinity) || a.title.localeCompare(b.title);

export function lineSwitchKind(item: Omit<LineSwitchItem, "title">): keyof LineSwitchReport | null {
  if (item.failure) return "failed";
  if (item.lifecycle === "draft") return item.before === item.tip ? null : "restored";
  return item.afterApproval ? null : "approved";
}

export function lineSwitchReport(items: readonly LineSwitchItem[]): LineSwitchReport {
  const report: LineSwitchReport = { restored: [], approved: [], failed: [] };
  for (const item of items) {
    const kind = lineSwitchKind(item);
    if (kind) report[kind].push(item);
  }
  for (const group of Object.values(report)) group.sort(bySavedThenTitle);
  return report;
}

export function restoreMessageText(report: LineSwitchReport): string | undefined {
  const blocks = [
    ...report.restored.map((item) => `「${item.title}」已恢复至版本 ${item.tipVersion}`),
    ...report.approved.map((item) => `「${item.title}」已批准，以库里的版本 ${item.currentVersion} 为准`),
    ...report.failed.map((item) => {
      const target = item.failure!.conversationVersion === null ? "对话里的那一版" : `版本 ${item.failure!.conversationVersion}`;
      return [`「${item.title}」没能恢复至${target}${item.currentVersion === null ? "" : `，仍是版本 ${item.currentVersion}`}`,
        `- 原因：${item.failure!.reason}`,
        `- 下一步：主代理先读取库里的内容再操作；要用回${target}，让主代理照对话里的内容重新保存一次`,
        ...(item.failure!.logPath ? [`- 运行日志：${item.failure!.logPath}`] : []),
      ].join("\n");
    }),
  ];
  return blocks.length ? blocks.join("\n\n") : undefined;
}

export function windowLineMemory() {
  let tips = new Map<string, string>();
  return {
    tipOf: (requirementId: string): string | null => tips.get(requirementId) ?? null,
    remember(line: Readonly<Record<string, readonly string[]>>): void {
      tips = new Map(Object.entries(line).flatMap(([requirementId, anchors]) => anchors.length ? [[requirementId, anchors.at(-1)!] as const] : []));
    },
  };
}
