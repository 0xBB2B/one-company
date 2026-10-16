import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  create,
  diffVersions,
  prdRequirementPath,
  PrdStorageError,
  readVersion,
  save,
  verifyVersion,
  type PrdStorageAuthorize,
  type PrdStorageConfig,
} from "../src/modules/requirement/prd-storage.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const execFileAsync = promisify(execFile);
const GIT = "git";
const REQUIREMENT_ID = "01941f29-7c00-7000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function hash(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function git(args: string[], cwd: string, home: string): Promise<string> {
  const result = await execFileAsync(GIT, args, {
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
      LC_ALL: "C",
      LANG: "C",
    },
  });
  return result.stdout;
}

async function world(authorize: PrdStorageAuthorize = () => true): Promise<{ root: string; home: string; config: PrdStorageConfig }> {
  const root = await mkdtemp(join(temporaryRoot(), "prd-storage-"));
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
      authorize,
    },
  };
}

async function first(w: Awaited<ReturnType<typeof world>>, bytes = "# 第一版\n") {
  return create({ ...w.config, operationId: "create-1", expectedParent: null, bytes: Buffer.from(bytes) });
}

async function commitCount(repositoryRoot: string, home: string): Promise<number> {
  return Number((await git(["rev-list", "--count", "HEAD"], repositoryRoot, home)).trim());
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "PrdStorageError", code });
}

test("Git 更新引用失败时仍收紧中间对象权限，重试只产生一个可达版本", async () => {
  const w = await world();
  const initial = await first(w);
  const gitRoot = join(initial.repositoryRoot, ".git");
  const lock = join(gitRoot, "refs", "heads", "main.lock");
  await writeFile(lock, "fixture lock", { mode: 0o600 });
  const command = { ...w.config, action: "updateDraft" as const, operationId: "private-failure",
    expectedParent: initial.commit, bytes: Buffer.from("新的正文") };
  await expectCode(save(command), "git_failed");
  async function checkPermissions(path: string): Promise<void> {
    const info = await lstat(path);
    expect(info.mode & 0o077, path).toBe(0);
    if (info.isDirectory()) for (const name of await readdir(path)) await checkPermissions(join(path, name));
  }
  await checkPermissions(gitRoot);
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(1);
  await rm(lock);
  await save(command);
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(2);
});

