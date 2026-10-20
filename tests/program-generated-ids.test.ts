import { expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const srcRoot = new URL("../src", import.meta.url).pathname;

test("两个工具说明与报错文案里没有“新生成”", async () => {
  const files = ["modules/interaction/requirement-manage-tool.ts", "modules/interaction/user-interact-tool.ts", "modules/requirement/host-authorization.ts",
    "modules/requirement/user-interaction-format.ts", "modules/requirement/short-decision-format.ts", "modules/pm/pm-intake-service.ts", "modules/pm/pm-intake-store.ts"];
  const withFreshText: string[] = [];
  for (const file of files) if ((await readFile(join(srcRoot, file), "utf8")).replace(/重新生成/g, "").includes("新生成")) withFreshText.push(file);
  expect(withFreshText).toEqual([]);
});

test("源码里没有 stale_operation_result", async () => {
  const entries = await readdir(srcRoot, { withFileTypes: true, recursive: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = join(entry.parentPath, entry.name);
    if ((await readFile(file, "utf8")).includes("stale_operation_result")) found.push(file);
  }
  expect(found).toEqual([]);
});
