import { posix as path } from "node:path";
import { withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "./database.ts";

/**
 * explore 的有界输入/输出契约：parent 与来源基线由宿主填写；本模块只校验 JSON 形状、固定预算和输入输出一致性，
 * 不读取文件、数据库或网络，无法证明文件当前内容或正文语义。
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
} as const);

const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const boundedText = Type.String({ minLength: 1 });
const identifier = Type.String({ pattern: "^[\\p{L}\\p{N}._:/#@+-]{1,256}$" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const uuidV7 = Type.String({ pattern: UUID_V7_PATTERN.source, minLength: 36, maxLength: 36 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// ECMAScript Date 可精确表示的正 Unix epoch 毫秒上界。
const unixEpochMilliseconds = Type.Integer({ minimum: 1, maximum: 8_640_000_000_000_000 });
const textList = Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.statusItems });
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

const localInputSource = object({
  kind: Type.Literal("local_file"),
  indexBaseline: Type.Literal("not_applicable"),
  root: Type.String({ minLength: 1, maxLength: EXPLORE_CONTRACT_LIMITS.pathBytes }),
});
const webInputSource = object({
  kind: Type.Literal("web"),
  indexBaseline: Type.Literal("not_applicable"),
  query: boundedText,
});
const inputSource = Type.Union([localInputSource, webInputSource]);

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
const resultSource = Type.Union([localResultSource, webResultSource]);

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
});

export const ExploreResultSchema = object({
  format: Type.Literal("explore-result/v1"),
  kind: Type.Literal("research"),
  parent,
  source: inputSource,
  conclusions: Type.Array(boundedText, { maxItems: EXPLORE_CONTRACT_LIMITS.conclusions }),
  sources: Type.Array(resultSource, { maxItems: EXPLORE_CONTRACT_LIMITS.sources }),
  searchedScope: Type.Union([localScope, webScope]),
  notFound: textList,
  failures: textList,
  truncation: object({ truncated: Type.Boolean(), reasons: textList }),
  unknown: textList,
});
export type ExploreResult = Static<typeof ExploreResultSchema>;

const EXPLORE_CONTRACT_ADVICE = {
  invalid_shape: { why: "检索请求或 research 的字段不符合格式", next: "按原因改正字段后重交" },
  invalid_binding: { why: "research 与派工时给定的父身份、检索来源或问题不一致", next: "按派工给定的问题与来源提交，不要自行改写这些字段" },
  out_of_scope: { why: "引用了检索范围以外的来源", next: "只引用本次允许的检索范围内的来源" },
  resource_limit: { why: "内容超出了允许的数量或长度", next: "精简内容后重交" },
} as const satisfies Record<string, FailureAdvice>;
export type ExploreContractErrorCode = keyof typeof EXPLORE_CONTRACT_ADVICE;
export class ExploreContractError extends Error {
  readonly code: ExploreContractErrorCode;
  get advice(): FailureAdvice { return withDetail(EXPLORE_CONTRACT_ADVICE[this.code], this.detail); }
  /** 程序生成的改正提示，只含字段位置与检索根，不含模型提交的值。 */
  readonly detail: string | undefined;
  constructor(code: ExploreContractErrorCode, detail?: string) {
    super(`explore 契约拒绝：${code}${detail ? `（${detail}）` : ""}`);
    this.name = "ExploreContractError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: ExploreContractErrorCode, detail?: string): never { throw new ExploreContractError(code, detail); }
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

function checkText(value: string, maximum: number, field: string): void {
  if (value.trim().length === 0) fail("invalid_shape");
  if (codepoints(value) > maximum) fail("resource_limit", `${field} ${codepoints(value)} 字，上限 ${maximum} 字`);
}
function checkTextList(values: readonly string[], maximum: number, field: string): void {
  values.forEach((value, index) => checkText(value, maximum, `${field} 第 ${index + 1} 项`));
}
function checkAbsolutePath(value: string): void {
  if (bytes(value) > EXPLORE_CONTRACT_LIMITS.pathBytes || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || !path.isAbsolute(value) || path.normalize(value) !== value
    || value.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))) fail("out_of_scope");
}
function isUnder(value: string, root: string): boolean {
  return value === root || value.startsWith(root === "/" ? "/" : `${root}/`);
}
export function checkedUrl(value: string): URL {
  if (bytes(value) > EXPLORE_CONTRACT_LIMITS.urlBytes) fail("resource_limit", `网址 ${bytes(value)} 字节，上限 ${EXPLORE_CONTRACT_LIMITS.urlBytes} 字节`);
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
  checkText(input.question, EXPLORE_CONTRACT_LIMITS.questionCodepoints, "question");
  checkTextList(input.clues, EXPLORE_CONTRACT_LIMITS.clueCodepoints, "clues");
  if (input.source.kind === "web") checkText(input.source.query, EXPLORE_CONTRACT_LIMITS.questionCodepoints, "source.query");
  else checkAbsolutePath(input.source.root);
}

