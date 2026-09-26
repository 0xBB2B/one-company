import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { repositoryIdentity, daemonSocketPath } from "../../runtime/identity.ts";
import { RunStore } from "../../runtime/run-store.ts";
import type { RunRecord } from "../../runtime/run-store.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { driveUser } from "./helpers/user-driver.ts";
import type { DriverEvent, DriverOutcome } from "./helpers/user-driver.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();

const SCRIPT = {
  requirement: "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。"
    + "不做体力值，不改跳跃。请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。",
  approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。",
  proceed: "继续：创建工作区并派出 PM 开始实施。",
  accept: "完成报告我看过了，验收通过。",
  close: "验收已通过，请以完成关闭这个需求。",
};

function sumUsage(items: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }>) {
  return items.reduce((total, usage) => ({ input: total.input + usage.input, output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

function mainSessionFacts(host: InstalledHost) {
  const assistant = host.session.messages.flatMap((message) => message.role === "assistant" ? [message] : []);
  const toolCalls = assistant.flatMap((message) => message.content.flatMap((block) => block.type === "toolCall"
    ? [`${block.name}${typeof (block.arguments as { action?: unknown }).action === "string" ? `:${(block.arguments as { action: string }).action}` : ""}`] : []));
  const errors = host.session.messages.flatMap((message) => message.role === "toolResult" && message.isError
    ? [{ tool: message.toolName, text: JSON.stringify(message.content).slice(0, 500) }] : []);
  return { turns: assistant.length, usage: sumUsage(assistant.map((message) => message.usage)), toolCalls, toolErrors: errors,
    models: [...new Set(assistant.map((message) => `${message.provider}/${message.model}`))] };
}

async function waitMissing(path: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await stat(path); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC12：安装产物、全新数据根、零自定义定义，真实模型从需求草稿走到用户验收与完成关闭", async () => {
  const cfg = config!;
  const evidence = join(cfg.output, `zero-custom-${new Date().toISOString().replace(/[:.]/g, "-")}`);
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
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_TELEMETRY = "0";
    process.env.PI_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(join(agentDir, "pi-company"), repoId);

    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    outcome = await driveUser(host, SCRIPT, { userTurns: 15, wallMs: 90 * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") }, record);

    const runStore = new RunStore({ dataRoot: join(agentDir, "pi-company"), repoId, daemonStartedAt: new Date().toISOString() });
    const listed = (await runStore.list({ limit: 500 })).items;
    const runs = (await Promise.all(listed.map(async (item) => { const got = await runStore.get(item.id); return got.ok ? [got.run] : []; }))).flat() as RunRecord[];
    const worktrees = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
    const worktree = /^worktree (.+)$/gm.exec(worktrees.split("\n\n").slice(1).join("\n\n"))?.[1];
    const archives = worktree ? await readdir(join(worktree, "docs", "prod")).catch(() => []) : [];
    const report = {
      config: { model: `${cfg.provider}/${cfg.modelId}`, thinking: cfg.thinking },
      outcome, elapsedMs: Date.now() - started,
      main: mainSessionFacts(host),
      runs: runs.map((run) => ({ id: run.id, kind: run.kind, role: run.role, state: run.state, stateReason: run.stateReason, turns: run.turns,
        usage: run.usage, model: run.model, thinking: run.thinking, agentSource: run.agent?.source, parentRunId: run.parentRunId })),
      runUsage: sumUsage(runs.map((run) => run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      dialogs: host.dialogs, notifications: host.notifications, modelEvents: host.modelEvents, worktree: worktree ?? null, archives,
      worktreeLog: worktree ? (await exec("git", ["log", "--oneline", "-20"], { cwd: worktree })).stdout : null,
    };
    await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "closed" });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.agent?.source === "default")).toBe(true);
    expect(runs.map((run) => run.kind)).toContain("requirement");
    for (const role of ["pi-company.worker", "pi-company.reviewer", "pi-company.qa"]) expect(runs.map((run) => run.role)).toContain(role);
    expect(archives.some((name) => name.endsWith(".md"))).toBe(true);
  } finally {
    if (host) await writeFile(join(evidence, "side-calls.json"), JSON.stringify(host.sideCalls, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await writeFile(join(evidence, "model-events.json"), JSON.stringify(host.modelEvents, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await writeFile(join(evidence, "main-session.json"), JSON.stringify(host.session.messages, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await host.close().catch((error: unknown) => record({ type: "stop", reason: `关闭宿主失败：${String(error)}`, at: Date.now() }));
    const daemonGone = socketPath ? await waitMissing(socketPath, 30_000) : true;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // 凭据无论成败都删；其余现场仅在守护进程已退出时整体删除，否则保留供排查
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
    else record({ type: "stop", reason: `守护进程未退出，保留现场：${root}`, at: Date.now() });
  }
}, 100 * 60_000);
