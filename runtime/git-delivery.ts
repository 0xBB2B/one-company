import { createHash } from "node:crypto";
import { mutedLines } from "./question-window.ts";
import type { ProgramWindow, WindowChoice } from "./question-window.ts";
import { commandOutputTail } from "./tool-failure.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { globalDatabase, withDatabase } from "./database.ts";
import { isProdArchivePath } from "./content-policy.ts";
import { fetchRemoteTarget, gitIn, includesCommit } from "./target-branch.ts";

const exec = promisify(execFile);
const SETTINGS = "settings";
const SETTING_KEY = "git-delivery";

export function gitDeliveryEnabled(dataRoot: string): boolean {
  return withDatabase(globalDatabase(dataRoot), (db) => db.read<{ enabled?: boolean }>(SETTINGS, SETTING_KEY)?.data.enabled === true);
}
export function setGitDeliveryEnabled(dataRoot: string, enabled: boolean): void {
  withDatabase(globalDatabase(dataRoot), (db) => db.transaction(() => {
    const row = db.read<{ enabled: boolean }>(SETTINGS, SETTING_KEY);
    if (row) db.update(SETTINGS, SETTING_KEY, row.version, { enabled });
    else db.create(SETTINGS, SETTING_KEY, { enabled });
  }));
}

/** 交付所需的无正文事实：来自可信关闭记录。 */
export interface DeliveryFacts {
  requirementId: string;
  closed: boolean;
  reason: string;
  archive: { path: string; archiveHash: string | null; status: string } | null;
  worktree: string;
  branch: string;
  /** 最终检查轮核对过的代码提交。 */
  codeHead: string;
}
export interface DeliveryUi {
  confirm(window: ProgramWindow): Promise<boolean>;
  choose(window: ProgramWindow & { choices: WindowChoice[]; cancelNote?: string }): Promise<string | undefined>;
}
export type DeliveryResult =
  | { status: "rejected"; reason: string; next: string }
  | { status: "conflict"; target: string; reason: string; next: string }
  | { status: "cancelled"; head: string }
  | { status: "delivered"; head: string; provider: "gh" | "glab"; url: string; reused: boolean; rebasedAfterAcceptance: boolean; merge: "review" | "auto" };

const REJECT_ADVICE = {
  requirement_not_completed: { why: "需求没有以完成关闭", next: "只有用户验收通过并以完成关闭的需求才能交付" },
  archive_not_written: { why: "需求归档还没写好", next: "用 workflow_manage 的 status 查看归档状态，归档完成后再交付" },
  branch_changed: { why: "需求工作区当前不在需求分支上", next: "请用户把需求工作区切回需求分支后再交付" },
  worktree_dirty: { why: "需求工作区里有归档以外的未提交改动", next: "请用户处理这些改动后再交付" },
  no_remote: { why: "仓库没有名为 origin 的远端", next: "请用户配置 origin 远端后再交付" },
  unknown_host: { why: "origin 远端不是 GitHub 或 GitLab，无法开 PR 或 MR", next: "请用户确认远端地址；其他平台需要手动交付" },
  head_changed: { why: "需求分支在最终检查后又有代码改动", next: "重新做交付核对和验收后再交付" },
  foreign_prod_archive: { why: "分支里带了别的需求的归档文件", next: "请用户移除这些文件后再交付" },
  nested_repository: { why: "分支里有嵌套仓库（子模块）改动", next: "请用户处理子模块改动后再交付" },
  archive_mismatch: { why: "归档文件与关闭时登记的内容不一致", next: "请用户确认归档文件没有被手动改动" },
  unexpected_staged: { why: "暂存区里有归档以外的文件", next: "请用户清理暂存区后再交付" },
  unexpected_commit_content: { why: "交付提交里出现了归档以外的改动", next: "请用户检查分支后再交付" },
  push_rejected: { why: "推送被远端拒绝", next: "按 Git 的报错处理：没登录请用户登录，不能快进就先同步目标分支，受保护分支请用户调整权限" },
  pull_request_unknown: { why: "PR 或 MR 没能建立", next: "按报错处理：gh 或 glab 没装或没登录时请用户处理，也可以请用户手动开 PR" },
} as const;
type RejectCode = keyof typeof REJECT_ADVICE;

export const REVIEW_CHOICE = "自己 review";
export const AUTO_MERGE_CHOICE = "自动合并";

type Provider = "gh" | "glab";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const entries = (text: string) => text.split("\0").filter(Boolean);

