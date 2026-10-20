import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { temporaryRoot } from "../helpers/temporary-root.ts";
import { registerControlledProvider, scriptReplies } from "../helpers/controlled-provider.ts";
import requirementManageExtension from "../../src/modules/interaction/requirement-manage-extension.ts";
import type { WindowContextValue } from "../../src/core/host/extension-lifecycle.ts";
import { repositoryIdentity } from "../../src/core/storage/identity.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";

const exec = promisify(execFile);
const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n登录。\n## 功能 {#features}\n手机号登录。\n## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n能登录。\n";
const files: AutocompleteProvider = {
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
};

test("M8D-AC1：交互终端里只登记一次 @ 补全；打 @ 时列出本窗口的需求，PM 正在运行的写明，窗口关闭后只剩原来的补全", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "mention-")), repo = join(root, "repo"), agentDir = join(root, "agent"), dataRoot = join(root, "data");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await mkdir(repo); await mkdir(agentDir); await mkdir(dataRoot);
    await exec("git", ["init", "--initial-branch=main"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "fixture"); await exec("git", ["add", "README.md"], { cwd: repo });
    await exec("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "init"], { cwd: repo });
    const identity = await repositoryIdentity(repo), sm = SessionManager.inMemory(repo);
    let overview: Array<{ requirementId: string; status: string }> = [];
    const client = { state: () => ({ status: "connected" }), subscribe: () => () => {}, call: async () => ({ items: overview }) };
    const window = { windowId: uuidv7(), sessionId: sm.getSessionId(), clients: { forRepo: () => client },
      workspace: { repos: [{ ...identity, path: repo }] } } as unknown as WindowContextValue;
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = registerControlledProvider(runtime, { providerId: "mention-sdk", modelId: "controlled" });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => requirementManageExtension(pi, { dataRoot, windowReady: async () => window, windowContext: () => window })] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: repo, agentDir, sessionManager: sm, modelRuntime: runtime, model: runtime.getModels(provider.providerId)[0],
      resourceLoader: loader, noTools: "builtin", settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
    const factories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
    const uiContext = { ...session.extensionRunner.getUIContext(), notify: () => {}, addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => { factories.push(factory); } };
    await session.bindExtensions({ mode: "tui", uiContext });
    expect(factories).toHaveLength(1);
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    expect(factories).toHaveLength(1);

    scriptReplies(provider, [
      { type: "toolcall", name: "one_company_requirement_manage", input: { request: { action: "create", repoId: identity.repoId,
        summary: "手机号登录", title: "登录", body: BODY } } },
      { type: "text", text: '{"allow":true}' }, { type: "text", text: "done" },
    ]);
    await session.prompt("整理手机号登录需求", { source: "interactive" });
    const created = session.messages.find((m) => m.role === "toolResult" && m.toolName === "one_company_requirement_manage");
    expect(created?.isError, JSON.stringify(created?.content)).toBe(false);
    const requirementId = (created!.details as { requirementId: string }).requirementId;

    const mention = factories[0]!(files), signal = new AbortController().signal;
    expect(await mention.getSuggestions(["@"], 0, 1, { signal })).toEqual({ prefix: "@",
      items: [{ value: `@[登录#${requirementId.slice(-4)}] `, label: `@[登录#${requirementId.slice(-4)}]`, description: "需求 · 草稿" }] });
    overview = [{ requirementId, status: "running" }];
    expect((await mention.getSuggestions(["@登"], 0, 2, { signal }))!.items[0]!.description).toBe("需求 · 草稿 · PM 运行中");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(await mention.getSuggestions(["@"], 0, 1, { signal })).toBeNull();
  } finally {
    if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
