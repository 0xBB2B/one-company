import { readRecord, putRecord, repositoryDatabase, withDatabase, uuidv7 } from "../runtime/database.ts";
import { failDatabaseWrites, testRepoId } from "./helpers/database-fixture.ts";
import type { ErrorDetailsRef } from "../runtime/error-details.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  extractErrorDetail,
  readErrorDetails,
  summarizeErrorDetails,
  writeErrorDetails,
} from "../runtime/error-details.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRunDir(): Promise<ErrorDetailsRef> {
  const dir = await mkdtemp(join(tmpdir(), "pi-company-error-details-"));
  tempRoots.push(dir);
  return { dataRoot: dir, repoId: testRepoId(), runId: uuidv7() };
}

function databasePath(ref: ErrorDetailsRef): string { return repositoryDatabase(ref.dataRoot, ref.repoId); }
function detailRef(ref: ErrorDetailsRef) { return { database: databasePath(ref), namespace: "error_details", key: ref.runId }; }
function detailJson(ref: ErrorDetailsRef): string {
  const record = readRecord(detailRef(ref));
  if (!record.exists) throw new Error("诊断不存在");
  return JSON.stringify(record.data);
}

function baseInput(ref: ErrorDetailsRef, overrides: Record<string, unknown> = {}) {
  return {
    runId: ref.runId,
    model: { provider: "anthropic", id: "claude-test" },
    ...overrides,
  };
}

describe("extractErrorDetail", () => {
  test("标准 Error 对象提取 message/name/stack", () => {
    const error = new Error("失败了");
    const detail = extractErrorDetail(error);
    expect(detail.message).toBe("失败了");
    expect(detail.name).toBe("Error");
    expect(detail.stack).toBeTruthy();
  });

  test("三层 cause 链逐层保留", () => {
    const root = new Error("根因");
    const middle = new Error("中间层", { cause: root });
    const top = new Error("顶层", { cause: middle });
    const detail = extractErrorDetail(top);
    expect(detail.message).toBe("顶层");
    expect(detail.cause?.message).toBe("中间层");
    expect(detail.cause?.cause?.message).toBe("根因");
  });

  test("只有 terminated 消息时无附加原因", () => {
    const error = new Error("terminated");
    const detail = extractErrorDetail(error);
    expect(detail.message).toBe("terminated");
    expect(detail.noAdditionalCause).toBe(true);
    expect(detail.cause).toBeUndefined();
  });

  test("已知字段 code/status/requestId 被收入 fields", () => {
    const error = Object.assign(new Error("请求失败"), {
      code: "ERR_TIMEOUT",
      status: 503,
      requestId: "req-xyz",
    });
    const detail = extractErrorDetail(error);
    expect(detail.fields.code).toBe("ERR_TIMEOUT");
    expect(detail.fields.status).toBe(503);
    expect(detail.fields.requestId).toBe("req-xyz");
  });

  test("statusCode 与 request_id 别名同样被收入 fields", () => {
    const error = Object.assign(new Error("请求失败"), {
      statusCode: 429,
      request_id: "req-alias",
    });
    const detail = extractErrorDetail(error);
    expect(detail.fields.status).toBe(429);
    expect(detail.fields.requestId).toBe("req-alias");
  });

  test("环引用的 cause 不抛出且不无限递归", () => {
    const a: Record<string, unknown> = new Error("a");
    const b: Error = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => extractErrorDetail(b)).not.toThrow();
  });

  test("request/response 等容器属性不被序列化进 fields", () => {
    const error = Object.assign(new Error("请求失败"), {
      request: { url: "https://example.com", body: "敏感请求体" },
      response: { data: "敏感响应体" },
    });
    const detail = extractErrorDetail(error);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("敏感请求体");
    expect(serialized).not.toContain("敏感响应体");
  });

  test("字符串错误值也能得到 message", () => {
    const detail = extractErrorDetail("纯字符串错误");
    expect(detail.message).toBe("纯字符串错误");
  });

  test("数字错误值也能得到 message", () => {
    const detail = extractErrorDetail(42);
    expect(typeof detail.message).toBe("string");
    expect(detail.message.length).toBeGreaterThan(0);
  });

  test("null 错误值也能得到 message", () => {
    const detail = extractErrorDetail(null);
    expect(typeof detail.message).toBe("string");
    expect(detail.message.length).toBeGreaterThan(0);
  });

  test("超长错误原文长度不被截断", () => {
    const longMessage = "错".repeat(50001);
    const detail = extractErrorDetail(new Error(longMessage));
    expect(detail.message.length).toBe(longMessage.length);
  });

  test("status 为字符串数字时被数字化收入 fields", () => {
    const error = Object.assign(new Error("请求失败"), { status: "503" });
    const detail = extractErrorDetail(error);
    expect(detail.fields.status).toBe(503);
  });

  test("code 为数字时被字符串化收入 fields", () => {
    const error = Object.assign(new Error("请求失败"), { code: 500 });
    const detail = extractErrorDetail(error);
    expect(detail.fields.code).toBe("500");
  });

  test("requestId 为数字时被字符串化收入 fields", () => {
    const error = Object.assign(new Error("请求失败"), { requestId: 12345 });
    const detail = extractErrorDetail(error);
    expect(detail.fields.requestId).toBe("12345");
  });

  test("cause 形成循环时内层标记 causeCycle 而非误判为无原因", () => {
    const a: Record<string, unknown> = new Error("a");
    const b: Error = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const detail = extractErrorDetail(b);
    expect(detail.cause?.causeCycle).toBe(true);
    expect(detail.cause?.noAdditionalCause).not.toBe(true);
  });

  test("stack 属性为抛出异常的 getter 时不抛出，得到 message 且 stack 缺省", () => {
    const error = new Error("失败");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack getter 故意抛出");
      },
      configurable: true,
    });
    let detail: ReturnType<typeof extractErrorDetail> | undefined;
    expect(() => {
      detail = extractErrorDetail(error);
    }).not.toThrow();
    expect(detail?.message).toBe("失败");
    expect(detail?.stack).toBeUndefined();
  });
});

