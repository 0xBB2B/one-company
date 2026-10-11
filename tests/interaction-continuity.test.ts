import { afterEach, expect, test, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { uuidv7, repositoryDatabase, withDatabase, LocalDatabase } from "../runtime/database.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";
import { interpreterView } from "../runtime/user-interaction-format.ts";
import type { InteractionContext, InteractionInterpretation } from "../runtime/user-interaction-format.ts";
import { INTERACTION_CONTINUITY_NAMESPACE, loadInteractionContinuity } from "../runtime/interaction-continuity.ts";
import { ApprovalManifestStore, summarizeApprovalManifest } from "../runtime/approval-manifest-store.ts";

const exec = promisify(execFile), clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of clean.splice(0).reverse()) await c(); });
async function world(body = "# A {#A}\nA目标。\n# B {#B}\nB目标。\n") {
  const root = await mkdtemp(join(temporaryRoot(), "ic-")), repo = join(root, "repo"), dataRoot = join(root, "data");
  await mkdir(repo); await mkdir(dataRoot); await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "fixture"); await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "init"], { cwd: repo });
  const { repoId } = await repositoryIdentity(repo), path = repositoryDatabase(dataRoot, repoId);
  const service = await RequirementService.open({ dataRoot, repositoryRoot: repo, repoId, authorize: () => true });
  let saved = await service.create({ operationId: uuidv7(), requestId: uuidv7(), title: "候选", body });
  let loaded = await service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId: uuidv7() });
  const context = (): InteractionContext => {
    const document = { candidate: loaded.candidate, title: loaded.title, body: loaded.body, partition: loaded.partition };
    return { basis: loaded.basis, currentGoal: "", candidates: [{ ...loaded.candidate, diff: "实际服务已核对候选" }], document, savedOperationId: loaded.savedOperationId,
      ...loadInteractionContinuity(dataRoot, repoId, loaded.basis, document) };
  };
  let output: (ctx: InteractionContext) => InteractionInterpretation = (ctx) => review(ctx);
  let identityHook: (() => void) | undefined;
  const core = await UserInteractionCore.open({ dataRoot, repositoryRoot: repo, repoId, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => context(), interpreter: { identity: () => { identityHook?.(); return { provider: "fixture", id: "continuity", configurationHash: "a".repeat(64) }; },
      interpret: async ({ context }) => JSON.stringify(output(context)) } });
  core.startSession({ sessionId: "actual-fixture", windowId: "actual-fixture" });
  clean.push(async () => { core.shutdown(); await rm(root, { recursive: true, force: true }); });
  const interpret = async (text: string) => core.interpret(core.captureInput({ source: "interactive", text }, "actual-fixture"), saved.requirementId);
  return { core, context, interpret, path, dataRoot, repoId, service, repo, setIdentityHook: (hook: (() => void) | undefined) => { identityHook = hook; }, get loaded() { return loaded; }, setOutput: (f: typeof output) => { output = f; },
    resave: async (nextBody = loaded.body.replace("B目标", "B修改后目标")) => {
      saved = await service.updateDraft({ requirementId: saved.requirementId, version: loaded.version, operationId: uuidv7(), title: "候选", body: nextBody });
      loaded = await service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId: uuidv7() });
    } };
}
function review(ctx: InteractionContext): InteractionInterpretation {
  const e = (kind: "constraint" | "target" | "action", conclusion: string) => ({ kind, conclusion, scope: "当前明确范围", basis: "explicit" as const, resolution: "direct" as const,
    candidateId: ctx.document!.candidate.candidateId, requestId: null, actions: kind === "action" ? ["analyze" as const] : [], references: [], supersedes: [] });
  return { format: "interaction-interpretation/v1", referenceResolution: "none", entries: [e("constraint", "文档身份"), e("target", "A目标"), e("target", "B目标"), e("action", "分析B")],
    documentReview: { faithful: true, units: ctx.document!.partition.units.map((u, i) => ({ id: u.id, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [], conclusionIndexes: [i] })),
      actions: [{ action: "analyze", goalIds: ["B"], constraintIds: [], conclusionIndexes: [3], unknown: false }], questions: [] } };
}
test("跨版本保留A原目标，新增B决定不复制A用户结论；原决定取代撤销旧范围", async () => {
  const w = await world(), first = await w.interpret("A与B目标明确，分析B"), original = w.core.save(first.capability);
  await w.resave();
  const evidence = w.context().retainedEvidence!.find((e) => e.unitId === "A")!;
  expect(evidence.decision.id).toBe(original.decisionIds[1]); expect(evidence.sourceBasis.version).toBeLessThan(w.loaded.version);
  w.setOutput((ctx) => {
    const output = review(ctx); output.entries.splice(1, 1); output.entries[1]!.conclusion = "B修改后目标";
    output.documentReview!.units[1] = { ...output.documentReview!.units[1]!, conclusionIndexes: [], retainedFactIds: [evidence.fact.id] };
    output.documentReview!.units[2]!.conclusionIndexes = [1]; output.documentReview!.actions[0]!.conclusionIndexes = [2]; return output;
  });
  const next = await w.interpret("改B目标并分析B；A保持原结论"), saved = w.core.save(next.capability);
  expect(saved.decisionIds).toHaveLength(3);
  const rows = withDatabase(w.path, (db) => db.list<{ conclusion: string }>("short_decisions"));
  expect(rows.filter((r) => r.data.conclusion === "A目标")).toHaveLength(1);
  const approved = w.core.authorizeDocument(next.capability, w.loaded)!;
  expect(approved.manifest.retainedSources).toContainEqual(evidence);
  expect(approved.manifest.actions.map((a) => a.goalIds)).toEqual([["B"]]);
  const store = new ApprovalManifestStore({ dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true,
    loadExpected: async () => ({ requirementId: w.loaded.requirementId, candidate: w.loaded.candidate, partition: w.loaded.partition }),
    admit: () => ({ receiptId: approved.authorization.receiptId, version: w.loaded.version, epoch: w.loaded.epoch, inputProof: approved.authorization.inputProof }) });
  await store.register(approved.manifest);
  // 第二次真实输入经Core的supersedes机制修订原来源，不直接伪造actor或SQL状态。
  const old = w.core.readDecision(w.loaded.requirementId, evidence.decision.id);
  const second = await UserInteractionCore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repo, repoId: w.repoId,
    authorize: () => true, authorizeAction: () => true, loadContext: async () => ({ basis: w.loaded.basis, currentGoal: "", candidates: [], questions: [], priorDecisions: [old] }),
    interpreter: { identity: () => ({ provider: "fixture", id: "revision", configurationHash: "b".repeat(64) }), interpret: async () => JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "explicit", entries: [{ kind: "target", basis: "explicit", resolution: "direct", conclusion: "A修订", scope: "A", candidateId: null, requestId: null, actions: [], references: [], supersedes: [old.decisionId] }] }) } });
  try {
    second.startSession({ sessionId: "second", windowId: "second" });
    second.save((await second.interpret(second.captureInput({ source: "interactive", text: "修订A" }, "second"), w.loaded.requirementId)).capability);
    expect(w.core.authorizeDocument(next.capability, w.loaded)).toBeNull();
  } finally { second.shutdown(); }
});
test("A/B两题先答A再答B，已答A收束但原问题保留；短答B不授予A动作", async () => {
  const w = await world(), c = w.loaded;
  const ask = (id: string) => w.core.ask(JSON.stringify({ basis: c.basis, candidate: c.candidate, partition: c.partition, unitIds: [id], actions: ["analyze"],
    proposal: { conclusion: `确认${id}并分析该范围`, scope: id, references: [], supersedes: [] } }));
  const a = ask("A"), b = ask("B");
  w.setOutput((ctx) => {
    const r = review(ctx); r.referenceResolution = "explicit";
    r.entries[1] = { ...r.entries[1]!, requestId: a.requestId, resolution: "accept" };
    r.entries[2] = { ...r.entries[2]!, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "B未答" };
    r.entries.splice(3, 1); r.documentReview!.actions = []; r.documentReview!.units[2]!.disposition = "pending-description";
    r.documentReview!.questions = [{ requestId: a.requestId, answeredIds: ["A"], pendingIds: [], conclusionIndexes: [1] },
      { requestId: b.requestId, answeredIds: [], pendingIds: ["B"], conclusionIndexes: [] }]; return r;
  });
  const first = await w.interpret("A可以，B暂缓"); w.core.save(first.capability);
  const middle = w.context(); expect(middle.questions.map((q) => q.requestId)).toEqual([b.requestId]);
  expect(withDatabase(w.path, (db) => db.read("interaction_questions_v1", a.requestId))!.data).toEqual(a);
  const source = middle.retainedEvidence!.find((e) => e.unitId === "A")!;
  w.setOutput((ctx) => {
    const r = review(ctx); r.referenceResolution = "single-question"; r.entries.splice(1, 1);
    r.entries[1] = { ...r.entries[1]!, requestId: b.requestId, resolution: "accept" };
    r.entries[2] = { ...r.entries[2]!, requestId: b.requestId, resolution: "accept" };
    r.documentReview!.units[1] = { ...r.documentReview!.units[1]!, conclusionIndexes: [], retainedFactIds: [source.fact.id] };
    r.documentReview!.units[2]!.conclusionIndexes = [1]; r.documentReview!.actions[0]!.conclusionIndexes = [2];
    r.documentReview!.questions = [{ requestId: b.requestId, answeredIds: ["B"], pendingIds: [], conclusionIndexes: [1, 2] }]; return r;
  });
  const second = await w.interpret("可以"); w.core.save(second.capability);
  const manifest = w.core.authorizeDocument(second.capability, w.loaded)!.manifest;
  expect(manifest.actions).toEqual([expect.objectContaining({ action: "analyze", goalIds: ["B"], constraintIds: [], unknown: false })]);
  expect(summarizeApprovalManifest(manifest).blocked).toEqual([]);
  expect(w.context().questions).toEqual([]);
  expect(withDatabase(w.path, (db) => db.list("interaction_questions_v1"))).toHaveLength(2);
  expect(withDatabase(w.path, (db) => db.list<{ conclusion: string }>("short_decisions")).filter((r) => r.data.conclusion === "A目标")).toHaveLength(1);
  const beforeRevision = w.context(), oldA = beforeRevision.priorDecisions.find((d) => d.conclusion === "A目标")!;
  const retainedB = beforeRevision.retainedEvidence!.find((e) => e.unitId === "B")!;
  w.setOutput((ctx) => {
    const r = review(ctx); r.entries[1]!.supersedes = [oldA.decisionId]; r.entries[1]!.conclusion = "A更新后的目标";
    r.entries.splice(2, 1); r.documentReview!.units[2] = { ...r.documentReview!.units[2]!, conclusionIndexes: [], retainedFactIds: [retainedB.fact.id] };
    r.documentReview!.actions[0]!.conclusionIndexes = [2]; return r;
  });
  const revised = await w.interpret("更新A目标，B维持且只分析B"); w.core.save(revised.capability);
  expect(w.context().questions).toEqual([]); // A的真实修订链不让B重新待答，也不重开A原问题。
});
test("不忠实原文的direct+modify不能变成retained；只改B不能丢A的修订待办", async () => {
  const w = await world();
  w.setOutput((ctx) => {
    const r = review(ctx); r.documentReview!.faithful = false;
    r.entries.splice(2, 0, { ...r.entries[0]!, conclusion: "A必须限定内测用户", resolution: "modify" });
    r.documentReview!.units[1]!.conclusionIndexes = [1, 2]; r.documentReview!.units[2]!.conclusionIndexes = [3];
    r.documentReview!.actions[0]!.conclusionIndexes = [4]; return r;
  });
  const first = await w.interpret("A必须限定内测用户，B目标明确，只分析B"), saved = w.core.save(first.capability);
  expect(w.core.authorizeDocument(first.capability, w.loaded)).toBeNull();
  for (const onlyChangeB of [false, true]) {
    if (onlyChangeB) await w.resave();
    const context = w.context();
    expect(context.retainedEvidence!.some((e) => e.unitId === "A")).toBe(false);
    expect(context.continuityIssues).toContainEqual(expect.objectContaining({ unitId: "A", reason: "modify" }));
    expect(context.priorDecisions.some((d) => d.conclusion === "A必须限定内测用户")).toBe(true);
    w.setOutput((ctx) => {
      const r = review(ctx); r.entries.splice(1, 1);
      r.documentReview!.units[1] = { ...r.documentReview!.units[1]!, conclusionIndexes: [], retainedFactIds: [saved.operationId] };
      r.documentReview!.units[2]!.conclusionIndexes = [1]; r.documentReview!.actions[0]!.conclusionIndexes = [2]; return r;
    });
    await expect(w.interpret("只分析B，A按原决定保留")).rejects.toThrow();
  }
  await w.resave(w.loaded.body.replace("A目标。", "A目标，仅限内测用户。"));
  w.setOutput((ctx) => { const r = review(ctx); r.entries[1]!.conclusion = "A仅限内测用户"; return r; });
  const fixed = await w.interpret("确认A仅限内测用户，B仍按原目标，只分析B"); w.core.save(fixed.capability);
  expect(w.core.authorizeDocument(fixed.capability, w.loaded)).not.toBeNull();
  expect(w.context().continuityIssues!.some((issue) => issue.unitId === "A")).toBe(false);
});

