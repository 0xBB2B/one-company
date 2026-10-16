import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeMcpStatus, registerMcpServers } from "../src/modules/agents/mcp.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function configFile(content: string): Promise<string> {
  const dir = await mkdtemp("/tmp/pi-t-");
  cleanup.push(dir);
  const path = join(dir, "mcp.json");
  await writeFile(path, content);
  return path;
}

function recorder(reject: Record<string, string> = {}) {
  const registered: Array<{ name: string; config: unknown }> = [];
  return {
    registered,
    pi: { registerMcpServer(name: string, config: unknown) {
      if (reject[name]) throw new Error(reject[name]);
      registered.push({ name, config });
    } },
  };
}

describe("registerMcpServers", () => {
  test("只注册定义点名且未停用的服务，配置原样交给 pi", async () => {
    const path = await configFile(JSON.stringify({ mcpServers: {
      docs: { command: "node", args: ["server.mjs"], directTools: true },
      off: { command: "x", enabled: false },
      other: { url: "https://example.com/mcp" },
    } }));
    const { pi, registered } = recorder();
    expect(registerMcpServers(pi, path, ["docs", "off", "absent"])).toEqual({ loaded: ["docs"], missing: ["off", "absent"], failures: [] });
    expect(registered).toEqual([{ name: "docs", config: { command: "node", args: ["server.mjs"], directTools: true } }]);
  });

  test("pi 拒绝某个服务的配置时写明服务名与原因，其余服务照常注册", async () => {
    const path = await configFile(JSON.stringify({ mcpServers: { bad: { foo: 1 }, docs: { command: "x" } } }));
    const { pi, registered } = recorder({ bad: 'server "bad" needs either "command" (stdio) or "url" (streamable HTTP)' });
    expect(registerMcpServers(pi, path, ["bad", "docs"])).toEqual({ loaded: ["docs"], missing: [],
      failures: ['bad：server "bad" needs either "command" (stdio) or "url" (streamable HTTP)'] });
    expect(registered.map((entry) => entry.name)).toEqual(["docs"]);
  });

  test("mcp.json 不存在时点名的服务都算缺失", async () => {
    const dir = await mkdtemp("/tmp/pi-t-");
    cleanup.push(dir);
    const { pi } = recorder();
    expect(registerMcpServers(pi, join(dir, "mcp.json"), ["docs"])).toEqual({ loaded: [], missing: ["docs"], failures: [] });
  });

  test("mcp.json 写错时不注册任何服务并写明文件与原因", async () => {
    const path = await configFile("{ not json");
    const { pi, registered } = recorder();
    const result = registerMcpServers(pi, path, ["docs"]);
    expect(result.loaded).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(`读取 ${path} 失败`);
    expect(registered).toEqual([]);
  });

  test("没有点名任何服务时不读取配置", () => {
    const { pi } = recorder();
    expect(registerMcpServers(pi, "/nonexistent/mcp.json", [])).toEqual({ loaded: [], missing: [], failures: [] });
  });
});

describe("describeMcpStatus", () => {
  test("没有点名服务时保持原文", () => {
    expect(describeMcpStatus({ loaded: [], missing: [], failures: [] })).toBe("未装载任何 MCP 服务");
  });

  test("列出已装载、缺失与失败原因，并说明工具名形式", () => {
    const text = describeMcpStatus({ loaded: ["docs"], missing: ["off"], failures: ["bad：配置无效"] });
    expect(text).toContain("已装载 docs");
    expect(text).toContain("缺失 off");
    expect(text).toContain("bad：配置无效");
    expect(text).toContain("mcp__<服务名>__<工具名>");
  });
});
