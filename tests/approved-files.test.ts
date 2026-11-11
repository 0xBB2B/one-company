import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approvedFilesConflictAdvice, commitApprovedFiles, mergeWithBase, planApprovedFiles } from "../src/modules/delivery/approved-files.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import { runGit } from "./helpers/git-run.ts";
import { setLocalIdentity, withoutGitIdentity } from "./helpers/git-identity.ts";
import { AGENTS_BASE, AGENTS_DRAFT, DESIGN_BASE, DESIGN_DRAFT, DESIGN_MAIN_COLOR, DESIGN_MAIN_COMPONENT, PROTOTYPE_HTML } from "./helpers/approved-files-fixture.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ID = "01941f29-7c00-7000-8000-000000000001";
const FILE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PRD = "# 角色跳跃\n\n## 目标\n保留移动。\n";
const text = (value: Uint8Array | string) => Buffer.from(value).toString("utf8");
const bytes = (value: string) => Buffer.from(value);
const mdPath = (title: string) => `docs/prd/${ID}.${title}.md`;
const htmlPath = (name: string) => `docs/prd/${ID}.${name}.html`;
const TWO_CHAPTERS_DRAFT = DESIGN_DRAFT.replace("- 主色：#0f766e", "- 主色：#7c3aed");
const TWO_CHAPTERS_MAIN = DESIGN_BASE.replace("- 主色：#0f766e", "- 主色：#2563eb").replace("- 按钮：圆角 4px", "- 按钮：圆角 2px");

const files = (patch: Partial<Record<"design" | "designBase" | "agents" | "agentsBase", string | null>> & { prototypes?: Record<string, string> } = {}) => ({
  prd: bytes(PRD),
  design: patch.design === undefined ? null : patch.design === null ? null : bytes(patch.design),
  designBase: patch.designBase === undefined ? null : patch.designBase === null ? null : bytes(patch.designBase),
  agents: patch.agents === undefined ? null : patch.agents === null ? null : bytes(patch.agents),
  agentsBase: patch.agentsBase === undefined ? null : patch.agentsBase === null ? null : bytes(patch.agentsBase),
  prototypes: Object.fromEntries(Object.entries(patch.prototypes ?? {}).map(([name, html]) => [name, bytes(html)])),
});
const plan = (input: { title?: string; files?: ReturnType<typeof files>; current?: { design: string | null; agents: string | null }; existingPaths?: string[] }) =>
  planApprovedFiles({ requirementId: ID, title: input.title ?? "角色跳跃", files: input.files ?? files(), current: input.current ?? { design: null, agents: null }, existingPaths: input.existingPaths ?? [] });
const written = (result: { writes: Record<string, Uint8Array> }) => Object.keys(result.writes).sort();

test("三方合并：两边改的是不同章，底稿到批准版的改动和底稿到现有内容的改动都在结果里", () => {
  const merged = mergeWithBase(DESIGN_BASE, DESIGN_MAIN_COLOR, DESIGN_DRAFT);
  expect(merged.conflictChapters).toEqual([]);
  expect(merged.content).toBe(DESIGN_BASE.replace("- 主色：#0f766e", "- 主色：#2563eb").replace("- 按钮：圆角 4px", "- 按钮：圆角 8px"));
});

test("三方合并：现有内容和底稿相同，结果就是批准的内容", () => {
  expect(mergeWithBase(DESIGN_BASE, DESIGN_BASE, DESIGN_DRAFT)).toEqual({ content: DESIGN_DRAFT, conflictChapters: [] });
});

test("三方合并：批准的内容和底稿相同，现有内容原样保留", () => {
  expect(mergeWithBase(DESIGN_BASE, DESIGN_MAIN_COLOR, DESIGN_BASE)).toEqual({ content: DESIGN_MAIN_COLOR, conflictChapters: [] });
});

test("三方合并：两边改了同一章的同一行，报出冲突所在的二级标题", () => {
  expect(mergeWithBase(DESIGN_BASE, DESIGN_MAIN_COMPONENT, DESIGN_DRAFT).conflictChapters).toEqual(["组件"]);
});

test("三方合并：两个章都冲突，按文件里出现的先后列出两个章名", () => {
  expect(mergeWithBase(DESIGN_BASE, TWO_CHAPTERS_MAIN, TWO_CHAPTERS_DRAFT).conflictChapters).toEqual(["颜色", "组件"]);
});

