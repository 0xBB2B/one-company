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
  expect((unknown as Error).message).toContain("可用 purpose:action：user-confirmation:ask、user-confirmation:reply、user-confirmation:forward、adjudicate:reply、panel-item:ask、pm-intake:ask、pm-intake:forward、pm-intake:reply");
  const extra = await tool.execute("call", { request: { ...base, sectionId: "x" } } as never, undefined, undefined, {} as never).catch((error: unknown) => error);
  expect((extra as Error).message).toContain("多余字段：sectionId");
});
const CHOICES = [{ label: "实施 A", reason: "马上能用", recommended: true, recommendedReason: "A 已写清楚" }, { label: "先不实施", reason: "等 B 一起做" }];
test("ask问题、范围、action限额严格，章节数不设单独上限，且不接正文附件", async () => {
  const ask = { ...base, action: "ask", question: "A可以实施吗？", rootCheck: "要定的是 A 何时实施", choices: CHOICES, scope: "仅A", actions: ["implement"], unitIds: ["A"] };
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: ask })).toBe(true);
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...ask, purpose: "user-confirmation" } })).toBe(true);
  expect(Value.Check(USER_INTERACT_PARAMETERS, { request: { ...ask, unitIds: Array.from({ length: 25 }, (_, i) => `A${i}`) } })).toBe(true);
  for (const patch of [{ question: "甲".repeat(401) }, { scope: "乙".repeat(401) }, { actions: ["arbitrary-shell"] }, { attachment: "body" }]) {
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
  const messages = convertToLlm([{ role: "toolResult", toolCallId: "call-visible", toolName: "one_company_user_interact",
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

test("M8D-AC9：登记问题缺根源自检、选项数量不对、没有推荐或推荐了多个、推荐项缺理由、拼起来超长，都被拒绝并写明缺了什么", async () => {
  const tool = createUserInteractTool({ interaction: { execute: () => { throw new Error("must-not-run"); } } as never });
  const ask = { ...base, action: "ask", question: "A可以实施吗？", rootCheck: "要定的是 A 何时实施", choices: CHOICES, scope: "仅A", actions: ["implement"], unitIds: ["A"] };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ rootCheck: undefined }, "缺少根源自检（rootCheck）"],
    [{ rootCheck: " " }, "缺少根源自检（rootCheck）"],
    [{ choices: undefined }, "缺少选项（choices）：要给 2 到 4 个选项"],
    [{ choices: [CHOICES[0]] }, "选项要 2 到 4 个，现在是 1 个"],
    [{ choices: [...CHOICES, ...CHOICES.slice(1), ...CHOICES.slice(1), ...CHOICES.slice(1)] }, "选项要 2 到 4 个，现在是 5 个"],
    [{ choices: [{ ...CHOICES[0], recommended: undefined, recommendedReason: undefined }, CHOICES[1]] }, "没有标出推荐项：要恰好推荐一个选项"],
    [{ choices: [CHOICES[0], { ...CHOICES[1], recommended: true, recommendedReason: "也行" }] }, "推荐了 2 个选项，只能推荐一个"],
    [{ choices: [{ ...CHOICES[0], recommendedReason: undefined }, CHOICES[1]] }, "推荐项缺少推荐理由（recommendedReason）"],
    [{ choices: [CHOICES[0], { ...CHOICES[1], reason: "" }] }, "第 2 个选项缺少理由（reason）"],
    [{ choices: [CHOICES[0], { ...CHOICES[1], recommendedReason: "x" }] }, "第 2 个选项不是推荐项，不能写推荐理由"],
    [{ question: "问".repeat(380) }, "个字，超过 400 个字，请精简"],
  ];
  for (const [patch, text] of cases) {
    const error = await tool.execute("call", { request: { ...ask, ...patch } } as never, undefined, undefined, {} as never).catch((caught: unknown) => caught);
    expect(error, text).toMatchObject({ code: "question_format" });
    expect((error as Error).message, text).toContain("原因：问题没有按要求写全：");
    expect((error as Error).message, text).toContain(text);
  }
});

const renderTheme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };
function rendered(result: { details?: unknown; content?: Array<{ type: "text"; text: string }> } | undefined, isError = false) {
  const tool = createUserInteractTool({ interaction: {} as never });
  const args = { request: { ...base, action: "ask", question: "起跳时机怎么定？", rootCheck: "根源", choices: [
    { label: "松开空格时起跳", reason: "符合描述", recommended: true, recommendedReason: "初速度才由按住时长决定" }, { label: "按下立即起跳", reason: "手感即时" }], scope: "仅起跳", actions: [], unitIds: ["A"] } };
  const state: Record<string, unknown> = {};
  const context = { args, state, isError, invalidate: () => {} } as never;
  const lines = () => [
    ...tool.renderCall!(args as never, renderTheme as never, context).render(80),
    ...(result ? tool.renderResult!({ content: result.content ?? [], details: result.details } as never, { expanded: false, isPartial: false }, renderTheme as never, context).render(80) : []),
  ].map((line) => line.trimEnd());
  lines();
  return lines();
}

test("M8D-AC9：对话里的提问记录块：登记中显示问题；回答后显示需求名、问题与回答，推荐项标绿色推荐，自己输入与暂不回答分别写明", () => {
  expect(rendered(undefined)).toEqual(["<b>提问</b>  <muted>起跳时机怎么定？</>"]);
  const caption = "按住空格时长控制跳跃高度（第 2 版）";
  expect(rendered({ details: { caption, question: "起跳时机怎么定？", status: "answered", answer: { text: "选第 1 项：松开空格时起跳（推荐）", choice: 1 } } })).toEqual([
    `<b>提问</b>  <muted>${caption}</>`, "", "起跳时机怎么定？", "<muted>你的回答  </>1. 松开空格时起跳<success>（推荐）</>"]);
  expect(rendered({ details: { caption, question: "起跳时机怎么定？", status: "answered", answer: { text: "按下立即起跳", other: true } } }).at(-1))
    .toBe("<muted>你的回答  </>按下立即起跳<muted>（自己输入）</>");
  expect(rendered({ details: { caption, question: "起跳时机怎么定？", status: "pending", answer: null } }).at(-1)).toBe("<muted>你暂不回答，问题保留。</>");
  expect(rendered({ content: [{ type: "text", text: "one_company_user_interact 的 ask 动作失败。\n原因：问题没有按要求写全：没有标出推荐项\n建议：按原因补全后重新登记问题" }] }, true).at(-1))
    .toBe("<error>没有登记：问题没有按要求写全：没有标出推荐项</>");
});

test("M8D-AC9：提问以外的动作不改显示，交给 pi 的默认样式", () => {
  const tool = createUserInteractTool({ interaction: {} as never });
  const context = { args: { request: base }, state: {}, isError: false, invalidate: () => {} } as never;
  expect(() => tool.renderCall!({ request: base } as never, renderTheme as never, context)).toThrow();
  expect(() => tool.renderResult!({ content: [], details: {} } as never, { expanded: false, isPartial: false }, renderTheme as never, context)).toThrow();
});
