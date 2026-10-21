import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverLocally } from "../src/modules/delivery/local-delivery.ts";
import type { DeliveryFacts, DeliveryUi } from "../src/modules/delivery/git-delivery.ts";

type Method = "squash" | "merge" | "rebase";
const ALL: Method[] = ["squash", "merge", "rebase"];

const cleanups: string[] = [];
afterEach(async () => { for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const REQUIREMENT = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const ARCHIVE = `docs/prd/${REQUIREMENT}.手机号登录.md`;
const PRD = "# 手机号登录\n正文\n";
const TITLE = `手机号登录 [${REQUIREMENT}]`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function world() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-t-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const main = join(base, "main"), worktree = join(base, "req");
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.com"); git(main, "config", "user.name", "t");
  await writeFile(join(main, "a.ts"), "a\n"); git(main, "add", "."); git(main, "commit", "-qm", "seed");
  git(main, "worktree", "add", "-q", "-b", "req/login", worktree);
  await writeFile(join(worktree, "login.ts"), "export const login = 1;\n"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "task-1: 登录");
  const codeHead = git(worktree, "rev-parse", "HEAD");
  await mkdir(join(worktree, "docs", "prd"), { recursive: true });
  await writeFile(join(worktree, ARCHIVE), PRD);
  git(worktree, "add", "-f", "--", "docs/prd");
  git(worktree, "commit", "-q", "-m", `docs(prd): 归档需求 ${REQUIREMENT}`, "-m", `Requirement: ${REQUIREMENT}`);
  const facts: DeliveryFacts = { requirementId: REQUIREMENT, closed: true, reason: "completed",
    archive: { path: ARCHIVE, archiveHash: sha256(PRD), status: "archived", prototypes: [] }, worktree, branch: "refs/heads/req/login", codeHead };
  const windows: Parameters<DeliveryUi["choose"]>[0][] = [];
  let confirms = 0;
  let duringChoose: (() => Promise<void>) | undefined;
  const ui = (pick?: string): DeliveryUi => ({
    confirm: async () => { confirms += 1; return true; },
    choose: async (window) => { windows.push(window); await duringChoose?.(); return pick; },
  });
  const advanceMain = async (file: string, content: string) => {
    await writeFile(join(main, file), content); git(main, "add", file); git(main, "commit", "-qm", `main: ${file}`);
  };
  const run = (pick: string | undefined, methods: Method[] = ALL) => deliverLocally(facts, ui(pick), { repositoryRoot: main, mergeMethods: methods });
  return { git, main, worktree, facts, windows, confirms: () => confirms, run, advanceMain, whileChoosing: (fn: () => Promise<void>) => { duringChoose = fn; },
    mainSha: () => git(main, "rev-parse", "main"), reqSha: () => git(worktree, "rev-parse", "HEAD") };
}
const message = (w: Awaited<ReturnType<typeof world>>, rev: string) => w.git(w.main, "log", "-1", "--format=%B", rev).split("\n");
const windowText = (window: { lines: Array<{ text: string }> }) => window.lines.map((line) => line.text).join("\n");

test("选压缩合并：main 多一个提交，内容等于需求分支的全部改动（含归档），说明符合约定", async () => {
  const w = await world();
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run("压缩合并");
  expect(result).toMatchObject({ status: "merged-locally", method: "squash", target: "main", rebasedAfterAcceptance: false });
  expect(w.git(w.main, "rev-list", "--count", `${oldMain}..main`)).toBe("1");
  expect(w.git(w.main, "diff", oldMain, "main")).toBe(w.git(w.main, "diff", oldMain, tip));
  expect(w.git(w.main, "show", `main:${ARCHIVE}`)).toBe(PRD.trim());
  expect((result as { head: string }).head).toBe(w.mainSha());
  const lines = message(w, "main");
  expect(lines[0]).toBe(TITLE);
  expect(lines).toEqual(expect.arrayContaining([`需求 ${REQUIREMENT}`, `交付提交 ${tip}`, `最终检查代码 ${w.facts.codeHead}`]));
  expect(lines).not.toContain("验收后已自动 rebase，这部分未重新验证。");
  expect(w.git(w.main, "log", "-1", "--format=%B", "main").split("\n").at(-1)).toBe(`Requirement: ${REQUIREMENT}`);
});

test("选普通合并：能快进时也新建有两个父提交的合并提交，说明同压缩合并", async () => {
  const w = await world();
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run("普通合并");
  expect(result).toMatchObject({ status: "merged-locally", method: "merge", target: "main" });
  expect(w.git(w.main, "rev-list", "--parents", "-n", "1", "main").split(" ")).toEqual([w.mainSha(), oldMain, tip]);
  const lines = message(w, "main");
  expect(lines[0]).toBe(TITLE);
  expect(lines).toEqual(expect.arrayContaining([`需求 ${REQUIREMENT}`, `交付提交 ${tip}`, `最终检查代码 ${w.facts.codeHead}`]));
  expect(w.git(w.main, "log", "-1", "--format=%B", "main").split("\n").at(-1)).toBe(`Requirement: ${REQUIREMENT}`);
});

test("选 rebase 合并：main 直接前进到需求分支末端，没有新提交", async () => {
  const w = await world();
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run("rebase 合并");
  expect(result).toMatchObject({ status: "merged-locally", method: "rebase", target: "main", head: tip });
  expect(w.mainSha()).toBe(tip);
  expect(w.git(w.main, "rev-list", "--count", `${oldMain}..main`)).toBe("2");
  expect(w.git(w.main, "rev-list", "--merges", "--count", `${oldMain}..main`)).toBe("0");
});

test("三种方式都勾时窗口有三项、压缩合并推荐，标题与正文行符合约定", async () => {
  const w = await world();
  await w.run(undefined);
  const window = w.windows[0]!;
  expect(window.title).toBe("合进 main，怎么合并？");
  expect(window.cancelNote).toBe("取消就不合并，需求分支保留");
  expect(window.choices.map((choice) => choice.label)).toEqual(["压缩合并", "普通合并", "rebase 合并"]);
  expect(window.choices.map((choice) => choice.recommended === true)).toEqual([true, false, false]);
  expect(window.choices[0]!.description).toBe(`main 上多一个提交；标题是“${TITLE}”，正文末行 Requirement: ${REQUIREMENT}`);
  expect(window.choices[1]!.description).toBe("保留每个提交，另加一个合并提交");
  expect(window.choices[2]!.description).toBe("保留每个提交，main 直接前进到需求分支末端");
  const text = windowText(window);
  expect(text).toContain("手机号登录");
  expect(text).toContain(`编号：${REQUIREMENT}`);
  expect(text).toContain("分支：req/login → main（仅本地，不推送）");
  expect(text).toContain("目标分支未变化");
});

test("只勾普通合并时窗口只有一项", async () => {
  const w = await world();
  await w.run(undefined, ["merge"]);
  expect(w.windows[0]!.choices.map((choice) => choice.label)).toEqual(["普通合并"]);
});

test("按 Esc：不合并，main 和需求分支都不变", async () => {
  const w = await world();
  const oldMain = w.mainSha(), tip = w.reqSha();
  expect(await w.run(undefined)).toEqual({ status: "not-merged", reason: "用户选择先不合并，需求分支保留" });
  expect(w.mainSha()).toBe(oldMain);
  expect(w.reqSha()).toBe(tip);
});

test("主仓库没检出分支时拒绝，两边提交不变，没有弹窗", async () => {
  const w = await world();
  w.git(w.main, "checkout", "-q", "--detach");
  const oldMain = w.mainSha(), tip = w.reqSha();
  expect(await w.run("压缩合并")).toEqual({ status: "rejected", reason: "主仓库当前没有检出分支", next: "请用户在主仓库检出要合进去的分支后再交付" });
  expect(w.windows).toHaveLength(0);
  expect(w.confirms()).toBe(0);
  expect(w.mainSha()).toBe(oldMain);
  expect(w.reqSha()).toBe(tip);
});

test.each([["已修改", false], ["已暂存", true]])("主仓库有%s的改动时拒绝，两边提交不变，没有弹窗", async (_label, staged) => {
  const w = await world();
  await writeFile(join(w.main, "a.ts"), "changed\n");
  if (staged) w.git(w.main, "add", "a.ts");
  const oldMain = w.mainSha(), tip = w.reqSha();
  expect(await w.run("压缩合并")).toEqual({ status: "rejected", reason: "主仓库有未提交的改动", next: "请用户提交或暂存（stash）主仓库的改动后再交付" });
  expect(w.windows).toHaveLength(0);
  expect(w.confirms()).toBe(0);
  expect(w.mainSha()).toBe(oldMain);
  expect(w.reqSha()).toBe(tip);
});

test("主仓库只有未跟踪文件时不拒绝", async () => {
  const w = await world();
  await writeFile(join(w.main, "scratch.txt"), "x\n");
  expect(await w.run("压缩合并")).toMatchObject({ status: "merged-locally" });
});

test("公共核对：归档与登记不一致时拒绝，没有弹窗", async () => {
  const w = await world();
  w.facts.archive!.archiveHash = sha256("别的内容");
  const result = await w.run("压缩合并");
  expect(result).toMatchObject({ status: "rejected" });
  expect(w.windows).toHaveLength(0);
});

test("公共核对：需求没有以完成关闭时拒绝，没有弹窗", async () => {
  const w = await world();
  w.facts.reason = "cancelled";
  expect(await w.run("压缩合并")).toMatchObject({ status: "rejected" });
  expect(w.windows).toHaveLength(0);
});

test("公共核对：需求工作区有未提交改动时拒绝，没有弹窗", async () => {
  const w = await world();
  await writeFile(join(w.worktree, "login.ts"), "dirty\n");
  expect(await w.run("压缩合并")).toMatchObject({ status: "rejected" });
  expect(w.windows).toHaveLength(0);
});

test("main 在验收后前进且不冲突：窗口提示已自动 rebase，压缩合并说明带 rebase 一行，结果标记 rebasedAfterAcceptance", async () => {
  const w = await world();
  await w.advanceMain("other.ts", "o\n");
  const result = await w.run("压缩合并");
  expect(windowText(w.windows[0]!)).toContain("目标分支在验收后前进，已自动 rebase，这部分未重新验证");
  expect(result).toMatchObject({ status: "merged-locally", method: "squash", rebasedAfterAcceptance: true });
  expect(message(w, "main")).toContain("验收后已自动 rebase，这部分未重新验证。");
  expect(w.git(w.main, "show", "main:other.ts")).toBe("o");
  expect(w.git(w.main, "show", "main:login.ts")).toBe("export const login = 1;");
});

test("main 在验收后前进且冲突：返回 conflict，没有弹窗，两边提交不变", async () => {
  const w = await world();
  await w.advanceMain("login.ts", "export const login = 2;\n");
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run("压缩合并");
  expect(result).toMatchObject({ status: "conflict", target: "main", next: "请用户手动解决冲突，重新检查和验收后再交付" });
  expect((result as { reason: string }).reason.startsWith("目标分支在验收后前进，自动 rebase 有冲突")).toBe(true);
  expect(w.windows).toHaveLength(0);
  expect(w.mainSha()).toBe(oldMain);
  expect(w.reqSha()).toBe(tip);
});

test.each<[string, Method]>([["压缩合并", "squash"], ["普通合并", "merge"], ["rebase 合并", "rebase"]])("%s遇到主仓库同名未跟踪文件：合并失败，main 不变，文件保留，需求分支和工作区仍在", async (label) => {
  const w = await world();
  await writeFile(join(w.main, "login.ts"), "本地自己的文件\n");
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run(label);
  expect(result).toMatchObject({ status: "rejected", next: "处理后再交付" });
  expect((result as { reason: string }).reason).toContain("login.ts");
  expect(w.mainSha()).toBe(oldMain);
  expect(await readFile(join(w.main, "login.ts"), "utf8")).toBe("本地自己的文件\n");
  expect(w.git(w.main, "status", "--porcelain", "--untracked-files=no")).toBe("");
  expect(w.reqSha()).toBe(tip);
  expect(existsSync(w.worktree)).toBe(true);
});

test("合并成功后需求分支和工作区都还在，仓库没有 origin 也能交付", async () => {
  const w = await world();
  expect(w.git(w.main, "remote")).toBe("");
  const tip = w.reqSha();
  expect(await w.run("压缩合并")).toMatchObject({ status: "merged-locally" });
  expect(w.git(w.main, "rev-parse", "refs/heads/req/login")).toBe(tip);
  expect(existsSync(join(w.worktree, "login.ts"))).toBe(true);
});

test("合并窗口上方有灰字交付到本地分支", async () => {
  const w = await world();
  await w.run(undefined);
  expect(w.windows[0]!.caption).toBe("交付到本地分支");
});

test("合并窗口正文依次是需求、编号、分支、归档已在分支中、目标分支状态", async () => {
  const w = await world();
  await w.run(undefined);
  const texts = w.windows[0]!.lines.map((line) => line.text);
  const branch = texts.findIndex((text) => text.startsWith("分支："));
  expect(texts.slice(0, 2)).toEqual([`需求：手机号登录`, `编号：${REQUIREMENT}`]);
  expect(texts[branch]).toBe("分支：req/login → main（仅本地，不推送）");
  expect(texts.slice(branch + 1)).toEqual(["归档已在分支中", "目标分支未变化"]);
  expect(w.windows[0]!.lines[branch + 1]!.tone).toBe("muted");
});

test("main 在验收后前进时，归档已在分支中一行在目标分支状态之前", async () => {
  const w = await world();
  await w.advanceMain("other.ts", "o\n");
  await w.run(undefined);
  const texts = w.windows[0]!.lines.map((line) => line.text);
  const archive = texts.indexOf("归档已在分支中");
  expect(archive).toBeGreaterThan(texts.findIndex((text) => text.startsWith("分支：")));
  expect(texts[archive + 1]).toBe("目标分支在验收后前进，已自动 rebase，这部分未重新验证");
});

test.each<[string, string, boolean]>([
  ["压缩合并", "能快进", false], ["普通合并", "能快进", false], ["rebase 合并", "能快进", false],
  ["压缩合并", "已分叉", true], ["普通合并", "已分叉", true], ["rebase 合并", "已分叉", true],
])("%s（主仓库%s）遇到主仓库里被忽略、需求分支却跟踪的同名文件：合并失败，main 不变，本地文件内容不变，需求分支保留", async (label, _state, diverged) => {
  const w = await world();
  const ignoreFile = join(w.git(w.main, "rev-parse", "--absolute-git-dir"), "info", "exclude");
  await writeFile(ignoreFile, ".env\n");
  await writeFile(join(w.main, ".env"), "SECRET=本地\n");
  await writeFile(join(w.worktree, ".env"), "SECRET=需求分支\n");
  w.git(w.worktree, "add", "-f", ".env"); w.git(w.worktree, "commit", "-qm", "task-2: 提交 .env");
  w.facts.codeHead = w.reqSha();
  if (diverged) await w.advanceMain("other.ts", "o\n");
  expect(w.git(w.main, "status", "--porcelain")).toBe("");
  const oldMain = w.mainSha();
  const result = await w.run(label);
  expect(result).toMatchObject({ status: "rejected", next: "处理后再交付" });
  expect((result as { reason: string }).reason).toContain(".env");
  expect(w.mainSha()).toBe(oldMain);
  expect(await readFile(join(w.main, ".env"), "utf8")).toBe("SECRET=本地\n");
  expect(w.git(w.main, "rev-parse", "refs/heads/req/login")).toBe(w.reqSha());
  expect(w.git(w.main, "show", "refs/heads/req/login:.env")).toBe("SECRET=需求分支");
  expect(existsSync(w.worktree)).toBe(true);
});

const METHODS: Array<[string]> = [["压缩合并"], ["普通合并"], ["rebase 合并"]];

async function ignoreInMain(w: Awaited<ReturnType<typeof world>>, pattern: string) {
  const ignoreFile = join(w.git(w.main, "rev-parse", "--absolute-git-dir"), "info", "exclude");
  await writeFile(ignoreFile, `${pattern}\n`);
}

async function expectRejected(w: Awaited<ReturnType<typeof world>>, label: string, path: string, localFile: string, localContent: string) {
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run(label);
  expect(result).toMatchObject({ status: "rejected", next: "处理后再交付" });
  expect((result as { reason: string }).reason).toContain(path);
  expect(w.mainSha()).toBe(oldMain);
  expect(await readFile(join(w.main, localFile), "utf8")).toBe(localContent);
  expect(w.reqSha()).toBe(tip);
  expect(w.git(w.main, "rev-parse", "refs/heads/req/login")).toBe(tip);
  expect(existsSync(w.worktree)).toBe(true);
}

test.each(METHODS)("%s遇到需求分支把已跟踪的 .env.example 改名成 .env、主仓库有被忽略的本地 .env：合并失败，main 不变，本地文件不变，需求分支和工作区仍在", async (label) => {
  const w = await world();
  await w.advanceMain(".env.example", "SECRET=\n");
  w.git(w.worktree, "rebase", "-q", "main");
  await ignoreInMain(w, ".env");
  await writeFile(join(w.main, ".env"), "SECRET=本地\n");
  w.git(w.worktree, "mv", ".env.example", ".env"); w.git(w.worktree, "commit", "-qm", "task-2: 改名");
  w.facts.codeHead = w.reqSha();
  await expectRejected(w, label, ".env", ".env", "SECRET=本地\n");
});

test.each(METHODS)("%s遇到需求分支新增主仓库里被忽略目录下的同名文件：合并失败，main 不变，本地文件不变，需求分支和工作区仍在", async (label) => {
  const w = await world();
  await ignoreInMain(w, "build/");
  await mkdir(join(w.main, "build"));
  await writeFile(join(w.main, "build", "x.txt"), "本地产物\n");
  await mkdir(join(w.worktree, "build"));
  await writeFile(join(w.worktree, "build", "x.txt"), "需求分支产物\n");
  w.git(w.worktree, "add", "-f", "build/x.txt"); w.git(w.worktree, "commit", "-qm", "task-2: 提交 build");
  w.facts.codeHead = w.reqSha();
  await expectRejected(w, label, "build/x.txt", "build/x.txt", "本地产物\n");
});

test.each(METHODS)("%s遇到需求分支一次新增数千个长路径文件、其中一个与主仓库被忽略的本地 .env 同名：合并失败，main 不变，本地文件不变", async (label) => {
  const w = await world();
  await ignoreInMain(w, ".env");
  await writeFile(join(w.main, ".env"), "SECRET=本地\n");
  await writeFile(join(w.worktree, ".env"), "SECRET=需求分支\n");
  const dir = ["a", "b", "c"].map((c) => c.repeat(120)).join("/");
  await mkdir(join(w.worktree, dir), { recursive: true });
  for (let i = 0; i < 3000; i += 1) await writeFile(join(w.worktree, dir, `f${String(i).padStart(5, "0")}-${"p".repeat(30)}`), "x\n");
  w.git(w.worktree, "add", "-f", "."); w.git(w.worktree, "commit", "-qm", "task-2: 大量新增");
  w.facts.codeHead = w.reqSha();
  await expectRejected(w, label, ".env", ".env", "SECRET=本地\n");
}, 60_000);

const ignoreCase = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-t-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    return execFileSync("git", ["config", "--type=bool", "core.ignorecase"], { cwd: dir, encoding: "utf8" }).trim() === "true";
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
})();

