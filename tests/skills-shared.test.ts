import { describe, expect, test } from "vitest";
import { skillLintErrors } from "./helpers/skill-lint.ts";

const TOPICS: Record<string, string[]> = {
  "web-api-security": ["OWASP Top 10:2025", "IDOR", "SSRF", "169.254.169.254", "DNS 重绑定", "输出编码", "批量赋值", "内部细节"],
  "auth-session": ["alg: none", "HttpOnly", "SameSite", "CSRF", "localStorage", "argon2id", "旧 token"],
  "supply-chain": ["--ignore-scripts", "lockfile", "save-exact", "冷却期", "经用户同意", "Shai-Hulud"],
  "relational-db": ["占位符", "白名单", "keyset", "死锁", "N+1", "连接池"],
  "redis": ["穿透", "布隆过滤器", "击穿", "singleflight", "逻辑过期", "雪崩", "抖动", "NX", "Lua", "Redlock", "fencing", "UNLINK"],
  "message-queue": ["幂等", "offset", "Outbox", "死信", "按 key 分区"],
  "service-runtime": ["超时", "退避", "抖动", "重试预算", "幂等键", "限流", "SIGTERM", "脱敏", "密钥"],
};

describe("共享 skill 内容检查", () => {
  test.each(Object.keys(TOPICS))("%s 格式与主题关键词全部合格", async (name) => {
    expect(await skillLintErrors(name, TOPICS[name]!)).toEqual([]);
  });
});
