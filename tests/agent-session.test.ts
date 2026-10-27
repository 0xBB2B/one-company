import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkAgentToolCall, createAgentRoleSession } from "../src/modules/agents/agent-session.ts";
import type { AgentSessionHandle } from "../src/modules/agents/agent-session.ts";
import { createClock } from "../src/core/policy/clock.ts";
import { uuidv7 } from "../src/core/storage/database.ts";
import { NetworkPauseGate } from "../src/core/host/network-pause.ts";
import { authorizeToolAction, CORE_TOOL_ACTIONS } from "../src/core/policy/core-permissions.ts";
import type { CoreTool } from "../src/core/policy/core-permissions.ts";
import { coreToolName, ROLE_HOST_TOOLS, toPiTool } from "../src/modules/agents/role-tools.ts";
import { AGENT_ROLES } from "../src/modules/agents/roles.ts";
import type { AgentRole } from "../src/modules/agents/roles.ts";
import { createFakeTimeSource } from "./helpers/fake-clock.ts";
import type { FakeTimeSource } from "./helpers/fake-clock.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function grantedTools(role: AgentRole): CoreTool[] {
  return (Object.keys(CORE_TOOL_ACTIONS) as CoreTool[]).filter((tool) => CORE_TOOL_ACTIONS[tool].some((action) => authorizeToolAction(role, tool, action)));
}

function fakeCoreTools(role: AgentRole, calls: string[], hangForever?: Promise<void>, honorsAbort = false): ToolDefinition[] {
  if (honorsAbort) {
    return grantedTools(role).map((tool) => toPiTool(tool, `fixture ${tool}`, Type.Object({}, { additionalProperties: true }), {
      async execute(_input: unknown, signal?: AbortSignal) {
        calls.push(tool);
        const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("已取消")), { once: true }));
        await Promise.race([hangForever, aborted]);
        return {};
      },
      dispose() {},
    }));
  }
  return grantedTools(role).map((tool) => ({
    name: coreToolName(tool), label: tool, description: `fixture ${tool}`, parameters: Type.Object({}, { additionalProperties: true }),
    async execute() { calls.push(tool); if (hangForever) await hangForever; return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
  }) as unknown as ToolDefinition);
}

