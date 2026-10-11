import { afterEach, expect, test } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveRealRepoPath } from "../runtime/write-guard.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("真实路径解析保留仓库内路径，拒绝经符号链接或绝对路径逃逸仓库", async () => {
  const repo = await createRepoFixture(); cleanup.push(() => removeRepoFixture(repo));
  const home = await createTempHome(); cleanup.push(() => removeTempHome(home));
  await mkdir(join(repo.root, "allowed"));
  await mkdir(join(repo.root, "shared-dir"));
  expect(await resolveRealRepoPath(repo.root, join(repo.root, "allowed/new.txt"), false)).toBe("allowed/new.txt");
  expect(await resolveRealRepoPath(repo.root, join(repo.root, "allowed/deep/new/"), true)).toBe("allowed/deep/new/");
  await symlink(join(repo.root, "shared-dir"), join(repo.root, "allowed/link"));
  expect(await resolveRealRepoPath(repo.root, join(repo.root, "allowed/link/new.txt"), false)).toBe("shared-dir/new.txt");
  await symlink(home.home, join(repo.root, "allowed/outside"));
  await expect(resolveRealRepoPath(repo.root, join(repo.root, "allowed/outside/new.txt"), false)).rejects.toThrow("路径逃逸仓库边界");
  await expect(resolveRealRepoPath(repo.root, join(home.home, "outside.txt"), false)).rejects.toThrow("路径逃逸仓库边界");
  await expect(resolveRealRepoPath(repo.root, repo.root, true)).rejects.toThrow("路径逃逸仓库边界");
});
