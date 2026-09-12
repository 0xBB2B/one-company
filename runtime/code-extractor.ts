import { createHash } from "node:crypto";
import type { Node as SyntaxNode } from "web-tree-sitter";
import { withSyntaxTree } from "./syntax-parser.ts";
import type { SyntaxLanguage } from "./syntax-parser.ts";

export const CODE_EXTRACTOR_COORDINATES = {
  offsetEncoding: "utf16",
  lineBase: 0,
  columnBase: 0,
  endExclusive: true,
} as const;

export const CODE_EXTRACTOR_BUDGET = {
  maxNodes: 100_000,
  maxDepth: 256,
  maxDiagnostics: 100,
} as const;

const ALGORITHM_VERSION = "4";
const EXTRACTOR_VERSIONS: Record<SyntaxLanguage, string> = {
  ts: `code-extractor@${ALGORITHM_VERSION}:web-tree-sitter@0.27.0:tree-sitter-typescript@0.23.2:typescript`,
  tsx: `code-extractor@${ALGORITHM_VERSION}:web-tree-sitter@0.27.0:tree-sitter-typescript@0.23.2:tsx`,
  js: `code-extractor@${ALGORITHM_VERSION}:web-tree-sitter@0.27.0:tree-sitter-javascript@0.25.0:javascript`,
  jsx: `code-extractor@${ALGORITHM_VERSION}:web-tree-sitter@0.27.0:tree-sitter-javascript@0.25.0:jsx`,
  go: `code-extractor@${ALGORITHM_VERSION}:web-tree-sitter@0.27.0:tree-sitter-go@0.25.0:go`,
};

export interface CodePosition {
  offset: number;
  line: number;
  column: number;
}

/** UTF-16、零起始行列的半开区间。 */
export interface CodeRange {
  start: CodePosition;
  end: CodePosition;
}

export type CodeSymbolKind = "function" | "arrow_function" | "class" | "method" | "interface" | "type";

export interface CodeSymbol {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: CodeSymbolKind;
  range: CodeRange;
  selectionRange: CodeRange;
  syntax: string;
}

export interface CodeImportBinding {
  imported: string;
  local: string | null;
  kind: "default" | "named" | "namespace" | "side_effect";
}

export interface CodeImport {
  id: string;
  module: string;
  bindings: CodeImportBinding[];
  range: CodeRange;
  syntax: "import_statement" | "import_spec";
}

export interface CodeExport {
  id: string;
  exported: string;
  local: string | null;
  module: string | null;
  range: CodeRange;
  syntax: "export_statement" | "commonjs_assignment" | "go_exported_identifier";
}

export type CodeReferenceEvidence =
  | "lexical_same_file_direct_call"
  | "lexical_shadow"
  | "external_binding"
  | "ambiguous_binding"
  | "tainted_callable_binding"
  | "non_callable_binding"
  | "unresolved_identifier"
  | "dynamic_or_member_call";

export interface CodeReference {
  id: string;
  kind: "call";
  name: string | null;
  fromSymbolId: string | null;
  targetSymbolId: string | null;
  certainty: "certain" | "unknown";
  evidence: CodeReferenceEvidence;
  range: CodeRange;
  syntax: "call_expression";
}

export type CodeDiagnosticCode =
  | "syntax_error"
  | "missing_syntax"
  | "node_budget_exceeded"
  | "depth_budget_exceeded"
  | "diagnostic_budget_exceeded";

export interface CodeDiagnostic {
  code: CodeDiagnosticCode;
  severity: "error" | "warning";
  range: CodeRange;
}

export interface ExtractCodeInput {
  path: string;
  language: SyntaxLanguage;
  source: string;
  signal?: AbortSignal;
}

export interface ExtractCodeResult {
  path: string;
  language: SyntaxLanguage;
  extractorVersion: string;
  status: "complete" | "partial";
  coordinates: typeof CODE_EXTRACTOR_COORDINATES;
  symbols: CodeSymbol[];
  imports: CodeImport[];
  exports: CodeExport[];
  references: CodeReference[];
  diagnostics: CodeDiagnostic[];
}

export class CodeExtractionCancelledError extends Error {
  readonly code = "cancelled";

  constructor() {
    super("代码结构提取已取消");
    this.name = "AbortError";
  }
}

export function getCodeExtractorVersion(language: SyntaxLanguage): string {
  const version = EXTRACTOR_VERSIONS[language];
  if (!version) throw new TypeError("仅支持 ts/tsx/js/jsx/go 的提取版本");
  return version;
}

