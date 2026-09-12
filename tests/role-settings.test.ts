import { readRecord, putRecord, withDatabase } from "../runtime/database.ts";
import { failDatabaseWrites } from "./helpers/database-fixture.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRoleField,
  effectiveMcp,
  loadRoleSettings,
  resolveRoleSettings,
  saveRoleSettings,
  settingsPaths,
  thinkingCandidatesFor,
} from "../runtime/settings.ts";

const ROLE_NAMES = ["planner", "worker", "reviewer", "acceptance", "requirement-agent"];
const MODEL_A = "acme/model-a";
const MODEL_B = "acme/model-b";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-role-settings-"));
  tempRoots.push(root);
  return root;
}

test("清除最后一项后同一设置页可继续保存，空层读取不创建数据库", async () => {
  const root = await makeRoot();
  const path = join(root, "settings.sqlite");
  const initial = await loadRoleSettings({ global: path, project: null }, { roleNames: ROLE_NAMES });
  expect(initial.global.raw).toBeNull();
  expect(await readdir(root)).toEqual([]);
  const saved = await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline: initial.global.raw });
  const cleared = await clearRoleField(path, { role: "worker", field: "model", baseline: saved });
  expect(cleared).toBeNull();
  await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_B }, baseline: cleared });
  const loaded = await loadRoleSettings({ global: path, project: null }, { roleNames: ROLE_NAMES });
  expect(loaded.global.roles.worker?.model).toBe(MODEL_B);
});

function settingsText(roles: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(roles);
}

function readSettings(path: string): string | null {
  return withDatabase(path, (db) => {
    const rows = db.list("role_settings");
    return rows.length ? JSON.stringify(Object.fromEntries(rows.map((row) => [row.key, row.data]))) : null;
  });
}

async function writeSettingsFile(path: string, roles: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string | null> {
  withDatabase(path, (db) => db.transaction(() => {
    for (const row of db.list("role_settings")) db.remove("role_settings", row.key, row.version);
    for (const [key, value] of Object.entries(roles)) db.create("role_settings", key, value);
    for (const [key, value] of Object.entries(extra)) db.create("other_settings", key, value);
  }));
  return readSettings(path);
}

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    mainModel: MODEL_A,
    mainThinking: "medium",
    models: [
      { id: MODEL_A, thinkingLevels: ["off", "low", "medium", "high"] },
      { id: MODEL_B, thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
    ],
    availableMcp: ["context7", "chrome-devtools", "codegraph"],
    ...overrides,
  };
}

async function expectThrows(run: () => unknown, contains: string): Promise<void> {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(contains);
  expect(message.length).toBeGreaterThan(contains.length);
}

describe("settingsPaths", () => {
  test("项目受信任时返回全局与仓库数据库", async () => {
    const repo = await createRepoFixture();
    try {
      const paths = await settingsPaths({ agentDir: "/home/x/.pi/agent", repoRoot: repo.root, projectTrusted: true });
      expect(paths.global).toBe("/home/x/.pi/agent/pi-company/global.db");
      expect(paths.project).toMatch(/pi-company\/repos\/[0-9a-f]{64}\/data.db$/);
    } finally { await removeRepoFixture(repo); }
  });

  test("项目不受信任时不解析项目目录", async () => {
    const paths = await settingsPaths({ agentDir: "/home/x/.pi/agent", repoRoot: "/repo", projectTrusted: false });
    expect(paths.project).toBeNull();
    expect(paths.global).toBe("/home/x/.pi/agent/pi-company/global.db");
  });
});

