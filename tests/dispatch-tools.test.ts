import { afterEach, describe, expect, test, vi } from "vitest";
import { Value } from "typebox/value";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { registerDispatchTools, default as dispatchExtension } from "../extensions/dispatch.ts";
import { collectGitSnapshot } from "../runtime/git-snapshot.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { validateParams } from "../runtime/protocol.ts";
import { uuidv7 } from "../runtime/database.ts";
import { addWorktree, createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const exec = promisify(execFile);
const SECRET = "/private/old-target/" + "旧正文".repeat(2000);
async function repo() { const r = await createRepoFixture(); cleanup.push(() => removeRepoFixture(r)); return Object.assign(r, await repositoryIdentity(r.root)); }
function harness(entries: Array<{ repoId: string; path: string; call: (...args: any[]) => any }> = []) {
  const clients = new Map<string, any>();
  for (const e of entries) if (!clients.has(e.repoId)) clients.set(e.repoId, { call: vi.fn(async (method, params) => { validateParams(method, params); return e.call(method, params); }) });
  const tools: any[] = [];
  const context = vi.fn(() => ({ windowId: "test", workspace: { repos: entries.map((e) => ({ ...e, commonDir: join(e.path, ".git") })), skipped: [] }, clients: { forRepo: (id: string) => clients.get(id), all: () => [...clients.values()], skipped: () => [], closeAll() {} } }));
  registerDispatchTools({ registerTool: (tool: any) => tools.push(tool) } as any, context);
  const execute = (params: any, cwd = "/", signal?: AbortSignal) => tools[0].execute("test", params, signal, undefined, { cwd });
  return { tools, context, clients, execute };
}
const text = (r: any) => r.content.map((p: any) => p.text).join("\n");

describe("旧派工入口永久删除", () => {
  test("D01 只注册状态与安全停止工具，不注册旧派工回复转发或隐藏 renderer", () => {
    const h = harness(); expect(dispatchExtension.length).toBe(1);
    expect(h.tools.map((t) => t.name)).toEqual(["pi_company_agents"]);
    expect(h.tools[0].renderCall).toBeUndefined(); expect(h.tools[0].renderResult).toBeUndefined();
    for (const action of ["list", "status", "pause", "stop", "pauseAll", "stopAll"]) expect(Value.Check(h.tools[0].parameters, { action })).toBe(true);
    for (const extra of [{ actor: "user" }, { role: "main" }, { requirementId: "fake" }, { extra: 1 }]) expect(Value.Check(h.tools[0].parameters, { action: "list", ...extra })).toBe(false);
  });
  test.each(["dispatch", "review", "reply", "forward", "resume", "resumeAll", "resumeInterrupted", "unknown"])("D02 %s 直接 execute 也拒绝且不触达连接", async (action) => {
    const h = harness(); const r = await h.execute({ action, runId: "old", actor: "user", message: SECRET });
    expect(Value.Check(h.tools[0].parameters, { action })).toBe(false);
    expect(r.details.isError).toBe(true); expect(text(r)).toContain("永久淘汰"); expect(text(r)).not.toContain(SECRET); expect(h.context).not.toHaveBeenCalled();
  });
});

describe("保留状态与停止回执", () => {
  test("D03 list 多仓部分失败如实报错，保留成功元数据且不泄漏失败正文", async () => {
    const a = uuidv7(); const b = uuidv7(); const coverage = { unconfirmedOutsidePage: 0 };
    const h = harness([{ repoId: "a", path: "/nested/repo-a", call: () => ({ items: [{ id: a, state: "running", task: SECRET }], coverage }) }, { repoId: "b", path: "/other/repo-b", call: () => { throw new Error(SECRET); } }]);
    const r = await h.execute({ action: "list" }); expect(r.details.isError).toBe(true);
    expect(text(r)).toContain(`repo-a: ${a}(运行中)`); expect(r.details.coverage).toMatchObject({ returned: 1, unknown: 1, repositories: 2, truncated: true }); expect(text(r)).not.toContain(SECRET); expect(text(r).length).toBeLessThan(500);
    h.clients.get("b").call.mockResolvedValue({ items: [{ id: b, state: "paused" }], coverage });
    const reachable = await h.execute({ action: "list" }); expect(reachable.details.isError).toBe(false); expect(text(reachable)).toContain(`repo-a: ${a}(运行中)`); expect(text(reachable)).toContain(`repo-b: ${b}(已暂停)`); expect(reachable.details.coverage).toMatchObject({ returned: 2, unknown: 0, remaining: 0 });
  });
  test("D04 全部不可达不是无运行，异常 URL 和非 Error 不进入输出", async () => {
    const h = harness([{ repoId: "a", path: "/repo", call: () => { throw "https://user:secret@example.invalid/旧正文"; } }]);
    const r = await h.execute({ action: "list" }); expect(r.details.isError).toBe(true); expect(text(r)).not.toContain("无运行"); expect(text(r)).not.toContain("https");
  });
  test("D05 同 repoId 的真实 worktree 广播只一次，按真实 confirmed 计数", async () => {
    const r = await repo(); const wt = await addWorktree(r);
    const call = () => ({ results: [{ confirmed: true }, { confirmed: true }, { confirmed: false }] });
    const h = harness([{ repoId: r.repoId, path: r.root, call }, { repoId: r.repoId, path: wt.root, call }]);
    const result = await h.execute({ action: "pauseAll" }); expect(result.details.isError).toBe(true);
    expect(text(result)).toContain(`${basename(wt.root)}: 已确认=2，未确认=1，未知=0`); expect(result.details.coverage).toMatchObject({ remaining: 0, hasUnconfirmed: true }); expect(h.clients.get(r.repoId).call).toHaveBeenCalledTimes(1);
    const id = uuidv7(); h.clients.get(r.repoId).call.mockClear().mockResolvedValue({ items: [{ id, state: "running" }], coverage: { unconfirmedOutsidePage: 0 } });
    const listed = await h.execute({ action: "list" }); expect(text(listed).split(id)).toHaveLength(2); expect(listed.details.coverage).toMatchObject({ repositories: 1, returned: 1, unknown: 0 }); expect(h.clients.get(r.repoId).call).toHaveBeenCalledTimes(1);
  });
  test("D06 仓库名数字不影响计数，多仓 stopAll 不合并或重复", async () => {
    const h = harness([3, 5].map((n) => ({ repoId: String(n), path: `/repo-${n}${n}`, call: () => ({ results: [{ confirmed: true }], coverage: { confirmed: n, unconfirmed: 0, unknown: 0, shellUnconfirmed: 0, returned: 1, remaining: n - 1, truncated: true } }) })));
    const r = await h.execute({ action: "stopAll" }); expect(r.details.isError).toBe(false);
    expect(text(r)).toContain("repo-33: 已确认=3，未确认=0，未知=0；repo-55: 已确认=5，未确认=0，未知=0"); expect(r.details.coverage).toMatchObject({ hasUnconfirmed: false });
    for (const c of h.clients.values()) expect(c.call).toHaveBeenCalledOnce();
  });
  test.each(["status", "pause", "stop"])("D07 %s 核验 cwd 仓库身份，拒绝相对路径和外仓", async (action) => {
    const a = await repo(); const b = await repo(); const h = harness([{ repoId: a.repoId, path: a.root, call: () => ({ state: "stopped", confirmed: true }) }]);
    for (const cwd of [".", "../x", b.root]) { const r = await h.execute({ action, runId: "run-1", cwd }, a.root); expect(r.details.isError).toBe(true); }
    expect(h.clients.get(a.repoId).call).not.toHaveBeenCalled();
    expect((await h.execute({ action }, a.root)).details.isError).toBe(true);
  });
  test.each(["pause", "stop"])("D08 %s 不把未确认请求说成成功", async (action) => {
    const r = await repo(); let confirmed = false;
    const h = harness([{ repoId: r.repoId, path: r.root, call: () => ({ state: action === "stop" ? "stopped" : "paused", confirmed }) }]);
    const first = await h.execute({ action, runId: "run-1" }, r.root); expect(first.details.isError).toBe(true); expect(text(first)).toContain("尚未确认");
    confirmed = true; const second = await h.execute({ action, runId: "run-1" }, r.root); expect(second.details.isError).toBe(false); expect(text(second)).toBe(action === "stop" ? "已停止" : "已暂停");
  });
  test("D09 status 仅状态，未知状态和异常正文不回显", async () => {
    const r = await repo(); let fail = false;
    const h = harness([{ repoId: r.repoId, path: r.root, call: () => { if (fail) throw new Error(SECRET); return { run: { state: SECRET, result: SECRET } }; } }]);
    expect(text(await h.execute({ action: "status", runId: "run" }, r.root))).toBe("登记状态：未知状态；旧状态不证明当前验收通过或进程已停止");
    h.clients.get(r.repoId).call.mockResolvedValueOnce({ run: { state: "completed" } });
    expect(text(await h.execute({ action: "status", runId: "run" }, r.root))).toBe("登记状态：已完成；旧状态不证明当前验收通过或进程已停止");
    fail = true;
    for (const action of ["status", "pause", "stop"]) { const failed = await h.execute({ action, runId: "run" }, r.root); expect(failed.details.isError).toBe(true); expect(text(failed)).not.toContain(SECRET); expect(text(failed).length).toBeLessThan(500); }
  });
  test("D10 初次多仓list取消保留成功元数据和固定等待回执，不回显迟到正文", async () => {
    const ids = Array.from({ length: 100 }, () => uuidv7()); const repoName = '"'.repeat(128);
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }); let resolveCall!: (value: any) => void;
    const h = harness([
      { repoId: "a", path: `/${repoName}`, call: () => ({ items: ids.map((id) => ({ id, state: "running" })), total: ids.length, coverage: { total: ids.length, unconfirmedOutsidePage: 0 } }) },
      { repoId: "b", path: "/repo-b", call: () => { started(); return new Promise((resolve) => { resolveCall = resolve; }); } },
    ]);
    const controller = new AbortController(); const pending = h.execute({ action: "list" }, "/", controller.signal);
    await ready; const start = Date.now(); controller.abort(); const r = await pending; resolveCall({ items: [{ id: SECRET, state: SECRET }] });
    expect(Date.now() - start).toBeLessThan(1000); expect(r.details.isError).toBe(true);
    expect(text(r)).toContain(`${repoName}: ${ids[0]}(运行中)`); expect(text(r)).toContain("已停止等待，守护进程可能仍在执行，请用 agents list 核对");
    expect(text(r)).not.toContain(SECRET); expect(text(r)).not.toContain("守护进程已停止"); expect(r.details.coverage).toMatchObject({ unknown: 1, repositories: 2, truncated: true });
    expect(r.details.coverage.returned).toBeGreaterThan(0); expect(r.details.coverage.returned).toBeLessThanOrEqual(ids.length);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(16384); for (const client of h.clients.values()) expect(client.call).toHaveBeenCalledOnce();
  });
  test("D10 全局offset触发的localOffset再请求取消也保留固定回执且不重试", async () => {
    const id = uuidv7(); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let resolveCall!: (value: any) => void;
    const h = harness([{ repoId: "a", path: "/repo-a", call: (_method, params) => {
      if (params.offset === 0) return { items: [{ id, state: "running" }], total: 2, coverage: { total: 2, unconfirmedOutsidePage: 1 } };
      started(); return new Promise((resolve) => { resolveCall = resolve; });
    } }]);
    const controller = new AbortController(); const pending = h.execute({ action: "list", limit: 1, offset: 1 }, "/", controller.signal);
    await ready; const start = Date.now(); controller.abort(); const r = await pending; resolveCall({ items: [{ id: SECRET, state: SECRET }], total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Date.now() - start).toBeLessThan(1000); expect(r.details.isError).toBe(true); expect(text(r)).toContain("已停止等待，守护进程可能仍在执行，请用 agents list 核对");
    expect(text(r)).not.toContain(SECRET); expect(r.details.coverage).toMatchObject({ returned: 0, unknown: 1, total: 2, offset: 1, nextOffset: null, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(16384); expect(h.clients.get("a").call).toHaveBeenCalledTimes(2);
  });
});

describe("展示覆盖与未知状态", () => {
  test("D15 list合法分页展示页外未确认，坏身份/状态/缺coverage不能假称完整", async () => {
    const ids = [uuidv7(), uuidv7()];
    const h = harness([{ repoId: "a", path: "/repo-a", call: () => ({ items: ids.map((id) => ({ id, state: "stopped" })), coverage: { unconfirmedOutsidePage: 103 } }) }]);
    const r = await h.execute({ action: "list", limit: 1 }); expect(r.details.isError).toBe(false);
    expect(r.details.coverage).toMatchObject({ returned: 1, validated: 2, remaining: 104, unknown: 0, truncated: true }); expect(text(r)).toContain("状态不证明进程已停");
    expect(h.clients.get("a").call).toHaveBeenCalledWith("runs.list", { limit: 1, offset: 0 });
    h.clients.get("a").call.mockResolvedValue({ items: [{ id: SECRET, state: "running" }, { id: uuidv7(), state: SECRET }, { id: ids[0], state: "failed" }] });
    const bad = await h.execute({ action: "list" }); expect(bad.details.isError).toBe(true); expect(bad.details.coverage).toMatchObject({ returned: 1, unknown: 3, truncated: true }); expect(text(bad)).not.toContain(SECRET);
    for (const params of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { offset: -1 }]) {
      h.context.mockClear(); const rejected = await h.execute({ action: "list", ...params }); expect(rejected.details.isError).toBe(true); expect(h.context).not.toHaveBeenCalled();
    }
  });
  test("D16 stopAll以全部coverage计未确认/未知而非results非空判成功", async () => {
    const h = harness([{ repoId: "a", path: "/repo-a", call: () => ({ results: [{ confirmed: true }], coverage: { confirmed: 104, unconfirmed: 1, unknown: 2, shellUnconfirmed: 1 } }) }]);
    const r = await h.execute({ action: "stopAll" }); expect(r.details.isError).toBe(true); expect(text(r)).toContain("已确认=104，未确认=2，未知=2"); expect(r.details.coverage).toMatchObject({ hasUnconfirmed: true });
  });
  test("D17 status请求取消保留停止等待回执，不暗示后台进程结束", async () => {
    const r = await repo(); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }); let done!: (value: any) => void;
    const h = harness([{ repoId: r.repoId, path: r.root, call: () => { started(); return new Promise((resolve) => { done = resolve; }); } }]);
    const controller = new AbortController(); const pending = h.execute({ action: "status", runId: uuidv7() }, r.root, controller.signal);
    await ready; const start = Date.now(); controller.abort(); const result = await pending; done({ run: { state: "stopped" } });
    expect(Date.now() - start).toBeLessThan(1000); expect(result.details.isError).toBe(true); expect(text(result)).toContain("已停止等待"); expect(text(result)).toContain("可能仍在执行");
  });
});

