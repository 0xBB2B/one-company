import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptedReply } from "./controlled-provider.ts";
import { PROVIDER_REQUESTS_LOG_ENV_VAR, PROVIDER_SCRIPTS_ENV_VAR } from "./model-provider-module.ts";
import type { ProviderScript } from "./model-provider-module.ts";

export const MODEL_PROVIDER_MODULE_ENV_VAR = "ONE_COMPANY_MODEL_PROVIDER_MODULE";

export type TestProviderScript = ProviderScript;

const modelProviderModulePath = fileURLToPath(new URL("./model-provider-module.ts", import.meta.url));

export async function writeTestModelProviders(dir: string, scripts: TestProviderScript[]): Promise<string> {
  const path = join(dir, "model-providers.json");
  await writeFile(path, JSON.stringify(scripts), "utf8");
  return path;
}

// 守护进程按 ONE_COMPANY_MODEL_PROVIDER_MODULE 动态导入通用模块并调用其 registerProviders(runtime)；
// 生产代码不引用测试目录，脚本数据路径经模块自身读取的 ONE_COMPANY_TEST_PROVIDER_SCRIPTS 传入
export function modelProviderEnv(scriptsPath: string, requestsLogPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    [MODEL_PROVIDER_MODULE_ENV_VAR]: modelProviderModulePath,
    [PROVIDER_SCRIPTS_ENV_VAR]: scriptsPath,
  };
  if (requestsLogPath) env[PROVIDER_REQUESTS_LOG_ENV_VAR] = requestsLogPath;
  return env;
}

export interface ProviderRequestLogEntry {
  providerId: string;
  at: number;
  text: string;
}

export async function readProviderRequestsLog(path: string): Promise<ProviderRequestLogEntry[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProviderRequestLogEntry);
}
