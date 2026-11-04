import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openExamplesPage } from "../src/modules/settings/examples-extension.ts";
import { saveDisabledAgentsSetting, userSettingsPath } from "../src/modules/settings/agent-settings.ts";

const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";
const theme = { fg: (_kind: string, text: string) => text, bg: (_kind: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
const EXAMPLES = join(import.meta.dirname, "..", "examples");

type Screen = { keys: (...k: string[]) => void; text: string };
type Step = (screen: Screen) => void;

let root = "", agentDir = "", repoDir = "", savedAgentDir: string | undefined;

afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  savedAgentDir = undefined;
  for (const dir of [join(agentDir, "skills"), join(agentDir, "agents")]) if (existsSync(dir)) chmodSync(dir, 0o755);
  await rm(root, { recursive: true, force: true });
});

async function setup(options: { trusted?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "pi-t-"));
  agentDir = join(root, "agent");
  repoDir = join(root, "repo");
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  if (options.trusted !== undefined) await setTrust(options.trusted);
}

const trustPath = () => join(agentDir, "trust.json");
async function setTrust(value: boolean) {
  await writeFile(trustPath(), JSON.stringify({ [await realpath(repoDir)]: value }));
}
const setTrustSync = (value: boolean) => writeFileSync(trustPath(), JSON.stringify({ [realpathSync(repoDir)]: value }));
async function readTrust(): Promise<Record<string, boolean>> {
  return JSON.parse(await readFile(trustPath(), "utf8"));
}

const tagTheme = { ...theme, fg: (kind: string, text: string) => `<${kind}>${text}</${kind}>` };

async function run(steps: Step[], options: { width?: number; theme?: typeof theme } = {}) {
  const queue = [...steps];
  const screens: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, options.theme ?? theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = queue.shift();
        if (!step) throw new Error("脚本步骤用完了");
        const text = component.render(options.width ?? 200).map((line) => line.trimEnd()).join("\n");
        screens.push(text);
        step({ keys: (...keys) => { for (const key of keys) component.handleInput(key); }, text });
      });
    },
    notify(message: string, level?: string) { notifications.push({ message, level }); },
  };
  const ctx = { hasUI: true, mode: "tui", cwd: repoDir, ui, modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false }, model: undefined };
  await openExamplesPage(ctx as never);
  expect(queue).toHaveLength(0);
  return { screens, notifications, last: () => notifications[notifications.length - 1]!.message };
}

const pick = (...sequence: string[]): Step => ({ keys }) => keys(...sequence);
const GOLANG = pick(ENTER), VUE = pick(DOWN, ENTER), USER_LAYER = pick(ENTER), PROJECT_LAYER = pick(DOWN, ENTER);
const COPY = pick(ENTER), SKIP_COPY = pick(DOWN, ENTER), CANCEL = pick(ESC);
const capture = (store: string[], then: Step): Step => (screen) => { store.push(screen.text); then(screen); };

const sample = (name: string, ...parts: string[]) => readFile(join(EXAMPLES, name, ...parts), "utf8");
const exists = (path: string) => existsSync(path);
const tildeOf = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

async function copyGolangToUser() {
  await run([GOLANG, USER_LAYER, COPY]);
}

const userDir = () => `${tildeOf(agentDir)}/`;
const projectDir = async () => `${tildeOf(await realpath(repoDir))}/.pi/`;
const read = async (path: string) => (await readFile(path)).toString("utf8");

async function seed(example: string, layerDir: string, only?: { skills?: string[]; agents?: string[] }) {
  for (const name of only?.skills ?? await readdir(join(EXAMPLES, example, "skills"))) {
    await cp(join(EXAMPLES, example, "skills", name), join(layerDir, "skills", name), { recursive: true });
  }
  for (const file of only?.agents ?? await readdir(join(EXAMPLES, example, "agents"))) {
    await mkdir(join(layerDir, "agents"), { recursive: true });
    await cp(join(EXAMPLES, example, "agents", file), join(layerDir, "agents", file));
  }
}

async function appendTo(path: string) {
  await writeFile(path, `${await readFile(path, "utf8")}\n改过\n`);
}

