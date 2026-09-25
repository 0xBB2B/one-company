import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const BIN = new URL("../bin/spec-check.mjs", import.meta.url).pathname;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const rule = (id: string, patch: Record<string, unknown> = {}) => ({ id, title: id, condition: "角色在地面", trigger: "按下跳跃", expected: "角色起跳", reason: "基本操作",
  dependsOn: [], exceptions: [], acceptance: [{ id: "a", given: "角色在地面", when: "按跳跃", then: "起跳" }], ...patch });
const document = (rules: unknown[]) => JSON.stringify({ schemaVersion: 1, feature: { id: "jump", title: "跳跃", aliases: [] }, rules }, null, 2) + "\n";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(temporaryRoot(), "spec-check-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
async function run(root: string, home: string) {
  try { const { stdout } = await exec(process.execPath, [BIN, root], { env: { PATH: process.env.PATH, HOME: home } }); return { code: 0, out: stdout }; }
  catch (error) { const failed = error as { code: number; stderr: string }; return { code: failed.code, out: failed.stderr }; }
}

test("M8-AC7：CI 规则检查只看当前 docs/spec，通过时退出码 0；不读 docs/prod，不在用户目录建数据库或数据目录", async () => {
  const home = await project({});
  const root = await project({ "docs/spec/player/jump.rules.json": document([rule("jump.basic")]), "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.跳跃.md": "不是规则 {",
    "docs/prod/fake.rules.json": "{ 损坏" });
  expect(await run(root, home)).toEqual({ code: 0, out: "规则检查通过：1 个文件，1 条规则\n" });
  expect(await readdir(home)).toEqual([]);
});

test("M8-AC7：格式错误、机械冲突与重复规则使检查失败并列出规则；互相声明例外的同条件规则不算冲突", async () => {
  const home = await project({});
  expect((await run(await project({ "docs/spec/player/jump.rules.json": "{ 坏" }), home)).code).toBe(1);
  const conflict = await run(await project({ "docs/spec/player/jump.rules.json": document([rule("jump.basic"), rule("jump.other", { expected: "角色下蹲" })]) }), home);
  expect(conflict).toEqual({ code: 1, out: "规则冲突：jump.basic 与 jump.other 条件和触发相同但期望不同，且未声明例外\n" });
  const duplicate = await run(await project({ "docs/spec/player/jump.rules.json": document([rule("jump.basic"), rule("jump.copy", { title: "jump.basic" })]) }), home);
  expect(duplicate).toEqual({ code: 1, out: "重复规则：jump.basic 与 jump.copy 内容相同\n" });
  const excepted = await run(await project({ "docs/spec/player/jump.rules.json": document([rule("jump.basic"), rule("jump.other", { expected: "角色下蹲", exceptions: ["jump.basic"] })]) }), home);
  expect(excepted.code).toBe(0);
});
