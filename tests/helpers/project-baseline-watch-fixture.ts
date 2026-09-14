import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProjectBaselineCapture, ProjectBaselineInvalidation, ProjectBaselineProvider,
  ProjectBaselineSnapshot,
} from "../../runtime/project-baseline.ts";
import { BaselineFixture } from "./project-baseline-fixture.ts";

/** 真实 fs.watch + 临时字节；每条通知递增一次 HOST 消费序号，查询本身不递增。 */
export class BaselineWatchFixture implements ProjectBaselineProvider {
  readonly base: BaselineFixture;
  readonly events: ProjectBaselineInvalidation[] = [];
  readonly listeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  readonly watcher: FSWatcher;
  private lastEventTime = 0;
  private previousHash = "";
  closed = false;
  freshnessChecks = 0;
  reconcileHashOverride?: string;

  private constructor(base: BaselineFixture) {
    this.base = base;
    this.watcher = watch(base.root, { recursive: true }, (eventType, filename) => {
      if (this.closed) return;
      this.lastEventTime = Date.now();
      this.base.sequence++;
      this.emit({ ...this.identity(), reason: "watch", source: "watch", observedSequence: this.base.sequence,
        path: filename?.toString() ?? null, eventType, archiveMetadataOnly: false, requiresFullReconcile: false, baselineHash: null });
    });
    this.watcher.on("error", () => this.inject("watcher_failure"));
  }

  static async create() {
    const fixture = new BaselineWatchFixture(await BaselineFixture.create(true));
    try {
      // 递归监听的启动没有 ready 事件；仅在 gate 订阅前用变更字节与真实回调握手。
      // 探测有界且恢复初始字节；订阅后不重试写入、不屏蔽任何通知。
      for (const [path, content] of [["a.ts", "A"], ["b.ts", "B"]]) {
        const before = fixture.events.length;
        const deadline = Date.now() + 2000;
        let probe = 0;
        while (!fixture.events.slice(before).some((event) => event.reason === "watch" && event.path === path)) {
          if (Date.now() > deadline) throw new Error(`watch fixture startup not observed: ${path}`);
          await fixture.base.write(path, `${content}-watch-ready-${probe++}`);
          await delay(25);
        }
        await fixture.writeObserved(path, content);
      }
      return fixture;
    } catch (error) { await fixture.close(); throw error; }
  }
  get root() { return this.base.root; }
  private identity() { return { repoId: "repo", workspaceId: "workspace", authorityEpoch: this.base.authority }; }
  emit(event: ProjectBaselineInvalidation) {
    if (this.events.length >= 512) throw new Error("watch fixture event limit");
    this.events.push(Object.freeze({ ...event }));
    for (const listener of this.listeners) listener(event);
  }
  inject(reason: string, overrides: Partial<ProjectBaselineInvalidation> = {}) {
    this.base.sequence++;
    this.emit({ ...this.identity(), reason, source: reason, observedSequence: this.base.sequence,
      path: null, eventType: null, archiveMetadataOnly: false, requiresFullReconcile: true, baselineHash: null, ...overrides });
  }
  async quiet() {
    const deadline = Date.now() + 2000;
    // 限定测试环境的回调收尾等待，不声称静默时间能证明任意外部文件系统从未变化。
    do {
      const sequence = this.base.sequence;
      await delay(25);
      if (sequence === this.base.sequence && Date.now() - this.lastEventTime >= 25) return;
    } while (Date.now() < deadline);
    throw new Error("watch fixture did not settle");
  }
  async writeObserved(path: string, content: string) {
    const before = this.events.length;
    await this.base.write(path, content);
    const deadline = Date.now() + 2000;
    while (!this.events.slice(before).some((event) => event.reason === "watch" && event.path === path)) {
      if (Date.now() > deadline) throw new Error(`missing real watch event: ${path}`);
      await delay(5);
    }
    await this.quiet();
  }
  async reconcile(source: "watch" | "read_before", signal?: AbortSignal): Promise<ProjectBaselineSnapshot> {
    signal?.throwIfAborted();
    this.freshnessChecks++;
    await this.quiet();
    signal?.throwIfAborted();
    const current = await this.base.snapshot();
    if (this.previousHash && this.previousHash !== current.baselineHash) {
      this.base.sequence++;
      this.base.generation++;
      this.emit({ ...this.identity(), reason: "reconciled_change", source,
        observedSequence: this.base.sequence, path: null, eventType: null,
        archiveMetadataOnly: false, requiresFullReconcile: true,
        baselineHash: this.reconcileHashOverride ?? current.baselineHash });
    }
    this.previousHash = current.baselineHash;
    return this.base.snapshot();
  }
  async captureFresh(signal?: AbortSignal): Promise<ProjectBaselineCapture> {
    return { kind: "fresh", snapshot: await this.reconcile("read_before", signal) };
  }
  async assertCurrent(snapshot: ProjectBaselineSnapshot, signal?: AbortSignal) {
    await this.reconcile("read_before", signal);
    signal?.throwIfAborted();
    await this.base.assertCurrent(snapshot, signal);
  }
  subscribeInvalidation(listener: (event: ProjectBaselineInvalidation) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const closed = new Promise<void>((resolve) => this.watcher.once("close", resolve));
    this.watcher.close();
    await closed;
    this.listeners.clear();
    await this.base.close();
  }
}
