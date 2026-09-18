import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { repositoryIdentity } from "../runtime/identity.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../runtime/database.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { ShortDecisionStore } from "../runtime/short-decisions.ts";
import { decisionDigest } from "../runtime/short-decision-format.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";
import type { InteractionInterpreter, InteractionAuthorization } from "../runtime/user-interaction.ts";
import { candidateBinding, checkInterpretation, checkContext } from "../runtime/user-interaction-format.ts";
import type { InteractionContext, InteractionEntry, InteractionInterpretation } from "../runtime/user-interaction-format.ts";
import { createPiInteractionInterpreter } from "../runtime/user-interaction-model.ts";
import { partitionProdDocument } from "../runtime/prod-view.ts";
import { createProdDocument } from "../runtime/requirement-identity.ts";
import { create as createStoredProd } from "../runtime/prod-storage.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { testHostGitExecutable } from "./helpers/test-git-binding.ts";

const HOST_GIT = testHostGitExecutable([]);

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const PHONE = "我想加手机号登录，原来的邮箱登录保留。微信登录以后可能也要，但这次先不做。短信多久过期你参考常见做法。先帮我看看涉及哪些改动。";
const DIRECT = "增加手机号登录并保留邮箱登录，这次不做微信登录，短信有效期你来定。现在直接实施。";
const model = { provider: "controlled-fixture", id: "fixture-not-quality-evidence", configurationHash: "a".repeat(64) };
function entry(patch: Partial<InteractionEntry> = {}): InteractionEntry {
  return { kind: "target", basis: "explicit", resolution: "direct", candidateId: null, requestId: null, actions: [],
    conclusion: "增加手机号登录", scope: "保留邮箱登录，本次不做微信登录", references: [], supersedes: [], ...patch };
}
function result(entries: InteractionEntry[], referenceResolution: InteractionInterpretation["referenceResolution"] = "none"): InteractionInterpretation {
  return { format: "interaction-interpretation/v1", referenceResolution, entries };
}
// 下列解释器只返回测试逐项预先指定的结果，不解析自然语言，绝不当成真实模型质量证据。
async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "interaction-core-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const identity = await repositoryIdentity(repo.root);
  let now = 1_000_000, allowed = true;
  let authorizationHook: ((action: string) => void) | undefined;
  const actionCalls: InteractionAuthorization[] = [];
  const deniedActions = new Set<string>();
  let actionHook: ((request: InteractionAuthorization) => unknown) | undefined;
  const permittedScopes = new Map<string, Set<string>>([
    ["confirm-target", new Set(["保留邮箱登录，本次不做微信登录"])],
    ["analyze", new Set(["仅分析手机号登录，不改代码", "仅分析，不修改代码"])],
    ["implement", new Set(["只实施手机号登录，保留邮箱，不做微信"])],
  ]);
  const options = { dataRoot: join(root, "private"), repoId: identity.repoId, repositoryRoot: repo.root,
    now: () => now, authorize: (request: { action: string }) => { authorizationHook?.(request.action); return allowed; },
    authorizeAction: (request: InteractionAuthorization): boolean => {
      actionCalls.push(structuredClone(request));
      if (actionHook) return actionHook(request) as boolean;
      return allowed && !deniedActions.has(request.action) && request.repoId === identity.repoId &&
        decisionDigest(request.basis) === decisionDigest(basis) && decisionDigest(request.candidate) === decisionDigest(candidateBinding(candidate)) &&
        permittedScopes.get(request.action)?.has(request.scope) === true;
    } };
  const state = await RequirementStateStore.open(options);
  const reserved = state.reserve({ requestId: uuidv7(), intentHash: "b".repeat(64) });
  const basis = { requirementId: reserved.id, version: reserved.version, epoch: reserved.data.epoch, prod: null };
  const candidate = { candidateId: uuidv7(), operationId: uuidv7(), intentHash: "c".repeat(64), from: null,
    to: { commit: "d".repeat(40), hash: "e".repeat(64) }, diff: "+增加手机号登录；保留邮箱登录；本次不做微信登录" };
  const context: InteractionContext = { basis, currentGoal: "当前保留邮箱登录", candidates: [candidate], questions: [], priorDecisions: [] };
  let output = result([entry({ candidateId: candidate.candidateId }), entry({ kind: "action", candidateId: candidate.candidateId,
    actions: ["analyze"], conclusion: "分析涉及的改动", scope: "仅分析手机号登录，不改代码" })]);
  let implementation: InteractionInterpreter["interpret"] = async () => JSON.stringify(output);
  let selected = { ...model };
  const interpreter: InteractionInterpreter = { identity: () => selected, interpret: (input) => implementation(input) };
  const loader = vi.fn(async () => context);
  const core = await UserInteractionCore.open({ ...options, interpreter, loadContext: loader }); cleanup.push(() => core.shutdown());
  core.startSession({ sessionId: "session", windowId: "window" });
  const path = repositoryDatabase(options.dataRoot, identity.repoId);
  const capture = (text = PHONE) => core.captureInput({ source: "interactive", text }, "session");
  const interpret = async (text = PHONE) => core.interpret(capture(text), basis.requirementId);
  const binding = { basis, candidate: candidateBinding(candidate) };
  const records = () => withDatabase(path, (db) => db.list("short_decisions"));
  return { root, path, options, core, state, basis, candidate, context, binding, capture, interpret, records, loader,
    output: () => output, setOutput: (value: InteractionInterpretation) => { output = value; },
    setImplementation: (fn: InteractionInterpreter["interpret"]) => { implementation = fn; },
    setNow: (value: number) => { now = value; }, setAllowed: (value: boolean) => { allowed = value; },
    setModel: (value: typeof model) => { selected = value; },
    actionCalls, deniedActions, setActionHook: (hook: (request: InteractionAuthorization) => unknown) => { actionHook = hook; },
    setAuthorizationHook: (hook: (action: string) => void) => { authorizationHook = hook; } };
}
function phoneClassification(candidateId: string, direct = false) {
  return result([
    entry({ candidateId }),
    entry({ kind: "constraint", conclusion: "保留邮箱登录", scope: "登录功能" }),
    entry({ kind: "exclusion", conclusion: "本次不做微信登录", scope: "本轮交付范围" }),
    entry({ kind: "future", basis: "proposed", conclusion: "微信登录未来可能需要", scope: "未纳入当前执行" }),
    entry({ kind: "delegation", candidateId, conclusion: "委托代理选择短信有效期", scope: "仅短信有效期技术选择" }),
    entry({ kind: "ai-choice", basis: "delegated", candidateId, conclusion: "短信有效期选择5分钟", scope: "用户委托的短信有效期" }),
    entry({ kind: "action", candidateId, actions: [direct ? "implement" : "analyze"], conclusion: direct ? "直接实施手机号登录" : "分析改动范围",
      scope: direct ? "只实施手机号登录，保留邮箱，不做微信" : "仅分析，不修改代码" }),
  ]);
}

