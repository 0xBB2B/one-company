import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SETTINGS_ROLES, clearAgentSetting, clearGitDeliverySetting, clearMergeMethodsSetting, projectSettingsPath, readAgentSettings, saveAgentSetting, saveGitDeliverySetting, saveMergeMethodsSetting, userSettingsPath,
} from "../src/modules/settings/agent-settings.ts";
import * as settings from "../src/modules/settings/agent-settings.ts";
import { initRepoWithOrigin, installFakeGh } from "./helpers/fake-gh.ts";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
let gh: Awaited<ReturnType<typeof installFakeGh>>;
beforeEach(async () => { gh = await installFakeGh(); });
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); await gh.restore(); });

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
  pm: { model: null, thinking: null, source: "default" },
  interpreter: { model: null, thinking: null, source: "default" },
  "draft-verifier": { model: null, thinking: null, source: "default" },
};

describe("角色固定表", () => {
  test("三个角色按 key 和中文名列出", () => {
    expect(SETTINGS_ROLES.map((r) => [r.key, r.label])).toEqual([
      ["pm", "PM"], ["interpreter", "解释器"], ["draft-verifier", "草稿核验器"],
    ]);
  });

  test("三个角色的内置默认模型和思考等级都是 null，表示跟随主会话", () => {
    expect(SETTINGS_ROLES.map((r) => [r.key, r.model, r.thinking])).toEqual([
      ["pm", null, null], ["interpreter", null, null], ["draft-verifier", null, null],
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

  test("项目层 pm 写成跟随时整条覆盖用户层，不按字段落到下一层", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "gpt-6-luna", thinking: "low" } } });
    await w.write(w.project, { "one-company": { pm: { model: null, thinking: null } } });
    const { values } = await w.read(true);
    expect(values.pm).toEqual({ model: null, thinking: null, source: "project" });
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
      display: "「PM」的思考等级写错了：super；只能是 off、minimal、low、medium、high、xhigh、max，或 null（跟随主会话）",
    });
  });

  test("thinking 写成 null 时读出 null 表示跟随主会话，且不记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "gpt-6-luna", thinking: null }, interpreter: { model: null, thinking: null } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: "gpt-6-luna", thinking: null, source: "user" });
    expect(values.interpreter).toEqual({ model: null, thinking: null, source: "user" });
    expect(problems).toEqual([]);
  });

  test("thinking 写成数字时丢弃该项并记问题，原值按 JSON 显示", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: "gpt-6-luna", thinking: 5 } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual(DEFAULTS.pm);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.display).toBe("「PM」的思考等级写错了：5；只能是 off、minimal、low、medium、high、xhigh、max，或 null（跟随主会话）");
  });

  test("条目缺 thinking 字段时仍记问题，thinking 为 null 不等于没写", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { pm: { model: null } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual(DEFAULTS.pm);
    expect(problems).toHaveLength(1);
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

  test("不认识的设定被忽略并记问题，其余角色照常生效", async () => {
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
      display: "不认识的设定 boss，只能是 pm、interpreter、draft-verifier、git-delivery、merge-methods、disabled-agents",
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

  test("保存 thinking 为 null 后文件里是 null，再读出来仍是 null", async () => {
    const w = await world();
    await saveAgentSetting({ path: w.user, role: "interpreter", model: "gpt-6-luna", thinking: null });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ "one-company": { interpreter: { model: "gpt-6-luna", thinking: null } } });
    const { values, problems } = await w.read(true);
    expect(values.interpreter).toEqual({ model: "gpt-6-luna", thinking: null, source: "user" });
    expect(problems).toEqual([]);
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

const ALL_METHODS = ["squash", "merge", "rebase"];
const ONE_COMPANY_KEYS = "pm、interpreter、draft-verifier、git-delivery、merge-methods、disabled-agents";

describe("读取 git-delivery", () => {
  test("两层都没写且 origin 主机 gh 登录过：生效 remote，来源默认，带探测结果", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, "git@github.com:acme/shop.git");
    gh.ghLoggedIn(["github.com"]);
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "remote", source: "default", detected: { host: "github.com", provider: "gh" } });
  });

  test("两层都没写且只有 glab 登录过 origin 主机：生效 remote，探测工具是 glab", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, "https://code.example.com/acme/shop.git");
    await gh.glabLoggedIn(["code.example.com"]);
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "remote", source: "default", detected: { host: "code.example.com", provider: "glab" } });
  });

  test("两层都没写且 gh 和 glab 都没登录 origin 主机：生效 local，探测结果带主机", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, "https://git.example.com/acme/shop.git");
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "local", source: "default", detected: { host: "git.example.com", provider: null } });
  });

  test("两层都没写且没有 origin：生效 local，主机为 null", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, null);
    gh.ghLoggedIn(["github.com"]);
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "local", source: "default", detected: { host: null, provider: null } });
  });

  test("项目层写 local 且受信任时覆盖用户层的 remote", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote" } });
    await w.write(w.project, { "one-company": { "git-delivery": "local" } });
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "local", source: "project" });
  });

  test("项目不受信任时忽略项目层，取用户层的值", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote" } });
    await w.write(w.project, { "one-company": { "git-delivery": "local" } });
    expect((await w.read(false)).gitDelivery).toEqual({ mode: "remote", source: "user" });
  });

  test("用户层写了值时不再用探测结果，即使 origin 主机登录过", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, "git@github.com:acme/shop.git");
    gh.ghLoggedIn(["github.com"]);
    await w.write(w.user, { "one-company": { "git-delivery": "local" } });
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "local", source: "user" });
  });

  test.each([
    ["旧的 true", true, "true"],
    ["旧的 false", false, "false"],
    ["字符串 yes", "yes", '"yes"'],
    ["null", null, "null"],
    ["数字 1", 1, "1"],
  ])("用户层写 %s：这一层不生效，改用内置默认值，问题带原因和原样写法", async (_label, written, shown) => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": written } });
    const { gitDelivery, problems } = await w.read(true);
    expect(gitDelivery).toMatchObject({ mode: "local", source: "default" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.user, layer: "user", key: "git-delivery", display: "git-delivery 只能写 remote 或 local", value: shown });
  });

  test("项目层写错时这一项改用用户层的值并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote" } });
    await w.write(w.project, { "one-company": { "git-delivery": true } });
    const { gitDelivery, problems } = await w.read(true);
    expect(gitDelivery).toEqual({ mode: "remote", source: "user" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.project, layer: "project", display: "git-delivery 只能写 remote 或 local", value: "true" });
  });

  test("git-delivery 写错不影响同层的角色设定", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": null, pm: { model: "gpt-6-luna", thinking: "low" } } });
    const { values, problems } = await w.read(true);
    expect(values.pm).toEqual({ model: "gpt-6-luna", thinking: "low", source: "user" });
    expect(problems).toHaveLength(1);
  });

  test("one-company 下出现不认识的键时问题里列出五个可用设定", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { foo: 1 } });
    const { problems } = await w.read(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.user, key: "foo", display: `不认识的设定 foo，只能是 ${ONE_COMPANY_KEYS}` });
  });

  test("只写 git-delivery 时不产生问题，角色仍是默认值", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote" } });
    const { values, problems } = await w.read(true);
    expect(values).toEqual(DEFAULTS);
    expect(problems).toEqual([]);
  });
});

