import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const LOGIN = [
  "export const CODE_TTL_MS = 5 * 60 * 1000;",
  "",
  "export function codeExpired(issuedAt: number, now: number): boolean {",
  "  return now - issuedAt > CODE_TTL_MS;",
  "}",
  "",
].join("\n");
const SAY = "我要给登录加验证码重发功能。先派 explore 在本地查清验证码多久过期、在哪定义，把查到的写进需求草稿";
const WAIT_MS = 30 * 60_000;

type Block = { type: string; name?: string; arguments?: Record<string, unknown>; text?: string };
type Message = { role: string; customType?: string; toolName?: string; content?: Block[] | string };

const actionOf = (args: Record<string, unknown>) => String((args.request as { action?: string } | undefined)?.action ?? args.action ?? "");

const textOf = (content: Message["content"]) => typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");

function facts(messages: Message[]) {
  const deliveries = messages.flatMap((m, index) => m.role === "custom" && m.customType === "one-company.explore-result"
    ? [{ index, runId: /"runId":"([0-9a-f-]{36})"/.exec(textOf(m.content))?.[1] }] : []);
  const delivered = deliveries[0]?.index ?? -1;
  const deliveredRunIds = new Set(deliveries.flatMap((d) => d.runId ? [d.runId] : []));
  const calls = messages.flatMap((message, index) => message.role === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((b) => b.type === "toolCall" ? [{ index, name: b.name!, args: b.arguments ?? {} }] : []) : []);
  const after = delivered < 0 ? [] : calls.filter((call) => call.index > delivered);
  const draft = after.find((call) => call.name === "one_company_requirement_manage" && ["create", "updateDraft"].includes(actionOf(call.args)));
  const sources = after.find((call) => call.name === "one_company_agent_manage" && call.args.action === "sources"
    && deliveredRunIds.has(String(call.args.runId)) && (draft === undefined || call.index < draft.index));
  return { deliveredRunIds: [...deliveredRunIds], delivered, sources: sources?.index, draft: draft?.index, calls: calls.map((call) => `${call.index}:${call.name}:${actionOf(call.args)}`) };
}

test.skipIf(!config || process.platform !== "darwin")("P22：explore 的检索结果送达后，主代理要把查到的写进需求草稿前，先用 agent_manage action=sources 按派出时的运行编号取来源核对", async () => {
  const point = await startMainPoint(config!, "p22", { seed: async ({ repo }) => {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "login.ts"), LOGIN);
    const git = (...args: string[]) => exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", ...args], { cwd: repo });
    await git("add", "src/login.ts");
    await git("commit", "-qm", "登录：验证码过期");
  } });
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say(SAY);
  const deadline = Date.now() + WAIT_MS;
  let seen = facts(point.host.session.messages as unknown as Message[]);
  while (Date.now() < deadline && seen.draft === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await point.host.session.waitForIdle();
    seen = facts(point.host.session.messages as unknown as Message[]);
  }
  judgement = seen;
  expect(seen.delivered, JSON.stringify(judgement)).toBeGreaterThanOrEqual(0);
  expect(seen.draft, JSON.stringify(judgement)).toBeDefined();
  expect(seen.sources, JSON.stringify(judgement)).toBeDefined();
}, WAIT_MS + 10 * 60_000);
