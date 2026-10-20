import { mutedLines } from "../../core/host/question-window.ts";
import type { ProgramWindow, WindowChoice } from "../../core/host/question-window.ts";
import { commandOutputTail } from "../../core/exec/tool-failure.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPrdArchivePath } from "../../core/policy/content-policy.ts";
import { archiveInHead } from "./archive-commit.ts";
import { fetchRemoteTarget, gitIn, includesCommit } from "../../core/exec/target-branch.ts";
import type { TargetBranch } from "../../core/exec/target-branch.ts";
import { originHost, providerForHost } from "../../core/exec/git-host.ts";
import type { DeliveryMode, GitProvider } from "../../core/exec/git-host.ts";
import type { MergeMethod } from "../settings/agent-settings.ts";

const exec = promisify(execFile);

/** 交付所需的无正文事实：来自可信关闭记录。 */
export interface DeliveryFacts {
  requirementId: string;
  closed: boolean;
  reason: string;
  archive: { path: string; archiveHash: string | null; status: string; prototypes: Array<{ path: string; name: string; version: number; hash: string }> } | null;
  worktree: string;
  branch: string;
  /** 最终检查轮核对过的代码提交。 */
  codeHead: string;
}
export interface DeliveryOptions { mode: DeliveryMode; mergeMethods: readonly MergeMethod[] }
export interface DeliveryUi {
  confirm(window: ProgramWindow): Promise<boolean>;
  choose(window: ProgramWindow & { choices: WindowChoice[]; cancelNote?: string }): Promise<string | undefined>;
}
type MergeChoice = MergeMethod | "project";
export interface MergeOutcome { method: "review" | MergeChoice; state: "review" | "queued" | "merged" | "failed"; reason?: string; next?: string }
export type DeliveryResult =
  | { status: "rejected"; reason: string; next: string }
  | { status: "conflict"; target: string; reason: string; next: string }
  | { status: "cancelled"; head: string }
  | { status: "delivered"; head: string; provider: GitProvider; url: string; reused: boolean; rebasedAfterAcceptance: boolean; merge: MergeOutcome };

const REJECT_ADVICE = {
  requirement_not_completed: { why: "需求没有以完成关闭", next: "只有用户验收通过并以完成关闭的需求才能交付" },
  archive_not_written: { why: "需求归档还没写好", next: "用 workflow_manage 的 status 查看归档状态，归档完成后再交付" },
  branch_changed: { why: "需求工作区当前不在需求分支上", next: "请用户把需求工作区切回需求分支后再交付" },
  worktree_dirty: { why: "需求工作区里有未提交改动", next: "请用户处理这些改动后再交付" },
  head_changed: { why: "需求分支在最终检查后又有代码改动", next: "重新做交付核对和验收后再交付" },
  foreign_prd_archive: { why: "分支里带了别的需求的归档文件", next: "请用户移除这些文件后再交付" },
  nested_repository: { why: "分支里有嵌套仓库（子模块）改动", next: "请用户处理子模块改动后再交付" },
  archive_mismatch: { why: "归档文件与关闭时登记的内容不一致", next: "请用户确认归档文件没有被手动改动" },
  push_rejected: { why: "推送被远端拒绝", next: "按 Git 的报错处理：没登录请用户登录，不能快进就先同步目标分支，受保护分支请用户调整权限" },
} as const;
type RejectCode = keyof typeof REJECT_ADVICE;

const REVIEW_CHOICE = "自己 review";
const SWITCH_TO_LOCAL = "或在 /one:setting 把 Git 交付改成仅本地";

const entries = (text: string) => text.split("\0").filter(Boolean);

