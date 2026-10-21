import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverRequirement } from "../src/modules/delivery/git-delivery.ts";
import type { DeliveryFacts, DeliveryUi } from "../src/modules/delivery/git-delivery.ts";

type MergeMethodKey = "squash" | "merge" | "rebase";
const ALL_METHODS: MergeMethodKey[] = ["squash", "merge", "rebase"];
const deliver = (facts: DeliveryFacts, ui: DeliveryUi, mergeMethods: MergeMethodKey[] = ALL_METHODS) => deliverRequirement(facts, ui, { mode: "remote", mergeMethods });

const cleanups: string[] = [];
const originalPath = process.env.PATH;
const ENV_KEYS = ["PATH", "HOME", "GLAB_CONFIG_DIR", "GITLAB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "FAKE_STATE", "FAKE_GH_HOSTS", "FAKE_CREATE_FAILS", "FAKE_SQUASH", "FAKE_MERGE_COMMIT",
  "FAKE_REBASE", "FAKE_AUTO_MERGE", "FAKE_REPO_VIEW_FAILS", "FAKE_API_USER_FAILS", "FAKE_SQUASH_OPTION", "FAKE_MERGE_FAILS", "FAKE_REPO_NULLS", "FAKE_PR_STATE", "FAKE_MR_STATE", "FAKE_VIEW_FAILS",
  "FAKE_LIST_FAILS", "FAKE_EDIT_FAILS", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(async () => {
  for (const key of ENV_KEYS) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

const REQUIREMENT = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const ARCHIVE = `docs/prd/${REQUIREMENT}.手机号登录.md`;
const PRD = "# 手机号登录\n不得出现在 PR 里的需求正文\n";
const TITLE = `手机号登录 [${REQUIREMENT}]`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const prBody = (head: string, codeHead: string, rebased = false) =>
  [`需求 ${REQUIREMENT}`, `交付提交 ${head}`, `最终检查代码 ${codeHead}`, ...(rebased ? ["验收后已自动 rebase，这部分未重新验证。"] : []), "", `Requirement: ${REQUIREMENT}`].join("\n");
const flagValue = (call: string[], flag: string) => call[call.indexOf(flag) + 1];
const REJECT_NEXT_LOCAL = "登录后再交付，或在 /one:setting 把 Git 交付改成仅本地";

/**
 * 假的 gh/glab：把每次调用写进日志，PR/MR 列表存在状态文件里；
 * FAKE_GH_HOSTS 列出 gh 已登录的主机；FAKE_CREATE_FAILS=1 时创建成功但以失败退出（结果不明）；
 * FAKE_API_USER_FAILS=1 时 api user 失败；FAKE_SQUASH / FAKE_MERGE_COMMIT / FAKE_REBASE / FAKE_AUTO_MERGE 为 0 时 GitHub 仓库关闭对应能力；
 * FAKE_SQUASH_OPTION 是 GitLab 项目的 squash_option；FAKE_REPO_VIEW_FAILS=1 时读仓库或项目设置失败；FAKE_REPO_NULLS=1 时 GitHub 仓库设置四项都返回 null；
 * FAKE_MERGE_FAILS=1 时合并命令失败；FAKE_CREATE_FAILS=2 时创建失败且不建出 PR；FAKE_LIST_FAILS=1 / FAKE_EDIT_FAILS=1 时查已有 PR/MR、更新描述失败；
 * FAKE_PR_STATE（MERGED 或 OPEN）、FAKE_MR_STATE（merged 或 opened）决定合并后查到的真实状态。
 */
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = process.env.FAKE_STATE, name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify([name, ...args]) + "\\n");
const file = path.join(dir, "requests.json"), list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const flag = (key) => args[args.indexOf(key) + 1];
const fail = (text) => { process.stderr.write(text); process.exit(1); };
if (args[0] === "auth" && args[1] === "token") { if (name === "gh" && (process.env.FAKE_GH_HOSTS || "").split(",").includes(flag("--hostname"))) process.stdout.write("placeholder-token"); else fail("not logged in"); }
else if (args[0] === "api" && args[1] === "user") { if (process.env.FAKE_API_USER_FAILS === "1") fail("HTTP 401: Bad credentials"); process.stdout.write("{}"); }
else if (name === "gh" && args[0] === "api" && args[1] === "graphql") {
  if (process.env.FAKE_REPO_VIEW_FAILS === "1") fail("HTTP 502: Bad Gateway");
  const on = (key) => process.env.FAKE_REPO_NULLS === "1" ? null : process.env[key] !== "0";
  process.stdout.write(JSON.stringify({ data: { repository: { autoMergeAllowed: on("FAKE_AUTO_MERGE"), squashMergeAllowed: on("FAKE_SQUASH"), mergeCommitAllowed: on("FAKE_MERGE_COMMIT"), rebaseMergeAllowed: on("FAKE_REBASE") } } }));
}
else if (args[1] === "list" && process.env.FAKE_LIST_FAILS === "1") fail("list boom");
else if ((args[1] === "edit" || args[1] === "update") && process.env.FAKE_EDIT_FAILS === "1") fail("edit boom");
else if (args[1] === "view" && process.env.FAKE_VIEW_FAILS === "1") { process.stderr.write("view boom"); process.exit(1); }
else if (name === "gh" && args[0] === "pr" && args[1] === "view") process.stdout.write(process.env.FAKE_PR_STATE === "MERGED" ? '{"state":"MERGED","autoMergeRequest":null}' : process.env.FAKE_PR_STATE === "OPEN_PLAIN" ? '{"state":"OPEN","autoMergeRequest":null}' : '{"state":"OPEN","autoMergeRequest":{"enabledAt":"x"}}');
else if (name === "glab" && args[0] === "mr" && args[1] === "view") process.stdout.write(process.env.FAKE_MR_STATE === "merged" ? '{"state":"merged","merge_when_pipeline_succeeds":false}' : '{"state":"opened","merge_when_pipeline_succeeds":true}');
else if (name === "glab" && args[0] === "api" && args[1] === "projects/:fullpath") {
  if (process.env.FAKE_REPO_VIEW_FAILS === "1") fail("HTTP 502: Bad Gateway");
  process.stdout.write(JSON.stringify({ squash_option: process.env.FAKE_SQUASH_OPTION || "default_off" }));
}
else if (name === "gh" && args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify(list.filter((r) => r.branch === flag("--head")).map((r) => ({ number: r.n, url: r.url }))));
else if (name === "glab" && args[0] === "mr" && args[1] === "list") process.stdout.write(JSON.stringify(list.filter((r) => r.branch === flag("--source-branch")).map((r) => ({ iid: r.n, web_url: r.url }))));
else if (args[1] === "create") {
  const branch = flag(name === "gh" ? "--head" : "--source-branch"), n = list.length + 1;
  list.push({ n, branch, url: "https://example.test/" + n }); fs.writeFileSync(file, JSON.stringify(list));
  if (process.env.FAKE_CREATE_FAILS === "2") { list.pop(); fs.writeFileSync(file, JSON.stringify(list)); fail("create boom"); }
  if (process.env.FAKE_CREATE_FAILS === "1") fail("timeout");
} else if (args[1] === "merge" && process.env.FAKE_MERGE_FAILS === "1") fail("merge blocked: required status checks are expected");
`;

interface WorldOptions { host?: string; prototypes?: ReadonlyArray<readonly [string, string]>; login?: "gh" | "glab" | "both" | "glab-no-token" | "none"; origin?: boolean }

async function world(options: WorldOptions = {}) {
  const host = options.host ?? "github.example", prototypes = options.prototypes ?? [];
  const login = options.login ?? (host.startsWith("github") ? "gh" : "glab");
  const base = await realpath(await mkdtemp(join(tmpdir(), "git-delivery-")));
  cleanups.push(base);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const remote = join(base, "team", "app.git"), main = join(base, "main"), other = join(base, "other"), worktree = join(base, "req");
  const identity = (cwd: string) => { git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); };
  const originUrl = `ssh://${host}/team/app.git`;
  await mkdir(remote, { recursive: true });
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(base, "clone", "-q", remote, other); identity(other);
  await writeFile(join(other, "a.ts"), "a\n"); git(other, "add", "."); git(other, "commit", "-qm", "seed"); git(other, "push", "-q", "origin", "main");
  git(base, "clone", "-q", remote, main); identity(main);
  git(main, "remote", "set-url", "origin", originUrl);
  git(main, "worktree", "add", "-q", "-b", "req/login", worktree);
  await writeFile(join(worktree, "login.ts"), "export const login = 1;\n"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "task-1: 登录");
  const codeHead = git(worktree, "rev-parse", "HEAD");
  await mkdir(join(worktree, "docs", "prd"), { recursive: true });
  await writeFile(join(worktree, ARCHIVE), PRD);
  for (const [name, html] of prototypes) await writeFile(join(worktree, `docs/prd/${REQUIREMENT}.${name}.html`), html);
  git(worktree, "add", "-f", "--", "docs/prd");
  git(worktree, "commit", "-q", "-m", `docs(prd): 归档需求 ${REQUIREMENT}`, "-m", `Requirement: ${REQUIREMENT}`);
  if (options.origin === false) git(main, "remote", "remove", "origin");
  const bin = join(base, "bin"), state = join(base, "state"), home = join(base, "home"), glabDir = join(base, "glab");
  await mkdir(bin); await mkdir(state); await mkdir(home); await mkdir(glabDir);
  for (const name of ["gh", "glab"]) { await writeFile(join(bin, name), FAKE_CLI); await chmod(join(bin, name), 0o755); }
  const fakeSsh = join(bin, "fake-ssh");
  await writeFile(fakeSsh, `#!/bin/sh\nfor last; do :; done\nexec sh -c "$(printf '%s' "$last" | sed "s#'/#'${base}/#")"\n`);
  await chmod(fakeSsh, 0o755);
  if (login === "glab" || login === "both") await writeFile(join(glabDir, "config.yml"), `hosts:\n    ${host}:\n        token: placeholder-token\n        api_host: ${host}\n`);
  if (login === "glab-no-token") await writeFile(join(glabDir, "config.yml"), `hosts:\n    ${host}:\n        api_host: ${host}\n`);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.HOME = home;
  process.env.GLAB_CONFIG_DIR = glabDir;
  process.env.FAKE_STATE = state;
  process.env.GIT_SSH_COMMAND = fakeSsh;
  process.env.GIT_SSH_VARIANT = "simple";
  if (login === "gh" || login === "both") process.env.FAKE_GH_HOSTS = host;
  const facts: DeliveryFacts = { requirementId: REQUIREMENT, closed: true, reason: "completed", archive: { path: ARCHIVE, archiveHash: sha256(PRD), status: "archived",
      prototypes: prototypes.map(([name, html], index) => ({ path: `docs/prd/${REQUIREMENT}.${name}.html`, name, version: index + 1, hash: sha256(html) })) },
    worktree, branch: "refs/heads/req/login", codeHead };
  const prompts: string[] = [];
  const windows: Parameters<DeliveryUi["choose"]>[0][] = [];
  const ui = (confirm = true, ...pick: [(string | undefined)?]): DeliveryUi => ({
    confirm: async (window) => { prompts.push(window.lines.map((line) => line.text).join("\n")); return confirm; },
    choose: async (window) => { prompts.push(`${window.title}（${window.cancelNote}）`); windows.push(window); return pick.length ? pick[0] : "自己 review"; },
  });
  const calls = async () => (await readFile(join(state, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const remoteBranch = () => { try { return git(remote, "rev-parse", "refs/heads/req/login"); } catch { return null; } };
  const archiveCommits = () => Number(git(worktree, "rev-list", "--count", "--grep", "^docs(prd): 归档需求", "HEAD"));
  return { git, main, other, worktree, remote, facts, ui, prompts, windows, calls, remoteBranch, archiveCommits };
}

const labels = (window: { choices: Array<{ label: string }> }) => window.choices.map((choice) => choice.label);
const choiceOf = (window: { choices: Array<{ label: string; disabled?: string; recommended?: boolean }> }, label: string) => window.choices.find((choice) => choice.label === label);

test("C-1/C-9：确认后不提交任何文件、推送准确提交号、建 PR（描述无 PRD 正文），gh 登录时调 gh", async () => {
  const w = await world();
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  const result = await deliver(w.facts, w.ui(true, "自己 review"));
  expect(result).toMatchObject({ status: "delivered", provider: "gh", reused: false, rebasedAfterAcceptance: false, url: "https://example.test/1", head, merge: { method: "review", state: "review" } });
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(head);
  expect(w.archiveCommits()).toBe(1);
  expect(w.prompts[0]).toContain("归档已在分支中");
  expect(w.remoteBranch()).toBe(head);
  const calls = await w.calls();
  expect(calls).toContainEqual(["gh", "auth", "token", "--hostname", "github.example"]);
  const create = calls.find((call) => call[2] === "create")!;
  expect(create).toEqual(expect.arrayContaining(["--head", "req/login", "--base", "main", "--title", TITLE]));
  expect(JSON.stringify(calls)).not.toContain("不得出现在 PR 里的需求正文");
  expect(calls.some((call) => call[2] === "merge")).toBe(false);
});

test("C-1a：推送前真连一次平台，gh api user 失败时拒绝、什么都不推送也不建 PR", async () => {
  const w = await world();
  process.env.FAKE_API_USER_FAILS = "1";
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^gh 连不上 github\.example：[\s\S]*HTTP 401: Bad credentials/), next: "检查网络和登录状态（gh auth status 或 glab auth status）后再交付" });
  expect(await w.calls()).toContainEqual(["gh", "api", "user", "--hostname", "github.example"]);
  expect(w.remoteBranch()).toBeNull();
  expect((await w.calls()).some((call) => call[2] === "create")).toBe(false);
});

test("C-1a：glab 登录的主机 glab api user 失败时拒绝，reason 以 glab 连不上开头，什么都不推送", async () => {
  const w = await world({ host: "code.example.com" });
  process.env.FAKE_API_USER_FAILS = "1";
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^glab 连不上 code\.example\.com：/), next: "检查网络和登录状态（gh auth status 或 glab auth status）后再交付" });
  expect(await w.calls()).toContainEqual(["glab", "api", "user", "--hostname", "code.example.com"]);
  expect(w.remoteBranch()).toBeNull();
});

