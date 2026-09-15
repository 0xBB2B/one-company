import { afterEach, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionUrl = pathToFileURL(fileURLToPath(new URL("../../extensions/index.ts", import.meta.url))).href;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("启用前Git gate失败时不注册任何工具、事件、命令或daemon入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-company-git-startup-gate-"));
  roots.push(root);
  const emptyBin = join(root, "empty-bin"), home = join(root, "home"), cwd = join(root, "cwd");
  await mkdir(emptyBin, { mode: 0o755 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o755 });
  await chmod(root, 0o755);
  const script = `
const extension = await import(${JSON.stringify(extensionUrl)});
let accesses = 0;
const pi = new Proxy({}, { get() { accesses += 1; return () => { accesses += 1; }; } });
let code;
try { extension.default(pi); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, accesses }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: { ...process.env, PATH: emptyBin, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ code: "git_not_found", accesses: 0 });
});
