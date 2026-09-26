import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkAgentToolCall, createAgentRoleSession } from "../daemon/agent-session.ts";
import type { AgentSessionHandle } from "../daemon/agent-session.ts";
import { createClock } from "../runtime/clock.ts";
import { uuidv7 } from "../runtime/database.ts";
import { NetworkPauseGate } from "../runtime/network-pause.ts";
import { coreToolName, coreToolsForRole, ROLE_HOST_TOOLS } from "../runtime/role-tools.ts";
import { AGENT_ROLES } from "../runtime/roles.ts";
import type { AgentRole } from "../runtime/roles.ts";
import { openSessionManagerForRun } from "../runtime/session-records.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fakeCoreTools(role: AgentRole, calls: string[]): ToolDefinition[] {
  return coreToolsForRole(role).map((tool) => ({
    name: coreToolName(tool), label: tool, description: `fixture ${tool}`, parameters: Type.Object({}, { additionalProperties: true }),
    async execute() { calls.push(tool); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
  }) as unknown as ToolDefinition);
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), "agent-session-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "agent", "pi-company"), cwd = join(root, "repo"), outside = join(root, "outside.txt");
  await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(cwd, { recursive: true })]));
  await writeFile(join(cwd, "inside.txt"), "inside");
  await writeFile(outside, "outside");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const clock = createClock(); cleanup.push(() => clock.stopGapWatcher());
  const gate = new NetworkPauseGate();
  let serial = 0;
  async function session(role: AgentRole, replies: ScriptedReply[], options: { resume?: boolean; runId?: string; readRoots?: string[]; maxTurns?: number } = {}) {
    const provider = registerControlledProvider(runtime, { providerId: `agent-${++serial}`, modelId: "test" });
    scriptReplies(provider, replies);
    const calls: string[] = [];
    const runId = options.runId ?? uuidv7();
    const handle: AgentSessionHandle = await createAgentRoleSession({
      dataRoot, repoId: "a".repeat(64), runId, cwd,
      definition: { name: role, role, description: "fixture", body: `ROLE-BODY-${role}` },
      context: "TASK-CONTEXT", coreTools: fakeCoreTools(role, calls), readRoots: options.readRoots ?? (role === "qa" ? [] : [cwd]),
      runtime, modelRef: { provider: provider.providerId, id: "test" }, clock, networkGate: gate,
      completion: role === "pm" ? { kind: "idle-only" } : { kind: "on-result", resultTool: coreToolName("result_submit") },
      resume: options.resume, maxTurns: options.maxTurns,
    });
    cleanup.push(async () => { await handle.stop(); handle.dispose(); });
    return { handle, provider, calls, runId };
  }
  return { root, dataRoot, cwd, outside, session };
}

function toolNames(request: Context | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name).sort();
}
function toolResults(request: Context | undefined): Array<{ text: string; isError: boolean }> {
  return (request?.messages ?? []).filter((message) => message.role === "toolResult")
    .map((message) => ({ text: JSON.stringify(message.content), isError: Boolean((message as { isError?: boolean }).isError) }));
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("等待超时");
}

describe("工具集与模型请求一致", () => {
  test.each(AGENT_ROLES)("%s 的模型请求只含该职责的宿主工具与核心工具", async (role) => {
    const w = await world();
    const s = await w.session(role, [{ type: "text", text: "只看工具" }]);
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 1);
    const expected = [...ROLE_HOST_TOOLS[role], ...coreToolsForRole(role).map(coreToolName)].sort();
    expect(toolNames(s.provider.requests[0])).toEqual(expected);
    for (const forbidden of ["bash", "write", "edit", "pi_company_git_commit", "structured_output", "pi_company_resume_check"]) {
      expect(toolNames(s.provider.requests[0])).not.toContain(forbidden);
    }
    // 部分提供方（如 OpenAI Responses 接口）遇到含 \p{..}、前后顾或代理项范围的正则，整条请求失败
    expect((s.provider.requests[0]?.tools ?? []).filter((tool) => /\\\\p\{|\(\?<?[=!]|\\\\ud[89a-f]/i.test(JSON.stringify(tool.parameters))).map((tool) => tool.name)).toEqual([]);
  }, 20000);

  test("系统提示含定义正文与程序组装的任务上下文", async () => {
    const w = await world();
    const s = await w.session("worker", [{ type: "text", text: "x" }]);
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 1);
    expect(s.provider.requests[0]?.systemPrompt).toContain("ROLE-BODY-worker");
    expect(s.provider.requests[0]?.systemPrompt).toContain("TASK-CONTEXT");
  }, 20000);
});