test("手机号原句分类固定：目标/保留/排除/未来/委托与仅分析分离，合法文字重合可保存", async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId));
  const before = w.state.read(w.basis.requirementId);
  const interpreted = await w.interpret();
  expect(interpreted.interpretation.entries.map((e) => e.kind)).toEqual(["target", "constraint", "exclusion", "future", "delegation", "ai-choice", "action"]);
  expect(w.core.authorization(interpreted.capability, w.binding, "analyze")).toBeNull();
  const saved = w.core.save(interpreted.capability);
  expect(w.core.authorization(interpreted.capability, w.binding, "analyze")).toMatchObject({ action: "analyze" });
  expect(w.core.authorization(interpreted.capability, w.binding, "implement")).toBeNull();
  expect(w.core.authorization(interpreted.capability, w.binding, "confirm-target")).not.toBeNull();
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[3]!)).toMatchObject({ actor: "user", status: "pending" });
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[5]!)).toMatchObject({ actor: "ai", status: "confirmed" });
  expect(w.state.read(w.basis.requirementId)).toEqual(before);
});
test("明确直接实施无需重复审批，但不产生关闭、提交或推送许可", async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
  const { capability } = await w.interpret(DIRECT); w.core.save(capability);
  expect(w.core.authorization(capability, w.binding, "implement")).toMatchObject({ action: "implement" });
  for (const action of ["close", "commit", "push", "plan"] as const) expect(w.core.authorization(capability, w.binding, action)).toBeNull();
});
test("新增AI业务限制保持pending并阻塞其候选，不冒充用户要求", async () => {
  const w = await world(); const output = phoneClassification(w.candidate.candidateId, true);
  output.entries.push(entry({ kind: "suggestion", candidateId: w.candidate.candidateId, basis: "proposed", conclusion: "建议每个用户仅绑定一个手机号", scope: "需要补充确认" }));
  w.setOutput(output); const { capability } = await w.interpret(); const saved = w.core.save(capability);
  expect(w.core.authorization(capability, w.binding, "implement")).toBeNull();
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds.at(-1)!)).toMatchObject({ actor: "ai", status: "pending" });
});
test("局部未决只阻塞对应候选，独立已明确候选保留动作权限", async () => {
  const w = await world(); const other = { ...w.candidate, candidateId: uuidv7(), operationId: uuidv7(), intentHash: "f".repeat(64),
    to: { commit: "a".repeat(40), hash: "b".repeat(64) } };
  w.context.candidates.push(other);
  const output = w.output(); output.entries.push(entry({ kind: "unresolved", basis: "uncertain", candidateId: other.candidateId, conclusion: "另一个功能前提未知", scope: "仅该功能", resolution: "unclear" }));
  const { capability } = await w.interpret(); w.core.save(capability);
  expect(w.core.authorization(capability, w.binding, "analyze")).not.toBeNull();
  expect(w.core.authorization(capability, { basis: w.basis, candidate: candidateBinding(other) }, "analyze")).toBeNull();
});
async function question(w: Awaited<ReturnType<typeof world>>) {
  const q = w.core.ask(JSON.stringify({ basis: w.basis, candidate: candidateBinding(w.candidate),
    proposal: { conclusion: "增加手机号登录", scope: "仅分析", references: [], supersedes: [] }, actions: ["analyze"] }));
  w.context.questions.push(q); return q;
}
test("单请求短答关联实际请求，多个请求的可以不擅自选一个", async () => {
  const w = await world(), q = await question(w);
  w.setOutput(result(w.output().entries.map((e) => ({ ...e, requestId: q.requestId, resolution: "accept" })), "single-question"));
  const first = await w.interpret("可以"); const saved = w.core.save(first.capability);
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[0]!).references).toContain(q.requestId);
  await question(w);
  await expect(w.interpret("可以")).rejects.toThrow(/interpretation_denied/);
  w.setOutput(result([entry({ kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "请明确确认哪一个请求", scope: "两个请求均未确认" })], "ambiguous"));
  const ambiguous = await w.interpret("可以"); w.core.save(ambiguous.capability);
  expect(w.core.authorization(ambiguous.capability, w.binding, "analyze")).toBeNull();
});
test("长答部分接受/修改/暂缓保存真实分类，修改不能批准原候选hash，修订保留supersedes", async () => {
  const w = await world(); const first = await w.interpret(); const original = w.core.save(first.capability);
  w.context.priorDecisions = [w.core.readDecision(w.basis.requirementId, original.decisionIds[0]!)];
  const q = await question(w);
  w.setOutput(result([
    entry({ candidateId: w.candidate.candidateId, requestId: q.requestId, resolution: "modify", conclusion: "手机号登录仅开放给内测用户", supersedes: [original.decisionIds[0]!] }),
    entry({ kind: "constraint", candidateId: w.candidate.candidateId, requestId: q.requestId, resolution: "accept", conclusion: "保留邮箱登录" }),
    entry({ kind: "future", basis: "proposed", resolution: "defer", conclusion: "其他登录方式暂缓" }),
  ], "explicit"));
  const revised = await w.interpret("保留邮箱这项可以。手机号只给内测用户，其他先缓缓。"); const saved = w.core.save(revised.capability);
  expect(w.core.authorization(revised.capability, w.binding, "confirm-target")).toBeNull();
  expect(w.core.readDecision(w.basis.requirementId, original.decisionIds[0]!)).toMatchObject({ status: "superseded", supersededBy: saved.decisionIds[0] });
});
for (const source of ["extension", "tool", "user", "model", "rpc-untrusted"]) test(`来源${source}不能产生输入能力`, async () => {
  const w = await world(); expect(() => w.core.captureInput({ source, text: "实施" }, "session")).toThrow(); expect(w.records()).toEqual([]);
});
for (const field of ["actor", "role", "receiptId", "rawContent"]) test(`输入伪${field}以及JSON票据拒绝`, async () => {
  const w = await world();
  expect(() => w.core.captureInput({ source: "interactive", text: "实施", [field]: "user" }, "session")).toThrow();
  const ticket = w.capture(); await expect(w.core.interpret(JSON.parse(JSON.stringify(ticket)), w.basis.requirementId)).rejects.toThrow(/invalid_input_ticket/);
});
test("可信RPC可用，但宿主会话绑定不同、相同事件重入、已消费票据拒绝", async () => {
  const w = await world(); const event = { source: "rpc", text: PHONE };
  expect(() => w.core.captureInput(event, "foreign-session")).toThrow(/untrusted_session/);
  const ticket = w.core.captureInput(event, "session"); await w.core.interpret(ticket, w.basis.requirementId);
  await expect(w.core.interpret(ticket, w.basis.requirementId)).rejects.toThrow(/invalid_input_ticket/);
  expect(() => w.core.captureInput(event, "session")).toThrow(/input_reentry/);
});
test("JSON能力、旧hash/epoch/版本、跨需求和篡改前后引用拒绝授权", async () => {
  const w = await world(); const { capability } = await w.interpret(); w.core.save(capability);
  expect(() => w.core.save(JSON.parse(JSON.stringify(capability)))).toThrow(/invalid_capability/);
  const variants = [
    { ...w.binding, basis: { ...w.basis, requirementId: uuidv7() } },
    { ...w.binding, basis: { ...w.basis, epoch: 2 } }, { ...w.binding, basis: { ...w.basis, version: 2 } },
    { ...w.binding, candidate: { ...w.binding.candidate, intentHash: "0".repeat(64) } },
    { ...w.binding, candidate: { ...w.binding.candidate, to: { ...w.candidate.to, hash: "0".repeat(64) } } },
    { ...w.binding, candidate: { ...w.binding.candidate, from: w.candidate.to } },
  ];
  for (const binding of variants) expect(w.core.authorization(capability, binding, "analyze")).toBeNull();
});
test("存在短决定和工具自填结论都不能直接得到admit；修改返回视图不改变内部批次", async () => {
  const w = await world(); const interpreted = await w.interpret(); interpreted.interpretation.entries[0]!.conclusion = "伪造推送批准";
  const saved = w.core.save(interpreted.capability);
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[0]!).conclusion).toBe("增加手机号登录");
  const store = await ShortDecisionStore.open(w.options);
  expect(() => store.append(JSON.stringify({ ...w.basis, operationId: uuidv7(), decisions: [{ conclusion: "推送", scope: "全部", references: [], supersedes: [] }] }))).toThrow(/trusted_admission_required/);
});
for (const revoke of ["clear", "shutdown", "switch", "expiry", "closing", "model", "permission"] as const) test(`${revoke}后旧能力不可用，closing不加载正文`, async () => {
  const w = await world(); const { capability } = await w.interpret(); w.core.save(capability);
  if (revoke === "clear") w.core.revoke();
  if (revoke === "shutdown") w.core.shutdown();
  if (revoke === "switch") w.core.startSession({ sessionId: "new-session", windowId: "window" });
  if (revoke === "expiry") w.setNow(1_900_000);
  if (revoke === "model") w.setModel({ ...model, id: "changed" });
  if (revoke === "permission") w.setAllowed(false);
  if (revoke === "closing") {
    w.state.beginClose({ requirementId: w.basis.requirementId, version: w.basis.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    w.loader.mockClear(); await expect(w.interpret()).rejects.toThrow(); expect(w.loader).not.toHaveBeenCalled();
  }
  expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull();
});
for (const race of ["input", "session", "closing", "version", "revoke", "model"]) test(`异步解释期间${race}变化，迟到结果不保存或签发能力`, async () => {
  const w = await world(); let settle!: (value: string) => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  w.setImplementation(async () => { entered(); return new Promise<string>((resolve) => { settle = resolve; }); });
  const pending = w.interpret(); await ready;
  if (race === "input") w.capture("新的分析请求");
  if (race === "session") w.core.startSession({ sessionId: "new", windowId: "new" });
  if (race === "revoke") w.core.revoke();
  if (race === "model") w.setModel({ ...model, configurationHash: "b".repeat(64) });
  if (race === "version") w.state.recordSavedVersion({ requirementId: w.basis.requirementId, version: w.basis.version, operationId: uuidv7(), reference: w.candidate.to });
  if (race === "closing") w.state.beginClose({ requirementId: w.basis.requirementId, version: w.basis.version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
  settle(JSON.stringify(w.output())); await expect(pending).rejects.toThrow(/interpretation_denied/); expect(w.records()).toEqual([]);
});
test("解释异常不回显原话/模型错误，后续新输入可正常解释", async () => {
  const w = await world(); w.setImplementation(async () => { throw new Error(PHONE); });
  await expect(w.interpret()).rejects.toThrow(/^用户交互被拒绝：interpretation_denied$/);
  w.setImplementation(async () => JSON.stringify(w.output())); expect((await w.interpret()).capability.kind).toBe("interaction-capability");
});
test("真实SQLite只保存短结论与问题，无原话表/文件；清空会话后合法决定仍可读", async () => {
  const w = await world();
  const tables = () => { const db = new DatabaseSync(w.path, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(); } finally { db.close(); } };
  const beforeTables = tables();
  await question(w); const { capability } = await w.interpret(); const saved = w.core.save(capability); w.core.shutdown();
  expect(tables()).toEqual(beforeTables);
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[0]!).conclusion).toBe("增加手机号登录");
  const rows = withDatabase(w.path, (db) => [...db.list("short_decisions"), ...db.list("interaction_questions_v1"), ...db.list("short_decision_operations")]);
  expect(JSON.stringify(rows)).not.toContain(PHONE); expect(JSON.stringify(rows)).not.toMatch(/transcript|rawContent|prodBody|attachment/);
  const names = await readdir(dirname(w.path)); expect(names.every((name) => ["data.db", "data.db-wal", "data.db-shm"].includes(name))).toBe(true);
  expect((await stat(w.path)).mode & 0o777).toBe(0o600);
  expect((await readFile(w.path)).includes(Buffer.from(PHONE))).toBe(false);
});
for (const field of ["conclusion", "scope"] as const) test(`真实SQLite ${field}400码点可保存，401拒绝且不截断`, async () => {
  const w = await world(); w.output().entries[0]![field] = "😀".repeat(400);
  const { capability } = await w.interpret(); w.core.save(capability); expect(w.records()).toHaveLength(2);
  w.output().entries[0]![field] += "中"; await expect(w.interpret()).rejects.toThrow(); expect(w.records()).toHaveLength(2);
});
test("固定schema拒绝未知字段、正文/patch/附件、重复键、超20批与引用超16", async () => {
  const w = await world();
  for (const field of ["actor", "role", "prodBody", "patch", "attachment", "rawContent", "transcript"]) {
    expect(() => checkInterpretation(JSON.stringify({ ...w.output(), [field]: "hidden" }), w.context)).toThrow();
    expect(() => w.core.ask(JSON.stringify({ basis: w.basis, candidate: null, proposal: { conclusion: "短决定", scope: "范围", references: [], supersedes: [], [field]: "hidden" }, actions: [] }))).toThrow();
  }
  expect(() => checkInterpretation(JSON.stringify(w.output()).replace('"entries":', '"format":"x","entries":'), w.context)).toThrow(/duplicate_key/);
  w.setOutput(result(Array.from({ length: 21 }, () => entry()))); await expect(w.interpret()).rejects.toThrow();
  w.setOutput(result([entry({ candidateId: w.candidate.candidateId, references: Array.from({ length: 13 }, (_, i) => `R-${i}`) })]));
  await expect(w.interpret()).rejects.toThrow(); expect(w.records()).toEqual([]);
});
test("64KiB限制包含当前输入和解释上下文，超限不调用解释器", async () => {
  const w = await world(), spy = vi.fn(async () => JSON.stringify(w.output())); w.setImplementation(spy);
  expect(() => w.capture("中".repeat(30_000))).toThrow(/request_limit/);
  await expect(w.interpret("a".repeat(65_000))).rejects.toThrow(); expect(spy).not.toHaveBeenCalled();
  const source = JSON.stringify(w.output()); expect(checkInterpretation(source + " ".repeat(65_536 - Buffer.byteLength(source)), w.context)).toEqual(w.output());
  expect(() => checkInterpretation(source + " ".repeat(65_537 - Buffer.byteLength(source)), w.context)).toThrow(/request_limit/);
});
test("虚构问题、旧基线、伪造委托与引用旧自填记录不升级为用户授权", async () => {
  const w = await world();
  w.setOutput(result([entry({ requestId: uuidv7(), resolution: "accept" })])); await expect(w.interpret()).rejects.toThrow();
  w.setOutput(result([entry({ kind: "ai-choice", basis: "delegated" })])); await expect(w.interpret()).rejects.toThrow();
  w.setOutput(result([entry({ supersedes: [uuidv7()] })])); await expect(w.interpret()).rejects.toThrow();
  const q = await question(w); q.basis = { ...q.basis, epoch: 2 }; expect(() => checkContext(w.context)).toThrow(/question_baseline_mismatch/);
});

test("短决定事务末尾的宿主撤权使整个写入回滚，不能在最后一次权限回调后漏检", async () => {
  const w = await world(); const { capability } = await w.interpret(); let records = 0;
  w.setAuthorizationHook((action) => { if (action === "record-decisions" && ++records === 3) w.core.revoke(); });
  expect(() => w.core.save(capability)).toThrow(); expect(w.records()).toEqual([]);
  expect(withDatabase(w.path, (db) => db.events(`short_decision_events:${w.basis.requirementId}`))).toEqual([]);
});

test("候选ID、hash和提交引用不接受尾部换行或隐藏载荷", async () => {
  const w = await world();
  for (const field of ["candidateId", "operationId", "intentHash"] as const) {
    expect(() => checkContext({ ...w.context, candidates: [{ ...w.candidate, [field]: w.candidate[field] + "\n" }] })).toThrow();
  }
  expect(() => checkContext({ ...w.context, candidates: [{ ...w.candidate, to: { ...w.candidate.to, commit: w.candidate.to.commit + "\n" } }] })).toThrow();
});

test("20条及16引用的合法边界写入真实SQLite，保存幂等，新增输入不能继续用旧能力", async () => {
  const w = await world();
  w.setOutput(result(Array.from({ length: 20 }, () => entry({ references: Array.from({ length: 16 }, (_, i) => `R-${i}`) }))));
  const { capability } = await w.interpret(); const saved = w.core.save(capability);
  expect(saved.decisionIds).toHaveLength(20); expect(w.core.save(capability)).toEqual(saved); expect(w.records()).toHaveLength(20);
  w.capture("新的需求"); expect(() => w.core.save(capability)).toThrow(/invalid_capability/);
});
test("短答不能把仅分析问题扩大为实施；不存在候选时只能保存目标，不能取得任意动作", async () => {
  const w = await world(); const q = await question(w);
  w.setOutput(result([entry({ kind: "action", candidateId: w.candidate.candidateId, requestId: q.requestId, resolution: "accept", actions: ["implement"] })], "single-question"));
  await expect(w.interpret("可以")).rejects.toThrow();
  w.setOutput(result([entry()])); const { capability } = await w.interpret("我想增加手机号登录"); w.core.save(capability);
  expect(w.core.authorization(capability, w.binding, "implement")).toBeNull();
});
test("迟到旧模型结果不会清掉后来的真实输入票据", async () => {
  const w = await world(); let settle!: (value: string) => void, ready!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  w.setImplementation(async () => { ready(); return new Promise<string>((resolve) => { settle = resolve; }); });
  const first = w.interpret(); await entered; const newTicket = w.capture("新的请求");
  settle(JSON.stringify(w.output())); await expect(first).rejects.toThrow();
  w.setImplementation(async () => JSON.stringify(w.output()));
  expect((await w.core.interpret(newTicket, w.basis.requirementId)).capability.kind).toBe("interaction-capability");
});
test("未决问题的陌生需求和旧版本无法从SQLite读出或重放", async () => {
  const w = await world(); const q = await question(w);
  expect(() => w.core.readQuestion(q.requestId, { ...w.basis, version: 2 })).toThrow();
  w.core.startSession({ sessionId: "session", windowId: "window" });
  const other = w.state.reserve({ requestId: uuidv7(), intentHash: "f".repeat(64) });
  expect(() => w.core.readQuestion(q.requestId, { ...w.basis, requirementId: other.id })).toThrow(/question_identity_mismatch/);
});

for (const [kind, basis] of [["future", "proposed"], ["constraint", "proposed"], ["constraint", "uncertain"]] as const) {
  test(`F1 同候选${kind}/${basis}/direct未生效内容拒绝完整hash`, async () => {
    const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
    w.output().entries.push(entry({ kind, basis, candidateId: w.candidate.candidateId, conclusion: "微信仍未确认", scope: "当前候选中的未确认内容" }));
    const { capability } = await w.interpret("手机号现在实施，微信还没确认。"); const saved = w.core.save(capability);
    expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds.at(-1)!)).toMatchObject({ status: "pending" });
    expect(w.core.authorization(capability, w.binding, "implement")).toBeNull();
    expect(w.core.authorization(capability, w.binding, "confirm-target")).toBeNull();
  });
}
test("F1 没有关联的未知约束不是已判断无关；原手机号future(null)仍为未来讨论", async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
  let parsed = await w.interpret(DIRECT); w.core.save(parsed.capability);
  expect(w.core.authorization(parsed.capability, w.binding, "implement")).not.toBeNull();
  w.output().entries.push(entry({ kind: "constraint", basis: "uncertain", candidateId: null, conclusion: "用户范围未知", scope: "影响尚未明确" }));
  parsed = await w.interpret(DIRECT); w.core.save(parsed.capability);
  expect(w.core.authorization(parsed.capability, w.binding, "implement")).toBeNull();
});
for (const kind of ["target", "action", "constraint"] as const) test(`F2 合法双core修订${kind}，原能力失效且不重新批准新记录`, async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
  const first = await w.interpret(DIRECT); const saved = w.core.save(first.capability);
  expect(w.core.authorization(first.capability, w.binding, "implement")).not.toBeNull();
  const index = w.output().entries.findIndex((e) => e.kind === kind);
  const old = w.core.readDecision(w.basis.requirementId, saved.decisionIds[index]!);
  const before = w.state.read(w.basis.requirementId);
  const revisedOutput = result([entry({ kind: kind === "action" ? "action" : kind, candidateId: w.candidate.candidateId,
    actions: kind === "action" ? ["analyze"] : [], conclusion: "修订刚才的决定，当前仅分析", scope: "不再允许实施代码", supersedes: [old.decisionId] })]);
  const second = await UserInteractionCore.open({ ...w.options, loadContext: async () => ({ ...w.context, priorDecisions: [old] }),
    interpreter: { identity: () => model, interpret: async () => JSON.stringify(revisedOutput) } });
  cleanup.push(() => second.shutdown()); second.startSession({ sessionId: "B", windowId: "B" });
  const next = await second.interpret(second.captureInput({ source: "interactive", text: "取消刚才的实施许可，当前只分析，并修订对应目标或约束。" }, "B"), w.basis.requirementId);
  const revised = second.save(next.capability);
  expect(w.core.readDecision(w.basis.requirementId, old.decisionId)).toMatchObject({ status: "superseded", supersededBy: revised.decisionIds[0] });
  expect(w.state.read(w.basis.requirementId)).toEqual(before);
  expect(w.core.authorization(first.capability, w.binding, "implement")).toBeNull();
  expect(second.authorization(next.capability, w.binding, "implement")).toBeNull();
});
test("F2 另一合法core仅修订独立候选不重置当前候选", async () => {
  const w = await world(); const other = { ...w.candidate, candidateId: uuidv7(), operationId: uuidv7(), intentHash: "f".repeat(64),
    to: { commit: "a".repeat(40), hash: "b".repeat(64) } };
  w.context.candidates.push(other); w.output().entries.push(entry({ candidateId: other.candidateId, conclusion: "独立候选目标" }));
  const first = await w.interpret(); const saved = w.core.save(first.capability);
  const old = w.core.readDecision(w.basis.requirementId, saved.decisionIds[2]!);
  const second = await UserInteractionCore.open({ ...w.options, loadContext: async () => ({ ...w.context, priorDecisions: [old] }),
    interpreter: { identity: () => model, interpret: async () => JSON.stringify(result([entry({ candidateId: other.candidateId,
      resolution: "modify", conclusion: "修订另一个独立候选", supersedes: [old.decisionId] })])) } });
  cleanup.push(() => second.shutdown()); second.startSession({ sessionId: "B", windowId: "B" });
  const next = await second.interpret(second.captureInput({ source: "interactive", text: "只修改另一个独立候选" }, "B"), w.basis.requirementId);
  second.save(next.capability);
  expect(w.core.readDecision(w.basis.requirementId, old.decisionId).status).toBe("superseded");
  expect(w.core.authorization(first.capability, w.binding, "analyze")).not.toBeNull();
});
for (const field of ["conclusion", "scope", "operationId", "requirementVersion", "basisReceiptId", "actor", "prod", "recordedAt", "missing"] as const) {
  test(`F2 实际保存记录${field}改变拒绝旧能力（独立临时库完整性故障）`, async () => {
    const w = await world(); const { capability } = await w.interpret(); const saved = w.core.save(capability);
    withDatabase(w.path, (db) => {
      const old = db.read("short_decisions", saved.decisionIds[1]!)!;
      if (field === "missing") db.remove("short_decisions", old.id, old.version);
      else {
        const changed = { conclusion: "不同结论", scope: "不同范围", operationId: uuidv7(), requirementVersion: 2,
          basisReceiptId: uuidv7(), actor: "ai", prod: w.candidate.to, recordedAt: 1_000_001 };
        db.update("short_decisions", old.id, old.version, { ...old.data as object, [field]: changed[field] });
      }
    });
    expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull();
  });
}
for (const name of ["user-interaction-format", "user-interaction", "user-interaction-model", "approval-manifest"]) test(`F3 当前Node原生strip-types导入${name}`, () => {
  const url = new URL(`../runtime/${name}.ts`, import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_OPTIONS: "" } });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status, child.stderr).toBe(0);
});
test("F4 保留状态/决定read但单独撤销implement，逐次动作回调拒绝", async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
  const { capability } = await w.interpret(DIRECT); const saved = w.core.save(capability);
  expect(w.core.authorization(capability, w.binding, "implement")).not.toBeNull();
  w.deniedActions.add("implement");
  expect(w.state.read(w.basis.requirementId)).toBeDefined();
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[0]!).status).toBe("confirmed");
  expect(w.core.authorization(capability, w.binding, "implement")).toBeNull();
  expect(w.core.authorization(capability, w.binding, "confirm-target")).not.toBeNull();
  expect(w.actionCalls.filter((r) => r.action === "implement")).toHaveLength(2);
});
test("F4 回调收到冻结的完整身份/候选/动作/receipt与scope，不匹配scope拒绝", async () => {
  const w = await world(); const { capability } = await w.interpret(); const saved = w.core.save(capability);
  const receiptId = w.core.readDecision(w.basis.requirementId, saved.decisionIds[1]!).basisReceiptId;
  w.setActionHook((r) => {
    expect(r).toEqual({ repoId: w.options.repoId, ...w.binding, action: "analyze", receiptId, scope: "仅分析手机号登录，不改代码" });
    expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.candidate.to)).toBe(true);
    return r.scope === "只有另一个范围获得许可";
  });
  expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull();
});
for (const change of ["revoke", "shutdown", "state", "record", "recursive"] as const) test(`F4 动作回调重入${change}不能放行`, async () => {
  const w = await world(); const { capability } = await w.interpret(); const saved = w.core.save(capability);
  w.setActionHook(() => {
    if (change === "revoke") w.core.revoke();
    if (change === "shutdown") w.core.shutdown();
    if (change === "state") w.state.recordSavedVersion({ requirementId: w.basis.requirementId, version: w.basis.version,
      operationId: uuidv7(), reference: w.candidate.to });
    if (change === "record") withDatabase(w.path, (db) => {
      const old = db.read("short_decisions", saved.decisionIds[0]!)!;
      db.update("short_decisions", old.id, old.version, { ...old.data as object, conclusion: "回调期间内容变化" });
    });
    if (change === "recursive") { expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull(); w.core.revoke(); }
    return true;
  });
  expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull();
});
test("F4 最后一个状态read回调改变保存记录，最终无回调快照仍拒绝", async () => {
  const w = await world(); const { capability } = await w.interpret(); const saved = w.core.save(capability);
  let decisionsRead = 0, stateRead = 0, mutated = false;
  w.setAuthorizationHook((action) => {
    if (action === "read-decisions") decisionsRead++;
    // 两条决定均完成read-decisions的前后核验后，最后一次state.read的返回前回调才修改。
    if (decisionsRead === 4 && action === "read" && ++stateRead === 2) withDatabase(w.path, (db) => {
      const old = db.read("short_decisions", saved.decisionIds[0]!)!;
      db.update("short_decisions", old.id, old.version, { ...old.data as object, conclusion: "晚于动作回调的变化" });
      mutated = true;
    });
  });
  expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull(); expect(mutated).toBe(true);
});
test("F4 动作回调中另一合法core保存撤权修订，旧能力不能返回授权", async () => {
  const w = await world(); w.setOutput(phoneClassification(w.candidate.candidateId, true));
  const first = await w.interpret(DIRECT); const original = w.core.save(first.capability);
  const old = w.core.readDecision(w.basis.requirementId, original.decisionIds.at(-1)!);
  const second = await UserInteractionCore.open({ ...w.options, loadContext: async () => ({ ...w.context, priorDecisions: [old] }),
    interpreter: { identity: () => model, interpret: async () => JSON.stringify(result([entry({ kind: "action", candidateId: w.candidate.candidateId,
      actions: ["analyze"], conclusion: "撤销实施，只允许分析", scope: "不允许实施", supersedes: [old.decisionId] })])) } });
  cleanup.push(() => second.shutdown()); second.startSession({ sessionId: "B", windowId: "B" });
  const next = await second.interpret(second.captureInput({ source: "interactive", text: "取消实施许可，只分析" }, "B"), w.basis.requirementId);
  w.setActionHook(() => { second.save(next.capability); return true; });
  expect(w.core.authorization(first.capability, w.binding, "implement")).toBeNull();
  expect(w.core.readDecision(w.basis.requirementId, old.decisionId).status).toBe("superseded");
});
for (const mode of ["promise-resolve", "promise-reject", "thenable-resolve", "thenable-reject"] as const) test(`F4 ${mode}不授权且迟到reject被收尾`, async () => {
  const w = await world(); const { capability } = await w.interpret(); w.core.save(capability);
  let finish!: () => void, completed = false;
  if (mode.startsWith("promise")) {
    const pending = new Promise<boolean>((resolve, reject) => { finish = () => { completed = true; mode.endsWith("reject") ? reject(new Error("late")) : resolve(true); }; });
    w.setActionHook(() => pending);
  } else {
    w.setActionHook(() => ({ then: (resolve: (v: boolean) => void, reject: (e: Error) => void) => {
      finish = () => { completed = true; mode.endsWith("reject") ? reject(new Error("late")) : resolve(true); };
    } }));
  }
  expect(w.core.authorization(capability, w.binding, "analyze")).toBeNull();
  await Promise.resolve(); finish(); await new Promise((resolve) => setImmediate(resolve)); expect(completed).toBe(true);
});
test("F4 未接入authorizeAction的运行时调用默认拒绝，不用恒真默认", async () => {
  const w = await world(); const { authorizeAction: _omitted, ...withoutAction } = w.options;
  // 编译时缺失必需回调也应报错；运行时来自未类型化接线仍须默认拒绝。
  // @ts-expect-error authorizeAction is required
  const core = await UserInteractionCore.open({ ...withoutAction, loadContext: async () => w.context,
    interpreter: { identity: () => model, interpret: async () => JSON.stringify(w.output()) } });
  cleanup.push(() => core.shutdown()); core.startSession({ sessionId: "B", windowId: "B" });
  const { capability } = await core.interpret(core.captureInput({ source: "interactive", text: PHONE }, "B"), w.basis.requirementId);
  core.save(capability); expect(core.authorization(capability, w.binding, "analyze")).toBeNull();
});

