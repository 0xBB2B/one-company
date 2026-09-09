import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Clock } from "./clock.ts";
import { fileFingerprint, withDirLock, writeFileAtomic } from "./store.ts";

const DIR_MODE = 0o700;
const WAIT_POLL_MS = 75;
const MAX_RELEASED = 200;
const PROBE_TOTAL_BUDGET_MS = 2_000;
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "stopped", "interrupted"]);

export interface Holder {
  kind: "main" | "role" | "requirement";
  windowId?: string;
  runId?: string;
  requirement?: string;
}

export interface ClaimRecord {
  claimId: string;
  holder: Holder;
  paths: string[];
  claimedAt: string;
  fingerprints: Record<string, string>;
}

export interface WaitingRecord {
  waitId: string;
  holder: Holder;
  paths: string[];
  since: string;
}

export interface ReleasedRecord {
  claimId: string;
  holder: Holder;
  paths: string[];
  fingerprints: Record<string, string>;
  evidence?: string;
  decisionId?: string;
  releasedAt: string;
}

interface ClaimsDoc {
  version: number;
  claims: ClaimRecord[];
  waiting: WaitingRecord[];
  released: ReleasedRecord[];
}

export interface ConflictEntry {
  path: string;
  claimId: string;
  holder: Holder;
}

export type ClaimResult =
  | { granted: true; claimId: string }
  | { granted: false; conflicts: ConflictEntry[]; reason: string };

export type ReleaseIfHolderGoneResult = { released: true; evidence: string } | { released: false; reason: string };

export type ReleaseByUserResult = { released: true; claimId: string; decisionId: string };

export interface WaitOptions {
  signal?: AbortSignal;
  holder: Holder;
}

export interface WaitOutcome {
  reason: string;
}

export interface HolderGoneProbeResult {
  gone: boolean;
  evidence?: string;
  reason?: string;
}

