import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectIndexHost } from "../daemon/project-index-host.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function world() {
  const fixture = await createPmIntakeFixture(); cleanups.push(() => fixture.cleanup());
  const archiveRisk = vi.fn(async () => {});
  const host = new ProjectIndexHost({ repoId: fixture.repoId, dataRoot: fixture.dataRoot, repositoryRoot: fixture.repositoryRoot, beforeArchiveRisk: archiveRisk });
  cleanups.push(() => host.close());
  const root = fixture.repositoryRoot;
  const search = async (text: string, caller = "c") => JSON.stringify(await host.query(caller, { action: "search", text }));
  return { fixture, host, root, archiveRisk, search };
}

test("未初始化时查询报 not_initialized；init 后可查，结果标注索引代次", async () => {
  const w = await world();
  await writeFile(join(w.root, "jump.ts"), "export const 跳跃高度 = 3;\n");
  await expect(w.host.query("c", { action: "facts" })).rejects.toMatchObject({ code: "not_initialized" });
  expect(await w.host.status()).toMatchObject({ managed: false });
  await w.host.init();
  expect(await w.host.status()).toMatchObject({ managed: true });
  const page = await w.host.query("c", { action: "search", text: "跳跃高度" });
  expect(page.generation).toBeGreaterThan(0);
  expect(JSON.stringify(page)).toContain("jump.ts");
});

test("每次查询前对账：外部改动（含大小与修改时间不变）在下一次查询即可见，无变化时不重建", async () => {
  const w = await world();
  const file = join(w.root, "speed.ts");
  await writeFile(file, "export const 速度甲 = 1;\n");
  await w.host.init();
  expect(await w.search("速度甲")).toContain("speed.ts");
  const generation = (await w.host.query("c", { action: "facts" })).generation;
  expect((await w.host.query("d", { action: "facts" })).generation).toBe(generation);

  const before = await stat(file);
  await writeFile(file, "export const 速度乙 = 1;\n");
  await utimes(file, before.atime, before.mtime);
  expect((await stat(file)).size).toBe(before.size);
  expect(await w.search("速度乙")).toContain("speed.ts");
  expect(await w.search("速度甲")).not.toContain("speed.ts");
  expect(w.archiveRisk).toHaveBeenCalled();
});

test("被 Git 忽略的文件不进入索引；切换分支后查询自动按当前分支对账", async () => {
  const w = await world();
  await writeFile(join(w.root, ".gitignore"), "*.local.ts\n");
  await writeFile(join(w.root, "secret.local.ts"), "export const 忽略标记 = 1;\n");
  await writeFile(join(w.root, "main.ts"), "export const 主干标记 = 1;\n");
  await w.host.init();
  expect(await w.search("忽略标记")).not.toContain("secret.local.ts");
  expect(await w.search("主干标记")).toContain("main.ts");

  execFileSync("git", ["checkout", "-q", "-b", "feature-x"], { cwd: w.root });
  await writeFile(join(w.root, "feature.ts"), "export const 分支标记 = 1;\n");
  const page = await w.host.query("c", { action: "search", text: "分支标记" });
  expect(page.workspace.branch).toBe("refs/heads/feature-x");
  expect(JSON.stringify(page)).toContain("feature.ts");
});

test("spec 文件无效时查询照常返回一页，以 specStatus/indexStatus 标出无效，不报整体不可用", async () => {
  const w = await world();
  await writeFile(join(w.root, "a.ts"), "export const 标记 = 1;\n");
  await mkdir(join(w.root, "docs", "spec"), { recursive: true });
  await writeFile(join(w.root, "docs", "spec", "bad.rules.json"), "{ not json");
  await w.host.init();
  const page = await w.host.query("c", { action: "search", text: "标记" });
  expect(page).toMatchObject({ specStatus: "invalid", indexStatus: "invalid" });
});
