import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalDatabase, repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { draftApprover } from "./helpers/approval-fixture.ts";
import type { WriteGrant } from "./helpers/approval-fixture.ts";
import { createChangeApplyTool, retireRunChangeSetsIn } from "../src/modules/verification/change-apply.ts";
import type { ChangeApplyGrant, ChangeApplyToolOptions } from "../src/modules/verification/change-apply.ts";
import * as store from "../src/core/storage/store.ts";
import { createRepoFixture, addWorktree, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 目标 {#goals}\n保留移动。\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "change-apply-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const grants = new Map<string, { action: string; intent: string; receiptId?: string }>();
  const service = await RequirementService.open({ ...options, authorize: (request) => {
    if (request.repoId !== options.repoId) return false;
    if (request.action === "metadata") return true;
    const grant = request.operationId ? grants.get(request.operationId) : undefined;
    return !!grant && grant.action === request.action && grant.intent === request.intentHash && grant.receiptId === request.receiptId;
  }, authorizeManifest: () => true });
  const grantWrite: WriteGrant = (r) => grants.set(r.operationId, { action: r.action, intent: requirementIntentHash({ title: r.title, body: r.body }), receiptId: r.receiptId });
  const state = await RequirementStateStore.open({ ...options, authorize: (request) => request.repoId === options.repoId &&
    ["open", "read", "bind-workspace", "begin-close"].includes(request.action) });
  const create = { requestId: uuidv7(), operationId: uuidv7(), title: "角色跳跃", body: BODY };
  grants.set(create.operationId, { action: "create", intent: requirementIntentHash({ title: create.title, body: BODY }) });
  const created = await service.create(create);
  const worktree = await addWorktree(repo);
  const baseCommit = (await runGit(["rev-parse", "HEAD"], worktree.root)).trim();
  await state.bindWorkspace({ requirementId: created.requirementId, version: state.read(created.requirementId).version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  await draftApprover(options, service, { requirementId: created.requirementId, operationId: created.operationId, title: "角色跳跃", body: BODY }, grantWrite)();
  const record = state.read(created.requirementId).data;
  const workspace = record.workspace!;
  await mkdir(join(worktree.root, "src"), { recursive: true });
  await writeFile(join(worktree.root, "src", "a.ts"), "export const a = 1;\n");
  await runGit(["add", "."], worktree.root); await runGit(["commit", "-qm", "seed"], worktree.root);
  const permits = new Map<string, string>();
  function grant(extra: Partial<ChangeApplyGrant> = {}): ChangeApplyGrant {
    return { role: "worker", callerId: uuidv7(), runId: uuidv7(), requirementId: created.requirementId, repoId: options.repoId,
      workspaceId: workspace.workspaceId, branch: workspace.branch, epoch: record.epoch, writePaths: ["src/", "package.json"], ...extra };
  }
  const host: ChangeApplyToolOptions["authorize"] = (request) => permits.get(request.grant.callerId) === JSON.stringify(request.grant);
  async function tool(bound = grant(), authorize = host) {
    permits.set(bound.callerId, JSON.stringify(bound));
    const instance = await createChangeApplyTool({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, grant: bound, authorize });
    cleanups.push(async () => instance.dispose()); return instance;
  }
  const read = (path: string) => readFile(join(worktree.root, path), "utf8");
  const base = sha("export const a = 1;\n");
  return { ...options, root, repo, state, created, workspace, worktree, grant, tool, read, base };
}
type Result = { status: string; operationId: string; baseHead: string; files: Array<{ path: string; status: string; reason?: string; targetHash: string }> };

test("M5-AC1：无效批量补丁预检整批拒绝、不写任何文件、不留操作记录", async () => {
  const w = await world(); const tool = await w.tool();
  const good = { path: "src/b.ts", baseHash: "absent", content: "export const b = 2;\n" };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["forbidden_path", { path: "docs/prd/x.md", baseHash: "absent", content: "x" }],
    ["forbidden_path", { path: ".git/hooks/pre-commit", baseHash: "absent", content: "x" }],
    ["forbidden_path", { path: ".pi/agents/worker.md", baseHash: "absent", content: "x" }],
    ["forbidden_path", { path: ".pi/skills/requirement-doc/SKILL.md", baseHash: "absent", content: "x" }],
    ["forbidden_path", { path: "AGENTS.md", baseHash: "absent", content: "x" }],
    ["forbidden_path", { path: "../outside.ts", baseHash: "absent", content: "x" }],
    ["out_of_scope", { path: "lib/c.ts", baseHash: "absent", content: "x" }],
    ["stale_base", { path: "src/a.ts", baseHash: sha("旧内容"), content: "x" }],
    ["invalid_shape", { path: "src/b.ts", baseHash: "absent", content: "dup" }],
    ["invalid_shape", { path: "src/gone.ts", baseHash: "absent", content: null }],
  ];
  for (const [code, bad] of cases) {
    await expect(tool.execute({ action: "apply", files: [good, bad] })).rejects.toMatchObject({ code });
    await expect(w.read("src/b.ts")).rejects.toMatchObject({ code: "ENOENT" });
  }
  await expect(w.read("src/a.ts")).resolves.toBe("export const a = 1;\n");
  await expect(tool.execute({ action: "prepare", files: [{ path: "src/a.ts", baseHash: "absent", content: "x" }] }))
    .rejects.toThrow(`stale_base: src/a.ts 当前 baseHash=${w.base}`);
  const filled = await tool.execute({ action: "prepare", files: [{ path: "src/a.ts", content: "x" }, { path: "src/new.ts", content: "y" }] }) as Result;
  expect(filled.files.map((file: { baseHash: string }) => file.baseHash)).toEqual([w.base, "absent"]);
  await expect(tool.execute({ action: "apply", files: [{ path: "src/unprepared.ts", content: "x" }] }))
    .rejects.toThrow("invalid_shape: src/unprepared.ts 没有预检过，先 prepare 或填 baseHash");
  for (const extra of [{ role: "worker" }, { requirementId: uuidv7() }, { writePaths: ["/"] }, { actor: "user" }]) {
    await expect(tool.execute({ action: "apply", files: [good], ...extra })).rejects.toMatchObject({ code: "invalid_shape" });
  }
  const preflight = await tool.execute({ action: "prepare", files: [good, { path: "src/a.ts", baseHash: w.base, content: "export const a = 2;\n" }] }) as Result;
  expect(preflight.status).toBe("ready");
  expect(preflight.files.map((file) => file.path)).toEqual(["src/b.ts", "src/a.ts"]);
  await expect(w.read("src/b.ts")).rejects.toMatchObject({ code: "ENOENT" });
});

test("M5-AC1/AC8：中途写入失败精确记录已写/失败/未动，不带编号、带同样的文件重试补齐", async () => {
  const w = await world(); const tool = await w.tool();
  const files = [
    { path: "src/a.ts", baseHash: w.base, content: "export const a = 2;\n" },
    { path: "src/nested/b.ts", baseHash: "absent", content: "export const b = 2;\n" },
    { path: "src/c.ts", baseHash: "absent", content: "export const c = 3;\n" },
  ];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("b.ts")) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const first = await tool.execute({ action: "apply", files }) as Result;
  expect(first.status).toBe("partial_failure");
  const operationId = first.operationId;
  expect(first.files.map((file) => file.status)).toEqual(["written", "failed", "pending"]);
  expect(first.files[1]!.reason).toContain("模拟磁盘故障");
  await expect(w.read("src/a.ts")).resolves.toBe("export const a = 2;\n");
  await expect(w.read("src/nested/b.ts")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(w.read("src/c.ts")).rejects.toMatchObject({ code: "ENOENT" });
  expect(((await tool.execute({ action: "status", operationId })) as Result).status).toBe("partial_failure");
  vi.restoreAllMocks();
  const altered = [{ ...files[2]!, content: "别的内容" }];
  await expect(tool.execute({ action: "apply", files: altered })).rejects.toMatchObject({ code: "operation_conflict", advice: { why: expect.stringContaining("本运行还有一批没写完的文件") } });
  const reordered = [files[2]!, files[0]!, files[1]!];
  const second = await tool.execute({ action: "apply", files: reordered }) as Result;
  expect(second.operationId).toBe(operationId);
  expect(second.status).toBe("applied");
  expect(second.files.map((file) => [file.path, file.status])).toEqual([["src/a.ts", "written"], ["src/nested/b.ts", "written"], ["src/c.ts", "written"]]);
  await expect(w.read("src/nested/b.ts")).resolves.toBe("export const b = 2;\n");
  await expect(w.read("src/c.ts")).resolves.toBe("export const c = 3;\n");

  const logFiles = [{ path: "src/d.ts", baseHash: "absent", content: "d\n" }, { path: "src/e.ts", baseHash: "absent", content: "e\n" }];
  const update = LocalDatabase.prototype.update;
  let failures = 0;
  vi.spyOn(LocalDatabase.prototype, "update").mockImplementation(function (this: LocalDatabase, ...args) {
    if (args[0] === "change_sets" && failures++ === 0) throw Object.assign(new Error("模拟日志提交失败"), { code: "EIO" });
    return update.apply(this, args);
  });
  const failure = await tool.execute({ action: "apply", files: logFiles }).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toContain("模拟日志提交失败");
  expect(failure).toMatchObject({ code: "EIO" });
  expect(failure?.message).toContain("带同样的文件再调一次可以续写");
  expect(failure?.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  await expect(w.read("src/d.ts")).resolves.toBe("d\n");
  await expect(w.read("src/e.ts")).rejects.toMatchObject({ code: "ENOENT" });
  vi.restoreAllMocks();
  const recovered = await tool.execute({ action: "apply", files: logFiles }) as Result;
  expect(recovered.status).toBe("applied");
  await expect(w.read("src/e.ts")).resolves.toBe("e\n");
});

test("M5-AC2：外部编辑或 pull 之后旧基础补丁拒绝，不覆盖用户新内容", async () => {
  const w = await world(); const tool = await w.tool();
  await writeFile(join(w.worktree.root, "src", "a.ts"), "用户手改\n");
  await expect(tool.execute({ action: "apply", files: [{ path: "src/a.ts", baseHash: w.base, content: "x" }] }))
    .rejects.toMatchObject({ code: "stale_base" });
  await expect(w.read("src/a.ts")).resolves.toBe("用户手改\n");

  const files = [{ path: "src/f.ts", baseHash: "absent", content: "f\n" }, { path: "src/g.ts", baseHash: "absent", content: "g\n" }];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("g.ts")) throw new Error("模拟故障");
    return original(path, content);
  });
  const partial = await tool.execute({ action: "apply", files }) as Result;
  expect(partial.status).toBe("partial_failure");
  const operationId = partial.operationId;
  vi.restoreAllMocks();
  await writeFile(join(w.worktree.root, "src", "g.ts"), "用户抢先写入\n");
  const resumed = await tool.execute({ action: "apply", files }) as Result;
  expect(resumed.operationId).toBe(operationId);
  expect(resumed.status).toBe("stale");
  expect(resumed.files[1]).toMatchObject({ status: "stale" });
  await expect(w.read("src/g.ts")).resolves.toBe("用户抢先写入\n");

  const pulledFiles = [{ path: "src/h.ts", baseHash: "absent", content: "h\n" }, { path: "src/i.ts", baseHash: "absent", content: "i\n" }];
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("i.ts")) throw new Error("模拟故障");
    return original(path, content);
  });
  const afterStale = await tool.execute({ action: "apply", files: [{ path: "src/after-stale.ts", baseHash: "absent", content: "s\n" }] }) as Result;
  expect(afterStale.status).toBe("applied");
  const pulledFirst = await tool.execute({ action: "apply", files: pulledFiles }) as Result;
  expect(pulledFirst.status).toBe("partial_failure");
  const pulled = pulledFirst.operationId;
  vi.restoreAllMocks();
  await runGit(["add", "src/h.ts"], w.worktree.root); await runGit(["commit", "-qm", "外部提交"], w.worktree.root);
  await expect(tool.execute({ action: "apply", files: pulledFiles })).rejects.toMatchObject({ code: "stale_base" });
  expect(((await tool.execute({ action: "status", operationId: pulled })) as Result).status).toBe("stale");
  await expect(w.read("src/i.ts")).rejects.toMatchObject({ code: "ENOENT" });
});

