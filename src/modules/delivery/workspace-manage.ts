import { execFile } from "node:child_process";
import { commandOutputTail, withDetail } from "../../core/exec/tool-failure.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { Static } from "typebox";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import { gitVersion, readGit, versionAtLeast } from "../../core/exec/git-read.ts";
import { checked, commit, id, object } from "../requirement/requirement-contracts.ts";
import { RequirementService } from "../requirement/requirement-service.ts";
import { RequirementStateStore } from "../requirement/requirement-state.ts";
import { mutedLines } from "../../core/host/question-window.ts";
import type { ProgramWindow } from "../../core/host/question-window.ts";
import { verifyRequirementWorkspace } from "../requirement/requirement-workspace.ts";
import { RequirementCloseService } from "./workflow-close.ts";

const execFileAsync = promisify(execFile);
export const MANAGED_WORKSPACES = "managed_workspaces";
export const WORKTREE_CONTAINER = ".one-company-worktrees";

const ManagedWorkspace = object({
  format: Type.Literal("managed-workspace/v1"), requirementId: id, title: Type.String({ minLength: 1, maxLength: 1024 }), operationId: id, baseCommit: commit,
  branch: Type.String({ pattern: "^refs/heads/req/" }), path: Type.String({ minLength: 1, maxLength: 4096 }),
  status: Type.Union([Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("recycled")]),
  recycleOperationId: Type.Union([id, Type.Null()]),
});
export type ManagedWorkspace = Static<typeof ManagedWorkspace>;

const WORKSPACE_ADVICE = {
  requirement_not_active: { why: "需求不在可准备工作区的状态", next: "重新读取需求状态后再操作" },
  requirement_not_closed: { why: "需求还没关闭，不能回收工作区", next: "等需求关闭并归档后再回收" },
  declined: { why: "用户在界面上拒绝了这次操作", next: "不要重试；确实需要时先向用户说明原因再问" },
  path_conflict: { why: "工作区目标路径已被占用", next: "请用户处理该路径后重试" },
  branch_conflict: { why: "需求分支名已被占用且不属于本需求", next: "请用户处理同名分支后重试" },
  not_prepared: { why: "需求还没有准备工作区", next: "先用 workspace-prepare 准备工作区" },
  recycle_blocked: { why: "工作区还不能回收", next: "按原因逐项处理后再回收" },
  git_failed: { why: "Git 命令执行失败", next: "按 Git 的报错处理；需要改动仓库时请用户介入" },
} as const satisfies Record<string, FailureAdvice>;
export type WorkspaceManageErrorCode = keyof typeof WORKSPACE_ADVICE;
export class WorkspaceManageError extends Error {
  readonly code: WorkspaceManageErrorCode;
  readonly blockers: string[];
  readonly advice: FailureAdvice;
  constructor(code: WorkspaceManageErrorCode, blockers: string[] = [], next?: string) {
    super(blockers.length > 0 ? `${code}: ${blockers.join("；")}` : code);
    this.name = "WorkspaceManageError"; this.code = code; this.blockers = blockers;
    this.advice = withDetail(next ? { ...WORKSPACE_ADVICE[code], next } : WORKSPACE_ADVICE[code], blockers.join("；"));
  }
}

export interface WorkspaceManageOptions {
  /** 主仓库真实根目录；新 worktree 从这里创建。 */
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 真实用户在宿主界面的确认；返回 false 即拒绝。 */
  confirm: (window: ProgramWindow) => Promise<boolean>;
  gitVersion?: () => Promise<string>;
}

interface RecycleCheck { blockers: string[]; tooOldGit: string | null; unmerged: boolean }

