import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "../../runtime/database.ts";
import { HostAuthorizationManager } from "../../runtime/host-authorization.ts";
import { MainRequirementInteraction } from "../../runtime/main-requirement-interaction.ts";
import { createUserInteractTool } from "../../runtime/user-interact-tool.ts";
import type { createPmRunWorld } from "./run-manager-fixture.ts";
import { answeringUi } from "./window-host.ts";
import type { ShownWindow, WindowDecision } from "./window-host.ts";

type PmRunWorld = Awaited<ReturnType<typeof createPmRunWorld>>;

/**
 * 主窗口以宿主截获的原话登记用户裁决：解释器回复由 interpret 提供（默认压入脚本化模型队列）。
 */
export function mainAdjudication(w: PmRunWorld, cleanups: Array<() => unknown | Promise<unknown>>,
  interpret: (reply: string) => void = (reply) => { w.provider.queue.push({ type: "text", text: reply }); }) {
  const sessionId = uuidv7(), windowId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot: w.fixture.dataRoot });
  authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [w.fixture.repoId] });
  const registry = new ModelRegistry(w.runtime), model = w.runtime.getModels("team-model")[0]!;
  const windows: ShownWindow[] = [];
  let windowAnswer: WindowDecision = true;
  const ctx = { cwd: w.fixture.repositoryRoot, mode: "tui", hasUI: true, isProjectTrusted: () => false, modelRegistry: registry, model,
    ui: { notify: () => {}, confirm: () => { throw new Error("UI.confirm forbidden"); }, ...answeringUi((window) => { windows.push(window); return windowAnswer; }) },
    sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  const interaction = new MainRequirementInteraction({ mainThinking: () => "off", dataRoot: w.fixture.dataRoot, authorization,
    resolveHost: () => ({ windowId, sessionId, repositories: new Map([[w.fixture.repoId, { path: w.fixture.repositoryRoot }]]) }) });
  cleanups.push(() => { interaction.dispose(); authorization.shutdown(); });
  const tool = createUserInteractTool({ interaction });
  const entry = (references: string[], patch: Record<string, unknown> = {}) => ({ kind: "adjudication", basis: "explicit", resolution: "direct", candidateId: null,
    requestId: null, actions: [], conclusion: "用户的裁决", scope: "待裁决事项", references, supersedes: [], ...patch });
  /** 模拟用户在面板里打开事项后作答；opened=false 时不打开。 */
  async function adjudicate(text: string, entries: unknown[] | null, itemId: string, itemVersion: string, opened = true) {
    if (opened) { interaction.revokeInput(); interaction.noteOpenedItem({ repoId: w.fixture.repoId, requirementId: w.fixture.requirementId, itemId }); }
    interaction.captureInput({ source: "interactive", text }, ctx);
    if (entries) interpret(JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries }));
    const toolCallId = uuidv7();
    const result = await tool.execute(toolCallId, { request: { purpose: "adjudicate", action: "reply", repoId: w.fixture.repoId, requirementId: w.fixture.requirementId,
      operationId: uuidv7(), itemId, itemVersion } } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx);
    return result.details as Record<string, unknown>;
  }
  /** 主代理针对面板事项提问：窗口按 answerWindows 设定作答，回答成为当前输入。 */
  async function panelAsk(request: Record<string, unknown>) {
    const toolCallId = uuidv7();
    const result = await tool.execute(toolCallId, { request: { purpose: "panel-item", action: "ask", repoId: w.fixture.repoId, requirementId: w.fixture.requirementId,
      operationId: uuidv7(), ...request } } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx);
    return result.details as Record<string, unknown>;
  }
  /** 不截获新原话，直接以当前输入（例如窗口里的回答）登记裁决。 */
  async function register(itemId: string, itemVersion: string, entries: unknown[]) {
    interpret(JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries }));
    const toolCallId = uuidv7();
    const result = await tool.execute(toolCallId, { request: { purpose: "adjudicate", action: "reply", repoId: w.fixture.repoId, requirementId: w.fixture.requirementId,
      operationId: uuidv7(), itemId, itemVersion } } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx);
    return result.details as Record<string, unknown>;
  }
  return { entry, adjudicate, panelAsk, register, interaction, ctx, windows, answerWindows: (answer: WindowDecision) => { windowAnswer = answer; } };
}
