import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { dataRoot } from "../runtime/data-root.ts";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { deliverRequirement, gitDeliveryEnabled, setGitDeliveryEnabled } from "../runtime/git-delivery.ts";
import type { DeliveryFacts } from "../runtime/git-delivery.ts";
import { AdvisedError, toolFailure } from "../runtime/tool-failure.ts";
import { shapeIssue } from "../runtime/tool-request.ts";
import { windowContext } from "./lifecycle.ts";

export const GIT_DELIVER_TOOL = "pi_company_git_deliver";
const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const PARAMETERS = Type.Object({ repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }), requirementId: Type.String({ pattern: UUID_V7 }) }, { additionalProperties: false });
const ENABLE = "开启", DISABLE = "关闭";

interface CloseStatus {
  status: string; reason?: string;
  archive?: { path: string; archiveHash: string | null; status: string } | null;
  delivery?: { worktree: string; branch: string; codeHead: string } | null;
}
export interface GitDeliveryDeps { dataRoot: string; clients: () => WorkspaceClientsHandle }

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}
function showTool(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, enabled: boolean): void {
  const others = pi.getActiveTools().filter((name) => name !== GIT_DELIVER_TOOL);
  pi.setActiveTools(enabled ? [...others, GIT_DELIVER_TOOL] : others);
}

/** 可选业务 Git 交付：默认关闭，/pi-company:git-delivery 开启后主窗口才出现交付工具；确认与合并方式都由界面直接问用户。 */
export function registerGitDelivery(pi: ExtensionAPI, deps: () => GitDeliveryDeps): void {
  pi.registerTool({
    name: GIT_DELIVER_TOOL,
    label: "git_deliver",
    description: "把已完成并归档的需求交付到 Git：核对完成凭据后提交归档、推送需求分支并建立或复用 PR/MR；推送前和合并方式都由界面直接询问用户。",
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, _signal, _update, ctx: ExtensionContext) {
      const fail: (why: string, next: string) => never = (why, next) => { throw toolFailure(GIT_DELIVER_TOOL, new AdvisedError("git_deliver_failed", { why, next })); };
      if (!gitDeliveryEnabled(deps().dataRoot)) fail("Git 交付工具已关闭", "请用户用 /pi-company:git-delivery 命令开启后再交付");
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
      try { return result(await deliverRequirement(facts, { confirm: (title, message) => ctx.ui.confirm(title, message), select: (title, options) => ctx.ui.select(title, options) })); }
      catch (error) { throw toolFailure(GIT_DELIVER_TOOL, error); }
    },
  });
  pi.registerCommand("pi-company:git-delivery", {
    description: "开启或关闭可选的 Git 交付工具",
    handler: async (_args, ctx) => {
      const root = deps().dataRoot;
      const choice = await ctx.ui.select(`Git 交付工具当前${gitDeliveryEnabled(root) ? "已开启" : "已关闭"}`, [ENABLE, DISABLE]);
      if (choice === undefined) return;
      setGitDeliveryEnabled(root, choice === ENABLE);
      showTool(pi, choice === ENABLE);
      ctx.ui.notify(choice === ENABLE ? "Git 交付工具已开启" : "Git 交付工具已关闭", "info");
    },
  });
  pi.on("session_start", () => { showTool(pi, gitDeliveryEnabled(deps().dataRoot)); });
}

export default function gitDeliveryExtension(pi: ExtensionAPI): void {
  registerGitDelivery(pi, () => ({ dataRoot: dataRoot(process.env), clients: () => windowContext().clients }));
}
