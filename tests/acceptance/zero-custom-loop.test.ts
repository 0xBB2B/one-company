import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import type { RequirementRecord } from "../../runtime/requirement-contracts.ts";
import { repositoryIdentity, daemonSocketPath } from "../../runtime/identity.ts";
import { readApprovedConventions } from "../../runtime/project-conventions.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { RunRecord } from "../../runtime/run-store.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { killUnder, mainSessionFacts, sumUsage, waitMissing } from "./helpers/evidence.ts";
import { driveUser } from "./helpers/user-driver.ts";
import type { DriverEvent, DriverOutcome } from "./helpers/user-driver.ts";

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

interface LoopResult { outcome: DriverOutcome | undefined; runs: RunRecord[]; archive: string | null; archives: string[]; host: InstalledHost; agentDir: string; repoId: string; repo: string }

/** 一轮真实模型闭环：装产品、建样例项目、按脚本驱动用户，把证据写进输出目录，再交给 verify 断言；现场与凭据在结束时清理。 */
async function runLoop(name: string, script: typeof SCRIPT, prepare: (repo: string, agentDir: string, installed: string) => Promise<void>, verify: (result: LoopResult) => void | Promise<void>) {
  const cfg = config!;
  const evidence = join(cfg.output, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const events = join(evidence, "events.jsonl");
  const record = (event: DriverEvent) => { void appendFile(events, `${JSON.stringify(event)}\n`, { mode: 0o600 }); };

  const root = await mkdtemp(join(tmpdir(), "m9-"));
  const agentDir = join(root, "agent"), home = join(root, "home");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "PI_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  let host: InstalledHost | undefined, outcome: DriverOutcome | undefined, socketPath: string | undefined;
  const started = Date.now();
  try {
    const installed = await installProduct(root);
    const repo = await createSampleProject(root);
    const { repoId } = await repositoryIdentity(repo);
    await mkdir(home, { recursive: true });
    await copyCredentials(cfg.credentialsDir, agentDir);
    await prepare(repo, agentDir, installed);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_TELEMETRY = "0";
    process.env.PI_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(join(agentDir, "pi-company"), repoId);

    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    outcome = await driveUser(host, script, { userTurns: 15, wallMs: 90 * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") }, record);

    const runStore = new RunStore({ dataRoot: join(agentDir, "pi-company"), repoId, daemonStartedAt: new Date().toISOString() });
    const listed = (await runStore.list({ limit: 500 })).items;
    const runs = (await Promise.all(listed.map(async (item) => { const got = await runStore.get(item.id); return got.ok ? [got.run] : []; }))).flat() as RunRecord[];
    const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    const worktree = /^worktree (.+)$/gm.exec(worktrees.split("\n\n").slice(1).join("\n\n"))?.[1];
    const archives = worktree ? await readdir(join(worktree, "docs", "prod")).catch(() => []) : [];
    const archive = worktree && archives[0] ? await readFile(join(worktree, "docs", "prod", archives[0]), "utf8") : null;
    if (archive !== null) await writeFile(join(evidence, "archive.md"), archive, { mode: 0o600 });
    const conventions = readApprovedConventions(join(agentDir, "pi-company"), repoId);
    const report = {
      config: { model: `${cfg.provider}/${cfg.modelId}`, thinking: cfg.thinking },
      outcome, elapsedMs: Date.now() - started,
      main: mainSessionFacts(host),
      runs: runs.map((run) => ({ id: run.id, kind: run.kind, role: run.role, state: run.state, stateReason: run.stateReason, stopCause: run.stopCause, turns: run.turns,
        usage: run.usage, model: run.model, thinking: run.thinking, agentSource: run.agent?.source, agentName: run.agent?.name, agentSkills: run.agent?.skills.map((skill) => skill.name), task: run.task, parentRunId: run.parentRunId })),
      runUsage: sumUsage(runs.map((run) => run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      dialogs: host.dialogs, notifications: host.notifications, modelEvents: host.modelEvents, worktree: worktree ?? null, archives, conventions,
      worktreeLog: worktree ? (await exec("git", ["log", "--oneline", "-20"], { cwd: worktree })).stdout : null,
    };
    await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await verify({ outcome, runs, archive, archives, host, agentDir, repoId, repo });
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
    const sessions = await readdir(join(agentDir, "pi-company"), { recursive: true }).catch(() => [] as string[]);
    for (const path of sessions.filter((name) => name.endsWith("session.jsonl"))) {
      await mkdir(join(evidence, "runs"), { recursive: true });
      await copyFile(join(agentDir, "pi-company", path), join(evidence, "runs", `${basename(dirname(path))}.jsonl`)).catch(() => undefined);
    }
    // 凭据无论成败都删；其余现场仅在守护进程已退出时整体删除，否则保留供排查
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
    else record({ type: "stop", reason: `守护进程未退出，保留现场：${root}`, at: Date.now() });
  }
}

/** 记录插入位置按 markers 顺序出现在归档里。 */
function expectInOrder(archive: string | null, markers: string[]) {
  const positions = markers.map((marker) => archive?.indexOf(marker) ?? -1);
  expect(positions.every((position) => position > 0), JSON.stringify(positions)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC12：安装产物、全新数据根、零自定义定义，真实模型从需求草稿走到用户验收与完成关闭", async () => {
  await runLoop("zero-custom", SCRIPT, async () => {}, async ({ outcome, runs, archive, archives, host, agentDir, repoId, repo }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.agent?.source === "default")).toBe(true);
    expect(runs.map((run) => run.kind)).toContain("requirement");
    for (const role of ["pi-company.worker", "pi-company.reviewer", "pi-company.qa"]) expect(runs.map((run) => run.role)).toContain(role);
    expect(archives.some((name) => name.endsWith(".md"))).toBe(true);
    expectInOrder(archive, ["{#background}", "{#requirements}", "{#features}", "{#implementation}", "\n### 实现记录（关闭时由程序生成）\n", "{#acceptance}", "\n### 验收记录（关闭时由程序生成）\n"]);
    const conventions = readApprovedConventions(join(agentDir, "pi-company"), repoId);
    expect(host.dialogs.some((dialog) => dialog.title === "确认更新项目规范 AGENTS.md")).toBe(true);
    expect(conventions?.content).toMatch(/大写|upper_?case|UPPER_SNAKE|SCREAMING_SNAKE/i);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8").catch(() => null)).toBe(conventions?.content);
  });
}, 100 * 60_000);

const CUSTOM_DOC = `---
name: requirement-doc
description: 本项目的需求文档规范。主会话写需求草稿时由框架自动注入。
disable-model-invocation: true
sections:
  - { id: goal, title: 目标 }
  - { id: scenarios, title: 场景 }
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
    const records = withDatabase(repositoryDatabase(join(agentDir, "pi-company"), repoId), (db) => db.list<RequirementRecord>("requirements"));
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

test.skipIf(!config || process.platform !== "darwin")("M9-AC13：复制默认 worker 为 ui-worker 并挂项目 skill ui-basics，PM 自动选中它完成 HUD 面板的设计与实现，reviewer 与 QA 独立检查", async () => {
  const script = {
    requirement: "我要给游戏加一个 HUD 状态面板：显示角色当前水平速度、是否在空中、是否在快跑。用 TypeScript 写一个函数，输入这三个状态，输出面板的 HTML 字符串，再导出面板的 CSS；用 node 单元测试验证输出。界面怎么设计你们按项目的界面约定来。" +
      "请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。",
    approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。", proceed: "继续：创建工作区并派出 PM 开始实施。",
    accept: "完成报告我看过了，验收通过。", close: "验收已通过，请以完成关闭这个需求。",
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
  }, async ({ outcome, runs }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    const ui = runs.filter((run) => run.agent?.name === "ui-worker");
    expect(ui.length).toBeGreaterThan(0);
    expect(ui.every((run) => run.role === "pi-company.worker" && run.agent?.source === "user" && run.agent.skills.some((skill) => skill.name === "ui-basics"))).toBe(true);
    for (const role of ["pi-company.reviewer", "pi-company.qa"]) expect(runs.some((run) => run.role === role && run.state === "completed")).toBe(true);
    expect(runs.filter((run) => run.role === "pi-company.explore").every((run) => run.writePaths.length === 0)).toBe(true);
  });
}, 100 * 60_000);
