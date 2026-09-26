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

export interface DriverLimits { userTurns: number; wallMs: number; sameMessage: number }

export type DriverEvent =
  | { type: "user"; text: string; at: number }
  | { type: "open-item"; label: string; at: number }
  | { type: "panel"; lines: string[]; at: number }
  | { type: "stop"; reason: string; at: number };

export type DriverOutcome = { status: "closed" | "stopped"; reason: string };

interface ToolResultView { toolName: string; isError: boolean; details: unknown }

function toolResults(host: InstalledHost): ToolResultView[] {
  return host.session.messages.flatMap((message) => message.role === "toolResult"
    ? [{ toolName: message.toolName, isError: message.isError === true, details: message.details }] : []);
}

const has = (results: ToolResultView[], tool: string, pattern: RegExp) =>
  results.some((result) => result.toolName === tool && !result.isError && pattern.test(JSON.stringify(result.details ?? null)));

/** 只依据用户看得到的东西（工具结果摘要、PM 面板）判断进展。 */
function progress(host: InstalledHost) {
  const results = toolResults(host);
  return {
    created: has(results, "pi_company_requirement_manage", /"requirementId"/),
    approved: has(results, "pi_company_user_interact", /"prodActivated":true/) || has(results, "pi_company_requirement_manage", /"lifecycle":"active"/),
    closed: has(results, "pi_company_workflow_manage", /"status":"closed"/),
    accepted: has(results, "pi_company_user_interact", /"choice":"accept"/),
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
export async function driveUser(host: InstalledHost, script: UserScript, limits: DriverLimits, record: (event: DriverEvent) => void): Promise<DriverOutcome> {
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
    await host.session.waitForIdle();
    const state = progress(host);
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
      await sleep(5_000);
      continue;
    }
    if (lines.length > 0) { await sleep(5_000); continue; }

    const next = !state.created ? script.requirement : !state.approved ? script.approve : state.accepted ? script.close : script.proceed;
    result = await say(next);
    if (result) return result;
  }
}