async function documentWorld() {
  const w = await world(); w.setActionHook(() => true);
  const title = "渐进登录", body = "前言：保留邮箱。\r\n# 手机号 {#A}\r\n实施手机号。😀\r\n# 微信 {#B}\r\n未决，不实施。\r\n";
  const partition = partitionProdDocument(w.basis.requirementId, title, body);
  w.candidate.to.hash = partition.prodHash;
  const saved = w.state.recordSavedVersion({ requirementId: w.basis.requirementId, version: w.basis.version, operationId: w.candidate.operationId, reference: w.candidate.to });
  Object.assign(w.basis, { version: saved.version, prod: saved.data.saved }); Object.assign(w.candidate, { from: saved.data.saved });
  w.context.document = { candidate: candidateBinding(w.candidate), title, body, partition };
  w.setOutput(result([
    entry({ candidateId: w.candidate.candidateId }),
    entry({ candidateId: w.candidate.candidateId, kind: "constraint", conclusion: "保留邮箱" }),
    entry({ candidateId: w.candidate.candidateId, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "微信未决" }),
    entry({ candidateId: w.candidate.candidateId, kind: "action", actions: ["implement"], conclusion: "实施手机号" }),
  ]));
  w.output().documentReview = { faithful: true,
    units: partition.units.map((u) => ({ id: u.id, disposition: u.id === "B" ? "pending-description" : "confirmed", globalConstraint: false,
      appliesTo: [], dependsOn: u.id === "A" ? ["preamble"] : [], conclusionIndexes: [u.id === "B" ? 2 : u.id === "preamble" ? 1 : 0] })),
    actions: [{ action: "implement", goalIds: ["A"], constraintIds: ["preamble"], conclusionIndexes: [3], unknown: false }], questions: [] };
  const binding = () => ({ basis: w.basis, candidate: candidateBinding(w.candidate) });
  const scope = { action: "implement" as const, goalIds: ["A"], constraintIds: ["preamble"] };
  const resave = () => {
    const document = w.context.document!; document.body += "补充仍不改变已确认范围。\n";
    document.partition = partitionProdDocument(w.basis.requirementId, title, document.body);
    w.candidate.to = { commit: (Number.parseInt(w.candidate.to.commit[0]!, 16) + 1).toString(16).slice(-1).repeat(40), hash: document.partition.prodHash };
    w.candidate.operationId = uuidv7(); w.candidate.candidateId = uuidv7(); w.candidate.intentHash = decisionDigest(w.candidate.to);
    const saved = w.state.recordSavedVersion({ requirementId: w.basis.requirementId, version: w.basis.version, operationId: w.candidate.operationId, reference: w.candidate.to });
    Object.assign(w.basis, { version: saved.version, prod: saved.data.saved }); Object.assign(w.candidate, { from: saved.data.saved });
    document.candidate = candidateBinding(w.candidate);
    for (const e of w.output().entries) e.candidateId = w.candidate.candidateId;
  };
  return { ...w, binding, scope, resave };
}
test("范围入口真实SQLite保存A确认+B未决，整份可阅读但仅A动作，旧全候选不能兑换", async () => {
  const w = await documentWorld(), { capability } = await w.interpret("手机号实施，微信还没确定，文档写清楚未决。");
  expect(w.core.authorizeDocument(capability, w.binding())).toBeNull();
  const saved = w.core.save(capability), doc = w.core.authorizeDocument(capability, w.binding())!;
  expect(doc.authorization.action).toBe("authorize-document");
  expect(doc.manifest.units.find((u) => u.id === "B")!.decisionIds).toEqual([saved.decisionIds[2]]);
  expect(w.core.readDecision(w.basis.requirementId, saved.decisionIds[2]!).status).toBe("pending");
  expect(w.core.authorizeScope(capability, w.binding(), w.scope)).toMatchObject({ action: "implement", goalIds: ["A"], constraintIds: ["preamble"] });
  expect(w.core.authorizeScope(capability, w.binding(), { ...w.scope, goalIds: ["B"] })).toBeNull();
  expect(w.core.authorizeScope(capability, w.binding(), { ...w.scope, goalIds: ["A", "B"] })).toBeNull();
  expect(w.core.authorization(capability, w.binding(), "implement")).toBeNull();
  expect(w.core.authorization(capability, w.binding(), "confirm-target")).toBeNull();
  doc.manifest.units[3]!.disposition = "confirmed";
  expect(w.core.authorizeDocument(capability, w.binding())!.manifest.units[3]!.disposition).toBe("pending-description");
  expect(JSON.stringify(w.records())).not.toContain(w.context.document!.body);
});
for (const attack of ["not-saved", "overlap", "hash", "omission", "same-hash-candidates", "missing-review", "modify", "stale-decision"] as const) test(`范围审核${attack}拒绝`, async () => {
  const w = await documentWorld();
  if (attack === "not-saved") { w.candidate.to.commit = "1".repeat(40); w.context.document!.candidate = candidateBinding(w.candidate); }
  if (attack === "overlap") w.context.document!.partition.units[1]!.startByte--;
  if (attack === "hash") w.context.document!.partition.units[1]!.hash = "1".repeat(64);
  if (attack === "omission") w.output().documentReview!.units.shift();
  if (attack === "same-hash-candidates") w.context.candidates.push({ ...w.candidate, candidateId: uuidv7() });
  if (attack === "missing-review") delete w.output().documentReview;
  if (attack === "modify") w.output().entries[0]!.resolution = "modify";
  if (attack === "stale-decision") w.output().entries[0]!.supersedes = [uuidv7()];
  await expect(w.interpret()).rejects.toThrow(/interpretation_denied/); expect(w.records()).toEqual([]);
});
test("范围动作包含全局未决依赖则拒绝，但全局条件明确不作用于A时A保留", async () => {
  const w = await documentWorld(), review = w.output().documentReview!;
  review.units[3]!.globalConstraint = true; review.units[3]!.appliesTo = ["A"]; review.actions[0]!.constraintIds.push("B");
  let parsed = await w.interpret(); w.core.save(parsed.capability);
  expect(w.core.authorizeDocument(parsed.capability, w.binding())).not.toBeNull();
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { ...w.scope, constraintIds: ["preamble", "B"] })).toBeNull();
  review.units[3]!.appliesTo = ["metadata"]; review.actions[0]!.constraintIds = ["preamble"];
  parsed = await w.interpret(); w.core.save(parsed.capability);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), w.scope)).not.toBeNull();
});
for (const kind of ["target", "constraint", "action"] as const) test(`范围F2 双core真实修订${kind}使原文档与范围能力失效`, async () => {
  const w = await documentWorld(), first = await w.interpret(), saved = w.core.save(first.capability);
  const index = w.output().entries.findIndex((e) => e.kind === kind), old = w.core.readDecision(w.basis.requirementId, saved.decisionIds[index]!);
  const revised = result([entry({ candidateId: w.candidate.candidateId, kind, actions: kind === "action" ? ["analyze"] : [], supersedes: [old.decisionId], conclusion: "修订对应决定，撤销原实施" })]);
  const { document: _document, ...context } = w.context;
  const core = await UserInteractionCore.open({ ...w.options, loadContext: async () => ({ ...context, priorDecisions: [old] }),
    interpreter: { identity: () => model, interpret: async () => JSON.stringify(revised) } });
  cleanup.push(() => core.shutdown()); core.startSession({ sessionId: "B", windowId: "B" });
  const next = await core.interpret(core.captureInput({ source: "interactive", text: "修订刚才该决定，停止实施" }, "B"), w.basis.requirementId); core.save(next.capability);
  expect(w.core.authorizeDocument(first.capability, w.binding())).toBeNull(); expect(w.core.authorizeScope(first.capability, w.binding(), w.scope)).toBeNull();
});
for (const change of ["revoke", "record", "state", "async", "scope-denied", "document-denied"] as const) test(`范围F4逐次动作回调${change}拒绝`, async () => {
  const w = await documentWorld(), { capability } = await w.interpret(), saved = w.core.save(capability);
  w.setActionHook((r) => {
    expect(Object.isFrozen(r.manifest)).toBe(true);
    if (change === "revoke") w.core.revoke();
    if (change === "record") withDatabase(w.path, (db) => { const record = db.read("short_decisions", saved.decisionIds[0]!)!; db.update("short_decisions", record.id, record.version, { ...record.data as object, conclusion: "changed" }); });
    if (change === "state") w.resave();
    if (change === "async") return Promise.reject(new Error("late"));
    if (change === "scope-denied") return r.action !== "implement";
    if (change === "document-denied") return r.action !== "authorize-document";
    return true;
  });
  expect(w.core.authorizeScope(capability, w.binding(), w.scope)).toBeNull(); await new Promise((resolve) => setImmediate(resolve));
});
test("没有受控permit的外部重存不能重解释，也不能用JSON伪造permit", async () => {
  const w = await documentWorld(), ticket = w.capture("A直接实施，B未决写清楚。");
  const previous = await w.core.interpret(ticket, w.basis.requirementId); w.core.save(previous.capability);
  await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow(/reconsideration_denied/);
  const texts: string[] = []; w.setImplementation(async (input) => { texts.push(input.text); return JSON.stringify(w.output()); });
  for (let i = 0; i < 3; i++) {
    w.resave(); await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId, { kind: "candidate-resave-permit" })).rejects.toThrow(/reconsideration_denied/);
  }
  expect(texts).toEqual([]); expect(w.core.authorizeScope(previous.capability, w.binding(), w.scope)).toBeNull();
  w.core.revoke(); await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow();
});
for (const change of ["revoke", "expiry", "input", "resave"] as const) test(`无permit的外部重存经${change}不能启动模型或写决定`, async () => {
  const w = await documentWorld(), ticket = w.capture(); await w.core.interpret(ticket, w.basis.requirementId); w.resave();
  let calls = 0; w.setImplementation(async () => { calls++; return JSON.stringify(w.output()); });
  if (change === "revoke") w.core.revoke();
  if (change === "expiry") w.setNow(1_900_000);
  if (change === "input") w.capture("真正新的输入");
  if (change === "resave") w.resave();
  await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow(); expect(calls).toBe(0); expect(w.records()).toEqual([]);
});
test("部分短答问题元数据保留A已答/B未答，旧版本问题不自动跟新候选", async () => {
  const w = await documentWorld(); const q = w.core.ask(JSON.stringify({ basis: w.basis, candidate: candidateBinding(w.candidate), unitIds: ["A", "B"],
    proposal: { conclusion: "确认A与B", scope: "当前文档", references: [], supersedes: [] }, actions: ["implement"] }));
  w.context.questions.push(q); w.output().entries[0]!.requestId = q.requestId; w.output().entries[0]!.resolution = "accept";
  w.output().referenceResolution = "explicit";
  w.output().entries.push(entry({ candidateId: w.candidate.candidateId, kind: "constraint", conclusion: "文档身份元数据" }));
  w.output().documentReview!.units[0]!.conclusionIndexes = [4];
  w.output().documentReview!.questions = [{ requestId: q.requestId, answeredIds: ["A"], pendingIds: ["B"], conclusionIndexes: [0] }];
  const ticket = w.capture("A可以，B还没想好"), parsed = await w.core.interpret(ticket, w.basis.requirementId); w.core.save(parsed.capability);
  expect(w.core.authorizeDocument(parsed.capability, w.binding())!.manifest.questions[0]).toMatchObject({ answeredIds: ["A"], pendingIds: ["B"] });
  w.resave(); await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow(/reconsideration_denied/);
});

