import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import rulesExtension from "../src/app/extension/rules.ts";
import type { WindowContextValue } from "../src/core/host/extension-lifecycle.ts";
import { registerRequirementInput } from "../src/core/host/extension-lifecycle.ts";
import { mentionNote } from "../src/modules/interaction/requirement-manage-extension.ts";
import { packageSkillsDir } from "../src/modules/requirement/requirement-doc.ts";
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

test("窗口没有接入仓库时告诉主代理需求和后台代理工具用不了，以及用户该怎么做", async () => {
  const systemPrompt = await start(() => ({ workspace: { repos: [], skipped: [] } }));
  expect(systemPrompt).toContain("## 当前窗口没有接入 Git 仓库\n当前目录和它的子目录里都没有 Git 仓库，需要 repoId 的需求和后台代理工具都用不了，不要调用。"
    + "用户想用这些功能时，请告诉用户把当前目录建成 Git 仓库（git init），或者在子目录里各自建成 Git 仓库，然后重新启动 pi。");
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
  const run = promisify(execFile);
  await run("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
  await run("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await writeFile(join(dir, "SKILL.md"), "---\nname: requirement-doc\ndescription: 三板块\nsections:\n  - { id: goal, title: 目标, goal: true }\n" +
    "  - { id: build, title: 做法, record: implementation }\n  - { id: check, title: 检验, record: acceptance }\n---\n目标写清楚谁要什么。\n");
  const window = () => ({ workspace: { repos: [{ path: repo, repoId: "b".repeat(64), commonDir: join(repo, ".git") }], skipped: [] } });
  expect(await start(window, dataRoot)).toContain("（包内默认）");
  new ProjectTrustStore(agentDir).set(repo, true);
  const trusted = await start(window, dataRoot);
  expect(trusted).toContain(`来源：${join(await realpath(repo), ".pi", "skills", "requirement-doc", "SKILL.md")}（项目）`);
  expect(trusted).toContain("顶层板块依次为二级标题：`## 目标 {#goal}`、`## 做法 {#build}`、`## 检验 {#check}`");
  expect(trusted).toContain("目标写清楚谁要什么。");
  expect(trusted).not.toContain("## 背景 {#background}");
  await writeFile(join(dir, "SKILL.md"), "---\nname: requirement-doc\nsections: []\n---\n");
  expect(await start(window, dataRoot)).toContain(`## 需求文档规范\n规范无效，批准会被拒绝：需求文档规范 ${join(await realpath(repo), ".pi", "skills", "requirement-doc", "SKILL.md")} 无效`);
});

describe("在 linked worktree 里打开 pi，需求文档规范按主仓库目录判断项目层", () => {
  const skillFile = (title: string) => `---\nname: requirement-doc\ndescription: 三板块\nsections:\n  - { id: goal, title: ${title}, goal: true }\n` +
    "  - { id: build, title: 做法, record: implementation }\n  - { id: check, title: 检验, record: acceptance }\n---\n";
  async function linked(mainTrusted: boolean, worktreeTrusted: boolean) {
    const { agentDir, dataRoot } = await agentRoot(), repo = join(agentDir, "repo"), worktree = join(agentDir, "wt"), run = promisify(execFile);
    await mkdir(repo);
    await run("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
    await run("git", ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    await run("git", ["worktree", "add", "-q", worktree], { cwd: repo });
    const mainDir = join(repo, ".pi", "skills", "requirement-doc"), worktreeDir = join(worktree, ".pi", "skills", "requirement-doc");
    await mkdir(mainDir, { recursive: true }); await mkdir(worktreeDir, { recursive: true });
    await writeFile(join(mainDir, "SKILL.md"), skillFile("主仓库目标"));
    await writeFile(join(worktreeDir, "SKILL.md"), skillFile("工作目录目标"));
    const store = new ProjectTrustStore(agentDir); store.set(repo, mainTrusted); store.set(worktree, worktreeTrusted);
    const window = () => ({ workspace: { repos: [{ path: worktree, repoId: "c".repeat(64), commonDir: join(repo, ".git") }], skipped: [] } });
    return { prompt: await start(window, dataRoot), mainFile: join(await realpath(repo), ".pi", "skills", "requirement-doc", "SKILL.md") };
  }

  test("主仓库信任、worktree 不信任：来源是主仓库的文件，标签为项目，板块取自主仓库的文件", async () => {
    const { prompt, mainFile } = await linked(true, false);
    expect(prompt).toContain(`来源：${mainFile}（项目）`);
    expect(prompt).toContain("`## 主仓库目标 {#goal}`");
    expect(prompt).not.toContain("工作目录目标");
  });

  test("主仓库不信任、worktree 信任：不用项目层，落到包内默认", async () => {
    const { prompt } = await linked(false, true);
    expect(prompt).toContain("（包内默认）");
    expect(prompt).not.toContain("（项目）");
    expect(prompt).not.toContain("目标 {#goal}");
  });
});

test("M9：主会话规则要求收到需求的那一轮就保存草稿，待澄清的写成未决问题，不先在对话里问完再保存", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("收到需求的那一轮就用 create 保存草稿");
  expect(systemPrompt).toMatch(/要澄清的写进需求板块的未决问题[\s\S]*不要先在对话里问完再保存/);
});

test("主会话规则要求回答功能或行为问题先查代码并写出文件与行号、行号取自带行号的结果，归档、说明注释和代码不一致时以代码为准并说清哪里不一致", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("回答功能或行为问题前先查代码，回答里写出依据的文件与行号");
  expect(systemPrompt).toContain("行号取自知识查询结果里的起止行或 `grep -n` 的输出，读文件工具返回的正文不带行号，不要自己数");
  expect(systemPrompt).toContain("归档、说明注释和代码说的不一样时，以代码为准，并说清哪里不一样");
});

test("主会话规则说明从代码查需求：先看提交说明里的编号，没有就看提交是否新增了 docs/prd 归档，再按编号读归档，没有编号或归档时照实说", async () => {
  const systemPrompt = await start(noWindow);
  expect(systemPrompt).toContain("git log --format='%h %s%n%b' -- <文件>");
  expect(systemPrompt).toContain("git log -L <起始行>,<结束行>:<文件>");
  expect(systemPrompt).toMatch(/末尾有一行 `Requirement: <编号>`[\s\S]*标题里可能带 `\[<编号>\]`/);
  expect(systemPrompt).toMatch(/先看提交说明[\s\S]*说明里都没有时/);
  expect(systemPrompt).toContain("git show --name-only --diff-filter=A <提交>");
  expect(systemPrompt).toContain("git log --diff-filter=A --format='%h %s' -- 'docs/prd/<编号>.*'");
  expect(systemPrompt).toContain("git log --grep <编号>");
  expect(systemPrompt).toContain("实现记录");
  expect(systemPrompt).toContain("读 `docs/prd` 下以这个编号开头的归档文件");
  expect(systemPrompt).toMatch(/找不到归档[\s\S]*把编号告诉用户/);
  expect(systemPrompt).toMatch(/两个来源都没有编号的[\s\S]*照实说查不到对应需求，只读提交说明/);
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

describe("新技术须经用户同意：主会话系统提示", () => {
  test("TD-01 需求要用新技术时，请用户批准需求之前用 one_company_user_interact 的 ask-tech 一次列出全部新技术", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/新技术[\s\S]*批准需求之前[\s\S]*one_company_user_interact[\s\S]*ask-tech[\s\S]*一次列出全部/);
  });

  test("TD-02 新技术范围含编程语言、框架、数据库、第三方库、中间件或外部服务、工具（如 Docker），以及要升级的已有第三方库", async () => {
    const prompt = await start(noWindow);
    for (const word of ["编程语言", "框架", "数据库", "第三方库", "中间件", "外部服务", "Docker", "升级"]) expect(prompt).toContain(word);
    expect(prompt).toMatch(/新技术[\s\S]*Docker[\s\S]*升级已有的?第三方库|升级[\s\S]*已有[\s\S]*第三方库/);
  });

  test("TD-03 读依赖清单文件（package.json、go.mod）和代码目录判断项目里有没有，拿不准就当新技术", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/package\.json[\s\S]*go\.mod[\s\S]*代码目录[\s\S]*拿不准就当新技术/);
  });

  test("TD-04 来源填法：用户点名、项目规范（AGENTS.md、专项代理、skill 推荐）、AI 提议；推荐依据不能代替用户同意", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/用户点名[\s\S]*项目规范[\s\S]*AGENTS\.md[\s\S]*AI 提议/);
    expect(prompt).toMatch(/推荐依据[\s\S]*不能代替用户同意/);
  });

  test("TD-05 用户全部同意后用 updateDraft 把每项名称和类别写进「实现」板块，同意前不写", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/全部同意后[\s\S]*updateDraft[\s\S]*名称和类别[\s\S]*「实现」板块/);
    expect(prompt).toMatch(/同意前不写/);
  });

  test("TD-06 用户写了修改意见，改好清单再用 ask-tech 弹一次完整清单，连带要用的新技术也列进去", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/修改意见[\s\S]*ask-tech[\s\S]*完整清单[\s\S]*连带/);
  });

  test("TD-07 状态面板里 PM 上报要用新技术的待裁决任务，用 purpose=panel-item 的 ask-tech；全部同意后先按返回的 next 以 adjudicate 登记，再写进「实现」板块请用户批准新版本", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/PM 上报[\s\S]*新技术[\s\S]*purpose=panel-item[\s\S]*ask-tech[\s\S]*返回的 next[\s\S]*adjudicate[\s\S]*「实现」板块[\s\S]*批准新版本/);
  });

  test("TD-08 包内默认需求文档规范的「实现」说明含「用户在技术清单窗口里同意的技术」，五大板块不变", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/- 实现：[^\n]*用户在技术清单窗口里同意的技术/);
    const positions = ["## 背景 {#background}", "## 需求 {#requirements}", "## 功能 {#features}", "## 实现 {#implementation}", "## 验收 {#acceptance}"].map((heading) => prompt.indexOf(heading));
    expect(positions.every((position) => position > 0)).toBe(true);
  });

  test("TD-28 项目里已经在用的技术接着用不算新技术；来源是项目规范的技术同样要用户同意并写进「实现」板块", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toContain("项目里已经在用的接着用不算");
    expect(prompt).toMatch(/来源是“项目规范”的技术同样要用户同意，同意后同样写进「实现」板块/);
  });

  test("TD-29 用户按 Esc 暂不回答后在对话里同意或改，照样处理；面板里 PM 上报的新技术事项用 ask-tech、不用 ask", async () => {
    const prompt = await start(noWindow);
    expect(prompt).toMatch(/按 Esc 暂不回答时清单保留，之后在对话里说同意或修改意见，也照这样处理/);
    expect(prompt).toMatch(/purpose=panel-item 的 ask-tech 把这些技术列给用户，不用 ask/);
  });

  test("TD-30 在对话里展示草稿要点请用户确认或批准之前，先用 ask-tech 弹技术清单；确认和批准两种说法都算", async () => {
    const prompt = await start(noWindow);
    const sentences = prompt.split(/[。；\n]/);
    const hit = sentences.filter((sentence) => /需求要用新技术/.test(sentence) && sentence.includes("ask-tech") && /展示草稿/.test(sentence) && sentence.includes("确认") && sentence.includes("批准") && /之前|先/.test(sentence));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("TD-31 「实现」板块还写不出具体技术（未选定、由 PM 规划）时，不请用户确认或批准需求", async () => {
    const prompt = await start(noWindow);
    const sentences = prompt.split(/[。；\n]/);
    const hit = sentences.filter((sentence) => /需求要用新技术/.test(sentence) && sentence.includes("「实现」板块") && sentence.includes("未选定") && sentence.includes("PM 规划") && /(不要?|不得|不能|禁止)[^，。]*请用户/.test(sentence) && sentence.includes("确认") && sentence.includes("批准"));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("TD-32 要用哪些新技术由主代理提出、用户确认，不留给 PM 去选", async () => {
    const prompt = await start(noWindow);
    const sentences = prompt.split(/[。；\n]/);
    const hit = sentences.filter((sentence) => sentence.includes("新技术") && sentence.includes("PM") && sentence.includes("选") && /不(要|得|能|留|交|由|让)/.test(sentence) && sentence.includes("提出") && sentence.includes("用户确认"));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("TD-33 PM 上报新技术待裁决任务的 panel-item ask-tech 那条，写明这条路只用来补主代理当初没预见到的技术", async () => {
    const prompt = await start(noWindow);
    const line = prompt.split("\n").find((candidate) => /purpose=panel-item[^\n]*ask-tech/.test(candidate) && candidate.includes("PM 上报"));
    expect(line).toBeDefined();
    expect(line).toMatch(/(只|仅)(用来|用于)[^。；]*(没|未)预见/);
  });

  test("TD-34 只用项目里已有技术的需求，「实现」板块写「由 PM 规划」也可以请用户批准", async () => {
    const prompt = await start(noWindow);
    const sentences = prompt.split(/[。；\n]/);
    const hit = sentences.filter((sentence) => /已有|已经在用/.test(sentence) && sentence.includes("由 PM 规划") && sentence.includes("请用户") && sentence.includes("批准") && !sentence.includes("不请用户"));
    expect(hit.length).toBeGreaterThan(0);
  });

  test("TD-09 主会话新增的新技术相关句子不含「不再」", async () => {
    const prompt = await start(noWindow);
    const related = prompt.split(/[。\n]/).filter((line) => line.includes("ask-tech"));
    expect(related.length).toBeGreaterThan(0);
    for (const line of related) expect(line).not.toContain("不再");
  });
});
