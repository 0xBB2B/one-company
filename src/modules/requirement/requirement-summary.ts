import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";

const SUMMARIES = "requirement_summaries";
export const SUMMARY_MAX_CHARS = 200;

interface SummaryRecord { prdHash: string; summary: string }

const hex = (prdHash: string) => prdHash.replace(/^sha256:/u, "");

/** 记下某一版草稿的简介；只保留最新保存的那一版。 */
export function saveRequirementSummary(dataRoot: string, repoId: string, requirementId: string, prdHash: string, summary: string): void {
  const value: SummaryRecord = { prdHash: hex(prdHash), summary };
  withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.transaction(() => {
    const row = db.read<SummaryRecord>(SUMMARIES, requirementId);
    if (row) db.update(SUMMARIES, requirementId, row.version, value);
    else db.create(SUMMARIES, requirementId, value);
  }));
}

/** 只返回与给定草稿版本指纹对应的简介，版本对不上时为 undefined。 */
export function requirementSummary(dataRoot: string, repoId: string, requirementId: string, prdHash: string): string | undefined {
  const row = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.read<SummaryRecord>(SUMMARIES, requirementId));
  return row && row.data.prdHash === hex(prdHash) ? row.data.summary : undefined;
}
