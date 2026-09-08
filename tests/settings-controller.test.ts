import { describe, expect, test } from "bun:test";
import { createSettingsComponent, createSettingsSession } from "../runtime/settings-ui.ts";
import { renderComponent } from "./helpers/virtual-terminal.ts";

const ROLE_ORDER = ["worker", "planner", "reviewer", "acceptance", "requirement-agent", "custom-role"];

const MODEL_A = { provider: "acme", id: "model-a", thinkingLevels: ["off", "low", "medium", "high"] };
const MODEL_SONNET = { provider: "acme", id: "sonnet-x", thinkingLevels: ["off", "low", "medium"] };
const MODEL_B = { provider: "other", id: "model-b", thinkingLevels: ["off", "high", "max"] };
const MODELS = [MODEL_A, MODEL_SONNET, MODEL_B];
const SESSION_MODEL = "acme/model-a";
const SESSION_THINKING = "medium";
const HINT_TEXT = "←→ 角色 · ↑↓ 字段 · Tab 范围 · Enter 修改 · Esc 关闭";

function makeInput(opts: {
  roles?: string[];
  global?: Record<string, unknown>;
  project?: Record<string, unknown> | null;
  scope?: "global" | "project";
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
    scope: opts.scope ?? "global",
    models: { available: MODELS, sessionModel: SESSION_MODEL, sessionThinking: SESSION_THINKING },
    mcp: { detected: opts.detected ?? ["context7", "chrome-devtools"] },
    save: opts.save ?? (async () => {}),
  };
}

function collectSaves() {
  const calls: Array<{ scope: string; role: string; field: string; value: unknown }> = [];
  const save = async (scope: string, role: string, field: string, value: unknown) => {
    calls.push({ scope, role, field, value });
  };
  return { calls, save };
}

function fieldRow(rows: ReturnType<ReturnType<typeof createSettingsSession>["homeRows"]>, field: string, kind: "field-title" | "field-value") {
  return rows.find((row: any) => row.kind === kind && row.field === field);
}

describe("会话创建", () => {
  test("初始角色为目录第一项、初始字段为 model、范围与注入一致", () => {
    const session = createSettingsSession(makeInput({ scope: "project" }));
    expect(session.currentRole()).toBe(ROLE_ORDER[0]);
    expect(session.currentField()).toBe("model");
    expect(session.currentScope()).toBe("project");
  });

  test("初始未打开候选页，回执为空", () => {
    const session = createSettingsSession(makeInput());
    expect(session.candidatePage()).toBeNull();
    expect(session.lastReceipt()).toBeNull();
    expect(session.isClosed()).toBe(false);
  });
});

