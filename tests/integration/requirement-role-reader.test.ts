import { afterEach, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRequirementReader, REQUIREMENT_READER_TOOL } from "../../runtime/requirement-role-reader.ts";
import type { RequirementReaderOptions } from "../../runtime/requirement-role-reader.ts";
import { RequirementService } from "../../runtime/requirement-service.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";
import { ApprovalManifestStore } from "../../runtime/approval-manifest-store.ts";
import { approvalManifestReference } from "../../runtime/approval-manifest.ts";
import { UserInteractionCore } from "../../runtime/user-interaction.ts";
import { decisionDigest } from "../../runtime/short-decision-format.ts";
import { repositoryDatabase, uuidv7 } from "../../runtime/database.ts";
import { repositoryIdentity } from "../../runtime/identity.ts";
import { createRequirementReadTool } from "../../runtime/requirement-read-tool.ts";
import * as requirementReadToolModule from "../../runtime/requirement-read-tool.ts";
import * as storage from "../../runtime/prod-storage.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "../helpers/repo-fixture.ts";
import { temporaryRoot } from "../helpers/temporary-root.ts";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BODY = "# 登录 {#A}\n唯一获准目标MARKER：手机号登录并保留邮箱登录。正常：有效验证码后进入首页。异常：错误验证码留在登录页显示错误。边界：验证码过期时提示重新获取，不能进入首页。\n# 未决 {#B}\n短信限流次数未决，不实施。\n# 排除 {#C}\n本次不做微信登录。\n# 限流增强 {#D}\n短信限流增强依赖B的次数明确后才可实施。\n";
const ANSWER = "正常：有效验证码进入首页；异常：错误验证码留在登录页；边界：过期提示重取。限流未决，微信排除。仅待验场景，not_a_formal_verdict，未运行黑盒操作，性能未知。";
async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "role-reader-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const config = { repositoryRoot: repo.root, dataRoot: join(root, "private"), repoId: identity.repoId };
  const service = await RequirementService.open({ ...config, authorize: (r) => r.repoId === identity.repoId });
  const state = await RequirementStateStore.open({ ...config, authorize: (r) => r.repoId === identity.repoId });
  const saved = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "登录目标", body: BODY });
  const worktree = await addWorktree(repo);
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: saved.requirementId, version: state.read(saved.requirementId).version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  const operationId = uuidv7();
  const load = () => service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId });
  let context = await load();
  const core = await UserInteractionCore.open({ ...config, authorize: (r) => r.repoId === identity.repoId,
    authorizeAction: (r) => r.repoId === identity.repoId && r.basis.requirementId === saved.requirementId &&
      decisionDigest(r.candidate) === decisionDigest(context.candidate) && ["authorize-document", "analyze"].includes(r.action),
    loadContext: async () => { context = await load(); return { basis: context.basis, currentGoal: "", candidates: [{ ...context.candidate,
      diff: context.difference.text }], questions: [], priorDecisions: [], document: { candidate: context.candidate, title: context.title,
      body: context.body, partition: context.partition } }; },
    interpreter: { identity: () => ({ provider: "fixture", id: "document-review", configurationHash: "a".repeat(64) }),
      interpret: async ({ context: c }) => {
        const common = { basis: "explicit", resolution: "direct", candidateId: c.document!.candidate.candidateId,
          requestId: null, actions: [], references: [], supersedes: [], scope: "仅分析A；B未决，C排除" };
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
          { ...common, kind: "target", conclusion: "确认登录场景与依赖未决B的限流增强D目标" },
          { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "短信限流未决" },
          { ...common, kind: "exclusion", conclusion: "本次不做微信" },
          { ...common, kind: "action", actions: ["analyze"], conclusion: "只分析登录目标" },
        ], documentReview: { faithful: true, units: c.document!.partition.units.map((u) => ({ id: u.id,
          disposition: u.id === "B" ? "pending-description" : u.id === "C" ? "excluded" : "confirmed",
          globalConstraint: false, appliesTo: [], dependsOn: u.id === "D" ? ["B"] : [], conclusionIndexes: [u.id === "B" ? 1 : u.id === "C" ? 2 : 0] })),
          actions: [{ action: "analyze", goalIds: ["A"], constraintIds: [], conclusionIndexes: [3], unknown: false }], questions: [] } });
      } },
  });
  cleanups.push(() => core.shutdown()); core.startSession({ sessionId: "reader-fixture", windowId: "fixture-window" });
  const ticket = core.captureInput({ source: "interactive", text: "确认登录与场景及限流增强D目标，D须等B明确。限流次数B未决，不做微信，仅分析A。" }, "reader-fixture");
  const interpreted = await core.interpret(ticket, saved.requirementId); const initialDecisions = core.save(interpreted.capability);
  const document = () => core.authorizeDocument(interpreted.capability, { basis: context.basis, candidate: context.candidate });
  const authorized = document()!; expect(authorized).not.toBeNull();
  const store = new ApprovalManifestStore({ ...config, loadExpected: async () => { const c = await load();
    return { requirementId: c.requirementId, candidate: c.candidate, partition: c.partition }; },
    authorize: (r) => r.repoId === identity.repoId,
    admit: (r) => { const current = document(); return current && decisionDigest(current.authorization.manifest) === decisionDigest(r.reference)
      ? { receiptId: current.authorization.receiptId, version: current.authorization.basis.version, epoch: current.authorization.basis.epoch, inputProof: current.authorization.inputProof } : null; },
  });
  await store.register(authorized.manifest);
  const approver = await RequirementService.open({ ...config, authorize: (r) => r.repoId === identity.repoId,
    authorizeManifest: (r) => { const d = document(); return !!d && r.requirementId === saved.requirementId &&
      r.receiptId === d.authorization.receiptId && decisionDigest(r.manifest) === decisionDigest(d.authorization.manifest); } });
  const approved = await approver.confirmUpdate({ requirementId: saved.requirementId, operationId, version: context.version,
    title: context.title, body: context.body, receiptId: authorized.authorization.receiptId, manifest: approvalManifestReference(authorized.manifest) });
  // Fixture obtains the real state-service lease; the adapter never creates a PM or dispatches work.
  const lease = await state.acquirePm({ requirementId: saved.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });
  const workspace = state.read(saved.requirementId).data.workspace!;
  await mkdir(join(worktree.root, ".pi", "extensions"), { recursive: true });
  await mkdir(join(worktree.root, "docs", "spec"), { recursive: true });
  await writeFile(join(worktree.root, "AGENTS.md"), "UNAUTHORIZED_AGENTS_MARKER");
  await writeFile(join(worktree.root, "docs", "spec", "hidden.json"), "UNAUTHORIZED_SPEC_MARKER");
  await writeFile(join(worktree.root, "hidden.ts"), "UNAUTHORIZED_CODE_MARKER");
  await mkdir(join(worktree.root, ".pi", "prompts"), { recursive: true });
  await mkdir(join(worktree.root, ".pi", "skills", "poison"), { recursive: true });
  await mkdir(join(worktree.root, ".pi", "sessions"), { recursive: true });
  await writeFile(join(worktree.root, ".pi", "SYSTEM.md"), "UNAUTHORIZED_SYSTEM_MARKER");
  await writeFile(join(worktree.root, ".pi", "prompts", "poison.md"), "UNAUTHORIZED_PROMPT_MARKER");
  await writeFile(join(worktree.root, ".pi", "skills", "poison", "SKILL.md"), "UNAUTHORIZED_SKILL_MARKER");
  await writeFile(join(worktree.root, ".pi", "sessions", "old.jsonl"), JSON.stringify({ role: "user", content: "OLD_SESSION_MARKER" }));
  await writeFile(join(worktree.root, ".pi", "extensions", "poison.ts"), 'throw new Error("UNAUTHORIZED_EXTENSION_MARKER");');
  await mkdir(join(root, "sdk"), { recursive: true });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "sdk", "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const contexts: Context[] = [];
  let providerHook: ((context: Context, turn: number) => Promise<void> | void) | undefined;
  const steps: Array<Record<string, unknown> | undefined> = [{ action: "read" }];
  runtime.registerProvider("reader-fixture", { baseUrl: "http://localhost.invalid", apiKey: "fixture-only", api: "openai-completions",
    models: [{ id: "deterministic", name: "deterministic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model, c, opts) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now() };
        try {
          await opts?.onPayload?.({ messages: c.messages, tools: c.tools }, model);
          opts?.signal?.throwIfAborted(); contexts.push(JSON.parse(JSON.stringify(c)));
          await providerHook?.(c, contexts.length);
          opts?.signal?.throwIfAborted();
          const args = steps[contexts.length - 1];
          output.content = args ? [{ type: "toolCall", id: `read-call-${contexts.length}`, name: REQUIREMENT_READER_TOOL, arguments: args }]
            : [{ type: "text", text: ANSWER }];
          output.stopReason = args ? "toolUse" : "stop";
          stream.push({ type: "start", partial: output }); stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end();
        } catch {
          output.stopReason = opts?.signal?.aborted ? "aborted" : "error"; output.errorMessage = "fixture cancelled";
          stream.push({ type: "error", reason: output.stopReason, error: output }); stream.end();
        }
      })(); return stream;
    },
  });
  await runtime.setRuntimeApiKey("reader-fixture", "fixture-only");
  const permits = new Map<string, string>();
  const controller = new AbortController();
  function options(role: "pm" | "reviewer" | "qa" = "qa"): RequirementReaderOptions {
    const binding = { role, callerId: uuidv7(), runId: role === "pm" ? lease.runId : uuidv7(), requirementId: saved.requirementId,
      repoId: identity.repoId, workspaceId: workspace.workspaceId, branch: workspace.branch, lease: structuredClone(lease),
      diffBaseline: { revision: 1, reference: { commit: approved.commit, hash: approved.prodHash.slice(7) } } };
    permits.set(binding.callerId, JSON.stringify(binding));
    return { ...config, binding, authorize: (r) => permits.get(r.binding.callerId) === JSON.stringify(r.binding),
      modelRuntime: runtime, modelRef: { provider: "reader-fixture", id: "deterministic" }, question: "列出正常、异常、边界黑盒待验场景与未决和排除范围。",
      signal: controller.signal, timeoutMs: 30_000 };
  }
  async function reader(o = options()) { const r = await createRequirementReader(o); cleanups.push(() => r.dispose()); return r; }
  function close() { const r = state.read(saved.requirementId); state.beginClose({ requirementId: saved.requirementId, version: r.version,
    intent: { operationId: uuidv7(), receiptId: uuidv7(), reason: "cancelled" } }); }
  return { core, initialDecisions, config, root, repo, saved, approved, state, service, lease, workspace, worktree, runtime, contexts, controller, permits, options, reader, close,
    setHook: (hook: typeof providerHook) => { providerHook = hook; }, setArgs: (input: Record<string, unknown>, turn = 1) => { steps[turn - 1] = input; } };
}

