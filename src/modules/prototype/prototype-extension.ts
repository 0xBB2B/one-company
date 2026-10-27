import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { DaemonClient } from "../../core/host/daemon-client.ts";
import { decisionEntryText, confirmWindowContent, removeWindowContent, ABANDON_LABEL, ACCEPT_LABEL, REMOVE_LABEL } from "./prototype-windows.ts";
import type { PendingPrototype, PrototypeRecord, PrototypeRemoval } from "./prototype-windows.ts";
import { chooseOrWriteWindow, chooseWindow } from "../../core/host/question-window.ts";
import { id, object } from "../requirement/requirement-contracts.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import { AdvisedError, adviceOf, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { requestParameters } from "../../core/exec/tool-request.ts";
import { revokeCapturedInput, windowReady as defaultWindowReady } from "../../core/host/extension-lifecycle.ts";
import type { WindowContextValue } from "../../core/host/extension-lifecycle.ts";

const TOOL_NAME = "one_company_prototype";
const ENTRY_TYPE = "one-company.prototype-record";
const repoId = Type.String({ pattern: "^[0-9a-f]{64}$" });
const name = Type.String({ minLength: 1, maxLength: 40 });
const agentName = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

const PARAMETERS = requestParameters([
  object({ action: Type.Literal("designers"), repoId }),
  object({ action: Type.Literal("dispatch"), repoId, requirementId: id, name, brief: Type.String({ minLength: 1, maxLength: 4000 }),
    maxTurns: Type.Integer({ minimum: 1, maximum: 100 }), agent: Type.Optional(agentName) }),
  object({ action: Type.Literal("status"), repoId, requirementId: id }),
  object({ action: Type.Literal("confirm"), repoId, requirementId: id, name }),
  object({ action: Type.Literal("remove"), repoId, requirementId: id, name }),
]);

export interface PrototypeDeps {
  windowReady?: () => Promise<WindowContextValue>;
  openFile?: (path: string) => Promise<boolean>;
}

function openWithSystem(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("open", [path], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
  return sanitizeText(raw, 200).replace(/\s+/g, " ").trim() || "未知错误";
}

type FlowResult = "decided" | "undecided" | "no_ui" | "failed";
const OPINION_MAX_LENGTH = 4000;

const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });

