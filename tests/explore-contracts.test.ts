import { expect, test } from "vitest";
import {
  EXPLORE_CONTRACT_LIMITS,
  ExploreContractError,
  checkExploreInput,
  checkExploreResult,
} from "../runtime/explore-contracts.ts";
import type { ExploreInput, ExploreResult } from "../runtime/explore-contracts.ts";

const requirementId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const hashes = {
  repo: "a".repeat(64), workspace: "b".repeat(64), baseline: "c".repeat(64), file: "d".repeat(64), disclosure: "e".repeat(64),
};
const mainParent = {
  role: "main", parentSessionId: "session-main", parentRunId: "run-main", contextId: "context-main", requirementBinding: null,
} as const;
const pmParent = {
  role: "PM", parentSessionId: "session-pm", parentRunId: "run-pm", contextId: "context-pm",
  requirementBinding: { requirementId, epoch: 3, pmFence: 7 },
} as const;
const budget = { maxSources: 32, maxResultBytes: 32_768 };
const workspace = { repoId: hashes.repo, workspaceId: hashes.workspace, branch: "refs/heads/test" };

function knowledgeInput(parent: typeof mainParent | typeof pmParent = mainParent): ExploreInput {
  return {
    format: "explore-input/v1", parent, question: "定位当前校验逻辑", clues: ["只看获准文件"], budget,
    source: { kind: "knowledge_query", workspace, generation: 4, baselineHash: hashes.baseline, allowedPaths: ["runtime/current.ts"] },
  };
}
function localInput(parent: typeof mainParent | typeof pmParent = mainParent): ExploreInput {
  return {
    format: "explore-input/v1", parent, question: "查看指定本地文件", clues: [], budget,
    source: { kind: "local_file", indexBaseline: "not_applicable", allowedRoot: "/safe/project",
      allowedPaths: ["/safe/project/current.ts"], expectedFileHashes: [{ path: "/safe/project/current.ts", fileHash: hashes.file }] },
  };
}
function webInput(parent: typeof mainParent | typeof pmParent = mainParent): ExploreInput {
  return {
    format: "explore-input/v1", parent, question: "查公开文档", clues: ["只发公开问题"], budget,
    source: { kind: "web", indexBaseline: "not_applicable", query: "公开 API 文档", allowedDomains: ["example.com"],
      networkAuthorizationRef: "network-grant-1", disclosure: { authorizationRef: "disclosure-grant-1", contentScope: "仅公开问题",
        contentHash: hashes.disclosure } },
  };
}
function resultFor(input: ExploreInput): ExploreResult {
  const common: Omit<ExploreResult, "sources" | "searchedScope"> = {
    format: "explore-result/v1", kind: "research", parent: input.parent, source: input.source,
    conclusions: ["找到一个有界来源"], notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [],
  };
  if (input.source.kind === "knowledge_query") return {
    ...common,
    sources: [{ kind: "knowledge_query", workspace: input.source.workspace, generation: input.source.generation,
      baselineHash: input.source.baselineHash, path: input.source.allowedPaths[0]!, fileHash: hashes.file, startLine: 1, endLine: 3 }],
    searchedScope: { kind: "knowledge_query", paths: [input.source.allowedPaths[0]!] },
  };
  if (input.source.kind === "local_file") return {
    ...common,
    sources: [{ kind: "local_file", indexBaseline: "not_applicable", path: input.source.allowedPaths[0]!,
      fileHash: input.source.expectedFileHashes[0]!.fileHash, startLine: 2, endLine: 4 }],
    searchedScope: { kind: "local_file", paths: [input.source.allowedPaths[0]!] },
  };
  return {
    ...common,
    sources: [{ kind: "web", indexBaseline: "not_applicable", url: "https://example.com/docs", retrievedAt: 1_800_000_000_000,
      quote: "公开短引文" }],
    searchedScope: { kind: "web", queries: [input.source.query], domains: [input.source.allowedDomains[0]!] },
  };
}
const clone = <T>(value: T): T => structuredClone(value);
const expectCode = (operation: () => unknown, code: string) => {
  try { operation(); } catch (error) {
    expect(error).toBeInstanceOf(ExploreContractError);
    expect((error as ExploreContractError).code).toBe(code);
    return;
  }
  throw new Error(`预期拒绝：${code}`);
};

