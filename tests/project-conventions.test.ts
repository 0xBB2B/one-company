import { afterEach, expect, test, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConventions, type ConventionsWindow } from "../src/modules/verification/project-conventions.ts";

const roots: string[] = [];
const TITLE = "订单导出";
const DRAFT = "写进草稿";

function draftInput(extra: { draftBase?: string | null } = {}) {
  const writeDraft = vi.fn(async (_content: string) => {});
  return { requirementTitle: TITLE, draftBase: extra.draftBase ?? null, writeDraft };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("仓库根 AGENTS.md 是软链接：选写进草稿后软链接和真实文件都不动，新内容交给草稿写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  const real = join(root, "real.md");
  const repo = join(root, "repo");
  const link = join(repo, "AGENTS.md");
  await mkdir(repo);
  await writeFile(real, "旧规范\n");
  await symlink(real, link);
  const input = draftInput();
  const result = await updateConventions({ repositoryRoot: repo, content: "新规范\n", ...input, decide: async () => ({ choices: [DRAFT] }) });
  expect(result).toEqual({ status: "written" });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readlink(link)).toBe(real);
  expect(await readFile(real, "utf8")).toBe("旧规范\n");
  expect(input.writeDraft).toHaveBeenCalledExactlyOnceWith("新规范\n");
});

async function windowOf(repo: string, content: string, extra: { draftBase?: string | null } = {}) {
  let seen: ConventionsWindow | undefined;
  await updateConventions({ repositoryRoot: repo, content, ...draftInput(extra), decide: async (window) => { seen = window; return { choices: [DRAFT] }; } });
  return seen;
}

async function windowTexts(repo: string, content: string, extra: { draftBase?: string | null } = {}) {
  return (await windowOf(repo, content, extra))!.lines.map((line) => line.text);
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
  expect(await readFile(real, "utf8")).toBe("旧规范\n");
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

test("仓库根 AGENTS.md 是 CRLF：差异窗口没有 \\r，未改的行显示为不变行，新增行以 + 开头，交给草稿的内容保持提交原文，根目录文件不动", async () => {
  const { repo } = await makeRepo();
  const file = join(repo, "AGENTS.md");
  await writeFile(file, "# 约定\r\n- 甲\r\n");
  const input = draftInput();
  let seen: ConventionsWindow | undefined;
  await updateConventions({ repositoryRoot: repo, content: "# 约定\n- 甲\n- 乙\n", ...input, decide: async (window) => { seen = window; return { choices: [DRAFT] }; } });
  const texts = seen!.lines.map((line) => line.text);
  expect(texts.some((text) => text.includes("\r"))).toBe(false);
  expect(texts).toContain("  # 约定");
  expect(texts).toContain("  - 甲");
  expect(texts).toContain("+ - 乙");
  expect(texts.filter((text) => text.startsWith("- ") || text.startsWith("+ "))).toEqual(["+ - 乙"]);
  expect(input.writeDraft).toHaveBeenCalledExactlyOnceWith("# 约定\n- 甲\n- 乙\n");
  expect(await readFile(file, "utf8")).toBe("# 约定\r\n- 甲\r\n");
});

test("窗口文字：标题含需求标题，说明行、三个选项、其他一行、Esc 说明与规定一字不差", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "旧规范\n");
  const window = (await windowOf(repo, "新规范\n"))!;
  expect(window.title).toBe("把这些改动写进需求「订单导出」的草稿？");
  expect(window.lines.at(-1)).toEqual({ text: "批准需求后随需求分支写入，此后这个需求派出的 PM、worker、reviewer 都按新内容工作。", tone: "muted" });
  expect(window.choices).toEqual([{ label: "写进草稿" }, { label: "不写" }]);
  expect(window.otherLabel).toBe("其他（自己输入修改意见）");
  expect(window.cancelNote).toBe("不写");
  expect(window.escapeHint).toBe("Esc 不写");
});

