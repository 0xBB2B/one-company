import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { lintSkillText, skillLintErrors } from "./helpers/skill-lint.ts";

const TOPICS: Record<string, string[]> = {
  "go-coding": ["%w", "errors.Is", "errors.As", "context.Context", "不存进结构体", "使用方", "包名", "defer", "panic("],
  "go-pitfalls": ["nil map", "concurrent map", "-race", "goroutine 泄漏", "DefaultClient", "Body.Close", "1.22", "WaitGroup"],
  "typescript-coding": ["strict", "不用 any", "unknown", "`as` 断言", "never", "readonly"],
  "node-pitfalls": ["运行时校验", "多余字段", "__proto__", "unhandledRejection", "Node 15", "事件循环", "child_process"],
  "python-coding": ["PEP 8", "PEP 484", "except:", "with open", "logging"],
  "python-pitfalls": ["pickle", "yaml.load", "可变默认参数", "asyncio", "shell=True", "eval(", "exec("],
  "java-coding": ["Google Java Style", "Throwable", "hashCode", "try-with-resources", "Optional"],
  "java-pitfalls": ["ObjectInputStream", "Jackson", "@Transactional", "自调用", "rollbackFor", "Executors", "close", "Actuator", "SimpleDateFormat"],
};

const item = (title: string, overrides: Partial<Record<string, string | null>> = {}): string => {
  const lines = {
    问题: "- 问题：错误被吞掉",
    怎么认出: "- 怎么认出：搜索空的 catch",
    修法: "- 修法：向上返回",
    出处: "- 出处：https://example.com/a",
    ...overrides,
  };
  return [`### ${title}`, ...Object.values(lines).filter((line): line is string => line !== null)].join("\n");
};

const skill = (body: string, head = "name: demo\ndescription: 示例"): string => `---\n${head}\n---\n${body}\n`;

describe("后端 skill 内容检查", () => {
  test.each(Object.keys(TOPICS))("%s 格式与主题关键词全部合格", async (name) => {
    expect(await skillLintErrors(name, TOPICS[name]!)).toEqual([]);
  });
});

describe("skill 检查辅助函数", () => {
  test("完整合格的 skill 没有错误", () => {
    expect(lintSkillText("demo", skill(item("甲")), [])).toEqual([]);
  });

  test("缺修法行时报出第几项缺修法", () => {
    const errors = lintSkillText("demo", skill(`${item("甲")}\n${item("乙", { 修法: null })}`), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("第 2 项");
    expect(errors[0]).toContain("修法");
  });

  test("四行顺序不对时报出第几项顺序错误", () => {
    const swapped = ["### 甲", "- 怎么认出：x", "- 问题：y", "- 修法：z", "- 出处：https://example.com"].join("\n");
    const errors = lintSkillText("demo", skill(swapped), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("第 1 项");
    expect(errors[0]).toContain("顺序");
  });

  test("出处是 http:// 而非 https:// 时报出", () => {
    const errors = lintSkillText("demo", skill(item("甲", { 出处: "- 出处：http://example.com/a" })), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("https");
  });

  test("name 与目录名不一致时报出", () => {
    const errors = lintSkillText("demo", skill(item("甲"), "name: other\ndescription: 示例"), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("name");
  });

  test("description 为空时报出", () => {
    const errors = lintSkillText("demo", skill(item("甲"), "name: demo\ndescription: \"\""), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("description");
  });

  test("没有检查项时报出", () => {
    const errors = lintSkillText("demo", skill("只有一段说明"), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("没有检查项");
  });

  test("缺关键词时逐个报出，区分大小写", () => {
    const errors = lintSkillText("demo", skill(item("甲") + "\nStrict"), ["strict", "错误被吞掉"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("strict");
  });

  test("恰好 200 行通过，201 行被报出", () => {
    const base = skill(item("甲")).replace(/\n$/, "").split("\n").length;
    const padding = (total: number): string => "\n说明".repeat(total - base);
    expect(lintSkillText("demo", skill(item("甲") + padding(200)), [])).toEqual([]);
    const errors = lintSkillText("demo", skill(item("甲") + padding(201)), []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("201");
  });

  test("skill 文件不存在时报出文件不存在", async () => {
    const errors = await skillLintErrors("no-such-skill", []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不存在");
  });
});

describe("typescript-coding 的 tsconfig 约定", () => {
  test("写明严格选项是新建或修改 tsconfig 时的写法，没有 tsconfig 时不自行加严格参数检查（含测试文件），按项目已有检查方式；格式合格且不超过 200 行", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "skills", "typescript-coding", "SKILL.md"), "utf8");
    expect(text).toContain("没有 tsconfig");
    expect(text).toContain("不自行");
    expect(text).toMatch(/新建或修改 tsconfig/);
    expect(text.split("\n").length).toBeLessThanOrEqual(200);
    expect(await skillLintErrors("typescript-coding", TOPICS["typescript-coding"]!)).toEqual([]);
  });
});
