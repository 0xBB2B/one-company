import { afterEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRegistry, ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { MainRequirementInteraction } from "../runtime/main-requirement-interaction.ts";
import { UserInteractionCore } from "../runtime/user-interaction.ts";
import { RequirementOperations } from "../runtime/requirement-operations.ts";
import type { MainRequirementInteractionOptions } from "../runtime/main-requirement-interaction.ts";
import { createRequirementManageTool } from "../runtime/requirement-manage-tool.ts";
import { createUserInteractTool } from "../runtime/user-interact-tool.ts";
import { RequirementService } from "../runtime/requirement-service.ts";
import { RequirementServiceError } from "../runtime/requirement-manage-contracts.ts";
import { RequirementStateStore } from "../runtime/requirement-state.ts";
import { resolveRepositoryRequirementDoc } from "../runtime/requirement-doc.ts";
import type { ConfirmationContext } from "../runtime/requirement-manage-contracts.ts";
import type { Static } from "typebox";
import { ModelInterpretation } from "../runtime/interaction-derivation.ts";
import { requirementSummary } from "../runtime/requirement-summary.ts";
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
async function world(options: Pick<MainRequirementInteractionOptions, "now" | "inputTtlMs"> = {}) {
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
  let windowAnswer: WindowDecision = true;
  const ctx = { cwd: repositoryRoot, mode: "tui", hasUI: true, modelRegistry: registry, model,
    ui: { notify: (text: string) => notifications.push(text), confirm: () => { throw new Error("UI.confirm forbidden"); },
      ...answeringUi((window) => { windows.push(window); return windowAnswer; }) },
    sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  const interaction = new MainRequirementInteraction({ ...options, dataRoot, authorization,
    resolveHost: () => ({ windowId, sessionId, repositories: new Map([[repoId, { path: repositoryRoot }]]) }) });
  cleanup.push(async () => { interaction.dispose(); authorization.shutdown(); await rm(root, { recursive: true, force: true }); });
  const manage = createRequirementManageTool({ interaction }), user = createUserInteractTool({ interaction });
  const call = async (params: Record<string, unknown>, userTool = false) => {
    const toolCallId = uuidv7();
    const result = await (userTool ? user : manage).execute(toolCallId, { request: { repoId, ...params } } as never, undefined, undefined, ctx);
    interaction.assertDelivery(toolCallId, ctx); return result.details!;
  };
  const mentioned: string[] = [];
  /** 模拟用户这句话 @ 了已建的需求；mention=false 时原样输入。 */
  const capture = (text = PHONE, source = "interactive", rpc = false, mention = true) =>
    interaction.captureInput({ source, text: (mention ? mentioned.map((id) => `@[登录#${id.slice(-4)}] `).join("") : "") + text }, ctx, rpc);
  const service = await RequirementService.open({ dataRoot, repositoryRoot, repoId, authorize: () => true });
  const create = async (body = BODY) => {
    capture(); scriptReplies(provider, [{ type: "text", text: '{"allow":true}' }]);
    const created = await call({ action: "create", requestId: uuidv7(), operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body });
    mentioned.push(String(created.requirementId));
    return created;
  };
  const request = async (created: Record<string, unknown>, operationId = uuidv7()) => {
    const input = { requirementId: String(created.requirementId), savedOperationId: String(created.operationId), operationId, version: Number(created.version) };
    return { input, loaded: await service.loadConfirmationContext({ requirementId: input.requirementId, savedOperationId: input.savedOperationId, operationId }) };
  };
  return { root, repositoryRoot, dataRoot, repoId, sessionId, authorization, ctx, interaction, provider, call, capture, create, request, service, notifications, manage,
    windows, answerWindows: (answer: WindowDecision) => { windowAnswer = answer; } };
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

/** 任意正文的整份确认：targetId 是目标，其余单位按格式与约束确认，授权只分析。 */
function wholeReview(c: Pick<ConfirmationContext, "candidate" | "partition">, targetId = "A"): Static<typeof ModelInterpretation> {
  const base = (kind: "constraint" | "target" | "action", conclusion: string, unitIds: string[]) => ({ kind, conclusion, scope: kind === "action" ? "只分析，不修改代码" : "当前登录需求",
    basis: "explicit" as const, resolution: "direct" as const, candidateId: c.candidate.candidateId, requestId: null, actions: kind === "action" ? ["analyze" as const] : [], references: [], supersedes: [], unitIds });
  const others = c.partition.units.map((unit) => unit.id).filter((id) => id !== targetId);
  return { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: true,
    entries: [base("constraint", "需求身份、标题与格式板块", others), base("target", "增加手机号登录", [targetId]), base("action", "本轮授权动作", [targetId])] };
}

/** 用户层把两个内部调用设成跟主会话模型、不思考，供拦截 complete 调用的用例使用。 */
async function plainInternalModels(root: string) {
  await mkdir(join(root, "agents"), { recursive: true });
  for (const role of ["interpreter", "draft-verifier"]) await writeFile(join(root, "agents", `${role}.md`), `---\nname: ${role}\ndescription: d\nrole: ${role}\nthinking: off\n---\n`);
}

describe("主窗口共享控制器的真实服务路径", () => {
  test("M8D-AC3：这句话 @ 到的需求直接按原话登记，不弹窗；没 @ 到时弹出批准窗口，显示需求名、版本与简介，取消即不登记不生效", async () => {
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    w.capture("同意", "interactive", false, false); w.answerWindows(false);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "decision_declined" });
    expect(w.windows).toHaveLength(1);
    expect(w.windows[0]!.title).toBe("批准需求");
    expect(w.windows[0]!.text).toContain("需求：登录（第 1 版）");
    expect(w.windows[0]!.text).toContain(`编号：${input.requirementId}`);
    expect(w.windows[0]!.text).toContain("简介：手机号登录，保留邮箱登录");
    expect(state.read(input.requirementId).data.lifecycle).toBe("draft");
    w.capture("同意"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    expect(await w.call({ action: "confirmUpdate", ...input })).toMatchObject({ targetRecorded: true, prodActivated: true });
    expect(w.windows).toHaveLength(1);
  });

  test("M8D-AC8：解释器按用户层内部定义的思考等级调用；草稿核验器配置的模型不存在时写明原因，不改用主会话模型", async () => {
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    const agents = join(w.root, "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "interpreter.md"), `---\nname: interpreter\ndescription: d\nrole: interpreter\nmodel: ${w.provider.providerId}/${w.provider.modelId}\nthinking: low\n---\n`);
    w.capture("同意"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    const before = w.provider.reasoning.length;
    await w.call({ action: "confirmUpdate", ...input });
    expect(w.provider.reasoning.slice(before)).toEqual(["low"]);
    await writeFile(join(agents, "draft-verifier.md"), "---\nname: draft-verifier\ndescription: d\nrole: draft-verifier\nmodel: nowhere/missing\n---\n");
    w.capture("再建一个需求"); const calls = w.provider.requests.length;
    await expect(w.call({ action: "create", requestId: uuidv7(), operationId: uuidv7(), summary: "简介", title: "另一个", body: BODY }))
      .rejects.toMatchObject({ code: "internal_model_unavailable", message: expect.stringContaining("草稿核验器配置的模型 nowhere/missing 不可用：本机的模型配置里找不到模型 nowhere/missing") });
    expect(w.provider.requests.length).toBe(calls);
  });

  test("M8D-AC2：同一窗口可以处理多个需求，不需要绑定就能读取和修改其中任何一个的草稿", async () => {
    const w = await world(), first = await w.create(), second = await w.create();
    for (const created of [first, second]) {
      expect(await w.call({ action: "read", requirementId: created.requirementId, source: "saved" })).toMatchObject({ requirementId: created.requirementId });
      w.capture("补一句"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      expect(await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version, operationId: uuidv7(),
        summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补一句。\n" })).toMatchObject({ action: "updateDraft", requirementId: created.requirementId });
    }
  });

  test("M8D-AC1：@ 补全列出本窗口状态正常的草稿与进行中需求及当前草稿标题，改标题后列表跟着变", async () => {
    const w = await world(), created = await w.create();
    expect(await w.interaction.mentionCandidates(w.ctx)).toEqual([{ repoId: w.repoId, requirementId: created.requirementId, title: "登录", lifecycle: "draft" }]);
    w.capture("标题改一下"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version, operationId: uuidv7(),
      summary: "手机号登录，保留邮箱登录", title: "手机号登录", body: BODY });
    expect((await w.interaction.mentionCandidates(w.ctx)).map((item) => item.title)).toEqual(["手机号登录"]);
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
    await expect(w.call({ action: "create", requestId: uuidv7(), operationId: uuidv7(), title: "登录", body: BODY }))
      .rejects.toMatchObject({ code: "invalid_shape", message: expect.stringContaining("缺少字段：summary") });
    const created = await w.create();
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    const first = state.read(String(created.requirementId)).data.saved!.hash;
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), first)).toBe("手机号登录，保留邮箱登录");
    w.capture("再加一句"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: created.requirementId, version: created.version, operationId: uuidv7(), summary: "手机号验证码登录，邮箱登录照旧",
      title: "登录", body: BODY + "补充一句。\n" });
    const second = state.read(String(created.requirementId)).data.saved!.hash;
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), second)).toBe("手机号验证码登录，邮箱登录照旧");
    expect(requirementSummary(w.dataRoot, w.repoId, String(created.requirementId), first)).toBeUndefined();
  });

  test("普通问答、未来闲聊、伪来源、无输入、无模型均不能create；只读metadata不建空库", async () => {
    const w = await world(), input = { action: "create", requestId: uuidv7(), operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
    await expect(w.call(input)).rejects.toMatchObject({ code: "current_input_required" });
    for (const source of ["extension", "tool", "user", "rpc"]) { w.capture("想做登录", source); await expect(w.call(input)).rejects.toMatchObject({ code: "current_input_required" }); }
    for (const text of ["这个函数为什么这样写？", "也许明年做个登录吧"]) {
      w.capture(text); scriptReplies(w.provider, [{ type: "text", text: '{"allow":false}' }]);
      await expect(w.call(input)).rejects.toMatchObject({ code: "draft_interpretation_denied" });
    }
    w.capture(); const selected = w.ctx.model; Object.defineProperty(w.ctx, "model", { value: undefined, configurable: true });
    await expect(w.call(input)).rejects.toMatchObject({ code: "internal_model_unavailable" }); Object.defineProperty(w.ctx, "model", { value: selected });
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
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    await w.call({ action: "confirmUpdate", ...input });
    const prompts = w.provider.requests.map((request) => request.systemPrompt ?? "");
    const verifier = prompts.find((prompt) => prompt.includes("草拟意图核验器"))!, interpreter = prompts.find((prompt) => prompt.includes("需求解释器"))!;
    for (const prompt of [verifier, interpreter]) {
      expect(prompt).toContain("需求文档规范规定的板块与格式占位内容");
      expect(prompt).not.toMatch(/背景、需求、功能、实现、验收|五个板块/u);
    }
  });

  test("M9：用户按主代理的推荐作答后更新草稿，草稿核验器能看到本需求上提过的问题，提示词说明被采纳的那项才算用户决定", async () => {
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    w.capture(); w.answerWindows(false);
    await w.call({ action: "ask", ...input, operationId: uuidv7(), question: "短信验证码有效期选哪种？", rootCheck: "要定的是验证码多久失效，而不是另加重发限制",
      choices: [{ label: "5 分钟", reason: "更安全", recommended: true, recommendedReason: "常见做法，够用户收短信" }, { label: "10 分钟", reason: "信号差也来得及，但更容易被盗用" }], scope: "仅短信验证码期限",
      unitIds: [loaded.partition.units[1]!.id], actions: ["analyze"] }, true);
    w.capture("按你推荐的定，写进草稿"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
    const verifier = w.provider.requests.filter((request) => request.systemPrompt?.includes("草拟意图核验器")).at(-1)!;
    const payload = JSON.parse(String((verifier.messages[0] as { content: string }).content));
    expect(payload.questions).toEqual([{ question: "短信验证码有效期选哪种？\n选项：1. 5 分钟（推荐）；2. 10 分钟", scope: "仅短信验证码期限" }]);
    expect(verifier.systemPrompt).toContain("被采纳的那一项算用户决定");
  });

  test("M9：草稿核验器拒绝时带回一句原因，标明是模型说法；原因只作参考，未知字段或类型不对仍按格式错误拒绝", async () => {
    const w = await world(), input = { action: "create", requestId: uuidv7(), operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
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

  test("create自动真实Git首提、UUID/hash一致、同operation幂等；新增无关需求不复用输入", async () => {
    const w = await world(); w.capture(); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    const p = { action: "create", requestId: uuidv7(), operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY };
    const first = await w.call(p), second = await w.call(p); expect(second).toEqual(first);
    const directory = join(w.dataRoot, "repos", w.repoId, "requirements", String(first.requirementId));
    const prod = await readFile(join(directory, "prod.md"));
    expect(prod.toString()).toContain(`requirementId: ${first.requirementId}`);
    expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(directory, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("prod.md");
    expect(await git(directory, ["show", "-s", "--format=%an <%ae>", "HEAD"])).toBe("pi prod storage <pi-prod-storage@localhost>");
    scriptReplies(w.provider, [{ type: "text", text: '{"allow":false}' }]);
    await expect(w.call({ ...p, operationId: uuidv7(), requestId: uuidv7(), title: "无关付款" })).rejects.toMatchObject({ code: "draft_interpretation_denied" });
  });
  test("M8A-AC9：正文不是五大板块时批准被拒，不调用模型、不激活，并写明期望与实际", async () => {
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
    const skillFile = (ids: [string, string, string]) => `---\nname: requirement-doc\ndescription: 三板块\nsections:\n  - { id: ${ids[0]}, title: 目标 }\n` +
      `  - { id: ${ids[1]}, title: 实现, record: implementation }\n  - { id: ${ids[2]}, title: 验收, record: acceptance }\n---\n三板块写法。\n`;
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), skillFile(["goal", "build", "check"]));
    const body = "## 目标 {#goal}\n登录需求。\n### 手机号 {#A}\n增加手机号登录。\n## 实现 {#build}\n由 PM 规划。\n## 验收 {#check}\n手机号能登录。\n";
    const created = await w.create(body), first = await w.request(created), before = w.provider.requests.length;
    await expect(w.call({ action: "confirmUpdate", ...first.input })).rejects.toThrow("当前为 goal、build、check");
    expect(w.provider.requests).toHaveLength(before);
    new ProjectTrustStore(w.root).set(w.repositoryRoot, true);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(wholeReview(first.loaded)) }]);
    expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prodActivated: true });
    const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
    const snapshot = (await resolveRepositoryRequirementDoc(w.dataRoot, w.repositoryRoot)).spec;
    expect(snapshot.sections.map((section) => section.id)).toEqual(["goal", "build", "check"]);
    expect(state.read(first.input.requirementId).data.docSpec).toEqual(snapshot);
    await writeFile(join(dir, "SKILL.md"), skillFile(["aim", "make", "verify"]));
    expect((await resolveRepositoryRequirementDoc(w.dataRoot, w.repositoryRoot)).spec.sections.map((section) => section.id)).toEqual(["aim", "make", "verify"]);
    const updated = await w.service.updateDraft({ requirementId: first.input.requirementId, version: state.read(first.input.requirementId).version, operationId: uuidv7(), title: "登录", body: body + "补充邮箱约束。\n" });
    const next = await w.request(updated);
    w.capture("批准这版。"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(wholeReview(next.loaded)) }]);
    expect(await w.call({ action: "confirmUpdate", ...next.input })).toMatchObject({ prodActivated: true });
    expect(state.read(first.input.requirementId).data.docSpec).toEqual(snapshot);
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
    await plainInternalModels(w.root);
    const original = w.ctx.modelRegistry.complete.bind(w.ctx.modelRegistry);
    vi.spyOn(w.ctx.modelRegistry, "complete").mockImplementation((model, context, options) => { sent.push(context); return original(model, context, options); });
    const created = await w.create(), { input, loaded } = await w.request(created);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    const result = await w.call({ action: "confirmUpdate", ...input });
    expect(result).toMatchObject({ targetRecorded: true, prodActivated: true, allowedScopes: [{ action: "analyze", goalIds: ["A"], constraintIds: [] }] });
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
    const { input, loaded } = await w.request({ ...created, version: bound.version });
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded, "implement")) }]);
    const params = { action: "confirmUpdate", ...input }, result = await w.call(params);
    expect(result).toMatchObject({ targetRecorded: true, prodActivated: true, lifecycle: "active", allowedScopes: [{ action: "implement", goalIds: ["A"], constraintIds: [] }] });
    expect(result).not.toHaveProperty("blockedBy");
    expect(result).not.toHaveProperty("unimplemented");
    expect(await w.call(params)).toEqual(result);
    expect(state.events(String(created.requirementId)).filter((e) => e.data.kind === "prod.approved")).toHaveLength(1);
    expect(await git(join(w.dataRoot, "repos", w.repoId, "requirements", String(created.requirementId)), ["rev-list", "--count", "HEAD"])).toBe("1");
  });
  test("模型异步期间撤权，迟到输出脱敏、没有短记录或manifest", async () => {
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)), chunkDelayMs: 30 }]);
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
    const script = `import {RequirementStateStore} from ${JSON.stringify(new URL("../runtime/requirement-state.ts", import.meta.url).href)};
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
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
    const review = phoneReview(loaded); review.faithful = false;
    review.entries[1]!.resolution = "modify"; review.entries[1]!.conclusion = "手机号登录需修改后保留邮箱";
    review.entries.splice(5, 1);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }]);
    const result = await w.call({ action: "confirmUpdate", ...input });
    expect(result).toMatchObject({ targetRecorded: true, prodActivated: false, blockedBy: "candidate_requires_revision_or_clarification", allowedScopes: [] });
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("approval_manifests_v1"))).toEqual([]);
    const updated = await w.service.updateDraft({ requirementId: input.requirementId, version: input.version, operationId: uuidv7(), title: "登录", body: BODY + "明确保留邮箱登录。\n" });
    await expect(w.call({ action: "confirmUpdate", requirementId: input.requirementId, version: updated.version, savedOperationId: updated.operationId, operationId: uuidv7() })).rejects.toThrow();
    expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.events(`requirement_events:${input.requirementId}`).filter((e) => (e.data as { kind: string }).kind === "prod.approved"))).toEqual([]);
  });
  test("一次真实输入完成modify-resave-reinterpret；旧capability立即失效，三次上限和原TTL均保留", async () => {
    let now = 1000;
    const w = await world({ now: () => now, inputTtlMs: 100_000 });
    await plainInternalModels(w.root);
    const created = await w.create(), captured: unknown[] = [], texts: string[] = [];
    const capture = vi.spyOn(UserInteractionCore.prototype, "captureInput");
    const original = w.ctx.modelRegistry.complete.bind(w.ctx.modelRegistry);
    let expectedInput: { requirementId: string; savedOperationId: string; operationId: string; version: number };
    let reviewedDocuments = 0;
    const inputFor = (saved: Record<string, unknown>) => ({ requirementId: String(saved.requirementId), savedOperationId: String(saved.operationId), operationId: uuidv7(), version: Number(saved.version) });
    const complete = vi.spyOn(w.ctx.modelRegistry, "complete").mockImplementation((model, context, options) => {
      if (context.messages[0]?.role === "user" && typeof context.messages[0].content === "string") {
        const payload = JSON.parse(context.messages[0].content);
        texts.push(payload.text);
        if (payload.context?.document) {
          // 固定模型答复使用生产解释器实际提供的候选与分区，不另行读取一次prod。
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
    const oldCapabilities: import("../runtime/user-interaction.ts").InteractionCapability[] = [];
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
        expect(result.prodActivated).toBe(false);
        oldCapabilities.push((await interpreted.mock.results.at(-1)!.value).capability);
        const update = { action: "updateDraft", requirementId: input.requirementId, version: input.version, operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + `补充${i}：明确保留邮箱登录。\n` };
        scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
        if (i === 3) { await expect(w.call(update)).rejects.toThrow(); break; }
        saved = await w.call(update);
        expect(await w.call(update)).toEqual(saved);
        now += 1000;
      }
      expect(reviewedDocuments).toBe(4);
      expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0]![2]).toBe(101000);
      expect(captured).toHaveLength(3); expect(captured.every((ticket) => ticket === captured[0])).toBe(true);
      expect(texts.every((text) => text === PHONE)).toBe(true);
      const directory = join(w.dataRoot, "repos", w.repoId, "requirements", String(created.requirementId));
      expect(await git(directory, ["rev-list", "--count", "HEAD"])).toBe("4");
      now = 101000; await expect(w.call({ action: "confirmUpdate", ...inputFor(saved) })).rejects.toMatchObject({ code: "current_input_required" });
    } finally { capture.mockRestore(); complete.mockRestore(); prepare.mockRestore(); interpreted.mockRestore(); }
  });
  for (const change of ["revoke", "expiry", "input", "resave"] as const) test(`受控重解释在模型等待期间${change}拒绝迟到结果`, async () => {
    let now = 1000;
    const w = await world({ now: () => now, inputTtlMs: 100_000 }), created = await w.create(), first = await w.request(created), review = phoneReview(first.loaded);
    review.faithful = false; review.entries[1]!.resolution = "modify"; review.entries.splice(5, 1);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }]); await w.call({ action: "confirmUpdate", ...first.input });
    scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
    const updated = await w.call({ action: "updateDraft", requirementId: first.input.requirementId, version: first.input.version, operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充邮箱约束。\n" });
    const next = await w.request(updated), before = withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(next.loaded)), chunkDelayMs: 500 }]);
    const count = w.provider.requests.length, pending = w.call({ action: "confirmUpdate", ...next.input }), rejected = expect(pending).rejects.toThrow();
    const deadline = Date.now() + 3000;
    while (w.provider.requests.length === count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    expect(w.provider.requests.length).toBe(count + 1);
    if (change === "revoke") w.authorization.revoke();
    if (change === "expiry") now = 101000;
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
        const error = await w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version), operationId: uuidv7(),
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
      await expect(w.call({ action: "updateDraft", requirementId: String(created.requirementId), version: Number(created.version), operationId: uuidv7(),
        summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充。\n" })).rejects.toMatchObject({ code: "interaction_denied" });
    } finally { fail.mockRestore(); }
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(200);
    expect(JSON.parse(lines[0]!)).toEqual({ old: 6 });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ at: expect.any(String), action: "updateDraft", name: "Error", code: "ERR_SQLITE_ERROR", errcode: 5 });
    expect(lines.join("\n")).not.toContain("需求正文");
  });
  test("受控重存finalize失败保留实际数据但取消重解释permit", async () => {
    const w = await world(), created = await w.create(), { input, loaded } = await w.request(created), review = phoneReview(loaded);
    review.faithful = false; review.entries[1]!.resolution = "modify";
    review.entries.splice(5, 1);
    scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }]); await w.call({ action: "confirmUpdate", ...input });
    const fail = vi.spyOn(RequirementOperations.prototype, "finalize").mockImplementation(() => { throw new Error("fixture_finalize_failure"); });
    const operationId = uuidv7();
    try {
      scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
      await expect(w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, operationId, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "补充。\n" })).rejects.toThrow();
    } finally { fail.mockRestore(); }
    const current = w.authorization.snapshot(w.repoId, input.requirementId, w.sessionId);
    expect(current.version).toBeGreaterThan(input.version);
    await expect(w.call({ action: "confirmUpdate", requirementId: input.requirementId, version: current.version, savedOperationId: operationId, operationId: uuidv7() })).rejects.toThrow();
  });
  test("分页保留中文、范围与未决标记，封装≤50KiB，游标跨新输入失效", async () => {
    const w = await world(), created = await w.create("# 说明 {#A}\n" + "中文边界\\\"".repeat(2000)), requirementId = String(created.requirementId);
    const first = await w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024 });
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(first) }], details: first }))).toBeLessThanOrEqual(50 * 1024);
    expect(first.text).not.toContain("�"); expect(first.coverage).toMatchObject({ complete: false, blocking: ["incomplete_prod_read", "global_constraints_and_unresolved_may_be_outside_page"] });
    const cursor = (first.coverage as { nextCursor: string }).nextCursor;
    expect(await w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024, cursor })).toHaveProperty("text");
    w.capture("新输入"); await expect(w.call({ action: "read", requirementId, source: "saved", maxBytes: 1024, cursor })).rejects.toMatchObject({ code: "cursor_expired" });
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
  const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const read = vi.spyOn(UserInteractionCore.prototype, "readDecision").mockImplementation(() => { throw busy; });
  try {
    w.capture("同意"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    const outcome = await w.call({ action: "confirmUpdate", ...input }).then((result) => result, (error: unknown) => error);
    expect(outcome).not.toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
    expect(outcome).toMatchObject({ code: "interaction_denied" });
  } finally { read.mockRestore(); }
});

const SMS_ASK = { question: "短信验证码有效期选哪种？", rootCheck: "要定的是验证码多久失效，而不是另加重发限制",
  choices: [{ label: "5 分钟", reason: "更安全", recommended: true, recommendedReason: "常见做法，够用户收短信" }, { label: "10 分钟", reason: "信号差也来得及，但更容易被盗用" }],
  scope: "仅短信验证码期限", actions: ["analyze"] };
async function askedWorld() {
  const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
  const ask = (answer: WindowDecision, extra: Record<string, unknown> = {}) => {
    w.capture(); w.answerWindows(answer);
    return w.call({ action: "ask", ...input, operationId: uuidv7(), ...SMS_ASK, unitIds: [loaded.partition.units[1]!.id], ...extra }, true);
  };
  return { w, input, loaded, ask };
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
  expect(result).toMatchObject({ status: "answered", answer: { text: "选第 1 项：5 分钟（推荐）", choice: 1 } });
  scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" });
  expect(verifierText(w)).toBe("选第 1 项：5 分钟（推荐）");
});

test("M8D-AC9：在其他里自己输入的文字原样当作用户原话；Esc 暂不回答时问题仍未决，不记新的原话", async () => {
  const other = await askedWorld();
  expect(await other.ask({ other: "7 分钟" })).toMatchObject({ status: "answered", answer: { text: "7 分钟", other: true } });
  scriptReplies(other.w.provider, [{ type: "text", text: '{"allow":true}' }]);
  await other.w.call({ action: "updateDraft", requirementId: other.input.requirementId, version: other.input.version, operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 7 分钟有效。\n" });
  expect(verifierText(other.w)).toBe("7 分钟");
  const skipped = await askedWorld();
  const result = await skipped.ask(false);
  expect(result).toMatchObject({ status: "pending", answer: null });
  expect(withDatabase(repositoryDatabase(skipped.w.dataRoot, skipped.w.repoId), (db) => db.list("interaction_questions_v1"))).toHaveLength(1);
});

test("M8D-AC9：窗口里的回答只算回答：拿它批准时不弹批准窗口、不生效，拿它裁决时被拒并写明原因", async () => {
  const { w, input, loaded, ask } = await askedWorld();
  const asked = await ask("批准这一版并实施", { choices: [{ label: "批准这一版并实施", reason: "马上开始", recommended: true, recommendedReason: "草稿已写全" }, { label: "先不批准", reason: "再看看" }], unitIds: ["SMS"] });
  const before = w.windows.length, review = phoneReview(loaded);
  review.referenceResolution = "explicit";
  Object.assign(review.entries.find((entry) => entry.kind === "unresolved")!, { requestId: asked.requestId, resolution: "defer" });
  scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }, { type: "text", text: JSON.stringify(review) }]);
  const outcome = await w.call({ action: "reply", ...input }, true).then((r) => r, (e: unknown) => e);
  expect(outcome).toMatchObject({ prodActivated: false, blockedBy: "window_answer_not_decision" });
  expect(w.windows.length).toBe(before);
  const state = await RequirementStateStore.open({ dataRoot: w.dataRoot, repositoryRoot: w.repositoryRoot, repoId: w.repoId, authorize: () => true });
  expect(state.read(input.requirementId).data.lifecycle).toBe("draft");
  const adjudicated = await w.call({ purpose: "adjudicate", action: "reply", requirementId: input.requirementId, operationId: uuidv7(),
    itemId: `requirement:${input.requirementId}`, itemVersion: `requirement:${input.requirementId}:1` }, true).catch((e: unknown) => e);
  expect(adjudicated).toMatchObject({ code: "window_answer_not_decision" });
  expect((adjudicated as Error).message).toContain("原因：用户是在提问窗口里选的，这只算回答，不能当作批准或裁决");
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

test("M8D-AC9：批准被挡时写明原因：以前登记的决定挡住了哪些段落、这次解读里还有哪些段落待定，用段落标题说", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  const modify = phoneReview(first.loaded);
  modify.faithful = false; modify.entries[1]!.resolution = "modify"; modify.entries.splice(5, 1);
  w.capture("手机号登录要改一下"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(modify) }]);
  expect(await w.call({ action: "reply", ...first.input }, true)).toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  const resaveOperation = uuidv7();
  const resaved = await w.service.updateDraft({ requirementId: first.input.requirementId, version: first.input.version, operationId: resaveOperation, title: "登录", body: BODY + "补充一句。\n" });
  const next = await w.request({ ...created, operationId: resaveOperation, version: resaved.version });
  w.capture("内容正确，批准这一版"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(allPending(next.loaded)) }, { type: "text", text: JSON.stringify(allPending(next.loaded)) }]);
  const again = await w.call({ action: "confirmUpdate", ...next.input }).then((r) => r, (e: unknown) => e);
  expect(again).toMatchObject({ blockedBy: "candidate_requires_revision_or_clarification" });
  const reason = (again as { blockedReason: string }).blockedReason;
  expect(reason).toMatch(/以前登记的决定和现在的草稿对不上，涉及段落：[^；]*手机号与邮箱/u);
  expect(reason).toMatch(/这次的解读里仍待定的段落：[^；]*手机号与邮箱/u);
});

test("M8D-AC3：没有确认任何正文段落的解读不留下决定记录，随后一次明确的批准照常生效", async () => {
  const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
  const decisions = () => withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("short_decisions"));
  w.capture("两处我都批准"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(allPending(loaded)) }]);
  const blocked = await w.call({ action: "confirmUpdate", ...input });
  expect(blocked).toMatchObject({ prodActivated: false, blockedBy: "candidate_requires_revision_or_clarification", decisionIds: [] });
  expect((blocked as { blockedReason: string }).blockedReason).toMatch(/这次的解读里仍待定的段落：[^；]*手机号与邮箱/u);
  expect(decisions()).toEqual([]);
  w.capture("我批准登录这个需求的这一版"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
  expect(await w.call({ action: "confirmUpdate", ...input, operationId: input.operationId })).toMatchObject({ prodActivated: true });
});

test("M8D-AC3：解释器的上下文里带有程序认定的对象事实：@ 到的写 mention 与同一句话针对的其他需求数，批准窗口确认的写 window", async () => {
  const w = await world(), a = await w.create(), b = await w.create();
  const first = await w.request(a), second = await w.request(b);
  w.capture("两处我都批准"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(first.loaded)) }]);
  await w.call({ action: "confirmUpdate", ...first.input });
  expect(interpreterContext(w).addressed).toEqual({ how: "mention", others: 1 });
  w.capture("批准登录", "interactive", false, false); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(second.loaded)) }]);
  await w.call({ action: "confirmUpdate", ...second.input });
  expect(interpreterContext(w).addressed).toEqual({ how: "window" });
  expect(w.provider.requests.filter((r) => r.systemPrompt?.includes("需求解释器")).at(-1)!.systemPrompt).toContain("context.addressed");
});

test("批准登记到一半失败后又登记了新问题，草稿仍能继续保存，不会卡死在这一版", async () => {
  const w = await world(), created = await w.create(), { input, loaded } = await w.request(created);
  const storage = vi.spyOn(RequirementService.prototype, "confirmUpdate").mockRejectedValueOnce(new RequirementServiceError("stale_version", "模拟存储出错"));
  try {
    w.capture("同意"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(loaded)) }]);
    await expect(w.call({ action: "confirmUpdate", ...input })).rejects.toMatchObject({ code: "stale_version" });
  } finally { storage.mockRestore(); }
  expect(withDatabase(repositoryDatabase(w.dataRoot, w.repoId), (db) => db.list("approval_manifests_v1"))).toHaveLength(1);
  w.capture("再问我一下短信期限"); w.answerWindows(false);
  await w.call({ action: "ask", ...input, operationId: uuidv7(), ...SMS_ASK, unitIds: ["SMS"] }, true);
  w.capture("短信验证码 5 分钟有效，写进草稿"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  const saved = await w.call({ action: "updateDraft", requirementId: input.requirementId, version: input.version, operationId: uuidv7(),
    summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "短信验证码 5 分钟有效。\n" }).then((r) => r, (e: unknown) => e);
  expect(saved).toMatchObject({ status: "saved" });
});

test("M8D-AC3：一句话 @ 两个需求并批准，两个需求按各自的版本分别登记生效", async () => {
  const w = await world(), a = await w.create(), b = await w.create();
  const first = await w.request(a), second = await w.request(b);
  w.capture("两处我都批准");
  scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(first.loaded)) }]);
  expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prodActivated: true });
  scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(second.loaded)) }]);
  const other = await w.call({ action: "confirmUpdate", ...second.input }).then((r) => r, (e: unknown) => e);
  expect(other).toMatchObject({ prodActivated: true });
  expect(w.windows).toHaveLength(0);
});

test("M8D-AC3：已批准的需求只改一段后再批准，解释器只确认改动的那段、把没改的段落列为待定，程序沿用原批准，更新照常生效", async () => {
  const w = await world(), created = await w.create(), first = await w.request(created);
  w.capture("同意"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(phoneReview(first.loaded)) }]);
  expect(await w.call({ action: "confirmUpdate", ...first.input })).toMatchObject({ prodActivated: true });
  w.capture("验收补一条：手机号连续失败三次后锁定十分钟"); scriptReplies(w.provider, [{ type: "text", text: '{"allow":true}' }]);
  const updateOperation = uuidv7();
  const updated = await w.call({ action: "updateDraft", requirementId: first.input.requirementId, version: Number((await w.call({ action: "metadata", requirementId: first.input.requirementId })).version),
    operationId: updateOperation, summary: "手机号登录，保留邮箱登录", title: "登录", body: BODY + "手机号连续失败三次后锁定十分钟。\n" });
  const next = await w.request({ ...created, operationId: updateOperation, version: updated.version });
  const base = phoneReview(next.loaded), entry = base.entries[0]!;
  const sms = base.entries.find((e) => e.kind === "unresolved")!, delegation = base.entries.find((e) => e.kind === "delegation")!;
  const untouched = next.loaded.partition.units.map((unit) => unit.id).filter((id) => !["acceptance", "SMS", "D"].includes(id));
  const review = { format: "interaction-interpretation/v1", referenceResolution: "none", faithful: false, entries: [
    { ...entry, kind: "constraint", conclusion: "验收补充失败锁定", unitIds: ["acceptance"] }, sms, delegation,
    { ...entry, kind: "unresolved", basis: "uncertain", resolution: "unclear", conclusion: "其余段落这次没有重新确认", unitIds: untouched }] };
  w.capture("更新我确认，批准"); scriptReplies(w.provider, [{ type: "text", text: JSON.stringify(review) }, { type: "text", text: JSON.stringify(review) }]);
  const outcome = await w.call({ action: "confirmUpdate", ...next.input }).then((r) => r, (e: unknown) => e);
  expect(outcome).toMatchObject({ prodActivated: true });
});