async function decisionSupersede(w: Awaited<ReturnType<typeof world>>) {
  const baseline = w.state.read(w.saved.requirementId), originalId = w.initialDecisions.decisionIds[0]!;
  const second = await UserInteractionCore.open({ ...w.config,
    authorize: (request) => request.repoId === w.config.repoId &&
      (request.input.requirementId === undefined || request.input.requirementId === w.saved.requirementId),
    authorizeAction: () => false,
    loadContext: async (requirementId) => {
      if (requirementId !== w.saved.requirementId) throw new Error("unexpected_requirement");
      return { basis: { requirementId, version: baseline.version, epoch: baseline.data.epoch, prod: baseline.data.approved },
        currentGoal: "", candidates: [], questions: [], priorDecisions: [w.core.readDecision(requirementId, originalId)] };
    },
    interpreter: { identity: () => ({ provider: "fixture", id: "role-revision", configurationHash: "b".repeat(64) }),
      interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "explicit", entries: [{
        basis: "explicit", resolution: "direct", kind: "target", candidateId: null, requestId: null, actions: [], references: [],
        supersedes: [originalId], conclusion: "修订登录目标", scope: "仅登录目标" }] }) },
  });
  cleanups.push(() => second.shutdown()); second.startSession({ sessionId: "second-role", windowId: "second-role" });
  const revised = await second.interpret(second.captureInput({ source: "interactive", text: "修订登录目标" }, "second-role"), w.saved.requirementId);
  let injected = false;
  const inject = () => { if (!injected) { second.save(revised.capability); injected = true; } };
  const verify = () => {
    expect(injected).toBe(true); expect(w.state.read(w.saved.requirementId)).toEqual(baseline);
    expect(second.readDecision(w.saved.requirementId, originalId)).toMatchObject({ status: "superseded" });
  };
  return { inject, verify };
}