test("C-1：只有 glab 登录、主机名不含 gitlab 时调 glab；gh 和 glab 都登录时先用 gh", async () => {
  const lab = await world({ host: "code.example.com" });
  expect(await deliver(lab.facts, lab.ui())).toMatchObject({ status: "delivered", provider: "glab" });
  const labCalls = await lab.calls();
  expect(labCalls[0]).toEqual(["gh", "auth", "token", "--hostname", "code.example.com"]);
  expect(labCalls.some((call) => call[0] === "gh" && call[1] === "pr")).toBe(false);
  expect(labCalls.some((call) => call[0] === "glab" && call[1] === "mr" && call[2] === "create")).toBe(true);

  const both = await world({ host: "code.example.com", login: "both" });
  expect(await deliver(both.facts, both.ui())).toMatchObject({ status: "delivered", provider: "gh" });
});

test("C-1：都没登录时拒绝并写明主机；glab 配置里该主机没有 token 值也算没登录；什么都不推送", async () => {
  for (const login of ["none", "glab-no-token"] as const) {
    const w = await world({ host: "code.example.com", login });
    expect(await deliver(w.facts, w.ui())).toEqual({ status: "rejected", reason: "本机 gh 和 glab 都没登录 code.example.com", next: REJECT_NEXT_LOCAL });
    expect(w.remoteBranch(), login).toBeNull();
    expect((await w.calls()).some((call) => call[2] === "create"), login).toBe(false);
  }
});

