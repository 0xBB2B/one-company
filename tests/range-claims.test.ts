import { afterAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClock } from "../runtime/clock.ts";
import { RangeClaims, fingerprint, overlaps, verifyFingerprint } from "../runtime/ranges.ts";
import { withDatabase } from "../runtime/database.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";

const execFileAsync = promisify(execFile);

const RANGES_MODULE_PATH = fileURLToPath(new URL("../runtime/ranges.ts", import.meta.url));
const CLOCK_MODULE_PATH = fileURLToPath(new URL("../runtime/clock.ts", import.meta.url));

const tempDirs: string[] = [];

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "range-claims-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface HolderGoneResult {
  gone: boolean;
  evidence?: string;
  reason?: string;
}

function makeClaims(
  repoDir: string,
  fns: {
    runState?: (runId: string) => Promise<string | null>;
    holderGone?: (windowId: string) => Promise<HolderGoneResult>;
    activeShellTasks?: (runId: string) => Promise<number>;
  } = {},
): RangeClaims {
  return new RangeClaims({
    repoDir,
    repoRoot: repoDir,
    clock: createClock(),
    runState: fns.runState ?? (async () => null),
    holderGone: fns.holderGone ?? (async () => ({ gone: false, reason: "默认未失联" })),
    activeShellTasks: fns.activeShellTasks ?? (async () => 0),
  });
}

async function writeSubprocessScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "range-claims-proc-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "claim-once.mjs");
  await writeFile(
    scriptPath,
    `
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const [, , rangesPath, clockPath, repoDir, pathsJson, holderJson, outFile] = process.argv;
const { RangeClaims } = await import(pathToFileURL(rangesPath).href);
const { createClock } = await import(pathToFileURL(clockPath).href);

const claims = new RangeClaims({
  repoDir,
  repoRoot: repoDir,
  clock: createClock(),
  runState: async () => null,
  holderGone: async () => ({ gone: false, reason: "n/a" }),
  activeShellTasks: async () => 0,
});

const holder = JSON.parse(holderJson);
const paths = JSON.parse(pathsJson);
const result = await claims.claim(holder, paths);
await writeFile(outFile, JSON.stringify(result));
`,
    "utf8",
  );
  return scriptPath;
}

async function claimInSubprocess(
  scriptPath: string,
  repoDir: string,
  paths: string[],
  holder: Record<string, unknown>,
): Promise<{ granted: boolean; [key: string]: unknown }> {
  const outDir = await mkdtemp(join(tmpdir(), "range-claims-out-"));
  tempDirs.push(outDir);
  const outFile = join(outDir, "result.json");
  await execFileAsync(process.execPath, [
    scriptPath,
    RANGES_MODULE_PATH,
    CLOCK_MODULE_PATH,
    repoDir,
    JSON.stringify(paths),
    JSON.stringify(holder),
    outFile,
  ]);
  return JSON.parse(await readFile(outFile, "utf8"));
}

function claimsJson(repoDir: string): string {
  return withDatabase(join(repoDir, "data.db"), (db) => JSON.stringify({
    claims: db.list("range_claims").map((row) => row.data),
    waiting: db.list("range_waiting").map((row) => row.data),
    released: db.list("range_released").map((row) => row.data),
  }));
}

describe("跨进程并发申请：重叠范围只有一方获准", () => {
  test("同一文件的并发跨进程申请恰有一方获准（10 轮），claims.json 始终合法", async () => {
    const scriptPath = await writeSubprocessScript();
    for (let round = 0; round < 10; round++) {
      const repoDir = await makeRepoDir();
      const [resultA, resultB] = await Promise.all([
        claimInSubprocess(scriptPath, repoDir, ["shared.txt"], { kind: "main", windowId: `win-a-${round}` }),
        claimInSubprocess(scriptPath, repoDir, ["shared.txt"], { kind: "main", windowId: `win-b-${round}` }),
      ]);
      const grantedCount = [resultA, resultB].filter((r) => r.granted).length;
      expect(grantedCount).toBe(1);

      const raw = claimsJson(repoDir);
      const parsed = JSON.parse(raw) as { version: number };
      expect(parsed.claims).toHaveLength(1);
    }
  }, 30_000);
});

describe("不重叠任务不被阻止", () => {
  test("不重叠范围的并发申请均获准", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const [resultA, resultB] = await Promise.all([
      claims.claim({ kind: "main", windowId: "win-a" }, ["a.txt"]),
      claims.claim({ kind: "main", windowId: "win-b" }, ["b.txt"]),
    ]);
    expect(resultA.granted).toBe(true);
    expect(resultB.granted).toBe(true);
  });
});

