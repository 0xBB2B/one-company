import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/pi-ai";
import { TASKS } from "../../../src/modules/pm/plan-manage.ts";
import type { TaskRecord } from "../../../src/modules/pm/plan-manage.ts";
import { VERDICTS } from "../../../src/modules/pm/verdicts.ts";
import type { Verdict } from "../../../src/modules/pm/verdicts.ts";
import type { ScriptedReply } from "../../helpers/controlled-provider.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import type { AcceptanceConfig } from "./installed-host.ts";
import { call, NA, taskKey } from "./point-pm.ts";
import { createRealModel } from "./real-model.ts";

const exec = promisify(execFile);
const REVIEW_MAX_TURNS = 30;
const WORKER_WAIT_SECONDS = 300;
const REVIEW_WAIT_SECONDS = 800;
const SETUP_SECONDS = 100;
export const POINT_TIMEOUT_MS = (WORKER_WAIT_SECONDS + REVIEW_WAIT_SECONDS + SETUP_SECONDS) * 1_000;

export interface PitLocation { path: string; startLine: number; endLine: number }
/** alsoAt 是同一个坑的其他可命中位置，命中任意一处即算命中。 */
export interface SeededPit extends PitLocation { content: string; description: string; alsoAt?: PitLocation[] }
export type ReviewWorld = Awaited<ReturnType<typeof runSpecialistReview>>;

/** 在 content 里按行内文字定位起止行（从 1 数起，两端都含）。 */
export function span(path: string, content: string, from: string, to: string): PitLocation {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.includes(from)), end = lines.findIndex((line, index) => index >= start && line.includes(to));
  if (start < 0 || end < 0) throw new Error(`${path} 里找不到起止行：${from} … ${to}`);
  return { path, startLine: start + 1, endLine: end + 1 };
}

export function seed(path: string, content: string, from: string, to: string, description: string, alsoAt?: PitLocation[]): SeededPit {
  return { ...span(path, content, from, to), content: `${content}\n`, description, ...(alsoAt ? { alsoAt } : {}) };
}

const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n给样例项目新增几项小功能。\n## 功能 {#features}\n功能如下。\n" +
  "### 新增小功能 {#goal.login}\n样例项目新增若干小功能的代码。\n### 失败处理 {#scenario.failure}\n出错时给出明确的失败结果。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n新增的代码可读、可用。\n";

