import { afterEach, expect, test, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { draftApprover, manifestConfirmInput } from "./helpers/approval-fixture.ts";
import type { RequirementServiceOptions, ServiceAuthorizationRequest } from "../src/modules/requirement/requirement-service.ts";
import { RequirementOperations } from "../src/modules/requirement/requirement-operations.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import * as databaseModule from "../src/core/storage/database.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { prodRequirementPath } from "../src/modules/requirement/prod-storage.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { beginDesign, decidePrototype, draftPrototypes, pendingConfirmation, readPrototypeBoard, removeFromDraft, submitDesign } from "../src/modules/requirement/requirement-prototypes.ts";
import { prototypesAtRevision } from "../src/modules/requirement/requirement-prototype-revisions.ts";


const exec = promisify(execFile);
const GIT = "git";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(authorize: RequirementServiceOptions["authorize"] = () => true) {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-service-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options: RequirementServiceOptions = {
    repositoryRoot: repo.root,
    dataRoot: join(root, "private"),
    repoId: identity.repoId,
    authorize,
    authorizeManifest: () => true,
  };
  const service = await RequirementService.open(options);
  const state = await RequirementStateStore.open({ ...options, authorize: () => true });
  const bind = async (requirementId: string) => {
    const worktree = await addWorktree(repo);
    const baseCommit = (await exec(GIT, ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
    const current = state.read(requirementId);
    return state.bindWorkspace({ requirementId, version: current.version, path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  };
  return { root, repo, identity, options, service, state, bind };
}

const createInput = (overrides: Partial<{ requestId: string; operationId: string; title: string; body: string }> = {}) => ({
  requestId: uuidv7(),
  operationId: uuidv7(),
  title: "需求标题",
  body: "初始正文",
  ...overrides,
});

async function commitCount(requirementRoot: string): Promise<number> {
  return Number((await exec(GIT, ["rev-list", "--count", "HEAD"], { cwd: requirementRoot, env: GIT_ENV })).stdout.trim());
}

function spawnServiceWrite(
  w: Awaited<ReturnType<typeof world>>,
  input: Parameters<RequirementService["updateDraft"]>[0],
  hold?: { claimed: string; release: string },
) {
  const script = join(w.root, `service-child-${uuidv7()}.mjs`);
  const source = `import {existsSync,writeFileSync} from 'node:fs';
import {RequirementService} from ${JSON.stringify(new URL("../src/modules/requirement/requirement-service.ts", import.meta.url).href)};
import {RequirementWriteCoordinator} from ${JSON.stringify(new URL("../src/modules/requirement/requirement-coordination.ts", import.meta.url).href)};
const options=${JSON.stringify({ repositoryRoot: w.options.repositoryRoot, dataRoot: w.options.dataRoot, repoId: w.options.repoId})};
const input=${JSON.stringify(input)};
const hold=${JSON.stringify(hold ?? null)};
const coordinator=new RequirementWriteCoordinator(options);
let announced=false;
const service=await RequirementService.open({...options,authorize:(request)=>{
  if (hold && request.operationId===input.operationId) {
    const claim=coordinator.inspect(input.requirementId)[0];
    if (claim?.pid===process.pid && !announced) {
      announced=true; writeFileSync(hold.claimed,'claimed');
      const wait=new Int32Array(new SharedArrayBuffer(4));
      while(!existsSync(hold.release)) Atomics.wait(wait,0,0,10);
    }
  }
  return true;
}});
try { const result=await service.updateDraft(input); console.log(JSON.stringify({ok:true,result})); }
catch(error) { console.log(JSON.stringify({ok:false,code:error.code??error.name,message:error.message})); }
`;
  const ready = writeFile(script, source).then(() => {
    const proc = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { proc.once("close", resolve); proc.once("error", reject); });
    void closed.catch(() => {});
    return { proc, closed, stdout: () => stdout, stderr: () => stderr };
  });
  return ready;
}

async function waitForFile(path: string, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(diagnostics() || `等待文件超时: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function activate(w: Awaited<ReturnType<typeof world>>, created: Awaited<ReturnType<RequirementService["create"]>>) {
  await w.bind(created.requirementId);
  return w.service.confirmUpdate(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId }));
}

test("create 生成并持久复用 UUID，首提与同 operation 响应重试不重复提交或事件", async () => {
  const authorizations: ServiceAuthorizationRequest[] = [];
  const w = await world((request) => { authorizations.push(structuredClone(request)); return true; });
  const input = createInput();
  const first = await w.service.create(input);
  const repeated = await w.service.create(input);

  expect(first.requirementId).toMatch(/^[0-9a-f-]{36}$/);
  expect(repeated).toEqual(first);
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: first.requirementId }))).toBe(1);
  expect(w.state.events(first.requirementId).filter((event) => event.data.kind === "prod.saved")).toHaveLength(1);
  expect((await w.service.read({ requirementId: first.requirementId, source: "saved" })).body).toBe(input.body);
  expect(w.state.read(first.requirementId).data.saved!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(w.state.read(first.requirementId).data.saved!.hash).not.toContain("sha256:");
  expect(authorizations.some((request) => request.prodHash === first.prodHash)).toBe(true);
  expect(authorizations.every((request) => request.repoId === w.identity.repoId)).toBe(true);
  expect(JSON.stringify(authorizations)).not.toContain(input.body);
  expect(requirementIntentHash({ title: input.title, body: input.body })).toBe(requirementIntentHash({ body: input.body, title: input.title }));
});

test("相同 requestId 即使使用新 operationId 仍复用 UUID 与已有提交", async () => {
  const w = await world();
  const input = createInput();
  const first = await w.service.create(input);
  const second = await w.service.create({ ...input, operationId: uuidv7() });
  expect(second.requirementId).toBe(first.requirementId);
  expect(second.status).toBe("unchanged");
  expect(second.commit).toBe(first.commit);
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: first.requirementId }))).toBe(1);
  expect(w.state.events(first.requirementId).filter((event) => event.data.kind === "prod.saved")).toHaveLength(1);
});

test("无变化 draft 不空提交；首次确认引用已有提交但仍激活并登记批准事件", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const current = await w.service.metadata(created.requirementId);
  const draft = await w.service.updateDraft({
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: current.version,
    title: "需求标题",
    body: "初始正文",
  });
  expect(draft.status).toBe("unchanged");
  expect(draft.commit).toBe(created.commit);
  expect(w.state.events(created.requirementId).filter((event) => event.data.kind === "prod.saved")).toHaveLength(1);

  const approved = await activate(w, created);
  expect(approved.status).toBe("unchanged");
  expect(approved.commit).toBe(created.commit);
  expect(approved.lifecycle).toBe("active");
  expect(approved.revision).toBe(1);
  expect(w.state.events(created.requirementId).filter((event) => event.data.kind === "prod.approved")).toHaveLength(1);
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(1);
});

test("M8A-AC7：确认须有可信 receipt 授权，不要求已绑定 worktree", async () => {
  let allowConfirmation = true;
  const w = await world((request) => request.action !== "confirmUpdate" || allowConfirmation);
  const created = await w.service.create(createInput());
  const base = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "初始正文",
  };
  await expect(w.service.confirmUpdate(base as never)).rejects.toMatchObject({ code: "invalid_shape" });
  const confirm = await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId });
  allowConfirmation = false;
  await expect(w.service.confirmUpdate(confirm)).rejects.toMatchObject({ code: "authorization_required" });
  expect(w.state.read(created.requirementId).data.lifecycle).toBe("draft");
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(1);
  allowConfirmation = true;
  await w.service.confirmUpdate(confirm);
  expect(w.state.read(created.requirementId).data).toMatchObject({ lifecycle: "active", workspace: null });
});

test("metadata 返回当前保存版本对应的保存操作编号，改草稿后跟着变", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  expect((await w.service.metadata(created.requirementId)).savedOperationId).toBe(created.operationId);
  const operationId = uuidv7();
  await w.service.updateDraft({ requirementId: created.requirementId, operationId, version: (await w.service.metadata(created.requirementId)).version,
    title: "需求标题", body: "改过的正文" });
  expect((await w.service.metadata(created.requirementId)).savedOperationId).toBe(operationId);
});

test("批准之后 metadata 返回的保存操作编号不变，可以直接用来读取确认上下文", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  await activate(w, created);
  const meta = await w.service.metadata(created.requirementId);
  expect(meta.savedOperationId).toBe(created.operationId);
  const loaded = await w.service.loadConfirmationContext({ requirementId: created.requirementId, savedOperationId: meta.savedOperationId, operationId: uuidv7() });
  expect(loaded.difference.text).toBe("");
});

test("diff 使用登记的跨版本 approved 事件，正确跨过中间 draft", async () => {
  const w = await world();
  const created = await w.service.create(createInput({ body: "批准一" }));
  const first = await activate(w, created);
  const approve = draftApprover(w.options, w.service, { requirementId: created.requirementId, operationId: created.operationId, title: "需求标题", body: "批准一" });

  await w.service.updateDraft({
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: first.version,
    title: "需求标题",
    body: "未批准中间草稿",
  });
  const second = await approve("批准二");
  await w.service.updateDraft({
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: second.version,
    title: "需求标题",
    body: "另一份未批准草稿",
  });
  const third = await approve("批准三");

  const difference = await w.service.diff({ requirementId: created.requirementId, fromRevision: 1, toRevision: 3 });
  expect(difference.fromCommit).toBe(first.commit);
  expect(difference.toCommit).toBe(third.commit);
  expect(difference.diff).toContain("-批准一");
  expect(difference.diff).toContain("+批准三");
  expect(difference.diff).not.toContain("未批准中间草稿");
});

test("缺授权、异步授权、伪字段和 closing/closed 正文读取均拒绝", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-service-auth-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const options = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId};
  await expect(RequirementService.open(options)).rejects.toMatchObject({ code: "authorization_required" });
  await expect(RequirementService.open({ ...options, authorize: (async () => true) as never })).rejects.toMatchObject({ code: "authorization_required" });

  const w = await world();
  const input = createInput();
  await expect(w.service.create({ ...input, actor: "user" } as never)).rejects.toMatchObject({ code: "invalid_shape" });
  const created = await w.service.create(input);
  const closing = w.state.beginClose({
    requirementId: created.requirementId,
    version: created.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() },
  });
  await expect(w.service.read({ requirementId: created.requirementId, source: "saved" })).rejects.toMatchObject({ code: "lifecycle_denied" });
  await expect(w.service.diff({ requirementId: created.requirementId, fromRevision: 1 })).rejects.toMatchObject({ code: "lifecycle_denied" });
  const closed = w.state.finishClose({ requirementId: created.requirementId, version: closing.version, operationId: closing.data.close!.operationId });
  await expect(w.service.read({ requirementId: created.requirementId, source: "saved" })).rejects.toMatchObject({ code: "lifecycle_denied" });
  expect((await w.service.metadata(created.requirementId)).lifecycle).toBe("closed");
  expect(closed.data.lifecycle).toBe("closed");
});

test("Git 完成后操作日志登记故障，原 operation 重试复用提交并补齐 DB", async () => {
  const w = await world();
  const input = createInput();
  const original = RequirementOperations.prototype.recordGitResult;
  const spy = vi.spyOn(RequirementOperations.prototype, "recordGitResult").mockImplementationOnce(() => {
    throw new Error("injected operation DB failure");
  }).mockImplementation(original);
  await expect(w.service.create(input)).rejects.toThrow(/injected operation DB failure/);
  const reserved = w.state.reserve({ requestId: input.requestId, intentHash: requirementIntentHash({ title: input.title, body: input.body }) });
  expect(reserved.data.saved).toBeNull();
  const requirementRoot = prodRequirementPath({ ...w.options, requirementId: reserved.id });
  expect(await commitCount(requirementRoot)).toBe(1);

  const recovered = await w.service.create(input);
  expect(recovered.status).toBe("recovered");
  expect(await commitCount(requirementRoot)).toBe(1);
  expect(w.state.events(reserved.id).filter((event) => event.data.kind === "prod.saved")).toHaveLength(1);
  expect(spy).toHaveBeenCalled();
});

test("批准已落库但 finalize 响应丢失时，同 operation 重试不重复批准事件", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  await w.bind(created.requirementId);
  const input = await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId });
  const original = RequirementOperations.prototype.finalize;
  vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementationOnce(() => {
    throw new Error("injected lost finalize response");
  }).mockImplementation(original);
  await expect(w.service.confirmUpdate(input)).rejects.toThrow(/lost finalize response/);
  expect(w.state.read(created.requirementId).data.revision).toBe(1);

  const recovered = await w.service.confirmUpdate(input);
  expect(recovered.revision).toBe(1);
  expect(recovered.lifecycle).toBe("active");
  expect(w.state.events(created.requirementId).filter((event) => event.data.kind === "prod.approved")).toHaveLength(1);
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(1);
});

test("状态保存已成功但 operation 日志未登记时，原 operation 核对恢复且不再写 Git", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "状态已保存但日志响应丢失",
  };
  const original = RequirementOperations.prototype.recordSavedVersion;
  vi.spyOn(RequirementOperations.prototype, "recordSavedVersion").mockImplementationOnce(() => {
    throw new Error("injected saved-version log failure");
  }).mockImplementation(original);
  await expect(w.service.updateDraft(input)).rejects.toThrow(/saved-version log failure/);
  const afterFailure = w.state.read(created.requirementId);
  expect(afterFailure.data.saved!.commit).not.toBe(created.commit);
  const requirementRoot = prodRequirementPath({ ...w.options, requirementId: created.requirementId });
  expect(await commitCount(requirementRoot)).toBe(2);
  const recovered = await w.service.updateDraft(input);
  expect(recovered.commit).toBe(afterFailure.data.saved!.commit);
  expect(await commitCount(requirementRoot)).toBe(2);
  expect(w.state.events(created.requirementId).filter((event) => event.data.kind === "prod.saved")).toHaveLength(2);
});

test("Git 成功后状态事件登记失败，重试按持久原 version 补齐且不重复 commit/event", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "数据库故障后的新正文",
  };
  const restore = failDatabaseWrites(
    repositoryDatabase(w.options.dataRoot, w.options.repoId),
    "events",
    "stream",
    `requirement_events:${created.requirementId}`,
  );
  try { await expect(w.service.updateDraft(input)).rejects.toThrow(); }
  finally { restore(); }

  const requirementRoot = prodRequirementPath({ ...w.options, requirementId: created.requirementId });
  expect(await commitCount(requirementRoot)).toBe(2);
  expect((await w.service.metadata(created.requirementId)).saved!.commit).toBe(created.commit);
  const recovered = await w.service.updateDraft(input);
  expect(recovered.status).toBe("saved");
  expect(await commitCount(requirementRoot)).toBe(2);
  expect(w.state.events(created.requirementId).filter((event) => event.data.kind === "prod.saved")).toHaveLength(2);
});

test("外部正文与持久目标不匹配时保留外部内容并阻塞，不 reset 或覆盖", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const requirementRoot = prodRequirementPath({ ...w.options, requirementId: created.requirementId });
  await writeFile(join(requirementRoot, "prod.md"), "external-user-content");
  await expect(w.service.updateDraft({
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "服务想写入的新正文",
  })).rejects.toMatchObject({ code: "working_copy_mismatch" });
  expect(await readFile(join(requirementRoot, "prod.md"), "utf8")).toBe("external-user-content");
  expect(await commitCount(requirementRoot)).toBe(1);
  expect((await w.service.metadata(created.requirementId)).saved!.commit).toBe(created.commit);
});

test("create 分配到已有完整 UUID 归档时持久降权，归档删除后也不自动恢复", async () => {
  const w = await world();
  const collisionId = uuidv7();
  const archiveDirectory = join(w.repo.root, "docs", "prod");
  await mkdir(archiveDirectory, { recursive: true });
  const archive = join(archiveDirectory, `${collisionId}.历史需求.md`);
  await writeFile(archive, "ARCHIVE-BODY-MUST-NOT-BE-READ");
  const input = createInput();
  const originalUuid = databaseModule.uuidv7;
  const spy = vi.spyOn(databaseModule, "uuidv7")
    .mockImplementationOnce(() => collisionId)
    .mockImplementation(originalUuid);
  await expect(w.service.create(input)).rejects.toMatchObject({ code: "recovery_required" });
  expect(w.state.read(collisionId).data).toMatchObject({ lifecycle: "draft", recovery: "needs_review", recoveryReason: "archive_found" });
  expect(existsSync(prodRequirementPath({ ...w.options, requirementId: collisionId }))).toBe(false);
  await rm(archive);
  await expect(w.service.create(input)).rejects.toMatchObject({ code: "recovery_required" });
  expect(w.state.read(collisionId).data.recoveryReason).toBe("archive_found");
  expect(spy).toHaveBeenCalled();
});

test("两个独立 Node 服务竞争同一需求时只有持有者进入正文写入", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const claimed = join(w.root, "first-claimed");
  const release = join(w.root, "release-first");
  const firstInput = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "第一个进程正文",
  };
  const secondInput = { ...firstInput, operationId: uuidv7(), body: "第二个进程正文" };
  const first = await spawnServiceWrite(w, firstInput, { claimed, release });
  await waitForFile(claimed, first.stderr);
  const second = await spawnServiceWrite(w, secondInput);
  expect(await second.closed).toBe(0);
  const secondResult = JSON.parse(second.stdout().trim().split("\n").at(-1)!);
  expect(secondResult).toMatchObject({ ok: false, code: "requirement_write_pending" });
  await writeFile(release, "continue");
  expect(await first.closed).toBe(0);
  expect(JSON.parse(first.stdout().trim().split("\n").at(-1)!)).toMatchObject({ ok: true });
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(2);
  expect((await w.service.read({ requirementId: created.requirementId, source: "saved" })).body).toBe("第一个进程正文");
}, 15_000);

test("活动持有者不能被偷占，进程真实结束后只有原 operation 可恢复", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const claimed = join(w.root, "dead-owner-claimed");
  const release = join(w.root, "never-release");
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "死亡进程恢复正文",
  };
  const child = await spawnServiceWrite(w, input, { claimed, release });
  await waitForFile(claimed, child.stderr);
  await expect(w.service.updateDraft(input)).rejects.toMatchObject({ code: "requirement_write_busy" });
  await expect(w.service.updateDraft({ ...input, operationId: uuidv7() })).rejects.toMatchObject({ code: "requirement_write_pending" });
  child.proc.kill("SIGKILL");
  expect(await child.closed).not.toBe(0);
  const recovered = await w.service.updateDraft(input);
  expect(recovered.status).toBe("saved");
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(2);
}, 15_000);

test("关闭与 storage.beforeWrite 互斥，预检失败不撤权且不写文件", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "不应写入的正文",
  };
  const original = RequirementOperations.prototype.assertOwned;
  let checks = 0;
  vi.spyOn(RequirementOperations.prototype, "assertOwned").mockImplementation(function (...args) {
    if (args[0] === input.operationId && ++checks === 3) {
      const current = w.state.read(created.requirementId);
      w.state.beginClose({
        requirementId: created.requirementId,
        version: current.version,
        intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() },
      });
    }
    return original.apply(this, args);
  });
  await expect(w.service.updateDraft(input)).rejects.toBeTruthy();
  expect(checks).toBeGreaterThanOrEqual(3);
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(1);
  const after = w.state.read(created.requirementId);
  expect(after.data.lifecycle).toBe("draft");
  expect(after.data.epoch).toBe(created.epoch);
  const closing = w.state.beginClose({ requirementId: created.requirementId, version: after.version,
    intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  const closed = w.state.finishClose({ requirementId: created.requirementId, version: closing.version, operationId: closing.data.close!.operationId });
  expect(closed.data.lifecycle).toBe("closed");
});

test("completed 关闭在需求写占用和未完成保存存在时保持 active", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const active = await activate(w, created);
  const claimed = join(w.root, "completed-owner-claimed");
  const release = join(w.root, "completed-owner-release");
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: active.version,
    title: "需求标题",
    body: "完成关闭竞争正文",
  };
  const child = await spawnServiceWrite(w, input, { claimed, release });
  await waitForFile(claimed, child.stderr);
  const current = w.state.read(created.requirementId);
  expect(() => w.state.beginClose({
    requirementId: created.requirementId,
    version: current.version,
    intent: { operationId: uuidv7(), reason: "completed", receiptId: uuidv7() },
  })).toThrow(/requirement_write_busy/);
  expect(w.state.read(created.requirementId).data.lifecycle).toBe("active");
  await writeFile(release, "continue");
  expect(await child.closed).toBe(0);
}, 15_000);

test("取消关闭先等待写入安全结束，死亡进程占用不会永久阻塞关闭", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const claimed = join(w.root, "closing-owner-claimed");
  const release = join(w.root, "closing-owner-release");
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "关闭竞争正文",
  };
  const child = await spawnServiceWrite(w, input, { claimed, release });
  await waitForFile(claimed, child.stderr);
  const current = w.state.read(created.requirementId);
  const closeRequest = { requirementId: created.requirementId, version: current.version,
    intent: { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() } };
  expect(() => w.state.beginClose(closeRequest)).toThrow(/requirement_write_busy/);
  expect(w.state.read(created.requirementId).data).toEqual(current.data);
  child.proc.kill("SIGKILL");
  expect(await child.closed).not.toBe(0);
  const closing = w.state.beginClose(closeRequest);
  expect(w.state.finishClose({ requirementId: created.requirementId, version: closing.version, operationId: closing.data.close!.operationId }).data.lifecycle).toBe("closed");
}, 15_000);

test("既有closing现场的写进程死亡后可安全结束，活持有者不能被清理", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const claimed = join(w.root, "legacy-closing-claimed"), release = join(w.root, "legacy-closing-release");
  const child = await spawnServiceWrite(w, { requirementId: created.requirementId, operationId: uuidv7(), version: created.version,
    title: "需求标题", body: "不应在closed之后保存" }, { claimed, release });
  await waitForFile(claimed, child.stderr);
  const current = w.state.read(created.requirementId);
  const intent = { operationId: uuidv7(), reason: "cancelled" as const, receiptId: uuidv7() };
  // 构造先前版本可能留下的closing记录，实际进程仍保持存活。
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => db.update("requirements", created.requirementId,
    current.version, { ...current.data, lifecycle: "closing", epoch: current.data.epoch + 1, close: intent }));
  const closing = w.state.read(created.requirementId);
  const finish = { requirementId: created.requirementId, version: closing.version, operationId: intent.operationId };
  expect(() => w.state.finishClose(finish)).toThrow(/requirement_write_busy/);
  child.proc.kill("SIGKILL");
  expect(await child.closed).not.toBe(0);
  expect(w.state.finishClose(finish).data.lifecycle).toBe("closed");
  expect(await commitCount(prodRequirementPath({ ...w.options, requirementId: created.requirementId }))).toBe(1);
}, 15_000);

test("完成 operation 的重复请求会核对当前工作正文，不把外部变化误报成功", async () => {
  const w = await world();
  const input = createInput();
  const created = await w.service.create(input);
  const requirementRoot = prodRequirementPath({ ...w.options, requirementId: created.requirementId });
  await writeFile(join(requirementRoot, "prod.md"), "external-after-finalize");
  await expect(w.service.create(input)).rejects.toMatchObject({ code: "working_copy_mismatch" });
});

test("finalize 后发生关闭时不返回过期 active receipt", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const input = {
    requirementId: created.requirementId,
    operationId: uuidv7(),
    version: created.version,
    title: "需求标题",
    body: "finalize 后关闭",
  };
  const original = RequirementOperations.prototype.finalize;
  vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementation(function (...args) {
    const finalized = original.apply(this, args);
    const current = w.state.read(created.requirementId);
    w.state.beginClose({
      requirementId: created.requirementId,
      version: current.version,
      intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() },
    });
    return finalized;
  });
  await expect(w.service.updateDraft(input)).rejects.toMatchObject({ code: "lifecycle_denied" });
  expect(w.state.read(created.requirementId).data.lifecycle).toBe("closing");
});

test("SQLite 原始 records/events 不含正文、patch 或正文副本字段", async () => {
  const w = await world();
  const secretBody = "SERVICE-RAW-DB-MUST-NOT-CONTAIN-THIS-BODY-7f86b2";
  const created = await w.service.create(createInput({ title: "safe-title", body: secretBody }));
  const path = repositoryDatabase(w.options.dataRoot, w.options.repoId);
  const dump = withDatabase(path, (db) => JSON.stringify({
    records: ["requirements", "requirement_requests", "requirement_operations", "requirement_service_operations"]
      .flatMap((namespace) => db.list(namespace)),
    events: db.events(`requirement_events:${created.requirementId}`),
  }));
  expect(dump).not.toContain(secretBody);
  expect(dump).not.toMatch(/"(?:body|prodBody|patch|diff|bytes|rawContent)"/);

  const databaseBytes = await readFile(path);
  expect(databaseBytes.includes(Buffer.from(secretBody))).toBe(false);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(path + suffix)) expect((await readFile(path + suffix)).includes(Buffer.from(secretBody))).toBe(false);
  }
});

const PROTOTYPE_HTML = "<!doctype html><html><body><h1>设置页</h1></body></html>";
const boardRef = (w: Awaited<ReturnType<typeof world>>) => ({ dataRoot: w.options.dataRoot, repoId: w.options.repoId });

async function acceptedPrototype(w: Awaited<ReturnType<typeof world>>, requirementId: string, name: string) {
  const runId = uuidv7();
  await beginDesign(boardRef(w), { requirementId, name, runId, agent: "designer" });
  await submitDesign(boardRef(w), { requirementId, name, runId, html: PROTOTYPE_HTML, note: "说明" });
  const pending = await pendingConfirmation(boardRef(w), { requirementId, name });
  await decidePrototype(boardRef(w), { requirementId, name, version: pending.version, hash: pending.hash, choice: "accept", opinion: null });
}

async function rejection(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(() => { throw new Error("预期被拒，但成功了"); }, (caught: unknown) => caught as { message: string; advice?: { why: string; next: string } });
  return `${error.message} ${error.advice?.why ?? ""} ${error.advice?.next ?? ""}`;
}

async function prototypeApproval(w: Awaited<ReturnType<typeof world>>) {
  const created = await w.service.create(createInput());
  await acceptedPrototype(w, created.requirementId, "设置页");
  const { digest } = await draftPrototypes(boardRef(w), created.requirementId);
  const input = { ...(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId })), prototypes: digest };
  return { created, input, digest };
}

test("看板里有原型时，批准不带原型指纹被拒并写明要带指纹", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  await acceptedPrototype(w, created.requirementId, "设置页");
  const input = await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: created.operationId });
  await expect(w.service.confirmUpdate(input)).rejects.toMatchObject({ code: "prototype_digest_required", advice: { why: expect.stringContaining("必须带上草稿原型集合的指纹") } });
  expect(w.state.read(created.requirementId).data.lifecycle).toBe("draft");
});

test("批准带的原型指纹和草稿不一致时被拒且不留未完成的批准记录，之后改草稿和用正确指纹重批都成功", async () => {
  const w = await world();
  const { created, input } = await prototypeApproval(w);
  await expect(w.service.confirmUpdate({ ...input, prototypes: "f".repeat(64) })).rejects.toThrow();
  const updated = await w.service.updateDraft({ requirementId: created.requirementId, operationId: uuidv7(), version: (await w.service.metadata(created.requirementId)).version,
    title: "需求标题", body: "批准被拒后改过的正文" });
  expect(updated.status).toBe("saved");
  const next = { ...(await manifestConfirmInput(w.options, { requirementId: created.requirementId, savedOperationId: updated.operationId })), prototypes: input.prototypes };
  expect((await w.service.confirmUpdate(next)).revision).toBe(1);
  expect((await prototypesAtRevision(boardRef(w), created.requirementId, 1)).map((item) => item.name)).toEqual(["设置页"]);
});

test("草稿里还有在途原型时，批准被拒且不留未完成的批准记录，改草稿照常成功", async () => {
  const w = await world();
  const { created, input } = await prototypeApproval(w);
  await beginDesign(boardRef(w), { requirementId: created.requirementId, name: "命令行输出", runId: uuidv7(), agent: "designer" });
  await expect(w.service.confirmUpdate(input)).rejects.toThrow();
  const updated = await w.service.updateDraft({ requirementId: created.requirementId, operationId: uuidv7(), version: (await w.service.metadata(created.requirementId)).version,
    title: "需求标题", body: "批准被拒后改过的正文" });
  expect(updated.status).toBe("saved");
  expect(await prototypesAtRevision(boardRef(w), created.requirementId, 1)).toEqual([]);
});

test("批准操作没完成期间，原型看板锁住：登记通过、返工、放弃，移除，派出新设计都被拒，原因写明需求正在批准；完成后恢复正常", async () => {
  const w = await world();
  const { created, input } = await prototypeApproval(w);
  const id = created.requirementId;
  vi.spyOn(RequirementStateStore.prototype, "recordApprovedVersion").mockRejectedValueOnce(new Error("injected approve failure"));
  await expect(w.service.confirmUpdate(input)).rejects.toThrow(/injected approve failure/);
  const before = await readPrototypeBoard(boardRef(w), id);
  const locked = async (run: () => Promise<unknown>) => {
    const text = await rejection(run);
    expect(text).toContain("需求正在批准");
    expect(text).toContain("稍后再试");
  };
  await locked(() => beginDesign(boardRef(w), { requirementId: id, name: "命令行输出", runId: uuidv7(), agent: "designer" }));
  await locked(() => removeFromDraft(boardRef(w), { requirementId: id, name: "设置页", version: 1 }));
  await locked(() => decidePrototype(boardRef(w), { requirementId: id, name: "设置页", version: 1, hash: "a".repeat(64), choice: "accept", opinion: null }));
  expect(await readPrototypeBoard(boardRef(w), id)).toEqual(before);

  expect((await w.service.confirmUpdate(input)).revision).toBe(1);
  await beginDesign(boardRef(w), { requirementId: id, name: "命令行输出", runId: uuidv7(), agent: "designer" });
});

test("带原型指纹的批准在写入前中断后，用同一份请求重放能补完：快照写入、看板提升", async () => {
  const w = await world();
  const { created, input } = await prototypeApproval(w);
  const id = created.requirementId;
  vi.spyOn(RequirementStateStore.prototype, "recordApprovedVersion").mockRejectedValueOnce(new Error("injected approve failure"));
  await expect(w.service.confirmUpdate(input)).rejects.toThrow(/injected approve failure/);
  expect(await prototypesAtRevision(boardRef(w), id, 1)).toEqual([]);
  expect((await readPrototypeBoard(boardRef(w), id)).entries[0]!.approved).toBeNull();

  const recovered = await w.service.confirmUpdate(input);
  expect(recovered).toMatchObject({ revision: 1, lifecycle: "active" });
  expect((await prototypesAtRevision(boardRef(w), id, 1)).map((item) => `${item.name}:${item.version}`)).toEqual(["设置页:1"]);
  const entry = (await readPrototypeBoard(boardRef(w), id)).entries[0]!;
  expect(entry.approved?.version).toBe(1);
  expect(entry.draft).toBeNull();
});

test("需求的 epoch 变化后，metadata 不再给出旧 epoch 的保存操作编号", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  expect((await w.service.metadata(created.requirementId)).savedOperationId).toBe(created.operationId);
  withDatabase(repositoryDatabase(w.options.dataRoot, w.options.repoId), (db) => {
    const row = db.read<{ epoch: number }>("requirements", created.requirementId)!;
    db.update("requirements", created.requirementId, row.version, { ...row.data, epoch: row.data.epoch + 1 });
  });
  const current = w.state.read(created.requirementId);
  const meta = await w.service.metadata(created.requirementId);
  expect(meta.epoch).toBe(current.data.epoch);
  expect(meta.epoch).toBe(created.epoch + 1);
  expect(meta.savedOperationId).toBeNull();
});

test("归档目录里只有本需求的原型 html 时 read 照常成功；与正文并存时判为已有归档而不是身份冲突", async () => {
  const w = await world();
  const created = await w.service.create(createInput());
  const prod = join(w.repo.root, "docs", "prod");
  await mkdir(prod, { recursive: true });
  for (const name of ["设置页", "命令行输出"]) await writeFile(join(prod, `${created.requirementId}.${name}.html`), "<html></html>");
  await expect(w.service.read({ requirementId: created.requirementId, source: "saved" })).resolves.toBeDefined();
  expect(w.state.read(created.requirementId).data.recovery).toBe("ready");

  await writeFile(join(prod, `${created.requirementId}.需求标题.md`), "正文");
  await expect(w.service.read({ requirementId: created.requirementId, source: "saved" })).rejects.toMatchObject({ code: "recovery_required" });
  expect(w.state.read(created.requirementId).data.recoveryReason).toBe("archive_found");
});