function providerFor(url: string): Provider | null {
  return /github/i.test(url) ? "gh" : /gitlab/i.test(url) ? "glab" : null;
}
async function cli(provider: Provider, cwd: string, args: string[]) {
  return (await exec(provider, args, { cwd, maxBuffer: 1 << 22, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_PROMPT: "1" } })).stdout;
}
/** 同一源分支上仍打开的 PR/MR；查询失败按未知处理，由调用方停止。 */
async function existingRequest(provider: Provider, cwd: string, branch: string): Promise<{ number: string; url: string } | null> {
  if (provider === "gh") {
    const list = JSON.parse(await cli("gh", cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"])) as Array<{ number: number; url: string }>;
    return list[0] ? { number: String(list[0].number), url: list[0].url } : null;
  }
  const list = JSON.parse(await cli("glab", cwd, ["mr", "list", "--source-branch", branch, "--output", "json"])) as Array<{ iid: number; web_url: string }>;
  return list[0] ? { number: String(list[0].iid), url: list[0].web_url } : null;
}
async function createRequest(provider: Provider, cwd: string, input: { branch: string; base: string; title: string; body: string }): Promise<void> {
  if (provider === "gh") await cli("gh", cwd, ["pr", "create", "--head", input.branch, "--base", input.base, "--title", input.title, "--body", input.body]);
  else await cli("glab", cwd, ["mr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "--yes"]);
}
/** 自动合并只合并已推送的那个提交；优先 squash，仓库不允许时改用它允许的方式。 */
async function enableAutoMerge(provider: Provider, cwd: string, number: string, head: string): Promise<void> {
  if (provider === "gh") {
    const allowed = JSON.parse(await cli("gh", cwd, ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"])) as
      { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean };
    const method = allowed.squashMergeAllowed ? "--squash" : allowed.mergeCommitAllowed ? "--merge" : allowed.rebaseMergeAllowed ? "--rebase" : null;
    if (!method) throw new Error("merge_method_unavailable: 仓库没有允许的合并方式");
    await cli("gh", cwd, ["pr", "merge", number, "--auto", method, "--match-head-commit", head]);
    return;
  }
  try { await cli("glab", cwd, ["mr", "merge", number, "--auto-merge", "--squash", "--sha", head, "--yes"]); }
  catch { await cli("glab", cwd, ["mr", "merge", number, "--auto-merge", "--sha", head, "--yes"]); }
}

/**
 * 可选业务 Git 交付：核对完成凭据与实际产物后，经用户确认提交归档、推送准确提交号并建或复用 PR/MR；
 * 验收后目标分支前进时能干净 rebase 才继续，并在描述中注明未重新验证；合并方式由用户在界面选择。
 */
export async function deliverRequirement(facts: DeliveryFacts, ui: DeliveryUi): Promise<DeliveryResult> {
  const reject = (code: RejectCode, detail?: string) =>
    ({ status: "rejected" as const, reason: detail ? `${REJECT_ADVICE[code].why}：${detail}` : REJECT_ADVICE[code].why, next: REJECT_ADVICE[code].next });
  if (!facts.closed || facts.reason !== "completed") return reject("requirement_not_completed");
  if (!facts.archive || facts.archive.status !== "archived") return reject("archive_not_written");
  const archive = facts.archive;
  const git = (args: string[]) => gitIn(facts.worktree, args);
  const branch = facts.branch.slice("refs/heads/".length);
  if ((await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !== facts.branch) return reject("branch_changed");
  const dirty = entries((await git(["status", "--porcelain", "-z", "--untracked-files=all"])).stdout).map((entry) => entry.slice(3));
  if (dirty.some((path) => path !== archive.path)) return reject("worktree_dirty");
  let remoteError = "";
  const remoteUrl = (await git(["remote", "get-url", "origin"]).catch((error: unknown) => { remoteError = commandOutputTail(error); return { stdout: "" }; })).stdout.trim();
  const provider = providerFor(remoteUrl);
  if (!remoteUrl) return reject("no_remote", remoteError || undefined);
  if (!provider) return reject("unknown_host");

  const target = await fetchRemoteTarget(facts.worktree);
  // 中途失败后重跑时分支上可能已有归档提交或 rebase；比较需求自身改动的补丁指纹，与最终检查时一致才放行
  const ownChanges = async (tip: string) => {
    const base = (await git(["merge-base", target.sha, tip])).stdout.trim();
    const diff = (await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", base, tip, "--", ".", `:(exclude)${archive.path}`])).stdout;
    return (await gitIn(facts.worktree, ["patch-id", "--stable"], diff)).stdout.split(" ")[0] ?? "";
  };
  if ((await git(["rev-parse", "HEAD"])).stdout.trim() !== facts.codeHead && await ownChanges("HEAD") !== await ownChanges(facts.codeHead)) return reject("head_changed");
  const changed = entries((await git(["diff", "-z", "--name-only", `${target.sha}...HEAD`])).stdout);
  if (changed.some((path) => isProdArchivePath(path) && path !== archive.path)) return reject("foreign_prod_archive");
  if ((await git(["diff", "--raw", `${target.sha}...HEAD`])).stdout.split("\n").some((line) => /^:\d+ 160000 /.test(line))) return reject("nested_repository");
  let rebasedAfterAcceptance = false;
  if (!(await includesCommit(facts.worktree, target.sha))) {
    const failure = await git(["rebase", "--no-autosquash", "--no-autostash", target.sha]).then(() => null, (error: unknown) => error);
    if (failure) {
      await git(["rebase", "--abort"]).catch(() => undefined);
      const output = commandOutputTail(failure);
      const conflicted = /CONFLICT|could not apply/iu.test(String((failure as { stdout?: unknown }).stdout ?? "") + output);
      return { status: "conflict", target: target.ref,
        reason: `${conflicted ? "目标分支在验收后前进，自动 rebase 有冲突" : "自动 rebase 失败"}：${output}`,
        next: conflicted ? "请用户手动解决冲突，重新检查和验收后再交付" : "按 Git 的报错处理后再交付" };
    }
    rebasedAfterAcceptance = true;
  }

  await git(["add", "--", archive.path]);
  const staged = /^\d+ ([0-9a-f]+) 0\t/.exec((await git(["ls-files", "-s", "--", archive.path])).stdout)?.[1];
  const stagedBytes = staged ? (await exec("git", ["cat-file", "blob", staged], { cwd: facts.worktree, encoding: "buffer", maxBuffer: 1 << 26 })).stdout : null;
  const worktreeMatchesIndex = await git(["diff", "--quiet", "--", archive.path]).then(() => true, () => false);
  if (!stagedBytes || sha256(stagedBytes) !== archive.archiveHash || !worktreeMatchesIndex) {
    await git(["reset", "--quiet", "--", archive.path]);
    return reject("archive_mismatch");
  }
  if ((await git(["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean).some((path) => path !== archive.path)) return reject("unexpected_staged");
  const pending = (await git(["diff", "--cached", "--quiet"]).then(() => false, () => true));
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const title = archive.path.slice(archive.path.lastIndexOf("/") + 1).replace(/^[0-9a-f-]{36}\./, "").replace(/\.md$/, "");
  const approved = await ui.confirm({ title: "交付到 Git", lines: [{ text: `需求：${title}` }, ...mutedLines([`编号：${facts.requirementId}`,
    `分支：${branch} → ${target.name}（${provider}）`, pending ? `将提交归档 ${archive.path}` : "归档已在分支中",
    rebasedAfterAcceptance ? "目标分支在验收后前进，已自动 rebase，这部分未重新验证" : "目标分支未变化", "确认后推送并建立或复用 PR。"])] });
  if (!approved) return { status: "cancelled", head };
  if (pending) await git(["commit", "--quiet", "-m", `docs(prod): 归档需求 ${facts.requirementId}`]);
  const delivered = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const archiveOnly = entries((await git(["diff", "-z", "--name-only", head, delivered])).stdout);
  if (archiveOnly.some((path) => path !== archive.path)) return reject("unexpected_commit_content");
  try { await git(["push", "--quiet", "origin", `${delivered}:refs/heads/${branch}`]); }
  catch (error) { return reject("push_rejected", commandOutputTail(error)); }

  let request = await existingRequest(provider, facts.worktree, branch);
  const reused = request !== null;
  if (!request) {
    const body = [`需求 ${facts.requirementId}`, `交付提交 ${delivered}`, `最终检查代码 ${facts.codeHead}`,
      ...(rebasedAfterAcceptance ? ["验收后已自动 rebase，这部分未重新验证。"] : [])].join("\n");
    let createError = "";
    await createRequest(provider, facts.worktree, { branch, base: target.name, title: `${title} [${facts.requirementId}]`, body }).catch((error: unknown) => { createError = commandOutputTail(error); });
    request = await existingRequest(provider, facts.worktree, branch);
    if (!request) return reject("pull_request_unknown", createError || undefined);
  }
  const choice = await ui.choose({ title: "PR 已就绪，怎么合并？", lines: [{ text: `需求：${title}` }, { text: `PR：${request.url}`, tone: "muted" }],
    choices: [{ label: REVIEW_CHOICE, description: "PR 留着等你看，合并由你在网页上操作" },
      { label: AUTO_MERGE_CHOICE, description: "等仓库要求的检查通过后自动合并，优先 squash" }], cancelNote: "取消等于自己 review" });
  const merge = choice === AUTO_MERGE_CHOICE ? "auto" as const : "review" as const;
  if (merge === "auto") await enableAutoMerge(provider, facts.worktree, request.number, delivered);
  return { status: "delivered", head: delivered, provider, url: request.url, reused, rebasedAfterAcceptance, merge };
}