describe("loadRoleSettings 解析与校验", () => {
  test("文件不存在视为空层", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    const project = join(root, "project", "settings.sqlite");

    const result = await loadRoleSettings({ global, project }, { roleNames: ROLE_NAMES });

    expect(result.global).toEqual({ path: global, raw: null, roles: {} });
    expect(result.project).toEqual({ path: project, raw: null, roles: {} });
  });

  test("paths.project 为 null 时结果 project 为 null", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");

    const result = await loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES });

    expect(result.project).toBeNull();
  });

  test("合法条目解析出角色配置并去掉前缀", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, {
      "pi-company.worker": { model: MODEL_A, thinking: "high", mcp: ["context7", "chrome-devtools"] },
      "pi-company.requirement-agent": { model: "inherit" },
    });

    const result = await loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES });

    expect(result.global.roles.worker).toEqual({ model: MODEL_A, thinking: "high", mcp: ["context7", "chrome-devtools"] });
    expect(result.global.roles["requirement-agent"]).toEqual({ model: "inherit" });
  });

  test("条目含未知键抛出含角色名的错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { model: MODEL_A, extra: true } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("model 格式非法抛出含角色名的错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { model: "not-a-valid-model" } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("model 允许多段路径式 id", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { model: "openrouter/meta-llama/llama-3" } });

    const result = await loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES });

    expect(result.global.roles.worker).toEqual({ model: "openrouter/meta-llama/llama-3" });
  });

  test("model 单段无斜杠时非法", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { model: "claude" } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("model 首段为空时非法", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { model: "/x" } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("thinking 不在枚举内抛出含角色名的错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { thinking: "ultra" } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("mcp 非字符串数组抛出含角色名的错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.worker": { mcp: "context7" } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "worker");
  });

  test("角色名不在角色目录中抛出含该角色名的错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await writeSettingsFile(global, { "pi-company.ghost-role": { model: MODEL_A } });

    await expectThrows(() => loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES }), "ghost-role");
  });

  test("顶层 JSON 非法抛出错误", async () => {
    const root = await makeRoot();
    const global = join(root, "global", "settings.sqlite");
    await mkdir(join(root, "global"), { recursive: true });
    await writeFile(global, "{ not json");

    await expect(loadRoleSettings({ global, project: null }, { roleNames: ROLE_NAMES })).rejects.toThrow();
  });
});

