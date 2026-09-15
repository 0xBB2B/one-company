import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sandboxLaunch } from "./command-boundary.ts";
import { currentHostGit } from "./git-runtime.mjs";

const execFileAsync = promisify(execFile);

export async function gitExecutable(): Promise<string> {
  return currentHostGit().executablePath;
}

export interface GitReadOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  deniedReads?: string[];
}

// 内部查询只能读取：禁止写入、联网和启动 Git 辅助程序，并排除外部 diff/textconv。
export async function readGitBytes(cwd: string, args: string[], options: GitReadOptions = {}) {
  const commandArgs = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  const deniedReads = [...new Set((options.deniedReads ?? []).map((path) => resolve(cwd, path)))];
  const binding = currentHostGit([cwd]);
  const launch = sandboxLaunch("", {
    readRoots: ["/"], writeRoots: [], deniedReads, deniedWrites: [], scratch: "/private/tmp",
  }, { path: binding.executablePath, args: ["-c", "core.fsmonitor=false", ...commandArgs] });
  currentHostGit([cwd]);
  try {
    return await execFileAsync(launch.command, launch.args, {
      cwd, env: { ...launch.env, LC_ALL: "C" }, encoding: "buffer",
      timeout: options.timeout ?? 10_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, signal: options.signal,
    });
  } finally {
    currentHostGit([cwd]);
  }
}

export async function readGit(cwd: string, args: string[], options: GitReadOptions = {}) {
  const result = await readGitBytes(cwd, args, options);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}
