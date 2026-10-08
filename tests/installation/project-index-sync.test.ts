import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseRows, fixtureSmoke, InstalledProjectFixture } from "../helpers/project-index-installed-fixture.ts";
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
function result(reply: HostReply, name = "one_company_project_manage") {
  const value = reply.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
  expect(value, `缺少真实SDK ${name}结果`).toBeDefined();
  return value!;
}
async function initialize(host: Host) {
  await host.call("approve", { value: true });
  const reply = await host.call("project", { action: "init" });
  expect(result(reply).isError, JSON.stringify(result(reply))).toBe(false);
  expect(result(reply).details).toMatchObject({ action: "init", status: "ready" });
  expect(reply.node).toBe(process.execPath); expect(reply.version).toBe(process.version); expect(reply.sdkVersion).toBe("0.87.1");
  expect(reply.onPayloadCalls).toBeGreaterThan(0); expect(reply.payloadEvents).toBe(reply.onPayloadCalls);
  return reply;
}
function spec(expected: string) {
  return JSON.stringify({ $schema: "schema.json", schemaVersion: 1, feature: { id: "installed.sync", title: "遗留规则文件", aliases: ["同步"] },
    rules: [{ id: "installed.sync.current", title: "当前行为", condition: "已初始化", trigger: "修改文件", expected,
      reason: "核对当前项目", dependsOn: [], exceptions: [], acceptance: [{ id: "current", given: "已初始化", when: "外部修改", then: expected }] }] });
}
async function query(host: Host, repo: InstalledRepository, request: Record<string, unknown>): Promise<string> {
  const reply = await host.call("tool", { name: "one_company_knowledge_query", args: { repoId: repo.repoId, query: request } });
  const value = result(reply, "one_company_knowledge_query");
  expect(value.isError, JSON.stringify(value)).toBe(false);
  return JSON.stringify(value.content);
}
const exact = (path: string) => ({ action: "exact", by: "path", value: path });
async function cleanDaemon(daemon: Awaited<ReturnType<InstalledProjectFixture["daemon"]>>) {
  const ended = await daemon.stop(); expect(ended, ended.stderr).toMatchObject({ code: 0, signal: null });
  const probe = await daemon.probe();
  expect(probe).toMatchObject({ node: process.execPath, nodeVersion: process.version, forbiddenReads: 0, exited: true });
  expect(existsSync(daemon.socket)).toBe(false);
}

test("fixture-smoke：短真实路径、环境隔离、只读观察不创建数据库", fixtureSmoke);
test("fixture-cleanup：stop失败和退出未知仍有界记录每个孩子并保留现场", () => InstalledProjectFixture.cleanupSmoke(), 10_000);

