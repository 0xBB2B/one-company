import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sandboxLaunch } from "./command-boundary.ts";

const execFileAsync = promisify(execFile);
let executable: Promise<string> | undefined;

export function gitExecutable(): Promise<string> {
  return executable ??= (async () => {
    if (process.platform !== "darwin") throw new Error("此平台尚无可用的 Git 文件隔离后端");
    const result = await execFileAsync("/usr/bin/xcrun", ["--find", "git"], {
      cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000,
    });
    return realpath(result.stdout.trim());
  })();
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
  const launch = sandboxLaunch("", {
    readRoots: ["/"], writeRoots: [], deniedReads, deniedWrites: [], scratch: "/private/tmp",
  }, { path: await gitExecutable(), args: ["-c", "core.fsmonitor=false", ...commandArgs] });
  return execFileAsync(launch.command, launch.args, {
    cwd, env: { ...launch.env, LC_ALL: "C" }, encoding: "buffer",
    timeout: options.timeout ?? 10_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, signal: options.signal,
  });
}

export async function readGit(cwd: string, args: string[], options: GitReadOptions = {}) {
  const result = await readGitBytes(cwd, args, options);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}
