import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";

const SUMMARIES = "requirement_summaries";
export const SUMMARY_MAX_CHARS = 200;

interface SummaryRecord { summary: string }

const keyOf = (requirementId: string, prdHash: string) => `${requirementId}:${prdHash.replace(/^sha256:/u, "")}`;

/** 记下某一版草稿的简介；每一版正文各存一份。 */
export function saveRequirementSummary(dataRoot: string, repoId: string, requirementId: string, prdHash: string, summary: string): void {
  const key = keyOf(requirementId, prdHash), value: SummaryRecord = { summary };
  withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.transaction(() => {
    const row = db.read<SummaryRecord>(SUMMARIES, key);
    if (row) db.update(SUMMARIES, key, row.version, value);
    else db.create(SUMMARIES, key, value);
  }));
}

/** 返回给定草稿版本的简介，这一版没存过时为 undefined。 */
export function requirementSummary(dataRoot: string, repoId: string, requirementId: string, prdHash: string): string | undefined {
  return withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.read<SummaryRecord>(SUMMARIES, keyOf(requirementId, prdHash)))?.data.summary;
}
