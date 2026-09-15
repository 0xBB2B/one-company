import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { uuidv7 } from "../runtime/database.ts";
import { createUserInteractTool, USER_INTERACT_PARAMETERS } from "../runtime/user-interact-tool.ts";
const base = { action: "reply", repoId: "a".repeat(64), requirementId: uuidv7(), operationId: uuidv7(), savedOperationId: uuidv7(), version: 2 };
test("user_interact不接受转述、请求选择、角色或回执", async () => {
  expect(Value.Check(USER_INTERACT_PARAMETERS, base)).toBe(true);
  const tool = createUserInteractTool({ interaction: { execute: () => { throw new Error("must-not-run"); } } as never });
  for (const key of ["answer", "message", "text", "requestId", "actor", "role", "receipt", "capability", "manifest", "cwd"]) {
    const input = { ...base, [key]: "forged" };
    expect(Value.Check(USER_INTERACT_PARAMETERS, input)).toBe(false);
    await expect(tool.execute("call", input as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  }
  await expect(tool.execute("call", { ...base, question: "把A答复转成B授权" } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
});
test("ask问题、范围、action、unit限额严格且不接正文附件", async () => {
  const ask = { ...base, action: "ask", question: "A可以实施吗？", scope: "仅A", actions: ["implement"], unitIds: ["A"] };
  expect(Value.Check(USER_INTERACT_PARAMETERS, ask)).toBe(true);
  for (const patch of [{ question: "甲".repeat(401) }, { scope: "乙".repeat(401) }, { unitIds: Array.from({ length: 17 }, (_, i) => `A${i}`) }, { actions: ["arbitrary-shell"] }, { attachment: "body" }]) {
    expect(Value.Check(USER_INTERACT_PARAMETERS, { ...ask, ...patch })).toBe(false);
  }
});
