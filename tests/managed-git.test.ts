import { afterEach, expect, test } from "vitest";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClock } from "../runtime/clock.ts";
import { uuidv7 } from "../runtime/database.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { createRangeProtection } from "../runtime/range-protection.ts";
import { createManagedBashOperations } from "../runtime/shell-bash.ts";
import { createGitCommitTool } from "../runtime/git-commit-tool.ts";
import { RunStore } from "../runtime/run-store.ts";
import { ShellRegistry } from "../runtime/shell-registry.ts";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { initializeHostGit } from "../runtime/git-runtime.mjs";

initializeHostGit([]);

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function world(linked = false, main = false) {
  const repo = await createRepoFixture();
  cleanups.push(() => removeRepoFixture(repo));
  const cwd = linked ? (await addWorktree(repo)).root : repo.root;
  const home = await createTempHome();
  cleanups.push(() => removeTempHome(home));
  await runGit(["config", "user.name", "Managed test"], cwd);
  await runGit(["config", "user.email", "managed@example.com"], cwd);
  await writeFile(join(cwd, "foreign.txt"), "foreign original\n");
  await runGit(["add", "foreign.txt"], cwd);
  await runGit(["commit", "-m", "seed"], cwd);
  const clock = createClock();
  cleanups.push(() => clock.stopGapWatcher());
  const shells = new ShellRegistry({ clock });
  const repoId = (await repositoryIdentity(cwd)).repoId;
  const runs = new RunStore({ dataRoot: home.dataRoot, repoId, daemonStartedAt: "managed-git-test" });
  async function run(paths: string[]) {
    const record = await runs.create({ kind: "role", standalone: true, role: "pi-company.implementer", requirement: "2026-09-10.git", task: "git", cwd, writePaths: paths, readPaths: [cwd], model: { provider: "test", id: "test" }, thinking: "off", mcp: [] });
    await runs.update(record.id, { state: "running" });
    return record;
  }
  const own = await run(["README.md", "new.txt"]);
  const foreign = await run(["foreign.txt"]);
  const holder = main ? { kind: "main" as const, windowId: uuidv7() } : { kind: "role" as const, runId: own.id, requirement: own.requirement };
  const guard = await createRangeProtection({ cwd, dataRoot: home.dataRoot, holder, writePaths: main ? [cwd] : own.writePaths, clock, shells });
  cleanups.push(async () => {
    for (const task of shells.list()) if (["starting", "running", "stopping", "uncertain"].includes(task.status)) await shells.stop(task.taskId);
    await runs.update(own.id, { state: "completed" });
    await guard.release();
  });
  const other = await createRangeProtection({ cwd, dataRoot: home.dataRoot, holder: { kind: "role", runId: foreign.id, requirement: foreign.requirement }, writePaths: ["foreign.txt"], clock, shells });
  cleanups.push(async () => { await runs.update(foreign.id, { state: "completed" }); await other.release(); });
  expect((await other.checkWrite("foreign.txt")).ok).toBe(true);
  const operations = createManagedBashOperations({ registry: shells, host: { kind: holder.kind, id: holder.runId ?? holder.windowId!, runId: holder.runId }, runToken: uuidv7(), guard: guard.commandGuard });
  async function shell(command: string) {
    let output = "";
    const result = await operations.exec(command, cwd, { timeout: 10, onData: (data) => { output += data.toString(); } });
    return { ...result, output };
  }
  const tool = createGitCommitTool(async () => guard.commit);
  const commit = (paths: string[], message = "fix: own change") => tool.execute("commit", { paths, message }, undefined, undefined, { cwd } as never);
  return { cwd, foreign, guard, other, shell, commit, shells };
}

