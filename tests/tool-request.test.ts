import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { requestParameters, shapeIssue, unwrapRequest } from "../src/core/exec/tool-request.ts";

const create = Type.Object({ action: Type.Literal("create"), repoId: Type.String(), title: Type.String(), note: Type.Optional(Type.String()) }, { additionalProperties: false });
const read = Type.Object({ action: Type.Literal("read"), repoId: Type.String(), requirementId: Type.String() }, { additionalProperties: false });

test("模型可见参数为 { request: 各动作格式的联合 }，平铺写法与多余字段都不合格", () => {
  const parameters = requestParameters([create, read]);
  expect(Value.Check(parameters, { request: { action: "create", repoId: "r", title: "t" } })).toBe(true);
  expect(Value.Check(parameters, { request: { action: "read", repoId: "r", requirementId: "q" } })).toBe(true);
  expect(Value.Check(parameters, { action: "create", repoId: "r", title: "t" })).toBe(false);
  expect(Value.Check(parameters, { request: { action: "create", repoId: "r", title: "t", requirementId: "q" } })).toBe(false);
  expect(Value.Check(parameters, { request: { action: "read", repoId: "r", requirementId: "q" }, extra: 1 })).toBe(false);
});

test("unwrapRequest 只接受恰好一个 request 键的普通对象", () => {
  expect(unwrapRequest({ request: { action: "read" } })).toEqual({ action: "read" });
  for (const raw of [undefined, null, [], "x", { action: "read" }, { request: { action: "read" }, action: "read" }]) expect(unwrapRequest(raw)).toBeUndefined();
});

test("shapeIssue 只给出字段名：多余、缺少与本动作允许的字段", () => {
  expect(shapeIssue(create, { action: "create", repoId: "r", requirementId: "q", sectionId: "x" }))
    .toBe("多余字段：requirementId、sectionId；缺少字段：title；本动作允许字段：action、repoId、title、note");
  expect(shapeIssue(create, { action: "create", repoId: "r", title: 1 })).toBe("字段值格式不符：title；本动作允许字段：action、repoId、title、note");
});

test("shapeIssue 不回显不像字段名的键，只报告数量", () => {
  const issue = shapeIssue(read, { action: "read", repoId: "r", requirementId: "q", "需求正文：角色快跑……": 1, "a b": 2 });
  expect(issue).toBe("多余字段：另有 2 个非法字段名；本动作允许字段：action、repoId、requirementId");
});