describe("主页行模型", () => {
  test("行顺序为标题/范围/角色标签/模型标题/模型值/思考标题/思考值/MCP标题/MCP值/提示，共十行", () => {
    const session = createSettingsSession(makeInput());
    const kinds = session.homeRows().map((row: any) => row.kind);
    expect(kinds).toEqual([
      "title",
      "scope",
      "roles",
      "field-title",
      "field-value",
      "field-title",
      "field-value",
      "field-title",
      "field-value",
      "hint",
    ]);
    const fieldOrder = session
      .homeRows()
      .filter((row: any) => row.kind === "field-title")
      .map((row: any) => row.field);
    expect(fieldOrder).toEqual(["model", "thinking", "mcp"]);
  });

  test("范围行含全局与项目，且仅当前范围带方括号标记", () => {
    const session = createSettingsSession(makeInput({ scope: "global" }));
    const scopeRow = session.homeRows().find((row: any) => row.kind === "scope") as any;
    expect(scopeRow.options.map((o: any) => o.label)).toEqual(["全局", "项目"]);
    expect(scopeRow.options.find((o: any) => o.value === "global").active).toBe(true);
    expect(scopeRow.options.find((o: any) => o.value === "project").active).toBe(false);
  });

  test("角色标签行按目录顺序排列，含需求代理，仅当前角色带方括号标记", () => {
    const session = createSettingsSession(makeInput());
    const rolesRow = session.homeRows().find((row: any) => row.kind === "roles") as any;
    expect(rolesRow.options.map((o: any) => o.value)).toEqual(ROLE_ORDER);
    expect(rolesRow.options.map((o: any) => o.value)).toContain("requirement-agent");
    expect(rolesRow.options.find((o: any) => o.value === ROLE_ORDER[0]).active).toBe(true);
  });

  test("字段标题带来源：全局显式设置显示来源为全局，未设置显示来源为默认", () => {
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } } }));
    const rows = session.homeRows();
    const modelTitle = fieldRow(rows, "model", "field-title") as any;
    const thinkingTitle = fieldRow(rows, "thinking", "field-title") as any;
    expect(modelTitle.source).toBe("global");
    expect(modelTitle.text).toBe("模型 - 全局");
    expect(thinkingTitle.source).toBe("default");
    expect(thinkingTitle.text).toBe("思考 - 默认");
  });

  test("模型与思考字段未设置时值显示沿用/默认字样，MCP 未设置时显示无", () => {
    const session = createSettingsSession(makeInput());
    const rows = session.homeRows();
    expect((fieldRow(rows, "model", "field-value") as any).text).toBe("沿用主会话");
    expect((fieldRow(rows, "thinking", "field-value") as any).text).toBe("使用上级/角色默认");
    expect((fieldRow(rows, "mcp", "field-value") as any).text).toBe("无");
  });

  test("MCP 值列出已勾选服务并按顿号分隔，不可用项标注不可用", () => {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7", "codegraph"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const value = (fieldRow(session.homeRows(), "mcp", "field-value") as any).text;
    expect(value).toBe("context7、codegraph（不可用）");
  });

  test("字段值缩进不影响文本内容，值行 text 不含前导空白（缩进由渲染层负责）", () => {
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } } }));
    const value = (fieldRow(session.homeRows(), "model", "field-value") as any).text;
    expect(value).toBe("acme/model-a");
  });

  test("提示行文本为完整操作提示", () => {
    const session = createSettingsSession(makeInput());
    const hintRow = session.homeRows().find((row: any) => row.kind === "hint") as any;
    expect(hintRow.text).toBe(HINT_TEXT);
  });
});

describe("主页按键", () => {
  test("右键切到下一个角色，当前字段保持不变", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("down");
    expect(session.currentField()).toBe("thinking");
    session.pressHome("right");
    expect(session.currentRole()).toBe(ROLE_ORDER[1]);
    expect(session.currentField()).toBe("thinking");
  });

  test("左键在首个角色上不下溢（边界）", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("left");
    expect(session.currentRole()).toBe(ROLE_ORDER[0]);
  });

  test("右键到达末个角色后不上溢（边界）", () => {
    const session = createSettingsSession(makeInput());
    for (let i = 0; i < ROLE_ORDER.length + 2; i++) session.pressHome("right");
    expect(session.currentRole()).toBe(ROLE_ORDER[ROLE_ORDER.length - 1]);
  });

  test("Tab 切范围不触发 save 且角色、字段、字段展示值均不变", () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(
      makeInput({ scope: "global", global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } }, save }),
    );
    session.pressHome("down");
    const valueRowsOf = (rows: ReturnType<typeof session.homeRows>) =>
      rows.filter((row) => row.kind === "field-value" || row.kind === "field-title").map((row) => ({ ...row }));
    const before = valueRowsOf(session.homeRows());
    session.pressHome("tab");
    expect(session.currentScope()).toBe("project");
    expect(session.currentRole()).toBe(ROLE_ORDER[0]);
    expect(session.currentField()).toBe("thinking");
    expect(valueRowsOf(session.homeRows())).toEqual(before);
    const scopeRow = session.homeRows().find((row) => row.kind === "scope");
    expect(scopeRow?.options?.find((o) => o.value === "project")?.active).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("上下键在模型/思考/MCP 三字段间循环", () => {
    const session = createSettingsSession(makeInput());
    expect(session.currentField()).toBe("model");
    session.pressHome("down");
    expect(session.currentField()).toBe("thinking");
    session.pressHome("down");
    expect(session.currentField()).toBe("mcp");
    session.pressHome("down");
    expect(session.currentField()).toBe("model");
    session.pressHome("up");
    expect(session.currentField()).toBe("mcp");
  });
});