test("M5-AC2：apply 省略 baseHash 时用本会话最近一次 prepare 的值；预检后文件被改仍拒绝，不覆盖新内容", async () => {
  const w = await world(); const tool = await w.tool();
  await tool.execute({ action: "prepare", files: [{ path: "src/a.ts", content: "export const a = 2;\n" }, { path: "src/new.ts", content: "n\n" }] });
  const applied = await tool.execute({ action: "apply", files: [{ path: "src/a.ts", content: "export const a = 2;\n" }, { path: "src/new.ts", content: "n\n" }] }) as Result;
  expect(applied.status).toBe("applied");
  await expect(w.read("src/a.ts")).resolves.toBe("export const a = 2;\n");
  await expect(w.read("src/new.ts")).resolves.toBe("n\n");

  await tool.execute({ action: "prepare", files: [{ path: "src/a.ts", content: "export const a = 3;\n" }] });
  await writeFile(join(w.worktree.root, "src", "a.ts"), "用户手改\n");
  await expect(tool.execute({ action: "apply", files: [{ path: "src/a.ts", content: "export const a = 3;\n" }] }))
    .rejects.toMatchObject({ code: "stale_base" });
  await expect(w.read("src/a.ts")).resolves.toBe("用户手改\n");
  const other = await w.tool();
  await expect(other.execute({ action: "apply", files: [{ path: "src/a.ts", content: "x" }] })).rejects.toMatchObject({ code: "invalid_shape" });
});