test("需要修改的文档只保存短决定；外部重存没有permit不能恢复旧输入能力", async () => {
  const w = await documentWorld(), ticket = w.capture("A只对内测用户，B仍未决");
  w.output().documentReview!.faithful = false; w.output().documentReview!.actions = [];
  w.output().entries[0]!.resolution = "modify"; w.output().entries.splice(3, 1);
  const first = await w.core.interpret(ticket, w.basis.requirementId); w.core.save(first.capability);
  expect(w.core.authorizeDocument(first.capability, w.binding())).toBeNull();
  expect(w.core.authorizeScope(first.capability, w.binding(), w.scope)).toBeNull();
  w.context.document!.body = w.context.document!.body.replace("实施手机号。", "仅向内测用户提供手机号登录。");
  w.resave(); w.output().documentReview!.faithful = true; w.output().entries[0]!.resolution = "direct";
  await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow(/reconsideration_denied/);
  expect(w.core.authorizeDocument(first.capability, w.binding())).toBeNull();
  expect(w.core.authorizeScope(first.capability, w.binding(), w.scope)).toBeNull();
});
test("重解释不能省略整份document审核退回完整候选授权", async () => {
  const w = await documentWorld(), ticket = w.capture(); await w.core.interpret(ticket, w.basis.requirementId); w.resave();
  delete w.context.document; delete w.output().documentReview;
  await expect(w.core.reconsiderSavedCandidate(ticket, w.basis.requirementId)).rejects.toThrow(/reconsideration_denied/);
});
test("全确认文档仍使用同一个完整prod清单；范围许可不能通过JSON能力重建", async () => {
  const w = await documentWorld();
  w.context.document!.body = w.context.document!.body.replace("未决，不实施。", "实施微信登录。"); w.resave();
  w.output().entries[2] = entry({ candidateId: w.candidate.candidateId, conclusion: "确认B" });
  w.output().documentReview!.units[3]!.disposition = "confirmed";
  w.output().documentReview!.actions.push({ action: "implement", goalIds: ["A", "B"], constraintIds: ["preamble"], conclusionIndexes: [3], unknown: false });
  const { capability } = await w.interpret(); w.core.save(capability);
  expect(w.core.authorizeScope(capability, w.binding(), { ...w.scope, goalIds: ["A", "B"] })).not.toBeNull();
  expect(w.core.authorizeDocument(JSON.parse(JSON.stringify(capability)), w.binding())).toBeNull();
});

