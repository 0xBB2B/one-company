import { createConnection } from "node:net";
import { createRequest, decodeFrames } from "./protocol.ts";

const PROBE_TIMEOUT_MS = 3_000;
const SOCKET_PATH_BYTE_LIMIT: Record<string, number> = { darwin: 104, linux: 108 };

export function socketPathByteLimit(platform: NodeJS.Platform = process.platform): number {
  return SOCKET_PATH_BYTE_LIMIT[platform] ?? 108;
}

type ProbeResult = "existing" | "stale" | "ambiguous";

export async function probeExistingInstance(socketPath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("ambiguous"), PROBE_TIMEOUT_MS);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED（崩溃遗留的真实 socket）与 ENOTSOCK（占位普通文件）都能确认无人监听
      finish(error.code === "ECONNREFUSED" || error.code === "ENOTSOCK" ? "stale" : "ambiguous");
    });
    socket.once("connect", () => {
      const request = createRequest("ping", {});
      socket.write(`${JSON.stringify(request)}\n`);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const { frames, rest } = decodeFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.t === "res" && frame.id === request.id) finish(frame.ok ? "existing" : "ambiguous");
        }
      });
    });
  });
}
