import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptedReply } from "./controlled-provider.ts";
import { CONNECTIVITY_REACHABLE_FILE_ENV_VAR, CONNECTIVITY_REACHABLE_MAP_ENV_VAR } from "./connectivity-probe-module.ts";
import { PROVIDER_REQUESTS_LOG_ENV_VAR, PROVIDER_SCRIPTS_ENV_VAR } from "./model-provider-module.ts";
import type { ProviderScript } from "./model-provider-module.ts";

export const MODEL_PROVIDER_MODULE_ENV_VAR = "ONE_COMPANY_MODEL_PROVIDER_MODULE";
export const CONNECTIVITY_PROBE_MODULE_ENV_VAR = "ONE_COMPANY_CONNECTIVITY_PROBE_MODULE";
export const NETWORK_PROBE_INTERVAL_MS_ENV_VAR = "ONE_COMPANY_NETWORK_PROBE_INTERVAL_MS";

export type TestProviderScript = ProviderScript;

const modelProviderModulePath = fileURLToPath(new URL("./model-provider-module.ts", import.meta.url));
const connectivityProbeModulePath = fileURLToPath(new URL("./connectivity-probe-module.ts", import.meta.url));

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

export async function createProviderRequestsLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "provider-requests-log-"));
  const path = join(dir, "requests.jsonl");
  await writeFile(path, "", "utf8");
  return path;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 日志文件由子进程同步写入，但读取仍跨进程/跨事件循环——用轮询代替固定 delay 消除负载下的时序抖动
export async function waitForProviderLogEntries(
  path: string,
  predicate: (entries: ProviderRequestLogEntry[]) => boolean,
  timeoutMs: number,
): Promise<ProviderRequestLogEntry[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entries = await readProviderRequestsLog(path);
    if (predicate(entries)) return entries;
    await delay(100);
  }
  throw new Error(`等待受控 provider 请求日志达到期望条件超时（${timeoutMs}ms）：${path}`);
}

export async function writeNetworkReachableFile(path: string, reachable: boolean): Promise<void> {
  await writeFile(path, reachable ? "reachable" : "unreachable", "utf8");
}

// 连通性探测器的可替换入口：守护进程按 ONE_COMPANY_CONNECTIVITY_PROBE_MODULE 动态导入模块并调用其 probe()，
// 轮询间隔改经 ONE_COMPANY_NETWORK_PROBE_INTERVAL_MS 注入，测试端不必再等生产固定的 30s 间隔
export function connectivityProbeEnv(reachableFilePath: string, intervalMs = 500): Record<string, string> {
  return {
    [CONNECTIVITY_PROBE_MODULE_ENV_VAR]: connectivityProbeModulePath,
    [CONNECTIVITY_REACHABLE_FILE_ENV_VAR]: reachableFilePath,
    [NETWORK_PROBE_INTERVAL_MS_ENV_VAR]: String(intervalMs),
  };
}

// 按 provider baseUrl 分组探测：写一份 {baseUrl: 可达性文件路径} 映射，
// 让 connectivity-probe-module 的 probe(baseUrl) 按各自文件独立判定
export async function writeConnectivityReachableMap(dir: string, entries: Record<string, string>): Promise<string> {
  const path = join(dir, "connectivity-reachable-map.json");
  await writeFile(path, JSON.stringify(entries), "utf8");
  return path;
}

export function connectivityProbeMapEnv(mapPath: string, intervalMs = 500): Record<string, string> {
  return {
    [CONNECTIVITY_PROBE_MODULE_ENV_VAR]: connectivityProbeModulePath,
    [CONNECTIVITY_REACHABLE_MAP_ENV_VAR]: mapPath,
    [NETWORK_PROBE_INTERVAL_MS_ENV_VAR]: String(intervalMs),
  };
}
