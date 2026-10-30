import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import {
  acceptSuggestion,
  recentRounds,
  requestSuggestion,
  suggestionThinking,
} from "../src/modules/input-suggestion/suggestion-model.ts";

let seq = 0;
function userEntry(text: string): any {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: null,
    timestamp: "2026-10-30T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: seq },
  };
}
function stringUserEntry(text: string): any {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: null,
    timestamp: "2026-10-30T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: seq },
  };
}
function assistantEntry(content: unknown[]): any {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: null,
    timestamp: "2026-10-30T00:00:00.000Z",
    message: { role: "assistant", content, timestamp: seq },
  };
}
function textReply(text: string): any {
  return assistantEntry([{ type: "text", text }]);
}
function toolResultEntry(text: string): any {
  seq += 1;
  return {
    type: "message",
    id: `e${seq}`,
    parentId: null,
    timestamp: "2026-10-30T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: seq,
    },
  };
}
function customEntry(text: string): any {
  seq += 1;
  return {
    type: "custom_message",
    id: `e${seq}`,
    parentId: null,
    timestamp: "2026-10-30T00:00:00.000Z",
    customType: "x",
    content: text,
    display: true,
  };
}

function model(over: Record<string, unknown> = {}): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "p",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
    ...over,
  } as Model<Api>;
}

function reply(text: string, stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    provider: "p",
    model: "m",
    api: "openai-completions",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  } as AssistantMessage;
}

function fakeRegistry(text = "好的", stopReason = "stop") {
  return {
    hasConfiguredAuth: vi.fn(() => true),
    complete: vi.fn(async () => reply(text, stopReason)),
    streamSimple: vi.fn(() => ({ result: async () => reply(text, stopReason) })),
  };
}

function contextText(context: any): string {
  const parts: string[] = [];
  if (typeof context.systemPrompt === "string") parts.push(context.systemPrompt);
  for (const m of context.messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else for (const b of m.content) if (b.type === "text") parts.push(b.text);
  }
  return parts.join("\n");
}

const rounds = [
  { user: "第一问ALPHA", assistant: "第一答BRAVO" },
  { user: "第二问CHARLIE", assistant: "第二答DELTA" },
];

const run = (registry: any, over: Record<string, unknown> = {}) =>
  requestSuggestion({
    registry,
    model: model(),
    rounds,
    signal: new AbortController().signal,
    ...over,
  } as any);

