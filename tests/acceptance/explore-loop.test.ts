import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { killUnder, mainSessionFacts, waitMissing } from "./helpers/evidence.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";

const config = acceptanceConfig();
const CARD = "pi-company.explore-result";
const ASKS = [
  { name: "web", text: "不用建需求。请派一个 explore 联网检索：Node.js 内置测试模块 node:test 怎么跳过单个测试？要官方文档链接和原文短引文。拿到结果后核对来源再告诉我。" },
  { name: "local", text: "不用建需求。请派一个 explore 在本仓库里检索：go 目录下 Greet 函数定义在哪、谁调用它，要文件路径和行号。拿到结果后核对来源再告诉我。" },
  { name: "index", text: "先初始化本项目的索引，然后派一个 explore 借助项目索引查 horizontalVelocity 的定义和测试在哪。拿到结果后核对来源再告诉我。不用建需求。" },
];

function cards(host: InstalledHost): Array<Record<string, unknown>> {
  return host.session.messages.flatMap((message) => {
    const custom = message as unknown as { role: string; customType?: string; content?: unknown };
    return custom.customType === CARD && typeof custom.content === "string" ? [JSON.parse(custom.content) as Record<string, unknown>] : [];
  });
}

test.skipIf(!config || process.platform !== "darwin")("M9-AC10：安装产物中 main 在无需求、未初始化时派 explore 做纯网页与本地检索，再初始化索引检索；全程不建需求、结果以卡片交回主代理核对", async () => {
  const cfg = config!;
  const evidence = join(cfg.output, `explore-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(tmpdir(), "m9-"));
  const agentDir = join(root, "agent"), home = join(root, "home"), dataRoot = join(agentDir, "pi-company");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "PI_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  let host: InstalledHost | undefined, socketPath: string | undefined;
  const results: Array<{ name: string; elapsedMs: number; card: Record<string, unknown> | null; answer: string }> = [];
  try {
    const installed = await installProduct(root);
    const repo = await createSampleProject(root);
    const { repoId } = await repositoryIdentity(repo);
    await mkdir(home, { recursive: true });
    await copyCredentials(cfg.credentialsDir, agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir; process.env.HOME = home; process.env.PI_TELEMETRY = "0"; process.env.PI_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(dataRoot, repoId);
    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    for (const ask of ASKS) {
      const before = cards(host).length, started = Date.now();
      await host.session.prompt(ask.text, { source: "interactive" });
      await host.session.waitForIdle();
      while (cards(host).length === before && Date.now() - started < 15 * 60_000) await new Promise((resolve) => setTimeout(resolve, 2_000));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await host.session.waitForIdle();
      const last = host.session.messages.at(-1) as { role: string; content?: Array<{ type: string; text?: string }> };
      results.push({ name: ask.name, elapsedMs: Date.now() - started, card: cards(host)[before] ?? null,
        answer: last.role === "assistant" ? (last.content ?? []).map((block) => block.text ?? "").join("") : "" });
      await writeFile(join(evidence, "results.json"), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
    }
    const requirements = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list("requirements"));
    const sessions = withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<{ parentRole: string; requirementId: string | null }>("explore_sessions").map((row) => row.data));
    await writeFile(join(evidence, "report.json"), `${JSON.stringify({ main: mainSessionFacts(host), requirements: requirements.length, sessions, modelEvents: host.modelEvents }, null, 2)}\n`, { mode: 0o600 });
    expect(requirements).toEqual([]);
    expect(sessions.length).toBeGreaterThanOrEqual(ASKS.length);
    expect(sessions.every((session) => session.parentRole === "main" && session.requirementId === null)).toBe(true);
    for (const result of results) expect(result.card, result.name).not.toBeNull();
  } finally {
    if (host) await writeFile(join(evidence, "main-session.json"), JSON.stringify(host.session.messages, null, 2), { mode: 0o600 }).catch(() => undefined);
    if (host) await host.close().catch(() => undefined);
    let daemonGone = socketPath ? await waitMissing(socketPath, 30_000) : true;
    if (!daemonGone && socketPath) { await killUnder(root); daemonGone = await waitMissing(socketPath, 10_000); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
  }
}, 60 * 60_000);
