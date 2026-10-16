import { isAbsolute } from "node:path";
import { dataRoot } from "../../core/storage/data-root.ts";

export interface DaemonStartupConfig {
  readonly sdkDir: string;
  readonly repoDir: string;
  readonly dataRoot: string;
}

function requiredAbsolutePath(name: string, value: string | undefined): string {
  if (!value) throw new Error(`缺少环境变量: ${name}`);
  if (!isAbsolute(value)) throw new Error(`${name} 必须是绝对路径: ${value}`);
  return value;
}

export function parseDaemonStartupConfig(env: Record<string, string | undefined>): DaemonStartupConfig {
  const sdkDir = requiredAbsolutePath("ONE_COMPANY_SDK_DIR", env.ONE_COMPANY_SDK_DIR);
  const repoDir = requiredAbsolutePath("ONE_COMPANY_REPO_DIR", env.ONE_COMPANY_REPO_DIR);
  const configuredDataRoot = Object.hasOwn(env, "ONE_COMPANY_DATA_ROOT")
    ? requiredAbsolutePath("ONE_COMPANY_DATA_ROOT", env.ONE_COMPANY_DATA_ROOT)
    : dataRoot(env);
  return Object.freeze({ sdkDir, repoDir, dataRoot: configuredDataRoot });
}
