import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceConfig } from "./acceptance/helpers/installed-host.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_NAMES = [
  "ONE_COMPANY_ACCEPTANCE_OUTPUT",
  "ONE_COMPANY_ACCEPTANCE_MODEL",
  "ONE_COMPANY_ACCEPTANCE_THINKING",
  "ONE_COMPANY_ACCEPTANCE_CREDENTIALS",
] as const;
const saved: Record<string, string | undefined> = {};
const BASE_SETTINGS = { defaultProvider: "5x-test", defaultModel: "gpt-6.1-sol" };

let credentials: string;
let output: string;

beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  credentials = mkdtempSync(join(temporaryRoot(), "cred-"));
  output = join(temporaryRoot(), "evidence");
  process.env.ONE_COMPANY_ACCEPTANCE_CREDENTIALS = credentials;
  process.env.ONE_COMPANY_ACCEPTANCE_OUTPUT = output;
});

afterEach(() => {
  rmSync(credentials, { recursive: true, force: true });
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function writeSettings(settings: object): string {
  const file = join(credentials, "settings.json");
  writeFileSync(file, JSON.stringify(settings));
  return file;
}

describe("验收配置：模型", () => {
  test("没有模型变量时取 pi 配置的默认提供方和模型", () => {
    writeSettings(BASE_SETTINGS);
    expect(acceptanceConfig()).toEqual({
      provider: "5x-test", modelId: "gpt-6.1-sol", thinking: "medium", credentialsDir: credentials, output,
    });
  });

  test("设了模型变量时用变量，不看 pi 配置的模型", () => {
    writeSettings(BASE_SETTINGS);
    process.env.ONE_COMPANY_ACCEPTANCE_MODEL = "5x/gpt-6.1-sol";
    const config = acceptanceConfig();
    expect(config?.provider).toBe("5x");
    expect(config?.modelId).toBe("gpt-6.1-sol");
  });

  test("模型变量不是 <提供方>/<模型> 格式时报错", () => {
    writeSettings(BASE_SETTINGS);
    process.env.ONE_COMPANY_ACCEPTANCE_MODEL = "5x";
    expect(() => acceptanceConfig()).toThrow("<provider>/<model>");
  });

  test("凭据目录下项目级 .pi/settings.json 不参与取值", () => {
    writeSettings(BASE_SETTINGS);
    mkdirSync(join(credentials, ".pi"));
    writeFileSync(join(credentials, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "other", defaultModel: "x" }));
    const config = acceptanceConfig();
    expect(config?.provider).toBe("5x-test");
    expect(config?.modelId).toBe("gpt-6.1-sol");
  });
});

describe("验收配置：思考等级", () => {
  test("变量和 pi 配置都没有时取 medium", () => {
    writeSettings(BASE_SETTINGS);
    expect(acceptanceConfig()?.thinking).toBe("medium");
  });

  test("没有变量时取 pi 配置的 defaultThinkingLevel", () => {
    writeSettings({ ...BASE_SETTINGS, defaultThinkingLevel: "high" });
    expect(acceptanceConfig()?.thinking).toBe("high");
  });

  test("思考等级变量优先于 pi 配置", () => {
    writeSettings({ ...BASE_SETTINGS, defaultThinkingLevel: "high" });
    process.env.ONE_COMPANY_ACCEPTANCE_THINKING = "low";
    expect(acceptanceConfig()?.thinking).toBe("low");
  });

  test("思考等级不在允许范围时报错并带上这个值", () => {
    writeSettings(BASE_SETTINGS);
    process.env.ONE_COMPANY_ACCEPTANCE_THINKING = "huge";
    expect(() => acceptanceConfig()).toThrow("huge");
  });

  test("pi 配置里的思考等级不在允许范围时报错并带上这个值", () => {
    writeSettings({ ...BASE_SETTINGS, defaultThinkingLevel: "huge" });
    expect(() => acceptanceConfig()).toThrow("huge");
  });
});

describe("验收配置：证据目录与 pi 配置缺失", () => {
  test("没有证据目录时返回 null，即使设了模型变量", () => {
    writeSettings(BASE_SETTINGS);
    delete process.env.ONE_COMPANY_ACCEPTANCE_OUTPUT;
    process.env.ONE_COMPANY_ACCEPTANCE_MODEL = "5x/gpt-6.1-sol";
    expect(acceptanceConfig()).toBeNull();
  });

  test("没有证据目录时返回 null，即使没设模型变量", () => {
    writeSettings(BASE_SETTINGS);
    delete process.env.ONE_COMPANY_ACCEPTANCE_OUTPUT;
    expect(acceptanceConfig()).toBeNull();
  });

  const missing: Array<[string, () => void]> = [
    ["缺 defaultModel", () => writeSettings({ defaultProvider: "5x-test" })],
    ["缺 defaultProvider", () => writeSettings({ defaultModel: "gpt-6.1-sol" })],
    ["settings.json 不存在", () => undefined],
  ];
  test.each(missing)("%s 且无模型变量时报错，信息含路径和两个字段名与覆盖变量", (_name, setup) => {
    setup();
    let message = "";
    try {
      acceptanceConfig();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(join(credentials, "settings.json"));
    expect(message).toContain("defaultProvider");
    expect(message).toContain("defaultModel");
    expect(message).toContain("ONE_COMPANY_ACCEPTANCE_MODEL");
  });

  test("pi 配置文件不是合法 JSON 时报错，信息含路径", () => {
    writeFileSync(join(credentials, "settings.json"), "{ not json");
    expect(() => acceptanceConfig()).toThrow(join(credentials, "settings.json"));
  });

  test("读取 pi 配置后文件内容逐字节不变", () => {
    const file = writeSettings({ ...BASE_SETTINGS, defaultThinkingLevel: "high", extra: { a: 1 } });
    const before = readFileSync(file);
    acceptanceConfig();
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("并行验收脚本缺证据目录", () => {
  test("退出码非 0，stderr 只要求设证据目录", () => {
    const env = { ...process.env };
    delete env.ONE_COMPANY_ACCEPTANCE_OUTPUT;
    delete env.ONE_COMPANY_ACCEPTANCE_MODEL;
    const result = spawnSync(process.execPath, ["tests/acceptance/run-parallel.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ONE_COMPANY_ACCEPTANCE_OUTPUT");
    expect(result.stderr).not.toContain("ONE_COMPANY_ACCEPTANCE_MODEL");
  });
});
