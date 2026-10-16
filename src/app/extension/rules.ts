import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dataRoot as defaultDataRoot } from "../runtime/identity.ts";
import { loadPackageRules } from "../runtime/package-rules.ts";
import { resolveRepositoryRequirementDoc, resolveRequirementDoc } from "../runtime/requirement-doc.ts";
import type { ResolvedRequirementDoc } from "../runtime/requirement-doc.ts";
import { currentMentionNote, windowContext as defaultWindowContext } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

function repositoryList(windowContext: () => Pick<WindowContextValue, "workspace">): string {
	let repos: WindowContextValue["workspace"]["repos"];
	try { repos = windowContext().workspace.repos; } catch { return ""; }
	if (repos.length === 0) return ["## 当前窗口没有接入 Git 仓库",
		"当前目录和它的子目录里都没有 Git 仓库，需要 repoId 的需求和后台代理工具都用不了，不要调用。"
		+ "用户想用这些功能时，请告诉用户把当前目录建成 Git 仓库（git init），或者在子目录里各自建成 Git 仓库，然后重新启动 pi。"].join("\n");
	return ["## 当前窗口已接入的仓库", "调用需要 repoId 的工具时使用下列编号，不要自行计算：",
		...repos.map((repo) => `- ${repo.path} → repoId ${repo.repoId}`)].join("\n");
}

const SOURCE = { project: "项目", user: "用户", package: "包内默认" } as const;

/** 每次开始回合都重新读取窗口所接仓库生效的需求文档规范，规范文件的修改对之后的草稿立即生效。 */
async function requirementDocGuide(dataRoot: () => string, windowContext: () => Pick<WindowContextValue, "workspace">): Promise<string> {
	let repos: WindowContextValue["workspace"]["repos"] = [];
	try { repos = windowContext().workspace.repos; } catch { /* 窗口未启动时仍按用户与包内规范说明写法 */ }
	const blocks = new Map<string, { repos: string[]; text: string }>();
	for (const repo of repos.length ? repos : [undefined]) {
		let text: string;
		try {
			const root = dataRoot();
			const doc: ResolvedRequirementDoc = repo ? await resolveRepositoryRequirementDoc(root, repo.path)
				: await resolveRequirementDoc({ agentDir: dirname(root), projectTrusted: false });
			text = [`来源：${doc.path}（${SOURCE[doc.source]}）`,
				`顶层板块依次为二级标题：${doc.spec.sections.map((section) => `\`## ${section.title} {#${section.id}}\``).join("、")}。` +
				`实现记录与验收记录由程序在归档时分别插在「${doc.spec.sections.find((s) => s.record === "implementation")!.title}」「${doc.spec.sections.find((s) => s.record === "acceptance")!.title}」板块末尾，草稿不写。`,
				doc.body.trim()].filter(Boolean).join("\n");
		} catch (error) {
			text = `规范无效，批准会被拒绝：${(error as Error).message}。请告诉用户修正该文件。`;
		}
		const block = blocks.get(text) ?? { repos: [], text };
		if (repo) block.repos.push(repo.path);
		blocks.set(text, block);
	}
	return [...blocks.values()].map((block) => ["## 需求文档规范", ...(blocks.size > 1 ? [`适用仓库：${block.repos.join("、")}`] : []), block.text].join("\n")).join("\n\n");
}

export default function rulesExtension(pi: ExtensionAPI, deps: { windowContext?: () => Pick<WindowContextValue, "workspace">; dataRoot?: string } = {}) {
	const rules = [loadPackageRules("rules"), loadPackageRules("shared")].join("\n\n");
	const windowContext = deps.windowContext ?? defaultWindowContext;
	const dataRoot = () => deps.dataRoot ?? defaultDataRoot(process.env);
	pi.on("before_agent_start", async (event) => {
		const extra = [rules, await requirementDocGuide(dataRoot, windowContext), repositoryList(windowContext), currentMentionNote()].filter(Boolean).join("\n\n");
		if (!extra) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
	});
}
