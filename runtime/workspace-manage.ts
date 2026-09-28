import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { Static } from "typebox";
import { repositoryDatabase, withDatabase } from "./database.ts";
import { readGit } from "./git-read.ts";
import { checked, commit, id, object } from "./requirement-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { RequirementCloseService } from "./workflow-close.ts";

const execFileAsync = promisify(execFile);
export const MANAGED_WORKSPACES = "managed_workspaces";
export const WORKTREE_CONTAINER = ".pi-company-worktrees";

const ManagedWorkspace = object({
  format: Type.Literal("managed-workspace/v1"), requirementId: id, operationId: id, baseCommit: commit,
  branch: Type.String({ pattern: "^refs/heads/req/" }), path: Type.String({ minLength: 1, maxLength: 4096 }),
  status: Type.Union([Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("recycled")]),
  recycleOperationId: Type.Union([id, Type.Null()]),
});
export type ManagedWorkspace = Static<typeof ManagedWorkspace>;

export type WorkspaceManageErrorCode = "requirement_not_active" | "requirement_not_closed" | "declined" | "path_conflict" | "branch_conflict"
  | "operation_conflict" | "not_prepared" | "recycle_blocked" | "git_failed";
export class WorkspaceManageError extends Error {
  readonly code: WorkspaceManageErrorCode;
  readonly blockers: string[];
  constructor(code: WorkspaceManageErrorCode, blockers: string[] = []) {
    super(blockers.length > 0 ? `${code}: ${blockers.join("；")}` : code);
    this.name = "WorkspaceManageError"; this.code = code; this.blockers = blockers;
  }
}

export interface WorkspaceManageOptions {
  /** 主仓库真实根目录；新 worktree 从这里创建。 */
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 真实用户在宿主界面的确认；返回 false 即拒绝。 */
  confirm: (title: string, message: string) => Promise<boolean>;
}

// 固定参数写 Git：关闭 hook 与 fsmonitor，避免创建/回收现场时执行仓库内脚本
async function writeGit(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: { ...process.env, LC_ALL: "C" }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new WorkspaceManageError("git_failed", [args.slice(0, 2).join(" ")]);
  }
}
async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try { return (await readGit(cwd, args)).stdout.trim(); } catch { return null; }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

export function workspaceLocation(repositoryRoot: string, requirementId: string): { branch: string; path: string } {
  return { branch: `refs/heads/req/${requirementId}`, path: join(dirname(repositoryRoot), WORKTREE_CONTAINER, basename(repositoryRoot), requirementId) };
}

export class WorkspaceManageService {
  private readonly database: string;
  private readonly options: WorkspaceManageOptions;
  private readonly state: RequirementStateStore;
  private constructor(options: WorkspaceManageOptions, state: RequirementStateStore) {
    this.options = options;
    this.state = state;
    this.database = repositoryDatabase(options.dataRoot, options.repoId);
  }

  static async open(options: WorkspaceManageOptions): Promise<WorkspaceManageService> {
    const state = await RequirementStateStore.open({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: options.repoId,
      authorize: (request) => request.repoId === options.repoId && ["open", "read", "bind-workspace"].includes(request.action) });
    return new WorkspaceManageService({ ...options, repositoryRoot: await realpath(options.repositoryRoot) }, state);
  }

  read(requirementId: string): ManagedWorkspace | null {
    const row = withDatabase(this.database, (db) => db.read<unknown>(MANAGED_WORKSPACES, requirementId));
    return row ? checked(ManagedWorkspace, row.data) : null;
  }

  private save(next: ManagedWorkspace): void {
    const value = checked(ManagedWorkspace, next);
    withDatabase(this.database, (db) => db.transaction(() => {
      const row = db.read<unknown>(MANAGED_WORKSPACES, value.requirementId);
      if (row) db.update(MANAGED_WORKSPACES, value.requirementId, row.version, value);
      else db.create(MANAGED_WORKSPACES, value.requirementId, value);
    }));
  }

  /** 绑定或解绑工作区会让需求版本加一，调用方后续的需求操作要用这个新版本。 */
  requirementVersion(requirementId: string): number {
    return this.state.read(checked(id, requirementId)).version;
  }

