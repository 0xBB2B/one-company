import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import rulesExtension from "../extensions/rules.ts";
import type { WindowContextValue } from "../extensions/lifecycle.ts";
import { registerRequirementInput } from "../extensions/lifecycle.ts";
import { mentionNote } from "../extensions/requirement-manage.ts";
import { packageSkillsDir } from "../runtime/requirement-doc.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function agentRoot() {
  const agentDir = await mkdtemp(join(temporaryRoot(), "rules-")); roots.push(agentDir);
  return { agentDir, dataRoot: join(agentDir, "one-company") };
}
const noWindow = () => { throw new Error("窗口未启动"); };
async function start(windowContext: () => Pick<WindowContextValue, "workspace">, dataRoot?: string) {
  const pi = createFakePi();
  rulesExtension(pi.pi, { windowContext, dataRoot: dataRoot ?? (await agentRoot()).dataRoot });
  return (await pi.handlersFor("before_agent_start")[0]!({ type: "before_agent_start", systemPrompt: "BASE" }, {} as never) as { systemPrompt: string }).systemPrompt;
}

test("主会话系统提示附上当前窗口已接入仓库的路径与 repoId，主代理不必自行计算", async () => {
  const repoId = "a".repeat(64);
  const systemPrompt = await start(() => ({ workspace: { repos: [{ path: "/work/game", repoId, commonDir: "/work/game/.git" }], skipped: [] } }));
  expect(systemPrompt.startsWith("BASE\n\n## 主会话职责")).toBe(true);
  expect(systemPrompt).toContain(`## 当前窗口已接入的仓库\n调用需要 repoId 的工具时使用下列编号，不要自行计算：\n- /work/game → repoId ${repoId}`);
});

test("窗口尚未启动时只附规则，不编造仓库", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("## 主会话职责");
  expect(systemPrompt).not.toContain("当前窗口已接入的仓库");
});

