import type { ExploreResult } from "./explore-contracts.ts";

export interface ExploreReport {
  kind: "explore-report";
  runId: string;
  outcome: string;
  turnsUsed: number;
  research: ExploreResult | null;
  note?: string;
  reason?: string;
  next?: string;
  log?: string;
}

const NEXT = {
  main: "结论要写进需求草稿，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。",
  pm: "结论要写进计划或任务，或当作回答用户的依据时，先用 one_company_agent_manage action=sources 按 runId 取来源核对；只用来决定下一步再查什么时不用取。",
} as const;

export function exploreReportView(report: ExploreReport, audience: "main" | "pm"): unknown {
  const { research } = report;
  if (!research) return report;
  return {
    runId: report.runId, outcome: report.outcome, turnsUsed: report.turnsUsed,
    conclusions: research.conclusions, notFound: research.notFound, unknown: research.unknown, failures: research.failures,
    truncation: research.truncation, sourceCount: research.sources.length, next: NEXT[audience],
  };
}

export function exploreSourcesView(runId: string, research: ExploreResult): unknown {
  return { runId, sources: research.sources, searchedScope: research.searchedScope };
}