test.skipIf(!ignoreCase).each(METHODS)("%s在不区分大小写的文件系统上遇到需求分支新增 .ENV、主仓库有被忽略的本地 .env：合并失败，本地文件不变", async (label) => {
  const w = await world();
  expect(w.git(w.main, "config", "--type=bool", "core.ignorecase")).toBe("true");
  await ignoreInMain(w, ".env");
  await writeFile(join(w.main, ".env"), "SECRET=本地\n");
  await writeFile(join(w.worktree, ".ENV"), "SECRET=需求分支\n");
  w.git(w.worktree, "add", "-f", ".ENV"); w.git(w.worktree, "commit", "-qm", "task-2: 提交 .ENV");
  w.facts.codeHead = w.reqSha();
  await expectRejected(w, label, ".ENV", ".env", "SECRET=本地\n");
});

test.each(METHODS)("%s遇到需求分支在主仓库被忽略的本地文件 foo 下新增 foo/bar.txt：合并失败，main 不变，foo 仍是普通文件，需求分支和工作区仍在", async (label) => {
  const w = await world();
  await ignoreInMain(w, "foo");
  await writeFile(join(w.main, "foo"), "LOCAL");
  await mkdir(join(w.worktree, "foo"));
  await writeFile(join(w.worktree, "foo", "bar.txt"), "需求分支\n");
  w.git(w.worktree, "add", "-f", "foo/bar.txt"); w.git(w.worktree, "commit", "-qm", "task-2: 新增 foo/bar.txt");
  w.facts.codeHead = w.reqSha();
  await expectRejected(w, label, "foo", "foo", "LOCAL");
  expect((await lstat(join(w.main, "foo"))).isFile()).toBe(true);
});