function confirmBody(screen: string): string[] {
  const rows = screen.split("\n").map((line) => line.trim());
  const start = rows.findIndex((row) => /^复制 \d+ 份到 /u.test(row) || row === "这一层没有要复制的。");
  const end = rows.findIndex((row, i) => i > start && /^(→ )?复制$/u.test(row));
  const body = rows.slice(start, end);
  while (body[body.length - 1] === "") body.pop();
  return body;
}

describe("空代理目录、授信记录为空", () => {
  test("窗口一项目层写实际复制状态，窗口二项目层可选并写明选它会设为受信任", async () => {
    await setup();
    const screens: string[] = [];
    await run([capture(screens, GOLANG), capture(screens, CANCEL)]);
    expect(screens[0]).toContain("要用哪套设计规范样例？");
    expect(screens[0]).toContain("选中后再选复制到哪一层；skills 和角色定义一起复制。");
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制 · 项目层：未复制");
    expect(screens[0]).toMatch(/vue.*Vue 前端 · 用户层：未复制 · 项目层：未复制/u);
    expect(screens[0]).not.toContain("未受信任");
    expect(screens[1]).toContain("把 Go 后端样例复制到哪一层？");
    expect(screens[1]).toContain(`${agentDir}/ · 对你的所有项目生效`);
    expect(screens[1]).toContain(`${await realpath(repoDir)}/ · 只对这个项目生效 · 选它会把本项目设为受信任`);
    expect(screens[1]).not.toContain("暂不能复制到这里");
    expect(screens[1]).not.toContain("先输入 /trust 选 Trust");
  });

  test("窗口一项目层写实际复制状态：项目层已复制时写已复制", async () => {
    await setup({ trusted: true });
    await run([GOLANG, PROJECT_LAYER, COPY]);
    await rm(trustPath());
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制 · 项目层：已复制");
  });

  test("项目层已全部复制：窗口二项目层灰掉写已全部复制，和样例一致", async () => {
    await setup({ trusted: true });
    await run([GOLANG, PROJECT_LAYER, COPY]);
    await rm(trustPath());
    const screens: string[] = [];
    await run([GOLANG, capture(screens, CANCEL)]);
    expect(screens[0]).toMatch(/项目层.*已全部复制，和样例一致/u);
    expect(screens[0]).not.toContain("选它会把本项目设为受信任");
  });
});

