import { posix as path } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";

/**
 * M4 只定义 explore 的有界输入/输出契约。
 * parent、来源基线、路径、文件 hash 及授权引用必须由未来可信宿主填写；
 * 本模块只校验 JSON 形状、固定预算和输入输出的一致性，不签发授权，
 * 也不读取文件、数据库或网络，无法证明文件当前内容、授权真实性或正文语义。
 */
export const EXPLORE_CONTRACT_LIMITS = Object.freeze({
  questionCodepoints: 1_500,
  clues: 8,
  clueCodepoints: 400,
  sources: 32,
  conclusions: 16,
  conclusionCodepoints: 400,
  statusItems: 16,
  statusItemCodepoints: 400,
  quoteCodepoints: 400,
  inputBytes: 32_768,
  outputBytes: 32_768,
  pathBytes: 4_096,
  urlBytes: 2_048,
  domains: 16,
} as const);

const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const boundedText = Type.String({ minLength: 1 });
const identifier = Type.String({ pattern: "^[\\p{L}\\p{N}._:/#@+-]{1,256}$" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const uuidV7 = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// ECMAScript Date 可精确表示的正 Unix epoch 毫秒上界。
const unixEpochMilliseconds = Type.Integer({ minimum: 1, maximum: 8_640_000_000_000_000 });
const branch = Type.String({ pattern: "^refs/heads/[^\\u0000-\\u0020]+$", maxLength: 1_024 });
const textList = Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.statusItems });
const workspace = object({ repoId: hash, workspaceId: hash, branch });
const requirementBinding = object({ requirementId: uuidV7, epoch: positive });

const mainParent = object({
  role: Type.Literal("main"),
  parentSessionId: identifier,
  parentRunId: identifier,
  contextId: identifier,
  requirementBinding: Type.Union([Type.Null(), requirementBinding]),
});
const pmParent = object({
  role: Type.Literal("PM"),
  parentSessionId: identifier,
  parentRunId: identifier,
  contextId: identifier,
  requirementBinding: object({ requirementId: uuidV7, epoch: positive, pmFence: positive }),
});
const parent = Type.Union([mainParent, pmParent]);

const knowledgeInputSource = object({
  kind: Type.Literal("knowledge_query"),
  workspace,
  generation: positive,
  baselineHash: hash,
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }), {
    minItems: 1,
    maxItems: EXPLORE_CONTRACT_LIMITS.sources,
    uniqueItems: true,
  }),
});
const localInputSource = object({
  kind: Type.Literal("local_file"),
  indexBaseline: Type.Literal("not_applicable"),
  allowedRoot: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }),
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }), {
    minItems: 1,
    maxItems: EXPLORE_CONTRACT_LIMITS.sources,
    uniqueItems: true,
  }),
  expectedFileHashes: Type.Array(object({
    path: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }),
    fileHash: hash,
  }), { minItems: 1, maxItems: EXPLORE_CONTRACT_LIMITS.sources }),
});
const webInputSource = object({
  kind: Type.Literal("web"),
  indexBaseline: Type.Literal("not_applicable"),
  query: boundedText,
  allowedDomains: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
    minItems: 1,
    maxItems: EXPLORE_CONTRACT_LIMITS.domains,
    uniqueItems: true,
  }),
  networkAuthorizationRef: identifier,
  disclosure: object({
    authorizationRef: identifier,
    contentScope: boundedText,
    contentHash: hash,
  }),
});
const inputSource = Type.Union([knowledgeInputSource, localInputSource, webInputSource]);

export const ExploreInputSchema = object({
  format: Type.Literal("explore-input/v1"),
  parent,
  question: boundedText,
  clues: Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.clues }),
  budget: object({
    maxSources: Type.Integer({ minimum: 1, maximum: EXPLORE_CONTRACT_LIMITS.sources }),
    maxResultBytes: Type.Integer({ minimum: 1, maximum: EXPLORE_CONTRACT_LIMITS.outputBytes }),
  }),
  source: inputSource,
});
export type ExploreInput = Static<typeof ExploreInputSchema>;

