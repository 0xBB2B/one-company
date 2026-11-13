import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { DaemonClient } from "../../core/host/daemon-client.ts";
import { decisionEntryText, confirmWindowContent, removeWindowContent, ABANDON_LABEL, ACCEPT_LABEL, REMOVE_LABEL, optionLabel } from "./prototype-windows.ts";
import type { PendingPrototype, PrototypeRecord, PrototypeRemoval } from "./prototype-windows.ts";
import { chooseOrWriteWindow, chooseWindow } from "../../core/host/question-window.ts";
import { optionLetter } from "../requirement/requirement-prototypes.ts";
import type { PickedOption } from "../requirement/requirement-prototypes.ts";
import { id, object } from "../requirement/requirement-contracts.ts";
import { currentLine, currentLineRepos, recordLineAnchor } from "../requirement/line-anchors.ts";
import { uuidv7 } from "../../core/storage/database.ts";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import { AdvisedError, adviceOf, toolFailure, toolStep } from "../../core/exec/tool-failure.ts";
import { leanToolResult } from "../../core/exec/tool-result.ts";
import { requestParameters } from "../../core/exec/tool-request.ts";
import { revokeCapturedInput, windowReady as defaultWindowReady } from "../../core/host/extension-lifecycle.ts";
import type { WindowContextValue } from "../../core/host/extension-lifecycle.ts";
import { mutedItem, requirementLabel, shortId, summaryLine, toolCard } from "../../core/host/tool-card.ts";
import type { CardRow, CardSegment, CardSpec } from "../../core/host/tool-card.ts";

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

function prototypeLine(entry: CardRow): CardSegment[] {
  const { inFlight, draft, approved, lastEnded } = entry;
  const status = inFlight ? `第 ${inFlight.version} 版${inFlight.status === "awaiting" ? "等你确认" : "设计中"}`
    : entry.removed ? "已从草稿移除"
    : draft ? `第 ${draft.version} 版已通过`
    : approved ? `第 ${approved.version} 版已随需求批准`
    : lastEnded ? `第 ${lastEnded.version} 版没交稿：${lastEnded.reason}`
    : "还没交稿";
  return [{ text: entry.name, shrink: true }, { text: "：" }, { text: status, shrink: true }];
}

const said: CardSpec["summary"] = (details) => [details as unknown as string];
const PROTOTYPE_CARDS = {
  actionOf: (args: unknown) => (args as { request?: { action?: string } } | undefined)?.request?.action,
  cards: {
    designers: { title: "列出原型设计师", object: () => undefined, summary: (details) => [`${details.items.length} 位设计师`] },
    dispatch: { title: "派出原型设计", object: (request) => request.name,
      summary: (details, theme) => [summaryLine(theme, "已派出", `第 ${details.version} 版`, `编号 ${shortId(details.runId)}`)] },
    status: { title: "原型状态", object: (request) => requirementLabel(request.requirementId),
      summary: (details, theme) => {
        const entries = details.entries as CardRow[];
        if (entries.length === 0) return ["还没有原型"];
        const lines = entries.slice(0, 2).map(prototypeLine);
        if (entries.length > 2) lines[1] = [...lines[1]!, mutedItem(theme, `还有 ${entries.length - 2} 个原型`)];
        return lines;
      } },
    confirm: { title: "确认原型", object: (request) => request.name, summary: said },
    remove: { title: "删除原型", object: (request) => request.name, summary: said },
  },
} satisfies { actionOf: (args: unknown) => string | undefined; cards: Record<string, CardSpec> };

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

type FlowResult = "decided" | "abandoned" | "undecided" | "no_ui" | "failed";
const OPINION_MAX_LENGTH = 4000;

const keep = (source: unknown, keys: string[]): Record<string, unknown> => {
  const from = (source ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));
};
const NOTE_KEYS = ["note", "options", "picked"];