test("C-1：仓库没有 origin 时拒绝，什么都不推送", async () => {
  const w = await world({ origin: false });
  expect(await deliver(w.facts, w.ui())).toEqual({ status: "rejected", reason: "仓库没有名为 origin 的远端", next: "配置 origin 后再交付，或在 /one:setting 把 Git 交付改成仅本地" });
  expect(w.remoteBranch()).toBeNull();
});

test("C-2：新建 PR 的描述逐行是需求、交付提交、最终检查代码、空行、Requirement；复用已有 PR 时用 pr edit 换成这份描述", async () => {
  const w = await world();
  const first = await deliver(w.facts, w.ui());
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  expect(first).toMatchObject({ status: "delivered", reused: false });
  const create = (await w.calls()).find((call) => call[2] === "create")!;
  expect(flagValue(create, "--body")).toBe(prBody(head, w.facts.codeHead));
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: true });
  const calls = await w.calls();
  expect(calls.filter((call) => call[2] === "create")).toHaveLength(1);
  expect(calls.filter((call) => call[1] === "pr" && call[2] === "edit")).toEqual([["gh", "pr", "edit", "1", "--body", prBody(head, w.facts.codeHead)]]);
});

test("C-3/C-4：三种方式都允许并勾选、开了自动合并时，窗口按自己 review、压缩、普通、rebase 列出，压缩合并是推荐项", async () => {
  const w = await world();
  await deliver(w.facts, w.ui());
  const window = w.windows[0];
  expect(window.title).toBe("PR 已就绪，怎么合并？");
  expect(window.cancelNote).toBe("取消等于自己 review");
  expect(window.lines.some((line) => line.text.includes("手机号登录"))).toBe(true);
  expect(window.lines.some((line) => line.text.includes("https://example.test/1"))).toBe(true);
  expect(window.lines.some((line) => line.text.includes("仓库要求的检查通过后合并"))).toBe(true);
  expect(window.choices).toMatchObject([
    { label: "自己 review", description: "PR 留着等你看，合并由你在网页上操作" },
    { label: "压缩合并", description: `所有提交压成一个；标题是“手机号登录 [${REQUIREMENT}] (#1)”，正文末行 Requirement: ${REQUIREMENT}`, recommended: true },
    { label: "普通合并", description: "保留每个提交，另加一个合并提交" },
    { label: "rebase 合并", description: "保留每个提交，接到目标分支后面" }]);
  expect(window.choices.some((choice) => choice.disabled)).toBe(false);
  expect(window.choices.filter((choice) => choice.recommended)).toHaveLength(1);
  const query = (await w.calls()).find((call) => call[1] === "api" && call[2] === "graphql")!;
  expect(query.slice(0, 10).join(" ")).toBe("gh api graphql --hostname github.example -F owner={owner} -F name={repo} -f");
  const text = flagValue(query, "-f");
  expect(text).toContain("query=");
  expect(text).toContain("repository(owner:$owner,name:$name)");
  for (const field of ["autoMergeAllowed", "squashMergeAllowed", "mergeCommitAllowed", "rebaseMergeAllowed"]) expect(text).toContain(field);
});

