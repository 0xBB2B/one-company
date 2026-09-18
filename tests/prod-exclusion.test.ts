import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedEntries, collectContentFingerprint, collectGitSnapshot } from "../runtime/git-snapshot.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";

const fixtures: Array<Awaited<ReturnType<typeof createRepoFixture>>> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await removeRepoFixture(fixture);
});

async function repoWithArchive() {
  const repo = await createRepoFixture();
  fixtures.push(repo);
  await mkdir(join(repo.root, "src"), { recursive: true });
  await mkdir(join(repo.root, "docs", "prod"), { recursive: true });
  await writeFile(join(repo.root, "src", "source.ts"), "export const source = 'v1';\n");
  await writeFile(join(repo.root, "docs", "prod", "archive.md"), "ARCHIVE-SECRET-v1\n");
  await runGit(["add", "src/source.ts", "docs/prod/archive.md"], repo.root);
  await runGit(["commit", "-m", "seed source and archive"], repo.root);
  return repo;
}

describe("M1-AC4/5：自有快照固定排除 docs/prod 正文", () => {
  test("没有本机 DB 时，未跟踪、已跟踪、暂存和已提交归档变化都不改变内容快照", async () => {
    const repo = await repoWithArchive();
    await expect(stat(join(repo.root, ".pi-company"))).rejects.toMatchObject({ code: "ENOENT" });

    const cleanGit = await collectGitSnapshot({ repoRoot: repo.root });
    const cleanContent = await collectContentFingerprint(repo.root);

    await mkdir(join(repo.root, "docs", "prod", "nested"), { recursive: true });
    await writeFile(join(repo.root, "docs", "prod", "nested", "untracked.md"), "UNTRACKED-SECRET-v1\n");
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).toBe(cleanContent);

    await writeFile(join(repo.root, "docs", "prod", "archive.md"), "ARCHIVE-SECRET-v2\n");
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).toBe(cleanContent);
    expect((await changedEntries(repo.root)).flatMap((entry) => entry.paths)).toContain("docs/prod/archive.md");

    await runGit(["add", "docs/prod/archive.md", "docs/prod/nested/untracked.md"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).toBe(cleanContent);

    await runGit(["commit", "-m", "archive only"], repo.root);
    const committed = await collectGitSnapshot({ repoRoot: repo.root });
    expect(committed.head).not.toBe(cleanGit.head);
    expect(committed.fingerprint).toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).toBe(cleanContent);

    await runGit(["rm", "docs/prod/archive.md"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).toBe(cleanContent);
  });

  test("普通源码变化仍进入 Git 和全内容指纹，近似目录不会被误排除", async () => {
    const repo = await repoWithArchive();
    const cleanGit = await collectGitSnapshot({ repoRoot: repo.root });
    const cleanContent = await collectContentFingerprint(repo.root);

    await writeFile(join(repo.root, "src", "source.ts"), "export const source = 'v2';\n");
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).not.toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).not.toBe(cleanContent);

    await runGit(["checkout", "--", "src/source.ts"], repo.root);
    await runGit(["rm", "src/source.ts"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).not.toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).not.toBe(cleanContent);

    await runGit(["reset", "--hard", "HEAD"], repo.root);
    await mkdir(join(repo.root, "docs", "product"), { recursive: true });
    await writeFile(join(repo.root, "docs", "product", "ordinary.ts"), "export const ordinary = true;\n");
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).not.toBe(cleanGit.fingerprint);
    expect(await collectContentFingerprint(repo.root)).not.toBe(cleanContent);
  });

  test("跨归档边界改名按源码范围记为删除或新增，归档内部改名不影响快照", async () => {
    const repo = await repoWithArchive();
    const clean = await collectGitSnapshot({ repoRoot: repo.root });

    await runGit(["mv", "src/source.ts", "docs/prod/source.ts"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).not.toBe(clean.fingerprint);

    await runGit(["reset", "--hard", "HEAD"], repo.root);
    await runGit(["mv", "docs/prod/archive.md", "src/restored.md"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).not.toBe(clean.fingerprint);

    await runGit(["reset", "--hard", "HEAD"], repo.root);
    await runGit(["mv", "docs/prod/archive.md", "docs/prod/moved.md"], repo.root);
    expect((await collectGitSnapshot({ repoRoot: repo.root })).fingerprint).toBe(clean.fingerprint);
  });

  test("大段归档差异不会进入 Git 输出缓冲区，调用方附加排除不能取消固定排除", async () => {
    const repo = await repoWithArchive();
    const clean = await collectGitSnapshot({ repoRoot: repo.root, gitMaxBuffer: 2_048, excludePaths: ["README.md"] });
    await writeFile(join(repo.root, "docs", "prod", "archive.md"), `ARCHIVE-OUTPUT-PROBE\n${"x".repeat(128 * 1024)}`);
    await runGit(["add", "docs/prod/archive.md"], repo.root);

    const changed = await collectGitSnapshot({ repoRoot: repo.root, gitMaxBuffer: 2_048, excludePaths: ["README.md"] });
    expect(changed.fingerprint).toBe(clean.fingerprint);
  });

  test("Node 内容枚举在 lstat/流读取前跳过归档，但普通不可读文件仍会失败", async () => {
    const repo = await repoWithArchive();
    const archive = join(repo.root, "docs", "prod", "archive.md");
    await chmod(archive, 0o000);
    await expect(collectContentFingerprint(repo.root)).resolves.toMatch(/^[0-9a-f]{64}$/);

    const source = join(repo.root, "src", "source.ts");
    await chmod(source, 0o000);
    await expect(collectContentFingerprint(repo.root)).rejects.toThrow("无法读取快照文件: src/source.ts");
  });
});