test("M5-AC2：生成器只能从沙箱生成目录按声明指纹导入，越界或指纹不符不落盘", async () => {
  const w = await world();
  const scratch = await mkdtemp(join(w.root, "scratch-"));
  await mkdir(join(scratch, "gen"), { recursive: true });
  await writeFile(join(scratch, "gen", "out.ts"), "generated\n");
  await symlink(join(w.worktree.root, "src", "a.ts"), join(scratch, "link.ts"));
  const tool = await w.tool(w.grant({ scratchRoot: scratch }));
  const targetHash = sha("generated\n");
  await expect(tool.execute({ action: "import", files: [{ path: "src/out.ts", baseHash: "absent", sourcePath: "gen/out.ts", targetHash: sha("别的") }] }))
    .rejects.toMatchObject({ code: "import_mismatch" });
  await expect(tool.execute({ action: "import", files: [{ path: "src/out.ts", baseHash: "absent", sourcePath: "../a.ts", targetHash }] }))
    .rejects.toMatchObject({ code: "path_escape" });
  await expect(tool.execute({ action: "import", files: [{ path: "src/out.ts", baseHash: "absent", sourcePath: "link.ts", targetHash: w.base }] }))
    .rejects.toMatchObject({ code: "path_escape" });
  await expect(tool.execute({ action: "import", files: [{ path: "docs/prd/x.md", baseHash: "absent", sourcePath: "gen/out.ts", targetHash }] }))
    .rejects.toMatchObject({ code: "forbidden_path" });
  await expect(w.read("src/out.ts")).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(scratch, "gen", "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const blobHash = createHash("sha256").update(Buffer.from([0xff, 0xfe, 0x00, 0x80])).digest("hex");
  await expect(tool.execute({ action: "import", files: [{ path: "src/blob.bin", baseHash: "absent", sourcePath: "gen/blob.bin", targetHash: blobHash }] }))
    .rejects.toMatchObject({ code: "import_mismatch" });
  await expect(w.read("src/blob.bin")).rejects.toMatchObject({ code: "ENOENT" });
  const result = await tool.execute({ action: "import", files: [{ path: "src/out.ts", baseHash: "absent", sourcePath: "gen/out.ts", targetHash }] }) as Result;
  expect(result.status).toBe("applied");
  await expect(w.read("src/out.ts")).resolves.toBe("generated\n");
  const unscoped = await w.tool();
  await expect(unscoped.execute({ action: "import", files: [{ path: "src/out2.ts", baseHash: "absent", sourcePath: "gen/out.ts", targetHash }] }))
    .rejects.toMatchObject({ code: "forbidden_path" });
});

test("M5-AC3/AC7：非 worker 职责、伪造绑定、旧 epoch、宿主撤权、越出绑定 worktree 一律拒绝且不写", async () => {
  const w = await world();
  const good = { path: "src/z.ts", baseHash: "absent", content: "z\n" };
  for (const role of ["main", "pm", "explore", "reviewer", "qa", "planner"]) {
    await expect(w.tool({ ...w.grant(), role } as never)).rejects.toMatchObject({ code: "grant_invalid" });
  }
  await expect(w.tool(w.grant({ epoch: w.grant().epoch + 1 }))).resolves.toBeDefined();
  const staleEpoch = await w.tool(w.grant({ epoch: w.grant().epoch + 1 }));
  await expect(staleEpoch.execute({ action: "apply", files: [good] })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求已换代（epoch 变化）" } });
  const otherWorkspace = await w.tool(w.grant({ workspaceId: "f".repeat(64) }));
  await expect(otherWorkspace.execute({ action: "apply", files: [good] })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求工作区绑定已变化" } });
  const otherBranch = await w.tool(w.grant({ branch: "refs/heads/elsewhere" }));
  await expect(otherBranch.execute({ action: "prepare", files: [good] })).rejects.toMatchObject({ code: "requirement_changed" });
  await expect(w.tool(w.grant(), () => false)).rejects.toMatchObject({ code: "session_inactive" });
  const bound = w.grant();
  const permits = new Map([[bound.callerId, true]]);
  const flip = await w.tool(bound, (request) => permits.get(request.grant.callerId) === true);
  permits.set(bound.callerId, false);
  await expect(flip.execute({ action: "apply", files: [good] })).rejects.toMatchObject({ code: "session_inactive" });
  await expect(w.read("src/z.ts")).rejects.toMatchObject({ code: "ENOENT" });
  const closingTool = await w.tool();
  w.state.beginClose({ requirementId: w.created.requirementId, version: w.state.read(w.created.requirementId).version,
    intent: { operationId: uuidv7(), receiptId: uuidv7(), reason: "cancelled" } });
  await expect(closingTool.execute({ action: "apply", files: [good] })).rejects.toMatchObject({ code: "requirement_changed", advice: { why: "需求已不是派工时的状态：需求不在活动状态" } });
  await expect(w.read("src/z.ts")).rejects.toMatchObject({ code: "ENOENT" });
});

test("写项目设置文件被拒并写明是哪个文件、为什么不能改，文件内容不变，写入范围里列了它也一样；.pi/other.json 不受影响", async () => {
  const w = await world();
  const settings = join(w.worktree.root, ".pi", "settings.json");
  await mkdir(join(w.worktree.root, ".pi"), { recursive: true });
  await writeFile(settings, "{}\n");
  const tool = await w.tool(w.grant({ writePaths: ["src/", ".pi/"] }));
  for (const path of [".pi/settings.json", ".PI/Settings.json"]) {
    await expect(tool.execute({ action: "apply", files: [{ path, baseHash: sha("{}\n"), content: "{\"x\":1}\n" }] }))
      .rejects.toMatchObject({ code: "host_settings", advice: { why: `这是 pi 的项目设置文件，只能由用户修改：${path}` } });
  }
  await expect(readFile(settings, "utf8")).resolves.toBe("{}\n");
  const other = await tool.execute({ action: "apply", files: [{ path: ".pi/other.json", baseHash: "absent", content: "{}\n" }] }) as Result;
  expect(other.files[0]!.status).not.toBe("failed");
  await expect(w.read(".pi/other.json")).resolves.toBe("{}\n");
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("apply、import 不带 operationId 成功，结果带本次操作编号且每次不同", async () => {
  const w = await world();
  const scratch = await mkdtemp(join(w.root, "scratch-"));
  await mkdir(join(scratch, "gen"), { recursive: true });
  await writeFile(join(scratch, "gen", "out.ts"), "generated\n");
  const tool = await w.tool(w.grant({ scratchRoot: scratch }));
  const one = await tool.execute({ action: "apply", files: [{ path: "src/one.ts", baseHash: "absent", content: "1\n" }] }) as Result;
  const two = await tool.execute({ action: "apply", files: [{ path: "src/two.ts", baseHash: "absent", content: "2\n" }] }) as Result;
  const imported = await tool.execute({ action: "import", files: [{ path: "src/out.ts", baseHash: "absent", sourcePath: "gen/out.ts", targetHash: sha("generated\n") }] }) as Result;
  for (const result of [one, two, imported]) {
    expect(result.status).toBe("applied");
    expect(result.operationId).toMatch(UUID_V7);
  }
  await expect(tool.execute({ action: "apply", operationId: uuidv7(), files: [{ path: "src/three.ts", baseHash: "absent", content: "3\n" }] })).rejects.toMatchObject({ code: "invalid_shape" });
  await expect(tool.execute({ action: "import", operationId: uuidv7(), files: [{ path: "src/out3.ts", baseHash: "absent", sourcePath: "gen/out.ts", targetHash: sha("generated\n") }] })).rejects.toMatchObject({ code: "invalid_shape" });
  await expect(w.read("src/three.ts")).rejects.toMatchObject({ code: "ENOENT" });
  expect(new Set([one.operationId, two.operationId, imported.operationId]).size).toBe(3);
  await expect(w.read("src/one.ts")).resolves.toBe("1\n");
});

test("写到一半失败后不带编号、带同样的文件再调，续写完成且结果与一次写完相同", async () => {
  const w = await world(); const tool = await w.tool();
  const files = [{ path: "src/p.ts", baseHash: "absent", content: "p\n" }, { path: "src/q.ts", baseHash: "absent", content: "q\n" }];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("q.ts")) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const first = await tool.execute({ action: "apply", files }) as Result;
  expect(["applying", "partial_failure"]).toContain(first.status);
  expect(first.operationId).toMatch(UUID_V7);
  vi.restoreAllMocks();
  const resumed = await tool.execute({ action: "apply", files }) as Result;
  expect(resumed.status).toBe("applied");
  expect(resumed.operationId).toBe(first.operationId);
  expect(resumed.files.map((file) => [file.path, file.status])).toEqual([["src/p.ts", "written"], ["src/q.ts", "written"]]);
  await expect(w.read("src/q.ts")).resolves.toBe("q\n");
  const fresh = await w.tool();
  const direct = await fresh.execute({ action: "apply", files: [{ path: "src/p2.ts", baseHash: "absent", content: "p\n" }, { path: "src/q2.ts", baseHash: "absent", content: "q\n" }] }) as Result;
  expect(direct.files.map((file) => file.status)).toEqual(resumed.files.map((file) => file.status));
});

test("没写完的写入还在时，另一批文件被拒；写完或 stale 的记录不挡新写入", async () => {
  const w = await world(); const tool = await w.tool();
  const files = [{ path: "src/p.ts", baseHash: "absent", content: "p\n" }, { path: "src/q.ts", baseHash: "absent", content: "q\n" }];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("q.ts")) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const partial = await tool.execute({ action: "apply", files }) as Result;
  vi.restoreAllMocks();
  const conflict = { code: "operation_conflict", advice: { why: expect.stringContaining("本运行还有一批没写完的文件") } };
  const changed = [{ ...files[1]!, content: "别的内容" }];
  await expect(tool.execute({ action: "apply", files: changed })).rejects.toMatchObject(conflict);
  await expect(tool.execute({ action: "apply", files: [{ path: "src/other.ts", baseHash: "absent", content: "o\n" }] })).rejects.toMatchObject(conflict);
  await expect(w.read("src/other.ts")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(w.read("src/q.ts")).rejects.toMatchObject({ code: "ENOENT" });

  const done = await tool.execute({ action: "apply", files }) as Result;
  expect(done.status).toBe("applied");
  expect(done.operationId).toBe(partial.operationId);
  const next = await tool.execute({ action: "apply", files: [{ path: "src/other.ts", baseHash: "absent", content: "o\n" }] }) as Result;
  expect(next.status).toBe("applied");
  expect(next.operationId).not.toBe(partial.operationId);
});

test("导入没写完时，带同样的生成文件再调 import 续写，编号不变", async () => {
  const w = await world();
  const scratch = await mkdtemp(join(w.root, "scratch-"));
  await mkdir(join(scratch, "gen"), { recursive: true });
  await writeFile(join(scratch, "gen", "x.ts"), "x\n");
  await writeFile(join(scratch, "gen", "y.ts"), "y\n");
  const tool = await w.tool(w.grant({ scratchRoot: scratch }));
  const files = [
    { path: "src/x.ts", baseHash: "absent", sourcePath: "gen/x.ts", targetHash: sha("x\n") },
    { path: "src/y.ts", baseHash: "absent", sourcePath: "gen/y.ts", targetHash: sha("y\n") },
  ];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("y.ts")) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const first = await tool.execute({ action: "import", files }) as Result;
  expect(first.status).toBe("partial_failure");
  vi.restoreAllMocks();
  const resumed = await tool.execute({ action: "import", files }) as Result;
  expect(resumed.status).toBe("applied");
  expect(resumed.operationId).toBe(first.operationId);
  await expect(w.read("src/y.ts")).resolves.toBe("y\n");
});

test("status 仍要求 operationId，填了能查到本运行的写入", async () => {
  const w = await world(); const tool = await w.tool();
  await expect(tool.execute({ action: "status" })).rejects.toMatchObject({ code: "invalid_shape" });
  const applied = await tool.execute({ action: "apply", files: [{ path: "src/s.ts", baseHash: "absent", content: "s\n" }] }) as Result;
  const status = await tool.execute({ action: "status", operationId: applied.operationId }) as Result;
  expect(status).toMatchObject({ status: "applied", operationId: applied.operationId });
  await expect(tool.execute({ action: "status", operationId: uuidv7() })).rejects.toMatchObject({ code: "not_found" });
});

test("change_apply 的工具说明与报错文字不含“新生成”“UUIDv7”，import_mismatch 的“重新生成文件”保留", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "src", "modules", "verification", "change-apply.ts"), "utf8");
  const tools = await readFile(join(import.meta.dirname, "..", "src", "modules", "pm", "subagent-tools.ts"), "utf8");
  const description = tools.split("\n").find((line) => line.includes('toPiTool("change_apply"'))!;
  expect(description).toBeDefined();
  expect(description).not.toContain("报错里给出本次操作编号");
  expect(description).not.toMatch(/apply、import 的 operationId/);
  expect(source).not.toContain('if (db.read(CHANGE_SETS, set.operationId)) throw new ChangeApplyError("operation_conflict")');
  for (const text of [source, description]) {
    expect(text.replace(/重新生成/g, "")).not.toContain("新生成");
    expect(text).not.toContain("UUIDv7");
  }
  expect(source).toContain("重新生成文件");
  expect(source).not.toContain("resume_not_found");
  expect(source).not.toContain("resume_finished");
});

