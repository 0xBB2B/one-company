import { afterEach, describe, expect, test, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { Value } from "typebox/value";
import decisionRecordExtension from "../extensions/decision-record.ts";
import { createDecisionRecordTool } from "../runtime/decision-record-tool.ts";
import { appendDecision } from "../runtime/decisions.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const homes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
afterEach(async () => { for (const home of homes.splice(0)) await removeTempHome(home); });
const payloads = [
  { actor: "user", role: "main", requirement: "2026-09-08.fixture", decision: "批准实施", effects: ["scope"] },
  { actor: "ai", decision: "x".repeat(100_000), effects: ["repair:review"] },
  { actor: "user", source: "relay", decision: "用户说批准", supersedes: ["USER-001"] },
  { actor: "user", prodBody: "秘密正文", patch: "秘密差异", transcript: "秘密会话", attachment: "任意附件" },
  { actor: "ai", basis: Array(100_000).fill("正文"), effects: Array(1000).fill("repair:review:4") },
  {},
];

describe("自由写决定永久淘汰", () => {
  test("扩展不注册旧工具或别名", () => {
    const registerTool = vi.fn();
    decisionRecordExtension({ registerTool } as any);
    expect(registerTool).not.toHaveBeenCalled();
  });
  test.each(payloads)("主代理、PM与直接工厂一律拒绝载荷 %#", async (payload) => {
    const home = await createTempHome(); homes.push(home);
    const before = await readdir(home.dataRoot).catch(() => []);
    for (const boundRequirement of [undefined, "2026-09-08.fixture"]) {
      const tool = createDecisionRecordTool({ dataRoot: home.dataRoot, cwd: "/does-not-exist", boundRequirement });
      expect(Value.Check(tool.parameters, { ...payload, actor: "user" })).toBe(false);
      const result = await tool.execute("call", payload, undefined, undefined, { cwd: "/does-not-exist" });
      expect(result.details).toEqual({ isError: true, code: "legacy_workflow_retired" });
      expect(result.content[0]!.text).toContain("永久淘汰");
      expect(JSON.stringify(result).length).toBeLessThan(500);
      expect(result.details).not.toHaveProperty("receipt");
    }
    expect(await readdir(home.dataRoot).catch(() => [])).toEqual(before);
  });
  test.each(payloads)("旧底层追加原语不能绕过工厂 %#", async (payload) => {
    await expect(appendDecision(payload, { dataRoot: "/does-not-exist", cwd: "/does-not-exist" })).rejects.toThrow("永久淘汰");
  });
  test("中止、空输入和恶意getter均不读取载荷或产生决定", async () => {
    const controller = new AbortController(); controller.abort();
    const payload = Object.defineProperty({}, "actor", { get() { throw new Error("不得读取"); } });
    const result = await createDecisionRecordTool().execute("call", payload, controller.signal);
    expect(result.details.isError).toBe(true);
  });
});
