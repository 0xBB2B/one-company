import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "", real: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => state.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = async () => state.real;
  const lstat = async () => ({ isSymbolicLink: () => true });
  const readFile = async () => "旧规范\n";
  return { ...actual, realpath, lstat, readFile, default: { ...actual, realpath, lstat, readFile } };
});

const { tilde } = await import("../src/modules/settings/settings-page-ui.ts");
const { updateConventions } = await import("../src/modules/verification/project-conventions.ts");

async function firstLine(real: string) {
  state.real = real;
  let first: { text: string; tone?: string } | undefined;
  await updateConventions({ repositoryRoot: "C:\\work\\repo", content: "新规范\n",
    decide: async (window) => { first = window.lines[0]; return { choices: ["不写入"] }; } });
  return first;
}

beforeEach(() => { state.home = "C:\\Users\\alice\\"; });

test("Windows 家目录带结尾反斜杠：家目录下的路径写成 ~ 开头", () => {
  expect(tilde("C:\\Users\\alice\\.pi\\agent\\AGENTS.md")).toBe("~\\.pi\\agent\\AGENTS.md");
});

test("Windows 家目录带结尾反斜杠：路径等于去掉结尾反斜杠的家目录时写成 ~", () => {
  expect(tilde("C:\\Users\\alice")).toBe("~");
});

test("Windows 家目录为空字符串：任何路径原样显示", () => {
  state.home = "";
  expect(tilde("C:\\Windows\\System32")).toBe("C:\\Windows\\System32");
});

test("Windows 家目录带结尾反斜杠：软链接真实路径在家目录下时窗口第一行写成 ~ 开头", async () => {
  expect(await firstLine("C:\\Users\\alice\\.pi\\agent\\AGENTS.md"))
    .toEqual({ text: "AGENTS.md 是软链接，实际写到 ~\\.pi\\agent\\AGENTS.md", tone: "warning" });
});

test("Windows 家目录为空字符串：软链接真实路径原样显示", async () => {
  state.home = "";
  expect(await firstLine("C:\\Windows\\System32\\AGENTS.md"))
    .toEqual({ text: "AGENTS.md 是软链接，实际写到 C:\\Windows\\System32\\AGENTS.md", tone: "warning" });
});
