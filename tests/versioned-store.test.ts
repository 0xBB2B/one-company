import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LockTimeoutError,
  StaleVersionError,
  appendLine,
  createDocument,
  fileFingerprint,
  readDocument,
  readLines,
  withDirLock,
  writeDocument,
} from "../runtime/store.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-versioned-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createDocument / readDocument", () => {
  test("首次 createDocument 后 readDocument 返回 version 1 与原 data", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    const created = await createDocument(path, { name: "示例" });
    expect(created).toEqual({ version: 1 });
    const doc = await readDocument(path);
    if (!doc.exists) throw new Error("期望文档存在");
    expect(doc.version).toBe(1);
    expect(doc.data).toEqual({ name: "示例" });
  });

  test("createDocument 对已存在文件抛错且内容不变", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { name: "原始" });
    const before = await readFile(path, "utf8");
    await expect(createDocument(path, { name: "覆盖" })).rejects.toThrow();
    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  test("createDocument 在父目录不存在时自动创建目录后写入", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "a", "b", "c", "doc.json");
    const created = await createDocument(path, { nested: true });
    expect(created).toEqual({ version: 1 });
    const doc = await readDocument(path);
    if (!doc.exists) throw new Error("期望文档存在");
    expect(doc.data).toEqual({ nested: true });
  });

  test("文档文件为 UTF-8 JSON 对象且以换行结尾", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { hello: "世界" });
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ version: 1, data: { hello: "世界" } });
  });

  test("readDocument 对不存在的文件返回 exists:false", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "missing.json");
    expect(await readDocument(path)).toEqual({ exists: false });
  });

  test("readDocument 对非法 JSON 内容抛出含损坏的错误", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await writeFile(path, "{not valid json\n", "utf8");
    await expect(readDocument(path)).rejects.toThrow("损坏");
  });

  test("readDocument 对非对象 JSON 抛出含损坏的错误", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await writeFile(path, "[1,2,3]\n", "utf8");
    await expect(readDocument(path)).rejects.toThrow("损坏");
  });

  test("readDocument 对缺少或非法正整数 version 抛出含损坏的错误", async () => {
    const dir = await makeTempDir();
    const cases = [{ data: {} }, { version: 0, data: {} }, { version: -1, data: {} }, { version: 1.5, data: {} }];
    for (const [index, content] of cases.entries()) {
      const path = join(dir, `doc-${index}.json`);
      await writeFile(path, `${JSON.stringify(content)}\n`, "utf8");
      await expect(readDocument(path)).rejects.toThrow("损坏");
    }
  });
});

describe("writeDocument 版本控制", () => {
  test("writeDocument 对不存在的文件抛错，要求先 createDocument", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "missing.json");
    await expect(writeDocument(path, { a: 1 }, { expectedVersion: 1 })).rejects.toThrow();
  });

  test("两个窗口基于同一版本更新，后到者被拒绝并提示重新读取，先前内容保留", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { value: "init" });
    const readByFirst = await readDocument(path);
    const readBySecond = await readDocument(path);
    if (!readByFirst.exists || !readBySecond.exists) throw new Error("期望文档存在");
    expect(readByFirst.version).toBe(1);
    expect(readBySecond.version).toBe(1);

    const first = await writeDocument(path, { value: "first" }, { expectedVersion: readByFirst.version });
    expect(first).toEqual({ version: 2 });

    let caught: unknown;
    try {
      await writeDocument(path, { value: "second" }, { expectedVersion: readBySecond.version });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StaleVersionError);
    expect((caught as Error).message).toContain("重新读取");

    const final = await readDocument(path);
    if (!final.exists) throw new Error("期望文档存在");
    expect(final.version).toBe(2);
    expect(final.data).toEqual({ value: "first" });
  });

  test("写入的 data 整体替换生效，不做字段级部分写入", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { a: 1, b: 2 });
    await writeDocument(path, { a: 99 }, { expectedVersion: 1 });
    const doc = await readDocument(path);
    if (!doc.exists) throw new Error("期望文档存在");
    expect(doc.data).toEqual({ a: 99 });
  });

  test("十个并发 writeDocument 读后写重试最终 version 为 11 且每次成功恰递增 1", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { count: 0 });

    async function writer(id: number): Promise<number> {
      for (;;) {
        const doc = await readDocument(path);
        if (!doc.exists) throw new Error("期望文档存在");
        try {
          const result = await writeDocument(path, { count: id }, { expectedVersion: doc.version });
          return result.version;
        } catch (error) {
          if (error instanceof StaleVersionError) continue;
          throw error;
        }
      }
    }

    const versions = await Promise.all(Array.from({ length: 10 }, (_, i) => writer(i)));
    expect(new Set(versions).size).toBe(10);
    expect(versions.slice().sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const final = await readDocument(path);
    if (!final.exists) throw new Error("期望文档存在");
    expect(final.version).toBe(11);
  });
});

