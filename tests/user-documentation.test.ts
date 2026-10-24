import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const README = join(PACKAGE_ROOT, "README.md");
const CONTRIBUTING = join(PACKAGE_ROOT, "CONTRIBUTING.md");
const DAEMON_MAIN = join(PACKAGE_ROOT, "src/app/daemon/main.ts");
const COMMAND_SOURCES = [join(PACKAGE_ROOT, "src/app/extension/commands.ts"), join(PACKAGE_ROOT, "src/modules/interaction/requirement-manage-extension.ts")];
const readCommandSources = async () => (await Promise.all(COMMAND_SOURCES.map(readText))).join("\n");
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const IDENTITY = join(PACKAGE_ROOT, "src/core/storage/identity.ts");
const PM_PANEL = join(PACKAGE_ROOT, "src/modules/panel/pm-panel.ts");

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function extractH2Headings(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.match(/^##\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1].trim());
}

function extractSection(body: string, sectionName: string, level = 2): string {
  const lines = body.split("\n");
  let capturing = false;
  const buffer: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^(#+)\s+(.+)$/);
    if (headingMatch && headingMatch[1].length <= level) {
      if (capturing) break;
      if (headingMatch[1].length === level && headingMatch[2].trim() === sectionName) capturing = true;
      continue;
    }
    if (capturing) buffer.push(line);
  }
  return buffer.join("\n");
}

const REQUIRED_SECTION_ORDER = [
  "前置条件",
  "安装",
  "上手",
  "功能",
  "设置",
  "设计规范样例",
  "原理",
  "已知限制",
  "常见问题",
];

describe("README 二级标题", () => {
  for (const heading of REQUIRED_SECTION_ORDER) {
    test(`存在标题: ${heading}`, async () => {
      const body = await readText(README);
      expect(extractH2Headings(body)).toContain(heading);
    });
  }

  test("顺序与规定一致", async () => {
    const body = await readText(README);
    const headings = extractH2Headings(body);
    const indices = REQUIRED_SECTION_ORDER.map((heading) => headings.indexOf(heading));
    for (const index of indices) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });
});

describe("README 必需句", () => {
  const REQUIRED = [
    "/one:setting",
    "/one:ps",
    "每个仓库一个守护进程",
    "自动启动",
    "空闲后自动退出",
    "标记为中断",
    "合盖睡眠",
    "background: true",
    "不随 Git 同步",
    "按启动目录",
    "pi install git:github.com/0xBB2B/one-company",
    "pi remove",
    "Node",
    "Git ≥ 2.38",
    "仅本地",
    "merge-methods",
    "Default to pull request title and description",
    "Allow auto-merge",
    "Squash commit message template",
    "--diff-filter=A",
    "examples/golang/",
    "examples/vue/",
    "~/.pi/agent/git/github.com/0xBB2B/one-company/examples/",
    "[设计规范样例](#设计规范样例)",
    "~/.pi/agent/skills/",
    ".pi/skills/",
    "~/.pi/agent/agents/",
    ".pi/agents/",
    "/one:examples",
    "| `/one:examples` | 把 Go、Vue 设计规范样例复制到用户层或项目层 |",
    "你的个人规范；`/one:examples` 经你确认后会在末尾追加样例那一段",
  ];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readText(README);
      expect(body).toContain(phrase);
    });
  }
});

describe("README 禁止句", () => {
  const FORBIDDEN = ["pi-subagents", "符号链接", "/spec-new", "推荐用 rebase", "PR 用哪种方式合并", "开启 Git 交付", "`true` 或 `false`", "只读不写"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readText(README);
      expect(body).not.toContain(phrase);
    });
  }

});

describe("ARCHITECTURE 样例说明", () => {
  const ARCHITECTURE = join(PACKAGE_ROOT, "ARCHITECTURE.md");

  test("不含: 程序不读", async () => {
    expect(await readText(ARCHITECTURE)).not.toContain("程序不读");
  });

  test("含: /one:examples 把它们复制到用户层或项目层", async () => {
    expect(await readText(ARCHITECTURE)).toContain("`/one:examples` 把它们复制到用户层或项目层");
  });
});

describe("README 仓库合并设置提示框", () => {
  test("提示框放在「前置条件」之后、「安装」之前", async () => {
    const body = await readText(README);
    const box = body.indexOf("> [!IMPORTANT]");
    expect(box).toBeGreaterThan(body.indexOf("## 前置条件"));
    expect(box).toBeLessThan(body.indexOf("## 安装"));
    expect(body.slice(box, body.indexOf("## 安装"))).toContain("Squash commit message template");
  });
});

