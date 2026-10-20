import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATABASE_MAINTENANCE_FILE } from "../../src/core/storage/database-paths.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";

export const STALE_LSTART = "Thu Jan  1 00:00:00 2026";

export async function writeMarker(directory: string, pid: number, processStartIdentity: string): Promise<string> {
  const path = join(directory, DATABASE_MAINTENANCE_FILE);
  await writeFile(path, JSON.stringify({
    format: "database-maintenance/v2", operationId: uuidv7(), state: "maintenance",
    owner: { pid, processStartIdentity }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return path;
}

export async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return pid;
}

export async function aliveChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "console.log('UP');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", () => resolve());
  });
  return child;
}

export async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL"); await closed;
}
