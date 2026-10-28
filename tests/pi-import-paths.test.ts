import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const FORBIDDEN_PREFIXES = ["@earendil-works/pi-tui/", "@earendil-works/pi-coding-agent/", "@earendil-works/pi-agent-core/"];
const srcRoot = join(import.meta.dirname, "..", "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tsFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

test("src 下的文件不从 pi-tui、pi-coding-agent、pi-agent-core 的子路径导入", () => {
  const moduleNames = /(?:\bimport|\bexport)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
  const violations: string[] = [];
  for (const file of tsFiles(srcRoot)) {
    for (const match of readFileSync(file, "utf8").matchAll(moduleNames)) {
      const name = match[1] ?? match[2] ?? match[3]!;
      if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) violations.push(`${file}: ${name}`);
    }
  }
  expect(violations).toEqual([]);
});
