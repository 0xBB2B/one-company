import { expect, test } from "vitest";
import { agentManageTool, intakeSubmitTool } from "../daemon/pm-tools.ts";
import type { PmToolsInput } from "../daemon/pm-tools.ts";

const TASK = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
function input(alive: boolean): PmToolsInput {
  return { alive: () => alive, checkLease: async () => {}, agents: { dispatch: async () => ({}), explore: async () => ({}), control: async () => ({}), catalog: async () => ({}) } } as unknown as PmToolsInput;
}
const run = (tool: { execute: unknown }, params: unknown) => (tool.execute as (id: string, params: unknown) => Promise<unknown>)("t", params);

test("PM 会话已结束时派工失败，原因与参数错误分开说", async () => {
  await expect(run(agentManageTool(input(false)), { action: "dispatch", taskId: TASK }))
    .rejects.toThrow("one_company_agent_manage 的 dispatch 动作失败。\n原因：本 PM 会话已结束、被停止或已被新 PM 取代\n建议：停止操作，不要重试；由主代理决定是否重新派出 PM");
  await expect(run(agentManageTool(input(true)), { action: "dispatch", taskId: TASK, retry: { reason: "x", maxTurns: 1 }, rework: { reason: "y", maxTurns: 1 } }))
    .rejects.toThrow("原因：参数不符合该动作的格式（retry、rework、review 三者最多给一个；轮次上限是 1 到 100 的整数）");
});

test("PM 提交接手理解时会话已结束，给出原因与建议", async () => {
  await expect(run(intakeSubmitTool(input(false)), {}))
    .rejects.toThrow("one_company_user_interact失败。\n原因：本 PM 会话已结束、被停止或已被新 PM 取代\n建议：停止操作，不要重试；由主代理决定是否重新派出 PM");
});