describe("resolveRoleSettings 逐字段继承", () => {
  function layer(path: string, roles: Record<string, unknown>) {
    return { path, raw: settingsText(roles), roles };
  }

  test("项目显式模型覆盖全局，未设的思考沿用全局显式值", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_A, thinking: "high" } });
    const project = layer("/p/settings.sqlite", { worker: { model: MODEL_B } });

    const resolved = await resolveRoleSettings("worker", { global, project }, baseContext());

    expect(resolved.model).toBe(MODEL_B);
    expect(resolved.thinking).toBe("high");
  });

  test("无项目层时使用全局显式配置", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_A, thinking: "high" } });

    const resolved = await resolveRoleSettings("worker", { global, project: null }, baseContext());

    expect(resolved.model).toBe(MODEL_A);
    expect(resolved.thinking).toBe("high");
  });

  test("显式配置 model 为 inherit 时解析得主会话模型", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_B } });
    const project = layer("/p/settings.sqlite", { worker: { model: "inherit" } });
    const context = baseContext();

    const resolved = await resolveRoleSettings("worker", { global, project }, context);

    expect(resolved.model).toBe(context.mainModel);
  });

  test("其他角色不受目标角色显式配置影响", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_A, thinking: "high" } });
    const project = layer("/p/settings.sqlite", { worker: { model: MODEL_B } });
    const context = baseContext();

    const resolved = await resolveRoleSettings("reviewer", { global, project }, context);

    expect(resolved.model).toBe(context.mainModel);
    expect(resolved.thinking).toBe(context.mainThinking);
  });

  test("四角色均未显式配置时随主会话模型与等级变化", async () => {
    const global = layer("/g/settings.sqlite", {});
    const roles = ["planner", "worker", "reviewer", "acceptance"];

    const highContext = baseContext({ mainThinking: "high" });
    for (const role of roles) {
      const resolved = await resolveRoleSettings(role, { global, project: null }, highContext);
      expect(resolved.thinking).toBe("high");
      expect(resolved.model).toBe(highContext.mainModel);
    }

    const mediumContext = baseContext({ mainThinking: "medium" });
    for (const role of roles) {
      const resolved = await resolveRoleSettings(role, { global, project: null }, mediumContext);
      expect(resolved.thinking).toBe("medium");
      expect(resolved.model).toBe(mediumContext.mainModel);
    }
  });

  test("mcp 按范围整体覆盖：项目保存过则不取全局并集", async () => {
    const global = layer("/g/settings.sqlite", { worker: { mcp: ["context7", "chrome-devtools"] } });
    const project = layer("/p/settings.sqlite", { worker: { mcp: ["codegraph"] } });

    const resolved = await resolveRoleSettings("worker", { global, project }, baseContext());

    expect(resolved.mcp.enabled).toEqual(["codegraph"]);
    expect(resolved.mcp.unavailable).toEqual([]);
  });

  test("mcp 字段级回退：项目层存在但未保存 mcp 字段时沿用全局 mcp", async () => {
    const global = layer("/g/settings.sqlite", { worker: { mcp: ["context7"] } });
    const project = layer("/p/settings.sqlite", { worker: { model: MODEL_B } });

    const resolved = await resolveRoleSettings("worker", { global, project }, baseContext());

    expect(resolved.mcp.enabled).toEqual(["context7"]);
  });

  test("已保存服务不可用时保留在 unavailable 而不静默丢弃", async () => {
    const global = layer("/g/settings.sqlite", { worker: { mcp: ["codegraph"] } });
    const context = baseContext({ availableMcp: ["context7", "chrome-devtools"] });

    const resolved = await resolveRoleSettings("worker", { global, project: null }, context);

    expect(resolved.mcp.enabled).toEqual([]);
    expect(resolved.mcp.unavailable).toEqual(["codegraph"]);
  });

  test("显式模型不在可用模型集合中抛出含角色名的错误", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: "acme/ghost-model" } });

    await expectThrows(() => resolveRoleSettings("worker", { global, project: null }, baseContext()), "worker");
  });

  test("显式思考超出模型能力抛出含角色名的错误", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_A, thinking: "xhigh" } });

    await expectThrows(() => resolveRoleSettings("worker", { global, project: null }, baseContext()), "worker");
  });

  test("继承主会话思考超出显式模型能力时收敛到该模型支持的最高等级", async () => {
    const global = layer("/g/settings.sqlite", { worker: { model: MODEL_A } });
    const context = baseContext({ mainThinking: "xhigh" });

    const resolved = await resolveRoleSettings("worker", { global, project: null }, context);

    expect(resolved.model).toBe(MODEL_A);
    expect(resolved.thinking).toBe("high");
  });

  test("主会话模型不在模型目录中且角色未显式配置时模型与思考原样沿用主会话", async () => {
    const global = layer("/g/settings.sqlite", {});
    const context = baseContext({ mainModel: "acme/ghost-model", mainThinking: "xhigh" });

    const resolved = await resolveRoleSettings("worker", { global, project: null }, context);

    expect(resolved.model).toBe("acme/ghost-model");
    expect(resolved.thinking).toBe("xhigh");
  });
});

describe("effectiveMcp 范围合并", () => {
  const available = ["context7", "chrome-devtools", "codegraph"];

  test("两层都未保存时结果为空集合", () => {
    const result = effectiveMcp({ available });
    expect(result).toEqual({ enabled: [], unavailable: [], source: "none" });
  });

  test("仅全局保存时取全局", () => {
    const result = effectiveMcp({ global: ["context7", "chrome-devtools"], available });
    expect(result.enabled.sort()).toEqual(["chrome-devtools", "context7"]);
    expect(result.source).toBe("global");
  });

  test("项目保存过即整体取项目而非取并集", () => {
    const result = effectiveMcp({ global: ["context7", "chrome-devtools"], project: ["codegraph"], available });
    expect(result.enabled).toEqual(["codegraph"]);
    expect(result.source).toBe("project");
  });

  test("项目保存为空数组时整体覆盖全局得空集合", () => {
    const result = effectiveMcp({ global: ["context7", "chrome-devtools"], project: [], available });
    expect(result.enabled).toEqual([]);
    expect(result.source).toBe("project");
  });

  test("可用集合不含已保存服务时该服务归入 unavailable", () => {
    const result = effectiveMcp({ project: ["codegraph"], available: ["context7"] });
    expect(result.enabled).toEqual([]);
    expect(result.unavailable).toEqual(["codegraph"]);
  });

  test("不修改传入的数组参数", () => {
    const global = ["context7"];
    const project = ["codegraph"];
    effectiveMcp({ global, project, available });
    expect(global).toEqual(["context7"]);
    expect(project).toEqual(["codegraph"]);
  });
});

