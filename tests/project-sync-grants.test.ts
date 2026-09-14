import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClientInfo } from "../daemon/server.ts";
import { LocalDatabase, repositoryDatabase } from "../runtime/database.ts";
import { repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import {
  PROJECT_INDEX_GRANT_NAMESPACE,
  ProjectSyncGrantIssuer,
  ProjectSyncGrantVerifier,
} from "../runtime/project-sync-grants.ts";
import { createRepoFixture, GIT_ENV, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const repos: RepoFixture[] = [];
const issuers: ProjectSyncGrantIssuer[] = [];

function client(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    windowId: "window-a",
    sessionId: "session-a",
    pid: process.pid,
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    repoIds: [],
    daemonInstanceId: randomUUID(),
    connectionId: randomUUID(),
    ...overrides,
  };
}

async function world() {
  const repo = await createRepoFixture();
  repos.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "project-grants-"));
  roots.push(dataRoot);
  const identity = await repositoryIdentity(repo.root);
  await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  const service = await ProjectIndexService.open({ repositoryRoot: repo.root, dataRoot, repoId: identity.repoId, authorize: () => true });
  const connected = client({ cwd: repo.root, workspaceRoot: repo.root, repoIds: [identity.repoId] });
  return { repo, dataRoot, identity, workspace: service.workspace, connected };
}

function issuerFor(w: Awaited<ReturnType<typeof world>>, options: { allow?: boolean; principal?: object; current?: () => object | null } = {}) {
  const principal = options.principal ?? {};
  const issuer = new ProjectSyncGrantIssuer({
    dataRoot: w.dataRoot,
    repoId: w.identity.repoId,
    commonDir: w.identity.commonDir,
    hostPrincipal: principal,
    currentHostPrincipal: options.current ?? (() => principal),
    currentConnectionIdentity: () => ({ daemonInstanceId: w.connected.daemonInstanceId!, connectionId: w.connected.connectionId!, connectionSequence: 1 }),
    authorize: options.allow === undefined ? undefined : () => options.allow === true,
  });
  issuers.push(issuer);
  return issuer;
}