test.each([
  ["main knowledge_query", knowledgeInput(mainParent)], ["PM knowledge_query", knowledgeInput(pmParent)],
  ["main local_file", localInput(mainParent)], ["PM local_file", localInput(pmParent)],
  ["main web", webInput(mainParent)], ["PM web", webInput(pmParent)],
] as const)("双父三来源正向：%s", (_name, input) => {
  const checked = checkExploreInput(input);
  expect(checked).toEqual(input);
  expect(checked).not.toBe(input);
  expect(checkExploreResult(resultFor(checked), checked)).toEqual(resultFor(checked));
});

test("main无需求、未声明本地索引的纯web输入在两类授权引用齐备时有效", () => {
  const input = webInput(mainParent);
  const checked = checkExploreInput(input);
  expect(checked.parent.requirementBinding).toBeNull();
  expect(checked.source).toEqual(expect.objectContaining({ kind: "web", indexBaseline: "not_applicable" }));
  expect(JSON.stringify(checked)).not.toMatch(/workspace|generation|baselineHash|requirementId|pmFence|allowedRoot/);
});

test("网络授权和外发授权各自缺失都会拒绝，混入本地索引字段也拒绝", () => {
  for (const key of ["networkAuthorizationRef", "disclosure"] as const) {
    const input = clone(webInput()) as unknown as Record<string, unknown>;
    delete (input.source as Record<string, unknown>)[key];
    expectCode(() => checkExploreInput(input), "invalid_shape");
  }
  const noDisclosureReference = clone(webInput()) as unknown as { source: { disclosure: Record<string, unknown> } };
  delete noDisclosureReference.source.disclosure.authorizationRef;
  expectCode(() => checkExploreInput(noDisclosureReference), "invalid_shape");
  for (const extra of [{ generation: 1 }, { baselineHash: hashes.baseline }, { allowedRoot: "/safe/project" }]) {
    const input = clone(webInput()) as unknown as { source: Record<string, unknown> };
    Object.assign(input.source, extra);
    expectCode(() => checkExploreInput(input), "invalid_shape");
  }
});

test("PM必须有需求、epoch和fence绑定，伪角色及伪载荷字段拒绝", () => {
  for (const parent of [
    { ...pmParent, requirementBinding: null },
    { ...pmParent, requirementBinding: { requirementId, epoch: 3 } },
    { ...pmParent, role: "planner" },
  ]) {
    expectCode(() => checkExploreInput({ ...webInput(), parent }), "invalid_shape");
  }
  for (const field of ["prodBody", "diff", "transcript", "rawContent", "detailedSummary", "parentMessages", "authorization", "newRole"]) {
    const input = clone(knowledgeInput()) as unknown as Record<string, unknown>;
    input[field] = "forbidden";
    expectCode(() => checkExploreInput(input), "invalid_shape");
  }
});

test("相邻来源字段不能混合，路径越界及明确禁止位置拒绝", () => {
  const knowledge = clone(knowledgeInput()) as unknown as { source: Record<string, unknown> };
  knowledge.source.indexBaseline = "not_applicable";
  expectCode(() => checkExploreInput(knowledge), "invalid_shape");

  for (const forbidden of [
    "../outside.ts", "docs/prod/closed.md", "state/data.db", "sessions/run.json", "keys/private.pem", "/absolute.ts",
    ".git/config", ".pi/session.json", ".ssh/id_rsa", ".aws/credentials", "src/credential.key", "src/cert.pem", "src/cert.p12",
  ]) {
    const input = clone(knowledgeInput());
    if (input.source.kind !== "knowledge_query") throw new Error("knowledge source required");
    input.source.allowedPaths = [forbidden];
    expectCode(() => checkExploreInput(input), "out_of_scope");
  }
  for (const forbidden of [
    "/safe/project/../outside.ts", "/safe/project/docs/prod/closed.md", "/safe/project/index.db", "/safe/project/sessions/run.json",
    "/safe/project/.git/config", "/safe/project/.pi/session.json", "/safe/project/.ssh/id_rsa", "/safe/project/.aws/credentials",
    "/safe/project/src/credential.key", "/safe/project/src/cert.pem", "/safe/project/src/cert.p12", "/outside/current.ts",
  ]) {
    const input = clone(localInput());
    if (input.source.kind !== "local_file") throw new Error("local source required");
    input.source.allowedPaths = [forbidden];
    input.source.expectedFileHashes = [{ path: forbidden, fileHash: hashes.file }];
    expectCode(() => checkExploreInput(input), "out_of_scope");
  }
  for (const forbiddenRoot of ["/safe/.git/project", "/safe/.pi/project", "/Users/example/.ssh/project", "/Users/example/.aws/project", "/safe/docs/prod"]) {
    const input = clone(localInput());
    if (input.source.kind !== "local_file") throw new Error("local source required");
    input.source.allowedRoot = forbiddenRoot;
    input.source.allowedPaths = [`${forbiddenRoot}/current.ts`];
    input.source.expectedFileHashes = [{ path: `${forbiddenRoot}/current.ts`, fileHash: hashes.file }];
    expectCode(() => checkExploreInput(input), "out_of_scope");
  }
});