describe("writeDocument 原子写入与中断保护", () => {
  test("writeDocument 成功后目录内除文档外无残留临时文件", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { a: 1 });
    await writeDocument(path, { a: 2 }, { expectedVersion: 1 });
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["doc.json"]);
  });

  test("beforeRename 钩子在 rename 前被 await", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { a: 1 });
    const events: string[] = [];
    let sawPreRenameVersion = false;
    await writeDocument(path, { a: 2 }, {
      expectedVersion: 1,
      beforeRename: async () => {
        events.push("beforeRename");
        const doc = await readDocument(path);
        sawPreRenameVersion = doc.exists && doc.version === 1;
      },
    });
    events.push("resolved");
    expect(events).toEqual(["beforeRename", "resolved"]);
    expect(sawPreRenameVersion).toBe(true);
  });

  test("beforeRename 抛错时文件保持旧内容，不伪报成功，目录内无残留临时文件", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "doc.json");
    await createDocument(path, { value: "old" });

    await expect(
      writeDocument(path, { value: "new" }, {
        expectedVersion: 1,
        beforeRename: async () => {
          throw new Error("模拟中断");
        },
      }),
    ).rejects.toThrow("模拟中断");

    const doc = await readDocument(path);
    if (!doc.exists) throw new Error("期望文档存在");
    expect(doc.version).toBe(1);
    expect(doc.data).toEqual({ value: "old" });

    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["doc.json"]);
  });
});

describe("withDirLock", () => {
  test("上次进程崩溃残留的锁目录被自动清除而不是等到超时", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".lock"));
    await writeFile(join(dir, ".lock", "owner"), "999999\n");
    const startedAt = Date.now();
    const result = await withDirLock(dir, async () => "ok", { timeoutMs: 5_000 });
    expect(result).toBe("ok");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("withDirLock 返回 fn 的返回值", async () => {
    const dir = await makeTempDir();
    const result = await withDirLock(dir, async () => 42);
    expect(result).toBe(42);
  });

  test("两个并发 withDirLock 的临界区不重叠", async () => {
    const dir = await makeTempDir();
    let active = 0;
    let overlapped = false;

    async function critical(): Promise<void> {
      return withDirLock(dir, async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    }

    await Promise.all([critical(), critical()]);
    expect(overlapped).toBe(false);
  });

  test("锁被占用超过 timeoutMs 时 withDirLock 抛出含锁字样的 LockTimeoutError", async () => {
    const dir = await makeTempDir();
    let lockAcquiredResolve: () => void = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      lockAcquiredResolve = resolve;
    });
    let release: () => void = () => {};
    const holder = withDirLock(dir, () => {
      lockAcquiredResolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await lockAcquired;

    let caught: unknown;
    try {
      await withDirLock(dir, async () => {}, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    release();
    await holder;

    expect(caught).toBeInstanceOf(LockTimeoutError);
    expect((caught as Error).message).toContain("锁");
  });

  test("fn 抛异常后锁目录被移除，异常原样抛出，下一次加锁立即成功", async () => {
    const dir = await makeTempDir();
    await expect(
      withDirLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(stat(join(dir, ".lock"))).rejects.toThrow();

    const result = await withDirLock(dir, async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("appendLine / readLines", () => {
  test("appendLine 文件不存在时创建并写入第一行", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");
    const result = await appendLine(path, { a: 1 });
    expect(result).toEqual({ lineNumber: 1, line: JSON.stringify({ a: 1 }) });
    const raw = await readFile(path, "utf8");
    expect(raw).toBe(`${JSON.stringify({ a: 1 })}\n`);
  });

  test("readLines 对不存在的文件返回空数组", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "missing.ndjson");
    expect(await readLines(path)).toEqual([]);
  });

  test("十个并发 appendLine 全部成功且各占一行、无交错、lineNumber 为 1..10 各一次", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => appendLine(path, { i })));
    const lineNumbers = results.map((r) => r.lineNumber).sort((a, b) => a - b);
    expect(lineNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBe(10);
    for (const line of lines) {
      expect(JSON.stringify(JSON.parse(line))).toBe(line);
    }

    const records = await readLines(path);
    expect(records.length).toBe(10);
  });

  test("appendLine 对已损坏的既有记录拒绝追加，报错含损坏与行号且文件不变", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");
    await writeFile(path, '{"a":1}\n{"b": 2}\n', "utf8");
    const before = await fileFingerprint(path);

    let caught: unknown;
    try {
      await appendLine(path, { c: 3 });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("损坏");
    expect((caught as Error).message).toContain("2");

    const after = await fileFingerprint(path);
    expect(after).toBe(before);
  });

  test("readLines 对已损坏的记录行抛出含行号的损坏错误", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");
    await writeFile(path, '{"a":1}\nnot json\n', "utf8");

    let caught: unknown;
    try {
      await readLines(path);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain("损坏");
    expect((caught as Error).message).toContain("2");
  });

  test("文件末尾缺换行时 appendLine 拒绝追加", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");
    await writeFile(path, '{"a":1}', "utf8");
    await expect(appendLine(path, { b: 2 })).rejects.toThrow("损坏");
  });

  test("appendLine 写入后原有字节前缀保持不变", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.ndjson");
    await appendLine(path, { a: 1 });
    const afterFirst = await readFile(path, "utf8");
    await appendLine(path, { b: 2 });
    const afterSecond = await readFile(path, "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
  });
});

describe("fileFingerprint", () => {
  test("对相同内容返回相同的 sha256 十六进制值", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "f.txt");
    await writeFile(path, "hello", "utf8");
    const first = await fileFingerprint(path);
    const second = await fileFingerprint(path);
    expect(first).toBe(second);
    expect(first).toBe(createHash("sha256").update("hello").digest("hex"));
  });

  test("改一个字节后指纹不同", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "f.txt");
    await writeFile(path, "hello", "utf8");
    const before = await fileFingerprint(path);
    await writeFile(path, "hellp", "utf8");
    const after = await fileFingerprint(path);
    expect(after).not.toBe(before);
  });
});