test("草稿里已有 AGENTS.md：差异和草稿内容比，不和仓库根目录比", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "# 约定\n- 根\n");
  const texts = await windowTexts(repo, "# 约定\n- 草稿\n- 新增\n", { draftBase: "# 约定\n- 草稿\n" });
  expect(texts).toContain(DIFF_HEADER);
  expect(texts).toContain("  - 草稿");
  expect(texts).toContain("+ - 新增");
  expect(texts.filter((text) => text.startsWith("- "))).toEqual([]);
});

test("草稿里没有 AGENTS.md 且仓库根目录也没有：窗口写明还没有，并给出全文", async () => {
  const { repo } = await makeRepo();
  const texts = await windowTexts(repo, "# 约定\n- 甲\n");
  expect(texts).toContain("仓库里还没有 AGENTS.md，要写入的全文如下：");
  expect(texts).toContain("+ - 甲");
});

test("内容和草稿里的 AGENTS.md 相同：返回 unchanged，不弹窗、不写草稿，即使和仓库根目录不同", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "根\n");
  const input = draftInput({ draftBase: "草稿\n" });
  const decide = vi.fn();
  expect(await updateConventions({ repositoryRoot: repo, content: "草稿\n", ...input, decide })).toEqual({ status: "unchanged" });
  expect(decide).not.toHaveBeenCalled();
  expect(input.writeDraft).not.toHaveBeenCalled();
});

test("草稿里没有 AGENTS.md、内容和仓库根目录相同：返回 unchanged，不弹窗、不写草稿", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "根\n");
  const input = draftInput();
  const decide = vi.fn();
  expect(await updateConventions({ repositoryRoot: repo, content: "根\n", ...input, decide })).toEqual({ status: "unchanged" });
  expect(decide).not.toHaveBeenCalled();
  expect(input.writeDraft).not.toHaveBeenCalled();
});

test("草稿里已有 AGENTS.md、内容等于仓库根目录的内容：不算 unchanged，照常弹窗", async () => {
  const { repo } = await makeRepo();
  await writeFile(join(repo, "AGENTS.md"), "根\n");
  const decide = vi.fn(async () => ({ choices: [DRAFT] }));
  const input = draftInput({ draftBase: "草稿\n" });
  expect(await updateConventions({ repositoryRoot: repo, content: "根\n", ...input, decide })).toEqual({ status: "written" });
  expect(decide).toHaveBeenCalledOnce();
  expect(input.writeDraft).toHaveBeenCalledExactlyOnceWith("根\n");
});

test("选不写、按 Esc：返回 cancelled，不写草稿", async () => {
  const { repo } = await makeRepo();
  for (const answer of [{ choices: ["不写"] }, undefined]) {
    const input = draftInput();
    expect(await updateConventions({ repositoryRoot: repo, content: "新规范\n", ...input, decide: async () => answer })).toEqual({ status: "cancelled" });
    expect(input.writeDraft).not.toHaveBeenCalled();
  }
});

test("选其他写修改意见：返回 revise 和原话，不写草稿", async () => {
  const { repo } = await makeRepo();
  const input = draftInput();
  expect(await updateConventions({ repositoryRoot: repo, content: "新规范\n", ...input, decide: async () => ({ choices: [], other: "只改一条" }) }))
    .toEqual({ status: "revise", feedback: "只改一条" });
  expect(input.writeDraft).not.toHaveBeenCalled();
});

test("内容超过规范大小上限：抛 too_large，不弹窗、不写草稿", async () => {
  const { repo } = await makeRepo();
  const input = draftInput();
  const decide = vi.fn();
  await expect(updateConventions({ repositoryRoot: repo, content: "规".repeat(6000), ...input, decide })).rejects.toMatchObject({ code: "too_large" });
  expect(decide).not.toHaveBeenCalled();
  expect(input.writeDraft).not.toHaveBeenCalled();
});
