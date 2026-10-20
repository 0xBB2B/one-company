import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 交稿后程序会用 open 在浏览器里打开原型；换成只记下路径的脚本，免得跑验收时弹出浏览器。 */
export async function stubOpen() {
  const dir = await mkdtemp(join(tmpdir(), "pt-open-"));
  await writeFile(join(dir, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${join(dir, "opened.txt")}'\n`);
  await chmod(join(dir, "open"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  return async () => { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); };
}
