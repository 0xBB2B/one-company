import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { REQUIREMENT_READER_PARAMETERS, REQUIREMENT_READER_MAX_BYTES, requirementReaderContent } from "../runtime/requirement-role-reader.ts";

test("provider schema为严格object/string enum，没有角色/需求/任意ref参数", () => {
  const schema = JSON.parse(JSON.stringify(REQUIREMENT_READER_PARAMETERS));
  expect(schema.type).toBe("object"); expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.action.enum).toEqual(["read", "diff", "metadata"]);
  expect(Object.keys(schema.properties)).toEqual(["action", "cursor", "maxBytes", "sectionId"]);
  expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf/);
});
test.each(['"', "\\", "\u0001", "中😀"])("外层JSON再次转义计算预算且不破坏JSON：%s", (text) => {
  const value = { text: text.repeat(2000), source: { approvalScope: { pending: ["P"], excluded: ["E"], blocked: ["B"] } } };
  const wrapped = requirementReaderContent(value);
  expect(JSON.parse(wrapped.content[0]!.text)).toEqual(value);
  expect(Buffer.byteLength(JSON.stringify(wrapped))).toBeLessThanOrEqual(REQUIREMENT_READER_MAX_BYTES);
  expect(() => requirementReaderContent({ text: text.repeat(REQUIREMENT_READER_MAX_BYTES) })).toThrow("requirement_reader_budget");
});
test("含coverage与scope警告的最终对象恰好50KiB通过，多一字节拒绝且不裁字段", () => {
  const base = { requirementId: "req", role: "qa", text: "", approvalScope: { pending: ["P"], excluded: ["E"], blocked: ["B"] },
    coverage: { representation: "parsed_prod_body", readPages: 1, entireProdCovered: false,
      blocking: ["incomplete_prod_read", "global_constraints_and_unresolved_may_be_outside_page"],
      businessCompleteness: "not_mechanically_proven", verification: "not_evaluated", performance: "unknown" },
    not_a_formal_verdict: true, operationsSettled: true, sessionPersisted: false };
  const overhead = Buffer.byteLength(JSON.stringify(requirementReaderContent(base)));
  const value = { ...base, text: "x".repeat(REQUIREMENT_READER_MAX_BYTES - overhead) };
  const wrapped = requirementReaderContent(value);
  expect(Buffer.byteLength(JSON.stringify(wrapped))).toBe(REQUIREMENT_READER_MAX_BYTES);
  expect(JSON.parse(wrapped.content[0]!.text)).toEqual(value);
  expect(() => requirementReaderContent({ ...value, text: value.text + "x" })).toThrow("requirement_reader_budget");
});
test("元数据自身超预算明确拒绝，不删scope或切断JSON", () => {
  expect(() => requirementReaderContent({ source: { approvalScope: { pending: ["x".repeat(60_000)] } }, text: "" })).toThrow("requirement_reader_budget");
});
test("适配入口不导入旧dispatcher/role-session/session-records且仅内存会话", async () => {
  const source = await readFile(new URL("../runtime/requirement-role-reader.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from ["'][^"']*(?:daemon|role-session|session-records|run-manager)/);
  expect(source).toContain("SessionManager.inMemory(");
  expect(source).not.toMatch(/SessionManager\.(?:open|create|continueRecent)|DefaultResourceLoader|bindWorkspace|acquirePm|result_submit/);
});
test("工具包装后把原结果交给同步guard，guard后不再await或调用宿主", async () => {
  const source = await readFile(new URL("../runtime/requirement-role-reader.ts", import.meta.url), "utf8");
  const start = source.indexOf("const result = await readTool!.execute(");
  const end = source.indexOf("return wrapped;", start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const frame = source.slice(start, end + "return wrapped;".length);
  expect(frame).toMatch(/const wrapped = requirementReaderContent\(result\);[\s\S]*coverage\.add\(result\);[\s\S]*readTool!\.assertCurrent\(result\);\s*return wrapped;$/);
  expect(frame.indexOf("coverage.add(result);")).toBeLessThan(frame.indexOf("readTool!.assertCurrent(result);"));
  const afterGuard = frame.slice(frame.indexOf("readTool!.assertCurrent(result);"));
  expect(afterGuard).not.toMatch(/\bawait\b|\bhost\s*\(|\bcheck(?:Sync)?\s*\(/);
});
test("最终完整对象在settle后同步授权并统一核预算", async () => {
  const source = await readFile(new URL("../runtime/requirement-role-reader.ts", import.meta.url), "utf8");
  const start = source.indexOf("const stopped = await settle();");
  const end = source.indexOf("return result;", start);
  const frame = source.slice(start, end + "return result;".length);
  expect(frame).toMatch(/checkSync\(\);[\s\S]*const result = freeze\([\s\S]*coverage: coverage\.snapshot\(\)[\s\S]*operationsSettled:[\s\S]*requirementReaderContent\(result\);\s*return result;$/);
  expect(frame.match(/requirementReaderContent\(result\)/g)).toHaveLength(1);
});