test("M8D2-AC1：主会话系统提示按编号顺序含六条主窗口规范，其后是三条共享规范", async () => {
  const systemPrompt = await start(noWindow);
  const positions = ["## 主会话职责", "## 沟通方式", "## 递进式澄清（禁止脑补）", "## 执行授权", "## 归档需求", "## 简报", "## 工作纪律", "## 收尾自检", "## 搜索范围"]
    .map((heading) => systemPrompt.indexOf(`\n${heading}\n`));
  expect(positions.every((position) => position > 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("M8A-AC7：主会话规则要求先请用户批准草稿，需求生效后再建工作区、派 PM", async () => {
  const systemPrompt = await start(noWindow);
  const approve = systemPrompt.indexOf("confirmUpdate 登记"), prepare = systemPrompt.indexOf("workspace-prepare"), dispatch = systemPrompt.indexOf("role=pm");
  expect(approve).toBeGreaterThan(0);
  expect(prepare).toBeGreaterThan(approve);
  expect(dispatch).toBeGreaterThan(prepare);
  expect(systemPrompt).not.toContain("在请用户批准之前");
});

test("M8C-AC1：零自定义时注入包内默认规范，按背景、需求、功能、实现、验收的顺序列出五大板块及固定编号", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain(`## 需求文档规范\n来源：${join(packageSkillsDir(), "requirement-doc", "SKILL.md")}（包内默认）`);
  const positions = ["## 背景 {#background}", "## 需求 {#requirements}", "## 功能 {#features}", "## 实现 {#implementation}", "## 验收 {#acceptance}"]
    .map((heading) => systemPrompt.indexOf(heading));
  expect(positions.every((position) => position > 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(systemPrompt).toContain("由 PM 规划");
  expect(systemPrompt).toContain("每个标题（包括各级小节标题）末尾都写唯一编号");
});

test("M8C-AC2/AC4：受信任项目的规范取代默认注入主会话，项目未受信任时不生效；规范无效时写明原因", async () => {
  const { agentDir, dataRoot } = await agentRoot(), repo = join(agentDir, "repo"), dir = join(repo, ".pi", "skills", "requirement-doc");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "---\nname: requirement-doc\ndescription: 三板块\nsections:\n  - { id: goal, title: 目标, goal: true }\n" +
    "  - { id: build, title: 做法, record: implementation }\n  - { id: check, title: 检验, record: acceptance }\n---\n目标写清楚谁要什么。\n");
  const window = () => ({ workspace: { repos: [{ path: repo, repoId: "b".repeat(64), commonDir: join(repo, ".git") }], skipped: [] } });
  expect(await start(window, dataRoot)).toContain("（包内默认）");
  new ProjectTrustStore(agentDir).set(repo, true);
  const trusted = await start(window, dataRoot);
  expect(trusted).toContain(`来源：${join(dir, "SKILL.md")}（项目）`);
  expect(trusted).toContain("顶层板块依次为二级标题：`## 目标 {#goal}`、`## 做法 {#build}`、`## 检验 {#check}`");
  expect(trusted).toContain("目标写清楚谁要什么。");
  expect(trusted).not.toContain("## 背景 {#background}");
  await writeFile(join(dir, "SKILL.md"), "---\nname: requirement-doc\nsections: []\n---\n");
  expect(await start(window, dataRoot)).toContain(`## 需求文档规范\n规范无效，批准会被拒绝：需求文档规范 ${join(dir, "SKILL.md")} 无效`);
});

test("M9：主会话规则要求收到需求的那一轮就保存草稿，待澄清的写成未决问题，不先在对话里问完再保存", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("收到需求的那一轮就用 create 保存草稿");
  expect(systemPrompt).toMatch(/要澄清的写进需求板块的未决问题[\s\S]*不要先在对话里问完再保存/);
});

test("主会话规则要求回答功能或行为问题先查代码并写出文件与行号，归档、说明注释和代码不一致时以代码为准并说清哪里不一致", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("回答功能或行为问题前先查代码，回答里写出依据的文件与行号");
  expect(systemPrompt).toContain("归档、说明注释和代码说的不一样时，以代码为准，并说清哪里不一样");
});

test("M9：草稿被核验器拒绝时按原因删去不是用户原话的内容再保存，不算重复试错；草稿没保存成功前不请用户批准", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("保存被草稿核验器拒绝时，按它写的原因删去不是用户原话的内容再保存");
  expect(systemPrompt).toContain("草稿没有保存成功前不要请用户批准");
});

test("M8D-AC9：主会话规则要求需要用户决定的问题都用 ask 登记，先做根源自检、给 2 到 4 个选项并恰好推荐一个，窗口回答只算回答", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toMatch(/需要用户做决定的问题都用 `one_company_user_interact` ask 登记，不在对话里直接问/);
  expect(systemPrompt).toMatch(/根源自检（rootCheck）[\s\S]*2 到 4 个选项[\s\S]*恰好推荐一个（recommended）并写推荐理由（recommendedReason）/);
  expect(systemPrompt).toContain("登记后不要在对话里再列一遍选项");
  expect(systemPrompt).toMatch(/status=answered[\s\S]*直接按回答用 updateDraft 修改草稿，不要再用 reply 登记[\s\S]*status=pending/);
  expect(systemPrompt).toMatch(/带有 blockedReason 时，把它照实告诉用户[\s\S]*以前的决定是否作废/);
  expect(systemPrompt).toContain("blockedBy=window_answer_not_decision");
});

test("M8D-AC1：这句话 @ 到的需求由程序写进本轮系统提示，写明仓库、repoId 与 requirementId；没有 @ 时不附", async () => {
  const repoId = "a".repeat(64), requirementId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
  const window = () => ({ workspace: { repos: [{ path: "/work/game", repoId, commonDir: "/work/game/.git" }], skipped: [] } });
  registerRequirementInput({ revoke() {}, noteOpenedItem() {},
    mentionNote: () => mentionNote([{ repoId, requirementId, title: "角色跳跃" }], window().workspace.repos) });
  try {
    expect(await start(window)).toContain(`## 这句话 @ 到的需求\n用户在这句话里用 @ 指明了下列需求；这句话里的批准只对这些需求有效：\n- 角色跳跃（仓库 /work/game，repoId ${repoId}，requirementId ${requirementId}）`);
    registerRequirementInput({ revoke() {}, noteOpenedItem() {}, mentionNote: () => mentionNote([], []) });
    expect(await start(window)).not.toContain("## 这句话 @ 到的需求");
  } finally { registerRequirementInput(undefined); }
});
