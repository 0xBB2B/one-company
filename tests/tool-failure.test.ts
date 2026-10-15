import { expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  for (const patch of [{ cmd: undefined }, { code: "EOTHER" }, { stderr: undefined }, { stdout: undefined }]) {
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

test("命令输出摘要：真实触发的外部命令失败没有任何输出时写命令没有输出，不含整条命令行", async () => {
  const error = await inCleanRepo(async (cwd) => {
    await execFileAsync("git", ["checkout", "-q", "--detach"], { cwd });
    try { await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "symbolic-ref", "--quiet", "HEAD"], { cwd }); } catch (caught) { return caught; }
    throw new Error("命令没有失败");
  });
  expect(commandOutputTail(error)).toBe("命令没有输出");
});

test("命令输出摘要：手工拼的外部命令错误对象输出只有空白时写命令没有输出；不是外部命令的错误仍取消息", () => {
  expect(commandOutputTail(Object.assign(new Error("Command failed: tar -x"), { cmd: "tar -x", code: 2, stdout: " \n", stderr: "\t" }))).toBe("命令没有输出");
  expect(commandOutputTail(new Error("spawn tar ENOENT"))).toBe("spawn tar ENOENT");
});

const failureOf = async (file: string, args: string[], options: Parameters<typeof execFileAsync>[2] = {}) => {
  try { await execFileAsync(file, args, options); } catch (error) { return error; }
  throw new Error("命令没有失败");
};
const explained = (step: string, why: string, next: string) => `${step}失败。\n原因：${why}\n建议：${next}`;
const RETRY_ONCE_NEXT = "可以重试一次；仍然超时就把这段原因告诉用户";
const NO_RETRY_NEXT = "不要重试，把这段原因告诉用户";
const NOT_FOUND_NEXT = "确认工作目录还在；仍然失败就把这段原因告诉用户，可能需要安装这个程序";

test("真实触发：非零退出且没有输出", async () => {
  const error = await failureOf("sh", ["-c", "exit 3"]);
  expect(commandOutputTail(error)).toBe("命令没有输出");
  expect(failureText("跑脚本", error)).toBe(explained("跑脚本", "sh 命令失败（退出码 3）：命令没有输出", COMMAND_NEXT));
});

test("真实触发：超时且没有输出", async () => {
  const error = await failureOf("sleep", ["5"], { timeout: 200 });
  expect(commandOutputTail(error)).toBe("命令超时，被程序停止");
  expect(failureText("等待", error)).toBe(explained("等待", "sleep 命令超时，被程序停止", RETRY_ONCE_NEXT));
});

test("真实触发：超时但已有输出", async () => {
  const error = await failureOf("sh", ["-c", "echo 'Cloning into x...' >&2; sleep 30"], { timeout: 3000 });
  expect(commandOutputTail(error)).toBe("命令超时，被程序停止：Cloning into x...");
  expect(failureText("克隆", error)).toBe(explained("克隆", "sh 命令超时，被程序停止：Cloning into x...", RETRY_ONCE_NEXT));
});

test("真实触发：被外部信号杀掉", async () => {
  const error = await failureOf("sh", ["-c", "kill -9 $$"]);
  expect(commandOutputTail(error)).toBe("命令被信号 SIGKILL 停止");
  expect(failureText("跑脚本", error)).toBe(explained("跑脚本", "sh 命令被信号 SIGKILL 停止", UNCLASSIFIED_NEXT));
});

test("真实触发：输出超过读取上限，不附半截输出", async () => {
  const error = await failureOf("sh", ["-c", "yes | head -c 5000"], { maxBuffer: 100 });
  expect(commandOutputTail(error)).toBe("命令输出太多，超过程序的读取上限");
  expect(failureText("读日志", error)).toBe(explained("读日志", "sh 命令输出太多，超过程序的读取上限", NO_RETRY_NEXT));
});

test("真实触发：找不到程序", async () => {
  const error = await failureOf("pi-t-no-such-program", []);
  expect(commandOutputTail(error)).toBe("命令无法启动：找不到这个程序，或者工作目录不存在");
  expect(failureText("启动", error)).toBe(explained("启动", "pi-t-no-such-program 命令无法启动：找不到这个程序，或者工作目录不存在", NOT_FOUND_NEXT));
});

test("真实触发：工作目录不存在", async () => {
  const error = await failureOf("git", ["--version"], { cwd: "/tmp/pi-t-no-such-dir" });
  expect(commandOutputTail(error)).toBe("命令无法启动：找不到这个程序，或者工作目录不存在");
  expect(failureText("查版本", error)).toBe(explained("查版本", "git 命令无法启动：找不到这个程序，或者工作目录不存在", NOT_FOUND_NEXT));
});