test.each(["pm", "reviewer", "qa"] as const)("真实SDK %s 仅见获准prod/scope，问答不是正式裁决，正文不入SQLite", async (role) => {
  const w = await world(), r = await w.reader(w.options(role));
  const before = await readFile(repositoryDatabase(w.config.dataRoot, w.config.repoId));
  const result = await r.run();
  expect(result).toMatchObject({ text: ANSWER, not_a_formal_verdict: true, sessionPersisted: false, operationsSettled: true,
    approvalScope: { pending: ["B"], excluded: ["C"], blocked: ["D"] },
    coverage: { representation: "parsed_prod_body", readPages: 1, entireProdCovered: true, blocking: [],
      businessCompleteness: "not_mechanically_proven", verification: "not_evaluated", performance: "unknown" } });
  expect(w.contexts).toHaveLength(2);
  expect(w.contexts[0]!.tools!.map((t) => t.name)).toEqual([REQUIREMENT_READER_TOOL]);
  expect(JSON.stringify(w.contexts[0])).not.toContain("唯一获准目标MARKER");
  const toolResult = w.contexts[1]!.messages.find((m) => m.role === "toolResult")!;
  expect(JSON.stringify(toolResult)).toContain("唯一获准目标MARKER");
  expect(JSON.stringify(toolResult)).toContain('pending');
  expect(JSON.stringify(w.contexts)).not.toMatch(/UNAUTHORIZED_|OLD_SESSION/);
  expect(await readFile(repositoryDatabase(w.config.dataRoot, w.config.repoId))).toEqual(before);
  const dbBytes = await readFile(repositoryDatabase(w.config.dataRoot, w.config.repoId));
  expect(dbBytes.includes(Buffer.from("唯一获准目标MARKER"))).toBe(false); expect(dbBytes.includes(Buffer.from(ANSWER))).toBe(false);
  expect(w.state.read(w.saved.requirementId).data.lifecycle).toBe("active");
  await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
}, 20_000);

