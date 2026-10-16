import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import {
  PROTOCOL_VERSION,
  assertProtocolVersion,
  createErrorResponse,
  createEvent,
  createResponse,
  decodeFrames,
  encodeFrame,
  validateParams,
} from "../../core/host/protocol.ts";
import type { Frame } from "../../core/host/protocol.ts";
import { adviceOf } from "../../core/exec/tool-failure.ts";

export interface ClientInfo {
  windowId: string;
  sessionId: string;
  /** 由服务端每次认证生成，模型或 hello 参数不能指定。 */
  readonly daemonInstanceId?: string;
  readonly connectionId?: string;
}

interface ClientConnection {
  socket: Socket;
  info: ClientInfo | null;
  buffer: string;
  closed: boolean;
}

export type MethodHandler = (
  params: Record<string, unknown>,
  client: ClientInfo,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface DaemonServerOptions {
  authToken: string;
  repoId: string;
  startedAt: string;
  onActivity?: () => void;
  hasActiveRuns?: () => Promise<{ active: boolean; reason?: string }>;
  isReady?: () => boolean;
  onShutdownRequested?: () => void;
}

const HANDLERS_READY_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  const code = (error as { code?: string }).code;
  return typeof code === "string" ? code : "internal";
}

export function errorData(error: unknown): Record<string, unknown> | undefined {
  const raw = (error as { data?: unknown }).data;
  const data = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const advice = adviceOf(error);
  return advice ? { ...data, advice: { why: advice.why, next: advice.next } } : data;
}

export class DaemonServer {
  readonly daemonInstanceId = randomUUID();
  private readonly options: DaemonServerOptions;
  private server: Server | null = null;
  private readonly connections = new Set<ClientConnection>();
  private readonly handlers = new Map<string, MethodHandler>();
  private resolveHandlersReady!: () => void;
  private readonly handlersReady: Promise<void>;
  onHello: ((client: ClientInfo) => Promise<void> | void) | null = null;
  /** 每个已认证的 ClientInfo 身份在断线、重 hello 或服务关闭时至多回调一次。 */
  onDisconnect: ((client: ClientInfo) => Promise<void> | void) | null = null;

  constructor(options: DaemonServerOptions) {
    this.options = options;
    this.handlersReady = new Promise((resolve) => {
      this.resolveHandlersReady = resolve;
    });
  }

