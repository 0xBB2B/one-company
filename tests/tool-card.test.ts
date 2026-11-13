import { expect, test } from "vitest";
import { failureReason } from "../src/core/host/tool-card.ts";

test("failureReason 取「原因：」到「\\n建议：」之间的整段，原因里带中文冒号也整段取出", () => {
  expect(failureReason("X 失败。\n原因：草稿已经被改过：要确认的不是最新一版\n建议：重新读取")).toBe("草稿已经被改过：要确认的不是最新一版");
});

test("failureReason 原因跨两行时两行都取出", () => {
  expect(failureReason("X 失败。\n原因：第一行\n第二行\n建议：重试")).toBe("第一行\n第二行");
});

test("failureReason 没有「建议：」时取到文字末尾", () => {
  expect(failureReason("X 失败。\n原因：只有原因")).toBe("只有原因");
});

test("failureReason 没有「原因：」的文字取第一行", () => {
  expect(failureReason("参数 request 缺少必填字段\n第二行细节")).toBe("参数 request 缺少必填字段");
});
