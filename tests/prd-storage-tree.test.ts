import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  commitDraftFiles,
  create,
  readDraftFiles,
  readVersion,
  save,
  type PrdStorageConfig,
} from "../src/modules/requirement/prd-storage.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const execFileAsync = promisify(execFile);
const REQUIREMENT_ID = "01941f29-7c00-7000-8000-000000000001";
const roots: string[] = [];
let counter = 0;

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function uuid(): string {
  counter += 1;
  return `01941f29-7c00-7000-8000-${String(counter).padStart(12, "0")}`;
}

function hash(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function git(args: string[], cwd: string, home: string, input?: string): Promise<string> {
  const child = execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "xdg"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@localhost",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@localhost",
      LC_ALL: "C",
      LANG: "C",
    },
  });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout;
}

async function world(): Promise<{ root: string; home: string; config: PrdStorageConfig }> {
  const root = await mkdtemp(join(temporaryRoot(), "prd-tree-"));
  roots.push(root);
  const home = join(root, "home");
  const business = join(root, "business");
  await mkdir(home, { mode: 0o700 });
  await mkdir(business, { mode: 0o700 });
  return {
    root,
    home,
    config: {
      dataRoot: join(root, "private"),
      repoId: "repo-1",
      requirementId: REQUIREMENT_ID,
      repositoryRoot: business,
      worktreeRoots: [],
      authorize: () => true,
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function initial(w: World, body = "# 第一版\n") {
  return create({ ...w.config, operationId: uuid(), anchor: uuid(), expectedParent: null, bytes: Buffer.from(body) } as never);
}

async function update(w: World, expectedParent: string, body: string, ids = { operationId: uuid(), anchor: uuid() }) {
  return save({ ...w.config, action: "updateDraft", ...ids, expectedParent, bytes: Buffer.from(body) } as never);
}

async function refsOf(repo: string, home: string): Promise<Record<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)"], repo, home);
  return Object.fromEntries(out.trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PrdStorageError", code });
}

async function manualCommit(repo: string, home: string, files: Record<string, string>, parents: string[], ref: string): Promise<string> {
  const lines: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = (await git(["hash-object", "-w", "--stdin"], repo, home, content)).trim();
    lines.push(`100644 blob ${blob}\t${path}`);
  }
  const tree = (await git(["mktree"], repo, home, `${lines.join("\n")}\n`)).trim();
  const args = ["commit-tree", tree, "-m", `prd(${REQUIREMENT_ID}): updateDraft\n\nOperation-Id: ${uuid()}\nPrd-Hash: ${hash(files["prd.md"] ?? "")}`];
  for (const parent of parents) args.push("-p", parent);
  const commit = (await git(args, repo, home)).trim();
  await git(["update-ref", ref, commit], repo, home);
  return commit;
}

test("回到 C2 再保存得到 C3'：C3 原样可读，main 指向 C3'", async () => {
  const w = await initial_world();
  const c2 = w.c2;
  const c3 = await update(w.w, c2.commit, "# 第三版\n");
  const c3b = await update(w.w, c2.commit, "# 另一个第三版\n");
  expect(c3b.parent).toBe(c2.commit);
  expect(Buffer.from((await readVersion({ ...w.w.config, commit: c3.commit, expectedHash: c3.prdHash } as never)).bytes).toString()).toBe("# 第三版\n");
  expect((await git(["rev-parse", "refs/heads/main"], c3b.repositoryRoot, w.w.home)).trim()).toBe(c3b.commit);
});

async function initial_world() {
  const w = await world();
  const c2 = await initial(w);
  return { w, c2 };
}

test("每次保存和每次 commitDraftFiles 都有 refs/lines/<anchor> 指向其提交", async () => {
  const { w, c2 } = await initial_world();
  const anchorSave = uuid();
  const saved = await update(w, c2.commit, "# 第二版\n", { operationId: uuid(), anchor: anchorSave });
  const anchorProto = uuid();
  const proto = await commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: anchorProto, kind: "prototype", expectedParent: saved.commit,
    changes: { "prototypes/导出页.v1.html": Buffer.from("<html></html>") },
  } as never);
  const refs = await refsOf(c2.repositoryRoot, w.home);
  expect(refs[`refs/lines/${anchorSave}`]).toBe(saved.commit);
  expect(refs[`refs/lines/${anchorProto}`]).toBe(proto.commit);
});