describe("README 常量与实际代码一致", () => {
  test("计划被拒的待裁决示例按实际次数写阿拉伯数字，与待处理事项文字一致", async () => {
    expect(await readText(README)).toContain("待裁决：PM 计划 2 次提交被拒");
  });

  test("空闲退出时限与守护进程默认空闲常量一致", async () => {
    const source = await readText(DAEMON_MAIN);
    const match = source.match(/Number\(raw \?\? "(\d+)"\)/);
    expect(match).not.toBeNull();
    const idleMs = Number(match![1]);
    const idleMinutes = idleMs / 60_000;
    expect(Number.isInteger(idleMinutes)).toBe(true);
    const body = await readText(README);
    expect(body).toContain(`${idleMinutes} 分钟`);
  });

  test("Node 版本号与 package.json 的 engines.node 一致", async () => {
    const packageJson = JSON.parse(await readText(PACKAGE_JSON)) as { engines?: { node?: string } };
    const rawVersion = packageJson.engines?.node;
    expect(rawVersion).toBeTruthy();
    const versionMatch = rawVersion!.match(/(\d+\.\d+)/);
    expect(versionMatch).not.toBeNull();
    const body = await readText(README);
    expect(body).toContain(versionMatch![1]);
  });

  test("命令表覆盖扩展注册的全部入口名，且不出现未注册的入口", async () => {
    const source = await readCommandSources();
    const registered = [...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(registered).toEqual(["one:setting", "one:examples", "one:ps"].sort());

    const body = await readText(README);
    for (const name of registered) {
      const expected = `/${name}`;
      expect(body).toContain(expected);
    }
  });

  test("README 中出现的全部 /one: 命令都在已注册命令集合内", async () => {
    const source = await readCommandSources();
    const registered = new Set([...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]));
    const body = await readText(README);
    const mentioned = new Set([...body.matchAll(/\/one:([a-zA-Z-]+)/g)].map((match) => `one:${match[1]}`));
    for (const name of mentioned) expect(registered.has(name)).toBe(true);
  });
});

describe("旧命令与旧页面已清除", () => {
  const SEARCHED = ["README.md", "CONTRIBUTING.md", "rules", "shared", "role-rules", "skills", "src"];

  async function filesUnder(path: string): Promise<string[]> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries) return [path];
    const nested = await Promise.all(entries.map((entry) => filesUnder(join(path, entry.name))));
    return nested.flat();
  }

  for (const command of ["/one:agents", "/one:git-delivery"]) {
    test(`文档、提示词和源码里搜不到 ${command}`, async () => {
      const files = (await Promise.all(SEARCHED.map((name) => filesUnder(join(PACKAGE_ROOT, name))))).flat();
      const hits: string[] = [];
      for (const file of files) if ((await readText(file)).includes(command)) hits.push(file.slice(PACKAGE_ROOT.length + 1));
      expect(hits).toEqual([]);
    });
  }

  test("主代理提示词按远程档位和仅本地档位两档说 Git 交付", async () => {
    const rules = await readText(join(PACKAGE_ROOT, "rules/01-main-session.md"));
    expect(rules).toContain("Git 交付在远程档位时");
    expect(rules).toContain("仅本地档位");
    expect(rules).not.toContain("开关里开启 Git 交付");
    expect(rules).not.toContain("未开启时推送与合并由用户在外部操作");
  });

  test("主代理提示词的提问条目写明问题等文字不用我、你、您，指人写用户或角色，指自己写 AI", async () => {
    const line = (await readText(join(PACKAGE_ROOT, "rules/01-main-session.md"))).split("\n").find((text) => text.includes("**提问**"))!;
    expect(line).toMatch(/不用[^\n]{0,12}我[^\n]{0,6}你[^\n]{0,6}您/u);
    expect(line).toContain("用户");
    expect(line).toContain("角色");
    expect(line).toContain("AI");
  });

  test("主代理提示词的提问条目写明 answer.text 就是用户这一轮的原话", async () => {
    const line = (await readText(join(PACKAGE_ROOT, "rules/01-main-session.md"))).split("\n").find((text) => text.includes("**提问**"))!;
    expect(line).toContain("answer.text 就是用户这一轮的原话");
  });

  for (const phrase of ["设定栏", "右上角写着各层"]) {
    test(`README 里搜不到旧页面的说法：${phrase}`, async () => {
      expect(await readText(README)).not.toContain(phrase);
    });
  }

  test("README 说明新页面导航时写了 ← 回目录和 R 清除本层", async () => {
    const body = await readText(README);
    expect(body).toMatch(/←[^\n]{0,6}回目录/u);
    expect(body).toContain("R 清除本层");
  });

  test("旧的角色定义页源文件已不存在", () => {
    expect(existsSync(join(PACKAGE_ROOT, "src/modules/settings/agent-catalog-ui.ts"))).toBe(false);
  });
});

