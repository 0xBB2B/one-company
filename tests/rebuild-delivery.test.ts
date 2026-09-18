import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRepoFixture, removeRepoFixture, addWorktree, GIT_ENV } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { RunStore } from "../runtime/run-store.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { bindRunResult, checkAcceptanceReport, verifyTaskDelivery } from "../runtime/delivery.ts";

import { createClock } from "../runtime/clock.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import { createGitCommitTool } from "../runtime/git-commit-tool.ts";
import { sandboxLaunch } from "../runtime/command-boundary.ts";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("没有隔离后端的平台在启动前明确拒绝", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(() => sandboxLaunch("touch forbidden", { readRoots: [], writeRoots: [], deniedReads: [], deniedWrites: [], scratch: "/unused" })).toThrow("隔离后端");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

async function fixture() {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  const requirement = "2026-09-10.delivery";

  const identity = await repositoryIdentity(repo.root);
  const store = new RunStore({ dataRoot: home.dataRoot, repoId: identity.repoId, daemonStartedAt: new Date().toISOString() });
  const run = await store.create({ phase: "work", kind: "role", standalone: true, role: "pi-company.worker", requirement, task: "T-1", cwd: repo.root, writePaths: ["README.md"], readPaths: [repo.root], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
  const raw = { phase: "work", verdict: "PASS", summary: "现有读取行为符合规范", issues: [], evidence: ["README.md:1"], changeKind: "refactor", workState: "green-baseline-no-change", coverage: [{ ref: "demo/readme/AC-1", test: "README.md:1" }], redCommands: [], greenCommands: [{ command: "cat README.md > /dev/null", status: "passed", details: "读取通过" }], changedFiles: [], productionPath: ["README.md"], preexistingEvidence: ["README.md:1"], fakeRed: false };
  await store.update(run.id, { state: "running" });
  return { repo, home, requirement, run, store, raw };
}

test("旧无改动PASS不能绑定交付或触发复跑，真实运行数据保留", async () => {
  const world = await fixture();
  await expect(bindRunResult(world.run, "work", world.raw)).rejects.toThrow("永久淘汰");
  await world.store.update(world.run.id, { state: "completed", result: { ...world.raw, binding: { requirement: world.requirement } } });
  const found = await world.store.get(world.run.id); if (!found.ok) throw new Error("运行缺失");
  const original = JSON.stringify(found.run);
  let executed = 0;
  await expect(verifyTaskDelivery({ run: found.run, execute: async () => { executed++; } })).rejects.toThrow("永久淘汰");
  expect(executed).toBe(0);
  expect(JSON.stringify((await world.store.get(world.run.id) as { run: unknown }).run)).toBe(original);
});

test("外改后旧交付不能触发验证或覆盖当前文件", async () => {
  const world = await fixture();
  await world.store.update(world.run.id, { state: "completed", result: { ...world.raw, binding: { codeHead: "旧提交", workspaceContent: "旧指纹" } } });
  const found = await world.store.get(world.run.id); if (!found.ok) throw new Error("运行缺失");
  await writeFile(join(world.repo.root, "README.md"), "改变现场");
  let executed = false;
  await expect(verifyTaskDelivery({ run: found.run, execute: async () => { executed = true; } })).rejects.toThrow("永久淘汰");
  expect(executed).toBe(false);
  expect(await readFile(join(world.repo.root, "README.md"), "utf8")).toBe("改变现场");
});

test("旧复跑回调不能凭假PASS写文件或生成验证凭据", async () => {
  const world = await fixture();
  const before = await readFile(join(world.repo.root, "README.md"), "utf8");
  await world.store.update(world.run.id, { state: "completed", result: { ...world.raw, binding: {}, delivery: { verificationOk: true } } });
  const found = await world.store.get(world.run.id); if (!found.ok) throw new Error("运行缺失");
  let executed = 0;
  await expect(verifyTaskDelivery({ run: found.run, execute: async () => {
    executed++; await writeFile(join(world.repo.root, "README.md"), "复跑产生未提交变化");
  } })).rejects.toThrow("永久淘汰");
  expect(executed).toBe(0);
  expect(await readFile(join(world.repo.root, "README.md"), "utf8")).toBe(before);
});

test("验收裁决必须对应真实报告内容和实际命令", async () => {
  const world = await fixture();
  const path = join(world.repo.root, "acceptance.md");
  const value = { phase: "acceptance" as const, verdict: "PASS" as const, summary: "验收通过", issues: [], evidence: ["真实报告"], acceptanceResult: "accepted" as const, reportPath: path, items: [{ id: "AC-1", result: "PASS" as const, observed: "能够读取", difference: "" }], uncovered: [] };
  await writeFile(path, "---\ndate: 2026-09-10\nresult: accepted\n---\n## 验收结果\n| AC-1 | PASS | 能够读取 | |\n## 所用命令\ncat README.md\n");
  expect(await checkAcceptanceReport(value, path, ["cat README.md"])).toMatch(/^[a-f0-9]{64}$/);
  await expect(checkAcceptanceReport(value, path, ["npm test"])).rejects.toThrow("实际执行");
  await writeFile(path, (await readFile(path, "utf8")).replace("| PASS |", "| FAIL |"));
  await expect(checkAcceptanceReport(value, path)).rejects.toThrow("不一致");
});

test("真实命令隔离允许任务写入、阻止跨仓读写和修改流程数据", async () => {
  const world = await fixture();
  const foreign = await createRepoFixture(); cleanup.push(() => removeRepoFixture(foreign));
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const host = { kind: "role" as const, id: world.run.id, runId: world.run.id, role: "worker" };
  cleanup.push(() => shells.stopHost(host));
  const protection = await createRangeProtection({ cwd: world.repo.root, dataRoot: world.home.dataRoot, holder: { kind: "role", runId: world.run.id, requirement: world.requirement }, writePaths: ["README.md"], clock, shells });
  cleanup.push(async () => { await world.store.update(world.run.id, { state: "failed" }); await protection.release(); });
  const bash = createManagedBashOperations({ registry: shells, host, runToken: world.run.shellToken, guard: protection.commandGuard });
  const run = (command: string) => bash.exec(command, world.repo.root, { onData: () => {}, timeout: 5 });
  expect((await run("printf ok > README.md")).exitCode).toBe(0);
  expect((await run("test \"$(cat README.md)\" = ok")).exitCode).toBe(0);
  expect((await run(`cat '${foreign.root}/README.md'`)).exitCode).not.toBe(0);
  expect((await run(`printf bad > '${foreign.root}/README.md'`)).exitCode).not.toBe(0);
  expect((await run(`printf bad > '${world.home.dataRoot}/forged.json'`)).exitCode).not.toBe(0);
  expect(await readFile(join(world.repo.root, "README.md"), "utf8")).toBe("ok");
});

test("真实 linked worktree 可正常提交，命令不继承认证环境变量，只读角色不能改源码", async () => {
  const world = await fixture();
  const worktree = await addWorktree(world.repo);
  await exec("git", ["config", "user.name", "Test"], { cwd: worktree.root, env: GIT_ENV });
  await exec("git", ["config", "user.email", "test@example.test"], { cwd: worktree.root, env: GIT_ENV });
  const clock = createClock(); cleanup.push(async () => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const host = { kind: "role" as const, id: world.run.id, runId: world.run.id, role: "worker" };
  const protection = await createRangeProtection({ cwd: worktree.root, dataRoot: world.home.dataRoot, holder: { kind: "role", runId: world.run.id, requirement: world.requirement }, writePaths: ["README.md"], clock, shells });
  cleanup.push(async () => { await shells.stopHost(host); await world.store.update(world.run.id, { state: "failed" }); await protection.release(); });
  const bash = createManagedBashOperations({ registry: shells, host, runToken: world.run.shellToken, guard: protection.commandGuard });
  const before = process.env.PI_COMPANY_TEST_SECRET;
  process.env.PI_COMPANY_TEST_SECRET = "不得传给命令";
  try {
    const outcome = await bash.exec("test -z \"$PI_COMPANY_TEST_SECRET\" && printf hello > README.md", worktree.root, { onData: () => {}, timeout: 10 });
    expect(outcome.exitCode).toBe(0);
    const commit = createGitCommitTool(async () => protection.commit);
    await commit.execute("commit", { paths: ["README.md"], message: "worktree 提交" }, undefined, undefined, { cwd: worktree.root } as never);
    expect((await exec("git", ["show", "HEAD:README.md"], { cwd: worktree.root, env: GIT_ENV })).stdout).toBe("hello");
  } finally {
    if (before === undefined) delete process.env.PI_COMPANY_TEST_SECRET;
    else process.env.PI_COMPANY_TEST_SECRET = before;
  }
  const readonly = await createRangeProtection({ cwd: worktree.root, dataRoot: world.home.dataRoot, holder: { kind: "role", runId: world.run.id, requirement: world.requirement }, writePaths: [], clock, shells });
  cleanup.push(() => readonly.release());
  const review = createManagedBashOperations({ registry: shells, host, runToken: world.run.shellToken, guard: readonly.commandGuard });
  expect((await review.exec("printf bad > README.md", worktree.root, { onData: () => {}, timeout: 5 })).exitCode).not.toBe(0);
  expect(await readFile(join(worktree.root, "README.md"), "utf8")).toBe("hello");
});
