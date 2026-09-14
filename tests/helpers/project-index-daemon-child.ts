import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SleepSelection { entry: number; holder: number; sequence: number }
export interface SleepDenial { entry: number; sequence: number; lastAuthorized?: SleepSelection }
export interface SleepCallEvidence { call: number; selections: number; lastAuthorized: SleepSelection[]; denied: SleepDenial[] }
export interface SleepEvidence {
  installed: boolean; module: string | null; started: number; completed: number; failed: number; observerErrors: number;
  events: Array<{ call: number; phase: string; sequence: number; errorCode?: string }>;
  authority: { installed: boolean; revocations: SleepSelection[]; calls: SleepCallEvidence[] };
}

/** 只分类有原始Promise结果及同进程撤权证据的调用；失败计数不改写。 */
export function classifySleep(sleep: SleepEvidence, requiredCalls: readonly number[] = [], settled = false) {
  const fail = (reason: string): never => { throw new Error(`真实sleep失败/无归因：${reason}: ${JSON.stringify(sleep)}`); };
  if (!sleep.installed || sleep.observerErrors) fail("探针缺失或出错");
  const starts = sleep.events.filter((event) => event.phase === "started");
  const completed = sleep.events.filter((event) => event.phase === "completed");
  const failed = sleep.events.filter((event) => event.phase === "failed");
  if (starts.length !== sleep.started || completed.length !== sleep.completed || failed.length !== sleep.failed
    || starts.length + completed.length + failed.length !== sleep.events.length) fail("原始计数/事件不完整");
  const result = { successful: [] as number[], cancelled: [] as number[], pending: [] as number[], required: [...requiredCalls] };
  for (let call = 1; call <= sleep.started; call++) {
    const begin = starts.filter((event) => event.call === call);
    const ends = [...completed, ...failed].filter((event) => event.call === call);
    if (begin.length !== 1 || ends.length > 1 || ends.some((event) => event.sequence <= begin[0].sequence)) fail(`call${call}顺序异常`);
    if (!ends.length) { result.pending.push(call); continue; }
    const end = ends[0];
    if (end.phase === "completed") {
      const evidence = sleep.authority?.calls.find((item) => item.call === call);
      if (requiredCalls.includes(call) && (!sleep.authority?.installed || !evidence?.selections || evidence.denied.length)) fail(`持权必测call${call}缺少持续持权证据`);
      result.successful.push(call); continue;
    }
    if (requiredCalls.includes(call)) fail(`持权必测call${call}被拒绝`);
    const evidence = sleep.authority?.calls.find((item) => item.call === call);
    if (end.errorCode !== "authorization_denied" || !sleep.authority?.installed || !evidence?.denied.length
      || !evidence.denied.every((denial) => {
        const selected = denial.lastAuthorized;
        return selected && selected.entry === denial.entry && selected.sequence > begin[0].sequence
          && denial.sequence < end.sequence && sleep.authority.revocations.some((revoked) =>
            revoked.entry === selected.entry && revoked.holder === selected.holder
            && selected.sequence < revoked.sequence && revoked.sequence < denial.sequence);
      })) fail(`call${call}没有匹配的持权→真实撤权→授权拒绝证据`);
    result.cancelled.push(call);
  }
  if ([...completed, ...failed].some((event) => event.call < 1 || event.call > sleep.started)) fail("未知调用结果");
  if (settled && (result.pending.length || requiredCalls.some((call) => !result.successful.includes(call)))) fail("必测调用未成功或仍有在途调用");
  return result;
}

