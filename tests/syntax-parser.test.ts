import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { Parser, Tree } from "web-tree-sitter";
import { verifySyntaxResources, withSyntaxTree } from "../src/modules/project-index/syntax-parser.ts";
import type { SyntaxLanguage } from "../src/modules/project-index/syntax-parser.ts";

const cases = JSON.parse(await readFile(new URL("./fixtures/syntax-cases.json", import.meta.url), "utf8")) as Array<{
  language: SyntaxLanguage; source: string; nodeType: string; name?: string; text?: string;
}>;

describe("固定语言的本机解析入口", () => {
  for (const fixture of cases) {
    test(`${fixture.language}：真实语法、Unicode/CRLF 坐标和注释隔离`, async () => {
      await withSyntaxTree(fixture.language, fixture.source, (tree) => {
        expect(tree.rootNode.hasError).toBe(false);
        const nodes = tree.rootNode.descendantsOfType(fixture.nodeType);
        expect(nodes).toHaveLength(1);
        const node = nodes[0]!;
        if (fixture.name) expect(node.childForFieldName("name")?.text).toBe(fixture.name);
        if (fixture.text) expect(node.text).toBe(fixture.text);
        expect(fixture.source.slice(node.startIndex, node.endIndex)).toBe(node.text);
        expect(node.startPosition.row).toBe(fixture.source.slice(0, node.startIndex).split("\n").length - 1);
      });
    });
  }

  test("不支持的语言、路径和对象原型键不能作为资源路径", async () => {
    for (const input of ["python", "typescript", "../go", "https://example.invalid/parser.wasm", "__proto__", "constructor"]) {
      await expect(withSyntaxTree(input as SyntaxLanguage, "", () => null)).rejects.toMatchObject({ code: "unsupported_language" });
    }
  });

  test("资源健康检查复用hash/版本/ABI核验且不创建解析树", async () => {
    const parse = Parser.prototype.parse;
    let parseCalls = 0;
    Parser.prototype.parse = function (...args: Parameters<typeof parse>) {
      parseCalls++;
      return parse.apply(this, args);
    };
    try {
      for (const language of ["ts", "tsx", "js", "jsx", "go"] as const) await verifySyntaxResources(language);
      expect(parseCalls).toBe(0);
      await expect(verifySyntaxResources("python" as SyntaxLanguage)).rejects.toMatchObject({ code: "unsupported_language" });
    } finally { Parser.prototype.parse = parse; }
  });

  test("语法错误保留在树中，不伪报有效源码", async () => {
    expect(await withSyntaxTree("ts", "export function {", (tree) => tree.rootNode.hasError)).toBe(true);
  });

  test("并发调用各自使用解析树", async () => {
    const values = await Promise.all(Array.from({ length: 20 }, (_, i) => withSyntaxTree("ts", `const v${i} = ${i};`, async (tree) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return tree.rootNode.text;
    })));
    expect(new Set(values).size).toBe(20);
  });

  test("正常、同步抛错、异步拒绝与 parse 失败均释放资源", async () => {
    await withSyntaxTree("js", "", () => null);
    const parserDelete = Parser.prototype.delete;
    const treeDelete = Tree.prototype.delete;
    const parse = Parser.prototype.parse;
    let parsers = 0;
    let trees = 0;
    Parser.prototype.delete = function () { parsers++; return parserDelete.call(this); };
    Tree.prototype.delete = function () { trees++; return treeDelete.call(this); };
    try {
      expect(await withSyntaxTree("js", "let x = 1;", async (tree) => {
        await Promise.resolve();
        expect(parsers).toBe(0);
        expect(trees).toBe(0);
        return tree.rootNode.type;
      })).toBe("program");
      await expect(withSyntaxTree("js", "", () => { throw new Error("inspect failure"); })).rejects.toThrow("inspect failure");
      await expect(withSyntaxTree("js", "", async () => { await Promise.resolve(); throw new Error("async failure"); })).rejects.toThrow("async failure");
      expect(trees).toBe(3);
      expect(parsers).toBe(3);
      Parser.prototype.parse = () => { throw new Error("parse failure"); };
      await expect(withSyntaxTree("js", "", () => null)).rejects.toThrow("parse failure");
      expect(trees).toBe(3);
      expect(parsers).toBe(4);
    } finally {
      Parser.prototype.delete = parserDelete;
      Tree.prototype.delete = treeDelete;
      Parser.prototype.parse = parse;
    }
    expect(await withSyntaxTree("js", "", (tree) => tree.rootNode.type)).toBe("program");
  });
});
