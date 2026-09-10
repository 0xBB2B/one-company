import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface CommandBoundary {
  readRoots: string[];
  writeRoots: string[];
  deniedReads: string[];
  deniedWrites: string[];
  scratch: string;
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return resolve(await canonical(dirname(path)), path.split("/").at(-1)!); }
}

export async function commandBoundary(input: { cwd: string; writePaths: string[]; dataRoot: string; foreignPaths: string[] }): Promise<CommandBoundary> {
  const root = await realpath(input.cwd);
  const cache = await canonical(join(root, ".pi-company", ".cache"));
  if (!cache.startsWith(`${root}${sep}`)) throw new Error("命令缓存路径越出仓库边界");
  await mkdir(cache, { recursive: true });
  try { await writeFile(join(cache, ".gitignore"), "*\n", { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const scratch = join(cache, "commands", randomUUID());
  await mkdir(scratch, { recursive: true });
  const readRoots = [input.cwd, dirname(await realpath(process.execPath)), join(homedir(), ".gitconfig")];
  try { readRoots.push(await realpath(join(input.cwd, "node_modules"))); } catch {}
  return {
    readRoots: [...new Set([...readRoots, ...await Promise.all(readRoots.map(canonical))])],
    writeRoots: await Promise.all([...input.writePaths.map((path) => resolve(input.cwd, path)), scratch].map(canonical)),
    deniedReads: [await canonical(input.dataRoot)],
    deniedWrites: await Promise.all([input.dataRoot, ...input.foreignPaths.map((path) => resolve(input.cwd, path))].map(canonical)),
    scratch: await canonical(scratch),
  };
}

export function sandboxLaunch(command: string, boundary: CommandBoundary, executable?: { path: string; args: string[] }) {
  if (process.platform !== "darwin") throw new Error("此平台尚无可用的命令文件隔离后端，已拒绝不受保护的执行");
  const subpaths = (paths: string[]) => paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
  const ancestors = new Set<string>();
  for (const root of boundary.readRoots) {
    for (let path = dirname(root); ; path = dirname(path)) {
      ancestors.add(path);
      if (path === dirname(path)) break;
    }
  }
  const profile = [
    "(version 1)", "(allow default)",
    `(deny file-read-data (require-all (require-any ${subpaths(["/Users", "/private/tmp", "/private/var/folders", "/Volumes", "/home", "/root", "/mnt", "/media"])}) (require-not (require-any ${subpaths(boundary.readRoots)} ${[...ancestors].map((path) => `(literal ${JSON.stringify(path)})`).join(" ")}))))`,
    "(deny file-write*)",
    ...boundary.deniedReads.map((path) => `(deny network-outbound (remote unix-socket (subpath ${JSON.stringify(path)})))`),
    `(allow file-write* ${subpaths(boundary.writeRoots)} (literal "/dev/null") (literal "/dev/tty"))`,
    ...(boundary.deniedReads.length ? [`(deny file-read* ${subpaths(boundary.deniedReads)})`] : []),
    ...(boundary.deniedWrites.length ? [`(deny file-write* ${subpaths(boundary.deniedWrites)})`] : []),
    ...(executable ? ["(deny network*)", `(deny process-exec (require-not (literal ${JSON.stringify(executable.path)})))`] : []),
  ].join("\n");
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "GIT_CEILING_DIRECTORIES"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { inheritEnv: false, command: "/usr/bin/sandbox-exec", args: ["-p", profile, ...(executable ? [executable.path, ...executable.args] : ["/bin/sh", "-c", command])], env: { ...env, GIT_OPTIONAL_LOCKS: "0", TMPDIR: boundary.scratch, TMP: boundary.scratch, TEMP: boundary.scratch } };
}
