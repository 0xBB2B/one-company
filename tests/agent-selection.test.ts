import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import { CheckRoundService } from "../runtime/check-round.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [],
  writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 3, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["其他"] }, performance: NA, ...patch });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function world() {
  const w = await createPmRunWorld(cleanups);
  const root = await mkdtemp(join(tmpdir(), "agent-selection-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const userDir = join(root, "agents"), skillDir = join(root, "skills");
  await mkdir(join(skillDir, "ui-kit"), { recursive: true });
  const skill = "# UI 规范\n按钮统一用主色。\n";
  await writeFile(join(skillDir, "ui-kit", "SKILL.md"), skill);
  const define = async (name: string, extra: string, body = `你是 ${name}。`) => {
    await mkdir(userDir, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${name} 专业定义\nrole: worker\n${extra}---\n${body}\n`;
    await writeFile(join(userDir, `${name}.md`), content);
    return content;
  };
  const options = (w.manager as unknown as { options: Record<string, unknown> }).options;
  options.loadRoleCatalog = async () => (await loadRoleCatalog({ defaultDir: defaultRoleDir(), userDir, projectDir: join(root, "none"), parseFrontmatter, projectTrusted: false })).roles;
  options.skillDirs = [skillDir];
  const task = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
    db.list<{ key: string; taskId: string; status: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const dispatch = (key: string) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null });
  return { ...w, userDir, skill, define, task, dispatch };
}
const prompt = (request: Context | undefined) => request?.systemPrompt ?? "";

test("M7-AC22/AC23/AC24：能力目录有界；任务指定专业定义时按定义派工、按需加载 skills，运行记录保存定义与 skills 指纹", async () => {
  const w = await world();
  const content = await w.define("ui-dev", "skills: [ui-kit]\n");
  const catalog = await w.manager.agentCatalog("worker", 0);
  expect(catalog.items.map((item) => item.name).sort()).toEqual(["ui-dev", "worker"]);
  expect(JSON.stringify(catalog)).not.toContain("你是 ui-dev");
  expect(JSON.stringify(await w.manager.agentCatalog(undefined, 0))).not.toContain("\"pm\"");

  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev", agentReason: "界面任务" }), spec("plain", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "开工" }, { type: "text", text: "PM 收到" });
  const run = await w.dispatch("ui");
  await until(() => w.provider.requests.some((request) => prompt(request).includes("你是 ui-dev")));
  const system = prompt(w.provider.requests.find((request) => prompt(request).includes("你是 ui-dev")));
  expect(system).toContain("按钮统一用主色");
  const record = await w.runStore.get(run.runId);
  expect(record.ok && record.run.agent).toMatchObject({ name: "ui-dev", source: "user", hash: sha(content),
    skills: [{ name: "ui-kit", path: join(w.userDir, "..", "skills", "ui-kit", "SKILL.md"), hash: sha(w.skill) }] });
});

test("M7-AC22/AC23：指定定义不存在、声明的 skill 缺失、模型不存在或思考等级不受支持时拒绝派工，不静默改用默认", async () => {
  const w = await world();
  await w.define("ghost-skill", "skills: [missing]\n");
  await w.define("bad-model", "model: nowhere/none\n");
  await w.define("deep-think", "thinking: xhigh\n");
  await w.plan.execute({ action: "propose", tasks: [
    spec("a", { agent: "nobody" }), spec("b", { agent: "ghost-skill", goalUnitIds: ["scenario.failure"] }),
    spec("c", { agent: "bad-model" }), spec("d", { agent: "deep-think", goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.dispatch("a")).rejects.toMatchObject({ code: "agent_unavailable" });
  await expect(w.dispatch("b")).rejects.toMatchObject({ code: "skill_unavailable" });
  await expect(w.dispatch("c")).rejects.toMatchObject({ code: "model_unavailable" });
  await expect(w.dispatch("d")).rejects.toMatchObject({ code: "thinking_unsupported" });
});

test("M7-AC25：运行中改了定义文件，暂停后续接时发现配置已变即安全停止，不用旧配置续跑", async () => {
  const w = await world();
  await w.define("ui-dev", "");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  const run = await w.dispatch("ui");
  await until(async () => { const current = await w.runStore.get(run.runId); return current.ok && current.run.state === "running"; });
  await w.manager.pause(run.runId);
  await w.define("ui-dev", "", "你是改过的 ui-dev。");
  await expect(w.manager.resume(run.runId)).rejects.toMatchObject({ code: "config_changed" });
  const stopped = await w.runStore.get(run.runId);
  expect(stopped.ok && stopped.run.state).toBe("stopped");
  expect(stopped.ok && stopped.run.stopCause).toEqual({ reason: "config_changed" });
});

test("M7-AC26：专业 worker 运行中不能开启正式检查；换专业名称不能改变职责（worker 定义不能执行审查）；需求停止时专业实例一并停止", async () => {
  const w = await world();
  await w.define("ui-dev", "");
  await w.define("code-reviewer", "");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "ui-dev", reviewAgent: "code-reviewer" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  await expect(w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: w.task("ui").taskId, retry: null, review: { maxTurns: 2 } }))
    .rejects.toMatchObject({ code: "agent_unavailable" });
  w.provider.queue.push({ type: "text", text: "慢慢做", chunkDelayMs: 3_000 });
  const run = await w.dispatch("ui");
  await until(async () => { const current = await w.runStore.get(run.runId); return current.ok && current.run.state === "running"; });
  const rounds = await CheckRoundService.open({ repositoryRoot: w.fixture.repositoryRoot, dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId, authorize: () => true });
  cleanups.push(() => rounds.dispose());
  await expect(rounds.openRound({ lease: w.lease })).rejects.toMatchObject({ code: "workers_active" });
  await w.manager.stopRequirement(w.fixture.requirementId, { reason: "requirement_closing" });
  const stopped = await w.runStore.get(run.runId);
  expect(stopped.ok && stopped.run.state).toBe("stopped");
});

test("M7-AC8：定义正文不含任何职责说明、模型也不遵守提示时，工具集合与写入限制仍由程序执行", async () => {
  const w = await world();
  await w.define("bare", "", "（无说明）");
  await w.plan.execute({ action: "propose", tasks: [spec("ui", { agent: "bare" }), spec("rest", { goalUnitIds: ["scenario.failure"] })] });
  await w.plan.execute({ action: "confirm", planVersion: 1 });
  w.provider.queue.push(
    { type: "toolcall", name: "one_company_plan_manage", input: { action: "confirm", planVersion: 1 } },
    { type: "toolcall", name: "one_company_change_apply", input: { action: "apply", operationId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10",
      files: [{ path: "docs/prod/x.md", baseHash: "absent", content: "x" }] } },
    { type: "toolcall", name: "bash", input: { command: "echo hacked > src/x.ts" } },
    { type: "text", text: "结束" }, { type: "text", text: "PM 收到" });
  await w.dispatch("ui");
  await until(() => w.provider.requests.some((request) => JSON.stringify(request.messages.at(-1) ?? "").includes("forbidden_path")));
  const tools = w.provider.requests.find((request) => prompt(request).includes("（无说明）"))!.tools!.map((tool) => tool.name);
  expect(tools).not.toContain("one_company_plan_manage");
  expect(tools).not.toContain("bash");
  const all = JSON.stringify(w.provider.requests);
  expect(all).toContain("Tool one_company_plan_manage not found");
  expect(all).toContain("forbidden_path");
});
