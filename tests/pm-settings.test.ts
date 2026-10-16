import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readAgentSettings } from "../src/modules/settings/agent-settings.ts";
import type { SettingsRoleKey } from "../src/modules/settings/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog } from "../src/modules/agents/roles.ts";
import { loadRoleRules } from "../src/modules/agents/package-rules.ts";
import { registerControlledProvider } from "./helpers/controlled-provider.ts";
import { createPmRunWorld } from "./helpers/run-manager-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const MAIN = { provider: "team-model", id: "test" };
const A = { provider: "team-model", id: "gpt-6-luna" };
const B = { provider: "team-model", id: "gpt-6.1-sol" };
const PM_FIRST_LINE = "你是一个活动需求的唯一 PM，只在主代理准备并绑定的分支与 worktree 内工作。";

type Setting = { model: string | null; thinking: string | null };
const settingsOf = (pm: Setting) => async () => {
  const none = { model: null, thinking: null, source: "default" as const };
  return { values: { pm: { ...pm, source: "user" as const }, interpreter: none, "draft-verifier": none } as never,
    layers: { user: {}, project: {} }, problems: [] };
};

async function tempRoot() {
  const root = await mkdtemp(join(temporaryRoot(), "pm-set-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSettings(path: string, roles: Partial<Record<SettingsRoleKey, Setting>>) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ "one-company": roles }));
}

async function runOf(w: Awaited<ReturnType<typeof createPmRunWorld>>, runId: string) {
  const got = await w.runStore.get(runId);
  if (!got.ok) throw new Error(got.reason);
  return got.run;
}

describe("PM 的模型与思考等级取自设定", () => {
  test("两层都没有设定时，PM 用派出时主窗口的模型和思考等级", async () => {
    const w = await createPmRunWorld(cleanups, { thinking: "high" });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: MAIN, thinking: "high" });
  });

  test.each([
    ["项目受信任时 PM 用项目层的设定", true, B],
    ["项目不受信任时 PM 用用户层的设定", false, A],
  ])("用户层设 A、项目层设 B：%s", async (_label, projectTrusted, expected) => {
    const root = await tempRoot();
    await writeSettings(join(root, "agent", "settings.json"), { pm: { model: "team-model/gpt-6-luna", thinking: null } });
    await writeSettings(join(root, "repo", ".pi", "settings.json"), { pm: { model: "team-model/gpt-6.1-sol", thinking: null } });
    const w = await createPmRunWorld(cleanups, { thinking: "low",
      loadAgentSettings: () => readAgentSettings({ agentDir: join(root, "agent"), repositoryRoot: join(root, "repo"), projectTrusted }) });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: expected, thinking: "low" });
  });

  test("设定只写模型时，PM 用这个模型和派出时主窗口的思考等级", async () => {
    const w = await createPmRunWorld(cleanups, { thinking: "low", loadAgentSettings: settingsOf({ model: "team-model/gpt-6-luna", thinking: null }) });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: A, thinking: "low" });
  });

  test("设定只写思考等级时，PM 用派出时主窗口的模型和这个等级", async () => {
    const w = await createPmRunWorld(cleanups, { thinking: "high", loadAgentSettings: settingsOf({ model: null, thinking: "low" }) });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: MAIN, thinking: "low" });
  });

  test("设定里只写模型名时按本机模型找到它", async () => {
    const w = await createPmRunWorld(cleanups, { loadAgentSettings: settingsOf({ model: "gpt-6.1-sol", thinking: null }) });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: B });
  });

  test("每次派出都重新读设定：PM 运行期间改设定不影响这个 PM，下次派出用新值", async () => {
    let current: Setting = { model: "team-model/gpt-6-luna", thinking: null };
    const w = await createPmRunWorld(cleanups, { loadAgentSettings: () => settingsOf(current)() });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: A });
    current = { model: "team-model/gpt-6.1-sol", thinking: null };
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: A, state: "running" });
    w.fixture.state.releasePm(w.lease);
    const second = await w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: MAIN, thinking: "off" });
    expect(await runOf(w, second.runId)).toMatchObject({ model: B });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: A });
  });

  test("设定为跟随时，同一需求先以主窗口思考 high 派出、停掉后以 low 再派，第二次运行用 low", async () => {
    const w = await createPmRunWorld(cleanups, { thinking: "high" });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ thinking: "high" });
    w.fixture.state.releasePm(w.lease);
    const second = await w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: MAIN, thinking: "low" });
    expect(await runOf(w, second.runId)).toMatchObject({ thinking: "low" });
  });

  test("思考等级是跟随来的而模型不支持时，报 thinking_unsupported 且原因说明是跟随了派出方的思考等级", async () => {
    let current: Setting = { model: null, thinking: null };
    const w = await createPmRunWorld(cleanups, { loadAgentSettings: () => settingsOf(current)() });
    w.runtime.registerProvider("plain", { apiKey: "k", baseUrl: "http://127.0.0.1:1", api: "anthropic-messages" as never,
      models: [{ id: "no-reasoning", name: "no-reasoning", reasoning: false, input: ["text" as const], contextWindow: 1000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple() { throw new Error("不应被调用"); } });
    current = { model: "plain/no-reasoning", thinking: null };
    w.fixture.state.releasePm(w.lease);
    await expect(w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: MAIN, thinking: "high" }))
      .rejects.toMatchObject({ code: "thinking_unsupported", message: expect.stringContaining("（没有单独设定，跟随了派出方的思考等级）") });
  });

  test("思考等级不被模型支持时，建议指向 /one:setting 的「模型」", async () => {
    let current: Setting = { model: null, thinking: null };
    const w = await createPmRunWorld(cleanups, { loadAgentSettings: () => settingsOf(current)() });
    current = { model: null, thinking: "minimal" };
    w.fixture.state.releasePm(w.lease);
    await expect(w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: MAIN, thinking: "off" }))
      .rejects.toMatchObject({ code: "thinking_unsupported", advice: { next: "请用户改选模型，或在 /one:setting 的「模型」里给这个角色设定该模型支持的思考等级" } });
  });

  describe("设定的模型或思考等级用不了时直接报错并写明原因，不换别的模型", () => {
    const cases: Array<[string, Setting, string, string]> = [
      ["模型在本机找不到", { model: "team-model/missing", thinking: null }, "model_unavailable", "team-model/missing"],
      ["模型没有凭据", { model: "keyless/m", thinking: null }, "model_unavailable", "没有可用的凭据"],
      ["思考等级不受这个模型支持", { model: null, thinking: "minimal" }, "thinking_unsupported", "minimal"],
    ];
    test.each(cases)("%s", async (_label, setting, code, reason) => {
      let current: Setting = { model: null, thinking: null };
      const w = await createPmRunWorld(cleanups, { loadAgentSettings: () => settingsOf(current)() });
      registerControlledProvider(w.runtime, { providerId: "keyless", modelId: "m", noAuth: true });
      const before = (await w.runStore.list({ limit: 100 })).items.length;
      current = setting;
      w.fixture.state.releasePm(w.lease);
      await expect(w.manager.dispatchPm({ requirementId: w.fixture.requirementId, model: MAIN, thinking: "off" }))
        .rejects.toMatchObject({ code, message: expect.stringContaining(reason) });
      expect((await w.runStore.list({ limit: 100 })).items).toHaveLength(before);
    });
  });
});

