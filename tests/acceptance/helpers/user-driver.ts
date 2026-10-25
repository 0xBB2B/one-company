import { existsSync } from "node:fs";
import { recommendedChoice } from "./installed-host.ts";
import type { InstalledHost } from "./installed-host.ts";

const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r", ESCAPE = "\x1b";

export interface UserScript {
  /** 第一句：需求描述与授权范围。 */
  requirement: string;
  /** 需求草稿已保存、尚未批准时，用户的批准原话。 */
  approve: string;
  /** 已批准但还没有 PM 在跑时，用户催促继续的原话。 */
  proceed: string;
  /** 打开"待验收"事项、读完报告后的验收原话。 */
  accept: string;
  /** 验收通过后需求仍未关闭时的原话。 */
  close: string;
  /** 打开"待裁决"的任务事项后的裁决原话；不给时碰到这类事项即停止。 */
  adjudicate?: string;
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

/** 只依据用户看得到的东西（工具结果摘要、状态面板）判断进展。 */
function progress(host: InstalledHost, since: number) {
  const results = toolResults(host, since);
  return {
    // 只认批准登记成功的回执；查询已生效需求的元数据也带 lifecycle=active，不能当作本段已批准
    approved: has(results, "one_company_user_interact", /"prdActivated":true/) || has(results, "one_company_requirement_manage", /"prdActivated":true/),
    closed: has(results, "one_company_workflow_manage", /"status":"closed"/),
    accepted: has(results, "one_company_user_interact", /"choice":"accept"/),
  };
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
  const started = Date.now(), sent = new Map<string, number>(), opened = new Map<string, { times: number; pmTurns: string }>();
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
      const seen = opened.get(key);
      // PM 改正后重交的接手理解或完成报告，面板上还是同一行字。PM 这一轮已停下（⏸）且轮数比上次打开时多，说明它又动过，
      // 主代理也已答完：像真人一样再打开一次。PM 还在跑时不重开，免得对同一份重复核对
      const pmTurns = /↻(\d+)/.exec(lines.join("\n"))?.[1] ?? "";
      const reopen = seen !== undefined && (label.includes("接手") || label.includes("待验收")) && seen.times < 6 && lines.some((line) => line.includes("⏸")) && pmTurns !== seen.pmTurns
        && host.session.messages.at(-1)?.role === "assistant";
      if (!seen || reopen) {
        opened.set(key, { times: (seen?.times ?? 0) + 1, pmTurns });
        record({ type: "open-item", label, at: Date.now() });
        // 主代理分析完会针对这个事项弹问答窗口：要登记决定的事项按台词作答；只作指示的事项（计划多次被拒、PM 停下）选主代理推荐的一项
        const instruction = /PM 计划 \d+ 次提交被拒/.test(label) || label.includes("PM 停下了");
        let instructed = false;
        host.answerPanelWindow = (window) => instruction ? (instructed = true, recommendedChoice(window)) : label.includes("待验收")
          ? (/验收通过/.test(script.accept) && window.choices.includes("验收通过") ? "验收通过" : { other: script.accept })
          : label.includes("PM 请求拆分") ? (window.choices.includes("让 PM 按新版本拆分") ? "让 PM 按新版本拆分" : undefined)
          : label.includes("待裁决") && script.adjudicate ? { other: script.adjudicate } : undefined;
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
        await host.session.waitForIdle();
        // 已在问答窗口里答过、事项随之消失的，不再重复说台词
        if (!host.panelLines().some((line) => line.includes(label))) continue;
        if (instruction) { if (!instructed) return stop(`主代理没有为事项弹出问答窗口：${label}`); }
        else if (label.includes("待验收")) { result = await say(script.accept); if (result) return result; }
        else if (label.includes("PM 请求拆分")) return stop(`请求拆分事项在窗口作答后仍在：${label}`);
        else if (label.includes("待裁决") && script.adjudicate) { result = await say(script.adjudicate); if (result) return result; }
        else if (!label.includes("接手")) return stop(`出现台词未覆盖的事项：${label}`);
        continue;
      }
      // 待验收事项仍在、主代理已答完等用户（例如登记失败请用户再说一次），像真人一样再回一次验收
      if (label.includes("待验收") && host.session.messages.at(-1)?.role === "assistant") {
        result = await say(script.accept); if (result) return result;
        continue;
      }
      await sleep(5_000);
      continue;
    }
    // 事项处理完从面板上消失后，同样文字的事项再出现就是新的一次，要重新打开
    opened.clear();
    if (lines.length > 0) {
      if (options.approveWhileRunning && !state.approved && host.session.messages.at(-1)?.role === "assistant") {
        result = await say(script.approve); if (result) return result; continue;
      }
      await sleep(5_000); continue;
    }

    // 需求原文只发一次；之后主代理停下等用户时，按真人会做的回答：未批准就确认草稿
    const next = !state.approved ? script.approve : state.accepted ? script.close : script.proceed;
    result = await say(next);
    if (result) return result;
  }
}
