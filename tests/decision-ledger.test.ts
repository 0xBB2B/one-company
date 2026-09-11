import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { repositoryIdentity } from "../runtime/identity.ts";
import { repositoryDatabase, withDatabase, UUID_V7_PATTERN } from "../runtime/database.ts";
import {
  decisionStream,
  appendDecision,
  buildRecord,
  inspectDecision,
  nextDecisionId,
  readDecisions,
  validateDecisionInput,
} from "../runtime/decisions.ts";

const REQUIREMENT = "2026-09-08.fixture";

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];
const tempHomes: Array<Awaited<ReturnType<typeof createTempHome>>> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
  for (const home of tempHomes.splice(0)) await removeTempHome(home);
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const home = await createTempHome();
  tempHomes.push(home);
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  return { home, repo };
}

function aiInput(overrides: Record<string, unknown> = {}) {
  return {
    requirement: REQUIREMENT,
    actor: "ai" as const,
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

function userInput(overrides: Record<string, unknown> = {}) {
  return {
    requirement: REQUIREMENT,
    actor: "user" as const,
    source: "main-session",
    trigger: "确认范围",
    decision: "缩小范围至 MVP",
    alternatives: ["保留全部范围"],
    effects: ["scope"],
    impact: "后续迭代补齐剩余范围",
    ...overrides,
  };
}

async function ledgerFor(home: Awaited<ReturnType<typeof createTempHome>>, repoRoot: string, actor: "ai" | "user") {
  const identity = await repositoryIdentity(repoRoot);
  return { database: repositoryDatabase(home.dataRoot, identity.repoId), stream: decisionStream(REQUIREMENT, actor) };
}

function ledgerJson(ref: { database: string; stream: string }): string {
  return withDatabase(ref.database, (db) => db.events(ref.stream).map((event) => JSON.stringify(event.data)).join("\n"));
}

function corruptLedger(ref: { database: string; stream: string }): void {
  withDatabase(ref.database, (db) => db.append(ref.stream, { broken: true, x: 1 }));
}

describe("validateDecisionInput", () => {
  test("合法 AI 决定输入通过校验", () => {
    expect(() => validateDecisionInput(aiInput())).not.toThrow();
  });

  test("合法用户决定输入通过校验", () => {
    expect(() => validateDecisionInput(userInput())).not.toThrow();
  });

  test("AI 决定缺少 scope 时报错", () => {
    const input = aiInput();
    delete (input as Record<string, unknown>).scope;
    expect(() => validateDecisionInput(input)).toThrow("AI 决定必须同时提供 scope、basis、action");
  });

  test("AI 决定 basis 为空数组时视为缺失并报错", () => {
    expect(() => validateDecisionInput(aiInput({ basis: [] }))).toThrow("AI 决定必须同时提供 scope、basis、action");
  });

  test("AI 决定 basis 为 null 时视为缺失并报错", () => {
    expect(() => validateDecisionInput(aiInput({ basis: null }))).toThrow("AI 决定必须同时提供 scope、basis、action");
  });

  test("AI 决定 scope 为空字符串时视为缺失并报错", () => {
    expect(() => validateDecisionInput(aiInput({ scope: "" }))).toThrow("AI 决定必须同时提供 scope、basis、action");
  });

  test("AI 决定缺少 action 时报错", () => {
    const input = aiInput();
    delete (input as Record<string, unknown>).action;
    expect(() => validateDecisionInput(input)).toThrow("AI 决定必须同时提供 scope、basis、action");
  });

  test("AI 决定携带 impact 时被拒绝", () => {
    expect(() => validateDecisionInput(aiInput({ impact: "不应出现" }))).toThrow();
  });

  test("用户决定携带 basis 时报错文案为用户决定不得携带 basis", () => {
    expect(() => validateDecisionInput(userInput({ basis: ["不应出现"] }))).toThrow("用户决定不得携带 basis");
  });

  test("用户决定携带 scope 时被拒绝", () => {
    expect(() => validateDecisionInput(userInput({ scope: "不应出现" }))).toThrow();
  });

  test("用户决定携带 action 时被拒绝", () => {
    expect(() => validateDecisionInput(userInput({ action: "不应出现" }))).toThrow();
  });

  test("用户决定缺少 impact 时被拒绝", () => {
    const input = userInput();
    delete (input as Record<string, unknown>).impact;
    expect(() => validateDecisionInput(input)).toThrow();
  });

  test("用户决定 impact 为空字符串时视为缺失并报错", () => {
    expect(() => validateDecisionInput(userInput({ impact: "" }))).toThrow();
  });
});

describe("appendDecision", () => {
  test("需求目录不存在时首次 AI 决定成功且回执信息完整", async () => {
    const { home, repo } = await setup();
    const identity = await repositoryIdentity(repo.root);

    const receipt = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    expect(receipt.schema).toBe("decision-receipt/v1");
    expect(receipt.decisionId).toBe("AI-001");
    expect(receipt.actor).toBe("ai");
    expect(receipt.repoId).toBe(identity.repoId);
    expect(receipt.requirement).toBe(REQUIREMENT);
    expect(receipt.sequence).toBe(1);

    expect(receipt.recordId).toMatch(UUID_V7_PATTERN);
    expect(receipt.receiptId).toMatch(UUID_V7_PATTERN);
    const ref = await ledgerFor(home, repo.root, "ai");
    const events = withDatabase(ref.database, (db) => db.events(ref.stream));
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(receipt.recordId);
    expect(receipt.decisionHash).toBe(createHash("sha256").update(JSON.stringify(events[0]!.data)).digest("hex"));
    expect(receipt.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("首次用户决定成功并写入用户决策流", async () => {
    const { home, repo } = await setup();

    const receipt = await appendDecision(userInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    expect(receipt.decisionId).toBe("USER-001");
    expect(receipt.actor).toBe("user");
    const ref = await ledgerFor(home, repo.root, "user");
    expect(withDatabase(ref.database, (db) => db.events(ref.stream))[0]!.id).toBe(receipt.recordId);
  });

  test("AI 决定校验失败时拒绝写入且不产生台账文件", async () => {
    const { home, repo } = await setup();
    const input = aiInput();
    delete (input as Record<string, unknown>).action;

    await expect(appendDecision(input, { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(
      "AI 决定必须同时提供 scope、basis、action",
    );

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("用户决定携带 basis 时拒绝写入", async () => {
    const { home, repo } = await setup();

    await expect(
      appendDecision(userInput({ basis: ["不应出现"] }), { dataRoot: home.dataRoot, cwd: repo.root }),
    ).rejects.toThrow("用户决定不得携带 basis");
  });

  test("缺少 decision 字段时拒绝写入且报错提及字段名", async () => {
    const { home, repo } = await setup();
    const input = aiInput();
    delete (input as Record<string, unknown>).decision;

    await expect(appendDecision(input, { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(/decision/);

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("effects 字段缺失时拒绝写入且报错提及字段名", async () => {
    const { home, repo } = await setup();
    const input = aiInput();
    delete (input as Record<string, unknown>).effects;

    await expect(appendDecision(input, { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(/effects/);

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("effects 为空数组时拒绝写入且报错提及字段名", async () => {
    const { home, repo } = await setup();

    await expect(appendDecision(aiInput({ effects: [] }), { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(
      /effects/,
    );

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("缺少 trigger 字段时拒绝写入且报错提及字段名", async () => {
    const { home, repo } = await setup();
    const input = aiInput();
    delete (input as Record<string, unknown>).trigger;

    await expect(appendDecision(input, { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(/trigger/);

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("缺少 source 字段时拒绝写入且报错提及字段名", async () => {
    const { home, repo } = await setup();
    const input = aiInput();
    delete (input as Record<string, unknown>).source;

    await expect(appendDecision(input, { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow(/source/);

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    expect(await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" })).toEqual([]);
  });

  test("supersedes 指向不存在的决定时拒绝且台账不变", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const before = ledgerJson(ledgerPath);

    await expect(
      appendDecision(aiInput({ supersedes: ["AI-009"] }), { dataRoot: home.dataRoot, cwd: repo.root }),
    ).rejects.toThrow();

    expect(ledgerJson(ledgerPath)).toBe(before);
  });

  test("supersedes 指向自身尚未分配的编号时拒绝且台账不变", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const before = ledgerJson(ledgerPath);

    await expect(
      appendDecision(aiInput({ supersedes: ["AI-002"] }), { dataRoot: home.dataRoot, cwd: repo.root }),
    ).rejects.toThrow();

    expect(ledgerJson(ledgerPath)).toBe(before);
  });

  test("supersedes 含重复编号时拒绝且台账不变", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const before = ledgerJson(ledgerPath);

    await expect(
      appendDecision(aiInput({ supersedes: ["AI-001", "AI-001"] }), { dataRoot: home.dataRoot, cwd: repo.root }),
    ).rejects.toThrow();

    expect(ledgerJson(ledgerPath)).toBe(before);
  });

  test("AI 决定 supersedes 引用用户台账中的决定时允许追加且双方记录不变", async () => {
    const { home, repo } = await setup();
    const userReceipt = await appendDecision(userInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const aiReceipt = await appendDecision(aiInput({ supersedes: [userReceipt.decisionId] }), {
      dataRoot: home.dataRoot,
      cwd: repo.root,
    });

    expect(aiReceipt.decisionId).toBe("AI-001");
    const foundUser = await inspectDecision({
      dataRoot: home.dataRoot,
      cwd: repo.root,
      requirement: REQUIREMENT,
      id: userReceipt.decisionId,
    });
    const foundAi = await inspectDecision({
      dataRoot: home.dataRoot,
      cwd: repo.root,
      requirement: REQUIREMENT,
      id: aiReceipt.decisionId,
    });
    expect((foundUser as { id: string } | null)?.id).toBe(userReceipt.decisionId);
    expect((foundAi as { id: string } | null)?.id).toBe(aiReceipt.decisionId);
  });

  test("用户决定 supersedes 引用 AI 台账中的决定时允许追加且双方记录不变", async () => {
    const { home, repo } = await setup();
    const aiReceipt = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const userReceipt = await appendDecision(userInput({ supersedes: [aiReceipt.decisionId] }), {
      dataRoot: home.dataRoot,
      cwd: repo.root,
    });

    expect(userReceipt.decisionId).toBe("USER-001");
    const foundAi = await inspectDecision({
      dataRoot: home.dataRoot,
      cwd: repo.root,
      requirement: REQUIREMENT,
      id: aiReceipt.decisionId,
    });
    const foundUser = await inspectDecision({
      dataRoot: home.dataRoot,
      cwd: repo.root,
      requirement: REQUIREMENT,
      id: userReceipt.decisionId,
    });
    expect((foundAi as { id: string } | null)?.id).toBe(aiReceipt.decisionId);
    expect((foundUser as { id: string } | null)?.id).toBe(userReceipt.decisionId);
  });

  test("合法替代追加成功且旧行逐字不变", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const firstLine = (ledgerJson(ledgerPath)).split("\n").filter(Boolean)[0];

    const receipt = await appendDecision(aiInput({ supersedes: ["AI-001"] }), { dataRoot: home.dataRoot, cwd: repo.root });

    expect(receipt.decisionId).toBe("AI-002");
    const lines = (ledgerJson(ledgerPath)).split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(firstLine);
  });

  test("20 个并发 appendDecision 得到 20 个不同编号且文件 20 行", async () => {
    const { home, repo } = await setup();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root })),
    );

    expect(new Set(results.map((r) => r.decisionId)).size).toBe(20);
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const lines = (ledgerJson(ledgerPath)).split("\n").filter(Boolean);
    expect(lines.length).toBe(20);
  });

  test("两个子进程各追加 5 条得到 10 行且编号唯一", async () => {
    const { home, repo } = await setup();
    const decisionsModulePath = fileURLToPath(new URL("../runtime/decisions.ts", import.meta.url));
    const script = `
      const { appendDecision } = await import(${JSON.stringify(decisionsModulePath)});
      for (let i = 0; i < 5; i++) {
        await appendDecision(
          {
            requirement: ${JSON.stringify(REQUIREMENT)},
            actor: "ai",
            source: "main-session",
            trigger: "选型讨论",
            decision: "并发追加 " + i,
            alternatives: ["方案 B"],
            effects: ["architecture"],
            scope: "订单模块",
            basis: ["性能测试结果"],
            action: "更新实施计划",
          },
          { dataRoot: process.env.PI_TEST_DATA_ROOT, cwd: process.env.PI_TEST_CWD },
        );
      }
    `;
    const spawnChild = () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PI_TEST_DATA_ROOT: home.dataRoot, PI_TEST_CWD: repo.root },
        timeout: 20_000,
      }).then(() => ({ code: 0 }), (error) => ({ code: error.code, stderr: error.stderr }));

    const results = await Promise.all([spawnChild(), spawnChild()]);
    for (const result of results) {
      expect(result.code, "stderr" in result ? result.stderr : undefined).toBe(0);
    }

    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    const lines = (ledgerJson(ledgerPath)).split("\n").filter(Boolean);
    expect(lines.length).toBe(10);
    const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
    expect(new Set(ids).size).toBe(10);
  });

  test("决策流被插入坏结构后追加被拒绝且原记录未变", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    corruptLedger(ledgerPath);
    const before = ledgerJson(ledgerPath);

    await expect(appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root })).rejects.toThrow();

    expect(ledgerJson(ledgerPath)).toBe(before);
  });

  test("同一仓库两个 worktree 下追加的记录落在同一文件", async () => {
    const { home, repo } = await setup();
    const worktree = await addWorktree(repo);

    const first = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const second = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: worktree.root });

    expect(second.repoId).toBe(first.repoId);
    expect(second.decisionId).toBe("AI-002");
  });

  test("不同仓库同名需求落在不同文件", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const repoA = await createRepoFixture();
    repoFixtures.push(repoA);
    const repoB = await createRepoFixture();
    repoFixtures.push(repoB);

    const receiptA = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repoA.root });
    const receiptB = await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repoB.root });

    expect(receiptA.repoId).not.toBe(receiptB.repoId);
    expect(receiptA.decisionId).toBe("AI-001");
    expect(receiptB.decisionId).toBe("AI-001");
  });

  test("非 Git 目录作为 cwd 时拒绝写入并说明原因", async () => {
    const home = await createTempHome();
    tempHomes.push(home);
    const plainDir = await mkdtemp(join(tmpdir(), "pi-company-plain-"));
    tempRoots.push(plainDir);

    await expect(appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: plainDir })).rejects.toThrow(
      /不是 Git 仓库/,
    );
  });

  test("需求名格式非法时拒绝写入", async () => {
    const { home, repo } = await setup();

    await expect(
      appendDecision(aiInput({ requirement: "order-export" }), { dataRoot: home.dataRoot, cwd: repo.root }),
    ).rejects.toThrow();
  });

  test("首次写入后仓库记录的 commonDir 正确、目录权限 0700", async () => {
    const { home, repo } = await setup();
    const identity = await repositoryIdentity(repo.root);

    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const repoDir = join(home.dataRoot, "repos", identity.repoId);
    const dirStat = await stat(repoDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const payload = withDatabase(repositoryDatabase(home.dataRoot, identity.repoId), (db) => db.read<{ commonDir: string }>("repository", identity.repoId)!.data);
    expect(payload.commonDir).toBe(identity.commonDir);
  });
});

describe("readDecisions", () => {
  test("需求目录不存在时返回空数组", async () => {
    const { home, repo } = await setup();

    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" });

    expect(records).toEqual([]);
  });

  test("返回按追加顺序排列且逐条校验后的记录", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput({ decision: "第一次决定" }), { dataRoot: home.dataRoot, cwd: repo.root });
    await appendDecision(aiInput({ decision: "第二次决定" }), { dataRoot: home.dataRoot, cwd: repo.root });

    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" });

    expect(records.map((r) => (r as { id: string }).id)).toEqual(["AI-001", "AI-002"]);
  });

  test("台账损坏时抛出损坏错误", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });
    const ledgerPath = await ledgerFor(home, repo.root, "ai");
    corruptLedger(ledgerPath);

    await expect(
      readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "ai" }),
    ).rejects.toThrow();
  });

  test("按 actor: user 返回用户决定记录", async () => {
    const { home, repo } = await setup();
    await appendDecision(userInput({ decision: "第一次用户决定" }), { dataRoot: home.dataRoot, cwd: repo.root });

    const records = await readDecisions({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, actor: "user" });

    expect(records.map((r) => (r as { id: string }).id)).toEqual(["USER-001"]);
  });
});

describe("inspectDecision", () => {
  test("存在的编号返回对应记录", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const found = await inspectDecision({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, id: "AI-001" });

    expect((found as { id: string } | null)?.id).toBe("AI-001");
  });

  test("不存在的编号返回 null", async () => {
    const { home, repo } = await setup();
    await appendDecision(aiInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const found = await inspectDecision({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, id: "AI-099" });

    expect(found).toBeNull();
  });

  test("USER-00n 编号从用户台账中查找记录", async () => {
    const { home, repo } = await setup();
    const receipt = await appendDecision(userInput(), { dataRoot: home.dataRoot, cwd: repo.root });

    const found = await inspectDecision({ dataRoot: home.dataRoot, cwd: repo.root, requirement: REQUIREMENT, id: receipt.decisionId });

    expect((found as { id: string } | null)?.id).toBe("USER-001");
  });
});

describe("nextDecisionId", () => {
  test("既有编号为空时返回 001", () => {
    expect(nextDecisionId([], "ai")).toBe("AI-001");
  });

  test("按最大后缀 +1 计算且三位补零", () => {
    expect(nextDecisionId(["AI-001", "AI-002"], "ai")).toBe("AI-003");
  });

  test("允许空洞：既有编号不连续时取最大值 +1", () => {
    expect(nextDecisionId(["AI-001", "AI-005"], "ai")).toBe("AI-006");
  });

  test("按 actor 前缀过滤，只统计同一台账的既有编号", () => {
    const existingIds = ["AI-001", "USER-001", "USER-002"];
    expect(nextDecisionId(existingIds, "ai")).toBe("AI-002");
    expect(nextDecisionId(existingIds, "user")).toBe("USER-003");
  });
});

describe("buildRecord", () => {
  test("AI 决定字段顺序符合约定", () => {
    const record = buildRecord(aiInput(), { id: "AI-001", recordedAt: "2026-09-08T00:00:00.000Z" });

    expect(Object.keys(record)).toEqual([
      "id",
      "recordedAt",
      "actor",
      "source",
      "requirement",
      "trigger",
      "decision",
      "effects",
      "scope",
      "basis",
      "alternatives",
      "action",
    ]);
  });

  test("用户决定字段顺序符合约定", () => {
    const record = buildRecord(userInput(), { id: "USER-001", recordedAt: "2026-09-08T00:00:00.000Z" });

    expect(Object.keys(record)).toEqual([
      "id",
      "recordedAt",
      "actor",
      "source",
      "requirement",
      "trigger",
      "decision",
      "effects",
      "alternatives",
      "impact",
    ]);
  });

  test("supersedes 存在时排在字段末尾", () => {
    const record = buildRecord(aiInput({ supersedes: ["AI-001"] }), { id: "AI-002", recordedAt: "2026-09-08T00:00:00.000Z" });

    expect(Object.keys(record)).toEqual([
      "id",
      "recordedAt",
      "actor",
      "source",
      "requirement",
      "trigger",
      "decision",
      "effects",
      "scope",
      "basis",
      "alternatives",
      "action",
      "supersedes",
    ]);
  });
});

describe("运行时 API 的 alternatives 存在性", () => {
  test("缺 alternatives 时拒绝写入", async () => {
    const { home, repo } = await setup();
    await expect(
      appendDecision(
        { requirement: "2026-09-08.fixture", actor: "ai", source: "s", trigger: "t", decision: "d", effects: ["behavior"], scope: "x", basis: ["b"], action: "a" },
        { dataRoot: home.dataRoot, cwd: repo.root },
      ),
    ).rejects.toThrow("alternatives");
  });
});