test("三方合并：底稿不存在时按空处理，现有内容也不存在则结果就是批准的内容", () => {
  expect(mergeWithBase(null, null, DESIGN_DRAFT)).toEqual({ content: DESIGN_DRAFT, conflictChapters: [] });
});

test("三方合并：底稿不存在而现有内容已有不同的文件，两边都像是新写的，按冲突处理", () => {
  expect(mergeWithBase(null, DESIGN_MAIN_COLOR, DESIGN_DRAFT).conflictChapters.length).toBeGreaterThan(0);
});

test("算出要写的文件：正文、原型、DESIGN.md、AGENTS.md 四类都在规定路径上，DESIGN.md 是三方合并的结果，AGENTS.md 与批准内容一致", () => {
  const result = plan({
    files: files({ design: DESIGN_DRAFT, designBase: DESIGN_BASE, agents: AGENTS_DRAFT, agentsBase: AGENTS_BASE, prototypes: { "设置页.v1": PROTOTYPE_HTML } }),
    current: { design: DESIGN_MAIN_COLOR, agents: AGENTS_BASE },
  });
  expect(result.conflicts).toEqual([]);
  expect(written(result)).toEqual(["AGENTS.md", "DESIGN.md", mdPath("角色跳跃"), htmlPath("设置页")].sort());
  expect(text(result.writes[mdPath("角色跳跃")]!)).toBe(PRD);
  expect(text(result.writes[htmlPath("设置页")]!)).toBe(PROTOTYPE_HTML);
  expect(text(result.writes["DESIGN.md"]!)).toBe(DESIGN_BASE.replace("- 主色：#0f766e", "- 主色：#2563eb").replace("- 按钮：圆角 4px", "- 按钮：圆角 8px"));
  expect(text(result.writes["AGENTS.md"]!)).toBe(AGENTS_DRAFT);
  expect(result.deletes).toEqual([]);
});

test("算出要写的文件：草稿里没有 DESIGN.md 和 AGENTS.md 时只写正文，不碰分支里已有的这两个文件", () => {
  const result = plan({ current: { design: DESIGN_MAIN_COLOR, agents: AGENTS_BASE } });
  expect(written(result)).toEqual([mdPath("角色跳跃")]);
  expect(result.deletes).toEqual([]);
});

test("算出要写的文件：分支里还没有这两个文件、底稿也不存在时，批准的内容原样写入", () => {
  const result = plan({ files: files({ design: DESIGN_DRAFT, agents: AGENTS_DRAFT }), current: { design: null, agents: null } });
  expect(result.conflicts).toEqual([]);
  expect(text(result.writes["DESIGN.md"]!)).toBe(DESIGN_DRAFT);
  expect(text(result.writes["AGENTS.md"]!)).toBe(AGENTS_DRAFT);
});

test("算出要写的文件：新版本改了标题，旧标题的正文文件列入删除，新标题的写入", () => {
  const result = plan({ title: "角色二段跳", existingPaths: [mdPath("角色跳跃")] });
  expect(result.deletes).toEqual([mdPath("角色跳跃")]);
  expect(written(result)).toEqual([mdPath("角色二段跳")]);
});

test("算出要写的文件：新版本去掉了某份原型，那份原型的文件列入删除，仍在的原型不删", () => {
  const result = plan({ files: files({ prototypes: { "设置页.v2": PROTOTYPE_HTML } }), existingPaths: [mdPath("角色跳跃"), htmlPath("设置页"), htmlPath("命令行输出")] });
  expect(result.deletes).toEqual([htmlPath("命令行输出")]);
  expect(written(result)).toEqual([mdPath("角色跳跃"), htmlPath("设置页")].sort());
});

test("算出要写的文件：标题和原型都没变时没有要删的文件", () => {
  expect(plan({ existingPaths: [mdPath("角色跳跃")] }).deletes).toEqual([]);
});

test("算出要写的文件：DESIGN.md 合不上时返回冲突的文件和章名", () => {
  const result = plan({ files: files({ design: DESIGN_DRAFT, designBase: DESIGN_BASE }), current: { design: DESIGN_MAIN_COMPONENT, agents: null } });
  expect(result.conflicts).toEqual([{ file: "DESIGN.md", chapter: "组件" }]);
});

