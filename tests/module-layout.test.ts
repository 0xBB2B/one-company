import { describe, expect, test } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(PACKAGE_ROOT, name), "utf8"));
}

describe("源码目录布局", () => {
  test.each(["runtime", "extensions", "daemon"])("仓库根上不存在 %s 目录", async (name) => {
    expect(await pathExists(join(PACKAGE_ROOT, name))).toBe(false);
  });

  test("src/ 下的目录恰好是 app、core、modules", async () => {
    const entries = await readdir(join(PACKAGE_ROOT, "src"), { withFileTypes: true }).catch(() => []);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["app", "core", "modules"]);
    expect(entries.every((entry) => entry.isDirectory())).toBe(true);
  });

  test.each([
    "src/modules/delivery/git-delivery.ts",
    "src/modules/delivery/git-delivery-extension.ts",
    "src/modules/settings/settings-page-ui.ts",
    "src/core/exec/tool-failure.ts",
    "src/core/exec/git-read.ts",
    "src/modules/requirement/requirement-state.ts",
    "src/core/host/extension-lifecycle.ts",
    "src/app/extension/index.ts",
    "src/app/daemon/bootstrap.mjs",
  ])("文件 %s 存在", async (path) => {
    expect(await pathExists(join(PACKAGE_ROOT, path))).toBe(true);
  });
});

describe("package.json 与 tsconfig.json 指向新目录", () => {
  test("pi.extensions 严格等于新入口", async () => {
    const pkg = await readJson("package.json");
    expect(pkg.pi?.extensions).toEqual(["./src/app/extension/index.ts"]);
  });

  test("files 含 src，不含 runtime、daemon、extensions", async () => {
    const pkg = await readJson("package.json");
    expect(pkg.files).toContain("src");
    for (const old of ["runtime", "daemon", "extensions"]) expect(pkg.files).not.toContain(old);
  });

  test("preinstall 脚本指向新路径的 git 前置检查", async () => {
    const pkg = await readJson("package.json");
    expect(pkg.scripts?.preinstall).toBe("node src/core/exec/git-prerequisite.mjs --check");
  });

  test("tsconfig include 检查 src，不再含旧目录", async () => {
    const tsconfig = await readJson("tsconfig.json");
    expect(tsconfig.include).toContain("src/**/*.ts");
    for (const old of ["runtime/**/*.ts", "daemon/**/*.ts", "extensions/**/*.ts"]) expect(tsconfig.include).not.toContain(old);
  });
});
