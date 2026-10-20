import { createHash } from "node:crypto";
import { commandOutputTail } from "../../core/exec/tool-failure.ts";
import { gitIn } from "../../core/exec/target-branch.ts";

export interface ArchiveFile { path: string; hash: string }

async function blobHash(worktree: string, listing: string[]): Promise<string | null> {
  const blob = /\b([0-9a-f]{40,64})\b/.exec((await gitIn(worktree, listing)).stdout)?.[1];
  return blob ? createHash("sha256").update((await gitIn(worktree, ["cat-file", "blob", blob])).stdout, "utf8").digest("hex") : null;
}

async function allMatch(worktree: string, files: ArchiveFile[], listing: (path: string) => string[]): Promise<boolean> {
  for (const file of files) if (await blobHash(worktree, listing(`:(literal)${file.path}`)) !== file.hash) return false;
  return true;
}

export async function archiveInHead(worktree: string, files: ArchiveFile[]): Promise<boolean> {
  return allMatch(worktree, files, (path) => ["ls-tree", "HEAD", "--", path]);
}

/** `commit --only` 只提交归档路径，使用户暂存区和工作区里的其他改动保持原样。 */
export async function commitArchive(worktree: string, requirementId: string, files: ArchiveFile[]): Promise<void> {
  if (await archiveInHead(worktree, files)) return;
  const literal = files.map((file) => `:(literal)${file.path}`);
  const unstage = () => gitIn(worktree, ["reset", "-q", "--", ...literal]).catch(() => undefined);
  await gitIn(worktree, ["add", "-f", "--", ...literal]);
  if (!await allMatch(worktree, files, (path) => ["ls-files", "-s", "--", path])) {
    await unstage();
    throw new Error("归档提交失败：仓库的换行或过滤设置（.gitattributes）改变了归档文件内容，提交进去会和登记的不一致；请用户检查 .gitattributes 对 docs/prd 的设置后再归档");
  }
  try {
    await gitIn(worktree, ["commit", "--quiet", "--only", "-m", `docs(prd): 归档需求 ${requirementId}`, "-m", `Requirement: ${requirementId}`, "--", ...literal]);
  } catch (error) {
    await unstage();
    throw new Error(`归档提交失败：${commandOutputTail(error)}；请用户检查需求工作区的 Git 设置（例如配置 Git 用户名和邮箱）后再归档`);
  }
}
