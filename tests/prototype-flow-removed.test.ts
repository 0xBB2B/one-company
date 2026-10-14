import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadRoleRules } from "../runtime/package-rules.ts";

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

test("PM 规矩和主代理提示词不再提给任务打界面标记、带 prototype 派工、在面板确认原型", async () => {
  const main = await readFile(root("rules/01-main-session.md"), "utf8");
  for (const text of [loadRoleRules("pm"), main]) {
    for (const phrase of ["ui 写成 true", "带 prototype 派", "待你确认原型"]) expect(text).not.toContain(phrase);
  }
});

test("PM 概览不再产生原型事项和等待确认原型的状态行", async () => {
  const source = await readFile(root("runtime/pm-overview.ts"), "utf8");
  expect(source).not.toMatch(/kind: "prototype"|\| "prototype"/u);
  expect(source).not.toContain("待你确认原型");
  expect(source).not.toContain("等待你确认原型");
});

test("README 写新流程和升级须知，不再有待你确认原型", async () => {
  const readme = await readFile(root("README.md"), "utf8");
  expect(readme).not.toContain("待你确认原型");
  expect(readme).toContain("升级前");
  expect(readme).toContain("做完或取消");
});
