import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectBaselineCapture, ProjectBaselineInvalidation, ProjectBaselineProvider, ProjectBaselineSnapshot } from "../../runtime/project-baseline.ts";

export const baselineHash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 测试专用：按显式选项枚举顶层或递归输入；docs/prod 从入口排除，不读取正文。 */
export class BaselineFixture implements ProjectBaselineProvider {
  readonly listeners = new Set<(event: ProjectBaselineInvalidation) => void>();
  readonly signals: AbortSignal[] = [];
  generation = 1;
  sequence = 0;
  authority = "connection-1";
  branch = "refs/heads/test";
  unmanaged = false;
  captureFailure = false;
  assertFailure = false;
  captures = 0;
  assertions = 0;
  captureHook?: (signal?: AbortSignal) => Promise<ProjectBaselineCapture>;
  assertHook?: () => Promise<void>;
  private recursive = false;
  private constructor(readonly root: string) {}

  static async create(recursive = false) {
    const root = await mkdtemp("/tmp/m3-baseline-fixture-");
    await chmod(root, 0o700);
    const fixture = new BaselineFixture(root);
    fixture.recursive = recursive;
    await fixture.write("a.ts", "A");
    await fixture.write("b.ts", "B");
    return fixture;
  }

  async write(path: string, content: string) { await writeFile(join(this.root, path), content, { mode: 0o600 }); }
  async remove(path: string) { await rm(join(this.root, path)); }
  async snapshot(): Promise<ProjectBaselineSnapshot> {
    const files: Array<{ path: string; hash: string }> = [];
    const visit = async (directory: string) => {
      for (const entry of (await readdir(join(this.root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (path.toLowerCase() === "docs/prod") continue;
        if (entry.isFile()) files.push({ path, hash: baselineHash(await readFile(join(this.root, path))) });
        else if (entry.isDirectory() && this.recursive) await visit(path);
      }
    };
    await visit("");
    return { repoId: "repo", workspaceId: "workspace", root: this.root, branch: this.branch,
      generation: this.generation, baselineHash: baselineHash(JSON.stringify(files)), observedSequence: this.sequence,
      authorityEpoch: this.authority,
      coverage: { kind: "allowed-inputs", complete: true, roots: ["."], excludedPaths: ["docs/prod"], policyHash: baselineHash(this.recursive ? "recursive-test-policy" : "top-level-test-policy") }, files };
  }

  async captureFresh(signal?: AbortSignal): Promise<ProjectBaselineCapture> {
    this.captures++;
    if (signal) this.signals.push(signal);
    if (this.captureHook) return this.captureHook(signal);
    if (this.captureFailure) throw new Error("private failure");
    if (this.unmanaged) return { kind: "unmanaged", reason: "never_attached" };
    return { kind: "fresh", snapshot: await this.snapshot() };
  }

  async assertCurrent(snapshot: ProjectBaselineSnapshot, _signal?: AbortSignal): Promise<void> {
    this.assertions++;
    await this.assertHook?.();
    if (this.assertFailure || this.unmanaged) throw new Error("unavailable");
    if (JSON.stringify(snapshot) !== JSON.stringify(await this.snapshot())) throw new Error("stale");
  }

  subscribeInvalidation(listener: (event: ProjectBaselineInvalidation) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(reason = "changed") {
    this.sequence++;
    for (const listener of this.listeners) listener({ reason, observedSequence: this.sequence });
  }
  async close() { await rm(this.root, { recursive: true, force: true }); }
}