test("合法supersedes原目标后补事实和缓存重试成功，B仍用原来源且不被重新批准", async () => {
  const w = await world(), first = await w.interpret("A与B明确，只分析B"), original = w.core.save(first.capability);
  const b = w.context().retainedEvidence!.find((e) => e.unitId === "B")!;
  w.setOutput((ctx) => {
    const r = review(ctx); r.entries[1]!.conclusion = "A修订后的明确目标"; r.entries[1]!.supersedes = [original.decisionIds[1]!];
    r.entries.splice(2, 1); r.documentReview!.units[2] = { ...r.documentReview!.units[2]!, conclusionIndexes: [], retainedFactIds: [b.fact.id] };
    r.documentReview!.actions[0]!.conclusionIndexes = [2]; return r;
  });
  const second = await w.interpret("修订A目标，B保持原目标且只分析B"), saved = w.core.save(second.capability);
  expect(w.core.readDecision(w.loaded.requirementId, original.decisionIds[1]!)).toMatchObject({ status: "superseded", supersededBy: saved.decisionIds[1] });
  expect(w.core.save(second.capability)).toEqual(saved);
  expect(w.core.authorizeDocument(second.capability, w.loaded)?.manifest.retainedSources).toContainEqual(b);
  expect(withDatabase(w.path, (db) => db.list(INTERACTION_CONTINUITY_NAMESPACE))).toHaveLength(2);
  expect(withDatabase(w.path, (db) => db.list<{ conclusion: string }>("short_decisions")).filter((row) => row.data.conclusion === "B目标")).toHaveLength(1);
});

