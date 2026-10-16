import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { temporaryRoot } from "./helpers/temporary-root.ts";
import { DaemonServer } from "../src/app/daemon/server.ts";
import type { ClientInfo } from "../src/app/daemon/server.ts";
import { PROTOCOL_VERSION, createRequest, decodeFrames, encodeFrame } from "../src/core/host/protocol.ts";


interface Peer {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitClosed(): Promise<void>;
  socket: Socket;
  close(): void;
}

const roots: string[] = [];
const servers: DaemonServer[] = [];
const peers: Peer[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`等待条件满足超时（${timeoutMs}ms）`);
}

async function makeServer(): Promise<{ server: DaemonServer; socketPath: string }> {
  const root = await mkdtemp(join(temporaryRoot(), "daemon-connection-"));
  roots.push(root);
  const server = new DaemonServer({ authToken: "lifecycle-token", repoId: "repo-lifecycle", startedAt: "test" });
  servers.push(server);
  const socketPath = join(root, "daemon.sock");
  await server.listen(socketPath);
  return { server, socketPath };
}

async function connectPeer(socketPath: string): Promise<Peer> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let buffer = "";
  const pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const decoded = decodeFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.t !== "res") continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
    }
  });
  const peer: Peer = {
    socket,
    call(method, params) {
      const request = createRequest(method, params);
      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        socket.write(encodeFrame(request));
      });
    },
    waitClosed: () => closed,
    close() {
      socket.destroy();
    },
  };
  peers.push(peer);
  return peer;
}

