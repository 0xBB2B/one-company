import { testRepoId, sessionJson, failDatabaseWrites } from "./helpers/database-fixture.ts";
import { uuidv7, repositoryDatabase, withDatabase } from "../runtime/database.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createRoleSession } from "../daemon/role-session.ts";
import { createClock } from "../runtime/clock.ts";
import { NetworkPauseGate, type PauseReason } from "../runtime/network-pause.ts";
import { ShellRegistry, type Host, type ShellRegistryProbes } from "../runtime/shell-registry.ts";
import type { McpConfig } from "../runtime/mcp.ts";
import { readRoleDefinition, type RoleCatalogEntry } from "../runtime/roles.ts";
import { Type } from "typebox";
import { WORK_SCHEMA } from "../runtime/result.ts";
import { openSessionManagerForRun, sessionRecordRef } from "../runtime/session-records.ts";
import { registerControlledProvider, scriptReplies, setReplies, type ControlledProvider } from "./helpers/controlled-provider.ts";
import { createFakeTimeSource, withClockPump, withTimeout } from "./helpers/fake-clock.ts";
import { createTempHome, removeTempHome, type TempHome } from "./helpers/temp-home.ts";
import { addWorktree, createRepoFixture, removeRepoFixture, type RepoFixture } from "./helpers/repo-fixture.ts";
import { calls as fakeMcpCalls, resetCalls as resetFakeMcpCalls } from "./fixtures/fake-mcp-adapter/index.ts";

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-adapter");
const FAKE_MCP_ENTRY = join(FIXTURE_DIR, "index.ts");
const CONTROLLED_API_KEY = "controlled-key";

const tempRoots: string[] = [];
const tempHomes: TempHome[] = [];
const repoFixtures: RepoFixture[] = [];
const handles: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      handle.dispose();
    } catch {
      // 清理阶段的 dispose 失败不应掩盖用例本身的断言结果
    }
  }
  for (const fixture of repoFixtures.splice(0)) {
    await removeRepoFixture(fixture);
  }
  for (const home of tempHomes.splice(0)) {
    await removeTempHome(home);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRuntime(): Promise<ModelRuntime> {
  const modelsDir = await mkdtemp(join(tmpdir(), "role-session-models-"));
  tempRoots.push(modelsDir);
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(modelsDir, "models.json"),
    refreshOnCreate: false,
  });
}

async function setupProvider(providerId: string): Promise<{ runtime: ModelRuntime; provider: ControlledProvider }> {
  const runtime = await createRuntime();
  const provider = registerControlledProvider(runtime, { providerId, modelId: "controlled-model" });
  return { runtime, provider };
}

async function writeRoleEntry(fields: {
  name: string;
  kind: string;
  tools: string[];
}): Promise<RoleCatalogEntry> {
  const dir = await mkdtemp(join(tmpdir(), "role-session-role-"));
  tempRoots.push(dir);
  const path = join(dir, `${fields.name}.md`);
  const lines = [
    `name: ${fields.name}`,
    `description: ${fields.name} 测试角色`,
    `kind: ${fields.kind}`,
    `tools: [${fields.tools.join(", ")}]`,
    "skills: false",
    "context_files: false",
    "prompt_mode: append",
  ];
  await writeFile(path, `---\n${lines.join("\n")}\n---\n正文\n`);
  const definition = await readRoleDefinition(path, parseFrontmatter);
  return { name: fields.name, source: "project", path, available: true, definition };
}

async function hashFile(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "missing";
  }
}

function createGuards(occupied: Set<string> = new Set()) {
  return {
    async checkWrite(path: string) {
      return occupied.has(path)
        ? ({ ok: false as const, reason: "路径已被占用" })
        : ({ ok: true as const });
    },
    async fingerprint(paths: string[]): Promise<Record<string, string>> {
      const entries = await Promise.all(paths.map(async (p) => [p, await hashFile(p)] as const));
      return Object.fromEntries(entries);
    },
    async verifyFingerprint(fp: Record<string, string>): Promise<Array<{ path: string }>> {
      const changed: Array<{ path: string }> = [];
      for (const [path, hash] of Object.entries(fp)) {
        if ((await hashFile(path)) !== hash) changed.push({ path });
      }
      return changed;
    },
  };
}

function validWorkObject(): Record<string, unknown> {
  return {
    phase: "work",
    verdict: "PASS",
    summary: "完成实现",
    issues: [],
    evidence: ["测试证据"],
    changeKind: "refactor",
    workState: "green-baseline-no-change",
    coverage: [{ ref: "r1", test: "t1" }],
    redCommands: [],
    greenCommands: [{ command: "bun test", status: "passed", details: "全部通过" }],
    changedFiles: [],
    productionPath: [],
    preexistingEvidence: ["既有证据"],
    fakeRed: false,
  };
}

function invalidWorkObject(): Record<string, unknown> {
  const obj = validWorkObject();
  delete obj.coverage;
  return obj;
}

async function tempCwd(): Promise<string> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  return repo.root;
}

function collect(handle: any, type: string): unknown[] {
  const events: unknown[] = [];
  handle.events.on(type, (event: unknown) => events.push(event));
  return events;
}

async function waitForState(handle: any, predicate: (state: string) => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!predicate(handle.state())) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时等待状态，当前: ${handle.state()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForCount(getLength: () => number, min: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (getLength() < min) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时等待事件数量达到 ${min}，当前 ${getLength()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hasBareSpaceUserMessage(dataRoot: string, repoId: string, runId: string): boolean {
  const opened = openSessionManagerForRun({ dataRoot, repoId, runId });
  if (!opened.ok) return false;
  return opened.manager.getEntries().some((entry: any) => {
    if (entry.type !== "message" || entry.message.role !== "user") return false;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.map((block: any) => block.text ?? "").join("");
    return text === " ";
  });
}

interface NetworkGateSpy {
  gate: NetworkPauseGate;
  requestPauseCalls: Array<{ runId: string; reason: PauseReason }>;
  canProceedCalls: string[];
  resumeCalls: string[];
}

function createNetworkGateSpy(): NetworkGateSpy {
  const real = new NetworkPauseGate();
  const spy: NetworkGateSpy = {
    gate: real,
    requestPauseCalls: [],
    canProceedCalls: [],
    resumeCalls: [],
  };
  const originalRequestPause = real.requestPause.bind(real);
  const originalCanProceed = real.canProceed.bind(real);
  const originalResume = real.resume.bind(real);
  real.requestPause = (runId: string, reason: PauseReason) => {
    spy.requestPauseCalls.push({ runId, reason });
    return originalRequestPause(runId, reason);
  };
  real.canProceed = (runId: string) => {
    spy.canProceedCalls.push(runId);
    return originalCanProceed(runId);
  };
  real.resume = (runId: string) => {
    spy.resumeCalls.push(runId);
    return originalResume(runId);
  };
  return spy;
}

describe("独立会话与运行身份", () => {
  test("会话按 dataRoot/repoId/runId 落盘为合法会话文件", async () => {
    const { runtime, provider } = await setupProvider("role-session-identity");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "grep", "find", "ls", "edit", "write", "bash"] });
    const repoId = testRepoId("identity-repo");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "完成" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId,
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "身份测试任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("身份测试任务");
    await handle.result();

    expect(handle.state()).toBe("completed");
    const opened = openSessionManagerForRun({ dataRoot: home.dataRoot, repoId, runId });
    expect(opened.ok).toBe(true);
    const rawExists = sessionJson({ dataRoot: home.dataRoot, repoId, runId });
    expect(rawExists.length).toBeGreaterThan(0);
  }, 20000);

  test("模型服务不可用时会话如实报告错误", async () => {
    const { runtime, provider } = await setupProvider("role-session-unavailable");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "bash"] });

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("unavailable-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "模型不可用任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("模型不可用任务");

    await expect(handle.result()).rejects.toBeTruthy();
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
  }, 20000);

  test("角色定义损坏时创建会话报错并说明原因", async () => {
    const { runtime, provider } = await setupProvider("role-session-broken-role");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const brokenReason = "角色定义缺少必需字段 name（测试注入）";
    const brokenEntry: RoleCatalogEntry = {
      name: "worker",
      source: "project",
      path: join(cwd, "worker.md"),
      available: false,
      reason: brokenReason,
    };

    await expect(
      createRoleSession({
        dataRoot: home.dataRoot,
        repoId: testRepoId("broken-role-repo"),
        runId: uuidv7(),
        shellToken: randomUUID(),
        cwd,
        roleName: "worker",
        role: brokenEntry,
        task: "损坏角色任务",
        readPaths: [],
        writePaths: [],
        contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
        runtime,
        modelRef: { provider: provider.providerId, id: provider.modelId },
        clock: createClock(),
        shellRegistry: new ShellRegistry({ clock: createClock() }),
        guards: createGuards(),
        networkGate: new NetworkPauseGate(),
      }),
    ).rejects.toThrow(brokenReason);
  }, 20000);
});

