import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// 默认不跟随软链接，防止写入穿到目录外
export async function writeFileAtomic(originalPath: string, content: string, options?: { followSymlink?: boolean }): Promise<void> {
  const path = options?.followSymlink ? await realpath(originalPath).catch(() => originalPath) : originalPath;
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const mode = await lstat(path).then((stats) => stats.isFile() ? stats.mode & 0o777 : 0o600, () => 0o600);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.chmod(mode);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  const directory = await open(dir, "r");
  try { await directory.sync(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error; }
  finally { await directory.close(); }
}

export function writeFileAtomicSync(originalPath: string, content: string, options?: { followSymlink?: boolean }): void {
  let path = originalPath;
  if (options?.followSymlink) { try { path = realpathSync(originalPath); } catch {} }
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let mode = 0o600;
  try { const stats = lstatSync(path); if (stats.isFile()) mode = stats.mode & 0o777; } catch {}
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  const directory = openSync(dir, "r");
  try { fsyncSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error; }
  finally { closeSync(directory); }
}
