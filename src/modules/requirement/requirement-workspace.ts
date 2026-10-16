import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readGit } from "../../core/exec/git-read.ts";
import { assertDataRootOutsideWorktrees } from "../../core/storage/database-paths.ts";
import { listWorktrees, repositoryIdentity } from "../../core/storage/identity.ts";
import { RequirementStateError } from "./requirement-contracts.ts";
import type { WorkspaceBinding } from "./requirement-contracts.ts";

function parseSingleGitRef(output: string): string {
  const terminatorLength = output.endsWith("\r\n") ? 2 : output.endsWith("\n") ? 1 : 0;
  if (terminatorLength === 0) throw new RequirementStateError("invalid_git_ref_output");
  const ref = output.slice(0, -terminatorLength);
  if (ref.length === 0 || ref.includes("\r") || ref.includes("\n")) throw new RequirementStateError("invalid_git_ref_output");
  return ref;
}

/** 只读核对预备现场；不创建、切换或回收分支/worktree，不提供创建授权。 */
export async function inspectRequirementWorkspace(dataRoot: string, repoId: string, input: { path: string; requirementId: string; prepareOperationId: string; baseCommit: string }): Promise<WorkspaceBinding> {
  if (!isAbsolute(input.path)) throw new RequirementStateError("absolute_workspace_required");
  const root = await realpath(input.path);
  const identity = await repositoryIdentity(root);
  if (identity.repoId !== repoId) throw new RequirementStateError("foreign_repository");
  const worktrees = await listWorktrees(identity.commonDir);
  assertDataRootOutsideWorktrees(dataRoot, worktrees);
  const actualRoot = await realpath((await readGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim());
  const gitDir = await realpath((await readGit(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim());
  if (root !== actualRoot || gitDir === identity.commonDir) throw new RequirementStateError("independent_worktree_required");
  const branch = parseSingleGitRef((await readGit(root, ["symbolic-ref", "--quiet", "HEAD"])).stdout);
  if (!branch.startsWith("refs/heads/")) throw new RequirementStateError("branch_required");
  await readGit(root, ["cat-file", "-e", `${input.baseCommit}^{commit}`]);
  const [rootInfo, gitInfo] = await Promise.all([stat(root), stat(gitDir)]);
  const identityFields = { rootDevice: rootInfo.dev, rootInode: rootInfo.ino, gitDevice: gitInfo.dev, gitInode: gitInfo.ino };
  return { requirementId: input.requirementId, prepareOperationId: input.prepareOperationId, baseCommit: input.baseCommit,
    repoId, path: root, gitDir, branch, ...identityFields, workspaceId: createHash("sha256").update(JSON.stringify([gitDir, ...Object.values(identityFields)])).digest("hex") };
}

export async function verifyRequirementWorkspace(dataRoot: string, binding: WorkspaceBinding): Promise<void> {
  const actual = await inspectRequirementWorkspace(dataRoot, binding.repoId, binding);
  if (actual.workspaceId !== binding.workspaceId || actual.branch !== binding.branch || actual.path !== binding.path || actual.gitDir !== binding.gitDir) throw new RequirementStateError("workspace_binding_changed");
}
