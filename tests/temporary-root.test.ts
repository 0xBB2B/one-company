import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { daemonSocketPath } from "../src/core/storage/identity.ts";
import { socketPathByteLimit } from "../src/core/host/daemon-probe.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);

test("共享临时根路径短、同进程稳定且目录权限为 0700", async () => {
  const root = temporaryRoot();
  expect(temporaryRoot()).toBe(root);
  expect(root).toBe(await realpath(root));
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect(process.env.GIT_CEILING_DIRECTORIES).toBe(root);
  expect(process.env.TMPDIR).toBe(join(root, "verification"));
  expect((await stat(process.env.TMPDIR!)).mode & 0o777).toBe(0o700);

  const dataRoot = await mkdtemp(join(root, "d"));
  try {
    const socketPath = daemonSocketPath(dataRoot, "a".repeat(64));
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(socketPathByteLimit());
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("独立进程使用不同临时根并在自身退出时清理", async () => {
  const parentRoot = temporaryRoot();
  const moduleUrl = new URL("./helpers/temporary-root.ts", import.meta.url).href;
  const script = `
    import { statSync } from "node:fs";
    import { temporaryRoot } from ${JSON.stringify(moduleUrl)};
    const root = temporaryRoot();
    process.stdout.write(JSON.stringify({ root, mode: statSync(root).mode & 0o777 }));
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env },
  });
  const child = JSON.parse(stdout) as { root: string; mode: number };

  expect(child.root).not.toBe(parentRoot);
  expect(child.mode).toBe(0o700);
  await expect(stat(child.root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(parentRoot)).resolves.toBeDefined();
});