describe("空代理目录、你在 pi 里选过不信任", () => {
  test("窗口一项目层写未受信任，窗口二项目层灰掉并写明去 /trust", async () => {
    await setup({ trusted: false });
    const screens: string[] = [];
    await run([capture(screens, GOLANG), capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制 · 项目层：未受信任");
    expect(screens[0]).toMatch(/vue.*Vue 前端 · 用户层：未复制 · 项目层：未受信任/u);
    expect(screens[1]).toContain("你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust");
    expect(screens[1]).not.toContain("选它会把本项目设为受信任");
  });

  test("项目层已复制过也写未受信任", async () => {
    await setup({ trusted: true });
    await run([GOLANG, PROJECT_LAYER, COPY]);
    await setTrust(false);
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("项目层：未受信任");
  });

  test("用户层已全部复制：提前结束，提示保持原文字", async () => {
    await setup({ trusted: false });
    await copyGolangToUser();
    const screens: string[] = [];
    const result = await run([capture(screens, GOLANG)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：已复制 · 项目层：未受信任");
    expect(result.last()).toBe("Go 后端样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。");
  });
});

describe("授信记录为信任", () => {
  test("项目受信任时窗口二的项目层写主仓库目录，不带设为受信任的说明，窗口一项目层状态为未复制", async () => {
    await setup({ trusted: true });
    const screens: string[] = [];
    await run([capture(screens, GOLANG), capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制 · 项目层：未复制");
    expect(screens[1]).toContain(`${await realpath(repoDir)}/ · 只对这个项目生效`);
    expect(screens[1]).not.toContain("选它会把本项目设为受信任");
    expect(screens[1]).not.toContain("先输入 /trust 选 Trust");
  });
});

describe("用户层已全部复制时的提前结束", () => {
  test("授信记录为空、项目层没复制：不提前结束，进入选层窗口，用户层灰掉、项目层可选", async () => {
    await setup();
    await copyGolangToUser();
    const screens: string[] = [];
    await run([GOLANG, capture(screens, CANCEL)]);
    expect(screens[0]).toContain("把 Go 后端样例复制到哪一层？");
    expect(screens[0]).toMatch(/用户层.*已全部复制，和样例一致/u);
    expect(screens[0]).toContain("选它会把本项目设为受信任");
  });

  test("授信记录为空、项目层也已全部复制：提前结束，提示两层都和样例一致", async () => {
    await setup({ trusted: true });
    await run([GOLANG, USER_LAYER, COPY]);
    await run([GOLANG, PROJECT_LAYER, COPY]);
    await rm(trustPath());
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层和项目层都已全部复制，和样例一致。");
  });

  test("授信记录为不信任、项目层已全部复制：仍提前结束，提示保持原文字", async () => {
    await setup({ trusted: true });
    await run([GOLANG, USER_LAYER, COPY]);
    await run([GOLANG, PROJECT_LAYER, COPY]);
    await setTrust(false);
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。");
  });
});

describe("golang 复制到用户层", () => {
  test("全新复制：确认窗口正文只有一行份数，结果只有一行，只弹出三个窗口", async () => {
    await setup();
    const screens: string[] = [];
    const result = await run([GOLANG, USER_LAYER, capture(screens, COPY)]);
    expect(screens[0]).toContain("把 Go 后端样例复制到用户层？");
    expect(confirmBody(screens[0]!)).toEqual([`复制 12 份到 ${userDir()}：10 份 skill、2 份角色定义。`]);
    expect(screens[0]).not.toContain("AGENTS.md");
    expect(screens[0]).toMatch(/^\s*(→ )?复制$/mu);
    expect(screens[0]).toMatch(/^\s*(→ )?不复制$/mu);

    expect((await readdir(join(agentDir, "skills"))).sort()).toEqual((await readdir(join(EXAMPLES, "golang", "skills"))).sort());
    for (const name of await readdir(join(EXAMPLES, "golang", "skills"))) {
      expect(await readFile(join(agentDir, "skills", name, "SKILL.md"), "utf8")).toBe(await sample("golang", "skills", name, "SKILL.md"));
    }
    expect((await readdir(join(agentDir, "agents"))).sort()).toEqual(["go-reviewer.md", "go-worker.md"]);

    expect(result.screens).toHaveLength(3);
    expect(result.notifications).toHaveLength(1);
    expect(result.last()).toBe("✓ Go 后端样例已复制到用户层：新复制 12 个文件。");
  });

  test("用户层已有和样例一样的 golang-testing：第一行少一份 skill，第二行写跳过的份数", async () => {
    await setup();
    await seed("golang", agentDir, { skills: ["golang-testing"], agents: [] });
    const screens: string[] = [];
    await run([GOLANG, USER_LAYER, capture(screens, SKIP_COPY)]);
    expect(confirmBody(screens[0]!)).toEqual([
      `复制 11 份到 ${userDir()}：9 份 skill、2 份角色定义。`,
      "已经有、和样例一样的 1 份，跳过。",
    ]);
  });

  test("再次运行：窗口一显示用户层已复制，授信记录为空时项目层写未复制", async () => {
    await setup();
    await copyGolangToUser();
    const screens: string[] = [];
    await run([capture(screens, GOLANG), CANCEL]);
    expect(screens[0]).toContain("Go 后端 · 用户层：已复制 · 项目层：未复制");
  });

  test("用户层和项目层都已全部复制时，提示两层都和样例一致", async () => {
    await setup({ trusted: true });
    await run([GOLANG, USER_LAYER, COPY]);
    await run([GOLANG, PROJECT_LAYER, COPY]);
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层和项目层都已全部复制，和样例一致。");
  });

  test("用户层 skills 目录没有写权限：提示两行，原因和目录写在第一行，已复制的份数写在第二行", async () => {
    if (process.getuid?.() === 0) return;
    await setup();
    await mkdir(join(agentDir, "skills"), { recursive: true });
    chmodSync(join(agentDir, "skills"), 0o555);
    const result = await run([GOLANG, USER_LAYER, COPY]);
    const lines = result.last().split("\n");
    const kept = exists(join(agentDir, "agents")) ? (await readdir(join(agentDir, "agents"))).length : 0;
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith(`✗ 复制没有完成：没有权限写入 ${join(agentDir, "skills")}/`)).toBe(true);
    expect(lines[1]!.trim()).toBe(`已复制的 ${kept} 个文件保留；解决后再运行 /one:examples 会接着补。`);
    expect(result.notifications[0]!.level).toBe("error");
  });
});

describe("AGENTS.md 不读不写", () => {
  const original = "个人规范一\n\n## 后端设计约定\n\n自己写的\n";

  test.each([["原来不存在", null], ["原来有内容，含样例标题", original]] as const)("用户层和项目层各复制一次 golang：%s的 AGENTS.md 前后逐字节相同", async (_name, content) => {
    await setup({ trusted: true });
    const paths = [join(agentDir, "AGENTS.md"), join(await realpath(repoDir), "AGENTS.md")];
    if (content !== null) for (const path of paths) await writeFile(path, content);
    await run([GOLANG, USER_LAYER, COPY]);
    await run([GOLANG, PROJECT_LAYER, COPY]);
    for (const path of paths) {
      if (content === null) expect(exists(path)).toBe(false);
      else expect(await read(path)).toBe(content);
    }
  });

  test("以前复制进去的那一段不影响状态：skills 和定义都没有时，目标 AGENTS.md 里有样例标题也是未复制", async () => {
    await setup();
    await writeFile(join(agentDir, "AGENTS.md"), original);
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制");
  });
});

describe("层状态只看 skills 和定义", () => {
  async function windowOneText() {
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    return screens[0]!;
  }

  test.each([["没有 AGENTS.md", null], ["有样例那一段", "## 后端设计约定\n\n内容\n"], ["有别的内容", "## 别的约定\n"]] as const)("skills 和定义全部一样，目标%s：已复制", async (_name, content) => {
    await setup();
    await seed("golang", agentDir);
    if (content !== null) await writeFile(join(agentDir, "AGENTS.md"), content);
    expect(await windowOneText()).toContain("Go 后端 · 用户层：已复制");
  });

  test("项目层 skills 和定义全部一样，仓库根目录 AGENTS.md 里有样例那一段：项目层已复制", async () => {
    await setup({ trusted: true });
    await seed("golang", join(repoDir, ".pi"));
    await writeFile(join(repoDir, "AGENTS.md"), "## 后端设计约定\n\n内容\n");
    expect(await windowOneText()).toContain("项目层：已复制");
  });

  test("删一份 skill：部分复制", async () => {
    await setup();
    await seed("golang", agentDir);
    await writeFile(join(agentDir, "AGENTS.md"), "## 后端设计约定\n\n内容\n");
    await rm(join(agentDir, "skills", "api-design"), { recursive: true });
    expect(await windowOneText()).toContain("Go 后端 · 用户层：部分复制");
  });

  test("改一个 skill 文件：有改动", async () => {
    await setup();
    await seed("golang", agentDir);
    await appendTo(join(agentDir, "skills", "golang-testing", "SKILL.md"));
    expect(await windowOneText()).toContain("Go 后端 · 用户层：有改动");
  });
});

describe("确认窗口正文", () => {
  async function confirmText(steps: Step[], options?: Parameters<typeof run>[1]) {
    const screens: string[] = [];
    await run([...steps, capture(screens, SKIP_COPY)], options);
    return screens[0]!;
  }

  test("项目层有改过的 version-policy、用户层有 go-worker.md、go-reviewer 关闭：份数行后空一行，三行警示按顺序", async () => {
    await setup({ trusted: true });
    await seed("golang", join(repoDir, ".pi"), { skills: ["version-policy"], agents: [] });
    await appendTo(join(repoDir, ".pi", "skills", "version-policy", "SKILL.md"));
    await seed("golang", agentDir, { skills: [], agents: ["go-worker.md"] });
    await saveDisabledAgentsSetting(userSettingsPath(agentDir), ["go-reviewer"]);
    const text = await confirmText([GOLANG, PROJECT_LAYER]);
    expect(confirmBody(text)).toEqual([
      `复制 11 份到 ${await projectDir()}：9 份 skill、2 份角色定义。`,
      "",
      "你改过的 1 份保留你的版本，不覆盖：skills/version-policy",
      `go-worker 会替换你在用户层的同名定义 ${tildeOf(join(agentDir, "agents", "go-worker.md"))}。`,
      "go-reviewer 在 /one:setting 里是关闭，复制后照样关闭，派工不会用它。",
    ]);
    expect(text).not.toContain("AGENTS.md");
  });

  test("特殊情况的几行用警示色，份数行不用", async () => {
    await setup({ trusted: true });
    await seed("golang", join(repoDir, ".pi"), { skills: ["version-policy"], agents: [] });
    await appendTo(join(repoDir, ".pi", "skills", "version-policy", "SKILL.md"));
    await seed("golang", agentDir, { skills: [], agents: ["go-worker.md"] });
    await saveDisabledAgentsSetting(userSettingsPath(agentDir), ["go-reviewer"]);
    const rows = (await confirmText([GOLANG, PROJECT_LAYER], { theme: tagTheme })).split("\n");
    const row = (part: string) => rows.find((line) => line.includes(part))!;
    expect(row("复制 11 份到")).not.toContain("<warning>");
    expect(row("你改过的 1 份")).toContain("<warning>");
    expect(row("会替换你在用户层的同名定义")).toContain("<warning>");
    expect(row("在 /one:setting 里是关闭")).toContain("<warning>");
  });

  test("复制到用户层、项目受信任、项目层已有 go-worker：出现项目层那份生效的一行", async () => {
    await setup({ trusted: true });
    await seed("golang", join(repoDir, ".pi"), { skills: [], agents: ["go-worker.md"] });
    const text = await confirmText([GOLANG, USER_LAYER], { theme: tagTheme });
    const plain = text.replace(/<\/?[a-zA-Z]+>/gu, "");
    expect(confirmBody(plain)).toEqual([
      `复制 12 份到 ${userDir()}：10 份 skill、2 份角色定义。`,
      "",
      "项目层已有 go-worker，在这个项目里用的是项目层那份，用户层这份不生效。",
    ]);
    expect(text.split("\n").find((line) => line.includes("项目层已有 go-worker"))).toContain("<warning>");
  });

  test("全部和样例一样或被改过：第一行写没有要复制的，一样的份数、被改过的路径照写", async () => {
    await setup();
    await seed("golang", agentDir);
    await appendTo(join(agentDir, "skills", "version-policy", "SKILL.md"));
    const text = await confirmText([GOLANG, USER_LAYER]);
    expect(confirmBody(text)).toEqual([
      "这一层没有要复制的。",
      "已经有、和样例一样的 11 份，跳过。",
      "",
      "你改过的 1 份保留你的版本，不覆盖：skills/version-policy",
    ]);
  });

  test("只缺一份 skill：第一行只有 skill 那一半，没有顿号", async () => {
    await setup();
    await seed("golang", agentDir);
    await rm(join(agentDir, "skills", "api-design"), { recursive: true });
    const text = await confirmText([GOLANG, USER_LAYER]);
    expect(confirmBody(text)).toEqual([`复制 1 份到 ${userDir()}：1 份 skill。`, "已经有、和样例一样的 11 份，跳过。"]);
  });

  test("只缺一份角色定义：第一行只有角色定义那一半", async () => {
    await setup();
    await seed("golang", agentDir);
    await rm(join(agentDir, "agents", "go-reviewer.md"));
    const text = await confirmText([GOLANG, USER_LAYER]);
    expect(confirmBody(text)).toEqual([`复制 1 份到 ${userDir()}：1 份角色定义。`, "已经有、和样例一样的 11 份，跳过。"]);
  });

  test("替换内置定义时正文不写说明，也没有开关那一行", async () => {
    await setup();
    const text = await confirmText([GOLANG, USER_LAYER]);
    expect(text).not.toContain("复制后替换同名");
    expect(text).not.toContain("开关按定义名记");
    expect(text).not.toContain("现在是开启");
  });
});

describe("选样例窗口说明", () => {
  test("说明一字不差，不提 AGENTS.md", async () => {
    await setup();
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("选中后再选复制到哪一层；skills 和角色定义一起复制。");
    expect(screens[0]).not.toContain("AGENTS.md");
  });
});


describe("取消", () => {
  test.each([
    ["窗口一 Esc", [CANCEL]],
    ["窗口二 Esc", [GOLANG, CANCEL]],
    ["窗口三 Esc", [GOLANG, USER_LAYER, CANCEL]],
    ["窗口三选不复制", [GOLANG, USER_LAYER, SKIP_COPY]],
  ] as const)("%s：不写任何文件并提示已取消", async (_name, steps) => {
    await setup();
    const result = await run([...steps]);
    expect(result.last()).toBe("已取消，没有复制任何文件");
    expect(exists(join(agentDir, "skills"))).toBe(false);
    expect(exists(join(agentDir, "agents"))).toBe(false);
    expect(exists(trustPath())).toBe(false);
  });

  test.each([
    ["项目层窗口三 Esc", [GOLANG, PROJECT_LAYER, CANCEL]],
    ["项目层窗口三选不复制", [GOLANG, PROJECT_LAYER, SKIP_COPY]],
  ] as const)("授信记录为空，%s：不写授信记录、不复制", async (_name, steps) => {
    await setup();
    const result = await run([...steps]);
    expect(result.last()).toBe("已取消，没有复制任何文件");
    expect(exists(trustPath())).toBe(false);
    expect(exists(join(repoDir, ".pi"))).toBe(false);
  });
});

describe("vue 样例的分类", () => {
  test("复制全套后改动、删除一部分再运行：确认窗口只列份数、跳过数和被改路径，结果提示列出被改文件", async () => {
    await setup();
    await run([VUE, USER_LAYER, COPY]);
    const constraints = join(agentDir, "skills", "vue-constraints", "SKILL.md");
    const worker = join(agentDir, "agents", "vue-worker.md");
    await appendTo(constraints);
    await appendTo(worker);
    await rm(join(agentDir, "skills", "frontend-constraints"), { recursive: true });
    await rm(join(agentDir, "agents", "vue-reviewer.md"));
    const changed = { constraints: await readFile(constraints, "utf8"), worker: await readFile(worker, "utf8") };

    const screens: string[] = [];
    const result = await run([VUE, USER_LAYER, capture(screens, COPY)]);
    expect(confirmBody(screens[0]!)).toEqual([
      `复制 2 份到 ${userDir()}：1 份 skill、1 份角色定义。`,
      "已经有、和样例一样的 1 份，跳过。",
      "",
      "你改过的 2 份保留你的版本，不覆盖：skills/vue-constraints、agents/vue-worker.md",
    ]);
    expect(await readFile(constraints, "utf8")).toBe(changed.constraints);
    expect(await readFile(worker, "utf8")).toBe(changed.worker);
    expect(exists(join(agentDir, "skills", "frontend-constraints", "SKILL.md"))).toBe(true);
    expect(exists(join(agentDir, "agents", "vue-reviewer.md"))).toBe(true);
    expect(result.notifications).toHaveLength(1);
    const lines = result.last().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("✓ Vue 前端样例已复制到用户层：新复制 2 个文件。");
    expect(lines[1]!.trim()).toBe(`被改过、没有覆盖：${constraints}、${worker}。`);
  });
});


describe("项目层已有同名定义", () => {
  async function runVueToUser() {
    const screens: string[] = [];
    await run([VUE, USER_LAYER, capture(screens, CANCEL)]);
    return screens[0]!;
  }

  test("项目受信任：每个项目层已有的新复制定义提示项目层那份生效", async () => {
    await setup({ trusted: true });
    await mkdir(join(repoDir, ".pi", "agents"), { recursive: true });
    await cp(join(EXAMPLES, "vue", "agents", "vue-reviewer.md"), join(repoDir, ".pi", "agents", "vue-reviewer.md"));
    expect(await runVueToUser()).toContain("项目层已有 vue-reviewer，在这个项目里用的是项目层那份，用户层这份不生效。");
  });

  test("授信记录为空、复制到用户层：项目层还没生效，不出现这一行", async () => {
    await setup();
    await mkdir(join(repoDir, ".pi", "agents"), { recursive: true });
    await cp(join(EXAMPLES, "vue", "agents", "vue-reviewer.md"), join(repoDir, ".pi", "agents", "vue-reviewer.md"));
    expect(await runVueToUser()).not.toContain("项目层已有");
  });

  test("你在 pi 里选过不信任：同样的布局不出现这一行", async () => {
    await setup({ trusted: false });
    await mkdir(join(repoDir, ".pi", "agents"), { recursive: true });
    await cp(join(EXAMPLES, "vue", "agents", "vue-reviewer.md"), join(repoDir, ".pi", "agents", "vue-reviewer.md"));
    expect(await runVueToUser()).not.toContain("项目层已有");
  });
});

describe("审查补充", () => {
  test("只缺一个定义：结果提示以新复制个数结尾，被改过的那行以句号结尾", async () => {
    await setup();
    await run([VUE, USER_LAYER, COPY]);
    await writeFile(join(agentDir, "agents", "vue-worker.md"), "改过\n");
    await rm(join(agentDir, "agents", "vue-reviewer.md"));
    const { last } = await run([VUE, USER_LAYER, COPY]);
    expect(last().split("\n")[0]).toBe("✓ Vue 前端样例已复制到用户层：新复制 1 个文件。");
    expect(last()).toMatch(/被改过、没有覆盖：.*vue-worker\.md。$/mu);
  });

  test("确认窗口开着时别处建了同名定义：复制停下，原因用大白话写，不覆盖", async () => {
    await setup();
    const { last } = await run([GOLANG, USER_LAYER, (screen) => {
      execFileSync("mkdir", ["-p", join(agentDir, "agents")]);
      writeFileSync(join(agentDir, "agents", "go-worker.md"), "别处刚写的\n");
      COPY(screen);
    }]);
    expect(last()).toContain("✗ 复制没有完成：目标位置已有别处写的同名文件");
    expect(last()).not.toContain("EEXIST");
    expect(await readFile(join(agentDir, "agents", "go-worker.md"), "utf8")).toBe("别处刚写的\n");
  });
});


describe("选层窗口", () => {
  test("项目受信任、用户层已全部复制：用户层变暗写已全部复制，光标停在项目层", async () => {
    await setup({ trusted: true });
    await copyGolangToUser();
    const layer: string[] = [];
    await run([GOLANG, capture(layer, CANCEL)]);
    expect(layer[0]).toMatch(/用户层.*已全部复制，和样例一致/u);
    expect(layer[0]).toMatch(/→ 项目层/u);
  });
});

describe("授信记录为空时复制到项目层", () => {
  test("确认复制：授信记录写 true，文件复制，完成提示末尾加已设为受信任", async () => {
    await setup();
    const result = await run([GOLANG, PROJECT_LAYER, COPY]);
    expect(await readTrust()).toEqual({ [await realpath(repoDir)]: true });
    expect(exists(join(repoDir, ".pi", "skills", "api-design", "SKILL.md"))).toBe(true);
    expect(result.notifications).toHaveLength(1);
    expect(result.last()).toContain("✓ Go 后端样例已复制到项目层：新复制 12 个文件。");
    expect(result.last()).toMatch(/· 已把本项目设为受信任$/u);
  });

  test("授信记录已是信任：完成提示不加已设为受信任", async () => {
    await setup({ trusted: true });
    const result = await run([GOLANG, PROJECT_LAYER, COPY]);
    expect(result.last()).not.toContain("已把本项目设为受信任");
  });

  test("授信记录为空时复制到用户层：不写授信记录，提示不加已设为受信任", async () => {
    await setup();
    const result = await run([GOLANG, USER_LAYER, COPY]);
    expect(exists(trustPath())).toBe(false);
    expect(result.last()).not.toContain("已把本项目设为受信任");
  });

  test("授信记录里有别的项目：保留别的项目的记录", async () => {
    await setup();
    await writeFile(trustPath(), JSON.stringify({ "/some/other/project": false }));
    await run([GOLANG, PROJECT_LAYER, COPY]);
    expect(await readTrust()).toEqual({ "/some/other/project": false, [await realpath(repoDir)]: true });
  });

  test.skipIf(process.getuid?.() === 0)("文件复制阶段失败：沿用复制失败提示，授信记录已写入不回滚", async () => {
    await setup();
    await mkdir(join(repoDir, ".pi", "skills"), { recursive: true });
    chmodSync(join(repoDir, ".pi", "skills"), 0o555);
    try {
      const result = await run([GOLANG, PROJECT_LAYER, COPY]);
      expect(result.last().split("\n")[0]).toMatch(/^✗ 复制没有完成：没有权限写入 /u);
      expect(result.notifications[0]!.level).toBe("error");
      expect(await readTrust()).toEqual({ [await realpath(repoDir)]: true });
    } finally {
      chmodSync(join(repoDir, ".pi", "skills"), 0o755);
    }
  });
});

describe("授信记录已写入后复制失败", () => {
  test.skipIf(process.getuid?.() === 0).each([["空：复制失败提示末尾另起一行带已把本项目设为受信任", undefined, true], ["信任：复制失败提示不带已把本项目设为受信任", true, false]] as const)("授信记录原为%s", async (_name, initial, hasLine) => {
    await setup(initial === undefined ? {} : { trusted: initial });
    await mkdir(join(repoDir, ".pi", "skills"), { recursive: true });
    chmodSync(join(repoDir, ".pi", "skills"), 0o555);
    try {
      const result = await run([GOLANG, PROJECT_LAYER, COPY]);
      expect(result.last()).toMatch(/^✗ 复制没有完成：/u);
      if (hasLine) expect(result.last()).toMatch(/\n {2}· 已把本项目设为受信任$/u);
      else expect(result.last()).not.toContain("已把本项目设为受信任");
      expect(await readTrust()).toEqual({ [await realpath(repoDir)]: true });
    } finally {
      chmodSync(join(repoDir, ".pi", "skills"), 0o755);
    }
  });
});

describe("确认复制那一刻重新读授信记录", () => {
  test.each([["空", undefined], ["信任", true]] as const)("授信记录原为%s，确认窗口开着时被改成不信任：不写授信记录、不复制，提示去 /trust", async (_name, initial) => {
    await setup(initial === undefined ? {} : { trusted: initial });
    const result = await run([GOLANG, PROJECT_LAYER, (screen) => { setTrustSync(false); COPY(screen); }]);
    expect(result.last()).toBe("✗ 复制没有完成：你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust");
    expect(result.notifications[0]!.level).toBe("error");
    expect(await readTrust()).toEqual({ [await realpath(repoDir)]: false });
    expect(exists(join(repoDir, ".pi"))).toBe(false);
  });
});

describe("写授信记录失败", () => {
  test.skipIf(process.getuid?.() === 0)("确认窗口开着时代理目录变成不可写：不复制任何文件，error 提示带原因第一行和 trust.json 路径", async () => {
    await setup();
    try {
      const result = await run([GOLANG, PROJECT_LAYER, (screen) => { chmodSync(agentDir, 0o555); COPY(screen); }]);
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]!.level).toBe("error");
      const message = result.last();
      expect(message.startsWith("✗ 复制没有完成：")).toBe(true);
      expect(message.split("\n")).toHaveLength(1);
      expect(message).toContain("trust.json");
      expect(exists(join(repoDir, ".pi"))).toBe(false);
      expect(exists(trustPath())).toBe(false);
    } finally {
      chmodSync(agentDir, 0o755);
    }
  });
});