describe("工具白名单、读写路径与占用核对", () => {
  test("范围外读写、他人占用文件、集合外 MCP 调用依次被拒绝且会话继续，范围内写入成功，结构化提交唯一生效", async () => {
    const { runtime, provider } = await setupProvider("role-session-worker-script");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();

    const outsideReadFile = join(cwd, "secret.txt");
    const outsideWriteFile = join(cwd, "outside-write.txt");
    const occupiedFile = join(cwd, "occupied.txt");
    const inScopeReadFile = join(cwd, "readable.txt");
    const inScopeWriteFile = join(cwd, "output.txt");
    await writeFile(outsideReadFile, "机密内容");
    await writeFile(occupiedFile, "占用内容");
    await writeFile(inScopeReadFile, "可读内容");

    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "grep", "find", "ls", "edit", "write", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "read", input: { path: outsideReadFile } },
      { type: "toolcall", name: "write", input: { path: outsideWriteFile, content: "越界写入" } },
      { type: "toolcall", name: "write", input: { path: occupiedFile, content: "尝试覆盖占用文件" } },
      { type: "toolcall", name: "mcp", input: { tool: "codegraph_explore", server: "codegraph", search: "x" } },
      { type: "toolcall", name: "write", input: { path: inScopeWriteFile, content: "worker content" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("worker-script-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "综合脚本任务",
      readPaths: [inScopeReadFile],
      writePaths: [occupiedFile, inScopeWriteFile],
      mcp: { servers: ["context7"] },
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(new Set([occupiedFile])),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;

    handle.prompt("综合脚本任务");
    const result = await handle.result();

    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");
    await waitForCount(() => toolEnds.length, 6);

    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(toolEnds[2]?.isError).toBe(true);
    expect(toolEnds[3]?.isError).toBe(true);
    expect(toolEnds[4]?.isError).toBe(false);
    expect(toolEnds[5]?.isError).toBe(false);

    const written = await readFile(inScopeWriteFile, "utf8");
    expect(written).toBe("worker content");
    await expect(readFile(outsideWriteFile, "utf8")).rejects.toBeTruthy();
    const occupiedContent = await readFile(occupiedFile, "utf8");
    expect(occupiedContent).toBe("占用内容");
  }, 20000);

  test("角色工具白名单外的操作被拒绝", async () => {
    const { runtime, provider } = await setupProvider("role-session-tool-allowlist");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const writeTarget = join(cwd, "should-not-exist.txt");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: writeTarget, content: "不该写入" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("tool-allowlist-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "工具白名单任务",
      readPaths: [],
      writePaths: [writeTarget],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("工具白名单任务");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    await expect(readFile(writeTarget, "utf8")).rejects.toBeTruthy();
  }, 20000);
});

describe("只读工具省略 path 与相对路径解析", () => {
  test("grep/find/ls 省略 path 时仍按 readPaths 判定，不因省略而绕过范围且不泄漏范围外内容", async () => {
    const { runtime, provider } = await setupProvider("role-session-omit-path");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const allowedFile = join(cwd, "allowed.txt");
    const secretFile = join(cwd, "secret.txt");
    await writeFile(allowedFile, "普通内容");
    await writeFile(secretFile, "TOPSECRET-BODY-9F2");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "grep", input: { pattern: "TOPSECRET" } },
      { type: "toolcall", name: "find", input: { pattern: "*.txt" } },
      { type: "toolcall", name: "ls", input: {} },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("omit-path-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "省略 path 任务",
      readPaths: [allowedFile],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("省略 path 任务");

    await waitForCount(() => toolEnds.length, 3);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(toolEnds[2]?.isError).toBe(true);

    const requestsText = JSON.stringify(provider.requests);
    expect(requestsText).not.toContain("TOPSECRET-BODY-9F2");
  }, 20000);

  test("write 相对路径按会话 cwd 解析：范围内相对路径放行，越出 cwd 的相对路径被拒", async () => {
    const { runtime, provider } = await setupProvider("role-session-relative-path");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const outFile = join(cwd, "out.txt");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["write", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: "out.txt", content: "相对路径写入" } },
      { type: "toolcall", name: "write", input: { path: "../escape.txt", content: "越权写入" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("relative-path-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "相对路径任务",
      readPaths: [],
      writePaths: [outFile],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("相对路径任务");

    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(toolEnds[1]?.isError).toBe(true);
    const written = await readFile(outFile, "utf8");
    expect(written).toBe("相对路径写入");
    await expect(readFile(join(cwd, "..", "escape.txt"), "utf8")).rejects.toBeTruthy();
  }, 20000);

  test("只读角色即便工具白名单含 write/edit，直接调用也被拒（非经 bash）", async () => {
    const { runtime, provider } = await setupProvider("role-session-readonly-write-tool");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const targetFile = join(cwd, "target.txt");
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "write", "edit", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: targetFile, content: "不该写入" } },
      { type: "toolcall", name: "edit", input: { path: targetFile, edits: [{ oldText: "a", newText: "b" }] } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("readonly-write-tool-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "reviewer",
      role,
      task: "只读角色直写任务",
      readPaths: [],
      writePaths: [targetFile],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "review" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("只读角色直写任务");

    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(true);
    await expect(readFile(targetFile, "utf8")).rejects.toBeTruthy();
  }, 20000);
});

describe("MCP 服务限制", () => {
  test("缺失服务只阻塞依赖它的任务，不改变读写边界", async () => {
    const { runtime, provider } = await setupProvider("role-session-mcp-missing");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const inScopeWriteFile = join(cwd, "output.txt");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "write", "edit", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "mcp", input: { tool: "context7_docs", server: "context7", search: "x" } },
      { type: "toolcall", name: "write", input: { path: inScopeWriteFile, content: "无 MCP 仍可写入" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("mcp-missing-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "MCP 缺失任务",
      readPaths: [],
      writePaths: [inScopeWriteFile],
      mcp: { servers: [] },
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("MCP 缺失任务");
    await handle.result();

    expect(handle.state()).toBe("completed");
    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(false);
    const written = await readFile(inScopeWriteFile, "utf8");
    expect(written).toBe("无 MCP 仍可写入");
  }, 20000);
});

describe("MCP 真实装载对照", () => {
  test("勾选且可用的服务真实装载并成功调用，集合外服务被拒，禁用服务只在系统提示里说明缺失", async () => {
    resetFakeMcpCalls();
    const { runtime, provider } = await setupProvider("role-session-mcp-real-adapter");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const mcpConfig: McpConfig = {
      mcpServers: {
        codegraph: { command: "codegraph-server" },
        legacy: { command: "legacy-server", disabled: true },
      },
    };

    scriptReplies(provider, [
      { type: "toolcall", name: "mcp", input: { tool: "codegraph_explore", server: "codegraph", search: "x" } },
      { type: "toolcall", name: "mcp", input: { tool: "outside_tool", server: "outside-service", search: "x" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("mcp-real-adapter-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "MCP 真实装载任务",
      readPaths: [],
      writePaths: [],
      mcp: { servers: ["codegraph", "legacy"], entryPath: FAKE_MCP_ENTRY, packageDir: FIXTURE_DIR, config: mcpConfig },
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("MCP 真实装载任务");

    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(fakeMcpCalls).toEqual([{ server: "codegraph", tool: "codegraph_explore", mode: "search" }]);

    const requestsText = provider.requests.map((ctx) => ctx.systemPrompt ?? "").join("\n");
    expect(requestsText).toContain("缺失");
    expect(requestsText).toContain("legacy");
  }, 20000);

  test("只读角色经真实装载的 MCP 工具发起写类调用仍被拒", async () => {
    resetFakeMcpCalls();
    const { runtime, provider } = await setupProvider("role-session-mcp-readonly");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["bash"] });
    const mcpConfig: McpConfig = { mcpServers: { codegraph: { command: "codegraph-server" } } };

    scriptReplies(provider, [
      { type: "toolcall", name: "mcp", input: { tool: "codegraph_write", server: "codegraph", args: { content: "不该写入" } } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("mcp-readonly-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "reviewer",
      role,
      task: "只读 MCP 写类调用任务",
      readPaths: [],
      writePaths: [],
      mcp: { servers: ["codegraph"], entryPath: FAKE_MCP_ENTRY, packageDir: FIXTURE_DIR, config: mcpConfig },
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "review" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("只读 MCP 写类调用任务");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(fakeMcpCalls).toEqual([]);
  }, 20000);

  test("MCP 适配器装载失败时系统提示含失败原因，调用 mcp 得到服务不可用而非未知工具的回执", async () => {
    const { runtime, provider } = await setupProvider("role-session-mcp-load-failure");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const brokenEntry = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "broken-mcp-adapter", "index.ts");
    const mcpConfig: McpConfig = { mcpServers: { codegraph: { command: "codegraph-server" } } };

    scriptReplies(provider, [
      { type: "toolcall", name: "mcp", input: { tool: "codegraph_explore", server: "codegraph", search: "x" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("mcp-load-failure-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "MCP 装载失败任务",
      readPaths: [],
      writePaths: [],
      mcp: { servers: ["codegraph"], entryPath: brokenEntry, packageDir: dirname(brokenEntry), config: mcpConfig },
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("MCP 装载失败任务");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);

    const requestsText = JSON.stringify(provider.requests);
    expect(requestsText).toContain("服务不可用");

    const systemPromptText = provider.requests.map((ctx) => ctx.systemPrompt ?? "").join("\n");
    expect(systemPromptText).toContain("入口加载失败");
  }, 20000);
});

describe("结构化提交", () => {
  test("不合法对象缺字段被拒绝且会话继续，随后合法提交被接受", async () => {
    const { runtime, provider } = await setupProvider("role-session-invalid-submission");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: invalidWorkObject() },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("invalid-submission-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "非法提交任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("非法提交任务");
    const result = await handle.result();

    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");
    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(true);
    expect(toolEnds[1]?.isError).toBe(false);
  }, 20000);

  test("结构化提交被接受后是会话最后一个动作，其后任何操作都被拒绝", async () => {
    const { runtime, provider } = await setupProvider("role-session-submission-is-last");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const postSubmitFile = join(cwd, "post-submit.txt");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["write", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "toolcall", name: "write", input: { path: postSubmitFile, content: "提交后不该写入" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("submission-is-last-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "提交是最后动作任务",
      readPaths: [],
      writePaths: [postSubmitFile],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("提交是最后动作任务");
    await expect(handle.result()).rejects.toThrow("裁决提交后仍发起工具调用");
    expect(handle.state()).toBe("failed");
    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(toolEnds[1]?.isError).toBe(true);
    await expect(readFile(postSubmitFile, "utf8")).rejects.toBeTruthy();
  }, 20000);

});

describe("暂停与恢复", () => {
  test("SQLite 会话保存失败使角色失败并阻止后续文件写入", async () => {
    const { runtime, provider } = await setupProvider("role-session-persist-failure");
    const home = await createTempHome(); tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["write"] });
    const repoId = testRepoId(); const runId = uuidv7();
    scriptReplies(provider, [{ type: "toolcall", name: "write", input: { path: "unsaved.txt", content: "不应执行" } }, { type: "text", text: "结束" }]);
    const clock = createClock();
    const handle = await createRoleSession({ dataRoot: home.dataRoot, repoId, runId, shellToken: randomUUID(), cwd, roleName: "worker", role, task: "保存失败", readPaths: [cwd], writePaths: [cwd], contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" }, runtime, modelRef: { provider: provider.providerId, id: provider.modelId }, clock, shellRegistry: new ShellRegistry({ clock }), guards: createGuards(), networkGate: new NetworkPauseGate() });
    handles.push(handle);
    const restore = failDatabaseWrites(repositoryDatabase(home.dataRoot, repoId), "events", "stream", `session:${runId}`);
    try {
      handle.prompt("开始");
      await expect(handle.result()).rejects.toThrow("会话保存失败");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(handle.state()).toBe("failed");
      await expect(readFile(join(cwd, "unsaved.txt"), "utf8")).rejects.toThrow();
    } finally { restore(); clock.stopGapWatcher(); }
  });

  test("暂停后 resume 只产生一次真实续跑请求，排队消息送达，会话文件不含裸空格用户消息", async () => {
    const { runtime, provider } = await setupProvider("role-session-pause-resume");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const file1 = join(cwd, "file1.txt");
    await writeFile(file1, "初始内容");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "write", "bash"] });
    const repoId = testRepoId("pause-resume-repo");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: file1, content: "第一次写入" } },
      { type: "text", text: "unused" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId,
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "暂停恢复任务",
      readPaths: [file1],
      writePaths: [file1],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    let pausePromise: Promise<{ confirmed: boolean; reason?: string }> | undefined;
    handle.events.on("tool_end", (event: { toolName?: string }) => {
      if (!pausePromise && event?.toolName === "write") pausePromise = handle.pause();
    });

    handle.prompt("暂停恢复任务");

    await waitForCount(() => pausePromise !== undefined, 1);
    await pausePromise;

    handle.prompt("排队消息标记");

    const requestsBeforeResume = provider.requests.length;
    setReplies(provider, [{ type: "text", text: "resumed" }]);

    await handle.resume();
    await waitForCount(() => provider.requests.length, requestsBeforeResume + 1);
    expect(provider.requests.length).toBe(requestsBeforeResume + 1);

    const resumeRequest = provider.requests[requestsBeforeResume];
    expect(JSON.stringify(resumeRequest)).toContain("排队消息标记");
    expect(hasBareSpaceUserMessage(home.dataRoot, repoId, runId)).toBe(false);
  }, 20000);

  test("恢复核对工具实际读取现场后才解除写入阶段检查", async () => {
    const { runtime, provider } = await setupProvider("role-session-pause-verify-gate");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const file1 = join(cwd, "file1.txt");
    const file2 = join(cwd, "file2.txt");
    await writeFile(file1, "初始内容");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "write", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: file1, content: "第一次写入" } },
      { type: "text", text: "unused" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("pause-verify-gate-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "核对期解除任务",
      readPaths: [file1],
      writePaths: [file1, file2],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    let pausePromise: Promise<{ confirmed: boolean; reason?: string }> | undefined;
    handle.events.on("tool_end", (event: { toolName?: string }) => {
      if (!pausePromise && event?.toolName === "write") pausePromise = handle.pause();
    });

    handle.prompt("核对期解除任务");
    await waitForCount(() => pausePromise !== undefined, 1);
    await pausePromise;

    setReplies(provider, [
      { type: "toolcall", name: "write", input: { path: file2, content: "核对期第一次重试" } },
      { type: "toolcall", name: "write", input: { path: file2, content: "核对期第二次重试" } },
      { type: "toolcall", name: "pi_company_resume_check", input: {} },
      { type: "toolcall", name: "write", input: { path: file2, content: "核对完成后写入" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "resumed" },
    ]);

    await handle.resume();
    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();

    await waitForCount(() => toolEnds.length, 6, 5000);
    expect(toolEnds[1]?.isError).toBe(true);
    expect(toolEnds[2]?.isError).toBe(true);
    expect(toolEnds[3]?.isError).toBe(false);
    expect(toolEnds[4]?.isError).toBe(false);

    const written = await readFile(file2, "utf8");
    expect(written).toBe("核对完成后写入");
  }, 20000);

  test("pause 在事件回调里同步调用即时中止进行中的 bash 并停止其 Shell，运行中排队消息保留到续跑提示且只产生一次续跑请求", async () => {
    const { runtime, provider } = await setupProvider("role-session-pause-inflight-bash");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const repoId = testRepoId("pause-inflight-bash-repo");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "sleep 2" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId,
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "暂停中止进行中操作任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;

    handle.prompt("暂停中止进行中操作任务");
    // 真实等待，让受控 provider 的 toolcall 走完 tool_call 拦截并让 bash 真正 spawn 出 sleep 子进程，
    // 确保下面的 pause() 是在一次真正进行中的长耗时操作期间调用，而非操作尚未开始
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(() => handle.prompt("运行中排队消息")).not.toThrow();

    const pauseStartedAt = Date.now();
    const pauseOutcome = await handle.pause();
    const pauseElapsedMs = Date.now() - pauseStartedAt;

    expect(pauseOutcome.confirmed).toBe(true);
    expect(pauseElapsedMs).toBeLessThan(1000);

    await waitForCount(() => toolEnds.length, 1, 5000);
    expect(toolEnds[0]?.isError).toBe(true);

    const requestsBeforeResume = provider.requests.length;
    setReplies(provider, [{ type: "text", text: "resumed" }]);
    await withTimeout(handle.resume(), 5000, "超时等待 resume() 完成");

    await waitForCount(() => provider.requests.length, requestsBeforeResume + 1);
    expect(provider.requests.length).toBe(requestsBeforeResume + 1);
    const resumeRequest = provider.requests[requestsBeforeResume];
    expect(JSON.stringify(resumeRequest)).toContain("运行中排队消息");
    expect(hasBareSpaceUserMessage(home.dataRoot, repoId, runId)).toBe(false);
  }, 20000);
});

describe("核对期收敛（自然结束回合即照常结算，不追加核验提示）", () => {
  test("核对期内模型只回文字结束回合，不追加核验提示，只产生一次续跑请求；未提交时保持 running 并 emit idle", async () => {
    const { runtime, provider } = await setupProvider("role-session-verify-settle-text");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const file1 = join(cwd, "file1.txt");
    await writeFile(file1, "初始内容");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "write", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: file1, content: "第一次写入" } },
      { type: "text", text: "unused" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("verify-settle-text-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "核对期收敛任务",
      readPaths: [file1],
      writePaths: [file1],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    let pausePromise: Promise<{ confirmed: boolean; reason?: string }> | undefined;
    handle.events.on("tool_end", (event: { toolName?: string }) => {
      if (!pausePromise && event?.toolName === "write") pausePromise = handle.pause();
    });

    handle.prompt("核对期收敛任务");
    await waitForCount(() => pausePromise !== undefined, 1);
    await pausePromise;

    const requestsBeforeResume = provider.requests.length;
    const idleEvents = collect(handle, "idle");
    setReplies(provider, [{ type: "text", text: "已核对" }]);

    await handle.resume();
    await waitForCount(() => idleEvents.length, 1, 3000);

    expect(handle.state()).toBe("running");
    expect((idleEvents[0] as { submitted?: boolean })?.submitted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitForCount(() => provider.requests.length, requestsBeforeResume + 1);
    expect(provider.requests.length).toBe(requestsBeforeResume + 1);
  }, 20000);

  test("角色工具白名单只有 bash（无只读工具）时，核对期内模型只回文字同样不产生额外请求", async () => {
    const { runtime, provider } = await setupProvider("role-session-verify-settle-bash-only");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const file1 = join(cwd, "file1.txt");
    await writeFile(file1, "初始内容");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo hi > ${file1}` } },
      { type: "text", text: "unused" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("verify-settle-bash-only-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "核对期收敛任务（仅 bash）",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    let pausePromise: Promise<{ confirmed: boolean; reason?: string }> | undefined;
    handle.events.on("tool_end", (event: { toolName?: string }) => {
      if (!pausePromise && event?.toolName === "bash") pausePromise = handle.pause();
    });

    handle.prompt("核对期收敛任务（仅 bash）");
    await waitForCount(() => pausePromise !== undefined, 1);
    await pausePromise;

    const requestsBeforeResume = provider.requests.length;
    const idleEvents = collect(handle, "idle");
    setReplies(provider, [{ type: "text", text: "已核对" }]);

    await handle.resume();
    await waitForCount(() => idleEvents.length, 1, 3000);

    expect(handle.state()).toBe("running");
    expect((idleEvents[0] as { submitted?: boolean })?.submitted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitForCount(() => provider.requests.length, requestsBeforeResume + 1);
    expect(provider.requests.length).toBe(requestsBeforeResume + 1);
  }, 20000);
});

describe("多轮与 finalize 结算", () => {
  test("同时提交及 idle 回调内追加消息串行进入 SDK，全部写入历史且无请求冲突", async () => {
    const { runtime, provider } = await setupProvider("role-session-concurrent-prompts");
    const home = await createTempHome(); tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read"] });
    const runId = uuidv7();
    const repoId = testRepoId("concurrent-prompts");
    scriptReplies(provider, ["第一条已处理", "第二条已处理", "第三条已处理"].map((text) => ({ type: "text" as const, text })));
    const handle = await createRoleSession({ dataRoot: home.dataRoot, repoId, runId, shellToken: randomUUID(), cwd,
      roleName: "worker", role, task: "串行消息", readPaths: [], writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" }, runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId }, clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }), guards: createGuards(), networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);
    let idle = 0;
    handle.events.on("idle", () => { if (++idle === 1) handle.prompt("第三条消息"); });
    handle.prompt("第一条消息");
    handle.prompt("第二条消息");
    await waitForCount(() => idle, 3, 5000);
    expect(handle.state()).toBe("running");
    expect(provider.requests).toHaveLength(3);
    const opened = openSessionManagerForRun({ dataRoot: home.dataRoot, repoId, runId });
    if (!opened.ok) throw new Error(opened.detail);
    const userMessages = opened.manager.getEntries().filter((entry: any) => entry.type === "message" && entry.message.role === "user").map((entry: any) => entry.message.content.map((block: any) => block.text ?? "").join(""));
    expect(userMessages).toEqual(["第一条消息", "第二条消息", "第三条消息"]);
  });

  test("第一轮只回文字未提交：保持 running、emit idle、result 未结算；第二轮提交后 completed", async () => {
    const { runtime, provider } = await setupProvider("role-session-multi-turn-idle");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [{ type: "text", text: "先汇报计划" }]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("multi-turn-idle-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "多轮任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const idleEvents = collect(handle, "idle");
    handle.prompt("多轮任务");

    await waitForCount(() => idleEvents.length, 1, 5000);
    expect(handle.state()).toBe("running");
    expect((idleEvents[0] as { submitted?: boolean })?.submitted).toBe(false);

    const notSettledMarker = Symbol("not-settled");
    const race = await Promise.race([
      handle.result().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve(notSettledMarker), 300)),
    ]);
    expect(race).toBe(notSettledMarker);

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);
    handle.prompt("请提交结果");

    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");
  }, 20000);

  test("finalize()：idle 期间未提交时判 failed 并说明未提交", async () => {
    const { runtime, provider } = await setupProvider("role-session-finalize-not-submitted");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [{ type: "text", text: "先汇报计划" }]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("finalize-not-submitted-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "finalize 未提交任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const idleEvents = collect(handle, "idle");
    const failedEvents = collect(handle, "failed");
    handle.prompt("finalize 未提交任务");
    await waitForCount(() => idleEvents.length, 1, 5000);

    let finalizeError: Error | undefined;
    try {
      await handle.finalize();
    } catch (error) {
      finalizeError = error as Error;
    }

    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0]) + (finalizeError?.message ?? "")).toContain("未提交");
  }, 8000);

  test("finalize()：已提交并自然结算为 completed 后再次调用不改变终态", async () => {
    const { runtime, provider } = await setupProvider("role-session-finalize-submitted");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("finalize-submitted-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "finalize 已提交任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("finalize 已提交任务");
    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");

    let finalizeError: Error | undefined;
    try {
      await handle.finalize();
    } catch (error) {
      finalizeError = error as Error;
    }
    expect(finalizeError).toBeUndefined();
    expect(handle.state()).toBe("completed");
  }, 20000);
});

describe("网络流空闲与暂停", () => {
  test("非睡眠的真实停滞（无新数据）超阈值判为连接故障并进入网络暂停", async () => {
    const { runtime, provider } = await setupProvider("role-session-network-idle");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    // chunkDelayMs 用真实定时器投递第二块数据；取一个远大于测试断言窗口的值，
    // 确保断言完成前这块数据不会真的抵达（本用例只关心"无数据"期间的空闲判定）。
    scriptReplies(provider, [{ type: "text", text: "分块回复", chunkDelayMs: 2000 }]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 50, watchdogIntervalMs: 100 });
    clock.startGapWatcher();

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("network-idle-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "网络空闲任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      streamIdleTimeoutMs: 200,
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry: new ShellRegistry({ clock }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const pausedNetworkEvents = collect(handle, "paused_network");
    handle.prompt("网络空闲任务");

    // 放行一次真实事件循环，让流的起始事件与空闲监视定时器完成注册
    await new Promise((resolve) => setTimeout(resolve, 50));
    timeSource.advance(250);

    await waitForState(handle, (state) => state === "paused_network", 5000);
    await waitForCount(() => pausedNetworkEvents.length, 1);
    expect(clock.sleepGaps()).toEqual([]);
  }, 20000);

  test("睡眠期间的墙钟跳变经 clock 账本真实判定为睡眠，不触发网络暂停", async () => {
    const { runtime, provider } = await setupProvider("role-session-sleep-gap");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [{ type: "text", text: "分块回复", chunkDelayMs: 2000 }]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 50, watchdogIntervalMs: 100 });
    clock.startGapWatcher();

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("sleep-gap-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "睡眠跳变任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      streamIdleTimeoutMs: 200,
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry: new ShellRegistry({ clock }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const pausedNetworkEvents = collect(handle, "paused_network");
    handle.prompt("睡眠跳变任务");

    await new Promise((resolve) => setTimeout(resolve, 50));
    timeSource.jump(250);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pausedNetworkEvents.length).toBe(0);
    expect(handle.state()).not.toBe("paused_network");
    expect(clock.sleepGaps().length).toBeGreaterThan(0);
  }, 20000);

  test("网络暂停后 resume 触发自动续接，networkGate 记录暂停请求与续跑前的可续跑核查", async () => {
    const { runtime, provider } = await setupProvider("role-session-network-resume");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "text", text: "分块回复", chunkDelayMs: 600 },
      { type: "text", text: "续跑回复" },
    ]);

    const gateSpy = createNetworkGateSpy();

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("network-resume-repo"),
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "网络续接任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      streamIdleTimeoutMs: 200,
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: gateSpy.gate,
    });
    handles.push(handle);

    handle.prompt("网络续接任务");
    await waitForState(handle, (state) => state === "paused_network", 5000);

    expect(gateSpy.requestPauseCalls.some((c) => c.runId === runId && c.reason === "network")).toBe(true);
    const requestsBeforeResume = provider.requests.length;

    await expect(handle.resume()).resolves.toBeUndefined();

    expect(gateSpy.canProceedCalls).toContain(runId);
    expect(gateSpy.gate.canProceed(runId)).toEqual({ allowed: true });
    await waitForCount(() => provider.requests.length, requestsBeforeResume + 1);
  }, 20000);

  test("paused_network 期间 prompt 不产生新的模型请求，resume 后该消息被送达", async () => {
    const { runtime, provider } = await setupProvider("role-session-network-gate-short-circuit");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [{ type: "text", text: "分块回复", chunkDelayMs: 600 }]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("network-gate-short-circuit-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "网络闸门任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      streamIdleTimeoutMs: 200,
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("网络闸门任务");
    await waitForState(handle, (state) => state === "paused_network", 5000);

    const requestsAtPause = provider.requests.length;
    handle.prompt("x");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(provider.requests.length).toBe(requestsAtPause);

    setReplies(provider, [{ type: "text", text: "resume-ack" }]);
    await handle.resume();
    await waitForCount(() => provider.requests.length, requestsAtPause + 1, 5000);
    const resumeRequest = provider.requests.at(-1);
    expect(JSON.stringify(resumeRequest)).toContain("x");
  }, 20000);
});

async function waitForProcessGone(pgid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`进程组 ${pgid} 在 ${timeoutMs}ms 内未消失`);
}

interface GitCountingShim {
  dir: string;
  getCount(): Promise<number>;
}

async function createGitCountingShim(): Promise<GitCountingShim> {
  const dir = await mkdtemp(join(tmpdir(), "git-shim-"));
  tempRoots.push(dir);
  const countFile = join(dir, "git-calls.log");
  await writeFile(countFile, "");
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim();
  const shimPath = join(dir, "git");
  await writeFile(shimPath, `#!/bin/sh\necho called >> "${countFile}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  return {
    dir,
    async getCount() {
      const content = await readFile(countFile, "utf8");
      return content.split("\n").filter((line) => line.trim().length > 0).length;
    },
  };
}

describe("暂停超时与停止确认", () => {
  test("session.abort 无法快速确认时 pause 仍应 stopHost 停止在飞的 bash，并以 confirmed:false 返回原因", async () => {
    const { runtime, provider } = await setupProvider("role-session-pause-stop-timeout");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const pidFile = join(cwd, "bash.pid");

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10` } },
      { type: "text", text: "done" },
    ]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("pause-stop-timeout-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "暂停停止超时任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      // 不注入探针：默认真实 kill，验证 stopHost 真能终止这个进程组
      shellRegistry: new ShellRegistry({ clock }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("暂停停止超时任务");

    let pid: number | undefined;
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      try {
        const content = (await readFile(pidFile, "utf8")).trim();
        if (content) {
          pid = Number(content);
          break;
        }
      } catch {
        // pidFile 尚未写入
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);

    const pausePromise = handle.pause();
    // pause() 内部同步注册 abort 与其自身 5s 超时定时器后才第一次让出事件循环；在此之前
    // 同步把这张表推过 5s，保证超时必然先于 session.abort() 落定，而不必等真实异步进展
    timeSource.advance(5000);
    // 超时分支之后若仍需调用 stopHost，其内部轮询同样经这把注入时钟；继续用时钟泵推进，
    // 不必真实等待
    const pauseOutcome = await withClockPump(timeSource, () =>
      withTimeout(pausePromise, 3000, "pause() 未在合理时间内返回"),
    );

    expect(pauseOutcome.confirmed).toBe(false);
    expect(pauseOutcome.reason).toBeTruthy();
    await waitForProcessGone(pid as number);
  }, 8000);

  test("stop() 返回的 Shell 清理结果在无法确认停止时应反映 uncertain 而非恒为 stopped:true", async () => {
    const { runtime, provider } = await setupProvider("role-session-stop-uncertain");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "sleep 30" } },
      { type: "text", text: "done" },
    ]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const noopKillProbes: ShellRegistryProbes = { kill: () => {} };

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("stop-uncertain-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "停止确认任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry: new ShellRegistry({ clock, probes: noopKillProbes }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("停止确认任务");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const stopOutcome = await withClockPump(timeSource, () =>
      withTimeout(handle.stop(), 3000, "stop() 未在合理时间内返回"),
    );

    expect(JSON.stringify(stopOutcome.shellResults)).toContain("uncertain");

    // 注入的探针只让 ShellRegistry 内部误判"已停止"，真实子进程仍然存活；
    // 全局 process.kill 未被替换，直接用它善后，避免残留 sleep 30
    for (const entry of stopOutcome.shellResults) {
      if (entry.result.ok) {
        try {
          process.kill(-entry.result.task.pgid, "SIGKILL");
        } catch {
          // 组已消失，无需处理
        }
      }
    }
  }, 8000);

  test("pause 的 abort 超时分支确实调用了 stopHost：kill 记录含该任务 pgid（判别力强于仅看进程是否存活）", async () => {
    const { runtime, provider } = await setupProvider("role-session-pause-stophost-recorded");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const pidFile = join(cwd, "bash.pid");

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10` } },
      { type: "text", text: "done" },
    ]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const recordingProbes: ShellRegistryProbes = {
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        // 仍然真实发信号，保证被测的这个任务确实会被清理掉，不残留后台进程
        process.kill(pid, signal);
      },
    };

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("pause-stophost-recorded-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "暂停停止记录任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry: new ShellRegistry({ clock, probes: recordingProbes }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("暂停停止记录任务");

    let pid: number | undefined;
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      try {
        const content = (await readFile(pidFile, "utf8")).trim();
        if (content) {
          pid = Number(content);
          break;
        }
      } catch {
        // pidFile 尚未写入
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);

    const pausePromise = handle.pause();
    timeSource.advance(5000);
    const pauseOutcome = await withClockPump(timeSource, () =>
      withTimeout(pausePromise, 3000, "pause() 未在合理时间内返回"),
    );

    expect(pauseOutcome.confirmed).toBe(false);
    expect(killCalls.some((call) => Math.abs(call.pid) === pid)).toBe(true);
  }, 8000);

  test("工具调用挂死时 stop() 先停止本运行的后台 Shell（真实子进程消失）再对 abort 做有界等待，返回真实 shellResults", async () => {
    const { runtime, provider } = await setupProvider("role-session-stop-stuck-tool");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const pidFile = join(cwd, "bash.pid");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10` } },
      { type: "text", text: "done" },
    ]);

    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const shellRegistry = new ShellRegistry({ clock });
    // 与 daemon/role-session.ts 内部构造的 host 同形，用来直接向 registry 查询任务是否已登记
    const host: Host = { kind: "role", id: runId, role: "worker", runId };

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("stop-stuck-tool-repo"),
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "停止时工具调用挂死任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry,
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("停止时工具调用挂死任务");

    // pidFile 只证明子进程本身已经起来；registry 自己的登记（this.tasks.set）还要再等一次
    // 外部 ps 往返（baselineStartedAt）才落定，两者独立等，否则 stopHost 可能在登记完成前
    // 就把这个任务当成"从未见过"而跳过，白白得到一个看似成功却什么也没停的空结果
    let pid: number | undefined;
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      try {
        const content = (await readFile(pidFile, "utf8")).trim();
        if (content) {
          pid = Number(content);
          break;
        }
      } catch {
        // pidFile 尚未写入
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);

    const registeredDeadline = Date.now() + 2000;
    let registered = false;
    while (Date.now() < registeredDeadline) {
      if (shellRegistry.list(host).some((task) => task.status !== "starting")) {
        registered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(registered).toBe(true);

    try {
      // stopHost 的确认轮询靠真实进程死亡驱动：这里只用 withClockPump 按真实小间隔推进注入时钟，
      // 不再额外一次性 advance(5000)——那样会在同一个同步栈里把整段等待窗口耗尽，
      // SIGTERM 还没来得及被内核真正处理、轮询就已经因为假时钟到期而判定超时，产生 uncertain
      const stopOutcome = await withClockPump(timeSource, () =>
        withTimeout(handle.stop(), 6000, "stop() 未在合理时间内返回"),
      );

      expect(stopOutcome.shellResults.length).toBeGreaterThan(0);
      const entry = stopOutcome.shellResults[0];
      expect(entry?.result.ok).toBe(true);
      if (entry?.result.ok) expect(entry.result.task).not.toMatchObject({ status: "uncertain" });
      await waitForProcessGone(pid as number);
    } finally {
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch {
        // 进程组已消失，无需处理
      }
    }
  }, 8000);
});

describe("只读角色的写入核验", () => {
  test("review kind 角色的 git status 放行，写入判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    await mkdir(join(repo.root, "src"), { recursive: true });
    await writeFile(join(repo.root, "src", "a.ts"), "export const a = 1;\n");

    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "git status" } },
      { type: "toolcall", name: "bash", input: { command: "echo x >> src/a.ts" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "只读核验任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "review" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    const failedEvents = collect(handle, "failed");
    handle.prompt("只读核验任务");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(false);

    await waitForState(handle, (state) => state === "failed", 15000);
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain("src/a.ts");
  }, 20000);

  test("acceptance 写指定报告路径放行，写其它路径判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-acceptance");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const reportPath = join(cwd, "report.md");
    const otherPath = join(cwd, "other.txt");
    const role = await writeRoleEntry({ name: "acceptance", kind: "acceptance", tools: ["bash", "write"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo report > ${reportPath}` } },
      { type: "toolcall", name: "bash", input: { command: `echo other > ${otherPath}` } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("acceptance-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "acceptance",
      role,
      task: "验收只读核验任务",
      readPaths: [cwd],
      writePaths: [],
      reportPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "acceptance" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    const failedEvents = collect(handle, "failed");
    handle.prompt("验收只读核验任务");

    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(handle.state()).not.toBe("failed");

    await waitForState(handle, (state) => state === "failed", 15000);
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain(otherPath);
  }, 20000);

  test("reviewer 从不提交结构化结果时判定为失败并说明未提交", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-never-submit");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "git status" } },
      { type: "text", text: "核验完成，未发现问题" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-never-submit-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "从不提交任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    const idleEvents = collect(handle, "idle");
    handle.prompt("从不提交任务");

    // 新合同：自然结束回合但未提交时会话保持 running 并 emit idle，不自行结算；
    // 由调用方决定何时经 finalize() 收尾
    await waitForCount(() => idleEvents.length, 1, 3000);
    expect(handle.state()).toBe("running");

    let finalizeError: Error | undefined;
    try {
      await handle.finalize();
    } catch (error) {
      finalizeError = error as Error;
    }

    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0]) + (finalizeError?.message ?? "")).toContain("未提交");
  }, 8000);

  test("acceptance 从不提交结构化结果时判定为失败并说明未提交", async () => {
    const { runtime, provider } = await setupProvider("role-session-acceptance-never-submit");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const reportPath = join(cwd, "report.md");
    const role = await writeRoleEntry({ name: "acceptance", kind: "acceptance", tools: ["bash", "write"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo report > ${reportPath}` } },
      { type: "text", text: "验收完成" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("acceptance-never-submit-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "acceptance",
      role,
      task: "验收从不提交任务",
      readPaths: [cwd],
      writePaths: [],
      reportPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    const idleEvents = collect(handle, "idle");
    handle.prompt("验收从不提交任务");

    await waitForCount(() => idleEvents.length, 1, 3000);
    expect(handle.state()).toBe("running");

    let finalizeError: Error | undefined;
    try {
      await handle.finalize();
    } catch (error) {
      finalizeError = error as Error;
    }

    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0]) + (finalizeError?.message ?? "")).toContain("未提交");
  }, 8000);

  test("readPaths 下存在 node_modules 子树时 git status 仍快速放行且不误报", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-node-modules");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const nodeModulesDir = join(repo.root, "node_modules", "some-pkg");
    await mkdir(nodeModulesDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await writeFile(join(nodeModulesDir, `file-${i}.js`), `module.exports = ${i};\n`);
    }
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "git status" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-node-modules-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "含 node_modules 的只读核验任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    const failedEvents = collect(handle, "failed");

    const startedAt = Date.now();
    handle.prompt("含 node_modules 的只读核验任务");

    await waitForCount(() => toolEnds.length, 1);
    const elapsedMs = Date.now() - startedAt;

    expect(toolEnds[0]?.isError).toBe(false);
    expect(elapsedMs).toBeLessThan(2000);
    expect(failedEvents.length).toBe(0);
    expect(handle.state()).not.toBe("failed");
  }, 20000);

  test("只读角色经 bash 重定向写入 .git/hooks/pre-commit 判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-git-hooks");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "echo pwned > .git/hooks/pre-commit" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-git-hooks-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "写入 git hooks 任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("写入 git hooks 任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain(".git/hooks/pre-commit");
  }, 20000);

  test("只读角色经 bash 重定向写入 node_modules/.bin/tool 判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-node-modules-bin");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "mkdir -p node_modules/.bin && echo pwned > node_modules/.bin/tool" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-node-modules-bin-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "写入 node_modules/.bin 任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("写入 node_modules/.bin 任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain("node_modules/.bin/tool");
  }, 20000);

  test("只读角色经 git config core.hooksPath 指向仓库外目录并放置 pre-commit 判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-hookspath");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const externalHooksDir = await tempCwd();
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      {
        type: "toolcall",
        name: "bash",
        input: { command: `git config core.hooksPath ${externalHooksDir} && echo pwned > ${externalHooksDir}/pre-commit` },
      },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-hookspath-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "core.hooksPath 绕过任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("core.hooksPath 绕过任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toMatch(/\.git\/config|hooksPath/);
  }, 20000);

  test("readPaths 为仓库子目录（<repo>/src）时写入 .git/hooks/pre-commit 仍以仓库根定点纳入并判违规", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-subtree-hooks");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    await mkdir(join(repo.root, "src"), { recursive: true });
    await writeFile(join(repo.root, "src", "a.ts"), "export const a = 1;\n");
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "echo pwned > .git/hooks/pre-commit" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-subtree-hooks-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "子树只读范围任务",
      readPaths: [join(repo.root, "src")],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("子树只读范围任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain(".git/hooks/pre-commit");
  }, 20000);

  test("git status 触发的 core.untrackedCache 等调优项写入不误判为违规", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-untracked-cache");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "git status" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-untracked-cache-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "git status 噪声任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("git status 噪声任务");

    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");
    expect(failedEvents.length).toBe(0);
  }, 20000);

  test("linked worktree 下写入主仓 <common>/hooks/pre-commit 判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-worktree-hooks");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });
    const hooksTarget = join(repo.root, ".git", "hooks", "pre-commit");

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo pwned > ${hooksTarget}` } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("worktree-hooks-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: worktree.root,
      roleName: "reviewer",
      role,
      task: "worktree 写主仓 hooks 任务",
      readPaths: [worktree.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("worktree 写主仓 hooks 任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toMatch(/hooks/);
  }, 20000);

  test("linked worktree 下写入主仓 <common>/info/attributes 判违规并结束会话", async () => {
    const { runtime, provider } = await setupProvider("role-session-worktree-attributes");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const worktree = await addWorktree(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });
    const attributesTarget = join(repo.root, ".git", "info", "attributes");

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo "* -text" > ${attributesTarget}` } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("worktree-attributes-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: worktree.root,
      roleName: "reviewer",
      role,
      task: "worktree 写主仓 info/attributes 任务",
      readPaths: [worktree.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("worktree 写主仓 info/attributes 任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toMatch(/attributes/);
  }, 20000);

  const GIT_CONFIG_BLACKLIST_CASES: Array<{ label: string; command: string }> = [
    { label: "credential.helper", command: "git config credential.helper '!f(){ :; }; f'" },
    { label: "core.sshCommand", command: "git config core.sshCommand x" },
    { label: "filter.evil.clean", command: "git config filter.evil.clean x" },
    { label: "diff.evil.command", command: "git config diff.evil.command x" },
  ];

  for (const testCase of GIT_CONFIG_BLACKLIST_CASES) {
    test(`只读角色写入 git config ${testCase.label} 判违规并结束会话`, async () => {
      const { runtime, provider } = await setupProvider(`role-session-config-${testCase.label}`);
      const home = await createTempHome();
      tempHomes.push(home);
      const repo = await createRepoFixture();
      repoFixtures.push(repo);
      const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

      scriptReplies(provider, [
        { type: "toolcall", name: "bash", input: { command: testCase.command } },
        { type: "toolcall", name: "structured_output", input: validWorkObject() },
        { type: "text", text: "done" },
      ]);

      const handle = await createRoleSession({
        dataRoot: home.dataRoot,
        repoId: testRepoId(`config-${testCase.label}-repo`),
        runId: uuidv7(),
        shellToken: randomUUID(),
        cwd: repo.root,
        roleName: "reviewer",
        role,
        task: `写入 git config ${testCase.label} 任务`,
        readPaths: [repo.root],
        writePaths: [],
        contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
        runtime,
        modelRef: { provider: provider.providerId, id: provider.modelId },
        clock: createClock(),
        shellRegistry: new ShellRegistry({ clock: createClock() }),
        guards: createGuards(),
        networkGate: new NetworkPauseGate(),
      });
      handles.push(handle);

      const failedEvents = collect(handle, "failed");
      handle.prompt(`写入 git config ${testCase.label} 任务`);

      await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
      expect(handle.state()).toBe("failed");
      await waitForCount(() => failedEvents.length, 1);
    }, 20000);
  }

  test("审查者执行 git config --global core.hooksPath 指向仓库外目录判违规", async () => {
    const { runtime, provider } = await setupProvider("role-session-global-hookspath");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    // 独立的假 HOME，避免 git config --global 写到真实的 ~/.gitconfig
    const fakeHome = await tempCwd();
    const externalDir = await tempCwd();
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `git config --global core.hooksPath ${externalDir}` } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("global-hookspath-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "全局 hooksPath 任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const failedEvents = collect(handle, "failed");
      handle.prompt("全局 hooksPath 任务");

      await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
      expect(handle.state()).toBe("failed");
      await waitForCount(() => failedEvents.length, 1);
      expect(JSON.stringify(failedEvents[0])).toMatch(/hooksPath/);
    } finally {
      process.env.HOME = originalHome;
    }
  }, 20000);

  test("core.hooksPath 为相对路径时按工作树顶层解析，会话 cwd 在子目录下写入仍判违规", async () => {
    const { runtime, provider } = await setupProvider("role-session-relative-hookspath");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repo.root });
    const subdir = join(repo.root, "src");
    await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, "a.ts"), "export const a = 1;\n");
    const hooksTarget = join(repo.root, ".githooks", "pre-commit");
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `mkdir -p ${dirname(hooksTarget)} && echo pwned > ${hooksTarget}` } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("relative-hookspath-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: subdir,
      roleName: "reviewer",
      role,
      task: "相对 hooksPath 任务",
      readPaths: [subdir],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    handle.prompt("相对 hooksPath 任务");

    await waitForState(handle, (state) => state === "failed" || state === "completed", 5000);
    expect(handle.state()).toBe("failed");
    await waitForCount(() => failedEvents.length, 1);
    expect(JSON.stringify(failedEvents[0])).toContain(".githooks");
  }, 20000);
});

describe("终态守卫", () => {
  async function completedWorkerSession(repoId: string) {
    const { runtime, provider } = await setupProvider(`role-session-${repoId}`);
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId(repoId),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "终态守卫任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });

    handle.prompt("终态守卫任务");
    await handle.result();
    expect(handle.state()).toBe("completed");
    return { handle, provider };
  }

  test("completed 后调用 pause 不改变终态", async () => {
    const { handle } = await completedWorkerSession("terminal-guard-pause");
    const pauseOutcome = await handle.pause();
    expect(pauseOutcome).toBeTruthy();
    expect(handle.state()).toBe("completed");
    handle.dispose();
  }, 20000);

  test("completed 后调用 stop 不把状态改为 stopped", async () => {
    const { handle } = await completedWorkerSession("terminal-guard-stop");
    const stopOutcome = await handle.stop();
    expect(stopOutcome).toBeTruthy();
    expect(handle.state()).toBe("completed");
    handle.dispose();
  }, 20000);

  test("completed 后 prompt 不发起新的模型请求且不抛出异常", async () => {
    const { handle, provider } = await completedWorkerSession("terminal-guard-prompt");
    const requestsBefore = provider.requests.length;
    expect(() => handle.prompt("completed 后不该发起新请求")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.requests.length).toBe(requestsBefore);
    handle.dispose();
  }, 20000);

  test("completed 后 dispose 不抛错", async () => {
    const { handle } = await completedWorkerSession("terminal-guard-dispose");
    expect(() => handle.dispose()).not.toThrow();
  }, 20000);
});

describe("会话文件落盘", () => {
  test("会话文件与系统提示均不含受控 provider 使用的凭据字符串", async () => {
    const { runtime, provider } = await setupProvider("role-session-credential");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const repoId = testRepoId("credential-repo");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId,
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "凭据不泄漏任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("凭据不泄漏任务");
    await handle.result();

    const raw = sessionJson({ dataRoot: home.dataRoot, repoId, runId });
    expect(raw).not.toContain(CONTROLLED_API_KEY);

    const requestsText = provider.requests
      .map((ctx) => `${ctx.systemPrompt ?? ""}\n${JSON.stringify(ctx.messages)}`)
      .join("\n");
    expect(requestsText).not.toContain(CONTROLLED_API_KEY);
  }, 20000);
});

describe("会话隔离", () => {
  test("同进程两个 worker 会话的请求上下文互不串扰", async () => {
    const { runtime, provider } = await setupProvider("role-session-isolation");
    const home = await createTempHome();
    tempHomes.push(home);
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    const cwdA = await tempCwd();
    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done-a" },
    ]);
    const handleA = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("isolation-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: cwdA,
      roleName: "worker",
      role,
      task: "isolate-marker-A",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handleA);
    handleA.prompt("isolate-marker-A");
    await handleA.result();

    const cwdB = await tempCwd();
    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done-b" },
    ]);
    const handleB = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("isolation-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: cwdB,
      roleName: "worker",
      role,
      task: "isolate-marker-B",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handleB);
    handleB.prompt("isolate-marker-B");
    await handleB.result();

    const requests = provider.requests.map((ctx) => JSON.stringify(ctx));
    const aRequests = requests.filter((r) => r.includes("isolate-marker-A"));
    const bRequests = requests.filter((r) => r.includes("isolate-marker-B"));
    expect(aRequests.length).toBeGreaterThan(0);
    expect(bRequests.length).toBeGreaterThan(0);
    for (const r of aRequests) expect(r).not.toContain("isolate-marker-B");
    for (const r of bRequests) expect(r).not.toContain("isolate-marker-A");
  }, 20000);
});

describe("网络暂停恢复的一致性与异常安全", () => {
  // session.abort 由 createAgentSession 内部创建、未对外暴露引用，黑盒测试无法注入一个会拒绝的替身；
  // 本用例仅覆盖可验证的部分：resume 后 state 与 networkGate 的一致性、以及该流程本身不产生未处理异常
  test("网络暂停后 resume：state 与 networkGate.canProceed 一致，过程不产生未处理异常", async () => {
    const { runtime, provider } = await setupProvider("role-session-network-consistency");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const file1 = join(cwd, "file1.txt");
    await writeFile(file1, "初始内容");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["read", "bash"] });
    const runId = uuidv7();

    scriptReplies(provider, [{ type: "text", text: "分块回复", chunkDelayMs: 2000 }]);

    const gate = new NetworkPauseGate();
    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("network-consistency-repo"),
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "网络一致性任务",
      readPaths: [file1],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      streamIdleTimeoutMs: 200,
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: gate,
    });
    handles.push(handle);

    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount += 1;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      handle.prompt("网络一致性任务");
      await waitForState(handle, (state) => state === "paused_network", 5000);
      expect(gate.canProceed(runId).allowed).toBe(false);

      setReplies(provider, [
        { type: "toolcall", name: "read", input: { path: file1 } },
        { type: "toolcall", name: "structured_output", input: validWorkObject() },
        { type: "text", text: "resume-ack" },
      ]);
      await handle.resume();

      expect(["running", "completed"]).toContain(handle.state());
      expect(gate.canProceed(runId).allowed).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandledCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20000);
});

describe("性能：只读角色单条命令的 git 子进程数", () => {
  test("单条 git status 命令前后触发的 git 子进程数应 ≤ 4（配置快照合并为一次调用）", async () => {
    const { runtime, provider } = await setupProvider("role-session-git-subprocess-count");
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "grep", "find", "ls", "bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: "git status" } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("git-subprocess-count-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd: repo.root,
      roleName: "reviewer",
      role,
      task: "git 子进程计数任务",
      readPaths: [repo.root],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    const shim = await createGitCountingShim();
    const originalPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${originalPath}`;

    try {
      const countBefore = await shim.getCount();
      handle.prompt("git 子进程计数任务");
      await waitForCount(() => toolEnds.length, 1, 5000);
      const countAfter = await shim.getCount();
      expect(countAfter - countBefore).toBeLessThanOrEqual(4);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20000);
});

describe("用户停止是独立终态", () => {
  test("运行中（未提交）调用 stop()：终态为 stopped，不判 failed/completed，result 含'停止'不含 aborted，已产生成果与会话记录保留", async () => {
    const { runtime, provider } = await setupProvider("role-session-stop-running-unsubmitted");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const outputFile = join(cwd, "output.txt");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["write", "bash"] });
    const repoId = testRepoId("stop-running-unsubmitted-repo");
    const runId = uuidv7();

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: outputFile, content: "已完成的成果" } },
      { type: "toolcall", name: "bash", input: { command: "sleep 10" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId,
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "运行中停止任务",
      readPaths: [],
      writePaths: [outputFile],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const failedEvents = collect(handle, "failed");
    const toolEnds = collect(handle, "tool_end") as Array<{ toolName?: string }>;
    handle.prompt("运行中停止任务");

    await waitForCount(() => toolEnds.length, 1, 5000);
    // 留出真实时间让第二轮的 bash sleep 真正 spawn 起来，确保 stop() 命中的是一次真正在飞的操作
    await new Promise((resolve) => setTimeout(resolve, 250));

    await handle.stop();

    expect((handle.state() as string)).toBe("stopped");
    expect(failedEvents.some((event) => JSON.stringify(event).includes("aborted"))).toBe(false);

    let resultMessage: string;
    try {
      const value = await handle.result();
      resultMessage = JSON.stringify(value);
    } catch (error) {
      resultMessage = (error as Error).message;
    }
    expect(resultMessage).toContain("停止");
    expect(resultMessage).not.toContain("aborted");

    const written = await readFile(outputFile, "utf8");
    expect(written).toBe("已完成的成果");
    const raw = sessionJson({ dataRoot: home.dataRoot, repoId, runId });
    expect(raw.length).toBeGreaterThan(0);
  }, 20000);

  test("已提交结构化结果后调用 stop()：终态同样为 stopped，不得把该提交当作被采纳", async () => {
    const { runtime, provider } = await setupProvider("role-session-stop-after-submit");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("stop-after-submit-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "worker",
      role,
      task: "已提交后停止任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    let stopPromise: Promise<unknown> | undefined;
    handle.events.on("tool_end", (event: { toolName?: string }) => {
      if (!stopPromise && event?.toolName === "structured_output") stopPromise = handle.stop();
    });

    handle.prompt("已提交后停止任务");
    await waitForCount(() => stopPromise !== undefined, 1);
    await stopPromise;

    expect((handle.state() as string)).toBe("stopped");
    expect((handle.state() as string)).not.toBe("completed");

    let resultMessage: string;
    let resolved = false;
    try {
      const value = await handle.result();
      resolved = true;
      resultMessage = JSON.stringify(value);
    } catch (error) {
      resultMessage = (error as Error).message;
    }
    // 即便模型已提交了合法结果，被 stop() 抢先中止的这次运行也不能被判定为"通过"：
    // 要么根本不 resolve（reject），要么 resolve 的值不能等同于那份被提交的结构化对象
    if (resolved) {
      expect(resultMessage).not.toContain("\"phase\":\"work\"");
    }
    expect(resultMessage).toContain("停止");
    expect(resultMessage).not.toContain("aborted");
  }, 20000);
});

describe("终态清理", () => {
  test("运行经提交自然 completed 后，登记的后台 Shell 已被真正停止且注册表中该任务为终态", async () => {
    const { runtime, provider } = await setupProvider("role-session-terminal-cleanup");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const pidFile = join(cwd, "bg.pid");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const runId = uuidv7();
    const roleName = "worker";

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10`, background: true } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const clock = createClock();
    const shellRegistry = new ShellRegistry({ clock });
    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("terminal-cleanup-repo"),
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName,
      role,
      task: "终态清理任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry,
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("终态清理任务");
    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");

    let pid: number | undefined;
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      try {
        const content = (await readFile(pidFile, "utf8")).trim();
        if (content) {
          pid = Number(content);
          break;
        }
      } catch {
        // pidFile 尚未写入
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);

    try {
      await waitForProcessGone(pid as number);
      const host: Host = { kind: "role", id: runId, role: roleName, runId };
      const endedCount = () => shellRegistry.list(host).filter((task) => task.activity === "ended").length;
      await waitForCount(endedCount, shellRegistry.list(host).length, 5000);
      expect(shellRegistry.list(host).filter((task) => task.activity !== "ended")).toEqual([]);
    } finally {
      // 兜底杀掉后台进程组，避免断言失败时留下残留
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch {
        // 组已消失，无需处理
      }
    }
  }, 20000);

  test("终态之后再次调用 stop()：shellResults 反映真实清理结果，不恒为 {stopped:true, shellResults:[]}", async () => {
    const { runtime, provider } = await setupProvider("role-session-terminal-stop-again");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const pidFile = join(cwd, "bg.pid");
    const role = await writeRoleEntry({ name: "worker", kind: "work", tools: ["bash"] });
    const runId = uuidv7();
    const roleName = "worker";

    scriptReplies(provider, [
      { type: "toolcall", name: "bash", input: { command: `echo $$ > ${pidFile} && sleep 10`, background: true } },
      { type: "toolcall", name: "structured_output", input: validWorkObject() },
      { type: "text", text: "done" },
    ]);

    const clock = createClock();
    const shellRegistry = new ShellRegistry({ clock });
    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("terminal-stop-again-repo"),
      runId,
      shellToken: randomUUID(),
      cwd,
      roleName,
      role,
      task: "终态后再停止任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "work" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock,
      shellRegistry,
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    handle.prompt("终态后再停止任务");
    const result = await withTimeout(handle.result(), 5000, "超时等待 result() 兑现");
    expect(result).toBeTruthy();
    expect(handle.state()).toBe("completed");

    let pid: number | undefined;
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      try {
        const content = (await readFile(pidFile, "utf8")).trim();
        if (content) {
          pid = Number(content);
          break;
        }
      } catch {
        // pidFile 尚未写入
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);
    try {
      // 终态结算本身应已把这个后台任务真正停掉，此时它已不在存活状态
      await waitForProcessGone(pid as number);

      const stopOutcome = await handle.stop();
      // 该任务此刻早已不是"从未注册过"，真实反映结果不能是恒定的空 shellResults；
      // 至少应能看到它已处于终态（例如 exited/stopped/timed_out/uncertain 之一）
      expect(JSON.stringify(stopOutcome.shellResults)).not.toBe("[]");
    } finally {
      try {
        process.kill(-(pid as number), "SIGKILL");
      } catch {
        // 组已消失，无需处理
      }
    }
  }, 20000);
});

describe("验收者写入范围限定为指定报告路径", () => {
  test("acceptance 会话对 reportPath 的 write 放行并落盘，写其它路径被拒绝", async () => {
    const { runtime, provider } = await setupProvider("role-session-acceptance-report-path");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "acceptance", kind: "acceptance", tools: ["read", "write", "bash"] });
    const reportPath = join(cwd, "acceptance-report.md");
    const otherPath = join(cwd, "not-report.md");

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: reportPath, content: "验收报告内容" } },
      { type: "toolcall", name: "write", input: { path: otherPath, content: "不该写入" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("acceptance-report-path-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "acceptance",
      role,
      task: "验收报告任务",
      readPaths: [],
      writePaths: [reportPath, otherPath],
      reportPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "acceptance" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("验收报告任务");

    await waitForCount(() => toolEnds.length, 2);
    expect(toolEnds[0]?.isError).toBe(false);
    expect(toolEnds[1]?.isError).toBe(true);

    const written = await readFile(reportPath, "utf8");
    expect(written).toBe("验收报告内容");
    await expect(readFile(otherPath, "utf8")).rejects.toBeTruthy();
  }, 20000);

  test("reviewer 会话对任意路径的 write 仍被拒绝，即便该路径就是注入的 reportPath", async () => {
    const { runtime, provider } = await setupProvider("role-session-reviewer-write-still-blocked");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "reviewer", kind: "review", tools: ["read", "write", "bash"] });
    const targetPath = join(cwd, "should-not-write.md");

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: targetPath, content: "不该写入" } },
      { type: "text", text: "done" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("reviewer-write-still-blocked-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "reviewer",
      role,
      task: "只读审查任务",
      readPaths: [],
      writePaths: [targetPath],
      reportPath: targetPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "review" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("只读审查任务");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    await expect(readFile(targetPath, "utf8")).rejects.toBeTruthy();
  }, 20000);

  test("reportPath 本身直接位于会话 cwd 之外时拒绝写入，宽松 guards 不得放行", async () => {
    const { runtime, provider } = await setupProvider("role-session-acceptance-reportpath-outside-cwd");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "acceptance", kind: "acceptance", tools: ["read", "write", "bash"] });
    const outsideRoot = await mkdtemp(join(tmpdir(), "role-session-outside-"));
    tempRoots.push(outsideRoot);
    const outsideReportPath = join(outsideRoot, "direct-report.md");

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: outsideReportPath, content: "尝试写入 cwd 外" } },
      { type: "text", text: "done" },
    ]);

    const alwaysAllowGuards = {
      async checkWrite() {
        return { ok: true as const };
      },
      async fingerprint(paths: string[]): Promise<Record<string, string>> {
        return Object.fromEntries(paths.map((p) => [p, "unchanged"]));
      },
      async verifyFingerprint(): Promise<Array<{ path: string }>> {
        return [];
      },
    };

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("acceptance-reportpath-outside-cwd-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "acceptance",
      role,
      task: "验收报告任务（reportPath 在 cwd 外）",
      readPaths: [],
      writePaths: [outsideReportPath],
      reportPath: outsideReportPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "acceptance" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: alwaysAllowGuards,
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("验收报告任务（reportPath 在 cwd 外）");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    await expect(readFile(outsideReportPath, "utf8")).rejects.toBeTruthy();
  }, 20000);

  test("reportPath 落在 cwd 内但经符号链接指向仓库外时拒绝写入，即便写入目标与 reportPath 逐字相同，宽松 guards 不得放行", async () => {
    const { runtime, provider } = await setupProvider("role-session-acceptance-reportpath-symlink-outside");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "acceptance", kind: "acceptance", tools: ["read", "write", "bash"] });
    const outsideRoot = await mkdtemp(join(tmpdir(), "role-session-outside-"));
    tempRoots.push(outsideRoot);
    const actualTarget = join(outsideRoot, "actual-report.md");
    await writeFile(actualTarget, "");
    const symlinkReportPath = join(cwd, "linked-report.md");
    await symlink(actualTarget, symlinkReportPath);

    scriptReplies(provider, [
      { type: "toolcall", name: "write", input: { path: symlinkReportPath, content: "尝试经符号链接写入仓库外" } },
      { type: "text", text: "done" },
    ]);

    const alwaysAllowGuards = {
      async checkWrite() {
        return { ok: true as const };
      },
      async fingerprint(paths: string[]): Promise<Record<string, string>> {
        return Object.fromEntries(paths.map((p) => [p, "unchanged"]));
      },
      async verifyFingerprint(): Promise<Array<{ path: string }>> {
        return [];
      },
    };

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("acceptance-reportpath-symlink-outside-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "acceptance",
      role,
      task: "验收报告任务（reportPath 经符号链接指向仓库外）",
      readPaths: [],
      writePaths: [symlinkReportPath],
      reportPath: symlinkReportPath,
      contract: { kind: "structured", outputSchema: WORK_SCHEMA, expectedPhase: "acceptance" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: alwaysAllowGuards,
      networkGate: new NetworkPauseGate(),
    });
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ isError?: boolean }>;
    handle.prompt("验收报告任务（reportPath 经符号链接指向仓库外）");
    await waitForCount(() => toolEnds.length, 1);
    expect(toolEnds[0]?.isError).toBe(true);
    const outsideContent = await readFile(actualTarget, "utf8");
    expect(outsideContent).toBe("");
  }, 20000);
});

describe("kind:plan 角色的输出契约", () => {
  test("回合以纯文字结束即 completed，不要求 structured_output 提交", async () => {
    const { runtime, provider } = await setupProvider("role-session-plan-kind");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "planner", kind: "plan", tools: ["read", "write"] });

    scriptReplies(provider, [{ type: "text", text: "已核对任务骨架，规划完成" }]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("plan-kind-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "planner",
      role,
      task: "规划任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "plain", completion: "complete-on-idle" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    } as never);
    handles.push(handle);

    handle.prompt("规划任务");
    const result = await withTimeout(handle.result(), 10_000, "kind:plan 会话未在时限内结束");

    expect(handle.state()).toBe("completed");
    expect((result as { verdict?: unknown } | undefined)?.verdict).toBeUndefined();
    expect((result as { binding?: unknown } | undefined)?.binding).toBeUndefined();
  }, 15000);

  test("提交工具（structured_output）对 kind:plan 会话不存在：脚本调用它会被当作未知工具处理", async () => {
    const { runtime, provider } = await setupProvider("role-session-plan-no-submit-tool");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "planner", kind: "plan", tools: ["read", "write"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: { phase: "plan" } },
      { type: "text", text: "已完成规划" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("plan-no-submit-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "planner",
      role,
      task: "规划任务（尝试误用提交工具）",
      readPaths: [],
      writePaths: [],
      contract: { kind: "plain", completion: "complete-on-idle" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    } as never);
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ toolName?: string; isError?: boolean }>;
    handle.prompt("规划任务（尝试误用提交工具）");
    await withTimeout(handle.result(), 10_000, "kind:plan 会话未在时限内结束");

    const submitAttempt = toolEnds.find((event) => event.toolName === "structured_output");
    expect(submitAttempt?.isError).toBe(true);
  }, 15000);
});

describe("无契约角色（kind manage 且未传 outputSchema）不构造提交通道", () => {
  test("createRoleSession 不注册 structured_output、不构造结果收集器，回合以纯文字结束即 completed", async () => {
    const { runtime, provider } = await setupProvider("role-session-no-contract");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "coordinator", kind: "manage", tools: ["read"] });

    scriptReplies(provider, [
      { type: "toolcall", name: "structured_output", input: {} },
      { type: "text", text: "已处理完毕" },
    ]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("no-contract-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "coordinator",
      role,
      task: "无契约任务",
      readPaths: [],
      writePaths: [],
      contract: { kind: "plain", completion: "complete-on-idle" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    } as never);
    handles.push(handle);

    const toolEnds = collect(handle, "tool_end") as Array<{ toolName?: string; isError?: boolean }>;
    handle.prompt("无契约任务");
    await withTimeout(handle.result(), 10_000, "无契约会话未在时限内结束");

    const submitAttempt = toolEnds.find((event) => event.toolName === "structured_output");
    expect(submitAttempt?.isError).toBe(true);
    expect(handle.state()).toBe("completed");
  }, 15000);

  test("completion:idle-only 时纯文字结束只发 idle，保持 running 而非自动 completed", async () => {
    const { runtime, provider } = await setupProvider("role-session-no-contract-no-autocomplete");
    const home = await createTempHome();
    tempHomes.push(home);
    const cwd = await tempCwd();
    const role = await writeRoleEntry({ name: "coordinator", kind: "manage", tools: ["read"] });

    scriptReplies(provider, [{ type: "text", text: "仍在推进" }]);

    const handle = await createRoleSession({
      dataRoot: home.dataRoot,
      repoId: testRepoId("no-contract-no-autocomplete-repo"),
      runId: uuidv7(),
      shellToken: randomUUID(),
      cwd,
      roleName: "coordinator",
      role,
      task: "无契约任务（关闭自动完成）",
      readPaths: [],
      writePaths: [],
      contract: { kind: "plain", completion: "idle-only" },
      runtime,
      modelRef: { provider: provider.providerId, id: provider.modelId },
      clock: createClock(),
      shellRegistry: new ShellRegistry({ clock: createClock() }),
      guards: createGuards(),
      networkGate: new NetworkPauseGate(),
    } as never);
    handles.push(handle);

    const idleEvents = collect(handle, "idle");
    handle.prompt("无契约任务（关闭自动完成）");
    await waitForCount(() => idleEvents.length, 1);

    expect(handle.state()).toBe("running");
  }, 15000);
});
