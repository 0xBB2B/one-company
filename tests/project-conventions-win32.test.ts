import { expect, test, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => "C:\\Users\\alice";
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = async () => realTarget;
  const lstat = async () => ({ isSymbolicLink: () => true });
  const readFile = async () => "旧规范\n";
  return { ...actual, realpath, lstat, readFile, default: { ...actual, realpath, lstat, readFile } };
});

let realTarget = "";
const { updateConventions } = await import("../src/modules/verification/project-conventions.ts");

async function firstLine(real: string) {
  realTarget = real;
  let first: { text: string; tone?: string } | undefined;
  await updateConventions({ repositoryRoot: "C:\\work\\repo", content: "新规范\n",
    decide: async (window) => { first = window.lines[0]; return { choices: ["不写入"] }; } });
  return first;
}

test("Windows：软链接真实路径在家目录下时，窗口第一行写成 ~ 开头并保持反斜杠", async () => {
  expect(await firstLine("C:\\Users\\alice\\.pi\\agent\\AGENTS.md"))
    .toEqual({ text: "AGENTS.md 是软链接，实际写到 ~\\.pi\\agent\\AGENTS.md", tone: "warning" });
});

test("Windows：软链接真实路径在名字以家目录名开头的别的目录下时原样显示", async () => {
  expect(await firstLine("C:\\Users\\alice2\\x\\AGENTS.md"))
    .toEqual({ text: "AGENTS.md 是软链接，实际写到 C:\\Users\\alice2\\x\\AGENTS.md", tone: "warning" });
});
