import { describe, expect, test } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RULES_DIR = join(PACKAGE_ROOT, "rules");
const WORKFLOW_STATE = join(PACKAGE_ROOT, "runtime/workflow-state.ts");
const DISPATCH = join(PACKAGE_ROOT, "extensions/dispatch.ts");
const REQUIREMENT_AGENT = join(PACKAGE_ROOT, "daemon/requirement-agent.ts");

const FILES = {
  specFlow: join(PACKAGE_ROOT, "skills/spec-flow/SKILL.md"),
  gitPush: join(PACKAGE_ROOT, "skills/git-push/SKILL.md"),
  specRevise: join(PACKAGE_ROOT, "skills/spec-revise/SKILL.md"),
  specSync: join(PACKAGE_ROOT, "skills/spec-sync/SKILL.md"),
  rules04: join(RULES_DIR, "04-decision-record.md"),
  rules05: join(RULES_DIR, "05-review-failure-handling.md"),
  rules06: join(RULES_DIR, "06-dispatch-boundary.md"),
} as const;

async function readDoc(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function extractSection(body: string, sectionName: string): string {
  const lines = body.split("\n");
  let capturing = false;
  const buffer: string[] = [];
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (capturing) break;
      if (h2Match[1].trim() === sectionName) capturing = true;
      continue;
    }
    if (capturing) buffer.push(line);
  }
  return buffer.join("\n");
}