describe("saveRoleSettings 原子保存与 CAS", () => {
  test("文件不存在时创建新文件并写入 patch", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");

    const raw = await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A, thinking: "high" }, baseline: null });

    const parsed = JSON.parse(raw);
    expect(parsed["pi-company.worker"]).toEqual({ model: MODEL_A, thinking: "high" });
    const onDisk = readSettings(path);
    expect(JSON.parse(onDisk)).toEqual(parsed);
  });

  test("保存后保留其他顶层键与其他角色条目", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.reviewer": { thinking: "medium" } }, { theme: "dark" });

    const raw = await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline });

    const parsed = JSON.parse(raw);
    expect(readRecord({ database: path, namespace: "other_settings", key: "theme" })).toMatchObject({ data: "dark" });
    expect(parsed["pi-company.reviewer"]).toEqual({ thinking: "medium" });
    expect(parsed["pi-company.worker"]).toEqual({ model: MODEL_A });
  });

  test("baseline 与磁盘当前内容不一致时 CAS 失败且文件不变", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A } });
    const externallyModified = settingsText({ "pi-company.worker": { model: MODEL_B } });
    await writeSettingsFile(path, JSON.parse(externallyModified));

    await expectThrows(
      () => saveRoleSettings(path, { role: "worker", patch: { thinking: "high" }, baseline }),
      "重新打开",
    );

    const onDisk = readSettings(path);
    expect(onDisk).toBe(externallyModified);
  });

  test("目标是符号链接时拒绝写入", async () => {
    const root = await makeRoot();
    const target = join(root, "real-settings.sqlite");
    await writeSettingsFile(target, {});
    const linkPath = join(root, "settings.sqlite");
    await symlink(target, linkPath);

    await expect(saveRoleSettings(linkPath, { role: "worker", patch: { model: MODEL_A }, baseline: null })).rejects.toThrow();

    const targetContent = readSettings(target);
    expect(targetContent).toBeNull();
  });

  test("patch 非法时抛出错误且文件不变", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A } });

    await expect(saveRoleSettings(path, { role: "worker", patch: { thinking: "ultra" }, baseline })).rejects.toThrow();

    const onDisk = readSettings(path);
    expect(onDisk).toBe(baseline);
  });

  test("写入完成后目录内无残留临时文件", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");

    await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline: null });

    const entries = await readdir(root);
    expect(entries).toContain("settings.sqlite");
    expect(entries.every((name) => ["settings.sqlite", "settings.sqlite-wal", "settings.sqlite-shm"].includes(name))).toBe(true);
  });

  test("既有角色记录结构损坏时拒绝覆盖", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": [1, 2, 3] });
    await expect(saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline })).rejects.toThrow("必须是对象");
    expect(readSettings(path)).toBe(baseline);
  });

  test("保存前后文件权限保持 0600", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A } });
    await chmod(path, 0o644);

    await saveRoleSettings(path, { role: "worker", patch: { thinking: "high" }, baseline });

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("文件不存在时新建文件权限为 0600", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");

    await saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline: null });

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("patch 含 undefined 值的键时视为未提供该键", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A, thinking: "medium" } });

    const raw = await saveRoleSettings(path, {
      role: "worker",
      patch: { model: undefined, thinking: "low" },
      baseline,
    });

    const parsed = JSON.parse(raw);
    expect(parsed["pi-company.worker"]).toEqual({ model: MODEL_A, thinking: "low" });
  });

  test("同一 baseline 并发保存恰一个成功一个抛出重新打开错误", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A } });

    const results = await Promise.allSettled([
      saveRoleSettings(path, { role: "worker", patch: { thinking: "high" }, baseline }),
      saveRoleSettings(path, { role: "worker", patch: { thinking: "low" }, baseline }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("重新打开");

    const entries = await readdir(root);
    expect(entries).toContain("settings.sqlite");
    expect(entries.every((name) => ["settings.sqlite", "settings.sqlite-wal", "settings.sqlite-shm"].includes(name))).toBe(true);
  });

  test("目标目录不可写时返回带原因的错误且无残留临时文件", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, {});
    const restore = failDatabaseWrites(path, "records", "namespace", "role_settings");

    try {
      await expect(saveRoleSettings(path, { role: "worker", patch: { model: MODEL_A }, baseline })).rejects.toThrow();
    } finally {
      restore();
    }

    const entries = await readdir(root);
    expect(entries).toContain("settings.sqlite");
    expect(entries.every((name) => ["settings.sqlite", "settings.sqlite-wal", "settings.sqlite-shm"].includes(name))).toBe(true);
  });
});

