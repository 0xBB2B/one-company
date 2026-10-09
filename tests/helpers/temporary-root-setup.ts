import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 整轮测试建一个上级目录，各测试进程照旧在它下面自建临时根；全部跑完后整个删除。
 * 测试进程常被直接结束、来不及在退出时清理，原来各自建在 /tmp 下的目录会越积越多。
 */
export default function setup(): () => void {
  const runRoot = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-r-")));
  chmodSync(runRoot, 0o700);
  process.env.ONE_COMPANY_TEST_RUN_ROOT = runRoot;
  return () => {
    const left = readdirSync(runRoot).length;
    if (left) console.warn(`本轮测试有 ${left} 个测试进程的临时根没有自行清理，已随 ${runRoot} 一并删除`);
    rmSync(runRoot, { recursive: true, force: true });
    delete process.env.ONE_COMPANY_TEST_RUN_ROOT;
  };
}