// 固定参数写 Git：关闭 hook 与 fsmonitor，避免创建/回收现场时执行仓库内脚本
async function writeGit(cwd: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: { ...process.env, LC_ALL: "C" }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    })).stdout.trim();
  } catch (error) {
    throw new WorkspaceManageError("git_failed", [`git ${args.slice(0, 2).join(" ")}：${commandOutputTail(error)}`]);
  }
}
async function gitOutput(cwd: string, args: string[], timeout?: number): Promise<string | null> {
  try { return (await readGit(cwd, args, { timeout })).stdout.trim(); } catch { return null; }
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

  /** 需求关闭后正文拒读，所以标题在创建工作区时从已批准正文读出并随工作区记录保存，回收时直接用。 */
  private async approvedTitle(requirementId: string): Promise<string> {
    const service = await RequirementService.open({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.options.repoId,
      authorize: (request) => request.repoId === this.options.repoId && ["metadata", "readApproved"].includes(request.action)
        && (request.requirementId === undefined || request.requirementId === requirementId) });
    return (await service.read({ requirementId, source: "approved" })).title;
  }

  async prepare(input: { requirementId: string }): Promise<ManagedWorkspace> {
    checked(id, input.requirementId);
    const record = this.state.read(input.requirementId);
    if (record.data.lifecycle !== "active") throw new WorkspaceManageError("requirement_not_active", ["需求批准生效后才能创建工作区"]);
    const existing = this.read(input.requirementId);
    if (existing?.status === "ready") return existing;
    const operationId = existing?.operationId ?? uuidv7();
    const location = workspaceLocation(this.options.repositoryRoot, input.requirementId);
    let baseCommit = existing?.baseCommit ?? await gitOutput(this.options.repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const unbornBranch = baseCommit ? null : await gitOutput(this.options.repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!baseCommit && !unbornBranch) throw new WorkspaceManageError("git_failed", ["rev-parse HEAD"]);
    if (!existing) {
      const title = await this.approvedTitle(input.requirementId);
      const approved = await this.options.confirm({ title: "确认创建需求工作区", lines: [{ text: `需求：${title}` }, ...mutedLines([
        `编号：${input.requirementId}`, `分支：${location.branch.slice("refs/heads/".length)}`, `目录：${location.path}`,
        `基线提交：${baseCommit ?? `仓库还没有任何提交，确认后先在 ${unbornBranch} 分支上建一个空提交（说明为 init）作为基线`}`,
        "主仓库未提交的改动不会带入新工作区。"])] });
      if (!approved) throw new WorkspaceManageError("declined");
      baseCommit ??= await this.initCommit();
      this.save({ format: "managed-workspace/v1", requirementId: input.requirementId, title, operationId, baseCommit,
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

  // 用空树建提交并只在分支仍无提交时写入，不碰用户的暂存区和工作目录
  private async initCommit(): Promise<string> {
    const root = this.options.repositoryRoot;
    const tree = await writeGit(root, ["hash-object", "-w", "-t", "tree", "/dev/null"]);
    const commit = await writeGit(root, ["commit-tree", "--no-gpg-sign", "-m", "init", tree]);
    await writeGit(root, ["update-ref", "-m", "init", "HEAD", commit, ""]);
    return commit;
  }

  async recycle(input: { requirementId: string }): Promise<ManagedWorkspace> {
    checked(id, input.requirementId);
    const plan = this.read(input.requirementId);
    if (!plan || plan.status === "preparing") throw new WorkspaceManageError("not_prepared");
    if (plan.status === "recycled") return plan;
    const record = this.state.read(input.requirementId);
    if (record.data.lifecycle !== "closed") throw new WorkspaceManageError("requirement_not_closed");

    const check = await this.recycleBlockers(plan, record.data.workspace);
    if (check.blockers.length > 0) throw this.blockedError(plan, check);
    const approved = await this.options.confirm({ title: "确认回收需求工作区", lines: [{ text: `需求：${plan.title}` }, ...mutedLines([
      `编号：${input.requirementId}`, `将移除目录：${plan.path}`, `将删除本地分支：${plan.branch.slice("refs/heads/".length)}`,
      "不删除主仓库、其他分支、远端分支或本机需求记录。"])] });
    if (!approved) throw new WorkspaceManageError("declined");
    const recheck = await this.recycleBlockers(plan, record.data.workspace);
    if (recheck.blockers.length > 0) throw this.blockedError(plan, recheck);

    if (await exists(plan.path)) await writeGit(this.options.repositoryRoot, ["worktree", "remove", plan.path]);
    if (await gitOutput(this.options.repositoryRoot, ["rev-parse", "--verify", "--quiet", plan.branch]) !== null) {
      await writeGit(this.options.repositoryRoot, ["branch", "-D", plan.branch.slice("refs/heads/".length)]);
    }
    const recycled = { ...plan, status: "recycled" as const, recycleOperationId: uuidv7() };
    this.save(recycled);
    return recycled;
  }

  private blockedError(plan: ManagedWorkspace, check: RecycleCheck): WorkspaceManageError {
    const steps: string[] = [];
    if (check.tooOldGit) steps.push("升级 Git 后再回收");
    if (check.unmerged) {
      const branch = plan.branch.slice("refs/heads/".length);
      steps.push(`1. 远端已经合并的，先在主仓库把目标分支拉到本地（例如 git pull）再回收；2. 还没合并的，先交付或自己合并；3. 合并后主分支又改了同一处代码、确认改动都已进去的，自己运行 git worktree remove '${plan.path}' 和 git branch -D ${branch}`);
    }
    const others = check.blockers.length > (check.tooOldGit ? 1 : 0) + (check.unmerged ? 1 : 0);
    const next = steps.length === 0 ? undefined : others ? `按原因逐项处理后再回收；${steps.join("；")}` : steps.join("；");
    return new WorkspaceManageError("recycle_blocked", check.blockers, next);
  }

  // merge-tree 不碰工作区、暂存区和任何分支：合并后的树等于主仓库当前树，说明需求分支的改动已全部进了主仓库
  private async mergedInto(tip: string): Promise<boolean> {
    const root = this.options.repositoryRoot;
    const merged = await gitOutput(root, ["merge-tree", "--write-tree", "HEAD", tip], 120_000);
    const tree = await gitOutput(root, ["rev-parse", "HEAD^{tree}"]);
    return merged !== null && tree !== null && merged.split("\n")[0] === tree;
  }

  private async recycleBlockers(plan: ManagedWorkspace, binding: Parameters<typeof verifyRequirementWorkspace>[1] | null): Promise<RecycleCheck> {
    const blockers: string[] = [];
    let tooOldGit: string | null = null;
    let unmerged = false;
    const done = (): RecycleCheck => ({ blockers, tooOldGit, unmerged });
    const close = await RequirementCloseService.open({ repositoryRoot: this.options.repositoryRoot, dataRoot: this.options.dataRoot, repoId: this.options.repoId,
      authorize: (request) => request.action === "status" && request.requirementId === plan.requirementId });
    try {
      const status = close.status(plan.requirementId);
      if (status.status === "none" || status.status !== "closed") blockers.push("关闭收尾尚未完成");
      else if (status.archive && status.archive.status !== "archived") blockers.push("最终归档尚未完成");
    } finally { close.dispose(); }
    const pendingWrites = withDatabase(this.database, (db) => db.list<{ requirementId?: string; status?: string }>("change_sets")
      .filter((row) => row.data.requirementId === plan.requirementId && (row.data.status === "applying" || row.data.status === "partial_failure")).length);
    if (pendingWrites > 0) blockers.push("存在未完成或待恢复的受控写入");
    let tip: string | null;
    if (await exists(plan.path)) {
      if (binding) {
        try { await verifyRequirementWorkspace(this.options.dataRoot, binding); } catch { blockers.push("工作区身份或分支已被外部改变"); return done(); }
      }
      const dirty = await gitOutput(plan.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (dirty === null) blockers.push("无法读取工作区状态");
      else if (dirty.length > 0) blockers.push("存在未提交或未跟踪的文件");
      tip = await gitOutput(plan.path, ["rev-parse", "HEAD"]);
    } else {
      tip = await gitOutput(this.options.repositoryRoot, ["rev-parse", "--verify", "--quiet", `${plan.branch}^{commit}`]);
      if (tip === null) return done();
    }
    const mainHead = await gitOutput(this.options.repositoryRoot, ["rev-parse", "HEAD"]);
    if (!tip || !mainHead) blockers.push("无法读取分支提交");
    else if (tip !== mainHead) {
      const version = await (this.options.gitVersion ?? gitVersion)();
      if (!versionAtLeast(version, "2.38")) {
        tooOldGit = version;
        blockers.push(`本机 Git 版本 ${version} 低于 2.38，判断不了需求是否已合并`);
      } else if (!(await this.mergedInto(tip))) {
        unmerged = true;
        const mainBranch = await gitOutput(this.options.repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const target = mainBranch ? `主仓库当前分支 ${mainBranch}` : `主仓库当前提交 ${mainHead.slice(0, 7)}`;
        blockers.push(`需求分支 ${plan.branch.slice("refs/heads/".length)} 还有改动没进${target}`);
      }
    }
    return done();
  }
}
