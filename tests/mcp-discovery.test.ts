import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  checkMcpCall,
  describeMcpStatus,
  detectMcpAdapter,
  filterMcpConfig,
  listMcpServers,
  loadMcpForRole,
} from "../runtime/mcp.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { createTempHome, removeTempHome, type TempHome } from "./helpers/temp-home.ts";
import { calls, resetCalls } from "./fixtures/fake-mcp-adapter/index.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, "fixtures", "fake-mcp-adapter");
const FAKE_ENTRY = join(FIXTURE_DIR, "index.ts");
const BROKEN_ENTRY = join(TEST_DIR, "fixtures", "broken-mcp-adapter", "index.ts");
const ESCAPING_DIR = join(TEST_DIR, "fixtures", "escaping-mcp-adapter");

const tempRoots: string[] = [];
const tempHomes: TempHome[] = [];

afterEach(async () => {
  for (const home of tempHomes.splice(0)) {
    await removeTempHome(home);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function baseServers() {
  return {
    context7: { command: "context7-server", args: ["--stdio"] },
    "chrome-devtools": { command: "chrome-devtools-server", args: [] },
    codegraph: { url: "http://127.0.0.1:4000", disabled: true },
  };
}

interface FakePiTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: unknown[]; details: unknown }>;
}

interface FakeToolCallEvent {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface FakePi {
  registeredTools: Map<string, FakePiTool>;
  toolCallHandlers: Array<(event: FakeToolCallEvent) => { block?: boolean; reason?: string } | void>;
  registerTool(tool: FakePiTool): void;
  on(event: string, handler: (event: FakeToolCallEvent) => { block?: boolean; reason?: string } | void): void;
}

function createFakePi(): FakePi {
  const registeredTools = new Map<string, FakePiTool>();
  const toolCallHandlers: FakePi["toolCallHandlers"] = [];
  return {
    registeredTools,
    toolCallHandlers,
    registerTool(tool) {
      registeredTools.set(tool.name, tool);
    },
    on(event, handler) {
      if (event === "tool_call") toolCallHandlers.push(handler);
    },
  };
}

function inferMode(input: Record<string, unknown>): "search" | "describe" | "call" {
  if (input.search !== undefined) return "search";
  if (input.describe !== undefined) return "describe";
  return "call";
}

function wireCheckMcpCall(
  pi: { on: (event: string, handler: (event: FakeToolCallEvent) => { block?: boolean; reason?: string } | void) => void },
  roleKind: "plan" | "work" | "review" | "acceptance" | "manage",
  allowedServers: string[],
) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "mcp") return;
    const decision = checkMcpCall({
      roleKind,
      allowedServers,
      request: {
        mode: inferMode(event.input),
        server: event.input.server as string | undefined,
        tool: event.input.tool as string | undefined,
        args: event.input.args,
      },
    });
    if (!decision.allowed) return { block: true, reason: decision.reason };
  });
}

async function simulateToolCall(pi: FakePi, input: Record<string, unknown>) {
  const event: FakeToolCallEvent = { type: "tool_call", toolName: "mcp", toolCallId: "sim", input };
  for (const handler of pi.toolCallHandlers) {
    const decision = handler(event);
    if (decision?.block) return { blocked: true as const, reason: decision.reason };
  }
  const tool = pi.registeredTools.get("mcp");
  if (!tool) throw new Error("mcp 工具未注册");
  const result = await tool.execute("sim", input, undefined, undefined, {});
  return { blocked: false as const, result };
}

