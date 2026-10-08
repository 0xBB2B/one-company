import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";

// 用法：node tests/acceptance/measure.ts <验收输出目录>；按 M9-AC11、AC18 登记的方法从证据目录取数，报告写到 <目录>/measure.md
const root = process.argv[2];
if (!root || !existsSync(root)) throw new Error("须给出验收输出目录");

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
type Message = { role: string; content?: unknown; sections?: unknown; toolName?: string; toolCallId?: string; isError?: boolean; usage?: Usage; customType?: string; timestamp?: number };
type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };
type Run = { id: string; kind?: string; role?: string; agentName?: string; agentSource?: string; agentSkills?: string[]; usage?: Usage; turns?: number; state?: string };

const isPm = (run: Run) => run.agentName === "pm" || run.kind === "requirement";
const tokens = (usage: Usage | undefined) => (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
const blocks = (message: Message) => (Array.isArray(message.content) ? message.content : []) as Block[];
const textOf = (message: Message) => typeof message.content === "string" ? message.content : blocks(message).map((block) => block.text ?? "").join("");
const actionOf = (block: Block) => String(block.arguments?.action ?? (block.arguments?.request as { action?: string } | undefined)?.action ?? "");
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN; };

function logOf(path: string): Array<{ at: number; message: Message }> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; timestamp?: string; message?: Message })
    .filter((entry) => entry.type === "message" && entry.message).map((entry) => ({ at: Date.parse(entry.timestamp!), message: entry.message! }));
}

const evidences = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => /(^|\/)report(-[a-z]+)?\.json$/u.test(path))
  .map((path) => dirname(join(root, path))).filter((dir, index, all) => all.indexOf(dir) === index).sort();

const intakeRows: string[] = [], exploreRows: string[] = [], groupRows: string[] = [], limits = new Set<string>();
const intakeStats: Record<string, number[]> = {}, exploreStats: Record<string, number[]> = {}, groupStats: Record<string, Record<string, number[]>> = {};
const push = (stats: Record<string, number[]>, key: string, value: number) => { (stats[key] ??= []).push(value); };

