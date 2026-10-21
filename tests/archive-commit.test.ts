import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveInHead, commitArchive } from "../src/modules/delivery/archive-commit.ts";
import { addWorktree, createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { setLocalIdentity, withoutGitIdentity } from "./helpers/git-identity.ts";

const REQUIREMENT = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const ARCHIVE = `docs/prd/${REQUIREMENT}.手机号登录.md`;
const PROTOTYPE = `docs/prd/${REQUIREMENT}.设置页.html`;
const PRD = "# 手机号登录\n正文\n";
const HTML = "<html>设置页</html>\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const files = [{ path: ARCHIVE, hash: sha(PRD) }, { path: PROTOTYPE, hash: sha(HTML) }];

const fixtures: RepoFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await removeRepoFixture(fixture); });

async function world() {
  const repo = await createRepoFixture(); fixtures.push(repo);
  const worktree = await addWorktree(repo);
  await setLocalIdentity(repo.root);
  const root = worktree.root;
  await mkdir(join(root, "docs", "prd"), { recursive: true });
  await writeFile(join(root, ARCHIVE), PRD);
  await writeFile(join(root, PROTOTYPE), HTML);
  const git = async (...args: string[]) => (await runGit(args, root)).trim();
  return { root, git };
}

test("archiveInHead：HEAD 里所有文件内容的 sha256 都和登记的一致时为 true", async () => {
  const w = await world();
  await w.git("add", "--", ARCHIVE, PROTOTYPE); await w.git("commit", "-qm", "归档");
  expect(await archiveInHead(w.root, files)).toBe(true);
});

test("archiveInHead：文件只在工作区或暂存区、不在 HEAD 里时为 false", async () => {
  const w = await world();
  expect(await archiveInHead(w.root, files)).toBe(false);
  await w.git("add", "--", ARCHIVE, PROTOTYPE);
  expect(await archiveInHead(w.root, files)).toBe(false);
});

test("archiveInHead：HEAD 里有文件但内容与登记的不同，或其中一份缺失时为 false", async () => {
  const w = await world();
  await w.git("add", "--", ARCHIVE); await w.git("commit", "-qm", "只归档正文");
  expect(await archiveInHead(w.root, files)).toBe(false);
  expect(await archiveInHead(w.root, [{ path: ARCHIVE, hash: sha("别的内容") }])).toBe(false);
  expect(await archiveInHead(w.root, [{ path: ARCHIVE, hash: sha(PRD) }])).toBe(true);
});

test("archiveInHead：只看 HEAD，工作区里后来被改的内容不影响结果", async () => {
  const w = await world();
  await w.git("add", "--", ARCHIVE, PROTOTYPE); await w.git("commit", "-qm", "归档");
  await writeFile(join(w.root, ARCHIVE), "被手动改过\n");
  expect(await archiveInHead(w.root, files)).toBe(true);
});

test("archiveInHead：路径含方括号时按字面路径核对", async () => {
  const w = await world();
  const bracket = `docs/prd/${REQUIREMENT}.a[1].html`, similar = `docs/prd/${REQUIREMENT}.a1.html`;
  await writeFile(join(w.root, bracket), "方括号\n"); await writeFile(join(w.root, similar), "近似名\n");
  await w.git("add", "--", bracket, similar); await w.git("commit", "-qm", "归档");
  expect(await archiveInHead(w.root, [{ path: bracket, hash: sha("方括号\n") }, { path: similar, hash: sha("近似名\n") }])).toBe(true);
  expect(await archiveInHead(w.root, [{ path: bracket, hash: sha("近似名\n") }])).toBe(false);
});