test.each(["data.db", "data.db-wal", "data.db-shm", "index.db", "global.db", "credential.key", "cert.pem", "cert.p12"])(
  "文件%s不能通过把allowedRoot收窄为文件本身绕过后缀限制", (name) => {
    for (const rootEqualsFile of [false, true]) {
      const input = localInput();
      if (input.source.kind !== "local_file") throw new Error("local source required");
      const file = `/safe/project/${name}`;
      input.source.allowedRoot = rootEqualsFile ? file : "/safe/project";
      input.source.allowedPaths = [file]; input.source.expectedFileHashes = [{ path: file, fileHash: hashes.file }];
      expectCode(() => checkExploreInput(input), "out_of_scope");
      expectCode(() => checkExploreResult(resultFor(input), input), "out_of_scope");
    }
  },
);

test("普通源码路径等于获准根仍按同一词法契约检查", () => {
  const input = localInput();
  if (input.source.kind !== "local_file") throw new Error("local source required");
  input.source.allowedRoot = "/safe/current.ts"; input.source.allowedPaths = ["/safe/current.ts"];
  input.source.expectedFileHashes = [{ path: "/safe/current.ts", fileHash: hashes.file }];
  expect(() => checkExploreInput(input)).not.toThrow();
  expect(() => checkExploreResult(resultFor(input), input)).not.toThrow();
});

test("普通session、keys、secrets源码路径及同名祖先根在明确授权范围内有效", () => {
  for (const allowedPath of ["src/session/index.ts", "src/keys/parser.ts", "src/secrets/redact.ts"]) {
    const input = clone(knowledgeInput());
    if (input.source.kind !== "knowledge_query") throw new Error("knowledge source required");
    input.source.allowedPaths = [allowedPath];
    expect(checkExploreInput(input).source).toEqual(input.source);
  }
  const input = localInput();
  if (input.source.kind !== "local_file") throw new Error("local source required");
  input.source.allowedRoot = "/Users/keys/project";
  input.source.allowedPaths = ["/Users/keys/project/src/index.ts"];
  input.source.expectedFileHashes = [{ path: "/Users/keys/project/src/index.ts", fileHash: hashes.file }];
  expect(checkExploreInput(input).source).toEqual(input.source);
});

test("对象键重排不影响绑定，父身份、disclosure或workspace真实字段变化仍拒绝", () => {
  const web = webInput();
  const reorderedParent = clone(resultFor(web));
  reorderedParent.parent = Object.fromEntries(Object.entries(reorderedParent.parent).reverse()) as typeof reorderedParent.parent;
  expect(() => checkExploreResult(reorderedParent, web)).not.toThrow();

  const reorderedDisclosure = clone(resultFor(web));
  if (reorderedDisclosure.source.kind !== "web") throw new Error("web source required");
  reorderedDisclosure.source.disclosure = Object.fromEntries(
    Object.entries(reorderedDisclosure.source.disclosure).reverse(),
  ) as typeof reorderedDisclosure.source.disclosure;
  expect(() => checkExploreResult(reorderedDisclosure, web)).not.toThrow();

  const knowledge = knowledgeInput();
  const reorderedWorkspace = clone(resultFor(knowledge));
  const knowledgeSource = reorderedWorkspace.sources[0];
  if (knowledgeSource?.kind !== "knowledge_query") throw new Error("knowledge source required");
  knowledgeSource.workspace = Object.fromEntries(
    Object.entries(knowledgeSource.workspace).reverse(),
  ) as typeof knowledgeSource.workspace;
  expect(() => checkExploreResult(reorderedWorkspace, knowledge)).not.toThrow();

  const changedParent = clone(resultFor(web));
  changedParent.parent.parentRunId = "changed-run";
  expectCode(() => checkExploreResult(changedParent, web), "invalid_binding");

  const changedDisclosure = clone(resultFor(web));
  if (changedDisclosure.source.kind !== "web") throw new Error("web source required");
  changedDisclosure.source.disclosure.contentHash = "f".repeat(64);
  expectCode(() => checkExploreResult(changedDisclosure, web), "invalid_binding");

  const changedWorkspace = clone(resultFor(knowledge));
  if (changedWorkspace.sources[0]?.kind !== "knowledge_query") throw new Error("knowledge source required");
  changedWorkspace.sources[0].workspace.workspaceId = "f".repeat(64);
  expectCode(() => checkExploreResult(changedWorkspace, knowledge), "invalid_binding");
});