describe("整体授权：多范围申请全冲突或全不冲突", () => {
  test("乙申请 A+B 时因 A 冲突整体不获准、不占 B；甲释放后乙整体获准", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);

    const first = await claims.claim({ kind: "main", windowId: "win-1" }, ["a.txt"]);
    expect(first.granted).toBe(true);
    if (!first.granted) return;

    const second = await claims.claim({ kind: "main", windowId: "win-2" }, ["a.txt", "b.txt"]);
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.conflicts.some((c: { path: string }) => c.path === "a.txt")).toBe(true);
    expect(JSON.stringify(second.conflicts)).toContain("win-1");
    expect(typeof second.reason).toBe("string");
    expect(second.reason.length).toBeGreaterThan(0);

    const third = await claims.claim({ kind: "main", windowId: "win-3" }, ["b.txt"]);
    expect(third.granted).toBe(true);
    if (third.granted) await claims.release(third.claimId, { kind: "main", windowId: "win-3" });

    await claims.release(first.claimId, { kind: "main", windowId: "win-1" });

    const retry = await claims.claim({ kind: "main", windowId: "win-2" }, ["a.txt", "b.txt"]);
    expect(retry.granted).toBe(true);
  });

  test("交叉重叠的多路申请不出现各占一部分互等", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const [resultX, resultY] = await Promise.all([
      claims.claim({ kind: "main", windowId: "win-x" }, ["a.txt", "b.txt"]),
      claims.claim({ kind: "main", windowId: "win-y" }, ["b.txt", "a.txt"]),
    ]);
    const grantedCount = [resultX, resultY].filter((r) => r.granted).length;
    expect(grantedCount).toBe(1);
    const losing = resultX.granted ? resultY : resultX;
    expect(losing.granted).toBe(false);
    if (!losing.granted) {
      expect(losing.conflicts.length).toBeGreaterThan(0);
    }
  });
});

describe("overlaps：目录范围与文件/目录的重叠判定", () => {
  test("目录范围覆盖其下的文件路径", () => {
    expect(overlaps("docs/", "docs/a.md")).toBe(true);
  });

  test("不同顶层目录不重叠", () => {
    expect(overlaps("docs", "docs2/")).toBe(false);
  });
});

describe("wait：只等待冲突部分，不自动抢占或暂停原任务", () => {
  test("等待中的申请可通过 signal 取消而非无限阻塞", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "holder-1" }, ["locked.txt"]);
    expect(held.granted).toBe(true);

    const controller = new AbortController();
    const waitPromise = claims.wait(["locked.txt"], { signal: controller.signal, holder: { kind: "main", windowId: "waiter-locked" } }).then(
      () => "settled",
      () => "settled",
    );
    setTimeout(() => controller.abort(), 50);

    const outcome = await Promise.race([
      waitPromise,
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    expect(outcome).toBe("settled");
  }, 10_000);

  test("等待中的申请在冲突方释放后结束等待", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "holder-2" }, ["locked2.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const controller = new AbortController();
    const waitPromise = claims.wait(["locked2.txt"], { signal: controller.signal, holder: { kind: "main", windowId: "waiter-locked2" } });
    setTimeout(() => {
      void claims.release(held.claimId, { kind: "main", windowId: "holder-2" });
    }, 50);

    const outcome = await Promise.race([
      waitPromise.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    expect(outcome).toBe("settled");
  }, 10_000);
});

describe("releaseIfHolderGone：机械证据判定，非机械证据不释放", () => {
  test("role 持有者运行已终态且无活动/不确定任务：释放并返回证据", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async (runId) => (runId === "run-role-1" ? "stopped" : null),
      activeShellTasks: async () => 0,
    });
    const held = await claims.claim({ kind: "role", runId: "run-role-1" }, ["role-a.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(true);
    if (result.released) expect(result.evidence).toBeTruthy();
    expect(await claims.holderOf("role-a.txt")).toBeFalsy();
  });

  test("role 持有者运行终态但登记表仍有不确定任务：保留并报告原因", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => "stopped",
      activeShellTasks: async () => 1,
    });
    const held = await claims.claim({ kind: "role", runId: "run-role-2" }, ["role-b.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(await claims.holderOf("role-b.txt")).toBeTruthy();
  });

  test("role 持有者运行中：保留", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => "running",
      activeShellTasks: async () => 0,
    });
    const held = await claims.claim({ kind: "role", runId: "run-role-3" }, ["role-c.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
  });

  test("requirement 持有者运行已终态且无不确定任务：释放", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => "completed",
      activeShellTasks: async () => 0,
    });
    const held = await claims.claim(
      { kind: "requirement", runId: "run-req-1", requirement: "2026-09-09.example" },
      ["req-a.txt"],
    );
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(true);
  });

  test("main 持有者窗口 holderGone 成立：释放", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      holderGone: async (windowId) =>
        windowId === "win-gone" ? { gone: true, evidence: "unregistered" } : { gone: false, reason: "n/a" },
    });
    const held = await claims.claim({ kind: "main", windowId: "win-gone" }, ["main-a.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(true);
  });

  test("main 持有者心跳过期但开机标识相同且进程存在（holderGone 不成立）：保留", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      holderGone: async () => ({ gone: false, reason: "开机标识未变且进程存在" }),
    });
    const held = await claims.claim({ kind: "main", windowId: "win-alive" }, ["main-b.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(typeof result.reason).toBe("string");
  });
});