describe("三种候选：模型", () => {
  test("Enter 打开模型候选页，标题为'<角色> 模型选择'，可搜索", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("enter");
    const page = session.candidatePage();
    expect(page).not.toBeNull();
    expect(page!.field).toBe("model");
    expect(page!.title).toBe(`${ROLE_ORDER[0]} 模型选择`);
    expect(page!.searchable).toBe(true);
  });

  test("输入 son 后只剩标签包含 son 的候选，含'沿用主会话'被一并纳入搜索过滤", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("enter");
    const page = session.candidatePage()!;
    page.setQuery("son");
    expect(page.items().map((item) => item.value)).toEqual(["acme/sonnet-x"]);
  });

  test("未显式设置模型时候选页初始定位到'沿用主会话'", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("enter");
    const page = session.candidatePage()!;
    expect(page.items()[page.cursor()].value).toBe("inherit");
  });

  test("已显式设置模型时候选页初始定位到当前模型", () => {
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "other/model-b" } } }));
    session.pressHome("enter");
    const page = session.candidatePage()!;
    expect(page.items()[page.cursor()].value).toBe("other/model-b");
  });

  test("直接确认沿用项，保存值仍为 inherit，且返回主页", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(makeInput({ save }));
    session.pressHome("enter");
    await session.candidatePage()!.press("enter");
    expect(calls).toEqual([{ scope: "global", role: ROLE_ORDER[0], field: "model", value: "inherit" }]);
    expect(session.candidatePage()).toBeNull();
    expect(session.lastReceipt()).toEqual({ ok: true });
  });

  test("确认保存时使用当前所选范围", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(makeInput({ scope: "global", save }));
    session.pressHome("tab");
    session.pressHome("enter");
    await session.candidatePage()!.press("enter");
    expect(calls[0]?.scope).toBe("project");
  });
});

describe("三种候选：思考", () => {
  test("思考候选只含当前有效模型支持的等级，并含'使用上级/角色默认'，不可搜索", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("down");
    session.pressHome("enter");
    const page = session.candidatePage()!;
    expect(page.field).toBe("thinking");
    expect(page.title).toBe(`${ROLE_ORDER[0]} 思考选择`);
    expect(page.searchable).toBe(false);
    expect(page.items().map((item) => item.value)).toEqual(["inherit", ...MODEL_A.thinkingLevels]);
  });

  test("角色显式设置了模型时，思考候选跟随该模型的能力集合", () => {
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "other/model-b" } } }));
    session.pressHome("down");
    session.pressHome("enter");
    const page = session.candidatePage()!;
    expect(page.items().map((item) => item.value)).toEqual(["inherit", ...MODEL_B.thinkingLevels]);
  });

  test("未显式设置思考时初始定位到'使用上级/角色默认'", () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("down");
    session.pressHome("enter");
    const page = session.candidatePage()!;
    expect(page.items()[page.cursor()].value).toBe("inherit");
  });
});

describe("三种候选：MCP", () => {
  function openMcp(session: ReturnType<typeof createSettingsSession>) {
    session.pressHome("down");
    session.pressHome("down");
    session.pressHome("enter");
    return session.candidatePage()!;
  }

  test("候选为探测到的全部服务加已保存但不可用的服务，标注不可用", () => {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7", "codegraph"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const page = openMcp(session);
    expect(page.field).toBe("mcp");
    expect(page.title).toBe(`${ROLE_ORDER[0]} MCP 选择`);
    expect(page.searchable).toBe(false);
    const values = page.items().map((item) => item.value);
    expect(values.sort()).toEqual(["chrome-devtools", "codegraph", "context7"]);
    const codegraph = page.items().find((item) => item.value === "codegraph")!;
    expect(codegraph.unavailable).toBe(true);
    expect(codegraph.checked).toBe(true);
    const chromeDevtools = page.items().find((item) => item.value === "chrome-devtools")!;
    expect(chromeDevtools.checked).toBe(false);
  });

  test("Space 按两次后勾选状态恢复原状", async () => {
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } }, detected: ["context7", "chrome-devtools"] }),
    );
    const page = openMcp(session);
    await page.press("down");
    const target = page.items()[page.cursor()];
    expect(target.value).toBe("chrome-devtools");
    expect(target.checked).toBe(false);
    await page.press("space");
    expect(page.items()[page.cursor()].checked).toBe(true);
    await page.press("space");
    expect(page.items()[page.cursor()].checked).toBe(false);
  });

  test("Esc 取消后配置不变，回到进入前的角色与字段", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } }, detected: ["context7", "chrome-devtools"], save }),
    );
    const before = (fieldRow(session.homeRows(), "mcp", "field-value") as any).text;
    const page = openMcp(session);
    await page.press("space");
    await page.press("escape");
    expect(session.candidatePage()).toBeNull();
    expect(calls.length).toBe(0);
    expect((fieldRow(session.homeRows(), "mcp", "field-value") as any).text).toBe(before);
    expect(session.currentRole()).toBe(ROLE_ORDER[0]);
    expect(session.currentField()).toBe("mcp");
  });

  test("Enter 后保存的配置为最终勾选集合，全部取消后保存空集合", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(
      makeInput({ global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } }, detected: ["context7"], save }),
    );
    const page = openMcp(session);
    expect(page.items()[page.cursor()].value).toBe("context7");
    await page.press("space");
    await page.press("enter");
    expect(calls).toEqual([{ scope: "global", role: ROLE_ORDER[0], field: "mcp", value: [] }]);
    expect((fieldRow(session.homeRows(), "mcp", "field-value") as any).text).toBe("无");
  });

  test("未探测到适配器且角色未保存任何服务时没有候选", () => {
    const session = createSettingsSession(makeInput({ detected: [] }));
    const page = openMcp(session);
    expect(page.items()).toEqual([]);
  });
});

