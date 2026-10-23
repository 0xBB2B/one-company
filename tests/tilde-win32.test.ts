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

const { tilde } = await import("../src/modules/settings/settings-page-ui.ts");

test("Windows：家目录下的路径把家目录部分写成 ~，分隔符保持反斜杠", () => {
  expect(tilde("C:\\Users\\alice\\.pi\\agent\\AGENTS.md")).toBe("~\\.pi\\agent\\AGENTS.md");
});

test("Windows：路径等于家目录时写成 ~", () => {
  expect(tilde("C:\\Users\\alice")).toBe("~");
});

test("Windows：名字以家目录名开头的别的目录原样显示", () => {
  expect(tilde("C:\\Users\\alice2\\x")).toBe("C:\\Users\\alice2\\x");
});
