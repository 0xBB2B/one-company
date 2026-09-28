import { expect, test } from "vitest";
import rulesExtension from "../extensions/rules.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const start = async (pi: ReturnType<typeof createFakePi>) =>
  (await pi.handlersFor("before_agent_start")[0]!({ type: "before_agent_start", systemPrompt: "BASE" }, {} as never)) as { systemPrompt: string };

test("主会话系统提示附上当前窗口已接入仓库的路径与 repoId，主代理不必自行计算", async () => {
  const pi = createFakePi();
  const repoId = "a".repeat(64);
  rulesExtension(pi.pi, { windowContext: () => ({ workspace: { repos: [{ path: "/work/game", repoId, commonDir: "/work/game/.git" }], skipped: [] } }) });
  const { systemPrompt } = await start(pi);
  expect(systemPrompt.startsWith("BASE\n\n## 主会话职责")).toBe(true);
  expect(systemPrompt).toContain(`## 当前窗口已接入的仓库\n调用需要 repoId 的工具时使用下列编号，不要自行计算：\n- /work/game → repoId ${repoId}`);
});

test("窗口尚未启动时只附规则，不编造仓库", async () => {
  const pi = createFakePi();
  rulesExtension(pi.pi, { windowContext: () => { throw new Error("窗口未启动"); } });
  const { systemPrompt } = await start(pi);
  expect(systemPrompt).toContain("## 主会话职责");
  expect(systemPrompt).not.toContain("当前窗口已接入的仓库");
});

test("M8A-AC7：主会话规则要求先请用户批准草稿，需求生效后再建工作区、派 PM", async () => {
  const pi = createFakePi();
  rulesExtension(pi.pi, { windowContext: () => { throw new Error("窗口未启动"); } });
  const { systemPrompt } = await start(pi);
  const approve = systemPrompt.indexOf("confirmUpdate 登记"), prepare = systemPrompt.indexOf("workspace-prepare"), dispatch = systemPrompt.indexOf("role=pm");
  expect(approve).toBeGreaterThan(0);
  expect(prepare).toBeGreaterThan(approve);
  expect(dispatch).toBeGreaterThan(prepare);
  expect(systemPrompt).not.toContain("在请用户批准之前");
});

test("M8A-AC9：主会话规则写明草稿五大板块及固定编号，按背景、需求、功能、实现、验收的顺序", async () => {
  const pi = createFakePi();
  rulesExtension(pi.pi, { windowContext: () => { throw new Error("窗口未启动"); } });
  const { systemPrompt } = await start(pi);
  const positions = ["## 背景 {#background}", "## 需求 {#requirements}", "## 功能 {#features}", "## 实现 {#implementation}", "## 验收 {#acceptance}"]
    .map((heading) => systemPrompt.indexOf(heading));
  expect(positions.every((position) => position > 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(systemPrompt).toContain("由 PM 规划");
});
