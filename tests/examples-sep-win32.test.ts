import { expect, test, vi } from "vitest";

const windows = vi.hoisted(() => ({ calls: [] as Array<{ choices: Array<{ label: string; description?: string }> }> }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => "C:\\Users\\alice";
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix };
});
vi.mock("../src/core/host/question-window.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/host/question-window.ts")>(),
  chooseWindow: async (_ctx: unknown, window: { choices: Array<{ label: string; description?: string }> }) => {
    windows.calls.push(window);
    return windows.calls.length === 1 ? "golang" : undefined;
  },
}));
vi.mock("../src/core/storage/data-root.ts", () => ({ dataRoot: () => "C:\\Users\\alice\\.pi\\agent\\one-company" }));
vi.mock("../src/core/storage/identity.ts", () => ({ primaryWorktreeRoot: async () => "C:\\Users\\alice\\shop" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ ProjectTrustStore: class { get() { return undefined; } } }));
vi.mock("../src/modules/settings/spec-examples.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/modules/settings/spec-examples.ts")>(),
  examplesDir: () => "C:\\examples",
  listExamples: async () => [{ name: "golang", label: "Go 后端" }],
  inspectExample: async () => inspection,
}));

const { confirmLines, copyFailureText, openExamplesPage, resultText } = await import("../src/modules/settings/examples-extension.ts");
const { ExampleCopyError } = await import("../src/modules/settings/spec-examples.ts");

const inspection = { skills: [], agents: [], section: { heading: "Go 后端规范", state: "same" as const }, overall: "未复制" as const };
const agentDir = "C:\\Users\\alice\\.pi\\agent";

test("Windows：确认窗口里 skills 和角色定义的目标目录结尾用反斜杠", () => {
  const lines = confirmLines({
    inspection,
    targets: { skillsDir: `${agentDir}\\skills`, agentsDir: `${agentDir}\\agents`, conventionsFile: `${agentDir}\\AGENTS.md` },
    layer: "user",
    userAgentsDir: `${agentDir}\\agents`,
    projectAgentsDir: null,
    disabled: { user: [], project: [] },
    conventions: { before: null, over: false, bytes: 0, excess: 0 },
  }).map((line) => line.text);
  expect(lines).toContain("skills → ~\\.pi\\agent\\skills\\");
  expect(lines).toContain("角色定义 → ~\\.pi\\agent\\agents\\");
});

test("Windows：AGENTS.md 没有权限写入时，提示里的目录结尾用反斜杠", () => {
  const writeError = Object.assign(new Error("denied"), { code: "EACCES" });
  const text = resultText({ label: "Go 后端", layer: "project", written: 0, skipped: [], inspection, conventionsFile: "C:\\Users\\alice\\shop\\AGENTS.md", outcome: "failed", writeError, writeDir: "C:\\Users\\alice\\shop" });
  expect(text).toContain("没有权限写入 ~\\shop\\；");
});

test("Windows：复制失败提示里的目录结尾用反斜杠", () => {
  const text = copyFailureText(new ExampleCopyError(2, `${agentDir}\\skills\\go`, "EACCES", "denied"));
  expect(text).toContain("没有权限写入 ~\\.pi\\agent\\skills\\go\\\n");
});

test("Windows：选层窗口里用户层和项目层的目录结尾用反斜杠", async () => {
  await openExamplesPage({ hasUI: true, mode: "tui", cwd: "C:\\Users\\alice\\shop", ui: { notify() {} } } as never);
  const descriptions = windows.calls[1]!.choices.map((choice) => choice.description);
  expect(descriptions[0]).toBe("~\\.pi\\agent\\ · 对你的所有项目生效");
  expect(descriptions[1]).toBe("~\\shop\\ · 只对这个项目生效");
});
