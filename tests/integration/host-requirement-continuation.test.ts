import { afterEach, expect, test } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createClock } from "../../runtime/clock.ts";
import { connectDaemon } from "../../runtime/daemon-client.ts";
import { HostAuthorizationManager } from "../../runtime/host-authorization.ts";
import { RequirementService } from "../../runtime/requirement-service.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../runtime/database.ts";
import requirementManageExtension from "../../extensions/requirement-manage.ts";
import type { WindowContextValue } from "../../extensions/lifecycle.ts";
import { createDaemonFixture, removeDaemonFixture, resolveSdkDir, startDaemonForTest, killDaemon } from "../helpers/daemon-harness.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import { join } from "node:path";


const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function world() {
  const fixture = await createDaemonFixture();
  const daemon = await startDaemonForTest(fixture);
  cleanup.push(async () => { await killDaemon(daemon); await removeDaemonFixture(fixture); });
  const config = { dataRoot: fixture.dataRoot, repositoryRoot: fixture.repo.root, repoId: fixture.repoId, authorize: () => true };
  const service = await RequirementService.open(config), state = await RequirementStateStore.open(config);
  async function session(rpcAuthorized = true) {
    const sm = SessionManager.inMemory(fixture.repo.root), windowId = uuidv7(), clock = createClock();
    const client = await connectDaemon({ repoDir: fixture.repo.root, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock,
      hello: { windowId, sessionId: sm.getSessionId(), pid: process.pid, cwd: fixture.repo.root, workspaceRoot: fixture.repo.root } });
    expect(client.state().status).toBe("connected");
    const window = { windowId, sessionId: sm.getSessionId(), workspace: { repos: [{ repoId: fixture.repoId, path: fixture.repo.root, commonDir: fixture.repoDir }], skipped: [] },
      clients: { forRepo: (id: string) => id === fixture.repoId ? client : undefined, all: () => [client], closeAll: () => client.close() } } as unknown as WindowContextValue;
    const authorization = new HostAuthorizationManager({ dataRoot: fixture.dataRoot });
    const runtime = await ModelRuntime.create({ authPath: join(fixture.home.agentDir, `${windowId}.auth.json`), modelsPath: null, refreshOnCreate: false });
    const provider = registerControlledProvider(runtime, { providerId: `selection-${windowId}`, modelId: "controlled" });
    const notifications: string[] = [], prompts: Array<{ title: string; options: string[] }> = [];
    let choose: (options: string[]) => Promise<string | undefined> = async () => undefined;
    const loader = new DefaultResourceLoader({ cwd: fixture.repo.root, agentDir: fixture.home.agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [(pi) => requirementManageExtension(pi, { dataRoot: fixture.dataRoot, authorization, windowReady: async () => window, windowContext: () => window })] });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd: fixture.repo.root, agentDir: fixture.home.agentDir, modelRuntime: runtime, model: runtime.getModels(provider.providerId)[0],
      sessionManager: sm, resourceLoader: loader, noTools: "builtin", settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
    session.extensionRunner.setFlagValue("requirement-rpc-input", rpcAuthorized);
    await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify: (message) => notifications.push(message),
      select: async (title, options) => { prompts.push({ title, options: [...options] }); return choose([...options]); } } });
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await session.abort(); await session.waitForIdle(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); client.close(); clock.stopGapWatcher(); };
    cleanup.push(close);
    const call = async (params: Record<string, unknown>, source: "rpc" | "extension" = "rpc", draft = false) => {
      scriptReplies(provider, [{ type: "toolcall", name: "pi_company_requirement_manage", input: { repoId: fixture.repoId, ...params } },
        ...(draft ? [{ type: "text" as const, text: '{"allow":true}' }] : []), { type: "text", text: "done" }]);
      await session.prompt(draft ? "请整理并保存A需求；首次输入标记不应进入新会话" : "执行本次需求工具操作", { source });
      const result = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "pi_company_requirement_manage").at(-1)!;
      expect(result).toBeDefined(); return result;
    };
    return { session, sm, client, authorization, notifications, prompts, call, close,
      choose(callback: typeof choose) { choose = callback; } };
  }
  return { fixture, service, state, session };
}