test.each([false, true])("真实 Shell 在修改前阻止提交、切换、重置和脚本绕行，linked=%s", async (linked) => {
  const w = await world(linked);
  await writeFile(join(w.cwd, "foreign.txt"), "foreign staged\n");
  await runGit(["add", "foreign.txt"], w.cwd);
  await writeFile(join(w.cwd, "README.md"), "own modified\n");
  const head = await runGit(["rev-parse", "HEAD"], w.cwd);
  const branch = await runGit(["symbolic-ref", "HEAD"], w.cwd);
  const index = (await runGit(["rev-parse", "--path-format=absolute", "--git-path", "index"], w.cwd)).trim();
  const beforeIndex = await readFile(index);
  const common = (await repositoryIdentity(w.cwd)).commonDir;
  const commands = [
    "git add README.md && git commit -m mixed",
    "git commit -am mixed",
    "git switch -c forbidden",
    "git checkout -b forbidden",
    "git reset --hard HEAD~1",
    "git -c alias.change='switch -c forbidden' change",
    "sh -c 'git switch -c forbidden'",
    `printf broken > '${common}/config'`,
    `git --git-dir='${common}' update-ref refs/heads/forbidden HEAD`,
  ];
  for (const command of commands) {
    const result = await w.shell(command);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(w.foreign.id);
    expect(await runGit(["rev-parse", "HEAD"], w.cwd)).toBe(head);
    expect(await runGit(["symbolic-ref", "HEAD"], w.cwd)).toBe(branch);
    expect(await readFile(index)).toEqual(beforeIndex);
    expect(await readFile(join(w.cwd, "README.md"), "utf8")).toBe("own modified\n");
    expect(await readFile(join(w.cwd, "foreign.txt"), "utf8")).toBe("foreign staged\n");
  }
  expect((await w.shell("git status --porcelain && git diff --stat")).exitCode).toBe(0);
  expect((await runGit(["branch", "--list", "forbidden"], w.cwd)).trim()).toBe("");
}, 30_000);

test.each([false, true])("受管提交只包含指定文件，保留他人部分暂存，main=%s", async (main) => {
  const w = await world(false, main);
  await writeFile(join(w.cwd, "foreign.txt"), "foreign staged\n");
  await runGit(["add", "foreign.txt"], w.cwd);
  await writeFile(join(w.cwd, "foreign.txt"), "foreign unstaged\n");
  await writeFile(join(w.cwd, "README.md"), "own updated\n");
  await writeFile(join(w.cwd, "new.txt"), "new content\n");
  const staged = await runGit(["diff", "--cached", "--binary", "--", "foreign.txt"], w.cwd);
  const working = await readFile(join(w.cwd, "foreign.txt"));
  await w.commit(["README.md", "new.txt"]);
  expect((await runGit(["show", "--format=", "--name-only", "HEAD"], w.cwd)).trim().split("\n")).toEqual(["README.md", "new.txt"]);
  expect(await runGit(["diff", "--cached", "--binary", "--", "foreign.txt"], w.cwd)).toBe(staged);
  expect(await readFile(join(w.cwd, "foreign.txt"))).toEqual(working);
  expect((await runGit(["status", "--porcelain", "--", "README.md", "new.txt"], w.cwd)).trim()).toBe("");
  expect(w.shells.list().length).toBe(2);
}, 15_000);

test("linked worktree 提交更新本分支且保留公共仓库分支", async () => {
  const w = await world(true);
  const mainHead = await runGit(["rev-parse", "main"], w.cwd);
  await writeFile(join(w.cwd, "README.md"), "linked change\n");
  await w.commit(["README.md"]);
  expect(await runGit(["rev-parse", "main"], w.cwd)).toBe(mainHead);
  expect((await runGit(["show", "HEAD:README.md"], w.cwd)).trim()).toBe("linked change");
}, 15_000);

test("主会话不能直接编辑 Git 元数据或经符号链接绕行，也不能提交他人文件", async () => {
  const w = await world(false, true);
  const common = (await repositoryIdentity(w.cwd)).commonDir;
  await symlink(common, join(w.cwd, "git-alias"));
  for (const path of [".git/HEAD", ".git/config", "git-alias/HEAD"]) expect((await w.guard.checkWrite(path)).ok).toBe(false);
  expect((await w.shell("printf broken > git-alias/HEAD")).exitCode).not.toBe(0);
  await writeFile(join(w.cwd, "foreign.txt"), "foreign change\n");
  const head = await runGit(["rev-parse", "HEAD"], w.cwd);
  await expect(w.commit(["foreign.txt"])).rejects.toThrow();
  await expect(w.commit([".git/HEAD"])).rejects.toThrow();
  expect(await runGit(["rev-parse", "HEAD"], w.cwd)).toBe(head);
}, 15_000);

test("hook 和 filter 无法利用受管提交执行越界操作，失败不绕过 hook", async () => {
  const w = await world();
  const common = (await repositoryIdentity(w.cwd)).commonDir;
  const head = await runGit(["rev-parse", "HEAD"], w.cwd);
  const hook = join(common, "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\ngit switch -c hook-escape\nprintf escape > foreign.txt\n");
  await chmod(hook, 0o755);
  await writeFile(join(w.cwd, "README.md"), "own change\n");
  await expect(w.commit(["README.md"])).rejects.toThrow();
  expect(await runGit(["rev-parse", "HEAD"], w.cwd)).toBe(head);
  expect((await runGit(["branch", "--list", "hook-escape"], w.cwd)).trim()).toBe("");
  expect(await readFile(join(w.cwd, "foreign.txt"), "utf8")).toBe("foreign original\n");
  await rm(hook);
  await writeFile(join(w.cwd, ".gitattributes"), "README.md filter=escape\n");
  await runGit(["config", "filter.escape.clean", "printf escape > foreign.txt; cat"], w.cwd);
  await runGit(["config", "filter.escape.required", "true"], w.cwd);
  await expect(w.commit(["README.md"])).rejects.toThrow();
  expect(await readFile(join(w.cwd, "foreign.txt"), "utf8")).toBe("foreign original\n");
  expect(await runGit(["rev-parse", "HEAD"], w.cwd)).toBe(head);
}, 15_000);

