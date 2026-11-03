import { describe, expect, test } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function workflow(): Promise<string> {
  return readFile(join(root, ".github", "workflows", "pages.yml"), "utf8");
}

function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim());
}

function triggerBlock(text: string): string {
  const match = text.match(/^on:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m);
  return match?.[1] ?? "";
}

function topLevelBlock(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+.*\\n?|[ \\t]*\\n)*)`, "m"));
  return match?.[1] ?? "";
}

describe("GitHub Pages 部署工作流", () => {
  test("只在推送到 main 且改了 site 或工作流自身时触发，另可手动运行", async () => {
    const trigger = lines(triggerBlock(await workflow())).filter((line) => line !== "");
    expect(trigger).toEqual(["push:", "branches: [main]", "paths:", '- "site/**"', '- ".github/workflows/pages.yml"', "workflow_dispatch:"]);
  });

  test("不响应 pull_request", async () => {
    expect(await workflow()).not.toMatch(/pull_request/);
  });

  test("上传步骤只发布 site 目录", async () => {
    expect(lines(await workflow())).toContain("path: site");
  });

  test("不装依赖也不构建：没有任何 run 步骤", async () => {
    expect(lines(await workflow()).filter((line) => /^-?\s*run:/.test(line))).toEqual([]);
  });

  test("权限只在顶层写一次，只有 contents 读、pages 写、id-token 写", async () => {
    const text = await workflow();
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(1);
    const entries = lines(topLevelBlock(text, "permissions")).filter((line) => line !== "");
    expect(entries.sort()).toEqual(["contents: read", "id-token: write", "pages: write"]);
  });

  test("同一时间只有一个部署且不取消进行中的部署", async () => {
    const block = lines(topLevelBlock(await workflow(), "concurrency")).filter((line) => line !== "");
    expect(block).toEqual(["group: pages", "cancel-in-progress: false"]);
  });

  test("用到的三个 Action 都写到完整版本号", async () => {
    const text = await workflow();
    const uses = lines(text)
      .filter((line) => /^-?\s*uses:/.test(line))
      .map((line) => line.replace(/^-?\s*uses:\s*/, "").trim());
    expect(uses.sort()).toEqual([
      "actions/checkout@v7.0.1",
      "actions/deploy-pages@v5.0.1",
      "actions/upload-pages-artifact@v5.0.0",
    ]);
    for (const use of uses) expect(use).toMatch(/@v\d+\.\d+\.\d+$/);
  });
});

describe("站点与发布包", () => {
  test("package.json 的 files 不含 site", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: string[] };
    const files = manifest.files ?? [];
    expect(files.filter((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, "").split("/")[0] === "site")).toEqual([]);
  });

  test("site 目录下没有 CNAME 文件", async () => {
    const entries = await readdir(join(root, "site"), { recursive: true });
    expect(entries.filter((entry) => entry.split("/").pop() === "CNAME")).toEqual([]);
  });
});