test("写到一半失败后又重新预检，不填 baseHash 带同样的文件再调，仍按同一批续写完成", async () => {
  const w = await world(); const tool = await w.tool();
  const files = [{ path: "src/p.ts", content: "p\n" }, { path: "src/q.ts", content: "q\n" }];
  await tool.execute({ action: "prepare", files });
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith("q.ts")) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const first = await tool.execute({ action: "apply", files }) as Result;
  expect(["applying", "partial_failure"]).toContain(first.status);
  vi.restoreAllMocks();
  await tool.execute({ action: "prepare", files });
  const resumed = await tool.execute({ action: "apply", files }) as Result;
  expect(resumed).toMatchObject({ status: "applied", operationId: first.operationId });
  await expect(w.read("src/q.ts")).resolves.toBe("q\n");
});

test("写完后最后核对时发现文件被外部改过：报 stale_base，不附续写提示", async () => {
  const w = await world(); const tool = await w.tool();
  const files = [{ path: "src/p.ts", baseHash: "absent", content: "p\n" }, { path: "src/q.ts", baseHash: "absent", content: "q\n" }];
  const original = store.writeFileAtomic;
  vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    await original(path, content);
    if (path.endsWith("q.ts")) await writeFile(join(w.worktree.root, "src/p.ts"), "外部改动\n");
  });
  const error = await tool.execute({ action: "apply", files }).then(() => undefined, (caught: Error) => caught);
  expect(error).toMatchObject({ code: "stale_base" });
  expect(error!.message).not.toContain("续写");
  expect(JSON.stringify((error as { advice?: unknown }).advice ?? "")).not.toContain("续写");
});

