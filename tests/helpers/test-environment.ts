import { chmodSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { cleanupTemporaryRoot, temporaryRoot } from "./temporary-root.ts";

const root = temporaryRoot();
const verificationRoot = join(root, "verification");
process.env.TMPDIR = verificationRoot;
process.env.GIT_CEILING_DIRECTORIES = root.replace(/\/$/, "");
mkdirSync(verificationRoot, { recursive: true, mode: 0o700 });
chmodSync(verificationRoot, 0o700);
afterAll(() => {
  try {
    rmdirSync(verificationRoot);
  } catch {
    // 非空目录保留，用于暴露未收尾的测试数据。
  }
  cleanupTemporaryRoot();
});
