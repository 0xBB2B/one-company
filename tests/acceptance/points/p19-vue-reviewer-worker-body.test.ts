import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { copyExampleFiles, examplesDir, inspectExample, layerTargets } from "../../../src/modules/settings/spec-examples.ts";
import { temporaryRoot } from "../../helpers/temporary-root.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { pointEvidence } from "../helpers/point-pm.ts";
import { fileOf, pitCoverage, POINT_TIMEOUT_MS, runSpecialistReview, pit, sameFile, specialistVerdict } from "../helpers/point-review.ts";
import type { SeededPit } from "../helpers/point-review.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const TOKEN_STORE_PATH = "web/src/auth/token-store.ts";
const TOKEN_STORE = [
  "const REFRESH_KEY = 'refresh_token'",
  "",
  "export function saveRefreshToken(token: string) {",
  "  localStorage.setItem(REFRESH_KEY, token)",
  "}",
  "",
  "export function loadRefreshToken(): string | null {",
  "  return localStorage.getItem(REFRESH_KEY)",
  "}",
  "",
].join("\n");

const SESSION = [
  "let accessToken: string | null = null",
  "",
  "export function setAccessToken(token: string | null) {",
  "  accessToken = token",
  "}",
  "",
  "export function getAccessToken() {",
  "  return accessToken",
  "}",
  "",
].join("\n");
const SUPPORT = { "web/src/auth/session.ts": SESSION };

const PITS: SeededPit[] = [
  pit("web/src/auth/refresh.ts", [
    "import { loadRefreshToken } from './token-store'",
    "import { setAccessToken } from './session'",
    "",
    "export async function refreshAccessToken() {",
    "  const refreshToken = loadRefreshToken()",
    "  const response = await fetch(`/api/auth/refresh?refresh_token=${refreshToken}`, { method: 'POST' })",
    "  const body = await response.json()",
    "  setAccessToken(body.accessToken)",
    "}",
  ].join("\n"), "刷新 token 的请求把 refresh token 拼进 URL 查询参数", ["URL", "查询参数", "query", "日志", "Referer", "地址栏"]),
  pit("web/src/components/Comment.vue", [
    "<script setup lang=\"ts\">",
    "defineProps<{ author: string; content: string }>()",
    "</script>",
    "",
    "<template>",
    "  <article class=\"comment\">",
    "    <h4>{{ author }}</h4>",
    "    <div class=\"body\" v-html=\"content\"></div>",
    "  </article>",
    "</template>",
  ].join("\n"), "用 v-html 渲染用户评论", ["v-html", "XSS", "转义", "净化"]),
];

test.skipIf(!config || process.platform !== "darwin")("P19：只有 vue-worker 正文写明 auth-session 第 15 条不适用时，vue-reviewer 不为 localStorage 存 refresh token 阻塞，其余坑照常指到", async () => {
  const agentDir = await mkdtemp(join(temporaryRoot(), "agent-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  const targets = layerTargets("user", { agentDir, repoRoot: agentDir });
  const inspection = await inspectExample({ examplesDir: examplesDir(), example: "vue", targets });
  await copyExampleFiles({ examplesDir: examplesDir(), example: "vue", targets, inspection });
  const reviewerPath = join(targets.agentsDir, "vue-reviewer.md");
  const reviewerLines = (await readFile(reviewerPath, "utf8")).split("\n");
  const keptLines = reviewerLines.filter((line) => !line.startsWith("- auth-session 第 15 条"));
  expect(reviewerLines.length - keptLines.length, "只有 vue-worker 定义正文写明不适用：vue-reviewer 正文里应恰好删掉 1 行").toBe(1);
  await writeFile(reviewerPath, keptLines.join("\n"));
  const definitionBody = (text: string) => text.split(/^---$/m).slice(2).join("---");
  const reviewerText = await readFile(reviewerPath, "utf8");
  expect(definitionBody(reviewerText), "只有 vue-worker 定义正文写明不适用：vue-reviewer 正文仍含 auth-session").not.toContain("auth-session");
  expect(reviewerText.split("\n").find((line) => line.startsWith("skills:")), "vue-reviewer 的 skills 行应仍含 auth-session").toContain("auth-session");
  expect(definitionBody(await readFile(join(targets.agentsDir, "vue-worker.md"), "utf8")), "只有 vue-worker 定义正文写明不适用：vue-worker 正文应含 auth-session 第 15 条").toContain("auth-session 第 15 条");

  const evidence = await pointEvidence(config!, "p19");
  const result = await runSpecialistReview("vue-worker", "vue-reviewer", PITS, {
    cleanups, config: config!, evidence, support: { ...SUPPORT, [TOKEN_STORE_PATH]: TOKEN_STORE },
    userDir: targets.agentsDir, skillDirs: [targets.skillsDir],
  });
  const verdict = specialistVerdict(result);
  const coverage = verdict ? pitCoverage(verdict, PITS) : [];
  const tokenStoreRefs = (verdict?.findings ?? []).filter((finding) => finding.kind === "blocking")
    .filter((finding) => {
      const file = fileOf(finding.targetRef), text = `${finding.trigger}\n${finding.impact}`.toLowerCase();
      const seeded = PITS.some((entry) => sameFile(file, entry.path) && entry.keywords.some((word) => text.includes(word.toLowerCase())));
      return sameFile(file, TOKEN_STORE_PATH) || (!seeded && /localstorage|sessionstorage/u.test(text) && /xss|脚本|httponly/u.test(text));
    })
    .map((finding) => finding.targetRef);
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: result.turns(), reviewers: result.reviewerAgents, conclusion: verdict?.conclusion ?? null, summary: verdict?.summary ?? null,
    findings: verdict?.findings ?? [], coverage: coverage.map(({ pit, hit, refs }) => ({ path: pit.path, description: pit.description, hit, refs })),
    localStorageFilePointedAt: tokenStoreRefs.length > 0, localStorageFileRefs: tokenStoreRefs,
    calls: result.real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(result.turns(), "真实模型没有被调用：vue-reviewer 没有派出").toBeGreaterThan(0);
  expect(verdict, "vue-reviewer 没有交出结论").toBeDefined();
  expect(verdict!.conclusion, JSON.stringify(verdict!.findings)).toBe("blocked");
  expect(coverage.filter((entry) => !entry.hit).map((entry) => `${entry.pit.path} ${entry.pit.description}`), "没有被阻塞意见指到的坑").toEqual([]);
  expect(tokenStoreRefs, "只有 vue-worker 定义正文写明不适用的 localStorage 存 refresh token 被阻塞意见指到").toEqual([]);
}, POINT_TIMEOUT_MS);
