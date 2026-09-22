import { expect, test } from "vitest";
import { uuidv7 } from "../runtime/database.ts";
import { EXPLORE_HOST_TOOLS, checkExploreCapability } from "../runtime/explore-capabilities.ts";
import type { ExploreCapabilityGrant } from "../runtime/explore-capabilities.ts";
import type { ExploreInput, ExploreResult } from "../runtime/explore-contracts.ts";
import { createResultSubmitTool } from "../runtime/result-submit.ts";
import type { ResultSubmitGrant } from "../runtime/result-submit.ts";

const requirementId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const hashes = { repo: "a".repeat(64), workspace: "b".repeat(64), baseline: "c".repeat(64), file: "d".repeat(64), disclosure: "e".repeat(64) };
const mainParent = { role: "main", parentSessionId: "session-main", parentRunId: "run-main", contextId: "context-main", requirementBinding: null } as const;
const pmParent = { role: "PM", parentSessionId: "session-pm", parentRunId: "run-pm", contextId: "context-pm",
  requirementBinding: { requirementId, epoch: 3, pmFence: 7 } } as const;
const budget = { maxSources: 32, maxResultBytes: 32_768 };
const root = "/safe/project";
const knowledge: ExploreInput = { format: "explore-input/v1", parent: pmParent, question: "定位校验逻辑", clues: [], budget,
  source: { kind: "knowledge_query", workspace: { repoId: hashes.repo, workspaceId: hashes.workspace, branch: "refs/heads/test" }, generation: 4,
    baselineHash: hashes.baseline, allowedPaths: ["runtime/current.ts"] } };
const local: ExploreInput = { format: "explore-input/v1", parent: mainParent, question: "查看本地文件", clues: [], budget,
  source: { kind: "local_file", indexBaseline: "not_applicable", allowedRoot: root, allowedPaths: [`${root}/current.ts`],
    expectedFileHashes: [{ path: `${root}/current.ts`, fileHash: hashes.file }] } };
const web: ExploreInput = { format: "explore-input/v1", parent: mainParent, question: "查公开文档", clues: [], budget,
  source: { kind: "web", indexBaseline: "not_applicable", query: "公开 API 文档", allowedDomains: ["example.com"],
    networkAuthorizationRef: "network-grant-1", disclosure: { authorizationRef: "disclosure-grant-1", contentScope: "仅公开问题", contentHash: hashes.disclosure } } };
const grant = (input: ExploreInput, networkAvailable?: boolean): ExploreCapabilityGrant => ({ input, ...(networkAvailable === undefined ? {} : { networkAvailable }) });
const decide = (g: ExploreCapabilityGrant, request: unknown) => checkExploreCapability(g, request);

test("M5-AC9：explore 只有白名单内的受限本地查找与联网能力，任意 bash/MCP/脚本/写入/派工/核心写工具一律拒绝", () => {
  expect([...EXPLORE_HOST_TOOLS.local]).toEqual(["read", "grep", "find", "ls"]);
  expect([...EXPLORE_HOST_TOOLS.network]).toEqual(["web_search", "web_fetch"]);
  for (const input of [knowledge, local, web]) {
    for (const tool of ["bash", "mcp", "write", "edit", "pi_company_agent", "agent_manage", "change_apply", "spec_change", "plan_manage",
      "requirement_manage", "pi_company_requirement_manage", "structured_output", "node", "sh", ""]) {
      expect(decide(grant(input, true), { tool, path: `${root}/current.ts` })).toEqual({ allowed: false, code: "tool_forbidden", report: "not_executed" });
    }
    expect(decide(grant(input, true), null)).toMatchObject({ allowed: false, code: "invalid_shape" });
    expect(decide(grant(input, true), { tool: "read", path: `${root}/current.ts`, role: "main" })).toMatchObject({ allowed: false, code: "invalid_shape" });
    expect(decide(grant(input, true), { tool: "read", path: 1 })).toMatchObject({ allowed: false, code: "invalid_shape" });
  }
});

