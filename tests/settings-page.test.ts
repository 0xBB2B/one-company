import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsComponent, createSettingsSession } from "../runtime/settings-ui.ts";
import { openSettingsPage } from "../extensions/settings.ts";
import { pressKeys, renderComponent } from "./helpers/virtual-terminal.ts";

const ROLE_ORDER = ["worker", "planner", "reviewer", "acceptance", "requirement-agent"];
const MODEL_A = { provider: "acme", id: "model-a", thinkingLevels: ["off", "low", "medium", "high"] };
const SESSION_MODEL = "acme/model-a";
const SESSION_THINKING = "medium";
const HINT_TEXT = "←→ 角色 · ↑↓ 字段 · Tab 范围 · Enter 修改 · Esc 关闭";

const KEY = {
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  space: " ",
};

function makeInput(opts: {
  roles?: string[];
  global?: Record<string, unknown>;
  project?: Record<string, unknown> | null;
  detected?: string[];
  save?: (scope: string, role: string, field: string, value: unknown) => Promise<void>;
} = {}) {
  const roles = opts.roles ?? ROLE_ORDER;
  return {
    catalog: { roles: roles.map((name) => ({ name, source: "default", path: `/fake/${name}.md`, available: true })) },
    settings: {
      global: { roles: opts.global ?? {} },
      project: opts.project === null ? null : { roles: opts.project ?? {} },
    },
    scope: "global" as const,
    models: { available: [MODEL_A], sessionModel: SESSION_MODEL, sessionThinking: SESSION_THINKING },
    mcp: { detected: opts.detected ?? [] },
    save: opts.save ?? (async () => {}),
  };
}

function contentLines(lines: string[]): string[] {
  return lines.slice(1, -1);
}

describe("100×40 主页布局", () => {
  test("首末行为全宽蓝线，内容依次为标题/范围/空行/角色/空行/模型标题/模型值/空行/思考标题/思考值/空行/MCP标题/MCP值/空行/提示", async () => {
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session);
    const lines = await renderComponent(component, 100, 40);

    expect(lines[0]).toMatch(/^\S{100}$/);
    expect(lines[lines.length - 1]).toMatch(/^\S{100}$/);

    const content = contentLines(lines);
    expect(content.length).toBe(15);
    expect(content[0]!.length).toBeGreaterThan(0);
    expect(content[1]).toContain("全局");
    expect(content[1]).toContain("项目");
    expect(content[2]).toBe("");
    expect(content[3]).toContain(ROLE_ORDER[0]);
    expect(content[3]).toContain("requirement-agent");
    expect(content[4]).toBe("");
    expect(content[5]).toBe("模型 - 默认");
    expect(content[6]).toBe("  沿用主会话");
    expect(content[7]).toBe("");
    expect(content[8]).toBe("思考 - 默认");
    expect(content[9]).toBe("  使用上级/角色默认");
    expect(content[10]).toBe("");
    expect(content[11]).toBe("MCP - 默认");
    expect(content[12]).toBe("  无");
    expect(content[13]).toBe("");
    expect(content[14]).toBe(HINT_TEXT);
  });

  test("内容区各行宽度不超过 72 列上限", async () => {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7", "chrome-devtools"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const component = createSettingsComponent(session);
    const lines = await renderComponent(component, 100, 40);
    for (const line of contentLines(lines)) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });
});

describe("60×12 窄屏压缩布局", () => {
  test("蓝线仍为 60 列，无行超过 60 列，提示文字仍完整出现", async () => {
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session, { rows: () => 12 });
    const lines = await renderComponent(component, 60, 12);

    expect(lines[0]).toMatch(/^\S{60}$/);
    expect(lines[lines.length - 1]).toMatch(/^\S{60}$/);
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);

    const joined = lines.join("\n");
    for (const fragment of ["角色", "字段", "范围", "修改", "关闭"]) {
      expect(joined).toContain(fragment);
    }
  });
});

describe("MCP 候选页交互", () => {
  function openMcpComponent() {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const component = createSettingsComponent(session);
    return { session, component };
  }

  test("Enter 打开后标题为'worker MCP 选择'且无搜索行", async () => {
    const { component } = openMcpComponent();
    const results = await pressKeys(component, [KEY.down, KEY.down, KEY.enter], 100, 40);
    const opened = contentLines(results[2]!);
    expect(opened[0]).toBe("worker MCP 选择");
    expect(opened.some((line) => line.startsWith("搜索："))).toBe(false);
  });

  test("Space 后目标项的勾选标记变化", async () => {
    const { component } = openMcpComponent();
    const results = await pressKeys(component, [KEY.down, KEY.down, KEY.enter, KEY.down, KEY.space], 100, 40);
    const beforeToggle = contentLines(results[3]!).find((line) => line.includes("chrome-devtools"));
    const afterToggle = contentLines(results[4]!).find((line) => line.includes("chrome-devtools"));
    expect(beforeToggle).toContain("[ ]");
    expect(afterToggle).toContain("[x]");
  });

  test("Esc 回主页且选中仍停留在 worker 的 MCP 字段", async () => {
    const { session, component } = openMcpComponent();
    await pressKeys(component, [KEY.down, KEY.down, KEY.enter, KEY.escape], 100, 40);
    expect(session.candidatePage()).toBeNull();
    expect(session.currentRole()).toBe("worker");
    expect(session.currentField()).toBe("mcp");
  });
});

