import { afterEach, expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { createGitCommitTool } from "../runtime/git-commit-tool.ts";
import { ProjectBaselineHooks } from "../runtime/project-baseline-hooks.ts";
import { BaselineFixture, deferred } from "./helpers/project-baseline-fixture.ts";
import { currentHostGit, initializeHostGit } from "../runtime/git-runtime.mjs";

initializeHostGit([]);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function bound(unmanaged = false) {
  const f = await BaselineFixture.create(); cleanup.push(() => f.close()); f.unmanaged = unmanaged;
  const hooks = new ProjectBaselineHooks({ provider: f }); cleanup.push(() => hooks.shutdown());
  const ctx = { cwd: f.root, sessionManager: {} } as ExtensionContext; hooks.bindContext(ctx);
  const request = await hooks.beginRequest(); await hooks.beforeProviderRequest();
  const message: AssistantMessage = { role: "assistant", api: "anthropic-messages", provider: "fixture", model: "fixture", timestamp: 1,
    content: [{ type: "toolCall", id: "original-commit", name: "pi_company_git_commit", arguments: {} }], stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  hooks.messageStart(message); expect(await hooks.messageEnd(message)).toBe(true);
  return { f, hooks, ctx, request };
}
const input = { paths: ["a.ts"], message: "fixture" };

test("commit actual execute无tool_call预检也拒旧callId，不借新request续权", async () => {
  const w = await bound(); let invoked = 0;
  const tool = createGitCommitTool(async () => async () => { invoked++; return "unexpected"; });
  await w.hooks.beginRequest();
  await expect(tool.execute("original-commit", input, undefined, undefined, w.ctx)).rejects.toMatchObject({ code: "stale" });
  expect(invoked).toBe(0);
});

test("commit resolver等待期间外改，actual mutation入口拒绝", async () => {
  const w = await bound(); let invoked = 0;
  const tool = createGitCommitTool(async () => { await w.f.write("a.ts", "EXTERNAL"); return async () => { invoked++; return "unexpected"; }; });
  await expect(tool.execute("original-commit", input, undefined, undefined, w.ctx)).rejects.toMatchObject({ code: "stale" });
  expect(invoked).toBe(0);
});

test("commit已进入准备期间撤权信号传给原commit，未到真实变更不落盘", async () => {
  const w = await bound(); const entered = deferred<void>(), release = deferred<void>(); let mutated = false;
  const tool = createGitCommitTool(async () => async (_paths, _message, signal) => {
    entered.resolve(); await release.promise; signal?.throwIfAborted(); mutated = true; return "unexpected";
  });
  const running = tool.execute("original-commit", input, undefined, undefined, w.ctx);
  const rejected = expect(running).rejects.toThrow();
  await entered.promise; w.f.notify(); release.resolve(); await rejected;
  expect(mutated).toBe(false);
});

test("commit合法unmanaged保留legacy，并保留原SDK取消信号", async () => {
  const w = await bound(true); const controller = new AbortController(); let invoked = 0;
  const tool = createGitCommitTool(async () => async (paths, message, signal) => {
    expect(paths).toEqual([`${w.f.root}/a.ts`]); expect(message).toBe("fixture"); expect(signal?.aborted).toBe(false); invoked++; return "legacy";
  });
  expect((await tool.execute("original-commit", input, controller.signal, undefined, w.ctx)).content).toEqual([{ type: "text", text: "legacy" }]);
  expect(invoked).toBe(1);
});

test("外层withMutation返回后Git绑定失效阻止最终工具响应且不泄露旧输出", async () => {
  const w = await bound(true);
  const target = w.hooks as unknown as { withMutation: (...args: unknown[]) => Promise<unknown> };
  const original = target.withMutation.bind(target);
  let wrapperCalls = 0;
  target.withMutation = async (...args: unknown[]) => {
    wrapperCalls++;
    const result = await original(...args);
    try { currentHostGit([dirname(currentHostGit().executablePath)]); } catch { /* 故意使本测试进程的宿主Git绑定失效。 */ }
    return result;
  };
  const tool = createGitCommitTool(async () => async () => "PRIVATE_OUTPUT");

  let caught: unknown;
  try { await tool.execute("original-commit", input, undefined, undefined, w.ctx); }
  catch (error) { caught = error; }
  expect(wrapperCalls).toBe(1);
  expect(caught).toMatchObject({ code: "git_runtime_invalid" });
  expect((caught as Error).message).not.toContain("PRIVATE_OUTPUT");
});