test("C-3：仓库没开自动合并时，窗口那一行写现在就合并", async () => {
  const w = await world();
  process.env.FAKE_AUTO_MERGE = "0";
  await deliver(w.facts, w.ui());
  expect(w.windows[0].lines.some((line) => line.text.includes("仓库没开自动合并，选了就现在合并"))).toBe(true);
  expect(w.windows[0].lines.some((line) => line.text.includes("仓库要求的检查通过后合并"))).toBe(false);
});

test("C-3：仓库不允许的方式变暗并写原因，其余方式仍可选", async () => {
  const w = await world();
  process.env.FAKE_REBASE = "0"; process.env.FAKE_SQUASH = "0"; process.env.FAKE_MERGE_COMMIT = "0";
  await deliver(w.facts, w.ui());
  const window = w.windows[0];
  expect(choiceOf(window, "压缩合并")?.disabled).toBe("仓库不允许压缩合并");
  expect(choiceOf(window, "普通合并")?.disabled).toBe("仓库不允许普通合并");
  expect(choiceOf(window, "rebase 合并")?.disabled).toBe("仓库不允许 rebase 合并");
  expect(choiceOf(window, "自己 review")?.disabled).toBeUndefined();

  const onlyRebase = await world();
  process.env.FAKE_REBASE = "0";
  await deliver(onlyRebase.facts, onlyRebase.ui());
  expect(choiceOf(onlyRebase.windows[0], "rebase 合并")?.disabled).toBe("仓库不允许 rebase 合并");
  expect(choiceOf(onlyRebase.windows[0], "压缩合并")?.disabled).toBeUndefined();
  expect(choiceOf(onlyRebase.windows[0], "压缩合并")?.recommended).toBe(true);
});

test("C-4：压缩合并被仓库禁用时它不能再是可选的推荐项，光标会落在自己 review", async () => {
  const w = await world();
  process.env.FAKE_SQUASH = "0";
  await deliver(w.facts, w.ui());
  const squash = choiceOf(w.windows[0], "压缩合并")!;
  expect(squash.disabled).toBe("仓库不允许压缩合并");
  expect(w.windows[0].choices.filter((choice) => choice.recommended && !choice.disabled)).toEqual([]);
});

test("C-3：设置里没勾的方式不出现，只勾 merge 时只有自己 review 和普通合并且没有推荐项；顺序固定为压缩、普通、rebase", async () => {
  const onlyMerge = await world();
  await deliver(onlyMerge.facts, onlyMerge.ui(), ["merge"]);
  expect(labels(onlyMerge.windows[0])).toEqual(["自己 review", "普通合并"]);
  expect(onlyMerge.windows[0].choices.some((choice) => choice.recommended)).toBe(false);

  const reordered = await world();
  await deliver(reordered.facts, reordered.ui(), ["rebase", "squash"]);
  expect(labels(reordered.windows[0])).toEqual(["自己 review", "压缩合并", "rebase 合并"]);
});

