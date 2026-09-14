import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash, databaseRows, eventually, fixtureSmoke, InstalledProjectFixture } from "../helpers/project-index-installed-fixture.ts";
import type { Host, HostReply, InstalledRepository } from "../helpers/project-index-installed-fixture.ts";

// 正式执行必须在写入冻结后串行运行；fixture-smoke 不打包、不安装、不启动 daemon。
const worlds: InstalledProjectFixture[] = [];
afterEach(async (context) => {
  const errors: unknown[] = [];
  for (const world of worlds.splice(0).reverse()) { try { await world.close(context.task.result?.state === "fail"); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "M3安装夹具未完整收尾");
});
const installedTest = test.skipIf(process.platform !== "darwin");
async function world() { const result = await InstalledProjectFixture.create(); worlds.push(result); return result; }
function result(reply: HostReply, name = "pi_company_project_manage") {
  const value = reply.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
  expect(value, `缺少真实SDK ${name}结果`).toBeDefined();
  return value!;
}
async function initialize(host: Host) {
  await host.call("approve", { value: true });
  const reply = await host.call("project", { action: "init" });
  expect(result(reply).isError, JSON.stringify(result(reply))).toBe(false);
  expect(result(reply).details).toMatchObject({ action: "init", status: "ready" });
  expect(reply.node).toBe(process.execPath); expect(reply.version).toBe(process.version); expect(reply.sdkVersion).toBe("0.85.1");
  expect(reply.onPayloadCalls).toBeGreaterThan(0); expect(reply.payloadEvents).toBe(reply.onPayloadCalls);
  return reply;
}
function spec(expected: string) {
  return JSON.stringify({ $schema: "schema.json", schemaVersion: 1, feature: { id: "installed.sync", title: "当前规则", aliases: ["同步"] },
    rules: [{ id: "installed.sync.current", title: "当前行为", condition: "已初始化", trigger: "修改文件", expected,
      reason: "核对当前项目", dependsOn: [], exceptions: [], acceptance: [{ id: "current", given: "持续授权", when: "外部修改", then: expected }] }] });
}
async function waitRule(w: InstalledProjectFixture, repo: InstalledRepository, predicate: (rules: Awaited<ReturnType<typeof w.snapshot>>["rules"]) => boolean) {
  await eventually(async () => { try { return predicate((await w.snapshot(repo)).rules); } catch { return false; } }, "规则自动发布");
}
async function cleanDaemon(daemon: Awaited<ReturnType<InstalledProjectFixture["daemon"]>>) {
  const ended = await daemon.stop(); expect(ended, ended.stderr).toMatchObject({ code: 0, signal: null });
  const probe = await daemon.probe();
  expect(probe).toMatchObject({ node: process.execPath, nodeVersion: process.version, watchers: 0, forbiddenReads: 0, exited: true });
  expect(probe.closedWatchers).toBe(probe.createdWatchers); expect(existsSync(daemon.socket)).toBe(false);
}

test("fixture-smoke：短真实路径、环境隔离、只读观察不创建数据库", fixtureSmoke);
test("fixture-cleanup：stop失败和退出未知仍有界记录每个孩子并保留现场", () => InstalledProjectFixture.cleanupSmoke(), 10_000);

installedTest("M3-AC1/3/9 安装：preview不升级、自动改增删改名、双窗口、同会话重连及新会话撤权", async () => {
  const w = await world(), repo = await w.repository("r");
  for (const file of ["extensions/index.ts", "extensions/project-manage.ts", "extensions/project-baseline.ts", "runtime/project-manage-tool.ts",
    "runtime/project-index-sync.ts", "runtime/project-sync-client.ts", "runtime/project-sync-grants.ts", "runtime/project-baseline.ts",
    "runtime/project-baseline-hooks.ts", "daemon/project-index-coordinator.ts", "daemon/project-index-requirements.ts", "daemon/project-baseline-provider.ts",
    "daemon/bootstrap.mjs", "daemon/loader.mjs", "resources/spec/schema.json", "resources/tree-sitter/manifest.json", "LICENSE"]) expect(w.artifactFiles).toContain(file);
  expect(w.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  await mkdir(join(repo.path, "docs/spec"), { recursive: true });
  await copyFile(join(w.installed, "resources/spec/schema.json"), join(repo.path, "docs/spec/schema.json"));
  await writeFile(join(repo.path, "docs/spec/current.rules.json"), spec("原始行为"));
  const first = await w.daemon(repo), a = await w.host(repo);
  expect((await first.probe()).pid).toBe(first.proc.pid);
  await a.call("approve", { value: true });
  const preview = await a.call("project", { action: "init", preview: true });
  expect(result(preview).isError).toBe(false); expect(result(preview).details).toMatchObject({ action: "preview", databaseCreated: false });
  expect(existsSync(repo.indexPath)).toBe(false); expect((await first.probe()).watchers).toBe(0);
  expect(preview.confirmations).toHaveLength(1); expect(preview.confirmations[0]!.message).toContain("不能用于批准后续 init/refresh");
  const forged = await a.call("project", { action: "init", approved: true, role: "main" });
  expect(result(forged).isError).toBe(true); expect(forged.confirmations).toHaveLength(1);
  expect(existsSync(repo.indexPath)).toBe(false); expect((await first.probe()).watchers).toBe(0);
  await a.call("approve", { value: false });
  const declined = await a.call("project", { action: "init" });
  expect(result(declined).isError).toBe(true); expect(declined.confirmations).toHaveLength(2);
  expect(existsSync(repo.indexPath)).toBe(false); expect((await first.probe()).watchers).toBe(0);
  const initialized = await initialize(a);
  expect(initialized.confirmations).toHaveLength(3);
  expect(initialized.confirmations[2]!.message).toContain("当前 session");
  expect(initialized.confirmations[2]!.message).toContain("断线重连");
  expect(initialized.confirmations[2]!.message).toContain("docs/prod");
  expect(initialized.confirmations[2]!.message).toContain(repo.path);
  expect(initialized.confirmations[2]!.message).toContain(repo.dataRoot);
  const watcherCount = (await first.probe()).watchers; expect(watcherCount).toBeGreaterThan(0);
  const b = await w.host(repo); await initialize(b);
  const grants = w.grants(repo).filter((item) => item.status === "active");
  expect(grants).toHaveLength(2); expect(new Set(grants.map((item) => item.daemonInstanceId)).size).toBe(1);
  expect(new Set(grants.map((item) => item.connectionId)).size).toBe(2);
  expect((await first.probe()).watchers).toBe(watcherCount);
  expect(grants.every((grant) => /^[0-9a-f]{64}$/.test(grant.grantHash))).toBe(true);
  expect(JSON.stringify(databaseRows(repo.databasePath, "project_index_grants"))).not.toMatch(/"grantId"|"token"/);

  // 以下只写外部文件和观察已发布SQLite，不用模型请求、refresh或ensureFresh促发。
  const external = "export const external = 2;\n";
  await writeFile(join(repo.path, "source.ts"), external);
  await eventually(() => w.hasFile(repo, "source.ts", external), "外改自动发布");
  await writeFile(join(repo.path, "added.ts"), "export const added = 3;\n");
  await eventually(() => w.hasFile(repo, "added.ts"), "新增自动发布");
  await rename(join(repo.path, "added.ts"), join(repo.path, "renamed.ts"));
  await eventually(async () => await w.hasFile(repo, "renamed.ts") && !await w.hasFile(repo, "added.ts"), "改名更新路径");
  await rm(join(repo.path, "renamed.ts"));
  await eventually(async () => !(await w.snapshot(repo)).files.some((file) => file.path === "renamed.ts"), "删除清除节点");
  await writeFile(join(repo.path, "docs/spec/current.rules.json"), spec("新的行为"));
  await waitRule(w, repo, (rules) => rules[0]?.expected === "新的行为");
  await rename(join(repo.path, "docs/spec/current.rules.json"), join(repo.path, "docs/spec/renamed.rules.json"));
  await waitRule(w, repo, (rules) => rules[0]?.path === "docs/spec/renamed.rules.json");
  await rm(join(repo.path, "docs/spec/renamed.rules.json"));
  await waitRule(w, repo, (rules) => rules.length === 0);
  await writeFile(join(repo.path, "docs/spec/added.rules.json"), spec("新增规则行为"));
  await waitRule(w, repo, (rules) => rules[0]?.expected === "新增规则行为");
  await a.close();
  await eventually(() => w.grants(repo).filter((item) => item.status === "active").length === 1, "仅A撤权");
  expect((await first.probe()).watchers).toBe(watcherCount);
  await writeFile(join(repo.path, "after-a.ts"), "export const alive = true;\n");
  await eventually(() => w.hasFile(repo, "after-a.ts"), "A关闭后B持续同步");

  const before = await stat(join(repo.path, "source.ts"));
  const oldGrant = w.grants(repo).find((grant) => grant.status === "active")!;
  // 暂停本次自有宿主，避免重启空档自动拉起未登记子进程；恢复的是同一物理session。
  b.proc.kill("SIGSTOP");
  await cleanDaemon(first);
  const offline = "export const external = 9;\n";
  await writeFile(join(repo.path, "source.ts"), offline);
  // 数值秒保留亚毫秒精度，Date对象会截断原mtime，使“同mtime”夹具失真。
  await utimes(join(repo.path, "source.ts"), before.atimeMs / 1000, before.mtimeMs / 1000);
  expect((await stat(join(repo.path, "source.ts"))).size).toBe(before.size);
  expect((await stat(join(repo.path, "source.ts"))).mtimeMs).toBeCloseTo(before.mtimeMs, 2);
  const second = await w.daemon(repo); b.proc.kill("SIGCONT");
  await eventually(() => w.grants(repo).some((grant) => grant.status === "active" && grant.sessionId === oldGrant.sessionId && grant.daemonInstanceId !== oldGrant.daemonInstanceId), "同存活session重签连接授权");
  const read = await b.call("tool", { name: "read", args: { path: "source.ts" } });
  expect(result(read, "read").isError).toBe(false); expect(JSON.stringify(result(read, "read").content)).toContain("external = 9");
  expect(await w.hasFile(repo, "source.ts", offline)).toBe(true);
  expect(read.confirmations).toHaveLength(1);
  const newGrant = w.grants(repo).find((grant) => grant.status === "active")!;
  expect(newGrant.connectionId).not.toBe(oldGrant.connectionId); expect(newGrant.grantHash).not.toBe(oldGrant.grantHash);
  await b.close(); await eventually(async () => (await second.probe()).watchers === 0, "末窗口关闭回收监听");
  const c = await w.host(repo);
  const status = await c.call("project", { action: "status" });
  expect(result(status).isError).toBe(false); expect(status.sessionId).not.toBe(oldGrant.sessionId);
  expect(status.confirmations).toHaveLength(0); expect((await second.probe()).watchers).toBe(0);
  expect(w.grants(repo).every((grant) => grant.status === "revoked")).toBe(true);
  await c.call("approve", { value: false }); const denied = await c.call("project", { action: "init" });
  expect(result(denied).isError).toBe(true); expect((await second.probe()).watchers).toBe(0);
  await c.close(); await cleanDaemon(second);
}, 180_000);

installedTest("M3-AC3/4 安装：本地bare远端双克隆pull、独立索引、prod入口禁正文及旧active待核对", async () => {
  const w = await world(), seed = await w.repository("seed");
  const remote = join(w.root, "remote.git"); await w.git(w.root, ["init", "--bare", "--initial-branch=main", remote]);
  await w.git(seed.path, ["remote", "add", "origin", remote]); await w.git(seed.path, ["push", "-u", "origin", "main"]);
  const a = await w.repository("ca", remote), b = await w.repository("cb", remote);
  expect(a.dataRoot).not.toBe(b.dataRoot); expect(a.indexPath).not.toBe(b.indexPath);
  const { RequirementService } = await w.product<typeof import("../../runtime/requirement-service.ts")>("runtime/requirement-service.ts");
  const { RequirementStateStore } = await w.product<typeof import("../../runtime/requirement-state.ts")>("runtime/requirement-state.ts");
  const { uuidv7 } = await w.product<typeof import("../../runtime/database.ts")>("runtime/database.ts");
  const options = { repositoryRoot: b.path, dataRoot: b.dataRoot, repoId: b.repoId, gitExecutable: "/usr/bin/git", authorize: () => true };
  // 仅封闭的测试准备调用已安装存储层；它不证明模型拥有批准权限。扫描授权仍走真实UI。
  const service = await RequirementService.open(options), state = await RequirementStateStore.open(options);
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "归档风险", body: "LOCAL_PRIVATE_M3_INSTALL" });
  const worktree = join(w.root, "bound"); await w.git(b.path, ["worktree", "add", "-b", "fixture-bound", worktree]);
  const bound = await state.bindWorkspace({ requirementId: created.requirementId, version: created.version, path: worktree,
    prepareOperationId: uuidv7(), baseCommit: await w.git(b.path, ["rev-parse", "HEAD"]) });
  const active = await service.confirmUpdate({ requirementId: created.requirementId, version: bound.version, operationId: uuidv7(),
    title: "归档风险", body: "LOCAL_PRIVATE_M3_INSTALL", receiptId: uuidv7() });
  const lease = await state.acquirePm({ requirementId: created.requirementId, version: active.version, runId: uuidv7(), expectedFence: 0 });
  const da = await w.daemon(a), db = await w.daemon(b), ha = await w.host(a), hb = await w.host(b);
  await initialize(ha); await initialize(hb);
  const archive = `docs/prod/${created.requirementId}.归档风险.md`, secret = "ARCHIVE_PRIVATE_M3_INSTALL_DO_NOT_READ";
  await mkdir(join(seed.path, "docs/prod"), { recursive: true });
  await writeFile(join(seed.path, archive), `---\nstate: active\n---\n${secret}\n`);
  const pulled = "export const pulled = 22;\n"; await writeFile(join(seed.path, "source.ts"), pulled);
  await w.git(seed.path, ["add", "."]); await w.git(seed.path, ["commit", "-m", "shared final files"]); await w.git(seed.path, ["push", "origin", "main"]);
  await w.git(a.path, ["pull", "--ff-only"]);
  await eventually(() => w.hasFile(a, "source.ts", pulled), "A pull自动索引");
  expect(await w.hasFile(b, "source.ts", "export const initial = 1;\n")).toBe(true);
  await w.git(b.path, ["pull", "--ff-only"]);
  await eventually(() => w.hasFile(b, "source.ts", pulled), "B pull自动索引");
  await eventually(() => state.read(created.requirementId).data.recovery === "needs_review", "旧active撤权并待核对");
  expect(state.read(created.requirementId).data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "archive_found", close: null });
  expect(state.pmOwner(created.requirementId)).toMatchObject({ lease: null }); await expect(state.checkPm(lease)).rejects.toThrow(/recovery_required/);
  for (const repo of [a, b]) {
    await eventually(async () => (await w.snapshot(repo)).prodMetadata.some((item) => item.requirementId === created.requirementId && item.source === "archive"), "仅归档元数据发布");
    const snapshot = await w.snapshot(repo);
    expect(snapshot.files.some((file) => file.path.startsWith("docs/prod/"))).toBe(false);
    for (const marker of [secret, "LOCAL_PRIVATE_M3_INSTALL"]) expect(JSON.stringify(snapshot)).not.toContain(marker);
    expect(JSON.stringify(databaseRows(repo.indexPath, "source_fragments"))).not.toContain(secret);
  }
  expect(databaseRows(a.databasePath, "requirements")).toEqual([]);
  expect(databaseRows(b.databasePath, "requirements")).toHaveLength(1);
  const blocked = state.read(created.requirementId);
  await rm(join(b.path, archive));
  await eventually(async () => !(await w.snapshot(b)).prodMetadata.some((item) => item.source === "archive"), "删除归档自动对账");
  expect(state.read(created.requirementId)).toEqual(blocked);
  for (const host of [ha, hb]) {
    const reply = await host.call("text"); expect(JSON.stringify(reply.requests)).not.toContain(secret);
    expect(JSON.stringify(reply.messages)).not.toContain(secret);
  }
  expect((await da.probe()).forbiddenReads).toBe(0); expect((await db.probe()).forbiddenReads).toBe(0);
  await ha.close(); await hb.close(); await cleanDaemon(da); await cleanDaemon(db);
}, 180_000);

