import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function run(steps: Step[]) {
  const queue = [...steps];
  const screens: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const ui = {
    custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender() {} }, theme, undefined, resolve) as { render(width: number): string[]; handleInput(data: string): void };
        const step = queue.shift();
        if (!step) throw new Error("脚本步骤用完了");
        const text = component.render(200).map((line) => line.trimEnd()).join("\n");
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
const COPY = pick(ENTER), SKIP_COPY = pick(DOWN, ENTER), WRITE = pick(ENTER), NOT_WRITE = pick(DOWN, ENTER), CANCEL = pick(ESC);
const capture = (store: string[], then: Step): Step => (screen) => { store.push(screen.text); then(screen); };

const sample = (name: string, ...parts: string[]) => readFile(join(EXAMPLES, name, ...parts), "utf8");
const exists = (path: string) => existsSync(path);

async function copyGolangToUser() {
  await run([GOLANG, USER_LAYER, COPY, WRITE]);
}

describe("空代理目录、授信记录为空", () => {
  test("窗口一项目层写实际复制状态，窗口二项目层可选并写明选它会设为受信任", async () => {
    await setup();
    const screens: string[] = [];
    await run([capture(screens, GOLANG), capture(screens, CANCEL)]);
    expect(screens[0]).toContain("要用哪套设计规范样例？");
    expect(screens[0]).toContain("选中后再选复制到哪一层；skills、角色定义和 AGENTS.md 那一段一起复制。");
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
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    await rm(trustPath());
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：未复制 · 项目层：已复制");
  });

  test("项目层已全部复制：窗口二项目层灰掉写已全部复制，和样例一致", async () => {
    await setup({ trusted: true });
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
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
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
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
    await run([GOLANG, USER_LAYER, COPY, WRITE]);
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    await rm(trustPath());
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层和项目层都已全部复制，和样例一致。");
  });

  test("授信记录为不信任、项目层已全部复制：仍提前结束，提示保持原文字", async () => {
    await setup({ trusted: true });
    await run([GOLANG, USER_LAYER, COPY, WRITE]);
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    await setTrust(false);
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。");
  });
});

