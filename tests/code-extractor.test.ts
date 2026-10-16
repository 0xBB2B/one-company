import { describe, expect, test } from "vitest";
import {
  CODE_EXTRACTOR_BUDGET,
  CODE_EXTRACTOR_COORDINATES,
  extractCode,
  getCodeExtractorVersion,
} from "../src/modules/project-index/code-extractor.ts";
import type { CodeRange } from "../src/modules/project-index/code-extractor.ts";
import type { SyntaxLanguage } from "../src/modules/project-index/syntax-parser.ts";

function position(source: string, offset: number) {
  const before = source.slice(0, offset);
  const line = before.split("\n").length - 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { offset, line, column: offset - lineStart };
}

function markedRange(source: string, text: string, occurrence = 0): CodeRange {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    start = source.indexOf(text, from);
    if (start < 0) throw new Error(`测试标记不存在：${text}`);
    from = start + text.length;
  }
  return { start: position(source, start), end: position(source, start + text.length) };
}

function symbolSummary(result: Awaited<ReturnType<typeof extractCode>>) {
  return result.symbols.map(({ name, kind, qualifiedName }) => ({ name, kind, qualifiedName }));
}

describe("首批代码结构提取", () => {
  test("TS：提取函数、箭头、类/方法、接口、类型及真实 UTF-16/CRLF 范围", async () => {
    const source = [
      "// 中文😀 function fake() {}",
      "const text = 'class Decoy {} 😀'; export function helper() { return 1; }",
      "export interface Shape { size: number }",
      "export type ShapeId = string;",
      "export class Box { method() { return helper(); } }",
      "export const run = () => helper();",
    ].join("\r\n");
    const result = await extractCode({ path: "src/中文😀.ts", language: "ts", source });

    expect(result.status).toBe("complete");
    expect(result.coordinates).toEqual(CODE_EXTRACTOR_COORDINATES);
    expect(symbolSummary(result)).toEqual([
      { name: "helper", kind: "function", qualifiedName: undefined },
      { name: "Shape", kind: "interface", qualifiedName: undefined },
      { name: "ShapeId", kind: "type", qualifiedName: undefined },
      { name: "Box", kind: "class", qualifiedName: undefined },
      { name: "method", kind: "method", qualifiedName: "Box.method" },
      { name: "run", kind: "arrow_function", qualifiedName: undefined },
    ]);
    expect(result.symbols.some((symbol) => ["fake", "Decoy"].includes(symbol.name))).toBe(false);

    const helper = result.symbols.find((symbol) => symbol.name === "helper")!;
    const helperText = "function helper() { return 1; }";
    expect(helper.range).toEqual(markedRange(source, helperText));
    expect(helper.selectionRange).toEqual(markedRange(source, "helper"));
    expect(source.slice(helper.range.start.offset, helper.range.end.offset)).toBe(helperText);
    expect(helper.range.start).toEqual({
      offset: source.indexOf(helperText),
      line: 1,
      column: "const text = 'class Decoy {} 😀'; export ".length,
    });

    const methodCall = result.references.find((reference) => reference.fromSymbolId === result.symbols.find((symbol) => symbol.name === "method")!.id)!;
    expect(methodCall).toMatchObject({
      name: "helper",
      targetSymbolId: helper.id,
      certainty: "certain",
      evidence: "lexical_same_file_direct_call",
    });
    expect(result.exports.map((entry) => entry.exported)).toEqual(["helper", "Shape", "ShapeId", "Box", "run"]);
  });

  test.each<Array<{ language: SyntaxLanguage; source: string; expected: Array<[string, string]> }>>([
    {
      language: "tsx",
      source: "export const App = () => <button onClick={() => run()}>中文😀</button>; function run() {}",
      expected: [["App", "arrow_function"], ["run", "function"]],
    },
    {
      language: "js",
      source: "const task = function () { return work(); }; function work() {} class Job { start() { task(); } } module.exports = task;",
      expected: [["task", "function"], ["work", "function"], ["Job", "class"], ["start", "method"]],
    },
    {
      language: "jsx",
      source: "export default function App() { return <div onClick={() => render()}>function fake(){}</div>; } function render() {}",
      expected: [["App", "function"], ["render", "function"]],
    },
  ])("$language：只从语法节点提取 JSX/JS 结构", async ({ language, source, expected }) => {
    const result = await extractCode({ path: `src/view.${language}`, language, source });
    expect(result.status).toBe("complete");
    expect(result.symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual(expected);
    expect(result.symbols.some((symbol) => symbol.name === "fake")).toBe(false);
    expect(result.references.filter((reference) => reference.certainty === "certain").length).toBeGreaterThan(0);
  });

  test("Go：提取函数、方法、类型、导入及按标识符规则导出", async () => {
    const source = [
      "package sample",
      "import (",
      "  f \"fmt\"",
      "  _ \"net/http\"",
      ")",
      "// func Fake() {}",
      "type Public struct { Name string }",
      "type private interface { run() }",
      "func helper() {}",
      "func Caller() { helper(); f.Println(\"中文😀\") }",
      "func (p *Public) Method() { Caller() }",
    ].join("\r\n");
    const result = await extractCode({ path: "pkg/sample.go", language: "go", source });

    expect(result.status).toBe("complete");
    expect(symbolSummary(result)).toEqual([
      { name: "Public", kind: "type", qualifiedName: undefined },
      { name: "private", kind: "type", qualifiedName: undefined },
      { name: "helper", kind: "function", qualifiedName: undefined },
      { name: "Caller", kind: "function", qualifiedName: undefined },
      { name: "Method", kind: "method", qualifiedName: "Public.Method" },
    ]);
    expect(result.imports.map(({ module, bindings }) => ({ module, bindings }))).toEqual([
      { module: "fmt", bindings: [{ imported: "*", local: "f", kind: "namespace" }] },
      { module: "net/http", bindings: [{ imported: "*", local: null, kind: "side_effect" }] },
    ]);
    expect(result.exports.map((entry) => entry.exported)).toEqual(["Public", "Caller", "Method"]);
    const helper = result.symbols.find((symbol) => symbol.name === "helper")!;
    expect(result.references.find((reference) => reference.name === "helper")).toMatchObject({
      targetSymbolId: helper.id,
      certainty: "certain",
    });
    expect(result.references.find((reference) => reference.name === "Println")).toMatchObject({
      targetSymbolId: null,
      certainty: "unknown",
      evidence: "dynamic_or_member_call",
    });
  });

  test("导入导出保留模块字符串和语法依据", async () => {
    const source = [
      "import main, { local as renamed } from 'safe/module';",
      "export { renamed as publicName } from \"other/module\";",
      "export * from './all.js';",
      "export const outer = () => { const hidden = 1; };",
    ].join("\n");
    const result = await extractCode({ path: "src/module.ts", language: "ts", source });

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({
      module: "safe/module",
      syntax: "import_statement",
      bindings: [
        { imported: "default", local: "main", kind: "default" },
        { imported: "local", local: "renamed", kind: "named" },
      ],
    });
    expect(result.exports.map(({ exported, local, module, syntax }) => ({ exported, local, module, syntax }))).toEqual([
      { exported: "publicName", local: "renamed", module: "other/module", syntax: "export_statement" },
      { exported: "*", local: "*", module: "./all.js", syntax: "export_statement" },
      { exported: "outer", local: "outer", module: null, syntax: "export_statement" },
    ]);
    expect(result.exports.some((entry) => entry.exported === "hidden")).toBe(false);
  });

  test("仅把可证明的同文件词法直接调用标为确定，遮蔽、外部和成员调用保持 unknown", async () => {
    const source = [
      "import { remote } from 'pkg';",
      "function target() {}",
      "function direct() { target(); const inner = () => target(); inner(); }",
      "function parameterShadow(target: () => void) { target(); }",
      "function localShadow() { const target = remote; target(); }",
      "function varShadow() { { var target = remote; } target(); }",
      "remote();",
      "service.target();",
      "injected();",
    ].join("\n");
    const result = await extractCode({ path: "src/calls.ts", language: "ts", source });
    const target = result.symbols.find((symbol) => symbol.name === "target")!;
    const inner = result.symbols.find((symbol) => symbol.name === "inner")!;

    const certainTargets = result.references.filter((reference) => reference.certainty === "certain");
    expect(certainTargets.filter((reference) => reference.targetSymbolId === target.id)).toHaveLength(2);
    expect(certainTargets.find((reference) => reference.name === "inner")).toMatchObject({ targetSymbolId: inner.id });
    expect(result.references.filter((reference) => reference.name === "target" && reference.evidence === "lexical_shadow")).toHaveLength(3);
    expect(result.references.find((reference) => reference.name === "remote")).toMatchObject({
      targetSymbolId: null,
      certainty: "unknown",
      evidence: "external_binding",
    });
    expect(result.references.find((reference) => reference.name === "target" && reference.evidence === "dynamic_or_member_call")).toMatchObject({
      targetSymbolId: null,
      certainty: "unknown",
    });
    expect(result.references.find((reference) => reference.name === "injected")).toMatchObject({
      targetSymbolId: null,
      certainty: "unknown",
      evidence: "unresolved_identifier",
    });
  });

  test("无括号箭头参数遮蔽同名顶层函数，匿名回调隔断外层调用者归属", async () => {
    const shadowSource = "function run() {}\nconst apply = run => run();";
    const shadowResult = await extractCode({ path: "src/arrow-shadow.ts", language: "ts", source: shadowSource });
    const apply = shadowResult.symbols.find((symbol) => symbol.name === "apply")!;
    expect(shadowResult.references).toHaveLength(1);
    expect(shadowResult.references[0]).toMatchObject({
      name: "run",
      fromSymbolId: apply.id,
      targetSymbolId: null,
      certainty: "unknown",
      evidence: "lexical_shadow",
    });

    const callbackSource = "function run() {}\nfunction outer() { return () => run(); }";
    const callbackResult = await extractCode({ path: "src/callback.ts", language: "ts", source: callbackSource });
    const run = callbackResult.symbols.find((symbol) => symbol.name === "run")!;
    expect(callbackResult.references).toEqual([
      expect.objectContaining({
        name: "run",
        fromSymbolId: null,
        targetSymbolId: run.id,
        certainty: "certain",
      }),
    ]);
  });

  test("赋值、增强赋值、解构赋值和更新会保守污染可调用绑定", async () => {
    const source = [
      "function assigned() {}",
      "assigned = other; assigned();",
      "let augmented = () => {}; augmented += other; augmented();",
      "let arrayTarget = () => {}; [arrayTarget] = candidates; arrayTarget();",
      "let objectTarget = () => {}; ({ objectTarget } = candidate); objectTarget();",
      "let updated = () => {}; updated++; updated();",
      "function clean() {}",
      "function direct() { clean(); }",
    ].join("\n");
    const result = await extractCode({ path: "src/tainted.ts", language: "ts", source });

    for (const name of ["assigned", "augmented", "arrayTarget", "objectTarget", "updated"]) {
      expect(result.references.find((reference) => reference.name === name)).toMatchObject({
        targetSymbolId: null,
        certainty: "unknown",
        evidence: "tainted_callable_binding",
      });
    }
    const clean = result.symbols.find((symbol) => symbol.name === "clean")!;
    expect(result.references.find((reference) => reference.name === "clean")).toMatchObject({
      targetSymbolId: clean.id,
      certainty: "certain",
      evidence: "lexical_same_file_direct_call",
    });
  });

  test("循环写目标与循环局部声明不伪造确定调用", async () => {
    for (const operator of ["of", "in"]) {
      for (const target of ["target", "[target]", "{ target }"]) {
        const source = `function target() {}\nfor (${target} ${operator} callbacks) {}\ntarget();`;
        const result = await extractCode({ path: "src/loop.js", language: "js", source });
        expect(result.status).toBe("complete");
        expect(result.references.at(-1)).toMatchObject({ targetSymbolId: null, certainty: "unknown", evidence: "tainted_callable_binding" });
      }
    }
    for (const declaration of ["const", "let"]) {
      const source = `function target() {}\nfor (${declaration} target of callbacks) { target(); }\ntarget();`;
      const result = await extractCode({ path: "src/loop.ts", language: "ts", source });
      expect(result.references[0]).toMatchObject({ targetSymbolId: null, certainty: "unknown", evidence: "lexical_shadow" });
      expect(result.references[1]).toMatchObject({ targetSymbolId: result.symbols[0]!.id, certainty: "certain" });
    }
    const variable = await extractCode({ path: "src/loop.js", language: "js", source: "function target() {}\nfor (var target of callbacks) {}\ntarget();" });
    expect(variable.references.at(-1)).toMatchObject({ targetSymbolId: null, certainty: "unknown" });
  });

  test("Go range、接收和类型switch声明在对应作用域遮蔽包级函数", async () => {
    for (const body of [
      "for target := range callbacks { target() }",
      "select { case target := <-callbacks: target() }",
      "switch target := value.(type) { case func(): target() }",
    ]) {
      const source = `package p\nfunc target(){}\nfunc caller(callbacks <-chan func(), value any) { ${body}; target() }`;
      const result = await extractCode({ path: "pkg/bindings.go", language: "go", source });
      expect(result.status).toBe("complete");
      expect(result.references[0]).toMatchObject({ targetSymbolId: null, certainty: "unknown", evidence: "lexical_shadow" });
      expect(result.references[1]).toMatchObject({ targetSymbolId: result.symbols.find(s => s.name === "target")!.id, certainty: "certain" });
    }
    const assigned = await extractCode({ path: "pkg/range.go", language: "go", source: "package p\nfunc target(){}\nfunc caller(callbacks <-chan func()){for target = range callbacks {}; target()}" });
    expect(assigned.references.at(-1)).toMatchObject({ targetSymbolId: null, certainty: "unknown", evidence: "tainted_callable_binding" });
  });

  test("Go初始化表达式使用外层名字，局部绑定只在规范作用域内生效", async () => {
    const cases = [
      { result: "<-chan func()", body: "for target := range target() { target() }" },
      { result: "<-chan func()", body: "select { case target := <-target(): target() }" },
      { result: "any", body: "switch target := target().(type) { case func(): target(); default: _ = target }" },
      { result: "func()", body: "{ target := target(); target() }" },
      { result: "func()", body: "{ var target = target(); target() }" },
    ];
    for (const sample of cases) {
      const source = `package p\nfunc target() ${sample.result} { return nil }\nfunc caller(){ ${sample.body}; target() }`;
      const result = await extractCode({ path: "pkg/visibility.go", language: "go", source });
      expect(result.status).toBe("complete");
      expect(result.references).toHaveLength(3);
      const target = result.symbols.find(symbol => symbol.name === "target")!.id;
      expect(result.references[0]).toMatchObject({ targetSymbolId: target, certainty: "certain" });
      expect(result.references[1]).toMatchObject({ targetSymbolId: null, certainty: "unknown", evidence: "lexical_shadow" });
      expect(result.references[2]).toMatchObject({ targetSymbolId: target, certainty: "certain" });
    }
  });

  test("Go匿名函数隔离参数与调用者，不沿用外层函数", async () => {
    const source = "package p\nfunc target(){}\nfunc outer(){ cb:=func(target func()){target()}; _=cb }";
    const result = await extractCode({ path: "pkg/callback.go", language: "go", source });
    expect(result.status).toBe("complete");
    expect(result.references).toEqual([expect.objectContaining({ fromSymbolId: null, targetSymbolId: null, certainty: "unknown", evidence: "lexical_shadow" })]);
  });

  test("Go 具名返回参数与顶层函数同名时按词法遮蔽处理", async () => {
    const source = "package sample\nfunc run() {}\nfunc outer() (run func()) { run(); return }";
    const result = await extractCode({ path: "pkg/shadow.go", language: "go", source });
    const outer = result.symbols.find((symbol) => symbol.name === "outer")!;
    expect(result.references).toEqual([
      expect.objectContaining({
        name: "run",
        fromSymbolId: outer.id,
        targetSymbolId: null,
        certainty: "unknown",
        evidence: "lexical_shadow",
      }),
    ]);
  });

  test("语法错误返回 partial 和固定范围诊断，不用错误片段伪造结构", async () => {
    const source = "function valid() {}\r\nexport function { 中文😀";
    const result = await extractCode({ path: "src/broken.ts", language: "ts", source });

    expect(result.status).toBe("partial");
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["valid"]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((diagnostic) => ["code", "severity", "range"].every((key) => key in diagnostic))).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "syntax_error" || diagnostic.code === "missing_syntax")).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain("中文");
  });

  test("已取消或加载边界发生取消时抛出明确错误，不返回 complete 或 partial", async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(extractCode({ path: "src/cancel.ts", language: "ts", source: "function nope() {}", signal: alreadyCancelled.signal }))
      .rejects.toMatchObject({ name: "AbortError", code: "cancelled" });

    const cancelledDuringLoad = new AbortController();
    const extraction = extractCode({ path: "src/cancel.go", language: "go", source: "package p\nfunc Nope() {}", signal: cancelledDuringLoad.signal });
    cancelledDuringLoad.abort();
    await expect(extraction).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
  });

  test("同一输入的结果和 ID 确定，版本按语言绑定固定运行时与语法", async () => {
    const input = { path: "src/stable.tsx", language: "tsx" as const, source: "export const App = () => helper(); function helper() {}" };
    const first = await extractCode(input);
    const second = await extractCode(input);

    expect(second).toEqual(first);
    expect(first.extractorVersion).toBe(getCodeExtractorVersion("tsx"));
    expect(getCodeExtractorVersion("tsx")).toContain("code-extractor@5");
    expect(getCodeExtractorVersion("tsx")).toContain("web-tree-sitter@0.27.0");
    expect(getCodeExtractorVersion("tsx")).toContain("tree-sitter-typescript@0.23.2:tsx");
    expect(getCodeExtractorVersion("go")).toContain("tree-sitter-go@0.25.0:go");
    expect(getCodeExtractorVersion("ts")).not.toBe(getCodeExtractorVersion("tsx"));
    expect(new Set(first.symbols.map((symbol) => symbol.id)).size).toBe(first.symbols.length);
  });

  test("公开深度预算超限时保守返回 partial", async () => {
    const nesting = CODE_EXTRACTOR_BUDGET.maxDepth + 8;
    const source = `function deep() { return ${"(".repeat(nesting)}1${")".repeat(nesting)}; }`;
    const result = await extractCode({ path: "src/deep.ts", language: "ts", source });
    expect(result.status).toBe("partial");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "depth_budget_exceeded", severity: "warning" }));
  });
});