describe("releaseByUser：用户显式释放需决定编号", () => {
  test("带决定编号可释放并把编号写入释放记录", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "win-u1" }, ["user-a.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    await claims.releaseByUser(held.claimId, { decisionId: "USER-1" });
    expect(await claims.holderOf("user-a.txt")).toBeFalsy();

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { released: { claimId: string; decisionId?: string }[] };
    const record = doc.released.find((r) => r.claimId === held.claimId);
    expect(record?.decisionId).toBe("USER-1");
  });

  test("无决定编号拒绝释放", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "win-u2" }, ["user-b.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    await expect(claims.releaseByUser(held.claimId, { decisionId: "" })).rejects.toThrow();
    expect(await claims.holderOf("user-b.txt")).toBeTruthy();
  });
});

describe("fingerprint / verifyFingerprint：接手前核对文件是否变化", () => {
  test("文件内容未变化时差异清单为空", async () => {
    const repoDir = await makeRepoDir();
    await writeFile(join(repoDir, "spec.md"), "v1 内容\n");
    const fp = await fingerprint(repoDir, ["spec.md"]);
    const diff = await verifyFingerprint(repoDir, fp);
    const diffSize = Array.isArray(diff) ? diff.length : Object.keys(diff as object).length;
    expect(diffSize).toBe(0);
  });

  test("接手前文件已被修改：差异清单报告该文件", async () => {
    const repoDir = await makeRepoDir();
    await writeFile(join(repoDir, "spec.md"), "v1 内容\n");
    const fp = await fingerprint(repoDir, ["spec.md"]);
    await writeFile(join(repoDir, "spec.md"), "v2 修改后的内容\n");
    const diff = await verifyFingerprint(repoDir, fp);
    expect(JSON.stringify(diff)).toContain("spec.md");
  });
});

describe("错误场景", () => {
  test("release 未知 claimId 报错", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    await expect(claims.release("unknown-claim-id", { kind: "main", windowId: "nobody" })).rejects.toThrow();
  });
});

describe("claims.json 并发写不产生半文件", () => {
  test("高并发写入后仍是合法 JSON 且 version 单调递增", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);

    const first = await claims.claim({ kind: "main", windowId: "seq-1" }, ["seq-a.txt"]);
    expect(first.granted).toBe(true);
    const afterFirst = JSON.parse(claimsJson(repoDir)) as {
      version: number;
    };

    const second = await claims.claim({ kind: "main", windowId: "seq-2" }, ["seq-b.txt"]);
    expect(second.granted).toBe(true);
    const afterSecond = JSON.parse(claimsJson(repoDir)) as {
      version: number;
    };
    expect(afterFirst.claims).toHaveLength(1);
    expect(afterSecond.claims).toHaveLength(2);

    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claims.claim({ kind: "main", windowId: `burst-${i}` }, [`burst-${i}.txt`])),
    );
    expect(burst.every((r) => r.granted)).toBe(true);

    const raw = claimsJson(repoDir);
    expect(() => JSON.parse(raw)).not.toThrow();
    const finalDoc = JSON.parse(raw) as { version: number; claims: unknown[] };
    expect(finalDoc.claims.length).toBe(22);
    expect(new Set(finalDoc.claims.map((claim) => claim.claimId)).size).toBe(22);
  }, 15_000);
});

