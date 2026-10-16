import { repositoryDatabase, uuidv7, withDatabase } from "../../src/core/storage/database.ts";
import type { PmLease, RequirementRecord } from "../../src/modules/requirement/requirement-contracts.ts";
import { createRequirementReadTool } from "../../src/modules/pm/requirement-read-tool.ts";

/** 像 PM 收到更新通知后那样，按通知里的版本号用 diff 读完全部分页，返回每条通知对应的差异正文。 */
export async function readNoticedDiffs(options: { repositoryRoot: string; dataRoot: string; repoId: string; lease: PmLease }, notices: string[]): Promise<string[]> {
  const { lease } = options;
  const workspace = withDatabase(repositoryDatabase(options.dataRoot, options.repoId),
    (db) => db.read<RequirementRecord>("requirements", lease.requirementId))!.data.workspace!;
  const tool = await createRequirementReadTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, authorize: () => true,
    binding: { role: "pm", callerId: uuidv7(), runId: lease.runId, requirementId: lease.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, lease } });
  try {
    const texts: string[] = [];
    for (const notice of notices) {
      const match = /revision (\d+) → (\d+)/u.exec(notice);
      if (!match) continue;
      let text = "", cursor: string | undefined;
      do {
        const page = await tool.execute(cursor ? { action: "next", cursor } : { action: "diff", fromRevision: Number(match[1]), toRevision: Number(match[2]) }) as
          { text: string; coverage: { nextCursor: string | null } };
        text += page.text;
        cursor = page.coverage.nextCursor ?? undefined;
      } while (cursor);
      texts.push(text);
    }
    return texts;
  } finally { tool.dispose(); }
}
