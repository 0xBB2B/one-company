import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codeFingerprint, installedPackageRoot } from "../src/core/host/code-fingerprint.ts";
import { repoDisplayName } from "../src/core/storage/identity.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function manifest(version = "1.0.0"): string {
  return JSON.stringify({ name: "x", version });
}

async function makeInstall(): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot(), "fp-"));
  created.push(root);
  await mkdir(join(root, "src", "sub"), { recursive: true });
  await mkdir(join(root, "resources", "x"), { recursive: true });
  await mkdir(join(root, "role-rules"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "package.json"), manifest());
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "sub", "b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "resources", "x", "p.wasm"), "wasm-bytes\n");
  await writeFile(join(root, "README.md"), "readme\n");
  await writeFile(join(root, "role-rules", "pm.md"), "pm\n");
  await writeFile(join(root, "tests", "t.test.ts"), "test\n");
  return root;
}

describe("代码指纹", () => {
  test("不改文件时连算两次相同，且是 64 位十六进制串", async () => {
    const root = await makeInstall();
    const first = await codeFingerprint(root);
    const second = await codeFingerprint(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  test("改 src 下文件内容指纹变化，改回后恢复原值", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    const file = join(root, "src", "sub", "b.ts");
    const content = await readFile(file, "utf8");
    await writeFile(file, content.replace("2", "3"));
    expect(await codeFingerprint(root)).not.toBe(original);
    await writeFile(file, content);
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("src 下新增文件指纹变化", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "src", "new.ts"), "x\n");
    expect(await codeFingerprint(root)).not.toBe(original);
  });

  test("删除 resources 下的文件指纹变化", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await rm(join(root, "resources", "x", "p.wasm"));
    expect(await codeFingerprint(root)).not.toBe(original);
  });

  test("文件改名但内容不变，指纹变化", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await rename(join(root, "src", "a.ts"), join(root, "src", "c.ts"));
    expect(await codeFingerprint(root)).not.toBe(original);
  });

  test("改 resources 下文件内容指纹变化", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "resources", "x", "p.wasm"), "other-bytes\n");
    expect(await codeFingerprint(root)).not.toBe(original);
  });

  test("改 package.json 内容指纹变化", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "package.json"), manifest("1.0.1"));
    expect(await codeFingerprint(root)).not.toBe(original);
  });

  test("只改 README.md，指纹不变", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "README.md"), "changed\n");
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("只改 role-rules/pm.md，指纹不变", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "role-rules", "pm.md"), "changed\n");
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("只改 tests 下的文件，指纹不变", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await writeFile(join(root, "tests", "t.test.ts"), "changed\n");
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("新增 docs/x.md，指纹不变", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "x.md"), "doc\n");
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("新增 skills/s.md，指纹不变", async () => {
    const root = await makeInstall();
    const original = await codeFingerprint(root);
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "skills", "s.md"), "skill\n");
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("没有 resources 目录时不抛错，之后补建空的 resources 目录指纹不变", async () => {
    const root = await makeInstall();
    await rm(join(root, "resources"), { recursive: true });
    const original = await codeFingerprint(root);
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    await mkdir(join(root, "resources"));
    expect(await codeFingerprint(root)).toBe(original);
  });

  test("没有 package.json 时拒绝", async () => {
    const root = await makeInstall();
    await rm(join(root, "package.json"));
    await expect(codeFingerprint(root)).rejects.toThrow();
  });
});

describe("one-company 自身安装目录", () => {
  test("installedPackageRoot 下的 package.json 名字是 @0xbb2b/one-company", async () => {
    const manifestText = await readFile(join(installedPackageRoot(), "package.json"), "utf8");
    expect((JSON.parse(manifestText) as { name: string }).name).toBe("@0xbb2b/one-company");
  });

  test("对仓库本身算指纹在 2 秒内返回 64 位十六进制串", async () => {
    const started = Date.now();
    const fingerprint = await codeFingerprint(installedPackageRoot());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("项目目录名", () => {
  test("末段是 .git 时取上一级目录名", () => {
    expect(repoDisplayName("/x/企微BOT/.git")).toBe("企微BOT");
    expect(repoDisplayName("/a/b/main-repo/.git")).toBe("main-repo");
  });

  test("裸仓库取末段并去掉结尾的 .git", () => {
    expect(repoDisplayName("/x/repo.git")).toBe("repo");
  });
});
