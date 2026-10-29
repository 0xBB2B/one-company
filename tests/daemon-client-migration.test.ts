import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceClients } from "../src/core/host/daemon-client.ts";
import type { WorkspaceClientsHandle } from "../src/core/host/daemon-client.ts";
import type { BeforeSpawn } from "../src/core/host/database-migration-prompt.ts";
import { AdvisedError } from "../src/core/exec/tool-failure.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { resolveSdkDir } from "./helpers/daemon-harness.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

let repo: RepoFixture | undefined;
let dataRoot: string | undefined;
let handle: WorkspaceClientsHandle | undefined;

afterEach(async () => {
  handle?.closeAll(); handle = undefined;
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  if (repo) await removeRepoFixture(repo);
  dataRoot = undefined; repo = undefined;
});

test("守护进程连不上时拉起前调用 beforeSpawn；返回 declined 则调用抛 AdvisedError 且不重连", async () => {
  repo = await createRepoFixture();
  dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  const { repoId } = await repositoryIdentity(repo.root);
  const why = "守护进程不可达：仓库 测试 的本机数据库是旧版本，用户这次选了暂不迁移";
  const next = "请用户重开 pi 窗口，在提示框里选「迁移」";
  const calls: Array<{ repoId: string; commonDir: string }> = [];
  const beforeSpawn: BeforeSpawn = async (target) => {
    calls.push(target);
    return { proceed: false, code: "database_migration_declined", why, next };
  };
  handle = await WorkspaceClients.create({
    workspaceRoot: repo.root, dataRoot, sdkDir: resolveSdkDir(),
    hello: { windowId: "window-migration", sessionId: "session-migration" }, beforeSpawn,
  });
  const client = handle.forRepo(repoId)!;
  const error = await client.call("ping").then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(AdvisedError);
  expect((error as AdvisedError).code).toBe("database_migration_declined");
  expect((error as AdvisedError).advice).toEqual({ why, next });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.repoId).toBe(repoId);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  expect(calls).toHaveLength(1);
}, 20000);

test("beforeSpawn 本身抛错：调用抛 database_migration_failed，且不重连、不反复检查", async () => {
  repo = await createRepoFixture();
  dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  const { repoId } = await repositoryIdentity(repo.root);
  let calls = 0;
  const beforeSpawn: BeforeSpawn = async () => { calls++; throw new Error("读不出仓库的工作树"); };
  handle = await WorkspaceClients.create({
    workspaceRoot: repo.root, dataRoot, sdkDir: resolveSdkDir(),
    hello: { windowId: "window-migration", sessionId: "session-migration" }, beforeSpawn,
  });
  const error = await handle.forRepo(repoId)!.call("ping").then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(AdvisedError);
  expect((error as AdvisedError).code).toBe("database_migration_failed");
  expect((error as AdvisedError).advice.why).toContain("读不出仓库的工作树");
  expect((error as AdvisedError).advice.next).toBe("请用户重开 pi 窗口再试一次迁移；仍然失败就把原因告诉用户");
  await new Promise((resolve) => setTimeout(resolve, 3500));
  expect(calls).toBe(1);
}, 20000);