test("C-3：查不到仓库设置时，勾选的方式全变暗并带 gh 的报错，交付不报错且结果为自己 review", async () => {
  const w = await world();
  process.env.FAKE_REPO_VIEW_FAILS = "1";
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  const window = w.windows[0];
  expect(labels(window)).toEqual(["自己 review", "压缩合并", "普通合并", "rebase 合并"]);
  for (const label of ["压缩合并", "普通合并", "rebase 合并"]) expect(choiceOf(window, label)?.disabled, label).toMatch(/^查不到仓库允许的合并方式：[\s\S]*HTTP 502: Bad Gateway/);
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("C-3：仓库设置里某个值是 null 而不是布尔时，三种方式全变暗，原因写查不到仓库允许的合并方式", async () => {
  const w = await world();
  process.env.FAKE_REPO_NULLS = "1";
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  for (const label of ["压缩合并", "普通合并", "rebase 合并"]) expect(choiceOf(w.windows[0], label)?.disabled, label).toMatch(/^查不到仓库允许的合并方式：/);
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("C-4：按 Esc 或选自己 review 都不触发合并，结果为自己 review", async () => {
  const w = await world();
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  expect(await deliver(w.facts, w.ui(true, "自己 review"))).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("C-5：选压缩合并时带 --squash、--match-head-commit、--auto、--subject 和描述作 --body，合并后查到 PR 仍打开且开着自动合并，结果为已排队", async () => {
  const w = await world();
  process.env.FAKE_PR_STATE = "OPEN";
  const result = await deliver(w.facts, w.ui(true, "压缩合并"));
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  expect(result).toMatchObject({ status: "delivered", merge: { method: "squash", state: "queued" } });
  const merges = (await w.calls()).filter((call) => call[2] === "merge");
  expect(merges).toHaveLength(1);
  const merge = merges[0];
  expect(merge.slice(0, 4)).toEqual(["gh", "pr", "merge", "1"]);
  expect(merge).toEqual(expect.arrayContaining(["--squash", "--auto"]));
  expect(flagValue(merge, "--match-head-commit")).toBe(head);
  expect(flagValue(merge, "--subject")).toBe(`${TITLE} (#1)`);
  expect(flagValue(merge, "--body")).toBe(prBody(head, w.facts.codeHead));
  expect((await w.calls()).filter((call) => call[2] === "view")).toEqual([["gh", "pr", "view", "1", "--json", "state,autoMergeRequest"]]);
});

test("C-5：仓库开了自动合并但 PR 已直接合并时，结果为已合并而不是已排队", async () => {
  const w = await world();
  process.env.FAKE_PR_STATE = "MERGED";
  expect(await deliver(w.facts, w.ui(true, "压缩合并"))).toMatchObject({ status: "delivered", merge: { method: "squash", state: "merged" } });
  expect((await w.calls()).find((call) => call[2] === "merge")).toContain("--auto");
});

test("C-5：仓库没开自动合并时合并命令不带 --auto，结果为已合并", async () => {
  const w = await world();
  process.env.FAKE_AUTO_MERGE = "0"; process.env.FAKE_PR_STATE = "MERGED";
  expect(await deliver(w.facts, w.ui(true, "压缩合并"))).toMatchObject({ status: "delivered", merge: { method: "squash", state: "merged" } });
  const merge = (await w.calls()).find((call) => call[2] === "merge")!;
  expect(merge).toContain("--squash");
  expect(merge).not.toContain("--auto");
});

test("C-5：选普通合并带 --merge、--subject、--body；选 rebase 合并带 --rebase 且没有 --subject 和 --body", async () => {
  const normal = await world();
  process.env.FAKE_PR_STATE = "OPEN";
  expect(await deliver(normal.facts, normal.ui(true, "普通合并"))).toMatchObject({ merge: { method: "merge", state: "queued" } });
  const mergeCall = (await normal.calls()).find((call) => call[2] === "merge")!;
  const head = normal.git(normal.worktree, "rev-parse", "HEAD");
  expect(mergeCall).toContain("--merge");
  expect(flagValue(mergeCall, "--match-head-commit")).toBe(head);
  expect(flagValue(mergeCall, "--subject")).toBe(`${TITLE} (#1)`);
  expect(flagValue(mergeCall, "--body")).toBe(prBody(head, normal.facts.codeHead));

  const rebase = await world();
  expect(await deliver(rebase.facts, rebase.ui(true, "rebase 合并"))).toMatchObject({ merge: { method: "rebase", state: "queued" } });
  const rebaseCall = (await rebase.calls()).find((call) => call[2] === "merge")!;
  expect(rebaseCall).toContain("--rebase");
  expect(flagValue(rebaseCall, "--match-head-commit")).toBe(rebase.git(rebase.worktree, "rev-parse", "HEAD"));
  expect(rebaseCall).not.toContain("--subject");
  expect(rebaseCall).not.toContain("--body");
});

test("C-8：GitHub 合并命令失败时交付仍成功，merge 为失败并带平台报错和建议，不抛错", async () => {
  const w = await world();
  process.env.FAKE_MERGE_FAILS = "1";
  const result = await deliver(w.facts, w.ui(true, "压缩合并"));
  expect(result).toMatchObject({ status: "delivered", provider: "gh", url: "https://example.test/1",
    merge: { method: "squash", state: "failed", reason: expect.stringContaining("merge blocked: required status checks are expected"), next: "处理后在网页上合并，或修好后重新交付" } });
});

test("M8-AC6：重跑复用已有 PR 不重复创建；创建结果不明时先查询再复用；选自己 review 时不触发合并", async () => {
  const w = await world();
  process.env.FAKE_CREATE_FAILS = "1";
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: false, merge: { method: "review", state: "review" } });
  delete process.env.FAKE_CREATE_FAILS;
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: true, merge: { method: "review", state: "review" } });
  const calls = await w.calls();
  expect(calls.filter((call) => call[2] === "create")).toHaveLength(1);
  expect(calls.some((call) => call[2] === "merge")).toBe(false);
});

test.each([
  ["gh", "github.example"],
  ["glab", "code.example.com"],
])("推送成功后查已有 PR/MR 失败时（%s），不抛错，返回 rejected，原因说分支已推送并带平台报错", async (provider, host) => {
  const w = await world({ host });
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  process.env.FAKE_LIST_FAILS = "1";
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^分支已推送到 origin，但[\s\S]*list boom/), next: `处理后重新交付即可，会复用已有的 ${provider === "gh" ? "PR" : "MR"}` });
  expect(w.remoteBranch()).toBe(head);
});

test.each([
  ["gh", "github.example"],
  ["glab", "code.example.com"],
])("推送成功后建 PR/MR 失败且没建出来时（%s），不抛错，返回 rejected，原因说分支已推送并带平台报错", async (provider, host) => {
  const w = await world({ host });
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  process.env.FAKE_CREATE_FAILS = "2";
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^分支已推送到 origin，但[\s\S]*create boom/), next: `处理后重新交付即可，会复用已有的 ${provider === "gh" ? "PR" : "MR"}` });
  expect(w.remoteBranch()).toBe(head);
});

test.each([
  ["gh", "github.example"],
  ["glab", "code.example.com"],
])("推送成功后更新已有 PR/MR 描述失败时（%s），不抛错，返回 rejected，原因说分支已推送并带平台报错", async (provider, host) => {
  const w = await world({ host });
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered" });
  process.env.FAKE_EDIT_FAILS = "1";
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^分支已推送到 origin，但[\s\S]*edit boom/), next: `处理后重新交付即可，会复用已有的 ${provider === "gh" ? "PR" : "MR"}` });
});

test("合并命令成功但查状态失败时，按排队处理并写明状态没查到", async () => {
  const w = await world({ host: "github.example" });
  process.env.FAKE_VIEW_FAILS = "1";
  const result = await deliver(w.facts, w.ui(true, "压缩合并"));
  expect(result).toMatchObject({ status: "delivered", merge: { method: "squash", state: "queued", reason: expect.stringMatching(/^合并命令已发出，状态没查到：[\s\S]*view boom/) } });
});