describe("detectMcpAdapter", () => {
  test("sourcePaths 未包含适配器包时返回 installed:false", async () => {
    const unrelated = await mkdtemp(join(tmpdir(), "mcp-discovery-unrelated-"));
    tempRoots.push(unrelated);
    const result = detectMcpAdapter({ sourcePaths: [unrelated], argv: [], agentDir: "/dev/null/agent" });
    expect(result.installed).toBe(false);
  });

  test("sourcePaths 含不存在的路径时不抛错并返回 installed:false", () => {
    expect(() =>
      detectMcpAdapter({ sourcePaths: ["/nonexistent/pi-mcp-discovery-path"], argv: [], agentDir: "/dev/null/agent" }),
    ).not.toThrow();
    const result = detectMcpAdapter({
      sourcePaths: ["/nonexistent/pi-mcp-discovery-path"],
      argv: [],
      agentDir: "/dev/null/agent",
    });
    expect(result.installed).toBe(false);
  });

  test("sourcePaths 指向适配器包根目录时返回 packageDir 与 entryPath", () => {
    const result = detectMcpAdapter({ sourcePaths: [FIXTURE_DIR], argv: [], agentDir: "/dev/null/agent" });
    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.packageDir).toBe(FIXTURE_DIR);
      expect(result.entryPath).toBe(FAKE_ENTRY);
    }
  });

  test("sourcePaths 指向适配器包内嵌套目录时向上查找到 packageDir", () => {
    const nested = join(FIXTURE_DIR, "nested");
    const result = detectMcpAdapter({ sourcePaths: [nested], argv: [], agentDir: "/dev/null/agent" });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.packageDir).toBe(FIXTURE_DIR);
  });

  test("configPath 取 argv 中 --mcp-config 之后的值", () => {
    const result = detectMcpAdapter({
      sourcePaths: [FIXTURE_DIR],
      argv: ["--mcp-config", "/tmp/x/mcp.json"],
      agentDir: "/dev/null/agent",
    });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.configPath).toBe("/tmp/x/mcp.json");
  });

  test("configPath 支持 --mcp-config=path 形式", () => {
    const result = detectMcpAdapter({
      sourcePaths: [FIXTURE_DIR],
      argv: ["--mcp-config=/tmp/y/mcp.json"],
      agentDir: "/dev/null/agent",
    });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.configPath).toBe("/tmp/y/mcp.json");
  });

  test("argv 未指定 --mcp-config 时 configPath 落在 agentDir 下", () => {
    const result = detectMcpAdapter({ sourcePaths: [FIXTURE_DIR], argv: [], agentDir: "/dev/null/agent" });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.configPath).toBe(join("/dev/null/agent", "mcp.json"));
  });

  test("--mcp-config 后紧跟另一个 flag 时视为未指定", () => {
    const result = detectMcpAdapter({
      sourcePaths: [FIXTURE_DIR],
      argv: ["--mcp-config", "--verbose"],
      agentDir: "/dev/null/agent",
    });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.configPath).toBe(join("/dev/null/agent", "mcp.json"));
  });

  test("--mcp-config= 后为空值时视为未指定", () => {
    const result = detectMcpAdapter({
      sourcePaths: [FIXTURE_DIR],
      argv: ["--mcp-config="],
      agentDir: "/dev/null/agent",
    });
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.configPath).toBe(join("/dev/null/agent", "mcp.json"));
  });

  test("package.json 的 main 指向 packageDir 之外时不放行越界 entryPath", () => {
    const result = detectMcpAdapter({ sourcePaths: [ESCAPING_DIR], argv: [], agentDir: "/dev/null/agent" });
    const safe = result.installed === false;
    expect(safe).toBe(true);
  });

  test("适配器包位于 HOME 之外的祖先目录时不视为安装", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "mcp-discovery-home-bound-"));
    tempRoots.push(tmpRoot);
    await writeFile(
      join(tmpRoot, "package.json"),
      JSON.stringify({ name: "pi-mcp-adapter", version: "0.0.0", main: "index.ts" }),
    );
    const agentDir = join(tmpRoot, "home", ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    const sourcePath = join(tmpRoot, "outside", "leaf");
    await mkdir(sourcePath, { recursive: true });
    const result = detectMcpAdapter({ sourcePaths: [sourcePath], argv: [], agentDir });
    expect(result.installed).toBe(false);
  });
});

describe("listMcpServers", () => {
  test("解析出三个服务及各自 transport 与 disabled 标记", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: baseServers() }));
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
      expect(byName.context7).toEqual({ name: "context7", disabled: false, transport: "stdio" });
      expect(byName["chrome-devtools"]).toEqual({ name: "chrome-devtools", disabled: false, transport: "stdio" });
      expect(byName.codegraph).toEqual({ name: "codegraph", disabled: true, transport: "http" });
    }
  });

  test("识别 socket transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-socket-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { local: { socket: "/tmp/mcp.sock" } } }));
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.servers[0]).toEqual({ name: "local", disabled: false, transport: "socket" });
  });

  test("文件不存在时返回 ok:false 带原因", () => {
    const result = listMcpServers(join(tmpdir(), "definitely-missing-mcp-discovery.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("非法 JSON 时返回 ok:false 带原因", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-bad-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, "{ not json");
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(false);
  });

  test("缺 mcpServers 对象时返回 ok:false 带原因", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-empty-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ settings: {} }));
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(false);
  });

  test("服务项为 null 时返回 ok:false 且原因含服务名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-null-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { a: null } }));
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("a");
  });

  test("服务项为字符串而非对象时返回 ok:false 且原因含服务名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-discovery-cfg-string-"));
    tempRoots.push(dir);
    const configPath = join(dir, "mcp.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { a: "x" } }));
    const result = listMcpServers(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("a");
  });
});

