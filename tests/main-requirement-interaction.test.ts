import { afterEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRegistry, ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { scriptReview } from "./helpers/interpreter-reply.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { UUID_V7_PATTERN, uuidv7, repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import { HostAuthorizationError, HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import { MainRequirementInteraction } from "../src/modules/interaction/main-requirement-interaction.ts";
import { UserInteractionCore } from "../src/modules/interaction/user-interaction.ts";
import { RequirementOperations } from "../src/modules/requirement/requirement-operations.ts";
import { prdRequirementPath } from "../src/modules/requirement/prd-storage.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "../src/modules/requirement/requirement-coordination.ts";
import type { MainRequirementInteractionOptions } from "../src/modules/interaction/main-requirement-interaction.ts";
import { createRequirementManageTool } from "../src/modules/interaction/requirement-manage-tool.ts";
import { createUserInteractTool } from "../src/modules/interaction/user-interact-tool.ts";
import { RequirementService, requirementIntentHash } from "../src/modules/requirement/requirement-service.ts";
import { adviceOf } from "../src/core/exec/tool-failure.ts";
import { RequirementServiceError } from "../src/modules/requirement/requirement-manage-contracts.ts";
import { RequirementStateStore } from "../src/modules/requirement/requirement-state.ts";
import { resolveRepositoryRequirementDoc } from "../src/modules/requirement/requirement-doc.ts";
import type { ConfirmationContext } from "../src/modules/requirement/requirement-manage-contracts.ts";
import type { Static } from "typebox";
import { ModelInterpretation } from "../src/modules/interaction/interaction-derivation.ts";
import { requirementSummary } from "../src/modules/requirement/requirement-summary.ts";
import { beginDesign, decidePrototype, pendingConfirmation, prototypeFilePath, readPrototypeBoard, removeFromDraft, submitDesign } from "../src/modules/requirement/requirement-prototypes.ts";
import { prototypesAtRevision } from "../src/modules/requirement/requirement-prototype-revisions.ts";
import { answeringUi } from "./helpers/window-host.ts";
import type { ShownWindow, WindowDecision } from "./helpers/window-host.ts";


const exec = promisify(execFile), cleanup: Array<() => Promise<void>> = [];
const PHONE = "我想加手机号登录，原来的邮箱登录保留。微信登录以后可能也要，但这次先不做。短信多久过期你参考常见做法。先帮我看看涉及哪些改动。";
const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n登录需求如下。\n### 手机号与邮箱 {#A}\n增加手机号登录，保留邮箱登录。\n" +
  "### 短信方案委托 {#D}\n短信期限参考常见做法提出方案。\n### 短信期限 {#SMS}\n具体数值未决。\n### 微信 {#B}\n本次排除微信登录。\n" +
  "## 功能 {#features}\n用手机号和验证码登录。\n## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n手机号能登录，邮箱仍能登录。\n";
const FRAME = ["metadata", "background", "requirements", "features", "implementation", "acceptance"];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function git(cwd: string, args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }
async function world(options: Pick<MainRequirementInteractionOptions, "now" | "mainThinking"> = {}) {
  const root = await mkdtemp(join(temporaryRoot(), "host-interaction-")), repositoryRoot = join(root, "repo"), dataRoot = join(root, "data");
  await mkdir(repositoryRoot); await mkdir(dataRoot); await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFile(join(repositoryRoot, "README.md"), "fixture\n"); await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "init"]);
  const { repoId } = await repositoryIdentity(repositoryRoot), sessionId = uuidv7(), windowId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot }); authorization.startWindow({ kind: "main", windowId, sessionId, repoIds: [repoId] });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: `host-${uuidv7()}`, modelId: "controlled" });
  const registry = new ModelRegistry(runtime), model = runtime.getModels(provider.providerId)[0]!;
  const notifications: string[] = [], windows: ShownWindow[] = [];
  let windowAnswer: WindowDecision = true, beforeAnswer: (() => Promise<void>) | undefined;
  const ctx = { cwd: repositoryRoot, mode: "tui", hasUI: true, isProjectTrusted: () => false, modelRegistry: registry, model,
    ui: { notify: (text: string) => notifications.push(text), confirm: () => { throw new Error("UI.confirm forbidden"); },
      ...answeringUi(async (window) => { windows.push(window); await beforeAnswer?.(); return windowAnswer; }) },
    sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  let reachable = true, hostPath = repositoryRoot;
  const interaction = new MainRequirementInteraction({ mainThinking: () => "off", ...options, dataRoot, authorization,
    resolveHost: () => { if (!reachable) throw new HostAuthorizationError("host_unavailable"); return { windowId, sessionId, repositories: new Map([[repoId, { path: hostPath }]]) }; } });
  cleanup.push(async () => { interaction.dispose(); authorization.shutdown(); await rm(root, { recursive: true, force: true }); });
  const manage = createRequirementManageTool({ interaction }), user = createUserInteractTool({ interaction });
  const call = async (params: Record<string, unknown>, userTool = false) => {
    const toolCallId = uuidv7();
    const result = await (userTool ? user : manage).execute(toolCallId, { request: { repoId, ...params } } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx); return result.details!;
  };
  const mentioned: string[] = [];
  /** 模拟用户这句话 @ 了已建的需求；mention=false 时原样输入。 */
  const capture = (text = PHONE, source = "interactive", mention = true) =>
    interaction.captureInput({ source, text: (mention ? mentioned.map((id) => `@[登录#${id.slice(-4)}] `).join("") : "") + text }, ctx);
  const service = await RequirementService.open({ dataRoot, repositoryRoot, repoId, authorize: () => true });
  const create = async (body = BODY) => {
    capture(); scriptReplies(provider, [{ type: "text", text: '{"allow":true}' }]);
    const created = await call({ action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body });
    mentioned.push(String(created.requirementId));
    return created;
  };
  const request = async (created: Record<string, unknown>) =>
    ({ input: { requirementId: String(created.requirementId), savedOperationId: String(created.operationId), version: Number(created.version) } });
  const setReachable = (value: boolean) => { reachable = value; };
  const setHostPath = (value: string) => { hostPath = value; };
  return { root, repositoryRoot, dataRoot, repoId, sessionId, authorization, ctx, interaction, provider, call, capture, create, request, service, notifications, manage, setReachable, setHostPath,
    windows, answerWindows: (answer: WindowDecision) => { windowAnswer = answer; }, beforeAnswer: (hook: () => Promise<void>) => { beforeAnswer = hook; } };
}
/** 明确fixture语义输出；调用仍经过真实ModelRegistry/provider与生产解释适配器。 */
function phoneReview(c: Pick<ConfirmationContext, "candidate" | "partition">, action: "analyze" | "implement" = "analyze"): Static<typeof ModelInterpretation> {
  const entry = (kind: "constraint" | "target" | "delegation" | "future" | "unresolved" | "exclusion" | "action", conclusion: string, basis: "explicit" | "uncertain" = "explicit") => ({
    kind, conclusion, scope: kind === "action" ? (action === "analyze" ? "只分析，不修改代码" : "实施手机号登录，保留邮箱，不做微信") : "当前登录需求", basis,
    resolution: "direct" as const, candidateId: c.candidate.candidateId, requestId: null, actions: kind === "action" ? [action] : [], references: [], supersedes: [] });
  const ids = new Set(c.partition.units.map((unit) => unit.id));
  const unit = (...wanted: string[]) => wanted.filter((id) => ids.has(id));
  return { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: true, entries: [{ ...entry("constraint", "需求身份、标题与格式板块"), unitIds: unit(...FRAME) },
    { ...entry("target", "增加手机号登录并保留邮箱登录"), unitIds: unit("A") }, { ...entry("delegation", "短信期限委托参考常见做法提出方案"), unitIds: unit("D") },
    { ...entry("unresolved", "短信期限待提出方案", "uncertain"), unitIds: unit("SMS") }, { ...entry("exclusion", "本次排除微信登录"), unitIds: unit("B") },
    { ...entry("action", "本轮授权动作"), unitIds: ["A"] }, { ...entry("future", "微信仅为未来想法", "uncertain"), candidateId: null }] };
}

const modifyReview = (c: Pick<ConfirmationContext, "candidate" | "partition">) => {
  const review = phoneReview(c);
  review.faithful = false; review.entries[1]!.resolution = "modify"; review.entries.splice(5, 1);
  return review;
};

/** 任意正文的整份确认：targetId 是目标，其余单位按格式与约束确认，授权只分析。 */
function wholeReview(c: Pick<ConfirmationContext, "candidate" | "partition">, targetId = "A"): Static<typeof ModelInterpretation> {
  const base = (kind: "constraint" | "target" | "action", conclusion: string, unitIds: string[]) => ({ kind, conclusion, scope: kind === "action" ? "只分析，不修改代码" : "当前登录需求",
    basis: "explicit" as const, resolution: "direct" as const, candidateId: c.candidate.candidateId, requestId: null, actions: kind === "action" ? ["analyze" as const] : [], references: [], supersedes: [], unitIds });
  const others = c.partition.units.map((unit) => unit.id).filter((id) => id !== targetId);
  return { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: true,
    entries: [base("constraint", "需求身份、标题与格式板块", others), base("target", "增加手机号登录", [targetId]), base("action", "本轮授权动作", [targetId])] };
}