test("真实SDK标准ToolDefinition接metadata/section/diff，准确基线与scope保留", async () => {
  const w = await world(); w.setArgs({ action: "metadata" }); w.setArgs({ action: "read", sectionId: "A" }, 2); w.setArgs({ action: "diff" }, 3);
  const r = await w.reader();
  expect(await r.run()).toMatchObject({ not_a_formal_verdict: true, approvalScope: { pending: ["B"], excluded: ["C"], blocked: ["D"] },
    coverage: { representation: "parsed_prod_body", readPages: 1, entireProdCovered: false,
      blocking: ["incomplete_prod_read", "global_constraints_and_unresolved_may_be_outside_page"] } });
  expect(w.contexts).toHaveLength(4);
  const results = w.contexts[3]!.messages.filter((m) => m.role === "toolResult").map((m) => JSON.parse((m.content[0] as any).text));
  expect(results.map((r) => r.kind)).toEqual(["metadata", "read", "diff"]);
  expect(results[1].coverage).toMatchObject({ sectionId: "A", entireProdCovered: false });
  expect(results[1].source.approvalScope.summary).toMatchObject({ pending: ["B"], excluded: ["C"], blocked: ["D"] });
  expect(results[2].difference).toMatchObject({ fromCommit: w.approved.commit, toCommit: w.approved.commit });
}, 20_000);

