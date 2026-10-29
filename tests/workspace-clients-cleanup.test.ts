import { afterEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { createErrorResponse, createResponse, decodeFrames, encodeFrame, PROTOCOL_VERSION } from "../src/core/host/protocol.ts";
import { daemonSocketPath, repositoryIdentity } from "../src/core/storage/identity.ts";
import { createWorkspaceFixture, removeRepoFixture } from "./helpers/repo-fixture.ts";
import type { WorkspaceFixture } from "./helpers/repo-fixture.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const injected = vi.hoisted(() => ({ brokenName: "", delayMs: 0 }));

vi.mock("../src/core/storage/identity.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/storage/identity.ts")>();
  return {
    ...original,
    repositoryIdentity: async (repoDir: string) => {
      if (injected.brokenName && repoDir.endsWith(`/${injected.brokenName}`)) {
        await new Promise((resolve) => setTimeout(resolve, injected.delayMs));
        throw new Error("读取仓库身份失败（测试注入）");
      }
      return original.repositoryIdentity(repoDir);
    },
  };
});

const { WorkspaceClients, resolveSdkDir } = await import("../src/core/host/daemon-client.ts");

const workspaces: WorkspaceFixture[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  injected.brokenName = "";
  for (const server of servers.splice(0)) server.close();
  for (const workspace of workspaces.splice(0)) await removeRepoFixture(workspace);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件满足超时（${timeoutMs}ms）`);
}

async function startHealthyDaemon(socketPath: string, repoId: string, helloDelayMs: number): Promise<{ open: () => number; helloed: () => number }> {
  const sockets = new Set<Socket>();
  let helloed = 0;
  await mkdir(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.t !== "req") continue;
        if (frame.method !== "hello") {
          socket.write(encodeFrame(createErrorResponse(frame.id, "unknown_method", `未知方法: ${frame.method}`)));
          continue;
        }
        setTimeout(() => {
          helloed += 1;
          socket.write(encodeFrame(createResponse(frame.id, {
            daemonPid: process.pid, repoId, protocolVersion: PROTOCOL_VERSION, startedAt: new Date().toISOString(),
            daemonInstanceId: randomUUID(), connectionId: randomUUID(),
          })));
        }, helloDelayMs);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return { open: () => sockets.size, helloed: () => helloed };
}

async function scenario(options: { helloDelayMs: number; brokenDelayMs: number }) {
  const workspace = await createWorkspaceFixture();
  workspaces.push(workspace);
  const dataRoot = await mkdtemp(join(temporaryRoot(), "d"));
  dirs.push(dataRoot);
  const [healthyDir, brokenDir] = workspace.repos as [string, string];
  const healthy = await repositoryIdentity(healthyDir);
  const daemon = await startHealthyDaemon(daemonSocketPath(dataRoot, healthy.repoId), healthy.repoId, options.helloDelayMs);
  injected.brokenName = basename(brokenDir);
  injected.delayMs = options.brokenDelayMs;
  const created = WorkspaceClients.create({
    workspaceRoot: workspace.root,
    dataRoot,
    sdkDir: resolveSdkDir(),
    hello: { windowId: "window-cleanup", sessionId: "session-cleanup" },
  });
  return { daemon, created };
}

describe("WorkspaceClients.create 某个仓库失败时清理其他仓库的客户端", () => {
  test("其他仓库已经连上时，整体失败后关掉它的连接", async () => {
    const { daemon, created } = await scenario({ helloDelayMs: 0, brokenDelayMs: 300 });

    await expect(created).rejects.toThrow("读取仓库身份失败（测试注入）");
    expect(daemon.helloed()).toBe(1);
    await waitUntil(() => daemon.open() === 0);
  });

  test("其他仓库还在连接时，整体失败后等它连上再关掉", async () => {
    const { daemon, created } = await scenario({ helloDelayMs: 300, brokenDelayMs: 0 });

    await expect(created).rejects.toThrow("读取仓库身份失败（测试注入）");
    await waitUntil(() => daemon.helloed() === 1);
    await waitUntil(() => daemon.open() === 0);
  });
});
