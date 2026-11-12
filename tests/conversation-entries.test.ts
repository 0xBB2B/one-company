import { expect, test, vi } from "vitest";
import { appendCustomEntry, branchCustomEntries } from "../src/core/host/conversation-entries.ts";

const custom = (id: string, customType: string, data?: unknown) => ({ type: "custom", id, parentId: null, customType, data });
const manager = (entries: unknown[]) => ({ getBranch: () => entries }) as never;

test("branchCustomEntries只返回指定customType的data，顺序与对话一致", () => {
  const entries = [
    { type: "message", id: "1", parentId: null },
    custom("2", "one-company.line-anchor", { anchor: "a" }),
    custom("3", "other", { anchor: "x" }),
    custom("4", "one-company.line-anchor", { anchor: "b" }),
  ];
  expect(branchCustomEntries(manager(entries), "one-company.line-anchor")).toEqual([{ anchor: "a" }, { anchor: "b" }]);
});

test("对话线夹着压缩记录时仍返回压缩前的自定义记录", () => {
  const entries = [
    custom("1", "t", { n: 1 }),
    { type: "compaction", id: "2", parentId: "1" },
    custom("3", "t", { n: 2 }),
  ];
  expect(branchCustomEntries(manager(entries), "t")).toEqual([{ n: 1 }, { n: 2 }]);
});

test("没有匹配的自定义记录时返回空数组", () => {
  expect(branchCustomEntries(manager([custom("1", "a", 1)]), "b")).toEqual([]);
  expect(branchCustomEntries(manager([]), "b")).toEqual([]);
});

test("appendCustomEntry把customType和data原样交给pi.appendEntry", () => {
  const appendEntry = vi.fn();
  const data = { repoId: "r", requirementId: "q", anchor: "a" };
  appendCustomEntry({ appendEntry } as never, "one-company.line-anchor", data);
  expect(appendEntry).toHaveBeenCalledTimes(1);
  expect(appendEntry).toHaveBeenCalledWith("one-company.line-anchor", data);
});
