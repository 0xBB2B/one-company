import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildAgentPrompt } from "../daemon/agent-session.ts";
import { loadRoleRules } from "../runtime/package-rules.ts";
import type { TaskSpec } from "../runtime/plan-manage.ts";
import { TASKS } from "../runtime/plan-manage.ts";
import { repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { defaultRoleDir, readRoleDefinition } from "../runtime/roles.ts";
import type { RoleDefinition } from "../runtime/roles.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const EXPLORE_FIRST_LINE = "你是只读检索代理，只回答派工给出的搜索问题。";
const PM_FIRST_LINE = "你是一个活动需求的唯一 PM，只在主代理准备并绑定的分支与 worktree 内工作。";

describe("职责规矩文件", () => {
  test.each([
    ["worker", ["只完成派工给出的任务", "不清楚就停下来在结果里说明", "外科手术式改动", "\"步骤 → 验证项\"", "只经 one_company_change_apply 写入，只写授权范围",
      "只经 one_company_verification_run（debug）运行", "时不要自己装、不要改依赖清单文件", "项目规范文件 AGENTS.md 不能改", "按 TDD 先红后绿",
      "纯文档、配置等没有可测行为的改动", "测试名写明期望结果", "实现出来的界面须与它一致", "不伪造通过", "不读取 prod 全文，不主动读取 docs/prod 归档或已关闭需求"],
      ["说明注释", "章节编号"]],
    ["worker-prototype", ["本次只做界面原型", "单个 HTML 文件，样式和脚本都写在文件里", "正常、空数据、加载中、出错", "有交互的地方做成可点击的",
      "深色背景、等宽字体、固定 80 列", "多步交互按顺序画出每一步", "按意见改出新版本", "action=prototype"], ["先红后绿"]],
    ["reviewer", ["只审查派工给出的 worker 任务在其可写范围内的改动，不修改任何文件", "目标符合性、安全性、与目标直接相关的鲁棒性、预定的性能条件",
      "先按任务说明里的 git diff 命令查看本次改动", "核对项目规范", "核对 worker 定义的规范", "违反的列为阻塞", "核对界面原型", "核对第三方依赖",
      "「不做、不改」的边界", "核对先红后绿", "未说明合理的不适用理由", "分为阻塞、非阻塞建议、未验证", "kind=debug，只跑被审任务范围的测试",
      "不自填 PASS，不新增验收门槛"], ["核对说明注释"]],
    ["qa", ["按测试名写明的期望结果", "对应不上的标未验证", "不读源码、不修改文件", "分为阻塞、建议、未验证"], []],
    ["explore", [EXPLORE_FIRST_LINE], []],
    ["pm", [PM_FIRST_LINE], []],
  ] as const)("%s 的职责规矩含约定内容且不含已移除内容", (role, included, excluded) => {
    const rules = loadRoleRules(role);
    for (const phrase of included) expect(rules).toContain(phrase);
    for (const phrase of excluded) expect(rules).not.toContain(phrase);
  });
});

describe("内置定义只留元信息", () => {
  test.each(["worker", "reviewer", "qa", "explore"])("%s 不写模型和思考，正文为空串，skills 与 mcp 都是空数组", async (name) => {
    const definition = await readRoleDefinition(join(defaultRoleDir(), `${name}.md`), parseFrontmatter);
    expect(definition.model).toBeUndefined();
    expect(definition.thinking).toBeUndefined();
    expect(definition.body).toBe("");
    expect(definition.skills).toEqual([]);
    expect(definition.mcp).toEqual([]);
  });

  test("包的 files 含 role-rules 目录", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("role-rules");
  });
});

