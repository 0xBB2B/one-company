import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveInternalModel } from "../runtime/internal-model.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model = (provider: string, id: string) => ({ provider, id, api: "openai-responses" }) as unknown as Model<Api>;
const MAIN = model("5x", "gpt-6-sol"), LUNA = model("5x", "gpt-6-luna"), NOAUTH = model("other", "fast");
const registry = { find: (provider: string, id: string) => [MAIN, LUNA, NOAUTH].find((m) => m.provider === provider && m.id === id),
  hasConfiguredAuth: (m: Model<Api>) => m !== NOAUTH };

async function world() {
  const root = await mkdtemp(join(tmpdir(), "internal-model-")); roots.push(root);
  const agentDir = join(root, "agent"), repo = join(root, "repo");
  const define = async (dir: string, role: string, extra: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${role}.md`), `---\nname: ${role}\ndescription: d\nrole: ${role}\n${extra}\n---\n正文不生效\n`);
  };
  const resolve = (role: "interpreter" | "draft-verifier", projectTrusted = false) =>
    resolveInternalModel({ role, agentDir, repositoryRoot: repo, projectTrusted, registry, mainModel: MAIN });
  return { user: join(agentDir, "agents"), project: join(repo, ".pi", "agents"), define, resolve };
}

test("M8D-AC8：没有自定义时解释器与草稿核验器沿用主会话模型、不思考", async () => {
  const w = await world();
  for (const role of ["interpreter", "draft-verifier"] as const) expect(await w.resolve(role)).toEqual({ model: MAIN, thinking: undefined });
});

test("M8D-AC8：用户层同名定义改的模型与思考等级生效，只影响对应的那一个", async () => {
  const w = await world();
  await w.define(w.user, "interpreter", "model: 5x/gpt-6-luna\nthinking: low");
  expect(await w.resolve("interpreter")).toEqual({ model: LUNA, thinking: "low" });
  expect(await w.resolve("draft-verifier")).toEqual({ model: MAIN, thinking: undefined });
  await w.define(w.user, "draft-verifier", "thinking: off");
  expect(await w.resolve("draft-verifier")).toEqual({ model: MAIN, thinking: undefined });
});

test("M8D-AC8：项目层定义只在项目受信任时生效", async () => {
  const w = await world();
  await w.define(w.project, "interpreter", "model: 5x/gpt-6-luna");
  expect((await w.resolve("interpreter", false)).model).toBe(MAIN);
  expect((await w.resolve("interpreter", true)).model).toBe(LUNA);
});

test("M8D-AC8：配置的模型找不到或没有凭据时写明原因，不改用主会话模型", async () => {
  const w = await world();
  await w.define(w.user, "interpreter", "model: 5x/not-there");
  await expect(w.resolve("interpreter")).rejects.toMatchObject({ code: "internal_model_unavailable",
    message: expect.stringContaining("解释器配置的模型 5x/not-there 在本机的模型配置里找不到") });
  await w.define(w.user, "draft-verifier", "model: other/fast");
  await expect(w.resolve("draft-verifier")).rejects.toMatchObject({ code: "internal_model_unavailable",
    message: expect.stringContaining("草稿核验器配置的模型 other/fast 没有可用的凭据") });
});

test("M8D-AC8：没有自定义且主会话也没选模型时写明原因", async () => {
  const w = await world();
  await expect(resolveInternalModel({ role: "interpreter", agentDir: "/nonexistent", repositoryRoot: "/nonexistent", projectTrusted: false, registry, mainModel: undefined }))
    .rejects.toMatchObject({ code: "model_unavailable" });
});