test("首次 create 自动初始化并以固定身份、message、单文件 tree 和实际字节 hash 首提", async () => {
  const w = await world();
  const body = "# 中文需求\r\n\r\n保留实际字节。\n";
  const result = await first(w, body);
  expect(result).toMatchObject({ status: "created", action: "create", parent: null, changed: true, prdHash: hash(body) });
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(await readFile(join(result.repositoryRoot, "prd.md"))).toEqual(Buffer.from(body));
  expect((await git(["show", "-s", "--format=%B", result.commit], result.repositoryRoot, w.home)).trimEnd()).toBe(
    `prd(${REQUIREMENT_ID}): create\n\nOperation-Id: create-1\nPrd-Hash: ${hash(body)}`,
  );
  expect((await git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", result.commit], result.repositoryRoot, w.home)).trim()).toBe(
    "pi PRD storage\0pi-prd-storage@localhost\0pi PRD storage\0pi-prd-storage@localhost",
  );
  expect((await git(["ls-tree", "-r", "--name-only", result.commit], result.repositoryRoot, w.home)).trim()).toBe("prd.md");
  expect(await git(["status", "--porcelain"], result.repositoryRoot, w.home)).toBe("");
  expect((await stat(result.repositoryRoot)).mode & 0o077).toBe(0);
  expect((await stat(join(result.repositoryRoot, "prd.md"))).mode & 0o077).toBe(0);
  expect((await stat(join(result.repositoryRoot, ".git"))).mode & 0o077).toBe(0);
  expect(await verifyVersion({ ...w.config, expectedRepositoryIdentity: result.repositoryIdentity, commit: result.commit, expectedHash: result.prdHash })).toMatchObject({ ok: true, commit: result.commit, prdHash: result.prdHash });
});

test("updateDraft 与 confirmUpdate 形成精确线性版本，历史读取和草稿到确认 diff 使用指定提交", async () => {
  const w = await world();
  const initial = await first(w, "# 目标\n\n初稿\n");
  const draft = await save({ ...w.config, action: "updateDraft", operationId: "draft-1", expectedParent: initial.commit, bytes: Buffer.from("# 目标\n\n草稿补充\n") });
  const confirmed = await save({ ...w.config, action: "confirmUpdate", operationId: "confirm-1", expectedParent: draft.commit, bytes: Buffer.from("# 目标\n\n批准内容\n") });
  expect(draft).toMatchObject({ status: "saved", parent: initial.commit, changed: true });
  expect(confirmed).toMatchObject({ status: "saved", parent: draft.commit, changed: true });
  expect("approved" in confirmed).toBe(false);
  expect(Buffer.from((await readVersion({ ...w.config, commit: initial.commit, expectedHash: initial.prdHash })).bytes).toString()).toBe("# 目标\n\n初稿\n");
  const difference = await diffVersions({
    ...w.config,
    fromCommit: draft.commit,
    toCommit: confirmed.commit,
    expectedFromHash: draft.prdHash,
    expectedToHash: confirmed.prdHash,
  });
  expect(difference.diff).toContain("-草稿补充");
  expect(difference.diff).toContain("+批准内容");
  expect((await git(["rev-list", "--first-parent", "--format=%P", "HEAD"], confirmed.repositoryRoot, w.home)).trim()).toContain(draft.commit);
});

test("正文无变化不产生空提交；同 operationId 的提交成功响应丢失可恢复且不重复提交", async () => {
  const w = await world();
  const initial = await first(w);
  const unchanged = await save({ ...w.config, action: "updateDraft", operationId: "unchanged-1", expectedParent: initial.commit, bytes: Buffer.from("# 第一版\n") });
  expect(unchanged).toMatchObject({ status: "unchanged", action: "updateDraft", commit: initial.commit, changed: false });
  const sameContentConfirmation = await save({ ...w.config, action: "confirmUpdate", operationId: "confirm-same-1", expectedParent: initial.commit, bytes: Buffer.from("# 第一版\n") });
  expect(sameContentConfirmation).toMatchObject({ status: "unchanged", action: "confirmUpdate", commit: initial.commit, changed: false });
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(1);

  const request = { ...w.config, action: "updateDraft" as const, operationId: "lost-response-1", expectedParent: initial.commit, bytes: Buffer.from("# 第二版\n") };
  const saved = await save(request);
  const recovered = await save(request);
  expect(recovered).toMatchObject({ status: "recovered", commit: saved.commit, parent: initial.commit, changed: true });
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(2);
});

test("无可信持久操作记录的临时文件会原样保留并阻塞；人工核对移除后可恢复 init", async () => {
  const interrupted = await world();
  const interruptedRoot = prdRequirementPath(interrupted.config);
  const interruptedBody = "# 第一版\n";
  const staleBytes = Buffer.from("与文件名目标 hash 不同的外部临时内容");
  const staleTemp = join(interruptedRoot, `.prd-storage-create-1-${hash(interruptedBody).slice("sha256:".length)}-deadbeef.tmp`);
  await mkdir(join(interruptedRoot, ".git"), { recursive: true, mode: 0o700 });
  await writeFile(staleTemp, staleBytes, { mode: 0o600 });
  await expectCode(first(interrupted, interruptedBody), "recovery_required");
  expect(await readFile(staleTemp)).toEqual(staleBytes);
  await rm(staleTemp);
  expect((await first(interrupted, interruptedBody)).status).toBe("created");

  const bodyOnly = await world();
  const bodyOnlyRoot = prdRequirementPath(bodyOnly.config);
  await mkdir(bodyOnlyRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(bodyOnlyRoot, "prd.md"), "外部正文", { mode: 0o600 });
  await expectCode(first(bodyOnly), "git_missing");
  expect(await readFile(join(bodyOnlyRoot, "prd.md"), "utf8")).toBe("外部正文");

  const missingHistory = await world();
  await expectCode(save({ ...missingHistory.config, action: "updateDraft", operationId: "save-1", expectedParent: "a".repeat(40), bytes: Buffer.from("目标") }), "git_missing");
});

test("文件替换后 Git 失败保留目标正文，清除锁后同操作从预期父提交安全完成", async () => {
  const w = await world();
  const initial = await first(w);
  const lock = join(initial.repositoryRoot, ".git", "refs", "heads", "main.lock");
  await writeFile(lock, "阻塞", { mode: 0o600 });
  const request = { ...w.config, action: "updateDraft" as const, operationId: "write-failed-1", expectedParent: initial.commit, bytes: Buffer.from("# Git 失败后的目标\n") };
  await expectCode(save(request), "git_failed");
  expect(await readFile(join(initial.repositoryRoot, "prd.md"), "utf8")).toBe("# Git 失败后的目标\n");
  expect((await git(["rev-parse", "HEAD"], initial.repositoryRoot, w.home)).trim()).toBe(initial.commit);
  await rm(lock);
  const resumed = await save(request);
  expect(resumed).toMatchObject({ status: "saved", parent: initial.commit, changed: true });
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(2);
});

test("未知 HEAD、外部正文、复用旧 operationId 和仓库目录身份变化均阻塞且不覆盖内容", async () => {
  const outsideHead = await world();
  const initial = await first(outsideHead);
  await git(["-c", "user.name=outside", "-c", "user.email=outside@example.com", "commit", "--allow-empty", "-m", "outside"], initial.repositoryRoot, outsideHead.home);
  const externalCommit = (await git(["rev-parse", "HEAD"], initial.repositoryRoot, outsideHead.home)).trim();
  await expectCode(save({ ...outsideHead.config, action: "updateDraft", operationId: "save-2", expectedParent: initial.commit, bytes: Buffer.from("不能覆盖") }), "identity_mismatch");
  expect((await git(["rev-parse", "HEAD"], initial.repositoryRoot, outsideHead.home)).trim()).toBe(externalCommit);

  const outsideBody = await world();
  const original = await first(outsideBody);
  await writeFile(join(original.repositoryRoot, "prd.md"), "编辑器中的新正文");
  await expectCode(save({ ...outsideBody.config, action: "updateDraft", operationId: "save-3", expectedParent: original.commit, bytes: Buffer.from("另一目标") }), "working_copy_mismatch");
  expect(await readFile(join(original.repositoryRoot, "prd.md"), "utf8")).toBe("编辑器中的新正文");

  const duplicateOperation = await world();
  const old = await first(duplicateOperation);
  const next = await save({ ...duplicateOperation.config, action: "updateDraft", operationId: "save-4", expectedParent: old.commit, bytes: Buffer.from("第二版") });
  await expectCode(save({ ...duplicateOperation.config, action: "confirmUpdate", operationId: "save-4", expectedParent: next.commit, bytes: Buffer.from("第三版") }), "operation_conflict");

  const replacedRepository = await world();
  const bound = await first(replacedRepository);
  const moved = join(replacedRepository.root, "old-git");
  await rename(join(bound.repositoryRoot, ".git"), moved);
  await cp(moved, join(bound.repositoryRoot, ".git"), { recursive: true });
  await expectCode(save({ ...replacedRepository.config, expectedRepositoryIdentity: bound.repositoryIdentity, action: "updateDraft", operationId: "save-5", expectedParent: bound.commit, bytes: Buffer.from("新内容") }), "repository_identity_mismatch");
}, 30_000);

test("额外暂存路径明确拒绝且不会混入正文提交或清掉外部暂存", async () => {
  const w = await world();
  const initial = await first(w);
  const source = join(w.root, "outside.txt");
  await writeFile(source, "外部暂存");
  const blob = (await git(["hash-object", "-w", source], initial.repositoryRoot, w.home)).trim();
  await git(["update-index", "--add", "--cacheinfo", `100644,${blob},outside.txt`], initial.repositoryRoot, w.home);
  await expectCode(save({ ...w.config, action: "updateDraft", operationId: "save-index", expectedParent: initial.commit, bytes: Buffer.from("新正文") }), "extra_index");
  expect((await git(["ls-files", "--stage", "outside.txt"], initial.repositoryRoot, w.home)).trim()).toContain(blob);
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(1);
});

test("恶意本地与全局 Git 配置、hook、filter、textconv、签名和远端探针均不执行", async () => {
  const w = await world();
  const initial = await first(w);
  const probe = join(w.root, "probe.sh");
  const sentinel = join(w.root, "executed");
  await writeFile(probe, `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\nexit 9\n`);
  await chmod(probe, 0o755);
  const hookDir = join(w.root, "hooks");
  await mkdir(hookDir);
  await cp(probe, join(hookDir, "pre-commit"));
  await chmod(join(hookDir, "pre-commit"), 0o755);
  await mkdir(join(initial.repositoryRoot, ".git", "info"), { recursive: true });
  await writeFile(join(initial.repositoryRoot, ".git", "info", "attributes"), "prd.md filter=probe diff=probe\n");
  await writeFile(join(initial.repositoryRoot, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\thooksPath = ${hookDir}\n\tworktree = ${join(w.root, "wrong-worktree")}\n[filter "probe"]\n\tclean = ${probe}\n\tsmudge = ${probe}\n\trequired = true\n[diff "probe"]\n\ttextconv = ${probe}\n[diff]\n\texternal = ${probe}\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${probe}\n[remote "origin"]\n\turl = ext::${probe}\n`);
  await writeFile(join(w.config.dataRoot, ".gitconfig"), `[include]\n\tpath = ${join(w.root, "global-evil")}\n[core]\n\thooksPath = ${hookDir}\n`);
  await writeFile(join(w.root, "global-evil"), `[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${probe}\n`);

  const saved = await save({ ...w.config, action: "updateDraft", operationId: "safe-config", expectedParent: initial.commit, bytes: Buffer.from("正文不经过 filter\n") });
  const difference = await diffVersions({ ...w.config, fromCommit: initial.commit, toCommit: saved.commit, expectedFromHash: initial.prdHash, expectedToHash: saved.prdHash });
  expect(difference.diff).toContain("正文不经过 filter");
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(saved.repositoryRoot, "prd.md"), "utf8")).toBe("正文不经过 filter\n");
  expect(await git(["show", `${saved.commit}:prd.md`], saved.repositoryRoot, w.home)).toBe("正文不经过 filter\n");
});

test("PATH 上没有 git 时明确失败", async () => {
  const missingWorld = await world();
  const emptyBin = join(missingWorld.root, "empty-bin");
  await mkdir(emptyBin);
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try { await expectCode(first(missingWorld), "git_unavailable"); }
  finally { process.env.PATH = originalPath; }
});

test("路径祖先链接、错误 .git 链接和权限拒绝不会被吞掉或写到链接目标", async () => {
  const linked = await world();
  const outside = join(linked.root, "outside");
  const alias = join(linked.root, "alias");
  await mkdir(outside);
  await symlink(outside, alias);
  await expectCode(first({ ...linked, config: { ...linked.config, dataRoot: join(alias, "private") } }), "unsafe_path");
  expect(await readdir(outside)).toEqual([]);

  const badGit = await world();
  const requirementRoot = prdRequirementPath(badGit.config);
  const externalGit = join(badGit.root, "external-git");
  await mkdir(requirementRoot, { recursive: true });
  await mkdir(externalGit);
  await symlink(externalGit, join(requirementRoot, ".git"));
  await expectCode(first(badGit), "git_invalid");

  const denied = await world();
  const created = await first(denied);
  await chmod(created.repositoryRoot, 0o000);
  try {
    await expect(readVersion({ ...denied.config, commit: created.commit, expectedHash: created.prdHash })).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(created.repositoryRoot, 0o700);
  }
});

test("读取前和正文返回前都重新授权；异步拒绝会安全吸收迟到 rejection", async () => {
  let readChecks = 0;
  const revoke = await world(({ action }) => action !== "readVersion" || ++readChecks === 1);
  const initial = await first(revoke);
  await expectCode(readVersion({ ...revoke.config, commit: initial.commit, expectedHash: initial.prdHash }), "permission_denied");
  expect(readChecks).toBe(2);

  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const late = await world((() => Promise.reject(new Error("late denial"))) as PrdStorageAuthorize);
    await expectCode(first(late), "permission_denied");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("返回前撤权使已完成 Git 提交保持可恢复状态，重试复用同提交", async () => {
  let denyReturn = true;
  const w = await world(({ phase }) => phase !== "beforeReturn" || !denyReturn);
  const request = { ...w.config, operationId: "return-revoked", expectedParent: null, bytes: Buffer.from("已提交但未返回\n") };
  await expectCode(create(request), "permission_denied");
  const repositoryRoot = prdRequirementPath(w.config);
  const committed = (await git(["rev-parse", "HEAD"], repositoryRoot, w.home)).trim();
  denyReturn = false;
  const recovered = await create(request);
  expect(recovered).toMatchObject({ status: "recovered", commit: committed });
  expect(await commitCount(repositoryRoot, w.home)).toBe(1);
});

test("只允许当前 main 线性历史中的完整版本，侧支对象不能用于读取或 diff", async () => {
  const w = await world();
  const initial = await first(w);
  const tree = (await git(["rev-parse", `${initial.commit}^{tree}`], initial.repositoryRoot, w.home)).trim();
  const side = (await git(["-c", "user.name=outside", "-c", "user.email=outside@example.com", "commit-tree", tree, "-m", "side"], initial.repositoryRoot, w.home)).trim();
  expect(side).toMatch(/^[0-9a-f]{40}$/);
  await expectCode(readVersion({ ...w.config, commit: side, expectedHash: initial.prdHash }), "unknown_version");
  await expectCode(diffVersions({ ...w.config, fromCommit: initial.commit, toCommit: side, expectedFromHash: initial.prdHash, expectedToHash: initial.prdHash }), "unknown_version");
  await expectCode(readVersion({ ...w.config, commit: initial.commit.slice(0, 12), expectedHash: initial.prdHash }), "invalid_commit");
});

test("仓库中的未登记工作正文阻止保存，但精确历史读取不读取未授权的当前工作正文", async () => {
  const w = await world();
  const initial = await first(w);
  await writeFile(join(initial.repositoryRoot, "prd.md"), "外部内容");
  await expectCode(save({ ...w.config, action: "updateDraft", operationId: "same-looking", expectedParent: initial.commit, bytes: Buffer.from("# 第一版\n") }), "working_copy_mismatch");
  expect(Buffer.from((await readVersion({ ...w.config, commit: initial.commit, expectedHash: initial.prdHash })).bytes).toString()).toBe("# 第一版\n");
  expect(await readFile(join(initial.repositoryRoot, "prd.md"), "utf8")).toBe("外部内容");
});

test("beforeWrite 授权回调后的外部正文替换按原身份和 hash 检出且不会覆盖", async () => {
  let prdPath = "";
  let injected = false;
  const w = await world((check) => {
    if (check.phase === "beforeWrite" && check.action === "save" && !injected) {
      injected = true;
      writeFileSync(prdPath, "external-user-bytes");
    }
    return true;
  });
  const initial = await first(w);
  prdPath = join(initial.repositoryRoot, "prd.md");
  await expectCode(save({
    ...w.config,
    action: "updateDraft",
    operationId: "external-during-auth",
    expectedParent: initial.commit,
    bytes: Buffer.from("内部目标字节"),
  }), "working_copy_changed");
  expect(await readFile(prdPath, "utf8")).toBe("external-user-bytes");
  const recoveryTemps = (await readdir(initial.repositoryRoot)).filter((entry) => entry.startsWith(".prd-storage-external-during-auth-") && entry.endsWith(".tmp"));
  expect(recoveryTemps).toHaveLength(1);
  expect(await readFile(join(initial.repositoryRoot, recoveryTemps[0]!))).toEqual(Buffer.from("内部目标字节"));
  expect(await commitCount(initial.repositoryRoot, w.home)).toBe(1);
});

test("读取接口首次授权携带精确提交和预期 hash，且不读取请求外的历史正文", async () => {
  const checks: Parameters<PrdStorageAuthorize>[0][] = [];
  const w = await world((check) => { checks.push({ ...check }); return true; });
  const initial = await first(w, "版本一");
  const second = await save({ ...w.config, action: "updateDraft", operationId: "version-2", expectedParent: initial.commit, bytes: Buffer.from("版本二") });
  const latest = await save({ ...w.config, action: "confirmUpdate", operationId: "version-3", expectedParent: second.commit, bytes: Buffer.from("版本三") });

  checks.length = 0;
  await readVersion({ ...w.config, commit: latest.commit, expectedHash: latest.prdHash });
  expect(checks[0]).toMatchObject({ phase: "beforeAction", action: "readVersion", commit: latest.commit, expectedHash: latest.prdHash });

  checks.length = 0;
  await verifyVersion({ ...w.config, commit: latest.commit, expectedHash: latest.prdHash });
  expect(checks[0]).toMatchObject({ phase: "beforeAction", action: "verifyVersion", commit: latest.commit, expectedHash: latest.prdHash });

  checks.length = 0;
  await diffVersions({
    ...w.config,
    fromCommit: second.commit,
    toCommit: latest.commit,
    expectedFromHash: second.prdHash,
    expectedToHash: latest.prdHash,
  });
  expect(checks[0]).toMatchObject({
    phase: "beforeAction",
    action: "diffVersions",
    fromCommit: second.commit,
    toCommit: latest.commit,
    expectedFromHash: second.prdHash,
    expectedToHash: latest.prdHash,
  });

  const oldBlob = (await git(["rev-parse", `${initial.commit}:prd.md`], initial.repositoryRoot, w.home)).trim();
  const oldBlobPath = join(initial.repositoryRoot, ".git", "objects", oldBlob.slice(0, 2), oldBlob.slice(2));
  await rename(oldBlobPath, join(w.root, "held-old-prd-blob"));
  expect(Buffer.from((await readVersion({ ...w.config, commit: latest.commit, expectedHash: latest.prdHash })).bytes).toString()).toBe("版本三");
  await expectCode(readVersion({ ...w.config, commit: initial.commit, expectedHash: initial.prdHash }), "git_failed");
}, 30_000);

test("update-ref 后 index 更新中断可由同 operation 精确补齐", async () => {
  let indexLock = "";
  let injectLock = true;
  const w = await world((check) => {
    if (check.phase === "beforeWrite" && check.action === "create" && injectLock) {
      injectLock = false;
      writeFileSync(indexLock, "阻塞");
    }
    return true;
  });
  indexLock = join(prdRequirementPath(w.config), ".git", "index.lock");
  const request = { ...w.config, operationId: "index-create", expectedParent: null, bytes: Buffer.from("首次正文") };
  await expectCode(create(request), "git_failed");
  const repositoryRoot = prdRequirementPath(w.config);
  const committed = (await git(["rev-parse", "HEAD"], repositoryRoot, w.home)).trim();
  expect(await git(["ls-files", "--stage"], repositoryRoot, w.home)).toBe("");
  await rm(indexLock);
  const recovered = await create(request);
  expect(recovered).toMatchObject({ status: "recovered", commit: committed });
  expect(await commitCount(repositoryRoot, w.home)).toBe(1);
  expect(await git(["status", "--porcelain"], repositoryRoot, w.home)).toBe("");

  const update = await world();
  const parent = await first(update);
  const updateLock = join(parent.repositoryRoot, ".git", "index.lock");
  await writeFile(updateLock, "阻塞", { mode: 0o600 });
  const updateRequest = { ...update.config, action: "updateDraft" as const, operationId: "index-update", expectedParent: parent.commit, bytes: Buffer.from("更新正文") };
  await expectCode(save(updateRequest), "git_failed");
  const updatedCommit = (await git(["rev-parse", "HEAD"], parent.repositoryRoot, update.home)).trim();
  await rm(updateLock);
  expect(await save(updateRequest)).toMatchObject({ status: "recovered", commit: updatedCommit, parent: parent.commit });
  expect(await commitCount(parent.repositoryRoot, update.home)).toBe(2);
  expect(await git(["status", "--porcelain"], parent.repositoryRoot, update.home)).toBe("");
}, 30_000);

test("同 operation 恢复遇到非旧父树也非新树的外部 index 时保留并阻塞", async () => {
  const w = await world();
  const parent = await first(w);
  const indexLock = join(parent.repositoryRoot, ".git", "index.lock");
  await writeFile(indexLock, "阻塞", { mode: 0o600 });
  const request = { ...w.config, action: "updateDraft" as const, operationId: "index-save", expectedParent: parent.commit, bytes: Buffer.from("本操作目标") };
  await expectCode(save(request), "git_failed");
  const committed = (await git(["rev-parse", "HEAD"], parent.repositoryRoot, w.home)).trim();
  expect(committed).not.toBe(parent.commit);
  await rm(indexLock);
  const source = join(w.root, "external-index-body");
  await writeFile(source, "外部 index 字节");
  const externalBlob = (await git(["hash-object", "-w", source], parent.repositoryRoot, w.home)).trim();
  await git(["update-index", "--add", "--cacheinfo", `100644,${externalBlob},prd.md`], parent.repositoryRoot, w.home);
  await expectCode(save(request), "external_index");
  expect(await git(["ls-files", "--stage", "prd.md"], parent.repositoryRoot, w.home)).toContain(externalBlob);
  expect((await git(["rev-parse", "HEAD"], parent.repositoryRoot, w.home)).trim()).toBe(committed);
  expect(await commitCount(parent.repositoryRoot, w.home)).toBe(2);
});

test("尾随换行的 requirementId、repoId、operationId、提交和 hash 在文件或 Git 副作用前拒绝", async () => {
  const invalidOperation = await world();
  await expectCode(create({ ...invalidOperation.config, operationId: "create-1\n", expectedParent: null, bytes: Buffer.from("正文") }), "invalid_operation");
  await expect(lstat(invalidOperation.config.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });

  const invalidRequirement = await world();
  await expectCode(create({ ...invalidRequirement.config, requirementId: `${REQUIREMENT_ID}\n`, operationId: "create-1", expectedParent: null, bytes: Buffer.from("正文") }), "invalid_requirement_id");
  await expect(lstat(invalidRequirement.config.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });

  const invalidRepo = await world();
  await expectCode(create({ ...invalidRepo.config, repoId: "repo-1\n", operationId: "create-1", expectedParent: null, bytes: Buffer.from("正文") }), "invalid_config");
  await expect(lstat(invalidRepo.config.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });

  let authorizationCalls = 0;
  const committed = await world(() => { authorizationCalls += 1; return true; });
  const initial = await first(committed);
  const callsAfterCreate = authorizationCalls;
  await expectCode(readVersion({ ...committed.config, commit: `${initial.commit}\n`, expectedHash: initial.prdHash }), "invalid_commit");
  await expectCode(readVersion({ ...committed.config, commit: initial.commit, expectedHash: `${initial.prdHash}\n` as `sha256:${string}` }), "hash_mismatch");
  await expectCode(save({ ...committed.config, action: "updateDraft", operationId: "save-1", expectedParent: `${initial.commit}\n`, bytes: Buffer.from("下一版") }), "invalid_commit");
  expect(authorizationCalls).toBe(callsAfterCreate);
  expect(await commitCount(initial.repositoryRoot, committed.home)).toBe(1);
});

test("固定接口错误使用不会初始化仓库，也不会把 commit message 当作批准状态", async () => {
  const w = await world();
  await expectCode(create({ ...w.config, operationId: "wrong-parent", expectedParent: "a".repeat(40), bytes: Buffer.from("内容") }), "invalid_parent");
  await expectCode(save({ ...w.config, action: "create" as never, operationId: "wrong-action", expectedParent: null, bytes: Buffer.from("内容") }), "invalid_action");
  expect(await lstat(w.config.dataRoot).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")).toBe(false);
  expect(PrdStorageError).toBeTypeOf("function");
});

test("M9：授权回调抛出带原因的拒绝时，存储层的报错带上这个原因", async () => {
  const w = await world(() => { throw Object.assign(new Error("拒绝"), { advice: { why: "投递凭据已过期", next: "等下一次自动投递" } }); });
  const rejected = await first(w).catch((error: unknown) => error);
  expect(rejected).toMatchObject({ name: "PrdStorageError", code: "permission_denied" });
  expect((rejected as Error).message).toContain("投递凭据已过期");
});
