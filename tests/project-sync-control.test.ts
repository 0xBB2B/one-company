import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientInfo } from "../daemon/server.ts";
import { connectDaemon } from "../runtime/daemon-client.ts";
import type { DaemonClient, DaemonConnectionIdentity } from "../runtime/daemon-client.ts";
import { LocalDatabase, repositoryDatabase } from "../runtime/database.ts";
import { daemonSocketPath, repoDataDir, repositoryIdentity } from "../runtime/identity.ts";
import { ProjectIndexService } from "../runtime/project-index-service.ts";
import { PROJECT_INDEX_GRANT_NAMESPACE, ProjectSyncGrantIssuer } from "../runtime/project-sync-grants.ts";
import type { IssuedProjectSyncGrant } from "../runtime/project-sync-grants.ts";
import { PROTOCOL_VERSION } from "../runtime/protocol.ts";
import { connectTestClient, resolveSdkDir } from "./helpers/daemon-harness.ts";
import type { TestClient } from "./helpers/daemon-harness.ts";
import { createRepoFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { RepoFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const repos: RepoFixture[] = [];
const roots: string[] = [];
const clients: Array<DaemonClient | TestClient> = [];
const issuers: ProjectSyncGrantIssuer[] = [];
interface ChildHandle { proc: ChildProcess; exited: Promise<number | null>; stderr: () => string; stdout: () => string }
const children: ChildHandle[] = [];

async function startChild(repositoryRoot: string, dataRoot: string): Promise<ChildHandle> {
  const entry = fileURLToPath(new URL("./helpers/project-sync-control-child.ts", import.meta.url));
  const proc = spawn(process.execPath, [entry, JSON.stringify({ repositoryRoot, dataRoot })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  let stdout = "";
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  const handle = { proc, exited, stderr: () => stderr, stdout: () => stdout };
  children.push(handle);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("跨进程验证器启动超时")), 10_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      proc.off("message", onMessage);
      proc.off("error", onError);
      proc.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const onMessage = (message: unknown) => { if ((message as { ready?: boolean })?.ready) finish(); };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error("跨进程验证器提前退出"));
    proc.on("message", onMessage);
    proc.once("error", onError);
    proc.once("exit", onExit);
  });
  return handle;
}

async function stopChild(child: ChildHandle): Promise<number | null> {
  if (child.proc.exitCode !== null || child.proc.signalCode !== null) return child.exited;
  if (child.proc.connected) child.proc.send("stop");
  const timer = setTimeout(() => { child.proc.kill("SIGKILL"); }, 5_000);
  try { return await child.exited; } finally { clearTimeout(timer); }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) await stopChild(child);
  for (const issuer of issuers.splice(0)) await issuer.close();
  for (const repo of repos.splice(0)) await removeRepoFixture(repo);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function world() {
  const repo = await createRepoFixture();
  repos.push(repo);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  roots.push(dataRoot);
  const identity = await repositoryIdentity(repo.root);
  await repoDataDir(dataRoot, identity.repoId, identity.commonDir);
  const service = await ProjectIndexService.open({ repositoryRoot: repo.root, dataRoot, repoId: identity.repoId, authorize: () => true });
  const hello = { windowId: "trusted-host", sessionId: "host-session", pid: process.pid, cwd: repo.root, workspaceRoot: repo.root };
  return { repo, dataRoot, identity, workspace: service.workspace, hello, socketPath: daemonSocketPath(dataRoot, identity.repoId) };
}

function scope(issued: IssuedProjectSyncGrant): Record<string, unknown> {
  return { action: "preview", grantId: issued.grantId, repoId: issued.workspace.repoId,
    workspaceId: issued.workspace.workspaceId, repositoryRoot: issued.workspace.root, branch: issued.workspace.branch };
}

function issuerFor(w: Awaited<ReturnType<typeof world>>, currentConnectionIdentity: () => Readonly<DaemonConnectionIdentity> | null) {
  const principal = {};
  const issuer = new ProjectSyncGrantIssuer({ dataRoot: w.dataRoot, ...w.identity, hostPrincipal: principal,
    currentHostPrincipal: () => principal, currentConnectionIdentity, authorize: () => true });
  issuers.push(issuer);
  return issuer;
}

function hostClient(w: Awaited<ReturnType<typeof world>>, identity: Readonly<DaemonConnectionIdentity>): ClientInfo {
  return { ...w.hello, repoIds: [w.identity.repoId], daemonInstanceId: identity.daemonInstanceId, connectionId: identity.connectionId };
}