test("prototype 提交父为 C3、不动 main，readDraftFiles 读出新增文件且 prd 仍是 C3", async () => {
  const { w, c2 } = await initial_world();
  const c3 = await update(w, c2.commit, "# 第三版\n");
  const proto = await commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "prototype", expectedParent: c3.commit,
    changes: {
      "prototypes/导出页.v1.html": Buffer.from("<p>原型</p>"),
      "DESIGN.md": Buffer.from("设计"),
      "DESIGN.base.md": Buffer.from("设计基线"),
    },
  } as never);
  const repo = c3.repositoryRoot;
  expect((await git(["rev-parse", `${proto.commit}^`], repo, w.home)).trim()).toBe(c3.commit);
  expect((await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim()).toBe(c3.commit);
  const files = await readDraftFiles({ ...w.config, commit: proto.commit } as never);
  expect(Buffer.from(files.prd).toString()).toBe("# 第三版\n");
  expect(Buffer.from(files.design!).toString()).toBe("设计");
  expect(Buffer.from(files.designBase!).toString()).toBe("设计基线");
  expect(files.agents).toBeNull();
  expect(Buffer.from(files.prototypes["导出页.v1"]!).toString()).toBe("<p>原型</p>");
});

test("conventions 加 AGENTS.md 并把原型路径设为 null 后，原型消失、AGENTS.md 在", async () => {
  const { w, c2 } = await initial_world();
  const proto = await commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "prototype", expectedParent: c2.commit,
    changes: { "prototypes/导出页.v1.html": Buffer.from("<p>原型</p>") },
  } as never);
  const conv = await commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "conventions", expectedParent: proto.commit,
    changes: { "AGENTS.md": Buffer.from("约定"), "prototypes/导出页.v1.html": null },
  } as never);
  const files = await readDraftFiles({ ...w.config, commit: conv.commit } as never);
  expect(files.prototypes).toEqual({});
  expect(Buffer.from(files.agents!).toString()).toBe("约定");
});

