import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { readPlanIn } from "../../runtime/plan-manage.ts";
import type { RequirementRecord } from "../../runtime/requirement-contracts.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { RunRecord } from "../../runtime/run-store.ts";
import { askQuestions, killUnder, mainSessionFacts, sumUsage, waitMissing } from "./helpers/evidence.ts";
import type { QuestionRecord } from "./helpers/evidence.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { driveUser } from "./helpers/user-driver.ts";
import type { DriverEvent, DriverOutcome, UserScript } from "./helpers/user-driver.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();
const AUTHORIZE = "请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。";
const ACCEPT = { accept: "完成报告我看过了，验收通过。", close: "验收已通过，请以完成关闭这个需求。" };

const SPRINT: UserScript = {
  requirement: "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。不做体力值，不改跳跃。" + AUTHORIZE,
  approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。", proceed: "继续：创建工作区并派出 PM 开始实施。", ...ACCEPT,
};
const JUMP: UserScript = {
  requirement: "我要调整跳跃：按住空格越久跳得越高，最长按住 0.3 秒，超过按 0.3 秒算；松开空格时如果还在上升，上升速度立即减半；空中仍然不能再次起跳。不改快跑和水平移动。" + AUTHORIZE,
  approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。", proceed: "继续：创建工作区并派出 PM 开始实施。", ...ACCEPT,
};
const ANIMATION: UserScript = {
  requirement: "给当前的跳跃需求追加跳跃动画：一个函数根据竖直速度、是否着地和着地后经过的帧数返回姿态名。规则：在空中且竖直速度不小于起跳速度的 0.8 倍为「起跳」，" +
    "在空中其余向上为「上升」，在空中竖直速度不大于 0 为「下落」，着地且着地后不到 6 帧为「落地」，着地且满 6 帧返回「站立」。其余要求不变。请更新需求草稿给我确认，确认后继续按原授权实施。",
  approve: "更新后的需求草稿我看过了，批准这一版，继续实施。", proceed: "继续按批准的新版本实施。",
  accept: "先不验收：我刚追加了跳跃动画，请按追加批准后的版本继续做完再交报告。", close: ACCEPT.close,
};
/** 需要读活动需求正文的题放在绑定了跳跃需求的会话里问。 */
const BOUND_QUESTIONS = ["正在进行的跳跃动画需求要求哪些姿态？", "当前需求最新批准的版本比上一版改了什么？"];
/** 其余题放在没有绑定任何需求的新会话里问；序号对应用户定的 ①②③⑤⑦⑧⑨⑩⑪。 */
const FRESH_QUESTIONS = [
  "角色的水平速度现在是怎么算的？代码在哪？",
  "go 目录里的 Greet 函数做什么，谁调用它？",
  "角色在空中能不能再跳一次？依据是哪段代码和哪个测试？",
  "把现在所有进行中的需求内容都列给我看。",
  "已经完成的快跑需求当时的验收标准是什么？",
  "快跑和跳跃的实现有没有相互影响？请依据代码和测试回答。",
  "快跑的测试正式通过了吗？",
  "这次改动让移动计算快了多少？",
  "参考 docs/prod 里的旧需求，帮我写一个新需求：角色可以蹲下。",
];
const REFUSE_BODY = new Set([3, 4, 8]);
const HOST_READ_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

type Phase = "sprint" | "jump" | "animation";