function hello(windowId: string, authToken = "lifecycle-token"): Record<string, unknown> {
  return {
    authToken,
    windowId,
    sessionId: `session-${windowId}`,
    protocolVersion: PROTOCOL_VERSION,
  };
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DaemonServer 已认证连接生命周期", () => {
  test("未认证连接不触发断开回调，已认证连接的 error/close 收敛为一次", async () => {
    const { server, socketPath } = await makeServer();
    server.onHello = () => {};
    const disconnected: ClientInfo[] = [];
    server.onDisconnect = (client) => disconnected.push(client);

    const unauthenticated = await connectPeer(socketPath);
    await expect(unauthenticated.call("hello", hello("bad", "wrong-token"))).rejects.toThrow("unauthorized");
    unauthenticated.close();
    await delay(30);
    expect(disconnected).toEqual([]);

    const authenticated = await connectPeer(socketPath);
    await authenticated.call("hello", hello("authenticated"));
    const identity = server.clients()[0];
    expect(identity).toBeDefined();
    expect(() => Object.assign(identity!, { connectionId: "forged" })).toThrow();
    expect(() => Object.assign(identity!, { daemonInstanceId: "forged" })).toThrow();
    const serverConnection = [...(server as unknown as {
      connections: Set<{ socket: Socket }>;
    }).connections][0];
    serverConnection?.socket.destroy(new Error("测试注入连接错误"));

    await waitUntil(() => disconnected.length === 1);
    await delay(30);
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toBe(identity);
  });

  test("同一 socket 重复 hello 撤销旧身份，延迟 onHello 只接收当前身份", async () => {
    const { server, socketPath } = await makeServer();
    const disconnected: ClientInfo[] = [];
    const welcomed: ClientInfo[] = [];
    server.onDisconnect = (client) => disconnected.push(client);

    const peer = await connectPeer(socketPath);
    const firstHello = await peer.call("hello", hello("first"));
    const secondHello = await peer.call("hello", hello("second"));
    expect(firstHello.daemonInstanceId).toBe(server.daemonInstanceId);
    expect(secondHello.daemonInstanceId).toBe(server.daemonInstanceId);
    expect(firstHello.connectionId).not.toBe(secondHello.connectionId);
    expect(firstHello.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(secondHello.connectionId).toMatch(/^[0-9a-f-]{36}$/u);

    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]?.windowId).toBe("first");
    const current = server.clients()[0];
    expect(current?.windowId).toBe("second");
    expect(current?.connectionId).toBe(secondHello.connectionId);
    expect(current?.daemonInstanceId).toBe(secondHello.daemonInstanceId);
    expect(disconnected[0]?.connectionId).toBe(firstHello.connectionId);

    server.onHello = (client) => welcomed.push(client);
    server.markHandlersReady();
    await waitUntil(() => welcomed.length === 1);

    expect(welcomed).toEqual([current]);
    expect(welcomed[0]).not.toBe(disconnected[0]);

    peer.close();
    await waitUntil(() => disconnected.length === 2);
    expect(disconnected[1]).toBe(current);
  });

  test.each([
    {
      name: "malformed 参数",
      params: (() => {
        const { windowId: _windowId, ...rest } = hello("malformed");
        return rest;
      })(),
      errorCode: "bad_params",
      closesSocket: false,
    },
    {
      name: "错误协议",
      params: { ...hello("wrong-protocol"), protocolVersion: PROTOCOL_VERSION + 1 },
      errorCode: "protocol_version",
      closesSocket: true,
    },
    {
      name: "错误 token",
      params: hello("wrong-token", "not-the-token"),
      errorCode: "unauthorized",
      closesSocket: false,
    },
  ])("已认证连接收到$name re-hello 时立即撤销旧身份", async ({ params, errorCode, closesSocket }) => {
    const { server, socketPath } = await makeServer();
    const disconnected: ClientInfo[] = [];
    const welcomed: ClientInfo[] = [];
    server.onDisconnect = (client) => disconnected.push(client);
    server.registerHandler("pm.overview", (_params, client) => ({ windowId: client.windowId }));

    const peer = await connectPeer(socketPath);
    await peer.call("hello", hello("old"));
    const oldIdentity = server.clients()[0];
    expect(oldIdentity?.windowId).toBe("old");

    await expect(peer.call("hello", params)).rejects.toThrow(errorCode);
    await waitUntil(() => disconnected.length === 1);
    expect(disconnected).toEqual([oldIdentity]);
    expect(server.clients()).toEqual([]);

    if (closesSocket) {
      await peer.waitClosed();
    } else {
      await expect(peer.call("pm.overview", {})).rejects.toThrow("bad_params");
    }

    server.onHello = (client) => welcomed.push(client);
    server.markHandlersReady();
    await delay(30);
    expect(welcomed).toEqual([]);
  });

  test("连接在 handlers ready 前断开后，不会迟到触发 onHello", async () => {
    const { server, socketPath } = await makeServer();
    const disconnected: ClientInfo[] = [];
    const welcomed: ClientInfo[] = [];
    server.onDisconnect = (client) => disconnected.push(client);

    const peer = await connectPeer(socketPath);
    await peer.call("hello", hello("gone-before-ready"));
    const identity = server.clients()[0];
    peer.close();
    await waitUntil(() => disconnected.length === 1);

    server.onHello = (client) => welcomed.push(client);
    server.markHandlersReady();
    await delay(30);

    expect(disconnected[0]).toBe(identity);
    expect(welcomed).toEqual([]);
  });

  test("server.close 清理全部连接，断开回调抛错或 reject 不阻塞且不产生未处理拒绝", async () => {
    const { server, socketPath } = await makeServer();
    server.onHello = () => {};
    const disconnected: ClientInfo[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    server.onDisconnect = (client) => {
      disconnected.push(client);
      if (client.windowId === "window-a") throw new Error("同步回调失败（测试注入）");
      return Promise.reject(new Error("异步回调失败（测试注入）"));
    };

    const first = await connectPeer(socketPath);
    const second = await connectPeer(socketPath);
    await first.call("hello", hello("window-a"));
    await second.call("hello", hello("window-b"));
    const identities = server.clients();

    try {
      await server.close();
      await Promise.all([first.waitClosed(), second.waitClosed()]);
      await delay(30);
      expect(disconnected).toHaveLength(2);
      expect(disconnected).toEqual(expect.arrayContaining(identities));
      expect(server.clients()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("hello不允许客户端指定daemon或connection身份，新server实例不复用标识", async () => {
    const { server, socketPath } = await makeServer();
    server.onHello = () => {};
    const peer = await connectPeer(socketPath);
    for (const extra of [{ daemonInstanceId: server.daemonInstanceId }, { connectionId: "forged" }]) {
      await expect(peer.call("hello", { ...hello("forged"), ...extra })).rejects.toThrow("bad_params");
      expect(server.clients()).toEqual([]);
    }
    const first = await peer.call("hello", hello("first"));
    await server.close();
    const next = new DaemonServer({ authToken: "lifecycle-token", repoId: "repo-lifecycle", startedAt: "test" });
    servers.push(next);
    next.onHello = () => {};
    await next.listen(socketPath);
    const second = await (await connectPeer(socketPath)).call("hello", hello("first"));
    expect(second.daemonInstanceId).not.toBe(first.daemonInstanceId);
    expect(second.connectionId).not.toBe(first.connectionId);
  });

  test("多个连接分别按各自 ClientInfo 对象身份减引用", async () => {
    const { server, socketPath } = await makeServer();
    server.onHello = () => {};
    const disconnected: ClientInfo[] = [];
    server.onDisconnect = (client) => disconnected.push(client);

    const first = await connectPeer(socketPath);
    const second = await connectPeer(socketPath);
    await first.call("hello", hello("window-a"));
    await second.call("hello", hello("window-b"));
    const identities = server.clients();
    const identityA = identities.find((client) => client.windowId === "window-a");
    const identityB = identities.find((client) => client.windowId === "window-b");

    first.close();
    await waitUntil(() => disconnected.length === 1);
    expect(disconnected[0]).toBe(identityA);
    expect(server.clients()).toEqual([identityB]);

    second.close();
    await waitUntil(() => disconnected.length === 2);
    expect(disconnected[1]).toBe(identityB);
    expect(server.clients()).toEqual([]);
  });
});