const lineRange = {
  startLine: positive,
  endLine: positive,
};
const knowledgeResultSource = object({
  kind: Type.Literal("knowledge_query"),
  workspace,
  generation: positive,
  baselineHash: hash,
  path: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }),
  fileHash: hash,
  ...lineRange,
});
const localResultSource = object({
  kind: Type.Literal("local_file"),
  indexBaseline: Type.Literal("not_applicable"),
  path: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }),
  fileHash: hash,
  ...lineRange,
});
const webResultSource = object({
  kind: Type.Literal("web"),
  indexBaseline: Type.Literal("not_applicable"),
  url: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.urlBytes }),
  retrievedAt: unixEpochMilliseconds,
  quote: boundedText,
});
const resultSource = Type.Union([knowledgeResultSource, localResultSource, webResultSource]);

const knowledgeScope = object({
  kind: Type.Literal("knowledge_query"),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }), {
    maxItems: EXPLORE_CONTRACT_LIMITS.sources,
    uniqueItems: true,
  }),
});
const localScope = object({
  kind: Type.Literal("local_file"),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }), {
    maxItems: EXPLORE_CONTRACT_LIMITS.sources,
    uniqueItems: true,
  }),
});
const webScope = object({
  kind: Type.Literal("web"),
  queries: Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.statusItems, uniqueItems: true }),
  domains: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
    maxItems: EXPLORE_CONTRACT_LIMITS.domains,
    uniqueItems: true,
  }),
});

export const ExploreResultSchema = object({
  format: Type.Literal("explore-result/v1"),
  kind: Type.Literal("research"),
  parent,
  source: inputSource,
  conclusions: Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.conclusions }),
  sources: Type.Array(resultSource, { maxItems: EXPLORE_CONTRACT_LIMITS.sources }),
  searchedScope: Type.Union([knowledgeScope, localScope, webScope]),
  notFound: textList,
  failures: textList,
  truncation: object({ truncated: Type.Boolean(), reasons: textList }),
  unknown: textList,
});
export type ExploreResult = Static<typeof ExploreResultSchema>;

export type ExploreContractErrorCode = "invalid_shape" | "invalid_binding" | "out_of_scope" | "resource_limit";
export class ExploreContractError extends Error {
  readonly code: ExploreContractErrorCode;
  constructor(code: ExploreContractErrorCode) {
    super(`explore 契约拒绝：${code}`);
    this.name = "ExploreContractError";
    this.code = code;
  }
}

function fail(code: ExploreContractErrorCode): never { throw new ExploreContractError(code); }
const codepoints = (value: string): number => Array.from(value).length;
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function jsonClone<T>(schema: TSchema, value: unknown): { copy: T; json: string } {
  try {
    const copy = structuredClone(value);
    if (!Value.Check(schema, copy)) fail("invalid_shape");
    const json = JSON.stringify(copy);
    if (json === undefined) fail("invalid_shape");
    return { copy: copy as T, json };
  } catch (error) {
    if (error instanceof ExploreContractError) throw error;
  }
  return fail("invalid_shape");
}