describe("recentRounds", () => {
  test("5 轮记录只给出第 3、4、5 轮", () => {
    const entries: any[] = [];
    for (let i = 1; i <= 5; i++) entries.push(userEntry(`问${i}`), textReply(`答${i}`));
    expect(recentRounds(entries)).toEqual([
      { user: "问3", assistant: "答3" },
      { user: "问4", assistant: "答4" },
      { user: "问5", assistant: "答5" },
    ]);
  });

  test("用户消息 content 是纯字符串时也能取到文字", () => {
    expect(recentRounds([stringUserEntry("纯字符串问"), textReply("答")])).toEqual([
      { user: "纯字符串问", assistant: "答" },
    ]);
  });

  test("只有 1 轮时只给出这 1 轮", () => {
    expect(recentRounds([userEntry("你好"), textReply("在")])).toEqual([
      { user: "你好", assistant: "在" },
    ]);
  });

  test("思考、工具调用、工具结果、custom_message 都不出现", () => {
    const entries = [
      userEntry("做个检查"),
      assistantEntry([
        { type: "thinking", thinking: "SECRET-THINK" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "SECRET-CMD" } },
      ]),
      toolResultEntry("SECRET-RESULT"),
      customEntry("SECRET-CUSTOM"),
      assistantEntry([
        { type: "thinking", thinking: "SECRET-THINK2" },
        { type: "text", text: "检查完了" },
        { type: "toolCall", id: "c2", name: "bash", arguments: { cmd: "SECRET-CMD2" } },
      ]),
    ];
    const result = recentRounds(entries);
    expect(result).toEqual([{ user: "做个检查", assistant: "检查完了" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("一轮里有多条 assistant 消息时只取最后一条的文字块", () => {
    const entries = [
      userEntry("干活"),
      textReply("先说一句"),
      toolResultEntry("结果"),
      textReply("最终结论"),
    ];
    expect(recentRounds(entries)).toEqual([{ user: "干活", assistant: "最终结论" }]);
  });
});

describe("acceptSuggestion 整理", () => {
  test.each([
    ["建议：跑一下测试", "跑一下测试"],
    ["Suggestion: run the tests", "run the tests"],
    ["<suggestion>跑一下测试</suggestion>", "跑一下测试"],
    ["  可以  ", "可以"],
  ])("%s -> %s", (raw, expected) => {
    expect(acceptSuggestion(raw)).toBe(expected);
  });

  test("前后带空白的 60 个汉字去掉空白后返回", () => {
    expect(acceptSuggestion(`  ${"好".repeat(60)}\n`)).toBe("好".repeat(60));
  });
});

describe("acceptSuggestion 判定为没有", () => {
  test.each([
    ["空串", ""],
    ["全空白", "   "],
    ["61 个汉字", "好".repeat(61)],
    ["含换行", "第一行\n第二行"],
    ["含 U+2028", "第一行\u2028第二行"],
    ["含 U+2029", "第一行\u2029第二行"],
    ["含控制字符", "好\u001b[31m"],
    ["含星号", "跑 **测试**"],
    ["无建议", "无建议"],
    ["括号包住的沉默", "（沉默）"],
    ["英文 Done.", "Done."],
    ["方括号包住", "[无]"],
    ["道谢加肯定", "看起来不错，谢谢"],
    ["Looks good", "Looks good"],
    ["我来开头", "我来跑测试"],
    ["Let me 开头", "Let me run tests"],
    ["句号后还有文字", "跑测试。然后提交"],
  ])("%s", (_name, raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test.each(["无", "无建议", "没有建议", "暂无建议", "沉默", "完成", "已完成", "None", "no suggestion", "Nothing to suggest", "SILENCE", "done", "无。", "「完成」", "沉默！"])("自述没有建议：%s", (raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test.each(["（沉默）", "(none)", "[无]", "【无】", "［无］", "〔无〕"])("整句被一对括号包住：%s", (raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test.each(["好的谢谢", "非常感谢", "太好了", "这样看起来不错", "完美", "Thanks", "thank you so much", "LGTM, looks good", "sounds good to me", "great", "Perfect"])("含评价语：%s", (raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test.each(["我来跑测试", "让我看看", "我会提交", "我将提交", "我已提交", "我先看看", "好的，我来改", "Let me check", "I'll commit", "I've done it", "Here's the fix", "here is the fix"])("主代理口吻开头：%s", (raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test.each(["跑测试。然后提交", "跑测试！再提交", "要跑吗？跑吧", "Run tests. Then commit", "Run tests! Then commit", "跑测试!然后提交", "Run tests.Then commit"])("多句话：%s", (raw) => {
    expect(acceptSuggestion(raw)).toBeUndefined();
  });

  test("按码点计数，61 个非 BMP 字符没有建议", () => {
    expect(acceptSuggestion("𠮷".repeat(61))).toBeUndefined();
  });
});

describe("acceptSuggestion 判定为建议", () => {
  test.each([
    ["正好 60 个汉字", "好".repeat(60)],
    ["可以", "可以"],
    ["句末带句号", "跑一下测试。"],
    ["60 个非 BMP 字符", "𠮷".repeat(60)],
    ["以问号结尾的单句", "要不要先跑测试？"],
    ["带小数点的版本号", "升级到 v1.2 再跑测试"],
    ["叠用的标点", "可以！！"],
    ["问号加感叹号", "真的要跑吗？！"],
    ["不是一对的括号", "(先跑测试】"],
    ["中间含完成二字", "完成后跑测试"],
    ["不错不是评价语", "不错位地对齐表格"],
  ])("%s", (_name, raw) => {
    expect(acceptSuggestion(raw)).toBe(raw);
  });
});

describe("suggestionThinking", () => {
  test("不支持推理的模型不思考", () => {
    expect(suggestionThinking(model({ reasoning: false }))).toBeUndefined();
  });

  test("支持推理且没有 thinkingLevelMap 时不思考", () => {
    expect(suggestionThinking(model({ reasoning: true }))).toBeUndefined();
  });

  test("off 与 minimal 都不可用时用 low", () => {
    const m = model({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } });
    expect(suggestionThinking(m)).toBe("low");
  });

  test("只有 off 不可用时用 minimal", () => {
    const m = model({ reasoning: true, thinkingLevelMap: { off: null } });
    expect(suggestionThinking(m)).toBe("minimal");
  });
});

describe("requestSuggestion 轮数", () => {
  test.each([0, 1])("收到 %i 轮时不调用，结果为没有", async (n) => {
    const registry = fakeRegistry();
    const result = await run(registry, { rounds: rounds.slice(0, n) });
    expect(result).toBeUndefined();
    expect(registry.streamSimple).not.toHaveBeenCalled();
    expect(registry.complete).not.toHaveBeenCalled();
  });

  test("收到 2 轮时调用", async () => {
    const registry = fakeRegistry();
    await run(registry);
    expect(registry.streamSimple).toHaveBeenCalledTimes(1);
  });
});

describe("requestSuggestion 调用方式", () => {
  test("关掉思考：只调 streamSimple，无 reasoning，maxTokens 512", async () => {
    const registry = fakeRegistry();
    await run(registry);
    expect(registry.complete).not.toHaveBeenCalled();
    expect(registry.streamSimple).toHaveBeenCalledTimes(1);
    const options = (registry.streamSimple.mock.calls[0] as any)[2];
    expect(options.reasoning).toBeUndefined();
    expect(options.maxTokens).toBe(512);
  });

  test("把传入的 signal 交给 streamSimple", async () => {
    const registry = fakeRegistry();
    const signal = new AbortController().signal;
    await run(registry, { signal });
    expect((registry.streamSimple.mock.calls[0] as any)[2].signal).toBe(signal);
  });

  test("最低等级：reasoning 为 low，maxTokens 8192", async () => {
    const registry = fakeRegistry();
    await run(registry, {
      model: model({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
        maxTokens: 100000,
      }),
    });
    expect(registry.complete).not.toHaveBeenCalled();
    const options = (registry.streamSimple.mock.calls[0] as any)[2];
    expect(options.reasoning).toBe("low");
    expect(options.maxTokens).toBe(8192);
  });

  test("model.maxTokens 为 300 时两种都用 300", async () => {
    const off = fakeRegistry();
    await run(off, { model: model({ maxTokens: 300 }) });
    expect((off.streamSimple.mock.calls[0] as any)[2].maxTokens).toBe(300);

    const low = fakeRegistry();
    await run(low, {
      model: model({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
        maxTokens: 300,
      }),
    });
    expect((low.streamSimple.mock.calls[0] as any)[2].maxTokens).toBe(300);
  });

  test("model.maxTokens 为 0 时仍是 512 / 8192", async () => {
    const off = fakeRegistry();
    await run(off, { model: model({ maxTokens: 0 }) });
    expect((off.streamSimple.mock.calls[0] as any)[2].maxTokens).toBe(512);

    const low = fakeRegistry();
    await run(low, {
      model: model({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
        maxTokens: 0,
      }),
    });
    expect((low.streamSimple.mock.calls[0] as any)[2].maxTokens).toBe(8192);
  });
});

describe("requestSuggestion 上下文", () => {
  test("含各个要求要点和各轮用户、主代理文字", async () => {
    const registry = fakeRegistry();
    await run(registry);
    const text = contextText((registry.streamSimple.mock.calls[0] as any)[1]);
    for (const word of ["会打的话", "一句", "60", "评价", "提问", "口吻", "新点子", "敏感", "指令", "什么都不写"]) {
      expect(text).toContain(word);
    }
    for (const word of ["ALPHA", "BRAVO", "CHARLIE", "DELTA"]) expect(text).toContain(word);
  });
});

describe("requestSuggestion 失败与结果", () => {
  test("没有配置认证时不调用模型，结果为没有", async () => {
    const registry = fakeRegistry();
    registry.hasConfiguredAuth.mockReturnValue(false);
    expect(await run(registry)).toBeUndefined();
    expect(registry.complete).not.toHaveBeenCalled();
    expect(registry.streamSimple).not.toHaveBeenCalled();
  });

  test("没有模型时不调用，结果为没有", async () => {
    const registry = fakeRegistry();
    expect(await run(registry, { model: undefined })).toBeUndefined();
    expect(registry.complete).not.toHaveBeenCalled();
    expect(registry.streamSimple).not.toHaveBeenCalled();
  });

  test("streamSimple 抛错时结果为没有且不抛错", async () => {
    const registry = fakeRegistry();
    registry.streamSimple.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(run(registry)).resolves.toBeUndefined();
  });

  test("result() 拒绝时结果为没有且不抛错", async () => {
    const registry = fakeRegistry();
    registry.streamSimple.mockReturnValue({
      result: async () => {
        throw new Error("boom");
      },
    });
    await expect(run(registry)).resolves.toBeUndefined();
  });

  test.each(["error", "aborted", "length"])("stopReason 为 %s 时结果为没有", async (stopReason) => {
    const registry = fakeRegistry("可以", stopReason);
    expect(await run(registry)).toBeUndefined();
  });

  test("signal 已中止时结果为没有且不抛错", async () => {
    const registry = fakeRegistry();
    const controller = new AbortController();
    controller.abort();
    await expect(run(registry, { signal: controller.signal })).resolves.toBeUndefined();
  });

  test("正常返回时去掉首尾空白作为建议", async () => {
    const registry = fakeRegistry("  可以，按这个预览写 PRD  ");
    expect(await run(registry)).toBe("可以，按这个预览写 PRD");
  });
});