test("真实触发：没有权限进入工作目录", async () => {
  const root = await mkdtemp("/tmp/pi-t-");
  const locked = `${root}/locked`;
  try {
    await mkdir(locked);
    await chmod(locked, 0o000);
    const error = await failureOf("git", ["--version"], { cwd: locked });
    expect(commandOutputTail(error)).toBe("命令无法启动：没有权限运行这个程序，或者没有权限进入工作目录");
    expect(failureText("查版本", error)).toBe(explained("查版本", "git 命令无法启动：没有权限运行这个程序，或者没有权限进入工作目录", NO_RETRY_NEXT));
  } finally {
    await chmod(locked, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("真实触发：命令被取消", async () => {
  const error = await failureOf("sleep", ["5"], { signal: AbortSignal.timeout(200) });
  expect(commandOutputTail(error)).toBe("命令被取消");
  expect(failureText("等待", error)).toBe(explained("等待", "sleep 命令被取消", "不要重试，等待用户或上级的下一步安排"));
});

test("手工拼的错误对象：超时的有输出与没输出两种写法", () => {
  const timeout = (output: { stdout: string; stderr: string }) => Object.assign(new Error("Command failed: git clone"), { cmd: "git clone u", code: null, killed: true, signal: "SIGTERM", ...output });
  expect(commandOutputTail(timeout({ stdout: "", stderr: " \n" }))).toBe("命令超时，被程序停止");
  expect(commandOutputTail(timeout({ stdout: "a\nb\nc\nd", stderr: "" }))).toBe("命令超时，被程序停止：b / c / d");
  expect(failureText("克隆", timeout({ stdout: "", stderr: "Cloning" }))).toBe(explained("克隆", "git 命令超时，被程序停止：Cloning", RETRY_ONCE_NEXT));
  expect(failureText("克隆", timeout({ stdout: "", stderr: "" }))).toBe(explained("克隆", "git 命令超时，被程序停止", RETRY_ONCE_NEXT));
});

test("手工拼的错误对象：外部信号的有输出与没输出两种写法", () => {
  const killed = (output: { stdout: string; stderr: string }) => Object.assign(new Error("Command failed: tar -x"), { cmd: "tar -x", code: null, killed: false, signal: "SIGKILL", ...output });
  expect(commandOutputTail(killed({ stdout: "", stderr: "" }))).toBe("命令被信号 SIGKILL 停止");
  expect(commandOutputTail(killed({ stdout: "", stderr: "half" }))).toBe("命令被信号 SIGKILL 停止：half");
  expect(failureText("解包", killed({ stdout: "x", stderr: "" }))).toBe(explained("解包", "tar 命令被信号 SIGKILL 停止：x", UNCLASSIFIED_NEXT));
  expect(failureText("解包", killed({ stdout: "", stderr: "" }))).toBe(explained("解包", "tar 命令被信号 SIGKILL 停止", UNCLASSIFIED_NEXT));
});

test("手工拼的错误对象：输出超限时即使 stdout 有半截也不附输出", () => {
  const error = Object.assign(new Error("m"), { cmd: "yes", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "y\ny\n", stderr: "" });
  expect(commandOutputTail(error)).toBe("命令输出太多，超过程序的读取上限");
  expect(failureText("读", error)).toBe(explained("读", "yes 命令输出太多，超过程序的读取上限", NO_RETRY_NEXT));
});

test("手工拼的错误对象：不在分类表里的情况仍按未归类处理", () => {
  const base = { cmd: "git x", stdout: "", stderr: "e" };
  for (const patch of [{ code: "EOTHER" }, { code: null }, { code: null, killed: false }]) {
    const error = Object.assign(new Error("boom"), base, patch);
    expect(failureText("s", error)).toBe(explained("s", "未归类的错误（boom）", UNCLASSIFIED_NEXT));
    expect(commandOutputTail(error)).toBe("e");
  }
});

test("手工拼的错误对象：缺 cmd 的超时、信号和找不到程序错误不归入外部命令分类", () => {
  for (const patch of [{ code: null, killed: true }, { code: null, signal: "SIGKILL" }, { code: "ENOENT" }]) {
    const error = Object.assign(new Error("boom"), { stdout: "", stderr: "e" }, patch);
    expect(failureText("s", error)).toBe(explained("s", "未归类的错误（boom）", UNCLASSIFIED_NEXT));
  }
});

test("带 advice 的超时错误仍用自带的原因与建议", () => {
  const error = Object.assign(new Error("x"), { cmd: "git x", code: null, killed: true, signal: "SIGTERM", stdout: "", stderr: "", advice });
  expect(failureText("s", error)).toBe(explained("s", advice.why, advice.next));
});

test("真实触发：输出按字节读取（encoding buffer）的命令失败同样按类别写原因，不带整条命令行", async () => {
  const exited = await inCleanRepo((cwd) => failureOf("git", ["-c", "core.fsmonitor=false", "cat-file", "blob", "deadbeef"], { cwd, encoding: "buffer" }));
  expect(commandOutputTail(exited)).toBe("fatal: Not a valid object name deadbeef");
  expect(failureText("读取文件", exited)).toBe(explained("读取文件", "git 命令失败（退出码 128）：fatal: Not a valid object name deadbeef", COMMAND_NEXT));
  const silent = await failureOf("sh", ["-c", "exit 3"], { encoding: "buffer" });
  expect(commandOutputTail(silent)).toBe("命令没有输出");
  const timedOut = await failureOf("sleep", ["5"], { timeout: 200, encoding: "buffer" });
  expect(failureText("读取文件", timedOut)).toBe(explained("读取文件", "sleep 命令超时，被程序停止", RETRY_ONCE_NEXT));
});
