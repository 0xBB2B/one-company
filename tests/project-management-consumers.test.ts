import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";


for (const mode of ["native", "loader"]) test(`持久管理消费者：真实SQLite/SDK与${mode}加载入口`, async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [new URL("./helpers/project-management-consumers.mjs", import.meta.url).pathname, mode],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ node: process.version, mode, installed: false, cleaned: true });
  expect(result.records.map((row: { scenario: string }) => row.scenario)).toEqual([
    "cancelled", "deleted-index", "legacy-index", "unknown-record", "missing-data", "other-worktree", "legacy", "sdk-inflight-registration",
  ]);
  expect(result.records.every((row: { passed: boolean }) => row.passed)).toBe(true);
  expect(stderr).not.toContain("NO_PROJECT_BODY_IO");
}, 70_000);