for (const dir of evidences) {
  const name = relativeName(dir);
  const scenario = basename(dir).replace(/-20\d\d-.*$/u, "");
  const reports = readdirSync(dir).filter((file) => /^report(-[a-z]+)?\.json$/u.test(file)).map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as { runs?: Run[]; elapsedMs?: number });
  const runs = [...new Map(reports.flatMap((report) => report.runs ?? []).map((run) => [run.id, run])).values()];
  const logPath = (id: string) => join(dir, "runs", `${id}.jsonl`);

  // 接手：PM 从开工到收到核对通过
  for (const pm of runs.filter((run) => isPm(run) && existsSync(logPath(run.id)))) {
    const log = logOf(logPath(pm.id));
    const passed = log.findIndex(({ message }) => message.role === "user" && textOf(message).includes("主代理已核对通过你的接手理解"));
    const phase = passed < 0 ? log : log.slice(0, passed + 1);
    const calls = phase.flatMap(({ message }) => message.role === "assistant" ? blocks(message).filter((block) => block.type === "toolCall") : []);
    const reads = phase.filter(({ message }) => message.role === "toolResult" && message.toolName === "one_company_requirement_manage").reduce((sum, { message }) => sum + textOf(message).length, 0);
    const submits = calls.filter((block) => block.name === "one_company_user_interact" && actionOf(block) === "ask").length;
    const seconds = phase.length ? Math.round((phase.at(-1)!.at - phase[0]!.at) / 1000) : NaN;
    const used = phase.reduce((sum, { message }) => sum + (message.role === "assistant" ? tokens(message.usage) : 0), 0);
    intakeRows.push(`| ${name} | ${pm.id.slice(0, 13)} | ${passed < 0 ? "未通过" : "通过"} | ${seconds} | ${used} | ${calls.length} | ${reads} | ${submits} |`);
    if (passed >= 0) { push(intakeStats, "用时秒", seconds); push(intakeStats, "token", used); push(intakeStats, "工具调用", calls.length); push(intakeStats, "读需求字数", reads); push(intakeStats, "提交次数", submits); }
  }

  // 检索：主窗口卡片与 PM 运行记录里的 explore
  const parents = readdirSync(dir).filter((file) => /^main-session(-[a-z]+)?\.json$/u.test(file))
    .map((file) => ({ parent: "main", messages: JSON.parse(readFileSync(join(dir, file), "utf8")) as Message[] }));
  for (const pm of runs.filter((run) => isPm(run) && existsSync(logPath(run.id)))) parents.push({ parent: "PM", messages: logOf(logPath(pm.id)).map(({ message }) => message) });
  const reported = new Set<string>();
  for (const { parent, messages } of parents) {
    messages.forEach((message, index) => {
      const card = message.customType === "one-company.explore-result" ? textOf(message) : message.role === "user" && textOf(message).includes("\"kind\":\"explore-report\"") ? textOf(message) : null;
      if (!card) return;
      const report = JSON.parse(card.slice(card.indexOf("{"))) as { runId: string; outcome: string; research?: { sources?: Array<{ path?: string }>; truncation?: { truncated?: boolean }; failures?: unknown[]; notFound?: unknown[] } };
      if (reported.has(report.runId)) return;
      reported.add(report.runId);
      const cited = new Set((report.research?.sources ?? []).flatMap((source) => source.path ? [basename(source.path)] : []));
      // 回读：卡片之后到下一句用户原话之前，父代理读了被引用文件几次、多少字
      let rereads = 0, rereadChars = 0;
      const pending = new Map<string, boolean>();
      for (const next of messages.slice(index + 1)) {
        if (next.role === "user" && !textOf(next).includes("explore-report")) break;
        for (const block of blocks(next)) if (block.type === "toolCall" && ["read", "grep"].includes(block.name ?? "")) {
          const target = String(block.arguments?.path ?? "");
          if ([...cited].some((file) => target.endsWith(file))) pending.set(block.id ?? "", true);
        }
        if (next.role === "toolResult" && pending.has(next.toolCallId ?? "")) { rereads += 1; rereadChars += textOf(next).length; }
      }
      const log = existsSync(logPath(report.runId)) ? logOf(logPath(report.runId)) : [];
      if (!log.length) limits.add(`${name}：explore ${report.runId.slice(0, 13)} 没有会话日志，只记卡片里的结论`);
      const firstInput = log.filter(({ message }) => message.role === "system" || message.role === "user").slice(0, 2).reduce((sum, { message }) => sum + JSON.stringify(message.sections ?? message.content ?? "").length, 0);
      const assistants = log.filter(({ message }) => message.role === "assistant");
      const toolCalls = assistants.reduce((sum, { message }) => sum + blocks(message).filter((block) => block.type === "toolCall").length, 0);
      const toolChars = log.filter(({ message }) => message.role === "toolResult").reduce((sum, { message }) => sum + textOf(message).length, 0);
      const seconds = log.length ? Math.round((log.at(-1)!.at - log[0]!.at) / 1000) : NaN;
      const used = assistants.reduce((sum, { message }) => sum + tokens(message.usage), 0);
      const resultChars = report.research ? JSON.stringify(report.research).length : 0;
      exploreRows.push(`| ${name} | ${parent} | ${report.runId.slice(0, 13)} | ${report.outcome} | ${seconds} | ${used} | ${assistants.length} | ${firstInput} | ${toolCalls} | ${toolChars} | ${resultChars} | ${report.research?.truncation?.truncated ? "是" : "否"} | ${report.research?.failures?.length ?? 0} | ${report.research?.notFound?.length ?? 0} | ${rereads} | ${rereadChars} |`);
      push(exploreStats, "用时秒", seconds); push(exploreStats, "token", used); push(exploreStats, "轮数", assistants.length); push(exploreStats, "工具返回字数", toolChars); push(exploreStats, "回读次数", rereads);
    });
  }
  for (const run of runs.filter((entry) => entry.role === "one-company.explore" && !reported.has(entry.id))) limits.add(`${name}：explore ${run.id.slice(0, 13)} 有运行记录但父代理里没找到结果卡片`);

  // 默认与专业路径：只统计单需求闭环的证据（零自定义与 AC18 对照组）
  if (!["zero-custom", "ac18-nomatch", "ac18-match", "ui-worker"].includes(scenario)) continue;
  const pmLog = runs.filter((run) => isPm(run) && existsSync(logPath(run.id))).flatMap((run) => logOf(logPath(run.id)));
  const catalogIds = new Set(pmLog.flatMap(({ message }) => blocks(message).filter((block) => block.type === "toolCall" && block.name === "one_company_agent_manage" && actionOf(block) === "catalog").map((block) => block.id)));
  const catalogChars = pmLog.filter(({ message }) => message.role === "toolResult" && catalogIds.has(message.toolCallId)).reduce((sum, { message }) => sum + textOf(message).length, 0);
  const dispatchIds = new Set(pmLog.flatMap(({ message }) => blocks(message).filter((block) => block.type === "toolCall" && block.name === "one_company_agent_manage" && actionOf(block) === "dispatch").map((block) => block.id)));
  const dispatchErrors = pmLog.filter(({ message }) => message.role === "toolResult" && dispatchIds.has(message.toolCallId) && message.isError).length;
  const workers = runs.filter((run) => run.role === "one-company.worker");
  const definitions = [...new Set(workers.map((run) => `${run.agentName}（${run.agentSource}${run.agentSkills?.length ? `，skill ${run.agentSkills.join("、")}` : ""}）`))].join("；");
  let skillHashes = "库未保存", attempts = NaN;
  const db = join(dir, "data.db");
  if (existsSync(db) && statSync(db).size > 0) {
    const raw = new DatabaseSync(db, { readOnly: true });
    const hashes = raw.prepare("SELECT data FROM records WHERE namespace = 'runs'").all().flatMap((row) => {
      const data = JSON.parse(String(row.data)) as { agent?: { skills?: Array<{ name: string; hash: string }> } };
      return (data.agent?.skills ?? []).map((skill) => `${skill.name}:${skill.hash.slice(0, 12)}`);
    });
    attempts = raw.prepare("SELECT data FROM records WHERE namespace = 'tasks'").all().reduce((sum, row) => sum + ((JSON.parse(String(row.data)) as { attempts?: unknown[] }).attempts?.length ?? 0), 0);
    raw.close();
    skillHashes = [...new Set(hashes)].join("、") || "无";
  } else limits.add(`${name}：证据里没有本机库，skill 加载指纹不可测`);

  const byRole = (role: string) => runs.filter((run) => run.role === role || (role === "pm" && isPm(run))).reduce((sum, run) => sum + tokens(run.usage), 0);
  const elapsed = Math.round((reports[0]?.elapsedMs ?? NaN) / 1000);
  groupRows.push(`| ${name} | ${scenario} | ${catalogIds.size} | ${catalogChars} | ${definitions || "无 worker 运行"} | ${skillHashes} | ${dispatchErrors} | ${Number.isNaN(attempts) ? "不可测" : attempts} | ${byRole("pm")} | ${byRole("one-company.worker")} | ${byRole("one-company.reviewer")} | ${byRole("one-company.qa")} | ${elapsed} |`);
  const group = (groupStats[scenario] ??= {});
  push(group, "目录调用", catalogIds.size); push(group, "派工失败", dispatchErrors); push(group, "worker token", byRole("one-company.worker")); push(group, "总 token", runs.reduce((sum, run) => sum + tokens(run.usage), 0)); push(group, "总用时秒", elapsed);
}

