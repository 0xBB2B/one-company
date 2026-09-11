import { chmodSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_PROPERTY = "__piCompanyTestTemporaryRoot";
type TestProcess = NodeJS.Process & { [ROOT_PROPERTY]?: string };

export function cleanupTemporaryRoot(): void {
  const testProcess = process as TestProcess;
  const root = testProcess[ROOT_PROPERTY];
  if (!root) return;
  try {
    rmdirSync(root);
    delete testProcess[ROOT_PROPERTY];
  } catch {
    // 非空目录保留，用于暴露未收尾的夹具或子进程。
  }
}

export function temporaryRoot(): string {
  const testProcess = process as TestProcess;
  if (testProcess[ROOT_PROPERTY]) return testProcess[ROOT_PROPERTY];

  const systemRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = realpathSync(mkdtempSync(join(systemRoot, "pi-t-")));
  chmodSync(root, 0o700);
  testProcess[ROOT_PROPERTY] = root;
  process.once("exit", cleanupTemporaryRoot);
  return root;
}
