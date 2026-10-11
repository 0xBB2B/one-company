import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../runtime/git-prerequisite.mjs", import.meta.url));

test("preinstall 检查：PATH 上没有 git 时非零退出并提示，有 git 时通过", async () => {
  const emptyBin = await mkdtemp(join(tmpdir(), "one-company-no-git-"));
  try {
    const missing = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8", env: { PATH: emptyBin } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("必须预先安装Git并确保PATH可用");
  } finally {
    await rm(emptyBin, { recursive: true, force: true });
  }
  const present = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  expect(present.status).toBe(0);
  expect(present.stdout).toMatch(/^Git 前置检查通过：git version /u);
});
