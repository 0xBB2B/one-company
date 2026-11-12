import { afterEach, expect, test } from "vitest";
import { uuidv7, repositoryDatabase, withDatabase } from "../../../src/core/storage/database.ts";
import { implementAuthorized } from "../../../src/modules/pm/pm-intake-runtime.ts";
import type { RequirementRecord } from "../../../src/modules/requirement/requirement-contracts.ts";
import { RequirementService } from "../../../src/modules/requirement/requirement-service.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); }, 120_000);

const SPRINT = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n给角色加快跑。\n## 功能 {#features}\n快跑行为如下。\n" +
  "### 地面快跑 {#features.sprint}\n按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍。\n### 空中不变 {#features.airborne}\n角色在空中时按 Shift 不改变水平速度。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n地面快跑为行走速度的 1.5 倍，空中按 Shift 不变。\n";

type Call = { name: string; args: Record<string, unknown> };
const requestOf = (call: Call) => (call.args.request ?? call.args) as { action?: string; role?: string };
const isPrepare = (call: Call) => call.name === "one_company_project_manage" && requestOf(call).action === "workspace-prepare";
const isDispatchPm = (call: Call) => call.name === "one_company_agent_manage" && requestOf(call).role === "pm";

test.skipIf(!config || process.platform !== "darwin")("P23：需求已批准后，用户说授权实施地面快跑、空中不变以后再说时，批准清单里仍没有实施，不建工作区、不派 PM，并告诉用户要先改需求草稿或缩小范围", async () => {
  const point = await startMainPoint(config!, "p23", { seed: async (place) => {
    const service = await RequirementService.open({ repositoryRoot: place.repo, dataRoot: place.dataRoot, repoId: place.repoId, authorize: () => true });
    await service.create({ operationId: uuidv7(), requestId: uuidv7(), title: "快跑", body: SPRINT });
  } });
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  const assistantTexts = () => point.host.session.messages.flatMap((message) => message.role === "assistant"
    ? [message.content.map((block) => block.type === "text" ? block.text : "").join("")] : []);

  await point.say("快跑这个需求草稿写好了吗？把要点给我看，我看完再决定批准。");
  await point.say("批准这一版。");
  const afterApprove = point.host.session.messages.length;
  await point.say("授权实施地面快跑，空中不变以后再说。");
  const rest = point.calls(afterApprove);
  const lastText = assistantTexts().at(-1) ?? "";
  const row = withDatabase(repositoryDatabase(point.dataRoot, point.repoId), (db) => db.list<RequirementRecord>("requirements"))[0]!;
  const approved = row.data.approvalManifest !== undefined;
  const authorizedImplement = approved && implementAuthorized({ dataRoot: point.dataRoot, repoId: point.repoId } as never, row as never);
  judgement = { calls: rest.map((call) => `${call.name}:${requestOf(call).action ?? ""}`), approved, lastText, authorizedImplement };

  expect(approved, JSON.stringify(judgement)).toBe(true);
  expect(authorizedImplement, JSON.stringify(judgement)).toBe(false);
  expect(rest.some(isPrepare), JSON.stringify(judgement)).toBe(false);
  expect(rest.some(isDispatchPm), JSON.stringify(judgement)).toBe(false);
  expect(lastText, JSON.stringify(judgement)).toMatch(/草稿|范围|限制/u);
}, 30 * 60_000);