function checkText(value: string, maximum: number): void {
  if (value.trim().length === 0) fail("invalid_shape");
  if (codepoints(value) > maximum) fail("resource_limit");
}
function checkTextList(values: readonly string[], maximum: number): void {
  for (const value of values) checkText(value, maximum);
}
const reservedPathParts = new Set([".git", ".pi", ".ssh", ".aws"]);
const privateTopLevelParts = new Set(["session", "sessions", "key", "keys", "secret", "secrets"]);
function hasReservedLocation(parts: readonly string[]): boolean {
  if (parts.some((part) => reservedPathParts.has(part))) return true;
  return parts.some((part, index) => part === "docs" && parts[index + 1] === "prod");
}
export function isForbiddenFileName(value: string): boolean {
  const base = path.basename(value).toLowerCase();
  return /(?:^|\.)(?:db|db-wal|db-shm|key|pem|p12)$/u.test(base)
    || ["data.db", "index.db", "global.db"].includes(base);
}
export function isForbiddenRelativePath(value: string): boolean {
  const parts = value.toLowerCase().split("/").filter(Boolean);
  return hasReservedLocation(parts) || privateTopLevelParts.has(parts[0] ?? "") || isForbiddenFileName(value);
}
function checkRelativePath(value: string): void {
  if (bytes(value) > EXPLORE_CONTRACT_LIMITS.pathBytes || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || path.isAbsolute(value) || value === "." || path.normalize(value) !== value
    || value.split("/").some((part) => part === "" || part === "." || part === "..") || isForbiddenRelativePath(value)) fail("out_of_scope");
}
function checkAbsolutePath(value: string): void {
  if (bytes(value) > EXPLORE_CONTRACT_LIMITS.pathBytes || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || !path.isAbsolute(value) || path.normalize(value) !== value
    || value.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))) fail("out_of_scope");
}
function checkAllowedRoot(value: string): void {
  checkAbsolutePath(value);
  if (hasReservedLocation(value.toLowerCase().split("/").filter(Boolean))) fail("out_of_scope");
}
function isUnder(value: string, root: string): boolean {
  return value === root || value.startsWith(root === "/" ? "/" : `${root}/`);
}
function checkPathUnderRoot(value: string, root: string): void {
  checkAbsolutePath(value);
  if (!isUnder(value, root)) fail("out_of_scope");
  const relative = path.relative(root, value);
  if (isForbiddenFileName(value) || relative && isForbiddenRelativePath(relative)) fail("out_of_scope");
}
export function canonicalDomain(value: string): boolean {
  if (value !== value.toLowerCase() || value.endsWith(".") || value.includes(":") || value.includes("/") || value.includes("@")) return false;
  try {
    const url = new URL(`https://${value}/`);
    return url.hostname === value && url.host === value && (url.hostname === "localhost" || url.hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)));
  } catch { return false; }
}
export function checkedUrl(value: string): URL {
  if (bytes(value) > EXPLORE_CONTRACT_LIMITS.urlBytes) fail("resource_limit");
  const url = (() => {
    try { return new URL(value); } catch { return fail("out_of_scope"); }
  })();
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.href !== value) fail("out_of_scope");
  return url;
}
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function validateInput(input: ExploreInput): void {
  checkText(input.question, EXPLORE_CONTRACT_LIMITS.questionCodepoints);
  checkTextList(input.clues, EXPLORE_CONTRACT_LIMITS.clueCodepoints);
  if (input.source.kind === "knowledge_query") {
    input.source.allowedPaths.forEach(checkRelativePath);
  } else if ("allowedRoot" in input.source) {
    const source = input.source;
    checkAllowedRoot(source.allowedRoot);
    source.allowedPaths.forEach((value) => checkPathUnderRoot(value, source.allowedRoot));
    if (source.expectedFileHashes.length !== source.allowedPaths.length) fail("invalid_binding");
    const expectedPaths = source.expectedFileHashes.map((value) => value.path);
    if (new Set(expectedPaths).size !== expectedPaths.length) fail("invalid_binding");
    for (const value of source.expectedFileHashes) checkPathUnderRoot(value.path, source.allowedRoot);
    if (!same([...expectedPaths].sort(), [...source.allowedPaths].sort())) fail("invalid_binding");
  } else if ("query" in input.source) {
    checkText(input.source.query, EXPLORE_CONTRACT_LIMITS.questionCodepoints);
    checkText(input.source.disclosure.contentScope, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints);
    if (!input.source.allowedDomains.every(canonicalDomain)) fail("out_of_scope");
  } else fail("invalid_shape");
}

/** 校验并复制最小 explore 输入；不会创建角色、会话、需求、工作区或任何授权。 */
export function checkExploreInput(value: unknown): ExploreInput {
  const { copy, json } = jsonClone<ExploreInput>(ExploreInputSchema, value);
  validateInput(copy);
  if (bytes(json) > EXPLORE_CONTRACT_LIMITS.inputBytes) fail("resource_limit");
  return copy;
}

