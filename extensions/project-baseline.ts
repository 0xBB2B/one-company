import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot, repositoryIdentity } from "../runtime/identity.ts";
import { classifyIndexWatchEvent, scanIndexWorkspace } from "../runtime/project-index-policy.ts";
import type { ProjectBaselineProvider, ProjectBaselineSnapshot, ProjectBaselineInvalidation } from "../runtime/project-baseline.ts";
import { ProjectBaselineError } from "../runtime/project-baseline.ts";
import { installProjectBaselineHooks } from "../runtime/project-baseline-hooks.ts";
import type { ProjectSyncBinding, ProjectSyncController, ProjectSyncFreshBaseline } from "../runtime/project-sync-client.ts";
import { activeProjectSyncController, captureProjectFreshBaseline, subscribeProjectSyncControllers } from "./project-manage.ts";
import { windowReady } from "./lifecycle.ts";

const unavailable = () => new ProjectBaselineError("unavailable");
/** 策略指纹来自安装产物中的实际策略源码，不采用模型自报 policyHash。 */
const policyHash = () => createHash("sha256").update(readFileSync(new URL("../runtime/project-index-policy.ts", import.meta.url))).digest("hex");

export interface HostProjectBaselineProvider extends ProjectBaselineProvider {
  assertUnmanaged(signal?: AbortSignal): Promise<void>;
  checkPath(path: string): Promise<string>;
  dispose(): void;
}

