import { dirname } from "node:path";

/**
 * 验证命令只限写入：禁写路径由调用方给出，可按需放行本次输出目录；读取、网络与环境变量不限。
 * 沙箱规则后写者优先，故先禁后放。
 */
export function writeGuardLaunch(command: string, guard: { deniedWrites: string[]; allowedWrites: string[]; deniedSockets: string[]; scratch: string }) {
  if (process.platform !== "darwin") throw new Error("此平台尚无可用的命令文件隔离后端，已拒绝不受保护的执行");
  const subpaths = (paths: string[]) => paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
  // 规则按操作当时的路径匹配：上级目录若能改名，受保护目录就能换个路径写入，故一并禁改各级上级目录本身
  const ancestors = new Set<string>();
  for (const path of guard.deniedWrites) for (let parent = dirname(path); ; parent = dirname(parent)) {
    ancestors.add(parent);
    if (parent === dirname(parent)) break;
  }
  const profile = [
    "(version 1)", "(allow default)",
    ...guard.deniedSockets.map((path) => `(deny network-outbound (remote unix-socket (subpath ${JSON.stringify(path)})))`),
    `(deny file-write* ${subpaths(guard.deniedWrites)} ${[...ancestors].map((path) => `(literal ${JSON.stringify(path)})`).join(" ")})`,
    ...(guard.allowedWrites.length ? [`(allow file-write* ${subpaths(guard.allowedWrites)})`] : []),
  ].join("\n");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command], env: { ...env, GIT_OPTIONAL_LOCKS: "0", TMPDIR: guard.scratch, TMP: guard.scratch, TEMP: guard.scratch } };
}