describe("同一 Component 实例在视图间切换", () => {
  test("Enter 进入候选页、Esc 返回主页、再次 Enter 进入候选页均由同一实例渲染", async () => {
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session);
    const results = await pressKeys(component, [KEY.enter, KEY.escape, KEY.enter], 100, 40);

    expect(contentLines(results[0]!)[0]).toBe(`${ROLE_ORDER[0]} 模型选择`);
    expect(contentLines(results[1]!)[5]).toBe("模型 - 默认");
    expect(contentLines(results[2]!)[0]).toBe(`${ROLE_ORDER[0]} 模型选择`);
  });
});

describe("主页 Esc 关闭回调", () => {
  test("主页上按 Esc 触发关闭回调", async () => {
    let closed = 0;
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session, { onClose: () => { closed += 1; } });
    await pressKeys(component, [KEY.escape], 100, 40);
    expect(closed).toBe(1);
    expect(session.isClosed()).toBe(true);
  });

  test("候选页内按 Esc 只返回主页，不触发关闭回调", async () => {
    let closed = 0;
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session, { onClose: () => { closed += 1; } });
    await pressKeys(component, [KEY.enter, KEY.escape], 100, 40);
    expect(closed).toBe(0);
    expect(session.isClosed()).toBe(false);
  });
});

describe("openSettingsPage 失败契约", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function makeFakeCtx(overrides: Record<string, unknown> = {}) {
    const setEditorComponentCalls: unknown[] = [];
    return {
      ctx: {
        hasUI: true,
        mode: "tui",
        cwd: process.cwd(),
        isProjectTrusted: () => false,
        ui: {
          notify() {},
          setEditorComponent(factory: unknown) {
            setEditorComponentCalls.push(factory);
          },
        },
        ...overrides,
      },
      setEditorComponentCalls,
    };
  }

  test("全局设置文件内容非法时提示具体失败原因，且不打开设置页", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-company-settings-ext-"));
    tempRoots.push(home);
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ piCompany: { roles: { "pi-company.worker": { model: "bad-model-no-slash" } } } }),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { ctx, setEditorComponentCalls } = makeFakeCtx({ cwd: home });

      await expect(openSettingsPage(ctx)).rejects.toThrow(/worker/);
      expect(setEditorComponentCalls.length).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

function collectSaves() {
  const calls: Array<{ scope: string; role: string; field: string; value: unknown }> = [];
  const save = async (scope: string, role: string, field: string, value: unknown) => {
    calls.push({ scope, role, field, value });
  };
  return { calls, save };
}

describe("主题着色注入", () => {
  test("来源片段经 fg('muted') 包裹、横线经 fg('border') 包裹、选中值行经 bg('selectedBg') 包裹", async () => {
    const theme = {
      fg: (kind: string, text: string) => `«${kind}:${text}»`,
      bg: (kind: string, text: string) => `«${kind}:${text}»`,
    };
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } } }));
    const component = createSettingsComponent(session, { theme });
    const lines = await renderComponent(component, 100, 40);
    const joined = lines.join("\n");
    expect(joined).toContain("«border:");
    expect(joined).toContain("«muted:");
    expect(joined).toContain("«selectedBg:");
  });
});

describe("候选页提示折行", () => {
  test("40 列宽度下模型候选页提示信息折行后仍完整包含取消操作说明", async () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("enter");
    const component = createSettingsComponent(session);
    const lines = await renderComponent(component, 40, 40);
    expect(lines.join("\n")).toContain("取消");
  });
});

describe("MCP 候选页光标标记", () => {
  test("当前光标所在项行含 › 标记", async () => {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const component = createSettingsComponent(session);
    await pressKeys(component, [KEY.down, KEY.down, KEY.enter], 100, 40);
    const lines = component.render(100);
    expect(lines.join("\n")).toContain("›");
  });
});

describe("空候选页文案", () => {
  test("候选为空时显示明确的空态提示", async () => {
    const session = createSettingsSession(makeInput({ detected: [] }));
    const component = createSettingsComponent(session);
    await pressKeys(component, [KEY.down, KEY.down, KEY.enter], 100, 40);
    const lines = component.render(100);
    expect(lines.join("\n")).toContain("没有可选项");
  });
});