// F1回归使用真实独立prod Git、SQLite、core.ask与opaque能力；解释器只模拟错误映射。
async function requestScopeWorld(shared = false, bConfirmed = false) {
  const w = await world(); w.setActionHook(() => true);
  const title = "请求范围", body = "# A {#A}\n实施A。\n# B {#B}\n" + (bConfirmed ? "实施B。\n" : "B未决。\n") + (shared ? "# 共享约束 {#C}\n保留邮箱。\n" : "");
  const document = createProdDocument(w.basis.requirementId, title, body);
  const stored = await createStoredProd({ dataRoot: w.options.dataRoot, repoId: w.options.repoId,
    requirementId: w.basis.requirementId, operationId: w.candidate.operationId, expectedParent: null,
    bytes: document.bytes, gitExecutable: HOST_GIT, worktreeRoots: [w.options.repositoryRoot], authorize: () => true });
  w.candidate.to = { commit: stored.commit, hash: stored.prodHash.slice(7) };
  const saved = w.state.recordSavedVersion({ requirementId: w.basis.requirementId, version: w.basis.version,
    operationId: w.candidate.operationId, reference: w.candidate.to });
  Object.assign(w.basis, { version: saved.version, prod: saved.data.saved }); Object.assign(w.candidate, { from: saved.data.saved });
  const partition = partitionProdDocument(w.basis.requirementId, title, body);
  w.context.document = { candidate: candidateBinding(w.candidate), title, body, partition };
  const e = (patch: Partial<InteractionEntry>) => entry({ candidateId: w.candidate.candidateId, ...patch });
  w.setOutput(result([e({ conclusion: "确认A" }), e({ kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "B未决" }),
    e({ kind: "action", actions: ["implement"], conclusion: "实施A" }), e({ kind: "constraint", conclusion: "文档身份元数据" }),
    ...(shared ? [e({ kind: "constraint", conclusion: "保留邮箱", scope: "A的共享条件" })] : [])]));
  w.output().documentReview = { faithful: true, units: partition.units.map(u => ({ id: u.id,
    disposition: u.id === "B" ? "pending-description" : "confirmed", globalConstraint: u.id === "C", appliesTo: u.id === "C" ? ["A"] : [],
    dependsOn: [], conclusionIndexes: [u.id === "metadata" ? 3 : u.id === "A" ? 0 : u.id === "B" ? 1 : 4] })),
    actions: [{ action: "implement", goalIds: ["A"], constraintIds: shared ? ["C"] : [], conclusionIndexes: [2], unknown: false }], questions: [] };
  const binding = () => ({ basis: w.basis, candidate: candidateBinding(w.candidate) });
  function ask(unitIds = ["A"], actions: Array<"implement" | "analyze"> = ["implement"]) {
    const q = w.core.ask(JSON.stringify({ ...binding(), unitIds, actions,
      proposal: { conclusion: "是否实施指定范围", scope: "仅问题所列单位", references: [], supersedes: [] } }));
    w.context.questions.push(q); return q;
  }
  function answerA() {
    const q = ask(); w.output().referenceResolution = "single-question";
    for (const i of [0, 2]) Object.assign(w.output().entries[i]!, { requestId: q.requestId, resolution: "accept" });
    w.output().documentReview!.questions = [{ requestId: q.requestId, answeredIds: ["A"], pendingIds: [], conclusionIndexes: [0, 2] }];
    return q;
  }
  return { ...w, binding, e, ask, answerA };
}
for (const attack of ["original-F1", "hidden-unit", "hidden-action", "reused-entry", "direct-target", "direct-action", "direct-new-action", "metadata-goal", "metadata-reused", "outside-constraint"] as const) {
  test(`请求范围F1真实Git/SQLite拒绝${attack}且不保存越权记录`, async () => {
    const w = await requestScopeWorld(), q = w.answerA(), r = w.output().documentReview!;
    if (["original-F1", "hidden-unit", "hidden-action", "reused-entry", "direct-target", "direct-action"].includes(attack)) {
      w.output().entries[1] = w.e({ conclusion: "确认B", requestId: q.requestId, resolution: "accept" });
      r.units[2]!.disposition = "confirmed";
    }
    if (["original-F1", "hidden-action", "direct-action"].includes(attack)) r.actions[0]!.goalIds = ["B"];
    if (attack === "original-F1") r.questions[0]!.conclusionIndexes = [0];
    if (attack === "hidden-action") r.questions[0]!.conclusionIndexes = [0, 1];
    if (attack === "reused-entry") {
      w.output().entries[1] = w.e({ kind: "future", basis: "proposed", resolution: "defer", candidateId: null, conclusion: "未纳入执行的未来讨论" });
      r.units[2]!.conclusionIndexes = [0];
    }
    if (attack === "direct-target") Object.assign(w.output().entries[1]!, { requestId: null, resolution: "direct" });
    if (attack === "direct-action") { Object.assign(w.output().entries[1]!, { requestId: null, resolution: "direct" }); Object.assign(w.output().entries[2]!, { requestId: null, resolution: "direct" }); r.questions[0]!.conclusionIndexes = [0]; }
    if (attack === "direct-new-action") { Object.assign(w.output().entries[2]!, { requestId: null, resolution: "direct", actions: ["analyze"] }); r.actions[0]!.action = "analyze"; r.questions[0]!.conclusionIndexes = [0]; }
    if (attack === "metadata-goal") { w.output().entries[3]!.kind = "target"; r.actions[0]!.goalIds = ["metadata"]; }
    if (attack === "metadata-reused") { r.units[2]!.conclusionIndexes = [3]; r.units[2]!.disposition = "confirmed"; r.units[1]!.conclusionIndexes.push(1); r.faithful = false; }
    if (attack === "outside-constraint") { w.output().entries[1] = w.e({ kind: "constraint", conclusion: "B约束" }); r.units[2]!.disposition = "confirmed"; }
    await expect(w.interpret("可以")).rejects.toThrow(/interpretation_denied/);
    expect(w.records()).toEqual([]);
  });
}
test("完整候选单题短答也不能通过direct或清空requestId扩大动作", async () => {
  const w = await world(), q = await question(w);
  w.setOutput(result(w.output().entries.map(e => ({ ...e, requestId: q.requestId, resolution: "accept" })), "single-question"));
  Object.assign(w.output().entries[1]!, { requestId: null, resolution: "direct", actions: ["implement"] });
  await expect(w.interpret("可以")).rejects.toThrow(/interpretation_denied/); expect(w.records()).toEqual([]);
});
for (const attack of ["missing-source", "changed-conclusion", "changed-scope", "wrong-source", "pending-source", "constraint-as-goal"] as const) {
  test(`独立共享约束${attack}不构成短答的新授权依据`, async () => {
    const w = await requestScopeWorld(true), first = await w.interpret("A实施，保留邮箱，B未决。");
    const saved = w.core.save(first.capability), old = w.core.readDecision(w.basis.requirementId, saved.decisionIds[attack === "pending-source" ? 1 : 4]!);
    w.context.priorDecisions = [old]; w.output().entries[4]!.references = [old.decisionId]; w.answerA();
    if (attack === "missing-source") w.output().entries[4]!.references = [];
    if (attack === "changed-conclusion") w.output().entries[4]!.conclusion = "改成另一条约束";
    if (attack === "changed-scope") w.output().entries[4]!.scope = "新增B范围";
    if (attack === "wrong-source") w.output().entries[4]!.references = [uuidv7()];
    if (attack === "pending-source") Object.assign(w.output().entries[4]!, { conclusion: old.conclusion, scope: old.scope });
    if (attack === "constraint-as-goal") {
      w.output().entries[4]!.kind = "target"; w.output().documentReview!.units[3]!.globalConstraint = false;
      w.output().documentReview!.units[3]!.appliesTo = []; w.output().documentReview!.actions[0]!.goalIds = ["C"];
      w.output().documentReview!.actions[0]!.constraintIds = [];
    }
    const before = w.records(); await expect(w.interpret("可以")).rejects.toThrow(/interpretation_denied/); expect(w.records()).toEqual(before);
  });
}
test("单题只答A可实施A但不能实施B；全部pending只允许阅读清单", async () => {
  const w = await requestScopeWorld(); w.answerA();
  const parsed = await w.interpret("可以"); w.core.save(parsed.capability);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["A"], constraintIds: [] })).not.toBeNull();
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["B"], constraintIds: [] })).toBeNull();
  w.context.questions = []; w.output().referenceResolution = "none";
  w.output().entries = [w.e({ kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "整份描述待确认事项" })];
  for (const u of w.output().documentReview!.units) { u.disposition = "pending-description"; u.conclusionIndexes = [0]; }
  w.output().documentReview!.actions = []; w.output().documentReview!.questions = [];
  const pending = await w.interpret("全部还未决定，仅描述未决事项"); w.core.save(pending.capability);
  expect(w.core.authorizeDocument(pending.capability, w.binding())).not.toBeNull();
  expect(w.core.authorizeScope(pending.capability, w.binding(), { action: "implement", goalIds: ["A"], constraintIds: [] })).toBeNull();
});
test("两题长答A接受/B暂缓，问题索引完整覆盖实际答案，B不获动作", async () => {
  const w = await requestScopeWorld(), a = w.answerA(), b = w.ask(["B"]);
  w.output().referenceResolution = "explicit"; w.output().entries[1]!.requestId = b.requestId;
  w.output().documentReview!.questions.push({ requestId: b.requestId, answeredIds: [], pendingIds: ["B"], conclusionIndexes: [1] });
  const parsed = await w.interpret("A可以实施，B暂缓"); w.core.save(parsed.capability);
  expect(w.core.authorizeDocument(parsed.capability, w.binding())!.manifest.questions).toMatchObject([
    { requestId: a.requestId, answeredIds: ["A"], pendingIds: [] }, { requestId: b.requestId, answeredIds: [], pendingIds: ["B"] }]);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["A"], constraintIds: [] })).not.toBeNull();
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["B"], constraintIds: [] })).toBeNull();
});
test("长答explicit直接新指令B有独立target/action，不借问题A批准B", async () => {
  const w = await requestScopeWorld(false, true); w.answerA(); w.output().referenceResolution = "explicit";
  w.output().entries[1] = w.e({ conclusion: "直接确认B" }); w.output().documentReview!.units[2]!.disposition = "confirmed";
  w.output().entries.push(w.e({ kind: "action", actions: ["implement"], conclusion: "直接实施B" }));
  w.output().documentReview!.actions.push({ action: "implement", goalIds: ["B"], constraintIds: [], conclusionIndexes: [4], unknown: false });
  const parsed = await w.interpret("A按问题实施。另外我直接要求B也实施，B不再未决。"); w.core.save(parsed.capability);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["B"], constraintIds: [] })).not.toBeNull();
});
test("短答问题外共享约束必须有独立当前记录，约束不能成为行为目标且来源取代后失效", async () => {
  const w = await requestScopeWorld(true), first = await w.interpret("明确A目标和实施，保留邮箱约束，B未决。");
  const saved = w.core.save(first.capability), old = w.core.readDecision(w.basis.requirementId, saved.decisionIds[4]!);
  w.context.priorDecisions = [old]; w.output().entries[4]!.references = [old.decisionId]; w.answerA();
  const parsed = await w.interpret("可以"), current = w.core.save(parsed.capability);
  expect(w.core.authorizeDocument(parsed.capability, w.binding())!.manifest.units.find(u => u.id === "C")!.decisionIds).toEqual([current.decisionIds[4], old.decisionId]);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["A"], constraintIds: ["C"] })).not.toBeNull();
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["C"], constraintIds: [] })).toBeNull();
  const { document: _document, ...context } = w.context; context.questions = [];
  const second = await UserInteractionCore.open({ ...w.options, loadContext: async () => context, interpreter: { identity: () => model,
    interpret: async () => JSON.stringify(result([w.e({ kind: "constraint", conclusion: "修订共享约束", supersedes: [old.decisionId] })])) } });
  cleanup.push(() => second.shutdown()); second.startSession({ sessionId: "second", windowId: "second" });
  const update = await second.interpret(second.captureInput({ source: "interactive", text: "修改共享约束" }, "second"), w.basis.requirementId); second.save(update.capability);
  expect(w.core.authorizeScope(parsed.capability, w.binding(), { action: "implement", goalIds: ["A"], constraintIds: ["C"] })).toBeNull();
});