export default function prototypeExtension(pi: ExtensionAPI, deps: PrototypeDeps = {}): void {
  const resolveWindowReady = deps.windowReady ?? defaultWindowReady;
  const openFile = deps.openFile ?? openWithSystem;
  let sessionId: string | undefined;
  let sessionContext: ExtensionContext | undefined;
  let unsubscribes: Array<() => void> = [];
  let queue: Promise<unknown> = Promise.resolve();

  pi.registerEntryRenderer<{ text: string }>(ENTRY_TYPE, (entry, _options, theme) => new Text(theme.fg("success", entry.data?.text ?? ""), 1, 0));

  const record = (entry: PrototypeRecord) => pi.appendEntry(ENTRY_TYPE, { text: decisionEntryText(entry) });
  const tell = (customType: string, content: string) => {
    revokeCapturedInput();
    pi.sendMessage({ customType, content, display: true }, { triggerTurn: true });
  };
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  async function confirmPrototypeFlow(client: DaemonClient, ctx: ExtensionContext, input: { requirementId: string; name: string }, signal?: AbortSignal): Promise<FlowResult> {
    if (!ctx.hasUI) return "no_ui";
    const pending = await client.call("prototypes.pending", input) as unknown as PendingPrototype;
    const opened = await openFile(pending.path);
    const answer = await chooseOrWriteWindow(ctx, { ...confirmWindowContent(pending, opened), otherMaxLength: OPINION_MAX_LENGTH }, signal);
    if (!answer) return "undecided";
    const choice = answer.other ? "rework" : answer.choices[0] === ACCEPT_LABEL ? "accept" : answer.choices[0] === ABANDON_LABEL ? "abandon" : undefined;
    if (!choice) return "undecided";
    try {
      await client.call("prototypes.decide", { ...input, version: pending.version, hash: pending.hash, choice, opinion: answer.other ?? null, note: null });
    } catch (error) {
      const advice = adviceOf(error);
      const voided = (error as { code?: unknown }).code === "file_changed";
      ctx.ui.notify(voided ? "文件在交稿后被改过，这一版已作废，决定没有登记" : `决定没有登记：${advice ? `${advice.why}。${advice.next}` : reasonOf(error)}`, "warning");
      if (voided) tell("one-company.prototype-voided", `原型「${pending.name}」第 ${pending.version} 版的文件在交稿后被改过，这一版已作废，用户的决定没有登记。可以用 one_company_prototype dispatch 重派设计师。`);
      return "failed";
    }
    record({ kind: choice, name: pending.name, version: pending.version });
    if (choice === "rework") {
      tell("one-company.prototype-rework", `用户对原型「${pending.name}」第 ${pending.version} 版选了返工。\n上一版文件：${pending.path}\n用户原话：${answer.other}\n请按这句原话用 one_company_prototype dispatch 重派设计师。`);
    }
    return "decided";
  }

  async function removePrototypeFlow(client: DaemonClient, ctx: ExtensionContext, input: { requirementId: string; name: string }, signal?: AbortSignal): Promise<FlowResult> {
    if (!ctx.hasUI) return "no_ui";
    const removal = await client.call("prototypes.removal", input) as unknown as PrototypeRemoval;
    if (await chooseWindow(ctx, removeWindowContent(removal), signal) !== REMOVE_LABEL) return "undecided";
    await client.call("prototypes.remove", { ...input, version: removal.version });
    record({ kind: "remove", name: removal.name, draftVersion: removal.draftVersion });
    return "decided";
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "prototype",
    description: "澄清阶段为有界面的需求出原型。designers 列出可用的原型设计师；dispatch 派一个设计师（名称、要画什么、轮数上限，可点名设计师定义），立即返回；交稿后程序自动打开文件并弹窗请用户确认，用户的决定只认窗口；status 查看该需求的原型看板；confirm 让程序重开某份待确认原型的确认窗口；remove 弹出窗口请用户确认把某份原型从草稿移除。",
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const step = toolStep(TOOL_NAME, rawParams);
      const fail = (code: string, why: string, next: string): never => { throw toolFailure(step, new AdvisedError(code, { why, next })); };
      if (!Value.Check(PARAMETERS, rawParams)) fail("invalid_shape", "参数不符合该动作的格式", "按工具说明改正该动作的字段后重试");
      const { request } = rawParams as { request: Static<typeof PARAMETERS>["request"] };
      const client = (await resolveWindowReady()).clients.forRepo(request.repoId);
      if (!client) fail("foreign_repo", "repoId 不是当前窗口工作区里的仓库", "改用当前工作区列出的仓库编号");
      try {
        switch (request.action) {
          case "designers": return textResult(await client!.call("prototypes.designers", {}));
          case "status": return textResult(await client!.call("prototypes.board", { requirementId: request.requirementId }));
          case "dispatch": {
            if (!ctx.model) fail("model_unavailable", "主会话当前没有选定模型，派出的设计师要沿用主会话的模型", "请用户先选定模型再派");
            const { action: _action, repoId: _repoId, agent, ...rest } = request;
            return textResult(await client!.call("prototypes.dispatch", { ...rest, ...(agent ? { agent } : {}),
              model: { provider: ctx.model!.provider, id: ctx.model!.id }, thinking: pi.getThinkingLevel() }));
          }
          case "confirm": {
            const outcome = await enqueue(() => confirmPrototypeFlow(client!, ctx, { requirementId: request.requirementId, name: request.name }, signal));
            return textResult({ decided: "用户已在窗口里作出决定，结果以程序记录为准", undecided: "用户暂未决定，原型仍等待确认",
              no_ui: "当前没有界面，用户没看到窗口，没有登记决定", failed: "用户在窗口里作了决定，但没能登记，提示已显示给用户" }[outcome]);
          }
          case "remove": {
            const outcome = await enqueue(() => removePrototypeFlow(client!, ctx, { requirementId: request.requirementId, name: request.name }, signal));
            return textResult(outcome === "decided" ? "用户确认移除，已从草稿移除" : outcome === "no_ui" ? "当前没有界面，用户没看到窗口，没有移除" : "用户选择保留，没有移除");
          }
        }
      } catch (error) { throw toolFailure(step, error); }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const current = ctx.sessionManager.getSessionId();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    sessionId = current;
    sessionContext = ctx;
    void resolveWindowReady().then((window) => {
      if (sessionId !== current) return;
      for (const repo of window.workspace.repos) {
        const client = window.clients.forRepo(repo.repoId);
        if (!client) continue;
        unsubscribes.push(client.subscribe("prototype.submitted", (data) => {
          const event = data as { parentSessionId?: unknown; requirementId?: unknown; name?: unknown };
          if (event.parentSessionId !== sessionId || typeof event.requirementId !== "string" || typeof event.name !== "string") return;
          const input = { requirementId: event.requirementId, name: event.name };
          void enqueue(() => confirmPrototypeFlow(client, sessionContext!, input))
            .catch((error: unknown) => sessionContext?.ui.notify(`原型确认窗口没能打开：${reasonOf(error)}`, "warning"));
        }));
        unsubscribes.push(client.subscribe("prototype.finished", (data) => {
          const event = data as { parentSessionId?: unknown; name?: unknown; version?: unknown; log?: unknown; reason?: unknown };
          if (event.parentSessionId !== sessionId || typeof event.name !== "string" || typeof event.reason !== "string") return;
          tell("one-company.prototype-finished", `原型「${event.name}」第 ${String(event.version)} 版的设计师已结束，原因：${event.reason}。按原因调整后可以用 one_company_prototype dispatch 重派。运行日志：${String(event.log)}（原因不够判断时，读这份会话记录查看设计师的思考与工具调用）`);
        }));
      }
    }).catch(() => {});
  });
  pi.on("session_shutdown", async () => { sessionId = undefined; for (const unsubscribe of unsubscribes.splice(0)) unsubscribe(); });
}