afterEach(async () => {
  for (const issuer of issuers.splice(0)) await issuer.close();
  for (const repo of repos.splice(0).reverse()) await removeRepoFixture(repo);
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

test("默认拒绝，authorize只收到固定事实且不能由role/approved入参伪造许可", async () => {
  const w = await world();
  await expect(issuerFor(w).issue(w.connected, w.workspace)).rejects.toMatchObject({ code: "authorization_denied" });

  const principal = {};
  let request: Record<string, unknown> | undefined;
  const issuer = new ProjectSyncGrantIssuer({
    dataRoot: w.dataRoot,
    repoId: w.identity.repoId,
    commonDir: w.identity.commonDir,
    hostPrincipal: principal,
    currentHostPrincipal: () => principal,
    currentConnectionIdentity: () => ({ daemonInstanceId: w.connected.daemonInstanceId!, connectionId: w.connected.connectionId!, connectionSequence: 1 }),
    authorize(value, actualPrincipal) {
      expect(actualPrincipal).toBe(principal);
      request = value as unknown as Record<string, unknown>;
      return true;
    },
  });
  issuers.push(issuer);
  const issued = await issuer.issue(w.connected, w.workspace);
  expect(issued.grantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(request).toEqual({
    action: "issue_project_index_scan",
    repoId: w.identity.repoId,
    workspaceId: w.workspace.workspaceId,
    repositoryRoot: w.repo.root,
    branch: w.workspace.branch,
    windowId: w.connected.windowId,
    sessionId: w.connected.sessionId,
    pid: w.connected.pid,
  });
  expect(request).not.toHaveProperty("role");
  expect(request).not.toHaveProperty("approved");
  expect(issuer.validateForClient(issued.grantId, w.connected, w.workspace).workspace).toEqual(w.workspace);
});

test("许可绑定真实ClientInfo对象、repo/root/workspace/branch和session，伪造与跨范围均拒绝", async () => {
  const w = await world();
  const issuer = issuerFor(w, { allow: true });
  const issued = await issuer.issue(w.connected, w.workspace);

  expect(() => issuer.validateForClient(randomUUID(), w.connected, w.workspace)).toThrowError(expect.objectContaining({ code: "grant_invalid" }));
  expect(() => issuer.validateForClient(issued.grantId, { ...w.connected }, w.workspace)).toThrowError(expect.objectContaining({ code: "grant_invalid" }));
  expect(() => issuer.validateForClient(issued.grantId, w.connected, { ...w.workspace, root: `${w.workspace.root}-other` }))
    .toThrowError(expect.objectContaining({ code: "grant_invalid" }));
  expect(() => issuer.validateForClient(issued.grantId, w.connected, { ...w.workspace, workspaceId: "0".repeat(64) }))
    .toThrowError(expect.objectContaining({ code: "grant_invalid" }));

  w.connected.sessionId = "stale-session";
  expect(() => issuer.validateForClient(issued.grantId, w.connected, w.workspace)).toThrowError(expect.objectContaining({ code: "grant_invalid" }));
});

test("分支或可信宿主principal变化后fail closed", async () => {
  const w = await world();
  const principal = {};
  let current: object | null = principal;
  const issuer = issuerFor(w, { allow: true, principal, current: () => current });
  const issued = await issuer.issue(w.connected, w.workspace);
  current = {};
  expect(() => issuer.validateForClient(issued.grantId, w.connected, w.workspace)).toThrowError(expect.objectContaining({ code: "authorization_denied" }));
  current = principal;

  await exec("git", ["checkout", "-b", "changed-branch"], { cwd: w.repo.root, env: GIT_ENV });
  expect(() => issuer.validateForClient(issued.grantId, w.connected, w.workspace)).toThrowError(expect.objectContaining({ code: "grant_invalid" }));
});

test("仅准确issuer可撤销；shutdown即使主context先失效也清掉本issuer全部许可", async () => {
  const w = await world();
  const principal = {};
  let current: object | null = principal;
  const first = issuerFor(w, { allow: true, principal, current: () => current });
  const second = issuerFor(w, { allow: true });
  const one = await first.issue(w.connected, w.workspace);
  const two = await first.issue(w.connected, w.workspace);

  expect(await second.revokeExact(one.grantId)).toBe(false);
  expect(first.validateForClient(one.grantId, w.connected, w.workspace)).toBeDefined();
  expect(await first.revokeExact(one.grantId)).toBe(true);
  expect(() => first.validateForClient(one.grantId, w.connected, w.workspace)).toThrowError(expect.objectContaining({ code: "grant_invalid" }));

  current = null;
  await first.close();
  const db = new LocalDatabase(repositoryDatabase(w.dataRoot, w.identity.repoId));
  try {
    const rows = db.list<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.data.status === "revoked")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("prodBody");
    expect(JSON.stringify(rows)).not.toContain(one.grantId);
    expect(JSON.stringify(rows)).not.toContain(two.grantId);
    expect(rows.find((row) => row.key === createHash("sha256").update(two.grantId).digest("hex"))?.data).toMatchObject({ workspaceId: w.workspace.workspaceId, status: "revoked" });
  } finally { db.close(); }
});

function verifierFor(w: Awaited<ReturnType<typeof world>>, daemonInstanceId = w.connected.daemonInstanceId!) {
  return new ProjectSyncGrantVerifier({ dataRoot: w.dataRoot, ...w.identity, daemonInstanceId });
}

test("独立验证器按持久化hash核验，跨连接/daemon重启/旧结构拒绝，DB/WAL不含明文token", async () => {
  const w = await world();
  const issuer = issuerFor(w, { allow: true });
  const issued = await issuer.issue(w.connected, w.workspace);
  const verifier = verifierFor(w);
  expect(verifier.validateForClient(issued.grantId, { ...w.connected }, w.workspace).workspace).toEqual(w.workspace);
  for (const changed of [
    { connectionId: randomUUID() }, { daemonInstanceId: randomUUID() }, { connectionId: undefined },
    { sessionId: "other" }, { windowId: "other" }, { pid: process.pid + 1 }, { repoIds: [] },
  ]) expect(() => verifier.validateForClient(issued.grantId, { ...w.connected, ...changed }, w.workspace)).toThrow();
  const restartedId = randomUUID();
  expect(() => verifierFor(w, restartedId).validateForClient(issued.grantId, { ...w.connected, daemonInstanceId: restartedId }, w.workspace)).toThrow();
  expect(() => verifier.validateForClient(randomUUID(), w.connected, w.workspace)).toThrow();
  const path = repositoryDatabase(w.dataRoot, w.identity.repoId);
  for (const suffix of ["", "-wal", "-shm"]) {
    const bytes = await readFile(path + suffix).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return Buffer.alloc(0);
    });
    expect(bytes.includes(Buffer.from(issued.grantId))).toBe(false);
  }
  const db = new LocalDatabase(path);
  try {
    const hash = createHash("sha256").update(issued.grantId).digest("hex");
    const row = db.read<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE, hash)!;
    const { connectionId: _connectionId, ...legacy } = row.data;
    db.update(PROJECT_INDEX_GRANT_NAMESPACE, hash, row.version, legacy);
  } finally { db.close(); }
  expect(() => verifier.validateForClient(issued.grantId, w.connected, w.workspace)).toThrow();
  // 恢复测试自己写坏的固定元数据，使issuer可完成准确撤权和清理。
  const repair = new LocalDatabase(path);
  try {
    const hash = createHash("sha256").update(issued.grantId).digest("hex");
    const row = repair.read<Record<string, unknown>>(PROJECT_INDEX_GRANT_NAMESPACE, hash)!;
    const restored = { ...row.data, connectionId: w.connected.connectionId };
    const old = repair.update(PROJECT_INDEX_GRANT_NAMESPACE, hash, row.version, { ...restored, schemaVersion: 1 });
    expect(() => verifier.validateForClient(issued.grantId, w.connected, w.workspace)).toThrow();
    repair.update(PROJECT_INDEX_GRANT_NAMESPACE, hash, old, restored);
  } finally { repair.close(); }
});