test.each(METHODS)("%s遇到需求分支把被跟踪的符号链接 notes 换成真目录：照常合并成功，主仓库 notes/a.md 是需求分支的内容", async (label) => {
  const w = await world();
  const outside = join(w.main, "..", "outside");
  await mkdir(outside);
  await symlink(outside, join(w.main, "notes"));
  w.git(w.main, "add", "notes"); w.git(w.main, "commit", "-qm", "main: 跟踪符号链接 notes");
  w.git(w.worktree, "rebase", "-q", "main");
  w.git(w.worktree, "rm", "-q", "notes");
  await mkdir(join(w.worktree, "notes"));
  await writeFile(join(w.worktree, "notes", "a.md"), "需求分支\n");
  w.git(w.worktree, "add", "-f", "notes/a.md"); w.git(w.worktree, "commit", "-qm", "task-2: notes 换成真目录");
  w.facts.codeHead = w.reqSha();
  const oldMain = w.mainSha();
  const result = await w.run(label);
  expect(result).toMatchObject({ status: "merged-locally" });
  expect(w.mainSha()).not.toBe(oldMain);
  expect(await readFile(join(w.main, "notes", "a.md"), "utf8")).toBe("需求分支\n");
});

test("选方式期间用户在主仓库暂存了别的改动：拒绝，不把它压进需求的提交，main 不变", async () => {
  const w = await world();
  const before = w.mainSha();
  w.whileChoosing(async () => { await writeFile(join(w.main, "a.ts"), "changed\n"); w.git(w.main, "add", "a.ts"); });
  expect(await w.run("压缩合并")).toMatchObject({ status: "rejected", reason: "主仓库有未提交的改动", next: "请用户提交或暂存（stash）主仓库的改动后再交付" });
  expect(w.mainSha()).toBe(before);
  expect(w.git(w.main, "diff", "--cached", "--name-only")).toBe("a.ts");
});

