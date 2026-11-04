import { expect, test, vi } from "vitest";

const windows = vi.hoisted(() => ({
  calls: [] as Array<{ choices: Array<{ label: string; description?: string }>; lines?: Array<{ text: string }> }>,
  answers: [] as Array<string | undefined>,
}));

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
  chooseWindow: async (_ctx: unknown, window: { choices: Array<{ label: string; description?: string }>; lines?: Array<{ text: string }> }) => {
    windows.calls.push(window);
    return windows.answers[windows.calls.length - 1];
  },
}));
vi.mock("../src/core/storage/data-root.ts", () => ({ dataRoot: () => "C:\\Users\\alice\\.pi\\agent\\one-company" }));
vi.mock("../src/core/storage/identity.ts", () => ({ primaryWorktreeRoot: async () => "C:\\Users\\alice\\shop" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ ProjectTrustStore: class { get() { return undefined; } } }));
vi.mock("../src/modules/settings/spec-examples.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/settings/spec-examples.ts")>();
  return {
    ...actual,
    examplesDir: () => "C:\\examples",
    listExamples: async () => [{ name: "golang", label: "Go 后端" }],
    inspectExample: async () => inspection,
    copyExampleFiles: async () => { throw new actual.ExampleCopyError(2, `${agentDir}\\skills\\go`, "EACCES", "denied"); },
  };
});

const { openExamplesPage } = await import("../src/modules/settings/examples-extension.ts");

const agentDir = "C:\\Users\\alice\\.pi\\agent";
const inspection = {
  skills: [{ name: "go", state: "missing" as const, files: [{ path: `${agentDir}\\skills\\go\\SKILL.md`, source: "C:\\examples\\golang\\skills\\go\\SKILL.md", state: "missing" as const }] }],
  agents: [],
  overall: "未复制" as const,
};

async function openPage(answers: Array<string | undefined>) {
  windows.calls.length = 0;
  windows.answers = answers;
  const notifications: string[] = [];
  await openExamplesPage({ hasUI: true, mode: "tui", cwd: "C:\\Users\\alice\\shop", ui: { notify: (message: string) => notifications.push(message) } } as never);
  return notifications;
}

test("Windows：确认窗口第一行里层目录结尾用反斜杠", async () => {
  await openPage(["golang", "用户层", "不复制"]);
  const texts = windows.calls[2]!.lines!.map((line) => line.text);
  expect(texts).toContain("复制 1 份到 ~\\.pi\\agent\\：1 份 skill。");
});

test("Windows：复制失败提示里的目录结尾用反斜杠", async () => {
  const notifications = await openPage(["golang", "用户层", "复制"]);
  expect(notifications[0]).toContain("没有权限写入 ~\\.pi\\agent\\skills\\go\\\n");
});

test("Windows：选层窗口里用户层和项目层的目录结尾用反斜杠", async () => {
  await openPage(["golang"]);
  const descriptions = windows.calls[1]!.choices.map((choice) => choice.description);
  expect(descriptions[0]).toBe("~\\.pi\\agent\\ · 对你的所有项目生效");
  expect(descriptions[1]).toBe("~\\shop\\ · 只对这个项目生效 · 选它会把本项目设为受信任");
});