describe("读取 merge-methods", () => {
  test("两层都没写时三种都勾，来源默认", async () => {
    const w = await world();
    expect((await w.read(true)).mergeMethods).toEqual({ methods: ALL_METHODS, source: "default" });
  });

  test("项目层受信任时覆盖用户层", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["merge"] } });
    await w.write(w.project, { "one-company": { "merge-methods": ["rebase", "squash"] } });
    expect((await w.read(true)).mergeMethods).toEqual({ methods: ["rebase", "squash"], source: "project" });
  });

  test("项目不受信任时忽略项目层，取用户层", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["merge"] } });
    await w.write(w.project, { "one-company": { "merge-methods": ["rebase"] } });
    expect((await w.read(false)).mergeMethods).toEqual({ methods: ["merge"], source: "user" });
  });

  test("只写用户层时取用户层，不产生问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["squash"] } });
    const { mergeMethods, problems } = await w.read(true);
    expect(mergeMethods).toEqual({ methods: ["squash"], source: "user" });
    expect(problems).toEqual([]);
  });

  test.each([
    ["重复", ["squash", "squash"], '["squash","squash"]'],
    ["空数组", [], "[]"],
    ["不认识的方式", ["fast"], '["fast"]'],
    ["混着不认识的方式", ["squash", "fast"], '["squash","fast"]'],
    ["不是数组", "squash", '"squash"'],
    ["数组里不是字符串", [1], "[1]"],
  ])("用户层写%s：这一层不生效，改用内置默认值，问题带原因和原样写法", async (_label, written, shown) => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": written } });
    const { mergeMethods, problems } = await w.read(true);
    expect(mergeMethods).toEqual({ methods: ALL_METHODS, source: "default" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      path: w.user, layer: "user", key: "merge-methods",
      display: "merge-methods 只能是 squash、merge、rebase 里的一到三个，不能重复", value: shown,
    });
  });

  test("项目层写错时这一项改用用户层的值并记问题", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["merge"] } });
    await w.write(w.project, { "one-company": { "merge-methods": [] } });
    const { mergeMethods, problems } = await w.read(true);
    expect(mergeMethods).toEqual({ methods: ["merge"], source: "user" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.project, layer: "project", value: "[]" });
  });

  test("merge-methods 写错不影响同层的 git-delivery", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["fast"], "git-delivery": "remote" } });
    const { gitDelivery, problems } = await w.read(true);
    expect(gitDelivery).toEqual({ mode: "remote", source: "user" });
    expect(problems).toHaveLength(1);
  });
});

