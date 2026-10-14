import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SETTINGS_ROLES, clearAgentSetting, projectSettingsPath, readAgentSettings, saveAgentSetting, userSettingsPath,
} from "../runtime/agent-settings.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function world() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const repositoryRoot = join(root, "repo");
  const user = userSettingsPath(agentDir);
  const project = projectSettingsPath(repositoryRoot);
  const write = async (path: string, content: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  };
  const read = (trusted: boolean) => readAgentSettings({ agentDir, repositoryRoot, projectTrusted: trusted });
  return { agentDir, repositoryRoot, user, project, write, read };
}

const DEFAULTS = {
  pm: { model: "gpt-6.1-sol", thinking: "high", source: "default" },
  interpreter: { model: "gpt-6-luna", thinking: "medium", source: "default" },
  "draft-verifier": { model: "gpt-6.1-sol", thinking: "medium", source: "default" },
};

describe("角色固定表", () => {
  test("三个角色按 key 和中文名列出", () => {
    expect(SETTINGS_ROLES.map((r) => [r.key, r.label])).toEqual([
      ["pm", "PM"], ["interpreter", "解释器"], ["draft-verifier", "草稿核验器"],
    ]);
  });
});

describe("读取设定", () => {
  test("两层都没有文件时三个角色都用内置默认值且没有问题", async () => {
    const w = await world();
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toEqual([]);
  });

  test("项目受信任时 pm 取项目层的值", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "5x/gpt-6-luna", thinking: "low" } } });
    await w.write(w.project, { "one-company": { pm: { model: "gpt-6.1-sol", thinking: "max" } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: "gpt-6.1-sol", thinking: "max", source: "project" });
    expect(problems).toEqual([]);
  });

  test("项目不受信任时 pm 取用户层的值", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "5x/gpt-6-luna", thinking: "low" } } });
    await w.write(w.project, { "one-company": { pm: { model: "gpt-6.1-sol", thinking: "max" } } });
    const { values } = await w.read(false);
    expect(values.pm).toEqual({ model: "5x/gpt-6-luna", thinking: "low", source: "user" });
  });

  test("项目不受信任时项目层里写错的内容也不产生问题", async () => {
    const w = await world();
    await w.write(w.project, "{ 坏");
    const { values, problems } = await w.read(false);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toEqual([]);
  });

  test("model 写成 null 时读出 null 表示跟随主会话", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { interpreter: { model: null, thinking: "off" } } });
    const { values } = await w.read(true);
    expect(values.interpreter).toEqual({ model: null, thinking: "off", source: "user" });
  });

  test("项目层思考等级写错时丢弃该项、取用户层并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "5x/gpt-6-luna", thinking: "low" } } });
    await w.write(w.project, { "one-company": { pm: { model: "gpt-6.1-sol", thinking: "super" } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: "5x/gpt-6-luna", thinking: "low", source: "user" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      path: w.project, role: "pm",
      display: "「PM」的思考等级写错了：super；只能是 off、minimal、low、medium、high、xhigh、max",
    });
  });

  test("文件不是合法 JSON 时这一层整层不生效并记问题", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.user, display: "文件不是合法的 JSON，这一层的设定都没有生效" });
  });

  test("one-company 是数组时这一层整层不生效并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": [] });
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.user, display: "one-company 要写成对象，这一层的设定都没有生效" });
  });

  test("不认识的角色被忽略并记问题，其余角色照常生效", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": {
      boss: { model: "x", thinking: "low" },
      pm: { model: "gpt-6-luna", thinking: "xhigh" },
    } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: "gpt-6-luna", thinking: "xhigh", source: "user" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      path: w.user,
      display: "不认识的角色 boss，只能是 pm、interpreter、draft-verifier",
    });
  });

  test("条目缺 thinking 时丢弃该项、取下一层并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { interpreter: { model: "gpt-6.1-sol" } } });
    const { values, problems } = await w.read(true);
    expect(values.interpreter).toEqual(DEFAULTS.interpreter);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      path: w.user, role: "interpreter",
      display: "「解释器」的设定要写成对象，同时包含 model 和 thinking",
    });
  });

  test("条目不是对象时丢弃该项并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "draft-verifier": "gpt-6.1-sol" } });
    const { values, problems } = await w.read(true);
    expect(values["draft-verifier"]).toEqual(DEFAULTS["draft-verifier"]);
    expect(problems[0]).toMatchObject({
      path: w.user, role: "draft-verifier",
      display: "「草稿核验器」的设定要写成对象，同时包含 model 和 thinking",
    });
  });

  test("模型写法含空格时丢弃该项、取下一层并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "a b", thinking: "low" } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual(DEFAULTS.pm);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      path: w.user, role: "pm",
      display: "「PM」的模型写法不对：a b；要写成模型名、提供方/模型名，或 null（跟随主会话）",
    });
  });
});