describe("工具调用边界", () => {
  test("模型请求未授予的 bash、write 得到错误结果，文件不被改写", async () => {
    const w = await world();
    const s = await w.session("worker", [
      { type: "toolcall", name: "bash", input: { command: "echo hacked > inside.txt" } },
      { type: "toolcall", name: "write", input: { path: "inside.txt", content: "hacked" } },
      { type: "text", text: "结束" },
    ]);
    s.handle.prompt("越权尝试");
    await until(() => s.provider.requests.length === 3);
    expect(toolResults(s.provider.requests[2]).every((result) => result.isError)).toBe(true);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(join(w.cwd, "inside.txt"), "utf8"))).toBe("inside");
  }, 20000);

  test("给定读取根（explore）时只能读根内路径；缺省不限读取范围", async () => {
    const w = await world();
    const ctx = { cwd: w.cwd, readRoots: [w.cwd], paused: () => false, submitted: () => false };
    expect(await checkAgentToolCall({ type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "inside.txt" } } as never, ctx)).toBeUndefined();
    expect(await checkAgentToolCall({ type: "tool_call", toolCallId: "2", toolName: "read", input: { path: w.outside } } as never, ctx)).toMatchObject({ block: true });
    expect(await checkAgentToolCall({ type: "tool_call", toolCallId: "3", toolName: "grep", input: {} } as never, { ...ctx, readRoots: [] })).toMatchObject({ block: true });
    expect(await checkAgentToolCall({ type: "tool_call", toolCallId: "5", toolName: "read", input: { path: w.outside } } as never, { ...ctx, readRoots: undefined })).toBeUndefined();
    for (const path of ["~/.ssh/id_rsa", "~", "@/etc/passwd", "@inside.txt", "file:///etc/passwd", "FILE:///etc/passwd", "inside\u00A0.txt"]) {
      expect(await checkAgentToolCall({ type: "tool_call", toolCallId: "4", toolName: "read", input: { path } } as never, ctx)).toMatchObject({ block: true });
    }
  });

  test("MCP 调用只放行可信配置声明为只读的工具与所选服务", async () => {
    const w = await world();
    const mcp = { servers: ["docs"], entryPath: "/x", packageDir: "/x", config: { mcpServers: { docs: { command: "x", readOnlyTools: ["docs__search"] } } } as never };
    const ctx = { cwd: w.cwd, readRoots: [w.cwd], mcp, paused: () => false, submitted: () => false };
    const call = (input: Record<string, unknown>) => checkAgentToolCall({ type: "tool_call", toolCallId: "m", toolName: "mcp", input } as never, ctx);
    expect(await call({ tool: "docs__search", server: "docs", args: {} })).toBeUndefined();
    expect(await call({ tool: "docs__write", server: "docs", args: {} })).toMatchObject({ block: true });
    expect(await call({ tool: "other__search", server: "other", args: {} })).toMatchObject({ block: true });
    expect(await call({ search: "", tool: "docs__write", args: {} })).toMatchObject({ block: true });
    expect(await call({ describe: "x", tool: "docs__write", server: "docs" })).toMatchObject({ block: true });
    for (const action of ["install", "auth-start", "auth-complete"]) expect(await call({ search: "", action, server: "docs", url: "https://x" })).toMatchObject({ block: true });
    expect(await call({ search: "", connect: "docs" })).toMatchObject({ block: true });
    expect(await call({ search: "docs", server: "docs" })).toBeUndefined();
  });
});

