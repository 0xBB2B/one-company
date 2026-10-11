import { expect, test } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { mentionItems, requirementMentionProvider } from "../runtime/mention-completion.ts";

const JUMP = "0192f3a4-7c1e-7b2a-9d4e-5f6a7b8c9d0e", ANIMATION = "0192f3a5-0000-7000-8000-0000000041c7", CLASH = "0192f3a6-0000-7000-8000-000000009d0e";
const files: AutocompleteProvider = {
  async getSuggestions(lines, line, col) {
    const before = lines[line]!.slice(0, col);
    return before.endsWith("@跳") || before.endsWith("@src") ? { items: [{ value: "@src/jump.ts ", label: "@src/jump.ts", description: "文件" }], prefix: before.slice(before.lastIndexOf("@")) } : null;
  },
  applyCompletion(lines, line, col, item, prefix) {
    const text = lines[line]!;
    return { lines: [text.slice(0, col - prefix.length) + item.value + text.slice(col)], cursorLine: line, cursorCol: col - prefix.length + item.value.length };
  },
};
const signal = new AbortController().signal;

test("M8D-AC1：编号尾巴至少 4 位，和其他需求重复时加长；标题里的方括号换成全角，说明写明草稿或进行中、PM 状态与多仓库时的仓库名", () => {
  const items = mentionItems([
    { requirementId: JUMP, title: "角色跳跃", lifecycle: "active", pmRunning: true, repoName: "game" },
    { requirementId: CLASH, title: "登录[后端]", lifecycle: "draft", pmRunning: false, repoName: "api" },
  ], true);
  expect(items).toEqual([
    { value: "@[角色跳跃#c9d0e] ", label: "@[角色跳跃#c9d0e]", description: "需求 · 进行中 · PM 运行中 · game" },
    { value: "@[登录［后端］#09d0e] ", label: "@[登录［后端］#09d0e]", description: "需求 · 草稿 · api" },
  ]);
  expect(mentionItems([{ requirementId: ANIMATION, title: "跳跃动画", lifecycle: "draft", pmRunning: false, repoName: "game" }], false))
    .toEqual([{ value: "@[跳跃动画#41c7] ", label: "@[跳跃动画#41c7]", description: "需求 · 草稿" }]);
});

test("M8D-AC1：打 @ 时需求排在文件前面，按标题或编号尾巴过滤；没有匹配的需求时只剩原来的文件补全", async () => {
  const provider = requirementMentionProvider(files, async () => [
    { requirementId: JUMP, title: "角色跳跃", lifecycle: "active", pmRunning: true, repoName: "game" },
    { requirementId: ANIMATION, title: "跳跃动画", lifecycle: "draft", pmRunning: false, repoName: "game" }], () => false);
  const jump = await provider.getSuggestions(["@跳"], 0, 2, { signal });
  expect(jump).toEqual({ prefix: "@跳", items: [
    { value: "@[角色跳跃#9d0e] ", label: "@[角色跳跃#9d0e]", description: "需求 · 进行中 · PM 运行中" },
    { value: "@[跳跃动画#41c7] ", label: "@[跳跃动画#41c7]", description: "需求 · 草稿" },
    { value: "@src/jump.ts ", label: "@src/jump.ts", description: "文件" }] });
  expect((await provider.getSuggestions(["看看 @41c"], 0, 7, { signal }))!.items.map((item) => item.label)).toEqual(["@[跳跃动画#41c7]"]);
  expect(await provider.getSuggestions(["@src"], 0, 4, { signal })).toEqual({ prefix: "@src", items: [{ value: "@src/jump.ts ", label: "@src/jump.ts", description: "文件" }] });
  expect(await provider.getSuggestions(["没有艾特"], 0, 4, { signal })).toBeNull();
});

test("M8D-AC1：选中需求把 @前缀 换成 @[标题#编号尾]，光标停在后面；选中文件仍交给原来的补全处理", () => {
  const provider = requirementMentionProvider(files, async () => [], () => false);
  expect(provider.applyCompletion(["改 @跳 一下"], 0, 4, { value: "@[角色跳跃#9d0e] ", label: "@[角色跳跃#9d0e]" }, "@跳"))
    .toEqual({ lines: ["改 @[角色跳跃#9d0e]  一下"], cursorLine: 0, cursorCol: 15 });
  expect(provider.applyCompletion(["@src"], 0, 4, { value: "@src/jump.ts ", label: "@src/jump.ts" }, "@src"))
    .toEqual({ lines: ["@src/jump.ts "], cursorLine: 0, cursorCol: 13 });
});