describe("写入和清除 git-delivery", () => {
  test("保存后其他键原样保留，one-company.git-delivery 为所写档位", async () => {
    const w = await world();
    const original = { theme: "dark", "one-company": { pm: { model: "gpt-6-luna", thinking: "low" } } };
    await w.write(w.user, original);
    await saveGitDeliverySetting({ path: w.user, mode: "remote" });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({
      theme: "dark", "one-company": { pm: { model: "gpt-6-luna", thinking: "low" }, "git-delivery": "remote" },
    });
    await saveGitDeliverySetting({ path: w.user, mode: "local" });
    expect(JSON.parse(await readFile(w.user, "utf8"))["one-company"]["git-delivery"]).toBe("local");
  });

  test("保存后再读出来是所写的值", async () => {
    const w = await world();
    await saveGitDeliverySetting({ path: w.user, mode: "local" });
    const { gitDelivery, problems } = await w.read(true);
    expect(gitDelivery).toEqual({ mode: "local", source: "user" });
    expect(problems).toEqual([]);
  });

  test("保存到不存在的文件时自动建目录和文件", async () => {
    const w = await world();
    expect(existsSync(dirname(w.project))).toBe(false);
    await saveGitDeliverySetting({ path: w.project, mode: "remote" });
    expect(JSON.parse(await readFile(w.project, "utf8"))).toEqual({ "one-company": { "git-delivery": "remote" } });
  });

  test("文件不是合法 JSON 时保存报错，信息含原因和路径，文件内容不变", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    const err = await saveGitDeliverySetting({ path: w.user, mode: "remote" }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("设置文件不是合法的 JSON，没有改动");
    expect(err!.message).toContain(w.user);
    expect(await readFile(w.user, "utf8")).toBe("{ 坏");
  });

  test("清除只删 git-delivery，one-company 里其他项保留", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote", "merge-methods": ["merge"], pm: { model: null, thinking: "off" } } });
    await clearGitDeliverySetting({ path: w.user });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ "one-company": { "merge-methods": ["merge"], pm: { model: null, thinking: "off" } } });
  });

  test("清除后 one-company 变空时整个去掉，其余字段不变", async () => {
    const w = await world();
    await w.write(w.user, { theme: "dark", "one-company": { "git-delivery": "local" } });
    await clearGitDeliverySetting({ path: w.user });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ theme: "dark" });
  });

  test("这一层本来没有 git-delivery 时不改动文件，内容和修改时间都不变", async () => {
    const w = await world();
    const original = JSON.stringify({ "one-company": { pm: { model: null, thinking: "off" } } });
    await w.write(w.user, original);
    const past = new Date(Date.now() - 3_600_000);
    await utimes(w.user, past, past);
    const before = (await stat(w.user)).mtimeMs;
    await clearGitDeliverySetting({ path: w.user });
    expect(await readFile(w.user, "utf8")).toBe(original);
    expect((await stat(w.user)).mtimeMs).toBe(before);
  });

  test("清除时只动所选那一层", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote" } });
    await w.write(w.project, { "one-company": { "git-delivery": "local" } });
    await clearGitDeliverySetting({ path: w.project });
    expect((await w.read(true)).gitDelivery).toEqual({ mode: "remote", source: "user" });
  });
});