async function cli(provider: GitProvider, cwd: string, args: string[], timeout = 120_000) {
  return (await exec(provider, args, { cwd, timeout, maxBuffer: 1 << 22, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_PROMPT: "1" } })).stdout;
}
/** 同一源分支上仍打开的 PR/MR；查询失败按未知处理，由调用方停止。 */
async function existingRequest(provider: GitProvider, cwd: string, branch: string): Promise<{ number: string; url: string } | null> {
  if (provider === "gh") {
    const list = JSON.parse(await cli("gh", cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"])) as Array<{ number: number; url: string }>;
    return list[0] ? { number: String(list[0].number), url: list[0].url } : null;
  }
  const list = JSON.parse(await cli("glab", cwd, ["mr", "list", "--source-branch", branch, "--output", "json"])) as Array<{ iid: number; web_url: string }>;
  return list[0] ? { number: String(list[0].iid), url: list[0].web_url } : null;
}
async function createRequest(provider: GitProvider, cwd: string, input: { branch: string; base: string; title: string; body: string }): Promise<void> {
  if (provider === "gh") await cli("gh", cwd, ["pr", "create", "--head", input.branch, "--base", input.base, "--title", input.title, "--body", input.body]);
  else await cli("glab", cwd, ["mr", "create", "--source-branch", input.branch, "--target-branch", input.base, "--title", input.title, "--description", input.body, "--yes"]);
}
async function updateRequestBody(provider: GitProvider, cwd: string, number: string, body: string): Promise<void> {
  if (provider === "gh") await cli("gh", cwd, ["pr", "edit", number, "--body", body]);
  else await cli("glab", cwd, ["mr", "update", number, "--description", body]);
}

const requirementTitle = (facts: DeliveryFacts) => facts.archive!.path.slice(facts.archive!.path.lastIndexOf("/") + 1).replace(/^[0-9a-f-]{36}\./, "").replace(/\.md$/, "");
export const deliveryTitle = (facts: DeliveryFacts) => `${requirementTitle(facts)} [${facts.requirementId}]`;
export const deliveryBody = (facts: DeliveryFacts, head: string, rebased: boolean) =>
  [`需求 ${facts.requirementId}`, `交付提交 ${head}`, `最终检查代码 ${facts.codeHead}`,
    ...(rebased ? ["验收后已自动 rebase，这部分未重新验证。"] : []), "", `Requirement: ${facts.requirementId}`].join("\n");

type Prepared = { status: "ready"; head: string; rebased: boolean } | Extract<DeliveryResult, { status: "rejected" | "conflict" }>;

/** 交付公共核对：完成凭据、归档、工作区、补丁指纹；目标分支前进时 rebase，冲突就放弃并返回 conflict。 */
export async function prepareDelivery(facts: DeliveryFacts, target: TargetBranch): Promise<Prepared> {
  const reject = (code: RejectCode, detail?: string) =>
    ({ status: "rejected" as const, reason: detail ? `${REJECT_ADVICE[code].why}：${detail}` : REJECT_ADVICE[code].why, next: REJECT_ADVICE[code].next });
  if (!facts.closed || facts.reason !== "completed") return reject("requirement_not_completed");
  if (!facts.archive || facts.archive.status !== "archived") return reject("archive_not_written");
  const archive = facts.archive;
  const group = [{ path: archive.path, hash: archive.archiveHash }, ...archive.prototypes.map((item) => ({ path: item.path, hash: item.hash as string | null }))];
  const groupPaths = group.map((item) => item.path);
  const git = (args: string[]) => gitIn(facts.worktree, args);
  if ((await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !== facts.branch) return reject("branch_changed");
  if ((await git(["status", "--porcelain", "-uall"])).stdout.trim()) return reject("worktree_dirty");

  // 中途失败后重跑时分支上可能已有归档提交或 rebase；比较需求自身改动的补丁指纹，与最终检查时一致才放行
  const ownChanges = async (tip: string) => {
    const base = (await git(["merge-base", target.sha, tip])).stdout.trim();
    const diff = (await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", base, tip, "--", ".", ...groupPaths.map((path) => `:(exclude,literal)${path}`)])).stdout;
    return (await gitIn(facts.worktree, ["patch-id", "--stable"], diff)).stdout.split(" ")[0] ?? "";
  };
  if ((await git(["rev-parse", "HEAD"])).stdout.trim() !== facts.codeHead && await ownChanges("HEAD") !== await ownChanges(facts.codeHead)) return reject("head_changed");
  const changed = entries((await git(["diff", "-z", "--name-only", `${target.sha}...HEAD`])).stdout);
  if (changed.some((path) => isPrdArchivePath(path) && !groupPaths.includes(path))) return reject("foreign_prd_archive");
  if ((await git(["diff", "--raw", `${target.sha}...HEAD`])).stdout.split("\n").some((line) => /^:\d+ 160000 /.test(line))) return reject("nested_repository");
  let rebased = false;
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
    rebased = true;
  }
  for (const file of group) {
    if (!file.hash || !await archiveInHead(facts.worktree, [{ path: file.path, hash: file.hash }])) return reject("archive_mismatch", file.path);
  }
  return { status: "ready", head: (await git(["rev-parse", "HEAD"])).stdout.trim(), rebased };
}

interface MergeEntry { choice: WindowChoice; method: MergeChoice }
interface MergeMenu { entries: MergeEntry[]; autoMerge: boolean; line: string | null }

const GITHUB_METHODS = {
  squash: { label: "压缩合并", flag: "--squash", allowKey: "squashMergeAllowed", denied: "仓库不允许压缩合并" },
  merge: { label: "普通合并", flag: "--merge", allowKey: "mergeCommitAllowed", denied: "仓库不允许普通合并" },
  rebase: { label: "rebase 合并", flag: "--rebase", allowKey: "rebaseMergeAllowed", denied: "仓库不允许 rebase 合并" },
} as const;
const GITHUB_REPO_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}";
const METHOD_ORDER: readonly MergeMethod[] = ["squash", "merge", "rebase"];

async function githubMergeOptions(cwd: string, host: string, methods: readonly MergeMethod[], title: string, number: string, requirementId: string): Promise<MergeMenu> {
  const wanted = METHOD_ORDER.filter((key) => methods.includes(key));
  let repo: Record<string, unknown>;
  let broken: string | undefined;
  try {
    repo = (JSON.parse(await cli("gh", cwd, ["api", "graphql", "--hostname", host, "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${GITHUB_REPO_QUERY}`])) as { data: { repository: Record<string, unknown> } }).data.repository;
    if (![repo.autoMergeAllowed, ...Object.values(GITHUB_METHODS).map((info) => repo[info.allowKey])].every((value) => typeof value === "boolean")) broken = "拿到的合并设置不是 true/false";
  } catch (error) { repo = {}; broken = commandOutputTail(error); }
  if (broken) {
    const disabled = `查不到仓库允许的合并方式：${broken}`;
    return { entries: wanted.map((key) => ({ method: key, choice: { label: GITHUB_METHODS[key].label, disabled } })), autoMerge: false, line: null };
  }
  const descriptions = {
    squash: `所有提交压成一个；标题是“${title} (#${number})”，正文末行 Requirement: ${requirementId}`,
    merge: "保留每个提交，另加一个合并提交",
    rebase: "保留每个提交，接到目标分支后面",
  };
  const autoMerge = repo.autoMergeAllowed === true;
  return { autoMerge, line: autoMerge ? "仓库要求的检查通过后合并" : "仓库没开自动合并，选了就现在合并",
    entries: wanted.map((key) => {
      const info = GITHUB_METHODS[key];
      return { method: key, choice: repo[info.allowKey] ? { label: info.label, description: descriptions[key], ...(key === "squash" ? { recommended: true } : {}) } : { label: info.label, disabled: info.denied } };
    }) };
}

async function gitlabMergeOptions(cwd: string, host: string, methods: readonly MergeMethod[], title: string, requirementId: string): Promise<MergeMenu> {
  const SQUASH = "压缩合并", PROJECT = "不压缩（按项目设置）";
  const wantSquash = methods.includes("squash"), wantProject = methods.includes("merge") || methods.includes("rebase");
  let option: string;
  let broken: string | undefined;
  try { option = (JSON.parse(await cli("glab", cwd, ["api", "projects/:fullpath", "--hostname", host])) as { squash_option?: string }).squash_option ?? ""; }
  catch (error) { option = ""; broken = `查不到项目的压缩设置：${commandOutputTail(error)}`; }
  const squashDisabled = broken ?? (option === "never" ? "项目不允许压缩" : undefined);
  const projectDisabled = broken ?? (option === "always" ? "项目要求压缩" : option === "default_on" ? "项目默认压缩" : undefined);
  const found: MergeEntry[] = [];
  if (wantSquash) found.push({ method: "squash", choice: { label: SQUASH, ...(squashDisabled ? { disabled: squashDisabled } : { recommended: true }),
    description: `所有提交压成一个；说明是“${title}”、空一行、MR 描述（末行 Requirement: ${requirementId}）` } });
  if (wantProject) found.push({ method: "project", choice: { label: PROJECT, ...(projectDisabled ? { disabled: projectDisabled } : {}),
    description: "按项目设置的合并方式合并：普通合并、半线性或快进" } });
  return { entries: found, autoMerge: false, line: "有流水线时等流水线通过后合并" };
}

/** 只合并已推送的那个提交（--match-head-commit / --sha）；平台拒绝时返回 failed 而不是抛错，PR/MR 已经建好。合并命令成功不等于已合并（可能只是排队），所以再查一次真实状态。 */
async function mergeRequest(provider: GitProvider, cwd: string, input: { number: string; head: string; method: MergeChoice; autoMerge: boolean; title: string; body: string }): Promise<MergeOutcome> {
  const { number, head, method, autoMerge, title, body } = input;
  try {
    if (provider === "gh") {
      const flags = method === "rebase" ? [] : ["--subject", `${title} (#${number})`, "--body", body];
      await cli("gh", cwd, ["pr", "merge", number, GITHUB_METHODS[method as MergeMethod].flag, "--match-head-commit", head, ...(autoMerge ? ["--auto"] : []), ...flags]);
    } else {
      await cli("glab", cwd, ["mr", "merge", number, "--sha", head, "--yes", ...(method === "squash" ? ["--squash", "--squash-message", `${title}\n\n${body}`] : [])]);
    }
  } catch (error) {
    return { method, state: "failed", reason: commandOutputTail(error), next: "处理后在网页上合并，或修好后重新交付" };
  }
  const unknown = (detail: string): MergeOutcome => ({ method, state: "queued", reason: `合并命令已发出，状态没查到：${detail}` });
  try {
    if (provider === "gh") {
      const view = JSON.parse(await cli("gh", cwd, ["pr", "view", number, "--json", "state,autoMergeRequest"])) as { state: string; autoMergeRequest: unknown };
      if (view.state === "MERGED") return { method, state: "merged" };
      return view.autoMergeRequest ? { method, state: "queued" } : { method, state: "queued", reason: `合并命令已发出，PR 状态是 ${view.state}，也没有自动合并请求` };
    }
    const view = JSON.parse(await cli("glab", cwd, ["mr", "view", number, "-F", "json"])) as { state: string; merge_when_pipeline_succeeds?: boolean };
    if (view.state === "merged") return { method, state: "merged" };
    return view.merge_when_pipeline_succeeds ? { method, state: "queued" } : { method, state: "queued", reason: `合并命令已发出，MR 状态是 ${view.state}，也没有设置流水线通过后合并` };
  } catch (error) {
    return unknown(commandOutputTail(error));
  }
}

/**
 * 远程 Git 交付：核对完成凭据与已在分支中的归档后，经用户确认推送准确提交号并建或复用 PR/MR；
 * 验收后目标分支前进时能干净 rebase 才继续，并在描述中注明未重新验证；合并方式由用户在界面选择。
 */
export async function deliverRequirement(facts: DeliveryFacts, ui: DeliveryUi, options: DeliveryOptions): Promise<DeliveryResult> {
  const rejected = (reason: string, next: string) => ({ status: "rejected" as const, reason, next });
  const host = await originHost(facts.worktree);
  if (!host) return rejected("仓库没有名为 origin 的远端", `配置 origin 后再交付，${SWITCH_TO_LOCAL}`);
  const provider = await providerForHost(host);
  if (!provider) return rejected(`本机 gh 和 glab 都没登录 ${host}`, `登录后再交付，${SWITCH_TO_LOCAL}`);
  try { await cli(provider, facts.worktree, ["api", "user", "--hostname", host], 10_000); }
  catch (error) { return rejected(`${provider} 连不上 ${host}：${commandOutputTail(error)}`, "检查网络和登录状态（gh auth status 或 glab auth status）后再交付"); }

  const target = await fetchRemoteTarget(facts.worktree);
  const prepared = await prepareDelivery(facts, target);
  if (prepared.status !== "ready") return prepared;
  const { head: delivered, rebased } = prepared;
  const git = (args: string[]) => gitIn(facts.worktree, args);
  const branch = facts.branch.slice("refs/heads/".length);
  const requirement = requirementTitle(facts);
  const approved = await ui.confirm({ title: "交付到 Git", lines: [{ text: `需求：${requirement}` }, ...mutedLines([`编号：${facts.requirementId}`,
    `分支：${branch} → ${target.name}（${provider}）`, "归档已在分支中",
    rebased ? "目标分支在验收后前进，已自动 rebase，这部分未重新验证" : "目标分支未变化", "确认后推送并建立或复用 PR。"])] });
  if (!approved) return { status: "cancelled", head: delivered };
  try { await git(["push", "--quiet", "origin", `${delivered}:refs/heads/${branch}`]); }
  catch (error) { return { status: "rejected", reason: `${REJECT_ADVICE.push_rejected.why}：${commandOutputTail(error)}`, next: REJECT_ADVICE.push_rejected.next }; }

  const title = deliveryTitle(facts), body = deliveryBody(facts, delivered, rebased);
  const noun = provider === "gh" ? "PR" : "MR";
  const afterPush = (step: string, error: unknown) => ({ status: "rejected" as const, reason: `分支已推送到 origin，但${step}失败：${commandOutputTail(error)}`,
    next: `处理后重新交付即可，会复用已有的 ${noun}` });
  let request: { number: string; url: string } | null;
  try { request = await existingRequest(provider, facts.worktree, branch); }
  catch (error) { return afterPush(`查已有的 ${noun} 这一步`, error); }
  const reused = request !== null;
  if (request) {
    try { await updateRequestBody(provider, facts.worktree, request.number, body); }
    catch (error) { return afterPush(`更新已有 ${noun} 的描述这一步`, error); }
  } else {
    let createError: unknown;
    await createRequest(provider, facts.worktree, { branch, base: target.name, title, body }).catch((error: unknown) => { createError = error; });
    try { request = await existingRequest(provider, facts.worktree, branch); }
    catch (error) { return afterPush(`建 ${noun} 后确认它是否建出来这一步`, error); }
    if (!request) return afterPush(`建 ${noun} 这一步`, createError ?? new Error(`创建命令返回成功但没有查到新建的 ${noun}`));
  }
  const menu = provider === "gh"
    ? await githubMergeOptions(facts.worktree, host, options.mergeMethods, title, request.number, facts.requirementId)
    : await gitlabMergeOptions(facts.worktree, host, options.mergeMethods, title, facts.requirementId);
  const choice = await ui.choose({ title: `${noun} 已就绪，怎么合并？`, lines: [{ text: `需求：${requirement}` }, { text: `${noun}：${request.url}`, tone: "muted" }, ...mutedLines(menu.line ? [menu.line] : [])],
    choices: [{ label: REVIEW_CHOICE, description: `${noun} 留着等你看，合并由你在网页上操作` }, ...menu.entries.map((entry) => entry.choice)], cancelNote: "取消等于自己 review" });
  const selected = menu.entries.find((entry) => entry.choice.label === choice && !entry.choice.disabled);
  const merge: MergeOutcome = selected
    ? await mergeRequest(provider, facts.worktree, { number: request.number, head: delivered, method: selected.method, autoMerge: menu.autoMerge, title, body })
    : { method: "review", state: "review" };
  return { status: "delivered", head: delivered, provider, url: request.url, reused, rebasedAfterAcceptance: rebased, merge };
}