test("验证器revokeExact仅撤销当前daemon准确token；宿主close立即让另一验证器拒绝", async () => {
  const w = await world();
  const issuer = issuerFor(w, { allow: true });
  const first = await issuer.issue(w.connected, w.workspace);
  const second = await issuer.issue(w.connected, w.workspace);
  const verifier = verifierFor(w);
  expect(await verifierFor(w, randomUUID()).revokeExact(first.grantId)).toBe(false);
  expect(await verifier.revokeExact(randomUUID())).toBe(false);
  expect(await verifier.revokeExact(first.grantId)).toBe(true);
  expect(await verifier.revokeExact(first.grantId)).toBe(true);
  expect(() => verifier.validateForClient(first.grantId, w.connected, w.workspace)).toThrow();
  expect(verifier.validateForClient(second.grantId, w.connected, w.workspace)).toBeDefined();
  const closed = issuer.close();
  expect(() => verifier.validateForClient(second.grantId, w.connected, w.workspace)).toThrow();
  await closed;
});

test.each(["close", "principal", "connection", "session", "authorization"] as const)("异步身份检查期间%s失效，晚到issue不写DB", async (failure) => {
  const w = await world();
  const principal = {};
  let current: object | null = principal;
  let connected = true;
  let allowed = true;
  let authorizations = 0;
  let closePromise: Promise<void> | undefined;
  const issuer = new ProjectSyncGrantIssuer({
    dataRoot: w.dataRoot, ...w.identity, hostPrincipal: principal,
    currentHostPrincipal: () => current,
    currentConnectionIdentity: () => connected ? { daemonInstanceId: w.connected.daemonInstanceId!, connectionId: w.connected.connectionId!, connectionSequence: 1 } : null,
    authorize() {
      authorizations += 1;
      if (authorizations === 1) queueMicrotask(() => {
        if (failure === "close") closePromise = issuer.close();
        if (failure === "principal") current = null;
        if (failure === "connection") connected = false;
        if (failure === "session") w.connected.sessionId = "new-session";
        if (failure === "authorization") allowed = false;
      });
      return allowed;
    },
  });
  issuers.push(issuer);
  await expect(issuer.issue(w.connected, w.workspace)).rejects.toBeDefined();
  await closePromise;
  const db = new LocalDatabase(repositoryDatabase(w.dataRoot, w.identity.repoId));
  try { expect(db.list(PROJECT_INDEX_GRANT_NAMESPACE)).toEqual([]); }
  finally { db.close(); }
});

test("缺当前连接回调不签发；目录inode变化后验证器拒绝", async () => {
  const w = await world();
  const principal = {};
  const missing = new ProjectSyncGrantIssuer({ dataRoot: w.dataRoot, ...w.identity, hostPrincipal: principal, currentHostPrincipal: () => principal, authorize: () => true });
  issuers.push(missing);
  await expect(missing.issue(w.connected, w.workspace)).rejects.toMatchObject({ code: "authorization_denied" });
  const issued = await issuerFor(w, { allow: true }).issue(w.connected, w.workspace);
  const moved = `${w.repo.root}-moved`;
  await rename(w.repo.root, moved);
  try {
    expect(() => verifierFor(w).validateForClient(issued.grantId, w.connected, w.workspace)).toThrow();
    await mkdir(w.repo.root);
    await writeFile(join(w.repo.root, ".git"), `gitdir: ${join(moved, ".git")}\n`);
    expect(() => verifierFor(w).validateForClient(issued.grantId, w.connected, w.workspace)).toThrow();
  } finally {
    await rm(w.repo.root, { recursive: true, force: true });
    await rename(moved, w.repo.root);
  }
});