describe("保存失败在主页可见", () => {
  test("save 抛错后主页渲染包含失败原因文案", async () => {
    const session = createSettingsSession(
      makeInput({
        global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } },
        save: async () => {
          throw new Error("磁盘只读，无法写入设置文件");
        },
      }),
    );
    const component = createSettingsComponent(session);
    session.pressHome("enter");
    const page = session.candidatePage()!;
    await page.press("down");
    await page.press("enter");
    const lines = component.render(100);
    expect(lines.join("\n")).toContain("磁盘只读");
  });
});

describe("候选确认的异步契约", () => {
  test("确认后 requestRender 被调用一次，且确认进行中重复 Enter 不重复触发 save", async () => {
    const { calls, save } = collectSaves();
    let requestRenderCalls = 0;
    const session = createSettingsSession(makeInput({ save }));
    const component = createSettingsComponent(session, {
      requestRender: () => {
        requestRenderCalls += 1;
      },
    });
    session.pressHome("enter");
    component.handleInput("\r");
    component.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestRenderCalls).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("组件宿主契约", () => {
  test("组件具备 getText/setText/invalidate 且调用不抛出", () => {
    const session = createSettingsSession(makeInput());
    const component = createSettingsComponent(session) as { getText?: () => string; setText?: (text: string) => void; invalidate?: () => void };
    expect(() => component.getText?.()).not.toThrow();
    expect(() => component.setText?.("x")).not.toThrow();
    expect(() => component.invalidate?.()).not.toThrow();
    expect(typeof component.getText).toBe("function");
    expect(typeof component.setText).toBe("function");
    expect(typeof component.invalidate).toBe("function");
  });
});

describe("候选列表窗口化", () => {
  test("候选项超过可见行数时渲染行数不超过给定行数上限", () => {
    const manyModels = Array.from({ length: 60 }, (_, i) => ({ provider: "acme", id: `model-${i}`, thinkingLevels: ["off"] }));
    const session = createSettingsSession({
      ...makeInput(),
      models: { available: manyModels, sessionModel: "acme/model-0", sessionThinking: "off" },
    });
    const component = createSettingsComponent(session, { rows: () => 12 });
    session.pressHome("enter");
    const lines = component.render(100);
    expect(lines.length).toBeLessThanOrEqual(12);
  });
});

describe("openSettingsPage 补充契约", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function makeFakeCtx(overrides: Record<string, unknown> = {}) {
    const setEditorComponentCalls: unknown[] = [];
    return {
      ctx: {
        hasUI: true,
        mode: "tui",
        cwd: process.cwd(),
        isProjectTrusted: () => false,
        ui: {
          notify() {},
          setEditorComponent(factory: unknown) {
            setEditorComponentCalls.push(factory);
          },
        },
        ...overrides,
      },
      setEditorComponentCalls,
    };
  }

  async function makeValidHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "pi-company-settings-ext-supp-"));
    tempRoots.push(home);
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), "{}\n");
    return home;
  }

  test("跨视图切换过程中 setEditorComponent 仅被调用一次", async () => {
    const home = await makeValidHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { ctx, setEditorComponentCalls } = makeFakeCtx({ cwd: home });

      await openSettingsPage(ctx);
      expect(setEditorComponentCalls.length).toBe(1);
      const factory = setEditorComponentCalls[0] as (tui: unknown) => { handleInput(data: string): void };
      const component = factory({ terminal: { rows: 40 } });
      component.handleInput("\r");
      component.handleInput("\x1b");
      expect(setEditorComponentCalls.length).toBe(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("MCP 确认为空集合时写入显式空数组而非删除该键", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-company-settings-ext-mcp-"));
    tempRoots.push(home);
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    const defaultRoles = ["planner", "worker", "reviewer", "acceptance", "requirement-agent"];
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        piCompany: {
          roles: Object.fromEntries(defaultRoles.map((role) => [`pi-company.${role}`, { mcp: ["context7"] }])),
        },
      }),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { ctx, setEditorComponentCalls } = makeFakeCtx({ cwd: home });

      await openSettingsPage(ctx);
      const factory = setEditorComponentCalls[0] as (tui: unknown) => { render(width: number): string[]; handleInput(data: string): void };
      const component = factory({ terminal: { rows: 40 } });

      const openedLines = component.render(200);
      const currentRole = defaultRoles.find((role) => openedLines.some((line) => line.includes(`[${role}]`)))!;
      expect(currentRole).toBeTruthy();

      component.handleInput(KEY.down);
      component.handleInput(KEY.down);
      component.handleInput(KEY.enter);
      component.handleInput(KEY.space);
      component.handleInput(KEY.enter);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const raw = await readFile(join(agentDir, "settings.json"), "utf8");
      const parsed = JSON.parse(raw) as { piCompany: { roles: Record<string, { mcp?: string[] }> } };
      expect(parsed.piCompany.roles[`pi-company.${currentRole}`]).toHaveProperty("mcp");
      expect(parsed.piCompany.roles[`pi-company.${currentRole}`]!.mcp).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