function relativeName(dir: string) { return dir.slice(root.length).replace(/^\/+/u, "") || basename(dir); }
const summary = (stats: Record<string, number[]>) => Object.entries(stats).map(([key, values]) => `${key} 中位 ${median(values)}、最大 ${Math.max(...values)}（${values.length} 个样本）`).join("；") || "无样本";

const report = [
  "# M9-AC11、AC18 测量报告", "",
  `证据目录：${root}。token 为运行记录与会话日志里模型返回的实际用量（输入、输出、缓存读写之和）；字数为工具返回或结果文字的字符数，不当作 token。只报实测数，不计算节省比例。`, "",
  "## 接手（PM 开工到核对通过）", "",
  "| 证据 | PM 运行 | 结果 | 用时秒 | token | 工具调用 | 读需求字数 | 提交理解次数 |", "|---|---|---|---|---|---|---|---|", ...intakeRows, "", `汇总：${summary(intakeStats)}`, "",
  "## 检索", "",
  "| 证据 | 父代理 | 运行 | 结局 | 用时秒 | token | 轮数 | 首次输入字数 | 工具调用 | 工具返回字数 | 结果字数 | 截断 | 失败 | 未找到 | 父代理回读次数 | 回读字数 |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|", ...exploreRows, "", `汇总：${summary(exploreStats)}`,
  exploreRows.some((row) => row.includes("| PM |")) ? "" : "PM 派出的 explore 在这批样本里没有出现，PM 路径的检索不可测。", "",
  "## 默认与专业路径", "",
  "| 证据 | 组 | 目录调用 | 目录返回字数 | worker 定义 | skill 加载指纹 | 派工失败 | 任务尝试数 | PM token | worker token | reviewer token | QA token | 总用时秒 |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|", ...groupRows, "",
  ...Object.entries(groupStats).map(([scenario, stats]) => `- ${scenario}：${summary(stats)}`), "",
  "## 不可测与限制", "", ...(limits.size ? [...limits].map((line) => `- ${line}`) : ["- 无"]), "",
];
writeFileSync(join(root, "measure.md"), report.join("\n"));
console.log(report.join("\n"));
