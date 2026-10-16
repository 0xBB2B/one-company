import { expect, test, vi } from "vitest";

const calls: Array<{ args: string[]; options: { timeout?: number } }> = [];
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (_file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest.pop() as (error: null, result: { stdout: string; stderr: string }) => void;
    calls.push({ args, options: (rest[0] ?? {}) as { timeout?: number } });
    callback(null, { stdout: "b\n", stderr: "" });
  },
}));

const timeoutOf = (command: string) => calls.find((call) => call.args.includes(command))?.options.timeout;

test("M8M-AC5：会写仓库或走网络的 git 调用超时 120 秒，搜索排除判断忽略的 git 调用超时 10 秒", async () => {
  const { gitIn } = await import("../src/core/exec/target-branch.ts");
  await gitIn("/repo", ["fetch", "--no-tags", "origin"]);
  expect(timeoutOf("fetch")).toBe(120_000);

  const { createPmCommitTool } = await import("../src/modules/pm/pm-commit.ts");
  const tool = createPmCommitTool({ requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10", worktree: "/repo", branch: "b", alive: () => true, checkPhaseActive: () => false,
    writeScope: () => ["src/"] });
  await (tool.execute as (id: string, params: unknown) => Promise<unknown>)("call", { paths: ["src/a.ts"], message: "提交" });
  expect(timeoutOf("commit")).toBe(120_000);

  const { searchTargetExcluded } = await import("../src/modules/agents/search-exclusion.ts");
  await searchTargetExcluded("/repo", "src");
  expect(timeoutOf("check-ignore")).toBe(10_000);
});