test("真实两个Node进程经握手身份和共享临时DB签发/验证，伪token、跨连接、host关闭及daemon重启拒绝", async () => {
  const w = await world();
  const child = await startChild(w.repo.root, w.dataRoot);
  expect(child.proc.pid).not.toBe(process.pid);
  const connect = async () => {
    const client = await connectDaemon({ repoDir: w.repo.root, dataRoot: w.dataRoot, sdkDir: resolveSdkDir(), hello: w.hello });
    clients.push(client);
    return client;
  };
  const client = await connect();
  const current = client.connectionIdentity!()!;
  expect(current).not.toBeNull();
  const issuer = issuerFor(w, () => client.connectionIdentity!());
  const grant = await issuer.issue(hostClient(w, current), w.workspace);
  const response = await client.call("index.sync", scope(grant));
  expect(response).toEqual({ verified: true, workspace: w.workspace, verifierPid: child.proc.pid });
  expect(await client.call("hello")).toMatchObject(current);
  expect(await client.call("index.sync", scope(grant))).toEqual(response);
  await expect(client.call("index.sync", { ...scope(grant), grantId: randomUUID() })).rejects.toMatchObject({ code: "grant_invalid" });
  const second = await connect();
  await expect(second.call("index.sync", scope(grant))).rejects.toMatchObject({ code: "grant_invalid" });
  await issuer.close();
  await expect(client.call("index.sync", scope(grant))).rejects.toMatchObject({ code: "grant_invalid" });

  const restartIssuer = issuerFor(w, () => client.connectionIdentity!());
  const beforeRestart = await restartIssuer.issue(hostClient(w, current), w.workspace);
  client.close();
  second.close();
  expect(client.connectionIdentity!()).toBeNull();
  expect(await stopChild(child)).toBe(0);
  const restarted = await startChild(w.repo.root, w.dataRoot);
  const next = await connect();
  const nextIdentity = next.connectionIdentity!()!;
  expect(nextIdentity.daemonInstanceId === current.daemonInstanceId).toBe(false);
  await expect(next.call("index.sync", scope(beforeRestart))).rejects.toMatchObject({ code: "grant_invalid" });
  const nextIssuer = issuerFor(w, () => next.connectionIdentity!());
  const valid = await nextIssuer.issue(hostClient(w, nextIdentity), w.workspace);
  expect(await next.call("index.sync", scope(valid))).toMatchObject({ verified: true, verifierPid: restarted.proc.pid });

  const path = repositoryDatabase(w.dataRoot, w.identity.repoId);
  const db = new LocalDatabase(path);
  let serialized = "";
  try { serialized = JSON.stringify(db.list(PROJECT_INDEX_GRANT_NAMESPACE)); } finally { db.close(); }
  for (const grantId of [grant.grantId, beforeRestart.grantId, valid.grantId]) {
    expect(serialized.includes(grantId)).toBe(false);
    expect(child.stdout().includes(grantId) || child.stderr().includes(grantId)).toBe(false);
    expect(restarted.stdout().includes(grantId) || restarted.stderr().includes(grantId)).toBe(false);
    for (const suffix of ["", "-wal", "-shm"]) {
      const bytes = await readFile(path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return Buffer.alloc(0);
      });
      expect(bytes.includes(Buffer.from(grantId))).toBe(false);
    }
  }
}, 30_000);

test("跨进程同socket重hello退役旧token，未带新身份的宿主不能签发", async () => {
  const w = await world();
  await startChild(w.repo.root, w.dataRoot);
  const raw = await connectTestClient(w.socketPath, { ...w.hello, repoIds: [w.identity.repoId] });
  clients.push(raw);
  let connection: Readonly<DaemonConnectionIdentity> = {
    daemonInstanceId: raw.helloResult.daemonInstanceId as string, connectionId: raw.helloResult.connectionId as string, connectionSequence: 1,
  };
  const issuer = issuerFor(w, () => connection);
  const originalClient = hostClient(w, connection);
  const grant = await issuer.issue(originalClient, w.workspace);
  expect(await raw.call("index.sync", scope(grant))).toMatchObject({ verified: true });
  const rehello = await raw.call("hello", { ...w.hello, repoIds: [w.identity.repoId], protocolVersion: PROTOCOL_VERSION });
  connection = { daemonInstanceId: rehello.daemonInstanceId as string, connectionId: rehello.connectionId as string, connectionSequence: 2 };
  expect(connection.connectionId === originalClient.connectionId).toBe(false);
  await expect(raw.call("index.sync", scope(grant))).rejects.toThrow("grant_invalid");
  await expect(issuer.issue(originalClient, w.workspace)).rejects.toMatchObject({ code: "authorization_denied" });
  const next = await issuer.issue(hostClient(w, connection), w.workspace);
  expect(await raw.call("index.sync", scope(next))).toMatchObject({ verified: true });
}, 30_000);
