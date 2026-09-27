import { expect, test } from "vitest";
import { deniedText } from "../extensions/requirement-manage.ts";

const error = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

test("需求与接手交互的错误只放行固定格式的错误代码与字段名提示", () => {
  expect(deniedText(error("requirement_host_denied:current_input_required"), "requirement_interaction_denied")).toBe("requirement_interaction_denied:current_input_required");
  expect(deniedText(error("requirement_host_denied:invalid_shape（多余字段：sectionId；本动作允许字段：action、repoId）"), "requirement_interaction_denied"))
    .toBe("requirement_interaction_denied:invalid_shape（多余字段：sectionId；本动作允许字段：action、repoId）");
  expect(deniedText(error("pm_intake_interaction_denied:stale_context"), "pm_intake_interaction_denied")).toBe("pm_intake_interaction_denied:stale_context");
  expect(deniedText(error("requirement_host_denied:invalid_shape"), "pm_intake_interaction_denied")).toBe("pm_intake_interaction_denied:invalid_shape");
  for (const text of ["PM 接手服务被拒绝：untrusted_main_call", "PM 接手契约拒绝：invalid_shape", "PM 接手存储被拒绝：question_changed"]) {
    expect(deniedText(error(text), "pm_intake_interaction_denied")).toBe(`pm_intake_interaction_denied:${text.split("：")[1]}`);
  }
});

test("其他错误内容、非错误结果和多段内容都只给笼统拒绝，不回显正文", () => {
  for (const event of [error("需求正文：角色快跑"), error("late"), error("requirement_host_denied:x（{\"body\":\"正文\"}）"),
    { isError: false, content: [{ type: "text", text: "requirement_host_denied:ok" }] },
    { isError: true, content: [{ type: "text", text: "requirement_host_denied:a" }, { type: "text", text: "正文" }] }]) {
    expect(deniedText(event, "pm_intake_interaction_denied")).toBe("pm_intake_interaction_denied");
  }
});
