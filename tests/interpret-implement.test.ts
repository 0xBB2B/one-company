import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { continuityInputProofIn } from "../src/modules/requirement/interaction-continuity.ts";
import { RequirementService } from "../src/modules/requirement/requirement-service.ts";
import type { RequirementRecord } from "../src/modules/requirement/requirement-contracts.ts";
import { UserInteractionCore } from "../src/modules/interaction/user-interaction.ts";
import type { InteractionInterpreter } from "../src/modules/interaction/user-interaction.ts";
import { createPiInteractionInterpreter } from "../src/modules/interaction/user-interaction-model.ts";
import type { InteractionContext, InteractionEntry, InteractionInterpretation } from "../src/modules/requirement/user-interaction-format.ts";
import { partitionPrdDocument } from "../src/modules/requirement/prd-view.ts";
import { approveWithManifest } from "./helpers/approval-fixture.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const model = { provider: "controlled-fixture", id: "fixture-not-quality-evidence", configurationHash: "a".repeat(64) };
const IMPLEMENT = "授权实施";
const NOT_EXPLICIT_NEXT = "这句用户原话已作废，不能直接重试；请用户在主窗口说清楚是否要实施，再用 authorizeImplement 登记";

function entry(patch: Partial<InteractionEntry> = {}): InteractionEntry {
  return { kind: "action", basis: "explicit", resolution: "direct", candidateId: null, requestId: null, actions: ["implement"],
    conclusion: "开始实施", scope: "整份已批准需求", references: [], supersedes: [], ...patch };
}
function result(entries: InteractionEntry[]): InteractionInterpretation {
  return { format: "interaction-interpretation/v1", referenceResolution: "none", entries };
}
const unresolved = () => entry({ kind: "unresolved", basis: "uncertain", resolution: "unclear", actions: [], conclusion: "是否实施没说清", scope: "实施授权" });

async function world(options: { withAuthorization?: boolean; interpreter?: InteractionInterpreter } = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "interpret-implement-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  const config = { repositoryRoot: repo.root, dataRoot: join(root, "data"), repoId: identity.repoId };
  const service = await RequirementService.open({ ...config, authorize: () => true });
  const created = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title: "补授权", body: "# A {#A}\n手机号登录\n" });
  await approveWithManifest(config, { requirementId: created.requirementId, savedOperationId: created.operationId, implement: false });
  const path = repositoryDatabase(config.dataRoot, config.repoId);
  const requirementId = created.requirementId;
  const requirement = () => withDatabase(path, (db) => db.read<RequirementRecord>("requirements", requirementId))!;
  const row = requirement(), reference = row.data.approvalManifest!.reference;
  const basis = { requirementId, version: row.version, epoch: row.data.epoch, prd: row.data.approved };
  const context: InteractionContext = { basis, currentGoal: "", candidates: [], questions: [], priorDecisions: [],
    ...(options.withAuthorization === false ? {} : { implementAuthorization: { revision: row.data.revision, manifest: reference } }) };
  let output = result([entry()]), selected = { ...model }, actionHook: (request: { action: string }) => boolean = () => true;
  const interpreter: InteractionInterpreter = options.interpreter ?? { identity: () => selected,
    interpret: async () => JSON.stringify(output) };
  const core = await UserInteractionCore.open({ ...config, authorize: () => true,
    authorizeAction: (request) => actionHook(request as unknown as { action: string }), interpreter, loadContext: async () => structuredClone(context) });
  cleanup.push(() => core.shutdown());
  core.startSession({ sessionId: "session", windowId: "window" });
  const capture = (text = IMPLEMENT) => core.captureInput({ source: "interactive", text }, "session");
  const interpret = (text = IMPLEMENT) => core.interpret(capture(text), requirementId);
  const baseline = withDatabase(path, (db) => db.list("short_decisions")).length;
  return { core, path, baseline, requirementId, requirement, row, reference, context, basis, capture, interpret,
    setOutput: (value: InteractionInterpretation) => { output = value; },
    setModel: (value: typeof model) => { selected = value; },
    setActionHook: (hook: (request: { action: string }) => boolean) => { actionHook = hook; },
    records: () => withDatabase(path, (db) => db.list("short_decisions")),
    proof: () => withDatabase(path, (db) => continuityInputProofIn(db, requirementId)),
    bumpVersion: () => withDatabase(path, (db) => { const r = db.read<RequirementRecord>("requirements", requirementId)!;
      db.update("requirements", requirementId, r.version, { ...r.data, updatedAt: r.data.updatedAt + 1 }); }) };
}
type World = Awaited<ReturnType<typeof world>>;
async function authorized(w: World) {
  const { capability } = await w.interpret(), saved = w.core.save(capability);
  return { capability, saved };
}

