import { afterEach, describe, expect, test } from "vitest";
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/core/storage/store.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  return root;
}

async function linked() {
  const root = await makeRoot();
  const real = join(root, "real.md");
  const link = join(root, "link.md");
  await writeFile(real, "原内容\n");
  await symlink(real, link);
  return { real, link };
}

describe("writeFileAtomic 遇到软链接", () => {
  test("传 followSymlink：内容写进真实文件，软链接保留并仍指向原处", async () => {
    const { real, link } = await linked();
    await writeFileAtomic(link, "新内容\n", { followSymlink: true });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(real);
    expect(await readFile(real, "utf8")).toBe("新内容\n");
  });

  test("不传选项：软链接被换成普通文件，原来指向的文件内容不变", async () => {
    const { real, link } = await linked();
    await writeFileAtomic(link, "新内容\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, "utf8")).toBe("新内容\n");
    expect(await readFile(real, "utf8")).toBe("原内容\n");
  });

  test("目标不存在：传 followSymlink 也新建普通文件", async () => {
    const path = join(await makeRoot(), "new.md");
    await writeFileAtomic(path, "内容\n", { followSymlink: true });
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, "utf8")).toBe("内容\n");
  });

  test("目标不存在：不传选项新建普通文件", async () => {
    const path = join(await makeRoot(), "new.md");
    await writeFileAtomic(path, "内容\n");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, "utf8")).toBe("内容\n");
  });

  test("悬空软链接：传 followSymlink 把软链接换成普通文件，内容为新内容", async () => {
    const root = await makeRoot();
    const link = join(root, "link.md");
    await symlink(join(root, "missing.md"), link);
    await writeFileAtomic(link, "新内容\n", { followSymlink: true });
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(link, "utf8")).toBe("新内容\n");
  });
});