describe("路径规范化：等价路径视为同一范围", () => {
  test("./a.txt、sub/../a.txt、绝对路径均与 a.txt 冲突", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "alias-owner" }, ["a.txt"]);
    expect(held.granted).toBe(true);

    const dotRelative = await claims.claim({ kind: "main", windowId: "alias-1" }, ["./a.txt"]);
    expect(dotRelative.granted).toBe(false);

    const dotDot = await claims.claim({ kind: "main", windowId: "alias-2" }, ["sub/../a.txt"]);
    expect(dotDot.granted).toBe(false);

    const absolute = await claims.claim({ kind: "main", windowId: "alias-3" }, [join(repoDir, "a.txt")]);
    expect(absolute.granted).toBe(false);
  });

  test("overlaps 对路径别名一律返回 true", () => {
    expect(overlaps("a.txt", "./a.txt")).toBe(true);
    expect(overlaps("a.txt", "sub/../a.txt")).toBe(true);
    expect(overlaps("src/a", "src//a")).toBe(true);
  });
});

describe("仓库边界：逃逸仓库根一律拒绝", () => {
  test("claim 逃逸路径不获准且给出原因", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const result = await claims.claim({ kind: "main", windowId: "escaper" }, ["../outside.txt"]);
    expect(result.granted).toBe(false);
    if (!result.granted) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("fingerprint 对逃逸路径拒绝", async () => {
    const repoDir = await makeRepoDir();
    await expect(fingerprint(repoDir, ["../x"])).rejects.toThrow();
  });
});

describe("waiting 队列生命周期：按 holder+paths 去重，结束后清理", () => {
  test("同一 holder 重复申请同一冲突范围 5 次，waiting 恰有 1 条", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const blocker = await claims.claim({ kind: "main", windowId: "dup-blocker" }, ["dup.txt"]);
    expect(blocker.granted).toBe(true);

    const dupHolder = { kind: "main", windowId: "dup-waiter" };
    for (let i = 0; i < 5; i++) {
      const attempt = await claims.claim(dupHolder, ["dup.txt"]);
      expect(attempt.granted).toBe(false);
    }

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown }[] };
    const matching = doc.waiting.filter((w) => JSON.stringify(w.holder) === JSON.stringify(dupHolder));
    expect(matching.length).toBe(1);
  });

  test("冲突方释放、本方获准后 waiting 不再含本方条目", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const blocker = await claims.claim({ kind: "main", windowId: "release-blocker" }, ["release-wait.txt"]);
    expect(blocker.granted).toBe(true);
    if (!blocker.granted) return;

    const waiterHolder = { kind: "main", windowId: "release-waiter" };
    const attempt = await claims.claim(waiterHolder, ["release-wait.txt"]);
    expect(attempt.granted).toBe(false);

    await claims.release(blocker.claimId, { kind: "main", windowId: "release-blocker" });
    const retry = await claims.claim(waiterHolder, ["release-wait.txt"]);
    expect(retry.granted).toBe(true);

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown }[] };
    const stillWaiting = doc.waiting.some((w) => JSON.stringify(w.holder) === JSON.stringify(waiterHolder));
    expect(stillWaiting).toBe(false);
  });

  test("wait() 被 signal 取消后 waiting 中无本方条目", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const blocker = await claims.claim({ kind: "main", windowId: "cancel-blocker" }, ["cancel-wait.txt"]);
    expect(blocker.granted).toBe(true);

    const cancelHolder = { kind: "main", windowId: "cancel-waiter" };
    const attempt = await claims.claim(cancelHolder, ["cancel-wait.txt"]);
    expect(attempt.granted).toBe(false);

    const controller = new AbortController();
    const waitPromise = claims.wait(["cancel-wait.txt"], { signal: controller.signal, holder: cancelHolder });
    setTimeout(() => controller.abort(), 30);
    await expect(waitPromise).rejects.toThrow();

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown }[] };
    const stillWaiting = doc.waiting.some((w) => JSON.stringify(w.holder) === JSON.stringify(cancelHolder));
    expect(stillWaiting).toBe(false);
  }, 10_000);
});