test("supersedes之后事实失败只补同operation，原决定链与新行不得被跳过核验", async () => {
  const w = await world(), first = await w.interpret("A B明确"), original = w.core.save(first.capability);
  w.setOutput((ctx) => { const r = review(ctx); r.entries[1]!.supersedes = [original.decisionIds[1]!]; r.entries[1]!.conclusion = "A修订"; return r; });
  const second = await w.interpret("修订A并确认B"), create = LocalDatabase.prototype.create;
  const fault = vi.spyOn(LocalDatabase.prototype, "create").mockImplementation(function (namespace, ...args) {
    if (namespace === INTERACTION_CONTINUITY_NAMESPACE) throw new Error("fact_after_revision_failure");
    return create.call(this, namespace, ...args);
  });
  try { expect(() => w.core.save(second.capability)).toThrow(/fact_after_revision_failure/); } finally { fault.mockRestore(); }
  const rows = withDatabase(w.path, (db) => db.list("short_decisions")); expect(rows).toHaveLength(8);
  const saved = w.core.save(second.capability); expect(w.core.save(second.capability)).toEqual(saved);
  expect(withDatabase(w.path, (db) => db.list("short_decisions"))).toEqual(rows);
  withDatabase(w.path, (db) => { const old = db.read("short_decisions", original.decisionIds[1]!)!; db.update("short_decisions", original.decisionIds[1]!, old.version, old.data); });
  expect(w.core.authorizeDocument(second.capability, w.loaded)).toBeNull();
});