describe("golang 复制到用户层", () => {
  test("复制并写入：10 个 skill、2 个定义、AGENTS.md 全文，确认窗口与结果提示按规则写", async () => {
    await setup();
    const screens: string[] = [];
    const result = await run([GOLANG, USER_LAYER, capture(screens, COPY), capture(screens, WRITE)]);
    expect(screens[0]).toContain("把 Go 后端样例复制到用户层？");
    expect(screens[0]).toContain(`skills → ${join(agentDir, "skills")}/`);
    expect(screens[0]).toContain("新复制 10：");
    expect(screens[0]).toContain(`角色定义 → ${join(agentDir, "agents")}/`);
    expect(screens[0]).toContain("新复制 2：go-worker、go-reviewer");
    expect(screens[0]).toContain("复制后替换同名的内置定义。开关按定义名记，go-worker、go-reviewer 现在都是开启。");
    expect(screens[0]).toContain(`AGENTS.md → ${join(agentDir, "AGENTS.md")}`);
    expect(screens[0]).toContain("还没有 AGENTS.md，新建一份，下一步给你看全文再写");
    expect(screens[0]).toContain("复制");
    expect(screens[0]).toContain("不复制");

    expect((await readdir(join(agentDir, "skills"))).sort()).toHaveLength(10);
    for (const name of await readdir(join(EXAMPLES, "golang", "skills"))) {
      expect(await readFile(join(agentDir, "skills", name, "SKILL.md"), "utf8")).toBe(await sample("golang", "skills", name, "SKILL.md"));
    }
    expect((await readdir(join(agentDir, "agents"))).sort()).toEqual(["go-reviewer.md", "go-worker.md"]);
    expect(await readFile(join(agentDir, "AGENTS.md"), "utf8")).toBe(await sample("golang", "AGENTS.md"));

    const dialog = screens[1]!;
    const title = dialog.split("\n").find((line) => line.includes("把这些改动写入用户规范 "))!;
    expect(title.trim()).toMatch(/^把这些改动写入用户规范 .*AGENTS\.md？$/u);
    expect(dialog).toContain("还没有 AGENTS.md，要写入的全文如下：");
    expect(dialog).toContain("+ ## 后端设计约定");
    expect(dialog).toContain("写入后，此后派出的 PM、worker、reviewer 都按新内容工作。");
    expect(dialog).toMatch(/^\s*(→ )?写入/mu);
    expect(dialog).toContain("不写入");
    expect(dialog).not.toContain("其他");

    expect(result.notifications).toHaveLength(1);
    expect(result.last()).toContain("✓ Go 后端样例已复制到用户层：新复制 12 个文件，AGENTS.md 已写入「## 后端设计约定」。");
    expect(result.last()).toContain("此后派出的代理按新规范工作。");
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
    await run([GOLANG, USER_LAYER, COPY, WRITE]);
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    const result = await run([GOLANG]);
    expect(result.last()).toBe("Go 后端样例在用户层和项目层都已全部复制，和样例一致。");
  });

  test("用户层已有 AGENTS.md：确认窗口写追加，窗口四对比改动，写入后是原内容加空行加样例全文", async () => {
    await setup();
    await writeFile(join(agentDir, "AGENTS.md"), "个人规范一\n个人规范二\n");
    const screens: string[] = [];
    await run([GOLANG, USER_LAYER, capture(screens, COPY), capture(screens, WRITE)]);
    expect(screens[0]).toContain("追加「## 后端设计约定」一段，下一步给你看差异再写");
    expect(screens[1]).toContain("与现有的 AGENTS.md 相比的改动：");
    expect(screens[1]).toContain("+ ## 后端设计约定");
    expect(await readFile(join(agentDir, "AGENTS.md"), "utf8")).toBe(`个人规范一\n个人规范二\n\n${await sample("golang", "AGENTS.md")}`);
  });

  test.each([["选不写入", [DOWN, ENTER]], ["按 Esc", [ESC]]] as const)("窗口四%s：文件已复制，AGENTS.md 不创建，补写提示，再运行显示部分复制", async (_name, sequence) => {
    await setup();
    const result = await run([GOLANG, USER_LAYER, COPY, pick(...sequence)]);
    expect(await readdir(join(agentDir, "skills"))).toHaveLength(10);
    expect(exists(join(agentDir, "AGENTS.md"))).toBe(false);
    expect(result.last()).toContain("AGENTS.md 没有写入；想补上就再运行 /one:examples。");
    const screens: string[] = [];
    await run([capture(screens, CANCEL)]);
    expect(screens[0]).toContain("Go 后端 · 用户层：部分复制");
  });

  test("窗口四渲染后、回车前 AGENTS.md 被别处改动：保持被改后的内容并提示", async () => {
    await setup();
    const agentsPath = join(agentDir, "AGENTS.md");
    const result = await run([GOLANG, USER_LAYER, COPY, ({ keys }) => { writeFileSync(agentsPath, "别处写的\n"); keys(ENTER); }]);
    expect(await readFile(agentsPath, "utf8")).toBe("别处写的\n");
    expect(result.last()).toContain(`确认期间 ${agentsPath} 被别处改动，这次没有写入`);
  });

  test("用户层 skills 目录没有写权限：提示没有权限写入，已复制文件保留，AGENTS.md 没有动", async () => {
    if (process.getuid?.() === 0) return;
    await setup();
    await mkdir(join(agentDir, "skills"), { recursive: true });
    chmodSync(join(agentDir, "skills"), 0o555);
    const result = await run([GOLANG, USER_LAYER, COPY]);
    const lines = result.last().split("\n");
    expect(lines[0]).toMatch(/^✗ 复制没有完成：没有权限写入 /u);
    expect(lines[0]).toContain(`${join(agentDir, "skills")}/`);
    expect(result.last()).toContain("AGENTS.md 没有动");
    expect(result.last()).toContain("解决后再运行 /one:examples 会接着补。");
    expect(exists(join(agentDir, "AGENTS.md"))).toBe(false);
  });
});