describe("派审夹具下的通用 Git 指纹安全", () => {
  test("D11 HEAD、跟踪和未跟踪文件/目录变化按真实内容改变指纹", async () => {
    const r = await repo(); const snap = () => collectGitSnapshot({ repoRoot: r.root });
    const a = await snap(); expect(a.head).toMatch(/^[a-f0-9]{40,64}$/); expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await snap()).toEqual(a);
    for (const path of ["README.md", "untracked.txt", "newdir/a.ts"]) {
      await mkdir(join(r.root, "newdir"), { recursive: true }); await writeFile(join(r.root, path), "A"); const before = await snap();
      await writeFile(join(r.root, path), "B"); expect((await snap()).fingerprint).not.toBe(before.fingerprint);
    }
    await writeFile(join(r.root, "README.md"), "x".repeat(1024 * 1024 + 4096)); expect((await snap()).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(collectGitSnapshot({ repoRoot: r.root, gitMaxBuffer: 1024 })).rejects.toThrow("变更过大");
  });
  test("D12 外部软链接只指纹路径不读目标，零权限文件拒绝后恢复可读", async () => {
    const r = await repo(); const outside = await mkdtemp(join(tmpdir(), "dispatch-snapshot-")); cleanup.push(() => rm(outside, { recursive: true, force: true }));
    const target = join(outside, "target"); await writeFile(target, "A"); const link = join(r.root, "link"); await symlink(target, link);
    const a = await collectGitSnapshot({ repoRoot: r.root }); await writeFile(target, "B"); expect(await collectGitSnapshot({ repoRoot: r.root })).toEqual(a);
    await rm(link); await symlink(join(outside, "missing"), link); expect((await collectGitSnapshot({ repoRoot: r.root })).fingerprint).not.toBe(a.fingerprint);
    const locked = join(r.root, "locked"); await writeFile(locked, ""); await chmod(locked, 0);
    try { await expect(collectGitSnapshot({ repoRoot: r.root })).rejects.toThrow("无法读取快照文件"); } finally { await chmod(locked, 0o600); }
    expect((await collectGitSnapshot({ repoRoot: r.root })).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  test("D13 空仓库清楚拒绝，不泄漏 Git stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-empty-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); await exec("git", ["init", "-b", "main"], { cwd: dir, env: GIT_ENV });
    await expect(collectGitSnapshot({ repoRoot: dir })).rejects.toThrow("仓库尚无提交");
  });
  test("D14 真 Git 配置 FIFO 阻塞可超时和取消，不执行派审", async () => {
    const r = await repo(); const fifo = join(r.root, "blocked"); await exec("mkfifo", [fifo]); await exec("git", ["config", "include.path", fifo], { cwd: r.root, env: GIT_ENV });
    // 清除阻塞配置后才让仓库清理 helper 调用 Git。
    cleanup.push(() => writeFile(join(r.root, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n"));
    await expect(collectGitSnapshot({ repoRoot: r.root, gitTimeoutMs: 200 })).rejects.toThrow("git 命令超时");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await expect(collectGitSnapshot({ repoRoot: r.root, signal: controller.signal })).rejects.toThrow("git 命令已中止"); } finally { clearTimeout(timer); }
  }, 10_000);
});
