import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { InstalledHost } from "./installed-host.ts";

const exec = promisify(execFile);

export function sumUsage(items: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }>) {
  return items.reduce((total, usage) => ({ input: total.input + usage.input, output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

export function mainSessionFacts(host: InstalledHost) {
  const assistant = host.session.messages.flatMap((message) => message.role === "assistant" ? [message] : []);
  const toolCalls = assistant.flatMap((message) => message.content.flatMap((block) => block.type === "toolCall"
    ? [`${block.name}${typeof (block.arguments as { action?: unknown }).action === "string" ? `:${(block.arguments as { action: string }).action}` : ""}`] : []));
  const errors = host.session.messages.flatMap((message) => message.role === "toolResult" && message.isError
    ? [{ tool: message.toolName, text: JSON.stringify(message.content).slice(0, 500) }] : []);
  return { turns: assistant.length, usage: sumUsage(assistant.map((message) => message.usage)), toolCalls, toolErrors: errors,
    models: [...new Set(assistant.map((message) => `${message.provider}/${message.model}`))] };
}

export async function killUnder(root: string): Promise<void> {
  const listed = (await exec("ps", ["-axo", "pid=,command="])).stdout.split("\n");
  const pids = listed.flatMap((line) => { const match = /^\s*(\d+)\s+(.*)$/.exec(line); return match && match[2]!.includes(root) && Number(match[1]) !== process.pid ? [Number(match[1])] : []; });
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ } }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
}

export async function waitMissing(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await stat(path); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export interface QuestionRecord {
  question: string; answer: string;
  toolCalls: Array<{ name: string; args: unknown }>; toolResults: Array<{ name: string; isError: boolean; text: string }>;
  elapsedMs: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 在主会话里逐题提问，按题记下回答、本题的工具调用与结果、耗时和用量；不替模型判断对错。 */
export async function askQuestions(host: InstalledHost, questions: readonly string[], onAnswered: (record: QuestionRecord) => void | Promise<void>): Promise<QuestionRecord[]> {
  const records: QuestionRecord[] = [];
  for (const question of questions) {
    const start = host.session.messages.length, started = Date.now();
    await host.session.prompt(question, { source: "interactive" });
    await host.session.waitForIdle();
    const turn = host.session.messages.slice(start);
    const assistant = turn.flatMap((message) => message.role === "assistant" ? [message] : []);
    const record: QuestionRecord = {
      question,
      answer: assistant.at(-1)?.content.map((block) => block.type === "text" ? block.text : "").join("") ?? "",
      toolCalls: assistant.flatMap((message) => message.content.flatMap((block) => block.type === "toolCall" ? [{ name: block.name, args: block.arguments }] : [])),
      toolResults: turn.flatMap((message) => message.role === "toolResult"
        ? [{ name: message.toolName, isError: message.isError === true, text: message.content.map((block) => block.type === "text" ? block.text : "").join("").slice(0, 4_000) }] : []),
      elapsedMs: Date.now() - started, usage: sumUsage(assistant.map((message) => message.usage)),
    };
    records.push(record);
    await onAnswered(record);
  }
  return records;
}