function prototypeEntryView(entry: Record<string, unknown>): Record<string, unknown> {
  const version = (file: unknown) => file === null || file === undefined ? file : keep(file, ["version", ...NOTE_KEYS]);
  const view = keep(entry, ["name", "lastVersion", "removed", "lastOpinion"]);
  if (entry.lastEnded !== undefined) view.lastEnded = entry.lastEnded === null ? null : keep(entry.lastEnded, ["reason"]);
  if (entry.draft !== undefined) view.draft = version(entry.draft);
  if (entry.approved !== undefined) view.approved = version(entry.approved);
  const inFlight = entry.inFlight as Record<string, unknown> | null | undefined;
  if (inFlight !== undefined) view.inFlight = inFlight === null ? null : { ...keep(inFlight, ["version", "status"]), ...keep(inFlight.file, NOTE_KEYS) };
  return view;
}

function prototypeView(action: string, value: unknown): unknown {
  const full = value as Record<string, unknown>;
  if (action === "designers") return { items: (full.items as Array<Record<string, unknown>>).map((item) => keep(item, ["name", "description"])) };
  if (action === "status") return { entries: (full.entries as Array<Record<string, unknown>>).map(prototypeEntryView) };
  return value;
}

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

  const lineOf = (ctx: ExtensionContext, requirementId: string) => currentLine(ctx.sessionManager)[requirementId] ?? [];

  async function confirmPrototypeFlow(client: DaemonClient, ctx: ExtensionContext, input: { repoId: string; requirementId: string; name: string }, signal?: AbortSignal): Promise<FlowResult> {
    if (!ctx.hasUI) return "no_ui";
    const { repoId, ...target } = input;
    const line = lineOf(ctx, input.requirementId);
    const pending = await client.call("prototypes.pending", { ...target, line }) as unknown as PendingPrototype;
    const opened = await openFile(pending.path);
    const answer = await chooseOrWriteWindow(ctx, { ...confirmWindowContent(pending, opened), otherMaxLength: OPINION_MAX_LENGTH }, signal);
    if (!answer) return "undecided";
    const label = answer.choices[0];
    const index = pending.options.findIndex((optionName, i) => optionLabel(optionLetter(i), optionName) === label);
    const chosen: PickedOption | null = index >= 0 ? { letter: optionLetter(index), name: pending.options[index]! } : null;
    const choice = chosen || label === ACCEPT_LABEL ? "accept" : label === ABANDON_LABEL ? "abandon" : answer.other ? "opinion" : undefined;
    if (!choice) return "undecided";
    const opinion = choice === "opinion" ? answer.other ?? null : null;
    const anchor = uuidv7();
    try {
      await client.call("prototypes.decide", { ...target, line: lineOf(ctx, input.requirementId), anchor, version: pending.version, hash: pending.hash, choice, opinion, option: chosen?.letter ?? null });
      recordLineAnchor(pi, { repoId, requirementId: input.requirementId, anchor });
    } catch (error) {
      const advice = adviceOf(error);
      const voided = (error as { code?: unknown }).code === "file_changed";
      if ((error as { code?: unknown }).code === "design_changed") {
        ctx.ui.notify(advice?.why ?? reasonOf(error), "warning");
        tell("one-company.prototype-design-changed", `原型「${pending.name}」第 ${pending.version} 版没有通过：DESIGN.md 在你确认时被改过。在窗口里选「其他（自己输入）」写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次；可以用 one_company_prototype confirm 重开确认窗口。`);
        return "failed";
      }
      ctx.ui.notify(voided ? "文件在交稿后被改过，这一版已作废，决定没有登记" : `决定没有登记：${advice ? `${advice.why}。${advice.next}` : reasonOf(error)}`, "warning");
      if (voided) tell("one-company.prototype-voided", `原型「${pending.name}」第 ${pending.version} 版的文件在交稿后被改过，这一版已作废，用户的决定没有登记。可以用 one_company_prototype dispatch 重派设计师。`);
      return "failed";
    }
    if (choice === "accept") record({ kind: "accept", name: pending.name, version: pending.version, ...(chosen ? { picked: chosen } : {}) });
    else record({ kind: choice, name: pending.name, version: pending.version });
    if (chosen) {
      pi.sendMessage({ customType: "one-company.prototype-choice", display: false,
        content: `用户通过了原型「${pending.name}」第 ${pending.version} 版，选了方案 ${chosen.letter}：${chosen.name}，其余方案不做。\n这个选择已和这一版原型一起存下，批准需求后会交给 PM 和子代理。需求正文和它对不上时，按它改正文。` }, { deliverAs: "nextTurn" });
    }
    if (choice === "opinion") {
      tell("one-company.prototype-opinion", [
        `用户对原型「${pending.name}」第 ${pending.version} 版提了意见，这一版仍在等用户确认。`,
        `文件：${pending.path}`,
        "用户原话：",
        answer.other,
        "先弄清用户想要什么：可能是提问、要改原型，也可能是要改需求正文；拿不准就先用 one_company_user_interact ask 问用户。是提问就回答；要改需求正文就用 updateDraft 改草稿；处理完都用 one_company_prototype confirm 重开这份原型的确认窗口。要改原型时，先把你理解的修改要点告诉用户，问要不要按这些重出一版；用户明确同意后，才用 one_company_prototype dispatch 重派设计师，把确认过的修改要点写进要画什么。设计师会拿到这一版文件和用户原话，重派后这一版作废。",
      ].join("\n"));
    }
    return choice === "abandon" ? "abandoned" : "decided";
  }

  async function removePrototypeFlow(client: DaemonClient, ctx: ExtensionContext, input: { repoId: string; requirementId: string; name: string }, signal?: AbortSignal): Promise<FlowResult> {
    if (!ctx.hasUI) return "no_ui";
    const { repoId, ...target } = input;
    const line = lineOf(ctx, input.requirementId);
    const removal = await client.call("prototypes.removal", { ...target, line }) as unknown as PrototypeRemoval;
    if (await chooseWindow(ctx, removeWindowContent(removal), signal) !== REMOVE_LABEL) return "undecided";
    const anchor = uuidv7();
    await client.call("prototypes.remove", { ...target, line: lineOf(ctx, input.requirementId), anchor, version: removal.version });
    recordLineAnchor(pi, { repoId, requirementId: input.requirementId, anchor });
    record({ kind: "remove", name: removal.name, draftVersion: removal.draftVersion });
    return "decided";
  }

  const card = toolCard(PROTOTYPE_CARDS);

  async function confirmAwaitingOnLine(window: WindowContextValue, ctx: ExtensionContext): Promise<void> {
    const repoOf = currentLineRepos(ctx.sessionManager);
    for (const [requirementId, line] of Object.entries(currentLine(ctx.sessionManager))) {
      const repoId = repoOf[requirementId]!, client = window.clients.forRepo(repoId);
      if (!client) continue;
      const board = await client.call("prototypes.board", { requirementId, line }) as unknown as { entries: Array<{ name: string; inFlight: { status: string } | null }> };
      for (const entry of board.entries) {
        if (entry.inFlight?.status !== "awaiting") continue;
        await enqueue(() => confirmPrototypeFlow(client, ctx, { repoId, requirementId, name: entry.name }));
      }
    }
  }
  const confirmAwaitingAfterSwitch = (window: Promise<WindowContextValue>, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    void window.then((ready) => confirmAwaitingOnLine(ready, ctx).catch((error: unknown) => ctx.ui.notify(`原型确认窗口没能打开：${reasonOf(error)}`, "warning")),
      () => undefined);
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "prototype",
    description: "澄清阶段为有界面的需求出原型。designers 列出可用的原型设计师；dispatch 派一个设计师（名称、要画什么、轮数上限，可点名设计师定义），立即返回；交稿后程序自动打开文件并弹窗请用户确认，用户的决定只认窗口；status 查看该需求的原型看板；confirm 让程序重开某份待确认原型的确认窗口；remove 弹出窗口请用户确认把某份原型从草稿移除。",
    parameters: PARAMETERS,
    executionMode: "sequential",
    renderCall: (args, theme, context) => card.renderCall(args, theme, context),
    renderResult: (result, options, theme, context) => card.renderResult(result, options, theme, context),
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const step = toolStep(TOOL_NAME, rawParams);
      const fail = (code: string, why: string, next: string): never => { throw toolFailure(step, new AdvisedError(code, { why, next })); };
      if (!Value.Check(PARAMETERS, rawParams)) fail("invalid_shape", "参数不符合该动作的格式", "按工具说明改正该动作的字段后重试");
      const { request } = rawParams as { request: Static<typeof PARAMETERS>["request"] };
      const client = (await resolveWindowReady()).clients.forRepo(request.repoId);
      if (!client) fail("foreign_repo", "repoId 不是当前窗口工作区里的仓库", "改用当前工作区列出的仓库编号");
      try {
        switch (request.action) {
          case "designers": { const full = await client!.call("prototypes.designers", {}); return leanToolResult(full, prototypeView("designers", full)); }
          case "status": { const full = await client!.call("prototypes.board", { requirementId: request.requirementId, line: lineOf(ctx, request.requirementId) }); return leanToolResult(full, prototypeView("status", full)); }
          case "dispatch": {
            if (!ctx.model) fail("model_unavailable", "主会话当前没有选定模型，派出的设计师要沿用主会话的模型", "请用户先选定模型再派");
            const { action: _action, repoId, agent, ...rest } = request;
            const anchor = uuidv7();
            const full = await client!.call("prototypes.dispatch", { ...rest, ...(agent ? { agent } : {}), line: lineOf(ctx, request.requirementId), anchor,
              model: { provider: ctx.model!.provider, id: ctx.model!.id }, thinking: pi.getThinkingLevel() });
            recordLineAnchor(pi, { repoId, requirementId: request.requirementId, anchor });
            return leanToolResult(full, full);
          }
          case "confirm": {
            const outcome = await enqueue(() => confirmPrototypeFlow(client!, ctx, { repoId: request.repoId, requirementId: request.requirementId, name: request.name }, signal));
            const text = ({ decided: "用户已在窗口里作出决定，结果以程序记录为准", undecided: "用户暂未决定，原型仍等待确认",
              abandoned: "用户按 Esc 放弃了这一版，它不再挡住批准", no_ui: "当前没有界面，用户没看到窗口，没有登记决定", failed: "用户在窗口里作了决定，但没能登记，提示已显示给用户" })[outcome];
            return leanToolResult(text, text);
          }
          case "remove": {
            const outcome = await enqueue(() => removePrototypeFlow(client!, ctx, { repoId: request.repoId, requirementId: request.requirementId, name: request.name }, signal));
            const text = (outcome === "decided" ? "用户确认移除，已从草稿移除" : outcome === "no_ui" ? "当前没有界面，用户没看到窗口，没有移除" : "用户选择保留，没有移除");
            return leanToolResult(text, text);
          }
        }
      } catch (error) { throw toolFailure(step, error); }
    },
  });

  pi.on("session_tree", (_event, ctx) => {
    sessionContext = ctx;
    confirmAwaitingAfterSwitch(resolveWindowReady(), ctx);
  });
  pi.on("session_start", async (event, ctx) => {
    const current = ctx.sessionManager.getSessionId();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    sessionId = current;
    sessionContext = ctx;
    if (["startup", "resume", "fork"].includes(event.reason)) confirmAwaitingAfterSwitch(resolveWindowReady(), ctx);
    void resolveWindowReady().then((window) => {
      if (sessionId !== current) return;
      for (const repo of window.workspace.repos) {
        const client = window.clients.forRepo(repo.repoId);
        if (!client) continue;
        unsubscribes.push(client.subscribe("prototype.submitted", (data) => {
          const event = data as { requirementId?: unknown; name?: unknown; dispatchAnchor?: unknown };
          if (typeof event.requirementId !== "string" || typeof event.name !== "string" || typeof event.dispatchAnchor !== "string") return;
          const { requirementId, name, dispatchAnchor } = event;
          const ctx = sessionContext;
          if (!ctx || !lineOf(ctx, requirementId).includes(dispatchAnchor)) return;
          void enqueue(() => confirmPrototypeFlow(client, ctx, { repoId: repo.repoId, requirementId, name }))
            .catch((error: unknown) => ctx.ui.notify(`原型确认窗口没能打开：${reasonOf(error)}`, "warning"));
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