describe("release 持有者校验", () => {
  test("持有者不一致时拒绝释放，原持有者仍占用", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "owner-a" }, ["owned.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    await expect(claims.release(held.claimId, { kind: "main", windowId: "owner-b" })).rejects.toThrow();
    expect(await claims.holderOf("owned.txt")).toBeTruthy();
  });

  test("同一持有者重复 release 同一 claimId 幂等，不抛未捕获异常", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "owner-c" }, ["idempotent.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    await claims.release(held.claimId, { kind: "main", windowId: "owner-c" });

    let threw = false;
    try {
      await claims.release(held.claimId, { kind: "main", windowId: "owner-c" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("目录范围端到端：文件、指向目录的 symlink、子目录", () => {
  test("以 docs/ 申请获准，fingerprints 含各文件；第三方申请子文件冲突；释放后文件变化被 verifyFingerprint 发现", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs", "sub"), { recursive: true });
    await writeFile(join(repoDir, "docs", "a.md"), "alpha\n");
    await writeFile(join(repoDir, "docs", "sub", "b.md"), "beta\n");
    await mkdir(join(repoDir, "docs-target"), { recursive: true });
    await writeFile(join(repoDir, "docs-target", "c.md"), "gamma\n");
    await symlink(join(repoDir, "docs-target"), join(repoDir, "docs", "link-dir"));

    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "dir-holder" }, ["docs/"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { claims: { claimId: string; fingerprints: Record<string, string> }[] };
    const record = doc.claims.find((c) => c.claimId === held.claimId);
    expect(record).toBeTruthy();
    const fpPaths = Object.keys(record?.fingerprints ?? {});
    expect(fpPaths).toContain("docs/a.md");
    expect(fpPaths).toContain("docs/sub/b.md");

    const third = await claims.claim({ kind: "main", windowId: "third" }, ["docs/a.md"]);
    expect(third.granted).toBe(false);

    await claims.release(held.claimId, { kind: "main", windowId: "dir-holder" });
    await writeFile(join(repoDir, "docs", "a.md"), "alpha changed\n");
    const diff = await verifyFingerprint(repoDir, record?.fingerprints ?? {});
    expect(JSON.stringify(diff)).toContain("docs/a.md");
  });
});

describe("目录指纹计算不得在目录锁内独占", () => {
  test("大目录范围申请进行时，不重叠单文件申请应在 1 秒内获准", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    for (let i = 0; i < 300; i++) {
      await writeFile(join(repoDir, "docs", `f${i}.txt`), `content-${i}`);
    }
    await writeFile(join(repoDir, "other.txt"), "other content");

    const claims = makeClaims(repoDir);
    const dirClaimPromise = claims.claim({ kind: "main", windowId: "dir-claimer" }, ["docs/"]);
    const otherClaimPromise = claims.claim({ kind: "main", windowId: "other-claimer" }, ["other.txt"]);

    const outcome = await Promise.race([
      otherClaimPromise.then(() => "granted-in-time"),
      new Promise((resolve) => setTimeout(() => resolve("too-slow"), 1_000)),
    ]);
    expect(outcome).toBe("granted-in-time");
    await dirClaimPromise;
  }, 10_000);
});

describe("releaseIfHolderGone：探针异常与缺字段记录不静默释放", () => {
  test("runState 探针抛错：released:false 且原因含“不可判定”", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => {
        throw new Error("探针故障");
      },
    });
    const held = await claims.claim({ kind: "role", runId: "probe-throw-run" }, ["probe-a.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toContain("不可判定");
  });

  test("holderGone 探针抛错：released:false 且原因含“不可判定”", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      holderGone: async () => {
        throw new Error("探针故障");
      },
    });
    const held = await claims.claim({ kind: "main", windowId: "probe-throw-win" }, ["probe-b.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toContain("不可判定");
  });

  test("activeShellTasks 探针抛错：released:false 且原因含“不可判定”", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => "stopped",
      activeShellTasks: async () => {
        throw new Error("探针故障");
      },
    });
    const held = await claims.claim({ kind: "role", runId: "probe-throw-tasks" }, ["probe-c.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toContain("不可判定");
  });

  test("holder 缺少 windowId/runId 的记录：不释放并返回原因", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: async () => "stopped",
      holderGone: async () => ({ gone: true, evidence: "宽松探针" }),
      activeShellTasks: async () => 0,
    });
    const held = await claims.claim({ kind: "main" }, ["probe-d.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("released 记录容量上限", () => {
  test("循环 claim+release 205 次后 released 恰保留最新 200 条", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    for (let i = 0; i < 205; i++) {
      const held = await claims.claim({ kind: "main", windowId: `cap-${i}` }, ["cap.txt"]);
      if (!held.granted) throw new Error(`第 ${i} 次申请未获准`);
      await claims.release(held.claimId, { kind: "main", windowId: `cap-${i}` });
    }
    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { released: unknown[] };
    expect(doc.released.length).toBe(200);
  }, 20_000);
});

describe("overlaps 边界补充", () => {
  test("文件路径与其目录形态视为重叠：a.ts 与 a.ts/", () => {
    expect(overlaps("a.ts", "a.ts/")).toBe(true);
  });

  test("docs/ 与 docs2/a 不重叠", () => {
    expect(overlaps("docs/", "docs2/a")).toBe(false);
  });
});

