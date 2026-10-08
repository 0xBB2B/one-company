import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { resolveAgent } from "../runtime/agent-resolve.ts";
import { resolveInternalModel } from "../runtime/internal-model.ts";
import { findDefinedModel } from "../runtime/model-ref.ts";
import { loadRoleCatalog } from "../runtime/roles.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model = (provider: string, id: string) => ({ provider, id, api: "openai-responses", reasoning: true }) as unknown as Model<Api>;
const A_SOL = model("a", "sol"), B_SOL = model("b", "sol"), A_LUNA = model("a", "luna"), B_ONLY = model("b", "only"), SLASHED = model("a", "kimi/k3");
const ALL = [A_SOL, B_SOL, A_LUNA, B_ONLY, SLASHED];

test("M8F-AC1：只写模型名时优先主会话的提供方，否则要本机唯一；多个时列出候选，没有时报找不到；提供方/模型名照常解析", () => {
  expect(findDefinedModel("sol", ALL, "b")).toEqual({ ok: true, model: B_SOL });
  expect(findDefinedModel("only", ALL, "a")).toEqual({ ok: true, model: B_ONLY });
  expect(findDefinedModel("sol", ALL, "c")).toEqual({ ok: false, reason: "本机有多个提供方都有模型 sol（a/sol、b/sol），请把 model 改写成 提供方/模型名" });
  expect(findDefinedModel("sol", ALL, undefined)).toMatchObject({ ok: false });
  expect(findDefinedModel("none", ALL, "a")).toEqual({ ok: false, reason: "本机的模型配置里找不到模型 none" });
  expect(findDefinedModel("a/sol", ALL, "b")).toEqual({ ok: true, model: A_SOL });
  expect(findDefinedModel("a/kimi/k3", ALL, "b")).toEqual({ ok: true, model: SLASHED });
  expect(findDefinedModel("c/sol", ALL, "a")).toEqual({ ok: false, reason: "本机的模型配置里找不到模型 c/sol" });
});

async function roleDir(frontmatter: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "model-ref-")); roots.push(root);
  const agentDir = join(root, "agent"), dir = join(agentDir, "agents");
  await mkdir(dir, { recursive: true });
  for (const [name, extra] of Object.entries(frontmatter)) await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\n${extra}\n---\n正文\n`);
  return { root, agentDir, dir };
}

test("M8F-AC1：派子代理时只写模型名的定义按派出方的提供方找模型，多个提供方同名且派出方没有时拒绝", async () => {
  const { dir, root } = await roleDir({ w: "role: worker\nmodel: sol", only: "role: worker\nmodel: only", gone: "role: worker\nmodel: none", plain: "role: worker" });
  const catalog = (await loadRoleCatalog({ defaultDir: dir, userDir: join(root, "none"), projectDir: join(root, "none2"), parseFrontmatter, projectTrusted: false })).roles;
  const resolve = (name: string, provider: string) => resolveAgent({ catalog, name, role: "worker", skillDirs: [], hasAuth: () => true,
    models: (wanted) => ALL.filter((entry) => wanted === undefined || entry.provider === wanted), fallback: { model: { provider, id: "luna" }, thinking: "off" } });
  expect((await resolve("w", "b")).model).toEqual({ provider: "b", id: "sol" });
  expect((await resolve("only", "a")).model).toEqual({ provider: "b", id: "only" });
  expect((await resolve("plain", "a")).model).toEqual({ provider: "a", id: "luna" });
  await expect(resolve("w", "c")).rejects.toMatchObject({ code: "model_unavailable", message: expect.stringContaining("a/sol、b/sol") });
  await expect(resolve("gone", "a")).rejects.toMatchObject({ code: "model_unavailable", message: expect.stringContaining("找不到模型 none") });
});

test("M8F-AC1：内部调用只写模型名的定义按主会话的提供方找模型，多个提供方同名且主会话没有时拒绝并列出候选", async () => {
  const { agentDir, root } = await roleDir({ interpreter: "role: interpreter\nmodel: sol\nthinking: medium", "draft-verifier": "role: draft-verifier\nmodel: none" });
  const registry = { hasConfiguredAuth: () => true, getAll: () => ALL };
  const resolve = (role: "interpreter" | "draft-verifier", mainModel: Model<Api>) => resolveInternalModel({ role, agentDir, repositoryRoot: join(root, "repo"), projectTrusted: false, registry, mainModel });
  expect(await resolve("interpreter", B_ONLY)).toEqual({ model: B_SOL, thinking: "medium" });
  await expect(resolve("interpreter", model("c", "x"))).rejects.toMatchObject({ code: "internal_model_unavailable", message: expect.stringContaining("a/sol、b/sol") });
  await expect(resolve("draft-verifier", A_SOL)).rejects.toMatchObject({ code: "internal_model_unavailable", message: expect.stringContaining("草稿核验器配置的模型 none 不可用：本机的模型配置里找不到模型 none") });
});