test("结果绑定需求epoch、索引baseline和本地预期hash，变化均拒绝", () => {
  const pm = knowledgeInput(pmParent);
  const changedParent = clone(resultFor(pm));
  if (changedParent.parent.requirementBinding) changedParent.parent.requirementBinding.epoch++;
  expectCode(() => checkExploreResult(changedParent, pm), "invalid_binding");

  const changedBaseline = clone(resultFor(pm));
  if (changedBaseline.sources[0]?.kind === "knowledge_query") changedBaseline.sources[0].baselineHash = "f".repeat(64);
  expectCode(() => checkExploreResult(changedBaseline, pm), "invalid_binding");

  const local = localInput();
  const changedFile = clone(resultFor(local));
  if (changedFile.sources[0]?.kind === "local_file") changedFile.sources[0].fileHash = "f".repeat(64);
  expectCode(() => checkExploreResult(changedFile, local), "invalid_binding");
});

test("实际检索范围和来源不能超出输入授权范围", () => {
  const knowledge = knowledgeInput();
  const result = clone(resultFor(knowledge));
  if (result.searchedScope.kind === "knowledge_query") result.searchedScope.paths = ["runtime/other.ts"];
  expectCode(() => checkExploreResult(result, knowledge), "out_of_scope");

  const local = localInput();
  const localResult = clone(resultFor(local));
  if (localResult.sources[0]?.kind === "local_file") localResult.sources[0].path = "/safe/project/other.ts";
  expectCode(() => checkExploreResult(localResult, local), "invalid_binding");

  const web = webInput();
  const webResult = clone(resultFor(web));
  if (webResult.searchedScope.kind === "web") webResult.searchedScope.queries = ["另一个查询"];
  expectCode(() => checkExploreResult(webResult, web), "out_of_scope");
});

test.each([
  "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com/", "https://example.com.evil.test/",
  "https://evil-example.com/", "https://EXAMPLE.com/", "https://example.com:443/",
])("恶意或未规范化URL拒绝：%s", (url) => {
  const input = webInput();
  const result = clone(resultFor(input));
  if (result.sources[0]?.kind === "web") result.sources[0].url = url;
  expectCode(() => checkExploreResult(result, input), "out_of_scope");
});

test("结果只能是research，未知PASS/approved/authorization/newRole字段拒绝", () => {
  const input = knowledgeInput();
  for (const mutation of [
    (value: Record<string, unknown>) => { value.kind = "PASS"; },
    (value: Record<string, unknown>) => { value.approved = true; },
    (value: Record<string, unknown>) => { value.authorization = "granted"; },
    (value: Record<string, unknown>) => { value.newRole = "worker"; },
  ]) {
    const result = clone(resultFor(input)) as unknown as Record<string, unknown>;
    mutation(result);
    expectCode(() => checkExploreResult(result, input), "invalid_shape");
  }
});

