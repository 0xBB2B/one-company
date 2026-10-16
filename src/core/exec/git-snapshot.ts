import { createReadStream } from "node:fs";
import { PRD_ARCHIVE_GIT_PATHSPECS, isPrdArchivePath } from "../policy/content-policy.ts";
import { readGitBytes } from "./git-read.ts";
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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
  excludePaths?: string[];
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

async function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBuffer: number,
): Promise<Buffer> {
  try {
    return (await readGitBytes(cwd, args, { signal, timeout: timeoutMs, maxBuffer })).stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: Buffer };
    throw normalizeGitError(failure, signal, failure.stderr ?? Buffer.alloc(0));
  }
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
    throw new Error(`无法读取快照文件: ${relPath}`);
  }
  if (stats.isSymbolicLink()) {
    try {
      return Buffer.from(await readlink(fullPath), "utf8");
    } catch {
      throw new Error(`无法读取快照文件: ${relPath}`);
    }
  }
  if (stats.isFile()) {
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(fullPath)) hash.update(chunk);
      return Buffer.from(hash.digest("hex"));
    } catch {
      throw new Error(`无法读取快照文件: ${relPath}`);
    }
  }
  return Buffer.from(`type:${statsTypeLabel(stats)}`);
}

export async function collectGitSnapshot(input: CollectGitSnapshotInput): Promise<GitSnapshot> {
  const { repoRoot, signal } = input;
  const timeoutMs = input.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const maxBuffer = input.gitMaxBuffer ?? GIT_MAX_BUFFER;
  const pathspec = [
    "--",
    ".",
    ...PRD_ARCHIVE_GIT_PATHSPECS,
    ...(input.excludePaths ?? []).map((path) => `:(exclude,literal)${path}`),
  ];
  const head = (await runGit(repoRoot, ["rev-parse", "HEAD"], signal, timeoutMs, maxBuffer)).toString("utf8").trim();
  const rawBranch = (
    await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], signal, timeoutMs, maxBuffer)
  ).toString("utf8").trim();
  // 禁用重命名比较后，跨归档边界的改名按允许范围内的删除或新增计算，不读取另一侧正文。
  // -uall：未跟踪目录逐文件展开，不塌缩成目录名一行，否则目录内文件改内容不改路径时指纹不变
  const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-uall", "--no-renames", ...pathspec], signal, timeoutMs, maxBuffer);
  const diff = await runGit(repoRoot, ["diff", "HEAD", "--binary", "--no-renames", ...pathspec], signal, timeoutMs, maxBuffer);
  const hash = createHash("sha256");
  hashSegment(hash, status);
  hashSegment(hash, diff);
  hashSegment(hash, await runGit(repoRoot, ["diff", "--cached", "--binary", "--no-renames", ...pathspec], signal, timeoutMs, maxBuffer));
  // 未跟踪文件的内容不出现在 diff 里，porcelain 状态行也不含内容——不单独喂入会漏检改动
  for (const relPath of parseUntrackedPaths(status).sort()) {
    if (isPrdArchivePath(relPath)) continue;
    hashSegment(hash, Buffer.from(relPath, "utf8"));
    hashSegment(hash, await untrackedEntrySegment(repoRoot, relPath));
  }
  return { head, branch: rawBranch === "HEAD" ? null : rawBranch, fingerprint: hash.digest("hex") };
}

export async function listChangedPaths(repoRoot: string): Promise<string[]> {
  const status = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-uall", "--no-renames", "--", ".", ...PRD_ARCHIVE_GIT_PATHSPECS], undefined, GIT_TIMEOUT_MS, GIT_MAX_BUFFER);
  return status.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3));
}
