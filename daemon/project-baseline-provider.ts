import type { ProjectIndexCoordinator } from "./project-index-coordinator.ts";
import { ProjectBaselineError } from "../runtime/project-baseline.ts";
import type { ProjectBaselineInvalidation, ProjectBaselineProvider, ProjectBaselineSnapshot } from "../runtime/project-baseline.ts";

export interface DaemonProjectBaselineProvider extends ProjectBaselineProvider {
  checkPath(absolutePath: string): Promise<string>;
  dispose(): void;
}

/** 复用同daemon协调器的授权、队列和watch；本适配器不签发扫描许可。 */
export async function createDaemonProjectBaselineProvider(coordinator: ProjectIndexCoordinator, cwd: string): Promise<DaemonProjectBaselineProvider> {
  const scope = await coordinator.baselineScope(cwd);
  let closed = false, managed = false, uncertain = false;
  const listeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  const unsubscribe = coordinator.subscribeBaseline(scope, (event) => {
    for (const listener of listeners) listener(event);
  });
  const live = () => { if (closed) throw new ProjectBaselineError("unavailable"); };
  const provider: DaemonProjectBaselineProvider = {
    async captureFresh(signal) {
      live();
      try {
        const result = await coordinator.captureBaseline(scope, signal);
        live();
        if (result.kind === "fresh") managed = true;
        else if (managed || uncertain) throw new ProjectBaselineError("unavailable");
        return result;
      } catch (error) {
        if (!signal?.aborted) uncertain = true;
        throw error;
      }
    },
    async assertUnmanaged(signal) {
      live();
      if (managed || uncertain) throw new ProjectBaselineError("unavailable");
      try {
        await coordinator.assertUnmanagedBaseline(scope, signal);
        live();
      } catch (error) {
        if (!signal?.aborted) uncertain = true;
        throw error;
      }
    },
    async assertCurrent(snapshot: ProjectBaselineSnapshot, signal) {
      const result = await provider.captureFresh(signal);
      if (result.kind !== "fresh") throw new ProjectBaselineError("stale");
      const current = result.snapshot;
      if (current.repoId !== snapshot.repoId || current.workspaceId !== snapshot.workspaceId || current.root !== snapshot.root
        || current.branch !== snapshot.branch || current.authorityEpoch !== snapshot.authorityEpoch
        || current.observedSequence !== snapshot.observedSequence || current.baselineHash !== snapshot.baselineHash
        || current.generation < snapshot.generation || JSON.stringify(current.coverage) !== JSON.stringify(snapshot.coverage)
        || JSON.stringify([...current.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          !== JSON.stringify([...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) throw new ProjectBaselineError("stale");
    },
    subscribeInvalidation(listener) { live(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    async checkPath(absolutePath) { live(); return coordinator.checkBaselinePath(scope, absolutePath); },
    dispose() { if (closed) return; closed = true; unsubscribe(); listeners.clear(); },
  };
  return provider;
}
