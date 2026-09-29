import { expect, test } from "vitest";
import { Type } from "typebox";
import { AdvisedError, failureText, toolStep } from "../runtime/tool-failure.ts";
import { DaemonCallError } from "../runtime/daemon-client.ts";
import { toPiTool } from "../runtime/role-tools.ts";
import { errorData } from "../daemon/server.ts";

const advice = { why: "PM 租约已被新 PM 接管", next: "停止当前操作，等待主代理安排" };

test("错误文字只有哪一步失败、为什么、建议下一步，不含内部错误码", () => {
  const text = failureText("pi_company_plan_manage 的 update 动作", new AdvisedError("stale_pm_lease", advice));
  expect(text).toBe("pi_company_plan_manage 的 update 动作失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
  expect(text).not.toContain("stale_pm_lease");
});

test("经守护进程转发的错误从 data.advice 取原因与建议", () => {
  const text = failureText("派出 PM", new DaemonCallError("stale_pm_lease", "stale_pm_lease: 租约已换", { advice }));
  expect(text).toBe("派出 PM失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
});

test("没有原因与建议的错误也给出三段，原因带原始消息", () => {
  expect(failureText("读取", new Error("磁盘已满"))).toBe("读取失败。\n原因：未归类的错误（磁盘已满）\n建议：可以重试一次；仍然失败就把这段原因告诉用户");
});

test("步骤名取工具名与动作，参数包在 request 里或平铺都能取到", () => {
  expect(toolStep("pi_company_plan_manage", { request: { action: "update" } })).toBe("pi_company_plan_manage 的 update 动作");
  expect(toolStep("pi_company_agent_manage", { action: "dispatch" })).toBe("pi_company_agent_manage 的 dispatch 动作");
  expect(toolStep("pi_company_git_deliver", { repoId: "a" })).toBe("pi_company_git_deliver");
});

test("核心工具抛错时，模型拿到的是三段原因", async () => {
  const tool = toPiTool("plan_manage", "计划", Type.Object({}), {
    execute: () => { throw new AdvisedError("stale_pm_lease", advice); }, dispose: () => {},
  });
  const run = (tool.execute as (id: string, params: unknown) => Promise<unknown>)("t", { request: { action: "update" } });
  await expect(run).rejects.toThrow("pi_company_plan_manage 的 update 动作失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
});

test("守护进程回错时把原因与建议放进 data.advice，客户端据此还原三段", () => {
  const data = errorData(new AdvisedError("stale_pm_lease", advice));
  expect(data).toEqual({ advice });
  expect(failureText("派出 PM", new DaemonCallError("stale_pm_lease", "x", data))).toContain("原因：PM 租约已被新 PM 接管");
});