describe("保存回执", () => {
  test("持久化成功时回执 ok 为 true", async () => {
    const session = createSettingsSession(makeInput());
    session.pressHome("enter");
    await session.candidatePage()!.press("enter");
    expect(session.lastReceipt()).toEqual({ ok: true });
  });

  test("save 抛错时回执含原因，主页字段仍显示保存前的值，返回主页且角色字段不变", async () => {
    const session = createSettingsSession(
      makeInput({
        save: async () => {
          throw new Error("磁盘只读，无法写入设置文件");
        },
      }),
    );
    session.pressHome("enter");
    const page = session.candidatePage()!;
    await page.press("down");
    await page.press("enter");
    const receipt = session.lastReceipt()!;
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toContain("磁盘只读");
    expect((fieldRow(session.homeRows(), "model", "field-value") as any).text).toBe("沿用主会话");
    expect(session.candidatePage()).toBeNull();
    expect(session.currentRole()).toBe(ROLE_ORDER[0]);
    expect(session.currentField()).toBe("model");
  });
});

describe("来源判断", () => {
  test("项目层显式设置覆盖全局，来源显示为项目，且与当前所选范围无关", () => {
    const session = createSettingsSession(
      makeInput({
        scope: "global",
        global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } },
        project: { [ROLE_ORDER[0]]: { model: "other/model-b" } },
      }),
    );
    const rows = session.homeRows();
    expect((fieldRow(rows, "model", "field-title") as any).source).toBe("project");
    expect((fieldRow(rows, "model", "field-value") as any).text).toBe("other/model-b");
  });

  test("项目层存在但未保存 mcp 字段时按字段回退到全局，来源显示为全局", () => {
    const session = createSettingsSession(
      makeInput({
        global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } },
        project: { [ROLE_ORDER[0]]: { model: "other/model-b" } },
        detected: ["context7"],
      }),
    );
    const rows = session.homeRows();
    expect((fieldRow(rows, "mcp", "field-title") as any).source).toBe("global");
    expect((fieldRow(rows, "mcp", "field-value") as any).text).toBe("context7");
  });

  test("两层均未设置时来源为默认", () => {
    const session = createSettingsSession(makeInput());
    const rows = session.homeRows();
    expect((fieldRow(rows, "model", "field-title") as any).source).toBe("default");
    expect((fieldRow(rows, "thinking", "field-title") as any).source).toBe("default");
    expect((fieldRow(rows, "mcp", "field-title") as any).source).toBe("default");
  });
});

describe("角色标签行按宽度折行", () => {
  test("窄宽度下角色标签换行显示而非截断，当前角色方括号完整可见", async () => {
    const roles = ["worker", "planner", "reviewer", "acceptance", "requirement-agent", "custom-role"];
    const session = createSettingsSession(makeInput({ roles }));
    for (let i = 0; i < 5; i++) session.pressHome("right");
    const component = createSettingsComponent(session);
    const lines = await renderComponent(component, 60, 40);
    const joined = lines.join("\n");
    for (const name of roles) expect(joined).toContain(name);
    expect(joined).toContain("[custom-role]");
  });
});

