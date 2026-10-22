import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { pointEvidence } from "../helpers/point-pm.ts";
import { pitCoverage, POINT_TIMEOUT_MS, runSpecialistReview, seed, span, specialistVerdict } from "../helpers/point-review.ts";
import type { SeededPit } from "../helpers/point-review.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const ADMIN_API = [
  "import { Router } from 'express'",
  "import { listUsers } from './users'",
  "",
  "export const adminRouter = Router()",
  "",
  "adminRouter.get('/users', async (_req, res) => {",
  "  res.json(await listUsers())",
  "})",
  "",
].join("\n");
const APP = [
  "import express from 'express'",
  "import { adminRouter } from './admin-api'",
  "import { sessionFromCookie } from './session'",
  "",
  "const app = express()",
  "",
  "app.use('/api', async (req, res, next) => {",
  "  const session = await sessionFromCookie(req.headers.cookie)",
  "  if (!session) return res.status(401).json({ message: '请先登录' })",
  "  req.session = session",
  "  next()",
  "})",
  "",
  "app.use('/api/admin', adminRouter)",
  "",
  "app.listen(3000)",
  "",
].join("\n");
const VUE_SUPPORT = { "web/server/admin-api.ts": ADMIN_API, "web/server/app.ts": APP };

const VUE_PITS: SeededPit[] = [
  seed("web/src/components/Comment.vue", [
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
  ].join("\n"), "v-html", "v-html", "用 v-html 渲染用户评论"),
  seed("web/src/components/Profile.vue", [
    "<script setup lang=\"ts\">",
    "defineProps<{ name: string; homepage: string }>()",
    "</script>",
    "",
    "<template>",
    "  <section class=\"profile\">",
    "    <h3>{{ name }}</h3>",
    "    <a :href=\"homepage\">个人主页</a>",
    "  </section>",
    "</template>",
  ].join("\n"), ":href", ":href", ":href 直接绑定用户填的链接"),
  seed("web/src/components/ResizeWatcher.vue", [
    "<script setup lang=\"ts\">",
    "import { onMounted, onUnmounted, ref } from 'vue'",
    "",
    "const width = ref(window.innerWidth)",
    "",
    "function update() {",
    "  width.value = window.innerWidth",
    "}",
    "",
    "onMounted(() => {",
    "  window.addEventListener('resize', update)",
    "})",
    "",
    "onUnmounted(() => {",
    "  width.value = 0",
    "})",
    "</script>",
    "",
    "<template>",
    "  <p>窗口宽度 {{ width }}</p>",
    "</template>",
  ].join("\n"), "onMounted(() =>", "  width.value = 0", "onMounted 里 addEventListener，onUnmounted 没移除"),
  seed("web/src/components/Counter.vue", [
    "<script setup lang=\"ts\">",
    "import { reactive } from 'vue'",
    "",
    "const state = reactive({ count: 0, step: 1 })",
    "const { count, step } = state",
    "",
    "function add() {",
    "  state.count += state.step",
    "}",
    "</script>",
    "",
    "<template>",
    "  <button @click=\"add\">{{ count }} (+{{ step }})</button>",
    "</template>",
  ].join("\n"), "const { count, step }", "<button", "解构 reactive() 的返回值后在模板里使用"),
  seed("web/src/router/index.ts", [
    "import { createRouter, createWebHistory } from 'vue-router'",
    "import { useUserStore } from '../stores/user'",
    "import Home from '../views/Home.vue'",
    "import AdminPanel from '../views/AdminPanel.vue'",
    "",
    "const router = createRouter({",
    "  history: createWebHistory(),",
    "  routes: [",
    "    { path: '/', component: Home },",
    "    { path: '/admin', component: AdminPanel, meta: { requiresAdmin: true } },",
    "  ],",
    "})",
    "",
    "router.beforeEach((to) => {",
    "  const user = useUserStore()",
    "  if (to.meta.requiresAdmin && user.role !== 'admin') {",
    "    return '/'",
    "  }",
    "})",
    "",
    "export default router",
  ].join("\n"), "router.beforeEach", "  }", "路由守卫按用户角色放行管理页，后端接口不校验权限",
    [span("web/server/admin-api.ts", ADMIN_API, "adminRouter.get", "})"), span("web/server/app.ts", APP, "app.use('/api/admin'", "app.use('/api/admin'")]),
];

test.skipIf(!config || process.platform !== "darwin")("P16：vue-reviewer 把 Vue 样例里埋的 5 个坑都列为阻塞并指到文件和行号", async () => {
  const evidence = await pointEvidence(config!, "p16");
  const result = await runSpecialistReview("vue-worker", "vue-reviewer", VUE_PITS, { cleanups, config: config!, evidence, support: VUE_SUPPORT });
  const verdict = specialistVerdict(result);
  const coverage = verdict ? pitCoverage(verdict, VUE_PITS) : [];
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: result.turns(), reviewers: result.reviewerAgents, conclusion: verdict?.conclusion ?? null, summary: verdict?.summary ?? null,
    findings: verdict?.findings ?? [], coverage: coverage.map(({ pit, hit, refs }) => ({ path: pit.path, lines: [pit.startLine, pit.endLine], description: pit.description, hit, refs })),
    calls: result.real.toolCalls().map((block) => ({ name: block.name, arguments: block.arguments })) }, null, 2)}\n`, { mode: 0o600 });
  expect(result.turns(), "真实模型没有被调用：vue-reviewer 没有派出").toBeGreaterThan(0);
  expect(verdict, "vue-reviewer 没有交出结论").toBeDefined();
  expect(verdict!.conclusion, JSON.stringify(verdict!.findings)).toBe("blocked");
  expect(coverage.filter((entry) => !entry.hit).map((entry) => `${entry.pit.path}:${entry.pit.startLine}-${entry.pit.endLine} ${entry.pit.description}`), "没有被阻塞意见指到的坑").toEqual([]);
}, POINT_TIMEOUT_MS);
