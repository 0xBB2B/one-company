import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { TASKS } from "../../runtime/plan-manage.ts";
import type { TaskRecord } from "../../runtime/plan-manage.ts";
import type { RequirementRecord } from "../../runtime/requirement-contracts.ts";
import { repositoryIdentity, daemonSocketPath } from "../../runtime/identity.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { sessionFilePath } from "../../runtime/session-records.ts";
import type { RunRecord } from "../../runtime/run-store.ts";
import { acceptanceConfig, copyCredentials, installProduct, PROTOTYPE_ACCEPT, startInstalledHost, stubSystemOpen } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { killUnder, mainSessionFacts, sumUsage, waitMissing } from "./helpers/evidence.ts";
import { driveUser } from "./helpers/user-driver.ts";
import type { DriverEvent, DriverOutcome, UserScript } from "./helpers/user-driver.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();

const SCRIPT = {
  requirement: "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。"
    + "不做体力值，不改跳跃。另外定一条项目规范：以后导出的常量一律用大写字母加下划线命名。"
    + "请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。",
  approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。",
  proceed: "继续：创建工作区并派出 PM 开始实施。",
  accept: "完成报告我看过了，验收通过。",
  close: "验收已通过，请以完成关闭这个需求。",
};

interface LoopResult { outcome: DriverOutcome | undefined; runs: RunRecord[]; archive: string | null; archives: string[]; host: InstalledHost; agentDir: string; repoId: string; repo: string;
  /** 面板扩展交给系统 open 命令的路径，按先后顺序。 */ opened: string[]; evidence: string; worktree: string | undefined }

