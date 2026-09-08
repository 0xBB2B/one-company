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
} from "../runtime/protocol.ts";
import type { Frame } from "../runtime/protocol.ts";

export interface ClientInfo {
  windowId: string;
  pid: number;
  sessionId: string;
  cwd: string;
  workspaceRoot: string;
  repoIds: string[];
}

interface ClientConnection {
  socket: Socket;
  info: ClientInfo | null;
  buffer: string;
}

export type MethodHandler = (
  params: Record<string, unknown>,
  client: ClientInfo,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface DaemonServerOptions {
  repoId: string;
  startedAt: string;
  onActivity?: () => void;
  hasActiveRuns?: () => Promise<boolean> | boolean;
  isReady?: () => boolean;
  onShutdownRequested?: () => void;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: string }).code;
  return typeof code === "string" ? code : "internal";
}

export class DaemonServer {
  private readonly options: DaemonServerOptions;
  private server: Server | null = null;
  private readonly connections = new Set<ClientConnection>();
  private readonly handlers = new Map<string, MethodHandler>();

  constructor(options: DaemonServerOptions) {
    this.options = options;
  }

  registerHandler(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
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
    const client: ClientConnection = { socket, info: null, buffer: "" };
    this.connections.add(client);
    this.options.onActivity?.();
    socket.on("data", (chunk: Buffer) => {
      client.buffer += chunk.toString("utf8");
      const { frames, rest } = decodeFrames(client.buffer);
      client.buffer = rest;
      for (const frame of frames) {
        if (frame.t === "req") void this.handleRequest(client, frame);
      }
    });
    socket.on("close", () => {
      this.connections.delete(client);
    });
    socket.on("error", () => {
      this.connections.delete(client);
    });
  }

  private async handleRequest(client: ClientConnection, frame: Extract<Frame, { t: "req" }>): Promise<void> {
    this.options.onActivity?.();
    try {
      validateParams(frame.method, frame.params);
      const result =
        frame.method === "hello"
          ? await this.handleHello(client, frame.params)
          : await this.dispatchMethod(frame.method, frame.params, client);
      client.socket.write(encodeFrame(createResponse(frame.id, result)));
    } catch (error) {
      client.socket.write(encodeFrame(createErrorResponse(frame.id, errorCode(error), (error as Error).message)));
      if (errorCode(error) === "protocol_version") client.socket.end();
    }
  }

  private async handleHello(client: ClientConnection, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertProtocolVersion(params.protocolVersion as number);
    client.info = {
      windowId: params.windowId as string,
      pid: params.pid as number,
      sessionId: params.sessionId as string,
      cwd: params.cwd as string,
      workspaceRoot: params.workspaceRoot as string,
      repoIds: params.repoIds as string[],
    };
    return {
      daemonPid: process.pid,
      repoId: this.options.repoId,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.options.startedAt,
    };
  }

  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>,
    client: ClientConnection,
  ): Promise<Record<string, unknown>> {
    if (method === "ping") return { now: Date.now() };
    const info = client.info;
    if (!info) {
      const error = new Error(`须先完成 hello 才能调用该方法: ${method}`) as Error & { code: string };
      error.code = "bad_params";
      throw error;
    }
    if (method === "shutdown") {
      if (!(this.options.isReady?.() ?? true)) return { accepted: false, reason: "守护进程正在启动" };
      const activeRuns = (await this.options.hasActiveRuns?.()) ?? false;
      if (activeRuns) return { accepted: false, reason: "存在活动的需求代理运行" };
      this.options.onShutdownRequested?.();
      return { accepted: true };
    }
    const handler = this.handlers.get(method);
    if (!handler) {
      const error = new Error(`未注册的方法: ${method}`) as Error & { code: string };
      error.code = "unknown_method";
      throw error;
    }
    return handler(params, info);
  }

  broadcast(event: string, data: Record<string, unknown>, filter?: (info: ClientInfo) => boolean): void {
    const encoded = encodeFrame(createEvent(event, data));
    for (const client of this.connections) {
      if (client.info && (!filter || filter(client.info))) client.socket.write(encoded);
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
    for (const client of this.connections) client.socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
