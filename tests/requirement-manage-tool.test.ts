import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { uuidv7, withDatabase, repositoryDatabase } from "../runtime/database.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import type { TargetConfirmationScope } from "../runtime/host-authorization.ts";
import { REQUIREMENT_MANAGE_PARAMETERS, createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import { requirementIntentHash } from "../runtime/requirement-manage-contracts.ts";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", args, { cwd, env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}

async function world(withWorktree = false) {
  const root = await mkdtemp(join(temporaryRoot(), "requirement-tool-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const dataRoot = join(root, "data");
  await mkdir(repositoryRoot);
  await mkdir(dataRoot);
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFile(join(repositoryRoot, "README.md"), "fixture\n");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
  const identity = await repositoryIdentity(repositoryRoot);
  let worktree: string | undefined;
  if (withWorktree) {
    worktree = join(root, "worktree");
    await git(repositoryRoot, ["worktree", "add", "-b", `req-${uuidv7()}`, worktree, "HEAD"]);
  }
  return { root, repositoryRoot, dataRoot, repoId: identity.repoId, worktree };
}

function context(sessionId: string, confirm: (title: string, message: string) => Promise<boolean>, hasUI = true): ExtensionContext {
  return {
    cwd: "/not-used",
    mode: hasUI ? "tui" : "print",
    hasUI,
    ui: { confirm } as never,
    sessionManager: { getSessionId: () => sessionId } as never,
  } as ExtensionContext;
}

function toolFor(world: Awaited<ReturnType<typeof world>>, authorization: HostAuthorizationManager, sessionId: string) {
  return createRequirementManageTool({
    dataRoot: world.dataRoot,
    gitExecutable: "/usr/bin/git",
    authorization,
    resolveHost: async () => ({
      windowId: "window-main",
      sessionId,
      repositories: new Map([[world.repoId, { path: world.repositoryRoot }]]),
    }),
  });
}

async function call(tool: ReturnType<typeof createRequirementManageTool>, params: Record<string, unknown>, ctx: ExtensionContext) {
  return tool.execute(uuidv7(), params as never, undefined, undefined, ctx);
}

function startAuthorization(dataRoot: string, repoId: string, sessionId = "session-main", now?: () => number) {
  const authorization = new HostAuthorizationManager({ dataRoot, now, receiptTtlMs: 100 });
  authorization.startWindow({ kind: "main", windowId: "window-main", sessionId, repoIds: [repoId] });
  return authorization;
}

describe("requirement_manage 参数与可信 input", () => {
  test("schema 不接受 actor/role/cwd/receipt/hash 等模型自填授权字段", () => {
    const base = { action: "create", repoId: "a".repeat(64), requestId: uuidv7(), operationId: uuidv7(), title: "标题", body: "正文" };
    expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, base)).toBe(true);
    for (const forged of [
      { actor: "user" }, { role: "main" }, { cwd: "/tmp/repo" }, { receiptId: uuidv7() }, { intentHash: "b".repeat(64) }, { commit: "c".repeat(40) },
    ]) expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, { ...base, ...forged })).toBe(false);
  });

  test("无真实 input、extension 注入、错误 session/repo 均不能保存 draft；interactive/rpc 只授予绑定 draft", async () => {
    const w = await world();
    const authorization = startAuthorization(w.dataRoot, w.repoId);
    const binding = { action: "create" as const, repoId: w.repoId, requestId: uuidv7(), operationId: uuidv7(), intentHash: "d".repeat(64) };
    const authorize = authorization.authorizer(binding, "session-main");
    const request = { ...binding, action: "create" as const };
    expect(authorize(request)).toBe(false);
    authorization.captureInput("extension", "session-main");
    expect(authorize(request)).toBe(false);
    authorization.captureInput("interactive", "session-main");
    expect(authorize(request)).toBe(true);
    expect(() => authorization.captureInput("unknown-source", "session-main")).toThrow(/未知 input 来源/);
    expect(authorize(request)).toBe(false);
    authorization.captureInput("rpc", "session-main");
    expect(authorize(request)).toBe(true);
    expect(authorize({ ...request, operationId: uuidv7() })).toBe(false);
    expect(authorize({ ...request, repoId: "e".repeat(64) })).toBe(false);
    expect(() => authorization.captureInput("rpc", "other-session")).toThrow(/untrusted_host/);
    authorization.shutdown();
    expect(authorize(request)).toBe(false);
  });
});

