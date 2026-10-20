import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryDatabase, uuidv7, withDatabase } from "../../../src/core/storage/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../../src/core/storage/identity.ts";
import type { RequirementRecord } from "../../../src/modules/requirement/requirement-contracts.ts";
import { RequirementService } from "../../../src/modules/requirement/requirement-service.ts";
import { approveWithManifest } from "../../helpers/approval-fixture.ts";
import { killUnder, mainSessionFacts, waitMissing } from "./evidence.ts";
import { copyCredentials, installProduct, startInstalledHost } from "./installed-host.ts";
import type { AcceptanceConfig, InstalledHost } from "./installed-host.ts";
import { pointEvidence } from "./point-pm.ts";
import { createSampleProject } from "./sample-project.ts";
import { stubOpen } from "./stub-open.ts";

const exec = promisify(execFile);
export interface PointPlace { repo: string; dataRoot: string; repoId: string }

/** 不经模型直接建好并批准一个需求（不授权实施，不派 PM），返回需求编号。 */
export async function seedApproved(place: PointPlace, title: string, body: string): Promise<string> {
  const config = { repositoryRoot: place.repo, dataRoot: place.dataRoot, repoId: place.repoId };
  const service = await RequirementService.open({ ...config, authorize: () => true });
  const created = await service.create({ operationId: uuidv7(), requestId: uuidv7(), title, body });
  await approveWithManifest(config, { requirementId: created.requirementId, savedOperationId: created.operationId, implement: false });
  return created.requirementId;
}

/**
 * 主代理单点：装好产品、建样例项目，由 seed 不经模型准备好需求等前置数据，再启动主会话；主代理与内部模型调用都用真实模型。
 * close 时把主会话与内部调用写进证据目录，结束守护进程并删掉凭据。
 */
export async function startMainPoint(config: AcceptanceConfig, name: string, options: { conventions?: string; seed?(place: PointPlace): Promise<void> } = {}) {
  const evidence = await pointEvidence(config, name);
  const root = await mkdtemp(join(tmpdir(), "pt-"));
  const agentDir = join(root, "agent"), home = join(root, "home"), dataRoot = join(agentDir, "one-company");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "ONE_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  const installed = await installProduct(root);
  const repo = await createSampleProject(root);
  if (options.conventions) {
    await writeFile(join(repo, "AGENTS.md"), options.conventions);
    await exec("git", ["add", "AGENTS.md"], { cwd: repo });
    await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "项目规范"], { cwd: repo });
  }
  const { repoId } = await repositoryIdentity(repo);
  await mkdir(home, { recursive: true });
  await copyCredentials(config.credentialsDir, agentDir);
  await options.seed?.({ repo, dataRoot, repoId });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  process.env.PI_TELEMETRY = "0";
  process.env.ONE_COMPANY_IDLE_TIMEOUT_MS = "2000";
  const restoreOpen = await stubOpen();
  const host: InstalledHost = await startInstalledHost({ installed, repo, agentDir, config });
  const results = (since: number) => host.session.messages.slice(since).flatMap((message) => message.role === "toolResult"
    ? [{ tool: message.toolName, isError: message.isError === true, text: message.content.map((block) => block.type === "text" ? block.text : "").join("") }] : []);
  const calls = (since: number) => host.session.messages.slice(since).flatMap((message) => message.role === "assistant"
    ? message.content.flatMap((block) => block.type === "toolCall" ? [{ name: block.name, args: block.arguments as Record<string, unknown> }] : []) : []);
  return {
    host, repo, dataRoot, repoId, evidence, results, calls,
    requirements: () => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<RequirementRecord>("requirements").map((row) => row.data)),
    async say(text: string) {
      await host.session.prompt(text, { source: "interactive" });
      await host.session.waitForIdle();
    },
    async close(judgement: unknown) {
      await writeFile(join(evidence, "judgement.json"), `${JSON.stringify(judgement, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(evidence, "report.json"), `${JSON.stringify({ main: mainSessionFacts(host), dialogs: host.dialogs, modelEvents: host.modelEvents }, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(evidence, "main-session.json"), JSON.stringify(host.session.messages, null, 2), { mode: 0o600 });
      await writeFile(join(evidence, "side-calls.json"), JSON.stringify(host.sideCalls, null, 2), { mode: 0o600 });
      await host.close().catch(() => undefined);
      const socket = daemonSocketPath(dataRoot, repoId);
      let gone = await waitMissing(socket, 30_000);
      if (!gone) { await killUnder(root); gone = await waitMissing(socket, 10_000); }
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await restoreOpen();
      await rm(join(agentDir, "auth.json"), { force: true });
      await rm(join(agentDir, "models.json"), { force: true });
      if (gone) await rm(root, { recursive: true, force: true });
    },
  };
}
