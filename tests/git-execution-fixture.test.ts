import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import {
  cleanupGitDaemonFixtures,
  createOwnedSpawner,
  isolatedGitEnvironment,
  ownedTempRoot,
  withGitDaemonFixtures,
} from "./helpers/git-daemon-fixture.ts";
import { withGitExecutionFixture } from "./helpers/git-execution-fixture.ts";

afterEach(() => cleanupGitDaemonFixtures());

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("scope绑定真实spawn且不改全局函数，scope关闭后拒绝迟到调用", async () => {
  let pid = 0;
  let ownedSpawn!: typeof spawn;
  const original = spawn;
  await withGitDaemonFixtures(async () => {
    const home = await ownedTempRoot("ge-home-");
    ownedSpawn = createOwnedSpawner();
    const child = ownedSpawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true, stdio: "ignore", env: isolatedGitEnvironment(home),
    });
    pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    expect(groupAlive(pid)).toBe(true);
    expect(spawn).toBe(original);
  });
  expect(groupAlive(pid)).toBe(false);
  expect(() => ownedSpawn(process.execPath, ["-e", ""], { detached: true })).toThrow(/scope已关闭/);
  expect(spawn).toBe(original);
}, 8_000);

test("Git执行fixture中的ShellRegistry真实child也由owned scope接管", async () => {
  let pid = 0;
  await withGitExecutionFixture(async ({ registry }) => {
    const started = await registry.spawn({
      taskId: crypto.randomUUID(),
      host: { kind: "main", id: "fixture-test" },
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      mode: "background",
      runToken: crypto.randomUUID(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    pid = started.task.pgid;
    expect(groupAlive(pid)).toBe(true);
  });
  expect(groupAlive(pid)).toBe(false);
}, 8_000);
