import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_MERGE_CHOICE, deliverRequirement, REVIEW_CHOICE } from "../src/modules/delivery/git-delivery.ts";
import type { DeliveryFacts, DeliveryUi } from "../src/modules/delivery/git-delivery.ts";

const cleanups: string[] = [];
const originalPath = process.env.PATH;
beforeEach(() => { process.env.PATH = originalPath; });
afterEach(async () => { process.env.PATH = originalPath; for (const key of ["FAKE_CREATE_FAILS", "FAKE_SQUASH", "FAKE_MERGE_COMMIT", "FAKE_REBASE", "FAKE_REPO_VIEW_FAILS"]) delete process.env[key]; for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true }); });

const REQUIREMENT = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const ARCHIVE = `docs/prd/${REQUIREMENT}.手机号登录.md`;
const PRD = "# 手机号登录\n不得出现在 PR 里的需求正文\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * 假的 gh/glab：把每次调用写进日志，PR/MR 列表存在状态文件里；
 * FAKE_CREATE_FAILS=1 时创建成功但以失败退出（结果不明），FAKE_SQUASH=0 / FAKE_MERGE_COMMIT=0 / FAKE_REBASE=0 时 GitHub 仓库不允许对应合并方式，FAKE_REPO_VIEW_FAILS=1 时 `gh repo view` 报错退出。
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.FAKE_STATE, name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify([name, ...args]) + "\\n");
const file = path.join(dir, "requests.json"), list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const flag = (key) => args[args.indexOf(key) + 1];
if (name === "gh" && args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify(list.filter((r) => r.branch === flag("--head")).map((r) => ({ number: r.n, url: r.url }))));
else if (name === "glab" && args[0] === "mr" && args[1] === "list") process.stdout.write(JSON.stringify(list.filter((r) => r.branch === flag("--source-branch")).map((r) => ({ iid: r.n, web_url: r.url }))));
else if (args[1] === "create") {
  const branch = flag(name === "gh" ? "--head" : "--source-branch"), n = list.length + 1;
  list.push({ n, branch, url: "https://example.test/" + n }); fs.writeFileSync(file, JSON.stringify(list));
  if (process.env.FAKE_CREATE_FAILS === "1") { process.stderr.write("timeout"); process.exit(1); }
} else if (name === "gh" && args[0] === "repo" && process.env.FAKE_REPO_VIEW_FAILS === "1") { process.stderr.write("HTTP 502: Bad Gateway"); process.exit(1); }
else if (name === "gh" && args[0] === "repo") process.stdout.write(JSON.stringify({ squashMergeAllowed: process.env.FAKE_SQUASH !== "0", mergeCommitAllowed: process.env.FAKE_MERGE_COMMIT !== "0", rebaseMergeAllowed: process.env.FAKE_REBASE !== "0" }));
`;

async function world(host: "github" | "gitlab" = "github", prototypes: ReadonlyArray<readonly [string, string]> = []) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "git-delivery-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const remote = join(base, `${host}.example`, "team", "app.git"), main = join(base, "main"), other = join(base, "other"), worktree = join(base, "req");
  const identity = (cwd: string) => { git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); };
  await mkdir(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(base, "clone", "-q", remote, other); identity(other);
  await writeFile(join(other, "a.ts"), "a\n"); git(other, "add", "."); git(other, "commit", "-qm", "seed"); git(other, "push", "-q", "origin", "main");
  git(base, "clone", "-q", remote, main); identity(main);
  git(main, "worktree", "add", "-q", "-b", "req/login", worktree);
  await writeFile(join(worktree, "login.ts"), "export const login = 1;\n"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "task-1: 登录");
  const codeHead = git(worktree, "rev-parse", "HEAD");
  await mkdir(join(worktree, "docs", "prd"), { recursive: true });
  await writeFile(join(worktree, ARCHIVE), PRD);
  for (const [name, html] of prototypes) await writeFile(join(worktree, `docs/prd/${REQUIREMENT}.${name}.html`), html);
  git(worktree, "add", "-f", "--", "docs/prd");
  git(worktree, "commit", "-q", "-m", `docs(prd): 归档需求 ${REQUIREMENT}`, "-m", `Requirement: ${REQUIREMENT}`);
  const bin = join(base, "bin"), state = join(base, "state");
  await mkdir(bin); await mkdir(state);
  for (const name of ["gh", "glab"]) { await writeFile(join(bin, name), FAKE_CLI); await chmod(join(bin, name), 0o755); }
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.FAKE_STATE = state;
  for (const key of ["FAKE_CREATE_FAILS", "FAKE_SQUASH", "FAKE_MERGE_COMMIT", "FAKE_REBASE", "FAKE_REPO_VIEW_FAILS"]) delete process.env[key];
  const facts: DeliveryFacts = { requirementId: REQUIREMENT, closed: true, reason: "completed", archive: { path: ARCHIVE, archiveHash: sha256(PRD), status: "archived",
      prototypes: prototypes.map(([name, html], index) => ({ path: `docs/prd/${REQUIREMENT}.${name}.html`, name, version: index + 1, hash: sha256(html) })) },
    worktree, branch: "refs/heads/req/login", codeHead };
  const prompts: string[] = [];
  const windows: Parameters<DeliveryUi["choose"]>[0][] = [];
  const ui = (confirm = true, ...pick: [(string | undefined)?]): DeliveryUi => ({
    confirm: async (window) => { prompts.push(window.lines.map((line) => line.text).join("\n")); return confirm; },
    choose: async (window) => { prompts.push(`${window.title}（${window.cancelNote}）`); windows.push(window); return pick.length ? pick[0] : REVIEW_CHOICE; },
  });
  const calls = async () => (await readFile(join(state, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const remoteBranch = () => { try { return git(remote, "rev-parse", "refs/heads/req/login"); } catch { return null; } };
  const archiveCommits = () => Number(git(worktree, "rev-list", "--count", "--grep", "^docs(prd): 归档需求", "HEAD"));
  return { git, main, other, worktree, remote, facts, ui, prompts, windows, calls, remoteBranch, archiveCommits };
}

test("M8-AC5/AC6：确认后不提交任何文件、推送准确提交号、建 PR（描述无 PRD 正文），用户选自动合并时在仓库允许 rebase 时用 rebase 并绑定已推送提交；选项按仓库允许的方式给出", async () => {
  const w = await world();
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  const result = await deliverRequirement(w.facts, w.ui(true, AUTO_MERGE_CHOICE));
  expect(result).toMatchObject({ status: "delivered", provider: "gh", reused: false, rebasedAfterAcceptance: false, merge: "auto", url: "https://example.test/1" });
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(head);
  expect(w.archiveCommits()).toBe(1);
  expect(w.prompts[0]).toContain("归档已在分支中");
  expect(result.status === "delivered" && result.head).toBe(head);
  expect(w.remoteBranch()).toBe(head);
  expect(w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).toBe(ARCHIVE);
  const calls = await w.calls();
  const create = calls.find((call) => call[2] === "create")!;
  expect(create).toEqual(expect.arrayContaining(["--head", "req/login", "--base", "main", "--title", `手机号登录 [${REQUIREMENT}]`]));
  expect(JSON.stringify(calls)).not.toContain("不得出现在 PR 里的需求正文");
  expect(calls.find((call) => call[2] === "merge")).toEqual(["gh", "pr", "merge", "1", "--auto", "--rebase", "--match-head-commit", head]);
  expect(w.windows[0].title).toBe("PR 已就绪，怎么合并？");
  expect(w.windows[0].cancelNote).toBe("取消等于自己 review");
  expect(w.windows[0].lines.find((line) => line.text.startsWith("PR：") && line.text.includes("https://example.test/1"))?.tone).toBe("muted");
  expect(w.windows[0].lines.some((line) => line.text === "仓库不允许 rebase 合并，自动合并请从仓库允许的方式里选。")).toBe(false);
  expect(w.windows[0].choices).toEqual([
    { label: "自己 review", description: "PR 留着等你看，合并由你在网页上操作" },
    { label: "自动合并", description: "等仓库要求的检查通过后，用 rebase 自动合并" }]);
});

test("M8-AC6：选自己 review 或按 Esc 时都不触发合并、结果为自己 review", async () => {
  const w = await world();
  expect(await deliverRequirement(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered", merge: "review" });
  expect(await deliverRequirement(w.facts, w.ui(true, "自己 review"))).toMatchObject({ status: "delivered", merge: "review" });
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("M8-AC6：GitHub 仓库不允许 rebase 时提示原因，并按合并提交、squash 的顺序只列仓库允许的自动合并方式", async () => {
  const note = "仓库不允许 rebase 合并，自动合并请从仓库允许的方式里选。";
  const both = await world();
  process.env.FAKE_REBASE = "0";
  await deliverRequirement(both.facts, both.ui());
  expect(both.windows[0].lines.find((line) => line.text === note)?.tone).toBe("muted");
  expect(both.windows[0].choices).toEqual([
    { label: "自己 review", description: "PR 留着等你看，合并由你在网页上操作" },
    { label: "自动合并（合并提交）", description: "保留每个提交，另加一个合并提交" },
    { label: "自动合并（squash）", description: "所有提交压成一个" }]);

  for (const [label, flag] of [["自动合并（合并提交）", "--merge"], ["自动合并（squash）", "--squash"]] as const) {
    const w = await world();
    process.env.FAKE_REBASE = "0";
    expect(await deliverRequirement(w.facts, w.ui(true, label))).toMatchObject({ status: "delivered", merge: "auto" });
    const head = w.git(w.worktree, "rev-parse", "HEAD");
    expect((await w.calls()).filter((call) => call[2] === "merge")).toEqual([["gh", "pr", "merge", "1", "--auto", flag, "--match-head-commit", head]]);
  }

  const noSquash = await world();
  process.env.FAKE_REBASE = "0"; process.env.FAKE_SQUASH = "0";
  await deliverRequirement(noSquash.facts, noSquash.ui());
  expect(noSquash.windows[0].choices.map((choice) => choice.label)).toEqual(["自己 review", "自动合并（合并提交）"]);

  const noMergeCommit = await world();
  process.env.FAKE_REBASE = "0"; process.env.FAKE_SQUASH = "1"; process.env.FAKE_MERGE_COMMIT = "0";
  await deliverRequirement(noMergeCommit.facts, noMergeCommit.ui());
  expect(noMergeCommit.windows[0].choices.map((choice) => choice.label)).toEqual(["自己 review", "自动合并（squash）"]);
});

test("M8-AC6：查不到仓库允许的合并方式时交付不报错，自动合并项不可选并带上 gh 的报错，结果为自己 review", async () => {
  const w = await world();
  process.env.FAKE_REPO_VIEW_FAILS = "1";
  expect(await deliverRequirement(w.facts, w.ui(true, "自动合并"))).toMatchObject({ status: "delivered", merge: "review" });
  expect(w.prompts).toContain("PR 已就绪，怎么合并？（取消等于自己 review）");
  expect(w.windows[0].choices).toEqual([
    { label: "自己 review", description: "PR 留着等你看，合并由你在网页上操作" },
    { label: "自动合并", disabled: expect.stringMatching(/^查不到仓库允许的合并方式：[\s\S]*HTTP 502: Bad Gateway/) }]);
  expect(w.windows[0].lines.some((line) => line.text.includes("仓库不允许 rebase 合并"))).toBe(false);
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("M8-AC6：GitHub 三种合并方式都不允许时自动合并项不可选，结果为自己 review 且不调用合并命令", async () => {
  const w = await world();
  process.env.FAKE_REBASE = "0"; process.env.FAKE_SQUASH = "0"; process.env.FAKE_MERGE_COMMIT = "0";
  expect(await deliverRequirement(w.facts, w.ui(true, "自动合并"))).toMatchObject({ status: "delivered", merge: "review" });
  expect(w.windows[0].choices).toEqual([
    { label: "自己 review", description: expect.any(String) },
    { label: "自动合并", disabled: "仓库没有允许的合并方式" }]);
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("M8-AC6：重跑复用已有 PR 不重复创建；创建结果不明时先查询再复用；选自己 review 时不触发合并", async () => {
  const w = await world();
  process.env.FAKE_CREATE_FAILS = "1";
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: false, merge: "review" });
  delete process.env.FAKE_CREATE_FAILS;
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: true, merge: "review" });
  const calls = await w.calls();
  expect(calls.filter((call) => call[2] === "create")).toHaveLength(1);
  expect(calls.some((call) => call[2] === "merge")).toBe(false);
});

test("M8-AC6：用户不确认时不推送、不动暂存区；远端分支非快进时拒绝且不强推", async () => {
  const w = await world();
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  expect(await deliverRequirement(w.facts, w.ui(false))).toMatchObject({ status: "cancelled" });
  expect(w.remoteBranch()).toBeNull();
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(head);
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  w.git(w.other, "checkout", "-q", "-b", "req/login"); await writeFile(join(w.other, "x.ts"), "x\n");
  w.git(w.other, "add", "."); w.git(w.other, "commit", "-qm", "别人的提交"); w.git(w.other, "push", "-q", "origin", "req/login");
  const foreign = w.remoteBranch();
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^推送被远端拒绝：.+/), next: expect.any(String) });
  expect(w.remoteBranch()).toBe(foreign);
  expect((await w.calls()).some((call) => call[2] === "create")).toBe(false);
});

test("M8-AC2/AC5：未完成、归档未写入、归档未提交或与凭据不符、工作区有未提交改动、分支带入别的 PRD 归档或嵌套仓库时拒绝交付", async () => {
  const w = await world();
  expect(await deliverRequirement({ ...w.facts, reason: "cancelled" }, w.ui())).toMatchObject({ status: "rejected", reason: "需求没有以完成关闭" });
  expect(await deliverRequirement({ ...w.facts, archive: { ...w.facts.archive!, status: "pending" } }, w.ui())).toMatchObject({ status: "rejected", reason: "需求归档还没写好" });
  await writeFile(join(w.worktree, ARCHIVE), PRD + "被改过\n");
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "commit", "-qam", "改归档");
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  await writeFile(join(w.worktree, ARCHIVE), PRD);
  w.git(w.worktree, "commit", "-qam", "改回归档");
  await writeFile(join(w.worktree, "extra.ts"), "x\n");
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "add", "extra.ts");
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "rm", "-q", "--cached", "extra.ts");
  await rm(join(w.worktree, "extra.ts"));
  const fake = `docs/prd/0197b7b0-6a20-7c51-8a32-b9465fb72d11.伪装.md`;
  await writeFile(join(w.worktree, fake), "伪装的归档\n"); w.git(w.worktree, "add", fake); w.git(w.worktree, "commit", "-qm", "夹带");
  const withFake = { ...w.facts, codeHead: w.git(w.worktree, "rev-parse", "HEAD") };
  expect(await deliverRequirement(withFake, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("M8-AC9：验收后目标分支前进能干净 rebase 时继续并在 PR 中注明未重新验证；有冲突时停止、不推送", async () => {
  const w = await world();
  await writeFile(join(w.other, "b.ts"), "b\n"); w.git(w.other, "add", "."); w.git(w.other, "commit", "-qm", "别的需求"); w.git(w.other, "push", "-q", "origin", "main");
  const result = await deliverRequirement(w.facts, w.ui());
  expect(result).toMatchObject({ status: "delivered", rebasedAfterAcceptance: true });
  expect(w.prompts[0]).toContain("已自动 rebase，这部分未重新验证");
  expect(w.prompts).toContain("PR 已就绪，怎么合并？（取消等于自己 review）");
  expect((await w.calls()).find((call) => call[2] === "create")!.join("\n")).toContain("验收后已自动 rebase，这部分未重新验证。");

  const c = await world();
  const conflictHead = c.git(c.worktree, "rev-parse", "HEAD");
  await writeFile(join(c.other, "login.ts"), "export const login = 2;\n"); c.git(c.other, "add", "."); c.git(c.other, "commit", "-qm", "冲突"); c.git(c.other, "push", "-q", "origin", "main");
  expect(await deliverRequirement(c.facts, c.ui())).toMatchObject({ status: "conflict", target: "refs/remotes/origin/main", reason: expect.stringMatching(/^目标分支在验收后前进，自动 rebase 有冲突：/) });
  expect(c.remoteBranch()).toBeNull();
  expect(c.git(c.worktree, "rev-parse", "HEAD")).toBe(conflictHead);
});

test("C-5：分支上只比最终检查时多了归档提交，不报最终检查后又有代码改动；归档提交之后再有代码提交时仍报", async () => {
  const w = await world();
  expect(w.git(w.worktree, "rev-parse", "HEAD")).not.toBe(w.facts.codeHead);
  expect(await deliverRequirement(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });

  const extra = await world();
  await writeFile(join(extra.worktree, "later.ts"), "export const later = 1;\n");
  extra.git(extra.worktree, "add", "later.ts"); extra.git(extra.worktree, "commit", "-qm", "归档后又改代码");
  expect(await deliverRequirement(extra.facts, extra.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/最终检查后又有代码改动/) });
  expect(extra.remoteBranch()).toBeNull();
});

test("M8-AC6：GitLab 用 glab 建 MR，选项按项目设置的合并方式描述，选自动合并时只调用一次 glab 合并且不带 squash", async () => {
  const lab = await world("gitlab");
  expect(await deliverRequirement(lab.facts, lab.ui(true, "自动合并"))).toMatchObject({ status: "delivered", provider: "glab", merge: "auto" });
  const head = lab.git(lab.worktree, "rev-parse", "HEAD");
  expect(lab.windows[0].lines.find((line) => line.text.startsWith("MR：") && line.text.includes("https://example.test/1"))?.tone).toBe("muted");
  expect(lab.windows[0].choices).toEqual([
    { label: "自己 review", description: "MR 留着等你看，合并由你在网页上操作" },
    { label: "自动合并", description: "等仓库要求的检查通过后，按项目设置的合并方式合并" }]);
  expect((await lab.calls()).filter((call) => call[2] === "merge")).toEqual([["glab", "mr", "merge", "1", "--auto-merge", "--sha", head, "--yes"]]);
});

const PROTOTYPE_HTMLS = [["设置页", "<html>设置页 v3</html>\n"], ["命令行输出", "<html>命令行输出 v1</html>\n"]] as const;
const prototypePath = (name: string) => `docs/prd/${REQUIREMENT}.${name}.html`;
const worldWithPrototypes = (items: ReadonlyArray<readonly [string, string]> = PROTOTYPE_HTMLS) => world("github", items);

test("正文与原型 html 已一起提交时，确认窗口写归档已在分支中，交付不新增归档提交，工作区保持干净", async () => {
  const w = await worldWithPrototypes();
  const before = w.git(w.worktree, "rev-parse", "HEAD");
  expect(await deliverRequirement(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered", merge: "review" });
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(before);
  expect(w.archiveCommits()).toBe(1);
  const committed = w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  expect(committed).toEqual([ARCHIVE, prototypePath("命令行输出"), prototypePath("设置页")].sort());
  expect(w.git(w.worktree, "status", "--porcelain")).toBe("");
  expect(w.prompts[0]).toContain("归档已在分支中");
  expect(w.prompts[0]).not.toContain("将提交归档");
});

test("分支里带了别的需求的原型 html 时拒绝交付", async () => {
  const w = await worldWithPrototypes();
  const foreign = "docs/prd/0197b7b0-6a20-7c51-8a32-b9465fb72d11.别人的原型.html";
  await writeFile(join(w.worktree, foreign), "<html>别人的</html>\n"); w.git(w.worktree, "add", foreign); w.git(w.worktree, "commit", "-qm", "夹带");
  const facts = { ...w.facts, codeHead: w.git(w.worktree, "rev-parse", "HEAD") };
  expect(await deliverRequirement(facts, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("工作区里有 docs/prd 下的未提交杂物文件时拒绝交付", async () => {
  const w = await worldWithPrototypes();
  await writeFile(join(w.worktree, "docs/prd/别的文件.html"), "<html>杂物</html>\n");
  expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的原型 html 与关闭时登记的指纹不一致时拒绝交付，暂存区为空", async () => {
  const w = await worldWithPrototypes();
  await writeFile(join(w.worktree, prototypePath("设置页")), "<html>被手动改过</html>\n");
  w.git(w.worktree, "commit", "-qam", "改原型");
  const result = await deliverRequirement(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(result.status === "rejected" && result.reason).toContain(prototypePath("设置页"));
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的正文内容与登记指纹不一致被拒绝时，原因写出正文文件的相对路径", async () => {
  const w = await world();
  await writeFile(join(w.worktree, ARCHIVE), PRD + "被改过\n");
  w.git(w.worktree, "commit", "-qam", "改归档");
  const result = await deliverRequirement(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(result.status === "rejected" && result.reason).toContain(ARCHIVE);
});

test("登记的正文文件已从分支里删掉时，按内容不一致拒绝，不抛出 git 的原始报错，暂存区为空", async () => {
  const w = await world();
  w.git(w.worktree, "rm", "-q", "--", ARCHIVE); w.git(w.worktree, "commit", "-qm", "删归档");
  const result = await deliverRequirement(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  const reason = result.status === "rejected" ? result.reason : "";
  expect(reason).toContain(ARCHIVE);
  expect(reason).not.toMatch(/pathspec|128/);
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  expect(w.remoteBranch()).toBeNull();
});

test("登记的原型 html 已从分支里删掉时，按内容不一致拒绝并写出该原型的相对路径，暂存区为空", async () => {
  const w = await worldWithPrototypes();
  w.git(w.worktree, "rm", "-q", "--", prototypePath("命令行输出")); w.git(w.worktree, "commit", "-qm", "删原型");
  const result = await deliverRequirement(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  const reason = result.status === "rejected" ? result.reason : "";
  expect(reason).toContain(prototypePath("命令行输出"));
  expect(reason).not.toMatch(/pathspec|128/);
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  expect(w.remoteBranch()).toBeNull();
});

test("没有原型的需求交付时，归档提交里只有正文，交付不新增提交", async () => {
  const w = await world();
  const before = w.git(w.worktree, "rev-parse", "HEAD");
  expect(await deliverRequirement(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(before);
  expect(w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).toBe(ARCHIVE);
  expect(w.git(w.worktree, "log", "-1", "--format=%s")).toBe(`docs(prd): 归档需求 ${w.facts.requirementId}`);
  expect(w.prompts[0]).toContain("归档已在分支中");
  expect(w.prompts[0]).not.toContain("原型");
});

test("原型名称含方括号且另有近似名称的原型时，按字面路径核对指纹，交付通过", async () => {
  const w = await worldWithPrototypes([["a[1]", "<html>方括号</html>\n"], ["a1", "<html>近似名</html>\n"]]);
  expect(await deliverRequirement(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });
  const committed = w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  expect(committed).toEqual([ARCHIVE, prototypePath("a[1]"), prototypePath("a1")].sort());
});

test("本需求编号开头、但不在登记清单里的 html 被提交到分支上时拒绝交付", async () => {
  const w = await worldWithPrototypes();
  const stray = prototypePath("没登记的原型");
  await writeFile(join(w.worktree, stray), "<html>没登记</html>\n"); w.git(w.worktree, "add", stray); w.git(w.worktree, "commit", "-qm", "夹带");
  const facts = { ...w.facts, codeHead: w.git(w.worktree, "rev-parse", "HEAD") };
  expect(await deliverRequirement(facts, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的登记文件之后在工作区被删（未提交）时，按未提交改动拒绝，暂存区为空", async () => {
  for (const victim of [ARCHIVE, prototypePath("命令行输出")]) {
    const w = await worldWithPrototypes();
    await rm(join(w.worktree, victim));
    expect(await deliverRequirement(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
    expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
    expect(w.remoteBranch()).toBeNull();
  }
});
