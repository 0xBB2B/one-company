import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 整轮测试共用一个临时根目录，交给各测试进程按受控模式使用；全部跑完后统一删除。
 * 测试进程常被直接结束、来不及在退出时清理，各进程自建的目录因此会越积越多。
 */
export default function setup(): () => void {
  const root = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-t-")));
  chmodSync(root, 0o700);
  // 几个测试进程同时首次建 verification 会撞车，这里先建好
  mkdirSync(join(root, "verification"), { mode: 0o700 });
  const stats = statSync(root, { bigint: true });
  process.env.ONE_COMPANY_TEST_PARENT_BINDING = JSON.stringify({ path: root, dev: String(stats.dev), ino: String(stats.ino) });
  return () => {
    const left = readdirSync(root).filter((name) => name !== "verification").length
      + (existsSync(join(root, "verification")) ? readdirSync(join(root, "verification")).length : 0);
    if (left) console.warn(`本轮测试有 ${left} 项临时数据没有自行清理，已随临时根目录 ${root} 一并删除`);
    rmSync(root, { recursive: true, force: true });
    delete process.env.ONE_COMPANY_TEST_PARENT_BINDING;
  };
}