describe("filterMcpConfig", () => {
  function fullConfig() {
    return { mcpServers: baseServers(), settings: { debug: true, autoAuth: true, custom: "x" } };
  }

  test("仅保留勾选且未禁用的服务，其余进入 missing", () => {
    const { config, missing } = filterMcpConfig(fullConfig(), ["context7"]);
    expect(Object.keys(config.mcpServers ?? {})).toEqual(["context7"]);
    expect(missing).toEqual([]);
  });

  test("勾选被禁用的服务时该服务进入 missing", () => {
    const { config, missing } = filterMcpConfig(fullConfig(), ["codegraph"]);
    expect(config.mcpServers ?? {}).toEqual({});
    expect(missing).toEqual(["codegraph"]);
  });

  test("勾选不存在的服务时该服务进入 missing", () => {
    const { missing } = filterMcpConfig(fullConfig(), ["not-a-real-server"]);
    expect(missing).toEqual(["not-a-real-server"]);
  });

  test("保留的服务被强制 lifecycle lazy 与 directTools false", () => {
    const { config } = filterMcpConfig(fullConfig(), ["chrome-devtools"]);
    const server = config.mcpServers?.["chrome-devtools"];
    expect(server?.lifecycle).toBe("lazy");
    expect(server?.directTools).toBe(false);
  });

  test("settings 被强制 debug 与 autoAuth 为 false，其余键原样保留", () => {
    const { config } = filterMcpConfig(fullConfig(), ["context7"]);
    expect(config.settings).toEqual({ debug: false, autoAuth: false, custom: "x" });
  });

  test("原 settings 缺省时仍强制 debug 与 autoAuth 为 false", () => {
    const { config } = filterMcpConfig({ mcpServers: baseServers() }, ["context7"]);
    expect(config.settings).toEqual({ debug: false, autoAuth: false });
  });

  test("selected 为空数组时不保留任何服务且 missing 也为空", () => {
    const { config, missing } = filterMcpConfig(fullConfig(), []);
    expect(config.mcpServers ?? {}).toEqual({});
    expect(missing).toEqual([]);
  });

  test("返回配置的服务嵌套结构与入参不共享引用", () => {
    const original = baseServers();
    const { config } = filterMcpConfig({ mcpServers: original }, ["context7"]);
    (config.mcpServers?.context7?.args as string[]).push("--injected");
    expect(original.context7.args).toEqual(["--stdio"]);
  });
});

