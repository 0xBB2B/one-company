import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Language, Tree } from "web-tree-sitter";

export type SyntaxLanguage = "ts" | "tsx" | "js" | "jsx" | "go";
type Grammar = "typescript" | "tsx" | "javascript" | "go";
type Binding = typeof import("web-tree-sitter");

const RUNTIME_VERSION = "0.27.0";
const GRAMMARS = {
  typescript: { package: "tree-sitter-typescript", version: "0.23.2" },
  tsx: { package: "tree-sitter-typescript", version: "0.23.2" },
  javascript: { package: "tree-sitter-javascript", version: "0.25.0" },
  go: { package: "tree-sitter-go", version: "0.25.0" },
} as const;
const require = createRequire(import.meta.url);
const resourceRoot = new URL("../../../resources/tree-sitter/", import.meta.url);

export type SyntaxResourceErrorCode = "unsupported_language" | "resource_missing" | "resource_invalid" | "resource_incompatible";

export class SyntaxResourceError extends Error {
  readonly code: SyntaxResourceErrorCode;
  constructor(code: SyntaxResourceErrorCode, resource: string) {
    super(`解析资源不可用（${code}）：${resource}；请核对安装包，不会自动下载或编译资源`);
    this.name = "SyntaxResourceError";
    this.code = code;
  }
}

interface Resource {
  package: string;
  version: string;
  file: string;
  sha256: string;
  abiVersion?: number;
}
interface Manifest { schemaVersion: number; runtime: Resource; grammars: Record<Grammar, Resource> }

async function bytesAt(path: string | URL, label: string): Promise<Buffer> {
  try { return await readFile(path); }
  catch (error) {
    throw new SyntaxResourceError((error as NodeJS.ErrnoException).code === "ENOENT" ? "resource_missing" : "resource_invalid", label);
  }
}

async function manifest(): Promise<Manifest> {
  const bytes = await bytesAt(new URL("manifest.json", resourceRoot), "manifest.json");
  let value: Manifest;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new SyntaxResourceError("resource_invalid", "manifest.json"); }
  if (!value || value.schemaVersion !== 1 || !value.grammars) throw new SyntaxResourceError("resource_invalid", "manifest.json");
  for (const [key, expected] of Object.entries({ runtime: { package: "web-tree-sitter", version: RUNTIME_VERSION }, ...GRAMMARS })) {
    const entry = key === "runtime" ? value.runtime : value.grammars[key as Grammar];
    const filename = key === "runtime" ? "web-tree-sitter.wasm" : `tree-sitter-${key}.wasm`;
    if (!entry || entry.file !== filename || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new SyntaxResourceError("resource_invalid", "manifest.json");
    }
    if (entry.package !== expected.package || entry.version !== expected.version ||
      (key !== "runtime" && (!Number.isInteger(entry.abiVersion) || entry.abiVersion! < 13 || entry.abiVersion! > 15))) {
      throw new SyntaxResourceError("resource_incompatible", filename);
    }
  }
  return value;
}

async function checkedBytes(path: string | URL, resource: Resource): Promise<Buffer> {
  const bytes = await bytesAt(path, resource.file);
  if (createHash("sha256").update(bytes).digest("hex") !== resource.sha256) {
    throw new SyntaxResourceError("resource_invalid", resource.file);
  }
  return bytes;
}

let bindingPromise: Promise<Binding> | undefined;
// 官方绑定不提供 Language 卸载；本模块实例最多缓存四份固定语法，不缓存源码或解析树。
const languages = new Map<Grammar, Promise<Language>>();

function grammarFor(language: SyntaxLanguage): Grammar {
  if (!["ts", "tsx", "js", "jsx", "go"].includes(language)) {
    throw new SyntaxResourceError("unsupported_language", "仅支持 ts/tsx/js/jsx/go");
  }
  return language === "ts" ? "typescript" : language === "js" || language === "jsx" ? "javascript" : language;
}

async function load(grammar: Grammar): Promise<{ binding: Binding; language: Language }> {
  const resources = await manifest();
  let runtimePath: string;
  try { runtimePath = require.resolve("web-tree-sitter/web-tree-sitter.wasm"); }
  catch { throw new SyntaxResourceError("resource_missing", "web-tree-sitter"); }
  let runtimeVersion: unknown;
  try { runtimeVersion = JSON.parse((await bytesAt(join(dirname(runtimePath), "package.json"), "web-tree-sitter/package.json")).toString("utf8")).version; }
  catch (error) {
    if (error instanceof SyntaxResourceError) throw error;
    throw new SyntaxResourceError("resource_invalid", "web-tree-sitter/package.json");
  }
  if (runtimeVersion !== RUNTIME_VERSION) throw new SyntaxResourceError("resource_incompatible", "web-tree-sitter");
  // 即使 WASM 已在内存中，每次使用仍核对安装资源；缓存不掩盖缺失或损坏。
  const [runtimeBytes, grammarBytes] = await Promise.all([
    checkedBytes(runtimePath, resources.runtime),
    checkedBytes(new URL(resources.grammars[grammar].file, resourceRoot), resources.grammars[grammar]),
  ]);
  bindingPromise ??= (async () => {
    try {
      const binding = await import("web-tree-sitter");
      await binding.Parser.init({ wasmBinary: runtimeBytes });
      return binding;
    } catch { throw new SyntaxResourceError("resource_incompatible", "web-tree-sitter"); }
  })();
  const pendingBinding = bindingPromise;
  let binding: Binding;
  try { binding = await pendingBinding; }
  catch (error) {
    if (bindingPromise === pendingBinding) bindingPromise = undefined;
    throw error;
  }
  let pending = languages.get(grammar);
  if (!pending) {
    pending = binding.Language.load(grammarBytes).catch(() => { throw new SyntaxResourceError("resource_incompatible", resources.grammars[grammar].file); });
    languages.set(grammar, pending);
  }
  let language: Language;
  try { language = await pending; }
  catch (error) {
    // 仅移除本次失败的加载，不能撤销另一个调用已开始的重试。
    if (languages.get(grammar) === pending) languages.delete(grammar);
    throw error;
  }
  if (language.abiVersion !== resources.grammars[grammar].abiVersion ||
    language.abiVersion < binding.MIN_COMPATIBLE_VERSION || language.abiVersion > binding.LANGUAGE_VERSION) {
    throw new SyntaxResourceError("resource_incompatible", resources.grammars[grammar].file);
  }
  return { binding, language };
}

/** 只核对随安装交付的运行时及语法资源，不创建Parser、Tree或解析业务源码。 */
export async function verifySyntaxResources(language: SyntaxLanguage): Promise<void> {
  await load(grammarFor(language));
}

/**
 * 仅解析调用方提供的源码字符串，不扫描文件、不登记工具或写入数据库。
 * inspect 可以异步执行；结束前应提取普通数据，不向外保留 Tree/Node/Cursor。
 * 坐标是 JS 字符串的 UTF-16 索引，不能当作 UTF-8 字节偏移。
 */
export async function withSyntaxTree<T>(language: SyntaxLanguage, source: string, inspect: (tree: Tree) => T | Promise<T>): Promise<T> {
  const grammar = grammarFor(language);
  if (typeof source !== "string" || typeof inspect !== "function") throw new TypeError("必须提供源码字符串和解析树读取函数");
  const loaded = await load(grammar);
  const parser = new loaded.binding.Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(loaded.language);
    tree = parser.parse(source);
    if (!tree) throw new Error("源码解析中断，没有生成解析树");
    return await inspect(tree);
  } finally {
    try { tree?.delete(); } finally { parser.delete(); }
  }
}
