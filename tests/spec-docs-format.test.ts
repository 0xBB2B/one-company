import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = join(PACKAGE_ROOT, "skills/spec-docs");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const REQUIREMENTS_TEMPLATE = join(SKILL_DIR, "requirements.template.md");
const TASK_TEMPLATE = join(SKILL_DIR, "task.template.md");

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function extractFrontmatterKeys(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .filter((line) => /^[a-zA-Z_]+:/.test(line))
    .map((line) => line.split(":")[0].trim());
}

function extractSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const REQUIRED_SKILL_SENTENCES = [
  ".pi-company/",
  "任务文件不包含 status、step、agent、commit、note、parallel 等运行或调度字段",
  "扣除示例代码块与成品代码块（含首尾围栏）后最多 200 行",
  "不限制任务的代码改动量",
  "决策记录与运行信息只保存在本机，不进入仓库",
  "验证约定",
  "必须真实贯通",
  "三层责任",
  "规划者不得自行编写检查脚本",
  "检查器扣除全部围栏代码块",
];

const FORBIDDEN_SENTENCES = [
  "ai-decisions.jsonl",
  "user-decisions.jsonl",
  "status: todo",
  "agent: wf_",
  "parallel:",
  "预估改动不超过 200 行",
];

describe("SKILL.md 必需句逐字存在", () => {
  for (const sentence of REQUIRED_SKILL_SENTENCES) {
    test(`包含: ${sentence}`, async () => {
      const content = await readText(SKILL_MD);
      expect(content).toContain(sentence);
    });
  }
});

describe("禁止句不出现", () => {
  const targets: Array<[string, string]> = [
    ["SKILL.md", SKILL_MD],
    ["requirements.template.md", REQUIREMENTS_TEMPLATE],
    ["task.template.md", TASK_TEMPLATE],
  ];
  for (const [label, path] of targets) {
    for (const sentence of FORBIDDEN_SENTENCES) {
      test(`${label} 不含: ${sentence}`, async () => {
        const content = await readText(path);
        expect(content).not.toContain(sentence);
      });
    }
  }
});

describe("task.template.md 结构固定", () => {
  test("frontmatter 键顺序恰为 id、title、depends_on、files、refs、verify", async () => {
    const content = await readText(TASK_TEMPLATE);
    const keys = extractFrontmatterKeys(content);
    expect(keys).toEqual(["id", "title", "depends_on", "files", "refs", "verify"]);
  });

  test("正文含验证方式五个要点行：真实入口、必须成立、场景、模拟边界、三层责任", async () => {
    const content = await readText(TASK_TEMPLATE);
    expect(content).toContain("## 验证方式");
    const section = extractSection(content, "## 验证方式");
    expect(section.length).toBeGreaterThan(0);
    for (const label of ["真实入口", "必须成立", "场景", "模拟边界", "三层责任"]) {
      const hasLine = section.split("\n").some((line) => line.trim().startsWith("-") && line.includes(label));
      expect(hasLine).toBe(true);
    }
  });
});

describe("requirements.template.md 结构固定", () => {
  test("frontmatter 不含 status 行", async () => {
    const content = await readText(REQUIREMENTS_TEMPLATE);
    expect(content).not.toMatch(/^status:/m);
  });

  test("正文含第 1 至第 4 节标题", async () => {
    const content = await readText(REQUIREMENTS_TEMPLATE);
    for (const heading of ["## 1.", "## 2.", "## 3.", "## 4."]) {
      expect(content).toContain(heading);
    }
  });
});
