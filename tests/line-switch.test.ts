import { expect, test } from "vitest";
import { lineSwitchReport, restoreMessageText } from "../src/modules/interaction/line-switch.ts";

type Item = Parameters<typeof lineSwitchReport>[0][number];
const LOG = "/tmp/pi-t-logs/0192.log";
const LOG_B = "/tmp/pi-t-logs/0193.log";
const draft = (title: string, overrides: Partial<Item> = {}): Item => ({
  requirementId: title, title, lifecycle: "draft", before: "a10", tip: "a5", tipVersion: 5, currentVersion: 10, afterApproval: false, lastSaved: 1, ...overrides,
});
const textOf = (items: Item[]) => restoreMessageText(lineSwitchReport(items));

test("只有一个草稿需求的线尖变了：正文只有一行已恢复至新线尖的版本号", () => {
  expect(textOf([draft("订单导出")])).toBe("「订单导出」已恢复至版本 5");
});

test("线尖没变：报告为空，消息正文是 undefined", () => {
  expect(textOf([draft("订单导出", { before: "a5", tip: "a5" })])).toBeUndefined();
  expect(textOf([])).toBeUndefined();
});

test("三种结果混在一起：已恢复、已批准、没能恢复依次排列，块之间空一行，失败块三行列表齐全", () => {
  const text = textOf([
    draft("消息通知", { before: "n6", tip: "n3", currentVersion: 6, lastSaved: 1, failure: { reason: "需求自己的 Git 仓库里找不到版本 3 那次保存的提交", conversationVersion: 3, logPath: LOG } }),
    draft("会员积分", { lifecycle: "active", before: "m14", tip: "m2", currentVersion: 14, lastSaved: 2 }),
    draft("订单导出", { lastSaved: 3 }),
  ]);
  expect(text).toBe([
    "「订单导出」已恢复至版本 5", "",
    "「会员积分」已批准，以库里的版本 14 为准", "",
    "「消息通知」没能恢复至版本 3，仍是版本 6",
    "- 原因：需求自己的 Git 仓库里找不到版本 3 那次保存的提交",
    "- 下一步：主代理先读取库里的内容再操作；要用回版本 3，让主代理照对话里的内容重新保存一次",
    `- 运行日志：${LOG}`,
  ].join("\n"));
});

test("失败块取不到对话里的版本号时，写成对话里的那一版", () => {
  const text = textOf([draft("消息通知", { before: "n6", tip: "n3", currentVersion: 6, failure: { reason: "锚点在库里找不到", conversationVersion: null, logPath: LOG } })]);
  expect(text).toBe([
    "「消息通知」没能恢复至对话里的那一版，仍是版本 6",
    "- 原因：锚点在库里找不到",
    "- 下一步：主代理先读取库里的内容再操作；要用回对话里的那一版，让主代理照对话里的内容重新保存一次",
    `- 运行日志：${LOG}`,
  ].join("\n"));
});

test("恢复失败即使线尖和换线前相同也要报", () => {
  const text = textOf([draft("消息通知", { before: "n3", tip: "n3", currentVersion: 6, failure: { reason: "锚点在库里找不到", conversationVersion: 3, logPath: LOG } })]);
  expect(text).toContain("「消息通知」没能恢复至版本 3，仍是版本 6");
});

test.each(["active", "closing", "closed"] as const)("%s 的需求：新线尖停在批准之前写已批准块", (lifecycle) => {
  expect(textOf([draft("会员积分", { lifecycle, afterApproval: false, currentVersion: 14 })])).toBe("「会员积分」已批准，以库里的版本 14 为准");
});

test.each(["active", "closing", "closed"] as const)("%s 的需求：新线尖在批准之后不写", (lifecycle) => {
  expect(textOf([draft("会员积分", { lifecycle, afterApproval: true })])).toBeUndefined();
});

test.each(["active", "closing", "closed"] as const)("%s 的需求：换线前后线尖相同但都停在批准之前，照样写已批准块", (lifecycle) => {
  expect(textOf([draft("会员积分", { lifecycle, before: "m2", tip: "m2", afterApproval: false, currentVersion: 14 })])).toBe("「会员积分」已批准，以库里的版本 14 为准");
});

test("草稿需求换线前后线尖相同：不写", () => {
  expect(textOf([draft("订单导出", { before: "a5", tip: "a5", afterApproval: false })])).toBeUndefined();
});

test("多个仓库的失败块各写自己条目带的运行日志路径", () => {
  const text = textOf([
    draft("甲", { lastSaved: 1, failure: { reason: "原因甲", conversationVersion: 3, logPath: LOG } }),
    draft("乙", { lastSaved: 2, failure: { reason: "原因乙", conversationVersion: 3, logPath: LOG_B } }),
  ])!;
  const [first, second] = text.split("\n\n");
  expect(first).toContain(`- 运行日志：${LOG}`);
  expect(first).not.toContain(LOG_B);
  expect(second).toContain(`- 运行日志：${LOG_B}`);
  expect(second).not.toContain(LOG);
});

test("同一种里按线上最后保存的先后排，没保存过的排最后再按标题排", () => {
  const text = textOf([
    draft("丙", { lastSaved: null }), draft("乙", { lastSaved: 9 }), draft("甲", { lastSaved: null }), draft("戊", { lastSaved: 2 }),
  ])!;
  const titles = text.split("\n\n").map((block) => block.match(/「(.+?)」/)![1]);
  expect(titles).toEqual(["戊", "乙", ...["丙", "甲"].sort((a, b) => a.localeCompare(b))]);
});

test("已批准的块按同样规则排序，且排在已恢复之后", () => {
  const text = textOf([
    draft("批准乙", { lifecycle: "active", lastSaved: 8 }), draft("批准甲", { lifecycle: "closed", lastSaved: 3 }), draft("恢复", { lastSaved: 99 }),
  ])!;
  expect(text.split("\n\n").map((block) => block.match(/「(.+?)」/)![1])).toEqual(["恢复", "批准甲", "批准乙"]);
});
