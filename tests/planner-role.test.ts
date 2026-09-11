import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLANNER_MD = join(PACKAGE_ROOT, "agents/planner.md");
const PREFLIGHT_MD = join(PACKAGE_ROOT, "skills/spec-flow/references/planning-preflight.md");
const ARTIFACTS_MD = join(PACKAGE_ROOT, "skills/spec-flow/references/planning-artifacts.md");

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function parseFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function parseToolsList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractSection(content: string, headingPattern: RegExp): string {
  const lines = content.split("\n");
  let capturing = false;
  const buffer: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (capturing) break;
      if (headingPattern.test(headingMatch[2].trim())) {
        capturing = true;
      }
      continue;
    }
    if (capturing) buffer.push(line);
  }
  return buffer.join("\n");
}

describe("agents/planner.md frontmatter 契约", () => {
  test("name 字段为 planner", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    expect(parseFields(frontmatter).name).toBe("planner");
  });

  test("kind 字段为 plan", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    expect(parseFields(frontmatter).kind).toBe("plan");
  });

  test("tools 字段为列表格式", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    const raw = parseFields(frontmatter).tools ?? "";
    expect(raw.trim().startsWith("[")).toBe(true);
    expect(raw.trim().endsWith("]")).toBe(true);
  });

  test("tools 白名单整体相等", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    const tools = parseToolsList(parseFields(frontmatter).tools ?? "");
    const whitelist = ["read", "grep", "find", "ls", "write", "edit", "bash"];
    expect([...tools].sort()).toEqual([...whitelist].sort());
  });

  test("skills 字段为 true", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    expect(parseFields(frontmatter).skills).toBe("true");
  });

  test("prompt_mode 字段为 append", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    expect(parseFields(frontmatter).prompt_mode).toBe("append");
  });

  test("frontmatter 不含 status 键（不区分缩进与换行符）", async () => {
    const { frontmatter } = splitFrontmatter(await readText(PLANNER_MD));
    const normalized = frontmatter.replace(/\r\n/g, "\n");
    expect(/^[ \t]*status\s*:/m.test(normalized)).toBe(false);
  });

  test("frontmatter 之后存在非空正文", async () => {
    const { body } = splitFrontmatter(await readText(PLANNER_MD));
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

describe("agents/planner.md 必需句落在对应段落内", () => {
  const SECTION_SENTENCES: Array<[string, RegExp, string[]]> = [
    ["骨架先行", /^骨架先行$/, ["先列出骨架", "不另建长期报告", "不增加确认轮次"]],
    ["增量规划", /^增量规划$/, ["未受影响任务逐字不变", "不为未受影响任务重置运行状态"]],
    [
      "任务正文",
      /^任务正文$/,
      ["逐字内联所引 AC 与其回指的 C", "扣除示例与成品代码块后 ≤200 行", "完成时机"],
    ],
    ["机械检查", /^机械检查$/, ["lint.sh --tasks", "不自行编写检查脚本", "任务生成器", "验收解析器"]],
    [
      "不可执行即报告",
      /^不可执行即报告$/,
      ["不报告可执行", "模拟通过", "模型自觉遵守提示", "既有测试数量"],
    ],
    ["输入与边界", /^输入与边界$/, ["不派出任何角色"]],
  ];

  for (const [label, pattern, sentences] of SECTION_SENTENCES) {
    for (const sentence of sentences) {
      test(`${label} 段落含: ${sentence}`, async () => {
        const { body } = splitFrontmatter(await readText(PLANNER_MD));
        const section = extractSection(body, pattern);
        expect(section.length).toBeGreaterThan(0);
        expect(section).toContain(sentence);
      });
    }
  }
});

describe("planning-preflight.md 前检约定必需内容", () => {
  const PREFLIGHT_SIX_KEYWORDS = [
    "需求已确认",
    "规划类型",
    "受影响任务编辑状态",
    "范围占用",
    "目录授权",
    "验证条件",
  ];
  for (const keyword of PREFLIGHT_SIX_KEYWORDS) {
    test(`前检六项含: ${keyword}`, async () => {
      const content = await readText(PREFLIGHT_MD);
      expect(content).toContain(keyword);
    });
  }

  test("前检项数量为六", async () => {
    const content = await readText(PREFLIGHT_MD);
    const section = extractSection(content, /^前检六项$/);
    const bulletCount = (section.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBe(6);
  });

  const REQUIRED_SENTENCES = [
    "不派出规划角色",
    "授权范围",
    "不借用其他目录",
    "不改写旧运行结果",
    "未知技术前提",
    "摘要不替代",
    "不为未受影响任务重置运行状态",
    "解除完成状态限制",
  ];
  for (const sentence of REQUIRED_SENTENCES) {
    test(`含: ${sentence}`, async () => {
      const content = await readText(PREFLIGHT_MD);
      expect(content).toContain(sentence);
    });
  }

  const INCREMENTAL_KEYWORDS = ["变化摘要", "相关位置", "已知限制"];
  for (const keyword of INCREMENTAL_KEYWORDS) {
    test(`增量输入三件含: ${keyword}`, async () => {
      const content = await readText(PREFLIGHT_MD);
      expect(content).toContain(keyword);
    });
  }
});

describe("planning-artifacts.md 需求代理核对清单必需内容", () => {
  const REQUIRED_SENTENCES = [
    "在实施前由需求代理核对验证方案",
    "验证入口必须可运行",
    "排除在模拟之外",
    "不判为实施就绪",
    "模拟通过",
    "模型自觉遵守提示",
    "既有测试数量",
    "任务生成器",
    "验收解析器",
  ];
  for (const sentence of REQUIRED_SENTENCES) {
    test(`含: ${sentence}`, async () => {
      const content = await readText(ARTIFACTS_MD);
      expect(content).toContain(sentence);
    });
  }

  test("不复述骨架五要素成立标准正文（不含 互斥）", async () => {
    const content = await readText(ARTIFACTS_MD);
    expect(content).not.toContain("互斥");
  });

  test("不复述验证约定块模板正文（不含 - 真实入口：）", async () => {
    const content = await readText(ARTIFACTS_MD);
    expect(content).not.toContain("- 真实入口：");
  });
});

describe("三份文件禁止句不出现", () => {
  const TARGETS: Array<[string, string]> = [
    ["agents/planner.md", PLANNER_MD],
    ["planning-preflight.md", PREFLIGHT_MD],
    ["planning-artifacts.md", ARTIFACTS_MD],
  ];
  const FORBIDDEN_SENTENCES = [
    "预估改动不超过 200 行",
    "status:",
    "可以调用 worker",
    "规划派工次数为零",
    "每个待规划的行为切片",
  ];

  for (const [label, path] of TARGETS) {
    for (const sentence of FORBIDDEN_SENTENCES) {
      test(`${label} 不含: ${sentence}`, async () => {
        const content = await readText(path);
        expect(content).not.toContain(sentence);
      });
    }
  }
});
