import { afterEach, expect, test } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConventions, type ConventionsWindow } from "../src/modules/verification/project-conventions.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("仓库根 AGENTS.md 是软链接：选写入后软链接保留，真实文件内容等于新内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  const real = join(root, "real.md");
  const repo = join(root, "repo");
  const link = join(repo, "AGENTS.md");
  await mkdir(repo);
  await writeFile(real, "旧规范\n");
  await symlink(real, link);
  const result = await updateConventions({ repositoryRoot: repo, content: "新规范\n", decide: async () => ({ choices: ["写入"] }) });
  expect(result).toEqual({ status: "written" });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readlink(link)).toBe(real);
  expect(await readFile(real, "utf8")).toBe("新规范\n");
});

async function windowTexts(repo: string, content: string) {
  let seen: ConventionsWindow | undefined;
  await updateConventions({ repositoryRoot: repo, content, decide: async (window) => { seen = window; return { choices: ["写入"] }; } });
  return seen!.lines.map((line) => line.text);
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  return { root, repo };
}

const DIFF_HEADER = "与仓库里现有的 AGENTS.md 相比的改动：";

test("仓库根 AGENTS.md 指向仓库外文件：差异窗口在说明行上方写出真实路径", async () => {
  const { root, repo } = await makeRepo();
  const real = join(root, "real.md");
  await writeFile(real, "旧规范\n");
  await symlink(real, join(repo, "AGENTS.md"));
  const texts = await windowTexts(repo, "新规范\n");
  const note = `AGENTS.md 是软链接，实际写到 ${await realpath(real)}`;
  expect(texts).toContain(note);
  expect(texts.indexOf(note)).toBeLessThan(texts.indexOf(DIFF_HEADER));
});

test("仓库根 AGENTS.md 指向仓库内 CLAUDE.md：差异窗口写出仓库内 CLAUDE.md 的真实路径", async () => {
  const { repo } = await makeRepo();
  const claude = join(repo, "CLAUDE.md");
  await writeFile(claude, "旧规范\n");
  await symlink("CLAUDE.md", join(repo, "AGENTS.md"));
  const texts = await windowTexts(repo, "新规范\n");
  const note = `AGENTS.md 是软链接，实际写到 ${await realpath(claude)}`;
  expect(texts).toContain(note);
  expect(texts.indexOf(note)).toBeLessThan(texts.indexOf(DIFF_HEADER));
});

test("多级软链接：写出最终指向的真实文件路径", async () => {
  const { root, repo } = await makeRepo();
  const real = join(root, "real.md");
  const middle = join(root, "middle.md");
  await writeFile(real, "旧规范\n");
  await symlink(real, middle);
  await symlink(middle, join(repo, "AGENTS.md"));
  const texts = await windowTexts(repo, "新规范\n");
  expect(texts).toContain(`AGENTS.md 是软链接，实际写到 ${await realpath(real)}`);
  expect(await readFile(real, "utf8")).toBe("新规范\n");
  expect((await lstat(middle)).isSymbolicLink()).toBe(true);
  expect((await lstat(join(repo, "AGENTS.md"))).isSymbolicLink()).toBe(true);
});

test("悬空软链接：差异窗口没有软链接说明行", async () => {
  const { root, repo } = await makeRepo();
  await symlink(join(root, "gone.md"), join(repo, "AGENTS.md"));
  const texts = await windowTexts(repo, "新规范\n");
  expect(texts.some((text) => text.startsWith("AGENTS.md 是软链接"))).toBe(false);
});

test("仓库根 AGENTS.md 是普通文件：差异窗口没有软链接说明行", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "旧规范\n");
  const texts = await windowTexts(repo, "新规范\n");
  expect(texts.filter((text) => text.startsWith("AGENTS.md 是软链接"))).toEqual([]);
});

test("仓库根 AGENTS.md 是 CRLF：差异窗口没有 \\r，未改的行显示为不变行，新增行以 + 开头，写入内容保持提交原文", async () => {
  const { repo } = await makeRepo();
  const file = join(repo, "AGENTS.md");
  await writeFile(file, "# 约定\r\n- 甲\r\n");
  const texts = await windowTexts(repo, "# 约定\n- 甲\n- 乙\n");
  expect(texts.some((text) => text.includes("\r"))).toBe(false);
  expect(texts).toContain("  # 约定");
  expect(texts).toContain("  - 甲");
  expect(texts).toContain("+ - 乙");
  expect(texts.filter((text) => text.startsWith("- ") || text.startsWith("+ "))).toEqual(["+ - 乙"]);
  expect(await readFile(file, "utf8")).toBe("# 约定\n- 甲\n- 乙\n");
});
