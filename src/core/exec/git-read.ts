import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitReadOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
}

// 内部查询只能读取：排除外部 diff/textconv，不启动 Git 辅助程序。
export async function readGitBytes(cwd: string, args: string[], options: GitReadOptions = {}) {
  const commandArgs = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  return execFileAsync("git", ["-c", "core.fsmonitor=false", ...commandArgs], {
    cwd, env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }, encoding: "buffer",
    timeout: options.timeout ?? 10_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, signal: options.signal,
  });
}

export async function readGit(cwd: string, args: string[], options: GitReadOptions = {}) {
  const result = await readGitBytes(cwd, args, options);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await readGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return cwd;
  }
}
