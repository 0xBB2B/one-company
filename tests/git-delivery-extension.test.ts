import { answeringUi } from "./helpers/window-host.ts";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_DELIVER_TOOL, registerGitDelivery, showGitDeliveryTool } from "../src/modules/delivery/git-delivery-extension.ts";
import { dataRoot } from "../src/core/storage/data-root.ts";
import { globalDatabase, withDatabase } from "../src/core/storage/database.ts";
import * as gitDelivery from "../src/modules/delivery/git-delivery.ts";
import { projectSettingsPath, userSettingsPath } from "../src/modules/settings/agent-settings.ts";
import type { WorkspaceClientsHandle } from "../src/core/host/daemon-client.ts";

const cleanups: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Tool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }> };
type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
const gitDeliverySettings = (enabled: boolean) => JSON.stringify({ "one-company": { "git-delivery": enabled } });
async function writeSettings(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function world(status: Record<string, unknown> = { status: "closed", reason: "completed", archive: null, delivery: null }, trusted = true) {
  const root = await realpath(await mkdtemp("/tmp/pi-t-"));
  cleanups.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let active = ["read", "bash"];
  const tools = new Map<string, Tool>(), commands: string[] = [], handlers = new Map<string, Handler>();
  const calls: unknown[] = [];
  const pi = {
    registerTool: (tool: Tool & { name: string }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string) => { commands.push(name); },
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const clients = { forRepo: () => ({ call: async (method: string, params: unknown) => { calls.push([method, params]); return { result: { close: status } }; } }) } as unknown as WorkspaceClientsHandle;
  registerGitDelivery(pi, () => ({ clients: () => clients }));
  const ctx = { cwd, isProjectTrusted: () => trusted, hasUI: true, ui: { ...answeringUi(() => true), notify: () => {} } };
  const start = async () => { await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx); };
  const run = async (params: unknown) => JSON.parse((await tools.get(GIT_DELIVER_TOOL)!.execute("t", params, undefined, undefined, ctx)).content[0]!.text) as Record<string, unknown>;
  return {
    pi, active: () => active, commands, start, run, calls,
    userPath: userSettingsPath(agentDir), projectPath: projectSettingsPath(cwd),
  };
}
const PARAMS = { repoId: "a".repeat(64), requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10" };

test("两层设置都没写时，窗口启动后工具列表里没有交付工具，其他工具保留", async () => {
  const w = await world();
  await w.start();
  expect(w.active()).toEqual(["read", "bash"]);
});

test("用户层写 false 时，窗口启动后没有交付工具", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(false));
  await w.start();
  expect(w.active()).toEqual(["read", "bash"]);
});

test("用户层写 true 时，窗口启动后工具列表里有交付工具，其他工具顺序不变", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(true));
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("项目层 true、用户层没写、项目不受信任时没有交付工具", async () => {
  const w = await world(undefined, false);
  await writeSettings(w.projectPath, gitDeliverySettings(true));
  await w.start();
  expect(w.active()).toEqual(["read", "bash"]);
});

test("项目层 true、用户层没写、项目受信任时有交付工具", async () => {
  const w = await world();
  await writeSettings(w.projectPath, gitDeliverySettings(true));
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("旧的全局数据库里有已开启的开关时不生效：两层设置都没写则没有交付工具，调用被拒", async () => {
  const w = await world();
  withDatabase(globalDatabase(dataRoot(process.env)), (db) => db.create("settings", "git-delivery", { enabled: true }));
  await w.start();
  expect(w.active()).toEqual(["read", "bash"]);
  await expect(w.run(PARAMS)).rejects.toThrow("原因：Git 交付已关闭");
});

test("用户层写 false、项目层写 true、项目受信任时有交付工具", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(false));
  await writeSettings(w.projectPath, gitDeliverySettings(true));
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("项目层 false 盖过用户层 true", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(true));
  await writeSettings(w.projectPath, gitDeliverySettings(false));
  await w.start();
  expect(w.active()).toEqual(["read", "bash"]);
});

test("showGitDeliveryTool 传 true 后有交付工具、传 false 后没有，其他工具顺序不变，重复传 true 不出现两个", async () => {
  const w = await world();
  showGitDeliveryTool(w.pi, true);
  showGitDeliveryTool(w.pi, true);
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
  showGitDeliveryTool(w.pi, false);
  expect(w.active()).toEqual(["read", "bash"]);
});

test("窗口启动时开启，之后用户设置改成 false，再调用交付工具会被拒绝并写明原因和建议", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(true));
  await w.start();
  await writeSettings(w.userPath, gitDeliverySettings(false));
  await expect(w.run(PARAMS)).rejects.toThrow("原因：Git 交付已关闭");
  await expect(w.run(PARAMS)).rejects.toThrow("建议：请用户在 /one:setting 的开关里开启 Git 交付后再交付");
  expect(w.calls).toEqual([]);
});

test("没开启过时直接调用交付工具也被拒绝", async () => {
  const w = await world();
  await w.start();
  await expect(w.run(PARAMS)).rejects.toThrow("原因：Git 交付已关闭");
});

test("模型不能在参数里代选合并方式", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings(true));
  await w.start();
  await expect(w.run({ ...PARAMS, merge: "auto" })).rejects.toThrow("原因：参数不符合本工具的格式（多余字段：merge；本动作允许字段：repoId、requirementId）");
});

test("需求未以完成关闭时拒绝交付", async () => {
  const w = await world({ status: "closed", reason: "cancelled", archive: null, delivery: null });
  await writeSettings(w.userPath, gitDeliverySettings(true));
  await w.start();
  await expect(w.run(PARAMS)).rejects.toThrow("原因：需求没有以完成（completed）关闭并归档，当前状态 closed，关闭原因 cancelled\n建议：只有用户验收通过并以完成关闭的需求才能交付；需求已取消或拒绝时不要交付");
  expect(w.calls).toEqual([["workflow.manage", { requirementId: PARAMS.requirementId, request: { action: "status" } }]]);
});

test("不再注册 one:git-delivery 命令", async () => {
  const w = await world();
  expect(w.commands).not.toContain("one:git-delivery");
});

test("git-delivery 运行时模块不再导出数据库开关函数", () => {
  expect("gitDeliveryEnabled" in gitDelivery).toBe(false);
  expect("setGitDeliveryEnabled" in gitDelivery).toBe(false);
});
