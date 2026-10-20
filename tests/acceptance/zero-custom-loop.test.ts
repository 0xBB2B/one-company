import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { repositoryIdentity, daemonSocketPath } from "../../src/core/storage/identity.ts";
import { RunStore } from "../../src/modules/agents/run-store.ts";
import { sessionFilePath } from "../../src/modules/agents/session-records.ts";
import type { RunRecord } from "../../src/modules/agents/run-store.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { killUnder, mainSessionFacts, sumUsage, waitMissing } from "./helpers/evidence.ts";
import { driveUser } from "./helpers/user-driver.ts";
import { stubOpen } from "./helpers/stub-open.ts";
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
  worktree: string | undefined }

/** 一轮真实模型闭环：装产品、建样例项目、按脚本驱动用户，把证据写进输出目录，再交给 verify 断言；现场与凭据在结束时清理。 */
async function runLoop(name: string, script: UserScript, verify: (result: LoopResult) => void | Promise<void>) {
  const cfg = config!;
  const evidence = join(cfg.output, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const events = join(evidence, "events.jsonl");
  const record = (event: DriverEvent) => { void appendFile(events, `${JSON.stringify(event)}\n`, { mode: 0o600 }); };

  const root = await mkdtemp(join(tmpdir(), "m9-"));
  const agentDir = join(root, "agent"), home = join(root, "home");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "ONE_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  const restoreOpen = await stubOpen();
  let host: InstalledHost | undefined, outcome: DriverOutcome | undefined, socketPath: string | undefined;
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
    socketPath = daemonSocketPath(join(agentDir, "one-company"), repoId);

    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    outcome = await driveUser(host, script, { userTurns: 15, wallMs: 90 * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") }, record);

    const runStore = new RunStore({ dataRoot: join(agentDir, "one-company"), repoId, daemonStartedAt: new Date().toISOString() });
    const listed = (await runStore.list({ limit: 500 })).items;
    const runs = (await Promise.all(listed.map(async (item) => { const got = await runStore.get(item.id); return got.ok ? [got.run] : []; }))).flat() as RunRecord[];
    const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    const worktree = /^worktree (.+)$/gm.exec(worktrees.split("\n\n").slice(1).join("\n\n"))?.[1];
    const archives = worktree ? await readdir(join(worktree, "docs", "prd")).catch(() => []) : [];
    const archiveName = archives.find((name) => name.endsWith(".md"));
    const archive = worktree && archiveName ? await readFile(join(worktree, "docs", "prd", archiveName), "utf8") : null;
    if (archive !== null) await writeFile(join(evidence, "archive.md"), archive, { mode: 0o600 });
    const conventions = await readFile(join(repo, "AGENTS.md"), "utf8").catch(() => null);
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
    await verify({ outcome, runs, archive, archives, host, agentDir, repoId, repo, worktree });
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
    await restoreOpen();
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
  const archiveName = archives.find((name) => name.endsWith(".md"))!;
  const requirementId = archiveName.split(".")[0]!;
  const versions = join(agentDir, "one-company", "repos", repoId, "requirements", requirementId);
  expect((await readFile(join(versions, "prd.md"), "utf8")).length).toBeGreaterThan(0);
  expect(Number((await exec("git", ["rev-list", "--count", "HEAD"], { cwd: versions })).stdout.trim())).toBeGreaterThan(0);
  expect((await exec("git", ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all", "docs/prd"], { cwd: worktree! })).stdout).toContain(archiveName);
  await exec("git", ["add", "docs/prd"], { cwd: worktree! });
  await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "需求归档"], { cwd: worktree! });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree! })).stdout.trim();
  const clone = join(dirname(repo), "member-clone");
  await exec("git", ["clone", "-q", repo, clone]);
  await exec("git", ["checkout", "-q", head], { cwd: clone });
  expect(await readFile(join(clone, "docs", "prd", archiveName), "utf8")).toBe(archive);
  expect(archive).toContain("\n### 验收记录（关闭时由程序生成）\n");
}

/** 记录插入位置按 markers 顺序出现在归档里。 */
function expectInOrder(archive: string | null, markers: string[]) {
  const positions = markers.map((marker) => archive?.indexOf(marker) ?? -1);
  expect(positions.every((position) => position > 0), JSON.stringify(positions)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC12：安装产物、全新数据根、零自定义定义，真实模型从需求草稿走到用户验收与完成关闭", async () => {
  await runLoop("zero-custom", SCRIPT, async ({ outcome, runs, archive, archives, host, agentDir, repoId, repo, worktree }) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((run) => run.kind === "requirement").every((run) => run.agent === undefined)).toBe(true);
    expect(runs.filter((run) => run.kind !== "requirement").every((run) => run.agent?.source === "default")).toBe(true);
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
