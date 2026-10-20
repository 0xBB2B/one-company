import { afterEach, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { stubOpen } from "./acceptance/helpers/stub-open.ts";

const originalPath = process.env.PATH;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  process.env.PATH = originalPath;
});

async function activateStub(): Promise<() => Promise<void>> {
  const cleanup = await stubOpen();
  cleanups.push(cleanup);
  return cleanup;
}

const darwinOnly = test.skipIf(process.platform !== "darwin");

darwinOnly("stubOpen 生效后 PATH 里排第一的 open 是替身目录里的文件", async () => {
  await activateStub();
  const found = execFileSync("/bin/sh", ["-c", "command -v open"], { env: process.env }).toString().trim();
  expect(found).not.toBe("/usr/bin/open");
  expect(path.dirname(found)).toBe((process.env.PATH ?? "").split(path.delimiter)[0]);
});

darwinOnly("stubOpen 生效后执行 open 一个不存在的路径，退出码为 0", async () => {
  await activateStub();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("open", ["/tmp/pi-t-stub-open-not-exist/none.html"], { env: process.env, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", resolve);
  });
  expect(code).toBe(0);
});

darwinOnly("调用清理函数后 PATH 恢复原值且替身目录被删除", async () => {
  const before = process.env.PATH;
  const cleanup = await activateStub();
  const stubDir = (process.env.PATH ?? "").split(path.delimiter)[0];
  await access(stubDir);
  await cleanup();
  expect(process.env.PATH).toBe(before);
  await expect(access(stubDir)).rejects.toThrow();
});