describe("writeErrorDetails / readErrorDetails", () => {
  test("首次写入成功并可读回", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("首次失败"),
    });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const readBack = await readErrorDetails(runDir);
      expect(readBack.readable).toBe(true);
      if (readBack.readable) {
        expect(readBack.details.original.message).toBe("首次失败");
      }
    }
  });

  test("文件权限为 0600", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const info = await stat(databasePath(runDir));
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  test("4001 字符的错误原文完整保留不截断", async () => {
    const runDir = await createRunDir();
    const longMessage = "x".repeat(4001);
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error(longMessage) });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const raw = detailJson(runDir);
      const parsed = JSON.parse(raw);
      expect(parsed.original.message.length).toBe(4001);
    }
  });

  test("50001 字符的错误原文完整保留不截断", async () => {
    const runDir = await createRunDir();
    const longMessage = "y".repeat(50001);
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error(longMessage) });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const raw = detailJson(runDir);
      const parsed = JSON.parse(raw);
      expect(parsed.original.message.length).toBe(50001);
    }
  });

  test("含凭据特征的原文写盘后读回一字不改", async () => {
    const runDir = await createRunDir();
    const message = '请求失败 Authorization: Bearer x api_key="secret-value" https://user:p4ssw0rd@example.com/api';
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error(message) });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const readBack = await readErrorDetails(runDir);
      expect(readBack.readable).toBe(true);
      if (readBack.readable) {
        expect(readBack.details.original.message).toBe(message);
      }
    }
  });

  test("再次写入 original 与 failedAt 保持首次值，cleanup 追加一条", async () => {
    const runDir = await createRunDir();
    const firstInput = baseInput(runDir);
    const first = await writeErrorDetails(runDir, { ...firstInput, error: new Error("原始失败") });
    expect(first.saved).toBe(true);
    if (!first.saved) return;
    const firstRead = await readErrorDetails(runDir);
    expect(firstRead.readable).toBe(true);
    if (!firstRead.readable) return;
    const firstFailedAt = firstRead.details.failedAt;
    const firstOriginal = firstRead.details.original;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("原始失败"),
      cleanupError: new Error("清理失败"),
    });
    expect(second.saved).toBe(true);

    const secondRead = await readErrorDetails(runDir);
    expect(secondRead.readable).toBe(true);
    if (!secondRead.readable) return;
    expect(secondRead.details.failedAt).toBe(firstFailedAt);
    expect(secondRead.details.original).toEqual(firstOriginal);
    expect(secondRead.details.runId).toBe(firstInput.runId);
    expect(secondRead.details.cleanup.length).toBe(1);
    expect(secondRead.details.cleanup[0]?.message).toBe("清理失败");
  });

  test("已存在但损坏的旧文件不被覆盖，返回带'损坏'的失败原因", async () => {
    const runDir = await createRunDir();
    const path = databasePath(runDir);
    const corrupted = '{"version":1,"runId":"abc"';
    putRecord(detailRef(runDir), corrupted);
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("新失败") });
    expect(result.saved).toBe(false);
    if (!result.saved) {
      expect(result.reason).toContain("损坏");
    }
    expect(readRecord(detailRef(runDir))).toMatchObject({ data: corrupted });
  });

  test("写入后目录内无 .tmp 残留文件", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(result.saved).toBe(true);
    const entries = await readdir(dirname(databasePath(runDir)));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("rename 目标被同名目录占用时返回 saved:false 且不残留临时文件", async () => {
    const runDir = await createRunDir();
    await mkdir(databasePath(runDir), { recursive: true });
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(result.saved).toBe(false);
    const entries = await readdir(dirname(databasePath(runDir)));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("并发两次写入不同 cleanupError 时 cleanup 保留两条不丢失", async () => {
    const runDir = await createRunDir();
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("原始失败") });
    await Promise.all([
      writeErrorDetails(runDir, {
        ...baseInput(runDir),
        error: new Error("原始失败"),
        cleanupError: new Error("清理失败一"),
      }),
      writeErrorDetails(runDir, {
        ...baseInput(runDir),
        error: new Error("原始失败"),
        cleanupError: new Error("清理失败二"),
      }),
    ]);
    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(true);
    if (readBack.readable) {
      expect(readBack.details.cleanup.length).toBe(2);
    }
  });

  test("二次写入仅带 cleanupError 时 runId/model/submissions 保持首次值", async () => {
    const runDir = await createRunDir();
    const first = await writeErrorDetails(runDir, {
      runId: runDir.runId,
      model: { provider: "anthropic", id: "claude-first" },
      error: new Error("原始失败"),
      submissions: {
        attemptCount: 1,
        validCount: 1,
        attempts: [
          { toolCallId: "call-1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 },
        ],
      },
    });
    expect(first.saved).toBe(true);

    const second = await writeErrorDetails(runDir, {
      runId: runDir.runId,
      model: { provider: "anthropic", id: "claude-second" },
      error: new Error("原始失败"),
      cleanupError: new Error("清理失败"),
    });
    expect(second.saved).toBe(true);

    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(true);
    if (readBack.readable) {
      expect(readBack.details.runId).toBe(runDir.runId);
      expect(readBack.details.model).toEqual({ provider: "anthropic", id: "claude-first" });
      expect(readBack.details.submissions.attemptCount).toBe(1);
      expect(readBack.details.submissions.attempts.length).toBe(1);
    }
  });

  test("同一清理错误再次写入不重复", async () => {
    const runDir = await createRunDir();
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("原始失败") });
    await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("原始失败"),
      cleanupError: new Error("清理失败"),
    });
    await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("原始失败"),
      cleanupError: new Error("清理失败"),
    });
    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(true);
    if (readBack.readable) {
      expect(readBack.details.cleanup.length).toBe(1);
    }
  });

  test("写入目标不可写时返回带原因的失败状态且不抛出", async () => {
    const runDir = await createRunDir();
    withDatabase(databasePath(runDir), () => {});
    const restore = failDatabaseWrites(databasePath(runDir), "records", "namespace", "error_details");
    try {
      const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
      expect(result.saved).toBe(false);
      if (!result.saved) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    } finally {
      restore();
    }
  });

  test("runDir 为普通文件时返回带原因的失败状态且不抛出", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-company-error-details-file-"));
    tempRoots.push(parent);
    const notADir = join(parent, "not-a-dir");
    await writeFile(notADir, "占位文件");
    const runDir = { dataRoot: notADir, repoId: testRepoId(), runId: uuidv7() };
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(result.saved).toBe(false);
    if (!result.saved) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("submissions 计数与提交记录被保存", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("失败"),
      submissions: {
        attemptCount: 2,
        validCount: 1,
        attempts: [
          {
            toolCallId: "call-1",
            valid: false,
            accepted: false,
            error: "格式错误",
            duplicateEvents: 0,
            conflictingEvents: 0,
          },
          {
            toolCallId: "call-2",
            valid: true,
            accepted: true,
            error: null,
            duplicateEvents: 0,
            conflictingEvents: 1,
          },
        ],
      },
    });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const raw = detailJson(runDir);
      const parsed = JSON.parse(raw);
      expect(parsed.submissions.attemptCount).toBe(2);
      expect(parsed.submissions.validCount).toBe(1);
      expect(parsed.submissions.attempts.length).toBe(2);
    }
  });

  test("submissions 不保存提交正文", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("失败"),
      submissions: {
        attemptCount: 1,
        validCount: 1,
        attempts: [
          {
            toolCallId: "call-1",
            valid: true,
            accepted: true,
            error: null,
            duplicateEvents: 0,
            conflictingEvents: 0,
            body: "独立标记XYZ",
            value: { text: "独立标记XYZ" },
          } as any,
        ],
      },
    });
    expect(result.saved).toBe(true);
    if (result.saved) {
      const raw = detailJson(runDir);
      expect(raw).not.toContain("独立标记XYZ");
    }
  });
});

