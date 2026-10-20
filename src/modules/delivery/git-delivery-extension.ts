import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceClientsHandle } from "../../core/host/daemon-client.ts";
import { deliverRequirement } from "./git-delivery.ts";
import { gitIn } from "../../core/exec/target-branch.ts";
import { dataRoot } from "../../core/storage/data-root.ts";
import { readAgentSettings } from "../settings/agent-settings.ts";
import type { DeliveryFacts } from "./git-delivery.ts";
import { AdvisedError, toolFailure } from "../../core/exec/tool-failure.ts";
import { shapeIssue } from "../../core/exec/tool-request.ts";
import { windowContext } from "../../core/host/extension-lifecycle.ts";
import { chooseWindow, confirmWindow } from "../../core/host/question-window.ts";

export const GIT_DELIVER_TOOL = "one_company_git_deliver";
const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const PARAMETERS = Type.Object({ repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }), requirementId: Type.String({ pattern: UUID_V7 }) }, { additionalProperties: false });

interface CloseStatus {
  status: string; reason?: string;
  archive?: DeliveryFacts["archive"];
  delivery?: { worktree: string; branch: string; codeHead: string } | null;
}
export interface GitDeliveryDeps { clients: () => WorkspaceClientsHandle }

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

/** 业务 Git 交付：主窗口始终有交付工具；确认与合并方式都由界面直接问用户。 */
export function registerGitDelivery(pi: ExtensionAPI, deps: () => GitDeliveryDeps): void {
  pi.registerTool({
    name: GIT_DELIVER_TOOL,
    label: "git_deliver",
    description: "按 Git 交付档位交付已完成并归档的需求：核对归档已在需求分支中后，远程档位推送并建立或复用 PR/MR，仅本地档位在本机合进主仓库当前分支；推送前和合并方式由界面直接询问用户。",
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, _signal, _update, ctx: ExtensionContext) {
      const fail: (why: string, next: string) => never = (why, next) => { throw toolFailure(GIT_DELIVER_TOOL, new AdvisedError("git_deliver_failed", { why, next })); };
      if (!Value.Check(PARAMETERS, rawParams)) fail(`参数不符合本工具的格式（${shapeIssue(PARAMETERS, rawParams)}）`, "按字段要求改正参数后重试");
      if (!ctx.hasUI) fail("推送前和选择合并方式都要在界面上直接问用户，当前会话没有界面", "在有界面的主窗口里再交付");
      const { repoId, requirementId } = rawParams as Static<typeof PARAMETERS>;
      const client = deps().clients().forRepo(repoId);
      if (!client) fail("repoId 不是当前窗口工作区里的仓库", "改用当前工作区列出的仓库编号");
      let close: CloseStatus;
      try { close = ((await client.call("workflow.manage", { requirementId, request: { action: "status" } })) as { result: { close: CloseStatus } }).result.close; }
      catch (error) { throw toolFailure(`${GIT_DELIVER_TOOL} 查询需求关闭状态这一步`, error); }
      if (!close.delivery) fail(`需求没有以完成（completed）关闭并归档，当前状态 ${close.status}，关闭原因 ${close.reason ?? "无"}`,
        "只有用户验收通过并以完成关闭的需求才能交付；需求已取消或拒绝时不要交付");
      const facts: DeliveryFacts = { requirementId, closed: close.status === "closed", reason: close.reason ?? "", archive: close.archive ?? null, ...close.delivery };
      try {
        const mainRoot = /^worktree (.+)$/mu.exec((await gitIn(facts.worktree, ["worktree", "list", "--porcelain"])).stdout)![1];
        const { gitDelivery, mergeMethods } = await readAgentSettings({ agentDir: dirname(dataRoot(process.env)), repositoryRoot: mainRoot, projectTrusted: ctx.isProjectTrusted() });
        return result(await deliverRequirement(facts, { confirm: (window) => confirmWindow(ctx, window), choose: (window) => chooseWindow(ctx, window) }, { mode: gitDelivery.mode, mergeMethods: mergeMethods.methods }));
      }
      catch (error) { throw toolFailure(GIT_DELIVER_TOOL, error); }
    },
  });
  pi.on("session_start", async () => {
    const active = pi.getActiveTools();
    if (!active.includes(GIT_DELIVER_TOOL)) pi.setActiveTools([...active, GIT_DELIVER_TOOL]);
  });
}

export default function gitDeliveryExtension(pi: ExtensionAPI): void {
  registerGitDelivery(pi, () => ({ clients: () => windowContext().clients }));
}
