import { mutedLines } from "../../core/host/question-window.ts";
import type { WindowChoice } from "../../core/host/question-window.ts";
import { AdvisedError, commandOutputTail } from "../../core/exec/tool-failure.ts";
import { checkedOutBranch, gitIn } from "../../core/exec/target-branch.ts";
import type { MergeMethod } from "../settings/agent-settings.ts";
import { deliveryBody, deliveryTitle, prepareDelivery, requirementTitle } from "./git-delivery.ts";
import type { DeliveryFacts, DeliveryResult, DeliveryUi } from "./git-delivery.ts";

type Rejected = Extract<DeliveryResult, { status: "rejected" }>;
const rejected = (reason: string, next: string): Rejected => ({ status: "rejected", reason, next });

const METHOD_ORDER: readonly MergeMethod[] = ["squash", "merge", "rebase"];
const LABELS: Record<MergeMethod, string> = { squash: "压缩合并", merge: "普通合并", rebase: "rebase 合并" };

async function mainRepositoryCheck(repositoryRoot: string): Promise<Rejected | null> {
  const dirty = (await gitIn(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  return dirty ? rejected("主仓库有未提交的改动", "请用户提交或暂存（stash）主仓库的改动后再交付") : null;
}

function localMergeChoices(methods: readonly MergeMethod[], target: string, title: string, requirementId: string): Array<{ method: MergeMethod; choice: WindowChoice }> {
  const descriptions: Record<MergeMethod, string> = {
    squash: `${target} 上多一个提交；标题是“${title}”，正文末行 Requirement: ${requirementId}`,
    merge: "保留每个提交，另加一个合并提交",
    rebase: `保留每个提交，${target} 直接前进到需求分支末端`,
  };
  return METHOD_ORDER.filter((method) => methods.includes(method)).map((method) =>
    ({ method, choice: { label: LABELS[method], description: descriptions[method], ...(method === "squash" ? { recommended: true } : {}) } }));
}

async function mergeLocally(repositoryRoot: string, method: MergeMethod, input: { tip: string; base: string; title: string; body: string }): Promise<Rejected | null> {
  const { tip, base, title, body } = input;
  const git = async (args: string[]) => (await gitIn(repositoryRoot, args)).stdout.trim();
  try {
    // Git 生成合并提交时会悄悄覆盖被忽略的本地文件，只有快进时 --no-overwrite-ignore 才拦得住，所以先造好提交再快进。
    // 父提交用核对过的 base：主分支若又前进，快进会被拒绝，不会丢掉新提交。
    let commit = tip;
    if (method === "squash") commit = await git(["commit-tree", `${tip}^{tree}`, "-p", base, "-m", title, "-m", body]);
    else if (method === "merge") commit = await git(["commit-tree", `${tip}^{tree}`, "-p", base, "-p", tip, "-m", title, "-m", body]);
    await git(["merge", "--ff-only", "--no-overwrite-ignore", commit]);
    return null;
  } catch (error) {
    return rejected(`本地合并失败：${commandOutputTail(error, 8, 600)}`, "处理后再交付");
  }
}

/** 仅本地交付：在主仓库当前检出的分支上合并需求分支，不推送、不碰远端；需求分支和工作区保留。 */
export async function deliverLocally(facts: DeliveryFacts, ui: DeliveryUi, options: { repositoryRoot: string; mergeMethods: readonly MergeMethod[] }): Promise<DeliveryResult> {
  const { repositoryRoot } = options;
  let target;
  try { target = await checkedOutBranch(repositoryRoot, facts.worktree); }
  catch (error) {
    if (error instanceof AdvisedError) return rejected("主仓库当前没有检出分支", "请用户在主仓库检出要合进去的分支后再交付");
    throw error;
  }
  const dirty = await mainRepositoryCheck(repositoryRoot);
  if (dirty) return dirty;
  const prepared = await prepareDelivery(facts, target);
  if (prepared.status === "conflict") return { ...prepared, target: target.name };
  if (prepared.status !== "ready") return prepared;
  const { head: tip, rebased } = prepared;
  if (tip === target.sha) return rejected(`需求分支的改动已经全部在 ${target.name} 里，这个需求可能已经交付过`, "不用再交付；要清理需求工作区就用回收工作区");

  const title = deliveryTitle(facts);
  const entries = localMergeChoices(options.mergeMethods, target.name, title, facts.requirementId);
  const picked = await ui.choose({ title: `合进 ${target.name}，怎么合并？`,
    lines: [{ text: `需求：${requirementTitle(facts)}` }, ...mutedLines([`编号：${facts.requirementId}`,
      `分支：${facts.branch.slice("refs/heads/".length)} → ${target.name}（仅本地，不推送）`,
      "归档已在分支中",
      rebased ? "目标分支在验收后前进，已自动 rebase，这部分未重新验证" : "目标分支未变化"])],
    choices: entries.map((entry) => entry.choice), cancelNote: "取消就不合并，需求分支保留", caption: "交付到本地分支" });
  const selected = entries.find((entry) => entry.choice.label === picked);
  if (!selected) return { status: "not-merged", reason: "用户选择先不合并，需求分支保留" };
  const now = await checkedOutBranch(repositoryRoot, facts.worktree).catch(() => null);
  if (!now || now.ref !== target.ref || now.sha !== target.sha) return rejected("选合并方式期间主仓库当前分支变了", "请用户确认要合进去的分支后再交付");
  const dirtyNow = await mainRepositoryCheck(repositoryRoot);
  if (dirtyNow) return dirtyNow;

  const failure = await mergeLocally(repositoryRoot, selected.method, { tip, base: target.sha, title, body: deliveryBody(facts, tip, rebased) });
  if (failure) return failure;
  return { status: "merged-locally", method: selected.method, target: target.name, head: (await gitIn(repositoryRoot, ["rev-parse", target.ref])).stdout.trim(), rebasedAfterAcceptance: rebased };
}
