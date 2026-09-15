import { currentHostGit } from "../runtime/git-runtime.mjs";
import { parseDaemonStartupConfig } from "../runtime/daemon-startup-config.ts";
import { loadSdk } from "./sdk.ts";
import { startDaemon } from "./lifecycle.ts";

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
  const capturedEnv = { ...process.env };
  const startupConfig = parseDaemonStartupConfig(capturedEnv);
  const { sdkDir, repoDir, dataRoot: dataRootPath, ownRoots } = startupConfig;
  const idleTimeoutMs = parseIdleTimeoutMs(capturedEnv.PI_COMPANY_IDLE_TIMEOUT_MS);
  const clockSkewFile = capturedEnv.PI_COMPANY_CLOCK_SKEW_FILE;
  const modelProviderModulePath = capturedEnv.PI_COMPANY_MODEL_PROVIDER_MODULE;
  const connectivityProbeModulePath = capturedEnv.PI_COMPANY_CONNECTIVITY_PROBE_MODULE;
  const networkProbeIntervalMs = parseNetworkProbeIntervalMs(capturedEnv.PI_COMPANY_NETWORK_PROBE_INTERVAL_MS);
  currentHostGit(ownRoots);
  await loadSdk(sdkDir);
  currentHostGit(ownRoots);
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