async function world(timeSource?: FakeTimeSource) {
  const root = await mkdtemp(join(tmpdir(), "agent-session-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "agent", "one-company"), cwd = join(root, "repo"), outside = join(root, "outside.txt");
  await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(dataRoot, { recursive: true }), fs.mkdir(cwd, { recursive: true })]));
  await writeFile(join(cwd, "inside.txt"), "inside");
  await writeFile(outside, "outside");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const clock = createClock(timeSource ? { timeSource } : {}); cleanup.push(() => clock.stopGapWatcher());
  const gate = new NetworkPauseGate();
  let serial = 0;
  async function session(role: AgentRole, replies: ScriptedReply[], options: { readRoots?: string[]; maxTurns?: number; mcp?: string[]; hangForever?: Promise<void>; honorsAbort?: boolean } = {}) {
    const provider = registerControlledProvider(runtime, { providerId: `agent-${++serial}`, modelId: "test" });
    scriptReplies(provider, replies);
    const calls: string[] = [];
    const runId = uuidv7();
    const handle: AgentSessionHandle = await createAgentRoleSession({
      dataRoot, repoId: "a".repeat(64), runId, cwd,
      definition: { name: role, role, description: "fixture", body: `ROLE-BODY-${role}`, ...(options.mcp ? { mcp: options.mcp } : {}) },
      roleRules: `ROLE-RULES-${role}`, context: "TASK-CONTEXT", coreTools: fakeCoreTools(role, calls, options.hangForever, options.honorsAbort), readRoots: options.readRoots ?? (role === "qa" ? [] : [cwd]),
      runtime, modelRef: { provider: provider.providerId, id: "test" }, clock, networkGate: gate,
      completion: role === "pm" ? { kind: "idle-only" } : { kind: "on-result", resultTool: coreToolName("result_submit") },
      maxTurns: options.maxTurns,
    });
    cleanup.push(async () => { await handle.stop(); handle.dispose(); });
    return { handle, provider, calls, runId };
  }
  return { root, dataRoot, cwd, outside, gate, session };
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
    const expected = [...ROLE_HOST_TOOLS[role], ...grantedTools(role).map(coreToolName)].sort();
    expect(toolNames(s.provider.requests[0])).toEqual(expected);
    for (const forbidden of ["bash", "write", "edit", "one_company_git_commit", "structured_output", "one_company_resume_check"]) {
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

  test("系统提示含传入的职责规矩", async () => {
    const w = await world();
    const s = await w.session("reviewer", [{ type: "text", text: "x" }]);
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 1);
    expect(s.provider.requests[0]?.systemPrompt).toContain("ROLE-RULES-reviewer");
  }, 20000);

  test("M8D2-AC1：子代理的系统提示含共享规范，不含只给主窗口的规范", async () => {
    const w = await world();
    const s = await w.session("worker", [{ type: "text", text: "x" }]);
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 1);
    const prompt = s.provider.requests[0]!.systemPrompt!;
    for (const heading of ["## 工作纪律", "## 收尾自检", "## 搜索范围"]) expect(prompt).toContain(heading);
    expect(prompt.indexOf("ROLE-BODY-worker")).toBeLessThan(prompt.indexOf("## 职责规矩"));
    expect(prompt.indexOf("## 职责规矩")).toBeLessThan(prompt.indexOf("ROLE-RULES-worker"));
    expect(prompt.indexOf("ROLE-RULES-worker")).toBeLessThan(prompt.indexOf("## 工作纪律"));
    expect(prompt.indexOf("## 搜索范围")).toBeLessThan(prompt.indexOf("## 本次任务"));
    for (const heading of ["## 主会话职责", "## 沟通方式", "## 递进式澄清", "## 执行授权", "## 归档需求", "## 简报"]) expect(prompt).not.toContain(heading);
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

  test("mcp.json 里设为 direct 的服务，其工具直接列给模型并可直接调用", async () => {
    const w = await world();
    const server = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
    await writeFile(join(dirname(w.dataRoot), "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { command: process.execPath, args: [server], exposure: "direct", toolExposure: { "delete-all": "hidden" } } } }));
    const s = await w.session("worker", [
      { type: "toolcall", name: "mcp__docs__search", input: { q: "登录" } },
      { type: "text", text: "结束" },
    ], { mcp: ["docs"] });
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 2);
    expect(toolNames(s.provider.requests[0])).toContain("mcp__docs__search");
    expect(toolNames(s.provider.requests[0])).not.toContain("mcp__docs__delete_all");
    expect(toolResults(s.provider.requests[1])[0]?.text).toContain("内网文档：search");
  }, 30000);

  test("定义写了 mcp 时按 mcp.json 装载 pi 自带的 MCP，codemode 脚本可调用所选服务的全部工具，会话结束后服务进程退出", async () => {
    const w = await world();
    const pidFile = join(w.root, "mcp.pid");
    const server = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
    await writeFile(join(dirname(w.dataRoot), "mcp.json"), JSON.stringify({ mcpServers: {
      docs: { command: process.execPath, args: [server, pidFile] }, unselected_wiki: { command: process.execPath, args: [server] } } }));
    const script = "const a = await tools.mcp__docs__search({ q: '登录' }); const b = await tools.mcp__docs__delete_all({}); return [a.content[0].text, b.content[0].text].join(' | ');";
    const s = await w.session("worker", [
      { type: "toolcall", name: "codemode", input: { code: script } },
      { type: "toolcall", name: coreToolName("result_submit"), input: {} },
      { type: "text", text: "结束" },
    ], { mcp: ["docs", "absent"] });
    s.handle.prompt("开始");
    await until(() => s.provider.requests.length === 2);
    expect(toolNames(s.provider.requests[0])).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
    expect(s.provider.requests[0]?.systemPrompt).toContain("已装载 docs");
    expect(s.provider.requests[0]?.systemPrompt).toContain("缺失 absent");
    expect(s.provider.requests[0]?.systemPrompt).toContain("mcp__docs (codemode)");
    expect(JSON.stringify(s.provider.requests[0])).not.toContain("unselected_wiki");
    const [result] = toolResults(s.provider.requests[1]);
    expect(result).toMatchObject({ isError: false });
    expect(result!.text).toContain('内网文档：search {\\"q\\":\\"登录\\"} | 内网文档：delete-all {}');
    await s.handle.result();
    const pid = Number(await readFile(pidFile, "utf8"));
    s.handle.dispose();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }, 30000);
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

  test("PM 的回合结束只交回控制权，仍在运行", async () => {
    const w = await world();
    const s = await w.session("pm", [{ type: "text", text: "未提交" }]);
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    s.handle.prompt("开始");
    await until(() => idle.length === 1);
    expect(s.handle.state()).toBe("running");
  }, 20000);

  test("停止后状态为 stopped，结果以停止拒绝", async () => {
    const w = await world();
    const s = await w.session("pm", [{ type: "text", text: "第一轮" }]);
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    s.handle.prompt("开始");
    await until(() => idle.length === 1);
    expect(await s.handle.stop()).toEqual({ stopped: true });
    expect(s.handle.state()).toBe("stopped");
    await expect(s.handle.result()).rejects.toThrow("停止");
  }, 20000);

  test("工具开始执行时发出 tool_start，带工具名与参数", async () => {
    const w = await world();
    const s = await w.session("worker", [
      { type: "toolcall", name: coreToolName("result_submit"), input: { note: "n1" } },
      { type: "text", text: "已提交" },
    ]);
    const started: Array<{ toolCallId?: string; toolName?: string; args?: unknown }> = [];
    s.handle.events.on("tool_start", (event) => started.push(event));
    s.handle.prompt("完成任务");
    await s.handle.result();
    expect(started).toHaveLength(1);
    expect(started[0]!.toolName).toBe(coreToolName("result_submit"));
    expect(started[0]!.args).toEqual({ note: "n1" });
    expect(typeof started[0]!.toolCallId).toBe("string");
  }, 20000);

  test("stop() 后发出 stopped 事件", async () => {
    const w = await world();
    const s = await w.session("pm", [{ type: "text", text: "第一轮" }]);
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    const stopped: unknown[] = []; s.handle.events.on("stopped", () => stopped.push(true));
    s.handle.prompt("开始");
    await until(() => idle.length === 1);
    await s.handle.stop();
    expect(stopped).toHaveLength(1);
  }, 20000);

  test("连接故障当作暂停：状态为 paused、发出 network_paused 并拦住新请求，resume 后放行网络门并原地续接", async () => {
    const w = await world();
    const s = await w.session("pm", [{ type: "error", message: "fetch failed: connection reset (network)" }, { type: "text", text: "恢复后继续" }]);
    const paused: unknown[] = []; s.handle.events.on("network_paused", () => paused.push(true));
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    s.handle.prompt("开始");
    await until(() => s.handle.state() === "paused");
    expect(paused).toHaveLength(1);
    expect(w.gate.canProceed(s.runId)).toBe(false);
    s.handle.prompt("断网期间的消息");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.provider.requests).toHaveLength(1);
    await s.handle.resume();
    expect(s.handle.state()).toBe("running");
    expect(w.gate.canProceed(s.runId)).toBe(true);
    await until(() => idle.length === 1);
    expect(s.provider.requests).toHaveLength(2);
    expect(JSON.stringify(s.provider.requests[1]!.messages.at(-1))).toContain("断网期间的消息");
  }, 20000);

  test("模型请求超时不当作断网：不暂停，由 SDK 自动重试后接着运行", async () => {
    const w = await world();
    const s = await w.session("pm", [{ type: "error", message: "Request timed out." }, { type: "text", text: "重试成功" }]);
    const paused: unknown[] = []; s.handle.events.on("network_paused", () => paused.push(true));
    const idle: unknown[] = []; s.handle.events.on("idle", (event) => idle.push(event));
    s.handle.prompt("开始");
    await until(() => idle.length === 1);
    expect(paused).toHaveLength(0);
    expect(s.handle.state()).toBe("running");
    expect(w.gate.canProceed(s.runId)).toBe(true);
    expect(s.provider.requests).toHaveLength(2);
  }, 20000);
});