test("M5-AC9：本地读取只在获准根与路径内，prod 归档、私有库、密钥与会话目录被拒；索引来源不开放直接本地读取", () => {
  const g = grant(local);
  expect(decide(g, { tool: "read", path: `${root}/current.ts` })).toEqual({ allowed: true, tool: "read", scope: "local" });
  expect(decide(g, { tool: "grep", path: `${root}/current.ts` })).toMatchObject({ allowed: true });
  expect(decide(g, { tool: "find", path: root })).toMatchObject({ allowed: true, scope: "local" });
  expect(decide(g, { tool: "ls", path: `${root}/src` })).toMatchObject({ allowed: true });
  expect(decide(g, { tool: "read", path: `${root}/other.ts` })).toMatchObject({ allowed: false, code: "out_of_scope" });
  expect(decide(g, { tool: "read", path: "/etc/passwd" })).toMatchObject({ allowed: false, code: "out_of_scope" });
  expect(decide(g, { tool: "ls", path: "/safe/project-other" })).toMatchObject({ allowed: false, code: "out_of_scope" });
  expect(decide(g, { tool: "read", path: `${root}/../current.ts` })).toMatchObject({ allowed: false, code: "out_of_scope" });
  for (const path of [`${root}/docs/prod/closed.md`, `${root}/.git/config`, `${root}/state/data.db`, `${root}/index.db-wal`, `${root}/keys/private.pem`,
    `${root}/sessions/run.json`, `${root}/.ssh/id_ed25519`, `${root}/secrets/token`]) {
    expect(decide(g, { tool: "find", path })).toMatchObject({ allowed: false, code: "forbidden_path", report: "not_executed" });
  }
  expect(decide(grant(knowledge), { tool: "read", path: `${root}/current.ts` })).toMatchObject({ allowed: false, code: "out_of_scope" });
  expect(decide(grant(web, true), { tool: "read", path: `${root}/current.ts` })).toMatchObject({ allowed: false, code: "out_of_scope" });
});

test("M5-AC10：本地与联网分离，未授权网络或外发、能力不可用、scope 越界分别明确拒绝并报告仅本地/未执行", () => {
  const search = { tool: "web_search", query: "公开 API 文档", contentHash: hashes.disclosure };
  for (const input of [knowledge, local]) {
    expect(decide(grant(input, true), search)).toEqual({ allowed: false, code: "network_unauthorized", report: "local_only" });
    expect(decide(grant(input, true), { tool: "web_fetch", url: "https://example.com/docs", contentHash: hashes.disclosure }))
      .toEqual({ allowed: false, code: "network_unauthorized", report: "local_only" });
    expect(decide(grant(input, true), { tool: "read", path: `${root}/current.ts` })).toMatchObject({ allowed: input.source.kind === "local_file" });
  }
  expect(decide(grant(web), search)).toEqual({ allowed: false, code: "network_unavailable", report: "not_executed" });
  expect(decide(grant(web, false), search)).toEqual({ allowed: false, code: "network_unavailable", report: "not_executed" });
  const online = grant(web, true);
  expect(decide(online, search)).toEqual({ allowed: true, tool: "web_search", scope: "network" });
  expect(decide(online, { ...search, query: "公开 API 文档 加上私有源码片段" })).toEqual({ allowed: false, code: "out_of_scope", report: "not_executed" });
  expect(decide(online, { ...search, contentHash: "f".repeat(64) })).toEqual({ allowed: false, code: "disclosure_unauthorized", report: "not_executed" });
  expect(decide(online, { tool: "web_fetch", url: "https://example.com/docs", contentHash: hashes.disclosure })).toEqual({ allowed: true, tool: "web_fetch", scope: "network" });
  for (const url of ["https://evil.example.org/", "https://sub.example.com/", "https://user:pw@example.com/", "ftp://example.com/", "example.com/docs", "https://example.com/../"]) {
    expect(decide(online, { tool: "web_fetch", url, contentHash: hashes.disclosure })).toMatchObject({ allowed: false, code: "out_of_scope" });
  }
  expect(decide(online, { tool: "web_fetch", url: "https://example.com/docs", contentHash: "0".repeat(64) })).toMatchObject({ allowed: false, code: "disclosure_unauthorized" });
  const injected = { ...web, source: { ...web.source, allowedDomains: ["example.com", "evil.example.org"], networkAuthorizationRef: "self-issued" } };
  expect(decide(online, { tool: "web_fetch", url: "https://evil.example.org/", contentHash: hashes.disclosure, grant: injected })).toMatchObject({ allowed: false, code: "invalid_shape" });
  expect(decide(online, { tool: "web_fetch", url: "https://evil.example.org/", contentHash: hashes.disclosure })).toMatchObject({ allowed: false, code: "out_of_scope" });
});

