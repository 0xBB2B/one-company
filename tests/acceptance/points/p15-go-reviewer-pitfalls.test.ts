import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { pointEvidence } from "../helpers/point-pm.ts";
import { pitCoverage, POINT_TIMEOUT_MS, runSpecialistReview, pit, specialistVerdict } from "../helpers/point-review.ts";
import type { SeededPit } from "../helpers/point-review.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const GO_PITS: SeededPit[] = [
  pit("svc/client.go", [
    "package svc",
    "",
    "import (",
    "\t\"io\"",
    "\t\"net/http\"",
    ")",
    "",
    "func FetchProfile(url string) ([]byte, error) {",
    "\tresp, err := http.Get(url)",
    "\tif err != nil {",
    "\t\treturn nil, err",
    "\t}",
    "\tdefer resp.Body.Close()",
    "\treturn io.ReadAll(resp.Body)",
    "}",
  ].join("\n"), "http.Get 没有超时", ["超时", "timeout", "http.Get", "默认客户端", "DefaultClient"]),
  pit("svc/cache.go", [
    "package svc",
    "",
    "type Cache struct {",
    "\titems map[string]string",
    "}",
    "",
    "func NewCache() *Cache {",
    "\treturn &Cache{}",
    "}",
    "",
    "func (c *Cache) Set(key, value string) {",
    "\tc.items[key] = value",
    "}",
  ].join("\n"), "往没有 make 的 map 里写数据", ["nil", "make", "未初始化", "初始化", "panic"]),
  pit("svc/counter.go", [
    "package svc",
    "",
    "import \"sync\"",
    "",
    "type Counter struct {",
    "\thits map[string]int",
    "}",
    "",
    "func NewCounter() *Counter {",
    "\treturn &Counter{hits: make(map[string]int)}",
    "}",
    "",
    "func (c *Counter) CountAll(keys []string) {",
    "\tvar wg sync.WaitGroup",
    "\tfor _, key := range keys {",
    "\t\twg.Add(1)",
    "\t\tgo func(k string) {",
    "\t\t\tdefer wg.Done()",
    "\t\t\tc.hits[k]++",
    "\t\t}(key)",
    "\t}",
    "\twg.Wait()",
    "}",
  ].join("\n"), "多个 goroutine 不加锁写同一个 map", ["并发", "竞态", "race", "锁", "Mutex", "同时"]),
  pit("svc/store.go", [
    "package svc",
    "",
    "import (",
    "\t\"database/sql\"",
    "\t\"fmt\"",
    ")",
    "",
    "type User struct {",
    "\tID   int64",
    "\tName string",
    "}",
    "",
    "func FindUser(db *sql.DB, name string) (*User, error) {",
    "\tquery := \"SELECT id, name FROM users WHERE name = '\" + name + \"'\"",
    "\trow := db.QueryRow(query)",
    "\tvar u User",
    "\tif err := row.Scan(&u.ID, &u.Name); err != nil {",
    "\t\treturn nil, fmt.Errorf(\"find user: %w\", err)",
    "\t}",
    "\treturn &u, nil",
    "}",
  ].join("\n"), "字符串拼接把用户输入拼进 SQL", ["拼接", "注入", "SQL 注入", "参数化", "占位符", "绑定"]),
  pit("svc/lock.go", [
    "package svc",
    "",
    "import (",
    "\t\"context\"",
    "\t\"time\"",
    ")",
    "",
    "type Locker interface {",
    "\tSetNX(ctx context.Context, key string, value any, ttl time.Duration) (bool, error)",
    "\tDel(ctx context.Context, keys ...string) error",
    "}",
    "",
    "func Acquire(ctx context.Context, r Locker, name, token string) (bool, error) {",
    "\treturn r.SetNX(ctx, \"lock:\"+name, token, 30*time.Second)",
    "}",
    "",
    "func Release(ctx context.Context, r Locker, name string) error {",
    "\treturn r.Del(ctx, \"lock:\"+name)",
    "}",
  ].join("\n"), "用 DEL 直接释放 Redis 分布式锁，不比对 token", ["token", "比对", "校验持有", "别人的锁", "他人", "Lua", "误删", "删除", "删掉", "持有者", "所有权"]),
];

const GO_SUPPORT = { "svc/go.mod": "module example.com/svc\n\ngo 1.22\n" };

test.skipIf(!config || process.platform !== "darwin")("P15：go-reviewer 把 Go 样例里埋的 5 个坑都列为阻塞并指到文件和行号", async () => {
  const evidence = await pointEvidence(config!, "p15");
  const result = await runSpecialistReview("go-worker", "go-reviewer", GO_PITS, { cleanups, config: config!, evidence, support: GO_SUPPORT });
  const verdict = specialistVerdict(result);
  const coverage = verdict ? pitCoverage(verdict, GO_PITS) : [];
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: result.turns(), reviewers: result.reviewerAgents, conclusion: verdict?.conclusion ?? null, summary: verdict?.summary ?? null,
    findings: verdict?.findings ?? [], coverage: coverage.map(({ pit, hit, refs }) => ({ path: pit.path, description: pit.description, hit, refs })),
    calls: result.real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(result.turns(), "真实模型没有被调用：go-reviewer 没有派出").toBeGreaterThan(0);
  expect(verdict, "go-reviewer 没有交出结论").toBeDefined();
  expect(verdict!.conclusion, JSON.stringify(verdict!.findings)).toBe("blocked");
  expect(coverage.filter((entry) => !entry.hit).map((entry) => `${entry.pit.path} ${entry.pit.description}`), "没有被阻塞意见指到的坑").toEqual([]);
}, POINT_TIMEOUT_MS);
