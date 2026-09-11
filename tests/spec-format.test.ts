import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkSpecSet } from "../runtime/spec-format.ts";
import type { SpecDocument, SpecRule } from "../runtime/spec-format.ts";
import { canonicalJson, parseStrictJson } from "../runtime/strict-json.ts";
import { createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
function rule(id = "player.move"): SpecRule {
  return { id, title: "r", condition: "", trigger: "t", expected: "e", reason: "", dependsOn: [], exceptions: [], acceptance: [] };
}
function document(rules = [rule()]): SpecDocument { return { $schema: "../schema.json", schemaVersion: 1, feature: { id: "player", title: "f", aliases: [] }, rules }; }
function source(value: unknown, path = "docs/spec/player/move.rules.json") { return { path, content: JSON.stringify(value) }; }

for (const length of [1499, 1500, 1501]) {
  test(`规则${length}个码点，emoji和JSON转义不能绕过门槛`, () => {
    const doc = document(); doc.rules[0]!.expected = "😀".repeat(length - 3);
    const input = source(doc);
    const escaped = { ...input, content: input.content.replaceAll("😀", "\\ud83d\\ude00") };
    if (length <= 1500) {
      const a = checkSpecSet([input]), b = checkSpecSet([escaped]);
      expect(a.rules[0]!.codepoints).toBe(length);
      expect(a.contractSetHash).toBe(b.contractSetHash);
      expect(a.fileHashes[input.path]).not.toBe(b.fileHashes[input.path]);
    } else {
      for (const value of [input, escaped]) expect(() => checkSpecSet([value])).toThrow(/split_required/);
    }
  });
}
for (const size of [6, 7]) {
  test(`${size}个验收场景`, () => {
    const doc = document(); doc.rules[0]!.acceptance = Array.from({ length: size }, (_, i) => ({ id: `ac-${i}`, given: "", when: "做", then: "看" }));
    if (size === 6) expect(checkSpecSet([source(doc)]).rules[0]!.rule.acceptance).toHaveLength(6);
    else expect(() => checkSpecSet([source(doc)])).toThrow(/invalid_schema/);
  });
}

test("标题、原因、功能别名和所有验收文字均计入，不隐藏长正文", () => {
  for (const change of [
    (doc: SpecDocument) => { doc.feature.aliases = ["文".repeat(1500)]; },
    (doc: SpecDocument) => { doc.rules[0]!.reason = "文".repeat(1500); },
    (doc: SpecDocument) => { doc.rules[0]!.acceptance = [{ id: "a", given: "文".repeat(1500), when: "做", then: "看" }]; },
  ]) { const doc = document(); change(doc); expect(() => checkSpecSet([source(doc)])).toThrow(/split_required/); }
});

for (const raw of ['{"a":1,"a":2}', String.raw`{"a":1,"\u0061":2}`, '{"nested":[{"a":1,"a":2}]}']) {
  test(`重复JSON键拒绝：${raw}`, () => expect(() => parseStrictJson(raw)).toThrow(/duplicate_key/));
}
for (const raw of ['', '{', '[1,]', '{"x":1,}', 'true false', '01', '1e309', String.raw`"\ud800"`, '<<<<<<< conflict']) {
  test(`非法JSON或Unicode拒绝：${JSON.stringify(raw)}`, () => expect(() => parseStrictJson(raw)).toThrow());
}

test("JSON语义与稳定序列化保留null、数组顺序和Unicode形式", () => {
  expect(canonicalJson(parseStrictJson('{"b":null,"a":["😀",true,1]}'))).toBe('{"a":["😀",true,1],"b":null}');
  expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  expect(canonicalJson("é")).not.toBe(canonicalJson("e\u0301"));
  const object = parseStrictJson('{"__proto__":{"polluted":true}}');
  expect(Object.getPrototypeOf(object)).toBeNull();
  expect(canonicalJson(object)).toBe('{"__proto__":{"polluted":true}}');
});

test("未知字段、正文容器、未知schema及外部schema入口拒绝", () => {
  const doc = document();
  for (const invalid of [
    { ...doc, metadata: { body: "hidden" } }, { ...doc, schemaVersion: 2 }, { ...doc, $schema: "https://example.invalid/schema.json" },
    { ...doc, rules: [{ ...rule(), attachment: "hidden" }] },
    { ...doc, rules: [{ ...rule(), dependsOn: ["../body.md"] }] },
    { ...doc, rules: [{ ...rule(), exceptions: ["这不是纯规则引用"] }] },
    { ...doc, rules: [{ ...rule(), acceptance: [{ id: "a", given: "", when: "do", then: "done", rawContent: "hidden" }] }] },
  ]) expect(() => checkSpecSet([source(invalid)])).toThrow(/invalid_schema/);
});

test("$schema从根层、一层和多层规则目录正确指向唯一schema，省略时仍有效", () => {
  for (const [path, schemaRef] of [
    ["docs/spec/root.rules.json", "schema.json"],
    ["docs/spec/player/move.rules.json", "../schema.json"],
    ["docs/spec/player/movement/move.rules.json", "../../schema.json"],
  ]) {
    const doc = document(); doc.$schema = schemaRef;
    expect(checkSpecSet([source(doc, path)]).rules).toHaveLength(1);
  }
  const omitted = document(); delete omitted.$schema;
  expect(checkSpecSet([source(omitted, "docs/spec/player/movement/omitted.rules.json")]).rules).toHaveLength(1);
});

test("$schema逃出docs/spec、指向子目录或使用错误层数时明确拒绝", () => {
  for (const [path, schemaRef] of [
    ["docs/spec/escape.rules.json", "../../schema.json"],
    ["docs/spec/player/subdir.rules.json", "./schema.json"],
    ["docs/spec/player/movement/shallow.rules.json", "../schema.json"],
    ["docs/spec/player/movement/escape.rules.json", "../../../schema.json"],
  ]) {
    const doc = document(); doc.$schema = schemaRef;
    expect(() => checkSpecSet([source(doc, path)])).toThrow(/invalid_schema_target.*docs\/spec\/schema\.json/);
  }
});

test("重复规则、重复场景、悬空引用、循环和路径穿越拒绝", () => {
  expect(() => checkSpecSet([source(document([rule(), rule()]))])).toThrow(/duplicate_id/);
  expect(() => checkSpecSet([source(document()), source(document(), "docs/spec/player/other.rules.json")])).toThrow(/duplicate_id/);
  const duplicate = rule(); duplicate.acceptance = [1, 2].map(() => ({ id: "same", given: "", when: "do", then: "done" }));
  expect(() => checkSpecSet([source(document([duplicate]))])).toThrow(/duplicate_scenario/);
  expect(() => checkSpecSet([source(document([{ ...rule(), dependsOn: ["missing"] }]))])).toThrow(/missing_reference/);
  expect(() => checkSpecSet([source(document([{ ...rule("a"), dependsOn: ["b"] }, { ...rule("b"), exceptions: ["a"] }]))])).toThrow(/reference_cycle/);
  for (const path of ["docs/prod/archive.rules.json", "docs/spec/../prod/a.rules.json", "/docs/spec/a.rules.json"]) {
    expect(() => checkSpecSet([source(document(), path)])).toThrow(/invalid_path/);
  }
});

test("排版/键顺序只改变fileHash，语义、依赖、增加删除改变规则集合指纹", () => {
  const a = source(document());
  const base = checkSpecSet([a]);
  const b = { ...a, content: JSON.stringify(document(), null, 2) + "\r\n" };
  expect(checkSpecSet([b]).contractSetHash).toBe(base.contractSetHash);
  expect(checkSpecSet([b]).fileHashes[a.path]).not.toBe(base.fileHashes[a.path]);
  const changed = document(); changed.rules[0]!.reason = "说明";
  expect(checkSpecSet([source(changed)]).rules[0]!.contractHash).not.toBe(base.rules[0]!.contractHash);
  const dependency = { ...rule("child"), dependsOn: ["player.move"] };
  const linked = checkSpecSet([a, source(document([dependency]), "docs/spec/player/child.rules.json")]);
  const updated = checkSpecSet([source(changed), source(document([dependency]), "docs/spec/player/child.rules.json")]);
  expect(linked.rules.find((r) => r.rule.id === "child")!.contractHash).not.toBe(updated.rules.find((r) => r.rule.id === "child")!.contractHash);
  expect(linked.contractSetHash).not.toBe(base.contractSetHash);
  expect(checkSpecSet([]).contractSetHash).not.toBe(base.contractSetHash);
  expect(() => checkSpecSet([{ ...a, content: "{" }])).toThrow();
});

test("较长规则引用链使用有序图计算，不依赖JavaScript递归栈", () => {
  const rules = Array.from({ length: 2000 }, (_, i) => ({ ...rule(`r${String(i).padStart(4, "0")}`), dependsOn: i === 1999 ? [] : [`r${String(i + 1).padStart(4, "0")}`] }));
  expect(checkSpecSet([source(document(rules))]).rules).toHaveLength(2000);
});

test("相同条件不同结果只提示候选冲突，单一职责和合法例外仍需审查", () => {
  const checked = checkSpecSet([source(document([rule("a"), { ...rule("b"), expected: "different", exceptions: ["a"] }]))]);
  expect(checked.semanticReview).toEqual({ required: true, ruleIds: ["a", "b"], conflictCandidates: [{ left: "a", right: "b" }] });
});

test("M1-AC1：两份真实本地Git克隆在不同Node进程得到相同规则指纹", async () => {
  const repo = await createRepoFixture();
  const root = await mkdtemp(join(temporaryRoot(), "spec-clones-"));
  try {
    const path = "docs/spec/player/move.rules.json";
    await mkdir(join(repo.root, "docs/spec/player"), { recursive: true });
    await writeFile(join(repo.root, path), source(document()).content);
    await exec("git", ["add", "--", path], { cwd: repo.root, env: GIT_ENV });
    await exec("git", ["commit", "-m", "fixture spec"], { cwd: repo.root, env: GIT_ENV });
    const script = `import {readFileSync} from 'node:fs'; import {checkSpecSet} from ${JSON.stringify(new URL("../runtime/spec-format.ts", import.meta.url).href)};
console.log(checkSpecSet([{path:${JSON.stringify(path)},content:readFileSync(${JSON.stringify(path)},'utf8')}]).contractSetHash);`;
    const hashes: string[] = [];
    for (const name of ["a", "b"]) {
      const cwd = join(root, name);
      await exec("git", ["clone", "--local", "--no-hardlinks", repo.root, cwd], { env: GIT_ENV });
      const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd });
      hashes.push(stdout.trim());
    }
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/); expect(hashes[0]).toBe(hashes[1]);
  } finally { await removeRepoFixture(repo); await rm(root, { recursive: true, force: true }); }
});