describe("checkMcpCall", () => {
  test("请求集合内服务允许通过", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "search", server: "context7" },
    });
    expect(result.allowed).toBe(true);
  });

  test("请求集合外服务被拒绝", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "call", server: "codegraph", tool: "codegraph_explore" },
    });
    expect(result.allowed).toBe(false);
  });

  test("未给 server 时按 tool 双下划线前缀推断", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "search", tool: "context7__docs_search" },
    });
    expect(result.allowed).toBe(true);
  });

  test("未给 server 时按 tool 单下划线前缀推断", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "search", tool: "context7_docs" },
    });
    expect(result.allowed).toBe(true);
  });

  test("推断不出 server 且 allowedServers 为空时拒绝", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: [],
      request: { mode: "search", tool: "mcp" },
    });
    expect(result.allowed).toBe(false);
  });

  test("显式 server 与 tool 前缀不一致时拒绝", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "codegraph__explore" },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/不一致|codegraph/);
  });

  test("review 角色对写文件参数的 call 请求拒绝并说明只读角色", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_write", args: { path: "/etc/passwd" } },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("只读角色");
  });

  test("review 角色对写文件参数的 search 请求不受限", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "search", server: "context7", args: { path: "/etc/passwd" } },
    });
    expect(result.allowed).toBe(true);
  });

  test("review 角色对不含敏感键的 call 请求允许通过", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_query", args: { query: "x" } },
    });
    expect(result.allowed).toBe(true);
  });

  test("work 角色对写文件参数的 call 请求不受只读限制", () => {
    const result = checkMcpCall({
      roleKind: "work",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_write", args: { file: "x" } },
    });
    expect(result.allowed).toBe(true);
  });

  test("acceptance 角色对含 output 键的 call 请求拒绝", () => {
    const result = checkMcpCall({
      roleKind: "acceptance",
      allowedServers: ["chrome-devtools"],
      request: { mode: "call", server: "chrome-devtools", tool: "chrome-devtools_run", args: { output: "y" } },
    });
    expect(result.allowed).toBe(false);
  });

  test("review 角色对含 content 键的 call 请求拒绝并说明只读角色", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_write", args: { content: "x" } },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("只读角色");
  });

  test("review 角色对同时含 text 与 dest 键的 call 请求拒绝", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_write", args: { text: "x", dest: "y" } },
    });
    expect(result.allowed).toBe(false);
  });

  test("review 角色对仅含 profile 键的 call 请求放行", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_read", args: { profile: "x" } },
    });
    expect(result.allowed).toBe(true);
  });

  test("review 角色对仅含 filePattern 键的 call 请求放行", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_read", args: { filePattern: "*.ts" } },
    });
    expect(result.allowed).toBe(true);
  });

  test("review 角色对仅含 projectPath 键的 call 请求放行", () => {
    const result = checkMcpCall({
      roleKind: "review",
      allowedServers: ["context7"],
      request: { mode: "call", server: "context7", tool: "context7_read", args: { projectPath: "/repo" } },
    });
    expect(result.allowed).toBe(true);
  });
});

describe("describeMcpStatus", () => {
  test("含已装载服务时文本包含已装载字样与服务名，且不含缺失字样", () => {
    const text = describeMcpStatus({ loaded: ["context7"], missing: [] });
    expect(text).toContain("已装载");
    expect(text).toContain("context7");
    expect(text).not.toContain("缺失");
  });

  test("含缺失服务时文本包含缺失字样与服务名", () => {
    const text = describeMcpStatus({ loaded: [], missing: ["codegraph"] });
    expect(text).toContain("缺失");
    expect(text).toContain("codegraph");
  });

  test("含 failure 时文本包含该原因", () => {
    const text = describeMcpStatus({ loaded: [], missing: [], failure: "入口加载失败" });
    expect(text).toContain("入口加载失败");
  });
});

