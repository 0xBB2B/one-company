import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { cleanupTemporaryRoot, isTemporaryRootManaged, temporaryRoot } from "./temporary-root.ts";

function validateManagedVerificationRoot(path: string): void {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(path) !== path) {
    throw new Error("managed verification root must be a canonical regular directory");
  }
  if (typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {
    throw new Error("managed verification root must be owned by the current uid");
  }
  if ((stats.mode & 0o7777n) !== 0o700n) {
    throw new Error("managed verification root must have mode 0700");
  }
}

const root = temporaryRoot();
const managed = isTemporaryRootManaged();
const verificationRoot = join(root, "verification");
if (managed) {
  try {
    validateManagedVerificationRoot(verificationRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(verificationRoot, { mode: 0o700 });
    validateManagedVerificationRoot(verificationRoot);
  }
  if (temporaryRoot() !== root) throw new Error("managed temporary root identity changed during setup");
} else {
  mkdirSync(verificationRoot, { recursive: true, mode: 0o700 });
  chmodSync(verificationRoot, 0o700);
}
process.env.TMPDIR = verificationRoot;
process.env.GIT_CEILING_DIRECTORIES = root.replace(/\/$/, "");
afterAll(() => {
  if (!managed) {
    try {
      rmdirSync(verificationRoot);
    } catch {
      // 非空目录保留，用于暴露未收尾的测试数据。
    }
  }
  cleanupTemporaryRoot();
});
