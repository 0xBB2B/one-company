import { expect, test } from "vitest";
import { Type } from "typebox";
import { leanToolResult } from "../src/core/exec/tool-result.ts";
import { toPiTool } from "../src/modules/agents/role-tools.ts";

type Run = (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;

function run(runtime: object, params: unknown) {
  return (toPiTool("plan_manage", "计划", Type.Object({}), runtime as never).execute as unknown as Run)("t", params);
}

test("视图和完整结果不同时，content 只含视图字段，details 是完整结果", () => {
  const result = leanToolResult({ runId: "r1", fence: 3 }, { runId: "r1" });
  expect(result.content).toEqual([{ type: "text", text: '{"runId":"r1"}' }]);
  expect(result.details).toEqual({ runId: "r1", fence: 3 });
});

test("视图是字符串时 content 就是这句话本身，没有外层引号", () => {
  const result = leanToolResult("用户选择保留，没有移除", "用户选择保留，没有移除");
  expect(result.content[0].text).toBe("用户选择保留，没有移除");
  expect(result.details).toBe("用户选择保留，没有移除");
});

test("完整结果和视图都是 undefined 时 content 写 null", () => {
  const result = leanToolResult(undefined, undefined);
  expect(result.content[0].text).toBe("null");
  expect(result.details).toBeNull();
});

test("toPiTool 的 view 能拿到完整结果和这次的调用参数", async () => {
  const runtime = {
    execute: () => ({ a: 1, hash: "x" }),
    view: (r: unknown, p: unknown) => ({ a: (r as { a: number }).a, action: (p as { action?: string }).action ?? null }),
    dispose() {},
  };
  const result = await run(runtime, { action: "read" });
  expect(result.content[0].text).toBe('{"a":1,"action":"read"}');
  expect(result.details).toEqual({ a: 1, hash: "x" });
});

test("toPiTool 不传 view 时发给模型的文字和改前逐字相同，details 是完整结果", async () => {
  const result = await run({ execute: () => ({ a: 1, hash: "x" }), dispose() {} }, {});
  expect(result.content[0].text).toBe(JSON.stringify({ a: 1, hash: "x" }));
  expect(result.details).toEqual({ a: 1, hash: "x" });
});

test("toPiTool 遇到工具返回 undefined 且不传 view 时 content 写 null", async () => {
  const result = await run({ execute: () => undefined, dispose() {} }, {});
  expect(result.content[0].text).toBe("null");
});