describe("主窗口共享控制器的真实服务路径", () => {
  test("M8D-AC3：这句话 @ 到的需求直接按原话登记，不弹窗；没 @ 到时弹出批准窗口，显示需求名、版本与简介，取消即不登记不生效", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    w.capture("同意", "interactive", false); w.answerWindows(false);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "decision_declined" });
    expect(w.windows).toHaveLength(1);
    expect(w.windows[0]!.title).toBe("批准需求");
    expect(w.windows[0]!.text).toContain("需求：登录（第 1 版）");
    expect(w.windows[0]!.text).toContain(`编号：${input.requirementId}`);
    expect(w.windows[0]!.text).toContain("简介：手机号登录，保留邮箱登录");
    expect(state.read(input.requirementId).data.lifecycle).toBe("draft");
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ targetRecorded: true, prdActivated: true });
    expect(w.windows).toHaveLength(1);
  });

  test("解释器按用户层设定的思考等级调用；草稿核验器设定的模型不存在时写明原因，不改用主窗口的模型", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    await writeFile(join(w.root, "settings.json"), JSON.stringify({ "one-company": { interpreter: { model: `${w.provider.providerId}/${w.provider.modelId}`, thinking: "low" } } }));
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    const before = w.provider.reasoning.length;
    await w.call({ action: "confirmUpdate", ...input });
    expect(w.provider.reasoning.slice(before)).toEqual(["low"]);
    await writeFile(join(w.root, "settings.json"), JSON.stringify({ "one-company": { "draft-verifier": { model: "nowhere/missing", thinking: null } } }));
    w.capture("再建一个需求"); const calls = w.provider.requests.length;
    await expect(w.call({ action: "create", summary: "简介", title: "另一个", body: BODY }))
      .rejects.toMatchObject({ code: "internal_model_unavailable", message: expect.stringContaining("草稿核验器配置的模型 nowhere/missing 不可用：本机的模型配置里找不到模型 nowhere/missing") });
    expect(w.provider.requests.length).toBe(calls);
  });

  describe.each([
    ["父目录信任、仓库不信任", true, false, "controlled"],
    ["父目录不信任、仓库信任", false, true, "gpt-6.1-sol"],
  ])("按 trust.json 里离仓库最近的一条判断项目层（%s）", (_label, parentTrusted, repositoryTrusted, expectedModel) => {
    const prepare = async (key: "interpreter" | "draft-verifier") => {
      const w = await world();
      vi.stubEnv("PI_CODING_AGENT_DIR", w.root);
      cleanup.push(async () => { vi.unstubAllEnvs(); });
      await writeFile(join(w.root, "settings.json"), JSON.stringify({ "one-company": { [key]: { model: `${w.provider.providerId}/controlled`, thinking: null } } }));
      await mkdir(join(w.repositoryRoot, ".pi"), { recursive: true });
      await writeFile(join(w.repositoryRoot, ".pi", "settings.json"), JSON.stringify({ "one-company": { [key]: { model: `${w.provider.providerId}/gpt-6.1-sol`, thinking: null } } }));
      const store = new ProjectTrustStore(w.root);
      store.set(w.root, parentTrusted); store.set(w.repositoryRoot, repositoryTrusted);
      (w.ctx as { isProjectTrusted: () => boolean }).isProjectTrusted = () => !repositoryTrusted;
      return w;
    };

    test("解释器", async () => {
      const w = await prepare("interpreter"), created = await w.create(), { input } = await w.request(created);
      w.capture("同意"); scriptReview(w.provider, phoneReview);
      const before = w.provider.models.length;
      await w.call({ action: "confirmUpdate", ...input });
      expect(w.provider.models.slice(before)).toEqual([expectedModel]);
    });

    test("草稿核验器", async () => {
      const w = await prepare("draft-verifier");
      w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      const before = w.provider.models.length;
      await w.call({ action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY });
      expect(w.provider.models.slice(before)).toEqual([expectedModel]);
    });
  });

  describe.each([
    ["主仓库信任、worktree 不信任", true, false, "gpt-6.1-sol"],
    ["主仓库不信任、worktree 信任", false, true, "controlled"],
  ])("在 linked worktree 里打开 pi，项目层按主仓库目录判断（%s）", (_label, mainTrusted, worktreeTrusted, expectedModel) => {
    const prepare = async (key: "interpreter" | "draft-verifier") => {
      const w = await world();
      vi.stubEnv("PI_CODING_AGENT_DIR", w.root);
      cleanup.push(async () => { vi.unstubAllEnvs(); });
      const worktree = join(w.root, "wt");
      await git(w.repositoryRoot, ["worktree", "add", "-q", worktree]);
      await writeFile(join(w.root, "settings.json"), JSON.stringify({ "one-company": { [key]: { model: `${w.provider.providerId}/controlled`, thinking: null } } }));
      await mkdir(join(w.repositoryRoot, ".pi"), { recursive: true });
      await writeFile(join(w.repositoryRoot, ".pi", "settings.json"), JSON.stringify({ "one-company": { [key]: { model: `${w.provider.providerId}/gpt-6.1-sol`, thinking: null } } }));
      const store = new ProjectTrustStore(w.root);
      store.set(w.repositoryRoot, mainTrusted); store.set(worktree, worktreeTrusted);
      (w.ctx as { cwd: string }).cwd = worktree; w.setHostPath(worktree);
      (w.ctx as { isProjectTrusted: () => boolean }).isProjectTrusted = () => worktreeTrusted;
      return w;
    };

    test("解释器", async () => {
      const w = await prepare("interpreter"), created = await w.create(), { input } = await w.request(created);
      w.capture("同意"); scriptReview(w.provider, phoneReview);
      const before = w.provider.models.length;
      await w.call({ action: "confirmUpdate", ...input });
      expect(w.provider.models.slice(before)).toEqual([expectedModel]);
    });

    test("草稿核验器", async () => {
      const w = await prepare("draft-verifier");
      w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      const before = w.provider.models.length;
      await w.call({ action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY });
      expect(w.provider.models.slice(before)).toEqual([expectedModel]);
    });
  });

  test("设定没写思考等级时，解释器用主窗口当前的思考等级", async () => {
    const w = await world({ mainThinking: () => "high" }), created = await w.create(), { input } = await w.request(created);
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    const before = w.provider.reasoning.length;
    await w.call({ action: "confirmUpdate", ...input });
    expect(w.provider.reasoning.slice(before)).toEqual(["high"]);
  });

  test("设定没写思考等级时，草稿核验器用主窗口当前的思考等级", async () => {
    const w = await world({ mainThinking: () => "high" });
    await w.create();
    const verifier = w.provider.requests.map((request, index) => ({ request, index })).filter(({ request }) => request.systemPrompt?.includes("草拟意图核验器"));
    expect(verifier.length).toBeGreaterThan(0);
    for (const { index } of verifier) expect(w.provider.reasoning[index]).toBe("high");
  });

  test("M8D-AC2：同一窗口可以处理多个需求，不需要绑定就能读取和修改其中任何一个的草稿", async () => {
    const w = await world(), first = await w.create(), second = await w.create();
    for (const created of [first, second]) {
      expect(await w.call({ action: "read", requirementId: created.requirementId, source: "saved" })).toMatchObject({ requirementId: created.requirementId });
      w.capture("补一句"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      expect(await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version,
        summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补一句。\n" })).toMatchObject({ action: "updateDraft", requirementId: created.requirementId });
    }
  });

  test("M8G-AC1：修改草稿时核验器同时拿到上一版已保存的草稿，提示词写明只核改动的部分；新建草稿时没有上一版", async () => {
    const w = await world(), created = await w.create();
    const sentPayload = () => { const content = w.provider.requests.at(-1)!.messages[0]!.content; return JSON.parse(typeof content === "string" ? content : (content as Array<{ text: string }>).map((block) => block.text).join("")); };
    expect(sentPayload()).not.toHaveProperty("previous");
    w.capture("选第 1 项"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version,
      summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "验证码 5 分钟有效。\n" });
    expect(sentPayload()).toMatchObject({ text: expect.stringContaining("选第 1 项"), action: "updateDraft", previous: { title: "登录", body: BODY }, candidate: { title: "登录", body: BODY + "验证码 5 分钟有效。\n" } });
    expect(w.provider.requests.at(-1)!.systemPrompt).toContain("previous是程序保存的上一版草稿");
  });

  test("M8D-AC1：@ 补全列出本窗口状态正常的草稿与进行中需求及当前草稿标题，改标题后列表跟着变", async () => {
    const w = await world(), created = await w.create();
    expect(await w.interaction.mentionCandidates(w.ctx)).toEqual([{ repoId: w.repoId, requirementId: created.requirementId, title: "登录", lifecycle: "draft" }]);
    w.capture("标题改一下"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version,
      summary: "手机号登录，保留邮箱登录", title: "手机号登录", body: BODY });
    expect((await w.interaction.mentionCandidates(w.ctx)).map((item) => item.title)).toEqual(["手机号登录"]);
  });

  test("M8K-AC3：list 列出本窗口草稿与进行中需求的编号、标题、状态与仓库，不含正文，不需要当前用户输入；指定仓库时只列该仓库，结果照常通过送达核对", async () => {
    const w = await world(), created = await w.create();
    const list = async (request: Record<string, unknown>) => (await w.manage.execute(uuidv7(), { request } as never, undefined, undefined, w.ctx)).details!;
    const expected = { requirements: [{ repoId: w.repoId, requirementId: created.requirementId, title: "登录", lifecycle: "draft" }] };
    expect(await list({ action: "list" })).toEqual(expected);
    expect(await list({ action: "list", repoId: w.repoId })).toEqual(expected);
    expect(await w.call({ action: "list" })).toEqual(expected);
    expect(await list({ action: "list", repoId: "f".repeat(64) })).toEqual({ requirements: [] });
    expect(JSON.stringify(await list({ action: "list" }))).not.toContain("手机号");
  });

  test("M8D-AC1：原话里的 @ 按编号尾巴认出需求，同一需求只算一次，无效的 @ 单独报出原因", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    const result = w.interaction.captureInput({ source: "interactive", text: `@[登录#${id.slice(-4)}] @[登录#${id.slice(-6)}] @[别的#ffff] 改一下` }, w.ctx);
    expect(w.interaction.inputTargets()).toEqual([{ repoId: w.repoId, requirementId: id, title: "登录" }]);
    expect(result.invalid).toEqual([{ token: "[别的#ffff]", reason: "不存在、已关闭或状态异常" }]);
    w.interaction.captureInput({ source: "interactive", text: "下一句不带 @" }, w.ctx);
    expect(w.interaction.inputTargets()).toEqual([]);
  });

  test("M8D-AC7：新建和修改草稿都要写简介，程序按当前草稿版本记下简介；缺简介时拒绝并写明缺哪个字段", async () => {
    const w = await world();
    w.capture();
    await expect(w.call({ action: "create", title: "登录", body: BODY }))
      .rejects.toMatchObject({ code: "invalid_shape", message: expect.stringContaining("缺少字段：summary") });
    const created = await w.create();
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    const first = state.read(String(created.requirementId)).data.saved!.hash;
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), first)).toBe("手机号登录，保留邮箱登录");
    w.capture("再加一句"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version, summary: "手机号验证码登录，邮箱登录照旧",
      title: "登录", body: BODY + "补充一句。\n" });
    const second = state.read(String(created.requirementId)).data.saved!.hash;
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), second)).toBe("手机号验证码登录，邮箱登录照旧");
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), first)).toBeUndefined();
  });

  test("普通问答、未来闲聊、伪来源、无输入均不能create；只读metadata不建空库", async () => {
    const w = await world(), input = { action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
    await expect(w.call(input)).rejects.toMatchObject({ code: "current_input_required" });
    for (const source of ["extension", "tool", "user", "rpc"]) { w.capture("想做登录", source); await expect(w.call(input)).rejects.toMatchObject({ code: "current_input_required" }); }
    for (const text of ["这个函数为什么这样写？", "也许明年做个登录吧"]) {
      w.capture(text); scriptReplies(w.provider, [{ type: "text", text: '{"allow":false}' }]);
      await expect(w.call(input)).rejects.toMatchObject({ code: "draft_interpretation_denied" });
    }
    await expect(w.call({ action: "metadata", requirementId: uuidv7() })).rejects.toMatchObject({ code: "database_missing" });
    await expect(stat(repositoryDatabase(w.dataRoot, w.repoId))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("M8B：草稿核验器知道项目规范另经规范流程处理，草稿不含规范不影响放行", async () => {
    const w = await world();
    await w.create();
    expect(w.provider.requests.find((request) => request.systemPrompt?.includes("草拟意图核验器"))!.systemPrompt)
      .toContain("长期遵守的项目规范另经项目规范流程处理，不写进需求草稿；草稿不含这部分不影响放行");
  });

  test("M8C：草稿核验器与解释器的提示词不写死五大板块，改说需求文档规范规定的板块与格式占位内容", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    scriptReview(w.provider, phoneReview);
    await w.call({ action: "confirmUpdate", ...input });
    const prompts = w.provider.requests.map((request) => request.systemPrompt ?? "");
    const verifier = prompts.find((prompt) => prompt.includes("草拟意图核验器"))!, interpreter = prompts.find((prompt) => prompt.includes("需求解释器"))!;
    for (const prompt of [verifier, interpreter]) {
      expect(prompt).toContain("需求文档规范规定的板块与格式占位内容");
      expect(prompt).not.toMatch(/背景、需求、功能、实现、验收|五个板块/u);
    }
  });

  test("M9：用户按主代理的推荐作答后更新草稿，草稿核验器能看到本需求上提过的问题，提示词说明被采纳的那项才算用户决定", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    w.capture(); w.answerWindows(false);
    await w.call({ action: "ask", ...input, question: "短信验证码有效期选哪种？", rootCheck: "要定的是验证码多久失效，而不是另加重发限制",
      choices: [{ label: "5 分钟", reason: "更安全", recommended: true, recommendedReason: "常见做法，够用户收短信" }, { label: "10 分钟", reason: "信号差也来得及，但更容易被盗用" }], scope: "仅短信验证码期限",
      unitIds: ["background"], actions: ["analyze"] }, true);
    w.capture("按你推荐的定，写进草稿"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
    const verifier = w.provider.requests.filter((request) => request.systemPrompt?.includes("草拟意图核验器")).at(-1)!;
    const payload = JSON.parse(String((verifier.messages[0] as { content: string }).content));
    expect(payload.questions).toEqual([{ question: "短信验证码有效期选哪种？\n选项：1. 5 分钟（推荐）；2. 10 分钟", scope: "仅短信验证码期限" }]);
    expect(verifier.systemPrompt).toContain("被采纳的那一项算用户决定");
    expect(verifier.systemPrompt).toContain('只含问题与选项名称，推荐项标"（推荐）"');
  });

  test("M8M-AC2：本需求的历史问题多到放不进核验器输入时，改草稿照常成功，核验器拿到的是从最新往旧放得下的那些问题", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    const older = Array.from({ length: 60 }, () => uuidv7());
    w.capture(); w.answerWindows(false);
    await w.call({ action: "ask", ...input, question: "短信验证码有效期选哪种？", rootCheck: "要定的是验证码多久失效，而不是另加重发限制",
      choices: [{ label: "5 分钟", reason: "更安全", recommended: true, recommendedReason: "常见做法，够用户收短信" }, { label: "10 分钟", reason: "信号差也来得及，但更容易被盗用" }], scope: "仅短信验证码期限",
      unitIds: ["background"], actions: ["analyze"] }, true);
    withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
      for (const [i, requestId] of older.entries()) db.create("interaction_questions_v1", requestId, { format: "interaction-question/v1", requestId, repoId: w.repoId,
        basis: { requirementId: input.requirementId, version: 1, epoch: 1, prd: null }, candidate: null,
        proposal: { conclusion: `旧问题 ${i}：${"很久以前问过的细节".repeat(40)}`, scope: "旧范围", references: [], supersedes: [] }, actions: [], createdAt: 1 }, requestId);
    });
    w.capture("按你推荐的定，写进草稿"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
    const verifier = w.provider.requests.filter((request) => request.systemPrompt?.includes("草拟意图核验器")).at(-1)!;
    const content = String((verifier.messages[0] as { content: string }).content), payload = JSON.parse(content) as { questions: Array<{ question: string }> };
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(65_536);
    expect(payload.questions.at(-1)!.question).toContain("短信验证码有效期选哪种？");
    const kept = payload.questions.slice(0, -1).map((question) => Number(/^旧问题 (\d+)：/u.exec(question.question)![1]));
    const newest = older.map((id, i) => ({ id, i })).sort((a, b) => a.id.localeCompare(b.id)).slice(-kept.length).map((item) => item.i);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(60);
    expect(kept).toEqual(newest);
  });

  test("M9：草稿核验器拒绝时带回一句原因，标明是模型说法；原因只作参考，未知字段或类型不对仍按格式错误拒绝", async () => {
    const w = await world(), input = { action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
    w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":false,"reason":"需求里「不接入渲染循环」是用户没说过的限制"}' }]);
    const error = await w.call(input).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: "draft_interpretation_denied" });
    expect((error as Error).message).toBe("one_company_requirement_manage 的 create 动作失败。\n原因：核验器认为草稿与用户原话不符：核验器说明，模型撰写，仅供参考：需求里「不接入渲染循环」是用户没说过的限制\n建议：按核验器说明改正草稿中与用户原话不符的部分后重试");
    for (const reply of ['{"allow":false,"reason":1}', '{"allow":false,"why":"x"}', '{"allow":"false"}']) {
      w.capture(); scriptReplies(w.provider, [{ type: "text", text: reply }]);
      const error = await w.call(input).catch((caught: Error) => caught);
      expect(error).toMatchObject({ code: "draft_not_requested" });
      expect(String(error)).toContain("原因：核验模型的回答格式不对");
    }
    expect(w.provider.requests.find((request) => request.systemPrompt?.includes("草拟意图核验器"))!.systemPrompt).toContain('{"allow":boolean,"reason":string}');
    w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true,"reason":"用户要求整理登录需求"}' }]);
    expect(await w.call(input)).toMatchObject({ action: "create" });
  });

  test("create自动真实Git首提、UUID/hash一致；不带编号的再次create是另一个需求；新增无关需求不复用输入", async () => {
    const w = await world(); w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    const p = { action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
    const first = await w.call(p);
    w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    const second = await w.call(p);
    expect(second.requirementId).not.toBe(first.requirementId);
    const directory = join(w.dataRoot, "repos", w.repoId, "requirements", String(first.requirementId));
    const prd = await readFile(join(directory, "prd.md"));
    expect(prd.toString()).toContain(`requirementId: ${first.requirementId}`);
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(directory, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("prd.md");
    expect(await git(directory, ["show", "-s", "--format=%an <%ae>", "HEAD"])).toBe("pi PRD storage <pi-prd-storage@localhost>");
    w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":false}' }]);
    await expect(w.call({ ...p, title: "无关付款" })).rejects.toMatchObject({ code: "draft_interpretation_denied" });
  });
  test("M8A-AC9：正文顶层标题不符合需求文档规范规定的板块时批准被拒，不调用模型、不激活，并写明期望与实际", async () => {
    const w = await world();
    const created = await w.create("## 手机号登录 {#A}\n增加手机号登录。\n"), { input } = await w.request(created);
    const before = w.provider.requests.length;
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toThrow(
      "原因：需求正文不符合需求文档规范：顶层须为二级标题且依次为 background、requirements、features、implementation、acceptance，当前为 A");
    expect(w.provider.requests).toHaveLength(before);
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    expect(state.read(input.requirementId).data.lifecycle).toBe("draft");
  });
  test("M8C-AC2/AC3/AC5：项目受信任后按它的规范核对并存快照；之后改 skill，已生效需求再批准仍按快照", async () => {
    const w = await world(), dir = join(w.repositoryRoot, ".pi", "skills", "requirement-doc");
    const skillFile = (ids: [string, string, string]) => `---\nname: requirement-doc\ndescription: 三板块\nsections:\n  - { id: ${ids[0]}, title: 目标, goal: true }\n` +
      `  - { id: ${ids[1]}, title: 实现, record: implementation }\n  - { id: ${ids[2]}, title: 验收, record: acceptance }\n---\n三板块写法。\n`;
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), skillFile(["goal", "build", "check"]));
    const body = "## 目标 {#goal}\n登录需求。\n### 手机号 {#goal.A}\n增加手机号登录。\n## 实现 {#build}\n由 PM 规划。\n## 验收 {#check}\n手机号能登录。\n";
    const created = await w.create(body), first = await w.request(created), before = w.provider.requests.length;
    await expect(w.call({ action: "confirmUpdate", ...first.input })).rejects.toThrow("当前为 goal、build、check");
    expect(w.provider.requests).toHaveLength(before);
    new ProjectTrustStore(w.root).set(w.repositoryRoot, true);
    scriptReview(w.provider, (c) => wholeReview(c, "goal.A"));
    expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prdActivated: true });
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    const snapshot = (await resolveRepositoryRequirementDoc(w.dataRoot, w.repositoryRoot)).spec;
    expect(snapshot.sections.map((section) => section.id)).toEqual(["goal", "build", "check"]);
    expect(state.read(first.input.requirementId).data.docSpec).toEqual(snapshot);
    await writeFile(join(dir, "SKILL.md"), skillFile(["aim", "make", "verify"]));
    expect((await resolveRepositoryRequirementDoc(w.dataRoot, w.repositoryRoot)).spec.sections.map((section) => section.id)).toEqual(["aim", "make", "verify"]);
    const updated = await w.service.updateDraft({ requirementId: first.input.requirementId, version: state.read(first.input.requirementId).version, operationId: uuidv7(), title: "登录", body: body + "补充邮箱约束。\n" });
    const next = await w.request(updated);
    w.capture("批准这版。"); scriptReview(w.provider, (c) => wholeReview(c, "goal.A"));
    expect(await w.call({ action: "confirmUpdate", ...next.input })).toMatchObject({ prdActivated: true });
    expect(state.read(first.input.requirementId).data.docSpec).toEqual(snapshot);
  });
  test("M8O-AC2：需求存下的规范快照没有标出实施目标板块时，批准直接报错写明原因，不调用模型、不激活", async () => {
    const w = await world(), created = await w.create(), first = await w.request(created), before = w.provider.requests.length;
    withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => {
      const row = db.read<Record<string, unknown>>("requirements", first.input.requirementId)!;
      db.update("requirements", first.input.requirementId, row.version, { ...row.data, docSpec: { skillHash: `sha256:${"b".repeat(64)}`,
        sections: [{ id: "background", title: "背景" }, { id: "requirements", title: "需求" }, { id: "features", title: "功能" },
          { id: "implementation", title: "实现", record: "implementation" }, { id: "acceptance", title: "验收", record: "acceptance" }] } });
    });
    const version = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.read("requirements", first.input.requirementId)!.version);
    const error = await w.call({ action: "confirmUpdate", ...first.input, version }).catch((caught: Error) => caught);
    expect((error as Error).message).toContain("实施目标板块");
    expect(w.provider.requests).toHaveLength(before);
  });
  test("M8C-AC4：需求所在仓库的规范无效时批准直接报错写明原因，不调用模型、不激活、不退回默认", async () => {
    const w = await world(), dir = join(w.root, "skills", "requirement-doc");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: requirement-doc\nsections:\n  - { id: a, title: 甲, record: implementation }\n  - { id: a, title: 乙, record: acceptance }\n---\n");
    const created = await w.create(), { input } = await w.request(created), before = w.provider.requests.length;
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toThrow(`原因：读取需求文档规范失败：需求文档规范 ${join(dir, "SKILL.md")} 无效：板块编号 a 重复`);
    expect(w.provider.requests).toHaveLength(before);
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    expect(state.read(input.requirementId).data).toMatchObject({ lifecycle: "draft" });
    expect(state.read(input.requirementId).data.docSpec).toBeUndefined();
  });
  test("手机号原句仅分析：未建工作区也激活并记短决定与完整scope，不弹审批；清会话不生成原话表/文件", async () => {
    const w = await world(), sent: Array<{ messages: unknown[] }> = [];
    const original = w.ctx.modelRegistry.complete.bind(w.ctx.modelRegistry);
    vi.spyOn(w.ctx.modelRegistry, "complete").mockImplementation((model, context, options) => { sent.push(context); return original(model, context, options); });
    const created = await w.create(), { input } = await w.request(created);
    scriptReview(w.provider, phoneReview);
    const result = await w.call({ action: "confirmUpdate", ...input });
    expect(result).toMatchObject({ targetRecorded: true, prdActivated: true });
    expect(result).not.toHaveProperty("blockedBy");
    expect(result.approvalScope).toMatchObject({ summary: { confirmed: ["metadata", "background", "requirements", "A", "D", "features", "implementation", "acceptance"], pending: ["SMS"], excluded: ["B"] } });
    expect(w.provider.requests).toHaveLength(2);
    expect(w.provider.requests.every((r) => r.tools?.length === 0)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent.every((context) => context.messages.length === 0)).toBe(true);
    const rows = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
    expect(rows).toHaveLength(7); expect(rows.map((r) => (r.data as { actor: string }).actor)).toEqual(Array(7).fill("user"));
    expect(rows.some((r) => (r.data as { conclusion: string }).conclusion.includes("委托"))).toBe(true);
    expect(rows.some((r) => (r.data as { conclusion: string; status: string }).conclusion.includes("未来") && (r.data as { status: string }).status === "pending")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
    w.interaction.shutdown();
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"))).toEqual(rows);
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("host_requirement_target_receipts_v1"))).toEqual([]);
    expect((await readdir(join(w.dataRoot, "repos", w.repoId))).sort()).toEqual(["data.db", "requirements"]);
  });
  test("明确直接实施 + 真实ready worktree：manifest→service/state批准；重复无新事件/commit", async () => {
    const w = await world(), created = await w.create();
    const worktree = join(w.root, "worktree"); await git(w.repositoryRoot, ["worktree", "add", "-b", "requirement-test", worktree, "HEAD"]);
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    const bound = await state.bindWorkspace({ requirementId: String(created.requirementId), version: Number(created.version), path: worktree,
      baseCommit: await git(w.repositoryRoot, ["rev-parse", "HEAD"]), prepareOperationId: uuidv7() });
    w.capture("现在直接实施手机号登录并保留邮箱。微信排除。短信期限暂时只列待定。");
    const { input } = await w.request({ ...created, version: bound.version });
    scriptReview(w.provider, (c) => phoneReview(c, "implement"));
    const result = await w.call({ action: "confirmUpdate", ...input });
    expect(result).toMatchObject({ targetRecorded: true, prdActivated: true, lifecycle: "active" });
    expect(result).not.toHaveProperty("blockedBy");
    expect(result).not.toHaveProperty("unimplemented");
    expect(state.events(String(created.requirementId)).filter((e) => e.data.kind === "prd.approved")).toHaveLength(1);
    expect(await git(join(w.dataRoot, "repos", w.repoId, "requirements", String(created.requirementId)), ["rev-list", "--count", "HEAD"])).toBe("1");
  });
  test("模型异步期间撤权，迟到输出脱敏、没有短记录或manifest", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    scriptReview(w.provider, phoneReview, { chunkDelayMs: 30 });
    const result = w.call({ action: "confirmUpdate", ...input });
    const rejected = expect(result).rejects.toThrow();
    const deadline = Date.now() + 3000;
    while (w.provider.requests.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    expect(w.provider.requests).toHaveLength(2);
    w.authorization.revoke();
    await rejected;
    await new Promise((r) => setTimeout(r, 40));
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"))).toEqual([]);
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("approval_manifests_v1"))).toEqual([]);
  });
  test("SDK返回前微任务撤权与跨连接关闭，旧正文不得交付；关闭metadata最小化", async () => {
    const w = await world(), created = await w.create(), requirementId = String(created.requirementId);
    const resultId = uuidv7();
    await w.manage.execute(resultId, { request: { action: "read", repoId: w.repoId, requirementId, source: "saved" } } as never, undefined, undefined, w.ctx);
    await Promise.resolve().then(() => w.authorization.revoke());
    expect(() => w.interaction.assertDelivery(resultId, w.ctx)).toThrow();
    const otherResultId = uuidv7();
    await w.manage.execute(otherResultId, { request: { action: "read", repoId: w.repoId, requirementId, source: "saved" } } as never, undefined, undefined, w.ctx);
    const script = `import {RequirementStateStore} from ${JSON.stringify(new URL("../src/modules/requirement/requirement-state.ts", import.meta.url).href)};
      const state=await RequirementStateStore.open({...${JSON.stringify({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId })},authorize:()=>true});
      await state.beginClose(${JSON.stringify({ requirementId, version: Number(created.version), intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } })});`;
    await exec(process.execPath, ["--input-type=module", "-e", script]);
    expect(() => w.interaction.assertDelivery(otherResultId, w.ctx)).toThrow(/stale_result/);
    await expect(w.call({ action: "read", requirementId, source: "saved" })).rejects.toMatchObject({ code: "lifecycle_denied" });
    const metadata = await w.call({ action: "metadata", requirementId });
    expect(Object.keys(metadata).sort()).toEqual(["epoch", "lifecycle", "requirementId", "version"]);
    expect(metadata.lifecycle).toBe("closing");
  });
  test("修改建议不批准旧hash，外部服务重新保存不能重放旧ticket", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    scriptReview(w.provider, (c) => {
      const review = phoneReview(c); review.faithful = false;
      review.entries[1]!.resolution = "modify"; review.entries[1]!.conclusion = "手机号登录需修改后保留邮箱";
      review.entries.splice(5, 1);
      return review;
    });
    const result = await w.call({ action: "confirmUpdate", ...input });
    expect(result).toMatchObject({ targetRecorded: true, prdActivated: false, blockedBy: "candidate_requires_revision_or_clarification" });
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("approval_manifests_v1"))).toEqual([]);
    const updated = await w.service.updateDraft({ requirementId: input.requirementId, version: input.version, operationId: uuidv7(), title: "登录", body: BODY + "明确保留邮箱登录。\n" });
    await expect(w.call({ action: "confirmUpdate", requirementId: input.requirementId, version: updated.version, savedOperationId: updated.operationId })).rejects.toThrow();
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.events(`requirement_events:${input.requirementId}`).filter((e) => (e.data as { kind: string }).kind === "prd.approved"))).toEqual([]);
  });
  test("一次真实输入完成modify-resave-reinterpret；旧capability立即失效，三次上限保留", async () => {
    let now = 1000;
    const w = await world({ now: () => now });
    const created = await w.create(), captured: unknown[] = [], texts: string[] = [];
    const capture = vi.spyOn(UserInteractionCore.prototype, "captureInput");
    const original = w.ctx.modelRegistry.complete.bind(w.ctx.modelRegistry);
    let expectedInput: { requirementId: string; savedOperationId: string; version: number };
    let reviewedDocuments = 0;
    const inputFor = (saved: Record<string, unknown>) => ({ requirementId: String(saved.requirementId), savedOperationId: String(saved.operationId), version: Number(saved.version) });
    const complete = vi.spyOn(w.ctx.modelRegistry, "complete").mockImplementation((model, context, options) => {
      if (context.messages[0]?.role === "user" && typeof context.messages[0].content === "string") {
        const payload = JSON.parse(context.messages[0].content);
        texts.push(payload.text);
        if (payload.context?.document) {
          // 固定模型答复使用生产解释器实际提供的候选与分区，不另行读取一次PRD。
          expect(payload.context.basis).toMatchObject({ requirementId: expectedInput.requirementId, version: expectedInput.version });
          const review = phoneReview(payload.context.document);
          review.faithful = false; review.entries[1]!.resolution = "modify";
          review.entries.splice(5, 1);
          scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }]);
          reviewedDocuments++;
        }
      }
      return original(model, context, options);
    });
    const prepareOriginal = UserInteractionCore.prototype.prepareCandidateResave;
    const oldCapabilities: import("../src/modules/interaction/user-interaction.ts").InteractionCapability[] = [];
    const interpreted = vi.spyOn(UserInteractionCore.prototype, "interpret");
    const prepare = vi.spyOn(UserInteractionCore.prototype, "prepareCandidateResave").mockImplementation(function (ticket, expected) {
      const permit = prepareOriginal.call(this, ticket, expected);
      captured.push(ticket); for (const old of oldCapabilities) expect(() => this.save(old)).toThrow(/invalid_capability/);
      return permit;
    });
    try {
      let saved = created;
      for (let i = 0; i < 4; i++) {
        const input = inputFor(saved); expectedInput = input;
        const result = await w.call({ action: "confirmUpdate", ...input });
        expect(result.prdActivated).toBe(false);
        oldCapabilities.push((await interpreted.mock.results.at(-1)!.value).capability);
        const update = { action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + `补充${i}：明确保留邮箱登录。\n` };
        scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
        if (i === 3) { await expect(w.call(update)).rejects.toThrow(); break; }
        saved = await w.call(update);
        now += 1000;
      }
      expect(reviewedDocuments).toBe(4);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(3); expect(captured.every((ticket) => ticket === captured[0])).toBe(true);
      expect(texts.every((text) => text === PHONE)).toBe(true);
      const directory = join(w.dataRoot, "repos", w.repoId, "requirements", String(created.requirementId));
      expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("4");
    } finally { capture.mockRestore(); complete.mockRestore(); prepare.mockRestore(); interpreted.mockRestore(); }
  });
  for (const change of ["revoke", "input", "resave"] as const) test(`受控重解释在模型等待期间${change}拒绝迟到结果`, async () => {
    let now = 1000;
    const w = await world({ now: () => now }), created = await w.create(), first = await w.request(created);
    scriptReview(w.provider, modifyReview); await w.call({ action: "confirmUpdate", ...first.input });
    scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    const updated = await w.call({ action: "updateDraft", requirementId: first.input.requirementId, version: first.input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充邮箱约束。\n" });
    const next = await w.request(updated), before = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
    scriptReview(w.provider, phoneReview, { chunkDelayMs: 500 });
    const count = w.provider.requests.length, pending = w.call({ action: "confirmUpdate", ...next.input }), rejected = expect(pending).rejects.toThrow();
    const deadline = Date.now() + 3000;
    while (w.provider.requests.length === count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    expect(w.provider.requests.length).toBe(count + 1);
    if (change === "revoke") w.authorization.revoke();
    if (change === "input") w.capture("新的真实输入");
    if (change === "resave") await w.service.updateDraft({ requirementId: next.input.requirementId, version: next.input.version, operationId: uuidv7(), title: "登录", body: BODY + "外部更新。\n" });
    await rejected; await new Promise((r) => setTimeout(r, 510));
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"))).toEqual(before);
  });
  test("服务层带原因的失败原样交出原因，普通异常只说被拒、不回显原始消息", async () => {
    for (const [thrown, code] of [[new RequirementServiceError("stale_version", "详细说明"), "stale_version"], [new Error("fixture_plain_failure"), "interaction_denied"]] as const) {
      const w = await world(), created = await w.create();
      const fail = vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementation(() => { throw thrown; });
      try {
        w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
        const error = await w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version),
          summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充。\n" }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code });
        expect((error as Error).message).toContain(code === "stale_version" ? "原因：需求在读取后已被改动，提交用的版本号过期了：详细说明" : "原因：需求操作被拒绝，底层没有给出可说明的原因");
        expect((error as Error).message).not.toContain("fixture_plain_failure");
        const log = join(w.dataRoot, "repos", w.repoId, "logs", "requirement-errors.log");
        if (code === "stale_version") expect(existsSync(log)).toBe(false);
        else {
          const text = readFileSync(log, "utf8");
          expect(JSON.parse(text.trim())).toMatchObject({ action: "updateDraft", name: "Error" });
          expect(text).not.toContain("fixture_plain_failure");
        }
      } finally { fail.mockRestore(); }
    }
  });
  test("没有原因说明的失败记进本机日志，只保留最近 200 条，数据库错误记下代码与错误号", async () => {
    const w = await world(), created = await w.create();
    const dir = join(w.dataRoot, "repos", w.repoId, "logs"), log = join(dir, "requirement-errors.log");
    mkdirSync(dir, { recursive: true });
    writeFileSync(log, Array.from({ length: 205 }, (_, i) => JSON.stringify({ old: i })).join("\n") + "\n");
    const busy = Object.assign(new Error("database is locked: 需求正文"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    const fail = vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementation(() => { throw busy; });
    try {
      w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      await expect(w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version),
        summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充。\n" })).rejects.toMatchObject({ code: "interaction_denied" });
    } finally { fail.mockRestore(); }
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(200);
    expect(JSON.parse(lines[0]!)).toEqual({ old: 6 });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ at: expect.any(String), action: "updateDraft", name: "Error", code: "ERR_SQLITE_ERROR", errcode: 5 });
    expect(lines.join("\n")).not.toContain("需求正文");
  });
  test("受控重存finalize失败保留实际数据但取消重解释permit", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    scriptReview(w.provider, modifyReview); await w.call({ action: "confirmUpdate", ...input });
    const fail = vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementation(() => { throw new Error("fixture_finalize_failure"); });
    try {
      scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      await expect(w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充。\n" })).rejects.toThrow();
    } finally { fail.mockRestore(); }
    const current = w.authorization.snapshot(w.repoId, input.requirementId, w.sessionId);
    expect(current.version).toBeGreaterThan(input.version);
    const unfinished = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list(REQUIREMENT_OPERATION_NAMESPACE))
      .map((row) => row.data as { action: string; operationId: string; finalVersion: number | null })
      .filter((row) => row.action === "updateDraft" && row.finalVersion === null);
    expect(unfinished).toHaveLength(1);
    await expect(w.call({ action: "confirmUpdate", requirementId: input.requirementId, version: current.version, savedOperationId: unfinished[0]!.operationId })).rejects.toThrow();
  });
  test("分页保留中文、范围与未决标记，封装≤50KiB，翻页用 next，游标只能用一次、跨新输入失效，首次读取不收游标", async () => {
    const w = await world(), created = await w.create("# 说明 {#A}\n" + "中文边界\\\"".repeat(2000)), requirementId = String(created.requirementId);
    const first = await w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024 });
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(first) }], details: first }))).toBeLessThanOrEqual(50 * 1024);
    expect(first.text).not.toContain("�"); expect(first.coverage).toMatchObject({ complete: false, blocking: ["incomplete_prd_read", "global_constraints_and_unresolved_may_be_outside_page"] });
    const cursor = (first.coverage as { nextCursor: string }).nextCursor;
    const second = await w.call({ action: "next", requirementId, cursor });
    expect(second.coverage).toMatchObject({ startByte: Buffer.byteLength(first.text as string) });
    await expect(w.call({ action: "next", requirementId, cursor })).rejects.toMatchObject({ code: "cursor_expired" });
    const third = await w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024 });
    w.capture("新输入"); await expect(w.call({ action: "next", requirementId, cursor: (third.coverage as { nextCursor: string }).nextCursor })).rejects.toMatchObject({ code: "cursor_expired" });
    await expect(w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024, cursor: "0".repeat(64) })).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(w.call({ action: "next", requirementId, cursor: "a".repeat(64) })).rejects.toMatchObject({ code: "cursor_expired" });
  });
});
test("别的进程短暂占住数据库时，宿主读取需求记录等锁释放后照常完成，不立刻报数据库忙", async () => {
  const w = await world(), created = await w.create();
  const holder = execFile(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(repositoryDatabase(w.dataRoot, w.repoId))});
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_probe (a);");
    process.stdout.write("held");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 500);`]);
  await new Promise((resolve) => holder.stdout!.once("data", resolve));
  const started = performance.now();
  expect(w.authorization.snapshot(w.repoId, String(created.requirementId), w.sessionId).id).toBe(String(created.requirementId));
  expect(performance.now() - started).toBeGreaterThan(300);
  await new Promise((resolve) => holder.once("exit", resolve));
});
test("批准时生成批准范围这一步出错，如实报错，不说成草稿要修改或澄清", async () => {
  const w = await world(), created = await w.create(), { input } = await w.request(created);
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const read = vi.spyOn(UserInteractionCore.prototype, "readDecision").mockImplementation(() => { throw busy; });
  try {
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    const outcome = await w.call({ action: "confirmUpdate", ...input }).then((result) => result, (error: unknown) => error);
    expect(outcome).not.toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
    expect(outcome).toMatchObject({ code: "interaction_denied" });
  } finally { read.mockRestore(); }
});

const SMS_ASK = { question: "短信验证码有效期选哪种？", rootCheck: "要定的是验证码多久失效，而不是另加重发限制",
  choices: [{ label: "5 分钟", reason: "更安全", recommended: true, recommendedReason: "常见做法，够用户收短信" }, { label: "10 分钟", reason: "信号差也来得及，但更容易被盗用" }],
  scope: "仅短信验证码期限", actions: ["analyze"] };
async function askedWorld(options: Parameters<typeof world>[0] = {}) {
  const w = await world(options), created = await w.create(), { input } = await w.request(created);
  const ask = (answer: WindowDecision, extra: Record<string, unknown> = {}) => {
    w.capture(); w.answerWindows(answer);
    return w.call({ action: "ask", ...input, ...SMS_ASK, unitIds: ["background"], ...extra }, true);
  };
  return { w, input, ask };
}
const verifierText = (w: Awaited<ReturnType<typeof world>>) =>
  JSON.parse(String((w.provider.requests.filter((r) => r.systemPrompt?.includes("草拟意图核验器")).at(-1)!.messages[0] as { content: string }).content)).text;

test("M8D-AC9：登记问题后弹出提问窗口，用户选推荐项，主代理拿到回答，回答当作用户这一轮的原话", async () => {
  const { w, input, ask } = await askedWorld();
  const result = await ask("5 分钟");
  const shown = w.windows.at(-1)!;
  expect(shown.title).toBe("提问 · 登录（第 1 版）");
  expect(shown.text).toContain("根源自检  要定的是验证码多久失效");
  expect(shown.choices).toEqual(["5 分钟", "10 分钟", "其他（自己输入）"]);
  expect(result).toMatchObject({ status: "answered", answer: { text: "5 分钟\n更安全", choice: 1 } });
  scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
  expect(verifierText(w)).toBe("5 分钟\n更安全");
  expect(verifierText(w)).toBe((result as { answer: { text: string } }).answer.text);
});

test("窗口里点选非首项的推荐项，交给核验器的原话就是该项标题加说明，不带序号、推荐标记和推荐理由", async () => {
  const { w, input, ask } = await askedWorld();
  const choices = [{ label: "先核对信息完整性，项目名称由用户填写", reason: "不查询项目系统，是否真实和能否按期交付由负责人判断。" },
    { label: "负责人维护项目清单，BOT 匹配项目并核对信息完整性", reason: "按清单确认项目归属；交付可行性仍由负责人判断。", recommended: true, recommendedReason: "把交付承诺留给负责人，减少错误承诺。" }];
  const result = await ask("负责人维护项目清单，BOT 匹配项目并核对信息完整性", { choices });
  expect(result).toMatchObject({ status: "answered", answer: { text: "负责人维护项目清单，BOT 匹配项目并核对信息完整性\n按清单确认项目归属；交付可行性仍由负责人判断。", choice: 2 } });
  scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "交付可行性由需求负责人判断。\n" });
  expect(verifierText(w)).toBe("负责人维护项目清单，BOT 匹配项目并核对信息完整性\n按清单确认项目归属；交付可行性仍由负责人判断。");
});

const TWO_HOURS = 7_200_000;
test("原话没有时间期限：截获两小时后（时钟与计时器都推进），依赖当前原话的批准仍成功", async () => {
  let now = 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const w = await world({ now: () => now }), created = await w.create(), { input } = await w.request(created);
    w.capture("同意");
    now += TWO_HOURS; await vi.advanceTimersByTimeAsync(TWO_HOURS);
    vi.useRealTimers();
    scriptReview(w.provider, phoneReview);
    expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ targetRecorded: true, prdActivated: true });
  } finally { vi.useRealTimers(); }
});
test("提问窗口开着两小时后才回答：ask 返回 answered，不报 stale_host，送达核对通过", async () => {
  let now = 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { w, ask } = await askedWorld({ now: () => now });
    w.beforeAnswer(async () => { now += TWO_HOURS; await vi.advanceTimersByTimeAsync(TWO_HOURS); vi.useRealTimers(); });
    const result = await ask("5 分钟");
    expect(result).toMatchObject({ status: "answered", answer: { text: "5 分钟\n更安全", choice: 1 } });
  } finally { vi.useRealTimers(); }
});
test("提问窗口两小时后回答的话成为新的原话，之后立即可用于更新草稿", async () => {
  let now = 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { w, input, ask } = await askedWorld({ now: () => now });
    w.beforeAnswer(async () => { now += TWO_HOURS; await vi.advanceTimersByTimeAsync(TWO_HOURS); vi.useRealTimers(); });
    await ask("5 分钟");
    scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
    expect(verifierText(w)).toBe("5 分钟\n更安全");
  } finally { vi.useRealTimers(); }
});

test("M8D-AC9：在其他里自己输入的文字原样当作用户原话；Esc 暂不回答时问题仍未决，不记新的原话", async () => {
  const other = await askedWorld();
  expect(await other.ask({ other: "7 分钟" })).toMatchObject({ status: "answered", answer: { text: "7 分钟", other: true } });
  scriptReplies(other.w.provider, [{ type: "text", text: '{"allow":true}' }]);
  await other.w.call({ action: "updateDraft", requirementId: other.input.requirementId, version: other.input.version, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 7 分钟有效。\n" });
  expect(verifierText(other.w)).toBe("7 分钟");
  const skipped = await askedWorld();
  const result = await skipped.ask(false);
  expect(result).toMatchObject({ status: "pending", answer: null });
  expect(withDatabase(repositoryDatabase(skipped.w.dataRoot, skipped.w.repoId), (db) => db.list("interaction_questions_v1"))).toHaveLength(1);
});

test("提问文字含人称字：ask 失败并逐处写明字段、选项序号和含的字，改用用户、AI 或角色，窗口不弹", async () => {
  const { w, ask } = await askedWorld();
  const before = w.windows.length;
  const error = await ask("5 分钟", { question: "我们该选哪种？", choices: [{ label: "5 分钟", reason: "你也觉得够用", recommended: true, recommendedReason: "常见做法" }, { label: "10 分钟", reason: "来得及" }] })
    .then(() => undefined, (caught: unknown) => caught as Error);
  expect(error).toMatchObject({ code: "question_format" });
  expect(error!.message).toContain("question");
  expect(error!.message).toContain("我");
  expect(error!.message).toContain("第 1 个选项");
  expect(error!.message).toContain("reason");
  expect(error!.message).toContain("你");
  expect(error!.message).toMatch(/用户[\s\S]*AI|AI[\s\S]*用户/);
  expect(error!.message).toContain("角色");
  expect(w.windows.length).toBe(before);
});

test("提问文字不含人称字：照常弹窗；用户在其他里输入含人称字的话不检查，原文返回", async () => {
  const { w, ask } = await askedWorld();
  const result = await ask({ other: "我来验收" });
  expect(w.windows).toHaveLength(1);
  expect(result).toMatchObject({ status: "answered", answer: { text: "我来验收", other: true } });
});

test("M8D-AC9：窗口里的回答只算回答：拿它批准时不弹批准窗口、不生效，拿它裁决时被拒并写明原因", async () => {
  const { w, input, ask } = await askedWorld();
  const asked = await ask("批准这一版并实施", { choices: [{ label: "批准这一版并实施", reason: "马上开始", recommended: true, recommendedReason: "草稿已写全" }, { label: "先不批准", reason: "再看看" }], unitIds: ["SMS"] });
  const before = w.windows.length;
  scriptReview(w.provider, (c) => {
    const review = phoneReview(c);
    review.referenceResolution = "explicit";
    Object.assign(review.entries.find((entry) => entry.kind === "unresolved")!, { requestId: asked.requestId, resolution: "defer" });
    return review;
  });
  const outcome = await w.call({ action: "reply", ...input }, true).then((r) => r, (e: unknown) => e);
  expect(outcome).toMatchObject({ prdActivated: false, blockedBy: "window_answer_not_decision" });
  expect(w.windows.length).toBe(before);
  const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
  expect(state.read(input.requirementId).data.lifecycle).toBe("draft");
  const adjudicated = await w.call({ purpose: "adjudicate", action: "reply", requirementId: input.requirementId,
    itemId: `requirement:${input.requirementId}`, itemVersion: `requirement:${input.requirementId}:1` }, true).catch((e: unknown) => e);
  expect(adjudicated).toMatchObject({ code: "window_answer_not_decision" });
  expect((adjudicated as Error).message).toContain("原因：用户是在提问窗口里选的，这只算回答，不能当作批准或裁决");
});

test("批准时解读已完成、之后一步失败：同一句用户原话下原样再调 reply，直接批准成功，不再调用解读模型", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  const storage = vi.spyOn(RequirementService.prototype, "confirmUpdate").mockRejectedValueOnce(new RequirementServiceError("stale_version", "模拟存储出错"));
  const interpretations = () => w.provider.requests.filter((r) => r.systemPrompt?.includes("需求解释器")).length;
  w.capture("同意"); scriptReview(w.provider, phoneReview);
  try {
    await expect(w.call({ action: "reply", ...first.input }, true)).rejects.toMatchObject({ code: "stale_version" });
  } finally { storage.mockRestore(); }
  const before = interpretations();
  expect(before).toBeGreaterThan(0);
  const retried = await w.call({ action: "reply", ...first.input }, true).then((r) => r, (e: unknown) => e);
  expect(retried).toMatchObject({ prdActivated: true });
  expect(retried).not.toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  expect(interpretations()).toBe(before);
});

test("A 批准失败后在同一句用户原话下批准另一个需求 B：B 的批准用新的操作编号，不沿用 A 的", async () => {
  const w = await world(), created = await w.create(), other = await w.create();
  const first = await w.request(created), second = await w.request(other);
  const storage = vi.spyOn(RequirementService.prototype, "confirmUpdate").mockRejectedValueOnce(new RequirementServiceError("stale_version", "模拟存储出错"));
  w.capture("同意"); scriptReview(w.provider, phoneReview);
  let failedOperationId = "";
  try {
    await expect(w.call({ action: "reply", ...first.input }, true)).rejects.toMatchObject({ code: "stale_version" });
    failedOperationId = (storage.mock.calls[0]![0] as { operationId: string }).operationId;
  } finally { storage.mockRestore(); }
  const approved = await w.call({ action: "reply", ...second.input }, true);
  expect(approved).toMatchObject({ prdActivated: true });
  expect(approved.operationId).not.toBe(failedOperationId);
});

const allPending = (loaded: Pick<ConfirmationContext, "candidate" | "partition">) => {
  const review = phoneReview(loaded);
  review.faithful = false;
  review.entries = [{ ...review.entries[0]!, kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "整份待定",
    unitIds: loaded.partition.units.map((unit) => unit.id).filter((id) => id !== "metadata") }, { ...review.entries[0]!, unitIds: ["metadata"] }];
  return review;
};
const interpreterContext = (w: Awaited<ReturnType<typeof world>>) =>
  JSON.parse(String((w.provider.requests.filter((r) => r.systemPrompt?.includes("需求解释器")).at(-1)!.messages[0] as { content: string }).content)).context;

test("M8D-AC9：批准被挡时写明原因：以前登记的决定挡住了哪些段落、这次解读里还有哪些段落待定，用段落标题说，待定段落附上解读模型写的理由", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  w.capture("手机号登录要改一下"); scriptReview(w.provider, modifyReview);
  expect(await w.call({ action: "reply", ...first.input }, true)).toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  const resaveOperation = uuidv7();
  const resaved = await w.service.updateDraft({ requirementId: first.input.requirementId, version: first.input.version, operationId: resaveOperation, title: "登录", body: BODY + "补充一句。\n" });
  const next = await w.request({ ...created, operationId: resaveOperation, version: resaved.version });
  w.capture("内容正确，批准这一版"); scriptReview(w.provider, allPending);
  const again = await w.call({ action: "confirmUpdate", ...next.input }).then((r) => r, (e: unknown) => e);
  expect(again).toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  const reason = (again as { blockedReason: string }).blockedReason;
  expect(reason).toMatch(/以前登记的决定和现在的草稿对不上，涉及段落：[^；]*手机号与邮箱/u);
  expect(reason).toMatch(/这次的解读里仍待定的段落：[^；]*手机号与邮箱/u);
  expect(reason).toMatch(/解读模型对待定段落写的理由（模型写的，只用来决定问用户什么，不算批准）：「[^」]*手机号与邮箱[^」]*」整份待定/u);
});

test("M9-AC12：某段被记为要修改后，草稿改了这一段再请批准，这条旧的修改记录不再算连续性问题、不交给解读模型，没改的段落仍照旧；一次明确批准即生效", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  w.capture("手机号登录要改一下"); scriptReview(w.provider, modifyReview);
  expect(await w.call({ action: "reply", ...first.input }, true)).toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  const resaveOperation = uuidv7();
  const resaved = await w.service.updateDraft({ requirementId: first.input.requirementId, version: first.input.version, operationId: resaveOperation, title: "登录",
    body: BODY.replace("增加手机号登录，保留邮箱登录。", "增加手机号登录，保留邮箱登录，手机号须先验证。") });
  const next = await w.request({ ...created, operationId: resaveOperation, version: resaved.version });
  w.capture("内容正确，批准这一版"); scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...next.input })).toMatchObject({ prdActivated: true });
  expect((interpreterContext(w).continuityIssues as Array<{ unitId: string }>).map((issue) => issue.unitId)).toEqual(["SMS"]);
});

test("M9-AC12：解读模型对某段拿不准留下的待定记录只在当次有效：同一份草稿再请批准时不算以前的决定、不交给解读模型，一次明确批准即生效", async () => {
  const w = await world(), created = await w.create(), { input } = await w.request(created);
  w.capture("两处我都批准"); scriptReview(w.provider, (c) => {
    const unsure = phoneReview(c);
    unsure.faithful = false; Object.assign(unsure.entries[1]!, { kind: "unresolved", basis: "uncertain", resolution: "unclear" }); unsure.entries.splice(5, 1);
    return unsure;
  });
  expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ prdActivated: false, blockedBy: "candidate_requires_revision_or_clarification" });
  w.capture("我批准登录这个需求的这一版"); scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ prdActivated: true });
  expect((interpreterContext(w).continuityIssues as Array<{ unitId: string }>).map((issue) => issue.unitId)).toEqual(["SMS"]);
});

test("M8D-AC6：解释器的对象说明里带有本窗口其他还没批准的草稿（标题与待批准版本），已批准的不列", async () => {
  const w = await world(), a = await w.create(), b = await w.create();
  await w.create();
  const first = await w.request(a), second = await w.request(b);
  w.capture("两处我都批准", "interactive", false); scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prdActivated: true });
  expect(interpreterContext(w).addressed).toEqual({ how: "window", otherDrafts: [{ title: "登录", version: 1 }, { title: "登录", version: 1 }] });
  w.capture("两处我都批准", "interactive", false); scriptReview(w.provider, phoneReview);
  await w.call({ action: "confirmUpdate", ...second.input });
  expect(interpreterContext(w).addressed).toEqual({ how: "window", otherDrafts: [{ title: "登录", version: 1 }] });
});

test("M9：用户说第一句话时守护进程还没连上，原话照样记下；连上后主代理能用这句话保存草稿", async () => {
  const w = await world();
  w.setReachable(false);
  expect(() => w.capture(PHONE, "interactive", false)).not.toThrow();
  w.setReachable(true);
  scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  expect(await w.call({ action: "create", summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY })).toMatchObject({ status: "created" });
});

test("M8D-AC3：没有确认任何正文段落的解读不留下决定记录，随后一次明确的批准照常生效", async () => {
  const w = await world(), created = await w.create(), { input } = await w.request(created);
  const decisions = () => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
  w.capture("两处我都批准"); scriptReview(w.provider, allPending);
  const blocked = await w.call({ action: "confirmUpdate", ...input });
  expect(blocked).toMatchObject({ prdActivated: false, blockedBy: "candidate_requires_revision_or_clarification", decisionIds: [] });
  expect((blocked as { blockedReason: string }).blockedReason).toMatch(/这次的解读里仍待定的段落：[^；]*手机号与邮箱/u);
  expect(decisions()).toEqual([]);
  w.capture("我批准登录这个需求的这一版"); scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ prdActivated: true });
});

test("M8D-AC3：解释器的上下文里带有程序认定的对象事实：@ 到的写 mention 与同一句话针对的其他需求数，批准窗口确认的写 window", async () => {
  const w = await world(), a = await w.create(), b = await w.create();
  const first = await w.request(a), second = await w.request(b);
  w.capture("两处我都批准"); scriptReview(w.provider, phoneReview);
  await w.call({ action: "confirmUpdate", ...first.input });
  expect(interpreterContext(w).addressed).toEqual({ how: "mention", others: 1, otherDrafts: [{ title: "登录", version: 1 }] });
  w.capture("批准登录", "interactive", false); scriptReview(w.provider, phoneReview);
  await w.call({ action: "confirmUpdate", ...second.input });
  expect(interpreterContext(w).addressed).toEqual({ how: "window" });
  expect(w.provider.requests.filter((r) => r.systemPrompt?.includes("需求解释器")).at(-1)!.systemPrompt).toContain("context.addressed");
});

test("批准登记到一半失败后又登记了新问题，草稿仍能继续保存，不会卡死在这一版", async () => {
  const w = await world(), created = await w.create(), { input } = await w.request(created);
  const storage = vi.spyOn(RequirementService.prototype, "confirmUpdate").mockRejectedValueOnce(new RequirementServiceError("stale_version", "模拟存储出错"));
  try {
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "stale_version" });
  } finally { storage.mockRestore(); }
  expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("approval_manifests_v1"))).toHaveLength(1);
  w.capture("再问我一下短信期限"); w.answerWindows(false);
  await w.call({ action: "ask", ...input, ...SMS_ASK, unitIds: ["SMS"] }, true);
  w.capture("短信验证码 5 分钟有效，写进草稿"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  const saved = await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version,
    summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" }).then((r) => r, (e: unknown) => e);
  expect(saved).toMatchObject({ status: "saved" });
});

test("M8D-AC3：一句话 @ 两个需求并批准，两个需求按各自的版本分别登记生效", async () => {
  const w = await world(), a = await w.create(), b = await w.create();
  const first = await w.request(a), second = await w.request(b);
  w.capture("两处我都批准");
  scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prdActivated: true });
  scriptReview(w.provider, phoneReview);
  const other = await w.call({ action: "confirmUpdate", ...second.input }).then((r) => r, (e: unknown) => e);
  expect(other).toMatchObject({ prdActivated: true });
  expect(w.windows).toHaveLength(0);
});

test("M8D-AC3：已批准的需求只改一段后再批准，解释器只确认改动的那段、把没改的段落列为待定，程序沿用原批准，更新照常生效", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  w.capture("同意"); scriptReview(w.provider, phoneReview);
  expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prdActivated: true });
  w.capture("验收补一条：手机号连续失败三次后锁定十分钟"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  const updated = await w.call({ action: "updateDraft", requirementId: first.input.requirementId, version: Number((await w.call({ action: "metadata", requirementId: first.input.requirementId })).version),
    summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "手机号连续失败三次后锁定十分钟。\n" });
  const next = await w.request(updated);
  w.capture("更新我确认，批准"); scriptReview(w.provider, (c) => {
    const base = phoneReview(c), entry = base.entries[0]!;
    const sms = base.entries.find((e) => e.kind === "unresolved")!, delegation = base.entries.find((e) => e.kind === "delegation")!;
    const untouched = c.partition.units.map((unit) => unit.id).filter((id) => !["acceptance", "SMS", "D"].includes(id));
    return { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: false, entries: [
      { ...entry, kind: "constraint", conclusion: "验收补充失败锁定", unitIds: ["acceptance"] }, sms, delegation,
      { ...entry, kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "其余段落这次没有重新确认", unitIds: untouched }] };
  });
  const outcome = await w.call({ action: "confirmUpdate", ...next.input }).then((r) => r, (e: unknown) => e);
  expect(outcome).toMatchObject({ prdActivated: true });
});

test("结果送达记录没有时间期限：工具结果登记两小时后才做送达核对，仍通过", async () => {
  let now = 1000;
  const w = await world({ now: () => now });
  const toolCallId = uuidv7();
  await w.manage.execute(toolCallId, { request: { repoId: w.repoId, action: "list" } } as never, undefined, undefined, w.ctx);
  now += TWO_HOURS;
  expect(() => w.interaction.assertDelivery(toolCallId, w.ctx)).not.toThrow();
  expect(() => w.interaction.assertDelivery(toolCallId, w.ctx)).toThrow();
});
test("翻页记号没有时间期限：拿到下一页记号两小时后再翻页仍成功", async () => {
  let now = 1000;
  const w = await world({ now: () => now }), created = await w.create("# 说明 {#A}\n" + "中文边界".repeat(2000)), requirementId = String(created.requirementId);
  const first = await w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024 });
  now += TWO_HOURS;
  const second = await w.call({ action: "next", requirementId, cursor: (first.coverage as { nextCursor: string }).nextCursor });
  expect(second.coverage).toMatchObject({ startByte: Buffer.byteLength(first.text as string) });
});
describe("草稿核验模型没有 60 秒时限", () => {
  /** 让 AbortSignal.timeout 跟着假计时器走，否则 Node 内部计时器不受假时钟影响。 */
  const followFakeTimers = () => vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  test("核验模型 2 分钟后才回答，草稿照常保存", async () => {
    const w = await world(), created = await w.create();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = followFakeTimers();
    try {
      w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}', chunkDelayMs: 120_000 }]);
      const count = w.provider.requests.length;
      const pending = w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version),
        summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充邮箱约束。\n" });
      const settled = expect(pending).resolves.toMatchObject({ requirementId: created.requirementId });
      while (w.provider.requests.length === count) await new Promise((r) => setImmediate(r));
      for (let elapsed = 0; elapsed <= 130_000; elapsed += 1000) await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await settled;
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  test("核验模型很慢时用户取消（ctx.signal 中止）仍能中止", async () => {
    const w = await world(), created = await w.create(), abort = new AbortController();
    w.capture(); (w.ctx as { signal?: AbortSignal }).signal = abort.signal; scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}', chunkDelayMs: 120_000 }]);
    const count = w.provider.requests.length;
    const pending = w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version),
      summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充邮箱约束。\n" });
    const rejected = expect(pending).rejects.toThrow();
    while (w.provider.requests.length === count) await new Promise((r) => setTimeout(r, 1));
    abort.abort();
    await rejected;
  });
});

const PROTOTYPE_HTML = "<!doctype html><html><body><h1>设置页</h1></body></html>";
type World = Awaited<ReturnType<typeof world>>;
const boardRef = (w: World) => ({ dataRoot: w.dataRoot, repoId: w.repoId });

async function designed(w: World, requirementId: string, name: string, reworks = 0) {
  for (let round = 0; round <= reworks; round++) {
    const runId = uuidv7(), accept = round === reworks;
    await beginDesign(boardRef(w), { requirementId, name, runId, agent: "designer" });
    await submitDesign(boardRef(w), { requirementId, name, runId, html: PROTOTYPE_HTML, note: "三项状态横排" });
    const pending = await pendingConfirmation(boardRef(w), { requirementId, name });
    await decidePrototype(boardRef(w), { requirementId, name, version: pending.version, hash: pending.hash,
      choice: accept ? "accept" : "rework", opinion: accept ? null : "再改一版" });
  }
}

async function updatedBody(w: World, requirementId: string, body: string) {
  w.capture("补一句"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  const meta = await w.call({ action: "metadata", requirementId });
  const updated = await w.call({ action: "updateDraft", requirementId, version: Number(meta.version),
    summary: "手机号登录，保留邮箱登录", title: "登录", body });
  return { operationId: String(updated.operationId), version: Number(updated.version) };
}

async function approvedSaved(w: World, requirementId: string, saved: { operationId: string; version: number }) {
  const { input } = await w.request({ requirementId, operationId: saved.operationId, version: saved.version });
  w.capture("同意"); scriptReview(w.provider, phoneReview);
  return w.call({ action: "confirmUpdate", ...input });
}

const fresh = (created: Record<string, unknown>) => ({ operationId: String(created.operationId), version: Number(created.version) });
const summaryOf = (items: Array<{ name: string; version: number }>) => items.map((item) => `${item.name}:${item.version}`).sort();

/** 让批准窗口里的绿色、红色、灰色行带上标记，便于核对颜色。 */
function markTones(w: World) {
  const ui = w.ctx.ui as unknown as { custom: (factory: (...args: unknown[]) => unknown) => Promise<unknown> };
  const original = ui.custom.bind(ui);
  const marked = { bold: (text: string) => text, fg: (kind: string, text: string) => ["toolDiffAdded", "toolDiffRemoved", "muted"].includes(kind) ? `<${kind}>${text}</${kind}>` : text };
  ui.custom = (factory) => original((tui: unknown, _theme: unknown, keybindings: unknown, done: unknown) => factory(tui, marked, keybindings, done));
}

describe("批准时连同草稿里的原型一起批准", () => {
  test("草稿里有等确认和设计中的原型时，带 @ 和不带 @ 的批准都被拒，不弹窗，原因逐个写出名称和状态", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    const runId = uuidv7();
    await beginDesign(boardRef(w), { requirementId: id, name: "设置页", runId, agent: "designer" });
    await submitDesign(boardRef(w), { requirementId: id, name: "设置页", runId, html: PROTOTYPE_HTML, note: "说明" });
    await beginDesign(boardRef(w), { requirementId: id, name: "命令行输出", runId: uuidv7(), agent: "designer" });
    const before = await readPrototypeBoard(boardRef(w), id);
    for (const mention of [true, false]) {
      w.capture("同意", "interactive", mention);
      const error = await w.call({ action: "confirmUpdate", ...(await w.request(created)).input }).then(() => { throw new Error("批准没有被拒"); }, (caught: unknown) => caught as Error);
      expect(error.message).toContain("原因：还不能批准：");
      expect(error.message).toContain("原型「设置页」第 1 版还在等你确认");
      expect(error.message).toContain("原型「命令行输出」设计师还在做");
      expect(error.message).toContain("建议：先把这 2 份处理完（通过、返工或放弃），再说批准");
    }
    expect(w.windows).toHaveLength(0);
    expect(await readPrototypeBoard(boardRef(w), id)).toEqual(before);
  });

  test("草稿里只有一份在途原型时，建议写先把它处理完", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await beginDesign(boardRef(w), { requirementId: id, name: "设置页", runId: uuidv7(), agent: "designer" });
    w.capture("同意");
    const error = await w.call({ action: "confirmUpdate", ...(await w.request(created)).input }).then(() => { throw new Error("批准没有被拒"); }, (caught: unknown) => caught as Error);
    expect(error.message).toContain("原因：还不能批准：原型「设置页」设计师还在做");
    expect(error.message).toContain("建议：先把它处理完（通过、返工或放弃），再说批准");
  });

  test("原型名称很长时，名称和第几版之间仍至少隔两个空格", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "设置页深色模式外观");
    await approvedSaved(w, id, fresh(created));
    expect(w.windows[0]!.text).toMatch(/ {2}设置页深色模式外观 {2,}第 1 版 {2}本次新确认/);
  });

  test("首次批准时窗口的原型清单只有新确认的，确认后第 1 版快照记下它，看板 approved 更新、draft 清空", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    markTones(w);
    await designed(w, id, "设置页", 1);
    expect(await approvedSaved(w, id, fresh(created))).toMatchObject({ prdActivated: true });
    expect(w.windows).toHaveLength(1);
    expect(w.windows[0]!.text).toContain([
      " 这一版一起批准的原型（1 份）：",
      " <toolDiffAdded>  设置页        第 2 版  本次新确认</toolDiffAdded>",
      " <muted>原型的样子以你在浏览器里通过的那一版为准。</muted>",
    ].join("\n"));
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 1))).toEqual(["设置页:2"]);
    const entry = (await readPrototypeBoard(boardRef(w), id)).entries.find((item) => item.name === "设置页")!;
    expect(entry.approved?.version).toBe(2);
    expect(entry.draft).toBeNull();
  });

  test("新确认、沿用、移除三类原型的清单在带 @ 时也弹窗，逐行对得上预览；取消后看板不变，确认后快照只含新确认与沿用", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    markTones(w);
    await designed(w, id, "命令行输出"); await designed(w, id, "旧外观弹窗");
    await approvedSaved(w, id, fresh(created));
    await approvedSaved(w, id, await updatedBody(w, id, BODY + "第二版补充。\n"));
    expect(w.windows).toHaveLength(2);
    expect(w.windows[1]!.text).toContain([
      " 这一版一起批准的原型（2 份）：",
      "   命令行输出    第 1 版  沿用第 1 版需求",
      "   旧外观弹窗    第 1 版  沿用第 1 版需求",
    ].join("\n"));
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 2))).toEqual(["命令行输出:1", "旧外观弹窗:1"]);

    await designed(w, id, "设置页", 2);
    await removeFromDraft(boardRef(w), { requirementId: id, name: "旧外观弹窗", version: 1 });
    const saved = await updatedBody(w, id, BODY + "第二版补充。\n第三版补充。\n");
    const before = await readPrototypeBoard(boardRef(w), id);
    w.answerWindows(false);
    const { input } = await w.request({ requirementId: id, operationId: saved.operationId, version: saved.version });
    w.capture("同意");
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "decision_declined" });
    expect(await readPrototypeBoard(boardRef(w), id)).toEqual(before);
    expect(await prototypesAtRevision(boardRef(w), id, 3)).toEqual([]);

    w.answerWindows(true);
    expect(await approvedSaved(w, id, saved)).toMatchObject({ prdActivated: true });
    const shown = w.windows.at(-1)!.text;
    expect(shown).toContain("需求：登录（第 3 版）");
    expect(shown).toContain([
      " 这一版一起批准的原型（2 份）：",
      " <toolDiffAdded>  设置页        第 3 版  本次新确认</toolDiffAdded>",
      "   命令行输出    第 1 版  沿用第 2 版需求",
      " <toolDiffRemoved>  旧外观弹窗    第 1 版  本次移除</toolDiffRemoved>",
      " <muted>原型的样子以你在浏览器里通过的那一版为准。</muted>",
    ].join("\n"));
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 3))).toEqual(["命令行输出:1", "设置页:3"]);
    const entries = (await readPrototypeBoard(boardRef(w), id)).entries;
    expect(entries.every((item) => item.draft === null)).toBe(true);
    expect(entries.find((item) => item.name === "设置页")!.approved?.version).toBe(3);
    expect(entries.find((item) => item.name === "命令行输出")!.approved?.version).toBe(1);
    expect(entries.find((item) => item.name === "旧外观弹窗")!.approved).toBeNull();
    const diff = String(interpreterContext(w).candidates[0].diff);
    expect(diff).toContain("第三版补充");
    expect(diff).not.toContain("正文没有差异。");
    expect(diff).toContain("原型变化：设置页 新确认第 3 版；旧外观弹窗 移除");
  });

  test("没有任何原型的需求，带 @ 批准不弹窗，不带 @ 弹的窗口没有原型清单", async () => {
    const w = await world(), created = await w.create(), { input } = await w.request(created);
    w.capture("同意", "interactive", false); w.answerWindows(false);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "decision_declined" });
    expect(w.windows).toHaveLength(1);
    expect(w.windows[0]!.text).not.toContain("这一版一起批准的原型");
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ prdActivated: true });
    expect(w.windows).toHaveLength(1);
  });

  test("窗口显示之后、写入之前草稿里的原型变了，批准被拒，看板不提升、不写快照", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "设置页");
    w.beforeAnswer(async () => { await designed(w, id, "另一份"); });
    const { input } = await w.request(created);
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toThrow("原型在批准过程中变了");
    const entries = (await readPrototypeBoard(boardRef(w), id)).entries;
    expect(entries.map((item) => item.approved)).toEqual([null, null]);
    expect(await prototypesAtRevision(boardRef(w), id, 1)).toEqual([]);

    w.beforeAnswer(async () => {});
    expect(await approvedSaved(w, id, await updatedBody(w, id, BODY + "补一句。\n"))).toMatchObject({ prdActivated: true });
    const shown = w.windows.at(-1)!.text;
    expect(shown).toContain("这一版一起批准的原型（2 份）：");
    expect(shown).toContain("另一份");
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 1))).toEqual(["另一份:1", "设置页:1"]);
  });

  test("正文没改、只改了原型时，用 metadata 给的保存操作编号就能批准，版本加 1，解读模型的差异文字写明正文没有差异并带原型变化", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await approvedSaved(w, id, fresh(created));
    await designed(w, id, "设置页");
    const meta = await w.call({ action: "metadata", requirementId: id });
    expect(meta.savedOperationId).toBe(created.operationId);
    expect(meta.revision).toBe(1);
    expect(await approvedSaved(w, id, { operationId: String(meta.savedOperationId), version: Number(meta.version) })).toMatchObject({ prdActivated: true });
    expect((await w.call({ action: "metadata", requirementId: id })).revision).toBe(2);
    const diff = String(interpreterContext(w).candidates[0].diff);
    expect(diff).toContain("正文没有差异。");
    expect(diff).toContain("原型变化：设置页 新确认第 1 版");
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 2))).toEqual(["设置页:1"]);
  });

  test("只改正文再批准，新快照沿用上一版的原型，差异文字里没有原型变化", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "设置页");
    await approvedSaved(w, id, fresh(created));
    await approvedSaved(w, id, await updatedBody(w, id, BODY + "第二版补充。\n"));
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 2))).toEqual(["设置页:1"]);
    const diff = String(interpreterContext(w).candidates[0].diff);
    expect(diff).toContain("第二版补充");
    expect(diff).not.toContain("原型变化");
  });
});

describe("批准时核对原型文件和在途原型", () => {
  const filePath = (w: World, requirementId: string, name: string, version: number) => prototypeFilePath(boardRef(w), { requirementId, name, version });
  const rejected = (run: Promise<unknown>) => run.then(() => { throw new Error("批准没有被拒"); }, (caught: unknown) => caught as Error);
  const tamper = {
    "内容被改": (path: string) => writeFileSync(path, PROTOTYPE_HTML + "<!-- 偷偷改了 -->"),
    "文件被删": (path: string) => rmSync(path),
  };

  for (const [kind, damage] of Object.entries(tamper)) {
    test(`弹窗前发现新确认的原型${kind}：不弹窗，原因写出哪份原型第几版并建议重新派设计师或移除，草稿和看板不变`, async () => {
      const w = await world(), created = await w.create(), id = String(created.requirementId);
      await designed(w, id, "设置页");
      damage(filePath(w, id, "设置页", 1));
      const before = await readPrototypeBoard(boardRef(w), id);
      w.capture("同意");
      const error = await rejected(w.call({ action: "confirmUpdate", ...(await w.request(created)).input }));
      expect(error.message).toContain("设置页");
      expect(error.message).toContain("第 1 版");
      expect(error.message).toContain("重新派");
      expect(error.message).toContain("移除");
      expect(w.windows).toHaveLength(0);
      expect(await readPrototypeBoard(boardRef(w), id)).toEqual(before);
    });

    test(`弹窗前发现沿用的原型${kind}：不弹窗，批准被拒，看板不变`, async () => {
      const w = await world(), created = await w.create(), id = String(created.requirementId);
      await designed(w, id, "设置页");
      await approvedSaved(w, id, fresh(created));
      damage(filePath(w, id, "设置页", 1));
      const saved = await updatedBody(w, id, BODY + "第二版补充。\n");
      const before = await readPrototypeBoard(boardRef(w), id);
      const { input } = await w.request({ requirementId: id, operationId: saved.operationId, version: saved.version });
      w.capture("同意");
      const error = await rejected(w.call({ action: "confirmUpdate", ...input }));
      expect(error.message).toContain("设置页");
      expect(error.message).toContain("第 1 版");
      expect(w.windows).toHaveLength(1);
      expect(await readPrototypeBoard(boardRef(w), id)).toEqual(before);
      expect(await prototypesAtRevision(boardRef(w), id, 2)).toEqual([]);
    });

    test(`窗口显示后写入前原型${kind}：拒绝写入，看板不提升、不写快照`, async () => {
      const w = await world(), created = await w.create(), id = String(created.requirementId);
      await designed(w, id, "设置页");
      w.beforeAnswer(async () => { damage(filePath(w, id, "设置页", 1)); });
      const { input } = await w.request(created);
      w.capture("同意"); scriptReview(w.provider, phoneReview);
      const error = await rejected(w.call({ action: "confirmUpdate", ...input }));
      expect(error.message).toContain("设置页");
      expect(error.message).toContain("第 1 版");
      expect(error.message).toContain("重新派");
      expect(w.windows).toHaveLength(1);
      const entry = (await readPrototypeBoard(boardRef(w), id)).entries.find((item) => item.name === "设置页")!;
      expect(entry.approved).toBeNull();
      expect(entry.draft).not.toBeNull();
      expect(await prototypesAtRevision(boardRef(w), id, 1)).toEqual([]);
    });
  }

  test("本次标为移除的原型文件被改，不影响批准", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "命令行输出"); await designed(w, id, "旧外观弹窗");
    await approvedSaved(w, id, fresh(created));
    await removeFromDraft(boardRef(w), { requirementId: id, name: "旧外观弹窗", version: 1 });
    tamper["内容被改"](filePath(w, id, "旧外观弹窗", 1));
    expect(await approvedSaved(w, id, await updatedBody(w, id, BODY + "第二版补充。\n"))).toMatchObject({ prdActivated: true });
    expect(summaryOf(await prototypesAtRevision(boardRef(w), id, 2))).toEqual(["命令行输出:1"]);
  });

  test("窗口显示后又有一版设计中，写入被拒，原因写出名称和设计师还在做，不说原型变了", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "设置页");
    w.beforeAnswer(async () => { await beginDesign(boardRef(w), { requirementId: id, name: "另一份", runId: uuidv7(), agent: "designer" }); });
    const { input } = await w.request(created);
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    const error = await rejected(w.call({ action: "confirmUpdate", ...input }));
    expect(error.message).toContain("原型「另一份」设计师还在做");
    expect(error.message).toMatch(/通过|返工|放弃/);
    expect(error.message).not.toContain("在批准过程中变了");
    expect(await prototypesAtRevision(boardRef(w), id, 1)).toEqual([]);
  });

  test("窗口显示后又有一版进入等确认，写入被拒，原因写出名称和第几版还在等你确认", async () => {
    const w = await world(), created = await w.create(), id = String(created.requirementId);
    await designed(w, id, "设置页");
    w.beforeAnswer(async () => {
      const runId = uuidv7();
      await beginDesign(boardRef(w), { requirementId: id, name: "另一份", runId, agent: "designer" });
      await submitDesign(boardRef(w), { requirementId: id, name: "另一份", runId, html: PROTOTYPE_HTML, note: "说明" });
    });
    const { input } = await w.request(created);
    w.capture("同意"); scriptReview(w.provider, phoneReview);
    const error = await rejected(w.call({ action: "confirmUpdate", ...input }));
    expect(error.message).toContain("原型「另一份」第 1 版还在等你确认");
    expect(error.message).not.toContain("在批准过程中变了");
    expect(await prototypesAtRevision(boardRef(w), id, 1)).toEqual([]);
  });
});

describe("编号由程序生成", () => {
  const allowDrafts = (w: World) => { w.provider.awaitReply = async () => ({ type: "text", text: '{"allow":true}' }); };
  const draft = (created: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ action: "updateDraft", requirementId: String(created.requirementId),
    version: Number(created.version), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充一句。\n", ...extra });
  const stateOf = async (w: World) => RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });

  /** 让第一次登记保存版本失败，留下一次没做完的保存，返回它的操作编号。 */
  async function leaveUnfinishedUpdate(w: World, created: Record<string, unknown>) {
    const original = RequirementOperations.prototype.recordSavedVersion;
    const spy = vi.spyOn(RequirementOperations.prototype, "recordSavedVersion").mockImplementationOnce(() => { throw new Error("injected saved-version log failure"); }).mockImplementation(original);
    try { w.capture(); await expect(w.call(draft(created))).rejects.toThrow(); } finally { spy.mockRestore(); }
    const unfinished = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list(REQUIREMENT_OPERATION_NAMESPACE))
      .filter((row) => (row.data as { action: string; finalVersion: number | null }).action === "updateDraft" && (row.data as { finalVersion: number | null }).finalVersion === null);
    expect(unfinished).toHaveLength(1);
    return (unfinished[0]!.data as { operationId: string }).operationId;
  }

  test("create不带requestId与operationId也成功，结果带需求编号和合规的操作编号；带requestId被拒", async () => {
    const w = await world(), created = await w.create();
    expect(created.requirementId).toMatch(UUID_V7_PATTERN);
    expect(created.operationId).toMatch(UUID_V7_PATTERN);
    w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await expect(w.call({ action: "create", requestId: uuidv7(), summary: "简介", title: "另一个", body: BODY })).rejects.toMatchObject({ code: "invalid_shape" });
  });

  test("同一需求连续两次不带编号updateDraft：操作编号不同，版本号依次加一", async () => {
    const w = await world(), created = await w.create();
    allowDrafts(w);
    w.capture("补一句"); const first = await w.call(draft(created, { body: BODY + "第一句。\n" }));
    w.capture("再补一句"); const second = await w.call(draft(created, { version: Number(first.version), body: BODY + "第二句。\n" }));
    expect(first.operationId).toMatch(UUID_V7_PATTERN);
    expect(second.operationId).toMatch(UUID_V7_PATTERN);
    expect(second.operationId).not.toBe(first.operationId);
    expect(Number(first.version)).toBe(Number(created.version) + 1);
    expect(Number(second.version)).toBe(Number(first.version) + 1);
  });

  test("confirmUpdate与reply不带编号：结果带程序生成的操作编号", async () => {
    const w = await world(), first = await w.request(await w.create()), second = await w.request(await w.create());
    scriptReview(w.provider, phoneReview);
    w.capture("两处我都批准"); const confirmed = await w.call({ action: "confirmUpdate", ...first.input });
    expect(confirmed.operationId).toMatch(UUID_V7_PATTERN);
    expect(confirmed.operationId).not.toBe(first.input.savedOperationId);
    w.capture("两处我都批准"); const replied = await w.call({ action: "reply", ...second.input }, true);
    expect(replied.operationId).toMatch(UUID_V7_PATTERN);
  });

  async function leaveUnfinishedCreate(w: World, params: Record<string, unknown>) {
    const original = RequirementOperations.prototype.recordGitResult;
    const spy = vi.spyOn(RequirementOperations.prototype, "recordGitResult").mockImplementationOnce(() => { throw new Error("injected git-result log failure"); }).mockImplementation(original);
    try { w.capture(); await expect(w.call(params)).rejects.toThrow(); } finally { spy.mockRestore(); }
    const pending = new RequirementOperations({ dataRoot: w.dataRoot, repoId: w.repoId }).pendingCreate(requirementIntentHash({ title: String(params.title), body: String(params.body) }));
    expect(pending).not.toBeNull();
    return pending!;
  }
  const createParams = (extra: Record<string, unknown> = {}) => ({ action: "create", summary: "短信登录", title: "短信登录需求", body: BODY, ...extra });
  const creates = (w: World) => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list(REQUIREMENT_OPERATION_NAMESPACE))
    .filter((row) => (row.data as { action: string }).action === "create");
  const reasonOf = (error: unknown) => `${(error as Error).message}\n${adviceOf(error)?.why ?? ""}\n${adviceOf(error)?.next ?? ""}`;

  test("create 与 updateDraft 带 operationId 被拒为参数不合格；create 带 requestId 同样被拒", async () => {
    const w = await world(), created = await w.create();
    w.capture();
    await expect(w.call(createParams({ operationId: uuidv7() }))).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(w.call(createParams({ requestId: uuidv7() }))).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(w.call(draft(created, { operationId: uuidv7() }))).rejects.toMatchObject({ code: "invalid_shape" });
  });

  test("没做完的保存留着时，用原来的标题和正文再调一次 updateDraft（不带编号）：沿用原操作编号，保存完成，需求解锁", async () => {
    const w = await world(), created = await w.create();
    allowDrafts(w);
    const unfinished = await leaveUnfinishedUpdate(w, created);
    w.capture(); const resumed = await w.call(draft(created));
    expect(resumed).toMatchObject({ status: "saved", operationId: unfinished });
    expect(Number(resumed.version)).toBeGreaterThan(Number(created.version));
    w.capture(); const next = await w.call(draft(created, { version: Number(resumed.version), body: BODY + "解锁后的新内容。\n" }));
    expect(next).toMatchObject({ status: "saved" });
    expect(next.operationId).not.toBe(unfinished);
  });

  test("续做 updateDraft 只留一次正文提交", async () => {
    const w = await world(), created = await w.create();
    allowDrafts(w);
    await leaveUnfinishedUpdate(w, created);
    const repo = prdRequirementPath({ dataRoot: w.dataRoot, repoId: w.repoId, requirementId: String(created.requirementId) });
    const commits = async () => (await promisify(execFile)("git", ["-C", repo, "rev-list", "--count", "HEAD"])).stdout.trim();
    const before = await commits();
    w.capture(); await w.call(draft(created));
    expect(await commits()).toBe(before);
  });

  test("需求挂着一次没做完的 create 时调 updateDraft：被拒，建议用原来的动作续完", async () => {
    const w = await world(), state = await stateOf(w);
    allowDrafts(w);
    const pending = await leaveUnfinishedCreate(w, createParams());
    w.capture();
    const error = await w.call({ action: "updateDraft", requirementId: pending.requirementId, version: state.read(pending.requirementId).version,
      summary: "短信登录", title: "短信登录需求", body: BODY }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(reasonOf(error)).toContain("这个需求还有一次没完成的保存");
    expect(reasonOf(error)).toContain("原来的动作");
  });

  test("create 时填了不属于本窗口的仓库编号：先按仓库鉴权拒绝，不建出那个仓库的库", async () => {
    const w = await world();
    w.capture();
    const foreign = "e".repeat(64);
    await expect(w.call({ ...createParams(), repoId: foreign })).rejects.toThrow();
    await expect(stat(repositoryDatabase(w.dataRoot, foreign))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("没做完的 updateDraft 后用不同内容再调 updateDraft：被拒并写明还有一次没完成的保存，需求状态不变", async () => {
    const w = await world(), created = await w.create(), other = await w.create(), state = await stateOf(w);
    allowDrafts(w);
    await leaveUnfinishedUpdate(w, created);
    const before = [state.read(String(created.requirementId)), state.read(String(other.requirementId))];
    for (const extra of [{ title: "登录改名" }, { body: BODY + "别的内容。\n" }]) {
      w.capture(); const error = await w.call(draft(created, { version: state.read(String(created.requirementId)).version, ...extra })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(reasonOf(error)).toContain("这个需求还有一次没完成的保存");
      expect(reasonOf(error)).toContain("内容和这次不同");
      expect(reasonOf(error)).not.toContain("在 operationId 填");
      expect(reasonOf(error)).not.toContain("原操作编号");
    }
    expect([state.read(String(created.requirementId)), state.read(String(other.requirementId))]).toEqual(before);
  });

  test("本仓库有一次没做完的 create，标题和正文相同再调 create：续完原需求，不另建需求", async () => {
    const w = await world();
    allowDrafts(w);
    const pending = await leaveUnfinishedCreate(w, createParams());
    const before = creates(w).length;
    w.capture(); const resumed = await w.call(createParams());
    expect(resumed).toMatchObject({ status: "created", operationId: pending.operationId, requirementId: pending.requirementId });
    expect(creates(w)).toHaveLength(before);
  });

  test("没做完的 create 后标题或正文不同再调 create：新建另一个需求成功", async () => {
    const w = await world();
    allowDrafts(w);
    const pending = await leaveUnfinishedCreate(w, createParams());
    const before = creates(w).length;
    for (const extra of [{ title: "另一个标题" }, { body: BODY + "多一句。\n" }]) {
      w.capture(); const other = await w.call(createParams(extra));
      expect(other).toMatchObject({ status: "created" });
      expect(other.requirementId).not.toBe(pending.requirementId);
      expect(other.operationId).not.toBe(pending.operationId);
    }
    expect(creates(w)).toHaveLength(before + 2);
  });

  test("为某份内容占好了需求编号、保存还没开始时，原样再调 create：用占好的编号建出需求，库里只有这一个需求", async () => {
    const w = await world();
    allowDrafts(w);
    const state = await stateOf(w);
    const reserved = state.reserve({ requestId: uuidv7(), intentHash: requirementIntentHash({ title: "短信登录需求", body: BODY }) });
    const rows = () => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("requirements"));
    expect(rows()).toHaveLength(1);
    w.capture(); const resumed = await w.call(createParams());
    expect(resumed).toMatchObject({ status: "created", requirementId: reserved.id });
    expect(rows()).toHaveLength(1);
  });

  test("为某份内容占好的需求编号随后已被关闭，原样再调 create：不用这个编号，另建一个需求成功", async () => {
    const w = await world();
    allowDrafts(w);
    const state = await stateOf(w);
    const reserved = state.reserve({ requestId: uuidv7(), intentHash: requirementIntentHash({ title: "短信登录需求", body: BODY }) });
    state.beginClose({ requirementId: reserved.id, version: state.read(reserved.id).version, intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    expect(state.read(reserved.id).data.lifecycle).not.toBe("draft");
    w.capture(); const again = await w.call(createParams());
    expect(again).toMatchObject({ status: "created" });
    expect(again.requirementId).not.toBe(reserved.id);
  });

  test("占好编号但保存没开始时，内容不同的 create 照常新建另一个需求", async () => {
    const w = await world();
    allowDrafts(w);
    const state = await stateOf(w);
    const reserved = state.reserve({ requestId: uuidv7(), intentHash: requirementIntentHash({ title: "短信登录需求", body: BODY }) });
    w.capture(); const other = await w.call(createParams({ title: "另一个标题" }));
    expect(other).toMatchObject({ status: "created" });
    expect(other.requirementId).not.toBe(reserved.id);
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("requirements"))).toHaveLength(2);
  });

  test("pendingSave 与 pendingCreate：返回没做完的保存记录，没有或已做完返回 null", async () => {
    const w = await world(), created = await w.create();
    allowDrafts(w);
    const operations = new RequirementOperations({ dataRoot: w.dataRoot, repoId: w.repoId });
    const hash = requirementIntentHash({ title: "短信登录需求", body: BODY });
    expect(operations.pendingSave(String(created.requirementId))).toBeNull();
    expect(operations.pendingCreate(hash)).toBeNull();
    const unfinished = await leaveUnfinishedUpdate(w, created);
    expect(operations.pendingSave(String(created.requirementId))).toMatchObject({ operationId: unfinished, action: "updateDraft", finalVersion: null });
    expect(operations.pendingSave(uuidv7())).toBeNull();
    const pendingCreate = await leaveUnfinishedCreate(w, createParams());
    expect(operations.pendingCreate(hash)).toMatchObject({ operationId: pendingCreate.operationId, action: "create", finalVersion: null });
    expect(operations.pendingSave(pendingCreate.requirementId)).toMatchObject({ operationId: pendingCreate.operationId, action: "create" });
    expect(operations.pendingCreate(requirementIntentHash({ title: "别的", body: BODY }))).toBeNull();
    w.capture(); await w.call(createParams());
    expect(operations.pendingCreate(hash)).toBeNull();
    expect(operations.pendingSave(pendingCreate.requirementId)).toBeNull();
  });
});

test("填了不属于本窗口的仓库编号：先按仓库鉴权拒绝，不在本机建出这个仓库的库", async () => {
  const w = await world();
  w.capture("改一下需求");
  const foreign = "f".repeat(64);
  await expect(w.call({ repoId: foreign, action: "updateDraft", requirementId: uuidv7(), version: 1, summary: "手机号登录", title: "登录", body: BODY })).rejects.toThrow();
  await expect(stat(repositoryDatabase(w.dataRoot, foreign))).rejects.toMatchObject({ code: "ENOENT" });
});