test("算出要写的文件：AGENTS.md 合不上时返回冲突的文件和章名，DESIGN.md 能合上则不列", () => {
  const agentsMain = AGENTS_BASE.replace("- 文件名用小写。", "- 文件名用短横线连接。");
  const agentsDraft = AGENTS_BASE.replace("- 文件名用小写。", "- 文件名用大驼峰。");
  const result = plan({ files: files({ design: DESIGN_DRAFT, designBase: DESIGN_BASE, agents: agentsDraft, agentsBase: AGENTS_BASE }), current: { design: DESIGN_MAIN_COLOR, agents: agentsMain } });
  expect(result.conflicts).toEqual([{ file: "AGENTS.md", chapter: "命名" }]);
});

test("冲突说明：写明哪个文件哪一章，下一步建议让设计师按最新的 DESIGN.md 重做一版，不带错误码", () => {
  const advice = approvedFilesConflictAdvice([{ file: "DESIGN.md", chapter: "组件" }]);
  expect(Object.keys(advice).sort()).toEqual(["next", "why"]);
  expect(advice.why).toContain("DESIGN.md");
  expect(advice.why).toContain("组件");
  expect(advice.next).toContain("让设计师按最新的 DESIGN.md 重做一版");
  expect(advice.next).not.toContain("AGENTS.md");
  expect(advice.why).not.toMatch(/[a-z]+_[a-z_]+/);
});

test("冲突说明：AGENTS.md 冲突时下一步建议按最新的 AGENTS.md 重改规范", () => {
  const advice = approvedFilesConflictAdvice([{ file: "AGENTS.md", chapter: "命名" }]);
  expect(advice.why).toContain("AGENTS.md");
  expect(advice.why).toContain("命名");
  expect(advice.next).toContain("按最新的 AGENTS.md 重改规范");
  expect(advice.next).not.toContain("DESIGN.md");
});

test("冲突说明：两个文件都冲突时两条下一步都给", () => {
  const advice = approvedFilesConflictAdvice([{ file: "DESIGN.md", chapter: "组件" }, { file: "AGENTS.md", chapter: "命名" }]);
  expect(advice.next).toContain("让设计师按最新的 DESIGN.md 重做一版");
  expect(advice.next).toContain("按最新的 AGENTS.md 重改规范");
});

async function repoWithDesign() {
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  await setLocalIdentity(repo.root);
  await writeFile(join(repo.root, "DESIGN.md"), DESIGN_BASE);
  await mkdir(join(repo.root, "docs", "prd"), { recursive: true });
  await writeFile(join(repo.root, mdPath("旧标题")), "旧正文\n");
  await runGit(["add", "."], repo.root); await runGit(["commit", "-qm", "底稿"], repo.root);
  return repo;
}

test("提交：写入的文件和删除的文件落成一个提交，说明末尾单独一行 Requirement，文件内容与传入一致", async () => {
  const repo = await repoWithDesign();
  const before = (await runGit(["rev-parse", "HEAD"], repo.root)).trim();
  await commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { "DESIGN.md": bytes(DESIGN_DRAFT), [mdPath("新标题")]: bytes(PRD) }, deletes: [mdPath("旧标题")] });
  expect((await runGit(["rev-list", "--count", `${before}..HEAD`], repo.root)).trim()).toBe("1");
  const status = (await runGit(["-c", "core.quotePath=false", "show", "--name-status", "--format=", "HEAD"], repo.root)).trim().split("\n").sort();
  expect(status).toEqual([`A\t${mdPath("新标题")}`, `D\t${mdPath("旧标题")}`, "M\tDESIGN.md"].sort());
  expect(await readFile(join(repo.root, "DESIGN.md"), "utf8")).toBe(DESIGN_DRAFT);
  expect(await runGit(["show", `HEAD:${mdPath("新标题")}`], repo.root)).toBe(PRD);
  const message = (await runGit(["log", "-1", "--format=%B"], repo.root)).trimEnd().split("\n");
  expect(message.filter((line) => line !== "")).toEqual(["docs(prd): 提交批准的需求文件 " + ID, `Approved-Files: ${FILE_COMMIT}`, `Requirement: ${ID}`]);
  expect(message.at(-1)).toBe(`Requirement: ${ID}`);
  expect(message.slice(0, -1).filter((line) => line.startsWith("Requirement:"))).toEqual([]);
  expect((await runGit(["status", "--porcelain"], repo.root)).trim()).toBe("");
});

test("提交：用户已暂存的无关文件留在暂存区，不进这次提交", async () => {
  const repo = await repoWithDesign();
  await writeFile(join(repo.root, "别的.txt"), "暂存的\n");
  await runGit(["add", "别的.txt"], repo.root);
  await commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { [mdPath("新标题")]: bytes(PRD) }, deletes: [] });
  expect((await runGit(["-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD"], repo.root)).trim()).toBe(mdPath("新标题"));
  expect((await runGit(["-c", "core.quotePath=false", "status", "--porcelain"], repo.root)).trim()).toBe("A  别的.txt");
});

