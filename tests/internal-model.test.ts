import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveInternalModel } from "../src/modules/settings/internal-model.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const model = (provider: string, id: string) => ({ provider, id, api: "openai-responses" }) as unknown as Model<Api>;
const MAIN = model("5x", "gpt-6-sol"), SOL = model("5x", "gpt-6.1-sol"), LUNA = model("5x", "gpt-6-luna"), NOAUTH = model("other", "fast");
const registry = { getAll: () => [MAIN, SOL, LUNA, NOAUTH],
  hasConfiguredAuth: (m: Model<Api>) => m !== NOAUTH };
type Role = "interpreter" | "draft-verifier";
type Setting = { model: string | null; thinking: string | null };

async function world() {
  const root = await mkdtemp(join(tmpdir(), "internal-model-")); roots.push(root);
  const agentDir = join(root, "agent"), repo = join(root, "repo");
  const write = async (path: string, settings: Partial<Record<Role, Setting>>) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ "one-company": settings }));
  };
  const resolve = (role: Role, options: { projectTrusted?: boolean; mainThinking?: string; mainModel?: Model<Api> | undefined } = {}) =>
    resolveInternalModel({ role, agentDir, repositoryRoot: repo, projectTrusted: options.projectTrusted ?? false, registry,
      mainModel: "mainModel" in options ? options.mainModel : MAIN, mainThinking: options.mainThinking ?? "off" });
  return { agentDir, repo, user: (settings: Partial<Record<Role, Setting>>) => write(join(agentDir, "settings.json"), settings),
    project: (settings: Partial<Record<Role, Setting>>) => write(join(repo, ".pi", "settings.json"), settings), resolve };
}

test.each<Role>(["interpreter", "draft-verifier"])("两层都没有设定时%s用主窗口当前的模型和思考等级", async (role) => {
  const w = await world();
  expect(await w.resolve(role, { mainThinking: "high" })).toEqual({ model: MAIN, thinking: "high" });
});

test.each<Role>(["interpreter", "draft-verifier"])("主窗口思考等级为 off 时%s不思考", async (role) => {
  const w = await world();
  expect(await w.resolve(role, { mainThinking: "off" })).toEqual({ model: MAIN, thinking: undefined });
});

test("用户层的设定生效，只影响对应的那一个角色；思考等级写 null 时跟主窗口", async () => {
  const w = await world();
  await w.user({ interpreter: { model: "5x/gpt-6.1-sol", thinking: null } });
  expect(await w.resolve("interpreter", { mainThinking: "high" })).toEqual({ model: SOL, thinking: "high" });
  expect(await w.resolve("draft-verifier", { mainThinking: "high" })).toEqual({ model: MAIN, thinking: "high" });
});

test("设定里写明思考等级时用设定值，写 off 时不思考，模型写 null 时跟主窗口", async () => {
  const w = await world();
  await w.user({ interpreter: { model: null, thinking: "low" }, "draft-verifier": { model: null, thinking: "off" } });
  expect(await w.resolve("interpreter", { mainThinking: "high" })).toEqual({ model: MAIN, thinking: "low" });
  expect(await w.resolve("draft-verifier", { mainThinking: "high" })).toEqual({ model: MAIN, thinking: undefined });
});

test("项目层设定只在项目受信任时压过用户层", async () => {
  const w = await world();
  await w.user({ interpreter: { model: "5x/gpt-6-luna", thinking: null } });
  await w.project({ interpreter: { model: "5x/gpt-6.1-sol", thinking: null } });
  expect((await w.resolve("interpreter", { projectTrusted: false })).model).toBe(LUNA);
  expect((await w.resolve("interpreter", { projectTrusted: true })).model).toBe(SOL);
});

test("每次调用都重新读设定，改了设定下一次调用用新值", async () => {
  const w = await world();
  await w.user({ interpreter: { model: "5x/gpt-6-luna", thinking: null } });
  expect((await w.resolve("interpreter")).model).toBe(LUNA);
  await w.user({ interpreter: { model: "5x/gpt-6.1-sol", thinking: null } });
  expect((await w.resolve("interpreter")).model).toBe(SOL);
});

test("设定的模型找不到或没有凭据时，原因写明角色、模型和为什么，不改用主窗口的模型", async () => {
  const w = await world();
  await w.user({ interpreter: { model: "5x/not-there", thinking: null }, "draft-verifier": { model: "other/fast", thinking: null } });
  await expect(w.resolve("interpreter")).rejects.toMatchObject({ code: "internal_model_unavailable",
    message: expect.stringContaining("解释器") });
  await expect(w.resolve("interpreter")).rejects.toMatchObject({ message: expect.stringContaining("5x/not-there") });
  await expect(w.resolve("interpreter")).rejects.toMatchObject({ message: expect.stringContaining("本机的模型配置里找不到模型 5x/not-there") });
  await expect(w.resolve("draft-verifier")).rejects.toMatchObject({ code: "internal_model_unavailable",
    message: expect.stringContaining("草稿核验器") });
  await expect(w.resolve("draft-verifier")).rejects.toMatchObject({ message: expect.stringContaining("other/fast") });
  await expect(w.resolve("draft-verifier")).rejects.toMatchObject({ message: expect.stringContaining("没有可用的凭据") });
});

test("模型不可用的建议指向 /one:setting 的「模型」，并禁止自行改用别的模型", async () => {
  const w = await world();
  await w.user({ interpreter: { model: "5x/not-there", thinking: null } });
  await expect(w.resolve("interpreter")).rejects.toMatchObject({ advice: { next:
    "请用户在 /one:setting 的「模型」里检查这个角色的模型，或在主窗口选定模型、在本机配置该模型的凭据；不要自行改用别的模型重试" } });
});

test.each<[Role, string]>([["interpreter", "解释器"], ["draft-verifier", "草稿核验器"]])("设定跟随主窗口的模型但主窗口没有选定模型时，%s报错写明原因", async (role, label) => {
  const w = await world();
  await expect(w.resolve(role, { mainModel: undefined })).rejects.toMatchObject({ code: "internal_model_unavailable",
    message: expect.stringContaining(`${label}跟随主窗口的模型，但主窗口没有选定模型`) });
});

test.each<Role>(["interpreter", "draft-verifier"])("用户层旧的%s定义文件不再生效", async (role) => {
  const w = await world();
  await mkdir(join(w.agentDir, "agents"), { recursive: true });
  await writeFile(join(w.agentDir, "agents", `${role}.md`), `---\nname: ${role}\ndescription: d\nrole: ${role}\nmodel: 5x/gpt-6-luna\nthinking: low\n---\n`);
  expect(await w.resolve(role, { mainThinking: "high" })).toEqual({ model: MAIN, thinking: "high" });
});
