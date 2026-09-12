import { afterEach, expect, test, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const renameRace = vi.hoisted(() => ({
  enabled: false,
  targetPath: "",
  outsidePath: "",
}));

const permissionRace = vi.hoisted(() => ({
  enabled: false,
  targetPath: "",
  outsidePath: "",
  movedPath: "",
  kind: "file" as "file" | "dir",
  parentPath: "",
  occurrence: 1,
  seen: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
      if (permissionRace.enabled && permissionRace.parentPath && String(path) === permissionRace.targetPath) {
        permissionRace.seen += 1;
        if (permissionRace.seen === permissionRace.occurrence) {
          permissionRace.enabled = false;
          await actual.rename(permissionRace.parentPath, permissionRace.movedPath);
          await actual.symlink(permissionRace.outsidePath, permissionRace.parentPath, "dir");
        }
      }
      const stats = await actual.lstat(path, options as never);
      if (permissionRace.enabled && !permissionRace.parentPath && String(path) === permissionRace.targetPath) {
        permissionRace.seen += 1;
        if (permissionRace.seen === permissionRace.occurrence) {
          permissionRace.enabled = false;
          await actual.rename(path, permissionRace.movedPath);
          await actual.symlink(permissionRace.outsidePath, path, permissionRace.kind);
        }
      }
      return stats;
    },
    rename: async (oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) => {
      await actual.rename(oldPath, newPath);
      if (renameRace.enabled && String(newPath) === renameRace.targetPath) {
        renameRace.enabled = false;
        await actual.rename(newPath, `${String(newPath)}.owned-by-storage`);
        await actual.symlink(renameRace.outsidePath, newPath);
      }
    },
  };
});

const { create, save, ProdStorageError } = await import("../runtime/prod-storage.ts");

const GIT = "/usr/bin/git";
const REQUIREMENT_ID = "01941f29-7c00-7000-8000-000000000002";
const roots: string[] = [];

afterEach(async () => {
  renameRace.enabled = false;
  renameRace.targetPath = "";
  renameRace.outsidePath = "";
  permissionRace.enabled = false;
  permissionRace.targetPath = "";
  permissionRace.outsidePath = "";
  permissionRace.movedPath = "";
  permissionRace.kind = "file";
  permissionRace.parentPath = "";
  permissionRace.occurrence = 1;
  permissionRace.seen = 0;
  for (const root of roots.splice(0).reverse()) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("rename 后路径被替换成链接时不会沿路径 chmod 外部目标", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "prod-storage-link-race-"));
  roots.push(root);
  const business = join(root, "business");
  const outside = join(root, "outside-target");
  await mkdir(business, { mode: 0o700 });
  await writeFile(outside, "外部文件", { mode: 0o644 });
  await chmod(outside, 0o644);

  const dataRoot = join(root, "private");
  const requirementRoot = join(dataRoot, "repos", "repo-1", "requirements", REQUIREMENT_ID);
  renameRace.targetPath = join(requirementRoot, "prod.md");
  renameRace.outsidePath = outside;
  renameRace.enabled = true;

  const result = create({
    dataRoot,
    repoId: "repo-1",
    requirementId: REQUIREMENT_ID,
    gitExecutable: GIT,
    repositoryRoot: business,
    worktreeRoots: [],
    authorize: () => true,
    operationId: "rename-link-race",
    expectedParent: null,
    bytes: Buffer.from("自有正文"),
  });
  await expect(result).rejects.toMatchObject({
    name: "ProdStorageError",
    code: "working_copy_changed",
  });
  expect(ProdStorageError).toBeTypeOf("function");

  expect((await stat(outside)).mode & 0o777).toBe(0o644);
  expect(await readFile(outside, "utf8")).toBe("外部文件");
  expect((await lstat(renameRace.targetPath)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(requirementRoot, "prod.md.owned-by-storage"), "utf8")).toBe("自有正文");
});

