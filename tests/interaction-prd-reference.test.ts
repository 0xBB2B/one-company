import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { uuidv7 } from "../src/core/storage/database.ts";
import { CandidateBinding, InteractionBasis } from "../src/modules/requirement/user-interaction-format.ts";

const sha = (digit: string, length = 64) => digit.repeat(length);
const reference = { commit: sha("a", 40), hash: sha("b") };
const basis = (prd: unknown) => ({ requirementId: uuidv7(), version: 1, epoch: 1, prd });
const binding = (from: unknown, to: unknown) => ({ candidateId: uuidv7(), operationId: uuidv7(), intentHash: sha("c"), from, to });

const badReferences: Array<[string, unknown]> = [
  ["commit 末尾带换行", { ...reference, commit: `${reference.commit}\n` }],
  ["64 位 commit 末尾带换行", { ...reference, commit: `${sha("a")}\n` }],
  ["commit 41 位", { ...reference, commit: sha("a", 41) }],
  ["commit 39 位", { ...reference, commit: sha("a", 39) }],
  ["commit 含大写", { ...reference, commit: sha("A", 40) }],
  ["hash 63 位", { ...reference, hash: sha("b", 63) }],
  ["hash 65 位", { ...reference, hash: sha("b", 65) }],
  ["hash 含大写", { ...reference, hash: sha("B") }],
  ["hash 末尾带换行", { ...reference, hash: `${sha("b")}\n` }],
  ["多余字段", { ...reference, extra: 1 }],
];

test("正文引用的 commit 接受 40 位和 64 位小写十六进制，hash 接受 64 位", () => {
  for (const commit of [sha("a", 40), sha("0", 64)]) {
    expect(Value.Check(InteractionBasis, basis({ ...reference, commit }))).toBe(true);
    expect(Value.Check(CandidateBinding, binding(null, { ...reference, commit }))).toBe(true);
  }
  expect(Value.Check(InteractionBasis, basis(null))).toBe(true);
  expect(Value.Check(CandidateBinding, binding({ ...reference }, { ...reference }))).toBe(true);
});

test.each(badReferences)("InteractionBasis.prd 拒绝：%s", (_name, prd) => {
  expect(Value.Check(InteractionBasis, basis(prd))).toBe(false);
});

test.each(badReferences)("CandidateBinding.to 拒绝：%s", (_name, to) => {
  expect(Value.Check(CandidateBinding, binding(null, to))).toBe(false);
});

test.each(badReferences)("CandidateBinding.from 拒绝：%s", (_name, from) => {
  expect(Value.Check(CandidateBinding, binding(from, reference))).toBe(false);
});