/** 测试专用Node预加载探针：正常采样只旁观真实daemon的Promise和授权选择。 */
const reportPath = process.env.M3_ASSEMBLY_PROBE;
const repositoryRoot = process.env.M3_ASSEMBLY_REPOSITORY;
if (reportPath && repositoryRoot) {
  const write = fs.writeFileSync.bind(fs);
  const resources = () => {
    const memory = process.memoryUsage();
    const handles = (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
    const activeResources = process.getActiveResourcesInfo();
    const resourceCounts: Record<string, number> = {};
    for (const name of activeResources) resourceCounts[name] = (resourceCounts[name] ?? 0) + 1;
    return { at: Date.now(), rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
      external: memory.external, arrayBuffers: memory.arrayBuffers, handles: handles.length,
      activeResources: activeResources.length, resourceCounts };
  };
  let sequence = 0;
  const sleepContext = new AsyncLocalStorage<SleepCallEvidence>();
  const activeSleepCalls = new Set<number>();
  const initial = resources();
  const report = { pid: process.pid, node: process.execPath, nodeVersion: process.version,
    watchers: 0, peakWatchers: 0, createdWatchers: 0, closedWatchers: 0, closeCalls: 0, closeEvents: 0,
    watcherErrors: [] as Array<{ code?: string; message: string }>,
    closeErrors: [] as string[], forbiddenReads: 0, exited: false,
    sampleCount: 0, resources: initial, peakResources: { ...initial, resourceCounts: { ...initial.resourceCounts } },
    sleep: { installed: false, module: null as string | null, started: 0, completed: 0, failed: 0, observerErrors: 0,
      events: [] as Array<{ call: number; phase: "started" | "completed" | "failed"; sequence: number; errorCode?: string; resources: ReturnType<typeof resources> }>,
      authority: { installed: false, revocations: [] as SleepSelection[], calls: [] as SleepCallEvidence[] } },
    sleepGate: null as null | { call: number; phase: "held" | "released"; sequence: number } };
  const publish = () => {
    const current = resources();
    report.resources = current;
    report.sampleCount++;
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'handles', 'activeResources'] as const) {
      report.peakResources[key] = Math.max(report.peakResources[key], current[key]);
    }
    for (const [name, count] of Object.entries(current.resourceCounts)) {
      report.peakResources.resourceCounts[name] = Math.max(report.peakResources.resourceCounts[name] ?? 0, count);
    }
    const temporary = `${reportPath}.tmp`;
    write(temporary, JSON.stringify(report), { mode: 0o600 });
    fs.renameSync(temporary, reportPath);
  };
  // 采样计时器不阻止daemon自然退出；峰值为事件/100ms采样观测值，不声称连续精确峰值。
  const sampler = setInterval(publish, 100);
  sampler.unref();
  const check = (input: unknown) => {
    if (typeof input === "number") return;
    const path = input instanceof URL ? fileURLToPath(input) : String(input);
    if (path.includes("/docs/prod/") || path.includes("/requirements/") || path.includes("/sessions/")) {
      report.forbiddenReads++;
      publish();
      throw new Error("M3 assembly probe: forbidden body read");
    }
  };
  for (const [target, names] of [[fs, ["readFile", "readFileSync", "open", "openSync", "createReadStream"]],
    [fsp, ["readFile", "open"]]] as const) {
    const methods = target as unknown as Record<string, unknown>;
    for (const name of names) {
      const original = methods[name] as (...args: unknown[]) => unknown;
      methods[name] = (...args: unknown[]) => { check(args[0]); return Reflect.apply(original, target, args); };
    }
  }
  const watch = fs.watch;
  fs.watch = ((...args: Parameters<typeof fs.watch>) => {
    const watcher = Reflect.apply(watch, fs, args) as fs.FSWatcher;
    const path = resolve(String(args[0]));
    if (path !== repositoryRoot && !path.startsWith(`${repositoryRoot}/`)) return watcher;
    report.watchers++;
    report.createdWatchers++;
    report.peakWatchers = Math.max(report.peakWatchers, report.watchers);
    publish();
    let closed = false;
    const close = watcher.close.bind(watcher);
    const finish = () => {
      if (closed) return;
      closed = true;
      report.watchers--;
      report.closedWatchers++;
      report.closeEvents++;
      publish();
    };
    watcher.close = () => {
      report.closeCalls++;
      try { close(); } catch (error) { report.closeErrors.push(String(error)); throw error; }
      finally { publish(); }
    };
    watcher.once("close", finish);
    watcher.on("error", (error: NodeJS.ErrnoException) => {
      report.watcherErrors.push({ code: error.code, message: error.message });
      publish();
    });
    return watcher;
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  process.once("exit", () => { clearInterval(sampler); report.exited = true; publish(); });
  // 从实际Node入口定位同一产品的模块，安装产物绝不回退到工作区源码模块。
  const entry = process.argv[1] && fs.realpathSync(resolve(process.argv[1]));
  if (entry && basename(entry) === "bootstrap.mjs" && basename(dirname(entry)) === "daemon") {
    const moduleUrl = new URL("./project-index-coordinator.ts", pathToFileURL(entry));
    const { daemonLoader } = await import(new URL("./loader.mjs", pathToFileURL(entry)).href);
    const { ProjectIndexCoordinator } = await daemonLoader.import(moduleUrl.href);
    const prototype = ProjectIndexCoordinator.prototype;
    const original = prototype.onSleepGap;
    // ordinal只标识本进程内的对象，不保存grant token、正文或用户身份。
    const identities = new WeakMap<object, number>();
    let nextIdentity = 0;
    const id = (object: object) => { let value = identities.get(object); if (!value) { value = ++nextIdentity; identities.set(object, value); } return value; };
    if (typeof prototype.selectAuthorized === "function" && typeof prototype.deactivate === "function") {
      const select = prototype.selectAuthorized;
      prototype.selectAuthorized = function (entry: object) {
        const selected = Reflect.apply(select, this, [entry]);
        const context = sleepContext.getStore();
        // 后续timer可能继承async context；原Promise结束后不再归到该sleep调用。
        if (context && activeSleepCalls.has(context.call)) try {
          const entryId = id(entry);
          if (selected) {
            const value = { entry: entryId, holder: id(selected), sequence: ++sequence };
            context.selections++;
            context.lastAuthorized = [...context.lastAuthorized.filter((item) => item.entry !== entryId), value];
          } else {
            context.denied.push({ entry: entryId, sequence: ++sequence,
              lastAuthorized: context.lastAuthorized.find((item) => item.entry === entryId) });
          }
        } catch { report.sleep.observerErrors++; }
        return selected;
      };
      const deactivate = prototype.deactivate;
      prototype.deactivate = function (...args: unknown[]) {
        const removed = Reflect.apply(deactivate, this, args);
        try {
          for (const { entry, attachment } of removed) {
            // 原方法已同步移除attachment；记录发生在后续排队清理之前。
            if (attachment.active !== false || entry.clients.get(attachment.client) === attachment) throw new Error("未观察到实际移除");
            report.sleep.authority.revocations.push({ entry: id(entry), holder: id(attachment), sequence: ++sequence });
          }
          publish();
        } catch { report.sleep.observerErrors++; }
        return removed;
      };
      report.sleep.authority.installed = true;
    }
    // 专用竞争测试只延迟ensureFresh的进入边界，不伪造授权结果；常规资源测试不配置gate。
    const gate = process.env.M3_SLEEP_GATE;
    if (gate) {
      const managerUrl = new URL("../runtime/project-index-sync.ts", moduleUrl);
      const { ProjectIndexSyncManager } = await daemonLoader.import(managerUrl.href);
      const ensureFresh = ProjectIndexSyncManager.prototype.ensureFresh;
      let used = false;
      ProjectIndexSyncManager.prototype.ensureFresh = function (...args: unknown[]) {
        const context = sleepContext.getStore();
        if (!context || !activeSleepCalls.has(context.call) || used || !fs.existsSync(gate)) return Reflect.apply(ensureFresh, this, args);
        used = true;
        report.sleepGate = { call: context.call, phase: "held", sequence: ++sequence }; publish();
        return (async () => {
          const until = Date.now() + 10_000;
          while (!fs.existsSync(`${gate}.release`)) {
            if (Date.now() >= until) throw new Error("sleep gate未释放");
            await new Promise((done) => setTimeout(done, 5));
          }
          report.sleepGate = { call: context.call, phase: "released", sequence: ++sequence }; publish();
          return Reflect.apply(ensureFresh, this, args);
        })();
      };
    }
    const observe = (call: number, phase: "started" | "completed" | "failed", error?: unknown) => {
      try {
        report.sleep[phase]++;
        if (phase === "started") activeSleepCalls.add(call); else activeSleepCalls.delete(call);
        const code = (error as { code?: unknown } | null)?.code;
        const errorCode = ["authorization_denied", "index_not_fresh", "coordinator_closed", "resource_limit", "operation_in_progress"].includes(String(code))
          ? String(code) : "unknown";
        if (report.sleep.events.length >= 512) throw new Error("sleep事件超出探针预算");
        report.sleep.events.push({ call, phase, sequence: ++sequence,
          ...(phase === "failed" ? { errorCode } : {}), resources: resources() });
        publish();
      } catch { report.sleep.observerErrors++; }
    };
    ProjectIndexCoordinator.prototype.onSleepGap = function (this: object, ...args: unknown[]) {
      const call = report.sleep.started + 1;
      observe(call, "started");
      const context: SleepCallEvidence = { call, selections: 0, lastAuthorized: [], denied: [] };
      report.sleep.authority.calls.push(context);
      let result: Promise<unknown>;
      try { result = sleepContext.run(context, () => Reflect.apply(original, this, args)); }
      catch (error) { observe(call, "failed", error); throw error; }
      // 旁观原Promise的真实结果；调用方收到原Promise，未替换、吞掉或制造完成结果。
      void result.then(() => observe(call, "completed"), (error: unknown) => observe(call, "failed", error));
      return result;
    };
    report.sleep.installed = true;
    report.sleep.module = moduleUrl.href;
  }
  publish();
}
