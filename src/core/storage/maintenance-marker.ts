import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function processMissing(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function processIdentity(pid: number): { state: "active"; identity: string } | { state: "missing" | "unknown" } {
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    }).trim();
    if (output) return { state: "active", identity: `pid:${pid}:lstart:${output}` };
  } catch { /* 无进程查询权限时仍不能把活进程判为已退出。 */ }
  return { state: processMissing(pid) ? "missing" : "unknown" };
}

interface MarkerFile { contents: string; inode: number; device: number }
export interface MarkerOwner { pid: number; processStartIdentity: string }
export interface ReadMarker extends MarkerFile { owner: MarkerOwner }
export type MarkerVerdict = "clearable" | "alive" | "undecidable";
export type StaleMarkerResult =
  | { cleared: true }
  | { cleared: false; reason: "alive"; pid: number; path: string }
  | { cleared: false; reason: "undecidable" | "unreadable"; path: string };

function readFile(path: string): MarkerFile | "missing" | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : undefined; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) return undefined;
    const contents = readFileSync(fd, "utf8"), after = fstatSync(fd), named = lstatSync(path, { throwIfNoEntry: false });
    if (!named || named.ino !== after.ino || named.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(contents) !== after.size) return undefined;
    return { contents, inode: after.ino, device: after.dev };
  } finally { closeSync(fd); }
}

function parseOwner(contents: string): MarkerOwner | undefined {
  let marker: { format?: unknown; state?: unknown; owner?: { pid?: unknown; processStartIdentity?: unknown } };
  try { marker = JSON.parse(contents); } catch { return undefined; }
  const pid = marker?.owner?.pid, identity = marker?.owner?.processStartIdentity;
  if (marker?.format !== "database-maintenance/v2" || marker.state !== "maintenance" || !Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof identity !== "string") return undefined;
  const lstart = `pid:${pid}:lstart:`, instance = `pid:${pid}:instance:`;
  if (!identity.startsWith(lstart) && !(identity.startsWith(instance) && UUID_V7.test(identity.slice(instance.length)))) return undefined;
  return { pid: pid as number, processStartIdentity: identity };
}

export function readMarkerOwner(path: string): ReadMarker | "missing" | undefined {
  const file = readFile(path);
  if (file === "missing" || file === undefined) return file;
  const owner = parseOwner(file.contents);
  return owner && { ...file, owner };
}

export function judgeMarkerOwner(owner: MarkerOwner): MarkerVerdict {
  if (owner.pid === process.pid) return "alive";
  if (owner.processStartIdentity.startsWith(`pid:${owner.pid}:instance:`)) return processMissing(owner.pid) ? "clearable" : "undecidable";
  const observed = processIdentity(owner.pid);
  if (observed.state === "unknown") return "undecidable";
  if (observed.state === "active" && observed.identity === owner.processStartIdentity) return "alive";
  return "clearable";
}

export function releaseStaleMaintenanceMarker(path: string): StaleMarkerResult {
  const read = readMarkerOwner(path);
  if (read === "missing") return { cleared: true };
  if (!read) return { cleared: false, reason: "unreadable", path };
  const verdict = judgeMarkerOwner(read.owner);
  if (verdict === "alive") return { cleared: false, reason: "alive", pid: read.owner.pid, path };
  if (verdict === "undecidable") return { cleared: false, reason: "undecidable", path };
  const temporary = `${path}.stale-${process.pid}-${randomUUID()}`;
  // 判断期间标记可能已被别人清掉并换成新的，rename 会改走别人正在用的文件
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current) return { cleared: true };
  if (current.ino !== read.inode || current.dev !== read.device) return { cleared: false, reason: "undecidable", path };
  try { renameSync(path, temporary); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { cleared: true } : { cleared: false, reason: "undecidable", path }; }
  const moved = readFile(temporary);
  if (moved && moved !== "missing" && moved.inode === read.inode && moved.device === read.device && moved.contents === read.contents) {
    unlinkSync(temporary);
    return { cleared: true };
  }
  // 改名抓到的是别人新放的标记：放回原名（原名已被占用就保持占用者不动），再删临时名。
  try { linkSync(temporary, path); } catch { /* 原名已有更新的标记 */ }
  try { unlinkSync(temporary); } catch { /* 临时名已不在 */ }
  return { cleared: false, reason: "undecidable", path };
}

export function staleMarkerMessage(result: Exclude<StaleMarkerResult, { cleared: true }>): string {
  if (result.reason === "alive") return `本机数据正在备份、恢复或对账（进程 ${result.pid}），等它结束再试`;
  const why = result.reason === "undecidable" ? "判断不了留标记的进程是否还在" : "维护标记读不出";
  return `${why}；确认没有别的窗口在备份、恢复或对账后，删除 ${result.path}`;
}