/** 校验并复制最小 explore 输入；不会创建角色、会话、需求、工作区或任何授权。 */
export function checkExploreInput(value: unknown): ExploreInput {
  const { copy, json } = jsonClone<ExploreInput>(ExploreInputSchema, value);
  validateInput(copy);
  if (bytes(json) > EXPLORE_CONTRACT_LIMITS.inputBytes) fail("resource_limit", `检索请求整体 ${bytes(json)} 字节，上限 ${EXPLORE_CONTRACT_LIMITS.inputBytes} 字节`);
  return copy;
}

function validateResult(result: ExploreResult, input: ExploreInput): void {
  if (!same(result.parent, input.parent) || !same(result.source, input.source)) fail("invalid_binding");
  if (result.sources.length > input.budget.maxSources) fail("out_of_scope", `来源 ${result.sources.length} 条，超过预算 ${input.budget.maxSources} 条`);
  if (result.searchedScope.kind !== input.source.kind) fail("out_of_scope", `searchedScope 的种类须为 ${input.source.kind}`);
  checkTextList(result.conclusions, EXPLORE_CONTRACT_LIMITS.conclusionCodepoints, "conclusions");
  checkTextList(result.notFound, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints, "notFound");
  checkTextList(result.failures, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints, "failures");
  checkTextList(result.truncation.reasons, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints, "truncation.reasons");
  checkTextList(result.unknown, EXPLORE_CONTRACT_LIMITS.statusItemCodepoints, "unknown");
  if (result.truncation.truncated !== (result.truncation.reasons.length > 0)) fail("invalid_shape");

  if (input.source.kind === "local_file" && result.searchedScope.kind === "local_file") {
    const root = input.source.root;
    const outside = (field: string, index: number, extra = "") => fail("out_of_scope", `${field} 第 ${index + 1} 项不是检索根 ${root} 下的路径${extra}`);
    result.searchedScope.paths.forEach((value, index) => {
      try { checkAbsolutePath(value); } catch { outside("searchedScope.paths", index, "；每项只写一个路径，说明写进 notFound 或 unknown"); }
      if (!isUnder(value, root)) outside("searchedScope.paths", index, "；每项只写一个路径，说明写进 notFound 或 unknown");
    });
    for (const [index, source] of result.sources.entries()) {
      if (!("path" in source)) fail("invalid_binding");
      try { checkAbsolutePath(source.path); } catch { outside("sources", index); }
      if (!isUnder(source.path, root)) outside("sources", index);
      if (source.endLine < source.startLine) fail("invalid_shape");
    }
  } else if (input.source.kind === "web" && result.searchedScope.kind === "web") {
    result.searchedScope.queries.forEach((query, index) => checkText(query, EXPLORE_CONTRACT_LIMITS.questionCodepoints, `searchedScope.queries 第 ${index + 1} 项`));
    for (const [index, source] of result.sources.entries()) {
      if (!("url" in source)) fail("invalid_binding");
      checkedUrl(source.url);
      checkText(source.quote, EXPLORE_CONTRACT_LIMITS.quoteCodepoints, `sources 第 ${index + 1} 项的 quote`);
    }
  } else fail("invalid_binding");
}

/**
 * 校验 research 结果与原输入的父身份、需求绑定、来源基线、范围及预算一致；本地文件 hash 由宿主按实际内容另行核对。
 * 返回值不是 PASS、批准、授权或正文真实性证明；父代理仍须按风险回读并核验来源。
 */
export function checkExploreResult(value: unknown, input: ExploreInput): ExploreResult {
  const trustedInput = checkExploreInput(input);
  const { copy, json } = jsonClone<ExploreResult>(ExploreResultSchema, value);
  validateResult(copy, trustedInput);
  const maxBytes = Math.min(EXPLORE_CONTRACT_LIMITS.outputBytes, trustedInput.budget.maxResultBytes);
  if (bytes(json) > maxBytes) fail("resource_limit", `research 整体 ${bytes(json)} 字节，上限 ${maxBytes} 字节`);
  return copy;
}
