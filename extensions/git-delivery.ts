import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { dataRoot } from "../runtime/data-root.ts";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { deliverRequirement, gitDeliveryEnabled, setGitDeliveryEnabled } from "../runtime/git-delivery.ts";
import type { DeliveryFacts } from "../runtime/git-delivery.ts";
import { windowContext } from "./lifecycle.ts";

export const GIT_DELIVER_TOOL = "pi_company_git_deliver";
const UUID_V7 = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const PARAMETERS = Type.Object({ repoId: Type.String({ pattern: "^[0-9a-f]{64}$" }), requirementId: Type.String({ pattern: UUID_V7 }) }, { additionalProperties: false });
const ENABLE = "开启", DISABLE = "关闭";

interface CloseStatus {
  status: string; reason?: string;
  archive?: { path: string; prodHash: string; status: string } | null;
  delivery?: { worktree: string; branch: string; codeHead: string } | null;
}
export interface GitDeliveryDeps { dataRoot: string; clients: () => WorkspaceClientsHandle }

function result(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { isError } };
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
      if (!gitDeliveryEnabled(deps().dataRoot)) return result({ code: "git_delivery_disabled" }, true);
      if (!Value.Check(PARAMETERS, rawParams)) return result({ code: "invalid_shape" }, true);
      if (!ctx.hasUI) return result({ code: "ui_required" }, true);
      const { repoId, requirementId } = rawParams as Static<typeof PARAMETERS>;
      const client = deps().clients().forRepo(repoId);
      if (!client) return result({ code: "foreign_repo" }, true);
      let close: CloseStatus;
      try { close = ((await client.call("workflow.manage", { requirementId, request: { action: "status" } })) as { result: { close: CloseStatus } }).result.close; }
      catch (error) { return result({ code: (error as { code?: string }).code ?? "status_unavailable" }, true); }
      if (!close.delivery) return result({ status: "rejected", reason: "requirement_not_completed" }, true);
      const facts: DeliveryFacts = { requirementId, closed: close.status === "closed", reason: close.reason ?? "", archive: close.archive ?? null, ...close.delivery };
      try { return result(await deliverRequirement(facts, { confirm: (title, message) => ctx.ui.confirm(title, message), select: (title, options) => ctx.ui.select(title, options) })); }
      catch (error) { return result({ code: "git_delivery_failed", message: (error as Error).message }, true); }
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
