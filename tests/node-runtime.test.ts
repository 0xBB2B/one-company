import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);

test("测试运行于 Node，子进程使用相同可执行文件和真实 node:sqlite", async () => {
  expect(process.release.name).toBe("node");
  expect("Bun" in globalThis).toBe(false);
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (42);');
  console.log(JSON.stringify({ executable: process.execPath, version: process.version, arch: process.arch, value: db.prepare('SELECT value FROM probe').get().value }));
} finally { db.close(); }
`]);
  expect(JSON.parse(stdout)).toEqual({ executable: process.execPath, version: process.version, arch: process.arch, value: 42 });
});

test("pnpm版本、Node测试入口与Node类型显式声明，Bun配置不作为备用入口", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  expect(pkg.packageManager).toBe("pnpm@11.7.0");
  expect(pkg.scripts.test).toBe("vitest run --exclude 'tests/integration/**' --exclude 'tests/installation/**' --exclude 'tests/acceptance/**'");
  expect(pkg.scripts["test:integration"]).toBe("vitest run tests/integration");
  expect(pkg.scripts["test:installation"]).toBe("vitest run tests/installation");
  expect(pkg.scripts["test:acceptance"]).toBe("vitest run tests/acceptance");
  expect(pkg.devDependencies.vitest).toBe("4.1.6");
  expect(pkg.devDependencies["@types/node"]).toBeDefined();
  expect(pkg.devDependencies["@types/bun"]).toBeUndefined();
  expect((await stat(new URL("pnpm-lock.yaml", root))).isFile()).toBe(true);
  for (const name of ["bun.lock", "bunfig.toml"]) {
    await expect(stat(new URL(name, root))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test("Node原生类型剥离可加载生产数据库模块，不依赖测试转换器", async () => {
  const module = new URL("src/core/storage/database.ts", root).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
import { uuidv7, UUID_V7_PATTERN } from ${JSON.stringify(module)};
if (!UUID_V7_PATTERN.test(uuidv7())) process.exit(1);
console.log(process.release.name);
`], { cwd: fileURLToPath(root) });
  expect(stdout.trim()).toBe("node");
});
