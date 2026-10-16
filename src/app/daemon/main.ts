import { parseDaemonStartupConfig } from "./daemon-startup-config.ts";
import { assertSdkVersion } from "./sdk.ts";
import { createHostLoader } from "./loader.mjs";

function parseIdleTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? "600000");
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ONE_COMPANY_IDLE_TIMEOUT_MS 必须是有限正数: ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const capturedEnv = { ...process.env };
  const startupConfig = parseDaemonStartupConfig(capturedEnv);
  const { sdkDir, repoDir, dataRoot: dataRootPath } = startupConfig;
  const idleTimeoutMs = parseIdleTimeoutMs(capturedEnv.ONE_COMPANY_IDLE_TIMEOUT_MS);
  const clockSkewFile = capturedEnv.ONE_COMPANY_CLOCK_SKEW_FILE;
  const modelProviderModulePath = capturedEnv.ONE_COMPANY_MODEL_PROVIDER_MODULE;
  await assertSdkVersion(sdkDir);
  const { startDaemon } = (await createHostLoader(sdkDir).import(
    new URL("./lifecycle.ts", import.meta.url).href,
  )) as typeof import("./lifecycle.ts");
  await startDaemon({
    repoDir,
    dataRoot: dataRootPath,
    idleTimeoutMs,
    clockSkewFile,
    modelProviderModulePath,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
