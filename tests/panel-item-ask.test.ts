import { expect, test } from "vitest";
import { FIXED_CHOICES, fixedChoiceIssue } from "../runtime/panel-item-ask.ts";

test("M8L-AC3：固定选项须逐一相同、顺序一致，轮数上限只能是 1 到 1000 的整数", () => {
  expect(fixedChoiceIssue(FIXED_CHOICES.retry, ["再给一次机会，轮数上限 40", "调整目标或范围", "终止这个任务"])).toBeNull();
  expect(fixedChoiceIssue(FIXED_CHOICES.retry, ["再给一次机会，轮数上限 1000", "调整目标或范围", "终止这个任务"])).toBeNull();
  for (const turns of ["0", "1001", "04", "3.5", ""]) {
    expect(fixedChoiceIssue(FIXED_CHOICES.retry, [`再给一次机会，轮数上限 ${turns}`, "调整目标或范围", "终止这个任务"])).toContain("「再给一次机会，轮数上限 N」");
  }
  expect(fixedChoiceIssue(FIXED_CHOICES.acceptance, ["暂不验收", "验收通过"])).not.toBeNull();
  expect(fixedChoiceIssue(FIXED_CHOICES.requirement, ["调整需求", "取消需求"])).not.toBeNull();
});