describe("readErrorDetails 故障场景", () => {
  test("文件不存在返回 readable:false 且不伪造", async () => {
    const runDir = await createRunDir();
    const result = await readErrorDetails(runDir);
    expect(result.readable).toBe(false);
    if (!result.readable) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("JSON 非法返回 readable:false 且说明原因", async () => {
    const runDir = await createRunDir();
    putRecord(detailRef(runDir), "{不是合法 JSON");
    const result = await readErrorDetails(runDir);
    expect(result.readable).toBe(false);
    if (!result.readable) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("message 被篡改为数字时返回 readable:false", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(result.saved).toBe(true);
    if (!result.saved) return;
    const parsed = JSON.parse(detailJson(runDir));
    parsed.original.message = 12345;
    putRecord(detailRef(runDir), parsed);
    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(false);
  });

  test("attemptCount 被篡改为负数时返回 readable:false", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("失败"),
      submissions: {
        attemptCount: 1,
        validCount: 1,
        attempts: [
          { toolCallId: "call-1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 },
        ],
      },
    });
    expect(result.saved).toBe(true);
    if (!result.saved) return;
    const parsed = JSON.parse(detailJson(runDir));
    parsed.submissions.attemptCount = -1;
    putRecord(detailRef(runDir), parsed);
    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(false);
  });

  test("attemptCount 小于 validCount 时返回 readable:false", async () => {
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, {
      ...baseInput(runDir),
      error: new Error("失败"),
      submissions: {
        attemptCount: 2,
        validCount: 1,
        attempts: [
          { toolCallId: "call-1", valid: false, accepted: false, error: "无效", duplicateEvents: 0, conflictingEvents: 0 },
          { toolCallId: "call-2", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 },
        ],
      },
    });
    expect(result.saved).toBe(true);
    if (!result.saved) return;
    const parsed = JSON.parse(detailJson(runDir));
    parsed.submissions.attemptCount = 0;
    putRecord(detailRef(runDir), parsed);
    const readBack = await readErrorDetails(runDir);
    expect(readBack.readable).toBe(false);
  });
});

