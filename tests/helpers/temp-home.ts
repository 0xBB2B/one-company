import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  home: string;
  agentDir: string;
  dataRoot: string;
  env: Record<string, string>;
}

export interface TempHomeRootReceipt {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR", "GIT_CEILING_DIRECTORIES"];
const tempHomeReceipts = new WeakMap<object, TempHomeRootReceipt>();

function frozenReceipt(path: string, dev: number, ino: number): TempHomeRootReceipt {
  return Object.freeze({ path, dev, ino });
}

async function assertReceipt(receipt: TempHomeRootReceipt, phase: string): Promise<void> {
  const current = await lstat(receipt.path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== receipt.dev || current.ino !== receipt.ino) {
    throw new Error(`临时 HOME 在${phase}时身份已变化；保全路径 ${receipt.path}`);
  }
}

/** 只向持有原始 createTempHome 返回对象的测试夹具提供分配时根身份。 */
export function tempHomeRootReceipt(home: TempHome): TempHomeRootReceipt | undefined {
  const receipt = tempHomeReceipts.get(home);
  return receipt ? frozenReceipt(receipt.path, receipt.dev, receipt.ino) : undefined;
}

export async function createTempHome(): Promise<TempHome> {
  const home = await mkdtemp(join(tmpdir(), "one-company-home-"));
  let receipt: TempHomeRootReceipt | undefined;
  try {
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`临时 HOME 不是自产普通目录: ${home}`);
    receipt = frozenReceipt(home, info.dev, info.ino);
    const agentDir = join(home, ".pi", "agent");
    const dataRoot = join(agentDir, "one-company");
    await assertReceipt(receipt, "创建 agent 目录前");
    await mkdir(agentDir, { recursive: true });
    await assertReceipt(receipt, "创建 agent 目录后");
    await mkdir(dataRoot, { recursive: true });
    await assertReceipt(receipt, "创建 dataRoot 后");
    await writeFile(join(agentDir, "settings.json"), "{}\n");
    await assertReceipt(receipt, "返回前");
    const env: Record<string, string> = { HOME: home };
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const result = { home, agentDir, dataRoot, env };
    tempHomeReceipts.set(result, receipt);
    return result;
  } catch (error) {
    if (!receipt) {
      console.error(JSON.stringify({ status: "temp_home_preserved", reason: "分配后身份尚未确认", home }));
      throw error;
    }
    try {
      await assertReceipt(receipt, "创建失败清理前");
      await rm(home, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(JSON.stringify({ status: "temp_home_preserved", reason: "创建失败后清理未确认", home }));
      throw new AggregateError([error, cleanupError], `临时 HOME 创建失败且清理失败；保全路径 ${home}`);
    }
    throw error;
  }
}

export async function removeTempHome(home: TempHome): Promise<void> {
  const receipt = tempHomeReceipts.get(home);
  if (!receipt) throw new Error("拒绝删除没有原始分配收据的临时 HOME");
  try { await assertReceipt(receipt, "删除前"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await rm(receipt.path, { recursive: true, force: true });
}
