import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { registerControlledProvider, scriptReplies } from "./helpers/controlled-provider.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { sentOf } from "./helpers/lean-result.ts";
import type { ToolResponse } from "./helpers/lean-result.ts";
import { repositoryIdentity } from "../src/core/storage/identity.ts";
import { uuidv7 } from "../src/core/storage/database.ts";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import requirementManageExtension from "../src/modules/interaction/requirement-manage-extension.ts";

const exec = promisify(execFile), clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of clean.splice(0).reverse()) await c(); });
const BODY = "## 背景 {#background}\n用户未说明。\n## 需求 {#requirements}\n实施A。\n## 功能 {#features}\n### A {#features.A}\n实施A。\n" +
  "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\nA 可以使用。\n";

async function world() {
  const root = await mkdtemp(join(temporaryRoot(), "rir-")), repo = join(root, "repo"), dataRoot = join(root, "data");
  await mkdir(repo); await mkdir(dataRoot);
  const git = async (args: string[]) => (await exec("git", args, { cwd: repo })).stdout.trim();
  await git(["init", "--initial-branch=main"]); await writeFile(join(repo, "README.md"), "x"); await git(["add", "README.md"]);
  await git(["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "init"]);
  const { repoId } = await repositoryIdentity(repo), sessionId = uuidv7(), windowId = uuidv7();
  const authorization = new HostAuthorizationManager({ dataRoot });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const provider = registerControlledProvider(runtime, { providerId: uuidv7(), modelId: "controlled" });
  const branch: unknown[] = [];
  const ctx = { cwd: repo, modelRegistry: new ModelRegistry(runtime), model: runtime.getModels(provider.providerId)[0], sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } } as unknown as ExtensionContext;
  const client = { state: () => ({ status: "connected" as const }), subscribe: () => () => {} };
  const window = { windowId, sessionId, workspace: { repos: [{ repoId, path: repo }] }, clients: { forRepo: () => client } };
  const fake = createFakePi();
  requirementManageExtension({ ...fake.pi, getThinkingLevel: () => "off", appendEntry: () => {}, sendMessage: () => {} } as never,
    { authorization, dataRoot, windowReady: async () => window as never, windowContext: () => window as never });
  await fake.trigger("session_start", { reason: "new" }, ctx);
  clean.push(async () => { await fake.trigger("session_shutdown", {}, ctx); await rm(root, { recursive: true, force: true }); });
  const tool = fake.registeredTools().find((registered) => registered.name === "one_company_requirement_manage") as unknown as {
    execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<ToolResponse> };
  const run = async (params: Record<string, unknown>) => {
    const toolCallId = uuidv7(), input = { request: { repoId, ...params } };
    const response = await tool.execute(toolCallId, input, undefined, undefined, ctx);
    return { toolCallId, input, response };
  };
  const deliver = async (executed: Awaited<ReturnType<typeof run>>, toolName = "one_company_requirement_manage") =>
    (await fake.trigger("tool_result", { type: "tool_result", toolName, toolCallId: executed.toolCallId, input: executed.input,
      content: executed.response.content, details: executed.response.details, isError: false }, ctx))[0] as { content: Array<{ text: string }>; details: unknown; isError: true } | undefined;
  await fake.trigger("input", { source: "interactive", text: "整理并分析A目标" }, ctx);
  scriptReplies(provider, [{ type: "text", text: '{"allow":true}' }]);
  const created = await run({ action: "create", summary: "手机号登录，保留邮箱登录", title: "A需求", body: BODY });
  expect(await deliver(created)).toBeUndefined();
  return { run, deliver, requirementId: String(created.response.details!.requirementId) };
}

test("成功结果送达前核对通过时 tool_result 不改结果，模型拿到的 content 是精简内容", async () => {
  const w = await world();
  const read = await w.run({ action: "read", requirementId: w.requirementId, source: "saved" });
  expect(await w.deliver(read)).toBeUndefined();
  expect(sentOf(read.response)).not.toHaveProperty("epoch");
  expect(read.response.details).toHaveProperty("epoch");
});

test.each(["version", "epoch"])("送达前把 details 里的 %s 改掉，结果被换成送达前核对失败报错", async (field) => {
  const w = await world();
  const read = await w.run({ action: "read", requirementId: w.requirementId, source: "saved" });
  const details = read.response.details as Record<string, unknown>;
  details[field] = Number(details[field]) + 1;
  const replaced = await w.deliver(read);
  expect(replaced).toMatchObject({ isError: true, details: {} });
  expect(replaced!.content[0]!.text).toContain("结果送达前核对");
});

test.each(["metadata", "list"])("%s 结果送达前核对照常通过", async (action) => {
  const w = await world();
  const executed = await w.run({ action, ...(action === "metadata" ? { requirementId: w.requirementId } : {}) });
  expect(await w.deliver(executed)).toBeUndefined();
});