describe("确认沿用项后字段来源回退", () => {
  test("从显式模型切回沿用主会话后，字段来源变为默认而非仍标记为当前层", async () => {
    const session = createSettingsSession(makeInput({ global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } } }));
    session.pressHome("enter");
    const page = session.candidatePage()!;
    await page.press("up");
    expect(page.items()[page.cursor()].value).toBe("inherit");
    await page.press("enter");
    const titleRow = fieldRow(session.homeRows(), "model", "field-title") as any;
    expect(titleRow.source).toBe("default");
  });
});

describe("模型候选搜索过滤后的游标与确认语义", () => {
  test("过滤后确认保存的是高亮的可见项，而不是过滤前的游标值", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(makeInput({ save }));
    session.pressHome("enter");
    const page = session.candidatePage()!;
    page.setQuery("son");
    expect(page.items().map((item) => item.value)).toEqual(["acme/sonnet-x"]);
    expect(page.cursor()).toBe(0);
    await page.press("enter");
    expect(calls[0]?.value).toBe("acme/sonnet-x");
  });

  test("搜索无结果时回车不发起保存，候选页保持打开", async () => {
    const { calls, save } = collectSaves();
    const session = createSettingsSession(makeInput({ save }));
    session.pressHome("enter");
    const page = session.candidatePage()!;
    page.setQuery("zzzz");
    expect(page.items()).toEqual([]);
    await page.press("enter");
    expect(calls).toEqual([]);
    expect(session.candidatePage()).not.toBeNull();
    expect(session.lastReceipt()).toBeNull();
  });

  test("保存失败的回执在主页导航后被清除", async () => {
    const session = createSettingsSession(
      makeInput({
        save: async () => {
          throw new Error("磁盘只读");
        },
      }),
    );
    session.pressHome("enter");
    await session.candidatePage()!.press("enter");
    expect(session.lastReceipt()?.ok).toBe(false);
    session.pressHome("down");
    expect(session.lastReceipt()).toBeNull();
  });
});

describe("MCP 初始勾选按当前所选范围解析", () => {
  test("global 范围只取 global 层显式值，不受 project 层影响", () => {
    const session = createSettingsSession(
      makeInput({
        scope: "global",
        global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } },
        project: { [ROLE_ORDER[0]]: { mcp: [] } },
        detected: ["context7"],
      }),
    );
    session.pressHome("down");
    session.pressHome("down");
    session.pressHome("enter");
    const checked = session
      .candidatePage()!
      .items()
      .filter((item) => item.checked)
      .map((item) => item.value);
    expect(checked).toEqual(["context7"]);
  });

  test("project 范围下 project 层未设置该字段时取 global 层显式值", () => {
    const session = createSettingsSession(
      makeInput({
        scope: "project",
        global: { [ROLE_ORDER[0]]: { mcp: ["context7"] } },
        project: { [ROLE_ORDER[0]]: { model: "other/model-b" } },
        detected: ["context7"],
      }),
    );
    session.pressHome("down");
    session.pressHome("down");
    session.pressHome("enter");
    const checked = session
      .candidatePage()!
      .items()
      .filter((item) => item.checked)
      .map((item) => item.value);
    expect(checked).toEqual(["context7"]);
  });
});

describe("保存失败回执与 homeRows 不可变性", () => {
  test("save 抛错后回执含原因、主页仍显示旧值，且 homeRows 每次调用互不共享引用", async () => {
    const session = createSettingsSession(
      makeInput({
        global: { [ROLE_ORDER[0]]: { model: "acme/model-a" } },
        save: async () => {
          throw new Error("写入被拒绝：只读文件系统");
        },
      }),
    );
    const firstCall = session.homeRows();
    const secondCall = session.homeRows();
    expect(firstCall).not.toBe(secondCall);

    session.pressHome("enter");
    const page = session.candidatePage()!;
    await page.press("down");
    await page.press("enter");

    const receipt = session.lastReceipt()!;
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toContain("只读文件系统");
    const valueRow = fieldRow(session.homeRows(), "model", "field-value") as any;
    expect(valueRow.text).toBe("acme/model-a");
  });
});

describe("空候选场景补充", () => {
  test("project 范围下未探测到适配器且角色未保存服务时没有候选", () => {
    const session = createSettingsSession(makeInput({ scope: "project", detected: [] }));
    session.pressHome("down");
    session.pressHome("down");
    session.pressHome("enter");
    expect(session.candidatePage()!.items()).toEqual([]);
  });
});