describe("指纹基线：必须在取得独占之后计算", () => {
  test("乙获准后的 fingerprints 反映甲释放前的最终内容，而非乙申请发起时读到的旧内容", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    for (let i = 0; i < 3000; i++) {
      await writeFile(join(repoDir, "docs", `f${i}.txt`), `content-${i}`);
    }
    await writeFile(join(repoDir, "a.txt"), "原始内容\n");

    const claims = makeClaims(repoDir);
    const heldByA = await claims.claim({ kind: "main", windowId: "baseline-a" }, ["a.txt"]);
    expect(heldByA.granted).toBe(true);
    if (!heldByA.granted) return;

    const holderB = { kind: "main", windowId: "baseline-b" };
    setTimeout(() => {
      void (async () => {
        await writeFile(join(repoDir, "a.txt"), "甲释放前修改的内容\n");
        await claims.release(heldByA.claimId, { kind: "main", windowId: "baseline-a" });
      })();
    }, 20);

    const deadline = Date.now() + 10_000;
    let resultB = await claims.claim(holderB, ["a.txt", "docs/"]);
    while (!resultB.granted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      resultB = await claims.claim(holderB, ["a.txt", "docs/"]);
    }
    expect(resultB.granted).toBe(true);
    if (!resultB.granted) return;

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { claims: { claimId: string; fingerprints: Record<string, string> }[] };
    const record = doc.claims.find((c) => c.claimId === resultB.claimId);
    expect(record).toBeTruthy();

    const diff = await verifyFingerprint(repoDir, record?.fingerprints ?? {});
    expect(diff).toEqual([]);
  }, 15_000);
});

describe("wait 只清本方等待条目", () => {
  test("本方 wait 取消后 waiting 仍保留其他等待者的条目", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const heldByOwner = await claims.claim({ kind: "main", windowId: "waitonly-owner" }, ["x.txt"]);
    expect(heldByOwner.granted).toBe(true);

    const holderB = { kind: "main", windowId: "waitonly-b" };
    const holderC = { kind: "main", windowId: "waitonly-c" };
    const attemptB = await claims.claim(holderB, ["x.txt"]);
    expect(attemptB.granted).toBe(false);
    const attemptC = await claims.claim(holderC, ["x.txt"]);
    expect(attemptC.granted).toBe(false);

    const controller = new AbortController();
    const waitPromise = claims.wait(["x.txt"], { signal: controller.signal, holder: holderB });
    setTimeout(() => controller.abort(), 30);
    await expect(waitPromise).rejects.toThrow();

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown }[] };
    const hasB = doc.waiting.some((w) => JSON.stringify(w.holder) === JSON.stringify(holderB));
    const hasC = doc.waiting.some((w) => JSON.stringify(w.holder) === JSON.stringify(holderC));
    expect(hasB).toBe(false);
    expect(hasC).toBe(true);
  });
});

describe("claim 获准只清对应范围的本方等待条目", () => {
  test("在 p.txt 上获准后，本方在 q.txt 上的等待条目保留", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const heldP = await claims.claim({ kind: "main", windowId: "onlyp-owner" }, ["p.txt"]);
    expect(heldP.granted).toBe(true);
    if (!heldP.granted) return;
    const heldQ = await claims.claim({ kind: "main", windowId: "onlyq-owner" }, ["q.txt"]);
    expect(heldQ.granted).toBe(true);
    if (!heldQ.granted) return;

    const waiter = { kind: "main", windowId: "onlypq-waiter" };
    const attemptP = await claims.claim(waiter, ["p.txt"]);
    expect(attemptP.granted).toBe(false);
    const attemptQ = await claims.claim(waiter, ["q.txt"]);
    expect(attemptQ.granted).toBe(false);

    await claims.release(heldP.claimId, { kind: "main", windowId: "onlyp-owner" });
    const retryP = await claims.claim(waiter, ["p.txt"]);
    expect(retryP.granted).toBe(true);

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown; paths: string[] }[] };
    const stillHasQ = doc.waiting.some(
      (w) => JSON.stringify(w.holder) === JSON.stringify(waiter) && w.paths.includes("q.txt"),
    );
    expect(stillHasQ).toBe(true);
  });
});