const ENDED_REASON = "运行已结束，没写完";
type StoredSet = { status: string; updatedAt: number; files: Array<{ path: string; status: string; reason?: string }> };

async function failingBatch(w: Awaited<ReturnType<typeof world>>, runId: string, failName: string, names: string[]) {
  const tool = await w.tool(w.grant({ runId }));
  const original = store.writeFileAtomic;
  const spy = vi.spyOn(store, "writeFileAtomic").mockImplementation(async (path, content) => {
    if (path.endsWith(failName)) throw new Error("模拟磁盘故障");
    return original(path, content);
  });
  const result = await tool.execute({ action: "apply", files: names.map((name) => ({ path: `src/${name}`, baseHash: "absent", content: `${name}\n` })) }) as Result;
  spy.mockRestore();
  return { tool, result };
}
const readSet = (w: Awaited<ReturnType<typeof world>>, operationId: string) =>
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.read<StoredSet>("change_sets", operationId)!.data);
const retire = (w: Awaited<ReturnType<typeof world>>, runId: string) =>
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.transaction(() => { retireRunChangeSetsIn(db, runId); }));

test("运行结束收尾：partial_failure 的记录变 stale，没写成功的文件条目标为 stale 并写明原因，已写入的条目不变", async () => {
  const w = await world();
  const runId = uuidv7();
  const { result } = await failingBatch(w, runId, "m.ts", ["l.ts", "m.ts", "n.ts"]);
  expect(result.status).toBe("partial_failure");
  expect(result.files.map((file) => file.status)).toEqual(["written", "failed", "pending"]);

  retire(w, runId);

  const set = readSet(w, result.operationId);
  expect(set.status).toBe("stale");
  expect(set.files.map((file) => [file.path, file.status])).toEqual([["src/l.ts", "written"], ["src/m.ts", "stale"], ["src/n.ts", "stale"]]);
  expect(set.files[0]!.reason).toBeUndefined();
  expect(set.files[1]!.reason).toBe(ENDED_REASON);
  expect(set.files[2]!.reason).toBe(ENDED_REASON);
});