function validateResult(result: ExploreResult, input: ExploreInput): void {
  if (!same(result.parent, input.parent) || !same(result.source, input.source)) fail("invalid_binding");
  if (result.sources.length > input.budget.maxSources || result.searchedScope.kind !== input.source.kind) fail("out_of_scope");
  checkTextList(result.conclusions, EXPLORE_CONTRACT_LIMITS.conclusionCodepoints);
  checkTextList(result.notFound, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints);
  checkTextList(result.failures, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints);
  checkTextList(result.truncation.reasons, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints);
  checkTextList(result.unknown, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints);
  if (result.truncation.truncated !== (result.truncation.reasons.length > 0)) fail("invalid_shape");

  if (input.source.kind === "knowledge_query" && result.searchedScope.kind === "knowledge_query") {
    const searched = new Set(result.searchedScope.paths);
    for (const value of result.searchedScope.paths) {
      checkRelativePath(value);
      if (!input.source.allowedPaths.includes(value)) fail("out_of_scope");
    }
    for (const source of result.sources) {
      if (!("workspace" in source) || !same(source.workspace, input.source.workspace)
        || source.generation !== input.source.generation || source.baselineHash !== input.source.baselineHash
        || !input.source.allowedPaths.includes(source.path) || !searched.has(source.path)) fail("invalid_binding");
      checkRelativePath(source.path);
      if (source.endLine < source.startLine) fail("invalid_shape");
    }
  } else if (input.source.kind === "local_file" && result.searchedScope.kind === "local_file") {
    const searched = new Set(result.searchedScope.paths);
    const expected = new Map(input.source.expectedFileHashes.map((value) => [value.path, value.fileHash]));
    for (const value of result.searchedScope.paths) {
      checkAbsolutePath(value);
      if (!input.source.allowedPaths.includes(value)) fail("out_of_scope");
    }
    for (const source of result.sources) {
      if (!("path" in source) || "workspace" in source || !input.source.allowedPaths.includes(source.path) || !searched.has(source.path)
        || expected.get(source.path) !== source.fileHash) fail("invalid_binding");
      checkAbsolutePath(source.path);
      if (source.endLine < source.startLine) fail("invalid_shape");
    }
  } else if ("query" in input.source && result.searchedScope.kind === "web") {
    const inputSource = input.source;
    if (result.searchedScope.queries.some((query) => query !== inputSource.query)
      || result.searchedScope.domains.some((domain) => !inputSource.allowedDomains.includes(domain))) fail("out_of_scope");
    result.searchedScope.queries.forEach((query) => checkText(query, EXPLORE_CONTRACT_LIMITS.questionCodepoints));
    if (!result.searchedScope.domains.every(canonicalDomain)) fail("out_of_scope");
    const searchedDomains = new Set(result.searchedScope.domains);
    for (const source of result.sources) {
      if (!("url" in source)) fail("invalid_binding");
      const url = checkedUrl(source.url);
      if (!inputSource.allowedDomains.includes(url.hostname) || !searchedDomains.has(url.hostname)) fail("out_of_scope");
      checkText(source.quote, EXPLORE_CONTRACT_LIMITS.quoteCodepoints);
    }
  } else fail("invalid_binding");
}

/**
 * 校验 research 结果与原输入的父身份、需求绑定、来源基线、授权范围及预算一致。
 * 返回值不是 PASS、批准、授权或正文真实性证明；父代理仍须按风险回读并核验来源。
 */
export function checkExploreResult(value: unknown, input: ExploreInput): ExploreResult {
  const trustedInput = checkExploreInput(input);
  const { copy, json } = jsonClone<ExploreResult>(ExploreResultSchema, value);
  validateResult(copy, trustedInput);
  if (bytes(json) > Math.min(EXPLORE_CONTRACT_LIMITS.outputBytes, trustedInput.budget.maxResultBytes)) fail("resource_limit");
  return copy;
}
