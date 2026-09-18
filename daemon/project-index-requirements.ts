import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertDataRootOutsideWorktrees } from "../runtime/database-paths.ts";
import { readGit } from "../runtime/git-read.ts";
import { listWorktrees, repositoryIdentity } from "../runtime/identity.ts";
import { RequirementStateError } from "../runtime/requirement-contracts.ts";
import { RequirementEventService } from "../runtime/requirement-events.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { verifyRequirementWorkspace } from "../runtime/requirement-workspace.ts";
import type { ProjectIndexArchiveRiskHookEvent } from "./project-index-coordinator.ts";

const HASH = /^[0-9a-f]{64}$/u;
const ARCHIVE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(.+)\.md$/u;
const LIMITS = Object.freeze({ maxEntries: 20_000, maxMetadataBytes: 4 * 1024 * 1024, maxPending: 64 });

export interface ProjectIndexRequirementsOptions {
  readonly repositoryRoot: string;
  readonly dataRoot: string;
  readonly repoId: string;
  /** 仅可收紧元数据枚举预算，不限制或读取归档正文大小。 */
  readonly maxEntries?: number;
  readonly maxMetadataBytes?: number;
}

export class ProjectIndexRequirementsError extends Error {
  readonly code: "invalid_binding" | "unsafe_archive_directory" | "metadata_limit" | "archive_unstable" | "adapter_closed";

  constructor(code: ProjectIndexRequirementsError["code"]) {
    super(`归档生命周期核对被阻止：${code}`);
    this.name = "ProjectIndexRequirementsError";
    this.code = code;
  }
}

function absolute(path: string): boolean {
  return typeof path === "string" && isAbsolute(path) && resolve(path) === path;
}