test.skipIf(!config || process.platform !== "darwin")("M9-AC2/AC3/AC11：同一安装现场快跑完成关闭并合并，跳跃需求实施中追加动画，随后在绑定与未绑定会话分别提问", async () => {
  const cfg = config!;
  const evidence = join(cfg.output, `progressive-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const record = (event: DriverEvent | { type: "phase"; phase: string; at: number }) => { void appendFile(join(evidence, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 }); };
  const save = (name: string, value: unknown) => writeFile(join(evidence, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

  const root = await mkdtemp(join(tmpdir(), "m9-"));
  const agentDir = join(root, "agent"), home = join(root, "home"), dataRoot = join(agentDir, "one-company");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "ONE_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  const hosts: InstalledHost[] = [];
  let socketPath: string | undefined;
  const started = Date.now();
  try {
    const installed = await installProduct(root);
    const repo = await createSampleProject(root);
    const { repoId } = await repositoryIdentity(repo);
    await mkdir(home, { recursive: true });
    await copyCredentials(cfg.credentialsDir, agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_TELEMETRY = "0";
    process.env.ONE_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(dataRoot, repoId);
    const open = async () => { const host = await startInstalledHost({ installed, repo, agentDir, config: cfg }); hosts.push(host); return host; };
    const requirements = () => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<RequirementRecord>("requirements").map((row) => row.data));
    const active = () => requirements().find((item) => item.lifecycle === "active");
    const plan = (requirementId: string) => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => readPlanIn(db, requirementId));
    const runs = async () => {
      const store = new RunStore({ dataRoot, repoId, daemonStartedAt: new Date().toISOString() });
      return (await Promise.all((await store.list({ limit: 500 })).items.map(async (item) => { const got = await store.get(item.id); return got.ok ? [got.run] : []; }))).flat() as RunRecord[];
    };
    const snapshot = async (phase: Phase, host: InstalledHost, outcome: DriverOutcome) => {
      const all = await runs(), current = active();
      await save(`report-${phase}.json`, { phase, outcome, elapsedMs: Date.now() - started, main: mainSessionFacts(host),
        runs: all.map((run) => ({ id: run.id, kind: run.kind, role: run.role, requirement: run.requirement, state: run.state, stateReason: run.stateReason,
          stopCause: run.stopCause, turns: run.turns, usage: run.usage, parentRunId: run.parentRunId })),
        runUsage: sumUsage(all.map((run) => run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
        requirements: requirements().map((item) => ({ requirementId: item.requirementId, lifecycle: item.lifecycle, revision: item.revision, close: item.close, docSpec: item.docSpec?.skillHash })),
        plan: current ? plan(current.requirementId) : null, modelEvents: host.modelEvents, notifications: host.notifications });
      await save(`main-session-${phase}.json`, JSON.stringify(host.session.messages, null, 2));
      await save(`side-calls-${phase}.json`, JSON.stringify(host.sideCalls, null, 2));
    };
    const limits = (minutes: number) => ({ userTurns: 15, wallMs: minutes * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") });

    record({ type: "phase", phase: "sprint", at: Date.now() });
    const a = await open();
    const sprint = await driveUser(a, SPRINT, limits(90), record);
    await snapshot("sprint", a, sprint);
    expect(sprint, JSON.stringify(sprint)).toMatchObject({ status: "closed" });
    await a.close();
    const sprintId = requirements().find((item) => item.close?.reason === "completed")!.requirementId;
    const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    const entry = worktrees.split("\n\n").slice(1).join("\n\n");
    const worktree = /^worktree (.+)$/m.exec(entry)![1]!, branch = /^branch refs\/heads\/(.+)$/m.exec(entry)![1]!;
    // 交付工具未开启：用户在外部提交归档，再把完成的需求分支合回主分支，代码与归档随之进入主分支
    const user = ["-c", "user.name=sample", "-c", "user.email=sample@localhost"];
    await exec("git", ["add", "docs/prod"], { cwd: worktree });
    await exec("git", [...user, "commit", "-qm", "快跑需求归档"], { cwd: worktree });
    await exec("git", [...user, "merge", "--no-ff", "-m", "合并快跑", branch], { cwd: repo });
    const archives = await readdir(join(repo, "docs", "prod"));
    const sprintArchive = await readFile(join(repo, "docs", "prod", archives.find((name) => name.startsWith(sprintId))!), "utf8");
    await save("archive-sprint.md", sprintArchive);

    record({ type: "phase", phase: "jump", at: Date.now() });
    const b = await open();
    const jump = await driveUser(b, JUMP, limits(45), record, { until: () => {
      const current = active(); return Boolean(current && plan(current.requirementId)?.plan.confirmedVersion);
    } });
    await snapshot("jump", b, jump);
    expect(jump, JSON.stringify(jump)).toMatchObject({ status: "reached" });
    const jumpId = active()!.requirementId, jumpRevision = active()!.revision;

    record({ type: "phase", phase: "animation", at: Date.now() });
    const animation = await driveUser(b, ANIMATION, limits(45), record, { approveWhileRunning: true, until: () => {
      const current = requirements().find((item) => item.requirementId === jumpId)!;
      return current.revision > jumpRevision && (plan(jumpId)?.plan.confirmedRevision ?? 0) >= current.revision;
    } });
    await snapshot("animation", b, animation);
    expect(animation, JSON.stringify(animation)).toMatchObject({ status: "reached" });

    const answers: Array<QuestionRecord & { session: "bound" | "fresh" }> = [];
    const answered = (session: "bound" | "fresh") => async (item: QuestionRecord) => { answers.push({ ...item, session }); await save("questions.json", answers); };
    await askQuestions(b, BOUND_QUESTIONS, answered("bound"));
    await b.close();
    const c = await open();
    const fresh = await askQuestions(c, FRESH_QUESTIONS, answered("fresh"));
    await save("main-session-fresh.json", JSON.stringify(c.session.messages, null, 2));

    // 快跑验收板块里的正文句子：拒给正文的题的回答里不能出现
    const acceptance = sprintArchive.slice(sprintArchive.indexOf("{#acceptance}"), sprintArchive.indexOf("### 验收记录（关闭时由程序生成）"));
    const markers = acceptance.split("\n").map((line) => line.trim()).filter((line) => line.length >= 12 && !line.startsWith("#"));
    const bypass = fresh.flatMap((item, index) => REFUSE_BODY.has(index) ? item.toolCalls.filter((call) => HOST_READ_TOOLS.has(call.name) &&
      /docs\/prod|\/requirements\//.test(JSON.stringify(call.args))).map((call) => ({ question: item.question, call })) : []);
    const leaked = fresh.flatMap((item, index) => REFUSE_BODY.has(index) ? markers.filter((marker) => item.answer.includes(marker)).map((marker) => ({ question: item.question, marker })) : []);
    await save("judgement.json", { bypass, leaked, markers: markers.length });
    expect(markers.length).toBeGreaterThan(0);
    expect(bypass).toEqual([]);
    expect(leaked).toEqual([]);
  } finally {
    for (const host of hosts) await host.close().catch(() => undefined);
    let daemonGone = socketPath ? await waitMissing(socketPath, 30_000) : true;
    // 跳跃需求的 PM 仍在运行，守护进程不会空闲退出；只结束命令行里带本轮临时根目录的进程
    if (!daemonGone && socketPath) { await killUnder(root); daemonGone = await waitMissing(socketPath, 10_000); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const sessions = await readdir(dataRoot, { recursive: true }).catch(() => [] as string[]);
    for (const path of sessions.filter((name) => name.endsWith("session.jsonl"))) {
      await mkdir(join(evidence, "runs"), { recursive: true });
      await copyFile(join(dataRoot, path), join(evidence, "runs", `${basename(dirname(path))}.jsonl`)).catch(() => undefined);
    }
    // 凭据无论成败都删；其余现场仅在守护进程已退出时整体删除，否则保留供排查
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
    else record({ type: "stop", reason: `守护进程未退出，保留现场：${root}`, at: Date.now() });
  }
}, 240 * 60_000);