test("read/diff/metadata完成JSON包装后都以原结果对象调用guard，复制对象被拒绝", async () => {
  const w = await world(); w.setArgs({ action: "metadata" }); w.setArgs({ action: "read", sectionId: "A" }, 2); w.setArgs({ action: "diff" }, 3);
  const originalFactory = requirementReadToolModule.createRequirementReadTool;
  const guarded: unknown[] = [];
  vi.spyOn(requirementReadToolModule, "createRequirementReadTool").mockImplementation(async (options) => {
    const inner = await originalFactory(options);
    return Object.freeze({ ...inner, assertCurrent(result: unknown) {
      guarded.push(result);
      expect(() => inner.assertCurrent(JSON.parse(JSON.stringify(result)))).toThrow(/requirement_read_denied/);
      inner.assertCurrent(result);
    } });
  });
  const r = await w.reader(); await r.run();
  expect(guarded.map((result: any) => result.kind)).toEqual(["metadata", "read", "diff"]);
  expect(guarded.every((result) => Object.isFrozen(result))).toBe(true);
}, 20_000);

test("真实SDK按随机游标逐页读获准正文，所有页都保留范围和不完整警告", async () => {
  const w = await world(); w.setArgs({ action: "read", maxBytes: 80 });
  w.setHook((c, turn) => {
    const last = c.messages.filter((m) => m.role === "toolResult").at(-1);
    if (!last) return;
    const page = JSON.parse((last.content[0] as any).text);
    if (page.coverage.nextCursor) w.setArgs({ action: "read", maxBytes: 80, cursor: page.coverage.nextCursor }, turn);
  });
  const r = await w.reader(); const result = await r.run();
  const pages = w.contexts.at(-1)!.messages.filter((m) => m.role === "toolResult").map((m) => JSON.parse((m.content[0] as any).text));
  expect(pages.length).toBeGreaterThan(1); expect(pages.map((p) => p.text).join("")).toBe(BODY);
  expect(result).toMatchObject({ approvalScope: { pending: ["B"], excluded: ["C"], blocked: ["D"] },
    coverage: { representation: "parsed_prod_body", readPages: pages.length, entireProdCovered: true, blocking: [],
      businessCompleteness: "not_mechanically_proven", verification: "not_evaluated", performance: "unknown" } });
  for (const page of pages) {
    expect(page.source.approvalScope.summary).toMatchObject({ pending: ["B"], excluded: ["C"], blocked: ["D"] });
    expect(page.coverage.blocking).toContain("incomplete_prod_read");
  }
}, 30_000);

test("六角色/伪身份负面矩阵：main与worker无入口，错误租约和许可启动前拒绝", async () => {
  const w = await world(); const probe = vi.spyOn(storage, "readVersion");
  for (const mutate of [
    (o: RequirementReaderOptions) => { (o.binding as any).role = "main"; },
    (o: RequirementReaderOptions) => { (o.binding as any).role = "worker"; },
    (o: RequirementReaderOptions) => { o.binding.role = "pm"; },
    (o: RequirementReaderOptions) => { o.binding.requirementId = uuidv7(); },
    (o: RequirementReaderOptions) => { o.binding.workspaceId = "f".repeat(64); },
    (o: RequirementReaderOptions) => { o.binding.branch = "refs/heads/fake"; },
    (o: RequirementReaderOptions) => { o.binding.lease.fence++; },
    (o: RequirementReaderOptions) => { o.binding.lease.contextGeneration++; },
    (o: RequirementReaderOptions) => { o.binding.lease.epoch++; },
    (o: RequirementReaderOptions) => { o.binding.lease.expiresAt = 0; },
    (o: RequirementReaderOptions) => { o.authorize = () => false; },
    (o: RequirementReaderOptions) => { o.authorize = (() => Promise.resolve(true)) as any; },
  ]) {
    const o = w.options(); mutate(o); w.permits.set(o.binding.callerId, JSON.stringify(o.binding));
    await expect(createRequirementReader(o)).rejects.toThrow();
  }
  expect(probe).not.toHaveBeenCalled(); expect(w.contexts).toHaveLength(0);
}, 20_000);

