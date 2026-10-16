#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { daemonSocketPath } from "../../src/core/storage/identity.ts";
import { PROTOCOL_VERSION, createErrorResponse, createResponse, decodeFrames, encodeFrame } from "../../src/core/host/protocol.ts";

const repoDir = process.env.ONE_COMPANY_REPO_DIR ?? "";
const dataRootPath = process.env.ONE_COMPANY_DATA_ROOT ?? "";
const repoId = createHash("sha256").update(repoDir).digest("hex");
const socketPath = daemonSocketPath(dataRootPath, repoId);
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });

// 第一次 hello 判定为「协议版本不一致」的注入失败，此后的连接一律当作正常守护进程应答，
// 用同一个真实子进程同时覆盖"首次 hello 失败"与"后续重连成功"两种场景
let helloAttempts = 0;

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.t !== "req") continue;
      if (frame.method === "ping") {
        socket.write(encodeFrame(createResponse(frame.id, { now: Date.now() })));
        continue;
      }
      if (frame.method === "hello") {
        helloAttempts += 1;
        if (helloAttempts === 1) {
          socket.write(encodeFrame(createErrorResponse(frame.id, "protocol_version", "协议版本不一致（测试注入）")));
          socket.end();
        } else {
          socket.write(
            encodeFrame(
              createResponse(frame.id, {
                daemonPid: process.pid,
                repoId,
                protocolVersion: PROTOCOL_VERSION,
                startedAt: new Date().toISOString(),
                daemonInstanceId: randomUUID(),
                connectionId: randomUUID(),
              }),
            ),
          );
        }
      }
    }
  });
});
server.listen(socketPath);