test("重命名必须同时授权两端，删除与新建可通过受管提交完成", async () => {
  const w = await world();
  await runGit(["mv", "README.md", "new.txt"], w.cwd);
  const head = await runGit(["rev-parse", "HEAD"], w.cwd);
  await expect(w.commit(["new.txt"])).rejects.toThrow("重命名");
  expect(await runGit(["rev-parse", "HEAD"], w.cwd)).toBe(head);
  await w.commit(["README.md", "new.txt"]);
  expect((await runGit(["show", "--format=", "--name-status", "HEAD"], w.cwd)).trim()).toBe("R100\tREADME.md\tnew.txt");
  await rm(join(w.cwd, "new.txt"));
  await w.commit(["new.txt"]);
  expect((await runGit(["show", "--format=", "--name-status", "HEAD"], w.cwd)).trim()).toBe("D\tnew.txt");
}, 15_000);

test("路径按字面量处理，提交信息不会执行 Shell 替换", async () => {
  const w = await world(false, true);
  const path = ":(glob)*.txt";
  await writeFile(join(w.cwd, path), "literal\n");
  await writeFile(join(w.cwd, "other.txt"), "unselected\n");
  const message = "fix: literal\n\n$(touch injection) `touch injection`";
  await w.commit([path], message);
  expect((await runGit(["show", "--format=", "--name-only", "HEAD"], w.cwd)).trim()).toBe(path);
  expect((await runGit(["show", "-s", "--format=%B", "HEAD"], w.cwd)).trim()).toBe(message);
  await expect(readFile(join(w.cwd, "injection"))).rejects.toThrow();
  expect((await runGit(["status", "--porcelain", "--", "other.txt"], w.cwd)).trim()).toBe("?? other.txt");
}, 15_000);

test("真实并发提交遇 Git 锁时可安全重试，各提交不夹带其他范围", async () => {
  const w = await world();
  await writeFile(join(w.cwd, "README.md"), "own concurrently\n");
  await writeFile(join(w.cwd, "foreign.txt"), "foreign concurrently\n");
  const attempts = [() => w.commit(["README.md"], "own concurrent"), () => w.other.commit(["foreign.txt"], "foreign concurrent")];
  const results = await Promise.allSettled(attempts.map((attempt) => attempt()));
  for (let i = 0; i < results.length; i++) if (results[i]!.status === "rejected") await attempts[i]!();
  const changes = (await runGit(["log", "-2", "--format=", "--name-only"], w.cwd)).trim().split(/\n+/).sort();
  expect(changes).toEqual(["README.md", "foreign.txt"]);
  expect((await runGit(["status", "--porcelain"], w.cwd)).trim()).toBe("");
}, 15_000);

test("硬链接不能把共享 Git 文件映射到获准路径后写入", async () => {
  const w = await world();
  const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], w.cwd)).trim();
  const head = await readFile(join(gitDir, "HEAD"));
  const result = await w.shell(`ln '${gitDir}/HEAD' new.txt && printf broken > new.txt`);
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(join(gitDir, "HEAD"))).toEqual(head);
}, 15_000);

test("从会话子目录选择文件时按调用目录解析且取消不暂存", async () => {
  const w = await world(false, true);
  const { mkdir } = await import("node:fs/promises");
  const cwd = join(w.cwd, "src");
  await mkdir(cwd);
  await writeFile(join(cwd, "file.txt"), "subdirectory\n");
  const tool = createGitCommitTool(async () => w.guard.commit);
  const signal = AbortSignal.abort();
  await expect(tool.execute("cancel", { paths: ["file.txt"], message: "cancel" }, signal, undefined, { cwd } as never)).rejects.toThrow("aborted");
  expect((await runGit(["diff", "--cached", "--name-only"], w.cwd)).trim()).toBe("");
  await tool.execute("commit", { paths: ["file.txt"], message: "subdirectory" }, undefined, undefined, { cwd } as never);
  expect((await runGit(["show", "--format=", "--name-only", "HEAD"], w.cwd)).trim()).toBe("src/file.txt");
}, 15_000);