async function adapterWorld() {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  let selected = faux.getModel();
  const registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "complete"> = {
    find: (provider, id) => models.getModel(provider, id), hasConfiguredAuth: () => true,
    complete: (model, context, options) => models.complete(model, context, options),
  };
  const interpreter = createPiInteractionInterpreter({ registry, selectedModel: () => selected, timeoutMs: 1000 });
  return { faux, registry, interpreter, setSelected: (value: typeof selected) => { selected = value; } };
}
test("真实pi-ai适配路径使用选定模型、单条当前输入、固定指令、无工具且不存会话（faux只证明调用契约）", async () => {
  const w = await world(), a = await adapterWorld(); const complete = a.registry.complete;
  let requestMessages: unknown;
  const spy = vi.spyOn(a.registry, "complete").mockImplementation((model, context, options) => {
    requestMessages = structuredClone(context.messages); return complete(model, context, options);
  });
  a.faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(w.output()))])]);
  const output = await a.interpreter.interpret({ text: PHONE, context: w.context, model: a.interpreter.identity(), signal: new AbortController().signal });
  expect(JSON.parse(output)).toEqual(w.output());
  expect(requestMessages).toMatchObject([{ role: "user", content: JSON.stringify({ text: PHONE, context: w.context }) }]);
  expect(spy.mock.calls[0]![1].tools).toEqual([]); expect(spy.mock.calls[0]![1].systemPrompt).toContain("仅输出符合");
  expect(spy.mock.calls[0]![2]).toMatchObject({ cacheRetention: "none" });
  expect(spy.mock.calls[0]![1].messages).toEqual([]); // finally释放适配器持有的原文
});
test("pi-ai完整文档review走真实同一API路径，原文只在调用载荷中且响应固定schema", async () => {
  const w = await documentWorld(), a = await adapterWorld(), complete = a.registry.complete;
  let payload: { context: InteractionContext } | undefined;
  const spy = vi.spyOn(a.registry, "complete").mockImplementation((m, c, o) => {
    payload = JSON.parse(String((c.messages[0] as { content: string }).content)); return complete(m, c, o);
  });
  a.faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(w.output()))])]);
  await a.interpreter.interpret({ text: "A实施，B未决", context: w.context, model: a.interpreter.identity(), signal: new AbortController().signal });
  expect(payload!.context.document!.body).toBe(w.context.document!.body);
  expect(spy.mock.calls[0]![1].systemPrompt).toContain("pending-description");
  expect(spy.mock.calls[0]![1].messages).toEqual([]);
});
test("pi-ai调用期间切换宿主模型，旧结果拒绝而不偷换模型", async () => {
  const w = await world(), a = await adapterWorld();
  const complete = a.registry.complete; let proceed!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { proceed = resolve; });
  a.registry.complete = async (model, context, options) => { entered(); await wait; return complete(model, context, options); };
  a.faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(w.output()))])]);
  const pending = a.interpreter.interpret({ text: PHONE, context: w.context, model: a.interpreter.identity(), signal: new AbortController().signal });
  await ready; a.setSelected({ ...a.faux.getModel(), id: "different-selection" }); proceed();
  await expect(pending).rejects.toThrow(/model_interpretation_denied/);
});
for (const failure of ["auth", "tool", "length", "invalid", "wrong-model", "timeout"] as const) test(`pi-ai适配器${failure}失败默认拒绝，不降级模型或回显载荷`, async () => {
  const w = await world(), a = await adapterWorld(); const actualModel = a.interpreter.identity();
  if (failure === "auth") a.registry.hasConfiguredAuth = () => false;
  else if (failure === "tool") a.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "/tmp/no" })], { stopReason: "toolUse" })]);
  else if (failure === "length") a.faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify(w.output()))], { stopReason: "length" })]);
  else if (failure === "invalid") a.faux.setResponses([fauxAssistantMessage([fauxText('{"actor":"user"}')])]);
  else if (failure === "wrong-model") a.registry.complete = async () => ({ ...fauxAssistantMessage([fauxText(JSON.stringify(w.output()))]), provider: "foreign", model: "foreign" });
  else a.registry.complete = async () => new Promise(() => {});
  const interpreter = createPiInteractionInterpreter({ registry: a.registry, selectedModel: () => a.faux.getModel(), timeoutMs: 10 });
  await expect(interpreter.interpret({ text: PHONE, context: w.context,
    model: actualModel, signal: new AbortController().signal })).rejects.toThrow(/model_interpretation_denied/);
});
