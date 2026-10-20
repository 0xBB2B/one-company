import { describe, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type Violation = { file: string; reason: string };

async function listTsFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      files.push(full);
    }
  }
  return files;
}

const RELATIVE_IMPORT = /(?:import|export)\s+(?:[^"'()]*?\bfrom\s+)?["'](\.\.?\/[^"']+)["']/g;
const DYNAMIC_RELATIVE_IMPORT = /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']/g;
const EXPLICIT_EXTENSION = /\.(?:ts|mts|mjs|cjs)$/;

function findBadRelativeImports(content: string): string[] {
  const bad: string[] = [];
  for (const match of content.matchAll(RELATIVE_IMPORT)) {
    if (!EXPLICIT_EXTENSION.test(match[1])) bad.push(match[1]);
  }
  for (const match of content.matchAll(DYNAMIC_RELATIVE_IMPORT)) {
    if (!EXPLICIT_EXTENSION.test(match[1])) bad.push(match[1]);
  }
  return bad;
}

// node --check 不对 .ts 输入套用类型剥离，只有 stripTypeScriptTypes 能给出宿主 Node 的真实判定。
function checkNodeTypeStripping(content: string): string | null {
  try {
    stripTypeScriptTypes(content, { mode: "strip" });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function checkErasableSyntax(dir: string): Promise<{ checked: string[]; violations: Violation[] }> {
  const files = await listTsFiles(dir);
  const violations: Violation[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const spec of findBadRelativeImports(content)) {
      violations.push({ file, reason: `relative import 缺少显式扩展名: ${spec}` });
    }
    const stripError = checkNodeTypeStripping(content);
    if (stripError) violations.push({ file, reason: /\benum\b/i.test(stripError) ? "enum" : /\bnamespace\b/i.test(stripError) ? "namespace" : `node 类型剥离检查失败: ${stripError}` });
  }
  return { checked: files, violations };
}

describe("src/ 的可剥离语法检查", () => {
  test("src/ 全部文件通过可剥离语法检查（目录不存在时以零文件通过）", async () => {
    const result = await checkErasableSyntax(join(PACKAGE_ROOT, "src"));
    expect(result.violations).toEqual([]);
  }, 10_000);

  test("空临时目录以零文件通过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      const result = await checkErasableSyntax(dir);
      expect(result.checked.length).toBe(0);
      expect(result.violations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("合法文件通过检查（无 enum/namespace，相对 import 带 .ts 后缀）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "dep.ts"), "export const value = 1;\n");
      await writeFile(
        join(dir, "good.ts"),
        'import { value } from "./dep.ts";\nexport function useValue(): number {\n  return value;\n}\n',
      );
      const result = await checkErasableSyntax(dir);
      expect(result.checked.length).toBe(2);
      expect(result.violations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("含 enum 关键字的文件被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "bad-enum.ts"), "enum Color { Red, Green }\n");
      const result = await checkErasableSyntax(dir);
      expect(result.violations.some((v) => v.reason === "enum")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("含 namespace 关键字的文件被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "bad-namespace.ts"), "namespace Foo { export const x = 1; }\n");
      const result = await checkErasableSyntax(dir);
      expect(result.violations.some((v) => v.reason === "namespace")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("无 .ts 后缀的相对 import 被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "dep.ts"), "export const value = 1;\n");
      const badImportFile = join(dir, "bad-import.ts");
      await writeFile(badImportFile, 'import { value } from "./dep";\nexport { value };\n');
      const result = await checkErasableSyntax(dir);
      expect(result.violations.some((v) => v.file === badImportFile)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("类型剥离时语法错误的文件被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "bad-syntax.ts"), "export const value: = ;\n");
      const result = await checkErasableSyntax(dir);
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Node 类型剥离不支持的构造函数参数属性语法被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(
        join(dir, "param-property.ts"),
        "export class Foo {\n  constructor(private readonly bar: string) {}\n}\n",
      );
      const result = await checkErasableSyntax(dir);
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("无 .ts 后缀的动态相对 import 被判定为违规", async () => {
    const dir = await mkdtemp(join(tmpdir(), "one-company-erasable-"));
    try {
      await writeFile(join(dir, "dep.ts"), "export const value = 1;\n");
      const badImportFile = join(dir, "bad-dynamic-import.ts");
      await writeFile(badImportFile, 'export async function load() {\n  return await import("./dep");\n}\n');
      const result = await checkErasableSyntax(dir);
      expect(result.violations.some((v) => v.file === badImportFile)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