describe("暂停确认时限", () => {
  test("abort 迟迟确认不了：15 秒内一直等，超过 15 秒才报 abort 未在超时内确认", async () => {
    const timeSource = createFakeTimeSource();
    const w = await world(timeSource);
    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    const toolName = grantedTools("pm")[0]!;
    const s = await w.session("pm", [{ type: "toolcall", name: coreToolName(toolName), input: {} }], { hangForever: hang });
    cleanup.push(() => release());
    s.handle.prompt("开始");
    await until(() => s.calls.length > 0);

    let outcome: { confirmed: boolean; reason?: string } | undefined;
    const pausing = s.handle.pause().then((value) => { outcome = value; });
    await timeSource.waitPending();
    await timeSource.advanceAsync(14_900);
    expect(outcome).toBeUndefined();
    await timeSource.advanceAsync(200);
    await pausing;
    expect(outcome!.confirmed).toBe(false);
    expect(outcome!.reason).toContain("abort 未在超时内确认");
  }, 20000);
});

describe("暂停时取消正在执行的核心工具", () => {
  test("暂停把取消信号传给正在执行的核心工具，工具响应取消后暂停立即确认成功", async () => {
    const w = await world();
    let release!: () => void;
    const hang = new Promise<void>((resolve) => { release = resolve; });
    const toolName = grantedTools("pm")[0]!;
    const s = await w.session("pm", [{ type: "toolcall", name: coreToolName(toolName), input: {} }], { hangForever: hang, honorsAbort: true });
    cleanup.push(() => release());
    s.handle.prompt("开始");
    await until(() => s.calls.length > 0);

    let outcome: { confirmed: boolean; reason?: string } | undefined;
    const pausing = s.handle.pause().then((value) => { outcome = value; });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(outcome).toEqual({ confirmed: true });
    await pausing;
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

  test("子代理没提交结果就结束本轮时，会话进入 ended_without_result 终态，不再停在运行中", async () => {
    const w = await world();
    const s = await w.session("worker", [call(1), { type: "text", text: "做完了" }], { maxTurns: 5 });
    const ended: unknown[] = []; s.handle.events.on("ended_without_result", (event) => ended.push(event));
    s.handle.prompt("开始");
    await expect(s.handle.result()).rejects.toThrow("ended_without_result");
    expect(s.handle.state()).toBe("ended_without_result");
    expect(ended).toEqual([{ turns: 2 }]);
  }, 20000);

  test("M7-AC28：第 N 轮已完整提交结果时按正常完成处理", async () => {
    const w = await world();
    const s = await w.session("worker", [call(1), { type: "toolcall", name: coreToolName("result_submit"), input: {} }, { type: "text", text: "结束" }], { maxTurns: 2 });
    s.handle.prompt("开始");
    await s.handle.result();
    expect(s.handle.state()).toBe("completed");
  }, 20000);

  test("M7-AC27：非正整数的轮次上限直接拒绝创建会话；合法上限内按实际请求计数", async () => {
    const w = await world();
    for (const maxTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(w.session("worker", [], { maxTurns })).rejects.toThrow("maxTurns");
    const s = await w.session("worker", [call(1), call(2)], { maxTurns: 3 });
    s.handle.prompt("开始");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.handle.turnsUsed()).toBeLessThanOrEqual(3);
  }, 20000);
});