test("共享未决约束的影响不能通过下一轮丢global标记绕过，独立B仍可分析", async () => {
  const w = await world(), first = await w.interpret("A B明确，只分析B"); w.core.save(first.capability);
  await w.resave(w.loaded.body + "# G {#G}\nG仍待确认；确定前禁止A的全部操作（含分析）。\n");
  const render = (ctx: InteractionContext, globalConstraint: boolean, goal: "A" | "B"): InteractionInterpretation => {
    const base = review(ctx), metadata = base.entries[0]!, action = { ...base.entries[3]!, conclusion: `分析${goal}` };
    return { format: "interaction-interpretation/v1", referenceResolution: "none",
      entries: [metadata, { ...metadata, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "G仍待确认" }, action],
      documentReview: { faithful: true, units: ctx.document!.partition.units.map((unit) => {
        const common = { id: unit.id, globalConstraint: false, appliesTo: [], dependsOn: [] };
        if (unit.id === "metadata") return { ...common, disposition: "confirmed", conclusionIndexes: [0] };
        if (unit.id === "G") return { ...common, disposition: "pending-description", conclusionIndexes: [1], globalConstraint, appliesTo: globalConstraint ? ["A"] : [] };
        return { ...common, disposition: "confirmed", conclusionIndexes: [], retainedFactIds: [ctx.retainedEvidence!.find((source) => source.unitId === unit.id)!.fact.id] };
      }), actions: [{ action: "analyze", goalIds: [goal], constraintIds: [], conclusionIndexes: [2], unknown: false }], questions: [] } };
  };
  w.setOutput((ctx) => render(ctx, true, "B")); const pending = await w.interpret("增加G待确认限制，B独立分析"); w.core.save(pending.capability);
  expect(w.context().continuityIssues).toContainEqual(expect.objectContaining({ unitId: "G", affectedUnitIds: expect.arrayContaining(["A"]) }));
  w.setOutput((ctx) => render(ctx, false, "A")); await expect(w.interpret("G未解决，仅看A")).rejects.toThrow();
  w.setOutput((ctx) => render(ctx, true, "B")); const next = await w.interpret("G继续待确认，只分析不依赖G的B"); w.core.save(next.capability);
  const manifest = w.core.authorizeDocument(next.capability, w.loaded)!.manifest;
  expect(manifest.actions).toEqual([expect.objectContaining({ action: "analyze", goalIds: ["B"], constraintIds: [], unknown: false })]);
  expect(summarizeApprovalManifest(manifest).blocked).not.toContain("B");
});

