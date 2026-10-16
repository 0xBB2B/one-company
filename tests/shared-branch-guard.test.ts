import { afterEach, describe, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotBranchState } from "../src/core/exec/branch-guard.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";

const repoFixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];

afterEach(async () => {
  for (const fixture of repoFixtures.splice(0)) await removeRepoFixture(fixture);
});

async function makeBranchedRepo(): Promise<Awaited<ReturnType<typeof createRepoFixture>>> {
  const repo = await createRepoFixture();
  repoFixtures.push(repo);
  await writeFile(join(repo.root, "occupied.txt"), "占用文件\n");
  await writeFile(join(repo.root, "own.txt"), "本任务文件\n");
  await runGit(["add", "occupied.txt", "own.txt"], repo.root);
  await runGit(["commit", "-m", "seed occupied/own"], repo.root);
  await writeFile(join(repo.root, "second.txt"), "第二次提交\n");
  await runGit(["add", "second.txt"], repo.root);
  await runGit(["commit", "-m", "second commit"], repo.root);
  await runGit(["branch", "other"], repo.root);
  return repo;
}

describe("snapshotBranchState：只读 head/branch，不受工作区体量拖累", () => {
  test("边界：工作区差异体量巨大（超出常规 maxBuffer）时仍返回 head/branch 且不抛", async () => {
    const repo = await makeBranchedRepo();

    const head = (await runGit(["rev-parse", "HEAD"], repo.root)).trim();
    await writeFile(join(repo.root, "own.txt"), Buffer.alloc(65 * 1024 * 1024, "x"));
    const result = await snapshotBranchState({ repoRoot: repo.root });

    expect(result.head).toBe(head);
    expect(result.branch).toBe("main");
  }, 15_000);
});