describe("拼装提示词", () => {
  const definition = (body: string): RoleDefinition => ({ name: "ui-dev", role: "worker", description: "d", body });

  test("正文非空时职责规矩排在正文之后，标题下紧跟冲突时以这里为准的说明", () => {
    const prompt = buildAgentPrompt(definition("擅长 React"), "规矩正文X", "任务上下文Y", "MCP状态Z");
    expect(prompt.indexOf("擅长 React")).toBeLessThan(prompt.indexOf("## 职责规矩"));
    expect(prompt).toMatch(/## 职责规矩\n+以下是 worker 职责的流程规矩，由程序提供；与上面的定义正文冲突时以这里为准。\n+规矩正文X/);
  });

  test("正文为空时提示词以职责规矩标题开头，不出现上面的定义正文", () => {
    const prompt = buildAgentPrompt(definition(""), "规矩正文X", "任务上下文Y", "MCP状态Z");
    expect(prompt.startsWith("## 职责规矩")).toBe(true);
    expect(prompt).not.toContain("上面的定义正文");
    expect(prompt).toMatch(/^## 职责规矩\n+规矩正文X/);
  });

  test("职责规矩在通用纪律之前，本次任务与 MCP 状态依次在其后", () => {
    const prompt = buildAgentPrompt(definition("擅长 React"), "规矩正文X", "任务上下文Y", "MCP状态Z");
    const order = ["规矩正文X", "## 工作纪律", "## 本次任务\n任务上下文Y", "## MCP 状态\nMCP状态Z"].map((marker) => prompt.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("派工后子代理收到的提示词", () => {
  const NA = { applicable: false as const, reason: "无性能影响" };
  const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [],
    writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 3, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["其他"] }, performance: NA, ...patch });
  const pmAck: ScriptedReply = { type: "text", text: "PM 收到" };
  const verdict = (summary: string): ScriptedReply => ({ type: "toolcall", name: "one_company_result_submit",
    input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary, findings: [] } } });
  const promptOf = (requests: Context[], marker: string) => requests.find((request) => request.systemPrompt?.includes(marker))?.systemPrompt ?? "";

  async function world() {
    const userDir = await mkdtemp(join(tmpdir(), "pi-t-"));
    cleanups.push(() => rm(userDir, { recursive: true, force: true }));
    await mkdir(userDir, { recursive: true });
    const define = (name: string, body: string) => writeFile(join(userDir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} 专业定义\nrole: worker\n---\n${body}\n`);
    await define("react-dev", "擅长 React");
    await define("blank-dev", "");
    await define("doc-dev", "新函数要写说明注释");
    const w = await createPmRunWorld(cleanups, { userDir, reloadCatalog: true });
    const task = (key: string) => withDatabase(repositoryDatabase(w.fixture.dataRoot, w.fixture.repoId), (db) =>
      db.list<{ key: string; taskId: string; status: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
    const plan = async (tasks: TaskSpec[]) => {
      await w.plan.execute({ action: "propose", tasks });
      await w.plan.execute({ action: "confirm", planVersion: 1 });
    };
    const dispatch = (key: string, mode: { prototype?: { maxTurns: number }; review?: { maxTurns: number } } = {}) =>
      w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null, ...mode });
    return { ...w, userDir, task, plan, dispatch };
  }

  test("正文非空的 worker：正文在职责规矩之前，规矩在通用纪律之前，本次任务在其后，并含 worker 的实现规矩", async () => {
    const w = await world();
    await w.plan([spec("react", { agent: "react-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push({ type: "text", text: "开工" }, pmAck);
    await w.dispatch("react");
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("任务：react（")));
    const prompt = promptOf(w.provider.requests, "任务：react（");
    const order = ["擅长 React", "## 职责规矩", "## 工作纪律", "## 本次任务", "## MCP 状态"].map((marker) => prompt.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).toContain("冲突时以这里为准");
    expect(prompt).toContain("按 TDD 先红后绿");
    expect(prompt).not.toContain("说明注释");
  });

  test("正文为空的 worker：提示词没有定义正文那一句，职责规矩仍在通用纪律之前", async () => {
    const w = await world();
    await w.plan([spec("blank", { agent: "blank-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push({ type: "text", text: "开工" }, pmAck);
    await w.dispatch("blank");
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("任务：blank（")));
    const prompt = promptOf(w.provider.requests, "任务：blank（");
    expect(prompt).not.toContain("上面的定义正文");
    expect(prompt.indexOf("## 职责规矩")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("## 职责规矩")).toBeLessThan(prompt.indexOf("## 工作纪律"));
  });

  test("做原型的 worker 拿到原型规矩，不含先红后绿", async () => {
    const w = await world();
    await w.plan([spec("hud", { ui: true, writePaths: ["src/hud/"] }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push({ type: "text", text: "开工" }, pmAck);
    await w.dispatch("hud", { prototype: { maxTurns: 3 } });
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("本次只做界面原型")));
    const prompt = promptOf(w.provider.requests, "本次只做界面原型");
    expect(prompt).toContain("固定 80 列");
    expect(prompt).not.toContain("先红后绿");
  });

  test("审查所用 worker 定义的正文非空时，reviewer 的任务上下文附上该正文，且用 reviewer 规矩", async () => {
    const w = await world();
    await w.plan([spec("doc", { agent: "doc-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push(verdict("完成 doc"), pmAck);
    await w.dispatch("doc");
    await until(() => w.task("doc").status === "awaiting_review");
    w.provider.queue.push(verdict("符合目标"), pmAck);
    await w.dispatch("doc", { review: { maxTurns: 2 } });
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("审查任务：doc（")));
    const prompt = promptOf(w.provider.requests, "审查任务：doc（");
    expect(prompt).toContain("被审任务所用 worker 定义（doc-dev）的正文：\n新函数要写说明注释");
    expect(prompt).toContain("核对 worker 定义的规范");
    expect(prompt).not.toContain("核对说明注释");
  });

  test("被审 worker 定义的模型用不了时，审查照常派出并附上它的正文", async () => {
    const w = await world();
    await w.plan([spec("doc", { agent: "doc-dev" }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push(verdict("完成 doc"), pmAck);
    await w.dispatch("doc");
    await until(() => w.task("doc").status === "awaiting_review");
    await writeFile(join(w.userDir, "doc-dev.md"), "---\nname: doc-dev\ndescription: doc-dev 专业定义\nrole: worker\nmodel: nowhere/missing-model\n---\n导出函数要写示例\n");
    w.provider.queue.push(verdict("符合目标"), pmAck);
    await w.dispatch("doc", { review: { maxTurns: 2 } });
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("审查任务：doc（")));
    expect(promptOf(w.provider.requests, "审查任务：doc（")).toContain("被审任务所用 worker 定义（doc-dev）的正文：\n导出函数要写示例");
  });

  test.each([
    ["正文为空的专业定义", "blank-dev"],
    ["没指定定义而用默认 worker", undefined],
  ])("审查%s的任务时，reviewer 的任务上下文什么都不附", async (_label, agent) => {
    const w = await world();
    await w.plan([spec("bare", agent ? { agent } : {}), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    w.provider.queue.push(verdict("完成 bare"), pmAck);
    await w.dispatch("bare");
    await until(() => w.task("bare").status === "awaiting_review");
    w.provider.queue.push(verdict("符合目标"), pmAck);
    await w.dispatch("bare", { review: { maxTurns: 2 } });
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("审查任务：bare（")));
    expect(promptOf(w.provider.requests, "审查任务：bare（")).not.toContain("被审任务所用 worker 定义（");
  });

  test("explore 的原职责说明首行出现在职责规矩之后", async () => {
    const w = await world();
    w.provider.queue.push({ type: "text", text: "查完" }, pmAck);
    await w.manager.dispatchExplore({ parent: { role: "PM", pmRunId: w.pm.runId },
      request: { question: "登录模块在哪里", clues: [], source: { kind: "local_file" } }, maxTurns: 2 });
    await until(() => w.provider.requests.some((request) => request.systemPrompt?.includes("检索来源：直接读取本地文件")));
    const prompt = promptOf(w.provider.requests, "检索来源：直接读取本地文件");
    expect(prompt.indexOf("## 职责规矩")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(EXPLORE_FIRST_LINE)).toBeGreaterThan(prompt.indexOf("## 职责规矩"));
  });

  test("PM 的原职责说明首行出现在职责规矩之后", async () => {
    const w = await world();
    const prompt = w.provider.requests[0]!.systemPrompt!;
    expect(prompt.indexOf("## 职责规矩")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(PM_FIRST_LINE)).toBeGreaterThan(prompt.indexOf("## 职责规矩"));
  });
});