test("changes 里放 prd.md 报错", async () => {
  const { w, c2 } = await initial_world();
  await expect(commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "conventions", expectedParent: c2.commit,
    changes: { "prd.md": Buffer.from("偷改") },
  } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("changes 里放规定之外的路径被拒绝", async () => {
  const { w, c2 } = await initial_world();
  await expect(commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "conventions", expectedParent: c2.commit,
    changes: { "notes.txt": Buffer.from("x") },
  } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("手工加入含 notes.txt 的提交后读取报 history_mismatch", async () => {
  const { w, c2 } = await initial_world();
  await manualCommit(c2.repositoryRoot, w.home, { "prd.md": "# 第一版\n", "notes.txt": "x" }, [c2.commit], `refs/lines/${uuid()}`);
  await expectCode(readVersion({ ...w.config, commit: c2.commit, expectedHash: c2.prdHash } as never), "history_mismatch");
});

test("手工加入两个父的提交后读取报 history_mismatch", async () => {
  const { w, c2 } = await initial_world();
  const c3 = await update(w, c2.commit, "# 第二版\n");
  await manualCommit(c2.repositoryRoot, w.home, { "prd.md": "# 合并\n" }, [c2.commit, c3.commit], `refs/lines/${uuid()}`);
  await expectCode(readVersion({ ...w.config, commit: c2.commit, expectedHash: c2.prdHash } as never), "history_mismatch");
});

test("出现 refs/heads/other 时读取报错", async () => {
  const { w, c2 } = await initial_world();
  await git(["update-ref", "refs/heads/other", c2.commit], c2.repositoryRoot, w.home);
  await expect(readVersion({ ...w.config, commit: c2.commit, expectedHash: c2.prdHash } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("只有 main 的旧仓库（无 refs/lines）照常读取并以 main 为父保存", async () => {
  const { w, c2 } = await initial_world();
  const repo = c2.repositoryRoot;
  for (const ref of Object.keys(await refsOf(repo, w.home))) {
    if (ref.startsWith("refs/lines/")) await git(["update-ref", "-d", ref], repo, w.home);
  }
  expect(Buffer.from((await readVersion({ ...w.config, commit: c2.commit, expectedHash: c2.prdHash } as never)).bytes).toString()).toBe("# 第一版\n");
  const next = await update(w, c2.commit, "# 第二版\n");
  expect(next.parent).toBe(c2.commit);
});

test("同一 operationId 与 anchor 重试 save 不增加提交", async () => {
  const { w, c2 } = await initial_world();
  const ids = { operationId: uuid(), anchor: uuid() };
  const one = await update(w, c2.commit, "# 第二版\n", ids);
  const count = async () => (await git(["rev-list", "--all", "--count"], c2.repositoryRoot, w.home)).trim();
  const before = await count();
  const again = await update(w, c2.commit, "# 第二版\n", ids);
  expect(again.status).toBe("recovered");
  expect(again.commit).toBe(one.commit);
  expect(await count()).toBe(before);
});

test("提交说明含固定格式的首行、Operation-Id 和 Prd-Hash，身份固定", async () => {
  const { w, c2 } = await initial_world();
  const operationId = uuid();
  const c3 = await update(w, c2.commit, "# 第二版\n", { operationId, anchor: uuid() });
  const repo = c3.repositoryRoot;
  expect((await git(["show", "-s", "--format=%B", c3.commit], repo, w.home)).trimEnd()).toBe(
    `prd(${REQUIREMENT_ID}): updateDraft\n\nOperation-Id: ${operationId}\nPrd-Hash: ${hash("# 第二版\n")}`,
  );
  expect((await git(["show", "-s", "--format=%an%x00%ae", c3.commit], repo, w.home)).trim()).toBe("pi PRD storage\0pi-prd-storage@localhost");
});

test("以 C2 为父保存后工作副本的 prd.md 等于 main 的 prd.md", async () => {
  const { w, c2 } = await initial_world();
  await update(w, c2.commit, "# 第三版\n");
  const c3b = await update(w, c2.commit, "# 分叉版\n");
  expect(await readFile(join(c3b.repositoryRoot, "prd.md"), "utf8")).toBe("# 分叉版\n");
  expect(await git(["show", "refs/heads/main:prd.md"], c3b.repositoryRoot, w.home)).toBe("# 分叉版\n");
});

test("prototype 提交不移动 main，保存后 main 仍指向最近一次保存", async () => {
  const { w, c2 } = await initial_world();
  const proto = await commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "prototype", expectedParent: c2.commit,
    changes: { "prototypes/a.v1.html": Buffer.from("a") },
  } as never);
  expect((await git(["rev-parse", "refs/heads/main"], c2.repositoryRoot, w.home)).trim()).toBe(c2.commit);
  const saved = await update(w, proto.commit, "# 第二版\n");
  expect((await git(["rev-parse", "refs/heads/main"], c2.repositoryRoot, w.home)).trim()).toBe(saved.commit);
  const files = await readDraftFiles({ ...w.config, commit: saved.commit } as never);
  expect(Object.keys(files.prototypes)).toEqual(["a.v1"]);
});

test("create 缺少 anchor 时拒绝", async () => {
  const w = await world();
  await expectCode(
    create({ ...w.config, operationId: uuid(), expectedParent: null, bytes: Buffer.from("# 第一版\n") } as never),
    "invalid_anchor",
  );
});

test("save 的 anchor 不是 UUIDv7 时拒绝", async () => {
  const w = await world();
  const c1 = await initial(w);
  await expectCode(update(w, c1.commit, "# 第二版\n", { operationId: uuid(), anchor: "create-1" }), "invalid_anchor");
});

async function threeVersions() {
  const { w, c2: c1 } = await initial_world();
  const c2 = await update(w, c1.commit, "# 第二版\n");
  const c3 = await update(w, c2.commit, "# 第三版\n");
  return { w, c1, c2, c3, repo: c1.repositoryRoot };
}

async function removeLineRefs(repo: string, home: string): Promise<void> {
  for (const ref of Object.keys(await refsOf(repo, home))) {
    if (ref.startsWith("refs/lines/")) await git(["update-ref", "-d", ref], repo, home);
  }
}

const commitCount = async (repo: string, home: string) => (await git(["rev-list", "--all", "--count"], repo, home)).trim();

test("旧 main 不在任何 refs/lines 上时，以更早的提交为父保存被拒绝且仓库不变", async () => {
  const { w, c2, c3, repo } = await threeVersions();
  await removeLineRefs(repo, w.home);
  const before = await commitCount(repo, w.home);
  await expectCode(update(w, c2.commit, "# 分叉版\n"), "parent_mismatch");
  expect((await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim()).toBe(c3.commit);
  expect(await commitCount(repo, w.home)).toBe(before);
  expect(Buffer.from((await readVersion({ ...w.config, commit: c3.commit, expectedHash: c3.prdHash } as never)).bytes).toString()).toBe("# 第三版\n");
});

test("旧 main 不在任何 refs/lines 上时，以 main 为父保存成功且 main 的旧提交可由新提交到达", async () => {
  const { w, c3, repo } = await threeVersions();
  await removeLineRefs(repo, w.home);
  const next = await update(w, c3.commit, "# 第四版\n");
  expect(next.parent).toBe(c3.commit);
  expect((await git(["rev-parse", `${next.commit}^`], repo, w.home)).trim()).toBe(c3.commit);
});

test("重放已完成的旧保存不移动 main", async () => {
  const { w, c1, repo } = await threeVersions();
  const ids = { operationId: uuid(), anchor: uuid() };
  await update(w, c1.commit, "# A\n", ids);
  const b = await update(w, (await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim(), "# B\n");
  const again = await update(w, c1.commit, "# A\n", ids);
  expect(again.status).toBe("recovered");
  expect((await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim()).toBe(b.commit);
});

async function draftCommit(w: World, parent: string, ids: { operationId: string; anchor: unknown }, body: string) {
  return commitDraftFiles({
    ...w.config, ...ids, kind: "prototype", expectedParent: parent,
    changes: { "prototypes/a.v1.html": Buffer.from(body) },
  } as never);
}

test("commitDraftFiles 同一 operationId 与 anchor、内容相同的重试返回同一提交且不增加提交", async () => {
  const { w, c2: c1 } = await initial_world();
  const ids = { operationId: uuid(), anchor: uuid() };
  const one = await draftCommit(w, c1.commit, ids, "a");
  const before = await commitCount(c1.repositoryRoot, w.home);
  const again = await draftCommit(w, c1.commit, ids, "a");
  expect(again.commit).toBe(one.commit);
  expect(await commitCount(c1.repositoryRoot, w.home)).toBe(before);
});

test("commitDraftFiles 同一 operationId 与 anchor、内容不同的重试报 operation_conflict", async () => {
  const { w, c2: c1 } = await initial_world();
  const ids = { operationId: uuid(), anchor: uuid() };
  await draftCommit(w, c1.commit, ids, "a");
  await expectCode(draftCommit(w, c1.commit, ids, "b"), "operation_conflict");
});

test("commitDraftFiles 缺少 anchor 报 invalid_anchor", async () => {
  const { w, c2: c1 } = await initial_world();
  await expectCode(commitDraftFiles({
    ...w.config, operationId: uuid(), kind: "prototype", expectedParent: c1.commit,
    changes: { "prototypes/a.v1.html": Buffer.from("a") },
  } as never), "invalid_anchor");
});

test("commitDraftFiles 的 anchor 不是 UUIDv7 报 invalid_anchor", async () => {
  const { w, c2: c1 } = await initial_world();
  await expectCode(draftCommit(w, c1.commit, { operationId: uuid(), anchor: "x-1" }, "a"), "invalid_anchor");
});

test("commitDraftFiles 只放 DESIGN.base.md 不放 DESIGN.md 被拒绝", async () => {
  const { w, c2: c1 } = await initial_world();
  await expect(commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "prototype", expectedParent: c1.commit,
    changes: { "DESIGN.base.md": Buffer.from("基线") },
  } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("commitDraftFiles 只放 AGENTS.base.md 不放 AGENTS.md 被拒绝", async () => {
  const { w, c2: c1 } = await initial_world();
  await expect(commitDraftFiles({
    ...w.config, operationId: uuid(), anchor: uuid(), kind: "conventions", expectedParent: c1.commit,
    changes: { "AGENTS.base.md": Buffer.from("基线") },
  } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("手工加入只含 prd.md 和 DESIGN.base.md 的提交后读取报 history_mismatch", async () => {
  const { w, c2: c1 } = await initial_world();
  await manualCommit(c1.repositoryRoot, w.home, { "prd.md": "# 第一版\n", "DESIGN.base.md": "基线" }, [c1.commit], `refs/lines/${uuid()}`);
  await expectCode(readVersion({ ...w.config, commit: c1.commit, expectedHash: c1.prdHash } as never), "history_mismatch");
});

test("以 C2 为父、内容等于 C2 保存得到 unchanged，不产生新提交，main 仍是 C3", async () => {
  const { w, c2, c3, repo } = await threeVersions();
  const before = await commitCount(repo, w.home);
  const result = await update(w, c2.commit, "# 第二版\n");
  expect(result.status).toBe("unchanged");
  expect(await commitCount(repo, w.home)).toBe(before);
  expect((await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim()).toBe(c3.commit);
});

test("refs/lines 下名字不是 UUIDv7 的引用使读取报错", async () => {
  const { w, c2: c1 } = await initial_world();
  await git(["update-ref", "refs/lines/not-a-uuid", c1.commit], c1.repositoryRoot, w.home);
  await expect(readVersion({ ...w.config, commit: c1.commit, expectedHash: c1.prdHash } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("refs/lines/<UUIDv7> 指向 blob 对象使读取报错", async () => {
  const { w, c2: c1 } = await initial_world();
  const blob = (await git(["hash-object", "-w", "--stdin"], c1.repositoryRoot, w.home, "x")).trim();
  await git(["update-ref", `refs/lines/${uuid()}`, blob], c1.repositoryRoot, w.home);
  await expect(readVersion({ ...w.config, commit: c1.commit, expectedHash: c1.prdHash } as never)).rejects.toMatchObject({ name: "PrdStorageError" });
});

test("分叉保存写完 main 后丢失 refs/lines，同参数重试补上引用且不增加提交", async () => {
  const { w, c2, repo } = await threeVersions();
  const ids = { operationId: uuid(), anchor: uuid() };
  const s = await update(w, c2.commit, "# 分叉版\n", ids);
  await git(["update-ref", "-d", `refs/lines/${ids.anchor}`], repo, w.home);
  const before = await commitCount(repo, w.home);
  const again = await update(w, c2.commit, "# 分叉版\n", ids);
  expect(again.status).toBe("recovered");
  expect(again.commit).toBe(s.commit);
  expect((await refsOf(repo, w.home))[`refs/lines/${ids.anchor}`]).toBe(s.commit);
  expect(await commitCount(repo, w.home)).toBe(before);
  expect((await git(["rev-parse", "refs/heads/main"], repo, w.home)).trim()).toBe(s.commit);
});
