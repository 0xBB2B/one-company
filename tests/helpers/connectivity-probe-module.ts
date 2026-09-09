import { readFile } from "node:fs/promises";

export const CONNECTIVITY_REACHABLE_FILE_ENV_VAR = "PI_COMPANY_TEST_CONNECTIVITY_REACHABLE_FILE";
export const CONNECTIVITY_REACHABLE_MAP_ENV_VAR = "PI_COMPANY_TEST_CONNECTIVITY_REACHABLE_MAP";

async function readReachableFile(path: string): Promise<boolean | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim() === "reachable";
  } catch {
    return null;
  }
}

// 守护进程经 PI_COMPANY_CONNECTIVITY_PROBE_MODULE 动态导入本模块并调用 probe()；
// 文件路径这一测试内部细节经自身读取的环境变量传入，生产代码无需知道。
// 按 provider baseUrl 分组探测时传入 baseUrl，本模块从 PI_COMPANY_TEST_CONNECTIVITY_REACHABLE_MAP
// 指向的 JSON（{baseUrl: 文件路径}）里找该 baseUrl 专属的可达性文件；不传或找不到时退回全局单文件
export async function probe(baseUrl?: string): Promise<boolean | null> {
  if (baseUrl) {
    const mapPath = process.env[CONNECTIVITY_REACHABLE_MAP_ENV_VAR];
    if (mapPath) {
      try {
        const map = JSON.parse(await readFile(mapPath, "utf8")) as Record<string, string>;
        const filePath = map[baseUrl];
        if (filePath) return readReachableFile(filePath);
      } catch {
        return null;
      }
    }
  }
  const path = process.env[CONNECTIVITY_REACHABLE_FILE_ENV_VAR];
  if (!path) return null;
  return readReachableFile(path);
}