test("合并命令成功、查到 PR 仍开着且没有自动合并请求时，按排队处理并如实写出查到的状态", async () => {
  const w = await world({ host: "github.example" });
  process.env.FAKE_PR_STATE = "OPEN_PLAIN";
  const result = await deliver(w.facts, w.ui(true, "压缩合并"));
  expect(result).toMatchObject({ status: "delivered", merge: { method: "squash", state: "queued", reason: "合并命令已发出，PR 状态是 OPEN，也没有自动合并请求" } });
});

test("M8-AC6：用户不确认时不推送、不动暂存区；远端分支非快进时拒绝且不强推", async () => {
  const w = await world();
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  expect(await deliver(w.facts, w.ui(false))).toMatchObject({ status: "cancelled" });
  expect(w.remoteBranch()).toBeNull();
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(head);
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  w.git(w.other, "checkout", "-q", "-b", "req/login"); await writeFile(join(w.other, "x.ts"), "x\n");
  w.git(w.other, "add", "."); w.git(w.other, "commit", "-qm", "别人的提交"); w.git(w.other, "push", "-q", "origin", "req/login");
  const foreign = w.remoteBranch();
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^推送被远端拒绝：.+/), next: expect.any(String) });
  expect(w.remoteBranch()).toBe(foreign);
  expect((await w.calls()).some((call) => call[2] === "create")).toBe(false);
});

test("M8-AC2/AC5：未完成、归档未写入、归档未提交或与凭据不符、工作区有未提交改动、分支带入别的 PRD 归档或嵌套仓库时拒绝交付", async () => {
  const w = await world();
  expect(await deliver({ ...w.facts, reason: "cancelled" }, w.ui())).toMatchObject({ status: "rejected", reason: "需求没有以完成关闭" });
  expect(await deliver({ ...w.facts, archive: { ...w.facts.archive!, status: "pending" } }, w.ui())).toMatchObject({ status: "rejected", reason: "需求归档还没写好" });
  await writeFile(join(w.worktree, ARCHIVE), PRD + "被改过\n");
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "commit", "-qam", "改归档");
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  await writeFile(join(w.worktree, ARCHIVE), PRD);
  w.git(w.worktree, "commit", "-qam", "改回归档");
  await writeFile(join(w.worktree, "extra.ts"), "x\n");
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "add", "extra.ts");
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  w.git(w.worktree, "rm", "-q", "--cached", "extra.ts");
  await rm(join(w.worktree, "extra.ts"));
  const fake = `docs/prd/0197b7b0-6a20-7c51-8a32-b9465fb72d11.伪装.md`;
  await writeFile(join(w.worktree, fake), "伪装的归档\n"); w.git(w.worktree, "add", fake); w.git(w.worktree, "commit", "-qm", "夹带");
  const withFake = { ...w.facts, codeHead: w.git(w.worktree, "rev-parse", "HEAD") };
  expect(await deliver(withFake, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("M8-AC9：验收后目标分支前进能干净 rebase 时继续并在 PR 中注明未重新验证；有冲突时停止、不推送", async () => {
  const w = await world();
  await writeFile(join(w.other, "b.ts"), "b\n"); w.git(w.other, "add", "."); w.git(w.other, "commit", "-qm", "别的需求"); w.git(w.other, "push", "-q", "origin", "main");
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "delivered", rebasedAfterAcceptance: true });
  expect(w.prompts[0]).toContain("已自动 rebase，这部分未重新验证");
  expect(w.prompts).toContain("PR 已就绪，怎么合并？（取消等于自己 review）");
  const rebasedHead = w.git(w.worktree, "rev-parse", "HEAD");
  expect(flagValue((await w.calls()).find((call) => call[2] === "create")!, "--body")).toBe(prBody(rebasedHead, w.facts.codeHead, true));

  const c = await world();
  const conflictHead = c.git(c.worktree, "rev-parse", "HEAD");
  await writeFile(join(c.other, "login.ts"), "export const login = 2;\n"); c.git(c.other, "add", "."); c.git(c.other, "commit", "-qm", "冲突"); c.git(c.other, "push", "-q", "origin", "main");
  expect(await deliver(c.facts, c.ui())).toMatchObject({ status: "conflict", target: "refs/remotes/origin/main", reason: expect.stringMatching(/^目标分支在验收后前进，自动 rebase 有冲突：/) });
  expect(c.remoteBranch()).toBeNull();
  expect(c.git(c.worktree, "rev-parse", "HEAD")).toBe(conflictHead);
});

test("C-5：分支上只比最终检查时多了归档提交，不报最终检查后又有代码改动；归档提交之后再有代码提交时仍报", async () => {
  const w = await world();
  expect(w.git(w.worktree, "rev-parse", "HEAD")).not.toBe(w.facts.codeHead);
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });

  const extra = await world();
  await writeFile(join(extra.worktree, "later.ts"), "export const later = 1;\n");
  extra.git(extra.worktree, "add", "later.ts"); extra.git(extra.worktree, "commit", "-qm", "归档后又改代码");
  expect(await deliver(extra.facts, extra.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/最终检查后又有代码改动/) });
  expect(extra.remoteBranch()).toBeNull();
});

const gitlabWorld = () => world({ host: "gitlab.example" });
const SQUASH_DESCRIPTION = `所有提交压成一个；说明是“手机号登录 [${REQUIREMENT}]”、空一行、MR 描述（末行 Requirement: ${REQUIREMENT}）`;
const PROJECT_SETTING_DESCRIPTION = "按项目设置的合并方式合并：普通合并、半线性或快进";

