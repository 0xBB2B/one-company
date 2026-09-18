import { basename, isAbsolute } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { UUID_V7_PATTERN } from "../runtime/database.ts";
import { LEGACY_METADATA_BYTES, LEGACY_METADATA_LIMIT } from "../runtime/workflow-tool.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DaemonClient, WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import type { Workspace } from "../runtime/identity.ts";
import { LEGACY_WORKFLOW_RETIRED } from "../runtime/decision-record-tool.ts";
import { windowContext } from "./lifecycle.ts";

export const AGENTS_PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("pause"), Type.Literal("stop"), Type.Literal("pauseAll"), Type.Literal("stopAll")]),
  runId: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LEGACY_METADATA_LIMIT })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });
export interface DispatchContext {
  execution?: { projectTrusted: boolean; model?: { provider: string; id: string }; thinking?: string };
  clients: WorkspaceClientsHandle; windowId: string; workspace: Workspace;
  gitTimeoutMs?: number; gitMaxBuffer?: number;
}
function result(text: string, isError = false, coverage?: Record<string, unknown>) { return { content: [{ type: "text" as const, text }], details: { isError, ...(coverage ? { coverage } : {}) } }; }
const ABORT_RECEIPT = "已停止等待，守护进程可能仍在执行，请用 agents list 核对";
function isAbortReceipt(error: unknown): boolean { return error instanceof Error && error.message === ABORT_RECEIPT; }
function callWithAbort(client: DaemonClient, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => finish(() => reject(new Error(ABORT_RECEIPT)));
    const timer = setTimeout(onAbort, 30_000);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.call(method, params).then((value) => finish(() => resolve(value)), () => finish(() => reject(new Error("守护进程调用失败，请查询状态核对"))));
  });
}
function targets(context: DispatchContext) {
  const repositories = new Map(context.workspace.repos.map((repo) => [repo.repoId, repo.path]));
  const seen = new Set<DaemonClient>();
  const found: Array<{ name: string; client: DaemonClient }> = [];
  for (const [repoId, path] of repositories) {
    const client = context.clients.forRepo(repoId);
    if (client && !seen.has(client)) { seen.add(client); found.push({ name: basename(path), client }); }
  }
  for (const client of context.clients.all()) if (!seen.has(client)) { seen.add(client); found.push({ name: "未知仓库", client }); }
  return found;
}
function stateLabel(state: unknown): string {
  const labels: Record<string, string> = { queued: "排队中", running: "运行中", pausing: "暂停中", paused: "已暂停", paused_network: "网络已暂停", waiting_answer: "等待作答中", completed: "已完成", failed: "已失败", stopped: "已停止", interrupted: "已中断" };
  return typeof state === "string" ? labels[state] ?? "未知状态" : "未知状态";
}
export function registerDispatchTools(pi: ExtensionAPI, context: () => DispatchContext): void {
  pi.registerTool({
    name: "pi_company_agents", label: "旧运行状态与停止", description: "只查询、暂停或停止旧运行；不提供派工、回复、转发和恢复", parameters: AGENTS_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action: string = params.action;
      if (!["list", "status", "pause", "stop", "pauseAll", "stopAll"].includes(action)) return result(LEGACY_WORKFLOW_RETIRED, true);
      if (!Value.Check(AGENTS_PARAMETERS, params)) return result("旧运行查询参数无效", true);
      try {
        const dctx = context();
        if (["list", "pauseAll", "stopAll"].includes(action)) {
          const method = action === "list" ? "runs.list" : `runs.${action}`;
          const selected = targets(dctx);
          const settled = await Promise.allSettled(selected.map(({ client }) => callWithAbort(client, method, action === "list" ? { limit: params.limit ?? LEGACY_METADATA_LIMIT, offset: 0 } : {}, signal)));
          if (action === "list") {
            const offset = params.offset ?? 0;
            const limit = params.limit ?? LEGACY_METADATA_LIMIT;
            const pages: Array<{ index: number; total: number; value: Record<string, unknown> }> = [];
            let unknown = 0;
            let aborted = false;
            let total = 0;
            for (let index = 0; index < settled.length; index++) {
              const entry = settled[index]!;
              if (entry.status !== "fulfilled") { unknown++; aborted ||= isAbortReceipt(entry.reason); continue; }
              if (!Array.isArray(entry.value.items)) { unknown++; continue; }
              const coverage = entry.value.coverage as Record<string, unknown> | undefined;
              const outside = coverage?.unconfirmedOutsidePage;
              if (!Number.isSafeInteger(outside) || Number(outside) < 0) unknown++;
              const count = entry.value.total ?? coverage?.total ?? (entry.value.items.length + (Number.isSafeInteger(outside) && Number(outside) >= 0 ? Number(outside) : 0));
              if (!Number.isSafeInteger(count) || Number(count) < entry.value.items.length || !Number.isSafeInteger(total + Number(count))) { unknown++; continue; }
              pages.push({ index, total: Number(count), value: entry.value });
              total += Number(count);
            }
            const lines: string[] = [];
            let validated = 0;
            let consumed = 0;
            const makeResult = () => {
              const remaining = Math.max(0, total - offset - consumed);
              const coverage = { returned: lines.length, validated, remaining, unknown, total, offset,
                nextOffset: remaining > 0 && consumed > 0 ? offset + consumed : null,
                unconfirmedOutsidePage: Math.max(0, total - lines.length), repositories: selected.length,
                truncated: remaining > 0 || unknown > 0, byteLimit: LEGACY_METADATA_BYTES };
              const notice = `展示=${lines.length}，页外未确认=${coverage.unconfirmedOutsidePage}，未知记录/仓库=${unknown}。状态不证明进程已停；分页不限制stopAll的停止范围。`;
              return result([...lines, notice, ...(aborted ? [ABORT_RECEIPT] : [])].join("\n"), unknown > 0 || aborted, coverage);
            };
            let skip = offset;
            for (const page of pages) {
              if (skip >= page.total) { skip -= page.total; continue; }
              const localOffset = skip; skip = 0;
              let value = page.value;
              if (localOffset > 0) {
                try { value = await callWithAbort(selected[page.index]!.client, "runs.list", { limit, offset: localOffset }, signal); }
                catch (error) { unknown++; aborted ||= isAbortReceipt(error); break; }
                if (value.total !== page.total) { unknown++; break; }
              }
              if (!Array.isArray(value.items)) { unknown++; break; }
              const name = selected[page.index]!.name;
              const label = name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name) ? name : "仓库";
              let examined = 0;
              for (const item of value.items) {
                const run = item as { id?: unknown; state?: unknown } | null;
                if (!run || typeof run.id !== "string" || !UUID_V7_PATTERN.test(run.id) || stateLabel(run.state) === "未知状态") { unknown++; consumed++; examined++; continue; }
                validated++;
                if (lines.length >= limit) break;
                lines.push(`${label}: ${run.id}(${stateLabel(run.state)})`);
                consumed++; examined++;
                // 核对真正返回的 JSON，包括转义、提示及覆盖字段。
                if (Buffer.byteLength(JSON.stringify(makeResult())) > LEGACY_METADATA_BYTES - 256) {
                  lines.pop(); consumed--; examined--; break;
                }
              }
              // 当前仓库未消费完时不能先展示后续仓库，再用一个全局 offset 跳过它。
              if (localOffset + examined < page.total) break;
            }
            return makeResult();
          }
          let failed = false;
          const parts = settled.map((entry, index) => {
            const name = selected[index]!.name;
            if (entry.status === "rejected") { failed = true; return `${name}: ${entry.reason instanceof Error ? entry.reason.message : "状态查询失败"}`; }
            const outcomes = entry.value.results as Array<{ confirmed?: boolean }> | undefined;
            const coverage = entry.value.coverage as Record<string, unknown> | undefined;
            const count = (key: string, fallback: number) => coverage && Number.isSafeInteger(coverage[key]) && Number(coverage[key]) >= 0 ? Number(coverage[key]) : fallback;
            const confirmed = count("confirmed", outcomes?.filter((item) => item.confirmed === true).length ?? 0);
            const unconfirmed = count("unconfirmed", outcomes?.filter((item) => item.confirmed !== true).length ?? 0) + count("shellUnconfirmed", 0);
            const unknown = count("unknown", outcomes ? 0 : 1);
            if (unconfirmed || unknown) failed = true;
            return `${name.length <= 128 ? name : "仓库"}: 已确认=${confirmed}，未确认=${unconfirmed}，未知=${unknown}`;
          });
          const shown: string[] = [];
          const makeResult = () => {
            const remaining = parts.length - shown.length;
            const notice = `仓库=${parts.length}，未展示=${remaining}，存在未确认或失败=${failed ? "是" : "否"}；停止范围不受展示分页限制。`;
            return result([...shown, notice].join("；"), failed, { remaining, truncated: remaining > 0, hasUnconfirmed: failed, byteLimit: LEGACY_METADATA_BYTES });
          };
          for (const part of parts) {
            if (shown.length >= LEGACY_METADATA_LIMIT) break;
            shown.push(part);
            if (Buffer.byteLength(JSON.stringify(makeResult())) > LEGACY_METADATA_BYTES) { shown.pop(); break; }
          }
          return makeResult();
        }
        if (!params.runId) return result("缺少 runId", true);
        const cwd = params.cwd ?? ctx.cwd;
        if (!isAbsolute(cwd)) return result("cwd 必须是绝对路径", true);
        const client = dctx.clients.forRepo((await repositoryIdentity(cwd)).repoId);
        if (!client) return result("仓库不在工作区内", true);
        const response = await callWithAbort(client, action === "status" ? "runs.get" : `runs.${action}`, { runId: params.runId }, signal);
        const state = action === "status" ? (response.run as { state?: unknown } | undefined)?.state : response.state;
        if (action === "status") return result(`登记状态：${stateLabel(state)}；旧状态不证明当前验收通过或进程已停止`);
        return result(response.confirmed === false ? "操作尚未确认完成，请核对真实进程" : stateLabel(state), response.confirmed === false);
      } catch (error) { return result(isAbortReceipt(error) ? ABORT_RECEIPT : "旧运行状态操作失败", true); }
    },
  });
}
export default function dispatchExtension(pi: ExtensionAPI): void {
  registerDispatchTools(pi, () => { const { clients, windowId, workspace } = windowContext(); return { clients, windowId, workspace }; });
}