describe("验收单点数量", () => {
  test("AGENTS.md 和 CONTRIBUTING.md 里搜不到旧的单点数量，CONTRIBUTING.md 的编号表有 P14", async () => {
    const agents = await readText(join(PACKAGE_ROOT, "AGENTS.md"));
    const contributing = await readText(CONTRIBUTING);
    for (const text of [agents, contributing]) {
      expect(text).not.toContain("P1–P13");
      expect(text).not.toContain("13 个单点");
    }
    expect(contributing).toMatch(/^\| P14 \|/m);
  });
});

describe("README 状态面板事实与 src/modules/panel/pm-panel.ts 一致", () => {
  test("面板按键提示中的每个按键都在 README 中说明", async () => {
    const source = await readText(PM_PANEL);
    const hint = source.match(/const HINT = "([^"]+)"/)?.[1];
    expect(hint).toBeDefined();
    const section = extractSection(await readText(README), "状态面板", 3);
    for (const key of ["↑↓", "Enter", "p", "Esc"]) {
      expect(hint).toContain(key);
      expect(section).toContain(key);
    }
  });

  test("说明决策包不是用户决定，窗口里选中的固定选项、自己写的话或亲手输入的话才算", async () => {
    const section = extractSection(await readText(README), "状态面板", 3);
    expect(section).toContain("决策包");
    expect(section).toContain("亲手输入");
  });
});

describe("README 主代理提问", () => {
  test("M8D-AC9：说明提问窗口的内容、回车按推荐、Esc 暂不回答、窗口回答不能批准或裁决", async () => {
    const section = extractSection(await readText(README), "主代理提问", 3);
    for (const phrase of ["提问窗口", "根源自检", "2 到 4 个选项", "推荐理由", "其他（自己输入）", "直接按回车就是\"按推荐的来\"", "Esc 表示暂不回答", "不能用来批准需求或裁决事项"]) {
      expect(section, phrase).toContain(phrase);
    }
  });
});

describe("主代理规则提到待处理事项", () => {
  test("rules/01-main-session.md 写“待裁决”“待验收”，不出现“待你裁决”“待你验收”", async () => {
    const rules = await readText(join(PACKAGE_ROOT, "rules/01-main-session.md"));
    for (const phrase of ["待裁决", "待验收"]) expect(rules, phrase).toContain(phrase);
    for (const phrase of ["待你裁决", "待你验收"]) expect(rules, phrase).not.toContain(phrase);
  });
});

describe("README 设置", () => {
  test("说明只读查看、按职责分类、复制与三层覆盖及项目信任", async () => {
    const section = extractSection(await readText(README), "设置");
    for (const phrase of ["只读", "C 复制", "用户层", "项目层", "受信任", "不提供编辑"]) expect(section).toContain(phrase);
  });
});

describe("CONTRIBUTING 本地开发使用 pnpm install --frozen-lockfile", () => {
  test("本地安装段含: pnpm install --frozen-lockfile，不含: npm install", async () => {
    const section = extractSection(await readText(CONTRIBUTING), "本地安装");
    expect(section).toContain("pnpm install --frozen-lockfile");
    expect(section).not.toMatch(/(^|[^\w-])npm\s+install\b/);
  });

  test("含: pnpm test", async () => {
    expect(await readText(CONTRIBUTING)).toContain("pnpm test");
  });
});

describe("README 本机数据事实", () => {
  test("socket 路径与 identity.ts 的 daemonSocketPath 一致：sock/ 独立于按仓库分目录的列表，明确标为数据根一级", async () => {
    const source = await readText(IDENTITY);
    expect(source).toContain('join(dataRootPath, "sock"');
    const section = extractSection(await readText(README), "本机数据", 3);
    const sockSegment = section.split("、").find((segment) => segment.includes("sock"));
    expect(sockSegment).toBeDefined();
    expect(sockSegment).toContain("数据根");
  });

});

describe("README Shell 任务事实", () => {
  test("含: 本窗口主会话与本工作区守护进程", async () => {
    const section = extractSection(await readText(README), "Shell 任务", 3);
    expect(section).toContain("本窗口主会话与本工作区守护进程");
  });

  test("含: 工作区外不计入", async () => {
    const section = extractSection(await readText(README), "Shell 任务", 3);
    expect(section).toContain("工作区外不计入");
  });

  test("不含: 所有仓库", async () => {
    const section = extractSection(await readText(README), "Shell 任务", 3);
    expect(section).not.toContain("所有仓库");
  });
});
