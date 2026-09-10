import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClock } from "../runtime/clock.ts";
import { dataRoot, repositoryIdentity } from "../runtime/identity.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { windowReady } from "./lifecycle.ts";
import { createGitCommitTool } from "../runtime/git-commit-tool.ts";

let generation = 0;
const protections = new Map<string, Promise<Awaited<ReturnType<typeof createRangeProtection>>>>();
const clock = createClock();

export async function mainWriteProtection(cwd: string) {
  const window = await windowReady();
  if (!window.shellRegistry) throw new Error("窗口 Shell 登记尚未就绪");
  const identity = await repositoryIdentity(cwd);
  const repo = window.workspace.repos.find((entry) => entry.repoId === identity.repoId);
  if (!repo) throw new Error("操作目录不属于当前工作区");
  const key = `${generation}:${window.windowId}:${repo.path}`;
  let protection = protections.get(key);
  if (!protection) {
    protection = createRangeProtection({ cwd: repo.path, dataRoot: dataRoot(process.env), holder: { kind: "main", windowId: window.windowId }, writePaths: [repo.path], clock, shells: window.shellRegistry });
    protections.set(key, protection);
  }
  return protection;
}

export default function writeProtectionExtension(pi: ExtensionAPI): void {
  pi.registerTool(createGitCommitTool(async (cwd) => (await mainWriteProtection(cwd)).commit));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const protection = await mainWriteProtection(ctx.cwd);
    const checked = await protection.checkWrite(resolve(ctx.cwd, String(event.input.path)));
    if (!checked.ok) return { block: true, reason: checked.reason };
  });
  pi.on("tool_execution_end", async () => {
    const window = await windowReady();
    if (window.shellRegistry?.list().some((task) => ["starting", "running", "stopping", "uncertain"].includes(task.status))) return;
    for (const protection of protections.values()) await (await protection).release();
  });
  pi.on("session_shutdown", async () => {
    generation++;
    const pending = [...protections.values()];
    protections.clear();
    for (const protection of pending) await (await protection).release();
    clock.stopGapWatcher();
  });
}
