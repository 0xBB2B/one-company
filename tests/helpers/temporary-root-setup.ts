import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 整轮测试建一个登记目录，各测试进程照旧在系统临时目录下自建临时根，并在这里登记目录名；全部跑完后按登记删除。
 * 测试进程常被直接结束、来不及在退出时清理；临时根不能套在登记目录下面，多一层会让守护进程通信文件的路径超过 macOS 的 104 字节上限。
 */
export default function setup(): () => void {
  const systemRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const runRoot = realpathSync(mkdtempSync(join(systemRoot, "pi-r-")));
  chmodSync(runRoot, 0o700);
  process.env.ONE_COMPANY_TEST_RUN_ROOT = runRoot;
  return () => {
    const left = readdirSync(runRoot).filter((name) => /^pi-t-[A-Za-z0-9]{6}$/.test(name) && existsSync(join(systemRoot, name)));
    for (const name of left) rmSync(join(systemRoot, name), { recursive: true, force: true });
    if (left.length) console.warn(`本轮测试有 ${left.length} 个测试进程的临时根没有自行清理，已按登记删除`);
    rmSync(runRoot, { recursive: true, force: true });
    delete process.env.ONE_COMPANY_TEST_RUN_ROOT;
  };
}
