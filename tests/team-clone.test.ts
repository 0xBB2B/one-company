import { afterEach, expect, test } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { uuidv7 } from "../src/core/storage/database.ts";
import { archivePathFor } from "../src/modules/requirement/requirement-identity.ts";

const exec = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repos() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "team-clone-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" }).trim();
  const a = join(base, "a"), b = join(base, "b"), home = join(base, "home");
  await mkdir(home);
  git(base, "init", "-q", "-b", "main", a);
  git(a, "config", "user.email", "a@example.com"); git(a, "config", "user.name", "a");
  return { base, git, a, b, home };
}

test("M8-AC1/AC3：B 克隆 A 的仓库后，没有 A 的数据库也能用普通工具读代码和已完成归档、运行示例业务，且不产生本产品数据", async () => {
  const r = await repos();
  const archive = archivePathFor(uuidv7(), "角色跳跃");
  await mkdir(join(r.a, "docs", "prd"), { recursive: true });
  await writeFile(join(r.a, archive), "# 角色跳跃\n已完成的最终需求\n");
  await writeFile(join(r.a, "app.mjs"), "console.log('跳跃', 1 + 1);\n");
  r.git(r.a, "add", "."); r.git(r.a, "commit", "-qm", "交付跳跃");
  r.git(r.base, "clone", "-q", r.a, r.b);
  expect(await readFile(join(r.b, "app.mjs"), "utf8")).toContain("跳跃");
  expect(await readFile(join(r.b, archive), "utf8")).toContain("已完成的最终需求");
  const env = { PATH: process.env.PATH, HOME: r.home };
  expect((await exec(process.execPath, [join(r.b, "app.mjs")], { cwd: r.b, env })).stdout).toBe("跳跃 2\n");
  expect(await readdir(r.home)).toEqual([]);
  expect(r.git(r.b, "ls-files")).not.toMatch(/one-company|\.db|requirements\//);
});

test("M8-AC10：两个隔离克隆各自完成同标题需求，归档用不同 UUID 加相同描述，合并不因标题碰撞冲突", async () => {
  const r = await repos();
  await writeFile(join(r.a, "README.md"), "app\n"); r.git(r.a, "add", "."); r.git(r.a, "commit", "-qm", "seed");
  r.git(r.base, "clone", "-q", r.a, r.b);
  r.git(r.b, "config", "user.email", "b@example.com"); r.git(r.b, "config", "user.name", "b");
  const first = archivePathFor(uuidv7(), "角色跳跃"), second = archivePathFor(uuidv7(), "角色跳跃");
  expect(first).not.toBe(second);
  expect([first, second].map((path) => path.replace(/^docs\/prd\/[0-9a-f-]{36}\./, ""))).toEqual(["角色跳跃.md", "角色跳跃.md"]);
  for (const [repo, path] of [[r.a, first], [r.b, second]] as const) {
    await mkdir(join(repo, "docs", "prd"), { recursive: true });
    await writeFile(join(repo, path), `# 角色跳跃\n${repo}\n`); r.git(repo, "add", "."); r.git(repo, "commit", "-qm", "归档");
  }
  r.git(r.a, "pull", "-q", "--no-rebase", "--no-edit", r.b, "main");
  expect(r.git(r.a, "ls-files", "docs/prd").split("\n").sort()).toEqual([first, second].sort());
});