test.each(["close", "revoke", "update", "branch"] as const)("SDK工具结果与后续模型请求之间%s，不再提交目标或答案", async (change) => {
  const w = await world(); const original = RequirementService.prototype.read;
  vi.spyOn(RequirementService.prototype, "read").mockImplementationOnce(async function (this: RequirementService, input) {
    const result = await original.call(this, input);
    if (change === "close") w.close();
    if (change === "revoke") w.controller.abort();
    if (change === "update") await w.service.updateDraft({ requirementId: w.saved.requirementId, operationId: uuidv7(),
      version: w.state.read(w.saved.requirementId).version, title: "登录目标", body: BODY + "待核对更新" });
    if (change === "branch") await exec("git", ["checkout", "-b", "changed"], { cwd: w.worktree.root, env: GIT_ENV });
    return result;
  });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied", operationsSettled: true });
  expect(w.contexts).toHaveLength(1);
}, 20_000);

for (const boundary of ["service", "tool_execution_end微任务", "dispose微任务"] as const) {
  test(`真实第二Core在${boundary}取代决定后拒绝旧范围`, async () => {
    const w = await world(), revision = await decisionSupersede(w);
    if (boundary === "service") {
      const original = RequirementService.prototype.read;
      vi.spyOn(RequirementService.prototype, "read").mockImplementationOnce(async function (this: RequirementService, input) {
        const result = await original.call(this, input); revision.inject(); return result;
      });
    } else if (boundary === "tool_execution_end微任务") {
      const original = AgentSession.prototype.prompt;
      vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
        const unsubscribe = this.subscribe((event) => { if (event.type === "tool_execution_end") queueMicrotask(revision.inject); });
        try { await original.apply(this, args); } finally { unsubscribe(); }
      });
    } else {
      const original = AgentSession.prototype.dispose;
      vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
        original.call(this); queueMicrotask(revision.inject);
      });
    }
    const r = await w.reader();
    await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
    revision.verify();
    expect(w.contexts).toHaveLength(boundary === "dispose微任务" ? 2 : 1);
  }, 20_000);
}

test.each(["close", "host", "signal"] as const)("最终模型返回时%s，含目标答案不能交付", async (change) => {
  const w = await world(); w.setHook((_c, turn) => { if (turn === 2) {
    if (change === "close") w.close(); else if (change === "host") w.permits.clear(); else w.controller.abort();
  } });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(w.contexts).toHaveLength(2); expect((await r.dispose()).operationsSettled).toBe(true);
}, 20_000);

test("伪role/action/read source来自模型不扩权，dispose前后不能复用", async () => {
  const w = await world(); w.setArgs({ action: "read", role: "main", source: "saved" });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  const other = await w.reader(); expect(await other.dispose()).toEqual({ operationsSettled: true });
  await expect(other.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
});

test("取消后provider仍在运行时不假报停止，结束后dispose确认收尾", async () => {
  const w = await world(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => { release = r; }), entered = new Promise<void>((r) => { started = r; });
  w.setHook(async () => { started(); await waiting; });
  const o = w.options(); o.stopTimeoutMs = 10;
  const r = await w.reader(o), run = r.run(); void run.catch(() => undefined); await entered; w.controller.abort();
  await expect(run).rejects.toMatchObject({ code: "requirement_reader_stop_incomplete", operationsSettled: false });
  release(); expect(await r.dispose()).toEqual({ operationsSettled: true });
}, 20_000);

test("页间更新/关闭使旧游标失效，真实租约不能被authorize true替代", async () => {
  const w = await world(), o = w.options(); const tool = await createRequirementReadTool(o); cleanups.push(() => tool.dispose());
  const first = await tool.execute({ action: "read", maxBytes: 4 }) as any;
  expect(first.source.approvalScope.summary.pending).toEqual(["B"]); expect(first.coverage.entireProdCovered).toBe(false);
  w.state.releasePm(w.lease);
  await expect(createRequirementReader({ ...o, authorize: () => true })).rejects.toThrow();
  w.close(); await expect(tool.execute({ action: "read", maxBytes: 4, cursor: first.coverage.nextCursor })).rejects.toThrow();
});

test("工具已交给SDK后微任务撤权阻止下一模型请求", async () => {
  const w = await world();
  const original = AgentSession.prototype.prompt;
  vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
    const unsub = this.subscribe((e) => { if (e.type === "tool_execution_end") queueMicrotask(() => w.permits.clear()); });
    try { await original.apply(this, args); } finally { unsub(); }
  });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(w.contexts).toHaveLength(1);
}, 20_000);