describe("本机保存", () => {
  test("流程数据只依赖给定路径本地存储，工作目录被删除不影响已保存内容", async () => {
    const workspaceDir = await makeTempDir();
    const dataDir = await makeTempDir();
    const path = join(dataDir, "doc.json");
    await createDocument(path, { note: "本机保存" });

    await rm(workspaceDir, { recursive: true, force: true });

    const doc = await readDocument(path);
    if (!doc.exists) throw new Error("期望文档存在");
    expect(doc.data).toEqual({ note: "本机保存" });
  });
});

describe("锁的原子获取与回收", () => {
  test("多个等待者面对同一把残留锁时互斥不被破坏且都能完成", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".lock"));
    await writeFile(join(dir, ".lock", "owner"), "999999\n");
    let inside = 0;
    let overlap = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withDirLock(dir, async () => {
          inside += 1;
          if (inside > 1) overlap += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          const lockExists = await stat(join(dir, ".lock")).then(() => true, () => false);
          inside -= 1;
          return lockExists;
        }, { timeoutMs: 5_000 }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(results.map((r) => (r as PromiseFulfilledResult<boolean>).value)).toEqual([true, true, true, true]);
    expect(overlap).toBe(0);
  });

  test("没有 owner 文件的空锁目录被视为无效并被接管", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".lock"));
    const startedAt = Date.now();
    await withDirLock(dir, async () => undefined, { timeoutMs: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("释放锁失败不掩盖 fn 的返回值", async () => {
    const dir = await makeTempDir();
    const result = await withDirLock(dir, async () => {
      await rm(join(dir, ".lock"), { recursive: true, force: true });
      return "值";
    });
    expect(result).toBe("值");
  });
});