describe("clearRoleField", () => {
  test("删除单个字段后角色其余字段保留", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { model: MODEL_A, thinking: "high" } });

    const raw = await clearRoleField(path, { role: "worker", field: "thinking", baseline });

    const parsed = JSON.parse(raw);
    expect(parsed["pi-company.worker"]).toEqual({ model: MODEL_A });
  });

  test("删除最后一个字段后角色键整体消失", async () => {
    const root = await makeRoot();
    const path = join(root, "settings.sqlite");
    const baseline = await writeSettingsFile(path, { "pi-company.worker": { thinking: "high" } });

    const raw = await clearRoleField(path, { role: "worker", field: "thinking", baseline });

    const parsed = JSON.parse(raw);
    // 空设置返回 null；含点的角色键按字面名称核对。
    expect(parsed === null || !Object.hasOwn(parsed, "pi-company.worker")).toBe(true);
  });
});

describe("thinkingCandidatesFor", () => {
  test("返回该模型支持的思考等级", () => {
    const context = baseContext();
    expect(thinkingCandidatesFor(MODEL_A, context)).toEqual(["off", "low", "medium", "high"]);
    expect(thinkingCandidatesFor(MODEL_B, context)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  test("模型不存在返回空数组", () => {
    const context = baseContext();
    expect(thinkingCandidatesFor("acme/ghost-model", context)).toEqual([]);
  });
});

describe("思考等级收敛与空能力集", () => {
  test("模型能力集非升序时继承仍收敛到等级最高者", async () => {
    const root = await makeRoot();
    const paths = await settingsPaths({ agentDir: root, repoRoot: join(root, "repo"), projectTrusted: false });
    await writeSettingsFile(paths.global, { "pi-company.worker": { model: "acme/desc" } });
    const layers = await loadRoleSettings(paths, { roleNames: ["worker"] });
    const resolved = resolveRoleSettings("worker", layers, {
      mainModel: "acme/other",
      mainThinking: "xhigh",
      models: [
        { id: "acme/desc", thinkingLevels: ["high", "medium", "off", "low"] },
        { id: "acme/other", thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
      ],
      availableMcp: [],
    });
    expect(resolved.thinking).toBe("high");
  });

  test("模型声明不支持任何思考等级时显式思考报错，继承为 off", async () => {
    const root = await makeRoot();
    const paths = await settingsPaths({ agentDir: root, repoRoot: join(root, "repo"), projectTrusted: false });
    await writeSettingsFile(paths.global, {
      "pi-company.worker": { model: "acme/none", thinking: "max" },
      "pi-company.planner": { model: "acme/none" },
    });
    const layers = await loadRoleSettings(paths, { roleNames: ["worker", "planner"] });
    const context = {
      mainModel: "acme/other",
      mainThinking: "high",
      models: [
        { id: "acme/none", thinkingLevels: [] },
        { id: "acme/other", thinkingLevels: ["off", "low", "medium", "high"] },
      ],
      availableMcp: [],
    };
    expect(() => resolveRoleSettings("worker", layers, context)).toThrow("worker");
    expect(resolveRoleSettings("planner", layers, context).thinking).toBe("off");
  });
});
