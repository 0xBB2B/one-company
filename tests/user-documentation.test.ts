import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const README = join(PACKAGE_ROOT, "README.md");
const DAEMON_MAIN = join(PACKAGE_ROOT, "daemon/main.ts");
const COMMANDS = join(PACKAGE_ROOT, "extensions/commands.ts");
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const SETTINGS_UI = join(PACKAGE_ROOT, "runtime/settings-ui.ts");
const IDENTITY = join(PACKAGE_ROOT, "runtime/identity.ts");
const PM_PANEL = join(PACKAGE_ROOT, "runtime/pm-panel.ts");

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
  "PM 面板",
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

describe("README PM 面板事实与 runtime/pm-panel.ts 一致", () => {
  test("面板按键提示中的每个按键都在 README 中说明", async () => {
    const source = await readText(PM_PANEL);
    const hint = source.match(/const HINT = "([^"]+)"/)?.[1];
    expect(hint).toBeDefined();
    const section = extractSection(await readText(README), "PM 面板");
    for (const key of ["↑↓", "Enter", "p", "Esc"]) {
      expect(hint).toContain(key);
      expect(section).toContain(key);
    }
  });

  test("说明决策包不是用户决定、只有用户亲手输入的话才算", async () => {
    const section = extractSection(await readText(README), "PM 面板");
    expect(section).toContain("决策包");
    expect(section).toContain("亲手输入");
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
