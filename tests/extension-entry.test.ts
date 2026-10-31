import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import registerExtensions from "../src/app/extension/index.ts";
import shellUiExtension from "../src/modules/shell/shell-ui-extension.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_COMMAND_NAMES = [
  "one:setting",
  "one:ps",
];

// extension-lifecycle.ts 的 session_start 处理器体内唯一出现的变量名，用来在不触发真实会话的前提下辨认注册顺序中的第一个处理器来自谁
const LIFECYCLE_SESSION_START_MARKER = "capturedShutdown";

function makeShellUiCtx() {
  return {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify() {},
      setStatus() {},
    },
  };
}

describe("src/app/extension/index.ts 唯一扩展入口", () => {
  test("registerCommand 收到的命令名无重复，包含 one:setting 和 one:ps，不含 spec-* 别名", () => {
    const fakePi = createFakePi();

    registerExtensions(fakePi.pi);

    const names = fakePi.registeredCommands().map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_COMMAND_NAMES) {
      expect(names).toContain(required);
    }
    expect(names.some((name) => name.startsWith("spec-"))).toBe(false);
    expect(names).not.toContain("one:agents");
    expect(names).not.toContain("one:git-delivery");
  });

  test("registerTool 收到的工具名整体无重复（含 bash，覆盖各子扩展同步注册的全部工具）", () => {
    const fakePi = createFakePi();

    registerExtensions(fakePi.pi);

    const names = fakePi.registeredTools().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("one_company_project_manage");
    expect(names.filter((name) => name === "bash").length).toBe(1);
  });

  test("工具参数的正则不用 \\p{..}、前后顾与代理项范围：部分提供方（如 OpenAI Responses 接口）会整条请求失败", () => {
    const fakePi = createFakePi();

    registerExtensions(fakePi.pi);

    const offenders = fakePi.registeredTools().filter((tool) => /\\\\p\{|\(\?<?[=!]|\\\\ud[89a-f]/i.test(JSON.stringify(tool.parameters)));
    expect(offenders.map((tool) => tool.name)).toEqual([]);
  });

  test("注册后有监听 agent_settled 的处理器（输入建议扩展已接入）", () => {
    const fakePi = createFakePi();

    registerExtensions(fakePi.pi);

    expect(fakePi.handlerCount("agent_settled")).toBeGreaterThan(0);
  });

  test("package.json 的 pi.extensions 恰为 index.ts 单一入口", async () => {
    const raw = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { pi?: { extensions?: unknown } };

    expect(pkg.pi?.extensions).toEqual(["./src/app/extension/index.ts"]);
  });

  test("session_start 处理器注册顺序中，首位来自 lifecycle（先于 pm-panel/shell-ui）", () => {
    const fakePi = createFakePi();

    registerExtensions(fakePi.pi);

    const sessionStartHandlers = fakePi.handlersFor("session_start");
    expect(sessionStartHandlers.length).toBeGreaterThan(0);
    expect(sessionStartHandlers[0]!.toString()).toContain(LIFECYCLE_SESSION_START_MARKER);
  });
});

describe("shell-ui 的 bash 工具注册对重复 session_start 具备幂等性", () => {
  test("两次 session_start 触发后，registerTool 收到的 bash 仍恰为一次", async () => {
    const fakePi = createFakePi();
    shellUiExtension(fakePi.pi);

    const ctx = makeShellUiCtx();
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
    await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);

    const bashRegistrations = fakePi.registeredTools().filter((tool) => tool.name === "bash");
    expect(bashRegistrations.length).toBe(1);
  });
});