test("commitArchive：新增一个提交，只含给定文件，说明第一行是归档标题、空一行、最后一行是 Requirement", async () => {
  const w = await world();
  const before = await w.git("rev-list", "--count", "HEAD");
  await commitArchive(w.root, REQUIREMENT, files);
  expect(await w.git("rev-list", "--count", "HEAD")).toBe(String(Number(before) + 1));
  expect((await w.git("-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual([ARCHIVE, PROTOTYPE].sort());
  const lines = (await w.git("log", "-1", "--format=%B")).split("\n");
  expect(lines[0]).toBe(`docs(prd): 归档需求 ${REQUIREMENT}`);
  expect(lines[1]).toBe("");
  expect(lines.at(-1)).toBe(`Requirement: ${REQUIREMENT}`);
  expect(await archiveInHead(w.root, files)).toBe(true);
});

test("commitArchive：暂存区、工作区里别的改动保持原样，不进归档提交", async () => {
  const w = await world();
  await writeFile(join(w.root, "staged.ts"), "s\n"); await w.git("add", "staged.ts");
  await writeFile(join(w.root, "README.md"), "改过\n");
  await writeFile(join(w.root, "untracked.ts"), "u\n");
  await commitArchive(w.root, REQUIREMENT, files);
  expect(await w.git("-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).not.toMatch(/staged\.ts|README\.md|untracked\.ts/);
  expect((await runGit(["status", "--porcelain"], w.root)).split("\n").filter(Boolean).sort()).toEqual([" M README.md", "?? untracked.ts", "A  staged.ts"].sort());
});

test("commitArchive：文件已在 HEAD 里且内容一致时不新建提交", async () => {
  const w = await world();
  await commitArchive(w.root, REQUIREMENT, files);
  const head = await w.git("rev-parse", "HEAD");
  await commitArchive(w.root, REQUIREMENT, files);
  expect(await w.git("rev-parse", "HEAD")).toBe(head);
});

test("commitArchive：仓库忽略 *.html 时原型文件仍随归档一起提交", async () => {
  const w = await world();
  await writeFile(join(w.root, ".gitignore"), "*.html\n");
  await w.git("add", ".gitignore"); await w.git("commit", "-qm", "忽略 html");
  await commitArchive(w.root, REQUIREMENT, files);
  expect(await archiveInHead(w.root, files)).toBe(true);
});

test("commitArchive：路径含方括号时按字面路径提交，不连带近似名称的文件", async () => {
  const w = await world();
  const bracket = `docs/prd/${REQUIREMENT}.a[1].html`, similar = `docs/prd/${REQUIREMENT}.a1.html`;
  await writeFile(join(w.root, bracket), "方括号\n"); await writeFile(join(w.root, similar), "近似名\n");
  await commitArchive(w.root, REQUIREMENT, [{ path: bracket, hash: sha("方括号\n") }]);
  expect(await w.git("-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).toBe(bracket);
  expect(await w.git("status", "--porcelain")).toContain("?? ");
});

test("commitArchive：没配 Git 用户名和邮箱时提交失败并抛出 Git 的报错，不新增提交", async () => {
  const w = await world();
  const head = await w.git("rev-parse", "HEAD");
  const error = await withoutGitIdentity(w.root, () => commitArchive(w.root, REQUIREMENT, files).then(() => null, (e: unknown) => e as Error));
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toMatch(/identity|who you are|user\.(name|email)/i);
  expect(await w.git("rev-parse", "HEAD")).toBe(head);
  expect(await w.git("diff", "--cached", "--name-only")).toBe("");
  expect(error!.message).toMatch(/配置 Git 用户名和邮箱/);
});

test("commitArchive：正文已在 HEAD、原型还没提交时只补原型，提交数加一", async () => {
  const w = await world();
  await w.git("add", "--", ARCHIVE); await w.git("commit", "-qm", "只提交正文");
  const count = Number(await w.git("rev-list", "--count", "HEAD"));
  await commitArchive(w.root, REQUIREMENT, files);
  expect(Number(await w.git("rev-list", "--count", "HEAD"))).toBe(count + 1);
  expect(await w.git("-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD")).toBe(PROTOTYPE);
  expect(await archiveInHead(w.root, files)).toBe(true);
});

test("commitArchive：仓库换行设置改变了归档内容时报错写明原因和下一步，分支上不留提交、暂存区不留归档", async () => {
  const w = await world();
  await writeFile(join(w.root, ".gitattributes"), "* text=auto\n");
  await w.git("add", ".gitattributes"); await w.git("commit", "-qm", "换行设置");
  const crlf = "<html>\r\n设置页\r\n</html>\r\n";
  await writeFile(join(w.root, PROTOTYPE), crlf);
  const head = await w.git("rev-parse", "HEAD");
  const error = await commitArchive(w.root, REQUIREMENT, [files[0]!, { path: PROTOTYPE, hash: sha(crlf) }]).then(() => null, (e: unknown) => e as Error);
  expect(error?.message).toMatch(/\.gitattributes/);
  expect(await w.git("rev-parse", "HEAD")).toBe(head);
  expect(await w.git("diff", "--cached", "--name-only")).toBe("");
});
