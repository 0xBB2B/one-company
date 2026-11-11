import { repositoryDatabase, uuidv7, withDatabase } from "../../src/core/storage/database.ts";
import { commitDraftFiles, readDraftFiles } from "../../src/modules/requirement/prd-storage.ts";
import { createLineAnchorIn, lineViewIn } from "../../src/modules/requirement/line-anchors.ts";
import { approvalFileCommit } from "../../src/modules/delivery/approved-files.ts";

export const DESIGN_BASE = "# 界面设计规范\n## 颜色\n- 主色：#0f766e\n- 文字：#1f2933\n## 组件\n- 按钮：圆角 4px\n- 输入框：圆角 4px\n";
export const DESIGN_DRAFT = DESIGN_BASE.replace("- 按钮：圆角 4px", "- 按钮：圆角 8px");
export const DESIGN_MAIN_COLOR = DESIGN_BASE.replace("- 主色：#0f766e", "- 主色：#2563eb");
export const DESIGN_MAIN_COMPONENT = DESIGN_BASE.replace("- 按钮：圆角 4px", "- 按钮：圆角 2px");
export const AGENTS_BASE = "# 项目规范\n## 命名\n- 文件名用小写。\n";
export const AGENTS_DRAFT = `${AGENTS_BASE}## 测试\n- 每个功能配一个测试。\n`;
export const PROTOTYPE_HTML = "<html><body>设置页</body></html>\n";

export const SCENARIO_CHANGES: Record<string, string> = {
  "prototypes/设置页.v1.html": PROTOTYPE_HTML,
  "DESIGN.md": DESIGN_DRAFT, "DESIGN.base.md": DESIGN_BASE,
  "AGENTS.md": AGENTS_DRAFT, "AGENTS.base.md": AGENTS_BASE,
};

interface Config { dataRoot: string; repoId: string }

/** 在草稿这条线上追加一个装着这些文件改动的提交，返回新锚点；changes 里值为 null 的路径表示删除。 */
export async function addDraftFiles(config: Config, input: { requirementId: string; line: string[]; changes: Record<string, string | null> }): Promise<string> {
  const database = repositoryDatabase(config.dataRoot, config.repoId);
  const expectedParent = withDatabase(database, (db) => lineViewIn(db, input.requirementId, input.line).tip?.fileCommit);
  if (!expectedParent) throw new Error("草稿线上还没有保存过的提交");
  const anchor = uuidv7();
  const { commit } = await commitDraftFiles({ ...config, requirementId: input.requirementId, operationId: anchor, anchor, kind: "prototype", expectedParent,
    changes: Object.fromEntries(Object.entries(input.changes).map(([path, text]) => [path, text === null ? null : Buffer.from(text)])), authorize: () => true });
  withDatabase(database, (db) => createLineAnchorIn(db, { repoId: config.repoId, requirementId: input.requirementId, anchor, kind: "conventions", line: input.line, now: Date.now(), fileCommit: commit }));
  return anchor;
}

/** 批准的 prd.md 字节。 */
export async function approvedPrdBytes(config: Config, requirementId: string): Promise<Buffer> {
  const files = await readDraftFiles({ ...config, requirementId, commit: approvalFileCommit(config.dataRoot, config.repoId, requirementId), authorize: () => true });
  return Buffer.from(files.prd);
}