test("实施授权上下文下原话明确要实施：解读出唯一一条实施动作条目，可保存", async () => {
  const w = await world();
  const { interpretation, capability } = await w.interpret();
  expect(interpretation.entries).toHaveLength(1);
  expect(interpretation.entries[0]).toMatchObject({ kind: "action", basis: "explicit", resolution: "direct", candidateId: null, requestId: null,
    actions: ["implement"], supersedes: [], references: [] });
  expect(w.core.save(capability).decisionIds).toHaveLength(1);
});

test("没有实施授权上下文时，无候选的动作条目照旧报 action_candidate_required", async () => {
  const w = await world({ withAuthorization: false });
  await expect(w.interpret()).rejects.toMatchObject({ code: "action_candidate_required" });
});

// 上下文本身的字段不被认识（invalid_shape）不算拒绝了"带候选/正文/裁决"，要求拒绝原因是别的
async function expectContextDenied(w: World) {
  const error = await w.interpret().catch((e: unknown) => e) as { code?: string };
  expect(error).toBeInstanceOf(Error);
  expect(error.code).not.toBe("invalid_shape");
}

const BAD_CONTEXT: Array<[string, (w: World) => void]> = [
  ["清单引用的需求编号与依据不一致", (w) => { w.context.implementAuthorization!.manifest = { ...w.reference, requirementId: uuidv7() }; }],
  ["清单候选的 hash 与依据里的已批准版本不一致", (w) => { w.context.implementAuthorization!.manifest = { ...w.reference,
    candidate: { ...w.reference.candidate, to: { ...w.reference.candidate.to, hash: "f".repeat(64) } } }; }],
  ["清单候选的 commit 与依据里的已批准版本不一致", (w) => { w.context.implementAuthorization!.manifest = { ...w.reference,
    candidate: { ...w.reference.candidate, to: { ...w.reference.candidate.to, commit: "f".repeat(40) } } }; }],
];
for (const [name, mutate] of BAD_CONTEXT) test(`实施授权上下文：${name}，报 implement_context_mismatch`, async () => {
  const w = await world(); mutate(w);
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_context_mismatch" });
  expect(w.records()).toHaveLength(w.baseline);
});

test("实施授权上下文带候选时被拒", async () => {
  const w = await world();
  w.context.candidates.push({ candidateId: uuidv7(), operationId: uuidv7(), intentHash: "c".repeat(64), from: w.basis.prd, to: w.basis.prd!, diff: "+x" });
  await expectContextDenied(w);
});

test("实施授权上下文带裁决事项时被拒", async () => {
  const w = await world(); const id = uuidv7();
  w.context.adjudication = { itemId: `requirement:${id}`, version: `requirement:${id}:1`, summary: "待裁决" };
  await expectContextDenied(w);
});

test("实施授权上下文带正文时被拒", async () => {
  const w = await world();
  w.context.document = { candidate: { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "c".repeat(64), from: null, to: w.basis.prd! },
    title: "补授权", body: "# A {#A}\n手机号登录\n", partition: partitionPrdDocument(w.requirementId, "补授权", "# A {#A}\n手机号登录\n") };
  await expectContextDenied(w);
});

