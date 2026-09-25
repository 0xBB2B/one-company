import { resolve } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export function createProtectedFileTools(
  resolveProtection: (cwd: string) => Promise<Pick<Awaited<ReturnType<typeof mainWriteProtection>>, "checkWrite">> = mainWriteProtection,
) {
  const check = async (path: string, ctx: ExtensionContext) => {
    const protection = await resolveProtection(ctx.cwd);
    const checked = await protection.checkWrite(path);
    if (!checked.ok) throw new Error(checked.reason);
  };
  const mutate = async (path: string, content: string, ctx: ExtensionContext, sdkSignal?: AbortSignal, directory?: string) => {
    await check(path, ctx);
    const assertSignal = () => { sdkSignal?.throwIfAborted(); };
    if (directory) await mkdir(directory, { recursive: true });
    assertSignal();
    // mkdir 后重新执行原真实路径/链接/范围保护
    await check(path, ctx);
    assertSignal();
    await writeFile(path, content, "utf8");
  };
  const write = createWriteToolDefinition(process.cwd());
  const edit = createEditToolDefinition(process.cwd());
  return [
    { ...write, async execute(id, params, signal, update, ctx) {
      // SDK 自己持有文件队列；operations 在队列内执行，不外包同一队列造成重入死锁。
      let directory: string | undefined;
      const tool = createWriteToolDefinition(ctx.cwd, { operations: {
        async mkdir(dir) {
          await check(resolveToolPath(params.path, ctx.cwd), ctx);
          directory = dir;
        },
        writeFile: (path, content) => mutate(path, content, ctx, signal, directory),
      } });
      return tool.execute(id, params, signal, update, ctx);
    } } satisfies typeof write,
    { ...edit, async execute(id, params, signal, update, ctx) {
      const tool = createEditToolDefinition(ctx.cwd, { operations: {
        async access(path) { await check(path, ctx); await access(path, constants.R_OK | constants.W_OK); },
        async readFile(path) { await check(path, ctx); return readFile(path); },
        // SDK 已完成 BOM/CRLF/模糊匹配处理，这里的 content 是实际目标字节来源。
        writeFile: (path, content) => mutate(path, content, ctx, signal),
      } });
      return tool.execute(id, params, signal, update, ctx);
    } } satisfies typeof edit,
  ] as const;
}

function resolveToolPath(path: string, cwd: string): string {
  const value = path.startsWith("@") ? path.slice(1) : path;
  return resolve(cwd, value === "~" ? homedir() : value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value);
}

export default function writeProtectionExtension(pi: ExtensionAPI): void {
  const [write, edit] = createProtectedFileTools();
  pi.registerTool(write);
  pi.registerTool(edit);
  pi.registerTool(createGitCommitTool(async (cwd) => (await mainWriteProtection(cwd)).commit));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const protection = await mainWriteProtection(ctx.cwd);
    const checked = await protection.checkWrite(resolveToolPath(String(event.input.path), ctx.cwd));
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