describe("写入设定", () => {
  test("保存 pm 后其他字段和其他角色原样保留，并用两个空格缩进", async () => {
    const w = await world();
    const original = {
      theme: "dark", packages: ["x"],
      "one-company": { interpreter: { model: null, thinking: "off" } },
    };
    await w.write(w.user, original);
    await saveAgentSetting({ path: w.user, role: "pm", model: "5x/gpt-6-luna", thinking: "xhigh" });
    const text = await readFile(w.user, "utf8");
    const expected = { ...original, "one-company": { ...original["one-company"], pm: { model: "5x/gpt-6-luna", thinking: "xhigh" } } };
    expect(JSON.parse(text)).toEqual(expected);
    expect(text.trimEnd()).toBe(JSON.stringify(expected, null, 2));
  });

  test("保存 model 为 null 后再读出来仍是 null", async () => {
    const w = await world();
    await saveAgentSetting({ path: w.user, role: "pm", model: null, thinking: "off" });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: null, thinking: "off", source: "user" });
    expect(problems).toEqual([]);
  });

  test("清除唯一的 pm 条目后文件里不再有 one-company，其余字段不变", async () => {
    const w = await world();
    await w.write(w.user, { theme: "dark", packages: ["x"], "one-company": { pm: { model: "gpt-6-luna", thinking: "low" } } });
    await clearAgentSetting({ path: w.user, role: "pm" });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ theme: "dark", packages: ["x"] });
  });

  test("清除 pm 时保留其他角色", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": {
      pm: { model: "gpt-6-luna", thinking: "low" },
      interpreter: { model: null, thinking: "off" },
    } });
    await clearAgentSetting({ path: w.user, role: "pm" });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({
      "one-company": { interpreter: { model: null, thinking: "off" } },
    });
  });

  test("文件不是合法 JSON 时保存报错且文件内容不变", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    await expect(saveAgentSetting({ path: w.user, role: "pm", model: null, thinking: "off" })).rejects.toThrow();
    expect(await readFile(w.user, "utf8")).toBe("{ 坏");
  });

  test("文件不是合法 JSON 时清除报错且文件内容不变", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    await expect(clearAgentSetting({ path: w.user, role: "pm" })).rejects.toThrow();
    expect(await readFile(w.user, "utf8")).toBe("{ 坏");
  });

  test("保存到不存在的文件时自动建目录和文件", async () => {
    const w = await world();
    expect(existsSync(dirname(w.project))).toBe(false);
    await saveAgentSetting({ path: w.project, role: "draft-verifier", model: "gpt-6.1-sol", thinking: "high" });
    expect(JSON.parse(await readFile(w.project, "utf8"))).toEqual({
      "one-company": { "draft-verifier": { model: "gpt-6.1-sol", thinking: "high" } },
    });
  });
});

describe("读写异常文件时和 pi 一致", () => {
  test("设置文件的路径是目录时，读取记一条文件读不了的问题，保存报错", async () => {
    const w = await world();
    await mkdir(w.user, { recursive: true });
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe(w.user);
    expect(problems[0]!.display).toMatch(/^文件读不了（.+），这一层的设定都没有生效$/);
    expect(problems[0]!.display).not.toContain("JSON");
    await expect(saveAgentSetting({ path: w.user, role: "pm", model: null, thinking: "off" })).rejects.toThrow(/^设置文件读不了（.+），没有改动：/);
  });

  test("文件开头带 BOM 时照常读取和保存", async () => {
    const w = await world();
    await w.write(w.user, `﻿${JSON.stringify({ theme: "dark", "one-company": { pm: { model: "gpt-6-luna", thinking: "low" } } })}`);
    const { values, problems } = await w.read(true);
    expect(problems).toEqual([]);
    expect(values.pm).toEqual({ model: "gpt-6-luna", thinking: "low", source: "user" });
    await saveAgentSetting({ path: w.user, role: "interpreter", model: null, thinking: "off" });
    expect(JSON.parse((await readFile(w.user, "utf8")).replace(/^﻿/, ""))).toEqual({ theme: "dark",
      "one-company": { pm: { model: "gpt-6-luna", thinking: "low" }, interpreter: { model: null, thinking: "off" } } });
  });

  test("空文件当作没有设定，读取不记问题，保存后只有这一项", async () => {
    const w = await world();
    await w.write(w.user, "");
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toEqual([]);
    await saveAgentSetting({ path: w.user, role: "pm", model: "gpt-6-luna", thinking: "high" });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ "one-company": { pm: { model: "gpt-6-luna", thinking: "high" } } });
  });

  test("文件顶层不是对象时读取记问题，这一层不生效", async () => {
    const w = await world();
    await w.write(w.user, "[]");
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toEqual([expect.objectContaining({ path: w.user, display: "文件内容要写成 JSON 对象，这一层的设定都没有生效" })]);
  });

  test("用户层文件坏了、项目层正常时取项目层的值，并给出两层各自的有效条目", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    await w.write(w.project, { "one-company": { pm: { model: "gpt-6.1-sol", thinking: "max" } } });
    const { values, layers } = await w.read(true);
    expect(values.pm).toEqual({ model: "gpt-6.1-sol", thinking: "max", source: "project" });
    expect(layers).toEqual({ user: {}, project: { pm: { model: "gpt-6.1-sol", thinking: "max" } } });
  });

  test("清除一个本来没写的角色时不改动文件", async () => {
    const w = await world();
    const original = JSON.stringify({ "one-company": { pm: { model: "gpt-6-luna", thinking: "low" } } });
    await w.write(w.user, original);
    await clearAgentSetting({ path: w.user, role: "interpreter" });
    expect(await readFile(w.user, "utf8")).toBe(original);
  });

  test("模型写成对象时，问题里按 JSON 原样显示", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: { a: 1 }, thinking: "low" } } });
    const { problems } = await w.read(true);
    expect(problems[0]!.display).toBe("「PM」的模型写法不对：{\"a\":1}；要写成模型名、提供方/模型名，或 null（跟随主会话）");
  });
});
