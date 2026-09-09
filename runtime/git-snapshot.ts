import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const UNTRACKED_FILE_SIZE_LIMIT = 64 * 1024 * 1024;

export interface GitSnapshot {
  head: string;
  branch: string | null;
  fingerprint: string;
}

export interface CollectGitSnapshotInput {
  repoRoot: string;
  gitTimeoutMs?: number;
  gitMaxBuffer?: number;
  signal?: AbortSignal;
}

// git 子进程失败原因五选一，判定顺序即优先级：中止最先判、其次是 exec 层面的 kill/超时，
// 再是 execFile 自身报出的缓冲区超限（比 killed 更具体，需先于笼统的超时归因判定），
// 最后落到 stderr 文本匹配；顺序颠倒会把"变更过大"误报成"超时"或反之
function normalizeGitError(
  error: NodeJS.ErrnoException & { killed?: boolean },
  signal: AbortSignal | undefined,
  stderr: Buffer,
): Error {
  if (signal?.aborted) return new Error("git 命令已中止");
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error("变更过大，超出快照上限");
  if (error.killed) return new Error("git 命令超时");
  const stderrText = stderr.toString("utf8");
  if (/unknown revision or path not in the working tree|ambiguous argument 'HEAD'/i.test(stderrText)) {
    return new Error("仓库尚无提交，无法计算审查快照");
  }
  return new Error("git 命令执行失败，请核对仓库状态");
}

function runGit(cwd: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer, encoding: "buffer", env: { ...process.env, LC_ALL: "C" }, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(normalizeGitError(error as NodeJS.ErrnoException & { killed?: boolean }, signal, stderr as unknown as Buffer));
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

function hashSegment(hash: ReturnType<typeof createHash>, segment: Buffer): void {
  hash.update(`${segment.length}\0`);
  hash.update(segment);
}

function parseUntrackedPaths(status: Buffer): string[] {
  return status
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
}

function statsTypeLabel(stats: { isDirectory(): boolean; isFIFO(): boolean; isSocket(): boolean }): string {
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "other";
}

// 符号链接只喂目标路径字符串，不解引用读内容：目标可能在仓库外、可能不存在，
// 解引用既不安全也偏离"这条链接指向哪里"这一真正会影响审查的信息
async function untrackedEntrySegment(cwd: string, relPath: string): Promise<Buffer> {
  const fullPath = join(cwd, relPath);
  let stats;
  try {
    stats = await lstat(fullPath);
  } catch {
    return Buffer.from("unreadable");
  }
  if (stats.isSymbolicLink()) {
    try {
      return Buffer.from(await readlink(fullPath), "utf8");
    } catch {
      return Buffer.from("unreadable");
    }
  }
  if (stats.isFile()) {
    if (stats.size > UNTRACKED_FILE_SIZE_LIMIT) return Buffer.from(`size:${stats.size}`);
    try {
      return await readFile(fullPath);
    } catch {
      return Buffer.from("unreadable");
    }
  }
  return Buffer.from(`type:${statsTypeLabel(stats)}`);
}

export interface ChangedEntry {
  paths: string[];
}

// 重命名条目在 -z 输出里是"新路径"与"不带前缀的旧路径"两个连续段：两者算一次改动，
// 旧路径若命中获准范围就得带着新路径一起放行，否则改名后的文件反而没法提交
function parseChangedEntries(status: Buffer): ChangedEntry[] {
  const raw = status.toString("utf8").split("\0").filter((entry) => entry.length > 0);
  const entries: ChangedEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as string;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R") {
      const orig = raw[++i];
      entries.push({ paths: orig !== undefined ? [path, orig] : [path] });
    } else if (code[0] === "C") {
      i++;
      entries.push({ paths: [path] });
    } else {
      entries.push({ paths: [path] });
    }
  }
  return entries;
}

export async function changedEntries(repoRoot: string): Promise<ChangedEntry[]> {
  const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"], undefined, GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
  return parseChangedEntries(status);
}

export async function changedPaths(repoRoot: string): Promise<string[]> {
  return (await changedEntries(repoRoot)).flatMap((entry) => entry.paths);
}

export async function collectGitSnapshot(input: CollectGitSnapshotInput): Promise<GitSnapshot> {
  const { repoRoot, signal } = input;
  const timeoutMs = input.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const maxBuffer = input.gitMaxBuffer ?? GIT_MAX_BUFFER;
  const head = (await runGit(repoRoot, ["rev-parse", "HEAD"], signal, timeoutMs, maxBuffer)).toString("utf8").trim();
  const rawBranch = (
    await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], signal, timeoutMs, maxBuffer)
  ).toString("utf8").trim();
  // -uall：未跟踪目录逐文件展开，不塌缩成目录名一行，否则目录内文件改内容不改路径时指纹不变
  const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"], signal, timeoutMs, maxBuffer);
  const diff = await runGit(repoRoot, ["diff", "HEAD", "--binary"], signal, timeoutMs, maxBuffer);
  const hash = createHash("sha256");
  hashSegment(hash, status);
  hashSegment(hash, diff);
  // 未跟踪文件的内容不出现在 diff 里，porcelain 状态行也不含内容——不单独喂入会漏检改动
  for (const relPath of parseUntrackedPaths(status).sort()) {
    hashSegment(hash, Buffer.from(relPath, "utf8"));
    hashSegment(hash, await untrackedEntrySegment(repoRoot, relPath));
  }
  return { head, branch: rawBranch === "HEAD" ? null : rawBranch, fingerprint: hash.digest("hex") };
}
