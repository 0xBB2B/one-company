import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const README = join(PACKAGE_ROOT, "README.md");
const AGENTS_ACTIVITY = join(PACKAGE_ROOT, "runtime/agents-activity.ts");
const DAEMON_MAIN = join(PACKAGE_ROOT, "daemon/main.ts");
const COMMANDS = join(PACKAGE_ROOT, "extensions/commands.ts");
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const SETTINGS_UI = join(PACKAGE_ROOT, "runtime/settings-ui.ts");
const IDENTITY = join(PACKAGE_ROOT, "runtime/identity.ts");
const AGENTS_PANEL = join(PACKAGE_ROOT, "runtime/agents-panel.ts");

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

const REQUIRED_SECTION_ORDER = [
  "这是什么",
  "安装",
  "卸载",
  "快速开始",
  "守护进程",
  "面板与查看页",
  "角色与设置",
  "Shell 管理",
  "本机数据",
  "多窗口与工作区",
  "常见问题",
  "开发",
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
    "/pi-company:new",
    "/pi-company:setting",
    "/pi-company:ps",
    "每个仓库一个守护进程",
    "自动启动",
    "空闲后自动退出",
    "标记为中断",
    "合盖睡眠",
    "20 秒",
    "background: true",
    ".pi-company/",
    "不随 Git 同步",
    "按启动目录",
    "pi install git:github.com/0xBB2B/pi-company",
    "pi remove",
    "Node",
    "pnpm test",
  ];
  for (const phrase of REQUIRED) {
    test(`含: ${phrase}`, async () => {
      const body = await readText(README);
      expect(body).toContain(phrase);
    });
  }
});

describe("README 禁止句", () => {
  const FORBIDDEN = ["pi-subagents", "符号链接", "/spec-new"];
  for (const phrase of FORBIDDEN) {
    test(`不含: ${phrase}`, async () => {
      const body = await readText(README);
      expect(body).not.toContain(phrase);
    });
  }

});

describe("README 常量与实际代码一致", () => {
  test("20 秒面板保留期与 runtime/agents-activity.ts 的 RETENTION_MS 一致", async () => {
    const source = await readText(AGENTS_ACTIVITY);
    const match = source.match(/RETENTION_MS\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const retentionMs = Number(match![1].replace(/_/g, ""));
    const retentionSeconds = retentionMs / 1000;
    const body = await readText(README);
    expect(body).toContain(`${retentionSeconds} 秒`);
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

  test("命令表覆盖 extensions/commands.ts 注册的全部入口名，且不出现未注册的入口", async () => {
    const source = await readText(COMMANDS);
    const registered = [...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(registered).toEqual(["pi-company:new", "pi-company:resume", "pi-company:revise", "pi-company:setting", "pi-company:sync", "pi-company:ps"].sort());

    const body = await readText(README);
    for (const name of registered) {
      const expected = `/${name}`;
      expect(body).toContain(expected);
    }
  });

  test("README 中出现的全部 /pi-company: 命令都在已注册命令集合内", async () => {
    const source = await readText(COMMANDS);
    const registered = new Set([...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]));
    const body = await readText(README);
    const mentioned = new Set([...body.matchAll(/\/pi-company:([a-zA-Z-]+)/g)].map((match) => `pi-company:${match[1]}`));
    for (const name of mentioned) expect(registered.has(name)).toBe(true);
  });
});

describe("README 面板与查看页事实", () => {
  test("含 ←→ 按钮移动与 Enter 执行当前按钮", async () => {
    const section = extractSection(await readText(README), "面板与查看页");
    expect(section).toContain("←→");
    expect(section).toContain("Enter");
  });

  test("「查看」与 Enter 在同一句中共现", async () => {
    const section = extractSection(await readText(README), "面板与查看页");
    const sentence = section.split(/[。\n]/).find((candidate) => candidate.includes("Enter"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("「查看」");
  });

  test("已结束条目灰显与控制动作失败提示均独立说明保留 20 秒", async () => {
    const section = extractSection(await readText(README), "面板与查看页");
    expect(section).toContain("灰显");
    const occurrences = (section.match(/20 秒/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("按钮名与 agents-panel.ts 的 BUTTON_LABEL 动态一致，且不出现「恢复」", async () => {
    const source = await readText(AGENTS_PANEL);
    const match = source.match(/BUTTON_LABEL[^{]*\{([^}]*)\}/s);
    expect(match).not.toBeNull();
    const labels = [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    expect(labels).toEqual(["暂停", "停止"]);
    const section = extractSection(await readText(README), "面板与查看页");
    for (const label of labels) expect(section).toContain(label);
    expect(section).not.toContain("恢复");
  });
});

describe("README 角色与设置事实与 runtime/settings-ui.ts 一致", () => {
  test("含 settings-ui 字段表的全部可设字段标签", async () => {
    const source = await readText(SETTINGS_UI);
    const match = source.match(/FIELD_LABEL[^{]*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const labels = [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    expect(labels.length).toBeGreaterThan(0);
    const section = extractSection(await readText(README), "角色与设置");
    for (const label of labels) expect(section).toContain(label);
  });

  test("含来源只读说明与全局/项目范围切换", async () => {
    const section = extractSection(await readText(README), "角色与设置");
    expect(section).toContain("只读");
    expect(section).toContain("全局");
    expect(section).toContain("项目");
  });

  test("含: 受信任（项目级定义须项目受宿主信任才生效）", async () => {
    const section = extractSection(await readText(README), "角色与设置");
    expect(section).toContain("受信任");
  });
});

describe("README 安装段本地开发使用 pnpm install --frozen-lockfile", () => {
  test("含: pnpm install --frozen-lockfile，不含: npm install", async () => {
    const section = extractSection(await readText(README), "安装");
    expect(section).toContain("pnpm install --frozen-lockfile");
    expect(section).not.toMatch(/(^|[^\w-])npm\s+install\b/);
  });
});

describe("README 本机数据事实", () => {
  test("socket 路径与 identity.ts 的 daemonSocketPath 一致：sock/ 独立于按仓库分目录的列表，明确标为数据根一级", async () => {
    const source = await readText(IDENTITY);
    expect(source).toContain('join(dataRootPath, "sock"');
    const section = extractSection(await readText(README), "本机数据");
    const sockSegment = section.split("、").find((segment) => segment.includes("sock"));
    expect(sockSegment).toBeDefined();
    expect(sockSegment).toContain("数据根");
  });

});

describe("README Shell 管理事实", () => {
  test("含: 本窗口主会话与本工作区守护进程", async () => {
    const section = extractSection(await readText(README), "Shell 管理");
    expect(section).toContain("本窗口主会话与本工作区守护进程");
  });

  test("含: 工作区外不计入", async () => {
    const section = extractSection(await readText(README), "Shell 管理");
    expect(section).toContain("工作区外不计入");
  });

  test("不含: 所有仓库", async () => {
    const section = extractSection(await readText(README), "Shell 管理");
    expect(section).not.toContain("所有仓库");
  });
});
