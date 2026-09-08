import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIN_SDK_VERSION = "0.85.0";

interface ParsedVersion {
  parts: [number, number, number];
  prerelease: boolean;
}

function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?/.exec(version);
  if (!match) throw new Error(`无法解析 SDK 版本号: ${version}`);
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return (a.parts[i] as number) > (b.parts[i] as number);
  }
  // 数字部分相等时，预发布版本视为低于同号正式版
  return !a.prerelease;
}

export async function assertSdkVersion(sdkDir: string): Promise<string> {
  const packageJsonPath = join(sdkDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(`SDK 目录缺失或无法读取 package.json: ${sdkDir}`, { cause: error });
  }
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== "string") {
    throw new Error(`SDK package.json 缺少 version 字段: ${packageJsonPath}`);
  }
  if (!versionAtLeast(pkg.version, MIN_SDK_VERSION)) {
    throw new Error(`SDK 版本过低: ${pkg.version}，要求 >= ${MIN_SDK_VERSION}（${sdkDir}）`);
  }
  return pkg.version;
}

export async function loadSdkModule(sdkDir: string, packageName: string): Promise<unknown> {
  const packageRequire = createRequire(join(sdkDir, "package.json"));
  const resolved = packageRequire.resolve(packageName);
  return import(pathToFileURL(resolved).href);
}

export async function loadSdk(sdkDir: string): Promise<Record<string, unknown>> {
  await assertSdkVersion(sdkDir);
  const entry = join(sdkDir, "dist", "index.js");
  const sdkModule = await import(pathToFileURL(entry).href);
  return sdkModule as Record<string, unknown>;
}