  async prepare(input: { requirementId: string; operationId: string }): Promise<ManagedWorkspace> {
    checked(id, input.requirementId); checked(id, input.operationId);
    const record = this.state.read(input.requirementId);
    if (record.data.lifecycle !== "active") throw new WorkspaceManageError("requirement_not_active", ["需求批准生效后才能创建工作区"]);
    const existing = this.read(input.requirementId);
    if (existing && existing.operationId !== input.operationId) {
      if (existing.status === "ready") return existing;
      throw new WorkspaceManageError("operation_conflict");
    }
    const location = workspaceLocation(this.options.repositoryRoot, input.requirementId);
    const baseCommit = existing?.baseCommit ?? await gitOutput(this.options.repositoryRoot, ["rev-parse", "HEAD"]);
    if (!baseCommit) throw new WorkspaceManageError("git_failed", ["rev-parse HEAD"]);
    if (!existing) {
      const approved = await this.options.confirm("确认创建需求工作区",
        `需求：${input.requirementId}\n分支：${location.branch}\n目录：${location.path}\n基线提交：${baseCommit}\n主仓库未提交的改动不会带入新工作区。`);
      if (!approved) throw new WorkspaceManageError("declined");
      this.save({ format: "managed-workspace/v1", requirementId: input.requirementId, operationId: input.operationId, baseCommit,
        branch: location.branch, path: location.path, status: "preparing", recycleOperationId: null });
    }
    const plan = this.read(input.requirementId)!;
    if (plan.status === "ready") return plan;

    const branchTip = await gitOutput(this.options.repositoryRoot, ["rev-parse", "--verify", "--quiet", `${plan.branch}^{commit}`]);
    if (branchTip !== null && branchTip !== plan.baseCommit && !(await exists(plan.path))) throw new WorkspaceManageError("branch_conflict");
    if (await exists(plan.path)) {
      // 续办中断的创建：目录必须正是本仓库登记分支的 worktree，否则不碰身份不明的目录
      const head = await gitOutput(plan.path, ["symbolic-ref", "--quiet", "HEAD"]);
      const common = await gitOutput(plan.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const ownCommon = await gitOutput(this.options.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (head !== plan.branch || common === null || common !== ownCommon) throw new WorkspaceManageError("path_conflict");
    } else {
      await mkdir(dirname(plan.path), { recursive: true });
      await writeGit(this.options.repositoryRoot, branchTip === null
        ? ["worktree", "add", "-b", plan.branch.slice("refs/heads/".length), plan.path, plan.baseCommit]
        : ["worktree", "add", plan.path, plan.branch.slice("refs/heads/".length)]);
    }
    const fresh = this.state.read(input.requirementId);
    await this.state.bindWorkspace({ requirementId: input.requirementId, version: fresh.version, path: plan.path,
      prepareOperationId: plan.operationId, baseCommit: plan.baseCommit });
    const ready = { ...plan, status: "ready" as const };
    this.save(ready);
    return ready;
  }

  async recycle(input: { requirementId: string; operationId: string }): Promise<ManagedWorkspace> {
    checked(id, input.requirementId); checked(id, input.operationId);
    const plan = this.read(input.requirementId);
    if (!plan || plan.status === "preparing") throw new WorkspaceManageError("not_prepared");
    if (plan.status === "recycled") return plan;
    const record = this.state.read(input.requirementId);
    if (record.data.lifecycle !== "closed") throw new WorkspaceManageError("requirement_not_closed");

    const blockers = await this.recycleBlockers(plan, record.data.workspace);
    if (blockers.length > 0) throw new WorkspaceManageError("recycle_blocked", blockers);
    const approved = await this.options.confirm("确认回收需求工作区",
      `需求：${input.requirementId}\n将移除目录：${plan.path}\n将删除本地分支：${plan.branch}\n不删除主仓库、其他分支、远端分支或本机需求记录。`);
    if (!approved) throw new WorkspaceManageError("declined");
    const recheck = await this.recycleBlockers(plan, record.data.workspace);
    if (recheck.length > 0) throw new WorkspaceManageError("recycle_blocked", recheck);

    if (await exists(plan.path)) await writeGit(this.options.repositoryRoot, ["worktree", "remove", plan.path]);
    if (await gitOutput(this.options.repositoryRoot, ["rev-parse", "--verify", "--quiet", plan.branch]) !== null) {
      await writeGit(this.options.repositoryRoot, ["branch", "-d", plan.branch.slice("refs/heads/".length)]);
    }
    const recycled = { ...plan, status: "recycled" as const, recycleOperationId: input.operationId };
    this.save(recycled);
    return recycled;
  }

  private async recycleBlockers(plan: ManagedWorkspace, binding: Parameters<typeof verifyRequirementWorkspace>[1] | null): Promise<string[]> {
    const blockers: string[] = [];
    const close = await RequirementCloseService.open({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.options.repoId,
      authorize: (request) => request.action === "status" && request.requirementId === plan.requirementId });
    try {
      const status = close.status(plan.requirementId);
      if (status.status === "none" || status.status !== "closed") blockers.push("关闭收尾尚未完成");
      else if (status.archive && status.archive.status !== "archived") blockers.push("最终归档尚未完成");
    } finally { close.dispose(); }
    const pendingWrites = withDatabase(this.database, (db) => db.list<{ requirementId?: string; status?: string }>("change_sets")
      .filter((row) => row.data.requirementId === plan.requirementId && row.data.status !== "applied").length);
    if (pendingWrites > 0) blockers.push("存在未完成或待恢复的受控写入");
    if (!(await exists(plan.path))) return blockers;
    if (binding) {
      try { await verifyRequirementWorkspace(this.options.dataRoot, binding); } catch { blockers.push("工作区身份或分支已被外部改变"); return blockers; }
    }
    const dirty = await gitOutput(plan.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty === null) blockers.push("无法读取工作区状态");
    else if (dirty.length > 0) blockers.push("存在未提交或未跟踪的文件");
    const tip = await gitOutput(plan.path, ["rev-parse", "HEAD"]);
    const mainHead = await gitOutput(this.options.repositoryRoot, ["rev-parse", "HEAD"]);
    if (!tip || !mainHead) blockers.push("无法读取分支提交");
    else if (tip !== mainHead && (await gitOutput(this.options.repositoryRoot, ["merge-base", "--is-ancestor", tip, mainHead])) === null) blockers.push("分支存在未合并进主仓库当前分支的提交");
    return blockers;
  }
}