export async function runSpecialistReview(workerAgent: string, reviewerAgent: string, pits: SeededPit[],
  options: { cleanups: Array<() => unknown | Promise<unknown>>; config: AcceptanceConfig; evidence: string; support?: Record<string, string> }) {
  const w = await createPmRunWorld(options.cleanups, { body: BODY });
  const real = await createRealModel(w.fixture.root, options.config);
  options.cleanups.push(() => real.close(options.evidence));
  const workspace = w.fixture.state.read(w.fixture.requirementId).data.workspace!.path;
  const files = [...pits.map(({ path, content }) => ({ path, content })), ...Object.entries(options.support ?? {}).map(([path, content]) => ({ path, content }))];
  await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "--allow-empty", "-qm", "样例项目基线"], { cwd: workspace });

  const writePaths = [...new Set(files.map(({ path }) => `${path.split("/")[0]}/`))];
  const tasks = () => w.db((db) => db.list<TaskRecord>(TASKS).map((row) => row.data));
  const task = () => tasks().find((entry) => entry.key === "feature")!;
  const finished = async (runIds: string[], seconds: number) => {
    const states = async () => Promise.all(runIds.map(async (runId) => {
      const got = await w.runStore.get(runId);
      return `${runId}:${got.ok ? got.run.state : "missing"}`;
    }));
    for (let waited = 0; waited < seconds; waited++) {
      const got = await Promise.all(runIds.map((runId) => w.runStore.get(runId)));
      if (got.every((entry) => entry.ok && entry.run.state !== "running" && entry.run.state !== "queued")) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`等了 ${seconds} 秒运行仍未结束：${(await states()).join("、")}`);
  };

  const workerScript: ScriptedReply[] = [
    call("change_apply", { action: "apply", files: files.map(({ path, content }) => ({ path, baseHash: "absent", content })) }),
    call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "按需求新增了样例代码", findings: [] } }),
  ];
  const genericVerdict = call("result_submit", { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary: "改动范围与任务目标一致", findings: [] } });
  let turns = 0, genericSent = false;
  w.provider.awaitReply = async (request: Context) => {
    if (!taskKey(request)) return { type: "text", text: "收到" };
    const prompt = request.systemPrompt ?? "";
    if (!prompt.includes("审查任务：")) return workerScript.shift() ?? { type: "text", text: "完成" };
    if (prompt.includes("# 本任务加载的 skills")) return turns++ < REVIEW_MAX_TURNS ? real.answer(request) : { type: "text", text: "结束" };
    if (genericSent) return { type: "text", text: "完成" };
    genericSent = true;
    return genericVerdict;
  };

  await w.plan.execute({ action: "propose", tasks: [{ key: "feature", role: "worker", agent: workerAgent, agentReason: "按技术栈选专项 worker", goalUnitIds: ["goal.login", "scenario.failure"],
    constraintUnitIds: [], dependsOn: [], writePaths, blockedByQuestionIds: [], maxTurns: 20, objective: "按已批准需求给样例项目新增若干小功能的代码",
    passCriteria: ["新增代码满足需求", "出错时给出明确的失败结果"], scope: { in: ["新增小功能"], out: ["部署"] }, performance: NA }] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  const run = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task().taskId, retry: null });
  await finished([(run as { runId: string }).runId], WORKER_WAIT_SECONDS);
  if (task().status !== "awaiting_review") throw new Error(`worker 没有交出待审查的结果，任务状态：${task().status}`);

  const review = await w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task().taskId, retry: null, review: { maxTurns: REVIEW_MAX_TURNS } });
  if (!("runIds" in review) || review.failed.length > 0) throw new Error(`审查没有全部派出：${JSON.stringify(review)}`);
  await finished(review.runIds, REVIEW_WAIT_SECONDS);
  const reviewerAgents = await Promise.all(review.runIds.map(async (runId) => {
    const got = await w.runStore.get(runId);
    return { runId, agent: got.ok ? got.run.agent?.name : undefined };
  }));
  return { w, real, evidence: options.evidence, turns: () => turns, reviewer: reviewerAgent, reviewerAgents, task };
}

export function specialistVerdict(result: ReviewWorld): Verdict | undefined {
  const run = result.reviewerAgents.find((entry) => entry.agent === result.reviewer);
  return run && result.w.db((db) => db.list<Verdict>(VERDICTS).map((row) => row.data)).find((verdict) => verdict.runId === run.runId);
}

/** 每条阻塞意见的 targetRef 按「文件:行号」或「文件:起-止」解析（去掉首尾反引号；只写文件名时按末段匹配），文件对得上且行号全落在埋坑的行内即命中该坑。 */
export function pitCoverage(verdict: Verdict, pits: readonly SeededPit[]): Array<{ pit: SeededPit; hit: boolean; refs: string[] }> {
  const blocking = verdict.findings.filter((finding) => finding.kind === "blocking").map((finding) => finding.targetRef);
  const inside = (ref: string, where: PitLocation) => {
    const match = /^(.+?)[:#]L?(\d+)(?:\s*[-–]\s*L?(\d+))?/u.exec(ref.replace(/^`+|`+$/g, "").trim());
    if (!match) return false;
    const file = match[1]!.replace(/^\.\//, ""), start = Number(match[2]), end = Number(match[3] ?? match[2]);
    const sameFile = file.includes("/") ? file === where.path || file.endsWith(`/${where.path}`) : file === where.path.split("/").at(-1);
    return sameFile && start >= where.startLine && end <= where.endLine && start <= end;
  };
  return pits.map((pit) => {
    const refs = blocking.filter((ref) => [pit, ...(pit.alsoAt ?? [])].some((where) => inside(ref, where)));
    return { pit, hit: refs.length > 0, refs };
  });
}