type BindingKind = "callable" | "parameter" | "local" | "import" | "non_callable";

interface Binding {
  kind: BindingKind;
  targetSymbolId?: string;
  tainted?: boolean;
}

interface Scope {
  parent: Scope | null;
  kind: "root" | "function" | "block" | "catch";
  bindings: Map<string, Binding[]>;
  hasDotImport: boolean;
}

interface PendingReference {
  name: string | null;
  fromSymbolId: string | null;
  scope: Scope;
  callee: SyntaxNode;
}

interface PendingBindingMutation {
  names: string[];
  scope: Scope;
}

interface VisitContext {
  scope: Scope;
  callableSymbolId: string | null;
  containerName?: string;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CodeExtractionCancelledError();
}

function stableId(prefix: string, ...parts: Array<string | number>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(value.length));
    hash.update(":");
    hash.update(value);
    hash.update("|");
  }
  return `${prefix}_${hash.digest("hex").slice(0, 24)}`;
}

function nodeKey(node: SyntaxNode): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`;
}

function namedDescendants(node: SyntaxNode, types: string | string[]): SyntaxNode[] {
  return node.descendantsOfType(types);
}

function firstDescendant(node: SyntaxNode, types: string | string[]): SyntaxNode | undefined {
  return namedDescendants(node, types)[0];
}

function moduleValue(node: SyntaxNode): string {
  const raw = node.text;
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith("`") && raw.endsWith("`"))) {
    if (raw.startsWith("\"")) {
      try {
        const decoded = JSON.parse(raw);
        if (typeof decoded === "string") return decoded;
      } catch {
        // 返回语法节点内的模块字面量内容，不执行或解释它。
      }
    }
    return raw.slice(1, -1);
  }
  return raw;
}

function exportedIdentifier(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function boundPatternNames(node: SyntaxNode | null): SyntaxNode[] {
  if (!node) return [];
  if (["identifier", "shorthand_property_identifier_pattern"].includes(node.type)) return [node];
  if (node.type === "pair_pattern") return boundPatternNames(node.childForFieldName("value"));
  if (["assignment_pattern", "object_assignment_pattern"].includes(node.type)) {
    return boundPatternNames(node.childForFieldName("left"));
  }
  if (node.type === "rest_pattern") return boundPatternNames(node.namedChild(0));
  if (["array_pattern", "object_pattern"].includes(node.type)) return node.namedChildren.flatMap(boundPatternNames);
  return [];
}

function parameterNameNodes(parameters: SyntaxNode | null): SyntaxNode[] {
  if (!parameters) return [];
  const result: SyntaxNode[] = [];
  for (const child of parameters.namedChildren) {
    if (["required_parameter", "optional_parameter"].includes(child.type)) {
      result.push(...boundPatternNames(child.childForFieldName("pattern")));
    } else if (["parameter_declaration", "variadic_parameter_declaration"].includes(child.type)) {
      result.push(...child.childrenForFieldName("name"));
    } else {
      result.push(...boundPatternNames(child));
    }
  }
  return result;
}

function assignmentTargetNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "expression_list") return node.namedChildren.flatMap((child) => assignmentTargetNames(child));
  return boundPatternNames(node).map((name) => name.text);
}

function addBinding(scope: Scope, name: string, binding: Binding): void {
  const existing = scope.bindings.get(name);
  if (existing) existing.push(binding);
  else scope.bindings.set(name, [binding]);
}

function enclosingFunctionScope(scope: Scope): Scope {
  let current = scope;
  while (current.parent && current.kind !== "function") current = current.parent;
  return current;
}

function esImportBindings(node: SyntaxNode): CodeImportBinding[] {
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (!clause) return [];
  const bindings: CodeImportBinding[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      bindings.push({ imported: "default", local: child.text, kind: "default" });
    } else if (child.type === "namespace_import") {
      const local = child.namedChildren.find((part) => part.type === "identifier")?.text ?? null;
      bindings.push({ imported: "*", local, kind: "namespace" });
    } else if (child.type === "named_imports") {
      for (const specifier of child.namedChildren.filter((part) => part.type === "import_specifier")) {
        const imported = specifier.childForFieldName("name")?.text ?? "";
        const local = specifier.childForFieldName("alias")?.text ?? imported;
        bindings.push({ imported, local, kind: "named" });
      }
    }
  }
  return bindings;
}

function declarationExportNames(node: SyntaxNode): Array<{ exported: string; local: string | null }> {
  if (["function_declaration", "generator_function_declaration", "function_signature", "class_declaration",
    "interface_declaration", "type_alias_declaration", "enum_declaration"].includes(node.type)) {
    const name = node.childForFieldName("name")?.text;
    return name ? [{ exported: name, local: name }] : [];
  }
  if (["lexical_declaration", "variable_declaration"].includes(node.type)) {
    const names: Array<{ exported: string; local: string }> = [];
    for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      for (const nameNode of boundPatternNames(declarator.childForFieldName("name"))) {
        names.push({ exported: nameNode.text, local: nameNode.text });
      }
    }
    return names;
  }
  return [];
}

function calleeName(node: SyntaxNode): string | null {
  if (["identifier", "field_identifier"].includes(node.type)) return node.text;
  if (["member_expression", "selector_expression"].includes(node.type)) {
    return node.childForFieldName("property")?.text ?? node.childForFieldName("field")?.text ?? null;
  }
  return null;
}

function resolveReference(reference: PendingReference): Pick<CodeReference, "targetSymbolId" | "certainty" | "evidence"> {
  if (!reference.name || !["identifier", "field_identifier"].includes(reference.callee.type)) {
    return { targetSymbolId: null, certainty: "unknown", evidence: "dynamic_or_member_call" };
  }
  let scope: Scope | null = reference.scope;
  let sawDotImport = false;
  while (scope) {
    sawDotImport ||= scope.hasDotImport;
    const bindings = scope.bindings.get(reference.name);
    if (bindings) {
      if (bindings.length !== 1) return { targetSymbolId: null, certainty: "unknown", evidence: "ambiguous_binding" };
      const [binding] = bindings;
      if (binding!.kind === "callable" && binding!.targetSymbolId) {
        if (binding!.tainted) return { targetSymbolId: null, certainty: "unknown", evidence: "tainted_callable_binding" };
        return { targetSymbolId: binding!.targetSymbolId, certainty: "certain", evidence: "lexical_same_file_direct_call" };
      }
      if (binding!.kind === "import") return { targetSymbolId: null, certainty: "unknown", evidence: "external_binding" };
      if (binding!.kind === "parameter" || binding!.kind === "local") {
        return { targetSymbolId: null, certainty: "unknown", evidence: "lexical_shadow" };
      }
      return { targetSymbolId: null, certainty: "unknown", evidence: "non_callable_binding" };
    }
    scope = scope.parent;
  }
  return {
    targetSymbolId: null,
    certainty: "unknown",
    evidence: sawDotImport ? "external_binding" : "unresolved_identifier",
  };
}

export async function extractCode(input: ExtractCodeInput): Promise<ExtractCodeResult> {
  if (!input || typeof input.path !== "string" || typeof input.source !== "string") {
    throw new TypeError("必须提供 path、language 和 source 字符串");
  }
  throwIfCancelled(input.signal);
  const extractorVersion = getCodeExtractorVersion(input.language);

  const result = await withSyntaxTree(input.language, input.source, (tree) => {
    throwIfCancelled(input.signal);
    const lineStarts = [0];
    for (let index = 0; index < input.source.length; index++) {
      if (input.source.charCodeAt(index) === 10) lineStarts.push(index + 1);
    }
    const position = (offset: number): CodePosition => {
      let low = 0;
      let high = lineStarts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (lineStarts[middle]! <= offset) low = middle;
        else high = middle;
      }
      return { offset, line: low, column: offset - lineStarts[low]! };
    };
    const range = (node: SyntaxNode): CodeRange => ({ start: position(node.startIndex), end: position(node.endIndex) });

    const symbols: CodeSymbol[] = [];
    const imports: CodeImport[] = [];
    const exports: CodeExport[] = [];
    const diagnostics: CodeDiagnostic[] = [];
    const pendingReferences: PendingReference[] = [];
    const pendingBindingMutations: PendingBindingMutation[] = [];
    const callableNodes = new Map<string, CodeSymbol>();
    const symbolsByKey = new Map<string, CodeSymbol>();
    let partial = tree.rootNode.hasError;
    let visitedNodes = 0;
    let nodeTraversalStopped = false;
    let nodeBudgetReported = false;
    let depthBudgetReported = false;
    let diagnosticBudgetReported = false;

    const addDiagnostic = (code: CodeDiagnosticCode, severity: "error" | "warning", node: SyntaxNode): void => {
      partial = true;
      if (diagnostics.length < CODE_EXTRACTOR_BUDGET.maxDiagnostics) {
        diagnostics.push({ code, severity, range: range(node) });
      } else if (!diagnosticBudgetReported) {
        diagnosticBudgetReported = true;
        diagnostics[diagnostics.length - 1] = { code: "diagnostic_budget_exceeded", severity: "warning", range: range(tree.rootNode) };
      }
    };

    if (tree.rootNode.descendantCount > CODE_EXTRACTOR_BUDGET.maxNodes) {
      nodeBudgetReported = true;
      addDiagnostic("node_budget_exceeded", "warning", tree.rootNode);
    }

    const addSymbol = (kind: CodeSymbolKind, name: string, node: SyntaxNode, nameNode: SyntaxNode | null,
      syntax = node.type, containerName?: string): CodeSymbol => {
      const qualifiedName = containerName ? `${containerName}.${name}` : undefined;
      const key = `${kind}:${name}:${node.startIndex}:${node.endIndex}:${qualifiedName ?? ""}`;
      const existing = symbolsByKey.get(key);
      if (existing) return existing;
      const symbol: CodeSymbol = {
        id: stableId("sym", input.path, input.language, kind, name, qualifiedName ?? "", node.startIndex, node.endIndex),
        name,
        ...(qualifiedName ? { qualifiedName } : {}),
        kind,
        range: range(node),
        selectionRange: range(nameNode ?? node),
        syntax,
      };
      symbols.push(symbol);
      symbolsByKey.set(key, symbol);
      return symbol;
    };

    const rootScope: Scope = { parent: null, kind: "root", bindings: new Map(), hasDotImport: false };

    const visit = (node: SyntaxNode, context: VisitContext, depth: number): void => {
      throwIfCancelled(input.signal);
      if (nodeTraversalStopped) return;
      visitedNodes++;
      if (visitedNodes > CODE_EXTRACTOR_BUDGET.maxNodes) {
        nodeTraversalStopped = true;
        if (!nodeBudgetReported) {
          nodeBudgetReported = true;
          addDiagnostic("node_budget_exceeded", "warning", node);
        }
        return;
      }
      if (depth > CODE_EXTRACTOR_BUDGET.maxDepth) {
        if (!depthBudgetReported) {
          depthBudgetReported = true;
          addDiagnostic("depth_budget_exceeded", "warning", node);
        }
        return;
      }
      if (node.isError || node.isMissing) {
        addDiagnostic(node.isMissing ? "missing_syntax" : "syntax_error", "error", node);
        return;
      }

      let nextContext = context;
      let declaredCallable: CodeSymbol | undefined;
      const defaultExport = node.parent?.type === "export_statement" &&
        node.parent.children.some((child) => !child.isNamed && child.type === "default");

      if (["function_declaration", "generator_function_declaration", "function_signature"].includes(node.type)) {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? (defaultExport ? "default" : null);
        if (name) {
          declaredCallable = addSymbol("function", name, node, nameNode);
          if (nameNode) addBinding(context.scope, name, { kind: "callable", targetSymbolId: declaredCallable.id });
          callableNodes.set(nodeKey(node), declaredCallable);
        }
      } else if (node.type === "class_declaration") {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? (defaultExport ? "default" : null);
        if (name) {
          addSymbol("class", name, node, nameNode);
          if (nameNode) addBinding(context.scope, name, { kind: "non_callable" });
        }
      } else if (node.type === "interface_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) addSymbol("interface", nameNode.text, node, nameNode);
      } else if (["type_alias_declaration", "enum_declaration"].includes(node.type)) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) addSymbol("type", nameNode.text, node, nameNode);
      } else if (node.type === "method_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          declaredCallable = addSymbol("method", nameNode.text, node, nameNode, node.type, context.containerName);
          callableNodes.set(nodeKey(node), declaredCallable);
        }
      } else if (node.type === "method_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const receiver = node.childForFieldName("receiver");
          const receiverType = receiver ? firstDescendant(receiver, "type_identifier")?.text : undefined;
          declaredCallable = addSymbol("method", nameNode.text, node, nameNode, node.type, receiverType);
          callableNodes.set(nodeKey(node), declaredCallable);
        }
      } else if (node.type === "type_spec") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          addSymbol("type", nameNode.text, node, nameNode);
          addBinding(context.scope, nameNode.text, { kind: "non_callable" });
        }
      }

      if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        const names = boundPatternNames(nameNode);
        const bindingScope = node.parent?.type === "variable_declaration" && input.language !== "go"
          ? enclosingFunctionScope(context.scope)
          : context.scope;
        if (names.length === 1 && nameNode?.type === "identifier" && value &&
          ["arrow_function", "function_expression", "generator_function"].includes(value.type)) {
          const kind: CodeSymbolKind = value.type === "arrow_function" ? "arrow_function" : "function";
          const symbol = addSymbol(kind, nameNode.text, node, nameNode, value.type);
          callableNodes.set(nodeKey(value), symbol);
          addBinding(bindingScope, nameNode.text, { kind: "callable", targetSymbolId: symbol.id });
        } else {
          for (const name of names) addBinding(bindingScope, name.text, { kind: "local" });
        }
      }

      if (["function_expression", "generator_function", "arrow_function"].includes(node.type)) {
        let symbol = callableNodes.get(nodeKey(node));
        const nameNode = node.childForFieldName("name");
        if (!symbol && nameNode) {
          symbol = addSymbol("function", nameNode.text, node, nameNode);
          callableNodes.set(nodeKey(node), symbol);
        } else if (!symbol && defaultExport) {
          symbol = addSymbol(node.type === "arrow_function" ? "arrow_function" : "function", "default", node, null, node.type);
          callableNodes.set(nodeKey(node), symbol);
        }
      }

      if (node.type === "import_statement") {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const bindings = esImportBindings(node);
          const module = moduleValue(sourceNode);
          imports.push({
            id: stableId("imp", input.path, input.language, module, node.startIndex, node.endIndex),
            module,
            bindings: bindings.length ? bindings : [{ imported: "*", local: null, kind: "side_effect" }],
            range: range(node),
            syntax: "import_statement",
          });
          for (const binding of bindings) {
            if (binding.local) addBinding(context.scope, binding.local, { kind: "import" });
          }
        }
      } else if (node.type === "import_spec") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          const nameNode = node.childForFieldName("name");
          const alias = nameNode?.text ?? null;
          const binding: CodeImportBinding = alias === "_"
            ? { imported: "*", local: null, kind: "side_effect" }
            : alias === "."
              ? { imported: "*", local: null, kind: "namespace" }
              : { imported: "*", local: alias, kind: "namespace" };
          const module = moduleValue(pathNode);
          imports.push({
            id: stableId("imp", input.path, input.language, module, node.startIndex, node.endIndex),
            module,
            bindings: [binding],
            range: range(node),
            syntax: "import_spec",
          });
          if (alias === ".") context.scope.hasDotImport = true;
          else if (alias && alias !== "_") addBinding(context.scope, alias, { kind: "import" });
        }
      }

      if (node.type === "export_statement") {
        const sourceNode = node.childForFieldName("source");
        const module = sourceNode ? moduleValue(sourceNode) : null;
        const declaration = node.childForFieldName("declaration");
        const hasDefault = node.children.some((child) => !child.isNamed && child.type === "default");
        let entries: Array<{ exported: string; local: string | null }> = [];
        if (declaration) {
          entries = declarationExportNames(declaration);
          if (hasDefault) entries = [{ exported: "default", local: entries[0]?.local ?? null }];
        } else {
          const clause = node.namedChildren.find((child) => child.type === "export_clause");
          if (clause) {
            entries = clause.namedChildren.filter((child) => child.type === "export_specifier").map((specifier) => {
              const local = specifier.childForFieldName("name")?.text ?? null;
              return { exported: specifier.childForFieldName("alias")?.text ?? local ?? "", local };
            }).filter((entry) => entry.exported !== "");
          } else {
            const namespace = node.namedChildren.find((child) => child.type === "namespace_export");
            if (namespace) entries = [{ exported: namespace.namedChildren.at(-1)?.text ?? "*", local: "*" }];
            else if (node.children.some((child) => child.type === "*")) entries = [{ exported: "*", local: "*" }];
            else {
              const value = node.childForFieldName("value");
              if (value) entries = [{ exported: hasDefault ? "default" : value.text, local: value.type === "identifier" ? value.text : null }];
            }
          }
        }
        for (const entry of entries) {
          exports.push({
            id: stableId("exp", input.path, input.language, entry.exported, entry.local ?? "", module ?? "", node.startIndex, node.endIndex),
            exported: entry.exported,
            local: entry.local,
            module,
            range: range(node),
            syntax: "export_statement",
          });
        }
      }

      if (["assignment_expression", "augmented_assignment_expression", "assignment_statement"].includes(node.type)) {
        const names = assignmentTargetNames(node.childForFieldName("left"));
        if (names.length) pendingBindingMutations.push({ names, scope: context.scope });
      } else if (node.type === "update_expression") {
        const names = assignmentTargetNames(node.childForFieldName("argument"));
        if (names.length) pendingBindingMutations.push({ names, scope: context.scope });
      }

      if (node.type === "assignment_expression" && ["js", "jsx"].includes(input.language)) {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "member_expression") {
          const object = left.childForFieldName("object");
          const property = left.childForFieldName("property");
          const moduleExports = object?.type === "member_expression" && object.childForFieldName("object")?.text === "module" &&
            object.childForFieldName("property")?.text === "exports";
          const directModuleExports = object?.text === "module" && property?.text === "exports";
          const exportsProperty = object?.text === "exports" && property;
          const exported = moduleExports ? property?.text : directModuleExports ? "default" : exportsProperty ? property.text : null;
          if (exported) {
            exports.push({
              id: stableId("exp", input.path, input.language, exported, node.startIndex, node.endIndex),
              exported,
              local: right?.type === "identifier" ? right.text : null,
              module: null,
              range: range(node),
              syntax: "commonjs_assignment",
            });
          }
        }
      }

      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        if (callee) pendingReferences.push({
          name: calleeName(callee),
          fromSymbolId: context.callableSymbolId,
          scope: context.scope,
          callee,
        });
      }

      const createsFunctionScope = ["function_declaration", "generator_function_declaration", "function_signature",
        "function_expression", "generator_function", "arrow_function", "func_literal", "method_definition", "method_declaration"].includes(node.type);
      if (createsFunctionScope) {
        const functionScope: Scope = { parent: context.scope, kind: "function", bindings: new Map(), hasDotImport: false };
        const mapped = callableNodes.get(nodeKey(node)) ?? declaredCallable;
        const ownName = node.childForFieldName("name")?.text;
        if (ownName && mapped && ["function_expression", "generator_function"].includes(node.type)) {
          addBinding(functionScope, ownName, { kind: "callable", targetSymbolId: mapped.id });
        }
        for (const parameter of parameterNameNodes(node.childForFieldName("parameters"))) {
          addBinding(functionScope, parameter.text, { kind: "parameter" });
        }
        for (const parameter of boundPatternNames(node.childForFieldName("parameter"))) {
          addBinding(functionScope, parameter.text, { kind: "parameter" });
        }
        if (input.language === "go") {
          for (const resultParameter of parameterNameNodes(node.childForFieldName("result"))) {
            addBinding(functionScope, resultParameter.text, { kind: "parameter" });
          }
        }
        if (node.type === "method_declaration") {
          for (const receiver of parameterNameNodes(node.childForFieldName("receiver"))) {
            addBinding(functionScope, receiver.text, { kind: "parameter" });
          }
        }
        nextContext = {
          scope: functionScope,
          callableSymbolId: mapped?.id ?? null,
          containerName: context.containerName,
        };
      } else if (node.type === "for_in_statement") {
        const names = assignmentTargetNames(node.childForFieldName("left"));
        const declaration = node.childForFieldName("kind")?.text;
        if (declaration === "let" || declaration === "const") {
          const loopScope: Scope = { parent: context.scope, kind: "block", bindings: new Map(), hasDotImport: false };
          for (const name of names) addBinding(loopScope, name, { kind: "local" });
          nextContext = { ...context, scope: loopScope };
        } else {
          const bindingScope = declaration === "var" ? enclosingFunctionScope(context.scope) : context.scope;
          if (declaration === "var") for (const name of names) addBinding(bindingScope, name, { kind: "local" });
          pendingBindingMutations.push({ scope: bindingScope, names });
        }
      } else if (input.language === "go" && ["for_statement", "if_statement", "expression_switch_statement", "type_switch_statement", "communication_case", "type_case"].includes(node.type)) {
        nextContext = { ...context, scope: { parent: context.scope, kind: "block", bindings: new Map(), hasDotImport: false } };
      } else if (node.type === "catch_clause") {
        const catchScope: Scope = { parent: context.scope, kind: "catch", bindings: new Map(), hasDotImport: false };
        for (const parameter of boundPatternNames(node.childForFieldName("parameter"))) {
          addBinding(catchScope, parameter.text, { kind: "parameter" });
        }
        nextContext = { ...context, scope: catchScope };
      } else if (["statement_block", "block"].includes(node.type)) {
        nextContext = { ...context, scope: { parent: context.scope, kind: "block", bindings: new Map(), hasDotImport: false } };
      } else if (node.type === "class_declaration") {
        const className = node.childForFieldName("name")?.text ?? (defaultExport ? "default" : context.containerName);
        nextContext = { ...context, containerName: className };
      }

      if (input.language === "go" && node.type === "type_switch_statement") {
        for (const name of assignmentTargetNames(node.childForFieldName("alias"))) {
          addBinding(nextContext.scope, name, { kind: "local" });
        }
      }
      if (input.language === "go" && ["range_clause", "receive_statement"].includes(node.type)) {
        const names = assignmentTargetNames(node.childForFieldName("left"));
        if (node.children.some((child) => child.type === ":=")) {
          for (const name of names) addBinding(context.scope, name, { kind: "local" });
        } else if (names.length) pendingBindingMutations.push({ scope: context.scope, names });
      }
      if (node.type === "short_var_declaration") {
        const left = node.childForFieldName("left");
        if (left) for (const name of left.namedChildren.filter((child) => child.type === "identifier")) {
          addBinding(context.scope, name.text, { kind: "local" });
        }
      } else if (["var_spec", "const_spec"].includes(node.type)) {
        for (const name of node.childrenForFieldName("name")) addBinding(context.scope, name.text, { kind: "local" });
      }

      for (let index = 0; index < node.namedChildCount && !nodeTraversalStopped; index++) {
        const child = node.namedChild(index);
        if (child) visit(child, nextContext, depth + 1);
      }
    };

    visit(tree.rootNode, { scope: rootScope, callableSymbolId: null }, 0);
    if (tree.rootNode.hasError && !diagnostics.some((diagnostic) => diagnostic.code === "syntax_error" || diagnostic.code === "missing_syntax")) {
      addDiagnostic("syntax_error", "error", tree.rootNode);
    }

    for (const mutation of pendingBindingMutations) {
      for (const name of mutation.names) {
        let scope: Scope | null = mutation.scope;
        while (scope) {
          const bindings = scope.bindings.get(name);
          if (bindings) {
            for (const binding of bindings) {
              if (binding.kind === "callable") binding.tainted = true;
            }
            break;
          }
          scope = scope.parent;
        }
      }
    }

    if (input.language === "go") {
      for (const symbol of symbols) {
        if (exportedIdentifier(symbol.name)) {
          exports.push({
            id: stableId("exp", input.path, input.language, symbol.name, symbol.range.start.offset, symbol.range.end.offset),
            exported: symbol.name,
            local: symbol.name,
            module: null,
            range: symbol.selectionRange,
            syntax: "go_exported_identifier",
          });
        }
      }
    }

    const references: CodeReference[] = pendingReferences.map((reference) => {
      const resolved = resolveReference(reference);
      return {
        id: stableId("ref", input.path, input.language, reference.name ?? "", reference.callee.startIndex, reference.callee.endIndex,
          reference.fromSymbolId ?? ""),
        kind: "call",
        name: reference.name,
        fromSymbolId: reference.fromSymbolId,
        ...resolved,
        range: range(reference.callee),
        syntax: "call_expression",
      };
    });

    const byRange = <T extends { range: CodeRange }>(left: T, right: T): number =>
      left.range.start.offset - right.range.start.offset || left.range.end.offset - right.range.end.offset;
    symbols.sort((left, right) => byRange(left, right) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
    imports.sort(byRange);
    exports.sort((left, right) => byRange(left, right) || left.exported.localeCompare(right.exported));
    references.sort(byRange);
    diagnostics.sort((left, right) => byRange(left, right) || left.code.localeCompare(right.code));
    throwIfCancelled(input.signal);

    return {
      path: input.path,
      language: input.language,
      extractorVersion,
      status: partial ? "partial" as const : "complete" as const,
      coordinates: CODE_EXTRACTOR_COORDINATES,
      symbols,
      imports,
      exports,
      references,
      diagnostics,
    };
  });

  throwIfCancelled(input.signal);
  return result;
}