describe("写入路径的健壮性", () => {
  test("appendLine 对无法序列化的值在写入前拒绝且文件不变", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.jsonl");
    await appendLine(path, { a: 1 });
    const before = await fileFingerprint(path);
    await expect(appendLine(path, undefined)).rejects.toThrow();
    expect(await fileFingerprint(path)).toBe(before);
    expect(await readLines(path)).toEqual([{ a: 1 }]);
  });

  test("appendLine 在父目录不存在时自动创建", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "nested", "deeper", "log.jsonl");
    await appendLine(path, { a: 1 });
    expect(await readLines(path)).toEqual([{ a: 1 }]);
  });

  test("文档与记录文件权限为 0600", async () => {
    const dir = await makeTempDir();
    const docPath = join(dir, "doc.json");
    const logPath = join(dir, "log.jsonl");
    await createDocument(docPath, { v: 1 });
    await writeDocument(docPath, { v: 2 }, { expectedVersion: 1 });
    await appendLine(logPath, { a: 1 });
    expect((await stat(docPath)).mode & 0o777).toBe(0o600);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  test("createDocument 与并发读取不会把半写文件误报为损坏", async () => {
    for (let round = 0; round < 20; round += 1) {
      const dir = await makeTempDir();
      const path = join(dir, "doc.json");
      const [created, read] = await Promise.all([createDocument(path, { round }), readDocument(path)]);
      expect(created.version).toBe(1);
      if (read.exists) expect(read.data).toEqual({ round });
    }
  });

  test("appendLine 与并发 readLines 不会把追加中的文件误报为损坏", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.jsonl");
    await appendLine(path, { seed: true });
    const writers = Array.from({ length: 10 }, (_, i) => appendLine(path, { i }));
    const readers = Array.from({ length: 10 }, () => readLines(path));
    const settled = await Promise.allSettled([...writers, ...readers]);
    expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
  });
});

describe("锁的令牌身份与可重入", () => {
  test("三百轮十等待者残留锁下持锁期间锁目录 inode 不变、无重叠且无锁残留", async () => {
    for (let round = 0; round < 300; round += 1) {
      const dir = await makeTempDir();
      await mkdir(join(dir, ".lock"));
      await writeFile(join(dir, ".lock", "owner"), "999999\n");
      let inside = 0;
      let overlap = 0;
      let replaced = 0;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          withDirLock(dir, async () => {
            inside += 1;
            if (inside > 1) overlap += 1;
            const before = (await stat(join(dir, ".lock"))).ino;
            await new Promise((resolve) => setTimeout(resolve, 2));
            const after = await stat(join(dir, ".lock")).then((s) => s.ino, () => -1);
            if (after !== before) replaced += 1;
            inside -= 1;
          }),
        ),
      );
      expect(overlap).toBe(0);
      expect(replaced).toBe(0);
      expect((await readdir(dir)).filter((name) => name.startsWith(".lock"))).toEqual([]);
    }
  }, 120_000);

  test("同一异步上下文内嵌套加锁可重入，锁内读记录再追加不死锁", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "log.jsonl");
    const startedAt = Date.now();
    const result = await withDirLock(dir, async () => {
      const before = await readLines(path);
      await appendLine(path, { n: before.length + 1 });
      return withDirLock(dir, () => readLines(path), { timeoutMs: 300 });
    }, { timeoutMs: 300 });
    expect(result).toEqual([{ n: 1 }]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await stat(join(dir, ".lock")).then(() => true, () => false)).toBe(false);
  });

  test("自建目录权限为 0700", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "n1", "n2", "doc.json");
    await createDocument(path, { v: 1 });
    expect((await stat(join(dir, "n1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "n1", "n2"))).mode & 0o777).toBe(0o700);
  });
});

describe("持有集只在临界区内有效", () => {
  test("临界区内启动、释放后才执行的异步链必须真正加锁", async () => {
    const dir = await makeTempDir();
    let lockedDuringLateCall = false;
    let late: Promise<void> | null = null;
    await withDirLock(dir, async () => {
      late = new Promise((resolve) => {
        setTimeout(() => {
          void withDirLock(dir, async () => {
            lockedDuringLateCall = await stat(join(dir, ".lock")).then(() => true, () => false);
          }).then(() => resolve());
        }, 30);
      });
    });
    await late!;
    expect(lockedDuringLateCall).toBe(true);
  });

  test("多轮并发追加与读取都不误报损坏且不超时", async () => {
    for (let round = 0; round < 20; round += 1) {
      const dir = await makeTempDir();
      const path = join(dir, "log.jsonl");
      await appendLine(path, { seed: true });
      const settled = await Promise.allSettled([
        ...Array.from({ length: 10 }, (_, i) => appendLine(path, { i })),
        ...Array.from({ length: 10 }, () => readLines(path)),
      ]);
      expect(settled.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      expect((await readLines(path)).length).toBe(11);
    }
  }, 60_000);
});
