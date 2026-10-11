import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_ENV } from "./repo-fixture.ts";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV, timeout: 10_000 });
  return stdout;
}
