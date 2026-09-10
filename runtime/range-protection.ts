import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandBoundary, sandboxLaunch } from "./command-boundary.ts";
import { lstat, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { repoDataDir, repositoryIdentity } from "./identity.ts";
import { RangeClaims, fingerprint, verifyFingerprint } from "./ranges.ts";
import type { Holder } from "./ranges.ts";
import { RunStore } from "./run-store.ts";
import { currentBootId, processStartedAt, WindowRegistry } from "./windows.ts";
import { resolveRealRepoPath, snapshotForeignRanges, verifyAfterCommand, invalidateValidations } from "./write-guard.ts";
import { activeForeignHosts, snapshotBranchState, verifyBranchState } from "./branch-guard.ts";
import type { Clock } from "./clock.ts";
import type { ShellRegistry } from "./shell-registry.ts";
import type { BashCommandGuard } from "./shell-bash.ts";

export async function createRangeProtection(input: {
  cwd: string; dataRoot: string; holder: Holder; writePaths: string[]; clock: Clock; shells: ShellRegistry;
}) {
  const identity = await repositoryIdentity(input.cwd);
  const gitDir = (await promisify(execFile)("git", ["rev-parse", "--absolute-git-dir"], { cwd: input.cwd })).stdout.trim();
  const repoDir = await repoDataDir(input.dataRoot, identity.repoId, identity.commonDir);
  const windows = new WindowRegistry({ repoDir, clock: input.clock, bootId: currentBootId, processStartedAt });
  const runs = new RunStore({ dataRoot: input.dataRoot, repoId: identity.repoId, daemonStartedAt: "range-check" });
  const claims = new RangeClaims({ repoDir, repoRoot: input.cwd, clock: input.clock,
    runState: async (id) => { const run = await runs.get(id); if (!run.ok) throw new Error(`范围持有者不可读: ${id}`); return run.run.state; },
    holderGone: (id) => windows.holderGone(id),
    activeShellTasks: async (id) => input.shells.list().filter((task) => task.host.runId === id && ["starting", "running", "stopping", "uncertain"].includes(task.status)).length,
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
  const commandGuard: BashCommandGuard = {
    async launch(command) {
      const foreignPaths = (await claims.entries()).filter((claim) => claim.holder.runId !== input.holder.runId || claim.holder.windowId !== input.holder.windowId).flatMap((claim) => claim.paths);
      const boundary = await commandBoundary({ cwd: input.cwd, writePaths: input.writePaths, dataRoot: input.dataRoot, foreignPaths });
      boundary.readRoots.push(identity.commonDir, gitDir);
      if (input.writePaths.length > 0) boundary.writeRoots.push(...["objects", "refs", "logs"].map((part) => `${identity.commonDir}/${part}`), ...["index", "index.lock", "HEAD", "HEAD.lock", "COMMIT_EDITMSG", "logs"].map((part) => `${gitDir}/${part}`));
      scratchPaths.add(boundary.scratch);
      return sandboxLaunch(command, boundary);
    },
    async before() {
      await acquire(input.writePaths);
      return { snapshot: await snapshotForeignRanges({ repoRoot: input.cwd, claims, holder: input.holder }), branch: await snapshotBranchState({ repoRoot: input.cwd }) };
    },
    async after(raw) {
      const token = raw as { snapshot: Record<string, string>; branch: Awaited<ReturnType<typeof snapshotBranchState>> };
      const paths = await verifyAfterCommand({ repoRoot: input.cwd, claims, holder: input.holder, snapshot: token.snapshot });
      const hosts = await activeForeignHosts({ runStore: runs, windows, windowId: input.holder.windowId ?? "daemon", runId: input.holder.runId ?? "" });
      const branch = await verifyBranchState({ repoRoot: input.cwd, before: token.branch, activeHosts: hosts });
      if (branch.violation || branch.undetermined) paths.push("分支现场变化或无法核对");
      await violation(paths);
      return paths;
    },
  };
  return {
    claims, commandGuard,
    async checkWrite(path: string) {
      const lexical = await normalize(path);
      let target: string;
      try { target = resolve(input.cwd, await resolveRealRepoPath(input.cwd, lexical, lexical.endsWith("/"))); }
      catch (error) { return { ok: false as const, reason: (error as Error).message }; }
      if (!input.writePaths.some((scope) => { const boundary = resolve(input.cwd, scope); return resolve(target) === boundary || resolve(target).startsWith(`${boundary}${sep}`); })) return { ok: false as const, reason: `写入路径超出授权范围: ${path}` };
      try {
        await acquire(input.writePaths);
        const occupant = await claims.holderOf(target);
        if (occupant && (occupant.runId !== input.holder.runId || occupant.windowId !== input.holder.windowId)) return { ok: false as const, reason: `路径被其他任务占用: ${path}` };
        if (!occupant) await acquire([target]);
        return { ok: true as const };
      } catch (error) { return { ok: false as const, reason: (error as Error).message }; }
    },
    fingerprint: (paths: string[]) => fingerprint(input.cwd, paths),
    verifyFingerprint: (snapshot: Record<string, string>) => verifyFingerprint(input.cwd, snapshot),
    async release() {
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