describe("summarizeErrorDetails", () => {
  test("已保存详情返回 saved:true 与不超过 120 字符的 headline", async () => {
    const runDir = await createRunDir();
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败原因") });
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.saved).toBe(true);
    expect(summary.headline.length).toBeLessThanOrEqual(120);
  });

  test("超长错误原文的 headline 仍不超过 120 字符", async () => {
    const runDir = await createRunDir();
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("超长原因".repeat(200)) });
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.headline.length).toBeLessThanOrEqual(120);
  });

  test("未保存详情时返回 saved:false 且带 reason", async () => {
    const runDir = await createRunDir();
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.saved).toBe(false);
    expect(summary.reason?.length).toBeGreaterThan(0);
  });

  test("返回的 path 与 writeErrorDetails 保存路径一致", async () => {
    const runDir = await createRunDir();
    const writeResult = await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error("失败") });
    expect(writeResult.saved).toBe(true);
    if (!writeResult.saved) return;
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.recordId).toBe(writeResult.recordId);
  });

  test("headline 不改写含凭据特征的原文，仅截断", async () => {
    const runDir = await createRunDir();
    const message = '请求失败 Authorization: Bearer x api_key="secret-value" https://user:p4ssw0rd@example.com/api';
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error(message) });
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.saved).toBe(true);
    expect(summary.headline).toBe(message);
  });

  test("headline 对连续 emoji 消息不产生孤立代理项", async () => {
    const runDir = await createRunDir();
    const message = "😀".repeat(100);
    await writeErrorDetails(runDir, { ...baseInput(runDir), error: new Error(message) });
    const summary = await summarizeErrorDetails(runDir);
    expect(summary.saved).toBe(true);
    expect(summary.headline.length).toBeLessThanOrEqual(120);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(summary.headline)).toBe(false);
  });
});