describe("写入和清除 merge-methods", () => {
  test("保存后其他键原样保留，one-company.merge-methods 为所写数组", async () => {
    const w = await world();
    await w.write(w.user, { theme: "dark", "one-company": { "git-delivery": "remote" } });
    await saveMergeMethodsSetting({ path: w.user, methods: ["squash", "rebase"] });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({
      theme: "dark", "one-company": { "git-delivery": "remote", "merge-methods": ["squash", "rebase"] },
    });
  });

  test("保存后再读出来是所写的值", async () => {
    const w = await world();
    await saveMergeMethodsSetting({ path: w.project, methods: ["merge"] });
    const { mergeMethods, problems } = await w.read(true);
    expect(mergeMethods).toEqual({ methods: ["merge"], source: "project" });
    expect(problems).toEqual([]);
  });

  test("保存到不存在的文件时自动建目录和文件", async () => {
    const w = await world();
    await saveMergeMethodsSetting({ path: w.project, methods: ["squash", "merge", "rebase"] });
    expect(JSON.parse(await readFile(w.project, "utf8"))).toEqual({ "one-company": { "merge-methods": ["squash", "merge", "rebase"] } });
  });

  test("文件不是合法 JSON 时保存报错，文件内容不变", async () => {
    const w = await world();
    await w.write(w.user, "{ 坏");
    const err = await saveMergeMethodsSetting({ path: w.user, methods: ["merge"] }).then(() => null, (e: Error) => e);
    expect(err!.message).toContain("设置文件不是合法的 JSON，没有改动");
    expect(await readFile(w.user, "utf8")).toBe("{ 坏");
  });

  test("清除只删 merge-methods，one-company 里其他项保留", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "merge-methods": ["merge"], "git-delivery": "local" } });
    await clearMergeMethodsSetting({ path: w.user });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ "one-company": { "git-delivery": "local" } });
  });

  test("清除后 one-company 变空时整个去掉，其余字段不变", async () => {
    const w = await world();
    await w.write(w.user, { theme: "dark", "one-company": { "merge-methods": ["merge"] } });
    await clearMergeMethodsSetting({ path: w.user });
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ theme: "dark" });
  });

  test("这一层本来没有 merge-methods 时不改动文件，内容和修改时间都不变", async () => {
    const w = await world();
    const original = JSON.stringify({ "one-company": { "git-delivery": "local" } });
    await w.write(w.user, original);
    const past = new Date(Date.now() - 3_600_000);
    await utimes(w.user, past, past);
    const before = (await stat(w.user)).mtimeMs;
    await clearMergeMethodsSetting({ path: w.user });
    expect(await readFile(w.user, "utf8")).toBe(original);
    expect((await stat(w.user)).mtimeMs).toBe(before);
  });
});

const api = settings;
const CATALOG = { roles: [{ name: "go-worker" }, { name: "ts-worker" }] };
const has = (names: Iterable<string>, name: string) => [...names].includes(name);

