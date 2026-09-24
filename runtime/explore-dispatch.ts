import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative } from "node:path";
import { checkExploreInput, EXPLORE_CONTRACT_LIMITS, isForbiddenFileName, isForbiddenRelativePath } from "./explore-contracts.ts";
import type { ExploreInput } from "./explore-contracts.ts";

export class ExploreDispatchError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); this.name = "ExploreDispatchError"; this.code = code; }
}
const deny = (code: string, detail?: string): never => { throw new ExploreDispatchError(code, detail); };

/** 派出方只给检索目标；来源绑定、文件 hash 与授权都由宿主生成。 */
export type ExploreSourceRequest = { kind: "local_file"; paths: string[] };
export interface ExploreRequest {
  question: string;
  clues: string[];
  source: ExploreSourceRequest;
  maxSources?: number;
  maxResultBytes?: number;
}

/**
 * 获准直接本地读取：路径须在允许根内、是普通文件且不命中私有位置；宿主读取实际内容计算 hash，
 * 按真实路径登记，符号链接或越界一律拒绝。
 */
export async function localFileSource(root: string, paths: readonly string[]): Promise<Extract<ExploreInput["source"], { kind: "local_file" }>> {
  if (paths.length === 0 || paths.length > EXPLORE_CONTRACT_LIMITS.sources) deny("out_of_scope", "路径数量不在允许范围");
  const realRoot = await realpath(root);
  const allowed: string[] = [], hashes: Array<{ path: string; fileHash: string }> = [];
  for (const value of paths) {
    if (!isAbsolute(value) || normalize(value) !== value) deny("out_of_scope", value);
    const stat = await lstat(value).catch(() => deny("out_of_scope", `${value} 不存在`));
    if (!stat.isFile()) deny("out_of_scope", `${value} 不是普通文件`);
    const real = await realpath(value);
    const rel = relative(realRoot, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || isForbiddenFileName(real) || isForbiddenRelativePath(rel)) deny("out_of_scope", value);
    if (allowed.includes(real)) continue;
    allowed.push(real);
    hashes.push({ path: real, fileHash: createHash("sha256").update(await readFile(real)).digest("hex") });
  }
  return { kind: "local_file", indexBaseline: "not_applicable", allowedRoot: realRoot, allowedPaths: allowed, expectedFileHashes: hashes };
}

export function exploreInput(parent: ExploreInput["parent"], request: ExploreRequest, source: ExploreInput["source"]): ExploreInput {
  return checkExploreInput({ format: "explore-input/v1", parent, question: request.question, clues: request.clues,
    budget: { maxSources: request.maxSources ?? 8, maxResultBytes: request.maxResultBytes ?? 16_384 }, source });
}

/** explore 会话的任务说明：只含检索问题、线索、范围与结果格式，不含父会话、prod 或私有数据。 */
export function exploreContext(input: ExploreInput, maxTurns: number): string {
  const source = input.source;
  const scope = source.kind === "local_file"
    ? ["检索来源：获准直接读取的本地文件（未使用索引，indexBaseline=not_applicable）。只能读取下列文件：",
      ...source.expectedFileHashes.map((entry) => `- ${entry.path}（fileHash ${entry.fileHash}）`)]
    : source.kind === "web" ? [`检索来源：联网搜索，查询词固定为「${source.query}」，只能抓取搜索结果中的网址。`]
      : ["检索来源：主仓库索引（knowledge_query）。允许的路径：", ...source.allowedPaths.map((path) => `- ${path}`)];
  return [`问题：${input.question}`, ...(input.clues.length ? ["线索：", ...input.clues.map((clue) => `- ${clue}`)] : []), ...scope,
    `预算：来源最多 ${input.budget.maxSources} 条，结果不超过 ${input.budget.maxResultBytes} 字节；对话轮次上限：${maxTurns}。`,
    "完成后调用 pi_company_result_submit（action=research），result 含 conclusions、sources、searchedScope、notFound、failures、truncation{truncated,reasons}、unknown；parent 与 source 由宿主填写，可省略。",
    "本地来源的 sources 条目为 {kind, indexBaseline:\"not_applicable\", path, fileHash, startLine, endLine}，fileHash 取上面列出的值；网页来源为 {kind:\"web\", indexBaseline:\"not_applicable\", url, retrievedAt, quote}。",
  ].join("\n");
}