/** 一轮真实模型闭环：装产品、建样例项目、按脚本驱动用户，把证据写进输出目录，再交给 verify 断言；现场与凭据在结束时清理。 */
async function runLoop(name: string, script: UserScript, prepare: (repo: string, agentDir: string, installed: string) => Promise<void>, verify: (result: LoopResult) => void | Promise<void>) {
  const cfg = config!;
  const evidence = join(cfg.output, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const events = join(evidence, "events.jsonl");
  const record = (event: DriverEvent) => { void appendFile(events, `${JSON.stringify(event)}\n`, { mode: 0o600 }); };

  const root = await mkdtemp(join(tmpdir(), "m9-"));
  const agentDir = join(root, "agent"), home = join(root, "home");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "ONE_COMPANY_IDLE_TIMEOUT_MS", "PATH"].map((key) => [key, process.env[key]]));
  let host: InstalledHost | undefined, outcome: DriverOutcome | undefined, socketPath: string | undefined;
  const started = Date.now();
  try {
    const installed = await installProduct(root);
    const repo = await createSampleProject(root);
    const { repoId } = await repositoryIdentity(repo);
    await mkdir(home, { recursive: true });
    await copyCredentials(cfg.credentialsDir, agentDir);
    await prepare(repo, agentDir, installed);
    const openedLog = await stubSystemOpen(root);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_TELEMETRY = "0";
    process.env.ONE_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(join(agentDir, "one-company"), repoId);

    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    outcome = await driveUser(host, script, { userTurns: 15, wallMs: 90 * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") }, record);

    const runStore = new RunStore({ dataRoot: join(agentDir, "one-company"), repoId, daemonStartedAt: new Date().toISOString() });
    const listed = (await runStore.list({ limit: 500 })).items;
    const runs = (await Promise.all(listed.map(async (item) => { const got = await runStore.get(item.id); return got.ok ? [got.run] : []; }))).flat() as RunRecord[];
    const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    const worktree = /^worktree (.+)$/gm.exec(worktrees.split("\n\n").slice(1).join("\n\n"))?.[1];
    const archives = worktree ? await readdir(join(worktree, "docs", "prod")).catch(() => []) : [];
    const archive = worktree && archives[0] ? await readFile(join(worktree, "docs", "prod", archives[0]), "utf8") : null;
    if (archive !== null) await writeFile(join(evidence, "archive.md"), archive, { mode: 0o600 });
    const conventions = await readFile(join(repo, "AGENTS.md"), "utf8").catch(() => null);
    const opened = (await readFile(openedLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const report = {
      config: { model: `${cfg.provider}/${cfg.modelId}`, thinking: cfg.thinking },
      outcome, elapsedMs: Date.now() - started,
      main: mainSessionFacts(host),
      runs: runs.map((run) => ({ id: run.id, kind: run.kind, role: run.role, state: run.state, stateReason: run.stateReason, stopCause: run.stopCause, turns: run.turns,
        usage: run.usage, model: run.model, thinking: run.thinking, agentSource: run.agent?.source, agentName: run.agent?.name, agentSkills: run.agent?.skills.map((skill) => skill.name), task: run.task, parentRunId: run.parentRunId })),
      runUsage: sumUsage(runs.map((run) => run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      dialogs: host.dialogs, notifications: host.notifications, modelEvents: host.modelEvents, worktree: worktree ?? null, archives, conventions, opened,
      worktreeLog: worktree ? (await exec("git", ["log", "--oneline", "-20"], { cwd: worktree })).stdout : null,
    };
    await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await verify({ outcome, runs, archive, archives, host, agentDir, repoId, repo, opened, evidence, worktree });
  } finally {
    if (host) await writeFile(join(evidence, "side-calls.json"), JSON.stringify(host.sideCalls, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await writeFile(join(evidence, "model-events.json"), JSON.stringify(host.modelEvents, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await writeFile(join(evidence, "main-session.json"), JSON.stringify(host.session.messages, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await host.close().catch((error: unknown) => record({ type: "stop", reason: `关闭宿主失败：${String(error)}`, at: Date.now() }));
    let daemonGone = socketPath ? await waitMissing(socketPath, 30_000) : true;
    // PM 仍在运行时守护进程不会空闲退出；只结束命令行里带本轮临时根目录的进程
    if (!daemonGone && socketPath) { await killUnder(root); daemonGone = await waitMissing(socketPath, 10_000); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const sessions = await readdir(join(agentDir, "one-company"), { recursive: true }).catch(() => [] as string[]);
    for (const path of sessions.filter((name) => name.endsWith("session.jsonl"))) {
      await mkdir(join(evidence, "runs"), { recursive: true });
      await copyFile(join(agentDir, "one-company", path), join(evidence, "runs", `${basename(dirname(path))}.jsonl`)).catch(() => undefined);
    }
    for (const file of await readdir(join(agentDir, "one-company", "repos"), { recursive: true }).catch(() => [] as string[])) {
      if (/(^|\/)data\.db(-wal)?$/u.test(file)) await copyFile(join(agentDir, "one-company", "repos", file), join(evidence, basename(file))).catch(() => undefined);
    }
    // 凭据无论成败都删；其余现场仅在守护进程已退出时整体删除，否则保留供排查
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
    else record({ type: "stop", reason: `守护进程未退出，保留现场：${root}`, at: Date.now() });
  }
}

/**
 * M9-AC5、AC6：关闭后本机正文与私有版本库仍在；归档只有这一份完成需求，写进业务工作区等用户另行提交；
 * 模拟用户提交后，另起一份不带本机数据的克隆按这次提交读到同样的归档与验收记录。
 */
async function expectArchiveDelivered(result: Pick<LoopResult, "agentDir" | "repoId" | "repo" | "worktree" | "archive" | "archives">) {
  const { agentDir, repoId, repo, worktree, archive, archives } = result;
  expect(archives.filter((name) => name.endsWith(".md"))).toHaveLength(1);
  const requirementId = archives[0]!.split(".")[0]!;
  const versions = join(agentDir, "one-company", "repos", repoId, "requirements", requirementId);
  expect((await readFile(join(versions, "prod.md"), "utf8")).length).toBeGreaterThan(0);
  expect(Number((await exec("git", ["rev-list", "--count", "HEAD"], { cwd: versions })).stdout.trim())).toBeGreaterThan(0);
  expect((await exec("git", ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all", "docs/prod"], { cwd: worktree! })).stdout).toContain(archives[0]);
  await exec("git", ["add", "docs/prod"], { cwd: worktree! });
  await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "需求归档"], { cwd: worktree! });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree! })).stdout.trim();
  const clone = join(dirname(repo), "member-clone");
  await exec("git", ["clone", "-q", repo, clone]);
  await exec("git", ["checkout", "-q", head], { cwd: clone });
  expect(await readFile(join(clone, "docs", "prod", archives[0]!), "utf8")).toBe(archive);
  expect(archive).toContain("\n### 验收记录（关闭时由程序生成）\n");
}

/** 记录插入位置按 markers 顺序出现在归档里。 */
function expectInOrder(archive: string | null, markers: string[]) {
  const positions = markers.map((marker) => archive?.indexOf(marker) ?? -1);
  expect(positions.every((position) => position > 0), JSON.stringify(positions)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC12：安装产物、全新数据根、零自定义定义，真实模型从需求草稿走到用户验收与完成关闭", async () => {
  await runLoop("zero-custom", SCRIPT, async () => {}, async ({ outcome, runs, archive, archives, host, agentDir, repoId, repo, worktree }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.agent?.source === "default")).toBe(true);
    expect(runs.map((run) => run.kind)).toContain("requirement");
    for (const role of ["one-company.worker", "one-company.reviewer", "one-company.qa"]) expect(runs.map((run) => run.role)).toContain(role);
    expect(archives.some((name) => name.endsWith(".md"))).toBe(true);
    expectInOrder(archive, ["{#background}", "{#requirements}", "{#features}", "{#implementation}", "\n### 实现记录（关闭时由程序生成）\n", "{#acceptance}", "\n### 验收记录（关闭时由程序生成）\n"]);
    await expectArchiveDelivered({ agentDir, repoId, repo, worktree, archive, archives });
    expect(host.dialogs.some((dialog) => dialog.title === "把这些改动写入项目规范 AGENTS.md？" && dialog.answer === "写入")).toBe(true);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8").catch(() => null)).toMatch(/大写|upper_?case|UPPER_SNAKE|SCREAMING_SNAKE/i);
    // worker 遵守规范：交付的源码里导出的常量全是大写字母加下划线
    const sources = (await readdir(join(worktree!, "src"), { recursive: true })).filter((name) => name.endsWith(".ts"));
    const exported = (await Promise.all(sources.map((name) => readFile(join(worktree!, "src", name), "utf8")))).flatMap((text) => [...text.matchAll(/^export const (\w+)/gm)].map((match) => match[1]!));
    expect(exported.filter((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))).toEqual([]);
    // 审查结论写明核对了该规范
    const dataRoot = join(agentDir, "one-company");
    const reviews = await Promise.all(runs.filter((run) => run.role === "one-company.reviewer" && run.state === "completed").map((run) => readFile(sessionFilePath({ dataRoot, repoId, runId: run.id }), "utf8")));
    const summaries = reviews.flatMap((session) => session.split("\n").filter(Boolean).flatMap((line) => {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      return Array.isArray(content) ? content.flatMap((block: { type?: string; name?: string; arguments?: { action?: string; result?: { summary?: string } } }) =>
        block.type === "toolCall" && block.name?.endsWith("result_submit") && block.arguments?.action === "verdict" ? [block.arguments.result?.summary ?? ""] : []) : [];
    }));
    expect(summaries.some((summary) => /规范|AGENTS\.md/.test(summary) && /大写|常量/.test(summary)), JSON.stringify(summaries)).toBe(true);
  });
}, 100 * 60_000);

const CUSTOM_DOC = `---
name: requirement-doc
description: 本项目的需求文档规范。主会话写需求草稿时由框架自动注入。
disable-model-invocation: true
sections:
  - { id: goal, title: 目标 }
  - { id: scenarios, title: 场景, goal: true }
  - { id: check, title: 检验, record: acceptance }
  - { id: approach, title: 做法, record: implementation }
---
- 目标：一两句话写清楚要让谁得到什么，以及这次不做什么。
- 场景：按场景分三级小节写行为，编号以 scenarios. 开头，如 \`### 地面快跑 {#scenarios.sprint}\`，写正常、边界和不变的行为。
- 检验：按场景分三级小节写前置条件、操作、可观察结果，编号以 check. 开头，如 \`### 地面快跑 {#check.sprint}\`。
- 做法：只写用户明确提出的实现要求，没有就写"由 PM 规划"。

每个板块标题下先写一句概述再接小节，每个小节标题下都要有正文。
`;

test.skipIf(!config || process.platform !== "darwin")("M8C-AC7：受信任项目的自定义需求文档规范（检验板块在做法之前），真实模型从草稿走到完成关闭，归档按规范插入两段记录", async () => {
  const script = { ...SCRIPT, requirement: SCRIPT.requirement.replace("另外定一条项目规范：以后导出的常量一律用大写字母加下划线命名。", "") };
  await runLoop("custom-doc", script, async (repo, agentDir) => {
    await mkdir(join(repo, ".pi", "skills", "requirement-doc"), { recursive: true });
    await writeFile(join(repo, ".pi", "skills", "requirement-doc", "SKILL.md"), CUSTOM_DOC);
    await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "add", ".pi"], { cwd: repo });
    await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "项目需求文档规范"], { cwd: repo });
    new ProjectTrustStore(agentDir).set(repo, true);
  }, async ({ outcome, archive, agentDir, repoId }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expectInOrder(archive, ["{#goal}", "{#scenarios}", "{#check}", "\n### 验收记录（关闭时由程序生成）\n", "{#approach}", "\n### 实现记录（关闭时由程序生成）\n"]);
    expect(archive).not.toContain("{#background}");
    const records = withDatabase(repositoryDatabase(join(agentDir, "one-company"), repoId), (db) => db.list<RequirementRecord>("requirements"));
    expect(records.map((row) => row.data.docSpec?.sections.map((section) => section.id))).toEqual([["goal", "scenarios", "check", "approach"]]);
  });
}, 100 * 60_000);

const UI_BASICS = `---
name: ui-basics
description: 本项目的界面写法：HUD 与面板的 HTML 结构、类名与配色约定。做界面相关任务时使用。
---
- 面板根元素用 \`<section class="hud">\`，每一项用 \`<div class="hud-item" data-key="...">\`，标签与数值分别放在 \`<span class="label">\` 与 \`<span class="value">\`。
- 布尔状态显示「是」或「否」，不用 true/false。
- 样式写在导出的 CSS 字符串常量里，主色 #2f6fed，字号 14px，不引入第三方库。
`;

test.skipIf(!config || process.platform !== "darwin")("M9-AC13：复制默认 worker 为 ui-worker 并挂项目 skill ui-basics，PM 自动选中它完成 HUD 面板的设计与实现，界面任务先做原型、用户通过后才实现，reviewer 与 QA 独立检查且 QA 读了原型", async () => {
  const script = {
    requirement: "我要给游戏加一个 HUD 状态面板：显示角色当前水平速度、是否在空中、是否在快跑。用 TypeScript 写一个函数，输入这三个状态，输出面板的 HTML 字符串，再导出面板的 CSS；用 node 单元测试验证输出。界面怎么设计你们按项目的界面约定来。" +
      "请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。",
    approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。", proceed: "继续：创建工作区并派出 PM 开始实施。",
    accept: "完成报告我看过了，验收通过。", close: "验收已通过，请以完成关闭这个需求。",
    adjudicate: "再给一次机会，上限 10 轮：按已批准的需求和原型文件核对输出，浏览器里的实际视觉没法验证的，在报告里写明没验证就行。",
  };
  await runLoop("ui-worker", script, async (repo, agentDir, installed) => {
    const worker = await readFile(join(installed, "agents", "worker.md"), "utf8");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writeFile(join(agentDir, "agents", "ui-worker.md"), worker.replace("name: worker\n", "name: ui-worker\n")
      .replace(/description: .*\n/u, "description: 界面专业 worker：负责 HUD、面板等界面的设计与实现，按项目界面约定写 HTML 与 CSS\nskills: [ui-basics]\n"));
    await mkdir(join(repo, ".pi", "skills", "ui-basics"), { recursive: true });
    await writeFile(join(repo, ".pi", "skills", "ui-basics", "SKILL.md"), UI_BASICS);
    const user = ["-c", "user.name=sample", "-c", "user.email=sample@localhost"];
    await exec("git", ["add", ".pi"], { cwd: repo });
    await exec("git", [...user, "commit", "-qm", "项目界面约定"], { cwd: repo });
    new ProjectTrustStore(agentDir).set(repo, true);
  }, async ({ outcome, runs, host, agentDir, repoId, opened, evidence }) => {
    const dataRoot = join(agentDir, "one-company");
    const tasks = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<TaskRecord>(TASKS)).map((row) => row.data);
    const uiTasks = tasks.filter((task) => task.ui && task.status !== "cancelled");
    await writeFile(join(evidence, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
    for (const prototype of uiTasks.flatMap((task) => task.prototypes ?? [])) await copyFile(prototype.path, join(evidence, basename(prototype.path))).catch(() => undefined);

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expect(uiTasks.length).toBeGreaterThan(0);
    const sessionText = (runId: string) => readFile(sessionFilePath({ dataRoot, repoId, runId }), "utf8");
    for (const task of uiTasks) {
      const prototype = task.prototypes?.at(-1);
      expect(prototype?.decision?.choice, task.key).toBe("accept");
      expect(createHash("sha256").update(await readFile(prototype!.path)).digest("hex")).toBe(prototype!.hash);
      expect(opened).toContain(prototype!.path);
      expect(runs.find((run) => run.id === prototype!.runId)?.role).toBe("one-company.worker");
      // 先原型后实现：这个任务的每次实现运行都在用户通过原型之后才开始
      expect(task.attempts.length).toBeGreaterThan(0);
      const firstAccepted = task.prototypes!.find((version) => version.decision?.choice === "accept")!.decision!.decidedAt;
      for (const attempt of task.attempts) expect(Date.parse(runs.find((run) => run.id === attempt.runId)!.startedAt)).toBeGreaterThan(firstAccepted);
    }
    const confirmations = host.dialogs.filter((dialog) => dialog.title === "确认原型");
    expect(confirmations.length).toBeGreaterThan(0);
    expect(confirmations.every((dialog) => dialog.answer === PROTOTYPE_ACCEPT)).toBe(true);
    // QA 对照原型：至少一个完成的 QA 运行用 read 读了某份已通过的原型文件
    const approved = uiTasks.map((task) => join("prototypes", task.requirementId, basename(task.prototypes!.at(-1)!.path)));
    const qaSessions = await Promise.all(runs.filter((run) => run.role === "one-company.qa" && run.state === "completed").map((run) => sessionText(run.id)));
    const readsPrototype = (session: string) => session.split("\n").filter(Boolean).some((line) => {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      return Array.isArray(content) && content.some((block: { type?: string; name?: string; arguments?: { path?: string } }) => block.type === "toolCall" && block.name === "read" && approved.some((path) => block.arguments?.path?.endsWith(path)));
    });
    expect(qaSessions.some(readsPrototype)).toBe(true);
    const ui = runs.filter((run) => run.agent?.name === "ui-worker");
    expect(ui.length).toBeGreaterThan(0);
    expect(ui.every((run) => run.role === "one-company.worker" && run.agent?.source === "user" && run.agent.skills.some((skill) => skill.name === "ui-basics"))).toBe(true);
    // M9-AC17：ui-basics 的加载指纹就是项目里 SKILL.md 的实际内容；任务写明为什么选 ui-worker；本机库不存 skill 与角色定义的正文
    const skillHash = createHash("sha256").update(UI_BASICS).digest("hex");
    expect(ui.every((run) => run.agent!.skills.some((skill) => skill.name === "ui-basics" && skill.hash === skillHash))).toBe(true);
    expect(uiTasks.every((task) => task.agent === "ui-worker" && Boolean(task.agentReason))).toBe(true);
    const raw = new DatabaseSync(repositoryDatabase(dataRoot, repoId), { readOnly: true });
    // 报告与审查结论会转述“主色 #2f6fed”这类取值，只查正文原句与 skill 头部
    const bodies = (raw.prepare("SELECT count(*) AS n FROM records WHERE data LIKE ? OR data LIKE ? OR data LIKE ?")
      .get("%name: ui-basics%", "%布尔状态显示「是」或「否」，不用 true/false%", "%你是实现代理，只完成派工给出的任务%") as { n: number }).n;
    raw.close();
    expect(bodies).toBe(0);
    for (const role of ["one-company.reviewer", "one-company.qa"]) expect(runs.some((run) => run.role === role && run.state === "completed")).toBe(true);
    expect(runs.filter((run) => run.role === "one-company.explore").every((run) => run.writePaths.length === 0)).toBe(true);
  });
}, 100 * 60_000);

/** 预埋两处错误：快跑倍率在另一个文件里写成 1.2，空中按 Shift 也加速，且各有一条测试断言错误行为；用户需求要求 1.5 倍、空中不变。 */
const SEEDED_TUNING = "/** 快跑时水平速度相对行走速度的倍率。 */\nexport const SPRINT_MULTIPLIER = 1.2;\n";
const SEEDED_MOVEMENT = [
  "import { SPRINT_MULTIPLIER } from \"./tuning.ts\";",
  "",
  "export const WALK_SPEED = 4;",
  "",
  "export interface MoveInput { left: boolean; right: boolean; shift?: boolean; grounded?: boolean }",
  "",
  "/** 每帧水平速度：只按一个方向键时朝该方向走，按住 Shift 时乘以快跑倍率；同时按或都不按时停下。 */",
  "export function horizontalVelocity(input: MoveInput): number {",
  "  if (input.left === input.right) return 0;",
  "  const speed = input.shift ? WALK_SPEED * SPRINT_MULTIPLIER : WALK_SPEED;",
  "  return input.right ? speed : -speed;",
  "}",
  "",
].join("\n");
const SEEDED_TEST = [
  "import { test } from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { horizontalVelocity, WALK_SPEED } from \"./movement.ts\";",
  "import { pressJump } from \"./jump.ts\";",
  "",
  "test(\"按右键向右走，同时按两个方向键停下\", () => {",
  "  assert.equal(horizontalVelocity({ left: false, right: true }), WALK_SPEED);",
  "  assert.equal(horizontalVelocity({ left: true, right: true }), 0);",
  "});",
  "",
  "test(\"快跑为行走速度的 1.2 倍\", () => {",
  "  assert.equal(horizontalVelocity({ left: false, right: true, shift: true, grounded: true }), WALK_SPEED * 1.2);",
  "});",
  "",
  "test(\"空中按 Shift 同样加速\", () => {",
  "  assert.equal(horizontalVelocity({ left: false, right: true, shift: true, grounded: false }), WALK_SPEED * 1.2);",
  "});",
  "",
  "test(\"空中再次按跳跃不重新起跳\", () => {",
  "  const airborne = pressJump({ grounded: true, verticalSpeed: 0 });",
  "  assert.deepEqual(pressJump({ ...airborne, verticalSpeed: 3 }), { ...airborne, verticalSpeed: 3 });",
  "});",
  "",
].join("\n");
const CODE_ERROR_SCRIPT: UserScript = {
  ...SCRIPT,
  requirement: "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。"
    + "不做体力值，不改跳跃。请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。",
};

test.skipIf(!config || process.platform !== "darwin")("M9-AC3：样例项目预埋两处错误——tuning.ts 里快跑倍率写成 1.2、空中按 Shift 也加速，各有测试断言错误行为；需求要求 1.5 倍且空中不加速；PM 改正代码与测试，需求始终是批准的第 1 版，以完成关闭", async () => {
  await runLoop("code-error", CODE_ERROR_SCRIPT, async (repo) => {
    await writeFile(join(repo, "src/player/tuning.ts"), SEEDED_TUNING);
    await writeFile(join(repo, "src/player/movement.ts"), SEEDED_MOVEMENT);
    await writeFile(join(repo, "src/player/movement.test.ts"), SEEDED_TEST);
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "快跑初版"], { cwd: repo });
  }, async ({ outcome, agentDir, repoId, worktree, evidence }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    const { requirements, tasks } = withDatabase(repositoryDatabase(join(agentDir, "one-company"), repoId), (db) => ({
      requirements: db.list<RequirementRecord>("requirements").map((row) => row.data), tasks: db.list<TaskRecord>(TASKS).map((row) => row.data) }));
    expect(requirements).toHaveLength(1);
    const requirement = requirements[0]!;
    expect(requirement).toMatchObject({ revision: 1, close: { reason: "completed" } });
    expect(requirement.saved?.hash).toBe(requirement.approved?.hash);
    expect(tasks.map((task) => task.status)).not.toContain("awaiting_user");
    const probe = "import { horizontalVelocity, WALK_SPEED } from './src/player/movement.ts';"
      + "console.log(JSON.stringify({ air: horizontalVelocity({ left: false, right: true, shift: true, grounded: false }), ground: horizontalVelocity({ left: false, right: true, shift: true, grounded: true }), walk: WALK_SPEED }));";
    const behavior = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", probe], { cwd: worktree! })).stdout);
    const npmTest = await exec("npm", ["test"], { cwd: worktree! }).then(() => 0, (error: { code?: number }) => error.code ?? 1);
    await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ requirement: { revision: requirement.revision, close: requirement.close }, taskStatuses: tasks.map((task) => task.status), behavior, npmTest }, null, 2)}\n`, { mode: 0o600 });
    expect(behavior).toEqual({ air: behavior.walk, ground: behavior.walk * 1.5, walk: behavior.walk });
    expect(npmTest).toBe(0);
  });
}, 100 * 60_000);

const MOVEMENT_BASICS = `---
name: movement-basics
description: 本项目的移动逻辑写法：速度常量、地面与空中判断。改角色移动相关代码时使用。
---
- 速度相关常量集中放在 src/player/movement.ts 顶部，导出名用大写字母加下划线。
- 地面与空中的判断只看输入里的 grounded 字段，不另外推断。
- 每条速度规则都要有一条 node 单元测试覆盖地面与空中两种情况。
`;

/** 在 AC12 的快跑需求上另装一个用户层专业 worker（复制默认 worker 改名、改说明、挂项目 skill），项目受信任。 */
function withSpecialist(name: string, description: string, skill: string, body: string) {
  return async (repo: string, agentDir: string, installed: string) => {
    const worker = await readFile(join(installed, "agents", "worker.md"), "utf8");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writeFile(join(agentDir, "agents", `${name}.md`), worker.replace("name: worker\n", `name: ${name}\n`)
      .replace(/description: .*\n/u, `description: ${description}\nskills: [${skill}]\n`));
    await mkdir(join(repo, ".pi", "skills", skill), { recursive: true });
    await writeFile(join(repo, ".pi", "skills", skill, "SKILL.md"), body);
    const user = ["-c", "user.name=sample", "-c", "user.email=sample@localhost"];
    await exec("git", ["add", ".pi"], { cwd: repo });
    await exec("git", [...user, "commit", "-qm", "项目约定"], { cwd: repo });
    new ProjectTrustStore(agentDir).set(repo, true);
  };
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC18：同一快跑需求，装了界面专业 worker 但当前任务不匹配，PM 仍用默认 worker 完成并关闭（测量对照：有专业无匹配）", async () => {
  await runLoop("ac18-nomatch", SCRIPT, withSpecialist("ui-worker", "界面专业 worker：负责 HUD、面板等界面的设计与实现，按项目界面约定写 HTML 与 CSS", "ui-basics", UI_BASICS),
    async ({ outcome, runs }) => {
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
      const workers = runs.filter((run) => run.role === "one-company.worker");
      expect(workers.length).toBeGreaterThan(0);
      expect(workers.every((run) => run.agent?.name === "worker" && run.agent.source === "default")).toBe(true);
    });
}, 100 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("M9-AC18：同一快跑需求，装了移动逻辑专业 worker 并挂项目 skill，PM 选中它完成并关闭，运行记录里 skill 指纹等于 SKILL.md 实际内容（测量对照：专业匹配）", async () => {
  await runLoop("ac18-match", SCRIPT, withSpecialist("movement-worker", "移动逻辑专业 worker：负责角色水平移动、快跑、跳跃等运动逻辑的实现与单元测试", "movement-basics", MOVEMENT_BASICS),
    async ({ outcome, runs }) => {
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
      const workers = runs.filter((run) => run.role === "one-company.worker");
      expect(workers.length).toBeGreaterThan(0);
      const skillHash = createHash("sha256").update(MOVEMENT_BASICS).digest("hex");
      expect(workers.every((run) => run.agent?.name === "movement-worker" && run.agent.source === "user"
        && run.agent.skills.some((skill) => skill.name === "movement-basics" && skill.hash === skillHash))).toBe(true);
    });
}, 100 * 60_000);
