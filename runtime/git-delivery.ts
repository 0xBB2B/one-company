import { createHash } from "node:crypto";
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
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
}
export type DeliveryResult =
  | { status: "rejected"; reason: string }
  | { status: "conflict"; target: string }
  | { status: "cancelled"; head: string }
  | { status: "delivered"; head: string; provider: "gh" | "glab"; url: string; reused: boolean; rebasedAfterAcceptance: boolean; merge: "review" | "auto" };

export const REVIEW_CHOICE = "自己 review";
export const AUTO_MERGE_CHOICE = "自动合并（等检查通过，优先 squash）";

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
  const reject = (reason: string) => ({ status: "rejected" as const, reason });
  if (!facts.closed || facts.reason !== "completed") return reject("requirement_not_completed");
  if (!facts.archive || facts.archive.status !== "archived") return reject("archive_not_written");
  const archive = facts.archive;
  const git = (args: string[]) => gitIn(facts.worktree, args);
  const branch = facts.branch.slice("refs/heads/".length);
  if ((await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !== facts.branch) return reject("branch_changed");
  const dirty = entries((await git(["status", "--porcelain", "-z", "--untracked-files=all"])).stdout).map((entry) => entry.slice(3));
  if (dirty.some((path) => path !== archive.path)) return reject("worktree_dirty");
  const remoteUrl = (await git(["remote", "get-url", "origin"]).catch(() => ({ stdout: "" }))).stdout.trim();
  const provider = providerFor(remoteUrl);
  if (!remoteUrl) return reject("no_remote");
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
    const rebased = await git(["rebase", "--no-autosquash", "--no-autostash", target.sha]).then(() => true, () => false);
    if (!rebased) { await git(["rebase", "--abort"]); return { status: "conflict", target: target.ref }; }
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
  const approved = await ui.confirm("交付到 Git", [`需求 ${facts.requirementId}`, `分支 ${branch} → ${target.name}（${provider}）`,
    pending ? `将提交归档 ${archive.path}` : "归档已在分支中", rebasedAfterAcceptance ? "目标分支在验收后前进，已自动 rebase，这部分未重新验证" : "目标分支未变化",
    "确认后推送并建立或复用 PR。"].join("\n"));
  if (!approved) return { status: "cancelled", head };
  if (pending) await git(["commit", "--quiet", "-m", `docs(prod): 归档需求 ${facts.requirementId}`]);
  const delivered = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const archiveOnly = entries((await git(["diff", "-z", "--name-only", head, delivered])).stdout);
  if (archiveOnly.some((path) => path !== archive.path)) return reject("unexpected_commit_content");
  try { await git(["push", "--quiet", "origin", `${delivered}:refs/heads/${branch}`]); }
  catch { return reject("push_rejected"); }

  let request = await existingRequest(provider, facts.worktree, branch);
  const reused = request !== null;
  if (!request) {
    const title = archive.path.slice(archive.path.lastIndexOf("/") + 1).replace(/^[0-9a-f-]{36}\./, "").replace(/\.md$/, "");
    const body = [`需求 ${facts.requirementId}`, `交付提交 ${delivered}`, `最终检查代码 ${facts.codeHead}`,
      ...(rebasedAfterAcceptance ? ["验收后已自动 rebase，这部分未重新验证。"] : [])].join("\n");
    await createRequest(provider, facts.worktree, { branch, base: target.name, title, body }).catch(() => undefined);
    request = await existingRequest(provider, facts.worktree, branch);
    if (!request) return reject("pull_request_unknown");
  }
  const choice = await ui.select(`PR 已就绪：${request.url}`, [REVIEW_CHOICE, AUTO_MERGE_CHOICE]);
  const merge = choice === AUTO_MERGE_CHOICE ? "auto" as const : "review" as const;
  if (merge === "auto") await enableAutoMerge(provider, facts.worktree, request.number, delivered);
  return { status: "delivered", head: delivered, provider, url: request.url, reused, rebasedAfterAcceptance, merge };
}