/** 只消费可信 HOST 绑定；未初始化不枚举文件，已管理后缺失/断线不能降回 legacy。 */
export function createHostProjectBaselineProvider(input: { binding: ProjectSyncBinding; dataRoot: string }): HostProjectBaselineProvider {
  let closed = false;
  let everManaged = false;
  let controller: ProjectSyncController | undefined;
  let unsubscribe: (() => void) | undefined;
  let latest: ProjectSyncFreshBaseline | undefined;
  const snapshots = new Map<string, ProjectSyncFreshBaseline>();
  const listeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  const key = (snapshot: ProjectBaselineSnapshot) => JSON.stringify([snapshot.authorityEpoch, snapshot.generation,
    snapshot.baselineHash, snapshot.observedSequence]);
  const emit = (event: ProjectBaselineInvalidation) => { for (const listener of listeners) listener(event); };
  const attach = (next: ProjectSyncController) => {
    if (closed || next.binding.repoId !== input.binding.repoId || next.binding.windowId !== input.binding.windowId
      || next.binding.sessionId !== input.binding.sessionId || next === controller) return;
    unsubscribe?.();
    controller = next; everManaged = true; latest = undefined; snapshots.clear();
    emit({ reason: "controller_replaced" });
    unsubscribe = next.subscribeInvalidation((event) => {
      emit({ reason: event.sourceReason ?? event.reason, observedSequence: event.observationSequence,
        source: event.source ?? undefined, path: event.path, eventType: event.eventType,
        requiresFullReconcile: event.requiresFullReconcile, archiveMetadataOnly: event.archiveMetadataOnly,
        baselineHash: event.baselineHash, repoId: event.repoId, workspaceId: event.workspaceId,
        authorityEpoch: latest?.authorityEpoch });
    });
  };
  const stopControllers = subscribeProjectSyncControllers(attach);
  const initial = activeProjectSyncController(input.binding);
  if (initial) attach(initial);
  const current = (waitForCapture = false) => {
    if (closed) throw unavailable();
    const next = activeProjectSyncController(input.binding);
    if (next) attach(next);
    if (everManaged && (!next || !waitForCapture && !next.isActive())) throw unavailable();
    return next;
  };
  return {
    async captureFresh(signal) {
      // 新捕获在controller队列内等已获授权的重连完成并核验active；旧快照检查仍即时拒绝。
      const active = current(true);
      const captured = await captureProjectFreshBaseline(input.binding, signal);
      if (captured.kind === "unmanaged") {
        if (everManaged) throw unavailable();
        return captured;
      }
      if (!active || !active.isActive()) throw unavailable();
      const raw = captured.snapshot;
      // HOST 的完整预算证明加上扫描文件集合对账；解析 partial 不能伪装文件 coverage complete。
      // scan 在读取任何正文前执行 prod/私有资料排除，且仅在已有持续扫描授权时运行。
      const scan = await scanIndexWorkspace({ root: raw.root, dataRoot: input.dataRoot, signal });
      if (scan.partial || scan.budget.stoppedReason !== "complete" || scan.budget.exhausted.length
        || scan.files.length !== raw.files.length || scan.files.some((file) => !raw.files.some((entry) => entry.path === file.path))) throw unavailable();
      await active.assertCurrent(raw, signal);
      if (current() !== active) throw unavailable();
      const snapshot: ProjectBaselineSnapshot = Object.freeze({ repoId: raw.repoId, workspaceId: raw.workspaceId,
        root: raw.root, branch: raw.branch, generation: raw.generation, baselineHash: raw.baselineHash,
        observedSequence: raw.observedSequence, authorityEpoch: raw.authorityEpoch,
        coverage: Object.freeze({ kind: "allowed-inputs", complete: true, roots: ["."], excludedPaths: ["docs/prod"], policyHash: policyHash() }),
        files: raw.files });
      latest = raw;
      if (snapshots.size >= 256) snapshots.clear();
      snapshots.set(key(snapshot), raw);
      return { kind: "fresh", snapshot };
    },
    async assertUnmanaged(signal) {
      if (current()) throw unavailable();
      const captured = await captureProjectFreshBaseline(input.binding, signal);
      if (captured.kind !== "unmanaged" || current()) throw unavailable();
    },
    async assertCurrent(snapshot, signal) {
      const active = current();
      const raw = snapshots.get(key(snapshot));
      if (!active || !raw || snapshot.coverage.policyHash !== policyHash()
        || snapshot.root !== raw.root || snapshot.repoId !== raw.repoId || snapshot.workspaceId !== raw.workspaceId
        || snapshot.branch !== raw.branch || JSON.stringify(snapshot.files.map((file) => [file.path, file.hash]).sort())
          !== JSON.stringify(raw.files.map((file) => [file.path, file.hash]).sort())) throw unavailable();
      // 保留 window/session/connection 等 HOST 原始字段，内核的不可变克隆不冒充 HOST snapshot。
      await active.assertCurrent(raw, signal);
    },
    subscribeInvalidation(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async checkPath(path) {
      const active = current();
      if (!active) return path; // legacy 仍由原 mainWriteProtection 执行范围/链接/Git/DB限制。
      if (!latest) throw unavailable();
      const rel = relative(latest.root, resolve(path)).split(sep).join("/");
      if (classifyIndexWatchEvent(rel) !== "index") throw new ProjectBaselineError("invalid_input");
      const scan = await scanIndexWorkspace({ root: latest.root, dataRoot: input.dataRoot });
      if (scan.partial || scan.skipped.some((entry) => rel === entry.path || rel.startsWith(`${entry.path}/`))) throw unavailable();
      return rel;
    },
    dispose() { if (closed) return; closed = true; unsubscribe?.(); stopControllers(); snapshots.clear(); listeners.clear(); latest = undefined; },
  };
}

export default function projectBaselineExtension(pi: ExtensionAPI): void {
  let provider: HostProjectBaselineProvider | undefined;
  let context: ExtensionContext | undefined;
  let stopped = false;
  const listeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  let stopProvider: (() => void) | undefined;
  const resolveProvider = async () => {
    if (stopped || !context) throw unavailable();
    if (provider) return provider;
    const window = await windowReady();
    const identity = await repositoryIdentity(context.cwd);
    const sessionId = context.sessionManager.getSessionId();
    if (window.sessionId !== sessionId || !window.workspace.repos.some((repo) => repo.repoId === identity.repoId)) throw unavailable();
    provider = createHostProjectBaselineProvider({ binding: { windowId: window.windowId, sessionId, repoId: identity.repoId }, dataRoot: dataRoot(process.env) });
    stopProvider = provider.subscribeInvalidation((event) => { for (const listener of listeners) listener(event); });
    return provider;
  };
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  installProjectBaselineHooks(pi, {
    provider: {
      async captureFresh(signal) { return (await resolveProvider()).captureFresh(signal); },
      async assertCurrent(snapshot, signal) { return (await resolveProvider()).assertCurrent(snapshot, signal); },
      async assertUnmanaged(signal) { return (await resolveProvider()).assertUnmanaged(signal); },
      subscribeInvalidation(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    checkPath: async (path, request) => request.kind === "unmanaged" ? path : (await resolveProvider()).checkPath(path),
    disposeProvider() { stopped = true; stopProvider?.(); provider?.dispose(); listeners.clear(); context = undefined; },
  });
}