test("G约束H且H约束A时，未决影响传递到A及完整约束范围", async () => {
  const w = await world();
  await w.resave(w.loaded.body + "# G {#G}\nG未决；H的使用须先解决G。\n# H {#H}\nH约束A。\n");
  const render = (ctx: InteractionContext, original: boolean): InteractionInterpretation => {
    const r = review(ctx);
    r.entries.push({ ...r.entries[0]!, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: "G未决" }, { ...r.entries[0]!, conclusion: "H约束A" });
    r.documentReview!.units = ctx.document!.partition.units.map((unit, i) => ({ id: unit.id, disposition: unit.id === "G" ? "pending-description" : "confirmed",
      globalConstraint: unit.id === "H" || unit.id === "G" && original, appliesTo: unit.id === "H" ? ["A"] : unit.id === "G" && original ? ["H"] : [],
      dependsOn: [], conclusionIndexes: [i < 3 ? i : i + 1] }));
    if (!original) { r.documentReview!.actions[0]!.goalIds = ["A"]; r.documentReview!.actions[0]!.constraintIds = ["H"]; }
    return r;
  };
  w.setOutput((ctx) => render(ctx, true)); const first = await w.interpret("G未决，只分析独立B"); w.core.save(first.capability);
  expect(w.context().continuityIssues!.find((issue) => issue.unitId === "G")!.affectedUnitIds).toEqual(expect.arrayContaining(["G", "H", "A"]));
  w.setOutput((ctx) => render(ctx, false)); await expect(w.interpret("G仍未解决，却请求A")).rejects.toThrow();
});

test.each(["document", "register", "register-after-core", "cross-process"] as const)("最后回调新增真实问题使输入集合失效（%s）", async (mode) => {
  const w = await world(), first = await w.interpret("A B明确"), old = w.core.save(first.capability);
  w.setOutput((ctx) => { const r = review(ctx); r.entries[1]!.supersedes = [old.decisionIds[1]!]; return r; });
  const current = await w.interpret("修订A，分析B"); w.core.save(current.capability);
  const approved = w.core.authorizeDocument(current.capability, w.loaded)!;
  const other = await UserInteractionCore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repo, repoId: w.repoId, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => w.context(), interpreter: { identity: () => ({ provider: "fixture", id: "other", configurationHash: "b".repeat(64) }), interpret: async () => { throw new Error("unused"); } } });
  other.startSession({ sessionId: "other", windowId: "other" }); clean.push(async () => other.shutdown());
  let questionId: string | undefined;
  const addQuestion = () => {
    const input = JSON.stringify({ basis: w.loaded.basis, candidate: w.loaded.candidate, partition: w.loaded.partition, unitIds: ["B"], actions: ["analyze"],
      proposal: { conclusion: "B新增未确认前提", scope: "B", references: [], supersedes: [] } });
    if (mode !== "cross-process") { questionId = other.ask(input).requestId; return; }
    const modulePath = fileURLToPath(new URL("../runtime/user-interaction.ts", import.meta.url));
    const source = `import {UserInteractionCore} from ${JSON.stringify(modulePath)}; const c=await UserInteractionCore.open({...${JSON.stringify({ dataRoot: w.dataRoot, repositoryRoot: w.repo, repoId: w.repoId })}, authorize:()=>true,authorizeAction:()=>true,loadContext:async()=>{throw Error('unused')},interpreter:{identity:()=>({provider:'fixture',id:'child',configurationHash:'c'.repeat(64)}),interpret:async()=>{throw Error('unused')}}});try{c.startSession({sessionId:'child',windowId:'child'});console.log(JSON.stringify(c.ask(${JSON.stringify(input)}).requestId));}finally{c.shutdown();}`;
    questionId = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }));
  };
  let calls = 0;
  if (mode !== "register-after-core") w.setIdentityHook(() => { if (++calls === (mode === "document" ? 3 : 6)) addQuestion(); });
  if (mode.startsWith("register") || mode === "cross-process") {
    let admissions = 0;
    const store = new ApprovalManifestStore({ dataRoot: w.dataRoot, repoId: w.repoId, authorize: () => true,
      loadExpected: async () => ({ requirementId: w.loaded.requirementId, candidate: w.loaded.candidate, partition: w.loaded.partition }),
      admit: () => {
        const document = w.core.authorizeDocument(current.capability, w.loaded);
        if (++admissions === 2 && mode === "register-after-core") addQuestion();
        return document ? { receiptId: document.authorization.receiptId, version: w.loaded.version, epoch: w.loaded.epoch, inputProof: document.authorization.inputProof } : null;
      } });
    await expect(store.register(approved.manifest)).rejects.toThrow();
    expect(withDatabase(w.path, (db) => db.list("approval_manifests_v1"))).toEqual([]);
  } else expect(w.core.authorizeDocument(current.capability, w.loaded)).toBeNull();
  expect(questionId).toBeDefined(); w.setIdentityHook(undefined);
  expect(w.context().questions.some((question) => question.requestId === questionId)).toBe(true);
  expect(w.core.authorizeDocument(current.capability, w.loaded)).toBeNull();
});