describe("错误值与合并的边界", () => {
  test("toString 抛错或空原型的错误值仍能提取并落盘", async () => {
    const hostile = { toString() { throw new Error("boom"); } };
    expect(() => extractErrorDetail(hostile)).not.toThrow();
    expect(extractErrorDetail(Object.create(null)).message.length).toBeGreaterThan(0);
    const runDir = await createRunDir();
    const result = await writeErrorDetails(runDir, baseInput(runDir, { error: hostile }));
    expect(result.saved).toBe(true);
  });

  test("后续更完整的提交诊断按标识合并且不覆盖此前尝试的错误", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    await writeErrorDetails(runDir, input);
    await writeErrorDetails(runDir, {
      ...input,
      submissions: {
        attemptCount: 1,
        validCount: 0,
        attempts: [{ toolCallId: "c1", valid: false, accepted: false, error: "首次错误", duplicateEvents: 0, conflictingEvents: 0 }],
      },
    });
    await writeErrorDetails(runDir, {
      ...input,
      submissions: {
        attemptCount: 2,
        validCount: 1,
        attempts: [
          { toolCallId: "c1", valid: false, accepted: false, error: "被改写的错误", duplicateEvents: 1, conflictingEvents: 0 },
          { toolCallId: "c2", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 },
        ],
      },
    });
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (!read.readable) return;
    expect(read.details.submissions.attemptCount).toBe(2);
    expect(read.details.submissions.validCount).toBe(1);
    expect(read.details.submissions.attempts.map((a) => a.toolCallId)).toEqual(["c1", "c2"]);
    expect(read.details.submissions.attempts[0]?.error).toBe("首次错误");
    expect(read.details.submissions.attempts[0]?.duplicateEvents).toBe(1);
  });

  test("旧文件不可读与内容非法的原因分别措辞", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    await writeErrorDetails(runDir, input);
    const path = databasePath(runDir);
    await rename(path, `${path}.saved`);
    await mkdir(path);
    try {
      const blocked = await writeErrorDetails(runDir, input);
      expect(blocked.saved).toBe(false);
      if (!blocked.saved) {
        expect(blocked.reason).toContain("数据库必须是普通文件");
        expect(blocked.reason).not.toContain("损坏");
      }
    } finally {
      await rm(path, { recursive: true });
      await rename(`${path}.saved`, path);
    }
  });

  test("自建运行目录权限为 0700", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-company-error-details-"));
    tempRoots.push(root);
    const runDir = { dataRoot: root, repoId: testRepoId(), runId: uuidv7() };
    await writeErrorDetails(runDir, baseInput(runDir, { error: new Error("失败") }));
    expect((await stat(dirname(databasePath(runDir)))).mode & 0o777).toBe(0o700);
  });
});