  registerHandler(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  // 路由表本身的装配（registerProtocolHandlers）与业务是否就绪（manager.awaitStarted）是两道独立的闸；
  // 前者晚于 socket 开始接受连接时，客户端的早到请求要能等到路由表填完，而不是直接判 unknown_method
  markHandlersReady(): void {
    this.resolveHandlersReady();
  }

  // 装配一旦真的卡死（而非仅仅慢），排队请求不能无限期挂着——给个上界，超时明确报"启动中"
  // 而不是让调用方误判成路由不存在
  private async waitHandlersReady(): Promise<boolean> {
    return Promise.race([this.handlersReady.then(() => true), delay(HANDLERS_READY_TIMEOUT_MS).then(() => false)]);
  }

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        server.on("error", () => {});
        this.server = server;
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    const client: ClientConnection = { socket, info: null, buffer: "", closed: false };
    this.connections.add(client);
    this.options.onActivity?.();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (client.closed) return;
      client.buffer += chunk;
      const { frames, rest } = decodeFrames(client.buffer);
      client.buffer = rest;
      for (const frame of frames) {
        if (frame.t === "req") void this.handleRequest(client, frame);
      }
    });
    socket.on("close", () => this.disconnect(client));
    socket.on("error", () => this.disconnect(client));
  }

  private runLifecycleCallback(callback: ((client: ClientInfo) => Promise<void> | void) | null, info: ClientInfo): void {
    if (!callback) return;
    try {
      void Promise.resolve(callback(info)).catch(() => undefined);
    } catch {
      // 生命周期观察者故障不能打断 socket 清理或协议处理。
    }
  }

  private retireIdentity(client: ClientConnection): void {
    const info = client.info;
    if (!info) return;
    client.info = null;
    this.runLifecycleCallback(this.onDisconnect, info);
  }

  private disconnect(client: ClientConnection): void {
    if (client.closed) return;
    client.closed = true;
    this.connections.delete(client);
    this.retireIdentity(client);
  }

  private assertAuthToken(params: Record<string, unknown>): void {
    const token = Buffer.from(typeof params.authToken === "string" ? params.authToken : "");
    const expected = Buffer.from(this.options.authToken);
    if (token.length !== expected.length || token.length === 0 || !timingSafeEqual(token, expected)) {
      throw Object.assign(new Error("控制连接认证失败"), { code: "unauthorized" });
    }
  }

  private isClientCurrent(client: ClientConnection, info: ClientInfo): boolean {
    return !client.closed && client.info === info && this.connections.has(client);
  }

  private assertClientCurrent(client: ClientConnection, info: ClientInfo): void {
    if (!this.isClientCurrent(client, info)) {
      throw Object.assign(new Error("连接身份已变化"), { code: "identity_changed" });
    }
  }

  private retireCurrentIdentity(client: ClientConnection, info: ClientInfo): void {
    if (!this.isClientCurrent(client, info)) return;
    this.retireIdentity(client);
  }

  private async notifyHelloWhenCurrent(client: ClientConnection, info: ClientInfo): Promise<void> {
    if (!this.isClientCurrent(client, info)) return;
    const callback = this.onHello;
    if (callback) {
      try {
        await callback(info);
      } catch {
        // 生命周期观察者故障不改变已认证连接。
      }
    }
  }

  private async handleRequest(client: ClientConnection, frame: Extract<Frame, { t: "req" }>): Promise<void> {
    this.options.onActivity?.();
    const isHello = frame.method === "hello";
    let requestInfo: ClientInfo | null = null;
    let responseInfo: ClientInfo | null = null;
    // 任意新 hello 都是身份替换边界。先撤销旧身份，再校验新参数、协议和凭证，失败时保持未认证。
    if (isHello) this.retireIdentity(client);
    else requestInfo = client.info;
    try {
      if (isHello) this.assertAuthToken(frame.params);
      validateParams(frame.method, frame.params);
      let result: Record<string, unknown>;
      if (isHello) {
        const hello = await this.handleHello(client, frame.params);
        responseInfo = hello.info;
        result = hello.result;
      } else {
        result = await this.dispatchMethod(frame.method, frame.params, client, requestInfo);
        responseInfo = requestInfo;
      }
      if (responseInfo) this.assertClientCurrent(client, responseInfo);
      client.socket.write(encodeFrame(createResponse(frame.id, result)));
    } catch (error) {
      const expectedInfo = responseInfo ?? requestInfo;
      if (expectedInfo && !this.isClientCurrent(client, expectedInfo)) return;
      client.socket.write(
        encodeFrame(createErrorResponse(frame.id, errorCode(error), (error as Error).message, errorData(error))),
      );
      if (errorCode(error) === "protocol_version") {
        if (expectedInfo) this.retireCurrentIdentity(client, expectedInfo);
        else this.retireIdentity(client);
        client.socket.end();
      }
    }
  }

  private async handleHello(client: ClientConnection, params: Record<string, unknown>): Promise<{
    info: ClientInfo;
    result: Record<string, unknown>;
  }> {
    assertProtocolVersion(params.protocolVersion as number);
    client.info = {
      windowId: params.windowId as string,
      sessionId: params.sessionId as string,
      daemonInstanceId: this.daemonInstanceId,
      connectionId: randomUUID(),
    };
    Object.defineProperties(client.info, {
      daemonInstanceId: { writable: false, configurable: false },
      connectionId: { writable: false, configurable: false },
    });
    // 推送延后到下一轮事件循环：hello 响应帧必须先于任何推送帧写入 socket，
    // 否则客户端可能在收到响应、注册事件监听器之前就已经收到并丢弃了推送；
    // onHello 由 registerProtocolHandlers 在装配完成时才赋值，装配未完工时 hello 也要等，
    // 不能因为此刻还没有回调就悄悄丢掉这次推送
    const info = client.info;
    if (this.onHello) {
      setImmediate(() => { void this.notifyHelloWhenCurrent(client, info); });
    } else {
      void this.waitHandlersReady().then((ready) => {
        if (ready) void this.notifyHelloWhenCurrent(client, info);
      });
    }
    return {
      info,
      result: {
        daemonPid: process.pid,
        repoId: this.options.repoId,
        protocolVersion: PROTOCOL_VERSION,
        startedAt: this.options.startedAt,
        daemonInstanceId: info.daemonInstanceId,
        connectionId: info.connectionId,
      },
    };
  }

  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>,
    client: ClientConnection,
    requestInfo: ClientInfo | null,
  ): Promise<Record<string, unknown>> {
    if (method === "ping") return { now: Date.now() };
    const info = requestInfo;
    if (!info) {
      const error = new Error(`须先完成 hello 才能调用该方法: ${method}`) as Error & { code: string };
      error.code = "bad_params";
      throw error;
    }
    this.assertClientCurrent(client, info);
    if (method === "shutdown") {
      if (!(this.options.isReady?.() ?? true)) return { accepted: false, reason: "守护进程正在启动" };
      const activeResult = await this.options.hasActiveRuns?.();
      this.assertClientCurrent(client, info);
      if (activeResult?.active) return { accepted: false, reason: activeResult.reason ?? "存在活动的需求代理运行" };
      this.assertClientCurrent(client, info);
      this.options.onShutdownRequested?.();
      return { accepted: true };
    }
    let handler = this.handlers.get(method);
    if (!handler) {
      const ready = await this.waitHandlersReady();
      this.assertClientCurrent(client, info);
      if (!ready) {
        const error = new Error(`守护进程启动中，方法尚未登记: ${method}`) as Error & { code: string };
        error.code = "daemon_starting";
        throw error;
      }
      handler = this.handlers.get(method);
    }
    if (!handler) {
      const error = new Error(`未注册的方法: ${method}`) as Error & { code: string };
      error.code = "unknown_method";
      throw error;
    }
    this.assertClientCurrent(client, info);
    return handler(params, info);
  }

  broadcast(event: string, data: Record<string, unknown>, filter?: (info: ClientInfo) => boolean): void {
    const encoded = encodeFrame(createEvent(event, data));
    for (const client of this.connections) {
      const info = client.info;
      if (!info) continue;
      try {
        const accepted = !filter || filter(info);
        this.assertClientCurrent(client, info);
        if (accepted) client.socket.write(encoded);
      } catch (error) {
        if (!this.isClientCurrent(client, info)) continue;
        throw error;
      }
    }
  }

  clients(): ClientInfo[] {
    const infos: ClientInfo[] = [];
    for (const client of this.connections) {
      if (client.info) infos.push(client.info);
    }
    return infos;
  }

  close(): Promise<void> {
    for (const client of [...this.connections]) {
      this.disconnect(client);
      client.socket.destroy();
    }
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