test("运行结束收尾：applying 状态的记录同样变 stale", async () => {
  const w = await world();
  const runId = uuidv7();
  const { result } = await failingBatch(w, runId, "m.ts", ["l.ts", "m.ts"]);
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.read<StoredSet>("change_sets", result.operationId)!;
    db.update("change_sets", result.operationId, row.version, { ...row.data, status: "applying" });
  });

  retire(w, runId);

  expect(readSet(w, result.operationId).status).toBe("stale");
});

test("运行结束收尾：别的运行的记录、已 applied 的记录、已 stale 的记录原样不动", async () => {
  const w = await world();
  const runId = uuidv7();
  const otherRunId = uuidv7();
  const { result: appliedSet } = await failingBatch(w, runId, "never", ["done.ts"]);
  expect(appliedSet.status).toBe("applied");
  const stale = await failingBatch(w, runId, "s2.ts", ["s1.ts", "s2.ts"]);
  withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
    const row = db.read<StoredSet>("change_sets", stale.result.operationId)!;
    db.update("change_sets", stale.result.operationId, row.version, { ...row.data, status: "stale" });
  });
  const other = await failingBatch(w, otherRunId, "o2.ts", ["o1.ts", "o2.ts"]);
  expect(other.result.status).toBe("partial_failure");
  const before = [appliedSet.operationId, stale.result.operationId, other.result.operationId].map((id) => readSet(w, id));

  retire(w, runId);

  expect([appliedSet.operationId, stale.result.operationId, other.result.operationId].map((id) => readSet(w, id))).toEqual(before);
});

test("运行结束收尾后，别的运行可以正常写入别的文件", async () => {
  const w = await world();
  const runA = uuidv7();
  const { result } = await failingBatch(w, runA, "b2.ts", ["b1.ts", "b2.ts"]);
  expect(result.status).toBe("partial_failure");
  retire(w, runA);

  const toolB = await w.tool(w.grant({ runId: uuidv7() }));
  const applied = await toolB.execute({ action: "apply", files: [{ path: "src/other.ts", baseHash: "absent", content: "o\n" }] }) as Result;

  expect(applied.status).toBe("applied");
  expect(applied.operationId).not.toBe(result.operationId);
});
