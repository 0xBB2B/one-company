import { expect, test, vi } from "vitest";
import { currentLine, recordLineAnchor, recordSaveStart, startedSaves } from "../src/modules/interaction/conversation-line.ts";

const anchorEntry = (requirementId: string, anchor: string) =>
  ({ type: "custom", customType: "one-company.line-anchor", data: { repoId: "repo", requirementId, anchor } });
const sessionOf = (branch: unknown[]) => ({ getBranch: () => branch }) as never;

test("currentLine 按需求分组并保持对话顺序", () => {
  const line = currentLine(sessionOf([anchorEntry("r1", "a1"), anchorEntry("r2", "b1"), anchorEntry("r1", "a2"), anchorEntry("r2", "b2"), anchorEntry("r1", "a3")]));
  expect(line).toEqual({ r1: ["a1", "a2", "a3"], r2: ["b1", "b2"] });
});

test("currentLine 忽略其他类型的记录", () => {
  const line = currentLine(sessionOf([
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "custom", customType: "other.thing", data: { repoId: "repo", requirementId: "r1", anchor: "x" } },
    anchorEntry("r1", "a1"),
  ]));
  expect(line).toEqual({ r1: ["a1"] });
});

test("currentLine 在没有锚点记录时返回空对象", () => {
  expect(currentLine(sessionOf([]))).toEqual({});
});

test("recordLineAnchor 原样调用 appendEntry", () => {
  const appendEntry = vi.fn();
  recordLineAnchor({ appendEntry } as never, { repoId: "repo", requirementId: "r1", anchor: "a1" });
  expect(appendEntry).toHaveBeenCalledExactlyOnceWith("one-company.line-anchor", { repoId: "repo", requirementId: "r1", anchor: "a1" });
});

const saveStartEntry = (requirementId: string, operationId: string) =>
  ({ type: "custom", customType: "one-company.save-start", data: { repoId: "repo", requirementId, operationId } });

test("recordSaveStart 以保存开始记录的类型调用 appendEntry", () => {
  const appendEntry = vi.fn();
  recordSaveStart({ appendEntry } as never, { repoId: "repo", requirementId: "r1", operationId: "op1" });
  expect(appendEntry).toHaveBeenCalledExactlyOnceWith("one-company.save-start", { repoId: "repo", requirementId: "r1", operationId: "op1" });
});

test("startedSaves 按需求分组返回当前线上的操作编号，忽略其他类型的记录", () => {
  const started = startedSaves(sessionOf([saveStartEntry("r1", "o1"), anchorEntry("r1", "a1"), saveStartEntry("r2", "o2"), saveStartEntry("r1", "o3")]));
  expect(started).toEqual({ r1: ["o1", "o3"], r2: ["o2"] });
});