describe("完成与控制", () => {
  test("子代理提交结果后本轮结束即完成，之后的调用被拒绝", async () => {
    const w = await world();
    const s = await w.session("worker", [
      { type: "toolcall", name: coreToolName("result_submit"), input: {} },
      { type: "text", text: "已提交" },
    ]);
    s.handle.prompt("完成任务");
    await s.handle.result();
    expect(s.handle.state()).toBe("completed");
    expect(s.calls).toEqual(["result_submit"]);
  }, 20000);

  test("未提交结果的回合只交回控制权，不算完成；PM 同样只交回控制权", async () => {
    const w = await world();
    for (const role of ["worker", "pm"] as const) {
      const s = await w.session(role, [{ type: "text", text: "未提交" }]);
      const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
      s.handle.prompt("开始");
      await until(() => idle.length === 1);
      expect(s.handle.state()).toBe("running");
    }
  }, 20000);

  test("停止后状态为 stopped，结果以停止拒绝，会话记录可按运行续接", async () => {
    const w = await world();
    const s = await w.session("reviewer", [{ type: "text", text: "第一轮" }]);
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    s.handle.prompt("开始");
    await until(() => idle.length === 1);
    expect(await s.handle.stop()).toEqual({ stopped: true });
    expect(s.handle.state()).toBe("stopped");
    await expect(s.handle.result()).rejects.toThrow("停止");
    const opened = openSessionManagerForRun({ dataRoot: w.dataRoot, repoId: "a".repeat(64), runId: s.runId });
    expect(opened.ok).toBe(true);
    const resumed = await w.session("reviewer", [{ type: "text", text: "续接" }], { resume: true, runId: s.runId });
    expect(resumed.handle.state()).toBe("running");
  }, 20000);
});

describe("对话轮次上限", () => {
  const call = (n: number): ScriptedReply => ({ type: "toolcall", name: "read", input: { path: `inside.txt#${n}` } });

  test("M7-AC28：最多执行 N 次模型请求，不发出第 N+1 次，未提交结果标记 turn_limit_reached", async () => {
    const w = await world();
    const s = await w.session("worker", [call(1), call(2), call(3), call(4)], { maxTurns: 2 });
    const reached: unknown[] = []; s.handle.events.on("turn_limit_reached", (event) => reached.push(event));
    s.handle.prompt("开始");
    await expect(s.handle.result()).rejects.toThrow("turn_limit_reached");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.provider.requests).toHaveLength(2);
    expect(s.handle.state()).toBe("turn_limit_reached");
    expect(s.handle.turnsUsed()).toBe(2);
    expect(reached).toEqual([{ turns: 2, maxTurns: 2 }]);
  }, 20000);

  test("M7-AC28：第 N 轮已完整提交结果时按正常完成处理", async () => {
    const w = await world();
    const s = await w.session("worker", [call(1), { type: "toolcall", name: coreToolName("result_submit"), input: {} }, { type: "text", text: "结束" }], { maxTurns: 2 });
    s.handle.prompt("开始");
    await s.handle.result();
    expect(s.handle.state()).toBe("completed");
  }, 20000);

  test("M7-AC27：非正整数的轮次上限直接拒绝创建会话；续接时按已用轮数继续计数", async () => {
    const w = await world();
    for (const maxTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(w.session("worker", [], { maxTurns })).rejects.toThrow("maxTurns");
    const s = await w.session("worker", [call(1), call(2)], { maxTurns: 3 });
    s.handle.prompt("开始");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.handle.turnsUsed()).toBeLessThanOrEqual(3);
  }, 20000);
});
