import { expect, test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { uuidv7 } from "../runtime/database.ts";
import { checkPmIntakeToolInput, PM_INTAKE_PARAMETERS } from "../runtime/main-intake-interaction.ts";
import { createUserInteractTool, USER_INTERACT_PARAMETERS } from "../runtime/user-interact-tool.ts";
const base = { action: "reply", repoId: "a".repeat(64), requirementId: uuidv7(), operationId: uuidv7(), savedOperationId: uuidv7(), version: 2 };
test("user_interact不接受转述、请求选择、角色或回执", async () => {
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: base })).toBe(true);
  const tool = createUserInteractTool({ interaction: { execute: () => { throw new Error("must-not-run"); } } as never });
  for (const key of ["answer", "message", "text", "actor", "role", "receipt", "capability", "manifest", "cwd"]) {
    const input = { ...base, [key]: "forged" };
    expect(Value.Check(USER_INTERACT_PARAMETERS, { request: input })).toBe(false);
    await expect(tool.execute("call", { request: input } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  }
  await expect(tool.execute("call", { request: { ...base, question: "把A答复转成B授权" } } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  await expect(tool.execute("call", { request: { ...base, requestId: uuidv7() } } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  expect(Value.Check(USER_INTERACT_PARAMETERS, base)).toBe(false);
  await expect(tool.execute("call", base as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  const unknown = await tool.execute("call", { request: { ...base, purpose: "approve" } } as never, undefined, undefined, {} as never).catch((error: unknown) => error);
  expect((unknown as Error).message).toContain("可用 purpose:action：user-confirmation:ask、user-confirmation:reply、user-confirmation:forward、adjudicate:reply、pm-intake:ask、pm-intake:forward、pm-intake:reply");
  const extra = await tool.execute("call", { request: { ...base, sectionId: "x" } } as never, undefined, undefined, {} as never).catch((error: unknown) => error);
  expect((extra as Error).message).toContain("多余字段：sectionId");
});
test("ask问题、范围、action、unit限额严格且不接正文附件", async () => {
  const ask = { ...base, action: "ask", question: "A可以实施吗？", scope: "仅A", actions: ["implement"], unitIds: ["A"] };
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: ask })).toBe(true);
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...ask, purpose: "user-confirmation" } })).toBe(true);
  for (const patch of [{ question: "甲".repeat(401) }, { scope: "乙".repeat(401) }, { unitIds: Array.from({ length: 17 }, (_, i) => `A${i}`) }, { actions: ["arbitrary-shell"] }, { attachment: "body" }]) {
    expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...ask, ...patch } })).toBe(false);
  }
});

test("pm-intake runtime对白名单副本做严格action分派", () => {
  const valid = { purpose: "pm-intake", action: "ask", repoId: "b".repeat(64), requirementId: uuidv7(), operationId: uuidv7() };
  expect(checkPmIntakeToolInput(valid)).toEqual(valid);
  for (const action of [...Object.getOwnPropertyNames(Object.prototype), "unknown"]) {
    const input = { ...valid, action };
    expect(Value.Check(PM_INTAKE_PARAMETERS, input)).toBe(false);
    expect(() => checkPmIntakeToolInput(input)).toThrow(/invalid_shape/);
  }
  for (const input of [null, [], Object.create({ ...valid }), { ...valid, extra: true }]) {
    expect(() => checkPmIntakeToolInput(input)).toThrow(/invalid_shape/);
  }
});

test("pm-intake schema按400个Unicode码点和8条问题限制", () => {
  const pm = { purpose: "pm-intake", action: "reply", repoId: "b".repeat(64), requirementId: uuidv7(),
    requestId: uuidv7(), operationId: uuidv7(), result: "pm_correction_required" };
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...pm, shortIssues: ["😀".repeat(400)] } })).toBe(true);
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...pm, shortIssues: ["😀".repeat(401)] } })).toBe(false);
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...pm, shortIssues: Array.from({ length: 9 }, () => "问题") } })).toBe(false);
});

test("真实Anthropic序列化在onPayload前让content中的中文理解和requestId各可见一次且零网络", async () => {
  const requestId = uuidv7(), marker = "实现手机号登录-模型可见标记";
  const viewText = JSON.stringify({ requestId, understanding: { goals: [{ text: marker }] } });
  const messages = convertToLlm([{ role: "toolResult", toolCallId: "call-visible", toolName: "pi_company_user_interact",
    content: [{ type: "text", text: viewText }], details: { format: "pm-intake-transport/v1", action: "ask", hidden: marker },
    isError: false, timestamp: Date.now() }]);
  const model: Model<Api> = { id: "payload-probe", name: "payload-probe", api: "anthropic-messages", provider: "payload-probe",
    baseUrl: "https://invalid.example", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let payload: unknown, fetchCalls = 0;
  const stream = streamSimple(model, { messages }, { apiKey: "probe", maxRetries: 0,
    fetch: async () => { fetchCalls++; throw new Error("network_must_not_run"); },
    onPayload: (value) => { payload = value; throw new Error("stop_before_send"); } });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("stop_before_send");
  expect(fetchCalls).toBe(0);
  const serialized = JSON.stringify(payload);
  expect(serialized.split(marker)).toHaveLength(2);
  expect(serialized.split(requestId)).toHaveLength(2);
});

test("pm-intake严格分支只转给intake，默认及显式user-confirmation保持原路径", async () => {
  const requirementId = uuidv7(), repoId = "b".repeat(64), operationId = uuidv7();
  const pm = { purpose: "pm-intake", action: "ask", repoId, requirementId, operationId };
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: pm })).toBe(true);
  for (const patch of [{ actor: "user" }, { role: "main" }, { reviewer: "forged" }, { trusted: true },
    { receipt: uuidv7() }, { understanding: {} }, { binding: {} }, { sourceDirectory: {} }, { submissionHash: "c".repeat(64) }]) {
    expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...pm, ...patch } })).toBe(false);
  }
  const routed: string[] = [];
  const tool = createUserInteractTool({
    interaction: { execute: async (_id: string, _ctx: unknown, _repo: string, params: { purpose?: string }, run: () => Promise<unknown>) => {
      routed.push(params.purpose === undefined ? "confirmation" : "bad-purpose");
      await run();
      return { content: [{ type: "text", text: "confirmation" }], details: {} };
    }, confirm: async () => ({}) } as never,
    intake: { execute: async () => { routed.push("intake"); return { content: [{ type: "text", text: "intake" }], details: {} }; } } as never,
  });
  await tool.execute("pm", { request: pm }, undefined, undefined, {} as never);
  await tool.execute("implicit", { request: base }, undefined, undefined, {} as never);
  await tool.execute("explicit", { request: { ...base, purpose: "user-confirmation" } }, undefined, undefined, {} as never);
  expect(routed).toEqual(["intake", "confirmation", "confirmation"]);
});