test("最后cleanup await中的微任务撤权仍在公开run返回帧同步复核", async () => {
  const w = await world(), original = AgentSession.prototype.dispose;
  vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
    original.call(this); queueMicrotask(() => w.permits.clear());
  });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(w.contexts).toHaveLength(2);
}, 20_000);

test("跨进程关闭不依赖本进程通知队列，最终答案拒绝且无新模型请求", async () => {
  const w = await world();
  const modulePath = new URL("../../runtime/requirement-state.ts", import.meta.url).href;
  w.setHook(async (_c, turn) => { if (turn !== 2) return;
    const script = `import { RequirementStateStore } from ${JSON.stringify(modulePath)};
const config = ${JSON.stringify(w.config)};
const s = await RequirementStateStore.open({...config, authorize:r=>r.repoId===config.repoId});
const id=${JSON.stringify(w.saved.requirementId)}, r=s.read(id);
s.beginClose({requirementId:id,version:r.version,intent:{operationId:${JSON.stringify(uuidv7())},receiptId:${JSON.stringify(uuidv7())},reason:"cancelled"}});`;
    await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: w.root });
  });
  const r = await w.reader(); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(w.state.read(w.saved.requirementId).data.lifecycle).toBe("closing"); expect(w.contexts).toHaveLength(2);
}, 20_000);

test("draft与关闭需求即使宿主回调true仍不能开始会话，实际read探针为零", async () => {
  const w = await world();
  const draft = await w.service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "draft", body: "DRAFT_ONLY_MARKER" });
  const o = w.options(), probe = vi.spyOn(storage, "readVersion");
  o.binding.requirementId = draft.requirementId; o.binding.lease.requirementId = draft.requirementId; o.authorize = () => true;
  await expect(createRequirementReader(o)).rejects.toMatchObject({ code: "requirement_reader_denied" });
  w.close(); await expect(w.reader()).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(probe).not.toHaveBeenCalled(); expect(w.contexts).toHaveLength(0);
}, 20_000);

test("模型启动前worktree异步核验未结束时dispose不能假报停止", async () => {
  const w = await world(), o = w.options(); o.stopTimeoutMs = 10;
  const r = await w.reader(o), original = RequirementStateStore.prototype.checkPm;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(RequirementStateStore.prototype, "checkPm").mockImplementationOnce(async function (this: RequirementStateStore, lease) {
    entered(); await blocked; return original.call(this, lease);
  });
  const run = r.run(); void run.catch(() => undefined); await started;
  expect(await r.dispose()).toEqual({ operationsSettled: false }); release();
  await expect(run).rejects.toMatchObject({ code: "requirement_reader_denied" });
  expect(await r.dispose()).toEqual({ operationsSettled: true }); expect(w.contexts).toHaveLength(0);
}, 20_000);

test("超时触发自有SDK abort并等待合作provider结束", async () => {
  const w = await world(); w.setHook(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  const o = w.options(); o.timeoutMs = 50;
  const r = await w.reader(o); await expect(r.run()).rejects.toMatchObject({ code: "requirement_reader_denied", operationsSettled: true });
  expect(await r.dispose()).toEqual({ operationsSettled: true });
}, 20_000);

