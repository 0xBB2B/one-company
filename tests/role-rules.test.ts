import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildAgentPrompt } from "../src/modules/agents/agent-session.ts";
import { loadRoleRules } from "../src/modules/agents/package-rules.ts";
import type { TaskSpec } from "../src/modules/pm/plan-manage.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import { repositoryDatabase, withDatabase } from "../src/core/storage/database.ts";
import { defaultRoleDir, readRoleDefinition } from "../src/modules/agents/roles.ts";
import type { RoleDefinition } from "../src/modules/agents/roles.ts";
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
      "纯文档、配置等没有可测行为的改动", "测试名写明期望结果", "实现出来的界面须与它一致", "不伪造通过", "不读取 PRD 全文，不主动读取 docs/prd 归档或已关闭需求", "skills 的写法和项目规范冲突时按项目规范"],
      ["说明注释", "章节编号", "本次只做界面原型"]],
    ["reviewer", ["只审查派工给出的 worker 任务在其可写范围内的改动，不修改任何文件", "目标符合性、安全性、与目标直接相关的鲁棒性、预定的性能条件",
      "先按任务说明里的 git diff 命令查看本次改动", "核对项目规范", "核对 worker 定义的规范", "违反的列为阻塞", "核对界面原型", "核对第三方依赖",
      "「不做、不改」的边界", "核对先红后绿", "未说明合理的不适用理由", "分为阻塞、非阻塞建议、未验证", "kind=debug，只跑被审任务范围的测试",
      "不自填 PASS，不新增验收门槛"], ["核对说明注释"]],
    ["qa", ["按测试名写明的期望结果", "对应不上的标未验证", "不读源码、不修改文件", "分为阻塞、建议、未验证"], []],
    ["explore", [EXPLORE_FIRST_LINE], []],
    ["pm", [PM_FIRST_LINE, "nextCursor 不为 null 时带上它继续查", "不可用或已关闭时", "写进任务的 reviewers", "由程序自动挂上", "全部通过任务才算完成", "依赖它的任务才能派出", "本周期两轮打回"], ["reviewAgent"]],
  ] as const)("%s 的职责规矩含约定内容且不含已移除内容", (role, included, excluded) => {
    const rules = loadRoleRules(role);
    for (const phrase of included) expect(rules).toContain(phrase);
    for (const phrase of excluded) expect(rules).not.toContain(phrase);
  });
});

describe("reviewer 职责规矩的 skill 分工", () => {
  test("worker 定义加载的 skill 由专项审查核对，通用审查不因看不到 skill 正文列未验证", () => {
    const rules = loadRoleRules("reviewer");
    const sentence = rules.split(/[。\n]/).find((line) => line.includes("skill") && line.includes("专项审查") && line.includes("未验证"));
    expect(sentence).toBeDefined();
  });

  test("已加载给通用审查的 skill（没有专项审查覆盖的）由它逐条核对", () => {
    const rules = loadRoleRules("reviewer");
    const sentence = rules.split(/[。\n]/).find((line) => line.includes("skill") && line.includes("已加载给你") && line.includes("逐条核对"));
    expect(sentence).toBeDefined();
  });

  test("已加载给你的 skill 逐条核对不挂在没有给出时跳过的条件下", () => {
    const rules = loadRoleRules("reviewer");
    const item = rules.split(/^- /m).find((entry) => entry.includes("已加载给你"));
    expect(item).toBeDefined();
    expect(item).not.toContain("没有给出时跳过");
  });
});

describe("reviewer-specialist 职责规矩", () => {
  test("含只按本任务 skills 核对、通用审查负责项不核对、不适用结论、修法写法、按项目规范，不含通用审查的条目开头", () => {
    const rules = loadRoleRules("reviewer-specialist");
    for (const phrase of ["只按本任务加载的 skills", "由通用审查负责，你不核对", "本次改动不涉及", "修法：", "按项目规范"]) {
      expect(rules).toContain(phrase);
    }
    for (const phrase of ["核对界面原型", "核对需求边界", "核对先红后绿"]) expect(rules).not.toContain(phrase);
  });
});