test("无结果仍必须明确失败、截断和未知字段，截断原因不能被丢弃", () => {
  const input = webInput();
  if (input.source.kind !== "web") throw new Error("web source required");
  const result: ExploreResult = { ...resultFor(input), conclusions: [], sources: [], searchedScope: { kind: "web", queries: [input.source.query], domains: ["example.com"] },
    notFound: ["没有命中"], failures: ["网络返回错误"], truncation: { truncated: true, reasons: ["来源预算耗尽"] }, unknown: ["正文是否已更新"] };
  expect(checkExploreResult(result, input)).toEqual(result);
  for (const field of ["notFound", "failures", "truncation", "unknown"]) {
    const missing = clone(result) as unknown as Record<string, unknown>;
    delete missing[field];
    expectCode(() => checkExploreResult(missing, input), "invalid_shape");
  }
  expectCode(() => checkExploreResult({ ...result, truncation: { truncated: false, reasons: ["不能静默丢弃"] } }, input), "invalid_shape");
});

test.each([" ", "\n", "\t", "　"])("所有非空文本项拒绝纯空白且不修改有效文本：%s", (blank) => {
  const question = { ...webInput(), question: blank };
  expectCode(() => checkExploreInput(question), "invalid_shape");

  const clue = { ...webInput(), clues: [blank] };
  expectCode(() => checkExploreInput(clue), "invalid_shape");

  const query = clone(webInput());
  if (query.source.kind !== "web") throw new Error("web source required");
  query.source.query = blank;
  expectCode(() => checkExploreInput(query), "invalid_shape");

  const disclosure = clone(webInput());
  if (disclosure.source.kind !== "web") throw new Error("web source required");
  disclosure.source.disclosure.contentScope = blank;
  expectCode(() => checkExploreInput(disclosure), "invalid_shape");

  const input = webInput();
  const quote = clone(resultFor(input));
  if (quote.sources[0]?.kind !== "web") throw new Error("web source required");
  quote.sources[0].quote = blank;
  expectCode(() => checkExploreResult(quote, input), "invalid_shape");

  for (const field of ["conclusions", "notFound", "failures", "unknown"] as const) {
    expectCode(() => checkExploreResult({ ...resultFor(input), [field]: [blank] }, input), "invalid_shape");
  }
  expectCode(() => checkExploreResult({ ...resultFor(input), truncation: { truncated: true, reasons: [blank] } }, input), "invalid_shape");

  const preservedInput = clone(webInput());
  preservedInput.question = " 公开问题 ";
  if (preservedInput.source.kind !== "web") throw new Error("web source required");
  preservedInput.source.query = " 公开查询 ";
  preservedInput.source.disclosure.contentScope = " 公开范围 ";
  const checkedInput = checkExploreInput(preservedInput);
  expect(checkedInput.question).toBe(" 公开问题 ");
  if (checkedInput.source.kind !== "web") throw new Error("web source required");
  expect(checkedInput.source.query).toBe(" 公开查询 ");
  expect(checkedInput.source.disclosure.contentScope).toBe(" 公开范围 ");
  const preservedResult = resultFor(checkedInput);
  if (preservedResult.sources[0]?.kind !== "web") throw new Error("web source required");
  preservedResult.sources[0].quote = " 支持引文 ";
  preservedResult.failures = [" 真实失败 "];
  const checkedResult = checkExploreResult(preservedResult, checkedInput);
  expect(checkedResult.sources[0]?.kind === "web" ? checkedResult.sources[0].quote : "").toBe(" 支持引文 ");
  expect(checkedResult.failures).toEqual([" 真实失败 "]);
});