describe("AGENTS.md 软链接和 CRLF", () => {
  test("用户层 AGENTS.md 是软链接：选写入后软链接保留，真实文件里追加了样例那一段", async () => {
    await setup();
    const real = join(root, "elsewhere.md");
    const link = join(agentDir, "AGENTS.md");
    await writeFile(real, "个人规范一\n");
    await symlink(real, link);
    await run([GOLANG, USER_LAYER, COPY, WRITE]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, "utf8")).toBe(`个人规范一\n\n${await sample("golang", "AGENTS.md")}`);
  });

  test("用户层 AGENTS.md 是软链接：差异窗口在说明行上方写出真实路径", async () => {
    await setup();
    const real = join(root, "elsewhere.md");
    await writeFile(real, "个人规范一\n");
    await symlink(real, join(agentDir, "AGENTS.md"));
    const screens: string[] = [];
    await run([GOLANG, USER_LAYER, COPY, capture(screens, WRITE)]);
    const note = `AGENTS.md 是软链接，实际写到 ${await realpath(real)}`;
    expect(screens[0]).toContain(note);
    expect(screens[0]!.indexOf(note)).toBeLessThan(screens[0]!.indexOf("与现有的 AGENTS.md 相比的改动："));
  });

  test("用户层 AGENTS.md 是普通文件：差异窗口没有软链接说明行", async () => {
    await setup();
    await writeFile(join(agentDir, "AGENTS.md"), "个人规范一\n");
    const screens: string[] = [];
    await run([GOLANG, USER_LAYER, COPY, capture(screens, WRITE)]);
    expect(screens[0]).toContain("与现有的 AGENTS.md 相比的改动：");
    expect(screens[0]).not.toContain("AGENTS.md 是软链接");
  });

  test("用户层 AGENTS.md 是 CRLF：差异窗口没有 \\r，写入后没有单独的 \\n，再运行窗口一显示已复制", async () => {
    await setup();
    const agentsPath = join(agentDir, "AGENTS.md");
    await writeFile(agentsPath, "个人规范一\r\n个人规范二\r\n");
    const screens: string[] = [];
    await run([GOLANG, USER_LAYER, COPY, capture(screens, WRITE)]);
    expect(screens[0]).not.toContain("\r");
    expect(await readFile(agentsPath, "utf8")).not.toMatch(/(?<!\r)\n/u);
    const after: string[] = [];
    await run([capture(after, CANCEL)]);
    expect(after[0]).toContain("Go 后端 · 用户层：已复制");
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
    expect(exists(join(agentDir, "AGENTS.md"))).toBe(false);
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
  test("复制全套后改动、删除一部分再运行：分类写清，不弹窗口四，改过的文件不变，结果提示列出被改文件", async () => {
    await setup();
    await run([VUE, USER_LAYER, COPY, WRITE]);
    const constraints = join(agentDir, "skills", "vue-constraints", "SKILL.md");
    const worker = join(agentDir, "agents", "vue-worker.md");
    await writeFile(constraints, `${await readFile(constraints, "utf8")}\n改过\n`);
    await writeFile(worker, `${await readFile(worker, "utf8")}\n改过\n`);
    await rm(join(agentDir, "skills", "frontend-constraints"), { recursive: true });
    await rm(join(agentDir, "agents", "vue-reviewer.md"));
    const agentsPath = join(agentDir, "AGENTS.md");
    const lines = (await readFile(agentsPath, "utf8")).split("\n");
    lines[2] = `${lines[2]}改过`;
    await writeFile(agentsPath, lines.join("\n"));
    const changed = { constraints: await readFile(constraints, "utf8"), worker: await readFile(worker, "utf8"), agents: lines.join("\n") };

    const screens: string[] = [];
    const result = await run([VUE, USER_LAYER, capture(screens, COPY)]);
    const dialog = screens[0]!;
    expect(dialog).toContain("新复制 1：frontend-constraints");
    expect(dialog).toContain("已一致 1：version-policy");
    expect(dialog).toContain("被改过，跳过 1：vue-constraints");
    expect(dialog).toContain("新复制 1：vue-reviewer");
    expect(dialog).toContain("被改过，跳过 1：vue-worker");
    expect(dialog).toContain("已有「## 前端设计约定」一段，和样例不一样，不动");
    expect(await readFile(constraints, "utf8")).toBe(changed.constraints);
    expect(await readFile(worker, "utf8")).toBe(changed.worker);
    expect(await readFile(agentsPath, "utf8")).toBe(changed.agents);
    expect(result.notifications).toHaveLength(1);
    expect(result.last()).toContain(constraints);
    expect(result.last()).toContain(worker);
    expect(result.last()).toContain("被改过、没有覆盖：");
    expect(result.last()).toContain("AGENTS.md 的「## 前端设计约定」一段也没动");
    expect(result.last()).not.toContain("此后派出的代理按新规范工作。");
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

describe("复制到项目层", () => {
  async function seedUserAgents() {
    await mkdir(join(agentDir, "agents"), { recursive: true });
    for (const name of ["go-worker.md", "go-reviewer.md"]) await cp(join(EXAMPLES, "golang", "agents", name), join(agentDir, "agents", name));
  }

  test("用户层已有同名定义：写替换用户层定义，开关全开", async () => {
    await setup({ trusted: true });
    await seedUserAgents();
    const screens: string[] = [];
    await run([GOLANG, PROJECT_LAYER, capture(screens, CANCEL)]);
    expect(screens[0]).toContain("把 Go 后端样例复制到项目层？");
    expect(screens[0]).toContain(`skills → ${join(repoDir, ".pi", "skills")}/`);
    expect(screens[0]).toContain("复制后替换同名的用户层定义。开关按定义名记，go-worker、go-reviewer 现在都是开启。");
  });

  test("用户设置关掉 go-worker：开关写 go-worker 现在是关闭，go-reviewer 是开启", async () => {
    await setup({ trusted: true });
    await seedUserAgents();
    await saveDisabledAgentsSetting(userSettingsPath(agentDir), ["go-worker"]);
    const screens: string[] = [];
    await run([GOLANG, PROJECT_LAYER, capture(screens, CANCEL)]);
    expect(screens[0]).toContain("go-worker 现在是关闭，go-reviewer 是开启");
  });

  test("项目层复制并写入：窗口四标题写项目规范，AGENTS.md 写在仓库根", async () => {
    await setup({ trusted: true });
    const screens: string[] = [];
    const result = await run([GOLANG, PROJECT_LAYER, COPY, capture(screens, WRITE)]);
    expect(screens[0]).toContain("把这些改动写入项目规范 AGENTS.md？");
    expect(await readFile(join(await realpath(repoDir), "AGENTS.md"), "utf8")).toBe(await sample("golang", "AGENTS.md"));
    expect(exists(join(repoDir, ".pi", "skills", "api-design", "SKILL.md"))).toBe(true);
    expect(result.last()).toContain("✓ Go 后端样例已复制到项目层：新复制 12 个文件，AGENTS.md 已写入「## 后端设计约定」。");
  });

  test("合并后超过 16 KB：确认窗口写超限，不弹窗口四，AGENTS.md 不变，提示精简后补写", async () => {
    await setup({ trusted: true });
    const original = `${"x".repeat(12185)}\n`;
    await writeFile(join(repoDir, "AGENTS.md"), original);
    const screens: string[] = [];
    const result = await run([GOLANG, PROJECT_LAYER, capture(screens, COPY)]);
    expect(screens[0]).toContain("合并后 17024 字节，超过 16 KB 上限 640 字节，这次不写。");
    expect(screens[0]).toContain("精简 AGENTS.md 后再运行 /one:examples，会只补写这一段。");
    expect(await readFile(join(repoDir, "AGENTS.md"), "utf8")).toBe(original);
    expect(result.last()).toContain("AGENTS.md 合并后超过 16 KB 上限，没有写入");
  });
});

describe("审查补充", () => {
  test("只有一个定义要新复制：开关写「现在是开启」，被改过的那行以句号结尾", async () => {
    await setup();
    await run([VUE, USER_LAYER, COPY, WRITE]);
    await writeFile(join(agentDir, "agents", "vue-worker.md"), "改过\n");
    await rm(join(agentDir, "agents", "vue-reviewer.md"));
    const confirm: string[] = [];
    const { last } = await run([VUE, USER_LAYER, capture(confirm, COPY)]);
    expect(confirm[0]).toContain("开关按定义名记，vue-reviewer 现在是开启。");
    expect(confirm[0]).not.toContain("现在都是");
    expect(last()).toMatch(/被改过、没有覆盖：.*vue-worker\.md。$/mu);
  });

  test("选层窗口开着时别处写进了一致的那一段：确认窗口写不动，不弹差异窗口，那一段只有一份", async () => {
    await setup();
    const text = await sample("golang", "AGENTS.md");
    const confirm: string[] = [];
    await run([GOLANG, (screen) => { writeFileSync(join(agentDir, "AGENTS.md"), text); USER_LAYER(screen); }, capture(confirm, COPY)]);
    expect(confirm[0]).toContain("已有「## 后端设计约定」一段，和样例一致，不动");
    const after = await readFile(join(agentDir, "AGENTS.md"), "utf8");
    expect(after.split("## 后端设计约定").length - 1).toBe(1);
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

  test("确认窗口三块之间没有空行", async () => {
    await setup();
    const confirm: string[] = [];
    await run([GOLANG, USER_LAYER, capture(confirm, SKIP_COPY)]);
    const lines = confirm[0]!.split("\n");
    const start = lines.findIndex((line) => line.includes("skills →")), end = lines.findIndex((line) => line.includes("AGENTS.md →"));
    expect(lines.slice(start, end + 2).some((line) => line.trim() === "")).toBe(false);
  });
});

describe("复制完成后写 AGENTS.md 出错", () => {
  test.skipIf(process.getuid?.() === 0)("代理目录没有写权限：不抛错，结果提示写明 AGENTS.md 没有写入和补写办法", async () => {
    await setup();
    try {
      const { last } = await run([GOLANG, USER_LAYER, COPY, (screen) => { chmodSync(agentDir, 0o555); WRITE(screen); }]);
      const lines = last().split("\n");
      expect(lines[0]).toBe("✓ Go 后端样例已复制到用户层：新复制 12 个文件。");
      expect(last()).toContain("AGENTS.md 没有写入：没有权限写入 ");
      expect(last()).toContain("；解决后再运行 /one:examples 补写。");
      expect(last()).not.toContain("此后派出的代理按新规范工作");
    } finally {
      chmodSync(agentDir, 0o755);
    }
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

describe("软链接指向的目录不可写", () => {
  test.skipIf(process.getuid?.() === 0)("写 AGENTS.md 失败时，原因写真实文件所在的目录", async () => {
    await setup();
    const realDir = join(root, "dotfiles");
    await mkdir(realDir);
    await writeFile(join(realDir, "AGENTS.md"), "个人规范一\n");
    await symlink(join(realDir, "AGENTS.md"), join(agentDir, "AGENTS.md"));
    chmodSync(realDir, 0o555);
    try {
      const { last } = await run([GOLANG, USER_LAYER, COPY, WRITE]);
      expect(last()).toContain(`AGENTS.md 没有写入：没有权限写入 ${await realpath(realDir)}/`);
    } finally {
      chmodSync(realDir, 0o755);
    }
  });
});

describe("授信记录为空时复制到项目层", () => {
  test("确认复制：授信记录写 true，文件复制，完成提示末尾加已设为受信任", async () => {
    await setup();
    const result = await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    expect(await readTrust()).toEqual({ [await realpath(repoDir)]: true });
    expect(exists(join(repoDir, ".pi", "skills", "api-design", "SKILL.md"))).toBe(true);
    expect(await readFile(join(await realpath(repoDir), "AGENTS.md"), "utf8")).toBe(await sample("golang", "AGENTS.md"));
    expect(result.notifications).toHaveLength(1);
    expect(result.last()).toContain("✓ Go 后端样例已复制到项目层：新复制 12 个文件");
    expect(result.last()).toMatch(/· 已把本项目设为受信任$/u);
  });

  test("授信记录已是信任：完成提示不加已设为受信任", async () => {
    await setup({ trusted: true });
    const result = await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    expect(result.last()).not.toContain("已把本项目设为受信任");
  });

  test("授信记录为空时复制到用户层：不写授信记录，提示不加已设为受信任", async () => {
    await setup();
    const result = await run([GOLANG, USER_LAYER, COPY, WRITE]);
    expect(exists(trustPath())).toBe(false);
    expect(result.last()).not.toContain("已把本项目设为受信任");
  });

  test("授信记录里有别的项目：保留别的项目的记录", async () => {
    await setup();
    await writeFile(trustPath(), JSON.stringify({ "/some/other/project": false }));
    await run([GOLANG, PROJECT_LAYER, COPY, WRITE]);
    expect(await readTrust()).toEqual({ "/some/other/project": false, [await realpath(repoDir)]: true });
  });

  test.skipIf(process.getuid?.() === 0)("文件复制阶段失败：沿用复制失败提示，授信记录已写入不回滚", async () => {
    await setup();
    await mkdir(join(repoDir, ".pi", "skills"), { recursive: true });
    chmodSync(join(repoDir, ".pi", "skills"), 0o555);
    try {
      const result = await run([GOLANG, PROJECT_LAYER, COPY]);
      expect(result.last().split("\n")[0]).toMatch(/^✗ 复制没有完成：没有权限写入 /u);
      expect(result.last()).toContain("AGENTS.md 没有动");
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
    expect(exists(join(repoDir, "AGENTS.md"))).toBe(false);
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
      expect(exists(join(repoDir, "AGENTS.md"))).toBe(false);
      expect(exists(trustPath())).toBe(false);
    } finally {
      chmodSync(agentDir, 0o755);
    }
  });
});