installedTest("M3-AC7 安装：慢模型外改标旧回复、write不执行、新请求携带当前hash", async () => {
  const w = await world(), repo = await w.repository("r"), daemon = await w.daemon(repo), host = await w.host(repo);
  await initialize(host);
  // 正向对照：工具已真实装配且能在有效基线上写入，避免把一般失败当旧基线保护。
  const valid = "export const valid = 3;\n";
  const good = await host.call("tool", { name: "write", args: { path: "source.ts", content: valid } });
  expect(result(good, "write").isError, JSON.stringify(result(good, "write"))).toBe(false);
  expect(await readFile(join(repo.path, "source.ts"), "utf8")).toBe(valid);
  await host.call("slow", { textOnly: true });
  await eventually(async () => (await host.call("slowState") as HostReply & { entered: boolean }).entered, "模型payload已发送并等待返回");
  const changed = "export const external = 4;\n"; await writeFile(join(repo.path, "source.ts"), changed);
  await eventually(() => w.hasFile(repo, "source.ts", changed), "回答中真实watch更新");
  const staleAnswer = await host.call("release");
  expect(JSON.stringify(staleAnswer.messages.filter((message) => message.role === "assistant").at(-1))).toContain("旧快照");
  const next = await host.call("text");
  expect(next.requests.at(-1)).toContain("旧快照"); expect(next.requests.at(-1)).toContain("external_or_unknown");
  const current = databaseRows<{ baselineHash: string }>(repo.indexPath, "workspaces")[0]!;
  expect(current.baselineHash).toMatch(/^[0-9a-f]{64}$/);
  expect(next.requests.at(-1)).toContain(current.baselineHash); expect(next.requests.at(-1)).toContain("generation");
  const beforeSlow = next.requests.length;
  await host.call("slow", { name: "write", args: { path: "source.ts", content: "MUST_NOT_WRITE" } });
  await eventually(async () => (await host.call("slowState") as HostReply & { entered: boolean }).entered, "旧write请求已送达受控模型");
  const newer = "export const external = 5;\n"; await writeFile(join(repo.path, "source.ts"), newer);
  await eventually(() => w.hasFile(repo, "source.ts", newer), "写入前外改已发布");
  const blocked = await host.call("release");
  expect(blocked.requests.length).toBeGreaterThan(beforeSlow);
  expect(result(blocked, "write").isError).toBe(true); expect(JSON.stringify(result(blocked, "write").content)).toContain("旧快照");
  expect(await readFile(join(repo.path, "source.ts"), "utf8")).toBe(newer);
  expect(blocked.payloadEvents).toBe(blocked.onPayloadCalls); expect(blocked.payloadEvents).toBeGreaterThan(4);
  const snapshot = await w.snapshot(repo); expect(snapshot.files.find((file) => file.path === "source.ts")?.hash).toBe(contentHash(newer));
  await host.close(); await cleanDaemon(daemon);
  // 交付seal/ROLE finalize、write/edit/Shell/commit的入口内竞争由真实source测试分别验收：
  // tests/role-project-baseline.test.ts、tests/project-baseline-host-sdk.test.ts；此用例不把提示词遵守当交付证明。
}, 120_000);
