import { approvalDependencyClosure } from "../../src/modules/requirement/approval-manifest.ts";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ApprovalManifestStore } from "../../src/modules/requirement/approval-manifest-store.ts";
import { approvalManifestReference } from "../../src/modules/requirement/approval-manifest.ts";
import type { ApprovalManifest } from "../../src/modules/requirement/approval-manifest.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../../src/core/storage/database.ts";
import type { LocalDatabase } from "../../src/core/storage/database.ts";
import { HostAuthorizationManager } from "../../src/modules/requirement/host-authorization.ts";
import { PmIntakeService, pmUnderstandingHash } from "../../src/modules/pm/pm-intake-service.ts";
import type {
  MainIntakeCall,
  MainIntakeCallIdentity,
  PmSourceDirectoryHandle,
  PmSourceDirectoryMaterial,
  PmSourceDirectoryProvider,
  PmSourceDirectoryQuery,
  PmSubmissionHandle,
  PmSubmissionMaterial,
  PmSubmissionProvider,
  PmSubmissionQuery,
  PmIntakeServiceOptions,
} from "../../src/modules/pm/pm-intake-service.ts";
import { PmIntakeStore, intakeManifestDecisionIds } from "../../src/modules/pm/pm-intake-store.ts";
import { loadInteractionContinuity } from "../../src/modules/requirement/interaction-continuity.ts";
import type { IntakeBindingBasis } from "../../src/modules/pm/pm-intake-store.ts";
import type { IntakeSourceDirectory, PmUnderstanding } from "../../src/modules/pm/pm-intake-contracts.ts";
import type { PmLease } from "../../src/modules/requirement/requirement-contracts.ts";
import { RequirementService } from "../../src/modules/requirement/requirement-service.ts";
import { RequirementStateStore } from "../../src/modules/requirement/requirement-state.ts";
import { UserInteractionCore } from "../../src/modules/interaction/user-interaction.ts";
import type { InteractionContext } from "../../src/modules/requirement/user-interaction-format.ts";
import { decisionDigest } from "../../src/modules/requirement/short-decision-format.ts";
import { repositoryIdentity } from "../../src/core/storage/identity.ts";
import {
  addWorktree,
  createRepoFixture,
  GIT_ENV,
  removeRepoFixture,
  repoFixtureRootReceipt,
  worktreeFixtureRootReceipt,
} from "./repo-fixture.ts";
import type { RepoFixtureRootReceipt, WorktreeFixtureRootReceipt } from "./repo-fixture.ts";
import { temporaryRoot } from "./temporary-root.ts";

const exec = promisify(execFile);

