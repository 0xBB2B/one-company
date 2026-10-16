import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

const MODULE_DIRS = [
  "src/core/policy",
  "src/core/exec",
  "src/core/storage",
  "src/core/host",
  "src/modules/agents",
  "src/modules/requirement",
  "src/modules/prototype",
  "src/modules/verification",
  "src/modules/explore",
  "src/modules/settings",
  "src/modules/pm",
  "src/modules/delivery",
  "src/modules/panel",
  "src/modules/interaction",
  "src/modules/project-index",
  "src/modules/shell",
  "src/app/extension",
  "src/app/daemon",
];

const APP_RANK = MODULE_DIRS.length - 1;

function moduleOf(relPath: string): { name: string; rank: number } | undefined {
  const index = MODULE_DIRS.findIndex((dir) => relPath.startsWith(`${dir}/`));
  if (index === -1) return undefined;
  const dir = MODULE_DIRS[index];
  if (dir.startsWith("src/app/")) return { name: "app", rank: APP_RANK };
  const name = dir.startsWith("src/core/") ? dir.slice("src/".length) : dir.slice("src/modules/".length);
  return { name, rank: index };
}

async function listSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return listSources(full);
      return /\.(ts|mts|mjs)$/.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

const REFERENCE_PATTERNS = [
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["'](\.{1,2}\/[^"']*)["']/g,
  /\bimport\s*["'](\.{1,2}\/[^"']*)["']/g,
  /\bimport\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g,
  /\bnew\s+URL\(\s*["'](\.{1,2}\/[^"']*)["']\s*,\s*import\.meta\.url/g,
];

async function scanModuleDependencies(root: string): Promise<{ violations: string[]; strayFiles: string[] }> {
  const files = (await listSources(join(root, "src"))).map((file) => relative(root, file).split(sep).join("/")).sort();
  const violations: string[] = [];
  const strayFiles: string[] = [];
  for (const file of files) {
    const from = moduleOf(file);
    if (!from) {
      strayFiles.push(`${file} 不在任何模块目录里`);
      continue;
    }
    const content = await readFile(join(root, file), "utf8");
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const target = relative(root, resolve(root, dirname(file), match[1])).split(sep).join("/");
        const to = moduleOf(target);
        if (!to || to.rank <= from.rank) continue;
        const line = content.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${line} 引用了上层模块 ${to.name}（${target}）`);
      }
    }
  }
  return { violations, strayFiles };
}

describe("真实仓库的模块依赖方向", () => {
  let scan: Awaited<ReturnType<typeof scanModuleDependencies>>;

  beforeAll(async () => {
    scan = await scanModuleDependencies(REPO_ROOT);
  });

  test("没有下层模块引用上层模块", () => {
    expect(scan.violations).toEqual([]);
  });

  test("src/ 下没有散落在模块目录之外的文件", () => {
    expect(scan.strayFiles).toEqual([]);
  });

  test("src/core/ 下的文件没有引用 src/modules/ 或 src/app/", () => {
    const coreToUpper = scan.violations.filter(
      (message) => message.startsWith("src/core/") && /（src\/(modules|app)\//.test(message),
    );
    expect(coreToUpper).toEqual([]);
  });
});

describe("样例目录树的模块依赖检查", () => {
  let root: string;

  async function put(relPath: string, content = "export const x = 1;\n"): Promise<void> {
    const full = join(root, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  beforeAll(async () => {
    root = await mkdtemp(join("/tmp", "pi-t-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function scanFresh(files: Record<string, string>) {
    await rm(join(root, "src"), { recursive: true, force: true });
    for (const [path, content] of Object.entries(files)) await put(path, content);
    return scanModuleDependencies(root);
  }

  test("下层模块 import 上层模块时报错", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'import { x } from "../pm/b.ts";\n',
      "src/modules/pm/b.ts": "export const x = 1;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"]);
    expect(result.strayFiles).toEqual([]);
  });

  test("import type 同样检查", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'import type { X } from "../pm/b.ts";\n',
      "src/modules/pm/b.ts": "export type X = number;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test("export type ... from 同样检查", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'export type { X } from "../pm/b.ts";\n',
      "src/modules/pm/b.ts": "export type X = number;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test.each([
    ['无绑定 import', 'import "../pm/b.ts";\n'],
    ['export { x } from', 'export { x } from "../pm/b.ts";\n'],
    ['export * from', 'export * from "../pm/b.ts";\n'],
  ])("%s 同样检查", async (_name, content) => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": content,
      "src/modules/pm/b.ts": "export const x = 1;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test("一个文件里的多处违规全部列出且行号正确", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'import { x } from "../pm/b.ts";\nconst y = 2;\nimport { z } from "../../app/daemon/c.ts";\n',
      "src/modules/pm/b.ts": "export const x = 1;\n",
      "src/app/daemon/c.ts": "export const z = 1;\n",
    });
    expect(result.violations).toEqual([
      "src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）",
      "src/modules/requirement/a.ts:3 引用了上层模块 app（src/app/daemon/c.ts）",
    ]);
  });

  test("多行 import 的行号是 import 那一行", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'const y = 2;\nimport {\n  a,\n  b,\n} from "../pm/b.ts";\n',
      "src/modules/pm/b.ts": "export const a = 1;\nexport const b = 2;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:2 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test("动态 import() 能抓到", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'const y = 2;\nconst m = await import("../pm/b.ts");\n',
      "src/modules/pm/b.ts": "export const x = 1;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:2 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test("new URL(..., import.meta.url) 能抓到", async () => {
    const result = await scanFresh({
      "src/modules/requirement/a.ts": 'const u = new URL("../pm/b.ts", import.meta.url);\n',
      "src/modules/pm/b.ts": "export const x = 1;\n",
    });
    expect(result.violations).toEqual(["src/modules/requirement/a.ts:1 引用了上层模块 pm（src/modules/pm/b.ts）"]);
  });

  test("引用同模块和下层模块不报错", async () => {
    const result = await scanFresh({
      "src/modules/pm/c.ts":
        'import { r } from "../requirement/r.ts";\nimport { d } from "./d.ts";\nimport { e } from "../../core/exec/e.ts";\n',
      "src/modules/requirement/r.ts": "export const r = 1;\n",
      "src/modules/pm/d.ts": "export const d = 1;\n",
      "src/core/exec/e.ts": "export const e = 1;\n",
    });
    expect(result.violations).toEqual([]);
    expect(result.strayFiles).toEqual([]);
  });

  test("包名引用不检查", async () => {
    const result = await scanFresh({
      "src/core/policy/p.ts": 'import { Type } from "typebox";\nimport { readFile } from "node:fs/promises";\n',
    });
    expect(result.violations).toEqual([]);
  });

  test("app 层可以引用任意模块", async () => {
    const result = await scanFresh({
      "src/app/daemon/d.ts":
        'import { r } from "../../modules/requirement/r.ts";\nimport { b } from "../../modules/pm/b.ts";\nimport { e } from "../extension/x.ts";\n',
      "src/modules/requirement/r.ts": "export const r = 1;\n",
      "src/modules/pm/b.ts": "export const b = 1;\n",
      "src/app/extension/x.ts": "export const x = 1;\n",
    });
    expect(result.violations).toEqual([]);
  });

  test("core 内部下层引用更下层不报错，反向报错并写 core/ 前缀", async () => {
    const result = await scanFresh({
      "src/core/exec/e.ts": 'import { p } from "../policy/p.ts";\n',
      "src/core/policy/p.ts": 'import { e } from "../exec/e.ts";\n',
    });
    expect(result.violations).toEqual(["src/core/policy/p.ts:1 引用了上层模块 core/exec（src/core/exec/e.ts）"]);
  });

  test("core 引用 modules 时报错", async () => {
    const result = await scanFresh({
      "src/core/host/h.ts": 'import { a } from "../../modules/agents/a.ts";\n',
      "src/modules/agents/a.ts": "export const a = 1;\n",
    });
    expect(result.violations).toEqual(["src/core/host/h.ts:1 引用了上层模块 agents（src/modules/agents/a.ts）"]);
  });

  test("直接放在 src/modules/ 下的文件算散落文件", async () => {
    const result = await scanFresh({ "src/modules/loose.ts": "export const x = 1;\n" });
    expect(result.strayFiles).toEqual(["src/modules/loose.ts 不在任何模块目录里"]);
  });

  test("放在清单之外目录里的文件算散落文件", async () => {
    const result = await scanFresh({ "src/modules/foo/x.ts": "export const x = 1;\n" });
    expect(result.strayFiles).toEqual(["src/modules/foo/x.ts 不在任何模块目录里"]);
  });

  test.each(["src/index.ts", "src/core/loose.mts", "src/app/loose.mjs"])("%s 算散落文件", async (path) => {
    const result = await scanFresh({ [path]: "export const x = 1;\n" });
    expect(result.strayFiles).toEqual([`${path} 不在任何模块目录里`]);
  });
});