describe("loadMcpForRole", () => {
  test("成功装载时把配置应用到假适配器并返回 loaded", async () => {
    resetCalls();
    const pi = createFakePi();
    const config = { mcpServers: { context7: { command: "context7-server" } } };
    const result = await loadMcpForRole({ pi, entryPath: FAKE_ENTRY, packageDir: FIXTURE_DIR, config });
    expect(result.failure).toBeUndefined();
    expect(result.loaded).toEqual(["context7"]);
    expect(pi.registeredTools.has("mcp")).toBe(true);
  });

  test("入口加载失败时不抛出，返回 loaded 为空并写明 failure", async () => {
    const pi = createFakePi();
    const result = await loadMcpForRole({ pi, entryPath: BROKEN_ENTRY, packageDir: dirname(BROKEN_ENTRY), config: { mcpServers: {} } });
    expect(result.loaded).toEqual([]);
    expect(result.failure).toBeTruthy();
  });

  test("importer 解析出的模块缺少 createMcpAdapter 时返回 loaded 为空并写明 failure", async () => {
    const pi = createFakePi();
    const result = await loadMcpForRole({
      pi,
      entryPath: "custom://missing-factory",
      packageDir: FIXTURE_DIR,
      config: { mcpServers: {} },
      importer: async () => ({ default: {} }),
    });
    expect(result.loaded).toEqual([]);
    expect(result.failure).toBeTruthy();
  });

  test("自定义 importer 收到原样 entryPath 并被实际调用", async () => {
    const pi = createFakePi();
    let receivedEntryPath: string | undefined;
    const result = await loadMcpForRole({
      pi,
      entryPath: "custom://stub-adapter",
      packageDir: FIXTURE_DIR,
      config: { mcpServers: { context7: { command: "x" } } },
      importer: async (path: string) => {
        receivedEntryPath = path;
        return {
          createMcpAdapter: () => (piApi: FakePi) => {
            piApi.registerTool({ name: "mcp", execute: async () => ({ content: [], details: undefined }) });
          },
        };
      },
    });
    expect(receivedEntryPath).toBe("custom://stub-adapter");
    expect(result.loaded).toEqual(["context7"]);
    expect(pi.registeredTools.has("mcp")).toBe(true);
  });

  test("扩展函数为 async 且 reject 时返回 failure 且不产生 unhandledRejection", async () => {
    const pi = createFakePi();
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await loadMcpForRole({
        pi,
        entryPath: FAKE_ENTRY,
      packageDir: FIXTURE_DIR,
        config: { mcpServers: {}, settings: { __fixtureAsyncReject: true } },
      });
      expect(result.loaded).toEqual([]);
      expect(result.failure).toContain("fixture async reject");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("importer 返回 null 时不抛出，返回 loaded 为空并写明 failure", async () => {
    const pi = createFakePi();
    const result = await loadMcpForRole({
      pi,
      entryPath: "custom://null-module",
      packageDir: FIXTURE_DIR,
      config: { mcpServers: {} },
      importer: async () => null,
    });
    expect(result.loaded).toEqual([]);
    expect(result.failure).toBeTruthy();
  });

  test("importer 返回非对象时不抛出，返回 loaded 为空并写明 failure", async () => {
    const pi = createFakePi();
    const result = await loadMcpForRole({
      pi,
      entryPath: "custom://string-module",
      packageDir: FIXTURE_DIR,
      config: { mcpServers: {} },
      importer: async () => "not-a-module",
    });
    expect(result.loaded).toEqual([]);
    expect(result.failure).toBeTruthy();
  });

  test("勾选服务含 disabled 服务时结果含 missing，且贯通不依赖单独调用 filterMcpConfig", async () => {
    resetCalls();
    const pi = createFakePi();
    const result = (await loadMcpForRole({
      pi,
      entryPath: FAKE_ENTRY,
      packageDir: FIXTURE_DIR,
      config: { mcpServers: baseServers() },
      selected: ["context7", "codegraph"],
    }));
    expect(result.loaded).toEqual(["context7"]);
    expect(result.missing).toEqual(["codegraph"]);
    const text = describeMcpStatus({ loaded: result.loaded, missing: result.missing ?? [], failure: result.failure });
    expect(text).toContain("缺失");
    expect(text).toContain("codegraph");
  });

  test("entryPath 经 realpath 后越出 packageDir 时不 import 并返回 failure", async () => {
    const pi = createFakePi();
    const result = await loadMcpForRole({
      pi,
      entryPath: BROKEN_ENTRY,
      config: { mcpServers: {} },
      packageDir: FIXTURE_DIR,
    });
    expect(result.loaded).toEqual([]);
    expect(result.failure).toContain("越出");
  });

  test("entryPath 在 packageDir 内时正常装载", async () => {
    resetCalls();
    const pi = createFakePi();
    const config = { mcpServers: { context7: { command: "context7-server" } } };
    const result = await loadMcpForRole({
      pi,
      entryPath: FAKE_ENTRY,
      config,
      packageDir: FIXTURE_DIR,
    });
    expect(result.failure).toBeUndefined();
    expect(result.loaded).toEqual(["context7"]);
  });
});

describe("按角色装载并通过三类入口拦截", () => {
  test("worker 只能发现与调用 context7", async () => {
    resetCalls();
    const pi = createFakePi();
    const { config } = filterMcpConfig({ mcpServers: baseServers() }, ["context7"]);
    const loadResult = await loadMcpForRole({ pi, entryPath: FAKE_ENTRY, packageDir: FIXTURE_DIR, config });
    expect(loadResult.loaded).toEqual(["context7"]);
    wireCheckMcpCall(pi, "work", ["context7"]);

    const allowed = await simulateToolCall(pi, { tool: "context7_docs", server: "context7", search: "x" });
    expect(allowed.blocked).toBe(false);

    const deniedChrome = await simulateToolCall(pi, {
      tool: "chrome-devtools_run",
      server: "chrome-devtools",
      search: "x",
    });
    expect(deniedChrome.blocked).toBe(true);

    const deniedCodegraph = await simulateToolCall(pi, { tool: "codegraph_explore", server: "codegraph", search: "x" });
    expect(deniedCodegraph.blocked).toBe(true);

    expect(calls).toEqual([{ server: "context7", tool: "context7_docs", mode: "search" }]);
  });

  test("acceptance 只能发现与调用 chrome-devtools", async () => {
    resetCalls();
    const pi = createFakePi();
    const { config } = filterMcpConfig({ mcpServers: baseServers() }, ["chrome-devtools"]);
    await loadMcpForRole({ pi, entryPath: FAKE_ENTRY, packageDir: FIXTURE_DIR, config });
    wireCheckMcpCall(pi, "acceptance", ["chrome-devtools"]);

    const allowed = await simulateToolCall(pi, { tool: "chrome-devtools_run", server: "chrome-devtools", describe: "run" });
    expect(allowed.blocked).toBe(false);

    const denied = await simulateToolCall(pi, { tool: "context7_docs", server: "context7", describe: "docs" });
    expect(denied.blocked).toBe(true);

    expect(calls).toEqual([{ server: "chrome-devtools", tool: "chrome-devtools_run", mode: "describe" }]);
  });

  test("reviewer 未勾选任何服务时没有可用 MCP，codegraph 也无法访问", async () => {
    resetCalls();
    const pi = createFakePi();
    const { config } = filterMcpConfig({ mcpServers: baseServers() }, []);
    const loadResult = await loadMcpForRole({ pi, entryPath: FAKE_ENTRY, packageDir: FIXTURE_DIR, config });
    expect(loadResult.loaded).toEqual([]);
    wireCheckMcpCall(pi, "review", []);

    const deniedContext7 = await simulateToolCall(pi, { tool: "context7_docs", server: "context7", search: "x" });
    expect(deniedContext7.blocked).toBe(true);

    const deniedCodegraph = await simulateToolCall(pi, { tool: "codegraph_explore", server: "codegraph", search: "x" });
    expect(deniedCodegraph.blocked).toBe(true);

    expect(calls).toEqual([]);
  });
});

async function startSession(extensionFactory: InlineExtension) {
  const tempHome = await createTempHome();
  tempHomes.push(tempHome);
  const cwd = await mkdtemp(join(tmpdir(), "mcp-discovery-cwd-"));
  tempRoots.push(cwd);
  await mkdir(cwd, { recursive: true });

  const runtime = await ModelRuntime.create({
    authPath: join(tempHome.agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const provider = registerControlledProvider(runtime, { providerId: "controlled", modelId: "controlled-model" });
  const model = runtime.getModels(provider.providerId)[0];

  const loader = new DefaultResourceLoader({ cwd, agentDir: tempHome.agentDir, extensionFactories: [extensionFactory] });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: tempHome.agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
  });

  return { session, provider };
}

function buildRoleExtension(options: {
  entryPath: string;
  config: unknown;
  roleKind: "plan" | "work" | "review" | "acceptance" | "manage";
  allowedServers: string[];
  onLoaded?: (result: { loaded: string[]; missing: string[]; failure?: string }) => void;
}): InlineExtension {
  return async (pi: ExtensionAPI) => {
    const result = await loadMcpForRole({ pi, entryPath: options.entryPath, packageDir: dirname(options.entryPath), config: options.config as McpConfig });
    options.onLoaded?.(result);
    wireCheckMcpCall(pi, options.roleKind, options.allowedServers);
  };
}

describe("真实 SDK 会话集成", () => {
  test("会话中请求集合外服务被真实 SDK 拦截，假适配器未被调用", async () => {
    resetCalls();
    const { config } = filterMcpConfig({ mcpServers: baseServers() }, ["context7"]);
    const extensionFactory = buildRoleExtension({
      entryPath: FAKE_ENTRY,
      config,
      roleKind: "work",
      allowedServers: ["context7"],
    });
    const { session, provider } = await startSession(extensionFactory);

    scriptReplies(provider, [
      { type: "toolcall", name: "mcp", input: { tool: "codegraph_explore", server: "codegraph" } },
      { type: "text", text: "done" },
    ]);

    await session.prompt("go");
    await session.waitForIdle();

    const toolResult = session.messages.find((message) => message.role === "toolResult");
    expect(toolResult?.isError).toBe(true);
    const lastMessage = session.messages.at(-1);
    expect(lastMessage?.role).toBe("assistant");
    expect(calls.length).toBe(0);
  }, 20000);

  test("入口加载失败时会话仍可创建，loadMcpForRole 报告 failure", async () => {
    let captured: { loaded: string[]; missing: string[]; failure?: string } | undefined;
    const extensionFactory: InlineExtension = async (pi: ExtensionAPI) => {
      captured = await loadMcpForRole({ pi, entryPath: BROKEN_ENTRY, packageDir: dirname(BROKEN_ENTRY), config: { mcpServers: {} } });
    };
    const { session, provider } = await startSession(extensionFactory);

    expect(captured?.loaded).toEqual([]);
    expect(captured?.failure).toBeTruthy();
    expect(
      describeMcpStatus({ loaded: captured?.loaded ?? [], missing: captured?.missing ?? [], failure: captured?.failure }),
    ).toContain(captured?.failure ?? "");

    scriptReplies(provider, [{ type: "text", text: "ok" }]);
    await session.prompt("hi");
    await session.waitForIdle();

    const lastMessage = session.messages.at(-1);
    expect(lastMessage?.role).toBe("assistant");
  }, 20000);
});

describe("参数形状、服务推断、入口校验与配置克隆的边界", () => {
  const base = { roleKind: "review" as const, allowedServers: ["context7", "context7_docs"] };
  test("数组或字符串形式的 args 被只读角色拒绝", () => {
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: ["--output", "/etc/x"] } }).allowed).toBe(false);
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: "--output /etc/x" } }).allowed).toBe(false);
  });
  test("白名单键下的嵌套对象同样按白名单判定", () => {
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: { query: { write: "/etc/x" } } } }).allowed).toBe(false);
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: { query: { pattern: "*.ts" }, paths: ["a", "b"] } } }).allowed).toBe(true);
  });
  test("工具名无法推断服务时即使声明了 server 也拒绝", () => {
    const result = checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "mcp" } });
    expect(result.allowed).toBe(false);
  });
  test("带下划线的服务名按最长前缀匹配", () => {
    expect(checkMcpCall({ ...base, request: { mode: "call", tool: "context7_docs__search" } }).allowed).toBe(true);
  });
  test("白名单不含 args 与 url，携带者被只读角色拒绝", () => {
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: { args: ["-o", "/etc/x"] } } }).allowed).toBe(false);
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: { url: "file:///etc/x" } } }).allowed).toBe(false);
    expect(checkMcpCall({ ...base, request: { mode: "call", server: "context7", tool: "context7__x", args: { query: { query: { args: ["-o"] } } } } }).allowed).toBe(false);
  });

  test("相对路径入口即使注入 importer 也被拒绝，伪协议入口才豁免", async () => {
    const relative = await loadMcpForRole({ pi: {}, entryPath: "../../../../etc/passwd", packageDir: FIXTURE_DIR, config: { mcpServers: {} }, importer: async () => ({}) });
    expect(relative.loaded).toEqual([]);
    expect(relative.failure).toContain("绝对路径");
    for (const entryPath of ["file:///etc/passwd", "https://evil.example/x.js"]) {
      const schemed = await loadMcpForRole({ pi: {}, entryPath, packageDir: FIXTURE_DIR, config: { mcpServers: {} }, importer: async () => ({}) });
      expect(schemed.failure).toContain("绝对路径");
    }
    const missingPkg = await loadMcpForRole({ pi: {}, entryPath: FAKE_ENTRY, packageDir: "", config: { mcpServers: {} } });
    expect(missingPkg.failure).toContain("packageDir");
  });

  test("配置含不可克隆值时返回 failure 而不抛出", async () => {
    const result = await loadMcpForRole({ pi: {}, entryPath: FAKE_ENTRY, packageDir: FIXTURE_DIR, config: { mcpServers: {}, settings: { cb: () => {} } } as McpConfig, selected: [] });
    expect(result.failure).toBeTruthy();
  });

  test("filterMcpConfig 的 settings 不与入参共享引用", () => {
    const full = { mcpServers: { a: { command: "x" } }, settings: { nested: { flag: true } } } as McpConfig;
    const out = filterMcpConfig(full, ["a"]);
    ((out.config.settings as Record<string, unknown>).nested as Record<string, unknown>).flag = false;
    expect(((full.settings as Record<string, unknown>).nested as Record<string, unknown>).flag).toBe(true);
  });
});