describe("提交诊断合并与写前自检", () => {
  test("合并后 validCount 按实际有效条数重算", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 1, attempts: [{ toolCallId: "c1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 }] } });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 1, attempts: [{ toolCallId: "c2", valid: true, accepted: false, error: null, duplicateEvents: 0, conflictingEvents: 0 }] } });
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (read.readable) {
      expect(read.details.submissions.attemptCount).toBe(2);
      expect(read.details.submissions.validCount).toBe(2);
    }
  });

  test("缺标识的提交尝试可写可读", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    const attempt = { valid: false, accepted: false, error: "无标识", duplicateEvents: 0, conflictingEvents: 0 };
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 0, attempts: [attempt] } });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 2, validCount: 0, attempts: [attempt, attempt] } });
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (read.readable) expect(read.details.submissions.attempts.length).toBe(3);
  });

  test("同标识后到的有效与接受状态覆盖首次值而错误保留首次", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 0, attempts: [{ toolCallId: "c1", valid: false, accepted: false, error: "首次错误", duplicateEvents: 0, conflictingEvents: 0 }] } });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 1, attempts: [{ toolCallId: "c1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 }] } });
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (read.readable) {
      expect(read.details.submissions.attempts[0]).toEqual({ toolCallId: "c1", valid: true, accepted: true, error: "首次错误", duplicateEvents: 0, conflictingEvents: 0 });
      expect(read.details.submissions.validCount).toBe(1);
    }
  });

  test("调用方计数自相矛盾时写入返回失败且不产出不可读文件", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    const result = await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 5, attempts: [] } });
    expect(result.saved).toBe(false);
    if (!result.saved) expect(result.reason).toContain("submissions");
    const exists = readRecord(detailRef(runDir)).exists;
    expect(exists).toBe(false);
  });
});

describe("合并时错误与模型字段的收敛", () => {
  test("同标识首次 error 为 null 时记录后续的具体错误", async () => {
    const runDir = await createRunDir();
    const input = baseInput(runDir, { error: new Error("原始失败") });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 1, attempts: [{ toolCallId: "c1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 }] } });
    await writeErrorDetails(runDir, { ...input, submissions: { attemptCount: 1, validCount: 1, attempts: [{ toolCallId: "c1", valid: true, accepted: false, error: "重复投递被拒", duplicateEvents: 0, conflictingEvents: 1 }] } });
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (read.readable) expect(read.details.submissions.attempts[0]?.error).toBe("重复投递被拒");
  });

  test("model 只保留 provider 与 id", async () => {
    const runDir = await createRunDir();
    await writeErrorDetails(runDir, baseInput(runDir, { error: new Error("失败"), model: { provider: "p", id: "m", apiKeyHint: "额外字段XYZ" } as { provider: string; id: string } }));
    const raw = detailJson(runDir);
    expect(raw).not.toContain("额外字段XYZ");
  });

  test("首次写入的计数与记录条数取齐", async () => {
    const runDir = await createRunDir();
    const attempt = { toolCallId: "c1", valid: true, accepted: true, error: null, duplicateEvents: 0, conflictingEvents: 0 };
    await writeErrorDetails(runDir, baseInput(runDir, { error: new Error("失败"), submissions: { attemptCount: 0, validCount: 0, attempts: [attempt] } }));
    const read = await readErrorDetails(runDir);
    expect(read.readable).toBe(true);
    if (read.readable) expect(read.details.submissions).toMatchObject({ attemptCount: 1, validCount: 1 });
  });
});