test("新B决定不能supersede仍存在的A来源", async () => {
  const w = await world(), first = await w.interpret("A B明确"), initial = w.core.save(first.capability);
  const before = withDatabase(w.path, (db) => db.list("short_decisions"));
  w.setOutput((ctx) => { const r = review(ctx); r.entries[2]!.supersedes = [initial.decisionIds[1]!]; return r; });
  await expect(w.interpret("修改B" )).rejects.toThrow();
  expect(withDatabase(w.path, (db) => db.list("short_decisions"))).toEqual(before);
});

test("来源事实登记失败以固定operation补登，短决定不重复且事实没有正文输入", async () => {
  const w = await world(), result = await w.interpret("真实输入不应复制到来源事实"), original = LocalDatabase.prototype.create;
  const fail = vi.spyOn(LocalDatabase.prototype, "create").mockImplementation(function (namespace, ...args) {
    if (namespace === INTERACTION_CONTINUITY_NAMESPACE) throw new Error("fixture_fact_failure");
    return original.call(this, namespace, ...args);
  });
  try { expect(() => w.core.save(result.capability)).toThrow(/fixture_fact_failure/); } finally { fail.mockRestore(); }
  const before = withDatabase(w.path, (db) => db.list("short_decisions")); expect(before).toHaveLength(4);
  const first = w.core.save(result.capability), retry = w.core.save(result.capability); expect(retry).toEqual(first);
  expect(withDatabase(w.path, (db) => db.list("short_decisions"))).toEqual(before);
  const facts = withDatabase(w.path, (db) => db.list(INTERACTION_CONTINUITY_NAMESPACE)); expect(facts).toHaveLength(1);
  expect(JSON.stringify(facts)).not.toContain("真实输入不应复制"); expect(JSON.stringify(facts)).not.toContain(w.loaded.body);
  expect(JSON.stringify(facts)).not.toContain("conclusion"); expect(JSON.stringify(facts)).not.toContain("scope");
});
test("M9：草稿按答复改写后重存，所涉段落已变或删除的待答问题作废，段落未变的问题照常待答", async () => {
  const w = await world(), c = w.loaded;
  const ask = (id: string) => w.core.ask(JSON.stringify({ basis: c.basis, candidate: c.candidate, partition: c.partition, unitIds: [id], actions: ["analyze"],
    proposal: { conclusion: `确认${id}`, scope: id, references: [], supersedes: [] } }));
  const a = ask("A"), b = ask("B");
  expect(w.context().questions.map((q) => q.requestId)).toEqual([a.requestId, b.requestId]);
  await w.resave();
  expect(w.context().questions.map((q) => q.requestId)).toEqual([a.requestId]);
  await w.resave("# B {#B}\nB修改后目标。\n");
  expect(w.context()).toMatchObject({ questions: [], effectiveQuestions: [] });
  expect(withDatabase(w.path, (db) => db.list("interaction_questions_v1"))).toHaveLength(2);
});
test("别的进程短暂占住数据库时，读取交互连续性等锁释放后照常完成，不立刻报数据库忙", async () => {
  const w = await world();
  const holder = execFile(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(w.path)});
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_probe (a);");
    process.stdout.write("held");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 500);`]);
  await new Promise((resolve) => holder.stdout!.once("data", resolve));
  const started = performance.now();
  expect(() => w.context()).not.toThrow();
  expect(performance.now() - started).toBeGreaterThan(300);
  await new Promise((resolve) => holder.once("exit", resolve));
});

const factIds = (w: Awaited<ReturnType<typeof world>>) => withDatabase(w.path, (db) => db.list(INTERACTION_CONTINUITY_NAMESPACE)).map((row) => row.id).sort();
test("M8N-AC1、AC4：同一段落后一次确认整体替换前一次：先目标后约束只认约束，以它为目标的动作被拒，引用被替换的旧确认也被拒", async () => {
  const w = await world();
  w.core.save((await w.interpret("A、B 都是目标")).capability);
  w.setOutput((ctx) => { const r = review(ctx); r.entries[1] = { ...r.entries[1]!, kind: "constraint", conclusion: "A作为约束" }; return r; });
  w.core.save((await w.interpret("A 只作约束")).capability);
  const [first, second] = factIds(w), ctx = w.context();
  expect(ctx.retainedEvidence!.filter((e) => e.unitId === "A").map((e) => [e.fact.id, e.kind])).toEqual([[second, "constraint"]]);
  expect(ctx.priorDecisions.map((d) => d.conclusion).sort()).toEqual(["A作为约束", "B目标"]);
  const targetA = (factId: string) => w.setOutput((c) => {
    const r = review(c); r.entries.splice(1, 1);
    r.documentReview!.units[1] = { ...r.documentReview!.units[1]!, conclusionIndexes: [], retainedFactIds: [factId] };
    r.documentReview!.units[2]!.conclusionIndexes = [1];
    r.documentReview!.actions = [{ action: "analyze", goalIds: ["A"], constraintIds: [], conclusionIndexes: [2], unknown: false }]; return r;
  });
  targetA(second!);
  await expect(w.interpret("分析A")).rejects.toMatchObject({ code: "goal_not_explicit" });
  targetA(first!);
  await expect(w.interpret("按最早那次分析A")).rejects.toMatchObject({ code: "retained_source_missing" });
});
test("M8N-AC1：同一段落先被排除、后被确认为目标，此后只按目标沿用", async () => {
  const w = await world();
  w.setOutput((ctx) => {
    const r = review(ctx); r.entries[2] = { ...r.entries[2]!, kind: "exclusion", conclusion: "B不做" };
    r.documentReview!.units[2]!.disposition = "excluded";
    r.documentReview!.actions = [{ action: "analyze", goalIds: ["A"], constraintIds: [], conclusionIndexes: [3], unknown: false }]; return r;
  });
  w.core.save((await w.interpret("B 不做，分析A")).capability);
  w.setOutput((ctx) => review(ctx));
  w.core.save((await w.interpret("B 还是要做")).capability);
  const [, second] = factIds(w);
  expect(w.context().retainedEvidence!.filter((e) => e.unitId === "B").map((e) => [e.fact.id, e.kind])).toEqual([[second, "target"]]);
  w.setOutput((c) => {
    const r = review(c); r.entries.splice(2, 1);
    r.documentReview!.units[2] = { ...r.documentReview!.units[2]!, conclusionIndexes: [], retainedFactIds: [second!] };
    r.documentReview!.actions = [{ action: "analyze", goalIds: ["B"], constraintIds: [], conclusionIndexes: [2], unknown: false }]; return r;
  });
  await expect(w.interpret("按上次说的分析B")).resolves.toBeDefined();
});
const SECTIONS = Array.from({ length: 25 }, (_, i) => `# S${i} {#s${i}}\nS${i}目标。\n`).join("");
function reviewAll(ctx: InteractionContext): InteractionInterpretation {
  const units = ctx.document!.partition.units, candidateId = ctx.document!.candidate.candidateId;
  const e = (kind: "constraint" | "target" | "action", conclusion: string) => ({ kind, conclusion, scope: "当前明确范围", basis: "explicit" as const, resolution: "direct" as const,
    candidateId, requestId: null, actions: kind === "action" ? ["analyze" as const] : [], references: [], supersedes: [] });
  const groups = Math.ceil((units.length - 1) / 5);
  const entries = [e("constraint", "文档身份"), ...Array.from({ length: groups }, (_, g) => e("target", `第${g}组目标`)), e("action", "分析第0组")];
  return { format: "interaction-interpretation/v1", referenceResolution: "none", entries,
    documentReview: { faithful: true, units: units.map((u, i) => ({ id: u.id, disposition: "confirmed", globalConstraint: false, appliesTo: [], dependsOn: [],
      conclusionIndexes: [i === 0 ? 0 : 1 + Math.floor((i - 1) / 5)] })),
      actions: [{ action: "analyze", goalIds: units.slice(1, 6).map((u) => u.id), constraintIds: [], conclusionIndexes: [entries.length - 1], unknown: false }], questions: [] } };
}
test("M8N-AC2、AC3：25 段草稿连续批准 5 个版本、每版改一段且解读模型从不写取代，之后解读与批准都成功，旧依据与旧决定不随版本增长", async () => {
  const w = await world(SECTIONS);
  w.setOutput(reviewAll);
  const sizes: Array<{ priors: number; facts: number; decisions: number }> = [];
  for (let v = 0; v < 5; v++) {
    const result = await w.interpret(`批准第 ${v} 版`); w.core.save(result.capability);
    const approved = w.core.authorizeDocument(result.capability, w.loaded)!;
    const ctx = w.context();
    sizes.push({ priors: ctx.priorDecisions.length, facts: new Set(ctx.retainedEvidence!.map((e) => e.fact.id)).size,
      decisions: new Set(approved.manifest.units.flatMap((u) => u.decisionIds)).size });
    await w.resave(w.loaded.body.replace(`S${v}目标。`, `S${v}目标改过。`));
  }
  expect(new Set(sizes.map((s) => JSON.stringify(s))).size).toBe(1);
  w.setOutput((ctx) => {
    const units = ctx.document!.partition.units, candidateId = ctx.document!.candidate.candidateId;
    const offered = (id: string) => [...new Set(ctx.retainedEvidence!.filter((e) => e.unitId === id).map((e) => e.fact.id))];
    const changed = units.filter((u) => !offered(u.id).length).map((u) => u.id);
    const e = (kind: "target" | "action", conclusion: string) => ({ kind, conclusion, scope: "当前明确范围", basis: "explicit" as const, resolution: "direct" as const,
      candidateId, requestId: null, actions: kind === "action" ? ["analyze" as const] : [], references: [], supersedes: [] });
    return { format: "interaction-interpretation/v1", referenceResolution: "none", entries: [e("target", "改过的段落目标"), e("action", "分析改过的段落")],
      documentReview: { faithful: true, units: units.map((u) => ({ id: u.id, disposition: "confirmed" as const, globalConstraint: false, appliesTo: [], dependsOn: [],
        conclusionIndexes: changed.includes(u.id) ? [0] : [], ...(changed.includes(u.id) ? {} : { retainedFactIds: offered(u.id) }) })),
        actions: [{ action: "analyze", goalIds: changed, constraintIds: [], conclusionIndexes: [1], unknown: false }], questions: [] } };
  });
  const last = await w.interpret("其余段落照旧，批准这一版");
  w.core.save(last.capability);
  const manifest = w.core.authorizeDocument(last.capability, w.loaded)!.manifest;
  for (const unitId of new Set(manifest.retainedSources!.map((e) => e.unitId))) {
    expect(new Set(manifest.retainedSources!.filter((e) => e.unitId === unitId).map((e) => e.fact.id)).size).toBe(1);
  }
  expect(new Set(manifest.units.flatMap((u) => u.decisionIds)).size).toBeLessThanOrEqual(manifest.units.length);
}, 120_000);
test("M8N-AC4：段落的当前确认被取代、而取代它的那次没被接受时，不退回更早那次已被替换的确认", async () => {
  const w = await world();
  w.core.save((await w.interpret("A、B 都是目标")).capability);
  w.setOutput((ctx) => { const r = review(ctx); r.entries[1] = { ...r.entries[1]!, kind: "constraint", conclusion: "A作为约束" }; return r; });
  w.core.save((await w.interpret("A 只作约束")).capability);
  const constraintA = w.context().priorDecisions.find((d) => d.conclusion === "A作为约束")!;
  w.setOutput((ctx) => { const r = review(ctx); r.documentReview!.faithful = false; r.entries[1] = { ...r.entries[1]!, conclusion: "A重新定", supersedes: [constraintA.decisionId] }; return r; });
  w.core.save((await w.interpret("A 重新定，草稿还没改")).capability);
  const [first] = factIds(w);
  expect(w.context().retainedEvidence!.some((e) => e.unitId === "A" && e.fact.id === first)).toBe(false);
});
test("沿用的原依据很多时，按发给解释器的内容算 48K 上限：哈希不计入，60 段草稿改一段后照常解读并批准", async () => {
  const w = await world(Array.from({ length: 60 }, (_, i) => `# S${i} {#s${i}}\nS${i}目标。\n`).join(""));
  w.setOutput(reviewAll);
  const first = await w.interpret("批准第一版");
  w.core.save(first.capability); w.core.authorizeDocument(first.capability, w.loaded);
  await w.resave(w.loaded.body.replace("S0目标。", "S0目标改过。"));
  const continuity = w.context();
  const { questions, effectiveQuestions, retainedEvidence, continuityIssues, priorDecisions, revisionSources, inputProof } = continuity;
  const result = { questions, effectiveQuestions, retainedEvidence, continuityIssues, priorDecisions, revisionSources, inputProof };
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(49_152);
  expect(Buffer.byteLength(JSON.stringify(interpreterView(result)))).toBeLessThanOrEqual(49_152);
  w.setOutput(reviewAll);
  const last = await w.interpret("其余段落照旧，批准这一版");
  w.core.save(last.capability);
  expect(w.core.authorizeDocument(last.capability, w.loaded)).toBeTruthy();
}, 120_000);