test("C-6：GitLab 用 glab 建 MR，窗口是自己 review、压缩合并（推荐）、不压缩（按项目设置）", async () => {
  const w = await gitlabWorld();
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", provider: "glab", url: "https://example.test/1", merge: { method: "review", state: "review" } });
  const window = w.windows[0];
  expect(window.title).toBe("MR 已就绪，怎么合并？");
  expect(window.lines.some((line) => line.text.includes("手机号登录"))).toBe(true);
  expect(window.lines.some((line) => line.text.includes("https://example.test/1"))).toBe(true);
  expect(window.lines.some((line) => line.text.includes("有流水线时等流水线通过后合并"))).toBe(true);
  expect(window.choices).toMatchObject([
    { label: "自己 review", description: "MR 留着等你看，合并由你在网页上操作" },
    { label: "压缩合并", description: SQUASH_DESCRIPTION, recommended: true },
    { label: "不压缩（按项目设置）", description: PROJECT_SETTING_DESCRIPTION }]);
  expect(window.choices.some((choice) => choice.disabled)).toBe(false);
  const calls = await w.calls();
  expect(calls).toContainEqual(["glab", "api", "user", "--hostname", "gitlab.example"]);
  const project = calls.find((call) => call[0] === "glab" && call[1] === "api" && call[2] === "projects/:fullpath")!;
  expect(project).toBeDefined();
  expect(project).toContain("--hostname");
  expect(flagValue(project, "--hostname")).toBe("gitlab.example");
});

test("C-2：GitLab 复用已有 MR 时用 mr update --description 换成这份描述", async () => {
  const w = await gitlabWorld();
  await deliver(w.facts, w.ui());
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  const create = (await w.calls()).find((call) => call[2] === "create")!;
  expect(flagValue(create, "--description")).toBe(prBody(head, w.facts.codeHead));
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "delivered", reused: true });
  expect((await w.calls()).filter((call) => call[1] === "mr" && call[2] === "update")).toEqual([["glab", "mr", "update", "1", "--description", prBody(head, w.facts.codeHead)]]);
});

test("C-6：项目 squash_option 决定变暗项：never 禁压缩，always 禁不压缩，default_on 禁不压缩，default_off 都可选", async () => {
  const expected = {
    never: { squash: "项目不允许压缩", project: undefined },
    always: { squash: undefined, project: "项目要求压缩" },
    default_on: { squash: undefined, project: "项目默认压缩" },
    default_off: { squash: undefined, project: undefined },
  } as const;
  for (const [option, want] of Object.entries(expected)) {
    const w = await gitlabWorld();
    process.env.FAKE_SQUASH_OPTION = option;
    await deliver(w.facts, w.ui());
    expect(choiceOf(w.windows[0], "压缩合并")?.disabled, option).toBe(want.squash);
    if (option === "never") expect(choiceOf(w.windows[0], "压缩合并")?.recommended, option).toBeFalsy();
    expect(choiceOf(w.windows[0], "不压缩（按项目设置）")?.disabled, option).toBe(want.project);
  }
});

test("C-6：读不到项目压缩设置时两项变暗并带报错；设置里没勾的方式对应项不出现", async () => {
  const broken = await gitlabWorld();
  process.env.FAKE_REPO_VIEW_FAILS = "1";
  expect(await deliver(broken.facts, broken.ui())).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  for (const label of ["压缩合并", "不压缩（按项目设置）"]) expect(choiceOf(broken.windows[0], label)?.disabled, label).toMatch(/^查不到项目的压缩设置：[\s\S]*HTTP 502: Bad Gateway/);

  const onlySquash = await gitlabWorld();
  await deliver(onlySquash.facts, onlySquash.ui(), ["squash"]);
  expect(labels(onlySquash.windows[0])).toEqual(["自己 review", "压缩合并"]);

  const onlyMerge = await gitlabWorld();
  await deliver(onlyMerge.facts, onlyMerge.ui(), ["merge"]);
  expect(labels(onlyMerge.windows[0])).toEqual(["自己 review", "不压缩（按项目设置）"]);
  expect(onlyMerge.windows[0].choices.some((choice) => choice.recommended)).toBe(false);

  const onlyRebase = await gitlabWorld();
  await deliver(onlyRebase.facts, onlyRebase.ui(), ["rebase"]);
  expect(labels(onlyRebase.windows[0])).toEqual(["自己 review", "不压缩（按项目设置）"]);
});

test("C-6：压缩合并被项目禁用时没有可选的推荐项；Esc 等于自己 review", async () => {
  const w = await gitlabWorld();
  process.env.FAKE_SQUASH_OPTION = "never";
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
  expect(w.windows[0].choices.filter((choice) => choice.recommended)).toEqual([]);
  expect((await w.calls()).some((call) => call[2] === "merge")).toBe(false);
});

test("C-7：GitLab 选压缩合并时带 --sha、--yes、--squash 和 --squash-message（第一行是标题 [编号]，空一行后是 MR 描述），MR 已合并时结果为已合并", async () => {
  const w = await gitlabWorld();
  process.env.FAKE_MR_STATE = "merged";
  const result = await deliver(w.facts, w.ui(true, "压缩合并"));
  const head = w.git(w.worktree, "rev-parse", "HEAD");
  expect(result).toMatchObject({ status: "delivered", merge: { method: "squash", state: "merged" } });
  const merges = (await w.calls()).filter((call) => call[2] === "merge");
  expect(merges).toHaveLength(1);
  const merge = merges[0];
  expect(merge.slice(0, 4)).toEqual(["glab", "mr", "merge", "1"]);
  expect(flagValue(merge, "--sha")).toBe(head);
  expect(merge).toEqual(expect.arrayContaining(["--yes", "--squash"]));
  const message = flagValue(merge, "--squash-message");
  expect(message.split("\n")[0]).toBe(TITLE);
  expect(message).toBe(`${TITLE}\n\n${prBody(head, w.facts.codeHead)}`);
  expect((await w.calls()).filter((call) => call[2] === "view")).toEqual([["glab", "mr", "view", "1", "-F", "json"]]);
});

test("C-7：GitLab 项目有流水线、MR 还在等流水线通过时，结果为已排队", async () => {
  const w = await gitlabWorld();
  process.env.FAKE_MR_STATE = "opened";
  expect(await deliver(w.facts, w.ui(true, "压缩合并"))).toMatchObject({ status: "delivered", merge: { method: "squash", state: "queued" } });
});

