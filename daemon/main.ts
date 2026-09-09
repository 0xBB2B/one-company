import { dataRoot as resolveDataRoot } from "../runtime/identity.ts";
import { loadSdk } from "./sdk.ts";
import { startDaemon } from "./lifecycle.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量: ${name}`);
  return value;
}

function parseIdleTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? "600000");
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`PI_COMPANY_IDLE_TIMEOUT_MS 必须是有限正数: ${raw}`);
  }
  return value;
}

function parseNetworkProbeIntervalMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`PI_COMPANY_NETWORK_PROBE_INTERVAL_MS 必须是有限正数: ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const sdkDir = requireEnv("PI_COMPANY_SDK_DIR");
  const repoDir = requireEnv("PI_COMPANY_REPO_DIR");
  const dataRootPath = process.env.PI_COMPANY_DATA_ROOT ?? resolveDataRoot(process.env);
  const idleTimeoutMs = parseIdleTimeoutMs(process.env.PI_COMPANY_IDLE_TIMEOUT_MS);
  const clockSkewFile = process.env.PI_COMPANY_CLOCK_SKEW_FILE;
  const modelProviderModulePath = process.env.PI_COMPANY_MODEL_PROVIDER_MODULE;
  const connectivityProbeModulePath = process.env.PI_COMPANY_CONNECTIVITY_PROBE_MODULE;
  const networkProbeIntervalMs = parseNetworkProbeIntervalMs(process.env.PI_COMPANY_NETWORK_PROBE_INTERVAL_MS);

  await loadSdk(sdkDir);
  await startDaemon({
    repoDir,
    dataRoot: dataRootPath,
    idleTimeoutMs,
    clockSkewFile,
    modelProviderModulePath,
    connectivityProbeModulePath,
    networkProbeIntervalMs,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
