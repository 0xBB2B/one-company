import { expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { Type } from "typebox";
import { AdvisedError, commandOutputTail, failureText, toolFailure, toolStep } from "../runtime/tool-failure.ts";
import { DaemonCallError } from "../runtime/daemon-client.ts";
import { toPiTool } from "../runtime/role-tools.ts";
import { errorData } from "../daemon/server.ts";

const advice = { why: "PM 租约已被新 PM 接管", next: "停止当前操作，等待主代理安排" };

test("错误文字只有哪一步失败、为什么、建议下一步，不含内部错误码", () => {
  const text = failureText("one_company_plan_manage 的 update 动作", new AdvisedError("stale_pm_lease", advice));
  expect(text).toBe("one_company_plan_manage 的 update 动作失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
  expect(text).not.toContain("stale_pm_lease");
});

test("经守护进程转发的错误从 data.advice 取原因与建议", () => {
  const text = failureText("派出 PM", new DaemonCallError("stale_pm_lease", "stale_pm_lease: 租约已换", { advice }));
  expect(text).toBe("派出 PM失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
});

test("没有原因与建议的错误也给出三段，原因带原始消息", () => {
  expect(failureText("读取", new Error("磁盘已满"))).toBe("读取失败。\n原因：未归类的错误（磁盘已满）\n建议：可以重试一次；仍然失败就把这段原因告诉用户");
});

test("步骤名取工具名与动作，参数包在 request 里或平铺都能取到", () => {
  expect(toolStep("one_company_plan_manage", { request: { action: "update" } })).toBe("one_company_plan_manage 的 update 动作");
  expect(toolStep("one_company_agent_manage", { action: "dispatch" })).toBe("one_company_agent_manage 的 dispatch 动作");
  expect(toolStep("one_company_git_deliver", { repoId: "a" })).toBe("one_company_git_deliver");
});

test("核心工具抛错时，模型拿到的是三段原因", async () => {
  const tool = toPiTool("plan_manage", "计划", Type.Object({}), {
    execute: () => { throw new AdvisedError("stale_pm_lease", advice); }, dispose: () => {},
  });
  const run = (tool.execute as (id: string, params: unknown) => Promise<unknown>)("t", { request: { action: "update" } });
  await expect(run).rejects.toThrow("one_company_plan_manage 的 update 动作失败。\n原因：PM 租约已被新 PM 接管\n建议：停止当前操作，等待主代理安排");
});

test("pi 给核心工具的取消信号原样传到工具实现", async () => {
  const execute = vi.fn(async () => ({}));
  const tool = toPiTool("verification_run", "验证", Type.Object({}), { execute, dispose: () => {} });
  const controller = new AbortController();
  await (tool.execute as (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>)("t", { action: "run" }, controller.signal);
  expect(execute).toHaveBeenCalledWith({ action: "run" }, controller.signal);
});

test("守护进程回错时把原因与建议放进 data.advice，客户端据此还原三段", () => {
  const data = errorData(new AdvisedError("stale_pm_lease", advice));
  expect(data).toEqual({ advice });
  expect(failureText("派出 PM", new DaemonCallError("stale_pm_lease", "x", data))).toContain("原因：PM 租约已被新 PM 接管");
});

test("外部命令失败只取报错最后几行，没有 stderr 时取消息", () => {
  const error = Object.assign(new Error("Command failed: git worktree add"), { stderr: "hint: a\nfatal: 'x' already exists\n\nerror: could not add\n" });
  expect(commandOutputTail(error, 2)).toBe("fatal: 'x' already exists / error: could not add");
  expect(commandOutputTail(new Error("spawn git ENOENT"))).toBe("spawn git ENOENT");
  expect(commandOutputTail(Object.assign(new Error("x"), { stderr: "e".repeat(400) }))).toHaveLength(301);
});

const execFileAsync = promisify(execFile);
const UNCLASSIFIED_NEXT = "可以重试一次；仍然失败就把这段原因告诉用户";
const COMMAND_NEXT = "根据命令输出判断：参数或文件写错就改正后再试；看不懂就把这段原因告诉用户";

async function inCleanRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp("/tmp/pi-t-");
  try {
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
    await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd });
    return await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
const failureOfCommand = (args: string[]) => inCleanRepo(async (cwd) => {
  try { await execFileAsync("git", args, { cwd }); } catch (error) { return error; }
  throw new Error("命令没有失败");
});

test("命令输出摘要：stderr 为空白时取 stdout，两者都空才取消息", () => {
  expect(commandOutputTail(Object.assign(new Error("m"), { stderr: " \n ", stdout: "a\nnothing to commit" }))).toBe("a / nothing to commit");
  expect(commandOutputTail(Object.assign(new Error("m"), { stderr: "", stdout: "" }))).toBe("m");
  expect(commandOutputTail(Object.assign(new Error("m"), { stderr: "err", stdout: "out" }))).toBe("err");
  expect(commandOutputTail(Object.assign(new Error("m"), { stderr: "", stdout: "l1\nl2\nl3\nl4" }))).toBe("l2 / l3 / l4");
});

test("真实触发的外部命令失败（输出在 stderr）：原因写程序名、退出码和命令输出，不含整条命令行", async () => {
  const error = await failureOfCommand(["--literal-pathspecs", "-c", "commit.gpgsign=false", "commit", "--only", "-m", "秘密提交说明", "--", "missing.ts"]);
  const text = failureText("提交", error);
  expect(text).toContain("提交失败。\n原因：git 命令失败（退出码 1）：");
  expect(text).toContain("pathspec");
  expect(text).toContain(`建议：${COMMAND_NEXT}`);
  for (const leaked of ["Command failed", "--literal-pathspecs", "-c", "秘密提交说明"]) expect(text.split("\n原因：")[1]!.split("\n建议：")[0]).not.toContain(leaked);
  expect(text).not.toContain("重试一次");
});

test("真实触发的外部命令失败（输出在 stdout，stderr 为空）：原因取 stdout", async () => {
  const error = await failureOfCommand(["commit", "-m", "秘密提交说明"]);
  expect((error as { stderr: string }).stderr.trim()).toBe("");
  const text = failureText("提交", error);
  expect(text).toContain("原因：git 命令失败（退出码 1）：");
  expect(text).toContain("nothing");
  expect(text).not.toContain("Command failed");
  expect(text).not.toContain("秘密提交说明");
});

test("toolFailure 的消息与 failureText 一致，外部命令失败同样不带整条命令行", async () => {
  const error = await failureOfCommand(["commit", "-m", "秘密提交说明"]);
  const failure = toolFailure("提交", error);
  expect(failure.message).toBe(failureText("提交", error));
  expect(failure.message).not.toContain("Command failed");
});

test("手工拼的外部命令错误对象：程序名取 cmd 的第一个词", () => {
  const error = Object.assign(new Error("Command failed: tar -x"), { cmd: "tar -x -f a.tar", code: 2, stdout: "", stderr: "tar: bad archive\n" });
  expect(failureText("解包", error)).toBe(`解包失败。\n原因：tar 命令失败（退出码 2）：tar: bad archive\n建议：${COMMAND_NEXT}`);
});

test("缺少 cmd、退出码不是数字或输出不是字符串的错误仍按未归类处理", () => {
  const base = { cmd: "git x", code: 1, stdout: "", stderr: "e" };
  for (const patch of [{ cmd: undefined }, { code: "ENOENT" }, { stderr: undefined }, { stdout: undefined }]) {
    const error = Object.assign(new Error("boom"), base, patch);
    expect(failureText("s", error)).toBe(`s失败。\n原因：未归类的错误（boom）\n建议：${UNCLASSIFIED_NEXT}`);
  }
});

test("普通 Error 和字符串仍写未归类的错误", () => {
  expect(failureText("s", new Error("Command failed: git x"))).toBe(`s失败。\n原因：未归类的错误（Command failed: git x）\n建议：${UNCLASSIFIED_NEXT}`);
  expect(failureText("s", "坏了")).toBe(`s失败。\n原因：未归类的错误（坏了）\n建议：${UNCLASSIFIED_NEXT}`);
});

test("带 data.advice 的外部命令错误仍用自带的原因与建议", () => {
  const error = Object.assign(new Error("x"), { cmd: "git x", code: 1, stdout: "", stderr: "e", data: { advice } });
  expect(failureText("s", error)).toBe(`s失败。\n原因：${advice.why}\n建议：${advice.next}`);
});

test("真实触发的外部命令失败（stdout、stderr 都为空）：原因写命令没有输出，不含整条命令行", async () => {
  const error = await inCleanRepo(async (cwd) => {
    await execFileAsync("git", ["checkout", "-q", "--detach"], { cwd });
    try { await execFileAsync("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "symbolic-ref", "--quiet", "HEAD"], { cwd }); } catch (caught) { return caught; }
    throw new Error("命令没有失败");
  });
  expect((error as { stdout: string }).stdout.trim()).toBe("");
  expect((error as { stderr: string }).stderr.trim()).toBe("");
  expect((error as { code: number }).code).toBe(1);
  const text = failureText("读取分支", error);
  expect(text).toBe(`读取分支失败。\n原因：git 命令失败（退出码 1）：命令没有输出\n建议：${COMMAND_NEXT}`);
  for (const leaked of ["Command failed", "-c", "--literal-pathspecs", "symbolic-ref --quiet HEAD"]) expect(text).not.toContain(leaked);
});

test("手工拼的外部命令错误对象：输出只有空白时同样写命令没有输出", () => {
  const error = Object.assign(new Error("Command failed: tar -x -f a.tar"), { cmd: "tar -x -f a.tar", code: 2, stdout: " \n", stderr: "\t" });
  expect(failureText("解包", error)).toBe(`解包失败。\n原因：tar 命令失败（退出码 2）：命令没有输出\n建议：${COMMAND_NEXT}`);
});