test("选方式期间用户在主仓库切换了分支：拒绝，不合进别的分支", async () => {
  const w = await world();
  w.git(w.main, "branch", "other");
  const other = w.git(w.main, "rev-parse", "other");
  w.whileChoosing(async () => { w.git(w.main, "checkout", "-q", "other"); });
  expect(await w.run("rebase 合并")).toMatchObject({ status: "rejected", reason: "选合并方式期间主仓库当前分支变了", next: "请用户确认要合进去的分支后再交付" });
  expect(w.git(w.main, "rev-parse", "other")).toBe(other);
});

test("main 在验收后前进、同时归档被改过：在 rebase 之前就拒绝，需求分支不变", async () => {
  const w = await world();
  await writeFile(join(w.worktree, ARCHIVE), PRD + "改过\n"); w.git(w.worktree, "commit", "-qam", "改归档");
  await w.advanceMain("b.ts", "b\n");
  const req = w.reqSha();
  expect(await w.run("压缩合并")).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(w.reqSha()).toBe(req);
});

const ALREADY = { status: "rejected", reason: "需求分支的改动已经全部在 main 里，这个需求可能已经交付过", next: "不用再交付；要清理需求工作区就用回收工作区" };

test.each(METHODS)("%s合并之后再交付同一个需求：不弹窗，拒绝并说明已经交付过，main 的提交和提交数不变", async (label) => {
  const w = await world();
  expect(await w.run(label)).toMatchObject({ status: "merged-locally" });
  const windowsBefore = w.windows.length, head = w.mainSha(), count = w.git(w.main, "rev-list", "--count", "main");
  expect(await w.run(label)).toEqual(ALREADY);
  expect(w.windows).toHaveLength(windowsBefore);
  expect(w.mainSha()).toBe(head);
  expect(w.git(w.main, "rev-list", "--count", "main")).toBe(count);
});