installedTest("M3-AC1/3/9 安装：preview不升级、查询前对账读到增删改名、双窗口、daemon重启后同mtime离线改动及新会话无需再批准", async () => {
  const w = await world(), repo = await w.repository("r");
  for (const file of ["extensions/index.ts", "extensions/project-manage.ts", "extensions/knowledge-query.ts", "runtime/project-manage-tool.ts",
    "runtime/knowledge-query-tool.ts", "daemon/project-index-host.ts", "daemon/project-index-requirements.ts",
    "daemon/bootstrap.mjs", "daemon/loader.mjs", "resources/tree-sitter/manifest.json", "LICENSE"]) expect(w.artifactFiles).toContain(file);
  expect(w.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  await mkdir(join(repo.path, "docs/spec"), { recursive: true });
  await writeFile(join(repo.path, "docs/spec/current.rules.json"), spec("原始行为"));
  const first = await w.daemon(repo), a = await w.host(repo);
  expect((await first.probe()).pid).toBe(first.proc.pid);
  const uninitialized = await a.call("tool", { name: "one_company_knowledge_query", args: { repoId: repo.repoId, query: exact("source.ts") } });
  expect(result(uninitialized, "one_company_knowledge_query").isError).toBe(true);
  await a.call("approve", { value: true });
  const preview = await a.call("project", { action: "init", preview: true });
  expect(result(preview).isError).toBe(false); expect(result(preview).details).toMatchObject({ action: "preview", databaseCreated: false });
  expect(existsSync(repo.indexPath)).toBe(false);
  expect(preview.confirmations).toHaveLength(1); expect(preview.confirmations[0]!.message).toContain("不能用于批准后续 init/refresh");
  const forged = await a.call("project", { action: "init", approved: true, role: "main" });
  expect(result(forged).isError).toBe(true); expect(forged.confirmations).toHaveLength(1);
  expect(existsSync(repo.indexPath)).toBe(false);
  await a.call("approve", { value: false });
  const declined = await a.call("project", { action: "init" });
  expect(result(declined).isError).toBe(true); expect(declined.confirmations).toHaveLength(2);
  expect(existsSync(repo.indexPath)).toBe(false);
  const initialized = await initialize(a);
  expect(initialized.confirmations).toHaveLength(3);
  expect(initialized.confirmations[2]!.message).toContain("docs/prod");
  expect(initialized.confirmations[2]!.message).toContain(repo.path);
  expect(initialized.confirmations[2]!.message).toContain(repo.dataRoot);
  const b = await w.host(repo);
  expect(await query(b, repo, exact("source.ts"))).toContain("initial = 1");

  // 只写外部文件，由下一次查询前对账发现变化；不调用refresh。
  await writeFile(join(repo.path, "source.ts"), "export const external = 2;\n");
  expect(await query(a, repo, exact("source.ts"))).toContain("external = 2");
  await writeFile(join(repo.path, "added.ts"), "export const added = 3;\n");
  expect(await query(a, repo, exact("added.ts"))).toContain("added = 3");
  await rename(join(repo.path, "added.ts"), join(repo.path, "renamed.ts"));
  expect(await query(a, repo, exact("renamed.ts"))).toContain("added = 3");
  expect((await w.snapshot(repo)).files.some((file) => file.path === "added.ts")).toBe(false);
  await rm(join(repo.path, "renamed.ts"));
  await query(a, repo, exact("source.ts"));
  expect((await w.snapshot(repo)).files.some((file) => file.path === "renamed.ts")).toBe(false);
  await writeFile(join(repo.path, "docs/spec/current.rules.json"), spec("新的行为"));
  expect(await query(a, repo, { action: "search", text: "当前行为" })).toContain("新的行为");
  await rename(join(repo.path, "docs/spec/current.rules.json"), join(repo.path, "docs/spec/renamed.rules.json"));
  expect(await query(a, repo, { action: "search", text: "当前行为" })).toContain("docs/spec/renamed.rules.json");
  await a.close();
  await writeFile(join(repo.path, "after-a.ts"), "export const alive = true;\n");
  expect(await query(b, repo, exact("after-a.ts"))).toContain("alive = true");
  await b.close();

  const before = await stat(join(repo.path, "source.ts"));
  await cleanDaemon(first);
  await writeFile(join(repo.path, "source.ts"), "export const external = 9;\n");
  // 数值秒保留亚毫秒精度，Date对象会截断原mtime，使“同mtime”夹具失真。
  await utimes(join(repo.path, "source.ts"), before.atimeMs / 1000, before.mtimeMs / 1000);
  expect((await stat(join(repo.path, "source.ts"))).size).toBe(before.size);
  expect((await stat(join(repo.path, "source.ts"))).mtimeMs).toBeCloseTo(before.mtimeMs, 2);
  const second = await w.daemon(repo), c = await w.host(repo);
  const status = await c.call("project", { action: "status" });
  expect(result(status).isError).toBe(false); expect(status.confirmations).toHaveLength(0);
  const offline = await c.call("tool", { name: "one_company_knowledge_query", args: { repoId: repo.repoId, query: exact("source.ts") } });
  expect(JSON.stringify(result(offline, "one_company_knowledge_query").content)).toContain("external = 9");
  expect(offline.confirmations).toHaveLength(0);
  await c.close(); await cleanDaemon(second);
}, 180_000);

installedTest("M3-AC3/4 安装：本地bare远端双克隆pull、独立索引、查询前对账经归档核对、prod入口禁正文及旧active待核对", async () => {
  const w = await world(), seed = await w.repository("seed");
  const remote = join(w.root, "remote.git"); await w.git(w.root, ["init", "--bare", "--initial-branch=main", remote]);
  await w.git(seed.path, ["remote", "add", "origin", remote]); await w.git(seed.path, ["push", "-u", "origin", "main"]);
  const a = await w.repository("ca", remote), b = await w.repository("cb", remote);
  expect(a.dataRoot).not.toBe(b.dataRoot); expect(a.indexPath).not.toBe(b.indexPath);
  const { RequirementService } = await w.product<typeof import("../../runtime/requirement-service.ts")>("runtime/requirement-service.ts");
  const { RequirementStateStore } = await w.product<typeof import("../../runtime/requirement-state.ts")>("runtime/requirement-state.ts");
  const { uuidv7 } = await w.product<typeof import("../../runtime/database.ts")>("runtime/database.ts");
  const options = { repositoryRoot: b.path, dataRoot: b.dataRoot, repoId: b.repoId, authorize: () => true };
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
  expect(await query(ha, a, exact("source.ts"))).toContain("pulled = 22");
  // 不监听文件：B未查询前索引保持旧内容。
  expect(await w.hasFile(b, "source.ts", "export const initial = 1;\n")).toBe(true);
  await w.git(b.path, ["pull", "--ff-only"]);
  expect(state.read(created.requirementId).data.recovery).not.toBe("needs_review");
  expect(await query(hb, b, exact("source.ts"))).toContain("pulled = 22");
  // 查询返回时归档风险核对已完成。
  expect(state.read(created.requirementId).data).toMatchObject({ lifecycle: "active", recovery: "needs_review", recoveryReason: "archive_found", close: null });
  expect(state.pmOwner(created.requirementId)).toMatchObject({ lease: null }); await expect(state.checkPm(lease)).rejects.toThrow(/recovery_required/);
  for (const repo of [a, b]) {
    const snapshot = await w.snapshot(repo);
    expect(snapshot.prodMetadata.some((item) => item.requirementId === created.requirementId && item.source === "archive")).toBe(true);
    expect(snapshot.files.some((file) => file.path.startsWith("docs/prod/"))).toBe(false);
    for (const marker of [secret, "LOCAL_PRIVATE_M3_INSTALL"]) expect(JSON.stringify(snapshot)).not.toContain(marker);
    expect(JSON.stringify(databaseRows(repo.indexPath, "source_fragments"))).not.toContain(secret);
  }
  expect(databaseRows(a.databasePath, "requirements")).toEqual([]);
  expect(databaseRows(b.databasePath, "requirements")).toHaveLength(1);
  const blocked = state.read(created.requirementId);
  await rm(join(b.path, archive));
  await query(hb, b, exact("source.ts"));
  expect((await w.snapshot(b)).prodMetadata.some((item) => item.source === "archive")).toBe(false);
  expect(state.read(created.requirementId)).toEqual(blocked);
  for (const host of [ha, hb]) {
    const reply = await host.call("text"); expect(JSON.stringify(reply.requests)).not.toContain(secret);
    expect(JSON.stringify(reply.messages)).not.toContain(secret);
  }
  expect((await da.probe()).forbiddenReads).toBe(0); expect((await db.probe()).forbiddenReads).toBe(0);
  await ha.close(); await hb.close(); await cleanDaemon(da); await cleanDaemon(db);
}, 180_000);

installedTest("M9-AC1 安装：删除 index.db 后重启，下一次查询从允许文件自动重建并读到当前内容，不再弹确认，归档仍排除", async () => {
  const w = await world(), repo = await w.repository("rebuild");
  const secret = "ARCHIVE_PRIVATE_M9_REBUILD_DO_NOT_READ";
  await mkdir(join(repo.path, "docs/prod"), { recursive: true });
  await writeFile(join(repo.path, "docs/prod/0197b7b0-6a20-7c51-8a32-b9465fb72d10.旧需求.md"), `${secret}\n`);
  const first = await w.daemon(repo), a = await w.host(repo);
  await initialize(a);
  expect(await query(a, repo, exact("source.ts"))).toContain("initial = 1");
  await a.close(); await cleanDaemon(first);

  for (const suffix of ["", "-wal", "-shm"]) await rm(`${repo.indexPath}${suffix}`, { force: true });
  await writeFile(join(repo.path, "source.ts"), "export const rebuilt = 7;\n");
  const second = await w.daemon(repo), b = await w.host(repo);
  const rebuilt = await b.call("tool", { name: "one_company_knowledge_query", args: { repoId: repo.repoId, query: exact("source.ts") } });
  expect(result(rebuilt, "one_company_knowledge_query").isError).toBe(false);
  expect(rebuilt.confirmations).toHaveLength(0);
  expect(JSON.stringify(result(rebuilt, "one_company_knowledge_query").content)).toContain("rebuilt = 7");
  expect(existsSync(repo.indexPath)).toBe(true);
  const snapshot = await w.snapshot(repo);
  expect(snapshot.files.some((file) => file.path.startsWith("docs/prod/"))).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(JSON.stringify(databaseRows(repo.indexPath, "source_fragments"))).not.toContain(secret);
  expect((await second.probe()).forbiddenReads).toBe(0);
  await b.close(); await cleanDaemon(second);
}, 180_000);
