import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { createClock } from "../../src/core/policy/clock.ts";
import { connectDaemon } from "../../src/core/host/daemon-client.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../src/core/storage/identity.ts";
import { killDaemon, resolveSdkDir, spawnDaemonProcess, waitForSocketReady } from "../helpers/daemon-harness.ts";
import { PROVIDER_REQUESTS_LOG_ENV_VAR, PROVIDER_SCRIPTS_ENV_VAR } from "../helpers/model-provider-module.ts";
import { createPmIntakeFixture } from "../helpers/pm-intake-fixture.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const providerModule = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers", "model-provider-module.ts");
const until = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("等待超时");
};

async function firstPmRequestProvider(trust: boolean | undefined) {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const agentDir = dirname(fixture.dataRoot);
  await mkdir(join(fixture.repositoryRoot, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ "one-company": { pm: { model: "user-model/test", thinking: null } } }));
  await writeFile(join(fixture.repositoryRoot, ".pi", "settings.json"), JSON.stringify({ "one-company": { pm: { model: "project-model/test", thinking: null } } }));
  if (trust !== undefined) new ProjectTrustStore(agentDir).set(fixture.repositoryRoot, trust);
  const record = fixture.state.read(fixture.requirementId).data;
  fixture.db((db) => {
    db.create("managed_workspaces", fixture.requirementId, { format: "managed-workspace/v1", requirementId: fixture.requirementId, title: "角色跳跃", operationId: uuidv7(),
      baseCommit: record.workspace!.baseCommit, branch: record.workspace!.branch, path: record.workspace!.path, status: "ready", recycleOperationId: null });
  });
  fixture.state.releasePm(fixture.lease);
  const scripts = join(fixture.root, "scripts.json"), log = join(fixture.root, "requests.jsonl");
  await writeFile(scripts, JSON.stringify(["gate-model", "user-model", "project-model"].map((providerId) =>
    ({ providerId, modelId: "test", replies: [{ type: "text", text: "收到" }] }))));
  const home = await createTempHome(); cleanups.push(() => removeTempHome(home));
  const { commonDir } = await repositoryIdentity(fixture.repositoryRoot);
  const daemon = spawnDaemonProcess({ home, repoDir: commonDir, dataRoot: fixture.dataRoot, extraEnv: { ONE_COMPANY_MODEL_PROVIDER_MODULE: providerModule,
    [PROVIDER_SCRIPTS_ENV_VAR]: scripts, [PROVIDER_REQUESTS_LOG_ENV_VAR]: log } });
  cleanups.push(() => killDaemon(daemon).catch(() => undefined));
  await Promise.race([waitForSocketReady(daemonSocketPath(fixture.dataRoot, fixture.repoId)), daemon.exited.then(() => { throw new Error("daemon_exited_before_ready"); })]);
  const clock = createClock(); cleanups.push(() => clock.stopGapWatcher());
  const client = await connectDaemon({ repoDir: record.workspace!.path, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock, connectOnly: true,
    hello: { windowId: uuidv7(), sessionId: SessionManager.inMemory(record.workspace!.path).getSessionId() } });
  cleanups.push(async () => { await client.close?.(); });
  await client.call("agents.dispatchPm", { requirementId: fixture.requirementId, model: { provider: "gate-model", id: "test" }, thinking: "off" });
  const requests = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { providerId: string });
  await until(async () => (await requests()).length > 0);
  return (await requests())[0]!.providerId;
}

test("授信记录里没有这个项目时，PM 用用户层设定的模型，项目层的设定不生效", async () => {
  expect(await firstPmRequestProvider(undefined)).toBe("user-model");
}, 120_000);

test("授信记录为 true 时，PM 用项目层设定的模型", async () => {
  expect(await firstPmRequestProvider(true)).toBe("project-model");
}, 120_000);