function research(input: ExploreInput): ExploreResult {
  return { format: "explore-result/v1", kind: "research", parent: input.parent, source: input.source, conclusions: ["找到一个有界来源"],
    sources: [{ kind: "web", indexBaseline: "not_applicable", url: "https://example.com/docs", retrievedAt: 1_800_000_000_000, quote: "公开短引文" }],
    searchedScope: { kind: "web", queries: ["公开 API 文档"], domains: ["example.com"] }, notFound: [], failures: [], truncation: { truncated: false, reasons: [] }, unknown: [] };
}

test("M5-AC9：result_submit 只接受 explore 绑定原输入的 research，research 不是 PASS；裁决动作在 M5 明确不可用", () => {
  const explorer: ResultSubmitGrant = { role: "explore", callerId: uuidv7(), runId: uuidv7(), parentRunId: "run-main" };
  const tool = createResultSubmitTool({ grant: explorer, exploreInput: web, authorize: () => true });
  const receipt = tool.execute({ action: "research", result: research(web) });
  expect(receipt).toMatchObject({ kind: "research", accepted: true, isPass: false, sourceKind: "web", parentRunId: "run-main", sources: 1 });
  expect(receipt.resultHash).toMatch(/^[0-9a-f]{64}$/);
  expect(() => tool.execute({ action: "research", result: { ...research(web), passed: true } })).toThrow(/invalid_shape/);
  expect(() => tool.execute({ action: "research", result: research(local) })).toThrow(/invalid_binding/);
  expect(() => tool.execute({ action: "research", result: { ...research(web), sources: [{ kind: "web", indexBaseline: "not_applicable",
    url: "https://evil.example.org/", retrievedAt: 1_800_000_000_000, quote: "x" }] } })).toThrow(/out_of_scope/);
  expect(() => tool.execute({ action: "verdict", result: { status: "PASS" } })).toThrow(/result_submit_denied/);
  expect(() => tool.execute({ action: "research", result: research(web), role: "worker" })).toThrow(/invalid_shape/);
  expect(() => createResultSubmitTool({ grant: { ...explorer, parentRunId: "run-other" }, exploreInput: web, authorize: () => true })).toThrow(/result_submit_denied/);
  expect(() => createResultSubmitTool({ grant: { ...explorer, role: "planner" } as never, exploreInput: web, authorize: () => true })).toThrow(/result_submit_denied/);
  const revoked = createResultSubmitTool({ grant: explorer, exploreInput: web, authorize: () => false });
  expect(() => revoked.execute({ action: "research", result: research(web) })).toThrow(/result_submit_denied/);
  for (const role of ["worker", "reviewer", "qa"] as const) {
    const other = createResultSubmitTool({ grant: { ...explorer, role }, authorize: () => true });
    expect(() => other.execute({ action: "research", result: research(web) })).toThrow(/result_submit_denied/);
    expect(() => other.execute({ action: "verdict", result: { status: "PASS" } })).toThrow(/verdict_unavailable/);
  }
  const noInput = createResultSubmitTool({ grant: explorer, authorize: () => true });
  expect(() => noInput.execute({ action: "research", result: research(web) })).toThrow(/result_submit_denied/);
});
