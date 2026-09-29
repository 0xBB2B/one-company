import { afterEach, expect, test } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_DELIVER_TOOL, registerGitDelivery } from "../extensions/git-delivery.ts";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Tool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }> };
async function world(status: Record<string, unknown> = { status: "closed", reason: "completed", archive: null, delivery: null }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "git-delivery-ext-")));
  cleanups.push(root);
  let active = ["read", GIT_DELIVER_TOOL];
  const tools = new Map<string, Tool>(), commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>(), handlers = new Map<string, () => void>();
  const calls: unknown[] = [];
  const pi = {
    registerTool: (tool: Tool & { name: string }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, options.handler); },
    on: (event: string, handler: () => void) => { handlers.set(event, handler); },
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const clients = { forRepo: () => ({ call: async (method: string, params: unknown) => { calls.push([method, params]); return { result: { close: status } }; } }) } as unknown as WorkspaceClientsHandle;
  registerGitDelivery(pi, () => ({ dataRoot: root, clients: () => clients }));
  const answers: string[] = [];
  const ctx = { hasUI: true, ui: { select: async () => answers.shift(), confirm: async () => true, notify: () => {} } };
  const run = async (params: unknown) => JSON.parse((await tools.get(GIT_DELIVER_TOOL)!.execute("t", params, undefined, undefined, ctx)).content[0]!.text) as Record<string, unknown>;
  return { active: () => active, handlers, commands, answers, ctx, run, calls };
}
const PARAMS = { repoId: "a".repeat(64), requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10" };

test("M8-AC4/AC6：交付工具默认关闭且不出现在主窗口工具里；命令开启后才出现，关闭后再隐藏", async () => {
  const w = await world();
  w.handlers.get("session_start")!();
  expect(w.active()).toEqual(["read"]);
  await expect(w.run(PARAMS)).rejects.toThrow("pi_company_git_deliver失败。\n原因：Git 交付工具已关闭\n建议：请用户用 /pi-company:git-delivery 命令开启后再交付");
  w.answers.push("开启"); await w.commands.get("pi-company:git-delivery")!("", w.ctx);
  expect(w.active()).toEqual(["read", GIT_DELIVER_TOOL]);
  w.answers.push("关闭"); await w.commands.get("pi-company:git-delivery")!("", w.ctx);
  expect(w.active()).toEqual(["read"]);
});

test("M8-AC6：模型不能在参数里代选合并方式；需求未以完成关闭时拒绝交付", async () => {
  const w = await world({ status: "closed", reason: "cancelled", archive: null, delivery: null });
  w.answers.push("开启"); await w.commands.get("pi-company:git-delivery")!("", w.ctx);
  await expect(w.run({ ...PARAMS, merge: "auto" })).rejects.toThrow("原因：参数不符合本工具的格式（多余字段：merge；本动作允许字段：repoId、requirementId）");
  await expect(w.run(PARAMS)).rejects.toThrow("原因：需求没有以完成（completed）关闭并归档，当前状态 closed，关闭原因 cancelled\n建议：只有用户验收通过并以完成关闭的需求才能交付；需求已取消或拒绝时不要交付");
  expect(w.calls).toEqual([["workflow.manage", { requirementId: PARAMS.requirementId, request: { action: "status" } }]]);
});