test(".git/config 在 lstat 后被替换成链接时不会修改外部文件权限或字节", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "prod-storage-git-permission-race-"));
  roots.push(root);
  const business = join(root, "business");
  const outside = join(root, "outside-config");
  await mkdir(business, { mode: 0o700 });
  await writeFile(outside, "外部配置字节", { mode: 0o644 });
  await chmod(outside, 0o644);

  const dataRoot = join(root, "private");
  const requirementRoot = join(dataRoot, "repos", "repo-1", "requirements", REQUIREMENT_ID);
  const initial = await create({
    dataRoot,
    repoId: "repo-1",
    requirementId: REQUIREMENT_ID,
    gitExecutable: GIT,
    repositoryRoot: business,
    worktreeRoots: [],
    authorize: () => true,
    operationId: "permission-race-create",
    expectedParent: null,
    bytes: Buffer.from("第一版"),
  });

  const configPath = join(requirementRoot, ".git", "config");
  permissionRace.targetPath = configPath;
  permissionRace.outsidePath = outside;
  permissionRace.movedPath = join(root, "owned-config");
  permissionRace.kind = "file";
  permissionRace.occurrence = 2;
  permissionRace.seen = 0;
  permissionRace.enabled = true;

  await expect(save({
    dataRoot,
    repoId: "repo-1",
    requirementId: REQUIREMENT_ID,
    gitExecutable: GIT,
    repositoryRoot: business,
    worktreeRoots: [],
    authorize: () => true,
    action: "updateDraft",
    operationId: "permission-race-save",
    expectedParent: initial.commit,
    bytes: Buffer.from("第二版"),
  })).rejects.toMatchObject({ name: "ProdStorageError", code: "git_invalid" });

  expect(permissionRace.enabled).toBe(false);
  expect((await stat(outside)).mode & 0o777).toBe(0o644);
  expect(await readFile(outside, "utf8")).toBe("外部配置字节");
  expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
});

test("遍历子文件前父目录被替换时不修改替代目录中的文件", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "prod-parent-identity-"));
  roots.push(root);
  const business = join(root, "business");
  const outside = join(root, "outside-directory");
  await mkdir(business, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  const config = { dataRoot: join(root, "private"), repoId: "repo-1", requirementId: REQUIREMENT_ID,
    gitExecutable: GIT, repositoryRoot: business, worktreeRoots: [], authorize: () => true };
  const initial = await create({ ...config, operationId: "parent-create", expectedParent: null, bytes: Buffer.from("第一版") });
  const gitDir = join(initial.repositoryRoot, ".git");
  const original = await readFile(join(gitDir, "config"));
  const outsideConfig = join(outside, "config");
  await writeFile(outsideConfig, original, { mode: 0o644 });
  await chmod(outsideConfig, 0o644);
  permissionRace.targetPath = join(gitDir, "config");
  permissionRace.parentPath = gitDir;
  permissionRace.outsidePath = outside;
  permissionRace.movedPath = join(root, "owned-git");
  permissionRace.occurrence = 2;
  permissionRace.enabled = true;
  await expect(save({ ...config, action: "updateDraft", operationId: "parent-save",
    expectedParent: initial.commit, bytes: Buffer.from("第二版") })).rejects.toMatchObject({ code: "git_invalid" });
  expect(permissionRace.enabled).toBe(false);
  expect((await stat(outsideConfig)).mode & 0o777).toBe(0o644);
  expect(await readFile(outsideConfig)).toEqual(original);
});

test("dataRoot 目录在 lstat 后被替换成链接时不会修改外部目录权限或内容", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "prod-storage-directory-permission-race-"));
  roots.push(root);
  const business = join(root, "business");
  const dataRoot = join(root, "private");
  const outside = join(root, "outside-directory");
  const marker = join(outside, "marker.txt");
  await mkdir(business, { mode: 0o700 });
  await mkdir(dataRoot, { mode: 0o755 });
  await chmod(dataRoot, 0o755);
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await writeFile(marker, "外部目录内容", { mode: 0o644 });
  await chmod(marker, 0o644);

  permissionRace.targetPath = dataRoot;
  permissionRace.outsidePath = outside;
  permissionRace.movedPath = join(root, "owned-data-root");
  permissionRace.kind = "dir";
  permissionRace.occurrence = 2;
  permissionRace.seen = 0;
  permissionRace.enabled = true;

  await expect(create({
    dataRoot,
    repoId: "repo-1",
    requirementId: REQUIREMENT_ID,
    gitExecutable: GIT,
    repositoryRoot: business,
    worktreeRoots: [],
    authorize: () => true,
    operationId: "directory-permission-race",
    expectedParent: null,
    bytes: Buffer.from("正文"),
  })).rejects.toMatchObject({ name: "ProdStorageError", code: "unsafe_path" });

  expect(permissionRace.enabled).toBe(false);
  expect((await stat(outside)).mode & 0o777).toBe(0o755);
  expect((await stat(marker)).mode & 0o777).toBe(0o644);
  expect(await readFile(marker, "utf8")).toBe("外部目录内容");
  expect((await lstat(dataRoot)).isSymbolicLink()).toBe(true);
});