test("C-7：GitLab 选不压缩（按项目设置）时带 --sha 和 --yes，不带 --squash 和 --squash-message", async () => {
  const w = await gitlabWorld();
  process.env.FAKE_MR_STATE = "merged";
  const result = await deliver(w.facts, w.ui(true, "不压缩（按项目设置）"));
  expect(result).toMatchObject({ status: "delivered", merge: { method: "project", state: "merged" } });
  const merge = (await w.calls()).find((call) => call[2] === "merge")!;
  expect(merge.slice(0, 4)).toEqual(["glab", "mr", "merge", "1"]);
  expect(flagValue(merge, "--sha")).toBe(w.git(w.worktree, "rev-parse", "HEAD"));
  expect(merge).toContain("--yes");
  expect(merge).not.toContain("--squash");
  expect(merge).not.toContain("--squash-message");
});

test("C-8：GitLab 合并命令失败时交付仍成功，merge 为失败并带平台报错和建议，不抛错", async () => {
  const w = await gitlabWorld();
  process.env.FAKE_MERGE_FAILS = "1";
  expect(await deliver(w.facts, w.ui(true, "不压缩（按项目设置）"))).toMatchObject({ status: "delivered", provider: "glab",
    merge: { method: "project", state: "failed", reason: expect.stringContaining("merge blocked: required status checks are expected"), next: "处理后在网页上合并，或修好后重新交付" } });
});

const PROTOTYPE_HTMLS = [["设置页", "<html>设置页 v3</html>\n"], ["命令行输出", "<html>命令行输出 v1</html>\n"]] as const;
const prototypePath = (name: string) => `docs/prd/${REQUIREMENT}.${name}.html`;
const worldWithPrototypes = (items: ReadonlyArray<readonly [string, string]> = PROTOTYPE_HTMLS) => world({ prototypes: items });

test("正文与原型 html 已一起提交时，确认窗口写归档已在分支中，交付不新增归档提交，工作区保持干净", async () => {
  const w = await worldWithPrototypes();
  const before = w.git(w.worktree, "rev-parse", "HEAD");
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered", merge: { method: "review", state: "review" } });
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
  expect(await deliver(facts, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("工作区里有 docs/prd 下的未提交杂物文件时拒绝交付", async () => {
  const w = await worldWithPrototypes();
  await writeFile(join(w.worktree, "docs/prd/别的文件.html"), "<html>杂物</html>\n");
  expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的原型 html 与关闭时登记的指纹不一致时拒绝交付，暂存区为空", async () => {
  const w = await worldWithPrototypes();
  await writeFile(join(w.worktree, prototypePath("设置页")), "<html>被手动改过</html>\n");
  w.git(w.worktree, "commit", "-qam", "改原型");
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(result.status === "rejected" && result.reason).toContain(prototypePath("设置页"));
  expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的正文内容与登记指纹不一致被拒绝时，原因写出正文文件的相对路径", async () => {
  const w = await world();
  await writeFile(join(w.worktree, ARCHIVE), PRD + "被改过\n");
  w.git(w.worktree, "commit", "-qam", "改归档");
  const result = await deliver(w.facts, w.ui());
  expect(result).toMatchObject({ status: "rejected", reason: expect.stringMatching(/^归档文件与关闭时登记的内容不一致/) });
  expect(result.status === "rejected" && result.reason).toContain(ARCHIVE);
});

test("登记的正文文件已从分支里删掉时，按内容不一致拒绝，不抛出 git 的原始报错，暂存区为空", async () => {
  const w = await world();
  w.git(w.worktree, "rm", "-q", "--", ARCHIVE); w.git(w.worktree, "commit", "-qm", "删归档");
  const result = await deliver(w.facts, w.ui());
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
  const result = await deliver(w.facts, w.ui());
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
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });
  expect(w.git(w.worktree, "rev-parse", "HEAD")).toBe(before);
  expect(w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).toBe(ARCHIVE);
  expect(w.git(w.worktree, "log", "-1", "--format=%s")).toBe(`docs(prd): 归档需求 ${w.facts.requirementId}`);
  expect(w.prompts[0]).toContain("归档已在分支中");
  expect(w.prompts[0]).not.toContain("原型");
});

test("原型名称含方括号且另有近似名称的原型时，按字面路径核对指纹，交付通过", async () => {
  const w = await worldWithPrototypes([["a[1]", "<html>方括号</html>\n"], ["a1", "<html>近似名</html>\n"]]);
  expect(await deliver(w.facts, w.ui(true, undefined))).toMatchObject({ status: "delivered" });
  const committed = w.git(w.worktree, "-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  expect(committed).toEqual([ARCHIVE, prototypePath("a[1]"), prototypePath("a1")].sort());
});

test("本需求编号开头、但不在登记清单里的 html 被提交到分支上时拒绝交付", async () => {
  const w = await worldWithPrototypes();
  const stray = prototypePath("没登记的原型");
  await writeFile(join(w.worktree, stray), "<html>没登记</html>\n"); w.git(w.worktree, "add", stray); w.git(w.worktree, "commit", "-qm", "夹带");
  const facts = { ...w.facts, codeHead: w.git(w.worktree, "rev-parse", "HEAD") };
  expect(await deliver(facts, w.ui())).toMatchObject({ status: "rejected", reason: "分支里带了别的需求的归档文件" });
  expect(w.remoteBranch()).toBeNull();
});

test("已提交的登记文件之后在工作区被删（未提交）时，按未提交改动拒绝，暂存区为空", async () => {
  for (const victim of [ARCHIVE, prototypePath("命令行输出")]) {
    const w = await worldWithPrototypes();
    await rm(join(w.worktree, victim));
    expect(await deliver(w.facts, w.ui())).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未提交改动/) });
    expect(w.git(w.worktree, "diff", "--cached", "--name-only")).toBe("");
    expect(w.remoteBranch()).toBeNull();
  }
});
