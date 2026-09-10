import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readRoleDefinition, type RoleDefinition } from "../runtime/roles.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");

const ROLE_FILES = {
  "requirement-agent": join(AGENTS_DIR, "requirement-agent.md"),
  planner: join(AGENTS_DIR, "planner.md"),
  worker: join(AGENTS_DIR, "worker.md"),
  reviewer: join(AGENTS_DIR, "reviewer.md"),
  acceptance: join(AGENTS_DIR, "acceptance.md"),
} as const;

type RoleName = keyof typeof ROLE_FILES;
type ContractRoleName = "requirement-agent" | "worker" | "reviewer" | "acceptance";

async function readRole(name: RoleName): Promise<string> {
  return readFile(ROLE_FILES[name], "utf8");
}

async function loadDefinition(name: RoleName): Promise<RoleDefinition> {
  return readRoleDefinition(ROLE_FILES[name], parseFrontmatter);
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

const REQUIRED_FRONTMATTER_KEYS = ["name", "description", "kind", "tools", "skills", "context_files", "prompt_mode"].sort();

describe("五份角色文件 frontmatter 字段", () => {
  for (const name of Object.keys(ROLE_FILES) as RoleName[]) {
    test(`${name}.md frontmatter 字段恰为规定七项`, async () => {
      const { frontmatter } = parseFrontmatter(await readRole(name));
      expect(Object.keys(frontmatter).sort()).toEqual(REQUIRED_FRONTMATTER_KEYS);
    });

    test(`${name}.md frontmatter name 与文件名一致`, async () => {
      const { frontmatter } = parseFrontmatter(await readRole(name));
      expect(frontmatter.name).toBe(name);
    });
  }
});

const ROLE_CONTRACTS: Array<{
  name: ContractRoleName;
  kind: string;
  tools: string[];
  skills: boolean;
  contextFiles: boolean;
  promptMode: string;
}> = [
  {
    name: "requirement-agent",
    kind: "manage",
    tools: [
      "read",
      "bash",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "pi_company_workflow",
      "pi_company_agent",
      "pi_company_ask",
      "pi_company_propose_shape",
      "decision_record",
    ],
    skills: true,
    contextFiles: true,
    promptMode: "append",
  },
  {
    name: "worker",
    kind: "work",
    tools: ["read", "bash", "grep", "find", "ls", "edit", "write", "structured_output"],
    skills: true,
    contextFiles: true,
    promptMode: "append",
  },
  {
    name: "reviewer",
    kind: "review",
    tools: ["read", "bash", "grep", "find", "ls", "structured_output"],
    skills: true,
    contextFiles: true,
    promptMode: "append",
  },
  {
    name: "acceptance",
    kind: "acceptance",
    tools: ["read", "bash", "write", "structured_output"],
    skills: false,
    contextFiles: false,
    promptMode: "append",
  },
];

describe("四份角色文件 kind 与 tools 契约", () => {
  for (const contract of ROLE_CONTRACTS) {
    test(`${contract.name}.md kind 为 ${contract.kind}`, async () => {
      const definition = await loadDefinition(contract.name);
      expect(definition.kind).toBe(contract.kind);
    });

    test(`${contract.name}.md tools 集合与契约逐项相等`, async () => {
      const definition = await loadDefinition(contract.name);
      expect([...definition.tools].sort()).toEqual([...contract.tools].sort());
    });

    test(`${contract.name}.md skills 为 ${contract.skills}`, async () => {
      const definition = await loadDefinition(contract.name);
      expect(definition.skills).toBe(contract.skills);
    });

    test(`${contract.name}.md context_files 为 ${contract.contextFiles}`, async () => {
      const definition = await loadDefinition(contract.name);
      expect(definition.contextFiles).toBe(contract.contextFiles);
    });

    test(`${contract.name}.md prompt_mode 为 ${contract.promptMode}`, async () => {
      const definition = await loadDefinition(contract.name);
      expect(definition.promptMode).toBe(contract.promptMode);
    });
  }
});

describe("工具边界", () => {
  test("reviewer 不含 edit", async () => {
    const definition = await loadDefinition("reviewer");
    expect(definition.tools).not.toContain("edit");
  });

  test("reviewer 不含 write", async () => {
    const definition = await loadDefinition("reviewer");
    expect(definition.tools).not.toContain("write");
  });

  for (const forbidden of ["grep", "find", "ls", "edit"]) {
    test(`acceptance 不含 ${forbidden}`, async () => {
      const definition = await loadDefinition("acceptance");
      expect(definition.tools).not.toContain(forbidden);
    });
  }

  for (const name of ["worker", "reviewer", "acceptance"] as const) {
    test(`${name} 含 structured_output`, async () => {
      const definition = await loadDefinition(name);
      expect(definition.tools).toContain("structured_output");
    });

    test(`${name} 不含 pi_company_agent`, async () => {
      const definition = await loadDefinition(name);
      expect(definition.tools).not.toContain("pi_company_agent");
    });
  }

  test("requirement-agent 不含 structured_output", async () => {
    const definition = await loadDefinition("requirement-agent");
    expect(definition.tools).not.toContain("structured_output");
  });
});

const SECTION_ORDER: Array<{ name: ContractRoleName; sections: string[] }> = [
  {
    name: "requirement-agent",
    sections: [
      "身份与前提",
      "规划前检",
      "规划",
      "形状提议",
      "执行",
      "交付核对",
      "归因与返修",
      "门禁",
      "对话中继",
      "跨仓库",
      "结束",
    ],
  },
  { name: "worker", sections: ["输入", "证明力核对", "Red", "Green", "自验收", "依赖", "提交", "禁止"] },
  { name: "reviewer", sections: ["范围与只读", "安全优先", "鲁棒性", "可追踪关系", "提交"] },
  { name: "acceptance", sections: ["输入边界", "执行", "可用性", "报告", "提交"] },
];

describe("四份角色文件正文段落结构", () => {
  for (const entry of SECTION_ORDER) {
    test(`${entry.name}.md 正文非空`, async () => {
      const definition = await loadDefinition(entry.name);
      expect(definition.body.trim().length).toBeGreaterThan(0);
    });

    test(`${entry.name}.md 二级标题集合与顺序与规定段落一致`, async () => {
      const definition = await loadDefinition(entry.name);
      expect(extractH2Headings(definition.body)).toEqual(entry.sections);
    });
  }
});

const REQUIRED_EXPRESSIONS: Array<{ name: ContractRoleName; section: string; phrases: string[] }> = [
  { name: "requirement-agent", section: "身份与前提", phrases: ["只有一个需求代理", "不处理绑定范围之外"] },
  { name: "requirement-agent", section: "规划前检", phrases: ["验证条件", "阻塞", "不派工"] },
  {
    name: "requirement-agent",
    section: "规划",
    phrases: [
      "先骨架再正文",
      "受影响范围",
      "lint.sh --tasks",
      "验收解析器",
      "三层责任",
      "200 行",
      "不可重复副作用",
      "不宣布可执行",
    ],
  },
  {
    name: "requirement-agent",
    section: "形状提议",
    phrases: ["pi_company_propose_shape", "白盒审查", "黑盒验收", "跳过门禁", "用户决定", "重新提议"],
  },
  { name: "requirement-agent", section: "执行", phrases: ["形状中声明的范围", "提交交付证据"] },
  {
    name: "requirement-agent",
    section: "交付核对",
    phrases: ["真实测试位置", "本次造成", "已有", "后续接入", "未归因", "task-finish"],
  },
  {
    name: "requirement-agent",
    section: "归因与返修",
    phrases: [
      "三轮",
      "后续问题",
      "不自动返修",
      "停止派发任何修复",
      "错误假设",
      "从原轮次继续",
      "同根因",
      "技术阻塞",
      "不写用户决策记录",
    ],
  },
  { name: "requirement-agent", section: "门禁", phrases: ["规则文件清单", "报告位置", "环境启动方式", "结构化格式", "advance"] },
  { name: "requirement-agent", section: "对话中继", phrases: ["pi_company_ask", "并入"] },
  {
    name: "requirement-agent",
    section: "跨仓库",
    phrases: ["主会话裁定", "裁定前不得按变更后的契约实现", "不联系其他需求代理"],
  },
  { name: "requirement-agent", section: "结束", phrases: ["经中继通知"] },

  { name: "worker", section: "输入", phrases: ["只写任务声明", "不读其他任务"] },
  { name: "worker", section: "证明力核对", phrases: ["真实入口", "改变完成时机或错误含义", "缺失时测试必须"] },
  { name: "worker", section: "Red", phrases: ["目标行为缺失", "不算可信失败", "green-baseline-no-change"] },
  { name: "worker", section: "Green", phrases: ["不跳过、弱化或替换关键断言", "不修改测试含义"] },
  { name: "worker", section: "自验收", phrases: ["verify", "分四类", "本次造成的失败不得交付"] },
  { name: "worker", section: "依赖", phrases: ["任务清单内", "不安装、不 import", "上报库名"] },
  { name: "worker", section: "提交", phrases: ["structured_output", "唯一工作裁决", "coverage", "映射到真实测试位置"] },
  { name: "worker", section: "禁止", phrases: ["不派出角色", "不改写运行信息", "不操作 git 提交"] },

  { name: "reviewer", section: "范围与只读", phrases: ["审查快照", "只读", "命令层判为运行失败"] },
  { name: "reviewer", section: "安全优先", phrases: ["攻击者视角", "攻击路径或触发条件"] },
  { name: "reviewer", section: "鲁棒性", phrases: ["真实非恶意故障视角", "只写进 summary", "不进 issues 与 findings"] },
  { name: "reviewer", section: "可追踪关系", phrases: ["TDD 可信度", "Blocker"] },
  { name: "reviewer", section: "提交", phrases: ["reviewedHead", "contentFingerprint", "traceability", "evidence"] },

  { name: "acceptance", section: "输入边界", phrases: ["不读源码", "任务文件或其他仓库文件", "命令层判为运行失败"] },
  { name: "acceptance", section: "执行", phrases: ["Given", "When", "Then", "原样观察"] },
  { name: "acceptance", section: "可用性", phrases: ["使用者视角", "不可达", "不可用", "精确输入", "rejected"] },
  { name: "acceptance", section: "报告", phrases: ["result", "date", "结果表", "未覆盖", "命令清单", "结论", "reportPath"] },
  { name: "acceptance", section: "提交", phrases: ["items", "全部通过", "uncovered", "accepted"] },
];

describe("四份角色文件必需表达落在对应段落内", () => {
  for (const { name, section, phrases } of REQUIRED_EXPRESSIONS) {
    for (const phrase of phrases) {
      test(`${name}.md ${section} 段落含: ${phrase}`, async () => {
        const definition = await loadDefinition(name);
        const found = extractSection(definition.body, section);
        expect(found.length).toBeGreaterThan(0);
        expect(found).toContain(phrase);
      });
    }
  }
});

describe("禁止句", () => {
  const SELF_EDIT_FORBIDDEN = ["直接修改文件", "自行修复"];
  for (const name of ["reviewer", "acceptance"] as const) {
    for (const phrase of SELF_EDIT_FORBIDDEN) {
      test(`${name}.md 不含要求自身改文件的指令: ${phrase}`, async () => {
        const definition = await loadDefinition(name);
        expect(definition.body).not.toContain(phrase);
      });
    }
  }

  const SPEC_LEAK_FORBIDDEN = [".bb-spec/docs/spec", "C-1"];
  for (const name of Object.keys(ROLE_FILES) as RoleName[]) {
    for (const phrase of SPEC_LEAK_FORBIDDEN) {
      test(`${name}.md 不含 spec 溯源标记: ${phrase}`, async () => {
        const definition = await loadDefinition(name);
        expect(definition.body).not.toContain(phrase);
      });
    }
  }

  test("acceptance.md 不将 commands 列为裁决字段", async () => {
    const definition = await loadDefinition("acceptance");
    expect(definition.body).not.toContain("commands");
  });
});