describe("pm 职责规矩的审查重试", () => {
  test("写明审查没交结论时看原因单独重派、必要时调大轮数上限或补条件，需要额外角度时可临时加专项审查并写理由", () => {
    const rules = loadRoleRules("pm");
    for (const phrase of ["单独重派", "调大轮数上限", "补条件", "不要靠改任务说明", "escalate", "缺什么", "临时加专项审查", "写理由"]) expect(rules).toContain(phrase);
  });
});

describe("pm 职责规矩的返修后审查", () => {
  test("写明返修后再派审查，通用 reviewer 和全部专项审查都重新审一遍，不含只会重审的说法", () => {
    const rules = loadRoleRules("pm");
    expect(rules).toContain("返修后再派审查，通用 reviewer 和全部专项审查都重新审一遍");
    expect(rules).not.toContain("只会重审");
  });
});

describe("worker 职责规矩的重试验证引用", () => {
  test("写明重试时引用前一次尝试的红、自己再跑一次绿", () => {
    const rules = loadRoleRules("worker");
    expect(rules).toContain("重试");
    expect(rules).toMatch(/前一次|更早/);
    expect(rules).toMatch(/重试[^。]*红|红[^。]*重试/);
  });
});

describe("prototype 职责规矩", () => {
  test("含单个 HTML、四种状态、深色等宽 80 列终端、多步按顺序、先读上一版按意见改，不含先红后绿", () => {
    const rules = loadRoleRules("prototype");
    for (const phrase of ["单个 HTML", "样式和脚本", "写在文件里", "正常", "空数据", "加载中", "出错", "深色背景", "等宽字体", "80 列", "按顺序", "上一版", "意见"]) {
      expect(rules).toContain(phrase);
    }
    expect(rules).not.toContain("先红后绿");
  });

  test("任务说明给出上一版文件和用户意见时，按用户原话改、没提到的保持不变，不含返工", () => {
    const rules = loadRoleRules("prototype");
    expect(rules).toContain("任务说明里给出上一版文件和用户的意见时，先用 read 读上一版，按用户原话改，没提到的地方保持不变");
    expect(rules).not.toContain("返工");
  });
});

describe("下游职责规矩的原型要求", () => {
  test.each([
    ["worker", ["有原型时先读原型", "与它一致"]],
    ["reviewer", ["与原型不一致", "改了界面但需求里没有用户通过的原型"]],
    ["qa", ["对照原型逐项验收", "不一致"]],
    ["pm", ["要改用户看得到的界面", "批准版本里没有对应原型", "不派这个任务", "上报", "回主窗口补原型", "批准新版本", "面板上还有", "调整"]],
  ] as const)("%s 的职责规矩含原型要求", (role, phrases) => {
    const rules = loadRoleRules(role);
    for (const phrase of phrases) expect(rules).toContain(phrase);
  });

  test("pm 的职责规矩不再让 PM 写 ui 标记或带 prototype 派工", () => {
    const rules = loadRoleRules("pm");
    for (const phrase of ["ui 写成 true", "带 prototype 派"]) expect(rules).not.toContain(phrase);
  });
});

