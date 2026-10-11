import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import lifecycleExtension, { windowContext } from "../../extensions/lifecycle.ts";
import type { Clock } from "../../runtime/clock.ts";
import { WorkspaceClients } from "../../runtime/daemon-client.ts";
import { ShellRegistry } from "../../runtime/shell-registry.ts";
import { createFakePi } from "./fake-pi.ts";


interface RunnerConfig {
  cwd: string;
  dataRoot: string;
  sdkDir: string;
  stateFile: string;
  shellCommand: string;
}

interface StateSnapshot {
  phase: string;
  windowId?: string;
  taskId?: string;
  pid?: number;
  pgid?: number;
  reason?: string;
  connected?: boolean;
}

function writeState(path: string, state: StateSnapshot): void {
  writeFileSync(path, JSON.stringify(state));
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("缺少配置文件路径参数");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RunnerConfig;

  const fakePi = createFakePi();
  let shellRegistry: ShellRegistry | undefined;
  let connected = false;
  lifecycleExtension(fakePi.pi, {
    createShellRegistry: (clock: Clock) => {
      shellRegistry = new ShellRegistry({ clock });
      return shellRegistry;
    },
    // 生产默认实现按当前进程环境变量推导 dataRoot；测试固件的守护进程数据根是独立随机目录，
    // 与本子进程的环境变量无关联关系，改为直接把固件已知的 dataRoot/sdkDir 传给同一个生产
    // WorkspaceClients.create，走的仍是真实 socket 握手，只是换一种方式提供参数
    connectWorkspaceClients: async (input) => {
      const handle = await WorkspaceClients.create({
        workspaceRoot: input.cwd,
        dataRoot: config.dataRoot,
        sdkDir: config.sdkDir,
        hello: { windowId: input.windowId, sessionId: input.sessionId },
      });
      connected = handle.all().length > 0 && handle.all().every((c) => c.state().status === "connected");
      return handle;
    },
    process,
  });

  const sessionId = randomUUID();
  const ctx = {
    cwd: config.cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message: string, level?: string) => process.stderr.write(`[window] ${level ?? "info"}: ${message}\n`) },
    shutdown: () => {
      writeState(config.stateFile, { phase: "shutdown-called" });
      process.exit(0);
    },
  };

  await fakePi.trigger("session_start", { type: "session_start", reason: "new" }, ctx);
  if (!shellRegistry) {
    writeState(config.stateFile, { phase: "failed", reason: "窗口未成功启动" });
    process.exit(1);
    return;
  }

  const windowId = windowContext().windowId;
  const taskId = randomUUID();
  const spawned = await shellRegistry.spawn({
    taskId,
    host: { kind: "main", id: windowId },
    command: "sh",
    args: ["-c", config.shellCommand],
    mode: "background",
    runToken: randomUUID(),
  });
  if (!spawned.ok) {
    writeState(config.stateFile, { phase: "failed", reason: spawned.reason });
    process.exit(1);
    return;
  }

  writeState(config.stateFile, {
    phase: "ready",
    windowId,
    taskId,
    pid: spawned.task.pid,
    pgid: spawned.task.pgid,
    connected,
  });

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() !== "QUIT") return;
    void fakePi
      .trigger("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
      .then(() => {
        writeState(config.stateFile, { phase: "quit-done", windowId, taskId });
        process.exit(0);
      });
  });
}

void main();