export interface RangeClaimsOptions {
  repoDir: string;
  repoRoot: string;
  clock: Clock;
  runState: (runId: string) => Promise<string | null>;
  holderGone: (windowId: string) => Promise<HolderGoneProbeResult>;
  activeShellTasks: (runId: string) => Promise<number>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// 仅按路径别名规整（点段、重复斜杠、目录尾斜杠），不涉及仓库边界；仓库边界判定见 resolveRepoRelative。
export function overlaps(aRaw: string, bRaw: string): boolean {
  const a = posix.normalize(aRaw);
  const b = posix.normalize(bRaw);
  const aBase = a.endsWith("/") ? a.slice(0, -1) : a;
  const bBase = b.endsWith("/") ? b.slice(0, -1) : b;
  if (aBase === bBase) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}

export function resolveRepoRelative(repoRoot: string, rawPath: string): string {
  const isDir = rawPath.endsWith("/");
  const absoluteRoot = resolve(repoRoot);
  const absoluteTarget = isAbsolute(rawPath) ? resolve(rawPath) : resolve(absoluteRoot, rawPath);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径逃逸仓库根: ${rawPath}`);
  }
  const posixRel = rel.split(sep).join("/");
  return isDir ? `${posixRel}/` : posixRel;
}

function hashContentString(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashPathForFingerprint(fullPath: string): Promise<string> {
  let entryStat;
  try {
    entryStat = await lstat(fullPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    throw error;
  }
  if (entryStat.isSymbolicLink()) {
    return hashContentString(await readlink(fullPath));
  }
  if (entryStat.isFile()) {
    return fileFingerprint(fullPath);
  }
  if (entryStat.isDirectory()) return "nonfile:directory";
  if (entryStat.isFIFO()) return "nonfile:fifo";
  if (entryStat.isSocket()) return "nonfile:socket";
  return "nonfile:other";
}

async function walkDirectoryFingerprint(absDir: string, repoRoot: string, result: Record<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(absDir, entry.name);
    const relPath = relative(repoRoot, fullPath).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      result[relPath] = await hashPathForFingerprint(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      await walkDirectoryFingerprint(fullPath, repoRoot, result);
      continue;
    }
    if (entry.isFile()) {
      result[relPath] = await hashPathForFingerprint(fullPath);
    }
  }
}

function directoryManifestHash(canonicalDirPath: string, entries: Record<string, string>): string {
  const manifestLines = Object.keys(entries)
    .filter((path) => path.startsWith(canonicalDirPath))
    .sort()
    .map((path) => `${path}:${entries[path]}`);
  return hashContentString(manifestLines.join("\n"));
}

export async function fingerprint(repoRoot: string, rawPaths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const rawPath of rawPaths) {
    const canonical = resolveRepoRelative(repoRoot, rawPath);
    if (canonical.endsWith("/")) {
      const localEntries: Record<string, string> = {};
      await walkDirectoryFingerprint(join(repoRoot, canonical), repoRoot, localEntries);
      Object.assign(result, localEntries);
      result[canonical] = directoryManifestHash(canonical, localEntries);
    } else {
      result[canonical] = await hashPathForFingerprint(join(repoRoot, canonical));
    }
  }
  return result;
}

export interface FingerprintDiff {
  path: string;
  expected: string;
  actual: string;
}

export async function verifyFingerprint(repoRoot: string, fp: Record<string, string>): Promise<FingerprintDiff[]> {
  const diffs: FingerprintDiff[] = [];
  const canonicalFp: Record<string, string> = {};
  for (const [rawKey, expected] of Object.entries(fp)) {
    canonicalFp[resolveRepoRelative(repoRoot, rawKey)] = expected;
  }
  const dirPrefixes = Object.keys(canonicalFp).filter((path) => path.endsWith("/"));

  for (const [canonical, expected] of Object.entries(canonicalFp)) {
    if (canonical.endsWith("/")) continue;
    if (dirPrefixes.some((prefix) => canonical.startsWith(prefix))) continue;
    const actual = await hashPathForFingerprint(join(repoRoot, canonical));
    if (actual !== expected) diffs.push({ path: canonical, expected, actual });
  }

  for (const [canonical, expected] of Object.entries(canonicalFp)) {
    if (!canonical.endsWith("/")) continue;
    const freshEntries: Record<string, string> = {};
    await walkDirectoryFingerprint(join(repoRoot, canonical), repoRoot, freshEntries);
    const actual = directoryManifestHash(canonical, freshEntries);
    if (actual === expected) continue;
    diffs.push({ path: canonical, expected, actual });
    const oldKeys = new Set(
      Object.keys(canonicalFp).filter((path) => !path.endsWith("/") && path.startsWith(canonical)),
    );
    const newKeys = new Set(Object.keys(freshEntries));
    for (const path of newKeys) {
      if (!oldKeys.has(path)) {
        diffs.push({ path, expected: "absent", actual: freshEntries[path] });
      } else if (canonicalFp[path] !== freshEntries[path]) {
        diffs.push({ path, expected: canonicalFp[path], actual: freshEntries[path] });
      }
    }
    for (const path of oldKeys) {
      if (!newKeys.has(path)) diffs.push({ path, expected: canonicalFp[path], actual: "absent" });
    }
  }

  const seen = new Set<string>();
  return diffs.filter((diff) => {
    const key = `${diff.path}\0${diff.expected}\0${diff.actual}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findConflicts(existing: ClaimRecord[], paths: string[]): ConflictEntry[] {
  const conflicts: ConflictEntry[] = [];
  for (const path of paths) {
    for (const record of existing) {
      if (record.paths.some((existingPath) => overlaps(existingPath, path))) {
        conflicts.push({ path, claimId: record.claimId, holder: record.holder });
      }
    }
  }
  return conflicts;
}

function holderKey(holder: Holder): string {
  return `${holder.kind}|${holder.runId ?? ""}|${holder.windowId ?? ""}|${holder.requirement ?? ""}`;
}

function holdersEqual(a: Holder, b: Holder): boolean {
  return holderKey(a) === holderKey(b);
}

function pathsKey(paths: string[]): string {
  return JSON.stringify([...paths].sort());
}

function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = Math.max(0, deadlineAt - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("探针超时")), remaining);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class RangeClaims {
  private readonly repoRoot: string;
  private readonly rangesDir: string;
  private readonly claimsPath: string;
  private readonly clock: Clock;
  private readonly runStateFn: (runId: string) => Promise<string | null>;
  private readonly holderGoneFn: (windowId: string) => Promise<HolderGoneProbeResult>;
  private readonly activeShellTasksFn: (runId: string) => Promise<number>;

  constructor(options: RangeClaimsOptions) {
    this.repoRoot = options.repoRoot;
    this.rangesDir = join(options.repoDir, "ranges");
    this.claimsPath = join(this.rangesDir, "claims.json");
    this.clock = options.clock;
    this.runStateFn = options.runState;
    this.holderGoneFn = options.holderGone;
    this.activeShellTasksFn = options.activeShellTasks;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private async ensureRangesDir(): Promise<void> {
    await mkdir(this.rangesDir, { recursive: true, mode: DIR_MODE });
  }

  private async readDoc(): Promise<ClaimsDoc> {
    try {
      const raw = await readFile(this.claimsPath, "utf8");
      return JSON.parse(raw) as ClaimsDoc;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { version: 0, claims: [], waiting: [], released: [] };
      throw error;
    }
  }

  private async writeDoc(doc: ClaimsDoc): Promise<void> {
    const next: ClaimsDoc = { ...doc, version: doc.version + 1 };
    await writeFileAtomic(this.claimsPath, JSON.stringify(next));
  }

  private pushReleased(doc: ClaimsDoc, record: ReleasedRecord): void {
    doc.released.push(record);
    if (doc.released.length > MAX_RELEASED) {
      doc.released.splice(0, doc.released.length - MAX_RELEASED);
    }
  }

  private upsertWaiting(doc: ClaimsDoc, holder: Holder, paths: string[]): void {
    const key = `${holderKey(holder)}::${pathsKey(paths)}`;
    doc.waiting = doc.waiting.filter((w) => `${holderKey(w.holder)}::${pathsKey(w.paths)}` !== key);
    doc.waiting.push({ waitId: randomUUID(), holder, paths, since: this.nowIso() });
  }

  private removeWaitingEntryFromDoc(doc: ClaimsDoc, holder: Holder, paths: string[]): void {
    const key = `${holderKey(holder)}::${pathsKey(paths)}`;
    doc.waiting = doc.waiting.filter((w) => `${holderKey(w.holder)}::${pathsKey(w.paths)}` !== key);
  }

  private async removeWaitingEntry(holder: Holder, paths: string[]): Promise<void> {
    await this.ensureRangesDir();
    await withDirLock(this.rangesDir, async () => {
      const doc = await this.readDoc();
      const before = doc.waiting.length;
      this.removeWaitingEntryFromDoc(doc, holder, paths);
      if (doc.waiting.length === before) return;
      await this.writeDoc(doc);
    });
  }

  async claim(holder: Holder, rawPaths: string[]): Promise<ClaimResult> {
    let canonicalPaths: string[];
    try {
      canonicalPaths = rawPaths.map((p) => resolveRepoRelative(this.repoRoot, p));
    } catch (error) {
      return { granted: false, conflicts: [], reason: (error as Error).message };
    }
    await this.ensureRangesDir();

    const grant = await withDirLock(this.rangesDir, async () => {
      const doc = await this.readDoc();
      const conflicts = findConflicts(doc.claims, canonicalPaths);
      if (conflicts.length > 0) {
        const holders = Array.from(new Set(conflicts.map((c) => JSON.stringify(c.holder))));
        const reason = `范围冲突: ${conflicts.map((c) => c.path).join(", ")}（持有者 ${holders.join(", ")}）`;
        this.upsertWaiting(doc, holder, canonicalPaths);
        await this.writeDoc(doc);
        return { granted: false as const, conflicts, reason };
      }
      const claimId = randomUUID();
      doc.claims.push({ claimId, holder, paths: canonicalPaths, claimedAt: this.nowIso(), fingerprints: {} });
      this.removeWaitingEntryFromDoc(doc, holder, canonicalPaths);
      await this.writeDoc(doc);
      return { granted: true as const, claimId };
    });
    if (!grant.granted) return grant;

    try {
      const fp = await fingerprint(this.repoRoot, canonicalPaths);
      const writeback = await withDirLock(this.rangesDir, async () => {
        const doc = await this.readDoc();
        const record = doc.claims.find((c) => c.claimId === grant.claimId);
        if (!record) return { ok: false as const };
        record.fingerprints = fp;
        await this.writeDoc(doc);
        return { ok: true as const };
      });
      if (!writeback.ok) {
        return { granted: false, conflicts: [], reason: "占位在补写指纹前已被释放" };
      }
      return { granted: true, claimId: grant.claimId };
    } catch (error) {
      await this.compensateFailedPlaceholder(grant.claimId);
      throw new Error(`claim 补写指纹失败，占位已回滚: ${grant.claimId}`, { cause: error });
    }
  }

  private async compensateFailedPlaceholder(claimId: string): Promise<void> {
    try {
      await withDirLock(this.rangesDir, async () => {
        const doc = await this.readDoc();
        const index = doc.claims.findIndex((c) => c.claimId === claimId);
        if (index === -1) return;
        doc.claims.splice(index, 1);
        await this.writeDoc(doc);
      });
    } catch {
      // 补偿失败不掩盖上层已抛出的补写错误；占位留给后续 releaseIfHolderGone/releaseByUser 兜底清理
    }
  }

  async release(claimId: string, holder: Holder): Promise<void> {
    if (!holder) throw new Error("释放需要提供 holder 以核对身份");
    await this.ensureRangesDir();
    await withDirLock(this.rangesDir, async () => {
      const doc = await this.readDoc();
      const index = doc.claims.findIndex((c) => c.claimId === claimId);
      if (index === -1) {
        if (doc.released.some((r) => r.claimId === claimId)) return;
        throw new Error(`未知的 claimId: ${claimId}`);
      }
      const record = doc.claims[index];
      if (!holdersEqual(record.holder, holder)) {
        throw new Error(`持有者不一致，拒绝释放: ${claimId}`);
      }
      doc.claims.splice(index, 1);
      const deliveryFingerprints = await fingerprint(this.repoRoot, record.paths);
      this.pushReleased(doc, {
        claimId: record.claimId,
        holder: record.holder,
        paths: record.paths,
        fingerprints: deliveryFingerprints,
        releasedAt: this.nowIso(),
      });
      await this.writeDoc(doc);
    });
  }

  async wait(rawPaths: string[], options: WaitOptions): Promise<WaitOutcome> {
    if (!options.holder) throw new Error("等待需要提供 holder 以核对身份");
    const canonicalPaths = rawPaths.map((p) => resolveRepoRelative(this.repoRoot, p));
    const { signal, holder } = options;
    try {
      while (true) {
        if (signal?.aborted) throw new Error("等待已取消");
        const doc = await this.readDoc();
        if (findConflicts(doc.claims, canonicalPaths).length === 0) {
          return { reason: "无冲突，可申请" };
        }
        await this.sleep(WAIT_POLL_MS, signal);
      }
    } finally {
      try {
        await this.removeWaitingEntry(holder, canonicalPaths);
      } catch {
        // 清理失败不得掩盖 try 块里的原始结果（取消错误或正常返回）
      }
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.clock.clearTimer(timer);
        reject(new Error("等待已取消"));
      };
      const timer = this.clock.setTimeoutExcludingSleep(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async holderOf(rawPath: string): Promise<Holder | null> {
    const canonical = resolveRepoRelative(this.repoRoot, rawPath);
    const doc = await this.readDoc();
    const record = doc.claims.find((c) => c.paths.some((p) => overlaps(p, canonical)));
    return record ? record.holder : null;
  }

  private async evaluateHolderGone(holder: Holder): Promise<{ gone: true; evidence: string } | { gone: false; reason: string }> {
    const deadlineAt = Date.now() + PROBE_TOTAL_BUDGET_MS;
    if (holder.kind === "main") {
      if (!holder.windowId) return { gone: false, reason: "holder 缺少 windowId，无法判定" };
      let result: HolderGoneProbeResult;
      try {
        result = await withDeadline(this.holderGoneFn(holder.windowId), deadlineAt);
      } catch (error) {
        return { gone: false, reason: `证据不可判定: ${(error as Error).message}` };
      }
      if (result.gone) return { gone: true, evidence: result.evidence ?? "holder-gone" };
      return { gone: false, reason: result.reason ?? "holder 未失联" };
    }
    if (!holder.runId) return { gone: false, reason: "holder 缺少 runId，无法判定" };
    let state: string | null;
    try {
      state = await withDeadline(this.runStateFn(holder.runId), deadlineAt);
    } catch (error) {
      return { gone: false, reason: `证据不可判定: ${(error as Error).message}` };
    }
    if (state === null || !TERMINAL_RUN_STATES.has(state)) {
      return { gone: false, reason: `运行状态非终态: ${state ?? "未知"}` };
    }
    let activeTasks: number;
    try {
      activeTasks = await withDeadline(this.activeShellTasksFn(holder.runId), deadlineAt);
    } catch (error) {
      return { gone: false, reason: `证据不可判定: ${(error as Error).message}` };
    }
    if (activeTasks > 0) {
      return { gone: false, reason: `仍有 ${activeTasks} 个活动/不确定任务` };
    }
    return { gone: true, evidence: `run-terminal:${state}` };
  }

  async releaseIfHolderGone(claimId: string): Promise<ReleaseIfHolderGoneResult> {
    await this.ensureRangesDir();
    return withDirLock(this.rangesDir, async () => {
      const doc = await this.readDoc();
      const index = doc.claims.findIndex((c) => c.claimId === claimId);
      if (index === -1) throw new Error(`未知的 claimId: ${claimId}`);
      const record = doc.claims[index];
      const evidenceResult = await this.evaluateHolderGone(record.holder);
      if (!evidenceResult.gone) return { released: false, reason: evidenceResult.reason };
      doc.claims.splice(index, 1);
      const deliveryFingerprints = await fingerprint(this.repoRoot, record.paths);
      this.pushReleased(doc, {
        claimId: record.claimId,
        holder: record.holder,
        paths: record.paths,
        fingerprints: deliveryFingerprints,
        evidence: evidenceResult.evidence,
        releasedAt: this.nowIso(),
      });
      await this.writeDoc(doc);
      return { released: true, evidence: evidenceResult.evidence };
    });
  }

  async releaseByUser(claimId: string, input: { decisionId: string }): Promise<ReleaseByUserResult> {
    if (!input.decisionId) throw new Error("释放需要决定编号");
    await this.ensureRangesDir();
    return withDirLock(this.rangesDir, async () => {
      const doc = await this.readDoc();
      const index = doc.claims.findIndex((c) => c.claimId === claimId);
      if (index === -1) throw new Error(`未知的 claimId: ${claimId}`);
      const record = doc.claims[index];
      doc.claims.splice(index, 1);
      const deliveryFingerprints = await fingerprint(this.repoRoot, record.paths);
      this.pushReleased(doc, {
        claimId: record.claimId,
        holder: record.holder,
        paths: record.paths,
        fingerprints: deliveryFingerprints,
        decisionId: input.decisionId,
        releasedAt: this.nowIso(),
      });
      await this.writeDoc(doc);
      return { released: true, claimId: record.claimId, decisionId: input.decisionId };
    });
  }
}
