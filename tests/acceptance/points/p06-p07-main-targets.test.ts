import { afterEach, expect, test } from "vitest";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { seedApproved, startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const SPRINT = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n给角色加快跑。\n## 功能 {#features}\n快跑行为如下。\n" +
  "### 地面快跑 {#goal.sprint}\n按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍。\n### 空中不变 {#goal.airborne}\n角色在空中时按 Shift 不改变水平速度。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n地面快跑为行走速度的 1.5 倍，空中按 Shift 不变。\n";
const JUMP = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n调整跳跃。\n## 功能 {#features}\n跳跃行为如下。\n" +
  "### 蓄力跳 {#goal.charge}\n按住空格越久跳得越高，最长按 0.3 秒计算。\n### 空中不能再跳 {#goal.air}\n空中仍然不能再次起跳。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n按住时长决定起跳高度，空中不能再跳。\n";

/** 两个已批准的需求：快跑与跳跃；返回各自编号与 @ 写法。 */
async function twoRequirements(name: string) {
  const ids: Record<string, string> = {};
  const point = await startMainPoint(config!, name, { seed: async (place) => {
    ids.sprint = await seedApproved(place, "快跑", SPRINT);
    ids.jump = await seedApproved(place, "跳跃", JUMP);
  } });
  const record = (id: string) => point.requirements().find((item) => item.requirementId === id)!;
  /** 已保存的版本与批准版本不同，说明这次改了草稿。 */
  const drafted = (id: string) => record(id).saved?.hash !== record(id).approved?.hash;
  return { point, ids, drafted, mention: (id: string, title: string) => `@[${title}#${id.slice(-8)}]` };
}

test.skipIf(!config || process.platform !== "darwin")("P6：不带 @ 说两个现有需求都要补一条，主代理判断出涉及快跑与跳跃两个需求，两份草稿都改", async () => {
  const { point, ids, drafted } = await twoRequirements("p6");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say("快跑和跳跃这两个需求都再补一条：角色死亡后不能快跑，也不能起跳。请分别更新草稿给我确认。");
  if (!(drafted(ids.sprint!) && drafted(ids.jump!))) await point.say("按你的推荐处理，两个草稿都更新后给我确认。");
  judgement = { sprint: drafted(ids.sprint!), jump: drafted(ids.jump!), requirements: point.requirements().length,
    calls: point.calls(0).map((call) => `${call.name}:${String(call.args.action ?? (call.args.request as { action?: string } | undefined)?.action ?? "")}`) };
  expect(drafted(ids.sprint!) && drafted(ids.jump!), JSON.stringify(judgement)).toBe(true);
  expect(point.requirements().length, "不该新建需求").toBe(2);
}, 20 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("P7：@快跑 说转告 PM 时主代理转给 PM、不改需求；@快跑 说追加功能时只改快跑的草稿", async () => {
  const { point, ids, drafted, mention } = await twoRequirements("p7");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  const A = mention(ids.sprint!, "快跑");
  await point.say(`${A} 转告 PM：先写测试再改代码，不要动跳跃相关的文件。这不是需求变更。`);
  const forwarded = point.calls(0).some((call) => call.name === "one_company_agent_manage" && (call.args.action ?? (call.args.request as { action?: string } | undefined)?.action) === "message");
  const instructionDrafted = drafted(ids.sprint!) || drafted(ids.jump!);
  const before = point.host.session.messages.length;
  await point.say(`${A} 追加一条：快跑时角色头顶显示一个小箭头，提示正在快跑；其余不变。请更新需求草稿给我确认。`);
  judgement = { forwarded, instructionDrafted, featureSprint: drafted(ids.sprint!), featureJump: drafted(ids.jump!),
    calls: point.calls(0).map((call) => `${call.name}:${String(call.args.action ?? (call.args.request as { action?: string } | undefined)?.action ?? "")}`),
    secondTurnCalls: point.calls(before).length };
  expect(forwarded, JSON.stringify(judgement)).toBe(true);
  expect(instructionDrafted, JSON.stringify(judgement)).toBe(false);
  expect(drafted(ids.sprint!), JSON.stringify(judgement)).toBe(true);
  expect(drafted(ids.jump!), JSON.stringify(judgement)).toBe(false);
}, 20 * 60_000);
