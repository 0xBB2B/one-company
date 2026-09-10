import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  home: string;
  agentDir: string;
  dataRoot: string;
  env: Record<string, string>;
}

const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR", "GIT_CEILING_DIRECTORIES"];

export async function createTempHome(): Promise<TempHome> {
  const home = await mkdtemp(join(tmpdir(), "pi-company-home-"));
  const agentDir = join(home, ".pi", "agent");
  const dataRoot = join(agentDir, "pi-company");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const env: Record<string, string> = { HOME: home };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { home, agentDir, dataRoot, env };
}

export async function removeTempHome(home: TempHome): Promise<void> {
  await rm(home.home, { recursive: true, force: true });
}