function extractH2Headings(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.match(/^##\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1].trim());
}

function parseRetreatPaths(source: string): Record<string, string> {
  const match = source.match(/RETREAT_PATHS[^{]*\{([^}]*)\}/s);
  if (!match) throw new Error("RETREAT_PATHS 未找到");
  const entries: Record<string, string> = {};
  for (const pair of match[1].matchAll(/(\w+):\s*"(\w+)"/g)) entries[pair[1]] = pair[2];
  return entries;
}

function parseStringSet(source: string, constName: string): Set<string> {
  const match = source.match(new RegExp(`${constName}[^\\[]*\\[([^\\]]*)\\]`, "s"));
  if (!match) throw new Error(`${constName} 未找到`);
  return new Set([...match[1].matchAll(/"(\w+)"/g)].map((entry) => entry[1]));
}

function parseObjectKeySet(source: string, constName: string): Set<string> {
  const match = source.match(new RegExp(`${constName}[^{]*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`${constName} 未找到`);
  return new Set([...match[1].matchAll(/^\s*(\w+)\s*:/gm)].map((entry) => entry[1]));
}

function hasAllWords(body: string, words: string[]): boolean {
  return words.every((word) => body.includes(word));
}

const ruleFiles = (await readdir(RULES_DIR)).filter((name) => name.endsWith(".md")).sort();

describe("spec-flow 必需段落顺序", () => {
  test("二级标题依次为角色定位、工作区识别、澄清与规范、确认与派出、中继、补充需求、续接", async () => {
    const body = await readDoc(FILES.specFlow);
    expect(extractH2Headings(body)).toEqual([
      "角色定位",
      "工作区识别",
      "澄清与规范",
      "确认与派出",
      "中继",
      "补充需求",
      "续接",
    ]);
  });
});

const SPEC_FLOW_SECTION_PHRASES: Array<[string, string[]]> = [
  ["角色定位", ["不规划任务", "派出需求代理"]],
  ["工作区识别", ["契约先写入各仓库规范"]],
  ["确认与派出", ["decision_record", "version", "pi_company_workflow init", "advance confirmed", "pi_company_dispatch"]],
  ["中继", ["pi_company_reply", "pi_company_forward"]],
  ["续接", ["/pi-company:resume", "从本机流程数据定位", "不从文档推断阶段", "resumeInterrupted"]],
];

describe("spec-flow 必需句落在对应段落内", () => {
  for (const [section, phrases] of SPEC_FLOW_SECTION_PHRASES) {
    for (const phrase of phrases) {
      test(`${section} 段落含: ${phrase}`, async () => {
        const body = await readDoc(FILES.specFlow);
        const found = extractSection(body, section);
        expect(found.length).toBeGreaterThan(0);
        expect(found).toContain(phrase);
      });
    }
  }
});

describe("spec-flow 确认与派出段落含用户决定证据", () => {
  test("含 actor user 或 用户决定（语义等价二选一）", async () => {
    const body = await readDoc(FILES.specFlow);
    const section = extractSection(body, "确认与派出");
    expect(/actor user|用户决定/.test(section)).toBe(true);
  });
});

describe("spec-flow 禁止句", () => {
  const FORBIDDEN = ["SubagentWorkflow", "test-engineer", "impl-engineer", "/spec-new", "/spec-resume"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readDoc(FILES.specFlow);
      expect(body).not.toContain(phrase);
    });
  }
});

describe("git-push 必需句", () => {
  const REQUIRED = [
    "一次直接派",
    "审查快照",
    "本需求获准范围路径",
    "不切换分支",
    "retreat",
    "重新派出需求代理",
    "decision_record",
    "新运行身份",
  ];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.gitPush);
      expect(body).toContain(phrase);
    });
  }
});

describe("git-push 禁止句", () => {
  const FORBIDDEN = ["git add .", "--force", "最多三轮"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readDoc(FILES.gitPush);
      expect(body).not.toContain(phrase);
    });
  }
});

describe("git-push 归因记录为用户决定", () => {
  test("含 actor user 或 用户决定（语义等价二选一）", async () => {
    const body = await readDoc(FILES.gitPush);
    expect(/actor user|用户决定/.test(body)).toBe(true);
  });

  test("不含 actor ai", async () => {
    const body = await readDoc(FILES.gitPush);
    expect(body).not.toContain("actor ai");
  });
});

describe("git-push retreat 目标阶段与回退前置条件", () => {
  test("含: 该需求下无未停止运行", async () => {
    const body = await readDoc(FILES.gitPush);
    expect(body).toContain("该需求下无未停止运行");
  });

  test("retreat 与 executing 同时出现，指向回退目标为 executing", async () => {
    const body = await readDoc(FILES.gitPush);
    expect(body).toContain("retreat");
    expect(body).toContain("executing");
  });

  test("retreat 调用写明 stage、version、reason、decisionId 四参数", async () => {
    const body = await readDoc(FILES.gitPush);
    expect(hasAllWords(body, ["stage", "version", "reason", "decisionId"])).toBe(true);
  });
});

describe("spec-revise 必需句", () => {
  const REQUIRED = ["pi_company_workflow retreat", "已 accepted 需求只读", "decision_record", "实现缺陷", "规范缺陷", "需求变更"];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.specRevise);
      expect(body).toContain(phrase);
    });
  }
});

describe("spec-revise 禁止句", () => {
  const FORBIDDEN = ["/spec-revise", "test-engineer"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readDoc(FILES.specRevise);
      expect(body).not.toContain(phrase);
    });
  }
});

describe("spec-revise 归因记录为用户决定", () => {
  test("含 actor user 或 用户决定（语义等价二选一）", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(/actor user|用户决定/.test(body)).toBe(true);
  });

  test("不含 actor ai", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(body).not.toContain("actor ai");
  });
});

describe("workflow-state.ts 的 RETREAT_PATHS 与 spec-revise/git-push 的回退路径描述一致", () => {
  test("RETREAT_PATHS 结构为 planned→confirmed、reviewing/accepting/accepted→executing", async () => {
    const source = await readDoc(WORKFLOW_STATE);
    expect(parseRetreatPaths(source)).toEqual({ planned: "confirmed", reviewing: "executing", accepting: "executing", accepted: "executing" });
  });

  test("spec-revise 按阶段分流：planned 回退到 confirmed", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(body).toContain("planned 回退到 confirmed");
  });

  test("spec-revise 按阶段分流：reviewing/accepting 回退到 executing", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(body).toContain("reviewing");
    expect(body).toContain("accepting");
    expect(body).toContain("回退到 executing");
  });

  test("spec-revise 按阶段分流：confirmed 与 executing 同为无需回退直接转发要求重新提议", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(body).toContain("confirmed/executing 无需回退");
  });

  test("spec-revise 含: 该需求下无未停止运行", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(body).toContain("该需求下无未停止运行");
  });

  test("spec-revise retreat 调用写明 stage、version、reason、decisionId 四参数", async () => {
    const body = await readDoc(FILES.specRevise);
    expect(hasAllWords(body, ["stage", "version", "reason", "decisionId"])).toBe(true);
  });
});

describe("spec-sync 必需句", () => {
  const REQUIRED = ["由需求代理派 acceptance", "只读盘点"];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.specSync);
      expect(body).toContain(phrase);
    });
  }

  test("写明需求已 accepted 或无进行中需求时以一条对账需求承载验收", async () => {
    const body = await readDoc(FILES.specSync);
    const hasAcceptedOrNone = /已\s*accepted/.test(body) && /无(进行中)?需求/.test(body);
    expect(hasAcceptedOrNone && body.includes("对账需求")).toBe(true);
  });
});

describe("spec-sync 禁止句", () => {
  const FORBIDDEN = ["/spec-sync"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readDoc(FILES.specSync);
      expect(body).not.toContain(phrase);
    });
  }
});

describe("rules/06-dispatch-boundary.md", () => {
  test("文件存在且非空", async () => {
    const body = await readDoc(FILES.rules06);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  const REQUIRED = ["只派需求代理与提交前白盒审查者", "角色不再向下派", "日常对话不派任何角色"];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.rules06);
      expect(body).toContain(phrase);
    });
  }
});

describe("rules/04-decision-record.md 必需句", () => {
  const REQUIRED = ["回执先于行动", "decision_record"];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.rules04);
      expect(body).toContain(phrase);
    });
  }
});

describe("rules/05-review-failure-handling.md 必需句", () => {
  const REQUIRED = ["回退到执行阶段", "重新派出"];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readDoc(FILES.rules05);
      expect(body).toContain(phrase);
    });
  }

  test("归因职责归需求代理（'归因'与'需求代理'邻近共现）", async () => {
    const body = await readDoc(FILES.rules05);
    expect(/需求代理.{0,10}归因|归因.{0,10}需求代理/.test(body)).toBe(true);
  });

  test("retreat 调用写明 stage、version、reason、decisionId 四参数", async () => {
    const body = await readDoc(FILES.rules05);
    expect(hasAllWords(body, ["stage", "version", "reason", "decisionId"])).toBe(true);
  });
});

describe("extensions/dispatch.ts 的阻断阶段集与 daemon/requirement-agent.ts 的 BLOCKED_STAGES 一致", () => {
  test("dispatch.ts 的 DISPATCH_BLOCKED_STAGE_REASONS 键集等于 requirement-agent.ts 的 BLOCKED_STAGES，且与 IN_PROGRESS_STAGES 互补", async () => {
    const workflowStateSource = await readDoc(WORKFLOW_STATE);
    const dispatchSource = await readDoc(DISPATCH);
    const requirementAgentSource = await readDoc(REQUIREMENT_AGENT);

    const validStages = parseStringSet(workflowStateSource, "VALID_STAGES");
    const inProgressStages = parseStringSet(dispatchSource, "IN_PROGRESS_STAGES");
    const dispatchBlocked = parseObjectKeySet(dispatchSource, "DISPATCH_BLOCKED_STAGE_REASONS");
    const blockedStages = parseStringSet(requirementAgentSource, "BLOCKED_STAGES");

    expect(dispatchBlocked).toEqual(blockedStages);
    const derivedBlocked = new Set([...validStages].filter((stage) => !inProgressStages.has(stage)));
    expect(derivedBlocked).toEqual(blockedStages);
  });
});

describe("rules/* 禁止句", () => {
  const FORBIDDEN = ["pi-subagents", "SubagentWorkflow"];
  for (const file of ruleFiles) {
    for (const phrase of FORBIDDEN) {
      test(`${file} 不含: ${phrase}`, async () => {
        const body = await readFile(join(RULES_DIR, file), "utf8");
        expect(body).not.toContain(phrase);
      });
    }
  }
});