describe("定义开关", () => {
  test("用户层列表原样读出，关闭名单含该名字，开关为用户层关闭", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": ["go-worker"] } });
    const { disabledAgents, problems } = await w.read(true);
    expect(disabledAgents).toEqual({ user: ["go-worker"], project: [] });
    expect(problems).toEqual([]);
    expect(has(api.disabledAgentNames(disabledAgents), "go-worker")).toBe(true);
    expect(api.agentSwitchOf("go-worker", disabledAgents)).toEqual({ generic: false, enabled: false, from: "user" });
  });

  test("两层都没写时全部开启，来源为 null", async () => {
    const w = await world();
    const { disabledAgents } = await w.read(true);
    expect(disabledAgents).toEqual({ user: [], project: [] });
    expect(api.agentSwitchOf("go-worker", disabledAgents)).toEqual({ generic: false, enabled: true, from: null });
  });

  test("只在项目层写且项目受信任时关闭，来源为项目层", async () => {
    const w = await world();
    await w.write(w.project, { "one-company": { "disabled-agents": ["go-worker"] } });
    const { disabledAgents } = await w.read(true);
    expect(disabledAgents).toEqual({ user: [], project: ["go-worker"] });
    expect(has(api.disabledAgentNames(disabledAgents), "go-worker")).toBe(true);
    expect(api.agentSwitchOf("go-worker", disabledAgents)).toEqual({ generic: false, enabled: false, from: "project" });
  });

  test("项目不受信任时项目层列表不生效，project 为空", async () => {
    const w = await world();
    await w.write(w.project, { "one-company": { "disabled-agents": ["go-worker"] } });
    const { disabledAgents } = await w.read(false);
    expect(disabledAgents.project).toEqual([]);
    expect(api.agentSwitchOf("go-worker", disabledAgents).enabled).toBe(true);
  });

  test("两层都写了同一个名字时来源报用户层，关闭名单并集", () => {
    const d = { user: ["go-worker"], project: ["go-worker", "ts-worker"] };
    expect(api.agentSwitchOf("go-worker", d)).toEqual({ generic: false, enabled: false, from: "user" });
    expect(api.agentSwitchOf("ts-worker", d).from).toBe("project");
    const names = [...api.disabledAgentNames(d)];
    expect(names.sort()).toEqual(["go-worker", "ts-worker"]);
  });

  test("通用定义永远不算关闭：关闭名单不含，开关为通用且开启", () => {
    const d = { user: ["reviewer", "go-worker"], project: ["worker", "qa", "explore", "prototype"] };
    const names = api.disabledAgentNames(d);
    for (const g of ["worker", "reviewer", "qa", "explore", "prototype"]) {
      expect(has(names, g)).toBe(false);
      expect(api.agentSwitchOf(g, d)).toMatchObject({ generic: true, enabled: true });
    }
    expect(has(names, "go-worker")).toBe(true);
  });

  test("写成字符串而不是列表：记「只能写定义名列表」问题，原样写法带引号，这一层列表为空", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": "go-worker" } });
    const { disabledAgents, problems } = await w.read(true);
    expect(disabledAgents.user).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.user, layer: "user", key: "disabled-agents", display: "disabled-agents 只能写定义名列表", value: '"go-worker"' });
  });

  test.each([
    ["数字", 1, "1"],
    ["null", null, "null"],
    ["含非字符串元素的列表", ["go-worker", 2], '["go-worker",2]'],
  ])("写成%s：这一层不生效并记问题", async (_label, written, shown) => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": written } });
    const { disabledAgents, problems } = await w.read(true);
    expect(disabledAgents.user).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ key: "disabled-agents", display: "disabled-agents 只能写定义名列表", value: shown });
  });

  test("项目层写错时不影响用户层的列表", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": ["go-worker"] } });
    await w.write(w.project, { "one-company": { "disabled-agents": "ts-worker" } });
    const { disabledAgents, problems } = await w.read(true);
    expect(disabledAgents).toEqual({ user: ["go-worker"], project: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: w.project, layer: "project" });
  });

  test("列表里有通用定义名和不存在的定义名：各记一条问题，目录里的名字不出问题", () => {
    const paths = { user: "/u/settings.json", project: "/p/settings.json" };
    const problems = api.disabledAgentProblems({ user: ["reviewer", "nope", "go-worker"], project: [] }, paths, CATALOG);
    expect(problems.map((p) => [p.key, p.display, p.value])).toEqual([
      ["disabled-agents", "reviewer 是通用定义，不能关闭", "reviewer"],
      ["disabled-agents", "没有叫 nope 的角色定义", "nope"],
    ]);
  });

  test("项目层的坏名字问题指向项目层文件", () => {
    const paths = { user: "/u/settings.json", project: "/p/settings.json" };
    const problems = api.disabledAgentProblems({ user: [], project: ["nope"] }, paths, CATALOG);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: paths.project, layer: "project" });
  });

  test("列表全是有效名字时没有问题", () => {
    expect(api.disabledAgentProblems({ user: ["go-worker"], project: ["ts-worker"] }, { user: "/u", project: "/p" }, CATALOG)).toEqual([]);
  });

  test("通用定义名在列表里时关闭名单不含它，开关仍是通用且开启", () => {
    const d = { user: ["reviewer", "nope"], project: [] };
    expect(has(api.disabledAgentNames(d), "reviewer")).toBe(false);
    expect(api.agentSwitchOf("reviewer", d)).toMatchObject({ generic: true, enabled: true });
  });

  test("one-company 下出现不认识的键时允许键清单含 disabled-agents", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { foo: 1 } });
    const { problems } = await w.read(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.display).toContain("disabled-agents");
  });

  test("保存名单后 one-company 下其他键保留，再读出所写名单", async () => {
    const w = await world();
    await w.write(w.user, { theme: "dark", "one-company": { "git-delivery": "remote" } });
    await api.saveDisabledAgentsSetting(w.user, ["go-worker"]);
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ theme: "dark", "one-company": { "git-delivery": "remote", "disabled-agents": ["go-worker"] } });
    expect((await w.read(true)).disabledAgents.user).toEqual(["go-worker"]);
  });

  test("保存空名单时删掉 disabled-agents 键，其他键保留", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "git-delivery": "remote", "disabled-agents": ["go-worker"] } });
    await api.saveDisabledAgentsSetting(w.user, []);
    expect(JSON.parse(await readFile(w.user, "utf8"))).toEqual({ "one-company": { "git-delivery": "remote" } });
  });

  test("保存到不存在的文件时自动建目录和文件", async () => {
    const w = await world();
    await api.saveDisabledAgentsSetting(w.project, ["go-worker", "ts-worker"]);
    expect(JSON.parse(await readFile(w.project, "utf8"))).toEqual({ "one-company": { "disabled-agents": ["go-worker", "ts-worker"] } });
  });

  test("保存是整层写入：新名单替换旧名单", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": ["go-worker", "ts-worker"] } });
    await api.saveDisabledAgentsSetting(w.user, ["ts-worker"]);
    expect(JSON.parse(await readFile(w.user, "utf8"))["one-company"]["disabled-agents"]).toEqual(["ts-worker"]);
  });

  test("轻量读取返回两层各自的列表，未受信任时项目层为空", async () => {
    const w = await world();
    await w.write(w.user, { "one-company": { "disabled-agents": ["go-worker"] } });
    await w.write(w.project, { "one-company": { "disabled-agents": ["ts-worker"] } });
    const input = { agentDir: w.agentDir, repositoryRoot: w.repositoryRoot };
    expect(await api.readDisabledAgents({ ...input, projectTrusted: true })).toEqual({ user: ["go-worker"], project: ["ts-worker"] });
    expect(await api.readDisabledAgents({ ...input, projectTrusted: false })).toEqual({ user: ["go-worker"], project: [] });
  });

  test("轻量读取在两层都没写 git-delivery 时不调用 gh", async () => {
    const w = await world();
    await initRepoWithOrigin(w.repositoryRoot, "git@github.com:acme/shop.git");
    gh.ghLoggedIn(["github.com"]);
    await w.write(w.user, { "one-company": { "disabled-agents": ["go-worker"] } });
    await api.readDisabledAgents({ agentDir: w.agentDir, repositoryRoot: w.repositoryRoot, projectTrusted: true });
    const log = process.env.FAKE_GH_LOG!;
    expect(existsSync(log) ? await readFile(log, "utf8") : "").toBe("");
  });
});
