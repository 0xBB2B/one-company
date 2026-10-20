import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
