import { existsSync } from "node:fs";
import type { InstalledHost } from "./installed-host.ts";

const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r", ESCAPE = "\x1b";

export interface UserScript {
  /** 第一句：需求描述与授权范围。 */
  requirement: string;
  /** 需求草稿已保存、尚未批准时，用户的批准原话。 */
  approve: string;
  /** 已批准但还没有 PM 在跑时，用户催促继续的原话。 */
  proceed: string;
  /** 打开"待你验收"事项、读完报告后的验收原话。 */
  accept: string;
  /** 验收通过后需求仍未关闭时的原话。 */
  close: string;
}

export interface DriverLimits { userTurns: number; wallMs: number; sameMessage: number; /** 存在即按正常流程停止，便于人工中止且照常收尾。 */ stopFile?: string }

export type DriverEvent =
  | { type: "user"; text: string; at: number }
  | { type: "open-item"; label: string; at: number }
  | { type: "panel"; lines: string[]; at: number }
  | { type: "stop"; reason: string; at: number };

export type DriverOutcome = { status: "closed" | "stopped" | "reached"; reason: string };

/** 同一现场分段驱动：since 之前的消息属于前一段，不参与进展判断；until 为真即结束本段。 */
export interface DriveOptions {
  since?: number; until?: () => boolean | Promise<boolean>;
  /** PM 仍在运行时，主代理停下等用户而本段需求还没批准，就回批准台词（用于实施中追加需求）。 */
  approveWhileRunning?: boolean;
}

interface ToolResultView { toolName: string; isError: boolean; details: unknown; text: string }

function toolResults(host: InstalledHost, since: number): ToolResultView[] {
  return host.session.messages.slice(since).flatMap((message) => message.role === "toolResult"
    ? [{ toolName: message.toolName, isError: message.isError === true, details: message.details,
      text: message.content.map((block) => block.type === "text" ? block.text : "").join("") }] : []);
}

const has = (results: ToolResultView[], tool: string, pattern: RegExp) =>
  results.some((result) => result.toolName === tool && !result.isError && (pattern.test(JSON.stringify(result.details ?? null)) || pattern.test(result.text)));

/** 只依据用户看得到的东西（工具结果摘要、PM 面板）判断进展。 */
function progress(host: InstalledHost, since: number) {
  const results = toolResults(host, since);
  return {
    // 只认批准登记成功的回执；查询已生效需求的元数据也带 lifecycle=active，不能当作本段已批准
    approved: has(results, "one_company_user_interact", /"prodActivated":true/) || has(results, "one_company_requirement_manage", /"prodActivated":true/),
    closed: has(results, "one_company_workflow_manage", /"status":"closed"/),
    accepted: has(results, "one_company_user_interact", /"choice":"accept"/),
  };
}

const USER_PROMPT = `你在验收测试里扮演一个真实用户，和 AI 主代理对话推进需求。你的立场：需求以你最初的描述为准，不增加新要求；主代理给的选择题，选它标为推荐的那个，没标推荐就选它建议的那个，都没有就选改动最小、不扩大范围的那个；它要你补充的信息（如时长界限）按它的建议给出。
下面是主代理最后一条回复。判断它在等你做什么：
- 在等你回答问题或做选择：用一两句中文回答，写明具体选了什么，并要它写进草稿后再给你确认。
- 只在等你批准草稿、没有待你回答的问题：只输出 APPROVE。
只输出要发给主代理的话或 APPROVE，不要解释。`;

