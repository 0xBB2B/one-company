import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandBoundary, sandboxLaunch } from "./command-boundary.ts";
import { lstat, realpath, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { repoDataDir, repositoryIdentity } from "./identity.ts";
import { RangeClaims, fingerprint, verifyFingerprint } from "./ranges.ts";
import type { Holder } from "./ranges.ts";
import { RunStore } from "./run-store.ts";
import { currentBootId, processStartedAt, WindowRegistry } from "./windows.ts";
import { resolveRealRepoPath, snapshotForeignRanges, verifyAfterCommand, invalidateValidations } from "./write-guard.ts";
import { activeForeignHosts, scopedCommitPaths, snapshotBranchState, verifyBranchState } from "./branch-guard.ts";
import { createManagedBashOperations } from "./shell-bash.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import { parseChangedEntries } from "./git-snapshot.ts";
import type { Clock } from "./clock.ts";
import type { ShellRegistry } from "./shell-registry.ts";
import type { BashCommandGuard } from "./shell-bash.ts";

export async function createRangeProtection(input: {
  cwd: string; dataRoot: string; holder: Holder; writePaths: string[]; clock: Clock; shells: ShellRegistry;
}) {
  const identity = await repositoryIdentity(input.cwd);
  const gitDir = await realpath((await promisify(execFile)("git", ["rev-parse", "--absolute-git-dir"], { cwd: input.cwd })).stdout.trim());
  const repoDir = await repoDataDir(input.dataRoot, identity.repoId, identity.commonDir);
  const windows = new WindowRegistry({ repoDir, clock: input.clock, bootId: currentBootId, processStartedAt });
  const runs = new RunStore({ dataRoot: input.dataRoot, repoId: identity.repoId, daemonStartedAt: "range-check" });
  const claims = new RangeClaims({ repoDir, repoRoot: input.cwd, clock: input.clock,
    runState: async (id) => { const run = await runs.get(id); if (!run.ok) throw new Error(`范围持有者不可读: ${id}`); return run.run.state; },
    holderGone: (id) => windows.holderGone(id),
    activeShellTasks: async (id) => {
      const local = input.shells.list().filter((task) => task.host.runId === id && ["starting", "running", "stopping", "uncertain"].includes(task.status));
      const persisted = withDatabase(repositoryDatabase(input.dataRoot, identity.repoId), (db) => db.list<{ host: { runId?: string } }>("shells").filter((record) => record.data.host.runId === id));
      return local.length + persisted.length;
    },
  });
  const owned = new Map<string, string>();
  const normalize = async (path: string) => {
    const absolute = resolve(input.cwd, path);
    try { return (await lstat(absolute)).isDirectory() ? `${absolute}${sep}` : absolute; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return path.endsWith("/") ? `${absolute}${sep}` : absolute; }
  };
  async function acquire(paths: string[]) {
    for (const claim of await claims.entries()) await claims.releaseIfHolderGone(claim.claimId);
    const desired = (await Promise.all(paths.filter((path) => resolve(input.cwd, path) !== resolve(input.cwd)).map(normalize))).filter((path) => resolve(path) !== resolve(input.cwd) && !owned.has(path));
    if (desired.length === 0) return;
    const granted = await claims.claim(input.holder, desired);
    if (!granted.granted) throw new Error(granted.reason);
    for (const path of desired) owned.set(path, granted.claimId);
  }
  async function violation(paths: string[]) {
    if (paths.length === 0) return;
    const reason = `命令越界或现场核对失败: ${paths.join("、")}`;
    const requirements = new Set<string>();
    for (const path of paths) {
      const owner = await claims.holderOf(path).catch(() => null);
      if (owner?.requirement) requirements.add(owner.requirement);
    }
    for (const requirement of requirements) await invalidateValidations({ workflowCtx: { dataRoot: input.dataRoot, cwd: input.cwd, requirement }, reason });
    if (input.holder.runId) {
      const found = await runs.get(input.holder.runId);
      if (!found.ok) throw new Error("违规运行记录不可读");
      if (!["completed", "failed", "stopped"].includes(found.run.state)) await runs.update(input.holder.runId, { state: "failed", stateReason: reason });
    }
  }
  const scratchPaths = new Set<string>();
  let commitsInFlight = 0;
  const gitPaths = [identity.commonDir, gitDir, join(input.cwd, ".git")];
  let gitExecutable: Promise<string> | undefined;
  const executable = () => gitExecutable ??= (async () => {
    if (process.platform !== "darwin") throw new Error("此平台尚无可用的命令文件隔离后端");
    return realpath((await promisify(execFile)("/usr/bin/xcrun", ["--find", "git"])).stdout.trim());
  })();
  const foreignHosts = () => activeForeignHosts({ runStore: runs, windows, windowId: input.holder.windowId ?? "daemon", runId: input.holder.runId ?? "" });
  async function boundary() {
    const foreignPaths = (await claims.entries()).filter((claim) => claim.holder.runId !== input.holder.runId || claim.holder.windowId !== input.holder.windowId).flatMap((claim) => claim.paths);
    const result = await commandBoundary({ cwd: input.cwd, writePaths: input.writePaths, dataRoot: input.dataRoot, foreignPaths });
    result.readRoots.push(identity.commonDir, gitDir);
    scratchPaths.add(result.scratch);
    return result;
  }
  async function readGit(args: string[]) {
    const limits = await boundary();
    limits.writeRoots = [limits.scratch];
    limits.deniedWrites.push(...gitPaths);
    const launch = sandboxLaunch("", limits, { path: await executable(), args });
    const result = await promisify(execFile)(launch.command, launch.args, { cwd: input.cwd, env: launch.env, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
    return result.stdout;
  }
  const readChanges = async () => parseChangedEntries(await readGit(["status", "--porcelain=v1", "-z", "-uall"]));
  const commandGuard: BashCommandGuard = {
    async launch(command) {
      const limits = await boundary();
      limits.deniedWrites.push(...gitPaths);
      const hosts = await foreignHosts();
      const reason = `共享 Git 元数据只读；提交请使用 pi_company_git_commit 并指定路径。${hosts.length ? `其他活动宿主: ${hosts.join("、")}；禁止切换分支或重置共享现场。` : "分支切换与重置不属于受管 Shell 的写入权限。"}`;
      const launch = sandboxLaunch(command, limits);
      launch.args[launch.args.length - 1] = `${command}\npi_company_exit=$?; if [ "$pi_company_exit" -ne 0 ]; then printf '%s\\n' '${reason.replaceAll("'", "'\\''")}' >&2; fi; exit "$pi_company_exit"`;
      return launch;
    },
    async before() {
      await acquire(input.writePaths);
      return { snapshot: await snapshotForeignRanges({ repoRoot: input.cwd, claims, holder: input.holder }), branch: await snapshotBranchState({ repoRoot: input.cwd }) };
    },
    async after(raw) {
      const token = raw as { snapshot: Record<string, string>; branch: Awaited<ReturnType<typeof snapshotBranchState>> };
      const paths = await verifyAfterCommand({ repoRoot: input.cwd, claims, holder: input.holder, snapshot: token.snapshot, changedPaths: (await readChanges()).flatMap((entry) => entry.paths) });
      const hosts = await activeForeignHosts({ runStore: runs, windows, windowId: input.holder.windowId ?? "daemon", runId: input.holder.runId ?? "" });
      const branch = await verifyBranchState({ repoRoot: input.cwd, before: token.branch, activeHosts: hosts });
      if (branch.violation || branch.undetermined) paths.push("分支现场变化或无法核对");
      await violation(paths);
      return paths;
    },
  };
  async function checkWrite(path: string) {
    const lexical = await normalize(path);
    let target: string;
    try { target = resolve(input.cwd, await resolveRealRepoPath(input.cwd, lexical, lexical.endsWith("/"))); }
    catch (error) { return { ok: false as const, reason: (error as Error).message }; }
    if (gitPaths.some((path) => target === resolve(path) || target.startsWith(`${resolve(path)}${sep}`))) return { ok: false as const, reason: "共享 Git 元数据禁止直接写入；提交请使用 pi_company_git_commit" };
    if (!input.writePaths.some((scope) => { const boundary = resolve(input.cwd, scope); return resolve(target) === boundary || resolve(target).startsWith(`${boundary}${sep}`); })) return { ok: false as const, reason: `写入路径超出授权范围: ${path}` };
    try {
      await acquire(input.writePaths);
      const occupant = await claims.holderOf(target);
      if (occupant && (occupant.runId !== input.holder.runId || occupant.windowId !== input.holder.windowId)) return { ok: false as const, reason: `路径被其他任务占用: ${path}` };
      if (!occupant) await acquire([target]);
      return { ok: true as const };
    } catch (error) { return { ok: false as const, reason: (error as Error).message }; }
  }
  return {
    claims, commandGuard, checkWrite,
    async commit(paths: string[], message: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("aborted");
      commitsInFlight++;
      try {
        if (!message.trim() || message.includes("\0") || paths.length === 0 || paths.some((path) => !path || path.includes("\0"))) throw new Error("提交必须指定信息和文件路径");
        const hooks = (await readGit(["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).toString().trim();
        for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
          try {
            if ((await stat(join(hooks, name))).mode & 0o111) throw new Error(`受管提交不能安全执行 ${name} hook，提交未执行`);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const config = (await readGit(["config", "--null", "--list"])).toString().split("\0");
        if (config.some((entry) => /^filter\..*\.(clean|process)\n[^\0]+/.test(entry))) throw new Error("受管提交不能安全执行外部 filter，提交未执行");
        for (const path of paths) {
          const checked = await checkWrite(path);
          if (!checked.ok) throw new Error(checked.reason);
        }
        const scoped = await scopedCommitPaths({ repoRoot: input.cwd, writePaths: paths.map((path) => relative(input.cwd, resolve(input.cwd, path))), entries: await readChanges() });
        if (scoped.blocked.length) throw new Error(scoped.blocked.map((item) => item.reason).join("；"));
        if (!scoped.paths.length) throw new Error("指定路径没有可提交改动");
        for (const path of scoped.paths) {
          const checked = await checkWrite(path);
          if (!checked.ok) throw new Error(checked.reason);
        }
        const git = await executable();
        const host = { kind: input.holder.kind, id: input.holder.runId ?? input.holder.windowId!, runId: input.holder.runId };
        const tracked = new Set((await readGit(["ls-files", "-z"])).toString().split("\0"));
        const stagePaths: string[] = [];
        for (const path of scoped.paths) {
          try { await lstat(join(input.cwd, path)); stagePaths.push(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (tracked.has(path)) stagePaths.push(path); }
        }
        let output = "";
        for (const args of [...(stagePaths.length ? [["add", "--", ...stagePaths]] : []), ["commit", "--only", "-m", message, "--", ...scoped.paths]]) {
          const operations = createManagedBashOperations({ registry: input.shells, host, runToken: uuidv7(), guard: {
            ...commandGuard,
            async after(token, outcome) {
              const violations = await commandGuard.after(token, outcome);
              if (violations.length) throw new Error(`提交现场核对失败: ${violations.join("、")}`);
              return violations;
            },
            async launch() {
              const limits = await boundary();
              limits.writeRoots.push(gitDir, ...["objects", "refs", "logs"].map((part) => join(identity.commonDir, part)));
              return sandboxLaunch("", limits, { path: git, args: ["--literal-pathspecs", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args] });
            },
          } });
          const result = await operations.exec("git " + args[0], input.cwd, { signal, timeout: 30, onData: (chunk) => { output += chunk.toString(); } });
          if (result.exitCode !== 0) throw new Error(`受管提交失败（外部 hook/filter/签名程序不在执行权限内）：${output}`);
        }
        return output;
      } finally { commitsInFlight--; }
    },
    fingerprint: (paths: string[]) => fingerprint(input.cwd, paths),
    verifyFingerprint: (snapshot: Record<string, string>) => verifyFingerprint(input.cwd, snapshot),
    async release() {
      if (commitsInFlight > 0) return;
      const active = input.shells.list().some((task) => (input.holder.runId ? task.host.runId === input.holder.runId : task.host.id === input.holder.windowId) && ["starting", "running", "stopping", "uncertain"].includes(task.status));
      if (active) return;
      for (const scratch of scratchPaths) await rm(scratch, { recursive: true, force: true });
      scratchPaths.clear();
      for (const id of new Set(owned.values())) {
        if (input.holder.kind === "main") { await claims.release(id, input.holder); for (const [path, claimId] of owned) if (claimId === id) owned.delete(path); }
        else if ((await claims.releaseIfHolderGone(id)).released) for (const [path, claimId] of owned) if (claimId === id) owned.delete(path);
      }
    },
  };
}
