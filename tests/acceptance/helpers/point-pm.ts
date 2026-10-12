import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { ControlledProvider, ScriptedReply } from "../../helpers/controlled-provider.ts";
import type { AcceptanceConfig } from "./installed-host.ts";
import type { RealModel } from "./real-model.ts";

export const NA = { applicable: false as const, reason: "无性能影响" };
export const taskKey = (request: Context) => /任务：([A-Za-z0-9._-]+)（/.exec(request.systemPrompt ?? "")?.[1];
export const messageText = (value: unknown) => JSON.stringify(value ?? "");
export const call = (name: string, input: Record<string, unknown>): ScriptedReply => ({ type: "toolcall", name: `one_company_${name}`, input });

export async function pointEvidence(config: AcceptanceConfig, name: string): Promise<string> {
  const evidence = join(config.output, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  return evidence;
}

export interface RealPmOptions {
  /** 第一次为真的那个 PM 请求起交给真实模型。 */
  startWhen(request: Context): boolean;
  /** 为真或用满轮数后，PM 的请求改回脚本回复，判断点结束。 */
  stopWhen(): boolean;
  maxTurns: number;
  evidence: string;
  /** 子代理的请求按任务 key 回复；不给时一律回"完成"。 */
  subagent?(key: string, request: Context): ScriptedReply | undefined | Promise<ScriptedReply | undefined>;
}

/** 判断点之前 PM 由脚本回"收到"，判断点之后由真实模型回答；真实模型停下不再调用工具时判断点也结束。 */
export function realPm(provider: ControlledProvider, real: RealModel, options: RealPmOptions) {
  let turns = 0, started = false, done = false;
  provider.awaitReply = async (request) => {
    const key = taskKey(request);
    if (key) return (await options.subagent?.(key, request)) ?? { type: "text", text: "完成" };
    if (!started && !options.startWhen(request)) return { type: "text", text: "收到" };
    if (!started) {
      started = true;
      await writeFile(join(options.evidence, "decision-request.json"), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    }
    if (done || turns >= options.maxTurns || options.stopWhen()) { done = true; return { type: "text", text: "收到" }; }
    turns += 1;
    const reply = await real.answer(request);
    if (reply.type === "message" && reply.message.stopReason !== "toolUse") done = true;
    return reply;
  };
  return {
    turns: () => turns,
    /** 等到判断点结束，最多 limitSeconds 秒。 */
    async settled(limitSeconds = 600) {
      for (let waited = 0; !done && waited < limitSeconds; waited++) await new Promise((resolve) => setTimeout(resolve, 1_000));
      return done;
    },
  };
}