test("码点和条数固定边界：question、clue、source、结论、短引文、失败/unknown", () => {
  const questionAt = { ...knowledgeInput(), question: "😀".repeat(EXPLORE_CONTRACT_LIMITS.questionCodepoints) };
  expect(() => checkExploreInput(questionAt)).not.toThrow();
  expectCode(() => checkExploreInput({ ...questionAt, question: `${questionAt.question}x` }), "resource_limit");

  const cluesAt = { ...knowledgeInput(), clues: Array(EXPLORE_CONTRACT_LIMITS.clues).fill("界".repeat(EXPLORE_CONTRACT_LIMITS.clueCodepoints)) };
  expect(() => checkExploreInput(cluesAt)).not.toThrow();
  expectCode(() => checkExploreInput({ ...cluesAt, clues: [...cluesAt.clues, "多"] }), "invalid_shape");
  expectCode(() => checkExploreInput({ ...cluesAt, clues: [`${cluesAt.clues[0]}多`] }), "resource_limit");

  const paths = Array.from({ length: EXPLORE_CONTRACT_LIMITS.sources }, (_, index) => `runtime/file-${index}.ts`);
  const sourcesAt = { ...knowledgeInput(), source: { ...knowledgeInput().source, allowedPaths: paths } } as ExploreInput;
  expect(() => checkExploreInput(sourcesAt)).not.toThrow();
  expectCode(() => checkExploreInput({ ...sourcesAt, source: { ...sourcesAt.source, allowedPaths: [...paths, "runtime/too-many.ts"] } }), "invalid_shape");

  const web = webInput();
  const result = resultFor(web);
  const at = { ...result,
    conclusions: Array(EXPLORE_CONTRACT_LIMITS.conclusions).fill("结".repeat(EXPLORE_CONTRACT_LIMITS.conclusionCodepoints)),
    failures: Array(EXPLORE_CONTRACT_LIMITS.statusItems).fill("错".repeat(EXPLORE_CONTRACT_LIMITS.statusItemCodepoints)),
    unknown: Array(EXPLORE_CONTRACT_LIMITS.statusItems).fill("疑".repeat(EXPLORE_CONTRACT_LIMITS.statusItemCodepoints)),
  } as ExploreResult;
  // 独立检查每组边界，避免组合后的总字节预算先触发。
  expect(() => checkExploreResult({ ...result, conclusions: at.conclusions }, web)).not.toThrow();
  expect(() => checkExploreResult({ ...result, failures: at.failures }, web)).not.toThrow();
  expect(() => checkExploreResult({ ...result, unknown: at.unknown }, web)).not.toThrow();
  expectCode(() => checkExploreResult({ ...result, conclusions: [`${"结".repeat(400)}多`] }, web), "resource_limit");
  expectCode(() => checkExploreResult({ ...result, conclusions: Array(17).fill("结") }, web), "invalid_shape");
  for (const field of ["notFound", "failures", "unknown"] as const) {
    expect(() => checkExploreResult({ ...result, [field]: Array(16).fill("项".repeat(400)) }, web)).not.toThrow();
    expectCode(() => checkExploreResult({ ...result, [field]: Array(17).fill("项") }, web), "invalid_shape");
    expectCode(() => checkExploreResult({ ...result, [field]: [`${"项".repeat(400)}多`] }, web), "resource_limit");
  }
  expect(() => checkExploreResult({ ...result, truncation: { truncated: true, reasons: Array(16).fill("截".repeat(400)) } }, web)).not.toThrow();
  expectCode(() => checkExploreResult({ ...result, truncation: { truncated: true, reasons: Array(17).fill("截") } }, web), "invalid_shape");
  expectCode(() => checkExploreResult({ ...result, truncation: { truncated: true, reasons: [`${"截".repeat(400)}多`] } }, web), "resource_limit");
  const quote = clone(result);
  if (quote.sources[0]?.kind === "web") quote.sources[0].quote = "引".repeat(EXPLORE_CONTRACT_LIMITS.quoteCodepoints);
  expect(() => checkExploreResult(quote, web)).not.toThrow();
  if (quote.sources[0]?.kind === "web") quote.sources[0].quote += "多";
  expectCode(() => checkExploreResult(quote, web), "resource_limit");
});

function exactInputBytes(): ExploreInput {
  for (let pathLength = 1_000; pathLength <= 4_000; pathLength++) {
    const paths = [0, 1, 2].map((index) => `/safe/project/${String(index).repeat(4_000)}`);
    paths.push(`/safe/project/${"z".repeat(pathLength)}`);
    const base: ExploreInput = { ...localInput(), question: "q", source: { kind: "local_file", indexBaseline: "not_applicable",
      allowedRoot: "/safe/project", allowedPaths: paths, expectedFileHashes: paths.map((value) => ({ path: value, fileHash: hashes.file })) } };
    const questionLength = 1 + EXPLORE_CONTRACT_LIMITS.inputBytes - Buffer.byteLength(JSON.stringify(base));
    if (questionLength >= 1 && questionLength <= EXPLORE_CONTRACT_LIMITS.questionCodepoints) return { ...base, question: "q".repeat(questionLength) };
  }
  throw new Error("无法构造精确输入字节边界");
}
function exactOutputBytes(input: ExploreInput): ExploreResult {
  if (input.source.kind !== "web") throw new Error("web input required");
  for (let count = 1; count <= EXPLORE_CONTRACT_LIMITS.sources; count++) {
    for (let quoteLength = 1; quoteLength <= EXPLORE_CONTRACT_LIMITS.quoteCodepoints; quoteLength++) {
      const base: ExploreResult = { ...resultFor(input), conclusions: ["x"],
        sources: Array.from({ length: count }, (_, index) => ({ kind: "web", indexBaseline: "not_applicable", url: `https://example.com/${index}`,
          retrievedAt: 1_800_000_000_000, quote: "\u0001".repeat(quoteLength) })),
      };
      const conclusionLength = 1 + EXPLORE_CONTRACT_LIMITS.outputBytes - Buffer.byteLength(JSON.stringify(base));
      if (conclusionLength >= 1 && conclusionLength <= EXPLORE_CONTRACT_LIMITS.conclusionCodepoints) {
        return { ...base, conclusions: ["x".repeat(conclusionLength)] };
      }
    }
  }
  throw new Error("无法构造精确输出字节边界");
}

