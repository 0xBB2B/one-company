import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** PI_COMPANY_TEST_INSTALLED=1 时先打包安装产品，集成测试的 daemon 改从安装产物启动；否则什么也不做。 */
export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.PI_COMPANY_TEST_INSTALLED !== "1") return;
  const root = await mkdtemp(join(tmpdir(), "pi-company-installed-"));
  // 全局准备跑在 vite 模块加载器里，不支持 import.meta.resolve；安装放到独立 Node 进程执行
  const cli = join(dirname(fileURLToPath(import.meta.url)), "install-product-cli.ts");
  const { stdout } = await promisify(execFile)(process.execPath, [cli, root], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  process.env.PI_COMPANY_TEST_PRODUCT_ROOT = stdout.trim();
  return async () => { delete process.env.PI_COMPANY_TEST_PRODUCT_ROOT; await rm(root, { recursive: true, force: true }); };
}