test("提交：写入的内容和分支 HEAD 完全相同，不报错也不多提交", async () => {
  const repo = await repoWithDesign();
  const before = (await runGit(["rev-parse", "HEAD"], repo.root)).trim();
  await expect(commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { "DESIGN.md": bytes(DESIGN_BASE), [mdPath("旧标题")]: bytes("旧正文\n") }, deletes: [] })).resolves.toBeUndefined();
  expect((await runGit(["rev-parse", "HEAD"], repo.root)).trim()).toBe(before);
  expect((await runGit(["status", "--porcelain"], repo.root)).trim()).toBe("");
});

test("提交：提交者身份取这个仓库自己的 git 配置", async () => {
  const repo = await repoWithDesign();
  await runGit(["config", "user.name", "工作区作者"], repo.root);
  await runGit(["config", "user.email", "author@example.com"], repo.root);
  await commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { [mdPath("新标题")]: bytes(PRD) }, deletes: [] });
  expect((await runGit(["log", "-1", "--format=%an <%ae>"], repo.root)).trim()).toBe("工作区作者 <author@example.com>");
});

test("提交：git commit 失败时抛出错误，不留下新提交", async () => {
  const repo = await repoWithDesign();
  const before = (await runGit(["rev-parse", "HEAD"], repo.root)).trim();
  await withoutGitIdentity(repo.root, async () => {
    await expect(commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { [mdPath("新标题")]: bytes(PRD) }, deletes: [] })).rejects.toThrow();
  });
  expect((await runGit(["rev-parse", "HEAD"], repo.root)).trim()).toBe(before);
});

test("提交：写进子目录时自动建目录", async () => {
  const repo = await createRepoFixture(); cleanups.push(() => removeRepoFixture(repo));
  await setLocalIdentity(repo.root);
  await commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes: { [htmlPath("设置页")]: bytes(PROTOTYPE_HTML) }, deletes: [] });
  expect(await readFile(join(repo.root, htmlPath("设置页")), "utf8")).toBe(PROTOTYPE_HTML);
});

test("提交：写到一半有个目标位置写不进去，已写的文件全部恢复成写之前的样子，修好后再调用能提交", async () => {
  const repo = await repoWithDesign();
  const before = (await runGit(["rev-parse", "HEAD"], repo.root)).trim();
  await mkdir(join(repo.root, htmlPath("设置页")), { recursive: true });
  const writes = { "DESIGN.md": bytes(DESIGN_DRAFT), [mdPath("新标题")]: bytes(PRD), [htmlPath("设置页")]: bytes(PROTOTYPE_HTML) };
  await expect(commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes, deletes: [] })).rejects.toThrow();
  expect((await runGit(["rev-parse", "HEAD"], repo.root)).trim()).toBe(before);
  expect(await readFile(join(repo.root, "DESIGN.md"), "utf8")).toBe(DESIGN_BASE);
  expect((await runGit(["-c", "core.quotePath=false", "status", "--porcelain"], repo.root)).trim()).toBe("");
  await rm(join(repo.root, htmlPath("设置页")), { recursive: true });
  await commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes, deletes: [] });
  expect((await runGit(["-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD"], repo.root)).trim().split("\n").sort()).toEqual(["DESIGN.md", mdPath("新标题"), htmlPath("设置页")].sort());
});

test("提交：回滚时某个目标路径是已存在的空目录，抛出的是带原因和建议的「提交批准的文件失败」错误，已写的文件全部恢复", async () => {
  const repo = await repoWithDesign();
  await mkdir(join(repo.root, mdPath("新标题")), { recursive: true });
  const writes = { "DESIGN.md": bytes(DESIGN_DRAFT), [mdPath("新标题")]: bytes(PRD) };
  await expect(commitApprovedFiles({ worktree: repo.root, requirementId: ID, fileCommit: FILE_COMMIT, writes, deletes: [] })).rejects.toThrow(/提交批准的文件失败/);
  expect(await readFile(join(repo.root, "DESIGN.md"), "utf8")).toBe(DESIGN_BASE);
  expect((await runGit(["-c", "core.quotePath=false", "status", "--porcelain"], repo.root)).trim()).toBe("");
});
