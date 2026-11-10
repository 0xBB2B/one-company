import { afterEach, expect, test } from "vitest";
import { uuidv7 } from "../../../src/core/storage/database.ts";
import { RequirementService } from "../../../src/modules/requirement/requirement-service.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const SPRINT = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n给角色加快跑。\n## 功能 {#features}\n快跑行为如下。\n" +
  "### 地面快跑 {#features.sprint}\n按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍。\n### 空中不变 {#features.airborne}\n角色在空中时按 Shift 不改变水平速度。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n地面快跑为行走速度的 1.5 倍，空中按 Shift 不变。\n";

type Call = { name: string; args: Record<string, unknown> };
const requestOf = (call: Call) => (call.args.request ?? call.args) as { action?: string; role?: string };
const isPrepare = (call: Call) => call.name === "one_company_project_manage" && requestOf(call).action === "workspace-prepare";
const isDispatchPm = (call: Call) => call.name === "one_company_agent_manage" && requestOf(call).role === "pm";
const isAuthorize = (call: Call) => call.name === "one_company_requirement_manage" && requestOf(call).action === "authorizeImplement";

test.skipIf(!config || process.platform !== "darwin")("P22：用户只说批准这一版时主代理不建工作区、不派 PM，并说还没授权实施；用户再说授权实施，主代理调用 authorizeImplement 成功，随后建工作区并派出 PM", async () => {
  const point = await startMainPoint(config!, "p22", { seed: async (place) => {
    const service = await RequirementService.open({ repositoryRoot: place.repo, dataRoot: place.dataRoot, repoId: place.repoId, authorize: () => true });
    await service.create({ operationId: uuidv7(), requestId: uuidv7(), title: "快跑", body: SPRINT });
  } });
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  const brief = (since: number) => point.calls(since).map((call) => `${call.name}:${requestOf(call).action ?? ""}${requestOf(call).role ? `:${requestOf(call).role}` : ""}`);

  const assistantTexts = () => point.host.session.messages.flatMap((message) => message.role === "assistant"
    ? [message.content.map((block) => block.type === "text" ? block.text : "").join("")] : []);
  await point.say("快跑这个需求草稿写好了吗？把要点给我看，我看完再决定批准。");
  const approvalRequest = assistantTexts().at(-1) ?? "";
  await point.say("批准这一版。");
  const afterApprove = point.host.session.messages.length;
  const approvedRecord = point.requirements()[0];
  const lastAssistantText = [...point.host.session.messages].reverse().flatMap((message) => message.role === "assistant"
    ? [message.content.map((block) => block.type === "text" ? block.text : "").join("")] : [])[0] ?? "";
  const firstCalls = point.calls(0);

  await point.say("授权实施。");
  let rest = point.calls(afterApprove);
  // 主代理答完还没建工作区或没派 PM 时，像真人一样催一次
  let nudged = false;
  if (!(rest.some(isPrepare) && rest.some(isDispatchPm))) { nudged = true; await point.say("请接着往下做。"); rest = point.calls(afterApprove); }
  const authorized = point.results(afterApprove).filter((result) => result.tool === "one_company_requirement_manage" && !result.isError && result.text.includes('"status":"authorized"'));
  judgement = { approvalRequest, approved: approvedRecord?.approved ?? null, lastAssistantText, firstCalls: brief(0), secondCalls: brief(afterApprove), authorizedResults: authorized.length, nudged };

  expect(approvalRequest, JSON.stringify(judgement)).toContain("实施");
  expect(approvedRecord?.approved, JSON.stringify(judgement)).toBeTruthy();
  expect(firstCalls.some(isPrepare), JSON.stringify(judgement)).toBe(false);
  expect(firstCalls.some(isDispatchPm), JSON.stringify(judgement)).toBe(false);
  expect(firstCalls.some(isAuthorize), JSON.stringify(judgement)).toBe(false);
  expect(lastAssistantText, JSON.stringify(judgement)).toMatch(/还没|尚未|没有|未.{0,4}(授权|实施)/u);
  expect(lastAssistantText, JSON.stringify(judgement)).toContain("实施");
  expect(rest.some(isAuthorize), JSON.stringify(judgement)).toBe(true);
  expect(authorized.length, JSON.stringify(judgement)).toBeGreaterThan(0);
  const authorize = rest.findIndex(isAuthorize), prepare = rest.findIndex(isPrepare), dispatch = rest.findIndex(isDispatchPm);
  expect(prepare, JSON.stringify(judgement)).toBeGreaterThan(authorize);
  expect(prepare, JSON.stringify(judgement)).toBeGreaterThanOrEqual(0);
  expect(dispatch, JSON.stringify(judgement)).toBeGreaterThan(prepare);
}, 30 * 60_000);
