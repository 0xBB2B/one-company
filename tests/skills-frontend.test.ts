import { describe, expect, test } from "vitest";
import { skillLintErrors } from "./helpers/skill-lint.ts";

const TOPICS: Record<string, string[]> = {
  "vue-coding": ["多个单词", "prop 定义", "v-for", "v-if", "<script setup lang=\"ts\">", "computed", "不直接改 props"],
  "vue-pitfalls": ["组件模板", "v-html", "javascript:", ":style", "服务端渲染", "解构", "onUnmounted", "路由守卫"],
  "react-coding": ["顶层调用", "保持纯", "列表 key", "不存 state", "useEffect"],
  "react-pitfalls": ["dangerouslySetInnerHTML", "javascript:", "清理函数", "竞态", "下标当 key", "过期的 state"],
};

describe("前端 skill 内容检查", () => {
  test.each(Object.keys(TOPICS))("%s 格式与主题关键词全部合格", async (name) => {
    expect(await skillLintErrors(name, TOPICS[name]!)).toEqual([]);
  });
});