describe("真实 RequirementService 接线", () => {
  test("create 经过真实服务、SQLite 与本机 Git；重复 request/operation 幂等且正文首提一致", async () => {
    const w = await world();
    const authorization = startAuthorization(w.dataRoot, w.repoId);
    authorization.captureInput("interactive", "session-main");
    const tool = toolFor(w, authorization, "session-main");
    const params = { action: "create", repoId: w.repoId, requestId: uuidv7(), operationId: uuidv7(), title: "首个目标", body: "只保存草稿" };
    const first = await call(tool, params, context("session-main", async () => false));
    const second = await call(tool, params, context("session-main", async () => false));
    expect(first.details).toEqual(second.details);
    const details = first.details as { requirementId: string; commit: string; prodHash: string; lifecycle: string };
    expect(details.requirementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(details.lifecycle).toBe("draft");
    const requirementRoot = join(w.dataRoot, "repos", w.repoId, "requirements", details.requirementId);
    expect(await git(requirementRoot, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(requirementRoot, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("prod.md");
    expect(await git(requirementRoot, ["show", "-s", "--format=%an <%ae>%n%B", "HEAD"])).toContain("pi prod storage <pi-prod-storage@localhost>");
    const bytes = await readFile(join(requirementRoot, "prod.md"));
    expect(details.prodHash).toBe(`sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`);
    authorization.shutdown();
  });

  test("confirm 通过真实 UI receipt，仅确认目标；重复 operation 不重复询问，hash/epoch/撤权/过期均拒绝", async () => {
    let now = 1_000;
    const w = await world(true);
    const authorization = startAuthorization(w.dataRoot, w.repoId, "session-main", () => now);
    authorization.captureInput("interactive", "session-main");
    const tool = toolFor(w, authorization, "session-main");
    const created = (await call(tool, { action: "create", repoId: w.repoId, requestId: uuidv7(), operationId: uuidv7(), title: "草稿", body: "draft" }, context("session-main", async () => false))).details as { requirementId: string; version: number };
    const store = await RequirementStateStore.open({ dataRoot: w.dataRoot, repoId: w.repoId, repositoryRoot: w.repositoryRoot, now: () => now, authorize: () => true });
    const baseCommit = await git(w.repositoryRoot, ["rev-parse", "HEAD"]);
    const bound = await store.bindWorkspace({ requirementId: created.requirementId, version: created.version, path: w.worktree!, prepareOperationId: uuidv7(), baseCommit });

    let confirms = 0;
    let confirmationMessage = "";
    const operationId = uuidv7();
    const params = { action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId, operationId, version: bound.version, title: "正式目标", body: "只批准目标，不批准实施" };
    const ctx = context("session-main", async (_title, message) => { confirms += 1; confirmationMessage = message; return true; });
    const first = await call(tool, params, ctx);
    const repeat = await call(tool, params, ctx);
    expect(confirms).toBe(1);
    expect(confirmationMessage).toContain("仅确认需求目标，不授权规划、派工、代码修改或其他实施动作");
    expect(first.details).toEqual(repeat.details);
    expect((first.details as { lifecycle: string }).lifecycle).toBe("active");

    const intentHash = requirementIntentHash({ title: params.title, body: params.body });
    const scope: TargetConfirmationScope = { action: "confirmUpdate", purpose: "target-confirmation", implementation: "not-authorized", repoId: w.repoId,
      requirementId: created.requirementId, operationId, intentHash, epoch: (first.details as { epoch: number }).epoch, version: bound.version };
    const receipt = authorization.confirmation(scope, "session-main");
    expect(receipt.status).toBe("valid");
    if (receipt.status !== "valid") return;
    const confirmAuthorize = authorization.authorizer({ action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId,
      operationId, version: bound.version, intentHash, epoch: scope.epoch, receiptId: receipt.receipt.receiptId }, "session-main");
    expect(confirmAuthorize({ action: "updateDraft", repoId: w.repoId, requirementId: created.requirementId, operationId, version: bound.version, intentHash })).toBe(false);
    expect(confirmAuthorize({ action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId, operationId,
      version: bound.version, intentHash, epoch: scope.epoch + 1, receiptId: receipt.receipt.receiptId })).toBe(false);
    expect(authorization.confirmation({ ...scope, epoch: scope.epoch + 1 }, "session-main").status).toBe("conflict");
    expect(authorization.confirmation({ ...scope, version: scope.version + 1 }, "session-main").status).toBe("conflict");
    const wrongVersion = authorization.authorizer({ action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId,
      operationId, version: bound.version + 1, intentHash, epoch: scope.epoch, receiptId: receipt.receipt.receiptId }, "session-main");
    expect(wrongVersion({ action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId, operationId,
      version: bound.version + 1, intentHash, epoch: scope.epoch, receiptId: receipt.receipt.receiptId })).toBe(false);
    const recorded = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.data).toMatchObject({ actor: "user", status: "confirmed", conclusion: `确认需求目标：${params.title}`,
      requirementVersion: bound.version, basisReceiptId: receipt.receipt.receiptId });
    expect((recorded[0]!.data as { scope: string }).scope).toContain("实施权限须另行核验");
    const resumed = startAuthorization(w.dataRoot, w.repoId, "fresh-session", () => now);
    const resumedTool = toolFor(w, resumed, "fresh-session");
    const resumedResult = await call(resumedTool, params, context("fresh-session", async () => { throw new Error("原回执不应重复确认"); }));
    expect(resumedResult.details).toEqual(first.details);
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"))).toHaveLength(1);
    resumed.shutdown();
    expect(receipt.receipt.actor).toBe("user");
    expect(receipt.receipt.conclusion).toBe("target-confirmed");
    expect(receipt.receipt.scope.implementation).toBe("not-authorized");
    expect(JSON.stringify(receipt.receipt)).not.toContain(params.body);
    expect(JSON.stringify(receipt.receipt)).not.toContain(params.title);

    await expect(call(tool, { ...params, body: "换成另一目标" }, ctx)).rejects.toThrow(/回执/);
    expect(confirms).toBe(1);
    authorization.revokeConfirmation(w.repoId, operationId, "session-main");
    await expect(call(tool, params, ctx)).rejects.toThrow(/回执/);

    const secondOperation = uuidv7();
    const secondScope = { ...scope, operationId: secondOperation };
    authorization.recordConfirmation(secondScope, "session-main");
    now += 101;
    expect(authorization.confirmation(secondScope, "session-main").status).toBe("expired");
    authorization.shutdown();
  });

  test("无 UI/用户拒绝不生成回执，未绑定 ready workspace 由真实服务明确阻塞", async () => {
    const w = await world();
    const authorization = startAuthorization(w.dataRoot, w.repoId);
    authorization.captureInput("rpc", "session-main");
    const tool = toolFor(w, authorization, "session-main");
    const created = (await call(tool, { action: "create", repoId: w.repoId, requestId: uuidv7(), operationId: uuidv7(), title: "草稿", body: "draft" }, context("session-main", async () => false))).details as { requirementId: string; version: number };
    const base = { action: "confirmUpdate", repoId: w.repoId, requirementId: created.requirementId, version: created.version, title: "目标", body: "正文" };
    await expect(call(tool, { ...base, operationId: uuidv7() }, context("session-main", async () => true, false))).rejects.toThrow(/UI/);
    let asked = 0;
    await expect(call(tool, { ...base, operationId: uuidv7() }, context("session-main", async () => { asked += 1; return false; }))).rejects.toThrow(/取消或拒绝/);
    expect(asked).toBe(1);
    await expect(call(tool, { ...base, operationId: uuidv7() }, context("session-main", async () => true))).rejects.toMatchObject({ code: "workspace_not_ready" });
    authorization.shutdown();
  });

  test("closing 后正文 read 被真实服务拒绝，但 metadata 仍可返回且不含正文", async () => {
    const w = await world();
    const authorization = startAuthorization(w.dataRoot, w.repoId);
    authorization.captureInput("interactive", "session-main");
    const tool = toolFor(w, authorization, "session-main");
    const created = (await call(tool, { action: "create", repoId: w.repoId, requestId: uuidv7(), operationId: uuidv7(), title: "关闭草稿", body: "不能旁路读取" }, context("session-main", async () => false))).details as { requirementId: string; version: number };
    const store = await RequirementStateStore.open({ dataRoot: w.dataRoot, repoId: w.repoId, repositoryRoot: w.repositoryRoot, authorize: () => true });
    await store.beginClose({ requirementId: created.requirementId, version: created.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    await expect(call(tool, { action: "read", repoId: w.repoId, requirementId: created.requirementId, source: "saved" }, context("session-main", async () => false))).rejects.toMatchObject({ code: "lifecycle_denied" });
    const metadata = await call(tool, { action: "metadata", repoId: w.repoId, requirementId: created.requirementId }, context("session-main", async () => false));
    expect((metadata.details as { lifecycle: string }).lifecycle).toBe("closing");
    expect(JSON.stringify(metadata.details)).not.toContain("不能旁路读取");
    const receiptRows = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("host_requirement_target_receipts_v1"));
    expect(JSON.stringify(receiptRows)).not.toContain("不能旁路读取");
    authorization.shutdown();
  });
});