/** 主代理停下等用户时，由扮演用户的模型读它最后一条回复：有问题就按推荐作答；只等批准时返回 undefined，由调用方说批准台词。 */
export async function answerAsUser(host: InstalledHost): Promise<string | undefined> {
  const last = host.session.messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const text = last.content.map((block) => block.type === "text" ? block.text : "").join("").trim();
  if (!text) return undefined;
  const reply = await host.userModel(USER_PROMPT, text);
  return /^APPROVE\W*$/u.test(reply) || !reply ? undefined : reply;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTurn(host: InstalledHost, startedCount: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  // 事项卡片以 triggerTurn 异步插入，先等到新消息出现再等空闲
  while (host.session.messages.length === startedCount && Date.now() - started < timeoutMs) await sleep(200);
  await host.session.waitForIdle();
}

/**
 * 扮演用户：按固定台词和可见进展回应主代理，面板出现事项时像用户一样按 ↓ 和回车打开。
 * 碰到台词覆盖不到的事项、同一句话重复过多或超出轮数与时长即停止，并如实给出原因。
 */
export async function driveUser(host: InstalledHost, script: UserScript, limits: DriverLimits, record: (event: DriverEvent) => void, options: DriveOptions = {}): Promise<DriverOutcome> {
  const since = options.since ?? host.session.messages.length;
  const started = Date.now(), sent = new Map<string, number>(), opened = new Set<string>();
  let userTurns = 0, lastPanel = "";
  const stop = (reason: string): DriverOutcome => { record({ type: "stop", reason, at: Date.now() }); return { status: "stopped", reason }; };
  const say = async (text: string): Promise<DriverOutcome | undefined> => {
    const count = (sent.get(text) ?? 0) + 1;
    if (count > limits.sameMessage) return stop(`同一句用户台词已发 ${limits.sameMessage} 次仍无进展：${text}`);
    if (++userTurns > limits.userTurns) return stop(`用户轮数超过 ${limits.userTurns}`);
    sent.set(text, count);
    record({ type: "user", text, at: Date.now() });
    await host.session.prompt(text, { source: "interactive" });
    await host.session.waitForIdle();
    return undefined;
  };

  let result = await say(script.requirement);
  if (result) return result;
  for (;;) {
    if (Date.now() - started > limits.wallMs) return stop(`总时长超过 ${Math.round(limits.wallMs / 60_000)} 分钟`);
    if (limits.stopFile && existsSync(limits.stopFile)) return stop("发现停止文件，人工中止");
    await host.session.waitForIdle();
    if (options.until && await options.until()) return { status: "reached", reason: "已到达本段目标" };
    const state = progress(host, since);
    if (state.closed) return { status: "closed", reason: "需求已以完成关闭" };

    const lines = host.panelLines();
    const snapshot = lines.join("\n").replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "·").replace(/ · \d+(?:\.\d+)?s$| · \d+m\d+s| · \d+h\d+m\d+s/gm, "");
    if (snapshot !== lastPanel) { lastPanel = snapshot; record({ type: "panel", lines, at: Date.now() }); }
    const itemIndex = lines.findIndex((line) => line.includes("⚑"));
    if (itemIndex >= 0) {
      const label = lines[itemIndex]!.split("⚑ ")[1] ?? "";
      const key = `${label}@${lines.length}`;
      if (!opened.has(key)) {
        opened.add(key);
        record({ type: "open-item", label, at: Date.now() });
        const before = host.session.messages.length;
        // 面板光标会保留上次位置：先回到第一行，再按可选行（PM 行与事项行）数到目标
        const pmRows = lines.slice(0, itemIndex).filter((line) => /[├└]─ /.test(line)).length;
        const itemRows = lines.slice(0, itemIndex + 1).filter((line) => line.includes("⚑")).length;
        host.press(DOWN);
        for (let i = 0; i < 50; i++) host.press(UP);
        for (let i = 0; i < pmRows + itemRows - 1; i++) host.press(DOWN);
        host.press(ENTER);
        host.press(ESCAPE);
        await waitTurn(host, before, 30_000);
        if (label.includes("待你验收")) { result = await say(script.accept); if (result) return result; }
        else if (!label.includes("接手")) return stop(`出现台词未覆盖的事项：${label}`);
        continue;
      }
      // 待验收事项仍在、主代理已答完等用户（例如登记失败请用户再说一次），像真人一样再回一次验收
      if (label.includes("待你验收") && host.session.messages.at(-1)?.role === "assistant") {
        result = await say(script.accept); if (result) return result;
        continue;
      }
      await sleep(5_000);
      continue;
    }
    if (lines.length > 0) {
      if (options.approveWhileRunning && !state.approved && host.session.messages.at(-1)?.role === "assistant") {
        result = await say(await answerAsUser(host) ?? script.approve); if (result) return result; continue;
      }
      await sleep(5_000); continue;
    }

    // 需求原文只发一次；之后主代理停下等用户时，按真人会做的回答：未批准就确认草稿
    const next = !state.approved ? await answerAsUser(host) ?? script.approve : state.accepted ? script.close : script.proceed;
    result = await say(next);
    if (result) return result;
  }
}