describe("内置定义只留元信息", () => {
  test.each(["worker", "reviewer", "qa", "explore", "prototype"])("%s 不写模型和思考，正文为空串，skills 与 mcp 都是空数组", async (name) => {
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
    const dispatch = (key: string, mode: { review?: { maxTurns: number } } = {}) =>
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

describe("pm 职责规矩的需求更新后请求拆分", () => {
  const sentencesOf = (text: string) => text.split(/[。\n]/);

  test("已执行没完成的任务想拆分时用 escalate 带 taskId 与 note 请求用户决定", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("escalate") && line.includes("拆分") && line.includes("taskId") && line.includes("note"));
    expect(sentence).toBeDefined();
    expect(rules).toMatch(/需求更新后[^。\n]*受影响[^。\n]*(已执行|占住目标)|(已执行|占住目标)[^。\n]*受影响/u);
  });

  test("请求拆分的那一句同时写明适用情形与请用户决定", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("escalate") && line.includes("拆分") && line.includes("taskId"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("需求更新后");
    expect(sentence).toMatch(/用户决定/u);
  });

  test("用户选拆分后可取消该任务把目标交给新任务，不等新的批准版本", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("选拆分") && line.includes("取消") && line.includes("新任务"));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/不需要等新的批准版本|不用等新的批准版本|不等新的批准版本/u);
  });

  test("没选调整或拆分时只能修改任务本身的通用限制同一句写明目标不能减少", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("用户没对它选调整或拆分时只能修改它本身"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("目标不能减少");
  });

  test("用户选不拆就原地修改，且本批准版本内不要再请求拆分写在同一句", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("不拆") && line.includes("原地修改"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("本批准版本内");
    expect(sentence).toContain("不要再");
  });

  test("子代理还在暂停时先用 agent_manage stop 停掉再上报请求拆分", () => {
    const rules = loadRoleRules("pm");
    const item = rules.split("\n").find((line) => line.includes("收到已批准的需求更新时"))!;
    expect(item).toBeDefined();
    const sentence = item.split(/[。；]/).find((part) => part.includes("暂停") && part.includes("agent_manage") && part.includes("stop") && (part.includes("上报") || part.includes("请求拆分")));
    expect(sentence).toBeDefined();
  });

  test("用户选不拆后本批准版本内不要再为它请求拆分", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("本批准版本内") && line.includes("请求拆分"));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/不要再/u);
  });

  test("用户选不拆与本批准版本内不要再请求拆分写在同一句", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("不拆") && line.includes("本批准版本内"));
    expect(sentence).toBeDefined();
  });

  test("收到已批准的需求更新那一条里「目标不能减少」只出现在一句话里", () => {
    const rules = loadRoleRules("pm");
    const item = rules.split("\n").find((line) => line.includes("收到已批准的需求更新时"))!;
    expect(item).toBeDefined();
    const hits = item.split(/[。；]/).filter((part) => part.includes("目标不能减少"));
    expect(hits).toHaveLength(1);
  });

  test("计划与批准对不上时直接改计划的那句写明拆分要先上报的例外", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("直接改计划"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("拆分");
    expect(sentence).toContain("上报");
  });

  test("不要先把占住目标的任务原地改写成大任务再派出", () => {
    const rules = loadRoleRules("pm");
    const sentence = sentencesOf(rules).find((line) => line.includes("原地改写") && line.includes("大任务"));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/不要先/u);
  });

  test("拆分请求相关文字不含「不再」「无需」「夹具」", () => {
    const rules = loadRoleRules("pm");
    const related = sentencesOf(rules).filter((line) => line.includes("拆分") || line.includes("不拆") || line.includes("原地改写"));
    expect(related.length).toBeGreaterThan(0);
    for (const line of related) for (const word of ["不再", "无需", "夹具"]) expect(line).not.toContain(word);
  });
});

describe("PM 的 workflow_manage 工具说明", () => {
  const workflowDescription = async () => {
    const w = await createPmRunWorld(cleanups);
    const tool = w.provider.requests[0]!.tools!.find((entry) => entry.name === "one_company_workflow_manage")!;
    return tool.description;
  };

  test("escalate 的适用情形写明需求更新后受影响、已执行没完成的任务想拆分时", async () => {
    const description = await workflowDescription();
    const sentence = description.split(/[；。]/).find((part) => part.includes("escalate") && part.includes("拆分"));
    expect(sentence).toBeDefined();
    expect(sentence).toMatch(/需求更新后/u);
    expect(sentence).toContain("已执行没完成");
    expect(sentence).toMatch(/用户决定/u);
  });

  test("工具说明新增文字不含「不再」「无需」「夹具」", async () => {
    const description = await workflowDescription();
    for (const word of ["不再", "无需", "夹具"]) expect(description).not.toContain(word);
  });
});
