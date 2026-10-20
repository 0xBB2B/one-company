import { answeringUi } from "./helpers/window-host.ts";
import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GIT_DELIVER_TOOL, registerGitDelivery } from "../src/modules/delivery/git-delivery-extension.ts";
import * as gitDelivery from "../src/modules/delivery/git-delivery.ts";
import { projectSettingsPath, userSettingsPath } from "../src/modules/settings/agent-settings.ts";
import type { WorkspaceClientsHandle } from "../src/core/host/daemon-client.ts";

vi.mock("../src/modules/delivery/git-delivery.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/delivery/git-delivery.ts")>()),
  deliverRequirement: vi.fn(async () => ({ status: "rejected", reason: "测试替身", next: "无" })),
}));

vi.mock("../src/modules/delivery/local-delivery.ts", () => ({
  deliverLocally: vi.fn(async () => ({ status: "rejected", reason: "测试替身", next: "无" })),
}));

const cleanups: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Tool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }> };
type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
const gitDeliverySettings = (value: unknown) => JSON.stringify({ "one-company": { "git-delivery": value } });
const oneCompanySettings = (value: Record<string, unknown>) => JSON.stringify({ "one-company": value });
async function writeSettings(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function world(status: Record<string, unknown> = { status: "closed", reason: "completed", archive: null, delivery: null }, trusted = true) {
  const root = await realpath(await mkdtemp("/tmp/pi-t-"));
  cleanups.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let active = ["read", "bash"];
  const tools = new Map<string, Tool>(), commands: string[] = [], handlers = new Map<string, Handler>();
  const calls: unknown[] = [];
  const pi = {
    registerTool: (tool: Tool & { name: string }) => { tools.set(tool.name, tool); },
    registerCommand: (name: string) => { commands.push(name); },
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  const clients = { forRepo: () => ({ call: async (method: string, params: unknown) => { calls.push([method, params]); return { result: { close: status } }; } }) } as unknown as WorkspaceClientsHandle;
  registerGitDelivery(pi, () => ({ clients: () => clients }));
  const ctx = { cwd, isProjectTrusted: () => trusted, hasUI: true, ui: { ...answeringUi(() => true), notify: () => {} } };
  const start = async () => { await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx); };
  const run = async (params: unknown) => JSON.parse((await tools.get(GIT_DELIVER_TOOL)!.execute("t", params, undefined, undefined, ctx)).content[0]!.text) as Record<string, unknown>;
  const mainRepo = join(root, "main"), worktree = join(root, "req");
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const makeDeliverable = async () => {
    await mkdir(mainRepo, { recursive: true });
    await mkdir(join(root, "elsewhere"), { recursive: true });
    git(mainRepo, "init", "-q", "-b", "main");
    git(mainRepo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed");
    git(mainRepo, "worktree", "add", "-q", "-b", "req/login", worktree);
    Object.assign(status, { status: "closed", reason: "completed",
      archive: { path: "docs/prd/a.md", archiveHash: "h", status: "archived", prototypes: [] }, delivery: { worktree, branch: "refs/heads/req/login", codeHead: "c" } });
  };
  return {
    pi, active: () => active, commands, mainRoot: mainRepo, start, run, calls, makeDeliverable,
    userPath: userSettingsPath(agentDir), projectPath: projectSettingsPath(cwd), mainProjectPath: projectSettingsPath(mainRepo),
  };
}
const PARAMS = { repoId: "a".repeat(64), requirementId: "0197b7b0-6a20-7c51-8a32-b9465fb72d10" };

test("两层设置都没写时，窗口启动后工具列表里有交付工具，其他工具顺序不变", async () => {
  const w = await world();
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test.each([
  ["用户层 remote", "user", "remote"],
  ["用户层 local", "user", "local"],
  ["项目层 remote", "project", "remote"],
  ["项目层 local", "project", "local"],
  ["用户层旧的 true", "user", true],
  ["用户层旧的 false", "user", false],
  ["用户层写错的字符串", "user", "yes"],
])("设置是%s时，窗口启动后工具列表里都有交付工具", async (_label, layer, value) => {
  const w = await world();
  await writeSettings(layer === "user" ? w.userPath : w.projectPath, gitDeliverySettings(value));
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("项目不受信任、项目层写 local 时，工具列表里仍有交付工具", async () => {
  const w = await world(undefined, false);
  await writeSettings(w.projectPath, gitDeliverySettings("local"));
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("重复启动窗口不会让交付工具出现两个", async () => {
  const w = await world();
  await w.start();
  await w.start();
  expect(w.active()).toEqual(["read", "bash", GIT_DELIVER_TOOL]);
});

test("仅本地和远程档位下调用交付工具，都会去查需求的关闭状态", async () => {
  for (const mode of ["local", "remote"]) {
    const w = await world();
    await writeSettings(w.userPath, gitDeliverySettings(mode));
    await w.start();
    await w.run(PARAMS).catch(() => undefined);
    expect(w.calls[0], mode).toEqual(["workflow.manage", { requirementId: PARAMS.requirementId, request: { action: "status" } }]);
  }
});

test("两层设置都没写，窗口启动后直接调用交付工具会去查需求的关闭状态", async () => {
  const w = await world();
  await w.start();
  await w.run(PARAMS).catch(() => undefined);
  expect(w.calls.length).toBeGreaterThan(0);
});

test("窗口启动后用户设置改成 local，再调用交付工具仍会去查需求的关闭状态", async () => {
  const w = await world();
  await writeSettings(w.userPath, gitDeliverySettings("remote"));
  await w.start();
  await writeSettings(w.userPath, gitDeliverySettings("local"));
  await w.run(PARAMS).catch(() => undefined);
  expect(w.calls.length).toBeGreaterThan(0);
});

test("模型不能在参数里代选合并方式", async () => {
  const w = await world();
  await w.start();
  await expect(w.run({ ...PARAMS, merge: "auto" })).rejects.toThrow("原因：参数不符合本工具的格式（多余字段：merge；本动作允许字段：repoId、requirementId）");
});

test("需求未以完成关闭时拒绝交付", async () => {
  const w = await world({ status: "closed", reason: "cancelled", archive: null, delivery: null });
  await w.start();
  await expect(w.run(PARAMS)).rejects.toThrow("原因：需求没有以完成（completed）关闭并归档，当前状态 closed，关闭原因 cancelled\n建议：只有用户验收通过并以完成关闭的需求才能交付；需求已取消或拒绝时不要交付");
  expect(w.calls).toEqual([["workflow.manage", { requirementId: PARAMS.requirementId, request: { action: "status" } }]]);
});

test("不再注册 one:git-delivery 命令", async () => {
  const w = await world();
  expect(w.commands).not.toContain("one:git-delivery");
});

test("git-delivery 运行时模块不再导出数据库开关函数", () => {
  expect("gitDeliveryEnabled" in gitDelivery).toBe(false);
  expect("setGitDeliveryEnabled" in gitDelivery).toBe(false);
});

test("交付工具按需求工作区所在主仓库的设置，把交付档位和勾选的合并方式交给交付函数", async () => {
  const deliverMock = vi.mocked(gitDelivery.deliverRequirement);
  const w = await world();
  await w.makeDeliverable();
  await writeSettings(w.mainProjectPath, oneCompanySettings({ "git-delivery": "remote", "merge-methods": ["merge"] }));
  await w.start();
  deliverMock.mockClear();
  await w.run(PARAMS);
  expect(deliverMock).toHaveBeenCalledTimes(1);
  expect(deliverMock.mock.calls[0]![2]).toEqual({ mode: "remote", mergeMethods: ["merge"] });
});

test("用户层设置 local 且没写合并方式时，仅本地交付收到主仓库根和三种默认合并方式", async () => {
  const localDelivery = await import("../src/modules/delivery/local-delivery.ts");
  const localMock = vi.mocked(localDelivery.deliverLocally);
  const w = await world();
  await w.makeDeliverable();
  await writeSettings(w.userPath, gitDeliverySettings("local"));
  await w.start();
  localMock.mockClear();
  await w.run(PARAMS);
  expect(localMock.mock.calls[0]![2]).toEqual({ repositoryRoot: w.mainRoot, mergeMethods: ["squash", "merge", "rebase"] });
});

test("档位为 local 时调用仅本地交付，参数带主仓库根和合并方式，不调远程交付（gh/glab 只在远程交付里用）", async () => {
  const localDelivery = await import("../src/modules/delivery/local-delivery.ts");
  const localMock = vi.mocked(localDelivery.deliverLocally), remoteMock = vi.mocked(gitDelivery.deliverRequirement);
  const w = await world();
  await w.makeDeliverable();
  await writeSettings(w.mainProjectPath, oneCompanySettings({ "git-delivery": "local", "merge-methods": ["merge", "rebase"] }));
  await w.start();
  localMock.mockClear(); remoteMock.mockClear();
  await w.run(PARAMS);
  expect(remoteMock).not.toHaveBeenCalled();
  expect(localMock).toHaveBeenCalledTimes(1);
  expect(localMock.mock.calls[0]![2]).toEqual({ repositoryRoot: w.mainRoot, mergeMethods: ["merge", "rebase"] });
});