test.each(METHODS)("%s：选方式期间别人往主仓库 main 提交了无关文件，拒绝，main 停在那个新提交上，other.txt 还在", async (label) => {
  const w = await world();
  let other = "";
  w.whileChoosing(async () => { await w.advanceMain("other.txt", "o\n"); other = w.mainSha(); });
  expect(await w.run(label)).toMatchObject({ status: "rejected", reason: "选合并方式期间主仓库当前分支变了" });
  expect(w.mainSha()).toBe(other);
  expect(await readFile(join(w.main, "other.txt"), "utf8")).toBe("o\n");
  expect(existsSync(join(w.main, "login.ts"))).toBe(false);
});

test.each(METHODS)("%s遇到需求分支在主仓库被忽略的符号链接 data 下新增 data/x.txt：合并失败，main 不变，data 仍是符号链接，链接指向的目录里没有新文件", async (label) => {
  const w = await world();
  const target = join(w.main, "..", "elsewhere");
  await mkdir(target);
  await ignoreInMain(w, "data");
  await symlink(target, join(w.main, "data"));
  await mkdir(join(w.worktree, "data"));
  await writeFile(join(w.worktree, "data", "x.txt"), "需求分支\n");
  w.git(w.worktree, "add", "-f", "data/x.txt"); w.git(w.worktree, "commit", "-qm", "task-2: 新增 data/x.txt");
  w.facts.codeHead = w.reqSha();
  const oldMain = w.mainSha(), tip = w.reqSha();
  const result = await w.run(label);
  expect(result).toMatchObject({ status: "rejected" });
  expect((result as { reason: string }).reason).toContain("data");
  expect(w.mainSha()).toBe(oldMain);
  expect(w.reqSha()).toBe(tip);
  expect((await lstat(join(w.main, "data"))).isSymbolicLink()).toBe(true);
  expect(existsSync(join(target, "x.txt"))).toBe(false);
});
