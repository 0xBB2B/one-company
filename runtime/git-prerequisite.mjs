import { spawnSync } from "node:child_process";

const REQUIRED_MESSAGE = "必须预先安装Git并确保PATH可用";

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
  process.stderr.write("用法: node runtime/git-prerequisite.mjs --check\n");
  process.exitCode = 1;
} else {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    process.stderr.write(`Git 前置检查失败：${REQUIRED_MESSAGE}。\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Git 前置检查通过：${result.stdout.trim()}\n`);
  }
}
