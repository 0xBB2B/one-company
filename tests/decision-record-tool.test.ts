import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity, requirementDataDir } from "../runtime/identity.ts";
import decisionRecordExtension, { describeReceipt } from "../extensions/decision-record.ts";

const REQUIREMENT = "2026-09-08.fixture";

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const plainDirs: string[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const dir of plainDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function createFakePi() {
  const registered: any[] = [];
  const pi = {
    registerTool(tool: any) {
      registered.push(tool);
    },
    on() {},
  };
  return { pi, registered };
}

function registerAndGet() {
  const { pi, registered } = createFakePi();
  decisionRecordExtension(pi as unknown as ExtensionAPI);
  const def = registered.find((tool) => tool.name === "decision_record");
  if (!def) throw new Error("decision_record 未注册");
  return def;
}

function fakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    ui: {} as ExtensionContext["ui"],
    mode: "print",
    hasUI: false,
    cwd: "/",
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    ...overrides,
  } as ExtensionContext;
}

function validAiParams(overrides: Record<string, unknown> = {}) {
  return {
    requirement: REQUIREMENT,
    actor: "ai",
    source: "main-session",
    trigger: "选型讨论",
    decision: "采用方案 A",
    alternatives: ["方案 B"],
    effects: ["architecture"],
    scope: "订单模块",
    basis: ["性能测试结果"],
    action: "更新实施计划",
    ...overrides,
  };
}

function validUserParams(overrides: Record<string, unknown> = {}) {
  return {
    requirement: REQUIREMENT,
    actor: "user",
    source: "main-session",
    trigger: "确认范围",
    decision: "缩小范围至 MVP",
    alternatives: ["保留全部范围"],
    effects: ["scope"],
    impact: "后续迭代补齐剩余范围",
    ...overrides,
  };
}

async function withTempEnv<T>(home: Awaited<ReturnType<typeof createTempHome>>, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home.home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
}

describe("decision_record 工具注册", () => {
  test("注册名为 decision_record 的工具", () => {
    const def = registerAndGet();
    expect(def.name).toBe("decision_record");
  });
});

describe("decision_record 参数 schema", () => {
  test("additionalProperties 为 false", () => {
    const def = registerAndGet();
    expect((def.parameters as any).additionalProperties).toBe(false);
  });

  test("effects 字段 minItems 为 1", () => {
    const def = registerAndGet();
    expect((def.parameters as any).properties.effects.minItems).toBe(1);
  });

  test("合法 AI 决定参数通过 schema 校验", () => {
    const def = registerAndGet();
    expect(Value.Check(def.parameters, validAiParams())).toBe(true);
  });

  test("合法用户决定参数通过 schema 校验", () => {
    const def = registerAndGet();
    expect(Value.Check(def.parameters, validUserParams())).toBe(true);
  });

  test("含未知字段的参数被 schema 拒绝", () => {
    const def = registerAndGet();
    expect(Value.Check(def.parameters, validAiParams({ unknownField: "x" }))).toBe(false);
  });

  test("effects 为空数组的参数被 schema 拒绝", () => {
    const def = registerAndGet();
    expect(Value.Check(def.parameters, validAiParams({ effects: [] }))).toBe(false);
  });

  test("trigger 缺失时被 schema 拒绝，无法记录未回答的问题", () => {
    const def = registerAndGet();
    const params = validAiParams() as Record<string, unknown>;
    delete params.trigger;
    expect(Value.Check(def.parameters, params)).toBe(false);
  });

  test("decision 缺失时被 schema 拒绝，无法记录未回答的问题", () => {
    const def = registerAndGet();
    const params = validAiParams() as Record<string, unknown>;
    delete params.decision;
    expect(Value.Check(def.parameters, params)).toBe(false);
  });
});

describe("decision_record execute", () => {
  test("成功记录 AI 决定并返回含位置与行号的回执文本", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });

    const result = await withTempEnv(home, () => def.execute("call-1", validAiParams(), undefined, undefined, ctx));

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith("已记录 AI-001")).toBe(true);
    expect(text).toContain("ai-decisions.jsonl");
    expect(text).toMatch(/第\s*1\s*行/);
  });

  test("含未知字段的参数执行时返回 isError 且不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });

    const result = await withTempEnv(home, () => def.execute("call-1", validAiParams({ unknownField: "x" }), undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
  });

  test("effects 为空数组的参数执行时返回 isError 且不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });

    const result = await withTempEnv(home, () => def.execute("call-1", validAiParams({ effects: [] }), undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
  });

  test("AI 决定缺少 action 时 execute 返回 isError 且内容含原因，不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });
    const params = validAiParams() as Record<string, unknown>;
    delete params.action;

    const result = await withTempEnv(home, () => def.execute("call-1", params, undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("用户决定携带 basis 时 execute 返回 isError 且内容含原因，不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });
    const params = validUserParams({ basis: ["不应出现"] });

    const result = await withTempEnv(home, () => def.execute("call-1", params, undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("cwd 非 Git 目录时 execute 返回 isError 且内容含原因，不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const plainDir = await mkdtemp(join(tmpdir(), "pi-company-plain-"));
    plainDirs.push(plainDir);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: plainDir });

    const result = await withTempEnv(home, () => def.execute("call-1", validAiParams(), undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/不是 Git 仓库/);
  });

  test("台账损坏时 execute 返回 isError 且内容含原因，不抛出", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });

    const first = await withTempEnv(home, () => def.execute("call-1", validAiParams(), undefined, undefined, ctx));
    const ledgerPath = (first.details as any).receipt.ledgerPath as string;
    await appendFile(ledgerPath, '{"broken": true, "x": 1}\n', "utf8");

    const result = await withTempEnv(home, () => def.execute("call-1", validAiParams(), undefined, undefined, ctx));

    expect((result as any).details.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("已中止的 AbortSignal 传入 execute 时返回 isError 且不写入台账", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repo = await createRepoFixture();
    repoFixtures.push(repo);
    const def = registerAndGet();
    const ctx = fakeCtx({ cwd: repo.root });

    const result = await withTempEnv(home, () =>
      def.execute("call-1", validAiParams(), AbortSignal.abort(), undefined, ctx),
    );

    expect((result as any).details.isError).toBe(true);
    const identity = await repositoryIdentity(repo.root);
    const ledgerPath = join(requirementDataDir(home.dataRoot, identity.repoId, REQUIREMENT), "ai-decisions.jsonl");
    await expect(readFile(ledgerPath, "utf8")).rejects.toThrow();
  });
});

describe("describeReceipt", () => {
  test("生成已记录 <id>：<位置> 第 <n> 行 文案", () => {
    const receipt = {
      schema: "decision-receipt/v1" as const,
      receiptId: "r1",
      decisionId: "AI-001",
      actor: "ai" as const,
      repoId: "repo123",
      requirement: REQUIREMENT,
      ledgerPath: "/data/ai-decisions.jsonl",
      lineNumber: 1,
      decisionHash: "hash",
      recordedAt: "2026-09-08T00:00:00.000Z",
    };

    expect(describeReceipt(receipt)).toBe("已记录 AI-001：/data/ai-decisions.jsonl 第 1 行");
  });
});