// PM_FIXTURE_ROOT_RECEIPTS_START
export interface PmIntakeFixtureRootReceipt {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

// PM_FIXTURE_ROOT_RECEIPTS_END

export class FixtureSourceProvider implements PmSourceDirectoryProvider {
  readonly handles = new WeakMap<object, { query: Omit<PmSourceDirectoryQuery, "signal" | "binding">; scenarioIds: string[]; questionIds: string[] }>();
  live = true;
  scenarioIds = ["goal.login", "scenario.failure"];
  questionIds: string[] = [];
  loadHook?: () => void | Promise<void>;
  assertHook?: () => void;
  async loadCurrent(query: Readonly<PmSourceDirectoryQuery>): Promise<PmSourceDirectoryMaterial | null> {
    await this.loadHook?.();
    if (!this.live) return null;
    const handle: PmSourceDirectoryHandle = Object.freeze({ kind: "pm-source-directory-handle" });
    this.handles.set(handle, { query: { baseline: structuredClone(query.baseline), stableSectionIds: [...query.stableSectionIds],
      manifestUnitIds: [...query.manifestUnitIds], maxBytes: query.maxBytes }, scenarioIds: [...this.scenarioIds], questionIds: [...this.questionIds] });
    return { handle, scenarioIds: [...this.scenarioIds], questionIds: [...this.questionIds] };
  }
  assertCurrent(handle: PmSourceDirectoryHandle, query: Readonly<Omit<PmSourceDirectoryQuery, "signal">>): void {
    this.assertHook?.();
    const claim = this.handles.get(handle as object);
    const actual = { baseline: query.baseline, stableSectionIds: query.stableSectionIds,
      manifestUnitIds: query.manifestUnitIds, maxBytes: query.maxBytes };
    const bindingMatches = query.binding && Object.entries(claim?.query.baseline ?? {}).every(([key, value]) =>
      (query.binding as unknown as Record<string, unknown>)[key] === value);
    if (!this.live || !claim || !bindingMatches || decisionDigest(actual) !== decisionDigest(claim.query) ||
      decisionDigest(this.scenarioIds) !== decisionDigest(claim.scenarioIds) ||
      decisionDigest(this.questionIds) !== decisionDigest(claim.questionIds)) throw new Error("source_changed");
  }
}

export class FixtureSubmissionProvider implements PmSubmissionProvider {
  readonly handles = new WeakMap<object, { query: unknown; hash: string; ref: string; generation: object }>();
  live = true;
  loadHook?: () => void | Promise<void>;
  assertHook?: () => void;
  #generation: object = {};
  #currentHash: string | undefined;
  #mutate: ((understanding: PmUnderstanding) => void) | undefined;
  get mutate() { return this.#mutate; }
  set mutate(value: ((understanding: PmUnderstanding) => void) | undefined) { this.#mutate = value; this.#generation = {}; }
  async loadCurrent(query: Readonly<PmSubmissionQuery>): Promise<PmSubmissionMaterial | null> {
    await this.loadHook?.();
    if (!this.live) return null;
    const understanding: PmUnderstanding = {
      format: "pm-understanding/v1",
      binding: structuredClone(query.binding),
      goals: [
        { text: "实现手机号登录", sourceRefs: [{ kind: "prd-unit", id: "goal.login" }] },
        { text: "失败场景给出可观察结果", sourceRefs: [{ kind: "prd-scenario", id: "scenario.failure" }] },
      ],
      nonGoals: [],
      constraints: [{ text: "只按已批准范围工作", sourceRefs: [{ kind: "prd-unit", id: "metadata" }] }],
      allowedActions: [{ text: this.actionText, sourceRefs: [{ kind: "decision", id: this.actionDecisionId }] }],
      unresolved: [],
      scenarioCoverage: [
        { scenarioId: "goal.login", status: "covered", summary: "覆盖正常手机号登录", sourceRefs: [{ kind: "prd-scenario", id: "goal.login" }] },
        { scenarioId: "scenario.failure", status: "covered", summary: "覆盖验证码失败", sourceRefs: [{ kind: "prd-scenario", id: "scenario.failure" }] },
      ],
    };
    this.mutate?.(understanding);
    const submissionHash = pmUnderstandingHash(understanding), submissionRef = "pm/submission/current";
    if (submissionHash !== this.#currentHash) { this.#generation = {}; this.#currentHash = submissionHash; }
    const handle: PmSubmissionHandle = Object.freeze({ kind: "pm-submission-handle" });
    this.handles.set(handle, { query: { binding: structuredClone(query.binding), sourceDirectoryHash: query.sourceDirectoryHash, maxBytes: query.maxBytes },
      hash: submissionHash, ref: submissionRef, generation: this.#generation });
    return { handle, submissionRef, submissionHash, understanding };
  }
  constructor(readonly actionDecisionId: string, readonly actionText = "允许实施手机号目标") {}
  assertCurrent(handle: PmSubmissionHandle, query: Readonly<Omit<PmSubmissionQuery, "signal">>): void {
    this.assertHook?.();
    const claim = this.handles.get(handle as object);
    if (!this.live || !claim || claim.generation !== this.#generation || claim.hash !== this.#currentHash ||
      decisionDigest(claim.query) !== decisionDigest(query)) throw new Error("submission_changed");
  }
}

export interface PmIntakeFixture {
  root: string;
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  requirementId: string;
  service: RequirementService;
  state: RequirementStateStore;
  host: HostAuthorizationManager;
  intakeStore: PmIntakeStore;
  intake: PmIntakeService;
  sourceProvider: FixtureSourceProvider;
  submissionProvider: FixtureSubmissionProvider;
  call: MainIntakeCall;
  identity: MainIntakeCallIdentity;
  lease: PmLease;
  manifest: ApprovalManifest;
  basis: IntakeBindingBasis;
  sourceDirectory: IntakeSourceDirectory;
  operationId(): string;
  db<T>(run: (db: LocalDatabase) => T): T;
  newCall(patch?: Partial<MainIntakeCallIdentity>): MainIntakeCall;
  makeIntake(options?: Partial<Pick<PmIntakeServiceOptions, "requirementService" | "now" | "sourceDirectoryProvider" | "submissionProvider">>): PmIntakeService;
  captureCurrent(): ReturnType<PmIntakeStore["captureCurrent"]>;
  /** 按真实交互与清单登记流程批准一个新版本；units 覆盖各章节的全局约束、依赖与待定，实施动作列出实施目标板块下全部已确认的段落。 */
  approveRevision(input: { body: string; units?: Record<string, { globalConstraint?: boolean; appliesTo?: string[]; dependsOn?: string[];
    disposition?: "pending-description" }> }): Promise<void>;
  setNow(value: number): void;
  advanceNow(value: number): void;
  cleanup(): Promise<void>;
}

// PM_FIXTURE_FACTORY_START
export async function createPmIntakeFixture(options: { retained?: boolean; body?: string } = {}): Promise<PmIntakeFixture> {
  const allocation: {
    pmPath?: string;
    pmReceipt?: PmIntakeFixtureRootReceipt;
    repoReceipt?: RepoFixtureRootReceipt;
    worktreeReceipt?: WorktreeFixtureRootReceipt;
  } = {};
  let allocatedCore: UserInteractionCore | undefined, allocatedHost: HostAuthorizationManager | undefined;
  try {
  const root = await mkdtemp(join(temporaryRoot(), "pm-intake-"));
  allocation.pmPath = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`PM 测试环境根不是自产真实目录；保全路径 ${root}`);
  }
  allocation.pmReceipt = Object.freeze({ path: root, dev: rootInfo.dev, ino: rootInfo.ino });
  const repo = await createRepoFixture();
  const repoReceipt = repoFixtureRootReceipt(repo);
  if (!repoReceipt) throw new Error("PM 测试环境未取得原repo根收据");
  allocation.repoReceipt = Object.freeze({ path: repoReceipt.path, dev: repoReceipt.dev, ino: repoReceipt.ino });
  if (repo.root !== repoReceipt.path) throw new Error("PM 测试环境repo公开根与原收据不一致");
  const dataRoot = join(root, "data"), identity = await repositoryIdentity(repo.root);
  let now = Date.now();
  const config = { repositoryRoot: repo.root, dataRoot, repoId: identity.repoId };
  const service = await RequirementService.open({ ...config, authorize: () => true });
  const state = await RequirementStateStore.open({ ...config, authorize: () => true, now: () => now });
  const title = "PM接手", body = options.body ?? "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n";
  let saved = await service.create({ requestId: uuidv7(), operationId: uuidv7(), title, body });
  const worktree = await addWorktree(repo);
  const worktreeReceipt = worktreeFixtureRootReceipt(worktree);
  if (!worktreeReceipt) throw new Error("PM 测试环境未取得原worktree根收据");
  allocation.worktreeReceipt = Object.freeze({ path: worktreeReceipt.path, dev: worktreeReceipt.dev, ino: worktreeReceipt.ino });
  if (worktree.root !== worktreeReceipt.path) throw new Error("PM 测试环境worktree公开根与原收据不一致");
  const baseCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree.root, env: GIT_ENV })).stdout.trim();
  await state.bindWorkspace({ requirementId: saved.requirementId, version: state.read(saved.requirementId).version,
    path: worktree.root, prepareOperationId: uuidv7(), baseCommit });
  let confirmOperationId = uuidv7(), useRetained = false;
  let revisionPlan: { units: Record<string, { globalConstraint?: boolean; appliesTo?: string[]; dependsOn?: string[]; disposition?: "pending-description" }> } | undefined;
  // 样例需求正文用 goal 与 scenario 两个板块，批准并授权实施时这两个板块下已确认的段落都是实施目标
  const docSpec = { skillHash: `sha256:${"f".repeat(64)}`, sections: [{ id: "goal", title: "目标", goal: true as const },
    { id: "scenario", title: "场景", goal: true as const }, { id: "implementation", title: "实现", record: "implementation" as const },
    { id: "acceptance", title: "验收", record: "acceptance" as const }] };
  const goalSections = docSpec.sections.filter((section) => "goal" in section).map((section) => section.id);
  const load = () => service.loadConfirmationContext({ requirementId: saved.requirementId, savedOperationId: saved.operationId, operationId: confirmOperationId });
  let context = await load();
  const core = await UserInteractionCore.open({ ...config, now: () => now, authorize: () => true, authorizeAction: () => true,
    loadContext: async () => {
      context = await load();
      const document = { candidate: context.candidate, title: context.title, body: context.body, partition: context.partition };
      const result: InteractionContext = { basis: context.basis, currentGoal: "", candidates: [{ ...context.candidate, diff: context.difference.text || "无差异" }],
        document, savedOperationId: context.savedOperationId, ...loadInteractionContinuity(dataRoot, identity.repoId, context.basis, document) };
      return result;
    },
    interpreter: {
      identity: () => ({ provider: "fixture", id: "pm-intake", configurationHash: "a".repeat(64) }),
      interpret: async ({ context: current }) => {
        const candidateId = current.document!.candidate.candidateId;
        const common = { basis: "explicit", resolution: "direct", candidateId, requestId: null, actions: [], references: [], supersedes: [], scope: "批准手机号接手范围" };
        if (revisionPlan) {
          const plan = revisionPlan;
          const units = current.document!.partition.units.map((unit) => unit.id);
          const pending = (unitId: string) => plan.units[unitId]?.disposition === "pending-description";
          const entries = units.map((unitId) => pending(unitId) ? { ...common, kind: "unresolved", basis: "uncertain", resolution: "defer", conclusion: `待定章节 ${unitId}` }
            : { ...common, kind: unitId === "metadata" || plan.units[unitId]?.globalConstraint ? "constraint" : "target", conclusion: `确认章节 ${unitId}` });
          entries.push({ ...common, kind: "action", actions: ["implement"], conclusion: "允许实施本次目标" } as never);
          const goalIds = units.filter((unitId) => !pending(unitId) && goalSections.some((goal) => unitId === goal || unitId.startsWith(`${goal}.`)));
          return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries, documentReview: { faithful: true,
            units: units.map((unitId, index) => ({ id: unitId, disposition: pending(unitId) ? "pending-description" : "confirmed", globalConstraint: plan.units[unitId]?.globalConstraint ?? false,
              appliesTo: plan.units[unitId]?.appliesTo ?? [], dependsOn: plan.units[unitId]?.dependsOn ?? [], conclusionIndexes: [index] })),
            actions: [{ action: "implement", goalIds, conclusionIndexes: [units.length], unknown: false,
              constraintIds: approvalDependencyClosure(units.map((unitId) => ({ id: unitId, dependsOn: plan.units[unitId]?.dependsOn ?? [],
                globalConstraint: plan.units[unitId]?.globalConstraint ?? false, appliesTo: plan.units[unitId]?.appliesTo ?? [] })), goalIds)
                .filter((unitId) => !goalIds.includes(unitId)) }], questions: [] } });
        }
        if (useRetained) {
          const evidence = current.retainedEvidence?.find((entry) => entry.unitId === "goal.login");
          if (!evidence) throw new Error("fixture retained goal unavailable");
          return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
            { ...common, kind: "constraint", conclusion: "需求身份元数据" },
            { ...common, kind: "target", conclusion: "错误验证码失败时提示重试" },
            { ...common, kind: "action", actions: ["implement"], conclusion: "允许实施手机号目标" },
          ], documentReview: { faithful: true,
            units: current.document!.partition.units.map((unit) => ({ id: unit.id, disposition: "confirmed", globalConstraint: false,
              appliesTo: [], dependsOn: [], conclusionIndexes: unit.id === "goal.login" ? [] : [unit.id === "metadata" ? 0 : 1],
              ...(unit.id === "goal.login" ? { retainedFactIds: [evidence.fact.id] } : {}) })),
            actions: [{ action: "implement", goalIds: ["goal.login", "scenario.failure"], constraintIds: [], conclusionIndexes: [2], unknown: false }], questions: [] } });
        }
        return JSON.stringify({ format: "interaction-interpretation/v1", referenceResolution: "none", entries: [
          { ...common, kind: "constraint", conclusion: "需求身份元数据" },
          { ...common, kind: "target", conclusion: "手机号正常登录" },
          { ...common, kind: "target", conclusion: "验证码失败有可观察结果" },
          { ...common, kind: "action", actions: ["implement"], conclusion: "允许实施手机号登录" },
        ], documentReview: { faithful: true,
          units: current.document!.partition.units.map((unit) => ({ id: unit.id, disposition: "confirmed", globalConstraint: false,
            appliesTo: [], dependsOn: [], conclusionIndexes: [unit.id === "goal.login" ? 1 : unit.id === "scenario.failure" ? 2 : 0] })),
          actions: [{ action: "implement", goalIds: ["goal.login", "scenario.failure"], constraintIds: [], conclusionIndexes: [3], unknown: false }],
          questions: [] } });
      },
    } });
  allocatedCore = core;
  core.startSession({ sessionId: "fixture-core", windowId: "fixture-core" });
  const ticket = core.captureInput({ source: "interactive", text: "批准手机号正常和失败场景，并允许实施。" }, "fixture-core");
  let interpreted = await core.interpret(ticket, saved.requirementId);
  let decisions = core.save(interpreted.capability);
  if (options.retained) {
    saved = await service.updateDraft({ requirementId: saved.requirementId, version: state.read(saved.requirementId).version,
      operationId: uuidv7(), title, body: body.replace("错误验证码显示失败。", "错误验证码显示失败并提示重试。") });
    confirmOperationId = uuidv7(); context = await load(); useRetained = true;
    interpreted = await core.interpret(core.captureInput({ source: "interactive", text: "确认需求身份；正常登录保留，修改验证码失败提示并允许实施。" }, "fixture-core"), saved.requirementId);
    decisions = core.save(interpreted.capability);
  }
  const document = () => core.authorizeDocument(interpreted.capability, { basis: context.basis, candidate: context.candidate });
  const authorized = document();
  if (!authorized) throw new Error("fixture approval unavailable");
  const manifestStore = new ApprovalManifestStore({ ...config, authorize: () => true,
    loadExpected: async () => { const current = await load(); return { requirementId: current.requirementId, candidate: current.candidate, partition: current.partition }; },
    admit: (request) => {
      const current = document();
      return current && decisionDigest(approvalManifestReference(current.manifest)) === decisionDigest(request.reference)
        ? { receiptId: current.authorization.receiptId, version: current.authorization.basis.version,
          epoch: current.authorization.basis.epoch, inputProof: current.authorization.inputProof } : null;
    } });
  await manifestStore.register(authorized.manifest);
  const approver = await RequirementService.open({ ...config, authorize: () => true, authorizeManifest: (request) => {
    const current = document();
    return Boolean(current && request.receiptId === current.authorization.receiptId &&
      decisionDigest(request.manifest) === decisionDigest(approvalManifestReference(current.manifest)));
  } });
  const approved = await approver.confirmUpdate({ requirementId: saved.requirementId, operationId: confirmOperationId, version: context.version,
    title: context.title, body: context.body, receiptId: authorized.authorization.receiptId, manifest: approvalManifestReference(authorized.manifest), docSpec });
  const lease = await state.acquirePm({ requirementId: saved.requirementId, version: approved.version, runId: uuidv7(), expectedFence: 0 });

  const sessionId = uuidv7(), windowId = uuidv7();
  const host = new HostAuthorizationManager({ dataRoot });
  allocatedHost = host;
  host.startWindow({ kind: "main", windowId, sessionId, repoIds: [identity.repoId] });
  const calls = new WeakMap<object, MainIntakeCallIdentity>();
  const newCall = (patch: Partial<MainIntakeCallIdentity> = {}) => {
    const call: MainIntakeCall = Object.freeze({ kind: "main-intake-call" });
    calls.set(call, { repoId: identity.repoId, requirementId: saved.requirementId, windowId, sessionId, toolCallId: uuidv7(), ...patch });
    return call;
  };
  const call = newCall();
  const callIdentity = calls.get(call)!;
  const sourceProvider = new FixtureSourceProvider();
  const actionDecisionId = authorized.manifest.actions[0]!.decisionIds.find((id) => decisions.decisionIds.includes(id))!;
  const submissionProvider = new FixtureSubmissionProvider(actionDecisionId, "允许实施手机号目标");
  // 自定义正文多出的章节同样要在 PM 理解里标为已覆盖，接手核对才会通过
  const extraSections = [...body.matchAll(/\{#([^{}]+)\}/g)].map((match) => match[1]!).filter((id) => id !== "goal.login" && id !== "scenario.failure");
  if (extraSections.length) submissionProvider.mutate = (understanding) => {
    understanding.scenarioCoverage.push(...extraSections.map((id) => ({ scenarioId: id, status: "covered" as const, summary: `覆盖 ${id}`, sourceRefs: [{ kind: "prd-scenario" as const, id }] })));
  };
  const intakeStore = new PmIntakeStore({ dataRoot, repoId: identity.repoId, now: () => now });
  const resolver = { resolve: (candidate: MainIntakeCall) => calls.get(candidate as object) ?? null };
  const makeIntake = (options: Partial<Pick<PmIntakeServiceOptions, "requirementService" | "now" | "sourceDirectoryProvider" | "submissionProvider">> = {}) =>
    new PmIntakeService({ dataRoot, repoId: identity.repoId, state, requirementService: options.requirementService ?? approver,
      authorization: host, mainCallResolver: resolver, sourceDirectoryProvider: options.sourceDirectoryProvider ?? sourceProvider,
      submissionProvider: options.submissionProvider ?? submissionProvider, now: options.now ?? (() => now) });
  const intake = makeIntake(), active = state.read(saved.requirementId);
  if (!active.data.approved || !active.data.workspace) throw new Error("fixture active baseline unavailable");
  const basis: IntakeBindingBasis = { repoId: identity.repoId, requirementId: saved.requirementId,
    approvedPrdCommit: active.data.approved.commit, approvedRevision: active.data.revision, approvedPrdHash: active.data.approved.hash,
    approvalManifestHash: authorized.manifest.manifestHash, workspaceId: lease.workspaceId, workspaceRef: active.data.workspace.branch,
    epoch: lease.epoch, pmRunId: lease.runId, pmFence: lease.fence, contextGeneration: lease.contextGeneration };
  const sourceDirectory: IntakeSourceDirectory = { prdUnitIds: authorized.manifest.units.map((unit) => unit.id),
    prdScenarioIds: [...sourceProvider.scenarioIds],
    decisionIds: intakeManifestDecisionIds(authorized.manifest), questionIds: [], requiredScenarioIds: [...sourceProvider.scenarioIds] };
  const dbPath = repositoryDatabase(dataRoot, identity.repoId);
  if (!allocation.pmReceipt || !allocation.repoReceipt || !allocation.worktreeReceipt) {
    throw new Error("PM 测试环境三根原收据不完整");
  }
  const fixture: PmIntakeFixture = {
    root, repositoryRoot: repo.root, dataRoot, repoId: identity.repoId, requirementId: saved.requirementId, service: approver, state, host, intakeStore, intake,
    sourceProvider, submissionProvider, call, identity: callIdentity, lease, manifest: authorized.manifest, basis, sourceDirectory,
    operationId: uuidv7, db: <T>(run: (db: LocalDatabase) => T) => withDatabase(dbPath, run), newCall, makeIntake,
    captureCurrent: () => intakeStore.captureCurrent(basis, sourceDirectory),
    async approveRevision(input) {
      saved = await service.updateDraft({ requirementId: saved.requirementId, version: state.read(saved.requirementId).version,
        operationId: uuidv7(), title, body: input.body });
      confirmOperationId = uuidv7(); context = await load();
      revisionPlan = { units: input.units ?? {} };
      try {
        interpreted = await core.interpret(core.captureInput({ source: "interactive", text: "确认本次修改并允许实施。" }, "fixture-core"), saved.requirementId);
        decisions = core.save(interpreted.capability);
      } finally { revisionPlan = undefined; }
      const current = document();
      if (!current) throw new Error("fixture revision approval unavailable");
      await manifestStore.register(current.manifest);
      await approver.confirmUpdate({ requirementId: saved.requirementId, operationId: confirmOperationId, version: context.version,
        title: context.title, body: context.body, receiptId: current.authorization.receiptId, manifest: approvalManifestReference(current.manifest) });
    },
    setNow(value: number) { now = value; },
    advanceNow(value: number) { now += value; },
    async cleanup() {
      host.shutdown();
      core.shutdown();
      await removeRepoFixture(repo);
      await rm(root, { recursive: true, force: true });
    },
  };
  return fixture;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { allocatedHost?.shutdown(); } catch (failure) { cleanupErrors.push(failure); }
    try { allocatedCore?.shutdown(); } catch (failure) { cleanupErrors.push(failure); }
    // 未交回完整句柄时只停止已知内存资源；Git子进程结束未核实，不删除已分配根。
    console.error(JSON.stringify({ status: "pm_intake_fixture_setup_preserved", fixtureRoot: allocation.pmPath ?? null,
      repoRoot: allocation.repoReceipt?.path ?? null, worktreeRoot: allocation.worktreeReceipt?.path ?? null,
      processCleanup: "unconfirmed", memoryCleanupFailed: cleanupErrors.length > 0 }));
    const paths = [allocation.pmPath, allocation.repoReceipt?.path, allocation.worktreeReceipt?.path].filter((path): path is string => Boolean(path));
    throw new AggregateError([error, ...cleanupErrors], `PM 测试环境初始化失败${paths.length ? `；保全自有根 ${paths.join(" / ")}` : "；未取得分配路径"}`);
  }
}
// PM_FIXTURE_FACTORY_END