describe("PM 的提示词只由程序给", () => {
  test("PM 的提示词含 pm 职责规矩首行且没有定义正文，运行记录不带定义指纹，也不带 mcp", async () => {
    const w = await createPmRunWorld(cleanups);
    const prompt = w.provider.requests[0]!.systemPrompt ?? "";
    expect(loadRoleRules("pm")).toContain(PM_FIRST_LINE);
    expect(prompt).toContain(PM_FIRST_LINE);
    expect(prompt).not.toContain("上面的定义正文");
    const run = await runOf(w, w.pm.runId);
    expect(run.agent).toBeUndefined();
    expect(run.mcp ?? []).toEqual([]);
  });

  test("用户层放旧的 role 为 pm 的定义文件时，PM 不用它的模型，查询可用定义的结果里也没有它", async () => {
    const root = await tempRoot();
    const userDir = join(root, "agents");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "pm.md"), "---\nname: pm\ndescription: 旧 pm\nrole: pm\nmodel: team-model/gpt-6-luna\nthinking: low\n---\n旧正文\n");
    const w = await createPmRunWorld(cleanups, { userDir, reloadCatalog: true, thinking: "high" });
    expect(await runOf(w, w.pm.runId)).toMatchObject({ model: MAIN, thinking: "high" });
    expect(w.provider.requests[0]!.systemPrompt ?? "").not.toContain("旧正文");
    expect(JSON.stringify(await w.manager.agentCatalog(undefined, 0))).not.toContain("旧 pm");
    const { roles, problems } = await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir, projectDir: join(root, "none"), parseFrontmatter, projectTrusted: false });
    expect(roles.find((entry) => entry.name === "pm")).toBeUndefined();
    expect(problems.some((problem) => problem.reason === "已不再使用定义文件，模型和思考等级改在「模型」里")).toBe(true);
  });
});