test("完整JSON UTF-8转义按实际字节执行精确32768边界，超一字节拒绝", () => {
  const input = exactInputBytes();
  expect(Buffer.byteLength(JSON.stringify(input))).toBe(EXPLORE_CONTRACT_LIMITS.inputBytes);
  expect(() => checkExploreInput(input)).not.toThrow();
  expectCode(() => checkExploreInput({ ...input, question: `${input.question}x` }), "resource_limit");

  const web = webInput();
  const result = exactOutputBytes(web);
  expect(Buffer.byteLength(JSON.stringify(result))).toBe(EXPLORE_CONTRACT_LIMITS.outputBytes);
  expect(() => checkExploreResult(result, web)).not.toThrow();
  const over = clone(result);
  over.conclusions[0] += "x";
  expect(Buffer.byteLength(JSON.stringify(over))).toBe(EXPLORE_CONTRACT_LIMITS.outputBytes + 1);
  expectCode(() => checkExploreResult(over, web), "resource_limit");
});

test("来源数量同时受固定上限和调用预算限制，行号必须有效", () => {
  const input = webInput();
  const result = resultFor(input);
  if (result.sources[0]?.kind !== "web") throw new Error("web source required");
  const source = result.sources[0];
  const at = { ...result, sources: Array(EXPLORE_CONTRACT_LIMITS.sources).fill(source) };
  expect(() => checkExploreResult(at, input)).not.toThrow();
  expectCode(() => checkExploreResult({ ...result, sources: Array(33).fill(source) }, input), "invalid_shape");
  expectCode(() => checkExploreResult(at, { ...input, budget: { ...input.budget, maxSources: 31 } }), "out_of_scope");

  const local = localInput();
  const localResult = resultFor(local);
  if (localResult.sources[0]?.kind !== "local_file") throw new Error("local source required");
  expectCode(() => checkExploreResult({ ...localResult, sources: [{ ...localResult.sources[0], startLine: 5, endLine: 4 }] }, local), "invalid_shape");
});

test("网页取回时间是正Unix epoch毫秒，覆盖正常值、Date精确边界、越界和非整数", () => {
  const input = webInput();
  const result = resultFor(input);
  if (result.sources[0]?.kind !== "web") throw new Error("web source required");
  const source = result.sources[0];
  const maximum = 8_640_000_000_000_000;

  for (const retrievedAt of [1, 1_800_000_000_000, maximum]) {
    expect(new Date(retrievedAt).getTime()).toBe(retrievedAt);
    expect(() => checkExploreResult({ ...result, sources: [{ ...source, retrievedAt }] }, input)).not.toThrow();
  }
  for (const retrievedAt of [0, maximum + 1, Number.MAX_SAFE_INTEGER, 1.5]) {
    expectCode(() => checkExploreResult({ ...result, sources: [{ ...source, retrievedAt }] }, input), "invalid_shape");
  }
});

test("调用者声明更低maxResultBytes时使用更低限制且不截断", () => {
  const input = webInput();
  const result = resultFor(input);
  const exact = Buffer.byteLength(JSON.stringify(result));
  expect(() => checkExploreResult(result, { ...input, budget: { ...input.budget, maxResultBytes: exact } })).not.toThrow();
  expectCode(() => checkExploreResult(result, { ...input, budget: { ...input.budget, maxResultBytes: exact - 1 } }), "resource_limit");
  expect(result.conclusions).toEqual(["找到一个有界来源"]);
});
