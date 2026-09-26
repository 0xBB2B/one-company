import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { windowContext as defaultWindowContext } from "./lifecycle.ts";
import type { WindowContextValue } from "./lifecycle.ts";

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

function loadRules(): string {
	return readdirSync(rulesDir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => readFileSync(join(rulesDir, file), "utf8").trim())
		.join("\n\n");
}

function repositoryList(windowContext: () => Pick<WindowContextValue, "workspace">): string {
	let repos: WindowContextValue["workspace"]["repos"];
	try { repos = windowContext().workspace.repos; } catch { return ""; }
	if (repos.length === 0) return "";
	return ["## 当前窗口已接入的仓库", "调用需要 repoId 的工具时使用下列编号，不要自行计算：",
		...repos.map((repo) => `- ${repo.path} → repoId ${repo.repoId}`)].join("\n");
}

export default function rulesExtension(pi: ExtensionAPI, deps: { windowContext?: () => Pick<WindowContextValue, "workspace"> } = {}) {
	const rules = loadRules();
	const windowContext = deps.windowContext ?? defaultWindowContext;
	pi.on("before_agent_start", (event) => {
		const extra = [rules, repositoryList(windowContext)].filter(Boolean).join("\n\n");
		if (!extra) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
	});
}