test("实施授权上下文下动作条目带 candidateId，报 implement_action_invalid", async () => {
  const w = await world(); w.setOutput(result([entry({ candidateId: uuidv7() })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_action_invalid" });
});

test("实施授权上下文下动作条目带 requestId，报 implement_action_invalid", async () => {
  const w = await world(); w.setOutput(result([entry({ requestId: uuidv7() })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_action_invalid" });
});

test("实施授权上下文下出现两条动作条目：只保留第一条明确实施的，另一条的结论进 notRecorded", async () => {
  const w = await world(); w.setOutput(result([entry(), entry({ conclusion: "再次开始实施" })]));
  const { interpretation, notRecorded } = await w.interpret();
  expect(interpretation.entries).toHaveLength(1);
  expect(interpretation.entries[0]!.conclusion).toBe("开始实施");
  expect(notRecorded).toEqual(["再次开始实施"]);
});

test("实施授权上下文下动作条目没有实施（只有分析），报 implement_not_explicit", async () => {
  const w = await world(); w.setOutput(result([entry({ actions: ["analyze"] })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_not_explicit" });
});

test("实施授权上下文下动作条目不是用户明确直接说的，报 implement_not_explicit", async () => {
  const w = await world(); w.setOutput(result([entry({ basis: "proposed" })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_not_explicit" });
});

test("原话同时说了提交和推送：只保存一条决定，不带推送", async () => {
  const w = await world(); w.setOutput(result([entry({ actions: ["implement", "push"] })]));
  const { interpretation, capability } = await w.interpret();
  expect(interpretation.entries).toHaveLength(1);
  expect(interpretation.entries[0]!.actions).toContain("implement");
  expect(interpretation.entries[0]!.actions).not.toContain("push");
  expect(w.core.save(capability).decisionIds).toHaveLength(1);
  expect(w.records()).toHaveLength(w.baseline + 1);
});

test("原话没有明确说实施：报 implement_not_explicit，原因和建议固定，解读模型只调用一次", async () => {
  const w = await world(); w.setOutput(result([unresolved()]));
  const error = await w.interpret("再想想").catch((e: unknown) => e) as { code: string; advice: { why: string; next: string } };
  expect(error.code).toBe("implement_not_explicit");
  expect(error.advice.why).toBe("这句话没有明确说要实施");
  expect(error.advice.next).toBe(NOT_EXPLICIT_NEXT);
  expect(w.records()).toHaveLength(w.baseline);
});

test("原话没有明确说实施：这句原话作废，同一票据再解读被拒", async () => {
  const w = await world(); w.setOutput(result([unresolved()]));
  const ticket = w.capture("再想想");
  await expect(w.core.interpret(ticket, w.requirementId)).rejects.toMatchObject({ code: "implement_not_explicit" });
  await expect(w.core.interpret(ticket, w.requirementId)).rejects.toThrow();
});

test("保存后的补授权决定：用户、已确认、凭据为本次凭据、版本为当前需求版本、引用含已批准版本的 commit 与 hash", async () => {
  const w = await world(), { capability, saved } = await authorized(w);
  const grant = w.core.authorizeImplement(capability)!;
  const record = w.core.readDecision(w.requirementId, saved.decisionIds[0]!);
  expect(record).toMatchObject({ actor: "user", status: "confirmed", basisReceiptId: grant.receiptId, requirementVersion: w.row.version });
  expect(record.references).toEqual(expect.arrayContaining([w.basis.prd!.commit, w.basis.prd!.hash]));
});

test("authorizeImplement 全部条件满足：返回凭据、版本、epoch、原话指纹和决定编号，授权回调动作名是 authorize-implement", async () => {
  const w = await world(), { capability, saved } = await authorized(w);
  const actions: string[] = []; w.setActionHook((request) => { actions.push(request.action); return true; });
  const grant = w.core.authorizeImplement(capability);
  expect(grant).toEqual({ receiptId: expect.any(String), version: w.row.version, epoch: w.row.data.epoch, inputProof: w.proof(), decisionId: saved.decisionIds[0] });
  expect(actions).toEqual(["authorize-implement"]);
});

test("authorizeImplement：宿主授权回调不放行，返回空", async () => {
  const w = await world(), { capability } = await authorized(w);
  w.setActionHook(() => false);
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

test("authorizeImplement：原话换了，返回空", async () => {
  const w = await world(), { capability } = await authorized(w);
  w.capture("换一句话");
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

test("authorizeImplement：解读模型换了，返回空", async () => {
  const w = await world(), { capability } = await authorized(w);
  w.setModel({ ...model, id: "changed" });
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

test("authorizeImplement：需求版本变了，返回空", async () => {
  const w = await world(), { capability } = await authorized(w);
  w.bumpVersion();
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

test("authorizeImplement：没有保存决定就核对，返回空", async () => {
  const w = await world(), { capability } = await w.interpret();
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

function realLoop(responses: InteractionInterpretation[]) {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "complete"> = {
    find: (provider, id) => models.getModel(provider, id), hasConfiguredAuth: () => true,
    complete: (m, context, options) => models.complete(m, context, options),
  };
  const requests: unknown[][] = [];
  const complete = registry.complete;
  const spy = vi.spyOn(registry, "complete").mockImplementation((m, context, options) => {
    requests.push(structuredClone(context.messages)); return complete(m, context, options);
  });
  faux.setResponses(responses.map((r) => fauxAssistantMessage([fauxText(JSON.stringify(r))])));
  const interpreter = createPiInteractionInterpreter({ registry, selectedModel: () => faux.getModel() });
  return { interpreter, requests, providerCalls: () => spy.mock.calls.length };
}

test("真实重答循环：首答是拿不准的实施动作条目，不重答，报 implement_not_explicit，不保存新决定", async () => {
  const loop = realLoop([result([entry({ basis: "proposed", resolution: "unclear" })]), result([entry()])]);
  const w = await world({ interpreter: loop.interpreter });
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_not_explicit" });
  expect(loop.providerCalls()).toBe(1);
  expect(w.records()).toHaveLength(w.baseline);
});

test("真实重答循环：首答只有未决条目，不重答，报 implement_not_explicit", async () => {
  const loop = realLoop([result([unresolved()]), result([entry()])]);
  const w = await world({ interpreter: loop.interpreter });
  await expect(w.interpret("再想想")).rejects.toMatchObject({ code: "implement_not_explicit" });
  expect(loop.providerCalls()).toBe(1);
  expect(w.records()).toHaveLength(w.baseline);
});

test("模型把授权实施并推送拆成实施和推送两条动作条目：登记成功，只新增1条决定，只含实施", async () => {
  const w = await world(); w.setOutput(result([entry(), entry({ actions: ["push"], conclusion: "推送", scope: "推送代码" })]));
  const { capability } = await w.interpret(), saved = w.core.save(capability);
  expect(saved.decisionIds).toHaveLength(1);
  expect(w.records()).toHaveLength(w.baseline + 1);
  expect(w.core.authorizeImplement(capability)).not.toBeNull();
});

test("实施授权上下文下动作条目带 supersedes，报 implement_action_invalid", async () => {
  const w = await world(); w.setOutput(result([entry({ supersedes: [uuidv7()] })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_action_invalid" });
});

test("实施授权上下文下动作条目带 references，报 implement_action_invalid", async () => {
  const w = await world(); w.setOutput(result([entry({ references: ["A"] })]));
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_action_invalid" });
});

test("实施授权上下文下夹带的非动作条目进入 notRecorded，不被保存", async () => {
  const w = await world(); w.setOutput(result([entry(), entry({ kind: "target", actions: [], conclusion: "顺便增加微信登录", scope: "登录" })]));
  const { interpretation, capability, notRecorded } = await w.interpret();
  expect(interpretation.entries).toHaveLength(1);
  expect(notRecorded).toEqual(["顺便增加微信登录"]);
  w.core.save(capability);
  expect(w.records()).toHaveLength(w.baseline + 1);
});

test("真实重答循环：首答是带 references 的拿不准实施动作条目，不重答，报 implement_not_explicit", async () => {
  const loop = realLoop([result([entry({ basis: "proposed", resolution: "unclear", references: ["A"] })]), result([entry()])]);
  const w = await world({ interpreter: loop.interpreter });
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_not_explicit" });
  expect(loop.providerCalls()).toBe(1);
  expect(w.records()).toHaveLength(w.baseline);
});

test("真实重答循环：首答是 kind=unresolved 但 actions 含 implement 的条目，不重答，报 implement_not_explicit", async () => {
  const loop = realLoop([result([entry({ kind: "unresolved", basis: "uncertain", resolution: "unclear" })]), result([entry()])]);
  const w = await world({ interpreter: loop.interpreter });
  await expect(w.interpret()).rejects.toMatchObject({ code: "implement_not_explicit" });
  expect(loop.providerCalls()).toBe(1);
  expect(w.records()).toHaveLength(w.baseline);
});

test("真实重答循环：明确实施但带 candidateId 被拒后重答，反馈原因里不含「明确」二字", async () => {
  const loop = realLoop([result([entry({ candidateId: uuidv7() })]), result([entry()])]);
  const w = await world({ interpreter: loop.interpreter });
  const { interpretation } = await w.interpret();
  expect(interpretation.entries).toHaveLength(1);
  expect(loop.providerCalls()).toBe(2);
  const retry = loop.requests[1]!.at(-1) as { content: string };
  const feedback = (JSON.parse(retry.content) as { feedback: string }).feedback;
  expect(feedback).toContain("implement_action_invalid");
  expect(feedback).not.toContain("明确");
});

const TAMPER: Array<[string, (w: World) => void]> = [
  ["决定被改成已取代", (w) => withDatabase(w.path, (db) => { const r = db.list("short_decisions").find((x) => (x.data as { actor?: string }).actor === "user" && x.version === 1 && (x.data as { conclusion: string }).conclusion === "开始实施")!;
    db.update("short_decisions", r.id, r.version, { ...(r.data as object), status: "superseded", supersededBy: uuidv7() }); })],
  ["决定内容被改写", (w) => withDatabase(w.path, (db) => { const r = db.list("short_decisions").find((x) => (x.data as { conclusion: string }).conclusion === "开始实施")!;
    db.update("short_decisions", r.id, r.version, { ...(r.data as object), conclusion: "改写后的结论" }); })],
  ["原话指纹变了（连续性数据多了一个待答问题）", (w) => { w.core.ask(JSON.stringify({ basis: w.basis, candidate: null,
    proposal: { conclusion: "是否同时做微信登录", scope: "登录", references: [], supersedes: [] }, actions: [] })); }],
  ["需求 epoch 变了", (w) => withDatabase(w.path, (db) => { const r = db.read<RequirementRecord>("requirements", w.requirementId)!;
    db.update("requirements", w.requirementId, r.version, { ...r.data, epoch: r.data.epoch + 1 }); })],
  ["需求 recovery 不是 ready", (w) => withDatabase(w.path, (db) => { const r = db.read<RequirementRecord>("requirements", w.requirementId)!;
    db.update("requirements", w.requirementId, r.version, { ...r.data, recovery: "needs_review", recoveryReason: "history_unknown" }); })],
];
for (const [name, tamper] of TAMPER) test(`authorizeImplement：${name}，返回空`, async () => {
  const w = await world(), { capability } = await authorized(w);
  tamper(w);
  expect(w.core.authorizeImplement(capability)).toBeNull();
});

test("authorizeImplement 过程中数据库不可用：抛出带原因的错误，不返回空", async () => {
  const w = await world(), { capability } = await authorized(w);
  w.setActionHook(() => { rmSync(w.path, { force: true }); mkdirSync(w.path); return true; });
  let thrown: unknown = "未抛出";
  try { thrown = w.core.authorizeImplement(capability); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).not.toBe("");
});

async function systemPromptOf(): Promise<string> {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "complete"> = {
    find: (provider, id) => models.getModel(provider, id), hasConfiguredAuth: () => true,
    complete: (m, context, options) => models.complete(m, context, options),
  };
  const spy = vi.spyOn(registry, "complete");
  const w = await world({ withAuthorization: false });
  faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(result([entry({ kind: "target", actions: [], conclusion: "实施手机号登录" })])))])]);
  const interpreter = createPiInteractionInterpreter({ registry, selectedModel: () => faux.getModel() });
  await interpreter.interpret({ text: IMPLEMENT, context: w.context, model: interpreter.identity(), signal: new AbortController().signal });
  return spy.mock.calls[0]![1].systemPrompt!;
}
test("解读模型提示词含实施授权段：只判断 text 是否明确要实施，明确时只输出实施动作，否则不输出动作而列未决", async () => {
  const prompt = await systemPromptOf();
  const start = prompt.indexOf("context.implementAuthorization");
  expect(start).toBeGreaterThanOrEqual(0);
  const section = prompt.slice(start).split("\n")[0]!;
  expect(section).toContain("implement");
  expect(section).toContain("kind=action");
  expect(section).toContain("unresolved");
});

test("解读模型提示词的实施授权段说明未决条目的 actions 为空", async () => {
  const prompt = await systemPromptOf();
  const section = prompt.slice(prompt.indexOf("context.implementAuthorization")).split("\n")[0]!;
  expect(section).toContain("未决条目");
  expect(section).toContain("actions为空");
});
