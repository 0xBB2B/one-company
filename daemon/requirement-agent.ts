import { resolve as resolvePath, sep } from "node:path";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Clock } from "../runtime/clock.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import type { RoleCatalogEntry } from "../runtime/roles.ts";
import type { RunStore } from "../runtime/run-store.ts";
import type { ShellRegistry } from "../runtime/shell-registry.ts";
import { LEGACY_WORKFLOW_RETIRED } from "../runtime/decision-record-tool.ts";
import type { RoleSessionGuards, RoleSessionHandle, RoleSessionState, RoleSessionStopOutcome } from "./role-session.ts";
import { bestEffortRealpath } from "./role-session.ts";

export const AGENT_PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("list"), Type.Literal("cancel")]),
  runId: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const ASK_PARAMETERS = Type.Object({}, { additionalProperties: false });
export const PROPOSE_SHAPE_PARAMETERS = Type.Object({}, { additionalProperties: false });

export interface ShapeTaskDeclaration {
  id: string; title: string; roles: string[]; dependsOn: string[]; writePaths: string[];
  waitFor?: { repo: string; requirement: string; stage: string };
}
export interface ShapeDeclaration {
  tasks: ShapeTaskDeclaration[];
  gates: { whiteboxReview: boolean; blackboxAcceptance: boolean };
  skipped: Array<{ gate: string; decisionId: string }>;
  acceptanceReport: string | null; decisionId: string;
}
export interface RequirementAgentDispatch {
  dispatchRole(input: { role: string; task: string; instructions?: string; writePaths: string[]; readPaths: string[]; reportPath?: string; waitFor?: ShapeTaskDeclaration["waitFor"] }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }>;
  status(runId: string): Promise<{ ok: true; state: string } | { ok: false; reason: string }>;
  wait(runId: string): Promise<{ ok: true; state: string } | { ok: false; reason: string }>;
  list(): Promise<Array<{ runId: string; role: string; task: string; state: string }>>;
  cancel(runId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}
export interface RequirementAgentRelay {
  ask(input: { question: string; kind?: "question" | "contract_change"; options?: Array<{ label: string; description: string }>; recommended?: string; repoId: string; requirement: string }, opts?: { signal?: AbortSignal }): Promise<string>;
}
export interface CreateRequirementAgentSessionOptions {
  dispatchContext?: import("../runtime/run-store.ts").DispatchSettingsContext;
  thinking?: string;
  mcp?: import("./role-session.ts").RoleSessionMcpOptions;
  verifyDelivery?: (runId: string, signal?: AbortSignal) => Promise<void>;
  dataRoot: string; repoId: string; requirement: string; cwd: string;
  role: RoleCatalogEntry; roleCatalog: RoleCatalogEntry[]; runtime: ModelRuntime;
  modelRef: { provider: string; id: string }; clock: Clock; shellRegistry: ShellRegistry;
  guards: RoleSessionGuards; networkGate: NetworkPauseGate;
  dispatch: RequirementAgentDispatch; relay: RequirementAgentRelay; runStore: RunStore; workspaceRepoIds: string[];
}
export type RequirementAgentHandleState = RoleSessionState | "waiting_answer";
export interface RequirementAgentHandle {
  events: RoleSessionHandle["events"];
  state(): RequirementAgentHandleState;
  prompt(text: string): void;
  injectSupplement(text: string): void;
  result(): Promise<unknown>;
  pause(): Promise<{ confirmed: boolean; reason?: string }>;
  resume(): Promise<void>;
  stop(): Promise<RoleSessionStopOutcome>;
  dispose(): void;
}
export type CreateRequirementAgentSessionResult =
  | { ok: false; reason: string }
  | { ok: true; reused: true; runId: string }
  | { ok: true; reused: false; runId: string; handle: RequirementAgentHandle };
interface RequirementAgentToolContext {
  baselineRequired?: boolean; assertSubmitSettled?: () => void;
  verifyDelivery?: (runId: string, signal?: AbortSignal) => Promise<void>;
  onStateChange?: (state: { stage: string }) => void;
  dataRoot: string; repoId: string; requirement: string; cwd: string;
  roleCatalog: RoleCatalogEntry[]; roleName: string; runId: string;
  runStore: RunStore; workspaceRepoIds: string[];
  dispatch: RequirementAgentDispatch; relay: RequirementAgentRelay; modelRef: { provider: string; id: string };
}
function retired(): { ok: false; reason: string } { return { ok: false, reason: LEGACY_WORKFLOW_RETIRED }; }

export function buildRequirementAgentPrompt(_input: { requirement: string; cwd: string; roleCatalog: RoleCatalogEntry[]; shape: ShapeDeclaration | null }): string {
  return LEGACY_WORKFLOW_RETIRED;
}
export function evaluateCrossRepoStage(_waitFor: { repo: string; requirement: string; stage: string }, _documentExists: boolean, _documentData: unknown): { ok: true } | { ok: false; reason: string } { return retired(); }
export async function awaitCrossRepoStage(_workspaceRepoIds: string[], _dataRoot: string, _waitFor: { repo: string; requirement: string; stage: string }): Promise<{ ok: true } | { ok: false; reason: string }> { return retired(); }
export function assertShapeAllows(_shape: ShapeDeclaration | null, _taskId: string, _role: string): { ok: true; task: ShapeTaskDeclaration } | { ok: false; reason: string } { return retired(); }

function isWithinRoot(candidateReal: string, rootReal: string): boolean { return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep); }
export async function checkWritePaths(input: { cwd: string; writePaths: string[]; declaredWritePaths: string[] }): Promise<{ ok: true } | { ok: false; violations: string[] }> {
  const cwdReal = await bestEffortRealpath(resolvePath(input.cwd));
  const declaredReal = await Promise.all(input.declaredWritePaths.map((path) => bestEffortRealpath(resolvePath(input.cwd, path))));
  const violations: string[] = [];
  for (const path of input.writePaths) {
    const real = await bestEffortRealpath(resolvePath(input.cwd, path));
    if (!isWithinRoot(real, cwdReal) || !declaredReal.some((declared) => isWithinRoot(real, declared))) violations.push(path);
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

/** 仅保留运行状态与取消；即使直接调用 execute 也不能使用 run/submit。 */
export function registerAgentTool(pi: ExtensionAPI, ctx: RequirementAgentToolContext): void {
  pi.registerTool({
    name: "pi_company_agent", label: "旧子运行状态", description: "查询或取消旧子运行，不接受派工和自行提交", parameters: AGENT_PARAMETERS,
    async execute(_toolCallId, params) {
      const action: string = params.action;
      if (!["list", "status", "wait", "cancel"].includes(action)) throw new Error(LEGACY_WORKFLOW_RETIRED);
      if (action === "list") {
        const items = (await ctx.dispatch.list()).map(({ runId, state }) => ({ runId, state }));
        return { content: [{ type: "text", text: JSON.stringify(items) }], details: { isError: false } };
      }
      if (!params.runId) throw new Error("缺少 runId");
      const result = action === "cancel" ? await ctx.dispatch.cancel(params.runId) : action === "status" ? await ctx.dispatch.status(params.runId) : await ctx.dispatch.wait(params.runId);
      if (!result.ok) throw new Error("旧运行状态不可用或尚未安全停止");
      return { content: [{ type: "text", text: "state" in result ? `状态: ${result.state}` : "已确认取消" }], details: { isError: false } };
    },
  });
}

/** 旧字符串转述授权工具不注册。 */
export function registerAskTool(_pi: ExtensionAPI, _ctx: RequirementAgentToolContext, _askState: { count: number }): void {}
export function registerProposeShapeTool(_pi: ExtensionAPI, _ctx: RequirementAgentToolContext): void {}
export async function createRequirementAgentSession(_options: CreateRequirementAgentSessionOptions): Promise<CreateRequirementAgentSessionResult> { return retired(); }
export async function resumeRequirementAgentSession(_options: CreateRequirementAgentSessionOptions & { runId: string }): Promise<{ ok: true; handle: RequirementAgentHandle } | { ok: false; reason: string }> { return retired(); }