test("真实SDK命令/UI选择和认证daemon：新会话只绑定已有身份，不恢复旧输入或执行", async () => {
  const w = await world(), first = await w.session();
  const created = await first.call({ action: "create", requestId: uuidv7(), operationId: uuidv7(), title: "A需求", body: "# A {#A}\nA目标。\n" }, "rpc", true);
  expect(created.isError).toBe(false);
  const requirementId = String(created.details!.requirementId), version = Number(created.details!.version);
  await first.close();
  const next = await w.session();
  expect((await next.call({ action: "metadata", requirementId })).isError).toBe(true);
  await next.session.prompt(`/requirement-select ${requirementId}`, { source: "rpc" });
  expect(next.prompts).toHaveLength(0); expect(next.authorization.binding(next.sm.getSessionId())).toBeUndefined();
  next.choose(async (options) => options.find((option) => option.includes(requirementId)));
  await next.session.prompt("/requirement-select", { source: "rpc" });
  expect(next.prompts).toHaveLength(1); expect(next.prompts[0]!.options.some((option) => option.includes(requirementId))).toBe(true);
  expect(next.authorization.binding(next.sm.getSessionId())).toEqual({ repoId: w.fixture.repoId, requirementId });
  expect(next.notifications.at(-1)).toContain("未恢复旧输入");
  expect((await next.call({ action: "metadata", requirementId }, "extension")).isError).toBe(false);
  const before = w.state.read(requirementId);
  expect((await next.call({ action: "updateDraft", requirementId, version, operationId: uuidv7(), title: "改动", body: "未获真实输入许可" }, "extension")).isError).toBe(true);
  expect(w.state.read(requirementId)).toEqual(before);
  expect(JSON.stringify(next.session.messages)).not.toContain("首次输入标记");
  expect(withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => db.list("runs"))).toEqual([]);
  expect(withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) => db.list("short_decisions"))).toEqual([]);
}, 40_000);

test("选择取消、伪返回、未授权RPC和真正断连不能产生需求绑定", async () => {
  const w = await world();
  const saved = await w.service.create({ operationId: uuidv7(), requestId: uuidv7(), title: "候选", body: "候选目标" });
  const denied = await w.session(false);
  denied.choose(async (options) => options[0]);
  await denied.session.prompt("/requirement-select", { source: "rpc" });
  expect(denied.prompts).toHaveLength(0); expect(denied.authorization.binding(denied.sm.getSessionId())).toBeUndefined();
  const host = await w.session();
  await host.session.prompt("/requirement-select", { source: "rpc" });
  expect(host.authorization.binding(host.sm.getSessionId())).toBeUndefined();
  host.choose(async () => saved.requirementId);
  await host.session.prompt("/requirement-select", { source: "rpc" });
  expect(host.authorization.binding(host.sm.getSessionId())).toBeUndefined();
  host.choose(async (options) => { host.client.close(); return options[0]; });
  await host.session.prompt("/requirement-select", { source: "rpc" });
  expect(host.client.state().status).not.toBe("connected");
  expect(host.authorization.binding(host.sm.getSessionId())).toBeUndefined();
}, 40_000);

test("选择等待期间实际版本变化及closing被拒绝，JSON副本不是选择能力", async () => {
  const w = await world();
  const saved = await w.service.create({ operationId: uuidv7(), requestId: uuidv7(), title: "候选", body: "候选目标" });
  const host = await w.session();
  const choices = host.authorization.prepareSelections(host.sm.getSessionId());
  expect(() => host.authorization.verifySelection(structuredClone(choices.items[0]!.selection), host.sm.getSessionId())).toThrow();
  host.choose(async (options) => {
    await w.service.updateDraft({ requirementId: saved.requirementId, version: w.state.read(saved.requirementId).version, operationId: uuidv7(), title: "候选", body: "外部保存后的新字节" });
    return options[0];
  });
  await host.session.prompt("/requirement-select", { source: "rpc" });
  expect(host.authorization.binding(host.sm.getSessionId())).toBeUndefined();
  host.choose(async (options) => {
    w.state.beginClose({ requirementId: saved.requirementId, version: w.state.read(saved.requirementId).version,
      intent: { operationId: uuidv7(), reason: "cancelled", receiptId: uuidv7() } });
    return options[0];
  });
  await host.session.prompt("/requirement-select", { source: "rpc" });
  expect(host.authorization.binding(host.sm.getSessionId())).toBeUndefined();
  expect(host.authorization.prepareSelections(host.sm.getSessionId()).items).toEqual([]);
}, 40_000);