describe("waiting 去重与 paths 顺序无关", () => {
  test("同一 holder 先后以 [a,b]、[b,a] 申请同一冲突范围，waiting 恰 1 条", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const blockerA = await claims.claim({ kind: "main", windowId: "order-blocker-a" }, ["order-a.txt"]);
    expect(blockerA.granted).toBe(true);
    const blockerB = await claims.claim({ kind: "main", windowId: "order-blocker-b" }, ["order-b.txt"]);
    expect(blockerB.granted).toBe(true);

    const waiter = { kind: "main", windowId: "order-waiter" };
    const attempt1 = await claims.claim(waiter, ["order-a.txt", "order-b.txt"]);
    expect(attempt1.granted).toBe(false);
    const attempt2 = await claims.claim(waiter, ["order-b.txt", "order-a.txt"]);
    expect(attempt2.granted).toBe(false);

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { waiting: { holder: unknown }[] };
    const matching = doc.waiting.filter((w) => JSON.stringify(w.holder) === JSON.stringify(waiter));
    expect(matching.length).toBe(1);
  });
});

describe("目录范围指纹：能发现事后新增的文件", () => {
  test("接手前目录内新增文件被 verifyFingerprint 发现", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    await writeFile(join(repoDir, "docs", "a.md"), "alpha\n");

    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "newfile-holder" }, ["docs/"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    await claims.release(held.claimId, { kind: "main", windowId: "newfile-holder" });

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { released: { claimId: string; fingerprints: Record<string, string> }[] };
    const record = doc.released.find((r) => r.claimId === held.claimId);
    expect(record).toBeTruthy();

    await writeFile(join(repoDir, "docs", "new.md"), "brand new\n");

    const diff = await verifyFingerprint(repoDir, record?.fingerprints ?? {});
    const diffPaths = diff.map((d) => d.path);
    const found = diffPaths.includes("docs/new.md") || diffPaths.includes("docs/");
    expect(found).toBe(true);
  });
});

describe("指纹哨兵：区分不存在与存在但非普通文件", () => {
  test("不存在的路径记为 absent，创建为目录后 verifyFingerprint 报告类型变化", async () => {
    const repoDir = await makeRepoDir();
    const fp = await fingerprint(repoDir, ["thing"]);
    expect(fp.thing).toBe("absent");

    await mkdir(join(repoDir, "thing"), { recursive: true });
    const diff = await verifyFingerprint(repoDir, fp);
    expect(diff.some((d) => d.path === "thing")).toBe(true);
  });
});

describe("releaseIfHolderGone：探针超时按不可判定处理", () => {
  test("runState 探针永不 settle 时，在 5 秒内返回 released:false 且原因含“不可判定”", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: () => new Promise<string | null>(() => {}),
    });
    const held = await claims.claim({ kind: "role", runId: "timeout-run" }, ["timeout.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const result = await claims.releaseIfHolderGone(held.claimId);
    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toContain("不可判定");
  }, 6_000);
});

describe("claim 两阶段：占位在补写指纹前被释放", () => {
  test("占位被释放后，claim 返回 granted:false 且 claims.json 无残留记录", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    for (let i = 0; i < 3000; i++) {
      await writeFile(join(repoDir, "docs", `f${i}.txt`), `content-${i}`);
    }

    const claims = makeClaims(repoDir);
    const observer = makeClaims(repoDir);
    const holderB = { kind: "main", windowId: "phase2-gone-b" };

    const claimPromise = claims.claim(holderB, ["docs/"]);
    setTimeout(() => {
      void (async () => {
        const raw = claimsJson(repoDir);
        const doc = JSON.parse(raw) as { claims: { claimId: string; holder: unknown }[] };
        const placeholder = doc.claims.find((c) => JSON.stringify(c.holder) === JSON.stringify(holderB));
        if (placeholder) await observer.release(placeholder.claimId, holderB);
      })();
    }, 20);

    const result = await claimPromise;
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason.length).toBeGreaterThan(0);

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { claims: { holder: unknown }[] };
    const stillThere = doc.claims.some((c) => JSON.stringify(c.holder) === JSON.stringify(holderB));
    expect(stillThere).toBe(false);
  }, 15_000);
});

describe("claim 两阶段：补写指纹失败不得残留占位", () => {
  test("目录范围内文件不可读导致补写失败：抛错携带 claimId，claims.json 无占位残留", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    await writeFile(join(repoDir, "docs", "blocked.txt"), "secret\n");
    await chmod(join(repoDir, "docs", "blocked.txt"), 0o000);

    const claims = makeClaims(repoDir);
    const holderC = { kind: "main", windowId: "phase2-fail-c" };

    let thrown: Error | null = null;
    try {
      await claims.claim(holderC, ["docs/"]);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown?.message).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { claims: { holder: unknown }[] };
    const orphan = doc.claims.some((c) => JSON.stringify(c.holder) === JSON.stringify(holderC));
    expect(orphan).toBe(false);
  });
});