function budget(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ProjectIndexRequirementsError("invalid_binding");
  return result;
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** 项目索引workspaceId按repo/root/branch的带字节长度字段编码；不同于需求的inode绑定ID。 */
function indexWorkspaceId(repoId: string, root: string, branch: string): string {
  const hash = createHash("sha256");
  for (const part of [repoId, root, branch]) hash.update(String(Buffer.byteLength(part))).update(":").update(part).update("|");
  return hash.digest("hex");
}

interface MetadataScan {
  readonly paths: Map<string, string[]>;
  readonly checks: Array<() => Promise<void>>;
  entries: number;
  bytes: number;
}

/**
 * 可信daemon持有的撤权适配器。hook每次全量核对必要目录名称，不读prod正文、正文Git或会话。
 * hook失败必须由调用方阻止常规同步/通知；close立即拒绝新授权，并等待自有在途操作结束。
 */
export class ProjectIndexRequirements {
  private readonly options: ProjectIndexRequirementsOptions;
  private readonly maxEntries: number;
  private readonly maxMetadataBytes: number;
  private closing = false;
  private pending = 0;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: ProjectIndexRequirementsOptions) {
    if (!options || !HASH.test(options.repoId) || !absolute(options.repositoryRoot) || !absolute(options.dataRoot)) throw new ProjectIndexRequirementsError("invalid_binding");
    this.options = Object.freeze({ ...options });
    this.maxEntries = budget(options.maxEntries, LIMITS.maxEntries);
    this.maxMetadataBytes = budget(options.maxMetadataBytes, LIMITS.maxMetadataBytes);
  }

  private assertOpen(): void {
    if (this.closing) throw new ProjectIndexRequirementsError("adapter_closed");
  }

  readonly beforeArchiveRisk = (input: Readonly<ProjectIndexArchiveRiskHookEvent>): Promise<void> => {
    try {
      this.assertOpen();
      if (this.pending >= LIMITS.maxPending) throw new ProjectIndexRequirementsError("metadata_limit");
      const event = structuredClone(input);
      this.pending++;
      const result = this.serial.then(() => this.reconcile(event));
      this.serial = result.then(() => undefined, () => undefined).finally(() => { this.pending--; });
      return result;
    } catch (error) { return Promise.reject(error); }
  };

  async close(): Promise<void> {
    this.closing = true;
    await this.serial;
  }

  private async directory(path: string): Promise<BigIntStats | null> {
    this.assertOpen();
    let info: BigIntStats;
    try { info = await lstat(path, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ProjectIndexRequirementsError("unsafe_archive_directory");
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o444n) === 0n || (info.mode & 0o111n) === 0n ||
      await realpath(path) !== path) throw new ProjectIndexRequirementsError("unsafe_archive_directory");
    return info;
  }

  private async scan(root: string, scan: MetadataScan): Promise<void> {
    const snapshots: Array<{ path: string; info: BigIntStats | null }> = [];
    for (const path of [root, join(root, "docs"), join(root, "docs", "prod")]) {
      const info = await this.directory(path);
      snapshots.push({ path, info });
      if (!info) break;
      if (path !== root) {
        for (const marker of [".git", ".giT", ".gIt", ".gIT", ".Git", ".GiT", ".GIt", ".GIT"]) {
          try {
            await lstat(join(path, marker));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new ProjectIndexRequirementsError("unsafe_archive_directory");
          }
          throw new ProjectIndexRequirementsError("unsafe_archive_directory");
        }
      }
    }
    const verify = async () => {
      for (const snapshot of snapshots) {
        const current = await this.directory(snapshot.path);
        if (snapshot.info === null ? current !== null : current === null || !sameDirectory(snapshot.info, current)) {
          throw new ProjectIndexRequirementsError("archive_unstable");
        }
      }
    };
    scan.checks.push(verify);
    if (snapshots.length !== 3 || snapshots[2]!.info === null) { await verify(); return; }
    const archiveRoot = join(root, "docs", "prod");
    // opendir逐项计数，避免先分配无界readdir数组；不递归、不打开任何归档文件。
    const directory = await opendir(archiveRoot, { bufferSize: 32 });
    try {
      for await (const entry of directory) {
        this.assertOpen();
        scan.entries++;
        scan.bytes += Buffer.byteLength(entry.name) + Buffer.byteLength(archiveRoot) + 1;
        if (scan.entries > this.maxEntries || scan.bytes > this.maxMetadataBytes) throw new ProjectIndexRequirementsError("metadata_limit");
        const path = join(archiveRoot, entry.name);
        if (path.length > 4096 || Buffer.byteLength(entry.name) > 255 || /[\u0000-\u001f\u007f/\\]/u.test(entry.name)) {
          throw new ProjectIndexRequirementsError("unsafe_archive_directory");
        }
        const info = await lstat(path, { bigint: true });
        if (!entry.isFile() || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
          throw new ProjectIndexRequirementsError("unsafe_archive_directory");
        }
        const match = ARCHIVE_NAME.exec(entry.name);
        if (!match || match[2] === "." || match[2] === "..") continue;
        const paths = scan.paths.get(match[1]!) ?? [];
        paths.push(path);
        scan.paths.set(match[1]!, paths);
      }
    } finally {
      // for-await负责正常和异常关闭；显式关闭覆盖迭代器开始前的失败。
      try { await directory.close(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
      }
    }
    await verify();
  }

  private async reconcile(event: Readonly<ProjectIndexArchiveRiskHookEvent>): Promise<void> {
    this.assertOpen();
    const { repoId, repositoryRoot, dataRoot } = this.options;
    const workspace = event?.workspace;
    if (!workspace || workspace.repoId !== repoId || !absolute(workspace.root) || event.repositoryRoot !== workspace.root ||
      typeof workspace.branch !== "string" || !workspace.branch.startsWith("refs/heads/") ||
      workspace.workspaceId !== indexWorkspaceId(repoId, workspace.root, workspace.branch)) {
      throw new ProjectIndexRequirementsError("invalid_binding");
    }
    const identity = await repositoryIdentity(repositoryRoot);
    if (identity.repoId !== repoId || await realpath(repositoryRoot) !== repositoryRoot ||
      (await repositoryIdentity(workspace.root)).commonDir !== identity.commonDir) throw new ProjectIndexRequirementsError("invalid_binding");
    const worktrees = new Set(await Promise.all((await listWorktrees(identity.commonDir)).map((path) => realpath(path))));
    assertDataRootOutsideWorktrees(dataRoot, [...worktrees]);
    if (!worktrees.has(repositoryRoot) || !worktrees.has(workspace.root)) throw new ProjectIndexRequirementsError("invalid_binding");
    const verifyEventWorkspace = async () => {
      this.assertOpen();
      if (await realpath(workspace.root) !== workspace.root ||
        (await repositoryIdentity(workspace.root)).repoId !== repoId ||
        (await readGit(workspace.root, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !== workspace.branch) {
        throw new ProjectIndexRequirementsError("invalid_binding");
      }
    };
    await verifyEventWorkspace();
    const scan: MetadataScan = { paths: new Map(), checks: [], entries: 0, bytes: 0 };
    const scanned = new Set<string>();
    const scanRoot = async (root: string) => {
      if (!scanned.has(root)) { scanned.add(root); await this.scan(root, scan); }
    };
    await scanRoot(repositoryRoot);
    await scanRoot(workspace.root);
    // 不枚举需求正文目录。仅向现有状态接口查询归档名称中出现的完整UUID。
    for (const requirementId of scan.paths.keys()) {
      this.assertOpen();
      const state = await RequirementStateStore.open({ dataRoot, repoId, repositoryRoot,
        authorize: (request) => !this.closing && request.repoId === repoId &&
          (request.action === "open" && request.input.repositoryRoot === repositoryRoot ||
            request.action === "read" && request.input.requirementId === requirementId) });
      let current;
      try { current = state.read(requirementId); }
      catch (error) {
        if (error instanceof RequirementStateError && error.code === "unknown_requirement") continue;
        throw error;
      }
      const binding = current.data.workspace;
      const terminal = current.data.lifecycle === "closing" || current.data.lifecycle === "closed";
      // 终态以SQLite记录为准，只核对当前扫描现场，不要求旧开发工作区保持活动绑定。
      if (binding && !terminal) {
        if (binding.repoId !== repoId || !worktrees.has(binding.path)) throw new ProjectIndexRequirementsError("invalid_binding");
        await verifyRequirementWorkspace(dataRoot, binding);
        await scanRoot(binding.path);
      }
      const allowedRoots = new Set([repositoryRoot, binding?.path].filter((root): root is string => Boolean(root))
        .map((root) => join(root, "docs", "prod")));
      const paths = scan.paths.get(requirementId)!.filter((path) => allowedRoots.has(dirname(path))).sort();
      if (paths.length === 0) continue;
      // 两条不同精确路径已足以证明身份冲突；不是挑选一个归档作为当前或可信正文。
      const evidence = Object.freeze(paths.slice(0, 2));
      for (const check of scan.checks) await check();
      await verifyEventWorkspace();
      if (binding && !terminal) await verifyRequirementWorkspace(dataRoot, binding);
      const service = await RequirementEventService.open({ ...this.options,
        authorize: (request) => !this.closing && request.repoId === repoId &&
          (request.action === "open" && request.requirementId === undefined ||
            request.action === "archive-risk" && request.requirementId === requirementId &&
            request.archivePaths?.length === evidence.length && request.archivePaths.every((path, index) => path === evidence[index])) });
      try { await service.reconcileArchiveRisk({ requirementId, paths: [...evidence] }); }
      finally { service.dispose(); }
    }
    for (const check of scan.checks) await check();
    await verifyEventWorkspace();
  }
}
