import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSearchCall, filterSearchResult, withoutGitEntries } from "../runtime/search-exclusion.ts";

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "search-exclusion-")));
  cleanups.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
  await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored", "a.txt"), "x");
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(root, "run.log"), "x");
  return root;
}
const call = (toolName: string, path?: string) => ({ toolName, input: path === undefined ? {} : { path } });

test("grep/find/ls 指向 .git 或被 Git 忽略的路径时拦下，普通路径与省略 path 放行；read 不受影响", async () => {
  const root = await repo();
  for (const path of [".git", ".git/config", "ignored", "ignored/a.txt", "run.log", join(root, "ignored")]) {
    expect(await checkSearchCall(call("grep", path), root)).toMatchObject({ block: true });
  }
  expect(await checkSearchCall(call("find", ".git"), root)).toMatchObject({ block: true });
  expect(await checkSearchCall(call("ls", "ignored"), root)).toMatchObject({ block: true });
  for (const path of ["src", "src/a.ts", "."]) expect(await checkSearchCall(call("grep", path), root)).toBeUndefined();
  expect(await checkSearchCall(call("grep"), root)).toBeUndefined();
  expect(await checkSearchCall(call("read", "ignored/a.txt"), root)).toBeUndefined();
  expect(await checkSearchCall(call("grep", tmpdir()), root)).toBeUndefined();
});

test("搜索结果去掉 .git 条目，保留内容里提到 .git 的普通匹配", () => {
  expect(withoutGitEntries("grep", ".git/config:3: url = x\nsrc/a.ts:1: see .git/config\nsrc/b.ts-2- ctx")).toBe("src/a.ts:1: see .git/config\nsrc/b.ts-2- ctx");
  expect(withoutGitEntries("find", ".git/HEAD\nsrc/a.ts\nsub/.git/config")).toBe("src/a.ts");
  expect(withoutGitEntries("ls", ".git/\n.gitignore\nsrc/")).toBe(".gitignore\nsrc/");
  expect(filterSearchResult({ toolName: "read", content: [{ type: "text", text: ".git/x" }] })).toBeUndefined();
  expect(filterSearchResult({ toolName: "find", content: [{ type: "text", text: ".git/x\na" }] })).toEqual({ content: [{ type: "text", text: "a" }] });
});