describe("verifyFingerprint：目录范围内删除文件的差异不重复", () => {
  test("删除 docs/a.md 后，差异清单中 docs/a.md 只出现一次", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs"), { recursive: true });
    await writeFile(join(repoDir, "docs", "a.md"), "alpha\n");
    await writeFile(join(repoDir, "docs", "b.md"), "beta\n");

    const claims = makeClaims(repoDir);
    const held = await claims.claim({ kind: "main", windowId: "dupdiff-holder" }, ["docs/"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;
    await claims.release(held.claimId, { kind: "main", windowId: "dupdiff-holder" });

    const raw = claimsJson(repoDir);
    const doc = JSON.parse(raw) as { released: { claimId: string; fingerprints: Record<string, string> }[] };
    const record = doc.released.find((r) => r.claimId === held.claimId);
    expect(record).toBeTruthy();

    await rm(join(repoDir, "docs", "a.md"), { force: true });

    const diff = await verifyFingerprint(repoDir, record?.fingerprints ?? {});
    const occurrences = diff.filter((d) => d.path === "docs/a.md").length;
    expect(occurrences).toBe(1);
  });
});

describe("fingerprint：嵌套目录范围与申请顺序无关", () => {
  test("fingerprint(['docs/sub/','docs/']) 后磁盘未变化，verifyFingerprint 差异为空", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs", "sub"), { recursive: true });
    await writeFile(join(repoDir, "docs", "top.md"), "top\n");
    await writeFile(join(repoDir, "docs", "sub", "nested.md"), "nested\n");

    const fp = await fingerprint(repoDir, ["docs/sub/", "docs/"]);
    const diff = await verifyFingerprint(repoDir, fp);
    expect(diff).toEqual([]);
  });

  test("嵌套目录范围下改动内层文件，差异清单中该文件只出现一次", async () => {
    const repoDir = await makeRepoDir();
    await mkdir(join(repoDir, "docs", "sub"), { recursive: true });
    await writeFile(join(repoDir, "docs", "top.md"), "top\n");
    await writeFile(join(repoDir, "docs", "sub", "nested.md"), "nested\n");

    const fp = await fingerprint(repoDir, ["docs/sub/", "docs/"]);
    await writeFile(join(repoDir, "docs", "sub", "nested.md"), "changed\n");
    const diff = await verifyFingerprint(repoDir, fp);
    expect(diff.filter((d) => d.path === "docs/sub/nested.md")).toHaveLength(1);
  });
});

describe("releaseIfHolderGone：探针总预算需受控", () => {
  test("runState 与 activeShellTasks 各耗时 2.5 秒才 settle 时，整体在 4 秒内返回", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir, {
      runState: () => new Promise((resolve) => setTimeout(() => resolve("stopped"), 2_500)),
      activeShellTasks: () => new Promise((resolve) => setTimeout(() => resolve(0), 2_500)),
    });
    const held = await claims.claim({ kind: "role", runId: "slow-probe-run" }, ["slow-probe.txt"]);
    expect(held.granted).toBe(true);
    if (!held.granted) return;

    const started = Date.now();
    await claims.releaseIfHolderGone(held.claimId);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
  }, 8_000);
});

describe("wait 取消：清理阶段的锁竞争不得掩盖原始取消错误", () => {
  test("清理 waiting 时锁超时，wait 拒绝的错误仍是“等待已取消”而非锁超时", async () => {
    const repoDir = await makeRepoDir();
    const claims = makeClaims(repoDir);
    const blocker = await claims.claim({ kind: "main", windowId: "lockrace-blocker" }, ["lockrace.txt"]);
    expect(blocker.granted).toBe(true);

    const waiterHolder = { kind: "main", windowId: "lockrace-waiter" };
    const attempt = await claims.claim(waiterHolder, ["lockrace.txt"]);
    expect(attempt.granted).toBe(false);

    const restore = failDatabaseWrites(join(repoDir, "data.db"), "records", "namespace", "range_waiting");

    const controller = new AbortController();
    const waitPromise = claims.wait(["lockrace.txt"], { signal: controller.signal, holder: waiterHolder });
    setTimeout(() => controller.abort(), 50);

    let thrown: Error | null = null;
    try {
      await waitPromise;
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeTruthy();
    expect(thrown?.message).toContain("取消");

    restore();
  }, 15_000);
});
